/* global supabaseClient, requireAuth, applyRoleVisibility, AppCache, invalidateUserRoleCache, AppError, formatCurrency */

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

      const { data: existingUser, error: userError } = await supabaseClient
        .from("users")
        .select("id")
        .eq("email", email)
        .maybeSingle();

      if (userError) {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Save role"; }
        AppError.handle(userError, { target: errorEl });
        return;
      }

      if (!existingUser && !password) {
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

      const displayName = formData.get("display_name")?.trim() || null;
      const { data, error } = await supabaseClient.rpc("upsert_staff", {
        p_email: email,
        p_role: role,
        p_display_name: displayName || null,
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
      invalidateEmployeeListCache();
      loadStaffList();
    });
  }

  loadStaffList();
  initManageEmployees(auth);
  initShiftsForm();
  initLowStockForm();
  initAlertsForm();
  initExpenseCategories();
});

function initShiftsForm() {
  const form = document.getElementById("shifts-form");
  const successEl = document.getElementById("shifts-success");
  const fields = {
    morningName: document.getElementById("shift-morning-name"),
    morningStart: document.getElementById("shift-morning-start"),
    morningEnd: document.getElementById("shift-morning-end"),
    afternoonName: document.getElementById("shift-afternoon-name"),
    afternoonStart: document.getElementById("shift-afternoon-start"),
    afternoonEnd: document.getElementById("shift-afternoon-end"),
  };
  if (!form || !fields.morningName) return;
  try {
    fields.morningName.value = localStorage.getItem(SHIFT_KEYS.morningName) ?? DEFAULT_SHIFTS.morningName;
    fields.morningStart.value = localStorage.getItem(SHIFT_KEYS.morningStart) ?? DEFAULT_SHIFTS.morningStart;
    fields.morningEnd.value = localStorage.getItem(SHIFT_KEYS.morningEnd) ?? DEFAULT_SHIFTS.morningEnd;
    fields.afternoonName.value = localStorage.getItem(SHIFT_KEYS.afternoonName) ?? DEFAULT_SHIFTS.afternoonName;
    fields.afternoonStart.value = localStorage.getItem(SHIFT_KEYS.afternoonStart) ?? DEFAULT_SHIFTS.afternoonStart;
    fields.afternoonEnd.value = localStorage.getItem(SHIFT_KEYS.afternoonEnd) ?? DEFAULT_SHIFTS.afternoonEnd;
  } catch (_) {}
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    successEl?.classList.add("hidden");
    try {
      const morningName = (fields.morningName.value || "").trim() || DEFAULT_SHIFTS.morningName;
      const morningStart = fields.morningStart.value || DEFAULT_SHIFTS.morningStart;
      const morningEnd = fields.morningEnd.value || DEFAULT_SHIFTS.morningEnd;
      const afternoonName = (fields.afternoonName.value || "").trim() || DEFAULT_SHIFTS.afternoonName;
      const afternoonStart = fields.afternoonStart.value || DEFAULT_SHIFTS.afternoonStart;
      const afternoonEnd = fields.afternoonEnd.value || DEFAULT_SHIFTS.afternoonEnd;
      localStorage.setItem(SHIFT_KEYS.morningName, morningName);
      localStorage.setItem(SHIFT_KEYS.morningStart, morningStart);
      localStorage.setItem(SHIFT_KEYS.morningEnd, morningEnd);
      localStorage.setItem(SHIFT_KEYS.afternoonName, afternoonName);
      localStorage.setItem(SHIFT_KEYS.afternoonStart, afternoonStart);
      localStorage.setItem(SHIFT_KEYS.afternoonEnd, afternoonEnd);
      successEl?.classList.remove("hidden");
    } catch (_) {}
  });
}

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

const SHIFT_KEYS = {
  morningName: "petrolpump_shift_morning_name",
  morningStart: "petrolpump_shift_morning_start",
  morningEnd: "petrolpump_shift_morning_end",
  afternoonName: "petrolpump_shift_afternoon_name",
  afternoonStart: "petrolpump_shift_afternoon_start",
  afternoonEnd: "petrolpump_shift_afternoon_end",
};
const DEFAULT_SHIFTS = {
  morningName: "Morning shift",
  morningStart: "06:00",
  morningEnd: "14:00",
  afternoonName: "Afternoon shift",
  afternoonStart: "14:00",
  afternoonEnd: "22:00",
};

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

function invalidateEmployeeListCache() {
  if (typeof AppCache !== "undefined" && AppCache) {
    AppCache.invalidateByType("staff_list");
  }
}

/**
 * CRUD for `employees` (salary / attendance roster). Settings is admin-only.
 */
function initManageEmployees(auth) {
  const staffMemberForm = document.getElementById("emp-member-form");
  const staffFormSuccess = document.getElementById("emp-form-success");
  const staffFormError = document.getElementById("emp-form-error");
  const staffSubmitBtn = document.getElementById("emp-submit-btn");
  const staffCancelBtn = document.getElementById("emp-cancel-btn");
  const membersTbody = document.getElementById("emp-members-body");
  const idInput = document.getElementById("emp-member-id");
  const nameInput = document.getElementById("emp-name");
  const roleInput = document.getElementById("emp-job-role");
  const salaryInput = document.getElementById("emp-monthly-salary");
  if (!staffMemberForm || !membersTbody) return;

  let staffList = [];
  let staffListLoadError = null;

  async function loadStaffMembers() {
    const { data, error } = await supabaseClient
      .from("employees")
      .select("id, name, role_display, monthly_salary, display_order")
      .eq("is_active", true)
      .order("display_order", { ascending: true })
      .order("name", { ascending: true });

    if (error) {
      staffListLoadError = error;
      staffList = [];
      AppError.report(error, { context: "loadStaffMembers" });
      return [];
    }
    staffListLoadError = null;
    staffList = data ?? [];
    return staffList;
  }

  async function refreshMemberTable() {
    await loadStaffMembers();
    renderStaffMembersTable();
  }

  async function afterDeleteSuccess(message) {
    invalidateEmployeeListCache();
    if (staffFormSuccess) {
      staffFormSuccess.textContent = message;
      staffFormSuccess.classList.remove("hidden");
    }
    await refreshMemberTable();
  }

  function applyEditToForm(id, name, role, salary) {
    if (idInput) idInput.value = id;
    if (nameInput) nameInput.value = name;
    if (roleInput) roleInput.value = role;
    if (salaryInput) salaryInput.value = salary;
    if (staffSubmitBtn) staffSubmitBtn.textContent = "Update";
    if (staffCancelBtn) staffCancelBtn.classList.remove("hidden");
  }

  function renderStaffMembersTable() {
    if (staffListLoadError) {
      membersTbody.innerHTML = `<tr><td colspan="4" class="error">${escapeHtml(AppError.getUserMessage(staffListLoadError))}</td></tr>`;
      return;
    }

    if (!staffList.length) {
      membersTbody.innerHTML = "<tr><td colspan=\"4\" class=\"muted\">No staff yet. Add people using the form above.</td></tr>";
      return;
    }

    membersTbody.innerHTML = staffList
      .map(
        (s) => `
        <tr>
          <td>${escapeHtml(s.name)}</td>
          <td>${escapeHtml(s.role_display ?? "—")}</td>
          <td>${formatCurrency(s.monthly_salary)}</td>
          <td>
            <button type="button" class="edit-emp-staff-btn button-secondary" data-id="${escapeHtml(s.id)}" data-name="${escapeHtml(s.name)}" data-role="${escapeHtml(s.role_display ?? "")}" data-salary="${escapeHtml(String(s.monthly_salary ?? 0))}">Edit</button><button type="button" class="delete-emp-staff-btn button-secondary" data-id="${escapeHtml(s.id)}" data-name="${escapeHtml(s.name)}" style="margin-left:0.35rem">Delete</button>
          </td>
        </tr>
      `
      )
      .join("");
  }

  membersTbody.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const delBtn = t.closest(".delete-emp-staff-btn");
    if (delBtn) {
      e.preventDefault();
      const id = delBtn.getAttribute("data-id");
      const name = delBtn.getAttribute("data-name");
      if (id) void handleDeleteEmployee(id, name || "this person");
      return;
    }
    const editBtn = t.closest(".edit-emp-staff-btn");
    if (editBtn) {
      e.preventDefault();
      applyEditToForm(
        editBtn.getAttribute("data-id") || "",
        editBtn.getAttribute("data-name") || "",
        editBtn.getAttribute("data-role") || "",
        editBtn.getAttribute("data-salary") || ""
      );
    }
  });

  async function handleDeleteEmployee(id, name) {
    if (!window.confirm(`Remove ${name} from the active staff list?`)) return;
    staffFormError?.classList.add("hidden");
    staffFormSuccess?.classList.add("hidden");
    const { error: delErr } = await supabaseClient.from("employees").delete().eq("id", id);
    if (!delErr) {
      await afterDeleteSuccess("Staff member removed.");
      return;
    }
    const msg = (delErr.message || "").toLowerCase();
    const isFk = delErr.code === "23503" || msg.includes("foreign key") || msg.includes("constraint");
    if (isFk) {
      const { error: upErr } = await supabaseClient
        .from("employees")
        .update({ is_active: false })
        .eq("id", id);
      if (upErr) {
        AppError.handle(upErr, { target: staffFormError });
        return;
      }
      await afterDeleteSuccess(
        "Staff member removed from the list (kept in the system because of past salary or attendance)."
      );
      return;
    }
    AppError.handle(delErr, { target: staffFormError });
  }

  staffMemberForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (staffSubmitBtn) {
      staffSubmitBtn.disabled = true;
      staffSubmitBtn.textContent = "Saving…";
    }
    staffFormSuccess?.classList.add("hidden");
    staffFormError?.classList.add("hidden");

    const id = idInput?.value?.trim() || null;
    const name = nameInput?.value?.trim();
    const roleDisplay = roleInput?.value?.trim() || null;
    const monthlySalary = Number(salaryInput?.value || 0);

    if (!name) {
      if (staffSubmitBtn) {
        staffSubmitBtn.disabled = false;
        staffSubmitBtn.textContent = staffCancelBtn?.classList.contains("hidden") ? "Add staff" : "Update";
      }
      staffFormError?.classList.remove("hidden");
      if (staffFormError) staffFormError.textContent = "Name is required.";
      return;
    }

    const payload = {
      name: name,
      role_display: roleDisplay,
      monthly_salary: monthlySalary,
    };
    if (auth.session?.user?.id) payload.created_by = auth.session.user.id;

    if (id) {
      const { error } = await supabaseClient.from("employees").update(payload).eq("id", id);
      if (staffSubmitBtn) { staffSubmitBtn.disabled = false; staffSubmitBtn.textContent = staffCancelBtn?.classList.contains("hidden") ? "Add staff" : "Update"; }
      if (error) {
        AppError.handle(error, { target: staffFormError });
        return;
      }
    } else {
      const { error } = await supabaseClient.from("employees").insert(payload);
      if (staffSubmitBtn) { staffSubmitBtn.disabled = false; staffSubmitBtn.textContent = "Add staff"; }
      if (error) {
        AppError.handle(error, { target: staffFormError });
        return;
      }
    }

    staffMemberForm.reset();
    if (idInput) idInput.value = "";
    invalidateEmployeeListCache();
    if (staffSubmitBtn) {
      staffSubmitBtn.disabled = false;
      staffSubmitBtn.textContent = "Add staff";
    }
    if (staffCancelBtn) staffCancelBtn.classList.add("hidden");
    staffFormSuccess?.classList.remove("hidden");
    await refreshMemberTable();
  });

  if (staffCancelBtn) {
    staffCancelBtn.addEventListener("click", () => {
      staffMemberForm.reset();
      if (idInput) idInput.value = "";
      if (staffSubmitBtn) staffSubmitBtn.textContent = "Add staff";
      staffCancelBtn.classList.add("hidden");
    });
  }

  void refreshMemberTable();
}

async function loadStaffList() {
  const tbody = document.getElementById("settings-table-body");
  if (!tbody) return;
  tbody.innerHTML = "<tr><td colspan='4' class='muted'>Loading…</td></tr>";

  const { data, error } = await supabaseClient
    .from("users")
    .select("email, display_name, role, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    tbody.innerHTML = `<tr><td colspan='4' class='error'>${escapeHtml(AppError.getUserMessage(error))}</td></tr>`;
    AppError.report(error, { context: "loadStaffList" });
    return;
  }

  if (!data?.length) {
    tbody.innerHTML = "<tr><td colspan='4' class='muted'>No users yet.</td></tr>";
    return;
  }

  tbody.innerHTML = "";
  data.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(row.email)}</td>
      <td>${escapeHtml(row.display_name ?? "—")}</td>
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
