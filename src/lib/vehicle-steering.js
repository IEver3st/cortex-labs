import * as THREE from "three";

// Bridge meshes stay in GTA vehicle space: +X right, +Y forward, +Z up.
const STEERING_AXIS = new THREE.Vector3(0, 0, 1);
// Wheel drawables, plus body geometry the bridge split off the front hub and
// wheel bones (brake calipers, rotors), which turns with the wheel.
const STEERED_PARTS = new Set(["wheel", "hub"]);
const FRONT_BONE = /^(?:wheel|hub)_(lf|rf)$/;

function steeringSide(mesh) {
  const native = mesh.isMesh ? mesh.userData?.nativeMaterial : null;
  if (!STEERED_PARTS.has(native?.part)) return null;
  return FRONT_BONE.exec(native.partName || "")?.[1] || null;
}

/** Meshes that turn with the front wheels, every LOD included. */
export function getSteerableWheelMeshes(object) {
  const meshes = [];
  object?.traverse?.((child) => {
    if (steeringSide(child)) meshes.push(child);
  });
  return meshes;
}

/**
 * Hub pivot per front side, taken from the wheel drawable. The bridge exports
 * it as partOrigin; caches written before that field existed fall back to the
 * centre of the wheel's geometry, which sits within millimetres of the hub.
 * Brake parts never define the pivot: a caliper's centre is not the hub.
 */
function resolveWheelPivots(meshes) {
  const pivots = new Map();
  const bounds = new Map();
  for (const mesh of meshes) {
    const { part, partOrigin } = mesh.userData.nativeMaterial;
    if (part !== "wheel") continue;
    const side = steeringSide(mesh);
    if (Array.isArray(partOrigin) && partOrigin.length === 3) {
      pivots.set(side, new THREE.Vector3().fromArray(partOrigin));
      continue;
    }
    const geometry = mesh.geometry;
    if (!geometry?.attributes?.position) continue;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (!bounds.has(side)) bounds.set(side, new THREE.Box3());
    bounds.get(side).union(geometry.boundingBox);
  }
  for (const [side, box] of bounds) {
    if (!pivots.has(side) && !box.isEmpty()) pivots.set(side, box.getCenter(new THREE.Vector3()));
  }
  return pivots;
}

export function clampSteeringAngle(degrees, lockDegrees) {
  const value = Number(degrees);
  const lock = Math.abs(Number(lockDegrees));
  if (!Number.isFinite(value) || !Number.isFinite(lock)) return 0;
  return Math.min(lock, Math.max(-lock, value));
}

/**
 * Turns the front wheels about their hubs. Positive degrees steer right,
 * negative steer left, both wheels by the same angle. Returns the mesh count.
 */
export function applyFrontWheelSteering(object, degrees) {
  const meshes = getSteerableWheelMeshes(object);
  if (!meshes.length) return 0;
  const pivots = resolveWheelPivots(meshes);
  const rotation = new THREE.Quaternion().setFromAxisAngle(STEERING_AXIS, THREE.MathUtils.degToRad(-(Number(degrees) || 0)));
  let count = 0;
  for (const mesh of meshes) {
    const pivot = pivots.get(steeringSide(mesh));
    if (!pivot) continue;
    mesh.quaternion.copy(rotation);
    mesh.position.copy(pivot).sub(pivot.clone().applyQuaternion(rotation));
    mesh.updateMatrix();
    count += 1;
  }
  return count;
}
