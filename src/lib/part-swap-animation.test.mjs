import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  SWAP_ENTER_MS,
  SWAP_EXIT_MS,
  SWAP_HANDOFF_MS,
  createPartSwapAnimator,
  dropDistance,
  enterDelay,
  enterPose,
  exitPose,
} from "./part-swap-animation.js";

function vehicle() {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  scene.add(root);
  const body = new THREE.Mesh(new THREE.BoxGeometry(4, 1.5, 2), new THREE.MeshBasicMaterial());
  root.add(body);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 1.6), new THREE.MeshBasicMaterial());
  bar.position.set(2.2, 0, 0);
  root.add(bar);
  return { scene, root, body, bar };
}

function clock() {
  let time = 1000;
  return { now: () => time, advance: (ms) => { time += ms; } };
}

test("enter lands exactly at rest with a small dip below it", () => {
  assert.deepEqual(enterPose(0), { lift: 1, scale: 0.6 });
  assert.deepEqual(enterPose(1), { lift: 0, scale: 1 });
  assert.deepEqual(enterPose(2), { lift: 0, scale: 1 });
  let lowest = 0;
  for (let t = 0; t < 1; t += 0.01) lowest = Math.min(lowest, enterPose(t).lift);
  assert.ok(lowest < 0 && lowest > -0.06, `dip ${lowest}`);
  assert.ok(Math.abs(enterPose(0.999).lift) < 0.002);
});

test("exit hops, falls and shrinks to nothing", () => {
  assert.deepEqual(exitPose(0), { lift: 0, scale: 1 });
  assert.ok(exitPose(0.1).lift > 0);
  assert.ok(exitPose(1).lift < -1);
  assert.equal(exitPose(1).scale, 0);
  assert.deepEqual(exitPose(Number.NaN), exitPose(1));
});

test("stagger and drop distance stay bounded", () => {
  assert.equal(enterDelay(0), 0);
  assert.equal(enterDelay(0, { handoff: true }), SWAP_HANDOFF_MS);
  assert.equal(enterDelay(100), 360);
  assert.equal(dropDistance(0.5, 10), 0.6);
  assert.equal(dropDistance(0, 10), 0.5);
  assert.equal(dropDistance(50, 10), 2);
  assert.equal(dropDistance(1, Number.NaN), 0.2);
});

test("entering hides the real part until it lands, then restores its layers", () => {
  const { scene, root, bar } = vehicle();
  const time = clock();
  bar.layers.enable(5);
  const mask = bar.layers.mask;
  const animator = createPartSwapAnimator({ scene, now: time.now });
  let done = 0;
  assert.equal(animator.enter(bar, { anchor: root, onDone: () => { done += 1; } }), true);
  assert.equal(bar.layers.mask, 0);
  assert.equal(animator.container.children.length, 1);
  const ghost = animator.container.children[0];
  assert.equal(ghost.geometry, bar.geometry);
  assert.equal(ghost.material, bar.material);
  assert.equal(ghost.layers.mask, mask);

  assert.equal(animator.tick(), true);
  assert.equal(ghost.visible, true);
  const start = new THREE.Vector3().setFromMatrixPosition(ghost.matrix);
  assert.ok(start.y > 0.3, `starts above its place: ${start.y}`);

  time.advance(SWAP_ENTER_MS);
  assert.equal(animator.tick(), false);
  assert.equal(bar.layers.mask, mask);
  assert.equal(animator.container.children.length, 0);
  assert.equal(done, 1);
  // The real mesh was never moved.
  assert.deepEqual(bar.position.toArray(), [2.2, 0, 0]);
});

test("a delayed entry stays hidden until its turn", () => {
  const { scene, root, bar } = vehicle();
  const time = clock();
  const animator = createPartSwapAnimator({ scene, now: time.now });
  animator.enter(bar, { anchor: root, delay: 100 });
  animator.tick();
  assert.equal(animator.container.children[0].visible, false);
  time.advance(120);
  animator.tick();
  assert.equal(animator.container.children[0].visible, true);
});

test("an exit keeps shared resources alive until onDone and skips hidden meshes", () => {
  const { scene, root, bar } = vehicle();
  const hidden = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  hidden.visible = false;
  const group = new THREE.Group();
  group.add(bar, hidden);
  root.add(group);
  const time = clock();
  const animator = createPartSwapAnimator({ scene, now: time.now });
  let disposed = false;
  animator.exit(group, { anchor: root, onDone: () => { disposed = true; } });
  root.remove(group);
  assert.equal(animator.container.children.length, 1);
  animator.tick();
  assert.equal(disposed, false);
  time.advance(SWAP_EXIT_MS / 2);
  animator.tick();
  const ghost = animator.container.children[0];
  const position = new THREE.Vector3().setFromMatrixPosition(ghost.matrix);
  assert.ok(position.y < 0, `falling: ${position.y}`);
  time.advance(SWAP_EXIT_MS);
  animator.tick();
  assert.equal(disposed, true);
  assert.equal(animator.container.children.length, 0);
});

test("starting a new swap on a landing part settles the first one", () => {
  const { scene, root, bar } = vehicle();
  const time = clock();
  const animator = createPartSwapAnimator({ scene, now: time.now });
  const mask = bar.layers.mask;
  const calls = [];
  animator.enter(bar, { anchor: root, onDone: () => calls.push("enter") });
  animator.exit(bar, { anchor: root, onDone: () => calls.push("exit") });
  assert.deepEqual(calls, ["enter"]);
  assert.equal(bar.layers.mask, mask);
  animator.clear();
  assert.deepEqual(calls, ["enter", "exit"]);
  assert.equal(animator.active, false);
});

test("nothing to animate calls onDone at once", () => {
  const { scene, root } = vehicle();
  const animator = createPartSwapAnimator({ scene });
  let done = false;
  assert.equal(animator.exit(new THREE.Group(), { anchor: root, onDone: () => { done = true; } }), false);
  assert.equal(done, true);
  animator.dispose();
  assert.equal(scene.children.includes(animator.container), false);
});

test("several meshes swap as one part around their shared centre", () => {
  const { scene, root, body, bar } = vehicle();
  const time = clock();
  const animator = createPartSwapAnimator({ scene, now: time.now });
  assert.equal(animator.exit([body, bar], { anchor: root }), true);
  assert.equal(animator.container.children.length, 2);
  time.advance(SWAP_EXIT_MS * 0.6);
  animator.tick();
  const [a, b] = animator.container.children.map((ghost) => new THREE.Vector3().setFromMatrixPosition(ghost.matrix));
  // Both fall by the same amount; the shrink pulls them toward the shared centre.
  assert.ok(Math.abs(a.y - b.y) < 1e-9);
  assert.ok(b.x < 2.2);
});
