import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function taskHelpers() {
  const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const helpers = source.slice(0, source.indexOf("function renderGrid()"));
  const context = {
    console,
    crypto: { randomUUID: () => "test-id" },
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    window: { matchMedia: () => ({ matches: false }) },
    URL,
    Date
  };
  vm.runInNewContext(`${helpers}\nthis.taskHelpers = { taskPosts, filterActivity };`, context);
  return context.taskHelpers;
}

const posts = [
  { id: "brooke", status: "planned", workflow: "needs-review", assignee: "Brooke", dueDate: "2099-01-01" },
  { id: "david", status: "planned", workflow: "ready-meta", assignee: "David", dueDate: "2099-01-02" },
  { id: "unassigned", status: "planned", workflow: "needs-review", dueDate: "2099-01-03" },
  { id: "published", status: "posted", workflow: "published", assignee: "Brooke", dueDate: "2099-01-04" }
];

test("My Tasks returns only actionable posts assigned to the logged-in user", () => {
  const { taskPosts } = taskHelpers();
  assert.deepEqual(taskPosts(posts, { name: "Brooke" }, "mine").map(post => post.id), ["brooke"]);
});

test("Team Tasks returns every actionable post, including unassigned work", () => {
  const { taskPosts } = taskHelpers();
  assert.deepEqual(taskPosts(posts, { name: "Brooke" }, "team").map(post => post.id), ["brooke", "unassigned", "david"]);
});

test("sorts tasks by most recent activity when requested", () => {
  const { taskPosts } = taskHelpers();
  const source = posts.map((post, index) => ({ ...post, updatedAt: `2026-09-0${index + 1}T10:00:00.000Z` }));
  assert.deepEqual(taskPosts(source, { name: "Brooke" }, "team", "activity").map(post => post.id), ["unassigned", "david", "brooke"]);
});

test("filters activity by event type while keeping newest activity first", () => {
  const { filterActivity } = taskHelpers();
  const source = [
    { type: "approval", text: "Brooke approved a post", at: "2026-09-03T10:00:00.000Z" },
    { type: "content", text: "David uploaded a reel", at: "2026-09-04T10:00:00.000Z" },
    { type: "approval", text: "Loren requested review", at: "2026-09-05T10:00:00.000Z" }
  ];
  assert.deepEqual(filterActivity(source, "approval").map(item => item.text), ["Loren requested review", "Brooke approved a post"]);
});
