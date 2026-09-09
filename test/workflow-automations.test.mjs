import test from "node:test";
import assert from "node:assert/strict";
import { applyWorkflowAutomations, normalizeWorkflowAutomations } from "../lib/workflow-automations.mjs";

test("normalizes workflow automation assignments and drops unknown workflows", () => {
  const rules = normalizeWorkflowAutomations({ drafting: " Brooke ", unknown: "Loren", "needs-review": "" });
  assert.equal(rules.drafting, "Brooke");
  assert.equal(rules["needs-review"], "");
  assert.equal(rules.unknown, undefined);
});

test("reconciles existing matching posts while preserving published and archived posts", () => {
  const planner = {
    posts: [
      { id: "draft", workflow: "drafting", status: "draft", assignee: "Loren" },
      { id: "review", workflow: "needs-review", status: "planned", assignee: "" },
      { id: "published", workflow: "published", status: "posted", assignee: "Loren" },
      { id: "archived", workflow: "archived", status: "draft", assignee: "Loren" }
    ]
  };

  const changed = applyWorkflowAutomations(planner, { drafting: "Brooke", "needs-review": "Brooke" });

  assert.equal(changed, 2);
  assert.equal(planner.posts.find(post => post.id === "draft").assignee, "Brooke");
  assert.equal(planner.posts.find(post => post.id === "review").assignee, "Brooke");
  assert.equal(planner.posts.find(post => post.id === "published").assignee, "Loren");
  assert.equal(planner.posts.find(post => post.id === "archived").assignee, "Loren");
});
