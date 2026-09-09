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
  vm.runInNewContext(`${helpers}\nthis.previewHelpers = { needsCanvaPreviewRefresh, assetPreview, configureGridVideo, workflowPill, WORKFLOW_LABELS, workflowOf, applyWorkflow, shouldRefreshPlanner, editorDestinationAfterSave, contentBriefMarkup };`, context);
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

test("uses feedback as the middle approval state", () => {
  const { WORKFLOW_LABELS, workflowOf, applyWorkflow } = previewHelpers();
  const post = { status: "planned", approval: "approved" };

  assert.equal(WORKFLOW_LABELS.feedback, "Feedback");
  applyWorkflow(post, "feedback");
  assert.equal(post.approval, "feedback");
  assert.equal(post.status, "draft");
  assert.equal(workflowOf(post), "feedback");
});

test("does not refresh away an active asset editor", () => {
  const { shouldRefreshPlanner } = previewHelpers();
  assert.equal(shouldRefreshPlanner({ currentView: "editor", editorDirty: true, editorSaveInProgress: false }), false);
  assert.equal(shouldRefreshPlanner({ currentView: "editor", editorDirty: false, editorSaveInProgress: true }), false);
  assert.equal(shouldRefreshPlanner({ currentView: "library", editorDirty: true, editorSaveInProgress: false }), true);
});

test("returns to the page that opened the asset editor after saving", () => {
  const { editorDestinationAfterSave } = previewHelpers();
  assert.equal(editorDestinationAfterSave("editor", "library"), "library");
  assert.equal(editorDestinationAfterSave("editor", "grid"), "grid");
});

test("keeps only active content brief fields in the asset editor", () => {
  const { contentBriefMarkup } = previewHelpers();
  const markup = contentBriefMarkup({ audio: "Song", hashtags: "#family", tagNotes: "Vendors", altText: "Family portrait" });

  assert.match(markup, /id="eAudio"/);
  assert.match(markup, /id="eHashtags"/);
  assert.match(markup, /id="eTagNotes"/);
  assert.match(markup, /id="eAltText"/);
  assert.doesNotMatch(markup, /eGoal|eHook|eCta|>Goal<|>Hook<|Call to action/);
});
