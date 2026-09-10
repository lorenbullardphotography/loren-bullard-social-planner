import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("loads an existing planner without rewriting it through bootstrap", () => {
  const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const loadPlanner = source.match(/async function loadPlanner\(\) \{([\s\S]*?)\n\}/)?.[1] || "";

  assert.match(loadPlanner, /if \(!planner\.posts\?\.length\)/);
  assert.doesNotMatch(loadPlanner, /setPlanner\(planner\);[\s\S]*planner\/bootstrap/);
});
