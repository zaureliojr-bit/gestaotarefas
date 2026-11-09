import { STATUSES, CHECKLIST, localDay, normalize, nextId, unitNameKey } from "./model.mjs";

const $ = id => document.getElementById(id);
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[c]));

const passwordFragment = /^#senha=([a-f0-9]{64})$/.exec(location.hash);
let passwordToken = passwordFragment?.[1];
if (passwordToken) history.replaceState(null, "", location.pathname + location.search);
let internalLogin = false;
let awaitingLogin = Boolean(passwordToken);

let data;
let viewer;
let revision;
let saving = false;
let loading = false;
const isAdmin = () => viewer?.role === "office";
const accessRoles = { office: "Escritório", network_manager: "Gestor de rede", manager: "Gestor de unidade", employee: "Colaborador" };

function showMessage(id, message) {
  const el = $(id);
  el.textContent = message;
  el.hidden = !message;
}

async function api(path, options) {
  const response = await fetch("./api/" + path, {
    cache: "no-store", redirect: "error", ...options
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || "Falha ao sincronizar.");
    error.status = response.status;
    throw error;
  }
  return result;
}

function applySnapshot(snapshot) {
  data = snapshot.data;
  revision = snapshot.revision;
  viewer = snapshot.viewer;
  $("accountName").textContent = viewer.email;
  $("accountRole").textContent = accessRoles[viewer.role];
  $("greeting").textContent = "Visão geral das tarefas";
  $("accountAvatar").textContent = viewer.email.slice(0, 2).toUpperCase();
  document.querySelectorAll("[data-admin]").forEach(el => { el.hidden = !isAdmin(); });
  $("panel").hidden = false;
  $("syncGate").hidden = true;
  if (!isAdmin()) {
    accessUsers = [];
    $("accessTable").replaceChildren();
    if (document.querySelector(".page.active[data-admin]")) showPage("overview");
  }
  render();
}

function postAuth(route, data) {
  return api("auth/" + route, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)
  });
}

async function sync() {
  if (awaitingLogin || saving || loading || document.querySelector("dialog[open]")) return;
  loading = true;
  try {
    applySnapshot(await api("state"));
    showMessage("storageWarning", "");
  } catch (error) {
    // Oculta os dados em tela caso a sessão ou a concessão tenha expirado.
    $("panel").hidden = true;
    $("syncGate").hidden = false;
    if (internalLogin && error.status === 401) {
      $("loginForm").hidden = false;
      data = viewer = revision = undefined;
      $("accessTable").replaceChildren();
      accessUsers = [];
    }
    showMessage("initialError", error.message || "Acesse novamente com seu login.");
  } finally {
    loading = false;
  }
}

async function saveData(next, errorId = "storageWarning", taskId = null, importing = false) {
  if (saving || loading) {
    showMessage(errorId, "A sincronização está em andamento. Tente novamente.");
    return false;
  }
  saving = true;
  try {
    const task = taskId === null ? null : next.tasks.find(t => t.id === taskId);
    const payload = task ? { revision, status: task.status, checklist: task.checklist ?? null }
      : { revision, data: next, importing };
    applySnapshot(await api(task ? "tasks/" + taskId : "state", {
      method: task ? "PATCH" : "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }));
    showMessage("storageWarning", "");
    showMessage(errorId, "");
    return true;
  } catch (error) {
    showMessage(errorId, error.message);
    return false;
  } finally {
    saving = false;
  }
}

function notify(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => el.classList.remove("show"), 2500);
}

async function commit(change, message, errorId, taskId) {
  const next = structuredClone(data);
  change(next);
  if (!await saveData(next, errorId, taskId)) return false;
  notify(message);
  return true;
}

const deptName = id => data.departments.find(d => d.id === id)?.name || "Sem departamento";
const personName = id => data.people.find(p => p.id === id)?.name || "Não atribuído";
const unitName = id => data.units.find(unit => unit.id === id)?.name || "Sem unidade";
const statusClass = status => ({
  "Concluída": "tag-concluida", "Em andamento": "tag-andamento", "Pendente": "tag-pendente"
})[status];
const nextAction = {
  "Pendente": { label: "Iniciar", status: "Em andamento" },
  "Em andamento": { label: "Concluir", status: "Concluída" },
  "Concluída": { label: "Reabrir", status: "Pendente" }
};

function showPage(name) {
  document.querySelectorAll(".page").forEach(page => page.classList.toggle("active", page.id === "page-" + name));
  document.querySelectorAll(".nav-btn").forEach(button => button.classList.toggle("active", button.dataset.page === name));
  const titles = { overview: "Visão geral", tasks: "Tarefas", units: "Unidades", departments: "Departamentos", people: "Funcionários", access: "Usuários e acessos", reports: "Relatórios" };
  $("pageTitle").textContent = titles[name];
  $("breadcrumb").textContent = titles[name];
  $("sidebar").classList.remove("open");
  if (name === "access") loadAccessUsers();
}

document.querySelectorAll("[data-page]").forEach(b => b.onclick = () => showPage(b.dataset.page));
document.querySelectorAll("[data-go]").forEach(b => b.onclick = () => showPage(b.dataset.go));
$("mobileMenu").onclick = () => $("sidebar").classList.toggle("open");

function tasksByUnit() {
  const unit = $("filterUnit").value;
  return data.tasks.filter(task => !unit || (task.unitId ?? "none") === unit);
}

function matchesDue(task, filter, day) {
  if (!filter) return true;
  if (!task.due || task.status === "Concluída") return false;
  return filter === "today" ? task.due === day : task.due < day;
}

function formatDay(day) {
  return day ? day.split("-").reverse().join("/") : "Não definido";
}

function taskMarkup(task) {
  const checklist = task.checklist ? ` · Checklist: ${task.checklist.filter(Boolean).length}/${CHECKLIST.length}` : "";
  return `<div class="task-item"><div><div class="task-title">${esc(task.title)}</div>
    <div class="task-meta">${esc(unitName(task.unitId))} · ${esc(deptName(task.departmentId))} · ${esc(personName(task.personId))}
    · Prazo: ${formatDay(task.due)}${checklist}</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
      <span class="tag ${statusClass(task.status)}">${esc(task.status)}</span><span class="tag tag-priority">${esc(task.priority)}</span>
    </div></div>
    <div class="task-actions">
      <button class="small-btn" data-edit-task="${task.id}">${task.checklist ? "Abrir checklist" : isAdmin() ? "Editar" : "Ver tarefa"}</button>
      <button class="small-btn" data-next-task="${task.id}">${nextAction[task.status].label}</button>
      ${isAdmin() ? `<button class="small-btn" data-delete-task="${task.id}">Excluir</button>` : ""}
    </div></div>`;
}

function renderTasks() {
  const query = $("searchTasks").value.trim().toLowerCase();
  const status = $("filterStatus").value;
  const dept = $("filterDepartment").value;
  const due = $("filterDue").value;
  const day = localDay();
  const filtered = tasksByUnit().filter(t =>
    (t.title + " " + personName(t.personId)).toLowerCase().includes(query) &&
    (!status || t.status === status) && (!dept || String(t.departmentId) === dept) &&
    matchesDue(t, due, day)
  ).sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
  $("taskList").innerHTML = filtered.length ? filtered.map(taskMarkup).join("") :
    '<div class="empty">Nenhuma tarefa encontrada.</div>';
}

function changeStatus(task, status) {
  if (task.status === status) return;
  task.status = status;
  task.completedAt = status === "Concluída" ? Date.now() : null;
}

$("taskList").onclick = event => {
  const button = event.target.closest("button");
  if (!button) return;
  const { editTask, nextTask, deleteTask } = button.dataset;
  const id = Number(editTask ?? nextTask ?? deleteTask);
  const task = data.tasks.find(t => t.id === id);
  if (!task) return;

  if (editTask) openTask(id);
  if (nextTask) {
    const status = nextAction[task.status].status;
    if (status === "Concluída" && task.checklist?.some(checked => !checked)) {
      openTask(id);
      $("taskStatus").value = "Concluída";
      showMessage("taskError", "Marque todos os itens antes de concluir o fechamento.");
      return;
    }
    commit(next => changeStatus(next.tasks.find(t => t.id === id), status), "Status atualizado.", undefined, isAdmin() ? null : id);
  }
  if (deleteTask && confirm("Deseja excluir esta tarefa?")) {
    commit(next => { next.tasks = next.tasks.filter(t => t.id !== id); }, "Tarefa excluída.");
  }
};

function renderOverview() {
  const tasks = tasksByUnit();
  const day = localDay();
  $("metricTotal").textContent = tasks.length;
  $("metricProgress").textContent = tasks.filter(t => t.status === "Em andamento").length;
  $("metricDone").textContent = tasks.filter(t => t.status === "Concluída").length;
  $("metricToday").textContent = tasks.filter(t => matchesDue(t, "today", day)).length;
  $("metricLate").textContent = tasks.filter(t => matchesDue(t, "late", day)).length;
  $("recentTasks").innerHTML = tasks.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 5).map(t =>
    `<div class="task-item"><div><div class="task-title">${esc(t.title)}</div>
    <div class="task-meta">${esc(unitName(t.unitId))} · ${esc(deptName(t.departmentId))} · ${esc(personName(t.personId))}</div>
    </div><span class="tag ${statusClass(t.status)}">${esc(t.status)}</span></div>`
  ).join("") || '<div class="empty">Nenhuma tarefa cadastrada.</div>';
  $("departmentProgress").innerHTML = data.departments.map(d => {
    const all = tasks.filter(t => t.departmentId === d.id);
    const done = all.filter(t => t.status === "Concluída").length;
    const pct = all.length ? Math.round(done / all.length * 100) : 0;
    return `<div class="progress-row"><div class="progress-label"><b>${esc(d.name)}</b>
      <span>${done}/${all.length} concluídas · ${pct}%</span></div>
      <div class="progress"><span style="width:${pct}%"></span></div></div>`;
  }).join("");
}

function showDue(filter) {
  $("searchTasks").value = "";
  $("filterStatus").value = "";
  $("filterDepartment").value = "";
  $("filterDue").value = filter;
  showPage("tasks");
  renderTasks();
}

$("dueToday").onclick = () => showDue("today");
$("dueLate").onclick = () => showDue("late");

function renderUnits() {
  $("unitCards").innerHTML = data.units.map(unit =>
    `<article class="department-card"><h3>${esc(unit.name)}</h3>
      <div class="dept-stats">${unit.store ? "Loja" : "Administrativa"}</div>
      <div class="dept-stats">Código de acesso da unidade: <code>${esc(unit.id)}</code></div>
      <div class="department-actions"><button class="small-btn" data-edit-unit="${esc(unit.id)}">Editar</button></div>
    </article>`
  ).join("") || '<div class="empty">Nenhuma unidade cadastrada.</div>';
}

function openUnit(unit) {
  if (!isAdmin()) return;
  $("unitDialogTitle").textContent = unit ? "Editar unidade" : "Nova unidade";
  $("unitId").value = unit?.id ?? "";
  $("unitName").value = unit?.name ?? "";
  $("unitType").value = unit?.store === false ? "office" : "store";
  $("unitType").disabled = Boolean(unit);
  showMessage("unitError", "");
  $("unitDialog").showModal();
}

$("addUnit").onclick = () => openUnit();
$("unitCards").onclick = event => {
  const id = event.target.closest("[data-edit-unit]")?.dataset.editUnit;
  const unit = data.units.find(row => row.id === id);
  if (unit) openUnit(unit);
};

$("unitForm").addEventListener("submit", async event => {
  event.preventDefault();
  const id = $("unitId").value;
  const name = $("unitName").value.trim();
  if (!name || data.units.some(unit => unit.id !== id && unitNameKey(unit.name) === unitNameKey(name))) {
    showMessage("unitError", name ? "Já existe uma unidade com esse nome." : "Informe o nome da unidade.");
    return;
  }
  const store = $("unitType").value === "store";
  if (await commit(next => {
    const unit = next.units.find(row => row.id === id);
    if (unit) unit.name = name;
    else next.units.push({ id: crypto.randomUUID(), name, store });
  }, id ? "Unidade atualizada." : "Unidade cadastrada.", "unitError")) {
    $("unitDialog").close();
  }
});

function renderDepartments() {
  const tasks = tasksByUnit();
  $("departmentCards").innerHTML = data.departments.map(d => {
    const taskCount = tasks.filter(t => t.departmentId === d.id).length;
    const people = data.people.filter(p => p.departmentId === d.id).length;
    return `<article class="department-card"><h3>${esc(d.name)}</h3><p>${esc(d.description || "Sem descrição")}</p>
      <div class="dept-stats">${people} funcionário(s) · ${taskCount} tarefa(s) na seleção</div>
      <div class="department-actions">
        <button class="small-btn" data-edit-department="${d.id}" aria-label="Editar departamento ${esc(d.name)}">Editar</button>
        <button class="small-btn" data-delete-department="${d.id}" aria-label="Excluir departamento ${esc(d.name)}">Excluir</button>
      </div></article>`;
  }).join("") || '<div class="empty">Nenhum departamento cadastrado.</div>';
}

$("departmentCards").onclick = event => {
  const button = event.target.closest("button");
  if (!button) return;
  const { editDepartment, deleteDepartment } = button.dataset;
  const department = data.departments.find(d => d.id === Number(editDepartment ?? deleteDepartment));
  if (!department) return;
  if (editDepartment) openDepartment(department);
  else openDeleteDepartment(department);
};

function renderPeople() {
  $("peopleTable").innerHTML = data.people.map(p =>
    `<tr><td><b>${esc(p.name)}</b></td><td>${esc(p.email)}</td><td>${esc(deptName(p.departmentId))}</td>
      <td>${esc(p.role)}</td><td><div class="person-actions">
        <button class="small-btn" data-edit-person="${p.id}" aria-label="Editar funcionário ${esc(p.name)}">Editar</button>
        <button class="small-btn" data-delete-person="${p.id}">Excluir</button>
      </div></td></tr>`
  ).join("") || '<tr><td colspan="5" class="empty">Nenhum funcionário cadastrado.</td></tr>';
}

let accessUsers = [];
let editingAccess;
let loadingAccess = false;

function renderAccessUsers() {
  $("accessTable").innerHTML = accessUsers.map(user => `<tr>
    <td><b>${esc(user.email)}</b></td><td>${esc(accessRoles[user.perfil])}</td>
    <td>${esc(user.unidade === null ? "Todas" : unitName(user.unidade))}</td>
    <td>${user.ativo ? "Ativo" : "Desativado"}</td>
    <td>${user.email.toLowerCase() === viewer.email ? "Sua conta" :
      `<button class="small-btn" type="button" data-access-email="${esc(user.email)}">Editar</button>`}
      ${user.ativo ? `<button class="small-btn" type="button" data-password-email="${esc(user.email)}">Gerar link de senha</button>` : ""}</td>
  </tr>`).join("") || '<tr><td colspan="5" class="empty">Nenhum acesso cadastrado.</td></tr>';
}

async function loadAccessUsers() {
  if (!isAdmin() || loadingAccess) return;
  loadingAccess = true;
  showMessage("accessListError", "");
  try {
    const { users } = await api("access-users");
    if (!isAdmin()) return;
    accessUsers = users;
    renderAccessUsers();
  } catch (error) {
    accessUsers = [];
    renderAccessUsers();
    showMessage("accessListError", error.message);
  } finally {
    loadingAccess = false;
  }
}

function accessNeedsUnit(role) {
  return role === "manager" || role === "employee";
}

function updateAccessUnitField() {
  const needsUnit = accessNeedsUnit($("accessRole").value);
  $("accessUnitLabel").hidden = !needsUnit;
  $("accessUnit").disabled = !needsUnit;
  $("accessUnit").required = needsUnit;
}

function openAccess(user) {
  if (!isAdmin() || loadingAccess) return;
  editingAccess = user;
  $("accessDialogTitle").textContent = user ? "Editar acesso" : "Novo acesso";
  $("accessEmail").value = user?.email ?? "";
  $("accessEmail").readOnly = Boolean(user);
  $("accessRole").value = user?.perfil ?? "employee";
  $("accessUnit").value = user?.unidade ?? "";
  $("accessActive").value = String(user?.ativo ?? 1);
  updateAccessUnitField();
  showMessage("accessError", "");
  $("accessDialog").showModal();
}

$("addAccess").onclick = () => openAccess();
$("refreshAccess").onclick = loadAccessUsers;
$("accessRole").onchange = updateAccessUnitField;
$("accessTable").onclick = async event => {
  const linkButton = event.target.closest("[data-password-email]");
  if (linkButton && isAdmin()) {
    linkButton.disabled = true;
    const email = linkButton.dataset.passwordEmail;
    try {
      const { token } = await postAuth("password-link", { email });
      const link = new URL("/", location.origin);
      link.hash = "senha=" + token;
      $("passwordLink").value = link.href;
      $("passwordLinkHelp").textContent = `Compartilhe este link individualmente com ${email}. Ele vale por 1 hora e funciona uma vez.`;
      $("passwordLinkDialog").showModal();
    } catch (error) {
      showMessage("accessListError", error.message);
    } finally {
      linkButton.disabled = false;
    }
    return;
  }
  const email = event.target.closest("[data-access-email]")?.dataset.accessEmail;
  const user = accessUsers.find(row => row.email === email);
  if (user) openAccess(user);
};

$("accessForm").addEventListener("submit", async event => {
  event.preventDefault();
  const submit = $("saveAccess");
  if (!isAdmin() || submit.disabled) return;
  const perfil = $("accessRole").value;
  const payload = {
    email: $("accessEmail").value.trim(), perfil,
    unidade: accessNeedsUnit(perfil) ? $("accessUnit").value : null,
    ativo: Number($("accessActive").value), anterior: editingAccess
  };
  submit.disabled = true;
  showMessage("accessError", "");
  try {
    await api("access-users", {
      method: editingAccess ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    $("accessDialog").close();
    notify("Acesso salvo.");
    await loadAccessUsers();
  } catch (error) {
    showMessage("accessError", error.message);
  } finally {
    submit.disabled = false;
  }
});

$("peopleTable").onclick = event => {
  const button = event.target.closest("button");
  if (!button) return;
  const { editPerson, deletePerson } = button.dataset;
  const id = Number(editPerson ?? deletePerson);
  const person = data.people.find(p => p.id === id);
  if (!person) return;
  if (editPerson) {
    openPerson(person);
    return;
  }
  if (data.tasks.some(t => t.personId === id)) {
    notify("Reatribua as tarefas antes de excluir este funcionário.");
    return;
  }
  if (confirm("Excluir funcionário?")) {
    commit(next => { next.people = next.people.filter(p => p.id !== id); }, "Funcionário excluído.");
  }
};

function renderReports() {
  const tasks = tasksByUnit();
  const total = tasks.length;
  const done = tasks.filter(t => t.status === "Concluída").length;
  const percent = total ? Math.round(done / total * 100) : 0;
  $("reportSummary").innerHTML = `<article class="report-box"><h3>Conclusão de tarefas</h3>
    <div class="report-number">${percent}%</div><div class="progress"><span style="width:${percent}%"></span></div>
    <p class="task-meta">${done} de ${total} tarefa(s) concluída(s)</p></article>
    <article class="report-box"><h3>Distribuição por status</h3>${STATUSES.map(status =>
      `<div class="progress-label" style="margin-top:18px"><span>${status}</span><b>${tasks.filter(t => t.status === status).length}</b></div>`
    ).join("")}</article>`;
}

function populateSelects() {
  function options(id, markup) {
    const select = $(id);
    if (select.dataset.options === markup) return;
    const selected = select.value;
    select.innerHTML = markup;
    select.dataset.options = markup;
    if (Array.from(select.options).some(option => option.value === selected)) select.value = selected;
  }

  const departments = data.departments.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join("");
  options("taskDepartment", departments);
  options("personDepartment", departments);
  options("filterDepartment", '<option value="">Todos os departamentos</option>' + departments);
  options("taskPerson", '<option value="">Não atribuído</option>' + data.people.map(p =>
    `<option value="${p.id}">${esc(p.name)} · ${esc(deptName(p.departmentId))}</option>`
  ).join(""));
  const units = data.units.map(unit => `<option value="${esc(unit.id)}">${esc(unit.name)}</option>`).join("");
  options("filterUnit", '<option value="">Todas as unidades</option>' + units +
    (isAdmin() ? '<option value="none">Sem unidade</option>' : ""));
  options("taskUnit", '<option value="">Sem unidade</option>' + units);
  options("accessUnit", '<option value="">Selecione uma unidade</option>' + units);
}

function render() {
  populateSelects();
  renderOverview();
  renderTasks();
  if (isAdmin()) renderUnits();
  renderDepartments();
  renderPeople();
  renderReports();
  renderCashRoutine();
}

function openTask(id) {
  const task = data.tasks.find(t => t.id === id);
  const checklist = task?.checklist;
  const selectedUnit = $("filterUnit").value;
  $("taskDialogTitle").textContent = task ? "Editar tarefa" : "Nova tarefa";
  $("taskId").value = task?.id ?? "";
  $("taskTitle").value = task?.title ?? "";
  $("taskDescription").value = task?.description ?? "";
  $("taskUnit").value = task ? task.unitId ?? "" : selectedUnit === "none" ? "" : selectedUnit;
  $("taskDepartment").value = task?.departmentId ?? ($("filterDepartment").value || data.departments[0]?.id || "");
  $("taskPerson").value = task?.personId ?? "";
  $("taskDue").value = task?.due ?? "";
  $("taskPriority").value = task?.priority ?? "Média";
  $("taskStatus").value = task?.status ?? "Pendente";
  for (const field of ["taskTitle", "taskDescription", "taskDepartment", "taskPerson", "taskPriority"]) {
    $(field).disabled = !isAdmin();
  }
  $("taskUnit").disabled = !isAdmin() || Boolean(checklist);
  $("taskDue").disabled = !isAdmin() || Boolean(checklist);
  $("cashChecklist").hidden = !checklist;
  $("cashChecklistItems").innerHTML = checklist ? CHECKLIST.map((label, i) =>
    `<label><input type="checkbox"${checklist[i] ? " checked" : ""}> ${esc(label)}</label>`
  ).join("") : "";
  showMessage("taskError", "");
  $("taskDialog").showModal();
}

$("taskForm").addEventListener("submit", async event => {
  event.preventDefault();
  const id = Number($("taskId").value);
  const task = data.tasks.find(t => t.id === id);
  const item = {
    title: $("taskTitle").value.trim(),
    description: $("taskDescription").value.trim(),
    unitId: $("taskUnit").value || null,
    departmentId: Number($("taskDepartment").value),
    personId: Number($("taskPerson").value) || null,
    due: $("taskDue").value,
    priority: $("taskPriority").value
  };
  const status = $("taskStatus").value;
  if (!item.title || !item.departmentId) {
    showMessage("taskError", "Preencha o título e o departamento.");
    return;
  }
  if (task?.checklist) {
    item.checklist = Array.from($("cashChecklistItems").querySelectorAll("input"), input => input.checked);
    if (status === "Concluída" && item.checklist.some(checked => !checked)) {
      showMessage("taskError", "Marque todos os itens antes de concluir o fechamento.");
      return;
    }
  }
  if (await commit(next => {
    const existing = next.tasks.find(t => t.id === id);
    if (existing) {
      Object.assign(existing, item);
      changeStatus(existing, status);
    } else {
      const added = { id: nextId(next.tasks), ...item, createdAt: Date.now() };
      changeStatus(added, status);
      next.tasks.unshift(added);
    }
  }, "Tarefa sincronizada.", "taskError", isAdmin() ? null : id)) $("taskDialog").close();
});

$("newTask").onclick = $("newTaskTop").onclick = () => openTask();

function openDepartment(department) {
  $("departmentDialogTitle").textContent = department ? "Editar departamento" : "Novo departamento";
  $("departmentId").value = department?.id ?? "";
  $("departmentName").value = department?.name ?? "";
  $("departmentDescription").value = department?.description ?? "";
  showMessage("departmentError", "");
  $("departmentDialog").showModal();
}

$("addDepartment").onclick = () => openDepartment();
$("departmentForm").addEventListener("submit", async event => {
  event.preventDefault();
  const id = Number($("departmentId").value);
  const name = $("departmentName").value.trim();
  const description = $("departmentDescription").value.trim();
  if (!name || data.departments.some(d => d.id !== id && d.name.trim().toLowerCase() === name.toLowerCase())) {
    showMessage("departmentError", name ? "Este departamento já existe." : "Informe o nome do departamento.");
    return;
  }
  if (await commit(next => {
    const department = next.departments.find(d => d.id === id);
    if (department) Object.assign(department, { name, description });
    else next.departments.push({ id: nextId(next.departments), name, description });
  }, id ? "Departamento atualizado." : "Departamento cadastrado.", "departmentError")) {
    $("departmentDialog").close();
  }
});

function departmentLinks(id) {
  const tasks = data.tasks.filter(t => t.departmentId === id).length;
  const people = data.people.filter(p => p.departmentId === id).length;
  const cashRoutine = data.cashDepartmentId === id && data.cashRoutines.some(r => r.active);
  return { tasks, people, cashRoutine, needsTransfer: Boolean(tasks || people || cashRoutine) };
}

function openDeleteDepartment(department) {
  const { tasks, people, cashRoutine, needsTransfer } = departmentLinks(department.id);
  const destinations = data.departments.filter(d => d.id !== department.id);
  const blocked = needsTransfer && !destinations.length;
  const summary = [`Excluir “${department.name}”?`];
  if (needsTransfer) {
    summary.push(`Vínculos em todas as unidades: ${tasks} tarefa(s) e ${people} funcionário(s).`);
    if (cashRoutine) summary.push("O fechamento diário ativo também será transferido.");
    if (blocked) summary.push("Cadastre outro departamento para receber os vínculos antes de excluir este.");
  }
  $("deleteDepartmentId").value = department.id;
  $("deleteDepartmentSummary").textContent = summary.join(" ");
  $("transferDepartmentLabel").hidden = !needsTransfer || blocked;
  $("transferDepartment").required = needsTransfer && !blocked;
  $("transferDepartment").innerHTML = '<option value="">Selecione o departamento</option>' +
    destinations.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join("");
  $("confirmDeleteDepartment").disabled = blocked;
  showMessage("deleteDepartmentError", "");
  $("deleteDepartmentDialog").showModal();
}

$("deleteDepartmentForm").addEventListener("submit", async event => {
  event.preventDefault();
  const id = Number($("deleteDepartmentId").value);
  const { needsTransfer } = departmentLinks(id);
  const destination = needsTransfer ? Number($("transferDepartment").value) : null;
  if (needsTransfer && !data.departments.some(d => d.id === destination && d.id !== id)) {
    showMessage("deleteDepartmentError", "Selecione outro departamento para receber os vínculos. Se as opções mudaram, reabra esta janela.");
    return;
  }
  if (await commit(next => {
    for (const record of [...next.tasks, ...next.people]) {
      if (record.departmentId === id) record.departmentId = destination;
    }
    if (next.cashDepartmentId === id) next.cashDepartmentId = destination;
    next.departments = next.departments.filter(d => d.id !== id);
  }, "Departamento excluído.", "deleteDepartmentError")) $("deleteDepartmentDialog").close();
});

function openPerson(person) {
  if (!data.departments.length) {
    notify("Cadastre um departamento primeiro.");
    return;
  }
  $("personDialogTitle").textContent = person ? "Editar funcionário" : "Novo funcionário";
  $("personId").value = person?.id ?? "";
  $("personName").value = person?.name ?? "";
  $("personEmail").value = person?.email ?? "";
  $("personDepartment").value = person?.departmentId ?? data.departments[0].id;
  $("personRole").value = person?.role ?? "Funcionário";
  showMessage("personError", "");
  $("personDialog").showModal();
}

$("addPerson").onclick = () => openPerson();
$("personForm").addEventListener("submit", async event => {
  event.preventDefault();
  const id = Number($("personId").value);
  const email = $("personEmail").value.trim().toLowerCase();
  const name = $("personName").value.trim();
  const departmentId = Number($("personDepartment").value);
  const role = $("personRole").value;
  if (!name || !departmentId) {
    showMessage("personError", "Preencha o nome e o departamento.");
    return;
  }
  if (data.people.some(p => p.id !== id && p.email.trim().toLowerCase() === email)) {
    showMessage("personError", "Este e-mail já está cadastrado.");
    return;
  }
  if (await commit(next => {
    const person = next.people.find(p => p.id === id);
    const fields = { name, email, departmentId, role };
    if (person) Object.assign(person, fields);
    else next.people.push({ id: nextId(next.people), ...fields });
  }, id ? "Funcionário atualizado." : "Funcionário cadastrado.", "personError")) {
    $("personDialog").close();
  }
});

function renderCashRoutine() {
  const unitId = $("filterUnit").value;
  const visible = data.units.some(unit => unit.id === unitId && unit.store);
  const active = data.cashRoutines.some(r => r.unitId === unitId && r.active);
  $("cashRoutine").hidden = !isAdmin() || !visible;
  $("cashRoutine").textContent = active ? "Pausar fechamento diário" : "Ativar fechamento diário";
  $("cashRoutineHint").hidden = !isAdmin() || !visible || !active;
}

$("cashRoutine").onclick = () => {
  const unitId = $("filterUnit").value;
  if (!isAdmin() || !data.units.some(unit => unit.id === unitId && unit.store)) return;
  const active = data.cashRoutines.some(r => r.unitId === unitId && r.active);
  const day = localDay();
  commit(next => {
    let routine = next.cashRoutines.find(r => r.unitId === unitId);
    if (!routine) {
      routine = { unitId, active: false, nextDay: day };
      next.cashRoutines.push(routine);
    }
    routine.active = !active;
    if (routine.active) routine.nextDay = day;
  }, active ? "Fechamento diário pausado." : "Fechamento diário ativado.");
};

$("exportBackup").onclick = () => {
  const blob = new Blob([JSON.stringify({ app: "drogalink-painel", version: 2, data }, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `drogalink-backup-${localDay()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
};

$("importBackup").onclick = () => $("backupFile").click();
$("backupFile").addEventListener("change", async () => {
  const file = $("backupFile").files[0];
  $("backupFile").value = "";
  if (!file) return;
  let next;
  try {
    const raw = JSON.parse(await file.text());
    if (raw?.app !== "drogalink-painel" || raw.version !== 2) throw new Error("Versão incompatível");
    next = normalize(raw.data);
  } catch {
    notify("Arquivo inválido. Escolha um backup JSON exportado pelo Drogalink.");
    return;
  }
  if (!confirm("Importar este backup para o painel da rede? A importação exige que o painel esteja vazio.")) return;
  if (await saveData(next, "storageWarning", null, true)) {
    notify("Backup restaurado.");
  }
});

document.querySelectorAll("[data-close]").forEach(b => b.onclick = () => $(b.dataset.close).close());
$("searchTasks").addEventListener("input", renderTasks);
["filterStatus", "filterDepartment", "filterDue"].forEach(id => $(id).addEventListener("change", renderTasks));
$("filterUnit").addEventListener("change", render);
$("syncNow").onclick = sync;
document.addEventListener("visibilitychange", () => { if (!document.hidden) sync(); });
setInterval(() => { if (!document.hidden) sync(); }, 15000);
$("passwordLinkDialog").addEventListener("close", () => { $("passwordLink").value = ""; });
$("copyPasswordLink").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("passwordLink").value);
    notify("Link copiado.");
  } catch {
    $("passwordLink").select();
  }
};

for (const form of [$("loginForm"), $("passwordForm")]) {
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const button = form.querySelector("button[type=submit]");
    if (button.disabled) return;
    const fields = new FormData(form);
    const password = fields.get("password");
    const setting = form.id === "passwordForm";
    if (setting && password !== fields.get("confirmation")) {
      showMessage("initialError", "As senhas precisam ser iguais.");
      return;
    }
    button.disabled = true;
    try {
      if (setting) {
        await postAuth("password", { password, token: passwordToken });
        passwordToken = null;
        form.hidden = true;
        $("loginForm").hidden = false;
        showMessage("initialError", "Senha definida. Entre com seu e-mail e senha.");
      } else {
        await postAuth("login", { email: fields.get("email"), password });
        awaitingLogin = false;
        await sync();
      }
      form.reset();
    } catch (error) {
      showMessage("initialError", error.message);
    } finally {
      button.disabled = false;
    }
  });
}

document.querySelectorAll("[data-logout]").forEach(button => {
  button.onclick = async () => {
    button.disabled = true;
    try {
      if (internalLogin || viewer?.auth === "internal") await postAuth("logout", {});
      location.assign(internalLogin ? "/" : "/cdn-cgi/access/logout");
    } catch (error) {
      showMessage(viewer ? "storageWarning" : "initialError", error.message);
      button.disabled = false;
    }
  };
});

async function start() {
  try {
    internalLogin = (await api("auth/mode")).internal;
    if (passwordToken) {
      $("passwordForm").hidden = false;
      $("retrySync").hidden = true;
      showMessage("initialError", "Defina sua senha para o Drogalink Tarefas.");
    } else if (!awaitingLogin) {
      await sync();
    }
  } catch (error) {
    showMessage("initialError", error.message);
  }
}
$("retrySync").onclick = start;
start();
