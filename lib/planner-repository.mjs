// Row-based planner storage: schema management, transactions, reads, and the
// change feed for one-row-per-asset/idea collaboration. This module owns all
// planner_* row tables and never touches the legacy `planner_store` document
// table defined in lib/store.mjs.
//
// Task 2 scope: schema creation (ensureSchema) and a read-only readiness
// check (health). Migration from the legacy document, mutation endpoints,
// and reads/writes of individual rows are implemented in later tasks.

const DEFAULT_WORKSPACE_ID = "default";

export function createPlannerRepository({ sql, workspaceId = DEFAULT_WORKSPACE_ID } = {}) {
  if (typeof sql !== "function") {
    throw new Error("createPlannerRepository requires a direct Postgres `sql` client; the Supabase REST path is not supported for row storage.");
  }

  // workspaceId is accepted (and echoed back by health()) but not otherwise
  // used yet: every DDL statement below is static/unscoped, and no caller
  // passes a non-default workspaceId today. Later tasks (Task 3+) that add
  // per-row query methods will scope their queries with it.

  // Set once ensureSchema() has succeeded, so health() (called on every
  // GET /api/health/storage request) can skip re-issuing the full DDL batch
  // after the first successful run. ensureSchema() itself stays callable
  // and idempotent on its own for explicit/repeated invocation.
  let schemaReady = false;

  // Every statement is additive (CREATE ... IF NOT EXISTS) so it is always
  // safe to re-run ensureSchema, including on every health check.
  const schemaStatements = [
    () => sql`CREATE TABLE IF NOT EXISTS planner_assets (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'default',
      data JSONB NOT NULL,
      sort_key NUMERIC(30,15) NOT NULL DEFAULT 0,
      revision BIGINT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      changed_sequence BIGINT,
      deleted_at TIMESTAMPTZ
    )`,
    () => sql`CREATE TABLE IF NOT EXISTS planner_ideas (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'default',
      data JSONB NOT NULL,
      revision BIGINT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      changed_sequence BIGINT,
      deleted_at TIMESTAMPTZ
    )`,
    () => sql`CREATE TABLE IF NOT EXISTS planner_settings (
      workspace_id TEXT PRIMARY KEY DEFAULT 'default',
      data JSONB NOT NULL,
      revision BIGINT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      changed_sequence BIGINT
    )`,
    () => sql`CREATE TABLE IF NOT EXISTS planner_activity (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'default',
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      actor TEXT,
      summary TEXT NOT NULL,
      entity_revision BIGINT,
      changed_sequence BIGINT,
      undo_payload JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    // Cursor-visibility caveat for whoever implements Task 7's change-feed
    // polling endpoint (GET /api/planner/changes?since=sequence): `sequence`
    // is a Postgres IDENTITY column, and under MVCC transactions can commit
    // out of order relative to when their identity value was assigned — a
    // row with sequence 105 can become visible to readers before a
    // concurrently-open transaction's row with sequence 104 commits. A naive
    // `WHERE sequence > lastSeen` query is vulnerable to permanently
    // skipping row 104 if a client already observed 105. Not addressed here
    // (no polling logic exists yet in this task) — just flagging it so it
    // isn't rediscovered from scratch later.
    () => sql`CREATE TABLE IF NOT EXISTS planner_changes (
      sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'default',
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      entity_revision BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    () => sql`CREATE TABLE IF NOT EXISTS planner_migrations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'default',
      source_checksum TEXT,
      source_count INTEGER,
      destination_count INTEGER,
      parity_result TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )`,
    () => sql`CREATE INDEX IF NOT EXISTS planner_assets_active_order_idx
      ON planner_assets (workspace_id, sort_key)
      WHERE deleted_at IS NULL`,
    () => sql`CREATE INDEX IF NOT EXISTS planner_ideas_active_idx
      ON planner_ideas (workspace_id, created_at)
      WHERE deleted_at IS NULL`,
    () => sql`CREATE INDEX IF NOT EXISTS planner_changes_workspace_sequence_idx
      ON planner_changes (workspace_id, sequence)`,
    () => sql`CREATE INDEX IF NOT EXISTS planner_activity_workspace_created_idx
      ON planner_activity (workspace_id, created_at)`
  ];

  async function ensureSchema() {
    for (const runStatement of schemaStatements) {
      await runStatement();
    }
    schemaReady = true;
  }

  async function health() {
    // Once the schema is confirmed ready, skip re-running the DDL batch on
    // every call — GET /api/health/storage calls health() on every request,
    // and re-issuing 10 CREATE TABLE/INDEX IF NOT EXISTS statements per
    // request is unnecessary load once we already know it's ready.
    if (schemaReady) {
      return { available: true, rowSchemaReady: true, workspaceId };
    }
    try {
      await ensureSchema();
      return { available: true, rowSchemaReady: true, workspaceId };
    } catch {
      return { available: false, rowSchemaReady: false, workspaceId };
    }
  }

  return { ensureSchema, health };
}
