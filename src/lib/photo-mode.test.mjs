import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_LENS_MM,
  PHOTO_OBJECT_LIMIT,
  filterGameVehicles,
  lensToFov,
  normalizePhotoObject,
  normalizePhotoState,
  objectLabel,
  outputSize,
  photoFileName,
  photoPoseClip,
  placeNewObject,
  normalizeVehicleSettings,
  litObjectIds,
  normalizeObjectLight,
  PHOTO_SPOTLIGHT_LIMIT,
  vehicleClassLabel,
} from "./photo-mode.js";

test("lens focal length maps to the full-frame vertical field of view", () => {
  assert.ok(Math.abs(lensToFov(24) - 53.13) < 0.01);
  assert.ok(Math.abs(lensToFov(50) - 26.99) < 0.01);
  // Out of range and junk fall back or clamp instead of producing NaN.
  assert.equal(lensToFov(1), lensToFov(14));
  assert.equal(lensToFov("x"), lensToFov(DEFAULT_LENS_MM));
});

test("game objects keep only identifier names; file objects need a supported extension", () => {
  assert.equal(normalizePhotoObject({ kind: "vehicle", name: "Adder" }).name, "adder");
  assert.equal(normalizePhotoObject({ kind: "vehicle", name: "../adder" }), null);
  assert.equal(normalizePhotoObject({ kind: "prop", source: "file", path: "C:\\mods\\cone.ydr" }).name, "cone.ydr");
  assert.equal(normalizePhotoObject({ kind: "vehicle", source: "file", path: "C:\\mods\\car.ydr" }), null);
  assert.equal(normalizePhotoObject({ kind: "boat", name: "jetmax" }), null);
});

test("vehicles restore paint and keep only open doors in range", () => {
  const vehicle = normalizePhotoObject({
    kind: "vehicle",
    name: "police",
    vehicle: { doors: { door_dside_f: 2, bonnet: 0, "../x": 1, boot: 0.5 } },
  });
  assert.deepEqual(vehicle.vehicle.doors, { door_dside_f: 1, boot: 0.5 });
  assert.ok(vehicle.vehicle.paint.primary.color);
});

test("peds fall back to valid presets and the default pose", () => {
  const ped = normalizePhotoObject({ kind: "ped", ped: { gender: "female", body: "nope", pose: "dance" } });
  assert.equal(ped.name, "mp_f_freemode_01");
  assert.equal(ped.ped.pose, "idle");
  assert.match(ped.ped.body, /^f-/);
  assert.match(ped.ped.outfit, /^f-/);
});

test("pose clips resolve per gender, shared pairs, custom clips and the bind pose", () => {
  assert.deepEqual(photoPoseClip({ pose: "idle", gender: "female" }), { dict: "move_f@generic", clip: "idle" });
  assert.equal(photoPoseClip({ pose: "lean", gender: "female" }).clip, "idle_a");
  assert.equal(photoPoseClip({ pose: "bind" }), null);
  assert.deepEqual(photoPoseClip({ pose: "custom", dict: "mp_arresting", clip: "idle" }), { dict: "mp_arresting", clip: "idle" });
  assert.equal(photoPoseClip({ pose: "custom", dict: "a b", clip: "idle" }), null);
});

test("new objects line up without overlapping", () => {
  const first = { kind: "vehicle", position: placeNewObject([], "vehicle") };
  assert.deepEqual(first.position, [0, 0, 0]);
  const second = { kind: "vehicle", position: placeNewObject([first], "vehicle") };
  const third = { kind: "ped", position: placeNewObject([first, second], "ped") };
  const xs = [first, second, third].map((item) => item.position[0]);
  assert.equal(new Set(xs).size, 3);
  assert.ok(Math.abs(second.position[0]) >= 3.4);
});

test("state normalisation caps objects, drops duplicates and repairs the selection", () => {
  const objects = Array.from({ length: PHOTO_OBJECT_LIMIT + 4 }, (_, index) => ({ id: `o${index}`, kind: "prop", name: `prop_${index}` }));
  objects.push({ id: "o1", kind: "prop", name: "dup" });
  const state = normalizePhotoState({ objects, selectedId: "missing", output: { preset: "nope" } });
  assert.equal(state.objects.length, PHOTO_OBJECT_LIMIT);
  assert.equal(state.selectedId, "o0");
  assert.deepEqual(outputSize(state.output), { width: 1920, height: 1080 });
  assert.equal(normalizePhotoState(null).scene.stage, "showroom");
  assert.equal(normalizePhotoState({ camera: { position: [0, 1], target: [0, 0, 0] } }).camera, null);
});

test("vehicle catalogue filter matches every token across name, display name and make", () => {
  const list = [
    { name: "police", gameName: "POLICE", make: "VAPID", vehicleClass: "VC_EMERGENCY" },
    { name: "adder", gameName: "ADDER", make: "TRUFFADE", vehicleClass: "VC_SUPER" },
    { name: "club", gameName: "CLUB", make: "BF", vehicleClass: "VC_COMPACTS" },
  ];
  // The game's two spellings of one class filter and label as one.
  assert.deepEqual(filterGameVehicles(list, { vehicleClass: "VC_COMPACT" }).map((v) => v.name), ["club"]);
  assert.equal(vehicleClassLabel("VC_COMPACTS"), "Compacts");
  assert.deepEqual(filterGameVehicles(list, { query: "vapid pol" }).map((v) => v.name), ["police"]);
  assert.deepEqual(filterGameVehicles(list, { vehicleClass: "VC_SUPER" }).map((v) => v.name), ["adder"]);
  assert.equal(filterGameVehicles(list, {}).length, 3);
});

test("labels and file names come from the scene's objects", () => {
  assert.equal(objectLabel({ source: "file", path: "D:\\cars\\mycar_hi.yft" }), "mycar_hi");
  assert.equal(objectLabel({ source: "game", name: "adder" }), "adder");
  // A ped's label follows its current gender, not the name it was added with.
  assert.equal(objectLabel({ kind: "ped", name: "mp_m_freemode_01", ped: { gender: "female" } }), "mp_f_freemode_01");
  assert.equal(photoFileName([{ name: "adder", hidden: true }, { name: "police" }]), "police_photo.png");
  assert.equal(photoFileName([]), "photo.png");
});

test("vehicle settings keep valid mods, extras, livery, roof, steering and plate", () => {
  const vehicle = normalizeVehicleSettings({
    roof: 3,
    steering: -90,
    livery: 2,
    extras: { 1: true, 2: false, 7: "yes", 400: true },
    mods: { kit: " 211_elegy1_modkit ", slots: { vmt_spoiler: 3, VMT_ROOF: -1, "bad slot": 1, VMT_SKIRT: 1.5 } },
    plate: { style: 2, text: "photo mode" },
  });
  assert.equal(vehicle.roof, 1);
  assert.equal(vehicle.steering, -60);
  assert.equal(vehicle.livery, 2);
  assert.deepEqual(vehicle.extras, { 1: true });
  assert.deepEqual(vehicle.mods, { kit: "211_elegy1_modkit", slots: { VMT_SPOILER: 3 } });
  assert.equal(vehicle.plate.style, 2);
  assert.match(vehicle.plate.text, /^[A-Z0-9 ]+$/);
  // Older saves without these fields get the stock vehicle.
  const plain = normalizeVehicleSettings({});
  assert.deepEqual([plain.roof, plain.steering, plain.livery, plain.extras, plain.mods], [0, 0, null, {}, { kit: "", slots: {} }]);
});

test("object spotlights default on, keep valid settings and light at most the cap", () => {
  assert.deepEqual(normalizeObjectLight(undefined), { on: true, strength: 1, from: "", color: null, beam: true });
  assert.deepEqual(
    normalizeObjectLight({ on: false, strength: 9, from: "left", color: "#FF0000", beam: false }),
    { on: false, strength: 3, from: "left", color: "#ff0000", beam: false },
  );
  assert.equal(normalizeObjectLight({ from: "under", color: "red" }).from, "");
  const objects = Array.from({ length: PHOTO_SPOTLIGHT_LIMIT + 3 }, (_, index) => ({
    id: `o${index}`,
    hidden: index === 0,
    light: { on: index !== 1 },
  }));
  const lit = litObjectIds(objects);
  assert.equal(lit.length, PHOTO_SPOTLIGHT_LIMIT);
  assert.ok(!lit.includes("o0") && !lit.includes("o1"));
});
