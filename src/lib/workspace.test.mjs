import test from "node:test";
import assert from "node:assert/strict";

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};

const {
  createWorkspace,
  deleteWorkspaces,
  getActiveWorkspaceId,
  listProjects,
  loadOpenTabs,
  loadRecent,
  loadWorkspaces,
  markWorkspaceOpened,
  planOpenTabs,
  saveOpenTabs,
  saveWorkspaces,
  setActiveWorkspaceId,
} = await import("./workspace.js");

function resetStorage() {
  store.clear();
}

test("listProjects orders by last open, not by last save", () => {
  const workspaces = {
    a: { id: "a", name: "EUP Studio", page: "eupstudio", updatedAt: 9_000 },
    b: { id: "b", name: "All Textures", page: "viewer", updatedAt: 1_000 },
  };
  const recent = [
    { workspaceId: "b", openedAt: 5_000 },
    { workspaceId: "a", openedAt: 4_000 },
  ];
  const projects = listProjects(workspaces, recent);
  assert.deepEqual(projects.map((p) => p.workspaceId), ["b", "a"]);
  assert.equal(projects[0].openedAt, 5_000);
});

test("listProjects keeps workspaces missing from recents, using their save time", () => {
  const workspaces = {
    a: { id: "a", name: "Livery", page: "viewer", updatedAt: 3_000 },
    old: { id: "old", name: "Old", page: "variants", updatedAt: 1_000 },
    nostamp: { name: "No stamp" },
  };
  const projects = listProjects(workspaces, [{ workspaceId: "a", openedAt: 2_000 }]);
  assert.deepEqual(projects.map((p) => p.workspaceId), ["a", "old", "nostamp"]);
  assert.equal(projects[1].page, "variants");
  assert.equal(projects[2].openedAt, 0);
});

test("listProjects ignores recents for deleted workspaces and malformed input", () => {
  assert.deepEqual(listProjects(null, null), []);
  const projects = listProjects(
    { a: { id: "a", name: "A", updatedAt: 1 } },
    [null, { workspaceId: 42 }, { workspaceId: "gone", openedAt: 99 }, { workspaceId: "a", openedAt: 7 }],
  );
  assert.deepEqual(projects, [{ workspaceId: "a", name: "A", page: "viewer", openedAt: 7 }]);
});

test("markWorkspaceOpened moves an already-open project to the front", async () => {
  resetStorage();
  const first = createWorkspace("Vehicle", "viewer", { textureMode: "vehicle" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = createWorkspace("EUP Studio", "eupstudio");
  assert.equal(loadRecent()[0].workspaceId, second);

  await new Promise((resolve) => setTimeout(resolve, 5));
  markWorkspaceOpened(first);
  const projects = listProjects(loadWorkspaces(), loadRecent());
  assert.equal(projects[0].workspaceId, first);
  assert.equal(projects[0].name, "Vehicle");
});

test("markWorkspaceOpened ignores unknown workspaces", () => {
  resetStorage();
  saveWorkspaces({});
  markWorkspaceOpened("missing");
  assert.deepEqual(loadRecent(), []);
});

test("deleteWorkspaces removes the chosen projects, their recents and the active id", () => {
  resetStorage();
  const keep = createWorkspace("Keep", "viewer");
  const a = createWorkspace("A", "viewer");
  const b = createWorkspace("B", "eupstudio");
  setActiveWorkspaceId(b);
  assert.equal(deleteWorkspaces([a, b, "missing", null]), true);
  assert.deepEqual(Object.keys(loadWorkspaces()), [keep]);
  assert.deepEqual(loadRecent().map((entry) => entry.workspaceId), [keep]);
  assert.equal(getActiveWorkspaceId(), null);
  assert.equal(deleteWorkspaces([]), true);
  assert.deepEqual(Object.keys(loadWorkspaces()), [keep]);
});

test("deleteWorkspaces keeps recents when the workspace map cannot be saved", () => {
  resetStorage();
  const a = createWorkspace("A", "viewer");
  const setItem = globalThis.localStorage.setItem;
  const consoleError = console.error;
  globalThis.localStorage.setItem = () => { throw new Error("quota"); };
  console.error = () => {};
  try {
    assert.equal(deleteWorkspaces([a]), false);
  } finally {
    globalThis.localStorage.setItem = setItem;
    console.error = consoleError;
  }
  assert.ok(loadWorkspaces()[a]);
  assert.deepEqual(loadRecent().map((entry) => entry.workspaceId), [a]);
});

test("open tabs round-trip in order, without duplicates or a stray active id", () => {
  resetStorage();
  assert.deepEqual(loadOpenTabs(), { ids: [], active: null });
  assert.equal(saveOpenTabs(["b", "a", "b", null, 3], "a"), true);
  assert.deepEqual(loadOpenTabs(), { ids: ["b", "a"], active: "a" });
  saveOpenTabs(["b"], "gone");
  assert.deepEqual(loadOpenTabs(), { ids: ["b"], active: null });
  store.set("cortex-studio:open-tabs.v1", "{not json");
  assert.deepEqual(loadOpenTabs(), { ids: [], active: null });
});

test("planOpenTabs reopens only workspaces that still exist", () => {
  const workspaces = {
    v: { id: "v", name: "Charger", page: "viewer", state: { textureMode: "sirens", modelPath: "D:\c_hi.yft" } },
    odd: { id: "odd", name: "", page: "viewer", state: { textureMode: "bogus" } },
    old: { id: "old", name: "All Textures", page: "viewer", state: { textureMode: "everything" } },
    e: { id: "e", name: "EUP Studio", page: "eupstudio", state: { pieces: [] } },
    w: { id: "w", name: "Weird", page: "unknown", state: "nope" },
  };
  const plan = planOpenTabs({ ids: ["e", "missing", "v", "odd", "w", "old"], active: "v" }, workspaces);
  assert.deepEqual(plan.tabs.map((tab) => tab.workspaceId), ["e", "v", "odd", "w", "old"]);
  assert.equal(plan.activeWorkspaceId, "v");
  assert.deepEqual(plan.tabs[1], { workspaceId: "v", type: "viewer", name: "Charger", defaultMode: "sirens", state: workspaces.v.state });
  assert.equal(plan.tabs[0].type, "eupstudio");
  assert.equal(plan.tabs[0].defaultMode, null);
  assert.equal(plan.tabs[2].name, "Untitled");
  assert.equal(plan.tabs[2].defaultMode, "vehicle");
  assert.equal(plan.tabs[3].type, "viewer");
  assert.equal(plan.tabs[3].state, null);
  // An All (or Livery) tab from before Vehicle mode reopens in it.
  assert.equal(plan.tabs[4].defaultMode, "vehicle");

  assert.equal(planOpenTabs({ ids: ["v"], active: "missing" }, workspaces).activeWorkspaceId, null);
  assert.deepEqual(planOpenTabs(null, null), { tabs: [], activeWorkspaceId: null });
});
