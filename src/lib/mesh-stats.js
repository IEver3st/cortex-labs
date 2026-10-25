import * as THREE from "three";
import { skipsSolidWire } from "./viewer-render-effects.js";

// Counts describe what the viewer draws right now: hidden parts, inactive
// LODs and effect geometry (lamp glow, blockers) are left out, matching the
// solid wireframe pass. GTA drawables are triangle lists, so the triangle
// count is the model's polygon count.

function isDrawn(material) {
  return Boolean(material) && material.visible !== false && material.colorWrite !== false;
}

function forEachDrawnMesh(roots, visit) {
  const walk = (object) => {
    if (!object.visible) return;
    if (object.isMesh && !skipsSolidWire(object)) visit(object);
    for (const child of object.children) walk(child);
  };
  for (const root of roots) if (root) walk(root);
}

export function meshTriangleCount(mesh) {
  const geometry = mesh?.geometry;
  const total = geometry?.index ? geometry.index.count : geometry?.attributes?.position?.count || 0;
  const rangeStart = Math.max(0, geometry?.drawRange?.start || 0);
  const rangeEnd = Math.min(total, rangeStart + (geometry?.drawRange?.count ?? Infinity));
  if (Array.isArray(mesh.material) && geometry.groups.length) {
    let indices = 0;
    for (const group of geometry.groups) {
      if (!isDrawn(mesh.material[group.materialIndex])) continue;
      const start = Math.max(group.start, rangeStart);
      const end = Math.min(group.start + group.count, rangeEnd);
      if (end > start) indices += end - start;
    }
    return Math.floor(indices / 3);
  }
  return Math.floor(Math.max(0, rangeEnd - rangeStart) / 3);
}

// Cheap enough for every drawn frame; the full summary runs only when it changes.
export function countDrawnGeometry(roots) {
  let meshes = 0;
  let triangles = 0;
  let vertices = 0;
  forEachDrawnMesh(roots, (mesh) => {
    meshes += 1;
    triangles += meshTriangleCount(mesh);
    vertices += mesh.geometry.attributes.position.count;
  });
  return { meshes, triangles, vertices };
}

export function createMeshStatsReporter() {
  let key = null;
  return {
    reset() {
      key = null;
    },
    report(roots, onStats) {
      const counts = roots ? countDrawnGeometry(roots) : null;
      const next = counts ? `${counts.meshes}:${counts.triangles}:${counts.vertices}` : "";
      if (next === key) return;
      key = next;
      onStats?.(roots ? summarizeMeshStats(roots) : null);
    },
  };
}

const _box = new THREE.Box3();

export function summarizeMeshStats(roots) {
  let meshes = 0;
  let triangles = 0;
  let vertices = 0;
  const shaders = new Set();
  const textures = new Set();
  let nativeMeshes = 0;
  const bounds = new THREE.Box3();
  forEachDrawnMesh(roots, (mesh) => {
    meshes += 1;
    triangles += meshTriangleCount(mesh);
    vertices += mesh.geometry.attributes.position.count;
    const native = mesh.userData?.nativeMaterial;
    if (native) {
      nativeMeshes += 1;
      if (native.shaderName) shaders.add(String(native.shaderName).toLowerCase());
    }
    for (const name of Object.values(mesh.userData?.textureRefs || {})) {
      if (typeof name === "string" && name.trim()) textures.add(name.trim().toLowerCase());
    }
    const geometry = mesh.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (geometry.boundingBox && !geometry.boundingBox.isEmpty()) {
      bounds.union(_box.copy(geometry.boundingBox).applyMatrix4(mesh.matrixWorld));
    }
  });
  let size = null;
  if (!bounds.isEmpty()) {
    const extent = bounds.getSize(new THREE.Vector3());
    // Ground plane is XZ; the longer horizontal side is the length whichever
    // way the model faces.
    size = { length: Math.max(extent.x, extent.z), width: Math.min(extent.x, extent.z), height: extent.y };
  }
  return {
    meshes,
    triangles,
    vertices,
    // Only GTA drawables name their shaders and textures; other formats leave these unknown.
    shaders: nativeMeshes ? shaders.size : null,
    textures: textures.size ? textures.size : null,
    size,
  };
}
