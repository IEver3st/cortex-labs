import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  beatsPerSecond,
  classifyLightMesh,
  emissionStrength,
  evaluateLights,
  evaluateSirens,
  lightsAnimate,
  normalizeLightSwitches,
  sequencerBit,
  sequencerOn,
  sequencerPattern,
} from "./emergency-lights.js";
import { loadResourceMeta, parseCarcolsMeta, simulateVehicle } from "./vehicle-meta.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "meta");
const policeCarcols = () => readFileSync(path.join(FIXTURES, "police", "carcols.meta"), "utf8");

test("sequencer reads the most significant bit first", () => {
  assert.equal(sequencerPattern(2863311530), "10".repeat(16));
  assert.equal(sequencerPattern(1431655765), "01".repeat(16));
  assert.equal(sequencerBit(0x80000000, 0), true);
  assert.equal(sequencerBit(0x80000000, 1), false);
  assert.equal(sequencerBit(0x00000001, 31), true);
  // Steps wrap every 32 beats, including negative beats.
  assert.equal(sequencerBit(0x80000000, 32), true);
  assert.equal(sequencerBit(0x00000001, -1), true);
});

test("sequencer tolerates missing and out-of-range values", () => {
  assert.equal(sequencerBit(null, 0), false);
  assert.equal(sequencerBit(Number.NaN, 0), false);
  assert.equal(sequencerOn(0xffffffff, 1, Number.NaN), false);
});

test("multiples split an on-beat into equal flashes", () => {
  assert.equal(sequencerOn(0xffffffff, 1, 0.9), true);
  assert.equal(sequencerOn(0xffffffff, 2, 0.1), true);
  assert.equal(sequencerOn(0xffffffff, 2, 0.3), false);
  assert.equal(sequencerOn(0xffffffff, 2, 0.6), true);
  assert.equal(sequencerOn(0xffffffff, 2, 0.8), false);
  // An off-beat stays dark regardless of multiples.
  assert.equal(sequencerOn(0x7fffffff, 3, 0.1), false);
});

test("beat rate is sequencerBpm x timeMultiplier per minute", () => {
  assert.equal(beatsPerSecond({ sequencerBpm: 600, timeMultiplier: 1 }), 10);
  assert.equal(beatsPerSecond({ sequencerBpm: 600, timeMultiplier: 0.5 }), 5);
  assert.equal(beatsPerSecond({ sequencerBpm: 600 }), 10);
  assert.equal(beatsPerSecond({}), 0);
});

test("carcols sirens parse with channels, colours and lamp sequencers", () => {
  const { sirens } = parseCarcolsMeta(policeCarcols(), "carcols.meta");
  const setting = sirens[0];
  assert.equal(setting.sequencerBpm, 600);
  assert.equal(setting.sirens.length, 2);
  const [first, second] = setting.sirens;
  assert.equal(first.flashiness.sequencer, 2863311530);
  assert.equal(first.rotation.speed, 2);
  assert.equal(first.flash, true);
  assert.equal(first.rotate, false);
  // 0xFF0000FF is ARGB: opaque blue. 0xFFFF0000 is opaque red.
  assert.equal(first.color, "#0000ff");
  assert.equal(first.alpha, 1);
  assert.equal(second.color, "#ff0000");
  assert.equal(first.corona.size, 0.2);
  assert.equal(setting.lamps.leftHeadLight.sequencer, 0);
  assert.equal(setting.lamps.leftHeadLight.multiples, 1);
});

test("the police setting alternates its two sirens every 100 ms", () => {
  const setting = parseCarcolsMeta(policeCarcols()).sirens[0];
  const at = (time) => evaluateSirens(setting, time).map((state) => state.on);
  assert.deepEqual(at(0.05), [true, false]);
  assert.deepEqual(at(0.15), [false, true]);
  assert.deepEqual(at(3.25), [true, false]); // 32 beats later the cycle repeats
});

test("rotators spin and gate on their rotation sequencer", () => {
  const setting = {
    sequencerBpm: 600,
    sirens: [{
      rotate: true,
      flash: false,
      rotation: { delta: 0, start: 0, speed: 0, sequencer: 0xffffffff, multiples: 1, direction: true, syncToBpm: true },
      flashiness: {},
    }],
  };
  const early = evaluateSirens(setting, 0)[0];
  const later = evaluateSirens(setting, 0.25)[0];
  assert.equal(early.on, true);
  assert.ok(later.spin > early.spin);
  const reversed = evaluateSirens({ ...setting, sirens: [{ ...setting.sirens[0], rotation: { ...setting.sirens[0].rotation, direction: false } }] }, 0.25)[0];
  assert.ok(reversed.spin < 0);
});

test("non-rotating sirens aim at flashiness delta", () => {
  const setting = {
    sequencerBpm: 600,
    sirens: [{ flash: true, flashiness: { delta: Math.PI, sequencer: 0xffffffff }, rotation: { delta: 1 } }],
  };
  assert.equal(evaluateSirens(setting, 0)[0].yaw, Math.PI);
});

test("light meshes classify by bone first, then vertex light id", () => {
  const lit = "vehicle_lightsemissive";
  assert.deepEqual(classifyLightMesh({ lightBone: "siren7", shaderName: lit }), { kind: "siren", siren: 7, lit: true });
  // A rotator mirror turns with the bone but does not glow.
  assert.deepEqual(classifyLightMesh({ lightBone: "siren15", shaderName: "vehicle_mesh" }), { kind: "siren", siren: 15, lit: false });
  assert.equal(classifyLightMesh({ lightBone: "siren33", shaderName: lit }), null);
  assert.equal(classifyLightMesh({ lightBone: "siren_glass1", shaderName: lit }), null);
  assert.deepEqual(classifyLightMesh({ lightBone: "brakelight_l", shaderName: lit }), { kind: "lamp", name: "brakelight_l", lamp: "brakelight" });
  // The vertex light id wins over the bone, as in game.
  assert.deepEqual(classifyLightMesh({ lightBone: "brakelight_l", lightId: 3, shaderName: lit }), { kind: "lamp", name: "taillight_l", lamp: "taillight" });
  // Id 0 off a siren bone is the default light (running lights), even on a headlight bone.
  assert.deepEqual(classifyLightMesh({ lightBone: "headlight_l", lightId: 0, shaderName: lit }), { kind: "lamp", name: "defaultlight", lamp: "always" });
  // Lamp lenses share the bone but use glass shaders.
  assert.equal(classifyLightMesh({ lightBone: "headlight_l", shaderName: "vehicle_vehglass" }), null);
  assert.deepEqual(classifyLightMesh({ lightId: 5, shaderName: "vehicle_lightsemissive" }), { kind: "lamp", name: "indicator_lf", lamp: "indicator" });
  assert.deepEqual(classifyLightMesh({ lightId: 0, shaderName: "vehicle_lightsemissive" }), { kind: "lamp", name: "defaultlight", lamp: "always" });
  assert.equal(classifyLightMesh({ lightId: 5, shaderName: "vehicle_paint1" }), null);
  assert.equal(classifyLightMesh({ lightId: 99, shaderName: "vehicle_lightsemissive" }), null);
});

test("switches drive lamps, and lamp sequencers take over while sirens run", () => {
  const lampNames = ["headlight_l", "taillight_l", "brakelight_l", "indicator_lf", "indicator_rf", "reversinglight_l"];
  const off = evaluateLights(null, {}, 0, lampNames);
  assert.ok(Object.values(off.lamps).every((lamp) => !lamp.on));

  const driving = evaluateLights(null, { headlights: "on", brakes: true, indicators: "left" }, 0.1, lampNames);
  assert.equal(driving.lamps.headlight_l.on, true);
  assert.equal(driving.lamps.taillight_l.on, true);
  assert.equal(driving.lamps.brakelight_l.on, true);
  assert.equal(driving.lamps.indicator_lf.on, true);
  assert.equal(driving.lamps.indicator_rf.on, false);
  assert.equal(driving.lamps.reversinglight_l.on, false);
  // Indicators blink.
  assert.equal(evaluateLights(null, { indicators: "left" }, 0.5, lampNames).lamps.indicator_lf.on, false);

  const wigwag = { sequencerBpm: 600, lamps: { leftHeadLight: { sequencer: 0x80000000, multiples: 1 } }, sirens: [] };
  assert.equal(evaluateLights(wigwag, { sirens: true }, 0.05, lampNames).lamps.headlight_l.on, true);
  assert.equal(evaluateLights(wigwag, { sirens: true }, 0.15, lampNames).lamps.headlight_l.on, false);
  // Sirens off: the lamp sequencer is ignored.
  assert.equal(evaluateLights(wigwag, { sirens: false }, 0.05, lampNames).lamps.headlight_l.on, false);
});

test("the default light burns whenever the vehicle runs, and lit lamps carry their game energy", () => {
  const names = ["defaultlight", "headlight_l", "taillight_l"];
  const parked = evaluateLights(null, { night: true }, 0, names);
  assert.equal(parked.lamps.defaultlight.on, false);
  assert.equal(parked.lamps.defaultlight.energy, 0);
  for (const switches of [{ headlights: "on" }, { sirens: true }, { brakes: true }, { indicators: "hazard" }]) {
    assert.equal(evaluateLights(null, switches, 0, names).lamps.defaultlight.on, true, JSON.stringify(switches));
  }
  const lit = evaluateLights(null, { headlights: "on" }, 0, names).lamps;
  assert.ok(lit.defaultlight.energy > 0 && lit.defaultlight.strength > 0);
  // Night dims bloom, not lens coverage.
  assert.equal(evaluateLights(null, { headlights: "on", night: true }, 0, names).lamps.headlight_l.energy, lit.headlight_l.energy);
  assert.ok(evaluateLights(null, { headlights: "full" }, 0, names).lamps.headlight_l.energy > lit.headlight_l.energy);
  assert.ok(evaluateLights(null, { headlights: "on", brakes: true }, 0, names).lamps.taillight_l.energy > lit.taillight_l.energy);
});

test("lit sirens and steady burns carry the game's energy, so flasher reflectors burn through", async () => {
  const { createSirenSetting } = await import("./siren-settings.js");
  const setting = createSirenSetting({ count: 2 });
  const frame = evaluateLights(setting, { sirens: true, night: true }, 0);
  const lit = frame.sirens.filter((siren) => siren.on);
  const dark = frame.sirens.filter((siren) => !siren.on);
  assert.ok(lit.length && dark.length);
  // Day value at night too: night dims bloom, not coverage.
  for (const siren of lit) assert.equal(siren.energy, 150);
  for (const siren of dark) assert.equal(siren.energy, 0);
  assert.equal(frame.steady.energy, 15);
});

test("emission keeps the game's brightness order", () => {
  const siren = emissionStrength(150);
  const brake = emissionStrength(45);
  const head = emissionStrength(25);
  const indicator = emissionStrength(10);
  assert.ok(siren > brake && brake > head && head > indicator && indicator > 0);
  assert.equal(emissionStrength(0), 0);
  assert.equal(emissionStrength(Number.NaN), 0);
});

test("animation runs only while something flashes", () => {
  const setting = { sequencerBpm: 600, sirens: [{}] };
  assert.equal(lightsAnimate(setting, { sirens: true }), true);
  assert.equal(lightsAnimate(setting, { headlights: "on" }), false);
  assert.equal(lightsAnimate(null, { sirens: true }), false);
  assert.equal(lightsAnimate(null, { indicators: "hazard" }), true);
  assert.deepEqual(normalizeLightSwitches({ headlights: "bogus", indicators: "left" }).headlights, "off");
});

test("simulation resolves the model's siren setting and checks bones", () => {
  const meta = loadResourceMeta([
    { path: "carcols.meta", text: policeCarcols() },
    { path: "carvariations.meta", text: readFileSync(path.join(FIXTURES, "police", "carvariations.meta"), "utf8") },
  ]);
  const model = meta.variations[0].modelName;
  const sim = simulateVehicle(meta, model, { lightBones: ["siren1", "siren2", "siren3", "headlight_l"] });
  assert.equal(sim.sirenSetting?.id, meta.variations[0].sirenSettings);
  const codes = sim.warnings.map((warning) => warning.code);
  assert.ok(codes.includes("SIREN_SETTINGS_MISSING"));
  assert.ok(!codes.includes("SIREN_BONE_MISSING"));

  const missing = simulateVehicle(meta, model, { lightBones: ["siren1"] });
  assert.ok(missing.warnings.some((warning) => warning.code === "SIREN_BONE_MISSING"));
  // Without model bone data nothing bone-related is reported.
  const noBones = simulateVehicle(meta, model);
  assert.ok(!noBones.warnings.some((warning) => /^SIREN_(BONE|SETTINGS)_MISSING$/.test(warning.code)));
});

test("bad sequencers are reported; extra sirens are not", () => {
  const items = Array.from({ length: 22 }, (_, index) => `
    <Item><flashiness><sequencer value="${index === 3 ? "-5" : "4294967295"}" /></flashiness><flash value="true" /></Item>`).join("");
  const carcols = `<CVehicleModelInfoVarGlobal><Sirens><Item><id value="9" /><name>big</name><sequencerBpm value="300" /><sirens>${items}</sirens></Item></Sirens></CVehicleModelInfoVarGlobal>`;
  const variations = `<CVehicleModelInfoVariation><variationData><Item><modelName>big</modelName><sirenSettings value="9" /></Item></variationData></CVehicleModelInfoVariation>`;
  const meta = loadResourceMeta([{ path: "carcols.meta", text: carcols }, { path: "carvariations.meta", text: variations }]);
  const codes = simulateVehicle(meta, "big").warnings.map((warning) => warning.code);
  assert.ok(!codes.includes("SIREN_COUNT_ABOVE_VANILLA"), "more than 20 sirens is normal with the limit adjuster");
  assert.ok(codes.includes("SIREN_SEQUENCER_INVALID"));
  assert.equal(meta.sirens[0].sirens[3].flashiness.sequencer, null);
});

test("scale sirens grow by scaleFactor only while on", async () => {
  const { sirenFlashScale } = await import("./emergency-lights.js");
  assert.equal(sirenFlashScale(10), 10);
  assert.equal(sirenFlashScale(2), 2);
  assert.equal(sirenFlashScale(0), 1);
  assert.equal(sirenFlashScale(undefined), 1);
  const setting = {
    sequencerBpm: 600,
    sirens: [
      { flash: true, scale: true, scaleFactor: 10, flashiness: { sequencer: 0x80000000 } },
      { flash: true, scale: false, scaleFactor: 10, flashiness: { sequencer: 0x80000000 } },
    ],
  };
  const on = evaluateSirens(setting, 0.05);
  assert.equal(on[0].scale, 10);
  assert.equal(on[1].scale, 1);
  // Off beat: emitters return to their stored (hidden) size.
  assert.equal(evaluateSirens(setting, 0.15)[0].scale, 1);
});

test("id 0 emitters on an extra are steady-burn lights; the summary maps extras", async () => {
  const { summarizeVehicleLights } = await import("./emergency-lights.js");
  const lit = "vehicle_lightsemissive";
  assert.deepEqual(classifyLightMesh({ lightId: 0, shaderName: lit, extraIndex: 5 }), { kind: "steady", extra: 5 });
  assert.deepEqual(classifyLightMesh({ lightId: 0, shaderName: lit, extraIndex: null }), { kind: "lamp", name: "defaultlight", lamp: "always" });
  const summary = summarizeVehicleLights([
    { lightBone: "siren2", lightId: 0, shaderName: lit, extraIndex: 1 },
    { lightBone: "siren1", lightId: 0, shaderName: lit, extraIndex: 1 },
    { lightBone: "siren27", lightId: 0, shaderName: lit, extraIndex: 2 },
    { lightId: 0, shaderName: lit, extraIndex: 5 },
    { lightBone: "headlight_l", lightId: 1, shaderName: lit },
  ]);
  assert.deepEqual(summary.extras, { 1: { sirens: [1, 2], steady: false }, 2: { sirens: [27], steady: false }, 5: { sirens: [], steady: true } });
  assert.deepEqual(summary.lamps, ["headlight_l"]);
  assert.equal(summary.available, true);
});

test("siren bones report the heading they face, and a new setting starts there", async () => {
  const { boneHeading, sirenHeading, summarizeVehicleLights } = await import("./emergency-lights.js");
  const { createSirenSetting } = await import("./siren-settings.js");
  const half = Math.SQRT1_2;
  assert.equal(boneHeading([0, 0, 0, 1]), 0);
  assert.equal(boneHeading([0, 0, 1, 0]), Math.PI, "a bone turned to the rear reads pi, not -pi");
  assert.ok(Math.abs(boneHeading([0, 0, half, half]) - Math.PI / 2) < 1e-9, "+90 degrees about up faces left");
  assert.ok(Math.abs(boneHeading([0, 0, -half, half]) + Math.PI / 2) < 1e-9);
  assert.equal(boneHeading(undefined), 0);

  const summary = summarizeVehicleLights([], [
    { name: "siren1", rotation: [0, 0, 0, 1] },
    { name: "siren2", rotation: [0, 0, 1, 0] },
    { name: "siren3", rotation: [0, 0, half, half] },
    { name: "headlight_l", rotation: [0, 0, 1, 0] },
  ]);
  assert.deepEqual(Object.keys(summary.sirenHeadings), ["1", "2", "3"]);
  const setting = createSirenSetting({ count: 4, headings: summary.sirenHeadings });
  assert.deepEqual(setting.sirens.map((siren) => Number(sirenHeading(siren).toFixed(4))), [0, 3.1416, 1.5708, 0]);
  assert.deepEqual(setting.sirens.map((siren) => siren.rotation.delta), setting.sirens.map((siren) => siren.flashiness.delta));

  // Rotators aim at the rotation delta; everything else at the flashiness delta.
  assert.equal(sirenHeading({ rotate: true, rotation: { delta: 1 }, flashiness: { delta: 2 } }), 1);
  assert.equal(sirenHeading({ rotate: false, rotation: { delta: 1 }, flashiness: { delta: 2 } }), 2);
  assert.equal(sirenHeading({ rotate: false, rotation: { delta: 1 }, flashiness: {} }), 1);
});
