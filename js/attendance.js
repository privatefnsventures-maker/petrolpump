/* global requireAuth, applyRoleVisibility, supabaseClient, getLocalDateString, AppCache, AppError */

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getMonthStartEnd(year, month) {
  const m = month - 1;
  const start = new Date(year, m, 1);
  const end = new Date(year, m + 1, 0);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

const STATUS_LABELS = {
  present: "Present",
  absent: "Absent",
  half_day: "Half-day",
  leave: "Leave",
};

const SHIFT_STORAGE_KEYS = {
  morningName: "petrolpump_shift_morning_name",
  afternoonName: "petrolpump_shift_afternoon_name",
};
const DEFAULT_SHIFT_NAMES = { morningName: "Morning shift", afternoonName: "Afternoon shift" };

function getShiftConfig() {
  try {
    return {
      morningName: localStorage.getItem(SHIFT_STORAGE_KEYS.morningName) ?? DEFAULT_SHIFT_NAMES.morningName,
      afternoonName: localStorage.getItem(SHIFT_STORAGE_KEYS.afternoonName) ?? DEFAULT_SHIFT_NAMES.afternoonName,
    };
  } catch (_) {
    return { ...DEFAULT_SHIFT_NAMES };
  }
}

function getShiftLabel(shiftValue) {
  if (!shiftValue) return "—";
  const cfg = getShiftConfig();
  if (shiftValue === "morning") return cfg.morningName;
  if (shiftValue === "afternoon") return cfg.afternoonName;
  return shiftValue;
}

document.addEventListener("DOMContentLoaded", async () => {
  const auth = await requireAuth({
    allowedRoles: ["admin", "supervisor"],
    onDenied: "dashboard.html",
    pageName: "attendance",
  });
  if (!auth) return;
  applyRoleVisibility(auth.role);

  const attendanceDateInput = document.getElementById("attendance-date");
  const historyMonthInput = document.getElementById("history-month");
  const attendanceBody = document.getElementById("attendance-body");
  const attendanceSummary = document.getElementById("attendance-summary");
  const attendanceMessage = document.getElementById("attendance-message");
  const attendanceError = document.getElementById("attendance-error");
  const saveAllBtn = document.getElementById("attendance-save-all");
  const historyBody = document.getElementById("attendance-history-body");
  const historyDownloadBtn = document.getElementById("history-download-csv");

  if (attendanceDateInput) {
    attendanceDateInput.value = getLocalDateString();
  }
  const now = new Date();
  if (historyMonthInput) {
    historyMonthInput.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }

  let staffList = [];
  let attendanceByDate = new Map();

  async function loadStaffMembers() {
    const { data, error } = await supabaseClient
      .from("employees")
      .select("id, name, role_display, display_order")
      .eq("is_active", true)
      .order("display_order", { ascending: true })
      .order("name", { ascending: true });

    if (error) {
      AppError.report(error, { context: "loadStaffMembers" });
      return [];
    }
    staffList = data ?? [];
    return staffList;
  }

  async function loadAttendanceForDate(date) {
    const { data, error } = await supabaseClient
      .from("employee_attendance")
      .select("id, employee_id, date, status, shift, note")
      .eq("date", date);

    if (error) {
      AppError.report(error, { context: "loadAttendanceForDate" });
      return [];
    }
    const list = data ?? [];
    const map = new Map();
    list.forEach((r) => map.set(r.employee_id, r));
    attendanceByDate = map;
    return list;
  }

  function showMessage(msg, isError = false) {
    if (attendanceMessage) {
      attendanceMessage.textContent = isError ? "" : msg;
      attendanceMessage.classList.toggle("hidden", isError);
    }
    if (attendanceError) {
      attendanceError.textContent = isError ? msg : "";
      attendanceError.classList.toggle("hidden", !isError);
    }
  }

  function renderAttendanceTable(date) {
    if (!attendanceBody) return;

    if (!staffList.length) {
      attendanceBody.innerHTML =
        '<tr><td colspan="5" class="muted">Add staff in <a href="salary.html">Staff Salary</a> (Manage staff) first.</td></tr>';
      if (attendanceSummary) attendanceSummary.textContent = "";
      return;
    }

    const shiftConfig = getShiftConfig();
    const shiftOptions = [
      { value: "", label: "—" },
      { value: "morning", label: shiftConfig.morningName },
      { value: "afternoon", label: shiftConfig.afternoonName },
    ];

    const present = staffList.filter((s) => {
      const r = attendanceByDate.get(s.id);
      return r && r.status === "present";
    }).length;
    const absent = staffList.filter((s) => {
      const r = attendanceByDate.get(s.id);
      return r && r.status === "absent";
    }).length;
    const halfDay = staffList.filter((s) => {
      const r = attendanceByDate.get(s.id);
      return r && r.status === "half_day";
    }).length;
    const leave = staffList.filter((s) => {
      const r = attendanceByDate.get(s.id);
      return r && r.status === "leave";
    }).length;
    const unmarked = staffList.filter((s) => !attendanceByDate.has(s.id)).length;

    if (attendanceSummary) {
      const parts = [];
      if (present) parts.push(`${present} present`);
      if (absent) parts.push(`${absent} absent`);
      if (halfDay) parts.push(`${halfDay} half-day`);
      if (leave) parts.push(`${leave} on leave`);
      if (unmarked) parts.push(`${unmarked} not marked`);
      attendanceSummary.textContent = parts.length ? `Summary: ${parts.join(", ")}.` : `No attendance recorded for ${date}.`;
    }

    attendanceBody.innerHTML = staffList
      .map((s) => {
        const r = attendanceByDate.get(s.id);
        const id = r?.id ?? "";
        const status = r?.status ?? "present";
        const shift = r?.shift ?? "";
        const note = escapeHtml((r?.note ?? "").toString());
        const name = escapeHtml(s.name);
        const role = s.role_display ? ` (${escapeHtml(s.role_display)})` : "";
        const options = ["present", "absent", "half_day", "leave"]
          .map((st) => `<option value="${st}" ${st === status ? "selected" : ""}>${STATUS_LABELS[st]}</option>`)
          .join("");
        const shiftSelectOptions = shiftOptions
          .map((opt) => `<option value="${escapeHtml(opt.value)}" ${opt.value === shift ? "selected" : ""}>${escapeHtml(opt.label)}</option>`)
          .join("");
        return `
          <tr data-staff-id="${escapeHtml(s.id)}" data-record-id="${escapeHtml(id)}">
            <td>${name}${role}</td>
            <td>
              <select class="att-status" data-staff-id="${escapeHtml(s.id)}" aria-label="Status for ${name}">
                ${options}
              </select>
            </td>
            <td>
              <select class="att-shift" data-staff-id="${escapeHtml(s.id)}" aria-label="Shift for ${name}">
                ${shiftSelectOptions}
              </select>
            </td>
            <td><input type="text" class="att-note" value="${note}" maxlength="200" placeholder="Note" data-staff-id="${escapeHtml(s.id)}" /></td>
            <td><button type="button" class="att-save-row button-secondary" data-staff-id="${escapeHtml(s.id)}" data-record-id="${escapeHtml(id)}">Save</button></td>
          </tr>
        `;
      })
      .join("");

    attendanceBody.querySelectorAll(".att-save-row").forEach((btn) => {
      btn.addEventListener("click", () => saveRow(btn, date));
    });
  }

  async function saveRow(btn, date) {
    const staffId = btn.getAttribute("data-staff-id");
    const recordId = btn.getAttribute("data-record-id");
    const row = attendanceBody?.querySelector(`tr[data-staff-id="${staffId}"]`);
    if (!row) return;

    const statusEl = row.querySelector(".att-status");
    const shiftEl = row.querySelector(".att-shift");
    const noteEl = row.querySelector(".att-note");

    const status = statusEl?.value ?? "present";
    const shift = (shiftEl?.value || "").trim() || null;
    const note = noteEl?.value?.trim() || null;

    const payload = {
      employee_id: staffId,
      date,
      status,
      shift,
      note,
      updated_at: new Date().toISOString(),
    };
    if (auth?.session?.user?.id) payload.created_by = auth.session.user.id;

    let error;
    if (recordId) {
      const { error: updateErr } = await supabaseClient
        .from("employee_attendance")
        .update(payload)
        .eq("id", recordId);
      error = updateErr;
    } else {
      const { error: insertErr } = await supabaseClient.from("employee_attendance").insert(payload);
      error = insertErr;
    }

    if (error) {
      showMessage(AppError.getUserMessage(error), true);
      AppError.report(error, { context: "attendance saveRow" });
      return;
    }
    showMessage("Saved.");
    if (typeof AppCache !== "undefined" && AppCache) {
      AppCache.invalidateByType("recent_activity");
    }
    loadAttendanceForDate(date).then(() => renderAttendanceTable(date));
  }

  async function saveAll(date) {
    if (!staffList.length) return;
    showMessage("");

    let saved = 0;
    let errMsg = "";
    for (const s of staffList) {
      const row = attendanceBody?.querySelector(`tr[data-staff-id="${s.id}"]`);
      if (!row) continue;

      const statusEl = row.querySelector(".att-status");
      const shiftEl = row.querySelector(".att-shift");
      const noteEl = row.querySelector(".att-note");

      const status = statusEl?.value ?? "present";
      const shift = (shiftEl?.value || "").trim() || null;
      const note = noteEl?.value?.trim() || null;

      const payload = {
        employee_id: s.id,
        date,
        status,
        shift,
        note,
        updated_at: new Date().toISOString(),
      };
      if (auth?.session?.user?.id) payload.created_by = auth.session.user.id;

      const existing = attendanceByDate.get(s.id);
      if (existing) {
        const { error } = await supabaseClient.from("employee_attendance").update(payload).eq("id", existing.id);
        if (error) errMsg = AppError.getUserMessage(error);
        else saved++;
      } else {
        const { error } = await supabaseClient.from("employee_attendance").insert(payload);
        if (error) errMsg = AppError.getUserMessage(error);
        else saved++;
      }
    }

    if (errMsg) {
      showMessage(errMsg, true);
      return;
    }
    showMessage(saved ? `Saved ${saved} record(s).` : "No changes to save.");
    if (typeof AppCache !== "undefined" && AppCache) {
      AppCache.invalidateByType("recent_activity");
    }
    loadAttendanceForDate(date).then(() => renderAttendanceTable(date));
  }

  async function loadHistoryMonth(monthValue) {
    if (!historyBody) return;
    if (!monthValue) {
      historyBody.innerHTML = '<tr><td colspan="5" class="muted">Select a month.</td></tr>';
      return;
    }

    const [year, month] = monthValue.split("-").map(Number);
    const { start, end } = getMonthStartEnd(year, month);

    const { data, error } = await supabaseClient
      .from("employee_attendance")
      .select("id, employee_id, date, status, shift, note")
      .gte("date", start)
      .lte("date", end)
      .order("date", { ascending: false });

    if (error) {
      historyBody.innerHTML = `<tr><td colspan="5" class="error">${escapeHtml(AppError.getUserMessage(error))}</td></tr>`;
      AppError.report(error, { context: "loadHistoryMonth" });
      return;
    }

    const list = data ?? [];
    const staffById = new Map(staffList.map((s) => [s.id, s]));

    if (!list.length) {
      historyBody.innerHTML = '<tr><td colspan="5" class="muted">No attendance records for this month.</td></tr>';
      return;
    }

    historyBody.innerHTML = list
      .map((r) => {
        const staff = staffById.get(r.employee_id);
        const name = staff ? escapeHtml(staff.name) : "—";
        const shiftLabel = escapeHtml(getShiftLabel(r.shift));
        return `
          <tr>
            <td>${escapeHtml(r.date)}</td>
            <td>${name}</td>
            <td>${STATUS_LABELS[r.status] ?? r.status}</td>
            <td>${shiftLabel}</td>
            <td>${escapeHtml((r.note ?? "").toString())}</td>
          </tr>
        `;
      })
      .join("");
  }

  function downloadHistoryCsv(monthValue) {
    if (!monthValue) return;
    const [year, month] = monthValue.split("-").map(Number);
    const { start, end } = getMonthStartEnd(year, month);

    supabaseClient
      .from("employee_attendance")
      .select("employee_id, date, status, shift, note")
      .gte("date", start)
      .lte("date", end)
      .order("date", { ascending: false })
      .then(({ data, error }) => {
        if (error) {
          showMessage(AppError.getUserMessage(error), true);
          return;
        }
        const list = data ?? [];
        const staffById = new Map(staffList.map((s) => [s.id, s]));
        const headers = ["Date", "Staff", "Status", "Shift", "Note"];
        const rows = list.map((r) => {
          const staff = staffById.get(r.employee_id);
          const name = staff ? staff.name : "—";
          return [
            r.date,
            name,
            STATUS_LABELS[r.status] ?? r.status,
            getShiftLabel(r.shift),
            (r.note ?? "").toString().replace(/"/g, '""'),
          ];
        });
        const csv = [headers.join(","), ...rows.map((row) => row.map((c) => `"${c}"`).join(","))].join("\n");
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `attendance_${year}-${String(month).padStart(2, "0")}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
      });
  }

  await loadStaffMembers();
  const initialDate = attendanceDateInput?.value ?? getLocalDateString();
  await loadAttendanceForDate(initialDate);
  renderAttendanceTable(initialDate);

  attendanceDateInput?.addEventListener("change", async () => {
    const date = attendanceDateInput.value;
    if (!date) return;
    await loadAttendanceForDate(date);
    renderAttendanceTable(date);
  });

  saveAllBtn?.addEventListener("click", () => {
    const date = attendanceDateInput?.value;
    if (date) saveAll(date);
  });

  historyMonthInput?.addEventListener("change", () => {
    loadHistoryMonth(historyMonthInput.value);
  });

  historyDownloadBtn?.addEventListener("click", () => {
    downloadHistoryCsv(historyMonthInput?.value);
  });

  loadHistoryMonth(historyMonthInput?.value ?? "");
});
