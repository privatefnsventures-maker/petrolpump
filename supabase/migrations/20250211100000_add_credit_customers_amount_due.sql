-- Ensure credit_customers has amount_due (required by credit UI and record_credit_payment).
-- Safe if column already exists (e.g. from schema.sql or earlier setup).
alter table public.credit_customers
  add column if not exists amount_due numeric(14,2) not null default 0;

comment on column public.credit_customers.amount_due is 'Current outstanding balance for this customer (synced from credit_entries when using credit_entries).';

-- Index for listing by balance (if not already present)
create index if not exists credit_amount_idx on public.credit_customers (amount_due desc);
