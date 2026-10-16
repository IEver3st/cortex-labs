import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import {
  CUSTOM_POSE,
  DEFAULT_PROP_BONE,
  MAX_HELD_PROPS,
  PED_BONE_TAGS,
  clipGroundSpeed,
  customAnimationKey,
  heldPropModelKey,
  normalizeCustomAnimation,
  normalizeHeldProps,
  parseEmoteSnippet,
  propAttachmentMatrix,
  computeBoneRotations,
  computePosedBoneMatrix,
  isValidClip,
  normalizePoseId,
  poseClip,
  sampleClipPose,
} from "./ped-pose.js";

// Root turned half a turn about Z like the freemode bind skeleton, a pelvis,
// a thigh with its roll bone beside it, and a hand far down the chain.
function bone(tag, parentIndex, t, q = [0, 0, 0, 1]) {
  return { tag, parentIndex, tx: t[0], ty: t[1], tz: t[2], qx: q[0], qy: q[1], qz: q[2], qw: q[3],
    worldTx: t[0], worldTy: t[1], worldTz: t[2], worldQx: q[0], worldQy: q[1], worldQz: q[2], worldQw: q[3] };
}
const SKELETON = {
  bones: [
    bone(PED_BONE_TAGS.root, 0xffff, [0, 0, 0], [0, 0, 1, 0]),
    bone(PED_BONE_TAGS.pelvis, 0, [0, 0, 1]),
    bone(PED_BONE_TAGS.lThigh, 1, [0.1, 0, 0]),
    bone(PED_BONE_TAGS.lThighRoll, 1, [0.1, 0, 0]),
    bone(PED_BONE_TAGS.lHand, 2, [0, 0, -0.5]),
  ],
};

const HALF_X = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);

// Two samples: the thigh goes from rest to a quarter turn about X.
const CLIP = {
  duration: 1,
  sampleRate: 1,
  samples: 2,
  rotations: [
    { bone: PED_BONE_TAGS.root, values: [0, 0, 0, 1, 0, 0, 0, 1] },
    { bone: PED_BONE_TAGS.lThigh, values: [0, 0, 0, 1, ...HALF_X.toArray()] },
  ],
  translations: [{ bone: PED_BONE_TAGS.root, values: [0.2, 0, 0, 0.2, 0, 0] }],
  moverVelocity: [0, -1.5, 0],
};

test("sampleClipPose interpolates bone rotations and copies thigh rolls", () => {
  const { rotations } = sampleClipPose(SKELETON, CLIP, 0.5);
  const expected = new THREE.Quaternion().slerp(HALF_X, 0.5);
  assert.ok(rotations.get(2).angleTo(expected) < 1e-6, "halfway between the two samples");
  assert.ok(rotations.get(3).angleTo(expected) < 1e-6, "the roll bone follows its thigh");
  assert.equal(rotations.has(4), false, "bones without a track keep their bind rotation");
});

test("sampleClipPose keeps the bind root turn under the clip's root motion", () => {
  const { rotations, translations } = sampleClipPose(SKELETON, CLIP, 0);
  assert.ok(rotations.get(0).angleTo(new THREE.Quaternion(0, 0, 1, 0)) < 1e-6);
  const t = translations.get(0);
  assert.ok(t.distanceTo(new THREE.Vector3(-0.2, 0, 0)) < 1e-6, "root translation turns with the root");
});

test("sampleClipPose wraps time so loops never run off the end", () => {
  const early = sampleClipPose(SKELETON, CLIP, 0.25).rotations.get(2);
  const wrapped = sampleClipPose(SKELETON, CLIP, 1.25).rotations.get(2);
  assert.ok(early.angleTo(wrapped) < 1e-6);
});

test("malformed clips are rejected instead of half-applied", () => {
  assert.equal(isValidClip(CLIP), true);
  assert.equal(isValidClip({ ...CLIP, samples: 3 }), false, "track lengths must match the sample count");
  assert.equal(isValidClip({ ...CLIP, duration: 0 }), false);
  assert.equal(isValidClip({ ...CLIP, rotations: [{ bone: "x", values: [] }] }), false);
  assert.equal(sampleClipPose(SKELETON, { ...CLIP, samples: 3 }, 0).rotations.size, 0);
  assert.equal(sampleClipPose(null, CLIP, 0).rotations.size, 0);
});

test("pose ids map to per-gender game clips and old ids fall back", () => {
  assert.equal(poseClip("bind", "male"), null);
  assert.deepEqual(poseClip("walk", "male"), { dict: "move_m@generic", clip: "walk" });
  assert.deepEqual(poseClip("walk", "female"), { dict: "move_f@generic", clip: "walk" });
  assert.equal(normalizePoseId("hips"), "idle");
  assert.equal(normalizePoseId("crossed"), "crossed");
  assert.equal(clipGroundSpeed(CLIP), 1.5);
  assert.equal(clipGroundSpeed({}), 0);
});

test("posed bone matrices follow clip rotations and translations down the chain", () => {
  const pose = sampleClipPose(SKELETON, CLIP, 0.999);
  const hand = new THREE.Vector3().setFromMatrixPosition(computePosedBoneMatrix(SKELETON, pose, 4));
  // The thigh's quarter turn about X swings the hand from straight down to
  // along Y; the root's half turn about Z then flips X and Y.
  assert.ok(Math.abs(hand.z - 1) < 0.01, "the hand rises to hip height");
  assert.ok(Math.abs(Math.abs(hand.y) - 0.5) < 0.01, "and swings out along Y");
  const bind = new THREE.Vector3().setFromMatrixPosition(computePosedBoneMatrix(SKELETON, null, 4));
  assert.ok(Math.abs(bind.z - 0.5) < 1e-6, "no pose keeps the bind chain");
  assert.equal(computeBoneRotations(SKELETON, [{ bone: "lThigh", axis: [1, 0, 0], deg: 90 }]).size, 1);
});

test("custom animations keep a game clip or a picked .ycd and reject paths as names", () => {
  assert.equal(normalizePoseId(CUSTOM_POSE), CUSTOM_POSE);
  assert.deepEqual(
    normalizeCustomAnimation({ source: "game", dict: " Amb@World_Human_Clipboard@Male@Base ", clip: "base" }),
    { source: "game", dict: "amb@world_human_clipboard@male@base", clip: "base" },
  );
  assert.equal(normalizeCustomAnimation({ source: "game", dict: "../x", clip: "base" }), null);
  assert.equal(normalizeCustomAnimation({ source: "game", dict: "a..b", clip: "base" }), null);
  assert.deepEqual(
    normalizeCustomAnimation({ source: "file", path: "C:/anims/salute.YCD", clip: "Salute Loop" }),
    { source: "file", path: "C:/anims/salute.YCD", clip: "Salute Loop" },
  );
  assert.equal(normalizeCustomAnimation({ source: "file", path: "C:/anims/salute.ydr", clip: "x" }), null);
  assert.equal(customAnimationKey({ source: "game", dict: "cellphone@", clip: "" }), "", "no clip chosen yet");
  assert.equal(customAnimationKey({ source: "game", dict: "cellphone@", clip: "text" }), "game:cellphone@/text");
});

test("held props are bounded, deduplicated and default to the right hand", () => {
  const props = normalizeHeldProps([
    { id: "a", source: "game", name: "Prop_NPC_Phone_02", position: [0.1, 99, "x"], rotation: [720, -10, 5] },
    { id: "a", source: "game", name: "p_amb_coffeecup_01" },
    { source: "game", name: "../evil" },
    { source: "file", path: "C:/props/badge.ydr", bone: 24818 },
    ...Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, source: "game", name: `prop_${i}` })),
  ]);
  assert.equal(props.length, MAX_HELD_PROPS);
  assert.deepEqual(props[0], {
    id: "a", source: "game", name: "prop_npc_phone_02", path: "", bone: DEFAULT_PROP_BONE,
    position: [0.1, 5, 0], rotation: [360, -10, 5],
  });
  assert.equal(props[1].source, "file");
  assert.equal(props[1].bone, 24818);
  assert.equal(heldPropModelKey(props[1]), "file:C:/props/badge.ydr");
});

test("emote lines yield the clip and its props", () => {
  const emote = parseEmoteSnippet(
    `["clipboard"] = {"missfam4", "base", "Clipboard", AnimationOptions = { Prop = 'p_amb_clipboard_01', PropBone = 36029, PropPlacement = {0.16, 0.08, 0.1, -130.0, -50.0, 0.0}, EmoteLoop = true }},`,
  );
  assert.equal(emote.dict, "missfam4");
  assert.equal(emote.clip, "base");
  assert.deepEqual(emote.props, [
    { source: "game", name: "p_amb_clipboard_01", bone: 36029, position: [0.16, 0.08, 0.1], rotation: [-130, -50, 0] },
  ]);

  const two = parseEmoteSnippet(
    `{"missheistdockssetup1clipboard@base", "base", "Notepad", AnimationOptions = { Prop = 'prop_notepad_01', PropBone = 18905, PropPlacement = {0.1, 0.02, 0.05, 10.0, 0.0, 0.0}, SecondProp = 'prop_pencil_01', SecondPropBone = 58866, SecondPropPlacement = {0.11, -0.02, 0.001, -120.0, 0.0, 0.0} }}`,
  );
  assert.deepEqual(two.props.map((prop) => [prop.name, prop.bone]), [["prop_notepad_01", 18905], ["prop_pencil_01", 58866]]);

  const native = parseEmoteSnippet(`
    local prop = CreateObject(GetHashKey("prop_npc_phone_02"), 0.0, 0.0, 0.0, true, true, true)
    AttachEntityToEntity(prop, ped, GetPedBoneIndex(ped, 28422), 0.0, -0.01, 0.02, 10.0, 0.0, 90.0, true, true, false, true, 1, true)
    TaskPlayAnim(ped, "cellphone@", "cellphone_text_read_base", 8.0, -8.0, -1, 49, 0, false, false, false)
  `);
  assert.equal(native.dict, "cellphone@");
  assert.equal(native.clip, "cellphone_text_read_base");
  assert.deepEqual(native.props[0], { source: "game", name: "prop_npc_phone_02", bone: 28422, position: [0, -0.01, 0.02], rotation: [10, 0, 90] });

  assert.equal(parseEmoteSnippet("hello there"), null);
  assert.equal(parseEmoteSnippet(""), null);
});

test("a held prop follows its bone with the offset in bone space", () => {
  const hand = { bone: PED_BONE_TAGS.lHand, position: [0, 0, -0.1], rotation: [0, 0, 90] };
  // Unposed, the bone's bind world transform is used (this fixture's hand sits
  // at z = -0.5, unrotated); the offset hangs 10 cm lower and turns 90 degrees.
  const bind = propAttachmentMatrix(SKELETON, null, hand);
  const at = new THREE.Vector3().setFromMatrixPosition(bind);
  assert.ok(Math.abs(at.z + 0.6) < 1e-6, `bind z ${at.z}`);
  const forward = new THREE.Vector3(1, 0, 0).transformDirection(bind);
  assert.ok(Math.abs(forward.y - 1) < 1e-6, `prop X axis ${forward.toArray()}`);

  const posed = propAttachmentMatrix(SKELETON, sampleClipPose(SKELETON, CLIP, 0.999), hand);
  const raised = new THREE.Vector3().setFromMatrixPosition(posed);
  assert.ok(raised.z > 0.95, "the prop rises with the posed hand");
  assert.equal(propAttachmentMatrix(SKELETON, null, { ...hand, bone: 12345 }), null, "missing bones attach nothing");
});
