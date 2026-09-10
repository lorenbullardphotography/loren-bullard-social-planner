import test from "node:test";
import assert from "node:assert/strict";
import { createPlannerRepository } from "../lib/planner-repository.mjs";

function createRecordingSql() {
  const statements = [];
  function sql(strings, ...values) {
    // Reconstruct the SQL text the same way the real `postgres` tagged
    // template would receive it, so assertions can match on plain text.
    const text = strings.reduce((acc, part, i) => acc + part + (i < values.length ? String(values[i]) : ""), "");
    statements.push(text);
    return Promise.resolve([]);
  }
  sql.statements = statements;
  return sql;
}

test("ensureSchema creates all planner row tables", async () => {
  const sql = createRecordingSql();
  const repository = createPlannerRepository({ sql, workspaceId: "default" });

  await repository.ensureSchema();

  const combined = sql.statements.join("\n---\n");
  for (const table of [
    "planner_assets",
    "planner_ideas",
    "planner_settings",
    "planner_activity",
    "planner_changes",
    "planner_migrations"
  ]) {
    assert.match(
      combined,
      new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`),
      `expected a CREATE TABLE IF NOT EXISTS statement for ${table}`
    );
  }
});

test("ensureSchema creates the active-order and change-feed indexes", async () => {
  const sql = createRecordingSql();
  const repository = createPlannerRepository({ sql, workspaceId: "default" });

  await repository.ensureSchema();

  const combined = sql.statements.join("\n---\n");

  // Active asset ordering: partial index on (workspace_id, sort_key) where not deleted.
  assert.match(combined, /CREATE INDEX IF NOT EXISTS \w+\s+ON planner_assets\s*\(workspace_id,\s*sort_key\)\s*WHERE deleted_at IS NULL/i);

  // Active ideas: partial index on planner_ideas where not deleted.
  assert.match(combined, /CREATE INDEX IF NOT EXISTS \w+\s+ON planner_ideas\s*\([^)]*\)\s*WHERE deleted_at IS NULL/i);

  // Change feed: index on planner_changes by (workspace_id, sequence).
  assert.match(combined, /CREATE INDEX IF NOT EXISTS \w+\s+ON planner_changes\s*\(workspace_id,\s*sequence\)/i);

  // Activity by workspace/date.
  assert.match(combined, /CREATE INDEX IF NOT EXISTS \w+\s+ON planner_activity\s*\(workspace_id,\s*created_at\)/i);
});

test("ensureSchema never touches the legacy planner_store table", async () => {
  const sql = createRecordingSql();
  const repository = createPlannerRepository({ sql, workspaceId: "default" });

  await repository.ensureSchema();

  const combined = sql.statements.join("\n---\n");
  assert.doesNotMatch(combined, /planner_store/);
});

test("ensureSchema is idempotent: calling twice issues the same additive statements", async () => {
  const sql = createRecordingSql();
  const repository = createPlannerRepository({ sql, workspaceId: "default" });

  await repository.ensureSchema();
  const firstRun = [...sql.statements];
  sql.statements.length = 0;
  await repository.ensureSchema();

  assert.deepEqual(sql.statements, firstRun);
  for (const statement of firstRun) {
    assert.ok(
      /IF NOT EXISTS/.test(statement),
      `expected every schema statement to be additive (IF NOT EXISTS): ${statement}`
    );
  }
});

test("health() reports schema readiness when Postgres is available", async () => {
  const sql = createRecordingSql();
  const repository = createPlannerRepository({ sql, workspaceId: "default" });

  const result = await repository.health();
  assert.equal(result.rowSchemaReady, true);
  assert.equal(result.available, true);
});

test("createPlannerRepository requires a real sql client and never falls back silently", () => {
  assert.throws(() => createPlannerRepository({ sql: null, workspaceId: "default" }));
});

test("health() returns a safe service-unavailable result instead of throwing when Postgres errors", async () => {
  async function failingSql() {
    throw new Error("connection refused");
  }
  const repository = createPlannerRepository({ sql: failingSql, workspaceId: "default" });

  const result = await repository.health();
  assert.equal(result.available, false);
  assert.equal(result.rowSchemaReady, false);
});
