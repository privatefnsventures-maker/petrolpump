/* global supabaseClient, requireAuth, applyRoleVisibility, formatCurrency */

document.addEventListener("DOMContentLoaded", async () => {
  const auth = await requireAuth({
    allowedRoles: ["admin", "supervisor"],
    onDenied: "dashboard.html",
  });
  if (!auth) return;
  applyRoleVisibility(auth.role);

  const form = document.getElementById("expense-form");
  const successEl = document.getElementById("expense-success");
  const errorEl = document.getElementById("expense-error");
  const dateInput = document.getElementById("expense-date");

  if (dateInput) {
    dateInput.value = new Date().toISOString().slice(0, 10);
  }

  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      successEl?.classList.add("hidden");
      errorEl?.classList.add("hidden");

      const formData = new FormData(form);
      const payload = {
        date: formData.get("date"),
        category: formData.get("category") || null,
        description: formData.get("description") || null,
        amount: Number(formData.get("amount") || 0),
      };

      // Add created_by for RLS policy compliance
      if (auth.session?.user?.id) {
        payload.created_by = auth.session.user.id;
      }

      if (!payload.date) {
        if (errorEl) {
          errorEl.textContent = "Date is required.";
          errorEl.classList.remove("hidden");
        }
        return;
      }

      const { error } = await supabaseClient.from("expenses").insert(payload);

      if (error) {
        if (errorEl) {
          errorEl.textContent = error.message;
          errorEl.classList.remove("hidden");
        }
        return;
      }

      form.reset();
      if (dateInput) {
        dateInput.value = new Date().toISOString().slice(0, 10);
      }
      successEl?.classList.remove("hidden");
      loadExpenses();
    });
  }

  loadExpenses();
});

async function loadExpenses() {
  const tbody = document.getElementById("expense-table-body");
  if (!tbody) return;
  tbody.innerHTML = "<tr><td colspan='4' class='muted'>Loading…</td></tr>";

  const { data, error } = await supabaseClient
    .from("expenses")
    .select("date, category, description, amount")
    .order("date", { ascending: false })
    .limit(20);

  if (error) {
    tbody.innerHTML = `<tr><td colspan='4' class='error'>${error.message}</td></tr>`;
    return;
  }

  if (!data?.length) {
    tbody.innerHTML = "<tr><td colspan='4' class='muted'>No expenses yet.</td></tr>";
    return;
  }

  tbody.innerHTML = "";
  data.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.date}</td>
      <td>${row.category ?? "—"}</td>
      <td>${row.description ?? "—"}</td>
      <td>${formatCurrency(row.amount)}</td>
    `;
    tbody.appendChild(tr);
  });
}
