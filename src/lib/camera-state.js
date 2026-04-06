import * as THREE from "three";

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

  camera.position.copy(toVector3(viewState.position, camera.position));
  camera.up.copy(toVector3(viewState.up, camera.up));
  camera.near = Number.isFinite(viewState.near) ? viewState.near : camera.near;
  camera.far = Number.isFinite(viewState.far) ? viewState.far : camera.far;
  camera.updateProjectionMatrix();

  const target = toVector3(viewState.target, controls.target);
  controls.target.copy(target);
  if (Number.isFinite(viewState.minDistance)) controls.minDistance = viewState.minDistance;
  if (Number.isFinite(viewState.maxDistance)) controls.maxDistance = viewState.maxDistance;
  controls.update();

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
