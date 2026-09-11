// Domain operations for the row-storage planner: validates and applies
// asset/idea/settings changes on top of the low-level row/transaction
// primitives in lib/planner-repository.mjs.
//
// normalizePost/normalizeAssetChanges/applyAssetChanges/assetConflicts are
// imported from server.mjs rather than duplicated here, to reuse the exact
// same field-level revision/conflict behavior the legacy whole-document
// editor already relies on (and is already covered by
// test/asset-revision.test.mjs). server.mjs also imports createPlannerService
// from this module to wire routes, so this import is circular — safe here
// because all four are `function` declarations (hoisted, so their export
// bindings exist before either module's body finishes evaluating) and
// nothing at this module's top level calls them before both modules have
// finished loading.
import { normalizePost, normalizeAssetChanges, applyAssetChanges, assetConflicts, normalizeScratchEntry, normalizeSettings } from "../server.mjs";

export function createPlannerService({ repository }) {
  // Sequential, not Promise.all: each hosted Postgres connection pool is
  // small (see lib/store.mjs), and this runs on every page load — three
  // connections at once here was a direct contributor to a production
  // "max clients reached" outage. One connection at a time costs a little
  // latency; it doesn't risk exhausting the pool under concurrent traffic.
  async function readSnapshot() {
    const posts = await repository.listActiveAssets();
    const scratch = await repository.listActiveIdeas();
    const settings = await repository.getSettings();
    return { posts, scratch, settings };
  }

  async function createAsset({ asset, actor, reason }) {
    const normalized = normalizePost({ ...asset, revision: 1 });
    return repository.withTransaction(async sqlTx => {
      const sortKey = await repository.nextAssetSortKey(sqlTx);
      const inserted = await repository.insertAssetRow(sqlTx, { id: normalized.id, data: normalized, sortKey, revision: normalized.revision });
      if (!inserted) return { error: "id-in-use" };
      const changeSequence = await repository.recordChange(sqlTx, {
        entityType: "asset", entityId: normalized.id, operation: "create", entityRevision: normalized.revision
      });
      await repository.setAssetChangedSequence(sqlTx, normalized.id, changeSequence);
      await repository.recordActivity(sqlTx, {
        entityType: "asset", entityId: normalized.id, actor: actor?.name || "",
        summary: reason || `${actor?.name || "Someone"} added a new asset`,
        entityRevision: normalized.revision, changedSequence: changeSequence,
        undoPayload: { type: "delete-asset", id: normalized.id, expectedRevision: normalized.revision }
      });
      return { asset: normalized };
    });
  }

  async function patchAsset({ id, revision, changes, forceFields = [], actor, reason }) {
    return repository.withTransaction(async sqlTx => {
      const row = await repository.getAssetForUpdate(sqlTx, id);
      if (!row) return { error: "not-found" };
      const post = row.data;
      const normalizedChanges = normalizeAssetChanges(changes);
      if (!Object.keys(normalizedChanges).length) return { error: "no-changes" };
      const submittedRevision = Number(revision) || 1;
      const conflicts = assetConflicts(post, submittedRevision, normalizedChanges);
      const unforcedConflicts = Object.keys(conflicts).filter(field => !forceFields.includes(field));
      if (unforcedConflicts.length) return { error: "conflict", asset: post, conflicts };

      const updatedPost = applyAssetChanges(post, normalizedChanges, actor, new Date().toISOString());
      const changeSequence = await repository.recordChange(sqlTx, {
        entityType: "asset", entityId: id, operation: "update", entityRevision: updatedPost.revision
      });
      await repository.updateAssetRow(sqlTx, { id, data: updatedPost, revision: updatedPost.revision, changedSequence: changeSequence });
      await repository.recordActivity(sqlTx, {
        entityType: "asset", entityId: id, actor: actor?.name || "",
        summary: reason ? `${actor?.name || "Team"} ${reason}` : `${actor?.name || "Team"} updated planned content`,
        entityRevision: updatedPost.revision, changedSequence: changeSequence
      });
      return { asset: updatedPost, merged: submittedRevision !== post.revision };
    });
  }

  async function deleteAsset({ id, actor, reason }) {
    return repository.withTransaction(async sqlTx => {
      const row = await repository.getAssetForUpdate(sqlTx, id);
      if (!row) return { error: "not-found" };
      const changeSequence = await repository.recordChange(sqlTx, {
        entityType: "asset", entityId: id, operation: "delete", entityRevision: row.revision
      });
      await repository.softDeleteAssetRow(sqlTx, id, changeSequence);
      await repository.recordActivity(sqlTx, {
        entityType: "asset", entityId: id, actor: actor?.name || "",
        summary: reason || `${actor?.name || "Someone"} deleted an asset`,
        entityRevision: row.revision, changedSequence: changeSequence,
        undoPayload: { type: "restore-asset", id, data: row.data, sortKey: row.sort_key, revision: row.revision }
      });
      return { ok: true, id };
    });
  }

  const SORT_KEY_GAP = 1024;
  const MIN_SORT_GAP = 0.000001;

  // Moves one asset to sit between beforeId and afterId (either may be null
  // for "move to start"/"move to end"). Normally only the moved asset's
  // sort_key changes — neighbors are locked (not modified) purely to
  // prevent a concurrent reorder from computing a conflicting midpoint in
  // the same gap. When repeated splits have shrunk that gap below
  // MIN_SORT_GAP, every active asset is re-spaced in the same transaction
  // instead, and all of them come back in `affected`.
  async function reorderAsset({ id, beforeId, afterId, actor }) {
    return repository.withTransaction(async sqlTx => {
      const lockIds = [id, beforeId, afterId].filter(Boolean);
      const locked = await repository.lockAssetsForReorder(sqlTx, lockIds);
      const movedRow = locked.get(id);
      if (!movedRow) return { error: "not-found" };
      if (beforeId && !locked.get(beforeId)) return { error: "neighbor-not-found" };
      if (afterId && !locked.get(afterId)) return { error: "neighbor-not-found" };

      const beforeKey = beforeId ? Number(locked.get(beforeId).sort_key) : null;
      const afterKey = afterId ? Number(locked.get(afterId).sort_key) : null;

      let newKey;
      if (beforeKey != null && afterKey != null) newKey = (beforeKey + afterKey) / 2;
      else if (beforeKey != null) newKey = beforeKey + SORT_KEY_GAP;
      else if (afterKey != null) newKey = afterKey / 2;
      else newKey = SORT_KEY_GAP;

      const gapTooSmall =
        (beforeKey != null && Math.abs(newKey - beforeKey) < MIN_SORT_GAP) ||
        (afterKey != null && Math.abs(newKey - afterKey) < MIN_SORT_GAP);

      let affected;
      let movedChangeSequence;
      let undoPayload;
      if (gapTooSmall) {
        const rows = await repository.listActiveAssetRowsForRespacing(sqlTx);
        const orderedIds = rows.map(row => row.id).filter(rowId => rowId !== id);
        let insertAt = orderedIds.length;
        if (beforeId) insertAt = orderedIds.indexOf(beforeId) + 1;
        else if (afterId) insertAt = Math.max(orderedIds.indexOf(afterId), 0);
        else insertAt = 0;
        orderedIds.splice(insertAt, 0, id);

        affected = [];
        for (const [index, assetId] of orderedIds.entries()) {
          const sortKey = (index + 1) * SORT_KEY_GAP;
          const changeSequence = await repository.recordChange(sqlTx, {
            entityType: "asset", entityId: assetId, operation: "reorder", entityRevision: null
          });
          if (assetId === id) movedChangeSequence = changeSequence;
          const updated = await repository.updateAssetSortKey(sqlTx, assetId, sortKey, changeSequence);
          affected.push(updated.data);
        }
        // A re-space touches every active asset's position at once — safely
        // inverting that (restoring everyone's prior sort_key) is not worth
        // the complexity for an undo button, so this reorder is left
        // non-reversible (no undoPayload), same as settings/bulk imports.
      } else {
        movedChangeSequence = await repository.recordChange(sqlTx, {
          entityType: "asset", entityId: id, operation: "reorder", entityRevision: null
        });
        const updated = await repository.updateAssetSortKey(sqlTx, id, newKey, movedChangeSequence);
        affected = [updated.data];
        undoPayload = { type: "move-asset", id, fromSortKey: Number(movedRow.sort_key), expectedSortKey: newKey };
      }

      await repository.recordActivity(sqlTx, {
        entityType: "asset", entityId: id, actor: actor?.name || "",
        summary: `${actor?.name || "Someone"} reordered the grid`,
        entityRevision: null, changedSequence: movedChangeSequence,
        undoPayload
      });

      return { asset: affected.find(asset => asset.id === id), affected, changeToken: movedChangeSequence };
    });
  }

  // Ideas use plain whole-row optimistic concurrency (a submitted revision
  // that no longer matches the row returns a conflict with the current
  // data) rather than the field-level merge assets get — idea edits are
  // low-frequency enough that this simpler model is enough, per the plan.

  async function createIdea({ idea, actor, reason }) {
    const normalized = normalizeScratchEntry({ ...idea, createdBy: actor?.name || idea?.createdBy || "", updatedBy: actor?.name || "" });
    return repository.withTransaction(async sqlTx => {
      await repository.insertIdeaRow(sqlTx, { id: normalized.id, data: normalized, revision: 1 });
      const changeSequence = await repository.recordChange(sqlTx, {
        entityType: "idea", entityId: normalized.id, operation: "create", entityRevision: 1
      });
      await repository.setIdeaChangedSequence(sqlTx, normalized.id, changeSequence);
      await repository.recordActivity(sqlTx, {
        entityType: "idea", entityId: normalized.id, actor: actor?.name || "",
        summary: reason || `${actor?.name || "Someone"} added an idea`,
        entityRevision: 1, changedSequence: changeSequence,
        undoPayload: { type: "delete-idea", id: normalized.id, expectedRevision: 1 }
      });
      return { idea: normalized, revision: 1 };
    });
  }

  async function patchIdea({ id, revision, changes, actor, reason }) {
    return repository.withTransaction(async sqlTx => {
      const row = await repository.getIdeaForUpdate(sqlTx, id);
      if (!row) return { error: "not-found" };
      const submittedRevision = Number(revision) || 1;
      // planner_ideas.revision is a Postgres BIGINT, which the `postgres`
      // package returns as a string (JS numbers can't safely represent
      // every bigint value) — compare/increment as numbers, not raw values,
      // or a same-revision save always looks like a conflict ("1" !== 1)
      // and `row.revision + 1` string-concatenates into "11" instead of 2.
      const currentRevision = Number(row.revision);
      if (currentRevision !== submittedRevision) return { error: "conflict", idea: row.data, revision: currentRevision };

      const merged = normalizeScratchEntry({ ...row.data, ...changes, updatedBy: actor?.name || row.data.updatedBy });
      const nextRevision = currentRevision + 1;
      const changeSequence = await repository.recordChange(sqlTx, {
        entityType: "idea", entityId: id, operation: "update", entityRevision: nextRevision
      });
      await repository.updateIdeaRow(sqlTx, { id, data: merged, revision: nextRevision, changedSequence: changeSequence });
      await repository.recordActivity(sqlTx, {
        entityType: "idea", entityId: id, actor: actor?.name || "",
        summary: reason || `${actor?.name || "Team"} updated an idea`,
        entityRevision: nextRevision, changedSequence: changeSequence
      });
      return { idea: merged, revision: nextRevision };
    });
  }

  async function deleteIdea({ id, actor, reason }) {
    return repository.withTransaction(async sqlTx => {
      const row = await repository.getIdeaForUpdate(sqlTx, id);
      if (!row) return { error: "not-found" };
      const changeSequence = await repository.recordChange(sqlTx, {
        entityType: "idea", entityId: id, operation: "delete", entityRevision: row.revision
      });
      await repository.softDeleteIdeaRow(sqlTx, id, changeSequence);
      await repository.recordActivity(sqlTx, {
        entityType: "idea", entityId: id, actor: actor?.name || "",
        summary: reason || `${actor?.name || "Someone"} deleted an idea`,
        entityRevision: row.revision, changedSequence: changeSequence,
        undoPayload: { type: "restore-idea", id, data: row.data, revision: row.revision }
      });
      return { ok: true, id };
    });
  }

  // Settings: a single row per workspace. Same whole-row optimistic
  // concurrency as ideas. Creates the row on first use if migration/Task 3
  // hasn't already seeded one.
  async function patchSettings({ revision, changes, actor }) {
    return repository.withTransaction(async sqlTx => {
      const row = await repository.getSettingsForUpdate(sqlTx);
      const submittedRevision = Number(revision) || 1;
      // See the identical comment in patchIdea: revision is a Postgres
      // BIGINT and comes back as a string.
      const currentRevision = row ? Number(row.revision) : 0;
      if (row && currentRevision !== submittedRevision) return { error: "conflict", settings: row.data, revision: currentRevision };

      const merged = normalizeSettings({ ...(row?.data || {}), ...changes });
      const nextRevision = currentRevision + 1;
      const changeSequence = await repository.recordChange(sqlTx, {
        entityType: "settings", entityId: "settings", operation: "update", entityRevision: nextRevision
      });
      await repository.upsertSettingsRow(sqlTx, { data: merged, revision: nextRevision, changedSequence: changeSequence });
      await repository.recordActivity(sqlTx, {
        entityType: "settings", entityId: "settings", actor: actor?.name || "",
        summary: `${actor?.name || "Team"} updated planner settings`,
        entityRevision: nextRevision, changedSequence: changeSequence
      });
      return { settings: merged, revision: nextRevision };
    });
  }

  // Undoes one activity entry's effect, but only if the entity it touched
  // hasn't changed since — settings and re-spacing reorders are marked
  // non-reversible at the point they're recorded (no undo_payload), so this
  // only ever has to handle the four "safe" shapes below. Undo is one-shot:
  // whether it succeeds or turns out to be stale, undo_payload is cleared
  // so a second click can't re-apply it or re-report staleness as new.
  async function undoActivity({ id, actor }) {
    return repository.withTransaction(async sqlTx => {
      const activityRow = await repository.getActivityForUpdate(sqlTx, id);
      if (!activityRow) return { error: "not-found" };
      const payload = activityRow.undo_payload;
      if (!payload) return { error: "not-reversible" };

      if (payload.type === "delete-asset") {
        // Inverts a create: only safe if the asset is still exactly what
        // creating it produced (nobody has edited it since).
        const row = await repository.getAssetForUpdateIncludingDeleted(sqlTx, payload.id);
        if (!row || row.deleted_at || Number(row.revision) !== Number(payload.expectedRevision)) {
          await repository.consumeActivityUndo(sqlTx, id);
          return { error: "stale" };
        }
        const changeSequence = await repository.recordChange(sqlTx, { entityType: "asset", entityId: payload.id, operation: "delete", entityRevision: row.revision });
        await repository.softDeleteAssetRow(sqlTx, payload.id, changeSequence);
        await repository.recordActivity(sqlTx, {
          entityType: "asset", entityId: payload.id, actor: actor?.name || "",
          summary: `${actor?.name || "Someone"} undid adding an asset`,
          entityRevision: row.revision, changedSequence: changeSequence
        });
        await repository.consumeActivityUndo(sqlTx, id);
        return { ok: true, entityType: "asset", entityId: payload.id, changeToken: changeSequence };
      }

      if (payload.type === "restore-asset") {
        // Inverts a delete: only safe if the asset is still exactly as
        // deleted as it was (nobody recreated/reused this id since).
        const row = await repository.getAssetForUpdateIncludingDeleted(sqlTx, payload.id);
        if (!row || !row.deleted_at) {
          await repository.consumeActivityUndo(sqlTx, id);
          return { error: "stale" };
        }
        const changeSequence = await repository.recordChange(sqlTx, { entityType: "asset", entityId: payload.id, operation: "create", entityRevision: payload.revision });
        await repository.restoreAssetRow(sqlTx, { id: payload.id, data: payload.data, sortKey: payload.sortKey, revision: payload.revision, changedSequence: changeSequence });
        await repository.recordActivity(sqlTx, {
          entityType: "asset", entityId: payload.id, actor: actor?.name || "",
          summary: `${actor?.name || "Someone"} undid deleting an asset`,
          entityRevision: payload.revision, changedSequence: changeSequence
        });
        await repository.consumeActivityUndo(sqlTx, id);
        return { ok: true, entityType: "asset", entityId: payload.id, changeToken: changeSequence };
      }

      if (payload.type === "move-asset") {
        // Inverts a reorder: only safe if nobody has moved this asset again
        // since (its sort_key must still be exactly where this move left it).
        const row = await repository.getAssetForUpdate(sqlTx, payload.id);
        if (!row || Number(row.sort_key) !== Number(payload.expectedSortKey)) {
          await repository.consumeActivityUndo(sqlTx, id);
          return { error: "stale" };
        }
        const changeSequence = await repository.recordChange(sqlTx, { entityType: "asset", entityId: payload.id, operation: "reorder", entityRevision: null });
        const updated = await repository.updateAssetSortKey(sqlTx, payload.id, payload.fromSortKey, changeSequence);
        await repository.recordActivity(sqlTx, {
          entityType: "asset", entityId: payload.id, actor: actor?.name || "",
          summary: `${actor?.name || "Someone"} undid a reorder`,
          entityRevision: null, changedSequence: changeSequence
        });
        await repository.consumeActivityUndo(sqlTx, id);
        return { ok: true, entityType: "asset", entityId: payload.id, asset: updated.data, changeToken: changeSequence };
      }

      if (payload.type === "delete-idea") {
        const row = await repository.getIdeaForUpdateIncludingDeleted(sqlTx, payload.id);
        if (!row || row.deleted_at || Number(row.revision) !== Number(payload.expectedRevision)) {
          await repository.consumeActivityUndo(sqlTx, id);
          return { error: "stale" };
        }
        const changeSequence = await repository.recordChange(sqlTx, { entityType: "idea", entityId: payload.id, operation: "delete", entityRevision: row.revision });
        await repository.softDeleteIdeaRow(sqlTx, payload.id, changeSequence);
        await repository.recordActivity(sqlTx, {
          entityType: "idea", entityId: payload.id, actor: actor?.name || "",
          summary: `${actor?.name || "Someone"} undid adding an idea`,
          entityRevision: row.revision, changedSequence: changeSequence
        });
        await repository.consumeActivityUndo(sqlTx, id);
        return { ok: true, entityType: "idea", entityId: payload.id, changeToken: changeSequence };
      }

      if (payload.type === "restore-idea") {
        const row = await repository.getIdeaForUpdateIncludingDeleted(sqlTx, payload.id);
        if (!row || !row.deleted_at) {
          await repository.consumeActivityUndo(sqlTx, id);
          return { error: "stale" };
        }
        const changeSequence = await repository.recordChange(sqlTx, { entityType: "idea", entityId: payload.id, operation: "create", entityRevision: payload.revision });
        await repository.restoreIdeaRow(sqlTx, { id: payload.id, data: payload.data, revision: payload.revision, changedSequence: changeSequence });
        await repository.recordActivity(sqlTx, {
          entityType: "idea", entityId: payload.id, actor: actor?.name || "",
          summary: `${actor?.name || "Someone"} undid deleting an idea`,
          entityRevision: payload.revision, changedSequence: changeSequence
        });
        await repository.consumeActivityUndo(sqlTx, id);
        return { ok: true, entityType: "idea", entityId: payload.id, changeToken: changeSequence };
      }

      await repository.consumeActivityUndo(sqlTx, id);
      return { error: "not-reversible" };
    });
  }

  async function latestChangeToken() {
    return repository.latestChangeSequence();
  }

  async function changesSince(since) {
    return repository.changesSince(since);
  }

  async function recentActivity() {
    return repository.listRecentActivity({ limit: 40 });
  }

  return {
    readSnapshot, createAsset, patchAsset, deleteAsset, reorderAsset, createIdea, patchIdea, deleteIdea, patchSettings,
    latestChangeToken, changesSince, undoActivity, recentActivity
  };
}
