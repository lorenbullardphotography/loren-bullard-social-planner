import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setupIsolatedDataDir } from "./fixtures/isolated-data-dir.mjs";

setupIsolatedDataDir();
const { handleRequest, isPlannerUploadPathname, allowedUploadContentType, remainingUploadBytes } = await import("../server.mjs");

test("isPlannerUploadPathname accepts only paths under planner/", () => {
  assert.equal(isPlannerUploadPathname("planner/abc.jpg"), true);
  assert.equal(isPlannerUploadPathname("other/abc.jpg"), false);
  assert.equal(isPlannerUploadPathname(""), false);
  assert.equal(isPlannerUploadPathname(undefined), false);
});

test("allowedUploadContentType accepts only image/video mime types, lowercased", () => {
  assert.equal(allowedUploadContentType("image/jpeg"), "image/jpeg");
  assert.equal(allowedUploadContentType("video/mp4"), "video/mp4");
  assert.equal(allowedUploadContentType("IMAGE/JPEG"), "image/jpeg");
  assert.equal(allowedUploadContentType("application/json"), null);
  assert.equal(allowedUploadContentType(""), null);
  assert.equal(allowedUploadContentType(undefined), null);
});

test("remainingUploadBytes computes the gap between usage and limit, never negative", () => {
  assert.equal(remainingUploadBytes({ usedBytes: 100, limitBytes: 500 }), 400);
  assert.equal(remainingUploadBytes({ usedBytes: 600, limitBytes: 500 }), 0);
  assert.equal(remainingUploadBytes({}), 0);
});

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

test("POST /api/assets/upload-token requires authentication", async () => {
  const { req, res } = createMockReqRes({ method: "POST", url: "/api/assets/upload-token", body: {} });
  await handleRequest(req, res);
  assert.equal(res.statusCode, 401);
});

test("POST /api/assets/upload-token reports 503 when Vercel Blob is not configured", async () => {
  const { cookie } = await signIn();
  const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    const { req, res } = createMockReqRes({
      method: "POST",
      url: "/api/assets/upload-token",
      headers: { cookie },
      body: {}
    });
    await handleRequest(req, res);
    assert.equal(res.statusCode, 503);
    const data = JSON.parse(res.body);
    assert.match(data.error, /BLOB_READ_WRITE_TOKEN/);
  } finally {
    if (previousToken !== undefined) process.env.BLOB_READ_WRITE_TOKEN = previousToken;
  }
});
