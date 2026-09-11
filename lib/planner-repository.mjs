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

      // Real production data turned out to be messier than the fixture
      // data these functions were originally tested against — never trust
      // id fields to exist unguarded. The fallback is computed once per
      // item (not inlined at each interpolation site) so every reference
      // to it, including inside the stored JSONB itself, agrees.
      let created = 0;
      for (const [index, post] of orderedAssets.entries()) {
        const postId = post.id || crypto.randomUUID();
        const sortKey = (index + 1) * 1024;
        await sqlTx`
          INSERT INTO planner_assets (id, workspace_id, data, sort_key, revision, updated_at)
          VALUES (${postId}, ${workspaceId}, ${sql.json({ ...post, id: postId })}, ${sortKey}, ${Number(post.revision) || 1}, ${post.updatedAt || new Date().toISOString()})
          ON CONFLICT (id) DO NOTHING
        `;
        const [change] = await sqlTx`
          INSERT INTO planner_changes (workspace_id, entity_type, entity_id, operation, entity_revision)
          VALUES (${workspaceId}, 'asset', ${postId}, 'create', ${Number(post.revision) || 1})
          RETURNING sequence
        `;
        await sqlTx`UPDATE planner_assets SET changed_sequence = ${change.sequence} WHERE id = ${postId}`;
        created += 1;
      }

      for (const idea of scratch) {
        const ideaId = idea.id || crypto.randomUUID();
        await sqlTx`
          INSERT INTO planner_ideas (id, workspace_id, data, revision, created_at, updated_at)
          VALUES (${ideaId}, ${workspaceId}, ${sql.json({ ...idea, id: ideaId })}, 1, ${idea.createdAt || new Date().toISOString()}, ${idea.updatedAt || new Date().toISOString()})
          ON CONFLICT (id) DO NOTHING
        `;
        const [change] = await sqlTx`
          INSERT INTO planner_changes (workspace_id, entity_type, entity_id, operation, entity_revision)
          VALUES (${workspaceId}, 'idea', ${ideaId}, 'create', 1)
          RETURNING sequence
        `;
        await sqlTx`UPDATE planner_ideas SET changed_sequence = ${change.sequence} WHERE id = ${ideaId}`;
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
        // Real production activity history turned out to include at least
        // one entry with no id (older data than this app's own
        // crypto.randomUUID()-always convention) — postgres.js rejects an
        // undefined parameter outright, so this must never be trusted to
        // exist unguarded like post.id/idea.id are elsewhere in this loop.
        await sqlTx`
          INSERT INTO planner_activity (id, workspace_id, entity_type, entity_id, actor, summary, created_at)
          VALUES (${entry.id || crypto.randomUUID()}, ${workspaceId}, 'legacy', '', '', ${entry.text || ""}, ${entry.at || new Date().toISOString()})
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
    // with no structured fields to diff — presence and a matching count is
    // what "preserved" means for this entity. Real production history
    // turned out to include entries from before this app always assigned
    // an id (migrateLegacyPlanner gives those a fresh generated one) — a
    // legacy entry with no id obviously can't be found by id in the
    // migrated set, so those are matched by their (summary, created_at)
    // pair instead, each migrated row consumed at most once so duplicate
    // text/timestamp pairs can't hide a real gap.
    const activityRows = await sql`
      SELECT id, summary, created_at FROM planner_activity WHERE workspace_id = ${workspaceId} AND entity_type = 'legacy'
    `;
    const activityIds = new Set(activityRows.map(row => row.id));
    if (activityRows.length !== activity.length) {
      mismatches.push({ type: "count", entity: "activity", expected: activity.length, actual: activityRows.length });
    }
    const unclaimedRows = [...activityRows];
    for (const entry of activity) {
      if (entry.id) {
        if (!activityIds.has(entry.id)) mismatches.push({ type: "missing", entity: "activity", id: entry.id });
        continue;
      }
      const matchIndex = unclaimedRows.findIndex(row =>
        row.summary === (entry.text || "") && new Date(row.created_at).toISOString() === new Date(entry.at || 0).toISOString()
      );
      if (matchIndex === -1) mismatches.push({ type: "missing", entity: "activity", text: entry.text });
      else unclaimedRows.splice(matchIndex, 1);
    }

    return { ok: mismatches.length === 0, mismatches };
  }

  async function recordMigrationParity(checksum, ok) {
    await sql`
      UPDATE planner_migrations SET parity_result = ${ok ? "ok" : "mismatch"} WHERE id = ${checksum}
    `;
  }

  // Row storage must never activate just because PLANNER_ROW_STORAGE_ENABLED
  // is set — that flag only means "activate once a migration has actually
  // been run and reviewed." This is the runtime check for that: at least
  // one completed migration whose parity report came back clean.
  async function hasVerifiedMigrationParity() {
    const [row] = await sql`
      SELECT 1 FROM planner_migrations
      WHERE workspace_id = ${workspaceId} AND completed_at IS NOT NULL AND parity_result = 'ok'
      LIMIT 1
    `;
    return Boolean(row);
  }

  // An Admin restoring a JSON backup (PUT /api/planner with
  // adminImport:true) used to only ever write the legacy whole-document —
  // once row storage is serving reads, GET /api/planner sources
  // posts/scratch/settings from here instead, so the restore would return
  // 200 and then have no visible effect at all, forever. Unlike
  // migrateLegacyPlanner (a one-way, run-once copy guarded by a checksum),
  // this is an explicit, authenticated overwrite every time it's called —
  // that's the whole point of a restore.
  async function replaceAllFromImport({ posts = [], scratch = [], settings = null, actor = "" } = {}) {
    return withTransaction(async sqlTx => {
      await sqlTx`DELETE FROM planner_assets WHERE workspace_id = ${workspaceId}`;
      await sqlTx`DELETE FROM planner_ideas WHERE workspace_id = ${workspaceId}`;

      for (const [index, post] of posts.entries()) {
        const postId = post.id || crypto.randomUUID();
        const sortKey = (index + 1) * 1024;
        const revision = Number(post.revision) || 1;
        const changeSequence = await recordChange(sqlTx, { entityType: "asset", entityId: postId, operation: "create", entityRevision: revision });
        await sqlTx`
          INSERT INTO planner_assets (id, workspace_id, data, sort_key, revision, changed_sequence, updated_at)
          VALUES (${postId}, ${workspaceId}, ${sql.json({ ...post, id: postId })}, ${sortKey}, ${revision}, ${changeSequence}, NOW())
        `;
      }

      for (const idea of scratch) {
        const ideaId = idea.id || crypto.randomUUID();
        const changeSequence = await recordChange(sqlTx, { entityType: "idea", entityId: ideaId, operation: "create", entityRevision: 1 });
        await sqlTx`
          INSERT INTO planner_ideas (id, workspace_id, data, revision, changed_sequence, created_at, updated_at)
          VALUES (${ideaId}, ${workspaceId}, ${sql.json({ ...idea, id: ideaId })}, 1, ${changeSequence}, NOW(), NOW())
        `;
      }

      if (settings) {
        const [existing] = await sqlTx`SELECT revision FROM planner_settings WHERE workspace_id = ${workspaceId} FOR UPDATE`;
        const nextRevision = (Number(existing?.revision) || 0) + 1;
        const changeSequence = await recordChange(sqlTx, { entityType: "settings", entityId: "settings", operation: "update", entityRevision: nextRevision });
        await sqlTx`
          INSERT INTO planner_settings (workspace_id, data, revision, changed_sequence)
          VALUES (${workspaceId}, ${sql.json(settings)}, ${nextRevision}, ${changeSequence})
          ON CONFLICT (workspace_id) DO UPDATE
            SET data = EXCLUDED.data, revision = EXCLUDED.revision, changed_sequence = EXCLUDED.changed_sequence, updated_at = NOW()
        `;
      }

      await sqlTx`
        INSERT INTO planner_activity (id, workspace_id, entity_type, entity_id, actor, summary)
        VALUES (${crypto.randomUUID()}, ${workspaceId}, 'legacy', '', ${actor}, ${`${actor || "An admin"} restored a planner backup`})
      `;
    });
  }

  // --- Low-level row/transaction primitives for lib/planner-service.mjs ---
  // planner-service.mjs owns domain validation (normalizing changes,
  // detecting field conflicts); this module owns the actual row access,
  // locking, and change-feed bookkeeping those operations need.

  function withTransaction(fn) {
    return sql.begin(fn);
  }

  async function recordChange(sqlTx, { entityType, entityId, operation, entityRevision }) {
    const [change] = await sqlTx`
      INSERT INTO planner_changes (workspace_id, entity_type, entity_id, operation, entity_revision)
      VALUES (${workspaceId}, ${entityType}, ${entityId}, ${operation}, ${entityRevision})
      RETURNING sequence
    `;
    return change.sequence;
  }

  async function recordActivity(sqlTx, { entityType, entityId, actor, summary, entityRevision, changedSequence, undoPayload = null }) {
    await sqlTx`
      INSERT INTO planner_activity (id, workspace_id, entity_type, entity_id, actor, summary, entity_revision, changed_sequence, undo_payload)
      VALUES (${crypto.randomUUID()}, ${workspaceId}, ${entityType}, ${entityId}, ${actor || ""}, ${summary}, ${entityRevision}, ${changedSequence}, ${undoPayload ? sql.json(undoPayload) : null})
    `;
  }

  async function getAssetForUpdate(sqlTx, id) {
    const [row] = await sqlTx`
      SELECT * FROM planner_assets WHERE workspace_id = ${workspaceId} AND id = ${id} AND deleted_at IS NULL FOR UPDATE
    `;
    return row || null;
  }

  async function nextAssetSortKey(sqlTx) {
    const [{ maxSort }] = await sqlTx`
      SELECT COALESCE(MAX(sort_key), 0) AS "maxSort" FROM planner_assets WHERE workspace_id = ${workspaceId}
    `;
    return Number(maxSort) + 1024;
  }

  // A client-supplied id colliding with an existing *active* row is a
  // genuine conflict (returns null; the caller rejects the request). A
  // collision with a *soft-deleted* row (e.g. a retried create, or the
  // literal "teammate recreates the same id" scenario undo has to detect)
  // is treated as reviving that id with fresh data rather than a raw
  // primary-key error from a plain INSERT.
  async function insertAssetRow(sqlTx, { id, data, sortKey, revision }) {
    const [row] = await sqlTx`
      INSERT INTO planner_assets (id, workspace_id, data, sort_key, revision)
      VALUES (${id}, ${workspaceId}, ${sql.json(data)}, ${sortKey}, ${revision})
      ON CONFLICT (id) DO UPDATE
        SET data = EXCLUDED.data, sort_key = EXCLUDED.sort_key, revision = EXCLUDED.revision, deleted_at = NULL, updated_at = NOW()
        WHERE planner_assets.deleted_at IS NOT NULL
      RETURNING *
    `;
    return row || null;
  }

  async function updateAssetRow(sqlTx, { id, data, revision, changedSequence }) {
    const [row] = await sqlTx`
      UPDATE planner_assets
      SET data = ${sql.json(data)}, revision = ${revision}, updated_at = NOW(), changed_sequence = ${changedSequence}
      WHERE workspace_id = ${workspaceId} AND id = ${id}
      RETURNING *
    `;
    return row;
  }

  async function setAssetChangedSequence(sqlTx, id, changedSequence) {
    await sqlTx`UPDATE planner_assets SET changed_sequence = ${changedSequence} WHERE workspace_id = ${workspaceId} AND id = ${id}`;
  }

  async function softDeleteAssetRow(sqlTx, id, changedSequence) {
    await sqlTx`
      UPDATE planner_assets SET deleted_at = NOW(), changed_sequence = ${changedSequence}
      WHERE workspace_id = ${workspaceId} AND id = ${id}
    `;
  }

  async function listActiveAssets() {
    const rows = await sql`
      SELECT * FROM planner_assets WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL ORDER BY sort_key ASC
    `;
    return rows.map(row => row.data);
  }

  // Locks the moved asset plus its requested neighbors (whichever of
  // beforeId/afterId are non-null) in a single, id-sorted FOR UPDATE so two
  // concurrent reorders touching overlapping rows lock in the same order
  // and can't deadlock each other.
  async function lockAssetsForReorder(sqlTx, ids) {
    const rows = await sqlTx`
      SELECT * FROM planner_assets
      WHERE workspace_id = ${workspaceId} AND id = ANY(${ids}) AND deleted_at IS NULL
      ORDER BY id FOR UPDATE
    `;
    return new Map(rows.map(row => [row.id, row]));
  }

  async function listActiveAssetRowsForRespacing(sqlTx) {
    return sqlTx`
      SELECT id, sort_key FROM planner_assets
      WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL
      ORDER BY sort_key ASC FOR UPDATE
    `;
  }

  async function updateAssetSortKey(sqlTx, id, sortKey, changedSequence) {
    const [row] = await sqlTx`
      UPDATE planner_assets SET sort_key = ${sortKey}, changed_sequence = ${changedSequence}
      WHERE workspace_id = ${workspaceId} AND id = ${id}
      RETURNING *
    `;
    return row;
  }

  // --- Idea row primitives (mirrors the asset ones above, minus sort_key —
  // ideas have no grid ordering per the data model). ---

  async function getIdeaForUpdate(sqlTx, id) {
    const [row] = await sqlTx`
      SELECT * FROM planner_ideas WHERE workspace_id = ${workspaceId} AND id = ${id} AND deleted_at IS NULL FOR UPDATE
    `;
    return row || null;
  }

  async function insertIdeaRow(sqlTx, { id, data, revision }) {
    const [row] = await sqlTx`
      INSERT INTO planner_ideas (id, workspace_id, data, revision)
      VALUES (${id}, ${workspaceId}, ${sql.json(data)}, ${revision})
      RETURNING *
    `;
    return row;
  }

  async function setIdeaChangedSequence(sqlTx, id, changedSequence) {
    await sqlTx`UPDATE planner_ideas SET changed_sequence = ${changedSequence} WHERE workspace_id = ${workspaceId} AND id = ${id}`;
  }

  async function updateIdeaRow(sqlTx, { id, data, revision, changedSequence }) {
    const [row] = await sqlTx`
      UPDATE planner_ideas
      SET data = ${sql.json(data)}, revision = ${revision}, updated_at = NOW(), changed_sequence = ${changedSequence}
      WHERE workspace_id = ${workspaceId} AND id = ${id}
      RETURNING *
    `;
    return row;
  }

  async function softDeleteIdeaRow(sqlTx, id, changedSequence) {
    await sqlTx`
      UPDATE planner_ideas SET deleted_at = NOW(), changed_sequence = ${changedSequence}
      WHERE workspace_id = ${workspaceId} AND id = ${id}
    `;
  }

  async function listActiveIdeas() {
    const rows = await sql`
      SELECT * FROM planner_ideas WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL ORDER BY created_at ASC
    `;
    return rows.map(row => row.data);
  }

  // --- Settings: one row per workspace, whole-row optimistic concurrency
  // via `revision` (no field-level merge like assets — settings edits are
  // low-frequency and not worth that complexity). ---

  async function getSettingsForUpdate(sqlTx) {
    const [row] = await sqlTx`
      SELECT * FROM planner_settings WHERE workspace_id = ${workspaceId} FOR UPDATE
    `;
    return row || null;
  }

  async function upsertSettingsRow(sqlTx, { data, revision, changedSequence }) {
    const [row] = await sqlTx`
      INSERT INTO planner_settings (workspace_id, data, revision, changed_sequence)
      VALUES (${workspaceId}, ${sql.json(data)}, ${revision}, ${changedSequence})
      ON CONFLICT (workspace_id) DO UPDATE
        SET data = EXCLUDED.data, revision = EXCLUDED.revision, changed_sequence = EXCLUDED.changed_sequence, updated_at = NOW()
      RETURNING *
    `;
    return row;
  }

  async function getSettings() {
    const [row] = await sql`SELECT data, revision FROM planner_settings WHERE workspace_id = ${workspaceId}`;
    return row ? { ...row.data, revision: Number(row.revision) } : null;
  }

  const CHANGES_PAGE_LIMIT = 200;

  async function latestChangeSequence() {
    const [row] = await sql`SELECT MAX(sequence) AS seq FROM planner_changes WHERE workspace_id = ${workspaceId}`;
    return Number(row?.seq) || 0;
  }

  // Returns the canonical current state of every entity touched since
  // `sinceSequence` (capped at CHANGES_PAGE_LIMIT raw change rows, then
  // deduplicated to one entry per entity — several edits to the same asset
  // in the window collapse into its single current state). A currently
  // soft-deleted entity comes back as a tombstone ({ deleted: true }) with
  // no data, so the client can remove it instead of trying to render it.
  async function changesSince(sinceSequence) {
    const rawChanges = await sql`
      SELECT sequence, entity_type, entity_id, operation FROM planner_changes
      WHERE workspace_id = ${workspaceId} AND sequence > ${sinceSequence}
      ORDER BY sequence ASC
      LIMIT ${CHANGES_PAGE_LIMIT}
    `;
    if (!rawChanges.length) {
      return { changes: [], nextToken: sinceSequence };
    }

    const nextToken = Number(rawChanges[rawChanges.length - 1].sequence);
    const uniqueByEntity = new Map();
    for (const change of rawChanges) {
      uniqueByEntity.set(`${change.entity_type}:${change.entity_id}`, change.entity_type);
    }

    const assetIds = [...uniqueByEntity.entries()].filter(([, type]) => type === "asset").map(([key]) => key.split(":")[1]);
    const ideaIds = [...uniqueByEntity.entries()].filter(([, type]) => type === "idea").map(([key]) => key.split(":")[1]);
    const includesSettings = [...uniqueByEntity.values()].includes("settings");

    const changes = [];

    if (assetIds.length) {
      const assetRows = await sql`SELECT id, data, deleted_at FROM planner_assets WHERE workspace_id = ${workspaceId} AND id = ANY(${assetIds})`;
      const byId = new Map(assetRows.map(row => [row.id, row]));
      for (const id of assetIds) {
        const row = byId.get(id);
        changes.push(row && !row.deleted_at
          ? { entityType: "asset", entityId: id, deleted: false, data: row.data }
          : { entityType: "asset", entityId: id, deleted: true, data: null });
      }
    }

    if (ideaIds.length) {
      const ideaRows = await sql`SELECT id, data, deleted_at FROM planner_ideas WHERE workspace_id = ${workspaceId} AND id = ANY(${ideaIds})`;
      const byId = new Map(ideaRows.map(row => [row.id, row]));
      for (const id of ideaIds) {
        const row = byId.get(id);
        changes.push(row && !row.deleted_at
          ? { entityType: "idea", entityId: id, deleted: false, data: row.data }
          : { entityType: "idea", entityId: id, deleted: true, data: null });
      }
    }

    if (includesSettings) {
      const settingsData = await getSettings();
      changes.push({ entityType: "settings", entityId: "settings", deleted: false, data: settingsData });
    }

    return { changes, nextToken };
  }

  // --- Entity-scoped undo primitives ---
  // Undo needs to see a soft-deleted row too (to restore it), unlike every
  // other asset/idea read above which filters deleted_at IS NULL.

  async function getAssetForUpdateIncludingDeleted(sqlTx, id) {
    const [row] = await sqlTx`SELECT * FROM planner_assets WHERE workspace_id = ${workspaceId} AND id = ${id} FOR UPDATE`;
    return row || null;
  }

  async function restoreAssetRow(sqlTx, { id, data, sortKey, revision, changedSequence }) {
    await sqlTx`
      UPDATE planner_assets
      SET data = ${sql.json(data)}, sort_key = ${sortKey}, revision = ${revision}, deleted_at = NULL, changed_sequence = ${changedSequence}
      WHERE workspace_id = ${workspaceId} AND id = ${id}
    `;
  }

  async function getIdeaForUpdateIncludingDeleted(sqlTx, id) {
    const [row] = await sqlTx`SELECT * FROM planner_ideas WHERE workspace_id = ${workspaceId} AND id = ${id} FOR UPDATE`;
    return row || null;
  }

  async function restoreIdeaRow(sqlTx, { id, data, revision, changedSequence }) {
    await sqlTx`
      UPDATE planner_ideas
      SET data = ${sql.json(data)}, revision = ${revision}, deleted_at = NULL, changed_sequence = ${changedSequence}
      WHERE workspace_id = ${workspaceId} AND id = ${id}
    `;
  }

  async function getActivityForUpdate(sqlTx, id) {
    const [row] = await sqlTx`SELECT * FROM planner_activity WHERE workspace_id = ${workspaceId} AND id = ${id} FOR UPDATE`;
    return row || null;
  }

  // Undo is one-shot: successfully applying it (or finding it stale) clears
  // undo_payload so a second click can't re-apply the inverse or re-report
  // staleness as if it were a fresh action.
  async function consumeActivityUndo(sqlTx, id) {
    await sqlTx`UPDATE planner_activity SET undo_payload = NULL WHERE workspace_id = ${workspaceId} AND id = ${id}`;
  }

  // The Team Activity tab's feed, shaped to match the legacy whole-document
  // `planner.activity` entries it replaces ({ id, text, at, reversible,
  // rollbackId }) so the client can render either without a special case.
  // Ordered by created_at, which is correct for both migrated legacy rows
  // (their original timestamp) and rows recorded since (NOW() at write
  // time) — there is no single global sequence spanning both.
  async function listRecentActivity({ limit = 40 } = {}) {
    const rows = await sql`
      SELECT id, summary, created_at, undo_payload FROM planner_activity
      WHERE workspace_id = ${workspaceId}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `;
    return rows.map(row => ({
      id: row.id,
      text: row.summary,
      at: new Date(row.created_at).toISOString(),
      reversible: row.undo_payload != null,
      rollbackId: row.undo_payload != null ? row.id : undefined
    }));
  }

  return {
    ensureSchema, health, migrateLegacyPlanner, compareLegacyPlanner, recordMigrationParity, hasVerifiedMigrationParity, replaceAllFromImport,
    withTransaction, recordChange, recordActivity,
    getAssetForUpdate, nextAssetSortKey, insertAssetRow, updateAssetRow, setAssetChangedSequence, softDeleteAssetRow, listActiveAssets,
    lockAssetsForReorder, listActiveAssetRowsForRespacing, updateAssetSortKey,
    getIdeaForUpdate, insertIdeaRow, setIdeaChangedSequence, updateIdeaRow, softDeleteIdeaRow, listActiveIdeas,
    getSettingsForUpdate, upsertSettingsRow, getSettings,
    latestChangeSequence, changesSince,
    getAssetForUpdateIncludingDeleted, restoreAssetRow, getIdeaForUpdateIncludingDeleted, restoreIdeaRow,
    getActivityForUpdate, consumeActivityUndo, listRecentActivity
  };
}
