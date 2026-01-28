/* global supabaseClient, requireAuth, applyRoleVisibility, formatCurrency, AppError */

// Simple HTML escape for XSS prevention
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
      successEl?.classList.add("hidden");
      errorEl?.classList.add("hidden");

      const formData = new FormData(form);
      const payload = {
        date: formData.get("date"),
        category: formData.get("category") || null,
        description: formData.get("description") || null,
        amount: Number(formData.get("amount") || 0),
      };

      // Add created_by for RLS policy compliance
      if (auth.session?.user?.id) {
        payload.created_by = auth.session.user.id;
      }

      if (!payload.date) {
        if (errorEl) {
          errorEl.textContent = "Date is required.";
          errorEl.classList.remove("hidden");
        }
        return;
      }

      const { error } = await supabaseClient.from("expenses").insert(payload);

      if (error) {
        AppError.handle(error, { target: errorEl });
        return;
      }

      form.reset();
      if (dateInput) {
        dateInput.value = new Date().toISOString().slice(0, 10);
      }
      successEl?.classList.remove("hidden");
      loadExpenses(true); // Reset pagination to show new entry
    });
  }

  // Initialize pagination controls
  initExpensesPaginationControls();
  loadExpenses(true);
});

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
 * Load expenses with pagination support
 * @param {boolean} reset - If true, resets pagination and clears existing data
 */
async function loadExpenses(reset = false) {
  const tbody = document.getElementById("expense-table-body");
  const loadMoreBtn = document.getElementById("expenses-load-more");
  const paginationInfo = document.getElementById("expenses-pagination-info");
  
  if (!tbody) return;
  
  // Prevent duplicate requests
  if (expensesPagination.isLoading) return;
  expensesPagination.isLoading = true;

  // Reset pagination state if needed
  if (reset) {
    expensesPagination.offset = 0;
    expensesPagination.hasMore = true;
    expensesPagination.totalCount = 0;
    tbody.innerHTML = "<tr><td colspan='4' class='muted'>Loading…</td></tr>";
  }

  // Update button state
  if (loadMoreBtn) {
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = "Loading…";
  }

  try {
    // Fetch total count (only on reset/initial load)
    if (reset) {
      const { count, error: countError } = await supabaseClient
        .from("expenses")
        .select("*", { count: "exact", head: true });
      
      if (!countError) {
        expensesPagination.totalCount = count || 0;
      }
    }

    // Fetch data with pagination using range
    const { data, error } = await supabaseClient
      .from("expenses")
      .select("date, category, description, amount")
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

    // Update pagination state
    const fetchedCount = data?.length || 0;
    expensesPagination.offset += fetchedCount;
    expensesPagination.hasMore = fetchedCount === PAGE_SIZE;

    // Handle empty data
    if (reset && !fetchedCount) {
      tbody.innerHTML = "<tr><td colspan='4' class='muted'>No expenses yet.</td></tr>";
      expensesPagination.isLoading = false;
      updateExpensesPaginationUI();
      return;
    }

    // Clear loading message on initial load
    if (reset) {
      tbody.innerHTML = "";
    }

    // Append rows
    data.forEach((row) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${row.date}</td>
        <td>${escapeHtml(row.category ?? "—")}</td>
        <td>${escapeHtml(row.description ?? "—")}</td>
        <td>${formatCurrency(row.amount)}</td>
      `;
      tbody.appendChild(tr);
    });

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
