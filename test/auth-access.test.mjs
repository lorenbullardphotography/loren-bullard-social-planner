import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const loginHtml = fs.readFileSync(new URL("../public/login.html", import.meta.url), "utf8");
const loginJs = fs.readFileSync(new URL("../public/login.js", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../server.mjs", import.meta.url), "utf8");

test("login page does not expose public account creation", () => {
  assert.doesNotMatch(loginHtml, /Create account/i);
  assert.doesNotMatch(loginJs, /auth\/register/);
});

test("server rejects the public registration route", () => {
  assert.match(server, /url\.pathname === ["']\/auth\/register["']/);
  assert.match(server, /Account creation is disabled/);
});
