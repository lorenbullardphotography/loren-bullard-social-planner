import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const appJs = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const loginHtml = fs.readFileSync(new URL("../public/login.html", import.meta.url), "utf8");
const loginJs = fs.readFileSync(new URL("../public/login.js", import.meta.url), "utf8");

test("index.html contains the global page loading bar element", () => {
  assert.match(html, /<div id="pageLoadingBar" class="page-loading-bar"/);
});

test("styles.css defines page loading bar, animations, and skeleton shimmer styles", () => {
  assert.match(css, /\.page-loading-bar/);
  assert.match(css, /\.page-loading-bar\.active/);
  assert.match(css, /@keyframes pageLoadingSlide/);
  assert.match(css, /\.skeleton\b/);
  assert.match(css, /@keyframes skeletonShimmer/);
  assert.match(css, /\.skeleton-task-card/);
  assert.match(css, /\.skeleton-tile/);
  assert.match(css, /\.skeleton-library-card/);
  assert.match(css, /\.skeleton-settings-card/);
  assert.match(css, /\.loading-spinner-inline/);
  assert.match(css, /\.button-spinner/);
});

test("app.js implements skeleton renderers for all pages and views", () => {
  assert.match(appJs, /function renderTasksSkeleton/);
  assert.match(appJs, /function renderGridSkeleton/);
  assert.match(appJs, /function renderCalendarSkeleton/);
  assert.match(appJs, /function renderLibrarySkeleton/);
  assert.match(appJs, /function renderSettingsSkeleton/);
  assert.match(appJs, /function renderEditorSkeleton/);
  assert.match(appJs, /function renderAllSkeletons/);
  assert.match(appJs, /function setPageLoading/);
});

test("app.js activates page loading on init and Instagram sync", () => {
  assert.match(appJs, /async function init\(\)\s*\{[\s\S]*?setPageLoading\(true\)/);
  assert.match(appJs, /renderAllSkeletons\(\)/);
  assert.match(appJs, /async function syncInstagram\([\s\S]*?setPageLoading\(true\)/);
});

test("login page provides button loading spinner and disabled state on submit", () => {
  assert.match(loginHtml, /\.button:disabled/);
  assert.match(loginHtml, /\.button \.spinner/);
  assert.match(loginJs, /submitBtn\.disabled = true/);
  assert.match(loginJs, /submitBtn\.innerHTML = '<span class="spinner"/);
});
