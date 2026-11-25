import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { readDir, readFile, readTextFile, writeFile } from "@tauri-apps/plugin-fs";
import { open, save } from "@tauri-apps/plugin-dialog";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  Aperture,
  Axis3d,
  Box,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Contrast,
  Crosshair,
  Eye,
  EyeOff,
  Flashlight,
  FolderOpen,
  Grid3x3,
  Hexagon,
  ImageDown,
  ImagePlus,
  Loader2,
  Monitor,
  Moon,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Search,
  ShieldAlert,
  Sun,
  Triangle,
  X,
} from "lucide-react";
import { loadPrefs } from "../lib/prefs";
import { HOTKEY_ACTIONS } from "../lib/hotkeys";
import { useWorkspaceHotkeys } from "../lib/use-workspace-hotkeys";
import { normalizeShowroomSubject } from "../lib/studio-defaults.js";
import { openFolderPath } from "../lib/open-folder";
import { applyWatermarkToDataUrl } from "../lib/watermark";
import { trackUsage } from "../lib/usage";
import { loadNativeMaterialView } from "../lib/native-materials.js";
import { createPropModel, loadPropAsset } from "../lib/prop-model.js";
import { buildCollisionOverlay, readModelCollisions } from "../lib/collision-overlay.js";
import { PROP_LIGHT_LIMIT, createPropLightRig } from "../lib/prop-lights.js";
import { analyzePropHealth, computePropReloadDelta } from "../lib/prop-doctor.js";
import { parseYtypXml, sanitizeArchetypeName } from "../lib/prop-ytyp.js";
import { filterPropModels, findEnclosingPropRoot, isPathInside, scanPropFolder } from "../lib/prop-folder.js";
import { auditPropScript } from "../lib/prop-script-audit.js";
import { SCALE_REFERENCES } from "../lib/prop-scale-ref.js";
import { STUDIO_LOOK_PRESETS, getStudioPresetPatch, matchStudioPreset } from "../lib/studio-presets.js";
import { canvasToPngBytes, composeSheet } from "../lib/kit-shoot-media.js";
import { loadTextureFromPath } from "../lib/viewer-utils";
import {
  PROP_CAMERA_PRESETS,
  PROP_LOD_LABELS,
  PROP_LODS,
  emissiveLevel,
  formatCount,
  formatLength,
  isIdentityOrientation,
  isPropModelPath,
  lightColorHex,
  lodForCameraDistance,
  normalizePropState,
  rotateOrientation,
  thumbnailFileName,
} from "../lib/prop-studio.js";
import PropViewport from "./prop/PropViewport";
import PropExportDialog from "./prop/PropExportDialog";
import PropHealthPanel from "./prop/PropHealthPanel";
import PropAttachPanel from "./prop/PropAttachPanel";
import {
  AssetSlot,
  ColorLine,
  DeckButton,
  DeckViewMenu,
  deckButtonItems,
  ErrorText,
  FloorField,
  CollisionSlip,
  InspectorTabs,
  MeshStatsSlip,
  Slider,
  StageEmpty, StageToggle,
  StageSection,
  WorkspaceFrame,
  splitPath,
} from "./workspace/parts";
import { PaneResizer, usePaneWidths } from "./workspace/PaneResizer";
import { Toggle } from "./ui/toggle";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import "./PropStudioPage.css";

const PERSIST_DEBOUNCE_MS = 140;
const WATCH_DEBOUNCE_MS = 400;
const DEFAULT_BACKGROUND = "#141414";
const MODEL_FILTERS = [{ name: "Prop & 3D models", extensions: ["ydr", "ydd", "yft", "glb", "gltf"] }];
const YTD_FILTERS = [{ name: "Texture dictionaries", extensions: ["ytd"] }];
const OVERRIDE_TEX_FILTERS = [{ name: "Textures", extensions: ["png", "dds", "psd", "jpg", "jpeg", "webp", "tga"] }];
const WATCHED_EXTENSIONS = /\.(ydr|ydd|yft|glb|gltf|ytd|ytyp|xml)$/i;
const VIEW_MODES = [
  { id: "textured", label: "Textured" },
  { id: "clay", label: "Clay" },
  { id: "normals", label: "Normals" },
  { id: "uv", label: "UV check" },
  { id: "backface", label: "Backface" },
  { id: "vertex", label: "Vertex" },
];
const CHANNEL_OPTIONS = [
  { id: "rgba", label: "RGB" },
  { id: "r", label: "R" },
  { id: "g", label: "G" },
  { id: "b", label: "B" },
  { id: "a", label: "A" },
];
const CHANNEL_MAP_OPTIONS = [
  { id: "map", label: "Diffuse" },
  { id: "normalMap", label: "Normal" },
  { id: "specMap", label: "Spec / Rough" },
];
const STAGE_NOTES = {
  showroom: "A dark product studio scaled to the prop, with a reflective floor and a spotlight. The prop's own lights pool on the floor.",
  workbench: "Your backdrop colour, with the grid and shadows from the deck.",
};
const FORMAT_NAMES = { ydr: "Drawable", ydd: "Drawable dictionary", yft: "Fragment", glb: "glTF binary", gltf: "glTF" };
const DEG = Math.PI / 180;

function isTauriRuntimeAvailable() {
  return (
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__ !== "undefined" &&
    typeof window.__TAURI_INTERNALS__?.invoke === "function"
  );
}

function errorMessage(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (typeof error.message === "string") return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function readViewerPrefs() {
  const defaults = loadPrefs()?.defaults;
  const source = defaults && typeof defaults === "object" ? defaults : {};
  return {
    background: typeof source.backgroundColor === "string" && source.backgroundColor ? source.backgroundColor : DEFAULT_BACKGROUND,
    light: Number.isFinite(source.lightIntensity) ? source.lightIntensity : 1,
    showroom: normalizeShowroomSubject(source.showroom?.prop, "prop"),
  };
}

function dataUrlToBytes(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function folderOf(path) {
  return splitPath(path).folder;
}

function joinPath(folder, name) {
  if (!folder) return name;
  const sep = folder.includes("\\") ? "\\" : "/";
  return `${folder.replace(/[\\/]+$/, "")}${sep}${name}`;
}

function isEditableTarget(target) {
  return Boolean(target?.closest?.("input, textarea, select, [contenteditable='true']"));
}

function isInteractiveTarget(target) {
  return Boolean(target?.closest?.("button, a[href], [role='switch'], [role='radio'], [role='tab'], [role='menuitem'], summary"));
}

function newWatchId() {
  return `prop-${Math.random().toString(36).slice(2, 10)}`;
}

function PropHelp() {
  return (
    <div className="lv-help" role="dialog" aria-label="Viewer controls">
      <dl>
        <div><dt><kbd className="cx-keycap">LMB</kbd></dt><dd>Orbit · click a surface to inspect material</dd></div>
        <div><dt><kbd className="cx-keycap">RMB</kbd></dt><dd>Pan</dd></div>
        <div><dt>Scroll</dt><dd>Zoom</dd></div>
        <div><dt><kbd className="cx-keycap">F</kbd></dt><dd>Frame the prop</dd></div>
        <div><dt><kbd className="cx-keycap">Space</kbd></dt><dd>Turntable</dd></div>
        <div><dt><kbd className="cx-keycap">W</kbd></dt><dd>Wireframe</dd></div>
        <div><dt><kbd className="cx-keycap">E</kbd></dt><dd>Emissives on or off</dd></div>
        <div><dt><kbd className="cx-keycap">L</kbd></dt><dd>Prop lights on or off</dd></div>
        <div><dt><kbd className="cx-keycap">N</kbd></dt><dd>Dark room</dd></div>
        <div><dt><kbd className="cx-keycap">[</kbd> / <kbd className="cx-keycap">]</kbd></dt><dd>Previous / next prop in folder</dd></div>
      </dl>
    </div>
  );
}

function Seg({ label, id, value, options, onChange, className = "" }) {
  return (
    <div className="lv-field">
      {label ? <span className="cx-label" id={id}>{label}</span> : null}
      <div className={`lv-seg ${className}`.trim()} role="radiogroup" aria-labelledby={label ? id : undefined} aria-label={label ? undefined : id}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={value === option.id}
            className={`lv-seg-btn ${value === option.id ? "is-on" : ""}`}
            disabled={option.disabled}
            title={option.title}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ToggleRow({ label, checked, onChange, note, disabled }) {
  return (
    <div className={`lv-toggle-row ${disabled ? "ps-is-disabled" : ""}`}>
      <span>
        {label}
        {note ? <span className="ps-row-note">{note}</span> : null}
      </span>
      <Toggle checked={checked} onChange={onChange} ariaLabel={label} disabled={disabled} />
    </div>
  );
}

export default function PropStudioPage({ workspaceState, onStateChange, onRenameTab, isActive, contextBarTarget }) {
  const isTauriRuntime = isTauriRuntimeAvailable();
  const [settings, setSettings] = useState(() => normalizePropState(workspaceState, readViewerPrefs()));
  const [load, setLoad] = useState({ status: "idle", error: "", warnings: [], parser: "", cached: false });
  const [prop, setProp] = useState(null);
  const [nativeStatus, setNativeStatus] = useState({ state: "off" });
  const [info, setInfo] = useState({ stats: null, dims: null });
  const [meshStats, setMeshStats] = useState(null);
  const [collisionInfo, setCollisionInfo] = useState({ status: "idle" });
  const [collisionsOnly, setCollisionsOnly] = useState(false);
  const collisionOverlayRef = useRef(null);
  const [streamedFiles, setStreamedFiles] = useState([]);
  const [ytypInfo, setYtypInfo] = useState({ found: false, archetype: null, siblingYtd: "" });
  const [folderScan, setFolderScan] = useState(null);
  const [folderFilter, setFolderFilter] = useState("");
  const folderProps = useMemo(() => folderScan?.models || [], [folderScan]);
  const [selectedMaterialKey, setSelectedMaterialKey] = useState("");
  const [overrideTick, setOverrideTick] = useState(0);
  const [cameraDist, setCameraDist] = useState(null);
  const [autoLodLevel, setAutoLodLevel] = useState("high");
  const [reloadDelta, setReloadDelta] = useState(null);
  const [attachStatus, setAttachStatus] = useState({ state: "off", message: "" });
  const [attachGizmoMode, setAttachGizmoMode] = useState("translate");
  const [scriptAudit, setScriptAudit] = useState(null);
  const [scriptAuditBusy, setScriptAuditBusy] = useState(false);
  const [glowing, setGlowing] = useState(false);
  const [previewedLights, setPreviewedLights] = useState(() => new Set());
  const [reloadToken, setReloadToken] = useState(0);
  const [watchState, setWatchState] = useState({ status: "off", error: "" });
  const [inspectorTab, setInspectorTab] = useState("model");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const panes = usePaneWidths("cortex.prop.panes");
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState(null);
  const [alerts, setAlerts] = useState([]);

  const viewportRef = useRef(null);
  const rigRef = useRef(null);
  const floorYRef = useRef(0);
  const boundsHelperRef = useRef(null);
  const reloadRef = useRef({ force: false, keepCamera: false, prevSnapshot: null });
  const framePendingRef = useRef(false);
  const auditRunRef = useRef(0);
  const helpWrapRef = useRef(null);
  const exportOpenRef = useRef(false);
  exportOpenRef.current = exportOpen;
  const onRenameTabRef = useRef(onRenameTab);
  onRenameTabRef.current = onRenameTab;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const propRef = useRef(prop);
  propRef.current = prop;
  const healthRef = useRef(null);

  const { scene, view, emissive, lights, thumbnail, attach } = settings;
  const updateSection = useCallback((section, patch) => {
    setSettings((prev) => ({ ...prev, [section]: { ...prev[section], ...patch } }));
  }, []);
  const updateScene = useCallback((patch) => updateSection("scene", patch), [updateSection]);
  const updateView = useCallback((patch) => updateSection("view", patch), [updateSection]);
  const updateEmissive = useCallback((patch) => updateSection("emissive", patch), [updateSection]);
  const updateLights = useCallback((patch) => updateSection("lights", patch), [updateSection]);
  const updateAttach = useCallback((patch) => updateSection("attach", patch), [updateSection]);

  const notify = useCallback((message) => setNotice({ id: Date.now(), message }), []);
  const raiseAlert = useCallback((id, label, text) => {
    setAlerts((prev) => [...prev.filter((alert) => alert.id !== id), { id, label, text }]);
  }, []);
  const dismissAlert = useCallback((id) => setAlerts((prev) => prev.filter((alert) => alert.id !== id)), []);

  /* ── Persist (debounced; Shell skips unchanged state) ── */
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  useEffect(() => {
    const timer = setTimeout(() => onStateChangeRef.current?.(settings), PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [settings]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!reloadDelta) return undefined;
    const timer = setTimeout(() => setReloadDelta(null), 7000);
    return () => clearTimeout(timer);
  }, [reloadDelta]);

  /* ── Load the model ── */
  const extraKey = settings.extraYtds.join("\n");
  useEffect(() => {
    const path = settings.modelPath;
    if (!isTauriRuntime || !path) {
      setProp(null);
      setLoad({ status: "idle", error: "", warnings: [], parser: "", cached: false });
      setStreamedFiles([]);
      setYtypInfo({ found: false, archetype: null, siblingYtd: "" });
      return undefined;
    }
    const controller = new AbortController();
    const { force, keepCamera, prevSnapshot } = reloadRef.current;
    reloadRef.current = { force: false, keepCamera: false, prevSnapshot: null };
    setLoad((prev) => ({ ...prev, status: "loading", error: "" }));
    (async () => {
      try {
        // Ensure sibling files (folder props, .ytd, .ytyp.xml, streamed memory) are in scope.
        await invoke("allow_model_resource", { path }).catch(() => {});
        const asset = await loadPropAsset(path, {
          invoke,
          readFile,
          force,
          extraYtds: extraKey ? extraKey.split("\n") : [],
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        framePendingRef.current = !keepCamera;
        const nextProp = createPropModel(asset);
        setProp(nextProp);
        setSelectedMaterialKey("");
        setLoad({ status: "ready", error: "", warnings: asset.warnings, parser: asset.parser, cached: asset.cached });
        dismissAlert("load");
        onRenameTabRef.current?.(splitPath(path).name);

        if (prevSnapshot) {
          const nextQa = nextProp.qaMetrics();
          const nextDims = nextProp.dimensions();
          const delta = computePropReloadDelta(prevSnapshot, {
            path,
            triangles: nextQa.highTriangles,
            vertices: nextQa.highVertices,
            dims: nextDims,
          });
          if (delta) setReloadDelta({ id: Date.now(), ...delta });
        }
      } catch (error) {
        if (error?.name === "AbortError" || controller.signal.aborted) return;
        if (!keepCamera) setProp(null);
        setLoad({ status: "error", error: errorMessage(error), warnings: [], parser: "", cached: false });
        raiseAlert("load", keepCamera ? "Reload failed" : "Model didn't load", errorMessage(error));
      }
    })();
    return () => controller.abort();
  }, [settings.modelPath, extraKey, reloadToken, isTauriRuntime, dismissAlert, raiseAlert]);

  /* ── Scan FiveM script / stream folder, .ytyp.xml, and RSC7 streamed memory ── */
  const modelFolder = folderOf(settings.modelPath);
  useEffect(() => {
    const path = settings.modelPath;
    const explicitFolder = settings.folderPath;
    if (!isTauriRuntime || (!path && !explicitFolder)) {
      setFolderScan(null);
      setStreamedFiles([]);
      setYtypInfo({ found: false, archetype: null, siblingYtd: "" });
      return undefined;
    }
    const controller = new AbortController();
    let cancelled = false;
    (async () => {
      if (path) {
        await invoke("allow_model_resource", { path }).catch(() => {});
        if (cancelled) return;
      }

      // 1. Auto-detect enclosing FiveM script / stream/ folder (or use the selected script folder).
      try {
        let targetRoot = "";
        if (explicitFolder && (!path || isPathInside(path, explicitFolder))) {
          targetRoot = explicitFolder;
        } else if (path) {
          targetRoot = await findEnclosingPropRoot(path, { readDir });
        }
        if (cancelled) return;
        const scan = targetRoot ? await scanPropFolder(targetRoot, { readDir, signal: controller.signal }) : null;
        if (cancelled) return;
        setFolderScan(scan && scan.models.length > 0 ? scan : null);

        if (path) {
          const stemLower = sanitizeArchetypeName(path).toLowerCase();
          let siblingYtd = "";
          if (scan?.ytdStems?.includes(stemLower)) siblingYtd = stemLower;
          else if (scan?.ytdStems?.includes(`${stemLower}+hi`)) siblingYtd = `${stemLower}+hi`;

          let foundYtyp = false;
          let matchedArchetype = null;
          for (const xmlPath of (scan?.ytypXmls || []).slice(0, 10)) {
            try {
              const text = await readTextFile(xmlPath);
              if (cancelled) return;
              const defs = parseYtypXml(text);
              if (defs.length > 0) foundYtyp = true;
              const hit = defs.find((def) => def.name.toLowerCase() === stemLower || def.assetName.toLowerCase() === stemLower);
              if (hit) {
                matchedArchetype = hit;
                if (!siblingYtd && hit.textureDictionary) siblingYtd = hit.textureDictionary;
                break;
              }
            } catch {
              // Skip unreadable XML
            }
          }
          if (!cancelled) setYtypInfo({ found: foundYtyp, archetype: matchedArchetype, siblingYtd });
        } else {
          setYtypInfo({ found: false, archetype: null, siblingYtd: "" });
        }
      } catch (error) {
        if (error?.name !== "AbortError" && !cancelled) setFolderScan(null);
      }

      // 2. RSC7 streamed memory (reusing Rust's describe_streamed_assets).
      if (path) {
        try {
          const streamed = await invoke("describe_streamed_assets", { models: [path] });
          if (!cancelled) setStreamedFiles(Array.isArray(streamed?.files) ? streamed.files : []);
        } catch {
          if (!cancelled) setStreamedFiles([]);
        }
      } else if (!cancelled) {
        setStreamedFiles([]);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [isTauriRuntime, settings.modelPath, settings.folderPath, reloadToken]);

  /* ── Per-model resources: native materials, light rig, bounds box ── */
  const syncLights = useCallback(() => {
    const rig = rigRef.current;
    if (!rig) return;
    viewportRef.current?.setAccentLights(rig.update(floorYRef.current));
  }, []);

  const refreshLook = useCallback(() => {
    const current = propRef.current;
    if (!current) return;
    const { view: v, emissive: e } = settingsRef.current;
    current.setView(v.mode, v.wireframe, v.channel, v.channelMap);
    setGlowing(current.setEmissive(e));
    viewportRef.current?.requestRender();
  }, []);

  useEffect(() => {
    if (!prop) {
      setNativeStatus({ state: "off" });
      setInfo({ stats: null, dims: null });
      viewportRef.current?.setAccentLights([]);
      return undefined;
    }
    const rig = createPropLightRig({ gta: prop.gta, scene: prop.root, lights: prop.lights });
    rigRef.current = rig;
    setPreviewedLights(rig.previewedIds);
    const boundsHelper = new THREE.Box3Helper(new THREE.Box3(), 0x9fb4c8);
    boundsHelper.userData.propHelper = true;
    boundsHelper.visible = false;
    prop.root.add(boundsHelper);
    boundsHelperRef.current = boundsHelper;

    const native = new AbortController();
    let resources = null;
    if (prop.parser === "bridge" && prop.nativeSummary?.available) {
      setNativeStatus({ state: "loading", loaded: 0, planned: 0, failed: 0 });
      loadNativeMaterialView({
        object: prop.model,
        renderer: viewportRef.current?.getRenderer(),
        signal: native.signal,
        excludeMesh: (mesh) => Boolean(mesh.userData.propHelper),
        onSetup: (summary) => {
          prop.attachNativeMaterials();
          refreshLook();
          setNativeStatus({ state: "loading", loaded: 0, planned: summary.plannedTextureCount, failed: 0, missing: summary.missingBindingCount });
        },
        onProgress: (progress) => setNativeStatus({
          state: "loading",
          loaded: progress.loadedTextureCount,
          planned: progress.plannedTextureCount,
          failed: progress.failedTextureCount,
          missing: progress.missingBindingCount,
        }),
        onRender: () => viewportRef.current?.requestRender(),
      })
        .then((result) => {
          if (native.signal.aborted) {
            result.dispose();
            return;
          }
          resources = result;
          prop.attachNativeMaterials();
          refreshLook();
          setNativeStatus({
            state: "ready",
            loaded: result.summary.loadedTextureCount,
            planned: result.summary.plannedTextureCount,
            failed: result.summary.failedTextureCount,
            missing: result.summary.missingBindingCount,
            failures: result.summary.failures,
            textures: result.summary.textures || [],
          });
        })
        .catch((error) => {
          if (error?.name === "AbortError") return;
          setNativeStatus({ state: "error", error: errorMessage(error) });
        });
    } else {
      setNativeStatus({ state: "off" });
    }

    return () => {
      native.abort();
      resources?.dispose();
      rig.dispose();
      if (rigRef.current === rig) rigRef.current = null;
      boundsHelper.removeFromParent();
      boundsHelper.geometry.dispose();
      boundsHelper.material.dispose();
      prop.dispose();
    };
  }, [prop, refreshLook]);

  const lods = useMemo(() => prop?.availableLods() || [], [prop]);
  const effectiveLod = view.autoLod ? autoLodLevel : view.lod;

  const handleCameraDistance = useCallback((dist) => {
    setCameraDist(dist);
    const current = propRef.current;
    if (!current || !settingsRef.current.view.autoLod) return;
    const dimsNow = current.dimensions();
    const radius = dimsNow ? Math.hypot(dimsNow.x, dimsNow.y, dimsNow.z) * 0.5 : 0.5;
    const nextLod = lodForCameraDistance(dist, radius, current.availableLods());
    setAutoLodLevel((prev) => (prev === nextLod ? prev : nextLod));
  }, []);

  // Geometry: what's shown and how it's turned. Re-centres, re-fits the stage
  // and frames a newly loaded model.
  useEffect(() => {
    if (!prop) return;
    prop.setVisibility({ lod: effectiveLod, drawable: view.drawable, hiddenMaterials: view.hiddenMaterials });
    prop.setOrientation(view.orientation);
    if (!settingsRef.current.attach?.enabled) prop.recenter();
    const rest = prop.restBounds();
    floorYRef.current = rest?.min.y ?? 0;
    if (boundsHelperRef.current && rest) boundsHelperRef.current.box.copy(rest);
    const size = rest ? rest.getSize(new THREE.Vector3()).length() : 0.5;
    prop.setHelpers({ origin: view.origin, size: Math.max(0.02, size * 0.35) });
    setInfo({ stats: prop.stats(), dims: prop.dimensions() });
    if (framePendingRef.current) {
      framePendingRef.current = false;
      viewportRef.current?.frame(settingsRef.current.cameraPreset, { instant: true });
    } else {
      viewportRef.current?.refit();
    }
    syncLights();
    setGlowing(prop.setEmissive(settingsRef.current.emissive));
    viewportRef.current?.requestRender();
  }, [prop, effectiveLod, view.drawable, view.hiddenMaterials, view.orientation, view.origin, syncLights]);

  useEffect(() => {
    if (boundsHelperRef.current) boundsHelperRef.current.visible = Boolean(view.bounds);
    viewportRef.current?.requestRender();
  }, [prop, view.bounds]);

  // Read collisions automatically on load so Prop Doctor audits them immediately;
  // only build/mount the 3D overlay when view.collisions is toggled on.
  useEffect(() => {
    const path = settings.modelPath;
    if (!prop || !path) {
      setCollisionInfo({ status: "idle" });
      return undefined;
    }
    if (!isTauriRuntime || !/\.(yft|ydr|ydd)$/i.test(path)) {
      setCollisionInfo({ status: "unavailable" });
      return undefined;
    }
    let cancelled = false;
    setCollisionInfo({ status: "loading" });
    readModelCollisions(invoke, path, prop.root.uuid)
      .then((data) => {
        if (cancelled) return;
        if (!data.meshes.length && !data.primitives.length) {
          setCollisionInfo({ status: "none", data });
        } else {
          setCollisionInfo({ status: "ready", data });
        }
      })
      .catch((error) => {
        if (!cancelled) setCollisionInfo({ status: "error", error: errorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [prop, settings.modelPath, isTauriRuntime]);

  useEffect(() => {
    if (!view.collisions || !prop || collisionInfo.status !== "ready" || !collisionInfo.data) return undefined;
    const overlay = buildCollisionOverlay(collisionInfo.data);
    overlay.group.userData.propHelper = true;
    overlay.setSolid(collisionsOnlyRef.current);
    prop.gta.add(overlay.group);
    collisionOverlayRef.current = overlay;
    viewportRef.current?.requestRender();
    return () => {
      if (collisionOverlayRef.current === overlay) collisionOverlayRef.current = null;
      overlay.dispose();
      viewportRef.current?.requestRender();
    };
  }, [view.collisions, prop, collisionInfo]);

  const collisionsOnlyRef = useRef(collisionsOnly);
  useEffect(() => {
    collisionsOnlyRef.current = collisionsOnly;
    collisionOverlayRef.current?.setSolid(collisionsOnly);
    viewportRef.current?.requestRender();
  }, [collisionsOnly]);

  useEffect(() => {
    refreshLook();
  }, [prop, view.mode, view.channel, view.channelMap, view.wireframe, emissive, refreshLook]);

  useEffect(() => {
    if (!prop) return;
    prop.setHighlightedMaterial(selectedMaterialKey);
    viewportRef.current?.requestRender();
  }, [prop, selectedMaterialKey]);

  useEffect(() => {
    const rig = rigRef.current;
    if (!rig) return;
    rig.setState({ enabled: lights.enabled, strength: lights.strength, haze: lights.haze, off: lights.off, glow: emissive.glow });
    syncLights();
    viewportRef.current?.requestRender();
  }, [prop, lights, emissive.glow, syncLights]);

  /* ── Prop Doctor QA report ── */
  const qaMetrics = useMemo(() => (prop ? prop.qaMetrics() : null), [prop]);
  const health = useMemo(() => {
    if (!prop || !qaMetrics) return null;
    return analyzePropHealth({
      name: sanitizeArchetypeName(settings.modelPath),
      format: prop.format,
      gtaBounds: qaMetrics.gtaBounds,
      lodStats: qaMetrics.lodStats,
      highTriangles: qaMetrics.highTriangles,
      highVertices: qaMetrics.highVertices,
      missingBindings: qaMetrics.missingBindings,
      textureFailures: nativeStatus.failures || [],
      collisionsStatus: collisionInfo.status,
      collisions: collisionInfo.data || null,
      streamedFiles,
      ytypFound: ytypInfo.found,
      ytypArchetype: ytypInfo.archetype,
      ytypTextureDict: ytypInfo.siblingYtd,
      missingUvMeshes: qaMetrics.missingUvMeshes,
      missingNormalMeshes: qaMetrics.missingNormalMeshes,
      degenerateTriangles: qaMetrics.degenerateTriangles,
      invertedWindingMeshes: qaMetrics.invertedWindingMeshes,
    });
  }, [prop, qaMetrics, settings.modelPath, nativeStatus.failures, collisionInfo, streamedFiles, ytypInfo]);
  healthRef.current = health;

  /* ── Turntable ── */
  const handleAnimate = useCallback((dt) => {
    const current = propRef.current;
    if (!current) return;
    current.setYaw((current.yaw + dt * settingsRef.current.view.turntableSpeed * DEG) % (Math.PI * 2));
  }, []);
  const handleFrame = useCallback(() => {
    if (settingsRef.current.view.turntable) syncLights();
  }, [syncLights]);

  /* ── Files ── */
  const openModel = useCallback((path, { folderPath } = {}) => {
    if (!isPropModelPath(path)) {
      raiseAlert("load", "Not a prop model", "Prop Studio opens .ydr, .ydd, .yft, .glb and .gltf files.");
      return;
    }
    reloadRef.current = { force: false, keepCamera: false, prevSnapshot: null };
    setReloadDelta(null);
    setSettings((prev) => ({
      ...prev,
      modelPath: path,
      folderPath: folderPath !== undefined
        ? folderPath
        : prev.folderPath && isPathInside(path, prev.folderPath)
          ? prev.folderPath
          : "",
      view: { ...prev.view, drawable: -1, hiddenMaterials: {} },
      emissive: { ...prev.emissive, off: {}, levels: {} },
      lights: { ...prev.lights, off: {} },
    }));
  }, [raiseAlert]);

  const handlePickModel = useCallback(async () => {
    if (!isTauriRuntime) return;
    const picked = await open({ multiple: false, filters: MODEL_FILTERS, title: "Open a prop" });
    if (typeof picked === "string" && picked) openModel(picked);
  }, [isTauriRuntime, openModel]);

  const openScriptOrFolder = useCallback(async (picked) => {
    if (!picked) return false;
    try {
      const scan = await scanPropFolder(picked, { readDir });
      if (!scan.models.length) {
        if (scan.detectedStream) {
          raiseAlert("load", "No models in stream/", `Found stream/ inside ${scan.label}, but it contains no .ydr, .ydd, .yft, .glb or .gltf models.`);
        } else {
          raiseAlert("load", "No prop models found", "No stream/ folder or .ydr, .ydd, .yft, .glb or .gltf models were found there.");
        }
        return false;
      }
      setFolderScan(scan);
      setFolderFilter("");
      const currentPath = settingsRef.current.modelPath;
      const keepCurrent = currentPath && scan.models.some((entry) => entry.path.toLowerCase() === currentPath.toLowerCase());
      if (keepCurrent) {
        setSettings((prev) => ({ ...prev, folderPath: picked }));
      } else {
        openModel(scan.models[0].path, { folderPath: picked });
      }
      const where = scan.kind === "script" && scan.detectedStream ? `${scan.label}/stream` : scan.label;
      notify(`Found ${scan.models.length} ${scan.models.length === 1 ? "model" : "models"} in ${where}`);
      return true;
    } catch (error) {
      raiseAlert("load", "Folder couldn't be read", errorMessage(error));
      return false;
    }
  }, [notify, openModel, raiseAlert]);

  const handlePickFolder = useCallback(async () => {
    if (!isTauriRuntime) return;
    const picked = await open({ directory: true, multiple: false, title: "Select a FiveM script or prop folder" });
    if (typeof picked !== "string" || !picked) return;
    await openScriptOrFolder(picked);
  }, [isTauriRuntime, openScriptOrFolder]);

  const handleUnload = useCallback(() => {
    auditRunRef.current += 1;
    setSettings((prev) => ({ ...prev, modelPath: "", folderPath: "", extraYtds: [], attach: { ...prev.attach, enabled: false } }));
    setFolderScan(null);
    setScriptAudit(null);
    setScriptAuditBusy(false);
    setReloadDelta(null);
    onRenameTabRef.current?.("Prop Studio");
  }, []);

  useEffect(() => {
    auditRunRef.current += 1;
    setScriptAudit(null);
    setScriptAuditBusy(false);
  }, [folderScan?.scanRoot]);

  useEffect(() => {
    if (!helpOpen) return undefined;
    const onPointerDown = (event) => {
      if (!helpWrapRef.current?.contains(event.target)) setHelpOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setHelpOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [helpOpen]);

  const addYtds = useCallback((paths) => {
    const ytds = paths.filter((path) => /\.ytd$/i.test(path));
    if (ytds.length === 0) return;
    setSettings((prev) => ({ ...prev, extraYtds: [...new Set([...prev.extraYtds, ...ytds])].slice(0, 16) }));
  }, []);

  const handleAddYtd = useCallback(async () => {
    if (!isTauriRuntime) return;
    const picked = await open({ multiple: true, filters: YTD_FILTERS, title: "Add texture dictionaries" });
    addYtds(Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : []);
  }, [addYtds, isTauriRuntime]);

  const handleRemoveYtd = useCallback((path) => {
    setSettings((prev) => ({ ...prev, extraYtds: prev.extraYtds.filter((item) => item !== path) }));
  }, []);

  const triggerReload = useCallback(() => {
    const current = propRef.current;
    const qa = current?.qaMetrics?.();
    const prevSnapshot = current && qa
      ? {
        path: settingsRef.current.modelPath,
        triangles: qa.highTriangles,
        vertices: qa.highVertices,
        dims: current.dimensions(),
        issues: healthRef.current ? healthRef.current.counts.error + healthRef.current.counts.warn : undefined,
      }
      : null;
    reloadRef.current = { force: true, keepCamera: true, prevSnapshot };
    setReloadToken((token) => token + 1);
  }, []);

  const handlePickMaterialOverride = useCallback(async (materialKey) => {
    if (!isTauriRuntime || !propRef.current) return;
    const picked = await open({ multiple: false, filters: OVERRIDE_TEX_FILTERS, title: "Test texture on this material" });
    if (typeof picked !== "string" || !picked) return;
    try {
      const texture = await loadTextureFromPath(picked, null, viewportRef.current?.getRenderer());
      if (!texture) throw new Error("Unsupported or unreadable texture.");
      propRef.current.setMaterialTextureOverride(materialKey, texture, picked);
      setOverrideTick((t) => t + 1);
      viewportRef.current?.requestRender();
      notify(`Testing ${splitPath(picked).name}`);
    } catch (error) {
      raiseAlert("override", "Texture didn't load", errorMessage(error));
    }
  }, [isTauriRuntime, notify, raiseAlert]);

  const handleClearMaterialOverride = useCallback((materialKey) => {
    if (!propRef.current) return;
    propRef.current.clearMaterialTextureOverride(materialKey);
    setOverrideTick((t) => t + 1);
    viewportRef.current?.requestRender();
  }, []);

  const handlePickFromViewport = useCallback((materialKey) => {
    setSelectedMaterialKey((prev) => (prev === materialKey ? "" : materialKey));
    if (materialKey) {
      setInspectorOpen(true);
      setInspectorTab("model");
    }
  }, []);

  const stepFolderProp = useCallback((delta) => {
    if (folderProps.length < 2) return;
    const currentIndex = folderProps.findIndex((item) => item.path.toLowerCase() === settingsRef.current.modelPath.toLowerCase());
    if (currentIndex < 0) return;
    const next = folderProps[(currentIndex + delta + folderProps.length) % folderProps.length];
    if (next) openModel(next.path, { folderPath: settingsRef.current.folderPath || folderScan?.rootPath || "" });
  }, [folderProps, folderScan?.rootPath, openModel]);

  /* ── Drag and drop (native paths; models, .ytd, or a FiveM script / prop folder) ── */
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  useEffect(() => {
    if (!isTauriRuntime) return undefined;
    let unlisten = null;
    let disposed = false;
    const looksLikeFolder = (path) => typeof path === "string" && path.length > 0 && !/\.[a-z0-9]{1,8}$/i.test(splitPath(path).name);
    const relevant = (paths) => (paths || []).some((path) => isPropModelPath(path) || /\.ytd$/i.test(path) || looksLikeFolder(path));
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (!isActiveRef.current) return;
        const { type, paths } = event.payload || {};
        if (type === "enter") setDragging(relevant(paths));
        else if (type === "leave") setDragging(false);
        else if (type === "drop") {
          setDragging(false);
          const list = paths || [];
          const model = list.find(isPropModelPath);
          if (model) openModel(model);
          addYtds(list);
          if (!model && !list.some((p) => /\.ytd$/i.test(p))) {
            const folder = list.find(looksLikeFolder);
            if (folder) openScriptOrFolder(folder);
          }
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [addYtds, isTauriRuntime, openModel, openScriptOrFolder]);

  /* ── Live reload: the model's folder, auto-detected stream root, and added dictionaries ── */
  const watchKey = settings.modelPath
    ? [...new Set([folderOf(settings.modelPath), folderScan?.scanRoot, ...settings.extraYtds].filter(Boolean))].join("\n")
    : "";
  useEffect(() => {
    const paths = watchKey ? watchKey.split("\n") : [];
    if (!isTauriRuntime || !settings.liveReload || paths.length === 0) {
      setWatchState({ status: "off", error: "" });
      return undefined;
    }
    const id = newWatchId();
    let disposed = false;
    let unlisten = null;
    let timer = null;
    (async () => {
      try {
        unlisten = await listen("eup:update", (event) => {
          if (event.payload?.id !== id) return;
          if (exportOpenRef.current) return;
          if (!(event.payload.paths || []).some((path) => WATCHED_EXTENSIONS.test(path))) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            timer = null;
            if (exportOpenRef.current) return;
            triggerReload();
            notify("Reloaded after a file changed");
          }, WATCH_DEBOUNCE_MS);
        });
        if (disposed) {
          unlisten();
          return;
        }
        await invoke("start_eup_watch", { id, paths });
        if (!disposed) setWatchState({ status: "watching", error: "" });
      } catch (error) {
        if (!disposed) setWatchState({ status: "error", error: errorMessage(error) });
      }
    })();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unlisten?.();
      invoke("stop_eup_watch", { id }).catch(() => {});
    };
  }, [isTauriRuntime, notify, settings.liveReload, watchKey, triggerReload]);

  /* ── Helper: offscreen load + native materials for batch folder exports ── */
  const renderPropFileCanvas = useCallback(async (filePath, options, signal) => {
    const renderer = viewportRef.current?.getRenderer();
    if (!renderer) throw new Error("Renderer isn't ready.");
    const asset = await loadPropAsset(filePath, {
      invoke,
      readFile,
      extraYtds: settingsRef.current.extraYtds,
      signal,
    });
    if (signal?.aborted) {
      const err = new Error("Export cancelled.");
      err.name = "AbortError";
      throw err;
    }
    const temp = createPropModel(asset);
    let native = null;
    try {
      temp.setVisibility({ lod: "high", drawable: -1 });
      temp.recenter();
      if (temp.parser === "bridge" && temp.nativeSummary?.available) {
        native = await loadNativeMaterialView({
          object: temp.model,
          renderer,
          signal,
          excludeMesh: (mesh) => Boolean(mesh.userData.propHelper),
        });
        temp.attachNativeMaterials();
      }
      temp.setView("textured", false);
      temp.setEmissive(settingsRef.current.emissive);
      const bounds = temp.bounds();
      if (!bounds) throw new Error("No visible geometry.");

      const size = options.size || 512;
      const thumbScene = new THREE.Scene();
      const ambient = new THREE.AmbientLight(0xffffff, 0.55 * settingsRef.current.scene.lightLevel);
      const keyLight = new THREE.DirectionalLight(0xffffff, 0.95 * settingsRef.current.scene.lightLevel);
      keyLight.position.set(2.5, 4, 3);
      const rimLight = new THREE.DirectionalLight(0xffffff, 0.4 * settingsRef.current.scene.lightLevel);
      rimLight.position.set(-3, 2, -2.5);
      thumbScene.add(ambient, keyLight, rimLight, temp.root);
      temp.root.updateMatrixWorld(true);

      const sphere = bounds.getBoundingSphere(new THREE.Sphere());
      const radius = Math.max(sphere.radius, 0.005);
      const distance = radius / Math.sin(THREE.MathUtils.degToRad(30) / 2);
      const camera = new THREE.PerspectiveCamera(30, 1, Math.max(distance * 0.01, 0.0005), distance * 6);
      const dirs = {
        front: new THREE.Vector3(0, 0.12, 1).normalize(),
        top: new THREE.Vector3(0, 1, 0.0001).normalize(),
        angle: new THREE.Vector3(0.75, 0.42, 1).normalize(),
      };
      const dir = dirs[options.angle] || dirs.angle;
      camera.position.copy(sphere.center).addScaledVector(dir, distance);
      camera.lookAt(sphere.center);
      camera.updateMatrixWorld();
      camera.updateProjectionMatrix();
      let extent = 0;
      for (let corner = 0; corner < 8; corner += 1) {
        const pt = new THREE.Vector3(
          corner & 1 ? bounds.max.x : bounds.min.x,
          corner & 2 ? bounds.max.y : bounds.min.y,
          corner & 4 ? bounds.max.z : bounds.min.z,
        ).project(camera);
        extent = Math.max(extent, Math.abs(pt.x), Math.abs(pt.y));
      }
      if (extent > 0.001) {
        camera.zoom = Math.min(20, 1 / (extent * (1 + (options.padding ?? 0.08))));
        camera.updateProjectionMatrix();
      }

      const target = new THREE.WebGLRenderTarget(size, size, { samples: 4, colorSpace: THREE.SRGBColorSpace });
      const prevTarget = renderer.getRenderTarget();
      const prevColor = renderer.getClearColor(new THREE.Color());
      const prevAlpha = renderer.getClearAlpha();
      const pixels = new Uint8Array(size * size * 4);
      const bg = options.transparent ? null : settingsRef.current.scene.backdrop;
      try {
        renderer.setRenderTarget(target);
        if (bg) renderer.setClearColor(new THREE.Color(bg), 1);
        else renderer.setClearColor(0x000000, 0);
        renderer.clear();
        renderer.render(thumbScene, camera);
        renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
      } finally {
        renderer.setRenderTarget(prevTarget);
        renderer.setClearColor(prevColor, prevAlpha);
        target.dispose();
      }

      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const img = new ImageData(size, size);
      const row = size * 4;
      for (let y = 0; y < size; y += 1) {
        const src = (size - 1 - y) * row;
        const dst = y * row;
        for (let x = 0; x < row; x += 4) {
          const a = pixels[src + x + 3];
          const s = !bg && a > 0 && a < 255 ? 255 / a : 1;
          img.data[dst + x] = Math.min(255, pixels[src + x] * s);
          img.data[dst + x + 1] = Math.min(255, pixels[src + x + 1] * s);
          img.data[dst + x + 2] = Math.min(255, pixels[src + x + 2] * s);
          img.data[dst + x + 3] = a;
        }
      }
      canvas.getContext("2d").putImageData(img, 0, 0);
      return canvas;
    } finally {
      native?.dispose();
      temp.dispose();
    }
  }, []);

  /* ── Capture & Export ── */
  const handleScreenshot = useCallback(async () => {
    const dataUrl = viewportRef.current?.captureScreenshot();
    if (!dataUrl) {
      raiseAlert("capture", "View not saved", "The viewfinder isn't ready yet.");
      return;
    }
    try {
      const target = await save({
        defaultPath: thumbnailFileName(settingsRef.current.modelPath, null, { suffix: "view" }),
        filters: [{ name: "PNG image", extensions: ["png"] }],
        title: "Save this view",
      });
      if (!target) return;
      const stamped = await applyWatermarkToDataUrl(dataUrl, loadPrefs()?.defaults?.watermark);
      await writeFile(target, dataUrlToBytes(stamped));
      trackUsage("photo");
      dismissAlert("capture");
      notify(`Saved ${target}`);
    } catch (error) {
      raiseAlert("capture", "View not saved", errorMessage(error));
    }
  }, [dismissAlert, notify, raiseAlert]);

  const renderExport = useCallback((options) => viewportRef.current.renderThumbnail({
    size: options.size,
    angle: options.angle,
    padding: options.padding,
    background: options.transparent ? null : settingsRef.current.scene.backdrop,
  }), []);

  const saveExport = useCallback(async (options) => {
    const target = await save({
      defaultPath: thumbnailFileName(settingsRef.current.modelPath, options.size),
      filters: [{ name: "PNG image", extensions: ["png"] }],
      title: "Export image",
    });
    if (!target) return "";
    const bytes = await renderExport(options);
    await writeFile(target, bytes);
    trackUsage("photo");
    return target;
  }, [renderExport]);

  const handleExportSheet = useCallback(async ({ scope, options, signal, onProgress }) => {
    const current = propRef.current;
    if (!current || !viewportRef.current) throw new Error("No prop loaded.");
    const stem = sanitizeArchetypeName(settingsRef.current.modelPath);
    const target = await save({
      defaultPath: `${stem}_${scope === "folder" ? "pack_sheet" : "sheet"}.png`,
      filters: [{ name: "PNG image", extensions: ["png"] }],
      title: "Save contact sheet",
    });
    if (!target) return null;

    const bg = settingsRef.current.scene.backdrop;
    const items = [];
    let skipped = 0;
    if (scope === "angles") {
      const shots = [
        { key: "angle", title: "3/4" },
        { key: "front", title: "Front" },
        { key: "right", title: "Side" },
        { key: "top", title: "Top" },
      ];
      for (let i = 0; i < shots.length; i += 1) {
        if (signal?.aborted) break;
        onProgress?.({ current: i + 1, total: shots.length, label: `Rendering ${shots[i].title}…` });
        const image = viewportRef.current.renderAngleCanvas({
          size: 768,
          angle: shots[i].key,
          padding: options.padding,
          background: bg,
        });
        items.push({ image, title: shots[i].title, detail: stem });
      }
    } else if (scope === "drawables") {
      const prevDrawable = settingsRef.current.view.drawable;
      try {
        for (let i = 0; i < current.drawables.length; i += 1) {
          if (signal?.aborted) break;
          const d = current.drawables[i];
          onProgress?.({ current: i + 1, total: current.drawables.length, label: `Rendering ${d.name}…` });
          current.setVisibility({ lod: "high", drawable: d.index, hiddenMaterials: settingsRef.current.view.hiddenMaterials });
          current.recenter();
          const image = viewportRef.current.renderAngleCanvas({
            size: 512,
            angle: options.angle === "camera" ? "angle" : options.angle,
            padding: options.padding,
            background: bg,
          });
          items.push({ image, title: d.name });
        }
      } finally {
        current.setVisibility({ lod: effectiveLod, drawable: prevDrawable, hiddenMaterials: settingsRef.current.view.hiddenMaterials });
        if (!settingsRef.current.attach?.enabled) current.recenter();
        viewportRef.current.requestRender();
      }
    } else if (scope === "folder") {
      for (let i = 0; i < folderProps.length; i += 1) {
        if (signal?.aborted) break;
        const entry = folderProps[i];
        onProgress?.({ current: i + 1, total: folderProps.length, label: `Rendering ${entry.name}…` });
        try {
          const image = await renderPropFileCanvas(entry.path, { ...options, transparent: false, size: 512 }, signal);
          items.push({ image, title: sanitizeArchetypeName(entry.name) });
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          skipped += 1;
        }
      }
    }

    if (signal?.aborted) {
      const err = new Error("Export cancelled.");
      err.name = "AbortError";
      throw err;
    }
    if (!items.length) throw new Error("No frames were rendered for the contact sheet.");
    const sheet = await composeSheet({
      items,
      format: "square",
      title: scope === "folder" ? folderScan?.label || splitPath(modelFolder).name || "Prop pack" : stem,
      labels: true,
    });
    const { bytes } = await canvasToPngBytes(sheet);
    await writeFile(target, bytes);
    trackUsage("photo");
    return {
      path: target,
      detail: `${items.length} ${items.length === 1 ? "frame" : "frames"}${skipped ? ` (${skipped} skipped)` : ""}`,
    };
  }, [effectiveLod, folderProps, folderScan?.label, modelFolder, renderPropFileCanvas]);

  const handleExportBatch = useCallback(async ({ scope, options, signal, onProgress }) => {
    const current = propRef.current;
    if (!current || !viewportRef.current) throw new Error("No prop loaded.");
    const destination = await open({ directory: true, multiple: false, title: "Choose destination folder for icon PNGs" });
    if (typeof destination !== "string" || !destination) return null;

    const bg = options.transparent ? null : settingsRef.current.scene.backdrop;
    const angle = options.angle === "camera" ? "angle" : options.angle;
    let written = 0;
    const failed = [];
    const usedNames = new Map();
    const uniqueFileName = (rawName) => {
      const base = sanitizeArchetypeName(rawName);
      const key = base.toLowerCase();
      const count = (usedNames.get(key) || 0) + 1;
      usedNames.set(key, count);
      return count === 1 ? `${base}.png` : `${base}_${count}.png`;
    };

    if (scope === "drawables") {
      const prevDrawable = settingsRef.current.view.drawable;
      try {
        for (let i = 0; i < current.drawables.length; i += 1) {
          if (signal?.aborted) break;
          const d = current.drawables[i];
          const outName = uniqueFileName(d.name);
          onProgress?.({ current: i + 1, total: current.drawables.length, label: `Exporting ${outName}…` });
          try {
            current.setVisibility({ lod: "high", drawable: d.index, hiddenMaterials: settingsRef.current.view.hiddenMaterials });
            current.recenter();
            const bytes = await viewportRef.current.renderThumbnail({ size: options.size, angle, padding: options.padding, background: bg });
            await writeFile(joinPath(destination, outName), bytes);
            written += 1;
          } catch (error) {
            failed.push(`${d.name}: ${errorMessage(error)}`);
          }
        }
      } finally {
        current.setVisibility({ lod: effectiveLod, drawable: prevDrawable, hiddenMaterials: settingsRef.current.view.hiddenMaterials });
        if (!settingsRef.current.attach?.enabled) current.recenter();
        viewportRef.current.requestRender();
      }
    } else {
      for (let i = 0; i < folderProps.length; i += 1) {
        if (signal?.aborted) break;
        const entry = folderProps[i];
        const outName = uniqueFileName(entry.name);
        onProgress?.({ current: i + 1, total: folderProps.length, label: `Exporting ${outName}…` });
        try {
          const canvas = await renderPropFileCanvas(entry.path, { ...options, angle }, signal);
          const { bytes } = await canvasToPngBytes(canvas);
          await writeFile(joinPath(destination, outName), bytes);
          written += 1;
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          failed.push(`${entry.name}: ${errorMessage(error)}`);
        }
      }
    }

    if (written > 0) trackUsage("photo", written);
    return {
      folder: destination,
      detail: `${written} PNG${written === 1 ? "" : "s"} saved`,
      partialError: failed.length ? `${failed.length} failed (${failed.slice(0, 2).join("; ")})` : "",
    };
  }, [effectiveLod, folderProps, renderPropFileCanvas]);

  const handleExportVideo = useCallback(async ({ width, height, seconds, signal, onProgress }) => {
    if (!viewportRef.current) throw new Error("The viewfinder isn't ready yet.");
    const stem = sanitizeArchetypeName(settingsRef.current.modelPath);
    const result = await viewportRef.current.recordTurntableVideo({
      width,
      height,
      seconds,
      fps: 30,
      signal,
      onProgress: (step) => onProgress?.({ ...step, label: `Recording frame ${step.current} of ${step.total}…` }),
    });
    const target = await save({
      defaultPath: `${stem}_turntable.${result.extension}`,
      filters: [{ name: `${result.extension.toUpperCase()} video`, extensions: [result.extension] }],
      title: "Save turntable video",
    });
    if (!target) return null;
    await writeFile(target, result.bytes);
    trackUsage("photo");
    return { path: target, detail: `${seconds}s ${width}×${height} 30 fps` };
  }, []);

  const openModelFolder = useCallback(async () => {
    const folder = folderOf(settingsRef.current.modelPath);
    if (await openFolderPath(folder)) return;
    raiseAlert("open-folder", "Folder not opened", `Windows couldn't open ${folder}.`);
  }, [raiseAlert]);

  const handleRunScriptAudit = useCallback(async () => {
    if (!isTauriRuntime || !folderScan || !folderScan.models?.length || scriptAuditBusy) return;
    const runId = ++auditRunRef.current;
    setScriptAuditBusy(true);
    try {
      let manifestText = "";
      if (folderScan.hasManifest) {
        for (const name of ["fxmanifest.lua", "__resource.lua"]) {
          try {
            manifestText = await readTextFile(joinPath(folderScan.rootPath, name));
            if (manifestText) break;
          } catch {
            // Try next manifest name
          }
        }
      }
      const ytypDefs = [];
      for (const xmlPath of (folderScan.ytypXmls || []).slice(0, 16)) {
        try {
          const text = await readTextFile(xmlPath);
          ytypDefs.push(...parseYtypXml(text));
        } catch {
          // Skip unreadable XML
        }
      }
      let streamed = [];
      try {
        const desc = await invoke("describe_streamed_assets", { root: folderScan.rootPath });
        streamed = Array.isArray(desc?.files) ? desc.files : [];
      } catch {
        streamed = [];
      }
      if (auditRunRef.current !== runId) return;
      const audit = auditPropScript({
        label: folderScan.label,
        hasManifest: folderScan.hasManifest,
        manifestText,
        models: folderScan.models,
        ytypXmls: folderScan.ytypXmls || [],
        ytypDefs,
        streamedFiles: streamed,
      });
      setScriptAudit(audit);
      setInspectorOpen(true);
      setInspectorTab("qa");
    } catch (error) {
      if (auditRunRef.current === runId) {
        raiseAlert("audit", "Script audit failed", errorMessage(error));
      }
    } finally {
      if (auditRunRef.current === runId) setScriptAuditBusy(false);
    }
  }, [folderScan, isTauriRuntime, raiseAlert, scriptAuditBusy]);

  const handleAttachTransform = useCallback((local) => {
    updateAttach({ position: local.position, rotation: local.rotation });
  }, [updateAttach]);

  /* ── Keyboard ── */
  useEffect(() => {
    if (!isActive || exportOpen) return undefined;
    const onKeyDown = (event) => {
      if (event.ctrlKey || event.altKey || event.metaKey || isEditableTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === " " && isInteractiveTarget(event.target)) return;
      const current = settingsRef.current;
      if (key === "f") viewportRef.current?.frame(current.cameraPreset);
      else if (key === " ") updateView({ turntable: !current.view.turntable });
      else if (key === "w") updateView({ wireframe: !current.view.wireframe });
      else if (key === "e") updateEmissive({ enabled: !current.emissive.enabled });
      else if (key === "l") updateLights({ enabled: !current.lights.enabled });
      else if (key === "n") updateScene({ dark: current.scene.dark > 0 ? 0 : 1 });
      else if (key === "g" && current.attach?.enabled) setAttachGizmoMode((m) => (m === "translate" ? "off" : "translate"));
      else if (key === "r" && current.attach?.enabled) setAttachGizmoMode((m) => (m === "rotate" ? "off" : "rotate"));
      else if (event.key === "[") stepFolderProp(-1);
      else if (event.key === "]") stepFolderProp(1);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [exportOpen, isActive, stepFolderProp, updateEmissive, updateLights, updateScene, updateView]);

  /* ── Keyboard: the customizable view and camera shortcuts ── */
  const showShot = (key) => {
    if (!prop) return false;
    setSettings((prev) => ({ ...prev, cameraPreset: key }));
    viewportRef.current?.frame(key);
    return true;
  };
  const hotkeys = useWorkspaceHotkeys({
    isActive,
    enabled: !exportOpen,
    handlers: {
      [HOTKEY_ACTIONS.TOGGLE_PANEL]: () => setPanelCollapsed((value) => !value),
      [HOTKEY_ACTIONS.RESET_VIEW]: () => viewportRef.current?.frame(settingsRef.current.cameraPreset),
      [HOTKEY_ACTIONS.CAMERA_PRESET_FRONT]: () => showShot("front"),
      [HOTKEY_ACTIONS.CAMERA_PRESET_BACK]: () => showShot("back"),
      [HOTKEY_ACTIONS.CAMERA_PRESET_SIDE]: () => showShot("right"),
      [HOTKEY_ACTIONS.CAMERA_PRESET_ANGLE]: () => showShot("angle"),
      [HOTKEY_ACTIONS.CAMERA_PRESET_TOP]: () => showShot("top"),
      [HOTKEY_ACTIONS.CAPTURE_VIEW]: () => (isTauriRuntime && prop ? handleScreenshot() : false),
      [HOTKEY_ACTIONS.SELECT_MODEL]: () => (isTauriRuntime ? handlePickModel() : false),
    },
  });

  /* ── Derived ── */
  const showroomOn = scene.stage === "showroom";
  const showroomOptions = useMemo(
    () => ({ light: scene.light, spot: scene.spot, reflect: scene.reflect, beam: scene.beam, rim: scene.rim, floor: scene.floor }),
    [scene.light, scene.spot, scene.reflect, scene.beam, scene.rim, scene.floor],
  );
  const materialGroups = useMemo(() => prop?.materialGroups() || [], [prop, overrideTick, nativeStatus.state]);
  const emissiveGroups = materialGroups.filter((group) => group.emissive);
  const modelLights = prop?.lights || [];
  const hasModel = Boolean(prop);
  const loading = load.status === "loading";
  const activePreset = useMemo(() => matchStudioPreset(scene, "prop"), [scene]);
  const filteredFolderProps = useMemo(
    () => filterPropModels(folderProps, folderFilter),
    [folderProps, folderFilter],
  );
  const qaErrorCount = health?.counts?.error || 0;
  const qaWarnCount = health?.counts?.warn || 0;
  const qaBadgeCount = qaErrorCount + qaWarnCount;

  const stageControls = {
    stage: scene.stage,
    setStage: (value) => updateScene({ stage: value }),
    stageLight: scene.light,
    setStageLight: (value) => updateScene({ light: value }),
    stageSpot: scene.spot,
    setStageSpot: (value) => updateScene({ spot: value }),
    stageReflect: scene.reflect,
    setStageReflect: (value) => updateScene({ reflect: value }),
    stageBeam: scene.beam,
    setStageBeam: (value) => updateScene({ beam: value }),
  };
  const frameState = { isActive, isBooting: false, contextBarTarget, panelCollapsed, setPanelCollapsed, hotkeys };
  const exportBlocked = !isTauriRuntime ? "Exporting needs the desktop app." : !hasModel ? "Open a prop to export media." : "";
  const dims = info.dims;
  const modelNote = (() => {
    if (load.status === "loading") return { tone: "idle", text: "Loading the model…" };
    if (load.status === "error") return { tone: "error", text: load.error };
    if (!hasModel) return null;
    const format = FORMAT_NAMES[prop.format] || prop.format;
    if (load.parser === "parser") return { tone: "warn", text: `${format}, geometry only` };
    return { tone: "ok", text: `${format}${dims ? ` · ${formatLength(dims.x)} × ${formatLength(dims.y)} × ${formatLength(dims.z)}` : ""}` };
  })();
  const textureNote = (() => {
    if (!hasModel) return null;
    if (nativeStatus.state === "loading") return { tone: "idle", text: `Loading textures ${nativeStatus.loaded || 0} of ${nativeStatus.planned || "…"}` };
    if (nativeStatus.state === "error") return { tone: "error", text: `Textures didn't load: ${nativeStatus.error}` };
    if (nativeStatus.state !== "ready") return { tone: "warn", text: "No texture information for this model" };
    const problems = [];
    if (nativeStatus.failed > 0) problems.push(`${nativeStatus.failed} couldn't load`);
    if (nativeStatus.missing > 0) problems.push(`${nativeStatus.missing} not found`);
    return problems.length
      ? { tone: "warn", text: `${nativeStatus.loaded} textures; ${problems.join(", ")}` }
      : { tone: "ok", text: `${nativeStatus.loaded} ${nativeStatus.loaded === 1 ? "texture" : "textures"} loaded` };
  })();
  const watchNote = settings.liveReload
    ? watchState.status === "watching"
      ? { tone: "live", text: "Reloads when the model, .ytd or .ytyp changes" }
      : watchState.status === "error"
        ? { tone: "error", text: `Live reload is off: ${watchState.error}` }
        : null
    : null;
  const bloomOn = hasModel && emissive.glow > 0 && (glowing || (lights.enabled && modelLights.length > 0));

  return (
    <WorkspaceFrame s={frameState} inspectorOpen={inspectorOpen} setInspectorOpen={setInspectorOpen} style={panes.style}>
      {/* ──── Asset pipeline ──── */}
      <aside className="lv-dock" aria-label="Prop files" inert={panelCollapsed}>
        <div className="lv-dock-scroll custom-scrollbar">
          <AssetSlot
            id="ps-model"
            step={1}
            title="Model"
            path={settings.modelPath}
            emptyTitle="Open a prop"
            emptyHint=".ydr, .ydd, .yft, .glb or .gltf. Drop one here too."
            hotkey={hotkeys[HOTKEY_ACTIONS.SELECT_MODEL]}
            onPick={handlePickModel}
            onUnload={handleUnload}
            done={hasModel && load.status !== "error"}
            disabled={!isTauriRuntime}
            disabledNote="Opening game models needs the desktop app."
            trailing={hasModel ? (
              <button type="button" className="cx-icon-btn" onClick={triggerReload} title="Reload from disk" aria-label="Reload from disk" disabled={loading}>
                <RefreshCw aria-hidden="true" className={loading ? "ps-spin" : undefined} />
              </button>
            ) : null}
          >
            {modelNote ? (
              <p className={`lv-slot-note is-${modelNote.tone}`} role="status" aria-live="polite">
                <span className="lv-dot" aria-hidden="true" />
                <span>{modelNote.text}</span>
              </p>
            ) : null}
            {load.warnings.map((warning) => (
              <p key={warning} className="lv-slot-note is-warn">
                <span className="lv-dot" aria-hidden="true" />
                <span>{warning}</span>
              </p>
            ))}
            {settings.modelPath ? (
              <div className="lv-toggle-row">
                <span>Live reload</span>
                <Toggle checked={settings.liveReload} onChange={(value) => setSettings((prev) => ({ ...prev, liveReload: value }))} ariaLabel="Reload when the model or its textures change" />
              </div>
            ) : null}
            {watchNote ? (
              <p className={`lv-slot-note is-${watchNote.tone}`}>
                <span className="lv-dot" aria-hidden="true" />
                <span>{watchNote.text}</span>
              </p>
            ) : null}
          </AssetSlot>

          <section className={`lv-slot ${settings.extraYtds.length ? "is-filled" : "is-empty"} ${!settings.modelPath ? "is-disabled" : ""}`}>
            <header className="lv-slot-head">
              <span className={`lv-step ${nativeStatus.state === "ready" && !nativeStatus.missing ? "is-done" : ""}`} aria-hidden="true">
                {nativeStatus.state === "ready" && !nativeStatus.missing ? <Check /> : 2}
              </span>
              <h3 className="lv-slot-title" title="Found next to the model, through its .ytyp archetype, and in the game files">Textures</h3>
            </header>
            <div className="lv-slot-body">
              {!settings.modelPath ? (
                <p className="lv-slot-note">Found next to the model and in the game files.</p>
              ) : (
                <>
                  {textureNote ? (
                    <p className={`lv-slot-note is-${textureNote.tone}`} role="status" aria-live="polite">
                      <span className="lv-dot" aria-hidden="true" />
                      <span>{textureNote.text}</span>
                    </p>
                  ) : null}
                  {nativeStatus.state === "loading" && nativeStatus.planned > 0 ? (
                    <div className="lv-progress" role="progressbar" aria-label="Loading textures" aria-valuemin={0} aria-valuemax={nativeStatus.planned} aria-valuenow={nativeStatus.loaded}>
                      <span style={{ width: `${Math.round(((nativeStatus.loaded + nativeStatus.failed) / nativeStatus.planned) * 100)}%` }} />
                    </div>
                  ) : null}
                  {settings.extraYtds.map((path) => (
                    <div key={path} className="ps-ytd">
                      <span className="ps-ytd-name" title={path}>{splitPath(path).name}</span>
                      <button type="button" className="cx-icon-btn" onClick={() => handleRemoveYtd(path)} aria-label={`Remove ${splitPath(path).name}`} title="Remove">
                        <X aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                  <button type="button" className="lv-drop lv-drop--inline" onClick={handleAddYtd} disabled={!isTauriRuntime}>
                    <span className="lv-drop-title">Add a texture dictionary</span>
                    <span className="lv-drop-hint">Fills textures the model couldn&apos;t find, by name.</span>
                  </button>
                </>
              )}
            </div>
          </section>

          <section className={`lv-slot ${folderProps.length ? "is-filled" : "is-empty"} ${!isTauriRuntime ? "is-disabled" : ""}`}>
            <header className="lv-slot-head">
              <span className={`lv-step ${folderProps.length > 0 ? "is-done" : ""}`} aria-hidden="true">
                {folderProps.length > 0 ? <Check /> : 3}
              </span>
              <h3 className="lv-slot-title">Script / folder</h3>
              {folderProps.length > 1 ? (
                <div className="ps-folder-nav">
                  <button type="button" className="cx-icon-btn" onClick={() => stepFolderProp(-1)} title="Previous prop ([)" aria-label="Previous prop">
                    <ChevronLeft aria-hidden="true" />
                  </button>
                  <button type="button" className="cx-icon-btn" onClick={() => stepFolderProp(1)} title="Next prop (])" aria-label="Next prop">
                    <ChevronRight aria-hidden="true" />
                  </button>
                </div>
              ) : null}
            </header>
            <div className="lv-slot-body">
              {folderScan && folderProps.length > 0 ? (
                <div className="ps-script-head" title={folderScan.scanRoot}>
                  <span className="ps-script-name">{folderScan.label}</span>
                  {folderScan.detectedStream ? (
                    <span className="ps-badge is-accent" title={`Auto-detected ${folderScan.scanRoot}`}>
                      {folderScan.kind === "pack" ? "streams" : "stream/"}
                    </span>
                  ) : null}
                  <span className="ps-row-meta">{folderProps.length}</span>
                </div>
              ) : null}
              {folderProps.length > 5 ? (
                <label className="ps-search">
                  <Search aria-hidden="true" />
                  <input
                    type="search"
                    value={folderFilter}
                    placeholder={`Filter ${folderProps.length} models…`}
                    aria-label="Filter models in script or folder"
                    onChange={(event) => setFolderFilter(event.target.value)}
                  />
                </label>
              ) : null}
              {folderProps.length > 0 ? (
                <ul className="ps-folder-list custom-scrollbar" role="listbox" aria-label="Models in this script or folder">
                  {filteredFolderProps.map((entry) => {
                    const active = entry.path.toLowerCase() === settings.modelPath.toLowerCase();
                    const subLabel = folderScan?.kind === "pack"
                      ? [entry.resourceName, entry.subPath].filter(Boolean).join("/")
                      : entry.subPath;
                    return (
                      <li key={entry.path}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={active}
                          className={`ps-folder-item ${active ? "is-active" : ""}`}
                          title={entry.path}
                          onClick={() => openModel(entry.path, { folderPath: settings.folderPath || folderScan?.rootPath || "" })}
                        >
                          <span className="ps-folder-main">
                            <span className="ps-folder-name">{entry.stem || entry.name.replace(/\.[^.]+$/, "")}</span>
                            {subLabel ? <span className="ps-folder-sub">{subLabel}</span> : null}
                          </span>
                          <span className="ps-folder-ext">{entry.ext || entry.name.slice(entry.name.lastIndexOf("."))}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <button type="button" className="lv-drop lv-drop--inline" onClick={handlePickFolder} disabled={!isTauriRuntime}>
                  <span className="lv-drop-title">Select a script or folder</span>
                  <span className="lv-drop-hint">Pick a FiveM script (auto-detects stream/) or any prop folder.</span>
                </button>
              )}
              {folderProps.length > 0 ? (
                <div className="ps-head-acts">
                  <button type="button" className="lv-link ps-open-folder" onClick={handlePickFolder}>
                    Change script / folder…
                  </button>
                  {hasModel ? (
                    <button type="button" className="lv-link ps-open-folder" onClick={handleRunScriptAudit} disabled={scriptAuditBusy}>
                      {scriptAuditBusy ? "Auditing…" : "Audit script"}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </section>
        </div>
        <div className="lv-dock-foot">
          <button
            type="button"
            className="cx-btn is-primary"
            disabled={Boolean(exportBlocked)}
            onClick={() => setExportOpen(true)}
            title="PNG icon, contact sheet, batch folder icons, or 30 fps turntable video"
          >
            <ImageDown aria-hidden="true" />
            Export media…
          </button>
          <div className="lv-foot-row">
            <button type="button" className="cx-btn" disabled={Boolean(exportBlocked)} onClick={handleScreenshot} title="Save the viewfinder exactly as framed now">
              <Aperture aria-hidden="true" />
              Save this view
            </button>
          </div>
          {exportBlocked ? <p className="lv-foot-note">{exportBlocked}</p> : null}
        </div>
        <PaneResizer side="dock" label="Resize the prop files panel" setWidth={panes.setWidth} />
      </aside>

      {/* ──── Viewfinder ──── */}
      <section className={`lv-finder ${dragging ? "is-dragging" : ""}`} aria-label="Prop preview">
        <div className="lv-stage">
          {isTauriRuntime ? (
            <PropViewport
              ref={viewportRef}
              prop={prop}
              isActive={isActive}
              backgroundColor={scene.backdrop}
              lightIntensity={scene.lightLevel}
              dark={scene.dark}
              stage={scene.stage}
              showroom={showroomOptions}
              showGrid={scene.grid && hasModel}
              showShadows={scene.shadows}
              ambientOcclusion={scene.ambientOcclusion}
              bloom={bloomOn}
              animating={view.turntable && hasModel}
              onAnimate={handleAnimate}
              onFrame={handleFrame}
              showMeshStats={view.meshStats && hasModel}
              onMeshStats={setMeshStats}
              hideModel={view.collisions && collisionsOnly && collisionInfo?.status === "ready"}
              scaleRef={view.scaleRef}
              attach={attach}
              attachGizmoMode={attachGizmoMode}
              onAttachStatus={setAttachStatus}
              onAttachTransform={handleAttachTransform}
              onPickMaterial={handlePickFromViewport}
              onCameraDistance={handleCameraDistance}
            />
          ) : (
            <StageEmpty icon={Monitor} title="Desktop app required" line="Reading game models, textures and lights needs the Cortex Studio desktop app." />
          )}
          {isTauriRuntime && !hasModel && !loading ? (
            <StageEmpty
              icon={Flashlight}
              tone={load.status === "error" ? "error" : undefined}
              title={load.status === "error" ? "The model didn't load" : "No prop open"}
              line={load.status === "error" ? load.error : "Open a .ydr, .ydd, .yft, .glb or .gltf, select your FiveM script (auto-detects stream/), or drop one here."}
            >
              <div className="ps-empty-acts">
                <button type="button" className="cx-btn is-primary" onClick={handlePickModel}>
                  <FolderOpen aria-hidden="true" />
                  Open a prop
                </button>
                <button type="button" className="cx-btn" onClick={handlePickFolder}>
                  Select script / folder
                </button>
              </div>
            </StageEmpty>
          ) : null}
        </div>

        <div className="lv-hud">
          {hasModel ? (
            <StageToggle showroom={showroomOn} onChange={(on) => updateScene({ stage: on ? "showroom" : "workbench" })} title="A dark product studio with a reflective floor and a spotlight you can aim" />
          ) : null}

          <div className="lv-slip-stack">
            {loading || (hasModel && (view.bounds && dims || qaBadgeCount > 0 || view.autoLod || reloadDelta)) ? (
              <div className="lv-slip ps-status" role="status" aria-live="polite">
                {loading ? (
                  <span className="ps-status-row">
                    <Loader2 className="ps-spin" aria-hidden="true" />
                    <span>{hasModel ? "Reloading…" : "Loading the model…"}</span>
                  </span>
                ) : null}
                {hasModel && view.bounds && dims ? (
                  <span className="ps-status-row ps-dims">
                    <span>{formatLength(dims.x)}</span>×<span>{formatLength(dims.y)}</span>×<span>{formatLength(dims.z)}</span>
                  </span>
                ) : null}
                {hasModel && view.autoLod ? (
                  <span className="ps-status-row ps-dims">
                    <span>Auto LOD: {PROP_LOD_LABELS[effectiveLod] || effectiveLod}</span>
                    {cameraDist != null ? ` · ${cameraDist.toFixed(1)} m` : ""}
                  </span>
                ) : null}
                {hasModel && qaBadgeCount > 0 ? (
                  <button
                    type="button"
                    className={`ps-qa-pill ${qaErrorCount > 0 ? "is-error" : "is-warn"}`}
                    onClick={() => {
                      setInspectorOpen(true);
                      setInspectorTab("qa");
                    }}
                    title="Open Prop Doctor findings"
                  >
                    {qaErrorCount > 0 ? <ShieldAlert aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
                    <span>
                      {qaErrorCount ? `${qaErrorCount} ${qaErrorCount === 1 ? "error" : "errors"}` : ""}
                      {qaErrorCount && qaWarnCount ? " · " : ""}
                      {qaWarnCount ? `${qaWarnCount} ${qaWarnCount === 1 ? "warning" : "warnings"}` : ""}
                    </span>
                  </button>
                ) : null}
                {reloadDelta ? (
                  <div className="ps-delta-row">
                    <span className="ps-delta-items">
                      {reloadDelta.parts.map((part) => (
                        <span key={part.key} className={`ps-delta-chip is-${part.tone}`}>{part.label}</span>
                      ))}
                    </span>
                    <button type="button" className="cx-icon-btn" onClick={() => setReloadDelta(null)} aria-label="Dismiss reload diff" title="Dismiss">
                      <X aria-hidden="true" />
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {hasModel && view.collisions ? (
              <CollisionSlip
                info={collisionInfo || { status: "loading" }}
                showModel={!collisionsOnly}
                onShowModelChange={(value) => setCollisionsOnly(!value)}
              />
            ) : null}
            {hasModel && view.meshStats && meshStats ? <MeshStatsSlip stats={{ ...meshStats, size: dims ? { length: Math.max(dims.x, dims.y), width: Math.min(dims.x, dims.y), height: dims.z } : null }} /> : null}
          </div>

          <div className="lv-alerts" role="status" aria-live="polite">
            <AnimatePresence initial={false}>
              {alerts.map((alert) => (
                <motion.div key={alert.id} className="lv-alert" role="alert" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.16 }}>
                  <AlertTriangle className="lv-alert-icon" aria-hidden="true" />
                  <div className="lv-alert-copy">
                    <strong>{alert.label}</strong>
                    <ErrorText error={alert.text} />
                  </div>
                  <button type="button" className="cx-icon-btn" onClick={() => dismissAlert(alert.id)} aria-label="Dismiss">
                    <X aria-hidden="true" />
                  </button>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>

          <div className="lv-toasts">
            <AnimatePresence>
              {notice ? (
                <motion.div key={notice.id} className="lv-toast" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 12 }} transition={{ duration: 0.18 }}>
                  <Check aria-hidden="true" />
                  <span title={notice.message}>{notice.message}</span>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>

          {dragging ? (
            <div className="lv-dropzone" aria-hidden="true">
              <span className="cx-display">Release to load</span>
              <span>A .ydr, .ydd, .yft, .glb, .gltf or FiveM script folder opens; a .ytd adds its textures.</span>
            </div>
          ) : null}

          {hasModel ? (
            <div className="lv-deck" role="toolbar" aria-label="Camera and view">
              <div className="lv-deck-group" role="group" aria-label="Camera shots">
                {PROP_CAMERA_PRESETS.map((preset) => (
                  <DeckButton
                    key={preset.key}
                    active={settings.cameraPreset === preset.key}
                    onClick={() => {
                      setSettings((prev) => ({ ...prev, cameraPreset: preset.key }));
                      viewportRef.current?.frame(preset.key);
                    }}
                    title={`${preset.label} view`}
                  >
                    {preset.label}
                  </DeckButton>
                ))}
                <DeckButton onClick={() => viewportRef.current?.frame(settings.cameraPreset)} title="Frame the prop (F)" className="is-icon">
                  <Crosshair aria-hidden="true" />
                </DeckButton>
              </div>
              <div className="lv-deck-group" role="group" aria-label="Turn the prop a quarter turn">
                {["x", "y", "z"].map((axis) => (
                  <DeckButton
                    key={axis}
                    onClick={() => updateView({ orientation: rotateOrientation(view.orientation, axis) })}
                    title={`Turn 90° about ${axis.toUpperCase()}`}
                    className={`is-axis is-${axis}`}
                  >
                    {axis.toUpperCase()}
                  </DeckButton>
                ))}
                <DeckButton
                  onClick={() => updateView({ orientation: [0, 0, 0, 1] })}
                  disabled={isIdentityOrientation(view.orientation)}
                  title="Back to the authored orientation"
                  className="is-icon"
                >
                  <RotateCcw aria-hidden="true" />
                </DeckButton>
                <DeckButton active={view.turntable} onClick={() => updateView({ turntable: !view.turntable })} title="Turntable (Space)" className="is-icon">
                  <RotateCw aria-hidden="true" />
                </DeckButton>
              </div>
              <DeckViewMenu
                groups={[deckButtonItems(
                  <>
                    <DeckButton active={view.wireframe} onClick={() => updateView({ wireframe: !view.wireframe })} title="Wireframe (W)" label="Wireframe" className="is-icon">
                      <Box aria-hidden="true" />
                    </DeckButton>
                    <DeckButton active={view.meshStats} onClick={() => updateView({ meshStats: !view.meshStats })} title="Mesh stats" className="is-icon">
                      <Triangle aria-hidden="true" />
                    </DeckButton>
                    <DeckButton active={view.collisions} onClick={() => updateView({ collisions: !view.collisions })} title="Collisions" className="is-icon">
                      <Hexagon aria-hidden="true" />
                    </DeckButton>
                    <DeckButton active={view.origin} onClick={() => updateView({ origin: !view.origin })} title="GTA origin and axes" className="is-icon">
                      <Axis3d aria-hidden="true" />
                    </DeckButton>
                    <DeckButton active={scene.grid && !showroomOn} onClick={() => updateScene({ grid: !scene.grid })} title="Ground grid" note="Workbench only" disabled={showroomOn} className="is-icon">
                      <Grid3x3 aria-hidden="true" />
                    </DeckButton>
                    <DeckButton active={scene.shadows || showroomOn} onClick={() => updateScene({ shadows: !scene.shadows })} title="Ground shadow" note="Always on in the showroom" disabled={showroomOn} className="is-icon">
                      <Sun aria-hidden="true" />
                    </DeckButton>
                    <DeckButton active={scene.ambientOcclusion} onClick={() => updateScene({ ambientOcclusion: !scene.ambientOcclusion })} title="Ambient occlusion" className="is-icon">
                      <Contrast aria-hidden="true" />
                    </DeckButton>
                    <DeckButton active={scene.dark > 0} onClick={() => updateScene({ dark: scene.dark > 0 ? 0 : 1 })} title="Dark room: studio lights off (N)" label="Dark room" note="Studio lights off" className="is-icon">
                      <Moon aria-hidden="true" />
                    </DeckButton>
                  </>,
                )]}
              />
              <div className="lv-deck-group" ref={helpWrapRef}>
                <DeckButton active={helpOpen} onClick={() => setHelpOpen((value) => !value)} title="Mouse and keyboard controls" className="is-icon">
                  <CircleHelp aria-hidden="true" />
                </DeckButton>
                {helpOpen ? <PropHelp /> : null}
              </div>
            </div>
          ) : null}
        </div>
      </section>

      {/* ──── Inspector ──── */}
      <aside className="lv-inspector" aria-label="Inspector" inert={panelCollapsed || !inspectorOpen}>
        <PaneResizer side="insp" label="Resize the inspector" setWidth={panes.setWidth} />
        <InspectorTabs
          tabs={[
            { id: "model", label: "Model" },
            { id: "qa", label: qaBadgeCount > 0 ? `QA ${qaBadgeCount}` : "QA" },
            { id: "light", label: "Light" },
            { id: "attach", label: "Attach" },
            { id: "scene", label: "Scene" },
          ]}
          active={inspectorTab}
          onChange={setInspectorTab}
        />
        <div className="lv-inspector-scroll custom-scrollbar">
          {!hasModel && inspectorTab !== "scene" ? (
            <p className="ps-inspector-empty">Open a prop to inspect its LODs, QA checks, materials, lights and ped attachments.</p>
          ) : null}

          {hasModel && inspectorTab === "model" ? (
            <>
              <section className="lv-group">
                <h3 className="lv-group-title">View</h3>
                <Seg id="ps-view-mode" label="Shading" value={view.mode} options={VIEW_MODES} onChange={(mode) => updateView({ mode })} className="ps-seg-grid" />
                {view.mode === "textured" ? (
                  <>
                    <Seg id="ps-channel" label="Channel" value={view.channel} options={CHANNEL_OPTIONS} onChange={(channel) => updateView({ channel })} />
                    <Seg id="ps-channel-map" label="Map slot" value={view.channelMap} options={CHANNEL_MAP_OPTIONS} onChange={(channelMap) => updateView({ channelMap })} />
                  </>
                ) : null}
                {view.mode === "backface" ? (
                  <p className="lv-slot-note">Red surfaces are backfaces — recalculate normals outside before shipping to FiveM.</p>
                ) : null}
                {view.mode === "vertex" && !qaMetrics?.hasVertexColors ? (
                  <p className="lv-slot-note">This model carries no vertex colour channel.</p>
                ) : null}

                {lods.length > 0 ? (
                  <>
                    <div className="lv-group-head">
                      <span className="cx-label" id="ps-lod">Level of detail</span>
                      {lods.length > 1 ? (
                        <label className="ps-inline-toggle">
                          <span>Auto by distance</span>
                          <Toggle checked={view.autoLod} onChange={(autoLod) => updateView({ autoLod })} ariaLabel="Switch LOD automatically by camera distance" />
                        </label>
                      ) : null}
                    </div>
                    <Seg
                      id="ps-lod"
                      value={effectiveLod}
                      options={PROP_LODS.map((lod) => ({
                        id: lod,
                        label: PROP_LOD_LABELS[lod],
                        disabled: !lods.includes(lod) || view.autoLod,
                        title: !lods.includes(lod) ? "This model has no such LOD" : view.autoLod ? "Controlled by Auto LOD distance" : undefined,
                      }))}
                      onChange={(lod) => updateView({ lod, autoLod: false })}
                    />
                  </>
                ) : (
                  <p className="lv-slot-note">LODs are listed when the CodeWalker bridge reads the model.</p>
                )}

                {prop.drawables.length > 1 ? (
                  <div className="lv-field">
                    <span className="cx-label">Drawable</span>
                    <Select value={String(view.drawable)} onValueChange={(value) => updateView({ drawable: Number(value) })}>
                      <SelectTrigger aria-label="Drawable"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="-1">All {prop.drawables.length} drawables</SelectItem>
                        {prop.drawables.map((drawable) => (
                          <SelectItem key={drawable.index} value={String(drawable.index)}>{drawable.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
              </section>

              <section className="lv-group">
                <div className="lv-group-head">
                  <h3 className="lv-group-title">Materials</h3>
                  {Object.keys(view.hiddenMaterials).length > 0 ? (
                    <button type="button" className="lv-link" onClick={() => updateView({ hiddenMaterials: {} })}>Show all</button>
                  ) : null}
                </div>
                <p className="lv-slot-note">Click any surface on the prop or a row below to inspect its bindings and test a local texture.</p>
                <ul className="ps-rows">
                  {materialGroups.map((group) => {
                    const hidden = Boolean(view.hiddenMaterials[group.key]);
                    const selected = selectedMaterialKey === group.key;
                    const missingCount = (group.bindings || []).filter((b) => !b.resolved).length;
                    return (
                      <li key={group.key} className={`ps-row ps-row--mat ${hidden ? "is-hidden" : ""} ${selected ? "is-selected" : ""}`}>
                        <div className="ps-row-top">
                          <button
                            type="button"
                            className="ps-row-pick"
                            onClick={() => setSelectedMaterialKey((prev) => (prev === group.key ? "" : group.key))}
                          >
                            <span className="ps-row-label" title={group.label}>{group.label}</span>
                            <span className="ps-row-meta" title={group.textures.join(", ")}>
                              {group.shaderName || "material"} · {formatCount(group.triangles)} tris
                              {missingCount > 0 ? ` · ${missingCount} missing` : ""}
                            </span>
                          </button>
                          {group.overridePath ? <span className="ps-badge is-accent" title={group.overridePath}>Test</span> : null}
                          {group.emissive ? <span className="ps-badge" title="Emissive shader">Emissive</span> : null}
                          <button
                            type="button"
                            className="cx-icon-btn"
                            onClick={() => {
                              const next = { ...view.hiddenMaterials };
                              if (hidden) delete next[group.key];
                              else next[group.key] = true;
                              updateView({ hiddenMaterials: next });
                            }}
                            aria-label={hidden ? `Show ${group.label}` : `Hide ${group.label}`}
                            title={hidden ? "Show" : "Hide"}
                          >
                            {hidden ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                          </button>
                        </div>

                        {selected ? (
                          <div className="ps-mat-detail">
                            {group.bindings?.length ? (
                              <ul className="ps-bindings">
                                {group.bindings.map((binding) => (
                                  <li key={`${binding.paramName}-${binding.textureName}`} className={binding.resolved ? "" : "is-missing"}>
                                    <span className="ps-binding-slot">{binding.usage}</span>
                                    <span className="ps-binding-name" title={binding.resolvedPath || binding.textureName}>{binding.textureName}</span>
                                    <span className="ps-binding-src">{binding.resolved ? (binding.source || "ok") : "missing"}</span>
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p className="lv-slot-note">No texture samplers on this shader.</p>
                            )}
                            <div className="ps-btn-row">
                              <button
                                type="button"
                                className="cx-btn"
                                disabled={!isTauriRuntime}
                                onClick={() => handlePickMaterialOverride(group.key)}
                                title="Preview any PNG, PSD or DDS on this material without repacking the .ytd"
                              >
                                <ImagePlus aria-hidden="true" />
                                {group.overridePath ? "Swap test texture…" : "Test texture…"}
                              </button>
                              {group.overridePath ? (
                                <button type="button" className="cx-btn is-quiet" onClick={() => handleClearMaterialOverride(group.key)}>
                                  Restore
                                </button>
                              ) : null}
                            </div>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </section>

              <section className="lv-group">
                <h3 className="lv-group-title">Presentation &amp; scale</h3>
                <div className="lv-field">
                  <span className="cx-label">Scale reference (1:1 GTA metres)</span>
                  <Select value={view.scaleRef} onValueChange={(scaleRef) => updateView({ scaleRef })} disabled={attach.enabled}>
                    <SelectTrigger aria-label="Scale reference"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {SCALE_REFERENCES.map((item) => (
                        <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {attach.enabled ? <p className="lv-slot-note">Turn off ped attachment to use scale ghosts.</p> : null}
                </div>
                <ToggleRow label="Turntable" checked={view.turntable} onChange={(value) => updateView({ turntable: value })} disabled={attach.enabled} />
                <Slider id="ps-turntable-speed" label="Turntable speed" value={view.turntableSpeed} min={2} max={90} step={1} disabled={attach.enabled || !view.turntable} format={(value) => `${value}°/s`} onChange={(value) => updateView({ turntableSpeed: value })} />
                <ToggleRow label="Origin and axes" note="GTA X red, Y green, Z blue" checked={view.origin} onChange={(value) => updateView({ origin: value })} />
                <ToggleRow label="Bounding box" note="Dimensions show in the viewfinder" checked={view.bounds} onChange={(value) => updateView({ bounds: value })} />
              </section>
            </>
          ) : null}

          {hasModel && inspectorTab === "qa" ? (
            <PropHealthPanel
              prop={prop}
              modelPath={settings.modelPath}
              load={load}
              dims={dims}
              info={info}
              lods={lods}
              materialGroups={materialGroups}
              modelLights={modelLights}
              nativeStatus={nativeStatus}
              textureMetas={nativeStatus.textures?.length ? nativeStatus.textures : prop.embeddedTextures || []}
              health={health}
              collisionsStatus={collisionInfo.status}
              hasVertexColors={Boolean(qaMetrics?.hasVertexColors)}
              siblingYtdName={ytypInfo.siblingYtd}
              folderScan={folderScan}
              scriptAudit={scriptAudit}
              scriptAuditBusy={scriptAuditBusy}
              onRunScriptAudit={handleRunScriptAudit}
              isTauriRuntime={isTauriRuntime}
              onOpenCollisions={() => updateView({ collisions: true })}
              onInspectBackface={() => {
                updateView({ mode: "backface" });
                setInspectorTab("model");
              }}
              onInspectUvs={() => {
                updateView({ mode: "uv" });
                setInspectorTab("model");
              }}
              onOpenMaterials={() => setInspectorTab("model")}
              onOpenFolder={openModelFolder}
              onNotify={notify}
            />
          ) : null}

          {hasModel && inspectorTab === "light" ? (
            <>
              <section className="lv-group">
                <div className="lv-group-head">
                  <h3 className="lv-group-title">Emissives</h3>
                  <Toggle checked={emissive.enabled} onChange={(value) => updateEmissive({ enabled: value })} ariaLabel="Emissives on (E)" />
                </div>
                {emissiveGroups.length === 0 ? (
                  <p className="lv-slot-note">This model has no emissive materials.</p>
                ) : (
                  <>
                    <Slider id="ps-emissive" label="Brightness" value={emissive.strength} min={0} max={8} step={0.05} format={(value) => `${value.toFixed(2)}×`} onChange={(value) => updateEmissive({ strength: value })} />
                    <Slider id="ps-glow" label="Glow" value={emissive.glow} min={0} max={3} step={0.05} format={(value) => `${value.toFixed(2)}×`} onChange={(value) => updateEmissive({ glow: value })} />
                    <ToggleRow
                      label="Use the game's multipliers"
                      note="emissiveMultiplier, compressed to 0.25–4×"
                      checked={emissive.useGameMultiplier}
                      onChange={(value) => updateEmissive({ useGameMultiplier: value })}
                    />
                    {emissiveGroups.some((group) => group.nightOnly) ? (
                      <ToggleRow label="Light night-only emissives" note="emissivenight shaders" checked={emissive.nightOnly} onChange={(value) => updateEmissive({ nightOnly: value })} />
                    ) : null}
                    <ul className="ps-rows">
                      {emissiveGroups.map((group) => {
                        const off = Boolean(emissive.off[group.key]);
                        const level = emissive.levels[group.key] ?? 1;
                        return (
                          <li key={group.key} className={`ps-row ps-row--stack ${off ? "is-hidden" : ""}`}>
                            <div className="ps-row-top">
                              <span className="ps-row-main">
                                <span className="ps-row-label" title={group.label}>{group.label}</span>
                                <span className="ps-row-meta">
                                  {group.shaderName}
                                  {group.multiplier !== null ? ` · game ×${group.multiplier.toFixed(2)} → ${emissiveLevel(group.multiplier).toFixed(2)}×` : ""}
                                </span>
                              </span>
                              <Toggle
                                checked={!off}
                                onChange={(value) => {
                                  const next = { ...emissive.off };
                                  if (value) delete next[group.key];
                                  else next[group.key] = true;
                                  updateEmissive({ off: next });
                                }}
                                ariaLabel={`${group.label} lit`}
                              />
                            </div>
                            <Slider
                              id={`ps-emissive-${group.key}`}
                              label="Level"
                              value={level}
                              min={0}
                              max={8}
                              step={0.05}
                              format={(value) => `${value.toFixed(2)}×`}
                              onChange={(value) => updateEmissive({ levels: { ...emissive.levels, [group.key]: value } })}
                            />
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </section>

              <section className="lv-group">
                <div className="lv-group-head">
                  <h3 className="lv-group-title">Prop lights</h3>
                  {modelLights.length > 0 ? (
                    <Toggle checked={lights.enabled} onChange={(value) => updateLights({ enabled: value })} ariaLabel="Prop lights on (L)" />
                  ) : null}
                </div>
                {modelLights.length === 0 ? (
                  <p className="lv-slot-note">
                    {load.parser === "parser" ? "Lights need the CodeWalker bridge." : "This model carries no lights of its own."}
                  </p>
                ) : (
                  <>
                    <Slider id="ps-light-strength" label="Strength" value={lights.strength} min={0} max={4} step={0.05} format={(value) => `${value.toFixed(2)}×`} onChange={(value) => updateLights({ strength: value })} />
                    <Slider id="ps-light-haze" label="Beam haze" value={lights.haze} min={0} max={2} step={0.05} format={(value) => `${Math.round(value * 100)}%`} onChange={(value) => updateLights({ haze: value })} />
                    <ul className="ps-rows">
                      {modelLights.map((light, index) => {
                        const off = Boolean(lights.off[light.id]);
                        const previewed = previewedLights.has(light.id);
                        return (
                          <li key={light.id} className={`ps-row ${off || !previewed ? "is-hidden" : ""}`}>
                            <span className="ps-light-chip" style={{ "--chip": lightColorHex(light) }} aria-hidden="true" />
                            <span className="ps-row-main">
                              <span className="ps-row-label">
                                {light.type === "spot" ? "Spot" : light.type === "capsule" ? "Capsule" : "Point"} {index + 1}
                              </span>
                              <span className="ps-row-meta" title={previewed ? undefined : `Only the ${PROP_LIGHT_LIMIT} strongest lights are previewed`}>
                                {light.intensity.toFixed(1)} · {formatLength(light.falloff)}
                                {light.type === "spot" ? ` · ${light.coneOuterAngle.toFixed(0)}°` : ""}
                                {!previewed ? ` · past the ${PROP_LIGHT_LIMIT}-light preview` : ""}
                              </span>
                            </span>
                            <Toggle
                              checked={!off}
                              disabled={!previewed}
                              onChange={(value) => {
                                const next = { ...lights.off };
                                if (value) delete next[light.id];
                                else next[light.id] = true;
                                updateLights({ off: next });
                              }}
                              ariaLabel={`Light ${index + 1} on`}
                            />
                          </li>
                        );
                      })}
                    </ul>
                    <p className="lv-slot-note">Range and cone as authored. Falloff is approximated; the game&apos;s light shaders differ.</p>
                  </>
                )}
              </section>
            </>
          ) : null}

          {hasModel && inspectorTab === "attach" ? (
            <PropAttachPanel
              attach={attach}
              attachStatus={attachStatus}
              gizmoMode={attachGizmoMode}
              onGizmoModeChange={setAttachGizmoMode}
              modelPath={settings.modelPath}
              isTauriRuntime={isTauriRuntime}
              onChange={updateAttach}
              onNotify={notify}
            />
          ) : null}

          {inspectorTab === "scene" ? (
            <>
              <section className="lv-group">
                <h3 className="lv-group-title">Studio looks</h3>
                <div className="lv-chips ps-preset-chips" role="group" aria-label="Studio lighting presets">
                  {STUDIO_LOOK_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className={`lv-chip-btn ${activePreset === preset.id ? "is-on" : ""}`}
                      aria-pressed={activePreset === preset.id}
                      title={preset.note}
                      onClick={() => {
                        const patch = getStudioPresetPatch(preset.id, "prop");
                        if (patch) updateScene(patch);
                      }}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </section>
              <StageSection s={stageControls} notes={STAGE_NOTES}>
                <FloorField id="ps-floor-label" value={scene.floor} onChange={(floor) => updateScene({ floor })} />
                <Slider id="ps-stage-rim" label="Rim light" value={scene.rim} min={0} max={2} step={0.05} format={(value) => `${Math.round(value * 100)}%`} onChange={(value) => updateScene({ rim: value })} />
              </StageSection>
              <section className="lv-group">
                <h3 className="lv-group-title">Light</h3>
                <Slider id="ps-dark" label="Dark room" value={scene.dark} min={0} max={1} step={0.01} format={(value) => `${Math.round(value * 100)}%`} onChange={(value) => updateScene({ dark: value })} />
                <p className="lv-slot-note">Dims the studio so emissives and the prop&apos;s own lights carry the shot.</p>
                <Slider id="ps-light" label="Fill light" value={scene.lightLevel} min={0} max={3} step={0.05} format={(value) => `${value.toFixed(2)}×`} onChange={(value) => updateScene({ lightLevel: value })} />
              </section>
              {!showroomOn ? (
                <section className="lv-group">
                  <h3 className="lv-group-title">Backdrop</h3>
                  <div className="lv-colors">
                    <ColorLine
                      label="Background"
                      value={scene.backdrop}
                      onChange={(value) => updateScene({ backdrop: value })}
                      onReset={() => updateScene({ backdrop: readViewerPrefs().background })}
                    />
                  </div>
                </section>
              ) : null}
            </>
          ) : null}
        </div>
      </aside>

      {exportOpen && hasModel ? (
        <PropExportDialog
          options={thumbnail}
          onOptionsChange={(patch) => updateSection("thumbnail", patch)}
          onRender={renderExport}
          onSave={saveExport}
          onExportSheet={handleExportSheet}
          onExportBatch={handleExportBatch}
          onExportVideo={handleExportVideo}
          folderProps={folderProps}
          drawables={prop?.drawables || []}
          onClose={() => setExportOpen(false)}
          onOpenFolder={(path) => openFolderPath(path.endsWith(".png") || path.endsWith(".mp4") || path.endsWith(".webm") ? folderOf(path) : path)}
          backdrop={scene.backdrop}
        />
      ) : null}
    </WorkspaceFrame>
  );
}
