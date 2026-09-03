import test from "node:test";
import assert from "node:assert/strict";
import { preferredCanvaExportType, waitForCanvaExport } from "../server.mjs";

test("waits for a reel export that completes after the original six-second window", async () => {
  const originalFetch = globalThis.fetch;
  let polls = 0;
  globalThis.fetch = async url => {
    if (String(url).endsWith("job-123")) {
      polls += 1;
      const body = polls < 13
        ? { job: { id: "job-123", status: "in_progress" } }
        : { job: { id: "job-123", status: "success", urls: ["https://downloads.canva.test/reel.mp4"] } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const result = await waitForCanvaExport({ job: { id: "job-123", status: "in_progress" } }, "test-token", { intervalMs: 0 });
    assert.equal(result.urls[0], "https://downloads.canva.test/reel.mp4");
    assert.equal(polls, 13);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("prefers MP4 when Canva reports that the design supports it", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ formats: { jpg: {}, mp4: {} } }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });

  try {
    assert.equal(await preferredCanvaExportType("design-123", "test-token"), "mp4");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
