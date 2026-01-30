-- Add receipts and buying_price_per_litre to dsr for profit calculation.
-- When receipts > 0, admin sets buying_price_per_litre; it applies until the next receipt.
alter table public.dsr
  add column if not exists receipts numeric(14,2) not null default 0,
  add column if not exists buying_price_per_litre numeric(10,2);

comment on column public.dsr.receipts is 'Fuel received (L) on this date. When > 0, admin can set buying_price_per_litre for profit until next receipt.';
comment on column public.dsr.buying_price_per_litre is 'Admin-only: cost per litre for fuel received; used for profit from this date until next DSR with receipts > 0.';
