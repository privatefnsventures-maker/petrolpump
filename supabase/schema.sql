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
    -- First check staff table (source of truth)
    (select role from public.staff where email = (auth.jwt() ->> 'email') limit 1),
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

-- Audit triggers for sensitive tables (staff changes and deletions)
drop trigger if exists audit_staff_trigger on public.staff;
create trigger audit_staff_trigger
  after insert or update or delete on public.staff
  for each row execute function public.audit_trigger_fn();

-- Audit DELETE operations on financial tables (admin-only operations)
drop trigger if exists audit_dsr_delete_trigger on public.dsr;
create trigger audit_dsr_delete_trigger
  after delete on public.dsr
  for each row execute function public.audit_trigger_fn();

drop trigger if exists audit_dsr_stock_delete_trigger on public.dsr_stock;
create trigger audit_dsr_stock_delete_trigger
  after delete on public.dsr_stock
  for each row execute function public.audit_trigger_fn();

drop trigger if exists audit_expenses_delete_trigger on public.expenses;
create trigger audit_expenses_delete_trigger
  after delete on public.expenses
  for each row execute function public.audit_trigger_fn();

drop trigger if exists audit_credit_delete_trigger on public.credit_customers;
create trigger audit_credit_delete_trigger
  after delete on public.credit_customers
  for each row execute function public.audit_trigger_fn();
