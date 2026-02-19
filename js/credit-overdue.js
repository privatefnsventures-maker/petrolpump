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

// Pagination state (page-based: 0 = first page)
const PAGE_SIZE = 25;
let overduePagination = {
  currentPage: 0,
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
  // Customer detail modal
  initCustomerDetailModal();
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
    <div class="pagination-buttons">
      <button type="button" id="overdue-pagination-back" class="button-secondary hidden">Back</button>
      <button type="button" id="overdue-load-more" class="button-secondary hidden">Show more</button>
    </div>
  `;
  tableSection.appendChild(paginationDiv);

  const backBtn = document.getElementById("overdue-pagination-back");
  const loadMoreBtn = document.getElementById("overdue-load-more");
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      if (overduePagination.currentPage > 0) {
        overduePagination.currentPage--;
        renderOverduePage();
      }
    });
  }
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener("click", () => {
      const totalPages = Math.ceil(overduePagination.totalCount / PAGE_SIZE);
      if (overduePagination.currentPage < totalPages - 1) {
        overduePagination.currentPage++;
        renderOverduePage();
      }
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
    overduePagination.currentPage = 0;
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
      if (reset) overduePagination.currentPage = 0;
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

    renderOverduePage();

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
 * Render the current page of the outstanding list from cached filteredData (no fetch).
 */
function renderOverduePage() {
  const tbody = document.getElementById("credit-overdue-body");
  if (!tbody || !overduePagination.filteredData.length) return;

  const total = overduePagination.totalCount;
  const page = overduePagination.currentPage;
  const sliceStart = page * PAGE_SIZE;
  const sliceEnd = Math.min(sliceStart + PAGE_SIZE, total);
  const rowsToShow = overduePagination.filteredData.slice(sliceStart, sliceEnd);

  tbody.innerHTML = rowsToShow
    .map(
      (row) =>
        `<tr><td><span class="customer-name-link" data-customer-name="${escapeHtml(row.customer_name || "")}">${escapeHtml(row.customer_name || "—")}</span></td>` +
        `<td>${escapeHtml(row.vehicle_no ?? "—")}</td><td>${formatCurrency(row.amount_due_as_of)}</td>` +
        `<td>${formatDisplayDate(row.last_payment_date)}</td><td>${formatDisplayDate(row.sale_date)}</td></tr>`
    )
    .join("");
  tbody.querySelectorAll(".customer-name-link").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      openCustomerDetail(el.dataset.customerName || el.textContent);
    });
  });
}

/**
 * Update pagination UI elements for credit overdue (info text, Back, Show more).
 */
function updateOverduePaginationUI() {
  const backBtn = document.getElementById("overdue-pagination-back");
  const loadMoreBtn = document.getElementById("overdue-load-more");
  const paginationInfo = document.getElementById("overdue-pagination-info");

  if (paginationInfo) {
    if (overduePagination.totalCount > 0) {
      const totalPages = Math.ceil(overduePagination.totalCount / PAGE_SIZE);
      const page = overduePagination.currentPage;
      const from = page * PAGE_SIZE + 1;
      const to = Math.min((page + 1) * PAGE_SIZE, overduePagination.totalCount);
      const total = overduePagination.totalCount;
      if (totalPages <= 1) {
        paginationInfo.textContent = `Showing all ${total} entries`;
      } else {
        paginationInfo.textContent = `Showing ${from}–${to} of ${total}`;
      }
    } else {
      paginationInfo.textContent = "";
    }
  }

  const totalPages = Math.ceil(overduePagination.totalCount / PAGE_SIZE);
  const hasMultiplePages = totalPages > 1;
  const canGoBack = overduePagination.currentPage > 0;
  const canGoForward = overduePagination.currentPage < totalPages - 1;

  if (backBtn) {
    backBtn.textContent = "Back";
    backBtn.disabled = !canGoBack;
    backBtn.classList.toggle("hidden", !hasMultiplePages);
  }
  if (loadMoreBtn) {
    loadMoreBtn.textContent = "Show more";
    loadMoreBtn.disabled = !canGoForward;
    loadMoreBtn.classList.toggle("hidden", !hasMultiplePages);
  }
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

/** Breakdown table: show last 5 (most recent) per page, with Back / Show more */
const BREAKDOWN_PAGE_SIZE = 5;

/** Pagination state for modal breakdowns (entries sorted by date desc, page 0 = most recent) */
let breakdownState = {
  credit: { entries: [], page: 0 },
  settlement: { entries: [], page: 0 },
};

/** Cache modal element refs (set on first open) */
let customerDetailEls = null;

function getCustomerDetailEls() {
  if (customerDetailEls) return customerDetailEls;
  customerDetailEls = {
    overlay: document.getElementById("customer-detail-overlay"),
    title: document.getElementById("customer-detail-title"),
    asOf: document.getElementById("customer-detail-as-of"),
    content: document.getElementById("customer-detail-content"),
    error: document.getElementById("customer-detail-error"),
    loading: document.getElementById("customer-detail-loading"),
    creditTaken: document.getElementById("customer-detail-credit-taken"),
    settlementDone: document.getElementById("customer-detail-settlement-done"),
    remaining: document.getElementById("customer-detail-remaining"),
    creditWhen: document.getElementById("customer-detail-credit-when"),
    settlementWhen: document.getElementById("customer-detail-settlement-when"),
    vehicle: document.getElementById("customer-detail-vehicle"),
    creditTbody: document.getElementById("customer-detail-credit-breakdown"),
    settlementTbody: document.getElementById("customer-detail-settlement-breakdown"),
    creditEmpty: document.getElementById("customer-detail-credit-breakdown-empty"),
    settlementEmpty: document.getElementById("customer-detail-settlement-breakdown-empty"),
    creditPagination: document.getElementById("customer-detail-credit-breakdown-pagination"),
    creditPaginationInfo: document.getElementById("customer-detail-credit-breakdown-info"),
    creditBack: document.getElementById("customer-detail-credit-breakdown-back"),
    creditMore: document.getElementById("customer-detail-credit-breakdown-more"),
    settlementPagination: document.getElementById("customer-detail-settlement-breakdown-pagination"),
    settlementPaginationInfo: document.getElementById("customer-detail-settlement-breakdown-info"),
    settlementBack: document.getElementById("customer-detail-settlement-breakdown-back"),
    settlementMore: document.getElementById("customer-detail-settlement-breakdown-more"),
  };
  return customerDetailEls;
}

function initCustomerDetailModal() {
  const els = getCustomerDetailEls();
  if (!els.overlay) return;

  function close() {
    els.overlay.setAttribute("aria-hidden", "true");
  }

  const backdrop = document.getElementById("customer-detail-backdrop");
  const closeBtn = document.getElementById("customer-detail-close");
  const closeBtnFooter = document.getElementById("customer-detail-close-btn");
  if (backdrop) backdrop.addEventListener("click", close);
  if (closeBtn) closeBtn.addEventListener("click", close);
  if (closeBtnFooter) closeBtnFooter.addEventListener("click", close);
  els.overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  if (els.creditBack) {
    els.creditBack.addEventListener("click", () => {
      if (breakdownState.credit.page > 0) {
        breakdownState.credit.page--;
        renderBreakdownPage("credit");
      }
    });
  }
  if (els.creditMore) {
    els.creditMore.addEventListener("click", () => {
      const totalPages = Math.ceil(breakdownState.credit.entries.length / BREAKDOWN_PAGE_SIZE);
      if (breakdownState.credit.page < totalPages - 1) {
        breakdownState.credit.page++;
        renderBreakdownPage("credit");
      }
    });
  }
  if (els.settlementBack) {
    els.settlementBack.addEventListener("click", () => {
      if (breakdownState.settlement.page > 0) {
        breakdownState.settlement.page--;
        renderBreakdownPage("settlement");
      }
    });
  }
  if (els.settlementMore) {
    els.settlementMore.addEventListener("click", () => {
      const totalPages = Math.ceil(breakdownState.settlement.entries.length / BREAKDOWN_PAGE_SIZE);
      if (breakdownState.settlement.page < totalPages - 1) {
        breakdownState.settlement.page++;
        renderBreakdownPage("settlement");
      }
    });
  }
}

function renderBreakdownRows(entries) {
  if (!entries || !entries.length) return "";
  return entries
    .map((e) => `<tr><td>${escapeHtml(formatDisplayDate(e.entry_date))}</td><td>${formatCurrency(e.amount)}</td></tr>`)
    .join("");
}

/** Sort entries by entry_date descending (newest first) */
function sortEntriesByDateDesc(entries) {
  if (!entries || !entries.length) return [];
  return [...entries].sort((a, b) => {
    const dA = (a.entry_date || "").toString();
    const dB = (b.entry_date || "").toString();
    return dB.localeCompare(dA);
  });
}

/**
 * Render one breakdown section's current page and update pagination UI.
 * @param {"credit" | "settlement"} section
 */
function renderBreakdownPage(section) {
  const els = getCustomerDetailEls();
  const state = breakdownState[section];
  const total = state.entries.length;
  const totalPages = Math.max(1, Math.ceil(total / BREAKDOWN_PAGE_SIZE));
  const page = Math.min(state.page, totalPages - 1);
  state.page = page;

  const tbody = section === "credit" ? els.creditTbody : els.settlementTbody;
  const emptyEl = section === "credit" ? els.creditEmpty : els.settlementEmpty;
  const emptyMsg = section === "credit" ? "No credit entries." : "No settlements.";
  const paginationEl = section === "credit" ? els.creditPagination : els.settlementPagination;
  const infoEl = section === "credit" ? els.creditPaginationInfo : els.settlementPaginationInfo;
  const backBtn = section === "credit" ? els.creditBack : els.settlementBack;
  const moreBtn = section === "credit" ? els.creditMore : els.settlementMore;

  if (total === 0) {
    if (tbody) tbody.innerHTML = "";
    if (emptyEl) {
      emptyEl.textContent = emptyMsg;
      emptyEl.classList.remove("hidden");
    }
    if (paginationEl) paginationEl.classList.add("hidden");
    return;
  }

  const start = page * BREAKDOWN_PAGE_SIZE;
  const end = Math.min(start + BREAKDOWN_PAGE_SIZE, total);
  const slice = state.entries.slice(start, end);

  if (tbody) tbody.innerHTML = renderBreakdownRows(slice);
  if (emptyEl) emptyEl.classList.add("hidden");

  if (paginationEl && infoEl && backBtn && moreBtn) {
    paginationEl.classList.remove("hidden");
    const from = start + 1;
    const to = end;
    infoEl.textContent = `Showing ${from}–${to} of ${total}`;
    backBtn.disabled = page <= 0;
    backBtn.classList.toggle("hidden", totalPages <= 1);
    moreBtn.disabled = page >= totalPages - 1;
    moreBtn.classList.toggle("hidden", totalPages <= 1);
  }
}

function setBreakdownSection(tbody, emptyEl, entries, emptyMsg, section) {
  const state = breakdownState[section];
  state.entries = sortEntriesByDateDesc(entries || []);
  state.page = 0;
  renderBreakdownPage(section);
}

async function openCustomerDetail(customerName) {
  const name = customerName?.trim();
  if (!name) return;

  const els = getCustomerDetailEls();
  if (!els.overlay || !els.title) return;

  const dateInput = document.getElementById("credit-overdue-date");
  const dateStr = dateInput?.value || new Date().toISOString().slice(0, 10);

  els.title.textContent = escapeHtml(name);
  els.asOf.textContent = `All figures as of ${formatDisplayDate(dateStr)} (reference date for this summary)`;
  els.content.classList.add("hidden");
  els.error.classList.add("hidden");
  els.error.textContent = "";
  els.loading.classList.remove("hidden");
  els.loading.textContent = "Loading…";
  els.overlay.setAttribute("aria-hidden", "false");

  try {
    const { data, error } = await supabaseClient.rpc("get_customer_credit_detail_as_of", {
      p_customer_name: name,
      p_date: dateStr,
    });

    els.loading.classList.add("hidden");

    if (error) {
      els.error.textContent = AppError.getUserMessage(error);
      els.error.classList.remove("hidden");
      AppError.report(error, { context: "openCustomerDetail" });
      return;
    }

    const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
    if (!row) {
      els.error.textContent = "No credit summary found for this customer.";
      els.error.classList.remove("hidden");
      return;
    }

    els.creditTaken.textContent = formatCurrency(row.credit_taken);
    els.settlementDone.textContent = formatCurrency(row.settlement_done);
    els.remaining.textContent = formatCurrency(row.remaining);

    const first = row.first_sale_date ? formatDisplayDate(row.first_sale_date) : null;
    const last = row.last_credit_date ? formatDisplayDate(row.last_credit_date) : null;
    if (els.creditWhen) {
      els.creditWhen.textContent = first && last ? `First credit: ${first} · Last credit: ${last}` : first ? `First credit: ${first}` : last ? `Last credit: ${last}` : "";
    }
    if (els.settlementWhen) {
      els.settlementWhen.textContent = row.last_payment_date ? `Last settlement: ${formatDisplayDate(row.last_payment_date)}` : "";
    }
    if (els.vehicle) els.vehicle.textContent = row.vehicle_no ? `Vehicle: ${escapeHtml(row.vehicle_no)}` : "";

    const creditEntries = Array.isArray(row.credit_entries) ? row.credit_entries : [];
    const paymentEntries = Array.isArray(row.payment_entries) ? row.payment_entries : [];
    setBreakdownSection(els.creditTbody, els.creditEmpty, creditEntries, "No credit entries.", "credit");
    setBreakdownSection(els.settlementTbody, els.settlementEmpty, paymentEntries, "No settlements.", "settlement");

    els.content.classList.remove("hidden");
  } catch (err) {
    els.loading.classList.add("hidden");
    els.error.textContent = AppError.getUserMessage(err);
    els.error.classList.remove("hidden");
    AppError.report(err, { context: "openCustomerDetail" });
  }
}
