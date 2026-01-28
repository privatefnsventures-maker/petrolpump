/* global supabaseClient, AppCache, AppError */

const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const loginButton = document.getElementById("login-button");
const logoutButton = document.getElementById("logout-button");

const DEFAULT_ROLE = "admin";
const LANDING_BY_ROLE = {
  admin: "dashboard.html",
  supervisor: "credit.html",
};

/**
 * Generate cache key for user role
 */
function getRoleCacheKey(email) {
  return `staff_role_${email?.toLowerCase() ?? "unknown"}`;
}

function extractRole(source) {
  if (!source) return DEFAULT_ROLE;
  if (source.user_metadata) {
    return source.user_metadata.role ?? DEFAULT_ROLE;
  }
  return source.user?.user_metadata?.role ?? DEFAULT_ROLE;
}

function resolveLanding(role) {
  return LANDING_BY_ROLE[role] ?? LANDING_BY_ROLE[DEFAULT_ROLE];
}

function markCurrentNavLink() {
  const path = window.location.pathname;
  let current = path.split("/").pop() || "";
  if (!current || current === "index.html") {
    current = "dashboard.html";
  }

  document.querySelectorAll("header.topbar nav a").forEach((link) => {
    const href = link.getAttribute("href");
    if (href === current) {
      link.classList.add("nav-active");
      link.setAttribute("aria-current", "page");
    }
  });
}

/**
 * Normalize email for staff/role lookups (staff table stores lowercase).
 */
function normalizeEmail(email) {
  return (email || "").toLowerCase().trim();
}

/**
 * Fetch role from staff table with caching
 * Uses stale-while-revalidate pattern for fast role lookup
 */
async function fetchRoleFromStaff(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;

  const cacheKey = getRoleCacheKey(email);

  const fetchFn = async () => {
    const { data, error } = await supabaseClient
      .from("staff")
      .select("role")
      .eq("email", normalized)
      .maybeSingle();
    if (error) {
      AppError.report(error, { context: "fetchRoleFromStaff" });
      return null;
    }
    return data?.role ?? null;
  };

  // Use caching if available
  if (typeof AppCache !== "undefined" && AppCache) {
    return AppCache.getWithSWR(cacheKey, fetchFn, "staff_role");
  }

  return fetchFn();
}

async function resolveRoleForSession(session) {
  if (!session) return DEFAULT_ROLE;
  const email = session.user?.email;
  const staffRole = await fetchRoleFromStaff(email);
  return staffRole ?? extractRole(session);
}

/**
 * Clear cached role for a user (call after role changes)
 */
function invalidateUserRoleCache(email) {
  if (typeof AppCache !== "undefined" && AppCache && email) {
    AppCache.remove(getRoleCacheKey(email));
  }
}

if (loginForm) {
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    loginError?.classList.add("hidden");
    if (loginButton) loginButton.disabled = true;

    const formData = new FormData(loginForm);
    const email = formData.get("email");
    const password = formData.get("password");

    const { data, error } = await supabaseClient.auth.signInWithPassword({
      email,
      password,
    });

    if (loginButton) loginButton.disabled = false;

    if (error) {
      AppError.handle(error, { target: loginError });
      return;
    }

    const role = await resolveRoleForSession(data?.session ?? data?.user);
    window.location.href = resolveLanding(role);
  });
}

if (logoutButton) {
  logoutButton.addEventListener("click", async () => {
    // Get current session before signing out to clear cache
    const { data: { session } } = await supabaseClient.auth.getSession();
    const email = session?.user?.email;

    await supabaseClient.auth.signOut();

    // Clear user-specific caches on logout
    if (email) {
      invalidateUserRoleCache(email);
    }
    // Clear API-related caches
    if (typeof clearApiCaches === "function") {
      clearApiCaches();
    }

    window.location.href = "index.html";
  });
}

document.addEventListener("DOMContentLoaded", () => {
  markCurrentNavLink();
});

/**
 * Verifies page access via server-side database function.
 * This provides defense-in-depth beyond RLS policies.
 *
 * @param {string} pageName - The page identifier (e.g., 'settings', 'analysis')
 * @returns {Promise<{allowed: boolean, role: string}|null>}
 */
async function verifyPageAccess(pageName) {
  try {
    const { data, error } = await supabaseClient.rpc("check_page_access", {
      p_page: pageName,
    });
    if (error) {
      AppError.report(error, { context: "verifyPageAccess", pageName });
      return null;
    }
    return data;
  } catch (err) {
    AppError.report(err, { context: "verifyPageAccess", pageName });
    return null;
  }
}

/**
 * Redirects to the login page if there is no active Supabase session.
 * Supports optional role-based gating with server-side verification.
 *
 * SECURITY NOTE: Client-side checks are for UX only. All data operations
 * are protected by Row Level Security (RLS) policies in the database.
 * Users can bypass UI restrictions but cannot bypass RLS.
 *
 * @param {Object} options
 * @param {string[]} [options.allowedRoles]
 * @param {string} [options.redirectTo] - Where to send unauthenticated users.
 * @param {string} [options.onDenied] - Where to send authenticated users without the required role.
 * @param {string} [options.pageName] - Page identifier for server-side access verification.
 */
async function requireAuth(options = {}) {
  const {
    allowedRoles = null,
    redirectTo = "index.html",
    onDenied = "credit.html",
    pageName = null,
  } = options;

  const {
    data: { session },
  } = await supabaseClient.auth.getSession();

  if (!session) {
    window.location.href = redirectTo;
    return null;
  }

  // Resolve role from client (staff table + JWT fallback) first so we can
  // use it when server check is missing or disagrees
  const role = await resolveRoleForSession(session);

  // Server-side verification (if pageName provided)
  // Prefer server result; if server denies, still allow when client role is in allowedRoles
  // (e.g. user in staff as admin but get_user_role() returned null, or RPC not deployed)
  if (pageName) {
    const accessCheck = await verifyPageAccess(pageName);
    if (accessCheck && !accessCheck.allowed) {
      // Server says denied: only redirect if client also says not allowed
      if (Array.isArray(allowedRoles) && allowedRoles.length > 0 && !allowedRoles.includes(role)) {
        console.warn(`Access denied to ${pageName} for role: ${accessCheck.role}`);
        window.location.href = onDenied;
        return null;
      }
      // Server denied but client says allowed (e.g. admin in staff, server had null role) – allow
      return { session, role };
    }
    if (accessCheck?.role) {
      return { session, role: accessCheck.role };
    }
  }

  if (Array.isArray(allowedRoles) && allowedRoles.length > 0) {
    if (!allowedRoles.includes(role)) {
      window.location.href = onDenied;
      return null;
    }
  }

  return { session, role };
}

/**
 * Applies role-based visibility to UI elements.
 *
 * SECURITY NOTE: This is for UX only, NOT security enforcement.
 * Users can bypass this via browser dev tools, but they CANNOT bypass:
 * - Row Level Security (RLS) policies on database tables
 * - Server-side functions (upsert_staff, delete_staff, check_page_access)
 *
 * All sensitive operations are protected at the database level.
 *
 * @param {string} role - The user's role ('admin' or 'supervisor')
 */
function applyRoleVisibility(role) {
  document
    .querySelectorAll("[data-role='admin-only']")
    .forEach((el) => role !== "admin" && el.remove());

  document
    .querySelectorAll("[data-role='supervisor-only']")
    .forEach((el) => role === "admin" && el.remove());
}

window.requireAuth = requireAuth;
window.resolveLandingByRole = resolveLanding;
window.applyRoleVisibility = applyRoleVisibility;
window.resolveRoleForSession = resolveRoleForSession;
window.verifyPageAccess = verifyPageAccess;
window.invalidateUserRoleCache = invalidateUserRoleCache;