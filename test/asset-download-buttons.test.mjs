import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const appJs = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

test("the shared editor renders universal download buttons in both the posted and editable views", () => {
  const matches = appJs.match(/id="downloadOriginalAsset"/g) || [];
  assert.equal(matches.length, 2, "expected one in the posted-locked branch and one in the editable branch");
  const detailMatches = appJs.match(/id="downloadAssetDetails"/g) || [];
  assert.equal(detailMatches.length, 2);
});

test("removes the redundant approval-gated Meta handoff download/export code", () => {
  assert.doesNotMatch(appJs, /function approvedForMeta/);
  assert.doesNotMatch(appJs, /function metaExportData/);
  assert.doesNotMatch(appJs, /function exportMetaData/);
  assert.doesNotMatch(appJs, /id="downloadApprovedAsset"/);
  assert.doesNotMatch(appJs, /id="exportMetaData"/);
});
