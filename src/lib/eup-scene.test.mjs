import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import {
  MAX_SCENE_PROPS,
  duplicateSceneProp,
  heldPropOffset,
  normalizeSceneProp,
  normalizeSceneProps,
  normalizeYaw,
  placeSceneProp,
  removeSceneProp,
  restoreSceneProp,
  scenePropLabel,
  scenePropModelKey,
  uprightYaw,
  watchedScenePropPaths,
} from "./eup-scene.js";
import { propAttachmentMatrix } from "./ped-pose.js";

const cone = (id, position = [0, 0, 0], extra = {}) => ({ id, source: "game", name: "prop_roadcone02a", position, yaw: 0, ...extra });

test("older workspaces restore with an empty set", () => {
  assert.deepEqual(normalizeSceneProps(undefined), []);
  assert.deepEqual(normalizeSceneProps(null), []);
  assert.deepEqual(normalizeSceneProps({}), []);
  assert.deepEqual(normalizeSceneProps("props"), []);
});

test("normalizeSceneProp keeps game and file props and rejects what names no model", () => {
  assert.deepEqual(normalizeSceneProp(cone("set-a", [1, 0.2, -0.5], { yaw: 90 })), {
    id: "set-a",
    source: "game",
    name: "prop_roadcone02a",
    path: "",
    hidden: false,
    position: [1, 0.2, -0.5],
    yaw: 90,
  });
  const file = normalizeSceneProp({ id: "set-b", source: "file", path: " C:\\Mods\\desk.YDR ", hidden: true });
  assert.equal(file.path, "C:\\Mods\\desk.YDR");
  assert.equal(file.name, "");
  assert.equal(file.hidden, true);
  assert.deepEqual(file.position, [0, 0, 0]);
  assert.equal(normalizeSceneProp({ source: "file", path: "C:\\Mods\\desk.ytd" }), null, "a texture dictionary is not a model");
  assert.equal(normalizeSceneProp({ source: "file", path: "C:\\a\u0000.ydr" }), null);
  assert.equal(normalizeSceneProp({ source: "game", name: "../prop" }), null);
  assert.equal(normalizeSceneProp({ source: "game", name: "" }), null);
  assert.equal(normalizeSceneProp(null), null);
  assert.equal(normalizeSceneProp({ source: "game", name: "PROP_Cone" }).name, "prop_cone", "game names are lower case");
});

test("placement is clamped, rounded and finite", () => {
  const prop = normalizeSceneProp(cone("x", [1e6, -1e6, Number.NaN], { yaw: -90 }));
  assert.deepEqual(prop.position, [50, -20, 0]);
  assert.equal(prop.yaw, 270);
  assert.deepEqual(normalizeSceneProp(cone("x", [0.123456789, "2", null])).position, [0.1235, 2, 0]);
  assert.equal(normalizeYaw(359.999), 0);
  assert.equal(normalizeYaw(720 + 45), 45);
  assert.equal(normalizeYaw("x"), 0);
});

test("normalizeSceneProps re-ids duplicates instead of dropping them and caps the set", () => {
  const list = normalizeSceneProps([cone("same"), cone("same"), { id: "bad id!", source: "game", name: "prop_a" }]);
  assert.deepEqual(list.map((prop) => prop.id), ["same", "same-2", "set-2"]);
  const many = Array.from({ length: MAX_SCENE_PROPS + 5 }, (_, i) => cone(`p-${i}`));
  assert.equal(normalizeSceneProps(many).length, MAX_SCENE_PROPS);
});

test("labels and model keys", () => {
  assert.equal(scenePropLabel(cone("a")), "prop_roadcone02a");
  assert.equal(scenePropLabel({ source: "file", path: "D:\\x\\y\\barrier.yft" }), "barrier.yft");
  assert.equal(scenePropModelKey(cone("a")), "game:prop_roadcone02a");
  assert.equal(scenePropModelKey({ source: "file", path: "D:\\b.ydr" }), "file:D:\\b.ydr");
});

test("new props stand in front of the cast, alternating sides, never on top of each other", () => {
  const first = placeSceneProp([], { castHalfWidth: 0.45 });
  assert.deepEqual(first, [0.8, 0, 0.35]);
  const list = [cone("a", first)];
  const second = placeSceneProp(list, { castHalfWidth: 0.45 });
  assert.deepEqual(second, [-0.8, 0, 0.35]);
  list.push(cone("b", second));
  const third = placeSceneProp(list, { castHalfWidth: 0.45 });
  assert.deepEqual(third, [1.4, 0, 0.35]);
  const wide = placeSceneProp([], { castHalfWidth: 0.95 });
  assert.equal(wide[0], 1.3, "two characters push the first prop further out");
  // A prop the user moved away frees its spot.
  assert.deepEqual(placeSceneProp([cone("a", [5, 0, 5])]), [0.8, 0, 0.35]);
});

test("duplicates land beside the original, shown, with the new id", () => {
  const original = normalizeSceneProp(cone("a", [1, 0.1, 0.35], { yaw: 30, hidden: true }));
  const copy = duplicateSceneProp(original, [original], "b");
  assert.equal(copy.id, "b");
  assert.equal(copy.hidden, false);
  assert.equal(copy.yaw, 30);
  assert.deepEqual(copy.position, [1.6, 0.1, 0.35]);
  const crowded = [original, cone("c", [1.6, 0, 0.35])];
  assert.deepEqual(duplicateSceneProp(original, crowded, "d").position, [2.2, 0.1, 0.35]);
});

test("removing a prop can be undone in place, once", () => {
  const list = normalizeSceneProps([cone("a"), cone("b"), cone("c")]);
  const { list: after, removed } = removeSceneProp(list, "b");
  assert.deepEqual(after.map((prop) => prop.id), ["a", "c"]);
  assert.deepEqual(removed, { prop: list[1], index: 1 });
  const restored = restoreSceneProp(after, removed);
  assert.deepEqual(restored.map((prop) => prop.id), ["a", "b", "c"]);
  assert.equal(restoreSceneProp(restored, removed), restored, "an id already back is not added twice");
  assert.equal(removeSceneProp(list, "zzz").removed, null);
  const full = Array.from({ length: MAX_SCENE_PROPS }, (_, i) => cone(`p-${i}`));
  assert.equal(restoreSceneProp(full, removed), full, "a full set refuses the undo");
});

test("uprightYaw drops tilt and keeps the turn", () => {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, THREE.MathUtils.degToRad(120), 0.2, "YXZ"));
  assert.ok(Math.abs(uprightYaw(q) - 120) < 0.01);
  const back = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(-45));
  assert.ok(Math.abs(uprightYaw(back) - 315) < 0.01);
});

// One bone posed somewhere awkward, so the offset has to undo a real transform.
function handSkeleton() {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, -1.1, 0.7));
  return {
    bones: [{
      tag: 28422,
      parentIndex: -1,
      tx: 0.3, ty: -0.2, tz: 1.1, qx: q.x, qy: q.y, qz: q.z, qw: q.w,
      worldTx: 0.3, worldTy: -0.2, worldTz: 1.1, worldQx: q.x, worldQy: q.y, worldQz: q.z, worldQw: q.w,
    }],
  };
}

test("heldPropOffset inverts propAttachmentMatrix", () => {
  const skeleton = handSkeleton();
  const bone = propAttachmentMatrix(skeleton, null, { bone: 28422, position: [0, 0, 0], rotation: [0, 0, 0] });
  const prop = { bone: 28422, position: [0.16, 0.08, 0.1], rotation: [-30, -50, 20] };
  const placed = propAttachmentMatrix(skeleton, null, prop);
  const offset = heldPropOffset(bone, placed);
  assert.deepEqual(offset.position, prop.position);
  offset.rotation.forEach((value, i) => assert.ok(Math.abs(value - prop.rotation[i]) < 0.01, `axis ${i}`));
});

test("heldPropOffset round-trips any orientation, even as different angles", () => {
  const skeleton = handSkeleton();
  const bone = propAttachmentMatrix(skeleton, null, { bone: 28422, position: [0, 0, 0], rotation: [0, 0, 0] });
  // An emote menu's clipboard placement: X past 90 degrees comes back as an equivalent triple.
  const prop = { bone: 28422, position: [0.16, 0.08, 0.1], rotation: [-130, -50, 0] };
  const placed = propAttachmentMatrix(skeleton, null, prop);
  const offset = heldPropOffset(bone, placed);
  const again = propAttachmentMatrix(skeleton, null, { bone: 28422, ...offset });
  placed.elements.forEach((value, i) => assert.ok(Math.abs(value - again.elements[i]) < 1e-3, `element ${i}`));
});


test("live reload watches every file prop except a missing one, also while it reloads", () => {
  const props = [
    cone("game"),
    { id: "a", source: "file", path: "D:/set/desk.ydr", position: [0, 0, 0], yaw: 0 },
    { id: "b", source: "file", path: "F:/set/barrier.ydr", position: [1, 0, 0], yaw: 0 },
    { id: "c", source: "file", path: "D:/set/gone.ydr", position: [2, 0, 0], yaw: 0 },
    { id: "d", source: "file", path: "D:/set/broken.ydr", position: [3, 0, 0], yaw: 0 },
  ];
  const states = { a: { status: "loading" }, b: { status: "ready" }, c: { status: "missing" }, d: { status: "error" } };
  assert.deepEqual(watchedScenePropPaths(props, states), ["D:/set/desk.ydr", "F:/set/barrier.ydr", "D:/set/broken.ydr"]);
  // Before the first load reports anything, the file is watched already.
  assert.deepEqual(watchedScenePropPaths(props.slice(1, 2), {}), ["D:/set/desk.ydr"]);
  assert.deepEqual(watchedScenePropPaths(null, states), []);
});
