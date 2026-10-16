import assert from "node:assert/strict";
import test from "node:test";
import { findUlcConfig, normalizeUlcConfig, parseLuaTable } from "./ulc-config.js";
import { planExtras } from "./vehicle-extras.js";

const ULC = `-- a pack's ULC config
return {names = {"PackCarA","PackCarB"},
  steadyBurnConfig = {
    forceOn = false, useTime = false,
    disableWithLights = false,
    sbExtras = {}
  },
  parkConfig = {
    usePark = true,
    useSync = true,
    syncWith = {"PackCarA"},
    pExtras = {2},
    dExtras = {1,3}
  },
  brakeConfig = { useBrakes = true, speedThreshold = 5, brakeExtras = {4}, disableExtras = {} },
  reverseConfig = { useReverse = false, reverseExtras = {}, disableExtras = {} },
  buttons = {
    {label = "Cruise  Bar", key = 4, color = "red", extra = 5, linkedExtras = {}, oppositeExtras = {6}, offExtras = {}, repair = true},
    {label = "Cruise  Full", key = 1, color = "red", extra = 6, linkedExtras = {}, oppositeExtras = {}, offExtras = {}, repair = true},
    {label = "Scene", key = 2, color = "green", extra = 8, linkedExtras = {9}, oppositeExtras = {}, offExtras = {}, repair = true},
  },
  stages = { useStages = false, stageKeys = {}, },
}`;

test("Lua tables parse as data, with comments and both field styles", () => {
  assert.deepEqual(parseLuaTable("return { 1, 2, 'three', true, nil }"), [1, 2, "three", true, null]);
  assert.deepEqual(parseLuaTable("{ a = 1, ['b c'] = { x = -2.5 }; [3] = false }"), { a: 1, "b c": { x: -2.5 }, 3: false });
  assert.deepEqual(parseLuaTable("--[[ block ]] return { -- line\n a = [[long]] }"), { a: "long" });
  assert.throws(() => parseLuaTable("return { a = os.exit() }"), /unsupported expression "os"/);
  assert.throws(() => parseLuaTable("return { a = 1 } print('x')"), /unexpected text/);
  assert.throws(() => parseLuaTable("return { a = 'open }"), /unterminated string|expected/);
});

test("a ULC config matches models by name, case-insensitively", () => {
  const config = findUlcConfig(ULC, "packcarb");
  assert.ok(config);
  assert.deepEqual(config.park, { enabled: true, parkExtras: [2], driveExtras: [1, 3] });
  assert.deepEqual(config.brake.extras, [4]);
  assert.equal(config.buttons.length, 3);
  assert.equal(config.buttons[0].label, "Cruise Bar");
  assert.deepEqual(config.buttons[2].linked, [9]);
  assert.equal(findUlcConfig(ULC, "someothercar"), null);
  // A file returning a list of configs.
  assert.ok(findUlcConfig(`return { { names = {"x"} }, { names = {"y"}, parkConfig = { usePark = true } } }`, "y")?.park.enabled);
});

const available = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const ulc = findUlcConfig(ULC, "PackCarA");

test("the vehicle spawns with no extras on", () => {
  assert.deepEqual(planExtras({ available, ulc, switches: {} }).on, []);
  assert.deepEqual(planExtras({ available, switches: {} }).on, []);
});

test("ULC drive and park patterns follow the sirens and motion", () => {
  const driving = planExtras({ available, ulc, switches: { sirens: true }, state: { motion: "drive" } });
  assert.deepEqual(driving.on, [1, 3]);
  assert.equal(driving.reasons[1], "Drive pattern");
  const parked = planExtras({ available, ulc, switches: { sirens: true }, state: { motion: "park" } });
  assert.deepEqual(parked.on, [2]);
  assert.equal(parked.reasons[2], "Park pattern");
});

test("brakes, buttons, linked and opposite extras apply as ULC does", () => {
  const plan = planExtras({ available, ulc, switches: { sirens: true, brakes: true }, state: { buttons: [6, 5, 8] } });
  // Cruise Bar (5) turns its opposite (6) off; Scene (8) brings linked 9.
  assert.deepEqual(plan.on, [1, 3, 4, 5, 8, 9]);
  assert.equal(plan.reasons[4], "Brakes");
  assert.equal(plan.reasons[9], "Scene");
  // Reverse is disabled in this config.
  assert.deepEqual(planExtras({ available, ulc, switches: { reverse: true } }).on, []);
});

test("manual toggles override the plan", () => {
  const plan = planExtras({ available, ulc, switches: { sirens: true }, state: { overrides: { 1: false, 12: true } } });
  assert.deepEqual(plan.on, [3, 12]);
  assert.equal(plan.reasons[12], "Manual");
  // Both manual decisions are reported, on and off, so the viewer can tell
  // a hand toggle (animated) from a vehicle-state switch (instant).
  assert.deepEqual(plan.manual, [1, 12]);
  assert.deepEqual(planExtras({ available, ulc, switches: { sirens: true } }).manual, []);
});

test("without ULC, extras carrying siren geometry follow the sirens", () => {
  const lightExtras = { 1: { sirens: [1, 2], steady: false }, 5: { sirens: [], steady: true } };
  assert.deepEqual(planExtras({ available, lightExtras, switches: { sirens: true } }).on, [1]);
  assert.deepEqual(planExtras({ available, lightExtras, switches: { sirens: false } }).on, []);
});

test("normalisation tolerates missing sections", () => {
  const config = normalizeUlcConfig({ names: ["A"] });
  assert.deepEqual(config.park, { enabled: false, parkExtras: [], driveExtras: [] });
  assert.deepEqual(config.buttons, []);
});
