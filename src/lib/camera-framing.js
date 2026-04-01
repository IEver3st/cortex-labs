import * as THREE from "three";

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
    direction: new THREE.Vector3(0, 1, 0),
    up: new THREE.Vector3(0, 0, -1),
  },
};

export const DEFAULT_CAMERA_PRESET = "side";
export const CAMERA_PRESET_KEYS = Object.keys(CAMERA_PRESETS);
const DEFAULT_MARGIN = 1.08;
const EPSILON = 1e-6;

export function getCameraPreset(presetKey = DEFAULT_CAMERA_PRESET) {
  return CAMERA_PRESETS[presetKey] || CAMERA_PRESETS[DEFAULT_CAMERA_PRESET];
}

export function buildCameraFraming({
  bounds,
  aspect = 1,
  fov = 45,
  presetKey = DEFAULT_CAMERA_PRESET,
  margin = DEFAULT_MARGIN,
  zoomFactor = 1,
}) {
  const preset = getCameraPreset(presetKey);
  const safeBounds = isFiniteBounds(bounds)
    ? bounds.clone()
    : new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
  const target = safeBounds.getCenter(new THREE.Vector3());
  const corners = getBoundsCorners(safeBounds);
  const basis = buildCameraBasis(preset);
  const baseDistance = computeFitDistance({
    corners,
    target,
    direction: basis.direction,
    right: basis.right,
    up: basis.up,
    aspect,
    fov,
    margin,
  });
  const clampedZoom = clampZoomFactor(zoomFactor);
  const distance = Math.max(baseDistance / clampedZoom, EPSILON);
  const position = target.clone().addScaledVector(basis.direction, distance);
  const { near, far } = computeDepthRange({
    corners,
    target,
    direction: basis.direction,
    distance,
  });

  return {
    target,
    position,
    up: basis.cameraUp.clone(),
    distance,
    baseDistance,
    near,
    far,
    presetKey: preset.key,
  };
}

export function computeFramingBounds(objects, fallbackBounds = null) {
  const list = (Array.isArray(objects) ? objects : [objects]).filter(Boolean);
  if (!list.length) {
    return isFiniteBounds(fallbackBounds) ? fallbackBounds.clone() : null;
  }

  const bounds = new THREE.Box3();
  let hasBounds = false;

  for (const object of list) {
    object.updateMatrixWorld?.(true);
    const objectBounds = new THREE.Box3().setFromObject(object);
    if (!isFiniteBounds(objectBounds)) continue;
    if (!hasBounds) {
      bounds.copy(objectBounds);
      hasBounds = true;
      continue;
    }
    bounds.union(objectBounds);
  }

  if (hasBounds && isFiniteBounds(bounds)) return bounds;
  return isFiniteBounds(fallbackBounds) ? fallbackBounds.clone() : null;
}

function clampZoomFactor(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(0.4, Math.min(2.5, parsed));
}

function isFiniteBounds(bounds) {
  return Boolean(
    bounds &&
    Number.isFinite(bounds.min?.x) &&
    Number.isFinite(bounds.min?.y) &&
    Number.isFinite(bounds.min?.z) &&
    Number.isFinite(bounds.max?.x) &&
    Number.isFinite(bounds.max?.y) &&
    Number.isFinite(bounds.max?.z) &&
    bounds.max.x > bounds.min.x &&
    bounds.max.y > bounds.min.y &&
    bounds.max.z > bounds.min.z
  );
}

function getBoundsCorners(bounds) {
  const corners = [];
  const xs = [bounds.min.x, bounds.max.x];
  const ys = [bounds.min.y, bounds.max.y];
  const zs = [bounds.min.z, bounds.max.z];

  for (const x of xs) {
    for (const y of ys) {
      for (const z of zs) {
        corners.push(new THREE.Vector3(x, y, z));
      }
    }
  }
  return corners;
}

function buildCameraBasis(preset) {
  const direction = preset.direction.clone().normalize();
  let cameraUp = preset.up.clone();
  if (cameraUp.lengthSq() <= EPSILON) {
    cameraUp = Math.abs(direction.y) > 0.95
      ? new THREE.Vector3(0, 0, -1)
      : new THREE.Vector3(0, 1, 0);
  }
  cameraUp.normalize();

  let up = cameraUp.clone();
  up.addScaledVector(direction, -up.dot(direction));

  if (up.lengthSq() <= EPSILON) {
    up = Math.abs(direction.y) > 0.95
      ? new THREE.Vector3(0, 0, -1)
      : new THREE.Vector3(0, 1, 0);
    up.addScaledVector(direction, -up.dot(direction));
  }

  up.normalize();
  const right = new THREE.Vector3().crossVectors(up, direction).normalize();
  const correctedUp = new THREE.Vector3().crossVectors(direction, right).normalize();

  return {
    direction,
    right,
    up: correctedUp,
    cameraUp,
  };
}

function computeFitDistance({
  corners,
  target,
  direction,
  right,
  up,
  aspect,
  fov,
  margin,
}) {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const halfFov = THREE.MathUtils.degToRad(Math.max(1, Math.min(179, fov))) / 2;
  const tanVertical = Math.tan(halfFov);
  const tanHorizontal = tanVertical * safeAspect;
  let requiredDistance = 0;

  for (const corner of corners) {
    const offset = corner.clone().sub(target);
    const depthOffset = offset.dot(direction);
    const horizontal = Math.abs(offset.dot(right));
    const vertical = Math.abs(offset.dot(up));
    const distanceForHorizontal = horizontal / Math.max(tanHorizontal, EPSILON);
    const distanceForVertical = vertical / Math.max(tanVertical, EPSILON);
    requiredDistance = Math.max(
      requiredDistance,
      depthOffset + distanceForHorizontal,
      depthOffset + distanceForVertical,
    );
  }

  return Math.max(requiredDistance * Math.max(margin || DEFAULT_MARGIN, 1.01), 0.5);
}

function computeDepthRange({ corners, target, direction, distance }) {
  let minDepth = Number.POSITIVE_INFINITY;
  let maxDepth = Number.NEGATIVE_INFINITY;

  for (const corner of corners) {
    const depth = distance - corner.clone().sub(target).dot(direction);
    minDepth = Math.min(minDepth, depth);
    maxDepth = Math.max(maxDepth, depth);
  }

  const safeMinDepth = Number.isFinite(minDepth) ? minDepth : distance;
  const safeMaxDepth = Number.isFinite(maxDepth) ? maxDepth : distance * 2;
  const near = Math.max(Math.min(safeMinDepth * 0.25, distance * 0.5), 0.01);
  const far = Math.max(safeMaxDepth * 4, distance * 4, 100);

  return { near, far };
}
