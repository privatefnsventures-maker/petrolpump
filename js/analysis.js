/* global requireAuth, applyRoleVisibility, supabaseClient, formatCurrency, AppError, getValidFilterState, setFilterState */

document.addEventListener("DOMContentLoaded", async () => {
  const auth = await requireAuth({
    allowedRoles: ["admin"],
    onDenied: "dashboard.html",
    pageName: "analysis",
  });
  if (!auth) return;
  applyRoleVisibility(auth.role);

  await initAnalysisPage();
});

// --- Formatting ---
function formatQuantity(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return Number(value).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  const n = Number(value);
  const sign = n >= 0 ? "" : "";
  return sign + n.toFixed(1) + "%";
}

// --- Date range helpers (aligned with dashboard) ---

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

function getWeekRange(date) {
  const diffToMonday = (date.getDay() + 6) % 7;
  const start = new Date(date);
  start.setDate(date.getDate() - diffToMonday);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { start: formatDateInput(start), end: formatDateInput(end) };
}

function getMonthRange(year, monthIndex) {
  const start = new Date(year, monthIndex, 1);
  const end = new Date(year, monthIndex + 1, 0);
  return { start: formatDateInput(start), end: formatDateInput(end) };
}

function getLast3MonthsRange() {
  const end = new Date();
  const start = new Date(end);
  start.setMonth(start.getMonth() - 2);
  start.setDate(1);
  const lastDay = new Date(end.getFullYear(), end.getMonth() + 1, 0);
  return { start: formatDateInput(start), end: formatDateInput(lastDay) };
}

function getCustomRange(startValue, endValue) {
  if (!startValue && !endValue) return null;
  let start = startValue || endValue;
  let end = endValue || startValue;
  if (end < start) [start, end] = [end, start];
  return { start, end };
}

function getRangeForSelection(selection, startInput, endInput) {
  const today = new Date();
  if (selection === "this-week") {
    return { ...getWeekRange(today), modeInfo: { mode: "this-week" } };
  }
  if (selection === "this-month") {
    return {
      ...getMonthRange(today.getFullYear(), today.getMonth()),
      modeInfo: { mode: "this-month" },
    };
  }
  if (selection === "last-3-months") {
    return { ...getLast3MonthsRange(), modeInfo: { mode: "last-3-months" } };
  }
  if (selection === "custom") {
    const range = getCustomRange(startInput?.value, endInput?.value);
    if (!range) return null;
    return { ...range, modeInfo: { mode: "custom" } };
  }
  return null;
}

function setCustomRangeVisibility(container, startInput, endInput, isVisible) {
  if (!container) return;
  if (isVisible) container.classList.remove("hidden");
  else container.classList.add("hidden");
  if (startInput) startInput.disabled = !isVisible;
  if (endInput) endInput.disabled = !isVisible;
}

// --- Data fetch ---

async function fetchAnalysisData(startDate, endDate) {
  const [dsrResult, expenseResult] = await Promise.all([
    supabaseClient
      .from("dsr")
      .select("date, product, total_sales, testing, petrol_rate, diesel_rate")
      .gte("date", startDate)
      .lte("date", endDate)
      .order("date", { ascending: true }),
    supabaseClient
      .from("expenses")
      .select("date, amount")
      .gte("date", startDate)
      .lte("date", endDate),
  ]);

  if (dsrResult.error) AppError.report(dsrResult.error, { context: "fetchAnalysisData", type: "dsr" });
  if (expenseResult.error) AppError.report(expenseResult.error, { context: "fetchAnalysisData", type: "expenses" });

  return {
    dsrData: dsrResult.data ?? [],
    expenseData: expenseResult.data ?? [],
  };
}

function normalizeProduct(value) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Build daily series: for each date in [start, end], compute sales (₹), expenses (₹), profit (₹), petrol L, diesel L.
 */
function buildDailySeries(dsrData, expenseData, startDate, endDate) {
  const byDate = new Map();
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = formatDateInput(d);
    byDate.set(key, {
      date: key,
      salesRupees: 0,
      expenseRupees: 0,
      petrolL: 0,
      dieselL: 0,
      petrolRupees: 0,
      dieselRupees: 0,
    });
  }

  (dsrData ?? []).forEach((row) => {
    const key = row.date;
    if (!byDate.has(key)) return;
    const netSale = Number(row.total_sales ?? 0) - Number(row.testing ?? 0);
    if (!Number.isFinite(netSale) || netSale <= 0) return;
    const rate =
      normalizeProduct(row.product) === "petrol"
        ? Number(row.petrol_rate ?? 0)
        : Number(row.diesel_rate ?? 0);
    const revenue = Number.isFinite(rate) && rate > 0 ? netSale * rate : 0;
    const entry = byDate.get(key);
    entry.salesRupees += revenue;
    if (normalizeProduct(row.product) === "petrol") {
      entry.petrolL += netSale;
      entry.petrolRupees += revenue;
    } else {
      entry.dieselL += netSale;
      entry.dieselRupees += revenue;
    }
  });

  (expenseData ?? []).forEach((row) => {
    const key = row.date;
    if (!byDate.has(key)) return;
    byDate.get(key).expenseRupees += Number(row.amount ?? 0);
  });

  const series = Array.from(byDate.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, v]) => ({
      ...v,
      profitRupees: v.salesRupees - v.expenseRupees,
    }));

  return series;
}

/**
 * Get previous period of same length (number of days) before current start.
 */
function getPreviousPeriodStartEnd(currentStart, currentEnd) {
  const start = new Date(`${currentStart}T00:00:00`);
  const end = new Date(`${currentEnd}T00:00:00`);
  const days = Math.round((end - start) / (24 * 60 * 60 * 1000)) + 1;
  const prevEnd = new Date(start);
  prevEnd.setDate(prevEnd.getDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setDate(prevStart.getDate() - days + 1);
  return {
    start: formatDateInput(prevStart),
    end: formatDateInput(prevEnd),
  };
}

function computeGrowthPercent(currentTotal, previousTotal) {
  if (!Number.isFinite(previousTotal) || previousTotal === 0) return null;
  if (!Number.isFinite(currentTotal)) return null;
  return ((currentTotal - previousTotal) / previousTotal) * 100;
}

// --- UI: label, KPIs, charts ---

function updateAnalysisDateLabel(range, modeInfo) {
  const label = document.getElementById("analysis-date-label");
  if (!label) return;
  if (modeInfo?.mode === "this-month") {
    const d = new Date(`${range.start}T00:00:00`);
    label.textContent = `This month · ${d.toLocaleDateString("en-IN", { month: "long", year: "numeric" })}`;
    return;
  }
  if (modeInfo?.mode === "last-3-months") {
    label.textContent = `Last 3 months · ${formatDisplayDate(range.start)} – ${formatDisplayDate(range.end)}`;
    return;
  }
  const startLabel = formatDisplayDate(range.start);
  const endLabel = formatDisplayDate(range.end);
  label.textContent =
    startLabel === endLabel ? `Date: ${startLabel}` : `${startLabel} – ${endLabel}`;
}

function setStatTone(el, value, isPercent) {
  if (!el) return;
  el.classList.remove("stat-positive", "stat-negative");
  if (value === null || value === undefined || (isPercent && value === 0)) return;
  if (Number(value) > 0) el.classList.add("stat-positive");
  else if (Number(value) < 0) el.classList.add("stat-negative");
}

function renderKPIs(totals, growthPercent, insights) {
  const salesEl = document.getElementById("analysis-total-sales");
  const expensesEl = document.getElementById("analysis-total-expenses");
  const profitEl = document.getElementById("analysis-profit");
  const growthEl = document.getElementById("analysis-growth");
  const growthNoteEl = document.getElementById("analysis-growth-note");

  if (salesEl) salesEl.textContent = formatCurrency(totals.salesRupees);
  if (expensesEl) expensesEl.textContent = formatCurrency(totals.expenseRupees);
  if (profitEl) {
    profitEl.textContent = formatCurrency(totals.profitRupees);
    setStatTone(profitEl, totals.profitRupees, false);
  }
  if (growthEl) {
    if (growthPercent === null) {
      growthEl.textContent = "—";
      if (growthNoteEl) growthNoteEl.textContent = "vs previous period (no prior data)";
    } else {
      growthEl.textContent = (growthPercent >= 0 ? "+" : "") + growthPercent.toFixed(1) + "%";
      setStatTone(growthEl, growthPercent, true);
      if (growthNoteEl) growthNoteEl.textContent = "vs previous period";
    }
  }

  // Performance indicators
  const avgDailyEl = document.getElementById("analysis-avg-daily-sales");
  const marginEl = document.getElementById("analysis-profit-margin");
  const volumeEl = document.getElementById("analysis-total-volume");
  const expenseRatioEl = document.getElementById("analysis-expense-ratio");
  const bestDayEl = document.getElementById("analysis-best-day");
  const bestDayDateEl = document.getElementById("analysis-best-day-date");
  const daysProfitableEl = document.getElementById("analysis-days-profitable");
  const daysProfitableNoteEl = document.getElementById("analysis-days-profitable-note");
  const petrolShareEl = document.getElementById("analysis-petrol-share");
  const profitGrowthEl = document.getElementById("analysis-profit-growth");

  if (avgDailyEl) avgDailyEl.textContent = insights.avgDailySales != null ? formatCurrency(insights.avgDailySales) : "—";
  if (marginEl) {
    marginEl.textContent = insights.profitMarginPct != null ? formatPercent(insights.profitMarginPct) : "—";
    setStatTone(marginEl, insights.profitMarginPct, true);
  }
  if (volumeEl) volumeEl.textContent = insights.totalVolumeL != null ? formatQuantity(insights.totalVolumeL) : "—";
  if (expenseRatioEl) expenseRatioEl.textContent = insights.expenseRatioPct != null ? formatPercent(insights.expenseRatioPct) : "—";
  if (bestDayEl) bestDayEl.textContent = insights.bestDayAmount != null ? formatCurrency(insights.bestDayAmount) : "—";
  if (bestDayDateEl) bestDayDateEl.textContent = insights.bestDayDate != null ? insights.bestDayDate : "—";
  if (daysProfitableEl) daysProfitableEl.textContent = insights.daysProfitable != null ? String(insights.daysProfitable) : "—";
  if (daysProfitableNoteEl) daysProfitableNoteEl.textContent = insights.totalDays != null ? `of ${insights.totalDays} days` : "of period";
  if (petrolShareEl) petrolShareEl.textContent = insights.petrolSharePct != null ? formatPercent(insights.petrolSharePct) : "—";
  if (profitGrowthEl) {
    if (insights.profitGrowthPercent === null) {
      profitGrowthEl.textContent = "—";
    } else {
      profitGrowthEl.textContent = (insights.profitGrowthPercent >= 0 ? "+" : "") + insights.profitGrowthPercent.toFixed(1) + "%";
      setStatTone(profitGrowthEl, insights.profitGrowthPercent, true);
    }
  }
}

function renderInsights(series, totals, insights) {
  const list = document.getElementById("analysis-insights-list");
  if (!list) return;

  const items = [];
  if (insights.bestDayDate && insights.bestDayAmount != null) {
    items.push(`Best sales day: ${insights.bestDayDate} — ${formatCurrency(insights.bestDayAmount)}`);
  }
  const worstDay = series.length ? series.reduce((a, b) => (a.profitRupees < b.profitRupees ? a : b)) : null;
  if (worstDay && worstDay.date) {
    const d = new Date(`${worstDay.date}T00:00:00`);
    const label = d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
    items.push(`Lowest profit day: ${label} — ${formatCurrency(worstDay.profitRupees)}`);
  }
  if (insights.expenseRatioPct != null && totals.salesRupees > 0) {
    items.push(`Expense ratio: ${formatPercent(insights.expenseRatioPct)} of sales`);
  }
  if (insights.petrolSharePct != null) {
    items.push(`Petrol contributed ${formatPercent(insights.petrolSharePct)} of revenue; diesel ${formatPercent(100 - insights.petrolSharePct)}`);
  }
  if (insights.daysProfitable != null && insights.totalDays != null && insights.totalDays > 0) {
    items.push(`Profitable on ${insights.daysProfitable} of ${insights.totalDays} days`);
  }
  if (insights.profitMarginPct != null && Number.isFinite(insights.profitMarginPct)) {
    items.push(`Net profit margin: ${formatPercent(insights.profitMarginPct)}`);
  }

  if (items.length === 0) {
    list.innerHTML = "<li class=\"muted\">No insights for this range. Add DSR and expense data to see trends.</li>";
    return;
  }
  list.innerHTML = items.map((text) => `<li>${text}</li>`).join("");
}

let chartSales = null;
let chartProfit = null;
let chartFuelMix = null;
let chartRevenueMix = null;

function destroyCharts() {
  if (chartSales) { chartSales.destroy(); chartSales = null; }
  if (chartProfit) { chartProfit.destroy(); chartProfit = null; }
  if (chartFuelMix) { chartFuelMix.destroy(); chartFuelMix = null; }
  if (chartRevenueMix) { chartRevenueMix.destroy(); chartRevenueMix = null; }
}

function renderCharts(series, totals) {
  destroyCharts();

  const labels = series.map((d) => {
    const date = new Date(`${d.date}T00:00:00`);
    return date.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  });
  const salesData = series.map((d) => d.salesRupees);
  const expenseData = series.map((d) => d.expenseRupees);
  const profitData = series.map((d) => d.profitRupees);
  const petrolRevenueData = series.map((d) => d.petrolRupees ?? 0);
  const dieselRevenueData = series.map((d) => d.dieselRupees ?? 0);

  const grid = { color: "rgba(0,0,0,0.06)" };
  const fontFamily = "inherit";
  const rupeeTick = (value) => "₹" + (value >= 1000 ? value / 1000 + "k" : value);

  const salesCtx = document.getElementById("chart-sales")?.getContext("2d");
  if (salesCtx) {
    chartSales = new Chart(salesCtx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Net sale (₹)",
            data: salesData,
            borderColor: "#2563eb",
            backgroundColor: "rgba(37, 99, 235, 0.1)",
            fill: true,
            tension: 0.2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid, ticks: { font: { family: fontFamily }, maxRotation: 45 } },
          y: { grid, ticks: { font: { family: fontFamily }, callback: (v) => rupeeTick(v) } },
        },
      },
    });
  }

  const revenueMixCtx = document.getElementById("chart-revenue-mix")?.getContext("2d");
  if (revenueMixCtx) {
    chartRevenueMix = new Chart(revenueMixCtx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "Petrol (₹)", data: petrolRevenueData, backgroundColor: "rgba(59, 130, 246, 0.8)", borderColor: "#2563eb", borderWidth: 1 },
          { label: "Diesel (₹)", data: dieselRevenueData, backgroundColor: "rgba(245, 158, 11, 0.8)", borderColor: "#d97706", borderWidth: 1 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "top" } },
        scales: {
          x: { grid, stacked: true, ticks: { font: { family: fontFamily }, maxRotation: 45 } },
          y: { grid, stacked: true, ticks: { font: { family: fontFamily }, callback: (v) => rupeeTick(v) } },
        },
      },
    });
  }

  const profitCtx = document.getElementById("chart-profit")?.getContext("2d");
  if (profitCtx) {
    chartProfit = new Chart(profitCtx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "Profit (₹)", data: profitData, backgroundColor: "rgba(34, 197, 94, 0.6)", borderColor: "#16a34a", borderWidth: 1 },
          { label: "Expenses (₹)", data: expenseData, backgroundColor: "rgba(239, 68, 68, 0.5)", borderColor: "#dc2626", borderWidth: 1 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "top" } },
        scales: {
          x: { grid, ticks: { font: { family: fontFamily }, maxRotation: 45 } },
          y: { grid, ticks: { font: { family: fontFamily }, callback: (v) => rupeeTick(v) } },
        },
      },
    });
  }

  const fuelCtx = document.getElementById("chart-fuel-mix")?.getContext("2d");
  if (fuelCtx) {
    const petrolL = series.reduce((s, d) => s + d.petrolL, 0);
    const dieselL = series.reduce((s, d) => s + d.dieselL, 0);
    chartFuelMix = new Chart(fuelCtx, {
      type: "doughnut",
      data: {
        labels: ["Petrol (L)", "Diesel (L)"],
        datasets: [
          {
            data: [petrolL, dieselL],
            backgroundColor: ["#3b82f6", "#f59e0b"],
            borderWidth: 2,
            borderColor: "#fff",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom" },
        },
      },
    });
  }
}

function computeInsights(series, totals, profitGrowthPercent) {
  const numDays = series.length;
  const daysWithSales = series.filter((d) => d.salesRupees > 0).length;
  const avgDailySales = numDays > 0 ? totals.salesRupees / numDays : null;
  const profitMarginPct =
    totals.salesRupees > 0
      ? (totals.profitRupees / totals.salesRupees) * 100
      : null;
  const totalVolumeL = series.reduce((s, d) => s + d.petrolL + d.dieselL, 0);
  const expenseRatioPct =
    totals.salesRupees > 0
      ? (totals.expenseRupees / totals.salesRupees) * 100
      : null;
  const bestDay =
    series.length > 0
      ? series.reduce((a, b) => (b.salesRupees > a.salesRupees ? b : a), series[0])
      : null;
  const daysProfitable = series.filter((d) => d.profitRupees > 0).length;
  const petrolRevenue = series.reduce((s, d) => s + (d.petrolRupees ?? 0), 0);
  const dieselRevenue = series.reduce((s, d) => s + (d.dieselRupees ?? 0), 0);
  const totalRevenue = petrolRevenue + dieselRevenue;
  const petrolSharePct = totalRevenue > 0 ? (petrolRevenue / totalRevenue) * 100 : null;

  const bestDayDate =
    bestDay && bestDay.date
      ? (() => {
          const d = new Date(`${bestDay.date}T00:00:00`);
          return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
        })()
      : null;

  return {
    numDays,
    avgDailySales,
    profitMarginPct,
    totalVolumeL: totalVolumeL > 0 ? totalVolumeL : null,
    expenseRatioPct,
    bestDayAmount: bestDay ? bestDay.salesRupees : null,
    bestDayDate,
    daysProfitable,
    totalDays: numDays,
    petrolSharePct,
    profitGrowthPercent: profitGrowthPercent ?? null,
  };
}

async function loadAndRender(range) {
  const label = document.getElementById("analysis-date-label");
  const salesEl = document.getElementById("analysis-total-sales");
  if (label) label.textContent = "Loading…";
  if (salesEl) salesEl.textContent = "…";

  const { dsrData, expenseData } = await fetchAnalysisData(range.start, range.end);
  const series = buildDailySeries(dsrData, expenseData, range.start, range.end);

  const totals = {
    salesRupees: series.reduce((s, d) => s + d.salesRupees, 0),
    expenseRupees: series.reduce((s, d) => s + d.expenseRupees, 0),
    profitRupees: 0,
  };
  totals.profitRupees = totals.salesRupees - totals.expenseRupees;

  let growthPercent = null;
  let profitGrowthPercent = null;
  try {
    const prev = getPreviousPeriodStartEnd(range.start, range.end);
    const prevData = await fetchAnalysisData(prev.start, prev.end);
    const prevSeries = buildDailySeries(
      prevData.dsrData,
      prevData.expenseData,
      prev.start,
      prev.end
    );
    const prevSales = prevSeries.reduce((s, d) => s + d.salesRupees, 0);
    const prevProfit = prevSeries.reduce((s, d) => s + (d.profitRupees ?? 0), 0);
    growthPercent = computeGrowthPercent(totals.salesRupees, prevSales);
    profitGrowthPercent = computeGrowthPercent(totals.profitRupees, prevProfit);
  } catch {
    // no prior data or error
  }

  const insights = computeInsights(series, totals, profitGrowthPercent);

  updateAnalysisDateLabel(range, range.modeInfo);
  renderKPIs(totals, growthPercent, insights);
  renderInsights(series, totals, insights);
  renderCharts(series, totals);
}

async function initAnalysisPage() {
  const rangeSelect = document.getElementById("analysis-range");
  const startInput = document.getElementById("analysis-start");
  const endInput = document.getElementById("analysis-end");
  const form = document.getElementById("analysis-filter-form");
  const customRange = document.getElementById("analysis-custom-range");

  if (!rangeSelect || !form || !customRange) return;

  const ANALYSIS_RANGES = new Set(["this-week", "this-month", "last-3-months", "custom"]);
  const stored = typeof window.getValidFilterState === "function"
    ? window.getValidFilterState("analysis", ANALYSIS_RANGES)
    : null;
  if (stored) {
    rangeSelect.value = stored.range;
    if (stored.range === "custom" && stored.start && stored.end && startInput && endInput) {
      startInput.value = stored.start;
      endInput.value = stored.end;
    }
  } else if (!ANALYSIS_RANGES.has(rangeSelect.value)) {
    rangeSelect.value = "this-month";
  }

  const isCustom = rangeSelect.value === "custom";
  setCustomRangeVisibility(customRange, startInput, endInput, isCustom);
  if (isCustom && (!startInput?.value || !endInput?.value)) {
    const today = new Date();
    if (startInput) startInput.value = formatDateInput(today);
    if (endInput) endInput.value = formatDateInput(today);
  }

  const initialRange = getRangeForSelection(
    rangeSelect.value,
    startInput,
    endInput
  );
  if (initialRange) await loadAndRender(initialRange);

  const saveAnalysisFilter = () => {
    window.setFilterState && window.setFilterState("analysis", {
      range: rangeSelect.value,
      start: startInput?.value || undefined,
      end: endInput?.value || undefined,
    });
  };

  rangeSelect.addEventListener("change", async () => {
    const isCustom = rangeSelect.value === "custom";
    setCustomRangeVisibility(customRange, startInput, endInput, isCustom);
    if (isCustom && (!startInput?.value || !endInput?.value)) {
      const today = new Date();
      if (startInput) startInput.value = formatDateInput(today);
      if (endInput) endInput.value = formatDateInput(today);
    }
    saveAnalysisFilter();
    const range = getRangeForSelection(rangeSelect.value, startInput, endInput);
    if (!range) return;
    updateAnalysisDateLabel(range, range.modeInfo);
    await loadAndRender(range);
    if (isCustom) saveAnalysisFilter();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (rangeSelect.value === "custom" && startInput?.value && endInput?.value && startInput.value > endInput.value) {
      alert("Start date cannot be after end date.");
      return;
    }
    const range = getRangeForSelection(
      rangeSelect.value,
      startInput,
      endInput
    );
    if (!range) return;
    await loadAndRender(range);
    saveAnalysisFilter();
  });

  if (startInput && endInput) {
    const onCustomChange = async () => {
      if (rangeSelect.value !== "custom") return;
      if (startInput.value && endInput.value && startInput.value > endInput.value) return;
      const range = getRangeForSelection(
        rangeSelect.value,
        startInput,
        endInput
      );
      if (!range) return;
      await loadAndRender(range);
      saveAnalysisFilter();
    };
    startInput.addEventListener("change", onCustomChange);
    endInput.addEventListener("change", onCustomChange);
  }
}
