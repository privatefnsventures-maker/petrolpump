/**
 * Data caching utility for Petrol Pump application.
 * Provides localStorage caching with TTL, stale-while-revalidate pattern,
 * and cache invalidation utilities.
 */

const AppCache = (function () {
  const CACHE_PREFIX = "bpf_cache_";
  const DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes default TTL
  const STALE_TTL = 30 * 60 * 1000; // 30 minutes stale window

  // Cache TTL configurations for different data types
  const CACHE_CONFIG = {
    // Static reference data - long TTL
    staff_role: { ttl: 60 * 60 * 1000, staleTtl: 24 * 60 * 60 * 1000 }, // 1 hour, 24h stale
    staff_list: { ttl: 10 * 60 * 1000, staleTtl: 60 * 60 * 1000 }, // 10 min, 1h stale

    // Frequently accessed data - short TTL with stale-while-revalidate
    dashboard_data: { ttl: 2 * 60 * 1000, staleTtl: 10 * 60 * 1000 }, // 2 min, 10min stale
    credit_summary: { ttl: 2 * 60 * 1000, staleTtl: 10 * 60 * 1000 }, // 2 min, 10min stale
    today_sales: { ttl: 1 * 60 * 1000, staleTtl: 5 * 60 * 1000 }, // 1 min, 5min stale
    recent_activity: { ttl: 1 * 60 * 1000, staleTtl: 5 * 60 * 1000 }, // 1 min, 5min stale

    // DSR summary data - moderate TTL
    dsr_summary: { ttl: 3 * 60 * 1000, staleTtl: 15 * 60 * 1000 }, // 3 min, 15min stale
    profit_loss: { ttl: 3 * 60 * 1000, staleTtl: 15 * 60 * 1000 }, // 3 min, 15min stale
  };

  /**
   * Check if localStorage is available
   */
  function isStorageAvailable() {
    try {
      const test = "__storage_test__";
      localStorage.setItem(test, test);
      localStorage.removeItem(test);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Get cache key with prefix
   */
  function getCacheKey(key) {
    return CACHE_PREFIX + key;
  }

  /**
   * Get TTL configuration for a cache type
   */
  function getConfig(cacheType) {
    return CACHE_CONFIG[cacheType] || { ttl: DEFAULT_TTL, staleTtl: STALE_TTL };
  }

  /**
   * Store data in cache with metadata
   */
  function set(key, data, cacheType = null) {
    if (!isStorageAvailable()) return false;

    const config = cacheType ? getConfig(cacheType) : { ttl: DEFAULT_TTL, staleTtl: STALE_TTL };
    const now = Date.now();
    const cacheEntry = {
      data: data,
      timestamp: now,
      expiresAt: now + config.ttl,
      staleAt: now + config.staleTtl,
      cacheType: cacheType,
    };

    try {
      localStorage.setItem(getCacheKey(key), JSON.stringify(cacheEntry));
      return true;
    } catch (e) {
      // Handle quota exceeded - clear old entries
      if (e.name === "QuotaExceededError") {
        clearOldEntries();
        try {
          localStorage.setItem(getCacheKey(key), JSON.stringify(cacheEntry));
          return true;
        } catch {
          console.warn("Cache storage failed after cleanup:", key);
          return false;
        }
      }
      console.warn("Cache storage failed:", key, e);
      return false;
    }
  }

  /**
   * Get data from cache
   * @returns {Object} { data, isStale, isExpired, isMiss }
   */
  function get(key) {
    if (!isStorageAvailable()) {
      return { data: null, isStale: false, isExpired: true, isMiss: true };
    }

    try {
      const raw = localStorage.getItem(getCacheKey(key));
      if (!raw) {
        return { data: null, isStale: false, isExpired: true, isMiss: true };
      }

      const entry = JSON.parse(raw);
      const now = Date.now();

      // Check if completely stale (beyond stale window)
      if (now > entry.staleAt) {
        return { data: entry.data, isStale: true, isExpired: true, isMiss: false };
      }

      // Check if expired but within stale window
      if (now > entry.expiresAt) {
        return { data: entry.data, isStale: true, isExpired: false, isMiss: false };
      }

      // Fresh data
      return { data: entry.data, isStale: false, isExpired: false, isMiss: false };
    } catch (e) {
      console.warn("Cache read failed:", key, e);
      return { data: null, isStale: false, isExpired: true, isMiss: true };
    }
  }

  /**
   * Remove a specific cache entry
   */
  function remove(key) {
    if (!isStorageAvailable()) return;
    try {
      localStorage.removeItem(getCacheKey(key));
    } catch {
      // Ignore
    }
  }

  /**
   * Clear all cache entries with our prefix
   */
  function clearAll() {
    if (!isStorageAvailable()) return;
    try {
      const keys = Object.keys(localStorage);
      keys.forEach((key) => {
        if (key.startsWith(CACHE_PREFIX)) {
          localStorage.removeItem(key);
        }
      });
    } catch {
      // Ignore
    }
  }

  /**
   * Clear old/expired cache entries
   */
  function clearOldEntries() {
    if (!isStorageAvailable()) return;
    const now = Date.now();
    try {
      const keys = Object.keys(localStorage);
      keys.forEach((key) => {
        if (!key.startsWith(CACHE_PREFIX)) return;
        try {
          const raw = localStorage.getItem(key);
          if (!raw) return;
          const entry = JSON.parse(raw);
          // Remove if beyond stale window
          if (now > entry.staleAt) {
            localStorage.removeItem(key);
          }
        } catch {
          // Remove corrupted entries
          localStorage.removeItem(key);
        }
      });
    } catch {
      // Ignore
    }
  }

  /**
   * Invalidate cache entries by type
   */
  function invalidateByType(cacheType) {
    if (!isStorageAvailable()) return;
    try {
      const keys = Object.keys(localStorage);
      keys.forEach((key) => {
        if (!key.startsWith(CACHE_PREFIX)) return;
        try {
          const raw = localStorage.getItem(key);
          if (!raw) return;
          const entry = JSON.parse(raw);
          if (entry.cacheType === cacheType) {
            localStorage.removeItem(key);
          }
        } catch {
          // Ignore individual errors
        }
      });
    } catch {
      // Ignore
    }
  }

  /**
   * Invalidate cache entries matching a pattern
   */
  function invalidateByPattern(pattern) {
    if (!isStorageAvailable()) return;
    try {
      const keys = Object.keys(localStorage);
      const regex = new RegExp(pattern);
      keys.forEach((key) => {
        if (key.startsWith(CACHE_PREFIX) && regex.test(key)) {
          localStorage.removeItem(key);
        }
      });
    } catch {
      // Ignore
    }
  }

  /**
   * Stale-while-revalidate pattern implementation
   * Returns cached data immediately while fetching fresh data in background
   *
   * @param {string} key - Cache key
   * @param {Function} fetchFn - Async function to fetch fresh data
   * @param {string} cacheType - Cache type for TTL configuration
   * @param {Function} onUpdate - Optional callback when fresh data arrives
   * @returns {Promise<any>} - Returns cached data or fresh data
   */
  async function getWithSWR(key, fetchFn, cacheType = null, onUpdate = null) {
    const cached = get(key);

    // If we have cached data (even stale), return it
    if (!cached.isMiss && cached.data !== null) {
      // If stale or expired, revalidate in background
      if (cached.isStale || cached.isExpired) {
        // Background revalidation
        fetchFn()
          .then((freshData) => {
            if (freshData !== null && freshData !== undefined) {
              set(key, freshData, cacheType);
              if (onUpdate && typeof onUpdate === "function") {
                onUpdate(freshData);
              }
            }
          })
          .catch((err) => {
            console.warn("Background revalidation failed:", key, err);
          });
      }
      return cached.data;
    }

    // No cached data - fetch fresh
    try {
      const freshData = await fetchFn();
      if (freshData !== null && freshData !== undefined) {
        set(key, freshData, cacheType);
      }
      return freshData;
    } catch (err) {
      if (typeof window.AppError !== "undefined" && window.AppError.report) {
        window.AppError.report(err, { context: "AppCache.getWithSWR", key });
      } else {
        console.error("Fetch failed with no cached fallback:", key, err);
      }
      throw err;
    }
  }

  /**
   * Get cache statistics
   */
  function getStats() {
    if (!isStorageAvailable()) {
      return { entries: 0, size: 0, expired: 0, stale: 0 };
    }

    const now = Date.now();
    let entries = 0;
    let size = 0;
    let expired = 0;
    let stale = 0;

    try {
      const keys = Object.keys(localStorage);
      keys.forEach((key) => {
        if (!key.startsWith(CACHE_PREFIX)) return;
        const raw = localStorage.getItem(key);
        if (!raw) return;

        entries++;
        size += raw.length * 2; // Approximate bytes (2 bytes per char)

        try {
          const entry = JSON.parse(raw);
          if (now > entry.staleAt) {
            expired++;
            stale++;
          } else if (now > entry.expiresAt) {
            stale++;
          }
        } catch {
          expired++;
        }
      });
    } catch {
      // Ignore
    }

    return { entries, size, expired, stale };
  }

  // Public API
  return {
    set,
    get,
    remove,
    clearAll,
    clearOldEntries,
    invalidateByType,
    invalidateByPattern,
    getWithSWR,
    getStats,
    isStorageAvailable,
    CACHE_CONFIG,
  };
})();

// Export for use in other modules
window.AppCache = AppCache;
