# Asset Download and Uncompressed Upload Design

## Goal

Let users download the original asset file (image or reel) and a human-readable file of its saved metadata directly from the grid view's editor or the standalone asset editor. Ensure the file that comes back on download is never smaller/lower-quality than what was uploaded — which requires fixing the existing upload-time compression, not just the download step.

## Scope

Covers: the upload path for grid assets, reel cover photos, and Scratch Book reference photos; the shared editor UI (`renderInspector`, used for both the grid's docked inspector and the standalone "Asset Workspace" view); a new metadata text export. Does not change the existing approval-gated "Meta Business Suite handoff" JSON export (`exportMetaData`), Canva-sourced asset handling, or the 30MB per-file storage ceiling.

## Current problem

1. **Upload compression.** `prepareUploadFile()` in `public/app.js` resizes and re-encodes (JPEG quality 0.84) any image over 3MB before upload, and rejects any video over 3MB outright. This exists only because uploads are sent as base64 JSON to a Vercel serverless function, which caps request bodies at 4.5MB. It is not a deliberate quality decision — it is a side effect of the transport mechanism.
2. **No general download.** `downloadAsset()` and `exportMetaData()` already exist and are already lossless (they fetch the stored blob directly, no re-encoding), but both are hidden behind `approvedForMeta(post)` inside the Meta handoff section — so most assets, at most workflow stages, have no download option at all.
3. **No human-readable metadata export.** The only metadata export today is JSON shaped for a Meta Business Suite handoff, not for someone who just wants to read the caption/tags/notes in a text file.

## Part 1: Uncompressed uploads via direct-to-Blob upload

### Why not just raise the compression threshold

Vercel serverless functions cap request bodies at 4.5MB regardless of encoding. Sending raw bytes instead of base64 buys some headroom (removes ~33% base64 overhead) but does not remove the cap — large phone photos (8–15MB) and any reel video would still need to be rejected or compressed. The only way to accept files up to the app's existing 30MB ceiling at full quality is to stop routing the bytes through the serverless function at all.

### Approach: Vercel Blob client-side direct upload

The browser uploads directly to Vercel Blob storage using a short-lived client token issued by our server. The file bytes never pass through the serverless function, so the 4.5MB body cap does not apply. This keeps the current storage provider (Vercel Blob) — no new account, SDK, or asset URLs to migrate.

### Server: new token endpoint

`POST /api/assets/upload-token`

- Placed after the existing global `if (!account) return sendJson(res, 401, ...)` gate in `server.mjs`, so it inherits the same "must be signed in" requirement as every other `/api/*` route — no separate auth check needed in the handler.
- Returns `503` with the same message as the existing `/api/assets` POST route when `BLOB_READ_WRITE_TOKEN` is not configured (`!process.env.BLOB_READ_WRITE_TOKEN`), so the client can distinguish "not configured" from other errors and fall back.
- Implemented with `handleUpload()` from `@vercel/blob/client` (Node-safe import; only the *browser* entry point of this module needs special handling — see below). `onUploadCompleted` is intentionally omitted: it would require a publicly reachable callback URL, which local dev doesn't have, and the app doesn't need a post-upload webhook since the browser already receives the final blob URL from the direct PUT response.
- `onBeforeGenerateToken(pathname, clientPayload)`:
  - Reject if `pathname` does not start with `planner/` (prevents writing outside the app's blob prefix).
  - Parse `clientPayload` as the declared MIME type; reject if it's not `image/*` or `video/*`.
  - Compute remaining quota via the existing `blobUsage()` helper and pass it as `maximumSizeInBytes: Math.max(0, usage.limitBytes - usage.usedBytes)`, so Blob itself enforces the app's existing storage budget.
  - Pass `allowedContentTypes: [declaredMime]` and `addRandomSuffix: false`.

Note: the blob **pathname** (and therefore the final filename/extension) is chosen by the browser when it calls `upload(pathname, file, ...)` — `onBeforeGenerateToken`'s return value cannot override it, only validate it. This is normal for this API; the server's job is validation (prefix, quota, content type), not filename generation.

### Browser: loading the upload helper

`@vercel/blob/client`'s browser `upload()` function has top-level `import * as crypto from "crypto"` and `import { fetch } from "undici"` — these resolve correctly under a bundler (which substitutes the package's `browser` field), but this project ships plain `<script>`/ESM files with no build step, so importing the installed package directly would break in the browser.

Load it instead via `esm.sh`, a CDN built specifically to serve npm packages as browser-ready ESM (it resolves the package's own `browser` field mapping, which already points `crypto`/`undici` at the package's own browser-safe shims):

```js
import { upload } from "https://esm.sh/@vercel/blob@2.8.0/client";
```

This uses Vercel's real, maintained upload logic (retry behavior, versioned wire protocol, etc.) rather than a hand-rolled reimplementation of their internal client-token/PUT protocol, which would be fragile to keep in sync with future SDK changes.

### Shared upload helper

Replace the current "compress-then-POST-base64" call pattern (used at three sites: main grid upload, reel cover photo upload, Scratch Book reference photo upload) with one shared function in `public/app.js`:

```js
async function uploadAssetFile(file) {
  // returns { url, kind } — same shape callers already expect from /api/assets
}
```

Behavior:
1. If `file.size > 30 * 1024 * 1024`, throw immediately (existing app-wide ceiling, unchanged).
2. Attempt the direct-to-Blob path: generate `pathname = planner/${crypto.randomUUID()}.${extensionFor(file.type)}`, call `upload(pathname, file, { access: "public", handleUploadUrl: "/api/assets/upload-token", contentType: file.type, clientPayload: file.type })`. On success, return `{ url: result.url, kind: file.type.startsWith("video/") ? "video" : "image" }`.
3. If the token endpoint responds `503` (Blob not configured — local dev without `BLOB_READ_WRITE_TOKEN`), fall back to today's path unchanged: `prepareUploadFile()` (still compresses images >3MB, still rejects videos >3MB) then `POST /api/assets` with base64 JSON. This fallback is a local-dev safety net, not the primary path, and is not expected to run in production once `BLOB_READ_WRITE_TOKEN` is set.
4. Any other error (quota exceeded, disallowed type, network failure) surfaces to the caller as today.

All three call sites swap their existing upload logic for a call to `uploadAssetFile(file)` and keep their existing post-upload behavior (building the post object, attaching the cover image URL, pushing into `scratchAttachedImages`) unchanged.

## Part 2: Asset and metadata download

### Where it appears

Inside `renderInspector()` in `public/app.js`, which renders the same editor markup into both `#inspector` (grid view's docked panel) and `#postEditor` (standalone "Asset Workspace" view) — adding it once covers both surfaces the user referred to as "grid view edit" and "asset edit view". Also added to the read-only markup shown for `post.status === "posted"`, since downloading the original of something already live is a common need.

Two buttons, shown for every post regardless of approval/workflow state (unlike the existing Meta-handoff buttons, which stay approval-gated and unchanged):

- **"↓ Download original asset"**
- **"↓ Download content details (.txt)"**

Placed in their own small section near the asset preview, separate from the approval-gated "Meta Business Suite handoff" block.

### Asset download

Generalize the existing `downloadAsset(post)` (already lossless: `fetch(url)` → `blob()` → object URL → `<a download>`, no re-encoding at any step) by removing its `approvedForMeta` gate at the call site.

Carousel posts (`post.type === "CAROUSEL"` with `post.images.length > 1`) download every image in the carousel sequentially, one `downloadFile`-style trigger per image, named `loren-{type}-{id}-{n}.{ext}`. Non-carousel posts download the single asset as today, named `loren-{type}-{id}.{ext}`.

### Metadata text file

New function `downloadMetaTextFile(post)` builds a plain-text file (not JSON) with one labeled line per field, skipping empty fields:

```
Caption: ...
Hashtags: ...
Tags: ...
Tagging notes: ...
Location: ...
Alt text: ...
Notes: ...
Format: IMAGE | CAROUSEL | REEL
Scheduled: 2026-09-15 08:30
Workflow: ...
Approval: ...
Assignee: ...
Content pillar: ...
```

Saved as `loren-{type}-{id}-details.txt` via the existing `downloadFile(name, content, type)` helper with `type: "text/plain"`.

This is a separate function from `exportMetaData()` (JSON), which is left untouched and stays part of the approval-gated Meta handoff flow.

## Error handling

- Direct-to-Blob upload failure (network, quota, disallowed type) surfaces the same way upload failures do today: a `notify(error.message)` toast, no post created.
- `503` from `/api/assets/upload-token` is the *only* condition that triggers the base64 fallback; any other non-2xx response is treated as a real failure and surfaced to the user.
- Asset download failure (e.g. the stored file 404s) keeps today's behavior: `notify("The media file could not be downloaded")`.
- Metadata text download has no network dependency (built from in-memory post data), so it has no failure path beyond the browser's own file-save mechanics.

## Testing

- **Server unit tests** (`node:test`, following the existing pattern in `test/asset-revision.test.mjs` of exporting pure functions from `server.mjs` for direct testing): the `/api/assets/upload-token` pathname/content-type validation logic — rejects a pathname outside `planner/`, rejects a disallowed MIME type, computes `maximumSizeInBytes` correctly from a given usage/limit pair.
- **Manual verification** (browser):
  1. Upload an image over 3MB; confirm the stored blob's byte size matches the original file (no resize triggered).
  2. Upload a video over 3MB (and under 30MB); confirm it succeeds instead of being rejected.
  3. Download that asset from both the grid inspector and the standalone editor; confirm the downloaded file is byte-identical to what was uploaded.
  4. Download the metadata `.txt` for a post with every field populated; confirm all fields appear correctly labeled and formatted.
  5. Download both files for a carousel post; confirm every carousel image downloads.
  6. Temporarily unset `BLOB_READ_WRITE_TOKEN` locally; confirm upload still succeeds via the base64 fallback path.

## Out of scope

- Zipping multiple carousel images into a single download (no zip library in the project; sequential downloads are acceptable for the carousel sizes this app handles).
- Changing the existing 30MB per-file ceiling or the `ASSET_STORAGE_LIMIT_MB` total storage budget.
- Changing `exportMetaData()`'s JSON shape or its approval gate.
- Canva-sourced asset download behavior beyond what `downloadAsset()` already does (it already works for Canva-hosted URLs today since it's a plain fetch).
