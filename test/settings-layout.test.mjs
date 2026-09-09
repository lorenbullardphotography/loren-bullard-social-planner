import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("workflow automation settings occupy a full settings row", () => {
  const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.automation-settings\{grid-column:1 \/ -1\}/);
});

test("content pillars, formats, and goals are separated into balanced cards", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const settingsSection = html.slice(html.indexOf('id="view-settings"'), html.indexOf('</section>\n  </main>'));
  assert.match(settingsSection, /<h4>Content pillars<\/h4>[\s\S]*?<textarea id="settingsPillars"/);
  assert.match(settingsSection, /<h4>Formats<\/h4>[\s\S]*?<textarea id="settingsFormats"/);
  assert.match(settingsSection, /<h4>Content goals<\/h4>[\s\S]*?<textarea id="settingsGoals"/);
  // Ensure formats and goals are in separate sections rather than one crammed section
  const formatCard = settingsSection.match(/<section class="settings-card">[\s\S]*?<h4>Formats<\/h4>[\s\S]*?<\/section>/)?.[0] || "";
  assert.doesNotMatch(formatCard, /id="settingsGoals"/);
});

test("account settings span 2 columns and automations use a responsive subgrid", () => {
  const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.account-settings\{grid-column:span 2\}/);
  assert.match(css, /\.automation-list\{display:grid;grid-template-columns:repeat\(auto-fit,minmax\(280px,1fr\)\)/);
});

