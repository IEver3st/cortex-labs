import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import { DDSLoader } from "three/examples/jsm/loaders/DDSLoader";
import { TGALoader } from "three/examples/jsm/loaders/TGALoader";
import { DFFLoader } from "dff-loader";
import { invoke } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import { parseYft } from "../lib/yft";
import { parseClmesh } from "../lib/clmesh.js";
import { parseDDS } from "../lib/dds";
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
  createFloorGrid,
  normalizeLoadedMeshes,
  setupWasdControls,
  setupWheelWhileDragging,
  buildCageOverlay,
  disposeCageOverlay,
  loadTextureFromPath as loadTextureFromPathShared,
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
import { isTemplateMarkerModifierPressed } from "../lib/template-marker-utils.js";
import {
  applyShadowFlags,
  configureShadowLight,
  createShadowReceiver,
  disposeShadowReceiver,
  renderWithEffects,
  updateShadowReceiver,
  updateDirectionalShadowFrustum,
} from "../lib/viewer-render-effects.js";
import { stabilizeObjectForWorld } from "../lib/model-normalization.js";
import {
  applyNativeManifestToMeshes,
  summarizeNativeMaterialMeshes,
} from "../lib/native-material-plan.js";
import { loadNativeMaterialView } from "../lib/native-materials.js";

const defaultBody = "#dfe4ea";
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
const TEXTURE_CACHE_LIMIT = 16;
const textureCache = new Map();
const MODEL_CACHE_LIMIT = 4;
const modelCache = new Map();
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

function buildVehicleSlotColors(baseColor = defaultBody) {
  const resolved = baseColor || defaultBody;
  return {
    primary: resolved,
    secondary: resolved,
    accent: resolved,
    glass: resolved,
  };
}

function normalizeVehicleSlotColors(slotColors, baseColor = defaultBody) {
  const fallback = buildVehicleSlotColors(baseColor);
  if (!slotColors || typeof slotColors !== "object") return fallback;
  return {
    primary: slotColors.primary || fallback.primary,
    secondary: slotColors.secondary || fallback.secondary,
    accent: slotColors.accent || fallback.accent,
    glass: slotColors.glass || fallback.glass,
  };
}

function getVehicleSlotColor(slotColors, slot) {
  const fallbackOrder = {
    primary: ["primary"],
    secondary: ["secondary", "primary"],
    accent: ["accent", "secondary", "primary"],
    glass: ["glass", "primary"],
  };
  const keys = fallbackOrder[slot] || fallbackOrder.primary;
  for (const key of keys) {
    const value = slotColors?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return defaultBody;
}

function detectVehicleColorSlot(names, isGlass) {
  if (isGlass) return "glass";
  const raw = names
    .map((name) => (typeof name === "string" ? name.trim().toLowerCase() : ""))
    .filter(Boolean)
    .join(" ");

  if (!raw) return null;

  if (
    /vehicle[_-]?paint[_-]?2\b/.test(raw) ||
    /car[_-]?paint[_-]?2\b/.test(raw) ||
    /\bcarpaint2\b/.test(raw) ||
    /\bsecondary\b/.test(raw)
  ) {
    return "secondary";
  }

  if (
    /vehicle[_-]?paint[_-]?[3-9]\d*\b/.test(raw) ||
    /car[_-]?paint[_-]?[3-9]\d*\b/.test(raw) ||
    /\bcarpaint[3-9]\d*\b/.test(raw) ||
    raw.includes("vehicle_lightsemissive") ||
    raw.includes("vehicle_lights") ||
    raw.includes("lightsemissive") ||
    raw.includes("lightbar") ||
    raw.includes("emissive") ||
    raw.includes("siren") ||
    raw.includes("beacon") ||
    raw.includes("vehicle_detail") ||
    raw.includes("vehicle_badge") ||
    raw.includes("vehicle_badges") ||
    raw.includes("badge") ||
    raw.includes("accent") ||
    raw.includes("trim")
  ) {
    return "accent";
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

function getTextureCacheKey(path, flipY, reloadToken) {
  if (!path) return "";
  const normalized = path.toString();
  const token = Number.isFinite(reloadToken) ? reloadToken : 0;
  return `${normalized}::${flipY ? "fy" : "nf"}::${token}`;
}

function touchTextureCache(key) {
  const entry = textureCache.get(key);
  if (!entry) return null;
  textureCache.delete(key);
  textureCache.set(key, entry);
  return entry.texture;
}

function getCachedTexture(key) {
  if (!key) return null;
  return touchTextureCache(key);
}

function pruneTextureCache() {
  if (textureCache.size <= TEXTURE_CACHE_LIMIT) return;
  for (const [key, entry] of textureCache) {
    if (textureCache.size <= TEXTURE_CACHE_LIMIT) break;
    if (entry.refs > 0) continue;
    textureCache.delete(key);
    entry.texture.dispose?.();
  }
}

function cacheTexture(key, texture) {
  if (!key || !texture) return;
  const existing = textureCache.get(key);
  if (existing && existing.texture !== texture) {
    existing.texture.dispose?.();
  }
  const refs = existing?.refs || 0;
  textureCache.delete(key);
  texture.userData = texture.userData || {};
  texture.userData.cacheKey = key;
  textureCache.set(key, { texture, refs });
  pruneTextureCache();
}

function retainTexture(texture) {
  if (!texture) return;
  const key = texture.userData?.cacheKey;
  if (!key) return;
  const entry = textureCache.get(key);
  if (!entry) return;
  entry.refs = (entry.refs || 0) + 1;
}

function releaseTexture(texture) {
  if (!texture) return;
  const key = texture.userData?.cacheKey;
  if (!key) {
    texture.dispose?.();
    return;
  }
  const entry = textureCache.get(key);
  if (!entry) {
    texture.dispose?.();
    return;
  }
  entry.refs = Math.max(0, (entry.refs || 0) - 1);
}

function touchModelCache(key) {
  const entry = modelCache.get(key);
  if (!entry) return null;
  modelCache.delete(key);
  modelCache.set(key, entry);
  return entry.template;
}

function getCachedModelTemplate(path) {
  if (!path) return null;
  return touchModelCache(path.toString());
}

function pruneModelCache() {
  while (modelCache.size > MODEL_CACHE_LIMIT) {
    const [oldestKey, oldestEntry] = modelCache.entries().next().value || [];
    if (!oldestKey) break;
    modelCache.delete(oldestKey);
    disposeObject(oldestEntry?.template);
  }
}

function cacheModelTemplate(path, template) {
  if (!path || !template) return;
  const key = path.toString();
  const existing = modelCache.get(key);
  if (existing?.template && existing.template !== template) {
    disposeObject(existing.template);
  }
  modelCache.delete(key);
  modelCache.set(key, { template });
  pruneModelCache();
}

function cloneCachedModelTemplate(template) {
  if (!template) return null;
  const clone = template.clone(true);
  clone.traverse((child) => {
    if (!child?.isMesh) return;
    if (child.geometry?.clone) {
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
  slotColors,
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
  flipTextureY = true,
  wasdEnabled = false,
  showGrid = false,
  lightIntensity = 1.0,
  lightAzimuth = 54,
  lightElevation = 46,
  glossiness = 0.5,
  shadowsEnabled = false,
  materialType = "paint",
  materialLightIntensity = 1.0,
  materialGlossiness = 0.62,
  materialRoughness = 0.28,
  materialClearcoat = 0.72,
  materialTexturePath = "",
  nativeMaterialsEnabled = false,
  nativeMaterialsReloadToken = 0,
  onReady,
  onModelInfo,
  onModelError,
  onModelLoading,
  onTextureReload,
  onTextureError,
  onWindowTextureError,
  onFormatWarning,
  onNativeMaterialsStatus,
  isActive = true,
  includeTemplateGeometry = false,
  templateMarkerPickModifier = "alt",
  onTemplateMarkerUvHover,
  onTemplateMarkerUvLeave,
  onTemplateMarkerUvPick,
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
  const shadowReceiverRef = useRef(null);
  const gridRef = useRef(null);
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
  const onModelInfoRef = useRef(onModelInfo);
  const onModelErrorRef = useRef(onModelError);
  const onModelLoadingRef = useRef(onModelLoading);
  const onTextureErrorRef = useRef(onTextureError);
  const onWindowTextureErrorRef = useRef(onWindowTextureError);
  const onFormatWarningRef = useRef(onFormatWarning);
  const onNativeMaterialsStatusRef = useRef(onNativeMaterialsStatus);
  const onTemplateMarkerUvHoverRef = useRef(onTemplateMarkerUvHover);
  const onTemplateMarkerUvLeaveRef = useRef(onTemplateMarkerUvLeave);
  const onTemplateMarkerUvPickRef = useRef(onTemplateMarkerUvPick);
  const templateMarkerPickModifierRef = useRef(templateMarkerPickModifier);
  const templatePartPickEnabledRef = useRef(templatePartPickEnabled);
  const onTemplatePartHoverRef = useRef(onTemplatePartHover);
  const onTemplatePartLeaveRef = useRef(onTemplatePartLeave);
  const onTemplatePartPickRef = useRef(onTemplatePartPick);
  const isActiveRef = useRef(isActive);
  const shadowsEnabledRef = useRef(shadowsEnabled);
  const materialStateRef = useRef({});
  const markerPickStateRef = useRef({
    pointerId: null,
    startX: 0,
    startY: 0,
    moved: false,
    controlsDisabled: false,
  });
  const cameraStateRef = useRef({
    presetKey: DEFAULT_CAMERA_PRESET,
    zoomFactor: 1,
  });
  const [modelVersion, setModelVersion] = useState(0);

  const resolvedBodyColor = bodyColor || defaultBody;
  const resolvedSlotColors = useMemo(
    () => normalizeVehicleSlotColors(slotColors, resolvedBodyColor),
    [slotColors, resolvedBodyColor],
  );

  const textureLoader = useMemo(() => new THREE.TextureLoader(), []);
  const isTauriRuntime = isTauriRuntimeAvailable();

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

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
    onTemplateMarkerUvHoverRef.current = onTemplateMarkerUvHover;
    onTemplateMarkerUvLeaveRef.current = onTemplateMarkerUvLeave;
    onTemplateMarkerUvPickRef.current = onTemplateMarkerUvPick;
  }, [onTemplateMarkerUvHover, onTemplateMarkerUvLeave, onTemplateMarkerUvPick]);

  useEffect(() => {
    templateMarkerPickModifierRef.current = templateMarkerPickModifier;
  }, [templateMarkerPickModifier]);

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

  useEffect(() => {
    isActiveRef.current = isActive;
    if (isActive) {
      requestRenderRef.current?.();
    }
  }, [isActive]);

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
    scene.add(overlayGroup);
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
    const materialConfig = {
      type: materialType,
      lightIntensity: materialLightIntensity,
      glossiness: materialGlossiness,
      roughness: materialRoughness,
      clearcoat: materialClearcoat,
    };
    materialStateRef.current = {
      bodyColor: resolvedBodyColor,
      slotColors: resolvedSlotColors,
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
      modelRef.current.userData.slotColors = resolvedSlotColors;
      modelRef.current.userData.nativeMaterialsEnabled = Boolean(nativeMaterialsEnabled);
    }
  }, [
    resolvedBodyColor,
    resolvedSlotColors,
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
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    const getPixelRatio = () => Math.min(window.devicePixelRatio || 1, 1.5);
    renderer.setPixelRatio(getPixelRatio());
    renderer.setClearColor(new THREE.Color(backgroundColor || "#141414"), 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = Boolean(shadowsEnabled);
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    camera.position.set(2.4, 1.2, 2.8);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
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
    configureShadowLight(key, shadowsEnabled);
    const shadowReceiver = createShadowReceiver();

    lightsRef.current = { ambient, key, rim };
    shadowReceiverRef.current = shadowReceiver;
    scene.add(ambient, key, rim, shadowReceiver);

    renderer.domElement.addEventListener("contextmenu", (event) => {
      event.preventDefault();
    });

    containerRef.current.appendChild(renderer.domElement);

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;
    controlsRef.current = controls;
    setSceneReady(true);

    let frameId = 0;
    let isRendering = false;
    let renderRequested = false;
    const lastViewport = { width: 0, height: 0, pixelRatio: 0 };
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
        maxDistance: Math.max(framing.baseDistance * 10, 10),
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

      if (lightsRef.current.key?.castShadow) {
        updateDirectionalShadowFrustum(lightsRef.current.key, framing.distance);
      }

      if (shouldRequestRender) requestRenderRef.current?.();
    };

    const canRenderFrame = () => {
      if (!isActiveRef.current) return false;
      const container = containerRef.current;
      return Boolean(container && container.clientWidth > 0 && container.clientHeight > 0);
    };

    const renderFrame = () => {
      frameId = 0;
      if (!canRenderFrame()) {
        isRendering = false;
        return;
      }
      const needsUpdate = controls.update();
      updateShadowReceiver(shadowReceiverRef.current, {
        bounds: fitRef.current?.bounds,
        camera,
        enabled: shadowsEnabledRef.current,
      });
      renderWithEffects({
        renderer,
        scene,
        camera,
      });
      if (renderRequested || needsUpdate) {
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

    const restoreMarkerPickControls = () => {
      if (!markerPickStateRef.current.controlsDisabled) return;
      markerPickStateRef.current.controlsDisabled = false;
      controls.enabled = true;
    };

    const isMarkerPickingEnabled = () =>
      Boolean(
        onTemplateMarkerUvHoverRef.current ||
          onTemplateMarkerUvLeaveRef.current ||
          onTemplateMarkerUvPickRef.current,
      );

    const isPartPickingEnabled = () =>
      Boolean(
        templatePartPickEnabledRef.current &&
          (onTemplatePartHoverRef.current ||
            onTemplatePartLeaveRef.current ||
            onTemplatePartPickRef.current),
      );

    const isTemplatePickingEnabled = () =>
      isMarkerPickingEnabled() || isPartPickingEnabled();

    const clearMarkerHover = () => {
      renderer.domElement.style.cursor = "";
      onTemplateMarkerUvLeaveRef.current?.();
      onTemplatePartLeaveRef.current?.();
    };

    const getTemplatePickHit = (event, markerOnly = false) => {
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
        if (markerOnly && !object.userData?.templateMarkerInteractive) continue;
        const uv = intersection?.uv;
        if (markerOnly && (!uv || !Number.isFinite(uv.x) || !Number.isFinite(uv.y))) continue;
        return {
          uv:
            uv && Number.isFinite(uv.x) && Number.isFinite(uv.y)
              ? { x: uv.x, y: uv.y }
              : null,
          meshName: object.userData?.meshLabel || object.name || "",
          materialName: object.material?.name || object.userData?.baseMaterial?.name || "",
        };
      }
      return null;
    };

    const handleMarkerPointerMove = (event) => {
      if (!isTemplatePickingEnabled()) return;
      const partPicking = isPartPickingEnabled();
      const modifierActive = isTemplateMarkerModifierPressed(
        event,
        templateMarkerPickModifierRef.current,
      );
      if (!partPicking && !modifierActive) {
        clearMarkerHover();
        restoreMarkerPickControls();
        return;
      }

      const hit = getTemplatePickHit(event, !partPicking);
      renderer.domElement.style.cursor = hit ? "pointer" : "crosshair";
      if (hit && partPicking) {
        onTemplatePartHoverRef.current?.(hit);
      } else if (hit) {
        onTemplateMarkerUvHoverRef.current?.(hit);
      } else if (partPicking) {
        onTemplatePartLeaveRef.current?.();
      } else {
        onTemplateMarkerUvLeaveRef.current?.();
      }

      if (markerPickStateRef.current.pointerId !== null) {
        const distance = Math.hypot(
          Number(event.clientX) - markerPickStateRef.current.startX,
          Number(event.clientY) - markerPickStateRef.current.startY,
        );
        if (distance > 6) {
          markerPickStateRef.current.moved = true;
        }
      }

      if (!partPicking) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    const handleMarkerPointerDown = (event) => {
      if (!isTemplatePickingEnabled()) return;
      if (event.button !== 0) return;
      const partPicking = isPartPickingEnabled();
      if (
        !partPicking &&
        !isTemplateMarkerModifierPressed(event, templateMarkerPickModifierRef.current)
      ) {
        return;
      }

      markerPickStateRef.current.pointerId = event.pointerId ?? null;
      markerPickStateRef.current.startX = Number(event.clientX) || 0;
      markerPickStateRef.current.startY = Number(event.clientY) || 0;
      markerPickStateRef.current.moved = false;
      markerPickStateRef.current.controlsDisabled = !partPicking;
      if (!partPicking) controls.enabled = false;

      const hit = getTemplatePickHit(event, !partPicking);
      renderer.domElement.style.cursor = hit ? "pointer" : "crosshair";
      if (hit && partPicking) {
        onTemplatePartHoverRef.current?.(hit);
      } else if (hit) {
        onTemplateMarkerUvHoverRef.current?.(hit);
      } else if (partPicking) {
        onTemplatePartLeaveRef.current?.();
      } else {
        onTemplateMarkerUvLeaveRef.current?.();
      }

      if (!partPicking) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    const handleMarkerPointerUp = (event) => {
      if (!isTemplatePickingEnabled()) return;
      const state = markerPickStateRef.current;
      if (state.pointerId !== null && event.pointerId !== state.pointerId) return;
      const partPicking = isPartPickingEnabled();

      if (
        !partPicking &&
        !isTemplateMarkerModifierPressed(event, templateMarkerPickModifierRef.current)
      ) {
        state.pointerId = null;
        state.moved = false;
        restoreMarkerPickControls();
        clearMarkerHover();
        return;
      }

      const hit = getTemplatePickHit(event, !partPicking);
      renderer.domElement.style.cursor = hit ? "pointer" : "crosshair";

      if (!state.moved && hit && partPicking) {
        onTemplatePartPickRef.current?.(hit);
      } else if (!state.moved && hit) {
        onTemplateMarkerUvPickRef.current?.(hit);
      } else if (!hit && partPicking) {
        onTemplatePartLeaveRef.current?.();
      } else if (!hit) {
        onTemplateMarkerUvLeaveRef.current?.();
      }

      state.pointerId = null;
      state.moved = false;
      restoreMarkerPickControls();
      if (!partPicking) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    const handleMarkerPointerCancel = () => {
      if (!isTemplatePickingEnabled()) return;
      markerPickStateRef.current.pointerId = null;
      markerPickStateRef.current.moved = false;
      restoreMarkerPickControls();
      clearMarkerHover();
    };

    renderer.domElement.addEventListener("pointerdown", handleMarkerPointerDown, true);
    renderer.domElement.addEventListener("pointermove", handleMarkerPointerMove, true);
    renderer.domElement.addEventListener("pointerup", handleMarkerPointerUp, true);
    renderer.domElement.addEventListener("pointerleave", handleMarkerPointerCancel, true);
    renderer.domElement.addEventListener("pointercancel", handleMarkerPointerCancel, true);

    const applyResize = () => {
      if (!containerRef.current) return;
      const { clientWidth, clientHeight } = containerRef.current;
      if (clientWidth === 0 || clientHeight === 0) return;
      const pixelRatio = getPixelRatio();
      if (
        clientWidth === lastViewport.width &&
        clientHeight === lastViewport.height &&
        pixelRatio === lastViewport.pixelRatio
      ) {
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
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
      if (fitRef.current?.bounds) {
        applyCameraFrame(cameraStateRef.current.presetKey, cameraStateRef.current.zoomFactor, false);
      }
      if (!isActiveRef.current) return;
      const needsUpdate = controls.update();
      renderWithEffects({
        renderer,
        scene,
        camera,
      });
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

    controls.addEventListener("start", requestRenderFrame);
    controls.addEventListener("change", requestRenderFrame);
    controls.addEventListener("end", requestRenderFrame);

    requestRenderFrame();

    onReadyRef.current?.({
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

        if (lightsRef.current.key?.castShadow) {
          updateDirectionalShadowFrustum(lightsRef.current.key, restored.distance);
        }

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
            break;
        }
        requestRenderRef.current?.();
      },
      captureScreenshot: () => {
        if (!rendererRef.current || !sceneRef.current || !cameraRef.current) return null;
        // Render a fresh frame and capture it
        renderWithEffects({
          renderer: rendererRef.current,
          scene: sceneRef.current,
          camera: cameraRef.current,
        });
        return rendererRef.current.domElement.toDataURL("image/png");
      },
      getPresetKeys: () => CAMERA_PRESET_KEYS,
    });

    return () => {
      if (frameId) cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointerdown", handleMarkerPointerDown, true);
      renderer.domElement.removeEventListener("pointermove", handleMarkerPointerMove, true);
      renderer.domElement.removeEventListener("pointerup", handleMarkerPointerUp, true);
      renderer.domElement.removeEventListener("pointerleave", handleMarkerPointerCancel, true);
      renderer.domElement.removeEventListener("pointercancel", handleMarkerPointerCancel, true);
      restoreMarkerPickControls();
      clearMarkerHover();
      controls.removeEventListener("start", requestRenderFrame);
      controls.removeEventListener("change", requestRenderFrame);
      controls.removeEventListener("end", requestRenderFrame);
      if (scene.background === backgroundTextureRef.current) {
        scene.background = null;
      }
      if (modelRef.current) {
        disposeObject(modelRef.current);
        modelRef.current = null;
      }
      backgroundTextureRef.current?.dispose?.();
      backgroundTextureRef.current = null;
      releaseTexture(textureRef.current);
      textureRef.current = null;
      releaseTexture(windowTextureRef.current);
      windowTextureRef.current = null;
      releaseTexture(materialTextureRef.current);
      materialTextureRef.current = null;
      disposeShadowReceiver(shadowReceiverRef.current);
      shadowReceiverRef.current = null;
      controls.dispose();
      renderer.dispose();
      renderer.domElement.removeEventListener("wheel", wheelWhileDragging);
      renderer.domElement.remove();
      setSceneReady(false);
      requestRenderRef.current = null;
    };
  }, []);

  useEffect(() => {
    const { ambient, key, rim } = lightsRef.current;
    if (ambient) ambient.intensity = 0.5 * lightIntensity;
    if (key) key.intensity = 0.9 * lightIntensity;
    if (rim) rim.intensity = 0.35 * lightIntensity;
    requestRenderRef.current?.();
  }, [lightIntensity]);

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
    if (shadowsEnabled) {
      updateDirectionalShadowFrustum(key, fitRef.current?.distance);
    }
    requestRenderRef.current?.();
  }, [lightAzimuth, lightElevation, shadowsEnabled]);

  useEffect(() => {
    const renderer = rendererRef.current;
    const { key } = lightsRef.current;
    if (!renderer || !key) return;

    renderer.shadowMap.enabled = Boolean(shadowsEnabled);
    configureShadowLight(key, shadowsEnabled);

    if (modelRef.current) {
      applyShadowFlags(modelRef.current, shadowsEnabled);
    }
    updateShadowReceiver(shadowReceiverRef.current, {
      bounds: fitRef.current?.bounds,
      camera: cameraRef.current,
      enabled: shadowsEnabled,
    });
    if (shadowsEnabled) {
      updateDirectionalShadowFrustum(key, fitRef.current?.distance);
    }

    requestRenderRef.current?.();
  }, [shadowsEnabled]);

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
    });
  }, [sceneReady, wasdEnabled]);

  useEffect(() => {
    if (!rendererRef.current) return;
    rendererRef.current.setClearColor(new THREE.Color(backgroundColor || "#141414"), 1);
    requestRender();
  }, [backgroundColor]);

  useEffect(() => {
    if (!sceneRef.current || !rendererRef.current) return;
    let cancelled = false;

    const clearBackground = () => {
      if (sceneRef.current?.background === backgroundTextureRef.current) {
        sceneRef.current.background = null;
      }
      backgroundTextureRef.current?.dispose?.();
      backgroundTextureRef.current = null;
      requestRender();
    };

    if (!backgroundImagePath) {
      clearBackground();
      return;
    }

    const loadBackground = async () => {
      let texture = null;
      try {
        texture = await loadTextureFromPathShared(backgroundImagePath, textureLoader, rendererRef.current);
      } catch {
        texture = null;
      }
      if (!texture) {
        clearBackground();
        return;
      }
      if (cancelled) {
        texture.dispose?.();
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
          texture.dispose();
          finalTexture = blurredTexture;
        }
      }

      backgroundTextureRef.current = finalTexture;
      sceneRef.current.background = finalTexture;
      if (previous && previous !== finalTexture) {
        previous.dispose?.();
      }
      requestRender();
    };

    loadBackground();

    return () => {
      cancelled = true;
    };
  }, [backgroundImagePath, backgroundImageReloadToken, backgroundImageBlur, textureLoader, requestRender]);

  useEffect(() => {
    if (!sceneReady || !sceneRef.current) return;
    if (showGrid && !gridRef.current) {
      const grid = createFloorGrid();
      sceneRef.current.add(grid);
      gridRef.current = grid;
      requestRender();
    } else if (!showGrid && gridRef.current) {
      sceneRef.current.remove(gridRef.current);
      gridRef.current.geometry?.dispose?.();
      gridRef.current.material?.dispose?.();
      gridRef.current = null;
      requestRender();
    }
  }, [showGrid, sceneReady, requestRender]);

  useEffect(() => {
    if (!sceneReady || !sceneRef.current) return;

    if (!modelPath) {
      if (modelRef.current) {
        sceneRef.current.remove(modelRef.current);
        disposeObject(modelRef.current);
        modelRef.current = null;
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

    const loadModel = async () => {
      onModelLoadingRef.current?.(true);
      let object = null;
      let templateSourceObject = null;
      let nativeMaterialSummary = { available: false };
      try {
        const extension = getFileExtension(modelPath);
        const shouldPreferBridgeYft = extension === "yft" && isTauriRuntime && !includeTemplateGeometry;
        const shouldBypassTemplateCache =
          includeTemplateGeometry && (extension === "yft" || extension === "ydd");
        const cachedTemplate =
          shouldPreferBridgeYft || shouldBypassTemplateCache ? null : getCachedModelTemplate(modelPath);
        let shouldCacheModelTemplate = !shouldPreferBridgeYft;
        if (cachedTemplate) {
          object = cloneCachedModelTemplate(cachedTemplate);
        }

        if (!object) {
          if (extension === "obj") {
            onModelErrorRef.current?.(
              "out of sheer respect for vehicle devs and those who pour their hearts and souls into their creations, .OBJ files will never be supported.",
            );
            return;
          }

          if (extension === "yft") {
            if (shouldPreferBridgeYft) {
              try {
                const bridgeResult = await invoke("parse_yft", { path: modelPath });
                if (cancelled) return;

                const meshPath = typeof bridgeResult?.meshPath === "string" ? bridgeResult.meshPath.trim() : "";
                const manifestPath = typeof bridgeResult?.manifestPath === "string" ? bridgeResult.manifestPath.trim() : "";
                if (meshPath) {
                  let meshBytes = null;
                  try {
                    meshBytes = await readFile(meshPath);
                  } catch {
                    meshBytes = null;
                  }

                  if (meshBytes) {
                    let bridgeMeshes = parseClmesh(meshBytes);
                    if (manifestPath) {
                      try {
                        const manifest = await readJsonFile(manifestPath);
                        bridgeMeshes = applyNativeManifestToMeshes(bridgeMeshes, manifest, manifestPath);
                        nativeMaterialSummary = summarizeNativeMaterialMeshes(bridgeMeshes);
                      } catch (error) {
                        console.warn("[YFT] Failed to read bridge manifest:", error);
                      }
                    }

                    if (bridgeMeshes?.length) {
                      object = buildClmeshObject(bridgeMeshes);
                      object.userData.sourceFormat = "yft";
                      if (!hasRenderableMeshes(object)) {
                        disposeObject(object);
                        object = null;
                      }
                    }
                  }
                }
              } catch (error) {
                console.warn("[YFT] Bridge load failed, falling back to JS parser:", error);
              }
            }

            if (!object) {
              let bytes = null;
              try {
                bytes = await readFile(modelPath);
              } catch {
                onModelErrorRef.current?.("Failed to read YFT file.");
                return;
              }
              if (cancelled) return;
              const name = getFileNameWithoutExtension(modelPath) || "yft_model";
              let drawable = null;
              try {
                drawable = parseYft(bytes, name);
              } catch (err) {
                console.error("[YFT] Parse error:", err);
                onModelErrorRef.current?.("YFT parsing failed.");
                return;
              }
              if (!drawable || !drawable.models?.length) {
                onModelErrorRef.current?.("YFT parsing returned no drawable data.");
                return;
              }

              object = buildDrawableObject(drawable, { useVertexColors: false });
              if (!hasRenderableMeshes(object)) {
                onModelErrorRef.current?.("YFT parsed but no mesh data was generated.");
                return;
              }
              shouldCacheModelTemplate = true;
            }
            object.userData.sourceFormat = "yft";

            if (shouldPreferBridgeYft) {
              try {
                const bytes = await readFile(modelPath);
                if (!cancelled) {
                  const name = getFileNameWithoutExtension(modelPath) || "yft_model";
                  const drawable = parseYft(bytes, name);
                  if (drawable?.models?.length) {
                    templateSourceObject = buildDrawableObject(drawable, { useVertexColors: false });
                    templateSourceObject.userData.sourceFormat = "yft";
                  }
                }
              } catch (error) {
                console.warn("[YFT] Template source fallback failed:", error);
              }
            }

          } else if (extension === "ydd") {
            let bytes = null;
            try {
              bytes = await readFile(modelPath);
            } catch {
              onModelErrorRef.current?.("Failed to read YDD file.");
              return;
            }
            if (cancelled) return;
            const name = getFileNameWithoutExtension(modelPath) || "ydd_model";
            let drawable = null;
            try {
              drawable = parseYft(bytes, name, YDD_SCAN_SETTINGS);
            } catch (err) {
              console.error("[YDD] Parse error:", err);
              onModelErrorRef.current?.("YDD parsing failed.");
              return;
            }
            if (!drawable || !drawable.models?.length) {
              onModelErrorRef.current?.("YDD parsing returned no drawable data.");
              return;
            }
            object = buildDrawableObject(drawable, { useVertexColors: false });
            if (!hasRenderableMeshes(object)) {
              onModelErrorRef.current?.("YDD parsed but no mesh data was generated.");
              return;
            }
            object.userData.sourceFormat = "ydd";

            if (includeTemplateGeometry) {
              try {
                const templateDrawable = parseYft(bytes, name, {
                  ...YDD_SCAN_SETTINGS,
                  includeAllDrawables: true,
                });
                if (templateDrawable?.models?.length) {
                  templateSourceObject = buildDrawableObject(templateDrawable, { useVertexColors: false });
                  templateSourceObject.userData.sourceFormat = "ydd";
                }
              } catch (error) {
                console.warn("[YDD] Full dictionary template source failed:", error);
              }
            }
          } else if (extension === "clmesh") {
            let bytes = null;
            try {
              bytes = await readFile(modelPath);
            } catch {
              onModelErrorRef.current?.("Failed to read mesh cache.");
              return;
            }
            if (cancelled) return;
            const meshes = parseClmesh(bytes);
            if (!meshes || meshes.length === 0) {
              onModelErrorRef.current?.("Mesh cache contained no meshes.");
              return;
            }
            object = buildClmeshObject(meshes);
          } else if (extension === "dff") {
            let bytes = null;
            try {
              bytes = await readFile(modelPath);
            } catch {
              return;
            }
            if (cancelled) return;
            const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            const loader = new DFFLoader();
            try {
              object = loader.parse(buffer);
            } catch {
              return;
            }
          } else {
            onModelErrorRef.current?.("Unsupported model format.");
            return;
          }

          if (!object) {
            onModelErrorRef.current?.("Model loaded with no geometry.");
            return;
          }

          normalizeLoadedMeshes(object);
          if (shouldCacheModelTemplate) {
            const modelTemplate = cloneCachedModelTemplate(object);
            if (modelTemplate) {
              cacheModelTemplate(modelPath, modelTemplate);
            }
          }
        }

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

        onModelInfoRef.current?.({
          targets,
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
        });

        if (templateSourceObject && templateSourceObject !== object) {
          disposeObject(templateSourceObject);
          templateSourceObject = null;
        }

        const box = new THREE.Box3().setFromObject(object);
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);

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
        sceneObject.userData.materialConfig = materialState.materialConfig || DEFAULT_MATERIAL_CONFIG;
        sceneObject.userData.materialDetailTexture = materialTextureRef.current || null;
        sceneObject.userData.slotColors = materialState.slotColors || buildVehicleSlotColors(materialState.bodyColor);
        sceneObject.userData.nativeMaterialsEnabled = Boolean(materialState.nativeMaterialsEnabled);
        applyShadowFlags(sceneObject, shadowsEnabled);

        if (modelRef.current) {
          disposeCageOverlay(sceneRef.current);
          sceneRef.current.remove(modelRef.current);
          disposeObject(modelRef.current);
        }

        modelRef.current = sceneObject;
        sceneRef.current.add(sceneObject);
        setModelVersion((version) => version + 1);

        const fitBox = computeFramingBounds(sceneObject, new THREE.Box3().setFromObject(sceneObject)) || box.clone();
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
          onModelErrorRef.current?.("Parsed model bounds are invalid.");
          return;
        }
        const maxDim = Math.max(size.x, size.y, size.z);
        if (!Number.isFinite(maxDim) || maxDim <= 0) {
          onModelErrorRef.current?.("Parsed model geometry is empty.");
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
          syncViewerCameraPose({
            camera: cameraRef.current,
            controls: controlsRef.current,
            position: framing.position,
            target: framing.target,
            up: framing.up,
            near: framing.near,
            far: framing.far,
            minDistance: Math.max(framing.baseDistance * 0.05, 0.1),
            maxDistance: Math.max(framing.baseDistance * 10, 10),
          });
        }

        if (shadowsEnabled) {
          updateDirectionalShadowFrustum(lightsRef.current.key, fitRef.current.distance);
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
          buildCageOverlay(sceneObject, sceneRef.current);
        }
        requestRender();
      } catch (error) {
        const message =
          error && typeof error === "object" && "message" in error
            ? `Model load failed: ${error.message}`
            : "Model load failed.";
        onModelErrorRef.current?.(message);
        console.error(error);
      } finally {
        if (templateSourceObject && templateSourceObject !== object) {
          disposeObject(templateSourceObject);
        }
        if (!cancelled) onModelLoadingRef.current?.(false);
      }
    };

    loadModel();

    return () => {
      cancelled = true;
      onModelLoadingRef.current?.(false);
    };
  }, [modelPath, sceneReady, includeTemplateGeometry, isTauriRuntime, textureLoader]);

  useEffect(() => {
    const object = modelRef.current;
    if (!sceneReady || !object) return undefined;

    const enabled = Boolean(nativeMaterialsEnabled);
    object.userData = object.userData || {};
    object.userData.nativeMaterialsEnabled = enabled;
    object.userData.nativeMaterialsReady = false;

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

    const nativeMeshes = getMeshList(object).filter((mesh) => mesh.userData?.nativeMaterial);
    if (!enabled) {
      onNativeMaterialsStatusRef.current?.({
        state: "disabled",
        available: nativeMeshes.length > 0,
        meshCount: nativeMeshes.length,
      });
      reapplyMaterials();
      return undefined;
    }

    if (object.userData?.sourceFormat !== "yft" || nativeMeshes.length === 0) {
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
      resources?.dispose?.();
      object.userData.nativeMaterialsReady = false;
    };
  }, [modelVersion, nativeMaterialsEnabled, nativeMaterialsReloadToken, sceneReady]);

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
    resolvedSlotColors,
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

  // Cage wireframe overlay — builds/disposes EdgesGeometry + bounding-box cubes
  useEffect(() => {
    if (!sceneReady || !modelRef.current || !sceneRef.current) return;
    if (showCageWireframe) {
      buildCageOverlay(modelRef.current, sceneRef.current);
    } else {
      disposeCageOverlay(sceneRef.current);
    }
    requestRender();
  }, [showCageWireframe, sceneReady]);

  useEffect(() => {
    let cancelled = false;

    const clearTexture = () => {
      const materialState = materialStateRef.current;
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

      const cacheKey = getTextureCacheKey(texturePath, flipTextureY, textureReloadToken);
      const cached = getCachedTexture(cacheKey);
      if (cached) {
        if (cancelled) return;
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
      let bytes = null;
      try {
        bytes = await readFile(texturePath);
      } catch {
        return;
      }
      if (cancelled) return;

      const extension = getFileExtension(texturePath);
      const signature = sniffTextureSignature(bytes);

      const buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );

      const applyTextureSettings = (texture) => {
        const isLiveryMode = materialStateRef.current?.textureMode === "livery";
        texture.colorSpace = THREE.SRGBColorSpace;
        if (!texture.isCompressedTexture && !texture.userData?.ddsDecoded) {
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
        const blob = new Blob([bytes], { type: mime });
        const url = URL.createObjectURL(blob);
        try {
          const texture = await new Promise((resolve, reject) => {
            textureLoader.load(url, resolve, undefined, reject);
          });
          return texture;
        } finally {
          URL.revokeObjectURL(url);
        }
      };

      const loadDdsCustom = async () => {
        const tex = parseDDS(buffer);
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
        const pdf = await loadingTask.promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 2.0 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const context = canvas.getContext("2d");
        await page.render({ canvasContext: context, viewport }).promise;
        return new THREE.CanvasTexture(canvas);
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
            onFormatWarningRef.current?.({ type: "16bit-psd", bitDepth: error.bitDepth, path: texturePath, kind: "primary" });
            return;
          }
          if (!lastError || (error instanceof Error && error.message)) {
            lastError = error;
          }
        }
      }

      if (!texture) {
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
      const cacheKey = getTextureCacheKey(
        windowTexturePath,
        flipTextureY,
        windowTextureReloadToken,
      );
      const cached = getCachedTexture(cacheKey);
      if (cached) {
        if (cancelled) return;
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
      } catch {
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
        if (!texture.isCompressedTexture && !texture.userData?.ddsDecoded) {
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
        const blob = new Blob([bytes], { type: mime });
        const url = URL.createObjectURL(blob);
        try {
          const texture = await new Promise((resolve, reject) => {
            textureLoader.load(url, resolve, undefined, reject);
          });
          return texture;
        } finally {
          URL.revokeObjectURL(url);
        }
      };

      const loadDdsCustom = async () => {
        const tex = parseDDS(buffer);
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
        const pdf = await loadingTask.promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 2.0 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const context = canvas.getContext("2d");
        await page.render({ canvasContext: context, viewport }).promise;
        return new THREE.CanvasTexture(canvas);
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
            onFormatWarningRef.current?.({ type: "16bit-psd", bitDepth: error.bitDepth, path: windowTexturePath, kind: "window" });
            return;
          }
          lastError = error;
        }
      }

      if (!texture) {
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
      const cacheKey = getTextureCacheKey(materialTexturePath, flipTextureY, 0);
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
      try {
        texture = await loadTextureFromPathShared(materialTexturePath, textureLoader, rendererRef.current);
      } catch (error) {
        if (error?.type === "unsupported-bit-depth") {
          onFormatWarningRef.current?.({
            type: "16bit-psd",
            bitDepth: error.bitDepth,
            path: materialTexturePath,
            kind: "material",
          });
        }
        return;
      }

      if (!texture) return;
      if (cancelled) {
        texture.dispose?.();
        return;
      }

      texture.colorSpace = THREE.SRGBColorSpace;
      texture.flipY = flipTextureY;
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

  return <div ref={containerRef} className="h-full w-full" />;
}

export default memo(ViewerComponent);

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
    if (mesh.indices) {
      geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
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

function applyMaterialProfile(material, color, materialConfig, showWireframe) {
  const resolvedConfig = materialConfig || DEFAULT_MATERIAL_CONFIG;
  const type = resolvedConfig.type || DEFAULT_MATERIAL_CONFIG.type;
  const preset = MATERIAL_TYPE_PRESETS[type] || MATERIAL_TYPE_PRESETS.paint;

  const tint = color.clone();
  const lightBoost = clamp(
    Number.isFinite(resolvedConfig.lightIntensity) ? resolvedConfig.lightIntensity : DEFAULT_MATERIAL_CONFIG.lightIntensity,
    0,
    3,
  );
  tint.multiplyScalar(lightBoost);
  tint.r = clamp(tint.r, 0, 1);
  tint.g = clamp(tint.g, 0, 1);
  tint.b = clamp(tint.b, 0, 1);
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
  material.needsUpdate = true;
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

  const slotColors = normalizeVehicleSlotColors(object.userData?.slotColors, bodyColor || defaultBody);
  const colorBySlot = {
    primary: new THREE.Color(getVehicleSlotColor(slotColors, "primary")),
    secondary: new THREE.Color(getVehicleSlotColor(slotColors, "secondary")),
    accent: new THREE.Color(getVehicleSlotColor(slotColors, "accent")),
    glass: new THREE.Color(getVehicleSlotColor(slotColors, "glass")),
  };
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
    const slotRole = getMeshMeta(child).slotRole;
    const effectiveSlotRole = matchesWindow
      ? "glass"
      : (slotRole || (matchesVehicle ? "primary" : null));
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
    child.userData.templateMarkerInteractive = Boolean(matchesVehicle && vehicleTexture);

    if (activeTextureSet && child.geometry) {
      if (!applyTextureUVSet(child.geometry, preferredUvSelection)) {
        generateBoxProjectionUVs(child.geometry);
      }
    } else if (!shouldApply && child.geometry) {
      restoreBaseUVs(child.geometry);
    }

    const nativeLodVisible = !nativeMaterialsEnabled || child.userData?.nativeLodActive !== false;
    if (exteriorOnly) {
      child.visible = nativeLodVisible && shouldShowExteriorDual(
        child,
        vehicleTarget,
        matchesVehicle || (shouldApplySlotColor && slotRole !== "glass"),
        windowTarget,
        matchesWindow,
      );
    } else {
      child.visible = nativeLodVisible;
    }

    const nativeMaterial = nativeMaterialsEnabled ? child.userData?.nativeMaterialObject : null;
    if (nativeMaterial && !hasManualTextureOverride) {
      const profile = nativeMaterial.userData?.nativeProfile;
      const nativeSlotRole = slotRole || (profile === "paint" ? "primary" : profile === "glass" ? "glass" : null);
      nativeMaterial.color.copy(nativeSlotRole ? colorBySlot[nativeSlotRole] : AUTO_TEXTURE_NEUTRAL_COLOR);
      const baseRoughness = nativeMaterial.userData?.baseRoughness;
      if (typeof baseRoughness === "number") {
        nativeMaterial.roughness = clamp(baseRoughness * baseGlossFactor, 0, 1);
      }
      setMaterialWireframe(nativeMaterial, showWireframe);
      if (child.material !== nativeMaterial) child.material = nativeMaterial;
      continue;
    }

    if (shouldApply && (activeTexture || matchesVehicle || shouldApplySlotColor)) {
      const appliedMaterial = getOrCreateAppliedMaterial(child, meshColor);
      updateAppliedMaterial(appliedMaterial, meshColor, activeTextureSet);
      const effectiveMaterialConfig =
        effectiveSlotRole === "glass" || isGlass
          ? { ...materialConfig, type: "glass" }
          : materialConfig;
      applyMaterialProfile(appliedMaterial, meshColor, effectiveMaterialConfig, showWireframe);
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
  const chosen = chooseUVAttribute(geometry, preferUv2);
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

  const slotRole = detectVehicleColorSlot(searchNames, isGlass);
  const meta = { baseMaterial, meshLabel, materialNames, searchNames, targetSet, isGlass, slotRole };
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
