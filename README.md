## Project Structure

```
petrolPump/
├── index.html              # Login screen
├── dashboard.html          # Authenticated landing page
├── dsr.html                # Daily Sales Report entry + listing
├── credit.html             # Credit customer entry + ledger
├── expenses.html
├── attendance.html
├── analysis.html
├── sales-daily.html
├── css/
│   └── style.css
├── js/
│   ├── env.js              # Runtime config (overwritten by GHA deploy)
│   ├── supabase.js         # Supabase client bootstrap
│   ├── auth.js             # Auth helpers and session guard
│   ├── dashboard.js
│   ├── dsr.js
│   ├── credit.js
│   └── ...
├── supabase/
│   └── schema.sql
├── CNAME                   # GitHub Pages custom domain mapping
└── README.md
```

## Deployment (Prod + Staging)

This repo uses GitHub Actions to deploy two environments:

- **prod** → `main` branch (root site)
- **staging** → `staging` branch (`/staging/` path)

### How it works

- The workflow generates `js/env.js` during deploy using environment secrets.
- `js/supabase.js` reads `window.__APP_CONFIG__` so each environment uses its own Supabase project.

### Required GitHub environment secrets

Create two environments in GitHub: `prod` and `staging`, each with:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

### Supabase projects

- **Prod project:** `petrol pump`
- **Staging project:** `petrol pump staging`

### URLs

- Prod: `https://bishnupriyafuels.fnsventures.in/`
- Staging: `https://bishnupriyafuels.fnsventures.in/staging/`

### Deploy flow

1. **Test in staging**  
   - Push commits to `staging`
2. **Promote to prod**  
   - Merge `staging` → `main`

## Local Development

Run a local server on port 3000:

```bash
python3 -m http.server 3000
```

Open:

- `http://localhost:3000/`

