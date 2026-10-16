// Ped poses for EUP Studio: the game's bind pose or a GTA V animation clip.
//
// Clips are exported by the CodeWalker bridge as fixed-rate samples of each
// bone's local rotation (and, for a few bones, translation), keyed by bone tag.
// sampleClipPose turns a sample time into local transforms per skeleton index
// that a three.js rig or computePosedBoneMatrix can apply directly.

import * as THREE from "three";

export const PED_BONE_TAGS = Object.freeze({
  root: 0x0,
  pelvis: 0x2e28,
  lThigh: 0xe39f,
  rThigh: 0xca72,
  lThighRoll: 0x5c57,
  rThighRoll: 0x192a,
  head: 0x796e,
  lUpperArm: 0xb1c5,
  lForearm: 0xeeeb,
  lHand: 0x49d9,
  rUpperArm: 0x9d4d,
  rForearm: 0x6e5c,
  rHand: 0xdead,
});

// Roll bones are driven by expressions in game, which the preview does not
// run. Like CodeWalker, the thigh roll bones (siblings of the thighs under the
// pelvis) copy their thigh so the hips do not pinch.
const COPY_ROTATION = new Map([
  [PED_BONE_TAGS.lThighRoll, PED_BONE_TAGS.lThigh],
  [PED_BONE_TAGS.rThighRoll, PED_BONE_TAGS.rThigh],
]);

/**
 * Poses offered in EUP Studio. Each clip is `[dictionary, clip]`, chosen per
 * ped where the game has gender-specific versions. `walk` loops in place.
 */
export const PED_POSES = Object.freeze([
  { id: "bind", label: "A-pose" },
  { id: "idle", label: "Idle", male: ["move_m@generic", "idle"], female: ["move_f@generic", "idle"] },
  { id: "walk", label: "Walk", male: ["move_m@generic", "walk"], female: ["move_f@generic", "walk"], walk: true },
  {
    id: "belt",
    label: "Hands on belt",
    male: ["amb@world_human_cop_idles@male@base", "base"],
    female: ["amb@world_human_cop_idles@female@base", "base"],
  },
  {
    id: "crossed",
    label: "Arms crossed",
    male: ["anim@heists@heist_corona@single_team", "single_team_loop_boss"],
    female: ["amb@world_human_hang_out_street@female_arms_crossed@base", "base"],
  },
  {
    id: "clasped",
    label: "Hands clasped",
    male: ["amb@world_human_stand_guard@male@base", "base"],
    female: ["amb@world_human_stand_guard@male@base", "base"],
  },
]);

export const DEFAULT_PED_POSE = "idle";

/** The pose id for a clip the user chose: any game dictionary, or their own .ycd. */
export const CUSTOM_POSE = "custom";

export function normalizePoseId(value) {
  return value === CUSTOM_POSE || PED_POSES.some((pose) => pose.id === value) ? value : DEFAULT_PED_POSE;
}

/** `{ dict, clip }` for a pose and gender, or null for the bind pose. */
export function poseClip(poseId, gender) {
  const pose = PED_POSES.find((item) => item.id === poseId);
  const pair = pose?.[gender === "female" ? "female" : "male"];
  return pair ? { dict: pair[0], clip: pair[1] } : null;
}

// Game dictionary and clip names, matching the Rust and bridge validators.
const GAME_NAME = /^[a-z0-9_@.-]{1,128}$/;
const MODEL_NAME = /^[a-z0-9_-]{1,128}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function gameName(value, pattern = GAME_NAME) {
  const name = typeof value === "string" ? value.trim().toLowerCase() : "";
  return pattern.test(name) && !name.includes("..") ? name : "";
}

function fileClipName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  return name && name.length <= 128 && !CONTROL.test(name) ? name : "";
}

function filePath(value, extensions) {
  const path = typeof value === "string" ? value.trim() : "";
  const lower = path.toLowerCase();
  return path && extensions.some((ext) => lower.endsWith(`.${ext}`)) ? path : "";
}

/**
 * The clip behind the Custom pose: `{ source: "game", dict, clip }` or
 * `{ source: "file", path, clip }`. `clip` may be empty while the user is
 * still choosing one. Returns null for anything unusable.
 */
export function normalizeCustomAnimation(value) {
  if (!value || typeof value !== "object") return null;
  if (value.source === "file") {
    const path = filePath(value.path, ["ycd"]);
    return path ? { source: "file", path, clip: fileClipName(value.clip) } : null;
  }
  const dict = gameName(value.dict);
  if (!dict) return null;
  return { source: "game", dict, clip: gameName(value.clip) };
}

/** Cache key for a custom animation, or "" until it names a clip. */
export function customAnimationKey(animation) {
  if (!animation?.clip) return "";
  return animation.source === "file" ? `file:${animation.path}\n${animation.clip}` : `game:${animation.dict}/${animation.clip}`;
}

/**
 * Bones a prop can hang from, by the tag FiveM scripts pass to
 * GetPedBoneIndex. The PH_ bones are the game's own prop-holding points.
 */
export const PROP_ATTACH_BONES = Object.freeze([
  { tag: 28422, label: "Right hand prop (PH_R_Hand)" },
  { tag: 60309, label: "Left hand prop (PH_L_Hand)" },
  { tag: 57005, label: "Right hand (SKEL_R_Hand)" },
  { tag: 18905, label: "Left hand (SKEL_L_Hand)" },
  { tag: 6286, label: "Right hand IK (IK_R_Hand)" },
  { tag: 36029, label: "Left hand IK (IK_L_Hand)" },
  { tag: 31086, label: "Head (SKEL_Head)" },
  { tag: 24818, label: "Chest (SKEL_Spine3)" },
  { tag: 11816, label: "Pelvis (SKEL_Pelvis)" },
]);

export const DEFAULT_PROP_BONE = 28422;
export const MAX_HELD_PROPS = 4;
const MAX_PROP_OFFSET = 5;

function finiteIn(value, limit) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(limit, Math.max(-limit, number)) : 0;
}

function vector3(value, limit) {
  const list = Array.isArray(value) ? value : [];
  return [0, 1, 2].map((i) => finiteIn(list[i], limit));
}

/**
 * One prop held by the ped: a game drawable by name or a model file, hung
 * from `bone` (a bone tag) with a FiveM-style offset in metres and rotation
 * in degrees.
 */
export function normalizeHeldProp(value, index = 0) {
  if (!value || typeof value !== "object") return null;
  const source = value.source === "file" ? "file" : "game";
  const name = source === "game" ? gameName(value.name, MODEL_NAME) : "";
  const path = source === "file" ? filePath(value.path, ["ydr", "ydd", "yft"]) : "";
  if (!name && !path) return null;
  const bone = Number.isInteger(value.bone) && value.bone >= 0 && value.bone <= 0xffff ? value.bone : DEFAULT_PROP_BONE;
  const id = typeof value.id === "string" && value.id ? value.id.slice(0, 40) : `prop-${index}`;
  return {
    id,
    source,
    name,
    path,
    bone,
    position: vector3(value.position, MAX_PROP_OFFSET),
    rotation: vector3(value.rotation, 360),
  };
}

export function normalizeHeldProps(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const item of value) {
    const prop = normalizeHeldProp(item, result.length);
    if (!prop || seen.has(prop.id)) continue;
    seen.add(prop.id);
    result.push(prop);
    if (result.length >= MAX_HELD_PROPS) break;
  }
  return result;
}

/** Identity of a held prop's model; offsets and bones change without a reload. */
export function heldPropModelKey(prop) {
  return prop?.source === "file" ? `file:${prop.path}` : `game:${prop?.name || ""}`;
}

const NUMBER = String.raw`(-?\d+(?:\.\d+)?|-?\.\d+)`;

function placementAfter(text, key) {
  const match = new RegExp(String.raw`\b${key}\s*=\s*\{([^}]*)\}`).exec(text);
  if (!match) return null;
  const values = match[1].split(",").map((part) => Number(part.trim()));
  return values.length >= 6 && values.slice(0, 6).every(Number.isFinite) ? values.slice(0, 6) : null;
}

function quotedAfter(text, key) {
  return new RegExp(String.raw`\b${key}\s*=\s*["'\`]([^"'\`]+)["'\`]`).exec(text)?.[1] || "";
}

function integerAfter(text, key) {
  const match = new RegExp(String.raw`\b${key}\s*=\s*(\d+)`).exec(text);
  return match ? Number(match[1]) : null;
}

/**
 * Reads an animation and its props from a line of FiveM script: an emote menu
 * entry (`{"dict", "clip", "Label", AnimationOptions = { Prop = ..., PropBone
 * = ..., PropPlacement = {...} }}`, with SecondProp), a TaskPlayAnim call, or
 * an AttachEntityToEntity call with GetPedBoneIndex. Returns
 * `{ dict, clip, props }`, with empty fields for what the text lacks, or null
 * when it names nothing usable.
 */
export function parseEmoteSnippet(text) {
  const source = typeof text === "string" ? text.slice(0, 8000) : "";
  if (!source.trim()) return null;
  // Emote tables key entries as ["name"] = {...}; the key is not the dictionary.
  const body = source.replace(/^\s*\[\s*["'][^"']*["']\s*\]\s*=/, "");
  const STR = String.raw`["'\`]([^"'\`\n]{1,160})["'\`]`;
  let dict = "";
  let clip = "";
  // A TaskPlayAnim call names the pair outright; otherwise take the first two
  // quoted names separated only by a comma, as emote entries list them.
  const candidates = [
    ...body.matchAll(new RegExp(String.raw`TaskPlayAnim\s*\([^,()]+,\s*${STR}\s*,\s*${STR}`, "g")),
    ...body.matchAll(new RegExp(String.raw`${STR}\s*,\s*${STR}`, "g")),
  ];
  for (const match of candidates) {
    const a = gameName(match[1]);
    const b = gameName(match[2]);
    if (a && b) {
      dict = a;
      clip = b;
      break;
    }
  }

  const props = [];
  const addProp = (name, bone, placement) => {
    const model = gameName(name, MODEL_NAME);
    if (!model) return;
    props.push({
      source: "game",
      name: model,
      bone: Number.isInteger(bone) ? bone : DEFAULT_PROP_BONE,
      position: placement ? placement.slice(0, 3) : [0, 0, 0],
      rotation: placement ? placement.slice(3, 6) : [0, 0, 0],
    });
  };
  addProp(quotedAfter(body, "Prop"), integerAfter(body, "PropBone"), placementAfter(body, "PropPlacement"));
  addProp(quotedAfter(body, "SecondProp"), integerAfter(body, "SecondPropBone"), placementAfter(body, "SecondPropPlacement"));

  if (!props.length) {
    const attach = new RegExp(
      String.raw`GetPedBoneIndex\s*\([^,()]+,\s*(\d+)\s*\)\s*,\s*${Array(6).fill(NUMBER).join(String.raw`\s*,\s*`)}`,
    ).exec(body);
    const model = /(?:GetHashKey|joaat)\s*\(\s*["'`]([^"'`]+)["'`]\s*\)|`([a-z0-9_-]+)`/i.exec(body);
    if (attach && model) {
      const values = attach.slice(2, 8).map(Number);
      addProp((model[1] || model[2] || "").toLowerCase(), Number(attach[1]), values);
    }
  }

  if (!dict && !props.length) return null;
  return { dict, clip, props: props.slice(0, MAX_HELD_PROPS) };
}

const PROP_EULER = new THREE.Euler();
const PROP_UNIT = new THREE.Vector3(1, 1, 1);

/**
 * Where a held prop sits in ped space: the bone's posed transform times the
 * offset, as AttachEntityToEntity places it. Rotation is in degrees, applied
 * Y, then X, then Z about the bone (the game's default rotation order 2).
 * Returns null when the skeleton has no bone with the prop's tag.
 */
export function propAttachmentMatrix(skeleton, pose, prop) {
  const bones = skeleton?.bones;
  if (!Array.isArray(bones) || !prop) return null;
  const index = bones.findIndex((bone) => bone.tag === prop.bone);
  if (index < 0) return null;
  const [x = 0, y = 0, z = 0] = prop.position || [];
  const [rx = 0, ry = 0, rz = 0] = prop.rotation || [];
  const toRad = THREE.MathUtils.degToRad;
  PROP_EULER.set(toRad(rx), toRad(ry), toRad(rz), "ZXY");
  const offset = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(PROP_EULER),
    PROP_UNIT,
  );
  const { rotations, translations } = poseParts(pose);
  const posed = (rotations?.size || 0) + (translations?.size || 0) > 0;
  const bone = bones[index];
  // Without a pose the bind world transform is exact, as ped props use it.
  const boneMatrix = posed || !Number.isFinite(bone.worldTx)
    ? computePosedBoneMatrix(skeleton, pose, index)
    : new THREE.Matrix4().compose(new THREE.Vector3(bone.worldTx, bone.worldTy, bone.worldTz), boneWorldQuaternion(bone), PROP_UNIT);
  return boneMatrix.multiply(offset);
}

function boneLocalQuaternion(bone) {
  return new THREE.Quaternion(bone.qx, bone.qy, bone.qz, bone.qw).normalize();
}

function boneWorldQuaternion(bone) {
  return new THREE.Quaternion(bone.worldQx, bone.worldQy, bone.worldQz, bone.worldQw).normalize();
}

/** Checks the shape of a bridge clip export before it is sampled. */
export function isValidClip(clip) {
  if (!clip || !Number.isInteger(clip.samples) || clip.samples < 2) return false;
  if (!(clip.duration > 0) || !(clip.sampleRate > 0)) return false;
  const ok = (tracks, width) =>
    Array.isArray(tracks) &&
    tracks.every((track) => Number.isInteger(track?.bone) && track.values?.length === clip.samples * width);
  return ok(clip.rotations, 4) && ok(clip.translations || [], 3);
}

/** Ground speed of a walk cycle in metres per second (0 for stationary clips). */
export function clipGroundSpeed(clip) {
  const [x = 0, y = 0] = Array.isArray(clip?.moverVelocity) ? clip.moverVelocity : [];
  const speed = Math.hypot(x, y);
  return Number.isFinite(speed) ? speed : 0;
}

/**
 * Local bone transforms at `time` seconds (wrapping). Returns
 * `{ rotations, translations }`, Maps of skeleton index -> Quaternion/Vector3;
 * bones the clip does not animate are absent and keep their bind transform.
 * The bind skeleton's root is turned half a turn relative to clip space, so
 * the clip's root transform is applied on top of it.
 */
export function sampleClipPose(skeleton, clip, time) {
  const rotations = new Map();
  const translations = new Map();
  const bones = skeleton?.bones;
  if (!Array.isArray(bones) || !isValidClip(clip)) return { rotations, translations };

  const span = clip.samples - 1;
  const position = (((time * clip.sampleRate) % span) + span) % span;
  const i0 = Math.floor(position);
  const i1 = Math.min(i0 + 1, span);
  const alpha = position - i0;

  const indexByTag = new Map();
  bones.forEach((bone, index) => {
    if (!indexByTag.has(bone.tag)) indexByTag.set(bone.tag, index);
  });

  const q0 = new THREE.Quaternion();
  const q1 = new THREE.Quaternion();
  const byTag = new Map();
  for (const track of clip.rotations) {
    const v = track.values;
    q0.set(v[i0 * 4], v[i0 * 4 + 1], v[i0 * 4 + 2], v[i0 * 4 + 3]);
    q1.set(v[i1 * 4], v[i1 * 4 + 1], v[i1 * 4 + 2], v[i1 * 4 + 3]);
    byTag.set(track.bone, q0.clone().slerp(q1, alpha).normalize());
  }
  for (const [roll, source] of COPY_ROTATION) {
    if (!byTag.has(roll) && byTag.has(source)) byTag.set(roll, byTag.get(source).clone());
  }

  const rootIndex = indexByTag.get(PED_BONE_TAGS.root);
  const rootBind = rootIndex === undefined ? new THREE.Quaternion() : boneLocalQuaternion(bones[rootIndex]);
  for (const [tag, rotation] of byTag) {
    const index = indexByTag.get(tag);
    if (index === undefined) continue;
    rotations.set(index, index === rootIndex ? rootBind.clone().multiply(rotation) : rotation);
  }

  for (const track of clip.translations || []) {
    const index = indexByTag.get(track.bone);
    if (index === undefined) continue;
    const v = track.values;
    const t = new THREE.Vector3(v[i0 * 3], v[i0 * 3 + 1], v[i0 * 3 + 2])
      .lerp(new THREE.Vector3(v[i1 * 3], v[i1 * 3 + 1], v[i1 * 3 + 2]), alpha);
    translations.set(index, index === rootIndex ? t.applyQuaternion(rootBind) : t);
  }
  return { rotations, translations };
}

/**
 * Local rotations for an explicit list of `{ bone, axis, deg }`, applied in
 * ped space at the bone's bind orientation. Used by tests and tools.
 */
export function computeBoneRotations(skeleton, list) {
  const result = new Map();
  const bones = skeleton?.bones;
  if (!Array.isArray(bones) || !Array.isArray(list)) return result;
  const deltas = new Map();
  for (const { bone, axis, deg } of list) {
    const tag = PED_BONE_TAGS[bone];
    const index = bones.findIndex((item) => item.tag === tag);
    if (index < 0) continue;
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis).normalize(), THREE.MathUtils.degToRad(deg));
    deltas.set(index, rotation.multiply(deltas.get(index) || new THREE.Quaternion()));
  }
  for (const [index, delta] of deltas) {
    const world = boneWorldQuaternion(bones[index]);
    const local = world.clone().invert().multiply(delta).multiply(world);
    result.set(index, boneLocalQuaternion(bones[index]).multiply(local).normalize());
  }
  return result;
}

function poseParts(pose) {
  if (pose instanceof Map) return { rotations: pose, translations: null };
  return { rotations: pose?.rotations || null, translations: pose?.translations || null };
}

/**
 * A bone's posed transform in ped space (the same space as the parsed bind
 * `world*` fields). `pose` is `{ rotations, translations }` or a rotation Map.
 */
export function computePosedBoneMatrix(skeleton, pose, index) {
  const bones = skeleton?.bones || [];
  const { rotations, translations } = poseParts(pose);
  const result = new THREE.Matrix4();
  const chain = [];
  const seen = new Set();
  for (let i = index; i >= 0 && i < bones.length && !seen.has(i); i = bones[i].parentIndex) {
    seen.add(i);
    chain.push(i);
  }
  const unit = new THREE.Vector3(1, 1, 1);
  const local = new THREE.Matrix4();
  for (let k = chain.length - 1; k >= 0; k--) {
    const bone = bones[chain[k]];
    const rotation = rotations?.get(chain[k]) || boneLocalQuaternion(bone);
    const translation = translations?.get(chain[k]) || new THREE.Vector3(bone.tx, bone.ty, bone.tz);
    local.compose(translation, rotation, unit);
    result.multiply(local);
  }
  return result;
}
