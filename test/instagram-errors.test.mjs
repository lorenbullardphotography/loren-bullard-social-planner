import test from "node:test";
import assert from "node:assert/strict";
import { fetchJson, instagramConnectionError } from "../server.mjs";

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


test("expired Instagram sessions prompt reconnection rather than reporting connected", () => {
  const status = instagramConnectionError({ message: "Expired", details: { error: { code: 190 } } });
  assert.equal(status.connected, false);
  assert.equal(status.requiresReconnect, true);
  assert.match(status.error, /Reconnect Instagram/);
});

test("temporary Instagram failures do not discard a valid connection", () => {
  const status = instagramConnectionError(new Error("Temporarily unavailable"));
  assert.equal(status.connected, true);
  assert.equal(status.requiresReconnect, false);
});
