/* global supabaseClient, requireAuth, applyRoleVisibility, AppError */

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

// Pagination configuration and state
const DSR_PAGE_SIZE = 10;
const dsrPagination = {
  petrol: { offset: 0, hasMore: true, totalCount: 0, isLoading: false },
  diesel: { offset: 0, hasMore: true, totalCount: 0, isLoading: false },
};
const stockPagination = {
  petrol: { offset: 0, hasMore: true, totalCount: 0, isLoading: false },
  diesel: { offset: 0, hasMore: true, totalCount: 0, isLoading: false },
};

const stockNumberFields = [
  "opening_stock",
  "receipts",
  "total_stock",
  "sale_from_meter",
  "testing",
  "net_sale",
  "closing_stock",
  "dip_stock",
  "variation",
];

document.addEventListener("DOMContentLoaded", async () => {
  const auth = await requireAuth({
    allowedRoles: ["admin", "supervisor"],
    onDenied: "credit.html",
  });
  if (!auth) return;

  currentUserId = auth.session?.user?.id ?? null;
  applyRoleVisibility(auth.role);

  PRODUCTS.forEach((product) => {
    initReadingForm(product);
    initStockForm(product);
    initDsrPaginationControls(product);
    initStockPaginationControls(product);
    loadReadingHistory(product, true);
    loadStockHistory(product, true);
  });
});

function initReadingForm(product) {
  const form = document.getElementById(`dsr-form-${product}`);
  if (!form) return;

  setDefaultDate(form);
  updateDerivedFields(form);

  form.addEventListener("input", () => {
    updateDerivedFields(form);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const successEl = document.getElementById(`dsr-success-${product}`);
    const errorEl = document.getElementById(`dsr-error-${product}`);
    successEl?.classList.add("hidden");
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

    if (!payload.date) {
      if (errorEl) {
        errorEl.textContent = "Date is required.";
        errorEl.classList.remove("hidden");
      }
      return;
    }

    const { error } = await supabaseClient.from("dsr").insert(payload);

    if (error) {
      AppError.handle(error, { target: errorEl });
      return;
    }

    form.reset();
    setDefaultDate(form);
    successEl?.classList.remove("hidden");
    loadReadingHistory(product, true); // Reset pagination to show new entry
  });
}

function initStockForm(product) {
  const form = document.getElementById(`stock-form-${product}`);
  if (!form) return;

  setDefaultDate(form);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const successEl = document.getElementById(`stock-success-${product}`);
    const errorEl = document.getElementById(`stock-error-${product}`);
    successEl?.classList.add("hidden");
    errorEl?.classList.add("hidden");

    const formData = new FormData(form);
    const payload = {
      date: formData.get("date"),
      product,
      remark: formData.get("remark") || null,
    };
    if (currentUserId) {
      payload.created_by = currentUserId;
    }

    stockNumberFields.forEach((field) => {
      payload[field] = toNumber(formData.get(field));
    });

    if (!payload.date) {
      if (errorEl) {
        errorEl.textContent = "Date is required.";
        errorEl.classList.remove("hidden");
      }
      return;
    }

    const { error } = await supabaseClient.from("dsr_stock").insert(payload);

    if (error) {
      AppError.handle(error, { target: errorEl });
      return;
    }

    form.reset();
    setDefaultDate(form);
    successEl?.classList.remove("hidden");
    loadStockHistory(product, true); // Reset pagination to show new entry
  });
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
    <button id="dsr-load-more-${product}" class="button-secondary hidden">Load more</button>
  `;
  historySection.appendChild(paginationDiv);

  // Attach load more handler
  const loadMoreBtn = document.getElementById(`dsr-load-more-${product}`);
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener("click", () => loadReadingHistory(product, false));
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
    pagination.offset = 0;
    pagination.hasMore = true;
    pagination.totalCount = 0;
    tbody.innerHTML = `<tr><td colspan='${colCount}' class='muted'>Loading recent readings…</td></tr>`;
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
        .from("dsr")
        .select("*", { count: "exact", head: true })
        .eq("product", product);
      
      if (!countError) {
        pagination.totalCount = count || 0;
      }
    }

    const pumpCols = Array.from({ length: config.pumps }, (_, i) => `sales_pump${i + 1}`).join(", ");
    const selectCols = `date, ${pumpCols}, total_sales, testing, dip_reading, stock, petrol_rate, diesel_rate, remarks`;

    // Fetch data with pagination using range
    const { data, error } = await supabaseClient
      .from("dsr")
      .select(selectCols)
      .eq("product", product)
      .order("date", { ascending: false })
      .range(pagination.offset, pagination.offset + DSR_PAGE_SIZE - 1);

    if (error) {
      if (reset) {
        tbody.innerHTML = `<tr><td colspan='${colCount}' class='error'>${escapeHtml(AppError.getUserMessage(error))}</td></tr>`;
      }
      AppError.report(error, { context: "loadReadingHistory", product });
      pagination.isLoading = false;
      updateDsrPaginationUI(product);
      return;
    }

    // Update pagination state
    const fetchedCount = data?.length || 0;
    pagination.offset += fetchedCount;
    pagination.hasMore = fetchedCount === DSR_PAGE_SIZE;

    // Handle empty data
    if (reset && !fetchedCount) {
      tbody.innerHTML = `<tr><td colspan='${colCount}' class='muted'>No readings saved yet.</td></tr>`;
      pagination.isLoading = false;
      updateDsrPaginationUI(product);
      return;
    }

    // Clear loading message on initial load
    if (reset) {
      tbody.innerHTML = "";
    }

    // Append rows
    const pumpColNames = Array.from({ length: config.pumps }, (_, i) => `sales_pump${i + 1}`);
    data.forEach((row) => {
      const tr = document.createElement("tr");
      const rate = product === "petrol" ? row.petrol_rate : row.diesel_rate;
      const pumpCells = pumpColNames.map((col) => `<td>${formatQuantity(row[col])}</td>`).join("");
      tr.innerHTML = `
        <td>${row.date}</td>
        ${pumpCells}
        <td>${formatQuantity(row.total_sales)}</td>
        <td>${formatQuantity(row.testing)}</td>
        <td>${formatQuantity(row.dip_reading)}</td>
        <td>${formatQuantity(row.stock)}</td>
        <td>${rate ? formatCurrency(rate) : "—"}</td>
        <td>${escapeHtml(row.remarks ?? "—")}</td>
      `;
      tbody.appendChild(tr);
    });

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
 * Update pagination UI elements for DSR reading history
 */
function updateDsrPaginationUI(product) {
  const loadMoreBtn = document.getElementById(`dsr-load-more-${product}`);
  const paginationInfo = document.getElementById(`dsr-pagination-info-${product}`);
  const pagination = dsrPagination[product];
  
  // Update info text
  if (paginationInfo) {
    if (pagination.totalCount > 0) {
      const showing = Math.min(pagination.offset, pagination.totalCount);
      paginationInfo.textContent = `Showing ${showing} of ${pagination.totalCount} entries`;
    } else {
      paginationInfo.textContent = "";
    }
  }

  // Update load more button
  if (loadMoreBtn) {
    loadMoreBtn.disabled = false;
    loadMoreBtn.textContent = "Load more";
    
    if (pagination.hasMore && pagination.offset > 0) {
      loadMoreBtn.classList.remove("hidden");
    } else {
      loadMoreBtn.classList.add("hidden");
    }
  }
}

/**
 * Initialize pagination controls for stock history table
 */
function initStockPaginationControls(product) {
  const tbody = document.getElementById(`stock-table-${product}`);
  if (!tbody) return;
  
  const historySection = tbody.closest(".dsr-history") || tbody.closest(".table-scroll")?.parentElement;
  if (!historySection) return;

  // Check if pagination controls already exist
  if (historySection.querySelector(".pagination-controls")) return;

  // Create pagination controls container
  const paginationDiv = document.createElement("div");
  paginationDiv.className = "pagination-controls";
  paginationDiv.innerHTML = `
    <div class="pagination-info">
      <span id="stock-pagination-info-${product}" class="muted"></span>
    </div>
    <button id="stock-load-more-${product}" class="button-secondary hidden">Load more</button>
  `;
  historySection.appendChild(paginationDiv);

  // Attach load more handler
  const loadMoreBtn = document.getElementById(`stock-load-more-${product}`);
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener("click", () => loadStockHistory(product, false));
  }
}

/**
 * Load stock history with pagination support
 * @param {string} product - Product type (petrol/diesel)
 * @param {boolean} reset - If true, resets pagination and clears existing data
 */
async function loadStockHistory(product, reset = false) {
  const tbody = document.getElementById(`stock-table-${product}`);
  const loadMoreBtn = document.getElementById(`stock-load-more-${product}`);
  const paginationInfo = document.getElementById(`stock-pagination-info-${product}`);
  const pagination = stockPagination[product];
  
  if (!tbody) return;
  
  // Prevent duplicate requests
  if (pagination.isLoading) return;
  pagination.isLoading = true;

  // Reset pagination state if needed
  if (reset) {
    pagination.offset = 0;
    pagination.hasMore = true;
    pagination.totalCount = 0;
    tbody.innerHTML = "<tr><td colspan='11' class='muted'>Loading stock entries…</td></tr>";
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
        .from("dsr_stock")
        .select("*", { count: "exact", head: true })
        .eq("product", product);
      
      if (!countError) {
        pagination.totalCount = count || 0;
      }
    }

    // Fetch data with pagination using range
    const { data, error } = await supabaseClient
      .from("dsr_stock")
      .select(
        "date, opening_stock, receipts, total_stock, sale_from_meter, testing, net_sale, closing_stock, dip_stock, variation, remark"
      )
      .eq("product", product)
      .order("date", { ascending: false })
      .range(pagination.offset, pagination.offset + DSR_PAGE_SIZE - 1);

    if (error) {
      if (reset) {
        tbody.innerHTML = `<tr><td colspan='11' class='error'>${escapeHtml(AppError.getUserMessage(error))}</td></tr>`;
      }
      AppError.report(error, { context: "loadStockHistory", product });
      pagination.isLoading = false;
      updateStockPaginationUI(product);
      return;
    }

    // Update pagination state
    const fetchedCount = data?.length || 0;
    pagination.offset += fetchedCount;
    pagination.hasMore = fetchedCount === DSR_PAGE_SIZE;

    // Handle empty data
    if (reset && !fetchedCount) {
      tbody.innerHTML = "<tr><td colspan='11' class='muted'>No stock records yet.</td></tr>";
      pagination.isLoading = false;
      updateStockPaginationUI(product);
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
        <td>${formatQuantity(row.opening_stock)}</td>
        <td>${formatQuantity(row.receipts)}</td>
        <td>${formatQuantity(row.total_stock)}</td>
        <td>${formatQuantity(row.sale_from_meter)}</td>
        <td>${formatQuantity(row.testing)}</td>
        <td>${formatQuantity(row.net_sale)}</td>
        <td>${formatQuantity(row.closing_stock)}</td>
        <td>${formatQuantity(row.dip_stock)}</td>
        <td>${formatQuantity(row.variation)}</td>
        <td>${escapeHtml(row.remark ?? "—")}</td>
      `;
      tbody.appendChild(tr);
    });

  } catch (err) {
    if (reset) {
      tbody.innerHTML = `<tr><td colspan="11" class="error">${escapeHtml(AppError.getUserMessage(err))}</td></tr>`;
    }
    AppError.report(err, { context: "loadStockHistory", product });
  } finally {
    pagination.isLoading = false;
    updateStockPaginationUI(product);
  }
}

/**
 * Update pagination UI elements for stock history
 */
function updateStockPaginationUI(product) {
  const loadMoreBtn = document.getElementById(`stock-load-more-${product}`);
  const paginationInfo = document.getElementById(`stock-pagination-info-${product}`);
  const pagination = stockPagination[product];
  
  // Update info text
  if (paginationInfo) {
    if (pagination.totalCount > 0) {
      const showing = Math.min(pagination.offset, pagination.totalCount);
      paginationInfo.textContent = `Showing ${showing} of ${pagination.totalCount} entries`;
    } else {
      paginationInfo.textContent = "";
    }
  }

  // Update load more button
  if (loadMoreBtn) {
    loadMoreBtn.disabled = false;
    loadMoreBtn.textContent = "Load more";
    
    if (pagination.hasMore && pagination.offset > 0) {
      loadMoreBtn.classList.remove("hidden");
    } else {
      loadMoreBtn.classList.add("hidden");
    }
  }
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
  const input = form.querySelector(`[name="${name}"]`);
  if (!input) return 0;
  return toNumber(input.value);
}

function setNumber(form, name, value) {
  const input = form.querySelector(`[name="${name}"]`);
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

