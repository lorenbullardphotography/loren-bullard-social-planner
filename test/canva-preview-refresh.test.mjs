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
  vm.runInNewContext(`${helpers}\nthis.previewHelpers = { needsCanvaPreviewRefresh, assetPreview, configureGridVideo, workflowPill, libraryAssetBadges, WORKFLOW_LABELS, workflowOf, applyWorkflow, shouldRefreshPlanner, editorDestinationAfterSave, contentBriefMarkup, canShowAddActions };`, context);
  return context.previewHelpers;
}

test("shows add actions only in grid, calendar, and library views", () => {
  const { canShowAddActions } = previewHelpers();
  assert.equal(canShowAddActions("grid"), true);
  assert.equal(canShowAddActions("calendar"), true);
  assert.equal(canShowAddActions("library"), true);
  assert.equal(canShowAddActions("tasks"), false);
  assert.equal(canShowAddActions("editor"), false);
  assert.equal(canShowAddActions("settings"), false);
});

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

test("uses compact accessible asset/source indicators for library thumbnails", () => {
  const { libraryAssetBadges } = previewHelpers();
  assert.equal(libraryAssetBadges({ assetKind: "image", assetSource: "uploaded" }), '<span class="asset-badge library-asset-badge" title="Image" aria-label="Image">▧</span><span class="asset-badge library-asset-badge source-uploaded" title="Uploaded" aria-label="Uploaded">↑</span>');
  assert.equal(libraryAssetBadges({ assetKind: "image", assetSource: "canva" }), '<span class="asset-badge library-asset-badge" title="Image" aria-label="Image">▧</span><span class="asset-badge library-asset-badge source-canva" title="Canva" aria-label="Canva">C</span>');
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
  // Regression: a background poll must not rebuild the open editor even
  // before the first keystroke (editorDirty still false) or right after an
  // autosave clears it — renderInspector("#postEditor") is a full innerHTML
  // rebuild, so this window used to reset scroll and re-populate fields
  // from whatever's currently saved, which read as "the page keeps
  // refreshing" while composing a caption.
  assert.equal(shouldRefreshPlanner({ currentView: "editor", editorDirty: false, editorSaveInProgress: false }), false);
  assert.equal(shouldRefreshPlanner({ currentView: "library", editorDirty: true, editorSaveInProgress: false }), true);
  // Regression: on desktop, opening a tile from the Grid Planner keeps
  // currentView "grid" and renders the same editor form into the
  // right-hand #inspector panel instead of navigating to "editor" - that
  // panel needs the identical protection whenever a post is open in it.
  assert.equal(shouldRefreshPlanner({ currentView: "grid", selected: "post-1" }), false);
  assert.equal(shouldRefreshPlanner({ currentView: "grid", selected: null }), true);
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
