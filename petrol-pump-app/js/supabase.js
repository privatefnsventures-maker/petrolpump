/* global supabase */

// Update these with your Supabase project details.
const SUPABASE_URL = "https://lbpweydzbydndbayhstk.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_U-_hFv3Qwq_E30-lxCrb7Q_wC8c8c6H";

if (!SUPABASE_URL || SUPABASE_URL.includes("YOUR-PROJECT-ID")) {
  console.warn(
    "Supabase URL and anon key are placeholders. Update js/supabase.js before deploying."
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
