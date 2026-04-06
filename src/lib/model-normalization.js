import * as THREE from "three";

const DEFAULT_SAMPLE_LIMIT = 12000;
const DEFAULT_LOW_BAND_RATIO = 0.08;
const DEFAULT_MAX_LEVEL_ANGLE_DEG = 15;
const DEFAULT_MIN_LEVEL_ANGLE_DEG = 0.5;
const DEFAULT_PLANE_ERROR_RATIO = 0.025;
const MIN_PLANE_POINTS = 24;
const EPSILON = 1e-6;

export function fitGroundPlaneNormal(object, options = {}) {
  if (!object) return null;

  object.updateMatrixWorld?.(true);
  const bounds = new THREE.Box3().setFromObject(object);
  if (!isFiniteBounds(bounds)) return null;

  const size = bounds.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(maxDim) || maxDim <= 0) return null;

  const points = collectVertexSamples(object, options.sampleLimit || DEFAULT_SAMPLE_LIMIT);
  if (points.length < MIN_PLANE_POINTS) return null;

  const bandHeight = Math.max(size.y * (options.lowBandRatio || DEFAULT_LOW_BAND_RATIO), maxDim * 0.01);
  const cutoff = bounds.min.y + bandHeight;
  const lowPoints = points.filter((point) => point.y <= cutoff);
  if (lowPoints.length < MIN_PLANE_POINTS) return null;

  const centroid = new THREE.Vector3();
  for (const point of lowPoints) centroid.add(point);
  centroid.multiplyScalar(1 / lowPoints.length);

  let xx = 0;
  let xy = 0;
  let xz = 0;
  let yy = 0;
  let yz = 0;
  let zz = 0;

  for (const point of lowPoints) {
    const dx = point.x - centroid.x;
    const dy = point.y - centroid.y;
    const dz = point.z - centroid.z;
    xx += dx * dx;
    xy += dx * dy;
    xz += dx * dz;
    yy += dy * dy;
    yz += dy * dz;
    zz += dz * dz;
  }

  const normal = smallestEigenVectorSymmetric3([
    [xx, xy, xz],
    [xy, yy, yz],
    [xz, yz, zz],
  ]);
  if (!normal || normal.lengthSq() <= EPSILON) return null;
  if (normal.y < 0) normal.multiplyScalar(-1);

  let totalDistance = 0;
  for (const point of lowPoints) {
    totalDistance += Math.abs(normal.dot(point) - normal.dot(centroid));
  }
  const averageDistance = totalDistance / lowPoints.length;
  const maxAllowedError = maxDim * (options.maxPlaneErrorRatio || DEFAULT_PLANE_ERROR_RATIO);
  if (!Number.isFinite(averageDistance) || averageDistance > maxAllowedError) return null;

  return normal.normalize();
}

export function stabilizeObjectForWorld(object, options = {}) {
  if (!object) return null;

  const {
    autoLevel = true,
    centerXZ = true,
    groundToZero = true,
    maxLevelAngleDeg = DEFAULT_MAX_LEVEL_ANGLE_DEG,
    minLevelAngleDeg = DEFAULT_MIN_LEVEL_ANGLE_DEG,
  } = options;

  if (autoLevel) {
    const fittedNormal = fitGroundPlaneNormal(object, options);
    if (fittedNormal) {
      const up = new THREE.Vector3(0, 1, 0);
      const angle = fittedNormal.angleTo(up);
      const minAngle = THREE.MathUtils.degToRad(minLevelAngleDeg);
      const maxAngle = THREE.MathUtils.degToRad(maxLevelAngleDeg);
      if (angle >= minAngle && angle <= maxAngle) {
        const levelRotation = new THREE.Quaternion().setFromUnitVectors(fittedNormal, up);
        object.applyQuaternion(levelRotation);
        object.updateMatrixWorld(true);
      }
    }
  }

  const bounds = new THREE.Box3().setFromObject(object);
  if (!isFiniteBounds(bounds)) return object;

  const center = bounds.getCenter(new THREE.Vector3());
  const offset = new THREE.Vector3(
    centerXZ ? -center.x : 0,
    groundToZero ? -bounds.min.y : 0,
    centerXZ ? -center.z : 0,
  );

  object.position.add(offset);
  object.updateMatrixWorld(true);

  const wrapper = new THREE.Group();
  wrapper.name = object.name || "model";
  wrapper.userData = {
    ...(object.userData || {}),
    normalizedForWorld: true,
  };
  wrapper.add(object);
  wrapper.updateMatrixWorld(true);
  return wrapper;
}

function collectVertexSamples(object, sampleLimit) {
  const meshes = [];
  let totalVertexCount = 0;

  object.traverse((child) => {
    if (!child.isMesh) return;
    const positions = child.geometry?.attributes?.position;
    if (!positions?.count) return;
    meshes.push({ mesh: child, positions });
    totalVertexCount += positions.count;
  });

  if (!totalVertexCount) return [];

  const points = [];
  const point = new THREE.Vector3();
  const limit = Math.max(sampleLimit || DEFAULT_SAMPLE_LIMIT, MIN_PLANE_POINTS);

  for (const { mesh, positions } of meshes) {
    const desired = Math.max(1, Math.round((positions.count / totalVertexCount) * limit));
    const step = Math.max(1, Math.floor(positions.count / desired));
    for (let index = 0; index < positions.count; index += step) {
      point.set(positions.getX(index), positions.getY(index), positions.getZ(index));
      point.applyMatrix4(mesh.matrixWorld);
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) continue;
      points.push(point.clone());
    }
  }

  return points;
}

function smallestEigenVectorSymmetric3(matrix) {
  const a = matrix.map((row) => row.slice());
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  for (let iteration = 0; iteration < 16; iteration += 1) {
    const { p, q, magnitude } = largestOffDiagonal(a);
    if (magnitude <= 1e-10) break;

    const app = a[p][p];
    const aqq = a[q][q];
    const apq = a[p][q];
    const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
    const c = Math.cos(phi);
    const s = Math.sin(phi);

    for (let row = 0; row < 3; row += 1) {
      const arp = a[row][p];
      const arq = a[row][q];
      a[row][p] = c * arp - s * arq;
      a[row][q] = s * arp + c * arq;
    }

    for (let column = 0; column < 3; column += 1) {
      const apc = a[p][column];
      const aqc = a[q][column];
      a[p][column] = c * apc - s * aqc;
      a[q][column] = s * apc + c * aqc;
    }

    a[p][q] = 0;
    a[q][p] = 0;

    for (let row = 0; row < 3; row += 1) {
      const vrp = v[row][p];
      const vrq = v[row][q];
      v[row][p] = c * vrp - s * vrq;
      v[row][q] = s * vrp + c * vrq;
    }
  }

  const eigenvalues = [a[0][0], a[1][1], a[2][2]];
  let smallestIndex = 0;
  for (let index = 1; index < 3; index += 1) {
    if (eigenvalues[index] < eigenvalues[smallestIndex]) {
      smallestIndex = index;
    }
  }

  return new THREE.Vector3(
    v[0][smallestIndex],
    v[1][smallestIndex],
    v[2][smallestIndex],
  ).normalize();
}

function largestOffDiagonal(matrix) {
  let p = 0;
  let q = 1;
  let magnitude = Math.abs(matrix[0][1]);

  const pairs = [
    [0, 2],
    [1, 2],
  ];

  for (const [row, column] of pairs) {
    const value = Math.abs(matrix[row][column]);
    if (value > magnitude) {
      p = row;
      q = column;
      magnitude = value;
    }
  }

  return { p, q, magnitude };
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
