# Shared Asset Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace planner-wide asset saves with asset-level, revision-aware updates that merge different-field edits and surface same-field conflicts.

**Architecture:** The server continues storing a planner document, but adds an asset revision plus per-field revision metadata to each post. A new `PATCH /api/assets/:id` route validates and applies only submitted asset fields. The browser stores an editor baseline, sends only changed fields, replaces only the returned asset, and renders an inline conflict choice only for fields that changed after that baseline revision.

**Tech Stack:** Node.js HTTP server, JSON persistence through `lib/store.mjs`, vanilla browser JavaScript, Node’s built-in test runner.

**Spec:** `docs/superpowers/specs/2026-09-08-shared-asset-editing-design.md`

## Global Constraints

- Keep the existing planner JSON schema backward-compatible by normalizing missing revision metadata.
- Do not alter persistence behavior for planner settings, Scratch Book entries, account settings, Instagram sync, or uploaded asset creation.
- Do not replace unrelated dirty working-tree changes.
- Use test-first development for every behavior change.
- Keep same-field conflict resolution explicit; never force a field automatically.

---

### Task 1: Add revision-aware post normalization and merge primitives

**Files:**
- Modify: `server.mjs:447-536`
- Create: `test/asset-revision.test.mjs`

**Interfaces:**
- Produces: `normalizePost(post)`, `normalizeAssetChanges(changes)`, `applyAssetChanges(post, changes, actor, now)`, and `assetConflicts(post, submittedRevision, changes)`.
- Consumes: existing workflow validation, field limits, and `normalizePost` field rules.

- [ ] **Step 1: Write failing tests for legacy revisions and field-level metadata**

```js
test("normalizes a legacy post with an initial revision", () => {
  assert.equal(normalizePost({ id: "asset-1", image: "/photo.jpg" }).revision, 1);
  assert.deepEqual(normalizePost({ id: "asset-1", image: "/photo.jpg" }).fieldUpdatedAt, {});
});

test("records metadata only for fields that changed", () => {
  const updated = applyAssetChanges(
    normalizePost({ id: "asset-1", image: "/photo.jpg", revision: 3, caption: "Before" }),
    { caption: "After" },
    { name: "Loren" },
    "2026-09-08T20:00:00.000Z"
  );
  assert.equal(updated.revision, 4);
  assert.equal(updated.caption, "After");
  assert.equal(updated.fieldUpdatedRevision.caption, 4);
  assert.equal(updated.fieldUpdatedBy.caption, "Loren");
  assert.equal(updated.fieldUpdatedAt.caption, "2026-09-08T20:00:00.000Z");
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `node --test test/asset-revision.test.mjs`

Expected: FAIL because the revision-aware helpers are not exported or implemented.

- [ ] **Step 3: Implement normalized revision metadata and bounded editable fields**

Add these exported constants and helpers near `normalizePost`:

```js
export const ASSET_EDITABLE_FIELDS = new Set([
  "type", "workflow", "status", "approval", "assignee", "priority", "pillar",
  "date", "scheduleState", "caption", "notes", "audio", "hashtags", "tagNotes",
  "altText", "location", "locationTag", "cropZoom", "cropX", "cropY"
]);

export function normalizeAssetChanges(changes = {}) {
  const candidate = normalizePost({ id: "candidate", image: "/placeholder.jpg", ...changes });
  return Object.fromEntries([...ASSET_EDITABLE_FIELDS]
    .filter(field => Object.hasOwn(changes, field))
    .map(field => [field, candidate[field]]));
}
```

Extend `normalizePost` to return `revision: Math.max(1, Number(post?.revision) || 1)` plus sanitized `fieldUpdatedRevision`, `fieldUpdatedAt`, and `fieldUpdatedBy` objects limited to `ASSET_EDITABLE_FIELDS`. Implement `applyAssetChanges` to copy only normalized changed fields, increment the asset revision once, record that new revision plus actor/timestamp metadata for each changed field, and update `updatedBy`/`updatedAt`.

- [ ] **Step 4: Run the revision tests to confirm they pass**

Run: `node --test test/asset-revision.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit the isolated data-model work**

```bash
git add server.mjs test/asset-revision.test.mjs
git commit -m "Add revision metadata to planner assets"
```

### Task 2: Add an asset-level patch endpoint with automatic merging

**Files:**
- Modify: `server.mjs:654-780`
- Modify: `test/asset-revision.test.mjs`

**Interfaces:**
- Consumes: `PATCH /api/assets/:id` body `{ revision, changes, forceFields?, actor? }`.
- Produces: `200 { asset, merged }`, `400 { error }`, `404 { error }`, or `409 { error, asset, conflicts }`.

- [ ] **Step 1: Write failing endpoint tests for non-overlap, overlap, and a forced field**

```js
test("merges a stale edit to a different field", async () => {
  const result = await patchAsset({ revision: 2, changes: { notes: "New notes" } });
  assert.equal(result.status, 200);
  assert.equal(result.body.merged, true);
  assert.equal(result.body.asset.caption, "Teammate caption");
  assert.equal(result.body.asset.notes, "New notes");
});

test("returns a structured conflict for a stale same-field edit", async () => {
  const result = await patchAsset({ revision: 2, changes: { caption: "My caption" } });
  assert.equal(result.status, 409);
  assert.equal(result.body.conflicts.caption.currentValue, "Teammate caption");
});

test("applies an explicitly forced same-field edit", async () => {
  const result = await patchAsset({ revision: 3, changes: { caption: "My caption" }, forceFields: ["caption"] });
  assert.equal(result.status, 200);
  assert.equal(result.body.asset.caption, "My caption");
});
```

- [ ] **Step 2: Run the endpoint tests to confirm they fail**

Run: `node --test test/asset-revision.test.mjs`

Expected: FAIL because no PATCH route exists.

- [ ] **Step 3: Implement `PATCH /api/assets/:id`**

Insert the route before the existing `POST /api/assets` upload route. It must:

```js
const post = planner.posts.find(item => item.id === url.pathname.split("/").pop());
if (!post) return sendJson(res, 404, { error: "This asset was removed by a teammate." });
const changes = normalizeAssetChanges(body.changes);
if (!Object.keys(changes).length) return sendJson(res, 400, { error: "Choose at least one asset field to update." });
```

Compare `body.revision` to `post.revision`. For a stale request, create `conflicts` from fields whose `fieldUpdatedRevision[field] > body.revision`. Return `409` unless every conflicted field is included in `forceFields`. Otherwise call `applyAssetChanges`, replace only the matching post in `planner.posts`, add one activity entry, write the planner, and return the normalized saved asset with `merged: submittedRevision !== post.revision`.

- [ ] **Step 4: Run endpoint tests to confirm they pass**

Run: `node --test test/asset-revision.test.mjs`

Expected: PASS.

- [ ] **Step 5: Run the full server test suite**

Run: `node --test test/*.test.mjs`

Expected: PASS with no test failures.

- [ ] **Step 6: Commit the endpoint**

```bash
git add server.mjs test/asset-revision.test.mjs
git commit -m "Add conflict-aware asset patch endpoint"
```

### Task 3: Replace full-planner asset saves in the browser

**Files:**
- Modify: `public/app.js:229-340,800-1010`
- Modify: `test/asset-save-conflict.test.mjs`

**Interfaces:**
- Consumes: `PATCH /api/assets/:id` response described in Task 2.
- Produces: `assetEditorBaseline(post)`, `assetEditorChanges(baseline, edited)`, and `replaceAsset(savedAsset)`.

- [ ] **Step 1: Write failing browser-state tests**

```js
test("sends only fields changed in the asset editor", () => {
  const baseline = { revision: 3, caption: "Before", notes: "" };
  assert.deepEqual(assetEditorChanges(baseline, { ...baseline, caption: "After" }), { caption: "After" });
});

test("replaces only the saved asset in local planner state", () => {
  const posts = [{ id: "a", caption: "Old" }, { id: "b", caption: "Unchanged" }];
  assert.deepEqual(replaceAsset(posts, { id: "a", caption: "New" }), [{ id: "a", caption: "New" }, { id: "b", caption: "Unchanged" }]);
});
```

- [ ] **Step 2: Run the browser-state tests to confirm they fail**

Run: `node --test test/asset-save-conflict.test.mjs`

Expected: FAIL because the new helpers do not exist.

- [ ] **Step 3: Implement asset-specific browser persistence**

Add helpers before `renderGrid`:

```js
function assetEditorBaseline(post) {
  return { revision: post.revision || 1, values: Object.fromEntries(ASSET_EDIT_FIELDS.map(field => [field, post[field]])) };
}

function assetEditorChanges(baseline, edited) {
  return Object.fromEntries(ASSET_EDIT_FIELDS
    .filter(field => JSON.stringify(baseline.values[field]) !== JSON.stringify(edited[field]))
    .map(field => [field, edited[field]]));
}
```

Capture the baseline when the standalone editor opens. Replace the Save handler’s call to `persistPlanner("updated planned content")` with `api(`/api/assets/${post.id}`, { method: "PATCH", ... })`. On `200`, replace only the returned asset in `posts`, render views, notify, and return to `editorReturnView`. Delete the current full-planner conflict retry for this save path.

- [ ] **Step 4: Run the browser-state tests to confirm they pass**

Run: `node --test test/asset-save-conflict.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit the client save-path change**

```bash
git add public/app.js test/asset-save-conflict.test.mjs
git commit -m "Save asset edits through revision-aware patches"
```

### Task 4: Add same-field conflict resolution in the asset editor

**Files:**
- Modify: `public/app.js:800-1010`
- Modify: `public/styles.css`
- Modify: `test/asset-save-conflict.test.mjs`

**Interfaces:**
- Consumes: `409 { asset, conflicts }` from Task 2 and the local pending `changes` object.
- Produces: inline controls with `data-conflict-field`, Keep mine, and Use latest actions.

- [ ] **Step 1: Write failing tests for conflict choices**

```js
test("keeps only conflicted fields pending after choosing the latest value", () => {
  assert.deepEqual(removeConflictField({ caption: "Mine", notes: "Notes" }, "caption"), { notes: "Notes" });
});

test("adds a selected field to the explicit force list", () => {
  assert.deepEqual(forceConflictField([], "caption"), ["caption"]);
});
```

- [ ] **Step 2: Run the conflict-choice tests to confirm they fail**

Run: `node --test test/asset-save-conflict.test.mjs`

Expected: FAIL because the conflict helpers do not exist.

- [ ] **Step 3: Implement the inline conflict panel and choices**

When the asset patch returns `409`, retain all editor form values, store `{ asset, conflicts, changes }` in editor-local state, and insert a panel above the Save action. For each conflict, show the field label, the teammate’s current value, their name/time, and two buttons:

```html
<button type="button" data-conflict-action="keep" data-conflict-field="caption">Keep mine</button>
<button type="button" data-conflict-action="latest" data-conflict-field="caption">Use latest</button>
```

Keep mine includes the field in `forceFields`; Use latest replaces that field in the editor with the server value and removes it from pending changes. Resubmit with the returned asset revision. If no pending fields remain, replace the local asset with the latest server asset and return to the originating view.

Add concise styles for the panel, field values, and buttons using the planner’s existing error and ghost-button palette.

- [ ] **Step 4: Run the conflict-choice tests to confirm they pass**

Run: `node --test test/asset-save-conflict.test.mjs`

Expected: PASS.

- [ ] **Step 5: Run complete verification and commit**

Run: `node --check public/app.js && node --check server.mjs && node --test test/*.test.mjs && git diff --check`

Expected: all syntax checks and tests pass with no whitespace errors.

```bash
git add public/app.js public/styles.css test/asset-save-conflict.test.mjs
git commit -m "Resolve same-field asset edit conflicts"
```

### Task 5: Deploy and verify the production save path

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes: the revised `public/app.js` asset bundle.
- Produces: a cache-busted production script URL.

- [ ] **Step 1: Bump the `app.js` query version**

Change the only application script tag to a new dated version string, for example:

```html
<script src="/app.js?v=20260908-asset-revisions"></script>
```

- [ ] **Step 2: Re-run complete verification**

Run: `node --check public/app.js && node --check server.mjs && node --test test/*.test.mjs && git diff --check`

Expected: all checks pass.

- [ ] **Step 3: Commit and push only the shared-editing work**

```bash
git add public/index.html
git commit -m "Deploy revision-aware asset editing"
git push origin main
```

- [ ] **Step 4: Confirm Vercel serves the new asset code**

Run: `curl -sS https://planner.lorenbullard.com/app.js?v=20260908-asset-revisions | rg "api/assets/.+PATCH|forceFields"`

Expected: the deployed bundle includes the asset patch and conflict-resolution logic.

## Plan self-review

- Spec coverage: Tasks 1–2 implement revisions, field metadata, automatic merges, same-field conflicts, and forced field resolution. Tasks 3–4 implement minimal browser patches, asset replacement, conflict UI, and dirty-editor preservation. Task 5 verifies production delivery.
- Placeholder scan: no unresolved implementation placeholders remain; every task names files, tests, commands, interfaces, and expected behavior.
- Type consistency: the browser sends `revision`, `changes`, `forceFields`, and `actor`; the PATCH route uses `fieldUpdatedRevision` to decide conflicts and returns `asset`, optional `merged`, and optional `conflicts`; the editor uses those names consistently.
