# Bishnupriya Fuels ( Petrol Pump )
## A  F & S ventures Bussiness

Web application for **daily operations**, **finance**, and **HR** at a fuel station: meter readings (DSR), stock reconciliation, credit ledger, expenses, day closing & short, employee attendance, salary, and P&L analysis. Built with static HTML/JS and [Supabase](https://supabase.com) (PostgreSQL, Auth, Row Level Security).

---

## Documentation

| Document | Description |
|----------|-------------|
| [**Architecture**](docs/ARCHITECTURE.md) | Tech stack, **project structure**, system diagram, security, deployment overview |
| [**Data tables**](docs/DATA_TABLES.md) | Database tables: purpose, columns, relationships, RLS |
| [**Flows**](docs/FLOWS.md) | User and data flows: auth, daily ops, credit, day closing, HR, admin |
| [**DSR tables**](docs/DSR_TABLES.md) | DSR vs dsr_stock: roles and when to use which |
| [**Development guide**](docs/DEVELOPMENT.md) | Local setup, deployment (prod/staging), supervisor login |

Full index and how to use the docs: **[docs/README.md](docs/README.md)**.

---

## Getting started

- **Run locally:** See [Development guide → Local development](docs/DEVELOPMENT.md#1-local-development) (env setup and local server).
- **Deploy:** See [Development guide → Deployment](docs/DEVELOPMENT.md#2-deployment-prod-and-staging) (GitHub Actions, secrets, branches).
- **Add an operator (supervisor):** See [Development guide → Supervisor login](docs/DEVELOPMENT.md#3-supervisor--operator-login).

For **project layout** (folders, pages, scripts, supabase, docs), see [Architecture → Project structure](docs/ARCHITECTURE.md#3-project-structure).

---

## Roadmap

Planned improvements for scalability, offline use, and multi-site support:

| Area | Direction |
|------|------------|
| **Frontend** | Migrate to a framework (React, Vue, or Svelte) for state and components. |
| **Offline** | PWA support for forecourt devices with unstable connectivity. |
| **Multi-site** | Multi-tenancy for multiple pump locations and central reporting. |
| **Live data** | Supabase Realtime for live dashboard updates. |
| **Mobile** | Native or cross-platform app (e.g. React Native, Flutter) for operators. |
