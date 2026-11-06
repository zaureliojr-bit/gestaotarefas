const INITIAL_UNITS = [
  { id: "vila-sao-pedro", name: "Vila São Pedro", store: true },
  { id: "parque-sao-bernardo", name: "Parque São Bernardo", store: true },
  { id: "escritorio", name: "Escritório", store: false }
];
export const unitNameKey = name => name.trim().toLocaleLowerCase("pt-BR");
export const STATUSES = ["Pendente", "Em andamento", "Concluída"];
const PRIORITIES = ["Baixa", "Média", "Alta", "Urgente"];
export const CHECKLIST = [
  "Conferir o dinheiro em caixa com o total do sistema",
  "Conferir Pix e cartões com os comprovantes",
  "Registrar divergências, sangrias e suprimentos",
  "Guardar o relatório e os comprovantes do fechamento"
];

const saoPauloDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit"
});

export function localDay(date = new Date()) {
  return saoPauloDate.format(date);
}

function dateOffset(days, day = localDay()) {
  const date = new Date(day + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return localDay(date);
}

function isDay(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    localDay(new Date(value + "T12:00:00Z")) === value;
}

export function normalize(raw) {
  function checkRows(rows, check) {
    if (!Array.isArray(rows) || rows.some(row => !row || !Number.isSafeInteger(row.id) ||
        row.id <= 0 || !check(row)) || new Set(rows.map(row => row.id)).size !== rows.length) {
      throw new Error("Estrutura de dados inválida");
    }
  }

  if (!raw || typeof raw !== "object") throw new Error("Estrutura de dados inválida");
  const units = raw.units === undefined ? structuredClone(INITIAL_UNITS) : raw.units;
  if (!Array.isArray(units) || units.some(unit => !unit ||
      typeof unit.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(unit.id) ||
      unit.id === "none" || typeof unit.name !== "string" ||
      !unit.name.trim() || unit.name.trim().length > 100 || typeof unit.store !== "boolean") ||
      new Set(units.map(unit => unit.id)).size !== units.length ||
      new Set(units.map(unit => unitNameKey(unit.name))).size !== units.length) {
    throw new Error("Unidades inválidas");
  }
  const unitById = new Map(units.map(unit => [unit.id, unit]));
  checkRows(raw.departments, d => typeof d.name === "string" && typeof d.description === "string");
  const departments = new Set(raw.departments.map(d => d.id));
  checkRows(raw.people, p => typeof p.name === "string" && typeof p.email === "string" &&
    departments.has(p.departmentId) && ["Funcionário", "Gestor"].includes(p.role));
  const people = new Set(raw.people.map(p => p.id));
  checkRows(raw.tasks, t => typeof t.title === "string" && typeof t.description === "string" &&
    departments.has(t.departmentId) && (t.personId == null || people.has(t.personId)) &&
    (t.unitId == null || unitById.has(t.unitId)) && STATUSES.includes(t.status) &&
    PRIORITIES.includes(t.priority) && (t.due === "" || isDay(t.due)) &&
    Number.isFinite(t.createdAt) && (t.completedAt == null || Number.isFinite(t.completedAt)) &&
    (t.checklist == null || (t.due && unitById.get(t.unitId)?.store &&
      Array.isArray(t.checklist) && t.checklist.length === CHECKLIST.length &&
      t.checklist.every(checked => typeof checked === "boolean") &&
      (t.status !== "Concluída" || t.checklist.every(Boolean)))));

  const routines = raw.cashRoutines === undefined ? [] : raw.cashRoutines;
  if (!Array.isArray(routines) || routines.some(r => !r ||
      !unitById.get(r.unitId)?.store ||
      typeof r.active !== "boolean" || !isDay(r.nextDay) ||
      r.nextDay < "2000-01-01") || new Set(routines.map(r => r.unitId)).size !== routines.length) {
    throw new Error("Rotinas inválidas");
  }
  const cashDepartmentId = raw.cashDepartmentId === undefined && routines.length
    ? raw.departments.find(d => d.name.trim().toLowerCase() === "caixa")?.id ?? null
    : raw.cashDepartmentId ?? null;
  if (cashDepartmentId !== null && !departments.has(cashDepartmentId)) {
    throw new Error("Departamento de fechamento inválido");
  }
  return {
    units: units.map(unit => ({ id: unit.id, name: unit.name.trim(), store: unit.store })),
    departments: raw.departments,
    people: raw.people,
    tasks: raw.tasks.map(t => ({ ...t, unitId: t.unitId ?? null })),
    cashRoutines: routines,
    cashDepartmentId
  };
}

export function generateCashTasks(next, day) {
  let id = nextId(next.tasks);
  for (const routine of next.cashRoutines) {
    if (!routine.active || routine.nextDay > day) continue;
    let department = next.departments.find(d => d.id === next.cashDepartmentId) ??
      next.departments.find(d => d.name.trim().toLowerCase() === "caixa");
    if (!department) {
      department = { id: nextId(next.departments), name: "Caixa", description: "Fechamento e conferência de caixa" };
      next.departments.push(department);
    }
    next.cashDepartmentId = department.id;
    const existing = new Set(next.tasks.filter(t => t.unitId === routine.unitId && t.checklist).map(t => t.due));
    for (let due = routine.nextDay; due <= day; due = dateOffset(1, due)) {
      if (existing.has(due)) continue;
      next.tasks.push({
        id: id++, title: "Fechamento de caixa",
        description: "Confira o caixa da unidade e registre as divergências encontradas.",
        unitId: routine.unitId, departmentId: department.id, personId: null,
        due, priority: "Alta", status: "Pendente", createdAt: Date.now(), checklist: CHECKLIST.map(() => false)
      });
    }
    routine.nextDay = dateOffset(1, day);
  }
}

export function nextId(rows) {
  return rows.reduce((max, row) => Math.max(max, row.id), 0) + 1;
}

