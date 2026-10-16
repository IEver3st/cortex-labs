// A model's user orientation: quarter turns the user applied on top of the
// orientation the loader gave it, stored as a quaternion [x, y, z, w] (null is
// the loader's orientation). The rotation is applied to the viewer's model
// wrapper, whose own orientation is identity, so it never compounds with the
// GTA up-axis conversion inside it.

import * as THREE from "three";

const AXES = Object.freeze({
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
});

// Quarter turns only produce components in {0, ±1/2, ±1/√2, ±1}; snapping
// keeps repeated turns from drifting and makes four turns return to null.
const SNAP_VALUES = [0, 0.5, Math.SQRT1_2, 1];
const SNAP_EPSILON = 1e-6;

function snap(value) {
  const magnitude = Math.abs(value);
  for (const candidate of SNAP_VALUES) {
    if (Math.abs(magnitude - candidate) < SNAP_EPSILON) return Math.sign(value) * candidate;
  }
  return value;
}

function toArray(quaternion) {
  const q = quaternion.clone().normalize();
  // q and -q are the same rotation; keep one so saved values compare equal.
  const flip = q.w < 0 || (q.w === 0 && (q.x < 0 || (q.x === 0 && (q.y < 0 || (q.y === 0 && q.z < 0)))));
  const values = [q.x, q.y, q.z, q.w].map((value) => snap(flip ? -value : value) + 0);
  const identity = values[0] === 0 && values[1] === 0 && values[2] === 0;
  return identity ? null : values;
}

/** A saved rotation, or null for anything that is not a finite unit quaternion. */
export function normalizeModelRotation(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  if (!value.every((component) => typeof component === "number" && Number.isFinite(component))) return null;
  const length = Math.hypot(...value);
  if (Math.abs(length - 1) > 1e-3) return null;
  return toArray(new THREE.Quaternion().fromArray(value));
}

/** `rotation` turned a further 90 degrees about the model's own `axis`. */
export function quarterTurn(rotation, axis) {
  const vector = AXES[axis];
  const current = new THREE.Quaternion().fromArray(normalizeModelRotation(rotation) || [0, 0, 0, 1]);
  if (!vector) return normalizeModelRotation(rotation);
  const turn = new THREE.Quaternion().setFromAxisAngle(vector, Math.PI / 2);
  return toArray(current.multiply(turn));
}

/**
 * Turns `model` to `rotation` and stands it back on the floor, centred, the
 * way the loader placed it. `measure(model)` returns the model's bounds in its
 * parent's space (the viewer measures with the turntable at rest).
 */
export function orientModel(model, rotation, measure) {
  if (!model) return null;
  model.quaternion.fromArray(normalizeModelRotation(rotation) || [0, 0, 0, 1]);
  model.position.set(0, 0, 0);
  model.updateMatrixWorld(true);
  const bounds = measure ? measure(model) : new THREE.Box3().setFromObject(model);
  if (!bounds || bounds.isEmpty()) return null;
  const center = bounds.getCenter(new THREE.Vector3());
  if (![center.x, center.z, bounds.min.y].every(Number.isFinite)) return null;
  model.position.set(-center.x, -bounds.min.y, -center.z);
  model.updateMatrixWorld(true);
  return bounds.translate(model.position);
}
