/* global supabaseClient, requireAuth, applyRoleVisibility, formatCurrency */

document.addEventListener("DOMContentLoaded", async () => {
  const auth = await requireAuth({ allowedRoles: ["admin", "supervisor"] });
  if (!auth) return;

  const { role, session } = auth;
  const currentUserId = session?.user?.id ?? null;
  applyRoleVisibility(role);

  const form = document.getElementById("credit-form");
  if (form) {
    form.addEventListener("submit", (event) =>
      handleCreditSubmit(event, currentUserId)
    );
  }

  loadCreditLedger();
});

async function handleCreditSubmit(event, currentUserId) {
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
  if (currentUserId) {
    payload.created_by = currentUserId;
  }

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
  try {
    localStorage.setItem("credit-updated", String(Date.now()));
  } catch (e) {
    /* ignore */
  }
}

async function loadCreditLedger() {
  const tbody = document.getElementById("credit-table-body");
  if (!tbody) return;
  tbody.innerHTML = "<tr><td colspan='6' class='muted'>Fetching credit ledger…</td></tr>";

  const { data, error } = await supabaseClient
    .from("credit_customers")
    .select("id, customer_name, vehicle_no, amount_due, last_payment, notes")
    .order("created_at", { ascending: false })
    .limit(25);

  if (error) {
    tbody.innerHTML = `<tr><td colspan="6" class="error">${error.message}</td></tr>`;
    return;
  }

  if (!data?.length) {
    tbody.innerHTML = "<tr><td colspan='6' class='muted'>No credit customers recorded yet.</td></tr>";
    return;
  }

  tbody.innerHTML = "";
  data.forEach((row) => {
    const tr = document.createElement("tr");
    const actionHtml = Number(row.amount_due) > 0
      ? `<div class="settle-inline">
           <input type="number" min="0" step="0.01" class="settle-amount" placeholder="0.00" />
           <button class="settle-confirm" data-id="${row.id}">Settle</button>
           <span class="settle-msg muted" aria-hidden="true"></span>
         </div>`
      : `<div class="settle-inline">
           <span class="muted">Cleared</span>
           <button class="delete-entry" data-id="${row.id}" title="Delete settled entry">Delete</button>
           <span class="settle-msg muted" aria-hidden="true"></span>
         </div>`;

    tr.innerHTML = `
      <td>${escapeHtml(row.customer_name)}</td>
      <td>${escapeHtml(row.vehicle_no ?? "—")}</td>
      <td data-amount="${row.amount_due}">${formatCurrency(row.amount_due)}</td>
      <td>${row.last_payment ?? "—"}</td>
      <td>${escapeHtml(row.notes ?? "—")}</td>
      <td>${actionHtml}</td>
    `;
    tbody.appendChild(tr);
  });
}

// Handle inline settle confirm clicks
document.addEventListener("click", async (e) => {
  const btn = e.target.closest && e.target.closest(".settle-confirm");
  if (!btn) return;
  const id = btn.dataset.id;
  const container = btn.closest(".settle-inline");
  if (!id || !container) return;
  const input = container.querySelector(".settle-amount");
  const msg = container.querySelector(".settle-msg");
  msg.textContent = "";

  const raw = input.value;
  const paid = Number(raw || 0);
  if (!paid || paid <= 0) {
    msg.textContent = "Enter amount";
    return;
  }

  // fetch current amount for id to be safe
  const { data: currentRow, error: fetchErr } = await supabaseClient
    .from("credit_customers")
    .select("amount_due")
    .eq("id", id)
    .single();
  if (fetchErr || !currentRow) {
    msg.textContent = fetchErr?.message || "Record not found";
    return;
  }

  const current = Number(currentRow.amount_due) || 0;
  const settleAmount = Math.min(paid, current);
  const newAmount = Number((current - settleAmount).toFixed(2));

  const today = new Date().toISOString().slice(0, 10);
  btn.disabled = true;
  const { data: updatedRows, error: updateErr } = await supabaseClient
    .from("credit_customers")
    .update({ amount_due: newAmount, last_payment: today })
    .eq("id", id)
    .select();
  btn.disabled = false;

  console.debug("settle update result", { id, updatedRows, updateErr });

  if (updateErr) {
    msg.textContent = updateErr.message;
    console.error("Failed to update credit_customers:", updateErr);
    return;
  }
  // update row in-place and show whether fully settled
  const remaining = newAmount;
  const tr = btn.closest("tr");
  const amountCell = tr && tr.querySelector("td[data-amount]");
  if (amountCell) {
    amountCell.setAttribute("data-amount", remaining);
    amountCell.textContent = formatCurrency(remaining);
  }
  // update last payment cell (column 3)
  if (tr) {
    const cells = tr.querySelectorAll("td");
    if (cells && cells.length >= 4) {
      cells[3].textContent = today;
    }
  }

  input.value = "";
  msg.classList.remove("muted");
  msg.classList.add("success");
  if (remaining === 0) {
    msg.textContent = "Fully settled";
  } else {
    msg.textContent = `Settled · remaining ${formatCurrency(remaining)}`;
  }
  // update action controls for fully settled after a short delay (allow msg to appear)
  if (remaining === 0) {
    setTimeout(() => {
      if (container && container.parentElement) {
        container.parentElement.innerHTML = `<div class="settle-inline">
           <span class="muted">Cleared</span>
           <button class="delete-entry" data-id="${id}" title="Delete settled entry">Delete</button>
           <span class="settle-msg muted" aria-hidden="true"></span>
         </div>`;
      }
    }, 800);
  }

  // clear the status after a short delay
  setTimeout(() => {
    msg.classList.remove("success");
    msg.classList.add("muted");
    msg.textContent = "";
  }, 3500);
  try {
    localStorage.setItem("credit-updated", String(Date.now()));
  } catch (e) {
    /* ignore */
  }
});

// Handle delete button clicks for settled entries
document.addEventListener("click", async (e) => {
  const btn = e.target.closest && e.target.closest(".delete-entry");
  if (!btn) return;

  const id = btn.dataset.id;
  if (!id) return;

  const tr = btn.closest("tr");
  const customerName = tr ? tr.querySelector("td")?.textContent : "this entry";

  // Confirm deletion
  const confirmed = confirm(`Are you sure you want to delete the settled entry for "${customerName}"? This action cannot be undone.`);
  if (!confirmed) return;

  const container = btn.closest(".settle-inline");
  const msg = container?.querySelector(".settle-msg");

  btn.disabled = true;
  if (msg) msg.textContent = "Deleting…";

  const { error } = await supabaseClient
    .from("credit_customers")
    .delete()
    .eq("id", id);

  if (error) {
    btn.disabled = false;
    if (msg) {
      msg.classList.remove("muted");
      msg.classList.add("error");
      msg.textContent = error.message;
    }
    console.error("Failed to delete credit entry:", error);
    return;
  }

  // Remove the row from the table
  if (tr) {
    tr.style.transition = "opacity 0.3s ease";
    tr.style.opacity = "0";
    setTimeout(() => {
      tr.remove();
      // Check if table is now empty
      const tbody = document.getElementById("credit-table-body");
      if (tbody && tbody.querySelectorAll("tr").length === 0) {
        tbody.innerHTML = "<tr><td colspan='6' class='muted'>No credit customers recorded yet.</td></tr>";
      }
    }, 300);
  }

  try {
    localStorage.setItem("credit-updated", String(Date.now()));
  } catch (e) {
    /* ignore */
  }
});

// simple HTML escape for attribute injection safety
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
