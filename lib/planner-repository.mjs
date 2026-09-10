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
  }

  async function health() {
    try {
      await ensureSchema();
      return { available: true, rowSchemaReady: true, workspaceId };
    } catch {
      return { available: false, rowSchemaReady: false, workspaceId };
    }
  }

  return { ensureSchema, health };
}
