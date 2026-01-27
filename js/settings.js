/* global supabaseClient, requireAuth, applyRoleVisibility */

document.addEventListener("DOMContentLoaded", async () => {
  const auth = await requireAuth({ allowedRoles: ["admin"], onDenied: "dashboard.html" });
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

      const { error } = await supabaseClient.from("staff").upsert(
        { email, role },
        { onConflict: "email" }
      );

      if (error) {
        if (errorEl) {
          errorEl.textContent = error.message;
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
