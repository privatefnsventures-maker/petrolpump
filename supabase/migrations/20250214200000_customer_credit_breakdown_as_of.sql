-- RPC: Per-entry breakdown of credit and settlement for a customer (by name) as of a date
-- Returns: entry_type ('credit' | 'payment'), entry_date, amount for each transaction
create or replace function public.get_customer_credit_breakdown_as_of(
  p_customer_name text,
  p_date date
)
returns table (
  entry_type text,
  entry_date date,
  amount numeric
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
  credits as (
    select 'credit'::text as entry_type,
           e.transaction_date as entry_date,
           e.amount
    from public.credit_entries e
    join customer_ids ci on ci.credit_customer_id = e.credit_customer_id
    where e.transaction_date <= p_date
  ),
  payments as (
    select 'payment'::text as entry_type,
           p.date as entry_date,
           p.amount
    from public.credit_payments p
    join customer_ids ci on ci.credit_customer_id = p.credit_customer_id
    where p.date <= p_date
  )
  select u.entry_type, u.entry_date, u.amount
  from (
    select * from credits
    union all
    select * from payments
  ) u
  order by u.entry_date asc, u.entry_type asc;
end;
$$;
comment on function public.get_customer_credit_breakdown_as_of(text, date) is 'Per-entry breakdown: credit and payment rows with date and amount for overdue detail modal.';
