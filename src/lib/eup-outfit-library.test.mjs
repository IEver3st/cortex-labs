import test from "node:test";
import assert from "node:assert/strict";

import { MAX_OUTFIT_PRESETS, normalizeOutfitPresets, resolveOutfitSelections, selectionsWithPaths } from "./eup.js";
import {
  OUTFIT_LIBRARY_KEY,
  mergeOutfitPresets,
  readOutfitLibrary,
  workspaceOutfits,
  writeOutfitLibrary,
} from "./eup-outfit-library.js";

function memoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  };
}

const outfit = (id, name, extra = {}) => ({ id, name, selections: {}, baseOverrides: {}, pieces: [], ...extra });

test("merging keeps each outfit once and renames a clashing name instead of dropping it", () => {
  const merged = mergeOutfitPresets(
    { male: [outfit("outfit-1", "Patrol"), outfit("outfit-2", "Duty")] },
    { male: [outfit("outfit-1", "Patrol"), outfit("outfit-3", "patrol")], female: [outfit("outfit-4", "Patrol")] },
  );
  assert.deepEqual(merged.male.map((item) => [item.id, item.name]), [
    ["outfit-1", "Patrol"],
    ["outfit-2", "Duty"],
    ["outfit-3", "patrol (2)"],
  ]);
  assert.deepEqual(merged.female.map((item) => item.name), ["Patrol"]);
});

test("merging stops at the per-ped limit", () => {
  const many = Array.from({ length: MAX_OUTFIT_PRESETS + 5 }, (_, i) => outfit(`outfit-${i}`, `Look ${i}`));
  assert.equal(mergeOutfitPresets({ male: many }).male.length, MAX_OUTFIT_PRESETS);
});

test("the first read gathers outfits saved in earlier EUP workspaces and stores them once", () => {
  const workspaces = {
    later: { page: "eupstudio", createdAt: 20, state: { outfits: { male: [], female: [outfit("outfit-b", "Ranger")] } } },
    earlier: { page: "eupstudio", createdAt: 10, state: { outfits: { male: [outfit("outfit-a", "Police Test")], female: [] } } },
    viewer: { page: "viewer", createdAt: 5, state: { outfits: { male: [outfit("outfit-x", "Not EUP")] } } },
    empty: { page: "eupstudio", createdAt: 30, state: {} },
  };
  assert.equal(workspaceOutfits(workspaces).length, 2);
  const storage = memoryStorage();
  const first = readOutfitLibrary(storage, workspaces);
  assert.equal(first.migrated, true);
  assert.deepEqual(first.outfits.male.map((item) => item.name), ["Police Test"]);
  assert.deepEqual(first.outfits.female.map((item) => item.name), ["Ranger"]);
  assert.ok(storage.store.has(OUTFIT_LIBRARY_KEY));

  // Later reads use the library; deleting an outfit does not bring it back.
  writeOutfitLibrary({ male: [], female: first.outfits.female }, storage);
  const second = readOutfitLibrary(storage, workspaces);
  assert.equal(second.migrated, false);
  assert.equal(second.outfits.male.length, 0);
});

test("a damaged library is copied aside and reported", () => {
  const storage = memoryStorage({ [OUTFIT_LIBRARY_KEY]: "{not json" });
  const result = readOutfitLibrary(storage, {});
  assert.match(result.error, /could not be read/);
  assert.equal(storage.store.get(`${OUTFIT_LIBRARY_KEY}.damaged`), "{not json");
  assert.deepEqual(result.outfits, { male: [], female: [] });
});

test("a failed save reports the error", () => {
  const storage = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } };
  assert.deepEqual(writeOutfitLibrary({ male: [] }, storage), { ok: false, error: "QuotaExceededError" });
  const read = readOutfitLibrary(storage, {});
  assert.equal(read.error, "QuotaExceededError");
});

test("saved outfits keep pack file paths and piece files", () => {
  const [saved] = normalizeOutfitPresets({
    male: [outfit("outfit-1", "Vest", {
      selections: { task: { index: 0, variant: "b", path: "C:\\Packs\\vests\\task_000_u.ydd" } },
      piecePaths: ["C:\\Pieces\\badge.ydd", "not-a-model.txt", 7],
    })],
  }).male;
  assert.deepEqual(saved.selections.task, { index: 0, variant: "b", path: "C:\\Packs\\vests\\task_000_u.ydd" });
  assert.deepEqual(saved.piecePaths, ["C:\\Pieces\\badge.ydd"]);
});

test("pack selections are saved with their file and found by it later", () => {
  const packA = { components: { task: { drawables: { 0: { drawablePath: "C:\\Packs\\vests\\task_000_u.ydd" } } } } };
  const withPaths = selectionsWithPaths({ task: { index: 0, variant: "a" }, jbib: { index: 4, variant: "a" } }, packA);
  assert.equal(withPaths.task.path, "C:\\Packs\\vests\\task_000_u.ydd");
  assert.equal(withPaths.jbib.path, undefined);

  // Another session lists the same file at a different index.
  const packB = { components: { task: { drawables: { 0: { drawablePath: "C:/Packs/other/task_000_u.ydd" }, 3: { drawablePath: "c:/packs/vests/TASK_000_U.ydd" } } } } };
  assert.deepEqual(resolveOutfitSelections(withPaths, packB), {
    selections: { task: { index: 3, variant: "a" }, jbib: { index: 4, variant: "a" } },
    missing: [],
  });

  // Without the pack the selection is left out, not put on another file.
  const result = resolveOutfitSelections(withPaths, { components: {} });
  assert.deepEqual(result.selections, { jbib: { index: 4, variant: "a" } });
  assert.deepEqual(result.missing, [{ component: "task", path: "C:\\Packs\\vests\\task_000_u.ydd" }]);
});
