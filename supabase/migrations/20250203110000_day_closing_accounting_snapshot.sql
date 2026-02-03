-- Day closing: store full statement snapshot for accounting and future reference.
-- Each saved row is a complete, immutable closing statement with reference number.

-- ============================================================================
-- 1. Add snapshot and accounting columns to day_closing
-- ============================================================================
alter table public.day_closing
  add column if not exists total_sale numeric(14,2),
  add column if not exists collection numeric(14,2),
  add column if not exists short_previous numeric(14,2),
  add column if not exists credit_today numeric(14,2),
  add column if not exists expenses_today numeric(14,2),
  add column if not exists closing_reference text,
  add column if not exists remarks text;

comment on column public.day_closing.total_sale is 'Total sale (₹) at closing – snapshot for accounting.';
comment on column public.day_closing.collection is 'Collection from credit (₹) at closing – snapshot.';
comment on column public.day_closing.short_previous is 'Short carried from previous day (₹) – snapshot.';
comment on column public.day_closing.credit_today is 'New credit (₹) that day – snapshot.';
comment on column public.day_closing.expenses_today is 'Expenses (₹) that day – snapshot.';
comment on column public.day_closing.closing_reference is 'Unique reference for accounting (e.g. DC-2026-00001).';
comment on column public.day_closing.remarks is 'Optional remarks at closing.';

create unique index if not exists day_closing_closing_reference_idx on public.day_closing (closing_reference) where closing_reference is not null;

-- ============================================================================
-- 2. get_day_closing_breakdown: when already_saved, return stored snapshot values
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
  -- If a closing already exists for this date, return the saved snapshot (for accounting consistency)
  select total_sale, collection, short_previous, credit_today, expenses_today,
         night_cash, phone_pay, short_today, closing_reference, remarks
  into v_existing
  from public.day_closing where date = p_date limit 1;
  v_already_saved := found;

  if v_already_saved and v_existing.total_sale is not null then
    return jsonb_build_object(
      'date', p_date,
      'total_sale', v_existing.total_sale,
      'collection', v_existing.collection,
      'short_previous', v_existing.short_previous,
      'credit_today', v_existing.credit_today,
      'expenses_today', v_existing.expenses_today,
      'night_cash', v_existing.night_cash,
      'phone_pay', v_existing.phone_pay,
      'short_today', v_existing.short_today,
      'closing_reference', v_existing.closing_reference,
      'remarks', v_existing.remarks,
      'already_saved', true
    );
  end if;

  -- Otherwise compute live (for preview before save)
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
  from public.credit_customers where date = p_date;

  select coalesce(sum(amount), 0) into v_expenses_today
  from public.expenses where date = p_date;

  if v_already_saved then
    return jsonb_build_object(
      'date', p_date,
      'total_sale', v_total_sale,
      'collection', v_collection,
      'short_previous', v_short_previous,
      'credit_today', v_credit_today,
      'expenses_today', v_expenses_today,
      'night_cash', v_existing.night_cash,
      'phone_pay', v_existing.phone_pay,
      'short_today', v_existing.short_today,
      'closing_reference', v_existing.closing_reference,
      'remarks', v_existing.remarks,
      'already_saved', true
    );
  end if;

  return jsonb_build_object(
    'date', p_date,
    'total_sale', v_total_sale,
    'collection', v_collection,
    'short_previous', v_short_previous,
    'credit_today', v_credit_today,
    'expenses_today', v_expenses_today,
    'night_cash', null,
    'phone_pay', null,
    'short_today', null,
    'closing_reference', null,
    'remarks', null,
    'already_saved', false
  );
end;
$$;

-- ============================================================================
-- 3. save_day_closing: store full snapshot and generate closing_reference
-- ============================================================================
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

  -- Compute formula components (same as breakdown)
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
  from public.credit_customers where date = p_date;

  select coalesce(sum(amount), 0) into v_expenses_today
  from public.expenses where date = p_date;

  v_short_today := (v_total_sale + v_collection + v_short_previous)
    - (p_night_cash + p_phone_pay + v_credit_today + v_expenses_today);

  -- Generate accounting reference: DC-YYYY-NNNNN (per-year sequence)
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
    'total_sale', v_total_sale,
    'collection', v_collection,
    'short_previous', v_short_previous,
    'night_cash', p_night_cash,
    'phone_pay', p_phone_pay,
    'credit_today', v_credit_today,
    'expenses_today', v_expenses_today,
    'short_today', v_short_today,
    'closing_reference', v_ref,
    'remarks', nullif(trim(p_remarks), '')
  );
end;
$$;

comment on function public.save_day_closing(date, numeric, numeric, text) is 'Save day closing with full statement snapshot and accounting reference. One entry per date; duplicate save raises.';
