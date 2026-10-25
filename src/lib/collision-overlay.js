import * as THREE from "three";

const MAX_TRIANGLES = 1_000_000;
const MAX_PRIMITIVES = 100_000;
const PRIMITIVE_KINDS = ["box", "sphere", "capsule", "cylinder"];
const OVERLAY_OPACITY = 0.38;
const SOLID_OPACITY = 0.92;
const EDGE_OPACITY = 0.85;
const GOLDEN_ANGLE = 137.508;
const CACHE_SIZE = 6;
const reads = new Map();
const HUE_START = 140;

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const vector = (value) => (Array.isArray(value) && value.length === 3 && value.every(finite) ? value : null);
const materialIndex = (value) => (Number.isInteger(value) && value >= 0 && value < 256 ? value : 0);

export function collisionMaterialColor(slot) {
  return new THREE.Color().setHSL(((HUE_START + slot * GOLDEN_ANGLE) % 360) / 360, 0.72, 0.56);
}

export function collisionMaterialLabel(material) {
  return material?.name ? material.name : `Material ${material?.index ?? 0}`;
}

export function normalizeCollisions(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const meshes = [];
  const warnings = Array.isArray(source.warnings) ? source.warnings.filter((warning) => typeof warning === "string") : [];
  let truncated = Boolean(source.truncated);
  let damaged = 0;
  let triangles = 0;
  for (const mesh of Array.isArray(source.meshes) ? source.meshes : []) {
    const positions = Array.isArray(mesh?.positions) ? mesh.positions : [];
    const indices = Array.isArray(mesh?.indices) ? mesh.indices : [];
    const vertexCount = positions.length / 3;
    if (!vertexCount || !Number.isInteger(vertexCount) || indices.length % 3 !== 0 || !indices.length
      || !positions.every(finite)
      || !indices.every((index) => Number.isInteger(index) && index >= 0 && index < vertexCount)) {
      damaged += 1;
      continue;
    }
    const count = indices.length / 3;
    if (triangles + count > MAX_TRIANGLES) {
      truncated = true;
      break;
    }
    triangles += count;
    meshes.push({
      material: materialIndex(mesh.material),
      source: mesh.source === "physics" ? "physics" : "drawable",
      positions: Float32Array.from(positions),
      indices: vertexCount > 65535 ? Uint32Array.from(indices) : Uint16Array.from(indices),
    });
  }

  const primitives = [];
  for (const primitive of Array.isArray(source.primitives) ? source.primitives : []) {
    if (primitives.length >= MAX_PRIMITIVES) {
      truncated = true;
      break;
    }
    const before = primitives.length;
    if (!PRIMITIVE_KINDS.includes(primitive?.kind)) {
      damaged += 1;
      continue;
    }
    const material = materialIndex(primitive.material);
    if (primitive.kind === "box") {
      const corner = vector(primitive.corner);
      const edges = Array.isArray(primitive.edges) && primitive.edges.length === 3 ? primitive.edges.map(vector) : [];
      if (corner && edges.length === 3 && edges.every(Boolean)) primitives.push({ kind: "box", material, corner, edges });
    } else if (primitive.kind === "sphere") {
      const center = vector(primitive.center);
      if (center && finite(primitive.radius) && primitive.radius > 0) primitives.push({ kind: "sphere", material, center, radius: primitive.radius });
    } else {
      const a = vector(primitive.a);
      const b = vector(primitive.b);
      if (a && b && finite(primitive.radius) && primitive.radius > 0) primitives.push({ kind: primitive.kind, material, a, b, radius: primitive.radius });
    }
    if (primitives.length === before) damaged += 1;
  }
  if (damaged) warnings.push(`${damaged} collision ${damaged === 1 ? "part has" : "parts have"} damaged values and ${damaged === 1 ? "was" : "were"} left out.`);

  const names = new Map();
  for (const material of Array.isArray(source.materials) ? source.materials : []) {
    if (Number.isInteger(material?.index)) names.set(material.index, typeof material.name === "string" && material.name ? material.name : null);
  }
  const legend = new Map();
  const entry = (index) => {
    if (!legend.has(index)) legend.set(index, { index, name: names.get(index) ?? null, triangles: 0, shapes: 0 });
    return legend.get(index);
  };
  for (const mesh of meshes) entry(mesh.material).triangles += mesh.indices.length / 3;
  for (const primitive of primitives) entry(primitive.material).shapes += 1;

  const kinds = Object.fromEntries(PRIMITIVE_KINDS.map((kind) => [kind, primitives.filter((primitive) => primitive.kind === kind).length]));
  return {
    meshes,
    primitives,
    triangles,
    kinds,
    materials: [...legend.values()]
      .sort((a, b) => b.triangles + b.shapes - (a.triangles + a.shapes) || a.index - b.index)
      .map((material, slot) => ({ ...material, slot })),
    truncated,
    warnings: [...new Set(warnings)],
  };
}

function edgesOf(geometry) {
  const edges = new THREE.EdgesGeometry(geometry);
  geometry.dispose();
  return edges;
}

function primitiveMatrix(primitive) {
  const matrix = new THREE.Matrix4();
  if (primitive.kind === "box") {
    const [e1, e2, e3] = primitive.edges.map((edge) => new THREE.Vector3(...edge));
    matrix.makeBasis(e1, e2, e3).setPosition(new THREE.Vector3(...primitive.corner));
    return matrix;
  }
  if (primitive.kind === "sphere") {
    return matrix.compose(new THREE.Vector3(...primitive.center), new THREE.Quaternion(), new THREE.Vector3(primitive.radius, primitive.radius, primitive.radius));
  }
  const a = new THREE.Vector3(...primitive.a);
  const b = new THREE.Vector3(...primitive.b);
  const axis = b.clone().sub(a);
  const length = axis.length();
  const rotation = length > 1e-6
    ? new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.divideScalar(length))
    : new THREE.Quaternion();
  const scale = primitive.kind === "cylinder"
    ? new THREE.Vector3(primitive.radius, Math.max(length, 1e-4), primitive.radius)
    : new THREE.Vector3(1, 1, 1);
  return matrix.compose(a.clone().add(b).multiplyScalar(0.5), rotation, scale);
}

export function buildCollisionOverlay(data) {
  const group = new THREE.Group();
  group.name = "collision-overlay";
  group.userData.collisionOverlay = true;
  const fills = new Map();
  const edges = new Map();
  const slots = new Map(data.materials.map((material) => [material.index, material.slot]));
  const colorOf = (index) => collisionMaterialColor(slots.get(index) ?? index);
  const geometries = [];
  const fillFor = (index) => {
    if (!fills.has(index)) {
      fills.set(index, new THREE.MeshLambertMaterial({
        color: colorOf(index),
        transparent: true,
        opacity: OVERLAY_OPACITY,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      }));
    }
    return fills.get(index);
  };
  const edgeFor = (index) => {
    if (!edges.has(index)) {
      edges.set(index, new THREE.LineBasicMaterial({
        color: colorOf(index).offsetHSL(0, 0, 0.18),
        transparent: true,
        opacity: EDGE_OPACITY,
        depthWrite: false,
      }));
    }
    return edges.get(index);
  };
  const add = (object) => {
    object.userData.collisionOverlay = true;
    object.castShadow = false;
    object.receiveShadow = false;
    object.renderOrder = 4;
    group.add(object);
    return object;
  };
  const shared = {
    box: new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5),
    sphere: new THREE.SphereGeometry(1, 24, 16),
    cylinder: new THREE.CylinderGeometry(1, 1, 1, 24, 1),
  };
  const sharedEdges = {
    box: new THREE.EdgesGeometry(shared.box),
    sphere: edgesOf(new THREE.SphereGeometry(1, 12, 6)),
    cylinder: edgesOf(new THREE.CylinderGeometry(1, 1, 1, 16, 1)),
  };
  geometries.push(...Object.values(shared), ...Object.values(sharedEdges));

  for (const mesh of data.meshes) {
    const indexed = new THREE.BufferGeometry();
    indexed.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    indexed.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    const geometry = indexed.toNonIndexed();
    geometry.computeVertexNormals();
    const wire = new THREE.WireframeGeometry(indexed);
    indexed.dispose();
    geometries.push(geometry, wire);
    add(new THREE.Mesh(geometry, fillFor(mesh.material)));
    add(new THREE.LineSegments(wire, edgeFor(mesh.material)));
  }

  for (const primitive of data.primitives) {
    const matrix = primitiveMatrix(primitive);
    let fillGeometry = shared[primitive.kind];
    let edgeGeometry = sharedEdges[primitive.kind];
    if (primitive.kind === "capsule") {
      const length = new THREE.Vector3(...primitive.a).distanceTo(new THREE.Vector3(...primitive.b));
      fillGeometry = new THREE.CapsuleGeometry(primitive.radius, length, 6, 16);
      edgeGeometry = edgesOf(new THREE.CapsuleGeometry(primitive.radius, length, 3, 12));
      geometries.push(fillGeometry, edgeGeometry);
    }
    for (const object of [
      new THREE.Mesh(fillGeometry, fillFor(primitive.material)),
      new THREE.LineSegments(edgeGeometry, edgeFor(primitive.material)),
    ]) {
      object.matrixAutoUpdate = false;
      object.matrix.copy(matrix);
      add(object);
    }
  }

  return {
    group,
    setSolid(solid) {
      for (const material of fills.values()) {
        material.opacity = solid ? SOLID_OPACITY : OVERLAY_OPACITY;
        material.depthWrite = Boolean(solid);
        material.needsUpdate = true;
      }
    },
    dispose() {
      group.removeFromParent();
      for (const geometry of geometries) geometry.dispose();
      for (const material of [...fills.values(), ...edges.values()]) material.dispose();
    },
  };
}

export function readModelCollisions(invoke, path, key = path) {
  const cacheKey = `${path}|${key}`;
  if (reads.has(cacheKey)) return reads.get(cacheKey);
  const read = invoke("read_model_collisions", { path }).then(normalizeCollisions);
  read.catch(() => reads.delete(cacheKey));
  reads.set(cacheKey, read);
  while (reads.size > CACHE_SIZE) reads.delete(reads.keys().next().value);
  return read;
}
