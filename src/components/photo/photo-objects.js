import * as THREE from "three";
import { invoke } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import { loadPropAsset } from "../../lib/prop-model.js";
import { loadNativeMaterialView, loadNativeTextureSource, setNativeOverlayTexture } from "../../lib/native-materials.js";
import { resolvePaintLayerSlot } from "../../lib/native-material-plan.js";
import { createLiveryOverride, findLiveryModTexturePath, listTextureLiveries } from "../../lib/vehicle-livery.js";
import { listAvailableLods, resolveLod } from "../../lib/prop-studio.js";
import { createVehicleRig } from "../../lib/vehicle-rig.js";
import { getModelExtras, loadVehicleModPart } from "../../lib/vehicle-mod-parts.js";
import { isHiddenByBones } from "../../lib/vehicle-modkits.js";
import { applyFrontWheelSteering } from "../../lib/vehicle-steering.js";
import { createPlateOverlay, findPlateMeshes } from "../../lib/license-plate-overlay.js";
import { createEmergencyLightRig } from "../../lib/emergency-light-rig.js";
import { anyLightOn } from "../../lib/emergency-lights.js";
import { disposeObject } from "../../lib/viewer-utils.js";
import {
  FINISHED_PAINT_KEYS,
  VEHICLE_PAINT_KEYS,
  paintDisplayColor,
  paintFinishProfile,
} from "../../lib/vehicle-paint.js";
import {
  BODY_PRESETS,
  CLOTHING_PRESETS,
  COMPONENT_IDS,
  DEFAULT_BASE_OUTFIT,
  DEFAULT_RACE,
  HAIR_COLORS,
  PED_FOR_GENDER,
  isSkinTintSlot,
  selectBaseGameAssets,
  skinToneTint,
} from "../../lib/eup.js";
import {
  buildSlotGroup,
  computePedBounds,
  createPedRoot,
  disposeSlotGroup,
  setGroupHairColor,
  setGroupSkinTint,
  setPedPose,
  updatePedPropAttachments,
} from "../../lib/ped-assembly.js";
import { isValidClip, sampleClipPose } from "../../lib/ped-pose.js";
import { photoPoseClip } from "../../lib/photo-mode.js";
import { exportPedAsset, getPedClip, getPedListing, getPedSkeleton } from "../eup/ped-files.js";

/* Scene objects for Photo Mode. Each loader returns a controller whose
   `holder` the viewport adds to the scene:

     holder   the user's placement: position (x, lift, z) and yaw
       ground lifts the subject so its lowest point rests on the floor
         ...    GTA Z-up model space turned to three.js Y-up

   Vehicles and props share one path (the CodeWalker bridge, then the game's
   textures through native-materials.js); peds are assembled from base-game
   freemode drawables and posed with game animation clips. Every controller
   owns what it creates and frees it in dispose(). */

// The ped root faces +Z; vehicles and props face -Z. Turning the ped half a
// turn makes yaw 0 mean the same facing for every object.
const PED_FACING = Math.PI;
const FLOOR_SAMPLES = 8;
const NEUTRAL = new THREE.Color(1, 1, 1);

function abortError() {
  const error = new Error("Loading was cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

/** Lowest point of `subject` in its holder's frame, ignoring the placement. */
function measureFloor(holder, ground, measure) {
  const position = holder.position.clone();
  const quaternion = holder.quaternion.clone();
  holder.position.set(0, 0, 0);
  holder.quaternion.identity();
  ground.position.y = 0;
  holder.updateMatrixWorld(true);
  const lowest = measure();
  holder.position.copy(position);
  holder.quaternion.copy(quaternion);
  if (Number.isFinite(lowest)) ground.position.y = -lowest;
  holder.updateMatrixWorld(true);
}

function createHolder(name) {
  const holder = new THREE.Group();
  holder.name = name;
  const ground = new THREE.Group();
  holder.add(ground);
  return { holder, ground };
}

/* ── Vehicles and props ── */

function applyPaintFinish(material, finish, pearlColor) {
  const before = `${material.clearcoat > 0}|${material.sheen > 0}`;
  material.metalness = finish.metalness;
  material.roughness = Math.min(1, Math.max(0.02, finish.roughness));
  material.clearcoat = finish.clearcoat;
  material.clearcoatRoughness = finish.clearcoatRoughness;
  material.specularIntensity = finish.specularIntensity;
  if (pearlColor && "sheen" in material) {
    material.sheen = 1;
    material.sheenColor.copy(pearlColor);
    material.sheenRoughness = 0.35;
  } else if ("sheen" in material) {
    material.sheen = 0;
  }
  // Clear coat and sheen switch shader features; the program must rebuild.
  if (`${material.clearcoat > 0}|${material.sheen > 0}` !== before) material.needsUpdate = true;
}

/**
 * Loads a vehicle or prop, from the game files (`source: "game"`, by model
 * name) or from the user's own file. Game models are extracted once into the
 * app cache; the user's files are only read.
 */
export async function loadPhotoModel({ kind, source, name, path, signal, onStatus }) {
  let modelPath = path;
  if (source === "game") {
    onStatus?.("Extracting from the game files…");
    const exported = await invoke(kind === "vehicle" ? "export_game_vehicle" : "export_game_prop", { name });
    throwIfAborted(signal);
    modelPath = typeof exported?.path === "string" ? exported.path : "";
    if (!modelPath) throw new Error(`The game files returned no model for ${name}.`);
  }
  onStatus?.("Reading the model…");
  const asset = await loadPropAsset(modelPath, { invoke, readFile, signal });
  throwIfAborted(signal);
  const controller = createModelController(asset, kind);
  // The vehicle's resource (its meta, mod parts and roof clip) sits around this file.
  controller.modelPath = modelPath;
  return controller;
}

/** Shows each drawable's highest LOD only; records the choice on the mesh. */
function pickHighestLods(list) {
  const lodsByDrawable = new Map();
  for (const mesh of list) {
    const native = mesh.userData.nativeMaterial;
    const index = Number.isInteger(native?.drawableIndex) ? native.drawableIndex : 0;
    const lods = lodsByDrawable.get(index) || [];
    if (native?.lodLevel) lods.push(native.lodLevel);
    lodsByDrawable.set(index, lods);
  }
  for (const mesh of list) {
    const native = mesh.userData.nativeMaterial;
    const lods = lodsByDrawable.get(Number.isInteger(native?.drawableIndex) ? native.drawableIndex : 0) || [];
    const want = resolveLod("high", listAvailableLods(lods));
    mesh.userData.photoLodVisible = !want || !native?.lodLevel || native.lodLevel === want;
    mesh.visible = mesh.userData.photoLodVisible;
  }
}

function createModelController(asset, kind) {
  const { holder, ground } = createHolder(kind);
  const gta = new THREE.Group();
  gta.rotation.x = -Math.PI / 2;
  ground.add(gta);
  const model = asset.object;
  gta.add(model);

  const meshes = [];
  model.traverse((child) => {
    if (child.isMesh) meshes.push(child);
  });
  pickHighestLods(meshes);
  for (const mesh of meshes) mesh.userData.baseMaterial = mesh.material;

  const isVehicle = kind === "vehicle";
  const rig = isVehicle && asset.skeleton ? createVehicleRig({ skeleton: asset.skeleton, meshes }) : null;
  if (rig) rig.reset();
  const extras = isVehicle ? getModelExtras(model) : [];
  const liveries = isVehicle ? listTextureLiveries(meshes, asset.parentTextures) : null;
  const plateMeshes = isVehicle ? findPlateMeshes(model) : [];

  const measure = () => {
    const bounds = new THREE.Box3();
    const box = new THREE.Box3();
    for (const mesh of meshes) {
      if (!mesh.visible) continue;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      bounds.union(box.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld));
    }
    return bounds.isEmpty() ? Number.NaN : bounds.min.y;
  };
  measureFloor(holder, ground, measure);

  let native = null;
  let paint = null;
  let extrasOn = {};
  let hiddenBones = new Set();
  // Mod parts by resolution key: { path, group, meshes, native }.
  const modParts = new Map();
  let modRequest = 0;
  // Livery overrides. A mod kit livery (the paint shaders' overlay slot) wins
  // over a texture livery (`<prefix>_sign_N`); originals are restored first.
  const livery = {
    signNumber: null,
    signTextures: new Map(),
    modTexture: null,
    modPath: "",
    request: 0,
  };
  const liveryOverride = createLiveryOverride(setNativeOverlayTexture);
  let plate = null;
  // Vehicle lights: the Livery viewer's rig, built the first time a light is
  // switched on (its body spill lights add to every material's light count).
  const lights = { rig: null, scene: null, state: null };

  const applyLights = () => {
    if (!isVehicle || !lights.scene || !lights.state) return;
    if (!lights.rig) {
      if (!anyLightOn(lights.state.switches)) return;
      lights.rig = createEmergencyLightRig({ scene: lights.scene, model });
      if (!lights.rig) return;
    }
    lights.rig.setState(lights.state);
  };

  const allMeshes = () => {
    const list = [...meshes];
    for (const part of modParts.values()) list.push(...part.meshes);
    return list;
  };

  // A stock mesh shows when its LOD is the one shown, its extra (if any) is
  // on, and no chosen mod turns its bone off.
  const applyVisibility = () => {
    for (const mesh of meshes) {
      const extra = mesh.userData.extraIndex;
      const extraOn = !Number.isInteger(extra) || Boolean(extrasOn[extra]);
      const modHidden = isHiddenByBones(mesh.userData.nativeMaterial?.boneChain, hiddenBones);
      mesh.visible = mesh.userData.photoLodVisible !== false && extraOn && !modHidden;
    }
  };
  applyVisibility();

  const applyPaint = () => {
    if (!paint) return;
    const colors = {};
    for (const key of VEHICLE_PAINT_KEYS) colors[key] = new THREE.Color(paintDisplayColor(paint[key]));
    const finishes = {};
    for (const key of FINISHED_PAINT_KEYS) finishes[key] = paintFinishProfile(paint[key]?.finish);
    // Pearlescent shows on glossy primary paint only, as in game.
    const pearl = finishes.primary.clearcoat > 0 ? colors.pearlescent : null;
    for (const mesh of allMeshes()) {
      const material = mesh.userData.nativeMaterialObject;
      if (!material) continue;
      const layer = resolvePaintLayerSlot(mesh.userData.nativeMaterial);
      const profile = material.userData?.nativeProfile;
      const slot = layer !== undefined ? layer : profile === "paint" ? "primary" : null;
      if (!slot) continue;
      material.color.copy(colors[slot] || NEUTRAL);
      const finish = profile === "paint" ? finishes[slot] : null;
      if (finish) applyPaintFinish(material, finish, slot === "primary" ? pearl : null);
    }
  };

  const useNativeMaterials = (list) => {
    for (const mesh of list) {
      const material = mesh.userData.nativeMaterialObject;
      if (material && mesh.material !== material) mesh.material = material;
    }
    applyPaint();
  };

  const disposeModPart = (part) => {
    part.native?.dispose();
    rig?.detach(part.group);
    part.group.removeFromParent();
    disposeObject(part.group);
  };

  const restoreLivery = () => liveryOverride.restore();

  const applyLivery = () => {
    const sign = livery.signNumber != null ? livery.signTextures.get(livery.signNumber) : null;
    liveryOverride.apply(meshes, { mod: livery.modTexture, sign });
  };

  // A livery mod's model is a placeholder; its texture is what the game shows.
  const loadLiveryMod = async (part, request, renderer, failed) => {
    if ((part?.path || "") === livery.modPath) return;
    if (!part) {
      livery.modTexture?.dispose();
      livery.modTexture = null;
      livery.modPath = "";
      return;
    }
    let group = null;
    try {
      group = await loadVehicleModPart(part.path, asset.parentTextures, { invoke, readFile });
      const texturePath = findLiveryModTexturePath(group);
      if (!texturePath) throw new Error("The livery part carries no livery texture.");
      const texture = await loadNativeTextureSource(texturePath, renderer);
      if (request !== modRequest) {
        texture.dispose();
        return;
      }
      livery.modTexture?.dispose();
      livery.modTexture = texture;
      livery.modPath = part.path;
    } catch (error) {
      failed.push({ key: part.key, message: error?.message || String(error) });
    } finally {
      if (group) disposeObject(group);
    }
  };

  return {
    kind,
    holder,
    rig,
    parser: asset.parser,
    warnings: asset.warnings || [],
    nativeAvailable: asset.parser === "bridge" && asset.nativeSummary?.available,
    /** Extras the model has: [{ index, label }]. */
    extras: extras.map(({ index, label }) => ({ index, label })),
    /** Livery texture numbers the vehicle's dictionary has (`<prefix>_sign_N`), or null. */
    liveries: liveries ? liveries.numbers : null,
    hasPlate: plateMeshes.length > 0,

    /**
     * Loads the model's game textures. `onProgress` gets { loaded, planned,
     * failed, missing }; resolves with the same summary when done.
     */
    async loadTextures({ renderer, signal, onProgress, onRender }) {
      if (!this.nativeAvailable) return null;
      const result = await loadNativeMaterialView({
        object: model,
        renderer,
        signal,
        onSetup: (summary) => {
          useNativeMaterials(meshes);
          onProgress?.({ loaded: 0, planned: summary.plannedTextureCount, failed: 0, missing: summary.missingBindingCount });
        },
        onProgress: (progress) => onProgress?.({
          loaded: progress.loadedTextureCount,
          planned: progress.plannedTextureCount,
          failed: progress.failedTextureCount,
          missing: progress.missingBindingCount,
        }),
        onRender,
      });
      if (signal?.aborted) {
        result.dispose();
        throw abortError();
      }
      native = result;
      useNativeMaterials(meshes);
      applyLivery();
      const summary = result.summary;
      return {
        loaded: summary.loadedTextureCount,
        planned: summary.plannedTextureCount,
        failed: summary.failedTextureCount,
        missing: summary.missingBindingCount,
      };
    },

    setPaint(nextPaint) {
      paint = nextPaint || null;
      applyPaint();
    },

    /** Moves doors, bonnet and boot to `doors` ({ partId: 0..1 open }). */
    setDoors(doors, { animate = true } = {}) {
      if (!rig) return false;
      for (const part of rig.parts) {
        const amount = Math.min(1, Math.max(0, Number(doors?.[part.id]) || 0));
        rig.setValue(part.id, part.rest + (part.open - part.rest) * amount, { animate });
      }
      return true;
    },

    /** What clicking `mesh` opens: { kind: "part", id } or { kind: "roof" }, or null. */
    targetForMesh(mesh) {
      if (!rig) return null;
      // A mod part opens with the door, bonnet or boot it is fitted to.
      const target = rig.targetForMesh(mesh);
      if (target?.kind === "part") return { kind: "part", id: target.part.id };
      return target?.kind === "roof" ? { kind: "roof" } : null;
    },

    /** Installs the convertible roof clip (null removes it). Returns whether it took. */
    setRoofClip(clip) {
      return rig ? rig.setClip(clip) : false;
    },

    /** 0 closed .. 1 lowered. */
    setRoof(amount, { animate = true } = {}) {
      return rig ? rig.setValue("roof", Math.min(1, Math.max(0, Number(amount) || 0)), { animate }) : false;
    },

    get hasRoof() {
      return Boolean(rig?.hasRoof);
    },

    /** Turns the front wheels; positive steers right. Returns the wheels turned. */
    setSteering(degrees) {
      return isVehicle ? applyFrontWheelSteering(model, degrees) : 0;
    },

    /** Shows extras by number: { 1: true, 3: true }. Others are off, as at spawn. */
    setExtras(next) {
      extrasOn = next && typeof next === "object" ? next : {};
      applyVisibility();
    },

    /**
     * Shows a mod kit selection: `resolution` from resolveModSelection with
     * each part's kit `bone` ({ parts: [{ key, path, slotType, bone }],
     * hiddenBones }). Parts load through the bridge with the vehicle's texture
     * chain and paint, fitted to their bone so they move with it; a livery mod
     * becomes the paint's livery texture. Resolves with { failed, current }
     * once this selection has settled.
     */
    async setMods(resolution, { renderer, onRender } = {}) {
      const request = ++modRequest;
      const parts = resolution?.parts || [];
      const liveryPart = parts.find((part) => part.slotType === "VMT_LIVERY_MOD") || null;
      const wanted = new Map(parts.filter((part) => part !== liveryPart).map((part) => [part.key, part]));
      hiddenBones = new Set((resolution?.hiddenBones || []).map((bone) => String(bone).toLowerCase()));
      for (const [key, part] of modParts) {
        if (wanted.get(key)?.path === part.path) continue;
        disposeModPart(part);
        modParts.delete(key);
      }
      applyVisibility();
      onRender?.();
      const failed = [];
      const jobs = [...wanted.values()].filter((part) => !modParts.has(part.key)).map(async (part) => {
        let group = null;
        try {
          group = await loadVehicleModPart(part.path, asset.parentTextures, { invoke, readFile });
          if (request !== modRequest) {
            disposeObject(group);
            return;
          }
          const partMeshes = [];
          group.traverse((child) => {
            if (child.isMesh) partMeshes.push(child);
          });
          pickHighestLods(partMeshes);
          for (const mesh of partMeshes) mesh.userData.baseMaterial = mesh.material;
          const entry = { path: part.path, group, meshes: partMeshes, native: null };
          rig?.attach(group, part.bone);
          modParts.set(part.key, entry);
          gta.add(group);
          onRender?.();
          entry.native = await loadNativeMaterialView({ object: group, renderer, onRender });
          if (modParts.get(part.key) !== entry) {
            entry.native.dispose();
            return;
          }
          useNativeMaterials(partMeshes);
          onRender?.();
        } catch (error) {
          if (group && ![...modParts.values()].some((entry) => entry.group === group)) disposeObject(group);
          failed.push({ key: part.key, message: error?.message || String(error) });
        }
      });
      jobs.push(loadLiveryMod(liveryPart, request, renderer, failed));
      await Promise.all(jobs);
      if (request === modRequest) {
        applyLivery();
        onRender?.();
      }
      return { failed, current: request === modRequest };
    },

    /**
     * Shows livery texture `number` (`<prefix>_sign_<number>`) where the model
     * binds a livery sign; null restores the model's own binding. A livery
     * from the mod kit takes precedence while one is fitted.
     */
    async setLivery(number, { renderer } = {}) {
      const request = ++livery.request;
      const known = Boolean(liveries && number != null && liveries.numbers.includes(number));
      if (known && !livery.signTextures.has(number)) {
        const texture = await loadNativeTextureSource(liveries.paths.get(number), renderer);
        if (livery.signTextures.has(number)) texture.dispose();
        else livery.signTextures.set(number, texture);
      }
      if (request !== livery.request) return;
      livery.signNumber = known ? number : null;
      applyLivery();
    },

    /**
     * Draws the license plate image ({ data, width, height }, from
     * buildPlateImage) on the vehicle's plate meshes; null hides it.
     */
    setPlateImage(image) {
      if (!plateMeshes.length) return false;
      if (!plate) {
        // The overlays copy the plate meshes' world matrices, so their root
        // cancels the holder's transform each frame (see beforeRender).
        const root = new THREE.Group();
        root.name = "photo-plates";
        root.matrixAutoUpdate = false;
        holder.add(root);
        plate = { root, overlay: createPlateOverlay({ scene: root, model }) };
      }
      plate.overlay?.setImage(image);
      return true;
    },

    /** The scene the vehicle's light rig adds its glow, pool and spill lights to. */
    attachScene(scene) {
      lights.scene = scene;
      applyLights();
    },

    /**
     * Vehicle light state for the rig: { setting (carcols siren setting or
     * null), switches, spill, spillStrength, glow, haze }.
     */
    setLights(next) {
      lights.state = next || null;
      applyLights();
    },

    /** Whether lit lamps need the glow pass this frame. */
    get lightsActive() {
      return Boolean(lights.rig?.active);
    },

    /** Advances flashing lights. Returns true while they animate. */
    updateLights(camera, now) {
      return lights.rig ? lights.rig.update(camera, now) : false;
    },

    /** Per-frame work the viewport runs before drawing. */
    beforeRender() {
      if (!plate?.overlay) return;
      holder.updateMatrixWorld(true);
      plate.root.matrix.copy(holder.matrixWorld).invert();
      plate.root.matrixWorldNeedsUpdate = true;
      plate.overlay.update();
    },

    /** Advances moving parts. Returns true while something still moves. */
    step(_dt, now) {
      return rig ? rig.update(now) : false;
    },

    dispose() {
      modRequest += 1;
      livery.request += 1;
      holder.removeFromParent();
      for (const part of modParts.values()) disposeModPart(part);
      modParts.clear();
      restoreLivery();
      for (const texture of livery.signTextures.values()) texture.dispose();
      livery.signTextures.clear();
      livery.modTexture?.dispose();
      livery.modTexture = null;
      liveryOverride.dispose();
      plate?.overlay?.dispose();
      plate = null;
      lights.rig?.dispose();
      lights.rig = null;
      native?.dispose();
      native = null;
      rig?.dispose();
      const materials = new Set();
      for (const mesh of meshes) {
        mesh.geometry?.dispose?.();
        for (const material of [mesh.userData.baseMaterial, mesh.material].flat()) {
          if (material) materials.add(material);
        }
      }
      for (const material of materials) material.dispose?.();
    },
  };
}

/* ── Peds ── */

/**
 * Assembles a freemode ped from the game files: the body preset's face and
 * hair, the clothing preset over the bare-body base outfit, skin tone and hair
 * colour. A slot that fails is skipped and reported in `warnings`.
 */
export async function loadPhotoPed({ look, renderer, signal, onStatus }) {
  const gender = look.gender === "female" ? "female" : "male";
  const ped = PED_FOR_GENDER[gender];
  const body = BODY_PRESETS[gender].find((item) => item.id === look.body) || BODY_PRESETS[gender][0];
  const outfit = CLOTHING_PRESETS[gender].find((item) => item.id === look.outfit) || CLOTHING_PRESETS[gender][0];
  const hairColor = HAIR_COLORS.find((item) => item.id === body.hairColor)?.color || HAIR_COLORS[1].color;
  const tint = skinToneTint(body.skin);
  const indices = { ...DEFAULT_BASE_OUTFIT[gender], head: body.head, hair: body.hair, ...outfit.slots };

  onStatus?.("Reading the ped from the game files…");
  const [listing, skeleton] = await Promise.all([getPedListing(ped), getPedSkeleton(ped)]);
  throwIfAborted(signal);

  const root = createPedRoot();
  const warnings = [];
  onStatus?.("Dressing the ped…");
  // allSettled, so a cancelled load can still free the slots that finished.
  const settled = await Promise.allSettled(COMPONENT_IDS.map(async (component) => {
    const { drawable, texture } = selectBaseGameAssets(listing?.entries, ped, component, indices[component], {
      race: DEFAULT_RACE,
      collections: listing?.collections,
      variant: "a",
    });
    if (!drawable) {
      warnings.push(`${component} ${indices[component]} isn't in the game files`);
      return null;
    }
    try {
      const exported = await exportPedAsset(ped, drawable);
      const textures = texture ? await exportPedAsset(ped, texture) : null;
      throwIfAborted(signal);
      const group = await buildSlotGroup({
        component,
        drawablePath: exported?.path,
        texturePaths: (textures?.textures || []).map((item) => item.path),
        readFile,
        renderer,
        signal,
        skeleton,
      });
      group.userData.skinTintable = isSkinTintSlot({ component, drawableFile: drawable.file, textureFile: texture?.file });
      setGroupSkinTint(group, tint);
      setGroupHairColor(group, { color: hairColor, highlight: hairColor });
      return group;
    } catch (error) {
      if (error?.name === "AbortError" || signal?.aborted) throw error;
      warnings.push(`${component}: ${error?.message || error}`);
      return null;
    }
  }));
  const groups = settled.map((result) => (result.status === "fulfilled" ? result.value : null));
  const failure = settled.find((result) => result.status === "rejected");
  if (signal?.aborted || failure) {
    for (const group of groups) if (group) disposeSlotGroup(group);
    throw signal?.aborted ? abortError() : failure.reason;
  }
  for (const group of groups) if (group) root.add(group);
  if (!root.children.length) throw new Error("No part of the ped loaded from the game files.");
  updatePedPropAttachments(root);
  return createPedController({ root, skeleton, warnings });
}

function createPedController({ root, skeleton, warnings }) {
  const { holder, ground } = createHolder("ped");
  const facing = new THREE.Group();
  facing.rotation.y = PED_FACING;
  ground.add(facing);
  facing.add(root);

  let clip = null;
  let time = 0;

  const settle = () => {
    measureFloor(holder, ground, () => {
      let lowest = Infinity;
      const sample = () => {
        const bounds = computePedBounds(root);
        if (bounds) lowest = Math.min(lowest, bounds.min.y);
      };
      if (clip) {
        // The floor sits under the lowest point across the clip, so feet
        // never sink through it while the animation plays.
        for (let i = 0; i < FLOOR_SAMPLES; i += 1) {
          setPedPose(root, skeleton, sampleClipPose(skeleton, clip, (clip.duration * i) / FLOOR_SAMPLES));
          sample();
        }
        setPedPose(root, skeleton, sampleClipPose(skeleton, clip, time));
      } else {
        setPedPose(root, skeleton, null);
        sample();
      }
      return lowest;
    });
  };
  settle();

  return {
    kind: "ped",
    holder,
    rig: null,
    warnings,
    get duration() {
      return clip?.duration || 0;
    },
    get time() {
      return time;
    },

    /** Loads the look's pose clip from the game files; the bind pose for none. */
    async setPose(look, signal) {
      const wanted = photoPoseClip(look);
      if (!wanted) {
        clip = null;
        time = 0;
        settle();
        return null;
      }
      const result = await getPedClip(wanted.dict, wanted.clip);
      throwIfAborted(signal);
      if (!isValidClip(result)) throw new Error(`${wanted.dict} / ${wanted.clip} came back empty.`);
      clip = result;
      time = Math.min(Math.max(0, Number(look.time) || 0), clip.duration);
      settle();
      return { duration: clip.duration };
    },

    setTime(seconds) {
      if (!clip) return;
      time = ((Number(seconds) || 0) % clip.duration + clip.duration) % clip.duration;
      setPedPose(root, skeleton, sampleClipPose(skeleton, clip, time));
    },

    /** Plays the clip in place. Returns true while there is a clip to play. */
    step(dt) {
      if (!clip) return false;
      this.setTime(time + dt);
      return true;
    },

    dispose() {
      holder.removeFromParent();
      for (const group of [...root.children]) disposeSlotGroup(group);
    },
  };
}
