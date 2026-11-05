import { buildUvIslands } from "./template-map.js";

const EPSILON = 1e-12;
const BARY_TOLERANCE = 1e-3;
const MIXED_SHARE = 0.15;
const SHARED_UV_QUANTIZE = 1e4;
const SHARED_DISTANCE_SHARE = 0.02;
const FLAT_SURFACE_LIMIT = 0.35;
const TWIN_BOUNDS_TOLERANCE = 1e-3;
const TWIN_AREA_TOLERANCE = 0.02;

const finite = (value) => typeof value === "number" && Number.isFinite(value);

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function scale(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function length(a) {
  return Math.hypot(a[0], a[1], a[2]);
}

function normalize(a) {
  const size = length(a);
  return size > EPSILON ? scale(a, 1 / size) : null;
}

function isTypedOrArray(value) {
  return Array.isArray(value) || ArrayBuffer.isView(value);
}

export function validateMeshData(mesh) {
  if (!mesh || typeof mesh !== "object") return "The mesh data is missing.";
  if (!isTypedOrArray(mesh.positions) || mesh.positions.length < 9 || mesh.positions.length % 3) {
    return `${mesh.key || "A mesh"} has no usable positions.`;
  }
  const vertexCount = mesh.positions.length / 3;
  if (!isTypedOrArray(mesh.uvs) || mesh.uvs.length !== vertexCount * 2) {
    return `${mesh.key || "A mesh"} has no UVs on the livery's UV set.`;
  }
  if (mesh.normals != null && (!isTypedOrArray(mesh.normals) || mesh.normals.length !== vertexCount * 3)) {
    return `${mesh.key || "A mesh"} has a normal count that does not match its positions.`;
  }
  if (mesh.index != null) {
    if (!isTypedOrArray(mesh.index) || mesh.index.length < 3) return `${mesh.key || "A mesh"} has an empty index.`;
  } else if (vertexCount % 3) {
    return `${mesh.key || "A mesh"} is not a triangle list.`;
  }
  return "";
}

export function faceCount(mesh) {
  return Math.floor((mesh.index ? mesh.index.length : mesh.positions.length / 3) / 3);
}

export function faceVertices(mesh, face) {
  if (!Number.isInteger(face) || face < 0 || face >= faceCount(mesh)) return null;
  const vertexCount = mesh.positions.length / 3;
  const base = face * 3;
  const indices = mesh.index ? [mesh.index[base], mesh.index[base + 1], mesh.index[base + 2]] : [base, base + 1, base + 2];
  return indices.every((value) => Number.isInteger(value) && value >= 0 && value < vertexCount) ? indices : null;
}

function readPosition(mesh, vertex) {
  const p = [mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2]];
  return p.every(finite) ? p : null;
}

function readUv(mesh, vertex) {
  const uv = [mesh.uvs[vertex * 2], mesh.uvs[vertex * 2 + 1]];
  return uv.every(finite) ? uv : null;
}

function readNormal(mesh, vertex) {
  if (!mesh.normals) return null;
  const n = [mesh.normals[vertex * 3], mesh.normals[vertex * 3 + 1], mesh.normals[vertex * 3 + 2]];
  return n.every(finite) ? n : null;
}

export function normalizeBarycentric(bary) {
  if (!isTypedOrArray(bary) || bary.length !== 3) return null;
  const values = [Number(bary[0]), Number(bary[1]), Number(bary[2])];
  if (!values.every(finite)) return null;
  if (values.some((value) => value < -BARY_TOLERANCE)) return null;
  const clamped = values.map((value) => Math.max(0, value));
  const total = clamped[0] + clamped[1] + clamped[2];
  if (!(total > EPSILON) || Math.abs(total - 1) > 0.05) return null;
  return clamped.map((value) => value / total);
}

export function uvFromBarycentric(mesh, face, bary) {
  const vertices = faceVertices(mesh, face);
  const weights = normalizeBarycentric(bary);
  if (!vertices || !weights) return null;
  const uvs = vertices.map((vertex) => readUv(mesh, vertex));
  if (uvs.some((uv) => !uv)) return null;
  return [
    uvs[0][0] * weights[0] + uvs[1][0] * weights[1] + uvs[2][0] * weights[2],
    uvs[0][1] * weights[0] + uvs[1][1] * weights[1] + uvs[2][1] * weights[2],
  ];
}

export function pointFromBarycentric(mesh, face, bary) {
  const vertices = faceVertices(mesh, face);
  const weights = normalizeBarycentric(bary);
  if (!vertices || !weights) return null;
  const points = vertices.map((vertex) => readPosition(mesh, vertex));
  if (points.some((point) => !point)) return null;
  return [0, 1, 2].map((axis) => points[0][axis] * weights[0] + points[1][axis] * weights[1] + points[2][axis] * weights[2]);
}

export function barycentricFromPoint(a, b, c, point) {
  const v0 = sub(b, a);
  const v1 = sub(c, a);
  const v2 = sub(point, a);
  const d00 = dot(v0, v0);
  const d01 = dot(v0, v1);
  const d11 = dot(v1, v1);
  const d20 = dot(v2, v0);
  const d21 = dot(v2, v1);
  const denominator = d00 * d11 - d01 * d01;
  if (!(Math.abs(denominator) > EPSILON)) return null;
  const v = (d11 * d20 - d01 * d21) / denominator;
  const w = (d00 * d21 - d01 * d20) / denominator;
  return [1 - v - w, v, w];
}

export function sheetY(v, originTop) {
  return originTop ? v : 1 - v;
}

export function uvToSheet(u, v, width, height, originTop) {
  return [u * width, sheetY(v, originTop) * height];
}

function triangleFrame(points, sheetPoints) {
  const e1 = sub(points[1], points[0]);
  const e2 = sub(points[2], points[0]);
  const d1 = [sheetPoints[1][0] - sheetPoints[0][0], sheetPoints[1][1] - sheetPoints[0][1]];
  const d2 = [sheetPoints[2][0] - sheetPoints[0][0], sheetPoints[2][1] - sheetPoints[0][1]];
  const determinant = d1[0] * d2[1] - d2[0] * d1[1];
  if (!(Math.abs(determinant) > EPSILON)) return null;
  const tangent = scale(sub(scale(e1, d2[1]), scale(e2, d1[1])), 1 / determinant);
  const bitangent = scale(sub(scale(e2, d1[0]), scale(e1, d2[0])), 1 / determinant);
  const faceCross = cross(e1, e2);
  const area3d = length(faceCross) * 0.5;
  const sheetArea = Math.abs(determinant) * 0.5;
  return { tangent, bitangent, faceNormal: normalize(faceCross), area3d, sheetArea };
}

function outwardNormal(mesh, vertices, faceNormal) {
  if (!faceNormal) return null;
  const normals = vertices.map((vertex) => readNormal(mesh, vertex));
  if (normals.every(Boolean)) {
    const average = normalize([0, 1, 2].map((axis) => normals[0][axis] + normals[1][axis] + normals[2][axis]));
    if (average && dot(average, faceNormal) < 0) return scale(faceNormal, -1);
  }
  return faceNormal;
}

function faceGeometry(mesh, face, { width = 1, height = 1 } = {}) {
  const vertices = faceVertices(mesh, face);
  if (!vertices) return null;
  const points = vertices.map((vertex) => readPosition(mesh, vertex));
  const uvs = vertices.map((vertex) => readUv(mesh, vertex));
  if (points.some((point) => !point) || uvs.some((uv) => !uv)) return null;
  const sheetPoints = uvs.map(([u, v]) => uvToSheet(u, v, width, height, Boolean(mesh.originTop)));
  const frame = triangleFrame(points, sheetPoints);
  if (!frame || !frame.faceNormal || !(frame.area3d > EPSILON)) return null;
  const normal = outwardNormal(mesh, vertices, frame.faceNormal);
  return { vertices, points, uvs, sheetPoints, normal, ...frame };
}

export function faceHandedness(mesh, face) {
  const geometry = faceGeometry(mesh, face);
  if (!geometry) return null;
  const sign = dot(cross(geometry.tangent, geometry.bitangent), geometry.normal);
  if (!finite(sign) || Math.abs(sign) <= EPSILON) return null;
  return { mirrored: sign > 0, weight: geometry.area3d };
}

function meshDiagonal(mesh) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < mesh.positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = mesh.positions[i + axis];
      if (!finite(value)) continue;
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }
  if (!min.every(finite)) return 0;
  return Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
}

function flatUvAttribute(uvs) {
  return {
    count: uvs.length / 2,
    getX: (index) => uvs[index * 2],
    getY: (index) => uvs[index * 2 + 1],
  };
}

function islandSharesUvs(mesh, triangles, members, limit) {
  const seen = new Map();
  for (const member of members) {
    const triangle = triangles[member];
    for (const vertex of [triangle.i0, triangle.i1, triangle.i2]) {
      const uv = readUv(mesh, vertex);
      const point = readPosition(mesh, vertex);
      if (!uv || !point) continue;
      const key = `${Math.round(uv[0] * SHARED_UV_QUANTIZE)},${Math.round(uv[1] * SHARED_UV_QUANTIZE)}`;
      const first = seen.get(key);
      if (!first) {
        seen.set(key, point);
        continue;
      }
      if (length(sub(first, point)) > limit) return true;
    }
  }
  return false;
}

export function buildCanvasIslands(mesh) {
  const problem = validateMeshData(mesh);
  if (problem) throw new Error(problem);
  const { triangles, islands: components } = buildUvIslands(flatUvAttribute(mesh.uvs), mesh.index || null);
  const faceToIsland = new Int32Array(faceCount(mesh)).fill(-1);
  const sharedLimit = Math.max(1e-3, meshDiagonal(mesh) * SHARED_DISTANCE_SHARE);
  const islands = components.map((members, index) => {
    let minU = Infinity;
    let minV = Infinity;
    let maxU = -Infinity;
    let maxV = -Infinity;
    let sumU = 0;
    let sumV = 0;
    let uvArea = 0;
    let area3d = 0;
    let readable = 0;
    let mirrored = 0;
    for (const member of members) {
      const triangle = triangles[member];
      faceToIsland[triangle.face] = index;
      const [u0, v0, u1, v1, u2, v2] = triangle.uvs;
      minU = Math.min(minU, u0, u1, u2);
      minV = Math.min(minV, v0, v1, v2);
      maxU = Math.max(maxU, u0, u1, u2);
      maxV = Math.max(maxV, v0, v1, v2);
      sumU += (u0 + u1 + u2) * triangle.area;
      sumV += (v0 + v1 + v2) * triangle.area;
      uvArea += triangle.area;
      const hand = faceHandedness(mesh, triangle.face);
      if (!hand) continue;
      area3d += hand.weight;
      if (hand.mirrored) mirrored += hand.weight;
      else readable += hand.weight;
    }
    const centreU = uvArea > EPSILON ? sumU / (3 * uvArea) : (minU + maxU) / 2;
    const centreV = uvArea > EPSILON ? sumV / (3 * uvArea) : (minV + maxV) / 2;
    const tile = [Math.floor(centreU), Math.floor(centreV)];
    const handed = readable + mirrored;
    const shared = islandSharesUvs(mesh, triangles, members, sharedLimit);
    return {
      index,
      triangles: members,
      triangleCount: members.length,
      tile,
      bounds: { minU: minU - tile[0], minV: minV - tile[1], maxU: maxU - tile[0], maxV: maxV - tile[1] },
      uvArea,
      area3d,
      mirrored: handed > 0 && mirrored > readable,
      mixed: handed > 0 && Math.min(mirrored, readable) > MIXED_SHARE * handed,
      shared,
      twins: [],
    };
  });
  return { key: mesh.key || "", originTop: Boolean(mesh.originTop), triangles, islands, faceToIsland };
}

export function markTwinIslands(models) {
  const entries = [];
  for (const model of models) {
    for (const island of model.islands) entries.push({ key: model.key, island });
  }
  for (let i = 0; i < entries.length; i += 1) {
    const a = entries[i].island;
    for (let j = i + 1; j < entries.length; j += 1) {
      const b = entries[j].island;
      const close = Math.abs(a.bounds.minU - b.bounds.minU) <= TWIN_BOUNDS_TOLERANCE
        && Math.abs(a.bounds.minV - b.bounds.minV) <= TWIN_BOUNDS_TOLERANCE
        && Math.abs(a.bounds.maxU - b.bounds.maxU) <= TWIN_BOUNDS_TOLERANCE
        && Math.abs(a.bounds.maxV - b.bounds.maxV) <= TWIN_BOUNDS_TOLERANCE;
      const area = Math.max(a.uvArea, b.uvArea);
      if (!close || !(area > EPSILON) || Math.abs(a.uvArea - b.uvArea) / area > TWIN_AREA_TOLERANCE) continue;
      a.twins.push({ mesh: entries[j].key, island: b.index });
      b.twins.push({ mesh: entries[i].key, island: a.index });
      a.shared = true;
      b.shared = true;
    }
  }
  return models;
}

export function islandPlacementIssue(island, kind) {
  if (!island) return { level: "", text: "" };
  const sharedText = "Both sides of the vehicle use this part of the sheet, so whatever goes here shows on both, and one side reads mirrored.";
  if (kind === "text") {
    if (island.shared) return { level: "refuse", text: `Text can't go here. ${sharedText}` };
    if (island.mirrored || island.mixed) return { level: "refuse", text: "Text can't go here: this part's UVs are mirrored, so text would read backwards on the vehicle." };
    return { level: "", text: "" };
  }
  if (island.shared) return { level: "warn", text: sharedText };
  if (island.mirrored) return { level: "warn", text: "This part's UVs are mirrored, so it shows flipped on the vehicle. Use Flip if it must read the right way." };
  if (island.mixed) return { level: "warn", text: "Part of this island's UVs are mirrored, so some of it shows flipped on the vehicle." };
  return { level: "", text: "" };
}

function projectOnPlane(vector, normal) {
  return sub(vector, scale(normal, dot(vector, normal)));
}

function solveSheetDirection(tangent, bitangent, direction) {
  const tt = dot(tangent, tangent);
  const tb = dot(tangent, bitangent);
  const bb = dot(bitangent, bitangent);
  const determinant = tt * bb - tb * tb;
  if (!(Math.abs(determinant) > EPSILON)) return null;
  const td = dot(tangent, direction);
  const bd = dot(bitangent, direction);
  const x = (bb * td - tb * bd) / determinant;
  const y = (tt * bd - tb * td) / determinant;
  const size = Math.hypot(x, y);
  return size > EPSILON ? [x / size, y / size] : null;
}

export function orientationAt(mesh, face, { up = [0, 0, 1], forward = [0, 1, 0], cameraUp = null, width = 1, height = 1 } = {}) {
  const geometry = faceGeometry(mesh, face, { width, height });
  if (!geometry) return null;
  const upAxis = normalize(up);
  const forwardAxis = normalize(forward);
  if (!upAxis || !forwardAxis) return null;
  let direction = projectOnPlane(upAxis, geometry.normal);
  let basis = "up";
  if (length(direction) < FLAT_SURFACE_LIMIT) {
    direction = projectOnPlane(forwardAxis, geometry.normal);
    basis = "forward";
    const view = cameraUp ? projectOnPlane(cameraUp, geometry.normal) : null;
    if (view && length(view) > EPSILON && dot(direction, view) < 0) direction = scale(direction, -1);
  }
  const unit = normalize(direction);
  if (!unit) return null;
  const sheetDirection = solveSheetDirection(geometry.tangent, geometry.bitangent, unit);
  if (!sheetDirection) return null;
  const handedness = dot(cross(geometry.tangent, geometry.bitangent), geometry.normal);
  return {
    rotation: Math.atan2(sheetDirection[0], -sheetDirection[1]),
    pixelsPerUnit: Math.sqrt(geometry.sheetArea / geometry.area3d),
    mirrored: handedness > 0,
    basis,
    normal: geometry.normal,
  };
}

export function closestPointOnTriangle(point, a, b, c) {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(point, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return { point: a, bary: [1, 0, 0] };
  const bp = sub(point, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return { point: b, bary: [0, 1, 0] };
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return { point: [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v], bary: [1 - v, v, 0] };
  }
  const cp = sub(point, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return { point: c, bary: [0, 0, 1] };
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return { point: [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w], bary: [1 - w, 0, w] };
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return { point: [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w], bary: [0, 1 - w, w] };
  }
  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator;
  const w = vc * denominator;
  return { point: [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w], bary: [1 - v - w, v, w] };
}

export function mirrorPoint(point, axis = 0, offset = 0) {
  if (!point || !point.every(finite) || ![0, 1, 2].includes(axis)) return null;
  const mirrored = [...point];
  mirrored[axis] = 2 * offset - point[axis];
  return mirrored;
}

export function findCounterpart(meshes, source, { axis = 0, offset = 0, centreShare = 0.01, reachShare = 0.05 } = {}) {
  const sourceMesh = meshes.find((mesh) => mesh.key === source?.mesh);
  if (!sourceMesh) return { status: "missing", text: "The decal's part of the model is not loaded." };
  const point = pointFromBarycentric(sourceMesh, source.face, source.bary);
  if (!point) return { status: "missing", text: "The decal's place on the model can't be read." };
  const diagonal = Math.max(...meshes.map(meshDiagonal), 1e-6);
  if (Math.abs(point[axis] - offset) <= diagonal * centreShare) {
    return { status: "centre", text: "The decal sits on the centre line, so it has no counterpart on the other side." };
  }
  const target = mirrorPoint(point, axis, offset);
  let best = null;
  for (const mesh of meshes) {
    const count = faceCount(mesh);
    for (let face = 0; face < count; face += 1) {
      const vertices = faceVertices(mesh, face);
      if (!vertices) continue;
      const [a, b, c] = vertices.map((vertex) => readPosition(mesh, vertex));
      if (!a || !b || !c) continue;
      const hit = closestPointOnTriangle(target, a, b, c);
      const distance = length(sub(hit.point, target));
      if (!best || distance < best.distance) best = { mesh: mesh.key, face, bary: hit.bary, distance };
    }
  }
  if (!best || best.distance > diagonal * reachShare) {
    return { status: "none", text: "No matching surface on the other side of the vehicle." };
  }
  return { status: "found", ...best };
}

export function islandFrame(mesh, model, islandIndex, options = {}) {
  const island = model?.islands?.[islandIndex];
  if (!island || !island.triangles.length) return null;
  const width = options.width || 1;
  const height = options.height || 1;
  let largest = null;
  for (const member of island.triangles) {
    const triangle = model.triangles[member];
    if (!largest || triangle.area > largest.area) largest = triangle;
  }
  const orientation = orientationAt(mesh, largest.face, { ...options, width, height });
  const rotation = orientation ? orientation.rotation : 0;
  const cos = Math.cos(-rotation);
  const sin = Math.sin(-rotation);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const member of island.triangles) {
    const uvs = model.triangles[member].uvs;
    for (let i = 0; i < 6; i += 2) {
      const x = (uvs[i] - island.tile[0]) * width;
      const y = sheetY(uvs[i + 1] - island.tile[1], Boolean(model.originTop)) * height;
      const rx = x * cos - y * sin;
      const ry = x * sin + y * cos;
      minX = Math.min(minX, rx);
      minY = Math.min(minY, ry);
      maxX = Math.max(maxX, rx);
      maxY = Math.max(maxY, ry);
    }
  }
  const localX = (minX + maxX) / 2;
  const localY = (minY + maxY) / 2;
  const back = { cos: Math.cos(rotation), sin: Math.sin(rotation) };
  return {
    x: localX * back.cos - localY * back.sin,
    y: localX * back.sin + localY * back.cos,
    width: maxX - minX,
    height: maxY - minY,
    rotation,
  };
}

export function islandSheetTriangles(model, islandIndex, width, height, offsetX = 0, offsetY = 0) {
  const island = model?.islands?.[islandIndex];
  if (!island) return new Float32Array(0);
  const out = new Float32Array(island.triangles.length * 6);
  let cursor = 0;
  for (const member of island.triangles) {
    const uvs = model.triangles[member].uvs;
    for (let i = 0; i < 6; i += 2) {
      out[cursor] = (uvs[i] - island.tile[0]) * width - offsetX;
      out[cursor + 1] = sheetY(uvs[i + 1] - island.tile[1], Boolean(model.originTop)) * height - offsetY;
      cursor += 2;
    }
  }
  return out;
}

export function islandSheetBounds(model, islandIndex, width, height, pad = 0) {
  const island = model?.islands?.[islandIndex];
  if (!island) return null;
  const top = Boolean(model.originTop);
  const y0 = sheetY(island.bounds.minV, top) * height;
  const y1 = sheetY(island.bounds.maxV, top) * height;
  const left = Math.max(0, Math.floor(island.bounds.minU * width - pad));
  const right = Math.min(width, Math.ceil(island.bounds.maxU * width + pad));
  const upper = Math.max(0, Math.floor(Math.min(y0, y1) - pad));
  const lower = Math.min(height, Math.ceil(Math.max(y0, y1) + pad));
  if (right <= left || lower <= upper) return null;
  return { x: left, y: upper, width: right - left, height: lower - upper };
}

function pointInTriangle2d(px, py, uvs) {
  const [x0, y0, x1, y1, x2, y2] = uvs;
  const d1 = (px - x1) * (y0 - y1) - (x0 - x1) * (py - y1);
  const d2 = (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2);
  const d3 = (px - x0) * (y2 - y0) - (x2 - x0) * (py - y0);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
}

export function islandAtSheetPoint(models, x, y, width, height) {
  if (![x, y, width, height].every(finite) || width <= 0 || height <= 0) return null;
  for (const model of models) {
    const top = Boolean(model.originTop);
    for (const island of model.islands) {
      const u = x / width + island.tile[0];
      const v = (top ? y / height : 1 - y / height) + island.tile[1];
      if (u < island.bounds.minU + island.tile[0] || u > island.bounds.maxU + island.tile[0]) continue;
      if (v < island.bounds.minV + island.tile[1] || v > island.bounds.maxV + island.tile[1]) continue;
      for (const member of island.triangles) {
        const triangle = model.triangles[member];
        if (!pointInTriangle2d(u, v, triangle.uvs)) continue;
        const [u0, v0, u1, v1, u2, v2] = triangle.uvs;
        const denominator = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
        if (!(Math.abs(denominator) > EPSILON)) continue;
        const a = ((v1 - v2) * (u - u2) + (u2 - u1) * (v - v2)) / denominator;
        const b = ((v2 - v0) * (u - u2) + (u0 - u2) * (v - v2)) / denominator;
        return { mesh: model.key, island: island.index, face: triangle.face, bary: [a, b, 1 - a - b] };
      }
    }
  }
  return null;
}
