import assert from "node:assert/strict";
import test from "node:test";
import {
  applySavedVehicleToState,
  captureSavedVehicle,
  defaultSavedVehicleName,
  findSavedVehicleByName,
  findSavedVehicleWorkspace,
  loadSavedVehicles,
  MAX_SAVED_VEHICLES,
  moveSavedVehicleModel,
  normalizeSavedVehicles,
  partitionSavedVehicles,
  relinkSavedVehicle,
  removeSavedVehicle,
  restoreSavedVehicle,
  SAVED_VEHICLES_KEY,
  savedVehicleLinkStatus,
  savedVehicleWorkspaceState,
  upsertSavedVehicle,
} from "./saved-vehicles.js";

const MODEL = "D:\\Resources\\lspd\\stream\\police4_hi.yft";

function capture(overrides = {}) {
  return captureSavedVehicle({
    id: "veh-a",
    name: "LSPD slicktop",
    now: 1000,
    mode: "sirens",
    modelPath: MODEL,
    vehiclePaint: { primary: { index: 111 } },
    vehicleMods: { path: MODEL, kitName: "police4_modkit", mods: { vmt_spoiler: 2, VMT_ROOF: 0 } },
    livery: 3,
    extras: { motion: "park", overrides: { 1: true, 2: false, x: true } },
    plate: { style: 4, text: "lspd 01" },
    texturePath: "D:\\liveries\\lspd.psd",
    ...overrides,
  });
}

test("default name drops the extension and _hi suffix", () => {
  assert.equal(defaultSavedVehicleName(MODEL), "police4");
  assert.equal(defaultSavedVehicleName("C:/cars/fbi2.clmesh"), "fbi2");
});

test("capture keeps mods, paint, extras and plate, and normalizes them", () => {
  const entry = capture();
  assert.equal(entry.mode, "sirens");
  assert.deepEqual(entry.mods, { kitName: "police4_modkit", mods: { VMT_SPOILER: 2, VMT_ROOF: 0 } });
  assert.equal(entry.paint.primary.index, 111);
  assert.equal(entry.extras.motion, "park");
  assert.deepEqual(entry.extras.overrides, { 1: true, 2: false });
  assert.equal(entry.plate.style, 4);
  assert.equal(entry.plate.text, "LSPD 01");
  // Sirens has no livery slot, so a stray texture path is not kept.
  assert.equal(entry.texturePath, "");
});

test("the game livery is kept where mods are, and only as a livery number", () => {
  assert.equal(capture().livery, 3);
  assert.deepEqual(savedVehicleWorkspaceState(capture()).gameLivery, { path: MODEL, number: 3 });
  assert.equal(capture({ mode: "livery" }).livery, null);
  assert.equal(capture({ livery: "3" }).livery, null);
  assert.equal(capture({ livery: -1 }).livery, null);
  assert.equal("gameLivery" in savedVehicleWorkspaceState(capture({ livery: null })), false);
});

test("capture drops a mod selection that belongs to another model", () => {
  const entry = capture({ vehicleMods: { path: "D:\\other\\fbi_hi.yft", kitName: "x", mods: { VMT_ROOF: 1 } } });
  assert.equal(entry.mods, null);
});

test("livery mode keeps textures but never mods", () => {
  const entry = capture({ mode: "livery", windowTexturePath: "D:\\liveries\\glass.png" });
  assert.equal(entry.mods, null);
  assert.equal(entry.texturePath, "D:\\liveries\\lspd.psd");
  assert.equal(entry.windowTexturePath, "D:\\liveries\\glass.png");
});

test("capture rejects entries that could not be reopened", () => {
  assert.equal(capture({ name: "   " }), null);
  assert.equal(capture({ modelPath: "" }), null);
  assert.equal(capture({ modelPath: "D:\\models\\car.obj" }), null);
});

test("workspace state reopens through the restore path with the mods bound to the model", () => {
  const state = savedVehicleWorkspaceState(capture());
  assert.equal(state.textureMode, "sirens");
  assert.equal(state.modelSourcePath, MODEL);
  assert.deepEqual(state.vehicleMods, { path: MODEL, kitName: "police4_modkit", mods: { VMT_SPOILER: 2, VMT_ROOF: 0 } });
  assert.deepEqual(state.savedVehicle, { id: "veh-a", name: "LSPD slicktop", path: MODEL });
  assert.equal(state.licensePlate.text, "LSPD 01");
  assert.equal("texturePath" in state, false);
});

test("upsert replaces by id or name and keeps the original id and createdAt", () => {
  let { store } = upsertSavedVehicle(null, capture());
  ({ store } = upsertSavedVehicle(store, capture({ id: "veh-b", name: "FBI", now: 2000 })));
  assert.deepEqual(store.vehicles.map((entry) => entry.name), ["FBI", "LSPD slicktop"]);

  const result = upsertSavedVehicle(store, capture({ id: "veh-new", name: "lspd SLICKTOP", now: 3000 }));
  assert.equal(result.entry.id, "veh-a");
  assert.equal(result.entry.createdAt, 1000);
  assert.equal(result.entry.savedAt, 3000);
  assert.equal(result.store.vehicles.length, 2);
  assert.equal(result.store.vehicles[0].id, "veh-a");
  assert.equal(findSavedVehicleByName(result.store, "fbi").id, "veh-b");
});

test("remove and relink touch only the chosen entry", () => {
  let { store } = upsertSavedVehicle(null, capture());
  ({ store } = upsertSavedVehicle(store, capture({ id: "veh-b", name: "FBI", now: 2000 })));
  const moved = relinkSavedVehicle(store, "veh-a", "E:\\moved\\police4_hi.yft", 5000);
  const relinked = moved.vehicles.find((entry) => entry.id === "veh-a");
  assert.equal(relinked.modelPath, "E:\\moved\\police4_hi.yft");
  assert.deepEqual(relinked.mods.mods, { VMT_SPOILER: 2, VMT_ROOF: 0 });
  assert.equal(relinkSavedVehicle(store, "veh-a", "E:\\nope.txt", 5000).vehicles.find((e) => e.id === "veh-a").modelPath, MODEL);
  assert.deepEqual(removeSavedVehicle(moved, "veh-a").vehicles.map((entry) => entry.id), ["veh-b"]);
});

test("a renamed model carries every entry on its old path", () => {
  let { store } = upsertSavedVehicle(null, capture());
  ({ store } = upsertSavedVehicle(store, capture({ id: "veh-b", name: "Same car, other build", now: 2000 })));
  ({ store } = upsertSavedVehicle(store, capture({ id: "veh-c", name: "Other", modelPath: "D:\\x\\fbi_hi.yft", now: 3000 })));
  const result = moveSavedVehicleModel(store, MODEL.toUpperCase(), "D:\\Resources\\lspd\\stream\\pd_charger_hi.yft", 4000);
  assert.equal(result.moved, 2);
  assert.deepEqual(
    result.store.vehicles.filter((e) => e.modelPath.endsWith("pd_charger_hi.yft")).map((e) => e.id).sort(),
    ["veh-a", "veh-b"],
  );
  assert.equal(moveSavedVehicleModel(store, "D:\\nothing.yft", "D:\\new_hi.yft", 4000).moved, 0);
});

test("normalize drops malformed and duplicate entries and caps the library", () => {
  const good = capture();
  const store = normalizeSavedVehicles({ vehicles: [good, { ...good }, null, 7, { id: "x", name: "No model" }] });
  assert.equal(store.vehicles.length, 1);
  assert.deepEqual(normalizeSavedVehicles("garbage").vehicles, []);
  const many = Array.from({ length: MAX_SAVED_VEHICLES + 5 }, (_, i) => capture({ id: `v${i}`, name: `Car ${i}`, now: i + 1 }));
  const capped = normalizeSavedVehicles({ vehicles: many });
  assert.equal(capped.vehicles.length, MAX_SAVED_VEHICLES);
  assert.equal(capped.vehicles[0].name, `Car ${MAX_SAVED_VEHICLES + 4}`);
});

test("Livery and All keep the hand-picked mesh targets and window overlay switch, Sirens does not", () => {
  const picks = {
    textureTarget: "material:livery_paint",
    windowTextureTarget: "mesh:windscreen_f",
    windowTemplateEnabled: true,
    liveryWindowOverride: "material:glass_tint",
  };
  const everything = capture({ mode: "everything", ...picks });
  assert.equal(everything.textureTarget, "material:livery_paint");
  assert.equal(everything.windowTextureTarget, "mesh:windscreen_f");
  assert.equal(everything.windowTemplateEnabled, true);
  assert.equal(everything.liveryWindowOverride, "material:glass_tint");
  const state = savedVehicleWorkspaceState(everything);
  assert.equal(state.textureTarget, "material:livery_paint");
  assert.equal(state.windowTextureTarget, "mesh:windscreen_f");
  assert.equal(state.windowTemplateEnabled, true);
  assert.equal(state.liveryWindowOverride, "material:glass_tint");

  const sirens = capture({ mode: "sirens", ...picks });
  assert.equal(sirens.textureTarget, "");
  assert.equal(sirens.windowTemplateEnabled, null);
  const sirenState = savedVehicleWorkspaceState(sirens);
  for (const key of Object.keys(picks)) assert.equal(key in sirenState, false, key);
});

test("entries saved before targets existed leave the workspace defaults alone", () => {
  const old = normalizeSavedVehicles({
    vehicles: [{ id: "old", name: "Old", modelPath: MODEL, mode: "livery", savedAt: 5, texturePath: "D:\\a.png" }],
  }).vehicles[0];
  assert.equal(old.windowTemplateEnabled, null);
  const state = savedVehicleWorkspaceState(old);
  assert.equal(state.texturePath, "D:\\a.png");
  for (const key of ["textureTarget", "windowTextureTarget", "liveryWindowOverride", "windowTemplateEnabled"]) {
    assert.equal(key in state, false, key);
  }
});

test("a full library refuses a new save instead of dropping the oldest, but still replaces", () => {
  const vehicles = Array.from({ length: MAX_SAVED_VEHICLES }, (_, i) => capture({ id: `v${i}`, name: `Car ${i}`, now: i + 1 }));
  const full = normalizeSavedVehicles({ vehicles });
  const refused = upsertSavedVehicle(full, capture({ id: "veh-new", name: "One more", now: 9999 }));
  assert.equal(refused.entry, null);
  assert.equal(refused.error, "full");
  assert.equal(refused.store.vehicles.length, MAX_SAVED_VEHICLES);
  assert.ok(refused.store.vehicles.some((entry) => entry.id === "v0"), "the oldest entry survives");

  const replaced = upsertSavedVehicle(full, capture({ id: "veh-new", name: "car 0", now: 9999 }));
  assert.equal(replaced.entry.id, "v0");
  assert.equal(replaced.store.vehicles.length, MAX_SAVED_VEHICLES);
  const updated = upsertSavedVehicle(full, capture({ id: "v7", name: "Car 7 renamed", now: 9999 }));
  assert.equal(updated.entry.id, "v7");
});

test("partition reports every raw entry normalization drops", () => {
  const good = capture();
  const duplicate = { ...good, name: "Same id" };
  const broken = { id: "x", name: "No model" };
  const { store, dropped } = partitionSavedVehicles({ vehicles: [good, duplicate, null, broken] });
  assert.equal(store.vehicles.length, 1);
  assert.deepEqual(dropped, [duplicate, broken]);

  const many = Array.from({ length: MAX_SAVED_VEHICLES + 2 }, (_, i) => capture({ id: `v${i}`, name: `Car ${i}`, now: i + 1 }));
  const capped = partitionSavedVehicles({ vehicles: many });
  assert.equal(capped.store.vehicles.length, MAX_SAVED_VEHICLES);
  assert.deepEqual(capped.dropped.map((entry) => entry.id).sort(), ["v0", "v1"]);
});

test("loading backs up dropped entries once, before a write can erase them", () => {
  const store = new Map();
  const previous = globalThis.localStorage;
  const warn = console.warn;
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  console.warn = () => {};
  try {
    const broken = { id: "x", name: "Broken", modelPath: "D:\\car.obj" };
    store.set(SAVED_VEHICLES_KEY, JSON.stringify({ version: 1, vehicles: [capture(), broken] }));
    assert.equal(loadSavedVehicles().vehicles.length, 1);
    loadSavedVehicles();
    assert.deepEqual(JSON.parse(store.get(`${SAVED_VEHICLES_KEY}.dropped`)), [broken]);
  } finally {
    globalThis.localStorage = previous;
    console.warn = warn;
  }
});

test("undo restores by id and renames instead of replacing a vehicle saved since", () => {
  let { store } = upsertSavedVehicle(null, capture());
  ({ store } = upsertSavedVehicle(store, capture({ id: "veh-b", name: "FBI", now: 2000 })));
  const deleted = store.vehicles.find((entry) => entry.id === "veh-a");
  store = removeSavedVehicle(store, "veh-a");

  const plain = restoreSavedVehicle(store, deleted);
  assert.equal(plain.entry.id, "veh-a");
  assert.equal(plain.entry.name, "LSPD slicktop");

  ({ store } = upsertSavedVehicle(store, capture({ id: "veh-c", name: "lspd slicktop", now: 3000 })));
  const clash = restoreSavedVehicle(store, deleted);
  assert.equal(clash.entry.id, "veh-a");
  assert.equal(clash.entry.name, "LSPD slicktop (restored)");
  assert.equal(clash.store.vehicles.find((entry) => entry.id === "veh-c").name, "lspd slicktop");
  assert.equal(clash.store.vehicles.length, 3);

  const second = restoreSavedVehicle(clash.store, { ...deleted, id: "veh-e" });
  assert.equal(second.entry.name, "LSPD slicktop (restored 2)");
  const present = restoreSavedVehicle(clash.store, deleted);
  assert.equal(present.store.vehicles.length, 3, "an entry still present is left alone");
});

test("a restored name stays within the name limit", () => {
  const long = "X".repeat(60);
  const { store } = upsertSavedVehicle(null, capture({ id: "a", name: long }));
  const result = restoreSavedVehicle(store, capture({ id: "b", name: long }));
  assert.ok(result.entry.name.length <= 60);
  assert.ok(result.entry.name.endsWith(" (restored)"));
});

test("undo reports a full library instead of dropping an entry", () => {
  const vehicles = Array.from({ length: MAX_SAVED_VEHICLES }, (_, i) => capture({ id: `v${i}`, name: `Car ${i}`, now: i + 1 }));
  const result = restoreSavedVehicle({ vehicles }, capture({ id: "gone", name: "Gone" }));
  assert.equal(result.entry, null);
  assert.equal(result.error, "full");
});

test("link status tells Update whether the entry still points at this tab's model", () => {
  const { store } = upsertSavedVehicle(null, capture());
  assert.equal(savedVehicleLinkStatus(store, "veh-a", MODEL), "linked");
  assert.equal(savedVehicleLinkStatus(store, "veh-a", MODEL.toUpperCase().replace(/\\/g, "/")), "linked");
  const relinked = relinkSavedVehicle(store, "veh-a", "E:\\moved\\police4_hi.yft", 5000);
  assert.equal(savedVehicleLinkStatus(relinked, "veh-a", MODEL), "moved");
  assert.equal(savedVehicleLinkStatus(removeSavedVehicle(store, "veh-a"), "veh-a", MODEL), "missing");
});

test("reopening over a linked project applies the saved setup and keeps the scene", () => {
  const entry = capture({ mode: "everything", texturePath: "", livery: null, plate: null });
  const project = {
    textureMode: "livery",
    modelPath: "D:\\old\\police4_hi.yft",
    texturePath: "D:\\unsaved.png",
    gameLivery: { path: MODEL, number: 2 },
    licensePlate: { style: 1, text: "DRAFT" },
    textureTarget: "material:x",
    stage: "showroom",
    lightAzimuth: 120,
  };
  const merged = applySavedVehicleToState(project, entry);
  assert.equal(merged.textureMode, "everything");
  assert.equal(merged.modelPath, MODEL);
  assert.equal(merged.stage, "showroom");
  assert.equal(merged.lightAzimuth, 120);
  for (const key of ["texturePath", "gameLivery", "licensePlate", "textureTarget"]) assert.equal(key in merged, false, key);
  assert.deepEqual(merged.savedVehicle, { id: "veh-a", name: "LSPD slicktop", path: MODEL });
  assert.equal(applySavedVehicleToState(project, { id: "x" }), null);
});

test("the project linked to a saved vehicle prefers an open tab, then the latest save", () => {
  const linked = (updatedAt) => ({ page: "viewer", updatedAt, state: { savedVehicle: { id: "veh-a", path: MODEL } } });
  const workspaces = {
    a: linked(100),
    b: linked(300),
    c: { page: "viewer", updatedAt: 999, state: { savedVehicle: { id: "veh-other" } } },
    d: { page: "variants", updatedAt: 999, state: { savedVehicle: { id: "veh-a" } } },
  };
  assert.equal(findSavedVehicleWorkspace(workspaces, "veh-a"), "b");
  assert.equal(findSavedVehicleWorkspace(workspaces, "veh-a", ["a"]), "a");
  assert.equal(findSavedVehicleWorkspace(workspaces, "veh-none"), null);
  assert.equal(findSavedVehicleWorkspace(null, "veh-a"), null);
});
