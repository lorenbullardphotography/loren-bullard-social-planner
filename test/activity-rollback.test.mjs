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
