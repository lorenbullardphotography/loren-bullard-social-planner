// Gives a test file its own throwaway .data directory instead of the
// repo's real one. lib/store.mjs's local-file backend does an
// unsynchronized read-modify-write per key (read the whole JSON file,
// mutate, write the whole file back) — with every in-process test file
// pointed at the same real .data/*.json files, node --test running
// several of those files concurrently (it isolates each file into its own
// process, but they all still share the same disk) let two files
// interleave a read-modify-write on the same key, and the loser's write
// was silently discarded.
//
// Call setupIsolatedDataDir() and only then dynamically `import()`
// server.mjs (never a static top-level `import`) — DATA_DIR is read into a
// module-level constant the first time lib/store.mjs evaluates, and a
// static import would already have evaluated it before any of this
// module's code runs, since ES module imports evaluate before the
// importing module's own top-level body regardless of source order.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

export function setupIsolatedDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "planner-test-"));
  process.env.DATA_DIR = dir;
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
