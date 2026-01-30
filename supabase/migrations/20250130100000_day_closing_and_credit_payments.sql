-- Day closing & short calculation
-- Formula: (Total sale + Collection + Short previous) - (Night cash + Phone pay + Credit + Expenses) = Today's short
-- credit_payments: tracks money received from credit customers by date (collection)
-- day_closing: per-day cash counts and computed short

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
-- DAY CLOSING (night cash, phone pay, and computed short)
-- ============================================================================
-- Only night_cash and phone_pay are stored; short_today is computed on save/display.
-- short_today = (total_sale + collection + short_previous) - (night_cash + phone_pay + credit_today + expenses_today)
create table if not exists public.day_closing (
  id uuid primary key default uuid_generate_v4(),
  date date not null unique,
  night_cash numeric(14,2) not null default 0 check (night_cash >= 0),
  phone_pay numeric(14,2) not null default 0 check (phone_pay >= 0),
  short_today numeric(14,2),  -- computed and stored so next day can use as short_previous
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now()),
  updated_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists day_closing_date_idx on public.day_closing (date desc);

comment on table public.day_closing is 'Daily cash closing: night cash (hard cash), phone pay (UPI). short_today is computed from formula and stored for next day short_previous.';
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

-- Trigger to set updated_at on day_closing
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

-- Audit for day_closing and credit_payments
drop trigger if exists audit_credit_payments_trigger on public.credit_payments;
create trigger audit_credit_payments_trigger
  after insert or update or delete on public.credit_payments
  for each row execute function public.audit_trigger_fn();

drop trigger if exists audit_day_closing_trigger on public.day_closing;
create trigger audit_day_closing_trigger
  after insert or update or delete on public.day_closing
  for each row execute function public.audit_trigger_fn();

-- ============================================================================
-- RPC: Get day closing breakdown (for UI preview; does not save)
-- ============================================================================
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

  return jsonb_build_object(
    'date', p_date,
    'total_sale', v_total_sale,
    'collection', v_collection,
    'short_previous', v_short_previous,
    'credit_today', v_credit_today,
    'expenses_today', v_expenses_today,
    'night_cash', case when v_existing.night_cash is not null then v_existing.night_cash else null end,
    'phone_pay', case when v_existing.phone_pay is not null then v_existing.phone_pay else null end,
    'short_today', v_existing.short_today
  );
end;
$$;
comment on function public.get_day_closing_breakdown(date) is 'Returns day closing formula components for UI preview. Does not save.';

-- ============================================================================
-- RPC: Save day closing and compute short_today server-side (foolproof formula)
-- ============================================================================
-- Formula: short_today = (total_sale + collection + short_previous) - (night_cash + phone_pay + credit_today + expenses_today)
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

  -- Total sale (quantity * rate) for p_date from DSR
  for v_row in
    select product, total_sales, testing, petrol_rate, diesel_rate
    from public.dsr
    where date = p_date
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

  -- Collection: sum of credit_payments on p_date
  select coalesce(sum(amount), 0) into v_collection
  from public.credit_payments where date = p_date;

  -- Short of previous day
  select short_today into v_short_previous
  from public.day_closing where date = p_date - interval '1 day' limit 1;
  v_short_previous := coalesce(v_short_previous, 0);

  -- New credit on p_date (amount_due of entries created on that date)
  select coalesce(sum(amount_due), 0) into v_credit_today
  from public.credit_customers
  where (created_at at time zone 'utc')::date = p_date;

  -- Expenses on p_date
  select coalesce(sum(amount), 0) into v_expenses_today
  from public.expenses where date = p_date;

  -- Today's short
  v_short_today := (v_total_sale + v_collection + v_short_previous)
    - (p_night_cash + p_phone_pay + v_credit_today + v_expenses_today);

  insert into public.day_closing (date, night_cash, phone_pay, short_today, created_by)
  values (p_date, p_night_cash, p_phone_pay, v_short_today, auth.uid())
  on conflict (date) do update set
    night_cash = excluded.night_cash,
    phone_pay = excluded.phone_pay,
    short_today = excluded.short_today,
    updated_at = timezone('utc'::text, now());

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
comment on function public.save_day_closing(date, numeric, numeric) is 'Save day closing (night_cash, phone_pay) and compute short_today server-side. Returns all formula components.';

-- ============================================================================
-- RPC: Record credit payment (collection) and update customer balance
-- ============================================================================
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
