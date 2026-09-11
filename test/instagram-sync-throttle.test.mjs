import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// The shared Instagram session (see publicInstagramStatus's `shared: true`)
// means last_synced_at is a single server-wide timestamp, not per-browser.
// Before this fix, every page load called syncInstagram({silent:true})
// unconditionally whenever Instagram was connected, with no regard for how
// recently anyone had synced — and getInstagramMedia() deliberately fetches
// the *entire* media history every call (see layout.test.mjs's "syncs all
// instagram media without restricting by syncPhotoCount"). With several
// teammates refreshing/opening tabs throughout the day, that combination
// re-pulled the whole Instagram history on every single load, hammering the
// Graph API into rate-limit errors.

test("throttles the automatic page-load Instagram sync against last_synced_at", () => {
  const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const init = source.match(/async function init\(\) \{([\s\S]*?)\n\}/)?.[1] || "";

  assert.match(source, /INSTAGRAM_AUTO_SYNC_COOLDOWN_MS/);
  assert.match(init, /igStatus\.connected && !initialInstagramSyncDone/);
  // The auto-sync must be gated on how long it's been since the shared
  // session last synced, not fire unconditionally on every load.
  assert.match(init, /igStatus\.last_synced_at/);
  assert.match(init, /INSTAGRAM_AUTO_SYNC_COOLDOWN_MS/);
});

test("connecting Instagram does not double-fire a sync against init()'s own auto-sync", () => {
  const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const connectedHandler = source.match(/if \(query\.get\("meta"\) === "connected"\) \{([\s\S]*?)\n\}/)?.[1] || "";

  // Previously this block scheduled its own syncInstagram() call without
  // marking initialInstagramSyncDone, so init()'s checkInstagram().then(...)
  // ran a second, concurrent full sync moments later.
  assert.match(connectedHandler, /initialInstagramSyncDone\s*=\s*true/);
});
