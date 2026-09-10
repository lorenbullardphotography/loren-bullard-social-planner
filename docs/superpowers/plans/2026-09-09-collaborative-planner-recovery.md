# Collaborative Planner Recovery Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Replace planner-wide saves with durable row-level collaboration so people can edit, upload, and reorder together without lost data, snapbacks, or presence-related outages.

**Architecture:** The current planner-data document becomes a migration source, not the active collaboration model. A Postgres repository persists one asset or idea per row and emits an append-only change event in the same transaction. Browser actions use narrow endpoints and apply canonical responses; other open browsers receive read-only deltas instead of emitting heartbeat writes.

**Tech Stack:** Node.js 18+, native HTTP server, postgres, Supabase Postgres, Vercel Blob, vanilla browser JavaScript, Node built-in test runner.

**Spec:** docs/superpowers/specs/2026-09-09-collaborative-planner-recovery-design.md

## Global constraints

- Preserve every existing asset, idea, setting, activity entry, media URL, and current grid order.
- Use direct Postgres for shared planner rows. Do not use Supabase REST key/value storage for planner collaboration.
- Remove presence UI and all presence heartbeat/polling calls. Presence must never affect loading, saving, or uploads.
- Normal UI operations must not call PUT /api/planner or send a complete planner payload.
- Every mutation must use one transaction and append planner_changes in that transaction.
- Never silently discard local input. Conflicts keep the user's draft and show current server values.
- Keep and first deploy the already-tested storage-isolation changes in lib/store.mjs and server.mjs.
- Run node --test --test-concurrency=1 test/*.test.mjs before each release candidate.

## Files and ownership

| File | Responsibility |
| --- | --- |
| lib/store.mjs | Legacy generic storage and direct Postgres selection only. |
| lib/planner-repository.mjs | Row schema, migration, transactions, reads, change feed. |
| lib/planner-service.mjs | Domain validation and asset/idea/settings operations. |
| server.mjs | Route parsing, authentication, feature flags, media upload isolation. |
| public/app.js | Narrow mutation callers, draft protection, delta application, reorder reconciliation. |
| test/planner-repository.test.mjs | Schema and transactional repository tests. |
| test/planner-migration.test.mjs | Migration parity and idempotence tests. |
| test/planner-api.test.mjs | HTTP route and error-shape tests. |
| test/planner-collaboration.test.mjs | Two-client save/reorder/delta acceptance tests. |

## Task 1: Release the storage isolation hotfix

**Files:** Modify lib/store.mjs and server.mjs. Test test/store-connection.test.mjs and test/request-isolation.test.mjs.

**Produces:** Direct Postgres is selected before Supabase REST. Only readSession seeds Instagram credentials; ordinary upload and planner requests do not.

- [ ] Write/retain source assertions that database selection precedes Supabase REST and handleRequest does not call seedEnvironmentSession.
- [ ] Run node --test test/store-connection.test.mjs test/request-isolation.test.mjs. Expected: pass.
- [ ] Deploy only this isolated hotfix.
- [ ] Confirm production has DATABASE_URL or POSTGRES_URL and reports postgres planner storage.
- [ ] From two authenticated sessions, upload a small image. Expected: Blob URL or a Blob-specific retryable error, never a session/storage 500.
- [ ] Commit with message: fix: isolate uploads from planner storage failures.

## Task 2: Add direct-Postgres row schema and readiness checks

**Files:** Create lib/planner-repository.mjs. Modify lib/store.mjs and server.mjs. Create test/planner-repository.test.mjs.

**Interfaces:** createPlannerRepository({ sql, workspaceId }); repository.ensureSchema(); repository.health().

- [ ] Write a failing test that records SQL statements and asserts creation of planner_assets, planner_ideas, planner_settings, planner_activity, planner_changes, planner_migrations, plus the active-order and change-feed indexes.
- [ ] Run node --test test/planner-repository.test.mjs. Expected: fail because the repository does not exist.
- [ ] Implement ensureSchema with additive CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT EXISTS statements. Never modify or drop planner_store.
- [ ] Require direct Postgres for the repository. Return a safe service-unavailable error when unavailable; never fall back to whole-document REST writes.
- [ ] Add authenticated GET /api/health/storage returning plannerStorage and rowSchemaReady, without secrets, migration, or Instagram access.
- [ ] Run focused repository/store/isolation tests. Expected: pass.
- [ ] Commit with message: feat: add planner row storage schema.

## Task 3: Build idempotent legacy migration and parity audit

**Files:** Modify lib/planner-repository.mjs and server.mjs. Create test/planner-migration.test.mjs.

**Interfaces:** repository.migrateLegacyPlanner(legacyPlanner); repository.compareLegacyPlanner(legacyPlanner).

- [ ] Write a failing fixture test proving migration retains asset IDs, normalized values, ideas, settings, activity, and existing asset order.
- [ ] Write a second failing test proving a matching source checksum returns already-migrated without duplicating records or change events.
- [ ] Run node --test test/planner-migration.test.mjs. Expected: fail.
- [ ] Normalize the legacy document, compute SHA-256 checksum, and record migration state transactionally.
- [ ] Insert planned assets in current order with sort_key equal to index times 1024. Insert posted assets in stable order after them. Preserve existing revisions and field revision metadata.
- [ ] Implement parity comparison of counts, IDs, normalized fields excluding server timestamps, settings, activity, and order. Return precise mismatched IDs/fields; any mismatch blocks activation.
- [ ] Add Admin-only POST /api/admin/planner-row-migration accepting mode shadow. It migrates, verifies parity, returns the report, and never changes runtime read/write flags.
- [ ] Run repository and migration tests. Expected: pass.
- [ ] Commit with message: feat: add verified planner row migration.

## Task 4: Implement independent asset reads, saves, creates, and deletes

**Files:** Modify lib/planner-repository.mjs and server.mjs. Create lib/planner-service.mjs and test/planner-api.test.mjs.

**Interfaces:** patchAsset({ id, revision, changes, forceFields, actor, reason }); createAsset({ asset, actor, reason }); deleteAsset({ id, actor, reason }); readSnapshot().

- [ ] Write failing tests where two simultaneous saves change different assets and both persist.
- [ ] Write failing tests where different fields on one asset merge and stale same-field changes return ASSET_FIELD_CONFLICT with current field data.
- [ ] Run node --test test/planner-api.test.mjs. Expected: fail.
- [ ] Use SELECT FOR UPDATE on the affected asset row. Reuse normalizeAssetChanges, assetConflicts, and applyAssetChanges to maintain existing editor behavior.
- [ ] In the same transaction update one asset row, allocate a change sequence, insert planner_changes, and append activity. Do not call readPlanner, writePlanner, or withPlannerMutation.
- [ ] Gate row behavior with PLANNER_ROW_STORAGE_ENABLED. Keep legacy behavior until migration parity is approved.
- [ ] Keep media upload endpoint independent. Add POST /api/planner/assets to create the planner row after a successful Blob or Canva media step.
- [ ] Run node --test test/asset-revision.test.mjs test/planner-api.test.mjs test/request-isolation.test.mjs. Expected: pass.
- [ ] Commit with message: feat: persist planner assets as independent rows.

## Task 5: Implement server-authoritative reorder

**Files:** Modify lib/planner-repository.mjs, lib/planner-service.mjs, server.mjs, public/app.js, test/planner-api.test.mjs. Create test/planner-collaboration.test.mjs.

**Interfaces:** reorderAsset({ id, beforeId, afterId, actor }) returns asset, affected neighbors, and changeToken. Route: POST /api/assets/:id/reorder.

- [ ] Write a failing test that concurrently edits asset B and reorders asset A; assert both survive and no planner-wide 409 is returned.
- [ ] Run node --test test/planner-collaboration.test.mjs. Expected: fail.
- [ ] In one transaction lock moved asset and immediate neighbors. Assign a numeric key midway between neighbor keys; use a 1024 gap at ends.
- [ ] When the local gap is less than 0.000001, re-space the affected ordered set in that transaction, emit changed events for re-spaced rows, then return canonical order.
- [ ] Replace reorder's persistPlanner call with a narrow POST request. Keep immediate animation, disable only moved tile, and replace only returned assets.
- [ ] On error, refresh the delta/snapshot, display a retryable message, and never replace the full planner from a stale browser payload.
- [ ] Run planner API, collaboration, and existing asset conflict tests. Expected: pass.
- [ ] Commit with message: feat: reorder planner assets without global conflicts.

## Task 6: Move ideas and settings off full planner writes

**Files:** Modify lib/planner-repository.mjs, lib/planner-service.mjs, server.mjs, public/app.js, and test/planner-api.test.mjs.

**Interfaces:** POST/PATCH/DELETE /api/ideas/:id and PATCH /api/settings.

- [ ] Write a failing test that saves settings while another client edits an asset; assert both changes remain.
- [ ] Implement row-level idea mutation and one-row versioned settings mutation, each with activity and change events.
- [ ] Replace each normal persistPlanner call site for ideas, settings, Canva working drafts, uploaded posts, and deletion with its narrow endpoint.
- [ ] Keep full planner import/export as explicit administrator behavior only.
- [ ] Run node --test test/ideas.test.mjs test/settings-layout.test.mjs test/planner-api.test.mjs. Expected: pass.
- [ ] Commit with message: feat: save planner ideas and settings independently.

## Task 7: Remove presence and add a read-only change feed

**Files:** Modify lib/planner-repository.mjs, lib/planner-service.mjs, server.mjs, public/app.js, public/styles.css, test/planner-startup.test.mjs, and test/planner-collaboration.test.mjs.

**Interfaces:** GET /api/planner/changes?since=sequence; applyPlannerDelta(delta).

- [ ] Write a failing test that asks for changes newer than a token, receives only those entities, then gets a read-only 304/no-change response at the new token.
- [ ] Implement change query capped at 200 events. Return canonical changed rows and deleted tombstones; ETag is based on the current token.
- [ ] Delete editingPresenceMarkup, editorPresenceMarkup, renderPresenceIndicators, updateEditingPresence, presence endpoint use, heartbeat timer, and related CSS/markup.
- [ ] Add five-second read-only delta polling only while document.visibilityState is visible plus refresh on focus. Pause during a local mutation and request immediately after it finishes.
- [ ] If the selected asset has unsaved edits, retain its inputs and show a non-blocking teammate-saved notice. Apply deltas directly to all other items.
- [ ] Run node --test test/planner-startup.test.mjs test/planner-collaboration.test.mjs test/loading-ui.test.mjs. Expected: pass.
- [ ] Commit with message: feat: synchronize planner changes without presence writes.

## Task 8: Replace unsafe global undo with entity-scoped undo

**Files:** Modify lib/planner-repository.mjs, lib/planner-service.mjs, server.mjs, public/app.js, test/activity-rollback.test.mjs, and test/planner-collaboration.test.mjs.

**Interfaces:** POST /api/activity/:id/undo.

- [ ] Write a failing test: delete asset A, allow a teammate to change/recreate it, then assert undo returns UNDO_STALE and does not restore old state.
- [ ] Store an inverse payload and expected row revision only for safe asset create/delete/reorder operations.
- [ ] Undo locks the entity, checks its exact expected revision, applies only the inverse row change, then emits normal activity/change events.
- [ ] Mark settings and bulk imports non-reversible. Remove planner-rollback-history from the row-storage path.
- [ ] In UI, stale undo says the item changed after that action and cannot be safely undone; it never reloads/replaces the full planner.
- [ ] Run activity and collaboration tests. Expected: pass.
- [ ] Commit with message: fix: make planner undo safe for shared edits.

## Task 9: Controlled activation and production verification

**Files:** Modify server.mjs, public/app.js, README.md, .env.example, test/planner-api.test.mjs, and test/planner-collaboration.test.mjs.

- [ ] Write failing feature-flag tests that row reads/writes require a completed migration with parityOk true.
- [ ] After shadow migration produces a reviewed parity report, enable PLANNER_ROW_STORAGE_ENABLED for preview. Verify every current asset, idea, setting, and grid position.
- [ ] Enable PLANNER_ROW_WRITES_ENABLED only after row-read parity is accepted. When enabled, reject ordinary PUT /api/planner; allow only an authenticated administrator import with explicit confirmation.
- [ ] Document direct-Postgres requirements, Blob requirements, feature flags, shadow migration, parity review, activation order, and forward-fix recovery. Never include credentials.
- [ ] Run node --test --test-concurrency=1 test/*.test.mjs. Expected: pass.
- [ ] In two separate authenticated production-preview sessions verify separate asset saves, different-field merge, same-field conflict, concurrent drags, upload, six-second remote visibility, and retryable outage behavior with local draft retained.
- [ ] Commit with message: feat: activate durable collaborative planner storage.

## Task 10: Observe and retire legacy normal reads

**Files:** Modify server.mjs, lib/store.mjs, README.md, and test/planner-api.test.mjs.

- [ ] Add a failing test for safe operation diagnostics containing only operation name, duration, outcome, and feature-flag state.
- [ ] Add diagnostics around row requests. Never log captions, media URLs, credentials, cookies, request bodies, or passwords.
- [ ] After seven days with no parity mismatch, planner-wide conflict, or persistence 500, remove legacy normal read fallback and leftover presence storage keys. Retain the exported pre-migration backup and migration record.
- [ ] Run full tests. Expected: pass.
- [ ] Commit with message: chore: add collaborative planner release diagnostics.

## Plan self-review

- Coverage: Tasks 1-3 address availability, direct database use, migration, and parity. Tasks 4-6 remove whole-planner writes. Task 7 eliminates presence and adds safe synchronization. Task 8 prevents global rollback damage. Tasks 9-10 gate rollout and retirement.
- No placeholders: every task identifies files, interfaces, expected test behavior, and release criteria.
- Consistency: all normal writes travel through planner-service and narrow endpoints; all remote updates travel through the monotonic changeToken.

