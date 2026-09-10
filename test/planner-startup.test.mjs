import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("loads an existing planner without rewriting it through bootstrap", () => {
  const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const loadPlanner = source.match(/async function loadPlanner\(\) \{([\s\S]*?)\n\}/)?.[1] || "";

  assert.match(loadPlanner, /if \(!planner\.posts\?\.length\)/);
  assert.doesNotMatch(loadPlanner, /setPlanner\(planner\);[\s\S]*planner\/bootstrap/);
});

test("refreshes asset edit indicators when shared presence changes", () => {
  const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const refreshSharedPlanner = source.match(/async function refreshSharedPlanner\(\) \{([\s\S]*?)\n\}/)?.[1] || "";

  assert.match(refreshSharedPlanner, /presence = latest\.presence;\s*renderPresenceIndicators\(\);/);
});

test("does not use high-frequency presence polling that can block shared storage", () => {
  const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

  assert.doesNotMatch(source, /setInterval\(refreshPresence,/);
  assert.doesNotMatch(source, /startPresencePolling\(\)/);
});

test("only polls the shared planner while the tab is visible, at a low frequency", () => {
  const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

  const intervalCall = source.match(/setInterval\(\(\) => \{\s*if \(document\.visibilityState === "visible"\) refreshSharedPlanner\(\);\s*\}, (\d+)\)/);
  assert.ok(intervalCall, "expected a visibility-gated refreshSharedPlanner interval");
  assert.ok(Number(intervalCall[1]) >= 30000, "polling interval should be at least 30 seconds to limit Fast Origin Transfer usage");
  assert.match(source, /document\.addEventListener\("visibilitychange", \(\) => \{\s*if \(document\.visibilityState === "visible"\) refreshSharedPlanner\(\);\s*\}\)/);
});
