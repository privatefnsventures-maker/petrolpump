/* global supabaseClient, requireAuth, applyRoleVisibility, formatCurrency, getLocalDateString, AppCache, AppError */

/**
 * Format YYYY-MM-DD for display (e.g. "10 Feb 2025").
 * @param {string|null|undefined} dateStr
 * @returns {string}
 */
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

// Pagination state
const PAGE_SIZE = 25;
let creditPagination = {
  offset: 0,
  hasMore: true,
  totalCount: 0,
  isLoading: false,
};

document.addEventListener("DOMContentLoaded", async () => {
  const auth = await requireAuth({ allowedRoles: ["admin", "supervisor"] });
  if (!auth) return;

  const { role, session } = auth;
  const currentUserId = session?.user?.id ?? null;
  applyRoleVisibility(role);

  const form = document.getElementById("credit-form");
  if (form) {
    form.addEventListener("submit", (event) =>
      handleCreditSubmit(event, currentUserId)
    );
  }

  // Default transaction date to today
  const transactionDateInput = document.getElementById("credit-date");
  if (transactionDateInput && typeof getLocalDateString === "function") {
    transactionDateInput.value = getLocalDateString();
  }

  // Initialize pagination controls
  initPaginationControls();

  // Load existing customer names into dropdown (Temp + names from ledger)
  loadCustomerNames();

  loadCreditLedger(true); // Initial load with reset
});

/**
 * Load distinct customer names from credit_customers and populate the customer datalist.
 * "Temp" is always shown first for one-off / temporary customers.
 */
async function loadCustomerNames() {
  const datalist = document.getElementById("customer-list");
  if (!datalist) return;
  try {
    const { data, error } = await supabaseClient
      .from("credit_customers")
      .select("customer_name")
      .order("created_at", { ascending: false });
    if (error) {
      AppError.report(error, { context: "loadCustomerNames" });
      return;
    }
    const names = [...new Set((data || []).map((r) => (r.customer_name || "").trim()).filter(Boolean))];
    datalist.innerHTML = "<option value=\"Temp\">";
    names.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      datalist.appendChild(opt);
    });
  } catch (e) {
    AppError.report(e, { context: "loadCustomerNames" });
  }
}

async function handleCreditSubmit(event, currentUserId) {
  event.preventDefault();

  const form = event.currentTarget;
  const submitBtn = form.querySelector('button[type="submit"]');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";
  }
  const successEl = document.getElementById("credit-success");
  const errorEl = document.getElementById("credit-error");
  successEl?.classList.add("hidden");
  errorEl?.classList.add("hidden");

  const formData = new FormData(form);
  const transactionDate = formData.get("credit_date")?.trim() || (typeof getLocalDateString === "function" ? getLocalDateString() : new Date().toISOString().slice(0, 10));
  const customerName = (formData.get("customer_name") || "").trim();
  const fuelType = (formData.get("fuel_type") || "").trim() || null;
  const quantityRaw = Number(formData.get("quantity") || 0);
  const quantity = quantityRaw > 0 ? quantityRaw : null;
  const amount = Number(formData.get("amount_due") || 0);
  const notes = (formData.get("notes") || "").trim() || null;
  const vehicleNo = (formData.get("vehicle_no") || "").trim() || null;

  if (!customerName || amount <= 0) {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Save credit entry";
    }
    AppError.handle(new Error("Customer and amount are required."), { target: errorEl });
    return;
  }

  const { data, error } = await supabaseClient.rpc("add_credit_entry", {
    p_customer_name: customerName,
    p_transaction_date: transactionDate,
    p_amount: amount,
    p_vehicle_no: vehicleNo,
    p_fuel_type: fuelType || undefined,
    p_quantity: quantity ?? undefined,
    p_notes: notes,
  });

  if (error) {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Save credit entry";
    }
    AppError.handle(error, { target: errorEl });
    return;
  }

  form.reset();
  const transactionDateInput = form.querySelector("#credit-date");
  if (transactionDateInput) {
    transactionDateInput.value = typeof getLocalDateString === "function" ? getLocalDateString() : new Date().toISOString().slice(0, 10);
  }
  const fuelTypeSelect = form.querySelector("#fuel-type");
  if (fuelTypeSelect) fuelTypeSelect.value = "";
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = "Save credit entry";
  }
  successEl?.classList.remove("hidden");
  loadCreditLedger(true);
  loadCustomerNames();

  if (typeof AppCache !== "undefined" && AppCache) {
    AppCache.invalidateByType("credit_summary");
    AppCache.invalidateByType("recent_activity");
  }
  try {
    localStorage.setItem("credit-updated", String(Date.now()));
  } catch (e) {
    /* ignore */
  }
}

/**
 * Initialize pagination controls (load more button and info display)
 */
function initPaginationControls() {
  const tableSection = document.querySelector("section.card:has(#credit-table-body)");
  if (!tableSection) return;

  // Check if pagination controls already exist
  if (tableSection.querySelector(".pagination-controls")) return;

  // Create pagination controls container
  const paginationDiv = document.createElement("div");
  paginationDiv.className = "pagination-controls";
  paginationDiv.innerHTML = `
    <div class="pagination-info">
      <span id="credit-pagination-info" class="muted"></span>
    </div>
    <button id="credit-load-more" class="button-secondary hidden">Load more</button>
  `;
  tableSection.appendChild(paginationDiv);

  // Attach load more handler
  const loadMoreBtn = document.getElementById("credit-load-more");
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener("click", () => loadCreditLedger(false));
  }
}

/**
 * Load credit ledger with pagination support
 * @param {boolean} reset - If true, resets pagination and clears existing data
 */
async function loadCreditLedger(reset = false) {
  const tbody = document.getElementById("credit-table-body");
  const loadMoreBtn = document.getElementById("credit-load-more");
  const paginationInfo = document.getElementById("credit-pagination-info");
  
  if (!tbody) return;
  
  // Prevent duplicate requests
  if (creditPagination.isLoading) return;
  creditPagination.isLoading = true;

  // Reset pagination state if needed
  if (reset) {
    creditPagination.offset = 0;
    creditPagination.hasMore = true;
    creditPagination.totalCount = 0;
    tbody.innerHTML = "<tr><td colspan='7' class='muted'>Fetching credit ledger…</td></tr>";
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
        .from("credit_customers")
        .select("*", { count: "exact", head: true });
      
      if (!countError) {
        creditPagination.totalCount = count || 0;
      }
    }

    // Fetch data with pagination using range
    const { data, error } = await supabaseClient
      .from("credit_customers")
      .select("id, customer_name, vehicle_no, amount_due, date, last_payment, notes")
      .order("created_at", { ascending: false })
      .range(creditPagination.offset, creditPagination.offset + PAGE_SIZE - 1);

    if (error) {
      if (reset) {
        tbody.innerHTML = `<tr><td colspan="7" class="error">${escapeHtml(AppError.getUserMessage(error))}</td></tr>`;
      }
      AppError.report(error, { context: "loadCreditLedger" });
      creditPagination.isLoading = false;
      updatePaginationUI();
      return;
    }

    // Update pagination state
    const fetchedCount = data?.length || 0;
    creditPagination.offset += fetchedCount;
    creditPagination.hasMore = fetchedCount === PAGE_SIZE;

    // Handle empty data
    if (reset && !fetchedCount) {
      tbody.innerHTML = "<tr><td colspan='7'><div class='empty-state'><p>No credit customers recorded yet.</p><p class='empty-cta'><a href='#credit-form'>Record credit sale above</a>.</p></div></td></tr>";
      creditPagination.isLoading = false;
      updatePaginationUI();
      return;
    }

    // Clear loading message on initial load
    if (reset) {
      tbody.innerHTML = "";
    }

    const todayStr = typeof getLocalDateString === "function" ? getLocalDateString() : new Date().toISOString().slice(0, 10);
    // Append rows
    data.forEach((row) => {
      const tr = document.createElement("tr");
      const actionHtml = Number(row.amount_due) > 0
        ? `<div class="settle-inline">
             <label class="settle-date-label" for="settle-date-${row.id}">Settlement date</label>
             <input type="date" class="settle-date" id="settle-date-${row.id}" value="${todayStr}" title="Business date when payment was received" aria-label="Settlement date" />
             <select class="settle-mode" aria-label="Payment mode" title="Cash / UPI / Bank">
               <option value="Cash">Cash</option>
               <option value="UPI">UPI</option>
               <option value="Bank">Bank</option>
             </select>
             <input type="number" min="0" step="0.01" class="settle-amount" placeholder="Amount" title="Amount received" aria-label="Amount (₹)" />
             <button class="settle-confirm" data-id="${row.id}">Settle</button>
             <span class="settle-msg muted" aria-live="polite"></span>
           </div>`
        : `<div class="settle-inline">
             <span class="muted">Cleared</span>
             <button class="delete-entry" data-id="${row.id}" title="Delete settled entry">Delete</button>
           </div>`;

      tr.innerHTML = `
        <td>${escapeHtml(row.customer_name)}</td>
        <td>${escapeHtml(row.vehicle_no ?? "—")}</td>
        <td data-amount="${row.amount_due}">${formatCurrency(row.amount_due)}</td>
        <td>${formatDisplayDate(row.date)}</td>
        <td>${formatDisplayDate(row.last_payment)}</td>
        <td>${escapeHtml(row.notes ?? "—")}</td>
        <td>${actionHtml}</td>
      `;
      tbody.appendChild(tr);
    });

  } catch (err) {
    if (reset) {
      tbody.innerHTML = `<tr><td colspan="7" class="error">${escapeHtml(AppError.getUserMessage(err))}</td></tr>`;
    }
    AppError.report(err, { context: "loadCreditLedger" });
  } finally {
    creditPagination.isLoading = false;
    updatePaginationUI();
  }
}

/**
 * Update pagination UI elements (info text and load more button)
 */
function updatePaginationUI() {
  const loadMoreBtn = document.getElementById("credit-load-more");
  const paginationInfo = document.getElementById("credit-pagination-info");
  
  // Update info text and ledger summary
  const summaryEl = document.getElementById("credit-ledger-summary");
  if (paginationInfo) {
    if (creditPagination.totalCount > 0) {
      const showing = Math.min(creditPagination.offset, creditPagination.totalCount);
      paginationInfo.textContent = `Showing ${showing} of ${creditPagination.totalCount} entries`;
    } else {
      paginationInfo.textContent = "";
    }
  }
  if (summaryEl) {
    if (creditPagination.totalCount > 0) {
      const showing = Math.min(creditPagination.offset, creditPagination.totalCount);
      summaryEl.textContent = `${showing} of ${creditPagination.totalCount} entries`;
    } else {
      summaryEl.textContent = "";
    }
  }

  // Update load more button
  if (loadMoreBtn) {
    loadMoreBtn.disabled = false;
    loadMoreBtn.textContent = "Load more";
    
    if (creditPagination.hasMore && creditPagination.offset > 0) {
      loadMoreBtn.classList.remove("hidden");
    } else {
      loadMoreBtn.classList.add("hidden");
    }
  }
}

// Handle inline settle confirm clicks
document.addEventListener("click", async (e) => {
  const btn = e.target.closest && e.target.closest(".settle-confirm");
  if (!btn) return;
  const id = btn.dataset.id;
  const container = btn.closest(".settle-inline");
  if (!id || !container) return;
  const input = container.querySelector(".settle-amount");
  const dateInput = container.querySelector(".settle-date");
  const modeSelect = container.querySelector(".settle-mode");
  const msg = container.querySelector(".settle-msg");
  msg.textContent = "";

  const raw = input.value;
  const paid = Number(raw || 0);
  if (!paid || paid <= 0) {
    msg.textContent = "Enter amount";
    return;
  }

  const todayStrForValidation = typeof getLocalDateString === "function" ? getLocalDateString() : new Date().toISOString().slice(0, 10);
  let settlementDate = dateInput?.value?.trim() || todayStrForValidation;
  if (settlementDate > todayStrForValidation) {
    msg.textContent = "Settlement date cannot be in the future";
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(settlementDate)) {
    settlementDate = todayStrForValidation;
  }
  const paymentMode = (modeSelect && modeSelect.value) ? modeSelect.value : "Cash";

  // fetch current amount for id to be safe
  const { data: currentRow, error: fetchErr } = await supabaseClient
    .from("credit_customers")
    .select("amount_due")
    .eq("id", id)
    .single();
  if (fetchErr || !currentRow) {
    msg.textContent = AppError.getUserMessage(fetchErr || new Error("Record not found"));
    return;
  }

  const current = Number(currentRow.amount_due) || 0;
  const settleAmount = Math.min(paid, current);
  if (settleAmount <= 0) {
    msg.textContent = "Amount must be positive and not more than due";
    return;
  }

  btn.disabled = true;
  const { data: rpcData, error: updateErr } = await supabaseClient.rpc("record_credit_payment", {
    p_credit_customer_id: id,
    p_date: settlementDate,
    p_amount: settleAmount,
    p_note: null,
    p_payment_mode: paymentMode,
  });
  btn.disabled = false;

  if (updateErr) {
    msg.textContent = AppError.getUserMessage(updateErr);
    AppError.report(updateErr, { context: "creditSettle" });
    return;
  }
  const remaining = Number(rpcData?.new_due ?? 0);
  const tr = btn.closest("tr");
  const amountCell = tr && tr.querySelector("td[data-amount]");
  if (amountCell) {
    amountCell.setAttribute("data-amount", remaining);
    amountCell.textContent = formatCurrency(remaining);
  }
  // Update "Last paid" cell (column index 4)
  if (tr) {
    const cells = tr.querySelectorAll("td");
    if (cells && cells.length >= 5) {
      cells[4].textContent = formatDisplayDate(settlementDate);
    }
  }

  input.value = "";
  msg.classList.remove("muted");
  msg.classList.add("success");
  if (remaining === 0) {
    msg.textContent = "Fully settled";
  } else {
    msg.textContent = `Settled · remaining ${formatCurrency(remaining)}`;
  }
  // update action controls for fully settled after a short delay (allow msg to appear)
  if (remaining === 0) {
    setTimeout(() => {
      if (container && container.parentElement) {
        container.parentElement.innerHTML = `<div class="settle-inline">
           <span class="muted">Cleared</span>
           <button class="delete-entry" data-id="${id}" title="Delete settled entry">Delete</button>
         </div>`;
      }
    }, 800);
  }

  // clear the status after a short delay
  setTimeout(() => {
    msg.classList.remove("success");
    msg.classList.add("muted");
    msg.textContent = "";
  }, 3500);

  // Invalidate cache so dashboard (and other tabs) show updated credit immediately
  if (typeof AppCache !== "undefined" && AppCache) {
    AppCache.invalidateByType("credit_summary");
    AppCache.invalidateByType("recent_activity");
  }
  try {
    localStorage.setItem("credit-updated", String(Date.now()));
  } catch (e) {
    /* ignore */
  }
});

// Handle delete button clicks for settled entries
document.addEventListener("click", async (e) => {
  const btn = e.target.closest && e.target.closest(".delete-entry");
  if (!btn) return;

  const id = btn.dataset.id;
  if (!id) return;

  const tr = btn.closest("tr");
  const customerName = tr ? tr.querySelector("td")?.textContent : "this entry";

  // Confirm deletion
  const confirmed = confirm(`Are you sure you want to delete the settled entry for "${customerName}"? This action cannot be undone.`);
  if (!confirmed) return;

  const container = btn.closest(".settle-inline");
  const msg = container?.querySelector(".settle-msg");

  btn.disabled = true;
  if (msg) msg.textContent = "Deleting…";

  const { error } = await supabaseClient
    .from("credit_customers")
    .delete()
    .eq("id", id);

  if (error) {
    btn.disabled = false;
    if (msg) {
      msg.classList.remove("muted");
      msg.classList.add("error");
      msg.textContent = AppError.getUserMessage(error);
    }
    AppError.report(error, { context: "creditDelete" });
    return;
  }

  // Update pagination count
  if (creditPagination.totalCount > 0) {
    creditPagination.totalCount -= 1;
    creditPagination.offset = Math.max(0, creditPagination.offset - 1);
    updatePaginationUI();
  }

  // Remove the row from the table
  if (tr) {
    tr.style.transition = "opacity 0.3s ease";
    tr.style.opacity = "0";
    setTimeout(() => {
      tr.remove();
      // Check if table is now empty
      const tbody = document.getElementById("credit-table-body");
      if (tbody && tbody.querySelectorAll("tr").length === 0) {
        tbody.innerHTML = "<tr><td colspan='7' class='muted'>No credit customers recorded yet.</td></tr>";
        creditPagination.hasMore = false;
        updatePaginationUI();
      }
    }, 300);
  }

  // Invalidate cache so dashboard (and other tabs) show updated credit immediately
  if (typeof AppCache !== "undefined" && AppCache) {
    AppCache.invalidateByType("credit_summary");
    AppCache.invalidateByType("recent_activity");
  }
  try {
    localStorage.setItem("credit-updated", String(Date.now()));
  } catch (e) {
    /* ignore */
  }
});

// simple HTML escape for attribute injection safety
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
