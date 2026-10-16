const LOD_PRIORITY = new Map([
  ["high", 0],
  ["med", 1],
  ["medium", 1],
  ["low", 2],
  ["vlow", 3],
  ["verylow", 3],
  ["extra", 4],
]);

export function findLiveryTexturePrefix(textureRefs) {
  for (const refs of textureRefs || []) {
    for (const [sampler, name] of Object.entries(refs || {})) {
      if (!/diffuse|albedo|basecolor/i.test(sampler)) continue;
      const match = /^(.+)_sign_\d+$/i.exec(String(name));
      if (match) return match[1].toLowerCase();
    }
  }
  return null;
}

const COLOR_SAMPLER_TOKENS = ["diffuse", "albedo", "basecolor", "platebg", "fontsampler"];
const NORMAL_SAMPLER_TOKENS = ["normal", "bump"];
const SPECULAR_SAMPLER_TOKENS = ["spec", "gloss", "reflect"];
const EMISSIVE_SAMPLER_TOKENS = ["emissive", "emiss", "glow"];

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanInteger(value) {
  const next = Number(value);
  return Number.isInteger(next) ? next : null;
}

function normalizeLodLevel(value) {
  return cleanString(value).toLowerCase().replace(/[^a-z]/g, "");
}

function includesAny(value, tokens) {
  return tokens.some((token) => value.includes(token));
}

function isAbsolutePath(value) {
  return /^[a-z]:[\\/]/i.test(value) || value.startsWith("\\\\") || value.startsWith("/");
}

export function resolveManifestAssetPath(manifestPath, relativePath) {
  const assetPath = cleanString(relativePath);
  if (!assetPath || isAbsolutePath(assetPath)) return assetPath;

  const sourcePath = cleanString(manifestPath);
  if (!sourcePath) return assetPath;

  const lastSlash = Math.max(sourcePath.lastIndexOf("/"), sourcePath.lastIndexOf("\\"));
  if (lastSlash < 0) return assetPath;

  const separator = sourcePath.lastIndexOf("\\") > sourcePath.lastIndexOf("/") ? "\\" : "/";
  const directory = sourcePath.slice(0, lastSlash);
  return collapsePathSegments(`${directory}/${assetPath}`, separator);
}

// The bridge stores shared textures beside the cache entry and references
// them as "../.shared-textures/<hash>.dds". Tauri's fs plugin rejects any path
// containing "..", so resolve the segments here instead of passing them on.
function collapsePathSegments(path, separator) {
  const parts = path.split(/[\\/]+/);
  const out = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === ".." && out.length > 1 && out[out.length - 1] !== "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join(separator);
}

export function canonicalTextureUsage(binding) {
  const paramName = cleanString(binding?.paramName).toLowerCase();
  const declaredUsage = cleanString(binding?.usage).toLowerCase();

  // Shader parameter names are authoritative. Texture filenames often contain
  // words like "spec" or "emissive" even when bound to DiffuseSampler.
  if (includesAny(paramName, COLOR_SAMPLER_TOKENS)) return "baseColor";
  if (includesAny(paramName, NORMAL_SAMPLER_TOKENS)) return "normal";
  if (includesAny(paramName, SPECULAR_SAMPLER_TOKENS)) return "specular";
  if (includesAny(paramName, EMISSIVE_SAMPLER_TOKENS)) return "emissive";
  if (paramName.includes("dirt") || paramName.includes("mud")) return "dirt";
  if (paramName.includes("detail")) return "detail";
  if (paramName.includes("mask") || paramName.includes("control")) return "mask";
  if (paramName.includes("ambient") || paramName === "aosampler") return "ambientOcclusion";

  const normalizedDeclaredUsage = declaredUsage.replace(/[^a-z]/g, "");
  if (normalizedDeclaredUsage === "basecolor") return "baseColor";
  if (normalizedDeclaredUsage === "ambientocclusion") return "ambientOcclusion";
  return normalizedDeclaredUsage || "unknown";
}

function normalizeTextureBinding(binding, manifestPath) {
  const relativePath = cleanString(binding?.relativePath);
  const usage = canonicalTextureUsage(binding);
  return {
    paramName: cleanString(binding?.paramName),
    textureName: cleanString(binding?.textureName),
    relativePath,
    resolvedPath: resolveManifestAssetPath(manifestPath, relativePath),
    source: cleanString(binding?.source),
    nameHash: Number.isFinite(Number(binding?.nameHash)) ? Number(binding.nameHash) : null,
    usage,
    uvSet: cleanInteger(binding?.uvSet),
  };
}

function selectActiveLods(entries) {
  const bestByDrawable = new Map();

  for (const entry of entries) {
    const lodLevel = normalizeLodLevel(entry?.lodLevel);
    if (!lodLevel || !LOD_PRIORITY.has(lodLevel)) continue;
    const drawableIndex = cleanInteger(entry?.drawableIndex) ?? 0;
    const priority = LOD_PRIORITY.get(lodLevel);
    const current = bestByDrawable.get(drawableIndex);
    if (!current || priority < current.priority) {
      bestByDrawable.set(drawableIndex, { lodLevel, priority });
    }
  }

  return bestByDrawable;
}

export function applyNativeManifestToMeshes(meshes, manifest, manifestPath) {
  if (!Array.isArray(meshes) || meshes.length === 0 || !manifest) return meshes;

  const meshEntries = Array.isArray(manifest?.meshes) ? manifest.meshes : [];
  const meshEntriesByName = new Map();
  for (const entry of meshEntries) {
    const name = cleanString(entry?.name);
    if (name) meshEntriesByName.set(name, entry);
  }

  const activeLods = selectActiveLods(meshEntries);

  return meshes.map((mesh, index) => {
    // Entries follow .clmesh order. Names repeat when a split by light id
    // keeps the bone name, so pair by index and fall back to the name only for
    // mesh lists that were filtered or reordered.
    const name = cleanString(mesh?.name);
    const entry = cleanString(meshEntries[index]?.name) === name ? meshEntries[index] : meshEntriesByName.get(name);
    if (!entry) return mesh;

    const drawableIndex = cleanInteger(entry.drawableIndex) ?? 0;
    const lodLevel = normalizeLodLevel(entry.lodLevel);
    const selectedLod = activeLods.get(drawableIndex)?.lodLevel || "";
    const lodActive = !selectedLod || !lodLevel || lodLevel === selectedLod;
    const textureBindings = Array.isArray(entry.textureBindings)
      ? entry.textureBindings.map((binding) => normalizeTextureBinding(binding, manifestPath))
      : [];

    return {
      ...mesh,
      textureRefs: normalizeStringMap(entry.textureRefs),
      nativeMaterial: {
        shaderName: cleanString(entry.shaderName),
        shaderHash: Number.isFinite(Number(entry.shaderHash)) ? Number(entry.shaderHash) : null,
        shaderFileName: cleanString(entry.shaderFileName),
        renderBucket: cleanInteger(entry.renderBucket) ?? 0,
        drawableIndex,
        modelIndex: cleanInteger(entry.modelIndex),
        lodModelIndex: cleanInteger(entry.lodModelIndex),
        geometryIndex: cleanInteger(entry.geometryIndex),
        extraIndex: entry.extraIndex == null ? null : cleanInteger(entry.extraIndex),
        part: cleanString(entry.part).toLowerCase() || null,
        partName: cleanString(entry.partName) || null,
        partOrigin: normalizeVector3(entry.partOrigin),
        boneChain: Array.isArray(entry.boneChain) ? entry.boneChain.map(cleanString).filter(Boolean) : null,
        // Manifest skeleton bone the whole mesh follows (manifest v10+); null when it spans several.
        boneIndex: entry.boneIndex == null ? null : cleanInteger(entry.boneIndex),
        lightBone: cleanString(entry.lightBone).toLowerCase() || null,
        lightId: normalizeLightId(entry.lightId),
        paintLayer: normalizePaintLayer(entry.paintLayer),
        // Fixed matDiffuseColor [r, g, b, a] when the material is not paintable (manifest v6+).
        diffuseColor: normalizeVector4(entry.diffuseColor),
        // Shader emissiveMultiplier (manifest v9+); null when the shader has none.
        emissiveMultiplier: Number.isFinite(entry.emissiveMultiplier) ? entry.emissiveMultiplier : null,
        lodLevel,
        selectedLod,
        lodActive,
        textureBindings,
      },
    };
  });
}

// vehicle_lightsemissive light id from vertex colour0 alpha (manifest v8+), a byte.
function normalizeLightId(value) {
  const id = cleanInteger(value);
  return id != null && id >= 0 && id <= 255 ? id : null;
}

/**
 * Light bone pivots from manifest v8: [{ name, position: [x,y,z], rotation: [x,y,z,w] }]
 * in vehicle space. Entries with malformed vectors are dropped.
 */
export function normalizeManifestLightBones(manifest) {
  if (!Array.isArray(manifest?.lightBones)) return [];
  const out = [];
  for (const bone of manifest.lightBones) {
    const name = cleanString(bone?.name).toLowerCase();
    const position = normalizeVector3(bone?.position);
    const rotation = Array.isArray(bone?.rotation) && bone.rotation.length === 4 && bone.rotation.every(Number.isFinite)
      ? bone.rotation.slice()
      : null;
    if (!name || !position) continue;
    out.push({ name, position, rotation: rotation || [0, 0, 0, 1] });
  }
  return out;
}

// Game paint layers decoded from matDiffuseColor (2, layer, 0) by the bridge
// (manifest v6+). Layer 5 is the unpainted default; the game draws it white.
export const PAINT_LAYER_SLOTS = new Map([
  [1, "primary"],
  [2, "secondary"],
  [3, "pearlescent"],
  [4, "wheels"],
  [6, "interior"],
  [7, "dashboard"],
]);

function normalizeVector4(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const vector = value.map(Number);
  return vector.every(Number.isFinite) ? vector : null;
}

function normalizeVector3(value) {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const vector = value.map(Number);
  return vector.every(Number.isFinite) ? vector : null;
}

function normalizePaintLayer(value) {
  const layer = cleanInteger(value);
  return layer !== null && layer >= 1 && layer <= 7 ? layer : null;
}

/**
 * Paint slot the game colours a mesh with. A paint layer decides: a slot key,
 * or null for the unpainted layer 5. Without one, a vehicle shader has a fixed
 * colour, except a vehicle_paint shader with no matDiffuseColor at all, which
 * keeps its default of body paint. Returns undefined when the mesh carries no
 * vehicle shader data (peds, props, other formats) so the caller can fall back
 * to names. Reads bridge nativeMaterial or the JS parser's gtaShader.
 */
export function resolvePaintLayerSlot(nativeMaterial) {
  if (Number.isInteger(nativeMaterial?.paintLayer)) return PAINT_LAYER_SLOTS.get(nativeMaterial.paintLayer) ?? null;
  const shaderName = cleanString(nativeMaterial?.shaderName).toLowerCase();
  if (!shaderName.startsWith("vehicle_")) return undefined;
  if (!nativeMaterial.diffuseColor && /^vehicle_paint\d/.test(shaderName)) return "primary";
  return null;
}

// Vehicle mod models have no texture dictionary of their own: the game looks
// up anything not embedded in the mod in the parent vehicle's TXD chain. The
// parent's manifest lists exactly that chain (its YTDs, resource parents and
// shared archive dictionaries), so fill unresolved mod bindings from it by
// name. The parent's embedded textures are private to its drawable and skipped.
export function resolveBindingsFromParentManifest(meshes, parentManifest, parentManifestPath) {
  if (!Array.isArray(meshes)) return meshes;
  const byName = new Map();
  for (const texture of Array.isArray(parentManifest?.textures) ? parentManifest.textures : []) {
    const name = cleanString(texture?.name).toLowerCase();
    const relativePath = cleanString(texture?.relativePath);
    if (!name || !relativePath || cleanString(texture?.source).toLowerCase() === "embedded") continue;
    if (!byName.has(name)) byName.set(name, texture);
  }
  if (byName.size === 0) return meshes;

  return meshes.map((mesh) => {
    const bindings = mesh?.nativeMaterial?.textureBindings;
    if (!Array.isArray(bindings) || bindings.every((binding) => binding.resolvedPath)) return mesh;
    return {
      ...mesh,
      nativeMaterial: {
        ...mesh.nativeMaterial,
        textureBindings: bindings.map((binding) => {
          if (binding.resolvedPath) return binding;
          const parent = byName.get(cleanString(binding.textureName).toLowerCase());
          if (!parent) return binding;
          return {
            ...binding,
            relativePath: cleanString(parent.relativePath),
            resolvedPath: resolveManifestAssetPath(parentManifestPath, parent.relativePath),
            source: "parent",
          };
        }),
      },
    };
  });
}

export function normalizeStringMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized = {};
  for (const [key, entry] of Object.entries(value)) {
    const nextValue = cleanString(entry);
    if (nextValue) normalized[key] = nextValue;
  }
  return normalized;
}

function colorBindingScore(binding) {
  const paramName = cleanString(binding?.paramName).toLowerCase();
  if (paramName === "diffusesampler") return 0;
  if (paramName.includes("platebg")) return 1;
  if (paramName.includes("diffuse") && !/\d$/.test(paramName)) return 2;
  if (paramName.includes("diffuse")) return 3;
  if (paramName.includes("font")) return 4;
  return 5;
}

function firstResolved(bindings, usage) {
  return bindings.find((binding) => binding.usage === usage && binding.resolvedPath) || null;
}

export function selectNativeMaterialBindings(nativeMaterial) {
  const bindings = Array.isArray(nativeMaterial?.textureBindings)
    ? nativeMaterial.textureBindings.filter((binding) => binding?.resolvedPath)
    : [];
  const colorBindings = bindings
    .filter((binding) => binding.usage === "baseColor")
    .sort((a, b) => colorBindingScore(a) - colorBindingScore(b));
  const shaderName = cleanString(nativeMaterial?.shaderName).toLowerCase();
  const baseColor = colorBindings[0] || null;
  const overlay = colorBindings.find((binding) => binding !== baseColor && binding.resolvedPath !== baseColor?.resolvedPath) || null;
  const emissive = firstResolved(bindings, "emissive") ||
    ((shaderName.includes("emissive") || shaderName.includes("light")) && !isLightDrivenEmissive(nativeMaterial)
      ? baseColor
      : null);

  return {
    baseColor,
    overlay,
    normal: firstResolved(bindings, "normal"),
    specular: firstResolved(bindings, "specular"),
    emissive,
    ambientOcclusion: firstResolved(bindings, "ambientOcclusion"),
    dirt: firstResolved(bindings, "dirt"),
    detail: firstResolved(bindings, "detail"),
    mask: firstResolved(bindings, "mask"),
  };
}

export function classifyNativeShaderProfile(nativeMaterial) {
  const shaderName = cleanString(nativeMaterial?.shaderName).toLowerCase();
  if (shaderName.includes("glass")) return "glass";
  if (shaderName.includes("cutout")) return "cutout";
  if (shaderName.includes("decal") || shaderName.includes("badge")) return "decal";
  if (shaderName.includes("emissive") || shaderName.includes("light")) return "emissive";
  if (shaderName.includes("paint")) return "paint";
  if (shaderName.includes("tire")) return "rubber";
  if (shaderName.includes("cloth")) return "cloth";
  if (shaderName.includes("chrome") || shaderName.includes("metal")) return "metal";
  return "default";
}

// Drawable render bucket 1 is GTA's alpha pass: the shader blends by its
// diffuse alpha. vehicle_lightsemissive and dash emissives live there, so their
// texture alpha decides how much of the lens glows.
export function usesNativeAlphaBlending(nativeMaterial) {
  return nativeMaterial?.renderBucket === 1;
}

// vehicle_lightsemissive glows only while the lamp or siren its light id or
// bone names is lit; the emergency light rig draws that glow. Unlit, it is a
// plain textured surface, so it never self-emits.
export function isLightDrivenEmissive(nativeMaterial) {
  return cleanString(nativeMaterial?.shaderName).toLowerCase().includes("lightsemissive");
}

export function summarizeNativeMaterialMeshes(meshes) {
  const entries = (Array.isArray(meshes) ? meshes : [])
    .map((mesh) => mesh?.nativeMaterial)
    .filter(Boolean);
  const activeEntries = entries.filter((entry) => entry.lodActive !== false);
  const resolvedPaths = new Set();
  let bindingCount = 0;
  let resolvedBindingCount = 0;
  let unsupportedBindingCount = 0;
  const shaderNames = new Set();

  for (const entry of activeEntries) {
    if (entry.shaderName) shaderNames.add(entry.shaderName);
    const selected = selectNativeMaterialBindings(entry);
    const supportedBindings = new Set([
      selected.baseColor,
      selected.overlay,
      selected.normal,
      selected.specular,
      selected.emissive,
      selected.ambientOcclusion,
    ].filter(Boolean));

    for (const binding of entry.textureBindings || []) {
      bindingCount += 1;
      if (binding.resolvedPath) {
        resolvedBindingCount += 1;
        resolvedPaths.add(binding.resolvedPath.toLowerCase());
      }
      if (binding.resolvedPath && !supportedBindings.has(binding)) unsupportedBindingCount += 1;
    }
  }

  return {
    available: entries.length > 0,
    meshCount: entries.length,
    activeMeshCount: activeEntries.length,
    hiddenLodMeshCount: entries.length - activeEntries.length,
    bindingCount,
    resolvedBindingCount,
    missingBindingCount: bindingCount - resolvedBindingCount,
    uniqueTextureCount: resolvedPaths.size,
    shaderCount: shaderNames.size,
    unsupportedBindingCount,
  };
}
