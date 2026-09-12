import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const appJs = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

test("removes the Open Meta button/link from the Meta handoff section", () => {
  assert.doesNotMatch(appJs, />Open Meta</);
  assert.doesNotMatch(appJs, /href="https:\/\/business\.facebook\.com\/latest\/home"/);
});

test("removes the check photo metadata button and EXIF GPS reading functions", () => {
  assert.doesNotMatch(appJs, /id="readLocationMetadata"/);
  assert.doesNotMatch(appJs, /Check photo metadata/);
  assert.doesNotMatch(appJs, /id="locationHelp"/);
  assert.doesNotMatch(appJs, /function readExifGps/);
  assert.doesNotMatch(appJs, /function parseExifGps/);
  assert.doesNotMatch(appJs, /function readExifGpsFromUrl/);
});

test("preserves the location input field", () => {
  assert.match(appJs, /<input id="eLocation"/);
  assert.match(appJs, /post\.location = /);
});
