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

    const role = extractRole(data?.user ?? data?.session);
    window.location.href = resolveLanding(role);
  });
}

if (logoutButton) {
  logoutButton.addEventListener("click", async () => {
    await supabaseClient.auth.signOut();
    window.location.href = "index.html";
  });
}

/**
 * Redirects to the login page if there is no active Supabase session.
 * Supports optional role-based gating.
 *
 * @param {Object} options
 * @param {string[]} [options.allowedRoles]
 * @param {string} [options.redirectTo] - Where to send unauthenticated users.
 * @param {string} [options.onDenied] - Where to send authenticated users without the required role.
 */
async function requireAuth(options = {}) {
  const {
    allowedRoles = null,
    redirectTo = "index.html",
    onDenied = "credit.html",
  } = options;

  const {
    data: { session },
  } = await supabaseClient.auth.getSession();

  if (!session) {
    window.location.href = redirectTo;
    return null;
  }

  const role = extractRole(session);

  if (Array.isArray(allowedRoles) && allowedRoles.length > 0) {
    if (!allowedRoles.includes(role)) {
      window.location.href = onDenied;
      return null;
    }
  }

  return { session, role };
}

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
