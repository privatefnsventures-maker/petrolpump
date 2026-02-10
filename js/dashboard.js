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

const LOW_STOCK_KEYS = { petrol: "petrolpump_low_stock_threshold_petrol", diesel: "petrolpump_low_stock_threshold_diesel" };
const DEFAULT_LOW_STOCK_THRESHOLD = 5000;

const ALERT_KEYS = {
  highCredit: "petrolpump_alert_high_credit",
  highVariation: "petrolpump_alert_high_variation",
  dayClosingReminder: "petrolpump_alert_day_closing_reminder",
};
let lastCreditTotalRupees = null;
let lastPetrolVariation = null;
let lastDieselVariation = null;

function getLowStockThresholds() {
  let petrol, diesel;
  try {
    petrol = Number(localStorage.getItem(LOW_STOCK_KEYS.petrol));
    diesel = Number(localStorage.getItem(LOW_STOCK_KEYS.diesel));
  } catch (_) {}
  return {
    petrol: Number.isFinite(petrol) && petrol >= 0 ? petrol : DEFAULT_LOW_STOCK_THRESHOLD,
    diesel: Number.isFinite(diesel) && diesel >= 0 ? diesel : DEFAULT_LOW_STOCK_THRESHOLD,
  };
}

function updateLowStockAlert(petrolStock, dieselStock) {
  const wrap = document.getElementById("low-stock-alert");
  const msg = document.getElementById("low-stock-message");
  if (!wrap || !msg) return;
  const th = getLowStockThresholds();
  const parts = [];
  if (Number.isFinite(petrolStock) && petrolStock < th.petrol) {
    parts.push(`Petrol: ${formatQuantity(petrolStock)} L (below ${formatQuantity(th.petrol)} L)`);
  }
  if (Number.isFinite(dieselStock) && dieselStock < th.diesel) {
    parts.push(`Diesel: ${formatQuantity(dieselStock)} L (below ${formatQuantity(th.diesel)} L)`);
  }
  if (parts.length === 0) {
    wrap.classList.add("hidden");
    updateDashboardAlertsVisibility();
    return;
  }
  msg.textContent = "Low stock alert: " + parts.join(" · ");
  wrap.classList.remove("hidden");
  updateDashboardAlertsVisibility();
}

function updateDashboardAlertsVisibility() {
  const container = document.getElementById("dashboard-alerts");
  if (!container) return;
  const lowStock = document.getElementById("low-stock-alert");
  const smartPanel = document.getElementById("smart-alerts-panel");
  const hasVisible = (lowStock && !lowStock.classList.contains("hidden")) ||
    (smartPanel && !smartPanel.classList.contains("hidden") && smartPanel.children.length > 0);
  container.classList.toggle("dashboard-alerts-empty", !hasVisible);
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

  const operatorNameEl = document.getElementById("operator-name");
  const operatorRoleEl = document.getElementById("operator-role");
  if (operatorNameEl) {
    const nameToShow = auth.display_name?.trim() || (() => {
      const email = session.user?.email ?? "";
      return email.includes("@") ? email.split("@")[0] : email || "User";
    })();
    operatorNameEl.textContent = nameToShow;
  }
  if (operatorRoleEl && role) {
    const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);
    operatorRoleEl.textContent = `(${roleLabel})`;
  }

  // Ensure open credit is never served from cache on dashboard load
  if (typeof AppCache !== "undefined" && AppCache) {
    AppCache.invalidateByType("credit_summary");
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

  const snapshotCard = document.getElementById("snapshot-card");
  const dsrCard = document.getElementById("dsr-dashboard-card");

  if (typeof window.showProgress === "function") window.showProgress();
  try {
    await Promise.all([
      loadTodaySales(snapshotDateStr),
      loadCreditSummary(snapshotDateStr),
      initializeDsrDashboard(),
      initializeProfitLossFilter(),
    ]);
    if (snapshotCard) snapshotCard.classList.remove("loading");
    updateAtAGlance(snapshotDateStr);
    if (dsrCard) dsrCard.classList.remove("loading");
    await updateSmartAlerts();
    await loadDayClosingBanners();
    updateDashboardAlertsVisibility();
    if (role === "admin") {
      loadPlTodoBanner();
    }
    if (window.location.hash === "#pl") {
      setTimeout(() => {
        const plEl = document.getElementById("pl");
        if (plEl) plEl.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 300);
    }
    scheduleAutoFitStats();
  } catch (error) {
    AppError.handle(error, { context: { source: "dashboardInit" } });
    if (snapshotCard) snapshotCard.classList.remove("loading");
    if (dsrCard) dsrCard.classList.remove("loading");
  } finally {
    if (typeof window.hideProgress === "function") window.hideProgress();
  }
});

function updateAtAGlance(dateStr) {
  const glance = document.getElementById("at-a-glance");
  const glanceSale = document.getElementById("glance-sale");
  const glanceCredit = document.getElementById("glance-credit");
  const glanceCash = document.getElementById("glance-cash");
  if (!glance) return;
  const todayStr = new Date().toISOString().slice(0, 10);
  const isToday = dateStr === todayStr;
  if (glanceSale) {
    const todayTotal = document.getElementById("today-total-rupees");
    glanceSale.textContent = todayTotal ? todayTotal.textContent : "—";
  }
  if (glanceCredit) {
    const creditEl = document.getElementById("credit-total");
    glanceCredit.textContent = creditEl ? creditEl.textContent : "—";
  }
  if (glanceCash && isToday) {
    const inHandEl = document.getElementById("dsr-in-hand");
    glanceCash.textContent = inHandEl ? inHandEl.textContent : "—";
  } else if (glanceCash) {
    glanceCash.textContent = "—";
  }
  glance.classList.remove("hidden");
  const statusBar = document.getElementById("dashboard-status-bar");
  if (statusBar) statusBar.classList.remove("hidden");
}

function getAlertThresholds() {
  let highCredit = 0;
  let highVariation = 0;
  let dayClosingReminder = true;
  try {
    const hc = localStorage.getItem(ALERT_KEYS.highCredit);
    const hv = localStorage.getItem(ALERT_KEYS.highVariation);
    const dc = localStorage.getItem(ALERT_KEYS.dayClosingReminder);
    if (hc != null && hc !== "") highCredit = Number(hc);
    if (hv != null && hv !== "") highVariation = Number(hv);
    if (dc === "false") dayClosingReminder = false;
  } catch (_) {}
  return {
    highCredit: Number.isFinite(highCredit) && highCredit > 0 ? highCredit : 0,
    highVariation: Number.isFinite(highVariation) && highVariation > 0 ? highVariation : 0,
    dayClosingReminder,
  };
}

async function updateSmartAlerts() {
  const panel = document.getElementById("smart-alerts-panel");
  if (!panel) return;
  const alerts = [];
  const th = getAlertThresholds();

  if (th.highCredit > 0 && Number.isFinite(lastCreditTotalRupees) && lastCreditTotalRupees > th.highCredit) {
    alerts.push({
      type: "warning",
      message: `Outstanding credit (${formatCurrency(lastCreditTotalRupees)}) is above your alert threshold (${formatCurrency(th.highCredit)}).`,
      cta: "Credit",
      href: "credit.html",
    });
  }

  if (th.highVariation > 0 && (Number(lastPetrolVariation) > th.highVariation || Number(lastDieselVariation) > th.highVariation)) {
    const parts = [];
    if (Number(lastPetrolVariation) > th.highVariation) parts.push(`Petrol ${formatQuantity(lastPetrolVariation)} L`);
    if (Number(lastDieselVariation) > th.highVariation) parts.push(`Diesel ${formatQuantity(lastDieselVariation)} L`);
    alerts.push({
      type: "warning",
      message: `Stock variation exceeds threshold (${formatQuantity(th.highVariation)} L): ${parts.join(", ")}. Verify meter readings.`,
      cta: "View DSR",
      href: "dsr.html",
    });
  }

  if (alerts.length === 0) {
    panel.classList.add("hidden");
    panel.innerHTML = "";
    updateDashboardAlertsVisibility();
    return;
  }
  panel.classList.remove("hidden");
  updateDashboardAlertsVisibility();
  panel.innerHTML = alerts
    .map(
      (a) =>
        `<div class="smart-alert smart-alert--${a.type}" role="alert">
          <p class="smart-alert-message">${escapeHtml(a.message)}</p>
          <a href="${escapeHtml(a.href)}" class="button-secondary smart-alert-cta">${escapeHtml(a.cta)}</a>
        </div>`
    )
    .join("");
}

const DAY_CLOSING_LOOKBACK_DAYS = 7;

/**
 * Load day closing status for today and past days; render one banner per day (done or not done).
 * Respects dayClosingReminder setting. No "Day closing" title; separate banner per event.
 */
async function loadDayClosingBanners() {
  const block = document.getElementById("day-closing-block");
  const container = document.getElementById("day-closing-banners");
  if (!block || !container) return;

  const th = getAlertThresholds();
  if (!th.dayClosingReminder) {
    block.classList.add("hidden");
    container.innerHTML = "";
    return;
  }

  const today = new Date();
  const todayStr = formatDateInput(today);
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - DAY_CLOSING_LOOKBACK_DAYS);
  const startStr = formatDateInput(startDate);

  const { data: closedRows, error } = await supabaseClient
    .from("day_closing")
    .select("date")
    .gte("date", startStr)
    .lte("date", todayStr);

  if (error) {
    AppError.report(error, { context: "loadDayClosingBanners" });
    block.classList.add("hidden");
    container.innerHTML = "";
    return;
  }

  const closedSet = new Set((closedRows ?? []).map((r) => r.date));

  const datesToShow = [];
  for (let i = 0; i <= DAY_CLOSING_LOOKBACK_DAYS; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    datesToShow.push(formatDateInput(d));
  }

  const parts = [];

  function bannerForDate(dateStr, showDone) {
    const done = closedSet.has(dateStr);
    if (!showDone && done) return null;
    const label = formatDisplayDate(dateStr);
    const isToday = dateStr === todayStr;
    const dayLabel = isToday ? "today" : label;
    if (done) {
      return `<div class="day-closing-banner day-closing-cta done" role="status">
        <span class="cta-text">Day closing done for ${escapeHtml(dayLabel)}</span>
      </div>`;
    }
    const fillUrl = `day-closing.html?date=${encodeURIComponent(dateStr)}`;
    return `<div class="day-closing-banner day-closing-cta" role="alert">
      <span class="cta-text">Day closing not done for ${escapeHtml(dayLabel)}</span>
      <a href="${escapeHtml(fillUrl)}" class="day-closing-cta-btn">Fill day closing</a>
    </div>`;
  }

  parts.push(bannerForDate(datesToShow[0], true));
  datesToShow.slice(1).forEach((dateStr) => {
    const html = bannerForDate(dateStr, false);
    if (html) parts.push(html);
  });

  container.innerHTML = parts.join("");
  block.classList.toggle("hidden", parts.length === 0);
}

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

  // Total quantity = net + testing (i.e. total_sales) for Daily Snapshot
  const petrolTotalQty = sumByProduct(
    snapshotDsrRows,
    "petrol",
    (row) => Number(row.total_sales ?? 0)
  );
  const dieselTotalQty = sumByProduct(
    snapshotDsrRows,
    "diesel",
    (row) => Number(row.total_sales ?? 0)
  );
  const totalLiters = petrolTotalQty + dieselTotalQty;

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

  // Total quantity (including testing) × rate for Price (₹)
  const petrolLiters = sumByProduct(
    snapshotDsrRows,
    "petrol",
    (row) => Number(row.total_sales ?? 0)
  );
  const dieselLiters = sumByProduct(
    snapshotDsrRows,
    "diesel",
    (row) => Number(row.total_sales ?? 0)
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
  const cacheKey = getCreditSummaryCacheKey(selectedDate);

  const fetchFn = async () => {
    // Filter: last_payment <= selectedDate OR (last_payment is null AND credit date <= selectedDate)
    const { data, error } = await supabaseClient
      .from("credit_customers")
      .select("amount_due")
      .gt("amount_due", 0)
      .or(
        `and(last_payment.not.is.null,last_payment.lte.${selectedDate}),` +
        `and(last_payment.is.null,date.lte.${selectedDate})`
      );

    if (error) {
      AppError.report(error, { context: "loadCreditSummary", date: selectedDate });
      return null;
    }
    return data ?? [];
  };

  // Always fetch fresh data so open credit reflects latest value (no cache-first)
  let data = await fetchFn();
  if (AppCache && data !== null && data !== undefined) {
    AppCache.set(cacheKey, data, "credit_summary");
  }
  renderCreditSummary(data, creditTotal);
}

/**
 * Render credit summary to UI
 */
function renderCreditSummary(data, creditTotal) {
  if (!data) {
    lastCreditTotalRupees = null;
    if (creditTotal) creditTotal.textContent = "—";
    return;
  }

  const total = data.reduce((sum, row) => sum + Number(row.amount_due ?? 0), 0);
  lastCreditTotalRupees = total;
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

/**
 * Cost of goods: for each sale day, effective buying price = the buying price from the most recent
 * receipt day (same product) on or before that date. So profit is calculated from each receipt day
 * until the next receipt day using that day's buying price. Sum net_sale * effective_buying.
 */
function calculateCostOfGoods(dsrRows, receiptRows, endDate) {
  const byProduct = new Map();
  (receiptRows ?? []).forEach((row) => {
    const p = normalizeProduct(row.product);
    if (!byProduct.has(p)) byProduct.set(p, []);
    byProduct.get(p).push({
      date: row.date,
      buying_price_per_litre: Number(row.buying_price_per_litre),
    });
  });
  byProduct.forEach((list) => list.sort((a, b) => b.date.localeCompare(a.date)));

  function getEffectiveBuying(product, date) {
    const list = byProduct.get(normalizeProduct(product));
    if (!list || list.length === 0) return null;
    const found = list.find((r) => r.date <= date);
    return found != null && Number.isFinite(found.buying_price_per_litre) ? found.buying_price_per_litre : null;
  }

  let cost = 0;
  (dsrRows ?? []).forEach((row) => {
    const netSale = Number(row.total_sales ?? 0) - Number(row.testing ?? 0);
    if (!Number.isFinite(netSale) || netSale <= 0) return;
    const buying = getEffectiveBuying(row.product, row.date);
    if (buying != null) cost += netSale * buying;
  });
  return cost;
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
    totalNetSaleEl: document.getElementById("dsr-total-net-sale"),
    summaryExpenseEl: document.getElementById("dsr-summary-expense"),
    summaryCreditEl: document.getElementById("dsr-summary-credit"),
    inHandEl: document.getElementById("dsr-in-hand"),
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

  // Fetch credit in range (credit entries whose credit date falls in this period)
  const { data: creditRows } = await supabaseClient
    .from("credit_customers")
    .select("amount_due, date")
    .gte("date", range.start)
    .lte("date", range.end);
  dashboardData.creditData = creditRows ?? [];

  renderDsrSummary(dashboardData, elements);
  const todayStr = new Date().toISOString().slice(0, 10);
  if (range.start === todayStr && range.end === todayStr) {
    const inHandEl = document.getElementById("dsr-in-hand");
    const glanceCash = document.getElementById("glance-cash");
    if (glanceCash && inHandEl) glanceCash.textContent = inHandEl.textContent;
    const petrolStock = sumByProduct(dashboardData.dsrData || [], "petrol", (row) => row.stock);
    const dieselStock = sumByProduct(dashboardData.dsrData || [], "diesel", (row) => row.stock);
    updateLowStockAlert(petrolStock, dieselStock);
    lastPetrolVariation = sumByProduct(dashboardData.stockData || [], "petrol", (row) => row.variation);
    lastDieselVariation = sumByProduct(dashboardData.stockData || [], "diesel", (row) => row.variation);
    updateSmartAlerts();
    loadDayClosingBanners();
  } else {
    lastPetrolVariation = null;
    lastDieselVariation = null;
    const wrap = document.getElementById("low-stock-alert");
    if (wrap) wrap.classList.add("hidden");
    updateSmartAlerts();
  }
}

/**
 * Render DSR summary data to UI elements
 */
function renderDsrSummary(data, elements) {
  const {
    petrolStockEl, dieselStockEl, petrolNetSaleEl, dieselNetSaleEl,
    petrolNetSaleRupeesEl, dieselNetSaleRupeesEl, petrolVariationEl,
    dieselVariationEl,
    totalNetSaleEl, summaryExpenseEl, summaryCreditEl, inHandEl
  } = elements;

  const { dsrData, stockData, expenseData, creditData, dsrError, stockError, expenseError } = data || {};

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

  // Day summary: total net sale (₹), expenses, credit in range, in hand
  const totalNetSaleRupees = hasDsr && (dsrPetrolRate > 0 || dsrDieselRate > 0)
    ? petrolNetSale * (dsrPetrolRate || 0) + dieselNetSale * (dsrDieselRate || 0)
    : 0;
  const creditInRange = (creditData ?? []).reduce(
    (sum, row) => sum + Number(row.amount_due ?? 0),
    0
  );
  const inHand = totalNetSaleRupees - expenseTotal - creditInRange;

  if (totalNetSaleEl) {
    totalNetSaleEl.textContent = hasDsr ? formatCurrency(totalNetSaleRupees) : "—";
  }
  if (summaryExpenseEl) {
    summaryExpenseEl.textContent = hasExpense ? formatCurrency(expenseTotal) : "—";
  }
  if (summaryCreditEl) {
    summaryCreditEl.textContent = formatCurrency(creditInRange);
  }
  if (inHandEl) {
    inHandEl.textContent = hasDsr || hasExpense ? formatCurrency(inHand) : "—";
    inHandEl.classList.remove("stat-positive", "stat-negative");
    if (inHand > 0) inHandEl.classList.add("stat-positive");
    else if (inHand < 0) inHandEl.classList.add("stat-negative");
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

/**
 * Sync receipts from dsr_stock into dsr for matching (date, product) where dsr.receipts is 0.
 * Uses RPC when available (one round-trip); otherwise client-side updates. Optional pre-fetched
 * { dsrRows, stockRows } avoid duplicate fetches when called from loadProfitLossSummary.
 */
async function syncReceiptsFromDsrStock(startStr, endStr, { dsrRows: preDsr, stockRows: preStock } = {}) {
  const rpc = await supabaseClient.rpc("sync_dsr_receipts_from_stock", {
    p_start: startStr,
    p_end: endStr,
  });
  if (!rpc.error) return;

  const stockRows = preStock ?? (await supabaseClient.from("dsr_stock").select("date, product, receipts").gte("date", startStr).lte("date", endStr).gt("receipts", 0)).data;
  if (!stockRows?.length) return;

  const dsrRows = preDsr ?? (await supabaseClient.from("dsr").select("id, date, product, receipts").gte("date", startStr).lte("date", endStr)).data;
  const dsrByKey = new Map((dsrRows ?? []).map((r) => [`${r.date}:${r.product}`, r]));

  const updates = [];
  for (const row of stockRows) {
    const dsr = dsrByKey.get(`${row.date}:${row.product}`);
    const val = Number(row.receipts ?? 0);
    if (dsr && val > 0 && Number(dsr.receipts ?? 0) === 0) updates.push(supabaseClient.from("dsr").update({ receipts: val }).eq("id", dsr.id));
  }
  if (updates.length) await Promise.all(updates);
}

/**
 * Fetch count of DSR rows with receipts > 0 and no buying price (all history / old data included).
 * Syncs receipts from dsr_stock into dsr first (RPC when available).
 */
async function loadPlTodoBanner() {
  const bannerEl = document.getElementById("pl-todo-banner");
  const countEl = document.getElementById("pl-todo-count");
  if (!bannerEl || !countEl) return;

  const end = new Date();
  const endStr = formatDateInput(end);
  const start = new Date(end);
  start.setFullYear(start.getFullYear() - 10);
  const startStr = formatDateInput(start);

  await syncReceiptsFromDsrStock(startStr, endStr);

  const { count, error } = await supabaseClient
    .from("dsr")
    .select("id", { count: "exact", head: true })
    .gte("date", startStr)
    .lte("date", endStr)
    .gt("receipts", 0)
    .is("buying_price_per_litre", null);

  if (error) {
    AppError.report(error, { context: "loadPlTodoBanner" });
    bannerEl.classList.add("hidden");
    return;
  }
  const n = count ?? 0;
  if (n > 0) {
    countEl.textContent = String(n);
    bannerEl.classList.remove("hidden");
  } else {
    bannerEl.classList.add("hidden");
    try { sessionStorage.removeItem("pl_todo_pending"); } catch (_) {}
  }
}

/**
 * Get current P&L range from the filter form (for reload after saving buying price).
 */
function getCurrentPlRange() {
  const rangeSelect = document.getElementById("pl-range");
  const startEl = document.getElementById("pl-start");
  const endEl = document.getElementById("pl-end");
  if (!rangeSelect || !startEl || !endEl) return null;
  return getRangeForSelection(rangeSelect.value, startEl, endEl);
}

/**
 * Save buying price for a DSR row (receipt day) and reload P&L summary.
 */
async function handleSaveBuyingPrice(dsrId) {
  const input = document.getElementById(`pl-buying-${dsrId}`);
  const value = Number.parseFloat((input?.value ?? "").trim(), 10);
  if (!Number.isFinite(value) || value < 0) {
    showPlBuyingPriceError("Enter a valid buying price (₹/L).");
    return;
  }
  document.getElementById("pl-buying-price-error")?.classList.add("hidden");
  const btn = document.querySelector(`.pl-buying-save[data-dsr-id="${dsrId}"]`);
  const resetBtn = () => {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Save";
      btn.classList.remove("pl-save-success");
    }
  };
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Saving…";
  }
  const rpc = await supabaseClient.rpc("update_dsr_buying_price", { p_dsr_id: dsrId, p_value: value });
  const fallback = rpc.error ? await supabaseClient.from("dsr").update({ buying_price_per_litre: value }).eq("id", dsrId).select("id").maybeSingle() : { data: true };
  if (rpc.error && (fallback.error || !fallback.data)) {
    AppError.report(rpc.error || fallback.error, { context: "handleSaveBuyingPrice", type: "dsr" });
    showPlBuyingPriceError((rpc.error?.message || fallback.error?.message) || "Could not save. Ensure you are logged in as admin.");
    resetBtn();
    return;
  }
  if (btn) {
    btn.textContent = "Saved";
    btn.classList.add("pl-save-success");
  }
  // Invalidate cache so other tabs / next load see updated P&L immediately
  if (typeof AppCache !== "undefined" && AppCache) {
    AppCache.invalidateByType("profit_loss");
    AppCache.invalidateByType("dashboard_data");
  }
  const range = getCurrentPlRange();
  if (range) await loadProfitLossSummary(range);
  loadPlTodoBanner();
  resetBtn();
}

function showPlBuyingPriceError(message) {
  const el = document.getElementById("pl-buying-price-error");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("hidden");
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
  const plBuyingErrorEl = document.getElementById("pl-buying-price-error");
  if (plBuyingErrorEl) plBuyingErrorEl.classList.add("hidden");

  const RECEIPT_HISTORY_START = "2000-01-01";

  const [
    { data: dsrData, error: dsrError },
    { data: expenseData, error: expenseError },
    { data: receiptRows, error: receiptError },
    { data: stockRows, error: stockError },
  ] = await Promise.all([
    supabaseClient.from("dsr").select("id, date, product, total_sales, testing, petrol_rate, diesel_rate, receipts, buying_price_per_litre").gte("date", range.start).lte("date", range.end),
    supabaseClient.from("expenses").select("*").gte("date", range.start).lte("date", range.end),
    supabaseClient.from("dsr").select("date, product, buying_price_per_litre").gte("date", RECEIPT_HISTORY_START).lte("date", range.end).gt("receipts", 0).not("buying_price_per_litre", "is", null).order("date", { ascending: false }),
    supabaseClient.from("dsr_stock").select("date, product, receipts").gte("date", range.start).lte("date", range.end).gt("receipts", 0),
  ]);
  if (receiptError) AppError.report(receiptError, { context: "profitLossSummary", type: "receipt" });
  if (dsrError) AppError.report(dsrError, { context: "profitLossSummary", type: "dsr" });
  if (expenseError) AppError.report(expenseError, { context: "profitLossSummary", type: "expense" });

  await syncReceiptsFromDsrStock(range.start, range.end, { dsrRows: dsrData ?? [], stockRows: stockRows ?? [] });
  const stockByKey = new Map((stockRows ?? []).map((r) => [`${r.date}:${r.product}`, Number(r.receipts)]));
  const dsrRows = (dsrData ?? []).map((row) => {
    const fromStock = stockByKey.get(`${row.date}:${row.product}`);
    if (fromStock != null && Number(row.receipts ?? 0) === 0) return { ...row, receipts: fromStock };
    return row;
  });

  const hasDsr = !dsrError;
  const hasExpense = !expenseError;
  const income = calculateIncome(dsrRows);

  const isMissingBuyingPrice = (row) => {
    if (Number(row.receipts ?? 0) <= 0) return false;
    const bp = row.buying_price_per_litre;
    return bp == null || bp === "" || (typeof bp === "number" && !Number.isFinite(bp));
  };
  const missingBuyingPrice = dsrRows.filter(isMissingBuyingPrice);
  const allBuyingPricesEntered = missingBuyingPrice.length === 0;
  const receiptRowsForCost = allBuyingPricesEntered ? (receiptRows ?? []) : [];
  const costOfGoods = calculateCostOfGoods(dsrRows, receiptRowsForCost, range.end);

  const plAlertEl = document.getElementById("pl-buying-price-alert");
  const plMissingListEl = document.getElementById("pl-missing-buying-list");
  const plProfitHintEl = document.getElementById("pl-profit-hint");
  if (plAlertEl && plMissingListEl) {
    if (missingBuyingPrice.length > 0) {
      plAlertEl.classList.remove("hidden");
      plMissingListEl.innerHTML = missingBuyingPrice
        .map(
          (row) => {
            const productLabel = normalizeProduct(row.product) === "petrol" ? "Petrol" : "Diesel";
            const rowId = row.id;
            return `
              <li class="pl-missing-item" data-dsr-id="${escapeHtml(rowId)}">
                <span class="pl-missing-label">${escapeHtml(row.date)} · ${productLabel}</span>
                <label for="pl-buying-${rowId}" class="sr-only">Buying price (₹/L)</label>
                <input id="pl-buying-${rowId}" type="number" inputmode="decimal" step="0.01" min="0" placeholder="₹/L" class="pl-buying-input" data-dsr-id="${escapeHtml(rowId)}" />
                <button type="button" class="button-secondary pl-buying-save" data-dsr-id="${escapeHtml(rowId)}">Save</button>
              </li>`;
          }
        )
        .join("");
      plMissingListEl.querySelectorAll(".pl-buying-save").forEach((btn) => {
        btn.addEventListener("click", () => handleSaveBuyingPrice(btn.dataset.dsrId));
      });
    } else {
      plAlertEl.classList.add("hidden");
      plMissingListEl.innerHTML = "";
    }
  }

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
    plNetSaleEl.textContent = hasDsr && (dsrData ?? []).length ? formatCurrency(income.total) : "—";
  }
  if (plExpenseEl) {
    plExpenseEl.textContent = hasExpense ? formatCurrency(expenseTotal) : "—";
  }

  if (plValueEl && plLabelEl) {
    if (plLabelEl) plLabelEl.textContent = "Profit / Loss";
    if (plProfitHintEl) {
      plProfitHintEl.classList.add("hidden");
      plProfitHintEl.textContent = "";
    }
    if (!hasDsr || !hasExpense) {
      plValueEl.textContent = "—";
      plValueEl.classList.remove("stat-negative", "stat-positive");
    } else if (!allBuyingPricesEntered) {
      plValueEl.textContent = "—";
      if (plProfitHintEl) {
        plProfitHintEl.textContent = "Enter buying price for receipt days above to calculate.";
        plProfitHintEl.classList.remove("hidden");
      }
      plValueEl.classList.remove("stat-negative", "stat-positive");
    } else {
      const revenue = income.total;
      const profitLoss = revenue - costOfGoods - expenseTotal;
      plValueEl.textContent = formatCurrency(profitLoss);
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
  const date = dateInput?.value || (typeof getLocalDateString === "function" ? getLocalDateString() : new Date().toISOString().slice(0, 10));
  loadCreditSummary(date);
});

// Refetch open credit when user returns to dashboard tab or page (e.g. from Credit page)
function refreshCreditSummaryOnVisible() {
  const dateInput = document.getElementById("snapshot-date");
  if (!dateInput) return;
  const date = dateInput.value || new Date().toISOString().slice(0, 10);
  loadCreditSummary(date).then(() => {
    const creditTotal = document.getElementById("credit-total");
    const glanceCredit = document.getElementById("glance-credit");
    if (glanceCredit && creditTotal) glanceCredit.textContent = creditTotal.textContent;
  });
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && document.getElementById("snapshot-card")) {
    refreshCreditSummaryOnVisible();
  }
});
window.addEventListener("pageshow", (e) => {
  if (e.persisted && document.getElementById("snapshot-card")) {
    refreshCreditSummaryOnVisible();
  }
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

