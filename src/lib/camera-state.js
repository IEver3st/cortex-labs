import * as THREE from "three";
import { TOP_PRESET_FORWARD_BIAS } from "./camera-framing.js";

const DEFAULT_CAMERA_UP = new THREE.Vector3(0, 1, 0);
const LEGACY_TOP_CAMERA_UP = new THREE.Vector3(0, 0, -1);

export function cloneViewerCameraState({ camera, controls, fit, cameraState }) {
  if (!camera || !controls) return null;

  return {
    position: camera.position.clone(),
    up: camera.up.clone(),
    target: controls.target.clone(),
    near: camera.near,
    far: camera.far,
    minDistance: controls.minDistance,
    maxDistance: controls.maxDistance,
    distance: fit?.distance,
    baseDistance: fit?.baseDistance,
    presetKey: cameraState?.presetKey,
    zoomFactor: cameraState?.zoomFactor,
  };
}

export function syncViewerCameraPose({
  camera,
  controls,
  position,
  target,
  up,
  near,
  far,
  minDistance,
  maxDistance,
}) {
  if (!camera || !controls) return;

  flushOrbitControlsDamping(controls);

  const nextPosition = toVector3(position, camera.position);
  const nextTarget = toVector3(target, controls.target);
  const nextUp = toVector3(up, camera.up);

  camera.position.copy(nextPosition);
  camera.up.copy(nextUp);
  camera.near = Number.isFinite(near) ? near : camera.near;
  camera.far = Number.isFinite(far) ? far : camera.far;
  controls.target.copy(nextTarget);
  if (Number.isFinite(minDistance)) controls.minDistance = minDistance;
  if (Number.isFinite(maxDistance)) controls.maxDistance = maxDistance;
  camera.lookAt(nextTarget);
  camera.updateProjectionMatrix();
  controls.update();
}

export function restoreViewerCameraState({
  camera,
  controls,
  fit,
  cameraState,
  viewState,
}) {
  if (!camera || !controls || !viewState) {
    return {
      fit,
      cameraState,
      distance: fit?.distance ?? 0,
    };
  }

  const target = toVector3(viewState.target, controls.target);
  const { position, up } = normalizeLegacyTopViewState({
    viewState,
    camera,
    target,
  });
  syncViewerCameraPose({
    camera,
    controls,
    position,
    target,
    up,
    near: viewState.near,
    far: viewState.far,
    minDistance: viewState.minDistance,
    maxDistance: viewState.maxDistance,
  });

  const distance = Number.isFinite(viewState.distance)
    ? viewState.distance
    : camera.position.distanceTo(target);

  return {
    fit: {
      ...(fit || {}),
      center: target.clone(),
      distance,
      baseDistance: Number.isFinite(viewState.baseDistance) ? viewState.baseDistance : fit?.baseDistance,
      presetKey: viewState.presetKey || cameraState?.presetKey,
      zoomFactor: Number.isFinite(viewState.zoomFactor) ? viewState.zoomFactor : cameraState?.zoomFactor,
    },
    cameraState: {
      presetKey: viewState.presetKey || cameraState?.presetKey,
      zoomFactor: Number.isFinite(viewState.zoomFactor) ? viewState.zoomFactor : cameraState?.zoomFactor,
    },
    distance,
  };
}

function flushOrbitControlsDamping(controls) {
  if (!controls?.update || !controls.enableDamping) return;

  const previousDamping = controls.enableDamping;
  controls.enableDamping = false;
  controls.update();
  controls.enableDamping = previousDamping;
}

function normalizeLegacyTopViewState({ viewState, camera, target }) {
  const position = toVector3(viewState.position, camera.position);
  const up = toVector3(viewState.up, camera.up);

  if (viewState?.presetKey !== "top" || !isVectorApproxEqual(up, LEGACY_TOP_CAMERA_UP)) {
    return { position, up };
  }

  const offset = position.clone().sub(target);
  const distance = Math.max(offset.length(), Number(viewState.distance) || 0, 0.001);
  const nextPosition = isNearVerticalOffset(offset)
    ? target.clone().add(
        new THREE.Vector3(0, 1, TOP_PRESET_FORWARD_BIAS).normalize().multiplyScalar(distance),
      )
    : position;

  return {
    position: nextPosition,
    up: DEFAULT_CAMERA_UP.clone(),
  };
}

function isNearVerticalOffset(offset) {
  if (!offset || offset.lengthSq() === 0) return false;
  return Math.abs(offset.clone().normalize().y) > 0.9999;
}

function isVectorApproxEqual(value, target, epsilon = 1e-4) {
  return (
    Math.abs(value.x - target.x) <= epsilon &&
    Math.abs(value.y - target.y) <= epsilon &&
    Math.abs(value.z - target.z) <= epsilon
  );
}

function toVector3(value, fallback) {
  if (value instanceof THREE.Vector3) return value.clone();
  if (
    value &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.z)
  ) {
    return new THREE.Vector3(value.x, value.y, value.z);
  }
  return fallback?.clone?.() || new THREE.Vector3();
}
