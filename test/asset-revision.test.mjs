import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizePost,
  normalizeAssetChanges,
  applyAssetChanges,
  assetConflicts,
  ASSET_EDITABLE_FIELDS
} from "../server.mjs";

test("normalizes a legacy post with an initial revision", () => {
  const normalized = normalizePost({ id: "asset-1", image: "/photo.jpg" });
  assert.equal(normalized.revision, 1);
  assert.deepEqual(normalized.fieldUpdatedRevision, {});
  assert.deepEqual(normalized.fieldUpdatedAt, {});
  assert.deepEqual(normalized.fieldUpdatedBy, {});
});

test("records metadata only for fields that changed", () => {
  const initial = normalizePost({ id: "asset-1", image: "/photo.jpg", revision: 3, caption: "Before" });
  const updated = applyAssetChanges(
    initial,
    { caption: "After" },
    { name: "Loren" },
    "2026-09-08T20:00:00.000Z"
  );
  assert.equal(updated.revision, 4);
  assert.equal(updated.caption, "After");
  assert.equal(updated.fieldUpdatedRevision.caption, 4);
  assert.equal(updated.fieldUpdatedBy.caption, "Loren");
  assert.equal(updated.fieldUpdatedAt.caption, "2026-09-08T20:00:00.000Z");
});

test("normalizes only allowed editable asset fields", () => {
  const changes = normalizeAssetChanges({
    caption: "New caption",
    priority: "high",
    invalidField: "discard me",
    revision: 99
  });
  assert.deepEqual(changes, {
    caption: "New caption",
    priority: "high"
  });
});

test("detects same-field conflicts when fieldUpdatedRevision is newer than submitted revision", () => {
  const post = normalizePost({
    id: "asset-1",
    image: "/photo.jpg",
    revision: 5,
    caption: "Teammate caption",
    fieldUpdatedRevision: { caption: 5, notes: 3 },
    fieldUpdatedAt: { caption: "2026-09-08T20:00:00.000Z" },
    fieldUpdatedBy: { caption: "Brooke" }
  });

  const conflicts = assetConflicts(post, 3, { caption: "My caption", notes: "My notes" });
  assert.ok(conflicts.caption);
  assert.equal(conflicts.caption.currentValue, "Teammate caption");
  assert.equal(conflicts.caption.updatedBy, "Brooke");
  assert.equal(conflicts.caption.updatedAt, "2026-09-08T20:00:00.000Z");
  assert.equal(conflicts.notes, undefined);
});
