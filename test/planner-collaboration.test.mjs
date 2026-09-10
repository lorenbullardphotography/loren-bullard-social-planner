import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Reorder correctness (fractional sort keys, re-spacing, transactional
// locking) depends on real Postgres query results, so — like
// planner-migration.test.mjs and planner-api.test.mjs — these tests only
// run when TEST_DATABASE_URL points at a real disposable database. They
// spawn a fresh child process per scenario (see
// fixtures/planner-collaboration-server.mjs) rather than reusing a mock
// req/res in-process, for the same reasons documented there.
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const fixture = fileURLToPath(new URL("./fixtures/planner-collaboration-server.mjs", import.meta.url));

function runScenario(name) {
  const output = execFileSync(process.execPath, [fixture, name], {
    env: { ...process.env, DATABASE_URL: testDatabaseUrl, PLANNER_ROW_STORAGE_ENABLED: "true" },
    encoding: "utf8"
  });
  return JSON.parse(output.trim().split("\n").pop());
}

async function resetSchema() {
  const { default: postgres } = await import("postgres");
  const sql = postgres(testDatabaseUrl, { ssl: false });
  await sql`DROP TABLE IF EXISTS planner_assets, planner_ideas, planner_settings, planner_activity, planner_changes, planner_migrations CASCADE`;
  await sql.end({ timeout: 1 });
}

test("reordering one asset does not block a concurrent edit on another (no planner-wide 409)", { skip: !testDatabaseUrl && "set TEST_DATABASE_URL to run against a real Postgres database" }, async () => {
  await resetSchema();
  const result = runScenario("reorder-does-not-block-concurrent-edit");
  assert.equal(result.reorder.status, 200);
  assert.equal(result.patch.status, 200);
  assert.equal(result.patch.caption, "b edited concurrently");
});

test("an asset can be moved to the very start and the very end of the grid", { skip: !testDatabaseUrl && "set TEST_DATABASE_URL to run against a real Postgres database" }, async () => {
  await resetSchema();
  const result = runScenario("move-to-start-and-end");
  assert.equal(result.moveStart.status, 200);
  assert.equal(result.moveEnd.status, 200);
});

test("repeatedly bisecting a gap triggers a re-space and returns every affected asset", { skip: !testDatabaseUrl && "set TEST_DATABASE_URL to run against a real Postgres database" }, async () => {
  await resetSchema();
  const result = runScenario("respace-on-shrinking-gap");
  assert.equal(result.status, 200);
  assert.ok(result.affectedCount > 1, `expected a re-space to report more than one affected asset, got ${result.affectedCount}`);
});

test("reordering next to a neighbor removed by a teammate returns a retryable conflict, not a 404 for the moved asset", { skip: !testDatabaseUrl && "set TEST_DATABASE_URL to run against a real Postgres database" }, async () => {
  await resetSchema();
  const result = runScenario("reorder-missing-neighbor-conflict");
  assert.equal(result.status, 409);
});

test("GET /api/planner/changes returns only entities changed since the given token, then 304s at the new token", { skip: !testDatabaseUrl && "set TEST_DATABASE_URL to run against a real Postgres database" }, async () => {
  await resetSchema();
  const result = runScenario("change-feed");
  assert.equal(result.initialStatus, 304, "an empty planner has no changes yet, so the very first poll should 304");
  assert.equal(result.afterMutationsStatus, 200);
  assert.equal(result.changeCount, 2, "only the two touched assets should be reported, not unrelated state");
  assert.equal(result.aDeleted, false);
  assert.equal(result.aCaption, "a edited");
  assert.equal(result.bDeleted, true);
  assert.equal(result.bData, null, "a deleted entity should come back as a tombstone with no data");
  assert.equal(result.noChangeStatus, 304, "polling again at the token just returned should report no new changes");
});
