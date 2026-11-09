import { pbkdf2, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

const MINUTE = 60_000;
const SESSION_SECONDS = 8 * 60 * 60;
const COOKIE = "__Host-drogalink-tarefas";
const random = bytes => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
const tokenFormat = /^[a-f0-9]{64}$/;
const cleanEmail = value => typeof value === "string" ? value.trim().toLowerCase() : "";
const validEmail = email => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

async function digest(value) {
  return Buffer.from(await crypto.subtle.digest("SHA-256", Buffer.from(value))).toString("hex");
}

function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    pbkdf2(password, Buffer.from(salt, "hex"), 600_000, 32, "sha256", (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function sessionToken(request) {
  const value = /(?:^|;\s*)__Host-drogalink-tarefas=([^;]+)/.exec(request.headers.get("Cookie") ?? "")?.[1];
  return tokenFormat.test(value ?? "") ? value : null;
}

export async function sessionViewer(request, db) {
  const token = sessionToken(request);
  if (!token) return null;
  const row = await db.prepare(
    `SELECT a.email, a.perfil, a.unidade FROM tarefas_sessoes s
     JOIN tarefas_acessos a ON a.email = s.email
     WHERE s.token_hash = ? AND s.expira > ? AND a.ativo = 1 AND a.sessao_versao = s.versao`
  ).bind(await digest(token), Date.now()).first();
  return row && { email: row.email, role: row.perfil, unitId: row.unidade, auth: "internal" };
}

async function rateLimit(db, key, max) {
  const now = Date.now();
  await db.prepare(
    "DELETE FROM tarefas_login_limites WHERE chave IN (SELECT chave FROM tarefas_login_limites WHERE expira <= ? LIMIT 50)"
  ).bind(now).run();
  const result = await db.prepare(
    `INSERT INTO tarefas_login_limites (chave, expira, tentativas) VALUES (?, ?, 1)
     ON CONFLICT(chave) DO UPDATE SET
       tentativas = CASE WHEN expira <= ? THEN 1 ELSE tentativas + 1 END,
       expira = CASE WHEN expira <= ? THEN excluded.expira ELSE expira END
     WHERE expira <= ? OR tentativas < ?`
  ).bind(await digest(key), now + 15 * MINUTE, now, now, now, max).run();
  return result.meta.changes > 0;
}

function withCookie(json, token, age) {
  const response = json({ ok: true });
  response.headers.set("Set-Cookie", `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${age}`);
  return response;
}

export async function handleAuth(request, db, path, { body, json, HttpError, getViewer }) {
  const input = await body(request);
  if (path === "/api/auth/logout") {
    const token = sessionToken(request);
    if (token) await db.prepare("DELETE FROM tarefas_sessoes WHERE token_hash = ?").bind(await digest(token)).run();
    return withCookie(json, "", 0);
  }

  if (path === "/api/auth/password-link") {
    const viewer = await getViewer();
    if (viewer.role !== "office") throw new HttpError(403, "A gestão de acessos é reservada ao escritório.");
    const email = cleanEmail(input.email);
    if (!validEmail(email)) throw new HttpError(400, "Informe um e-mail válido.");
    const token = random(32);
    const result = await db.prepare(
      `UPDATE tarefas_acessos SET senha_token = ?, senha_token_expira = ?
       WHERE email = ? AND ativo = 1
       AND EXISTS (SELECT 1 FROM tarefas_acessos WHERE email = ? AND ativo = 1 AND perfil = 'office')`
    ).bind(await digest(token), Date.now() + 60 * MINUTE, email, viewer.email).run();
    if (!result.meta.changes) throw new HttpError(404, "O acesso precisa estar ativo para gerar um link.");
    return json({ token });
  }

  const ip = request.headers.get("CF-Connecting-IP") ?? "local";
  if (!await rateLimit(db, `${path}:ip:${ip}`, 30)) {
    throw new HttpError(429, "Muitas tentativas. Aguarde até 15 minutos.");
  }

  const password = input.password;
  if (typeof password !== "string" || password.length > 128 || !password.length) {
    throw new HttpError(400, "Informe uma senha válida de até 128 caracteres.");
  }

  if (path === "/api/auth/password") {
    if (password.length < 10) throw new HttpError(400, "Use pelo menos 10 caracteres.");
    const token = typeof input.token === "string" ? input.token : "";
    if (!tokenFormat.test(token)) throw new HttpError(400, "Link inválido ou expirado.");
    const tokenHash = await digest(token);
    const account = await db.prepare(
      "SELECT email FROM tarefas_acessos WHERE senha_token = ? AND senha_token_expira > ? AND ativo = 1"
    ).bind(tokenHash, Date.now()).first();
    if (!account) throw new HttpError(400, "Link inválido ou expirado.");
    const salt = random(16);
    const hash = (await hashPassword(password, salt)).toString("hex");
    const result = await db.prepare(
      `UPDATE tarefas_acessos SET senha_hash = ?, senha_salt = ?, senha_token = NULL, senha_token_expira = NULL,
         sessao_versao = sessao_versao + 1
       WHERE email = ? AND senha_token = ? AND senha_token_expira > ? AND ativo = 1`
    ).bind(hash, salt, account.email, tokenHash, Date.now()).run();
    if (!result.meta.changes) throw new HttpError(400, "Link inválido ou expirado.");
    return json({ ok: true });
  }

  const email = cleanEmail(input.email);
  if (!validEmail(email)) throw new HttpError(401, "E-mail ou senha inválidos.");
  const limit = `login:email:${email}`;
  if (!await rateLimit(db, limit, 8)) throw new HttpError(429, "Muitas tentativas. Aguarde até 15 minutos.");
  const row = await db.prepare(
    "SELECT senha_hash, senha_salt, sessao_versao FROM tarefas_acessos WHERE email = ? AND ativo = 1"
  ).bind(email).first();
  const hash = await hashPassword(password, row?.senha_salt ?? "0".repeat(32));
  const matches = timingSafeEqual(hash, Buffer.from(row?.senha_hash ?? "0".repeat(64), "hex"));
  if (!matches || !row?.senha_hash) throw new HttpError(401, "E-mail ou senha inválidos.");
  const now = Date.now();
  await db.prepare(
    "DELETE FROM tarefas_sessoes WHERE token_hash IN (SELECT token_hash FROM tarefas_sessoes WHERE expira <= ? LIMIT 50)"
  ).bind(now).run();
  const token = random(32);
  const result = await db.prepare(
    `INSERT INTO tarefas_sessoes (token_hash, email, versao, expira)
     SELECT ?, email, sessao_versao, ? FROM tarefas_acessos WHERE email = ? AND ativo = 1 AND sessao_versao = ?`
  ).bind(await digest(token), now + SESSION_SECONDS * 1000, email, row.sessao_versao).run();
  if (!result.meta.changes) throw new HttpError(401, "E-mail ou senha inválidos.");
  await db.prepare("DELETE FROM tarefas_login_limites WHERE chave = ?").bind(await digest(limit)).run();
  return withCookie(json, token, SESSION_SECONDS);
}
