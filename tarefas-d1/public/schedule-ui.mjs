import { monthDays, weekday, dailyMinutes, hoursLabel, shiftEnd, defaultShift, generatePlan, analyzePlan, validMonth } from "./schedule.mjs";
import { localDay } from "./model.mjs";

const $ = id => document.getElementById(id);
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const weekNames = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
const stateNames = { T: "Trabalho", F: "Folga", V: "Férias", A: "Afastamento" };
const fixedHolidays = ["01-01", "04-21", "05-01", "09-07", "10-12", "11-02", "11-15", "11-20", "12-25"];
const option = (value, label, selected = false) => `<option value="${esc(value)}"${selected ? " selected" : ""}>${esc(label)}</option>`;

export function setupSchedules({ api, notify, getData, getViewer, sync }) {
  let plan;
  let context;
  let requestVersion = 0;
  let busy = false;
  let dirty = false;
  let account;
  const error = message => { $("scheduleError").textContent = message; $("scheduleError").hidden = !message; };
  const status = () => { $("scheduleStatus").textContent = !plan ? "" : dirty ? "Alterações pendentes" : plan.status === "published" ? "Publicada" : "Rascunho"; };
  const markDirty = () => { dirty = true; plan.status = "draft"; status(); };
  const shiftOptions = selected => plan.shifts.map(s => option(s.id, s.name, s.id === selected)).join("");
  const jobs = () => [...new Set([...context.people.map(p => p.jobTitle), ...plan.rows.map(p => p.jobTitle)].filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
  const endpoint = () => `schedules?unit=${encodeURIComponent($("scheduleUnit").value)}`;
  const allowed = () => ["office", "network_manager", "manager"].includes(getViewer()?.role);
  function setupUnitOptions() {
    const viewer = getViewer();
    const units = getData()?.units.filter(u => u.store) ?? [];
    const selected = $("scheduleUnit").value;
    $("scheduleUnit").innerHTML = units.map(u => option(u.id, u.name, u.id === selected)).join("");
    if (!selected && units.some(u => u.id === viewer?.unitId)) $("scheduleUnit").value = viewer.unitId;
    $("scheduleUnit").disabled = units.length <= 1;
  }
  function newPlan(month, unitId) {
    const template = context.plans.filter(p => p.month < month).sort((a, b) => b.month.localeCompare(a.month))[0];
    const shifts = structuredClone(template?.shifts ?? [defaultShift()]);
    const days = monthDays(month);
    const rows = context.people.filter(p => p.employmentStatus === "Ativo").map(p => ({ personId: p.id, name: p.name, jobTitle: p.jobTitle, shiftId: template?.rows.find(r => r.personId === p.id)?.shiftId ?? shifts[0].id, days: days.map(() => "T") }));
    return { unitId, month, shifts, rows, coverage: structuredClone(template?.coverage ?? []), holidays: days.filter(d => fixedHolidays.includes(d.slice(5))), status: "draft" };
  }
  async function load() {
    const unit = $("scheduleUnit").value;
    const month = $("scheduleMonth").value;
    const version = ++requestVersion;
    $("scheduleEditor").hidden = true;
    plan = undefined;
    context = undefined;
    dirty = false;
    status();
    error("");
    if (!unit || !validMonth(month) || month < "2026-12") return error("Selecione a filial e um mês a partir de dezembro de 2026.");
    try {
      const result = await api(endpoint());
      if (version !== requestVersion || !allowed()) return;
      context = result;
      const stored = result.plans.find(p => p.month === month);
      plan = structuredClone(stored ?? newPlan(month, unit));
      if (!stored && plan.rows.length) plan = generatePlan(plan, context.plans);
      $("scheduleEditor").hidden = false;
      render();
    } catch (e) { if (version === requestVersion) error(e.message); }
  }
  function render() {
    if (!plan) return;
    const days = monthDays(plan.month);
    const mixed = dailyMinutes(days[0]) !== dailyMinutes(days.at(-1));
    $("scheduleHeading").textContent = `${getData().units.find(u => u.id === plan.unitId)?.name ?? plan.unitId} · ${plan.month.slice(5)}/${plan.month.slice(0, 4)}`;
    $("scheduleShiftSummary").textContent = plan.shifts.map(s => `${s.name}: ${s.start}–${shiftEnd(s, days[0])}${mixed ? ` (após 15/12: ${shiftEnd(s, days.at(-1))})` : ""} · intervalo ${s.breakMinutes} min`).join(" | ");
    $("scheduleHours").textContent = mixed ? "Transição: 8h24 até 15/12 e 8h a partir de 16/12. Confira a semana de mudança." : `${hoursLabel(dailyMinutes(days[0]))} de trabalho por dia · ${hoursLabel(dailyMinutes(days[0]) * 5)} por semana · pausa adicionada ao horário de saída.`;
    $("scheduleShifts").innerHTML = plan.shifts.map(s => `<div class="schedule-shift" data-shift="${s.id}"><label>Nome<input data-field="name" value="${esc(s.name)}" maxlength="60"></label><label>Entrada<input type="time" data-field="start" value="${esc(s.start)}"></label><label>Intervalo (min)<input type="number" data-field="breakMinutes" min="30" max="120" value="${s.breakMinutes}"></label><label>Mínimo<input type="number" data-field="minimum" min="0" max="100" value="${s.minimum}"></label><button class="small-btn" type="button" data-delete-shift="${s.id}"${plan.shifts.length === 1 || plan.rows.some(r => r.shiftId === s.id) ? " disabled" : ""}>Excluir</button><small>Saída ${shiftEnd(s, days[0])}${mixed ? ` / ${shiftEnd(s, days.at(-1))}` : ""}</small></div>`).join("");
    $("scheduleCoverageRules").innerHTML = plan.coverage.map((c, i) => `<div class="schedule-rule" data-rule="${i}"><label>Turno<select data-rule-field="shiftId">${shiftOptions(c.shiftId)}</select></label><label>Cargo<select data-rule-field="jobTitle">${jobs().map(j => option(j, j, c.jobTitle === j)).join("")}</select></label><label>Mínimo<input type="number" data-rule-field="minimum" min="1" max="100" value="${c.minimum}"></label><button type="button" class="small-btn" data-delete-rule="${i}">Excluir</button></div>`).join("") || '<p class="task-meta">Adicione exigências por cargo quando necessário.</p>';
    $("scheduleAddCoverage").disabled = !jobs().length;
    $("scheduleHoliday").min = days[0]; $("scheduleHoliday").max = days.at(-1);
    $("scheduleHolidays").innerHTML = plan.holidays.map(d => `<button type="button" class="small-btn" data-remove-holiday="${d}">${d.slice(-2)} ×</button>`).join(" ");
    const report = analyzePlan(plan, context.plans);
    const head = days.map(d => `<th class="${weekday(d) === 6 || plan.holidays.includes(d) ? "schedule-holiday" : ""}" title="${d}${plan.holidays.includes(d) ? ' — Feriado' : ''}">${d.slice(-2)}<small>${weekNames[weekday(d)]}</small></th>`).join("");
    const rows = plan.rows.map(row => `<tr><th scope="row"><strong>${esc(row.name)}</strong><small>${esc(row.jobTitle || "Sem cargo")}</small><select aria-label="Turno de ${esc(row.name)}" data-person-shift="${row.personId}">${shiftOptions(row.shiftId)}</select></th>${row.days.map((s, index) => `<td><select class="schedule-day state-${s}" aria-label="${esc(row.name)} ${days[index]}" data-person="${row.personId}" data-day="${index}">${Object.entries(stateNames).map(([v, label]) => option(v, v, s === v)).join("")}</select></td>`).join("")}<td>${row.days.filter(s => s === "T").length}</td><td>${row.days.filter(s => s === "F").length}</td></tr>`).join("");
    const totals = plan.shifts.map((shift, i) => `<tr class="schedule-total"><th>${esc(shift.name)} · cobertura</th>${days.map((_, j) => `<td class="${report.coverage[j][i] < shift.minimum ? 'schedule-short' : ''}">${report.coverage[j][i]}</td>`).join("")}<td colspan="2"></td></tr>`).join("");
    $("scheduleTable").innerHTML = plan.rows.length ? `<table class="schedule-grid"><thead><tr><th>Funcionário / turno</th>${head}<th>Trab.</th><th>Folga</th></tr></thead><tbody>${rows}${totals}</tbody></table>` : '<p class="empty">Nenhum funcionário ativo nesta filial.</p>';
    $("scheduleValidationCount").textContent = `${report.issues.length} conflitos · ${report.warnings.length} avisos`;
    const findings = [...report.issues.map(s => `<li class="schedule-issue">${esc(s)}</li>`), ...report.warnings.map(s => `<li>${esc(s)}</li>`)].join("");
    $("scheduleValidation").innerHTML = findings ? `<ul>${findings}</ul>` : '<p class="task-meta">Nenhum conflito nas regras verificadas.</p>';
    $("schedulePublish").disabled = busy || !plan.rows.length || !!report.issues.length;
    $("scheduleSave").disabled = busy;
    $("scheduleGenerate").disabled = busy || !plan.rows.length;
    status();
  }
  function changeSelection() {
    if (dirty && !window.confirm("Descartar alterações não salvas nesta escala?")) {
      $("scheduleUnit").value = plan.unitId; $("scheduleMonth").value = plan.month; return;
    }
    load();
  }
  $("scheduleUnit").onchange = changeSelection;
  $("scheduleMonth").onchange = changeSelection;
  $("scheduleReload").onclick = changeSelection;
  $("scheduleAddShift").onclick = () => { if (plan.shifts.length >= 12) return; const id = Math.max(...plan.shifts.map(s => s.id)) + 1; plan.shifts.push({ ...defaultShift(), id, name: `Turno ${id}` }); markDirty(); render(); };
  $("scheduleShifts").onchange = e => {
    const input = e.target;
    if (!input.dataset.field) return;
    const shift = plan.shifts.find(s => s.id === Number(input.closest("[data-shift]").dataset.shift));
    if (!input.checkValidity() || !input.value.trim()) return render();
    shift[input.dataset.field] = input.type === "number" ? Number(input.value) : input.value.trim(); markDirty(); render();
  };
  $("scheduleShifts").onclick = e => { const id = Number(e.target.dataset.deleteShift); if (!id || plan.rows.some(r => r.shiftId === id) || plan.shifts.length === 1) return; plan.shifts = plan.shifts.filter(s => s.id !== id); plan.coverage = plan.coverage.filter(c => c.shiftId !== id); markDirty(); render(); };
  $("scheduleAddCoverage").onclick = () => { if (!jobs().length || plan.coverage.length >= 40) return; plan.coverage.push({ shiftId: plan.shifts[0].id, jobTitle: jobs()[0], minimum: 1 }); markDirty(); render(); };
  $("scheduleCoverageRules").onchange = e => { const input = e.target; if (!input.dataset.ruleField || !input.checkValidity()) return render(); const rule = plan.coverage[Number(input.closest("[data-rule]").dataset.rule)]; rule[input.dataset.ruleField] = input.dataset.ruleField === "jobTitle" ? input.value : Number(input.value); markDirty(); render(); };
  $("scheduleCoverageRules").onclick = e => { if (e.target.dataset.deleteRule === undefined) return; plan.coverage.splice(Number(e.target.dataset.deleteRule), 1); markDirty(); render(); };
  $("scheduleTable").onchange = e => { const input = e.target; if (input.dataset.personShift) plan.rows.find(r => r.personId === Number(input.dataset.personShift)).shiftId = Number(input.value); else if (input.dataset.person) plan.rows.find(r => r.personId === Number(input.dataset.person)).days[Number(input.dataset.day)] = input.value; else return; markDirty(); render(); };
  $("scheduleAddHoliday").onclick = () => { const day = $("scheduleHoliday").value; if (!monthDays(plan.month).includes(day) || plan.holidays.includes(day)) return; plan.holidays.push(day); plan.holidays.sort(); markDirty(); render(); };
  $("scheduleHolidays").onclick = e => { const day = e.target.dataset.removeHoliday; if (!day) return; plan.holidays = plan.holidays.filter(d => d !== day); markDirty(); render(); };
  $("scheduleGenerate").onclick = () => { plan = generatePlan(plan, context.plans); markDirty(); render(); };
  $("scheduleRoster").onclick = () => {
    if (!window.confirm("Atualizar a lista com os funcionários ativos da filial? Os dias dos funcionários mantidos serão preservados.")) return;
    const existing = new Map(plan.rows.map(r => [r.personId, r]));
    plan.rows = context.people.filter(p => p.employmentStatus === "Ativo").map(p => {
      const row = existing.get(p.id);
      return row ? { ...row, name: p.name, jobTitle: p.jobTitle } : { personId: p.id, name: p.name, jobTitle: p.jobTitle, shiftId: plan.shifts[0].id, days: monthDays(plan.month).map(() => "F") };
    });
    markDirty(); render();
  };
  async function save(publish) {
    if (busy || !plan) return;
    busy = true; error(""); render();
    $("scheduleEditor").inert = true; $("scheduleUnit").disabled = true; $("scheduleMonth").disabled = true; $("scheduleReload").disabled = true;
    const version = requestVersion;
    try {
      const result = await api(endpoint(), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: context.revision, plan: { ...plan, status: publish ? "published" : "draft" } }) });
      if (version !== requestVersion) return;
      context = result; plan = structuredClone(result.plans.find(p => p.month === plan.month)); dirty = false;
      notify(publish ? "Escala publicada." : "Rascunho salvo.");
      sync();
    } catch (e) { if (version === requestVersion) error(e.message); }
    finally { busy = false; $("scheduleEditor").inert = false; $("scheduleMonth").disabled = false; $("scheduleReload").disabled = false; setupUnitOptions(); render(); }
  }
  $("scheduleSave").onclick = () => save(false);
  $("schedulePublish").onclick = () => save(true);
  $("schedulePrint").onclick = () => window.print();
  $("scheduleExport").onclick = () => {
    const quote = value => { const s = String(value); return `"${(/^[=+\-@\t\r]/.test(s) ? "'" + s : s).replaceAll('"', '""')}"`; };
    const days = monthDays(plan.month);
    const mixed = dailyMinutes(days[0]) !== dailyMinutes(days.at(-1));
    const rows = [["Funcionário", "Cargo", "Turno", "Entrada", "Intervalo (min)", "Saída", ...(mixed ? ["Saída a partir de 16/12"] : []), ...days], ...plan.rows.map(r => { const shift = plan.shifts.find(s => s.id === r.shiftId); return [r.name, r.jobTitle, shift.name, shift.start, shift.breakMinutes, shiftEnd(shift, days[0]), ...(mixed ? [shiftEnd(shift, days.at(-1))] : []), ...r.days.map(s => stateNames[s])]; })];
    const url = URL.createObjectURL(new Blob(["\ufeff", rows.map(r => r.map(quote).join(";")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = `escala-${plan.unitId}-${plan.month}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return {
    open() { if (!allowed()) return; setupUnitOptions(); if (!$("scheduleMonth").value) $("scheduleMonth").value = localDay().slice(0, 7) < "2026-12" ? "2026-12" : localDay().slice(0, 7); if (!plan || plan.unitId !== $("scheduleUnit").value) load(); },
    accountChanged() { const viewer = getViewer(); const identity = `${viewer?.email}|${viewer?.role}|${viewer?.unitId}`; if (account !== identity) { account = identity; requestVersion++; plan = context = undefined; dirty = false; $("scheduleEditor").hidden = true; } },
  };
}
