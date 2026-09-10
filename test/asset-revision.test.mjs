import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizePost,
  normalizeAssetChanges,
  applyAssetChanges,
  assetConflicts,
  ASSET_EDITABLE_FIELDS
} from "../server.mjs";

test("normalizes a legacy post with an initial revision", () => {
  const normalized = normalizePost({ id: "asset-1", image: "/photo.jpg" });
  assert.equal(normalized.revision, 1);
  assert.deepEqual(normalized.fieldUpdatedRevision, {});
  assert.deepEqual(normalized.fieldUpdatedAt, {});
  assert.deepEqual(normalized.fieldUpdatedBy, {});
});

test("records metadata only for fields that changed", () => {
  const initial = normalizePost({ id: "asset-1", image: "/photo.jpg", revision: 3, caption: "Before" });
  const updated = applyAssetChanges(
    initial,
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

test("normalizes only allowed editable asset fields", () => {
  const changes = normalizeAssetChanges({
    caption: "New caption",
    priority: "high",
    invalidField: "discard me",
    revision: 99
  });
  assert.deepEqual(changes, {
    caption: "New caption",
    priority: "high"
  });
});

test("detects same-field conflicts when fieldUpdatedRevision is newer than submitted revision", () => {
  const post = normalizePost({
    id: "asset-1",
    image: "/photo.jpg",
    revision: 5,
    caption: "Teammate caption",
    fieldUpdatedRevision: { caption: 5, notes: 3 },
    fieldUpdatedAt: { caption: "2026-09-08T20:00:00.000Z" },
    fieldUpdatedBy: { caption: "Brooke" }
  });

  const conflicts = assetConflicts(post, 3, { caption: "My caption", notes: "My notes" });
  assert.ok(conflicts.caption);
  assert.equal(conflicts.caption.currentValue, "Teammate caption");
  assert.equal(conflicts.caption.updatedBy, "Brooke");
  assert.equal(conflicts.caption.updatedAt, "2026-09-08T20:00:00.000Z");
  assert.equal(conflicts.notes, undefined);
});

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { handleRequest } from "../server.mjs";
import { writeStored } from "../lib/store.mjs";

const plannerDataFile = path.join(process.cwd(), ".data", "planner-data.json");
let originalPlannerData = null;

test.before(() => {
  if (fs.existsSync(plannerDataFile)) {
    originalPlannerData = fs.readFileSync(plannerDataFile, "utf8");
  }
});

test.after(() => {
  if (originalPlannerData != null) {
    fs.writeFileSync(plannerDataFile, originalPlannerData, "utf8");
  }
});

function createMockReq({ method = "GET", url = "/", body = null, headers = {} }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost:8787", ...headers };
  process.nextTick(() => {
    if (body != null) {
      req.emit("data", Buffer.from(typeof body === "string" ? body : JSON.stringify(body)));
    }
    req.emit("end");
  });
  return req;
}

function createMockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    writeHead(code, headers) {
      this.statusCode = code;
      Object.assign(this.headers, headers);
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(data) {
      if (data) this.body += data;
      this.resolve?.({
        status: this.statusCode,
        headers: this.headers,
        body: this.body ? JSON.parse(this.body) : null
      });
    }
  };
}

async function makeRequest(options) {
  const req = createMockReq(options);
  const res = createMockRes();
  const promise = new Promise(resolve => { res.resolve = resolve; });
  await handleRequest(req, res);
  return promise;
}

async function setupAuthenticatedPlanner() {
  const loginRes = await makeRequest({ method: "POST", url: "/auth/login", body: { login: "Loren", password: "admin" } });
  const cookie = (loginRes.headers["Set-Cookie"] || "").split(";")[0];

  const post = normalizePost({
    id: "asset-patch-test",
    image: "/photo.jpg",
    revision: 3,
    caption: "Teammate caption",
    notes: "Old notes",
    fieldUpdatedRevision: { caption: 3, notes: 2 },
    fieldUpdatedAt: { caption: "2026-09-08T19:00:00.000Z" },
    fieldUpdatedBy: { caption: "Brooke" }
  });

  await writeStored("planner-data", {
    version: 1,
    posts: [post],
    scratch: [],
    team: [],
    activity: [],
    settings: { syncPhotoCount: 12, workflowAutomations: [] }
  });

  return { cookie, postId: post.id };
}

test("merges a stale edit to a different field", async () => {
  const { cookie, postId } = await setupAuthenticatedPlanner();
  const result = await makeRequest({
    method: "PATCH",
    url: `/api/assets/${postId}`,
    headers: { cookie },
    body: { revision: 2, changes: { notes: "New notes" }, actor: { name: "Loren" } }
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.merged, true);
  assert.equal(result.body.asset.caption, "Teammate caption");
  assert.equal(result.body.asset.notes, "New notes");
  assert.equal(result.body.asset.revision, 4);
});

test("keeps simultaneous different-field asset saves", async () => {
  const { cookie, postId } = await setupAuthenticatedPlanner();
  const [captionSave, notesSave] = await Promise.all([
    makeRequest({
      method: "PATCH",
      url: `/api/assets/${postId}`,
      headers: { cookie },
      body: { revision: 3, changes: { caption: "Caption saved at the same time" }, actor: { name: "Loren" } }
    }),
    makeRequest({
      method: "PATCH",
      url: `/api/assets/${postId}`,
      headers: { cookie },
      body: { revision: 3, changes: { notes: "Notes saved at the same time" }, actor: { name: "Brooke" } }
    })
  ]);

  assert.equal(captionSave.status, 200);
  assert.equal(notesSave.status, 200);
  const planner = await makeRequest({ method: "GET", url: "/api/planner", headers: { cookie } });
  assert.equal(planner.body.posts[0].caption, "Caption saved at the same time");
  assert.equal(planner.body.posts[0].notes, "Notes saved at the same time");
});

test("updates an asset without advancing the shared planner version", async () => {
  const { cookie, postId } = await setupAuthenticatedPlanner();
  const result = await makeRequest({
    method: "PATCH",
    url: `/api/assets/${postId}`,
    headers: { cookie },
    body: { revision: 3, changes: { notes: "Saved independently" }, actor: { name: "Loren" } }
  });

  assert.equal(result.status, 200);
  const planner = await makeRequest({ method: "GET", url: "/api/planner", headers: { cookie } });
  assert.equal(planner.body.version, 1);
  assert.equal(planner.body.posts[0].notes, "Saved independently");
});

test("merges a new comment with comments added by a teammate", async () => {
  const { cookie, postId } = await setupAuthenticatedPlanner();
  const first = await makeRequest({
    method: "PATCH",
    url: `/api/assets/${postId}`,
    headers: { cookie },
    body: {
      revision: 3,
      changes: { comments: [{ author: "Brooke", text: "Teammate feedback", at: "2026-09-08T20:00:00.000Z" }] },
      actor: { name: "Brooke" }
    }
  });
  assert.equal(first.status, 200);

  const second = await makeRequest({
    method: "PATCH",
    url: `/api/assets/${postId}`,
    headers: { cookie },
    body: {
      revision: 3,
      changes: { comments: [{ author: "Loren", text: "My feedback", at: "2026-09-08T20:01:00.000Z" }] },
      actor: { name: "Loren" }
    }
  });

  assert.equal(second.status, 200);
  assert.deepEqual(second.body.asset.comments.map(comment => comment.text), ["Teammate feedback", "My feedback"]);
});

test("returns a structured conflict for a stale same-field edit", async () => {
  const { cookie, postId } = await setupAuthenticatedPlanner();
  const result = await makeRequest({
    method: "PATCH",
    url: `/api/assets/${postId}`,
    headers: { cookie },
    body: { revision: 2, changes: { caption: "My caption" }, actor: { name: "Loren" } }
  });

  assert.equal(result.status, 409);
  assert.equal(result.body.conflicts.caption.currentValue, "Teammate caption");
});

test("applies an explicitly forced same-field edit", async () => {
  const { cookie, postId } = await setupAuthenticatedPlanner();
  const result = await makeRequest({
    method: "PATCH",
    url: `/api/assets/${postId}`,
    headers: { cookie },
    body: { revision: 2, changes: { caption: "My caption" }, forceFields: ["caption"], actor: { name: "Loren" } }
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.asset.caption, "My caption");
  assert.equal(result.body.asset.revision, 4);
});

test("returns 404 if asset does not exist", async () => {
  const { cookie } = await setupAuthenticatedPlanner();
  const result = await makeRequest({
    method: "PATCH",
    url: "/api/assets/non-existent-id",
    headers: { cookie },
    body: { revision: 1, changes: { caption: "My caption" } }
  });

  assert.equal(result.status, 404);
  assert.equal(result.body.error, "This asset was removed by a teammate.");
});

test("returns 400 if changes object contains no valid editable fields", async () => {
  const { cookie, postId } = await setupAuthenticatedPlanner();
  const result = await makeRequest({
    method: "PATCH",
    url: `/api/assets/${postId}`,
    headers: { cookie },
    body: { revision: 3, changes: { invalidField: "test" } }
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.error, "Choose at least one asset field to update.");
});
