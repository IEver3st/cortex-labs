import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { createVehicleRig, describeJointParts, normalizeManifestSkeleton, normalizeModelClip } from "./vehicle-rig.js";

// Chassis at the origin; a driver door hinged 0.9 m left and 0.8 m forward, a
// window parented to the door, a bonnet, and two soft-top bones.
function manifest(extraJoints = []) {
  return {
    skeleton: {
      bones: [
        { name: "chassis", tag: 0, parent: -1, translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
        { name: "door_dside_f", tag: 60963, parent: 0, translation: [-0.9, 0.8, 0], rotation: [0, 0, 0, 1] },
        { name: "window_lf", tag: 26734, parent: 1, translation: [0.1, -0.7, 0.5], rotation: [0, 0, 0, 1] },
        { name: "bonnet", tag: 42990, parent: 0, translation: [0, 1, 0.5], rotation: [0, 0, 0, 1] },
        { name: "soft_1", tag: 1001, parent: 0, translation: [0, -1, 1], rotation: [0, 0, 0, 1] },
        { name: "soft_2", tag: 1002, parent: 4, translation: [0, -0.5, 0], rotation: [0, 0, 0, 1] },
        { name: "scoop", tag: 1160, parent: 0, translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
      ],
      joints: [
        { bone: 60963, kind: "rotation", min: [0, 0, -1.2391838], max: [0, 0, 0] },
        { bone: 42990, kind: "rotation", min: [0, 0, 0], max: [0.87, 0, 0] },
        { bone: 1160, kind: "rotation", min: [0, 0, -1.5], max: [0, 0, 1.5] },
        ...extraJoints,
      ],
    },
  };
}

function mesh(positions, nativeMaterial = {}, skin = null) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(positions), 3));
  const object = new THREE.Mesh(geometry);
  object.userData.nativeMaterial = { boneIndex: null, ...nativeMaterial };
  if (skin) geometry.userData.skin = skin;
  return object;
}

function worldPoint(object, index = 0) {
  object.updateMatrixWorld(true);
  return new THREE.Vector3().fromBufferAttribute(object.geometry.attributes.position, index).applyMatrix4(object.matrixWorld);
}

function close(actual, expected, message) {
  assert.ok(actual.distanceTo(expected) < 1e-4, `${message}: expected ${expected.toArray()}, got ${actual.toArray()}`);
}

test("parts come from joint limits, ordered and labelled, with rest and open ends", () => {
  const skeleton = normalizeManifestSkeleton(manifest([{ bone: 999, kind: "rotation", min: [0, 0, 0], max: [1, 0, 0] }]));
  const parts = describeJointParts(skeleton);
  assert.deepEqual(parts.map((part) => part.id), ["door_dside_f", "bonnet", "scoop"], "unknown bone tags are skipped");
  const [door, bonnet, scoop] = parts;
  assert.equal(door.label, "Driver door");
  assert.equal(door.axis, 2);
  assert.equal(door.rest, 0);
  assert.equal(door.open, door.min, "the driver door opens towards its negative limit");
  assert.equal(bonnet.open, 0.87);
  assert.equal(scoop.rest, 0, "a two-sided joint rests at zero");
});

test("skeletons with malformed bones are rejected and bad parents become roots", () => {
  assert.equal(normalizeManifestSkeleton({ skeleton: { bones: [{ name: "a", translation: [0, 0], rotation: [0, 0, 0, 1] }] } }), null);
  assert.equal(normalizeManifestSkeleton({}), null);
  const skeleton = normalizeManifestSkeleton({ skeleton: { bones: [
    { name: "a", tag: 1, parent: 1, translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
    { name: "b", tag: 2, parent: 5, translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
  ] } });
  assert.deepEqual(skeleton.bones.map((bone) => bone.parent), [-1, -1], "forward and out-of-range parents cannot form a cycle");
});

test("opening a door swings it and its window about the hinge", () => {
  const skeleton = normalizeManifestSkeleton(manifest());
  // A door corner 1 m behind the hinge, a window vertex, and an unrelated body vertex.
  const door = mesh([-0.9, -0.2, 0], { boneIndex: 1 });
  const window = mesh([-0.8, -0.1, 0.5], { boneIndex: 2 });
  const body = mesh([0, 0, 0], { boneIndex: 0 });
  const root = new THREE.Group().add(door, window, body);
  const rig = createVehicleRig({ skeleton, meshes: [door, window, body] });

  assert.deepEqual(rig.parts.map((part) => part.id), ["door_dside_f"], "parts without geometry are hidden");
  rig.setValue("door_dside_f", -Math.PI / 2, { animate: false });
  rig.update(0);
  root.updateMatrixWorld(true);
  // Clamped to the 71° limit about the hinge's Z axis.
  const hinge = new THREE.Vector3(-0.9, 0.8, 0);
  const swung = (x, y, z) => new THREE.Vector3(x, y, z).sub(hinge).applyAxisAngle(new THREE.Vector3(0, 0, 1), -1.2391838).add(hinge);
  close(worldPoint(door), swung(-0.9, -0.2, 0), "door corner");
  assert.ok(worldPoint(door).x < -1.5, "the driver door opens outwards");
  close(worldPoint(window), swung(-0.8, -0.1, 0.5), "the window follows its door");
  close(worldPoint(body), new THREE.Vector3(0, 0, 0), "the body stays put");
  assert.ok(rig.isOpen("door_dside_f"));

  rig.toggle("door_dside_f", { animate: false });
  rig.update(0);
  close(worldPoint(door), new THREE.Vector3(-0.9, -0.2, 0), "closing restores the bind pose");
  assert.equal(door.position.length(), 0);
});

test("a mod part fitted to the door bone swings with the door from vehicle space", () => {
  const skeleton = normalizeManifestSkeleton(manifest());
  const door = mesh([-0.9, -0.2, 0], { boneIndex: 1 });
  // A door badge exported where it sits on the closed door; its own one-bone
  // skeleton gives it bone index 0, which must not read as the vehicle's chassis.
  const badge = mesh([-0.92, 0.1, 0.1], { boneIndex: 0 });
  badge.userData.vehicleModPart = true;
  const part = new THREE.Group().add(badge);
  const antenna = new THREE.Group().add(mesh([0, -2, 0.5]));
  const root = new THREE.Group().add(door, part, antenna);
  const rig = createVehicleRig({ skeleton, meshes: [door] });

  assert.equal(rig.attach(part, "DOOR_DSIDE_F"), true, "bone names match without case");
  assert.equal(rig.attach(antenna, "boot"), false, "a bone the vehicle lacks leaves the part where it is");
  close(worldPoint(badge), new THREE.Vector3(-0.92, 0.1, 0.1), "attaching at rest does not move the part");
  assert.equal(rig.targetForMesh(badge)?.part.id, "door_dside_f", "clicking the badge opens its door");

  rig.setValue("door_dside_f", -1, { animate: false });
  rig.update(0);
  root.updateMatrixWorld(true);
  const hinge = new THREE.Vector3(-0.9, 0.8, 0);
  const swung = new THREE.Vector3(-0.92, 0.1, 0.1).sub(hinge).applyAxisAngle(new THREE.Vector3(0, 0, 1), -1).add(hinge);
  close(worldPoint(badge), swung, "the badge stays on the open door");
  close(worldPoint(antenna.children[0]), new THREE.Vector3(0, -2, 0.5), "an unattached part stays put");

  rig.detach(part);
  root.updateMatrixWorld(true);
  close(worldPoint(badge), new THREE.Vector3(-0.92, 0.1, 0.1), "detaching returns the part to vehicle space");
  assert.equal(rig.targetForMesh(badge), null, "a detached mod part no longer opens the door");
});

test("open all swings one-sided parts and leaves two-sided joints centred", () => {
  const skeleton = normalizeManifestSkeleton(manifest());
  const door = mesh([-0.9, -0.2, 0], { boneIndex: 1 });
  const scoop = mesh([0, 0, 0.2], { boneIndex: 6 });
  const rig = createVehicleRig({ skeleton, meshes: [door, scoop] });
  rig.setAll(true, { animate: false });
  rig.update(0);
  assert.equal(rig.getValue("door_dside_f"), -1.2391838);
  assert.equal(rig.getValue("scoop"), 0);
});

test("a sliding door follows its tilted slide dummy outward", () => {
  // Passenger-side box door from a real ambulance: the dummy is turned 4° about Z
  // so a 0.8 m backward slide also clears the body by ~5.6 cm; a counter-rotated
  // child keeps the door panel square to the body.
  const tilt = 4 * Math.PI / 180;
  const half = [0, 0, Math.sin(tilt / 2), Math.cos(tilt / 2)];
  const skeleton = normalizeManifestSkeleton({
    skeleton: {
      bones: [
        { name: "chassis", tag: 0, parent: -1, translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
        { name: "bonnet", tag: 42990, parent: 0, translation: [1.19, -1.7, 0.42], rotation: half },
        { name: "misc_z", tag: 58639, parent: 1, translation: [0, 0, 0], rotation: [0, 0, -half[2], half[3]] },
      ],
      joints: [{ bone: 42990, kind: "translation", min: [0, -0.8, 0], max: [0, 0, 0] }],
    },
  });
  const door = mesh([1.2, -2, 0.5], { boneIndex: 2 });
  const rig = createVehicleRig({ skeleton, meshes: [door] });
  rig.toggle("bonnet", { animate: false });
  rig.update(0);
  close(worldPoint(door), new THREE.Vector3(1.2 + 0.8 * Math.sin(tilt), -2 - 0.8 * Math.cos(tilt), 0.5), "door slides back and out");
  assert.ok(door.quaternion.angleTo(new THREE.Quaternion()) < 1e-6, "the panel stays square to the body");
  const frame = rig.getPartFrame("bonnet");
  close(frame.axis, new THREE.Vector3(-Math.sin(tilt), Math.cos(tilt), 0), "drag axis matches the slide");
});

test("animated moves ease to the target and report while moving", () => {
  const skeleton = normalizeManifestSkeleton(manifest());
  const door = mesh([-0.9, -0.2, 0], { boneIndex: 1 });
  const rig = createVehicleRig({ skeleton, meshes: [door] });
  rig.toggle("door_dside_f", { now: 0 });
  assert.equal(rig.getTarget("door_dside_f"), -1.2391838);
  assert.equal(rig.update(100), true);
  const midway = rig.getValue("door_dside_f");
  assert.ok(midway < 0 && midway > -1.2391838);
  assert.equal(rig.update(5000), false, "settled");
  assert.equal(rig.getValue("door_dside_f"), -1.2391838);
  assert.equal(rig.getOpenAmount("door_dside_f"), 1);
});

test("blended roof vertices are skinned across their bones and restored on reset", () => {
  const skeleton = normalizeManifestSkeleton(manifest());
  // Vertex 0 half on soft_1 and half on soft_2; vertex 1 only on soft_2.
  const roof = mesh([0, -1.5, 1, 0, -1.5, 1.2], {}, {
    indices: Uint16Array.from([4, 5, 0, 0, 5, 0, 0, 0]),
    weights: Uint8Array.from([128, 127, 0, 0, 255, 0, 0, 0]),
  });
  const shared = roof.geometry;
  const rig = createVehicleRig({ skeleton, meshes: [roof] });
  assert.notEqual(roof.geometry, shared, "a deforming mesh gets its own geometry");
  assert.equal(rig.setClip({
    duration: 1,
    samples: 2,
    rotations: [],
    // soft_2 slides 0.4 m backwards over the clip; a track for a missing bone is ignored.
    translations: [
      { bone: 1002, values: [0, -0.5, 0, 0, -0.9, 0] },
      { bone: 4242, values: [0, 0, 0, 1, 1, 1] },
    ],
  }), true);
  assert.equal(rig.hasRoof, true);

  rig.setValue("roof", 1, { animate: false });
  rig.update(0);
  const positions = roof.geometry.attributes.position.array;
  assert.ok(Math.abs(positions[1] - (-1.5 - 0.4 * 127 / 255)) < 1e-4, `blended vertex moves by its weight, got ${positions[1]}`);
  assert.ok(Math.abs(positions[4] - (-1.9)) < 1e-4, "single-bone vertex moves fully");
  assert.deepEqual(Array.from(shared.attributes.position.array), [0, -1.5, 1, 0, -1.5, 1.2].map(Math.fround), "cached geometry is untouched");

  rig.reset();
  assert.deepEqual(Array.from(roof.geometry.attributes.position.array), Array.from(Float32Array.from([0, -1.5, 1, 0, -1.5, 1.2])));
});

test("clicks resolve to the part a mesh hangs from, or to the roof", () => {
  const skeleton = normalizeManifestSkeleton(manifest());
  const window = mesh([-0.8, -0.1, 0.5], { boneIndex: 2 });
  const body = mesh([0, 0, 0], { boneIndex: 0 });
  const roof = mesh([0, -1.5, 1], { boneIndex: 5 });
  const rig = createVehicleRig({ skeleton, meshes: [window, body, roof] });
  assert.equal(rig.targetForMesh(window).part.id, "door_dside_f", "a window opens with its door");
  assert.equal(rig.targetForMesh(body), null);
  assert.equal(rig.targetForMesh(roof), null, "no roof without a clip");
  rig.setClip({ duration: 1, samples: 2, translations: [{ bone: 1001, values: [0, -1, 1, 0, -1.2, 0.8] }] });
  assert.deepEqual(rig.targetForMesh(roof), { kind: "roof" }, "geometry under an animated bone plays the roof");
  assert.equal(rig.targetForMesh(body), null);
});

test("roof clips are validated against the skeleton", () => {
  const skeleton = normalizeManifestSkeleton(manifest());
  assert.equal(normalizeModelClip({ duration: 1, samples: 2, rotations: [{ bone: 4242, values: [0, 0, 0, 1, 0, 0, 0, 1] }] }, skeleton), null, "no usable track");
  assert.equal(normalizeModelClip({ duration: 0, samples: 2, translations: [{ bone: 1002, values: [0, 0, 0, 0, 0, 0] }] }, skeleton), null, "no duration");
  assert.equal(normalizeModelClip({ duration: 1, samples: 2, translations: [{ bone: 1002, values: [0, 0, 0] }] }, skeleton), null, "short track");
  const clip = normalizeModelClip({ duration: 2, samples: 2, translations: [{ bone: 1002, values: [0, 0, 0, 1, 1, 1] }] }, skeleton);
  assert.equal(clip.translations[0].boneIndex, 5);
});

test("models without a skeleton or moving geometry get no rig", () => {
  assert.equal(createVehicleRig({ skeleton: null, meshes: [] }), null);
  const skeleton = normalizeManifestSkeleton(manifest());
  assert.equal(createVehicleRig({ skeleton, meshes: [mesh([0, 0, 0])] }), null);
});
