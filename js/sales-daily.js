/* global supabaseClient, requireAuth, applyRoleVisibility */

document.addEventListener("DOMContentLoaded", async () => {
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
    startInput.value = todayStr;
    endInput.value = todayStr;

    const onChange = () => {
      const start = startInput.value || todayStr;
      const end = endInput.value || todayStr;
      loadDailySummary(start, end);
    };
    startInput.addEventListener("change", onChange);
    endInput.addEventListener("change", onChange);
  }

  loadDailySummary(todayStr, todayStr);
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
