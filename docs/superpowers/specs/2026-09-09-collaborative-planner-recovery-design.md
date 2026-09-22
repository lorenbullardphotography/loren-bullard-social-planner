# Collaborative Planner Recovery Design

## Goal

Make the planner act like a dependable shared online workspace: completed saves are durable, unrelated work never overwrites another person's work, reordering does not snap back, and open browsers receive completed changes promptly.

## Why the current design fails

The application persists the whole planner under one planner-data document. Several normal browser actions submit that entire browser copy through PUT /api/planner. A newer change from any browser makes a stale copy conflict, including when the two people touched unrelated assets. The current single-process mutation queue cannot coordinate separate serverless instances. Presence also creates frequent background writes that compete with real work.

## Chosen architecture

Supabase Postgres becomes the authoritative planner database. Each asset and idea is stored as a separate row. Settings and activity are separate rows. Every mutation updates only its affected record and appends a change-feed event in the same database transaction.

The browser calls narrow server endpoints and replaces only the affected record with the canonical response. It never submits the complete planner for routine saves. The editing-avatar/presence feature is removed. Visible browser tabs poll a read-only changes endpoint every five seconds and refresh on focus. Supabase Realtime is intentionally deferred until this stable baseline is proven.

## Data model

All tables include workspace_id with a default current workspace value.

- planner_assets: id, workspace_id, data JSONB, sort_key NUMERIC(30,15), revision, created_at, updated_at, changed_sequence, deleted_at.
- planner_ideas: id, workspace_id, data JSONB, revision, created_at, updated_at, changed_sequence, deleted_at.
- planner_settings: one row per workspace with data JSONB, revision, updated_at, changed_sequence.
- planner_activity: append-only activity rows with entity type/id, actor, summary, entity revision, change sequence, created_at, and a small undo payload only when safe.
- planner_changes: sequence, workspace_id, entity type/id, operation, entity revision, created_at.
- planner_migrations: source checksum, timestamps, source/destination counts, and parity result.

Indexes cover active asset ordering, active ideas, changes by workspace/sequence, and activity by workspace/date.

## API contract

GET /api/planner returns the initial row-backed snapshot and a changeToken.

GET /api/planner/changes?since=sequence is read-only. It returns only changed/deleted entities and the newest token. It supports ETag and 304 when nothing changed.

POST /api/planner/assets creates an asset row after a media upload has succeeded. PATCH /api/assets/:id changes only submitted fields and performs field-level conflict detection. POST /api/assets/:id/reorder receives neighboring IDs and changes only that asset's sort key. DELETE /api/assets/:id soft-deletes the row.

Ideas and settings use equivalent narrow endpoints. PUT /api/planner is retained only for an explicit administrator import during transition, then removed from normal UI flows.

## Collaboration behavior

The server locks only the row being changed. Different assets always save independently. Different fields on the same asset merge. A same-field conflict returns the current field value and keeps the person's local draft available to review, retry, or replace intentionally.

Drag reorder uses a server-calculated fractional sort key. It changes one item, never a complete planner. When concurrent reorder affects a neighbor, the server returns the canonical local ordering rather than a planner-wide conflict.

Remote deltas apply normally except when the selected asset has unsaved local edits. In that case, the browser keeps the draft and shows a non-blocking notice that a teammate saved changes.

## Availability rules

Production row storage requires a verified direct Postgres connection through DATABASE_URL or POSTGRES_URL. The app must prefer it over Supabase REST storage. The existing emergency change that defers Instagram session initialization from unrelated requests is released before the migration.

Media upload is separate from planner persistence. The upload route must not read Instagram session state, presence, or planner data before calling Vercel Blob. A failed upload creates no planner record; a failed follow-on record creation reports a retryable error and records an orphan candidate for cleanup.

## Migration and rollback

Migration is additive and non-destructive. Back up and checksum the legacy document, create row tables behind disabled flags, copy normalized records using deterministic sort keys, then compare IDs, field values, counts, settings, activity, and order. Only an administrator-reviewed parity pass enables row reads. Narrow writes are enabled only after row-read parity is proven.

Before row writes begin, a feature flag can return reads to the legacy document. After row writes begin, the rows remain authoritative and recovery is a forward fix; copying row data back to one shared document would recreate the overwrite problem.

## Success criteria

- Uploads no longer fail due to unrelated session/presence storage.
- Two people editing separate assets retain both saves.
- Two people editing different fields of one asset retain both edits.
- Same-field changes show an actionable field-level conflict without discarding a draft.
- Concurrent reorder settles in one request cycle without snapback.
- Completed changes reach another visible browser in six seconds or less, using no background writes.
- A persistence failure is retryable and does not erase typed work.

