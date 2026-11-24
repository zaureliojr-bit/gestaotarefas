const date = value => new Date(`${value}T12:00:00Z`);
const iso = value => value.toISOString().slice(0, 10);
export const offsetDay = (day, offset) => {
  const value = date(day);
  value.setUTCDate(value.getUTCDate() + offset);
  return iso(value);
};
export const weekday = day => (date(day).getUTCDay() + 6) % 7;
export const validMonth = month => typeof month === "string" && /^20\d\d-(0[1-9]|1[0-2])$/.test(month);
export function monthDays(month) {
  if (!validMonth(month)) throw new Error("Mês inválido.");
  const start = `${month}-01`;
  const days = [];
  for (let day = start; day.startsWith(month); day = offsetDay(day, 1)) days.push(day);
  return days;
}
export const dailyMinutes = () => 444;
export function normalizeShiftTime(value) {
  const input = String(value).trim();
  const match = /^(\d{1,2}):?(\d{2})$/.exec(input);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
export const hoursLabel = minutes => `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
export const shiftEnd = shift => {
  const [hours, minutes] = shift.start.split(":").map(Number);
  const end = (hours * 60 + minutes + shift.breakMinutes + dailyMinutes()) % 1440;
  return `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
};
export const defaultShift = () => ({ id: 1, name: "Turno 1", start: "08:00", breakMinutes: 60, minimum: 1 });
const states = ["T", "F", "V", "A"];
const text = (value, max) => typeof value === "string" && value.trim() && value.length <= max;
export function validatePlan(plan) {
  if (!plan || !validMonth(plan.month) || !text(plan.unitId, 64) || !["draft", "published"].includes(plan.status)) throw new Error("Escala inválida.");
  const days = monthDays(plan.month);
  if (!Array.isArray(plan.shifts) || !plan.shifts.length || plan.shifts.length > 12 || plan.shifts.some(s => !s ||
    !Number.isSafeInteger(s.id) || s.id <= 0 || !text(s.name, 60) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.start) ||
    !Number.isInteger(s.breakMinutes) || s.breakMinutes < 30 || s.breakMinutes > 120 || !Number.isInteger(s.minimum) || s.minimum < 0 || s.minimum > 100) ||
    new Set(plan.shifts.map(s => s.id)).size !== plan.shifts.length) throw new Error("Turnos inválidos.");
  const shiftIds = new Set(plan.shifts.map(s => s.id));
  if (!Array.isArray(plan.rows) || plan.rows.length > 300 || plan.rows.some(r => !r || !Number.isSafeInteger(r.personId) || r.personId <= 0 ||
    !text(r.name, 150) || typeof r.jobTitle !== "string" || r.jobTitle.length > 100 || !shiftIds.has(r.shiftId) ||
    !Array.isArray(r.days) || r.days.length !== days.length || r.days.some(s => !states.includes(s))) ||
    new Set(plan.rows.map(r => r.personId)).size !== plan.rows.length) throw new Error("Funcionários ou dias da escala inválidos.");
  if (!Array.isArray(plan.holidays) || new Set(plan.holidays).size !== plan.holidays.length || plan.holidays.some(day => !days.includes(day))) throw new Error("Feriados inválidos.");
  if (!Array.isArray(plan.coverage) || plan.coverage.length > 40 || plan.coverage.some(c => !c || !shiftIds.has(c.shiftId) || !text(c.jobTitle, 100) || !Number.isInteger(c.minimum) || c.minimum < 1 || c.minimum > 100)) throw new Error("Cobertura por cargo inválida.");
  return plan;
}

function dayState(plan, personId, day, neighbors) {
  const source = day.startsWith(plan.month) ? plan : neighbors.find(p => p.unitId === plan.unitId && day.startsWith(p.month));
  const row = source?.rows.find(r => r.personId === personId);
  return row?.days[Number(day.slice(-2)) - 1];
}
const jobKey = value => value.trim().toLocaleLowerCase("pt-BR");

export function analyzePlan(plan, neighbors = []) {
  validatePlan(plan);
  const days = monthDays(plan.month);
  const issues = [];
  const warnings = [];
  const coverage = days.map((day, index) => {
    const totals = plan.shifts.map(shift => {
      const working = plan.rows.filter(r => r.shiftId === shift.id && r.days[index] === "T");
      if (working.length < shift.minimum) issues.push(`${day}: ${shift.name} tem ${working.length}/${shift.minimum} pessoas.`);
      for (const requirement of plan.coverage.filter(c => c.shiftId === shift.id)) {
        const count = working.filter(r => jobKey(r.jobTitle) === jobKey(requirement.jobTitle)).length;
        if (count < requirement.minimum) issues.push(`${day}: ${shift.name} — ${requirement.jobTitle} (${count}/${requirement.minimum}).`);
      }
      return working.length;
    });
    return totals;
  });
  const firstWeek = offsetDay(days[0], -weekday(days[0]));
  let incompleteCount = 0;
  for (const row of plan.rows) {
    let incomplete = false;
    let streak = 0;
    let sundayStreak = 0;
    for (let day = offsetDay(days[0], -21); day <= offsetDay(days.at(-1), 7); day = offsetDay(day, 1)) {
      const state = dayState(plan, row.personId, day, neighbors);
      streak = state === "T" ? streak + 1 : 0;
      if (day >= days[0] && offsetDay(day, -6) <= days.at(-1) && streak === 7) issues.push(`${row.name}: mais de seis dias seguidos de trabalho (${day}).`);
      if (weekday(day) === 6) {
        sundayStreak = state === "T" ? sundayStreak + 1 : 0;
        if (day >= days[0] && offsetDay(day, -7) <= days.at(-1) && sundayStreak === 2) issues.push(`${row.name}: dois domingos consecutivos de trabalho (${day}).`);
      }
    }
    for (let week = firstWeek; week <= days.at(-1); week = offsetDay(week, 7)) {
      const weekDays = Array.from({ length: 7 }, (_, i) => offsetDay(week, i));
      const states = weekDays.map(day => dayState(plan, row.personId, day, neighbors));
      if (states.includes(undefined)) { incomplete = true; continue; }
      if (states.some(s => s === "V" || s === "A")) continue;
      const total = states.filter(s => s === "T").length;
      if (total !== 5) issues.push(`${row.name}: ${week} — ${total} dias de trabalho na semana (esperado 5).`);
    }
    if (incomplete) incompleteCount++;
  }
  if (incompleteCount) warnings.push(`${incompleteCount} funcionário(s): semana compartilhada com outro mês sem escala completa.`);
  return { issues, warnings, coverage };
}

export function generatePlan(plan, neighbors = []) {
  validatePlan(plan);
  const days = monthDays(plan.month);
  const first = offsetDay(days[0], -weekday(days[0]));
  const rows = plan.rows.map(row => ({ ...row, days: row.days.map(s => s === "V" || s === "A" ? s : "T") }));
  const candidates = [];
  for (let a = 0; a < 7; a++) for (let b = a + 1; b < 7; b++) candidates.push([a, b]);
  const history = { ...plan, rows };
  for (let week = first; week <= days.at(-1); week = offsetDay(week, 7)) {
    const weekDays = Array.from({ length: 7 }, (_, i) => offsetDay(week, i));
    const order = rows.slice().sort((a, b) => ((a.personId + weekday(days[0])) % rows.length) - ((b.personId + weekday(days[0])) % rows.length));
    for (const row of order) {
      const shift = plan.shifts.find(s => s.id === row.shiftId);
      const fixed = weekDays.map(day => day.startsWith(plan.month) ? (dayState(history, row.personId, day, neighbors) === "V" || dayState(history, row.personId, day, neighbors) === "A" ? dayState(history, row.personId, day, neighbors) : undefined) : dayState(history, row.personId, day, neighbors));
      let best; let bestScore = Infinity;
      for (const pair of candidates) {
        const pattern = weekDays.map((_, i) => fixed[i] ?? (pair.includes(i) ? "F" : "T"));
        let score = Math.abs(pattern.filter(s => s === "F").length - 2) * 10000;
        let streak = 0;
        for (let prior = offsetDay(week, -1); streak < 7 && dayState(history, row.personId, prior, neighbors) === "T"; prior = offsetDay(prior, -1)) streak++;
        for (const state of pattern) { streak = state === "T" ? streak + 1 : 0; if (streak > 6) score += 10000; }
        const priorSunday = dayState(history, row.personId, offsetDay(week, -1), neighbors);
        if (pattern[6] === "T" && priorSunday === "T") score += 10000;
        const sameShift = order.filter(r => r.shiftId === row.shiftId);
        const preferSundayOff = priorSunday ? priorSunday === "T" : sameShift.indexOf(row) % 2 === 0;
        if ((pattern[6] === "F") !== preferSundayOff) score += 30;
        for (let i = 0; i < 7; i++) {
          if (pattern[i] !== "F" || !weekDays[i].startsWith(plan.month)) continue;
          const index = Number(weekDays[i].slice(-2)) - 1;
          const coworkers = rows.filter(r => r.personId !== row.personId && r.shiftId === row.shiftId && r.days[index] === "T");
          score += Math.max(0, shift.minimum - coworkers.length) * 1000 - coworkers.length;
          for (const c of plan.coverage.filter(c => c.shiftId === row.shiftId && jobKey(c.jobTitle) === jobKey(row.jobTitle))) score += Math.max(0, c.minimum - coworkers.filter(r => jobKey(r.jobTitle) === jobKey(c.jobTitle)).length) * 1000;
        }
        if (score < bestScore) { bestScore = score; best = pattern; }
      }
      weekDays.forEach((day, i) => { if (day.startsWith(plan.month)) row.days[Number(day.slice(-2)) - 1] = best[i]; });
    }
  }
  return { ...plan, status: "draft", rows };
}
