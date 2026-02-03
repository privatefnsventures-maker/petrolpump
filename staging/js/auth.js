/* global supabaseClient, AppCache, AppError */

const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const loginButton = document.getElementById("login-button");
const logoutButton = document.getElementById("logout-button");

const DEFAULT_ROLE = "admin";
const LANDING_BY_ROLE = {
  admin: "dashboard.html",
  supervisor: "dashboard.html",
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
      .from("users")
      .select("role, display_name")
      .eq("email", normalized)
      .maybeSingle();
    if (error) {
      AppError.report(error, { context: "fetchRoleFromUsers" });
      return null;
    }
    return data ? { role: data.role ?? null, display_name: data.display_name?.trim() || null } : null;
  };

  // Use caching if available
  if (typeof AppCache !== "undefined" && AppCache) {
    return AppCache.getWithSWR(cacheKey, fetchFn, "user_role");
  }

  return fetchFn();
}

async function resolveAuthForSession(session) {
  if (!session) return { role: DEFAULT_ROLE, display_name: null };
  const email = session.user?.email;
  const cached = await fetchRoleFromStaff(email);
  if (cached) {
    return { role: cached.role ?? extractRole(session), display_name: cached.display_name };
  }
  return { role: extractRole(session), display_name: null };
}

async function resolveRoleForSession(session) {
  const auth = await resolveAuthForSession(session);
  return auth.role;
}

/**
 * Clear cached role for a user (call after role changes)
 */
function invalidateUserRoleCache(email) {
  if (typeof AppCache !== "undefined" && AppCache && email) {
    AppCache.remove(getRoleCacheKey(email));
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const path = window.location.pathname || "";
  if (path.includes("login")) {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session) {
      const role = await resolveRoleForSession(session);
      window.location.href = resolveLanding(role);
      return;
    }
  }
  markCurrentNavLink();
  initNavToggle();
});

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

const forgotPasswordLink = document.getElementById("forgot-password-link");
if (forgotPasswordLink) {
  forgotPasswordLink.addEventListener("click", async (e) => {
    e.preventDefault();
    const emailInput = document.getElementById("email");
    const email = emailInput?.value?.trim();
    if (!email) {
      if (loginError) {
        loginError.textContent = "Enter your email above, then click Forgot password.";
        loginError.classList.remove("hidden");
      }
      return;
    }
    forgotPasswordLink.textContent = "Sending…";
    const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + "/login.html",
    });
    if (loginError) loginError.classList.add("hidden");
    if (error) {
      if (loginError) {
        loginError.textContent = error.message || "Failed to send reset email.";
        loginError.classList.remove("hidden");
      }
      forgotPasswordLink.textContent = "Forgot password?";
      return;
    }
    forgotPasswordLink.textContent = "Check your email for reset link.";
    setTimeout(() => {
      forgotPasswordLink.textContent = "Forgot password?";
    }, 5000);
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


function initNavToggle() {
  const toggle = document.querySelector(".topbar .nav-toggle");
  const nav = document.querySelector(".topbar .nav-wrap.collapsible");
  if (!toggle || !nav) return;
  toggle.addEventListener("click", () => {
    const open = nav.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", String(open));
  });

  /* Mobile: tap group label to expand/collapse that group (accordion) */
  nav.querySelectorAll(".nav-group-label").forEach((label) => {
    label.addEventListener("click", (e) => {
      const block = label.closest(".nav-group-block");
      if (!block) return;
      const isOpen = block.classList.toggle("is-open");
      label.setAttribute("aria-expanded", String(isOpen));
    });
    label.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      const block = label.closest(".nav-group-block");
      if (!block) return;
      const isOpen = block.classList.toggle("is-open");
      label.setAttribute("aria-expanded", String(isOpen));
    });
  });
}

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

  // Resolve role and display_name from users table + JWT fallback
  const auth = await resolveAuthForSession(session);
  const role = auth.role;
  const display_name = auth.display_name;

  // Server-side verification (if pageName provided)
  if (pageName) {
    const accessCheck = await verifyPageAccess(pageName);
    if (accessCheck && !accessCheck.allowed) {
      if (Array.isArray(allowedRoles) && allowedRoles.length > 0 && !allowedRoles.includes(role)) {
        console.warn(`Access denied to ${pageName} for role: ${accessCheck.role}`);
        window.location.href = onDenied;
        return null;
      }
      return { session, role, display_name };
    }
    if (accessCheck?.role) {
      return { session, role: accessCheck.role, display_name };
    }
  }

  if (Array.isArray(allowedRoles) && allowedRoles.length > 0) {
    if (!allowedRoles.includes(role)) {
      window.location.href = onDenied;
      return null;
    }
  }

  return { session, role, display_name };
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
  if (role === "admin") {
    document.body.classList.add("role-admin");
    document.querySelectorAll("[data-role='admin-only']").forEach((el) => {
      el.style.display = "";
    });
  } else {
    document.body.classList.remove("role-admin");
    document
      .querySelectorAll("[data-role='admin-only']")
      .forEach((el) => el.remove());
  }

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