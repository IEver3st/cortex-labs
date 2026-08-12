import * as THREE from "three";
import { readFile } from "@tauri-apps/plugin-fs";
import { parseDDS } from "./dds";
import {
  createBptcDdsTexture,
  createS3tcDdsTexture,
  inspectDdsCompression,
} from "./native-dds.js";
import {
  classifyNativeShaderProfile,
  selectNativeMaterialBindings,
  summarizeNativeMaterialMeshes,
} from "./native-material-plan.js";

const DXT_FORMATS = new Set(["DXT1", "DXT3", "DXT5"]);
const BC7_FORMATS = new Set([98, 99]);
const LOAD_CONCURRENCY = 3;

const PROFILE_SETTINGS = {
  default: { metalness: 0.18, roughness: 0.58 },
  paint: { metalness: 0.28, roughness: 0.28, clearcoat: 0.72, clearcoatRoughness: 0.22 },
  glass: { metalness: 0, roughness: 0.12, transparent: true, opacity: 0.42, transmission: 0.18, depthWrite: false, side: THREE.DoubleSide },
  cutout: { metalness: 0.05, roughness: 0.62, transparent: true, alphaTest: 0.18, depthWrite: true, side: THREE.DoubleSide },
  decal: { metalness: 0.08, roughness: 0.46, transparent: true, alphaTest: 0.04, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 },
  emissive: { metalness: 0.08, roughness: 0.3, emissiveIntensity: 1.25 },
  rubber: { metalness: 0, roughness: 0.9 },
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

async function loadNativeTextureSource(path, renderer, signal) {
  throwIfAborted(signal);
  const bytes = await readFile(path);
  throwIfAborted(signal);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const { fourCc, dxgiFormat } = inspectDdsCompression(bytes);

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

  const decoded = parseDDS(buffer, { log: false });
  if (!decoded) throw new Error(`Unsupported DDS texture: ${path}`);
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
    emissive: profile === "emissive" ? 0xffffff : 0x000000,
    side: THREE.FrontSide,
    ...settings,
  });
  material.name = mesh?.material?.name || nativeMaterial?.shaderName || "native-material";
  material.userData = {
    ...(material.userData || {}),
    nativeMaterial: true,
    nativeProfile: profile,
    baseRoughness: material.roughness,
    baseMetalness: material.metalness,
  };
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
  material.onBeforeCompile = (shader) => {
    shader.uniforms.nativeOverlayMap = { value: material.userData.nativeOverlayMap };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec2 nativeOverlayUv;\nvarying vec2 vNativeOverlayUv;")
      .replace("#include <uv_vertex>", "#include <uv_vertex>\nvNativeOverlayUv = nativeOverlayUv;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform sampler2D nativeOverlayMap;\nvarying vec2 vNativeOverlayUv;")
      .replace(
        "#include <map_fragment>",
        "#include <map_fragment>\nvec4 nativeOverlayColor = texture2D(nativeOverlayMap, vNativeOverlayUv);\ndiffuseColor.rgb = mix(diffuseColor.rgb, nativeOverlayColor.rgb, nativeOverlayColor.a);\ndiffuseColor.a = max(diffuseColor.a, nativeOverlayColor.a);",
      );
  };
  material.customProgramCacheKey = () => "cortex-native-overlay-v1";
  material.needsUpdate = true;
  return true;
}

function assignTexture(material, mesh, role, texture, binding) {
  if (role === "baseColor") {
    material.map = texture;
  } else if (role === "overlay") {
    configureOverlayShader(material, texture, mesh.geometry, binding);
  } else if (role === "normal") {
    material.normalMap = texture;
    material.normalScale?.set?.(1, 1);
  } else if (role === "specular") {
    material.specularIntensityMap = texture;
    material.specularColorMap = texture;
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
}

function buildAssignments(object) {
  const assignmentsByPath = new Map();
  const materials = new Set();
  const meshes = [];

  object.traverse((child) => {
    if (!child.isMesh) return;
    const nativeMaterial = child.userData?.nativeMaterial;
    child.userData.nativeLodActive = nativeMaterial ? nativeMaterial.lodActive !== false : true;
    if (!nativeMaterial || nativeMaterial.lodActive === false) return;

    if (!child.userData.baseMaterial) child.userData.baseMaterial = child.material;
    prepareNativeUvChannels(child.geometry);
    const material = createNativeMaterial(child, nativeMaterial);
    child.userData.nativeMaterialObject = material;
    child.renderOrder = nativeMaterial.renderBucket || 0;
    materials.add(material);
    meshes.push(child);

    const selected = selectNativeMaterialBindings(nativeMaterial);
    for (const role of ["baseColor", "overlay", "normal", "specular", "emissive", "ambientOcclusion"]) {
      const binding = selected[role];
      if (!binding?.resolvedPath) continue;
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
  onSetup,
  onProgress,
  onRender,
}) {
  throwIfAborted(signal);
  const nativeMeshEntries = [];
  object?.traverse?.((child) => {
    if (child.isMesh) nativeMeshEntries.push({ nativeMaterial: child.userData?.nativeMaterial });
  });
  const summary = summarizeNativeMaterialMeshes(nativeMeshEntries);
  const { assignmentsByPath, materials, meshes } = buildAssignments(object);
  const requests = Array.from(assignmentsByPath.values()).sort((a, b) => {
    const priority = { baseColor: 0, overlay: 1, emissive: 1, normal: 2, specular: 3, ambientOcclusion: 4 };
    const aPriority = Math.min(...a.assignments.map((entry) => priority[entry.role] ?? 9));
    const bPriority = Math.min(...b.assignments.map((entry) => priority[entry.role] ?? 9));
    return aPriority - bPriority;
  });
  const sourceTextures = new Set();
  const variants = new Map();
  const failures = [];
  let loaded = 0;

  const dispose = () => {
    for (const mesh of meshes) {
      const nativeMaterial = mesh.userData?.nativeMaterialObject;
      if (mesh.material === nativeMaterial && mesh.userData?.baseMaterial) {
        mesh.material = mesh.userData.baseMaterial;
      }
      if (mesh.geometry?.attributes?.nativeOverlayUv) mesh.geometry.deleteAttribute("nativeOverlayUv");
      restoreNativeUvChannels(mesh.geometry);
      if (mesh.userData) {
        delete mesh.userData.nativeMaterialObject;
        delete mesh.userData.nativeLodActive;
      }
    }
    for (const material of materials) material.dispose?.();
    for (const texture of variants.values()) texture.dispose?.();
    for (const texture of sourceTextures) texture.dispose?.();
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
          assignTexture(assignment.material, assignment.mesh, assignment.role, texture, assignment.binding);
        }
        loaded += 1;
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        failures.push({ path: request.path, message: error?.message || "Texture load failed." });
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
