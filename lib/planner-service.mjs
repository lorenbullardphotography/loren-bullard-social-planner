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
import { normalizePost, normalizeAssetChanges, applyAssetChanges, assetConflicts } from "../server.mjs";

export function createPlannerService({ repository }) {
  async function readSnapshot() {
    const assets = await repository.listActiveAssets();
    return { assets };
  }

  async function createAsset({ asset, actor, reason }) {
    const normalized = normalizePost({ ...asset, revision: 1 });
    return repository.withTransaction(async sqlTx => {
      const sortKey = await repository.nextAssetSortKey(sqlTx);
      await repository.insertAssetRow(sqlTx, { id: normalized.id, data: normalized, sortKey, revision: normalized.revision });
      const changeSequence = await repository.recordChange(sqlTx, {
        entityType: "asset", entityId: normalized.id, operation: "create", entityRevision: normalized.revision
      });
      await repository.setAssetChangedSequence(sqlTx, normalized.id, changeSequence);
      await repository.recordActivity(sqlTx, {
        entityType: "asset", entityId: normalized.id, actor: actor?.name || "",
        summary: reason || `${actor?.name || "Someone"} added a new asset`,
        entityRevision: normalized.revision, changedSequence: changeSequence,
        undoPayload: { type: "delete-asset", id: normalized.id }
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

  return { readSnapshot, createAsset, patchAsset, deleteAsset };
}
