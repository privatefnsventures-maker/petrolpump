-- Fix day closing: credit_today must come from credit_entries.amount (new credit sales on that date).
-- credit_entries has amount and amount_settled, NOT amount_due. Using amount_due caused 42703.

-- get_day_closing_breakdown: use sum(amount) from credit_entries where transaction_date = p_date
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
  select total_sale, collection, short_previous, credit_today, expenses_today,
         night_cash, phone_pay, short_today, closing_reference, remarks
  into v_existing
  from public.day_closing where date = p_date limit 1;
  v_already_saved := found;

  if v_already_saved and v_existing.total_sale is not null then
    return jsonb_build_object(
      'date', p_date,
      'total_sale', coalesce(v_existing.total_sale, 0),
      'collection', coalesce(v_existing.collection, 0),
      'short_previous', coalesce(v_existing.short_previous, 0),
      'credit_today', coalesce(v_existing.credit_today, 0),
      'expenses_today', coalesce(v_existing.expenses_today, 0),
      'night_cash', coalesce(v_existing.night_cash, 0),
      'phone_pay', coalesce(v_existing.phone_pay, 0),
      'short_today', coalesce(v_existing.short_today, 0),
      'closing_reference', v_existing.closing_reference,
      'remarks', v_existing.remarks,
      'already_saved', true
    );
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

  -- Credit today: credit_entries.amount for transaction_date (new flow) + legacy credit_customers.amount_due for date with no entries
  select coalesce(sum(amount), 0) into v_credit_today
  from public.credit_entries where transaction_date = p_date;
  select v_credit_today + coalesce((
    select sum(c.amount_due) from public.credit_customers c
    where c.date = p_date
      and not exists (select 1 from public.credit_entries e where e.credit_customer_id = c.id)
  ), 0) into v_credit_today;

  select coalesce(sum(amount), 0) into v_expenses_today
  from public.expenses where date = p_date;

  if v_already_saved then
    return jsonb_build_object(
      'date', p_date,
      'total_sale', coalesce(v_total_sale, 0),
      'collection', coalesce(v_collection, 0),
      'short_previous', coalesce(v_short_previous, 0),
      'credit_today', coalesce(v_credit_today, 0),
      'expenses_today', coalesce(v_expenses_today, 0),
      'night_cash', coalesce(v_existing.night_cash, 0),
      'phone_pay', coalesce(v_existing.phone_pay, 0),
      'short_today', coalesce(v_existing.short_today, 0),
      'closing_reference', v_existing.closing_reference,
      'remarks', v_existing.remarks,
      'already_saved', true
    );
  end if;

  return jsonb_build_object(
    'date', p_date,
    'total_sale', coalesce(v_total_sale, 0),
    'collection', coalesce(v_collection, 0),
    'short_previous', coalesce(v_short_previous, 0),
    'credit_today', coalesce(v_credit_today, 0),
    'expenses_today', coalesce(v_expenses_today, 0),
    'night_cash', null,
    'phone_pay', null,
    'short_today', null,
    'closing_reference', null,
    'remarks', null,
    'already_saved', false
  );
end;
$$;
comment on function public.get_day_closing_breakdown(date) is 'Returns day closing components. When already_saved with snapshot, returns stored values for accounting. credit_today = sum of credit_entries.amount for transaction_date.';

-- save_day_closing: same fix for credit_today
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

  -- Credit today: credit_entries.amount + legacy credit_customers.amount_due (no entries yet)
  select coalesce(sum(amount), 0) into v_credit_today
  from public.credit_entries where transaction_date = p_date;
  select v_credit_today + coalesce((
    select sum(c.amount_due) from public.credit_customers c
    where c.date = p_date
      and not exists (select 1 from public.credit_entries e where e.credit_customer_id = c.id)
  ), 0) into v_credit_today;

  select coalesce(sum(amount), 0) into v_expenses_today
  from public.expenses where date = p_date;

  v_short_today := (v_total_sale + v_collection + v_short_previous)
    - (p_night_cash + p_phone_pay + v_credit_today + v_expenses_today);

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
    'total_sale', coalesce(v_total_sale, 0),
    'collection', coalesce(v_collection, 0),
    'short_previous', coalesce(v_short_previous, 0),
    'credit_today', coalesce(v_credit_today, 0),
    'expenses_today', coalesce(v_expenses_today, 0),
    'night_cash', coalesce(p_night_cash, 0),
    'phone_pay', coalesce(p_phone_pay, 0),
    'short_today', coalesce(v_short_today, 0),
    'closing_reference', v_ref,
    'remarks', nullif(trim(p_remarks), '')
  );
end;
$$;
comment on function public.save_day_closing(date, numeric, numeric, text) is 'Save day closing with full statement snapshot and accounting reference. credit_today from credit_entries + legacy credit_customers.';
