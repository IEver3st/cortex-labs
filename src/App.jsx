import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { writeFile, exists as fsExists, readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { normalizeModelRotation, quarterTurn } from "./lib/model-orientation.js";
import { isYtdTexturePath } from "./lib/ytd-texture.js";
import { pieceTextureCandidates } from "./lib/eup.js";
// Window controls handled by Shell
import { ArrowUpRight, ChevronRight, Zap, Check, Copy, Droplets } from "lucide-react";
import AppLoader, { LoadingGlyph } from "./components/AppLoader";
import FormatWarningDialog from "./components/FormatWarningDialog";
import SingleWorkspace from "./components/workspace/SingleWorkspace";
import SirenWorkspace from "./components/workspace/SirenWorkspace";
import MultiWorkspace from "./components/workspace/MultiWorkspace";
// SettingsMenu now rendered by Shell
import Viewer from "./components/Viewer";
import MultiModelViewer from "./components/MultiModelViewer";
import { useMultiLineup } from "./components/workspace/useMultiLineup";
import { MAX_LINEUP_SLOTS, VEHICLE_MODEL_EXTENSIONS, isVehicleModelPath, lineupWatchPaths, pathKey as lineupPathKey } from "./lib/multi-lineup";
import useVehicleModkits from "./components/workspace/useVehicleModkits";
import useKitShoot from "./components/workspace/useKitShoot";
import { emitRenderEffectChanged, loadPrefs, RENDER_EFFECT_EVENT, sanitizeStoredDefaults, savePrefs } from "./lib/prefs";
import { openFolderPath } from "./lib/open-folder";
import { captureTemporaryViewerFrame, captureViewerFrameBytes } from "./lib/preview-capture";
import { countExistingFiles, downloadBytes } from "./lib/capture-output";
import { DEFAULT_WATERMARK, hasDrawableWatermark } from "./lib/watermark";

import { ensurePreviewExportFolder, resolveExistingPreviewFolderPath } from "./lib/preview-folder";
import { updateWorkspace, WORKSPACE_SAVE_FAILED_EVENT } from "./lib/workspace";
import { SHOWROOM_FLOORS, SHOWROOM_LIGHT_KEYS } from "./lib/viewer-stage";
import { TURNTABLE_DEFAULT_SPEED, normalizeTurntableSpeed } from "./lib/turntable.js";
import { DEFAULT_HAZE, DEFAULT_LIGHT_SWITCHES } from "./lib/emergency-lights";
import { DEFAULT_EXTRAS_STATE, normalizeExtrasState, planExtras } from "./lib/vehicle-extras";
import { normalizeLiverySet } from "./lib/livery-set";
import { normalizeClothingSet } from "./lib/clothing-pack";
import { captureSavedVehicle, generateSavedVehicleId, loadSavedVehicles, MAX_SAVED_VEHICLES, moveSavedVehicleModel, upsertSavedVehicle, writeSavedVehicles } from "./lib/saved-vehicles";
import { normalizeSavedLightPreview, normalizeSavedMaterials, normalizeSavedSteering, normalizeTextureMode, PAINT_TARGET, savedVehicleTargets } from "./lib/workspace-state";
import { setUnsavedChanges } from "./lib/unsaved-changes";
import { normalizeLightDefaults, normalizePlateDefault, normalizeShowroomSubject, normalizeSteeringDefault, resolveDefaultSteering } from "./lib/studio-defaults";
import { readModelResourceMeta } from "./lib/resource-meta-files";
import { filterVehicles, stepVehicle, vehicleIndexOf } from "./lib/vehicle-folder";
import { SNAPSHOT_HEIGHT, SNAPSHOT_PRESET, SNAPSHOT_QUALITY, SNAPSHOT_WIDTH, SNAPSHOT_ZOOM } from "./lib/vehicle-snapshots";
import useVehicleFolder from "./components/workspace/useVehicleFolder";
import usePackSnapshots from "./components/workspace/usePackSnapshots";
import { simulateVehicle } from "./lib/vehicle-meta";
import {
  VEHICLE_PAINT_KEYS,
  buildVehiclePaint,
  normalizeVehiclePaint,
  paintDisplayColor,
  paintFromMetaColor,
} from "./lib/vehicle-paint.js";
import useSirenEditor from "./components/siren-editor/useSirenEditor";
import useEls from "./components/els/useEls";
import { elsRunning } from "./lib/els-lights.js";
import {
  DEFAULT_HOTKEYS,
  HOTKEY_ACTIONS,
  findMatchingAction,
  mergeHotkeys,
} from "./lib/hotkeys";
import { Button } from "./components/ui/button";
import { Label } from "./components/ui/label";
import { Input } from "./components/ui/input";
import { CyberButton } from "./components/CyberUI";

// Workspaces whose vehicle lights an ELS VCF can drive.
const ELS_MODES = new Set(["sirens", "vehicle"]);

const DEFAULT_BODY = "#e7ebf0";
const DEFAULT_BG = "#141414";
const MAX_BACKGROUND_IMAGE_BLUR = 32;
const MIN_LOADER_MS = 650;
// Pack view snapshots wait this long after a vehicle settles, and a Take
// snapshots pass gives up on a vehicle that has not settled after the second.
const SNAPSHOT_SETTLE_MS = 350;
const SNAPSHOT_SKIP_MS = 120000;

const SUPPORTED_TEXTURE_EXTS = [
  "png",
  "jpg",
  "jpeg",
  "webp",
  "avif",
  "bmp",
  "gif",
  "tga",
  "dds",
  "tif",
  "tiff",
  "psd",
  "ai",
  "pdn",
];

const PREVIEW_CAPTURE_PRESETS = [
  { key: "front", label: "Front" },
  { key: "back", label: "Back" },
  { key: "side", label: "Side" },
  { key: "angle", label: "3/4" },
  { key: "top", label: "Top" },
];

const PREVIEW_CAPTURE_PRESET_KEYS = PREVIEW_CAPTURE_PRESETS.map((preset) => preset.key);
const PREVIEW_CAPTURE_PRESET_LABELS = PREVIEW_CAPTURE_PRESETS.reduce((acc, preset) => {
  acc[preset.key] = preset.label;
  return acc;
}, {});

function isTextureFormatSupported(filePath) {
  if (!filePath) return true;
  const ext = filePath.split(".").pop().toLowerCase();
  return SUPPORTED_TEXTURE_EXTS.includes(ext);
}

function getFileExtension(filePath) {
  if (!filePath) return "";
  return filePath.split(".").pop().toLowerCase();
}

function clampBackgroundImageBlur(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(MAX_BACKGROUND_IMAGE_BLUR, Math.round(parsed)));
}

const BUILT_IN_DEFAULTS = {
  textureMode: "vehicle",
  liveryExteriorOnly: false,
  windowTemplateEnabled: false,
  windowTextureTarget: "auto",
  bodyColor: DEFAULT_BODY,
  backgroundColor: DEFAULT_BG,
  showGrid: false,
  showShadows: false,
  ambientOcclusion: false,
  showRecents: true,
  lightIntensity: 1.0,
  lightAzimuth: 54,
  lightElevation: 46,
  windowControlsStyle: "windows",
  variantExportFolder: "",
  cameraControlsInPanel: false,
  eupAutoTextures: true,
  warnStandardModel: true,
  watermark: { ...DEFAULT_WATERMARK },
};

const BUILT_IN_UI = {

  colorsOpen: true,
};

function getInitialDefaults() {
  const prefs = loadPrefs();
  const stored = sanitizeStoredDefaults(prefs?.defaults);
  return { ...BUILT_IN_DEFAULTS, ...stored };
}

function getInitialUi() {
  const prefs = loadPrefs();
  const stored = prefs?.ui && typeof prefs.ui === "object" ? prefs.ui : {};
  return { ...BUILT_IN_UI, ...stored };
}

function getInitialHotkeys() {
  const prefs = loadPrefs();
  const stored = prefs?.hotkeys && typeof prefs.hotkeys === "object" ? prefs.hotkeys : {};
  return mergeHotkeys(stored, DEFAULT_HOTKEYS);
}

function getFileLabel(path, emptyLabel) {
  if (!path) return emptyLabel;
return path.split(/[\\/]/).pop();
}

function UnloadButton({ onClick, title, className }) {
  return (
    <CyberButton variant="danger" className={className} onClick={onClick} title={title}>
      <span className="font-bold tracking-[0.2em] text-[9px]">UNLOAD</span>
    </CyberButton>
  );
}

function App({ shellTab, isActive = true, onRenameTab, settingsVersion, defaultTextureMode = "vehicle", initialState = null, contextBarTarget = null }) {

  const viewerApiRef = useRef(null);
  const reloadTimerRef = useRef({ primary: null, window: null });
  const isTauriRuntime =
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__ !== "undefined" &&
    typeof window.__TAURI_INTERNALS__?.invoke === "function";

  const [defaults, setDefaults] = useState(() => getInitialDefaults());
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;
  const [hotkeys, setHotkeys] = useState(() => getInitialHotkeys());
  const [panelCollapsed, setPanelCollapsed] = useState(false);

  // Toast notification system
  const [toasts, setToasts] = useState([]);
  const toastIdRef = useRef(0);
  const toastTimersRef = useRef(new Set());
  const showToast = useCallback((message, type = "info") => {
    const id = ++toastIdRef.current;
    setToasts(prev => [...prev, { id, message, type }]);
    const timer = setTimeout(() => {
      toastTimersRef.current.delete(timer);
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 3200);
    toastTimersRef.current.add(timer);
  }, []);
  useEffect(() => {
    const timers = toastTimersRef.current;
    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);
  useEffect(() => {
    if (!isActive) return;
    const onSaveFailed = () => showToast("Workspace save failed — storage is full. Free up space or remove old workspaces.", "error");
    window.addEventListener(WORKSPACE_SAVE_FAILED_EVENT, onSaveFailed);
    return () => window.removeEventListener(WORKSPACE_SAVE_FAILED_EVENT, onSaveFailed);
  }, [isActive, showToast]);

  // Color swatch presets
  const COLOR_SWATCHES = ["#e7ebf0", "#1a1a2e", "#0f3460", "#16213e", "#533483", "#e94560", "#f5f5dc", "#2c3e50", "#000000", "#ffffff"];

  // Copy to clipboard
  const copyHex = useCallback((val) => {
    navigator.clipboard?.writeText(val).then(() => showToast(`Copied ${val}`));
  }, [showToast]);

  const [modelPath, setModelPath] = useState("");
  const [modelSourcePath, setModelSourcePath] = useState("");
  const [generatedTemplateMap, setGeneratedTemplateMap] = useState(null);
  const [templateMapError, setTemplateMapError] = useState("");
  const [texturePath, setTexturePath] = useState("");
  const [windowTemplateEnabled, setWindowTemplateEnabled] = useState(() => Boolean(getInitialDefaults().windowTemplateEnabled));
  const [windowTexturePath, setWindowTexturePath] = useState("");
  const [bodyColor, setBodyColor] = useState(() => getInitialDefaults().bodyColor);
  const [vehiclePaint, setVehiclePaint] = useState(() => buildVehiclePaint(getInitialDefaults().bodyColor));
  const [backgroundColor, setBackgroundColor] = useState(() => getInitialDefaults().backgroundColor);
  const [backgroundImagePath, setBackgroundImagePath] = useState("");
  const [backgroundImageBlur, setBackgroundImageBlur] = useState(0);
  const [backgroundImageReloadToken, setBackgroundImageReloadToken] = useState(0);
  const [showWireframe, setShowWireframe] = useState(false);
  const [showCageWireframe, setShowCageWireframe] = useState(false);
  const [showSolidWireframe, setShowSolidWireframe] = useState(false);
  // What the viewer draws while the solid wireframe is on; null when off.
  const [meshStats, setMeshStats] = useState(null);
  const [lightIntensity, setLightIntensity] = useState(() => normalizeLightDefaults(getInitialDefaults()).intensity);
  const [lightAzimuth, setLightAzimuth] = useState(() => normalizeLightDefaults(getInitialDefaults()).azimuth);
  const [lightElevation, setLightElevation] = useState(() => normalizeLightDefaults(getInitialDefaults()).elevation);
  // Viewer stage: "workbench" (the user's backdrop) or "showroom" (photo studio).
  // A new tab starts from Settings > Studio; a restored workspace keeps its own.
  // EUP starts from the EUP scene (the one EUP Studio uses), everything else from Vehicles.
  const [initialShowroom] = useState(() => {
    const subject = normalizeTextureMode(defaultTextureMode) === "eup" ? "ped" : "vehicle";
    return normalizeShowroomSubject(getInitialDefaults().showroom?.[subject], subject);
  });
  const [stage, setStage] = useState(initialShowroom.stage);
  const [stageSpot, setStageSpot] = useState(initialShowroom.spot);
  const [stageReflect, setStageReflect] = useState(initialShowroom.reflect);
  const [stageBeam, setStageBeam] = useState(initialShowroom.beam);
  const [stageLight, setStageLight] = useState(initialShowroom.light);
  const [stageFloor, setStageFloor] = useState(initialShowroom.floor);
  // Vehicle turntable (Scene tab), kept with the tab's workspace.
  const [turntable, setTurntable] = useState(false);
  const [turntableSpeed, setTurntableSpeed] = useState(TURNTABLE_DEFAULT_SPEED);
  const [photoError, setPhotoError] = useState("");
  const [lightingOpen, setLightingOpen] = useState(true);
  const [glossiness, setGlossiness] = useState(0.5);

  // Vehicle Materials state
  const [materialType, setMaterialType] = useState("paint");
  const [matLightIntensity, setMatLightIntensity] = useState(1.0);
  const [matGlossiness, setMatGlossiness] = useState(0.5);
  const [matRoughness, setMatRoughness] = useState(0.3);
  const [matClearcoat, setMatClearcoat] = useState(0.0);
  // Quarter turns applied with the rotate buttons ([x, y, z, w] or null).
  const [modelRotation, setModelRotation] = useState(null);
  // A model picked in EUP asks for its own texture dictionary (see the effect below).
  const [autoTextureRequest, setAutoTextureRequest] = useState(null);
  const autoTexturePathRef = useRef("");
  const [materialTextures, setMaterialTextures] = useState([]);
  const [materialsOpen, setMaterialsOpen] = useState(false);
  // Sirens shows the whole vehicle with its own textures unless the user turns them off.
  const [nativeMaterialsEnabled, setNativeMaterialsEnabled] = useState(() => defaultTextureMode === "sirens");
  const [nativeMaterialsReloadToken, setNativeMaterialsReloadToken] = useState(0);
  const [nativeMaterialsStatus, setNativeMaterialsStatus] = useState({
    state: "idle",
    available: false,
  });

  // windowControlsStyle now handled by Shell
  const [colorsOpen, setColorsOpen] = useState(() => getInitialUi().colorsOpen);

  const [panelOpen, setPanelOpen] = useState(() => ({
    model: true,
    templates: true,
    nativeMaterials: true,
    targeting: true,
    overlays: false,
    view: true,
    camera: true,
    colors: true,
    materials: false,
    lighting: true,
  }));
  const [activePanelTab, setActivePanelTab] = useState("asset");
  const [metaModelInfo, setMetaModelInfo] = useState(null);
  // Front wheel angle in degrees (positive steers right). A new model starts at
  // the Settings default, capped by its handling.meta steering lock, and stays
  // straight when no lock is found because the Meta panel can't steer it back.
  const [steering, setSteering] = useState({ path: "", angle: 0 });
  const [steeringLock, setSteeringLock] = useState({ path: "", lock: null });
  const defaultSteering = normalizeSteeringDefault(defaults.steeringAngle);
  const steeringAngle = steering.path === modelPath
    ? steering.angle
    : steeringLock.path === modelPath ? resolveDefaultSteering(defaultSteering, steeringLock.lock) : 0;
  const setSteeringAngle = useCallback((angle) => setSteering({ path: modelPath, angle }), [modelPath]);
  const needsSteeringLock = defaultSteering !== 0 && isTauriRuntime && /\.(yft|clmesh)$/i.test(modelPath || "");
  useEffect(() => {
    if (!needsSteeringLock) return undefined;
    const controller = new AbortController();
    const modelName = modelPath.split(/[\\/]/).pop().replace(/\.(yft|clmesh)$/i, "").replace(/_hi$/i, "");
    (async () => {
      await invoke("allow_model_resource", { path: modelPath });
      if (controller.signal.aborted) return;
      const result = await readModelResourceMeta(modelPath, { readDir, readTextFile, signal: controller.signal });
      if (controller.signal.aborted) return;
      setSteeringLock({ path: modelPath, lock: simulateVehicle(result.meta, modelName).steering.lockDegrees });
    })().catch((error) => {
      if (controller.signal.aborted) return;
      // The Meta tab reports unreadable meta files; the wheels just stay straight.
      console.warn("[Steering] Could not read the steering lock for", modelPath, error);
      setSteeringLock({ path: modelPath, lock: null });
    });
    return () => controller.abort();
  }, [modelPath, needsSteeringLock]);
  // Vehicle light preview. Switches persist across models; the carcols siren
  // setting belongs to the model it was read for.
  const [lightPreview, setLightPreview] = useState(() => ({
    switches: DEFAULT_LIGHT_SWITCHES, muted: [], speed: 1, spill: true, spillStrength: 1, glow: 1, haze: DEFAULT_HAZE, setting: null, ulc: null, sirenContext: null, settingPath: "",
    // Preview lens colours ({ path, tints }), kept with the model they were picked on.
    lens: null,
  }));
  const fileSirenSetting = lightPreview.settingPath === modelPath ? lightPreview.setting : null;
  // The siren editor's draft replaces the file's setting in the preview while it exists.
  const sirenEditor = useSirenEditor({ modelPath, fileSetting: fileSirenSetting });
  const vehicleLights = useMemo(() => ({
    ...lightPreview,
    setting: sirenEditor.draft ?? fileSirenSetting,
    fileSetting: fileSirenSetting,
    ulc: lightPreview.settingPath === modelPath ? lightPreview.ulc : null,
    sirenContext: lightPreview.settingPath === modelPath ? lightPreview.sirenContext : null,
    lens: lightPreview.lens?.path === modelPath ? lightPreview.lens.tints : null,
  }), [lightPreview, modelPath, fileSirenSetting, sirenEditor.draft]);
  // `lensTints` (siren number to "siren" or "#rrggbb") belongs to the open model.
  const updateVehicleLights = useCallback(({ lensTints, ...patch }) => setLightPreview((current) => ({
    ...current,
    ...patch,
    ...(Object.prototype.hasOwnProperty.call(patch, "setting") ? { settingPath: modelPath } : {}),
    ...(lensTints !== undefined ? { lens: modelPath && Object.keys(lensTints || {}).length ? { path: modelPath, tints: lensTints } : null } : {}),
  })), [modelPath]);
  const getLightTime = useCallback(() => viewerApiRef.current?.getLightTime?.() ?? null, []);
  const setLightTime = useCallback((seconds) => viewerApiRef.current?.setLightTime?.(seconds), []);
  const getSirenMarkers = useCallback(() => viewerApiRef.current?.getSirenMarkers?.() ?? [], []);
  // Overlays that track the camera lay out right after the viewer draws a frame.
  const viewerFrameListenersRef = useRef(new Set());
  const handleViewerFrame = useCallback(() => {
    for (const listener of viewerFrameListenersRef.current) listener();
  }, []);
  const onViewerFrame = useCallback((listener) => {
    viewerFrameListenersRef.current.add(listener);
    return () => viewerFrameListenersRef.current.delete(listener);
  }, []);
  // Bumped after the siren editor writes carcols.meta so the Meta tab rereads it.
  const [metaRescanToken, setMetaRescanToken] = useState(0);
  const requestMetaRescan = useCallback(() => setMetaRescanToken((value) => value + 1), []);
  // Doors, bonnet, boot and convertible roof. The viewer owns the pose and
  // reports part targets here; the roof clip named by vehicles.meta comes from
  // the resource's .ycd or the game files.
  const [vehicleParts, setVehicleParts] = useState(null);
  // Paint slots the loaded model's meshes take; null when nothing is loaded.
  const [paintSlotsInUse, setPaintSlotsInUse] = useState(null);
  const [roofClip, setRoofClip] = useState({ path: "", status: "idle", dict: "", clip: "", source: "", data: null, error: "" });
  const vehiclePosable = Boolean(metaModelInfo?.vehiclePosable);
  const canLoadRoofClip = vehiclePosable && isTauriRuntime && /\.yft$/i.test(modelPath || "");
  useEffect(() => {
    if (!canLoadRoofClip) {
      setRoofClip({ path: modelPath, status: "idle", dict: "", clip: "", source: "", data: null, error: "" });
      return undefined;
    }
    const controller = new AbortController();
    const modelName = modelPath.split(/[\\/]/).pop().replace(/\.yft$/i, "").replace(/_hi$/i, "");
    // A meta rescan of the same model keeps the loaded clip until the new one lands.
    const keepReady = (current) => current.path === modelPath && current.status === "ready";
    setRoofClip((current) => (keepReady(current) ? current : { path: modelPath, status: "loading", dict: "", clip: "", source: "", data: null, error: "" }));
    (async () => {
      await invoke("allow_model_resource", { path: modelPath });
      if (controller.signal.aborted) return;
      const result = await readModelResourceMeta(modelPath, { readDir, readTextFile, signal: controller.signal });
      if (controller.signal.aborted) return;
      const roof = simulateVehicle(result.meta, modelName).convertibleRoof;
      if (!roof) {
        setRoofClip({ path: modelPath, status: "none", dict: "", clip: "", source: "", data: null, error: "" });
        return;
      }
      setRoofClip((current) => (keepReady(current) ? current : { path: modelPath, status: "loading", dict: roof.dict, clip: roof.clip, source: "", data: null, error: "" }));
      const data = await invoke("export_model_clip", { modelPath, dict: roof.dict, clip: roof.clip });
      if (controller.signal.aborted) return;
      setRoofClip({ path: modelPath, status: "ready", dict: roof.dict, clip: roof.clip, source: data?.source || "", data, error: "" });
    })().catch((error) => {
      if (controller.signal.aborted) return;
      setRoofClip((current) => ({ ...current, path: modelPath, status: "error", data: null, error: String(error?.message || error) }));
    });
    return () => controller.abort();
  }, [modelPath, canLoadRoofClip, metaRescanToken]);
  const activeRoofClip = roofClip.path === modelPath && roofClip.status === "ready" ? roofClip.data : null;
  const vehiclePartControls = useMemo(() => ({
    set: (id, value, options) => viewerApiRef.current?.setVehiclePart?.(id, value, options),
    toggle: (id) => viewerApiRef.current?.toggleVehiclePart?.(id),
    setAll: (open) => viewerApiRef.current?.setAllVehicleParts?.(open),
  }), []);
  // Extras follow the vehicle state: a new model spawns with none on, then the
  // ULC config (or siren geometry) and manual toggles decide.
  const [extrasStateEntry, setExtrasStateEntry] = useState(() => ({ path: "", ...DEFAULT_EXTRAS_STATE }));
  // Stable while untouched, so effects that depend on it (session save) don't rerun every render.
  const extrasState = useMemo(
    () => (extrasStateEntry.path === modelPath ? extrasStateEntry : { path: modelPath, ...DEFAULT_EXTRAS_STATE }),
    [extrasStateEntry, modelPath],
  );
  const updateExtrasState = useCallback((patch) => setExtrasStateEntry((current) => ({
    ...(current.path === modelPath ? current : { path: modelPath, ...DEFAULT_EXTRAS_STATE }),
    ...(typeof patch === "function" ? patch(current.path === modelPath ? current : { path: modelPath, ...DEFAULT_EXTRAS_STATE }) : patch),
    path: modelPath,
  })), [modelPath]);
  const extrasPlan = useMemo(() => planExtras({
    available: (metaModelInfo?.extras || []).map((extra) => extra.index),
    ulc: vehicleLights.ulc,
    lightExtras: metaModelInfo?.lights?.extras || {},
    switches: vehicleLights.switches,
    state: extrasState,
  }), [metaModelInfo, vehicleLights.ulc, vehicleLights.switches, extrasState]);
  const toggleMetaExtra = useCallback((index, visible) => {
    updateExtrasState((current) => ({ overrides: { ...current.overrides, [index]: visible } }));
    return true;
  }, [updateExtrasState]);
  // License plate drawn on YFT vehicles: game style index (0-12) and up to 8
  // characters. Follows the Settings default until the user edits it here.
  const defaultPlate = useMemo(() => normalizePlateDefault(defaults.licensePlate), [defaults.licensePlate]);
  const [plateOverride, setPlateOverride] = useState(null);
  const licensePlate = plateOverride ?? defaultPlate;
  const [licensePlateStatus, setLicensePlateStatus] = useState(null);
  const updateLicensePlate = useCallback(
    (patch) => setPlateOverride((current) => ({ ...(current ?? defaultPlate), ...patch })),
    [defaultPlate],
  );
  const [textureReloadToken, setTextureReloadToken] = useState(0);
  // Loads the open model again after a write changed its files (lens colours).
  const [modelReloadToken, setModelReloadToken] = useState(0);
  const reloadModel = useCallback(() => setModelReloadToken((token) => token + 1), []);
  const [windowTextureReloadToken, setWindowTextureReloadToken] = useState(0);
  const [textureTargets, setTextureTargets] = useState([]);
  const [textureMode, setTextureMode] = useState(() => normalizeTextureMode(defaultTextureMode) || "vehicle");
  // loadModel outlives renders, so it reads the mode here.
  const textureModeRef = useRef(textureMode);
  textureModeRef.current = textureMode;
  const modkits = useVehicleModkits({ modelPath, enabled: isTauriRuntime && (textureMode === "vehicle" || textureMode === "sirens") });
  // ELS lighting (the vehicle workspaces: Sirens edits the VCF, Vehicle
  // switches it from the Lights panel): a vehicle switched to ELS has its
  // VCF drive the extras, and the carcols sirens follow its light stage.
  const elsModelExtras = useMemo(
    () => [...new Set((metaModelInfo?.extras || []).map((extra) => extra.index))].sort((a, b) => a - b),
    [metaModelInfo],
  );
  const elsMode = ELS_MODES.has(textureMode);
  const els = useEls({ modelPath, isTauriRuntime, modelExtras: elsModelExtras, active: elsMode });
  const elsLive = elsMode ? els.live : null;
  const viewerLights = useMemo(() => (elsLive ? {
    ...vehicleLights,
    els: elsLive,
    // The rig takes the sirens switch from the VCF; this keeps night lighting on while ELS runs.
    switches: { ...vehicleLights.switches, sirens: elsRunning(elsLive.config, elsLive.preview) },
  } : vehicleLights), [vehicleLights, elsLive]);
  // The saved vehicle this tab was opened from or last saved as: { id, name, path }.
  // It only applies while that model is loaded.
  const [savedVehicleEntry, setSavedVehicleEntry] = useState(null);
  const savedVehicle = savedVehicleEntry && savedVehicleEntry.path === modelPath ? savedVehicleEntry : null;
  // The game texture livery (`_sign_N`) shown in Vehicle or Sirens: { path, number }.
  // Like the mods, it belongs to the model it was chosen on.
  const [gameLiveryEntry, setGameLiveryEntry] = useState(null);
  const gameLivery = gameLiveryEntry && gameLiveryEntry.path === modelPath ? gameLiveryEntry.number : null;
  const setGameLivery = useCallback((number) => {
    setGameLiveryEntry(Number.isInteger(number) && modelPath ? { path: modelPath, number } : null);
  }, [modelPath]);
  // The folder of vehicles the Pack view lists (Vehicle mode), or "".
  const [vehicleFolder, setVehicleFolder] = useState("");
  const folderScan = useVehicleFolder(vehicleFolder, isTauriRuntime && textureMode === "vehicle", modelSourcePath || modelPath);
  // The Pack view's filter; stepping goes through the vehicles it leaves listed.
  const [vehicleFilter, setVehicleFilter] = useState("");
  const folderVehicles = useMemo(() => filterVehicles(folderScan.vehicles, vehicleFilter), [folderScan.vehicles, vehicleFilter]);
  // With a folder open, "pack" shows its vehicles in place of the workspace and
  // "vehicle" the workspace for the open one.
  const [folderView, setFolderView] = useState("vehicle");
  const hasFolder = isTauriRuntime && textureMode === "vehicle" && Boolean(vehicleFolder);
  const packShown = hasFolder && folderView === "pack";
  const packSnapshots = usePackSnapshots(folderScan.status === "scanning" ? null : folderScan.vehicles, hasFolder);
  // A Take snapshots pass: { queue, total, done, failed, current, returnTo }.
  const [snapshotRun, setSnapshotRun] = useState(null);
  // How the last pass ended, until the next one or the folder closes: { done, failed }.
  const [snapshotResult, setSnapshotResult] = useState(null);
  // Images staged in the Liveries tab to write as the model's texture
  // liveries: { path, pattern, items: [{ id, path, number }] }, per model.
  // Keyed by model path, so stepping through a folder of vehicles keeps each
  // one's unwritten liveries for the session.
  const [liverySetEntries, setLiverySetEntries] = useState({});
  const liverySet = (modelPath && liverySetEntries[modelPath]) || null;
  const setLiverySet = useCallback((update) => {
    if (!modelPath) return;
    setLiverySetEntries((entries) => {
      const current = entries[modelPath];
      const base = current || { path: modelPath, pattern: "", items: [], removed: [] };
      const next = typeof update === "function" ? update(base) : update;
      const rest = { ...entries };
      delete rest[modelPath];
      return next ? { ...rest, [modelPath]: { pattern: next.pattern || "", items: next.items || [], removed: next.removed || [], path: modelPath } } : rest;
    });
  }, [modelPath]);
  // Images staged in EUP mode's Textures tab as the open clothing item's
  // textures: { path, items: [{ id, path, letter }] }, per drawable, like the
  // liveries above.
  const [clothingSetEntries, setClothingSetEntries] = useState({});
  const clothingSet = (modelPath && clothingSetEntries[modelPath]) || null;
  const setClothingSet = useCallback((update) => {
    if (!modelPath) return;
    setClothingSetEntries((entries) => {
      const base = entries[modelPath] || { path: modelPath, items: [] };
      const next = typeof update === "function" ? update(base) : update;
      const rest = { ...entries };
      delete rest[modelPath];
      return next?.items?.length ? { ...rest, [modelPath]: { items: next.items, path: modelPath } } : rest;
    });
  }, [modelPath]);
  // Reported by the viewer for the model it shows, which lags modelPath while
  // the next model loads.
  const [gameLiveriesReport, setGameLiveries] = useState(null);
  const gameLiveries = gameLiveriesReport && gameLiveriesReport.path === modelPath ? gameLiveriesReport : null;
  const [vehicleModsStatus, setVehicleModsStatus] = useState(null);
  // Vehicle mode starts on the detected paint; the other modes on every mesh.
  const [textureTarget, setTextureTarget] = useState(() => (textureMode === "vehicle" ? PAINT_TARGET : "all"));
  const [liveryTarget, setLiveryTarget] = useState("");
  const [liveryLabel, setLiveryLabel] = useState("");
  const [windowTextureTarget, setWindowTextureTarget] = useState(() => getInitialDefaults().windowTextureTarget || "auto");

  const [cameraControlsInPanel, setCameraControlsInPanel] = useState(() => Boolean(getInitialDefaults().cameraControlsInPanel));
  const [showGrid, setShowGrid] = useState(() => Boolean(getInitialDefaults().showGrid));
  const [showShadows, setShowShadows] = useState(() => Boolean(getInitialDefaults().showShadows));
  const [ambientOcclusion, setAmbientOcclusion] = useState(() => Boolean(getInitialDefaults().ambientOcclusion));
  const [windowLiveryTarget, setWindowLiveryTarget] = useState("");
  const [windowLiveryLabel, setWindowLiveryLabel] = useState("");
  const [liveryExteriorOnly, setLiveryExteriorOnly] = useState(() => Boolean(getInitialDefaults().liveryExteriorOnly));
  const [lastUpdate, setLastUpdate] = useState("-");
  const [watchStatus, setWatchStatus] = useState("idle");
  const [dialogError, setDialogError] = useState("");
  const [textureError, setTextureError] = useState("");
  const [windowTextureError, setWindowTextureError] = useState("");
  const [isDragging, setIsDragging] = useState(false);

  const multiViewerApiRef = useRef(null);
  const multi = useMultiLineup(bodyColor, initialShowroom.floor);

  const [modelLoading, setModelLoading] = useState(false);
  const [viewerReady, setViewerReady] = useState(false);
  const [booted, setBooted] = useState(false);
  const [formatWarning, setFormatWarning] = useState(null); // { type: "16bit-psd", bitDepth: 16 }
  const bootStartRef = useRef(typeof performance !== "undefined" ? performance.now() : Date.now());
  const bootTimerRef = useRef(null);

  const initialStateRestoredRef = useRef(false);

  // Generate Preview state
  const [generatingPreview, setGeneratingPreview] = useState(false);
  const [previewProgress, setPreviewProgress] = useState({ current: 0, total: 0, preset: "" });
  const [previewComplete, setPreviewComplete] = useState(false);
  // What the last run actually wrote: { total, written, skipped, error, folder, note }.
  const [previewResult, setPreviewResult] = useState(null);
  // A run waiting on "Replace N files?": { conflicts, total, folder, job }.
  const [previewReplace, setPreviewReplace] = useState(null);
  const [previewOutputPath, setPreviewOutputPath] = useState("");
  const [previewFolderOpening, setPreviewFolderOpening] = useState(false);
  const [previewFolderOpenError, setPreviewFolderOpenError] = useState("");
  const [previewPromptOpen, setPreviewPromptOpen] = useState(false);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [previewZoomDraft, setPreviewZoomDraft] = useState(1);
  const [previewCapturePresets, setPreviewCapturePresets] = useState(() => [...PREVIEW_CAPTURE_PRESET_KEYS]);
  const [previewZoomPreview, setPreviewZoomPreview] = useState("");
  const [previewZoomLoading, setPreviewZoomLoading] = useState(false);
  const lightIntensityRafRef = useRef(0);
  const pendingLightIntensityRef = useRef(null);
  const lightDirectionRafRef = useRef(0);
  const pendingLightDirectionRef = useRef(null);

  const scheduleLightDirectionUpdate = useCallback((nextDirection) => {
    pendingLightDirectionRef.current = nextDirection;
    if (lightDirectionRafRef.current) return;
    lightDirectionRafRef.current = requestAnimationFrame(() => {
      lightDirectionRafRef.current = 0;
      const pending = pendingLightDirectionRef.current;
      pendingLightDirectionRef.current = null;
      if (!pending) return;
      setLightAzimuth((prev) => (prev === pending.azimuth ? prev : pending.azimuth));
      setLightElevation((prev) => (prev === pending.elevation ? prev : pending.elevation));
    });
  }, []);

  const handleLightIntensityChange = useCallback((nextValue) => {
    const parsed = Number(nextValue);
    const clamped = Math.max(0, Math.min(3, Math.round((Number.isFinite(parsed) ? parsed : 1) * 100) / 100));
    pendingLightIntensityRef.current = clamped;
    if (lightIntensityRafRef.current) return;
    lightIntensityRafRef.current = requestAnimationFrame(() => {
      lightIntensityRafRef.current = 0;
      const pending = pendingLightIntensityRef.current;
      pendingLightIntensityRef.current = null;
      if (typeof pending !== "number") return;
      setLightIntensity((prev) => (Math.abs(prev - pending) < 0.0001 ? prev : pending));
    });
  }, []);

  const handleLightAzimuthChange = useCallback((nextValue) => {
    const parsed = Number(nextValue);
    const nextAzimuth = Math.max(0, Math.min(360, Math.round(Number.isFinite(parsed) ? parsed : 54)));
    const pending = pendingLightDirectionRef.current;
    scheduleLightDirectionUpdate({
      azimuth: nextAzimuth,
      elevation: pending?.elevation ?? lightElevation,
    });
  }, [lightElevation, scheduleLightDirectionUpdate]);

  const handleLightElevationChange = useCallback((nextValue) => {
    const parsed = Number(nextValue);
    const nextElevation = Math.max(0, Math.min(90, Math.round(Number.isFinite(parsed) ? parsed : 46)));
    const pending = pendingLightDirectionRef.current;
    scheduleLightDirectionUpdate({
      azimuth: pending?.azimuth ?? lightAzimuth,
      elevation: nextElevation,
    });
  }, [lightAzimuth, scheduleLightDirectionUpdate]);

  // EUP mode has one body colour; it paints whatever takes primary.
  const eupPaint = useMemo(() => buildVehiclePaint(bodyColor), [bodyColor]);

  // `value` is a slot paint ({ index, color, finish }); primary also sets the base body colour.
  const setVehiclePaintSlot = useCallback((slot, value) => {
    if (!value) return;
    if (slot === "primary") setBodyColor(paintDisplayColor(value));
    setVehiclePaint((prev) => ({ ...prev, [slot]: value }));
  }, []);

  const resetVehiclePaintSlot = useCallback((slot) => {
    setVehiclePaintSlot(slot, buildVehiclePaint(defaultsRef.current.bodyColor)[slot]);
  }, [setVehiclePaintSlot]);

  const resetLighting = useCallback(() => {
    if (lightIntensityRafRef.current) {
      cancelAnimationFrame(lightIntensityRafRef.current);
      lightIntensityRafRef.current = 0;
    }
    if (lightDirectionRafRef.current) {
      cancelAnimationFrame(lightDirectionRafRef.current);
      lightDirectionRafRef.current = 0;
    }
    pendingLightIntensityRef.current = null;
    pendingLightDirectionRef.current = null;
    const light = normalizeLightDefaults(defaults);
    setLightIntensity(light.intensity);
    setLightAzimuth(light.azimuth);
    setLightElevation(light.elevation);
  }, [defaults]);

  useEffect(() => () => {
    if (lightIntensityRafRef.current) cancelAnimationFrame(lightIntensityRafRef.current);
    if (lightDirectionRafRef.current) cancelAnimationFrame(lightDirectionRafRef.current);
  }, []);

  // Re-read prefs when settings are saved from the Shell-level SettingsMenu
  useEffect(() => {
    if (!settingsVersion) return;
    const merged = getInitialDefaults();
    const previous = defaultsRef.current;
    setDefaults(merged);
    // These belong to the workspace. A changed default reaches a tab only while
    // the tab still uses the old one; saving other settings leaves them alone.
    const followDefault = (key, setValue, normalize) => {
      const before = normalize(previous[key]);
      const after = normalize(merged[key]);
      if (before !== after) setValue((current) => (current === before ? after : current));
    };
    followDefault("windowTemplateEnabled", setWindowTemplateEnabled, Boolean);
    followDefault("windowTextureTarget", setWindowTextureTarget, (value) => value || "auto");
    followDefault("backgroundColor", setBackgroundColor, (value) => value || DEFAULT_BG);
    setCameraControlsInPanel(Boolean(merged.cameraControlsInPanel));
    setShowGrid(Boolean(merged.showGrid));
    setShowShadows(Boolean(merged.showShadows));
    setAmbientOcclusion(Boolean(merged.ambientOcclusion));
    // Open paint follows a new base body colour; saving other settings keeps it.
    if (merged.bodyColor !== defaultsRef.current.bodyColor) {
      setBodyColor(merged.bodyColor);
      setVehiclePaint(buildVehiclePaint(merged.bodyColor));
      multi.repaintAll(merged.bodyColor);
    }
    const hk = getInitialHotkeys();
    setHotkeys(hk);
  }, [settingsVersion]);

  const isBooting = !booted;
  const selectedPreviewPresetCount = previewCapturePresets.length;
  const allPreviewPresetsSelected = selectedPreviewPresetCount === PREVIEW_CAPTURE_PRESET_KEYS.length;
  const previewCaptureTooltip = allPreviewPresetsSelected
    ? "Generate preview screenshots from all 5 angles"
    : selectedPreviewPresetCount > 0
      ? `Generate preview screenshots from ${selectedPreviewPresetCount} selected angle${selectedPreviewPresetCount === 1 ? "" : "s"}`
      : "Generate preview screenshots";

  const togglePreviewCapturePreset = useCallback((presetKey) => {
    setPreviewCapturePresets((current) =>
      current.includes(presetKey)
        ? current.filter((value) => value !== presetKey)
        : PREVIEW_CAPTURE_PRESET_KEYS.filter((key) => key === presetKey || current.includes(key)),
    );
  }, []);

  const toggleAllPreviewCapturePresets = useCallback(() => {
    setPreviewCapturePresets((current) =>
      current.length === PREVIEW_CAPTURE_PRESET_KEYS.length ? [] : [...PREVIEW_CAPTURE_PRESET_KEYS],
    );
  }, []);

  const modelExtensions =
    textureMode === "eup"
      ? ["yft", "clmesh", "dff", "ydd"]
      : ["yft", "clmesh", "dff"];
  const modelDropLabel = modelExtensions.map((ext) => `.${ext}`).join(" / ");

  // `rename: false` keeps the tab's name, for a tab reopened from a saved vehicle.
  const loadModel = useCallback(
    async (path, { rename = true, autoTexture = false } = {}) => {
      if (!path) return;

      setFormatWarning(null);

      const lower = path.toString().toLowerCase();
      if (lower.endsWith(".obj")) {
        setDialogError(
          "out of sheer respect for vehicle devs and those who pour their hearts and souls into their creations, .OBJ files will never be supported.",
        );
        return;
      }

      if (lower.endsWith(".yft") && !lower.endsWith("_hi.yft") && loadPrefs()?.defaults?.warnStandardModel !== false) {
        const hiPath = path.replace(/\.yft$/i, "_hi.yft");
        setFormatWarning({ type: "non-hi-model", path, hiPath: "", hiChecked: false, loadOptions: { rename, autoTexture } });
        // Offer the _hi model when it sits beside this one.
        if (isTauriRuntime) {
          fsExists(hiPath).catch(() => null).then((found) => {
            if (found == null) return;
            setFormatWarning((current) => (current?.type === "non-hi-model" && current.path === path
              ? { ...current, hiPath: found ? hiPath : "", hiChecked: true }
              : current));
          });
        }
      }

      setDialogError("");
      setGeneratedTemplateMap(null);
      setTemplateMapError("");
      setTextureTargets([]);
      setTextureTarget(textureModeRef.current === "vehicle" ? PAINT_TARGET : "all");
      setLiveryTarget("");
      setLiveryLabel("");
      // A new model starts from the Settings default; restore applies a saved pick after this.
      setWindowTextureTarget(defaultsRef.current.windowTextureTarget || "auto");
      setWindowLiveryTarget("");
      setWindowLiveryLabel("");
      setModelSourcePath(path);
      // A new model stands the way the loader puts it; restore applies a saved turn after this.
      setModelRotation(null);
      if (autoTexture) setAutoTextureRequest({ path });
      setModelLoading(true);

      try {
        setModelPath(path);
        // Auto-rename the tab to the loaded filename
        const fileName = path.split(/[\\/]/).pop();

        if (fileName && onRenameTab && rename) onRenameTab(fileName);
      } catch (error) {
        const message =
          typeof error === "string"
            ? error
            : error && typeof error === "object" && "message" in error
              ? error.message
              : "Model load failed.";
        setDialogError(message);
        setModelPath("");
        console.error(error);
      } finally {
        setModelLoading(false);
      }
    },
    [isTauriRuntime],
  );

  useEffect(() => {
    if (!viewerReady) return;

    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const elapsed = now - bootStartRef.current;
    const remaining = Math.max(0, MIN_LOADER_MS - elapsed);

    if (bootTimerRef.current) {
      clearTimeout(bootTimerRef.current);
    }

    bootTimerRef.current = setTimeout(() => {
      setBooted(true);
    }, remaining);

    return () => {
      if (bootTimerRef.current) {
        clearTimeout(bootTimerRef.current);
      }
    };
  }, [viewerReady]);

  // Saving waits until a restore has applied everything, so a half-restored
  // tab never overwrites its workspace. After that an empty tab saves as
  // empty, so a model or texture the user removed stays removed.
  const [restoreSettled, setRestoreSettled] = useState(() => !initialState);
  const sessionSaveTimerRef = useRef(null);
  const lastSavedSnapshotRef = useRef("");
  useEffect(() => {
    if (isBooting || !restoreSettled || !shellTab?.workspaceId) return;
    // A model that failed to load (a disconnected drive, a parse error) keeps
    // its source path; saving now would wipe the project's per-model setup.
    if (!modelPath && modelSourcePath) return;

    if (sessionSaveTimerRef.current) clearTimeout(sessionSaveTimerRef.current);
    sessionSaveTimerRef.current = setTimeout(() => {
      const stateSnapshot = {
        textureMode,
        modelPath: modelPath || "",
        modelSourcePath: modelSourcePath || "",
        modelRotation,
        texturePath: texturePath || "",
        textureAuto: Boolean(texturePath) && texturePath === autoTexturePathRef.current,
        textureTarget,
        windowTexturePath: windowTexturePath || "",
        windowTextureTarget,
        windowTemplateEnabled,
        bodyColor,
        vehiclePaint,
        backgroundColor,
        backgroundImagePath,
        backgroundImageBlur,
        showWireframe,
        showCageWireframe,
        showSolidWireframe,
        lightIntensity,
        lightAzimuth,
        lightElevation,
        stage,
        // EUP tabs saved before EUP had a showroom stored a vehicle default in `stage`.
        eupStage: textureMode === "eup" ? stage : undefined,
        stageSpot,
        stageReflect,
        stageBeam,
        stageLight,
        stageFloor,
        turntable,
        turntableSpeed,
        glossiness,
        liveryExteriorOnly,
        nativeMaterialsEnabled,
        lineup: multi.lineup,
        multiGizmoVisible: multi.gizmoVisible,
        multiShowroom: multi.showroom,
        // Mod kit parts chosen in Vehicle or Sirens: { path, kitName, mods } or null.
        vehicleMods: modkits.savedSelection,
        extras: modelPath ? { path: modelPath, ...normalizeExtrasState(extrasState) } : null,
        licensePlate: plateOverride,
        savedVehicle,
        gameLivery: gameLivery != null ? { path: modelPath, number: gameLivery } : null,
        liverySet: liverySet && (liverySet.items.length || liverySet.removed?.length || liverySet.pattern)
          ? { path: modelPath, pattern: liverySet.pattern, items: liverySet.items.map(({ id, path, number }) => ({ id, path, number })), removed: liverySet.removed || [] }
          : null,
        clothingSet: clothingSet?.items.length
          ? { path: modelPath, items: clothingSet.items.map(({ id, path, letter }) => ({ id, path, letter })) }
          : null,
        // Front wheel angle, for the model it was set on.
        steering: modelPath && steering.path === modelPath ? { path: modelPath, angle: steering.angle } : null,
        vehicleFolder: textureMode === "vehicle" && vehicleFolder ? vehicleFolder : null,
        vehicleFolderView: textureMode === "vehicle" && vehicleFolder ? folderView : null,
        // Lights panel choices; the siren setting itself is reread from the model's files.
        vehicleLights: {
          switches: lightPreview.switches,
          muted: lightPreview.muted,
          speed: lightPreview.speed,
          spill: lightPreview.spill,
          spillStrength: lightPreview.spillStrength,
          glow: lightPreview.glow,
          haze: lightPreview.haze,
          lens: lightPreview.lens,
        },
        materials: {
          type: materialType,
          lightIntensity: matLightIntensity,
          glossiness: matGlossiness,
          roughness: matRoughness,
          clearcoat: matClearcoat,
          textures: materialTextures.map(({ id, name, path }) => ({ id, name, path })),
        },
      };
      // Skip the localStorage round trip when nothing actually changed.
      let serialized = "";
      try {
        serialized = JSON.stringify(stateSnapshot);
      } catch {}
      const snapshotKey = `${shellTab.workspaceId}::${serialized}`;
      if (serialized && lastSavedSnapshotRef.current === snapshotKey) return;
      lastSavedSnapshotRef.current = snapshotKey;
      try {
        updateWorkspace(shellTab.workspaceId, { state: stateSnapshot });
      } catch {}
    }, 1000);

    return () => {
      if (sessionSaveTimerRef.current) clearTimeout(sessionSaveTimerRef.current);
    };
  }, [
    isBooting, restoreSettled, textureMode,
    modelPath, modelSourcePath, modelRotation, texturePath, textureTarget, windowTexturePath, windowTextureTarget, windowTemplateEnabled,
    bodyColor, vehiclePaint, backgroundColor, backgroundImagePath, backgroundImageBlur, showWireframe, showCageWireframe, showSolidWireframe,
    lightIntensity, lightAzimuth, lightElevation, glossiness, liveryExteriorOnly, nativeMaterialsEnabled,
    stage, stageSpot, stageReflect, stageBeam, stageLight, stageFloor, turntable, turntableSpeed,
    multi.lineup, multi.gizmoVisible, multi.showroom, multi.slots,
    modkits.savedSelection, extrasState, plateOverride, savedVehicle, gameLivery, liverySet, clothingSet, steering, vehicleFolder, folderView,
    lightPreview.switches, lightPreview.muted, lightPreview.speed, lightPreview.spill, lightPreview.spillStrength, lightPreview.glow, lightPreview.haze, lightPreview.lens,
    materialType, matLightIntensity, matGlossiness, matRoughness, matClearcoat, materialTextures,
    shellTab,
  ]);

  // A siren draft not yet written to a carcols.meta makes the Shell ask before
  // this tab or the window closes.
  const shellTabId = shellTab?.id;
  useEffect(() => {
    if (!shellTabId) return undefined;
    setUnsavedChanges(shellTabId, sirenEditor.dirty ? "siren" : els.dirty ? "els" : null);
    return () => setUnsavedChanges(shellTabId, null);
  }, [shellTabId, sirenEditor.dirty, els.dirty]);

  // Saves the loaded vehicle's setup to the library Home opens from. Updates
  // the linked entry unless `asNew`; a name already in the library replaces it.
  const saveVehicle = useCallback((name, { asNew = false } = {}) => {
    const now = Date.now();
    const entry = captureSavedVehicle({
      id: !asNew && savedVehicle ? savedVehicle.id : generateSavedVehicleId(now),
      name,
      now,
      mode: textureMode,
      modelPath,
      vehiclePaint,
      bodyColor,
      vehicleMods: modkits.savedSelection,
      livery: gameLivery,
      extras: extrasState,
      // The plate shown, including one that still follows the Settings default.
      plate: licensePlate,
      texturePath,
      windowTexturePath,
      textureTarget,
      windowTextureTarget,
      windowTemplateEnabled,
    });
    if (!entry) return { ok: false, error: "Saving needs a name and a loaded .yft, .clmesh or .dff model." };
    const result = upsertSavedVehicle(loadSavedVehicles(), entry);
    if (result.error === "full") {
      return { ok: false, error: `Home keeps up to ${MAX_SAVED_VEHICLES} saved vehicles. Delete one there, or replace one by saving under its name.` };
    }
    if (!result.entry || !writeSavedVehicles(result.store)) {
      return { ok: false, error: "The vehicle wasn't saved: app storage refused the write." };
    }
    setSavedVehicleEntry({ id: result.entry.id, name: result.entry.name, path: modelPath });
    showToast(`Saved ${result.entry.name}. Open it from Home.`);
    return { ok: true, entry: result.entry };
  }, [savedVehicle, textureMode, modelPath, vehiclePaint, bodyColor, modkits.savedSelection, gameLivery, extrasState, licensePlate, texturePath, windowTexturePath, textureTarget, windowTextureTarget, windowTemplateEnabled, showToast]);

  // The vehicle renamer moved the loaded model's files: reopen it at the new
  // path and carry what is keyed by path (mods, livery, extras, the saved-vehicle link),
  // and point saved vehicles on the old path at the new one.
  const reloadMovedModel = useCallback(async (newPath) => {
    const oldPath = modelPath;
    const link = savedVehicle;
    const mods = modkits.savedSelection;
    const livery = gameLivery;
    const extras = extrasState;
    const rotation = modelRotation;
    await loadModel(newPath);
    setModelRotation(rotation);
    if (!oldPath || !newPath || oldPath === newPath) return;
    setExtrasStateEntry({ ...extras, path: newPath });
    if (mods) modkits.restore({ ...mods, path: newPath });
    if (livery != null) setGameLiveryEntry({ path: newPath, number: livery });
    const { store, moved } = moveSavedVehicleModel(loadSavedVehicles(), oldPath, newPath, Date.now());
    if (moved && !writeSavedVehicles(store)) {
      showToast("Saved vehicles still point at the old model path: app storage refused the write.", "error");
    }
    if (link) setSavedVehicleEntry({ ...link, path: newPath });
  }, [modelPath, modelRotation, savedVehicle, modkits, gameLivery, extrasState, loadModel, showToast]);

  const scheduleReload = (kind) => {
    const key = kind === "window" ? "window" : "primary";
    const timers = reloadTimerRef.current;
    if (timers[key]) clearTimeout(timers[key]);
    timers[key] = setTimeout(() => {
      if (key === "window") setWindowTextureReloadToken((prev) => prev + 1);
      else setTextureReloadToken((prev) => prev + 1);
    }, 350);
  };

  const togglePanel = useCallback((key) => {
    setPanelOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  // Stable identities so memo(Viewer)/memo(MultiModelViewer) are not defeated
  // by fresh arrows on every App render.
  const handleViewerReady = useCallback((api) => {
    viewerApiRef.current = api;
    setViewerReady(true);
  }, []);
  const handleMultiViewerReady = useCallback((api) => {
    multiViewerApiRef.current = api;
    setViewerReady(true);
  }, []);

  const handleModelInfo = useCallback((info) => {
    setMetaModelInfo(info || null);
    const targets = info?.targets ?? [];
    setTextureTargets(targets);
    setGeneratedTemplateMap(info?.templateMap || null);
    setTemplateMapError(info?.templateMapError || "");
    setLiveryTarget(info?.liveryTarget || "");
    setLiveryLabel(info?.liveryLabel || "");
    setWindowLiveryTarget(info?.windowTarget || "");
    setWindowLiveryLabel(info?.windowLabel || "");
    setTextureTarget((prev) => {
      if (prev === "all" || prev === PAINT_TARGET) return prev;
      if (targets.some((target) => target.value === prev)) return prev;
      return textureModeRef.current === "vehicle" ? PAINT_TARGET : "all";
    });
    setWindowTextureTarget((prev) => {
      if (prev === "all" || prev === "none" || prev === "auto") return prev;
      return targets.some((target) => target.value === prev) ? prev : defaultsRef.current.windowTextureTarget || "auto";
    });

    if (Object.prototype.hasOwnProperty.call(info || {}, "nativeMaterials")) {
      const nativeSummary = info?.nativeMaterials || {};
      setNativeMaterialsStatus(
        nativeSummary.available
          ? { ...nativeSummary, state: "available", available: true }
          : {
              state: "unavailable",
              available: false,
              message: "No CodeWalker material bindings were found for this model.",
            },
      );
    } else {
      setNativeMaterialsStatus({ state: "idle", available: false });
    }
  }, []);

  useEffect(() => {
    if (!windowTemplateEnabled) return;
    setWindowTextureTarget((prev) => {
      if (prev === "auto") return prev;
      if (prev !== "none") return prev;
      return windowLiveryTarget || prev;
    });
  }, [windowTemplateEnabled, windowLiveryTarget]);

  useEffect(() => {
    if (windowTemplateEnabled) return;
    setWindowTextureError("");
  }, [windowTemplateEnabled]);

  const handleTextureError = useCallback((message) => {
    setTextureError(message || "");
    // If texture failed to load, clear the stale path
    if (message) setTexturePath("");
  }, []);

  const handleWindowTextureError = useCallback((message) => {
    setWindowTextureError(message || "");
    // If window texture failed to load, clear the stale path
    if (message) setWindowTexturePath("");
  }, []);

  const handleFormatWarning = useCallback((warning) => {
    setFormatWarning(warning);
  }, []);

  const handleModelLoading = useCallback((loading) => {
    setModelLoading(Boolean(loading));
  }, []);

  const handleNativeMaterialsStatus = useCallback((status) => {
    const next = status && typeof status === "object"
      ? status
      : { state: "idle", available: false };
    setNativeMaterialsStatus((current) => {
      if (!next.available && (next.state === "idle" || next.state === "unavailable")) {
        return next;
      }
      if (next.state === "disabled") {
        return {
          ...current,
          ...next,
          message: "",
          plannedTextureCount: 0,
          loadedTextureCount: 0,
          failedTextureCount: 0,
          failures: [],
        };
      }
      if (next.state === "loading" && current.state !== "loading") {
        return {
          ...current,
          ...next,
          message: "",
          loadedTextureCount: next.loadedTextureCount || 0,
          failedTextureCount: next.failedTextureCount || 0,
          failures: [],
        };
      }
      return {
        ...current,
        ...next,
        message: Object.prototype.hasOwnProperty.call(next, "message") ? next.message : "",
      };
    });
  }, []);

  const handleModelError = useCallback((message) => {
    setDialogError(message || "Failed to load model.");
    setGeneratedTemplateMap(null);
    setTemplateMapError("");
    setNativeMaterialsStatus({ state: "idle", available: false });
    setModelPath("");
  }, []);

  const handleDownloadTemplateMap = useCallback(() => {
    if (!generatedTemplateMap) {
      showToast("No template map available yet.");
      return;
    }

    const sourceName =
      generatedTemplateMap?.source?.fileName ||
      getFileLabel(modelSourcePath || modelPath, "model");
    const stem = (sourceName || "model").toString().replace(/\.[^.]+$/, "");
    const fileName = `${stem}.template-map.v1.json`;

    try {
      const json = JSON.stringify(generatedTemplateMap, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
      showToast(`Downloaded ${fileName}`);
    } catch (error) {
      console.error("Template map download failed:", error);
      showToast("Template map download failed.");
    }
  }, [generatedTemplateMap, modelPath, modelSourcePath, showToast]);

  const applyAndPersistDefaults = useCallback((next) => {
    const merged = { ...BUILT_IN_DEFAULTS, ...(next || {}) };
    setDefaults(merged);
    setLiveryExteriorOnly(Boolean(merged.liveryExteriorOnly));
    setWindowTemplateEnabled(Boolean(merged.windowTemplateEnabled));
    setWindowTextureTarget(merged.windowTextureTarget || "auto");


    setCameraControlsInPanel(Boolean(merged.cameraControlsInPanel));
    setShowGrid(Boolean(merged.showGrid));
    setShowShadows(Boolean(merged.showShadows));
    setAmbientOcclusion(Boolean(merged.ambientOcclusion));
    setBodyColor(merged.bodyColor);
    setVehiclePaint(buildVehiclePaint(merged.bodyColor));
    multi.repaintAll(merged.bodyColor);
    setBackgroundColor(merged.backgroundColor);
    const prefs = loadPrefs() || {};

    savePrefs({ ...prefs, defaults: merged });
  }, []);

  const saveHotkeys = useCallback((next) => {
    setHotkeys(next);
    const prefs = loadPrefs() || {};
    savePrefs({ ...prefs, hotkeys: next });
  }, []);

  const setGlobalRenderEffect = useCallback((key, nextValue) => {
    const currentPrefs = loadPrefs() || {};
    const storedDefaults = sanitizeStoredDefaults(currentPrefs.defaults);
    const mergedDefaults = { ...BUILT_IN_DEFAULTS, ...storedDefaults };
    const resolvedValue =
      typeof nextValue === "function" ? Boolean(nextValue(Boolean(mergedDefaults[key]))) : Boolean(nextValue);
    const nextDefaults = { ...mergedDefaults, [key]: resolvedValue };

    savePrefs({ ...currentPrefs, defaults: nextDefaults });
    // Not emitPrefsUpdated: that reloads every default and drops view state
    // such as Exterior Only. Every open viewer, this one included, applies it.
    emitRenderEffectChanged(key, resolvedValue);
  }, []);

  useEffect(() => {
    const handleRenderEffect = (event) => {
      const { key, value } = event.detail || {};
      if (key === "showShadows") setShowShadows(Boolean(value));
      else if (key === "showGrid") setShowGrid(Boolean(value));
      else if (key === "ambientOcclusion") setAmbientOcclusion(Boolean(value));
      else return;
      setDefaults((prev) => ({ ...prev, [key]: Boolean(value) }));
    };
    window.addEventListener(RENDER_EFFECT_EVENT, handleRenderEffect);
    return () => window.removeEventListener(RENDER_EFFECT_EVENT, handleRenderEffect);
  }, []);

  const toggleGlobalRenderEffect = useCallback((key) => {
    setGlobalRenderEffect(key, (prev) => !prev);
  }, [setGlobalRenderEffect]);

  useEffect(() => {
    const prefs = loadPrefs() || {};
    const ui = { ...(prefs.ui || {}), colorsOpen: panelOpen.colors };
    savePrefs({ ...prefs, ui });
  }, [panelOpen.colors]);

  const selectModelRef = useRef(null);
  // Set while a folder lists vehicles; the step hotkeys call it.
  const stepFolderVehicleRef = useRef(null);
  const selectTextureRef = useRef(null);
  const selectWindowTextureRef = useRef(null);

  const applyRestoredState = useCallback(async (state) => {
    const fileOk = async (p) => {
      if (!p) return false;
      try { return await fsExists(p); } catch { return false; }
    };

    // Restore non-path settings immediately
    let resolvedTextureMode = normalizeTextureMode(state.textureMode);
    if (!resolvedTextureMode && typeof state.openFile === "string") {
      const openFileLower = state.openFile.toLowerCase();
      if (openFileLower.endsWith(".ydd")) {
        resolvedTextureMode = "eup";
      } else if (openFileLower.endsWith(".yft")) {
        resolvedTextureMode = "vehicle";
      }
    }
    if (resolvedTextureMode) {
      setTextureMode(resolvedTextureMode);
      // loadModel below runs before the next render and reads the mode from the ref.
      textureModeRef.current = resolvedTextureMode;
    }
    if (typeof state.windowTemplateEnabled === "boolean") setWindowTemplateEnabled(state.windowTemplateEnabled);
    if (state.bodyColor) setBodyColor(state.bodyColor);
    // Tabs saved before paint followed the game palette stored `vehicleSlotColors`.
    const savedPaint = state.vehiclePaint || state.vehicleSlotColors;
    if (savedPaint || state.bodyColor) setVehiclePaint(normalizeVehiclePaint(savedPaint, state.bodyColor || DEFAULT_BODY));
    if (state.backgroundColor) setBackgroundColor(state.backgroundColor);
    if (typeof state.backgroundImageBlur === "number") {
      setBackgroundImageBlur(clampBackgroundImageBlur(state.backgroundImageBlur));
    }
    if (typeof state.showWireframe === "boolean") setShowWireframe(state.showWireframe);
    if (typeof state.showCageWireframe === "boolean") setShowCageWireframe(state.showCageWireframe);
    if (typeof state.showSolidWireframe === "boolean") setShowSolidWireframe(state.showSolidWireframe);
    if (typeof state.lightIntensity === "number") setLightIntensity(state.lightIntensity);
    if (typeof state.lightAzimuth === "number") setLightAzimuth(state.lightAzimuth);
    if (typeof state.lightElevation === "number") setLightElevation(state.lightElevation);
    const savedStage = (resolvedTextureMode || textureMode) === "eup" ? state.eupStage : state.stage;
    if (savedStage === "workbench" || savedStage === "showroom") setStage(savedStage);
    // An EUP tab saved before EUP had a showroom holds vehicle values here; it keeps the EUP scene.
    const ownsShowroom = (resolvedTextureMode || textureMode) !== "eup" || savedStage !== undefined;
    if (ownsShowroom) {
      if (typeof state.stageSpot === "number") setStageSpot(Math.min(2, Math.max(0, state.stageSpot)));
      if (typeof state.stageReflect === "number") setStageReflect(Math.min(1, Math.max(0, state.stageReflect)));
      if (typeof state.stageBeam === "boolean") setStageBeam(state.stageBeam);
      if (SHOWROOM_LIGHT_KEYS.includes(state.stageLight)) setStageLight(state.stageLight);
      if (SHOWROOM_FLOORS.includes(state.stageFloor)) setStageFloor(state.stageFloor);
    }
    if (typeof state.turntable === "boolean") setTurntable(state.turntable);
    if (state.turntableSpeed != null) setTurntableSpeed(normalizeTurntableSpeed(state.turntableSpeed));
    if (typeof state.glossiness === "number") setGlossiness(state.glossiness);
    if (typeof state.liveryExteriorOnly === "boolean") setLiveryExteriorOnly(state.liveryExteriorOnly);
    if (typeof state.nativeMaterialsEnabled === "boolean") setNativeMaterialsEnabled(state.nativeMaterialsEnabled);
    // Lights and Materials panels; tabs saved before these were kept start from the defaults.
    const savedLights = normalizeSavedLightPreview(state.vehicleLights);
    if (savedLights) setLightPreview((current) => ({ ...current, ...savedLights }));
    const savedMaterials = normalizeSavedMaterials(state.materials);
    if (savedMaterials) {
      setMaterialType(savedMaterials.type);
      setMatLightIntensity(savedMaterials.lightIntensity);
      setMatGlossiness(savedMaterials.glossiness);
      setMatRoughness(savedMaterials.roughness);
      setMatClearcoat(savedMaterials.clearcoat);
      setMaterialTextures(savedMaterials.textures);
    }
    // Multi lineup, including tabs saved with the earlier A/B fields.
    multi.restore(state, state.bodyColor || DEFAULT_BODY);

    // Restore file paths (best effort). Some environments can report false negatives
    // on fs existence checks for previously approved paths.
    autoTexturePathRef.current = state.textureAuto === true && typeof state.texturePath === "string" ? state.texturePath : "";
    if (typeof state.vehicleFolder === "string" && state.vehicleFolder) {
      setVehicleFolder(state.vehicleFolder);
      setFolderView(state.vehicleFolderView === "pack" ? "pack" : "vehicle");
    }
    const initialModelPath = [state.modelSourcePath, state.modelPath, state.openFile].find((path) => typeof path === "string" && path) || "";
    if (initialModelPath) {
      // A tab opened from a saved vehicle keeps the vehicle's name.
      // A file opened with Cortex Studio is a fresh pick; a saved tab keeps its own texture choice.
      const freshOpen = typeof state.openFile === "string" && Boolean(state.openFile) && !state.texturePath;
      await loadModel(initialModelPath, { rename: !state.savedVehicle?.id, autoTexture: freshOpen });
      setModelRotation(normalizeModelRotation(state.modelRotation));
      // loadModel resets the mesh targets for a new model; the saved ones are
      // the user's picks and win. handleModelInfo drops any the model lacks.
      // A Livery or All tab saved before Vehicle mode keeps the targets it meant.
      const savedTargets = savedVehicleTargets(state);
      if (savedTargets.textureTarget) setTextureTarget(savedTargets.textureTarget);
      if (savedTargets.windowTextureTarget) setWindowTextureTarget(savedTargets.windowTextureTarget);
      const savedSteering = normalizeSavedSteering(state.steering, initialModelPath);
      if (savedSteering) setSteering(savedSteering);
      // Saved for this model only; the parts load once the resource is scanned.
      if (state.vehicleMods?.path === initialModelPath) modkits.restore(state.vehicleMods);
      // Extras and the saved-vehicle link are per model, like the mods.
      if (state.extras && (state.extras.path || initialModelPath) === initialModelPath) {
        setExtrasStateEntry({ path: initialModelPath, ...normalizeExtrasState(state.extras) });
      }
      if (Number.isInteger(state.gameLivery?.number) && state.gameLivery.path === initialModelPath) {
        setGameLiveryEntry({ path: initialModelPath, number: state.gameLivery.number });
      }
      const restoredLiveries = state.liverySet?.path === initialModelPath ? normalizeLiverySet(state.liverySet) : null;
      if (restoredLiveries) setLiverySetEntries({ [initialModelPath]: { path: initialModelPath, ...restoredLiveries } });
      const restoredClothing = state.clothingSet?.path === initialModelPath ? normalizeClothingSet(state.clothingSet) : null;
      if (restoredClothing) setClothingSetEntries({ [initialModelPath]: { path: initialModelPath, ...restoredClothing } });
      if (state.savedVehicle?.id && state.savedVehicle.path === initialModelPath) {
        setSavedVehicleEntry({ id: state.savedVehicle.id, name: String(state.savedVehicle.name || ""), path: initialModelPath });
      }
    }
    if (state.licensePlate && typeof state.licensePlate === "object") setPlateOverride(normalizePlateDefault(state.licensePlate));
    if (state.texturePath && (await fileOk(state.texturePath))) setTexturePath(state.texturePath);
    else if (state.texturePath) setTexturePath(state.texturePath);
    if (state.backgroundImagePath && (await fileOk(state.backgroundImagePath))) setBackgroundImagePath(state.backgroundImagePath);
    else if (state.backgroundImagePath) setBackgroundImagePath(state.backgroundImagePath);
    if (state.windowTexturePath && (await fileOk(state.windowTexturePath))) setWindowTexturePath(state.windowTexturePath);
    else if (state.windowTexturePath) setWindowTexturePath(state.windowTexturePath);
  }, [loadModel, multi.restore, modkits.restore]);

  const restoreState = useCallback(async (state) => {
    if (!state) return;
    try {
      await applyRestoredState(state);
    } finally {
      setRestoreSettled(true);
    }
  }, [applyRestoredState]);

  // Auto-restore workspace state from initialState prop (passed by Shell from workspace)
  useEffect(() => {
    if (initialStateRestoredRef.current) return;
    if (!initialState) return;
    initialStateRestoredRef.current = true;
    restoreState(initialState);
  }, [initialState, restoreState]);

  const selectModel = async () => {
    if (textureMode === "multi") return selectMultiModel(multi.selectedId);
    if (!isTauriRuntime) {
      setDialogError("Tauri runtime required for file dialog.");
      return;
    }
    try {
      const selected = await open({
        filters: [{ name: "Model", extensions: modelExtensions }],
      });
      setDialogError("");
      if (typeof selected === "string") {
        await loadModel(selected, { autoTexture: true });
      }
    } catch (error) {
      setDialogError("Dialog permission blocked. Check Tauri capabilities.");
      console.error(error);
    }
  };

  // A folder of vehicles for the Pack view. The picker grants the folder and
  // everything under it for this session.
  const openVehicleFolder = async () => {
    if (!isTauriRuntime) {
      setDialogError("Tauri runtime required for file dialog.");
      return;
    }
    try {
      const openedFrom = (modelSourcePath || modelPath).replace(/[\\/][^\\/]*$/, "");
      const selected = await open({ directory: true, recursive: true, title: "Open a folder of vehicles", defaultPath: vehicleFolder || openedFrom || undefined });
      setDialogError("");
      if (typeof selected !== "string") return;
      if (selected === vehicleFolder) folderScan.rescan();
      else {
        setSnapshotRun(null);
        setSnapshotResult(null);
        setVehicleFolder(selected);
        setVehicleFilter("");
      }
      setFolderView("pack");
    } catch (error) {
      setDialogError("Dialog permission blocked. Check Tauri capabilities.");
      console.error(error);
    }
  };

  // Opens a vehicle from the folder to work on, in the Vehicle view. A pass
  // taking snapshots stops there: the user picked where to be.
  const openFolderVehicle = (vehicle) => {
    if (!vehicle?.path) return;
    setSnapshotRun(null);
    setFolderView("vehicle");
    // The open vehicle reloads only after its load failed.
    if (vehicle.path === (modelSourcePath || modelPath) && modelPath) return;
    loadModel(vehicle.path, { autoTexture: true });
  };

  const stepFolderVehicle = (delta) => {
    const next = stepVehicle(folderVehicles, modelSourcePath || modelPath, delta);
    if (next) openFolderVehicle(next);
  };

  // Opens each listed vehicle without a snapshot in turn, behind the Pack
  // view, so the capture below takes its snapshot; then reopens the vehicle
  // that was open before. With none missing, it retakes them all.
  const takeSnapshots = () => {
    const missing = folderScan.vehicles.filter((vehicle) => packSnapshots.taken[vehicle.path] == null);
    const queue = (missing.length ? missing : folderScan.vehicles).map((vehicle) => vehicle.path);
    setSnapshotResult(null);
    if (!queue.length) return;
    setSnapshotRun({ queue, total: queue.length, done: 0, failed: 0, current: queue[0], returnTo: modelSourcePath || modelPath });
  };
  const stopSnapshots = () => {
    setSnapshotRun((run) => (run ? { ...run, queue: [], current: "" } : run));
  };

  const selectTexture = async () => {
    if (textureMode === "multi") return selectMultiLivery(multi.selectedId);
    if (!isTauriRuntime) {
      setDialogError("Tauri runtime required for file dialog.");
      return;
    }
    try {
      const selected = await open({
        filters: [
          {
            name: "Texture",
            extensions: [
              "png",
              "jpg",
              "jpeg",
              "webp",
              "avif",
              "bmp",
              "gif",
              "tga",
              "dds",
              "tif",
              "tiff",
              "psd",
              "ai",
              "pdn",
              ...(textureMode === "eup" ? ["ytd"] : []),
            ],
          },
        ],
      });
      setDialogError("");
      if (typeof selected === "string") {
        if (!isTextureFormatSupported(selected) && !(textureMode === "eup" && isYtdTexturePath(selected))) {
          setFormatWarning({ type: "unsupported-format", ext: getFileExtension(selected), path: selected.split(/[\\/]/).pop() });
          return;
        }
        setTextureError("");
        setTexturePath(selected);
      }
    } catch (error) {
      setDialogError("Dialog permission blocked. Check Tauri capabilities.");
      console.error(error);
    }
  };

  // Window controls are handled by Shell

  // In Multi, `slotId` picks the lineup slot; click events fall back to the selected one.
  const selectWindowTexture = async (slotId) => {
    const targetSlotId = typeof slotId === "string" && slotId ? slotId : multi.selectedId;
    if (!isTauriRuntime) {
      setDialogError("Tauri runtime required for file dialog.");
      return;
    }
    try {
      const selected = await open({
        filters: [
          {
            name: "Texture",
            extensions: [
              "png",
              "jpg",
              "jpeg",
              "webp",
              "avif",
              "bmp",
              "gif",
              "tga",
              "dds",
              "tif",
              "tiff",
              "psd",
              "ai",
              "pdn",
            ],
          },
        ],
      });
      setDialogError("");
      if (typeof selected === "string") {
        if (!isTextureFormatSupported(selected)) {
          setFormatWarning({ type: "unsupported-format", ext: getFileExtension(selected), path: selected.split(/[\\/]/).pop() });
          return;
        }
        if (textureMode === "multi") {
          multi.updateSlot(targetSlotId, { windowPath: selected });
          return;
        }
        setWindowTextureError("");
        setWindowTexturePath(selected);
      }
    } catch (error) {
      setDialogError("Dialog permission blocked. Check Tauri capabilities.");
      console.error(error);
    }
  };

  const selectBackgroundImage = async () => {
    if (!isTauriRuntime) {
      setDialogError("Tauri runtime required for file dialog.");
      return;
    }
    try {
      const selected = await open({
        filters: [
          {
            name: "Background Image",
            extensions: [
              "png",
              "jpg",
              "jpeg",
              "webp",
              "avif",
              "bmp",
              "gif",
              "tga",
              "dds",
              "tif",
              "tiff",
              "psd",
              "ai",
              "pdn",
            ],
          },
        ],
      });
      setDialogError("");
      if (typeof selected === "string") {
        if (!isTextureFormatSupported(selected)) {
          setFormatWarning({ type: "unsupported-format", ext: getFileExtension(selected), path: selected.split(/[\\/]/).pop() });
          return;
        }
        setBackgroundImagePath((prev) => {
          if (prev === selected) {
            setBackgroundImageReloadToken((token) => token + 1);
          }
          return selected;
        });
      }
    } catch (error) {
      setDialogError("Dialog permission blocked. Check Tauri capabilities.");
      console.error(error);
    }
  };

  const multiTextureExts = ["png", "jpg", "jpeg", "webp", "avif", "bmp", "gif", "tga", "dds", "tif", "tiff", "psd", "ai", "pdn"];

  // Material texture upload handler
  const selectMaterialTexture = async () => {
    if (!isTauriRuntime) return;
    try {
      const selected = await open({
        multiple: true,
        filters: [{ name: "Texture", extensions: ["png", "jpg", "jpeg", "webp", "dds", "tga", "tif", "tiff", "psd", "bmp"] }],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const newTextures = paths.map((p) => ({
        id: `mat-tex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: p.split(/[\\/]/).pop(),
        path: p,
        thumbnail: null,
      }));
      setMaterialTextures((prev) => [...prev, ...newTextures].slice(0, 6));
    } catch { /* dialog blocked */ }
  };

  const removeMaterialTexture = useCallback((index) => {
    setMaterialTextures((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const selectMultiModel = async (slotId) => {
    if (!isTauriRuntime) {
      setDialogError("Tauri runtime required for file dialog.");
      return;
    }
    try {
      const selected = await open({ filters: [{ name: "Vehicle model", extensions: [...VEHICLE_MODEL_EXTENSIONS] }] });
      if (typeof selected !== "string") return;
      setDialogError("");
      multi.setModel(slotId || multi.selectedId, selected);
    } catch (error) {
      setDialogError("Dialog permission blocked. Check Tauri capabilities.");
      console.error(error);
    }
  };

  const selectMultiLivery = async (slotId) => {
    if (!isTauriRuntime) {
      setDialogError("Tauri runtime required for file dialog.");
      return;
    }
    try {
      const selected = await open({ filters: [{ name: "Livery", extensions: multiTextureExts }] });
      if (typeof selected !== "string") return;
      if (!isTextureFormatSupported(selected)) {
        setFormatWarning({ type: "unsupported-format", ext: getFileExtension(selected), path: selected.split(/[\\/]/).pop() });
        return;
      }
      setDialogError("");
      multi.updateSlot(slotId || multi.selectedId, { liveryPath: selected });
    } catch (error) {
      setDialogError("Dialog permission blocked. Check Tauri capabilities.");
      console.error(error);
    }
  };

  selectModelRef.current = selectModel;
  stepFolderVehicleRef.current = folderVehicles.length ? stepFolderVehicle : null;

  // Moves a pass past `path`, whether its snapshot was saved or not.
  const advanceSnapshotRun = useCallback((path, saved) => {
    setSnapshotRun((run) => {
      if (!run || run.current !== path) return run;
      const queue = run.queue.slice(1);
      return { ...run, queue, current: queue[0] || "", done: run.done + (saved ? 1 : 0), failed: run.failed + (saved ? 0 : 1) };
    });
  }, []);

  // Loads the pass's next vehicle, or ends the pass. A vehicle that never
  // settles (its load failed or hangs) is skipped after a while.
  const snapshotRunning = snapshotRun != null;
  const snapshotCurrent = snapshotRun?.current;
  useEffect(() => {
    const run = snapshotRun;
    if (!run) return undefined;
    if (!run.current) {
      setSnapshotRun(null);
      setSnapshotResult({ done: run.done, failed: run.failed });
      if (run.returnTo && run.returnTo !== (modelSourcePath || modelPath)) loadModel(run.returnTo);
      return undefined;
    }
    if (run.current !== (modelSourcePath || modelPath)) loadModel(run.current, { rename: false });
    const timer = setTimeout(() => advanceSnapshotRun(run.current, false), SNAPSHOT_SKIP_MS);
    return () => clearTimeout(timer);
    // Runs once per vehicle of the pass, not on every change to the run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotRunning, snapshotCurrent]);

  // A failed load moves the pass on at once. Only an error that appears while
  // a vehicle loads counts: the one already showing when the pass moves on
  // belongs to the vehicle before, and loading the next one clears it.
  const snapshotCurrentRef = useRef("");
  snapshotCurrentRef.current = snapshotCurrent || "";
  useEffect(() => {
    const current = snapshotCurrentRef.current;
    if (current && dialogError) advanceSnapshotRun(current, false);
  }, [dialogError, advanceSnapshotRun]);

  // A pass ends with the folder, Vehicle mode or this tab leaving the screen.
  useEffect(() => {
    if (!hasFolder || !isActive) setSnapshotRun(null);
    if (!hasFolder) setSnapshotResult(null);
  }, [hasFolder, isActive]);

  // The first time this session a folder vehicle is on screen with its own
  // textures settled (or it is the pass's current vehicle), the viewer takes
  // its snapshot from the camera shot every other one uses. Turning the
  // model's own textures on or off counts as a new look, worth a new one.
  const snapshotSessionRef = useRef(new Set());
  // The vehicle whose snapshot is being encoded and saved, so a rerun of the
  // effect meanwhile doesn't take a second one.
  const snapshotSavingRef = useRef("");
  const saveSnapshot = packSnapshots.save;
  useEffect(() => {
    if (!hasFolder || folderScan.status !== "ready" || !isActive || modelLoading || !modelPath) return undefined;
    const at = vehicleIndexOf(folderScan.vehicles, modelPath);
    if (at < 0) return undefined;
    const path = folderScan.vehicles[at].path;
    const look = `${path}|${nativeMaterialsEnabled ? "own" : "plain"}`;
    const wanted = snapshotCurrent ? snapshotCurrent === path : !snapshotSessionRef.current.has(look);
    if (!wanted) return undefined;
    const shown = viewerApiRef.current?.getShownModel?.();
    if (!shown?.settled || shown.path !== modelPath) return undefined;
    let cancelled = false;
    // A beat for the first frames with the model's textures to reach the GPU.
    const timer = setTimeout(async () => {
      const api = viewerApiRef.current;
      if (cancelled || snapshotSavingRef.current === path || api?.getShownModel?.()?.id !== shown.id) return;
      snapshotSessionRef.current.add(look);
      snapshotSavingRef.current = path;
      let saved = false;
      try {
        const [canvas] = api.captureShots({
          width: SNAPSHOT_WIDTH,
          height: SNAPSHOT_HEIGHT,
          shots: [{ pose: { type: "preset", presetKey: SNAPSHOT_PRESET, zoomFactor: SNAPSHOT_ZOOM } }],
        }) || [];
        const blob = canvas ? await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", SNAPSHOT_QUALITY)) : null;
        saved = blob ? await saveSnapshot(path, blob) : false;
      } catch (error) {
        console.warn("[pack] snapshot not taken:", path, error);
      } finally {
        snapshotSavingRef.current = "";
      }
      advanceSnapshotRun(path, saved);
    }, SNAPSHOT_SETTLE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [hasFolder, folderScan.status, folderScan.vehicles, isActive, modelLoading, modelPath, nativeMaterialsEnabled, nativeMaterialsStatus, snapshotCurrent, saveSnapshot, advanceSnapshotRun]);
  selectTextureRef.current = selectTexture;
  selectWindowTextureRef.current = selectWindowTexture;

  const getActiveViewerApi = useCallback(
    () => (textureMode === "multi" ? multiViewerApiRef.current : viewerApiRef.current),
    [textureMode],
  );

  const handleSetCameraPreset = useCallback((presetKey) => {
    getActiveViewerApi()?.setPreset?.(presetKey);
  }, [getActiveViewerApi]);

  const handleRotateModel = useCallback((axis) => {
    if (textureMode === "multi") {
      getActiveViewerApi()?.rotateModel?.(axis);
      return;
    }
    setModelRotation((current) => quarterTurn(current, axis));
  }, [getActiveViewerApi, textureMode]);

  const handleResetRotation = useCallback(() => setModelRotation(null), []);

  // EUP: a clothing model's own texture dictionary (its _diff_ .ytd beside it)
  // fills the texture slot when the model is picked. A texture the user chose
  // stays; only an earlier automatic pick is replaced or cleared.
  useEffect(() => {
    if (!autoTextureRequest || textureMode !== "eup") return;
    if (defaultsRef.current.eupAutoTextures === false) return;
    if (texturePath && texturePath !== autoTexturePathRef.current) return;
    let cancelled = false;
    (async () => {
      let found = "";
      for (const candidate of pieceTextureCandidates(autoTextureRequest.path).filter(isYtdTexturePath)) {
        if (await fsExists(candidate).catch(() => false)) {
          found = candidate;
          break;
        }
      }
      if (cancelled) return;
      autoTexturePathRef.current = found;
      if (found !== texturePath) {
        setTextureError("");
        setTexturePath(found);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [autoTextureRequest]);

  const handleCenterCamera = useCallback(() => {
    getActiveViewerApi()?.reset?.();
  }, [getActiveViewerApi]);

  // handleSaveViewPhoto is declared further down; the hotkey reaches it after render.
  const saveViewPhotoRef = useRef(null);
  useEffect(() => {
    saveViewPhotoRef.current = handleSaveViewPhoto;
  });

  useEffect(() => {
    if (!isActive) return undefined;

    // A shortcut only acts where its control is on screen: Sirens has no
    // texture or glass step, EUP has no glass step, the glass step is off until
    // its switch is on, and Save this view lives in the Livery, All, EUP and
    // Multi docks.
    const singleLayout = textureMode !== "multi" && textureMode !== "sirens";
    const isAvailable = (action, event) => {
      switch (action) {
        case HOTKEY_ACTIONS.SELECT_LIVERY:
          return textureMode !== "sirens";
        case HOTKEY_ACTIONS.SELECT_GLASS:
          return textureMode === "multi" || (singleLayout && textureMode !== "eup" && windowTemplateEnabled);
        case HOTKEY_ACTIONS.CAPTURE_VIEW:
          return textureMode !== "sirens" && viewerReady && !event.repeat;
        case HOTKEY_ACTIONS.PREVIOUS_VEHICLE:
        case HOTKEY_ACTIONS.NEXT_VEHICLE:
          return textureMode === "vehicle" && Boolean(stepFolderVehicleRef.current) && !event.repeat;
        default:
          return true;
      }
    };

    const handleKeyDown = (event) => {
      if (event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof Element) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (target.isContentEditable) return;
        if (target.classList.contains("hotkey-input")) return;
      }

      const action = findMatchingAction(hotkeys, event);
      if (!action || !isAvailable(action, event)) return;

      event.preventDefault();
      event.stopPropagation();

      switch (action) {
        case HOTKEY_ACTIONS.TOGGLE_EXTERIOR_ONLY:
          setLiveryExteriorOnly((prev) => !prev);
          break;
        case HOTKEY_ACTIONS.TOGGLE_SHADOWS:
          toggleGlobalRenderEffect("showShadows");
          break;
        // Mode switching removed — handled by Shell via new-tab hotkeys
        case HOTKEY_ACTIONS.TOGGLE_PANEL:
          setPanelCollapsed((prev) => !prev);
          break;
        case HOTKEY_ACTIONS.RESET_VIEW:
          getActiveViewerApi()?.reset?.();
          break;
        case HOTKEY_ACTIONS.CAMERA_PRESET_FRONT:
          getActiveViewerApi()?.setPreset?.("front");
          break;
        case HOTKEY_ACTIONS.CAMERA_PRESET_BACK:
          getActiveViewerApi()?.setPreset?.("back");
          break;
        case HOTKEY_ACTIONS.CAMERA_PRESET_SIDE:
          getActiveViewerApi()?.setPreset?.("side");
          break;
        case HOTKEY_ACTIONS.CAMERA_PRESET_ANGLE:
          getActiveViewerApi()?.setPreset?.("angle");
          break;
        case HOTKEY_ACTIONS.CAMERA_PRESET_TOP:
          getActiveViewerApi()?.setPreset?.("top");
          break;
        case HOTKEY_ACTIONS.CAPTURE_VIEW:
          saveViewPhotoRef.current?.();
          break;
        case HOTKEY_ACTIONS.SELECT_MODEL:
          selectModelRef.current?.();
          break;
        case HOTKEY_ACTIONS.SELECT_LIVERY:
          selectTextureRef.current?.();
          break;
        case HOTKEY_ACTIONS.SELECT_GLASS:
          selectWindowTextureRef.current?.();
          break;
        case HOTKEY_ACTIONS.TOGGLE_DUAL_GIZMO:
          multi.toggleGizmo("translate");
          break;
        case HOTKEY_ACTIONS.SWAP_DUAL_SLOT:
          multi.selectNext();
          break;
        case HOTKEY_ACTIONS.PREVIOUS_VEHICLE:
          stepFolderVehicleRef.current?.(-1);
          break;
        case HOTKEY_ACTIONS.NEXT_VEHICLE:
          stepFolderVehicleRef.current?.(1);
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hotkeys, getActiveViewerApi, isActive, toggleGlobalRenderEffect, textureMode, viewerReady, windowTemplateEnabled]);

  const persistPreviewFolder = useCallback(async (folder) => {
    const current = loadPrefs() || {};
    const defs = current?.defaults || {};
    savePrefs({ ...current, defaults: { ...defs, previewFolder: folder } });
  }, []);

  const promptForPreviewFolder = useCallback(async () => {
    if (!isTauriRuntime) return "";

    try {
      const selected = await open({ directory: true, title: "Select Preview Export Folder" });
      return typeof selected === "string" ? selected : "";
    } catch {
      return "";
    }
  }, [isTauriRuntime]);

  const resolveExistingFolder = useCallback(async (preferredPath, fallbackPath = "") => {
    if (!isTauriRuntime) return preferredPath || fallbackPath;
    return await resolveExistingPreviewFolderPath(preferredPath, fallbackPath, fsExists);
  }, [isTauriRuntime]);

  const handleOpenPreviewFolder = useCallback(async () => {
    if (previewFolderOpening) return;

    setPreviewFolderOpenError("");
    if (!isTauriRuntime) {
      setPreviewFolderOpenError("Open Folder is only available in the Cortex Studio desktop app.");
      return;
    }

    const prefs = loadPrefs() || {};
    const fallbackFolder = prefs?.defaults?.previewFolder || "";
    const targetFolder = await resolveExistingFolder(previewOutputPath, fallbackFolder);
    if (!targetFolder) {
      setPreviewFolderOpenError("The preview export folder could not be found. Choose it again before the next capture.");
      return;
    }

    setPreviewFolderOpening(true);
    try {
      const opened = await openFolderPath(targetFolder);
      if (!opened) {
        setPreviewFolderOpenError("Windows could not open the preview export folder. The saved images are still available at the selected destination.");
        return;
      }

      setPreviewComplete(false);
    } catch (error) {
      console.error("Failed to open preview folder:", targetFolder, error);
      setPreviewFolderOpenError("Windows could not open the preview export folder. The saved images are still available at the selected destination.");
    } finally {
      setPreviewFolderOpening(false);
    }
  }, [isTauriRuntime, previewFolderOpening, previewOutputPath, resolveExistingFolder]);

  const ensurePreviewFolderReady = useCallback(async () => {
    const prefs = loadPrefs() || {};
    const savedFolder = prefs?.defaults?.previewFolder || "";
    const result = await ensurePreviewExportFolder({
      savedFolder,
      isTauriRuntime,
      pathExists: fsExists,
      chooseFolder: async ({ reason }) => {
        if (reason === "missing") {
          showToast("Preview export folder was moved or deleted. Choose a new folder to continue.");
        } else {
          showToast("Choose a preview export folder to save captures.");
        }

        return await promptForPreviewFolder();
      },
      persistFolder: persistPreviewFolder,
    });

    if (result.status === "cancelled-missing" || result.status === "cancelled-unset") {
      showToast("Preview capture cancelled. No preview export folder was selected.");
    }

    return result;
  }, [isTauriRuntime, persistPreviewFolder, promptForPreviewFolder, showToast]);

  const kitShoot = useKitShoot({
    enabled: isTauriRuntime && textureMode === "vehicle",
    modkits,
    viewerApiRef,
    modelPath,
    viewerReady,
    isTauriRuntime,
    ensureFolder: ensurePreviewFolderReady,
    watermark: defaults.watermark || null,
    nativeMaterialsEnabled,
    bodyColor,
    vehiclePaint,
    setBodyColor,
    setVehiclePaint,
    showGrid,
    setShowGrid,
  });
  const { handleModsStatus: handleKitShootModsStatus } = kitShoot;
  const handleVehicleModsStatus = useCallback((status) => {
    setVehicleModsStatus(status);
    handleKitShootModsStatus(status);
  }, [handleKitShootModsStatus]);

  const previewSnapTokenRef = useRef(0);
  const updatePreviewSnapshot = useCallback(async (zoomLevel) => {
    if (!viewerApiRef.current || !viewerReady) return;
    previewSnapTokenRef.current += 1;
    const token = previewSnapTokenRef.current;
    setPreviewZoomLoading(true);
    try {
      const dataUrl = await captureTemporaryViewerFrame(viewerApiRef.current, {
        presetKey: "angle",
        zoomFactor: zoomLevel,
        delayMs: 0,
        watermark: defaults.watermark || null,
        thumbWidth: 720,
      });
      if (token !== previewSnapTokenRef.current) return;
      setPreviewZoomPreview(dataUrl || "");
    } finally {
      if (token === previewSnapTokenRef.current) setPreviewZoomLoading(false);
    }
  }, [viewerReady, defaults]);

  // Generate Preview: one PNG per camera preset. The destination is settled
  // before the first write so a run never splits across folders, and the
  // result counts only files that reached disk.
  const runPreviewCapture = useCallback(async ({ zoomLevel, presetKeys, modelName, outputFolder, folderNote }) => {
    // Temporarily disable grid for clean screenshots
    const gridWasOn = showGrid;
    if (gridWasOn) setShowGrid(false);

    setGeneratingPreview(true);
    setPreviewProgress({ current: 0, total: presetKeys.length, preset: "" });
    setPreviewOutputPath(outputFolder);

    // Wait a frame for grid to disappear if it was on
    if (gridWasOn) await new Promise((r) => setTimeout(r, 100));

    let written = 0;
    const skipped = [];
    let error = "";
    try {
      for (let i = 0; i < presetKeys.length; i++) {
        const preset = presetKeys[i];
        const label = PREVIEW_CAPTURE_PRESET_LABELS[preset] || preset;
        setPreviewProgress({ current: i, total: presetKeys.length, preset: label });

        const bytes = await captureViewerFrameBytes(viewerApiRef.current, {
          presetKey: preset,
          zoomFactor: zoomLevel,
          delayMs: 0,
          watermark: defaults.watermark || null,
        });
        if (!bytes) {
          skipped.push(label);
          continue;
        }

        const fileName = `${modelName}_${preset}.png`;
        try {
          await writeFile(`${outputFolder}/${fileName}`, bytes);
        } catch (writeError) {
          // A refused destination refuses every remaining file too.
          error = `Couldn't write ${fileName}: ${writeError?.message || writeError}`;
          break;
        }
        written += 1;
      }
    } catch (err) {
      console.error("Generate preview failed:", err);
      error = `The capture stopped: ${err?.message || err}`;
    } finally {
      // Restore grid state
      if (gridWasOn) setShowGrid(true);
    }

    setPreviewResult({
      total: presetKeys.length,
      written,
      skipped,
      error,
      folder: written > 0 ? outputFolder : "",
      note: written > 0 ? folderNote : "",
    });
    setPreviewOutputPath(written > 0 ? outputFolder : "");
    setPreviewFolderOpenError("");
    setPreviewProgress({ current: presetKeys.length, total: presetKeys.length, preset: "Complete" });
    setGeneratingPreview(false);
    setPreviewComplete(true);
  }, [showGrid, defaults]);

  const handleGeneratePreview = useCallback(async (zoomLevel = 1, requestedPresets = PREVIEW_CAPTURE_PRESET_KEYS) => {
    if (!viewerApiRef.current || !modelPath || generatingPreview) return;
    const presetKeys = PREVIEW_CAPTURE_PRESET_KEYS.filter((key) => requestedPresets.includes(key));
    if (!presetKeys.length) return;
    setPreviewReplace(null);

    const failBeforeWriting = (error) => {
      setPreviewResult({ total: presetKeys.length, written: 0, skipped: [], error, folder: "", note: "" });
      setPreviewComplete(true);
    };
    if (!isTauriRuntime) {
      failBeforeWriting("Capturing angles needs the desktop app.");
      return;
    }

    const folderResult = await ensurePreviewFolderReady();
    const folder = folderResult.folder;
    if (!folder) return;

    const modelName = modelPath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "preview";

    // Shots go in a subfolder named after the model. ensure_dir (src-tauri
    // lib.rs) only creates folders under the user's home, app data and temp
    // roots, so a picked folder elsewhere, such as another drive, takes the
    // shots directly. Either way every shot of the run lands in one folder.
    const modelFolder = `${folder}/${modelName}`;
    let outputFolder = modelFolder;
    let folderNote = "";
    try {
      await invoke("ensure_dir", { path: modelFolder });
    } catch (error) {
      outputFolder = folder;
      folderNote = `Saved in the export folder because a ${modelName} subfolder couldn't be created there: ${error?.message || error}`;
    }

    const job = { modelPath, zoomLevel, presetKeys, modelName, outputFolder, folderNote };
    const conflicts = await countExistingFiles(
      presetKeys.map((preset) => `${outputFolder}/${modelName}_${preset}.png`),
      fsExists,
    );
    if (conflicts > 0) {
      setPreviewComplete(false);
      setPreviewReplace({ conflicts, total: presetKeys.length, folder: outputFolder, job });
      return;
    }
    await runPreviewCapture(job);
  }, [modelPath, generatingPreview, isTauriRuntime, ensurePreviewFolderReady, runPreviewCapture]);

  const confirmPreviewReplace = useCallback(() => {
    const pending = previewReplace;
    setPreviewReplace(null);
    if (!pending || generatingPreview || !viewerApiRef.current || pending.job.modelPath !== modelPath) return;
    runPreviewCapture(pending.job);
  }, [previewReplace, generatingPreview, modelPath, runPreviewCapture]);

  // A pending "Replace?" belongs to the model it was asked for.
  useEffect(() => {
    setPreviewReplace(null);
  }, [modelPath]);

  const [savingPhoto, setSavingPhoto] = useState(false);
  // Multi saves the whole lineup as framed; every other mode saves its one viewer.
  const multiHasModel = multi.slots.some((slot) => slot.modelPath);
  const handleSaveViewPhoto = useCallback(async () => {
    const lineupPhoto = textureMode === "multi";
    const viewerApi = lineupPhoto ? multiViewerApiRef.current : viewerApiRef.current;
    if (!viewerApi || !(lineupPhoto ? multiHasModel : modelPath) || generatingPreview || savingPhoto) return;
    setPhotoError("");
    let folder = "";
    if (isTauriRuntime) {
      const folderResult = await ensurePreviewFolderReady();
      folder = folderResult.folder;
      if (!folder) return;
    }
    setSavingPhoto(true);
    try {
      const modelName = lineupPhoto ? "lineup" : modelPath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "photo";
      const now = new Date();
      const pad = (value) => String(value).padStart(2, "0");
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const fileName = `${modelName}_photo_${stamp}.png`;
      const bytes = await captureViewerFrameBytes(viewerApi, {
        watermark: defaults.watermark || null,
      });
      if (!bytes) throw new Error("the viewer returned no image");
      if (!isTauriRuntime) {
        // The browser has no folder access; the PNG goes to its downloads.
        downloadBytes(fileName, bytes, { mimeType: "image/png" });
        showToast(`Downloading ${fileName}`);
        return;
      }
      await writeFile(`${folder}/${fileName}`, bytes);
      setPreviewOutputPath(folder);
      showToast(`Saved ${fileName}`);
    } catch (err) {
      setPhotoError(`The photo wasn't saved${folder ? ` to ${folder}` : ""}: ${err?.message || err}.`);
    } finally {
      setSavingPhoto(false);
    }
  }, [textureMode, multiHasModel, modelPath, generatingPreview, savingPhoto, ensurePreviewFolderReady, defaults, isTauriRuntime, showToast]);

  useEffect(() => {
    if (!previewPromptOpen) return;
    const timer = setTimeout(() => {
      updatePreviewSnapshot(previewZoomDraft);
    }, 120);
    return () => clearTimeout(timer);
  }, [previewPromptOpen, previewZoomDraft, updatePreviewSnapshot]);


  const handleDragOver = (event) => {
    event.preventDefault();
    if (!isDragging) setIsDragging(true);
  };

  const handleDragLeave = (event) => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setIsDragging(false);
  };

  const handleDrop = (event) => {
    event.preventDefault();
    setIsDragging(false);
    if (!isTauriRuntime) {
      setDialogError("Drag-and-drop requires the Tauri app.");
      return;
    }

    const files = Array.from(event.dataTransfer?.files || []);
    const objFile = files.find((file) => file.name?.toLowerCase()?.endsWith(".obj"));
    const modelFiles = files.filter((file) => {
      const name = file.name?.toLowerCase();
      return modelExtensions.some((ext) => name?.endsWith(`.${ext}`));
    });
    const modelFile = modelFiles[0];

    if (!modelFile) {
      setDialogError(
        objFile
          ? "out of sheer respect for vehicle devs and those who pour their hearts and souls into their creations, .OBJ files will never be supported."
          : `Only ${modelDropLabel} files are supported for drop.`,
      );
      return;
    }

    if (!modelFile.path) {
      setDialogError("Unable to read dropped file path.");
      return;
    }

    setDialogError("");

    loadModel(modelFile.path, { autoTexture: true });
  };

  const multiWatchKey = lineupWatchPaths(multi.slots).join("\n");

  useEffect(() => {
    let unlisten = null;
    let cancelled = false;

    const normalizePath = (value) => (value || "").toString().replace(/\\/g, "/").toLowerCase();

    const start = async () => {
      if (!isTauriRuntime) {
        setWatchStatus("idle");
        return;
      }

      const isMulti = textureMode === "multi";

      if (isMulti) {
        // Ensure legacy single-template watchers are stopped so they don't fight over state.
        await invoke("stop_watch").catch(() => null);
        await invoke("stop_window_watch").catch(() => null);

        const paths = multiWatchKey ? multiWatchKey.split("\n") : [];

        if (!paths.length) {
          await invoke("stop_multi_watch").catch(() => null);
          if (!cancelled) setWatchStatus("idle");
          return;
        }

        // Resolves with the files it could not watch; rejects only when none could be.
        const watch = await invoke("start_multi_watch", { paths }).then(
          (result) => ({ ok: true, unwatched: Array.isArray(result?.unwatched) ? result.unwatched : [] }),
          (error) => ({ ok: false, error: String(error?.message ?? error) }),
        );

        if (!cancelled) {
          setWatchStatus(watch.ok ? "watching" : "error");
          if (!watch.ok) {
            showToast(`Live reload is off: ${watch.error}`, "error");
          } else if (watch.unwatched.length) {
            const names = watch.unwatched.map((item) => getFileLabel(item?.path, "a livery")).join(", ");
            showToast(`Changes to ${names} won't reload automatically.`, "error");
          }
        }

        // Every slot showing the changed file reloads it; a livery shared by
        // several vehicles is decoded once per slot from one token bump.
        const stopMultiListener = await listen("texture:update", (event) => {
          const changed = lineupPathKey(event?.payload?.path);
          for (const path of paths) {
            if (!changed || lineupPathKey(path) === changed) multi.scheduleReload(path);
          }
        });
        if (cancelled) {
          stopMultiListener();
          return;
        }
        unlisten = stopMultiListener;

        return;
      }

      // Non-multi (single viewer) mode
      await invoke("stop_multi_watch").catch(() => null);

      const primaryPath = texturePath;
      const secondaryPath = windowTemplateEnabled ? windowTexturePath : "";

      const wantsPrimary = Boolean(primaryPath);
      const wantsSecondary = Boolean(secondaryPath);

      if (!wantsPrimary) await invoke("stop_watch").catch(() => null);
      if (!wantsSecondary) await invoke("stop_window_watch").catch(() => null);

      if (!wantsPrimary && !wantsSecondary) {
        if (!cancelled) setWatchStatus("idle");
        return;
      }

      const primaryOk = wantsPrimary
        ? await invoke("start_watch", { path: primaryPath }).then(
            () => true,
            () => false,
          )
        : true;

      const secondaryOk = wantsSecondary
        ? await invoke("start_window_watch", { path: secondaryPath }).then(
            () => true,
            () => false,
          )
        : true;

      if (!cancelled) setWatchStatus(primaryOk && secondaryOk ? "watching" : "error");

      const stopListener = await listen("texture:update", (event) => {
        const changedPath = normalizePath(event?.payload?.path);
        const primaryNorm = normalizePath(primaryPath);
        const secondaryNorm = normalizePath(secondaryPath);

        if (!primaryNorm && !secondaryNorm) return;
        if (!changedPath) {
          scheduleReload("primary");
          scheduleReload("window");
          return;
        }
        const matchesPrimary = primaryNorm && changedPath === primaryNorm;
        const matchesWindow = secondaryNorm && changedPath === secondaryNorm;
        if (matchesPrimary) scheduleReload("primary");
        if (matchesWindow) scheduleReload("window");
      });
      if (cancelled) {
        stopListener();
        return;
      }
      unlisten = stopListener;
    };

    start();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      if (isTauriRuntime) {
        invoke("stop_watch").catch(() => null);
        invoke("stop_window_watch").catch(() => null);
        invoke("stop_multi_watch").catch(() => null);
      }
    };
  }, [textureMode, texturePath, windowTexturePath, windowTemplateEnabled, multiWatchKey]);

  const onTextureReload = useCallback(() => {
    setLastUpdate(new Date().toLocaleTimeString());
  }, []);

  const resolvedTextureTarget =
    textureTarget === PAINT_TARGET ? liveryTarget || "all" : textureTarget;
  const resolvedWindowBaseTarget =
    windowTextureTarget === "auto"
      ? windowLiveryTarget || "none"
      : windowTextureTarget || "none";
  const resolvedWindowTextureTarget = resolvedWindowBaseTarget;
  const activeMaterialTexturePath = materialTextures.length
    ? materialTextures[materialTextures.length - 1]?.path || ""
    : "";
  const hasModel = Boolean(modelPath);
  const activeModelPath = modelSourcePath || modelPath;
  const isTemplateModel = /\.(?:yft|ydd)$/i.test(activeModelPath);
  const hasTemplateMap = Boolean(generatedTemplateMap);
  const templateStatusLabel = !hasModel
    ? "Load a .yft or .ydd model to auto-generate a template map."
    : !isTemplateModel
      ? "Template map generation is available for .yft and .ydd models only."
      : templateMapError
        ? templateMapError
        : hasTemplateMap
          ? "Template map ready."
          : "Generating template map...";
  const liveryTargetLabel = (liveryLabel || "").replace(/^(material|mesh):\s*/i, "").trim();
  const liveryTargetMessage = !hasModel
    ? "Load a model to enable automatic targeting."
    : liveryTargetLabel
      ? `Automatically targeting ${liveryTargetLabel}`
      : "No paint material detected. Applying to all meshes.";
  const liveryTargetToneClass = !hasModel
    ? " is-empty"
    : liveryTargetLabel
      ? ""
      : " is-fallback";
  const windowStatusLabel = windowLiveryLabel || "No window material found";
  const modelLabel = getFileLabel(modelSourcePath || modelPath, "No model selected");
  const overlayLabel = windowTemplateEnabled
    ? getFileLabel(windowTexturePath, "No overlay selected")
    : "Off";
  const viewLabel = liveryExteriorOnly ? "Exterior only" : "Full model";
  const showVehicleSlotColorCards = textureMode === "vehicle" || textureMode === "sirens";
  const nativeMaterialsAvailable = Boolean(nativeMaterialsStatus.available);
  const nativeMaterialsActive = Boolean(nativeMaterialsEnabled && (textureMode === "vehicle" || textureMode === "sirens"));
  const nativeMaterialsCompleteCount =
    (nativeMaterialsStatus.loadedTextureCount || 0) +
    (nativeMaterialsStatus.failedTextureCount || 0);
  const nativeMaterialsPlannedCount = nativeMaterialsStatus.plannedTextureCount || 0;
  const nativeMaterialsProgress = nativeMaterialsPlannedCount > 0
    ? Math.min(100, Math.round((nativeMaterialsCompleteCount / nativeMaterialsPlannedCount) * 100))
    : 0;
  const nativeMaterialsCaption = (() => {
    switch (nativeMaterialsStatus.state) {
      case "available": return "Available";
      case "disabled": return nativeMaterialsAvailable ? "Off" : "Unavailable";
      case "loading": return nativeMaterialsPlannedCount > 0
        ? `Loading ${nativeMaterialsCompleteCount}/${nativeMaterialsPlannedCount}`
        : "Preparing";
      case "ready": return "Ready";
      case "partial": return "Partial";
      case "error": return "Load failed";
      case "unavailable": return "Unavailable";
      default: return "No model";
    }
  })();
  const nativeMaterialsStatusMessage = (() => {
    if (nativeMaterialsStatus.message) return nativeMaterialsStatus.message;
    switch (nativeMaterialsStatus.state) {
      case "available":
      case "disabled":
        return nativeMaterialsAvailable
          ? "Turn on to show the model's own GTA textures. A texture you pick still takes priority."
          : "Needs a .yft model loaded through the CodeWalker bridge.";
      case "loading": return "Loading the model's textures…";
      case "ready": return "Showing the model's own textures on its highest detail level.";
      case "partial":
        if ((nativeMaterialsStatus.unsupportedBindingCount || 0) > 0) {
          const count = nativeMaterialsStatus.unsupportedBindingCount;
          return `Showing the model's textures. ${count} advanced shader ${count === 1 ? "map isn't" : "maps aren't"} previewed yet.`;
        }
        return "Showing the model's textures, but some couldn't be loaded.";
      case "error": return "The model's textures couldn't be loaded. The standard preview is still shown.";
      case "unavailable": return "Needs a .yft model loaded through the CodeWalker bridge.";
      default: return "Load a model to use its own textures.";
    }
  })();

  const modeLabels = { vehicle: "Vehicle", eup: "EUP", multi: "Multi", sirens: "Sirens" };
  const currentModeLabel = modeLabels[textureMode] || "Preview";
  // The viewer still renders by the two old behaviours: on the detected paint
  // the livery is clamped to its sheet on the livery UV channel ("livery");
  // any other target treats it as a texture on those meshes ("everything").
  const viewerTextureMode = textureMode === "vehicle"
    ? (textureTarget === PAINT_TARGET ? "livery" : "everything")
    : textureMode;

  const singleViewer = (
  <Viewer
    modelPath={modelPath}
    texturePath={texturePath}
    windowTexturePath={windowTemplateEnabled ? windowTexturePath : ""}
    bodyColor={bodyColor}
    vehiclePaint={textureMode === "eup" ? eupPaint : vehiclePaint}
    backgroundColor={backgroundColor}
    backgroundImagePath={backgroundImagePath}
    backgroundImageReloadToken={backgroundImageReloadToken}
    backgroundImageBlur={backgroundImageBlur}
    showGrid={showGrid}
    textureReloadToken={textureReloadToken}
    windowTextureReloadToken={windowTextureReloadToken}
    modelReloadToken={modelReloadToken}
    textureTarget={resolvedTextureTarget}
    windowTextureTarget={resolvedWindowTextureTarget}
    textureMode={viewerTextureMode}
    showWireframe={showWireframe}
    showCageWireframe={showCageWireframe}
    showSolidWireframe={showSolidWireframe}
    onMeshStats={setMeshStats}
    wasdEnabled={true}
    liveryExteriorOnly={textureMode === "vehicle" && liveryExteriorOnly}
    lightIntensity={lightIntensity}
    lightAzimuth={lightAzimuth}
    lightElevation={lightElevation}
    stage={stage}
    stageRim={textureMode === "eup" ? initialShowroom.rim : 0}
    stageSpot={stageSpot}
    stageReflect={stageReflect}
    stageBeam={stageBeam}
    stageLight={stageLight}
    stageFloor={stageFloor}
    turntable={turntable}
    turntableSpeed={turntableSpeed}
    glossiness={glossiness}
    shadowsEnabled={showShadows}
    ambientOcclusion={ambientOcclusion}
    materialType={materialType}
    materialLightIntensity={matLightIntensity}
    materialGlossiness={matGlossiness}
    materialRoughness={matRoughness}
    materialClearcoat={matClearcoat}
    materialTexturePath={activeMaterialTexturePath}
    modelRotation={modelRotation}
    nativeMaterialsEnabled={nativeMaterialsActive}
    nativeMaterialsReloadToken={nativeMaterialsReloadToken}
    onModelInfo={handleModelInfo}
    onModelError={handleModelError}
    onModelLoading={handleModelLoading}
    onReady={handleViewerReady}
    onFrame={handleViewerFrame}
    onTextureReload={onTextureReload}
    onTextureError={handleTextureError}
    onWindowTextureError={handleWindowTextureError}
    onFormatWarning={handleFormatWarning}
    onAssetError={setDialogError}
    onNativeMaterialsStatus={handleNativeMaterialsStatus}
    vehicleMods={textureMode === "vehicle" || textureMode === "sirens" ? modkits.vehicleMods : null}
    gameLivery={textureMode === "vehicle" || textureMode === "sirens" ? gameLivery : null}
    onGameLiveryStatus={setGameLiveries}
    steeringAngle={steeringAngle}
    roofClip={activeRoofClip}
    onVehiclePartsChange={setVehicleParts}
    onPaintSlotsChange={setPaintSlotsInUse}
    vehicleLights={viewerLights}
    licensePlate={licensePlate}
    extrasPlan={extrasPlan}
    onLicensePlateStatus={setLicensePlateStatus}
    onVehicleModsStatus={handleVehicleModsStatus}
    isActive={isActive && (!packShown || snapshotRun != null)}
  />
  );

  const dismissFormatWarning = () => {
    const warning = formatWarning;
    // A PSD the viewer couldn't read leaves its slot empty instead of stale.
    if (warning && warning.type !== "non-hi-model" && warning.type !== "unsupported-format") {
      if (warning.slotId) {
        multi.updateSlot(warning.slotId, warning.kind === "window" ? { windowPath: "" } : { liveryPath: "" });
      } else {
        if (warning.kind === "window") setWindowTexturePath("");
        // A material map's warning leaves the livery alone.
        else if (warning.kind !== "material") setTexturePath("");
      }
      setTextureError("");
      setWindowTextureError("");
    }
    setFormatWarning(null);
  };

  const openHiModel = () => {
    const warning = formatWarning;
    setFormatWarning(null);
    if (warning?.hiPath) loadModel(warning.hiPath, warning.loadOptions);
  };

  // Settings > Standard Model Warning turns it back on.
  const stopStandardModelWarnings = () => {
    const prefs = loadPrefs() || {};
    const saved = savePrefs({ ...prefs, defaults: { ...sanitizeStoredDefaults(prefs.defaults), warnStandardModel: false } });
    setFormatWarning(null);
    if (!saved) showToast("Couldn't save that: app storage refused the write, so the warning will show again.", "error");
  };

  const formatWarningModal = (
    <FormatWarningDialog
      warning={formatWarning}
      supportedExtensions={SUPPORTED_TEXTURE_EXTS}
      onDismiss={dismissFormatWarning}
      onOpenHi={openHiModel}
      onNeverShow={stopStandardModelWarnings}
    />
  );

  // Livery has its own workspace (src/components/livery). It shares this
  // component's state, handlers, watchers and Viewer; only the layout differs.
  const handleLiveryDrop = (event) => {
    const files = Array.from(event.dataTransfer?.files || []);
    const hasModelFile = files.some((file) =>
      modelExtensions.some((ext) => file.name?.toLowerCase()?.endsWith(`.${ext}`)),
    );
    // EUP also takes a clothing texture dictionary.
    const textureFile = files.find((file) => isTextureFormatSupported(file.name || "") ||
      (textureMode === "eup" && isYtdTexturePath(file.name || "")));
    if (!hasModelFile && textureFile) {
      event.preventDefault();
      setIsDragging(false);
      if (!isTauriRuntime || !textureFile.path) {
        setDialogError("Drag-and-drop requires the Tauri app.");
        return;
      }
      setDialogError("");
      setTexturePath(textureFile.path);
      return;
    }
    handleDrop(event);
  };

  const multiViewer = (
    <MultiModelViewer
      slots={multi.viewerSlots}
      reloadTokens={multi.reloadTokens}
      selectedId={multi.selectedId}
      gizmoVisible={multi.gizmoVisible}
      gizmoMode={multi.gizmoMode}
      backgroundColor={backgroundColor}
      backgroundImagePath={backgroundImagePath}
      backgroundImageReloadToken={backgroundImageReloadToken}
      backgroundImageBlur={backgroundImageBlur}
      lightIntensity={lightIntensity}
      lightAzimuth={lightAzimuth}
      lightElevation={lightElevation}
      glossiness={glossiness}
      shadowsEnabled={showShadows}
      ambientOcclusion={ambientOcclusion}
      stage={stage}
      stageSpot={stageSpot}
      stageReflect={stageReflect}
      stageBeam={stageBeam}
        stageLight={stageLight}
      stageFloor={multi.showroom.floor}
      stageBays={multi.showroom.lights === "each"}
      turntable={turntable}
      turntableSpeed={turntableSpeed}
      showWireframe={showWireframe}
      showCageWireframe={showCageWireframe}
      showSolidWireframe={showSolidWireframe}
      onMeshStats={setMeshStats}
      showGrid={showGrid}
      wasdEnabled
      isActive={isActive}
      isTauriRuntime={isTauriRuntime}
      onReady={handleMultiViewerReady}
      onSelectSlot={multi.select}
      onSlotPlacements={multi.setPlacements}
      onSlotStatus={multi.reportStatus}
      onSlotInfo={multi.reportInfo}
      onFormatWarning={handleFormatWarning}
    />
  );

  // Multi drops: models fill the selected empty slot, then add vehicles; an
  // image alone becomes the selected vehicle's livery.
  const handleMultiDrop = (event) => {
    event.preventDefault();
    setIsDragging(false);
    if (!isTauriRuntime) {
      setDialogError("Drag-and-drop requires the Tauri app.");
      return;
    }
    const files = Array.from(event.dataTransfer?.files || []);
    const models = files.filter((file) => isVehicleModelPath(file.name || ""));
    if (models.length > 0) {
      const paths = models.map((file) => file.path).filter(Boolean);
      if (paths.length === 0) {
        setDialogError("Unable to read dropped file path.");
        return;
      }
      setDialogError("");
      const skipped = multi.placeModels(paths);
      if (skipped > 0) {
        setDialogError(`Multi shows up to ${MAX_LINEUP_SLOTS} vehicles, so ${skipped} dropped ${skipped === 1 ? "model wasn't" : "models weren't"} added.`);
      }
      return;
    }
    const texture = files.find((file) => isTextureFormatSupported(file.name || ""));
    if (texture?.path && multi.selectedId) {
      setDialogError("");
      multi.updateSlot(multi.selectedId, { liveryPath: texture.path });
      return;
    }
    if (files.some((file) => /\.ydd$/i.test(file.name || ""))) {
      setDialogError("Multi compares vehicles. Open clothing in EUP Studio, where you can wear several addon pieces at once.");
      return;
    }
    setDialogError(`Drop ${VEHICLE_MODEL_EXTENSIONS.map((ext) => `.${ext}`).join(" / ")} models or a livery image.`);
  };

  // Livery, All and Multi use the Studio 5 workspaces (src/components/workspace).
  // They share this component's state, handlers, watchers and viewers; only
  // the layout differs. EUP keeps the panel layout below for now.
  const workspaceCommon = {
      isActive, isBooting, contextBarTarget, isTauriRuntime, hotkeys,
      panelCollapsed, setPanelCollapsed, viewerReady, modelDropLabel,
      dialogError, setDialogError, isDragging, handleDragOver, handleDragLeave,
      toasts, cameraControlsInPanel,
      handleSetCameraPreset, handleCenterCamera, handleRotateModel, handleResetRotation, modelRotation,
      showWireframe, setShowWireframe, showCageWireframe, setShowCageWireframe,
      showSolidWireframe, setShowSolidWireframe, meshStats,
      showGrid, showShadows, ambientOcclusion, toggleRenderEffect: toggleGlobalRenderEffect,
      colorSwatches: COLOR_SWATCHES, defaultBody: DEFAULT_BODY, defaultBg: DEFAULT_BG,
      backgroundColor, setBackgroundColor, backgroundImagePath, selectBackgroundImage,
      clearBackgroundImage: () => {
        setBackgroundImagePath("");
        setBackgroundImageReloadToken((token) => token + 1);
      },
      backgroundImageBlur,
      setBackgroundImageBlur: (value) => setBackgroundImageBlur(clampBackgroundImageBlur(value)),
      maxBackgroundBlur: MAX_BACKGROUND_IMAGE_BLUR,
      lightAzimuth, lightElevation, lightIntensity,
      handleLightAzimuthChange, handleLightElevationChange, handleLightIntensityChange, resetLighting,
      stage, setStage, stageSpot, setStageSpot, stageReflect, setStageReflect, stageBeam, setStageBeam, stageLight, setStageLight,
      stageFloor, setStageFloor,
      turntable, setTurntable,
      turntableSpeed, setTurntableSpeed,
  };

  if (textureMode !== "multi") {
    const liveryStudio = {
      ...workspaceCommon,
      mode: textureMode,
      isActive, isBooting, contextBarTarget, isTauriRuntime, hotkeys,
      panelCollapsed, setPanelCollapsed,
      modelPath, modelSourcePath, modelLoading, viewerReady, modelDropLabel,
      selectModel,
      vehicleFolder, folderScan, folderVehicles, vehicleFilter, setVehicleFilter, openVehicleFolder, openFolderVehicle, stepFolderVehicle,
      closeVehicleFolder: () => {
        setVehicleFolder("");
        setVehicleFilter("");
        setFolderView("vehicle");
      },
      hasFolder, folderView, setFolderView, packShown, packSnapshots, liverySetEntries,
      snapshotRun, snapshotResult, takeSnapshots, stopSnapshots,
      unloadModel: () => {
        setModelPath("");
        setModelSourcePath("");
        setDialogError("");
        setGeneratedTemplateMap(null);
        setTemplateMapError("");
      },
      texturePath, setTexturePath, selectTexture, liveryTargetLabel,
      windowTemplateEnabled, setWindowTemplateEnabled, windowTexturePath, setWindowTexturePath,
      selectWindowTexture,
      windowLiveryTarget, windowStatusLabel, textureTargets,
      liveryExteriorOnly, setLiveryExteriorOnly,
      watchStatus, lastUpdate,
      dialogError, setDialogError, textureError, setTextureError, windowTextureError, setWindowTextureError,
      isDragging, handleDragOver, handleDragLeave, handleDrop: handleLiveryDrop,
      toasts, cameraControlsInPanel,
      handleSetCameraPreset, handleCenterCamera, handleRotateModel, handleResetRotation, modelRotation,
      showWireframe, setShowWireframe, showCageWireframe, setShowCageWireframe,
      showSolidWireframe, setShowSolidWireframe, meshStats,
      showGrid, showShadows, ambientOcclusion, toggleRenderEffect: toggleGlobalRenderEffect,
      vehiclePaint, setVehiclePaintSlot, resetVehiclePaintSlot, paintSlotsInUse,
      colorSwatches: COLOR_SWATCHES, defaultBody: DEFAULT_BODY, defaultBg: DEFAULT_BG,
      backgroundColor, setBackgroundColor, backgroundImagePath, selectBackgroundImage,
      clearBackgroundImage: () => {
        setBackgroundImagePath("");
        setBackgroundImageReloadToken((token) => token + 1);
      },
      backgroundImageBlur,
      setBackgroundImageBlur: (value) => setBackgroundImageBlur(clampBackgroundImageBlur(value)),
      maxBackgroundBlur: MAX_BACKGROUND_IMAGE_BLUR,
      materialType, setMaterialType,
      matLightIntensity, setMatLightIntensity, matGlossiness, setMatGlossiness,
      matRoughness, setMatRoughness, matClearcoat, setMatClearcoat,
      materialTextures, selectMaterialTexture, removeMaterialTexture,
      lightAzimuth, lightElevation, lightIntensity,
      handleLightAzimuthChange, handleLightElevationChange, handleLightIntensityChange, resetLighting,
      metaModelInfo,
      onApplyMetaLivery: (path) => {
        if (textureMode === "vehicle") setTextureTarget(PAINT_TARGET);
        else if (liveryTarget) setTextureTarget(liveryTarget);
        setTexturePath(path);
      },
      onApplyMetaColors: (preset) => {
        const next = {};
        for (const key of VEHICLE_PAINT_KEYS) {
          const paint = paintFromMetaColor(preset[key]);
          if (paint) next[key] = paint;
        }
        if (next.primary) setBodyColor(paintDisplayColor(next.primary));
        setVehiclePaint((current) => ({ ...current, ...next }));
      },
      onToggleMetaExtra: toggleMetaExtra,
      extrasPlan, extrasState, updateExtrasState,
      steeringAngle, setSteeringAngle,
      vehicleParts, vehiclePartControls, roofClip: roofClip.path === modelPath ? roofClip : null,
      vehicleLights, updateVehicleLights, getLightTime, setLightTime, getSirenMarkers, onViewerFrame,
      sirenEditor, els, metaRescanToken, requestMetaRescan, showToast,
      // Reopens a model by path, e.g. after the vehicle renamer moves its file.
      loadModel, reloadMovedModel, reloadModel,
      licensePlate, updateLicensePlate, licensePlateStatus,
      // Kit Shoot is a Vehicle tool; Sirens only picks parts.
      modkits, vehicleModsStatus, gameLivery, setGameLivery, gameLiveries, kitShoot: textureMode === "vehicle" ? kitShoot : null,
      liverySet, setLiverySet, clothingSet, setClothingSet,
      savedVehicle, saveVehicle: textureMode === "eup" ? null : saveVehicle,
      generatingPreview, previewProgress, previewComplete, setPreviewComplete,
      previewOutputPath, previewFolderOpening, previewFolderOpenError, handleOpenPreviewFolder,
      previewPromptOpen, previewZoomDraft, setPreviewZoomDraft, previewZoomPreview, previewZoomLoading,
      previewCapturePresets, capturePresets: PREVIEW_CAPTURE_PRESETS,
      selectedPreviewPresetCount, allPreviewPresetsSelected,
      togglePreviewCapturePreset, toggleAllPreviewCapturePresets, previewCaptureTooltip, previewResult,
      previewReplace, confirmPreviewReplace, cancelPreviewReplace: () => setPreviewReplace(null),
      previewFolder: loadPrefs()?.defaults?.previewFolder || "",
      previewZoom,
      stage, setStage, stageSpot, setStageSpot, stageReflect, setStageReflect, stageBeam, setStageBeam, stageLight, setStageLight,
      stageFloor, setStageFloor,
      turntable, setTurntable,
      turntableSpeed, setTurntableSpeed,
      saveViewPhoto: handleSaveViewPhoto, savingPhoto, photoError, setPhotoError,
      captureNow: () => {
        if (generatingPreview || !viewerReady) return;
        setPreviewComplete(false);
        handleGeneratePreview(previewZoom || 1, previewCapturePresets);
      },
      openCapture: () => {
        if (generatingPreview || !viewerReady) return;
        setPreviewComplete(false);
        setPreviewZoomDraft(previewZoom || 1);
        setPreviewZoomPreview("");
        setPreviewPromptOpen(true);
      },
      closeCapture: () => setPreviewPromptOpen(false),
      startCapture: () => {
        setPreviewZoom(previewZoomDraft);
        setPreviewPromptOpen(false);
        handleGeneratePreview(previewZoomDraft, previewCapturePresets);
      },
      textureTarget, setTextureTarget, windowTextureTarget, setWindowTextureTarget,
      nativeMaterialsEnabled, setNativeMaterialsEnabled,
      nativeMaterialsAvailable, nativeMaterialsActive, nativeMaterialsStatus,
      nativeMaterialsStatusMessage, nativeMaterialsProgress,
      nativeMaterialsPlannedCount, nativeMaterialsCompleteCount,
      retryNativeMaterials: () => setNativeMaterialsReloadToken((token) => token + 1),
      bodyColor, setBodyColor,
    };

    const Workspace = textureMode === "sirens" ? SirenWorkspace : SingleWorkspace;
    return (
      <Workspace
        s={liveryStudio}
        viewer={(
          <>
            {singleViewer}
            <AnimatePresence>
              {modelLoading ? <AppLoader variant="background" /> : null}
            </AnimatePresence>
          </>
        )}
        overlays={(
          <>
            <AnimatePresence>{isBooting ? <AppLoader variant="pane" /> : null}</AnimatePresence>
            {formatWarningModal}
          </>
        )}
      />
    );
  }

  const multiStudio = {
    ...workspaceCommon,
    handleDrop: handleMultiDrop,
    lineup: multi,
    watchStatus,
    selectMultiModel,
    selectMultiLivery,
    selectMultiWindow: (slotId) => selectWindowTexture(slotId),
    lineUp: () => multiViewerApiRef.current?.lineUp?.(multi.slots.map((slot) => slot.id)),
    saveViewPhoto: handleSaveViewPhoto, savingPhoto, photoError, setPhotoError,
    previewFolder: loadPrefs()?.defaults?.previewFolder || "",
  };
  const multiLoading = Object.values(multi.status).some((entry) => entry?.loading);

  return (
    <MultiWorkspace
      s={multiStudio}
      viewer={(
        <>
          {multiViewer}
          <AnimatePresence>
            {multiLoading ? <AppLoader variant="background" /> : null}
          </AnimatePresence>
        </>
      )}
      overlays={(
        <>
          <AnimatePresence>{isBooting ? <AppLoader variant="pane" /> : null}</AnimatePresence>
          {formatWarningModal}
        </>
      )}
    />
  );
}

export default App;
