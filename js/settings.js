/* global supabaseClient, requireAuth, applyRoleVisibility, AppCache, invalidateUserRoleCache, AppError */

// Simple HTML escape for XSS prevention
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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
      const submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Saving…";
      }
      successEl?.classList.add("hidden");
      errorEl?.classList.add("hidden");

      const formData = new FormData(form);
      const email = String(formData.get("email") || "").trim().toLowerCase();
      const role = formData.get("role");
      const password = String(formData.get("password") || "").trim();

      if (!email) {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Save role"; }
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
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Save role"; }
        AppError.handle(staffError, { target: errorEl });
        return;
      }

      if (!existingStaff && !password) {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Save role"; }
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
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Save role"; }
          AppError.handle(signupError, { target: errorEl });
          return;
        }
      }

      // Use secure server-side function for staff management
      // This validates admin role on the server regardless of client-side state
      const { data, error } = await supabaseClient.rpc("upsert_staff", {
        p_email: email,
        p_role: role,
      });

      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Save role";
      }
      if (error) {
        AppError.handle(error, { target: errorEl });
        return;
      }

      form.reset();
      successEl?.classList.remove("hidden");
      
      // Invalidate cached role for updated user
      if (typeof invalidateUserRoleCache === "function") {
        invalidateUserRoleCache(email);
      }
      // Invalidate staff list cache
      if (typeof AppCache !== "undefined" && AppCache) {
        AppCache.invalidateByType("staff_list");
      }
      
      loadStaffList();
    });
  }

  loadStaffList();
  initLowStockForm();
  initAlertsForm();
  initExpenseCategories();
});

function slugifyCategoryName(label) {
  return String(label || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 60) || "miscellaneous";
}

function initExpenseCategories() {
  loadExpenseCategories();

  const addForm = document.getElementById("expense-category-add-form");
  const labelInput = document.getElementById("expense-category-label");
  const addError = document.getElementById("expense-category-add-error");
  const addSuccess = document.getElementById("expense-category-add-success");

  if (addForm && labelInput) {
    addForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const submitBtn = addForm.querySelector('button[type="submit"]');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Saving…";
      }
      addError?.classList.add("hidden");
      addSuccess?.classList.add("hidden");

      const label = String(labelInput.value || "").trim();
      if (!label) {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Add category"; }
        if (addError) {
          addError.textContent = "Enter a category name.";
          addError.classList.remove("hidden");
        }
        return;
      }

      const name = slugifyCategoryName(label);
      const { error } = await supabaseClient.from("expense_categories").insert({
        name,
        label: label.slice(0, 80),
        sort_order: 999,
      });

      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Add category";
      }
      if (error) {
        if (error.code === "23505") {
          if (addError) {
            addError.textContent = "A category with this name already exists.";
            addError.classList.remove("hidden");
          }
        } else {
          AppError.handle(error, { target: addError });
        }
        return;
      }

      addForm.reset();
      addSuccess?.classList.remove("hidden");
      loadExpenseCategories();
    });
  }
}

async function loadExpenseCategories() {
  const tbody = document.getElementById("settings-expense-categories");
  if (!tbody) return;

  const { data, error } = await supabaseClient
    .from("expense_categories")
    .select("id, name, label")
    .order("sort_order", { ascending: true })
    .order("label", { ascending: true });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="2" class="error">${escapeHtml(AppError.getUserMessage(error))}</td></tr>`;
    AppError.report(error, { context: "loadExpenseCategories" });
    return;
  }

  if (!data?.length) {
    tbody.innerHTML = "<tr><td colspan=\"2\" class=\"muted\">No categories. Add one above.</td></tr>";
    return;
  }

  tbody.innerHTML = "";
  data.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(row.label)}</td>
      <td>
        <button type="button" class="button-secondary delete-expense-category" data-id="${escapeHtml(row.id)}" data-name="${escapeHtml(row.name)}" data-label="${escapeHtml(row.label)}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll(".delete-expense-category").forEach((btn) => {
    btn.addEventListener("click", () => handleDeleteExpenseCategory(btn));
  });
}

async function handleDeleteExpenseCategory(btn) {
  const id = btn.dataset.id;
  const name = btn.dataset.name;
  const label = btn.dataset.label || name;
  if (!id || !name) return;
  if (!confirm(`Delete category "${label}"? This is only allowed if no expense uses this category.`)) return;

  const { count, error: countError } = await supabaseClient
    .from("expenses")
    .select("*", { count: "exact", head: true })
    .eq("category", name);

  if (!countError && count > 0) {
    alert(`Cannot delete: ${count} expense(s) use this category. Change their category first or leave the category as-is.`);
    return;
  }

  const { error } = await supabaseClient.from("expense_categories").delete().eq("id", id);

  if (error) {
    AppError.report(error, { context: "deleteExpenseCategory" });
    alert(AppError.getUserMessage(error));
    return;
  }

  loadExpenseCategories();
}

const LOW_STOCK_KEYS = { petrol: "petrolpump_low_stock_threshold_petrol", diesel: "petrolpump_low_stock_threshold_diesel" };
const ALERT_KEYS = {
  highCredit: "petrolpump_alert_high_credit",
  highVariation: "petrolpump_alert_high_variation",
  dayClosingReminder: "petrolpump_alert_day_closing_reminder",
};
const DEFAULT_LOW_STOCK = 5000;

function initLowStockForm() {
  const form = document.getElementById("low-stock-form");
  const petrolInput = document.getElementById("low-stock-petrol");
  const dieselInput = document.getElementById("low-stock-diesel");
  const successEl = document.getElementById("low-stock-success");
  if (!form || !petrolInput || !dieselInput) return;
  try {
    const p = localStorage.getItem(LOW_STOCK_KEYS.petrol);
    const d = localStorage.getItem(LOW_STOCK_KEYS.diesel);
    if (p != null && p !== "") petrolInput.value = Number(p) || DEFAULT_LOW_STOCK;
    else petrolInput.placeholder = String(DEFAULT_LOW_STOCK);
    if (d != null && d !== "") dieselInput.value = Number(d) || DEFAULT_LOW_STOCK;
    else dieselInput.placeholder = String(DEFAULT_LOW_STOCK);
  } catch (_) {}
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    successEl?.classList.add("hidden");
    const petrol = Number(petrolInput.value);
    const diesel = Number(dieselInput.value);
    try {
      if (Number.isFinite(petrol) && petrol >= 0) localStorage.setItem(LOW_STOCK_KEYS.petrol, String(petrol));
      if (Number.isFinite(diesel) && diesel >= 0) localStorage.setItem(LOW_STOCK_KEYS.diesel, String(diesel));
      successEl?.classList.remove("hidden");
    } catch (_) {}
  });
}

function initAlertsForm() {
  const form = document.getElementById("alerts-form");
  const highCreditInput = document.getElementById("alert-high-credit");
  const highVariationInput = document.getElementById("alert-high-variation");
  const dayClosingCheck = document.getElementById("alert-day-closing");
  const successEl = document.getElementById("alerts-success");
  if (!form || !highCreditInput || !highVariationInput || !dayClosingCheck) return;
  try {
    const hc = localStorage.getItem(ALERT_KEYS.highCredit);
    const hv = localStorage.getItem(ALERT_KEYS.highVariation);
    const dc = localStorage.getItem(ALERT_KEYS.dayClosingReminder);
    if (hc != null && hc !== "") highCreditInput.value = Number(hc) || "";
    if (hv != null && hv !== "") highVariationInput.value = Number(hv) || "";
    dayClosingCheck.checked = dc !== "false";
  } catch (_) {}
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    successEl?.classList.add("hidden");
    const highCredit = Number(highCreditInput.value);
    const highVariation = Number(highVariationInput.value);
    try {
      if (Number.isFinite(highCredit) && highCredit >= 0) localStorage.setItem(ALERT_KEYS.highCredit, String(highCredit));
      else localStorage.removeItem(ALERT_KEYS.highCredit);
      if (Number.isFinite(highVariation) && highVariation >= 0) localStorage.setItem(ALERT_KEYS.highVariation, String(highVariation));
      else localStorage.removeItem(ALERT_KEYS.highVariation);
      localStorage.setItem(ALERT_KEYS.dayClosingReminder, dayClosingCheck.checked ? "true" : "false");
      successEl?.classList.remove("hidden");
    } catch (_) {}
  });
}

async function loadStaffList() {
  const tbody = document.getElementById("settings-table-body");
  if (!tbody) return;
  tbody.innerHTML = "<tr><td colspan='3' class='muted'>Loading…</td></tr>";

  const { data, error } = await supabaseClient
    .from("staff")
    .select("email, role, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    tbody.innerHTML = `<tr><td colspan='3' class='error'>${escapeHtml(AppError.getUserMessage(error))}</td></tr>`;
    AppError.report(error, { context: "loadStaffList" });
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
      <td>${escapeHtml(row.email)}</td>
      <td>${escapeHtml(row.role)}</td>
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
