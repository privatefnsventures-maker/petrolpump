# Development guide

This document covers **local development**, **deployment** (prod and staging), and **supervisor/operator login** for Bishnupriya Fuels (Petrol Pump). For project structure and tech stack, see [Architecture](ARCHITECTURE.md).

---

## 1. Local development

### 1.1 Prerequisites

- A Supabase project (create one at [supabase.com](https://supabase.com)).
- A local HTTP server (e.g. Python 3 or Node) to serve static files and avoid CORS issues.

### 1.2 Configure Supabase credentials

The app reads configuration from `js/env.js`, which is **gitignored** to avoid committing secrets.

1. Copy the example file:

   ```bash
   cp js/env.example.js js/env.js
   ```

2. Edit `js/env.js` and set your Supabase project values:

   ```javascript
   window.__APP_CONFIG__ = {
     SUPABASE_URL: "https://your-project-id.supabase.co",
     SUPABASE_ANON_KEY: "your-anon-key-here",
     APP_ENV: "development",
   };
   ```

   You can find **Project URL** and **anon key** in the Supabase dashboard under **Project Settings → API**.

3. Apply the schema (if not already done) by running the SQL in `supabase/schema.sql` in the Supabase SQL Editor, or apply migrations in order from `supabase/migrations/`.

### 1.3 Run a local server

Serve the project from the repository root so that paths like `/js/env.js` and `/css/app.css` resolve correctly.

**Using Python 3:**

```bash
python3 -m http.server 3000
```

**Using Node (npx):**

```bash
npx serve -p 3000
```

Then open **http://localhost:3000/** in your browser. Use `index.html` or `login.html` as the entry point.

### 1.4 First login

- Ensure at least one user exists in **Supabase Auth** (Authentication → Users) with email/password.
- Add the same user to `public.users` with role `admin` (e.g. via Supabase SQL Editor or the app Settings page after first login if you bootstrap an admin another way). Example:

  ```sql
  insert into public.users (email, role)
  values ('your@email.com', 'admin')
  on conflict (email) do update set role = 'admin';
  ```

---

## 2. Deployment (prod and staging)

The repository uses **GitHub Actions** to deploy two environments to **GitHub Pages**.

| Environment | Branch   | Typical URL |
|-------------|----------|-------------|
| **Production** | `main`   | Root (e.g. `https://bishnupriyafuels.fnsventures.in/`) |
| **Staging**    | `staging` | `/staging/` (e.g. `https://bishnupriyafuels.fnsventures.in/staging/`) |

### 2.1 How it works

- On push to `main` or `staging`, the workflow runs and generates `js/env.js` using **GitHub environment secrets**.
- Each environment uses its own Supabase project, so prod and staging data are separate.
- The site is served as a static bundle from GitHub Pages; `CNAME` is used for a custom domain.

### 2.2 Required GitHub configuration

1. Create two **environments** in the repo: **prod** and **staging** (Settings → Environments).
2. In each environment, add **Environment secrets**:
   - `SUPABASE_URL` — Supabase project URL for that environment.
   - `SUPABASE_ANON_KEY` — Supabase anon (public) key for that environment.

Use one Supabase project for prod and another for staging.

### 2.3 Deploy flow

1. **Test in staging**  
   Push commits to the `staging` branch. The workflow deploys to the `/staging/` path.

2. **Promote to production**  
   Merge `staging` into `main`. The workflow deploys to the root URL.

---

## 3. Supervisor / operator login

Operators can log in with a **supervisor** role: they see the same operational pages (dashboard, DSR, credit, expenses, day closing, attendance, salary) but **not** Analysis or Settings. Data access is still enforced by RLS; see [Architecture → Security model](ARCHITECTURE.md#7-security-model).

### 3.1 Steps to enable a supervisor

1. **Supabase Auth**  
   Ensure the user exists under **Authentication → Users**. Create the user (or have them sign up) and set a password.

2. **App users table**  
   Add a row in `public.users` with role `supervisor`:
   - From the app: an **admin** can add them via **Settings**.
   - From Supabase SQL Editor:

     ```sql
     insert into public.users (email, role)
     values ('operator@example.com', 'supervisor')
     on conflict (email) do update set role = 'supervisor';
     ```

   Emails are stored in lowercase; the app matches login email case-insensitively.

3. **Login**  
   The user signs in on the login page with the same email and password. They are redirected to the dashboard; Analysis and Settings are hidden from the navigation.

---

## Related documentation

| Document | Description |
|----------|-------------|
| [Architecture](ARCHITECTURE.md) | Project structure, tech stack, security, deployment overview |
| [Data Tables](DATA_TABLES.md) | Database tables and RLS |
| [Flows](FLOWS.md) | User and data flows |
