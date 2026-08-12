import * as THREE from "three";

export const FLY_LOOK_SENSITIVITY = 0.002;
export const FLY_MAX_PITCH = Math.PI / 2 - 0.01;

export function getFlyCameraSpeed({
  framingDistance = 4,
  boost = false,
  precision = false,
} = {}) {
  const resolvedDistance = Number.isFinite(framingDistance)
    ? Math.abs(framingDistance)
    : 4;
  const baseSpeed = Math.max(resolvedDistance * 0.6, 0.12);
  const boostFactor = boost ? 3.5 : 1;
  const precisionFactor = precision ? 0.18 : 1;
  return baseSpeed * boostFactor * precisionFactor;
}

export function updateFlyMovementVector({
  target,
  forward,
  right,
  quaternion,
  state,
  framingDistance,
  deltaSeconds,
}) {
  target.set(0, 0, 0);
  if (!quaternion || !state) return target;

  forward.set(0, 0, -1).applyQuaternion(quaternion).normalize();
  right.set(1, 0, 0).applyQuaternion(quaternion).normalize();

  if (state.forward) target.add(forward);
  if (state.back) target.addScaledVector(forward, -1);
  if (state.right) target.add(right);
  if (state.left) target.addScaledVector(right, -1);
  if (state.up) target.y += 1;
  if (state.down) target.y -= 1;

  if (target.lengthSq() === 0) return target;

  const delta = THREE.MathUtils.clamp(
    Number.isFinite(deltaSeconds) ? deltaSeconds : 0,
    0,
    0.05,
  );
  const speed = getFlyCameraSpeed({
    framingDistance,
    boost: state.boost,
    precision: state.precision,
  });
  return target.normalize().multiplyScalar(speed * delta);
}

export function updateFlyLookQuaternion({
  quaternion,
  euler,
  movementX = 0,
  movementY = 0,
  sensitivity = FLY_LOOK_SENSITIVITY,
}) {
  euler.setFromQuaternion(quaternion, "YXZ");
  euler.y -= movementX * sensitivity;
  euler.x -= movementY * sensitivity;
  euler.x = THREE.MathUtils.clamp(euler.x, -FLY_MAX_PITCH, FLY_MAX_PITCH);
  euler.z = 0;
  quaternion.setFromEuler(euler);
  return quaternion;
}
