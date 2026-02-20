# DSR vs dsr_stock: Analysis and Usage

Part of the [Petrol Pump documentation](README.md). For all tables and flows, see [DATA_TABLES.md](DATA_TABLES.md) and [FLOWS.md](FLOWS.md).

## Summary

| Table       | Purpose                    | Written by           | When to use |
|------------|----------------------------|----------------------|-------------|
| **dsr**    | Primary daily meter/sales   | Meter Reading form   | Always: sales, rates, day-closing, P&L |
| **dsr_stock** | Stock reconciliation    | Stock form (same page)| Optional: dip stock, variation, full stock trail |

**Recommendation: keep both.** They serve different workflows; the app already optimises by preferring `dsr_stock` when present and falling back to `dsr`.

---

## dsr (primary)

- **Role:** One row per (date, product) from the **Meter Reading** form: nozzle readings, total sales, testing, dip reading, stock (L), receipts, petrol/diesel rate, buying price.
- **Used by:** Day-closing (sales from `dsr`), P&L (buying price, receipts), dashboard (net sale, stock fallback), analysis, sales-daily (sales + stock).
- **Unique to dsr:** Nozzle columns, `total_sales`, `petrol_rate`, `diesel_rate`, `buying_price_per_litre`. Required for closing and profit calculation.

## dsr_stock (stock register)

- **Role:** Optional **stock reconciliation** per (date, product): opening_stock, receipts, total_stock, sale_from_meter, testing, net_sale, closing_stock, **dip_stock**, **variation**.
- **Written by:** The **Stock** form on the same Meter Reading page (separate from the main meter form).
- **Used by:** Dashboard (dip_stock and variation; preferred when present), sales-daily (opening/closing/variation), P&L (receipts source), and `sync_dsr_receipts_from_stock` (copies receipts into `dsr` when `dsr.receipts = 0`).

## Overlap and sync

- **receipts:** Stored in both. `sync_dsr_receipts_from_stock` copies from `dsr_stock` into `dsr` for matching (date, product) when `dsr.receipts = 0`.
- **Stock display:** Dashboard shows **dip stock** from `dsr_stock` when a row exists; otherwise it uses `dsr.stock`. Variation comes from `dsr_stock`; for a range with no `dsr_stock` data it can be derived from `dsr.stock` (stock change over the period).

## Why not remove one?

- **Removing dsr:** Day-closing, P&L, and most reads depend on `dsr`. Dropping it would require moving all meter/sales/rates/buying-price data into `dsr_stock` and updating every consumer (large migration).
- **Removing dsr_stock:** You would lose the dedicated stock register (opening, closing, dip_stock, variation) and the two-form workflow. You could merge those columns into `dsr` (add columns, backfill from `dsr_stock`, make the Stock form update `dsr`, then drop `dsr_stock`), but that is a deliberate migration and schema change, not a “delete redundant table” change.

## Optional future merge (single table)

If you later want a single table:

1. Add to **dsr**: `opening_stock`, `total_stock`, `sale_from_meter`, `net_sale`, `closing_stock`, `dip_stock`, `variation` (and ensure unique on `(date, product)`).
2. Migrate: backfill these columns in `dsr` from `dsr_stock` (update/insert as needed).
3. Change the Stock form to update (or upsert) **dsr** instead of inserting into `dsr_stock`.
4. Point all `dsr_stock` reads (dashboard, sales-daily, P&L) to `dsr`.
5. Remove `sync_dsr_receipts_from_stock` (or make it a no-op).
6. Drop `dsr_stock` after verification.

Until then, keeping both tables and the current fallback logic is the intended design.

---

## Related documentation

| Document | Description |
|----------|-------------|
| [Documentation index](README.md) | Doc portal and getting started |
| [Architecture](ARCHITECTURE.md) | Project structure, tech stack, security |
| [Data Tables](DATA_TABLES.md) | All tables and RLS |
| [Flows](FLOWS.md) | User and data flows; DSR/stock in daily ops |
| [Development guide](DEVELOPMENT.md) | Local setup, deployment, supervisor login |
