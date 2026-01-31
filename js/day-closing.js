/* global supabaseClient, requireAuth, applyRoleVisibility, formatCurrency, AppCache, AppError, getLocalDateString */

// Day closing & short: (Total sale + Collection + Short previous) − (Night cash + Phone pay + Credit + Expenses) = Today's short
let dayClosingBreakdown = null;

async function loadDayClosingBreakdown(dateStr) {
  const dateInput = document.getElementById("day-closing-date");
  const nightCashInput = document.getElementById("dc-night-cash");
  const phonePayInput = document.getElementById("dc-phone-pay");
  const totalSaleEl = document.getElementById("dc-total-sale");
  const collectionEl = document.getElementById("dc-collection");
  const shortPrevEl = document.getElementById("dc-short-previous");
  const subtotalEl = document.getElementById("dc-subtotal");
  const creditTodayEl = document.getElementById("dc-credit-today");
  const expensesTodayEl = document.getElementById("dc-expenses-today");
  const shortTodayEl = document.getElementById("dc-short-today");
  const successEl = document.getElementById("day-closing-success");
  const errorEl = document.getElementById("day-closing-error");

  if (!dateStr || !dateInput) return;

  successEl?.classList.add("hidden");
  errorEl?.classList.add("hidden");
  if (totalSaleEl) totalSaleEl.textContent = "…";
  if (collectionEl) collectionEl.textContent = "…";
  if (shortPrevEl) shortPrevEl.textContent = "…";
  if (subtotalEl) subtotalEl.textContent = "…";
  if (creditTodayEl) creditTodayEl.textContent = "…";
  if (expensesTodayEl) expensesTodayEl.textContent = "…";
  if (shortTodayEl) shortTodayEl.textContent = "…";

  try {
    const { data, error } = await supabaseClient.rpc("get_day_closing_breakdown", { p_date: dateStr });
    if (error) throw error;
    dayClosingBreakdown = data;
  } catch (err) {
    AppError.report(err, { context: "loadDayClosingBreakdown" });
    dayClosingBreakdown = null;
    if (totalSaleEl) totalSaleEl.textContent = "—";
    if (collectionEl) collectionEl.textContent = "—";
    if (shortPrevEl) shortPrevEl.textContent = "—";
    if (subtotalEl) subtotalEl.textContent = "—";
    if (creditTodayEl) creditTodayEl.textContent = "—";
    if (expensesTodayEl) expensesTodayEl.textContent = "—";
    if (shortTodayEl) shortTodayEl.textContent = "—";
    if (errorEl) {
      errorEl.textContent = err?.message || "Failed to load day closing breakdown.";
      errorEl.classList.remove("hidden");
    }
    return;
  }

  const b = dayClosingBreakdown || {};
  const totalSale = Number(b.total_sale ?? 0);
  const collection = Number(b.collection ?? 0);
  const shortPrevious = Number(b.short_previous ?? 0);
  const creditToday = Number(b.credit_today ?? 0);
  const expensesToday = Number(b.expenses_today ?? 0);
  const subtotal = totalSale + collection + shortPrevious;

  if (totalSaleEl) totalSaleEl.textContent = formatCurrency(totalSale);
  if (collectionEl) collectionEl.textContent = formatCurrency(collection);
  if (shortPrevEl) shortPrevEl.textContent = formatCurrency(shortPrevious);
  if (subtotalEl) subtotalEl.textContent = formatCurrency(subtotal);
  if (creditTodayEl) creditTodayEl.textContent = formatCurrency(creditToday);
  if (expensesTodayEl) expensesTodayEl.textContent = formatCurrency(expensesToday);

  if (nightCashInput) {
    const v = b.night_cash;
    if (v != null && v !== "") nightCashInput.value = Number(v);
    else nightCashInput.value = "";
  }
  if (phonePayInput) {
    const v = b.phone_pay;
    if (v != null && v !== "") phonePayInput.value = Number(v);
    else phonePayInput.value = "";
  }

  const alreadySaved = !!b.already_saved;
  const saveBtn = document.getElementById("day-closing-save");
  const alreadySavedEl = document.getElementById("day-closing-already-saved");
  if (saveBtn) saveBtn.disabled = alreadySaved;
  if (alreadySavedEl) {
    if (alreadySaved) {
      alreadySavedEl.classList.remove("hidden");
    } else {
      alreadySavedEl.classList.add("hidden");
    }
  }
  successEl?.classList.add("hidden");

  updateDayClosingShortLive();
}

function updateDayClosingShortLive() {
  if (!dayClosingBreakdown) return;
  const nightCashInput = document.getElementById("dc-night-cash");
  const phonePayInput = document.getElementById("dc-phone-pay");
  const shortTodayEl = document.getElementById("dc-short-today");

  const totalSale = Number(dayClosingBreakdown.total_sale ?? 0);
  const collection = Number(dayClosingBreakdown.collection ?? 0);
  const shortPrevious = Number(dayClosingBreakdown.short_previous ?? 0);
  const creditToday = Number(dayClosingBreakdown.credit_today ?? 0);
  const expensesToday = Number(dayClosingBreakdown.expenses_today ?? 0);
  const nightCash = Number(nightCashInput?.value ?? 0) || 0;
  const phonePay = Number(phonePayInput?.value ?? 0) || 0;

  const shortToday = (totalSale + collection + shortPrevious) - (nightCash + phonePay + creditToday + expensesToday);
  if (shortTodayEl) {
    shortTodayEl.textContent = formatCurrency(shortToday);
    shortTodayEl.classList.remove("stat-positive", "stat-negative");
    if (shortToday > 0) shortTodayEl.classList.add("stat-positive");
    else if (shortToday < 0) shortTodayEl.classList.add("stat-negative");
  }
}

async function initializeDayClosing() {
  const dateInput = document.getElementById("day-closing-date");
  const form = document.getElementById("day-closing-form");
  const refreshBtn = document.getElementById("day-closing-refresh");
  const nightCashInput = document.getElementById("dc-night-cash");
  const phonePayInput = document.getElementById("dc-phone-pay");

  if (!dateInput || !form) return;

  const todayStr = typeof getLocalDateString === "function" ? getLocalDateString() : new Date().toISOString().slice(0, 10);
  const dateParam = new URLSearchParams(window.location.search).get("date");
  if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) dateInput.value = dateParam;
  if (!dateInput.value) dateInput.value = todayStr;

  dateInput.addEventListener("change", () => {
    loadDayClosingBreakdown(dateInput.value || todayStr);
  });

  if (nightCashInput) {
    nightCashInput.addEventListener("input", updateDayClosingShortLive);
    nightCashInput.addEventListener("change", updateDayClosingShortLive);
  }
  if (phonePayInput) {
    phonePayInput.addEventListener("input", updateDayClosingShortLive);
    phonePayInput.addEventListener("change", updateDayClosingShortLive);
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    let alreadySavedHandled = false;
    const submitBtn = document.getElementById("day-closing-save");
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Saving…";
    }
    const successEl = document.getElementById("day-closing-success");
    const errorEl = document.getElementById("day-closing-error");
    successEl?.classList.add("hidden");
    errorEl?.classList.add("hidden");

    const dateStr = dateInput.value?.trim();
    const nightCash = Number(document.getElementById("dc-night-cash")?.value ?? 0);
    const phonePay = Number(document.getElementById("dc-phone-pay")?.value ?? 0);
    if (!dateStr) {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Save day closing"; }
      if (errorEl) {
        errorEl.textContent = "Please select a date.";
        errorEl.classList.remove("hidden");
      }
      return;
    }
    if (dayClosingBreakdown?.already_saved) {
      alreadySavedHandled = true;
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Save day closing"; }
      const alreadySavedEl = document.getElementById("day-closing-already-saved");
      if (alreadySavedEl) {
        alreadySavedEl.classList.remove("hidden");
      }
      if (errorEl) errorEl.classList.add("hidden");
      return;
    }
    if (nightCash < 0 || phonePay < 0) {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Save day closing"; }
      if (errorEl) {
        errorEl.textContent = "Night cash and Phone pay must be ≥ 0.";
        errorEl.classList.remove("hidden");
      }
      return;
    }

    try {
      const { data, error } = await supabaseClient.rpc("save_day_closing", {
        p_date: dateStr,
        p_night_cash: nightCash,
        p_phone_pay: phonePay,
      });
      if (error) throw error;
      dayClosingBreakdown = data;
      updateDayClosingShortLive();
      if (successEl) {
        successEl.classList.remove("hidden");
        successEl.textContent = "Day closing saved. Today's short: " + formatCurrency(Number(data?.short_today ?? 0)) + " (stored for next day).";
      }
      if (errorEl) errorEl.classList.add("hidden");
      await loadDayClosingBreakdown(dateStr);
      // Invalidate cache so dashboard day-closing banners and data reflect immediately
      if (typeof AppCache !== "undefined" && AppCache) {
        AppCache.invalidateByType("dashboard_data");
        AppCache.invalidateByType("recent_activity");
      }
    } catch (err) {
      AppError.report(err, { context: "saveDayClosing" });
      const isAlreadySaved = err?.message && String(err.message).includes("already saved for this date");
      if (isAlreadySaved) {
        alreadySavedHandled = true;
        if (errorEl) errorEl.classList.add("hidden");
        const alreadySavedEl = document.getElementById("day-closing-already-saved");
        if (alreadySavedEl) alreadySavedEl.classList.remove("hidden");
        if (submitBtn) submitBtn.disabled = true;
        dayClosingBreakdown = { ...(dayClosingBreakdown || {}), already_saved: true };
        await loadDayClosingBreakdown(dateStr);
      } else {
        if (errorEl) {
          errorEl.textContent = err?.message || "Failed to save day closing.";
          errorEl.classList.remove("hidden");
        }
      }
    } finally {
      if (submitBtn && !alreadySavedHandled) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Save day closing";
      }
    }
  });

  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => loadDayClosingBreakdown(dateInput.value || todayStr));
  }

  await loadDayClosingBreakdown(dateInput.value || todayStr);
}

document.addEventListener("DOMContentLoaded", async () => {
  const auth = await requireAuth({
    allowedRoles: ["admin", "supervisor"],
    onDenied: "dashboard.html",
  });
  if (!auth) return;
  applyRoleVisibility(auth.role);

  await initializeDayClosing();
});
