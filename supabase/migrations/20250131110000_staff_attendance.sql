-- Staff attendance: one row per staff_member per date (present/absent/half_day/leave, optional check-in/out)
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

-- Audit
drop trigger if exists audit_staff_attendance_trigger on public.staff_attendance;
create trigger audit_staff_attendance_trigger
  after insert or update or delete on public.staff_attendance
  for each row execute function public.audit_trigger_fn();
