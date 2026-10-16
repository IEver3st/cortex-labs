// EUP Studio set: props placed on the floor around the characters (cones,
// barriers, a desk), and the inverse of a held prop's bone attachment so the
// viewfinder gizmo can write its offsets back. Pure helpers shared by
// EupPage and Node tests.
//
// A set prop is `{ id, source: "game" | "file", name, path, hidden,
// position: [x, lift, z], yaw }` in stage metres and degrees. The floor is
// y = 0, where the page settles the characters' feet; `lift` raises the
// model's lowest point off it. The characters face +Z.

import * as THREE from "three";

export const MAX_SCENE_PROPS = 24;
export const SCENE_PROP_EXTENSIONS = Object.freeze(["ydr", "ydd", "yft"]);

const POSITION_LIMIT = 50;
const LIFT_LIMIT = 20;
const MODEL_NAME = /^[a-z0-9_-]{1,128}$/;
const ID_PATTERN = /^[a-z0-9-]{1,40}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

// New props stand just in front of the cast, alternating right and left of
// it and stepping outward, so nothing spawns inside a character or another prop.
const PLACE_GAP = 0.35;
const PLACE_STEP = 0.6;
const PLACE_DEPTH = 0.35;
const PLACE_CLEAR = 0.45;

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor || 0;
}

function clamp(value, min, max, fallback) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function baseName(path) {
  return String(path || "").split(/[\\/]/).pop() || "";
}

function modelName(value) {
  const name = typeof value === "string" ? value.trim().toLowerCase() : "";
  return MODEL_NAME.test(name) ? name : "";
}

function modelPath(value) {
  const path = typeof value === "string" ? value.trim() : "";
  if (!path || path.length > 1024 || CONTROL.test(path)) return "";
  const extension = path.split(".").pop()?.toLowerCase();
  return SCENE_PROP_EXTENSIONS.includes(extension) ? path : "";
}

/** Degrees in [0, 360), to two decimals. */
export function normalizeYaw(value) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return 0;
  return round(((number % 360) + 360) % 360, 2) % 360;
}

/** One set prop, or null when it names no usable model. */
export function normalizeSceneProp(value, index = 0) {
  if (!value || typeof value !== "object") return null;
  const source = value.source === "file" ? "file" : "game";
  const name = source === "game" ? modelName(value.name) : "";
  const path = source === "file" ? modelPath(value.path) : "";
  if (!name && !path) return null;
  const position = Array.isArray(value.position) ? value.position : [];
  return {
    id: typeof value.id === "string" && ID_PATTERN.test(value.id) ? value.id : `set-${index}`,
    source,
    name,
    path,
    hidden: value.hidden === true,
    position: [
      round(clamp(position[0], -POSITION_LIMIT, POSITION_LIMIT, 0), 4),
      round(clamp(position[1], -LIFT_LIMIT, LIFT_LIMIT, 0), 4),
      round(clamp(position[2], -POSITION_LIMIT, POSITION_LIMIT, 0), 4),
    ],
    yaw: normalizeYaw(value.yaw),
  };
}

/**
 * The set from a saved workspace. Older workspaces have none. A repeated id
 * gets a new one rather than dropping the prop; past the cap, props are left out.
 */
export function normalizeSceneProps(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const item of value) {
    if (result.length >= MAX_SCENE_PROPS) break;
    const prop = normalizeSceneProp(item, result.length);
    if (!prop) continue;
    let id = prop.id;
    for (let n = 2; seen.has(id); n += 1) id = `${prop.id.slice(0, 32)}-${n}`;
    seen.add(id);
    result.push(id === prop.id ? prop : { ...prop, id });
  }
  return result;
}

export function scenePropLabel(prop) {
  return prop?.source === "file" ? baseName(prop.path) : prop?.name || "";
}

/** Identity of a set prop's model; placement and visibility change without a reload. */
export function scenePropModelKey(prop) {
  return prop?.source === "file" ? `file:${prop.path}` : `game:${prop?.name || ""}`;
}

/**
 * The file props live reload watches: every one whose file isn't missing. A
 * prop stays watched while it loads or reloads after a save, and after a
 * failed load, so fixing the file and saving it loads it again.
 */
export function watchedScenePropPaths(props, states) {
  return (Array.isArray(props) ? props : [])
    .filter((prop) => prop?.source === "file" && prop.path && states?.[prop.id]?.status !== "missing")
    .map((prop) => prop.path);
}

function isFree(list, x, z, skipId = null) {
  return list.every((prop) => prop.id === skipId
    || Math.hypot((prop.position?.[0] ?? 0) - x, (prop.position?.[2] ?? 0) - z) >= PLACE_CLEAR);
}

/**
 * Where a new prop stands: in front of the cast, beside it, clear of the
 * props already placed. `castHalfWidth` is how far the cast reaches from the
 * stage centre along X.
 */
export function placeSceneProp(existing, { castHalfWidth = 0.45 } = {}) {
  const list = Array.isArray(existing) ? existing : [];
  for (let step = 0; step < 64; step += 1) {
    const reach = castHalfWidth + PLACE_GAP + Math.floor(step / 2) * PLACE_STEP;
    const x = round(step % 2 === 0 ? reach : -reach, 3);
    if (Math.abs(x) <= POSITION_LIMIT && isFree(list, x, PLACE_DEPTH)) return [x, 0, PLACE_DEPTH];
  }
  return [0, 0, round(Math.min(POSITION_LIMIT, PLACE_DEPTH + 1 + list.length * PLACE_STEP), 3)];
}

/** A copy of `prop` under `id`, shown, beside the original and clear of the rest. */
export function duplicateSceneProp(prop, existing, id) {
  const list = Array.isArray(existing) ? existing : [];
  const [x, lift, z] = prop.position;
  let position = [x, lift, Math.min(POSITION_LIMIT, z + PLACE_STEP)];
  for (let step = 1; step < 64; step += 1) {
    const candidate = x + step * PLACE_STEP;
    if (Math.abs(candidate) > POSITION_LIMIT) break;
    if (isFree(list, candidate, z)) {
      position = [candidate, lift, z];
      break;
    }
  }
  return normalizeSceneProp({ ...prop, id, hidden: false, position });
}

/** The list without `id`, and what was removed (for Undo). */
export function removeSceneProp(list, id) {
  const index = list.findIndex((prop) => prop.id === id);
  if (index < 0) return { list, removed: null };
  return { list: [...list.slice(0, index), ...list.slice(index + 1)], removed: { prop: list[index], index } };
}

/** Puts a removed prop back where it was. No-op when the set is full or the id is taken. */
export function restoreSceneProp(list, removed) {
  if (!removed?.prop || list.length >= MAX_SCENE_PROPS || list.some((prop) => prop.id === removed.prop.id)) return list;
  const index = Math.min(Math.max(0, Math.trunc(removed.index) || 0), list.length);
  return [...list.slice(0, index), removed.prop, ...list.slice(index)];
}

const YAW_EULER = new THREE.Euler();

/** The turn about +Y of a rotation, in degrees, dropping any tilt. */
export function uprightYaw(quaternion) {
  YAW_EULER.setFromQuaternion(quaternion, "YXZ");
  return normalizeYaw(THREE.MathUtils.radToDeg(YAW_EULER.y));
}

/**
 * A held prop's FiveM offset from where it sits: `boneMatrix` is the bone's
 * transform in ped space (propAttachmentMatrix with a zero offset) and
 * `matrix` the prop's. Returns `{ position, rotation }` in metres and
 * degrees in the game's rotation order (Y, then X, then Z about the bone),
 * the inverse of propAttachmentMatrix. The rotation may come back as a
 * different but equivalent set of angles.
 */
export function heldPropOffset(boneMatrix, matrix) {
  const offset = boneMatrix.clone().invert().multiply(matrix);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  offset.decompose(position, quaternion, new THREE.Vector3());
  const euler = new THREE.Euler().setFromQuaternion(quaternion, "ZXY");
  return {
    position: position.toArray().map((value) => round(value, 4)),
    rotation: [euler.x, euler.y, euler.z].map((value) => round(THREE.MathUtils.radToDeg(value), 2)),
  };
}
