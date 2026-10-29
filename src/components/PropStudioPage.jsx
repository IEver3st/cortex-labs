import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { open, save } from "@tauri-apps/plugin-dialog";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  Aperture,
  Axis3d,
  Box,
  Check,
  CircleHelp,
  Contrast,
  Crosshair,
  Eye,
  EyeOff,
  Grid3x3,
  Hexagon,
  ImageDown,
  Loader2,
  Monitor,
  Moon,
  RefreshCw,
  RotateCcw,
  RotateCw,
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
import { loadNativeMaterialView } from "../lib/native-materials.js";
import { createPropModel, loadPropAsset } from "../lib/prop-model.js";
import { buildCollisionOverlay, readModelCollisions } from "../lib/collision-overlay.js";
import { PROP_LIGHT_LIMIT, createPropLightRig } from "../lib/prop-lights.js";
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
  normalizePropState,
  rotateOrientation,
  thumbnailFileName,
} from "../lib/prop-studio.js";
import PropViewport from "./prop/PropViewport";
import PropExportDialog from "./prop/PropExportDialog";
import {
  AssetSlot,
  ColorLine,
  DeckButton,
  DeckViewMenu,
  deckButtonItems,
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
const MODEL_FILTERS = [{ name: "GTA V models", extensions: ["ydr", "ydd", "yft"] }];
const YTD_FILTERS = [{ name: "Texture dictionaries", extensions: ["ytd"] }];
const WATCHED_EXTENSIONS = /\.(ydr|ydd|yft|ytd|ytyp)$/i;
const VIEW_MODES = [
  { id: "textured", label: "Textured" },
  { id: "clay", label: "Clay" },
  { id: "normals", label: "Normals" },
  { id: "uv", label: "UV check" },
];
const STAGE_NOTES = {
  showroom: "A dark product studio scaled to the prop, with a reflective floor and a spotlight. The prop's own lights pool on the floor.",
  workbench: "Your backdrop colour, with the grid and shadows from the deck.",
};
const FORMAT_NAMES = { ydr: "Drawable", ydd: "Drawable dictionary", yft: "Fragment" };
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

function isEditableTarget(target) {
  return Boolean(target?.closest?.("input, textarea, select, [contenteditable='true']"));
}

function newWatchId() {
  return `prop-${Math.random().toString(36).slice(2, 10)}`;
}

function PropHelp() {
  return (
    <div className="lv-help" role="dialog" aria-label="Viewer controls">
      <dl>
        <div><dt><kbd className="cx-keycap">LMB</kbd></dt><dd>Orbit</dd></div>
        <div><dt><kbd className="cx-keycap">RMB</kbd></dt><dd>Pan</dd></div>
        <div><dt>Scroll</dt><dd>Zoom</dd></div>
        <div><dt><kbd className="cx-keycap">F</kbd></dt><dd>Frame the prop</dd></div>
        <div><dt><kbd className="cx-keycap">Space</kbd></dt><dd>Turntable</dd></div>
        <div><dt><kbd className="cx-keycap">W</kbd></dt><dd>Wireframe</dd></div>
        <div><dt><kbd className="cx-keycap">E</kbd></dt><dd>Emissives on or off</dd></div>
        <div><dt><kbd className="cx-keycap">L</kbd></dt><dd>Prop lights on or off</dd></div>
        <div><dt><kbd className="cx-keycap">N</kbd></dt><dd>Dark room</dd></div>
      </dl>
    </div>
  );
}

function Seg({ label, id, value, options, onChange }) {
  return (
    <div className="lv-field">
      {label ? <span className="cx-label" id={id}>{label}</span> : null}
      <div className="lv-seg" role="radiogroup" aria-labelledby={label ? id : undefined} aria-label={label ? undefined : id}>
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
  const [collisionInfo, setCollisionInfo] = useState(null);
  const [collisionsOnly, setCollisionsOnly] = useState(false);
  const collisionOverlayRef = useRef(null);
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
  const reloadRef = useRef({ force: false, keepCamera: false });
  const framePendingRef = useRef(false);
  const onRenameTabRef = useRef(onRenameTab);
  onRenameTabRef.current = onRenameTab;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const propRef = useRef(prop);
  propRef.current = prop;

  const { scene, view, emissive, lights, thumbnail } = settings;
  const updateSection = useCallback((section, patch) => {
    setSettings((prev) => ({ ...prev, [section]: { ...prev[section], ...patch } }));
  }, []);
  const updateScene = useCallback((patch) => updateSection("scene", patch), [updateSection]);
  const updateView = useCallback((patch) => updateSection("view", patch), [updateSection]);
  const updateEmissive = useCallback((patch) => updateSection("emissive", patch), [updateSection]);
  const updateLights = useCallback((patch) => updateSection("lights", patch), [updateSection]);

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

  /* ── Load the model ── */
  const extraKey = settings.extraYtds.join("\n");
  useEffect(() => {
    const path = settings.modelPath;
    if (!isTauriRuntime || !path) {
      setProp(null);
      setLoad({ status: "idle", error: "", warnings: [], parser: "", cached: false });
      return undefined;
    }
    const controller = new AbortController();
    const { force, keepCamera } = reloadRef.current;
    reloadRef.current = { force: false, keepCamera: false };
    setLoad((prev) => ({ ...prev, status: "loading", error: "" }));
    (async () => {
      try {
        const asset = await loadPropAsset(path, {
          invoke,
          readFile,
          force,
          extraYtds: extraKey ? extraKey.split("\n") : [],
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        framePendingRef.current = !keepCamera;
        setProp(createPropModel(asset));
        setLoad({ status: "ready", error: "", warnings: asset.warnings, parser: asset.parser, cached: asset.cached });
        dismissAlert("load");
        onRenameTabRef.current?.(splitPath(path).name);
      } catch (error) {
        if (error?.name === "AbortError" || controller.signal.aborted) return;
        // A live reload that catches a half-written file keeps the last good model.
        if (!keepCamera) setProp(null);
        setLoad({ status: "error", error: errorMessage(error), warnings: [], parser: "", cached: false });
        raiseAlert("load", keepCamera ? "Reload failed" : "Model didn't load", errorMessage(error));
      }
    })();
    return () => controller.abort();
  }, [settings.modelPath, extraKey, reloadToken, isTauriRuntime, dismissAlert, raiseAlert]);

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
    current.setView(v.mode, v.wireframe);
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

  // Geometry: what's shown and how it's turned. Re-centres, re-fits the stage
  // and frames a newly loaded model.
  useEffect(() => {
    if (!prop) return;
    prop.setVisibility({ lod: view.lod, drawable: view.drawable, hiddenMaterials: view.hiddenMaterials });
    prop.setOrientation(view.orientation);
    prop.recenter();
    const rest = prop.restBounds();
    floorYRef.current = rest?.min.y ?? 0;
    if (boundsHelperRef.current && rest) boundsHelperRef.current.box.copy(rest);
    const size = rest ? rest.getSize(new THREE.Vector3()).length() : 0.5;
    prop.setHelpers({ origin: view.origin, size: Math.max(0.02, size * 0.35) });
    setInfo({ stats: prop.stats(), dims: prop.dimensions() });
    if (framePendingRef.current) {
      framePendingRef.current = false;
      viewportRef.current?.frame(settingsRef.current.cameraPreset);
    } else {
      viewportRef.current?.refit();
    }
    syncLights();
    setGlowing(prop.setEmissive(settingsRef.current.emissive));
    viewportRef.current?.requestRender();
  }, [prop, view.lod, view.drawable, view.hiddenMaterials, view.orientation, view.origin, syncLights]);

  useEffect(() => {
    if (boundsHelperRef.current) boundsHelperRef.current.visible = Boolean(view.bounds);
    viewportRef.current?.requestRender();
  }, [prop, view.bounds]);

  useEffect(() => {
    const path = settings.modelPath;
    if (!view.collisions || !prop || !path) {
      setCollisionInfo(null);
      return undefined;
    }
    if (!isTauriRuntime || !/\.(yft|ydr|ydd)$/i.test(path)) {
      setCollisionInfo({ status: "unavailable" });
      return undefined;
    }
    let overlay = null;
    let cancelled = false;
    setCollisionInfo({ status: "loading" });
    readModelCollisions(invoke, path, prop.root.uuid)
      .then((data) => {
        if (cancelled) return;
        if (!data.meshes.length && !data.primitives.length) {
          setCollisionInfo({ status: "none" });
          return;
        }
        overlay = buildCollisionOverlay(data);
        overlay.group.userData.propHelper = true;
        overlay.setSolid(collisionsOnlyRef.current);
        prop.gta.add(overlay.group);
        collisionOverlayRef.current = overlay;
        setCollisionInfo({ status: "ready", data });
        viewportRef.current?.requestRender();
      })
      .catch((error) => {
        if (!cancelled) setCollisionInfo({ status: "error", error: errorMessage(error) });
      });
    return () => {
      cancelled = true;
      if (collisionOverlayRef.current === overlay) collisionOverlayRef.current = null;
      overlay?.dispose();
      viewportRef.current?.requestRender();
    };
  }, [view.collisions, prop, settings.modelPath, isTauriRuntime]);

  const collisionsOnlyRef = useRef(collisionsOnly);
  useEffect(() => {
    collisionsOnlyRef.current = collisionsOnly;
    collisionOverlayRef.current?.setSolid(collisionsOnly);
    viewportRef.current?.requestRender();
  }, [collisionsOnly]);

  useEffect(() => {
    refreshLook();
  }, [prop, view.mode, view.wireframe, emissive, refreshLook]);

  useEffect(() => {
    const rig = rigRef.current;
    if (!rig) return;
    rig.setState({ enabled: lights.enabled, strength: lights.strength, haze: lights.haze, off: lights.off, glow: emissive.glow });
    syncLights();
    viewportRef.current?.requestRender();
  }, [prop, lights, emissive.glow, syncLights]);

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
  const openModel = useCallback((path) => {
    if (!isPropModelPath(path)) {
      raiseAlert("load", "Not a prop model", "Prop Studio opens .ydr, .ydd and .yft files.");
      return;
    }
    reloadRef.current = { force: false, keepCamera: false };
    setSettings((prev) => ({
      ...prev,
      modelPath: path,
      // A new model starts with every LOD, drawable and material choice reset.
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

  const handleUnload = useCallback(() => {
    setSettings((prev) => ({ ...prev, modelPath: "", extraYtds: [] }));
    onRenameTabRef.current?.("Prop Studio");
  }, []);

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

  const handleReload = useCallback(() => {
    reloadRef.current = { force: true, keepCamera: true };
    setReloadToken((token) => token + 1);
  }, []);

  /* ── Drag and drop (native paths; only while this tab is showing) ── */
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  useEffect(() => {
    if (!isTauriRuntime) return undefined;
    let unlisten = null;
    let disposed = false;
    const relevant = (paths) => (paths || []).some((path) => isPropModelPath(path) || /\.ytd$/i.test(path));
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (!isActiveRef.current) return;
        const { type, paths } = event.payload || {};
        if (type === "enter") setDragging(relevant(paths));
        else if (type === "leave") setDragging(false);
        else if (type === "drop") {
          setDragging(false);
          const model = (paths || []).find(isPropModelPath);
          if (model) openModel(model);
          addYtds(paths || []);
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
  }, [addYtds, isTauriRuntime, openModel]);

  /* ── Live reload: the model's folder (sibling and archetype .ytd) and added dictionaries ── */
  const watchKey = settings.modelPath ? [folderOf(settings.modelPath), ...settings.extraYtds].filter(Boolean).join("\n") : "";
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
          if (!(event.payload.paths || []).some((path) => WATCHED_EXTENSIONS.test(path))) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            timer = null;
            reloadRef.current = { force: true, keepCamera: true };
            setReloadToken((token) => token + 1);
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
  }, [isTauriRuntime, notify, settings.liveReload, watchKey]);

  /* ── Capture ── */
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
    return target;
  }, [renderExport]);

  const openModelFolder = useCallback(async () => {
    const folder = folderOf(settingsRef.current.modelPath);
    if (await openFolderPath(folder)) return;
    raiseAlert("open-folder", "Folder not opened", `Windows couldn't open ${folder}.`);
  }, [raiseAlert]);

  /* ── Keyboard ── */
  useEffect(() => {
    if (!isActive || exportOpen) return undefined;
    const onKeyDown = (event) => {
      if (event.ctrlKey || event.altKey || event.metaKey || isEditableTarget(event.target)) return;
      const key = event.key.toLowerCase();
      const current = settingsRef.current;
      if (key === "f") viewportRef.current?.frame(current.cameraPreset);
      else if (key === " ") updateView({ turntable: !current.view.turntable });
      else if (key === "w") updateView({ wireframe: !current.view.wireframe });
      else if (key === "e") updateEmissive({ enabled: !current.emissive.enabled });
      else if (key === "l") updateLights({ enabled: !current.lights.enabled });
      else if (key === "n") updateScene({ dark: current.scene.dark > 0 ? 0 : 1 });
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [exportOpen, isActive, updateEmissive, updateLights, updateScene, updateView]);

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
  const materialGroups = useMemo(() => prop?.materialGroups() || [], [prop]);
  const emissiveGroups = materialGroups.filter((group) => group.emissive);
  const lods = useMemo(() => prop?.availableLods() || [], [prop]);
  const modelLights = prop?.lights || [];
  const hasModel = Boolean(prop);
  const loading = load.status === "loading";
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
  const exportBlocked = !isTauriRuntime ? "Exporting needs the desktop app." : !hasModel ? "Open a prop to export images." : "";
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
      ? { tone: "live", text: "Reloads when the model or its textures change" }
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
            emptyHint=".ydr, .ydd or .yft. Drop one here too."
            hotkey={hotkeys[HOTKEY_ACTIONS.SELECT_MODEL]}
            onPick={handlePickModel}
            onUnload={handleUnload}
            done={hasModel && load.status !== "error"}
            disabled={!isTauriRuntime}
            disabledNote="Opening game models needs the desktop app."
            trailing={hasModel ? (
              <button type="button" className="cx-icon-btn" onClick={handleReload} title="Reload from disk" aria-label="Reload from disk" disabled={loading}>
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
                <p className="lv-slot-note">Open a prop to find its textures.</p>
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
        </div>
        <div className="lv-dock-foot">
          <button
            type="button"
            className="cx-btn is-primary"
            disabled={Boolean(exportBlocked)}
            onClick={() => setExportOpen(true)}
            title="A transparent PNG for inventories and stores"
          >
            <ImageDown aria-hidden="true" />
            Export image
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
            />
          ) : (
            <StageEmpty icon={Monitor} title="Desktop app required" line="Reading game models, textures and lights needs the Cortex Studio desktop app." />
          )}
          {isTauriRuntime && !hasModel && !loading ? (
            <StageEmpty
              tone={load.status === "error" ? "error" : undefined}
              title={load.status === "error" ? "The model didn't load" : "No prop open"}
              line={load.status === "error" ? load.error : "Open a .ydr, .ydd or .yft, or drop one on the viewfinder."}
            >
              <button type="button" className="cx-btn is-primary" onClick={handlePickModel}>Open a prop</button>
            </StageEmpty>
          ) : null}
        </div>

        <div className="lv-hud">
          {hasModel ? (
            <StageToggle showroom={showroomOn} onChange={(on) => updateScene({ stage: on ? "showroom" : "workbench" })} title="A dark product studio with a reflective floor and a spotlight you can aim" />
          ) : null}

          <div className="lv-slip-stack">
            {loading || (hasModel && view.bounds && dims) ? (
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
                    <span>{alert.text}</span>
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
              <span>A .ydr, .ydd or .yft opens; a .ytd adds its textures.</span>
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
              <div className="lv-deck-group">
                <DeckButton active={helpOpen} onClick={() => setHelpOpen((value) => !value)} title="Mouse and keyboard controls" className="is-icon">
                  <CircleHelp aria-hidden="true" />
                </DeckButton>
              </div>
              {helpOpen ? <PropHelp /> : null}
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
            { id: "light", label: "Light" },
            { id: "scene", label: "Scene" },
            { id: "info", label: "Info" },
          ]}
          active={inspectorTab}
          onChange={setInspectorTab}
        />
        <div className="lv-inspector-scroll custom-scrollbar">
          {!hasModel && inspectorTab !== "scene" ? (
            <p className="ps-inspector-empty">Open a prop to inspect its LODs, materials and lights.</p>
          ) : null}

          {hasModel && inspectorTab === "model" ? (
            <>
              <section className="lv-group">
                <h3 className="lv-group-title">View</h3>
                <Seg id="ps-view-mode" label="Shading" value={view.mode} options={VIEW_MODES} onChange={(mode) => updateView({ mode })} />
                {lods.length > 0 ? (
                  <Seg
                    id="ps-lod"
                    label="Level of detail"
                    value={view.lod}
                    options={PROP_LODS.map((lod) => ({
                      id: lod,
                      label: PROP_LOD_LABELS[lod],
                      disabled: !lods.includes(lod),
                      title: lods.includes(lod) ? undefined : "This model has no such LOD",
                    }))}
                    onChange={(lod) => updateView({ lod })}
                  />
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
                <ul className="ps-rows">
                  {materialGroups.map((group) => {
                    const hidden = Boolean(view.hiddenMaterials[group.key]);
                    return (
                      <li key={group.key} className={`ps-row ${hidden ? "is-hidden" : ""}`}>
                        <span className="ps-row-main">
                          <span className="ps-row-label" title={group.label}>{group.label}</span>
                          <span className="ps-row-meta" title={group.textures.join(", ")}>
                            {group.shaderName || "material"} · {group.meshCount} {group.meshCount === 1 ? "mesh" : "meshes"}
                          </span>
                        </span>
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
                      </li>
                    );
                  })}
                </ul>
              </section>

              <section className="lv-group">
                <h3 className="lv-group-title">Presentation</h3>
                <ToggleRow label="Turntable" checked={view.turntable} onChange={(value) => updateView({ turntable: value })} />
                <Slider id="ps-turntable-speed" label="Turntable speed" value={view.turntableSpeed} min={2} max={90} step={1} format={(value) => `${value}°/s`} onChange={(value) => updateView({ turntableSpeed: value })} />
                <ToggleRow label="Origin and axes" note="GTA X red, Y green, Z blue" checked={view.origin} onChange={(value) => updateView({ origin: value })} />
                <ToggleRow label="Bounding box" note="Dimensions show in the viewfinder" checked={view.bounds} onChange={(value) => updateView({ bounds: value })} />
              </section>
            </>
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

          {inspectorTab === "scene" ? (
            <>
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

          {hasModel && inspectorTab === "info" ? (
            <section className="lv-group">
              <h3 className="lv-group-title">Model</h3>
              <dl className="ps-facts">
                <div><dt>Format</dt><dd>.{prop.format} · {FORMAT_NAMES[prop.format]}</dd></div>
                <div><dt>Read by</dt><dd>{load.parser === "bridge" ? `CodeWalker bridge${load.cached ? " (cached)" : ""}` : "Built-in parser"}</dd></div>
                {dims ? (
                  <div><dt>Size</dt><dd>{formatLength(dims.x)} × {formatLength(dims.y)} × {formatLength(dims.z)}</dd></div>
                ) : null}
                {info.stats ? (
                  <>
                    <div><dt>Meshes shown</dt><dd>{formatCount(info.stats.meshes)} of {formatCount(info.stats.totalMeshes)}</dd></div>
                    <div><dt>Vertices</dt><dd>{formatCount(info.stats.vertices)}</dd></div>
                    <div><dt>Triangles</dt><dd>{formatCount(info.stats.triangles)}</dd></div>
                  </>
                ) : null}
                <div><dt>Drawables</dt><dd>{formatCount(Math.max(prop.drawables.length, 1))}</dd></div>
                <div><dt>LODs</dt><dd>{lods.length ? lods.map((lod) => PROP_LOD_LABELS[lod]).join(", ") : "–"}</dd></div>
                <div><dt>Materials</dt><dd>{formatCount(materialGroups.length)}</dd></div>
                <div><dt>Lights</dt><dd>{formatCount(modelLights.length)}</dd></div>
                {nativeStatus.state === "ready" ? (
                  <div><dt>Textures</dt><dd>{nativeStatus.loaded} loaded{nativeStatus.missing ? `, ${nativeStatus.missing} not found` : ""}{nativeStatus.failed ? `, ${nativeStatus.failed} failed` : ""}</dd></div>
                ) : null}
              </dl>
              {nativeStatus.failures?.length ? (
                <ul className="ps-failures">
                  {nativeStatus.failures.slice(0, 6).map((failure) => (
                    <li key={failure.path} title={failure.message}>
                      <code>{splitPath(failure.path).name}</code> {failure.message}
                    </li>
                  ))}
                </ul>
              ) : null}
              <button type="button" className="lv-link ps-open-folder" onClick={openModelFolder}>
                Open the model&apos;s folder
              </button>
            </section>
          ) : null}
        </div>
      </aside>

      {exportOpen && hasModel ? (
        <PropExportDialog
          options={thumbnail}
          onOptionsChange={(patch) => updateSection("thumbnail", patch)}
          onRender={renderExport}
          onSave={saveExport}
          onClose={() => setExportOpen(false)}
          onOpenFolder={(path) => openFolderPath(folderOf(path))}
          backdrop={scene.backdrop}
        />
      ) : null}
    </WorkspaceFrame>
  );
}
