-- Add shift to employee_attendance (morning/afternoon, configurable in Settings; no check-in/check-out times stored here)
alter table public.employee_attendance
  add column if not exists shift text;

comment on column public.employee_attendance.shift is 'Shift name key: morning, afternoon, or null. Display names from Settings > Attendance shifts.';
