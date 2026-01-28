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
 * Register Service Worker for offline capability and caching
 */
function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", async () => {
      try {
        const registration = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
        });
        console.log("[App] Service Worker registered:", registration.scope);

        // Handle updates
        registration.addEventListener("updatefound", () => {
          const newWorker = registration.installing;
          if (newWorker) {
            newWorker.addEventListener("statechange", () => {
              if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
                // New version available
                console.log("[App] New Service Worker available");
                // Optionally notify user about update
                if (window.confirm("A new version is available. Reload to update?")) {
                  newWorker.postMessage({ type: "SKIP_WAITING" });
                  window.location.reload();
                }
              }
            });
          }
        });
      } catch (error) {
        console.warn("[App] Service Worker registration failed:", error);
      }
    });

    // Handle controller change (new SW activated)
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      console.log("[App] Service Worker controller changed");
    });
  }
}

/**
 * Send message to Service Worker
 */
function sendToServiceWorker(type, payload = {}) {
  return new Promise((resolve) => {
    if (!navigator.serviceWorker?.controller) {
      resolve(null);
      return;
    }

    const messageChannel = new MessageChannel();
    messageChannel.port1.onmessage = (event) => {
      resolve(event.data);
    };

    navigator.serviceWorker.controller.postMessage(
      { type, payload },
      [messageChannel.port2]
    );

    // Timeout fallback
    setTimeout(() => resolve(null), 3000);
  });
}

/**
 * Clear all caches (localStorage + Service Worker)
 */
async function clearAllCaches() {
  // Clear localStorage cache
  if (window.AppCache) {
    window.AppCache.clearAll();
  }

  // Clear Service Worker caches
  await sendToServiceWorker("CLEAR_CACHE");

  console.log("[App] All caches cleared");
}

/**
 * Clear API-related caches
 */
async function clearApiCaches() {
  // Clear localStorage cache types related to API data
  if (window.AppCache) {
    window.AppCache.invalidateByType("dashboard_data");
    window.AppCache.invalidateByType("credit_summary");
    window.AppCache.invalidateByType("today_sales");
    window.AppCache.invalidateByType("recent_activity");
    window.AppCache.invalidateByType("dsr_summary");
    window.AppCache.invalidateByType("profit_loss");
  }

  // Clear Service Worker API cache
  await sendToServiceWorker("CLEAR_API_CACHE");

  console.log("[App] API caches cleared");
}

/**
 * Get combined cache statistics
 */
async function getCacheStats() {
  const localStats = window.AppCache ? window.AppCache.getStats() : null;
  const swStats = await sendToServiceWorker("GET_CACHE_STATS");

  return {
    localStorage: localStats,
    serviceWorker: swStats,
  };
}

// Initialize Service Worker registration
registerServiceWorker();

// Clean up old cache entries periodically
if (window.AppCache) {
  // Initial cleanup
  window.AppCache.clearOldEntries();

  // Periodic cleanup every 10 minutes
  setInterval(() => {
    window.AppCache.clearOldEntries();
  }, 10 * 60 * 1000);
}

window.supabaseClient = supabaseClient;
window.clearAllCaches = clearAllCaches;
window.clearApiCaches = clearApiCaches;
window.getCacheStats = getCacheStats;
