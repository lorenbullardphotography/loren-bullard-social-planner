import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { normalizePost } from "../server.mjs";
import { createPlannerService } from "../lib/planner-service.mjs";
import { createPlannerRepository } from "../lib/planner-repository.mjs";

test("new assets receive a position before the current first asset", async () => {
  const repository = createPlannerRepository({ sql: () => {}, workspaceId: "default" });
  for (const minSort of [0, 1024, -4096]) {
    const key = await repository.nextAssetSortKey(async () => [{ minSort }]);
    assert.ok(key < minSort);
  }
});

test("asset creation returns the saved grid position to the uploading browser", async () => {
  let saved;
  const repository = {
    withTransaction: fn => fn({}),
    nextAssetSortKey: async () => -2048,
    insertAssetRow: async (_, row) => { saved = row; return row; },
    recordChange: async () => 1,
    setAssetChangedSequence: async () => {},
    recordActivity: async () => {}
  };
  const result = await createPlannerService({ repository }).createAsset({ asset: { id: "new" } });
  assert.equal(result.asset.gridSortKey, saved.sortKey);
});

test("new uploads and Canva assets sort ahead of existing grid positions", () => {
  const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const functions = source.slice(source.indexOf("function future()"), source.indexOf("function posted()"));
  const context = vm.createContext({ posts: [{ id: "old", gridSortKey: -1024 }], workflowOf: () => "draft" });
  vm.runInContext(functions, context);
  for (const source of ["uploaded", "canva"]) {
    vm.runInContext('posts.unshift({ id: "' + source + '", gridSortKey: newestGridSortKey() })', context);
    assert.equal(vm.runInContext("future()[0].id", context), source);
  }
});

test("existing Instagram posts use a stable image route instead of expired CDN links", () => {
  const post = normalizePost({ id: "old", metaId: "12345", image: "https://expired.example/photo.jpg", images: ["https://expired.example/photo.jpg"] });
  assert.equal(post.image, "/api/instagram/image/12345");
  assert.deepEqual(post.images, [post.image]);
  assert.equal(normalizePost(post).image, post.image);
  assert.equal(normalizePost({ image: "/uploads/photo.jpg" }).image, "/uploads/photo.jpg");
});
