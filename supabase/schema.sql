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

-- Get the current user's role from staff table or JWT metadata
-- Returns 'admin', 'supervisor', or null if not found
create or replace function public.get_user_role()
returns text
language sql
security definer
stable
as $$
  select coalesce(
    -- First check staff table (source of truth); match email case-insensitively
    (select role from public.staff where lower(trim(email)) = lower(trim(auth.jwt() ->> 'email')) limit 1),
    -- Fallback to JWT metadata
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

-- Secure function to add/update staff (admin-only, server-side validation)
create or replace function public.upsert_staff(
  p_email text,
  p_role text
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_result jsonb;
begin
  -- Validate admin access
  if not public.is_admin() then
    -- Allow first admin creation when no admins exist
    if exists (select 1 from public.staff where role = 'admin') then
      raise exception 'Access denied: Admin role required';
    end if;
  end if;

  -- Validate role
  if p_role not in ('admin', 'supervisor') then
    raise exception 'Invalid role: must be admin or supervisor';
  end if;

  -- Validate email
  if p_email is null or trim(p_email) = '' then
    raise exception 'Email is required';
  end if;

  -- Perform upsert
  insert into public.staff (email, role)
  values (lower(trim(p_email)), p_role)
  on conflict (email) do update set role = p_role
  returning jsonb_build_object('id', id, 'email', email, 'role', role) into v_result;

  return v_result;
end;
$$;

comment on function public.upsert_staff(text, text) is 'Securely add or update staff with server-side admin validation.';

-- Secure function to delete staff (admin-only, with audit)
create or replace function public.delete_staff(p_email text)
returns boolean
language plpgsql
security definer
as $$
begin
  -- Validate admin access
  if not public.is_admin() then
    raise exception 'Access denied: Admin role required';
  end if;

  -- Prevent self-deletion
  if lower(trim(p_email)) = lower(auth.jwt() ->> 'email') then
    raise exception 'Cannot delete your own account';
  end if;

  -- Delete the staff record
  delete from public.staff where email = lower(trim(p_email));
  
  return found;
end;
$$;

comment on function public.delete_staff(text) is 'Securely delete staff with server-side admin validation.';

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

create policy "expense_categories_select_authenticated" on public.expense_categories
  for select to authenticated using (true);

create policy "expense_categories_insert_admin" on public.expense_categories
  for insert to authenticated with check (public.is_admin());

create policy "expense_categories_update_admin" on public.expense_categories
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "expense_categories_delete_admin" on public.expense_categories
  for delete to authenticated using (public.is_admin());

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

-- SELECT: All authenticated users can view all staff records
-- Note: is_admin() function uses SECURITY DEFINER so it bypasses RLS
drop policy if exists "staff_select_authenticated" on public.staff;
drop policy if exists "staff_select_by_role" on public.staff;
create policy "staff_select_authenticated" on public.staff
  for select
  to authenticated
  using (true);
-- INSERT: Only admins can add staff (or first user when no admin exists)
drop policy if exists "staff_insert_admin" on public.staff;
create policy "staff_insert_admin" on public.staff
  for insert
  to authenticated
  with check (
    public.is_admin()
    or not exists (select 1 from public.staff s where s.role = 'admin')
  );

-- UPDATE: Only admins can modify staff records
drop policy if exists "staff_update_admin" on public.staff;
create policy "staff_update_admin" on public.staff
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- DELETE: Only admins can remove staff
drop policy if exists "staff_delete_admin" on public.staff;
create policy "staff_delete_admin" on public.staff
  for delete
  to authenticated
  using (public.is_admin());

-- Staff members (salary recipients: 5 staff including supervisor - distinct from login staff)
create table if not exists public.staff_members (
  id uuid primary key default uuid_generate_v4(),
  name text not null check (char_length(trim(name)) > 0 and char_length(name) <= 120),
  role_display text check (char_length(role_display) <= 60),
  monthly_salary numeric(14,2) not null default 0 check (monthly_salary >= 0),
  display_order smallint not null default 0,
  is_active boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists staff_members_display_order_idx on public.staff_members (display_order, name);

comment on table public.staff_members is 'Pump staff who receive salary (e.g. supervisor + 4 operators). Used for installment salary tracking.';

alter table public.staff_members enable row level security;

drop policy if exists "staff_members_select_authenticated" on public.staff_members;
create policy "staff_members_select_authenticated" on public.staff_members
  for select to authenticated using (true);

drop policy if exists "staff_members_insert_own_or_admin" on public.staff_members;
create policy "staff_members_insert_own_or_admin" on public.staff_members
  for insert to authenticated
  with check (created_by = auth.uid() or public.is_admin());

drop policy if exists "staff_members_update_by_role" on public.staff_members;
create policy "staff_members_update_by_role" on public.staff_members
  for update to authenticated
  using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());

drop policy if exists "staff_members_delete_admin" on public.staff_members;
create policy "staff_members_delete_admin" on public.staff_members
  for delete to authenticated using (public.is_admin());

-- Salary payments (installments: staff take salary in parts on different days)
create table if not exists public.salary_payments (
  id uuid primary key default uuid_generate_v4(),
  staff_member_id uuid not null references public.staff_members (id) on delete restrict,
  date date not null,
  amount numeric(14,2) not null check (amount > 0),
  note text check (char_length(note) <= 200),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists salary_payments_staff_date_idx on public.salary_payments (staff_member_id, date desc);
create index if not exists salary_payments_date_idx on public.salary_payments (date desc);

comment on table public.salary_payments is 'Installment salary payments to staff. One row per payment (e.g. 2000 today, 3000 next week).';

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

-- Staff attendance (one row per staff_member per date: present/absent/half_day/leave, optional check-in/out)
create table if not exists public.staff_attendance (
  id uuid primary key default uuid_generate_v4(),
  staff_member_id uuid not null references public.staff_members (id) on delete restrict,
  date date not null,
  status text not null check (status in ('present', 'absent', 'half_day', 'leave')),
  check_in time,
  check_out time,
  note text check (char_length(note) <= 200),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now()),
  updated_at timestamp with time zone default timezone('utc'::text, now()),
  unique (staff_member_id, date)
);

create index if not exists staff_attendance_date_idx on public.staff_attendance (date desc);
create index if not exists staff_attendance_staff_date_idx on public.staff_attendance (staff_member_id, date desc);

comment on table public.staff_attendance is 'Daily attendance for staff members (present/absent/half_day/leave with optional check-in/out times).';

alter table public.staff_attendance enable row level security;

drop policy if exists "staff_attendance_select_authenticated" on public.staff_attendance;
create policy "staff_attendance_select_authenticated" on public.staff_attendance
  for select to authenticated using (true);

drop policy if exists "staff_attendance_insert_own" on public.staff_attendance;
create policy "staff_attendance_insert_own" on public.staff_attendance
  for insert to authenticated with check (created_by = auth.uid());

drop policy if exists "staff_attendance_update_own" on public.staff_attendance;
create policy "staff_attendance_update_own" on public.staff_attendance
  for update to authenticated
  using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());

drop policy if exists "staff_attendance_delete_admin" on public.staff_attendance;
create policy "staff_attendance_delete_admin" on public.staff_attendance
  for delete to authenticated using (public.is_admin());

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
create index if not exists credit_customers_created_at_idx on public.credit_customers (created_at desc);

comment on table public.credit_customers is 'Credit ledger for fleet and institutional customers.';

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
-- CREDIT PAYMENTS (collection = money received from credit on that day)
-- ============================================================================
create table if not exists public.credit_payments (
  id uuid primary key default uuid_generate_v4(),
  credit_customer_id uuid not null references public.credit_customers (id) on delete restrict,
  date date not null,
  amount numeric(14,2) not null check (amount > 0),
  note text check (char_length(note) <= 200),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists credit_payments_date_idx on public.credit_payments (date desc);
create index if not exists credit_payments_customer_idx on public.credit_payments (credit_customer_id, date desc);

comment on table public.credit_payments is 'Payments received from credit customers. Sum by date = collection for day closing.';

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
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now()),
  updated_at timestamp with time zone default timezone('utc'::text, now())
);

create index if exists day_closing_date_idx on public.day_closing (date desc);

comment on table public.day_closing is 'Daily cash closing: night cash (hard cash), phone pay (UPI). short_today computed from formula and stored for next day short_previous.';
comment on column public.day_closing.night_cash is 'Hard cash counted at day end.';
comment on column public.day_closing.phone_pay is 'Money received through PhonePe/UPI.';
comment on column public.day_closing.short_today is 'Computed: (total_sale + collection + short_previous) - (night_cash + phone_pay + credit + expenses). Stored for next day short_previous.';

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

-- RPC: Get day closing breakdown (for UI preview; does not save)
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

  select coalesce(sum(amount_due), 0) into v_credit_today
  from public.credit_customers
  where (created_at at time zone 'utc')::date = p_date;

  select coalesce(sum(amount), 0) into v_expenses_today
  from public.expenses where date = p_date;

  select night_cash, phone_pay, short_today into v_existing
  from public.day_closing where date = p_date limit 1;
  v_already_saved := found;

  return jsonb_build_object(
    'date', p_date,
    'total_sale', v_total_sale,
    'collection', v_collection,
    'short_previous', v_short_previous,
    'credit_today', v_credit_today,
    'expenses_today', v_expenses_today,
    'night_cash', case when v_existing.night_cash is not null then v_existing.night_cash else null end,
    'phone_pay', case when v_existing.phone_pay is not null then v_existing.phone_pay else null end,
    'short_today', v_existing.short_today,
    'already_saved', v_already_saved
  );
end;
$$;
comment on function public.get_day_closing_breakdown(date) is 'Returns day closing formula components for UI preview. Does not save. already_saved=true when day closing exists for p_date.';

-- RPC: Save day closing and compute short_today server-side (foolproof formula)
create or replace function public.save_day_closing(
  p_date date,
  p_night_cash numeric,
  p_phone_pay numeric
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

  select coalesce(sum(amount_due), 0) into v_credit_today
  from public.credit_customers
  where (created_at at time zone 'utc')::date = p_date;

  select coalesce(sum(amount), 0) into v_expenses_today
  from public.expenses where date = p_date;

  v_short_today := (v_total_sale + v_collection + v_short_previous)
    - (p_night_cash + p_phone_pay + v_credit_today + v_expenses_today);

  insert into public.day_closing (date, night_cash, phone_pay, short_today, created_by)
  values (p_date, p_night_cash, p_phone_pay, v_short_today, auth.uid());

  return jsonb_build_object(
    'date', p_date,
    'total_sale', v_total_sale,
    'collection', v_collection,
    'short_previous', v_short_previous,
    'night_cash', p_night_cash,
    'phone_pay', p_phone_pay,
    'credit_today', v_credit_today,
    'expenses_today', v_expenses_today,
    'short_today', v_short_today
  );
end;
$$;
comment on function public.save_day_closing(date, numeric, numeric) is 'Save day closing (night_cash, phone_pay) and compute short_today server-side. One entry per date; duplicate save raises.';

-- RPC: Record credit payment (collection) and update customer balance
create or replace function public.record_credit_payment(
  p_credit_customer_id uuid,
  p_date date,
  p_amount numeric,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_current_due numeric;
  v_new_due numeric;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;

  select amount_due into v_current_due
  from public.credit_customers where id = p_credit_customer_id for update;
  if not found then
    raise exception 'Credit customer not found';
  end if;

  v_new_due := v_current_due - p_amount;
  if v_new_due < 0 then
    raise exception 'Payment amount (%) exceeds amount due (%)', p_amount, v_current_due;
  end if;

  update public.credit_customers
  set amount_due = v_new_due, last_payment = p_date
  where id = p_credit_customer_id;

  insert into public.credit_payments (credit_customer_id, date, amount, note, created_by)
  values (p_credit_customer_id, p_date, p_amount, nullif(trim(p_note), ''), auth.uid());

  return jsonb_build_object(
    'credit_customer_id', p_credit_customer_id,
    'date', p_date,
    'amount', p_amount,
    'previous_due', v_current_due,
    'new_due', v_new_due
  );
end;
$$;
comment on function public.record_credit_payment(uuid, date, numeric, text) is 'Record payment from credit customer; updates amount_due and inserts credit_payments for day-closing collection.';

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

-- Audit triggers for sensitive tables (staff: full trail; financial: full trail)
drop trigger if exists audit_staff_trigger on public.staff;
create trigger audit_staff_trigger
  after insert or update or delete on public.staff
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
drop trigger if exists audit_staff_members_trigger on public.staff_members;
create trigger audit_staff_members_trigger
  after insert or update or delete on public.staff_members
  for each row execute function public.audit_trigger_fn();

-- Salary payments: full audit
drop trigger if exists audit_salary_payments_trigger on public.salary_payments;
create trigger audit_salary_payments_trigger
  after insert or update or delete on public.salary_payments
  for each row execute function public.audit_trigger_fn();

-- Staff attendance: full audit
drop trigger if exists audit_staff_attendance_trigger on public.staff_attendance;
create trigger audit_staff_attendance_trigger
  after insert or update or delete on public.staff_attendance
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
