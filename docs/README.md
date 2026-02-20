# Documentation — Bishnupriya Fuels (Petrol Pump)

This folder contains the technical documentation for the Petrol Pump application: architecture, data model, user and data flows, and development/deployment. Use this index to find the right document for your task.

---

## Documentation index

| Document | Purpose |
|----------|---------|
| [**ARCHITECTURE.md**](ARCHITECTURE.md) | **Tech stack**, **project structure** (folders, pages, scripts, supabase, docs), system diagram, frontend/backend runtime, security model, deployment overview. Single source of truth for how the app is built and organized. |
| [**DATA_TABLES.md**](DATA_TABLES.md) | **Database reference**: all tables with purpose, main columns, RLS behaviour, and relationships. Canonical schema remains `supabase/schema.sql`. |
| [**FLOWS.md**](FLOWS.md) | **User and data flows**: authentication, daily operations (DSR → credit → expenses → day closing), credit ledger and settlement, DSR/stock, HR (attendance, salary), admin-only flows. Page → data mapping. |
| [**DSR_TABLES.md**](DSR_TABLES.md) | **DSR vs dsr_stock**: roles of each table, overlap, when to use which, and optional future merge approach. |
| [**DEVELOPMENT.md**](DEVELOPMENT.md) | **Setup and operations**: local development (env, server, first login), deployment (prod/staging, GitHub secrets, deploy flow), supervisor/operator login. |

---

## Getting started by role

- **New to the project**  
  Start with [Architecture](ARCHITECTURE.md) (structure and stack) and [Flows](FLOWS.md) (how features connect). Then use [Development guide](DEVELOPMENT.md) to run and deploy.

- **Working on schema, RPCs, or reporting**  
  Use [Data Tables](DATA_TABLES.md) and [DSR Tables](DSR_TABLES.md) for table and DSR semantics.

- **Setting up locally or deploying**  
  Follow [Development guide](DEVELOPMENT.md) for env config, local server, GitHub Actions, and supervisor setup.

- **Understanding a feature end-to-end**  
  Use [Flows](FLOWS.md) for daily ops, credit, day closing, HR, and admin flows, plus the page → data table.

---

## Document conventions

- **Cross-references:** Each doc ends with a “Related documentation” section linking to sibling docs.
- **Single source of truth:** Project structure lives in [Architecture § Project structure](ARCHITECTURE.md#3-project-structure); setup and deploy details in [Development guide](DEVELOPMENT.md). The main [README](../README.md) links here and does not duplicate structure or step-by-step instructions.
- **Schema:** The canonical database schema is `supabase/schema.sql`; [Data Tables](DATA_TABLES.md) summarizes it for quick reference.
