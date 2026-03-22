-- Outstanding list: "Sale date" = last credit sale on/before as-of date (not first).
create or replace function public.get_outstanding_credit_list_as_of(p_date date)
returns table (
  customer_name text,
  vehicle_no text,
  amount_due_as_of numeric,
  last_payment_date date,
  sale_date date
)
language plpgsql security definer stable
as $$
begin
  return query
  with bal as (
    select e.credit_customer_id,
           coalesce(sum(e.amount), 0) as credit_tot,
           max(e.transaction_date) as last_txn_date
    from public.credit_entries e
    where e.transaction_date <= p_date
    group by e.credit_customer_id
  ),
  pay as (
    select credit_customer_id,
           coalesce(sum(amount), 0) as payment_tot,
           max(date) as last_pay_date
    from public.credit_payments
    where date <= p_date
    group by credit_customer_id
  ),
  per_customer as (
    select c.customer_name,
           c.vehicle_no,
           (coalesce(b.credit_tot, 0) - coalesce(p.payment_tot, 0))::numeric as amt,
           p.last_pay_date as last_pay,
           b.last_txn_date as last_txn
    from public.credit_customers c
    left join bal b on b.credit_customer_id = c.id
    left join pay p on p.credit_customer_id = c.id
    where coalesce(b.credit_tot, 0) - coalesce(p.payment_tot, 0) > 0
  )
  select (max(pc.customer_name))::text as customer_name,
         (max(pc.vehicle_no))::text as vehicle_no,
         sum(pc.amt)::numeric as amount_due_as_of,
         max(pc.last_pay) as last_payment_date,
         max(pc.last_txn) as sale_date
  from per_customer pc
  group by lower(trim(pc.customer_name))
  order by amount_due_as_of desc;
end;
$$;

comment on function public.get_outstanding_credit_list_as_of(date) is 'Customers with outstanding balance as of date D; one row per customer (grouped by name). sale_date is the latest credit entry date on or before D; last_payment_date is as of D.';
