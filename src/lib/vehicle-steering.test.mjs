import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { applyFrontWheelSteering, clampSteeringAngle, getSteerableWheelMeshes } from "./vehicle-steering.js";

function wheelMesh(partName, origin) {
  const mesh = new THREE.Mesh(new THREE.BufferGeometry());
  mesh.userData.nativeMaterial = { part: partName ? "wheel" : null, partName, partOrigin: origin };
  return mesh;
}

function worldPoint(mesh, point) {
  mesh.updateMatrixWorld(true);
  return new THREE.Vector3(...point).applyMatrix4(mesh.matrixWorld);
}

test("only front wheels steer, every LOD of a wheel sharing its hub", () => {
  const root = new THREE.Group();
  root.add(
    wheelMesh("wheel_lf", [-0.86, 1.55, -0.54]),
    wheelMesh("wheel_rf", [0.86, 1.55, -0.54]),
    wheelMesh("wheel_lr", [-0.86, -1.55, -0.54]),
    wheelMesh("wheel_lf", null),
    wheelMesh(null, null),
  );
  assert.equal(getSteerableWheelMeshes(root).length, 3);
  assert.equal(applyFrontWheelSteering(root, 20), 3);
  assert.ok(root.children[2].quaternion.equals(new THREE.Quaternion()), "rear wheels stay straight");
});

test("wheels rotate about their own hub, positive angles steer right", () => {
  const hub = [-0.86, 1.55, -0.54];
  const mesh = wheelMesh("wheel_lf", hub);
  applyFrontWheelSteering(mesh, 30);

  const pivot = worldPoint(mesh, hub);
  assert.ok(pivot.distanceTo(new THREE.Vector3(...hub)) < 1e-6, "the hub does not move");

  // A point ahead of the hub swings toward +X (vehicle right) and stays level.
  const ahead = worldPoint(mesh, [hub[0], hub[1] + 1, hub[2]]);
  assert.ok(Math.abs(ahead.x - (hub[0] + Math.sin(Math.PI / 6))) < 1e-6);
  assert.ok(Math.abs(ahead.y - (hub[1] + Math.cos(Math.PI / 6))) < 1e-6);
  assert.ok(Math.abs(ahead.z - hub[2]) < 1e-6);

  applyFrontWheelSteering(mesh, 0);
  assert.ok(worldPoint(mesh, [1, 2, 3]).distanceTo(new THREE.Vector3(1, 2, 3)) < 1e-6, "zero restores the original pose");
});

test("steering angles clamp to the handling lock", () => {
  assert.equal(clampSteeringAngle(50, 36), 36);
  assert.equal(clampSteeringAngle(-50, 36), -36);
  assert.equal(clampSteeringAngle(12.5, 36), 12.5);
  assert.equal(clampSteeringAngle("nope", 36), 0);
});

test("wheels from caches without an exported hub pivot steer about their geometry centre", () => {
  const geometry = new THREE.BufferGeometry();
  // A wheel spanning x -1.0..-0.7, y 1.1..2.0, z -0.95..-0.13.
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, 1.1, -0.95, -0.7, 2, -0.13], 3));
  const mesh = new THREE.Mesh(geometry);
  mesh.userData.nativeMaterial = { part: "wheel", partName: "wheel_rf", partOrigin: null };

  assert.equal(applyFrontWheelSteering(mesh, -25), 1);
  const centre = [-0.85, 1.55, -0.54];
  assert.ok(worldPoint(mesh, centre).distanceTo(new THREE.Vector3(...centre)) < 1e-6, "the geometry centre stays put");
});

test("brake parts on the front hub bones turn about their wheel's hub", () => {
  const hub = [0.87, 1.55, -0.54];
  const root = new THREE.Group();
  const wheel = wheelMesh("wheel_rf", hub);
  const caliper = new THREE.Mesh(new THREE.BufferGeometry());
  caliper.userData.nativeMaterial = { part: "hub", partName: "hub_rf", partOrigin: null };
  const rearCaliper = new THREE.Mesh(new THREE.BufferGeometry());
  rearCaliper.userData.nativeMaterial = { part: "hub", partName: "hub_rr", partOrigin: null };
  root.add(wheel, caliper, rearCaliper);

  assert.equal(applyFrontWheelSteering(root, 15), 2);
  assert.ok(caliper.matrix.equals(wheel.matrix), "the caliper follows the wheel exactly");
  assert.ok(rearCaliper.quaternion.equals(new THREE.Quaternion()), "rear brakes stay put");
});

test("brake parts without a wheel on their side are left alone", () => {
  const caliper = new THREE.Mesh(new THREE.BufferGeometry());
  caliper.userData.nativeMaterial = { part: "hub", partName: "hub_lf", partOrigin: null };
  assert.equal(applyFrontWheelSteering(caliper, 15), 0);
});

