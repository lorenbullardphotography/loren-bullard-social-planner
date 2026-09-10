import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
const appJs = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("server records rollback snapshots and guards stale restores", () => {
  assert.match(server, /planner-rollback-history/);
  assert.match(server, /rollbackSnapshot/);
  assert.ok(server.includes("record.restoreUpdatedAt"));
  assert.match(server, /That activity can no longer be undone/);
  assert.match(server, /This activity is no longer the latest planner change/);
  assert.match(server, /addActivity\(planner, `\$\{body\?\.actor\?\.name \|\| "Team"\} synced Instagram`\)/);
  assert.match(server, /planner\.activity = planner\.activity\.map/);
});

test("activity feed includes an accessible undo control and rollback request", () => {
  assert.match(appJs, /data-rollback-id/);
  assert.ok(appJs.includes("/api/planner/rollback/"));
  assert.ok(appJs.includes("openUndoConfirmation"));
  assert.match(appJs, /Activity undone/);
  assert.match(appJs, /event\.metaKey/);
  assert.match(appJs, /event\.preventDefault\(\)/);
  assert.ok(appJs.includes("target.closest?.(\"input, textarea, select, [contenteditable='true']\")"));
  assert.ok(appJs.includes("openUndoConfirmation(latest.rollbackId)"));
  assert.match(html, /id="rollbackConfirmModal"/);
  assert.match(html, /id="confirmRollbackBtn"/);
});

test("undo tries the entity-scoped row-storage endpoint first, falling back to the legacy whole-planner rollback only when it isn't enabled", () => {
  const undoActivityBody = appJs.match(/async function undoActivity\(activityId, button = null\) \{([\s\S]*?)\n\}/)?.[1] || "";

  // Row storage path: a narrow, per-activity endpoint, not the legacy
  // whole-document one.
  assert.match(undoActivityBody, /\/api\/activity\/\$\{encodeURIComponent\(activityId\)\}\/undo/);
  assert.match(undoActivityBody, /narrowOrFallback/);

  // The legacy /api/planner/rollback/ call must still exist, but only
  // inside the fallback branch (row storage not enabled) — not as the
  // normal path.
  assert.match(undoActivityBody, /if \(result\.fallback\) \{[\s\S]*?\/api\/planner\/rollback\//);

  // A stale row-storage undo must show its own message and never replace
  // the whole local planner the way the legacy path's setPlanner(...) does.
  assert.match(undoActivityBody, /UNDO_STALE/);
  assert.match(undoActivityBody, /can no longer be safely undone/);
});
