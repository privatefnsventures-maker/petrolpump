-- Petrol Pump schema for Supabase
-- Run inside the Supabase SQL editor or via supabase cli.

create extension if not exists "uuid-ossp";

create table if not exists public.dsr (
  id uuid primary key default uuid_generate_v4(),
  date date not null,
  product text not null check (product in ('petrol', 'diesel')),
  opening_pump1_nozzle1 numeric(14,2) not null default 0,
  opening_pump1_nozzle2 numeric(14,2) not null default 0,
  opening_pump2_nozzle1 numeric(14,2) not null default 0,
  opening_pump2_nozzle2 numeric(14,2) not null default 0,
  closing_pump1_nozzle1 numeric(14,2) not null default 0,
  closing_pump1_nozzle2 numeric(14,2) not null default 0,
  closing_pump2_nozzle1 numeric(14,2) not null default 0,
  closing_pump2_nozzle2 numeric(14,2) not null default 0,
  sales_pump1 numeric(14,2) not null default 0,
  sales_pump2 numeric(14,2) not null default 0,
  total_sales numeric(14,2) not null default 0,
  testing numeric(14,2) not null default 0,
  dip_reading numeric(14,2) not null default 0,
  stock numeric(14,2) not null default 0,
  remarks text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists dsr_date_idx on public.dsr (date desc, product);

comment on table public.dsr is 'Nozzle readings for petrol and diesel pumps.';
comment on column public.dsr.total_sales is 'Manual total for shift (sales_pump1 + sales_pump2 minus testing, etc.).';

-- Stock register by product
create table if not exists public.dsr_stock (
  id uuid primary key default uuid_generate_v4(),
  date date not null,
  product text not null check (product in ('petrol', 'diesel')),
  opening_stock numeric(14,2) not null default 0,
  receipts numeric(14,2) not null default 0,
  total_stock numeric(14,2) not null default 0,
  sale_from_meter numeric(14,2) not null default 0,
  testing numeric(14,2) not null default 0,
  net_sale numeric(14,2) not null default 0,
  closing_stock numeric(14,2) not null default 0,
  dip_stock numeric(14,2) not null default 0,
  variation numeric(14,2) not null default 0,
  remark text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists dsr_stock_date_idx on public.dsr_stock (date desc, product);

comment on table public.dsr_stock is 'Daily stock reconciliation for each product.';

-- Credit customers ledger
create table if not exists public.credit_customers (
  id uuid primary key default uuid_generate_v4(),
  customer_name text not null check (char_length(customer_name) <= 120),
  vehicle_no text check (char_length(vehicle_no) <= 32),
  amount_due numeric(14,2) not null default 0,
  last_payment date,
  notes text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists credit_amount_idx on public.credit_customers (amount_due desc);

comment on table public.credit_customers is 'Credit ledger for fleet and institutional customers.';
