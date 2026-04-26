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

/** Single-letter codes in the month matrix */
const STATUS_SHORT = {
  present: "P",
  absent: "A",
  half_day: "H",
  leave: "L",
};

const WEEKDAY_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function monthDayMetas(year, month) {
  const last = new Date(year, month, 0).getDate();
  const out = [];
  const p2 = (n) => String(n).padStart(2, "0");
  const ym = `${year}-${p2(month)}-`;
  let weekday = new Date(year, month - 1, 1).getDay();
  for (let d = 1; d <= last; d++) {
    out.push({ day: d, dateStr: `${ym}${p2(d)}`, weekday });
    weekday = (weekday + 1) % 7;
  }
  return out;
}

const MATRIX_STATUS_CLASS = {
  present: "att-cell att-cell-present",
  absent: "att-cell att-cell-absent",
  half_day: "att-cell att-cell-half",
  leave: "att-cell att-cell-leave",
};

function matrixCellClass(status) {
  return MATRIX_STATUS_CLASS[status] ?? "att-cell att-cell-empty";
}

function matrixCellLetter(record) {
  if (!record) return "—";
  return STATUS_SHORT[record.status] ?? "—";
}

function matrixCellTitle(record) {
  if (!record) return "Not marked";
  const parts = [STATUS_LABELS[record.status] ?? record.status];
  const sh = getShiftLabel(record.shift);
  if (sh && sh !== "—") parts.push(sh);
  const n = (record.note ?? "").toString().trim();
  if (n) parts.push(n);
  return parts.join(" · ");
}

/** Tooltip line; avoids repeated localStorage reads when building the month grid */
function matrixCellTitleWithCfg(record, morningName, afternoonName) {
  if (!record) return "Not marked";
  const parts = [STATUS_LABELS[record.status] ?? record.status];
  let sh = "—";
  if (record.shift === "morning") sh = morningName;
  else if (record.shift === "afternoon") sh = afternoonName;
  else if (record.shift) sh = record.shift;
  if (sh && sh !== "—") parts.push(sh);
  const n = (record.note ?? "").toString().trim();
  if (n) parts.push(n);
  return parts.join(" · ");
}

/** Small sub-line under P/A/H/L; does not change cell background (shift is secondary to status). */
function matrixShiftAbbrev(shiftValue) {
  if (shiftValue === "morning") return "Mo";
  if (shiftValue === "afternoon") return "Af";
  return "";
}

function matrixCellContents(record) {
  const letter = matrixCellLetter(record);
  const main = escapeHtml(letter);
  const shiftAbbr = record && letter !== "—" ? matrixShiftAbbrev(record.shift) : "";
  const parts = [`<span class="att-cell-main">${main}</span>`];
  if (shiftAbbr) parts.push(`<span class="att-cell-shift">${escapeHtml(shiftAbbr)}</span>`);
  return `<div class="att-cell-stack">${parts.join("")}</div>`;
}

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
  const historyMatrixWrap = document.getElementById("attendance-matrix-wrap");
  const historyMatrixSummary = document.getElementById("attendance-matrix-summary");
  const historyRefreshBtn = document.getElementById("history-refresh");
  const historyDownloadBtn = document.getElementById("history-download-csv");

  function syncMarkRowClass(row) {
    if (!row) return;
    row.classList.remove("att-row-absent", "att-row-half", "att-row-leave");
    const st = row.querySelector(".att-status")?.value ?? "present";
    if (st === "absent") row.classList.add("att-row-absent");
    else if (st === "half_day") row.classList.add("att-row-half");
    else if (st === "leave") row.classList.add("att-row-leave");
  }

  attendanceBody?.addEventListener("change", (e) => {
    const t = e.target;
    if (t && t.classList && t.classList.contains("att-status")) {
      syncMarkRowClass(t.closest("tr"));
    }
  });

  attendanceBody?.addEventListener("click", (e) => {
    const btn = e.target.closest?.(".att-save-row");
    if (!btn || !attendanceBody.contains(btn)) return;
    const date = attendanceDateInput?.value;
    if (date) saveRow(btn, date);
  });

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
        '<tr><td colspan="5" class="muted">Add staff in <a href="settings.html#manage-staff-section">Settings → Manage staff (HR)</a> first (admin).</td></tr>';
      if (attendanceSummary) attendanceSummary.textContent = "";
      return;
    }

    const shiftConfig = getShiftConfig();
    const shiftOptions = [
      { value: "", label: "—" },
      { value: "morning", label: shiftConfig.morningName },
      { value: "afternoon", label: shiftConfig.afternoonName },
    ];

    let present = 0;
    let absent = 0;
    let halfDay = 0;
    let leave = 0;
    let unmarked = 0;
    for (const s of staffList) {
      const r = attendanceByDate.get(s.id);
      if (!r) {
        unmarked++;
        continue;
      }
      if (r.status === "present") present++;
      else if (r.status === "absent") absent++;
      else if (r.status === "half_day") halfDay++;
      else if (r.status === "leave") leave++;
      else unmarked++;
    }

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

    attendanceBody.querySelectorAll("tr[data-staff-id]").forEach(syncMarkRowClass);
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
    if (!historyMatrixWrap) return;

    if (!monthValue) {
      if (historyMatrixSummary) historyMatrixSummary.textContent = "";
      historyMatrixWrap.innerHTML = '<p class="muted att-matrix-placeholder">Select a month.</p>';
      return;
    }

    const [year, month] = monthValue.split("-").map(Number);
    const { start, end } = getMonthStartEnd(year, month);

    const { data, error } = await supabaseClient
      .from("employee_attendance")
      .select("employee_id, date, status, shift, note")
      .gte("date", start)
      .lte("date", end)
      .order("date", { ascending: true });

    if (error) {
      if (historyMatrixSummary) historyMatrixSummary.textContent = "";
      historyMatrixWrap.innerHTML = `<p class="error att-matrix-placeholder">${escapeHtml(AppError.getUserMessage(error))}</p>`;
      AppError.report(error, { context: "loadHistoryMonth" });
      return;
    }

    if (!staffList.length) {
      if (historyMatrixSummary) historyMatrixSummary.textContent = "";
      historyMatrixWrap.innerHTML =
        '<p class="muted att-matrix-placeholder">Add staff in <a href="settings.html#manage-staff-section">Settings → Manage staff (HR)</a> first (admin).</p>';
      return;
    }

    const list = data ?? [];
    const recordMap = new Map();
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      recordMap.set(`${r.employee_id}|${r.date}`, r);
    }

    const dayMetas = monthDayMetas(year, month);
    const totalCells = staffList.length * dayMetas.length;
    let nPresent = 0;
    let nAbsent = 0;
    let nHalf = 0;
    let nLeave = 0;
    for (const r of recordMap.values()) {
      const st = r.status;
      if (st === "present") nPresent++;
      else if (st === "absent") nAbsent++;
      else if (st === "half_day") nHalf++;
      else if (st === "leave") nLeave++;
    }
    const nUnmarked = Math.max(0, totalCells - recordMap.size);

    const monthLabel = new Date(year, month - 1, 1).toLocaleString("en-IN", { month: "long", year: "numeric" });
    if (historyMatrixSummary) {
      historyMatrixSummary.textContent = `${monthLabel} · ${staffList.length} staff × ${dayMetas.length} days — Present ${nPresent}, absent ${nAbsent}, half-day ${nHalf}, leave ${nLeave}, not marked ${nUnmarked}.`;
    }

    const shiftCfg = getShiftConfig();
    const morningName = shiftCfg.morningName;
    const afternoonName = shiftCfg.afternoonName;

    const headerParts = new Array(dayMetas.length);
    for (let i = 0; i < dayMetas.length; i++) {
      const dm = dayMetas[i];
      const wk = dm.weekday === 0 || dm.weekday === 6 ? " att-matrix-weekend" : "";
      headerParts[i] = `<th scope="col" class="att-matrix-day${wk}" title="${escapeHtml(dm.dateStr)}"><span class="att-matrix-daynum">${dm.day}</span><span class="att-matrix-wd">${WEEKDAY_SHORT[dm.weekday]}</span></th>`;
    }
    const headerDays = headerParts.join("");

    const bodyParts = new Array(staffList.length);
    for (let si = 0; si < staffList.length; si++) {
      const s = staffList[si];
      const name = escapeHtml(s.name);
      const role = s.role_display
        ? ` <span class="muted att-matrix-role">(${escapeHtml(s.role_display)})</span>`
        : "";
      const idPrefix = `${s.id}|`;
      const cellParts = new Array(dayMetas.length);
      for (let di = 0; di < dayMetas.length; di++) {
        const dm = dayMetas[di];
        const r = recordMap.get(idPrefix + dm.dateStr);
        const cls = matrixCellClass(r?.status);
        const title = matrixCellTitleWithCfg(r, morningName, afternoonName);
        const inner = matrixCellContents(r);
        cellParts[di] = `<td class="${cls}" title="${escapeHtml(title)}">${inner}</td>`;
      }
      bodyParts[si] = `<tr><th scope="row" class="att-matrix-staff-col">${name}${role}</th>${cellParts.join("")}</tr>`;
    }
    const bodyRows = bodyParts.join("");

    historyMatrixWrap.innerHTML = `<table class="attendance-matrix"><thead><tr><th scope="col" class="att-matrix-staff-col">Staff</th>${headerDays}</tr></thead><tbody>${bodyRows}</tbody></table>`;
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
        const cfg = getShiftConfig();
        const shiftLabelCsv = (shift) => {
          if (!shift) return "—";
          if (shift === "morning") return cfg.morningName;
          if (shift === "afternoon") return cfg.afternoonName;
          return shift;
        };
        const headers = ["Date", "Staff", "Status", "Shift", "Note"];
        const rows = list.map((r) => {
          const staff = staffById.get(r.employee_id);
          const name = staff ? staff.name : "—";
          return [
            r.date,
            name,
            STATUS_LABELS[r.status] ?? r.status,
            shiftLabelCsv(r.shift),
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

  async function refreshHistoryMonth() {
    const monthValue = historyMonthInput?.value ?? "";
    if (historyRefreshBtn) {
      historyRefreshBtn.disabled = true;
      historyRefreshBtn.setAttribute("aria-busy", "true");
    }
    try {
      await loadStaffMembers();
      await loadHistoryMonth(monthValue);
    } finally {
      if (historyRefreshBtn) {
        historyRefreshBtn.disabled = false;
        historyRefreshBtn.removeAttribute("aria-busy");
      }
    }
  }

  historyRefreshBtn?.addEventListener("click", () => {
    refreshHistoryMonth();
  });

  historyDownloadBtn?.addEventListener("click", () => {
    downloadHistoryCsv(historyMonthInput?.value);
  });

  loadHistoryMonth(historyMonthInput?.value ?? "");
});
