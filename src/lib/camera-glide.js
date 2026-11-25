// Smooth, interruptible camera preset transitions shared across Studio viewports.
// Interpolates camera position, OrbitControls target and optional FOV with a
// crisp cubic ease-out, immediately yielding to user orbit/zoom input and
// snapping when reduced motion is enabled or `instant: true` is passed.

import * as THREE from "three";
import { prefersReducedMotion } from "./part-swap-animation.js";

export const CAMERA_GLIDE_MS = 220;
const EPSILON_SQ = 1e-8;

export function easeOutCubic(t) {
  const u = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 1));
  return 1 - (1 - u) ** 3;
}

function isFiniteVec3(v) {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

export function createCameraGlide({
  camera,
  controls,
  durationMs = CAMERA_GLIDE_MS,
  now = () => performance.now(),
  reducedMotion = prefersReducedMotion,
} = {}) {
  const fromPos = new THREE.Vector3();
  const toPos = new THREE.Vector3();
  const fromTarget = new THREE.Vector3();
  const toTarget = new THREE.Vector3();
  const fromOffset = new THREE.Vector3();
  const toOffset = new THREE.Vector3();
  const arcAxis = new THREE.Vector3();
  const curOffset = new THREE.Vector3();
  const upFallback = new THREE.Vector3(0, 1, 0);
  let fromRadius = 0;
  let toRadius = 0;
  let arcAngle = 0;
  let useArc = false;
  let fromFov = null;
  let toFov = null;
  let startTime = 0;
  let duration = durationMs;
  let active = false;
  let finishCallback = null;

  const applyImmediate = (pos, target, fov, near, far, onDone) => {
    active = false;
    finishCallback = null;
    if (pos && isFiniteVec3(pos)) camera.position.copy(pos);
    if (target && isFiniteVec3(target)) controls.target.copy(target);
    let projDirty = false;
    if (Number.isFinite(near)) {
      camera.near = near;
      projDirty = true;
    }
    if (Number.isFinite(far)) {
      camera.far = far;
      projDirty = true;
    }
    if (Number.isFinite(fov) && Math.abs(camera.fov - fov) > 1e-4) {
      camera.fov = fov;
      projDirty = true;
    }
    if (projDirty) camera.updateProjectionMatrix();
    controls.update();
    onDone?.();
    return false;
  };

  return {
    get active() {
      return active;
    },

    /**
     * Glides (or snaps when `instant` / reduced-motion) the camera to `position`,
     * `target` and optional `fov`. Returns true while animating.
     */
    to({ position, target, fov = null, near = null, far = null, instant = false, duration: overrideMs = null, onDone = null } = {}) {
      if (!camera || !controls) return false;
      const nextPos = Array.isArray(position) ? toPos.fromArray(position) : position ? toPos.copy(position) : toPos.copy(camera.position);
      const nextTarget = Array.isArray(target) ? toTarget.fromArray(target) : target ? toTarget.copy(target) : toTarget.copy(controls.target);
      if (!isFiniteVec3(nextPos) || !isFiniteVec3(nextTarget)) return false;
      const nextFov = Number.isFinite(fov) ? fov : null;
      const ms = Number.isFinite(overrideMs) ? overrideMs : durationMs;

      if (instant || ms <= 0 || reducedMotion?.()) {
        return applyImmediate(nextPos, nextTarget, nextFov, near, far, onDone);
      }

      const posSame = camera.position.distanceToSquared(nextPos) <= EPSILON_SQ;
      const targetSame = controls.target.distanceToSquared(nextTarget) <= EPSILON_SQ;
      const fovSame = nextFov === null || Math.abs(camera.fov - nextFov) <= 1e-4;
      if (posSame && targetSame && fovSame) {
        return applyImmediate(nextPos, nextTarget, nextFov, near, far, onDone);
      }

      let projDirty = false;
      if (Number.isFinite(near)) {
        camera.near = near;
        projDirty = true;
      }
      if (Number.isFinite(far)) {
        camera.far = far;
        projDirty = true;
      }
      if (projDirty) camera.updateProjectionMatrix();

      fromPos.copy(camera.position);
      fromTarget.copy(controls.target);
      fromOffset.subVectors(fromPos, fromTarget);
      toOffset.subVectors(toPos, toTarget);
      fromRadius = fromOffset.length();
      toRadius = toOffset.length();
      useArc = false;
      if (fromRadius > 1e-4 && toRadius > 1e-4) {
        fromOffset.divideScalar(fromRadius);
        toOffset.divideScalar(toRadius);
        const dot = Math.max(-1, Math.min(1, fromOffset.dot(toOffset)));
        // Orbit around the subject on angular preset turns (>100°) so Front <-> Rear
        // never plunges through the middle of the model; smaller moves keep crisp lerp.
        if (dot < -0.17) {
          arcAngle = Math.acos(dot);
          arcAxis.crossVectors(fromOffset, toOffset);
          if (arcAxis.lengthSq() < 1e-6) {
            // 180° opposite: sweep cleanly around the camera's up axis.
            arcAxis.copy(camera.up && camera.up.lengthSq() > 1e-4 ? camera.up : upFallback).normalize();
            if (Math.abs(fromOffset.dot(arcAxis)) > 0.99) arcAxis.set(1, 0, 0);
          } else {
            arcAxis.normalize();
          }
          useArc = true;
        }
      }
      fromFov = camera.fov;
      toFov = nextFov;
      startTime = now();
      duration = ms;
      finishCallback = onDone || null;
      active = true;
      return true;
    },

    /** Advances the active glide at `time` ms. Returns true while still moving. */
    step(time = now()) {
      if (!active) return false;
      const raw = duration > 0 ? (time - startTime) / duration : 1;
      if (raw >= 1) {
        active = false;
        camera.position.copy(toPos);
        controls.target.copy(toTarget);
        if (toFov !== null && Math.abs(camera.fov - toFov) > 1e-4) {
          camera.fov = toFov;
          camera.updateProjectionMatrix();
        }
        const done = finishCallback;
        finishCallback = null;
        done?.();
        return false;
      }
      const u = easeOutCubic(raw);
      controls.target.lerpVectors(fromTarget, toTarget, u);
      if (useArc) {
        const radius = fromRadius + (toRadius - fromRadius) * u;
        curOffset.copy(fromOffset).applyAxisAngle(arcAxis, arcAngle * u).multiplyScalar(radius);
        camera.position.copy(controls.target).add(curOffset);
      } else {
        camera.position.lerpVectors(fromPos, toPos, u);
      }
      if (toFov !== null && fromFov !== null) {
        camera.fov = fromFov + (toFov - fromFov) * u;
        camera.updateProjectionMatrix();
      }
      return true;
    },

    /** Stops the glide in place so manual orbit/zoom immediately takes over. */
    cancel() {
      active = false;
      finishCallback = null;
    },
  };
}
