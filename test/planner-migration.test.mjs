import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createPlannerRepository } from "../lib/planner-repository.mjs";
import { setupIsolatedDataDir } from "./fixtures/isolated-data-dir.mjs";

setupIsolatedDataDir();
const { handleRequest } = await import("../server.mjs");

function createMockReqRes({ method = "GET", url = "/", headers = {}, body = null }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost:8787", ...headers };
  const res = {
    statusCode: 200, headers: {}, body: "",
    writeHead(status, headers = {}) { this.statusCode = status; this.headers = { ...this.headers, ...headers }; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(chunk = "") { this.body += chunk; }
  };
  process.nextTick(() => {
    if (body !== null) req.emit("data", typeof body === "string" ? body : JSON.stringify(body));
    req.emit("end");
  });
  return { req, res };
}

async function signIn(login, password) {
  const attempt = createMockReqRes({ method: "POST", url: "/auth/login", body: { login, password } });
  await handleRequest(attempt.req, attempt.res);
  return { cookie: attempt.res.headers["set-cookie"]?.split(";")[0] || "", status: attempt.res.statusCode };
}

// Each test file gets its own isolated .data directory (see
// setupIsolatedDataDir above), but within this file "Loren" is still a
// shared seeded account across tests — create fresh, uniquely-named
// accounts with known roles for each case instead of assuming any
// existing account's role.
async function signInAs(role) {
  const bootstrap = await signIn("Loren", "admin");
  const name = `Migration Test ${role} ${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const password = "testpassword123";
  const add = createMockReqRes({
    method: "POST", url: "/api/team/members", headers: { cookie: bootstrap.cookie },
    body: { name, role, password }
  });
  await handleRequest(add.req, add.res);
  assert.equal(add.res.statusCode, 201, `expected creating a ${role} test account to succeed`);
  return signIn(name, password);
}

test("POST /api/admin/planner-row-migration requires authentication", async () => {
  const { req, res } = createMockReqRes({ method: "POST", url: "/api/admin/planner-row-migration", body: { mode: "shadow" } });
  await handleRequest(req, res);
  assert.equal(res.statusCode, 401);
});

test("POST /api/admin/planner-row-migration rejects a non-Admin account", async () => {
  const { cookie } = await signInAs("Editor");
  const { req, res } = createMockReqRes({
    method: "POST", url: "/api/admin/planner-row-migration",
    headers: { cookie }, body: { mode: "shadow" }
  });
  await handleRequest(req, res);
  assert.equal(res.statusCode, 403);
});

test("POST /api/admin/planner-row-migration rejects an unsupported mode", async () => {
  const { cookie } = await signInAs("Admin");
  const { req, res } = createMockReqRes({
    method: "POST", url: "/api/admin/planner-row-migration",
    headers: { cookie }, body: { mode: "live" }
  });
  await handleRequest(req, res);
  assert.equal(res.statusCode, 400);
});

test("POST /api/admin/planner-row-migration reports 503 when direct Postgres isn't configured", async () => {
  const { cookie } = await signInAs("Admin");
  const { req, res } = createMockReqRes({
    method: "POST", url: "/api/admin/planner-row-migration",
    headers: { cookie }, body: { mode: "shadow" }
  });
  await handleRequest(req, res);
  // No DATABASE_URL/POSTGRES_URL is configured in this test environment.
  assert.equal(res.statusCode, 503);
});

// These tests exercise migrateLegacyPlanner/compareLegacyPlanner against a
// real Postgres database, because their correctness depends on actual query
// results (transactions, RETURNING, read-back comparisons) that a text-only
// fake sql recorder can't meaningfully simulate. They only run when a
// disposable test database is provided via TEST_DATABASE_URL, so the normal
// `node --test test/*.test.mjs` run (no Docker/Postgres required) still
// passes everywhere without it — this file is additional local/CI-with-db
// coverage, not part of the baseline suite's requirements.
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test("migrateLegacyPlanner and compareLegacyPlanner (real Postgres)", { skip: !testDatabaseUrl && "set TEST_DATABASE_URL to run against a real Postgres database" }, async t => {
  const { default: postgres } = await import("postgres");
  const sql = postgres(testDatabaseUrl, { ssl: false });
  t.after(() => sql.end({ timeout: 1 }));

  async function freshRepository() {
    await sql`DROP TABLE IF EXISTS planner_assets, planner_ideas, planner_settings, planner_activity, planner_changes, planner_migrations CASCADE`;
    const repository = createPlannerRepository({ sql, workspaceId: "default" });
    await repository.ensureSchema();
    return repository;
  }

  const legacyPlanner = {
    posts: [
      { id: "a1", status: "planned", revision: 2, caption: "first planned", updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "a2", status: "draft", revision: 1, caption: "second planned", updatedAt: "2026-01-02T00:00:00.000Z" },
      { id: "a3", status: "posted", revision: 3, caption: "posted one", updatedAt: "2026-01-03T00:00:00.000Z" }
    ],
    scratch: [
      { id: "i1", title: "idea one", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }
    ],
    activity: [
      { id: "act1", text: "Someone did something", at: "2026-01-01T00:00:00.000Z" }
    ],
    settings: { pillars: ["A", "B"], syncPhotoCount: 12 }
  };

  await t.test("migrates every asset, idea, and settings row, preserving planned-then-posted order", async () => {
    const repository = await freshRepository();
    const result = await repository.migrateLegacyPlanner(legacyPlanner);
    assert.equal(result.alreadyMigrated, false);
    assert.equal(result.sourceCount, 4); // 3 assets + 1 idea
    assert.equal(result.destinationCount, 4);

    const assetRows = await sql`SELECT id, sort_key FROM planner_assets ORDER BY sort_key ASC`;
    assert.deepEqual(assetRows.map(r => r.id), ["a1", "a2", "a3"]); // planned (a1, a2) before posted (a3)

    const ideaRows = await sql`SELECT id FROM planner_ideas`;
    assert.deepEqual(ideaRows.map(r => r.id), ["i1"]);

    const [settingsRow] = await sql`SELECT data FROM planner_settings WHERE workspace_id = 'default'`;
    assert.deepEqual(settingsRow.data, legacyPlanner.settings);

    const activityRows = await sql`SELECT id, summary FROM planner_activity`;
    assert.deepEqual(activityRows.map(r => r.id), ["act1"]);

    const changeRows = await sql`SELECT entity_id, operation FROM planner_changes ORDER BY sequence ASC`;
    assert.equal(changeRows.length, 4); // one change event per migrated asset/idea, not per activity row
  });

  await t.test("listActiveNonPostedAssets excludes posted assets - GET /api/planner's only caller always sources those from the legacy document instead", async () => {
    // Regression test for a Shared Pooler Egress contributor: GET
    // /api/planner discards row storage's "posted" assets in favor of the
    // legacy document's copy of them (see server.mjs), so fetching them
    // from row storage at all was wasted transfer - in real production
    // data, the vast majority of rows (~980 published Instagram posts vs.
    // ~30-70 active drafts).
    const repository = await freshRepository();
    await repository.migrateLegacyPlanner(legacyPlanner);
    const nonPosted = await repository.listActiveNonPostedAssets();
    assert.deepEqual(nonPosted.map(post => post.id).sort(), ["a1", "a2"]);
    assert.ok(!nonPosted.some(post => post.status === "posted"));
  });

  await t.test("re-running migration with the same source is idempotent (no duplicate rows or change events)", async () => {
    const repository = await freshRepository();
    await repository.migrateLegacyPlanner(legacyPlanner);
    const second = await repository.migrateLegacyPlanner(legacyPlanner);
    assert.equal(second.alreadyMigrated, true);

    const assetCount = await sql`SELECT COUNT(*)::int AS n FROM planner_assets`;
    assert.equal(assetCount[0].n, 3);
    const changeCount = await sql`SELECT COUNT(*)::int AS n FROM planner_changes`;
    assert.equal(changeCount[0].n, 4);
  });

  await t.test("compareLegacyPlanner reports ok with no mismatches after a clean migration", async () => {
    const repository = await freshRepository();
    await repository.migrateLegacyPlanner(legacyPlanner);
    const report = await repository.compareLegacyPlanner(legacyPlanner);
    assert.equal(report.ok, true);
    assert.deepEqual(report.mismatches, []);
  });

  await t.test("compareLegacyPlanner detects a field-level mismatch introduced after migration", async () => {
    const repository = await freshRepository();
    await repository.migrateLegacyPlanner(legacyPlanner);
    await sql`UPDATE planner_assets SET data = jsonb_set(data, '{caption}', '"tampered"') WHERE id = 'a1'`;

    const report = await repository.compareLegacyPlanner(legacyPlanner);
    assert.equal(report.ok, false);
    const captionMismatch = report.mismatches.find(m => m.type === "fields" && m.id === "a1");
    assert.ok(captionMismatch, "expected a field mismatch for asset a1");
    assert.equal(captionMismatch.fields.caption.expected, "first planned");
    assert.equal(captionMismatch.fields.caption.actual, "tampered");
  });

  await t.test("compareLegacyPlanner detects a missing row", async () => {
    const repository = await freshRepository();
    await repository.migrateLegacyPlanner(legacyPlanner);
    await sql`DELETE FROM planner_assets WHERE id = 'a2'`;

    const report = await repository.compareLegacyPlanner(legacyPlanner);
    assert.equal(report.ok, false);
    assert.ok(report.mismatches.some(m => m.type === "missing" && m.id === "a2"));
    assert.ok(report.mismatches.some(m => m.type === "count" && m.entity === "assets"));
  });

  await t.test("compareLegacyPlanner ignores server-timestamp differences", async () => {
    const repository = await freshRepository();
    await repository.migrateLegacyPlanner(legacyPlanner);
    await sql`UPDATE planner_assets SET data = jsonb_set(data, '{updatedAt}', '"2099-01-01T00:00:00.000Z"') WHERE id = 'a1'`;

    const report = await repository.compareLegacyPlanner(legacyPlanner);
    assert.equal(report.ok, true);
  });

  // Found by running this migration against real production data: history
  // predating this app's crypto.randomUUID()-always convention for
  // activity ids included entries with no id at all. A plain INSERT with
  // an undefined id crashes the postgres driver outright (it rejects
  // undefined parameters), and even once that's fixed, comparing an
  // id-less source entry by id against the migrated set (which always has
  // a real id) would report a false "missing" mismatch on every clean run.
  await t.test("migrates and correctly verifies parity for legacy activity entries with no id", async () => {
    const repository = await freshRepository();
    const plannerWithIdlessActivity = {
      ...legacyPlanner,
      activity: [
        { id: undefined, text: "an entry from before ids were mandatory", at: "2020-01-01T00:00:00.000Z" },
        { text: "another id-less entry, same shape", at: "2020-01-02T00:00:00.000Z" },
        ...legacyPlanner.activity
      ]
    };

    const migration = await repository.migrateLegacyPlanner(plannerWithIdlessActivity);
    assert.equal(migration.alreadyMigrated, false);

    const activityRows = await sql`SELECT id, summary FROM planner_activity`;
    assert.equal(activityRows.length, 3, "both id-less entries and the one normal entry should all be present");
    assert.ok(activityRows.every(row => typeof row.id === "string" && row.id.length > 0), "every migrated row must have a real generated id even when the source had none");

    const report = await repository.compareLegacyPlanner(plannerWithIdlessActivity);
    assert.equal(report.ok, true, `expected clean parity, got: ${JSON.stringify(report.mismatches)}`);
    assert.deepEqual(report.mismatches, []);
  });
});

test("POST /api/admin/planner-row-migration succeeds end-to-end against a real Postgres database", { skip: !testDatabaseUrl && "set TEST_DATABASE_URL to run against a real Postgres database" }, async () => {
  const { default: postgres } = await import("postgres");
  const sql = postgres(testDatabaseUrl, { ssl: false });
  await sql`DROP TABLE IF EXISTS planner_assets, planner_ideas, planner_settings, planner_activity, planner_changes, planner_migrations, planner_store CASCADE`;
  await sql.end({ timeout: 1 });

  // Run in a fresh child process (see fixtures/run-migration-e2e.mjs) rather
  // than a same-process dynamic import, since lib/store.mjs's DATABASE_URL
  // handling is fixed at first import and can't be changed mid-process.
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const output = execFileSync(process.execPath, [fileURLToPath(new URL("./fixtures/run-migration-e2e.mjs", import.meta.url))], {
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
    encoding: "utf8"
  });
  // Parse only the last line: ensureSchema()'s CREATE TABLE/INDEX IF NOT
  // EXISTS statements print a harmless Postgres NOTICE to stdout whenever
  // the schema already exists from an earlier run (nothing drops
  // planner_assets et al. between arbitrary local/manual runs of this
  // file), which would otherwise corrupt a parse of the full captured
  // output.
  const result = JSON.parse(output.trim().split("\n").pop());
  assert.equal(result.statusCode, 200, `expected 200, got ${result.statusCode}: ${result.body}`);
  const data = JSON.parse(result.body);
  assert.equal(data.migration.alreadyMigrated, false);
  assert.equal(data.parity.ok, true);
  assert.deepEqual(data.parity.mismatches, []);
});
