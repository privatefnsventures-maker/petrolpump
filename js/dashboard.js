/* global supabaseClient, requireAuth, applyRoleVisibility, formatCurrency */

let snapshotDsrRows = [];

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
  
  console.log("Initial elements found:", { 
    snapshotDateInput: !!snapshotDateInput, 
    petrolRateInput: !!petrolRateInput, 
    dieselRateInput: !!dieselRateInput,
    todayStr
  });
  
  const updateRateFieldsReadOnly = () => {
    const dateValue = snapshotDateInput?.value || todayStr;
    const isToday = dateValue === todayStr;
    console.log("updateRateFieldsReadOnly called - dateValue:", dateValue, "todayStr:", todayStr, "isToday:", isToday);
    console.log("Before - petrolRateInput.disabled:", petrolRateInput?.disabled, "dieselRateInput.disabled:", dieselRateInput?.disabled);
    
    if (petrolRateInput) {
      petrolRateInput.disabled = !isToday;
      console.log("Set petrolRateInput.disabled to:", !isToday);
    }
    if (dieselRateInput) {
      dieselRateInput.disabled = !isToday;
      console.log("Set dieselRateInput.disabled to:", !isToday);
    }
    
    console.log("After - petrolRateInput.disabled:", petrolRateInput?.disabled, "dieselRateInput.disabled:", dieselRateInput?.disabled);
  };
  
  if (snapshotDateInput) {
    snapshotDateInput.value = todayStr;
    updateRateFieldsReadOnly(); // Set initial state
    
    snapshotDateInput.addEventListener("change", async () => {
      const dateValue = snapshotDateInput.value || todayStr;
      console.log("Date changed to:", dateValue);
      updateRateFieldsReadOnly();
      await Promise.all([loadTodaySales(dateValue), loadCreditSummary(dateValue)]);
    });
  }
  if (petrolRateInput) {
    petrolRateInput.addEventListener("input", () => {
      updateTotalSaleRupees();
      updateNetSaleRupeesFromCache();
    });
  }
  if (dieselRateInput) {
    dieselRateInput.addEventListener("input", () => {
      updateTotalSaleRupees();
      updateNetSaleRupeesFromCache();
    });
  }

  await Promise.all([
    loadTodaySales(todayStr),
    loadCreditSummary(todayStr),
    initializeDsrDashboard(),
    loadRecentActivity(),
  ]);
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

  rangeSelect.value = "this-month";
  setCustomRangeVisibility(customRange, startInput, endInput, false);
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
      if (label) {
        label.textContent = "Select custom dates";
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
  console.log("loadTodaySales called with date:", selectedDate);

  const { data, error } = await supabaseClient
    .from("dsr")
    .select("product, total_sales, petrol_rate, diesel_rate")
    .eq("date", selectedDate);

  console.log("Query result:", { data, error, selectedDate });
  console.log("Full data structure:", JSON.stringify(data, null, 2));

  if (error) {
    console.error("DSR query error:", error);
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
    return;
  }

  snapshotDsrRows = data ?? [];
  console.log("snapshotDsrRows set to:", snapshotDsrRows);

  const totalLiters = snapshotDsrRows.reduce(
    (sum, row) => sum + Number(row.total_sales ?? 0),
    0
  );

  console.log("Total liters calculated:", totalLiters);

  // Fetch and set rates from DSR data (if columns exist)
  const petrolEntry = snapshotDsrRows.find((row) => row.product === "petrol");
  const dieselEntry = snapshotDsrRows.find((row) => row.product === "diesel");

  console.log("Rates found:", { petrolEntry, dieselEntry });

  if (petrolEntry?.petrol_rate !== undefined && petrolRateInput) {
    petrolRateInput.value = petrolEntry.petrol_rate;
    console.log("Set petrol rate to:", petrolEntry.petrol_rate);
  } else if (petrolRateInput) {
    petrolRateInput.value = "";
  }

  if (dieselEntry?.diesel_rate !== undefined && dieselRateInput) {
    dieselRateInput.value = dieselEntry.diesel_rate;
    console.log("Set diesel rate to:", dieselEntry.diesel_rate);
  } else if (dieselRateInput) {
    dieselRateInput.value = "";
  }

  if (todayStat) {
    todayStat.textContent = formatQuantity(totalLiters);
    console.log("Set todayStat to:", formatQuantity(totalLiters));
  }
  updateTotalSaleRupees();
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

  console.log("updateTotalSaleRupees called");
  console.log("snapshotDsrRows:", snapshotDsrRows);

  // Get rates from snapshotDsrRows directly, not from input fields
  const petrolEntry = snapshotDsrRows.find((row) => row.product === "petrol");
  const dieselEntry = snapshotDsrRows.find((row) => row.product === "diesel");
  
  console.log("petrolEntry:", petrolEntry);
  console.log("dieselEntry:", dieselEntry);
  
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

  console.log("Final rates - petrol:", petrolRate, "diesel:", dieselRate);

  // Only show currency if at least one rate is available and valid
  if (!Number.isFinite(petrolRate) && !Number.isFinite(dieselRate)) {
    console.log("No finite rates found");
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
  
  console.log("Liters - petrol:", petrolLiters, "diesel:", dieselLiters);
  
  const totalAmount = petrolLiters * petrolRate + dieselLiters * dieselRate;

  console.log("Total amount calculated:", totalAmount);
  
  if (totalAmount === 0) {
    console.log("Total amount is 0, showing dash");
    todayRupees.textContent = "—";
  } else {
    todayRupees.textContent = formatCurrency(totalAmount);
    console.log("Price displayed:", todayRupees.textContent);
  }
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
  const plNetSaleEl = document.getElementById("pl-net-sale");
  const plExpenseEl = document.getElementById("pl-expense");
  const plValueEl = document.getElementById("pl-value");
  const plLabelEl = document.getElementById("pl-label");

  if (petrolStockEl) petrolStockEl.textContent = "Loading…";
  if (dieselStockEl) dieselStockEl.textContent = "Loading…";
  if (petrolNetSaleEl) petrolNetSaleEl.textContent = "Loading…";
  if (dieselNetSaleEl) dieselNetSaleEl.textContent = "Loading…";
  if (petrolNetSaleRupeesEl) petrolNetSaleRupeesEl.textContent = "Loading…";
  if (dieselNetSaleRupeesEl) dieselNetSaleRupeesEl.textContent = "Loading…";
  if (petrolVariationEl) petrolVariationEl.textContent = "Loading…";
  if (dieselVariationEl) dieselVariationEl.textContent = "Loading…";
  if (expenseEl) expenseEl.textContent = "Loading…";
  if (plNetSaleEl) plNetSaleEl.textContent = "Loading…";
  if (plExpenseEl) plExpenseEl.textContent = "Loading…";
  if (plValueEl) plValueEl.textContent = "Loading…";

  const [
    { data: dsrData, error: dsrError },
    { data: stockData, error: stockError },
    { data: expenseData, error: expenseError },
  ] = await Promise.all([
    supabaseClient
      .from("dsr")
      .select("product, total_sales, testing, stock")
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

  console.log("loadDsrSummary - Date range:", { start: range.start, end: range.end });
  console.log("Expense data fetched:", { expenseData, expenseError });
  if (expenseData) {
    console.log("Expense records count:", expenseData.length);
    console.log("All expense records:", JSON.stringify(expenseData, null, 2));
  }

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

  console.log("Expense total calculated:", { expenseTotal, expenseDataLength: expenseData?.length });

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
  updateNetSaleRupees(petrolNetSale, dieselNetSale, hasDsr);
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
  container.classList.toggle("hidden", !isVisible);
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
  return (rows ?? []).reduce((sum, row) => {
    if (row.product !== product) return sum;
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

function updateNetSaleRupees(petrolLiters, dieselLiters, isActive, petrolRate = 0, dieselRate = 0) {
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

  // Use provided rates or fallback to input fields
  let pRate = petrolRate;
  let dRate = dieselRate;
  
  if (pRate === 0) {
    pRate = Number(
      document.getElementById("snapshot-petrol-rate")?.value || 0
    );
  }
  if (dRate === 0) {
    dRate = Number(
      document.getElementById("snapshot-diesel-rate")?.value || 0
    );
  }

  if (!pRate) {
    petrolNetSaleRupeesEl.textContent = "—";
  } else {
    petrolNetSaleRupeesEl.textContent = formatCurrency(
      petrolLiters * pRate
    );
  }

  if (!dRate) {
    dieselNetSaleRupeesEl.textContent = "—";
  } else {
    dieselNetSaleRupeesEl.textContent = formatCurrency(
      dieselLiters * dRate
    );
  }
}

function updateNetSaleRupeesFromCache() {
  if (!snapshotDsrRows?.length) return;
  
  const petrolEntry = snapshotDsrRows.find((row) => row.product === "petrol");
  const dieselEntry = snapshotDsrRows.find((row) => row.product === "diesel");
  const petrolRate = Number(petrolEntry?.petrol_rate || 0);
  const dieselRate = Number(dieselEntry?.diesel_rate || 0);
  
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
  updateNetSaleRupees(petrolNetSale, dieselNetSale, true, petrolRate, dieselRate);
}

function formatCurrency(value) {
  if (value === null || value === undefined) return "—";
  if (Number.isNaN(Number(value))) return "—";
  return "₹" + Number(value).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
