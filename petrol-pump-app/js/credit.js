/* global supabaseClient, requireAuth, applyRoleVisibility, formatCurrency */

document.addEventListener("DOMContentLoaded", async () => {
  const auth = await requireAuth({ allowedRoles: ["admin", "supervisor"] });
  if (!auth) return;

  const { role } = auth;
  applyRoleVisibility(role);

  const form = document.getElementById("credit-form");
  if (form) {
    form.addEventListener("submit", handleCreditSubmit);
  }

  loadCreditLedger();
});

async function handleCreditSubmit(event) {
  event.preventDefault();

  const successEl = document.getElementById("credit-success");
  const errorEl = document.getElementById("credit-error");
  successEl?.classList.add("hidden");
  errorEl?.classList.add("hidden");

  const form = event.currentTarget;
  const formData = new FormData(form);

  const payload = {
    customer_name: formData.get("customer_name"),
    vehicle_no: formData.get("vehicle_no") || null,
    amount_due: Number(formData.get("amount_due") || 0),
    last_payment: formData.get("last_payment") || null,
    notes: formData.get("notes") || null,
  };

  const { error } = await supabaseClient
    .from("credit_customers")
    .insert(payload);

  if (error) {
    if (errorEl) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
    }
    return;
  }

  form.reset();
  successEl?.classList.remove("hidden");
  loadCreditLedger();
}

async function loadCreditLedger() {
  const tbody = document.getElementById("credit-table-body");
  if (!tbody) return;
  tbody.innerHTML =
    "<tr><td colspan='5' class='muted'>Fetching credit ledger…</td></tr>";

  const { data, error } = await supabaseClient
    .from("credit_customers")
    .select("customer_name, vehicle_no, amount_due, last_payment, notes")
    .order("created_at", { ascending: false })
    .limit(25);

  if (error) {
    tbody.innerHTML = `<tr><td colspan="5" class="error">${error.message}</td></tr>`;
    return;
  }

  if (!data?.length) {
    tbody.innerHTML =
      "<tr><td colspan='5' class='muted'>No credit customers recorded yet.</td></tr>";
    return;
  }

  tbody.innerHTML = "";
  data.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.customer_name}</td>
      <td>${row.vehicle_no ?? "—"}</td>
      <td>${formatCurrency(row.amount_due)}</td>
      <td>${row.last_payment ?? "—"}</td>
      <td>${row.notes ?? "—"}</td>
    `;
    tbody.appendChild(tr);
  });
}
