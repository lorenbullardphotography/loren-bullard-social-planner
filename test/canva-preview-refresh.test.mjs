import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function previewHelpers() {
  const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const helpers = source.slice(0, source.indexOf("function renderGrid()"));
  const context = {
    console,
    crypto: { randomUUID: () => "test-id" },
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    window: { matchMedia: () => ({ matches: false }) },
    URL,
    Date
  };
  vm.runInNewContext(`${helpers}\nthis.previewHelpers = { needsCanvaPreviewRefresh, assetPreview, configureGridVideo, workflowPill };`, context);
  return context.previewHelpers;
}

test("shows Canva refresh only while a draft uses a temporary preview", () => {
  const { needsCanvaPreviewRefresh } = previewHelpers();
  assert.equal(needsCanvaPreviewRefresh({ assetSource: "canva", image: "https://document-export.canva.com/preview.jpg" }), true);
  assert.equal(needsCanvaPreviewRefresh({ assetSource: "canva", image: "/uploads/reel.mp4", canvaPreviewUpdatedAt: "2026-09-03T00:00:00.000Z" }), false);
  assert.equal(needsCanvaPreviewRefresh({ assetSource: "uploaded", image: "/uploads/photo.jpg" }), false);
});

test("renders a playable asset-page preview for an imported MP4 reel", () => {
  const { assetPreview } = previewHelpers();
  const markup = assetPreview({ assetKind: "image", image: "/uploads/canva-reel.mp4", cropRatio: "9:16" });
  assert.match(markup, /^<video /);
  assert.match(markup, /controls/);
  assert.doesNotMatch(markup, / muted/);
});

test("keeps grid reels paused on their first frame", () => {
  const { configureGridVideo } = previewHelpers();
  const video = {};
  configureGridVideo(video);
  assert.equal(video.autoplay, false);
  assert.equal(video.loop, false);
  assert.equal(video.muted, true);
  assert.equal(video.playsInline, true);
  assert.equal(video.preload, "metadata");
});

test("renders a workflow pill with a state hook for consistent color", () => {
  const { workflowPill } = previewHelpers();
  assert.equal(workflowPill("needs-review"), '<span class="workflow-pill" data-workflow="needs-review">Needs review</span>');
});
