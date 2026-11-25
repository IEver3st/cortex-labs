// Ped Bone Attachment Studio helpers for Prop Studio: persisted offset/bone
// state, FiveM snippet formatting (AttachEntityToEntity, ox_lib, rpemotes, qb),
// and snippet parsing so devs can tweak offsets visually and paste them back.

import * as THREE from "three";
import { DEFAULT_PROP_BONE, PROP_ATTACH_BONES, parseEmoteSnippet } from "./ped-pose.js";

export { DEFAULT_PROP_BONE, PROP_ATTACH_BONES };

export const ATTACH_SNIPPET_FORMATS = Object.freeze([
  { id: "native", label: "FiveM Native" },
  { id: "ox_lib", label: "ox_lib" },
  { id: "rpemotes", label: "rpemotes" },
  { id: "qb", label: "QB / QBX" },
]);

export const ATTACH_POSES = Object.freeze([
  { id: "idle", label: "Standing" },
  { id: "bind", label: "A-pose" },
  { id: "phone", label: "Holding / phone" },
  { id: "belt", label: "Hands on belt" },
  { id: "clasped", label: "Guard" },
  { id: "binoculars", label: "Two-handed aim" },
  { id: "chair", label: "Seated" },
]);

const POSITION_LIMIT = 2;
const ROTATION_LIMIT = 180;

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function normalizeVec3(value, limit) {
  const list = Array.isArray(value) ? value : [];
  return [0, 1, 2].map((i) => clamp(list[i], -limit, limit, 0));
}

function fmtNum(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) < 1e-6) return "0.0";
  const text = n.toFixed(decimals).replace(/\.?0+$/, "");
  return text.includes(".") ? text : `${text}.0`;
}

function cleanModelName(modelName) {
  const stem = String(modelName || "")
    .split(/[\\/]/)
    .pop()
    .replace(/\.[^.]+$/, "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_");
  return stem || "custom_prop";
}

export function normalizePropAttachState(value) {
  const source = value && typeof value === "object" ? value : {};
  const gender = source.gender === "female" ? "female" : "male";
  const pose = ATTACH_POSES.some((item) => item.id === source.pose) ? source.pose : "idle";
  const bone = Number.isInteger(source.bone) && source.bone >= 0 && source.bone <= 0xffff
    ? source.bone
    : DEFAULT_PROP_BONE;
  const format = ATTACH_SNIPPET_FORMATS.some((item) => item.id === source.format)
    ? source.format
    : "native";
  return {
    enabled: source.enabled === true,
    gender,
    pose,
    bone,
    position: normalizeVec3(source.position, POSITION_LIMIT),
    rotation: normalizeVec3(source.rotation, ROTATION_LIMIT),
    format,
  };
}

/** Formats ready-to-paste FiveM Lua attachment code in the selected convention. */
export function formatAttachSnippet({ modelName = "custom_prop", bone = DEFAULT_PROP_BONE, position = [0, 0, 0], rotation = [0, 0, 0], format = "native" } = {}) {
  const model = cleanModelName(modelName);
  const [x, y, z] = normalizeVec3(position, POSITION_LIMIT).map((n) => fmtNum(n, 4));
  const [rx, ry, rz] = normalizeVec3(rotation, ROTATION_LIMIT).map((n) => fmtNum(n, 2));
  const boneId = Number.isInteger(bone) ? bone : DEFAULT_PROP_BONE;

  if (format === "ox_lib") {
    return [
      `prop = {`,
      `    model = \`${model}\`,`,
      `    bone = ${boneId},`,
      `    pos = vec3(${x}, ${y}, ${z}),`,
      `    rot = vec3(${rx}, ${ry}, ${rz}),`,
      `},`,
    ].join("\n");
  }

  if (format === "rpemotes") {
    return [
      `Prop = '${model}',`,
      `PropBone = ${boneId},`,
      `PropPlacement = { ${x}, ${y}, ${z}, ${rx}, ${ry}, ${rz} },`,
    ].join("\n");
  }

  if (format === "qb") {
    return [
      `{`,
      `    model = '${model}',`,
      `    bone = ${boneId},`,
      `    coords = vec3(${x}, ${y}, ${z}),`,
      `    rotation = vec3(${rx}, ${ry}, ${rz}),`,
      `}`,
    ].join("\n");
  }

  return [
    `local prop = CreateObject(\`${model}\`, 0.0, 0.0, 0.0, true, true, false)`,
    `AttachEntityToEntity(`,
    `    prop, ped, GetPedBoneIndex(ped, ${boneId}),`,
    `    ${x}, ${y}, ${z}, ${rx}, ${ry}, ${rz},`,
    `    true, true, false, true, 2, true`,
    `)`,
  ].join("\n");
}

const VEC3 = String.raw`vec3\s*\(\s*(-?\d+(?:\.\d+)?|-?\.\d+)\s*,\s*(-?\d+(?:\.\d+)?|-?\.\d+)\s*,\s*(-?\d+(?:\.\d+)?|-?\.\d+)\s*\)`;
const NUM = String.raw`(-?\d+(?:\.\d+)?|-?\.\d+)`;
const PED_ARG = String.raw`(?:[^,()]|\([^()]*\))+`;

/**
 * Parses bone + position + rotation from a pasted FiveM snippet:
 * AttachEntityToEntity, rpemotes/dpemotes, ox_lib (`pos`/`rot`), or qb (`coords`/`rotation`).
 */
export function parseAttachSnippet(text) {
  const source = String(text || "").slice(0, 8000);
  if (!source.trim()) return null;

  const emote = parseEmoteSnippet(source);
  if (emote?.props?.length) {
    const first = emote.props[0];
    return {
      bone: first.bone,
      position: normalizeVec3(first.position, POSITION_LIMIT),
      rotation: normalizeVec3(first.rotation, ROTATION_LIMIT),
    };
  }

  // Handle bare AttachEntityToEntity(prop, ped, GetPedBoneIndex(ped, bone) | boneId, x, y, z, rx, ry, rz, ...)
  // even when no CreateObject(...) line was copied.
  const directAttach = new RegExp(
    String.raw`AttachEntityToEntity\s*\(\s*${PED_ARG},\s*${PED_ARG},\s*(?:GetPedBoneIndex\s*\(${PED_ARG},\s*(\d+)\s*\)|(\d+))\s*,\s*${Array(6).fill(NUM).join(String.raw`\s*,\s*`)}`,
    "i",
  ).exec(source);
  if (directAttach) {
    const bone = Number(directAttach[1] || directAttach[2]);
    return {
      ...(Number.isInteger(bone) && bone >= 0 && bone <= 0xffff ? { bone } : {}),
      position: normalizeVec3([Number(directAttach[3]), Number(directAttach[4]), Number(directAttach[5])], POSITION_LIMIT),
      rotation: normalizeVec3([Number(directAttach[6]), Number(directAttach[7]), Number(directAttach[8])], ROTATION_LIMIT),
    };
  }

  const bareAttach = new RegExp(
    String.raw`GetPedBoneIndex\s*\(${PED_ARG},\s*(\d+)\s*\)\s*,\s*${Array(6).fill(NUM).join(String.raw`\s*,\s*`)}`,
    "i",
  ).exec(source);
  if (bareAttach) {
    const bone = Number(bareAttach[1]);
    return {
      ...(Number.isInteger(bone) && bone >= 0 && bone <= 0xffff ? { bone } : {}),
      position: normalizeVec3([Number(bareAttach[2]), Number(bareAttach[3]), Number(bareAttach[4])], POSITION_LIMIT),
      rotation: normalizeVec3([Number(bareAttach[5]), Number(bareAttach[6]), Number(bareAttach[7])], ROTATION_LIMIT),
    };
  }

  const boneMatch = new RegExp(String.raw`\bbone\s*=\s*(\d+)|GetPedBoneIndex\s*\(${PED_ARG},\s*(\d+)\s*\)`, "i").exec(source);
  const posMatch = new RegExp(String.raw`\b(?:pos|coords)\s*=\s*${VEC3}`, "i").exec(source);
  const rotMatch = new RegExp(String.raw`\b(?:rot|rotation)\s*=\s*${VEC3}`, "i").exec(source);

  if (!boneMatch && !posMatch && !rotMatch) return null;
  const bone = boneMatch ? Number(boneMatch[1] || boneMatch[2]) : null;
  return {
    ...(Number.isInteger(bone) && bone >= 0 && bone <= 0xffff ? { bone } : {}),
    ...(posMatch ? { position: normalizeVec3([Number(posMatch[1]), Number(posMatch[2]), Number(posMatch[3])], POSITION_LIMIT) } : {}),
    ...(rotMatch ? { rotation: normalizeVec3([Number(rotMatch[1]), Number(rotMatch[2]), Number(rotMatch[3])], ROTATION_LIMIT) } : {}),
  };
}

/**
 * Inverse of ped-pose.js `propAttachmentMatrix`: converts a posed bone's matrix
 * and the prop slot's matrix (both in ped-root space) back into FiveM
 * `AttachEntityToEntity` `{ position: [x,y,z], rotation: [rx,ry,rz] }`
 * (metres and ZXY rotation-order-2 degrees).
 */
export function propLocalFromBoneMatrix(boneMatrix, slotMatrix) {
  if (!boneMatrix || !slotMatrix) return null;
  const invBone = boneMatrix.clone().invert();
  const offset = invBone.multiply(slotMatrix.clone());
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  offset.decompose(pos, quat, scale);
  const euler = new THREE.Euler().setFromQuaternion(quat, "ZXY");
  const radToDeg = 180 / Math.PI;
  const clampPos = (v) => Number(Math.max(-POSITION_LIMIT, Math.min(POSITION_LIMIT, v)).toFixed(4));
  const wrapDeg = (v) => {
    let d = v * radToDeg;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return Number(d.toFixed(1));
  };
  return {
    position: [clampPos(pos.x), clampPos(pos.y), clampPos(pos.z)],
    rotation: [wrapDeg(euler.x), wrapDeg(euler.y), wrapDeg(euler.z)],
  };
}
