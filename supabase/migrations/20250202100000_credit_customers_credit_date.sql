-- Add date column to credit_customers: the day for which this credit applies (default today).
-- Day closing uses this date to sum "credit_today" instead of created_at.

alter table public.credit_customers
  add column if not exists date date default current_date;

-- Backfill existing rows: use created_at date as credit date
update public.credit_customers
  set date = (created_at at time zone 'utc')::date;

create index if not exists credit_customers_date_idx on public.credit_customers (date desc);

comment on column public.credit_customers.date is 'Date for which this credit applies; used for day-closing credit_today sum.';

-- ============================================================================
-- get_day_closing_breakdown: use credit_customers.date for credit_today
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
  where date = p_date;

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

-- ============================================================================
-- save_day_closing: use credit_customers.date for credit_today
-- ============================================================================
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
  where date = p_date;

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
