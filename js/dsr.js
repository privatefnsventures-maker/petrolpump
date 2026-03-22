/* global supabaseClient, requireAuth, applyRoleVisibility, AppCache, AppError */

// Simple HTML escape for XSS prevention
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PRODUCTS = ["petrol", "diesel"];
let currentUserId = null;

/**
 * Pump/nozzle configuration per product. Change here when adding pumps or nozzles;
 * keep in sync with database schema and HTML form (or generate forms from this).
 */
const PUMP_CONFIG = {
  petrol: { pumps: 2, nozzlesPerPump: 2 },
  diesel: { pumps: 2, nozzlesPerPump: 2 },
};

/** Rate column name per product (dsr table). */
const RATE_FIELD_BY_PRODUCT = { petrol: "petrol_rate", diesel: "diesel_rate" };

/** Shown when a supervisor picks a date that already has a meter entry (read-only view). */
const MSG_SUPERVISOR_METER_DAY_LOCKED =
  "Meter readings for this date are already saved. Choose another date to enter new readings, or contact an admin if a correction is needed.";

/** Resolved after auth; drives supervisor vs admin meter form behaviour. */
let currentUserRole = "supervisor";

/**
 * Returns closing meter field names for a product config (e.g. closing_pump1_nozzle1, …).
 * @param {{ pumps: number, nozzlesPerPump: number }} config
 * @returns {string[]}
 */
function getClosingMeterFields(config) {
  const fields = [];
  for (let p = 1; p <= config.pumps; p++) {
    for (let n = 1; n <= config.nozzlesPerPump; n++) {
      fields.push(`closing_pump${p}_nozzle${n}`);
    }
  }
  return fields;
}

/**
 * Returns the date string (YYYY-MM-DD) for the day before the given date string.
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {string}
 */
function getPreviousDateStr(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Build list of DSR reading number field names from config (uses petrol shape for table). */
function getReadingNumberFields() {
  const config = PUMP_CONFIG.petrol;
  const { pumps, nozzlesPerPump } = config;
  const fields = [];
  for (let p = 1; p <= pumps; p++) {
    for (let n = 1; n <= nozzlesPerPump; n++) {
      fields.push(`opening_pump${p}_nozzle${n}`);
    }
  }
  for (let p = 1; p <= pumps; p++) {
    for (let n = 1; n <= nozzlesPerPump; n++) {
      fields.push(`closing_pump${p}_nozzle${n}`);
    }
  }
  for (let p = 1; p <= pumps; p++) {
    fields.push(`sales_pump${p}`);
  }
  fields.push("total_sales", "testing", "dip_reading", "stock");
  return fields;
}

const readingNumberFields = getReadingNumberFields();

// Pagination configuration and state (page-based: 0 = first page)
const DSR_PAGE_SIZE = 10;
/** Page size for "Recent meter entries" so "Load more" and Back show when there are more entries */
const DSR_RECENT_PAGE_SIZE = 5;
const dsrPagination = {
  petrol: { currentPage: 0, totalCount: 0, isLoading: false },
  diesel: { currentPage: 0, totalCount: 0, isLoading: false },
};

/** Increments on each date refresh so stale async results do not overwrite the form. */
const meterRefreshGeneration = { petrol: 0, diesel: 0 };

document.addEventListener("DOMContentLoaded", async () => {
  const auth = await requireAuth({
    allowedRoles: ["admin", "supervisor"],
    onDenied: "credit.html",
  });
  if (!auth) return;

  currentUserId = auth.session?.user?.id ?? null;
  currentUserRole = auth.role ?? "supervisor";
  applyRoleVisibility(auth.role);

  PRODUCTS.forEach((product) => {
    initReadingForm(product);
    initDsrPaginationControls(product);
  });
  await Promise.all(PRODUCTS.map((product) => loadReadingHistory(product, true)));
});

/**
 * @param {string} product
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {Promise<string | null>} dsr.id
 */
async function fetchDsrEntryIdForDate(product, dateStr) {
  if (!dateStr || !product) return null;
  const { data, error } = await supabaseClient
    .from("dsr")
    .select("id")
    .eq("product", product)
    .eq("date", dateStr)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error || !data?.length) return null;
  return data[0].id ?? null;
}

/**
 * Full DSR row for a calendar date (latest by created_at if duplicates).
 * @returns {Promise<object | null>}
 */
async function fetchDsrFullRowForDate(product, dateStr) {
  if (!dateStr || !product) return null;
  const { data, error } = await supabaseClient
    .from("dsr")
    .select("*")
    .eq("product", product)
    .eq("date", dateStr)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error || !data?.length) return null;
  return data[0];
}

/**
 * @param {HTMLFormElement} form
 * @param {object} row - dsr row
 * @param {string} product
 * @param {number | null | undefined} openingStockHint - from dsr_stock or previous-day logic
 */
function applyDsrRowFieldsToMeterForm(form, row, product, openingStockHint) {
  const skip = new Set(["id", "created_at", "created_by", "product", "date"]);
  for (const [key, val] of Object.entries(row)) {
    if (skip.has(key)) continue;
    const input = form.querySelector(`[name="${key}"]`);
    if (!input) continue;
    if (key === "remarks") {
      input.value = val ?? "";
      continue;
    }
    if (input.type === "number" || input.classList.contains("meter-reading")) {
      input.value = val != null && val !== "" ? Number(val).toFixed(2) : "";
    }
  }
  const openingInput = getFormFieldInput(form, "opening_stock");
  if (openingInput) {
    if (openingStockHint != null && Number.isFinite(Number(openingStockHint))) {
      openingInput.value = Number(openingStockHint).toFixed(2);
    } else {
      openingInput.value = "";
    }
  }
}

/**
 * Hydrate meter form from an already-fetched DSR row (opening stock from dsr_stock or previous day).
 */
async function applyExistingDsrRowToMeterForm(product, form, row) {
  if (!row) return;

  const { data: stockRows } = await supabaseClient
    .from("dsr_stock")
    .select("opening_stock")
    .eq("date", row.date)
    .eq("product", product)
    .limit(1);

  let openingHint = stockRows?.[0]?.opening_stock;
  if (openingHint == null || !Number.isFinite(Number(openingHint))) {
    openingHint = await getPreviousDayDipStock(product, row.date);
  }

  applyDsrRowFieldsToMeterForm(form, row, product, openingHint);
  updateDerivedFields(form);
}

function setMeterFormSupervisorLocked(form, locked) {
  const suffix = form.id?.replace("dsr-form-", "") || "";
  const banner = document.getElementById(`dsr-meter-locked-banner-${suffix}`);

  if (!locked) {
    form.classList.remove("dsr-meter-supervisor-locked");
    if (banner) {
      banner.classList.add("hidden");
      banner.textContent = "";
    }
    form.querySelectorAll("[data-dsr-supervisor-lock]").forEach((el) => {
      if (el.tagName === "BUTTON") {
        el.disabled = false;
      } else {
        el.readOnly = el.dataset.dsrOrigReadonly === "1";
      }
      el.removeAttribute("data-dsr-supervisor-lock");
      el.removeAttribute("data-dsr-orig-readonly");
    });
    return;
  }

  form.classList.add("dsr-meter-supervisor-locked");
  if (banner) {
    banner.textContent = MSG_SUPERVISOR_METER_DAY_LOCKED;
    banner.classList.remove("hidden");
  }

  form.querySelectorAll("input, textarea, button").forEach((el) => {
    if (el.name === "date" || el.type === "hidden") return;
    if (el.hasAttribute("data-dsr-supervisor-lock")) return;

    if (el.tagName === "BUTTON") {
      el.setAttribute("data-dsr-supervisor-lock", "");
      el.disabled = true;
      return;
    }
    el.setAttribute("data-dsr-supervisor-lock", "");
    el.setAttribute("data-dsr-orig-readonly", el.readOnly ? "1" : "0");
    el.readOnly = true;
  });
}

function applyMeterDayLockState(product, form, hasEntryForDate) {
  if (currentUserRole !== "supervisor" || !hasEntryForDate) {
    setMeterFormSupervisorLocked(form, false);
    return;
  }
  setMeterFormSupervisorLocked(form, true);
}

/**
 * Prefill for new dates, load saved row for dates that already have a DSR, then apply supervisor lock.
 */
async function refreshMeterFormForSelectedDate(product, form) {
  const dateInput = form.querySelector("input[name='date']");
  if (!dateInput?.value) return;

  const gen = (meterRefreshGeneration[product] = (meterRefreshGeneration[product] || 0) + 1);
  const dateStr = dateInput.value;

  const existingRow = await fetchDsrFullRowForDate(product, dateStr);

  if (gen !== meterRefreshGeneration[product]) return;

  if (existingRow) {
    await applyExistingDsrRowToMeterForm(product, form, existingRow);
  } else {
    await prefillOpeningFromPreviousDay(product, form);
  }

  if (gen !== meterRefreshGeneration[product]) return;

  applyMeterDayLockState(product, form, !!existingRow);
}

function initReadingForm(product) {
  const form = document.getElementById(`dsr-form-${product}`);
  if (!form) return;

  setDefaultDate(form);

  const dateInput = form.querySelector("input[name='date']");
  if (dateInput) {
    const onDateChange = () => {
      void refreshMeterFormForSelectedDate(product, form);
    };
    dateInput.addEventListener("change", onDateChange);
    dateInput.addEventListener("input", onDateChange);
    void onDateChange();
  } else {
    updateDerivedFields(form);
  }

  form.addEventListener("input", () => {
    if (form.classList.contains("dsr-meter-supervisor-locked")) return;
    updateDerivedFields(form);
  });

  const copyPrevBtn = form.querySelector(".dsr-copy-prev[data-product]");
  if (copyPrevBtn && copyPrevBtn.dataset.product === product) {
    copyPrevBtn.addEventListener("click", async () => {
      if (form.classList.contains("dsr-meter-supervisor-locked")) return;
      copyPrevBtn.disabled = true;
      copyPrevBtn.textContent = "Loading…";
      await prefillOpeningFromPreviousDay(product, form);
      updateDerivedFields(form);
      const d = form.querySelector("input[name='date']")?.value;
      const id = d ? await fetchDsrEntryIdForDate(product, d) : null;
      applyMeterDayLockState(product, form, id != null);
      copyPrevBtn.disabled = false;
      copyPrevBtn.textContent = "Copy from previous day";
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Saving…";
    }
    const successEl = document.getElementById(`dsr-success-${product}`);
    const errorEl = document.getElementById(`dsr-error-${product}`);
    successEl?.classList.add("hidden");
    errorEl?.classList.remove("dsr-meter-locked-msg");
    errorEl?.classList.add("hidden");

    updateDerivedFields(form);

    const formData = new FormData(form);
    const payload = {
      date: formData.get("date"),
      product,
      remarks: formData.get("remarks") || null,
    };
    if (currentUserId) {
      payload.created_by = currentUserId;
    }

    readingNumberFields.forEach((field) => {
      payload[field] = toNumber(formData.get(field));
    });

    // Add the appropriate rate field based on product
    if (product === "petrol" && formData.get("petrol_rate")) {
      payload.petrol_rate = toNumber(formData.get("petrol_rate"));
    } else if (product === "diesel" && formData.get("diesel_rate")) {
      payload.diesel_rate = toNumber(formData.get("diesel_rate"));
    }

    payload.receipts = toNumber(formData.get("receipts"));

    if (!payload.date) {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Save meter entry";
      }
      if (errorEl) {
        errorEl.classList.remove("dsr-meter-locked-msg");
        errorEl.textContent = "Date is required.";
        errorEl.classList.remove("hidden");
      }
      return;
    }

    if (form.classList.contains("dsr-meter-supervisor-locked")) {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Save meter entry";
      }
      if (errorEl) {
        errorEl.textContent = MSG_SUPERVISOR_METER_DAY_LOCKED;
        errorEl.classList.add("dsr-meter-locked-msg");
        errorEl.classList.remove("hidden");
      }
      return;
    }

    const existingId = await fetchDsrEntryIdForDate(product, payload.date);
    let saveError = null;

    if (existingId) {
      if (currentUserRole !== "admin") {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = "Save meter entry";
        }
        if (errorEl) {
          errorEl.textContent = MSG_SUPERVISOR_METER_DAY_LOCKED;
          errorEl.classList.add("dsr-meter-locked-msg");
          errorEl.classList.remove("hidden");
        }
        return;
      }

      const updatePayload = { ...payload };
      delete updatePayload.created_by;
      const { error } = await supabaseClient.from("dsr").update(updatePayload).eq("id", existingId);
      saveError = error;
      if (!error) {
        await syncDsrStockAfterDsrUpdate(payload);
      }
    } else {
      const { error } = await supabaseClient.from("dsr").insert(payload);
      saveError = error;
      if (!error) {
        await syncDsrStockFromMeterEntry(payload);
      }
    }

    if (saveError) {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Save meter entry";
      }
      errorEl?.classList.remove("dsr-meter-locked-msg");
      AppError.handle(saveError, { target: errorEl });
      return;
    }

    const hasReceipts = Number(payload.receipts) > 0;
    if (hasReceipts && typeof sessionStorage !== "undefined") {
      sessionStorage.setItem("pl_todo_pending", "1");
    }

    form.reset();
    setDefaultDate(form);
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Save meter entry";
    }
    await refreshMeterFormForSelectedDate(product, form);
    successEl?.classList.remove("hidden");
    if (successEl) {
      if (hasReceipts) {
        successEl.innerHTML =
          'Entry saved. Receipts recorded — <a href="dashboard.html#pl">Enter buying price on P&L dashboard</a> to calculate profit from this day until the next receipt.';
      } else {
        successEl.textContent = "Entry saved successfully.";
      }
    }
    loadReadingHistory(product, true); // Reset pagination to show new entry
    // Invalidate cache so dashboard reflects new DSR immediately
    if (typeof AppCache !== "undefined" && AppCache) {
      AppCache.invalidateByType("dashboard_data");
      AppCache.invalidateByType("today_sales");
      AppCache.invalidateByType("dsr_summary");
      AppCache.invalidateByType("profit_loss");
    }
  });
}

/**
 * If no dsr_stock row exists for this (date, product), insert one from the meter payload
 * so the dashboard shows stock/variation without requiring a separate Stock form entry.
 * opening_stock = previous day's dip_stock (from dsr_stock or dsr.stock).
 */
async function syncDsrStockFromMeterEntry(payload) {
  const date = payload.date;
  const product = payload.product;
  if (!date || !product) return;

  const { data: existing } = await supabaseClient
    .from("dsr_stock")
    .select("id")
    .eq("date", date)
    .eq("product", product)
    .limit(1)
    .maybeSingle();

  if (existing) return;

  const openingStock = await getPreviousDayDipStock(product, date);
  const receipts = toNumber(payload.receipts);
  const totalSales = toNumber(payload.total_sales);
  const testing = toNumber(payload.testing);
  const netSale = Math.max(0, totalSales - testing);
  const dipStock = toNumber(payload.stock);
  const closingStock = (openingStock + receipts) - netSale;
  const stockRow = {
    date,
    product,
    opening_stock: openingStock,
    receipts,
    total_stock: openingStock + receipts,
    sale_from_meter: totalSales,
    testing,
    net_sale: netSale,
    closing_stock: closingStock,
    dip_stock: dipStock,
    variation: closingStock - dipStock,
    remark: payload.remarks || null,
  };
  if (currentUserId) stockRow.created_by = currentUserId;

  await supabaseClient.from("dsr_stock").insert(stockRow);
}

/**
 * When dsr_stock already exists for this (date, product), refresh figures from an updated DSR meter payload.
 */
async function syncDsrStockAfterDsrUpdate(payload) {
  const date = payload.date;
  const product = payload.product;
  if (!date || !product) return;

  const { data: rows, error: selErr } = await supabaseClient
    .from("dsr_stock")
    .select("id, opening_stock")
    .eq("date", date)
    .eq("product", product)
    .limit(1);
  if (selErr || !rows?.length) return;

  const row = rows[0];
  const openingStock = Number(row.opening_stock);
  const receipts = toNumber(payload.receipts);
  const totalSales = toNumber(payload.total_sales);
  const testing = toNumber(payload.testing);
  const netSale = Math.max(0, totalSales - testing);
  const dipStock = toNumber(payload.stock);
  const totalStock = (Number.isFinite(openingStock) ? openingStock : 0) + receipts;
  const closingStock = totalStock - netSale;
  const variation = closingStock - dipStock;

  await supabaseClient
    .from("dsr_stock")
    .update({
      receipts,
      total_stock: totalStock,
      sale_from_meter: totalSales,
      testing,
      net_sale: netSale,
      closing_stock: closingStock,
      dip_stock: dipStock,
      variation,
      remark: payload.remarks ?? null,
    })
    .eq("id", row.id);
}

/** Fetch previous day's dip_stock for a product (from dsr_stock or dsr.stock). Returns a number. */
async function getPreviousDayDipStock(product, dateStr) {
  if (!dateStr || !product) return 0;
  const prevDateStr = getPreviousDateStr(dateStr);
  const [{ data: fromStock, error: stockErr }, { data: fromDsr, error: dsrErr }] = await Promise.all([
    supabaseClient
      .from("dsr_stock")
      .select("dip_stock")
      .eq("date", prevDateStr)
      .eq("product", product)
      .maybeSingle(),
    supabaseClient
      .from("dsr")
      .select("stock")
      .eq("date", prevDateStr)
      .eq("product", product)
      .maybeSingle(),
  ]);
  if (!stockErr && fromStock != null && Number.isFinite(Number(fromStock.dip_stock))) {
    return Number(fromStock.dip_stock);
  }
  if (!dsrErr && fromDsr != null && Number.isFinite(Number(fromDsr.stock))) {
    return Number(fromDsr.stock);
  }
  return 0;
}

/**
 * Initialize pagination controls for DSR reading history table
 */
function initDsrPaginationControls(product) {
  const historySection = document.querySelector(`#dsr-table-${product}`)?.closest(".dsr-history");
  if (!historySection) return;

  // Check if pagination controls already exist
  if (historySection.querySelector(".pagination-controls")) return;

  // Create pagination controls container
  const paginationDiv = document.createElement("div");
  paginationDiv.className = "pagination-controls";
  paginationDiv.innerHTML = `
    <div class="pagination-info">
      <span id="dsr-pagination-info-${product}" class="muted"></span>
    </div>
    <div class="pagination-buttons">
      <button type="button" id="dsr-pagination-back-${product}" class="button-secondary hidden">Back</button>
      <button type="button" id="dsr-load-more-${product}" class="button-secondary hidden">Load more</button>
    </div>
  `;
  historySection.appendChild(paginationDiv);

  const backBtn = document.getElementById(`dsr-pagination-back-${product}`);
  const loadMoreBtn = document.getElementById(`dsr-load-more-${product}`);
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      if (dsrPagination[product].currentPage > 0) {
        dsrPagination[product].currentPage--;
        loadReadingHistory(product, false);
      }
    });
  }
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener("click", () => {
      const totalPages = Math.ceil(dsrPagination[product].totalCount / DSR_RECENT_PAGE_SIZE);
      if (dsrPagination[product].currentPage < totalPages - 1) {
        dsrPagination[product].currentPage++;
        loadReadingHistory(product, false);
      }
    });
  }
}

/**
 * Load reading history with pagination support
 * @param {string} product - Product type (petrol/diesel)
 * @param {boolean} reset - If true, resets pagination and clears existing data
 */
async function loadReadingHistory(product, reset = false) {
  const tbody = document.getElementById(`dsr-table-${product}`);
  const loadMoreBtn = document.getElementById(`dsr-load-more-${product}`);
  const paginationInfo = document.getElementById(`dsr-pagination-info-${product}`);
  const pagination = dsrPagination[product];
  
  if (!tbody) return;
  
  // Prevent duplicate requests
  if (pagination.isLoading) return;
  pagination.isLoading = true;

  // Reset pagination state if needed
  const config = PUMP_CONFIG[product] || PUMP_CONFIG.petrol;
  const colCount = 7 + config.pumps; // date + pump sales + total_sales, testing, dip_reading, stock, rate, remarks

  if (reset) {
    pagination.currentPage = 0;
    pagination.totalCount = 0;
    tbody.innerHTML = `<tr><td colspan='${colCount}' class='muted'>Loading recent readings…</td></tr>`;
  }

  // Update button state
  if (loadMoreBtn) {
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = "Loading…";
  }

  try {
    const pumpCols = Array.from({ length: config.pumps }, (_, i) => `sales_pump${i + 1}`).join(", ");
    const selectCols = `date, ${pumpCols}, total_sales, testing, dip_reading, stock, petrol_rate, diesel_rate, remarks`;
    const rangeStart = pagination.currentPage * DSR_RECENT_PAGE_SIZE;
    const rangeEnd = rangeStart + DSR_RECENT_PAGE_SIZE - 1;

    let data;
    let error;

    if (reset) {
      const [countRes, pageRes] = await Promise.all([
        supabaseClient
          .from("dsr")
          .select("*", { count: "exact", head: true })
          .eq("product", product),
        supabaseClient
          .from("dsr")
          .select(selectCols)
          .eq("product", product)
          .order("date", { ascending: false })
          .range(rangeStart, rangeEnd),
      ]);

      if (!countRes.error) {
        pagination.totalCount = countRes.count || 0;
      }
      data = pageRes.data;
      error = pageRes.error;
    } else {
      const pageRes = await supabaseClient
        .from("dsr")
        .select(selectCols)
        .eq("product", product)
        .order("date", { ascending: false })
        .range(rangeStart, rangeEnd);
      data = pageRes.data;
      error = pageRes.error;
    }

    if (error) {
      if (reset) {
        tbody.innerHTML = `<tr><td colspan='${colCount}' class='error'>${escapeHtml(AppError.getUserMessage(error))}</td></tr>`;
      }
      AppError.report(error, { context: "loadReadingHistory", product });
      pagination.isLoading = false;
      updateDsrPaginationUI(product);
      return;
    }

    const dataRows = data || [];

    // Handle empty data
    if (reset && dataRows.length === 0) {
      tbody.innerHTML = `<tr><td colspan='${colCount}' class='muted'>No readings saved yet.</td></tr>`;
      pagination.isLoading = false;
      updateDsrPaginationUI(product);
      return;
    }

    // Replace tbody with current page rows
    const pumpColNames = Array.from({ length: config.pumps }, (_, i) => `sales_pump${i + 1}`);
    tbody.innerHTML = dataRows
      .map((row) => {
        const rate = product === "petrol" ? row.petrol_rate : row.diesel_rate;
        const pumpCells = pumpColNames.map((col) => `<td>${formatQuantity(row[col])}</td>`).join("");
        return `<tr>
          <td>${row.date}</td>
          ${pumpCells}
          <td>${formatQuantity(row.total_sales)}</td>
          <td>${formatQuantity(row.testing)}</td>
          <td>${formatQuantity(row.dip_reading)}</td>
          <td>${formatQuantity(row.stock)}</td>
          <td>${rate ? formatCurrency(rate) : "—"}</td>
          <td>${escapeHtml(row.remarks ?? "—")}</td>
        </tr>`;
      })
      .join("");

  } catch (err) {
    if (reset) {
      const errColCount = 7 + (PUMP_CONFIG[product] || PUMP_CONFIG.petrol).pumps;
      tbody.innerHTML = `<tr><td colspan="${errColCount}" class="error">${escapeHtml(AppError.getUserMessage(err))}</td></tr>`;
    }
    AppError.report(err, { context: "loadReadingHistory", product });
  } finally {
    pagination.isLoading = false;
    updateDsrPaginationUI(product);
  }
}

/**
 * Update pagination UI elements for DSR reading history (info text, Back, Load more).
 */
function updateDsrPaginationUI(product) {
  const backBtn = document.getElementById(`dsr-pagination-back-${product}`);
  const loadMoreBtn = document.getElementById(`dsr-load-more-${product}`);
  const paginationInfo = document.getElementById(`dsr-pagination-info-${product}`);
  const pagination = dsrPagination[product];

  if (paginationInfo) {
    if (pagination.totalCount > 0) {
      const totalPages = Math.ceil(pagination.totalCount / DSR_RECENT_PAGE_SIZE);
      const page = pagination.currentPage;
      const from = page * DSR_RECENT_PAGE_SIZE + 1;
      const to = Math.min((page + 1) * DSR_RECENT_PAGE_SIZE, pagination.totalCount);
      const total = pagination.totalCount;
      if (totalPages <= 1) {
        paginationInfo.textContent = `Showing all ${total} entries`;
      } else {
        paginationInfo.textContent = `Showing ${from}–${to} of ${total}`;
      }
    } else {
      paginationInfo.textContent = "";
    }
  }

  const totalPages = Math.ceil(pagination.totalCount / DSR_RECENT_PAGE_SIZE);
  const hasMultiplePages = totalPages > 1;
  const canGoBack = pagination.currentPage > 0;
  const canGoForward = pagination.currentPage < totalPages - 1;

  if (backBtn) {
    backBtn.disabled = !canGoBack;
    backBtn.classList.toggle("hidden", !hasMultiplePages);
  }
  if (loadMoreBtn) {
    loadMoreBtn.disabled = !canGoForward;
    loadMoreBtn.textContent = "Load more";
    loadMoreBtn.classList.toggle("hidden", !hasMultiplePages);
  }
}

// --- DSR prefill: fetch and apply helpers ---

/**
 * Fetches the DSR row to use for prefill: previous day if present, else latest before selected date.
 * @param {string} product - petrol | diesel
 * @param {string} selectedDateStr - YYYY-MM-DD
 * @param {string} selectCols - Comma-separated column names to select
 * @returns {Promise<{ row: object | null, error: Error | null }>}
 */
async function fetchDsrRowForPrefill(product, selectedDateStr, selectCols) {
  const prevDateStr = getPreviousDateStr(selectedDateStr);

  const { data: prevDayData, error: prevError } = await supabaseClient
    .from("dsr")
    .select(selectCols)
    .eq("product", product)
    .eq("date", prevDateStr)
    .maybeSingle();

  if (prevError) {
    AppError.report(prevError, { context: "fetchDsrRowForPrefill", product });
    return { row: null, error: prevError };
  }
  if (prevDayData) return { row: prevDayData, error: null };

  const { data: lastData, error: lastError } = await supabaseClient
    .from("dsr")
    .select(selectCols)
    .eq("product", product)
    .lt("date", selectedDateStr)
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lastError) {
    AppError.report(lastError, { context: "fetchDsrRowForPrefill", product });
    return { row: null, error: lastError };
  }
  return { row: lastData, error: null };
}

/**
 * Fetches the most recent non-null rate for a product from dsr.
 * @param {string} product - petrol | diesel
 * @returns {Promise<number | null>}
 */
async function fetchLastDsrRate(product) {
  const rateField = RATE_FIELD_BY_PRODUCT[product];
  if (!rateField) return null;

  const { data, error } = await supabaseClient
    .from("dsr")
    .select(rateField)
    .eq("product", product)
    .not(rateField, "is", null)
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || data?.[rateField] == null) return null;
  const num = Number(data[rateField]);
  return Number.isFinite(num) ? num : null;
}

/**
 * Applies opening meter values to the form from a DSR row, or "0.00" if no row.
 * @param {HTMLFormElement} form
 * @param {object | null} row - DSR row with closing_pump*_nozzle* fields
 * @param {{ pumps: number, nozzlesPerPump: number }} config
 */
function applyOpeningMeterToForm(form, row, config) {
  const closingFields = getClosingMeterFields(config);
  for (const closingKey of closingFields) {
    const openingKey = closingKey.replace("closing_", "opening_");
    const input = form.querySelector(`[name="${openingKey}"]`);
    if (!input) continue;

    let value = "0.00";
    if (row) {
      const v = row[closingKey];
      if (v != null && Number.isFinite(Number(v))) value = Number(v).toFixed(2);
    }
    input.value = value;
  }
}

/**
 * Sets the rate input on the form if value is a valid number.
 * @param {HTMLFormElement} form
 * @param {string} product - petrol | diesel
 * @param {number | null} rateValue
 */
function applyRateToForm(form, product, rateValue) {
  const rateField = RATE_FIELD_BY_PRODUCT[product];
  if (!rateField) return;
  const input = form.querySelector(`[name="${rateField}"]`);
  if (!input || rateValue == null || !Number.isFinite(rateValue)) return;
  input.value = rateValue.toFixed(2);
}

/**
 * Prefill opening meter and rate from previous/last DSR. Opening uses previous day, else latest before date; if none, opening is zero. Rate uses that row or last entered rate.
 * @param {string} product - petrol | diesel
 * @param {HTMLFormElement} form - The DSR reading form
 */
async function prefillOpeningFromPreviousDay(product, form) {
  const dateInput = form.querySelector("input[name='date']");
  if (!dateInput?.value) return;

  const selectedDateStr = dateInput.value;
  const config = PUMP_CONFIG[product] || PUMP_CONFIG.petrol;
  const rateField = RATE_FIELD_BY_PRODUCT[product];
  const closingFields = getClosingMeterFields(config);
  const selectCols = closingFields.join(", ") + (rateField ? ", " + rateField : "");

  const { row, error } = await fetchDsrRowForPrefill(product, selectedDateStr, selectCols);
  if (error) return;

  applyOpeningMeterToForm(form, row, config);

  const needsRateFallback =
    !row || row[rateField] == null || !Number.isFinite(Number(row[rateField]));

  const [openingStock, rateFallback] = await Promise.all([
    getPreviousDayDipStock(product, selectedDateStr),
    needsRateFallback ? fetchLastDsrRate(product) : Promise.resolve(null),
  ]);

  const openingStockInput = getFormFieldInput(form, "opening_stock");
  if (openingStockInput) {
    openingStockInput.value = openingStock > 0 ? openingStock.toFixed(2) : "";
  }

  let rateValue = row?.[rateField];
  if (rateValue == null || !Number.isFinite(Number(rateValue))) {
    rateValue = rateFallback;
  } else {
    rateValue = Number(rateValue);
  }
  applyRateToForm(form, product, rateValue);

  updateDerivedFields(form);
}

function setDefaultDate(form) {
  const dateInput = form.querySelector("input[type='date']");
  if (dateInput && !dateInput.value) {
    dateInput.value = new Date().toISOString().slice(0, 10);
  }
}

function toNumber(value) {
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? num : 0;
}

/**
 * Opening stock on meter forms uses id `{product}-opening-stock-inline` (see dsr.html).
 * Resolves inside the form so diesel/petrol stay independent.
 * @param {HTMLFormElement} form
 * @returns {HTMLInputElement | null}
 */
function getMeterReadingOpeningStockInput(form) {
  if (!form?.id?.startsWith("dsr-form-")) {
    return form?.querySelector('input[name="opening_stock"]') ?? null;
  }
  const product = form.id.slice("dsr-form-".length);
  const idSel =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? `#${CSS.escape(product)}-opening-stock-inline`
      : `#${product}-opening-stock-inline`;
  return form.querySelector(idSel) || form.querySelector('input[name="opening_stock"]');
}

function getFormFieldInput(form, name) {
  if (name === "opening_stock") {
    const meterOpening = getMeterReadingOpeningStockInput(form);
    if (meterOpening) return meterOpening;
  }
  return form.querySelector(`[name="${name}"]`);
}

function updateDerivedFields(form) {
  const product = form.id?.replace("dsr-form-", "") || "petrol";
  const config = PUMP_CONFIG[product] || PUMP_CONFIG.petrol;
  const { pumps, nozzlesPerPump } = config;

  const salesByPump = [];
  for (let p = 1; p <= pumps; p++) {
    let pumpSales = 0;
    for (let n = 1; n <= nozzlesPerPump; n++) {
      const opening = getNumber(form, `opening_pump${p}_nozzle${n}`);
      const closing = getNumber(form, `closing_pump${p}_nozzle${n}`);
      pumpSales += closing - opening;
    }
    salesByPump.push(pumpSales);
    setNumber(form, `sales_pump${p}`, pumpSales);
  }

  const totalSales = salesByPump.reduce((a, b) => a + b, 0);
  const testing = getNumber(form, "testing");
  const stock = getNumber(form, "stock");
  const openingStock = getNumber(form, "opening_stock");
  const receipts = getNumber(form, "receipts");
  const netSale = totalSales - testing;
  const totalStock = openingStock + receipts;
  const variation = stock - (totalStock - netSale);

  setNumber(form, "total_sales", totalSales);
  setNumber(form, "net_sale", netSale);
  setNumber(form, "total_stock", totalStock);
  setNumber(form, "variation", variation);
}

function getNumber(form, name) {
  const input = getFormFieldInput(form, name);
  if (!input) return 0;
  return toNumber(input.value);
}

function setNumber(form, name, value) {
  const input = getFormFieldInput(form, name);
  if (!input) return;
  if (!Number.isFinite(value)) {
    input.value = "";
    return;
  }
  input.value = value.toFixed(2);
}

function formatQuantity(value) {
  if (value === null || value === undefined) return "—";
  if (Number.isNaN(Number(value))) return "—";
  return Number(value).toLocaleString("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

