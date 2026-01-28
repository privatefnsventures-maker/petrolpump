/* global supabase */

const runtimeConfig = window.__APP_CONFIG__ || {};
const runtimeEnv = runtimeConfig.APP_ENV || "staging";

// Update these with your Supabase project details.
const STAGING_SUPABASE_URL = "https://sshxdavhbwfhzzxxdrhn.supabase.co";
const STAGING_SUPABASE_ANON_KEY =
  "sb_publishable_Vi8TjINOqGDlANzBH0nnrw_WJ3tGspz";

const LOCAL_HOSTS = ["localhost", "127.0.0.1"];
const PROD_HOSTS = ["bishnupriyafuels.fnsventures.in"];
const hostname = window.location.hostname;
const isLocalhost = LOCAL_HOSTS.includes(hostname);
const isProdHost = PROD_HOSTS.includes(hostname);

let SUPABASE_URL = runtimeConfig.SUPABASE_URL || STAGING_SUPABASE_URL;
let SUPABASE_ANON_KEY =
  runtimeConfig.SUPABASE_ANON_KEY || STAGING_SUPABASE_ANON_KEY;

if (isLocalhost || (runtimeEnv === "prod" && !isProdHost)) {
  SUPABASE_URL = STAGING_SUPABASE_URL;
  SUPABASE_ANON_KEY = STAGING_SUPABASE_ANON_KEY;
}

if (!runtimeConfig.SUPABASE_URL || !runtimeConfig.SUPABASE_ANON_KEY) {
  console.warn(
    "Supabase runtime config missing; falling back to staging defaults."
  );
}

if (runtimeEnv === "prod" && !isProdHost) {
  console.warn(
    "APP_ENV is prod on a non-prod host; using staging Supabase."
  );
}

if (
  !SUPABASE_URL ||
  !SUPABASE_ANON_KEY ||
  SUPABASE_URL.includes("YOUR-PROJECT-ID")
) {
  console.warn(
    "Supabase config is invalid. Check js/env.js and environment secrets."
  );
}

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/**
 * Utility to format amounts as INR currency.
 */
function formatCurrency(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "₹0";
  }
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(Number(value));
}

window.supabaseClient = supabaseClient;
window.formatCurrency = formatCurrency;
