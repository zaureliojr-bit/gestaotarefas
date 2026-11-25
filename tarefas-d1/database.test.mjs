import { test } from "node:test";
import assert from "node:assert/strict";
import { selectDatabase } from "./database.mjs";
test("D1 remains default even with Turso credentials", () => {
  const DB = {};
  assert.equal(selectDatabase({ DB, TURSO_AUTH_TOKEN: "fake" }), DB);
});
test("Turso requires explicit backend and credentials", () => {
  assert.throws(() => selectDatabase({ DATABASE_BACKEND: "turso" }));
});
test("adapter binds parameters and returns D1-compatible results", async () => {
  const env = { DATABASE_BACKEND: "turso", TURSO_DATABASE_URL: "libsql://example.turso.io", TURSO_AUTH_TOKEN: "fake" };
  const db = selectDatabase(env, async (url, options) => {
    assert.equal(url, "https://example.turso.io/v2/pipeline");
    assert.equal(options.headers.Authorization, "Bearer fake");
    const { requests } = JSON.parse(options.body);
    assert.deepEqual(requests[0].stmt.args, [{ type: "integer", value: "1" }, { type: "text", value: "x" }, { type: "null" }]);
    assert.equal(requests[1].type, "close");
    return Response.json({ results: [{ type: "ok", response: { type: "execute", result: { cols: [{ name: "id" }], rows: requests[0].stmt.want_rows ? [[{ type: "integer", value: "1" }]] : [], affected_row_count: 1 } } }] });
  });
  const stmt = db.prepare("test").bind(1, "x", null);
  assert.deepEqual(await stmt.first(), { id: 1 });
  assert.equal(await stmt.first("id"), 1);
  assert.deepEqual((await stmt.all()).results, [{ id: 1 }]);
  assert.equal((await stmt.run()).meta.changes, 1);
});
test("remote errors never fall back to D1", async () => {
  const db = selectDatabase({ DATABASE_BACKEND: "turso", TURSO_DATABASE_URL: "libsql://example.turso.io", TURSO_AUTH_TOKEN: "fake" }, async () => new Response("", { status: 503 }));
  await assert.rejects(db.prepare("SELECT 1").first(), /503/);
});

test("Workers-compatible redirect mode rejects redirects without forwarding token", async () => {
  const db = selectDatabase({ DATABASE_BACKEND: "turso", TURSO_DATABASE_URL: "libsql://example.turso.io", TURSO_AUTH_TOKEN: "fake" }, async (url, options) => {
    assert.equal(options.redirect, "manual");
    return new Response(null, { status: 302, headers: { Location: "https://example.com" } });
  });
  await assert.rejects(db.prepare("SELECT 1").first(), /302/);
});
