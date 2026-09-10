import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("prefers a direct Postgres connection over the Supabase REST proxy", () => {
  const source = fs.readFileSync(new URL("../lib/store.mjs", import.meta.url), "utf8");
  const readStored = source.match(/export async function readStored\(key, fallback\) \{([\s\S]*?)\n\}/)?.[1] || "";

  assert.ok(readStored.indexOf("if (useDatabase)") < readStored.indexOf("if (useSupabaseRest)"));
});
