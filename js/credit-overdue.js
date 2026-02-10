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
const PAGE_SIZE = 25;
let overduePagination = {
  offset: 0,
  hasMore: true,
  totalCount: 0,
  isLoading: false,
  currentDate: null,
  filteredData: [], // Store filtered data for client-side pagination
};

document.addEventListener("DOMContentLoaded", async () => {
  const auth = await requireAuth({
    allowedRoles: ["admin", "supervisor"],
    onDenied: "dashboard.html",
  });
  if (!auth) return;
  applyRoleVisibility(auth.role);

  const dateInput = document.getElementById("credit-overdue-date");
  const todayStr = new Date().toISOString().slice(0, 10);
  if (dateInput) {
    dateInput.value = todayStr;
    dateInput.addEventListener("change", () => {
      const value = dateInput.value || todayStr;
      loadOpenCredit(value, true); // Reset pagination on date change
    });
  }

  // Initialize pagination controls
  initOverduePaginationControls();
  loadOpenCredit(todayStr, true);
});

/**
 * Initialize pagination controls for credit overdue table
 */
function initOverduePaginationControls() {
  const tableSection = document.querySelector("section.card:has(#credit-overdue-body)");
  if (!tableSection) return;

  // Check if pagination controls already exist
  if (tableSection.querySelector(".pagination-controls")) return;

  // Create pagination controls container
  const paginationDiv = document.createElement("div");
  paginationDiv.className = "pagination-controls";
  paginationDiv.innerHTML = `
    <div class="pagination-info">
      <span id="overdue-pagination-info" class="muted"></span>
    </div>
    <button id="overdue-load-more" class="button-secondary hidden">Load more</button>
  `;
  tableSection.appendChild(paginationDiv);

  // Attach load more handler
  const loadMoreBtn = document.getElementById("overdue-load-more");
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener("click", () => {
      const dateInput = document.getElementById("credit-overdue-date");
      const dateStr = dateInput?.value || new Date().toISOString().slice(0, 10);
      loadOpenCredit(dateStr, false);
    });
  }
}

/**
 * Load open credit with pagination support
 * @param {string} dateStr - The date to filter by
 * @param {boolean} reset - If true, resets pagination and clears existing data
 */
async function loadOpenCredit(dateStr, reset = false) {
  const tbody = document.getElementById("credit-overdue-body");
  const summary = document.getElementById("credit-overdue-summary");
  const loadMoreBtn = document.getElementById("overdue-load-more");
  const paginationInfo = document.getElementById("overdue-pagination-info");
  
  if (!tbody) return;

  // Prevent duplicate requests
  if (overduePagination.isLoading) return;
  overduePagination.isLoading = true;

  // Reset pagination state if needed or if date changed
  if (reset || overduePagination.currentDate !== dateStr) {
    overduePagination.offset = 0;
    overduePagination.hasMore = false;
    overduePagination.totalCount = 0;
    overduePagination.currentDate = dateStr;
    overduePagination.filteredData = []; // Force fetch in try block
    tbody.innerHTML = "<tr><td colspan='5' class='muted'>Loading…</td></tr>";
  }

  // Update button state
  if (loadMoreBtn) {
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = "Loading…";
  }

  try {
    // On reset/date change: fetch full list (outstanding as of date = entries by txn date - payments by date)
    if (reset || overduePagination.currentDate !== dateStr || overduePagination.filteredData.length === 0) {
      const { data: listData, error } = await supabaseClient.rpc("get_outstanding_credit_list_as_of", {
        p_date: dateStr,
      });

      if (error) {
        tbody.innerHTML = `<tr><td colspan="5" class="error">${escapeHtml(AppError.getUserMessage(error))}</td></tr>`;
        if (summary) summary.textContent = "Unable to load.";
        if (document.getElementById("credit-overdue-as-of")) {
          document.getElementById("credit-overdue-as-of").textContent = `As of ${formatDisplayDate(dateStr)}`;
        }
        AppError.report(error, { context: "loadOpenCredit" });
        overduePagination.isLoading = false;
        updateOverduePaginationUI();
        return;
      }

      overduePagination.filteredData = listData ?? [];
      overduePagination.totalCount = overduePagination.filteredData.length;
      overduePagination.hasMore = overduePagination.totalCount > PAGE_SIZE;
    }

    const asOfEl = document.getElementById("credit-overdue-as-of");
    if (asOfEl) asOfEl.textContent = `As of ${formatDisplayDate(dateStr)}`;

    if (overduePagination.filteredData.length === 0) {
      tbody.innerHTML = `<tr><td colspan='5'><div class='empty-state'><p>No outstanding credits for this date.</p><p class='empty-cta'><a href='credit.html'>Record credit sale</a></p></div></td></tr>`;
      if (summary) summary.textContent = "Total outstanding: ₹0.00 · 0 customers";
      overduePagination.isLoading = false;
      updateOverduePaginationUI();
      return;
    }

    const totalDue = overduePagination.filteredData.reduce(
      (sum, row) => sum + Number(row.amount_due_as_of ?? 0),
      0
    );
    if (summary) {
      summary.textContent = `Total outstanding: ${formatCurrency(totalDue)} · ${overduePagination.totalCount} customers`;
    }

    const sliceStart = reset ? 0 : overduePagination.offset;
    const sliceEnd = sliceStart + PAGE_SIZE;
    const rowsToShow = overduePagination.filteredData.slice(sliceStart, sliceEnd);

    if (reset) {
      tbody.innerHTML = "";
    }

    rowsToShow.forEach((row) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(row.customer_name)}</td>
        <td>${escapeHtml(row.vehicle_no ?? "—")}</td>
        <td>${formatCurrency(row.amount_due_as_of)}</td>
        <td>${formatDisplayDate(row.last_payment_date)}</td>
        <td>${formatDisplayDate(row.sale_date)}</td>
      `;
      tbody.appendChild(tr);
    });

    overduePagination.offset = reset ? rowsToShow.length : overduePagination.offset + rowsToShow.length;
    overduePagination.hasMore = overduePagination.offset < overduePagination.totalCount;

  } catch (err) {
    if (reset) {
      tbody.innerHTML = `<tr><td colspan="5" class="error">${escapeHtml(AppError.getUserMessage(err))}</td></tr>`;
      if (summary) summary.textContent = "Unable to load.";
    }
    AppError.report(err, { context: "loadOpenCredit" });
  } finally {
    overduePagination.isLoading = false;
    updateOverduePaginationUI();
  }
}

/**
 * Update pagination UI elements for credit overdue
 */
function updateOverduePaginationUI() {
  const loadMoreBtn = document.getElementById("overdue-load-more");
  const paginationInfo = document.getElementById("overdue-pagination-info");
  
  // Update info text
  if (paginationInfo) {
    if (overduePagination.totalCount > 0) {
      const showing = Math.min(overduePagination.offset, overduePagination.totalCount);
      if (overduePagination.hasMore) {
        paginationInfo.textContent = `Showing ${showing} of ${overduePagination.totalCount} entries`;
      } else {
        paginationInfo.textContent = `Showing all ${overduePagination.totalCount} entries`;
      }
    } else {
      paginationInfo.textContent = "";
    }
  }

  // Update load more button
  if (loadMoreBtn) {
    loadMoreBtn.disabled = false;
    loadMoreBtn.textContent = "Load more";
    
    if (overduePagination.hasMore && overduePagination.filteredData.length > 0) {
      loadMoreBtn.classList.remove("hidden");
    } else {
      loadMoreBtn.classList.add("hidden");
    }
  }
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

function formatDisplayDate(dateStr) {
  if (!dateStr) return "—";
  const date = new Date(dateStr + "T00:00:00");
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
