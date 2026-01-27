/* global supabaseClient, requireAuth, applyRoleVisibility */

const PRODUCTS = ["petrol", "diesel"];
let currentUserId = null;

const readingNumberFields = [
  "opening_pump1_nozzle1",
  "opening_pump1_nozzle2",
  "opening_pump2_nozzle1",
  "opening_pump2_nozzle2",
  "closing_pump1_nozzle1",
  "closing_pump1_nozzle2",
  "closing_pump2_nozzle1",
  "closing_pump2_nozzle2",
  "sales_pump1",
  "sales_pump2",
  "total_sales",
  "testing",
  "dip_reading",
  "stock",
];

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
    loadReadingHistory(product);
    loadStockHistory(product);
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
      if (errorEl) {
        errorEl.textContent = error.message;
        errorEl.classList.remove("hidden");
      }
      return;
    }

    form.reset();
    setDefaultDate(form);
    successEl?.classList.remove("hidden");
    loadReadingHistory(product);
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
      if (errorEl) {
        errorEl.textContent = error.message;
        errorEl.classList.remove("hidden");
      }
      return;
    }

    form.reset();
    setDefaultDate(form);
    successEl?.classList.remove("hidden");
    loadStockHistory(product);
  });
}

async function loadReadingHistory(product) {
  const tbody = document.getElementById(`dsr-table-${product}`);
  if (!tbody) return;
  tbody.innerHTML =
    "<tr><td colspan='9' class='muted'>Loading recent readings…</td></tr>";

  const { data, error } = await supabaseClient
    .from("dsr")
    .select(
      "date, sales_pump1, sales_pump2, total_sales, testing, dip_reading, stock, petrol_rate, diesel_rate, remarks"
    )
    .eq("product", product)
    .order("date", { ascending: false })
    .limit(10);

  if (error) {
    tbody.innerHTML = `<tr><td colspan='9' class='error'>${error.message}</td></tr>`;
    return;
  }

  if (!data?.length) {
    tbody.innerHTML =
      "<tr><td colspan='9' class='muted'>No readings saved yet.</td></tr>";
    return;
  }

  tbody.innerHTML = "";
  data.forEach((row) => {
    const tr = document.createElement("tr");
    const rate = product === "petrol" ? row.petrol_rate : row.diesel_rate;
    tr.innerHTML = `
      <td>${row.date}</td>
      <td>${formatQuantity(row.sales_pump1)}</td>
      <td>${formatQuantity(row.sales_pump2)}</td>
      <td>${formatQuantity(row.total_sales)}</td>
      <td>${formatQuantity(row.testing)}</td>
      <td>${formatQuantity(row.dip_reading)}</td>
      <td>${formatQuantity(row.stock)}</td>
      <td>${rate ? formatCurrency(rate) : "—"}</td>
      <td>${row.remarks ?? "—"}</td>
    `;
    tbody.appendChild(tr);
  });
}

async function loadStockHistory(product) {
  const tbody = document.getElementById(`stock-table-${product}`);
  if (!tbody) return;
  tbody.innerHTML =
    "<tr><td colspan='11' class='muted'>Loading stock entries…</td></tr>";

  const { data, error } = await supabaseClient
    .from("dsr_stock")
    .select(
      "date, opening_stock, receipts, total_stock, sale_from_meter, testing, net_sale, closing_stock, dip_stock, variation, remark"
    )
    .eq("product", product)
    .order("date", { ascending: false })
    .limit(10);

  if (error) {
    tbody.innerHTML = `<tr><td colspan='11' class='error'>${error.message}</td></tr>`;
    return;
  }

  if (!data?.length) {
    tbody.innerHTML =
      "<tr><td colspan='11' class='muted'>No stock records yet.</td></tr>";
    return;
  }

  tbody.innerHTML = "";
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
      <td>${row.remark ?? "—"}</td>
    `;
    tbody.appendChild(tr);
  });
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
  const openingP1N1 = getNumber(form, "opening_pump1_nozzle1");
  const openingP1N2 = getNumber(form, "opening_pump1_nozzle2");
  const openingP2N1 = getNumber(form, "opening_pump2_nozzle1");
  const openingP2N2 = getNumber(form, "opening_pump2_nozzle2");
  const closingP1N1 = getNumber(form, "closing_pump1_nozzle1");
  const closingP1N2 = getNumber(form, "closing_pump1_nozzle2");
  const closingP2N1 = getNumber(form, "closing_pump2_nozzle1");
  const closingP2N2 = getNumber(form, "closing_pump2_nozzle2");
  const testing = getNumber(form, "testing");
  const stock = getNumber(form, "stock");
  const openingStock = getNumber(form, "opening_stock");
  const receipts = getNumber(form, "receipts");

  const salesPump1 = (closingP1N1 - openingP1N1) + (closingP1N2 - openingP1N2);
  const salesPump2 = (closingP2N1 - openingP2N1) + (closingP2N2 - openingP2N2);
  const totalSales = salesPump1 + salesPump2;
  const netSale = totalSales - testing;
  const totalStock = openingStock + receipts;
  const variation = stock - (totalStock - netSale);

  setNumber(form, "sales_pump1", salesPump1);
  setNumber(form, "sales_pump2", salesPump2);
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

function formatCurrency(value) {
  if (value === null || value === undefined) return "—";
  if (Number.isNaN(Number(value))) return "—";
  return "₹" + Number(value).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
