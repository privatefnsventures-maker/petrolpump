/* global supabaseClient, requireAuth, applyRoleVisibility, formatCurrency */

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
    overduePagination.hasMore = true;
    overduePagination.totalCount = 0;
    overduePagination.currentDate = dateStr;
    overduePagination.filteredData = [];
    tbody.innerHTML = "<tr><td colspan='5' class='muted'>Loading…</td></tr>";
  }

  // Update button state
  if (loadMoreBtn) {
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = "Loading…";
  }

  try {
    // Fetch total count of outstanding credits (only on reset)
    if (reset || overduePagination.currentDate !== dateStr) {
      const { count, error: countError } = await supabaseClient
        .from("credit_customers")
        .select("*", { count: "exact", head: true })
        .gt("amount_due", 0);
      
      if (!countError) {
        overduePagination.totalCount = count || 0;
      }
    }

    // Fetch data with pagination
    const { data, error } = await supabaseClient
      .from("credit_customers")
      .select("customer_name, vehicle_no, amount_due, last_payment, created_at")
      .gt("amount_due", 0)
      .order("amount_due", { ascending: false })
      .range(overduePagination.offset, overduePagination.offset + PAGE_SIZE - 1);

    if (error) {
      if (reset) {
        tbody.innerHTML = `<tr><td colspan="5" class="error">${error.message}</td></tr>`;
        if (summary) summary.textContent = "Unable to load.";
      }
      overduePagination.isLoading = false;
      updateOverduePaginationUI();
      return;
    }

    // Update pagination state
    const fetchedCount = data?.length || 0;
    overduePagination.offset += fetchedCount;
    overduePagination.hasMore = fetchedCount === PAGE_SIZE;

    // Handle empty data on initial load
    if (reset && !fetchedCount) {
      tbody.innerHTML = "<tr><td colspan='5' class='muted'>No outstanding credits.</td></tr>";
      if (summary) summary.textContent = `No pending credits on ${dateStr}.`;
      overduePagination.isLoading = false;
      updateOverduePaginationUI();
      return;
    }

    // Filter data by date
    const asOfDate = new Date(`${dateStr}T23:59:59.999Z`);
    const newFiltered = (data ?? []).filter((row) => {
      const last = row.last_payment ? new Date(`${row.last_payment}T00:00:00Z`) : null;
      const created = row.created_at ? new Date(row.created_at) : null;
      const effective = last || created;
      if (!effective) return false;
      return effective.getTime() <= asOfDate.getTime();
    });

    // Add to accumulated filtered data
    overduePagination.filteredData.push(...newFiltered);

    // Handle no filtered results
    if (overduePagination.filteredData.length === 0 && !overduePagination.hasMore) {
      tbody.innerHTML = "<tr><td colspan='5' class='muted'>No outstanding credits.</td></tr>";
      if (summary) summary.textContent = `No pending credits on ${dateStr}.`;
      overduePagination.isLoading = false;
      updateOverduePaginationUI();
      return;
    }

    // Update summary with filtered totals
    const totalDue = overduePagination.filteredData.reduce(
      (sum, row) => sum + Number(row.amount_due ?? 0), 0
    );
    if (summary) {
      summary.textContent = `${overduePagination.filteredData.length} customers · ${formatCurrency(totalDue)} outstanding`;
    }

    // Render table
    if (reset) {
      tbody.innerHTML = "";
    }

    // Append only new filtered rows
    newFiltered.forEach((row) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(row.customer_name)}</td>
        <td>${escapeHtml(row.vehicle_no ?? "—")}</td>
        <td>${formatCurrency(row.amount_due)}</td>
        <td>${row.last_payment ?? "—"}</td>
        <td>${formatDate(row.created_at)}</td>
      `;
      tbody.appendChild(tr);
    });

    // If we got no filtered results but there's more data, auto-load more
    if (newFiltered.length === 0 && overduePagination.hasMore) {
      overduePagination.isLoading = false;
      loadOpenCredit(dateStr, false);
      return;
    }

  } catch (err) {
    console.error("Error loading open credit:", err);
    if (reset) {
      tbody.innerHTML = `<tr><td colspan="5" class="error">Failed to load data</td></tr>`;
      if (summary) summary.textContent = "Unable to load.";
    }
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
    if (overduePagination.filteredData.length > 0) {
      const showing = overduePagination.filteredData.length;
      if (overduePagination.hasMore) {
        paginationInfo.textContent = `Showing ${showing} entries (more available)`;
      } else {
        paginationInfo.textContent = `Showing all ${showing} entries`;
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
