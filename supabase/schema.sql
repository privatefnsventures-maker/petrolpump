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
  petrol_rate numeric(10,2),
  diesel_rate numeric(10,2),
  remarks text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists dsr_date_idx on public.dsr (date desc, product);

comment on table public.dsr is 'Nozzle readings for petrol and diesel pumps.';
comment on column public.dsr.total_sales is 'Manual total for shift (sales_pump1 + sales_pump2 minus testing, etc.).';

alter table public.dsr enable row level security;
drop policy if exists "dsr_select_authenticated" on public.dsr;
create policy "dsr_select_authenticated" on public.dsr
  for select
  to authenticated
  using (true);
drop policy if exists "dsr_insert_authenticated" on public.dsr;
create policy "dsr_insert_authenticated" on public.dsr
  for insert
  to authenticated
  with check (true);

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

alter table public.dsr_stock enable row level security;
drop policy if exists "dsr_stock_select_authenticated" on public.dsr_stock;
create policy "dsr_stock_select_authenticated" on public.dsr_stock
  for select
  to authenticated
  using (true);
drop policy if exists "dsr_stock_insert_authenticated" on public.dsr_stock;
create policy "dsr_stock_insert_authenticated" on public.dsr_stock
  for insert
  to authenticated
  with check (true);

-- Operating expenses
create table if not exists public.expenses (
  id uuid primary key default uuid_generate_v4(),
  date date not null,
  category text,
  description text,
  amount numeric(14,2) not null default 0,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists expenses_date_idx on public.expenses (date desc);

comment on table public.expenses is 'Daily operating expenses for profit/loss.';

alter table public.expenses enable row level security;
drop policy if exists "expenses_select_authenticated" on public.expenses;
create policy "expenses_select_authenticated" on public.expenses
  for select
  to authenticated
  using (true);
drop policy if exists "expenses_insert_authenticated" on public.expenses;
create policy "expenses_insert_authenticated" on public.expenses
  for insert
  to authenticated
  with check (true);

-- Staff access roles
create table if not exists public.staff (
  id uuid primary key default uuid_generate_v4(),
  email text not null unique,
  role text not null check (role in ('admin', 'supervisor')),
  created_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists staff_email_idx on public.staff (email);

comment on table public.staff is 'Operator access roles for the dashboard.';

alter table public.staff enable row level security;
drop policy if exists "staff_select_authenticated" on public.staff;
create policy "staff_select_authenticated" on public.staff
  for select
  to authenticated
  using (true);
drop policy if exists "staff_insert_admin" on public.staff;
create policy "staff_insert_admin" on public.staff
  for insert
  to authenticated
  with check (
    (auth.jwt() -> 'user_metadata' ->> 'role') = 'admin'
    or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    or
    exists (
      select 1
      from public.staff s
      where s.email = (auth.jwt() ->> 'email')
        and s.role = 'admin'
    )
    or not exists (select 1 from public.staff s where s.role = 'admin')
  );
drop policy if exists "staff_update_admin" on public.staff;
create policy "staff_update_admin" on public.staff
  for update
  to authenticated
  using (
    (auth.jwt() -> 'user_metadata' ->> 'role') = 'admin'
    or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    or
    exists (
      select 1
      from public.staff s
      where s.email = (auth.jwt() ->> 'email')
        and s.role = 'admin'
    )
  )
  with check (
    (auth.jwt() -> 'user_metadata' ->> 'role') = 'admin'
    or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    or
    exists (
      select 1
      from public.staff s
      where s.email = (auth.jwt() ->> 'email')
        and s.role = 'admin'
    )
  );
drop policy if exists "staff_delete_admin" on public.staff;
create policy "staff_delete_admin" on public.staff
  for delete
  to authenticated
  using (
    (auth.jwt() -> 'user_metadata' ->> 'role') = 'admin'
    or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    or
    exists (
      select 1
      from public.staff s
      where s.email = (auth.jwt() ->> 'email')
        and s.role = 'admin'
    )
  );

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

alter table public.credit_customers enable row level security;
drop policy if exists "credit_select_authenticated" on public.credit_customers;
create policy "credit_select_authenticated" on public.credit_customers
  for select
  to authenticated
  using (true);
drop policy if exists "credit_insert_authenticated" on public.credit_customers;
create policy "credit_insert_authenticated" on public.credit_customers
  for insert
  to authenticated
  with check (true);

-- Allow authenticated users to update credit records (needed for settlements)
drop policy if exists "credit_update_authenticated" on public.credit_customers;
create policy "credit_update_authenticated" on public.credit_customers
  for update
  to authenticated
  using (true)
  with check (true);
