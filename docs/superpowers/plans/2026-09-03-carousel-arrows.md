# Carousel Arrows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Preserve and navigate all Canva carousel page previews with accessible previous/next arrows.

**Architecture:** Extend normalized carousel posts with an optional `images` array while retaining `image` as the first-page cover. The grid and library remain first-page previews; the asset editor owns local slide index state and renders arrow controls around the current image.

**Tech Stack:** Node HTTP server, browser JavaScript, CSS, Node’s built-in test runner.

**Spec:** `docs/superpowers/specs/2026-09-03-carousel-and-scratch-book-design.md`

## Global Constraints

- Preserve old posts that only have `image` and no `images` array.
- Use existing Canva export, upload, persistence, and accessibility patterns.
- Do not implement Scratch Book in this release.

### Task 1: Export and persist carousel page images

**Files:** `server.mjs`, `public/app.js`, `test/canva-export.test.mjs`

- [ ] Add a Canva carousel export helper that downloads every returned JPG URL and returns an array of durable URLs.
- [ ] Pass `pageCount` and metadata through import/refresh requests; classify multi-page designs as carousels before video detection.
- [ ] Store `images` and keep `image` synchronized to the first page.
- [ ] Add tests proving a multi-page design remains a carousel even when MP4 is available.

### Task 2: Add asset-editor carousel navigation

**Files:** `public/app.js`, `public/styles.css`, `test/canva-preview-refresh.test.mjs`

- [ ] Add a bounded slide index and render previous/next buttons plus `current / total` for carousel assets.
- [ ] Keep arrow buttons keyboard accessible and disable them at the first/last page.
- [ ] Leave grid/library cards on the first page only.
- [ ] Add a test for the carousel preview markup and run the full test suite.

### Task 3: Verify and push

- [ ] Run syntax checks, all Node tests, and `git diff --check`.
- [ ] Commit only carousel-related files and push `main`.
