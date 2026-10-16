import test from "node:test";
import assert from "node:assert/strict";

import { GTA_VEHICLE_COLORS, gameColorToHex, getVehicleColor, parseMetallicId } from "./data/gta-vehicle-colors.js";
import {
  PAINT_PALETTE_GROUPS,
  VEHICLE_PAINT_KEYS,
  buildVehiclePaint,
  customPaint,
  normalizeVehiclePaint,
  paintDisplayColor,
  paintFinishProfile,
  paintFromIndex,
  paintFromMetaColor,
  paintLabel,
} from "./vehicle-paint.js";

test("the palette is carcols.ymt: 161 colours, raw game values shown sRGB-encoded", () => {
  assert.equal(GTA_VEHICLE_COLORS.length, 161);
  assert.deepEqual(GTA_VEHICLE_COLORS.map((entry) => entry.index), [...Array(161).keys()]);
  const silver = getVehicleColor(4);
  assert.equal(silver.gameHex, "#5a5e66");
  assert.equal(silver.hex, "#a0a3aa");
  assert.equal(gameColorToHex("0xFF000000"), "#000000");
  assert.equal(gameColorToHex("0xFFFFFFFF"), "#ffffff");
  assert.equal(gameColorToHex("nope"), null);
  assert.equal(getVehicleColor(12).finish, 3, "Matte Black is matte");
  assert.equal(getVehicleColor(120).finish, 7, "Chrome is chrome");
  assert.equal(parseMetallicId("EVehicleModelColorMetallic_normal"), 0);
  assert.equal(parseMetallicId("EVehicleModelColorMetallic_9"), 9);
  assert.equal(parseMetallicId("EVehicleModelColorMetallic_12"), null);
  const grouped = PAINT_PALETTE_GROUPS.flatMap((group) => group.colors.map((entry) => entry.index));
  assert.equal(new Set(grouped).size, 161, "every colour appears in exactly one group");
});

test("a fresh vehicle paints its body in the base colour and the rest stock", () => {
  const paint = buildVehiclePaint("#112233");
  assert.deepEqual(Object.keys(paint), VEHICLE_PAINT_KEYS);
  assert.deepEqual(paint.primary, { index: null, color: "#112233", finish: 0 });
  assert.deepEqual(paint.secondary, paint.primary);
  assert.notEqual(paint.secondary, paint.primary, "slots do not share objects");
  assert.equal(paint.wheels.index, 156);
  assert.equal(paint.pearlescent.index, 0);
  assert.equal(buildVehiclePaint("not a colour").primary.color, "#e7ebf0");
});

test("saved paint restores, and the old hex-per-slot map migrates", () => {
  const legacy = normalizeVehiclePaint({
    primary: "#AA0000",
    secondary: "#00aa00",
    accent: "#0000aa",
    glass: "#ffffff",
    wheels: "#81827f",
  }, "#e7ebf0");
  assert.deepEqual(legacy.primary, { index: null, color: "#aa0000", finish: 0 });
  assert.equal(legacy.secondary.color, "#00aa00");
  assert.equal(legacy.wheels.index, 156, "the old Default Alloy hex becomes the palette colour");
  assert.equal(legacy.accent, undefined);
  assert.equal(legacy.glass, undefined);

  const saved = normalizeVehiclePaint({
    primary: { index: 27, color: "#000000", finish: 3 },
    secondary: { index: null, color: "#123456", finish: 7 },
    pearlescent: { index: 999 },
    interior: { color: "bad" },
  });
  assert.deepEqual(saved.primary, paintFromIndex(27), "a palette pick takes the palette colour and finish");
  assert.deepEqual(saved.secondary, { index: null, color: "#123456", finish: 7 });
  assert.equal(saved.pearlescent.index, 0, "an unknown index falls back to stock");
  assert.equal(saved.interior.index, 0);
  assert.deepEqual(normalizeVehiclePaint(null, "#010203").primary.color, "#010203");
});

test("chrome and labels", () => {
  assert.equal(paintDisplayColor(paintFromIndex(120)), "#c9ccd1", "palette chrome reads as a mirror");
  assert.equal(paintDisplayColor(customPaint("#ff0000", 7)), "#ff0000", "custom chrome keeps its tint");
  assert.equal(paintLabel(paintFromIndex(156)), "Default Alloy");
  assert.equal(paintLabel(customPaint("#ABCDEF")), "#abcdef");
  assert.equal(customPaint("#abcdef", 42).finish, 0);
});

test("finish profiles follow the carcols metallic settings", () => {
  const metallic = paintFinishProfile(0);
  const matte = paintFinishProfile(3);
  const chrome = paintFinishProfile(7);
  const brushed = paintFinishProfile(6);
  assert.ok(metallic.clearcoat > 0.5 && metallic.clearcoatRoughness < 0.1, "glossy paint gets a sharp clear coat");
  assert.equal(matte.clearcoat, 0);
  assert.ok(matte.roughness > 0.6, "matte is rough");
  assert.equal(chrome.metalness, 1);
  assert.ok(chrome.roughness < 0.1);
  assert.ok(brushed.metalness > 0.8 && brushed.roughness > chrome.roughness);
  assert.deepEqual(paintFinishProfile(99), metallic, "unknown finishes use the default");
});

test("meta colour presets become palette picks, or custom colours when carcols redefines them", () => {
  assert.deepEqual(paintFromMetaColor({ index: 111, hex: getVehicleColor(111).hex, finish: 2, known: true }), paintFromIndex(111));
  assert.deepEqual(
    paintFromMetaColor({ index: 1, hex: "#4b7d9d", finish: 0, known: true }),
    { index: null, color: "#4b7d9d", finish: 0 },
  );
  assert.equal(paintFromMetaColor({ index: 400, hex: "#aaaaaa", known: false }), null);
  assert.equal(paintFromMetaColor(undefined), null);
});
