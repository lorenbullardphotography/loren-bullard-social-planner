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
  vm.runInNewContext(`${helpers}\nthis.taskHelpers = { taskPosts, approvalSections, filterActivity, activityLabel, assigneePeople, personInitials, activityFilterStorageKey, loadActivityFilters };`, context);
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

test("groups approval posts by workflow without stacking them", () => {
  const { approvalSections } = taskHelpers();
  const sections = approvalSections(posts);
  const section = sections.find(item => item.key === "needs-review");
  assert.equal(section.label, "Needs Review");
  assert.deepEqual(section.posts.map(post => post.id), ["brooke", "unassigned"]);
  assert.equal(section.count, 2);
  assert.equal(section.remaining, 1);
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

test("filters activity by multiple checked event types", () => {
  const { filterActivity } = taskHelpers();
  const source = [
    { type: "approval", text: "Approval", at: "2026-09-03T10:00:00.000Z" },
    { type: "content", text: "Content", at: "2026-09-04T10:00:00.000Z" },
    { type: "sync", text: "Sync", at: "2026-09-05T10:00:00.000Z" }
  ];
  assert.deepEqual(filterActivity(source, ["approval", "sync"]).map(item => item.text), ["Sync", "Approval"]);
});

test("provides a readable label for each activity type", () => {
  const { activityLabel } = taskHelpers();
  assert.equal(activityLabel("approval"), "Approval");
  assert.equal(activityLabel("sync"), "Sync");
});

test("builds a unique assignee list from the team and current user", () => {
  const { assigneePeople } = taskHelpers();
  assert.deepEqual([...assigneePeople({ name: "Brooke", role: "Manager" }, [{ name: "David", role: "Photographer" }, { name: "Brooke", role: "Manager" }], "Loren")].map(person => person.name), ["Brooke", "David", "Loren"]);
});

test("creates compact profile initials for assignee avatars", () => {
  const { personInitials } = taskHelpers();
  assert.equal(personInitials("Brooke Smith"), "BS");
  assert.equal(personInitials("David"), "D");
});

test("keeps the open assignee menu floating above the editor fields", () => {
  const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.assignee-picker\.open \.assignee-picker-menu\{position:fixed/);
});

test("places Tasks before Grid Planner in the sidebar", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const nav = html.slice(html.indexOf("<nav>"), html.indexOf("</nav>"));
  assert.ok(nav.indexOf('data-view="tasks"') < nav.indexOf('data-view="grid"'));
  assert.ok(nav.indexOf('data-view="tasks"') < nav.indexOf('data-view="calendar"'));
});

test("stores Activity filters under a user-specific preference key", () => {
  const { activityFilterStorageKey } = taskHelpers();
  assert.equal(activityFilterStorageKey({ name: "Brooke" }), "lb-activity-filters-v1-brooke");
  assert.notEqual(activityFilterStorageKey({ name: "Brooke" }), activityFilterStorageKey({ name: "David" }));
});

test("restores saved Activity filters and defaults to all types", () => {
  const { loadActivityFilters } = taskHelpers();
  const storage = { getItem: key => key === "lb-activity-filters-v1-brooke" ? '["approval","sync"]' : null };
  assert.deepEqual([...loadActivityFilters({ name: "Brooke" }, storage)], ["approval", "sync"]);
  assert.equal(loadActivityFilters({ name: "David" }, storage).length, 6);
});
