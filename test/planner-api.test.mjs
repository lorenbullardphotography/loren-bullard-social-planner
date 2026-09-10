import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// These tests exercise the row-storage asset endpoints (PLANNER_ROW_STORAGE_ENABLED=true)
// against a real Postgres database, spawned fresh per scenario (see
// fixtures/planner-api-server.mjs for why: both the flag and DATABASE_URL are
// read into module-level constants on first import, and this repo's usual
// EventEmitter req/res mock loses a race against real Postgres I/O). They
// only run when TEST_DATABASE_URL is set, so `node --test test/*.test.mjs`
// still passes everywhere without Docker/Postgres.
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const fixture = fileURLToPath(new URL("./fixtures/planner-api-server.mjs", import.meta.url));

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

test("row storage: two simultaneous saves on different assets both persist", { skip: !testDatabaseUrl && "set TEST_DATABASE_URL to run against a real Postgres database" }, async () => {
  await resetSchema();
  const result = runScenario("concurrent-different-assets");
  assert.equal(result.patchA.status, 200);
  assert.equal(result.patchB.status, 200);
  assert.equal(result.patchA.caption, "a edited");
  assert.equal(result.patchB.caption, "b edited");
});

test("row storage: different fields on one asset merge without conflict", { skip: !testDatabaseUrl && "set TEST_DATABASE_URL to run against a real Postgres database" }, async () => {
  await resetSchema();
  const result = runScenario("different-fields-merge");
  assert.equal(result.captionPatch.status, 200);
  assert.equal(result.notesPatch.status, 200);
});

test("row storage: a stale same-field change returns ASSET_FIELD_CONFLICT with the current value", { skip: !testDatabaseUrl && "set TEST_DATABASE_URL to run against a real Postgres database" }, async () => {
  await resetSchema();
  const result = runScenario("stale-same-field-conflict");
  assert.equal(result.first.status, 200);
  assert.equal(result.stale.status, 409);
  assert.equal(result.stale.code, "ASSET_FIELD_CONFLICT");
  assert.equal(result.stale.currentCaption, "first writer wins the field");
});

test("row storage: creating then deleting an asset makes it unpatchable", { skip: !testDatabaseUrl && "set TEST_DATABASE_URL to run against a real Postgres database" }, async () => {
  await resetSchema();
  const result = runScenario("create-then-delete");
  assert.equal(result.created, 201);
  assert.equal(result.deleted.status, 200);
  assert.equal(result.deleted.ok, true);
  assert.equal(result.patchAfterDelete.status, 404);
});

test("row storage flag on: the legacy whole-document PUT /api/planner endpoint is untouched", { skip: !testDatabaseUrl && "set TEST_DATABASE_URL to run against a real Postgres database" }, async () => {
  await resetSchema();
  const result = runScenario("legacy-planner-put-still-works");
  assert.equal(result.status, 200);
});

test("row storage: saving settings does not block a concurrent asset edit", { skip: !testDatabaseUrl && "set TEST_DATABASE_URL to run against a real Postgres database" }, async () => {
  await resetSchema();
  const result = runScenario("settings-save-does-not-block-asset-edit");
  assert.equal(result.settings.status, 200);
  assert.equal(result.settings.syncPhotoCount, 20);
  assert.equal(result.asset.status, 200);
  assert.equal(result.asset.caption, "edited during settings save");
});

test("row storage: a stale settings save returns SETTINGS_CONFLICT", { skip: !testDatabaseUrl && "set TEST_DATABASE_URL to run against a real Postgres database" }, async () => {
  await resetSchema();
  const result = runScenario("settings-stale-conflict");
  assert.equal(result.first.status, 200);
  assert.equal(result.stale.status, 409);
  assert.equal(result.stale.code, "SETTINGS_CONFLICT");
});

test("row storage: an idea can be created, patched, and deleted independently", { skip: !testDatabaseUrl && "set TEST_DATABASE_URL to run against a real Postgres database" }, async () => {
  await resetSchema();
  const result = runScenario("idea-create-patch-delete");
  assert.equal(result.created.status, 201);
  assert.equal(result.created.title, "idea one");
  assert.equal(result.patched.status, 200);
  assert.equal(result.patched.title, "idea one updated");
  assert.equal(result.deleted.status, 200);
  assert.equal(result.deleted.ok, true);
  assert.equal(result.patchAfterDelete.status, 404);
});

test("row storage: a stale idea edit returns IDEA_CONFLICT", { skip: !testDatabaseUrl && "set TEST_DATABASE_URL to run against a real Postgres database" }, async () => {
  await resetSchema();
  const result = runScenario("idea-stale-conflict");
  assert.equal(result.first.status, 200);
  assert.equal(result.stale.status, 409);
  assert.equal(result.stale.code, "IDEA_CONFLICT");
});
