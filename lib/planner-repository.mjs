// Row-based planner storage: schema management, transactions, reads, and the
// change feed for one-row-per-asset/idea collaboration. This module owns all
// planner_* row tables and never touches the legacy `planner_store` document
// table defined in lib/store.mjs.

import crypto from "node:crypto";

const DEFAULT_WORKSPACE_ID = "default";

function checksumOf(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// Fields that legitimately vary between the legacy source and a migrated row
// without indicating a real mismatch (server-assigned timestamps).
const PARITY_IGNORED_ASSET_FIELDS = new Set(["updatedAt"]);
const PARITY_IGNORED_IDEA_FIELDS = new Set(["updatedAt", "createdAt"]);

// Postgres jsonb does not preserve object key insertion order, so a plain
// JSON.stringify comparison would report a false mismatch for two
// semantically-identical objects whose keys merely round-tripped in a
// different order. Canonicalize by sorting object keys recursively before
// comparing (array order is preserved and still significant).
function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJson(value[key])]));
  }
  return value;
}

function diffFields(sourceObj, storedObj, ignoredFields) {
  const diffs = {};
  const keys = new Set([...Object.keys(sourceObj || {}), ...Object.keys(storedObj || {})]);
  for (const key of keys) {
    if (ignoredFields.has(key)) continue;
    if (JSON.stringify(canonicalJson(sourceObj?.[key])) !== JSON.stringify(canonicalJson(storedObj?.[key]))) {
      diffs[key] = { expected: sourceObj?.[key], actual: storedObj?.[key] };
    }
  }
  return diffs;
}

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

  // Splits legacy posts the way migrateLegacyPlanner lays them out: planned
  // assets first (in their current order), then posted assets (in their
  // current order), each block getting sequential sort keys 1024 apart.
  function orderedLegacyAssets(posts) {
    const planned = posts.filter(post => post.status !== "posted");
    const posted = posts.filter(post => post.status === "posted");
    return [...planned, ...posted];
  }

  async function migrateLegacyPlanner(legacyPlanner) {
    await ensureSchema();
    const posts = Array.isArray(legacyPlanner?.posts) ? legacyPlanner.posts : [];
    const scratch = Array.isArray(legacyPlanner?.scratch) ? legacyPlanner.scratch : [];
    const activity = Array.isArray(legacyPlanner?.activity) ? legacyPlanner.activity : [];
    const settings = legacyPlanner?.settings || {};
    const checksum = checksumOf({ posts, scratch, activity, settings });

    const [existing] = await sql`
      SELECT * FROM planner_migrations WHERE id = ${checksum} AND completed_at IS NOT NULL
    `;
    if (existing) {
      return {
        alreadyMigrated: true,
        checksum,
        sourceCount: existing.source_count,
        destinationCount: existing.destination_count
      };
    }

    const orderedAssets = orderedLegacyAssets(posts);
    const sourceCount = orderedAssets.length + scratch.length;

    const destinationCount = await sql.begin(async sqlTx => {
      await sqlTx`
        INSERT INTO planner_migrations (id, workspace_id, source_checksum, source_count)
        VALUES (${checksum}, ${workspaceId}, ${checksum}, ${sourceCount})
        ON CONFLICT (id) DO NOTHING
      `;

      let created = 0;
      for (const [index, post] of orderedAssets.entries()) {
        const sortKey = (index + 1) * 1024;
        await sqlTx`
          INSERT INTO planner_assets (id, workspace_id, data, sort_key, revision, updated_at)
          VALUES (${post.id}, ${workspaceId}, ${sql.json(post)}, ${sortKey}, ${Number(post.revision) || 1}, ${post.updatedAt || new Date().toISOString()})
          ON CONFLICT (id) DO NOTHING
        `;
        const [change] = await sqlTx`
          INSERT INTO planner_changes (workspace_id, entity_type, entity_id, operation, entity_revision)
          VALUES (${workspaceId}, 'asset', ${post.id}, 'create', ${Number(post.revision) || 1})
          RETURNING sequence
        `;
        await sqlTx`UPDATE planner_assets SET changed_sequence = ${change.sequence} WHERE id = ${post.id}`;
        created += 1;
      }

      for (const idea of scratch) {
        await sqlTx`
          INSERT INTO planner_ideas (id, workspace_id, data, revision, created_at, updated_at)
          VALUES (${idea.id}, ${workspaceId}, ${sql.json(idea)}, 1, ${idea.createdAt || new Date().toISOString()}, ${idea.updatedAt || new Date().toISOString()})
          ON CONFLICT (id) DO NOTHING
        `;
        const [change] = await sqlTx`
          INSERT INTO planner_changes (workspace_id, entity_type, entity_id, operation, entity_revision)
          VALUES (${workspaceId}, 'idea', ${idea.id}, 'create', 1)
          RETURNING sequence
        `;
        await sqlTx`UPDATE planner_ideas SET changed_sequence = ${change.sequence} WHERE id = ${idea.id}`;
        created += 1;
      }

      await sqlTx`
        INSERT INTO planner_settings (workspace_id, data, revision)
        VALUES (${workspaceId}, ${sql.json(settings)}, 1)
        ON CONFLICT (workspace_id) DO NOTHING
      `;

      // Legacy free-text activity entries carry no structured entity
      // type/id/actor and no safely-replayable undo payload, so they are
      // preserved as read-only history (entity_type 'legacy', no
      // undo_payload) rather than being reverse-engineered into the new
      // entity-scoped undo model.
      for (const entry of activity) {
        await sqlTx`
          INSERT INTO planner_activity (id, workspace_id, entity_type, entity_id, actor, summary, created_at)
          VALUES (${entry.id}, ${workspaceId}, 'legacy', '', '', ${entry.text || ""}, ${entry.at || new Date().toISOString()})
          ON CONFLICT (id) DO NOTHING
        `;
      }

      await sqlTx`
        UPDATE planner_migrations
        SET destination_count = ${created}, completed_at = NOW()
        WHERE id = ${checksum}
      `;
      return created;
    });

    return { alreadyMigrated: false, checksum, sourceCount, destinationCount };
  }

  async function compareLegacyPlanner(legacyPlanner) {
    const posts = Array.isArray(legacyPlanner?.posts) ? legacyPlanner.posts : [];
    const scratch = Array.isArray(legacyPlanner?.scratch) ? legacyPlanner.scratch : [];
    const activity = Array.isArray(legacyPlanner?.activity) ? legacyPlanner.activity : [];
    const settings = legacyPlanner?.settings || {};
    const orderedAssets = orderedLegacyAssets(posts);

    const assetRows = await sql`
      SELECT id, data, sort_key FROM planner_assets
      WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL
      ORDER BY sort_key ASC
    `;
    const assetRowById = new Map(assetRows.map(row => [row.id, row]));
    const mismatches = [];

    if (assetRows.length !== orderedAssets.length) {
      mismatches.push({ type: "count", entity: "assets", expected: orderedAssets.length, actual: assetRows.length });
    }

    orderedAssets.forEach((post, index) => {
      const row = assetRowById.get(post.id);
      if (!row) {
        mismatches.push({ type: "missing", entity: "asset", id: post.id });
        return;
      }
      const fieldDiffs = diffFields(post, row.data, PARITY_IGNORED_ASSET_FIELDS);
      if (Object.keys(fieldDiffs).length) {
        mismatches.push({ type: "fields", entity: "asset", id: post.id, fields: fieldDiffs });
      }
      const expectedOrderIndex = assetRows.findIndex(r => r.id === post.id);
      if (expectedOrderIndex !== index) {
        mismatches.push({ type: "order", entity: "asset", id: post.id, expectedIndex: index, actualIndex: expectedOrderIndex });
      }
    });

    const ideaRows = await sql`
      SELECT id, data FROM planner_ideas WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL
    `;
    const ideaRowById = new Map(ideaRows.map(row => [row.id, row]));
    if (ideaRows.length !== scratch.length) {
      mismatches.push({ type: "count", entity: "ideas", expected: scratch.length, actual: ideaRows.length });
    }
    for (const idea of scratch) {
      const row = ideaRowById.get(idea.id);
      if (!row) {
        mismatches.push({ type: "missing", entity: "idea", id: idea.id });
        continue;
      }
      const fieldDiffs = diffFields(idea, row.data, PARITY_IGNORED_IDEA_FIELDS);
      if (Object.keys(fieldDiffs).length) {
        mismatches.push({ type: "fields", entity: "idea", id: idea.id, fields: fieldDiffs });
      }
    }

    const [settingsRow] = await sql`SELECT data FROM planner_settings WHERE workspace_id = ${workspaceId}`;
    if (!settingsRow) {
      mismatches.push({ type: "missing", entity: "settings" });
    } else {
      const fieldDiffs = diffFields(settings, settingsRow.data, new Set());
      if (Object.keys(fieldDiffs).length) {
        mismatches.push({ type: "fields", entity: "settings", fields: fieldDiffs });
      }
    }

    // Migrated activity rows are read-only history (see migrateLegacyPlanner)
    // with no structured fields to diff — presence by id and a matching
    // count is what "preserved" means for this entity.
    const activityRows = await sql`
      SELECT id FROM planner_activity WHERE workspace_id = ${workspaceId} AND entity_type = 'legacy'
    `;
    const activityIds = new Set(activityRows.map(row => row.id));
    if (activityRows.length !== activity.length) {
      mismatches.push({ type: "count", entity: "activity", expected: activity.length, actual: activityRows.length });
    }
    for (const entry of activity) {
      if (!activityIds.has(entry.id)) {
        mismatches.push({ type: "missing", entity: "activity", id: entry.id });
      }
    }

    return { ok: mismatches.length === 0, mismatches };
  }

  async function recordMigrationParity(checksum, ok) {
    await sql`
      UPDATE planner_migrations SET parity_result = ${ok ? "ok" : "mismatch"} WHERE id = ${checksum}
    `;
  }

  return { ensureSchema, health, migrateLegacyPlanner, compareLegacyPlanner, recordMigrationParity };
}
