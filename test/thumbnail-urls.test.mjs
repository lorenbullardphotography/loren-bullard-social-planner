import test from "node:test";
import assert from "node:assert/strict";
import { thumbKeyFor, thumbUrlFor } from "../lib/thumbnail-urls.mjs";

const HOST = "https://x.public.blob.vercel-storage.com";

test("thumbKeyFor maps an asset key to its jpg thumbnail key", () => {
  assert.equal(thumbKeyFor("planner/abc.jpeg"), "planner/thumbs/abc.jpg");
  assert.equal(thumbKeyFor("planner/abc.mov"), "planner/thumbs/abc.jpg");
});

test("thumbKeyFor leaves a thumbnail key unchanged", () => {
  assert.equal(thumbKeyFor("planner/thumbs/abc.jpg"), "planner/thumbs/abc.jpg");
});

test("thumbUrlFor maps a blob asset URL to its thumbnail URL on the same host", () => {
  assert.equal(thumbUrlFor(`${HOST}/planner/abc.png`), `${HOST}/planner/thumbs/abc.jpg`);
  assert.equal(thumbUrlFor(`${HOST}/planner/abc.mov`), `${HOST}/planner/thumbs/abc.jpg`);
});

test("thumbUrlFor returns empty string for URLs that cannot have thumbnails", () => {
  assert.equal(thumbUrlFor(""), "");
  assert.equal(thumbUrlFor(undefined), "");
  assert.equal(thumbUrlFor("data:image/png;base64,xx"), "");
  assert.equal(thumbUrlFor("/uploads/a.jpg"), "");
  assert.equal(thumbUrlFor("/api/instagram/image/123"), "");
  assert.equal(thumbUrlFor(`${HOST}/other/a.jpg`), "");
});

test("thumbUrlFor leaves an existing thumbnail URL unchanged", () => {
  assert.equal(thumbUrlFor(`${HOST}/planner/thumbs/abc.jpg`), `${HOST}/planner/thumbs/abc.jpg`);
});
