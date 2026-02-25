const TEMPLATE_SCHEMA = "cortex.template-map.v1";
const TEMPLATE_UV_SCHEMA = "cortex.template-uv.v1";
const FILE_TYPE = "yft";
const MATERIAL_TARGET_PREFIX = "material:";
const MESH_TARGET_PREFIX = "mesh:";
const UV_AREA_EPSILON = 1e-10;
const UV_WRAP_EPSILON = 1e-8;

/**
 * Minimum UV-space area for a shell to be included in the output.
 * Keep this extremely low so tiny but valid paintable fragments
 * (door-edge slivers, trim caps, narrow seams) are not discarded.
 */
const MIN_SHELL_UV_AREA = 1e-8;

/**
 * Proximity threshold in UV space for merging nearby shells from the
 * same mesh. Shells whose bounding boxes overlap or are within this
 * distance are merged into a single island.
 */
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

function buildTriangleComponents(triangles, hasIndexArray) {
  if (triangles.length === 0) return [];

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

  const components = buildTriangleComponents(triangles, Boolean(indexArray));
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

  let rawShells = [];
  let meshCounter = 0;

  object.traverse((child) => {
    if (!child?.isMesh) return;
    const meshShells = extractMeshUvShells(child, meshCounter, { preferUv2 });
    meshCounter += 1;
    if (!meshShells.length) return;
    rawShells.push(...meshShells);
  });

  if (rawShells.length === 0) return null;

  // Merge nearby shells from the same mesh (fixes split-normal fragmentation)
  const shells = mergeNearbyShells(rawShells);

  // Sort by area descending
  shells.sort((a, b) => {
    const areaDiff = b.uvArea - a.uvArea;
    if (Math.abs(areaDiff) > 1e-10) return areaDiff;
    const meshCompare = a.meshName.localeCompare(b.meshName);
    if (meshCompare !== 0) return meshCompare;
    return a.shellIndex - b.shellIndex;
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
  };
}
