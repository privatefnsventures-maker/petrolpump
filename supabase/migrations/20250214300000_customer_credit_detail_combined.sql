-- Combined RPC: summary + breakdown in one call (one round-trip for overdue modal).
-- Returns same summary as get_customer_credit_summary_as_of plus credit_entries and payment_entries as jsonb.
create or replace function public.get_customer_credit_detail_as_of(
  p_customer_name text,
  p_date date
)
returns table (
  customer_name text,
  vehicle_no text,
  credit_taken numeric,
  settlement_done numeric,
  remaining numeric,
  last_payment_date date,
  first_sale_date date,
  last_credit_date date,
  credit_entries jsonb,
  payment_entries jsonb
)
language plpgsql security definer stable
as $$
begin
  return query
  with customer_ids as (
    select c.id as credit_customer_id
    from public.credit_customers c
    where lower(trim(c.customer_name)) = lower(trim(p_customer_name))
  ),
  bal as (
    select e.credit_customer_id,
           coalesce(sum(e.amount), 0) as credit_tot,
           min(e.transaction_date) as min_txn_date,
           max(e.transaction_date) as max_txn_date
    from public.credit_entries e
    where e.transaction_date <= p_date
      and e.credit_customer_id in (select credit_customer_id from customer_ids)
    group by e.credit_customer_id
  ),
  pay as (
    select p.credit_customer_id,
           coalesce(sum(p.amount), 0) as payment_tot,
           max(p.date) as last_pay_date
    from public.credit_payments p
    where p.date <= p_date
      and p.credit_customer_id in (select credit_customer_id from customer_ids)
    group by p.credit_customer_id
  ),
  name_match as (
    select c.id as credit_customer_id,
           max(c.customer_name)::text as customer_name,
           max(c.vehicle_no)::text as vehicle_no
    from public.credit_customers c
    join customer_ids ci on ci.credit_customer_id = c.id
    group by c.id
  ),
  per_customer as (
    select nm.customer_name,
           nm.vehicle_no,
           coalesce(b.credit_tot, 0) as credit_taken,
           coalesce(p.payment_tot, 0) as settlement_done,
           (coalesce(b.credit_tot, 0) - coalesce(p.payment_tot, 0))::numeric as remaining,
           p.last_pay_date as last_payment_date,
           b.min_txn_date as first_sale_date,
           b.max_txn_date as last_credit_date
    from name_match nm
    left join bal b on b.credit_customer_id = nm.credit_customer_id
    left join pay p on p.credit_customer_id = nm.credit_customer_id
  ),
  agg as (
    select (max(pc.customer_name))::text as customer_name,
           (max(pc.vehicle_no))::text as vehicle_no,
           sum(pc.credit_taken)::numeric as credit_taken,
           sum(pc.settlement_done)::numeric as settlement_done,
           sum(pc.remaining)::numeric as remaining,
           max(pc.last_payment_date) as last_payment_date,
           min(pc.first_sale_date) as first_sale_date,
           max(pc.last_credit_date) as last_credit_date
    from per_customer pc
  ),
  credits_json as (
    select coalesce(
      (select jsonb_agg(jsonb_build_object('entry_date', e.transaction_date, 'amount', e.amount) order by e.transaction_date)
       from public.credit_entries e
       where e.credit_customer_id in (select credit_customer_id from customer_ids)
         and e.transaction_date <= p_date),
      '[]'::jsonb
    ) as entries
  ),
  payments_json as (
    select coalesce(
      (select jsonb_agg(jsonb_build_object('entry_date', p.date, 'amount', p.amount) order by p.date)
       from public.credit_payments p
       where p.credit_customer_id in (select credit_customer_id from customer_ids)
         and p.date <= p_date),
      '[]'::jsonb
    ) as entries
  )
  select a.customer_name, a.vehicle_no, a.credit_taken, a.settlement_done, a.remaining,
         a.last_payment_date, a.first_sale_date, a.last_credit_date,
         cj.entries as credit_entries, pj.entries as payment_entries
  from agg a, credits_json cj, payments_json pj;
end;
$$;
comment on function public.get_customer_credit_detail_as_of(text, date) is 'Combined credit detail: summary + credit_entries and payment_entries jsonb for overdue modal (one round-trip).';
