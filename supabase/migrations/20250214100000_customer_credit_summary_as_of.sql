-- RPC: Credit summary for a single customer (by name) as of a date
-- Returns: credit_taken, settlement_done, remaining (for modal on overdue page)
-- Drop first when changing return type (e.g. adding last_credit_date).
drop function if exists public.get_customer_credit_summary_as_of(text, date);

create or replace function public.get_customer_credit_summary_as_of(
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
  last_credit_date date
)
language plpgsql security definer stable
as $$
begin
  return query
  with name_match as (
    select c.id as credit_customer_id,
           max(c.customer_name)::text as customer_name,
           max(c.vehicle_no)::text as vehicle_no
    from public.credit_customers c
    where lower(trim(c.customer_name)) = lower(trim(p_customer_name))
    group by c.id
  ),
  bal as (
    select e.credit_customer_id,
           coalesce(sum(e.amount), 0) as credit_tot,
           min(e.transaction_date) as min_txn_date,
           max(e.transaction_date) as max_txn_date
    from public.credit_entries e
    where e.transaction_date <= p_date
      and e.credit_customer_id in (select credit_customer_id from name_match)
    group by e.credit_customer_id
  ),
  pay as (
    select credit_customer_id,
           coalesce(sum(amount), 0) as payment_tot,
           max(date) as last_pay_date
    from public.credit_payments
    where date <= p_date
      and credit_customer_id in (select credit_customer_id from name_match)
    group by credit_customer_id
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
  )
  select (max(pc.customer_name))::text,
         (max(pc.vehicle_no))::text,
         sum(pc.credit_taken)::numeric as credit_taken,
         sum(pc.settlement_done)::numeric as settlement_done,
         sum(pc.remaining)::numeric as remaining,
         max(pc.last_payment_date) as last_payment_date,
         min(pc.first_sale_date) as first_sale_date,
         max(pc.last_credit_date) as last_credit_date
  from per_customer pc;
end;
$$;
comment on function public.get_customer_credit_summary_as_of(text, date) is 'Credit summary for one customer (by name) as of date: credit_taken, settlement_done, remaining.';
