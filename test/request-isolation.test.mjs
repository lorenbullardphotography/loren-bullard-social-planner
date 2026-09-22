import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("does not read Instagram storage before unrelated API requests", () => {
  const source = fs.readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const requestHandler = source.match(/export async function handleRequest\(req, res\) \{([\s\S]*?)\n\}/)?.[1] || "";
  const readSession = source.match(/async function readSession\(\) \{([\s\S]*?)\n\}/)?.[1] || "";

  assert.doesNotMatch(requestHandler, /seedEnvironmentSession\(\)/);
  assert.match(readSession, /await seedEnvironmentSession\(\)/);
});
