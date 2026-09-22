import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function appJsHelpers() {
  const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const helpers = source.slice(0, source.indexOf("function renderGrid()"));
  const context = {
    crypto: { randomUUID: () => "test-id" },
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    window: { matchMedia: () => ({ matches: false }) },
    URL,
    Date
  };
  vm.runInNewContext(`${helpers}\nthis.helpers = { assetDetailsText, extensionForMime };`, context);
  return context.helpers;
}

test("assetDetailsText lists only populated fields, one labeled line each", () => {
  const { assetDetailsText } = appJsHelpers();
  const text = assetDetailsText({
    type: "IMAGE",
    caption: "Golden hour session",
    hashtags: "#nwafamily",
    date: "2026-09-15",
    time: "08:30",
    approval: "approved",
    assignee: "Loren"
  });
  assert.match(text, /^Caption: Golden hour session$/m);
  assert.match(text, /^Hashtags: #nwafamily$/m);
  assert.match(text, /^Format: IMAGE$/m);
  assert.match(text, /^Scheduled: 2026-09-15 08:30$/m);
  assert.match(text, /^Approval: Approved$/m);
  assert.match(text, /^Assignee: Loren$/m);
  assert.doesNotMatch(text, /^Notes:/m);
  assert.doesNotMatch(text, /^Audio:/m);
  assert.doesNotMatch(text, /^Location:/m);
});

test("assetDetailsText falls back to the location tag name when location is unset", () => {
  const { assetDetailsText } = appJsHelpers();
  const text = assetDetailsText({ type: "IMAGE", locationTag: { name: "Crystal Bridges" } });
  assert.match(text, /^Location: Crystal Bridges$/m);
});

test("extensionForMime maps common mime types to file extensions", () => {
  const { extensionForMime } = appJsHelpers();
  assert.equal(extensionForMime("image/jpeg"), "jpeg");
  assert.equal(extensionForMime("image/png"), "png");
  assert.equal(extensionForMime("video/mp4"), "mp4");
  assert.equal(extensionForMime("video/quicktime"), "mov");
});
