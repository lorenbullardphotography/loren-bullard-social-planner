// Standalone helper spawned as a fresh child process by
// planner-migration.test.mjs's end-to-end test. Two things force this out
// of the normal same-process test pattern:
//
// 1. lib/store.mjs reads DATABASE_URL into a module-level constant the
//    first time it's imported, so a later dynamic re-import of server.mjs
//    under a cache-busting query string still resolves its internal
//    `./lib/store.mjs` import to the already-cached instance from this
//    test file's very first `import { handleRequest } from "../server.mjs"`
//    — the env var change would silently have no effect in-process.
// 2. This repo's other tests fake req/res with a bare EventEmitter and
//    schedule the request body's 'data'/'end' events via process.nextTick.
//    That race is invisible against the local file store (no real async
//    I/O happens before readBody() attaches its listeners), but real
//    Postgres I/O is slow enough that the scheduled events fire — and are
//    silently dropped, since nothing is listening yet — before readBody()
//    ever attaches. Driving this over a real HTTP server + fetch() sidesteps
//    that fragility entirely (a real socket doesn't lose bytes waiting for
//    a listener) and is arguably more faithful to production anyway.
import http from "node:http";
import { handleRequest } from "../../server.mjs";

const server = http.createServer(handleRequest);
await new Promise(resolve => server.listen(0, resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

async function post(path, body, cookie) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body)
  });
  const cookieHeader = response.headers.get("set-cookie")?.split(";")[0] || "";
  const text = await response.text();
  return { status: response.status, cookie: cookieHeader, text };
}

const bootstrap = await post("/auth/login", { login: "Loren", password: "admin" });

const name = `Migration Test Admin ${Date.now()}`;
await post("/api/team/members", { name, role: "Admin", password: "testpassword123" }, bootstrap.cookie);

const login = await post("/auth/login", { login: name, password: "testpassword123" });
const migration = await post("/api/admin/planner-row-migration", { mode: "shadow" }, login.cookie);

process.stdout.write(JSON.stringify({ statusCode: migration.status, body: migration.text }));
server.close();
process.exit(0);
