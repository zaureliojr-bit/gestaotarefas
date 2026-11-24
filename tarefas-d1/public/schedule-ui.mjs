import { monthDays, weekday, dailyMinutes, hoursLabel, shiftEnd, defaultShift, generatePlan, analyzePlan, validMonth, normalizeShiftTime } from "./schedule.mjs";
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
  let expandedCoverageShift = null;
  const error = message => { $("scheduleError").textContent = message; $("scheduleError").hidden = !message; };
  const status = () => { $("scheduleStatus").textContent = !plan ? "" : dirty ? "Alterações pendentes" : plan.status === "published" ? "Publicada" : "Rascunho"; };
  const markDirty = () => { dirty = true; plan.status = "draft"; status(); };
  const shiftOptions = selected => plan.shifts.map(s => option(s.id, `${s.name} · ${s.start}–${shiftEnd(s)}`, s.id === selected)).join("");
  const jobs = () => [...new Set([...context.people.map(p => p.jobTitle), ...plan.rows.map(p => p.jobTitle)].filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
  const jobKey = value => value.trim().toLocaleLowerCase("pt-BR");
  const assignedCount = (shiftId, job) => plan.rows.filter(r => r.shiftId === shiftId && jobKey(r.jobTitle) === jobKey(job)).length;
  function renderRulePeople(shift, rule) {
    const matching = plan.rows.filter(r => jobKey(r.jobTitle) === jobKey(rule.jobTitle));
    const assigned = matching.filter(r => r.shiftId === shift.id);
    const available = matching.filter(r => r.shiftId !== shift.id);
    return `<div class="schedule-rule-people"><strong>Funcionários neste turno (${assigned.length})</strong><div class="schedule-assigned-list">${assigned.map(r => `<span class="schedule-person-chip">${esc(r.name)}</span>`).join("") || '<small>Nenhum funcionário atribuído.</small>'}</div>${available.length ? `<label>Mover funcionário para ${esc(shift.name)}<select data-assign-person="${shift.id}" data-assignment-rule="${rule.index}">${option("", "Selecionar funcionário")}${available.map(r => option(r.personId, `${r.name} · ${plan.shifts.find(s => s.id === r.shiftId)?.name ?? "Sem turno"}`)).join("")}</select></label>` : '<small>Todos os funcionários disponíveis deste cargo já estão no turno.</small>'}</div>`;
  }
  function availableJobs(shiftId, currentIndex = -1) {
    const current = plan.coverage[currentIndex]?.jobTitle;
    const used = new Set(plan.coverage.filter((r, i) => r.shiftId === shiftId && i !== currentIndex).map(r => jobKey(r.jobTitle)));
    const unique = new Map(jobs().map(j => [jobKey(j), j]));
    if (current) unique.set(jobKey(current), current);
    return [...unique.values()].filter(j => j === current || !used.has(jobKey(j)))
      .sort((a, b) => assignedCount(shiftId, b) - assignedCount(shiftId, a) || a.localeCompare(b, "pt-BR"));
  }
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
    const rows = context.people.filter(p => p.employmentStatus === "Ativo").map(p => ({ personId: p.id, name: p.name, jobTitle: p.jobTitle, shiftId: preferredShift(p, shifts, template?.rows.find(r => r.personId === p.id)?.shiftId), days: days.map(() => "T") }));
    return { unitId, month, shifts, rows, coverage: structuredClone(template?.coverage ?? []), holidays: days.filter(d => fixedHolidays.includes(d.slice(5))), restPattern: template?.restPattern ?? "separate", status: "draft" };
  }
  function preferredShift(person, shifts, fallback) {
    const id = person.preferredShiftId;
    if (!id) return fallback ?? shifts[0].id;
    if (!shifts.some(s => s.id === id)) shifts.push({ ...defaultShift(), id, name: `Turno ${id}` });
    shifts.sort((a, b) => a.id - b.id);
    return id;
  }
  async function load() {
    const unit = $("scheduleUnit").value;
    const month = $("scheduleMonth").value;
    const version = ++requestVersion;
    $("scheduleEditor").hidden = true;
    plan = undefined;
    context = undefined;
    expandedCoverageShift = null;
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
    $("scheduleRestPattern").value = plan.restPattern ?? "free";
    const days = monthDays(plan.month);
    $("scheduleHeading").textContent = `${getData().units.find(u => u.id === plan.unitId)?.name ?? plan.unitId} · ${plan.month.slice(5)}/${plan.month.slice(0, 4)}`;
    $("scheduleShiftSummary").textContent = plan.shifts.map(s => `${s.name}: ${s.start}–${shiftEnd(s)} · intervalo ${s.breakMinutes} min`).join(" | ");
    $("scheduleHours").textContent = `${hoursLabel(dailyMinutes())} de trabalho por dia · ${hoursLabel(dailyMinutes() * 5)} por semana · pausa adicionada ao horário de saída.`;
    $("scheduleShifts").innerHTML = plan.shifts.map(s => `<div class="schedule-shift" data-shift="${s.id}"><label>Nome<input data-field="name" value="${esc(s.name)}" maxlength="60"></label><label>Entrada (24h)<input class="schedule-time-input" type="text" inputmode="numeric" autocomplete="off" data-field="start" maxlength="5" placeholder="HH:MM" value="${esc(s.start)}"></label><label>Saída <output class="schedule-time-output">${shiftEnd(s)}${shiftEnd(s) < s.start ? '<span>Dia seguinte</span>' : ''}</output></label><label>Intervalo (min)<input type="number" data-field="breakMinutes" min="30" max="120" value="${s.breakMinutes}"></label><label>Mínimo<input type="number" data-field="minimum" min="0" max="100" value="${s.minimum}"></label><button class="small-btn" type="button" data-delete-shift="${s.id}"${plan.shifts.length === 1 || plan.rows.some(r => r.shiftId === s.id) ? " disabled" : ""}>Excluir</button></div>`).join("");
    $("scheduleCoverageRules").innerHTML = plan.shifts.map(shift => {
      const rules = plan.coverage.map((c, i) => ({ ...c, index: i })).filter(c => c.shiftId === shift.id);
      const count = plan.rows.filter(r => r.shiftId === shift.id).length;
      const expanded = expandedCoverageShift === shift.id;
      return `<section class="schedule-coverage-group"><div class="schedule-coverage-heading"><button class="schedule-coverage-toggle" type="button" data-toggle-coverage="${shift.id}" aria-expanded="${expanded}" aria-controls="coverage-shift-${shift.id}"><span aria-hidden="true">${expanded ? "▾" : "▸"}</span><div><strong>${esc(shift.name)}</strong><small>${esc(shift.start)}–${esc(shiftEnd(shift))} · ${count} funcionário(s) · ${rules.length} cargo(s)</small></div></button><button class="btn btn-light" type="button" data-add-coverage="${shift.id}"${!availableJobs(shift.id).length || plan.coverage.length >= 40 ? " disabled" : ""}>＋ Cargo</button></div><div id="coverage-shift-${shift.id}"${expanded ? "" : " hidden"}>${rules.map(c => `<div class="schedule-rule" data-rule="${c.index}"><label>Cargo<select data-rule-field="jobTitle">${availableJobs(shift.id, c.index).map(j => option(j, `${j} (${assignedCount(shift.id, j)})`, c.jobTitle === j)).join("")}</select></label><label>Mínimo<input type="number" data-rule-field="minimum" min="1" max="100" value="${c.minimum}"></label><button type="button" class="small-btn" data-delete-rule="${c.index}">Excluir</button>${renderRulePeople(shift, c)}</div>`).join("") || '<p class="task-meta">Nenhuma exigência por cargo.</p>'}</div></section>`;
    }).join("");
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
  $("scheduleAddShift").onclick = () => { if (plan.shifts.length >= 12) return; const id = Math.max(...plan.shifts.map(s => s.id)) + 1; plan.shifts.push({ ...defaultShift(), id, name: `Turno ${id}` }); expandedCoverageShift = null; markDirty(); render(); };
  $("scheduleShifts").onchange = e => {
    const input = e.target;
    if (!input.dataset.field) return;
    const shift = plan.shifts.find(s => s.id === Number(input.closest("[data-shift]").dataset.shift));
    if (input.dataset.field === "start") {
      const value = normalizeShiftTime(input.value);
      if (!value) { input.value = shift.start; return error("Digite um horário válido no formato HH:MM (00:00 a 23:59)."); }
      shift.start = value; error(""); markDirty(); render(); return;
    }
    if (!input.checkValidity() || !input.value.trim()) return render();
    shift[input.dataset.field] = input.type === "number" ? Number(input.value) : input.value.trim(); markDirty(); render();
  };
  $("scheduleShifts").onclick = e => { const id = Number(e.target.dataset.deleteShift); if (!id || plan.rows.some(r => r.shiftId === id) || plan.shifts.length === 1) return; plan.shifts = plan.shifts.filter(s => s.id !== id); plan.coverage = plan.coverage.filter(c => c.shiftId !== id); markDirty(); render(); };
  $("scheduleCoverageRules").onchange = e => {
    const input = e.target;
    if (input.dataset.assignPerson) {
      const shiftId = Number(input.dataset.assignPerson);
      const rule = plan.coverage[Number(input.dataset.assignmentRule)];
      const person = plan.rows.find(r => r.personId === Number(input.value));
      if (!person || rule?.shiftId !== shiftId || jobKey(person.jobTitle) !== jobKey(rule.jobTitle)) return;
      person.shiftId = shiftId;
    } else {
      if (!input.dataset.ruleField || !input.checkValidity()) return render();
      const rule = plan.coverage[Number(input.closest("[data-rule]").dataset.rule)];
      rule[input.dataset.ruleField] = input.dataset.ruleField === "jobTitle" ? input.value : Number(input.value);
    }
    markDirty(); render();
  };
  $("scheduleCoverageRules").onclick = e => {
    const toggle = e.target.closest("[data-toggle-coverage]");
    if (toggle) {
      const id = Number(toggle.dataset.toggleCoverage);
      expandedCoverageShift = expandedCoverageShift === id ? null : id;
      render();
      return;
    }
    const shiftId = Number(e.target.dataset.addCoverage);
    if (shiftId) {
      const job = availableJobs(shiftId)[0];
      if (!job || plan.coverage.length >= 40) return;
      plan.coverage.push({ shiftId, jobTitle: job, minimum: 1 });
      expandedCoverageShift = shiftId;
    } else if (e.target.dataset.deleteRule !== undefined) plan.coverage.splice(Number(e.target.dataset.deleteRule), 1);
    else return;
    markDirty(); render();
  };
  $("scheduleTable").onchange = e => { const input = e.target; if (input.dataset.personShift) plan.rows.find(r => r.personId === Number(input.dataset.personShift)).shiftId = Number(input.value); else if (input.dataset.person) plan.rows.find(r => r.personId === Number(input.dataset.person)).days[Number(input.dataset.day)] = input.value; else return; markDirty(); render(); };
  $("scheduleAddHoliday").onclick = () => { const day = $("scheduleHoliday").value; if (!monthDays(plan.month).includes(day) || plan.holidays.includes(day)) return; plan.holidays.push(day); plan.holidays.sort(); markDirty(); render(); };
  $("scheduleHolidays").onclick = e => { const day = e.target.dataset.removeHoliday; if (!day) return; plan.holidays = plan.holidays.filter(d => d !== day); markDirty(); render(); };
  $("scheduleGenerate").onclick = () => { plan = generatePlan(plan, context.plans); markDirty(); render(); };
  $("scheduleRestPattern").onchange = () => { plan.restPattern = $("scheduleRestPattern").value; markDirty(); render(); };
  $("scheduleRoster").onclick = async () => {
    if (!window.confirm("Atualizar funcionários ativos e aplicar os turnos padrão do cadastro? Os dias dos funcionários mantidos serão preservados.")) return;
    try {
      const version = requestVersion;
      const fresh = await api(endpoint());
      if (version !== requestVersion) return;
      if (JSON.stringify(fresh.plans) !== JSON.stringify(context.plans)) return error("As escalas foram alteradas em outra sessão. Recarregue antes de atualizar a equipe.");
      context = fresh;
    } catch (e) { return error(e.message); }
    const existing = new Map(plan.rows.map(r => [r.personId, r]));
    plan.rows = context.people.filter(p => p.employmentStatus === "Ativo").map(p => {
      const row = existing.get(p.id);
      const shiftId = preferredShift(p, plan.shifts, row?.shiftId);
      return row ? { ...row, name: p.name, jobTitle: p.jobTitle, shiftId } : { personId: p.id, name: p.name, jobTitle: p.jobTitle, shiftId, days: monthDays(plan.month).map(() => "F") };
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
    const rows = [["Funcionário", "Cargo", "Turno", "Entrada", "Intervalo (min)", "Saída", ...days], ...plan.rows.map(r => { const shift = plan.shifts.find(s => s.id === r.shiftId); return [r.name, r.jobTitle, shift.name, shift.start, shift.breakMinutes, shiftEnd(shift), ...r.days.map(s => stateNames[s])]; })];
    const url = URL.createObjectURL(new Blob(["\ufeff", rows.map(r => r.map(quote).join(";")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = `escala-${plan.unitId}-${plan.month}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return {
    open() { if (!allowed()) return; setupUnitOptions(); if (!$("scheduleMonth").value) $("scheduleMonth").value = localDay().slice(0, 7) < "2026-12" ? "2026-12" : localDay().slice(0, 7); if (!plan || plan.unitId !== $("scheduleUnit").value) load(); },
    accountChanged() { const viewer = getViewer(); const identity = `${viewer?.email}|${viewer?.role}|${viewer?.unitId}`; if (account !== identity) { account = identity; requestVersion++; plan = context = undefined; dirty = false; $("scheduleEditor").hidden = true; } },
  };
}
