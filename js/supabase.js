/* global supabase */

const runtimeConfig = window.__APP_CONFIG__ || {};
const runtimeEnv = runtimeConfig.APP_ENV || "staging";

const PROD_HOSTS = ["bishnupriyafuels.fnsventures.in"];
const hostname = window.location.hostname;
const isProdHost = PROD_HOSTS.includes(hostname);

const SUPABASE_URL = runtimeConfig.SUPABASE_URL;
const SUPABASE_ANON_KEY = runtimeConfig.SUPABASE_ANON_KEY;

// Validate configuration
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error(
    "Supabase configuration missing. Please ensure js/env.js exists with valid credentials. " +
    "See js/env.example.js for setup instructions."
  );
}

if (runtimeEnv === "prod" && !isProdHost) {
  console.warn(
    "APP_ENV is set to 'prod' but running on a non-production host."
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
