import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import {
  TURNTABLE_DEFAULT_SPEED,
  TURNTABLE_MAX_SPEED,
  normalizeTurntableSpeed,
  stepTurntable,
  withTurntableAtRest,
  wrapYaw,
} from "./turntable.js";

test("a spinning turntable turns at its speed and stays wrapped", () => {
  const { yaw, moving } = stepTurntable(0, { on: true, speed: 90, seconds: 0.05 });
  assert.ok(moving);
  assert.ok(Math.abs(yaw - THREE.MathUtils.degToRad(4.5)) < 1e-9);
  const lap = stepTurntable(Math.PI - 0.01, { on: true, speed: 90, seconds: 0.05 });
  assert.ok(lap.yaw < 0 && lap.yaw > -Math.PI, "passes PI into the negative half");
});

test("a long frame gap does not jump the vehicle", () => {
  const { yaw } = stepTurntable(0, { on: true, speed: 20, seconds: 30 });
  assert.ok(Math.abs(yaw - THREE.MathUtils.degToRad(2)) < 1e-9, "one step is capped at 0.1 s");
});

test("switched off, it eases home the short way and then rests", () => {
  let state = { yaw: wrapYaw(THREE.MathUtils.degToRad(300)), moving: true };
  assert.ok(state.yaw < 0, "300 degrees goes home through 360, not back through 180");
  let frames = 0;
  while (state.moving && frames < 600) {
    const next = stepTurntable(state.yaw, { on: false, seconds: 1 / 60 });
    assert.ok(Math.abs(next.yaw) <= Math.abs(state.yaw), "never overshoots");
    state = next;
    frames += 1;
  }
  assert.equal(state.yaw, 0);
  assert.equal(state.moving, false);
  assert.ok(frames < 120, "home within two seconds");
  assert.deepEqual(stepTurntable(0, { on: false, seconds: 1 / 60 }), { yaw: 0, moving: false });
});

test("speed is clamped and unreadable speeds fall back to the default", () => {
  assert.equal(normalizeTurntableSpeed("fast"), TURNTABLE_DEFAULT_SPEED);
  assert.equal(normalizeTurntableSpeed(1000), TURNTABLE_MAX_SPEED);
  assert.equal(normalizeTurntableSpeed(-5) > 0, true);
});

test("measuring at rest sees the unspun vehicle and restores the spin", () => {
  const table = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 6));
  table.add(body);
  table.rotation.y = Math.PI / 2;
  table.updateMatrixWorld(true);
  const spun = new THREE.Box3().setFromObject(body).getSize(new THREE.Vector3());
  assert.ok(Math.abs(spun.x - 6) < 1e-6);
  const rest = withTurntableAtRest([table], () => new THREE.Box3().setFromObject(body).getSize(new THREE.Vector3()));
  assert.ok(Math.abs(rest.x - 2) < 1e-6 && Math.abs(rest.z - 6) < 1e-6);
  assert.equal(table.rotation.y, Math.PI / 2);
  assert.ok(body.matrixWorld.elements[0] < 1e-6, "world matrices are back to the spun pose");
});
