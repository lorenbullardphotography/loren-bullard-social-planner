import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { setupIsolatedDataDir } from "./fixtures/isolated-data-dir.mjs";

setupIsolatedDataDir();
const { uploadTokenOptions } = await import("../server.mjs");

const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const start = source.indexOf("const THUMB_MIN_SOURCE_BYTES");
const end = source.indexOf('$("#upload").onchange');

function makeContext({ thumb = new Blob(["t"], { type: "image/jpeg" }), thumbError = null, uploadFailsFor = null } = {}) {
  const uploads = [];
  const context = vm.createContext({
    crypto: { randomUUID: () => "uuid-1" },
    File, Blob,
    extensionForMime: mime => (mime.split("/")[1] || "bin"),
    getStorageUsage: async () => ({ configured: true, usedBytes: 0, limitBytes: 1e12 }),
    loadBlobUpload: async () => async (pathname, body, options) => {
      if (uploadFailsFor && pathname.includes(uploadFailsFor)) throw new Error("thumb upload failed");
      uploads.push({ pathname, body, options });
      return { url: `https://store.public.blob.vercel-storage.com/${pathname}` };
    },
    api: async () => ({})
  });
  vm.runInContext(source.slice(start, end), context);
  context.makeThumbnailBlob = async () => { if (thumbError) throw thumbError; return thumb; };
  return { context, uploads };
}
const bigImage = () => new File([new Uint8Array(200 * 1024)], "a.jpg", { type: "image/jpeg" });

test("uploadAssetFile uploads a thumbnail beside the original at the thumbs path", async () => {
  const { context, uploads } = makeContext();
  const result = await context.uploadAssetFile(bigImage());
  assert.equal(result.url, "https://store.public.blob.vercel-storage.com/planner/uuid-1.jpeg");
  assert.equal(result.kind, "image");
  assert.deepEqual(uploads.map(u => u.pathname), ["planner/uuid-1.jpeg", "planner/thumbs/uuid-1.jpg"]);
  assert.equal(uploads[1].options.contentType, "image/jpeg");
  assert.equal(uploads[1].options.clientPayload, "image/jpeg");
});

test("uploadAssetFile skips the thumbnail when none can be generated", async () => {
  const { context, uploads } = makeContext({ thumb: null });
  const result = await context.uploadAssetFile(bigImage());
  assert.equal(result.kind, "image");
  assert.equal(uploads.length, 1);
});

test("uploadAssetFile still succeeds when thumbnail generation throws", async () => {
  const { context, uploads } = makeContext({ thumbError: new Error("decode failed") });
  const result = await context.uploadAssetFile(bigImage());
  assert.equal(result.kind, "image");
  assert.equal(uploads.length, 1);
});

test("uploadAssetFile still succeeds when the thumbnail upload fails", async () => {
  const { context } = makeContext({ uploadFailsFor: "thumbs/" });
  const result = await context.uploadAssetFile(bigImage());
  assert.equal(result.kind, "image");
});

test("uploadAssetFile does not make a thumbnail for files under 150 KB", async () => {
  const { context, uploads } = makeContext();
  await context.uploadAssetFile(new File([new Uint8Array(1000)], "s.jpg", { type: "image/jpeg" }));
  assert.equal(uploads.length, 1);
});

test("upload tokens request a one-year cache lifetime and still gate path and type", () => {
  const usage = { usedBytes: 0, limitBytes: 1000 };
  const ok = uploadTokenOptions("planner/thumbs/x.jpg", "image/jpeg", usage);
  assert.equal(ok.cacheControlMaxAge, 31536000);
  assert.deepEqual(ok.allowedContentTypes, ["image/jpeg"]);
  assert.equal(ok.addRandomSuffix, false);
  assert.equal(ok.maximumSizeInBytes, 1000);
  assert.throws(() => uploadTokenOptions("other/x.jpg", "image/jpeg", usage), /Invalid upload path/);
  assert.throws(() => uploadTokenOptions("planner/x.json", "application/json", usage), /Only images and reels/);
});
