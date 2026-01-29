/**
 * Service Worker for Bishnupriya Fuels Petrol Pump Application
 * Provides offline capability, network caching, and background sync
 */

const CACHE_VERSION = "v2";
const STATIC_CACHE = `bpf-static-${CACHE_VERSION}`;
const DYNAMIC_CACHE = `bpf-dynamic-${CACHE_VERSION}`;
const API_CACHE = `bpf-api-${CACHE_VERSION}`;

// Static assets to cache on install
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/login.html",
  "/dashboard.html",
  "/dsr.html",
  "/credit.html",
  "/credit-overdue.html",
  "/expenses.html",
  "/attendance.html",
  "/sales-daily.html",
  "/analysis.html",
  "/settings.html",
  "/about.html",
  "/css/base.css",
  "/css/app.css",
  "/css/landing.css",
  "/css/login.css",
  "/js/env.js",
  "/js/utils.js",
  "/js/supabase.js",
  "/js/auth.js",
  "/js/cache.js",
  "/js/dashboard.js",
  "/js/dsr.js",
  "/js/credit.js",
  "/js/credit-overdue.js",
  "/js/expenses.js",
  "/js/attendance.js",
  "/js/sales-daily.js",
  "/js/analysis.js",
  "/js/settings.js",
  "/js/landing.js",
  "/assets/landing-01.JPG",
  "/assets/landing-02.JPG",
  "/assets/landing-03.JPG",
  "/assets/landing-04.JPG",
];

// API endpoints to cache with network-first strategy
const API_PATTERNS = [
  /\/rest\/v1\//,
  /\/functions\/v1\//,
];

// Cache TTL for different resource types (in milliseconds)
const CACHE_TTL = {
  api: 2 * 60 * 1000, // 2 minutes for API responses
  static: 24 * 60 * 60 * 1000, // 24 hours for static assets
};

/**
 * Install event - cache static assets
 */
self.addEventListener("install", (event) => {
  console.log("[SW] Installing service worker...");

  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => {
        console.log("[SW] Caching static assets...");
        // Cache what we can, don't fail on individual asset failures
        return Promise.allSettled(
          STATIC_ASSETS.map((url) =>
            cache.add(url).catch((err) => {
              console.warn(`[SW] Failed to cache: ${url}`, err);
            })
          )
        );
      })
      .then(() => {
        console.log("[SW] Static assets cached");
        return self.skipWaiting();
      })
      .catch((err) => {
        console.error("[SW] Install failed:", err);
      })
  );
});

/**
 * Activate event - clean up old caches
 */
self.addEventListener("activate", (event) => {
  console.log("[SW] Activating service worker...");

  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => {
              return (
                name.startsWith("bpf-") &&
                name !== STATIC_CACHE &&
                name !== DYNAMIC_CACHE &&
                name !== API_CACHE
              );
            })
            .map((name) => {
              console.log("[SW] Deleting old cache:", name);
              return caches.delete(name);
            })
        );
      })
      .then(() => {
        console.log("[SW] Service worker activated");
        return self.clients.claim();
      })
  );
});

/**
 * Fetch event - handle network requests with caching strategies
 */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== "GET") {
    return;
  }

  // Skip chrome-extension and other non-http(s) requests
  if (!url.protocol.startsWith("http")) {
    return;
  }

  // Handle API requests with network-first strategy
  if (isApiRequest(url)) {
    event.respondWith(networkFirstStrategy(request, API_CACHE));
    return;
  }

  // Handle static assets with cache-first strategy
  if (isStaticAsset(url)) {
    event.respondWith(cacheFirstStrategy(request, STATIC_CACHE));
    return;
  }

  // Handle HTML pages with stale-while-revalidate
  if (isHtmlPage(url)) {
    event.respondWith(staleWhileRevalidate(request, DYNAMIC_CACHE));
    return;
  }

  // Default: network with cache fallback
  event.respondWith(networkWithCacheFallback(request, DYNAMIC_CACHE));
});

/**
 * Check if request is an API call
 */
function isApiRequest(url) {
  return API_PATTERNS.some((pattern) => pattern.test(url.pathname));
}

/**
 * Check if request is for a static asset
 */
function isStaticAsset(url) {
  const staticExtensions = [".css", ".js", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".woff", ".woff2"];
  return staticExtensions.some((ext) => url.pathname.endsWith(ext));
}

/**
 * Check if request is for an HTML page
 */
function isHtmlPage(url) {
  return url.pathname.endsWith(".html") || url.pathname === "/" || !url.pathname.includes(".");
}

/**
 * Network-first strategy - try network, fall back to cache
 * Best for API requests where fresh data is preferred
 */
async function networkFirstStrategy(request, cacheName) {
  try {
    const networkResponse = await fetch(request);

    // Only cache successful responses
    if (networkResponse.ok) {
      const cache = await caches.open(cacheName);
      // Clone response before caching
      cache.put(request, networkResponse.clone());
    }

    return networkResponse;
  } catch (error) {
    console.log("[SW] Network failed, trying cache:", request.url);
    const cachedResponse = await caches.match(request);

    if (cachedResponse) {
      return cachedResponse;
    }

    // Return offline fallback for API requests
    return new Response(
      JSON.stringify({
        error: "offline",
        message: "You are offline. Please check your connection.",
      }),
      {
        status: 503,
        statusText: "Service Unavailable",
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

/**
 * Cache-first strategy - try cache, fall back to network
 * Best for static assets that rarely change
 */
async function cacheFirstStrategy(request, cacheName) {
  const cachedResponse = await caches.match(request);

  if (cachedResponse) {
    // Optionally refresh cache in background
    refreshCacheInBackground(request, cacheName);
    return cachedResponse;
  }

  try {
    const networkResponse = await fetch(request);

    if (networkResponse.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, networkResponse.clone());
    }

    return networkResponse;
  } catch (error) {
    console.error("[SW] Cache-first failed:", request.url, error);
    return new Response("Resource not available offline", { status: 503 });
  }
}

/**
 * Stale-while-revalidate strategy
 * Returns cached version immediately, updates cache in background
 */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cachedResponse = await cache.match(request);

  // Fetch from network in background
  const fetchPromise = fetch(request)
    .then((networkResponse) => {
      if (networkResponse.ok) {
        cache.put(request, networkResponse.clone());
      }
      return networkResponse;
    })
    .catch((error) => {
      console.warn("[SW] Background fetch failed:", request.url, error);
      return null;
    });

  // Return cached response immediately, or wait for network
  if (cachedResponse) {
    return cachedResponse;
  }

  const networkResponse = await fetchPromise;
  if (networkResponse) {
    return networkResponse;
  }

  // Return offline page as last resort
  return getOfflineFallback();
}

/**
 * Network with cache fallback
 */
async function networkWithCacheFallback(request, cacheName) {
  try {
    const networkResponse = await fetch(request);

    if (networkResponse.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, networkResponse.clone());
    }

    return networkResponse;
  } catch (error) {
    const cachedResponse = await caches.match(request);

    if (cachedResponse) {
      return cachedResponse;
    }

    return getOfflineFallback();
  }
}

/**
 * Refresh cache in background without blocking
 */
function refreshCacheInBackground(request, cacheName) {
  fetch(request)
    .then(async (response) => {
      if (response.ok) {
        const cache = await caches.open(cacheName);
        cache.put(request, response);
      }
    })
    .catch(() => {
      // Silent fail for background refresh
    });
}

/**
 * Get offline fallback response
 */
async function getOfflineFallback() {
  // Try to return cached index page
  const cachedIndex = await caches.match("/index.html");
  if (cachedIndex) {
    return cachedIndex;
  }

  // Return basic offline message
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Offline - Bishnupriya Fuels</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: #f5f5f5;
      color: #333;
    }
    .offline-container {
      text-align: center;
      padding: 2rem;
      max-width: 400px;
    }
    .offline-icon {
      font-size: 4rem;
      margin-bottom: 1rem;
    }
    h1 {
      font-size: 1.5rem;
      margin-bottom: 0.5rem;
    }
    p {
      color: #666;
      margin-bottom: 1.5rem;
    }
    button {
      background: #2563eb;
      color: white;
      border: none;
      padding: 0.75rem 1.5rem;
      border-radius: 0.5rem;
      cursor: pointer;
      font-size: 1rem;
    }
    button:hover {
      background: #1d4ed8;
    }
  </style>
</head>
<body>
  <div class="offline-container">
    <div class="offline-icon">📡</div>
    <h1>You're Offline</h1>
    <p>Please check your internet connection and try again.</p>
    <button onclick="window.location.reload()">Try Again</button>
  </div>
</body>
</html>`,
    {
      status: 503,
      statusText: "Service Unavailable",
      headers: { "Content-Type": "text/html" },
    }
  );
}

/**
 * Message handler for cache management from main thread
 */
self.addEventListener("message", (event) => {
  const { type, payload } = event.data || {};

  switch (type) {
    case "SKIP_WAITING":
      self.skipWaiting();
      break;

    case "CLEAR_CACHE":
      clearAllCaches().then(() => {
        event.ports[0]?.postMessage({ success: true });
      });
      break;

    case "CLEAR_API_CACHE":
      caches.delete(API_CACHE).then(() => {
        event.ports[0]?.postMessage({ success: true });
      });
      break;

    case "GET_CACHE_STATS":
      getCacheStats().then((stats) => {
        event.ports[0]?.postMessage(stats);
      });
      break;

    case "INVALIDATE_PATTERN":
      if (payload?.pattern) {
        invalidateCacheByPattern(payload.pattern).then(() => {
          event.ports[0]?.postMessage({ success: true });
        });
      }
      break;
  }
});

/**
 * Clear all application caches
 */
async function clearAllCaches() {
  const cacheNames = await caches.keys();
  await Promise.all(
    cacheNames
      .filter((name) => name.startsWith("bpf-"))
      .map((name) => caches.delete(name))
  );
}

/**
 * Get cache statistics
 */
async function getCacheStats() {
  const stats = {
    static: { entries: 0 },
    dynamic: { entries: 0 },
    api: { entries: 0 },
  };

  try {
    const staticCache = await caches.open(STATIC_CACHE);
    const staticKeys = await staticCache.keys();
    stats.static.entries = staticKeys.length;

    const dynamicCache = await caches.open(DYNAMIC_CACHE);
    const dynamicKeys = await dynamicCache.keys();
    stats.dynamic.entries = dynamicKeys.length;

    const apiCache = await caches.open(API_CACHE);
    const apiKeys = await apiCache.keys();
    stats.api.entries = apiKeys.length;
  } catch {
    // Ignore errors
  }

  return stats;
}

/**
 * Invalidate cache entries matching a pattern
 */
async function invalidateCacheByPattern(pattern) {
  const regex = new RegExp(pattern);
  const cacheNames = await caches.keys();

  for (const cacheName of cacheNames) {
    if (!cacheName.startsWith("bpf-")) continue;

    const cache = await caches.open(cacheName);
    const keys = await cache.keys();

    for (const request of keys) {
      if (regex.test(request.url)) {
        await cache.delete(request);
      }
    }
  }
}

console.log("[SW] Service worker script loaded");
