## Petrol Pump Dashboard (Supabase + GitHub Pages)

This project delivers a lightweight management dashboard for petrol pump operations using plain HTML, CSS, and JavaScript backed by Supabase for Auth + Database. It is tailored around three core workflows:

- **Daily Sales Report (DSR)** capture and review
- **Credit customer ledger** maintenance
- **Operator login/logout** via Supabase Email/Password

The codebase is deployable as-is to GitHub Pages and includes guidance for mapping a custom domain (`fnsventures.in`).

---

### 1. Project Structure

```
petrol-pump-app/
├── index.html              # Login screen
├── dashboard.html          # Authenticated landing page
├── dsr.html                # Daily Sales Report entry + listing
├── credit.html             # Credit customer entry + ledger
├── css/
│   └── style.css
├── js/
│   ├── supabase.js         # Supabase client bootstrap (update with your keys)
│   ├── auth.js             # Auth helpers and session guard
│   ├── dashboard.js
│   ├── dsr.js
│   └── credit.js
├── supabase/
│   └── schema.sql          # SQL migrations for DSR + Credit tables
├── CNAME                   # GitHub Pages custom domain mapping
└── README.md
```

---

### 2. Supabase Setup

1. **Create Project**  
   - Go to [Supabase](https://supabase.com), create a new project, and note the **Project URL** and **Anon public key**.

2. **Auth Configuration**  
   - Enable *Email/Password* provider under **Authentication → Providers**.  
   - (Optional) Disable self-signups if you prefer to manage operators manually.

3. **Database Schema**  
   - Run the statements in `supabase/schema.sql` via Supabase SQL Editor or the CLI.  
   - Review comments in the file to adjust limits, indexes, or cascading rules if needed.

4. **Environment Variables**  
   - Update `js/supabase.js` with your Supabase project credentials.  
   - When publishing to GitHub Pages, these values become part of the static bundle; rotate keys if leaked and consider IP restrictions in Supabase.

---

### 3. Local Preview

Because the app is completely static, you can open the HTML files directly in a browser. For cleaner routing and CORS, use a lightweight server:

```bash
cd petrol-pump-app
python3 -m http.server 3000
# Visit http://localhost:3000/index.html
```

---

### 4. Deploy to GitHub Pages

1. Create a new GitHub repository (e.g. `petrol-pump-app`) and push the contents of this directory.
2. In the repository:
   - Go to **Settings → Pages**.
   - Set **Branch** to `main` and the folder to `/ (root)`.
3. Once the build completes, your site will be live at `https://<username>.github.io/petrol-pump-app/`.

> **Note:** The included `CNAME` file instructs GitHub Pages to serve the site from `fnsventures.in`. Keep the file in the repository root so GitHub configures DNS automatically.

---

### 5. Custom Domain Mapping (`fnsventures.in`)

1. **DNS Provider (e.g. GoDaddy/Namecheap)**  
   Create the following `A` records pointing to GitHub Pages:

   | Host | Type | Value          |
   |------|------|----------------|
   | @    | A    | 185.199.108.153 |
   | @    | A    | 185.199.109.153 |
   | @    | A    | 185.199.110.153 |
   | @    | A    | 185.199.111.153 |

   Optionally add a `www` CNAME pointing to `fnsventures.in`.

2. **GitHub Pages**  
   - In **Settings → Pages**, enter `fnsventures.in` as the custom domain (the `CNAME` file ensures this remains consistent).
   - Enable HTTPS once propagation completes.

3. **Supabase Redirects** (Optional)  
   - Update your Supabase project's allowed redirect URLs to include `https://fnsventures.in` and `https://www.fnsventures.in` under **Authentication → URL Configuration**.

---

### 6. Usage Notes

- All authenticated pages (`dashboard.html`, `dsr.html`, `credit.html`) call a shared `requireAuth` guard that redirects to the login page if no session exists.
- Forms use async Supabase calls for inserts and fetches. Errors are surfaced inline for quick debugging.
- The layout is intentionally minimal so you can apply your own branding or integrate with additional Supabase tables (inventory, banking, etc.).

---

### 7. Next Steps

- Add role-based access (e.g. Manager vs Operator) by extending Supabase Auth and Row-Level Security policies.
- Provide CSV/PDF export of DSR data (use Supabase Functions or client-side libraries).
- Integrate with Supabase Storage for uploading shift photos, bills, or receipts.

Deploy, log in with an operator account, and you have an immediately usable petrol pump dashboard running on GitHub Pages with Supabase as the backend.

