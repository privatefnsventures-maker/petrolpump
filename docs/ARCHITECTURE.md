# Architecture

This document describes the architecture of **Bishnupriya Fuels** (Petrol Pump): technology stack, project structure, runtime components, security, and deployment. It is the single source of truth for how the application is organized and how it runs.

**See also:** [Data Tables](DATA_TABLES.md) · [Flows](FLOWS.md) · [Development guide](DEVELOPMENT.md)

---

## 1. Overview

| Layer | Technology | Purpose |
|-------|------------|---------|
| **Frontend** | Static HTML, CSS, vanilla JavaScript | Multi-page app; auth-guarded pages; role-based navigation |
| **Backend / Data** | Supabase (PostgreSQL, Auth, RLS) | Authentication, database, Row Level Security, RPCs |
| **Deployment** | GitHub Pages + GitHub Actions | Prod (root) and Staging (`/staging/`) with env-specific config |

Data access is **enforced at the database** via Row Level Security (RLS). Client-side role checks are for UX only (e.g. hiding admin links); they do not replace server-side enforcement.

---

## 2. Tech stack

| Area | Choice | Notes |
|------|--------|-------|
| **UI** | HTML5, CSS3, JavaScript (ES6+) | No framework; each page has a dedicated script |
| **Auth** | Supabase Auth | Email/password; JWT; role from `public.users` |
| **Database** | PostgreSQL (Supabase) | Schema in `supabase/schema.sql`; migrations in `supabase/migrations/` |
| **API** | Supabase client (REST + RPC) | Tables + Row Level Security + server-side RPCs |
| **Hosting** | GitHub Pages | Static site; custom domain via `CNAME` |
| **CI/CD** | GitHub Actions | Builds `js/env.js` from secrets per environment |

---

## 3. Project structure

All application and documentation files live under the repository root. Below is the canonical layout.

### 3.1 Root and pages

```
petrolPump/
├── index.html              # Login entry (redirects to login or dashboard)
├── login.html              # Login form
├── dashboard.html          # Authenticated landing (snapshot, quick links)
├── dsr.html                # Meter Reading + Stock (DSR and dsr_stock)
├── sales-daily.html        # DSR listing / daily report view
├── credit.html             # Credit ledger (entries, payments, settle)
├── credit-overdue.html     # Overdue credit list and customer detail
├── expenses.html           # Daily expenses by category
├── day-closing.html        # Day closing & short (night cash, phone pay, snapshot)
├── attendance.html         # Employee attendance (status, check-in/out)
├── salary.html             # Salary payments (installments per employee)
├── analysis.html           # P&L / Analysis (admin only)
├── settings.html           # Users, expense categories, employees (admin only)
├── about.html              # About / info page
├── CNAME                   # GitHub Pages custom domain
├── sw.js                   # Service worker (if PWA enabled)
└── README.md               # Project overview and doc links
```

### 3.2 Styles

```
css/
├── base.css    # Layout, typography, shared components
├── app.css     # App shell, dashboard, forms, tables
├── login.css   # Login page
├── style.css   # Legacy / additional styles
└── landing.css # Landing (if used)
```

### 3.3 Scripts

```
js/
├── env.js         # Runtime config (SUPABASE_URL, SUPABASE_ANON_KEY, APP_ENV) — gitignored; generated in CI
├── env.example.js # Template for local env.js
├── supabase.js    # Supabase client bootstrap from window.__APP_CONFIG__
├── auth.js        # Session guard, role resolution, redirect, nav highlighting
├── utils.js       # Shared utilities
├── errorHandler.js# Centralized error reporting
├── cache.js       # Client cache (e.g. role) — AppCache
├── landing.js     # Landing page logic (if used)
├── dashboard.js   # Dashboard data and UI
├── dsr.js         # Meter Reading + Stock forms and listing
├── sales-daily.js # DSR report view
├── credit.js      # Credit ledger and payments
├── credit-overdue.js # Overdue list and customer detail
├── expenses.js    # Expenses form and listing
├── day-closing.js # Day closing breakdown and save
├── attendance.js  # Attendance grid and save
├── salary.js      # Salary payments per employee
├── analysis.js    # P&L / analysis (admin)
└── settings.js    # Users, categories, employees (admin)
```

**Convention:** Each feature page has a corresponding script (e.g. `dsr.html` → `js/dsr.js`). Shared behaviour lives in `auth.js`, `utils.js`, `errorHandler.js`, `cache.js`.

### 3.4 Backend (Supabase)

```
supabase/
├── schema.sql     # Full schema (tables, RLS, functions, triggers) — source of truth
└── migrations/    # Incremental migrations (timestamped)
    ├── 20250129000000_add_dsr_receipts_buying_price.sql
    ├── 20250130100000_day_closing_and_credit_payments.sql
    ├── ...
    └── 20250220100000_employee_attendance_shift.sql
```

### 3.5 Documentation

```
docs/
├── README.md       # Documentation index and how to use the docs
├── ARCHITECTURE.md # This file — structure, stack, security, deployment
├── DATA_TABLES.md  # Database tables: purpose, columns, RLS
├── FLOWS.md        # User and data flows
├── DSR_TABLES.md   # DSR vs dsr_stock in detail
└── DEVELOPMENT.md  # Local setup, deployment, supervisor login
```

---

## 4. System diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Browser (User)                                  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Frontend (Static)                                                        │
│  • HTML pages (dashboard, dsr, credit, expenses, day-closing, …)          │
│  • js/env.js → window.__APP_CONFIG__ (Supabase URL, anon key)             │
│  • js/supabase.js, js/auth.js, js/*.js per feature                       │
│  • css/base.css, css/app.css, css/login.css                               │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │  Supabase JS client (anon key)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Supabase                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐  │
│  │  Auth           │  │  PostgreSQL     │  │  Edge Functions (opt)   │  │
│  │  Email/Password  │  │  Tables + RLS   │  │  e.g. get-dashboard-data │  │
│  │  JWT → role     │  │  RPCs, Triggers │  │                          │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Deployment                                                               │
│  GitHub Actions → js/env.js from secrets → GitHub Pages (prod / staging)   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Frontend (runtime)

- **Entry:** `index.html` or `login.html`; after auth, redirect to `dashboard.html`.
- **Config:** `js/env.js` exposes `window.__APP_CONFIG__` (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `APP_ENV`). In CI this file is generated from GitHub environment secrets; locally it is created from `env.example.js`.
- **Auth:** `js/auth.js` handles session guard, role resolution from `public.users` (and JWT metadata), redirect to login when unauthenticated, and role-based nav (e.g. Analysis/Settings for admin only). Role is cached (e.g. via `AppCache`) for performance.
- **Supabase client:** `js/supabase.js` initializes the Supabase client from `window.__APP_CONFIG__`.
- **Pages:** Each feature has its own HTML and JS; navigation is role-aware and documented in [Flows](FLOWS.md).

---

## 6. Backend (Supabase)

### 6.1 Authentication

- **Provider:** Supabase Auth (email/password).
- **App roles:** Stored in `public.users` (email, role, display_name). Role is resolved by matching `auth.jwt() ->> 'email'` to `users.email` (case-insensitive). Roles: `admin`, `supervisor`.

### 6.2 Database

- **Engine:** PostgreSQL (Supabase).
- **Schema:** Defined in `supabase/schema.sql`; changes are applied via migrations under `supabase/migrations/`.
- **Security:** RLS is enabled on all application tables. Policies use helper functions `get_user_role()`, `is_admin()`, `is_supervisor_or_admin()` (security definer).
- **Audit:** Audit triggers on sensitive tables write to `audit_log` (table_name, record_id, action, old_data, new_data, performed_by, performed_at). Only admins can read `audit_log`.

### 6.3 Key server-side constructs

- **RPCs (examples):** `get_day_closing_breakdown(date)`, `save_day_closing(...)`, `add_credit_entry(...)`, `record_credit_payment(...)`, `get_open_credit_as_of(date)`, `get_credit_ledger_aggregated()`, `update_dsr_buying_price(...)`, `sync_dsr_receipts_from_stock(...)`, `upsert_staff(...)`, `delete_staff(...)`, `check_page_access(page)`.
- **Triggers:** `credit_entries_sync_trigger` keeps `credit_customers.amount_due` in sync with `credit_entries`; `day_closing_updated_at_trigger` maintains `updated_at`; audit triggers on users, dsr, dsr_stock, expenses, credit_customers, credit_entries, credit_payments, employees, salary_payments, employee_attendance, day_closing.

Full table and RPC reference: [Data Tables](DATA_TABLES.md).

---

## 7. Security model

- **Enforcement:** RLS is the primary authorization layer. Client-side checks only affect the UI.
- **Roles:**
  - **admin:** Full access (including delete and staff/category management).
  - **supervisor:** Read all; insert/update own records; no delete.
- **Policies:** Typically SELECT for all authenticated; INSERT with `created_by = auth.uid()`; UPDATE for own row or admin; DELETE only for admin. Exceptions (e.g. `expense_categories`, `users`) are documented in [Data Tables](DATA_TABLES.md).

---

## 8. Deployment

- **Hosting:** GitHub Pages (custom domain via `CNAME`).
- **Environments:**
  - **Prod:** `main` branch → root URL (e.g. `https://bishnupriyafuels.fnsventures.in/`).
  - **Staging:** `staging` branch → `/staging/` path.
- **CI:** GitHub Actions generates `js/env.js` from environment secrets (`SUPABASE_URL`, `SUPABASE_ANON_KEY`) so each environment uses its own Supabase project.
- **Details:** Step-by-step local setup, deploy flow, and supervisor login are in [Development guide](DEVELOPMENT.md).

---

## Related documentation

| Document | Description |
|----------|-------------|
| [Data Tables](DATA_TABLES.md) | Tables, columns, relationships, RLS |
| [Flows](FLOWS.md) | User and data flows (auth, daily ops, credit, HR, admin) |
| [DSR Tables](DSR_TABLES.md) | `dsr` vs `dsr_stock`: roles and when to use which |
| [Development guide](DEVELOPMENT.md) | Local development, deployment, supervisor login |
