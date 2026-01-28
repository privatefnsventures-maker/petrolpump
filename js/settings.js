/* global supabaseClient, requireAuth, applyRoleVisibility */

document.addEventListener("DOMContentLoaded", async () => {
  // Server-side role verification via check_page_access() function
  // Even if user bypasses client-side checks, RLS policies block unauthorized access
  const auth = await requireAuth({
    allowedRoles: ["admin"],
    onDenied: "dashboard.html",
    pageName: "settings", // Triggers server-side access verification
  });
  if (!auth) return;
  applyRoleVisibility(auth.role);

  const form = document.getElementById("settings-form");
  const successEl = document.getElementById("settings-success");
  const errorEl = document.getElementById("settings-error");

  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      successEl?.classList.add("hidden");
      errorEl?.classList.add("hidden");

      const formData = new FormData(form);
      const email = String(formData.get("email") || "").trim().toLowerCase();
      const role = formData.get("role");
      const password = String(formData.get("password") || "").trim();

      if (!email) {
        if (errorEl) {
          errorEl.textContent = "Email is required.";
          errorEl.classList.remove("hidden");
        }
        return;
      }

      const { data: existingStaff, error: staffError } = await supabaseClient
        .from("staff")
        .select("id")
        .eq("email", email)
        .maybeSingle();

      if (staffError) {
        if (errorEl) {
          errorEl.textContent = staffError.message;
          errorEl.classList.remove("hidden");
        }
        return;
      }

      if (!existingStaff && !password) {
        if (errorEl) {
          errorEl.textContent =
            "Password is required to create a new login.";
          errorEl.classList.remove("hidden");
        }
        return;
      }

      if (password) {
        const { error: signupError } = await supabaseClient.auth.signUp({
          email,
          password,
        });
        if (signupError && !isExistingUserError(signupError)) {
          if (errorEl) {
            errorEl.textContent = signupError.message;
            errorEl.classList.remove("hidden");
          }
          return;
        }
      }

      // Use secure server-side function for staff management
      // This validates admin role on the server regardless of client-side state
      const { data, error } = await supabaseClient.rpc("upsert_staff", {
        p_email: email,
        p_role: role,
      });

      if (error) {
        if (errorEl) {
          // Show user-friendly error message
          const message = error.message.includes("Access denied")
            ? "You do not have permission to manage staff."
            : error.message;
          errorEl.textContent = message;
          errorEl.classList.remove("hidden");
        }
        return;
      }

      form.reset();
      successEl?.classList.remove("hidden");
      loadStaffList();
    });
  }

  loadStaffList();
});

async function loadStaffList() {
  const tbody = document.getElementById("settings-table-body");
  if (!tbody) return;
  tbody.innerHTML = "<tr><td colspan='3' class='muted'>Loading…</td></tr>";

  const { data, error } = await supabaseClient
    .from("staff")
    .select("email, role, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    tbody.innerHTML = `<tr><td colspan='3' class='error'>${error.message}</td></tr>`;
    return;
  }

  if (!data?.length) {
    tbody.innerHTML = "<tr><td colspan='3' class='muted'>No users yet.</td></tr>";
    return;
  }

  tbody.innerHTML = "";
  data.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.email}</td>
      <td>${row.role}</td>
      <td>${formatDate(row.created_at)}</td>
    `;
    tbody.appendChild(tr);
  });
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function isExistingUserError(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("already registered") || message.includes("already exists");
}
