import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_HAZE, DEFAULT_LIGHT_SWITCHES } from "./emergency-lights.js";
import {
  normalizeSavedLightPreview,
  normalizeSavedMaterials,
  normalizeSavedSteering,
  normalizeTextureMode,
  normalizeVariantList,
} from "./workspace-state.js";

const MODEL = "D:\\cars\\police4_hi.yft";

test("only known viewer modes restore", () => {
  for (const mode of ["livery", "everything", "eup", "multi", "sirens"]) assert.equal(normalizeTextureMode(mode), mode);
  for (const bad of ["Livery", "all", "", null, undefined, 3, {}]) assert.equal(normalizeTextureMode(bad), "");
});

test("the wheel angle restores only for the model it was set on", () => {
  assert.deepEqual(normalizeSavedSteering({ path: MODEL, angle: -22.5 }, MODEL), { path: MODEL, angle: -22.5 });
  assert.deepEqual(normalizeSavedSteering({ path: MODEL, angle: 400 }, MODEL), { path: MODEL, angle: 90 });
  assert.equal(normalizeSavedSteering({ path: "D:\\other_hi.yft", angle: 10 }, MODEL), null);
  assert.equal(normalizeSavedSteering({ path: MODEL, angle: "10" }, MODEL), null);
  assert.equal(normalizeSavedSteering({ path: MODEL, angle: Number.NaN }, MODEL), null);
  assert.equal(normalizeSavedSteering(null, MODEL), null);
  assert.equal(normalizeSavedSteering({ path: "", angle: 5 }, ""), null);
});

test("Lights panel choices restore with defaults for missing or bad fields", () => {
  assert.equal(normalizeSavedLightPreview(undefined), null, "older snapshots keep the tab's defaults");
  const saved = normalizeSavedLightPreview({
    switches: { sirens: true, headlights: "full", indicators: "sideways" },
    muted: [3, 1, 1, -2, 1.5, "4", 300],
    speed: 0.5,
    spill: false,
    spillStrength: 9,
    glow: "bright",
    haze: 0.2,
    setting: { id: 1 },
  });
  assert.deepEqual(saved.switches, { ...DEFAULT_LIGHT_SWITCHES, sirens: true, headlights: "full" });
  assert.deepEqual(saved.muted, [1, 3]);
  assert.equal(saved.speed, 0.5);
  assert.equal(saved.spill, false);
  assert.equal(saved.spillStrength, 3);
  assert.equal(saved.glow, 1);
  assert.equal(saved.haze, 0.2);
  assert.equal("setting" in saved, false, "the siren setting is reread from the model's files");
  assert.equal(saved.lens, null);
  const empty = normalizeSavedLightPreview({});
  assert.equal(empty.speed, 1);
  assert.equal(empty.spill, true);
  assert.equal(empty.haze, DEFAULT_HAZE);
});

test("Materials panel restores its surface, sliders and texture maps", () => {
  assert.equal(normalizeSavedMaterials(null), null);
  const saved = normalizeSavedMaterials({
    type: "chrome",
    lightIntensity: 2.5,
    glossiness: 1.4,
    roughness: -1,
    clearcoat: 0.25,
    textures: [
      { id: "t1", name: "flakes.png", path: "D:\\maps\\flakes.png", thumbnail: "data:..." },
      { path: "D:\\maps\\grime.dds" },
      { name: "no path" },
      null,
      ...Array.from({ length: 8 }, (_, i) => ({ path: `D:\\maps\\${i}.png` })),
    ],
  });
  assert.equal(saved.type, "chrome");
  assert.equal(saved.lightIntensity, 2.5);
  assert.equal(saved.glossiness, 1);
  assert.equal(saved.roughness, 0);
  assert.equal(saved.clearcoat, 0.25);
  assert.equal(saved.textures.length, 6);
  assert.deepEqual(saved.textures[0], { id: "t1", name: "flakes.png", path: "D:\\maps\\flakes.png", thumbnail: null });
  assert.equal(saved.textures[1].name, "grime.dds");
  assert.ok(saved.textures[1].id);
  const defaults = normalizeSavedMaterials({ type: "velvet" });
  assert.deepEqual(defaults, { type: "paint", lightIntensity: 1, glossiness: 0.5, roughness: 0.3, clearcoat: 0, textures: [] });
});

test("variant lists are reshaped, with one base and unique ids", () => {
  let next = 0;
  const makeId = () => `gen${(next += 1)}`;
  assert.deepEqual(normalizeVariantList(undefined, makeId), [
    { id: "gen1", name: "Base", isBase: true, toggleable: {}, variantSelections: {}, locked: true },
  ]);
  assert.equal(normalizeVariantList("garbage", makeId).length, 1);

  const list = normalizeVariantList([
    null,
    { id: "a", name: "Day", toggleable: { Roof: true, Bad: "yes" }, variantSelections: { Lights: 2, Odd: -1 }, layerVisibility: { l1: false, l2: 3 } },
    { id: "a", name: "  ", isBase: true, toggleable: [1, 2] },
    { name: "Night", isBase: true, locked: true },
    7,
  ], makeId);
  assert.equal(list.length, 3);
  assert.deepEqual(new Set(list.map((variant) => variant.id)).size, 3);
  assert.equal(list[0].id, "a");
  assert.deepEqual(list[0].toggleable, { Roof: true });
  assert.deepEqual(list[0].variantSelections, { Lights: 2 });
  assert.deepEqual(list[0].layerVisibility, { l1: false });
  assert.equal(list[1].name, "Variant 2");
  assert.deepEqual(list[1].toggleable, {});
  assert.deepEqual(list.map((variant) => variant.isBase), [false, true, false], "the first entry marked base stays the only base");

  const noBase = normalizeVariantList([{ id: "x", name: "Only" }, { id: "y", name: "Other" }], makeId);
  assert.deepEqual(noBase.map((variant) => variant.isBase), [true, false]);
  assert.equal("layerVisibility" in noBase[0], false);
});

test("preview lens colours restore with their model and drop bad entries", () => {
  const saved = normalizeSavedLightPreview({
    lens: { path: MODEL, tints: { 1: "#FF0000", 2: "siren", 0: "#00ff00", 33: "#00ff00", 3: "red", 4: "#12345", x: "siren" } },
  });
  assert.deepEqual(saved.lens, { path: MODEL, tints: { 1: "#ff0000", 2: "siren" } });
  assert.equal(normalizeSavedLightPreview({ lens: { path: "", tints: { 1: "siren" } } }).lens, null, "tints need the model they belong to");
  assert.equal(normalizeSavedLightPreview({ lens: { path: MODEL, tints: { 9: "blue" } } }).lens, null);
  assert.equal(normalizeSavedLightPreview({ lens: [] }).lens, null);
});
