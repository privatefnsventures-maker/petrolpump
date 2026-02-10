-- Credit Management Module – DSR workflow
-- Transaction Date = business date of fuel delivery (drives DSR).
-- Settlement Date = business date of payment. Entry timestamp = audit only.

-- ============================================================================
-- 1. CREDIT ENTRIES (one row per credit sale – supports backdated entry & DSR)
-- ============================================================================
create table if not exists public.credit_entries (
  id uuid primary key default uuid_generate_v4(),
  credit_customer_id uuid not null references public.credit_customers (id) on delete restrict,
  transaction_date date not null,
  fuel_type text not null check (fuel_type in ('MS', 'HSD')),
  quantity numeric(14,3) not null check (quantity > 0),
  amount numeric(14,2) not null check (amount > 0),
  amount_settled numeric(14,2) not null default 0 check (amount_settled >= 0),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now()),
  constraint credit_entries_settled_le_amount check (amount_settled <= amount)
);

create index if not exists credit_entries_customer_date_idx on public.credit_entries (credit_customer_id, transaction_date);
create index if not exists credit_entries_transaction_date_idx on public.credit_entries (transaction_date desc);

comment on table public.credit_entries is 'One row per credit sale. Transaction date = DSR date (business date of fuel delivery).';
comment on column public.credit_entries.transaction_date is 'Business date when fuel was dispensed on credit; drives DSR credit_today.';
comment on column public.credit_entries.amount_settled is 'Amount already paid against this entry (FIFO allocation).';

alter table public.credit_entries enable row level security;

drop policy if exists "credit_entries_select_authenticated" on public.credit_entries;
create policy "credit_entries_select_authenticated" on public.credit_entries
  for select to authenticated using (true);

drop policy if exists "credit_entries_insert_own" on public.credit_entries;
create policy "credit_entries_insert_own" on public.credit_entries
  for insert to authenticated with check (created_by = auth.uid());

drop policy if exists "credit_entries_update_by_role" on public.credit_entries;
create policy "credit_entries_update_by_role" on public.credit_entries
  for update to authenticated
  using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());

drop policy if exists "credit_entries_delete_admin" on public.credit_entries;
create policy "credit_entries_delete_admin" on public.credit_entries
  for delete to authenticated using (public.is_admin());

-- Sync credit_customers.amount_due from sum of (amount - amount_settled) per customer
create or replace function public.credit_entries_sync_amount_due()
returns trigger language plpgsql security definer as $$
declare
  v_customer_id uuid;
begin
  if tg_op = 'DELETE' then
    v_customer_id := old.credit_customer_id;
  else
    v_customer_id := new.credit_customer_id;
  end if;
  update public.credit_customers c
  set amount_due = coalesce((
    select sum(e.amount - e.amount_settled)
    from public.credit_entries e
    where e.credit_customer_id = c.id
  ), 0)
  where c.id = v_customer_id;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

drop trigger if exists credit_entries_sync_trigger on public.credit_entries;
create trigger credit_entries_sync_trigger
  after insert or update or delete on public.credit_entries
  for each row execute function public.credit_entries_sync_amount_due();

-- ============================================================================
-- 2. PAYMENT MODE on credit_payments (Cash / UPI / Bank)
-- ============================================================================
alter table public.credit_payments
  add column if not exists payment_mode text check (payment_mode in ('Cash', 'UPI', 'Bank'));

comment on column public.credit_payments.payment_mode is 'Mode of payment received (Settlement Date = date column).';

-- ============================================================================
-- 3. MIGRATE EXISTING DATA: one credit_entry per credit_customer (current balance)
-- ============================================================================
insert into public.credit_entries (credit_customer_id, transaction_date, fuel_type, quantity, amount, amount_settled, created_by)
select id, date, 'HSD', 1, amount_due, 0, created_by
from public.credit_customers
where amount_due > 0
  and not exists (select 1 from public.credit_entries e where e.credit_customer_id = credit_customers.id);

-- ============================================================================
-- 4. RPC: ADD CREDIT ENTRY (Transaction Date = DSR date; Entry Timestamp = audit)
-- ============================================================================
create or replace function public.add_credit_entry(
  p_customer_name text,
  p_transaction_date date,
  p_amount numeric,
  p_vehicle_no text default null,
  p_fuel_type text default 'HSD',
  p_quantity numeric default 1,
  p_notes text default null
)
returns jsonb
language plpgsql security definer
as $$
declare
  v_customer_id uuid;
  v_entry_id uuid;
  v_fuel_type text;
  v_quantity numeric;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;

  v_fuel_type := coalesce(nullif(trim(p_fuel_type), ''), 'HSD');
  if v_fuel_type not in ('MS', 'HSD') then
    raise exception 'fuel_type must be MS or HSD';
  end if;

  v_quantity := coalesce(nullif(p_quantity, 0), 1);
  if v_quantity <= 0 then
    raise exception 'quantity must be positive when provided';
  end if;

  select id into v_customer_id
  from public.credit_customers
  where trim(lower(customer_name)) = trim(lower(p_customer_name))
  order by created_at desc limit 1;

  if v_customer_id is null then
    insert into public.credit_customers (customer_name, vehicle_no, amount_due, date, notes, created_by)
    values (
      trim(p_customer_name),
      nullif(trim(p_vehicle_no), ''),
      0,
      p_transaction_date,
      nullif(trim(p_notes), ''),
      auth.uid()
    )
    returning id into v_customer_id;
  end if;

  insert into public.credit_entries (credit_customer_id, transaction_date, fuel_type, quantity, amount, created_by)
  values (v_customer_id, p_transaction_date, v_fuel_type, v_quantity, p_amount, auth.uid())
  returning id into v_entry_id;

  return jsonb_build_object(
    'credit_customer_id', v_customer_id,
    'credit_entry_id', v_entry_id,
    'transaction_date', p_transaction_date,
    'amount', p_amount
  );
end;
$$;
comment on function public.add_credit_entry(text, date, numeric, text, text, numeric, text) is 'Add a credit sale. Transaction date = DSR date. Fuel type and quantity optional (default HSD, 1).';

-- ============================================================================
-- 5. RPC: RECORD CREDIT PAYMENT (FIFO allocation; Settlement Date; payment_mode)
-- ============================================================================
create or replace function public.record_credit_payment(
  p_credit_customer_id uuid,
  p_date date,
  p_amount numeric,
  p_note text default null,
  p_payment_mode text default 'Cash'
)
returns jsonb
language plpgsql security definer
as $$
declare
  v_remaining numeric := p_amount;
  v_entry record;
  v_alloc numeric;
  v_new_due numeric;
  v_last_payment date;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  if p_payment_mode is not null and p_payment_mode not in ('Cash', 'UPI', 'Bank') then
    raise exception 'payment_mode must be Cash, UPI, or Bank';
  end if;

  if not exists (select 1 from public.credit_customers where id = p_credit_customer_id) then
    raise exception 'Credit customer not found';
  end if;

  for v_entry in
    select id, amount, amount_settled
    from public.credit_entries
    where credit_customer_id = p_credit_customer_id
      and amount_settled < amount
    order by transaction_date asc, id asc
    for update
  loop
    exit when v_remaining <= 0;
    v_alloc := least(v_remaining, v_entry.amount - v_entry.amount_settled);
    update public.credit_entries
    set amount_settled = amount_settled + v_alloc
    where id = v_entry.id;
    v_remaining := v_remaining - v_alloc;
  end loop;

  if v_remaining >= p_amount then
    raise exception 'No outstanding balance to apply payment to';
  end if;

  insert into public.credit_payments (credit_customer_id, date, amount, note, payment_mode, created_by)
  values (p_credit_customer_id, p_date, p_amount, nullif(trim(p_note), ''), coalesce(p_payment_mode, 'Cash'), auth.uid());

  select coalesce(sum(amount - amount_settled), 0), max(transaction_date) into v_new_due, v_last_payment
  from public.credit_entries
  where credit_customer_id = p_credit_customer_id;

  update public.credit_customers
  set amount_due = v_new_due, last_payment = p_date
  where id = p_credit_customer_id;

  return jsonb_build_object(
    'credit_customer_id', p_credit_customer_id,
    'date', p_date,
    'amount', p_amount,
    'new_due', v_new_due
  );
end;
$$;
comment on function public.record_credit_payment(uuid, date, numeric, text, text) is 'Record payment; allocate to entries FIFO by transaction date. Settlement date = p_date.';

-- ============================================================================
-- 6. DAY CLOSING: credit_today from credit_entries by transaction_date (DSR)
-- ============================================================================
create or replace function public.get_day_closing_breakdown(p_date date)
returns jsonb
language plpgsql security definer stable
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

  select coalesce(sum(amount), 0) into v_credit_today
  from public.credit_entries where transaction_date = p_date;

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

create or replace function public.save_day_closing(
  p_date date,
  p_night_cash numeric,
  p_phone_pay numeric,
  p_remarks text default null
)
returns jsonb
language plpgsql security definer
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

  select coalesce(sum(amount), 0) into v_credit_today
  from public.credit_entries where transaction_date = p_date;

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
    'total_sale', v_total_sale,
    'collection', v_collection,
    'short_previous', v_short_previous,
    'credit_today', v_credit_today,
    'expenses_today', v_expenses_today,
    'night_cash', p_night_cash,
    'phone_pay', p_phone_pay,
    'short_today', v_short_today,
    'closing_reference', v_ref,
    'remarks', nullif(trim(p_remarks), '')
  );
end;
$$;

-- ============================================================================
-- 7. RPC: Open credit AS OF a date (from entries and payments by business date)
-- Outstanding as of D = sum(credit_entries where transaction_date <= D) - sum(credit_payments where date <= D) per customer
-- ============================================================================
create or replace function public.get_open_credit_as_of(p_date date)
returns numeric
language plpgsql security definer stable
as $$
declare
  v_total numeric;
begin
  with bal as (
    select e.credit_customer_id, coalesce(sum(e.amount), 0) as credit_tot
    from public.credit_entries e
    where e.transaction_date <= p_date
    group by e.credit_customer_id
  ),
  pay as (
    select credit_customer_id, coalesce(sum(amount), 0) as payment_tot
    from public.credit_payments
    where date <= p_date
    group by credit_customer_id
  )
  select coalesce(sum(greatest(coalesce(b.credit_tot, 0) - coalesce(p.payment_tot, 0), 0)), 0)
  into v_total
  from bal b
  left join pay p on p.credit_customer_id = b.credit_customer_id;
  return v_total;
end;
$$;
comment on function public.get_open_credit_as_of(date) is 'Total outstanding credit as of date D (entries with transaction_date <= D minus payments with date <= D).';

-- Returns list of customers with outstanding balance as of p_date (one row per customer name, aggregated)
create or replace function public.get_outstanding_credit_list_as_of(p_date date)
returns table (
  customer_name text,
  vehicle_no text,
  amount_due_as_of numeric,
  last_payment_date date,
  sale_date date
)
language plpgsql security definer stable
as $$
begin
  return query
  with bal as (
    select e.credit_customer_id,
           coalesce(sum(e.amount), 0) as credit_tot,
           min(e.transaction_date) as min_txn_date
    from public.credit_entries e
    where e.transaction_date <= p_date
    group by e.credit_customer_id
  ),
  pay as (
    select credit_customer_id,
           coalesce(sum(amount), 0) as payment_tot,
           max(date) as last_pay_date
    from public.credit_payments
    where date <= p_date
    group by credit_customer_id
  ),
  per_customer as (
    select c.customer_name,
           c.vehicle_no,
           (coalesce(b.credit_tot, 0) - coalesce(p.payment_tot, 0))::numeric as amt,
           p.last_pay_date as last_pay,
           b.min_txn_date as min_txn
    from public.credit_customers c
    left join bal b on b.credit_customer_id = c.id
    left join pay p on p.credit_customer_id = c.id
    where coalesce(b.credit_tot, 0) - coalesce(p.payment_tot, 0) > 0
  )
  select (max(pc.customer_name))::text as customer_name,
         (max(pc.vehicle_no))::text as vehicle_no,
         sum(pc.amt)::numeric as amount_due_as_of,
         max(pc.last_pay) as last_payment_date,
         min(pc.min_txn) as sale_date
  from per_customer pc
  group by lower(trim(pc.customer_name))
  order by amount_due_as_of desc;
end;
$$;
comment on function public.get_outstanding_credit_list_as_of(date) is 'Customers with outstanding balance as of date D; one row per customer (grouped by name). amount_due_as_of and last_payment_date are as of D.';

-- Credit ledger aggregated by customer name (one row per customer; primary id for Settle/Delete)
create or replace function public.get_credit_ledger_aggregated()
returns table (
  id uuid,
  customer_name text,
  vehicle_no text,
  amount_due numeric,
  date date,
  last_payment date,
  notes text
)
language plpgsql security definer stable
as $$
begin
  return query
  with ranked as (
    select c.id, c.customer_name, c.vehicle_no, c.amount_due, c.date, c.last_payment, c.notes,
           row_number() over (partition by lower(trim(c.customer_name)) order by c.amount_due desc nulls last, c.created_at desc) as rn
    from public.credit_customers c
  ),
  agg as (
    select lower(trim(r.customer_name)) as name_key,
           sum(r.amount_due) as total_due,
           min(r.date) as min_date,
           max(r.last_payment) as max_last_pay,
           (array_agg(r.notes order by r.amount_due desc nulls last))[1] as first_notes
    from ranked r
    group by lower(trim(r.customer_name))
  )
  select r.id,
         r.customer_name::text as customer_name,
         r.vehicle_no::text as vehicle_no,
         a.total_due::numeric as amount_due,
         a.min_date as date,
         a.max_last_pay as last_payment,
         a.first_notes::text as notes
  from ranked r
  join agg a on lower(trim(r.customer_name)) = a.name_key
  where r.rn = 1
  order by a.total_due desc nulls last;
end;
$$;
comment on function public.get_credit_ledger_aggregated() is 'Credit ledger with one row per customer (grouped by name). id is primary customer row for Settle/Delete.';
