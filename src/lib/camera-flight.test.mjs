import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  FLY_MAX_PITCH,
  getFlyCameraSpeed,
  updateFlyLookQuaternion,
  updateFlyMovementVector,
} from "./camera-flight.js";

function movement(state, quaternion = new THREE.Quaternion(), deltaSeconds = 1 / 60) {
  return updateFlyMovementVector({
    target: new THREE.Vector3(),
    forward: new THREE.Vector3(),
    right: new THREE.Vector3(),
    quaternion,
    state,
    framingDistance: 10,
    deltaSeconds,
  });
}

test("fly movement follows the camera pitch instead of flattening to the ground", () => {
  const quaternion = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(Math.PI / 4, 0, 0, "YXZ"),
  );
  const delta = movement({ forward: true }, quaternion);

  assert.ok(delta.y > 0, "forward movement should rise when the camera looks upward");
  assert.ok(delta.z < 0, "forward movement should continue into the scene");
});

test("diagonal flight is normalized to the same speed as straight flight", () => {
  const straight = movement({ forward: true });
  const diagonal = movement({ forward: true, right: true });

  assert.ok(Math.abs(straight.length() - diagonal.length()) < 1e-12);
});

test("precision and boost modifiers provide distinct movement ranges", () => {
  const standard = getFlyCameraSpeed({ framingDistance: 10 });
  const precision = getFlyCameraSpeed({ framingDistance: 10, precision: true });
  const boost = getFlyCameraSpeed({ framingDistance: 10, boost: true });

  assert.ok(precision < standard);
  assert.ok(boost > standard);
  assert.equal(precision, standard * 0.18);
  assert.equal(boost, standard * 3.5);
});

test("mouse look clamps pitch before the camera can flip", () => {
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler(0, 0, 0, "YXZ");

  updateFlyLookQuaternion({ quaternion, euler, movementY: -100000 });
  euler.setFromQuaternion(quaternion, "YXZ");

  assert.ok(Math.abs(euler.x - FLY_MAX_PITCH) < 1e-10);
  assert.equal(euler.z, 0);
});
