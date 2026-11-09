import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "./worker.mjs";

const sql = new DatabaseSync(":memory:");
const migration = readFileSync(new URL("./migrations/0001_tarefas.sql", import.meta.url), "utf8");
sql.exec(migration);
sql.exec(migration);
const users = [
  ["office@example.com", "office", null],
  ["gerente@example.com", "manager", "vila-sao-pedro"],
  ["equipe@example.com", "employee", "vila-sao-pedro"],
  ["desativado@example.com", "employee", "vila-sao-pedro"]
];
const insert = sql.prepare("INSERT INTO tarefas_acessos (email, perfil, unidade) VALUES (?, ?, ?)");
for (const user of users) insert.run(...user);
sql.exec("UPDATE tarefas_acessos SET ativo = 0 WHERE email = 'desativado@example.com'");
sql.exec(readFileSync(new URL("./migrations/0002_unidades_cadastraveis.sql", import.meta.url), "utf8"));
sql.exec(readFileSync(new URL("./migrations/0003_gestor_de_rede.sql", import.meta.url), "utf8"));
sql.exec(readFileSync(new URL("./migrations/0004_login_interno.sql", import.meta.url), "utf8"));
const DB = {
  prepare(query) {
    const stmt = sql.prepare(query);
    function bind(...args) {
      return {
        first: async () => stmt.get(...args) ?? null,
        all: async () => ({ results: stmt.all(...args) }),
        run: async () => ({ meta: { changes: Number(stmt.run(...args).changes) } })
      };
    }
    return { ...bind(), bind };
  }
};
const env = { DB, ACCESS_TEAM_URL: "https://teste.cloudflareaccess.com", ACCESS_AUD: "tarefas" };
const keys = await crypto.subtle.generateKey({
  name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
  publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256"
}, true, ["sign", "verify"]);
const key = await crypto.subtle.exportKey("jwk", keys.publicKey);
globalThis.fetch = async url => {
  assert.equal(url, env.ACCESS_TEAM_URL + "/cdn-cgi/access/certs");
  return Response.json({ keys: [{ ...key, kid: "teste" }] });
};

async function token(email, overrides = {}, kid = "teste") {
  const part = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwt = part({ alg: "RS256", kid }) + "." + part({
    iss: env.ACCESS_TEAM_URL, aud: [env.ACCESS_AUD],
    exp: Date.now() / 1000 + 300, email, ...overrides
  });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, Buffer.from(jwt));
  return jwt + "." + Buffer.from(sig).toString("base64url");
}

const [office, manager, employee, disabled] = await Promise.all(users.map(([email]) => token(email)));
const domain = "https://tarefas.example.com";
async function request(auth, path = "state", method = "GET", payload, origin = domain, extraHeaders = {}) {
  const headers = { Origin: origin, ...extraHeaders };
  if (auth) headers["Cf-Access-Jwt-Assertion"] = auth;
  if (payload) headers["Content-Type"] = "application/json";
  const response = await worker.fetch(new Request(domain + "/api/" + path, {
    method, headers, body: payload ? JSON.stringify(payload) : undefined
  }), env);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie") };
}

assert.equal((await request(null)).status, 401);
assert.equal((await request(await token(users[0][0], { aud: ["outro"] }))).status, 401);
assert.equal((await request(await token(users[0][0], { exp: 1 }))).status, 401);
assert.equal((await request(office.replace(/\.[^.]+$/, ".AAAA"))).status, 401);
assert.equal((await request(disabled)).status, 403);
assert.equal((await request(await token("fora@example.com"))).status, 403);
assert.equal((await request(office)).body.revision, 0);

const cookieRequest = (value, assertion = null) => request(assertion, "state", "GET", undefined, domain, {
  Cookie: `preferencia=1; CF_Authorization=${value}; outro=2`
});
assert.equal((await cookieRequest(office)).status, 200);
assert.equal((await cookieRequest(office.replace(/\.[^.]+$/, ".AAAA"))).status, 401);
assert.equal((await cookieRequest(await token(users[0][0], { aud: ["outro"] }))).status, 401);
assert.equal((await cookieRequest(await token(users[0][0], { exp: 1 }))).status, 401);
assert.equal((await cookieRequest(disabled)).status, 403);
assert.equal((await cookieRequest(office, disabled)).status, 403);
assert.equal((await request(await token(users[0][0], { aud: env.ACCESS_AUD }))).status, 200);
for (const [claims, stage] of [
  [{ iss: "https://outra-equipe.cloudflareaccess.com" }, "EMISSOR"],
  [{ aud: ["outra-aplicacao"] }, "AUD"],
  [{ exp: 1 }, "VALIDADE"],
  [{ email: undefined }, "IDENTIDADE"]
]) {
  const result = await request(await token(users[0][0], claims));
  assert.equal(result.status, 401);
  assert.match(result.body.error, new RegExp(`ACCESS-${stage}`));
}
assert.match((await cookieRequest(office.replace(/\.[^.]+$/, ".AAAA"))).body.error, /ACCESS-ASSINATURA/);

const base = {
  departmentId: 1, title: "Caixa", description: "", status: "Pendente",
  priority: "Alta", due: "2026-11-06", createdAt: 1
};
const data = {
  departments: [{ id: 1, name: "Caixa", description: "" }],
  people: [{ id: 1, name: "Equipe", email: users[2][0], departmentId: 1, role: "Funcionário" }],
  tasks: [
    { ...base, id: 1, unitId: "vila-sao-pedro", personId: 1, checklist: [false, false, false, false] },
    { ...base, id: 2, unitId: "vila-sao-pedro", personId: null },
    { ...base, id: 3, unitId: "parque-sao-bernardo", personId: 1 },
    { ...base, id: 4, unitId: null, personId: 1 }
  ],
  cashRoutines: [], cashDepartmentId: null
};
assert.equal((await request(office, "state", "PUT", { data, revision: 0 }, "https://fora.example")).status, 403);
assert.equal((await request(employee, "state", "PUT", { data, revision: 0 })).status, 403);
assert.equal((await request(office, "state", "PUT", { data, revision: 0, importing: true })).status, 200);
assert.equal((await request(office, "state", "PUT", { data, revision: 1, importing: true })).status, 409);
const visibleManager = (await request(manager)).body.data;
assert.deepEqual(visibleManager.tasks.map(task => task.id), [1, 2]);
assert.equal(visibleManager.people[0].email, "");
assert.deepEqual((await request(employee)).body.data.tasks.map(task => task.id), [1]);

const completion = { revision: 1, status: "Concluída", checklist: [true, true, true, true] };
assert.equal((await request(employee, "tasks/2", "PATCH", completion)).status, 404);
assert.equal((await request(manager, "tasks/3", "PATCH", completion)).status, 404);
assert.equal((await request(employee, "tasks/1", "PATCH", { ...completion, checklist: [false, true, true, true] })).status, 400);

const parallel = await Promise.all([
  request(employee, "tasks/1", "PATCH", { ...completion, unitId: "escritorio" }),
  request(manager, "tasks/1", "PATCH", completion)
]);
assert.deepEqual(parallel.map(result => result.status).sort(), [200, 409]);
const synced = (await request(office)).body;
assert.equal(synced.data.tasks[0].status, "Concluída");
assert.equal(synced.data.tasks[0].unitId, "vila-sao-pedro");
assert.equal(synced.revision, 2);
assert.ok(synced.data.tasks[0].completedAt);

const newUnit = { id: "nova-loja", name: "Nova Loja", store: true };
const newManager = await token("nova-gerencia@example.com");
sql.prepare("INSERT INTO tarefas_acessos (email, perfil, unidade) VALUES (?, ?, ?)")
  .run("nova-gerencia@example.com", "manager", newUnit.id);
assert.equal((await request(newManager)).status, 403);
const newData = structuredClone(synced.data);
newData.units.push(newUnit);
newData.tasks.push({ ...base, id: 5, unitId: newUnit.id, personId: null });
newData.cashRoutines.push({ unitId: newUnit.id, active: true, nextDay: new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit"
}).format(new Date()) });
assert.equal((await request(manager, "state", "PUT", { revision: 2, data: newData })).status, 403);
assert.equal((await request(office, "state", "PUT", { revision: 2, data: newData })).status, 200);
const newView = (await request(newManager)).body;
assert.deepEqual(newView.data.units, [newUnit]);
assert.equal(newView.data.tasks.length, 2);
assert.ok(newView.data.tasks.some(task => task.checklist));
assert.ok(!(await request(manager)).body.data.units.some(unit => unit.id === newUnit.id));
const fullView = (await request(office)).body;
const editData = structuredClone(fullView.data);
editData.units.find(unit => unit.id === newUnit.id).name = " vila são pedro ";
assert.equal((await request(office, "state", "PUT", { revision: fullView.revision, data: editData })).status, 400);
editData.units.find(unit => unit.id === newUnit.id).name = "Nova Loja Renomeada";
assert.equal((await request(office, "state", "PUT", { revision: fullView.revision, data: editData })).status, 200);
const afterRename = (await request(newManager)).body;
assert.equal(afterRename.data.units[0].name, "Nova Loja Renomeada");
assert.deepEqual(afterRename.data.tasks, newView.data.tasks);

assert.equal((await request(manager, "access-users")).status, 403);
assert.equal((await request(employee, "access-users")).status, 403);
const list = await request(office, "access-users");
assert.equal(list.status, 200);
assert.ok(list.body.users.some(user => user.email === users[0][0]));
const access = { email: "  Novo@Example.com ", perfil: "employee", unidade: "vila-sao-pedro", ativo: 1 };
assert.equal((await request(employee, "access-users", "POST", access)).status, 403);
assert.equal((await request(office, "access-users", "POST", access, "https://fora.example")).status, 403);
assert.equal((await request(office, "access-users", "POST", { ...access, unidade: "inexistente" })).status, 400);
const created = await request(office, "access-users", "POST", access);
assert.equal(created.status, 201);
assert.equal(created.body.user.email, "novo@example.com");
assert.equal((await request(office, "access-users", "POST", access)).status, 409);
const newEmployee = await token(created.body.user.email);
assert.equal((await request(newEmployee)).status, 200);
const previous = created.body.user;
assert.equal((await request(office, "access-users", "PATCH", {
  ...previous, email: users[0][0], ativo: 0, anterior: previous
})).status, 403);
const changed = await request(office, "access-users", "PATCH", {
  ...previous, perfil: "manager", unidade: newUnit.id, anterior: previous
});
assert.equal(changed.status, 200);
assert.deepEqual((await request(newEmployee)).body.data.units, afterRename.data.units);
assert.equal((await request(office, "access-users", "PATCH", {
  ...previous, ativo: 0, anterior: previous
})).status, 409);
const revoked = await request(office, "access-users", "PATCH", {
  ...changed.body.user, ativo: 0, anterior: changed.body.user
});
assert.equal(revoked.status, 200);
assert.equal((await request(newEmployee)).status, 403);
assert.equal((await request(office, "access-users", "PATCH", {
  ...revoked.body.user, ativo: 1, anterior: revoked.body.user
})).status, 200);
assert.equal((await request(newEmployee)).status, 200);

const networkAccount = { email: "rede@example.com", perfil: "network_manager", unidade: null, ativo: 1 };
assert.equal((await request(office, "access-users", "POST", { ...networkAccount, unidade: "vila-sao-pedro" })).status, 400);
assert.equal((await request(office, "access-users", "POST", networkAccount)).status, 201);
const networkManager = await token(networkAccount.email);
const networkView = (await request(networkManager)).body;
const officeView = (await request(office)).body;
assert.deepEqual(networkView.data.units, officeView.data.units);
assert.deepEqual(networkView.data.tasks, officeView.data.tasks);
assert.ok(networkView.data.people.every(person => person.email === ""));
assert.equal((await request(networkManager, "access-users")).status, 403);
assert.equal((await request(networkManager, "access-users", "POST", networkAccount)).status, 403);
assert.equal((await request(networkManager, "access-users", "PATCH", networkAccount)).status, 403);
assert.equal((await request(networkManager, "state", "PUT", { data, revision: 1 })).status, 403);
assert.equal((await request(networkManager, "tasks/5", "PATCH", {
  revision: networkView.revision, status: "Concluída", checklist: null
})).status, 200);

assert.match((await request(await token(users[0][0], {}, "ausente"))).body.error, /ACCESS-CHAVE-ID/);
env.ACCESS_TEAM_URL = "https://outra-equipe.cloudflareaccess.com";
const renewed = await token(users[0][0]);
globalThis.fetch = async () => new Response(null, { status: 403 });
const refusedKeys = await request(renewed);
assert.equal(refusedKeys.status, 503);
assert.match(refusedKeys.body.error, /ACCESS-CHAVE-HTTP-403/);
let attempts = 0;
globalThis.fetch = async () => {
  if (++attempts === 1) throw new Error("Falha de rede");
  return Response.json({ keys: [{ ...key, kid: "teste" }] });
};
assert.equal((await request(renewed)).status, 200);
assert.equal(attempts, 2);
console.log("OK: autenticação, migração, unidades novas e renomeadas, isolamento, backup, checklist e conflitos de revisão.");

const officeBridge = await token(users[0][0]);
const makeLink = email => request(officeBridge, "auth/password-link", "POST", { email });
const setPassword = (token, password) => request(null, "auth/password", "POST", { token, password });
const password = "teste12345";
const email = networkAccount.email;
const firstLink = await makeLink(email);
assert.equal(firstLink.status, 200);
assert.equal((await setPassword(firstLink.body.token, "teste1234")).status, 400);
assert.equal((await setPassword(firstLink.body.token, password)).status, 200);
assert.equal((await setPassword(firstLink.body.token, password)).status, 400);
const account = sql.prepare("SELECT senha_hash, senha_token FROM tarefas_acessos WHERE email = ?").get(email);
assert.notEqual(account.senha_hash, password);
assert.equal(account.senha_token, null);

env.AUTH_MODE = "internal";
assert.equal((await request(office)).status, 401);
const login = (value = password) => request(null, "auth/login", "POST", { email, password: value });
assert.equal((await login("senha incorreta")).status, 401);
assert.equal((await request(null, "auth/login", "POST", { email, password }, "https://fora.example")).status, 403);
const signedIn = await login();
assert.equal(signedIn.status, 200);
assert.match(signedIn.cookie, /Path=\/; Secure; HttpOnly; SameSite=Strict/);
const cookie = { Cookie: signedIn.cookie.split(";")[0] };
assert.equal((await request(null, "state", "GET", null, domain, cookie)).body.viewer.role, "network_manager");
assert.equal((await request(null, "auth/password-link", "POST", { email }, domain, cookie)).status, 403);
assert.equal((await request(null, "auth/logout", "POST", {}, domain, cookie)).status, 200);
assert.equal((await request(null, "state", "GET", null, domain, cookie)).status, 401);
const second = await login();
const oldCookie = { Cookie: second.cookie.split(";")[0] };
delete env.AUTH_MODE;
const reset = await makeLink(email);
assert.equal(reset.status, 200);
env.AUTH_MODE = "internal";
const newPassword = "outra senha longa para validação";
assert.equal((await setPassword(reset.body.token, newPassword)).status, 200);
assert.equal((await request(null, "state", "GET", null, domain, oldCookie)).status, 401);
assert.equal((await login()).status, 401);
const latest = await login(newPassword);
assert.equal(latest.status, 200);
const latestCookie = { Cookie: latest.cookie.split(";")[0] };
delete env.AUTH_MODE;
const active = (await request(officeBridge, "access-users")).body.users.find(user => user.email === email);
const inactive = await request(officeBridge, "access-users", "PATCH", { ...active, ativo: 0, anterior: active });
assert.equal(inactive.status, 200);
assert.equal((await request(officeBridge, "access-users", "PATCH", { ...active, anterior: inactive.body.user })).status, 200);
env.AUTH_MODE = "internal";
assert.equal((await request(null, "state", "GET", null, domain, latestCookie)).status, 401);
for (let attempt = 0; attempt < 8; attempt++) assert.equal((await login()).status, 401);
assert.equal((await login(newPassword)).status, 429);
console.log("OK: login interno, ativação, recuperação, sessão, revogação e limite de tentativas.");
