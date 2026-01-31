-- Fix staff role lookup: match email case-insensitively so is_admin() works for all admins.
create or replace function public.get_user_role()
returns text
language sql
security definer
stable
as $$
  select coalesce(
    (select role from public.staff where lower(trim(email)) = lower(trim(auth.jwt() ->> 'email')) limit 1),
    (auth.jwt() -> 'user_metadata' ->> 'role'),
    (auth.jwt() -> 'app_metadata' ->> 'role')
  );
$$;

-- RPC to update DSR buying price; runs with definer rights so RLS does not block admin updates.
create or replace function public.update_dsr_buying_price(p_dsr_id uuid, p_value numeric)
returns void
language plpgsql
security definer
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin access required to set buying price';
  end if;
  update public.dsr
  set buying_price_per_litre = p_value
  where id = p_dsr_id;
  if not found then
    raise exception 'DSR record not found';
  end if;
end;
$$;

comment on function public.update_dsr_buying_price(uuid, numeric) is 'Admin-only: set buying_price_per_litre for a DSR row (used from P&L dashboard).';

-- One-shot sync of receipts from dsr_stock into dsr (matching date, product) where dsr.receipts = 0.
-- Reduces N client updates to a single round-trip.
create or replace function public.sync_dsr_receipts_from_stock(p_start date, p_end date)
returns void
language sql
security definer
as $$
  update public.dsr d
  set receipts = s.receipts
  from public.dsr_stock s
  where d.date = s.date
    and d.product = s.product
    and s.receipts > 0
    and coalesce(d.receipts, 0) = 0
    and d.date >= p_start
    and d.date <= p_end
    and s.date >= p_start
    and s.date <= p_end;
$$;
comment on function public.sync_dsr_receipts_from_stock(date, date) is 'Sync receipts from dsr_stock into dsr for matching (date, product) where dsr.receipts is 0.';
