import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { handleRequest } from "../server.mjs";

function createMockReqRes({ method = "GET", url = "/", headers = {}, body = null }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost:8787", ...headers };

  const res = {
    statusCode: 200,
    headers: {},
    body: "",
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = { ...this.headers, ...headers };
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk = "") {
      this.body += chunk;
    }
  };

  process.nextTick(() => {
    if (body !== null) {
      req.emit("data", typeof body === "string" ? body : JSON.stringify(body));
    }
    req.emit("end");
  });

  return { req, res };
}

async function signIn() {
  const login = createMockReqRes({
    method: "POST",
    url: "/auth/login",
    body: { login: "Loren", password: "admin" }
  });
  await handleRequest(login.req, login.res);
  const cookie = login.res.headers["set-cookie"]?.split(";")[0] || "";
  return { cookie };
}

test("GET /api/health/storage requires authentication", async () => {
  const { req, res } = createMockReqRes({ method: "GET", url: "/api/health/storage" });
  await handleRequest(req, res);
  assert.equal(res.statusCode, 401);
});

test("GET /api/health/storage reports plannerStorage and rowSchemaReady without secrets or migration/instagram data", async () => {
  const { cookie } = await signIn();
  const { req, res } = createMockReqRes({
    method: "GET",
    url: "/api/health/storage",
    headers: { cookie }
  });
  await handleRequest(req, res);

  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);

  assert.ok("plannerStorage" in data);
  assert.ok("rowSchemaReady" in data);
  assert.equal(typeof data.rowSchemaReady, "boolean");

  // No direct Postgres is configured in this test environment, so the row
  // schema cannot be ready and the repository must not attempt a real
  // network call or throw.
  assert.equal(data.rowSchemaReady, false);

  const keys = Object.keys(data);
  assert.deepEqual(keys.sort(), ["plannerStorage", "rowSchemaReady"]);

  const serialized = res.body.toLowerCase();
  for (const forbidden of ["password", "secret", "token", "instagram", "migration", "canva"]) {
    assert.ok(!serialized.includes(forbidden), `response leaked forbidden term: ${forbidden}`);
  }
});
