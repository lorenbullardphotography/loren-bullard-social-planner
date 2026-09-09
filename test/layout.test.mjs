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

test("uses a larger meaningful SVG icon for every sidebar view", () => {
  const nav = html.slice(html.indexOf("<nav>"), html.indexOf("</nav>"));
  for (const view of ["tasks", "grid", "calendar", "library", "settings"]) {
    const item = nav.match(new RegExp(`<button[^>]*data-view="${view}"[\\s\\S]*?<\\/button>`))?.[0] || "";
    assert.match(item, /<svg class="nav-icon"[^>]*aria-hidden="true"/);
  }
  for (const view of ["tasks", "grid", "calendar", "library", "settings"]) {
    assert.match(nav, new RegExp(`data-view="${view}"[\\s\\S]*?<svg class="nav-icon"[^>]*data-icon="${view}"`));
  }
});

test("moves approvals into the Tasks view", () => {
  assert.doesNotMatch(html, /data-view="approvals"/);
  assert.doesNotMatch(html, /id="view-approvals"/);
  const tasks = html.slice(html.indexOf('<section id="view-tasks"'), html.indexOf('<section id="view-calendar"'));
  assert.match(tasks, /id="approvalsTab"[^>]*>Approvals/);
  assert.match(tasks, /id="approvalPanel"/);
});

test("gives task card arrows a centered, consistent trailing affordance", () => {
  const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.attention-card i\{[^}]*width:24px[^}]*height:24px/);
  assert.match(css, /\.attention-card i\{[^}]*display:grid[^}]*place-items:center/);
  assert.match(css, /\.attention-card i\{[^}]*font-style:normal/);
});

test("uses a cog shape for the Settings sidebar icon", () => {
  const settings = html.match(/<svg class="nav-icon" data-icon="settings"[\s\S]*?<\/svg>/)?.[0] || "";
  assert.match(settings, /<path d="M12\.22 2/);
  assert.match(settings, /<circle cx="12" cy="12" r="3"/);
});

test("keeps Settings as a single sidebar entry point", () => {
  assert.doesNotMatch(html, /id="settingsBtn"/);
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /\$\("#settingsBtn"\)/);
});

test("keeps collapsed sidebar labels hidden for the active item", () => {
  const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.nav\{justify-content:center;font-size:0\}/);
  assert.doesNotMatch(css, /\.nav:not\(\.active\)\{font-size:0\}/);
  assert.match(css, /\.nav-label\{display:none\}/);
  const nav = html.slice(html.indexOf("<nav>"), html.indexOf("</nav>"));
  assert.equal((nav.match(/class="nav-label"/g) || []).length, 5);
});

test("provides a hamburger-controlled mobile navigation drawer", () => {
  assert.match(html, /id="mobileMenuBtn"[^>]*aria-controls="mobileMenu"/);
  assert.match(html, /id="mobileMenuBackdrop"/);
  assert.match(html, /id="mobileMenu"/);
  const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.mobile-menu-toggle/);
  assert.match(css, /\.mobile-menu-backdrop/);
  assert.match(css, /\.mobile-menu-open \.side/);
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /mobileMenuBtn/);
  assert.match(app, /mobileMenuBackdrop/);
});

test("provides calendar controls for returning to today and a mobile agenda", () => {
  assert.match(html, /id="todayMonth"/);
  assert.match(html, /id="calendarAgenda"/);
  const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.calendar-agenda/);
  assert.match(css, /@media\(max-width:700px\)[\s\S]*\.calendar-agenda/);
});

test("opens calendar posts directly in the edit asset view", () => {
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /openPost\(node\.dataset\.open, true\)/);
  assert.match(app, /data-calendar-more/);
  assert.match(app, /\$\("#calendar"\)\.querySelectorAll\("\[data-open\]"\)/);
});

test("supports week, month, and year calendar views with an independent Today action", () => {
  assert.match(html, /id="todayMonth"[^>]*>Today/);
  assert.match(html, /id="calendarViewSwitcher"/);
  for (const view of ["week", "month", "year"]) assert.match(html, new RegExp("data-calendar-view=\"" + view + "\""));
  const calendar = html.slice(html.indexOf('<section id="view-calendar"'), html.indexOf('<section id="view-library"'));
  assert.ok(calendar.indexOf('id="todayMonth"') < calendar.indexOf('class="month-nav"'));
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /calendarView/);
  assert.match(app, /is-today/);
});

test("lets the yearly calendar overview span the full calendar surface", () => {
  const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.calendar-year\{[^}]*grid-column:1 \/ -1/);
});

test("supports showing and hiding synced Instagram posts on the calendar", () => {
  assert.match(html, /id="calendarInstagramToggle"/);
  assert.match(html, /Show Instagram posts/);
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /calendarShowInstagram/);
  assert.match(app, /instagram-badge/);
  assert.match(app, /status === "posted"/);
});

test("pulls all synced posts in calendar view while grid view respects settings sync count", () => {
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /function calendarPosts\(\)\s*\{[\s\S]*?calendarShowInstagram \? \[\.\.\.future\(\), \.\.\.posted\(\)\] : future\(\)/);
  assert.match(app, /function visiblePosted\(\)\s*\{[\s\S]*?\.slice\(0, Number\(settings\.syncPhotoCount\) \|\| 12\)/);
  assert.match(app, /function ordered\(\)\s*\{ return \[\.\.\.future\(\), \.\.\.visiblePosted\(\)\]; \}/);
});

test("opens instagram post in a separate tab when clicked in calendar view", () => {
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /window\.open\(post\.permalink \|\| "https:\/\/www\.instagram\.com\/", "_blank", "noopener,noreferrer"\)/);
  assert.match(app, /node\.setAttribute\("aria-label", `Open \$\{esc\(post\.caption \|\| "Instagram post"\)\} on Instagram`\)/);
});

test("server syncs all instagram media without restricting by syncPhotoCount", () => {
  const server = fs.readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /async function getInstagramMedia\(token, limit = null\)/);
  assert.match(server, /getInstagramMedia\(session\.access_token\)/);
});

