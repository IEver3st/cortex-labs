import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { normalizeModelRotation, orientModel, quarterTurn } from "./model-orientation.js";

function boxModel(width, height, depth) {
  const wrapper = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth));
  mesh.position.set(0, height / 2, 0);
  wrapper.add(mesh);
  wrapper.updateMatrixWorld(true);
  return wrapper;
}

test("four quarter turns on one axis return to the loader's orientation", () => {
  for (const axis of ["x", "y", "z"]) {
    let rotation = null;
    for (let i = 0; i < 4; i++) rotation = quarterTurn(rotation, axis);
    assert.equal(rotation, null, axis);
  }
});

test("quarter turns snap to exact values and compose about the model's own axes", () => {
  const once = quarterTurn(null, "x");
  assert.deepEqual(once, [Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
  const twice = quarterTurn(once, "x");
  assert.deepEqual(twice, [1, 0, 0, 0]);
  // X then Y applies Y in the turned frame: q = qx * qy.
  const expected = new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2));
  const got = quarterTurn(once, "y");
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(got[i] - expected.toArray()[i]) < 1e-9);
});

test("an unknown axis leaves the rotation unchanged", () => {
  const once = quarterTurn(null, "y");
  assert.deepEqual(quarterTurn(once, "w"), once);
  assert.equal(quarterTurn(null, ""), null);
});

test("saved rotations are validated", () => {
  assert.equal(normalizeModelRotation(null), null);
  assert.equal(normalizeModelRotation([0, 0, 0, 1]), null);
  assert.equal(normalizeModelRotation([0, 0, 0, -1]), null);
  assert.equal(normalizeModelRotation([1, 2, 3]), null);
  assert.equal(normalizeModelRotation([Number.NaN, 0, 0, 1]), null);
  assert.equal(normalizeModelRotation([0, 0, 0, 2]), null);
  assert.equal(normalizeModelRotation(["0", 0, 0, 1]), null);
  // -q is the same turn as q and is stored the same way.
  assert.deepEqual(normalizeModelRotation([-Math.SQRT1_2, 0, 0, -Math.SQRT1_2]), [Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
});

test("orientModel turns the model and stands it centred on the floor", () => {
  const model = boxModel(2, 4, 1);
  const bounds = orientModel(model, quarterTurn(null, "x"));
  const world = new THREE.Box3().setFromObject(model);
  assert.ok(Math.abs(world.min.y) < 1e-9, "grounded");
  const center = world.getCenter(new THREE.Vector3());
  assert.ok(Math.abs(center.x) < 1e-9 && Math.abs(center.z) < 1e-9, "centred");
  const size = world.getSize(new THREE.Vector3());
  // The 4-tall box lies along Z after a quarter turn about X.
  assert.ok(Math.abs(size.y - 1) < 1e-9 && Math.abs(size.z - 4) < 1e-9);
  assert.ok(bounds.equals(world));
});

test("orientModel with no rotation restores the loader's placement", () => {
  const model = boxModel(2, 4, 1);
  orientModel(model, quarterTurn(null, "z"));
  orientModel(model, null);
  assert.deepEqual(model.quaternion.toArray(), [0, 0, 0, 1]);
  const world = new THREE.Box3().setFromObject(model);
  assert.ok(Math.abs(world.min.y) < 1e-9 && Math.abs(world.max.y - 4) < 1e-9);
});

test("orientModel ignores a missing or empty model", () => {
  assert.equal(orientModel(null, null), null);
  assert.equal(orientModel(new THREE.Group(), quarterTurn(null, "x")), null);
});
