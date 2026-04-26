/* global supabaseClient, requireAuth, applyRoleVisibility, getValidFilterState, setFilterState */

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

document.addEventListener("DOMContentLoaded", async () => {
  const YYYYMMDD = /^\d{4}-\d{2}-\d{2}$/;
  const dateFromDashboard = (() => {
    try {
      const d = typeof sessionStorage !== "undefined" ? sessionStorage.getItem("petrolpump_sales_daily_from_dashboard") : null;
      if (d && YYYYMMDD.test(d)) {
        sessionStorage.removeItem("petrolpump_sales_daily_from_dashboard");
        return d;
      }
    } catch (_) {}
    return null;
  })();
  const urlDateParam = (() => {
    const p = new URLSearchParams(window.location.search);
    const d = p.get("date");
    return d && YYYYMMDD.test(d) ? d : null;
  })();

  const auth = await requireAuth({
    allowedRoles: ["admin", "supervisor"],
    onDenied: "dashboard.html",
  });
  if (!auth) return;
  applyRoleVisibility(auth.role);

  const startInput = document.getElementById("sales-start-date");
  const endInput = document.getElementById("sales-end-date");
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const curY = now.getFullYear();
  const curM = now.getMonth();
  const pad2 = (n) => String(n).padStart(2, "0");
  const currentMonthRange = {
    start: `${curY}-${pad2(curM + 1)}-01`,
    end: `${curY}-${pad2(curM + 1)}-${pad2(new Date(curY, curM + 1, 0).getDate())}`,
  };

  if (startInput && endInput) {
    const SALES_DAILY_RANGES = new Set(["custom"]);
    const stored = typeof window.getValidFilterState === "function"
      ? window.getValidFilterState("sales_daily", SALES_DAILY_RANGES)
      : null;

    const initialDate = dateFromDashboard || urlDateParam;
    if (initialDate) {
      startInput.value = initialDate;
      endInput.value = initialDate;
      window.setFilterState && window.setFilterState("sales_daily", { range: "custom", start: initialDate, end: initialDate });
    } else if (stored && stored.start && stored.end) {
      startInput.value = stored.start;
      endInput.value = stored.end;
    } else {
      startInput.value = currentMonthRange.start;
      endInput.value = currentMonthRange.end;
    }

    const saveSalesDailyFilter = () => {
      window.setFilterState && window.setFilterState("sales_daily", {
        range: "custom",
        start: startInput.value || undefined,
        end: endInput.value || undefined,
      });
    };

    const onChange = () => {
      const start = startInput.value || todayStr;
      const end = endInput.value || todayStr;
      loadDailySummary(start, end);
      saveSalesDailyFilter();
    };
    startInput.addEventListener("change", onChange);
    endInput.addEventListener("change", onChange);

    loadDailySummary(startInput.value, endInput.value);
  }
});

const TABLE_COLS = 11;

function setProductTableLoading(tbody) {
  tbody.innerHTML = `<tr><td colspan="${TABLE_COLS}" class="muted">Loading…</td></tr>`;
}

function renderProductRows(tbody, rows) {
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="${TABLE_COLS}" class="muted">No entries found.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map((row) => {
      const netSale = Number(row.total_sales ?? 0) - Number(row.testing ?? 0);
      return `<tr>
        <td>${escapeHtml(row.date)}</td>
        <td>${formatQuantity(row.sales_pump1)}</td>
        <td>${formatQuantity(row.sales_pump2)}</td>
        <td>${formatQuantity(row.total_sales)}</td>
        <td>${formatQuantity(row.testing)}</td>
        <td>${formatQuantity(netSale)}</td>
        <td>${formatQuantity(row.stock)}</td>
        <td>${formatQuantity(row.opening_stock)}</td>
        <td>${formatQuantity(row.receipts)}</td>
        <td>${formatQuantity(row.closing_stock)}</td>
        <td>${formatQuantity(row.variation)}</td>
      </tr>`;
    })
    .join("");
}

async function loadDailySummary(startDate, endDate) {
  const tbodyPetrol = document.getElementById("sales-daily-petrol-body");
  const tbodyDiesel = document.getElementById("sales-daily-diesel-body");
  if (!tbodyPetrol || !tbodyDiesel) return;
  setProductTableLoading(tbodyPetrol);
  setProductTableLoading(tbodyDiesel);

  const [
    { data: dsrData, error: dsrError },
    { data: stockData, error: stockError },
  ] = await Promise.all([
    supabaseClient
      .from("dsr")
      .select(
        "date, product, sales_pump1, sales_pump2, total_sales, testing, stock"
      )
      .gte("date", startDate)
      .lte("date", endDate)
      .order("date", { ascending: false }),
    supabaseClient
      .from("dsr_stock")
      .select(
        "date, product, opening_stock, receipts, closing_stock, variation"
      )
      .gte("date", startDate)
      .lte("date", endDate)
      .order("date", { ascending: false }),
  ]);

  if (dsrError || stockError) {
    const message = escapeHtml(dsrError?.message ?? stockError?.message ?? "Unable to load.");
    const errRow = `<tr><td colspan="${TABLE_COLS}" class="error">${message}</td></tr>`;
    tbodyPetrol.innerHTML = errRow;
    tbodyDiesel.innerHTML = errRow;
    return;
  }

  const combined = mergeDailyData(dsrData ?? [], stockData ?? []);
  const petrolRows = [];
  const dieselRows = [];
  for (const row of combined) {
    const p = (row.product || "").toLowerCase();
    if (p === "petrol") petrolRows.push(row);
    else if (p === "diesel") dieselRows.push(row);
  }

  renderProductRows(tbodyPetrol, petrolRows);
  renderProductRows(tbodyDiesel, dieselRows);
}

function mergeDailyData(dsrRows, stockRows) {
  const map = new Map();

  dsrRows.forEach((row) => {
    const key = `${row.date}-${row.product}`;
    map.set(key, {
      date: row.date,
      product: row.product,
      sales_pump1: row.sales_pump1,
      sales_pump2: row.sales_pump2,
      total_sales: row.total_sales,
      testing: row.testing,
      stock: row.stock,
    });
  });

  stockRows.forEach((row) => {
    const key = `${row.date}-${row.product}`;
    const existing = map.get(key) || { date: row.date, product: row.product };
    map.set(key, {
      ...existing,
      opening_stock: row.opening_stock,
      receipts: row.receipts,
      closing_stock: row.closing_stock,
      variation: row.variation,
    });
  });

  return Array.from(map.values()).sort((a, b) => {
    if (a.date === b.date) {
      return a.product.localeCompare(b.product);
    }
    return b.date.localeCompare(a.date);
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
