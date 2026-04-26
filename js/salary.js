/* global requireAuth, applyRoleVisibility, supabaseClient, formatCurrency, AppCache, AppError */

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getMonthStartEnd(year, month) {
  const m = month - 1;
  const start = new Date(year, m, 1);
  const end = new Date(year, m + 1, 0);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

document.addEventListener("DOMContentLoaded", async () => {
  const auth = await requireAuth({
    allowedRoles: ["admin", "supervisor"],
    onDenied: "dashboard.html",
    pageName: "salary",
  });
  if (!auth) return;
  applyRoleVisibility(auth.role);

  const paymentForm = document.getElementById("salary-payment-form");
  const paymentSuccess = document.getElementById("salary-payment-success");
  const paymentError = document.getElementById("salary-payment-error");
  const paymentStaffSelect = document.getElementById("payment-staff");
  const paymentDateInput = document.getElementById("payment-date");
  const salaryMonthInput = document.getElementById("salary-month");

  if (paymentDateInput) {
    paymentDateInput.value = new Date().toISOString().slice(0, 10);
  }

  const now = new Date();
  if (salaryMonthInput) {
    salaryMonthInput.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }

  let staffList = [];

  async function loadStaffMembers() {
    const { data, error } = await supabaseClient
      .from("employees")
      .select("id, name, role_display, monthly_salary, display_order")
      .eq("is_active", true)
      .order("display_order", { ascending: true })
      .order("name", { ascending: true });

    if (error) {
      AppError.report(error, { context: "loadStaffMembers" });
      return [];
    }
    staffList = data ?? [];
    return staffList;
  }

  function fillStaffSelect(selectEl, includeEmpty = true) {
    if (!selectEl) return;
    const current = selectEl.value;
    selectEl.innerHTML = includeEmpty ? "<option value=\"\">Select staff</option>" : "";
    staffList.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = `${s.name}${s.role_display ? ` (${s.role_display})` : ""}`;
      selectEl.appendChild(opt);
    });
    if (current && staffList.some((s) => s.id === current)) {
      selectEl.value = current;
    }
  }

  async function loadPaymentsInRange(startDate, endDate) {
    const { data, error } = await supabaseClient
      .from("salary_payments")
      .select("id, employee_id, date, amount, note")
      .gte("date", startDate)
      .lte("date", endDate)
      .order("date", { ascending: false });

    if (error) {
      AppError.report(error, { context: "loadPaymentsInRange" });
      return [];
    }
    return data ?? [];
  }

  function paidByStaffInRange(payments) {
    const byStaff = new Map();
    (payments || []).forEach((p) => {
      const id = p.employee_id;
      const prev = byStaff.get(id) || 0;
      byStaff.set(id, prev + Number(p.amount ?? 0));
    });
    return byStaff;
  }

  async function renderSummary(monthValue) {
    const tbody = document.getElementById("salary-summary-body");
    if (!tbody) return;

    if (!staffList.length) {
      tbody.innerHTML = "<tr><td colspan=\"6\" class=\"muted\">Add staff in <a href=\"settings.html#manage-staff-section\">Settings → Manage staff (HR)</a> first (admin).</td></tr>";
      return;
    }

    const [year, month] = monthValue.split("-").map(Number);
    const { start, end } = getMonthStartEnd(year, month);
    const payments = await loadPaymentsInRange(start, end);
    const paidMap = paidByStaffInRange(payments);

    tbody.innerHTML = staffList
      .map((s) => {
        const paid = paidMap.get(s.id) || 0;
        const pending = Math.max(0, Number(s.monthly_salary ?? 0) - paid);
        const name = escapeHtml(s.name);
        const role = escapeHtml(s.role_display ?? "—");
        return `
          <tr>
            <td>${name}</td>
            <td>${role}</td>
            <td>${formatCurrency(s.monthly_salary)}</td>
            <td>${formatCurrency(paid)}</td>
            <td>${formatCurrency(pending)}</td>
            <td>
              <button type="button" class="add-payment-btn button-secondary" data-staff-id="${escapeHtml(s.id)}" data-staff-name="${escapeHtml(s.name)}">
                Add payment
              </button>
            </td>
          </tr>
        `;
      })
      .join("");

    tbody.querySelectorAll(".add-payment-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-staff-id");
        if (paymentStaffSelect) paymentStaffSelect.value = id;
        if (paymentDateInput) paymentDateInput.value = new Date().toISOString().slice(0, 10);
        paymentForm?.scrollIntoView({ behavior: "smooth" });
      });
    });
  }

  async function loadRecentPayments() {
    const tbody = document.getElementById("salary-payments-body");
    if (!tbody) return;

    const { data, error } = await supabaseClient
      .from("salary_payments")
      .select("id, employee_id, date, amount, note")
      .order("date", { ascending: false })
      .limit(50);

    if (error) {
      tbody.innerHTML = `<tr><td colspan="4" class="error">${escapeHtml(AppError.getUserMessage(error))}</td></tr>`;
      AppError.report(error, { context: "loadRecentPayments" });
      return;
    }

    const list = data ?? [];
    const staffById = new Map(staffList.map((s) => [s.id, s]));

    if (!list.length) {
      tbody.innerHTML = "<tr><td colspan=\"4\" class=\"muted\">No payments yet.</td></tr>";
      return;
    }

    tbody.innerHTML = list
      .map((p) => {
        const staff = staffById.get(p.employee_id);
        const name = staff ? escapeHtml(staff.name) : "—";
        return `
          <tr>
            <td>${escapeHtml(p.date)}</td>
            <td>${name}</td>
            <td>${formatCurrency(p.amount)}</td>
            <td>${escapeHtml(p.note ?? "—")}</td>
          </tr>
        `;
      })
      .join("");
  }

  async function refreshAll() {
    await loadStaffMembers();
    fillStaffSelect(paymentStaffSelect);
    const monthVal = salaryMonthInput?.value;
    if (monthVal) await renderSummary(monthVal);
    await loadRecentPayments();
  }

  if (paymentForm) {
    paymentForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const submitBtn = paymentForm.querySelector('button[type="submit"]');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Saving…";
      }
      paymentSuccess?.classList.add("hidden");
      paymentError?.classList.add("hidden");

      const staffId = document.getElementById("payment-staff")?.value;
      const date = document.getElementById("payment-date")?.value;
      const amount = Number(document.getElementById("payment-amount")?.value || 0);
      const note = document.getElementById("payment-note")?.value?.trim() || null;

      if (!staffId) {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Save payment"; }
        paymentError?.classList.remove("hidden");
        if (paymentError) paymentError.textContent = "Select a staff member.";
        return;
      }
      if (amount <= 0) {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Save payment"; }
        paymentError?.classList.remove("hidden");
        if (paymentError) paymentError.textContent = "Amount must be greater than 0.";
        return;
      }

      const payload = {
        employee_id: staffId,
        date: date,
        amount: amount,
        note: note,
      };
      if (auth.session?.user?.id) payload.created_by = auth.session.user.id;

      const { error } = await supabaseClient.from("salary_payments").insert(payload);

      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Save payment";
      }
      if (error) {
        AppError.handle(error, { target: paymentError });
        return;
      }

      const staff = staffList.find((s) => s.id === staffId);
      const desc = staff ? `Salary: ${staff.name}${note ? ` - ${note}` : ""}` : "Salary";
      const expensePayload = {
        date: date,
        category: "salary",
        description: desc,
        amount: amount,
      };
      if (auth.session?.user?.id) expensePayload.created_by = auth.session.user.id;
      await supabaseClient.from("expenses").insert(expensePayload);

      paymentForm.reset();
      paymentDateInput.value = new Date().toISOString().slice(0, 10);
      fillStaffSelect(paymentStaffSelect);
      paymentSuccess?.classList.remove("hidden");
      await refreshAll();
      // Invalidate cache so dashboard reflects new expense (salary) immediately
      if (typeof AppCache !== "undefined" && AppCache) {
        AppCache.invalidateByType("dashboard_data");
        AppCache.invalidateByType("recent_activity");
      }
    });
  }

  if (salaryMonthInput) {
    salaryMonthInput.addEventListener("change", async () => {
      const val = salaryMonthInput.value;
      if (val) await renderSummary(val);
    });
  }

  const downloadCsvBtn = document.getElementById("salary-download-csv");
  if (downloadCsvBtn) {
    downloadCsvBtn.addEventListener("click", async () => {
      const monthVal = salaryMonthInput?.value;
      if (!monthVal) {
        return;
      }
      await loadStaffMembers();
      const [year, month] = monthVal.split("-").map(Number);
      const { start, end } = getMonthStartEnd(year, month);
      const payments = await loadPaymentsInRange(start, end);
      const paidMap = paidByStaffInRange(payments);
      const headers = ["Name", "Role", "Monthly salary (₹)", "Paid this month (₹)", "Pending (₹)"];
      const rows = staffList.map((s) => {
        const paid = paidMap.get(s.id) || 0;
        const pending = Math.max(0, Number(s.monthly_salary ?? 0) - paid);
        return [
          String(s.name ?? "").replace(/"/g, '""'),
          String(s.role_display ?? "").replace(/"/g, '""'),
          String(s.monthly_salary ?? 0),
          String(paid),
          String(pending),
        ];
      });
      const csv = [headers.join(","), ...rows.map((r) => r.map((c) => `"${c}"`).join(","))].join("\n");
      const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `salary-summary-${monthVal}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }

  await refreshAll();
});
