export const AUTOMATION_WORKFLOWS = [
  "idea", "drafting", "needs-assets", "needs-caption", "needs-review", "feedback",
  "approved", "ready-meta", "meta-scheduled", "published", "archived"
];

export function normalizeWorkflowAutomations(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(AUTOMATION_WORKFLOWS.map(workflow => [
    workflow,
    String(source[workflow] || "").trim().slice(0, 80)
  ]));
}

export function applyWorkflowAutomations(planner, automations) {
  const rules = normalizeWorkflowAutomations(automations);
  let changed = 0;
  for (const post of Array.isArray(planner?.posts) ? planner.posts : []) {
    const assignee = rules[post.workflow];
    if (!assignee || post.status === "posted" || post.workflow === "published" || post.workflow === "archived") continue;
    if (post.assignee === assignee) continue;
    post.assignee = assignee;
    changed++;
  }
  return changed;
}
