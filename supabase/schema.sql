-- Petrol Pump schema for Supabase
-- Run inside the Supabase SQL editor or via supabase cli.
--
-- SECURITY MODEL:
-- ===============
-- This schema implements Row Level Security (RLS) as the PRIMARY authorization layer.
-- Client-side role checks (applyRoleVisibility, requireAuth) are for UX only.
-- All data access is enforced at the database level regardless of client-side bypasses.
--
-- Roles:
--   - admin: Full access to all operations including delete and staff management
--   - supervisor: Read all, insert/update own records, no delete access

create extension if not exists "uuid-ossp";

-- ============================================================================
-- ROLE HELPER FUNCTIONS (Security Definer - bypasses RLS for internal checks)
-- ============================================================================

-- Get the current user's role from users table or JWT metadata
-- Returns 'admin', 'supervisor', or null if not found
create or replace function public.get_user_role()
returns text
language sql
security definer
stable
as $$
  select coalesce(
    (select role from public.users where lower(trim(email)) = lower(trim(auth.jwt() ->> 'email')) limit 1),
    (auth.jwt() -> 'user_metadata' ->> 'role'),
    (auth.jwt() -> 'app_metadata' ->> 'role')
  );
$$;

comment on function public.get_user_role() is 'Returns the role of the current authenticated user (admin/supervisor/null).';

-- Helper function to check if current user is admin
-- This centralizes the admin check logic and improves performance
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
as $$
  select public.get_user_role() = 'admin';
$$;

comment on function public.is_admin() is 'Returns true if the current authenticated user has admin role.';

-- RPC to update DSR buying price (used from P&L dashboard); bypasses RLS so admin update always succeeds.
create or replace function public.update_dsr_buying_price(p_dsr_id uuid, p_value numeric)
returns void
language plpgsql
security definer
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin access required to set buying price';
  end if;
  update public.dsr set buying_price_per_litre = p_value where id = p_dsr_id;
  if not found then
    raise exception 'DSR record not found';
  end if;
end;
$$;
comment on function public.update_dsr_buying_price(uuid, numeric) is 'Admin-only: set buying_price_per_litre for a DSR row (used from P&L dashboard).';

-- One-shot sync of receipts from dsr_stock into dsr (matching date, product) where dsr.receipts = 0.
create or replace function public.sync_dsr_receipts_from_stock(p_start date, p_end date)
returns void
language sql
security definer
as $$
  update public.dsr d
  set receipts = s.receipts
  from public.dsr_stock s
  where d.date = s.date and d.product = s.product
    and s.receipts > 0 and coalesce(d.receipts, 0) = 0
    and d.date >= p_start and d.date <= p_end
    and s.date >= p_start and s.date <= p_end;
$$;
comment on function public.sync_dsr_receipts_from_stock(date, date) is 'Sync receipts from dsr_stock into dsr for matching (date, product) where dsr.receipts is 0.';

-- Helper function to check if current user is supervisor or admin
-- Supervisors have read access and can manage their own records
create or replace function public.is_supervisor_or_admin()
returns boolean
language sql
security definer
stable
as $$
  select public.get_user_role() in ('admin', 'supervisor');
$$;

comment on function public.is_supervisor_or_admin() is 'Returns true if the current user is a supervisor or admin.';

-- ============================================================================
-- AUDIT LOG TABLE (tracks sensitive operations)
-- ============================================================================

create table if not exists public.audit_log (
  id uuid primary key default uuid_generate_v4(),
  table_name text not null,
  record_id uuid,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  old_data jsonb,
  new_data jsonb,
  performed_by uuid references auth.users (id) on delete set null,
  performed_by_email text,
  performed_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists audit_log_table_idx on public.audit_log (table_name, performed_at desc);
create index if not exists audit_log_record_idx on public.audit_log (record_id);

comment on table public.audit_log is 'Audit trail for sensitive operations (admin-only view).';

alter table public.audit_log enable row level security;

-- Only admins can view audit logs
drop policy if exists "audit_log_select_admin" on public.audit_log;
create policy "audit_log_select_admin" on public.audit_log
  for select
  to authenticated
  using (public.is_admin());

-- No direct inserts/updates/deletes - only via triggers
drop policy if exists "audit_log_no_direct_write" on public.audit_log;
create policy "audit_log_no_direct_write" on public.audit_log
  for all
  to authenticated
  using (false)
  with check (false);

-- ============================================================================
-- SECURE ADMIN FUNCTIONS (Server-side enforcement for critical operations)
-- ============================================================================

-- Secure function to add/update app user (admin-only, server-side validation)
create or replace function public.upsert_staff(
  p_email text,
  p_role text,
  p_display_name text default null
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_result jsonb;
begin
  if not public.is_admin() then
    if exists (select 1 from public.users where role = 'admin') then
      raise exception 'Access denied: Admin role required';
    end if;
  end if;
  if p_role not in ('admin', 'supervisor') then
    raise exception 'Invalid role: must be admin or supervisor';
  end if;
  if p_email is null or trim(p_email) = '' then
    raise exception 'Email is required';
  end if;

  insert into public.users (email, role, display_name)
  values (lower(trim(p_email)), p_role, nullif(trim(p_display_name), ''))
  on conflict (email) do update set role = excluded.role, display_name = excluded.display_name
  returning jsonb_build_object('id', id, 'email', email, 'role', role, 'display_name', display_name) into v_result;
  return v_result;
end;
$$;

comment on function public.upsert_staff(text, text, text) is 'Securely add or update app user (users table) with server-side admin validation.';

-- Secure function to delete app user (admin-only, with audit)
create or replace function public.delete_staff(p_email text)
returns boolean
language plpgsql
security definer
as $$
begin
  if not public.is_admin() then
    raise exception 'Access denied: Admin role required';
  end if;
  if lower(trim(p_email)) = lower(auth.jwt() ->> 'email') then
    raise exception 'Cannot delete your own account';
  end if;
  delete from public.users where email = lower(trim(p_email));
  return found;
end;
$$;

comment on function public.delete_staff(text) is 'Securely delete app user with server-side admin validation.';

-- Function to validate user has access to a specific page/feature
-- Can be called from client to verify access before showing sensitive data
create or replace function public.check_page_access(p_page text)
returns jsonb
language plpgsql
security definer
stable
as $$
declare
  v_role text;
  v_allowed boolean;
begin
  v_role := public.get_user_role();
  
  -- Define page access rules
  v_allowed := case p_page
    when 'settings' then v_role = 'admin'
    when 'analysis' then v_role = 'admin'
    when 'dashboard' then v_role in ('admin', 'supervisor')
    when 'dsr' then v_role in ('admin', 'supervisor')
    when 'expenses' then v_role in ('admin', 'supervisor')
    when 'credit' then v_role in ('admin', 'supervisor')
    when 'sales-daily' then v_role in ('admin', 'supervisor')
    when 'attendance' then v_role in ('admin', 'supervisor')
    when 'salary' then v_role in ('admin', 'supervisor')
    else false
  end;

  return jsonb_build_object(
    'allowed', v_allowed,
    'role', v_role,
    'page', p_page
  );
end;
$$;

comment on function public.check_page_access(text) is 'Server-side page access validation. Returns allowed status and user role.';

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
  receipts numeric(14,2) not null default 0,
  petrol_rate numeric(10,2),
  diesel_rate numeric(10,2),
  buying_price_per_litre numeric(10,2),
  remarks text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists dsr_date_idx on public.dsr (date desc, product);

comment on table public.dsr is 'Nozzle readings for petrol and diesel pumps.';
comment on column public.dsr.total_sales is 'Manual total for shift (sales_pump1 + sales_pump2 minus testing, etc.).';
comment on column public.dsr.receipts is 'Fuel received (L) on this date. When > 0, admin can set buying_price_per_litre for profit calculation until next receipt.';
comment on column public.dsr.buying_price_per_litre is 'Admin-only: cost per litre for fuel received on this date; used for profit from this date until next DSR with receipts > 0.';

alter table public.dsr enable row level security;

-- SELECT: All authenticated users can view all records
drop policy if exists "dsr_select_authenticated" on public.dsr;
drop policy if exists "dsr_select_by_role" on public.dsr;
create policy "dsr_select_authenticated" on public.dsr
  for select
  to authenticated
  using (true);

-- INSERT: Users can only insert records owned by themselves
drop policy if exists "dsr_insert_authenticated" on public.dsr;
drop policy if exists "dsr_insert_own" on public.dsr;
create policy "dsr_insert_own" on public.dsr
  for insert
  to authenticated
  with check (
    created_by = auth.uid()
  );

-- UPDATE: Users can update their own records, admins can update all
drop policy if exists "dsr_update_by_role" on public.dsr;
create policy "dsr_update_by_role" on public.dsr
  for update
  to authenticated
  using (
    created_by = auth.uid()
    or public.is_admin()
  )
  with check (
    created_by = auth.uid()
    or public.is_admin()
  );

-- DELETE: Only admins can delete DSR records (audit trail protection)
drop policy if exists "dsr_delete_admin" on public.dsr;
create policy "dsr_delete_admin" on public.dsr
  for delete
  to authenticated
  using (
    public.is_admin()
  );

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

-- SELECT: All authenticated users can view all records
drop policy if exists "dsr_stock_select_authenticated" on public.dsr_stock;
drop policy if exists "dsr_stock_select_by_role" on public.dsr_stock;
create policy "dsr_stock_select_authenticated" on public.dsr_stock
  for select
  to authenticated
  using (true);

-- INSERT: Users can only insert records owned by themselves
drop policy if exists "dsr_stock_insert_authenticated" on public.dsr_stock;
drop policy if exists "dsr_stock_insert_own" on public.dsr_stock;
create policy "dsr_stock_insert_own" on public.dsr_stock
  for insert
  to authenticated
  with check (
    created_by = auth.uid()
  );

-- UPDATE: Users can update their own records, admins can update all
drop policy if exists "dsr_stock_update_by_role" on public.dsr_stock;
create policy "dsr_stock_update_by_role" on public.dsr_stock
  for update
  to authenticated
  using (
    created_by = auth.uid()
    or public.is_admin()
  )
  with check (
    created_by = auth.uid()
    or public.is_admin()
  );

-- DELETE: Only admins can delete stock records (audit trail protection)
drop policy if exists "dsr_stock_delete_admin" on public.dsr_stock;
create policy "dsr_stock_delete_admin" on public.dsr_stock
  for delete
  to authenticated
  using (
    public.is_admin()
  );

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
create index if not exists expenses_created_at_idx on public.expenses (created_at desc);

comment on table public.expenses is 'Daily operating expenses for profit/loss.';

alter table public.expenses enable row level security;

-- SELECT: All authenticated users can view all records
drop policy if exists "expenses_select_authenticated" on public.expenses;
drop policy if exists "expenses_select_by_role" on public.expenses;
create policy "expenses_select_authenticated" on public.expenses
  for select
  to authenticated
  using (true);

-- INSERT: Users can only insert records owned by themselves
drop policy if exists "expenses_insert_authenticated" on public.expenses;
drop policy if exists "expenses_insert_own" on public.expenses;
create policy "expenses_insert_own" on public.expenses
  for insert
  to authenticated
  with check (
    created_by = auth.uid()
  );

-- UPDATE: Users can update their own records, admins can update all
drop policy if exists "expenses_update_by_role" on public.expenses;
create policy "expenses_update_by_role" on public.expenses
  for update
  to authenticated
  using (
    created_by = auth.uid()
    or public.is_admin()
  )
  with check (
    created_by = auth.uid()
    or public.is_admin()
  );

-- DELETE: Only admins can delete expense records (audit trail protection)
drop policy if exists "expenses_delete_admin" on public.expenses;
create policy "expenses_delete_admin" on public.expenses
  for delete
  to authenticated
  using (
    public.is_admin()
  );

-- Expense categories (user-managed; admin add/delete in Settings)
create table if not exists public.expense_categories (
  id uuid primary key default uuid_generate_v4(),
  name text not null unique,
  label text not null,
  sort_order int not null default 0,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists expense_categories_sort_idx on public.expense_categories (sort_order, label);

comment on table public.expense_categories is 'User-managed expense categories shown in Expenses form and Settings.';

alter table public.expense_categories enable row level security;

drop policy if exists "expense_categories_select_authenticated" on public.expense_categories;
create policy "expense_categories_select_authenticated" on public.expense_categories
  for select to authenticated using (true);

drop policy if exists "expense_categories_insert_admin" on public.expense_categories;
create policy "expense_categories_insert_admin" on public.expense_categories
  for insert to authenticated with check (public.is_admin());

drop policy if exists "expense_categories_update_admin" on public.expense_categories;
create policy "expense_categories_update_admin" on public.expense_categories
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "expense_categories_delete_admin" on public.expense_categories;
create policy "expense_categories_delete_admin" on public.expense_categories
  for delete to authenticated using (public.is_admin());

-- App users (login / operator roles; display_name shown in UI)
create table if not exists public.users (
  id uuid primary key default uuid_generate_v4(),
  email text not null unique,
  role text not null check (role in ('admin', 'supervisor')),
  display_name text check (display_name is null or (char_length(trim(display_name)) <= 120)),
  created_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists users_email_idx on public.users (email);

comment on table public.users is 'App users (login / operator roles). Display name shown in UI.';
comment on column public.users.display_name is 'Name shown in the app (e.g. welcome message). Optional; falls back to email if empty.';

alter table public.users enable row level security;

drop policy if exists "users_select_authenticated" on public.users;
create policy "users_select_authenticated" on public.users
  for select to authenticated using (true);

drop policy if exists "users_insert_admin" on public.users;
create policy "users_insert_admin" on public.users
  for insert to authenticated
  with check (public.is_admin() or not exists (select 1 from public.users u where u.role = 'admin'));

drop policy if exists "users_update_admin" on public.users;
create policy "users_update_admin" on public.users
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "users_delete_admin" on public.users;
create policy "users_delete_admin" on public.users
  for delete to authenticated using (public.is_admin());

-- Employees (pump staff who receive salary – distinct from app users)
create table if not exists public.employees (
  id uuid primary key default uuid_generate_v4(),
  name text not null check (char_length(trim(name)) > 0 and char_length(name) <= 120),
  role_display text check (char_length(role_display) <= 60),
  monthly_salary numeric(14,2) not null default 0 check (monthly_salary >= 0),
  display_order smallint not null default 0,
  is_active boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists employees_display_order_idx on public.employees (display_order, name);

comment on table public.employees is 'Pump employees who receive salary (e.g. supervisor + operators). Used for salary and attendance.';

alter table public.employees enable row level security;

drop policy if exists "employees_select_authenticated" on public.employees;
create policy "employees_select_authenticated" on public.employees
  for select to authenticated using (true);

drop policy if exists "employees_insert_own_or_admin" on public.employees;
create policy "employees_insert_own_or_admin" on public.employees
  for insert to authenticated with check (created_by = auth.uid() or public.is_admin());

drop policy if exists "employees_update_by_role" on public.employees;
create policy "employees_update_by_role" on public.employees
  for update to authenticated
  using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());

drop policy if exists "employees_delete_admin" on public.employees;
create policy "employees_delete_admin" on public.employees
  for delete to authenticated using (public.is_admin());

-- Salary payments (installments: employees receive salary in parts on different days)
create table if not exists public.salary_payments (
  id uuid primary key default uuid_generate_v4(),
  employee_id uuid not null references public.employees (id) on delete restrict,
  date date not null,
  amount numeric(14,2) not null check (amount > 0),
  note text check (char_length(note) <= 200),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists salary_payments_employee_date_idx on public.salary_payments (employee_id, date desc);
create index if not exists salary_payments_date_idx on public.salary_payments (date desc);

comment on table public.salary_payments is 'Installment salary payments to employees. One row per payment (e.g. 2000 today, 3000 next week).';

alter table public.salary_payments enable row level security;

drop policy if exists "salary_payments_select_authenticated" on public.salary_payments;
create policy "salary_payments_select_authenticated" on public.salary_payments
  for select to authenticated using (true);

drop policy if exists "salary_payments_insert_own" on public.salary_payments;
create policy "salary_payments_insert_own" on public.salary_payments
  for insert to authenticated with check (created_by = auth.uid());

drop policy if exists "salary_payments_update_by_role" on public.salary_payments;
create policy "salary_payments_update_by_role" on public.salary_payments
  for update to authenticated
  using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());

drop policy if exists "salary_payments_delete_admin" on public.salary_payments;
create policy "salary_payments_delete_admin" on public.salary_payments
  for delete to authenticated using (public.is_admin());

-- Employee attendance (one row per employee per date: present/absent/half_day/leave, optional check-in/out)
create table if not exists public.employee_attendance (
  id uuid primary key default uuid_generate_v4(),
  employee_id uuid not null references public.employees (id) on delete restrict,
  date date not null,
  status text not null check (status in ('present', 'absent', 'half_day', 'leave')),
  check_in time,
  check_out time,
  note text check (char_length(note) <= 200),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now()),
  updated_at timestamp with time zone default timezone('utc'::text, now()),
  unique (employee_id, date)
);

create index if not exists employee_attendance_date_idx on public.employee_attendance (date desc);
create index if not exists employee_attendance_employee_date_idx on public.employee_attendance (employee_id, date desc);

comment on table public.employee_attendance is 'Daily attendance for employees (present/absent/half_day/leave with optional check-in/out).';

alter table public.employee_attendance enable row level security;

drop policy if exists "employee_attendance_select_authenticated" on public.employee_attendance;
create policy "employee_attendance_select_authenticated" on public.employee_attendance
  for select to authenticated using (true);

drop policy if exists "employee_attendance_insert_own" on public.employee_attendance;
create policy "employee_attendance_insert_own" on public.employee_attendance
  for insert to authenticated with check (created_by = auth.uid());

drop policy if exists "employee_attendance_update_own" on public.employee_attendance;
create policy "employee_attendance_update_own" on public.employee_attendance
  for update to authenticated
  using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());

drop policy if exists "employee_attendance_delete_admin" on public.employee_attendance;
create policy "employee_attendance_delete_admin" on public.employee_attendance
  for delete to authenticated using (public.is_admin());

-- Credit customers ledger
create table if not exists public.credit_customers (
  id uuid primary key default uuid_generate_v4(),
  customer_name text not null check (char_length(customer_name) <= 120),
  vehicle_no text check (char_length(vehicle_no) <= 32),
  amount_due numeric(14,2) not null default 0,
  date date not null default current_date,
  last_payment date,
  notes text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists credit_amount_idx on public.credit_customers (amount_due desc);
create index if not exists credit_customers_created_at_idx on public.credit_customers (created_at desc);
create index if not exists credit_customers_date_idx on public.credit_customers (date desc);

comment on table public.credit_customers is 'Credit ledger for fleet and institutional customers.';
comment on column public.credit_customers.date is 'Date for which this credit applies; used for day-closing credit_today sum.';

alter table public.credit_customers enable row level security;

-- SELECT: All authenticated users can view all records
drop policy if exists "credit_select_authenticated" on public.credit_customers;
drop policy if exists "credit_select_by_role" on public.credit_customers;
create policy "credit_select_authenticated" on public.credit_customers
  for select
  to authenticated
  using (true);

-- INSERT: Users can only insert records owned by themselves
drop policy if exists "credit_insert_authenticated" on public.credit_customers;
drop policy if exists "credit_insert_own" on public.credit_customers;
create policy "credit_insert_own" on public.credit_customers
  for insert
  to authenticated
  with check (
    created_by = auth.uid()
  );

-- UPDATE: Users can update their own records (for settlements), admins can update all
drop policy if exists "credit_update_authenticated" on public.credit_customers;
drop policy if exists "credit_update_by_role" on public.credit_customers;
create policy "credit_update_by_role" on public.credit_customers
  for update
  to authenticated
  using (
    created_by = auth.uid()
    or public.is_admin()
  )
  with check (
    created_by = auth.uid()
    or public.is_admin()
  );

-- DELETE: Only admins can delete credit records (audit trail protection)
drop policy if exists "credit_delete_authenticated" on public.credit_customers;
drop policy if exists "credit_delete_admin" on public.credit_customers;
create policy "credit_delete_admin" on public.credit_customers
  for delete
  to authenticated
  using (
    public.is_admin()
  );

-- ============================================================================
-- CREDIT ENTRIES (one row per credit sale – Transaction Date = DSR date)
-- ============================================================================
create table if not exists public.credit_entries (
  id uuid primary key default uuid_generate_v4(),
  credit_customer_id uuid not null references public.credit_customers (id) on delete restrict,
  transaction_date date not null,
  fuel_type text not null check (fuel_type in ('MS', 'HSD')),
  quantity numeric(14,3) not null check (quantity > 0),
  amount numeric(14,2) not null check (amount > 0),
  amount_settled numeric(14,2) not null default 0 check (amount_settled >= 0),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now()),
  constraint credit_entries_settled_le_amount check (amount_settled <= amount)
);

create index if not exists credit_entries_customer_date_idx on public.credit_entries (credit_customer_id, transaction_date);
create index if not exists credit_entries_transaction_date_idx on public.credit_entries (transaction_date desc);

comment on table public.credit_entries is 'One row per credit sale. Transaction date = DSR date (business date of fuel delivery).';
comment on column public.credit_entries.transaction_date is 'Business date when fuel was dispensed on credit; drives DSR credit_today.';
comment on column public.credit_entries.amount_settled is 'Amount already paid against this entry (FIFO allocation).';

alter table public.credit_entries enable row level security;

drop policy if exists "credit_entries_select_authenticated" on public.credit_entries;
create policy "credit_entries_select_authenticated" on public.credit_entries
  for select to authenticated using (true);

drop policy if exists "credit_entries_insert_own" on public.credit_entries;
create policy "credit_entries_insert_own" on public.credit_entries
  for insert to authenticated with check (created_by = auth.uid());

drop policy if exists "credit_entries_update_by_role" on public.credit_entries;
create policy "credit_entries_update_by_role" on public.credit_entries
  for update to authenticated
  using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());

drop policy if exists "credit_entries_delete_admin" on public.credit_entries;
create policy "credit_entries_delete_admin" on public.credit_entries
  for delete to authenticated using (public.is_admin());

create or replace function public.credit_entries_sync_amount_due()
returns trigger language plpgsql security definer as $$
declare
  v_customer_id uuid;
begin
  if tg_op = 'DELETE' then
    v_customer_id := old.credit_customer_id;
  else
    v_customer_id := new.credit_customer_id;
  end if;
  update public.credit_customers c
  set amount_due = coalesce((
    select sum(e.amount - e.amount_settled)
    from public.credit_entries e
    where e.credit_customer_id = c.id
  ), 0)
  where c.id = v_customer_id;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

drop trigger if exists credit_entries_sync_trigger on public.credit_entries;
create trigger credit_entries_sync_trigger
  after insert or update or delete on public.credit_entries
  for each row execute function public.credit_entries_sync_amount_due();

-- ============================================================================
-- CREDIT PAYMENTS (collection = money received from credit; Settlement Date = date)
-- ============================================================================
create table if not exists public.credit_payments (
  id uuid primary key default uuid_generate_v4(),
  credit_customer_id uuid not null references public.credit_customers (id) on delete restrict,
  date date not null,
  amount numeric(14,2) not null check (amount > 0),
  note text check (char_length(note) <= 200),
  payment_mode text check (payment_mode in ('Cash', 'UPI', 'Bank')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists credit_payments_date_idx on public.credit_payments (date desc);
create index if not exists credit_payments_customer_idx on public.credit_payments (credit_customer_id, date desc);

comment on table public.credit_payments is 'Payments received from credit customers. Sum by date = collection for day closing.';
comment on column public.credit_payments.payment_mode is 'Mode of payment (Cash/UPI/Bank). Settlement date = date column.';

alter table public.credit_payments enable row level security;

drop policy if exists "credit_payments_select_authenticated" on public.credit_payments;
create policy "credit_payments_select_authenticated" on public.credit_payments
  for select to authenticated using (true);

drop policy if exists "credit_payments_insert_own" on public.credit_payments;
create policy "credit_payments_insert_own" on public.credit_payments
  for insert to authenticated
  with check (created_by = auth.uid());

drop policy if exists "credit_payments_update_by_role" on public.credit_payments;
create policy "credit_payments_update_by_role" on public.credit_payments
  for update to authenticated
  using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());

drop policy if exists "credit_payments_delete_admin" on public.credit_payments;
create policy "credit_payments_delete_admin" on public.credit_payments
  for delete to authenticated using (public.is_admin());

-- ============================================================================
-- DAY CLOSING (night cash, phone pay, computed short)
-- Formula: (Total sale + Collection + Short previous) - (Night cash + Phone pay + Credit + Expenses) = Today's short
-- ============================================================================
create table if not exists public.day_closing (
  id uuid primary key default uuid_generate_v4(),
  date date not null unique,
  night_cash numeric(14,2) not null default 0 check (night_cash >= 0),
  phone_pay numeric(14,2) not null default 0 check (phone_pay >= 0),
  short_today numeric(14,2),
  total_sale numeric(14,2),
  collection numeric(14,2),
  short_previous numeric(14,2),
  credit_today numeric(14,2),
  expenses_today numeric(14,2),
  closing_reference text,
  remarks text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now()),
  updated_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists day_closing_date_idx on public.day_closing (date desc);
create unique index if not exists day_closing_closing_reference_idx on public.day_closing (closing_reference) where closing_reference is not null;

comment on table public.day_closing is 'Daily closing statement: full snapshot for accounting and future reference. One row per date.';
comment on column public.day_closing.night_cash is 'Hard cash counted at day end.';
comment on column public.day_closing.phone_pay is 'Money received through PhonePe/UPI.';
comment on column public.day_closing.short_today is 'Computed short; stored for next day short_previous.';
comment on column public.day_closing.total_sale is 'Total sale (₹) at closing – snapshot for accounting.';
comment on column public.day_closing.collection is 'Collection from credit (₹) at closing – snapshot.';
comment on column public.day_closing.short_previous is 'Short carried from previous day (₹) – snapshot.';
comment on column public.day_closing.credit_today is 'New credit (₹) that day – snapshot.';
comment on column public.day_closing.expenses_today is 'Expenses (₹) that day – snapshot.';
comment on column public.day_closing.closing_reference is 'Unique reference for accounting (e.g. DC-2026-00001).';
comment on column public.day_closing.remarks is 'Optional remarks at closing.';

alter table public.day_closing enable row level security;

drop policy if exists "day_closing_select_authenticated" on public.day_closing;
create policy "day_closing_select_authenticated" on public.day_closing
  for select to authenticated using (true);

drop policy if exists "day_closing_insert_own" on public.day_closing;
create policy "day_closing_insert_own" on public.day_closing
  for insert to authenticated
  with check (created_by = auth.uid());

drop policy if exists "day_closing_update_by_role" on public.day_closing;
create policy "day_closing_update_by_role" on public.day_closing
  for update to authenticated
  using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());

drop policy if exists "day_closing_delete_admin" on public.day_closing;
create policy "day_closing_delete_admin" on public.day_closing
  for delete to authenticated using (public.is_admin());

create or replace function public.day_closing_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = timezone('utc'::text, now());
  return new;
end;
$$;
drop trigger if exists day_closing_updated_at_trigger on public.day_closing;
create trigger day_closing_updated_at_trigger
  before update on public.day_closing
  for each row execute function public.day_closing_updated_at();

-- RPC: Get day closing breakdown; when already_saved returns stored snapshot (for accounting)
create or replace function public.get_day_closing_breakdown(p_date date)
returns jsonb
language plpgsql
security definer
stable
as $$
declare
  v_total_sale numeric := 0;
  v_collection numeric := 0;
  v_short_previous numeric := 0;
  v_credit_today numeric := 0;
  v_expenses_today numeric := 0;
  v_row record;
  v_petrol_net numeric;
  v_diesel_net numeric;
  v_petrol_rate numeric;
  v_diesel_rate numeric;
  v_existing record;
  v_already_saved boolean := false;
begin
  select total_sale, collection, short_previous, credit_today, expenses_today,
         night_cash, phone_pay, short_today, closing_reference, remarks
  into v_existing
  from public.day_closing where date = p_date limit 1;
  v_already_saved := found;

  if v_already_saved and v_existing.total_sale is not null then
    return jsonb_build_object(
      'date', p_date,
      'total_sale', coalesce(v_existing.total_sale, 0),
      'collection', coalesce(v_existing.collection, 0),
      'short_previous', coalesce(v_existing.short_previous, 0),
      'credit_today', coalesce(v_existing.credit_today, 0),
      'expenses_today', coalesce(v_existing.expenses_today, 0),
      'night_cash', coalesce(v_existing.night_cash, 0),
      'phone_pay', coalesce(v_existing.phone_pay, 0),
      'short_today', coalesce(v_existing.short_today, 0),
      'closing_reference', v_existing.closing_reference,
      'remarks', v_existing.remarks,
      'already_saved', true
    );
  end if;

  for v_row in
    select product, total_sales, testing, petrol_rate, diesel_rate
    from public.dsr where date = p_date
  loop
    if v_row.product = 'petrol' then
      v_petrol_net := coalesce(v_row.total_sales, 0) - coalesce(v_row.testing, 0);
      v_petrol_rate := coalesce(v_row.petrol_rate, 0);
      v_total_sale := v_total_sale + v_petrol_net * v_petrol_rate;
    elsif v_row.product = 'diesel' then
      v_diesel_net := coalesce(v_row.total_sales, 0) - coalesce(v_row.testing, 0);
      v_diesel_rate := coalesce(v_row.diesel_rate, 0);
      v_total_sale := v_total_sale + v_diesel_net * v_diesel_rate;
    end if;
  end loop;

  select coalesce(sum(amount), 0) into v_collection
  from public.credit_payments where date = p_date;

  select short_today into v_short_previous
  from public.day_closing where date = p_date - interval '1 day' limit 1;
  v_short_previous := coalesce(v_short_previous, 0);

  -- Credit today: credit_entries.amount for transaction_date + legacy credit_customers.amount_due (no entries yet)
  select coalesce(sum(amount), 0) into v_credit_today
  from public.credit_entries where transaction_date = p_date;
  select v_credit_today + coalesce((
    select sum(c.amount_due) from public.credit_customers c
    where c.date = p_date
      and not exists (select 1 from public.credit_entries e where e.credit_customer_id = c.id)
  ), 0) into v_credit_today;

  select coalesce(sum(amount), 0) into v_expenses_today
  from public.expenses where date = p_date;

  if v_already_saved then
    return jsonb_build_object(
      'date', p_date,
      'total_sale', coalesce(v_total_sale, 0),
      'collection', coalesce(v_collection, 0),
      'short_previous', coalesce(v_short_previous, 0),
      'credit_today', coalesce(v_credit_today, 0),
      'expenses_today', coalesce(v_expenses_today, 0),
      'night_cash', coalesce(v_existing.night_cash, 0),
      'phone_pay', coalesce(v_existing.phone_pay, 0),
      'short_today', coalesce(v_existing.short_today, 0),
      'closing_reference', v_existing.closing_reference,
      'remarks', v_existing.remarks,
      'already_saved', true
    );
  end if;

  return jsonb_build_object(
    'date', p_date,
    'total_sale', coalesce(v_total_sale, 0),
    'collection', coalesce(v_collection, 0),
    'short_previous', coalesce(v_short_previous, 0),
    'credit_today', coalesce(v_credit_today, 0),
    'expenses_today', coalesce(v_expenses_today, 0),
    'night_cash', null,
    'phone_pay', null,
    'short_today', null,
    'closing_reference', null,
    'remarks', null,
    'already_saved', false
  );
end;
$$;
comment on function public.get_day_closing_breakdown(date) is 'Returns day closing components. When already_saved with snapshot, returns stored values for accounting. credit_today from credit_entries + legacy credit_customers.';

-- RPC: Save day closing with full statement snapshot and accounting reference
create or replace function public.save_day_closing(
  p_date date,
  p_night_cash numeric,
  p_phone_pay numeric,
  p_remarks text default null
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_total_sale numeric := 0;
  v_collection numeric := 0;
  v_short_previous numeric := 0;
  v_credit_today numeric := 0;
  v_expenses_today numeric := 0;
  v_short_today numeric;
  v_petrol_net numeric;
  v_diesel_net numeric;
  v_petrol_rate numeric;
  v_diesel_rate numeric;
  v_row record;
  v_ref text;
  v_seq bigint;
begin
  if p_night_cash is null or p_night_cash < 0 then
    raise exception 'night_cash must be >= 0';
  end if;
  if p_phone_pay is null or p_phone_pay < 0 then
    raise exception 'phone_pay must be >= 0';
  end if;

  if exists (select 1 from public.day_closing where date = p_date) then
    raise exception 'Day closing already saved for this date.';
  end if;

  for v_row in
    select product, total_sales, testing, petrol_rate, diesel_rate
    from public.dsr where date = p_date
  loop
    if v_row.product = 'petrol' then
      v_petrol_net := coalesce(v_row.total_sales, 0) - coalesce(v_row.testing, 0);
      v_petrol_rate := coalesce(v_row.petrol_rate, 0);
      v_total_sale := v_total_sale + v_petrol_net * v_petrol_rate;
    elsif v_row.product = 'diesel' then
      v_diesel_net := coalesce(v_row.total_sales, 0) - coalesce(v_row.testing, 0);
      v_diesel_rate := coalesce(v_row.diesel_rate, 0);
      v_total_sale := v_total_sale + v_diesel_net * v_diesel_rate;
    end if;
  end loop;

  select coalesce(sum(amount), 0) into v_collection
  from public.credit_payments where date = p_date;

  select short_today into v_short_previous
  from public.day_closing where date = p_date - interval '1 day' limit 1;
  v_short_previous := coalesce(v_short_previous, 0);

  -- Credit today: credit_entries.amount + legacy credit_customers.amount_due (no entries yet)
  select coalesce(sum(amount), 0) into v_credit_today
  from public.credit_entries where transaction_date = p_date;
  select v_credit_today + coalesce((
    select sum(c.amount_due) from public.credit_customers c
    where c.date = p_date
      and not exists (select 1 from public.credit_entries e where e.credit_customer_id = c.id)
  ), 0) into v_credit_today;

  select coalesce(sum(amount), 0) into v_expenses_today
  from public.expenses where date = p_date;

  v_short_today := (v_total_sale + v_collection + v_short_previous)
    - (p_night_cash + p_phone_pay + v_credit_today + v_expenses_today);

  select coalesce(max(
    nullif(regexp_replace(closing_reference, '^DC-[0-9]+-([0-9]+)$', '\1'), '')::bigint
  ), 0) + 1 into v_seq
  from public.day_closing
  where extract(year from date) = extract(year from p_date)
    and closing_reference is not null
    and closing_reference ~ '^DC-[0-9]+-[0-9]+$';
  v_ref := 'DC-' || to_char(p_date, 'YYYY') || '-' || lpad(v_seq::text, 5, '0');

  insert into public.day_closing (
    date, night_cash, phone_pay, short_today,
    total_sale, collection, short_previous, credit_today, expenses_today,
    closing_reference, remarks, created_by
  )
  values (
    p_date, p_night_cash, p_phone_pay, v_short_today,
    v_total_sale, v_collection, v_short_previous, v_credit_today, v_expenses_today,
    v_ref, nullif(trim(p_remarks), ''), auth.uid()
  );

  return jsonb_build_object(
    'date', p_date,
    'total_sale', coalesce(v_total_sale, 0),
    'collection', coalesce(v_collection, 0),
    'short_previous', coalesce(v_short_previous, 0),
    'credit_today', coalesce(v_credit_today, 0),
    'expenses_today', coalesce(v_expenses_today, 0),
    'night_cash', coalesce(p_night_cash, 0),
    'phone_pay', coalesce(p_phone_pay, 0),
    'short_today', coalesce(v_short_today, 0),
    'closing_reference', v_ref,
    'remarks', nullif(trim(p_remarks), '')
  );
end;
$$;
comment on function public.save_day_closing(date, numeric, numeric, text) is 'Save day closing with full statement snapshot and accounting reference. credit_today from credit_entries + legacy credit_customers.';

-- RPC: Add credit entry (Transaction Date = DSR date)
create or replace function public.add_credit_entry(
  p_customer_name text,
  p_transaction_date date,
  p_amount numeric,
  p_vehicle_no text default null,
  p_fuel_type text default 'HSD',
  p_quantity numeric default 1,
  p_notes text default null
)
returns jsonb
language plpgsql security definer
as $$
declare
  v_customer_id uuid;
  v_entry_id uuid;
  v_fuel_type text;
  v_quantity numeric;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;

  v_fuel_type := coalesce(nullif(trim(p_fuel_type), ''), 'HSD');
  if v_fuel_type not in ('MS', 'HSD') then
    raise exception 'fuel_type must be MS or HSD';
  end if;

  v_quantity := coalesce(nullif(p_quantity, 0), 1);
  if v_quantity <= 0 then
    raise exception 'quantity must be positive when provided';
  end if;

  select id into v_customer_id
  from public.credit_customers
  where trim(lower(customer_name)) = trim(lower(p_customer_name))
  order by created_at desc limit 1;

  if v_customer_id is null then
    insert into public.credit_customers (customer_name, vehicle_no, amount_due, date, notes, created_by)
    values (
      trim(p_customer_name),
      nullif(trim(p_vehicle_no), ''),
      0,
      p_transaction_date,
      nullif(trim(p_notes), ''),
      auth.uid()
    )
    returning id into v_customer_id;
  end if;

  insert into public.credit_entries (credit_customer_id, transaction_date, fuel_type, quantity, amount, created_by)
  values (v_customer_id, p_transaction_date, v_fuel_type, v_quantity, p_amount, auth.uid())
  returning id into v_entry_id;

  return jsonb_build_object(
    'credit_customer_id', v_customer_id,
    'credit_entry_id', v_entry_id,
    'transaction_date', p_transaction_date,
    'amount', p_amount
  );
end;
$$;
comment on function public.add_credit_entry(text, date, numeric, text, text, numeric, text) is 'Add a credit sale. Transaction date = DSR date. Fuel type and quantity optional (default HSD, 1).';

-- RPC: Record credit payment (FIFO allocation; Settlement Date; payment_mode)
create or replace function public.record_credit_payment(
  p_credit_customer_id uuid,
  p_date date,
  p_amount numeric,
  p_note text default null,
  p_payment_mode text default 'Cash'
)
returns jsonb
language plpgsql security definer
as $$
declare
  v_remaining numeric := p_amount;
  v_entry record;
  v_alloc numeric;
  v_new_due numeric;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  if p_payment_mode is not null and p_payment_mode not in ('Cash', 'UPI', 'Bank') then
    raise exception 'payment_mode must be Cash, UPI, or Bank';
  end if;

  if not exists (select 1 from public.credit_customers where id = p_credit_customer_id) then
    raise exception 'Credit customer not found';
  end if;

  for v_entry in
    select id, amount, amount_settled
    from public.credit_entries
    where credit_customer_id = p_credit_customer_id
      and amount_settled < amount
    order by transaction_date asc, id asc
    for update
  loop
    exit when v_remaining <= 0;
    v_alloc := least(v_remaining, v_entry.amount - v_entry.amount_settled);
    update public.credit_entries
    set amount_settled = amount_settled + v_alloc
    where id = v_entry.id;
    v_remaining := v_remaining - v_alloc;
  end loop;

  if v_remaining >= p_amount then
    raise exception 'No outstanding balance to apply payment to';
  end if;

  insert into public.credit_payments (credit_customer_id, date, amount, note, payment_mode, created_by)
  values (p_credit_customer_id, p_date, p_amount, nullif(trim(p_note), ''), coalesce(p_payment_mode, 'Cash'), auth.uid());

  select coalesce(sum(amount - amount_settled), 0) into v_new_due
  from public.credit_entries
  where credit_customer_id = p_credit_customer_id;

  update public.credit_customers
  set amount_due = v_new_due, last_payment = p_date
  where id = p_credit_customer_id;

  return jsonb_build_object(
    'credit_customer_id', p_credit_customer_id,
    'date', p_date,
    'amount', p_amount,
    'new_due', v_new_due
  );
end;
$$;
comment on function public.record_credit_payment(uuid, date, numeric, text, text) is 'Record payment; allocate to entries FIFO by transaction date. Settlement date = p_date.';

-- Open credit as of date D (entries with transaction_date <= D minus payments with date <= D)
create or replace function public.get_open_credit_as_of(p_date date)
returns numeric
language plpgsql security definer stable
as $$
declare
  v_total numeric;
begin
  with bal as (
    select e.credit_customer_id, coalesce(sum(e.amount), 0) as credit_tot
    from public.credit_entries e
    where e.transaction_date <= p_date
    group by e.credit_customer_id
  ),
  pay as (
    select credit_customer_id, coalesce(sum(amount), 0) as payment_tot
    from public.credit_payments
    where date <= p_date
    group by credit_customer_id
  )
  select coalesce(sum(greatest(coalesce(b.credit_tot, 0) - coalesce(p.payment_tot, 0), 0)), 0)
  into v_total
  from bal b
  left join pay p on p.credit_customer_id = b.credit_customer_id;
  return v_total;
end;
$$;
comment on function public.get_open_credit_as_of(date) is 'Total outstanding credit as of date D (entries with transaction_date <= D minus payments with date <= D).';

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
           min(e.transaction_date) as min_txn_date
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
           b.min_txn_date as min_txn
    from public.credit_customers c
    left join bal b on b.credit_customer_id = c.id
    left join pay p on p.credit_customer_id = c.id
    where coalesce(b.credit_tot, 0) - coalesce(p.payment_tot, 0) > 0
  )
  select (max(pc.customer_name))::text as customer_name,
         (max(pc.vehicle_no))::text as vehicle_no,
         sum(pc.amt)::numeric as amount_due_as_of,
         max(pc.last_pay) as last_payment_date,
         min(pc.min_txn) as sale_date
  from per_customer pc
  group by lower(trim(pc.customer_name))
  order by amount_due_as_of desc;
end;
$$;
comment on function public.get_outstanding_credit_list_as_of(date) is 'Customers with outstanding balance as of date D; one row per customer (grouped by name). amount_due_as_of and last_payment_date are as of D.';

-- Credit summary for a single customer (by name) as of a date (for overdue page detail modal)
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

-- Per-entry breakdown of credit and settlement for a customer (by name) as of a date
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

-- Combined: summary + breakdown in one call (one round-trip for overdue modal)
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
    select c.id as credit_customer_id from public.credit_customers c
    where lower(trim(c.customer_name)) = lower(trim(p_customer_name))
  ),
  bal as (
    select e.credit_customer_id, coalesce(sum(e.amount), 0) as credit_tot,
           min(e.transaction_date) as min_txn_date, max(e.transaction_date) as max_txn_date
    from public.credit_entries e
    where e.transaction_date <= p_date and e.credit_customer_id in (select credit_customer_id from customer_ids)
    group by e.credit_customer_id
  ),
  pay as (
    select p.credit_customer_id, coalesce(sum(p.amount), 0) as payment_tot, max(p.date) as last_pay_date
    from public.credit_payments p
    where p.date <= p_date and p.credit_customer_id in (select credit_customer_id from customer_ids)
    group by p.credit_customer_id
  ),
  name_match as (
    select c.id as credit_customer_id, max(c.customer_name)::text as customer_name, max(c.vehicle_no)::text as vehicle_no
    from public.credit_customers c join customer_ids ci on ci.credit_customer_id = c.id group by c.id
  ),
  per_customer as (
    select nm.customer_name, nm.vehicle_no, coalesce(b.credit_tot, 0) as credit_taken,
           coalesce(p.payment_tot, 0) as settlement_done,
           (coalesce(b.credit_tot, 0) - coalesce(p.payment_tot, 0))::numeric as remaining,
           p.last_pay_date as last_payment_date, b.min_txn_date as first_sale_date, b.max_txn_date as last_credit_date
    from name_match nm
    left join bal b on b.credit_customer_id = nm.credit_customer_id
    left join pay p on p.credit_customer_id = nm.credit_customer_id
  ),
  agg as (
    select (max(pc.customer_name))::text as customer_name, (max(pc.vehicle_no))::text as vehicle_no,
           sum(pc.credit_taken)::numeric as credit_taken, sum(pc.settlement_done)::numeric as settlement_done,
           sum(pc.remaining)::numeric as remaining, max(pc.last_payment_date) as last_payment_date,
           min(pc.first_sale_date) as first_sale_date, max(pc.last_credit_date) as last_credit_date
    from per_customer pc
  ),
  credits_json as (
    select coalesce(
      (select jsonb_agg(jsonb_build_object('entry_date', e.transaction_date, 'amount', e.amount) order by e.transaction_date)
       from public.credit_entries e
       where e.credit_customer_id in (select credit_customer_id from customer_ids) and e.transaction_date <= p_date),
      '[]'::jsonb
    ) as entries
  ),
  payments_json as (
    select coalesce(
      (select jsonb_agg(jsonb_build_object('entry_date', p.date, 'amount', p.amount) order by p.date)
       from public.credit_payments p
       where p.credit_customer_id in (select credit_customer_id from customer_ids) and p.date <= p_date),
      '[]'::jsonb
    ) as entries
  )
  select a.customer_name, a.vehicle_no, a.credit_taken, a.settlement_done, a.remaining,
         a.last_payment_date, a.first_sale_date, a.last_credit_date, cj.entries as credit_entries, pj.entries as payment_entries
  from agg a, credits_json cj, payments_json pj;
end;
$$;
comment on function public.get_customer_credit_detail_as_of(text, date) is 'Combined credit detail: summary + credit_entries and payment_entries jsonb for overdue modal (one round-trip).';

-- Credit ledger aggregated by customer name (one row per customer; primary id for Settle/Delete)
create or replace function public.get_credit_ledger_aggregated()
returns table (
  id uuid,
  customer_name text,
  vehicle_no text,
  amount_due numeric,
  date date,
  last_payment date,
  notes text
)
language plpgsql security definer stable
as $$
begin
  return query
  with ranked as (
    select c.id, c.customer_name, c.vehicle_no, c.amount_due, c.date, c.last_payment, c.notes,
           row_number() over (partition by lower(trim(c.customer_name)) order by c.amount_due desc nulls last, c.created_at desc) as rn
    from public.credit_customers c
  ),
  agg as (
    select lower(trim(r.customer_name)) as name_key,
           sum(r.amount_due) as total_due,
           min(r.date) as min_date,
           max(r.last_payment) as max_last_pay,
           (array_agg(r.notes order by r.amount_due desc nulls last))[1] as first_notes
    from ranked r
    group by lower(trim(r.customer_name))
  )
  select r.id,
         r.customer_name::text as customer_name,
         r.vehicle_no::text as vehicle_no,
         a.total_due::numeric as amount_due,
         a.min_date as date,
         a.max_last_pay as last_payment,
         a.first_notes::text as notes
  from ranked r
  join agg a on lower(trim(r.customer_name)) = a.name_key
  where r.rn = 1
  order by a.total_due desc nulls last;
end;
$$;
comment on function public.get_credit_ledger_aggregated() is 'Credit ledger with one row per customer (grouped by name). id is primary customer row for Settle/Delete.';

-- ============================================================================
-- AUDIT TRIGGERS (automatic logging of sensitive operations)
-- ============================================================================

-- Generic audit trigger function
create or replace function public.audit_trigger_fn()
returns trigger
language plpgsql
security definer
as $$
begin
  if TG_OP = 'DELETE' then
    insert into public.audit_log (table_name, record_id, action, old_data, performed_by, performed_by_email)
    values (TG_TABLE_NAME, OLD.id, TG_OP, to_jsonb(OLD), auth.uid(), auth.jwt() ->> 'email');
    return OLD;
  elsif TG_OP = 'UPDATE' then
    insert into public.audit_log (table_name, record_id, action, old_data, new_data, performed_by, performed_by_email)
    values (TG_TABLE_NAME, NEW.id, TG_OP, to_jsonb(OLD), to_jsonb(NEW), auth.uid(), auth.jwt() ->> 'email');
    return NEW;
  elsif TG_OP = 'INSERT' then
    insert into public.audit_log (table_name, record_id, action, new_data, performed_by, performed_by_email)
    values (TG_TABLE_NAME, NEW.id, TG_OP, to_jsonb(NEW), auth.uid(), auth.jwt() ->> 'email');
    return NEW;
  end if;
  return null;
end;
$$;

comment on function public.audit_trigger_fn() is 'Generic trigger function for audit logging.';

-- Audit triggers for sensitive tables (users: full trail; financial: full trail)
drop trigger if exists audit_staff_trigger on public.users;
drop trigger if exists audit_users_trigger on public.users;
create trigger audit_users_trigger
  after insert or update or delete on public.users
  for each row execute function public.audit_trigger_fn();

-- DSR: full audit (insert, update, delete) - who changed what and when
drop trigger if exists audit_dsr_delete_trigger on public.dsr;
drop trigger if exists audit_dsr_trigger on public.dsr;
create trigger audit_dsr_trigger
  after insert or update or delete on public.dsr
  for each row execute function public.audit_trigger_fn();

-- DSR stock: full audit
drop trigger if exists audit_dsr_stock_delete_trigger on public.dsr_stock;
drop trigger if exists audit_dsr_stock_trigger on public.dsr_stock;
create trigger audit_dsr_stock_trigger
  after insert or update or delete on public.dsr_stock
  for each row execute function public.audit_trigger_fn();

-- Expenses: full audit
drop trigger if exists audit_expenses_delete_trigger on public.expenses;
drop trigger if exists audit_expenses_trigger on public.expenses;
create trigger audit_expenses_trigger
  after insert or update or delete on public.expenses
  for each row execute function public.audit_trigger_fn();

-- Credit customers: full audit
drop trigger if exists audit_credit_delete_trigger on public.credit_customers;
drop trigger if exists audit_credit_trigger on public.credit_customers;
create trigger audit_credit_trigger
  after insert or update or delete on public.credit_customers
  for each row execute function public.audit_trigger_fn();

-- Staff members: full audit
drop trigger if exists audit_staff_members_trigger on public.employees;
drop trigger if exists audit_employees_trigger on public.employees;
create trigger audit_employees_trigger
  after insert or update or delete on public.employees
  for each row execute function public.audit_trigger_fn();

-- Salary payments: full audit
drop trigger if exists audit_salary_payments_trigger on public.salary_payments;
create trigger audit_salary_payments_trigger
  after insert or update or delete on public.salary_payments
  for each row execute function public.audit_trigger_fn();

-- Staff attendance: full audit
drop trigger if exists audit_staff_attendance_trigger on public.employee_attendance;
drop trigger if exists audit_employee_attendance_trigger on public.employee_attendance;
create trigger audit_employee_attendance_trigger
  after insert or update or delete on public.employee_attendance
  for each row execute function public.audit_trigger_fn();

-- Credit payments: full audit
drop trigger if exists audit_credit_payments_trigger on public.credit_payments;
create trigger audit_credit_payments_trigger
  after insert or update or delete on public.credit_payments
  for each row execute function public.audit_trigger_fn();

-- Day closing: full audit
drop trigger if exists audit_day_closing_trigger on public.day_closing;
create trigger audit_day_closing_trigger
  after insert or update or delete on public.day_closing
  for each row execute function public.audit_trigger_fn();
