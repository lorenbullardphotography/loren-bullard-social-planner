import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { setupIsolatedDataDir } from "./fixtures/isolated-data-dir.mjs";

setupIsolatedDataDir();
const { handleRequest } = await import("../server.mjs");

const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const appJs = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

test("settings view includes team management card and member modal", () => {
  assert.match(html, /class="settings-card team-settings"/);
  assert.match(html, /id="addTeamMemberBtn"/);
  assert.match(html, /id="teamMemberList"/);
  assert.match(html, /id="teamMemberModal"/);
  assert.match(html, /id="teamMemberName"/);
  assert.match(html, /id="teamMemberRole"/);
  assert.match(html, /id="teamMemberPassword"/);
  assert.match(html, /id="saveTeamMemberBtn"/);
});

test("styles.css styles team settings across grid columns and responsive layouts", () => {
  assert.match(css, /\.team-settings\{grid-column:1 \/ -1\}/);
  assert.match(css, /\.team-member-list\{display:grid;/);
  assert.match(css, /\.team-member-card\{/);
  assert.match(css, /\.team-member-badge\{/);
});

test("app.js implements team member loading, rendering, and modal actions", () => {
  assert.match(appJs, /async function loadTeamMembers\(\)/);
  assert.match(appJs, /function renderTeamSettings\(\)/);
  assert.match(appJs, /function openTeamMemberModal\(/);
  assert.match(appJs, /\/api\/team\/members/);
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

test("team member API workflow: list, add, edit, password reset, and remove", async () => {
  // 1. Sign in as Loren
  const login = createMockReqRes({
    method: "POST",
    url: "/auth/login",
    body: { login: "Loren", password: "admin" }
  });
  await handleRequest(login.req, login.res);
  assert.equal(login.res.statusCode, 200);
  const cookie = login.res.headers["set-cookie"]?.split(";")[0] || "";
  assert.ok(cookie.startsWith("planner_session="));

  const authHeaders = { cookie };

  // 2. GET /api/team/members returns member list without exposing passwordHash
  const listReq = createMockReqRes({
    method: "GET",
    url: "/api/team/members",
    headers: authHeaders
  });
  await handleRequest(listReq.req, listReq.res);
  assert.equal(listReq.res.statusCode, 200);
  const listData = JSON.parse(listReq.res.body);
  assert.ok(Array.isArray(listData.members));
  assert.ok(listData.members.length >= 2);
  for (const m of listData.members) {
    assert.equal(m.passwordHash, undefined);
    assert.ok(m.id && m.name && m.role);
  }

  const uniqueSuffix = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const memberName = `Team Workflow Test Admin ${uniqueSuffix}`;
  const renamedMemberName = `Team Workflow Test Editor ${uniqueSuffix}`;

  // 3. POST /api/team/members creates a new member
  const addReq = createMockReqRes({
    method: "POST",
    url: "/api/team/members",
    headers: authHeaders,
    body: { name: memberName, role: "Admin", password: "supersecret123" }
  });
  await handleRequest(addReq.req, addReq.res);
  assert.equal(addReq.res.statusCode, 201);
  const addData = JSON.parse(addReq.res.body);
  assert.ok(addData.ok);
  assert.equal(addData.member.name, memberName);
  assert.equal(addData.member.role, "Admin");
  assert.equal(addData.member.passwordHash, undefined);
  const davidId = addData.member.id;

  // 4. Test login with newly created member
  const newLogin = createMockReqRes({
    method: "POST",
    url: "/auth/login",
    body: { login: memberName, password: "supersecret123" }
  });
  await handleRequest(newLogin.req, newLogin.res);
  assert.equal(newLogin.res.statusCode, 200);

  // 5. Reject short passwords and duplicate names
  const dupReq = createMockReqRes({
    method: "POST",
    url: "/api/team/members",
    headers: authHeaders,
    body: { name: memberName.toLowerCase(), role: "Editor", password: "password123" }
  });
  await handleRequest(dupReq.req, dupReq.res);
  assert.equal(dupReq.res.statusCode, 409);

  const shortPassReq = createMockReqRes({
    method: "POST",
    url: "/api/team/members",
    headers: authHeaders,
    body: { name: "New User", role: "Editor", password: "short" }
  });
  await handleRequest(shortPassReq.req, shortPassReq.res);
  assert.equal(shortPassReq.res.statusCode, 400);

  // 6. PUT /api/team/members/:id updates role and resets password
  const editReq = createMockReqRes({
    method: "PUT",
    url: `/api/team/members/${davidId}`,
    headers: authHeaders,
    body: { name: renamedMemberName, role: "Editor", password: "newpassword456" }
  });
  await handleRequest(editReq.req, editReq.res);
  assert.equal(editReq.res.statusCode, 200);
  const editData = JSON.parse(editReq.res.body);
  assert.equal(editData.member.name, renamedMemberName);
  assert.equal(editData.member.role, "Editor");

  // 7. Verify new password works
  const resetLogin = createMockReqRes({
    method: "POST",
    url: "/auth/login",
    body: { login: renamedMemberName, password: "newpassword456" }
  });
  await handleRequest(resetLogin.req, resetLogin.res);
  assert.equal(resetLogin.res.statusCode, 200);

  // 8. Reject self deletion
  const selfDelReq = createMockReqRes({
    method: "DELETE",
    url: `/api/team/members/${listData.members.find(m => m.name.toLowerCase() === "loren").id}`,
    headers: authHeaders
  });
  await handleRequest(selfDelReq.req, selfDelReq.res);
  assert.equal(selfDelReq.res.statusCode, 400);

  // 9. DELETE /api/team/members/:id successfully removes David
  const delReq = createMockReqRes({
    method: "DELETE",
    url: `/api/team/members/${davidId}`,
    headers: authHeaders
  });
  await handleRequest(delReq.req, delReq.res);
  assert.equal(delReq.res.statusCode, 200);

  // 10. Confirm David can no longer sign in
  const deletedLogin = createMockReqRes({
    method: "POST",
    url: "/auth/login",
    body: { login: renamedMemberName, password: "newpassword456" }
  });
  await handleRequest(deletedLogin.req, deletedLogin.res);
  assert.equal(deletedLogin.res.statusCode, 401);
});
