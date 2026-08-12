const LOD_PRIORITY = new Map([
  ["high", 0],
  ["med", 1],
  ["medium", 1],
  ["low", 2],
  ["vlow", 3],
  ["verylow", 3],
  ["extra", 4],
]);

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
  const normalizedRelative = assetPath.replace(/[\\/]+/g, separator);
  return `${directory}${separator}${normalizedRelative}`;
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

  return meshes.map((mesh) => {
    const entry = meshEntriesByName.get(cleanString(mesh?.name));
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
        lodLevel,
        selectedLod,
        lodActive,
        textureBindings,
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
    ((shaderName.includes("emissive") || shaderName.includes("light")) ? baseColor : null);

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
