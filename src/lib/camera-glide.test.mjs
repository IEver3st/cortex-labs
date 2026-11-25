import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createCameraGlide, easeOutCubic } from "./camera-glide.js";

function makeRig() {
  const camera = new THREE.PerspectiveCamera(40, 1.5, 0.1, 100);
  camera.position.set(0, 1, 5);
  let updates = 0;
  const controls = {
    target: new THREE.Vector3(0, 0.5, 0),
    update() {
      updates += 1;
      return false;
    },
    get updates() {
      return updates;
    },
  };
  return { camera, controls };
}

test("camera glide eases position, target and fov then settles cleanly", () => {
  const { camera, controls } = makeRig();
  let clock = 1000;
  let doneCount = 0;
  const glide = createCameraGlide({
    camera,
    controls,
    durationMs: 200,
    now: () => clock,
    reducedMotion: () => false,
  });

  const started = glide.to({
    position: new THREE.Vector3(10, 1, 5),
    target: new THREE.Vector3(2, 0.5, 0),
    fov: 60,
    onDone: () => { doneCount += 1; },
  });
  assert.equal(started, true);
  assert.equal(glide.active, true);

  clock = 1100; // halfway -> easeOutCubic(0.5) = 0.875
  assert.equal(glide.step(), true);
  assert.ok(Math.abs(camera.position.x - 10 * easeOutCubic(0.5)) < 1e-5);
  assert.ok(Math.abs(controls.target.x - 2 * easeOutCubic(0.5)) < 1e-5);
  assert.ok(Math.abs(camera.fov - (40 + 20 * easeOutCubic(0.5))) < 1e-5);
  assert.equal(doneCount, 0);

  clock = 1200;
  assert.equal(glide.step(), false);
  assert.equal(glide.active, false);
  assert.ok(Math.abs(camera.position.x - 10) < 1e-6);
  assert.ok(Math.abs(controls.target.x - 2) < 1e-6);
  assert.ok(Math.abs(camera.fov - 60) < 1e-6);
  assert.equal(doneCount, 1);
});

test("camera glide snaps immediately when reduced motion or instant is set", () => {
  const { camera, controls } = makeRig();
  const reduced = createCameraGlide({
    camera,
    controls,
    durationMs: 200,
    now: () => 0,
    reducedMotion: () => true,
  });
  assert.equal(reduced.to({ position: [3, 4, 5], target: [1, 2, 3], fov: 50 }), false);
  assert.equal(reduced.active, false);
  assert.deepEqual(camera.position.toArray(), [3, 4, 5]);
  assert.deepEqual(controls.target.toArray(), [1, 2, 3]);
  assert.equal(camera.fov, 50);

  const normal = createCameraGlide({
    camera,
    controls,
    durationMs: 200,
    now: () => 0,
    reducedMotion: () => false,
  });
  assert.equal(normal.to({ position: [0, 0, 1], target: [0, 0, 0], instant: true }), false);
  assert.equal(normal.active, false);
  assert.deepEqual(camera.position.toArray(), [0, 0, 1]);
});

test("cancel stops glide in place so manual orbit takes over without snapping", () => {
  const { camera, controls } = makeRig();
  let clock = 0;
  let done = false;
  const glide = createCameraGlide({
    camera,
    controls,
    durationMs: 200,
    now: () => clock,
    reducedMotion: () => false,
  });
  glide.to({ position: [10, 1, 5], target: [0, 0.5, 0], onDone: () => { done = true; } });
  clock = 50;
  glide.step();
  const midX = camera.position.x;
  assert.ok(midX > 0 && midX < 10);

  glide.cancel();
  assert.equal(glide.active, false);
  clock = 300;
  assert.equal(glide.step(), false);
  assert.equal(camera.position.x, midX);
  assert.equal(done, false);
});

test("opposite-side 180-degree glide arcs around target instead of passing through it", () => {
  const { camera, controls } = makeRig();
  camera.position.set(0, 1, 5);
  controls.target.set(0, 1, 0);
  let clock = 0;
  const glide = createCameraGlide({
    camera,
    controls,
    durationMs: 200,
    now: () => clock,
    reducedMotion: () => false,
  });

  glide.to({ position: [0, 1, -5], target: [0, 1, 0] });
  // Sample mid-transition: radius from target must stay well clear of 0.
  clock = 40; // easeOutCubic(0.2) = 0.488 (right near the midpoint)
  glide.step();
  const dist = camera.position.distanceTo(controls.target);
  assert.ok(dist > 4.5, `expected orbital arc radius ~5, got ${dist}`);
  assert.ok(Math.abs(camera.position.x) > 1, "expected lateral arc around target");

  clock = 200;
  assert.equal(glide.step(), false);
  assert.ok(Math.abs(camera.position.z + 5) < 1e-5);
});
