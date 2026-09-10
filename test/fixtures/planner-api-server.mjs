// Spawned as a fresh child process by planner-api.test.mjs so that
// PLANNER_ROW_STORAGE_ENABLED and DATABASE_URL are real environment
// variables in place before server.mjs (and lib/store.mjs) are first
// imported — both are read into module-level constants on first import,
// so setting them mid-process would silently have no effect. Starts a real
// HTTP server and runs whatever scenario name is passed as argv[2],
// printing one JSON result line to stdout. See
// test/planner-migration.test.mjs / run-migration-e2e.mjs for why this
// uses a real server + fetch() rather than the EventEmitter req/res mock
// most of this repo's other tests use (that mock's event timing races
// against real Postgres I/O and silently drops the request body).
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

async function signIn() {
  const login = await call("POST", "/auth/login", { login: "Loren", password: "admin" });
  return login.cookie;
}

const scenario = process.argv[2];
const cookie = await signIn();

if (scenario === "concurrent-different-assets") {
  const a = await call("POST", "/api/planner/assets", { asset: { image: "/a.jpg", caption: "asset a" }, actor: { name: "Loren" } }, cookie);
  const b = await call("POST", "/api/planner/assets", { asset: { image: "/b.jpg", caption: "asset b" }, actor: { name: "Loren" } }, cookie);
  const [patchA, patchB] = await Promise.all([
    call("PATCH", `/api/assets/${a.json.asset.id}`, { revision: a.json.asset.revision, changes: { caption: "a edited" }, actor: { name: "Loren" } }, cookie),
    call("PATCH", `/api/assets/${b.json.asset.id}`, { revision: b.json.asset.revision, changes: { caption: "b edited" }, actor: { name: "Brooke" } }, cookie)
  ]);
  console.log(JSON.stringify({ patchA: { status: patchA.status, caption: patchA.json?.asset?.caption }, patchB: { status: patchB.status, caption: patchB.json?.asset?.caption } }));
} else if (scenario === "different-fields-merge") {
  const created = await call("POST", "/api/planner/assets", { asset: { image: "/c.jpg", caption: "original", notes: "original notes" }, actor: { name: "Loren" } }, cookie);
  const id = created.json.asset.id;
  const baseRevision = created.json.asset.revision;
  const [captionPatch, notesPatch] = await Promise.all([
    call("PATCH", `/api/assets/${id}`, { revision: baseRevision, changes: { caption: "new caption" }, actor: { name: "Loren" } }, cookie),
    call("PATCH", `/api/assets/${id}`, { revision: baseRevision, changes: { notes: "new notes" }, actor: { name: "Brooke" } }, cookie)
  ]);
  const final = await call("GET", "/api/planner", undefined, cookie);
  console.log(JSON.stringify({
    captionPatch: { status: captionPatch.status },
    notesPatch: { status: notesPatch.status }
  }));
} else if (scenario === "stale-same-field-conflict") {
  const created = await call("POST", "/api/planner/assets", { asset: { image: "/d.jpg", caption: "original" }, actor: { name: "Loren" } }, cookie);
  const id = created.json.asset.id;
  const baseRevision = created.json.asset.revision;
  const first = await call("PATCH", `/api/assets/${id}`, { revision: baseRevision, changes: { caption: "first writer wins the field" }, actor: { name: "Loren" } }, cookie);
  const stale = await call("PATCH", `/api/assets/${id}`, { revision: baseRevision, changes: { caption: "stale writer loses" }, actor: { name: "Brooke" } }, cookie);
  console.log(JSON.stringify({
    first: { status: first.status },
    stale: { status: stale.status, code: stale.json?.code, currentCaption: stale.json?.conflicts?.caption?.currentValue }
  }));
} else if (scenario === "create-then-delete") {
  const created = await call("POST", "/api/planner/assets", { asset: { image: "/e.jpg", caption: "to delete" }, actor: { name: "Loren" } }, cookie);
  const id = created.json.asset.id;
  const del = await call("DELETE", `/api/assets/${id}`, { actor: { name: "Loren" }, reason: "cleanup" }, cookie);
  const patchAfterDelete = await call("PATCH", `/api/assets/${id}`, { revision: 1, changes: { caption: "should fail" }, actor: { name: "Loren" } }, cookie);
  console.log(JSON.stringify({ created: created.status, deleted: { status: del.status, ok: del.json?.ok }, patchAfterDelete: { status: patchAfterDelete.status } }));
} else if (scenario === "legacy-planner-put-still-works") {
  // Row storage is opt-in per route; the legacy whole-document endpoints
  // must keep working untouched even while PLANNER_ROW_STORAGE_ENABLED=true,
  // since activation (Task 9) hasn't happened yet.
  const planner = await call("GET", "/api/planner", undefined, cookie);
  const put = await call("PUT", "/api/planner", { version: planner.json.version, posts: planner.json.posts, scratch: planner.json.scratch, settings: planner.json.settings, actor: { name: "Loren" }, reason: "test" }, cookie);
  console.log(JSON.stringify({ status: put.status }));
} else if (scenario === "settings-save-does-not-block-asset-edit") {
  const created = await call("POST", "/api/planner/assets", { asset: { image: "/f.jpg", caption: "settings test asset" }, actor: { name: "Loren" } }, cookie);
  const asset = created.json.asset;
  const settingsPatch = await call("PATCH", "/api/settings", { revision: 1, changes: { syncPhotoCount: 20 }, actor: { name: "Loren" } }, cookie);
  const assetPatch = await call("PATCH", `/api/assets/${asset.id}`, { revision: asset.revision, changes: { caption: "edited during settings save" }, actor: { name: "Brooke" } }, cookie);
  console.log(JSON.stringify({
    settings: { status: settingsPatch.status, syncPhotoCount: settingsPatch.json?.settings?.syncPhotoCount },
    asset: { status: assetPatch.status, caption: assetPatch.json?.asset?.caption }
  }));
} else if (scenario === "settings-stale-conflict") {
  // The table is empty at the start of this scenario, so the very first
  // write has no prior revision to be stale against — it always succeeds
  // and establishes revision 1. Only the second write can be genuinely
  // stale relative to a third one that also submits revision 1.
  await call("PATCH", "/api/settings", { revision: 1, changes: { syncPhotoCount: 10 }, actor: { name: "Loren" } }, cookie);
  const first = await call("PATCH", "/api/settings", { revision: 1, changes: { syncPhotoCount: 15 }, actor: { name: "Loren" } }, cookie);
  const stale = await call("PATCH", "/api/settings", { revision: 1, changes: { syncPhotoCount: 30 }, actor: { name: "Brooke" } }, cookie);
  console.log(JSON.stringify({ first: { status: first.status }, stale: { status: stale.status, code: stale.json?.code } }));
} else if (scenario === "idea-create-patch-delete") {
  const created = await call("POST", "/api/ideas", { idea: { title: "idea one", body: "body text" }, actor: { name: "Loren" } }, cookie);
  const id = created.json?.idea?.id;
  const patched = await call("PATCH", `/api/ideas/${id}`, { revision: created.json.idea.revision, changes: { title: "idea one updated" }, actor: { name: "Loren" } }, cookie);
  const del = await call("DELETE", `/api/ideas/${id}`, { actor: { name: "Loren" } }, cookie);
  const patchAfterDelete = await call("PATCH", `/api/ideas/${id}`, { revision: 1, changes: { title: "should fail" }, actor: { name: "Loren" } }, cookie);
  console.log(JSON.stringify({
    created: { status: created.status, title: created.json?.idea?.title },
    patched: { status: patched.status, title: patched.json?.idea?.title },
    deleted: { status: del.status, ok: del.json?.ok },
    patchAfterDelete: { status: patchAfterDelete.status }
  }));
} else if (scenario === "idea-stale-conflict") {
  const created = await call("POST", "/api/ideas", { idea: { title: "original" }, actor: { name: "Loren" } }, cookie);
  const id = created.json.idea.id;
  const baseRevision = created.json.idea.revision;
  const first = await call("PATCH", `/api/ideas/${id}`, { revision: baseRevision, changes: { title: "first writer" }, actor: { name: "Loren" } }, cookie);
  const stale = await call("PATCH", `/api/ideas/${id}`, { revision: baseRevision, changes: { title: "stale writer" }, actor: { name: "Brooke" } }, cookie);
  console.log(JSON.stringify({ first: { status: first.status }, stale: { status: stale.status, code: stale.json?.code } }));
} else if (scenario === "gate-requires-verified-migration") {
  // The schema exists (ensureSchema runs lazily on first repository use)
  // but no planner_migrations row with parity_result='ok' has been seeded.
  // The flags alone must not be enough to serve row storage.
  const changes = await call("GET", "/api/planner/changes?since=0", undefined, cookie);
  const created = await call("POST", "/api/planner/assets", { asset: { image: "/x.jpg", caption: "x" }, actor: { name: "Loren" } }, cookie);
  console.log(JSON.stringify({ changesStatus: changes.status, createStatus: created.status }));
} else if (scenario === "put-planner-rejected-once-writes-enabled") {
  // Sign in as a freshly-created Admin rather than trusting "Loren"'s
  // role, which is mutable local test/dev state shared across runs.
  const adminName = `Activation Test Admin ${Date.now()}`;
  await call("POST", "/api/team/members", { name: adminName, role: "Admin", password: "testpassword123" }, cookie);
  const adminLogin = await call("POST", "/auth/login", { login: adminName, password: "testpassword123" });
  const adminCookie = adminLogin.cookie;

  const planner = await call("GET", "/api/planner", undefined, cookie);
  const put = await call("PUT", "/api/planner", { version: planner.json.version, posts: planner.json.posts, scratch: planner.json.scratch, settings: planner.json.settings, actor: { name: "Loren" }, reason: "test" }, cookie);
  const adminImport = await call("PUT", "/api/planner", { version: planner.json.version, posts: planner.json.posts, scratch: planner.json.scratch, settings: planner.json.settings, actor: { name: adminName }, reason: "test", adminImport: true }, adminCookie);
  console.log(JSON.stringify({ ordinaryPut: put.status, adminImportPut: adminImport.status }));
}

server.close();
process.exit(0);
