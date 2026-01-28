/* global supabaseClient, requireAuth, applyRoleVisibility, formatCurrency */

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
    // Rates are always computed from DSR entries; keep them read-only.
    if (petrolRateInput) petrolRateInput.readOnly = true;
    if (dieselRateInput) dieselRateInput.readOnly = true;
  };
  
  if (snapshotDateInput) {
    snapshotDateInput.value = todayStr;
    enforceRateFieldsReadOnly(); // Set initial state
    
    snapshotDateInput.addEventListener("change", async () => {
      const dateValue = snapshotDateInput.value || todayStr;
      enforceRateFieldsReadOnly();
      await Promise.all([loadTodaySales(dateValue), loadCreditSummary(dateValue)]);
    });
  }
  enforceRateFieldsReadOnly();

  try {
    await Promise.all([
      loadTodaySales(todayStr),
      loadCreditSummary(todayStr),
      initializeDsrDashboard(),
      initializeProfitLossFilter(),
      loadRecentActivity(),
    ]);
    console.log("All dashboard initializations completed successfully");
    scheduleAutoFitStats();
  } catch (error) {
    console.error("Error during dashboard initialization:", error);
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

  // Normalize the selection (some browsers may restore stale/invalid values).
  // Only force "this-month" when the current selection is invalid/empty.
  const allowedSelections = new Set(["this-week", "this-month", "custom"]);
  const currentSelection = rangeSelect.value;
  if (!allowedSelections.has(currentSelection)) {
    rangeSelect.value = "this-month";
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

  rangeSelect.addEventListener("change", async () => {
    const isCustom = rangeSelect.value === "custom";
    setCustomRangeVisibility(customRange, startInput, endInput, isCustom);
    if (isCustom) {
      if (!startInput.value && !endInput.value) {
        const today = new Date();
        startInput.value = formatDateInput(today);
        endInput.value = formatDateInput(today);
      }
      // Load data with pre-filled dates and show the date range
      const range = getRangeForSelection(
        rangeSelect.value,
        startInput,
        endInput
      );
      if (range) {
        updateDsrLabel(range, range.modeInfo);
        await loadDsrSummary(range);
      }
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

  const { data, error } = await supabaseClient
    .from("dsr")
    .select("product, total_sales, petrol_rate, diesel_rate")
    .eq("date", selectedDate);

  if (error) {
    console.error("DSR query error:", error);
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

  snapshotDsrRows = data ?? [];

  const totalLiters = snapshotDsrRows.reduce(
    (sum, row) => sum + Number(row.total_sales ?? 0),
    0
  );

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
    (row) => row.total_sales
  );
  const dieselLiters = sumByProduct(
    snapshotDsrRows,
    "diesel",
    (row) => row.total_sales
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
  const endOfDay = new Date(`${selectedDate}T23:59:59.999Z`).getTime();

  // Fetch outstanding rows and filter client-side by last_payment (fallback to created_at)
  const { data, error } = await supabaseClient
    .from("credit_customers")
    .select("customer_name, amount_due, last_payment, created_at")
    .gt("amount_due", 0);

  if (error) {
    console.error(error);
    if (creditTotal) creditTotal.textContent = "—";
    return;
  }

  const filtered = (data ?? []).filter((row) => {
    const last = row.last_payment ? new Date(`${row.last_payment}T00:00:00Z`) : null;
    const created = row.created_at ? new Date(row.created_at) : null;
    const effective = last || created;
    if (!effective) return false;
    return effective.getTime() <= endOfDay;
  });

  const total = filtered.reduce((sum, row) => sum + Number(row.amount_due ?? 0), 0);
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

  if (dsrError) console.error(dsrError);
  if (creditError) console.error(creditError);

  const entries = [];

  (dsrData ?? []).forEach((row) => {
    entries.push({
      type: "DSR",
      label: `${row.product?.toUpperCase() ?? ""}`,
      detail: formatCurrency(row.total_sales),
      timestamp: row.created_at ?? row.date,
    });
  });

  (creditData ?? []).forEach((row) => {
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
    li.innerHTML = `<strong>${entry.type}:</strong> ${entry.label} · ${entry.detail}`;
    list.appendChild(li);
  });
}

async function loadDsrSummary(range) {
  const petrolStockEl = document.getElementById("dsr-petrol-stock");
  const dieselStockEl = document.getElementById("dsr-diesel-stock");
  const petrolNetSaleEl = document.getElementById("dsr-petrol-net-sale");
  const dieselNetSaleEl = document.getElementById("dsr-diesel-net-sale");
  const petrolNetSaleRupeesEl = document.getElementById(
    "dsr-petrol-net-sale-rupees"
  );
  const dieselNetSaleRupeesEl = document.getElementById(
    "dsr-diesel-net-sale-rupees"
  );
  const petrolVariationEl = document.getElementById("dsr-petrol-variation");
  const dieselVariationEl = document.getElementById("dsr-diesel-variation");
  const expenseEl = document.getElementById("dsr-expense");

  if (petrolStockEl) petrolStockEl.textContent = "Loading…";
  if (dieselStockEl) dieselStockEl.textContent = "Loading…";
  if (petrolNetSaleEl) petrolNetSaleEl.textContent = "Loading…";
  if (dieselNetSaleEl) dieselNetSaleEl.textContent = "Loading…";
  if (petrolNetSaleRupeesEl) petrolNetSaleRupeesEl.textContent = "Loading…";
  if (dieselNetSaleRupeesEl) dieselNetSaleRupeesEl.textContent = "Loading…";
  if (petrolVariationEl) petrolVariationEl.textContent = "Loading…";
  if (dieselVariationEl) dieselVariationEl.textContent = "Loading…";
  if (expenseEl) expenseEl.textContent = "Loading…";

  const [
    { data: dsrData, error: dsrError },
    { data: stockData, error: stockError },
    { data: expenseData, error: expenseError },
  ] = await Promise.all([
    supabaseClient
      .from("dsr")
      .select("product, total_sales, testing, stock, petrol_rate, diesel_rate")
      .gte("date", range.start)
      .lte("date", range.end),
    supabaseClient
      .from("dsr_stock")
      .select("product, variation")
      .gte("date", range.start)
      .lte("date", range.end),
    supabaseClient
      .from("expenses")
      .select("*")
      .gte("date", range.start)
      .lte("date", range.end),
  ]);

  if (dsrError) console.error(dsrError);
  if (stockError) console.error(stockError);
  if (expenseError) console.error(expenseError);

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
  const totalNetSale = petrolNetSale + dieselNetSale;
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

  console.log("initializeProfitLossFilter - Elements:", { 
    rangeSelect: !!rangeSelect, 
    startInput: !!startInput, 
    endInput: !!endInput, 
    form: !!form, 
    customRange: !!customRange, 
    label: !!label 
  });

  if (!rangeSelect || !startInput || !endInput || !form || !customRange || !label) {
    console.warn("P&L filter elements not found", { rangeSelect, startInput, endInput, form, customRange, label });
    return;
  }

  // Normalize the selection (some browsers may restore stale/invalid values).
  // Only force "this-month" when the current selection is invalid/empty.
  const allowedSelections = new Set(["this-week", "this-month", "custom"]);
  const currentSelection = rangeSelect.value;
  if (!allowedSelections.has(currentSelection)) {
    rangeSelect.value = "this-month";
  }

  const isCustom = rangeSelect.value === "custom";
  console.log("initializeProfitLossFilter - currentSelection:", rangeSelect.value, "isCustom:", isCustom);

  console.log("initializeProfitLossFilter - Calling setCustomRangeVisibility with isCustom:", isCustom);
  setCustomRangeVisibility(customRange, startInput, endInput, isCustom);
  console.log("initializeProfitLossFilter - After setCustomRangeVisibility, customRange.classList:", customRange.classList.toString());
  
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
  console.log("initializeProfitLossFilter - initialRange:", initialRange);
  if (initialRange) {
    updatePlLabel(initialRange, initialRange.modeInfo, label);
    await loadProfitLossSummary(initialRange);
  }

  rangeSelect.addEventListener("change", async () => {
    console.log("P&L rangeSelect change event fired - value:", rangeSelect.value);
    const isCustom = rangeSelect.value === "custom";
    
    // Get fresh references to elements
    const customRangeEl = document.getElementById("pl-custom-range");
    const startEl = document.getElementById("pl-start");
    const endEl = document.getElementById("pl-end");
    const labelEl = document.getElementById("pl-date-label");
    
    console.log("P&L change - Elements found:", { customRangeEl: !!customRangeEl, startEl: !!startEl, endEl: !!endEl, labelEl: !!labelEl });
    console.log("P&L change - isCustom:", isCustom, "calling setCustomRangeVisibility");
    
    if (customRangeEl && startEl && endEl) {
      setCustomRangeVisibility(customRangeEl, startEl, endEl, isCustom);
      console.log("P&L change - After setCustomRangeVisibility, customRangeEl.classList:", customRangeEl.classList.toString());
    }
    
    if (isCustom) {
      if (startEl && endEl && !startEl.value && !endEl.value) {
        const today = new Date();
        startEl.value = formatDateInput(today);
        endEl.value = formatDateInput(today);
      }
      // Load data with pre-filled dates and show the date range
      const range = getRangeForSelection(
        rangeSelect.value,
        startEl,
        endEl
      );
      if (range && labelEl) {
        updatePlLabel(range, range.modeInfo, labelEl);
        await loadProfitLossSummary(range);
      }
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
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    
    // Get fresh references
    const startEl = document.getElementById("pl-start");
    const endEl = document.getElementById("pl-end");
    const labelEl = document.getElementById("pl-date-label");

    // Validate custom date range
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
  });

  const handleCustomChange = async () => {
    if (rangeSelect.value !== "custom") return;
    
    // Get fresh references
    const startEl = document.getElementById("pl-start");
    const endEl = document.getElementById("pl-end");
    const labelEl = document.getElementById("pl-date-label");

    // Validate custom date range
    if (startEl?.value && endEl?.value && startEl.value > endEl.value) {
      console.warn("Start date is after end date, skipping load");
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

  if (dsrError) console.error(dsrError);
  if (expenseError) console.error(expenseError);

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

function formatCurrency(value) {
  if (value === null || value === undefined) return "—";
  if (Number.isNaN(Number(value))) return "—";
  return "₹" + Number(value).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
