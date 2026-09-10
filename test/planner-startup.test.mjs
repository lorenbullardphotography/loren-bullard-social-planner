import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("loads an existing planner without rewriting it through bootstrap", () => {
  const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const loadPlanner = source.match(/async function loadPlanner\(\) \{([\s\S]*?)\n\}/)?.[1] || "";

  assert.match(loadPlanner, /if \(!planner\.posts\?\.length\)/);
  assert.doesNotMatch(loadPlanner, /setPlanner\(planner\);[\s\S]*planner\/bootstrap/);
});

test("does not use any presence heartbeat/polling that can block shared storage", () => {
  const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

  assert.doesNotMatch(source, /setInterval\(refreshPresence,/);
  assert.doesNotMatch(source, /startPresencePolling\(\)/);
  assert.doesNotMatch(source, /\bheartbeat\(\)/);
  assert.doesNotMatch(source, /\/api\/planner\/presence/);
});

test("polls the row-storage change feed only while the tab is visible, and only falls back to a whole-document poll at the slower Fast-Origin-Transfer-safe cadence", () => {
  const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

  // The delta poll itself must query GET /api/planner/changes, not the
  // whole document.
  assert.match(source, /fetch\(`\/api\/planner\/changes\?since=\$\{since\}`\)/);

  // A poll that had to fall back to the legacy whole-document endpoint
  // (row storage not enabled) must not be rescheduled at the fast delta
  // cadence — this is the same Fast Origin Transfer overage this codebase
  // has already had to fix once, and it would come back at 5s instead of
  // the 30s it was fixed at if the fallback path used the fast cadence.
  assert.match(source, /PLANNER_POLL_DELTA_MS\s*=\s*5000/);
  assert.match(source, /PLANNER_POLL_FALLBACK_MS\s*=\s*30000/);
  assert.match(source, /schedulePlannerPoll\(outcome === "fallback" \? PLANNER_POLL_FALLBACK_MS : PLANNER_POLL_DELTA_MS\)/);

  // Polling must pause while the tab is hidden, and refresh immediately on
  // focus/visibilitychange.
  assert.match(source, /if \(document\.visibilityState !== "visible"\) \{\s*schedulePlannerPoll\(PLANNER_POLL_DELTA_MS\);\s*return;\s*\}/);
  assert.match(source, /window\.addEventListener\("focus", \(\) => \{ refreshSharedPlanner\(\); checkInstagram\(\); \}\);/);
  assert.match(source, /document\.addEventListener\("visibilitychange", \(\) => \{\s*if \(document\.visibilityState === "visible"\) refreshSharedPlanner\(\);\s*\}\);/);
});

test("retains unsaved local edits on the selected asset instead of overwriting them with an incoming delta", () => {
  const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const applyPlannerDelta = source.match(/function applyPlannerDelta\(delta\) \{([\s\S]*?)\n\}/)?.[1] || "";

  assert.match(applyPlannerDelta, /if \(change\.entityId === selected && editorDirty\)/);
  assert.doesNotMatch(applyPlannerDelta, /replaceAsset\(posts, .*\);\s*continue/);
});
