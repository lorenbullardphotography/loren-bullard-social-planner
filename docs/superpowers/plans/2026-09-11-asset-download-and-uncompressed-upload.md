# Asset Download and Uncompressed Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove upload-time image compression by switching asset uploads to Vercel Blob's client-side direct upload, and add always-available "download original asset" / "download content details (.txt)" buttons to the grid and standalone asset editors, replacing the old approval-gated download/export buttons in the Meta handoff section.

**Architecture:** A new `POST /api/assets/upload-token` server route issues short-lived Vercel Blob client tokens so the browser can upload files directly to Blob storage, bypassing the 4.5MB serverless body limit that today forces image compression. A shared `uploadAssetFile()` browser helper replaces three separate "compress-then-POST-base64" call sites, falling back to the existing (still-compressing) base64 path only when Blob isn't configured. The shared editor renderer (`renderInspector`, used for both the grid's docked panel and the standalone editor) gets two new unconditional buttons; the old approval-gated duplicates in the Meta handoff section are deleted.

**Tech Stack:** Node.js (`node:http`, `node:test`), `@vercel/blob` / `@vercel/blob/client` (already a dependency), vanilla browser JS (no bundler — the browser-side Blob upload helper is loaded via a pinned `esm.sh` ES module import).

**Spec:** `docs/superpowers/specs/2026-09-11-asset-download-and-uncompressed-upload-design.md`

---

## Task 1: Server — `/api/assets/upload-token` endpoint

**Files:**
- Modify: `server.mjs` (imports near the top; new pure helpers near `blobUsage()` around line 430; new route in `handleRequest` just before the existing `POST /api/assets` route around line 1533)
- Test: `test/asset-upload-token.test.mjs` (new file)

- [ ] **Step 1: Write the failing tests for the pure validation helpers**

Create `test/asset-upload-token.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { handleRequest, isPlannerUploadPathname, allowedUploadContentType, remainingUploadBytes } from "../server.mjs";

test("isPlannerUploadPathname accepts only paths under planner/", () => {
  assert.equal(isPlannerUploadPathname("planner/abc.jpg"), true);
  assert.equal(isPlannerUploadPathname("other/abc.jpg"), false);
  assert.equal(isPlannerUploadPathname(""), false);
  assert.equal(isPlannerUploadPathname(undefined), false);
});

test("allowedUploadContentType accepts only image/video mime types, lowercased", () => {
  assert.equal(allowedUploadContentType("image/jpeg"), "image/jpeg");
  assert.equal(allowedUploadContentType("video/mp4"), "video/mp4");
  assert.equal(allowedUploadContentType("IMAGE/JPEG"), "image/jpeg");
  assert.equal(allowedUploadContentType("application/json"), null);
  assert.equal(allowedUploadContentType(""), null);
  assert.equal(allowedUploadContentType(undefined), null);
});

test("remainingUploadBytes computes the gap between usage and limit, never negative", () => {
  assert.equal(remainingUploadBytes({ usedBytes: 100, limitBytes: 500 }), 400);
  assert.equal(remainingUploadBytes({ usedBytes: 600, limitBytes: 500 }), 0);
  assert.equal(remainingUploadBytes({}), 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/asset-upload-token.test.mjs`
Expected: FAIL — `isPlannerUploadPathname`, `allowedUploadContentType`, `remainingUploadBytes` are not exported from `server.mjs`.

- [ ] **Step 3: Add the pure helpers to `server.mjs`**

Find this existing code in `server.mjs` (around line 426-442):

```js
async function blobClient() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  return import("@vercel/blob");
}
async function blobUsage() {
  const client = await blobClient();
  if (!client) return { configured: false, usedBytes: 0, limitBytes: ASSET_STORAGE_LIMIT_MB * 1024 * 1024 };
  let cursor;
  let usedBytes = 0;
  do {
    const page = await client.list({ prefix: "planner/", ...(cursor ? { cursor } : {}) });
    usedBytes += (page.blobs || []).reduce((total, blob) => total + Number(blob.size || 0), 0);
    cursor = page.hasMore ? page.cursor : null;
  } while (cursor);
  return { configured: true, usedBytes, limitBytes: ASSET_STORAGE_LIMIT_MB * 1024 * 1024 };
}
```

Add these three exported functions directly after it:

```js
export function isPlannerUploadPathname(pathname) {
  return typeof pathname === "string" && pathname.startsWith("planner/");
}
export function allowedUploadContentType(clientPayload) {
  const mime = String(clientPayload || "").toLowerCase();
  return mime.startsWith("image/") || mime.startsWith("video/") ? mime : null;
}
export function remainingUploadBytes(usage) {
  return Math.max(0, Number(usage?.limitBytes || 0) - Number(usage?.usedBytes || 0));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/asset-upload-token.test.mjs`
Expected: PASS for the three pure-helper tests (the route tests added in Step 6 don't exist yet).

- [ ] **Step 5: Write the failing tests for the route itself**

Append to `test/asset-upload-token.test.mjs`:

```js
function createMockReqRes({ method = "GET", url = "/", headers = {}, body = null }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost:8787", ...headers };

  const res = {
    statusCode: 200,
    headers: {},
    body: "",
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = { ...this.headers, ...headers };
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk = "") {
      this.body += chunk;
    }
  };

  process.nextTick(() => {
    if (body !== null) {
      req.emit("data", typeof body === "string" ? body : JSON.stringify(body));
    }
    req.emit("end");
  });

  return { req, res };
}

async function signIn() {
  const login = createMockReqRes({
    method: "POST",
    url: "/auth/login",
    body: { login: "Loren", password: "admin" }
  });
  await handleRequest(login.req, login.res);
  const cookie = login.res.headers["set-cookie"]?.split(";")[0] || "";
  return { cookie };
}

test("POST /api/assets/upload-token requires authentication", async () => {
  const { req, res } = createMockReqRes({ method: "POST", url: "/api/assets/upload-token", body: {} });
  await handleRequest(req, res);
  assert.equal(res.statusCode, 401);
});

test("POST /api/assets/upload-token reports 503 when Vercel Blob is not configured", async () => {
  const { cookie } = await signIn();
  const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    const { req, res } = createMockReqRes({
      method: "POST",
      url: "/api/assets/upload-token",
      headers: { cookie },
      body: {}
    });
    await handleRequest(req, res);
    assert.equal(res.statusCode, 503);
    const data = JSON.parse(res.body);
    assert.match(data.error, /BLOB_READ_WRITE_TOKEN/);
  } finally {
    if (previousToken !== undefined) process.env.BLOB_READ_WRITE_TOKEN = previousToken;
  }
});
```

- [ ] **Step 6: Run the tests to verify the new ones fail**

Run: `node --test test/asset-upload-token.test.mjs`
Expected: FAIL — `POST /api/assets/upload-token` doesn't exist yet, so both new tests get a 404-shaped response instead of 401/503.

- [ ] **Step 7: Add the `handleUpload` import**

Find this in `server.mjs` (top of file, around line 1-9):

```js
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { deleteStored, getDatabaseClient, hasDirectDatabase, readStored, readStoredField, readStoredIds, storageMode, writeStored, writeStoredField } from "./lib/store.mjs";
import { applyWorkflowAutomations, normalizeWorkflowAutomations } from "./lib/workflow-automations.mjs";
import { createPlannerRepository } from "./lib/planner-repository.mjs";
import { createPlannerService } from "./lib/planner-service.mjs";
```

Add one import line after it:

```js
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { deleteStored, getDatabaseClient, hasDirectDatabase, readStored, readStoredField, readStoredIds, storageMode, writeStored, writeStoredField } from "./lib/store.mjs";
import { applyWorkflowAutomations, normalizeWorkflowAutomations } from "./lib/workflow-automations.mjs";
import { createPlannerRepository } from "./lib/planner-repository.mjs";
import { createPlannerService } from "./lib/planner-service.mjs";
import { handleUpload } from "@vercel/blob/client";
```

- [ ] **Step 8: Add the route**

Find this in `server.mjs` (around line 1533, inside `handleRequest`):

```js
    if (url.pathname === "/api/assets" && req.method === "POST") {
      const body = await readBody(req);
      const match = String(body?.data || "").match(/^data:([^;]+);base64,(.+)$/s);
```

Insert the new route directly before it:

```js
    if (url.pathname === "/api/assets/upload-token" && req.method === "POST") {
      if (!process.env.BLOB_READ_WRITE_TOKEN) {
        return sendJson(res, 503, { error: "Vercel Blob is not connected to this production environment. Add BLOB_READ_WRITE_TOKEN under Production environment variables, then redeploy." });
      }
      const body = await readBody(req);
      try {
        const usage = await blobUsage();
        const responseBody = await handleUpload({
          body,
          request: req,
          onBeforeGenerateToken: async (pathname, clientPayload) => {
            if (!isPlannerUploadPathname(pathname)) throw new Error("Invalid upload path.");
            const mime = allowedUploadContentType(clientPayload);
            if (!mime) throw new Error("Only images and reels are supported.");
            return {
              allowedContentTypes: [mime],
              addRandomSuffix: false,
              maximumSizeInBytes: remainingUploadBytes(usage)
            };
          }
        });
        return sendJson(res, 200, responseBody);
      } catch (error) {
        return sendJson(res, 400, { error: error.message || "Could not start the upload." });
      }
    }

    if (url.pathname === "/api/assets" && req.method === "POST") {
      const body = await readBody(req);
      const match = String(body?.data || "").match(/^data:([^;]+);base64,(.+)$/s);
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `node --test test/asset-upload-token.test.mjs`
Expected: PASS — all 5 tests (3 pure-helper, 2 route) pass.

- [ ] **Step 10: Commit**

```bash
git add server.mjs test/asset-upload-token.test.mjs
git commit -m "$(cat <<'EOF'
feat: add /api/assets/upload-token for direct-to-Blob uploads

Issues short-lived Vercel Blob client tokens so the browser can upload
files directly to Blob storage instead of proxying through the
serverless function's 4.5MB body limit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Client — generalize asset download and add metadata text export

**Files:**
- Modify: `public/app.js` (replace the block spanning `downloadFile` through `exportMetaData`, around lines 758-817)
- Test: `test/asset-details-text.test.mjs` (new file)

- [ ] **Step 1: Write the failing test**

Create `test/asset-details-text.test.mjs`:

```js
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
  vm.runInNewContext(`${helpers}\nthis.helpers = { assetDetailsText };`, context);
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
```

(`extensionForMime` is added to the shared context in Task 4, which also adds tests for it to this same file and updates the `vm.runInNewContext` exposure line — this step only exercises `assetDetailsText`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/asset-details-text.test.mjs`
Expected: FAIL — `assetDetailsText` is not defined in `public/app.js` yet, so `vm.runInNewContext` throws a `ReferenceError`.

- [ ] **Step 3: Replace the download/export functions in `public/app.js`**

Find this existing block in `public/app.js` (around lines 758-817):

```js
function downloadFile(name, content, type) {
  const blob = new Blob([content], { type });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
function exportBackup() {
  downloadFile('loren-content-planner-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify({ exportedAt: new Date().toISOString(), posts, scratch }, null, 2), "application/json");
  notify("Backup exported");
}
function approvedForMeta(post) {
  return post?.approval === "approved" || ["approved", "ready-meta", "meta-scheduled"].includes(workflowOf(post));
}
function metaExportData(post) {
  return {
    exportedAt: new Date().toISOString(),
    source: "Loren Bullard Content Planner",
    posts: [{
      id: post.id,
      mediaUrl: post.image,
      mediaType: assetKindOf(post),
      format: post.type,
      caption: post.caption || "",
      hashtags: post.hashtags || "",
      scheduledDate: post.date || "",
      scheduledTime: post.time || "",
      location: post.location || post.locationTag?.name || "",
      altText: post.altText || "",
      notes: post.notes || "",
      audio: post.audio || "",
      taggingNotes: post.tagNotes || "",
      tags: Array.isArray(post.tags) ? post.tags : [],
      coverImageUrl: post.coverImage || ""
    }]
  };
}
async function downloadAsset(post) {
  try {
    const response = await fetch(post.image);
    if (!response.ok) throw new Error("The media file could not be downloaded");
    const blob = await response.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    const sourceExtension = post.image.match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i)?.[1]?.toLowerCase();
    const extension = sourceExtension || (assetKindOf(post) === "video" ? "mp4" : "jpg");
    link.download = `loren-${post.type.toLowerCase()}-${post.id}.${extension}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    notify("Approved media downloaded");
  } catch (error) {
    notify(error.message || "Media download failed");
  }
}
function exportMetaData(post) {
  if (!approvedForMeta(post)) return notify("Approve this asset before exporting it for Meta");
  downloadFile(`meta-handoff-${post.id}.json`, JSON.stringify(metaExportData(post), null, 2), "application/json");
  notify("Meta handoff data exported");
}
```

Replace it with:

```js
function downloadFile(name, content, type) {
  const blob = new Blob([content], { type });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
function exportBackup() {
  downloadFile('loren-content-planner-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify({ exportedAt: new Date().toISOString(), posts, scratch }, null, 2), "application/json");
  notify("Backup exported");
}
async function downloadFileFromUrl(url, baseName, fallbackExtension) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("The media file could not be downloaded");
  const blob = await response.blob();
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  const sourceExtension = url.match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i)?.[1]?.toLowerCase();
  link.download = `${baseName}.${sourceExtension || fallbackExtension}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
async function downloadAsset(post) {
  try {
    const images = carouselImages(post);
    if (post.type === "CAROUSEL" && images.length > 1) {
      for (let i = 0; i < images.length; i++) {
        await downloadFileFromUrl(images[i], `loren-${post.type.toLowerCase()}-${post.id}-${i + 1}`, "jpg");
      }
      notify("Carousel images downloaded");
      return;
    }
    await downloadFileFromUrl(post.image, `loren-${post.type.toLowerCase()}-${post.id}`, assetKindOf(post) === "video" ? "mp4" : "jpg");
    notify("Asset downloaded");
  } catch (error) {
    notify(error.message || "Media download failed");
  }
}
const APPROVAL_LABELS = { "needs-review": "Needs review", feedback: "Feedback", approved: "Approved" };
function assetDetailsText(post) {
  const lines = [
    ["Caption", post.caption],
    ["Notes", post.notes],
    ["Audio", post.audio],
    ["Hashtags", post.hashtags],
    ["Tagging notes", post.tagNotes],
    ["Alt text", post.altText],
    ["Location", post.location || post.locationTag?.name],
    ["Format", post.type],
    ["Scheduled", [post.date, post.time].filter(Boolean).join(" ")],
    ["Workflow", WORKFLOW_LABELS[workflowOf(post)] || workflowOf(post)],
    ["Approval", APPROVAL_LABELS[post.approval] || post.approval],
    ["Assignee", post.assignee],
    ["Priority", post.priority],
    ["Content pillar", post.pillar]
  ];
  return lines.filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`).join("\n");
}
function downloadMetaTextFile(post) {
  downloadFile(`loren-${post.type.toLowerCase()}-${post.id}-details.txt`, assetDetailsText(post), "text/plain");
  notify("Content details downloaded");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/asset-details-text.test.mjs`
Expected: PASS for both `assetDetailsText` tests. (`extensionForMime` isn't defined until Task 4 — that's fine, this test file doesn't reference it yet.)

- [ ] **Step 5: Commit**

```bash
git add public/app.js test/asset-details-text.test.mjs
git commit -m "$(cat <<'EOF'
feat: generalize asset download and add a metadata text export

downloadAsset() now handles carousels (downloads every image) instead
of being tied to the Meta handoff flow. Adds assetDetailsText()/
downloadMetaTextFile() as a human-readable replacement for the JSON
metaExportData() export, which is removed along with approvedForMeta()
and exportMetaData() now that nothing calls them.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Client — wire the new buttons into the shared editor, remove the old gated ones

**Files:**
- Modify: `public/app.js` (`renderInspector()`, around lines 1471-1520 and 1788-1791)
- Test: `test/asset-download-buttons.test.mjs` (new file)

- [ ] **Step 1: Write the failing test**

Create `test/asset-download-buttons.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const appJs = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

test("the shared editor renders universal download buttons in both the posted and editable views", () => {
  const matches = appJs.match(/id="downloadOriginalAsset"/g) || [];
  assert.equal(matches.length, 2, "expected one in the posted-locked branch and one in the editable branch");
  const detailMatches = appJs.match(/id="downloadAssetDetails"/g) || [];
  assert.equal(detailMatches.length, 2);
});

test("removes the redundant approval-gated Meta handoff download/export code", () => {
  assert.doesNotMatch(appJs, /function approvedForMeta/);
  assert.doesNotMatch(appJs, /function metaExportData/);
  assert.doesNotMatch(appJs, /function exportMetaData/);
  assert.doesNotMatch(appJs, /id="downloadApprovedAsset"/);
  assert.doesNotMatch(appJs, /id="exportMetaData"/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/asset-download-buttons.test.mjs`
Expected: FAIL — the buttons don't exist yet (0 matches instead of 2), and `approvedForMeta`/`metaExportData`/`exportMetaData` were already removed in Task 2, so the second test already passes but the first fails.

- [ ] **Step 3: Add the buttons to the posted-locked branch**

Find this in `public/app.js` (around lines 1471-1479):

```js
  if (post.status === "posted") {
    host.innerHTML = `<div class="editor"><button class="mobile-editor-close" type="button" aria-label="Close asset editor">×</button>
      <div class="preview-wrap">${assetPreview(post)}</div>
      <div class="posted-lock">This post is live on Instagram and stays locked in the grid.<br><br><b>${post.timestamp ? new Date(post.timestamp).toLocaleDateString() : "Posted"}</b>${post.permalink ? ` · <a href="${esc(post.permalink)}" target="_blank" rel="noopener noreferrer">Open on Instagram</a>` : ""}<br>${esc(formatSchedule(post))}${locationSummary(post)}</div>
      <label class="field">Caption<textarea rows="8" readonly>${esc(post.caption || "")}</textarea></label>
    </div>`;
    q(".mobile-editor-close")?.addEventListener("click", closeGridEditor);
    return;
  }
```

Replace it with:

```js
  if (post.status === "posted") {
    host.innerHTML = `<div class="editor"><button class="mobile-editor-close" type="button" aria-label="Close asset editor">×</button>
      <div class="preview-wrap">${assetPreview(post)}</div>
      <div class="posted-lock">This post is live on Instagram and stays locked in the grid.<br><br><b>${post.timestamp ? new Date(post.timestamp).toLocaleDateString() : "Posted"}</b>${post.permalink ? ` · <a href="${esc(post.permalink)}" target="_blank" rel="noopener noreferrer">Open on Instagram</a>` : ""}<br>${esc(formatSchedule(post))}${locationSummary(post)}</div>
      <label class="field">Caption<textarea rows="8" readonly>${esc(post.caption || "")}</textarea></label>
      <div class="handoff-actions"><button id="downloadOriginalAsset" class="ghost" type="button">↓ Download original asset</button><button id="downloadAssetDetails" class="ghost" type="button">↓ Download content details (.txt)</button></div>
    </div>`;
    q(".mobile-editor-close")?.addEventListener("click", closeGridEditor);
    q("#downloadOriginalAsset").onclick = () => downloadAsset(post);
    q("#downloadAssetDetails").onclick = () => downloadMetaTextFile(post);
    return;
  }
```

- [ ] **Step 4: Add the buttons to the editable branch and remove the old gated markup**

Find this in `public/app.js` (around line 1486):

```js
    <div class="asset-meta"><span class="asset-badge">${assetTypeLabel(post)}</span><span class="asset-badge source-${assetSourceOf(post)}">${assetSourceOf(post) === "canva" ? "Canva" : "Uploaded"}</span>${hasReelCover(post) ? '<span class="asset-badge cover-badge">Cover attached</span>' : ""}</div>
```

Replace it with:

```js
    <div class="asset-meta"><span class="asset-badge">${assetTypeLabel(post)}</span><span class="asset-badge source-${assetSourceOf(post)}">${assetSourceOf(post) === "canva" ? "Canva" : "Uploaded"}</span>${hasReelCover(post) ? '<span class="asset-badge cover-badge">Cover attached</span>' : ""}</div>
    <div class="handoff-actions"><button id="downloadOriginalAsset" class="ghost" type="button">↓ Download original asset</button><button id="downloadAssetDetails" class="ghost" type="button">↓ Download content details (.txt)</button></div>
```

Find this in `public/app.js` (around line 1516):

```js
    <div class="handoff"><b>Meta Business Suite handoff</b><span>Use Meta for final scheduling and publishing.</span><div class="handoff-actions"><button id="copyCaption" class="ghost">Copy caption</button><button id="copyHashtags" class="ghost">Copy hashtags</button><a class="ghost button-link" href="https://business.facebook.com/latest/home" target="_blank" rel="noopener noreferrer">Open Meta</a>${approvedForMeta(post) ? '<button id="downloadApprovedAsset" class="ghost">↓ Download approved media</button><button id="exportMetaData" class="ghost">↓ Export Meta data</button>' : ""}</div><button id="markMeta" class="primary">Mark ready for Meta</button></div>
```

Replace it with:

```js
    <div class="handoff"><b>Meta Business Suite handoff</b><span>Use Meta for final scheduling and publishing.</span><div class="handoff-actions"><button id="copyCaption" class="ghost">Copy caption</button><button id="copyHashtags" class="ghost">Copy hashtags</button><a class="ghost button-link" href="https://business.facebook.com/latest/home" target="_blank" rel="noopener noreferrer">Open Meta</a></div><button id="markMeta" class="primary">Mark ready for Meta</button></div>
```

- [ ] **Step 5: Wire the click handlers for the editable branch and remove the old ones**

Find this in `public/app.js` (around lines 1788-1791):

```js
  q("#copyCaption").onclick = () => copyText(post.caption, "Caption");
  q("#copyHashtags").onclick = () => copyText(post.hashtags, "Hashtags");
  if (q("#downloadApprovedAsset")) q("#downloadApprovedAsset").onclick = () => downloadAsset(post);
  if (q("#exportMetaData")) q("#exportMetaData").onclick = () => exportMetaData(post);
```

Replace it with:

```js
  q("#copyCaption").onclick = () => copyText(post.caption, "Caption");
  q("#copyHashtags").onclick = () => copyText(post.hashtags, "Hashtags");
  q("#downloadOriginalAsset").onclick = () => downloadAsset(post);
  q("#downloadAssetDetails").onclick = () => downloadMetaTextFile(post);
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test test/asset-download-buttons.test.mjs`
Expected: PASS — both tests pass.

- [ ] **Step 7: Run the full test suite to check for regressions**

Run: `node --test test/*.test.mjs`
Expected: PASS, aside from one pre-existing failure unrelated to this plan — `team-management.test.mjs`'s "team member API workflow" test currently fails (409 instead of 201) even on an unmodified checkout, from leftover on-disk `.data/planner-users.json` state across runs. If you see that single failure and nothing else new, it's not a regression from this task. (Any test requiring `TEST_DATABASE_URL` is skipped, not failed, if that env var isn't set.)

- [ ] **Step 8: Commit**

```bash
git add public/app.js test/asset-download-buttons.test.mjs
git commit -m "$(cat <<'EOF'
feat: surface asset + metadata download in the shared grid/asset editor

Adds unconditional "Download original asset" and "Download content
details" buttons to renderInspector() (covers both the grid's docked
inspector and the standalone Asset Workspace), including the read-only
posted-post view. Removes the now-redundant approval-gated download/
export buttons from the Meta handoff section.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Client — shared `uploadAssetFile()` helper

**Files:**
- Modify: `public/app.js` (add `extensionForMime` near `assetTypeLabel`, around line 86; add `loadBlobUpload`/`getStorageUsage`/`uploadAssetFile` near `prepareUploadFile`, around line 2276)
- Test: `test/asset-details-text.test.mjs` (add `extensionForMime` tests), `test/asset-download-buttons.test.mjs` (add esm.sh import test)

- [ ] **Step 1: Write the failing test for `extensionForMime`**

Add to `test/asset-details-text.test.mjs` (after the existing two tests, using the same `appJsHelpers()` function already defined there):

```js
test("extensionForMime maps common mime types to file extensions", () => {
  const { extensionForMime } = appJsHelpers();
  assert.equal(extensionForMime("image/jpeg"), "jpeg");
  assert.equal(extensionForMime("image/png"), "png");
  assert.equal(extensionForMime("video/mp4"), "mp4");
  assert.equal(extensionForMime("video/quicktime"), "mov");
});
```

Find this in `test/asset-details-text.test.mjs` (inside `appJsHelpers()`, added in Task 2):

```js
  vm.runInNewContext(`${helpers}\nthis.helpers = { assetDetailsText };`, context);
```

Replace it with:

```js
  vm.runInNewContext(`${helpers}\nthis.helpers = { assetDetailsText, extensionForMime };`, context);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/asset-details-text.test.mjs`
Expected: FAIL — `extensionForMime` is not defined in `public/app.js` yet.

- [ ] **Step 3: Add `extensionForMime`**

Find this in `public/app.js` (around lines 79-86):

```js
function assetTypeLabel(post) {
  if (assetKindOf(post) === "video") return "Video";
  if (assetSourceOf(post) === "canva") return post.canvaAssetType === "video" ? "Video" : "Image";
  if (post.canvaDoctypeName) return post.canvaDoctypeName;
  const labels = { doc: "Canva Doc", email: "Canva Email", presentation: "Canva Presentation", sheet: "Canva Sheet", whiteboard: "Canva Whiteboard", custom: "Canva Design", unknown: "Canva Design" };
  const type = (post.canvaDesignTypes || []).map(value => labels[value] || value).filter(Boolean)[0];
  return type || (assetSourceOf(post) === "canva" ? "Canva Design" : "Image");
}
```

Add directly after it:

```js
function extensionForMime(mime) {
  if (mime === "video/quicktime") return "mov";
  return (mime.split("/")[1] || "bin").replace(/[^a-z0-9]/g, "");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/asset-details-text.test.mjs`
Expected: PASS — all three tests in this file pass (two `assetDetailsText` tests from Task 2, plus this one).

- [ ] **Step 5: Write the failing structural test for the esm.sh import**

Add to `test/asset-download-buttons.test.mjs`:

```js
test("loads the Vercel Blob client upload helper via esm.sh, pinned to the installed package version", () => {
  const { version } = JSON.parse(fs.readFileSync(new URL("../node_modules/@vercel/blob/package.json", import.meta.url)));
  assert.match(appJs, new RegExp(`https://esm\\.sh/@vercel/blob@${version}/client`));
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `node --test test/asset-download-buttons.test.mjs`
Expected: FAIL — the import string doesn't exist yet.

- [ ] **Step 7: Add `loadBlobUpload`, `getStorageUsage`, and `uploadAssetFile`**

Find this in `public/app.js` (around lines 2267-2294):

```js
async function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function prepareUploadFile(file) {
  // Vercel Functions accept only a 4.5 MB request body. Because the upload is
  // sent as base64 JSON, keep browser-compressed photos below 3 MB so normal
  // camera images do not hit that platform limit.
  if (!file.type.startsWith("image/") || file.size <= 3 * 1024 * 1024) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, Math.sqrt((3 * 1024 * 1024) / file.size));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.84));
    if (blob && blob.size < file.size) return new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" });
  } catch {}
  return file;
}
```

Replace it with (only the comment on `prepareUploadFile` changes, plus four new functions appended after it):

```js
async function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function prepareUploadFile(file) {
  // Only reached as uploadAssetFile()'s local-dev fallback when Vercel Blob
  // isn't configured. That path still proxies through the serverless
  // function as base64 JSON, which caps request bodies at 4.5 MB — so
  // browser-compressed photos need to stay below 3 MB. The primary path
  // (Blob configured) uploads directly to Blob storage at full quality;
  // see uploadAssetFile() below.
  if (!file.type.startsWith("image/") || file.size <= 3 * 1024 * 1024) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, Math.sqrt((3 * 1024 * 1024) / file.size));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.84));
    if (blob && blob.size < file.size) return new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" });
  } catch {}
  return file;
}

let blobUploadPromise = null;
function loadBlobUpload() {
  if (!blobUploadPromise) blobUploadPromise = import("https://esm.sh/@vercel/blob@2.8.0/client").then(mod => mod.upload);
  return blobUploadPromise;
}

let storageUsagePromise = null;
function getStorageUsage() {
  if (!storageUsagePromise) storageUsagePromise = api("/api/storage/usage").catch(() => ({ configured: false, usedBytes: 0, limitBytes: 0 }));
  return storageUsagePromise;
}

async function uploadAssetFile(file) {
  if (file.size > 30 * 1024 * 1024) throw new Error("Assets must be 30 MB or smaller.");
  const usage = await getStorageUsage();
  if (usage.configured) {
    if (usage.usedBytes + file.size > usage.limitBytes) {
      throw new Error(`Storage limit reached. ${Math.max(0, usage.limitBytes - usage.usedBytes)} bytes remain.`);
    }
    const upload = await loadBlobUpload();
    const pathname = `planner/${crypto.randomUUID()}.${extensionForMime(file.type)}`;
    const result = await upload(pathname, file, {
      access: "public",
      handleUploadUrl: "/api/assets/upload-token",
      contentType: file.type,
      clientPayload: file.type
    });
    return { url: result.url, kind: file.type.startsWith("video/") ? "video" : "image" };
  }
  const uploadFile = await prepareUploadFile(file);
  if (uploadFile.size > 3 * 1024 * 1024) throw new Error("This asset is too large for the hosted upload connection. Photos are compressed automatically; videos must be under 3 MB.");
  return api("/api/assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: uploadFile.name, data: await readFile(uploadFile) }) });
}
```

Note: the pinned version `2.8.0` must match the installed `@vercel/blob` version. Confirm with:

```bash
node -p "require('./node_modules/@vercel/blob/package.json').version"
```

If it prints something other than `2.8.0`, use that version number in the `esm.sh` URL above instead.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --test test/asset-download-buttons.test.mjs test/asset-details-text.test.mjs`
Expected: PASS for all tests in both files.

- [ ] **Step 9: Commit**

```bash
git add public/app.js test/asset-details-text.test.mjs test/asset-download-buttons.test.mjs
git commit -m "$(cat <<'EOF'
feat: add uploadAssetFile() direct-to-Blob upload helper

Checks GET /api/storage/usage to decide whether Blob is configured
before choosing a path: direct-to-Blob upload (full quality, no size
trigger below the 30MB app ceiling) when it is, or today's compressing
base64 fallback when it isn't. Not yet wired into any call site.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Client — switch the three upload call sites to `uploadAssetFile()`

**Files:**
- Modify: `public/app.js` (main grid upload around line 2295, reel cover photo upload around line 1805, Scratch Book photo upload around line 2594)
- Test: `test/asset-download-buttons.test.mjs` (add call-site count test)

- [ ] **Step 1: Write the failing test**

Add to `test/asset-download-buttons.test.mjs`:

```js
test("every upload call site routes through the shared uploadAssetFile helper", () => {
  const callSites = appJs.match(/await uploadAssetFile\(file\)/g) || [];
  assert.equal(callSites.length, 3, "expected the main upload, cover photo upload, and Scratch Book upload to all call uploadAssetFile");
  const fallbackSites = appJs.match(/prepareUploadFile\(file\)/g) || [];
  assert.equal(fallbackSites.length, 1, "prepareUploadFile should now only run inside uploadAssetFile's local-dev fallback");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/asset-download-buttons.test.mjs`
Expected: FAIL — `uploadAssetFile(file)` appears 0 times at call sites right now (only inside its own definition, and via `prepareUploadFile` still at 3 old call sites plus 1 in the helper = 4).

- [ ] **Step 3: Update the reel cover photo upload**

Find this in `public/app.js` (around lines 1812-1815):

```js
    try {
      const uploadFile = await prepareUploadFile(file);
      if (uploadFile.size > 3 * 1024 * 1024) throw new Error("This asset is too large for the hosted upload connection. Photos are compressed automatically; videos must be under 3 MB.");
      const uploaded = await api("/api/assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: uploadFile.name, data: await readFile(uploadFile) }) });
      const saved = await saveQuickAssetChanges(post, { coverImage: uploaded.url }, "added a reel cover photo");
```

Replace it with:

```js
    try {
      const uploaded = await uploadAssetFile(file);
      const saved = await saveQuickAssetChanges(post, { coverImage: uploaded.url }, "added a reel cover photo");
```

- [ ] **Step 4: Update the main grid upload**

Find this in `public/app.js` (around lines 2310-2315):

```js
    for (const [index, file] of validFiles.entries()) {
      uploadStatus.textContent = "Uploading " + (index + 1) + " of " + validFiles.length + "…";
      const photoGps = file.type.startsWith("image/") ? await readExifGps(file) : null;
      const uploadFile = await prepareUploadFile(file);
      if (uploadFile.size > 3 * 1024 * 1024) throw new Error("This asset is too large for the hosted upload connection. Photos are compressed automatically; videos must be under 3 MB.");
      const uploaded = await api("/api/assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: uploadFile.name, data: await readFile(uploadFile) }) });
```

Replace it with:

```js
    for (const [index, file] of validFiles.entries()) {
      uploadStatus.textContent = "Uploading " + (index + 1) + " of " + validFiles.length + "…";
      const photoGps = file.type.startsWith("image/") ? await readExifGps(file) : null;
      const uploaded = await uploadAssetFile(file);
```

- [ ] **Step 5: Update the Scratch Book photo upload**

Find this in `public/app.js` (around lines 2604-2613):

```js
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (statusEl) statusEl.textContent = `Uploading photo ${i + 1} of ${files.length}…`;
        const uploadFile = await prepareUploadFile(file);
        if (uploadFile.size > 3 * 1024 * 1024) throw new Error("Photos must be under 3 MB");
        const uploaded = await api("/api/assets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: uploadFile.name, data: await readFile(uploadFile) })
        });
        if (uploaded?.url) {
          scratchAttachedImages.push(uploaded.url);
        }
      }
```

Replace it with:

```js
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (statusEl) statusEl.textContent = `Uploading photo ${i + 1} of ${files.length}…`;
        const uploaded = await uploadAssetFile(file);
        if (uploaded?.url) {
          scratchAttachedImages.push(uploaded.url);
        }
      }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test test/asset-download-buttons.test.mjs`
Expected: PASS — all tests in this file pass.

- [ ] **Step 7: Run the full test suite to check for regressions**

Run: `node --test test/*.test.mjs`
Expected: PASS, aside from one pre-existing failure unrelated to this plan — `team-management.test.mjs`'s "team member API workflow" test currently fails (409 instead of 201) even on an unmodified checkout, from leftover on-disk `.data/planner-users.json` state across runs. If you see that single failure and nothing else new, it's not a regression from this task. (Any test requiring `TEST_DATABASE_URL` is skipped, not failed, if that env var isn't set.)

- [ ] **Step 8: Commit**

```bash
git add public/app.js test/asset-download-buttons.test.mjs
git commit -m "$(cat <<'EOF'
feat: upload assets directly to Blob storage at full quality

Switches the main grid upload, reel cover photo upload, and Scratch
Book reference photo upload to uploadAssetFile(), removing the 3MB
image-compression trigger and 3MB video rejection whenever Vercel Blob
is configured. Falls back to the previous compressing base64 path only
when it isn't (local dev without BLOB_READ_WRITE_TOKEN).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Bump the app.js cache-busting version

**Files:**
- Modify: `public/index.html` (script tag near the end of the file)
- Test: `test/asset-download-buttons.test.mjs` (add version-bump test)

- [ ] **Step 1: Write the failing test**

Add to `test/asset-download-buttons.test.mjs`:

```js
test("bumps the app.js cache-busting version", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /<script src="\/app\.js\?v=20260911-/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/asset-download-buttons.test.mjs`
Expected: FAIL — the current version string is `20260910-row-storage-fixes`.

- [ ] **Step 3: Bump the version**

Find this in `public/index.html` (near the end of the file):

```html
<script src="/app.js?v=20260910-row-storage-fixes"></script>
```

Replace it with:

```html
<script src="/app.js?v=20260911-asset-download-uncompressed-upload"></script>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/asset-download-buttons.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full test suite one more time**

Run: `node --test test/*.test.mjs`
Expected: PASS, aside from the same pre-existing `team-management.test.mjs` failure noted in Task 3 Step 7 (unrelated to this plan).

- [ ] **Step 6: Commit**

```bash
git add public/index.html test/asset-download-buttons.test.mjs
git commit -m "$(cat <<'EOF'
chore: bump app.js cache-busting version

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Manual browser verification

No files change in this task — it's a verification pass using the running app, per the spec's testing section. Requires `BLOB_READ_WRITE_TOKEN` to be set (in `.env` or the shell) to exercise the primary path; without it, only steps 6-7 are meaningful (the fallback path).

- [ ] **Step 1: Start the dev server**

```bash
npm run dev
```

- [ ] **Step 2: Upload an image over 3MB and confirm no compression**

In the browser, sign in, go to Grid Planner, upload a photo larger than 3MB (e.g. an unedited phone photo). Note its file size on disk before uploading. After it appears in the grid, open the browser's Network tab, find the request to the Blob storage domain (`*.blob.vercel-storage.com`) or inspect the uploaded asset's URL directly, and confirm the stored file's size roughly matches the original (no resize). Compare against the pre-fix behavior: before this change, any image over 3MB would have been silently re-encoded to JPEG quality 0.84 and resized.

- [ ] **Step 3: Upload a video over 3MB (and under 30MB) and confirm it's accepted**

Before this change, this would fail with "This asset is too large for the hosted upload connection... videos must be under 3 MB." Confirm it now succeeds.

- [ ] **Step 4: Download that asset from both editor surfaces**

From the Grid Planner, click the tile to open the docked inspector; click "↓ Download original asset". Then open the same post in the standalone editor (double-click the tile, or use whatever opens `view-editor`) and click the same button there. Confirm both downloads produce a file whose size matches the uploaded original.

- [ ] **Step 5: Download the metadata text file**

On a post with caption, hashtags, notes, location, and assignee all filled in, click "↓ Download content details (.txt)". Open the downloaded file and confirm every populated field appears as a labeled line, and no empty fields appear.

- [ ] **Step 6: Download both files for a carousel post**

Create or open a CAROUSEL post with more than one image. Click "↓ Download original asset" and confirm every image in the carousel downloads (the browser may prompt to allow multiple downloads — accept it).

- [ ] **Step 7: Verify the local-dev fallback**

Stop the server, unset `BLOB_READ_WRITE_TOKEN` (comment it out in `.env` if present), restart the server, and upload a small image (under 3MB). Confirm it still succeeds via the fallback path. Optionally upload one over 3MB and confirm it's compressed as before (pre-existing fallback behavior, unchanged).

- [ ] **Step 8: Verify the simplified Meta handoff section**

Open an approved post's editor. Confirm the "Meta Business Suite handoff" card shows only Copy caption / Copy hashtags / Open Meta / Mark ready — no download or export buttons there anymore — and that the two new universal buttons (visible regardless of approval state, placed near the asset preview) are what's used to get the asset and its metadata.

- [ ] **Step 9: Restore local environment**

Re-enable `BLOB_READ_WRITE_TOKEN` in `.env` if you disabled it in Step 7, so the environment is left as it was found.

---

## Self-Review Notes

- **Spec coverage:** Part 1 (direct-to-Blob upload, server route, browser helper, fallback) → Tasks 1, 4, 5. Part 2 (asset download, carousel handling, metadata text export, Meta handoff simplification) → Tasks 2, 3. Error handling (quota pre-check, `usage.configured` fallback trigger) → Task 4. Testing section → Tasks 1-6 (automated) and Task 7 (manual, matching the spec's own manual-verification list almost line for line).
- **Type consistency:** `uploadAssetFile()` returns `{ url, kind }` in both its direct-to-Blob branch and its fallback branch (the fallback's `api("/api/assets", ...)` response already has this shape from the existing server route) — matches what all three call sites expect (`uploaded.url`, `uploaded.kind`). `downloadAsset(post)` and `downloadMetaTextFile(post)` are the exact function names referenced in both `renderInspector()` branches' click handlers. `assetDetailsText`/`extensionForMime`/`isPlannerUploadPathname`/`allowedUploadContentType`/`remainingUploadBytes` are named identically wherever defined, exported, and tested.
