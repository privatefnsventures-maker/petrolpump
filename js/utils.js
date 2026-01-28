/**
 * Shared utilities for the app.
 */

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
