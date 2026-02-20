-- Recalculate dsr_stock: opening_stock = previous day's dip_stock, then derived columns.
-- Formulas: opening_stock = previous day's dip_stock (same product), or 0 if none
--           total_stock = opening_stock + receipts
--           closing_stock = (opening_stock + receipts) - net_sale
--           variation = closing_stock - dip_stock

with prev as (
  select
    s.id,
    coalesce((
      select s2.dip_stock
      from public.dsr_stock s2
      where s2.product = s.product and s2.date < s.date
      order by s2.date desc
      limit 1
    ), 0)::numeric(14,2) as prev_dip_stock
  from public.dsr_stock s
)
update public.dsr_stock s
set
  opening_stock = p.prev_dip_stock,
  total_stock = p.prev_dip_stock + s.receipts,
  closing_stock = (p.prev_dip_stock + s.receipts) - s.net_sale,
  variation = ((p.prev_dip_stock + s.receipts) - s.net_sale) - s.dip_stock
from prev p
where p.id = s.id;
