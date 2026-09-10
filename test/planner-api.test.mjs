import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildPlannerDiagnostic } from "../server.mjs";

// These tests exercise the row-storage asset endpoints (PLANNER_ROW_STORAGE_ENABLED=true)
// against a real Postgres database, spawned fresh per scenario (see
// fixtures/planner-api-server.mjs for why: both the flag and DATABASE_URL are
// read into module-level constants on first import, and this repo's usual
// EventEmitter req/res mock loses a race against real Postgres I/O). They
// only run when TEST_DATABASE_URL is set, so `node --test test/*.test.mjs`
// still passes everywhere without Docker/Postgres.
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const fixture = fileURLToPath(new URL("./fixtures/planner-api-server.mjs", import.meta.url));

function runScenario(name, { rowStorageEnabled = true, rowWritesEnabled = true } = {}) {
  const output = execFileSync(process.execPath, [fixture, name], {
    env: {
      ...process.env, DATABASE_URL: testDatabaseUrl,
      PLANNER_ROW_STORAGE_ENABLED: String(rowStorageEnabled),
      PLANNER_ROW_WRITES_ENABLED: String(rowWritesEnabled)
    },
    encoding: "utf8"
  });
  return JSON.parse(output.trim().split("\n").pop());
}

// Task 9: row reads/writes require a *verified* migration (a
// planner_migrations row with parity_result='ok'), not just the feature
// flag — so every test exercising the row-storage endpoints has to seed
// one, the same way a real activation would after a reviewed shadow
// migration. resetSchema() does this by default; the one test that
// specifically checks the gate itself (further below) skips seeding.
async function resetSchema({ seedVerifiedMigration = true } = {}) {
  const { default: postgres } = await import("postgres");
  const { createPlannerRepository } = await import("../lib/planner-repository.mjs");
  const sql = postgres(testDatabaseUrl, { ssl: false });
  await sql`DROP TABLE IF EXISTS planner_assets, planner_ideas, planner_settings, planner_activity, planner_changes, planner_migrations CASCADE`;
  if (seedVerifiedMigration) {
    const repository = createPlannerRepository({ sql, workspaceId: "default" });
    await repository.ensureSchema();
    await sql`
      INSERT INTO planner_migrations (id, workspace_id, source_checksum, parity_result, completed_at)
      VALUES ('test-seed', 'default', 'test-seed', 'ok', NOW())
    `;
  }
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

test("row storage reads enabled but writes not yet: the legacy whole-document PUT /api/planner endpoint is untouched", { skip: !testDatabaseUrl && "set TEST_DATABASE_URL to run against a real Postgres database" }, async () => {
  // Task 9 activation is two stages: turning on row READS (this test's
  // scenario) must not by itself retire the legacy whole-document save —
  // that only happens once PLANNER_ROW_WRITES_ENABLED is also on (covered
  // separately below).
  await resetSchema();
  const result = runScenario("legacy-planner-put-still-works", { rowWritesEnabled: false });
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

// --- Task 9: controlled activation ---

test("row reads/writes stay unavailable with both flags on until a migration's parity has actually been verified", { skip: !testDatabaseUrl && "set TEST_DATABASE_URL to run against a real Postgres database" }, async () => {
  await resetSchema({ seedVerifiedMigration: false });
  const result = runScenario("gate-requires-verified-migration");
  assert.equal(result.changesStatus, 503, "the change feed must not serve reads without a verified migration, even with the flag on");
  assert.equal(result.createStatus, 503, "writes must not be possible without a verified migration, even with the flag on");
});

test("row reads/writes work once a verified migration exists", { skip: !testDatabaseUrl && "set TEST_DATABASE_URL to run against a real Postgres database" }, async () => {
  await resetSchema({ seedVerifiedMigration: true });
  const result = runScenario("gate-requires-verified-migration");
  assert.equal(result.changesStatus, 304, "no changes yet, but the read service is now active");
  assert.equal(result.createStatus, 201);
});

test("PLANNER_ROW_WRITES_ENABLED alone (without PLANNER_ROW_STORAGE_ENABLED) does not activate writes", { skip: !testDatabaseUrl && "set TEST_DATABASE_URL to run against a real Postgres database" }, async () => {
  await resetSchema({ seedVerifiedMigration: true });
  const result = runScenario("gate-requires-verified-migration", { rowStorageEnabled: false, rowWritesEnabled: true });
  assert.equal(result.changesStatus, 503);
  assert.equal(result.createStatus, 503, "writes require the read-side service to be active too, not just their own flag");
});

test("once row writes are enabled, ordinary PUT /api/planner is rejected but an explicit Admin import still works", { skip: !testDatabaseUrl && "set TEST_DATABASE_URL to run against a real Postgres database" }, async () => {
  await resetSchema({ seedVerifiedMigration: true });
  const result = runScenario("put-planner-rejected-once-writes-enabled");
  assert.equal(result.ordinaryPut, 403);
  assert.equal(result.adminImportPut, 200);
});

test("PUT /api/planner still works normally when row writes are not enabled", { skip: !testDatabaseUrl && "set TEST_DATABASE_URL to run against a real Postgres database" }, async () => {
  await resetSchema({ seedVerifiedMigration: true });
  const result = runScenario("put-planner-rejected-once-writes-enabled", { rowWritesEnabled: false });
  assert.equal(result.ordinaryPut, 200);
});

// --- Task 10: safe operation diagnostics ---

test("buildPlannerDiagnostic contains only operation name, duration, outcome, and feature-flag state", () => {
  const startedAt = Date.now() - 42;
  const entry = buildPlannerDiagnostic({ operation: "asset.patch", startedAt, outcome: "ok" });

  assert.deepEqual(Object.keys(entry).sort(), ["durationMs", "flags", "operation", "outcome"]);
  assert.equal(entry.operation, "asset.patch");
  assert.ok(entry.durationMs >= 40, "duration should reflect real elapsed time");
  assert.equal(entry.outcome, "ok");
  assert.deepEqual(Object.keys(entry.flags).sort(), ["rowStorageEnabled", "rowWritesEnabled"]);
  assert.equal(typeof entry.flags.rowStorageEnabled, "boolean");
  assert.equal(typeof entry.flags.rowWritesEnabled, "boolean");
});

test("buildPlannerDiagnostic never carries caption/media/credential-shaped data, even if a caller tries to pass it", () => {
  // The function only accepts { operation, startedAt, outcome } — there's
  // no parameter for a request body, caption, media URL, cookie, or
  // password, so this proves there's nothing for an accidental extra
  // field to leak through, not just that today's call sites behave.
  const entry = buildPlannerDiagnostic({
    operation: "asset.patch",
    startedAt: Date.now(),
    outcome: "ok",
    // Attempt to smuggle unsafe fields in — they must be ignored.
    caption: "a very personal caption",
    body: { password: "hunter2" },
    cookie: "planner_session=secret",
    mediaUrl: "https://blob.example/private-photo.jpg"
  });

  const serialized = JSON.stringify(entry).toLowerCase();
  for (const forbidden of ["caption", "password", "cookie", "secret", "mediaurl", "photo"]) {
    assert.ok(!serialized.includes(forbidden), `diagnostic entry leaked forbidden term: ${forbidden}`);
  }
  assert.deepEqual(Object.keys(entry).sort(), ["durationMs", "flags", "operation", "outcome"]);
});
