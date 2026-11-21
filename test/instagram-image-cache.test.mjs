import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setupIsolatedDataDir } from "./fixtures/isolated-data-dir.mjs";

setupIsolatedDataDir();
process.env.INSTAGRAM_ACCESS_TOKEN = "test-token";
const { handleRequest } = await import("../server.mjs");

function mock({ method = "GET", url = "/", headers = {}, body = null }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost:8787", ...headers };
  const res = {
    statusCode: 200, headers: {}, body: Buffer.alloc(0),
    writeHead(status, h = {}) { this.statusCode = status; this.headers = { ...this.headers, ...h }; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(chunk = "") { this.body = Buffer.concat([this.body, Buffer.from(chunk)]); }
  };
  process.nextTick(() => {
    if (body !== null) req.emit("data", typeof body === "string" ? body : JSON.stringify(body));
    req.emit("end");
  });
  return { req, res };
}

async function signedInCookie() {
  const login = mock({ method: "POST", url: "/auth/login", body: { login: "Loren", password: "admin" } });
  await handleRequest(login.req, login.res);
  return login.res.headers["set-cookie"]?.split(";")[0] || "";
}

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, ...rest) => handler(String(url), ...rest);
  return () => { globalThis.fetch = original; };
}

test("a proxied Instagram image is cached by the browser for a day", async () => {
  const cookie = await signedInCookie();
  const restore = stubFetch(url => url.includes("graph.instagram.com")
    ? new Response(JSON.stringify({ media_type: "IMAGE", media_url: "https://cdn.example/photo.jpg" }), { status: 200 })
    : new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } }));
  try {
    const { req, res } = mock({ url: "/api/instagram/image/12345", headers: { cookie } });
    await handleRequest(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["Cache-Control"], "private, max-age=86400, stale-while-revalidate=604800");
  } finally { restore(); }
});

test("a failed Instagram image request is never cached", async () => {
  const cookie = await signedInCookie();
  const restore = stubFetch(url => url.includes("graph.instagram.com")
    ? new Response(JSON.stringify({ media_type: "IMAGE", media_url: "https://cdn.example/photo.jpg" }), { status: 200 })
    : new Response("nope", { status: 500 }));
  try {
    const { req, res } = mock({ url: "/api/instagram/image/12345", headers: { cookie } });
    await handleRequest(req, res);
    assert.equal(res.statusCode, 502);
    assert.equal(res.headers["Cache-Control"], "no-store");
  } finally { restore(); }
});
