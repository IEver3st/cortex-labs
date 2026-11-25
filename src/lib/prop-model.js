import * as THREE from "three";
import { parseClmesh } from "./clmesh.js";
import { buildClmeshObject, userTextureUvAttribute } from "./clmesh-object.js";
import {
  applyNativeManifestToMeshes,
  normalizeManifestLightBones,
  resolveBindingsFromParentManifest,
  summarizeNativeMaterialMeshes,
} from "./native-material-plan.js";
import { parseYftAsync } from "./yft-loader.js";
import { isBridgeCancelled, readBridgeWarnings, requestBridgeParse } from "./model-load.js";
import { buildDrawableObject, YDD_SCAN_SETTINGS } from "./viewer-utils.js";
import { declareEmissiveDim, hasEmissiveDim } from "./native-shader.js";
import { GLOW_LAYER } from "./viewer-render-effects.js";
import { normalizeManifestSkeleton } from "./vehicle-rig.js";
import { summarizeParentTextures } from "./vehicle-mod-parts.js";
import {
  emissiveLevel,
  isEmissiveShader,
  isNightOnlyShader,
  listAvailableLods,
  materialGroupKey,
  materialGroupLabel,
  normalizeManifestDrawables,
  normalizeModelLights,
  propModelFormat,
  resolveLod,
} from "./prop-studio.js";

/* Prop Studio's model: loading a .ydr/.ydd/.yft through the CodeWalker bridge
   (with the JS parser as a geometry-only fallback) and the scene graph the
   viewport shows.

     root        identity container; world-space extras (light beams) live here
       turntable spins about the prop's centre (yaw only)
       offset    cancels the turntable's position so the GTA origin stays at 0
         orient  the user's quarter turns
           gta   GTA Z-up model space turned to three.js Y-up
             model meshes, glow overlays, wireframes
             lights (prop-lights.js), origin axes

   Everything the studio adds to a mesh (wireframe, glow overlay) is a child
   marked userData.propHelper, so bounds, picking and export skip it. */

const OVERLAY_SCALE = 0.6;
const CLAY_COLOR = 0xb9b7ae;
const WIRE_COLOR = 0x9fb4c8;

function abortError() {
  const error = new Error("Prop loading was cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function decodeJson(bytes) {
  return JSON.parse(new TextDecoder("utf-8").decode(bytes));
}

function fileStem(path) {
  return (String(path || "").split(/[\\/]/).pop() || "prop").replace(/\.[^.]+$/, "");
}

function errorText(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  return error.message || String(error);
}

/**
 * Parses a prop. Returns { object, format, parser, lights, drawables,
 * skeleton, parentTextures, nativeSummary, warnings }; `object` is the
 * GTA-space group of meshes, `skeleton` the bind pose and joints a vehicle rig
 * poses (null without one) and `parentTextures` the texture chain mod parts
 * resolve against (null without a manifest).
 * `extraYtds` fill bindings the bridge could not resolve, by texture name, the
 * way the game falls back through a parent dictionary.
 */
function disposeObjectGraph(root) {
  if (!root) return;
  const seenTex = new Set();
  root.traverse((child) => {
    if (!child.isMesh) return;
    child.geometry?.dispose?.();
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const mat of mats) {
      if (!mat) continue;
      for (const slot of ["map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap", "aoMap", "alphaMap", "bumpMap", "specularIntensityMap"]) {
        const tex = mat[slot];
        if (tex && !seenTex.has(tex)) {
          seenTex.add(tex);
          tex.dispose?.();
        }
      }
      mat.dispose?.();
    }
  });
}

function hasExternalGltfUri(bytes) {
  // Non-binary .gltf JSON starts with '{' (after optional UTF-8 BOM / whitespace).
  let i = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i += 1;
  if (bytes[i] !== 0x7b) return false;
  try {
    const json = JSON.parse(new TextDecoder("utf-8").decode(bytes));
    const check = (list) => Array.isArray(list) && list.some((entry) => typeof entry?.uri === "string" && !entry.uri.startsWith("data:"));
    return check(json?.buffers) || check(json?.images);
  } catch {
    return false;
  }
}

async function loadGltfPropAsset(path, { format, readFile, signal }) {
  const bytes = await readFile(path);
  throwIfAborted(signal);
  if (format === "gltf" && hasExternalGltfUri(bytes)) {
    throw new Error("Separate .gltf files with external .bin or image references are not supported. Export a self-contained .glb (or embedded .gltf) from Blender instead.");
  }
  const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
  const loader = new GLTFLoader();
  const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const gltf = await new Promise((resolve, reject) => {
    loader.parse(buffer, "", resolve, reject);
  });
  if (signal?.aborted) {
    disposeObjectGraph(gltf.scene);
    throw abortError();
  }
  const wrapper = new THREE.Group();
  wrapper.name = fileStem(path);
  // glTF is Y-up while createPropModel's `gta` node rotates -90° around X
  // (GTA Z-up → three.js Y-up). Counter-rotating +90° keeps glTF upright and
  // makes computeGtaBounds() emit accurate GTA Z-up coordinates for QA & .ytyp.
  wrapper.rotation.x = Math.PI / 2;
  wrapper.add(gltf.scene);
  wrapper.updateMatrixWorld(true);

  const gltfTextures = [];
  const seenTex = new Set();
  wrapper.traverse((child) => {
    if (!child.isMesh) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const mat of mats) {
      if (!mat) continue;
      for (const slot of ["map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap", "aoMap"]) {
        const tex = mat[slot];
        if (!tex || seenTex.has(tex)) continue;
        seenTex.add(tex);
        const w = Number(tex.image?.width || 0);
        const h = Number(tex.image?.height || 0);
        if (w > 0 && h > 0) {
          gltfTextures.push({
            name: tex.name || `${mat.name || child.name}_${slot}`,
            path: "",
            width: w,
            height: h,
            mipmaps: tex.generateMipmaps === false ? 1 : Math.floor(Math.log2(Math.max(w, h))) + 1,
            format: "RGBA8",
          });
        }
      }
    }
  });

  return {
    object: wrapper,
    format,
    parser: "gltf",
    lights: [],
    drawables: [],
    skeleton: null,
    parentTextures: null,
    nativeSummary: { available: false },
    embeddedTextures: gltfTextures,
    warnings: [],
    cached: false,
  };
}

export async function loadPropAsset(path, { invoke, readFile, force = false, extraYtds = [], signal } = {}) {
  const format = propModelFormat(path);
  if (!format) throw new Error("Prop Studio opens .ydr, .ydd, .yft, .glb and .gltf models.");
  if (format === "glb" || format === "gltf") {
    return loadGltfPropAsset(path, { format, readFile, signal });
  }
  const warnings = [];

  let bridgeError = null;
  try {
    // With a signal, an abandoned parse is cancelled on the bridge (see requestBridgeParse).
    const result = await requestBridgeParse(invoke, path, { force, signal });
    throwIfAborted(signal);
    const meshPath = typeof result?.meshPath === "string" ? result.meshPath.trim() : "";
    const manifestPath = typeof result?.manifestPath === "string" ? result.manifestPath.trim() : "";
    if (!meshPath) throw new Error("The CodeWalker bridge returned no mesh cache.");
    let manifestError = null;
    const [meshBytes, manifestBytes] = await Promise.all([
      readFile(meshPath),
      manifestPath
        ? readFile(manifestPath).catch((error) => {
          manifestError = error;
          return null;
        })
        : Promise.resolve(null),
    ]);
    throwIfAborted(signal);
    let meshes = parseClmesh(meshBytes);
    let manifest = null;
    if (manifestError) {
      warnings.push(`The model's material list didn't load, so textures are off: ${errorText(manifestError)}`);
    } else if (manifestPath && manifestBytes) {
      try {
        manifest = decodeJson(manifestBytes);
        meshes = applyNativeManifestToMeshes(meshes, manifest, manifestPath);
      } catch (error) {
        warnings.push(`The model's material list didn't load, so textures are off: ${errorText(error)}`);
      }
    }
    throwIfAborted(signal);

    for (const ytdPath of extraYtds) {
      try {
        const exported = await invoke("export_ytd", { path: ytdPath });
        const textures = (Array.isArray(exported?.textures) ? exported.textures : [])
          .filter((texture) => texture?.name && texture?.path)
          .map((texture) => ({ name: texture.name, relativePath: texture.path, source: "ytd" }));
        meshes = resolveBindingsFromParentManifest(meshes, { textures }, "");
      } catch (error) {
        warnings.push(`${fileStem(ytdPath)}.ytd didn't load: ${errorText(error)}`);
      }
      throwIfAborted(signal);
    }

    if (!meshes.length) throw new Error("The model contains no meshes.");
    const object = buildClmeshObject(meshes);
    // Siren and lamp bone pivots, where the vehicle light rig looks for them.
    object.userData.lightBones = manifest ? normalizeManifestLightBones(manifest) : [];
    // What the bridge worked around comes first; Multi shows only the first warning.
    warnings.unshift(...readBridgeWarnings(result));
    return {
      object,
      format,
      parser: "bridge",
      lights: normalizeModelLights(manifest),
      drawables: normalizeManifestDrawables(manifest),
      skeleton: normalizeManifestSkeleton(manifest),
      parentTextures: manifest ? summarizeParentTextures(manifest, manifestPath) : null,
      nativeSummary: summarizeNativeMaterialMeshes(meshes),
      warnings,
      cached: Boolean(result?.cached),
    };
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    // A cancelled parse is a stopped load, never a bridge failure to show.
    if (isBridgeCancelled(error)) throw abortError();
    bridgeError = error;
  }

  // Geometry-only fallback: no textures, lights or LODs, but the shape is real.
  const bytes = await readFile(path);
  throwIfAborted(signal);
  const drawable = await parseYftAsync(bytes, fileStem(path), format === "ydd" ? YDD_SCAN_SETTINGS : undefined);
  throwIfAborted(signal);
  if (!drawable?.models?.length) {
    throw new Error(`${fileStem(path)}.${format} couldn't be read: ${errorText(bridgeError)}`);
  }
  const object = buildDrawableObject(drawable, { useVertexColors: false });
  warnings.push(`Showing geometry only. The CodeWalker bridge failed, so textures, lights and LODs are unavailable: ${errorText(bridgeError)}`);
  return {
    object,
    format,
    parser: "parser",
    lights: [],
    drawables: [],
    skeleton: null,
    parentTextures: null,
    nativeSummary: { available: false },
    warnings,
    cached: false,
  };
}

/* ── Shared view materials ── */

function createCheckerTexture() {
  const size = 256;
  const cells = 8;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const cx = Math.floor((x / size) * cells);
      const cy = Math.floor((y / size) * cells);
      const even = (cx + cy) % 2 === 0;
      // A faint red ramp along U and green along V shows mirrored or rotated islands.
      const base = even ? 205 : 92;
      const i = (y * size + x) * 4;
      data[i] = Math.min(255, base + Math.round((x / size) * 40));
      data[i + 1] = Math.min(255, base + Math.round((y / size) * 40));
      data[i + 2] = base;
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.NearestFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function createChannelMaterial(texture, channel) {
  const mat = new THREE.MeshBasicMaterial({
    map: texture || null,
    color: texture ? 0xffffff : 0x444850,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  if (texture && channel && channel !== "rgba") {
    const swizzle = { r: "vec3(sampledDiffuseColor.r)", g: "vec3(sampledDiffuseColor.g)", b: "vec3(sampledDiffuseColor.b)", a: "vec3(sampledDiffuseColor.a)" }[channel];
    if (swizzle) {
      mat.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <map_fragment>",
          `#ifdef USE_MAP
            vec4 sampledDiffuseColor = texture2D( map, vMapUv );
            diffuseColor.rgb = ${swizzle};
            diffuseColor.a = 1.0;
          #endif`,
        );
      };
      mat.customProgramCacheKey = () => `prop-channel-${channel}`;
    }
  }
  return mat;
}

function selectMapForChannel(material, channelMap) {
  const mat = Array.isArray(material) ? material[0] : material;
  if (!mat) return null;
  if (channelMap === "normalMap") return mat.normalMap || null;
  if (channelMap === "specMap") return mat.specularIntensityMap || mat.roughnessMap || mat.metalnessMap || null;
  return mat.map || null;
}

function createBackfaceMaterial() {
  const material = new THREE.MeshStandardMaterial({
    color: CLAY_COLOR,
    roughness: 0.72,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <color_fragment>",
      `#include <color_fragment>
      if (!gl_FrontFacing) {
        diffuseColor.rgb = vec3(0.88, 0.22, 0.20);
      }`,
    );
  };
  material.customProgramCacheKey = () => "prop-backface-v1";
  return material;
}

function createViewMaterials() {
  const checker = createCheckerTexture();
  const materials = {
    clay: new THREE.MeshStandardMaterial({ color: CLAY_COLOR, roughness: 0.78, metalness: 0, side: THREE.DoubleSide }),
    normals: new THREE.MeshNormalMaterial({ side: THREE.DoubleSide }),
    uv: new THREE.MeshBasicMaterial({ map: checker, side: THREE.DoubleSide, toneMapped: false }),
    backface: createBackfaceMaterial(),
    vertex: new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, toneMapped: false }),
    vertexEmpty: new THREE.MeshBasicMaterial({ color: 0x727780, side: THREE.DoubleSide, toneMapped: false }),
    wire: new THREE.MeshBasicMaterial({
      color: WIRE_COLOR,
      wireframe: true,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      toneMapped: false,
    }),
    highlightWire: new THREE.MeshBasicMaterial({
      color: 0x558bf6,
      wireframe: true,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      toneMapped: false,
    }),
  };
  return {
    ...materials,
    dispose() {
      for (const material of Object.values(materials)) material.dispose();
      checker.dispose();
    },
  };
}

function ensureVertexColorAttribute(geometry) {
  if (!geometry) return false;
  if (geometry.getAttribute("color")) return true;
  const raw = geometry.userData?.gtaVertexColors;
  const posCount = geometry.getAttribute("position")?.count || 0;
  if (!raw || raw.length < posCount * 4 || !posCount) return false;
  // Normalize RGBA Uint8 to RGB Float32 (Three.js vertexColors reads RGB).
  const rgb = new Float32Array(posCount * 3);
  for (let i = 0; i < posCount; i += 1) {
    rgb[i * 3] = raw[i * 4] / 255;
    rgb[i * 3 + 1] = raw[i * 4 + 1] / 255;
    rgb[i * 3 + 2] = raw[i * 4 + 2] / 255;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(rgb, 3));
  return true;
}

function analyzeGeometryQuality(geometry) {
  const position = geometry?.getAttribute("position");
  const count = position?.count || 0;
  if (!count) return { missingUv: false, missingNormal: false, degenerate: 0, inverted: false };
  const missingUv = !geometry.getAttribute("uv");
  const normal = geometry.getAttribute("normal");
  const missingNormal = !normal;
  const index = geometry.getIndex();
  const triCount = Math.floor((index ? index.count : count) / 3);
  let degenerate = 0;
  let flipped = 0;
  let checked = 0;
  const ax = new THREE.Vector3();
  const bx = new THREE.Vector3();
  const cx = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const fn = new THREE.Vector3();
  const vn = new THREE.Vector3();
  const stride = triCount > 12000 ? Math.ceil(triCount / 12000) : 1;
  for (let t = 0; t < triCount; t += stride) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    ax.fromBufferAttribute(position, i0);
    bx.fromBufferAttribute(position, i1);
    cx.fromBufferAttribute(position, i2);
    ab.subVectors(bx, ax);
    ac.subVectors(cx, ax);
    fn.crossVectors(ab, ac);
    const area2 = fn.lengthSq();
    if (!Number.isFinite(area2) || area2 < 1e-12) {
      degenerate += stride;
      continue;
    }
    if (normal) {
      vn.set(
        normal.getX(i0) + normal.getX(i1) + normal.getX(i2),
        normal.getY(i0) + normal.getY(i1) + normal.getY(i2),
        normal.getZ(i0) + normal.getZ(i1) + normal.getZ(i2),
      );
      if (vn.lengthSq() > 1e-8) {
        checked += 1;
        if (fn.dot(vn) < 0) flipped += 1;
      }
    }
  }
  const inverted = checked >= 12 && flipped / checked > 0.72;
  return { missingUv, missingNormal, degenerate, inverted };
}

/* ── Prop model ── */

function meshStats(mesh) {
  const position = mesh.geometry?.getAttribute("position");
  const index = mesh.geometry?.getIndex();
  return {
    vertices: position?.count || 0,
    triangles: Math.floor((index ? index.count : position?.count || 0) / 3),
  };
}

function isShown(object, stop) {
  for (let node = object; node && node !== stop; node = node.parent) {
    if (!node.visible) return false;
  }
  return true;
}

/**
 * Wraps a loaded asset in the studio's scene graph. The returned controller
 * owns everything it creates; dispose() frees geometry, materials and
 * helpers (native material resources are freed by their own dispose).
 */
export function createPropModel(asset) {
  const container = new THREE.Group();
  container.name = "prop";
  const turntable = new THREE.Group();
  turntable.name = "prop-turntable";
  container.add(turntable);
  const offset = new THREE.Group();
  const orient = new THREE.Group();
  const gta = new THREE.Group();
  gta.name = "prop-gta";
  gta.rotation.x = -Math.PI / 2;
  turntable.add(offset);
  offset.add(orient);
  orient.add(gta);
  const model = asset.object;
  gta.add(model);

  const views = createViewMaterials();
  const axes = new THREE.AxesHelper(1);
  axes.name = "prop-origin";
  axes.userData.propHelper = true;
  axes.visible = false;
  axes.renderOrder = 20;
  axes.material.depthTest = false;
  axes.material.transparent = true;
  gta.add(axes);

  const meshes = [];
  model.traverse((child) => {
    if (!child.isMesh) return;
    const native = child.userData.nativeMaterial || null;
    child.userData.propMesh = true;
    child.userData.propBaseMaterial = child.material;
    // native-materials.js keeps the material it found as the one to restore;
    // record it now so a clay or UV view at load time is never mistaken for it.
    child.userData.baseMaterial = child.material;
    const primaryMat = Array.isArray(child.material) ? child.material[0] : child.material;
    child.userData.materialKey = materialGroupKey(native, primaryMat?.name || child.name);
    child.userData.materialLabel = materialGroupLabel(native, primaryMat?.name || child.name);
    child.userData.lodLevel = native?.lodLevel || "";
    child.userData.drawableIndex = Number.isInteger(native?.drawableIndex) ? native.drawableIndex : 0;
    if (native) native.lodActive = true;
    meshes.push(child);
  });

  const wires = meshes.map((mesh) => {
    const wire = new THREE.Mesh(mesh.geometry, views.wire);
    wire.name = `wire:${mesh.name}`;
    wire.userData.propHelper = true;
    wire.visible = false;
    wire.renderOrder = 15;
    wire.castShadow = false;
    wire.receiveShadow = false;
    mesh.add(wire);
    return wire;
  });

  const lodsByDrawable = new Map();
  for (const mesh of meshes) {
    const list = lodsByDrawable.get(mesh.userData.drawableIndex) || [];
    if (mesh.userData.lodLevel) list.push(mesh.userData.lodLevel);
    lodsByDrawable.set(mesh.userData.drawableIndex, list);
  }

  const groups = new Map();
  for (const mesh of meshes) {
    const native = mesh.userData.nativeMaterial;
    const key = mesh.userData.materialKey;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label: mesh.userData.materialLabel,
        shaderName: native?.shaderName || "",
        emissive: isEmissiveShader(native?.shaderName),
        nightOnly: isNightOnlyShader(native?.shaderName),
        multiplier: Number.isFinite(native?.emissiveMultiplier) ? native.emissiveMultiplier : null,
        textures: new Set(),
        bindings: new Map(),
        meshCount: 0,
        triangles: 0,
      };
      groups.set(key, group);
    }
    group.meshCount += 1;
    group.triangles += meshStats(mesh).triangles;
    for (const binding of native?.textureBindings || []) {
      if (!binding?.textureName) continue;
      group.textures.add(binding.textureName);
      const bKey = `${binding.usage || "unknown"}|${binding.paramName || ""}|${binding.textureName.toLowerCase()}`;
      const existing = group.bindings.get(bKey);
      if (!existing || (!existing.resolvedPath && binding.resolvedPath)) {
        group.bindings.set(bKey, {
          paramName: binding.paramName || "",
          usage: binding.usage || "unknown",
          textureName: binding.textureName,
          source: binding.source || "",
          resolved: Boolean(binding.resolvedPath),
          resolvedPath: binding.resolvedPath || "",
        });
      }
    }
  }

  let viewMode = "textured";
  let viewChannel = "rgba";
  let viewChannelMap = "map";
  let wireframe = false;
  let highlightedKey = "";
  let overlays = [];
  let emissiveSettings = null;
  let cachedQaMetrics = null;
  const channelMaterials = new Map();
  // User live texture overrides keyed by materialKey: { texture, path, originals: Map<mesh, { map, uv }> }
  const textureOverrides = new Map();

  const channelMaterialFor = (sourceMat) => {
    const tex = selectMapForChannel(sourceMat, viewChannelMap);
    const key = `${tex?.uuid || "none"}|${viewChannel}`;
    let mat = channelMaterials.get(key);
    if (!mat) {
      mat = createChannelMaterial(tex, viewChannel);
      channelMaterials.set(key, mat);
    }
    return mat;
  };

  const applyMaterials = () => {
    for (let index = 0; index < meshes.length; index += 1) {
      const mesh = meshes[index];
      const baseMat = mesh.userData.nativeMaterialObject || mesh.userData.propBaseMaterial;
      if (viewMode === "clay") mesh.material = views.clay;
      else if (viewMode === "normals") mesh.material = views.normals;
      else if (viewMode === "uv") mesh.material = views.uv;
      else if (viewMode === "backface") mesh.material = views.backface;
      else if (viewMode === "vertex") {
        mesh.material = ensureVertexColorAttribute(mesh.geometry) ? views.vertex : views.vertexEmpty;
      } else if (viewChannel !== "rgba" || viewChannelMap !== "map") {
        mesh.material = channelMaterialFor(baseMat);
      } else {
        mesh.material = baseMat;
      }
      const wire = wires[index];
      const isHighlighted = Boolean(highlightedKey) && mesh.userData.materialKey === highlightedKey;
      wire.material = isHighlighted ? views.highlightWire : views.wire;
      wire.visible = wireframe || isHighlighted;
    }
  };

  const clearChannelMaterials = () => {
    for (const mat of channelMaterials.values()) mat.dispose();
    channelMaterials.clear();
  };

  const applyOverrideToMesh = (mesh, override) => {
    const rawMat = mesh.userData.nativeMaterialObject || mesh.userData.propBaseMaterial;
    if (!rawMat) return;
    const mats = Array.isArray(rawMat) ? rawMat.filter(Boolean) : [rawMat];
    if (!mats.length) return;
    if (!override.originals.has(mesh)) {
      const baseUv = mesh.geometry?.userData?.gtaUvSets?.[0] || mesh.geometry?.attributes?.uv || null;
      override.originals.set(mesh, {
        materials: mats.map((material) => ({
          material,
          map: material.map || null,
          emissiveMap: material.emissiveMap || null,
        })),
        uv: baseUv,
      });
    }
    const baseUv = override.originals.get(mesh).uv;
    if (baseUv && mesh.geometry) {
      mesh.geometry.setAttribute("uv", userTextureUvAttribute(mesh.geometry, baseUv));
    }
    for (const material of mats) {
      material.map = override.texture;
      if (material.emissiveMap) material.emissiveMap = override.texture;
      material.needsUpdate = true;
    }
    for (const overlay of overlays) {
      if (overlay.userData.target === mesh && overlay.material) {
        overlay.material.map = override.texture;
        overlay.material.needsUpdate = true;
      }
    }
  };

  const restoreOverride = (override, { disposeTexture = true } = {}) => {
    if (!override) return;
    for (const [mesh, saved] of override.originals) {
      if (saved.uv && mesh.geometry) mesh.geometry.setAttribute("uv", saved.uv);
      for (const entry of saved.materials || []) {
        if (!entry.material) continue;
        entry.material.map = entry.map;
        if ("emissiveMap" in entry.material) entry.material.emissiveMap = entry.emissiveMap;
        entry.material.needsUpdate = true;
      }
      for (const overlay of overlays) {
        if (overlay.userData.target === mesh && overlay.material) {
          const restored = saved.materials?.[0];
          overlay.material.map = restored?.emissiveMap || restored?.map || null;
          overlay.material.needsUpdate = true;
        }
      }
    }
    override.originals.clear();
    if (disposeTexture) override.texture?.dispose?.();
  };

  const visibleMeshes = () => meshes.filter((mesh) => isShown(mesh, turntable.parent));

  const computeBounds = (list = visibleMeshes()) => {
    const bounds = new THREE.Box3();
    const box = new THREE.Box3();
    for (const mesh of list) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      mesh.updateWorldMatrix(true, false);
      bounds.union(box.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld));
    }
    return bounds.isEmpty() ? null : bounds;
  };

  /** Axis-aligned bounding box in raw GTA Z-up model coordinates (for Prop Doctor & .ytyp). */
  const computeGtaBounds = (list = null) => {
    const target = list || meshes.filter((mesh) => !mesh.userData.lodLevel || mesh.userData.lodLevel === "high");
    const source = target.length ? target : meshes;
    gta.updateMatrixWorld(true);
    const invGta = gta.matrixWorld.clone().invert();
    const toGta = new THREE.Matrix4();
    const bounds = new THREE.Box3();
    const box = new THREE.Box3();
    for (const mesh of source) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      toGta.multiplyMatrices(invGta, mesh.matrixWorld);
      bounds.union(box.copy(mesh.geometry.boundingBox).applyMatrix4(toGta));
    }
    if (bounds.isEmpty()) return null;
    return {
      min: [bounds.min.x, bounds.min.y, bounds.min.z],
      max: [bounds.max.x, bounds.max.y, bounds.max.z],
    };
  };

  const controller = {
    root: container,
    gta,
    model,
    meshes,
    format: asset.format,
    embeddedTextures: asset.embeddedTextures || [],
    parser: asset.parser,
    lights: asset.lights || [],
    drawables: asset.drawables || [],
    nativeSummary: asset.nativeSummary || { available: false },

    /** Material rows for the inspector, in first-seen order. */
    materialGroups() {
      return [...groups.values()].map((group) => ({
        ...group,
        textures: [...group.textures],
        bindings: [...group.bindings.values()],
        overridePath: textureOverrides.get(group.key)?.path || "",
      }));
    },

    /** Raw GTA Z-up bounding box across high-LOD meshes (or all meshes if no LODs). */
    gtaBounds() {
      return computeGtaBounds();
    },

    /** Cached geometry, LOD, vertex-colour and missing-binding metrics for Prop Doctor. */
    qaMetrics() {
      if (cachedQaMetrics) return cachedQaMetrics;
      const lodStats = {};
      let missingUvMeshes = 0;
      let missingNormalMeshes = 0;
      let degenerateTriangles = 0;
      let invertedWindingMeshes = 0;
      let hasVertexColors = false;
      const missingBindings = [];
      const seenMissing = new Set();

      const highMeshes = [];
      for (const mesh of meshes) {
        const lod = mesh.userData.lodLevel || "high";
        const counts = meshStats(mesh);
        if (!lodStats[lod]) lodStats[lod] = { meshes: 0, vertices: 0, triangles: 0 };
        lodStats[lod].meshes += 1;
        lodStats[lod].vertices += counts.vertices;
        lodStats[lod].triangles += counts.triangles;
        if (mesh.geometry?.userData?.gtaVertexColors?.length || mesh.geometry?.attributes?.color?.count > 0) hasVertexColors = true;
        if (lod === "high" || !mesh.userData.lodLevel) highMeshes.push(mesh);
      }

      const inspected = highMeshes.length ? highMeshes : meshes;
      let highTriangles = 0;
      let highVertices = 0;
      for (const mesh of inspected) {
        const counts = meshStats(mesh);
        highTriangles += counts.triangles;
        highVertices += counts.vertices;
        const quality = analyzeGeometryQuality(mesh.geometry);
        if (quality.missingUv) missingUvMeshes += 1;
        if (quality.missingNormal) missingNormalMeshes += 1;
        degenerateTriangles += quality.degenerate;
        if (quality.inverted) invertedWindingMeshes += 1;
        const native = mesh.userData.nativeMaterial;
        for (const binding of native?.textureBindings || []) {
          if (binding?.textureName && !binding.resolvedPath) {
            const mKey = `${mesh.userData.materialKey}|${binding.paramName}|${binding.textureName.toLowerCase()}`;
            if (seenMissing.has(mKey)) continue;
            seenMissing.add(mKey);
            missingBindings.push({
              material: mesh.userData.materialLabel,
              materialKey: mesh.userData.materialKey,
              paramName: binding.paramName || binding.usage || "",
              textureName: binding.textureName,
            });
          }
        }
      }

      cachedQaMetrics = {
        gtaBounds: computeGtaBounds(inspected),
        lodStats,
        highTriangles,
        highVertices,
        missingBindings,
        missingUvMeshes,
        missingNormalMeshes,
        degenerateTriangles,
        invertedWindingMeshes,
        hasVertexColors,
      };
      return cachedQaMetrics;
    },

    setHighlightedMaterial(key) {
      highlightedKey = key || "";
      applyMaterials();
    },

    setMaterialTextureOverride(materialKey, texture, path = "") {
      if (!materialKey || !texture) return;
      const previous = textureOverrides.get(materialKey);
      if (previous) restoreOverride(previous);
      clearChannelMaterials();
      const override = { texture, path, originals: new Map() };
      textureOverrides.set(materialKey, override);
      for (const mesh of meshes) {
        if (mesh.userData.materialKey === materialKey) applyOverrideToMesh(mesh, override);
      }
      applyMaterials();
    },

    clearMaterialTextureOverride(materialKey) {
      const override = textureOverrides.get(materialKey);
      if (!override) return;
      restoreOverride(override);
      textureOverrides.delete(materialKey);
      clearChannelMaterials();
      applyMaterials();
    },

    /** LOD levels any drawable has, best first. */
    availableLods() {
      return listAvailableLods([...lodsByDrawable.values()].flat());
    },

    /**
     * Shows one LOD (per drawable, falling back to the nearest available),
     * one drawable or all (-1), minus hidden material groups.
     */
    setVisibility({ lod = "high", drawable = -1, hiddenMaterials = {} } = {}) {
      const chosen = new Map();
      for (const [index, lods] of lodsByDrawable) chosen.set(index, resolveLod(lod, lods));
      for (const mesh of meshes) {
        const index = mesh.userData.drawableIndex;
        const want = chosen.get(index);
        const lodOk = !want || !mesh.userData.lodLevel || mesh.userData.lodLevel === want;
        const drawableOk = drawable < 0 || index === drawable;
        mesh.visible = lodOk && drawableOk && !hiddenMaterials[mesh.userData.materialKey];
      }
    },

    setOrientation(quaternion) {
      orient.quaternion.fromArray(quaternion).normalize();
    },

    /** Re-centres the turntable on the visible prop; the GTA origin stays at 0. */
    recenter() {
      const yaw = turntable.rotation.y;
      turntable.rotation.y = 0;
      turntable.position.set(0, 0, 0);
      offset.position.set(0, 0, 0);
      turntable.updateMatrixWorld(true);
      const bounds = computeBounds();
      if (bounds) {
        const center = bounds.getCenter(new THREE.Vector3());
        turntable.position.set(center.x, 0, center.z);
        offset.position.set(-center.x, 0, -center.z);
      }
      turntable.rotation.y = yaw;
      turntable.updateMatrixWorld(true);
    },

    setYaw(radians) {
      turntable.rotation.y = radians;
      turntable.updateMatrixWorld(true);
    },

    get yaw() {
      return turntable.rotation.y;
    },

    /** World bounds of the visible meshes (helpers excluded). */
    bounds() {
      turntable.updateMatrixWorld(true);
      return computeBounds();
    },

    /** Bounds as if the turntable were at rest, so framing does not breathe while it spins. */
    restBounds() {
      const yaw = turntable.rotation.y;
      turntable.rotation.y = 0;
      turntable.updateMatrixWorld(true);
      const bounds = computeBounds();
      turntable.rotation.y = yaw;
      turntable.updateMatrixWorld(true);
      return bounds;
    },

    /** Size in GTA metres of the visible meshes, unaffected by turns and spin. */
    dimensions() {
      const saved = [turntable.rotation.y, orient.quaternion.clone()];
      turntable.rotation.y = 0;
      orient.quaternion.identity();
      turntable.updateMatrixWorld(true);
      const bounds = computeBounds();
      turntable.rotation.y = saved[0];
      orient.quaternion.copy(saved[1]);
      turntable.updateMatrixWorld(true);
      if (!bounds) return null;
      const size = bounds.getSize(new THREE.Vector3());
      // three.js Y-up back to GTA: x stays, GTA y is depth (three z), GTA z is height.
      return { x: size.x, y: size.z, z: size.y };
    },

    stats() {
      const visible = visibleMeshes();
      let vertices = 0;
      let triangles = 0;
      for (const mesh of visible) {
        const counts = meshStats(mesh);
        vertices += counts.vertices;
        triangles += counts.triangles;
      }
      return { meshes: visible.length, totalMeshes: meshes.length, vertices, triangles };
    },

    setView(mode, nextWireframe, nextChannel = "rgba", nextChannelMap = "map") {
      viewMode = mode;
      wireframe = Boolean(nextWireframe);
      viewChannel = nextChannel || "rgba";
      viewChannelMap = nextChannelMap || "map";
      applyMaterials();
      if (emissiveSettings) controller.setEmissive(emissiveSettings);
    },

    setHelpers({ origin = false, size = 1 } = {}) {
      axes.visible = Boolean(origin);
      axes.scale.setScalar(Math.max(0.01, size));
    },

    /**
     * Takes the native materials loaded by native-materials.js and builds a
     * glow overlay for every emissive surface. Call again after a reload.
     */
    attachNativeMaterials() {
      clearChannelMaterials();
      for (const override of textureOverrides.values()) {
        restoreOverride(override, { disposeTexture: false });
      }
      for (const overlay of overlays) {
        overlay.removeFromParent();
        overlay.material.dispose();
      }
      overlays = [];
      for (const mesh of meshes) {
        const material = mesh.userData.nativeMaterialObject;
        if (!material) continue;
        const native = mesh.userData.nativeMaterial;
        const emissive = Boolean(material.emissiveMap) || material.userData?.nativeProfile === "emissive" || isEmissiveShader(native?.shaderName);
        mesh.userData.emissiveBase = emissive ? Math.max(material.emissiveIntensity || 0, 1) : 0;
        if (!emissive) continue;
        // Light-driven shaders bind no emissive map on vehicles; Prop Studio has
        // no light rig, so they glow by their diffuse texture here.
        if (!material.emissiveMap && material.map) {
          material.emissiveMap = material.map;
          material.needsUpdate = true;
        }
        if (material.emissive.getHex() === 0) material.emissive.setHex(0xffffff);
        const dimmed = hasEmissiveDim(mesh.geometry);
        const overlay = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({
          map: material.emissiveMap || material.map || null,
          color: 0x000000,
          side: material.side,
          alphaTest: material.alphaTest || 0,
          transparent: material.transparent || dimmed,
          depthWrite: false,
          depthFunc: THREE.LessEqualDepth,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
          toneMapped: false,
        }));
        if (dimmed) {
          overlay.material.onBeforeCompile = (shader) => {
            declareEmissiveDim(shader);
            shader.fragmentShader = shader.fragmentShader.replace(
              "#include <map_fragment>",
              "#include <map_fragment>\n\tdiffuseColor.a *= vEmissiveDim;",
            );
          };
          overlay.material.customProgramCacheKey = () => "prop-glow-dim";
        }
        overlay.name = `glow:${mesh.name}`;
        overlay.userData.propHelper = true;
        overlay.layers.set(GLOW_LAYER);
        overlay.visible = false;
        overlay.renderOrder = 10;
        overlay.userData.target = mesh;
        mesh.add(overlay);
        overlays.push(overlay);
      }
      for (const [key, override] of textureOverrides) {
        for (const mesh of meshes) {
          if (mesh.userData.materialKey === key) applyOverrideToMesh(mesh, override);
        }
      }
      applyMaterials();
      if (emissiveSettings) controller.setEmissive(emissiveSettings);
    },

    /** Applies emissive settings; returns true when any glow overlay is lit. */
    setEmissive(settings) {
      emissiveSettings = settings;
      const textured = viewMode === "textured" && viewChannel === "rgba" && viewChannelMap === "map";
      let glowing = false;
      for (const mesh of meshes) {
        const material = mesh.userData.nativeMaterialObject;
        const base = mesh.userData.emissiveBase || 0;
        if (!material || base <= 0) continue;
        const native = mesh.userData.nativeMaterial;
        const key = mesh.userData.materialKey;
        const lit = settings.enabled
          && !settings.off?.[key]
          && (settings.nightOnly || !isNightOnlyShader(native?.shaderName));
        const level = lit
          ? settings.strength
            * (settings.levels?.[key] ?? 1)
            * (settings.useGameMultiplier ? emissiveLevel(native?.emissiveMultiplier) : 1)
          : 0;
        material.emissiveIntensity = base * level;
        mesh.userData.emissiveLevel = level;
      }
      for (const overlay of overlays) {
        const level = overlay.userData.target.userData.emissiveLevel || 0;
        const strength = level * (settings.glow || 0) * OVERLAY_SCALE;
        overlay.material.color.setScalar(strength);
        overlay.visible = textured && strength > 0.001;
        if (overlay.visible && isShown(overlay.userData.target, turntable.parent)) glowing = true;
      }
      return glowing;
    },

    /**
     * Hides helpers, beams and coronas for an export; emissive glow overlays
     * stay so emissives render sharp. The returned function restores them.
     */
    hideHelpers() {
      const hidden = [];
      container.traverse((child) => {
        if (child.userData.propHelper && child.visible && (child.layers.isEnabled(0) || child.isSprite)) {
          child.visible = false;
          hidden.push(child);
        }
      });
      return () => {
        for (const child of hidden) child.visible = true;
      };
    },

    dispose() {
      for (const override of textureOverrides.values()) restoreOverride(override);
      textureOverrides.clear();
      for (const mat of channelMaterials.values()) mat.dispose();
      channelMaterials.clear();
      for (const overlay of overlays) overlay.material.dispose();
      overlays = [];
      for (const wire of wires) wire.removeFromParent();
      axes.geometry.dispose();
      axes.material.dispose();
      const disposed = new Set();
      const disposedTextures = new Set();
      const disposeMatTextures = asset.parser === "gltf";
      model.traverse((child) => {
        if (!child.isMesh || child.userData.propHelper) return;
        child.geometry?.dispose?.();
        const baseList = Array.isArray(child.userData.propBaseMaterial)
          ? child.userData.propBaseMaterial
          : [child.userData.propBaseMaterial];
        const currList = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of [...baseList, ...currList]) {
          if (!material || disposed.has(material) || Object.values(views).includes(material)) continue;
          disposed.add(material);
          if (disposeMatTextures) {
            for (const value of Object.values(material)) {
              if (value?.isTexture && !disposedTextures.has(value)) {
                disposedTextures.add(value);
                value.dispose?.();
              }
            }
          }
          material.dispose?.();
        }
      });
      views.dispose();
      container.removeFromParent();
    },
  };

  return controller;
}
