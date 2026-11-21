import test from "node:test";
import assert from "node:assert/strict";
import { planThumbnails } from "../scripts/backfill-thumbnails.mjs";

const KB = 1024;
const blob = (pathname, size = 500 * KB) => ({ pathname, size });

test("plans a thumbnail for each large image that lacks one", () => {
  const plan = planThumbnails([blob("planner/a.jpg"), blob("planner/b.jpeg"), blob("planner/c.png"), blob("planner/d.webp")]);
  assert.deepEqual(plan.map(item => item.pathname), ["planner/a.jpg", "planner/b.jpeg", "planner/c.png", "planner/d.webp"]);
  assert.deepEqual(plan.map(item => item.thumbPathname), ["planner/thumbs/a.jpg", "planner/thumbs/b.jpg", "planner/thumbs/c.jpg", "planner/thumbs/d.jpg"]);
});

test("skips images that already have a thumbnail in the listing", () => {
  const plan = planThumbnails([blob("planner/a.jpg"), blob("planner/thumbs/a.jpg", 30 * KB), blob("planner/b.jpg")]);
  assert.deepEqual(plan.map(item => item.pathname), ["planner/b.jpg"]);
});

test("skips thumbnails themselves, videos, small files and other prefixes", () => {
  const plan = planThumbnails([
    blob("planner/thumbs/x.jpg"), blob("planner/v.mov"), blob("planner/v.mp4"), blob("planner/small.jpg", 100 * KB),
    blob("other/a.jpg"), blob("planner/notes.txt")
  ]);
  assert.deepEqual(plan, []);
});

test("two images that would share a thumbnail name are planned once per source file", () => {
  const plan = planThumbnails([blob("planner/a.jpg"), blob("planner/a.png")]);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].thumbPathname, plan[1].thumbPathname);
});
