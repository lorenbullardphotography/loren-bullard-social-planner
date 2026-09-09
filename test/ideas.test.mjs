import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function ideaHelpers() {
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
  vm.runInNewContext(`${helpers}\nthis.ideaHelpers = { scratchIdeaPayload };`, context);
  return context.ideaHelpers;
}

test("persists goal, hook, and CTA with a Scratch Book idea", () => {
  const { scratchIdeaPayload } = ideaHelpers();
  assert.deepEqual(JSON.parse(JSON.stringify(scratchIdeaPayload({
    title: "Session prep",
    body: "Share a behind-the-scenes story",
    image: "https://example.com/reference.jpg",
    tags: "family, story",
    goal: "Build trust",
    hook: "What happens before the session starts",
    cta: "Save this for your next session"
  }))), {
    title: "Session prep",
    body: "Share a behind-the-scenes story",
    image: "https://example.com/reference.jpg",
    tags: ["family", "story"],
    goal: "Build trust",
    hook: "What happens before the session starts",
    cta: "Save this for your next session"
  });
});
