import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const slice = (from, to) => source.slice(source.indexOf(from), source.indexOf(to));

function renderContext(currentView) {
  const calls = [];
  const names = ["syncTopActions", "renderStats", "renderTasks", "renderGrid", "renderInspector", "renderCalendar", "renderLibrary", "renderScratch", "renderApprovals", "renderTeam", "renderActivity", "renderPlannerSettings"];
  const context = vm.createContext({ currentView, $: () => ({ innerHTML: "x" }) });
  for (const name of names) context[name] = () => calls.push(name);
  vm.runInContext(slice("const VIEW_RENDERERS", "function assetPreview"), context);
  return { context, calls };
}

test("renderAll renders media-heavy views only for the current view", () => {
  for (const [view, expected] of [["grid", ["renderGrid"]], ["calendar", ["renderCalendar"]], ["library", ["renderLibrary", "renderScratch"]], ["tasks", ["renderTasks", "renderApprovals"]], ["settings", ["renderPlannerSettings"]], ["activity", []]]) {
    const { context, calls } = renderContext(view);
    context.renderAll();
    const heavy = calls.filter(name => ["renderGrid", "renderCalendar", "renderLibrary", "renderScratch", "renderTasks", "renderApprovals", "renderPlannerSettings"].includes(name));
    assert.deepEqual(heavy, expected, view);
  }
});

test("renderAll still refreshes the light panels that carry no media on every view", () => {
  const { context, calls } = renderContext("calendar");
  context.renderAll();
  for (const name of ["renderStats", "renderTeam", "renderActivity"]) assert.ok(calls.includes(name), name);
  // renderPlannerSettings fetches storage usage, Canva status and team members,
  // so it must not run on every change from other views.
  assert.equal(calls.includes("renderPlannerSettings"), false);
});

test("renderViewContent renders the settings panel only for the settings view", () => {
  const { context, calls } = renderContext("grid");
  context.renderViewContent("settings");
  assert.deepEqual(calls, ["renderPlannerSettings"]);
});

test("renderViewContent renders exactly the named view, and nothing for views without media", () => {
  const { context, calls } = renderContext("grid");
  context.renderViewContent("calendar");
  assert.deepEqual(calls, ["renderCalendar"]);
  calls.length = 0;
  context.renderViewContent("editor");
  context.renderViewContent("activity");
  assert.deepEqual(calls, []);
});

test("reconcileTileNodes keeps existing nodes for unchanged items and rebuilds only changed ones", () => {
  const context = vm.createContext({});
  vm.runInContext(slice("function reconcileTileNodes", "function createGridTile"), context);
  let created = 0;
  const options = { signatureOf: item => item.v, create: item => ({ id: item.id, made: ++created }) };
  const cache = new Map();
  const first = context.reconcileTileNodes(cache, [{ id: "a", v: 1 }, { id: "b", v: 1 }, { id: "c", v: 1 }], options);
  assert.equal(created, 3);
  const second = context.reconcileTileNodes(cache, [{ id: "a", v: 1 }, { id: "b", v: 2 }, { id: "c", v: 1 }], options);
  assert.equal(created, 4);
  assert.equal(second[0], first[0]);
  assert.notEqual(second[1], first[1]);
  assert.equal(second[2], first[2]);
});

test("reconcileTileNodes follows the new order and evicts removed items", () => {
  const context = vm.createContext({});
  vm.runInContext(slice("function reconcileTileNodes", "function createGridTile"), context);
  const options = { signatureOf: item => item.v, create: item => ({ id: item.id }) };
  const cache = new Map();
  const [a, b] = context.reconcileTileNodes(cache, [{ id: "a", v: 1 }, { id: "b", v: 1 }], options);
  const reordered = context.reconcileTileNodes(cache, [{ id: "b", v: 1 }], options);
  assert.equal(reordered.length, 1);
  assert.equal(reordered[0], b);
  assert.equal(cache.has("a"), false);
  assert.notEqual(a, undefined);
});

test("reconcileTileNodes rebuilds a cached node that reports itself stale (e.g. showing the broken-image placeholder)", () => {
  const context = vm.createContext({});
  vm.runInContext(slice("function reconcileTileNodes", "function createGridTile"), context);
  let created = 0;
  const options = { signatureOf: item => item.v, create: item => ({ id: item.id, made: ++created, broken: false }), isStale: node => node.broken };
  const cache = new Map();
  const [first] = context.reconcileTileNodes(cache, [{ id: "a", v: 1 }], options);
  first.broken = true;
  const [second] = context.reconcileTileNodes(cache, [{ id: "a", v: 1 }], options);
  assert.notEqual(second, first);
  assert.equal(created, 2);
  const [third] = context.reconcileTileNodes(cache, [{ id: "a", v: 1 }], options);
  assert.equal(third, second);
});
