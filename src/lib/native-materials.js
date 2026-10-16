import * as THREE from "three";
import { readFile } from "@tauri-apps/plugin-fs";
import { parseDDSAsync } from "./dds";
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
import { patchNativeShader } from "./native-shader.js";
import { isLampBlocker, makeDepthOnlyOccluder, releaseDepthOnlyOccluder } from "./native-occluder.js";
import { applyMaterialDrawOrder, releaseMaterialDrawOrder } from "./native-draw-order.js";

const DXT_FORMATS = new Set(["DXT1", "DXT3", "DXT5"]);
const BC7_FORMATS = new Set([98, 99]);
const LOAD_CONCURRENCY = 3;

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

/** Loads a game DDS as a three.js texture (GPU-compressed when supported). */
export async function loadNativeTextureSource(path, renderer, signal) {
  throwIfAborted(signal);
  const bytes = await readFile(path);
  throwIfAborted(signal);
  const texture = await createNativeTextureSource(bytes, renderer);
  if (isFullyTransparentDds(bytes)) texture.userData.fullyTransparent = true;
  return texture;
}

async function createNativeTextureSource(bytes, renderer) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const { fourCc, dxgiFormat } = inspectDdsCompression(bytes);

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
  const decoded = await parseDDSAsync(buffer, { log: false, flipY: false });
  if (!decoded) throw new Error(`Unsupported texture format: ${describeDdsPixelFormat(bytes)}`);
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

function createNativeMaterial(mesh, nativeMaterial) {
  const profile = classifyNativeShaderProfile(nativeMaterial);
  const settings = PROFILE_SETTINGS[profile] || PROFILE_SETTINGS.default;
  const material = new THREE.MeshPhysicalMaterial({
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
    });
  };
  material.customProgramCacheKey = () =>
    `cortex-native-v3|${material.userData.nativeOverlayMap ? "overlay" : ""}|${material.specularIntensityMap ? "spec-r" : ""}`;
  return material;
}

function textureVariantKey(path, role, uvSet) {
  const colorMode = role === "baseColor" || role === "overlay" || role === "emissive" ? "srgb" : "linear";
  return `${path.toLowerCase()}|${colorMode}|${Number.isInteger(uvSet) ? uvSet : 0}`;
}

function configureTextureVariant(source, role, binding, renderer) {
  const texture = source.clone();
  const uvSet = Number.isInteger(binding?.uvSet) && binding.uvSet >= 0 && binding.uvSet <= 3
    ? binding.uvSet
    : 0;
  texture.channel = uvSet;
  texture.colorSpace = role === "baseColor" || role === "overlay" || role === "emissive"
    ? THREE.SRGBColorSpace
    : THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = renderer?.capabilities?.getMaxAnisotropy?.() || 1;
  texture.needsUpdate = true;
  return texture;
}

function configureOverlayShader(material, texture, geometry, binding) {
  const uvSet = Number.isInteger(binding?.uvSet) ? binding.uvSet : 0;
  const uvAttribute = geometry?.userData?.gtaUvSets?.[uvSet] || geometry?.attributes?.uv;
  if (!uvAttribute) return false;
  geometry.setAttribute("nativeOverlayUv", uvAttribute);
  material.userData.nativeOverlayMap = texture;
  // A compiled program keeps the uniform made by onBeforeCompile.
  if (material.userData.nativeOverlayUniform) material.userData.nativeOverlayUniform.value = texture;
  material.needsUpdate = true;
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
function assignPlaceholder(material, mesh, role, binding) {
  const texture = placeholderTexture(role, binding);
  if (role === "baseColor") material.map = texture;
  else if (role === "overlay") configureOverlayShader(material, texture, mesh.geometry, binding);
  else if (role === "normal") material.normalMap = texture;
  else if (role === "specular") material.specularIntensityMap = texture;
  else if (role === "emissive") material.emissiveMap = texture;
  else if (role === "ambientOcclusion") material.aoMap = texture;
}

/** Returns true when the texture turned the mesh into a lamp blocker (native-occluder.js). */
function assignTexture(material, mesh, role, texture, binding) {
  if (material.userData.nativeDepthOnly) return false;
  if (role === "baseColor" && isLampBlocker(mesh.userData?.nativeMaterial, binding, texture, mesh.geometry)) {
    makeDepthOnlyOccluder(material, mesh);
    return true;
  } else if (role === "baseColor") {
    material.map = texture;
    // Game glass is as opaque as its texture's alpha. The profile's fixed
    // opacity only covers the stand-in; kept on, it turns housings and
    // reflectors modelled as glass with opaque textures see-through.
    if (material.userData.nativeProfile === "glass") material.opacity = 1;
  } else if (role === "overlay") {
    configureOverlayShader(material, texture, mesh.geometry, binding);
  } else if (role === "normal") {
    material.normalMap = texture;
    material.normalScale?.set?.(1, 1);
  } else if (role === "specular") {
    material.specularIntensityMap = texture;
    material.specularIntensity = 1;
  } else if (role === "emissive") {
    material.emissiveMap = texture;
    material.emissive.setHex(0xffffff);
    material.emissiveIntensity = Math.max(material.emissiveIntensity || 0, 1);
  } else if (role === "ambientOcclusion") {
    material.aoMap = texture;
    material.aoMapIntensity = 1;
  }
  material.needsUpdate = true;
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
    const material = createNativeMaterial(child, nativeMaterial);
    child.userData.nativeMaterialObject = material;
    child.renderOrder = nativeMaterial.renderBucket || 0;
    if (material.transparent) applyMaterialDrawOrder(child);
    materials.add(material);
    meshes.push(child);

    const selected = selectNativeMaterialBindings(nativeMaterial);
    for (const role of ["baseColor", "overlay", "normal", "specular", "emissive", "ambientOcclusion"]) {
      const binding = selected[role];
      if (!binding?.resolvedPath) continue;
      assignPlaceholder(material, child, role, binding);
      const pathKey = binding.resolvedPath.toLowerCase();
      if (!assignmentsByPath.has(pathKey)) {
        assignmentsByPath.set(pathKey, { path: binding.resolvedPath, assignments: [] });
      }
      assignmentsByPath.get(pathKey).assignments.push({ material, mesh: child, role, binding });
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
  const sourceTextures = new Set();
  const variants = new Map();
  const failures = [];
  // Occluders this view made. Kept here rather than read back from mesh
  // flags, which other code (a livery override) may have changed since.
  const occluders = new Set();
  let loaded = 0;

  const dispose = () => {
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
    for (const texture of variants.values()) texture.dispose?.();
    for (const texture of sourceTextures) texture.dispose?.();
    occluders.clear();
    variants.clear();
    sourceTextures.clear();
  };

  onSetup?.({ ...summary, plannedTextureCount: requests.length });

  try {
    await runPool(requests, async (request) => {
      throwIfAborted(signal);
      try {
        const source = await loadNativeTextureSource(request.path, renderer, signal);
        throwIfAborted(signal);
        sourceTextures.add(source);

        for (const assignment of request.assignments) {
          const key = textureVariantKey(request.path, assignment.role, assignment.binding.uvSet);
          let texture = variants.get(key);
          if (!texture) {
            texture = configureTextureVariant(source, assignment.role, assignment.binding, renderer);
            variants.set(key, texture);
          }
          if (assignTexture(assignment.material, assignment.mesh, assignment.role, texture, assignment.binding)) {
            occluders.add(assignment.mesh);
          }
        }
        loaded += 1;
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        const message = (typeof error === "string" ? error : error?.message) || String(error || "") || "Texture load failed.";
        failures.push({ path: request.path, message });
        console.warn("[native-materials] Texture failed:", request.path, message);
      }

      onProgress?.({
        ...summary,
        plannedTextureCount: requests.length,
        loadedTextureCount: loaded,
        failedTextureCount: failures.length,
      });
      onRender?.();
    });
  } catch (error) {
    dispose();
    throw error;
  }

  return {
    summary: {
      ...summary,
      plannedTextureCount: requests.length,
      loadedTextureCount: loaded,
      failedTextureCount: failures.length,
      failures,
    },
    dispose,
  };
}
