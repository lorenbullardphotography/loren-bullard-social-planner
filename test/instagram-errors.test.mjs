import test from "node:test";
import assert from "node:assert/strict";
import { fetchJson } from "../server.mjs";

test("preserves Instagram authentication errors when requests use URL objects", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { message: "Session has expired", code: 190 }
  }), { status: 400 });
  try {
    await assert.rejects(fetchJson(new URL("https://graph.instagram.com/v25.0/me")), error => {
      assert.equal(error.message, "Session has expired");
      assert.equal(error.details.error.code, 190);
      return true;
    });
  } finally { globalThis.fetch = originalFetch; }
});
