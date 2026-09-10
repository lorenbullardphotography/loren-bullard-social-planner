import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function assetEditorHelpers() {
  const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const helpers = source.slice(0, source.indexOf("function renderGrid()"));
  const context = {
    crypto: { randomUUID: () => "test-id" },
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    window: { matchMedia: () => ({ matches: false }) },
    URL,
    Date
  };
  vm.runInNewContext(`${helpers}\nthis.helpers = { mergeAssetEdit, assetEditorBaseline, assetEditorChanges, replaceAsset, removeConflictField, forceConflictField, mergeFreshAssets, assetEditorsFor };`, context);
  return context.helpers;
}

test("reapplies an asset edit after a shared-planner conflict without replacing newer comments", () => {
  const { mergeAssetEdit } = assetEditorHelpers();
  const latest = { id: "post-1", caption: "Old caption", comments: [{ text: "New teammate feedback" }], coverImage: "/new-cover.jpg" };
  const edited = { caption: "Updated caption", notes: "Updated notes", workflow: "needs-review", status: "draft", approval: "needs-review" };

  const merged = mergeAssetEdit(latest, edited);
  assert.equal(merged.caption, "Updated caption");
  assert.equal(merged.notes, "Updated notes");
  assert.equal(merged.workflow, "needs-review");
  assert.deepEqual(JSON.parse(JSON.stringify(merged.comments)), [{ text: "New teammate feedback" }]);
  assert.equal(merged.coverImage, "/new-cover.jpg");
});

test("sends only fields changed in the asset editor", () => {
  const { assetEditorChanges } = assetEditorHelpers();
  const baseline = { revision: 3, values: { caption: "Before", notes: "" } };
  assert.deepEqual(JSON.parse(JSON.stringify(assetEditorChanges(baseline, { caption: "After", notes: "" }))), { caption: "After" });
});

test("replaces only the saved asset in local planner state", () => {
  const { replaceAsset } = assetEditorHelpers();
  const posts = [{ id: "a", caption: "Old" }, { id: "b", caption: "Unchanged" }];
  assert.deepEqual(JSON.parse(JSON.stringify(replaceAsset(posts, { id: "a", caption: "New" }))), [{ id: "a", caption: "New", assetKind: "image", assetSource: "uploaded" }, { id: "b", caption: "Unchanged" }]);
});

test("keeps only conflicted fields pending after choosing the latest value", () => {
  const { removeConflictField } = assetEditorHelpers();
  assert.deepEqual(JSON.parse(JSON.stringify(removeConflictField({ caption: "Mine", notes: "Notes" }, "caption"))), { notes: "Notes" });
});

test("adds a selected field to the explicit force list", () => {
  const { forceConflictField } = assetEditorHelpers();
  assert.deepEqual(JSON.parse(JSON.stringify(forceConflictField([], "caption"))), ["caption"]);
  assert.deepEqual(JSON.parse(JSON.stringify(forceConflictField(["caption"], "caption"))), ["caption"]);
  assert.deepEqual(JSON.parse(JSON.stringify(forceConflictField(["notes"], "caption"))), ["notes", "caption"]);
});

test("keeps local assets unless the shared copy has a newer asset revision", () => {
  const { mergeFreshAssets } = assetEditorHelpers();
  const local = [
    { id: "a", revision: 3, caption: "My latest" },
    { id: "b", revision: 2, caption: "Keep this" }
  ];
  const latest = [
    { id: "a", revision: 2, caption: "Older server copy" },
    { id: "b", revision: 4, caption: "Teammate update" },
    { id: "c", revision: 1, caption: "New asset" }
  ];

  assert.deepEqual(JSON.parse(JSON.stringify(mergeFreshAssets(local, latest))), [
    { id: "a", revision: 3, caption: "My latest" },
    { id: "b", revision: 4, caption: "Teammate update" },
    { id: "c", revision: 1, caption: "New asset" }
  ]);
});

test("removes an asset missing from a newer planner snapshot", () => {
  const { mergeFreshAssets } = assetEditorHelpers();
  const local = [{ id: "a", revision: 3 }, { id: "b", revision: 2 }];
  const latest = [{ id: "a", revision: 3 }];

  assert.deepEqual(JSON.parse(JSON.stringify(mergeFreshAssets(local, latest, { preserveMissing: false }))), [{ id: "a", revision: 3 }]);
});

test("identifies only teammates editing the selected asset", () => {
  const { assetEditorsFor } = assetEditorHelpers();
  const people = [
    { name: "Loren", editing: { assetId: "post-a", field: "caption" } },
    { name: "Brooke", editing: { assetId: "post-a", field: "notes" } },
    { name: "Maya", editing: { assetId: "post-b", field: "approval" } }
  ];

  assert.deepEqual(JSON.parse(JSON.stringify(assetEditorsFor("post-a", people, "Loren"))), [
    { name: "Brooke", editing: { assetId: "post-a", field: "notes" } }
  ]);
});
