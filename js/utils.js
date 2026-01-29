/**
 * Shared utilities for the app.
 */

const FILTER_STORAGE_PREFIX = "petrolpump_filter_";

/**
 * Get persisted filter state. Returns null if none or invalid.
 * @param {string} key - e.g. 'dashboard_dsr', 'dashboard_pl', 'analysis'
 * @returns {{ range: string, start?: string, end?: string }|null}
 */
function getFilterState(key) {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_PREFIX + key);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data && typeof data.range === "string" ? data : null;
  } catch {
    return null;
  }
}

/**
 * Get filter state only if valid for the given allowed ranges.
 * For "custom" range, start and end must be present.
 * @param {string} key
 * @param {Set<string>} allowedRanges - e.g. new Set(['today','this-week','this-month','custom'])
 * @returns {{ range: string, start?: string, end?: string }|null}
 */
function getValidFilterState(key, allowedRanges) {
  const data = getFilterState(key);
  if (!data || !allowedRanges.has(data.range)) return null;
  if (data.range === "custom" && (!data.start || !data.end)) return null;
  return data;
}

/**
 * Persist filter state so it can be restored when the user comes back.
 * @param {string} key
 * @param {{ range: string, start?: string, end?: string }} state
 */
function setFilterState(key, state) {
  if (typeof localStorage === "undefined" || !state || typeof state.range !== "string") return;
  try {
    localStorage.setItem(FILTER_STORAGE_PREFIX + key, JSON.stringify(state));
  } catch (_) {}
}

/**
 * Format a value as INR currency (₹) with 2 decimal places.
 * Returns "—" for null, undefined, or NaN.
 * @param {number|null|undefined} value
 * @returns {string}
 */
function formatCurrency(value) {
  if (value === null || value === undefined) return "—";
  if (Number.isNaN(Number(value))) return "—";
  return "₹" + Number(value).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

window.formatCurrency = formatCurrency;
window.getFilterState = getFilterState;
window.getValidFilterState = getValidFilterState;
window.setFilterState = setFilterState;
