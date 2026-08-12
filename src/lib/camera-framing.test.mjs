import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  buildCameraFraming,
  computeFramingBounds,
  DEFAULT_CAMERA_PRESET,
} from "./camera-framing.js";

function assertVectorClose(actual, expected, epsilon = 1e-9) {
  assert.ok(actual.distanceTo(expected) <= epsilon, `${actual.toArray()} != ${expected.toArray()}`);
}

test("camera framing targets the visual center of an offset model", () => {
  const bounds = new THREE.Box3(
    new THREE.Vector3(8, -2, 14),
    new THREE.Vector3(12, 6, 18),
  );

  const framing = buildCameraFraming({
    bounds,
    aspect: 16 / 9,
    presetKey: DEFAULT_CAMERA_PRESET,
  });

  assertVectorClose(framing.target, new THREE.Vector3(10, 2, 16));
  assert.ok(framing.position.distanceTo(framing.target) > 0);
});

test("rotated model bounds produce a new centered frame", () => {
  const geometry = new THREE.BoxGeometry(2, 4, 1);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.position.y = 2;
  const model = new THREE.Group();
  model.add(mesh);
  model.updateMatrixWorld(true);

  model.rotateX(Math.PI / 2);
  model.updateMatrixWorld(true);

  const bounds = computeFramingBounds(model);
  const framing = buildCameraFraming({ bounds, aspect: 1 });
  const expectedCenter = bounds.getCenter(new THREE.Vector3());

  assertVectorClose(framing.target, expectedCenter);
  assert.ok(Math.abs(expectedCenter.z - 2) < 1e-9);
  assert.ok(Math.abs(expectedCenter.y) < 1e-9);

  geometry.dispose();
  mesh.material.dispose();
});
