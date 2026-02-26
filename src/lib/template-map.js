const TEMPLATE_SCHEMA = "cortex.template-map.v1";
const TEMPLATE_UV_SCHEMA = "cortex.template-uv.v1";
const FILE_TYPE = "yft";
const MATERIAL_TARGET_PREFIX = "material:";
const MESH_TARGET_PREFIX = "mesh:";
const UV_AREA_EPSILON = 1e-10;
const UV_WRAP_EPSILON = 1e-8;
const POSITION_AREA_EPSILON = 1e-12;
const NORMAL_EPSILON = 1e-12;
const UV_ISLAND_MISSING = -1;
const UV_TOPOLOGY_QUANTIZE = 1e6;

/**
 * Minimum UV-space area for a shell to be included in the output.
 * Keep this extremely low so tiny but valid paintable fragments
 * (door-edge slivers, trim caps, narrow seams) are not discarded.
 */
const MIN_SHELL_UV_AREA = 1e-8;
const SHELL_MERGE_PROXIMITY = 0.02;

/* ── helpers ─────────────────────────────────────────────────────── */

function getFileName(path) {
  if (!path) return "";
  const raw = path.toString();
  const parts = raw.split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

function getModelName(fileName) {
  if (!fileName) return "model";
  return fileName.replace(/\.[^.]+$/, "") || "model";
}

function getMaterialNames(material) {
  if (!material) return [];
  const list = Array.isArray(material) ? material : [material];
  const names = [];
  for (const item of list) {
    const name = item?.name?.trim();
    if (!name) continue;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

function resolveMeshName(mesh, fallbackIndex) {
  const label = mesh?.userData?.meshLabel || mesh?.name;
  const normalized = typeof label === "string" ? label.trim() : "";
  if (normalized) return normalized;
  return `mesh-${fallbackIndex + 1}`;
}

function pushTarget(map, targetKey, entry, dedupe) {
  if (!targetKey || !entry) return;
  const signature = `${targetKey}::${entry.meshName}::${entry.materialName}`;
  if (dedupe.has(signature)) return;
  dedupe.add(signature);

  if (!map.has(targetKey)) map.set(targetKey, []);
  map.get(targetKey).push(entry);
}

function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    const meshCompare = a.meshName.localeCompare(b.meshName);
    if (meshCompare !== 0) return meshCompare;
    return a.materialName.localeCompare(b.materialName);
  });
}

/* ── UV attribute reading ────────────────────────────────────────── */

function readUvAt(uvAttribute, index) {
  const u = uvAttribute.getX(index);
  const v = uvAttribute.getY(index);
  if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
  return [u, v];
}

function readPositionAt(positionAttribute, index) {
  const x = positionAttribute.getX(index);
  const y = positionAttribute.getY(index);
  const z = positionAttribute.getZ(index);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
}

function readNormalAt(normalAttribute, index) {
  const x = normalAttribute.getX(index);
  const y = normalAttribute.getY(index);
  const z = normalAttribute.getZ(index);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return normalizeVec3(x, y, z);
}

function normalizeVec3(x, y, z) {
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length <= NORMAL_EPSILON) return null;
  return [x / length, y / length, z / length];
}

function transformPointByMatrix4(point, matrix4) {
  const elements = matrix4?.elements;
  if (!elements || elements.length < 16) return [point[0], point[1], point[2]];
  const x = point[0];
  const y = point[1];
  const z = point[2];
  const tx = elements[0] * x + elements[4] * y + elements[8] * z + elements[12];
  const ty = elements[1] * x + elements[5] * y + elements[9] * z + elements[13];
  const tz = elements[2] * x + elements[6] * y + elements[10] * z + elements[14];
  if (!Number.isFinite(tx) || !Number.isFinite(ty) || !Number.isFinite(tz)) {
    return [point[0], point[1], point[2]];
  }
  return [tx, ty, tz];
}

function transformDirectionByMatrix4(direction, matrix4) {
  const elements = matrix4?.elements;
  if (!elements || elements.length < 16) return [direction[0], direction[1], direction[2]];
  const x = direction[0];
  const y = direction[1];
  const z = direction[2];
  const tx = elements[0] * x + elements[4] * y + elements[8] * z;
  const ty = elements[1] * x + elements[5] * y + elements[9] * z;
  const tz = elements[2] * x + elements[6] * y + elements[10] * z;
  return normalizeVec3(tx, ty, tz) || [direction[0], direction[1], direction[2]];
}

function computeTriangleNormal(p0, p1, p2) {
  const ax = p1[0] - p0[0];
  const ay = p1[1] - p0[1];
  const az = p1[2] - p0[2];
  const bx = p2[0] - p0[0];
  const by = p2[1] - p0[1];
  const bz = p2[2] - p0[2];
  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  return normalizeVec3(nx, ny, nz);
}

function resolveMaterialNameFromIndex(material, materialIndex) {
  if (Array.isArray(material)) {
    const indexed = material[Math.max(0, materialIndex)] || material[0] || null;
    const name = indexed?.name?.trim();
    return name || "";
  }

  const singleName = material?.name?.trim();
  return singleName || "";
}

function findMaterialIndexForDrawOffset(groups, drawOffset) {
  if (!Array.isArray(groups) || groups.length === 0) return 0;

  for (const group of groups) {
    const start = Number(group?.start) || 0;
    const count = Number(group?.count) || 0;
    if (drawOffset >= start && drawOffset < start + count) {
      const materialIndex = Number(group?.materialIndex);
      return Number.isInteger(materialIndex) ? materialIndex : 0;
    }
  }

  return 0;
}

function hasUvVariation(attribute) {
  if (!attribute || typeof attribute.getX !== "function" || typeof attribute.getY !== "function") return false;
  const count = Math.min(attribute.count || 0, 512);
  if (count < 3) return false;

  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;

  for (let i = 0; i < count; i += 1) {
    const u = attribute.getX(i);
    const v = attribute.getY(i);
    if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
    minU = Math.min(minU, u);
    minV = Math.min(minV, v);
    maxU = Math.max(maxU, u);
    maxV = Math.max(maxV, v);
  }

  if (!Number.isFinite(minU) || !Number.isFinite(minV) || !Number.isFinite(maxU) || !Number.isFinite(maxV)) {
    return false;
  }

  return Math.abs(maxU - minU) > UV_WRAP_EPSILON || Math.abs(maxV - minV) > UV_WRAP_EPSILON;
}

/**
 * Score a UV attribute for template suitability. Prefers channels
 * whose UVs mostly fall within the [0,1] range and cover a large
 * portion of that space — hallmarks of a properly-unwrapped
 * livery/template UV layout.
 */
function scoreUvAttribute(attribute) {
  if (!attribute || typeof attribute.getX !== "function" || typeof attribute.getY !== "function") return -1;

  const count = attribute.count || 0;
  if (count < 3) return -1;

  const sampleCount = Math.min(count, 512);
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  let validCount = 0;
  let inNormalRange = 0;

  for (let i = 0; i < sampleCount; i += 1) {
    const u = attribute.getX(i);
    const v = attribute.getY(i);
    if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
    validCount += 1;
    minU = Math.min(minU, u);
    minV = Math.min(minV, v);
    maxU = Math.max(maxU, u);
    maxV = Math.max(maxV, v);
    if (u >= -0.05 && u <= 1.05 && v >= -0.05 && v <= 1.05) inNormalRange += 1;
  }

  if (validCount < 3) return -1;

  const rangeU = maxU - minU;
  const rangeV = maxV - minV;
  if (rangeU < UV_WRAP_EPSILON && rangeV < UV_WRAP_EPSILON) return -1;

  // Fraction of sampled UVs inside the normal [0,1] tile
  const normalRatio = inNormalRange / validCount;

  // How much of the 0–1 space the channel covers (capped at 1)
  const effectiveRangeU = Math.min(rangeU, 1.0);
  const effectiveRangeV = Math.min(rangeV, 1.0);
  const coverage = effectiveRangeU * effectiveRangeV;

  return normalRatio * 0.5 + coverage * 0.5;
}

function chooseTemplateUvAttribute(geometry, options = {}) {
  const attributes = geometry?.attributes;
  if (!attributes) return null;

  const candidates = [attributes.uv, attributes.uv2, attributes.uv3, attributes.uv4];
  const preferUv2 = options.preferUv2 !== false;
  const preferredOrder = preferUv2 ? [1, 2, 3, 0] : [0, 1, 2, 3];

  for (const index of preferredOrder) {
    const attr = candidates[index];
    if (hasUvVariation(attr)) return attr;
  }

  let bestAttr = null;
  let bestScore = -1;
  for (const index of preferredOrder) {
    const attr = candidates[index];
    const score = scoreUvAttribute(attr);
    if (score > bestScore) {
      bestScore = score;
      bestAttr = attr;
    }
  }
  if (bestAttr) return bestAttr;

  for (const index of preferredOrder) {
    const attr = candidates[index];
    if (attr) return attr;
  }

  return null;
}

/* ── Triangle extraction ─────────────────────────────────────────── */

/**
 * Build triangle records directly from the selected UV attribute.
 * UVs are preserved exactly as authored so generated template pixels
 * map 1:1 with how the runtime samples the texture.
 */
function buildTriangleRecords(uvAttribute, indexArray) {
  const uvCount = uvAttribute.count || 0;
  const indexCount = indexArray ? indexArray.length : uvCount;
  if (indexCount < 3) return [];

  const triangles = [];
  for (let i = 0; i + 2 < indexCount; i += 3) {
    const i0 = indexArray ? indexArray[i] : i;
    const i1 = indexArray ? indexArray[i + 1] : i + 1;
    const i2 = indexArray ? indexArray[i + 2] : i + 2;

    if (i0 >= uvCount || i1 >= uvCount || i2 >= uvCount) continue;

    const uv0 = readUvAt(uvAttribute, i0);
    const uv1 = readUvAt(uvAttribute, i1);
    const uv2 = readUvAt(uvAttribute, i2);
    if (!uv0 || !uv1 || !uv2) continue;

    // Keep raw UV coordinates so template pixels map 1:1 with texture sampling.
    const u0 = uv0[0];
    const v0 = uv0[1];
    const u1 = uv1[0];
    const v1 = uv1[1];
    const u2 = uv2[0];
    const v2 = uv2[1];

    const twiceArea = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
    const area = Math.abs(twiceArea) * 0.5;
    if (!Number.isFinite(area) || area <= UV_AREA_EPSILON) continue;

    triangles.push({
      i0,
      i1,
      i2,
      area,
      uvs: [u0, v0, u1, v1, u2, v2],
    });
  }

  return triangles;
}

/* ── Connected component detection ───────────────────────────────── */

function quantizeUvForTopology(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * UV_TOPOLOGY_QUANTIZE);
}

function makeUvVertexKey(u, v) {
  return `${quantizeUvForTopology(u)},${quantizeUvForTopology(v)}`;
}

function makeUvEdgeKey(u0, v0, u1, v1) {
  const a = makeUvVertexKey(u0, v0);
  const b = makeUvVertexKey(u1, v1);
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function resolveTriangleUvValues(triangle) {
  if (Array.isArray(triangle?.uvs) && triangle.uvs.length >= 6) return triangle.uvs;
  if (Array.isArray(triangle?.uv) && triangle.uv.length >= 6) return triangle.uv;
  return null;
}

/**
 * Build UV-island components by shared UV edges.
 * This is resilient to split normals / duplicated mesh vertices because
 * connectivity is established in UV-space, not index-space.
 */
function buildTriangleComponentsByUvEdges(triangles) {
  const edgeToTriangles = new Map();
  const adjacency = Array.from({ length: triangles.length }, () => new Set());

  for (let triangleIndex = 0; triangleIndex < triangles.length; triangleIndex += 1) {
    const triangle = triangles[triangleIndex];
    const uv = resolveTriangleUvValues(triangle);
    if (!uv) continue;
    if (!uv.every((value) => Number.isFinite(value))) continue;

    const edgeKeys = [
      makeUvEdgeKey(uv[0], uv[1], uv[2], uv[3]),
      makeUvEdgeKey(uv[2], uv[3], uv[4], uv[5]),
      makeUvEdgeKey(uv[4], uv[5], uv[0], uv[1]),
    ];

    for (const edgeKey of edgeKeys) {
      if (!edgeToTriangles.has(edgeKey)) edgeToTriangles.set(edgeKey, []);
      edgeToTriangles.get(edgeKey).push(triangleIndex);
    }
  }

  for (const linkedTriangles of edgeToTriangles.values()) {
    if (!Array.isArray(linkedTriangles) || linkedTriangles.length < 2) continue;
    for (let i = 0; i < linkedTriangles.length; i += 1) {
      for (let j = i + 1; j < linkedTriangles.length; j += 1) {
        const a = linkedTriangles[i];
        const b = linkedTriangles[j];
        adjacency[a].add(b);
        adjacency[b].add(a);
      }
    }
  }

  const visited = new Uint8Array(triangles.length);
  const components = [];

  for (let start = 0; start < triangles.length; start += 1) {
    if (visited[start]) continue;

    visited[start] = 1;
    const queue = [start];
    const component = [];

    while (queue.length > 0) {
      const triangleIndex = queue.pop();
      component.push(triangleIndex);

      for (const neighborIndex of adjacency[triangleIndex]) {
        if (visited[neighborIndex]) continue;
        visited[neighborIndex] = 1;
        queue.push(neighborIndex);
      }
    }

    if (component.length > 0) components.push(component);
  }

  return components;
}

function buildTriangleComponentsByIndex(triangles, hasIndexArray) {
  if (!hasIndexArray) {
    return [triangles.map((_, index) => index)];
  }

  const trianglesByVertex = new Map();
  triangles.forEach((triangle, triangleIndex) => {
    for (const vertexIndex of [triangle.i0, triangle.i1, triangle.i2]) {
      if (!trianglesByVertex.has(vertexIndex)) trianglesByVertex.set(vertexIndex, []);
      trianglesByVertex.get(vertexIndex).push(triangleIndex);
    }
  });

  const visited = new Uint8Array(triangles.length);
  const components = [];

  for (let start = 0; start < triangles.length; start += 1) {
    if (visited[start]) continue;

    visited[start] = 1;
    const queue = [start];
    const component = [];

    while (queue.length > 0) {
      const triangleIndex = queue.pop();
      component.push(triangleIndex);

      const triangle = triangles[triangleIndex];
      for (const vertexIndex of [triangle.i0, triangle.i1, triangle.i2]) {
        const neighbors = trianglesByVertex.get(vertexIndex);
        if (!neighbors) continue;
        for (const nextIndex of neighbors) {
          if (visited[nextIndex]) continue;
          visited[nextIndex] = 1;
          queue.push(nextIndex);
        }
      }
    }

    if (component.length > 0) components.push(component);
  }

  return components;
}

function buildTriangleComponents(triangles, options = {}) {
  if (triangles.length === 0) return [];

  const mode = options?.mode || "auto";
  const hasUvTriangles = triangles.some((triangle) => resolveTriangleUvValues(triangle));
  if (mode === "uv" || (mode === "auto" && hasUvTriangles)) {
    return buildTriangleComponentsByUvEdges(triangles);
  }

  return buildTriangleComponentsByIndex(triangles, Boolean(options?.hasIndexArray));
}

/* ── Shell record construction ───────────────────────────────────── */

/**
 * Build a shell record from a connected component. Triangle UVs are
 * kept in their original coordinate space so that mergeNearbyShells
 * can compare actual spatial positions. Normalization to (0,0) origin
 * is deferred until after the merge pass completes.
 */
function buildShellRecord(component, triangles, meshName, materialName, componentIndex, componentCount) {
  const flatTriangles = [];
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  let uvArea = 0;

  for (const triangleIndex of component) {
    const triangle = triangles[triangleIndex];
    if (!triangle) continue;

    const values = triangle.uvs;
    flatTriangles.push(values[0], values[1], values[2], values[3], values[4], values[5]);

    minU = Math.min(minU, values[0], values[2], values[4]);
    minV = Math.min(minV, values[1], values[3], values[5]);
    maxU = Math.max(maxU, values[0], values[2], values[4]);
    maxV = Math.max(maxV, values[1], values[3], values[5]);
    uvArea += triangle.area;
  }

  if (!Number.isFinite(minU) || !Number.isFinite(minV) || !Number.isFinite(maxU) || !Number.isFinite(maxV)) {
    return null;
  }

  // Skip degenerate shells with negligible area
  if (uvArea < MIN_SHELL_UV_AREA) return null;

  // Keep UVs in their original coordinate space so that the
  // proximity-based merge pass can compare actual spatial positions.
  // Normalization to (0,0) origin happens after merging completes.
  return {
    meshName,
    materialName,
    shellName: componentCount > 1 ? `${meshName}::${componentIndex + 1}` : meshName,
    shellIndex: componentIndex,
    triangleCount: component.length,
    uvArea,
    bounds: {
      minU,
      minV,
      maxU,
      maxV,
    },
    triangles: flatTriangles,
  };
}

/* ── Shell merging ───────────────────────────────────────────────── */

/**
 * Merge shells from the same mesh whose bounding boxes overlap or
 * are within SHELL_MERGE_PROXIMITY of each other. GTA V models
 * commonly have split normals that fragment what should be one
 * contiguous UV island into many tiny shells. Merging them back
 * together produces a much cleaner, more legible template.
 */
function mergeNearbyShells(shells) {
  if (shells.length <= 1) return shells;

  // Group shells by meshName first — only merge within the same mesh
  const byMesh = new Map();
  for (const shell of shells) {
    const key = shell.meshName;
    if (!byMesh.has(key)) byMesh.set(key, []);
    byMesh.get(key).push(shell);
  }

  const merged = [];

  for (const [meshName, group] of byMesh) {
    if (group.length <= 1) {
      merged.push(...group);
      continue;
    }

    // Union-find for merging
    const parent = group.map((_, i) => i);
    const find = (x) => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    const unite = (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    };

    // Check all pairs for bounding box proximity
    for (let i = 0; i < group.length; i += 1) {
      const a = group[i].bounds;
      for (let j = i + 1; j < group.length; j += 1) {
        const b = group[j].bounds;

        // Check if bounding boxes overlap or are within threshold
        const gapU = Math.max(0, Math.max(a.minU, b.minU) - Math.min(a.maxU, b.maxU));
        const gapV = Math.max(0, Math.max(a.minV, b.minV) - Math.min(a.maxV, b.maxV));

        if (gapU <= SHELL_MERGE_PROXIMITY && gapV <= SHELL_MERGE_PROXIMITY) {
          unite(i, j);
        }
      }
    }

    // Collect merged groups
    const clusters = new Map();
    for (let i = 0; i < group.length; i += 1) {
      const root = find(i);
      if (!clusters.has(root)) clusters.set(root, []);
      clusters.get(root).push(group[i]);
    }

    let clusterIndex = 0;
    const clusterCount = clusters.size;

    for (const cluster of clusters.values()) {
      if (cluster.length === 1) {
        const shell = cluster[0];
        shell.shellName = clusterCount > 1 ? `${meshName}::${clusterIndex + 1}` : meshName;
        shell.shellIndex = clusterIndex;
        merged.push(shell);
      } else {
        // Merge all triangles from the cluster into one shell
        const allTriangles = [];
        let minU = Infinity;
        let minV = Infinity;
        let maxU = -Infinity;
        let maxV = -Infinity;
        let totalArea = 0;
        let totalTriCount = 0;
        const materialName = cluster[0].materialName;

        for (const shell of cluster) {
          const tris = shell.triangles;
          for (let i = 0; i + 5 < tris.length; i += 6) {
            allTriangles.push(tris[i], tris[i + 1], tris[i + 2], tris[i + 3], tris[i + 4], tris[i + 5]);
          }
          minU = Math.min(minU, shell.bounds.minU);
          minV = Math.min(minV, shell.bounds.minV);
          maxU = Math.max(maxU, shell.bounds.maxU);
          maxV = Math.max(maxV, shell.bounds.maxV);
          totalArea += shell.uvArea;
          totalTriCount += shell.triangleCount;
        }

        merged.push({
          meshName,
          materialName,
          shellName: clusterCount > 1 ? `${meshName}::${clusterIndex + 1}` : meshName,
          shellIndex: clusterIndex,
          triangleCount: totalTriCount,
          uvArea: totalArea,
          bounds: { minU, minV, maxU, maxV },
          triangles: allTriangles,
        });
      }

      clusterIndex += 1;
    }
  }

  return merged;
}

/* ── Per-mesh extraction ─────────────────────────────────────────── */

function extractMeshUvShells(mesh, fallbackIndex, options = {}) {
  const geometry = mesh?.geometry;
  const uvAttribute = chooseTemplateUvAttribute(geometry, options);
  if (!uvAttribute) return [];

  const indexArray = geometry?.index?.array || null;
  const triangles = buildTriangleRecords(uvAttribute, indexArray);
  if (triangles.length === 0) return [];

  const components = buildTriangleComponents(triangles, {
    mode: "uv",
    hasIndexArray: Boolean(indexArray),
  });
  if (components.length === 0) return [];

  const meshName = resolveMeshName(mesh, fallbackIndex);
  const baseMaterial = mesh?.userData?.baseMaterial || mesh?.material;
  const materialNames = getMaterialNames(baseMaterial);
  const materialName = materialNames[0] || "";

  const shells = [];
  components.forEach((component, componentIndex) => {
    const shell = buildShellRecord(component, triangles, meshName, materialName, componentIndex, components.length);
    if (shell) shells.push(shell);
  });

  return shells;
}

function extractMeshProxyGeometry(mesh, fallbackIndex, options = {}) {
  const geometry = mesh?.geometry;
  const attributes = geometry?.attributes;
  const positionAttribute = attributes?.position;
  if (!positionAttribute) return null;
  const normalAttribute = attributes?.normal;
  const normalCount = normalAttribute?.count || 0;

  const uvAttribute = chooseTemplateUvAttribute(geometry, options);
  const uvCount = uvAttribute?.count || 0;
  const indexArray = geometry?.index?.array || null;
  const indexCount = indexArray ? indexArray.length : positionAttribute.count || 0;
  if (indexCount < 3) return null;
  mesh?.updateWorldMatrix?.(true, false);
  const worldMatrix = mesh?.matrixWorld || null;

  const meshName = resolveMeshName(mesh, fallbackIndex);
  const baseMaterial = mesh?.userData?.baseMaterial || mesh?.material;
  const materialNames = getMaterialNames(baseMaterial);
  const defaultMaterialName = materialNames[0] || "";
  const groups = Array.isArray(geometry?.groups) ? geometry.groups : [];

  const triangles = [];
  const uvTriangles = [];
  const uvTriangleToProxy = [];

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let drawOffset = 0; drawOffset + 2 < indexCount; drawOffset += 3) {
    const i0 = indexArray ? indexArray[drawOffset] : drawOffset;
    const i1 = indexArray ? indexArray[drawOffset + 1] : drawOffset + 1;
    const i2 = indexArray ? indexArray[drawOffset + 2] : drawOffset + 2;

    if (i0 >= positionAttribute.count || i1 >= positionAttribute.count || i2 >= positionAttribute.count) continue;

    const lp0 = readPositionAt(positionAttribute, i0);
    const lp1 = readPositionAt(positionAttribute, i1);
    const lp2 = readPositionAt(positionAttribute, i2);
    if (!lp0 || !lp1 || !lp2) continue;

    const p0 = transformPointByMatrix4(lp0, worldMatrix);
    const p1 = transformPointByMatrix4(lp1, worldMatrix);
    const p2 = transformPointByMatrix4(lp2, worldMatrix);

    const ax = p1[0] - p0[0];
    const ay = p1[1] - p0[1];
    const az = p1[2] - p0[2];
    const bx = p2[0] - p0[0];
    const by = p2[1] - p0[1];
    const bz = p2[2] - p0[2];
    const cx = ay * bz - az * by;
    const cy = az * bx - ax * bz;
    const cz = ax * by - ay * bx;
    const twiceArea = Math.hypot(cx, cy, cz);
    if (!Number.isFinite(twiceArea) || twiceArea <= POSITION_AREA_EPSILON) continue;

    const faceNormal = normalizeVec3(cx, cy, cz) || computeTriangleNormal(p0, p1, p2);
    if (!faceNormal) continue;

    const n0 = normalAttribute && i0 < normalCount ? readNormalAt(normalAttribute, i0) : null;
    const n1 = normalAttribute && i1 < normalCount ? readNormalAt(normalAttribute, i1) : null;
    const n2 = normalAttribute && i2 < normalCount ? readNormalAt(normalAttribute, i2) : null;
    const wn0 = n0 ? transformDirectionByMatrix4(n0, worldMatrix) : null;
    const wn1 = n1 ? transformDirectionByMatrix4(n1, worldMatrix) : null;
    const wn2 = n2 ? transformDirectionByMatrix4(n2, worldMatrix) : null;
    const v0Normal = wn0 || faceNormal;
    const v1Normal = wn1 || faceNormal;
    const v2Normal = wn2 || faceNormal;

    const materialIndex = findMaterialIndexForDrawOffset(groups, drawOffset);
    const materialName = resolveMaterialNameFromIndex(baseMaterial, materialIndex) || defaultMaterialName;

    let uvValues = null;
    if (uvAttribute && i0 < uvCount && i1 < uvCount && i2 < uvCount) {
      const uv0 = readUvAt(uvAttribute, i0);
      const uv1 = readUvAt(uvAttribute, i1);
      const uv2 = readUvAt(uvAttribute, i2);
      if (uv0 && uv1 && uv2) {
        const u0 = uv0[0];
        const v0 = uv0[1];
        const u1 = uv1[0];
        const v1 = uv1[1];
        const u2 = uv2[0];
        const v2 = uv2[1];
        const uvTwiceArea = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
        const uvArea = Math.abs(uvTwiceArea) * 0.5;
        if (Number.isFinite(uvArea) && uvArea > UV_AREA_EPSILON) {
          uvValues = [u0, v0, u1, v1, u2, v2];
        }
      }
    }

    minX = Math.min(minX, p0[0], p1[0], p2[0]);
    minY = Math.min(minY, p0[1], p1[1], p2[1]);
    minZ = Math.min(minZ, p0[2], p1[2], p2[2]);
    maxX = Math.max(maxX, p0[0], p1[0], p2[0]);
    maxY = Math.max(maxY, p0[1], p1[1], p2[1]);
    maxZ = Math.max(maxZ, p0[2], p1[2], p2[2]);

    const proxyIndex = triangles.length;
    triangles.push({
      i0,
      i1,
      i2,
      meshName,
      materialIndex,
      materialName,
      normal: faceNormal,
      vertexNormals: [
        v0Normal[0],
        v0Normal[1],
        v0Normal[2],
        v1Normal[0],
        v1Normal[1],
        v1Normal[2],
        v2Normal[0],
        v2Normal[1],
        v2Normal[2],
      ],
      positions: [
        p0[0],
        p0[1],
        p0[2],
        p1[0],
        p1[1],
        p1[2],
        p2[0],
        p2[1],
        p2[2],
      ],
      uv: uvValues,
      uvIslandId: UV_ISLAND_MISSING,
    });

    if (uvValues) {
      uvTriangles.push({ i0, i1, i2, uvs: uvValues });
      uvTriangleToProxy.push(proxyIndex);
    }
  }

  if (triangles.length === 0) return null;

  if (uvTriangles.length > 0) {
    const uvComponents = buildTriangleComponents(uvTriangles, {
      mode: "uv",
      hasIndexArray: Boolean(indexArray),
    });
    uvComponents.forEach((component, componentIndex) => {
      for (const uvTriangleIndex of component) {
        const proxyIndex = uvTriangleToProxy[uvTriangleIndex];
        if (!Number.isInteger(proxyIndex)) continue;
        if (!triangles[proxyIndex]) continue;
        triangles[proxyIndex].uvIslandId = componentIndex;
      }
    });
  }

  return {
    meshName,
    materialName: defaultMaterialName,
    triangleCount: triangles.length,
    bounds: {
      minX,
      minY,
      minZ,
      maxX,
      maxY,
      maxZ,
    },
    triangles,
  };
}

/* ── Public API: Template Map ────────────────────────────────────── */

export function buildYftTemplateMap({ object, modelPath = "", liveryTarget = "", windowTarget = "" }) {
  if (!object) return null;

  const targetMap = new Map();
  const dedupe = new Set();
  const seenMeshes = new Set();
  let meshCounter = 0;

  object.traverse((child) => {
    if (!child?.isMesh) return;

    const meshName = resolveMeshName(child, meshCounter);
    meshCounter += 1;
    seenMeshes.add(meshName);

    const baseMaterial = child.userData?.baseMaterial || child.material;
    const materialNames = getMaterialNames(baseMaterial);
    const primaryMaterial = materialNames[0] || "";

    pushTarget(targetMap, `${MESH_TARGET_PREFIX}${meshName}`, { meshName, materialName: primaryMaterial }, dedupe);

    for (const materialName of materialNames) {
      pushTarget(targetMap, `${MATERIAL_TARGET_PREFIX}${materialName}`, { meshName, materialName }, dedupe);
    }
  });

  const orderedTargets = {};
  const orderedKeys = [...targetMap.keys()].sort((a, b) => a.localeCompare(b));
  for (const key of orderedKeys) {
    orderedTargets[key] = sortEntries(targetMap.get(key));
  }

  const fileName = getFileName(modelPath);
  const modelName = getModelName(fileName);

  return {
    schema: TEMPLATE_SCHEMA,
    fileType: FILE_TYPE,
    source: {
      fileName,
      modelName,
      generatedAt: new Date().toISOString(),
    },
    targets: orderedTargets,
    inference: {
      liveryTarget: liveryTarget || "",
      windowTarget: windowTarget || "",
    },
    stats: {
      targetCount: orderedKeys.length,
      mappedMeshCount: seenMeshes.size,
    },
  };
}

/* ── Public API: Template PSD Source ──────────────────────────────── */

export function buildYftTemplatePsdSource({ object, modelPath = "", preferUv2 = true }) {
  if (!object) return null;

  const rawShells = [];
  const proxyMeshes = [];
  let meshCounter = 0;

  object.traverse((child) => {
    if (!child?.isMesh) return;

    const meshShells = extractMeshUvShells(child, meshCounter, { preferUv2 });
    if (meshShells.length > 0) rawShells.push(...meshShells);

    const proxyGeometry = extractMeshProxyGeometry(child, meshCounter, { preferUv2 });
    if (proxyGeometry?.triangleCount) proxyMeshes.push(proxyGeometry);

    meshCounter += 1;
  });

  if (rawShells.length === 0) return null;

  // UV-edge connected components already produce robust islands without
  // proximity-based post-merge heuristics.
  const shells = rawShells;

  // Sort by area descending
  shells.sort((a, b) => {
    const areaDiff = b.uvArea - a.uvArea;
    if (Math.abs(areaDiff) > 1e-10) return areaDiff;
    const meshCompare = a.meshName.localeCompare(b.meshName);
    if (meshCompare !== 0) return meshCompare;
    return a.shellIndex - b.shellIndex;
  });

  proxyMeshes.sort((a, b) => {
    const meshCompare = a.meshName.localeCompare(b.meshName);
    if (meshCompare !== 0) return meshCompare;
    return (a.materialName || "").localeCompare(b.materialName || "");
  });

  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  let triangleCount = 0;

  for (const shell of shells) {
    triangleCount += shell.triangleCount;
    minU = Math.min(minU, shell.bounds.minU);
    minV = Math.min(minV, shell.bounds.minV);
    maxU = Math.max(maxU, shell.bounds.maxU);
    maxV = Math.max(maxV, shell.bounds.maxV);
  }

  const fileName = getFileName(modelPath);
  const modelName = getModelName(fileName);

  return {
    schema: TEMPLATE_UV_SCHEMA,
    fileType: FILE_TYPE,
    source: {
      fileName,
      modelName,
      generatedAt: new Date().toISOString(),
    },
    bounds: {
      minU,
      minV,
      maxU,
      maxV,
    },
    meshCount: shells.length,
    triangleCount,
    meshes: shells,
    proxyMeshCount: proxyMeshes.length,
    proxyMeshes,
  };
}
