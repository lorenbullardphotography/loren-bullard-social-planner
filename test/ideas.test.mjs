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
  vm.runInNewContext(`${helpers}\nthis.ideaHelpers = { scratchIdeaPayload, normalizeActivityText };`, context);
  return context.ideaHelpers;
}

test("persists goal, hook, CTA, format, and pillar with an idea", () => {
  const { scratchIdeaPayload } = ideaHelpers();
  assert.deepEqual(JSON.parse(JSON.stringify(scratchIdeaPayload({
    title: "Session prep",
    format: "REEL",
    pillar: "Behind the scenes",
    body: "Share a behind-the-scenes story",
    image: "https://example.com/reference.jpg",
    tags: "family, story",
    goal: "Build trust",
    hook: "What happens before the session starts",
    cta: "Save this for your next session"
  }))), {
    title: "Session prep",
    format: "REEL",
    pillar: "Behind the scenes",
    body: "Share a behind-the-scenes story",
    image: "https://example.com/reference.jpg",
    tags: ["family", "story"],
    goal: "Build trust",
    hook: "What happens before the session starts",
    cta: "Save this for your next session"
  });
});

test("provides format and pillar fields in the idea composer and wide card layout", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(html, /id="scratchFormat"/);
  assert.match(html, /id="scratchPillar"/);
  assert.match(html, /class="scratch-composer-head"/);
  assert.match(css, /\.scratch-layout\{[^}]*grid-template-columns:minmax\(360px,440px\) minmax\(0,1fr\)/);
  assert.match(css, /\.scratch-list\{[^}]*grid-template-columns:repeat\(auto-fill,minmax\(340px,1fr\)\)/);
  assert.match(css, /\.scratch-badge-format/);
  assert.match(css, /\.scratch-badge-pillar/);
});

test("does not mention Scratch Book in client-facing copy or activity reasons", () => {
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /Scratch Book/i);
  assert.match(app, /persistPlanner\("archived an idea"\)/);
  assert.match(app, /persistPlanner\("deleted an idea"\)/);
  assert.match(app, /persistPlanner\(existing \? "updated an idea" : "added an idea"\)/);
});

test("sanitizes legacy Scratch Book activity text into natural idea descriptions", () => {
  const { normalizeActivityText } = ideaHelpers();
  assert.equal(normalizeActivityText("Loren updated a Scratch Book idea"), "Loren updated an idea");
  assert.equal(normalizeActivityText("Loren added a Scratch Book idea"), "Loren added an idea");
  assert.equal(normalizeActivityText("Loren archived a Scratch Book idea"), "Loren archived an idea");
  assert.equal(normalizeActivityText("Loren deleted a Scratch Book idea"), "Loren deleted an idea");
  assert.equal(normalizeActivityText("Loren updated a Idea idea"), "Loren updated an idea");
  assert.equal(normalizeActivityText("Loren added a idea"), "Loren added an idea");
});

