import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function mergeAssetEdit() {
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
  vm.runInNewContext(`${helpers}\nthis.mergeAssetEdit = mergeAssetEdit;`, context);
  return context.mergeAssetEdit;
}

test("reapplies an asset edit after a shared-planner conflict without replacing newer comments", () => {
  const merge = mergeAssetEdit();
  const latest = { id: "post-1", caption: "Old caption", comments: [{ text: "New teammate feedback" }], coverImage: "/new-cover.jpg" };
  const edited = { caption: "Updated caption", notes: "Updated notes", workflow: "needs-review", status: "draft", approval: "needs-review" };

  const merged = merge(latest, edited);
  assert.equal(merged.caption, "Updated caption");
  assert.equal(merged.notes, "Updated notes");
  assert.equal(merged.workflow, "needs-review");
  assert.deepEqual(JSON.parse(JSON.stringify(merged.comments)), [{ text: "New teammate feedback" }]);
  assert.equal(merged.coverImage, "/new-cover.jpg");
});
