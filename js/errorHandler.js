/**
 * Centralized error handling for Petrol Pump application.
 * - User-friendly error messages
 * - Optional reporting to monitoring service
 * - Retry logic for transient failures
 * - Global handlers for uncaught errors and unhandled rejections
 */

(function () {
  "use strict";

  const CONFIG = (typeof window !== "undefined" && window.__APP_CONFIG__) || {};
  const REPORT_URL = CONFIG.ERROR_REPORT_URL || null;
  const APP_ENV = CONFIG.APP_ENV || "staging";

  // Patterns/codes that indicate transient failures (worth retrying)
  const TRANSIENT_PATTERNS = [
    /network\s*error/i,
    /failed\s*to\s*fetch/i,
    /load\s*failed/i,
    /timeout/i,
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i,
    /503\s*service\s*unavailable/i,
    /502\s*bad\s*gateway/i,
    /504\s*gateway\s*timeout/i,
    /429\s*too\s*many\s*requests/i,
  ];

  const TRANSIENT_HTTP_CODES = [408, 429, 500, 502, 503, 504];

  /**
   * Normalize unknown values to an Error-like object.
   * @param {*} err
   * @returns {{ message: string, code?: string, original: unknown }}
   */
  function normalizeError(err) {
    if (!err) {
      return { message: "Something went wrong.", original: err };
    }
    if (err instanceof Error) {
      return {
        message: err.message,
        code: err.code,
        name: err.name,
        original: err,
      };
    }
    if (typeof err === "object" && err !== null && "message" in err) {
      return {
        message: String(err.message),
        code: err.code != null ? String(err.code) : undefined,
        original: err,
      };
    }
    return { message: String(err), original: err };
  }

  /**
   * Map technical errors to user-friendly messages.
   * @param {string} message
   * @param {{ code?: string, httpStatus?: number }} context
   * @returns {string}
   */
  function getUserFriendlyMessage(message, context) {
    const code = (context && context.code) || "";
    const status = context && context.httpStatus;
    const lower = (message || "").toLowerCase();

    // Auth
    if (lower.includes("invalid login") || lower.includes("invalid_credentials")) {
      return "Invalid email or password. Please try again.";
    }
    if (lower.includes("email not confirmed")) {
      return "Please confirm your email before signing in.";
    }
    if (lower.includes("access denied") || lower.includes("permission") || lower.includes("policy")) {
      return "You don't have permission to perform this action.";
    }
    if (lower.includes("session") && (lower.includes("expired") || lower.includes("invalid"))) {
      return "Your session has expired. Please sign in again.";
    }

    // Network / availability
    if (lower.includes("failed to fetch") || lower.includes("network error") || lower.includes("load failed")) {
      return "Connection problem. Please check your internet and try again.";
    }
    if (lower.includes("timeout") || lower.includes("timed out")) {
      return "The request took too long. Please try again.";
    }

    // Rate limit
    if (status === 429 || lower.includes("too many requests")) {
      return "Too many requests. Please wait a moment and try again.";
    }

    // Server errors
    if (status >= 500 || lower.includes("503") || lower.includes("502") || lower.includes("504")) {
      return "Our servers are temporarily busy. Please try again in a moment.";
    }

    // Common DB / Supabase
    if (lower.includes("duplicate") || lower.includes("unique") || code === "23505") {
      return "This record already exists. Please use a different value.";
    }
    if (lower.includes("foreign key") || code === "23503") {
      return "This action cannot be completed because it references missing data.";
    }
    if (lower.includes("row-level security") || lower.includes("rlspolicy") || lower.includes("new row violates")) {
      return "You don't have permission to perform this action.";
    }
    if (lower.includes("jwt") || lower.includes("token")) {
      return "Your session may have expired. Please sign in again.";
    }

    // Fallback: return original message but truncate long technical strings
    if (message && message.length > 200) {
      return message.slice(0, 197) + "...";
    }
    return message || "Something went wrong. Please try again.";
  }

  /**
   * Extract HTTP status from Supabase/postgrest error if present.
   * @param {*} err
   * @returns {number|undefined}
   */
  function getHttpStatus(err) {
    if (!err || typeof err !== "object") return undefined;
    if (typeof err.status === "number") return err.status;
    if (typeof err.statusCode === "number") return err.statusCode;
    return undefined;
  }

  /**
   * Report error to monitoring service (if configured).
   * @param {*} err
   * @param {Object} context
   */
  function reportToMonitoring(err, context) {
    if (!REPORT_URL || typeof fetch === "undefined") return;

    const normalized = normalizeError(err);
    const payload = {
      env: APP_ENV,
      message: normalized.message,
      code: normalized.code,
      url: typeof window !== "undefined" ? window.location.href : "",
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
      timestamp: new Date().toISOString(),
      ...context,
    };

    try {
      fetch(REPORT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(function () {
        // Silently ignore report failures to avoid feedback loops
      });
    } catch (_) {
      // Ignore
    }
  }

  /**
   * Check if the error looks transient (suitable for retry).
   * @param {*} err
   * @returns {boolean}
   */
  function isTransientError(err) {
    const normalized = normalizeError(err);
    const msg = (normalized.message || "").toLowerCase();
    const status = getHttpStatus(normalized.original);

    if (status != null && TRANSIENT_HTTP_CODES.includes(status)) return true;
    return TRANSIENT_PATTERNS.some(function (p) {
      return p.test(msg);
    });
  }

  /**
   * Retry an async function with exponential backoff for transient failures.
   * @param {() => Promise<T>} fn
   * @param {{ maxAttempts?: number, baseMs?: number, maxMs?: number, isRetryable?: (err: unknown) => boolean }} options
   * @returns {Promise<T>}
   */
  async function withRetry(fn, options) {
    const maxAttempts = options && options.maxAttempts != null ? options.maxAttempts : 3;
    const baseMs = options && options.baseMs != null ? options.baseMs : 500;
    const maxMs = options && options.maxMs != null ? options.maxMs : 10000;
    const isRetryable = options && typeof options.isRetryable === "function" ? options.isRetryable : isTransientError;

    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt === maxAttempts || !isRetryable(err)) throw err;
        const delay = Math.min(maxMs, baseMs * Math.pow(2, attempt - 1));
        await new Promise(function (r) {
          setTimeout(r, delay);
        });
      }
    }
    throw lastErr;
  }

  /**
   * Central handle: normalize, get friendly message, report, optionally show in UI.
   * @param {*} err
   * @param {{ target?: HTMLElement | null, report?: boolean, context?: Object }} options
   * @returns {string} User-friendly message
   */
  function handle(err, options) {
    const opts = options || {};
    const target = opts.target;
    const shouldReport = opts.report !== false;
    const context = opts.context || {};

    const normalized = normalizeError(err);
    const httpStatus = getHttpStatus(normalized.original);
    const friendly = getUserFriendlyMessage(normalized.message, {
      code: normalized.code,
      httpStatus,
    });

    if (shouldReport) {
      reportToMonitoring(err, { ...context, friendlyMessage: friendly, httpStatus });
    }

    if (typeof console !== "undefined" && console.error) {
      console.error("[AppError]", friendly, normalized.original);
    }

    if (target && typeof target.textContent !== "undefined") {
      target.textContent = friendly;
      target.classList && target.classList.remove("hidden");
    }

    return friendly;
  }

  /**
   * Show a global error banner (creates and injects if not present).
   * @param {string} message
   */
  function showGlobalBanner(message) {
    if (typeof document === "undefined" || !document.body) return;

    let banner = document.getElementById("app-error-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "app-error-banner";
      banner.setAttribute("role", "alert");
      banner.className = "app-error-banner";
      const close = document.createElement("button");
      close.type = "button";
      close.className = "app-error-banner-close";
      close.setAttribute("aria-label", "Dismiss");
      close.textContent = "×";
      close.addEventListener("click", function () {
        banner.classList.add("hidden");
      });
      banner.appendChild(document.createTextNode(""));
      banner.appendChild(close);
      document.body.insertBefore(banner, document.body.firstChild);
    }

    const text = banner.firstChild;
    if (text && text.nodeType === Node.TEXT_NODE) {
      text.textContent = message;
    } else {
      banner.insertBefore(document.createTextNode(message), banner.firstChild);
    }
    banner.classList.remove("hidden");
  }

  function onUnhandledError(event) {
    const err = event.error || event.reason || new Error("Unknown error");
    const friendly = handle(err, { report: true, context: { source: "global" } });
    showGlobalBanner(friendly);
    if (event.preventDefault) event.preventDefault();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    return false;
  }

  function onUnhandledRejection(event) {
    const err = event.reason;
    if (!err) return;
    const friendly = handle(err, { report: true, context: { source: "unhandledrejection" } });
    showGlobalBanner(friendly);
    event.preventDefault();
  }

  // Attach global handlers
  if (typeof window !== "undefined") {
    window.addEventListener("error", onUnhandledError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
  }

  // Public API
  window.AppError = {
    handle: handle,
    getUserMessage: function (err) {
      const n = normalizeError(err);
      return getUserFriendlyMessage(n.message, {
        code: n.code,
        httpStatus: getHttpStatus(n.original),
      });
    },
    report: reportToMonitoring,
    withRetry: withRetry,
    isTransient: isTransientError,
    showGlobalBanner: showGlobalBanner,
    normalize: normalizeError,
  };
})();
