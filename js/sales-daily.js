/* global supabaseClient, requireAuth, applyRoleVisibility, getValidFilterState, setFilterState */

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
  const todayStr = new Date().toISOString().slice(0, 10);

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
      startInput.value = todayStr;
      endInput.value = todayStr;
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

async function loadDailySummary(startDate, endDate) {
  const tbody = document.getElementById("sales-daily-body");
  if (!tbody) return;
  tbody.innerHTML = "<tr><td colspan='12' class='muted'>Loading…</td></tr>";

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
    const message = dsrError?.message ?? stockError?.message ?? "Unable to load.";
    tbody.innerHTML = `<tr><td colspan="12" class="error">${message}</td></tr>`;
    return;
  }

  const combined = mergeDailyData(dsrData ?? [], stockData ?? []);

  if (!combined.length) {
    tbody.innerHTML =
      "<tr><td colspan='12' class='muted'>No entries found.</td></tr>";
    return;
  }

  tbody.innerHTML = "";
  combined.forEach((row) => {
    const netSale = Number(row.total_sales ?? 0) - Number(row.testing ?? 0);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.date}</td>
      <td>${row.product}</td>
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
    `;
    tbody.appendChild(tr);
  });
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
