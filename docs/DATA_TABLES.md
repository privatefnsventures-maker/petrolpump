# Data Tables

Reference for all **database tables** used by the Petrol Pump application: purpose, key columns, relationships, and Row Level Security (RLS). Use this for schema work, RPC design, or understanding the data model. The canonical schema is `supabase/schema.sql`; this doc is a summary.

---

## Table Index

| Table | Purpose |
|-------|---------|
| [audit_log](#audit_log) | Audit trail for sensitive operations (admin-only read) |
| [users](#users) | App users (login / operator roles) |
| [dsr](#dsr) | Primary DSR: meter readings and daily sales per (date, product) |
| [dsr_stock](#dsr_stock) | Optional stock reconciliation per (date, product) |
| [expenses](#expenses) | Daily operating expenses |
| [expense_categories](#expense_categories) | User-managed expense categories |
| [employees](#employees) | Pump employees (for salary and attendance) |
| [salary_payments](#salary_payments) | Salary installments per employee |
| [employee_attendance](#employee_attendance) | Daily attendance (present/absent/half_day/leave) |
| [credit_customers](#credit_customers) | Credit ledger: customer master and current amount_due |
| [credit_entries](#credit_entries) | One row per credit sale (transaction date = DSR date) |
| [credit_payments](#credit_payments) | Payments received from credit customers |
| [day_closing](#day_closing) | Daily closing statement (night cash, phone pay, short, snapshot) |

For a detailed comparison of **dsr** vs **dsr_stock**, see [DSR_TABLES.md](DSR_TABLES.md).

---

## audit_log

**Purpose:** Audit trail for sensitive operations. Only admins can read.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| table_name | text | Table that was modified |
| record_id | uuid | Id of the row |
| action | text | INSERT, UPDATE, DELETE |
| old_data | jsonb | Snapshot before (UPDATE/DELETE) |
| new_data | jsonb | Snapshot after (INSERT/UPDATE) |
| performed_by | uuid | auth.users.id |
| performed_by_email | text | Email at time of action |
| performed_at | timestamptz | When the action occurred |

**RLS:** SELECT only for admin; no direct INSERT/UPDATE/DELETE (only via triggers).

**Populated by:** Audit triggers on: users, dsr, dsr_stock, expenses, credit_customers, employees, salary_payments, employee_attendance, credit_payments, day_closing.

---

## users

**Purpose:** App users who can log in. Roles: `admin`, `supervisor`. Display name shown in UI.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| email | text | Unique, lowercase for matching |
| role | text | `admin` \| `supervisor` |
| display_name | text | Optional; shown in app |
| created_at | timestamptz | Created at |

**RLS:** SELECT all authenticated; INSERT/UPDATE/DELETE only for admin (with bootstrap rule for first admin). Staff changes should use RPCs `upsert_staff`, `delete_staff`.

---

## dsr

**Purpose:** Primary Daily Sales Register: one row per (date, product). Filled by **Meter Reading** form (nozzle readings, total_sales, testing, dip_reading, stock, receipts, rates). Used by day-closing (sales), P&L (buying price, receipts), dashboard (net sale, stock fallback), analysis, sales-daily.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| date | date | Business date |
| product | text | `petrol` \| `diesel` |
| opening_pump*_nozzle* | numeric | Opening meter readings |
| closing_pump*_nozzle* | numeric | Closing meter readings |
| sales_pump1, sales_pump2 | numeric | Sales per pump |
| total_sales | numeric | Manual total for shift (L) |
| testing | numeric | Testing (L) |
| dip_reading | numeric | Dip reading |
| stock | numeric | Stock (L); dashboard uses when no dsr_stock |
| receipts | numeric | Fuel received (L); can be synced from dsr_stock |
| petrol_rate, diesel_rate | numeric | Selling rate (₹/L) |
| buying_price_per_litre | numeric | Admin-only; cost for profit calc |
| remarks | text | Optional |
| created_by | uuid | auth.users.id |
| created_at | timestamptz | Created at |

**Index:** `(date desc, product)`.

**RLS:** SELECT all authenticated; INSERT with `created_by = auth.uid()`; UPDATE own or admin; DELETE admin only.

---

## dsr_stock

**Purpose:** Optional stock reconciliation per (date, product). Filled by **Stock** form on Meter Reading page. Used by dashboard (dip_stock, variation), sales-daily, P&L (receipts), and `sync_dsr_receipts_from_stock`.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| date | date | Business date |
| product | text | `petrol` \| `diesel` |
| opening_stock | numeric | Opening stock (L) |
| receipts | numeric | Receipts (L) |
| total_stock | numeric | Total stock |
| sale_from_meter | numeric | Sale from meter |
| testing | numeric | Testing (L) |
| net_sale | numeric | Net sale |
| closing_stock | numeric | Closing stock |
| dip_stock | numeric | Dip stock (L) |
| variation | numeric | Variation |
| remark | text | Optional |
| created_by | uuid | auth.users.id |
| created_at | timestamptz | Created at |

**Index:** `(date desc, product)`.

**RLS:** Same pattern as dsr: SELECT all; INSERT own; UPDATE own or admin; DELETE admin only.

**Relationship:** When `dsr_stock` exists for a (date, product), dashboard prefers it for dip_stock/variation; otherwise uses `dsr`. See [DSR_TABLES.md](DSR_TABLES.md).

---

## expenses

**Purpose:** Daily operating expenses for P&L and day-closing.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| date | date | Expense date |
| category | text | References expense_categories (logical) |
| description | text | Optional |
| amount | numeric | Amount (₹) |
| created_by | uuid | auth.users.id |
| created_at | timestamptz | Created at |

**Indexes:** `(date desc)`, `(created_at desc)`.

**RLS:** SELECT all; INSERT own; UPDATE own or admin; DELETE admin only.

---

## expense_categories

**Purpose:** User-managed expense categories (used in Expenses form and Settings).

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| name | text | Unique internal name |
| label | text | Display label |
| sort_order | int | Display order |
| created_at | timestamptz | Created at |

**RLS:** SELECT all authenticated; INSERT/UPDATE/DELETE admin only.

---

## employees

**Purpose:** Pump employees who receive salary and have attendance (distinct from app users).

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| name | text | Employee name |
| role_display | text | Role label (e.g. Supervisor) |
| monthly_salary | numeric | Monthly salary (₹) |
| display_order | smallint | Order in lists |
| is_active | boolean | Active flag |
| created_by | uuid | auth.users.id |
| created_at | timestamptz | Created at |

**RLS:** SELECT all; INSERT own or admin; UPDATE own or admin; DELETE admin only.

---

## salary_payments

**Purpose:** Salary installments: one row per payment (e.g. partial salary on different dates).

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| employee_id | uuid | FK → employees.id |
| date | date | Payment date |
| amount | numeric | Amount (₹) |
| note | text | Optional |
| created_by | uuid | auth.users.id |
| created_at | timestamptz | Created at |

**Indexes:** `(employee_id, date desc)`, `(date desc)`.

**RLS:** SELECT all; INSERT own; UPDATE own or admin; DELETE admin only.

---

## employee_attendance

**Purpose:** Daily attendance per employee: status and optional check-in/out.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| employee_id | uuid | FK → employees.id |
| date | date | Attendance date |
| status | text | `present` \| `absent` \| `half_day` \| `leave` |
| shift | text | Optional shift label |
| check_in | time | Optional |
| check_out | time | Optional |
| note | text | Optional |
| created_by | uuid | auth.users.id |
| created_at, updated_at | timestamptz | Timestamps |

**Unique:** `(employee_id, date)`.

**RLS:** SELECT all; INSERT own; UPDATE own or admin; DELETE admin only.

---

## credit_customers

**Purpose:** Credit ledger: customer master. `amount_due` is kept in sync with `credit_entries` by trigger. `date` is used for legacy/day-closing “credit today” when there are no entries yet.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| customer_name | text | Customer name |
| vehicle_no | text | Optional |
| amount_due | numeric | Current outstanding (synced by trigger) |
| date | date | Used for day-closing credit_today legacy |
| last_payment | date | Last payment date |
| notes | text | Optional |
| created_by | uuid | auth.users.id |
| created_at | timestamptz | Created at |

**RLS:** SELECT all; INSERT own; UPDATE own or admin; DELETE admin only.

**Trigger:** `credit_entries_sync_trigger` on `credit_entries` updates `credit_customers.amount_due`.

---

## credit_entries

**Purpose:** One row per credit sale. Transaction date = DSR (business) date; drives “credit today” in day-closing.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| credit_customer_id | uuid | FK → credit_customers.id |
| transaction_date | date | Business date of fuel delivery |
| fuel_type | text | `MS` \| `HSD` |
| quantity | numeric | Quantity (L) |
| amount | numeric | Amount (₹) |
| amount_settled | numeric | Amount already paid (FIFO allocation) |
| created_by | uuid | auth.users.id |
| created_at | timestamptz | Created at |

**Constraint:** `amount_settled <= amount`.

**RLS:** SELECT all; INSERT own; UPDATE own or admin; DELETE admin only.

**Trigger:** Updates `credit_customers.amount_due` on insert/update/delete.

---

## credit_payments

**Purpose:** Payments received from credit customers. Sum by date = collection for day-closing.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| credit_customer_id | uuid | FK → credit_customers.id |
| date | date | Settlement date |
| amount | numeric | Amount (₹) |
| note | text | Optional |
| payment_mode | text | `Cash` \| `UPI` \| `Bank` |
| created_by | uuid | auth.users.id |
| created_at | timestamptz | Created at |

**RLS:** SELECT all; INSERT own; UPDATE own or admin; DELETE admin only.

**Note:** Payment allocation to entries (FIFO) is done in RPC `record_credit_payment`; then trigger on `credit_entries` updates `credit_customers.amount_due`.

---

## day_closing

**Purpose:** Daily closing statement: one row per date. Stores night_cash, phone_pay, computed short_today, and full snapshot (total_sale, collection, short_previous, credit_today, expenses_today) for accounting. `short_previous` comes from previous day’s `short_today`.

**Formula:**  
`short_today = (total_sale + collection + short_previous) - (night_cash + phone_pay + credit_today + expenses_today)`

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| date | date | Unique closing date |
| night_cash | numeric | Hard cash at day end |
| phone_pay | numeric | UPI/PhonePe |
| short_today | numeric | Computed short (stored for next day’s short_previous) |
| total_sale | numeric | Snapshot at closing |
| collection | numeric | Snapshot at closing |
| short_previous | numeric | Carried from previous day |
| credit_today | numeric | New credit that day (snapshot) |
| expenses_today | numeric | Expenses that day (snapshot) |
| closing_reference | text | Unique ref (e.g. DC-2026-00001) |
| remarks | text | Optional |
| created_by | uuid | auth.users.id |
| created_at, updated_at | timestamptz | Timestamps |

**RLS:** SELECT all; INSERT own; UPDATE own or admin; DELETE admin only.

**RPCs:** `get_day_closing_breakdown(date)` returns components (from snapshot if already saved); `save_day_closing(date, night_cash, phone_pay, remarks)` computes short and inserts one row.

---

## Entity Relationship (Simplified)

```
users (app login)
  └── created_by on: dsr, dsr_stock, expenses, credit_customers, credit_entries,
                    credit_payments, employees, salary_payments, employee_attendance, day_closing

employees
  ├── salary_payments.employee_id
  └── employee_attendance.employee_id

credit_customers
  ├── credit_entries.credit_customer_id  → trigger syncs amount_due
  └── credit_payments.credit_customer_id

day_closing
  └── short_previous = prev day’s short_today
```

---

## Related documentation

| Document | Description |
|----------|-------------|
| [Architecture](ARCHITECTURE.md) | Project structure, tech stack, security, deployment |
| [Flows](FLOWS.md) | User and data flows; page → data mapping |
| [DSR Tables](DSR_TABLES.md) | DSR vs dsr_stock in detail |
| [Development guide](DEVELOPMENT.md) | Local setup, deployment, supervisor login |
