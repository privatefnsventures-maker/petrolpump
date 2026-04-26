-- Only admins may insert or update employees (pump staff list). Supervisors keep SELECT
-- for salary and attendance. DELETE policy unchanged (already admin-only).

drop policy if exists "employees_insert_own_or_admin" on public.employees;
drop policy if exists "employees_insert_admin" on public.employees;
create policy "employees_insert_admin" on public.employees
  for insert to authenticated with check (public.is_admin());

drop policy if exists "employees_update_by_role" on public.employees;
drop policy if exists "employees_update_admin" on public.employees;
create policy "employees_update_admin" on public.employees
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

comment on table public.employees is 'Pump employees who receive salary. Mutations: admin only. Used for salary and attendance.';
