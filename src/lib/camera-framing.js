import * as THREE from "three";

const DEFAULT_CAMERA_FOV = 45;
const MIN_CAMERA_DISTANCE = 2.4;
const DEFAULT_FIT_PADDING = 1.12;
export const TOP_PRESET_FORWARD_BIAS = 0.02;

export const CAMERA_PRESETS = {
  front: {
    key: "front",
    direction: new THREE.Vector3(0, 0, -1),
    up: new THREE.Vector3(0, 1, 0),
  },
  back: {
    key: "back",
    direction: new THREE.Vector3(0, 0, 1),
    up: new THREE.Vector3(0, 1, 0),
  },
  side: {
    key: "side",
    direction: new THREE.Vector3(1, 0, 0),
    up: new THREE.Vector3(0, 1, 0),
  },
  angle: {
    key: "angle",
    direction: new THREE.Vector3(0.8, 0.12, -0.8).normalize(),
    up: new THREE.Vector3(0, 1, 0),
  },
  top: {
    key: "top",
    direction: new THREE.Vector3(0, 1, TOP_PRESET_FORWARD_BIAS).normalize(),
    up: new THREE.Vector3(0, 1, 0),
  },
};

export const DEFAULT_CAMERA_PRESET = "angle";
export const CAMERA_PRESET_KEYS = Object.keys(CAMERA_PRESETS);

function isFiniteBox(bounds) {
  if (!bounds?.isBox3) return false;
  return [bounds.min.x, bounds.min.y, bounds.min.z, bounds.max.x, bounds.max.y, bounds.max.z]
    .every((value) => Number.isFinite(value));
}

function getObjectBounds(object) {
  if (!object?.updateMatrixWorld) return null;
  object.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(object);
  return bounds.isEmpty() || !isFiniteBox(bounds) ? null : bounds;
}

export function computeFramingBounds(source, fallbackBounds = null) {
  const candidates = Array.isArray(source) ? source : [source];
  const mergedBounds = new THREE.Box3();
  let hasBounds = false;

  for (const candidate of candidates) {
    const bounds = candidate?.isBox3
      ? candidate.clone()
      : getObjectBounds(candidate);
    if (!bounds || bounds.isEmpty() || !isFiniteBox(bounds)) continue;
    if (!hasBounds) {
      mergedBounds.copy(bounds);
      hasBounds = true;
      continue;
    }
    mergedBounds.union(bounds);
  }

  const baseBounds = hasBounds
    ? mergedBounds
    : fallbackBounds?.isBox3 && !fallbackBounds.isEmpty() && isFiniteBox(fallbackBounds)
      ? fallbackBounds.clone()
      : null;

  if (!baseBounds) return null;

  const size = baseBounds.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 0);
  if (!Number.isFinite(maxDim) || maxDim <= 0) return baseBounds;

  return baseBounds.expandByScalar(Math.max(maxDim * 0.04, 0.02));
}

export function getCameraPreset(presetKey = DEFAULT_CAMERA_PRESET) {
  return CAMERA_PRESETS[presetKey] || CAMERA_PRESETS[DEFAULT_CAMERA_PRESET];
}

export function buildCameraFraming({
  bounds,
  aspect = 1,
  fov = DEFAULT_CAMERA_FOV,
  presetKey = DEFAULT_CAMERA_PRESET,
  zoomFactor = 1,
}) {
  const preset = getCameraPreset(presetKey);
  const target = bounds.getCenter(new THREE.Vector3());
  const sphere = bounds.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(Number.isFinite(sphere.radius) ? sphere.radius : 0, 0.5);
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const verticalFov = THREE.MathUtils.degToRad(
    Number.isFinite(fov) && fov > 0 ? fov : DEFAULT_CAMERA_FOV,
  );
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * safeAspect);
  const limitingFov = Math.max(Math.min(verticalFov, horizontalFov), THREE.MathUtils.degToRad(10));
  const baseDistance = Math.max(
    (radius * DEFAULT_FIT_PADDING) / Math.sin(limitingFov / 2),
    MIN_CAMERA_DISTANCE,
  );
  const distance = baseDistance / Math.max(zoomFactor || 1, 0.01);
  const position = target.clone().addScaledVector(preset.direction, distance);

  return {
    target,
    position,
    up: preset.up.clone(),
    distance,
    baseDistance,
    near: Math.max(0.01, distance - radius * 4),
    far: Math.max(distance + radius * 6, 100),
    presetKey: preset.key,
  };
}
