/* global supabaseClient, requireAuth, applyRoleVisibility, formatCurrency, AppCache, AppError */

// Category labels: loaded from expense_categories; legacy fallbacks for old DB values
let CATEGORY_LABEL_MAP = {};
const LEGACY_CATEGORY_LABELS = {
  miscellanious: "Miscellaneous",
  mstest: "Miscellaneous",
  hsdtest: "Others",
};

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getCategoryLabel(value) {
  return CATEGORY_LABEL_MAP[value] || LEGACY_CATEGORY_LABELS[value] || value || "—";
}

// Pagination state
const PAGE_SIZE = 20;
let expensesPagination = {
  offset: 0,
  hasMore: true,
  totalCount: 0,
  isLoading: false,
};

document.addEventListener("DOMContentLoaded", async () => {
  const auth = await requireAuth({
    allowedRoles: ["admin", "supervisor"],
    onDenied: "dashboard.html",
  });
  if (!auth) return;
  applyRoleVisibility(auth.role);

  await loadAndFillCategorySelect();

  const form = document.getElementById("expense-form");
  const successEl = document.getElementById("expense-success");
  const errorEl = document.getElementById("expense-error");
  const dateInput = document.getElementById("expense-date");

  if (dateInput) {
    dateInput.value = new Date().toISOString().slice(0, 10);
  }

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
      const payload = {
        date: formData.get("date"),
        category: formData.get("category") || null,
        description: formData.get("description") || null,
        amount: Number(formData.get("amount") || 0),
      };

      if (auth.session?.user?.id) {
        payload.created_by = auth.session.user.id;
      }

      if (!payload.date) {
        if (errorEl) {
          errorEl.textContent = "Date is required.";
          errorEl.classList.remove("hidden");
        }
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = "Save expense";
        }
        return;
      }

      const { error } = await supabaseClient.from("expenses").insert(payload);

      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Save expense";
      }

      if (error) {
        AppError.handle(error, { target: errorEl });
        return;
      }

      form.reset();
      if (dateInput) {
        dateInput.value = new Date().toISOString().slice(0, 10);
      }
      successEl?.classList.remove("hidden");
      loadExpenses(true);
      // Invalidate cache so dashboard reflects new expense immediately
      if (typeof AppCache !== "undefined" && AppCache) {
        AppCache.invalidateByType("dashboard_data");
        AppCache.invalidateByType("recent_activity");
      }
    });
  }

  initExpenseFilter();
  initExpensesPaginationControls();
  loadExpenses(true);
});

async function loadAndFillCategorySelect() {
  const select = document.getElementById("expense-category");
  if (!select) return;

  const { data, error } = await supabaseClient
    .from("expense_categories")
    .select("name, label")
    .order("sort_order", { ascending: true })
    .order("label", { ascending: true });

  CATEGORY_LABEL_MAP = {};
  const categories = [];
  if (!error && data?.length) {
    data.forEach((row) => {
      CATEGORY_LABEL_MAP[row.name] = row.label;
      categories.push({ value: row.name, label: row.label });
    });
  }
  Object.assign(CATEGORY_LABEL_MAP, LEGACY_CATEGORY_LABELS);

  select.innerHTML = "";
  const optPlaceholder = document.createElement("option");
  optPlaceholder.value = "";
  optPlaceholder.textContent = "Select category";
  select.appendChild(optPlaceholder);
  categories.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.value;
    opt.textContent = c.label;
    select.appendChild(opt);
  });
}

function getExpenseDateRange() {
  const rangeSelect = document.getElementById("expense-range");
  const startInput = document.getElementById("expense-start");
  const endInput = document.getElementById("expense-end");
  const val = rangeSelect?.value || "this-month";
  const now = new Date();
  if (val === "this-week") {
    const diffToMonday = (now.getDay() + 6) % 7;
    const start = new Date(now);
    start.setDate(now.getDate() - diffToMonday);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }
  if (val === "custom" && startInput?.value && endInput?.value) {
    const s = startInput.value;
    const e = endInput.value;
    return { start: s < e ? s : e, end: s < e ? e : s };
  }
  const y = now.getFullYear();
  const m = now.getMonth();
  const start = new Date(y, m, 1);
  const end = new Date(y, m + 1, 0);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function initExpenseFilter() {
  const rangeSelect = document.getElementById("expense-range");
  const customRange = document.getElementById("expense-custom-range");
  const applyBtn = document.getElementById("expense-apply-filter");
  if (customRange && rangeSelect) {
    customRange.classList.toggle("hidden", rangeSelect.value !== "custom");
  }
  if (rangeSelect) {
    rangeSelect.addEventListener("change", () => {
      if (customRange) customRange.classList.toggle("hidden", rangeSelect.value !== "custom");
    });
  }
  if (applyBtn) {
    applyBtn.addEventListener("click", () => loadExpenses(true));
  }
}

/**
 * Initialize pagination controls for expenses table
 */
function initExpensesPaginationControls() {
  const tableSection = document.querySelector("section.card:has(#expense-table-body)");
  if (!tableSection) return;

  // Check if pagination controls already exist
  if (tableSection.querySelector(".pagination-controls")) return;

  // Create pagination controls container
  const paginationDiv = document.createElement("div");
  paginationDiv.className = "pagination-controls";
  paginationDiv.innerHTML = `
    <div class="pagination-info">
      <span id="expenses-pagination-info" class="muted"></span>
    </div>
    <button id="expenses-load-more" class="button-secondary hidden">Load more</button>
  `;
  tableSection.appendChild(paginationDiv);

  // Attach load more handler
  const loadMoreBtn = document.getElementById("expenses-load-more");
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener("click", () => loadExpenses(false));
  }
}

/**
 * Load expenses with pagination and optional date filter
 * @param {boolean} reset - If true, resets pagination and reloads for current filter
 */
async function loadExpenses(reset = false) {
  const tbody = document.getElementById("expense-table-body");
  const loadMoreBtn = document.getElementById("expenses-load-more");
  const paginationInfo = document.getElementById("expenses-pagination-info");
  const totalRow = document.getElementById("expense-total-row");
  const totalValue = document.getElementById("expense-total-value");
  const emptyCta = document.getElementById("expense-empty-cta");
  const tableEl = tbody?.closest("table");

  if (!tbody) return;
  if (expensesPagination.isLoading) return;
  expensesPagination.isLoading = true;

  const { start, end } = getExpenseDateRange();

  if (reset) {
    expensesPagination.offset = 0;
    expensesPagination.hasMore = true;
    expensesPagination.totalCount = 0;
    tbody.innerHTML = "<tr><td colspan='4' class='muted'>Loading…</td></tr>";
  }
  if (totalRow) totalRow.classList.add("hidden");
  if (emptyCta) emptyCta.classList.add("hidden");
  if (loadMoreBtn) {
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = "Loading…";
  }

  try {
    if (reset) {
      const { count, error: countError } = await supabaseClient
        .from("expenses")
        .select("*", { count: "exact", head: true })
        .gte("date", start)
        .lte("date", end);
      if (!countError) expensesPagination.totalCount = count || 0;
    }

    const { data, error } = await supabaseClient
      .from("expenses")
      .select("date, category, description, amount")
      .gte("date", start)
      .lte("date", end)
      .order("date", { ascending: false })
      .range(expensesPagination.offset, expensesPagination.offset + PAGE_SIZE - 1);

    if (error) {
      if (reset) {
        tbody.innerHTML = `<tr><td colspan='4' class='error'>${escapeHtml(AppError.getUserMessage(error))}</td></tr>`;
      }
      AppError.report(error, { context: "loadExpenses" });
      expensesPagination.isLoading = false;
      updateExpensesPaginationUI();
      return;
    }

    const fetchedCount = data?.length || 0;
    expensesPagination.offset += fetchedCount;
    expensesPagination.hasMore = fetchedCount === PAGE_SIZE;

    if (reset && !fetchedCount) {
      tbody.innerHTML = "";
      if (tableEl) tableEl.classList.add("hidden");
      if (emptyCta) {
        emptyCta.classList.remove("hidden");
        emptyCta.querySelector("p") && (emptyCta.querySelector("p").textContent = "No expenses recorded for this period.");
      }
      if (totalRow) totalRow.classList.add("hidden");
      expensesPagination.isLoading = false;
      updateExpensesPaginationUI();
      return;
    }

    if (reset) {
      tbody.innerHTML = "";
      if (tableEl) tableEl.classList.remove("hidden");
    }

    let periodTotal = 0;
    data.forEach((row) => {
      periodTotal += Number(row.amount ?? 0);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${row.date}</td>
        <td>${escapeHtml(getCategoryLabel(row.category))}</td>
        <td>${escapeHtml(row.description ?? "—")}</td>
        <td>${formatCurrency(row.amount)}</td>
      `;
      tbody.appendChild(tr);
    });

    if (reset && totalRow && totalValue) {
      const { data: sumData } = await supabaseClient
        .from("expenses")
        .select("amount")
        .gte("date", start)
        .lte("date", end);
      const total = (sumData || []).reduce((s, r) => s + Number(r.amount ?? 0), 0);
      totalValue.textContent = formatCurrency(total);
      totalRow.classList.remove("hidden");
    }

  } catch (err) {
    if (reset) {
      tbody.innerHTML = `<tr><td colspan="4" class="error">${escapeHtml(AppError.getUserMessage(err))}</td></tr>`;
    }
    AppError.report(err, { context: "loadExpenses" });
  } finally {
    expensesPagination.isLoading = false;
    updateExpensesPaginationUI();
  }
}

/**
 * Update pagination UI elements for expenses
 */
function updateExpensesPaginationUI() {
  const loadMoreBtn = document.getElementById("expenses-load-more");
  const paginationInfo = document.getElementById("expenses-pagination-info");
  
  // Update info text
  if (paginationInfo) {
    if (expensesPagination.totalCount > 0) {
      const showing = Math.min(expensesPagination.offset, expensesPagination.totalCount);
      paginationInfo.textContent = `Showing ${showing} of ${expensesPagination.totalCount} entries`;
    } else {
      paginationInfo.textContent = "";
    }
  }

  // Update load more button
  if (loadMoreBtn) {
    loadMoreBtn.disabled = false;
    loadMoreBtn.textContent = "Load more";
    
    if (expensesPagination.hasMore && expensesPagination.offset > 0) {
      loadMoreBtn.classList.remove("hidden");
    } else {
      loadMoreBtn.classList.add("hidden");
    }
  }
}
