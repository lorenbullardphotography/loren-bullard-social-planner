// Total Blob usage is expensive to compute (list() is an "advanced operation"
// with a 2,000/month Hobby cap), so the total is persisted and shared across
// serverless instances, recounted at most once per TTL, and nudged in place
// by the uploads and deletes this app performs itself.
const MEMO_MS = 30_000;

function validSnapshot(value) {
  return value && typeof value === "object" && Number.isFinite(value.usedBytes) && value.usedBytes >= 0 && Number.isFinite(value.fetchedAt);
}

export function createUsageCache({ ttlMs = 600_000, now = Date.now, load, save, list }) {
  let memo = null;
  let memoAt = 0;
  let forceRecount = false;

  async function persist(snapshot) {
    memo = snapshot;
    memoAt = now();
    try { await save(snapshot); } catch {}
  }

  async function get() {
    if (!forceRecount && memo && now() - memoAt < MEMO_MS) return memo;
    if (!forceRecount) {
      let stored = null;
      try { stored = await load(); } catch {}
      if (validSnapshot(stored) && now() - stored.fetchedAt < ttlMs) {
        memo = stored;
        memoAt = now();
        return stored;
      }
    }
    const usedBytes = await list();
    forceRecount = false;
    const snapshot = { usedBytes, fetchedAt: now() };
    await persist(snapshot);
    return snapshot;
  }

  async function nudge(bytes) {
    const current = await get();
    await persist({ usedBytes: Math.max(0, current.usedBytes + bytes), fetchedAt: current.fetchedAt });
  }

  function invalidate() {
    memo = null;
    forceRecount = true;
  }

  return { get, nudge, invalidate };
}
