/* global supabaseClient, requireAuth, applyRoleVisibility, formatCurrency */

document.addEventListener("DOMContentLoaded", async () => {
  const auth = await requireAuth({
    allowedRoles: ["admin", "supervisor"],
    onDenied: "dashboard.html",
  });
  if (!auth) return;
  applyRoleVisibility(auth.role);

  const dateInput = document.getElementById("credit-overdue-date");
  const todayStr = new Date().toISOString().slice(0, 10);
  if (dateInput) {
    dateInput.value = todayStr;
    dateInput.addEventListener("change", () => {
      const value = dateInput.value || todayStr;
      loadOpenCredit(value);
    });
  }

  loadOpenCredit(todayStr);
});

async function loadOpenCredit(dateStr) {
  const tbody = document.getElementById("credit-overdue-body");
  const summary = document.getElementById("credit-overdue-summary");
  if (!tbody) return;

  tbody.innerHTML = "<tr><td colspan='5' class='muted'>Loading…</td></tr>";

  const endOfDay = `${dateStr}T23:59:59.999Z`;
  const { data, error } = await supabaseClient
    .from("credit_customers")
    .select("customer_name, vehicle_no, amount_due, last_payment, created_at")
    .gt("amount_due", 0)
    .lte("created_at", endOfDay)
    .or(`last_payment.is.null,last_payment.lt.${dateStr}`)
    .order("amount_due", { ascending: false });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="5" class="error">${error.message}</td></tr>`;
    if (summary) summary.textContent = "Unable to load.";
    return;
  }

  if (!data?.length) {
    tbody.innerHTML =
      "<tr><td colspan='5' class='muted'>No outstanding credits.</td></tr>";
    if (summary) summary.textContent = `No pending credits on ${dateStr}.`;
    return;
  }

  const totalDue = data.reduce(
    (sum, row) => sum + Number(row.amount_due ?? 0),
    0
  );
  if (summary) {
    summary.textContent = `${data.length} customers · ${formatCurrency(
      totalDue
    )} outstanding`;
  }

  tbody.innerHTML = "";
  data.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.customer_name}</td>
      <td>${row.vehicle_no ?? "—"}</td>
      <td>${formatCurrency(row.amount_due)}</td>
      <td>${row.last_payment ?? "—"}</td>
      <td>${formatDate(row.created_at)}</td>
    `;
    tbody.appendChild(tr);
  });
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
