-- Expense categories: user-managed list for the Expenses page
-- expenses.category stores the category name (slug); display label comes from expense_categories

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

-- SELECT: all authenticated users can read
create policy "expense_categories_select_authenticated" on public.expense_categories
  for select to authenticated using (true);

-- INSERT/UPDATE/DELETE: admin only
create policy "expense_categories_insert_admin" on public.expense_categories
  for insert to authenticated with check (public.is_admin());

create policy "expense_categories_update_admin" on public.expense_categories
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "expense_categories_delete_admin" on public.expense_categories
  for delete to authenticated using (public.is_admin());

-- Seed default categories (match current hardcoded list in app)
insert into public.expense_categories (name, label, sort_order)
values
  ('miscellaneous', 'Miscellaneous', 1),
  ('staff_food', 'Staff food', 2),
  ('salary', 'Salary', 3),
  ('maintenance', 'Maintenance', 4),
  ('electricity', 'Electricity', 5),
  ('rent', 'Rent', 6),
  ('security', 'Security', 7),
  ('others', 'Others', 8)
on conflict (name) do update set label = excluded.label, sort_order = excluded.sort_order;
