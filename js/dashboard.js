/* global supabaseClient, requireAuth, applyRoleVisibility, formatCurrency, AppCache, AppError, getValidFilterState, setFilterState */

// Simple HTML escape for XSS prevention
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Generate cache key for dashboard data queries
 */
function getDashboardCacheKey(startDate, endDate) {
  return `dashboard_${startDate}_${endDate}`;
}

/**
 * Generate cache key for today's sales
 */
function getTodaySalesCacheKey(dateStr) {
  return `today_sales_net_${dateStr}`;
}

/**
 * Generate cache key for credit summary
 */
function getCreditSummaryCacheKey(dateStr) {
  return `credit_summary_${dateStr}`;
}

let snapshotDsrRows = [];

function normalizeProduct(value) {
  return String(value ?? "").trim().toLowerCase();
}

let statFitRaf = null;

function fitTextToContainer(el, options = {}) {
  if (!el) return;
  const {
    minFontPx = 12,
    paddingPx = 2,
  } = options;

  const parent = el.parentElement;
  if (!parent) return;

  const maxFontPx =
    Number(el.dataset.maxFontPx) ||
    Number.parseFloat(window.getComputedStyle(el).fontSize) ||
    16;
  if (!el.dataset.maxFontPx) {
    el.dataset.maxFontPx = String(maxFontPx);
  }

  // Measure at max size first.
  el.style.fontSize = `${maxFontPx}px`;
  // Force a reflow to update scrollWidth accurately in some browsers.
  // eslint-disable-next-line no-unused-expressions
  el.offsetWidth;

  const available = Math.max(0, parent.getBoundingClientRect().width - paddingPx);
  const needed = el.scrollWidth;
  if (!available || !needed) return;

  if (needed <= available) {
    el.style.fontSize = `${maxFontPx}px`;
    return;
  }

  const ratio = available / needed;
  const next = Math.max(minFontPx, Math.floor(maxFontPx * ratio * 0.98));
  el.style.fontSize = `${next}px`;
}

function autoFitStats(scope = document) {
  const elements = scope.querySelectorAll(
    ".metric-box .stat, .stat-tile .stat"
  );
  elements.forEach((el) => {
    const isSub = el.classList.contains("stat-sub");
    fitTextToContainer(el, { minFontPx: isSub ? 10 : 12 });
  });
}

function scheduleAutoFitStats() {
  if (statFitRaf) cancelAnimationFrame(statFitRaf);
  statFitRaf = requestAnimationFrame(() => {
    statFitRaf = null;
    autoFitStats(document);
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  const auth = await requireAuth({
    allowedRoles: ["admin", "supervisor"],
    onDenied: "credit.html",
  });
  if (!auth) return;

  const { session, role } = auth;
  applyRoleVisibility(role);

  const operatorInfo = document.getElementById("operator-info");
  if (operatorInfo) {
    operatorInfo.textContent = session.user.email;
  }

  const snapshotDateInput = document.getElementById("snapshot-date");
  const petrolRateInput = document.getElementById("snapshot-petrol-rate");
  const dieselRateInput = document.getElementById("snapshot-diesel-rate");
  const todayStr = new Date().toISOString().slice(0, 10);
  
  const enforceRateFieldsReadOnly = () => {
    if (petrolRateInput) petrolRateInput.readOnly = true;
    if (dieselRateInput) dieselRateInput.readOnly = true;
  };

  const SNAPSHOT_RANGE = new Set(["date"]);
  const storedSnapshot = typeof window.getValidFilterState === "function"
    ? window.getValidFilterState("dashboard_snapshot", SNAPSHOT_RANGE)
    : null;
  const snapshotDateStr = storedSnapshot?.start || todayStr;
  if (snapshotDateInput) {
    snapshotDateInput.value = snapshotDateStr;
    enforceRateFieldsReadOnly();
    window.setFilterState && window.setFilterState("dashboard_snapshot", { range: "date", start: snapshotDateStr });
    const updateSalesDailyLink = () => {
      const link = document.getElementById("sales-daily-link");
      if (link) link.href = "sales-daily.html?date=" + (snapshotDateInput.value || todayStr);
    };
    updateSalesDailyLink();
    const salesDailyLink = document.getElementById("sales-daily-link");
    if (salesDailyLink) {
      salesDailyLink.addEventListener("click", () => {
        try {
          sessionStorage.setItem("petrolpump_sales_daily_from_dashboard", snapshotDateInput.value || todayStr);
        } catch (_) {}
      });
    }
    snapshotDateInput.addEventListener("change", async () => {
      const dateValue = snapshotDateInput.value || todayStr;
      enforceRateFieldsReadOnly();
      window.setFilterState && window.setFilterState("dashboard_snapshot", { range: "date", start: dateValue });
      updateSalesDailyLink();
      await Promise.all([loadTodaySales(dateValue), loadCreditSummary(dateValue)]);
    });
  }
  enforceRateFieldsReadOnly();

  try {
    await Promise.all([
      loadTodaySales(snapshotDateStr),
      loadCreditSummary(snapshotDateStr),
      initializeDsrDashboard(),
      initializeProfitLossFilter(),
      loadRecentActivity(),
    ]);
    console.log("All dashboard initializations completed successfully");
    scheduleAutoFitStats();
  } catch (error) {
    AppError.handle(error, { context: { source: "dashboardInit" } });
  }
});

async function initializeDsrDashboard() {
  const rangeSelect = document.getElementById("dsr-range");
  const startInput = document.getElementById("dsr-start");
  const endInput = document.getElementById("dsr-end");
  const form = document.getElementById("dsr-filter-form");
  const customRange = document.getElementById("dsr-custom-range");
  const label = document.getElementById("dsr-date-label");

  if (!rangeSelect || !startInput || !endInput || !form || !customRange) {
    return;
  }

  const DASHBOARD_RANGES = new Set(["today", "this-week", "this-month", "custom"]);
  const stored = typeof window.getValidFilterState === "function"
    ? window.getValidFilterState("dashboard_dsr", DASHBOARD_RANGES)
    : null;
  if (stored) {
    rangeSelect.value = stored.range;
    if (stored.range === "custom" && stored.start && stored.end) {
      startInput.value = stored.start;
      endInput.value = stored.end;
    }
  } else {
    rangeSelect.value = "today";
  }

  const isCustomInitial = rangeSelect.value === "custom";
  setCustomRangeVisibility(customRange, startInput, endInput, isCustomInitial);
  
  if (isCustomInitial && !startInput.value && !endInput.value) {
    const today = new Date();
    startInput.value = formatDateInput(today);
    endInput.value = formatDateInput(today);
  }
  
  const initialRange = getRangeForSelection(
    rangeSelect.value,
    startInput,
    endInput
  );
  if (initialRange) {
    updateDsrLabel(initialRange, initialRange.modeInfo);
    await loadDsrSummary(initialRange);
  }

  const saveDsrFilter = () => {
    window.setFilterState && window.setFilterState("dashboard_dsr", {
      range: rangeSelect.value,
      start: startInput.value || undefined,
      end: endInput.value || undefined,
    });
  };

  rangeSelect.addEventListener("change", async () => {
    const isCustom = rangeSelect.value === "custom";
    setCustomRangeVisibility(customRange, startInput, endInput, isCustom);
    if (isCustom && !startInput.value && !endInput.value) {
      const today = new Date();
      startInput.value = formatDateInput(today);
      endInput.value = formatDateInput(today);
    }
    saveDsrFilter();
    const range = getRangeForSelection(rangeSelect.value, startInput, endInput);
    if (!range) return;
    updateDsrLabel(range, range.modeInfo);
    await loadDsrSummary(range);
    if (isCustom) saveDsrFilter();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    
    // Validate custom date range
    if (rangeSelect.value === "custom") {
      if (startInput.value && endInput.value && startInput.value > endInput.value) {
        alert("Start date cannot be after end date. Please select valid dates.");
        return;
      }
    }
    
    const range = getRangeForSelection(
      rangeSelect.value,
      startInput,
      endInput
    );
    if (!range) return;
    updateDsrLabel(range, range.modeInfo);
    await loadDsrSummary(range);
    saveDsrFilter();
  });

  const handleCustomChange = async () => {
    if (rangeSelect.value !== "custom") return;
    
    // Validate custom date range
    if (startInput.value && endInput.value && startInput.value > endInput.value) {
      console.warn("Start date is after end date, skipping load");
      return;
    }
    
    const range = getRangeForSelection(
      rangeSelect.value,
      startInput,
      endInput
    );
    if (!range) return;
    updateDsrLabel(range, range.modeInfo);
    await loadDsrSummary(range);
    saveDsrFilter();
  };

  startInput.addEventListener("change", handleCustomChange);
  endInput.addEventListener("change", handleCustomChange);
}

async function loadTodaySales(dateStr) {
  const todayStat = document.getElementById("today-total");
  const todayRupees = document.getElementById("today-total-rupees");
  const todayDate = document.getElementById("today-date");
  const petrolRateInput = document.getElementById("snapshot-petrol-rate");
  const dieselRateInput = document.getElementById("snapshot-diesel-rate");

  const selectedDate = dateStr || new Date().toISOString().slice(0, 10);
  const cacheKey = getTodaySalesCacheKey(selectedDate);

  // Use stale-while-revalidate pattern for cached data
  const fetchFn = async () => {
    const { data, error } = await supabaseClient
      .from("dsr")
      .select("product, total_sales, testing, petrol_rate, diesel_rate")
      .eq("date", selectedDate);

    if (error) {
      AppError.report(error, { context: "loadTodaySales", date: selectedDate });
      return null;
    }
    return data ?? [];
  };

  // Callback to update UI when fresh data arrives
  const onUpdate = (freshData) => {
    renderTodaySales(freshData, selectedDate, todayStat, todayRupees, todayDate, petrolRateInput, dieselRateInput);
  };

  // Try to get cached data with SWR pattern
  let data;
  if (AppCache) {
    data = await AppCache.getWithSWR(cacheKey, fetchFn, "today_sales", onUpdate);
  } else {
    data = await fetchFn();
  }

  renderTodaySales(data, selectedDate, todayStat, todayRupees, todayDate, petrolRateInput, dieselRateInput);
}

/**
 * Render today's sales data to UI
 */
function renderTodaySales(data, selectedDate, todayStat, todayRupees, todayDate, petrolRateInput, dieselRateInput) {
  if (!data) {
    snapshotDsrRows = [];
    if (todayStat) todayStat.textContent = "—";
    if (todayDate) {
      const labelDate = new Date(`${selectedDate}T00:00:00`);
      todayDate.textContent = `for ${labelDate.toLocaleDateString("en-IN", {
        weekday: "short",
        month: "short",
        day: "numeric",
      })}`;
    }
    if (todayRupees) todayRupees.textContent = "—";
    if (petrolRateInput) petrolRateInput.value = "";
    if (dieselRateInput) dieselRateInput.value = "";
    scheduleAutoFitStats();
    return;
  }

  snapshotDsrRows = data;

  const petrolNetSale = sumByProduct(
    snapshotDsrRows,
    "petrol",
    (row) => Number(row.total_sales ?? 0) - Number(row.testing ?? 0)
  );
  const dieselNetSale = sumByProduct(
    snapshotDsrRows,
    "diesel",
    (row) => Number(row.total_sales ?? 0) - Number(row.testing ?? 0)
  );
  const totalLiters = petrolNetSale + dieselNetSale;

  // Fetch and set rates from DSR data (if columns exist)
  const petrolEntry = snapshotDsrRows.find(
    (row) => normalizeProduct(row.product) === "petrol"
  );
  const dieselEntry = snapshotDsrRows.find(
    (row) => normalizeProduct(row.product) === "diesel"
  );

  if (petrolEntry?.petrol_rate !== undefined && petrolRateInput) {
    petrolRateInput.value = petrolEntry.petrol_rate;
  } else if (petrolRateInput) {
    petrolRateInput.value = "";
  }

  if (dieselEntry?.diesel_rate !== undefined && dieselRateInput) {
    dieselRateInput.value = dieselEntry.diesel_rate;
  } else if (dieselRateInput) {
    dieselRateInput.value = "";
  }

  if (todayStat) {
    todayStat.textContent = formatQuantity(totalLiters);
  }
  updateTotalSaleRupees();
  scheduleAutoFitStats();
  if (todayDate) {
    const labelDate = new Date(`${selectedDate}T00:00:00`);
    todayDate.textContent = `for ${labelDate.toLocaleDateString("en-IN", {
      weekday: "short",
      month: "short",
      day: "numeric",
    })}`;
  }
}

function updateTotalSaleRupees() {
  const todayRupees = document.getElementById("today-total-rupees");
  if (!todayRupees) return;

  // Get rates from snapshotDsrRows directly, not from input fields
  const petrolEntry = snapshotDsrRows.find(
    (row) => normalizeProduct(row.product) === "petrol"
  );
  const dieselEntry = snapshotDsrRows.find(
    (row) => normalizeProduct(row.product) === "diesel"
  );
  
  // Use rates from DSR if available, otherwise use input fields
  let petrolRate = Number(petrolEntry?.petrol_rate || 0);
  let dieselRate = Number(dieselEntry?.diesel_rate || 0);

  // If rates are 0 (null/undefined), try to get from input fields
  if (petrolRate === 0) {
    petrolRate = Number(document.getElementById("snapshot-petrol-rate")?.value || 0);
  }
  if (dieselRate === 0) {
    dieselRate = Number(document.getElementById("snapshot-diesel-rate")?.value || 0);
  }

  // Only show currency if at least one rate is available and valid
  if (!Number.isFinite(petrolRate) && !Number.isFinite(dieselRate)) {
    todayRupees.textContent = "—";
    return;
  }

  const petrolLiters = sumByProduct(
    snapshotDsrRows,
    "petrol",
    (row) => Number(row.total_sales ?? 0) - Number(row.testing ?? 0)
  );
  const dieselLiters = sumByProduct(
    snapshotDsrRows,
    "diesel",
    (row) => Number(row.total_sales ?? 0) - Number(row.testing ?? 0)
  );
  
  const totalAmount = petrolLiters * petrolRate + dieselLiters * dieselRate;
  
  if (totalAmount === 0) {
    todayRupees.textContent = "—";
  } else {
    todayRupees.textContent = formatCurrency(totalAmount);
  }
  scheduleAutoFitStats();
}

async function loadCreditSummary(dateStr) {
  const creditTotal = document.getElementById("credit-total");
  const selectedDate = dateStr || new Date().toISOString().slice(0, 10);
  const endOfDayISO = `${selectedDate}T23:59:59.999Z`;
  const cacheKey = getCreditSummaryCacheKey(selectedDate);

  const fetchFn = async () => {
    // Filter in database: last_payment <= date OR (last_payment is null AND created_at <= endOfDay)
    const { data, error } = await supabaseClient
      .from("credit_customers")
      .select("amount_due")
      .gt("amount_due", 0)
      .or(
        `and(last_payment.not.is.null,last_payment.lte.${selectedDate}),` +
        `and(last_payment.is.null,created_at.lte.${endOfDayISO})`
      );

    if (error) {
      AppError.report(error, { context: "loadCreditSummary", date: selectedDate });
      return null;
    }
    return data ?? [];
  };

  // Callback to update UI when fresh data arrives
  const onUpdate = (freshData) => {
    renderCreditSummary(freshData, creditTotal);
  };

  // Try to get cached data with SWR pattern
  let data;
  if (AppCache) {
    data = await AppCache.getWithSWR(cacheKey, fetchFn, "credit_summary", onUpdate);
  } else {
    data = await fetchFn();
  }

  renderCreditSummary(data, creditTotal);
}

/**
 * Render credit summary to UI
 */
function renderCreditSummary(data, creditTotal) {
  if (!data) {
    if (creditTotal) creditTotal.textContent = "—";
    return;
  }

  const total = data.reduce((sum, row) => sum + Number(row.amount_due ?? 0), 0);
  if (creditTotal) creditTotal.textContent = formatCurrency(total);
}

function calculateIncome(rows) {
  let total = 0;
  let missingRates = 0;

  (rows ?? []).forEach((row) => {
    const netSale = Number(row.total_sales ?? 0) - Number(row.testing ?? 0);
    if (!Number.isFinite(netSale) || netSale <= 0) return;

    const rate =
      row.product === "petrol"
        ? Number(row.petrol_rate)
        : Number(row.diesel_rate);
    const hasRate = Number.isFinite(rate) && rate > 0;

    if (!hasRate) {
      missingRates += 1;
      return;
    }

    total += netSale * rate;
  });

  return { total, missingRates };
}

async function loadRecentActivity() {
  const list = document.getElementById("recent-log");
  if (!list) return;
  list.innerHTML = "<li class='muted'>Fetching recent activity…</li>";

  const cacheKey = "recent_activity";

  const fetchFn = async () => {
    const [{ data: dsrData, error: dsrError }, { data: creditData, error: creditError }] =
      await Promise.all([
        supabaseClient
          .from("dsr")
          .select("date, product, total_sales, created_at")
          .order("created_at", { ascending: false })
          .limit(4),
        supabaseClient
          .from("credit_customers")
          .select("customer_name, amount_due, created_at")
          .order("created_at", { ascending: false })
          .limit(4),
      ]);

    if (dsrError) AppError.report(dsrError, { context: "loadRecentActivity", type: "dsr" });
    if (creditError) AppError.report(creditError, { context: "loadRecentActivity", type: "credit" });

    return {
      dsrData: dsrData ?? [],
      creditData: creditData ?? [],
    };
  };

  // Callback to update UI when fresh data arrives
  const onUpdate = (freshData) => {
    renderRecentActivity(freshData, list);
  };

  // Try to get cached data with SWR pattern
  let data;
  if (AppCache) {
    data = await AppCache.getWithSWR(cacheKey, fetchFn, "recent_activity", onUpdate);
  } else {
    data = await fetchFn();
  }

  renderRecentActivity(data, list);
}

/**
 * Render recent activity to UI
 */
function renderRecentActivity(data, list) {
  if (!list) return;

  const entries = [];

  (data?.dsrData ?? []).forEach((row) => {
    entries.push({
      type: "DSR",
      label: `${row.product?.toUpperCase() ?? ""}`,
      detail: formatCurrency(row.total_sales),
      timestamp: row.created_at ?? row.date,
    });
  });

  (data?.creditData ?? []).forEach((row) => {
    entries.push({
      type: "Credit",
      label: `${row.customer_name} updated`,
      detail: formatCurrency(row.amount_due),
      timestamp: row.created_at,
    });
  });

  entries.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  if (!entries.length) {
    list.innerHTML = "<li class='muted'>No recent activity.</li>";
    return;
  }

  list.innerHTML = "";
  entries.slice(0, 8).forEach((entry) => {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${escapeHtml(entry.type)}:</strong> ${escapeHtml(entry.label)} · ${escapeHtml(entry.detail)}`;
    list.appendChild(li);
  });
}

/**
 * Fetches dashboard data using Edge Function (single round-trip) with fallback
 * to parallel client-side queries if the Edge Function is unavailable.
 * Uses stale-while-revalidate caching pattern.
 */
async function fetchDashboardData(startDate, endDate, onUpdate = null) {
  const cacheKey = getDashboardCacheKey(startDate, endDate);

  const fetchFn = async () => {
    try {
      // Edge Function with retry; we retry only on transient errors (via isTransientError)
      const { data, error } = await AppError.withRetry(
        () =>
          supabaseClient.functions.invoke("get-dashboard-data", {
            body: { startDate, endDate },
          }),
        { maxAttempts: 3 }
      );

      if (error) {
        throw error;
      }

      return {
        dsrData: data.dsrData,
        stockData: data.stockData,
        expenseData: data.expenseData,
        dsrError: data.errors?.dsr ? new Error(data.errors.dsr) : null,
        stockError: data.errors?.stock ? new Error(data.errors.stock) : null,
        expenseError: data.errors?.expense ? new Error(data.errors.expense) : null,
      };
    } catch {
      // Fallback: use parallel client-side queries
      const [dsrResult, stockResult, expenseResult] = await Promise.all([
        supabaseClient
          .from("dsr")
          .select("product, total_sales, testing, stock, petrol_rate, diesel_rate")
          .gte("date", startDate)
          .lte("date", endDate),
        supabaseClient
          .from("dsr_stock")
          .select("product, variation")
          .gte("date", startDate)
          .lte("date", endDate),
        supabaseClient
          .from("expenses")
          .select("*")
          .gte("date", startDate)
          .lte("date", endDate),
      ]);

      return {
        dsrData: dsrResult.data,
        stockData: stockResult.data,
        expenseData: expenseResult.data,
        dsrError: dsrResult.error,
        stockError: stockResult.error,
        expenseError: expenseResult.error,
      };
    }
  };

  // Use stale-while-revalidate pattern
  if (AppCache) {
    return AppCache.getWithSWR(cacheKey, fetchFn, "dashboard_data", onUpdate);
  }

  return fetchFn();
}

async function loadDsrSummary(range) {
  const elements = {
    petrolStockEl: document.getElementById("dsr-petrol-stock"),
    dieselStockEl: document.getElementById("dsr-diesel-stock"),
    petrolNetSaleEl: document.getElementById("dsr-petrol-net-sale"),
    dieselNetSaleEl: document.getElementById("dsr-diesel-net-sale"),
    petrolNetSaleRupeesEl: document.getElementById("dsr-petrol-net-sale-rupees"),
    dieselNetSaleRupeesEl: document.getElementById("dsr-diesel-net-sale-rupees"),
    petrolVariationEl: document.getElementById("dsr-petrol-variation"),
    dieselVariationEl: document.getElementById("dsr-diesel-variation"),
    expenseEl: document.getElementById("dsr-expense"),
  };

  // Show loading state
  Object.values(elements).forEach((el) => {
    if (el) el.textContent = "Loading…";
  });

  // Callback to update UI when fresh data arrives
  const onUpdate = (freshData) => {
    renderDsrSummary(freshData, elements);
  };

  // Use Edge Function for single round-trip (with fallback and caching)
  const dashboardData = await fetchDashboardData(range.start, range.end, onUpdate);
  renderDsrSummary(dashboardData, elements);
}

/**
 * Render DSR summary data to UI elements
 */
function renderDsrSummary(data, elements) {
  const {
    petrolStockEl, dieselStockEl, petrolNetSaleEl, dieselNetSaleEl,
    petrolNetSaleRupeesEl, dieselNetSaleRupeesEl, petrolVariationEl,
    dieselVariationEl, expenseEl
  } = elements;

  const { dsrData, stockData, expenseData, dsrError, stockError, expenseError } = data || {};

  if (dsrError) AppError.report(dsrError, { context: "renderDsrSummary", type: "dsr" });
  if (stockError) AppError.report(stockError, { context: "renderDsrSummary", type: "stock" });
  if (expenseError) AppError.report(expenseError, { context: "renderDsrSummary", type: "expense" });

  const hasDsr = !dsrError;
  const hasStock = !stockError;
  const hasExpense = !expenseError;

  const petrolStock = sumByProduct(dsrData, "petrol", (row) => row.stock);
  const dieselStock = sumByProduct(dsrData, "diesel", (row) => row.stock);
  const petrolNetSale = sumByProduct(
    dsrData,
    "petrol",
    (row) => Number(row.total_sales ?? 0) - Number(row.testing ?? 0)
  );
  const dieselNetSale = sumByProduct(
    dsrData,
    "diesel",
    (row) => Number(row.total_sales ?? 0) - Number(row.testing ?? 0)
  );
  const petrolVariation = sumByProduct(
    stockData,
    "petrol",
    (row) => row.variation
  );
  const dieselVariation = sumByProduct(
    stockData,
    "diesel",
    (row) => row.variation
  );
  const expenseTotal = (expenseData ?? []).reduce(
    (sum, row) => sum + Number(row.amount ?? 0),
    0
  );

  // Get rates from DSR data (use the latest non-zero rate)
  const petrolRates = (dsrData ?? [])
    .filter((row) => normalizeProduct(row.product) === "petrol" && row.petrol_rate > 0)
    .map((row) => row.petrol_rate);
  const dieselRates = (dsrData ?? [])
    .filter((row) => normalizeProduct(row.product) === "diesel" && row.diesel_rate > 0)
    .map((row) => row.diesel_rate);
  const dsrPetrolRate = petrolRates.length > 0 ? petrolRates[petrolRates.length - 1] : 0;
  const dsrDieselRate = dieselRates.length > 0 ? dieselRates[dieselRates.length - 1] : 0;

  if (petrolStockEl) {
    petrolStockEl.textContent = hasDsr ? formatQuantity(petrolStock) : "—";
  }
  if (dieselStockEl) {
    dieselStockEl.textContent = hasDsr ? formatQuantity(dieselStock) : "—";
  }
  if (petrolNetSaleEl) {
    petrolNetSaleEl.textContent = hasDsr ? formatQuantity(petrolNetSale) : "—";
  }
  if (dieselNetSaleEl) {
    dieselNetSaleEl.textContent = hasDsr ? formatQuantity(dieselNetSale) : "—";
  }
  updateDsrNetSaleRupees(petrolNetSale, dieselNetSale, hasDsr, dsrPetrolRate, dsrDieselRate);
  if (petrolVariationEl) {
    petrolVariationEl.textContent = hasStock ? formatQuantity(petrolVariation) : "—";
    applyVariationTone(petrolVariationEl, petrolVariation, hasStock);
  }
  if (dieselVariationEl) {
    dieselVariationEl.textContent = hasStock ? formatQuantity(dieselVariation) : "—";
    applyVariationTone(dieselVariationEl, dieselVariation, hasStock);
  }
  if (expenseEl) {
    expenseEl.textContent = hasExpense ? formatCurrency(expenseTotal) : "—";
  }
  scheduleAutoFitStats();
}

async function initializeProfitLossFilter() {
  const rangeSelect = document.getElementById("pl-range");
  const startInput = document.getElementById("pl-start");
  const endInput = document.getElementById("pl-end");
  const form = document.getElementById("pl-filter-form");
  const customRange = document.getElementById("pl-custom-range");
  const label = document.getElementById("pl-date-label");

  if (!rangeSelect || !startInput || !endInput || !form || !customRange || !label) {
    return;
  }

  const DASHBOARD_RANGES = new Set(["today", "this-week", "this-month", "custom"]);
  const storedPl = typeof window.getValidFilterState === "function"
    ? window.getValidFilterState("dashboard_pl", DASHBOARD_RANGES)
    : null;
  if (storedPl) {
    rangeSelect.value = storedPl.range;
    if (storedPl.range === "custom" && storedPl.start && storedPl.end) {
      startInput.value = storedPl.start;
      endInput.value = storedPl.end;
    }
  } else {
    rangeSelect.value = "today";
  }

  const isCustom = rangeSelect.value === "custom";
  setCustomRangeVisibility(customRange, startInput, endInput, isCustom);
  
  if (isCustom && !startInput.value && !endInput.value) {
    const today = new Date();
    startInput.value = formatDateInput(today);
    endInput.value = formatDateInput(today);
  }
  
  const initialRange = getRangeForSelection(
    rangeSelect.value,
    startInput,
    endInput
  );
  if (initialRange) {
    updatePlLabel(initialRange, initialRange.modeInfo, label);
    await loadProfitLossSummary(initialRange);
  }

  const savePlFilter = () => {
    window.setFilterState && window.setFilterState("dashboard_pl", {
      range: rangeSelect.value,
      start: startInput.value || undefined,
      end: endInput.value || undefined,
    });
  };

  rangeSelect.addEventListener("change", async () => {
    const isCustom = rangeSelect.value === "custom";
    const customRangeEl = document.getElementById("pl-custom-range");
    const startEl = document.getElementById("pl-start");
    const endEl = document.getElementById("pl-end");
    const labelEl = document.getElementById("pl-date-label");

    if (customRangeEl && startEl && endEl) {
      setCustomRangeVisibility(customRangeEl, startEl, endEl, isCustom);
    }
    if (isCustom && startEl && endEl && !startEl.value && !endEl.value) {
      const today = new Date();
      startEl.value = formatDateInput(today);
      endEl.value = formatDateInput(today);
    }
    savePlFilter();
    const range = getRangeForSelection(rangeSelect.value, startEl, endEl);
    if (!range) return;
    if (labelEl) updatePlLabel(range, range.modeInfo, labelEl);
    await loadProfitLossSummary(range);
    if (isCustom) savePlFilter();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    
    const startEl = document.getElementById("pl-start");
    const endEl = document.getElementById("pl-end");
    const labelEl = document.getElementById("pl-date-label");

    if (rangeSelect.value === "custom") {
      if (startEl?.value && endEl?.value && startEl.value > endEl.value) {
        alert("Start date cannot be after end date. Please select valid dates.");
        return;
      }
    }

    const range = getRangeForSelection(
      rangeSelect.value,
      startEl,
      endEl
    );
    if (!range) return;
    if (labelEl) {
      updatePlLabel(range, range.modeInfo, labelEl);
    }
    await loadProfitLossSummary(range);
    savePlFilter();
  });

  const handleCustomChange = async () => {
    if (rangeSelect.value !== "custom") return;
    
    const startEl = document.getElementById("pl-start");
    const endEl = document.getElementById("pl-end");
    const labelEl = document.getElementById("pl-date-label");

    if (startEl?.value && endEl?.value && startEl.value > endEl.value) {
      return;
    }

    const range = getRangeForSelection(
      rangeSelect.value,
      startEl,
      endEl
    );
    if (!range) return;
    if (labelEl) {
      updatePlLabel(range, range.modeInfo, labelEl);
    }
    await loadProfitLossSummary(range);
    savePlFilter();
  };

  startInput.addEventListener("change", handleCustomChange);
  endInput.addEventListener("change", handleCustomChange);
}

async function loadProfitLossSummary(range) {
  const plNetSaleEl = document.getElementById("pl-net-sale");
  const plExpenseEl = document.getElementById("pl-expense");
  const plValueEl = document.getElementById("pl-value");
  const plLabelEl = document.getElementById("pl-label");
  const incomeEl = document.getElementById("income-total");
  const incomeNoteEl = document.getElementById("income-note");

  if (plNetSaleEl) plNetSaleEl.textContent = "Loading…";
  if (plExpenseEl) plExpenseEl.textContent = "Loading…";
  if (plValueEl) plValueEl.textContent = "Loading…";
  if (incomeEl) incomeEl.textContent = "Loading…";
  if (incomeNoteEl) incomeNoteEl.textContent = "";

  const [
    { data: dsrData, error: dsrError },
    { data: expenseData, error: expenseError },
  ] = await Promise.all([
    supabaseClient
      .from("dsr")
      .select("product, total_sales, testing, petrol_rate, diesel_rate")
      .gte("date", range.start)
      .lte("date", range.end),
    supabaseClient
      .from("expenses")
      .select("*")
      .gte("date", range.start)
      .lte("date", range.end),
  ]);

  if (dsrError) AppError.report(dsrError, { context: "profitLossSummary", type: "dsr" });
  if (expenseError) AppError.report(expenseError, { context: "profitLossSummary", type: "expense" });

  const hasDsr = !dsrError;
  const hasExpense = !expenseError;
  const income = calculateIncome(dsrData ?? []);

  const petrolNetSale = sumByProduct(
    dsrData,
    "petrol",
    (row) => Number(row.total_sales ?? 0) - Number(row.testing ?? 0)
  );
  const dieselNetSale = sumByProduct(
    dsrData,
    "diesel",
    (row) => Number(row.total_sales ?? 0) - Number(row.testing ?? 0)
  );
  const totalNetSale = petrolNetSale + dieselNetSale;
  const expenseTotal = (expenseData ?? []).reduce(
    (sum, row) => sum + Number(row.amount ?? 0),
    0
  );

  if (plNetSaleEl) {
    plNetSaleEl.textContent = hasDsr ? formatCurrency(totalNetSale) : "—";
  }
  if (plExpenseEl) {
    plExpenseEl.textContent = hasExpense ? formatCurrency(expenseTotal) : "—";
  }

  if (plValueEl && plLabelEl) {
    if (!hasDsr || !hasExpense) {
      plValueEl.textContent = "—";
      plLabelEl.textContent = "Profit / Loss";
      plValueEl.classList.remove("stat-negative", "stat-positive");
    } else {
      const profitLoss = totalNetSale - expenseTotal;
      plValueEl.textContent = formatCurrency(profitLoss);
      plLabelEl.textContent = profitLoss >= 0 ? "Profit" : "Loss";
      plValueEl.classList.toggle("stat-positive", profitLoss >= 0);
      plValueEl.classList.toggle("stat-negative", profitLoss < 0);
    }
  }

  if (incomeEl) {
    incomeEl.textContent =
      hasDsr && (dsrData ?? []).length ? formatCurrency(income.total) : "—";
  }
  if (incomeNoteEl) {
    incomeNoteEl.textContent =
      income.missingRates > 0
        ? "Some DSR entries are missing rates, so income totals may be partial."
        : "";
  }
  scheduleAutoFitStats();
}

window.addEventListener("resize", () => {
  scheduleAutoFitStats();
});

function updatePlLabel(range, modeInfo, label) {
  if (!label) return;

  if (modeInfo?.mode === "today") {
    const dateLabel = formatDisplayDate(range.start);
    label.textContent = `Today · ${dateLabel}`;
    return;
  }

  if (modeInfo?.mode === "this-month") {
    const monthDate = new Date(`${range.start}T00:00:00`);
    const monthLabel = monthDate.toLocaleDateString("en-IN", {
      month: "long",
      year: "numeric",
    });
    label.textContent = `This month · ${monthLabel}`;
    return;
  }

  if (modeInfo?.mode === "this-week") {
    const startLabel = formatDisplayDate(range.start);
    const endLabel = formatDisplayDate(range.end);
    label.textContent = `This week · ${startLabel} – ${endLabel}`;
    return;
  }

  const startLabel = formatDisplayDate(range.start);
  const endLabel = formatDisplayDate(range.end);
  label.textContent =
    startLabel === endLabel
      ? `Date: ${startLabel}`
      : `Custom range: ${startLabel} – ${endLabel}`;
}

function getRangeForSelection(selection, startInput, endInput) {
  const today = new Date();
  const todayStr = formatDateInput(today);

  if (selection === "today") {
    return {
      start: todayStr,
      end: todayStr,
      modeInfo: { mode: "today" },
    };
  }

  if (selection === "this-week") {
    return {
      ...getWeekRange(today),
      modeInfo: { mode: "this-week" },
    };
  }

  if (selection === "this-month") {
    return {
      ...getMonthRange(today.getFullYear(), today.getMonth()),
      modeInfo: { mode: "this-month" },
    };
  }

  if (selection === "custom") {
    const range = getCustomRange(startInput.value, endInput.value);
    if (!range) return null;
    return { ...range, modeInfo: { mode: "custom" } };
  }

  return null;
}

function getCustomRange(startValue, endValue) {
  if (!startValue && !endValue) return null;
  let start = startValue || endValue;
  let end = endValue || startValue;
  if (end < start) {
    [start, end] = [end, start];
  }
  return { start, end };
}

function getMonthRange(year, monthIndex) {
  const start = new Date(year, monthIndex, 1);
  const end = new Date(year, monthIndex + 1, 0);
  return {
    start: formatDateInput(start),
    end: formatDateInput(end),
  };
}

function getWeekRange(date) {
  const day = date.getDay();
  const diffToMonday = (day + 6) % 7;
  const start = new Date(date);
  start.setDate(date.getDate() - diffToMonday);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return {
    start: formatDateInput(start),
    end: formatDateInput(end),
  };
}

function updateDsrLabel(range, modeInfo) {
  const label = document.getElementById("dsr-date-label");
  if (!label) return;

  if (modeInfo?.mode === "today") {
    const dateLabel = formatDisplayDate(range.start);
    label.textContent = `Today · ${dateLabel}`;
    return;
  }

  if (modeInfo?.mode === "this-month") {
    const monthDate = new Date(`${range.start}T00:00:00`);
    const monthLabel = monthDate.toLocaleDateString("en-IN", {
      month: "long",
      year: "numeric",
    });
    label.textContent = `This month · ${monthLabel}`;
    return;
  }

  if (modeInfo?.mode === "this-week") {
    const startLabel = formatDisplayDate(range.start);
    const endLabel = formatDisplayDate(range.end);
    label.textContent = `This week · ${startLabel} – ${endLabel}`;
    return;
  }

  const startLabel = formatDisplayDate(range.start);
  const endLabel = formatDisplayDate(range.end);
  label.textContent =
    startLabel === endLabel
      ? `Date: ${startLabel}`
      : `Custom range: ${startLabel} – ${endLabel}`;
}

function setCustomRangeVisibility(container, startInput, endInput, isVisible) {
  if (isVisible) {
    container.classList.remove("hidden");
  } else {
    container.classList.add("hidden");
  }
  startInput.disabled = !isVisible;
  endInput.disabled = !isVisible;
}

function formatDateInput(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function formatDisplayDate(dateStr) {
  const date = new Date(`${dateStr}T00:00:00`);
  return date.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatQuantity(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "—";
  }
  return Number(value).toLocaleString("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

// Listen for credit updates from other pages/tabs and refresh credit summary
window.addEventListener("storage", (e) => {
  if (e.key !== "credit-updated") return;
  const dateInput = document.getElementById("snapshot-date");
  const date = dateInput?.value || new Date().toISOString().slice(0, 10);
  loadCreditSummary(date);
});

function sumByProduct(rows, product, valueFn) {
  const expectedProduct = normalizeProduct(product);
  return (rows ?? []).reduce((sum, row) => {
    if (normalizeProduct(row.product) !== expectedProduct) return sum;
    return sum + Number(valueFn(row) ?? 0);
  }, 0);
}

function applyVariationTone(element, value, isActive) {
  element.classList.remove("stat-positive", "stat-negative");
  if (!isActive) return;
  if (value > 0) {
    element.classList.add("stat-positive");
  } else if (value < 0) {
    element.classList.add("stat-negative");
  }
}

// DSR Dashboard specific - uses rates from DSR data only
function updateDsrNetSaleRupees(petrolLiters, dieselLiters, isActive, petrolRate, dieselRate) {
  const petrolNetSaleRupeesEl = document.getElementById(
    "dsr-petrol-net-sale-rupees"
  );
  const dieselNetSaleRupeesEl = document.getElementById(
    "dsr-diesel-net-sale-rupees"
  );
  if (!petrolNetSaleRupeesEl || !dieselNetSaleRupeesEl) return;

  if (!isActive) {
    petrolNetSaleRupeesEl.textContent = "—";
    dieselNetSaleRupeesEl.textContent = "—";
    return;
  }

  if (!petrolRate || petrolRate === 0) {
    petrolNetSaleRupeesEl.textContent = "—";
  } else {
    petrolNetSaleRupeesEl.textContent = formatCurrency(petrolLiters * petrolRate);
  }

  if (!dieselRate || dieselRate === 0) {
    dieselNetSaleRupeesEl.textContent = "—";
  } else {
    dieselNetSaleRupeesEl.textContent = formatCurrency(dieselLiters * dieselRate);
  }
}

