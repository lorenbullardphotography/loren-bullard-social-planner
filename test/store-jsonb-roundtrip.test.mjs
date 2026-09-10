import test from "node:test";
import assert from "node:assert/strict";

// Regression test for a critical bug found while building the row-storage
// migration: lib/store.mjs's direct-Postgres writeStored() used to write
// `${JSON.stringify(value)}::jsonb`. The `postgres` package's own jsonb
// parameter handling already serializes JS values passed into a jsonb
// column, so pre-stringifying double-encoded them — the column ended up
// holding a JSON *string* scalar instead of a JSON object, and every
// subsequent readStored() call silently returned that string instead of
// real data (e.g. `planner.posts` would be undefined on a string, not an
// array). This can only be exercised against a real Postgres connection —
// a fake/mock sql client can't reveal a serialization-format bug — so, like
// test/planner-repository-migration.test.mjs, it only runs when a
// disposable database is provided via TEST_DATABASE_URL.
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test("writeStored/readStored round-trip real objects through direct Postgres without double-encoding", { skip: !testDatabaseUrl && "set TEST_DATABASE_URL to run against a real Postgres database" }, async t => {
  process.env.DATABASE_URL = testDatabaseUrl;
  const store = await import(`../lib/store.mjs?t=${Date.now()}`);
  const { default: postgres } = await import("postgres");
  const sql = postgres(testDatabaseUrl, { ssl: false });
  t.after(() => sql.end({ timeout: 1 }));
  await sql`DROP TABLE IF EXISTS planner_store`;

  const value = { posts: [{ id: "x", caption: "hi" }], version: 3, nested: { a: [1, 2, 3] } };
  await store.writeStored("regression-key", value);

  const rows = await sql`SELECT value FROM planner_store WHERE key = 'regression-key'`;
  assert.equal(typeof rows[0].value, "object", "stored jsonb value must round-trip as a real object, not a JSON string");
  assert.deepEqual(rows[0].value, value);

  const readBack = await store.readStored("regression-key", null);
  assert.deepEqual(readBack, value);
  assert.ok(Array.isArray(readBack.posts), "posts must remain a real array after round-tripping through direct Postgres");

  // lib/store.mjs keeps its own internal postgres connection open for the
  // life of the process (by design, for connection reuse) and doesn't
  // expose a way to close it — harmless in the real app, which never exits,
  // but it otherwise leaves this test file's process hanging forever since
  // `node --test` runs each file in its own process. Force exit now that
  // every assertion above has already run.
  process.exit(0);
});
