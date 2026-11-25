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
  { tag: 28252, label: "Right forearm (SKEL_R_Forearm)" },
  { tag: 61163, label: "Left forearm (SKEL_L_Forearm)" },
  { tag: 31086, label: "Head (SKEL_Head)" },
  { tag: 24818, label: "Chest (SKEL_Spine3)" },
  { tag: 11816, label: "Pelvis (SKEL_Pelvis)" },
  { tag: 51826, label: "Right thigh (SKEL_R_Thigh)" },
  { tag: 58271, label: "Left thigh (SKEL_L_Thigh)" },
  { tag: 36864, label: "Right calf (SKEL_R_Calf)" },
  { tag: 63931, label: "Left calf (SKEL_L_Calf)" },
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
  const PED_ARG = String.raw`(?:[^,()]|\([^()]*\))+`;
  const candidates = [
    ...body.matchAll(new RegExp(String.raw`TaskPlayAnim\s*\(${PED_ARG},\s*${STR}\s*,\s*${STR}`, "g")),
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
      String.raw`GetPedBoneIndex\s*\(${PED_ARG},\s*(\d+)\s*\)\s*,\s*${Array(6).fill(NUMBER).join(String.raw`\s*,\s*`)}`,
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
const IDENTITY_QUAT = Object.freeze(new THREE.Quaternion());
const ZERO_VEC = Object.freeze(new THREE.Vector3());
const SCRATCH_Q1 = new THREE.Quaternion();
const SCRATCH_PROP_POS = new THREE.Vector3();
const SCRATCH_PROP_QUAT = new THREE.Quaternion();
const SCRATCH_PROP_OFFSET = new THREE.Matrix4();
const SCRATCH_LOCAL_MAT = new THREE.Matrix4();

const validClipCache = new WeakMap();
const skeletonCache = new WeakMap();

function getSkeletonCache(skeleton) {
  const bones = skeleton?.bones;
  if (!Array.isArray(bones)) return null;
  let entry = skeletonCache.get(skeleton);
  if (entry && entry.bones === bones && entry.length === bones.length) return entry;

  const indexByTag = new Map();
  const bindQuats = new Array(bones.length);
  const bindPos = new Array(bones.length);
  for (let i = 0; i < bones.length; i += 1) {
    const b = bones[i];
    if (!indexByTag.has(b.tag)) indexByTag.set(b.tag, i);
    bindQuats[i] = new THREE.Quaternion(b.qx, b.qy, b.qz, b.qw).normalize();
    bindPos[i] = new THREE.Vector3(b.tx, b.ty, b.tz);
  }
  const rootIndex = indexByTag.get(PED_BONE_TAGS.root);
  const rootBind = rootIndex === undefined ? new THREE.Quaternion() : bindQuats[rootIndex];
  entry = {
    bones,
    length: bones.length,
    indexByTag,
    rootIndex,
    rootBind,
    bindQuats,
    bindPos,
    bindWorldQuats: new Array(bones.length),
    chains: new Array(bones.length),
    compiledClips: new WeakMap(),
  };
  skeletonCache.set(skeleton, entry);
  return entry;
}

/** O(1) bone index lookup by bone tag using the cached skeleton table. */
export function findBoneIndexByTag(skeleton, tag) {
  const cache = getSkeletonCache(skeleton);
  if (!cache) return -1;
  const idx = cache.indexByTag.get(tag);
  return idx === undefined ? -1 : idx;
}

function getBoneChain(cache, index) {
  let chain = cache.chains[index];
  if (chain) return chain;
  const bones = cache.bones;
  const rev = [];
  const seen = new Set();
  for (let i = index; Number.isInteger(i) && i >= 0 && i < bones.length && !seen.has(i); i = bones[i].parentIndex) {
    seen.add(i);
    rev.push(i);
  }
  // Store root-to-bone order so computePosedBoneMatrix walks forward.
  chain = new Int32Array(rev.length);
  for (let k = 0; k < rev.length; k += 1) chain[k] = rev[rev.length - 1 - k];
  cache.chains[index] = chain;
  return chain;
}

function getCompiledClip(cache, clip) {
  let compiled = cache.compiledClips.get(clip);
  if (compiled) return compiled;

  const { indexByTag, rootIndex } = cache;
  const rotByTag = new Map();
  for (let i = 0; i < clip.rotations.length; i += 1) {
    const track = clip.rotations[i];
    rotByTag.set(track.bone, track.values);
  }
  for (const [roll, source] of COPY_ROTATION) {
    if (!rotByTag.has(roll) && rotByTag.has(source)) rotByTag.set(roll, rotByTag.get(source));
  }
  const rotTracks = [];
  for (const [tag, values] of rotByTag) {
    const index = indexByTag.get(tag);
    if (index === undefined) continue;
    rotTracks.push({ index, values, isRoot: index === rootIndex });
  }

  const transByIndex = new Map();
  const srcTrans = clip.translations || [];
  for (let i = 0; i < srcTrans.length; i += 1) {
    const track = srcTrans[i];
    const index = indexByTag.get(track.bone);
    if (index === undefined) continue;
    transByIndex.set(index, track.values);
  }
  const transTracks = [];
  for (const [index, values] of transByIndex) {
    transTracks.push({ index, values, isRoot: index === rootIndex });
  }

  compiled = { rotTracks, transTracks };
  cache.compiledClips.set(clip, compiled);
  return compiled;
}

/**
 * Where a held prop sits in ped space: the bone's posed transform times the
 * offset, as AttachEntityToEntity places it. Rotation is in degrees, applied
 * Y, then X, then Z about the bone (the game's default rotation order 2).
 * Returns null when the skeleton has no bone with the prop's tag.
 */
export function propAttachmentMatrix(skeleton, pose, prop) {
  const cache = getSkeletonCache(skeleton);
  if (!cache || !prop) return null;
  const index = cache.indexByTag.get(prop.bone);
  if (index === undefined) return null;
  const pos = prop.position;
  const rot = prop.rotation;
  const x = pos?.[0] ?? 0;
  const y = pos?.[1] ?? 0;
  const z = pos?.[2] ?? 0;
  const rx = rot?.[0] ?? 0;
  const ry = rot?.[1] ?? 0;
  const rz = rot?.[2] ?? 0;
  const toRad = THREE.MathUtils.degToRad;
  PROP_EULER.set(toRad(rx), toRad(ry), toRad(rz), "ZXY");
  SCRATCH_PROP_POS.set(x, y, z);
  SCRATCH_PROP_QUAT.setFromEuler(PROP_EULER);
  SCRATCH_PROP_OFFSET.compose(SCRATCH_PROP_POS, SCRATCH_PROP_QUAT, PROP_UNIT);

  const { rotations, translations } = poseParts(pose);
  const posed = (rotations?.size || 0) + (translations?.size || 0) > 0;
  const bone = cache.bones[index];
  // Without a pose the bind world transform is exact, as ped props use it.
  let boneMatrix;
  if (posed || !Number.isFinite(bone.worldTx)) {
    boneMatrix = computePosedBoneMatrix(skeleton, pose, index);
  } else {
    let wq = cache.bindWorldQuats[index];
    if (!wq) {
      wq = boneWorldQuaternion(bone);
      cache.bindWorldQuats[index] = wq;
    }
    SCRATCH_PROP_POS.set(bone.worldTx, bone.worldTy, bone.worldTz);
    boneMatrix = new THREE.Matrix4().compose(SCRATCH_PROP_POS, wq, PROP_UNIT);
  }
  return boneMatrix.multiply(SCRATCH_PROP_OFFSET);
}

function boneLocalQuaternion(bone) {
  return new THREE.Quaternion(bone.qx, bone.qy, bone.qz, bone.qw).normalize();
}

function boneWorldQuaternion(bone) {
  return new THREE.Quaternion(bone.worldQx, bone.worldQy, bone.worldQz, bone.worldQw).normalize();
}

/** Checks the shape of a bridge clip export before it is sampled. */
export function isValidClip(clip) {
  if (!clip || typeof clip !== "object") return false;
  const cached = validClipCache.get(clip);
  if (cached !== undefined) return cached;
  let valid = false;
  if (Number.isInteger(clip.samples) && clip.samples >= 2 && clip.duration > 0 && clip.sampleRate > 0) {
    const ok = (tracks, width) =>
      Array.isArray(tracks) &&
      tracks.every((track) => Number.isInteger(track?.bone) && track.values?.length === clip.samples * width);
    valid = ok(clip.rotations, 4) && ok(clip.translations || [], 3);
  }
  validClipCache.set(clip, valid);
  return valid;
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
  const cache = getSkeletonCache(skeleton);
  if (!cache || !isValidClip(clip)) return { rotations, translations };

  const safeTime = Number.isFinite(time) ? time : 0;
  const span = clip.samples - 1;
  const position = (((safeTime * clip.sampleRate) % span) + span) % span;
  const i0 = Math.floor(position);
  const i1 = i0 < span ? i0 + 1 : span;
  const alpha = position - i0;
  const o0 = i0 * 4;
  const o1 = i1 * 4;
  const t0 = i0 * 3;
  const t1 = i1 * 3;

  const { rotTracks, transTracks } = getCompiledClip(cache, clip);
  const rootBind = cache.rootBind;

  for (let k = 0, n = rotTracks.length; k < n; k += 1) {
    const track = rotTracks[k];
    const v = track.values;
    const q = new THREE.Quaternion(v[o0], v[o0 + 1], v[o0 + 2], v[o0 + 3]);
    if (alpha > 0) {
      SCRATCH_Q1.set(v[o1], v[o1 + 1], v[o1 + 2], v[o1 + 3]);
      q.slerp(SCRATCH_Q1, alpha);
    }
    q.normalize();
    if (track.isRoot) q.premultiply(rootBind);
    rotations.set(track.index, q);
  }

  for (let k = 0, n = transTracks.length; k < n; k += 1) {
    const track = transTracks[k];
    const v = track.values;
    const vec = alpha > 0
      ? new THREE.Vector3(
        v[t0] + (v[t1] - v[t0]) * alpha,
        v[t0 + 1] + (v[t1 + 1] - v[t0 + 1]) * alpha,
        v[t0 + 2] + (v[t1 + 2] - v[t0 + 2]) * alpha,
      )
      : new THREE.Vector3(v[t0], v[t0 + 1], v[t0 + 2]);
    if (track.isRoot) vec.applyQuaternion(rootBind);
    translations.set(track.index, vec);
  }
  return { rotations, translations };
}

/**
 * Smoothly blends two poses (`fromPose` -> `toPose`) at factor `alpha` in [0, 1].
 * Missing bones in either pose (or a null bind pose) blend from/to the skeleton's
 * bind quaternion and position so pose transitions never snap.
 */
export function blendPoses(fromPose, toPose, alpha, skeleton) {
  const t = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1;
  if (t <= 0) return fromPose || null;
  if (t >= 1) return toPose || null;

  const from = poseParts(fromPose);
  const to = poseParts(toPose);
  const cache = getSkeletonCache(skeleton);
  const bindQuats = cache?.bindQuats || null;
  const bindPos = cache?.bindPos || null;

  const rotations = new Map();
  if (from.rotations) {
    for (const [idx, qa] of from.rotations) {
      const qb = to.rotations?.get(idx) || bindQuats?.[idx] || IDENTITY_QUAT;
      rotations.set(idx, qa.clone().slerp(qb, t).normalize());
    }
  }
  if (to.rotations) {
    for (const [idx, qb] of to.rotations) {
      if (rotations.has(idx)) continue;
      const qa = bindQuats?.[idx] || IDENTITY_QUAT;
      rotations.set(idx, qa.clone().slerp(qb, t).normalize());
    }
  }

  const translations = new Map();
  if (from.translations) {
    for (const [idx, ta] of from.translations) {
      const tb = to.translations?.get(idx) || bindPos?.[idx] || ZERO_VEC;
      translations.set(idx, ta.clone().lerp(tb, t));
    }
  }
  if (to.translations) {
    for (const [idx, tb] of to.translations) {
      if (translations.has(idx)) continue;
      const ta = bindPos?.[idx] || ZERO_VEC;
      translations.set(idx, ta.clone().lerp(tb, t));
    }
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
  const cache = getSkeletonCache(skeleton);
  const result = new THREE.Matrix4();
  if (!cache || index < 0 || index >= cache.length) return result;
  const { rotations, translations } = poseParts(pose);
  const chain = getBoneChain(cache, index);
  const { bindQuats, bindPos } = cache;
  for (let k = 0, n = chain.length; k < n; k += 1) {
    const idx = chain[k];
    const rotation = rotations?.get(idx) || bindQuats[idx];
    const translation = translations?.get(idx) || bindPos[idx];
    SCRATCH_LOCAL_MAT.compose(translation, rotation, PROP_UNIT);
    result.multiply(SCRATCH_LOCAL_MAT);
  }
  return result;
}
