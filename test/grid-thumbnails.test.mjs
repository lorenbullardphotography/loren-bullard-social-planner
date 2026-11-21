import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { thumbUrlFor as libThumbUrlFor, thumbKeyFor as libThumbKeyFor } from "../lib/thumbnail-urls.mjs";

const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const slice = (from, to) => source.slice(source.indexOf(from), source.indexOf(to));

const HOST = "https://s.public.blob.vercel-storage.com";
function makeContext() {
  const context = vm.createContext({
    URL,
    esc: value => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"),
    document: { createElement: tag => ({ tag, dataset: {}, classList: { add() {} }, style: {} }) }
  });
  vm.runInContext(slice("function thumbKeyFor", "function canvasToThumbBlob"), context);
  vm.runInContext(slice("function assetKindOf", "function assetSourceOf"), context);
  vm.runInContext(slice("function hasReelCover", "function carouselImages"), context);
  vm.runInContext(slice("function tileImageAttrs", "function libraryAssetBadges"), context);
  vm.runInContext(slice("const BROKEN_IMAGE_PLACEHOLDER", "if (typeof document.addEventListener"), context);
  return context;
}

test("app.js thumbnail helpers agree with lib/thumbnail-urls.mjs on shared cases", () => {
  const context = makeContext();
  for (const url of [`${HOST}/planner/a.jpeg`, `${HOST}/planner/a.mov`, `${HOST}/planner/thumbs/a.jpg`, `${HOST}/other/a.jpg`, "", "data:image/png;base64,xx", "/uploads/a.jpg", "/api/instagram/image/1"]) {
    assert.equal(context.thumbUrlFor(url), libThumbUrlFor(url), url);
  }
  for (const key of ["planner/a.jpeg", "planner/a.mov", "planner/thumbs/a.jpg", "x/a.jpg", ""]) {
    assert.equal(context.thumbKeyFor(key), libThumbKeyFor(key), key);
  }
});

test("an uploaded image tile loads the thumbnail lazily and keeps the original as fallback", () => {
  const context = makeContext();
  const html = context.tileImageMarkup({ image: `${HOST}/planner/a.jpeg`, type: "IMAGE" }, "tile-media");
  assert.match(html, new RegExp(`src="${HOST}/planner/thumbs/a\\.jpg"`));
  assert.match(html, new RegExp(`data-fallback-src="${HOST}/planner/a\\.jpeg"`));
  assert.match(html, /loading="lazy"/);
  assert.match(html, /decoding="async"/);
});

test("instagram, data and local upload images keep their own src with no fallback attribute", () => {
  const context = makeContext();
  for (const image of ["/api/instagram/image/123", "data:image/png;base64,xx", "/uploads/a.jpg"]) {
    const html = context.tileImageMarkup({ image, type: "IMAGE" });
    assert.ok(html.includes(`src="${image}"`), image);
    assert.doesNotMatch(html, /data-fallback/);
    assert.match(html, /loading="lazy"/);
  }
});

test("a reel with a cover image uses the cover, not the video", () => {
  const context = makeContext();
  const html = context.tileImageMarkup({ image: `${HOST}/planner/v.mov`, coverImage: `${HOST}/planner/c.jpeg`, type: "REEL", assetKind: "video" });
  assert.match(html, /planner\/thumbs\/c\.jpg/);
  assert.doesNotMatch(html, /video/);
});

test("a video without a cover renders its thumbnail with a video fallback; without a possible thumbnail it renders a metadata-only video", () => {
  const context = makeContext();
  const withThumb = context.tileImageMarkup({ image: `${HOST}/planner/v.mov`, type: "REEL", assetKind: "video" }, "x", { allowVideo: true });
  assert.match(withThumb, /planner\/thumbs\/v\.jpg/);
  assert.match(withThumb, new RegExp(`data-fallback-video="${HOST}/planner/v\\.mov"`));
  const local = context.tileImageMarkup({ image: "/uploads/v.mp4", type: "REEL", assetKind: "video" }, "x", { allowVideo: true });
  assert.match(local, /<video[^>]+preload="metadata"/);
});

test("the image error handler tries the fallback once, then the placeholder, then stops", () => {
  const context = makeContext();
  const img = { src: "thumb", dataset: { fallbackSrc: "orig" }, classList: { added: [], add(c) { this.added.push(c); } } };
  assert.equal(context.resolveImageError(img), "fallback");
  assert.equal(img.src, "orig");
  assert.equal(context.resolveImageError(img), "placeholder");
  assert.match(img.src, /^data:image\/svg/);
  assert.deepEqual(img.classList.added, ["img-broken"]);
  assert.equal(context.resolveImageError(img), "ignored");
});

test("the image error handler swaps a failed video thumbnail for a metadata-only video element", () => {
  const context = makeContext();
  let replacement = null;
  const img = { className: "tile-media crop-rendered", style: { cssText: "transform:scale(1)" }, src: "thumb", dataset: { fallbackVideo: `${HOST}/planner/v.mov` }, classList: { add() {} }, replaceWith(node) { replacement = node; } };
  assert.equal(context.resolveImageError(img), "video");
  assert.equal(replacement.tag, "video");
  assert.equal(replacement.src, `${HOST}/planner/v.mov`);
  assert.equal(replacement.preload, "metadata");
  assert.equal(replacement.className, "tile-media crop-rendered");
});
