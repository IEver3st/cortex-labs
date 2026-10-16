// Invisible lamp blockers, as GSD's "emiblocker" vehicles build them: a small
// closed box around a lamp, a `vehicle_badges` mesh whose diffuse is fully
// transparent. It draws nothing, yet the game still writes its depth, so the
// lamp stays hidden until a mod kit part's turnOffBones removes the box.
// native-materials turns such a mesh into a depth-only occluder; the bloom
// pre-pass in viewer-render-effects draws it again with the same offset.

import * as THREE from "three";
import { classifyNativeShaderProfile } from "./native-material-plan.js";

// After every opaque native bucket, before the light rig's lit overlays (10+).
export const DEPTH_ONLY_RENDER_ORDER = 9;

// A blank `<prefix>_sign_N` is "no livery": a decal over whole body panels
// that a livery pick fills in. Occluding with it would hide flat decals and
// lens overlays on those panels, so it stays an ordinary transparent decal.
const LIVERY_SIGN_TEXTURE = /_sign_\d+$/i;

// Vertices closer than this (metres) are one corner when testing for a closed
// box. Bridge meshes split corners per face normal and UV; blocker boxes sit
// 1-3 mm outside their lens, well clear of it.
const WELD_TOLERANCE = 1e-4;
// Two coincident sheets wound against each other pair every edge yet enclose
// nothing; a real blocker box encloses at least a cubic millimetre.
const MIN_BLOCKER_VOLUME = 1e-9;

/**
 * True when every triangle edge of `geometry` meets a neighbour wound the
 * other way and the surface encloses volume: one or more closed boxes.
 * Blank badge sheets (window decal templates, unused sticker slots) are open
 * and must stay transparent, or every lamp behind the glass disappears.
 */
export function isClosedSurface(geometry) {
  const position = geometry?.getAttribute?.("position");
  if (!position || position.count < 4) return false;
  const index = geometry.index;
  const count = index ? index.count : position.count;
  const corners = new Map();
  const weld = new Int32Array(position.count);
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    const key = `${Math.round(position.getX(vertex) / WELD_TOLERANCE)},${Math.round(position.getY(vertex) / WELD_TOLERANCE)},${Math.round(position.getZ(vertex) / WELD_TOLERANCE)}`;
    if (!corners.has(key)) corners.set(key, corners.size);
    weld[vertex] = corners.get(key);
  }
  // Undirected edge -> (a->b uses) - (b->a uses); a closed oriented surface nets zero.
  const edges = new Map();
  const corner = [0, 0, 0];
  const vertices = [0, 0, 0];
  let volume = 0;
  let triangles = 0;
  for (let offset = 0; offset + 2 < count; offset += 3) {
    for (let side = 0; side < 3; side += 1) {
      vertices[side] = index ? index.getX(offset + side) : offset + side;
      corner[side] = weld[vertices[side]];
    }
    if (corner[0] === corner[1] || corner[1] === corner[2] || corner[0] === corner[2]) continue;
    triangles += 1;
    for (let side = 0; side < 3; side += 1) {
      const a = corner[side];
      const b = corner[(side + 1) % 3];
      const key = a < b ? a * corners.size + b : b * corners.size + a;
      edges.set(key, (edges.get(key) || 0) + (a < b ? 1 : -1));
    }
    const [i, j, k] = vertices;
    const ax = position.getX(i), ay = position.getY(i), az = position.getZ(i);
    const bx = position.getX(j), by = position.getY(j), bz = position.getZ(j);
    const cx = position.getX(k), cy = position.getY(k), cz = position.getZ(k);
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  if (triangles < 4) return false;
  for (const balance of edges.values()) if (balance !== 0) return false;
  return Math.abs(volume) >= MIN_BLOCKER_VOLUME;
}

/**
 * Whether a mesh makes a lamp blocker: a badge shader on the decal profile, a
 * fully transparent diffuse (native-dds probes only small textures, 64x64 or
 * less), no livery sign texture, and closed box geometry. Decal shaders,
 * livery signs and open blank sheets are left alone.
 */
export function isLampBlocker(nativeMaterial, binding, texture, geometry) {
  if (!texture?.userData?.fullyTransparent) return false;
  const shaderName = typeof nativeMaterial?.shaderName === "string" ? nativeMaterial.shaderName.toLowerCase() : "";
  if (!shaderName.includes("badge") || classifyNativeShaderProfile(nativeMaterial) !== "decal") return false;
  const textureName = typeof binding?.textureName === "string" ? binding.textureName.trim() : "";
  if (LIVERY_SIGN_TEXTURE.test(textureName)) return false;
  return isClosedSurface(geometry);
}

// Drawn after the opaque body, the box hides only the lens and glow inside.
// Boxes sit a millimetre or two outside the lens, so the box is pulled further
// toward the camera than the light rig's glow overlays (-1/-1) pull a lens.
export function makeDepthOnlyOccluder(material, mesh) {
  material.colorWrite = false;
  material.transparent = false;
  material.depthWrite = true;
  material.alphaTest = 0;
  material.polygonOffset = true;
  material.polygonOffsetFactor = -2;
  material.polygonOffsetUnits = -2;
  material.side = THREE.DoubleSide;
  material.map = null;
  material.userData.nativeDepthOnly = true;
  mesh.userData.nativeDepthOnly = true;
  mesh.renderOrder = Math.max(mesh.renderOrder || 0, DEPTH_ONLY_RENDER_ORDER);
  mesh.castShadow = false;
}

/** Puts back the mesh flags an occluder changed, when the native view goes. */
export function releaseDepthOnlyOccluder(mesh) {
  if (!mesh) return;
  // applyShadowFlags keeps both flags equal; only cast was changed.
  mesh.castShadow = mesh.receiveShadow;
  mesh.renderOrder = mesh.userData?.nativeMaterial?.renderBucket || 0;
  if (mesh.userData) delete mesh.userData.nativeDepthOnly;
}
