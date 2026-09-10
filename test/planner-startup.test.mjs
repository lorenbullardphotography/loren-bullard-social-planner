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

test("polls lightweight presence separately from the full planner refresh", () => {
  const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(source, /async function refreshPresence\(\)[\s\S]*api\("\/api\/planner\/presence"\)/);
  assert.match(source, /setInterval\(refreshPresence, 2000\)/);
});
