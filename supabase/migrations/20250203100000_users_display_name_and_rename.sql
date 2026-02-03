-- Add display_name for app users and rename tables for readability:
-- staff -> users (app login users), staff_members -> employees (pump employees)

-- ============================================================================
-- 1. Add display_name to staff (before rename)
-- ============================================================================
alter table public.staff
  add column if not exists display_name text check (char_length(trim(display_name)) <= 120 or display_name is null);

comment on column public.staff.display_name is 'Name shown in the app (e.g. welcome message). Optional; falls back to email if empty.';

-- ============================================================================
-- 2. Rename staff -> users
-- ============================================================================
alter table public.staff rename to users;

-- ============================================================================
-- 3. Update role helper to read from users
-- ============================================================================
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

-- ============================================================================
-- 4. Update upsert_staff / delete_staff to use users table (keep function names for API)
-- ============================================================================
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
  on conflict (email) do update set
    role = excluded.role,
    display_name = excluded.display_name
  returning jsonb_build_object('id', id, 'email', email, 'role', role, 'display_name', display_name) into v_result;
  return v_result;
end;
$$;

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

-- ============================================================================
-- 5. RLS for users (drop old staff policies, create users policies)
-- ============================================================================
drop policy if exists "staff_select_authenticated" on public.users;
drop policy if exists "staff_select_by_role" on public.users;
create policy "users_select_authenticated" on public.users
  for select to authenticated using (true);

drop policy if exists "staff_insert_admin" on public.users;
create policy "users_insert_admin" on public.users
  for insert to authenticated
  with check (
    public.is_admin()
    or not exists (select 1 from public.users u where u.role = 'admin')
  );

drop policy if exists "staff_update_admin" on public.users;
create policy "users_update_admin" on public.users
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "staff_delete_admin" on public.users;
create policy "users_delete_admin" on public.users
  for delete to authenticated using (public.is_admin());

comment on table public.users is 'App users (login / operator roles). Display name shown in UI.';

-- ============================================================================
-- 6. Rename staff_members -> employees
-- ============================================================================
alter table public.staff_members rename to employees;

comment on table public.employees is 'Pump employees who receive salary (e.g. supervisor + operators). Used for salary and attendance.';

drop policy if exists "staff_members_select_authenticated" on public.employees;
create policy "employees_select_authenticated" on public.employees
  for select to authenticated using (true);

drop policy if exists "staff_members_insert_own_or_admin" on public.employees;
create policy "employees_insert_own_or_admin" on public.employees
  for insert to authenticated with check (created_by = auth.uid() or public.is_admin());

drop policy if exists "staff_members_update_by_role" on public.employees;
create policy "employees_update_by_role" on public.employees
  for update to authenticated
  using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());

drop policy if exists "staff_members_delete_admin" on public.employees;
create policy "employees_delete_admin" on public.employees
  for delete to authenticated using (public.is_admin());

-- ============================================================================
-- 7. salary_payments: staff_member_id -> employee_id, FK to employees
-- ============================================================================
alter table public.salary_payments
  drop constraint if exists salary_payments_staff_member_id_fkey;
alter table public.salary_payments
  rename column staff_member_id to employee_id;
alter table public.salary_payments
  add constraint salary_payments_employee_id_fkey
  foreign key (employee_id) references public.employees (id) on delete restrict;

drop index if exists salary_payments_staff_date_idx;
create index if not exists salary_payments_employee_date_idx on public.salary_payments (employee_id, date desc);

-- ============================================================================
-- 8. staff_attendance: staff_member_id -> employee_id, then rename table to employee_attendance
-- ============================================================================
alter table public.staff_attendance
  drop constraint if exists staff_attendance_staff_member_id_fkey;
alter table public.staff_attendance
  rename column staff_member_id to employee_id;
alter table public.staff_attendance
  add constraint staff_attendance_employee_id_fkey
  foreign key (employee_id) references public.employees (id) on delete restrict;

alter table public.staff_attendance rename to employee_attendance;

drop index if exists staff_attendance_staff_date_idx;
create index if not exists employee_attendance_employee_date_idx on public.employee_attendance (employee_id, date desc);
drop index if exists staff_attendance_date_idx;
create index if not exists employee_attendance_date_idx on public.employee_attendance (date desc);

drop policy if exists "staff_attendance_select_authenticated" on public.employee_attendance;
create policy "employee_attendance_select_authenticated" on public.employee_attendance
  for select to authenticated using (true);
drop policy if exists "staff_attendance_insert_own" on public.employee_attendance;
create policy "employee_attendance_insert_own" on public.employee_attendance
  for insert to authenticated with check (created_by = auth.uid());
drop policy if exists "staff_attendance_update_own" on public.employee_attendance;
create policy "employee_attendance_update_own" on public.employee_attendance
  for update to authenticated
  using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());
drop policy if exists "staff_attendance_delete_admin" on public.employee_attendance;
create policy "employee_attendance_delete_admin" on public.employee_attendance
  for delete to authenticated using (public.is_admin());

comment on table public.employee_attendance is 'Daily attendance for employees (present/absent/half_day/leave with optional check-in/out).';

-- ============================================================================
-- 9. Audit triggers: staff -> users, staff_members -> employees, staff_attendance -> employee_attendance
-- ============================================================================
drop trigger if exists audit_staff_trigger on public.users;
create trigger audit_users_trigger
  after insert or update or delete on public.users
  for each row execute function public.audit_trigger_fn();

drop trigger if exists audit_staff_members_trigger on public.employees;
create trigger audit_employees_trigger
  after insert or update or delete on public.employees
  for each row execute function public.audit_trigger_fn();

drop trigger if exists audit_staff_attendance_trigger on public.employee_attendance;
create trigger audit_employee_attendance_trigger
  after insert or update or delete on public.employee_attendance
  for each row execute function public.audit_trigger_fn();
