/**
 * Runtime environment configuration template.
 * 
 * SETUP:
 * 1. Copy this file to js/env.js
 * 2. Replace placeholder values with your actual Supabase credentials
 * 3. Never commit js/env.js to version control
 * 
 * For production deployments, js/env.js is generated automatically
 * by the CI/CD pipeline using GitHub Secrets.
 */
window.__APP_CONFIG__ = {
  SUPABASE_URL: "https://YOUR-PROJECT-ID.supabase.co",
  SUPABASE_ANON_KEY: "your-anon-key-here",
  APP_ENV: "staging",
};
