import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("workflow automation settings occupy a full settings row", () => {
  const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.automation-settings\{grid-column:1 \/ -1\}/);
});
