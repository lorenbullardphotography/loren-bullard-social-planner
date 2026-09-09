import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("uses the top bar as the only page-level H1", () => {
  assert.match(html, /<h1 id="pageTitle">Grid Planner<\/h1>/);
  assert.doesNotMatch(html, /<div><h1>Studio Planner<\/h1>/);
  assert.doesNotMatch(html, /<section id="view-(tasks|calendar|library|approvals|settings)"[^>]*>[\s\S]*?<h3>(Tasks|Content Calendar|Library|Approvals|Planner settings)<\/h3>/);
});

test("places Tasks before Grid Planner and owns the brand banner", () => {
  const nav = html.slice(html.indexOf("<nav>"), html.indexOf("</nav>"));
  assert.ok(nav.indexOf('data-view="tasks"') < nav.indexOf('data-view="grid"'));
  const grid = html.slice(html.indexOf('<section id="view-grid"'), html.indexOf('<section id="view-tasks"'));
  const tasks = html.slice(html.indexOf('<section id="view-tasks"'), html.indexOf('<section id="view-calendar"'));
  assert.doesNotMatch(grid, /class="brand-banner"/);
  assert.match(tasks, /class="brand-banner"/);
  assert.ok(tasks.indexOf('class="brand-banner"') < tasks.indexOf('class="intro"'));
});
