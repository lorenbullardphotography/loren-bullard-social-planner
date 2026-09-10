// Spawned as a fresh child process by planner-collaboration.test.mjs — see
// fixtures/planner-api-server.mjs for why (PLANNER_ROW_STORAGE_ENABLED and
// DATABASE_URL must be real env vars before server.mjs first imports
// lib/store.mjs, and the real HTTP server + fetch() sidesteps this repo's
// EventEmitter req/res mock losing a race against real Postgres I/O).
import http from "node:http";
import { handleRequest } from "../../server.mjs";

const server = http.createServer(handleRequest);
await new Promise(resolve => server.listen(0, resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, path, body, cookie) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const cookieHeader = response.headers.get("set-cookie")?.split(";")[0] || "";
  let json = null;
  try { json = await response.json(); } catch {}
  return { status: response.status, cookie: cookieHeader, json };
}

const login = await call("POST", "/auth/login", { login: "Loren", password: "admin" });
const cookie = login.cookie;

async function createAsset(caption) {
  const created = await call("POST", "/api/planner/assets", { asset: { image: "/x.jpg", caption }, actor: { name: "Loren" } }, cookie);
  return created.json.asset;
}

const scenario = process.argv[2];

if (scenario === "reorder-does-not-block-concurrent-edit") {
  const a = await createAsset("asset a");
  const b = await createAsset("asset b");
  const [reorderResult, patchResult] = await Promise.all([
    call("POST", `/api/assets/${a.id}/reorder`, { beforeId: null, afterId: b.id, actor: { name: "Loren" } }, cookie),
    call("PATCH", `/api/assets/${b.id}`, { revision: b.revision, changes: { caption: "b edited concurrently" }, actor: { name: "Brooke" } }, cookie)
  ]);
  console.log(JSON.stringify({
    reorder: { status: reorderResult.status },
    patch: { status: patchResult.status, caption: patchResult.json?.asset?.caption }
  }));
} else if (scenario === "move-to-start-and-end") {
  const a = await createAsset("a");
  const b = await createAsset("b");
  const c = await createAsset("c");
  // Initial order: a, b, c. Move c to the very start.
  const moveStart = await call("POST", `/api/assets/${c.id}/reorder`, { beforeId: null, afterId: a.id, actor: { name: "Loren" } }, cookie);
  // Move a to the very end.
  const moveEnd = await call("POST", `/api/assets/${a.id}/reorder`, { beforeId: b.id, afterId: null, actor: { name: "Loren" } }, cookie);
  console.log(JSON.stringify({
    moveStart: { status: moveStart.status },
    moveEnd: { status: moveEnd.status }
  }));
} else if (scenario === "respace-on-shrinking-gap") {
  // Repeatedly insert a brand-new asset into the gap between `lo` and
  // whichever asset is currently nearest to it, halving that gap each
  // time, until precision runs out and the service re-spaces everything.
  const lo = await createAsset("lo");
  let nearest = await createAsset("hi");
  let last;
  for (let i = 0; i < 60; i++) {
    const filler = await createAsset(`filler ${i}`);
    last = await call("POST", `/api/assets/${filler.id}/reorder`, { beforeId: lo.id, afterId: nearest.id, actor: { name: "Loren" } }, cookie);
    if (last.json?.affected?.length > 1) break;
    nearest = filler;
  }
  console.log(JSON.stringify({ status: last.status, affectedCount: last.json?.affected?.length }));
} else if (scenario === "reorder-missing-neighbor-conflict") {
  const a = await createAsset("a");
  const b = await createAsset("b");
  await call("DELETE", `/api/assets/${b.id}`, { actor: { name: "Loren" } }, cookie);
  const result = await call("POST", `/api/assets/${a.id}/reorder`, { beforeId: b.id, afterId: null, actor: { name: "Loren" } }, cookie);
  console.log(JSON.stringify({ status: result.status }));
}

server.close();
process.exit(0);
