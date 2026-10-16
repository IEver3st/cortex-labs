import * as THREE from "three";
import { parseClmesh } from "./clmesh.js";
import { buildClmeshObject } from "./clmesh-object.js";
import {
  applyNativeManifestToMeshes,
  normalizeManifestLightBones,
  resolveBindingsFromParentManifest,
  summarizeNativeMaterialMeshes,
} from "./native-material-plan.js";
import { parseYftAsync } from "./yft-loader.js";
import { isBridgeCancelled, readBridgeWarnings, requestBridgeParse } from "./model-load.js";
import { buildDrawableObject, YDD_SCAN_SETTINGS } from "./viewer-utils.js";
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
export async function loadPropAsset(path, { invoke, readFile, force = false, extraYtds = [], signal } = {}) {
  const format = propModelFormat(path);
  if (!format) throw new Error("Prop Studio opens .ydr, .ydd and .yft models.");
  const warnings = [];

  let bridgeError = null;
  try {
    // With a signal, an abandoned parse is cancelled on the bridge (see requestBridgeParse).
    const result = await requestBridgeParse(invoke, path, { force, signal });
    throwIfAborted(signal);
    const meshPath = typeof result?.meshPath === "string" ? result.meshPath.trim() : "";
    const manifestPath = typeof result?.manifestPath === "string" ? result.manifestPath.trim() : "";
    if (!meshPath) throw new Error("The CodeWalker bridge returned no mesh cache.");
    let meshes = parseClmesh(await readFile(meshPath));
    let manifest = null;
    if (manifestPath) {
      try {
        manifest = decodeJson(await readFile(manifestPath));
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

function createViewMaterials() {
  const checker = createCheckerTexture();
  const materials = {
    clay: new THREE.MeshStandardMaterial({ color: CLAY_COLOR, roughness: 0.78, metalness: 0, side: THREE.DoubleSide }),
    normals: new THREE.MeshNormalMaterial({ side: THREE.DoubleSide }),
    uv: new THREE.MeshBasicMaterial({ map: checker, side: THREE.DoubleSide }),
    wire: new THREE.MeshBasicMaterial({
      color: WIRE_COLOR,
      wireframe: true,
      transparent: true,
      opacity: 0.45,
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
    child.userData.materialKey = materialGroupKey(native, child.material?.name || child.name);
    child.userData.materialLabel = materialGroupLabel(native, child.material?.name || child.name);
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
        meshCount: 0,
      };
      groups.set(key, group);
    }
    group.meshCount += 1;
    for (const binding of native?.textureBindings || []) {
      if (binding?.textureName) group.textures.add(binding.textureName);
    }
  }

  let viewMode = "textured";
  let wireframe = false;
  let overlays = [];
  let emissiveSettings = null;

  const applyMaterials = () => {
    for (const mesh of meshes) {
      if (viewMode === "clay") mesh.material = views.clay;
      else if (viewMode === "normals") mesh.material = views.normals;
      else if (viewMode === "uv") mesh.material = views.uv;
      else mesh.material = mesh.userData.nativeMaterialObject || mesh.userData.propBaseMaterial;
    }
    for (const wire of wires) wire.visible = wireframe;
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

  const controller = {
    root: container,
    gta,
    model,
    meshes,
    format: asset.format,
    parser: asset.parser,
    lights: asset.lights || [],
    drawables: asset.drawables || [],
    nativeSummary: asset.nativeSummary || { available: false },

    /** Material rows for the inspector, in first-seen order. */
    materialGroups() {
      return [...groups.values()].map((group) => ({ ...group, textures: [...group.textures] }));
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

    setView(mode, nextWireframe) {
      viewMode = mode;
      wireframe = Boolean(nextWireframe);
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
        const overlay = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({
          map: material.emissiveMap || material.map || null,
          color: 0x000000,
          side: material.side,
          alphaTest: material.alphaTest || 0,
          transparent: material.transparent,
          depthWrite: false,
          depthFunc: THREE.LessEqualDepth,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
          toneMapped: false,
        }));
        overlay.name = `glow:${mesh.name}`;
        overlay.userData.propHelper = true;
        overlay.layers.set(GLOW_LAYER);
        overlay.visible = false;
        overlay.renderOrder = 10;
        overlay.userData.target = mesh;
        mesh.add(overlay);
        overlays.push(overlay);
      }
      applyMaterials();
      if (emissiveSettings) controller.setEmissive(emissiveSettings);
    },

    /** Applies emissive settings; returns true when any glow overlay is lit. */
    setEmissive(settings) {
      emissiveSettings = settings;
      const textured = viewMode === "textured";
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
      for (const overlay of overlays) overlay.material.dispose();
      overlays = [];
      for (const wire of wires) wire.removeFromParent();
      axes.geometry.dispose();
      axes.material.dispose();
      const disposed = new Set();
      model.traverse((child) => {
        if (!child.isMesh || child.userData.propHelper) return;
        child.geometry?.dispose?.();
        for (const material of [child.userData.propBaseMaterial, ...(Array.isArray(child.material) ? child.material : [child.material])]) {
          if (!material || disposed.has(material) || Object.values(views).includes(material)) continue;
          disposed.add(material);
          material.dispose?.();
        }
      });
      views.dispose();
      container.removeFromParent();
    },
  };

  return controller;
}
