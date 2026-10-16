import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILT_IN_SHOWROOM,
  DEFAULT_LIGHT,
  DEFAULT_PLATE,
  STEERING_DEFAULT_LIMIT,
  normalizeLightDefaults,
  normalizePlateDefault,
  normalizeShowroomDefaults,
  normalizeShowroomSubject,
  normalizeSteeringDefault,
  resolveDefaultSteering,
} from "./studio-defaults.js";
import { normalizePropState } from "./prop-studio.js";
import { SHOWROOM_FLOORS } from "./showroom-floors.js";

test("missing or malformed showroom defaults fall back to each subject's built-in scene", () => {
  assert.deepEqual(normalizeShowroomDefaults(undefined), {
    vehicle: { ...BUILT_IN_SHOWROOM.vehicle },
    ped: { ...BUILT_IN_SHOWROOM.ped },
    prop: { ...BUILT_IN_SHOWROOM.prop },
  });
  assert.deepEqual(normalizeShowroomDefaults({ vehicle: "showroom", ped: null }).vehicle, { ...BUILT_IN_SHOWROOM.vehicle });
});

test("showroom values are clamped and only carry the fields a subject uses", () => {
  const vehicle = normalizeShowroomSubject({ stage: "showroom", light: "left", spot: 9, reflect: -1, beam: false, rim: 1, floor: "tiles", dark: 1 }, "vehicle");
  assert.deepEqual(vehicle, { stage: "showroom", light: "left", spot: 2, reflect: 0, beam: false, floor: "tiles" });

  const prop = normalizeShowroomSubject({ stage: "studio", light: "under", spot: "1", rim: 1.5, floor: "carpet", dark: 0.4 }, "prop");
  assert.equal(prop.stage, "workbench");
  assert.equal(prop.light, BUILT_IN_SHOWROOM.prop.light);
  assert.equal(prop.spot, BUILT_IN_SHOWROOM.prop.spot);
  assert.equal(prop.rim, 1.5);
  assert.equal(prop.floor, BUILT_IN_SHOWROOM.prop.floor);
  assert.equal(prop.dark, 0.4);
  assert.equal("dark" in normalizeShowroomSubject({}, "ped"), false);
});

test("every floor finish survives normalisation for every subject", () => {
  for (const subject of ["vehicle", "ped", "prop"]) {
    for (const floor of SHOWROOM_FLOORS) {
      assert.equal(normalizeShowroomSubject({ floor }, subject).floor, floor, `${subject} keeps ${floor}`);
    }
  }
  assert.equal(normalizePropState({ scene: { floor: "marble" } }).scene.floor, "marble");
});

test("plate defaults keep a real style index and text a plate can show", () => {
  assert.deepEqual(normalizePlateDefault(undefined), { ...DEFAULT_PLATE });
  assert.deepEqual(normalizePlateDefault({ style: 4, text: "cortex-01!" }), { style: 4, text: "CORTEX01" });
  assert.deepEqual(normalizePlateDefault({ style: 99, text: "" }), { style: DEFAULT_PLATE.style, text: "" });
  assert.equal(normalizePlateDefault({ style: 1.5 }).style, DEFAULT_PLATE.style);
  assert.deepEqual(
    normalizePlateDefault({ style: 2, text: "GSD", image: { path: "C:/plates/gsd.png", stamp: 5 } }),
    { style: 2, text: "GSD", image: { path: "C:/plates/gsd.png", stamp: 5 } },
    "a custom plate image survives reload",
  );
  assert.deepEqual(normalizePlateDefault({ style: 2, text: "GSD", image: null }), { style: 2, text: "GSD" }, "a removed image stays removed");
  assert.deepEqual(normalizePlateDefault({ style: 2, text: "GSD", image: { path: "notes.txt" } }), { style: 2, text: "GSD" });
});

test("steering defaults stay within the limit in half-degree steps", () => {
  assert.equal(normalizeSteeringDefault(undefined), 0);
  assert.equal(normalizeSteeringDefault(12.3), 12.5);
  assert.equal(normalizeSteeringDefault(-200), -STEERING_DEFAULT_LIMIT);
  assert.equal(Object.is(normalizeSteeringDefault(-0.1), -0), false);
});

test("a vehicle without a steering lock starts straight; with one the default is capped", () => {
  assert.equal(resolveDefaultSteering(30, null), 0);
  assert.equal(resolveDefaultSteering(30, undefined), 0);
  assert.equal(resolveDefaultSteering(30, 0), 0);
  assert.equal(resolveDefaultSteering(30, 40), 30);
  assert.equal(resolveDefaultSteering(-38, 35), -35);
});

test("light defaults read the stored keys and reject out-of-range values", () => {
  assert.deepEqual(normalizeLightDefaults({}), { ...DEFAULT_LIGHT });
  assert.deepEqual(normalizeLightDefaults({ lightIntensity: 5, lightAzimuth: -30, lightElevation: 120 }), { intensity: 3, azimuth: 330, elevation: 90 });
});

test("Prop Studio seeds a new workspace's scene from the showroom defaults, saved state still wins", () => {
  const showroom = normalizeShowroomSubject({ stage: "showroom", light: "back", floor: "tiles", dark: 0.7, beam: true }, "prop");
  const fresh = normalizePropState({}, { showroom });
  assert.equal(fresh.scene.stage, "showroom");
  assert.equal(fresh.scene.light, "back");
  assert.equal(fresh.scene.floor, "tiles");
  assert.equal(fresh.scene.dark, 0.7);
  assert.equal(fresh.scene.beam, true);

  const saved = normalizePropState({ scene: { stage: "workbench", floor: "concrete" } }, { showroom });
  assert.equal(saved.scene.stage, "workbench");
  assert.equal(saved.scene.floor, "concrete");
  assert.equal(saved.scene.light, "back");

  const legacy = normalizePropState({}, {});
  assert.equal(legacy.scene.floor, BUILT_IN_SHOWROOM.prop.floor);
  assert.equal(legacy.scene.reflect, BUILT_IN_SHOWROOM.prop.reflect);
});
