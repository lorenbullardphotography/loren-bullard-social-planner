import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const loginHtml = fs.readFileSync(new URL("../public/login.html", import.meta.url), "utf8");

test("mobile drawer restores brand title, team presence, and identity actions", () => {
  assert.match(css, /body\.mobile-menu-open \.side \.brand\{display:flex/);
  assert.match(css, /body\.mobile-menu-open \.side \.brand>div:last-child\{font-size:inherit\}/);
  assert.match(css, /body\.mobile-menu-open \.side \.brand-title\{display:block/);
  assert.match(css, /body\.mobile-menu-open \.side \.brand p\{display:block/);
  assert.match(css, /body\.mobile-menu-open \.side \.team-card\{display:grid\}/);
  assert.match(css, /body\.mobile-menu-open \.side \.ghost\.light\{display:inline-flex\}/);
  assert.match(css, /body\.mobile-menu-open \.side\{[^}]*z-index:100/);
  assert.match(css, /\.mobile-menu-backdrop\{[^}]*z-index:90/);
  assert.match(html, /id="mobileDrawerClose"/);
  assert.match(app, /mobileDrawerClose/);
});

test("mobile header stays sticky when scrolling and hides action buttons when drawer is open", () => {
  assert.match(css, /@media\(max-width:700px\)\{[\s\S]*?\.top\{[^}]*position:sticky;top:0/);
  assert.match(css, /@media\(max-width:700px\)\{[\s\S]*?\.top\{[^}]*height:auto/);
  assert.match(css, /body\.mobile-menu-open \.top-actions\{display:none!important\}/);
});

test("tablet viewport maintains a 2-column workspace and collapsed icon navigation", () => {
  assert.match(css, /@media\(min-width:701px\) and \(max-width:1100px\)\{\.workspace\{grid-template-columns:minmax\(0,1fr\) minmax\(280px,340px\);gap:16px\}\}/);
  assert.match(css, /@media\(max-width:1050px\)\{\.app\{grid-template-columns:78px 1fr\}/);
});

test("mobile viewport provides clean stacked workspace and flexible top actions", () => {
  assert.match(css, /@media\(max-width:700px\)\{[\s\S]*?\.workspace\{display:block;grid-template-columns:1fr\}/);
  assert.match(css, /@media\(max-width:700px\)\{[\s\S]*?\.top-actions\{grid-column:1 \/ -1;width:100%;display:flex;gap:8px;flex-wrap:wrap/);
  assert.match(css, /\.top-actions \.upload-status\{flex:1 0 100%;text-align:center/);
});

test("modals and toast notifications enforce viewport safe constraints", () => {
  assert.match(css, /\.modal\{[^}]*max-height:calc\(100vh - 32px\);overflow-y:auto/);
  assert.match(css, /\.toast\{[^}]*max-width:calc\(100vw - 32px\)/);
});

test("tab bars and filters enable smooth horizontal touch scrolling", () => {
  assert.match(css, /\.task-tabs\{[^}]*overflow-x:auto/);
  assert.match(css, /\.task-tabs\{[^}]*-webkit-overflow-scrolling:touch/);
  assert.match(css, /\.task-tab\{[^}]*white-space:nowrap/);
  assert.match(css, /\.library-tabs\{[^}]*overflow-x:auto/);
  assert.match(css, /\.library-tab\{[^}]*white-space:nowrap/);
});

test("grid reorder animates tiles into their new positions", () => {
  assert.match(css, /\.tile\{[^}]*transition:[^}]*transform/);
  assert.match(app, /animateGridReorder/);
});

test("live rearranging animates surrounding tiles as asset is dragged", () => {
  assert.match(app, /activateGridDrag/);
  assert.match(app, /updateGridDragMove/);
  assert.match(app, /completeGridDrag/);
  assert.match(css, /\.tile\.dragging\{[^}]*box-shadow/);
  assert.match(css, /#grid\.is-reordering/);
});

test("mobile drag surfaces suppress native text selection and narrow calendar overflow", () => {
  assert.match(css, /\.tile,\.tile \*.*-webkit-user-select:none/);
  assert.match(css, /\.cal-post,\.cal-post \*.*-webkit-user-select:none/);
  assert.match(css, /\.month-nav\{[^}]*min-width:0/);
  assert.match(app, /selectstart/);
});

test("grid asset editing uses a mobile modal with an explicit close control", () => {
  assert.match(css, /#view-grid\.grid-editor-open::before\{[^}]*position:fixed/);
  assert.match(css, /#view-grid\.grid-editor-open \.inspector\{[^}]*position:fixed/);
  assert.match(css, /#view-grid\.grid-editor-open \.mobile-editor-close\{[^}]*display:grid/);
  assert.match(app, /function closeGridEditor\(\)/);
  assert.match(app, /class="mobile-editor-close"/);
});

test("desktop grid reordering starts only from the drag handle", () => {
  assert.match(app, /event\.pointerType === "mouse" && !event\.target\.closest\("\.handle"\)/);
  assert.match(css, /\.handle\{[^}]*cursor:grab/);
});

test("mobile tab bars and calendar controls can shrink without clipping", () => {
  assert.match(css, /\.task-tabs\{[^}]*min-width:0/);
  assert.match(css, /\.library-tabs\{[^}]*min-width:0/);
  assert.match(css, /\.task-tabs\{[^}]*width:100%/);
  assert.match(css, /\.calendar-toolbar>\*\{[^}]*min-width:0/);
  assert.match(css, /\.calendar-view-switcher\{[^}]*min-width:0/);
});

test("calendar cells keep long post captions inside their columns", () => {
  assert.match(css, /\.calendar\{[^}]*grid-template-columns:repeat\(7,minmax\(0,1fr\)\)/);
  assert.match(css, /\.day\{[^}]*min-width:0[^}]*overflow:hidden/);
  assert.match(css, /\.cal-post\{[^}]*min-width:0/);
  assert.match(css, /\.cal-post span\{[^}]*min-width:0[^}]*white-space:nowrap[^}]*overflow:hidden/);
});

test("login page scales padding and typography for narrow mobile devices", () => {
  assert.match(loginHtml, /@media\(max-width:380px\)\{\.card\{padding:22px 18px\}/);
});
