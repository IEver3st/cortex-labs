import * as THREE from "three";
import { readFile } from "@tauri-apps/plugin-fs";
import { parseDDSAsync } from "./dds.js";
import { describeDdsPixelFormat } from "./dds-decode.js";
import {
  createBptcDdsTexture,
  createS3tcDdsTexture,
  inspectDdsCompression,
  isFullyTransparentDds,
} from "./native-dds.js";
import {
  classifyNativeShaderProfile,
  selectNativeMaterialBindings,
  isLightDrivenEmissive,
  summarizeNativeMaterialMeshes,
  usesNativeAlphaBlending,
} from "./native-material-plan.js";
import { hasEmissiveDim, patchNativeShader } from "./native-shader.js";
import { formatLabelForDds } from "./texture-vram.js";
import { isLampBlocker, makeDepthOnlyOccluder, releaseDepthOnlyOccluder } from "./native-occluder.js";
import { applyMaterialDrawOrder, releaseMaterialDrawOrder } from "./native-draw-order.js";

const DXT_FORMATS = new Set(["DXT1", "DXT3", "DXT5"]);
const BC7_FORMATS = new Set([98, 99]);
const LOAD_CONCURRENCY = 16;
const PROGRESS_RENDER_INTERVAL_MS = 120;
const CACHED_TEXTURE_LRU_LIMIT = 200;

// Per-WebGLRenderer cache for active source textures plus a bounded LRU for
// bridge-extracted DDS files (`.shared-textures/<sha256>.dds` and `yft-cache`).
// Configured GPU texture variants live on each entry so cache hits reuse the
// already-uploaded WebGLTexture instead of cloning and re-uploading on toggle.
// Isolated per renderer so WebGL textures never cross contexts.
const rendererTextureCaches = new WeakMap();

function isContentAddressedSharedPath(path) {
  const normalized = String(path || "").replace(/\\/g, "/").toLowerCase();
  return normalized.includes("/.shared-textures/") && normalized.endsWith(".dds");
}

function isCacheableNativePath(path) {
  const normalized = String(path || "").replace(/\\/g, "/").toLowerCase();
  return (normalized.includes("/.shared-textures/") || normalized.includes("/yft-cache/")) && normalized.endsWith(".dds");
}

function getRendererCache(renderer) {
  if (!renderer || typeof renderer !== "object") return null;
  let cache = rendererTextureCaches.get(renderer);
  if (!cache) {
    cache = new Map();
    rendererTextureCaches.set(renderer, cache);
  }
  return cache;
}

function disposeCacheEntry(entry) {
  const disposed = new Set();
  if (entry.variants) {
    for (const variant of entry.variants.values()) {
      if (variant && !disposed.has(variant)) {
        disposed.add(variant);
        variant.dispose?.();
      }
    }
    entry.variants.clear();
  }
  if (entry.texture && !disposed.has(entry.texture)) {
    entry.texture.dispose?.();
  }
  entry.texture = null;
}

function evictTextureLru(cache) {
  let idleCached = 0;
  for (const entry of cache.values()) {
    if (entry.refs === 0 && entry.cacheable && !entry.stale) idleCached += 1;
  }
  if (idleCached <= CACHED_TEXTURE_LRU_LIMIT) return;
  for (const [key, entry] of cache) {
    if (entry.refs > 0 || !entry.cacheable || entry.stale) continue;
    cache.delete(key);
    disposeCacheEntry(entry);
    idleCached -= 1;
    if (idleCached <= CACHED_TEXTURE_LRU_LIMIT) break;
  }
}

export function clearNativeTextureCache(renderer = null, { onlyMutable = false } = {}) {
  const cache = renderer ? rendererTextureCaches.get(renderer) : null;
  if (!cache) return;
  for (const [key, entry] of cache) {
    if (onlyMutable && entry.immutable) continue;
    if (entry.refs <= 0) {
      cache.delete(key);
      disposeCacheEntry(entry);
    } else {
      entry.stale = true;
    }
  }
}

function getOrCreateCachedVariant(entry, role, binding, renderer) {
  const colorMode = role === "baseColor" || role === "overlay" || role === "emissive" ? "srgb" : "linear";
  const uvSet = Number.isInteger(binding?.uvSet) && binding.uvSet >= 0 && binding.uvSet <= 3 ? binding.uvSet : 0;
  const variantKey = `${colorMode}|${uvSet}`;
  let texture = entry.variants.get(variantKey);
  if (texture) return texture;
  // Reuse the uploaded source texture directly for the first variant so normal
  // single-role DDS files avoid cloning and re-uploading to WebGL.
  if (entry.variants.size === 0) {
    texture = entry.texture;
  } else {
    texture = entry.texture.clone();
  }
  texture.channel = uvSet;
  texture.colorSpace = colorMode === "srgb" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = renderer?.capabilities?.getMaxAnisotropy?.() || 1;
  texture.needsUpdate = true;
  entry.variants.set(variantKey, texture);
  return texture;
}

async function acquireNativeTextureSource(path, renderer, signal, { checkTransparency = true } = {}) {
  const cache = getRendererCache(renderer);
  if (!cache) {
    const texture = await loadNativeTextureSource(path, renderer, signal, { checkTransparency });
    const uncached = { texture, variants: new Map() };
    return {
      texture,
      getVariant: (role, binding) => getOrCreateCachedVariant(uncached, role, binding, renderer),
      release: () => disposeCacheEntry(uncached),
    };
  }
  const key = String(path || "").toLowerCase();
  const immutable = isContentAddressedSharedPath(path);
  const cacheable = isCacheableNativePath(path);
  let entry = cache.get(key);
  if (entry && entry.stale) {
    entry = null;
  }
  if (entry) {
    cache.delete(key);
    cache.set(key, entry);
    entry.refs += 1;
  } else {
    entry = { promise: null, texture: null, variants: new Map(), refs: 1, immutable, cacheable, stale: false };
    entry.promise = loadNativeTextureSource(path, renderer, null, { checkTransparency }).then(
      (texture) => {
        entry.texture = texture;
        if (entry.refs <= 0 && (!entry.cacheable || entry.stale)) {
          disposeCacheEntry(entry);
          if (cache.get(key) === entry) cache.delete(key);
        } else if (entry.refs <= 0) {
          evictTextureLru(cache);
        }
        return texture;
      },
      (error) => {
        if (cache.get(key) === entry) cache.delete(key);
        throw error;
      },
    );
    cache.set(key, entry);
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0) return;
    if (!entry.cacheable || entry.stale) {
      if (cache.get(key) === entry) cache.delete(key);
      disposeCacheEntry(entry);
    } else {
      evictTextureLru(cache);
    }
  };
  try {
    const texture = await entry.promise;
    if (signal?.aborted) throw makeAbortError();
    return {
      texture,
      getVariant: (role, binding) => getOrCreateCachedVariant(entry, role, binding, renderer),
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}

function createRenderBatcher(onRender, interval) {
  let last = 0;
  let timer = 0;
  const flush = () => {
    timer = 0;
    last = performance.now();
    onRender?.();
  };
  return {
    request() {
      if (!onRender || timer) return;
      const wait = interval - (performance.now() - last);
      if (wait <= 0) flush();
      else timer = setTimeout(flush, wait);
    },
    finish() {
      if (timer) clearTimeout(timer);
      flush();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = 0;
    },
  };
}

const PROFILE_SETTINGS = {
  default: { metalness: 0.18, roughness: 0.58 },
  paint: { metalness: 0.28, roughness: 0.28, clearcoat: 0.72, clearcoatRoughness: 0.22 },
  // No transmission: three draws transmissive materials before every
  // transparent one, which breaks the game's alpha bucket order (a model's
  // materials in shader order). Lamp lenses then drew under the decals and
  // emitters behind them, and opaque lens texels still let the cabin through.
  // Game glass blends by its texture's alpha only.
  glass: { metalness: 0, roughness: 0.12, transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide },
  cutout: { metalness: 0.05, roughness: 0.62, transparent: true, alphaTest: 0.18, depthWrite: true, side: THREE.DoubleSide },
  decal: { metalness: 0.08, roughness: 0.46, transparent: true, alphaTest: 0.04, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 },
  emissive: { metalness: 0.08, roughness: 0.3, emissiveIntensity: 1.25 },
  // vehicle_tire often covers rims and hubs too; a bound spec map raises
  // specularIntensity to 1 so those parts keep their authored sheen.
  rubber: { metalness: 0, roughness: 0.7, specularIntensity: 0.4 },
  cloth: { metalness: 0, roughness: 0.86, side: THREE.DoubleSide },
  metal: { metalness: 0.82, roughness: 0.24 },
};

function makeAbortError() {
  const error = new Error("Native material loading was cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw makeAbortError();
}

function canUploadCompression(renderer, extension) {
  try {
    return Boolean(renderer?.extensions?.has?.(extension));
  } catch {
    return false;
  }
}

function extractTextureMeta(texture, path, { fourCc = "", dxgiFormat = 0, source = "" } = {}) {
  const image = texture?.image;
  const mip0 = Array.isArray(texture?.mipmaps) && texture.mipmaps.length > 0 ? texture.mipmaps[0] : null;
  const width = Number(image?.width || mip0?.width || 0);
  const height = Number(image?.height || mip0?.height || 0);
  const mipmaps = Array.isArray(texture?.mipmaps) && texture.mipmaps.length > 0
    ? texture.mipmaps.length
    : texture?.generateMipmaps === false
      ? 1
      : width > 0 && height > 0
        ? Math.floor(Math.log2(Math.max(width, height))) + 1
        : 1;
  const name = String(path || "").split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "texture";
  return {
    name,
    path: path || "",
    width,
    height,
    mipmaps,
    format: formatLabelForDds({ fourCc, dxgiFormat, source }),
  };
}

/** Loads a game DDS as a three.js texture (GPU-compressed when supported). */
export async function loadNativeTextureSource(path, renderer, signal, { checkTransparency = true } = {}) {
  throwIfAborted(signal);
  const bytes = await readFile(path);
  throwIfAborted(signal);
  const ddsInfo = inspectDdsCompression(bytes);
  // Probe transparency before transferring `bytes.buffer` to the decode worker,
  // and only when the texture is bound as a baseColor diffuse map.
  const fullyTransparent = checkTransparency ? isFullyTransparentDds(bytes) : false;
  const texture = await createNativeTextureSource(bytes, renderer, ddsInfo);
  if (fullyTransparent) texture.userData.fullyTransparent = true;
  texture.userData.vramInfo = extractTextureMeta(texture, path, {
    ...ddsInfo,
    source: texture.userData?.nativeMaterialSource || "",
  });
  return texture;
}

async function createNativeTextureSource(bytes, renderer, ddsInfo = null) {
  const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const { fourCc, dxgiFormat } = ddsInfo || inspectDdsCompression(bytes);

  // GPU upload first; any failure there falls back to the CPU decoder.
  try {
    if (DXT_FORMATS.has(fourCc) && canUploadCompression(renderer, "WEBGL_compressed_texture_s3tc")) {
      const compressed = createS3tcDdsTexture(buffer, fourCc);
      if (compressed) {
        compressed.userData.nativeMaterialSource = "dds-compressed-s3tc";
        return compressed;
      }
    }

    if (BC7_FORMATS.has(dxgiFormat) && canUploadCompression(renderer, "EXT_texture_compression_bptc")) {
      const compressed = createBptcDdsTexture(buffer);
      if (compressed) {
        compressed.userData.nativeMaterialSource = "dds-compressed-bptc";
        return compressed;
      }
    }
  } catch {
    // Fall through to the decoder, which tolerates truncated mip chains.
  }

  // Same orientation as the compressed uploads above: the game's UVs address
  // the file's top row at v = 0, so the decoder must not flip rows here.
  // Capture format description before transferring `buffer` zero-copy to the worker.
  const formatDesc = describeDdsPixelFormat(bytes);
  const decoded = await parseDDSAsync(buffer, { log: false, flipY: false, transfer: true });
  if (!decoded) throw new Error(`Unsupported texture format: ${formatDesc}`);
  decoded.userData = { ...(decoded.userData || {}), nativeMaterialSource: "dds-decoded" };
  return decoded;
}

function prepareNativeUvChannels(geometry) {
  if (!geometry?.attributes) return;
  const gtaUvSets = Array.isArray(geometry.userData?.gtaUvSets)
    ? geometry.userData.gtaUvSets
    : [geometry.attributes.uv || null, geometry.attributes.uv2 || null, geometry.attributes.uv3 || null, geometry.attributes.uv4 || null];
  geometry.userData = geometry.userData || {};
  geometry.userData.gtaUvSets = gtaUvSets;

  if (!geometry.userData.nativeUvRestore) {
    geometry.userData.nativeUvRestore = {
      uv: geometry.attributes.uv || null,
      uv1: geometry.attributes.uv1 || null,
      uv2: geometry.attributes.uv2 || null,
      uv3: geometry.attributes.uv3 || null,
      uv4: geometry.attributes.uv4 || null,
    };
  }

  ["uv", "uv1", "uv2", "uv3"].forEach((name, index) => {
    const attribute = gtaUvSets[index];
    if (attribute) geometry.setAttribute(name, attribute);
    else if (name !== "uv") geometry.deleteAttribute(name);
  });
}

function restoreNativeUvChannels(geometry) {
  const restore = geometry?.userData?.nativeUvRestore;
  if (!geometry || !restore) return;
  for (const name of ["uv", "uv1", "uv2", "uv3", "uv4"]) {
    if (restore[name]) geometry.setAttribute(name, restore[name]);
    else geometry.deleteAttribute(name);
  }
  delete geometry.userData.nativeUvRestore;
}

export function createNativeMaterial(mesh, nativeMaterial, selectedBindings = null) {
  const profile = classifyNativeShaderProfile(nativeMaterial);
  const settings = PROFILE_SETTINGS[profile] || PROFILE_SETTINGS.default;
  // Paint, rubber and spec-mapped meshes need MeshPhysicalMaterial (clearcoat,
  // sheen, specularIntensity/specularIntensityMap). Everything else compiles a
  // much lighter MeshStandardMaterial program with identical visuals.
  const needsPhysical = profile === "paint" || profile === "rubber" || Boolean(selectedBindings?.specular?.resolvedPath);
  const MaterialClass = needsPhysical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
  const material = new MaterialClass({
    color: 0xffffff,
    emissive: profile === "emissive" && !isLightDrivenEmissive(nativeMaterial) ? 0xffffff : 0x000000,
    side: THREE.FrontSide,
    ...settings,
  });
  // Opaque profiles (emissive lenses especially) would otherwise draw texels
  // the game blends away at full strength. Depth stays on so stacked emitters
  // keep a stable nearest-wins order while the camera moves; only empty texels
  // are discarded so they neither draw nor hide what is behind them.
  if (!material.transparent && usesNativeAlphaBlending(nativeMaterial)) {
    material.transparent = true;
    material.alphaTest = 0.02;
  }
  material.name = mesh?.material?.name || nativeMaterial?.shaderName || "native-material";
  material.userData = {
    ...(material.userData || {}),
    nativeMaterial: true,
    nativeProfile: profile,
    baseRoughness: material.roughness,
    baseMetalness: material.metalness,
  };
  const emissiveDim = hasEmissiveDim(mesh?.geometry);
  material.onBeforeCompile = (shader) => {
    const overlayMap = material.userData.nativeOverlayMap;
    if (overlayMap) {
      // Kept so a livery swap can change the overlay without a recompile.
      material.userData.nativeOverlayUniform = { value: overlayMap };
      shader.uniforms.nativeOverlayMap = material.userData.nativeOverlayUniform;
    }
    patchNativeShader(shader, {
      overlay: Boolean(overlayMap),
      specularFromRed: Boolean(material.specularIntensityMap),
      diffusePoints: true,
      emissiveDim,
    });
  };
  material.customProgramCacheKey = () =>
    `cortex-native-v4|${material.userData.nativeOverlayMap ? "overlay" : ""}|${material.specularIntensityMap ? "spec-r" : ""}|${emissiveDim ? "dim" : ""}`;
  return material;
}

function configureOverlayShader(material, texture, geometry, binding) {
  const uvSet = Number.isInteger(binding?.uvSet) ? binding.uvSet : 0;
  const uvAttribute = geometry?.userData?.gtaUvSets?.[uvSet] || geometry?.attributes?.uv;
  if (!uvAttribute) return false;
  const hadOverlay = Boolean(material.userData.nativeOverlayMap);
  geometry.setAttribute("nativeOverlayUv", uvAttribute);
  material.userData.nativeOverlayMap = texture;
  // A compiled program keeps the uniform made by onBeforeCompile.
  if (material.userData.nativeOverlayUniform) material.userData.nativeOverlayUniform.value = texture;
  if (!hadOverlay) material.needsUpdate = true;
  return true;
}

/**
 * Puts `texture` in a native material's livery overlay (the second diffuse
 * slot paint shaders mix over the paint) on UV set `uvSet`. A material that
 * had no overlay gains one and recompiles once; after that only the uniform
 * changes, so callers hide an overlay with a transparent texture rather than
 * removing it. Returns false when the mesh has no such UV set.
 */
export function setNativeOverlayTexture(material, mesh, texture, uvSet = 0) {
  if (!material || !texture) return false;
  const hadOverlay = Boolean(material.userData.nativeOverlayMap);
  const uvAttribute = mesh?.geometry?.userData?.gtaUvSets?.[uvSet] || mesh?.geometry?.attributes?.uv;
  if (!uvAttribute) return false;
  mesh.geometry.setAttribute("nativeOverlayUv", uvAttribute);
  material.userData.nativeOverlayMap = texture;
  if (hadOverlay && material.userData.nativeOverlayUniform) material.userData.nativeOverlayUniform.value = texture;
  else material.needsUpdate = true;
  return true;
}

// 1x1 stand-ins, one per kind and UV set, that look like the empty slot.
const PLACEHOLDER_PIXELS = {
  baseColor: [255, 255, 255, 255],
  overlay: [0, 0, 0, 0],
  normal: [128, 128, 255, 255],
  specular: [255, 255, 255, 255],
  emissive: [0, 0, 0, 255],
  ambientOcclusion: [255, 255, 255, 255],
};
const placeholders = new Map();

function placeholderTexture(role, binding) {
  const uvSet = Number.isInteger(binding?.uvSet) && binding.uvSet >= 0 && binding.uvSet <= 3 ? binding.uvSet : 0;
  const key = `${role}|${uvSet}`;
  let texture = placeholders.get(key);
  if (!texture) {
    texture = new THREE.DataTexture(new Uint8Array(PLACEHOLDER_PIXELS[role]), 1, 1, THREE.RGBAFormat);
    texture.channel = uvSet;
    texture.colorSpace = role === "baseColor" || role === "overlay" || role === "emissive"
      ? THREE.SRGBColorSpace
      : THREE.NoColorSpace;
    texture.userData.nativePlaceholder = true;
    texture.needsUpdate = true;
    placeholders.set(key, texture);
  }
  return texture;
}

/*
 * A shader program depends on which texture slots are filled and their UV
 * sets, not on the textures themselves. Filling every slot a material will
 * use with a stand-in up front compiles its final program once, at setup;
 * each real texture that arrives is then a uniform change, not a recompile.
 * Compiles block the main thread, and per-texture variants were most of the
 * native load time. A slot whose texture fails keeps its neutral stand-in.
 */
export function assignNativePlaceholder(material, mesh, role, binding) {
  const texture = placeholderTexture(role, binding);
  if (role === "baseColor") material.map = texture;
  else if (role === "overlay") configureOverlayShader(material, texture, mesh.geometry, binding);
  else if (role === "normal") material.normalMap = texture;
  else if (role === "specular") material.specularIntensityMap = texture;
  else if (role === "emissive") material.emissiveMap = texture;
  else if (role === "ambientOcclusion") material.aoMap = texture;
}

/** Returns true when the texture turned the mesh into a lamp blocker (native-occluder.js). */
export function assignNativeTextureSlot(material, mesh, role, texture, binding) {
  if (material.userData.nativeDepthOnly) return false;
  let needsCompile = false;
  if (role === "baseColor" && isLampBlocker(mesh.userData?.nativeMaterial, binding, texture, mesh.geometry)) {
    makeDepthOnlyOccluder(material, mesh);
    material.needsUpdate = true;
    return true;
  } else if (role === "baseColor") {
    const prev = material.map;
    material.map = texture;
    if (!prev || prev.channel !== texture.channel) needsCompile = true;
    // Game glass is as opaque as its texture's alpha. The profile's fixed
    // opacity only covers the stand-in; kept on, it turns housings and
    // reflectors modelled as glass with opaque textures see-through.
    if (material.userData.nativeProfile === "glass") material.opacity = 1;
  } else if (role === "overlay") {
    configureOverlayShader(material, texture, mesh.geometry, binding);
  } else if (role === "normal") {
    const prev = material.normalMap;
    material.normalMap = texture;
    material.normalScale?.set?.(1, 1);
    if (!prev || prev.channel !== texture.channel) needsCompile = true;
  } else if (role === "specular") {
    const prev = material.specularIntensityMap;
    material.specularIntensityMap = texture;
    material.specularIntensity = 1;
    if (!prev || prev.channel !== texture.channel) needsCompile = true;
  } else if (role === "emissive") {
    const prev = material.emissiveMap;
    material.emissiveMap = texture;
    material.emissive.setHex(0xffffff);
    material.emissiveIntensity = Math.max(material.emissiveIntensity || 0, 1);
    if (!prev || prev.channel !== texture.channel) needsCompile = true;
  } else if (role === "ambientOcclusion") {
    const prev = material.aoMap;
    material.aoMap = texture;
    material.aoMapIntensity = 1;
    if (!prev || prev.channel !== texture.channel) needsCompile = true;
  }
  if (needsCompile) material.needsUpdate = true;
  return false;
}

function buildAssignments(object, excludeMesh) {
  const assignmentsByPath = new Map();
  const materials = new Set();
  const meshes = [];

  object.traverse((child) => {
    if (!child.isMesh || excludeMesh?.(child)) return;
    const nativeMaterial = child.userData?.nativeMaterial;
    child.userData.nativeLodActive = nativeMaterial ? nativeMaterial.lodActive !== false : true;
    if (!nativeMaterial || nativeMaterial.lodActive === false) return;

    if (!child.userData.baseMaterial) child.userData.baseMaterial = child.material;
    prepareNativeUvChannels(child.geometry);
    const selected = selectNativeMaterialBindings(nativeMaterial);
    const material = createNativeMaterial(child, nativeMaterial, selected);
    child.userData.nativeMaterialObject = material;
    child.renderOrder = nativeMaterial.renderBucket || 0;
    if (material.transparent) applyMaterialDrawOrder(child);
    materials.add(material);
    meshes.push(child);

    for (const role of ["baseColor", "overlay", "normal", "specular", "emissive", "ambientOcclusion"]) {
      const binding = selected[role];
      if (!binding?.resolvedPath) continue;
      assignNativePlaceholder(material, child, role, binding);
      const pathKey = binding.resolvedPath.toLowerCase();
      if (!assignmentsByPath.has(pathKey)) {
        assignmentsByPath.set(pathKey, { path: binding.resolvedPath, assignments: [], needsTransparencyCheck: false });
      }
      const bucket = assignmentsByPath.get(pathKey);
      if (role === "baseColor") bucket.needsTransparencyCheck = true;
      bucket.assignments.push({ material, mesh: child, role, binding });
    }
  });

  return { assignmentsByPath, materials, meshes };
}

async function runPool(items, worker, concurrency = LOAD_CONCURRENCY) {
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

export async function loadNativeMaterialView({
  object,
  renderer,
  signal,
  excludeMesh,
  onSetup,
  onProgress,
  onRender,
}) {
  throwIfAborted(signal);
  const nativeMeshEntries = [];
  object?.traverse?.((child) => {
    if (child.isMesh && !excludeMesh?.(child)) nativeMeshEntries.push({ nativeMaterial: child.userData?.nativeMaterial });
  });
  const summary = summarizeNativeMaterialMeshes(nativeMeshEntries);
  const { assignmentsByPath, materials, meshes } = buildAssignments(object, excludeMesh);
  const requests = Array.from(assignmentsByPath.values()).sort((a, b) => {
    const priority = { baseColor: 0, overlay: 1, emissive: 1, normal: 2, specular: 3, ambientOcclusion: 4 };
    const aPriority = Math.min(...a.assignments.map((entry) => priority[entry.role] ?? 9));
    const bPriority = Math.min(...b.assignments.map((entry) => priority[entry.role] ?? 9));
    return aPriority - bPriority;
  });
  const sourceReleases = [];
  const textureMetas = [];
  const failures = [];
  // Occluders this view made. Kept here rather than read back from mesh
  // flags, which other code (a livery override) may have changed since.
  const occluders = new Set();
  let loaded = 0;
  let disposed = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const mesh of meshes) {
      const nativeMaterial = mesh.userData?.nativeMaterialObject;
      if (mesh.material === nativeMaterial && mesh.userData?.baseMaterial) {
        mesh.material = mesh.userData.baseMaterial;
      }
      if (mesh.geometry?.attributes?.nativeOverlayUv) mesh.geometry.deleteAttribute("nativeOverlayUv");
      restoreNativeUvChannels(mesh.geometry);
      if (occluders.has(mesh)) releaseDepthOnlyOccluder(mesh);
      releaseMaterialDrawOrder(mesh);
      if (mesh.userData) {
        delete mesh.userData.nativeMaterialObject;
        delete mesh.userData.nativeLodActive;
        delete mesh.userData.nativeDepthOnly;
      }
    }
    for (const material of materials) material.dispose?.();
    for (const release of sourceReleases) release();
    occluders.clear();
    sourceReleases.length = 0;
  };

  onSetup?.({ ...summary, plannedTextureCount: requests.length });
  const render = createRenderBatcher(onRender, PROGRESS_RENDER_INTERVAL_MS);

  try {
    await runPool(requests, async (request) => {
      throwIfAborted(signal);
      if (disposed) throw makeAbortError();
      try {
        const { texture: source, getVariant, release } = await acquireNativeTextureSource(
          request.path,
          renderer,
          signal,
          // isFullyTransparentDds early-outs on >64px headers, so always probing
          // avoids cache-order misses if a small texture is first bound non-diffuse.
          { checkTransparency: true },
        );
        if (disposed || signal?.aborted) {
          release();
          throw makeAbortError();
        }
        sourceReleases.push(release);
        if (source.userData?.vramInfo) textureMetas.push(source.userData.vramInfo);

        for (const assignment of request.assignments) {
          const texture = getVariant(assignment.role, assignment.binding);
          if (assignNativeTextureSlot(assignment.material, assignment.mesh, assignment.role, texture, assignment.binding)) {
            occluders.add(assignment.mesh);
          }
        }
        loaded += 1;
      } catch (error) {
        if (error?.name === "AbortError" || disposed) throw error;
        const message = (typeof error === "string" ? error : error?.message) || String(error || "") || "Texture load failed.";
        failures.push({ path: request.path, message });
        console.warn("[native-materials] Texture failed:", request.path, message);
      }

      if (disposed || signal?.aborted) return;
      onProgress?.({
        ...summary,
        plannedTextureCount: requests.length,
        loadedTextureCount: loaded,
        failedTextureCount: failures.length,
      });
      render.request();
    });
  } catch (error) {
    render.cancel();
    dispose();
    throw error;
  }
  render.finish();

  return {
    summary: {
      ...summary,
      plannedTextureCount: requests.length,
      loadedTextureCount: loaded,
      failedTextureCount: failures.length,
      failures,
      textures: textureMetas,
    },
    dispose,
  };
}
