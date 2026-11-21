import test from "node:test";
import assert from "node:assert/strict";
import { createUsageCache } from "../lib/blob-usage-cache.mjs";

function harness({ stored = null, listBytes = 1000, now = { t: 1_000_000 } } = {}) {
  const store = { value: stored };
  const counts = { list: 0, save: 0 };
  const cache = () => createUsageCache({
    ttlMs: 600_000,
    now: () => now.t,
    load: async () => store.value,
    save: async snapshot => { counts.save++; store.value = snapshot; },
    list: async () => { counts.list++; return listBytes; }
  });
  return { store, counts, cache, now };
}

test("two reads within the TTL recount the store once", async () => {
  const h = harness();
  const cache = h.cache();
  assert.equal((await cache.get()).usedBytes, 1000);
  await cache.get();
  assert.equal(h.counts.list, 1);
});

test("a read after the TTL recounts", async () => {
  const h = harness();
  const cache = h.cache();
  await cache.get();
  h.now.t += 600_001;
  await cache.get();
  assert.equal(h.counts.list, 2);
});

test("a snapshot saved by one instance is used by another instance without recounting", async () => {
  const h = harness();
  await h.cache().get();
  const other = h.cache();
  assert.equal((await other.get()).usedBytes, 1000);
  assert.equal(h.counts.list, 1);
});

test("nudge adjusts the persisted total without recounting and never goes negative", async () => {
  const h = harness();
  const cache = h.cache();
  await cache.get();
  await cache.nudge(500);
  assert.equal((await cache.get()).usedBytes, 1500);
  assert.equal(h.store.value.usedBytes, 1500);
  await cache.nudge(-99999);
  assert.equal((await cache.get()).usedBytes, 0);
  assert.equal(h.counts.list, 1);
});

test("a missing or malformed persisted snapshot triggers a recount instead of an error", async () => {
  for (const stored of [null, "garbage", { usedBytes: "x" }, { usedBytes: 5 }, 42]) {
    const h = harness({ stored });
    assert.equal((await h.cache().get()).usedBytes, 1000, JSON.stringify(stored));
  }
});

test("invalidate forces the next read to recount even inside the TTL", async () => {
  const h = harness();
  const cache = h.cache();
  await cache.get();
  cache.invalidate();
  await cache.get();
  assert.equal(h.counts.list, 2);
});

test("a failed recount rejects and leaves the previous snapshot in place", async () => {
  const h = harness();
  const good = h.cache();
  await good.get();
  h.now.t += 700_000;
  const failing = createUsageCache({
    ttlMs: 600_000, now: () => h.now.t, load: async () => h.store.value, save: async s => { h.store.value = s; },
    list: async () => { throw new Error("blob list failed"); }
  });
  await assert.rejects(() => failing.get(), /blob list failed/);
  assert.equal(h.store.value.usedBytes, 1000);
});

test("a save failure does not break reads", async () => {
  const cache = createUsageCache({ ttlMs: 600_000, now: () => 1, load: async () => null, save: async () => { throw new Error("db down"); }, list: async () => 7 });
  assert.equal((await cache.get()).usedBytes, 7);
});
