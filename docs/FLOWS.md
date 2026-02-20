# Flows

This document describes the main **user and data flows** in the Petrol Pump application: how features connect and in what order data is typically entered. Use it to understand end-to-end behaviour and the page → data mapping.

### Flow overview

| Flow | Section | Key pages / data |
|------|---------|-------------------|
| Auth & roles | §1 | login → users (role) → dashboard |
| Daily operations | §2 | dsr → credit → expenses → day-closing |
| Credit ledger | §3 | credit_customers, credit_entries, credit_payments |
| DSR & stock | §4 | dsr, dsr_stock (Meter + Stock forms) |
| HR | §5 | employees, attendance, salary |
| Admin | §6 | settings, analysis, audit_log |

---

## 1. Authentication and role-based access

```
User opens app (index.html / login.html)
    → Enters email + password
    → Supabase Auth signs in
    → auth.js: fetch role from public.users (by email)
    → Role cached (e.g. AppCache), stored in session
    → Redirect: admin/supervisor → dashboard.html
    → requireAuth() on every protected page: redirect to login if no session
    → Navigation: admin sees Analysis + Settings; supervisor does not
```

**Important:** All data access is enforced by RLS in the database. Hiding links is for UX only.

---

## 2. Daily operations flow (typical day)

A typical daily sequence:

```
1. Meter Reading (dsr.html)
   → Enter/update DSR for today: nozzle readings, total_sales, testing, dip, stock, receipts, rates
   → Optionally fill Stock form → dsr_stock (opening/closing, dip_stock, variation)

2. Credit (credit.html)
   → Add credit sale → credit_entries (transaction_date = today)
   → Record payment from customer → credit_payments (FIFO allocation via record_credit_payment)

3. Expenses (expenses.html)
   → Add expenses for the day → expenses

4. Day closing (day-closing.html)
   → Call get_day_closing_breakdown(date) → get total_sale, collection, short_previous, credit_today, expenses_today
   → Enter night_cash, phone_pay, remarks
   → save_day_closing(...) → computes short_today, stores full snapshot, generates closing_reference (e.g. DC-2026-00001)
   → short_today becomes next day’s short_previous
```

**Data dependencies:**

- **Total sale:** From `dsr` (petrol + diesel net sale × rate).
- **Collection:** Sum of `credit_payments.amount` for that date.
- **Credit today:** Sum of `credit_entries.amount` for `transaction_date = date` plus legacy `credit_customers.amount_due` where `date = date` and no entries.
- **Expenses today:** Sum of `expenses.amount` for that date.
- **Short previous:** `day_closing.short_today` of the previous date.

---

## 3. Credit flow (ledger and settlement)

```
Create / identify customer
   → credit_customers (customer_name, vehicle_no, etc.)
   → If new sale: add_credit_entry(...) or insert credit_entries
   → Trigger updates credit_customers.amount_due

Receive payment
   → record_credit_payment(customer_id, date, amount, note, payment_mode)
   → RPC allocates amount to credit_entries (FIFO by transaction_date)
   → Inserts credit_payments
   → Trigger + explicit update keeps credit_customers.amount_due and last_payment correct
```

- **Ledger view:** `get_credit_ledger_aggregated()` — one row per customer (by name), with total due.
- **Overdue / as-of:** `get_outstanding_credit_list_as_of(date)`, `get_customer_credit_summary_as_of(name, date)`, `get_customer_credit_breakdown_as_of(name, date)` or `get_customer_credit_detail_as_of(name, date)`.

---

## 4. DSR and stock flow

- **Meter form** → `dsr`: one row per (date, product). Contains nozzle readings, total_sales, testing, dip_reading, stock, receipts, petrol_rate, diesel_rate, buying_price_per_litre (admin).
- **Stock form** (same page) → `dsr_stock`: optional row per (date, product) with opening_stock, receipts, total_stock, sale_from_meter, testing, net_sale, closing_stock, dip_stock, variation.
- **Dashboard / sales-daily:** Prefer `dsr_stock` when present (dip_stock, variation); else fall back to `dsr`.
- **Receipts:** If `dsr.receipts = 0`, admin can run `sync_dsr_receipts_from_stock(start_date, end_date)` to copy from `dsr_stock` into `dsr`.

See [DSR_TABLES.md](DSR_TABLES.md) for when to use which table.

---

## 5. HR flow (attendance and salary)

```
Employees (settings or dedicated HR)
   → employees: name, role_display, monthly_salary, display_order, is_active

Attendance (attendance.html)
   → employee_attendance: one row per (employee_id, date); status (present/absent/half_day/leave), optional shift, check_in, check_out

Salary (salary.html)
   → salary_payments: installments (employee_id, date, amount, note)
   → One employee can have multiple payments across dates (e.g. partial salary)
```

---

## 6. Admin-only flows

- **Settings (settings.html):** Manage `users` (upsert_staff, delete_staff), expense_categories, employees. Admin-only by RLS and UI.
- **Analysis (analysis.html):** P&L and reporting; may use DSR buying price, receipts, sales. Admin-only.
- **Dashboard buying price:** Admin can set `buying_price_per_litre` on DSR rows (via `update_dsr_buying_price` RPC).
- **Audit log:** Only admins can read `audit_log`; writes happen only via triggers.

---

## 7. Page → data mapping (quick reference)

| Page | Primary tables / RPCs |
|------|------------------------|
| Login | auth.users (Supabase), public.users (role) |
| Dashboard | dsr, dsr_stock, day_closing, get_day_closing_breakdown, update_dsr_buying_price |
| Meter Reading (DSR) | dsr, dsr_stock |
| DSR (sales-daily) | dsr, dsr_stock |
| Credit | credit_customers, credit_entries, credit_payments, add_credit_entry, record_credit_payment, get_credit_ledger_aggregated |
| Overdue | get_outstanding_credit_list_as_of, get_customer_credit_detail_as_of (or summary + breakdown) |
| Expenses | expenses, expense_categories |
| Day closing | day_closing, get_day_closing_breakdown, save_day_closing |
| Attendance | employee_attendance, employees |
| Salary | salary_payments, employees |
| Analysis | dsr, dsr_stock, expenses, day_closing, credit_* |
| Settings | users, expense_categories, employees (upsert_staff, delete_staff) |

---

## Related documentation

| Document | Description |
|----------|-------------|
| [Architecture](ARCHITECTURE.md) | Project structure, tech stack, security, deployment |
| [Data Tables](DATA_TABLES.md) | Table reference and RLS |
| [DSR Tables](DSR_TABLES.md) | DSR vs dsr_stock |
| [Development guide](DEVELOPMENT.md) | Local setup, deployment, supervisor login |
