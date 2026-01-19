/* global supabaseClient, requireAuth, applyRoleVisibility, formatCurrency */

document.addEventListener("DOMContentLoaded", async () => {
  const auth = await requireAuth({
    allowedRoles: ["admin"],
    onDenied: "credit.html",
  });
  if (!auth) return;

  const { session, role } = auth;
  applyRoleVisibility(role);

  const operatorInfo = document.getElementById("operator-info");
  if (operatorInfo) {
    operatorInfo.textContent = session.user.email;
  }

  await Promise.all([
    loadTodaySales(),
    loadCreditSummary(),
    loadRecentActivity(),
  ]);
});

async function loadTodaySales() {
  const todayStat = document.getElementById("today-total");
  const todayDate = document.getElementById("today-date");

  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10);

  const { data, error } = await supabaseClient
    .from("dsr")
    .select("total_sales")
    .eq("date", dateStr);

  if (error) {
    console.error(error);
    if (todayStat) todayStat.textContent = "—";
    if (todayDate) todayDate.textContent = "Unable to load";
    return;
  }

  const total = (data ?? []).reduce(
    (sum, row) => sum + Number(row.total_sales ?? 0),
    0
  );

  if (todayStat) todayStat.textContent = formatCurrency(total);
  if (todayDate) {
    todayDate.textContent = `for ${today.toLocaleDateString("en-IN", {
      weekday: "short",
      month: "short",
      day: "numeric",
    })}`;
  }
}

async function loadCreditSummary() {
  const creditTotal = document.getElementById("credit-total");
  const { data, error } = await supabaseClient
    .from("credit_customers")
    .select("amount_due");

  if (error) {
    console.error(error);
    if (creditTotal) creditTotal.textContent = "—";
    return;
  }

  const total = (data ?? []).reduce(
    (sum, row) => sum + Number(row.amount_due ?? 0),
    0
  );

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
        .select("date, product, shift, total_sales, created_at")
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
      label: `${row.product?.toUpperCase() ?? ""} · ${row.shift}`,
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
