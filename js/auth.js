/* global supabaseClient */

const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const loginButton = document.getElementById("login-button");
const logoutButton = document.getElementById("logout-button");

const DEFAULT_ROLE = "admin";
const LANDING_BY_ROLE = {
  admin: "dashboard.html",
  supervisor: "credit.html",
};

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

async function fetchRoleFromStaff(email) {
  if (!email) return null;
  const { data, error } = await supabaseClient
    .from("staff")
    .select("role")
    .eq("email", email)
    .maybeSingle();
  if (error) {
    console.error(error);
    return null;
  }
  return data?.role ?? null;
}

async function resolveRoleForSession(session) {
  if (!session) return DEFAULT_ROLE;
  const email = session.user?.email;
  const staffRole = await fetchRoleFromStaff(email);
  return staffRole ?? extractRole(session);
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
      if (loginError) {
        loginError.textContent = error.message;
        loginError.classList.remove("hidden");
      }
      return;
    }

    const role = await resolveRoleForSession(data?.session ?? data?.user);
    window.location.href = resolveLanding(role);
  });
}

if (logoutButton) {
  logoutButton.addEventListener("click", async () => {
    await supabaseClient.auth.signOut();
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
      console.error("Page access check failed:", error);
      return null;
    }
    return data;
  } catch (err) {
    console.error("Page access verification error:", err);
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

  // Server-side verification (if pageName provided)
  // This provides defense-in-depth - even if client-side is bypassed,
  // the server validates access before any sensitive operations
  if (pageName) {
    const accessCheck = await verifyPageAccess(pageName);
    if (accessCheck && !accessCheck.allowed) {
      console.warn(`Access denied to ${pageName} for role: ${accessCheck.role}`);
      window.location.href = onDenied;
      return null;
    }
    // Use server-verified role if available
    if (accessCheck?.role) {
      return { session, role: accessCheck.role };
    }
  }

  const role = await resolveRoleForSession(session);

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