-- Backfill dsr_stock from existing dsr data.
-- Inserts one dsr_stock row per (date, product) from dsr where no dsr_stock row exists.
-- Safe to run multiple times (idempotent): only (date, product) with no existing dsr_stock row are inserted.
--
-- Column mapping:
--   opening_stock: previous day's dip_stock (dsr.stock)
--   total_stock: opening_stock + receipts
--   net_sale: total_sales - testing (min 0)
--   closing_stock: (opening_stock + receipts) - net_sale
--   dip_stock: dsr.stock (actual dip reading)
--   variation: closing_stock - dip_stock

with src as (
  select
    d.date,
    d.product,
    d.remarks,
    d.created_by,
    coalesce(d.created_at, timezone('utc'::text, now())) as created_at,
    coalesce((
      select d2.stock
      from public.dsr d2
      where d2.product = d.product and d2.date < d.date
      order by d2.date desc
      limit 1
    ), 0)::numeric(14,2) as opening_stock,
    coalesce(d.receipts, 0) as receipts,
    coalesce(d.total_sales, 0) as total_sales,
    coalesce(d.testing, 0) as testing,
    coalesce(d.stock, 0) as dip_stock
  from public.dsr d
  where not exists (
    select 1 from public.dsr_stock s
    where s.date = d.date and s.product = d.product
  )
)
insert into public.dsr_stock (
  date,
  product,
  opening_stock,
  receipts,
  total_stock,
  sale_from_meter,
  testing,
  net_sale,
  closing_stock,
  dip_stock,
  variation,
  remark,
  created_by,
  created_at
)
select
  date,
  product,
  opening_stock,
  receipts,
  opening_stock + receipts,
  total_sales,
  testing,
  greatest(total_sales - testing, 0),
  (opening_stock + receipts) - greatest(total_sales - testing, 0),
  dip_stock,
  ((opening_stock + receipts) - greatest(total_sales - testing, 0)) - dip_stock,
  remarks,
  created_by,
  created_at
from src;
