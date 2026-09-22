// Needed only by the undo scenarios below, to look up a planner_activity
// row's id directly — there's no client-facing "list row-storage activity"
// endpoint yet (out of scope for Task 8), so tests reach into the database
// the same way a future activity-feed endpoint eventually would.
async function latestActivityId(databaseUrl, entityId) {
  const { default: postgres } = await import("postgres");
  const sql = postgres(databaseUrl, { ssl: false });
  const [row] = await sql`SELECT id FROM planner_activity WHERE entity_id = ${entityId} ORDER BY created_at DESC LIMIT 1`;
  await sql.end({ timeout: 1 });
  return row?.id;
}

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
} else if (scenario === "change-feed") {
  const initial = await call("GET", "/api/planner/changes?since=0", undefined, cookie);
  const a = await createAsset("feed asset a");
  const b = await createAsset("feed asset b");
  await call("PATCH", `/api/assets/${a.id}`, { revision: a.revision, changes: { caption: "a edited" }, actor: { name: "Loren" } }, cookie);
  await call("DELETE", `/api/assets/${b.id}`, { actor: { name: "Loren" } }, cookie);

  const afterMutations = await call("GET", "/api/planner/changes?since=0", undefined, cookie);
  const noChange = await call("GET", `/api/planner/changes?since=${afterMutations.json.nextToken}`, undefined, cookie);

  const aChange = afterMutations.json.changes.find(c => c.entityId === a.id);
  const bChange = afterMutations.json.changes.find(c => c.entityId === b.id);

  console.log(JSON.stringify({
    initialStatus: initial.status,
    afterMutationsStatus: afterMutations.status,
    changeCount: afterMutations.json.changes.length,
    aDeleted: aChange?.deleted,
    aCaption: aChange?.data?.caption,
    bDeleted: bChange?.deleted,
    bData: bChange?.data,
    noChangeStatus: noChange.status
  }));
} else if (scenario === "undo-delete-restores-asset") {
  const a = await createAsset("undo me");
  const del = await call("DELETE", `/api/assets/${a.id}`, { actor: { name: "Loren" } }, cookie);
  const activityId = await latestActivityId(process.env.DATABASE_URL, a.id);
  const undo = await call("POST", `/api/activity/${activityId}/undo`, { actor: { name: "Brooke" } }, cookie);
  const patchAfterUndo = await call("PATCH", `/api/assets/${a.id}`, { revision: a.revision, changes: { caption: "still here" }, actor: { name: "Loren" } }, cookie);
  console.log(JSON.stringify({
    deleted: del.status, undo: { status: undo.status, entityId: undo.json?.entityId },
    patchAfterUndo: { status: patchAfterUndo.status }
  }));
} else if (scenario === "undo-stale-after-recreate") {
  // Task 8's literal scenario: delete asset A, then a teammate re-creates
  // an asset reusing the same id (e.g. a retried client-side create) before
  // the undo is attempted — undo must detect the id is no longer in the
  // exact deleted state it left it in and refuse, not blindly restore.
  const a = await createAsset("original");
  await call("DELETE", `/api/assets/${a.id}`, { actor: { name: "Loren" } }, cookie);
  const activityId = await latestActivityId(process.env.DATABASE_URL, a.id);
  const recreated = await call("POST", "/api/planner/assets", { asset: { id: a.id, image: "/new.jpg", caption: "recreated by teammate" }, actor: { name: "Brooke" } }, cookie);
  const undo = await call("POST", `/api/activity/${activityId}/undo`, { actor: { name: "Loren" } }, cookie);
  const stillRecreated = await call("GET", "/api/planner", undefined, cookie);
  console.log(JSON.stringify({
    recreatedStatus: recreated.status,
    undo: { status: undo.status, code: undo.json?.code },
    // Confirm the recreated asset's data survived untouched (undo did not
    // silently overwrite it with the old pre-delete state).
    survivedCaption: recreated.json?.asset?.caption
  }));
} else if (scenario === "undo-create-stale-after-edit") {
  const a = await createAsset("brand new");
  const activityId = await latestActivityId(process.env.DATABASE_URL, a.id);
  await call("PATCH", `/api/assets/${a.id}`, { revision: a.revision, changes: { caption: "edited before undo" }, actor: { name: "Brooke" } }, cookie);
  const undo = await call("POST", `/api/activity/${activityId}/undo`, { actor: { name: "Loren" } }, cookie);
  console.log(JSON.stringify({ undo: { status: undo.status, code: undo.json?.code } }));
} else if (scenario === "undo-twice-second-is-not-reversible") {
  const a = await createAsset("undo twice");
  await call("DELETE", `/api/assets/${a.id}`, { actor: { name: "Loren" } }, cookie);
  const activityId = await latestActivityId(process.env.DATABASE_URL, a.id);
  const first = await call("POST", `/api/activity/${activityId}/undo`, { actor: { name: "Loren" } }, cookie);
  const second = await call("POST", `/api/activity/${activityId}/undo`, { actor: { name: "Loren" } }, cookie);
  console.log(JSON.stringify({ first: { status: first.status }, second: { status: second.status, code: second.json?.code } }));
} else if (scenario === "undo-reorder-restores-position") {
  const a = await createAsset("a");
  const b = await createAsset("b");
  const c = await createAsset("c");
  const reorder = await call("POST", `/api/assets/${c.id}/reorder`, { beforeId: null, afterId: a.id, actor: { name: "Loren" } }, cookie);
  const activityId = await latestActivityId(process.env.DATABASE_URL, c.id);
  const undo = await call("POST", `/api/activity/${activityId}/undo`, { actor: { name: "Brooke" } }, cookie);
  console.log(JSON.stringify({ reorder: reorder.status, undo: { status: undo.status, sortKeyRestored: undo.json?.asset != null } }));
} else if (scenario === "undo-settings-not-reversible") {
  const settingsPatch = await call("PATCH", "/api/settings", { revision: 1, changes: { syncPhotoCount: 20 }, actor: { name: "Loren" } }, cookie);
  const activityId = await latestActivityId(process.env.DATABASE_URL, "settings");
  const undo = await call("POST", `/api/activity/${activityId}/undo`, { actor: { name: "Loren" } }, cookie);
  console.log(JSON.stringify({ settingsPatch: settingsPatch.status, undo: { status: undo.status, code: undo.json?.code } }));
}

server.close();
process.exit(0);
