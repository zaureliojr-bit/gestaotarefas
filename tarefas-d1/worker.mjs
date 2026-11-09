import { handleAuth, sessionViewer } from "./auth.mjs";
import { normalize, generateCashTasks, localDay, STATUSES, CHECKLIST } from "./public/model.mjs";

const MAX_BYTES = 512 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let keysCache;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }
  });
}

function decodePart(value) {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Base64url inválido");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), c => c.charCodeAt(0));
}

async function publicKey(team, kid) {
  if (keysCache?.team !== team || keysCache.expires <= Date.now() ||
      (!keysCache.keys.some(key => key.kid === kid) && keysCache.loaded < Date.now() - 60000)) {
    const response = await fetchAccessKeys(team);
    const document = await response.json().catch(() => null);
    const keys = Array.isArray(document?.keys) ? document.keys.filter(key =>
      key?.kty === "RSA" && typeof key.kid === "string" &&
      typeof key.n === "string" && typeof key.e === "string"
    ) : [];
    if (!keys.length) {
      throw new HttpError(503, "O servidor de chaves do Access devolveu uma resposta inválida (ACCESS-CHAVE-RESPOSTA).");
    }
    const loaded = Date.now();
    keysCache = { team, keys, loaded, expires: loaded + 15 * 60000 };
  }
  const jwk = keysCache.keys.find(key => key.kid === kid);
  if (!jwk) throw new HttpError(401, "A chave da sessão não consta na lista do Access (ACCESS-CHAVE-ID).");
  try {
    return await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  } catch {
    throw new HttpError(503, "O Worker não conseguiu importar a chave do Access (ACCESS-CHAVE-IMPORTACAO).");
  }
}

async function fetchAccessKeys(team) {
  let response;
  for (let attempt = 0; attempt < 2; attempt++) {
    response = await fetch(team + "/cdn-cgi/access/certs", {
      redirect: "manual",
      cache: "no-store",
      headers: { Accept: "application/json", "User-Agent": "Drogalink-Tarefas/1.0" },
      signal: AbortSignal.timeout(3500)
    }).catch(() => null);
    if (response && response.status < 500) break;
    await response?.body?.cancel().catch(() => {});
  }
  if (!response?.ok) {
    const code = response ? `HTTP-${response.status}` : "REDE";
    throw new HttpError(503, `O Worker não conseguiu consultar as chaves do Access (ACCESS-CHAVE-${code}).`);
  }
  return response;
}

function accessToken(request) {
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (assertion) return assertion;
  const cookie = request.headers.get("Cookie") ?? "";
  return /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie)?.[1] ?? "";
}

async function verifiedEmail(request, env) {
  const team = env.ACCESS_TEAM_URL;
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(team ?? "") || !env.ACCESS_AUD) {
    throw new HttpError(503, "Configure o login do painel.");
  }
  const token = accessToken(request);
  if (!token) {
    throw new HttpError(401, "O Cloudflare Access não enviou uma sessão ao painel. Clique em Sair e entre novamente.");
  }
  let stage = "FORMATO";
  try {
    if (token.length > 16384) throw new Error("Token inválido");
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Token inválido");
    const [header, payload, signature] = parts;
    const { alg, kid } = JSON.parse(decoder.decode(decodePart(header)));
    const { aud, iss, exp, nbf, email } = JSON.parse(decoder.decode(decodePart(payload)));
    const now = Date.now() / 1000;
    if (alg !== "RS256" || typeof kid !== "string") throw new Error();
    stage = "EMISSOR";
    if (iss !== team) throw new Error();
    stage = "AUD";
    if (aud !== env.ACCESS_AUD && !(Array.isArray(aud) && aud.includes(env.ACCESS_AUD))) throw new Error();
    stage = "VALIDADE";
    if (!Number.isFinite(exp) || exp <= now ||
        (nbf != null && (!Number.isFinite(nbf) || nbf > now))) throw new Error();
    stage = "CHAVE";
    const key = await publicKey(team, kid);
    stage = "ASSINATURA";
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decodePart(signature), encoder.encode(header + "." + payload));
    if (!valid) throw new Error();
    stage = "IDENTIDADE";
    if (typeof email !== "string" || !email.trim().includes("@")) throw new Error();
    return email.trim().toLowerCase();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, `O painel não conseguiu validar a sessão do Cloudflare Access (ACCESS-${stage}).`);
  }
}

async function getViewer(request, env) {
  if (env.AUTH_MODE === "internal" || request.headers.get("Cookie")?.includes("__Host-drogalink-tarefas=")) {
    const viewer = await sessionViewer(request, env.DB);
    if (viewer) return viewer;
    if (env.AUTH_MODE === "internal") throw new HttpError(401, "Entre com seu e-mail e senha.");
  }
  const email = await verifiedEmail(request, env);
  const row = await env.DB.prepare(
    "SELECT perfil, unidade FROM tarefas_acessos WHERE email = ? AND ativo = 1"
  ).bind(email).first();
  if (!row) throw new HttpError(403, "Este e-mail ainda não tem acesso ao módulo de tarefas.");
  return { email, role: row.perfil, unitId: row.unidade };
}

const networkAccess = role => role === "office" || role === "network_manager";
const accessRoles = ["office", "network_manager", "manager", "employee"];

function canSee(task, data, viewer) {
  if (networkAccess(viewer.role)) return true;
  if (task.unitId !== viewer.unitId) return false;
  if (viewer.role === "manager") return true;
  return data.people.some(person => person.id === task.personId && person.email.trim().toLowerCase() === viewer.email);
}

function checkUnitAccess(data, viewer) {
  if (!networkAccess(viewer.role) && !data.units.some(unit => unit.id === viewer.unitId)) {
    throw new HttpError(403, "A unidade vinculada à sua conta não está cadastrada.");
  }
}

function snapshot(data, revision, viewer) {
  if (viewer.role === "office") return { data, revision, viewer };
  const units = networkAccess(viewer.role) ? data.units : data.units.filter(unit => unit.id === viewer.unitId);
  const tasks = data.tasks.filter(task => canSee(task, data, viewer));
  const assignees = new Set(tasks.map(task => task.personId));
  const people = data.people.filter(person => assignees.has(person.id)).map(person => ({ ...person, email: "" }));
  const departmentIds = new Set([...tasks, ...people].map(record => record.departmentId));
  const departments = data.departments.filter(dept => departmentIds.has(dept.id));
  return { data: { units, tasks, people, departments, cashRoutines: [], cashDepartmentId: null }, revision, viewer };
}

async function load(db) {
  const row = await db.prepare("SELECT revisao, dados FROM tarefas_rede WHERE id = 1").first();
  if (!row) throw new HttpError(503, "Aplique a migração do módulo de tarefas.");
  return { revision: row.revisao, data: normalize(JSON.parse(row.dados)) };
}

async function persist(db, revision, data) {
  const serialized = JSON.stringify(data);
  if (encoder.encode(serialized).length > MAX_BYTES) throw new HttpError(413, "Os dados excedem o limite do piloto.");
  const result = await db.prepare(
    "UPDATE tarefas_rede SET dados = ?, revisao = revisao + 1 WHERE id = 1 AND revisao = ?"
  ).bind(serialized, revision).run();
  return result.meta.changes === 1;
}

async function readState(db, viewer) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await load(db);
    checkUnitAccess(current.data, viewer);
    const day = localDay();
    if (!current.data.cashRoutines.some(r => r.active && r.nextDay <= day)) return current;
    generateCashTasks(current.data, day);
    if (await persist(db, current.revision, current.data)) return { ...current, revision: current.revision + 1 };
  }
  throw new HttpError(409, "Houve outra atualização. Sincronize e tente novamente.");
}

async function body(request) {
  if (request.headers.get("Origin") !== new URL(request.url).origin) {
    throw new HttpError(403, "Origem da gravação inválida.");
  }
  if (request.headers.get("Content-Type")?.split(";")[0] !== "application/json") {
    throw new HttpError(415, "Envie dados JSON.");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "Corpo da requisição ausente.");
  let total = 0;
  let text = "";
  const parser = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES + 1024) {
      await reader.cancel();
      throw new HttpError(413, "Arquivo muito grande para o piloto.");
    }
    text += parser.decode(value, { stream: true });
  }
  try {
    const result = JSON.parse(text + parser.decode());
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
    return result;
  } catch {
    throw new HttpError(400, "Dados inválidos.");
  }
}

async function manageAccess(request, db, viewer) {
  if (viewer.role !== "office") throw new HttpError(403, "A gestão de acessos é reservada ao escritório.");
  if (request.method === "GET") {
    const { results } = await db.prepare(
      "SELECT email, perfil, unidade, ativo FROM tarefas_acessos ORDER BY email"
    ).all();
    return json({ users: results });
  }

  const { email: input, perfil, unidade, ativo, anterior } = await body(request);
  const email = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "Informe um e-mail válido.");
  }
  if (email === viewer.email) throw new HttpError(403, "Você não pode alterar seu próprio acesso.");
  if (!accessRoles.includes(perfil) || ![0, 1].includes(ativo)) {
    throw new HttpError(400, "Escolha um perfil e uma situação válidos.");
  }
  if (networkAccess(perfil) ? unidade !== null : typeof unidade !== "string" || !unidade) {
    throw new HttpError(400, "Escolha uma unidade para gestor ou colaborador.");
  }
  if (unidade !== null) {
    const { data } = await load(db);
    if (!data.units.some(unit => unit.id === unidade)) throw new HttpError(400, "Unidade não cadastrada.");
  }

  // Revalida o privilégio na própria gravação para evitar que dois administradores se desativem ao mesmo tempo.
  const authorized = "EXISTS (SELECT 1 FROM tarefas_acessos WHERE email = ? AND perfil = 'office' AND ativo = 1)";
  if (request.method === "POST") {
    const result = await db.prepare(
      `INSERT INTO tarefas_acessos (email, perfil, unidade, ativo)
       SELECT ?, ?, ?, ? WHERE ${authorized}
       ON CONFLICT(email) DO NOTHING`
    ).bind(email, perfil, unidade, ativo, viewer.email).run();
    if (!result.meta.changes) throw new HttpError(409, "Este e-mail já está cadastrado ou sua permissão mudou. Atualize a lista.");
    return json({ user: { email, perfil, unidade, ativo } }, 201);
  }

  if (!anterior || !accessRoles.includes(anterior.perfil) ||
      (anterior.unidade !== null && typeof anterior.unidade !== "string") ||
      ![0, 1].includes(anterior.ativo)) throw new HttpError(400, "Atualize a lista e reabra a edição.");
  const result = await db.prepare(
    `UPDATE tarefas_acessos SET perfil = ?, unidade = ?, ativo = ?,
         sessao_versao = sessao_versao + (ativo <> ?),
         senha_token = CASE WHEN ativo <> ? THEN NULL ELSE senha_token END,
         senha_token_expira = CASE WHEN ativo <> ? THEN NULL ELSE senha_token_expira END
     WHERE email = ? AND perfil = ? AND unidade IS ? AND ativo = ? AND ${authorized}`
  ).bind(perfil, unidade, ativo, ativo, ativo, ativo, email, anterior.perfil, anterior.unidade, anterior.ativo, viewer.email).run();
  if (!result.meta.changes) throw new HttpError(409, "O acesso foi alterado em outra sessão ou sua permissão mudou. Atualize a lista.");
  return json({ user: { email, perfil, unidade, ativo } });
}

async function writeState(request, db, viewer, taskId) {
  if (taskId === null && viewer.role !== "office") throw new HttpError(403, "Alteração reservada ao escritório.");
  const incoming = await body(request);
  if (!Number.isSafeInteger(incoming.revision)) throw new HttpError(400, "Dados ou revisão inválidos.");
  const current = await load(db);
  checkUnitAccess(current.data, viewer);
  if (incoming.revision !== current.revision) throw new HttpError(409, "Os dados mudaram. Feche a edição, sincronize e tente novamente.");
  let next = current.data;
  if (taskId === null) {
    if (incoming.importing && (next.tasks.length || next.people.length || next.departments.length)) {
      throw new HttpError(409, "O backup local só pode ser importado com o painel da rede vazio.");
    }
    try {
      next = normalize(incoming.data);
      if (incoming.importing) {
        const units = new Map(next.units.map(unit => [unit.id, unit]));
        for (const unit of current.data.units) units.set(unit.id, unit);
        next = normalize({ ...next, units: [...units.values()] });
      }
      const emails = next.people.map(person => person.email.trim().toLowerCase());
      if (emails.some(email => !email.includes("@")) || new Set(emails).size !== emails.length) throw new Error();
    } catch {
      throw new HttpError(400, "Cadastros ou tarefas inválidos. Confira as unidades, os e-mails e os vínculos.");
    }
    if (current.data.units.some(unit => !next.units.some(row => row.id === unit.id && row.store === unit.store))) {
      throw new HttpError(400, "Os códigos e tipos das unidades cadastradas precisam ser preservados.");
    }
    generateCashTasks(next, localDay());
  } else {
    const task = next.tasks.find(row => row.id === taskId);
    if (!task || !canSee(task, next, viewer)) throw new HttpError(404, "Tarefa não encontrada.");
    const { status, checklist } = incoming;
    if (!STATUSES.includes(status)) throw new HttpError(400, "Status inválido.");
    if (task.checklist) {
      if (!Array.isArray(checklist) || checklist.length !== CHECKLIST.length ||
          checklist.some(item => typeof item !== "boolean") ||
          (status === "Concluída" && !checklist.every(Boolean))) {
        throw new HttpError(400, "Confira todos os itens do checklist antes de concluir.");
      }
      task.checklist = checklist;
    } else if (checklist !== null) {
      throw new HttpError(400, "Esta tarefa não possui checklist.");
    }
    if (task.status !== status) task.completedAt = status === "Concluída" ? Date.now() : null;
    task.status = status;
  }
  if (!await persist(db, current.revision, next)) {
    throw new HttpError(409, "Os dados mudaram. Feche a edição, sincronize e tente novamente.");
  }
  return json(snapshot(next, current.revision + 1, viewer));
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      if (path === "/api/auth/mode" && request.method === "GET") {
        return json({ internal: env.AUTH_MODE === "internal" });
      }
      if (request.method === "POST" && ["/api/auth/login", "/api/auth/logout", "/api/auth/password", "/api/auth/password-link"].includes(path)) {
        return await handleAuth(request, env.DB, path, {
          body, json, HttpError, getViewer: () => getViewer(request, env), pepper: env.AUTH_PASSWORD_PEPPER
        });
      }
      const viewer = await getViewer(request, env);
      if (path === "/api/access-users" && ["GET", "POST", "PATCH"].includes(request.method)) {
        return await manageAccess(request, env.DB, viewer);
      }
      if (path === "/api/state" && request.method === "GET") {
        const current = await readState(env.DB, viewer);
        return json(snapshot(current.data, current.revision, viewer));
      }
      if (path === "/api/state" && request.method === "PUT") return await writeState(request, env.DB, viewer, null);
      const task = /^\/api\/tasks\/(\d+)$/.exec(path);
      if (task && request.method === "PATCH") return await writeState(request, env.DB, viewer, Number(task[1]));
      return json({ error: "Rota não encontrada." }, 404);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error("Falha no módulo de tarefas:", request.method, path, error?.name);
      return json({ error: "O painel não conseguiu acessar os dados da rede." }, 500);
    }
  }
};
