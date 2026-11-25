// D1-compatible subset used by worker.mjs and auth.mjs.
function encode(value) {
  if (value === null) return { type: "null" };
  if (typeof value === "string") return { type: "text", value };
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isSafeInteger(value) ? { type: "integer", value: String(value) } : { type: "float", value };
  }
  throw new TypeError("Unsupported SQL parameter");
}
function decode(cell) {
  switch (cell.type) {
    case "null": return null;
    case "integer": {
      const n = Number(cell.value);
      if (!Number.isSafeInteger(n)) throw new Error("Unsafe SQL integer");
      return n;
    }
    case "float": case "text": return cell.value;
    case "blob": return Uint8Array.from(atob(cell.base64), c => c.charCodeAt(0));
    default: throw new Error("Unexpected SQL value");
  }
}
export function selectDatabase(env, fetcher = (url, options) => fetch(url, options)) {
  const backend = env.DATABASE_BACKEND || "d1";
  if (backend === "d1") return env.DB;
  if (backend !== "turso") throw new Error("Invalid database backend");
  if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) throw new Error("Missing Turso configuration");
  const url = new URL(env.TURSO_DATABASE_URL.replace(/^libsql:/, "https:"));
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname.endsWith(".turso.io")) throw new Error("Invalid Turso URL");
  const endpoint = new URL("/v2/pipeline", url).href;
  async function execute(sql, args, wantRows) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let response, payload;
    try {
      response = await fetcher(endpoint, {
      method: "POST", redirect: "error",
      headers: { Authorization: "Bearer " + env.TURSO_AUTH_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ baton: null, requests: [
        { type: "execute", stmt: { sql, args: args.map(encode), want_rows: wantRows } },
        { type: "close" }
      ] }),
      signal: controller.signal
      });
      if (!response.ok) {
        console.error("Turso upstream HTTP status", response.status);
        throw new Error("Turso HTTP failure");
      }
      payload = await response.json();
    } catch (error) {
      console.error("Turso transport stage failed", error?.name || "Error");
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const entry = payload.results?.[0];
    if (entry?.type !== "ok" || entry.response?.type !== "execute") throw new Error("Turso SQL failed");
    const result = entry.response.result;
    const results = wantRows ? result.rows.map(row => Object.fromEntries(result.cols.map((col, i) => [col.name, decode(row[i])]))) : [];
    return { results, success: true, meta: { changes: result.affected_row_count } };
  }
  function statement(sql, args = []) {
    return {
      bind: (...values) => statement(sql, values),
      first: async (column) => {
        const { results } = await execute(sql, args, true);
        const row = results[0];
        return row ? (column === undefined ? row : row[column]) : null;
      },
      all: () => execute(sql, args, true),
      run: () => execute(sql, args, false)
    };
  }
  return { prepare: sql => statement(sql) };
}
