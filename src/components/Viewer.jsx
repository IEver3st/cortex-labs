import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import { DDSLoader } from "three/examples/jsm/loaders/DDSLoader";
import { TGALoader } from "three/examples/jsm/loaders/TGALoader";
import { DFFLoader } from "dff-loader";
import { invoke } from "@tauri-apps/api/core";
import { readFile, stat } from "@tauri-apps/plugin-fs";
import { parseYftAsync } from "../lib/yft-loader";
import { parseClmesh } from "../lib/clmesh.js";
import { getBridgeParseIdentity, getLoadedModelCacheKey, getModelCacheKey, isBridgeCancelled, readBridgeWarnings, requestBridgeParse } from "../lib/model-load.js";
import { UV_ORIGIN_TOP, userTextureUvAttribute } from "../lib/clmesh-object.js";
import { getModelExtras, loadVehicleModPart, summarizeParentTextures } from "../lib/vehicle-mod-parts.js";
import { createPartSwapAnimator, enterDelay, prefersReducedMotion, SWAP_HANDOFF_MS } from "../lib/part-swap-animation.js";
import { parseDDSAsync } from "../lib/dds";
import { createTextureCache, getTextureCacheKey as buildTextureCacheKey } from "../lib/texture-cache.js";
import { buildModelTemplateMap, buildModelTemplateSets } from "../lib/template-map";
import { getTemplateModelPolicy } from "../lib/template-model";
import {
  getFileExtension,
  getFileNameWithoutExtension,
  getTextureMimeType,
  sniffTextureSignature,
  heightToFootprintRatio,
  maybeAutoFixYftUpAxis,
  setupLiveryShader,

  buildDrawableObject,
  hasRenderableMeshes,
  disposeObject,
  disposeMaterial,
  normalizeLoadedMeshes,
  setupWasdControls,
  setupWheelWhileDragging,
  buildCageOverlay,
  disposeCageOverlay,
  loadTextureFromPath as loadTextureFromPathShared,
  loadBlobTexture,
  disposeTexture,
  loadPsdTexture,
  loadPdnTexture,
  YDD_SCAN_SETTINGS,
} from "../lib/viewer-utils";
import {
  buildCameraFraming,
  computeFramingBounds,
  CAMERA_PRESET_KEYS,
  DEFAULT_CAMERA_PRESET,
} from "../lib/camera-framing.js";
import {
  cloneViewerCameraState,
  restoreViewerCameraState,
  syncViewerCameraPose,
} from "../lib/camera-state.js";
import {
  applyShadowFlags,
  BLOOM_STRENGTH,
  configureShadowLight,
  createAoPipeline,
  createBloomPipeline,
  createSolidWireMaterial,
  disposeAoPipeline,
  disposeBloomPipeline,
  FLOOR_LIGHT_LAYER,
  renderWithEffects,
  resizeAoPipeline,
  resizeBloomPipeline,
  setAoBounds,
} from "../lib/viewer-render-effects.js";
import { createEmergencyLightRig } from "../lib/emergency-light-rig.js";
import { TURNTABLE_DEFAULT_SPEED, stepTurntable, withTurntableAtRest } from "../lib/turntable.js";
import { normalizeModelRotation, orientModel } from "../lib/model-orientation.js";
import { isYtdTexturePath, resolveYtdTexturePath } from "../lib/ytd-texture.js";
import { createPlateOverlay, findPlateMeshes } from "../lib/license-plate-overlay.js";
import { buildPlateImage } from "../lib/license-plate-assets.js";
import { anyLightOn, summarizeVehicleLights } from "../lib/emergency-lights.js";
import { stabilizeObjectForWorld } from "../lib/model-normalization.js";
import { createViewerStage } from "../lib/viewer-stage.js";
import {
  applyNativeManifestToMeshes,
  findLiveryTexturePrefix,
  normalizeManifestLightBones,
  resolvePaintLayerSlot,
  summarizeNativeMaterialMeshes,
} from "../lib/native-material-plan.js";
import { loadNativeMaterialView, loadNativeTextureSource, setNativeOverlayTexture } from "../lib/native-materials.js";
import { createLiveryOverride, findLiveryModTexturePath, findLiverySignPrefix, listTextureLiveries } from "../lib/vehicle-livery.js";
import { applyFrontWheelSteering, getSteerableWheelMeshes } from "../lib/vehicle-steering.js";
import { createVehicleRig, normalizeManifestSkeleton } from "../lib/vehicle-rig.js";
import { isHiddenByBones } from "../lib/vehicle-modkits.js";
import { containFov, shotFov } from "../lib/eup-export.js";
import { countDrawnGeometry, summarizeMeshStats } from "../lib/mesh-stats.js";
import { buildCollisionOverlay, readModelCollisions } from "../lib/collision-overlay.js";
import { onViewerControlsChange, previewPixelRatio, readViewerControls } from "../lib/preview-detail.js";
import {
  FINISHED_PAINT_KEYS,
  VEHICLE_PAINT_KEYS,
  normalizeVehiclePaint,
  paintDisplayColor,
  paintFinishProfile,
} from "../lib/vehicle-paint.js";

const defaultBody = "#dfe4ea";
// Night light preview: studio light multiplier and workbench backdrop.
const NIGHT_LIGHT_SCALE = 0.08;
const NIGHT_BACKGROUND = "#07080b";
// How long the view holds still before siren markers re-check which lights sit
// behind the body.
const SIREN_SIDES_SETTLE_MS = 120;
// Raycast time per frame for that check, so it never drops a frame.
const SIREN_SIDES_BUDGET_MS = 3;
const ALL_TARGET = "all";
const MATERIAL_TARGET_PREFIX = "material:";
const MESH_TARGET_PREFIX = "mesh:";
const EMPTY_TEMPLATE_PART_NAMES = Object.freeze([]);
const LIVERY_TOKEN_SPLIT = /[^a-z0-9]+/g;
const EXTERIOR_INCLUDE_TOKENS = [
  "carpaint",
  "vehicle_paint",
  "car_paint",
  "car-paint",
  "livery",
  "sign",
  "decal",
  "logo",
  "wrap",
  "body",
  "bodyshell",
  "shell",
  "exterior",
  "panel",
  "door",
  "hood",
  "bonnet",
  "roof",
  "trunk",
  "boot",
  "bumper",
  "fender",
  "quarter",
  "skirt",
  "spoiler",
  "mirror",
  "lid",
  "light",
  "lights",
  "lightbar",
  "emissive",
  "beacon",
  "siren",
  "badge",
  "badges",
  "detail",
];
const EXTERIOR_EXCLUDE_TOKENS = [
  "glass",
  "window",
  "interior",
  "seat",
  "dash",
  "steer",
  "wheel",
  "tire",
  "rim",
  "brake",
  "engine",
  "suspension",
  "chassis",
  "under",
  "undercarriage",
];
// Shared across every mounted viewer; keyed by path+flip, see texture-cache.js.
const textureCache = createTextureCache();
const MODEL_CACHE_LIMIT = 4;
const modelCache = new Map();
// A hidden tab keeps its renderer, but after this long its GPU textures are
// dropped; three re-uploads them from the retained CPU-side images on the
// next frame once the tab is active again.
const IDLE_GPU_RELEASE_MS = 5 * 60 * 1000;
const DEFAULT_MATERIAL_CONFIG = {
  type: "paint",
  lightIntensity: 1.0,
  glossiness: 0.62,
  roughness: 0.28,
  clearcoat: 0.72,
};
const MATERIAL_TYPE_PRESETS = {
  paint: { metalness: 0.22, transparency: 0, transmission: 0, depthWrite: true },
  chrome: { metalness: 1.0, transparency: 0, transmission: 0, depthWrite: true },
  plastic: { metalness: 0.06, transparency: 0, transmission: 0, depthWrite: true },
  metal: { metalness: 0.82, transparency: 0, transmission: 0, depthWrite: true },
  glass: { metalness: 0.0, transparency: 0.62, transmission: 0.9, depthWrite: false },
};
const LIVERY_UV_MIN_CONFIDENCE = 0.55;
const LIVERY_UV_FALLBACK_MARGIN = 0.2;
const AUTO_TEXTURE_NEUTRAL_COLOR = new THREE.Color(0xffffff);
const AUTO_TEXTURE_BLACK = new THREE.Color(0x000000);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Paint slot for meshes without vehicle shader data (peds, props, models from
// other tools), by name. Lights, badges and trim are not body paint.
function detectVehicleColorSlot(names, isGlass) {
  if (isGlass) return null;
  const raw = names
    .map((name) => (typeof name === "string" ? name.trim().toLowerCase() : ""))
    .filter(Boolean)
    .join(" ");

  if (!raw) return null;

  if (
    /vehicle[_-]?paint[_-]?2/.test(raw) ||
    /car[_-]?paint[_-]?2/.test(raw) ||
    /carpaint2/.test(raw) ||
    /secondary/.test(raw)
  ) {
    return "secondary";
  }

  if (
    raw.includes("lightsemissive") ||
    raw.includes("vehicle_lights") ||
    raw.includes("lightbar") ||
    raw.includes("emissive") ||
    raw.includes("siren") ||
    raw.includes("beacon") ||
    raw.includes("vehicle_detail") ||
    raw.includes("badge") ||
    raw.includes("accent") ||
    raw.includes("trim")
  ) {
    return null;
  }

  if (
    raw.includes("vehicle_paint") ||
    raw.includes("carpaint") ||
    raw.includes("car_paint") ||
    raw.includes("car-paint") ||
    raw.includes("livery") ||
    raw.includes("vehicle_sign") ||
    raw.includes("decal") ||
    raw.includes("logo") ||
    raw.includes("wrap") ||
    matchesExteriorIncludedName(raw)
  ) {
    return "primary";
  }

  return null;
}

// Body paint meshes that count as the exterior shell.
const EXTERIOR_PAINT_SLOTS = new Set(["primary", "secondary", "pearlescent"]);

function getTextureCacheKey(path, flipY) {
  return buildTextureCacheKey(path, flipY);
}

function getCachedTexture(key) {
  return textureCache.get(key);
}

function cacheTexture(key, texture) {
  textureCache.set(key, texture);
}

function retainTexture(texture) {
  textureCache.retain(texture);
}

function releaseTexture(texture) {
  textureCache.release(texture);
}

// Per-viewer memory of the reload token a cache key was last loaded at. A
// changed token means this viewer saw a file save, so the cached texture may
// only be reused when another viewer already refreshed it (newer generation).
function shouldReuseCachedTexture(seenMap, key, token) {
  const seen = seenMap.get(key);
  if (!seen) return true;
  if (seen.token === token) return true;
  return textureCache.getGeneration(key) > seen.generation;
}

function rememberLoadedTexture(seenMap, key, token) {
  seenMap.set(key, { token, generation: textureCache.getGeneration(key) });
}

function collectMaterialTextures(object, out) {
  if (!object) return out;
  object.traverse((child) => {
    if (!child?.isMesh) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (!material) continue;
      for (const value of Object.values(material)) {
        if (value?.isTexture) out.add(value);
      }
    }
  });
  return out;
}

function touchModelCache(key) {
  const entry = modelCache.get(key);
  if (!entry) return null;
  modelCache.delete(key);
  modelCache.set(key, entry);
  return entry;
}

function getCachedModelTemplate(key) {
  if (!key) return null;
  return touchModelCache(key);
}

function pruneModelCache() {
  while (modelCache.size > MODEL_CACHE_LIMIT) {
    const [oldestKey, oldestEntry] = modelCache.entries().next().value || [];
    if (!oldestKey) break;
    modelCache.delete(oldestKey);
    disposeObject(oldestEntry?.template);
  }
}

// `key` comes from getModelCacheKey (file path, mtime, size and variant).
// `meta.sourcePath` and `meta.fileKey` let a parse of a file that has since
// been saved again drop the older version's entries, which are never read;
// `meta.bridgeIdentity` does the same for a model from an older bridge parse.
function cacheModelTemplate(key, template, meta = null) {
  if (!key || !template) return;
  const existing = modelCache.get(key);
  if (existing?.template && existing.template !== template) {
    disposeObject(existing.template);
  }
  if (meta?.sourcePath && meta.fileKey) {
    for (const [otherKey, entry] of [...modelCache]) {
      const olderParse = Boolean(meta.bridgeIdentity && entry.bridgeIdentity && entry.bridgeIdentity !== meta.bridgeIdentity);
      if (entry.sourcePath !== meta.sourcePath || (entry.fileKey === meta.fileKey && !olderParse)) continue;
      modelCache.delete(otherKey);
      disposeObject(entry.template);
    }
  }
  modelCache.delete(key);
  modelCache.set(key, { template, ...(meta || {}) });
  pruneModelCache();
}

// Geometries are read-only shared buffers (UV swaps keep their base sets in
// geometry.userData), so the cached template shares them with the first live
// object and only cache hits pay for a geometry clone. Materials are always
// cloned because the viewer mutates them per tab.
function cloneCachedModelTemplate(template, { cloneGeometry = true } = {}) {
  if (!template) return null;
  const clone = template.clone(true);
  clone.traverse((child) => {
    if (!child?.isMesh) return;
    if (cloneGeometry && child.geometry?.clone) {
      child.geometry = child.geometry.clone();
    }
    if (Array.isArray(child.material)) {
      child.material = child.material.map((material) => (material?.clone ? material.clone() : material));
    } else if (child.material?.clone) {
      child.material = child.material.clone();
    }
    child.userData = { ...(child.userData || {}) };
    delete child.userData.baseMaterial;
    delete child.userData.appliedMaterial;
    delete child.userData.textureMeta;
  });
  return clone;
}

function isTauriRuntimeAvailable() {
  return (
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__ !== "undefined" &&
    typeof window.__TAURI_INTERNALS__?.invoke === "function"
  );
}

function decodeUtf8(bytes) {
  if (!bytes) return "";
  return new TextDecoder("utf-8").decode(bytes);
}

async function readJsonFile(path) {
  if (!path) return null;
  const bytes = await readFile(path);
  return JSON.parse(decodeUtf8(bytes));
}

function isAbsolutePath(path) {
  if (typeof path !== "string") return false;
  return /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\") || path.startsWith("/");
}

function ViewerComponent({
  modelPath,
  texturePath,
  windowTexturePath,
  bodyColor,
  vehiclePaint,
  backgroundColor,
  backgroundImagePath = "",
  backgroundImageReloadToken = 0,
  backgroundImageBlur = 0,
  textureReloadToken,
  windowTextureReloadToken = textureReloadToken,
  textureTarget,
  windowTextureTarget,
  textureMode = "everything",
  liveryExteriorOnly = false,
  showWireframe = false,
  showCageWireframe = false,
  // Shaded model with its triangle edges drawn over it; reports onMeshStats.
  showSolidWireframe = false,
  onMeshStats,
  showCollisions = false,
  collisionsOnly = false,
  onCollisions,
  flipTextureY = true,
  wasdEnabled = false,
  showGrid = false,
  lightIntensity = 1.0,
  lightAzimuth = 54,
  lightElevation = 46,
  glossiness = 0.5,
  shadowsEnabled = false,
  ambientOcclusion = false,
  stage = "workbench",
  stageSpot = 1,
  stageReflect = 0.6,
  stageBeam = true,
  stageLight = "top",
  stageFloor = "concrete",
  // Showroom rim light strength; EUP passes its Settings > Studio value, vehicles have none.
  stageRim = 0,
  turntable = false,
  turntableSpeed = TURNTABLE_DEFAULT_SPEED,
  materialType = "paint",
  materialLightIntensity = 1.0,
  materialGlossiness = 0.62,
  materialRoughness = 0.28,
  materialClearcoat = 0.72,
  materialTexturePath = "",
  // Quarter turns the user applied ([x, y, z, w] or null); undefined leaves the
  // orientation to rotateModel callers such as the Template Generator.
  modelRotation = undefined,
  nativeMaterialsEnabled = false,
  nativeMaterialsReloadToken = 0,
  vehicleMods = null,
  gameLivery = null,
  onGameLiveryStatus,
  steeringAngle = 0,
  roofClip = null,
  onVehiclePartsChange,
  onPaintSlotsChange,
  vehicleLights = null,
  licensePlate = null,
  onLicensePlateStatus,
  extrasPlan = null,
  onVehicleModsStatus,
  onReady,
  // Called right after each live frame is drawn, so DOM overlays can follow
  // the camera in the same frame the canvas shows.
  onFrame,
  onModelInfo,
  onModelError,
  onModelLoading,
  onTextureReload,
  onTextureError,
  onWindowTextureError,
  onFormatWarning,
  onAssetError,
  onNativeMaterialsStatus,
  isActive = true,
  includeTemplateGeometry = false,
  // Bumped to load the same model again after its files changed on disk.
  modelReloadToken = 0,
  templatePartPickEnabled = false,
  selectedTemplatePartNames = EMPTY_TEMPLATE_PART_NAMES,
  hoveredTemplatePartName = "",
  onTemplatePartHover,
  onTemplatePartLeave,
  onTemplatePartPick,
}) {
  const containerRef = useRef(null);
  const rendererRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const controlsRef = useRef(null);
  const modelRef = useRef(null);
  const textureRef = useRef(null);
  const windowTextureRef = useRef(null);
  const materialTextureRef = useRef(null);
  const backgroundTextureRef = useRef(null);
  const templatePartOverlayRef = useRef(null);
  const lightsRef = useRef({ ambient: null, key: null, rim: null });
  const stageRef = useRef(null);
  // The vehicle sits in this group; it turns about the world Y axis, which
  // runs through the vehicle's centre (stabilizeObjectForWorld centres it).
  const turntableRef = useRef(null);
  const turntableStateRef = useRef({ on: turntable, speed: turntableSpeed });
  turntableStateRef.current = { on: turntable, speed: turntableSpeed };
  const stageModeRef = useRef(stage);
  const fitRef = useRef({
    bounds: null,
    center: new THREE.Vector3(),
    distance: 4,
    baseDistance: 4,
    presetKey: DEFAULT_CAMERA_PRESET,
    zoomFactor: 1,
  });
  const [sceneReady, setSceneReady] = useState(false);
  const requestRenderRef = useRef(null);
  const reframeModelRef = useRef(null);
  // The path of the model on screen: loading it again keeps the user's view.
  const shownModelPathRef = useRef("");
  const wasdStateRef = useRef({
    forward: false,
    back: false,
    left: false,
    right: false,
    up: false,
    down: false,
    boost: false,
  });
  const wasdFrameRef = useRef(0);
  const onReadyRef = useRef(onReady);
  const onFrameRef = useRef(onFrame);
  const compositeTextureRef = useRef(null);
  const loadedTextureTokensRef = useRef(new Map());
  const loadedWindowTextureTokensRef = useRef(new Map());
  const onModelInfoRef = useRef(onModelInfo);
  const onModelErrorRef = useRef(onModelError);
  const onModelLoadingRef = useRef(onModelLoading);
  const onTextureErrorRef = useRef(onTextureError);
  const onWindowTextureErrorRef = useRef(onWindowTextureError);
  const onFormatWarningRef = useRef(onFormatWarning);
  // Background image and material map failures, which have no slot of their own.
  const onAssetErrorRef = useRef(onAssetError);
  onAssetErrorRef.current = onAssetError;
  const onNativeMaterialsStatusRef = useRef(onNativeMaterialsStatus);
  const onVehicleModsStatusRef = useRef(onVehicleModsStatus);
  const onGameLiveryStatusRef = useRef(onGameLiveryStatus);
  onGameLiveryStatusRef.current = onGameLiveryStatus;
  const vehicleModsRef = useRef(vehicleMods);
  vehicleModsRef.current = vehicleMods;
  const templatePartPickEnabledRef = useRef(templatePartPickEnabled);
  const onTemplatePartHoverRef = useRef(onTemplatePartHover);
  const onTemplatePartLeaveRef = useRef(onTemplatePartLeave);
  const onTemplatePartPickRef = useRef(onTemplatePartPick);
  const isActiveRef = useRef(isActive);
  const shadowsEnabledRef = useRef(shadowsEnabled);
  const ambientOcclusionRef = useRef(ambientOcclusion);
  const materialStateRef = useRef({});
  const templatePickStateRef = useRef({
    pointerId: null,
    startX: 0,
    startY: 0,
    moved: false,
  });
  const cameraStateRef = useRef({
    presetKey: DEFAULT_CAMERA_PRESET,
    zoomFactor: 1,
  });
  const [modelVersion, setModelVersion] = useState(0);
  const [vehicleModsRevision, setVehicleModsRevision] = useState(0);
  // Bumped each time the model's native materials finish loading, so the game
  // livery is put back on the fresh materials.
  const [nativeReadyVersion, setNativeReadyVersion] = useState(0);
  const lightRigRef = useRef(null);
  // Far-side flags for the siren editor's markers, keyed by camera and anchors.
  const sirenSidesRef = useRef({ rig: null, key: "", since: 0, done: "", scan: null, far: new Set() });
  // Mod part and extra swaps animate on proxies (part-swap-animation.js).
  const partSwapRef = useRef(null);
  // Doors, bonnet, boot and convertible roof of the loaded vehicle (vehicle-rig.js).
  const vehicleRigRef = useRef(null);
  const vehiclePartDragRef = useRef(null);
  const onVehiclePartsChangeRef = useRef(onVehiclePartsChange);
  onVehiclePartsChangeRef.current = onVehiclePartsChange;
  const onPaintSlotsChangeRef = useRef(onPaintSlotsChange);
  onPaintSlotsChangeRef.current = onPaintSlotsChange;
  const emitVehicleParts = () => onVehiclePartsChangeRef.current?.(snapshotVehicleRig(vehicleRigRef.current));
  const bloomRef = useRef(null);
  const plateOverlayRef = useRef(null);
  const onLicensePlateStatusRef = useRef(onLicensePlateStatus);
  onLicensePlateStatusRef.current = onLicensePlateStatus;
  const aoRef = useRef(null);
  const solidWireRef = useRef({ on: showSolidWireframe, material: null });
  solidWireRef.current.on = showSolidWireframe;
  const onMeshStatsRef = useRef(onMeshStats);
  onMeshStatsRef.current = onMeshStats;
  const collisionRef = useRef({ overlay: null, key: "", request: 0, hidden: [] });
  const onCollisionsRef = useRef(onCollisions);
  onCollisionsRef.current = onCollisions;
  // null forces the first drawn frame to report.
  const meshStatsKeyRef = useRef(null);
  const solidWirePass = () => {
    const wire = solidWireRef.current;
    if (!wire.on || !modelRef.current) return null;
    wire.material ||= createSolidWireMaterial();
    return { roots: [modelRef.current], material: wire.material };
  };
  // Runs after each drawn frame: a cheap count, and the full summary only when
  // the drawn geometry changed (a part swap, extras, exterior-only, a new model).
  const reportMeshStats = () => {
    const model = solidWireRef.current.on ? modelRef.current : null;
    const counts = model ? countDrawnGeometry([model]) : null;
    const key = counts ? `${counts.meshes}:${counts.triangles}:${counts.vertices}` : "";
    if (key === meshStatsKeyRef.current) return;
    meshStatsKeyRef.current = key;
    onMeshStatsRef.current?.(model ? summarizeMeshStats([model]) : null);
  };
  const nightLights = Boolean(vehicleLights?.switches?.night && anyLightOn(vehicleLights.switches));

  const resolvedBodyColor = bodyColor || defaultBody;
  const resolvedPaint = useMemo(
    () => normalizeVehiclePaint(vehiclePaint, resolvedBodyColor),
    [vehiclePaint, resolvedBodyColor],
  );

  const textureLoader = useMemo(() => new THREE.TextureLoader(), []);
  const isTauriRuntime = isTauriRuntimeAvailable();

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  useEffect(() => {
    onFrameRef.current = onFrame;
  }, [onFrame]);

  useEffect(() => {
    onModelInfoRef.current = onModelInfo;
  }, [onModelInfo]);

  useEffect(() => {
    onModelErrorRef.current = onModelError;
  }, [onModelError]);

  useEffect(() => {
    onModelLoadingRef.current = onModelLoading;
  }, [onModelLoading]);

  useEffect(() => {
    onTextureErrorRef.current = onTextureError;
    onWindowTextureErrorRef.current = onWindowTextureError;
    onFormatWarningRef.current = onFormatWarning;
  }, [onTextureError, onWindowTextureError, onFormatWarning]);

  useEffect(() => {
    onNativeMaterialsStatusRef.current = onNativeMaterialsStatus;
  }, [onNativeMaterialsStatus]);

  useEffect(() => {
    onVehicleModsStatusRef.current = onVehicleModsStatus;
  }, [onVehicleModsStatus]);

  useEffect(() => {
    templatePartPickEnabledRef.current = Boolean(templatePartPickEnabled);
    onTemplatePartHoverRef.current = onTemplatePartHover;
    onTemplatePartLeaveRef.current = onTemplatePartLeave;
    onTemplatePartPickRef.current = onTemplatePartPick;
  }, [
    onTemplatePartHover,
    onTemplatePartLeave,
    onTemplatePartPick,
    templatePartPickEnabled,
  ]);

  const releaseIdleGpuResources = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const textures = new Set();
    for (const texture of [
      textureRef.current,
      windowTextureRef.current,
      materialTextureRef.current,
      backgroundTextureRef.current,
      sceneRef.current?.background,
    ]) {
      if (texture?.isTexture) textures.add(texture);
    }
    collectMaterialTextures(modelRef.current, textures);
    for (const texture of textures) {
      // A texture shared with another (possibly active) viewer stays resident.
      if (textureCache.refsOf(texture) > 1) continue;
      texture.dispose?.();
    }
    renderer.renderLists?.dispose?.();
  }, []);

  useEffect(() => {
    isActiveRef.current = isActive;
    if (isActive) {
      requestRenderRef.current?.();
      return undefined;
    }
    const timer = setTimeout(releaseIdleGpuResources, IDLE_GPU_RELEASE_MS);
    return () => clearTimeout(timer);
  }, [isActive, releaseIdleGpuResources]);

  // Starting, stopping (the vehicle eases home) and speed changes need frames.
  useEffect(() => {
    requestRenderRef.current?.();
  }, [turntable, turntableSpeed]);

  // Imperative composite input (Variant Builder): the caller owns a canvas or
  // ImageBitmap that is redrawn in place, so the same source only needs a GPU
  // re-upload instead of a PNG encode/decode round trip.
  const applyCompositeTexture = useCallback((source) => {
    const previous = compositeTextureRef.current;
    let texture = null;
    if (source) {
      if (previous && previous.image === source) {
        texture = previous;
        texture.needsUpdate = true;
      } else {
        texture = new THREE.CanvasTexture(source);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.flipY = true;
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.anisotropy = rendererRef.current?.capabilities.getMaxAnisotropy() || 1;
        texture.needsUpdate = true;
      }
    }
    if (previous && previous !== texture) {
      if (textureRef.current === previous) textureRef.current = null;
      previous.dispose();
    }
    compositeTextureRef.current = texture;
    if (textureRef.current !== texture) {
      releaseTexture(textureRef.current);
      textureRef.current = texture;
    }
    const materialState = materialStateRef.current;
    if (modelRef.current) {
      applyMaterials(
        modelRef.current,
        materialState.bodyColor,
        texture,
        materialState.textureTarget,
        windowTextureRef.current,
        materialState.windowTextureTarget,
        materialState.liveryExteriorOnly,
        materialState.textureMode,
        materialState.glossiness,
        materialState.showWireframe,
      );
      requestRenderRef.current?.();
    }
    onTextureErrorRef.current?.("");
  }, []);

  useEffect(() => {
    const scene = sceneRef.current;
    const model = modelRef.current;
    const removeOverlay = () => {
      const overlayGroup = templatePartOverlayRef.current;
      if (!overlayGroup) return;
      overlayGroup.parent?.remove(overlayGroup);
      overlayGroup.traverse((child) => {
        if (child?.material?.dispose) child.material.dispose();
      });
      templatePartOverlayRef.current = null;
    };

    removeOverlay();
    if (!scene || !model || !templatePartPickEnabled) return removeOverlay;

    const selectedNames = new Set(normalizeTemplatePartNames(selectedTemplatePartNames));
    const hoveredName = typeof hoveredTemplatePartName === "string"
      ? hoveredTemplatePartName.trim()
      : "";
    if (selectedNames.size === 0 && !hoveredName) return removeOverlay;

    model.updateMatrixWorld(true);
    const overlayGroup = new THREE.Group();
    overlayGroup.name = "template-part-selection";
    overlayGroup.userData.templateSelectionOverlay = true;

    for (const mesh of getMeshList(model)) {
      const meshName = ensureMeshLabel(mesh);
      const isSelected = selectedNames.has(meshName);
      const isHovered = Boolean(hoveredName && hoveredName === meshName);
      if (!isSelected && !isHovered) continue;

      const material = new THREE.MeshBasicMaterial({
        color: isHovered ? 0x68dad5 : 0xd97952,
        transparent: true,
        opacity: isHovered ? 0.58 : 0.38,
        wireframe: true,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const overlay = new THREE.Mesh(mesh.geometry, material);
      overlay.name = `template-part-overlay:${meshName}`;
      overlay.userData.templateSelectionOverlay = true;
      overlay.matrixAutoUpdate = false;
      overlay.matrix.copy(mesh.matrixWorld);
      overlay.renderOrder = 1000;
      overlayGroup.add(overlay);
    }

    if (overlayGroup.children.length === 0) return removeOverlay;
    // attach() keeps the copied world matrices and lets the turntable carry them.
    (turntableRef.current || scene).attach(overlayGroup);
    templatePartOverlayRef.current = overlayGroup;
    requestRenderRef.current?.();

    return removeOverlay;
  }, [
    hoveredTemplatePartName,
    modelVersion,
    selectedTemplatePartNames,
    templatePartPickEnabled,
  ]);

  useEffect(() => {
    shadowsEnabledRef.current = shadowsEnabled;
  }, [shadowsEnabled]);

  useEffect(() => {
    ambientOcclusionRef.current = ambientOcclusion;
    requestRenderRef.current?.();
  }, [ambientOcclusion]);

  useEffect(() => {
    const materialConfig = {
      type: materialType,
      lightIntensity: materialLightIntensity,
      glossiness: materialGlossiness,
      roughness: materialRoughness,
      clearcoat: materialClearcoat,
    };
    materialStateRef.current = {
      bodyColor: resolvedBodyColor,
      vehiclePaint: resolvedPaint,
      textureTarget,
      windowTextureTarget,
      liveryExteriorOnly,
      textureMode,
      glossiness,
      showWireframe,
      showCageWireframe,
      nativeMaterialsEnabled,
      materialConfig,
    };
    if (modelRef.current) {
      modelRef.current.userData = modelRef.current.userData || {};
      modelRef.current.userData.materialConfig = materialConfig;
      modelRef.current.userData.materialDetailTexture = materialTextureRef.current || null;
      modelRef.current.userData.vehiclePaint = resolvedPaint;
      modelRef.current.userData.nativeMaterialsEnabled = Boolean(nativeMaterialsEnabled);
    }
  }, [
    resolvedBodyColor,
    resolvedPaint,
    textureTarget,
    windowTextureTarget,
    liveryExteriorOnly,
    textureMode,
    glossiness,
    showWireframe,
    showCageWireframe,
    nativeMaterialsEnabled,
    materialType,
    materialLightIntensity,
    materialGlossiness,
    materialRoughness,
    materialClearcoat,
  ]);

  const requestRender = useCallback(() => {
    requestRenderRef.current?.();
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const scene = new THREE.Scene();
    // The stencil lets the solid wireframe tint each pixel once (renderSolidWire).
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: false, stencil: true });
    let viewerControls = readViewerControls();
    const getPixelRatio = () => previewPixelRatio(viewerControls.detail);
    renderer.setPixelRatio(getPixelRatio());
    renderer.setClearColor(new THREE.Color(backgroundColor || "#141414"), 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = Boolean(shadowsEnabled);
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    camera.position.set(2.4, 1.2, 2.8);
    camera.layers.enable(FLOOR_LIGHT_LAYER);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.zoomToCursor = viewerControls.zoomToCursor;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };

    const wheelWhileDragging = setupWheelWhileDragging(controls, requestRenderRef);
    renderer.domElement.addEventListener("wheel", wheelWhileDragging, { passive: false });

    controls.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;

    const ambient = new THREE.AmbientLight(0xffffff, 0.5 * lightIntensity);
    const key = new THREE.DirectionalLight(0xffffff, 0.9 * lightIntensity);
    key.position.set(3.5, 4.5, 2.5);
    const rim = new THREE.DirectionalLight(0xffffff, 0.35 * lightIntensity);
    rim.position.set(-3, 2, -2.2);
    configureShadowLight(key, shadowsEnabled && stage !== "showroom");

    lightsRef.current = { ambient, key, rim };
    scene.add(ambient, key, rim, key.target);

    const stageApi = createViewerStage({ renderer, scene, keyLight: key });
    stageApi.setBackgroundColor(backgroundColor);
    stageApi.setShadows(shadowsEnabled);
    stageApi.setMode(stage);
    stageRef.current = stageApi;

    const turntableGroup = new THREE.Group();
    turntableGroup.name = "vehicle-turntable";
    scene.add(turntableGroup);
    turntableRef.current = turntableGroup;
    const measureAtRest = (run) => withTurntableAtRest(turntableGroup, run);

    renderer.domElement.addEventListener("contextmenu", (event) => {
      event.preventDefault();
    });

    containerRef.current.appendChild(renderer.domElement);

    rendererRef.current = renderer;
    sceneRef.current = scene;
    partSwapRef.current = createPartSwapAnimator({ scene });
    cameraRef.current = camera;
    controlsRef.current = controls;
    setSceneReady(true);

    let frameId = 0;
    let isRendering = false;
    let renderRequested = false;
    const lastViewport = { width: 0, height: 0, pixelRatio: 0 };
    // Bloom runs only while a vehicle light is on; the composer is created on
    // first use and kept for the life of the renderer.
    const renderView = (view) => {
      const glow = lightRigRef.current?.glow ?? 1;
      // Lit lamps always go through the glow pipeline so lenses never hide them;
      // Glow 0 keeps the sharp lamp and drops only the bloom.
      const wantBloom = Boolean(lightRigRef.current?.active);
      if (wantBloom && !bloomRef.current) {
        bloomRef.current = createBloomPipeline({
          renderer,
          scene,
          camera: view,
          width: lastViewport.width || containerRef.current?.clientWidth || 1,
          height: lastViewport.height || containerRef.current?.clientHeight || 1,
        });
      }
      if (bloomRef.current) {
        bloomRef.current.enabled = wantBloom;
        bloomRef.current.bloomPass.strength = BLOOM_STRENGTH * glow;
      }
      // AO is built on first use and kept, like bloom.
      const wantAo = Boolean(ambientOcclusionRef.current);
      if (wantAo && !aoRef.current) {
        aoRef.current = createAoPipeline({
          renderer,
          scene,
          camera: view,
          width: lastViewport.width || containerRef.current?.clientWidth || 1,
          height: lastViewport.height || containerRef.current?.clientHeight || 1,
        });
      }
      if (aoRef.current) {
        aoRef.current.enabled = wantAo;
        if (wantAo) setAoBounds(aoRef.current, fitRef.current?.bounds);
      }
      renderWithEffects({ renderer, scene, camera: view, ao: aoRef.current, bloom: bloomRef.current, wire: solidWirePass() });
    };
    const applyCameraFrame = (presetKey = cameraStateRef.current.presetKey, zoomFactor = cameraStateRef.current.zoomFactor, shouldRequestRender = true) => {
      if (!containerRef.current || !fitRef.current?.bounds) return;
      const { clientWidth, clientHeight } = containerRef.current;
      if (!clientWidth || !clientHeight) return;

      const framing = buildCameraFraming({
        bounds: fitRef.current.bounds,
        aspect: clientWidth / clientHeight,
        fov: camera.fov,
        presetKey,
        zoomFactor,
      });

      syncViewerCameraPose({
        camera,
        controls,
        position: framing.position,
        target: framing.target,
        up: framing.up,
        near: framing.near,
        far: framing.far,
        minDistance: Math.max(framing.baseDistance * 0.05, 0.1),
        // Zooming out stops at 4x the fitted distance so the model never shrinks to a speck.
        maxDistance: Math.max(framing.baseDistance * 4, 1),
      });

      fitRef.current = {
        ...fitRef.current,
        center: framing.target.clone(),
        distance: framing.distance,
        baseDistance: framing.baseDistance,
        presetKey: framing.presetKey,
        zoomFactor,
      };
      cameraStateRef.current = {
        presetKey: framing.presetKey,
        zoomFactor,
      };

      if (shouldRequestRender) requestRenderRef.current?.();
    };

    // Frames the camera on the model where it now stands (after a turn).
    const reframeModel = () => {
      if (!modelRef.current) return;
      const bounds = withTurntableAtRest(turntableRef.current, () => computeFramingBounds(
        modelRef.current,
        new THREE.Box3().setFromObject(modelRef.current),
      ));
      if (!bounds) {
        requestRenderRef.current?.();
        return;
      }
      fitRef.current = {
        ...fitRef.current,
        bounds: bounds.clone(),
        center: bounds.getCenter(new THREE.Vector3()),
      };
      applyCameraFrame(cameraStateRef.current.presetKey, cameraStateRef.current.zoomFactor);
    };
    reframeModelRef.current = reframeModel;

    // Renders one frame from a framing preset with a throwaway camera. The
    // caller must render the live camera again in the same task, so the
    // browser never presents this frame and the user's view never moves.
    const renderPresetShot = (presetKey, zoomFactor) => {
      if (!containerRef.current || !fitRef.current?.bounds) return false;
      const { clientWidth, clientHeight } = containerRef.current;
      if (!clientWidth || !clientHeight) return false;
      const framing = buildCameraFraming({
        bounds: fitRef.current.bounds,
        aspect: clientWidth / clientHeight,
        fov: camera.fov,
        presetKey,
        zoomFactor,
      });
      const shot = camera.clone();
      shot.position.copy(framing.position);
      shot.up.copy(framing.up);
      shot.near = framing.near;
      shot.far = framing.far;
      shot.lookAt(framing.target);
      shot.updateProjectionMatrix();
      shot.updateMatrixWorld(true);
      if (turntableGroup.rotation.y === 0) {
        renderView(shot);
        return true;
      }
      // A named shot ("Front", "Side") is of the vehicle at rest, not wherever
      // the turntable has it. Overlays that copy world matrices follow it there
      // and back.
      withTurntableAtRest(turntableGroup, () => {
        syncWorldOverlays(shot);
        renderView(shot);
      });
      syncWorldOverlays(camera);
      return true;
    };

    const syncWorldOverlays = (view) => {
      plateOverlayRef.current?.update();
      lightRigRef.current?.update(view);
    };

    const restoreLiveFrame = () => {
      renderView(camera);
    };

    const encodeCanvas = (thumbWidth) => {
      const source = renderer.domElement;
      if (!thumbWidth || source.width <= thumbWidth) return source.toDataURL("image/png");
      const scale = thumbWidth / source.width;
      const thumb = document.createElement("canvas");
      thumb.width = Math.round(source.width * scale);
      thumb.height = Math.round(source.height * scale);
      thumb.getContext("2d").drawImage(source, 0, 0, thumb.width, thumb.height);
      return thumb.toDataURL("image/jpeg", 0.88);
    };

    const canRenderFrame = () => {
      if (!isActiveRef.current) return false;
      const container = containerRef.current;
      return Boolean(container && container.clientWidth > 0 && container.clientHeight > 0);
    };

    let turntableAt = null;
    const advanceTurntable = () => {
      const now = performance.now();
      const { on, speed } = turntableStateRef.current;
      const seconds = turntableAt == null ? 0 : (now - turntableAt) / 1000;
      const next = stepTurntable(turntableGroup.rotation.y, { on: on && Boolean(modelRef.current), speed, seconds });
      turntableAt = next.moving ? now : null;
      if (next.yaw !== turntableGroup.rotation.y) {
        turntableGroup.rotation.y = next.yaw;
        stageRef.current?.setSpin(next.yaw);
      }
      return next.moving;
    };

    const renderFrame = () => {
      frameId = 0;
      if (!canRenderFrame()) {
        isRendering = false;
        turntableAt = null;
        return;
      }
      const turning = advanceTurntable();
      stageRef.current?.fit(fitRef.current?.bounds, modelRef.current, { atRest: measureAtRest });
      stageRef.current?.constrainControls(controls);
      const needsUpdate = controls.update();
      // Flashing lights keep the loop running; it stops when they do.
      const lightsAnimating = lightRigRef.current?.update(camera) || false;
      // Opening doors and a moving roof do too, and report where they settled.
      const vehicleRig = vehicleRigRef.current;
      const partsAnimating = vehicleRig?.update(performance.now()) || false;
      if (vehicleRig && vehicleRig.wasAnimating && !partsAnimating) emitVehicleParts();
      if (vehicleRig) vehicleRig.wasAnimating = partsAnimating;
      const swapsAnimating = partSwapRef.current?.tick() || false;
      plateOverlayRef.current?.update();
      renderView(camera);
      onFrameRef.current?.();
      reportMeshStats();
      if (renderRequested || needsUpdate || lightsAnimating || partsAnimating || swapsAnimating || turning) {
        renderRequested = false;
        frameId = requestAnimationFrame(renderFrame);
      } else {
        isRendering = false;
      }
    };

    const requestRenderFrame = () => {
      if (!canRenderFrame()) return;
      renderRequested = true;
      if (isRendering) return;
      isRendering = true;
      frameId = requestAnimationFrame(renderFrame);
    };

    requestRenderRef.current = requestRenderFrame;

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    // Window templates: a click on glass adds or removes that part. Plain
    // drags still orbit.
    const isPartPickingEnabled = () =>
      Boolean(
        templatePartPickEnabledRef.current &&
          (onTemplatePartHoverRef.current ||
            onTemplatePartLeaveRef.current ||
            onTemplatePartPickRef.current),
      );

    // Other click handlers stand down while a template pick owns the pointer.
    const isTemplatePickingEnabled = isPartPickingEnabled;

    const clearTemplatePickHover = () => {
      renderer.domElement.style.cursor = "";
      onTemplatePartLeaveRef.current?.();
    };

    const getTemplatePickHit = (event) => {
      if (!modelRef.current) return null;
      const rect = renderer.domElement.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;

      const clientX = Number(event?.clientX);
      const clientY = Number(event?.clientY);
      if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;

      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -(((clientY - rect.top) / rect.height) * 2 - 1);
      raycaster.setFromCamera(pointer, camera);

      const intersections = raycaster.intersectObject(modelRef.current, true);
      for (const intersection of intersections) {
        const object = intersection?.object;
        if (!object?.isMesh || !object.visible) continue;
        if (object.userData?.templateSelectionOverlay) continue;
        return {
          meshName: object.userData?.meshLabel || object.name || "",
          materialName: object.material?.name || object.userData?.baseMaterial?.name || "",
        };
      }
      return null;
    };

    const reportTemplatePickHover = (hit) => {
      renderer.domElement.style.cursor = hit ? "pointer" : "crosshair";
      if (hit) onTemplatePartHoverRef.current?.(hit);
      else onTemplatePartLeaveRef.current?.();
    };

    const handleTemplatePickPointerMove = (event) => {
      if (!isPartPickingEnabled()) return;
      reportTemplatePickHover(getTemplatePickHit(event));
      const state = templatePickStateRef.current;
      if (state.pointerId !== null) {
        const distance = Math.hypot(
          Number(event.clientX) - state.startX,
          Number(event.clientY) - state.startY,
        );
        if (distance > 6) state.moved = true;
      }
    };

    const handleTemplatePickPointerDown = (event) => {
      if (!isPartPickingEnabled() || event.button !== 0) return;
      const state = templatePickStateRef.current;
      state.pointerId = event.pointerId ?? null;
      state.startX = Number(event.clientX) || 0;
      state.startY = Number(event.clientY) || 0;
      state.moved = false;
      reportTemplatePickHover(getTemplatePickHit(event));
    };

    const handleTemplatePickPointerUp = (event) => {
      if (!isPartPickingEnabled()) return;
      const state = templatePickStateRef.current;
      if (state.pointerId !== null && event.pointerId !== state.pointerId) return;
      const hit = getTemplatePickHit(event);
      reportTemplatePickHover(hit);
      if (!state.moved && hit) onTemplatePartPickRef.current?.(hit);
      state.pointerId = null;
      state.moved = false;
    };

    const handleTemplatePickPointerCancel = () => {
      if (!isPartPickingEnabled()) return;
      templatePickStateRef.current.pointerId = null;
      templatePickStateRef.current.moved = false;
      clearTemplatePickHover();
    };

    renderer.domElement.addEventListener("pointerdown", handleTemplatePickPointerDown, true);
    renderer.domElement.addEventListener("pointermove", handleTemplatePickPointerMove, true);
    renderer.domElement.addEventListener("pointerup", handleTemplatePickPointerUp, true);
    renderer.domElement.addEventListener("pointerleave", handleTemplatePickPointerCancel, true);
    renderer.domElement.addEventListener("pointercancel", handleTemplatePickPointerCancel, true);

    // Vehicle parts: a click opens or closes a door, bonnet, boot or roof;
    // Alt-drag swings a part to any angle. Plain drags still orbit.
    const setPointerRay = (event) => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
      raycaster.setFromCamera(pointer, camera);
      return true;
    };
    const pickVehiclePart = (event) => {
      const rig = vehicleRigRef.current;
      if (!rig || !modelRef.current || !setPointerRay(event)) return null;
      // The raycaster tests hidden meshes too; skip inactive LODs and hidden extras.
      const candidates = [];
      modelRef.current.traverseVisible((child) => {
        if (child.isMesh && !child.userData?.templateSelectionOverlay) candidates.push(child);
      });
      for (const hit of raycaster.intersectObjects(candidates, false)) {
        const object = hit.object;
        // The nearest visible surface decides; a body panel in front blocks the door behind it.
        const target = rig.targetForMesh(object);
        return target ? { ...target, rig, mesh: object, point: hit.point.clone() } : null;
      }
      return null;
    };
    const vehicleClick = { pointerId: null, x: 0, y: 0, time: 0, target: null };
    let hoverFrame = 0;
    let hoverEvent = null;
    const updatePartHover = () => {
      hoverFrame = 0;
      if (!hoverEvent || vehiclePartDragRef.current || isTemplatePickingEnabled()) return;
      const target = pickVehiclePart(hoverEvent);
      renderer.domElement.style.cursor = target ? (hoverEvent.altKey && target.kind === "part" ? "grab" : "pointer") : "";
    };
    const restoreVehicleDragControls = () => {
      const drag = vehiclePartDragRef.current;
      vehiclePartDragRef.current = null;
      if (drag) controls.enabled = drag.controlsEnabled;
    };
    const dragValue = (drag, event) => {
      if (!setPointerRay(event)) return null;
      const ray = raycaster.ray;
      if (drag.kind === "rotation" && Math.abs(ray.direction.dot(drag.axis)) > 0.2) {
        // Grab the part: the angle the pointer sweeps around the hinge.
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(drag.axis, drag.grab);
        const point = ray.intersectPlane(plane, new THREE.Vector3());
        if (point) {
          const from = drag.grab.clone().sub(drag.origin).projectOnPlane(drag.axis);
          const to = point.sub(drag.origin).projectOnPlane(drag.axis);
          if (from.lengthSq() > 1e-8 && to.lengthSq() > 1e-8) {
            const angle = Math.atan2(drag.axis.dot(from.clone().cross(to)), from.dot(to));
            return drag.startValue + angle;
          }
        }
      }
      // Edge-on hinges and slides: follow the grabbed point's on-screen direction of travel.
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      return drag.startValue + (dx * drag.screenDir.x + dy * drag.screenDir.y) / drag.pixelsPerUnit;
    };
    const handlePartPointerDown = (event) => {
      if (event.button !== 0 || isTemplatePickingEnabled()) return;
      const target = pickVehiclePart(event);
      vehicleClick.pointerId = null;
      if (!target) return;
      if (event.altKey && target.kind === "part") {
        const root = target.mesh.parent;
        const frame = target.rig.getPartFrame(target.part.id);
        if (!root || !frame) return;
        root.updateMatrixWorld(true);
        const origin = frame.origin.applyMatrix4(root.matrixWorld);
        const axis = frame.axis.transformDirection(root.matrixWorld).normalize();
        // How far the grabbed point moves on screen per radian or metre.
        const travel = target.part.kind === "rotation"
          ? axis.clone().cross(target.point.clone().sub(origin))
          : axis.clone();
        const rect = renderer.domElement.getBoundingClientRect();
        const toScreen = (point) => {
          const projected = point.clone().project(camera);
          return new THREE.Vector2((projected.x + 1) * 0.5 * rect.width, (1 - projected.y) * 0.5 * rect.height);
        };
        const step = 0.01;
        const screenDelta = toScreen(target.point.clone().addScaledVector(travel, step)).sub(toScreen(target.point));
        const pixelsPerUnit = Math.max(40, screenDelta.length() / step);
        vehiclePartDragRef.current = {
          rig: target.rig,
          id: target.part.id,
          kind: target.part.kind,
          origin,
          axis,
          grab: target.point,
          startValue: target.rig.getValue(target.part.id),
          startX: event.clientX,
          startY: event.clientY,
          screenDir: screenDelta.lengthSq() > 1e-6 ? screenDelta.normalize() : new THREE.Vector2(1, 0),
          pixelsPerUnit,
          pointerId: event.pointerId,
          controlsEnabled: controls.enabled,
        };
        controls.enabled = false;
        renderer.domElement.style.cursor = "grabbing";
        try {
          // Keeps the drag when the pointer leaves the canvas; dragging works without it.
          renderer.domElement.setPointerCapture(event.pointerId);
        } catch {
          // The pointer is no longer active.
        }
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      Object.assign(vehicleClick, { pointerId: event.pointerId, x: event.clientX, y: event.clientY, time: performance.now(), target });
    };
    const handlePartPointerMove = (event) => {
      const drag = vehiclePartDragRef.current;
      if (drag && event.pointerId === drag.pointerId) {
        if (drag.rig !== vehicleRigRef.current) {
          restoreVehicleDragControls();
          return;
        }
        const value = dragValue(drag, event);
        if (value != null && drag.rig.setValue(drag.id, value, { animate: false })) requestRenderFrame();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (vehicleClick.pointerId !== null && Math.hypot(event.clientX - vehicleClick.x, event.clientY - vehicleClick.y) > 5) {
        vehicleClick.pointerId = null;
      }
      if (event.buttons === 0 && vehicleRigRef.current) {
        hoverEvent = event;
        if (!hoverFrame) hoverFrame = requestAnimationFrame(updatePartHover);
      }
    };
    const handlePartPointerUp = (event) => {
      const drag = vehiclePartDragRef.current;
      if (drag && event.pointerId === drag.pointerId) {
        restoreVehicleDragControls();
        if (renderer.domElement.hasPointerCapture?.(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId);
        renderer.domElement.style.cursor = "";
        emitVehicleParts();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const click = vehicleClick.pointerId === event.pointerId ? vehicleClick.target : null;
      vehicleClick.pointerId = null;
      if (!click || click.rig !== vehicleRigRef.current || performance.now() - vehicleClick.time > 500) return;
      const toggled = click.kind === "roof" ? click.rig.toggle("roof") : click.rig.toggle(click.part.id);
      if (toggled) {
        emitVehicleParts();
        requestRenderFrame();
      }
    };
    const handlePartPointerCancel = (event) => {
      vehicleClick.pointerId = null;
      if (event.type === "pointerleave") {
        hoverEvent = null;
        if (!vehiclePartDragRef.current && !isTemplatePickingEnabled()) renderer.domElement.style.cursor = "";
      }
      if (event.type === "pointercancel" && vehiclePartDragRef.current?.pointerId === event.pointerId) {
        restoreVehicleDragControls();
        emitVehicleParts();
      }
    };
    renderer.domElement.addEventListener("pointerdown", handlePartPointerDown, true);
    renderer.domElement.addEventListener("pointermove", handlePartPointerMove, true);
    renderer.domElement.addEventListener("pointerup", handlePartPointerUp, true);
    renderer.domElement.addEventListener("pointerleave", handlePartPointerCancel, true);
    renderer.domElement.addEventListener("pointercancel", handlePartPointerCancel, true);

    const applyResize = () => {
      if (!containerRef.current) return;
      const { clientWidth, clientHeight } = containerRef.current;
      if (clientWidth === 0 || clientHeight === 0) return;
      const pixelRatio = getPixelRatio();
      const sizeChanged = clientWidth !== lastViewport.width || clientHeight !== lastViewport.height;
      if (!sizeChanged && pixelRatio === lastViewport.pixelRatio) {
        return;
      }
      lastViewport.width = clientWidth;
      lastViewport.height = clientHeight;
      // Only reconfigure pixel ratio when it actually changes (e.g. monitor switch)
      if (pixelRatio !== lastViewport.pixelRatio) {
        lastViewport.pixelRatio = pixelRatio;
        renderer.setPixelRatio(pixelRatio);
      }
      // false = don't touch canvas.style (avoids layout thrash during drag)
      renderer.setSize(clientWidth, clientHeight, false);
      stageRef.current?.resize();
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
      if (sizeChanged && fitRef.current?.bounds) {
        applyCameraFrame(cameraStateRef.current.presetKey, cameraStateRef.current.zoomFactor, false);
      }
      resizeBloomPipeline(bloomRef.current, clientWidth, clientHeight, pixelRatio);
      resizeAoPipeline(aoRef.current, clientWidth, clientHeight, pixelRatio);
      if (!isActiveRef.current) return;
      const needsUpdate = controls.update();
      renderView(camera);
      onFrameRef.current?.();
      if (needsUpdate || renderRequested) {
        requestRenderFrame();
      }
    };

    // ResizeObserver fires at most once per frame after layout, before paint.
    // Invoke applyResize directly (no RAF indirection) so the canvas buffer
    // matches the container size in the same paint frame — eliminates the
    // 1-frame size mismatch that caused visible lag during panel drag.
    const resizeObserver = new ResizeObserver(applyResize);
    resizeObserver.observe(containerRef.current);
    applyResize();
    const stopViewerControls = onViewerControlsChange(viewerControls, (next) => {
      viewerControls = next;
      controls.zoomToCursor = next.zoomToCursor;
      applyResize();
    });

    controls.addEventListener("start", requestRenderFrame);
    controls.addEventListener("change", requestRenderFrame);
    controls.addEventListener("end", requestRenderFrame);

    requestRenderFrame();

    onReadyRef.current?.({
      setExtraVisible: (index, visible) => {
        let found = false;
        modelRef.current?.traverse((child) => {
          if (!child.isMesh || child.userData?.extraIndex !== index) return;
          child.userData.metaExtraVisible = visible;
          child.visible = visible && child.userData.nativeLodActive !== false && child.userData.modHidden !== true;
          found = true;
        });
        if (found) requestRenderRef.current?.();
        return found;
      },
      /** Moves a vehicle part (joint units) or the roof ("roof", 0-1 of its clip). */
      setVehiclePart: (id, value, { animate = true } = {}) => {
        const rig = vehicleRigRef.current;
        if (!rig?.setValue(id, value, { animate })) return false;
        emitVehicleParts();
        requestRenderRef.current?.();
        return true;
      },
      toggleVehiclePart: (id) => {
        const rig = vehicleRigRef.current;
        if (!rig?.toggle(id)) return false;
        emitVehicleParts();
        requestRenderRef.current?.();
        return true;
      },
      /** Opens or closes every door, bonnet and boot together; the roof is left alone. */
      setAllVehicleParts: (open) => {
        const rig = vehicleRigRef.current;
        if (!rig) return;
        rig.setAll(Boolean(open));
        emitVehicleParts();
        requestRenderRef.current?.();
      },
      /** Seconds on the vehicle light clock, or null when no light preview exists. */
      getLightTime: () => lightRigRef.current?.time ?? null,
      /** Scrubs the vehicle light clock and redraws. */
      setLightTime: (seconds) => {
        if (!lightRigRef.current) return;
        lightRigRef.current.setTime(seconds);
        requestRenderRef.current?.();
      },
      /**
       * Siren positions in canvas CSS pixels for the siren editor's markers:
       * [{ siren, x, y, behind, far }]. `behind` marks points behind the
       * camera; `far` marks lights on the far side of the body, worked out
       * once the view holds still (it raycasts the model).
       */
      getSirenMarkers: () => {
        const rig = lightRigRef.current;
        if (!rig) return [];
        // OrbitControls moves the camera on each pointer event but its matrices
        // only catch up at the next render; until then they pair the new
        // position with the old rotation.
        camera.updateMatrixWorld();
        const width = renderer.domElement.clientWidth;
        const height = renderer.domElement.clientHeight;
        const point = new THREE.Vector3();
        const anchors = rig.getSirenAnchors();
        const sides = sirenSidesRef.current;
        const key = [...camera.matrixWorld.elements, ...anchors.flatMap(({ position }) => position.toArray())]
          .map((value) => value.toFixed(3)).join(",");
        const now = performance.now();
        if (sides.rig !== rig) Object.assign(sides, { rig, key: "", done: "", scan: null, far: new Set() });
        if (key !== sides.key) Object.assign(sides, { key, since: now, scan: null });
        else if (sides.done !== key && now - sides.since >= SIREN_SIDES_SETTLE_MS) {
          sides.scan ||= rig.scanFarSirens(camera.getWorldPosition(point), anchors);
          if (sides.scan.step(SIREN_SIDES_BUDGET_MS)) Object.assign(sides, { far: sides.scan.far, done: key, scan: null });
        }
        return anchors.map(({ siren, position }) => {
          point.copy(position).project(camera);
          return {
            siren,
            x: (point.x + 1) * 0.5 * width,
            y: (1 - point.y) * 0.5 * height,
            behind: point.z > 1,
            far: sides.far.has(siren),
          };
        });
      },
      getSirenLocalPoints: (definitions) => lightRigRef.current?.getSirenLocalPoints(definitions) ?? null,
      getViewState: () => cloneViewerCameraState({
        camera,
        controls,
        fit: fitRef.current,
        cameraState: cameraStateRef.current,
      }),
      restoreViewState: (viewState) => {
        const restored = restoreViewerCameraState({
          camera,
          controls,
          fit: fitRef.current,
          cameraState: cameraStateRef.current,
          viewState,
        });
        fitRef.current = restored.fit;
        cameraStateRef.current = restored.cameraState;

        requestRenderRef.current?.();
      },
      setPreset: (presetKey) => {
        applyCameraFrame(presetKey, cameraStateRef.current.zoomFactor);
      },
      setZoom: (zoomFactor) => {
        applyCameraFrame(cameraStateRef.current.presetKey, zoomFactor);
      },
      reset: () => {
        applyCameraFrame(DEFAULT_CAMERA_PRESET, 1);
      },
      rotateModel: (axis) => {
        if (!modelRef.current) return;
        const angle = Math.PI / 2; // 90 degrees
        switch (axis) {
          case "x":
            modelRef.current.rotateX(angle);
            break;
          case "y":
            modelRef.current.rotateY(angle);
            break;
          case "z":
            modelRef.current.rotateZ(angle);
            break;
          default:
            return;
        }
        modelRef.current.updateMatrixWorld(true);
        reframeModel();
      },
      captureScreenshot: () => {
        if (!rendererRef.current || !sceneRef.current || !cameraRef.current) return null;
        // Render a fresh frame and capture it (the drawing buffer is not preserved)
        renderView(cameraRef.current);
        return rendererRef.current.domElement.toDataURL("image/png");
      },
      captureScreenshotBlob: () => {
        if (!rendererRef.current || !sceneRef.current || !cameraRef.current) return Promise.resolve(null);
        renderView(cameraRef.current);
        return new Promise((resolve) => {
          rendererRef.current.domElement.toBlob((blob) => resolve(blob || null), "image/png");
        });
      },
      /** Captures a preset framing without moving the live camera. */
      captureFrame: ({ presetKey = null, zoomFactor = 1, thumbWidth = 0 } = {}) => {
        if (presetKey ? !renderPresetShot(presetKey, zoomFactor) : false) return null;
        if (!presetKey) restoreLiveFrame();
        const dataUrl = encodeCanvas(thumbWidth);
        if (presetKey) restoreLiveFrame();
        return dataUrl;
      },
      captureFrameBlob: ({ presetKey = null, zoomFactor = 1 } = {}) => {
        if (presetKey ? !renderPresetShot(presetKey, zoomFactor) : false) return Promise.resolve(null);
        if (!presetKey) restoreLiveFrame();
        // toBlob snapshots the drawing buffer when called, before the restore below.
        const pending = new Promise((resolve) => {
          renderer.domElement.toBlob((blob) => resolve(blob || null), "image/png");
        });
        if (presetKey) restoreLiveFrame();
        return pending;
      },
      /**
       * The model on screen: the path it was loaded from, an id that changes
       * with every load, and whether its own textures have settled.
       */
      getShownModel: () => {
        const object = modelRef.current;
        if (!object) return null;
        return {
          path: shownModelPathRef.current || "",
          id: object.uuid,
          settled: object.userData?.nativeMaterialsSettled === true,
        };
      },
      /** The live camera, so a Kit Shoot run keeps shooting from where it started. */
      getCameraSnapshot: () => ({
        position: camera.position.toArray(),
        target: controls.target.toArray(),
        up: camera.up.toArray(),
        fov: camera.fov,
        aspect: camera.aspect,
      }),
      /**
       * Kit Shoot framing bounds: the vehicle's framing box, and the union of
       * the loaded mod parts in `keys` (shown or hidden) and the stock meshes
       * on `bones`. Boxes are `{ min, max }` arrays; focus is null when none
       * of them is loaded.
       */
      measureVehicleMods: ({ keys = [], bones = [] } = {}) => {
        const model = modelRef.current;
        const vehicle = fitRef.current?.bounds;
        if (!model || !vehicle) return null;
        model.updateMatrixWorld(true);
        const state = vehicleModStates.get(model);
        const focus = new THREE.Box3();
        for (const key of keys) {
          const group = state?.groups.get(key);
          if (group) focus.expandByObject(group);
        }
        const boneSet = new Set(bones.map((bone) => String(bone).toLowerCase()));
        if (boneSet.size) {
          getVehicleRoot(model)?.traverse((child) => {
            if (!child.isMesh || isVehicleModMesh(child) || child.userData?.nativeLodActive === false) return;
            if (isHiddenByBones(child.userData?.nativeMaterial?.boneChain, boneSet)) focus.expandByObject(child);
          });
        }
        const toBox = (box) => ({ min: box.min.toArray(), max: box.max.toArray() });
        return { vehicle: toBox(vehicle), focus: focus.isEmpty() ? null : toBox(focus) };
      },
      /**
       * Renders the scene at exactly width x height into new 2D canvases, one
       * per `{ pose, crop }`. A pose is `{ type: "view", camera }` with a
       * getCameraSnapshot result (cropped to the output like EUP shots, or
       * widened to keep the whole view with `fit: "contain"`),
       * `{ type: "focus", box, direction, fov?, minDistance?, maxDistance? }`
       * to frame a box from a direction, or `{ type: "preset", presetKey,
       * zoomFactor? }` for a named camera shot of the model. `crop` (`{ x, y, width, height }` as
       * fractions of the frame, same aspect) renders that part of the frame at
       * full resolution. The drawing buffer is resized once for the batch and
       * restored before the browser paints, so the live view never shows it.
       */
      captureShots: ({ width, height, shots = [] }) => {
        if (!fitRef.current?.bounds || !(width > 0) || !(height > 0)) return shots.map(() => null);
        const outAspect = width / height;
        const shotCamera = ({ pose, crop }) => {
          const shot = camera.clone();
          shot.aspect = outAspect;
          if (pose?.type === "view" && pose.camera) {
            const snapshot = pose.camera;
            shot.position.fromArray(snapshot.position);
            shot.up.fromArray(snapshot.up);
            shot.fov = (pose.fit === "contain" ? containFov : shotFov)(snapshot.fov, snapshot.aspect, outAspect);
            shot.lookAt(new THREE.Vector3().fromArray(snapshot.target));
          } else if (pose?.type === "focus" && pose.box && pose.direction) {
            const direction = new THREE.Vector3().fromArray(pose.direction).normalize();
            const fov = Number.isFinite(pose.fov) ? pose.fov : camera.fov;
            const framing = buildCameraFraming({
              bounds: new THREE.Box3(new THREE.Vector3().fromArray(pose.box.min), new THREE.Vector3().fromArray(pose.box.max)),
              aspect: outAspect,
              fov,
              direction,
              minDistance: pose.minDistance,
            });
            const distance = Number.isFinite(pose.maxDistance) ? Math.min(framing.distance, pose.maxDistance) : framing.distance;
            shot.fov = fov;
            shot.position.copy(framing.target).addScaledVector(direction, distance);
            shot.up.copy(framing.up);
            shot.near = Math.min(framing.near, Math.max(0.01, distance * 0.05));
            shot.far = framing.far;
            shot.lookAt(framing.target);
          } else if (pose?.type === "preset") {
            const framing = buildCameraFraming({
              bounds: fitRef.current.bounds,
              aspect: outAspect,
              fov: camera.fov,
              presetKey: pose.presetKey,
              zoomFactor: pose.zoomFactor,
            });
            shot.fov = camera.fov;
            shot.position.copy(framing.position);
            shot.up.copy(framing.up);
            shot.near = framing.near;
            shot.far = framing.far;
            shot.lookAt(framing.target);
          } else {
            return null;
          }
          if (crop && crop.width > 0 && crop.height > 0 && (crop.width < 1 || crop.height < 1)) {
            const fullWidth = width / crop.width;
            const fullHeight = height / crop.height;
            shot.setViewOffset(fullWidth, fullHeight, crop.x * fullWidth, crop.y * fullHeight, width, height);
          }
          shot.updateProjectionMatrix();
          shot.updateMatrixWorld(true);
          return shot;
        };

        const previousRatio = renderer.getPixelRatio();
        const previousSize = renderer.getSize(new THREE.Vector2());
        try {
          renderer.setPixelRatio(1);
          renderer.setSize(width, height, false);
          stageRef.current?.resize();
          resizeBloomPipeline(bloomRef.current, width, height, 1);
          resizeAoPipeline(aoRef.current, width, height, 1);
          plateOverlayRef.current?.update();
          return shots.map((entry) => {
            const shot = shotCamera(entry);
            if (!shot) return null;
            if (entry.pose?.type === "preset" && turntableGroup.rotation.y !== 0) {
              withTurntableAtRest(turntableGroup, () => {
                syncWorldOverlays(shot);
                renderView(shot);
              });
              syncWorldOverlays(camera);
            } else {
              renderView(shot);
            }
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            canvas.getContext("2d").drawImage(renderer.domElement, 0, 0);
            return canvas;
          });
        } finally {
          renderer.setPixelRatio(previousRatio);
          renderer.setSize(previousSize.x, previousSize.y, false);
          stageRef.current?.resize();
          const ratio = lastViewport.pixelRatio || previousRatio;
          resizeBloomPipeline(bloomRef.current, previousSize.x, previousSize.y, ratio);
          resizeAoPipeline(aoRef.current, previousSize.x, previousSize.y, ratio);
          renderView(camera);
        }
      },
      setCompositeTexture: (source) => applyCompositeTexture(source || null),
      getPresetKeys: () => CAMERA_PRESET_KEYS,
    });

    return () => {
      if (frameId) cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      stopViewerControls();
      renderer.domElement.removeEventListener("pointerdown", handleTemplatePickPointerDown, true);
      renderer.domElement.removeEventListener("pointermove", handleTemplatePickPointerMove, true);
      renderer.domElement.removeEventListener("pointerup", handleTemplatePickPointerUp, true);
      renderer.domElement.removeEventListener("pointerleave", handleTemplatePickPointerCancel, true);
      renderer.domElement.removeEventListener("pointercancel", handleTemplatePickPointerCancel, true);
      renderer.domElement.removeEventListener("pointerdown", handlePartPointerDown, true);
      renderer.domElement.removeEventListener("pointermove", handlePartPointerMove, true);
      renderer.domElement.removeEventListener("pointerup", handlePartPointerUp, true);
      renderer.domElement.removeEventListener("pointerleave", handlePartPointerCancel, true);
      renderer.domElement.removeEventListener("pointercancel", handlePartPointerCancel, true);
      if (hoverFrame) cancelAnimationFrame(hoverFrame);
      restoreVehicleDragControls();
      vehicleRigRef.current = null;
      clearTemplatePickHover();
      controls.removeEventListener("start", requestRenderFrame);
      controls.removeEventListener("change", requestRenderFrame);
      controls.removeEventListener("end", requestRenderFrame);
      lightRigRef.current?.dispose();
      lightRigRef.current = null;
      plateOverlayRef.current?.dispose();
      plateOverlayRef.current = null;
      disposeBloomPipeline(bloomRef.current);
      bloomRef.current = null;
      disposeAoPipeline(aoRef.current);
      aoRef.current = null;
      solidWireRef.current.material?.dispose();
      solidWireRef.current.material = null;
      collisionRef.current.overlay?.dispose();
      collisionRef.current.overlay = null;
      collisionRef.current.hidden = [];
      collisionRef.current.key = "";
      collisionRef.current.request += 1;
      stageRef.current?.dispose();
      stageRef.current = null;
      turntableRef.current = null;
      // Proxies share the model's geometry; they go before it is disposed.
      partSwapRef.current?.dispose();
      partSwapRef.current = null;
      if (scene.background === backgroundTextureRef.current) {
        scene.background = null;
      }
      if (modelRef.current) {
        disposeObject(modelRef.current);
        modelRef.current = null;
      }
      disposeTexture(backgroundTextureRef.current);
      backgroundTextureRef.current = null;
      if (compositeTextureRef.current) {
        if (textureRef.current === compositeTextureRef.current) textureRef.current = null;
        compositeTextureRef.current.dispose();
        compositeTextureRef.current = null;
      }
      releaseTexture(textureRef.current);
      textureRef.current = null;
      releaseTexture(windowTextureRef.current);
      windowTextureRef.current = null;
      releaseTexture(materialTextureRef.current);
      materialTextureRef.current = null;
      controls.dispose();
      renderer.dispose();
      // dispose() frees three's bookkeeping; the context itself only goes away
      // once the browser collects it, so drop it explicitly.
      renderer.forceContextLoss();
      renderer.domElement.removeEventListener("wheel", wheelWhileDragging);
      renderer.domElement.remove();
      setSceneReady(false);
      requestRenderRef.current = null;
    };
  }, []);

  useEffect(() => {
    const { ambient, key, rim } = lightsRef.current;
    const showroom = stage === "showroom";
    // The night light preview drops the studio lights so emissives and siren
    // spill read the way they do after dark.
    const night = nightLights ? NIGHT_LIGHT_SCALE : 1;
    if (ambient) ambient.intensity = (showroom ? 0.06 : 0.5) * lightIntensity * night;
    if (key) key.intensity = (showroom ? 0.3 : 0.9) * lightIntensity * night;
    if (rim) rim.intensity = (showroom ? 0.55 : 0.35) * lightIntensity * night;
    stageRef.current?.setNight?.(night);
    requestRenderRef.current?.();
  }, [lightIntensity, stage, nightLights]);

  useEffect(() => {
    if (!sceneReady) return;
    let rig = lightRigRef.current;
    if (rig && rig.model !== modelRef.current) {
      rig.dispose();
      rig = lightRigRef.current = null;
    }
    const lights = vehicleLights || null;
    // Built for any model with lights: steady-burn extras can light with every switch off.
    if (!rig && modelRef.current && sceneRef.current) {
      rig = lightRigRef.current = createEmergencyLightRig({ scene: sceneRef.current, model: modelRef.current });
    }
    rig?.setState(lights || {});
    requestRenderRef.current?.();
  }, [vehicleLights, modelVersion, sceneReady]);

  // Extras follow the vehicle state plan (spawn with none on); manual toggles are
  // already folded into the plan by the host.
  // An extra switched by hand drops off or bolts on. Extras the vehicle state
  // switches (park and drive patterns, sirens, brakes, ULC buttons) are lights
  // being switched, so they change at once as in game, as do the extras a
  // model starts with and Kit Shoot's captures.
  const extrasKey = Array.isArray(extrasPlan?.on) ? extrasPlan.on.join(",") : null;
  const extrasManualKey = Array.isArray(extrasPlan?.manual) ? extrasPlan.manual.join(",") : "";
  useEffect(() => {
    const model = modelRef.current;
    if (!sceneReady || extrasKey == null || !model) return;
    const on = new Set(extrasKey ? extrasKey.split(",").map(Number) : []);
    const manual = new Set(extrasManualKey ? extrasManualKey.split(",").map(Number) : []);
    const leaving = new Map();
    const arriving = new Map();
    const changes = [];
    model.traverse((child) => {
      if (!child.isMesh || !Number.isInteger(child.userData?.extraIndex)) return;
      const visible = on.has(child.userData.extraIndex);
      if (child.userData.metaExtraVisible === visible) return;
      changes.push([child, visible]);
      if (!manual.has(child.userData.extraIndex)) return;
      const parts = visible ? arriving : leaving;
      parts.set(child.userData.extraIndex, [...(parts.get(child.userData.extraIndex) || []), child]);
    });
    if (!changes.length) return;
    let settledAt = extrasSettledAt.get(model);
    if (settledAt == null) extrasSettledAt.set(model, settledAt = performance.now() + EXTRAS_SETTLE_MS);
    const swaps = partSwapRef.current;
    const root = getVehicleRoot(model);
    const animate = Boolean(swaps && root) && performance.now() > settledAt
      && vehicleModsRef.current?.requestId == null && !prefersReducedMotion();
    // Exits read the meshes' visibility, so they start before it changes.
    if (animate) for (const meshes of leaving.values()) swaps.exit(meshes, { anchor: root });
    for (const [child, visible] of changes) {
      child.userData.metaExtraVisible = visible;
      child.visible = visible && child.userData.nativeLodActive !== false && child.userData.modHidden !== true;
    }
    if (animate) {
      [...arriving.values()].forEach((meshes, index) => swaps.enter(meshes, { anchor: root, delay: enterDelay(index, { handoff: leaving.size > 0 }) }));
    }
    requestRenderRef.current?.();
  }, [extrasKey, extrasManualKey, modelVersion, sceneReady]);

  // License plate: the game's plate style and text, composed from the game files
  // (or over the user's own plate image) and drawn over the model's
  // vehicle_licenseplate meshes.
  const plateStyle = licensePlate?.style;
  const plateText = licensePlate?.text;
  const plateImagePath = licensePlate?.image?.path || "";
  const plateImageStamp = licensePlate?.image?.stamp ?? 0;
  useEffect(() => {
    if (!sceneReady) return undefined;
    let overlay = plateOverlayRef.current;
    if (overlay && overlay.model !== modelRef.current) {
      overlay.dispose();
      overlay = plateOverlayRef.current = null;
    }
    if (!overlay && modelRef.current && sceneRef.current) {
      overlay = plateOverlayRef.current = createPlateOverlay({ scene: sceneRef.current, model: modelRef.current });
    }
    if (!overlay) return undefined;
    if (plateStyle == null || !isTauriRuntimeAvailable()) {
      overlay.setImage(null);
      requestRenderRef.current?.();
      return undefined;
    }
    let cancelled = false;
    const image = plateImagePath ? { path: plateImagePath, stamp: plateImageStamp } : null;
    buildPlateImage({ style: plateStyle, text: plateText, image }, { invoke, readFile })
      .then((image) => {
        if (cancelled || plateOverlayRef.current !== overlay) return;
        overlay.setImage(image);
        onLicensePlateStatusRef.current?.({ ok: true });
        requestRenderRef.current?.();
      })
      .catch((error) => {
        if (cancelled) return;
        onLicensePlateStatusRef.current?.({ ok: false, error: String(error?.message || error) });
      });
    return () => {
      cancelled = true;
    };
  }, [plateStyle, plateText, plateImagePath, plateImageStamp, modelVersion, sceneReady]);

  useEffect(() => {
    const { key } = lightsRef.current;
    if (!key) return;
    const aziRad = (lightAzimuth * Math.PI) / 180;
    const elevRad = (lightElevation * Math.PI) / 180;
    const r = 8;
    key.position.set(
      r * Math.cos(elevRad) * Math.sin(aziRad),
      r * Math.sin(elevRad),
      r * Math.cos(elevRad) * Math.cos(aziRad),
    );
    requestRenderRef.current?.();
  }, [lightAzimuth, lightElevation]);

  useEffect(() => {
    const stageApi = stageRef.current;
    const { key } = lightsRef.current;
    if (!stageApi || !key) return;

    stageModeRef.current = stage;
    configureShadowLight(key, shadowsEnabled && stage !== "showroom");
    stageApi.setMode(stage);
    stageApi.setShadows(shadowsEnabled);

    if (modelRef.current) {
      applyShadowFlags(modelRef.current, stageApi.castsShadows);
    }

    requestRenderRef.current?.();
  }, [shadowsEnabled, stage]);

  useEffect(() => {
    stageRef.current?.setShowroom({ spot: stageSpot, reflect: stageReflect, beam: stageBeam, light: stageLight, floor: stageFloor, rim: stageRim });
    requestRenderRef.current?.();
  }, [stageSpot, stageReflect, stageBeam, stageLight, stageFloor, stageRim]);

  useEffect(() => {
    if (!modelRef.current) return;
    const factor = 2 - 2 * glossiness;
    const meshes = getMeshList(modelRef.current);

    for (const child of meshes) {
      if (!child.material) continue;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        if (!material) continue;
        if (child.userData?.appliedMaterial && material === child.userData.appliedMaterial) continue;
        const base = material.userData?.baseRoughness;
        if (typeof base === "number") {
          material.roughness = Math.min(1.0, Math.max(0.0, base * factor));
        }
      }
    }
    requestRenderRef.current?.();
  }, [glossiness]);

  useEffect(() => {
    if (!sceneReady) return;
    if (!wasdEnabled) return;
    if (!cameraRef.current || !controlsRef.current) return;
    return setupWasdControls({
      wasdStateRef,
      wasdFrameRef,
      cameraRef,
      controlsRef,
      fitRef,
      requestRenderRef,
      domElement: rendererRef.current?.domElement,
      isActiveRef,
    });
  }, [sceneReady, wasdEnabled]);

  useEffect(() => {
    if (!rendererRef.current) return;
    rendererRef.current.setClearColor(new THREE.Color(nightLights ? NIGHT_BACKGROUND : backgroundColor || "#141414"), 1);
    stageRef.current?.setBackgroundColor(nightLights ? NIGHT_BACKGROUND : backgroundColor);
    requestRender();
  }, [backgroundColor, nightLights]);

  useEffect(() => {
    if (!sceneRef.current || !rendererRef.current) return;
    let cancelled = false;

    const clearBackground = () => {
      if (stageRef.current) stageRef.current.setUserBackground(null);
      else if (sceneRef.current?.background === backgroundTextureRef.current) {
        sceneRef.current.background = null;
      }
      disposeTexture(backgroundTextureRef.current);
      backgroundTextureRef.current = null;
      requestRender();
    };

    if (!backgroundImagePath) {
      clearBackground();
      return;
    }

    const loadBackground = async () => {
      let texture = null;
      let failure = null;
      try {
        texture = await loadTextureFromPathShared(backgroundImagePath, textureLoader, rendererRef.current);
      } catch (error) {
        failure = error;
      }
      // A newer background (or none) has taken over: leave its texture alone.
      if (cancelled) {
        disposeTexture(texture);
        return;
      }
      if (!texture) {
        clearBackground();
        const name = backgroundImagePath.split(/[\\/]/).pop();
        onAssetErrorRef.current?.(
          failure?.type === "unsupported-bit-depth"
            ? `Background image ${name} is ${failure.bitDepth}-bit, which isn't supported. Save it as 8-bit.`
            : `Background image ${name} couldn't be read.${failure?.message ? ` ${failure.message}` : ""}`,
        );
        return;
      }

      const previous = backgroundTextureRef.current;
      texture.mapping = THREE.UVMapping;

      // Apply blur via offscreen canvas if requested
      let finalTexture = texture;
      if (backgroundImageBlur > 0) {
        const img = texture.image;
        const isBlurrable = img && (
          img instanceof HTMLImageElement ||
          img instanceof HTMLCanvasElement ||
          img instanceof ImageBitmap
        );
        if (isBlurrable) {
          const w = img.naturalWidth || img.width || img.videoWidth || 512;
          const h = img.naturalHeight || img.height || img.videoHeight || 512;
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          const pad = backgroundImageBlur * 2;
          ctx.filter = `blur(${backgroundImageBlur}px)`;
          ctx.drawImage(img, -pad, -pad, w + pad * 2, h + pad * 2);
          const blurredTexture = new THREE.CanvasTexture(canvas);
          blurredTexture.colorSpace = THREE.SRGBColorSpace;
          blurredTexture.wrapS = THREE.RepeatWrapping;
          blurredTexture.wrapT = THREE.RepeatWrapping;
          // An ImageBitmap source is already upside down (loadBlobTexture), and
          // the canvas copies it as it is.
          blurredTexture.flipY = !texture.userData?.flipBaked;
          disposeTexture(texture);
          finalTexture = blurredTexture;
        }
      }

      backgroundTextureRef.current = finalTexture;
      if (stageRef.current) stageRef.current.setUserBackground(finalTexture);
      else sceneRef.current.background = finalTexture;
      if (previous && previous !== finalTexture) {
        disposeTexture(previous);
      }
      requestRender();
    };

    loadBackground();

    return () => {
      cancelled = true;
    };
  }, [backgroundImagePath, backgroundImageReloadToken, backgroundImageBlur, textureLoader, requestRender]);

  useEffect(() => {
    if (!sceneReady || !stageRef.current) return;
    stageRef.current.setGrid(showGrid);
    requestRender();
  }, [showGrid, sceneReady, requestRender]);

  useEffect(() => {
    if (!sceneReady || !sceneRef.current) return;

    if (!modelPath) {
      shownModelPathRef.current = "";
      if (modelRef.current) {
        partSwapRef.current?.clear();
        modelRef.current.removeFromParent();
        disposeObject(modelRef.current);
        modelRef.current = null;
        onPaintSlotsChangeRef.current?.(null);
      }
      if (vehicleRigRef.current) {
        vehicleRigRef.current = null;
        emitVehicleParts();
      }
      onModelInfoRef.current?.({
        targets: [],
        liveryTarget: "",
        liveryLabel: "",
        windowTarget: "",
        windowLabel: "",
        templateMap: null,
        templateMapError: "",
        templatePsdSource: null,
        templatePsdSourceError: "",
        templateSets: [],
        templateSetWarning: "",
      });
      onModelLoadingRef.current?.(false);
      fitRef.current = {
        ...fitRef.current,
        bounds: null,
      };
      setModelVersion((version) => version + 1);
      onNativeMaterialsStatusRef.current?.({ state: "idle", available: false });
      requestRender();
      return;
    }

    let cancelled = false;
    // Aborted with the load: a bridge parse nobody else waits for is then
    // cancelled (see requestBridgeParse), never one that already finished.
    const bridgeLoad = new AbortController();

    const loadModel = async () => {
      onModelLoadingRef.current?.(true);
      // A replaced or unmounted load reports nothing and never reaches the
      // scene: errors go through fail(), awaits are followed by a cancelled
      // check, and an object that was not committed is disposed in finally.
      const fail = (message) => {
        if (!cancelled) onModelErrorRef.current?.(message);
      };
      let object = null;
      let committed = false;
      let templateSourceObject = null;
      let templateSourceIsCached = false;
      let nativeMaterialSummary = { available: false };
      let bridgeWarnings = [];
      try {
        const extension = getFileExtension(modelPath);
        const shouldPreferBridgeYft = extension === "yft" && isTauriRuntime && !includeTemplateGeometry;
        const shouldBypassTemplateCache =
          includeTemplateGeometry && (extension === "yft" || extension === "ydd");
        // Cached parses are keyed on the file's mtime and size, so a model
        // saved again is parsed again. Without them nothing is cached.
        const fileInfo = isTauriRuntime ? await stat(modelPath).catch(() => null) : null;
        if (cancelled) return;
        const fileKey = getModelCacheKey(modelPath, fileInfo);
        // The bridge is asked on every open: it reuses its parse while the model
        // and every .ytd and meta file that parse read are unchanged (cheap), and
        // parses again otherwise. A model built from a parse is cached per parse,
        // never per .yft alone, so an edited texture dictionary always shows.
        let bridgeResult = null;
        let bridgeManifestInfo = null;
        if (shouldPreferBridgeYft) {
          try {
            bridgeResult = await requestBridgeParse(invoke, modelPath, { signal: bridgeLoad.signal });
            const manifestPath = typeof bridgeResult?.manifestPath === "string" ? bridgeResult.manifestPath.trim() : "";
            bridgeManifestInfo = manifestPath ? await stat(manifestPath).catch(() => null) : null;
          } catch (error) {
            // A replaced load's parse was stopped on purpose: not an error.
            if (cancelled) return;
            if (!isBridgeCancelled(error)) console.warn("[YFT] Bridge load failed, falling back to JS parser:", error);
          }
          if (cancelled) return;
        }
        // The bridge parse carries game materials, lights and the skeleton; a
        // JS parse of the same file does not, so they are cached apart.
        let modelCacheKey = getLoadedModelCacheKey(modelPath, fileInfo, { bridgeResult, manifestInfo: bridgeManifestInfo });
        let bridgeIdentity = bridgeResult ? getBridgeParseIdentity(bridgeResult, bridgeManifestInfo) : null;
        const cachedEntry = shouldBypassTemplateCache || !modelCacheKey ? null : getCachedModelTemplate(modelCacheKey);
        let shouldCacheModelTemplate = !shouldBypassTemplateCache;
        if (cachedEntry?.template) {
          object = cloneCachedModelTemplate(cachedEntry.template);
          if (cachedEntry.nativeMaterialSummary) {
            nativeMaterialSummary = cachedEntry.nativeMaterialSummary;
          }
          if (cachedEntry.bridgeWarnings) bridgeWarnings = cachedEntry.bridgeWarnings;
        }

        if (!object) {
          if (extension === "obj") {
            fail(
              "out of sheer respect for vehicle devs and those who pour their hearts and souls into their creations, .OBJ files will never be supported.",
            );
            return;
          }

          if (extension === "yft") {
            if (shouldPreferBridgeYft && bridgeResult) {
              try {
                bridgeWarnings = readBridgeWarnings(bridgeResult);

                const meshPath = typeof bridgeResult?.meshPath === "string" ? bridgeResult.meshPath.trim() : "";
                const manifestPath = typeof bridgeResult?.manifestPath === "string" ? bridgeResult.manifestPath.trim() : "";
                if (meshPath) {
                  let meshBytes = null;
                  try {
                    meshBytes = await readFile(meshPath);
                  } catch {
                    meshBytes = null;
                  }
                  if (cancelled) return;

                  if (meshBytes) {
                    let bridgeMeshes = parseClmesh(meshBytes);
                    let parentTextures = null;
                    let lightBones = [];
                    let skeleton = null;
                    if (manifestPath) {
                      try {
                        const manifest = await readJsonFile(manifestPath);
                        if (cancelled) return;
                        bridgeMeshes = applyNativeManifestToMeshes(bridgeMeshes, manifest, manifestPath);
                        nativeMaterialSummary = summarizeNativeMaterialMeshes(bridgeMeshes);
                        parentTextures = summarizeParentTextures(manifest, manifestPath);
                        lightBones = normalizeManifestLightBones(manifest);
                        skeleton = normalizeManifestSkeleton(manifest);
                      } catch (error) {
                        console.warn("[YFT] Failed to read bridge manifest:", error);
                      }
                    }

                    if (bridgeMeshes?.length) {
                      object = buildClmeshObject(bridgeMeshes);
                      object.userData.sourceFormat = "yft";
                      // Mod kit parts resolve textures from this vehicle's dictionary chain.
                      object.userData.parentTextures = parentTextures;
                      // Siren and lamp bone pivots for the vehicle light preview.
                      object.userData.lightBones = lightBones;
                      // Bind pose and joint limits for opening doors and roofs.
                      object.userData.vehicleSkeleton = skeleton;
                      if (!hasRenderableMeshes(object)) {
                        disposeObject(object);
                        object = null;
                      }
                    }
                  }
                }
              } catch (error) {
                // A replaced load's parse was stopped on purpose: not an error.
                if (cancelled) return;
                if (!isBridgeCancelled(error)) console.warn("[YFT] Bridge load failed, falling back to JS parser:", error);
              }
            }

            if (!object) {
              // The bridge's warnings describe a model that is not shown.
              bridgeWarnings = [];
              // A JS parse is cached with this file's other JS parses.
              modelCacheKey = getLoadedModelCacheKey(modelPath, fileInfo);
              bridgeIdentity = null;
              let bytes = null;
              try {
                bytes = await readFile(modelPath);
              } catch {
                fail("Failed to read YFT file.");
                return;
              }
              if (cancelled) return;
              const name = getFileNameWithoutExtension(modelPath) || "yft_model";
              let drawable = null;
              try {
                drawable = await parseYftAsync(bytes, name);
              } catch (err) {
                if (cancelled) return;
                console.error("[YFT] Parse error:", err);
                fail("YFT parsing failed.");
                return;
              }
              if (cancelled) return;
              if (!drawable || !drawable.models?.length) {
                fail("YFT parsing returned no drawable data.");
                return;
              }

              object = buildDrawableObject(drawable, { useVertexColors: false });
              if (!hasRenderableMeshes(object)) {
                fail("YFT parsed but no mesh data was generated.");
                return;
              }
              shouldCacheModelTemplate = true;
            }
            object.userData.sourceFormat = "yft";
            // The livery template map only needs mesh/material names, which the
            // bridge object already carries; the JS parser is no longer re-run
            // here. Template geometry (includeTemplateGeometry) takes the JS
            // path for `object` itself, so no second parse exists on that path.

          } else if (extension === "ydd") {
            let bytes = null;
            try {
              bytes = await readFile(modelPath);
            } catch {
              fail("Failed to read YDD file.");
              return;
            }
            if (cancelled) return;
            const name = getFileNameWithoutExtension(modelPath) || "ydd_model";
            let drawable = null;
            try {
              drawable = await parseYftAsync(bytes, name, YDD_SCAN_SETTINGS);
            } catch (err) {
              if (cancelled) return;
              console.error("[YDD] Parse error:", err);
              fail("YDD parsing failed.");
              return;
            }
            if (cancelled) return;
            if (!drawable || !drawable.models?.length) {
              fail("YDD parsing returned no drawable data.");
              return;
            }
            object = buildDrawableObject(drawable, { useVertexColors: false });
            if (!hasRenderableMeshes(object)) {
              fail("YDD parsed but no mesh data was generated.");
              return;
            }
            object.userData.sourceFormat = "ydd";

            if (includeTemplateGeometry) {
              // Full-dictionary template source is read-only input for the
              // template generator; keep it per file version so re-opening the
              // same YDD in another tab does not re-parse it.
              const templateCacheKey = getModelCacheKey(modelPath, fileInfo, "template");
              const cachedTemplateSource = templateCacheKey ? getCachedModelTemplate(templateCacheKey)?.template || null : null;
              if (cachedTemplateSource) {
                templateSourceObject = cachedTemplateSource;
                templateSourceIsCached = true;
              } else {
                try {
                  const templateDrawable = await parseYftAsync(bytes, name, {
                    ...YDD_SCAN_SETTINGS,
                    includeAllDrawables: true,
                  });
                  if (cancelled) return;
                  if (templateDrawable?.models?.length) {
                    templateSourceObject = buildDrawableObject(templateDrawable, { useVertexColors: false });
                    templateSourceObject.userData.sourceFormat = "ydd";
                    if (templateCacheKey) {
                      cacheModelTemplate(templateCacheKey, templateSourceObject, { sourcePath: modelPath, fileKey });
                      templateSourceIsCached = true;
                    }
                  }
                } catch (error) {
                  if (cancelled) return;
                  console.warn("[YDD] Full dictionary template source failed:", error);
                }
              }
            }
          } else if (extension === "clmesh") {
            let bytes = null;
            try {
              bytes = await readFile(modelPath);
            } catch {
              fail("Failed to read mesh cache.");
              return;
            }
            if (cancelled) return;
            const meshes = parseClmesh(bytes);
            if (!meshes || meshes.length === 0) {
              fail("Mesh cache contained no meshes.");
              return;
            }
            object = buildClmeshObject(meshes);
          } else if (extension === "dff") {
            const fileName = modelPath.split(/[\\/]/).pop();
            let bytes = null;
            try {
              bytes = await readFile(modelPath);
            } catch (error) {
              fail(`Failed to read ${fileName}: ${error?.message || error}`);
              return;
            }
            if (cancelled) return;
            const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            const loader = new DFFLoader();
            try {
              object = loader.parse(buffer);
            } catch (error) {
              console.error("[DFF] Parse error:", error);
              fail(`DFF parsing failed for ${fileName}.`);
              return;
            }
          } else {
            fail("Unsupported model format.");
            return;
          }

          if (!object) {
            fail("Model loaded with no geometry.");
            return;
          }

          normalizeLoadedMeshes(object);
          if (shouldCacheModelTemplate && modelCacheKey) {
            const modelTemplate = cloneCachedModelTemplate(object, { cloneGeometry: false });
            if (modelTemplate) {
              cacheModelTemplate(modelCacheKey, modelTemplate, { nativeMaterialSummary, bridgeWarnings, sourcePath: modelPath, fileKey, bridgeIdentity });
            }
          }
        }

        // Everything from here to the swap into modelRef is synchronous, so
        // this is the last point a newer load can have replaced this one.
        if (cancelled) return;

        const glossFactor = 2 - 2 * glossiness;
        const meshes = getMeshList(object);
        for (const child of meshes) {
          if (!child.material) continue;
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          for (const material of materials) {
            if (!material) continue;
            const base = material.userData?.baseRoughness;
            if (typeof base === "number") {
              material.roughness = Math.min(1.0, Math.max(0.0, base * glossFactor));
            }
          }
        }

        const targets = collectTextureTargets(object);
        const liveryTarget = findLiveryTarget(object);
        const windowTarget = findWindowTemplateTarget(object);
        let templateMap = null;
        let templateMapError = "";
        let templatePsdSource = null;
        let templatePsdSourceError = "";
        let templateSets = [];
        let windowTemplateSets = [];
        let windowTemplateError = "";
        let templateSetWarning = "";
        const templateObject = templateSourceObject || object;
        const sourceFormat = templateObject?.userData?.sourceFormat || "";

        if (sourceFormat === "yft" || sourceFormat === "ydd") {
          const templatePolicy = getTemplateModelPolicy(sourceFormat);
          try {
            if (includeTemplateGeometry) {
              const generation = buildModelTemplateSets({
                object: templateObject,
                modelPath,
                fileType: sourceFormat,
                preferUv2: templatePolicy.preferUv2,
                liveryTarget: liveryTarget?.value || "",
                windowTarget: windowTarget?.value || "",
                preferredDrawableKey: object?.userData?.selectedDrawableKey || "",
              });
              templateSets = generation.sets;
              templateMap = templateSets[0]?.templateMap || null;
              templatePsdSource = templateSets[0]?.templatePsdSource || null;
              if (generation.skipped.length > 0) {
                templateSetWarning = `${generation.skipped.length} drawable${generation.skipped.length === 1 ? " was" : "s were"} skipped because no renderable UV geometry was found.`;
              }
            } else {
              templateMap = buildModelTemplateMap({
                object: templateObject,
                modelPath,
                fileType: sourceFormat,
                liveryTarget: liveryTarget?.value || "",
                windowTarget: windowTarget?.value || "",
              });
            }
          } catch (error) {
            templateMapError = "Failed to generate template map.";
            console.error("[TemplateMap] Generation failed:", error);
          }

          if (includeTemplateGeometry && sourceFormat === "yft") {
            try {
              const windowGeneration = buildModelTemplateSets({
                object: templateObject,
                modelPath,
                fileType: sourceFormat,
                preferUv2: false,
                liveryTarget: liveryTarget?.value || "",
                windowTarget: windowTarget?.value || "",
                preferredDrawableKey: object?.userData?.selectedDrawableKey || "",
              });
              windowTemplateSets = windowGeneration.sets;
              if (windowGeneration.skipped.length > 0 && !windowTemplateSets.length) {
                windowTemplateError = "No window-ready UV geometry was found in this model.";
              }
            } catch (error) {
              windowTemplateError = "Failed to prepare window template geometry.";
              console.error("[TemplateMap] Window geometry generation failed:", error);
            }
          }

          if (includeTemplateGeometry && !templatePsdSource && !templateMapError) {
            templatePsdSourceError = "Failed to generate UV template source.";
          }
        }

        const vehicleRig = createVehicleRig({
          skeleton: object.userData?.vehicleSkeleton || null,
          meshes: getMeshList(object),
        });

        onModelInfoRef.current?.({
          targets,
          extras: getModelExtras(object),
          // The model can pose doors and play a convertible roof clip.
          vehiclePosable: Boolean(vehicleRig),
          steerableWheels: getSteerableWheelMeshes(object).some((mesh) => mesh.userData.nativeMaterial.part === "wheel"),
          lights: summarizeModelLights(object),
          licensePlates: findPlateMeshes(object).length,
          liveryTexturePrefix: findLiveryTexturePrefix(getMeshList(object).map((mesh) => mesh.userData?.textureRefs)),
          liveryTarget: liveryTarget?.value || "",
          liveryLabel: liveryTarget?.label || "",
          windowTarget: windowTarget?.value || "",
          windowLabel: windowTarget?.label || "",
          templateMap,
          templateMapError,
          templatePsdSource,
          templatePsdSourceError,
          templateSets,
          windowTemplateSets,
          windowTemplateError,
          templateSetWarning,
          nativeMaterials: nativeMaterialSummary,
          // Non-fatal problems the CodeWalker bridge reported for this model.
          bridgeWarnings,
        });

        if (templateSourceObject && templateSourceObject !== object) {
          if (!templateSourceIsCached) disposeObject(templateSourceObject);
          templateSourceObject = null;
        }

        const box = new THREE.Box3().setFromObject(object);
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);

        if (object?.userData?.sourceFormat === "ydd") {
          // GTA drawables are Z-up; the .ydd parser keeps the file's axes. The
          // X turn is EUP Studio's conversion (clothing upright, facing +Z); the
          // half turn then faces it -Z like a vehicle, where this viewer's Front
          // shot and showroom light directions look from.
          object.rotateX(-Math.PI / 2);
          object.applyQuaternion(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
          object.updateMatrixWorld(true);
          box.setFromObject(object);
          box.getSize(size);
        }

        if (object?.userData?.sourceFormat === "yft") {
          const didFix = maybeAutoFixYftUpAxis(object, size);
          if (didFix) {
            box.setFromObject(object);
            box.getSize(size);
          }
        }

        const sceneObject = stabilizeObjectForWorld(object, {
          autoLevel: true,
          centerXZ: true,
          groundToZero: true,
        }) || object;
        const materialState = materialStateRef.current;
        sceneObject.userData = sceneObject.userData || {};
        sceneObject.userData.modelSpaceRoot = object;
        sceneObject.userData.materialConfig = materialState.materialConfig || DEFAULT_MATERIAL_CONFIG;
        sceneObject.userData.materialDetailTexture = materialTextureRef.current || null;
        sceneObject.userData.vehiclePaint = materialState.vehiclePaint || normalizeVehiclePaint(null, materialState.bodyColor);
        sceneObject.userData.nativeMaterialsEnabled = Boolean(materialState.nativeMaterialsEnabled);
        sceneObject.userData.sourceModelPath = modelPath;
        applyShadowFlags(sceneObject, stageRef.current?.castsShadows ?? shadowsEnabled);

        if (modelRef.current) {
          partSwapRef.current?.clear();
          disposeCageOverlay(sceneRef.current);
          modelRef.current.removeFromParent();
          disposeObject(modelRef.current);
        }

        modelRef.current = sceneObject;
        committed = true;
        const reloadedInPlace = shownModelPathRef.current === modelPath;
        shownModelPathRef.current = modelPath;
        vehicleRigRef.current = vehicleRig;
        emitVehicleParts();
        onPaintSlotsChangeRef.current?.(collectPaintSlots(sceneObject));
        (turntableRef.current || sceneRef.current).add(sceneObject);
        setModelVersion((version) => version + 1);

        // Framing is measured on the vehicle at rest, whatever the turntable's angle.
        const fitBox = withTurntableAtRest(turntableRef.current, () =>
          computeFramingBounds(sceneObject, new THREE.Box3().setFromObject(sceneObject))) || box.clone();
        fitBox.getSize(size);
        fitBox.getCenter(center);

        const isBoundsValid =
          Number.isFinite(size.x) &&
          Number.isFinite(size.y) &&
          Number.isFinite(size.z) &&
          Number.isFinite(center.x) &&
          Number.isFinite(center.y) &&
          Number.isFinite(center.z);
        if (!isBoundsValid) {
          fail("Parsed model bounds are invalid.");
          return;
        }
        const maxDim = Math.max(size.x, size.y, size.z);
        if (!Number.isFinite(maxDim) || maxDim <= 0) {
          fail("Parsed model geometry is empty.");
          return;
        }
        const currentPreset = cameraStateRef.current?.presetKey || DEFAULT_CAMERA_PRESET;
        const currentZoom = cameraStateRef.current?.zoomFactor || 1;

        fitRef.current = {
          bounds: fitBox.clone(),
          center: center.clone(),
          distance: 4,
          baseDistance: 4,
          presetKey: currentPreset,
          zoomFactor: currentZoom,
        };
        cameraStateRef.current = {
          presetKey: currentPreset,
          zoomFactor: currentZoom,
        };

        if (cameraRef.current && controlsRef.current) {
          const { clientWidth = 1, clientHeight = 1 } = containerRef.current || {};
          const framing = buildCameraFraming({
            bounds: fitBox,
            aspect: clientWidth / clientHeight,
            fov: cameraRef.current.fov,
            presetKey: currentPreset,
            zoomFactor: currentZoom,
          });
          fitRef.current = {
            ...fitRef.current,
            center: framing.target.clone(),
            distance: framing.distance,
            baseDistance: framing.baseDistance,
            presetKey: framing.presetKey,
            zoomFactor: currentZoom,
          };
          if (!reloadedInPlace) {
            syncViewerCameraPose({
              camera: cameraRef.current,
              controls: controlsRef.current,
              position: framing.position,
              target: framing.target,
              up: framing.up,
              near: framing.near,
              far: framing.far,
              minDistance: Math.max(framing.baseDistance * 0.05, 0.1),
              maxDistance: Math.max(framing.baseDistance * 4, 1),
            });
          }
        }

        applyMaterials(
          sceneObject,
          materialState.bodyColor,
          textureRef.current,
          materialState.textureTarget,
          windowTextureRef.current,
          materialState.windowTextureTarget,
          materialState.liveryExteriorOnly,
          materialState.textureMode,
          materialState.glossiness,
          materialState.showWireframe,
        );
        // Rebuild cage overlay if it was enabled
        if (materialStateRef.current.showCageWireframe) {
          attachCageOverlay(buildCageOverlay(sceneObject, sceneRef.current), turntableRef.current);
        }
        requestRender();
      } catch (error) {
        const message =
          error && typeof error === "object" && "message" in error
            ? `Model load failed: ${error.message}`
            : "Model load failed.";
        fail(message);
        console.error(error);
      } finally {
        if (templateSourceObject && templateSourceObject !== object && !templateSourceIsCached) {
          disposeObject(templateSourceObject);
        }
        // Built but never shown: cancelled, or failed before the swap.
        if (object && !committed) disposeObject(object);
        if (!cancelled) onModelLoadingRef.current?.(false);
      }
    };

    loadModel();

    return () => {
      cancelled = true;
      bridgeLoad.abort();
      onModelLoadingRef.current?.(false);
    };
  }, [modelPath, modelReloadToken, sceneReady, includeTemplateGeometry, isTauriRuntime, textureLoader]);

  useEffect(() => {
    const object = modelRef.current;
    if (!sceneReady || !object) return undefined;

    const enabled = Boolean(nativeMaterialsEnabled);
    object.userData = object.userData || {};
    object.userData.nativeMaterialsEnabled = enabled;
    object.userData.nativeMaterialsReady = false;
    // True once the model's own textures have loaded, failed or been turned
    // off, so a snapshot of the vehicle shows it as it will look.
    object.userData.nativeMaterialsSettled = false;

    const reapplyMaterials = () => {
      const state = materialStateRef.current;
      applyMaterials(
        object,
        state.bodyColor,
        textureRef.current,
        state.textureTarget,
        windowTextureRef.current,
        state.windowTextureTarget,
        state.liveryExteriorOnly,
        state.textureMode,
        state.glossiness,
        state.showWireframe,
      );
      requestRenderRef.current?.();
    };

    const nativeMeshes = getMeshList(object).filter((mesh) => mesh.userData?.nativeMaterial && !isVehicleModMesh(mesh));
    if (!enabled) {
      object.userData.nativeMaterialsSettled = true;
      onNativeMaterialsStatusRef.current?.({
        state: "disabled",
        available: nativeMeshes.length > 0,
        meshCount: nativeMeshes.length,
      });
      reapplyMaterials();
      return undefined;
    }

    if (object.userData?.sourceFormat !== "yft" || nativeMeshes.length === 0) {
      object.userData.nativeMaterialsSettled = true;
      onNativeMaterialsStatusRef.current?.({
        state: "unavailable",
        available: false,
        message: "Native materials require a CodeWalker-backed .yft model.",
      });
      reapplyMaterials();
      return undefined;
    }

    const controller = new AbortController();
    let resources = null;
    let cancelled = false;
    let lastReported = -1;

    const load = async () => {
      try {
        resources = await loadNativeMaterialView({
          object,
          renderer: rendererRef.current,
          signal: controller.signal,
          // Mod kit parts own their textures; see the vehicle mods effect.
          excludeMesh: isVehicleModMesh,
          onSetup: (status) => {
            if (cancelled) return;
            onNativeMaterialsStatusRef.current?.({ ...status, state: "loading", available: true });
            reapplyMaterials();
          },
          onProgress: (status) => {
            if (cancelled) return;
            const complete = status.loadedTextureCount + status.failedTextureCount;
            const reportEvery = Math.max(1, Math.ceil(status.plannedTextureCount / 20));
            if (complete !== status.plannedTextureCount && complete - lastReported < reportEvery) return;
            lastReported = complete;
            onNativeMaterialsStatusRef.current?.({ ...status, state: "loading", available: true });
          },
          onRender: () => requestRenderRef.current?.(),
        });
        if (cancelled) {
          resources.dispose();
          resources = null;
          return;
        }

        object.userData.nativeMaterialsReady = true;
        object.userData.nativeMaterialsSettled = true;
        setNativeReadyVersion((version) => version + 1);
        const status = resources.summary;
        onNativeMaterialsStatusRef.current?.({
          ...status,
          state:
            status.failedTextureCount > 0 ||
            status.missingBindingCount > 0 ||
            status.unsupportedBindingCount > 0
              ? "partial"
              : "ready",
          available: true,
        });
        reapplyMaterials();
      } catch (error) {
        if (cancelled || error?.name === "AbortError") return;
        object.userData.nativeMaterialsReady = false;
        object.userData.nativeMaterialsSettled = true;
        onNativeMaterialsStatusRef.current?.({
          state: "error",
          available: true,
          message: error?.message || "Native material loading failed.",
        });
        reapplyMaterials();
      }
    };

    load();

    return () => {
      cancelled = true;
      controller.abort();
      // The livery override's materials go with these resources.
      liveryStates.get(object)?.override.forget();
      resources?.dispose?.();
      object.userData.nativeMaterialsReady = false;
    };
  }, [modelVersion, nativeMaterialsEnabled, nativeMaterialsReloadToken, sceneReady]);

  // Shows the chosen game livery on the vehicle's own materials: a mod kit
  // livery wins over a texture livery, as in game. Needs the native materials
  // loaded; until then (or with them off) the model shows as modelled.
  const applyGameLivery = useCallback(() => {
    const model = modelRef.current;
    const root = getVehicleRoot(model);
    const state = model ? liveryStates.get(model) : null;
    if (!root || !state || !model.userData?.nativeMaterialsReady) return;
    const meshes = [];
    root.traverse((child) => {
      if (child.isMesh && !isVehicleModMesh(child)) meshes.push(child);
    });
    const mod = state.activeModPath ? state.mods.get(state.activeModPath)?.texture || null : null;
    const sign = state.signNumber != null ? state.signs.get(state.signNumber) || null : null;
    state.override.apply(meshes, { mod, sign });
    requestRenderRef.current?.();
  }, []);

  // The texture liveries (`<prefix>_sign_N`) the vehicle's dictionary chain
  // holds, reported once per model.
  useEffect(() => {
    const model = modelRef.current;
    const root = getVehicleRoot(model);
    if (!sceneReady || !root) {
      onGameLiveryStatusRef.current?.(null);
      return;
    }
    const meshes = [];
    root.traverse((child) => {
      if (child.isMesh && !isVehicleModMesh(child)) meshes.push(child);
    });
    const state = getLiveryState(model);
    state.path = model.userData?.sourceModelPath || "";
    state.list = listTextureLiveries(meshes, root.userData?.parentTextures || null);
    // The sign the paint samples, even with fewer than two liveries to switch.
    state.signPrefix = findLiverySignPrefix(meshes);
    state.error = "";
    onGameLiveryStatusRef.current?.(describeLiveryState(state));
  }, [modelVersion, sceneReady]);

  useEffect(() => {
    const model = modelRef.current;
    if (!sceneReady || !getVehicleRoot(model)) return;
    const state = getLiveryState(model);
    const number = Number.isInteger(gameLivery) && state.list?.paths.has(gameLivery) ? gameLivery : null;
    const request = ++state.signRequest;
    const settle = (error = "") => {
      state.signNumber = error ? null : number;
      state.error = error;
      applyGameLivery();
      onGameLiveryStatusRef.current?.(describeLiveryState(state));
    };
    if (number == null || state.signs.has(number)) {
      settle();
      return;
    }
    loadNativeTextureSource(state.list.paths.get(number), rendererRef.current).then((texture) => {
      if (liveryStates.get(model) !== state || state.signs.has(number)) texture.dispose();
      else state.signs.set(number, texture);
      if (request === state.signRequest) settle();
    }).catch((error) => {
      if (request === state.signRequest) settle(`Livery ${number} didn't load: ${error?.message || error}`);
    });
  }, [gameLivery, modelVersion, sceneReady, nativeReadyVersion, applyGameLivery]);

  // Mod kit parts attach under the vehicle's normalized root so they share its
  // orientation and offset; the bridge exports both in vehicle space. Each part
  // owns its native textures, so toggling a mod never reloads the vehicle's.
  useEffect(() => {
    const model = modelRef.current;
    const root = getVehicleRoot(model);
    const parts = Array.isArray(vehicleMods?.parts) ? vehicleMods.parts : [];
    const requestId = vehicleMods?.requestId ?? null;
    if (!sceneReady || !root) {
      onVehicleModsStatusRef.current?.({ requestId, settled: false, parts: {}, hiddenMeshCount: 0, boneDataAvailable: false, parentTexturesAvailable: false });
      return;
    }
    let state = vehicleModStates.get(model);
    if (!state) {
      // textureLoads: controllers of part texture loads still running before
      // the part is fitted, aborted when the model is replaced or unmounted.
      state = { groups: new Map(), loading: new Set(), failures: new Map(), textureLoads: new Set() };
      vehicleModStates.set(model, state);
    }

    const refresh = () => {
      if (model.userData) delete model.userData.meshList;
      const materialState = materialStateRef.current;
      applyMaterials(
        model,
        materialState.bodyColor,
        textureRef.current,
        materialState.textureTarget,
        windowTextureRef.current,
        materialState.windowTextureTarget,
        materialState.liveryExteriorOnly,
        materialState.textureMode,
        materialState.glossiness,
        materialState.showWireframe,
      );
      requestRenderRef.current?.();
    };
    const bump = () => {
      if (modelRef.current === model) setVehicleModsRevision((revision) => revision + 1);
    };

    // A livery mod's model is a placeholder; its texture is the livery.
    const liveryParts = parts.filter((part) => part.slotType === LIVERY_MOD_SLOT);
    const wanted = new Map(parts.filter((part) => part.slotType !== LIVERY_MOD_SLOT).map((part) => [part.key, part]));
    let changed = false;
    // Parts the user swaps drop off and bolt on. Parts already chosen when the
    // model loads, and Kit Shoot's captures, change at once.
    const swaps = partSwapRef.current;
    const animate = Boolean(swaps) && state.primed && requestId == null && !prefersReducedMotion();
    let exits = 0;
    for (const [key, group] of state.groups) {
      if (wanted.has(key)) continue;
      state.groups.delete(key);
      changed = true;
      if (animate && group.visible) {
        // Disposed once it has fallen away; out of the model meanwhile.
        swaps.exit(group, { anchor: root, onDone: () => detachVehicleModGroup(group) });
        group.parent?.remove(group);
        exits += 1;
      } else detachVehicleModGroup(group);
      // After the exit has captured where the part sits on an open door.
      vehicleRigRef.current?.detach(group);
    }
    for (const key of [...state.failures.keys()]) {
      if (!wanted.has(key)) state.failures.delete(key);
    }

    const hiddenBones = new Set((vehicleMods?.hiddenBones || []).map((bone) => String(bone).toLowerCase()));
    let hiddenMeshCount = 0;
    let boneDataAvailable = false;
    const stockHidden = [];
    const stockShown = [];
    root.traverse((child) => {
      if (!child.isMesh || isVehicleModMesh(child)) return;
      const chain = child.userData?.nativeMaterial?.boneChain;
      if (Array.isArray(chain)) boneDataAvailable = true;
      const hidden = isHiddenByBones(chain, hiddenBones);
      if (hidden && child.userData?.nativeLodActive !== false) hiddenMeshCount += 1;
      if ((child.userData.modHidden === true) !== hidden) (hidden ? stockHidden : stockShown).push(child);
    });
    // The stock part a mod replaces falls away as one piece (its meshes are
    // still visible here; refresh() hides them) and comes back the same way.
    if (animate && stockHidden.length && swaps.exit(stockHidden, { anchor: root })) exits += 1;
    for (const child of stockHidden) child.userData.modHidden = true;
    for (const child of stockShown) child.userData.modHidden = false;
    if (stockHidden.length || stockShown.length) changed = true;
    if (animate && stockShown.length) swaps.enter(stockShown, { anchor: root, delay: enterDelay(0, { handoff: exits > 0 }) });

    // Kit Shoot keeps a slot's parts loaded and shows one at a time; showing
    // or hiding a loaded part needs a render, not a material pass.
    for (const [key, group] of state.groups) {
      const visible = wanted.get(key)?.hidden !== true;
      if (group.visible !== visible) {
        group.visible = visible;
        requestRenderRef.current?.();
      }
    }

    const nativeEnabled = Boolean(nativeMaterialsEnabled);
    for (const group of state.groups.values()) {
      const current = modNativeStates.get(group);
      const upToDate = current
        ? current.enabled === nativeEnabled && current.token === nativeMaterialsReloadToken
        : !nativeEnabled;
      if (upToDate) continue;
      if (current) {
        disposeModNative(group);
        changed = true;
      }
      if (!nativeEnabled) continue;
      const controller = new AbortController();
      const entry = {
        enabled: true,
        token: nativeMaterialsReloadToken,
        controller,
        resources: null,
        summary: null,
        state: "loading",
        message: "",
      };
      modNativeStates.set(group, entry);
      loadNativeMaterialView({
        object: group,
        renderer: rendererRef.current,
        signal: controller.signal,
        onRender: () => requestRenderRef.current?.(),
      }).then((resources) => {
        if (controller.signal.aborted) {
          resources.dispose();
          return;
        }
        Object.assign(entry, { resources, summary: resources.summary, state: "ready" });
        refresh();
        bump();
      }).catch((error) => {
        if (controller.signal.aborted || error?.name === "AbortError") return;
        Object.assign(entry, { state: "error", message: error?.message || "Texture loading failed." });
        bump();
      });
    }

    for (const [key, part] of wanted) {
      if (state.groups.has(key) || state.loading.has(key) || state.failures.has(key)) continue;
      state.loading.add(key);
      const animateIn = animate;
      loadVehicleModPart(part.path, root.userData?.parentTextures || null, { invoke, readFile })
        .then(async (group) => {
          const stillWanted = () => modelRef.current === model &&
            vehicleModsRef.current?.parts?.some((entry) => entry.key === key);
          if (!stillWanted()) {
            disposeObject(group);
            return;
          }
          // The part's textures load before it is fitted, so it lands finished
          // instead of landing grey and repainting. A toggle or reload meanwhile
          // is reconciled by the native pass above on the next run.
          if (nativeEnabled) {
            const native = {
              enabled: true,
              token: nativeMaterialsReloadToken,
              controller: new AbortController(),
              resources: null,
              summary: null,
              state: "loading",
              message: "",
            };
            state.textureLoads.add(native.controller);
            try {
              const resources = await loadNativeMaterialView({ object: group, renderer: rendererRef.current, signal: native.controller.signal });
              Object.assign(native, { resources, summary: resources.summary, state: "ready" });
            } catch (error) {
              Object.assign(native, { state: "error", message: error?.message || "Texture loading failed." });
            } finally {
              state.textureLoads.delete(native.controller);
            }
            if (native.controller.signal.aborted || !stillWanted()) {
              native.resources?.dispose();
              disposeObject(group);
              return;
            }
            modNativeStates.set(group, native);
          }
          applyShadowFlags(group, stageRef.current?.castsShadows ?? shadowsEnabledRef.current);
          group.visible = vehicleModsRef.current?.parts?.find((entry) => entry.key === key)?.hidden !== true;
          root.add(group);
          // Fitted to its kit bone so it opens with a door, bonnet or boot.
          vehicleRigRef.current?.attach(group, part.bone);
          state.groups.set(key, group);
          refresh();
          const swapper = partSwapRef.current;
          if (animateIn && swapper && group.visible && vehicleModsRef.current?.requestId == null && !prefersReducedMotion()) {
            swapper.enter(group, { anchor: root, delay: swapper.active ? SWAP_HANDOFF_MS : 0 });
            requestRenderRef.current?.();
          }
        })
        .catch((error) => {
          if (modelRef.current === model) state.failures.set(key, error?.message || String(error));
        })
        .finally(() => {
          state.loading.delete(key);
          bump();
        });
    }

    const livery = getLiveryState(model);
    for (const [path, entry] of livery.mods) {
      if (liveryParts.some((part) => part.path === path)) continue;
      entry.texture?.dispose();
      livery.mods.delete(path);
    }
    for (const part of liveryParts) {
      if (livery.mods.has(part.path)) continue;
      const entry = { state: "loading", texture: null, message: "" };
      livery.mods.set(part.path, entry);
      (async () => {
        const group = await loadVehicleModPart(part.path, root.userData?.parentTextures || null, { invoke, readFile });
        try {
          const texturePath = findLiveryModTexturePath(group);
          if (!texturePath) throw new Error("The livery part carries no livery texture.");
          return await loadNativeTextureSource(texturePath, rendererRef.current);
        } finally {
          disposeObject(group);
        }
      })().then((texture) => {
        if (livery.mods.get(part.path) !== entry) {
          texture.dispose();
          return;
        }
        Object.assign(entry, { state: "ready", texture });
        if (livery.activeModPath === part.path) applyGameLivery();
        bump();
      }).catch((error) => {
        if (livery.mods.get(part.path) !== entry) return;
        Object.assign(entry, { state: "error", message: error?.message || String(error) });
        bump();
      });
    }
    // Kit Shoot keeps a slot's options loaded and shows one at a time.
    const activeLiveryPath = liveryParts.find((part) => part.hidden !== true)?.path || "";
    if (livery.activeModPath !== activeLiveryPath) {
      livery.activeModPath = activeLiveryPath;
      applyGameLivery();
    }

    if (changed) refresh();
    state.primed = true;

    const partStatus = {};
    for (const part of liveryParts) {
      const entry = livery.mods.get(part.path);
      partStatus[part.key] = entry?.state === "error"
        ? { state: "error", message: entry.message }
        : { state: entry?.state === "ready" ? "ready" : "loading", textures: null };
    }
    for (const key of wanted.keys()) {
      const group = state.groups.get(key);
      const native = group ? modNativeStates.get(group) : null;
      if (state.failures.has(key)) {
        partStatus[key] = { state: "error", message: state.failures.get(key) };
      } else if (!group) {
        partStatus[key] = { state: "loading" };
      } else {
        partStatus[key] = {
          state: "ready",
          textures: native ? {
            state: native.state,
            message: native.message,
            loaded: native.summary?.loadedTextureCount ?? 0,
            failed: native.summary?.failedTextureCount ?? 0,
            missing: native.summary?.missingBindingCount ?? 0,
          } : null,
        };
      }
    }
    // Settled: every wanted part has loaded or failed and no texture load is
    // pending, so a capture now shows exactly what was asked for.
    const settled = Object.values(partStatus).every((entry) => entry.state !== "loading" && entry.textures?.state !== "loading");
    onVehicleModsStatusRef.current?.({
      requestId,
      settled,
      parts: partStatus,
      hiddenMeshCount,
      boneDataAvailable,
      parentTexturesAvailable: Boolean(root.userData?.parentTextures),
    });
  }, [vehicleMods, modelVersion, sceneReady, nativeMaterialsEnabled, nativeMaterialsReloadToken, vehicleModsRevision, applyGameLivery]);

  useEffect(() => {
    const model = modelRef.current;
    return () => {
      const state = model ? vehicleModStates.get(model) : null;
      disposeLiveryState(model);
      if (!state) return;
      for (const controller of state.textureLoads) controller.abort();
      for (const group of state.groups.values()) disposeModNative(group);
      vehicleModStates.delete(model);
    };
  }, [modelVersion]);

  useEffect(() => {
    if (!modelRef.current) return;
    if (applyFrontWheelSteering(modelRef.current, steeringAngle) > 0) requestRenderRef.current?.();
  }, [steeringAngle, modelVersion]);

  useEffect(() => {
    const rig = vehicleRigRef.current;
    if (!rig) return;
    rig.setClip(roofClip);
    emitVehicleParts();
    requestRenderRef.current?.();
    // emitVehicleParts reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roofClip, modelVersion]);

  useEffect(() => {
    if (!modelRef.current) return;
    modelRef.current.userData = modelRef.current.userData || {};
    modelRef.current.userData.materialConfig = materialStateRef.current.materialConfig || DEFAULT_MATERIAL_CONFIG;
    modelRef.current.userData.materialDetailTexture = materialTextureRef.current || null;
    applyMaterials(
      modelRef.current,
      resolvedBodyColor,
      textureRef.current,
      textureTarget,
      windowTextureRef.current,
      windowTextureTarget,
      liveryExteriorOnly,
      textureMode,
      materialStateRef.current.glossiness,
      materialStateRef.current.showWireframe,
    );
    requestRender();
  }, [
    resolvedBodyColor,
    resolvedPaint,
    textureTarget,
    windowTextureTarget,
    liveryExteriorOnly,
    textureMode,
    showWireframe,
    showCageWireframe,
    materialType,
    materialLightIntensity,
    materialGlossiness,
    materialRoughness,
    materialClearcoat,
  ]);

  const modelRotationKey = modelRotation === undefined ? "" : JSON.stringify(normalizeModelRotation(modelRotation));
  useEffect(() => {
    const model = modelRef.current;
    if (!modelRotationKey || !model) return;
    // A freshly loaded model already stands where the loader put it.
    if ((model.userData.rotationKey ?? "null") === modelRotationKey) return;
    model.userData.rotationKey = modelRotationKey;
    withTurntableAtRest(turntableRef.current, () => orientModel(
      model,
      JSON.parse(modelRotationKey),
      // The loader grounds on the full bounds (stabilizeObjectForWorld); so does a turn.
      (target) => new THREE.Box3().setFromObject(target),
    ));
    if (materialStateRef.current.showCageWireframe && sceneRef.current) {
      disposeCageOverlay(sceneRef.current);
      attachCageOverlay(buildCageOverlay(model, sceneRef.current), turntableRef.current);
    }
    reframeModelRef.current?.();
  }, [modelRotationKey, modelVersion]);

  // A quarter turn can change the size without changing the counts.
  useEffect(() => {
    meshStatsKeyRef.current = null;
    requestRenderRef.current?.();
  }, [showSolidWireframe, modelVersion, modelRotationKey]);

  useEffect(() => {
    const state = collisionRef.current;
    const model = modelRef.current;
    const path = shownModelPathRef.current;
    const showModel = () => {
      for (const object of state.hidden) object.visible = true;
      state.hidden = [];
    };
    const place = () => {
      const overlay = state.overlay;
      if (!overlay || !model?.parent) return;
      const inner = model.userData.modelSpaceRoot || model;
      model.updateMatrix();
      overlay.group.matrixAutoUpdate = false;
      overlay.group.matrix.copy(model.matrix);
      if (inner !== model) {
        inner.updateMatrix();
        overlay.group.matrix.multiply(inner.matrix);
      }
      overlay.group.matrixWorldNeedsUpdate = true;
      if (overlay.group.parent !== model.parent) model.parent.add(overlay.group);
      overlay.setSolid(collisionsOnly);
      showModel();
      if (collisionsOnly) {
        const cage = sceneRef.current?.getObjectByName("__cageOverlay");
        state.hidden = [model, cage].filter((object) => object?.visible);
        for (const object of state.hidden) object.visible = false;
      }
      requestRenderRef.current?.();
    };
    const clear = () => {
      showModel();
      state.overlay?.dispose();
      state.overlay = null;
      state.key = "";
      state.request += 1;
    };

    if (!showCollisions || !model || !path) {
      clear();
      onCollisionsRef.current?.(null);
      requestRenderRef.current?.();
      return;
    }
    if (!isTauriRuntime || !/\.(yft|ydr|ydd)$/i.test(path)) {
      clear();
      onCollisionsRef.current?.({ status: "unavailable" });
      return;
    }
    const key = `${path}|${modelVersion}`;
    if (state.key === key) {
      place();
      return;
    }
    clear();
    state.key = key;
    const request = state.request;
    onCollisionsRef.current?.({ status: "loading" });
    readModelCollisions(invoke, path, String(modelVersion))
      .then((data) => {
        if (request !== state.request) return;
        if (!data.meshes.length && !data.primitives.length) {
          onCollisionsRef.current?.({ status: "none", data });
          return;
        }
        state.overlay = buildCollisionOverlay(data);
        place();
        onCollisionsRef.current?.({ status: "ready", data });
      })
      .catch((error) => {
        if (request !== state.request) return;
        onCollisionsRef.current?.({ status: "error", error: String(error?.message || error) });
      });
  }, [showCollisions, collisionsOnly, modelVersion, modelRotationKey, isTauriRuntime]);

  // Cage wireframe overlay — builds/disposes EdgesGeometry + bounding-box cubes
  useEffect(() => {
    if (!sceneReady || !modelRef.current || !sceneRef.current) return;
    if (showCageWireframe) {
      attachCageOverlay(buildCageOverlay(modelRef.current, sceneRef.current), turntableRef.current);
    } else {
      disposeCageOverlay(sceneRef.current);
    }
    requestRender();
  }, [showCageWireframe, sceneReady]);

  useEffect(() => {
    let cancelled = false;

    const clearTexture = () => {
      const materialState = materialStateRef.current;
      // A composite handed in through setCompositeTexture is owned by the caller.
      if (textureRef.current && textureRef.current === compositeTextureRef.current) return;
      if (textureRef.current) {
        releaseTexture(textureRef.current);
        textureRef.current = null;
      }
      if (modelRef.current) {
        applyMaterials(
          modelRef.current,
          materialState.bodyColor,
          null,
          materialState.textureTarget,
          windowTextureRef.current,
          materialState.windowTextureTarget,
          materialState.liveryExteriorOnly,
          materialState.textureMode,
          materialState.glossiness,
          materialState.showWireframe,
        );
      }
      onTextureErrorRef.current?.("");
    };

    if (!texturePath) {
      clearTexture();
      return;
    }

    const loadTexture = async () => {
      // Handle data: URLs (e.g. from VariantsPage composited preview)
      if (texturePath.startsWith("data:")) {
        try {
          const img = new Image();
          img.crossOrigin = "anonymous";
          await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = texturePath;
          });
          const texture = new THREE.CanvasTexture(img);
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.flipY = true;
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          texture.needsUpdate = true;
          texture.anisotropy = rendererRef.current?.capabilities.getMaxAnisotropy() || 1;
          if (cancelled) return;
          releaseTexture(textureRef.current);
          textureRef.current = texture;
          retainTexture(texture);
          const materialState = materialStateRef.current;
          if (modelRef.current) {
            applyMaterials(
              modelRef.current,
              materialState.bodyColor,
              texture,
              materialState.textureTarget,
              windowTextureRef.current,
              materialState.windowTextureTarget,
              materialState.liveryExteriorOnly,
              materialState.textureMode,
              materialState.glossiness,
              materialState.showWireframe,
            );
            requestRender();
          }
          onTextureErrorRef.current?.("");
          onTextureReload?.();
        } catch {
          /* data URL loading failed */
        }
        return;
      }

      const cacheKey = getTextureCacheKey(texturePath, flipTextureY);
      const cached = shouldReuseCachedTexture(loadedTextureTokensRef.current, cacheKey, textureReloadToken)
        ? getCachedTexture(cacheKey)
        : null;
      if (cached) {
        if (cancelled) return;
        rememberLoadedTexture(loadedTextureTokensRef.current, cacheKey, textureReloadToken);
        const materialState = materialStateRef.current;
        if (textureRef.current !== cached) {
          releaseTexture(textureRef.current);
          textureRef.current = cached;
          retainTexture(cached);
        }
        if (modelRef.current) {
          applyMaterials(
            modelRef.current,
            materialState.bodyColor,
            cached,
            materialState.textureTarget,
            windowTextureRef.current,
            materialState.windowTextureTarget,
            materialState.liveryExteriorOnly,
            materialState.textureMode,
            materialState.glossiness,
            materialState.showWireframe,
          );
          requestRender();
        }
        onTextureErrorRef.current?.("");
        onTextureReload?.();
        return;
      }
      let sourcePath = texturePath;
      if (isYtdTexturePath(texturePath)) {
        try {
          sourcePath = await resolveYtdTexturePath(texturePath);
        } catch (error) {
          if (cancelled) return;
          if (textureRef.current?.userData?.cacheKey === cacheKey) {
            console.warn("[Texture] Dictionary reload failed, keeping the current texture:", error);
            return;
          }
          onTextureErrorRef.current?.(`${texturePath.split(/[\\/]/).pop()} couldn't be read: ${error?.message || error}`);
          return;
        }
        if (cancelled) return;
      }
      let bytes = null;
      try {
        bytes = await readFile(sourcePath);
      } catch (error) {
        if (cancelled) return;
        // A watched file can be locked for a moment while its editor saves
        // it; the shown texture stays and the next save event reloads it.
        if (textureRef.current?.userData?.cacheKey === cacheKey) {
          console.warn("[Texture] Reload read failed, keeping the current texture:", error);
          return;
        }
        onTextureErrorRef.current?.(`${texturePath.split(/[\\/]/).pop()} couldn't be read: ${error?.message || error}`);
        return;
      }
      if (cancelled) return;

      const extension = getFileExtension(sourcePath);
      const signature = sniffTextureSignature(bytes);

      const buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );

      const applyTextureSettings = (texture) => {
        const isLiveryMode = materialStateRef.current?.textureMode === "livery";
        texture.colorSpace = THREE.SRGBColorSpace;
        if (!texture.isCompressedTexture && !texture.userData?.ddsDecoded && !texture.userData?.flipBaked) {
          texture.flipY = flipTextureY;
        }
        texture.wrapS = isLiveryMode ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
        texture.wrapT = isLiveryMode ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
        texture.needsUpdate = true;
        texture.anisotropy = rendererRef.current?.capabilities.getMaxAnisotropy() || 1;
        if (texture.isDataTexture) {
          texture.magFilter = THREE.LinearFilter;
          texture.minFilter = THREE.LinearMipmapLinearFilter;
          if (!texture.mipmaps || texture.mipmaps.length === 0) {
            texture.generateMipmaps = true;
          }
        }
      };

      const loadNative = async () => {
        const mime = signature.mime || getTextureMimeType(extension) || "application/octet-stream";
        return loadBlobTexture(new Blob([bytes], { type: mime }), { flipY: flipTextureY, textureLoader });
      };

      const loadDdsCustom = async () => {
        const tex = await parseDDSAsync(buffer, { renderer: rendererRef.current });
        if (!tex) throw new Error("Custom DDS parser returned null");
        return tex;
      };

      const loadDdsFallback = async () => {
        const loader = new DDSLoader();
        if (typeof loader.parse === "function") {
          return loader.parse(buffer, true);
        }
        const blob = new Blob([bytes], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        try {
          const texture = await new Promise((resolve, reject) => {
            loader.load(url, resolve, undefined, reject);
          });
          return texture;
        } finally {
          URL.revokeObjectURL(url);
        }
      };

      const loadTga = async () => {
        const loader = new TGALoader();
        if (typeof loader.parse === "function") {
          return loader.parse(buffer);
        }
        const blob = new Blob([bytes], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        try {
          const texture = await new Promise((resolve, reject) => {
            loader.load(url, resolve, undefined, reject);
          });
          return texture;
        } finally {
          URL.revokeObjectURL(url);
        }
      };

      const loadPsd = async () => loadPsdTexture(bytes);

      const loadTiff = async () => {
        const mod = await import("utif");
        const UTIF = mod.default || mod;
        const ifds = UTIF.decode(buffer);
        if (!ifds || ifds.length === 0) {
          throw new Error("TIFF contained no images.");
        }
        UTIF.decodeImage(buffer, ifds[0]);
        const rgba = UTIF.toRGBA8(ifds[0]);
        const w = ifds[0].width;
        const h = ifds[0].height;
        if (!rgba || !w || !h) {
          throw new Error("TIFF decode returned empty image data.");
        }
        return new THREE.DataTexture(rgba, w, h, THREE.RGBAFormat);
      };

      const loadAi = async () => {
        const pdfjsLib = await import("pdfjs-dist");
        pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url
        ).href;
        const loadingTask = pdfjsLib.getDocument({ data: buffer });
        try {
          const pdf = await loadingTask.promise;
          const page = await pdf.getPage(1);
          const viewport = page.getViewport({ scale: 2.0 });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const context = canvas.getContext("2d");
          await page.render({ canvasContext: context, viewport }).promise;
          return new THREE.CanvasTexture(canvas);
        } finally {
          // Each getDocument call starts its own pdf.js worker; this ends it.
          await loadingTask.destroy().catch(() => {});
        }
      };

      const loadPdn = async () => loadPdnTexture(bytes, texturePath);

      const attempts = [];
      const kind = (extension || "").toLowerCase();
      const sigKind = (signature.kind || "").toLowerCase();
      const isTiff = kind === "tif" || kind === "tiff" || sigKind === "tif" || sigKind === "tiff";
      const isPsd = kind === "psd" || sigKind === "psd";
      const isDds = kind === "dds" || sigKind === "dds";
      const isAi = kind === "ai" || sigKind === "ai" || sigKind === "ai-ps";
      const isPdnFile = kind === "pdn" || sigKind === "pdn";
      const isPdfCompatibleAi = sigKind === "ai" || kind === "ai";
      const isUnsupportedAiVariant = kind === "ai" && sigKind !== "ai";

      if (isDds) { attempts.push(loadDdsCustom); attempts.push(loadDdsFallback); }
      if (kind === "tga") attempts.push(loadTga);
      if (isPsd) attempts.push(loadPsd);
      if (isPdnFile) attempts.push(loadPdn);
      if (isTiff) attempts.push(loadTiff);
      if (isAi && isPdfCompatibleAi) attempts.push(loadAi);
      attempts.push(loadNative);

      let texture = null;
      let lastError = null;

      for (const attempt of attempts) {
        try {
          texture = await attempt();
          if (texture) break;
        } catch (error) {
          if (error?.type === "unsupported-bit-depth") {
            console.log("[Texture] Unsupported bit depth detected:", error.bitDepth);
            if (!cancelled) onFormatWarningRef.current?.({ type: "16bit-psd", bitDepth: error.bitDepth, path: texturePath, kind: "primary" });
            return;
          }
          if (!lastError || (error instanceof Error && error.message)) {
            lastError = error;
          }
        }
      }

      if (!texture) {
        if (cancelled) return;
        console.error("[Texture] Load failed:", lastError);
        const errorMessage = isUnsupportedAiVariant
          ? "This .ai file is not PDF-compatible. Re-save/export it as PDF-compatible AI, or use PNG/JPG."
          : (lastError?.message ||
            "Texture failed to load. Try exporting to PNG or JPG if your editor uses a specialized format.");
        onTextureErrorRef.current?.(errorMessage);
        return;
      }

      if (cancelled) {
        releaseTexture(texture);
        return;
      }

      applyTextureSettings(texture);
      cacheTexture(cacheKey, texture);
      rememberLoadedTexture(loadedTextureTokensRef.current, cacheKey, textureReloadToken);
      releaseTexture(textureRef.current);
      textureRef.current = texture;
      retainTexture(texture);

      if (modelRef.current) {
        const materialState = materialStateRef.current;
        applyMaterials(
          modelRef.current,
          materialState.bodyColor,
          texture,
          materialState.textureTarget,
          windowTextureRef.current,
          materialState.windowTextureTarget,
          materialState.liveryExteriorOnly,
          materialState.textureMode,
          materialState.glossiness,
          materialState.showWireframe,
        );
        requestRender();
      }

      onTextureErrorRef.current?.("");
      onTextureReload?.();
    };

    loadTexture();

    return () => {
      cancelled = true;
    };
  }, [
    texturePath,
    textureReloadToken,
    textureLoader,
    onTextureReload,
    flipTextureY,
  ]);

  useEffect(() => {
    let cancelled = false;

    const clearTexture = () => {
      const materialState = materialStateRef.current;
      if (windowTextureRef.current) {
        releaseTexture(windowTextureRef.current);
        windowTextureRef.current = null;
      }
      if (modelRef.current) {
        applyMaterials(
          modelRef.current,
          materialState.bodyColor,
          textureRef.current,
          materialState.textureTarget,
          null,
          materialState.windowTextureTarget,
          materialState.liveryExteriorOnly,
          materialState.textureMode,
          materialState.glossiness,
          materialState.showWireframe,
        );
        requestRender();
      }
      onWindowTextureErrorRef.current?.("");
    };

    if (!windowTexturePath) {
      clearTexture();
      return;
    }

    const loadTexture = async () => {
      const cacheKey = getTextureCacheKey(windowTexturePath, flipTextureY);
      const cached = shouldReuseCachedTexture(loadedWindowTextureTokensRef.current, cacheKey, windowTextureReloadToken)
        ? getCachedTexture(cacheKey)
        : null;
      if (cached) {
        if (cancelled) return;
        rememberLoadedTexture(loadedWindowTextureTokensRef.current, cacheKey, windowTextureReloadToken);
        const materialState = materialStateRef.current;
        if (windowTextureRef.current !== cached) {
          releaseTexture(windowTextureRef.current);
          windowTextureRef.current = cached;
          retainTexture(cached);
        }
        if (modelRef.current) {
          applyMaterials(
            modelRef.current,
            materialState.bodyColor,
            textureRef.current,
            materialState.textureTarget,
            cached,
            materialState.windowTextureTarget,
            materialState.liveryExteriorOnly,
            materialState.textureMode,
            materialState.glossiness,
            materialState.showWireframe,
          );
          requestRender();
        }
        onWindowTextureErrorRef.current?.("");
        onTextureReload?.();
        return;
      }
      let bytes = null;
      try {
        bytes = await readFile(windowTexturePath);
      } catch (error) {
        if (cancelled) return;
        // As for the livery: a watched reload keeps the shown texture.
        if (windowTextureRef.current?.userData?.cacheKey === cacheKey) {
          console.warn("[Window Texture] Reload read failed, keeping the current texture:", error);
          return;
        }
        onWindowTextureErrorRef.current?.(`${windowTexturePath.split(/[\\/]/).pop()} couldn't be read: ${error?.message || error}`);
        return;
      }
      if (cancelled) return;

      const extension = getFileExtension(windowTexturePath);
      const signature = sniffTextureSignature(bytes);

      const buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );

      const applyTextureSettings = (texture) => {
        const isLiveryMode = materialStateRef.current?.textureMode === "livery";
        texture.colorSpace = THREE.SRGBColorSpace;
        if (!texture.isCompressedTexture && !texture.userData?.ddsDecoded && !texture.userData?.flipBaked) {
          texture.flipY = flipTextureY;
        }
        texture.wrapS = isLiveryMode ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
        texture.wrapT = isLiveryMode ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
        texture.needsUpdate = true;
        texture.anisotropy = rendererRef.current?.capabilities.getMaxAnisotropy() || 1;
        if (texture.isDataTexture) {
          texture.magFilter = THREE.LinearFilter;
          texture.minFilter = THREE.LinearMipmapLinearFilter;
          if (!texture.mipmaps || texture.mipmaps.length === 0) {
            texture.generateMipmaps = true;
          }
        }
      };

      const loadNative = async () => {
        const mime = signature.mime || getTextureMimeType(extension) || "application/octet-stream";
        return loadBlobTexture(new Blob([bytes], { type: mime }), { flipY: flipTextureY, textureLoader });
      };

      const loadDdsCustom = async () => {
        const tex = await parseDDSAsync(buffer, { renderer: rendererRef.current });
        if (!tex) throw new Error("Custom DDS parser returned null");
        return tex;
      };

      const loadDdsFallback = async () => {
        const loader = new DDSLoader();
        if (typeof loader.parse === "function") {
          return loader.parse(buffer, true);
        }
        const blob = new Blob([bytes], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        try {
          const texture = await new Promise((resolve, reject) => {
            loader.load(url, resolve, undefined, reject);
          });
          return texture;
        } finally {
          URL.revokeObjectURL(url);
        }
      };

      const loadTga = async () => {
        const loader = new TGALoader();
        if (typeof loader.parse === "function") {
          return loader.parse(buffer);
        }
        const blob = new Blob([bytes], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        try {
          const texture = await new Promise((resolve, reject) => {
            loader.load(url, resolve, undefined, reject);
          });
          return texture;
        } finally {
          URL.revokeObjectURL(url);
        }
      };

      const loadPsd = async () => loadPsdTexture(bytes);

      const loadTiff = async () => {
        const mod = await import("utif");
        const UTIF = mod.default || mod;
        const ifds = UTIF.decode(buffer);
        if (!ifds || ifds.length === 0) {
          throw new Error("TIFF contained no images.");
        }
        UTIF.decodeImage(buffer, ifds[0]);
        const rgba = UTIF.toRGBA8(ifds[0]);
        const w = ifds[0].width;
        const h = ifds[0].height;
        if (!rgba || !w || !h) {
          throw new Error("TIFF decode returned empty image data.");
        }
        return new THREE.DataTexture(rgba, w, h, THREE.RGBAFormat);
      };

      const loadAi = async () => {
        const pdfjsLib = await import("pdfjs-dist");
        pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url
        ).href;
        const loadingTask = pdfjsLib.getDocument({ data: buffer });
        try {
          const pdf = await loadingTask.promise;
          const page = await pdf.getPage(1);
          const viewport = page.getViewport({ scale: 2.0 });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const context = canvas.getContext("2d");
          await page.render({ canvasContext: context, viewport }).promise;
          return new THREE.CanvasTexture(canvas);
        } finally {
          // Each getDocument call starts its own pdf.js worker; this ends it.
          await loadingTask.destroy().catch(() => {});
        }
      };

      const loadPdn = async () => loadPdnTexture(bytes, windowTexturePath);

      const attempts = [];
      const kind = (extension || "").toLowerCase();
      const sigKind = (signature.kind || "").toLowerCase();
      const isTiff = kind === "tif" || kind === "tiff" || sigKind === "tif" || sigKind === "tiff";
      const isPsd = kind === "psd" || sigKind === "psd";
      const isDds = kind === "dds" || sigKind === "dds";
      const isAi = kind === "ai" || sigKind === "ai" || sigKind === "ai-ps";
      const isPdnFile = kind === "pdn" || sigKind === "pdn";
      const isPdfCompatibleAi = sigKind === "ai" || kind === "ai";
      const isUnsupportedAiVariant = kind === "ai" && sigKind !== "ai";

      if (isDds) { attempts.push(loadDdsCustom); attempts.push(loadDdsFallback); }
      if (kind === "tga") attempts.push(loadTga);
      if (isPsd) attempts.push(loadPsd);
      if (isPdnFile) attempts.push(loadPdn);
      if (isTiff) attempts.push(loadTiff);
      if (isAi && isPdfCompatibleAi) attempts.push(loadAi);
      attempts.push(loadNative);

      let texture = null;
      let lastError = null;

      for (const attempt of attempts) {
        try {
          texture = await attempt();
          if (texture) break;
        } catch (error) {
          if (error?.type === "unsupported-bit-depth") {
            if (!cancelled) onFormatWarningRef.current?.({ type: "16bit-psd", bitDepth: error.bitDepth, path: windowTexturePath, kind: "window" });
            return;
          }
          lastError = error;
        }
      }

      if (!texture) {
        if (cancelled) return;
        console.error("[Window Texture] Load failed:", lastError);
        onWindowTextureErrorRef.current?.(
          isUnsupportedAiVariant
            ? "This .ai file is not PDF-compatible. Re-save/export it as PDF-compatible AI, or use PNG/JPG."
            : "Window template failed to load. Try exporting to PNG or JPG if your editor uses a specialized format.",
        );
        return;
      }

      if (cancelled) {
        releaseTexture(texture);
        return;
      }

      applyTextureSettings(texture);
      cacheTexture(cacheKey, texture);
      rememberLoadedTexture(loadedWindowTextureTokensRef.current, cacheKey, windowTextureReloadToken);
      releaseTexture(windowTextureRef.current);
      windowTextureRef.current = texture;
      retainTexture(texture);

      if (modelRef.current) {
        const materialState = materialStateRef.current;
        applyMaterials(
          modelRef.current,
          materialState.bodyColor,
          textureRef.current,
          materialState.textureTarget,
          texture,
          materialState.windowTextureTarget,
          materialState.liveryExteriorOnly,
          materialState.textureMode,
          materialState.glossiness,
          materialState.showWireframe,
        );
      }

      onWindowTextureErrorRef.current?.("");
      onTextureReload?.();
    };

    loadTexture();

    return () => {
      cancelled = true;
    };
  }, [
    windowTexturePath,
    windowTextureReloadToken,
    textureLoader,
    onTextureReload,
    flipTextureY,
  ]);

  useEffect(() => {
    let cancelled = false;

    const applyCurrent = () => {
      if (!modelRef.current) return;
      modelRef.current.userData = modelRef.current.userData || {};
      modelRef.current.userData.materialConfig = materialStateRef.current.materialConfig || DEFAULT_MATERIAL_CONFIG;
      modelRef.current.userData.materialDetailTexture = materialTextureRef.current || null;
      const materialState = materialStateRef.current;
      applyMaterials(
        modelRef.current,
        materialState.bodyColor,
        textureRef.current,
        materialState.textureTarget,
        windowTextureRef.current,
        materialState.windowTextureTarget,
        materialState.liveryExteriorOnly,
        materialState.textureMode,
        materialState.glossiness,
        materialState.showWireframe,
      );
      requestRender();
    };

    const clearTexture = () => {
      if (materialTextureRef.current) {
        releaseTexture(materialTextureRef.current);
        materialTextureRef.current = null;
      }
      applyCurrent();
    };

    if (!materialTexturePath) {
      clearTexture();
      return;
    }

    const loadTexture = async () => {
      const cacheKey = getTextureCacheKey(materialTexturePath, flipTextureY);
      const cached = getCachedTexture(cacheKey);
      if (cached) {
        if (cancelled) return;
        releaseTexture(materialTextureRef.current);
        materialTextureRef.current = cached;
        retainTexture(cached);
        applyCurrent();
        return;
      }

      let texture = null;
      let failure = null;
      try {
        texture = await loadTextureFromPathShared(materialTexturePath, textureLoader, rendererRef.current);
      } catch (error) {
        failure = error;
      }

      if (cancelled) {
        disposeTexture(texture);
        return;
      }
      if (!texture) {
        if (failure?.type === "unsupported-bit-depth") {
          onFormatWarningRef.current?.({
            type: "16bit-psd",
            bitDepth: failure.bitDepth,
            path: materialTexturePath,
            kind: "material",
          });
        } else {
          const name = materialTexturePath.split(/[\\/]/).pop();
          onAssetErrorRef.current?.(`Texture map ${name} couldn't be read.${failure?.message ? ` ${failure.message}` : ""}`);
        }
        return;
      }

      texture.colorSpace = THREE.SRGBColorSpace;
      if (!texture.isCompressedTexture && !texture.userData?.ddsDecoded && !texture.userData?.flipBaked) {
        texture.flipY = flipTextureY;
      }
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.needsUpdate = true;
      texture.anisotropy = rendererRef.current?.capabilities?.getMaxAnisotropy?.() || 1;
      cacheTexture(cacheKey, texture);
      releaseTexture(materialTextureRef.current);
      materialTextureRef.current = texture;
      retainTexture(texture);
      applyCurrent();
    };

    loadTexture();
    return () => {
      cancelled = true;
    };
  }, [materialTexturePath, textureLoader, flipTextureY, requestRender]);

  return <div ref={containerRef} className="model-viewer h-full w-full" />;
}

export default memo(ViewerComponent);

function summarizeModelLights(object) {
  const natives = [];
  let lightBones = [];
  object?.traverse((child) => {
    if (child.isMesh && child.userData?.nativeMaterial && child.userData.nativeLodActive !== false) natives.push(child.userData.nativeMaterial);
    if (!lightBones.length && Array.isArray(child.userData?.lightBones)) lightBones = child.userData.lightBones;
  });
  return summarizeVehicleLights(natives, lightBones);
}

// Per-model mod kit state and per-part native texture state. Kept out of
// userData because Object3D.clone JSON-copies userData.
const vehicleModStates = new WeakMap();
// When each model's extras may start animating: the extras it spawns with, and
// the ULC or siren extras that switch while its resource is read, appear at once.
const extrasSettledAt = new WeakMap();
const EXTRAS_SETTLE_MS = 1500;
const modNativeStates = new WeakMap();
const LIVERY_MOD_SLOT = "VMT_LIVERY_MOD";
// Per-model game livery: the override on its native materials, the texture
// liveries it has (`list`), loaded sign textures by number, and mod kit
// livery textures by part path.
const liveryStates = new WeakMap();

function getLiveryState(model) {
  let state = liveryStates.get(model);
  if (!state) {
    state = { override: createLiveryOverride(setNativeOverlayTexture), path: "", list: null, signPrefix: null, signs: new Map(), signNumber: null, signRequest: 0, mods: new Map(), activeModPath: "", error: "" };
    liveryStates.set(model, state);
  }
  return state;
}

function disposeLiveryState(model) {
  const state = model ? liveryStates.get(model) : null;
  if (!state) return;
  state.signRequest += 1;
  state.override.dispose();
  for (const texture of state.signs.values()) texture.dispose();
  for (const entry of state.mods.values()) entry.texture?.dispose();
  liveryStates.delete(model);
}

function describeLiveryState(state) {
  return {
    path: state.path,
    numbers: state.list ? state.list.numbers.slice() : [],
    prefix: state.list?.prefix || "",
    signPrefix: state.signPrefix ?? null,
    shown: state.signNumber,
    error: state.error,
  };
}

// The cage copies world matrices once; inside the turntable it turns with the vehicle.
function attachCageOverlay(group, turntable) {
  if (group && turntable) turntable.attach(group);
}

function isVehicleModMesh(mesh) {
  return mesh?.userData?.vehicleModPart === true;
}

function getVehicleRoot(model) {
  if (!model) return null;
  return model.userData?.normalizedForWorld && model.children[0] ? model.children[0] : model;
}

function disposeModNative(group) {
  const entry = modNativeStates.get(group);
  if (!entry) return;
  entry.controller.abort();
  entry.resources?.dispose?.();
  modNativeStates.delete(group);
}

function detachVehicleModGroup(group) {
  disposeModNative(group);
  group.parent?.remove(group);
  disposeObject(group);
}

/** Plain view of the vehicle rig for React: part targets and the roof state. */
function snapshotVehicleRig(rig) {
  if (!rig) return null;
  return {
    parts: rig.parts.map((part) => ({
      id: part.id,
      label: part.label,
      kind: part.kind,
      min: part.min,
      max: part.max,
      rest: part.rest,
      open: part.open,
      value: rig.getTarget(part.id),
    })),
    roof: rig.hasRoof ? { value: rig.getTarget("roof"), duration: rig.roofDuration } : null,
  };
}

function buildClmeshObject(meshes) {
  const root = new THREE.Group();
  root.name = "clmesh";

  meshes.forEach((mesh) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    if (mesh.normals) {
      geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
    }
    const gtaUvSets = [
      mesh.uvs ? new THREE.BufferAttribute(mesh.uvs, 2) : null,
      mesh.uvs2 ? new THREE.BufferAttribute(mesh.uvs2, 2) : null,
      mesh.uvs3 ? new THREE.BufferAttribute(mesh.uvs3, 2) : null,
      mesh.uvs4 ? new THREE.BufferAttribute(mesh.uvs4, 2) : null,
    ];
    if (gtaUvSets[0]) geometry.setAttribute("uv", gtaUvSets[0]);
    if (gtaUvSets[1]) geometry.setAttribute("uv2", gtaUvSets[1]);
    if (gtaUvSets[2]) geometry.setAttribute("uv3", gtaUvSets[2]);
    if (gtaUvSets[3]) geometry.setAttribute("uv4", gtaUvSets[3]);
    geometry.userData.gtaUvSets = gtaUvSets;
    geometry.userData.uvOrigin = UV_ORIGIN_TOP;
    if (mesh.indices) {
      geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    }
    if (mesh.skinIndices && mesh.skinWeights) {
      // Blended vertices (soft convertible roofs) for vehicle-rig.js.
      geometry.userData.skin = { indices: mesh.skinIndices, weights: mesh.skinWeights };
    }

    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      metalness: 0.2,
      roughness: 0.6,
      side: THREE.FrontSide,
    });
    material.name = mesh.materialName || "";

    const threeMesh = new THREE.Mesh(geometry, material);
    threeMesh.name = mesh.name || material.name || "mesh";
    if (mesh.textureRefs && Object.keys(mesh.textureRefs).length > 0) {
      threeMesh.userData.textureRefs = mesh.textureRefs;
    }
    if (mesh.nativeMaterial) {
      threeMesh.userData.nativeMaterial = mesh.nativeMaterial;
      threeMesh.userData.nativeLodActive = mesh.nativeMaterial.lodActive !== false;
    }
    root.add(threeMesh);
  });

  return root;
}


// Paint slots the model's meshes take; pearlescent rides on primary paint.
function collectPaintSlots(object) {
  const used = new Set();
  for (const child of getMeshList(object)) {
    const { slotRole } = getMeshMeta(child);
    if (slotRole) used.add(slotRole);
  }
  if (used.has("primary")) used.add("pearlescent");
  return VEHICLE_PAINT_KEYS.filter((key) => used.has(key));
}

function getMeshList(object) {
  if (!object) return [];
  if (object.userData?.meshList) return object.userData.meshList;
  const meshes = [];
  object.traverse((child) => {
    if (child.isMesh) meshes.push(child);
  });
  object.userData.meshList = meshes;
  return meshes;
}

function getPrimaryMaterial(material) {
  if (!material) return null;
  if (Array.isArray(material)) return material.find(Boolean) || null;
  return material;
}

function getOrCreateAppliedMaterial(mesh, color) {
  if (mesh.userData.appliedMaterial) return mesh.userData.appliedMaterial;

  const baseMat = getPrimaryMaterial(mesh.userData.baseMaterial || mesh.material);
  const baseRoughness = baseMat?.userData?.baseRoughness ?? baseMat?.roughness ?? 0.6;
  const baseMetalness = baseMat?.metalness ?? 0.2;
  const baseOpacity = typeof baseMat?.opacity === "number" ? baseMat.opacity : 1;
  const material = new THREE.MeshPhysicalMaterial({
    color,
    map: null,
    side: THREE.FrontSide,
    metalness: baseMetalness,
    roughness: baseRoughness,
    clearcoat: 0,
    clearcoatRoughness: 0.35,
    emissive: 0x000000,
  });
  material.userData.baseRoughness = baseRoughness;
  material.userData.baseMetalness = baseMetalness;
  material.userData.baseOpacity = baseOpacity;
  material.userData.baseDepthWrite = baseMat?.depthWrite ?? true;
  setupLiveryShader(material);
  mesh.userData.appliedMaterial = material;
  return material;
}

function updateAppliedMaterial(material, color, map) {
  const resolved = map && typeof map === "object" && !map.isTexture && !Array.isArray(map)
    ? map
    : { map: map || null };
  material.color.copy(color);

  const nextMap = resolved.map || null;
  const nextNormalMap = resolved.normalMap || null;
  const nextEmissiveMap = resolved.emissiveMap || null;
  const nextAoMap = resolved.ambientOcclusionMap || null;
  const nextSpecularMap = resolved.specularMap || null;

  let needsUpdate = false;
  if (material.map !== nextMap) {
    material.map = nextMap;
    needsUpdate = true;
  }
  if (material.normalMap !== nextNormalMap) {
    material.normalMap = nextNormalMap;
    needsUpdate = true;
  }
  if (material.emissiveMap !== nextEmissiveMap) {
    material.emissiveMap = nextEmissiveMap;
    needsUpdate = true;
  }
  if (material.aoMap !== nextAoMap) {
    material.aoMap = nextAoMap;
    needsUpdate = true;
  }
  if ("specularIntensityMap" in material && material.specularIntensityMap !== nextSpecularMap) {
    material.specularIntensityMap = nextSpecularMap;
    needsUpdate = true;
  }
  if ("specularColorMap" in material && material.specularColorMap !== nextSpecularMap) {
    material.specularColorMap = nextSpecularMap;
    needsUpdate = true;
  }

  material.emissive.copy(nextEmissiveMap ? AUTO_TEXTURE_NEUTRAL_COLOR : AUTO_TEXTURE_BLACK);
  if (nextNormalMap && material.normalScale) {
    material.normalScale.set(1, 1);
  }
  if ("specularIntensity" in material) {
    material.specularIntensity = nextSpecularMap ? 1 : material.specularIntensity;
  }

  if (needsUpdate) {
    material.needsUpdate = true;
  }
}

function buildActiveTextureSet(baseTexture) {
  return baseTexture ? { map: baseTexture } : null;
}

// Only these flip shader defines; every other profile value is a uniform.
function getMaterialProgramSignature(material) {
  return [
    material.transparent ? 1 : 0,
    material.side,
    material.transmission > 0 ? 1 : 0,
    material.clearcoat > 0 ? 1 : 0,
    material.sheen > 0 ? 1 : 0,
  ].join("|");
}

// Shapes a body paint material by its slot's carcols finish; the pearlescent
// colour rides on primary paint as a grazing-angle sheen.
function applyPaintFinish(material, finish, pearlColor, glossFactor) {
  const previousSignature = getMaterialProgramSignature(material);
  material.metalness = finish.metalness;
  material.roughness = clamp(finish.roughness * glossFactor, 0.02, 1);
  material.clearcoat = finish.clearcoat;
  material.clearcoatRoughness = finish.clearcoatRoughness;
  material.specularIntensity = finish.specularIntensity;
  if (pearlColor) {
    material.sheen = 1;
    material.sheenColor.copy(pearlColor);
    material.sheenRoughness = 0.35;
  } else {
    material.sheen = 0;
  }
  if (getMaterialProgramSignature(material) !== previousSignature) material.needsUpdate = true;
}

function applyMaterialProfile(material, color, materialConfig, showWireframe) {
  const resolvedConfig = materialConfig || DEFAULT_MATERIAL_CONFIG;
  const type = resolvedConfig.type || DEFAULT_MATERIAL_CONFIG.type;
  const preset = MATERIAL_TYPE_PRESETS[type] || MATERIAL_TYPE_PRESETS.paint;
  const previousSignature = getMaterialProgramSignature(material);

  const tint = color.clone();
  const lightBoost = clamp(
    Number.isFinite(resolvedConfig.lightIntensity) ? resolvedConfig.lightIntensity : DEFAULT_MATERIAL_CONFIG.lightIntensity,
    0,
    3,
  );
  // Not clamped to 1: on a light colour or texture, a response above 1x has
  // to brighten the surface or the slider's upper range does nothing.
  tint.multiplyScalar(lightBoost);
  material.color.copy(tint);

  const materialGlossiness = clamp(
    Number.isFinite(resolvedConfig.glossiness) ? resolvedConfig.glossiness : DEFAULT_MATERIAL_CONFIG.glossiness,
    0,
    1,
  );
  const materialRoughness = clamp(
    Number.isFinite(resolvedConfig.roughness) ? resolvedConfig.roughness : DEFAULT_MATERIAL_CONFIG.roughness,
    0,
    1,
  );
  const glossFactor = 2 - 2 * materialGlossiness;
  material.roughness = clamp(materialRoughness * glossFactor, 0.02, 1);
  material.metalness = clamp(
    Number.isFinite(preset.metalness) ? preset.metalness : (material.userData.baseMetalness ?? 0.2),
    0,
    1,
  );

  const clearcoatValue = clamp(
    Number.isFinite(resolvedConfig.clearcoat) ? resolvedConfig.clearcoat : DEFAULT_MATERIAL_CONFIG.clearcoat,
    0,
    1,
  );
  material.clearcoat = clearcoatValue;
  material.clearcoatRoughness = clamp((1 - materialGlossiness) * 0.55, 0, 1);

  const transparency = clamp(preset.transparency ?? 0, 0, 1);
  const transmission = clamp(preset.transmission ?? 0, 0, 1);
  const baseOpacity = typeof material.userData.baseOpacity === "number" ? material.userData.baseOpacity : 1;
  material.opacity = clamp(baseOpacity * (1 - transparency), 0.08, 1);
  material.transmission = transmission;
  material.ior = type === "glass" ? 1.45 : 1.35;
  material.thickness = type === "glass" ? 0.24 : 0;
  material.transparent = material.opacity < 0.995 || material.transmission > 0;
  material.depthWrite = preset.depthWrite ?? (material.userData.baseDepthWrite ?? true);
  material.side = type === "glass" ? THREE.DoubleSide : THREE.FrontSide;

  if (!material.transparent) {
    material.opacity = 1;
    material.transmission = 0;
  }

  setMaterialWireframe(material, showWireframe);
  if (getMaterialProgramSignature(material) !== previousSignature) {
    material.needsUpdate = true;
  }
}

function applyMaterials(
  object,
  bodyColor,
  texture,
  textureTarget,
  windowTexture,
  windowTextureTarget,
  liveryExteriorOnly,
  textureMode,
  glossiness = 0.5,
  showWireframe = false,
) {
  if (!object) return;

  const paint = normalizeVehiclePaint(object.userData?.vehiclePaint, bodyColor || defaultBody);
  const colorBySlot = {};
  for (const key of VEHICLE_PAINT_KEYS) colorBySlot[key] = new THREE.Color(paintDisplayColor(paint[key]));
  const finishBySlot = {};
  for (const key of FINISHED_PAINT_KEYS) finishBySlot[key] = paintFinishProfile(paint[key].finish);
  // Pearlescent shows on glossy primary paint only, as in game.
  const pearlColor = finishBySlot.primary.clearcoat > 0 ? colorBySlot.pearlescent : null;
  const vehicleTarget = textureTarget || ALL_TARGET;
  const windowTarget = windowTextureTarget || ALL_TARGET;
  const exteriorOnly = Boolean(liveryExteriorOnly);
  const preferUv2 =
    textureMode === "livery" ||
    (textureMode === "everything" && shouldPreferLiveryUvForTarget(vehicleTarget));
  const meshes = getMeshList(object);
  const materialConfig = object.userData?.materialConfig || DEFAULT_MATERIAL_CONFIG;
  const materialDetailTexture = object.userData?.materialDetailTexture || null;
  const vehicleTexture =
    textureMode === "livery"
      ? texture
      : (materialDetailTexture || texture);
  const baseGlossFactor = 2 - 2 * clamp(glossiness, 0, 1);
  const nativeMaterialsEnabled = object.userData?.nativeMaterialsEnabled === true;

  for (const child of meshes) {
    if (!child.userData.baseMaterial) {
      child.userData.baseMaterial = child.material;
    }

    const isGlass = isGlassMaterial(child);
    const matchesVehicleRaw = matchesTextureTarget(child, vehicleTarget);
    const matchesVehicle = preferUv2 && isGlass ? false : matchesVehicleRaw;
    const matchesWindow = Boolean(windowTexture) && matchesTextureTarget(child, windowTarget);
    const { slotRole, slotLocked } = getMeshMeta(child);
    // A vehicle shader's paint layer is final; other meshes under the texture
    // target take primary paint.
    const effectiveSlotRole = matchesWindow
      ? null
      : (slotRole || (matchesVehicle && !slotLocked ? "primary" : null));
    const meshColor = effectiveSlotRole ? colorBySlot[effectiveSlotRole] : AUTO_TEXTURE_NEUTRAL_COLOR;
    const shouldApplySlotColor =
      Boolean(slotRole) ||
      matchesWindow ||
      matchesVehicle;
    const shouldApply = matchesVehicle || matchesWindow || shouldApplySlotColor;
    const activeTextureSet = matchesWindow
      ? buildActiveTextureSet(windowTexture)
      : matchesVehicle
        ? buildActiveTextureSet(vehicleTexture)
        : null;
    const activeTexture = activeTextureSet?.map || null;
    const hasManualTextureOverride = Boolean(activeTexture);
    const preferredUvSelection = matchesWindow
      ? false
      : (matchesVehicle && Boolean(vehicleTexture) ? preferUv2 : false);

    if (activeTextureSet && child.geometry) {
      if (!applyTextureUVSet(child.geometry, preferredUvSelection)) {
        generateBoxProjectionUVs(child.geometry);
      }
    } else if (!shouldApply && child.geometry) {
      restoreBaseUVs(child.geometry);
    }

    const nativeLodVisible = child.userData?.metaExtraVisible !== false &&
      child.userData?.nativeLodActive !== false &&
      child.userData?.modHidden !== true;
    if (exteriorOnly) {
      child.visible = nativeLodVisible && shouldShowExteriorDual(
        child,
        vehicleTarget,
        matchesVehicle || EXTERIOR_PAINT_SLOTS.has(slotRole),
        windowTarget,
        matchesWindow,
      );
    } else {
      child.visible = nativeLodVisible;
    }

    const nativeMaterial = nativeMaterialsEnabled ? child.userData?.nativeMaterialObject : null;
    if (nativeMaterial && !hasManualTextureOverride) {
      const profile = nativeMaterial.userData?.nativeProfile;
      const nativeSlotRole = slotLocked ? slotRole : slotRole || (profile === "paint" ? "primary" : null);
      const fixedColor = nativeSlotRole ? null : child.userData?.nativeMaterial?.diffuseColor;
      if (nativeSlotRole) nativeMaterial.color.copy(colorBySlot[nativeSlotRole]);
      // A fixed matDiffuseColor multiplies the texture as a linear colour.
      else if (fixedColor) nativeMaterial.color.setRGB(clamp(fixedColor[0], 0, 1), clamp(fixedColor[1], 0, 1), clamp(fixedColor[2], 0, 1));
      else nativeMaterial.color.copy(AUTO_TEXTURE_NEUTRAL_COLOR);
      const finish = profile === "paint" ? finishBySlot[nativeSlotRole] : null;
      if (finish) {
        applyPaintFinish(nativeMaterial, finish, nativeSlotRole === "primary" ? pearlColor : null, baseGlossFactor);
      } else {
        const baseRoughness = nativeMaterial.userData?.baseRoughness;
        if (typeof baseRoughness === "number") {
          nativeMaterial.roughness = clamp(baseRoughness * baseGlossFactor, 0, 1);
        }
      }
      setMaterialWireframe(nativeMaterial, showWireframe);
      if (child.material !== nativeMaterial) child.material = nativeMaterial;
      continue;
    }

    if (shouldApply && (activeTexture || matchesVehicle || shouldApplySlotColor)) {
      const appliedMaterial = getOrCreateAppliedMaterial(child, meshColor);
      updateAppliedMaterial(appliedMaterial, meshColor, activeTextureSet);
      const effectiveMaterialConfig = matchesWindow || isGlass
        ? { ...materialConfig, type: "glass" }
        : materialConfig;
      applyMaterialProfile(appliedMaterial, meshColor, effectiveMaterialConfig, showWireframe);
      // EUP has no paint finishes: its Surface panel (materialConfig) is the finish.
      const finish = isGlass || textureMode === "eup" ? null : finishBySlot[effectiveSlotRole];
      if (finish) {
        applyPaintFinish(appliedMaterial, finish, effectiveSlotRole === "primary" ? pearlColor : null, baseGlossFactor);
      } else if (appliedMaterial.sheen > 0) {
        appliedMaterial.sheen = 0;
        appliedMaterial.needsUpdate = true;
      }
      if (child.material !== appliedMaterial) {
        child.material = appliedMaterial;
      }
      continue;
    }

    if (child.material !== child.userData.baseMaterial) {
      if (
        child.material !== child.userData.appliedMaterial &&
        child.material !== child.userData.nativeMaterialObject
      ) {
        disposeMaterial(child.material);
      }
      child.material = child.userData.baseMaterial;
    }
    setMaterialWireframe(child.material, showWireframe);
    const materialList = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materialList) {
      const base = material?.userData?.baseRoughness;
      if (typeof base === "number") {
        material.roughness = clamp(base * baseGlossFactor, 0, 1);
      }
    }
  }
}

function setMaterialWireframe(material, enabled) {
  if (!material) return;
  if (Array.isArray(material)) {
    material.forEach((item) => setMaterialWireframe(item, enabled));
    return;
  }
  if (material.wireframe === enabled) return;
  material.wireframe = enabled;
  material.needsUpdate = true;
}

function getBaseUVs(geometry) {
  if (!geometry) return { uv0: null, uv1: null, uv2: null, uv3: null };
  // GTA models keep their UV sets by index. The attribute names can't be
  // trusted: native materials move set 1 from uv2 to uv1 and set 2 onto uv2,
  // so a cache taken after they load would put a livery on the wrong set.
  const gtaUvSets = geometry.userData?.gtaUvSets;
  if (Array.isArray(gtaUvSets)) {
    return { uv0: gtaUvSets[0] || null, uv1: gtaUvSets[1] || null, uv2: gtaUvSets[2] || null, uv3: gtaUvSets[3] || null };
  }
  if (!geometry.userData.baseUv) {
    geometry.userData.baseUv = geometry.attributes.uv || null;
  }
  if (!geometry.userData.baseUv2) {
    geometry.userData.baseUv2 = geometry.attributes.uv2 || null;
  }
  if (!geometry.userData.baseUv3) {
    geometry.userData.baseUv3 = geometry.attributes.uv3 || null;
  }
  if (!geometry.userData.baseUv4) {
    geometry.userData.baseUv4 = geometry.attributes.uv4 || null;
  }
  return {
    uv0: geometry.userData.baseUv,
    uv1: geometry.userData.baseUv2,
    uv2: geometry.userData.baseUv3,
    uv3: geometry.userData.baseUv4,
  };
}

function scoreUVAttribute(attribute) {
  if (!attribute || !attribute.array || attribute.itemSize < 2) return -1;
  const count = Math.min(attribute.count || 0, 2000);
  if (!count) return -1;
  const array = attribute.array;
  const stride = attribute.itemSize;
  let inRange = 0;
  let valid = 0;
  for (let i = 0; i < count; i += 1) {
    const u = array[i * stride];
    const v = array[i * stride + 1];
    if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
    valid += 1;
    if (u >= 0 && u <= 1 && v >= 0 && v <= 1) inRange += 1;
  }
  if (!valid) return -1;
  return inRange / valid;
}

function hasUVVariation(attribute) {
  if (!attribute || !attribute.array || attribute.itemSize < 2) return false;
  const count = Math.min(attribute.count || 0, 2000);
  if (count < 3) return false;
  const array = attribute.array;
  const stride = attribute.itemSize;
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  let valid = 0;
  for (let i = 0; i < count; i += 1) {
    const u = array[i * stride];
    const v = array[i * stride + 1];
    if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
    valid += 1;
    minU = Math.min(minU, u);
    minV = Math.min(minV, v);
    maxU = Math.max(maxU, u);
    maxV = Math.max(maxV, v);
  }
  if (valid < 3) return false;
  return Math.abs(maxU - minU) > 1e-8 || Math.abs(maxV - minV) > 1e-8;
}

function chooseUVAttribute(geometry, preferUv2) {
  const { uv0, uv1, uv2, uv3 } = getBaseUVs(geometry);
  const candidates = [uv0, uv1, uv2, uv3];

  if (Number.isInteger(preferUv2) && preferUv2 >= 0 && preferUv2 <= 3) {
    if (candidates[preferUv2]) return candidates[preferUv2];
    return candidates.find(Boolean) || null;
  }

  if (preferUv2) {
    const preferredOrder = [1, 2, 3, 0];
    let preferredIndex = -1;
    for (const index of preferredOrder) {
      if (candidates[index]) {
        preferredIndex = index;
        break;
      }
    }
    if (preferredIndex === -1) return null;

    const preferredAttribute = candidates[preferredIndex];
    const preferredVaries = hasUVVariation(preferredAttribute);
    const preferredScore = scoreUVAttribute(preferredAttribute);

    let bestScored = null;
    for (let index = 0; index < candidates.length; index += 1) {
      const attribute = candidates[index];
      if (!attribute) continue;
      const score = scoreUVAttribute(attribute);
      if (score < 0) continue;
      if (!bestScored || score > bestScored.score) {
        bestScored = { index, attribute, score };
      }
    }

    if (bestScored && bestScored.index !== preferredIndex) {
      const shouldFallback =
        !preferredVaries ||
        preferredScore < 0 ||
        (bestScored.score >= LIVERY_UV_MIN_CONFIDENCE &&
          bestScored.score - Math.max(preferredScore, 0) >= LIVERY_UV_FALLBACK_MARGIN);
      if (shouldFallback) return bestScored.attribute;
    }

    return preferredAttribute;
  }

  if (uv0) return uv0;
  if (uv1) return uv1;
  if (uv2) return uv2;
  if (uv3) return uv3;
  return null;
}

function applyTextureUVSet(geometry, preferUv2) {
  if (!geometry) return false;
  const chosen = userTextureUvAttribute(geometry, chooseUVAttribute(geometry, preferUv2));
  if (!chosen) return false;
  if (geometry.attributes.uv !== chosen) {
    geometry.setAttribute("uv", chosen);
    geometry.attributes.uv.needsUpdate = true;
  }
  return true;
}

function restoreBaseUVs(geometry) {
  if (!geometry) return;
  const { uv0 } = getBaseUVs(geometry);
  if (uv0 && geometry.attributes.uv !== uv0) {
    geometry.setAttribute("uv", uv0);
    geometry.attributes.uv.needsUpdate = true;
  }
}

function generateBoxProjectionUVs(geometry) {
  if (!geometry) return;
  if (!geometry.userData) geometry.userData = {};
  if (geometry.userData.boxUvAttribute) {
    if (geometry.attributes.uv !== geometry.userData.boxUvAttribute) {
      geometry.setAttribute("uv", geometry.userData.boxUvAttribute);
      geometry.attributes.uv.needsUpdate = true;
    }
    return;
  }
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bbox = geometry.boundingBox;
  const size = new THREE.Vector3();
  bbox.getSize(size);

  const positions = geometry.attributes.position;
  const normals = geometry.attributes.normal;
  const uvs = new Float32Array(positions.count * 2);

  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i);
    const y = positions.getY(i);
    const z = positions.getZ(i);

    let u, v;

    if (normals) {
      const nx = Math.abs(normals.getX(i));
      const ny = Math.abs(normals.getY(i));
      const nz = Math.abs(normals.getZ(i));

      if (nx >= ny && nx >= nz) {
        u = (z - bbox.min.z) / (size.z || 1);
        v = (y - bbox.min.y) / (size.y || 1);
      } else if (ny >= nx && ny >= nz) {
        u = (x - bbox.min.x) / (size.x || 1);
        v = (z - bbox.min.z) / (size.z || 1);
      } else {
        u = (x - bbox.min.x) / (size.x || 1);
        v = (y - bbox.min.y) / (size.y || 1);
      }
    } else {
      u = (x - bbox.min.x) / (size.x || 1);
      v = (y - bbox.min.y) / (size.y || 1);
    }

    uvs[i * 2] = u;
    uvs[i * 2 + 1] = v;
  }

  const attribute = new THREE.BufferAttribute(uvs, 2);
  geometry.userData.boxUvAttribute = attribute;
  geometry.setAttribute("uv", attribute);
}

function getMaterialNames(material) {
  if (!material) return [];
  if (Array.isArray(material)) {
    return material
      .map((mat) => mat?.name?.trim())
      .filter((name) => typeof name === "string" && name.length > 0);
  }
  const name = material.name?.trim();
  return name ? [name] : [];
}

function normalizeTemplatePartNames(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((entry) => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean),
  )];
}

function ensureMeshLabel(child) {
  if (!child.isMesh) return "";
  const existing = child.userData?.meshLabel;
  if (existing) return existing;
  const name = child.name?.trim();
  if (name) {
    child.userData.meshLabel = name;
    return name;
  }
  const label = `mesh-${child.id}`;
  child.userData.meshLabel = label;
  return label;
}

function getMeshMeta(child) {
  if (!child?.isMesh) {
    return {
      baseMaterial: null,
      meshLabel: "",
      materialNames: [],
      searchNames: [],
      targetSet: new Set(),
      isGlass: false,
      slotRole: null,
    };
  }
  const baseMaterial = child.userData?.baseMaterial || child.material;
  const cached = child.userData?.textureMeta;
  if (cached && cached.baseMaterial === baseMaterial) return cached;

  const meshLabel = ensureMeshLabel(child);
  const materialNames = getMaterialNames(baseMaterial);
  const textureRefNames = Object.values(child.userData?.textureRefs || {}).filter(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
  const searchNames = [meshLabel, ...materialNames, ...textureRefNames];
  const targetSet = new Set(materialNames.map((name) => `${MATERIAL_TARGET_PREFIX}${name}`));
  targetSet.add(`${MESH_TARGET_PREFIX}${meshLabel}`);
  const labelLower = meshLabel.toLowerCase();
  const isGlass = materialNames.some((name) => {
    const lower = name.toLowerCase();
    return lower.includes("glass") || lower.includes("window") || lower.includes("vehglass");
  }) || labelLower.includes("glass") || labelLower.includes("window");

  const layerSlot = resolvePaintLayerSlot(child.userData?.nativeMaterial || child.userData?.gtaShader);
  const slotLocked = layerSlot !== undefined;
  const slotRole = slotLocked ? layerSlot : detectVehicleColorSlot(searchNames, isGlass);
  const meta = { baseMaterial, meshLabel, materialNames, searchNames, targetSet, isGlass, slotRole, slotLocked };
  child.userData.textureMeta = meta;
  return meta;
}

function shouldPreferLiveryUvForTarget(textureTarget) {
  if (!textureTarget || textureTarget === ALL_TARGET || textureTarget === "none") return false;
  const raw = textureTarget.toString().trim().toLowerCase();
  if (!raw) return false;
  return (
    raw.includes("vehicle_paint") ||
    raw.includes("carpaint") ||
    raw.includes("car_paint") ||
    raw.includes("car-paint") ||
    raw.includes("livery") ||
    raw.includes("vehicle_sign") ||
    raw.includes("sign_1") ||
    raw.includes("sign-1") ||
    raw.includes("sign1") ||
    raw.includes("vehicle_decal") ||
    raw.includes("decal") ||
    raw.includes("logo") ||
    raw.includes("wrap")
  );
}

function matchesTextureTarget(child, textureTarget) {
  if (Array.isArray(textureTarget)) {
    return textureTarget.some((target) => matchesTextureTarget(child, target));
  }
  if (textureTarget === "none") return false;
  if (!textureTarget || textureTarget === ALL_TARGET) return true;
  if (
    textureTarget.startsWith(MATERIAL_TARGET_PREFIX) ||
    textureTarget.startsWith(MESH_TARGET_PREFIX)
  ) {
    const meta = getMeshMeta(child);
    return meta.targetSet.has(textureTarget);
  }
  return true;
}

function isGlassMaterial(child) {
  if (!child.isMesh) return false;
  return getMeshMeta(child).isGlass;
}

function shouldShowExterior(child, textureTarget, matchesTarget) {
  const meta = getMeshMeta(child);
  if (meta.isGlass) return false;

  const names = [meta.meshLabel, ...meta.materialNames];
  const hasExcludedToken = names.some(matchesExteriorExcludedName);
  if (hasExcludedToken) return false;

  const hasIncludedToken = names.some(matchesExteriorIncludedName);
  if (hasIncludedToken) return true;

  if (matchesTarget && textureTarget !== ALL_TARGET) return true;
  return false;
}

function shouldShowExteriorDual(
  child,
  vehicleTarget,
  matchesVehicle,
  windowTarget,
  matchesWindow,
) {
  if (matchesWindow && windowTarget && windowTarget !== ALL_TARGET) {
    // Exterior-only must stay shell-only, even when a manual window target exists.
    return false;
  }
  return shouldShowExterior(child, vehicleTarget, matchesVehicle);
}

function matchesExteriorIncludedName(name) {
  if (!name) return false;
  const raw = name.toString().trim().toLowerCase();
  if (!raw) return false;
  return EXTERIOR_INCLUDE_TOKENS.some((token) => raw.includes(token));
}

function matchesExteriorExcludedName(name) {
  if (!name) return false;
  const raw = name.toString().trim().toLowerCase();
  if (!raw) return false;
  return EXTERIOR_EXCLUDE_TOKENS.some((token) => raw.includes(token));
}

function collectTextureTargets(object) {
  const materialNames = new Set();
  const meshNames = new Set();
  const meshes = getMeshList(object);

  for (const child of meshes) {
    const baseMaterial = child.userData?.baseMaterial || child.material;
    const names = getMaterialNames(baseMaterial);
    names.forEach((name) => materialNames.add(name));
    meshNames.add(ensureMeshLabel(child));
  }

  const targets = [];
  if (materialNames.size > 0) {
    Array.from(materialNames)
      .sort()
      .forEach((name) => {
        targets.push({ value: `${MATERIAL_TARGET_PREFIX}${name}`, label: `Material: ${name}` });
      });
  } else {
    Array.from(meshNames)
      .sort()
      .forEach((name) => {
        targets.push({ value: `${MESH_TARGET_PREFIX}${name}`, label: `Mesh: ${name}` });
      });
  }

  return targets;
}

function findLiveryTarget(object) {
  let best = null;
  const meshes = getMeshList(object);

  for (const child of meshes) {
    const meta = getMeshMeta(child);
    meta.materialNames.forEach((name) => {
      const score = scoreLiveryName(name);
      if (score <= 0) return;
      const candidate = makeLiveryCandidate(name, "material", score);
      if (isBetterLiveryCandidate(candidate, best)) {
        best = candidate;
      }
    });

    const meshLabel = meta.meshLabel;
    const meshScore = scoreLiveryName(meshLabel);
    if (meshScore > 0) {
      const candidate = makeLiveryCandidate(meshLabel, "mesh", meshScore);
      if (isBetterLiveryCandidate(candidate, best)) {
        best = candidate;
      }
    }
  }

  if (!best) return null;
  return { value: best.value, label: best.label };
}

function findWindowTemplateTarget(object) {
  let best = null;
  const meshes = getMeshList(object);

  for (const child of meshes) {
    const meta = getMeshMeta(child);
    meta.materialNames.forEach((name) => {
      const score = scoreWindowTemplateName(name);
      if (score <= 0) return;
      const candidate = makeLiveryCandidate(name, "material", score);
      if (isBetterLiveryCandidate(candidate, best)) {
        best = candidate;
      }
    });

    const meshLabel = meta.meshLabel;
    const meshScore = scoreWindowTemplateName(meshLabel);
    if (meshScore > 0) {
      const candidate = makeLiveryCandidate(meshLabel, "mesh", meshScore);
      if (isBetterLiveryCandidate(candidate, best)) {
        best = candidate;
      }
    }
  }

  if (!best) return null;
  return { value: best.value, label: best.label };
}

function scoreWindowTemplateName(name) {
  if (!name) return 0;
  const raw = name.toString().trim().toLowerCase();
  if (!raw) return 0;

  if (raw.includes("sign_2") || raw.includes("sign-2") || raw.includes("sign2")) return 120;
  if (raw.includes("sign_3") || raw.includes("sign-3") || raw.includes("sign3")) return 110;

  const tokens = tokenizeName(raw);
  const tokenSet = new Set(tokens);
  if (tokenSet.has("sign") && tokenSet.has("2")) return 120;
  if (tokenSet.has("sign") && tokenSet.has("3")) return 110;

  if (raw.includes("vehglass") || raw.includes("vehicle_vehglass")) return 100;

  if (raw.includes("window")) return 70;
  if (raw.includes("glass")) return 60;

  return 0;
}

function scoreLiveryName(name) {
  if (!name) return 0;
  const raw = name.toString().trim().toLowerCase();
  if (!raw) return 0;

  const vehiclePaintIndexMatch = raw.match(/vehicle[_-]?paint[_-]?(\d+)/);
  if (vehiclePaintIndexMatch) {
    const index = Number.parseInt(vehiclePaintIndexMatch[1], 10);
    if (Number.isFinite(index)) return 140 + Math.max(0, Math.min(index, 99));
    return 140;
  }

  if (raw.includes("vehicle_paint") || raw.includes("carpaint") || raw.includes("car_paint") || raw.includes("car-paint")) return 130;
  if (raw.includes("livery")) return 110;

  if (raw.includes("vehicle_sign") || raw.includes("sign_1") || raw.includes("sign-1") || raw.includes("sign1")) return 95;
  if (raw.includes("sign_2") || raw.includes("sign-2") || raw.includes("sign2")) return 85;
  if (raw.includes("sign_3") || raw.includes("sign-3") || raw.includes("sign3")) return 75;

  if (raw.includes("vehicle_decal")) return 90;

  const tokens = tokenizeName(raw);
  const tokenSet = new Set(tokens);

  if (tokenSet.has("sign") && tokenSet.has("1")) return 95;
  if (tokenSet.has("sign") && tokenSet.has("2")) return 85;
  if (tokenSet.has("sign") && tokenSet.has("3")) return 75;
  if (tokenSet.has("sign")) return 65;

  if (raw.includes("decal") || tokenSet.has("decal") || tokenSet.has("decals")) return 55;
  if (raw.includes("logo") || tokenSet.has("logo") || tokenSet.has("logos")) return 50;
  if (raw.includes("wrap") || tokenSet.has("wrap")) return 45;

  if (raw.startsWith("material_") && !raw.includes("glass") && !raw.includes("tire") && !raw.includes("interior")) return 30;

  return 0;
}

function tokenizeName(raw) {
  return raw.replace(LIVERY_TOKEN_SPLIT, " ").trim().split(" ").filter(Boolean);
}

function makeLiveryCandidate(name, type, baseScore) {
  const isMaterial = type === "material";
  return {
    value: `${isMaterial ? MATERIAL_TARGET_PREFIX : MESH_TARGET_PREFIX}${name}`,
    label: `${isMaterial ? "Material" : "Mesh"}: ${name}`,
    score: baseScore + (isMaterial ? 5 : 0),
    isMaterial,
  };
}

function isBetterLiveryCandidate(candidate, best) {
  if (!best) return true;
  if (candidate.score !== best.score) return candidate.score > best.score;
  if (candidate.isMaterial !== best.isMaterial) return candidate.isMaterial;
  return candidate.label.localeCompare(best.label) < 0;
}
