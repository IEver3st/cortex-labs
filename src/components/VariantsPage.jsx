import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { exists, writeFile } from "@tauri-apps/plugin-fs";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Crosshair,
  Download,
  Eye,
  EyeOff,
  FileImage,
  FolderInput,
  FolderOpen,
  Frame,
  Grid3x3,
  Lock,
  Maximize2,
  Pencil,
  Plus,
  Redo2,
  RefreshCw,
  Search,
  SquareDashed,
  Sun,
  Trash2,
  Box,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { parsePsdLayers, compositePsdVariant } from "../lib/psd-layers";
import { loadPrefs } from "../lib/prefs";
import { HOTKEY_ACTIONS, hotkeyMatches } from "../lib/hotkeys";
import { useStoredHotkeys } from "../lib/use-workspace-hotkeys";
import { hotkeyLabel } from "./ui/keycaps";
import { normalizeVariantList } from "../lib/workspace-state";
import { openFolderPath } from "../lib/open-folder";
import { trackUsage } from "../lib/usage";
import { countExistingFiles } from "../lib/capture-output";
import { editHistoryKey } from "../lib/edit-history";
import { captureViewerFrameBytes } from "../lib/preview-capture";
import { normalizeVariantExportShape, variantExportDimensions } from "../lib/variant-export";
import { setLayers, soloLayer, toggleLayer } from "../lib/variant-layers";
import useEditHistory from "./useEditHistory";
import { Toggle } from "./ui/toggle";
import * as Ctx from "./ContextMenu";
import Viewer from "./Viewer";
import { AssetSlot, DeckButton, FootFact, PanelLayout, StageEmpty, splitPath } from "./workspace/parts";
import { PaneResizer, usePaneWidths } from "./workspace/PaneResizer";
import ReplacePrompt from "./workspace/ReplacePrompt";
import { usePaneMotion } from "./workspace/usePaneMotion";
import "./VariantsPage.css";

/* ═══════════════════════════════════════════════════════════
   Constants
   ═══════════════════════════════════════════════════════════ */
const SIZE_OPTIONS = [4096, 2048, 1024, 512];

const EXPORT_SHAPES = [
  { id: "source", label: "Keep aspect", title: "The long side takes the chosen size; the file's proportions stay" },
  { id: "square", label: "Square", title: "Stretch to a square at the chosen size" },
];

// Keys must match lib/camera-framing CAMERA_PRESETS; unknown keys fall back to 3/4.
const CAMERA_SHOTS = [
  { key: "front", label: "Front" },
  { key: "back", label: "Rear" },
  { key: "side", label: "Side" },
  { key: "angle", label: "3/4" },
  { key: "top", label: "Top" },
];

const LIGHTING_PRESETS = [
  { key: "studio", label: "Studio", intensity: 1.0 },
  { key: "sunlight", label: "Harsh sun", intensity: 1.6 },
  { key: "overcast", label: "Overcast", intensity: 0.7 },
  { key: "night", label: "Night", intensity: 0.3 },
];

const LAYER_FILTERS = [
  { id: "all", label: "All" },
  { id: "visible", label: "Visible" },
  { id: "modified", label: "Changed" },
];

const NOOP = () => {};

/* ═══════════════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════════════ */
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function buildDefaultVisibility(data) {
  const vis = {};
  for (const layer of data?.allLayers || []) vis[layer.id] = layer.visible;
  return vis;
}

function buildVisibilityFromLegacy(variant, data, fallback) {
  if (!variant || !data) return fallback || {};
  const vis = { ...(fallback || {}) };
  for (const layer of data.allLayers || []) {
    if (Object.prototype.hasOwnProperty.call(variant.toggleable || {}, layer.name)) {
      vis[layer.id] = variant.toggleable[layer.name];
    }
  }
  for (const group of data.variantGroups || []) {
    const selectedIdx = (variant.variantSelections || {})[group.name] ?? 0;
    for (let j = 0; j < group.options.length; j++) {
      const enabled = j === selectedIdx;
      for (const layer of data.allLayers || []) {
        if (layer.name === group.options[j].name) vis[layer.id] = enabled;
      }
    }
  }
  return vis;
}

function exportFileName(name) {
  return `${String(name || "variant").replace(/[^a-zA-Z0-9_\- ]/g, "_")}.png`;
}

/** A variant's vehicle render, saved beside its texture. */
function renderFileName(name) {
  return exportFileName(name).replace(/\.png$/, "_render.png");
}

function sameVisibility(a, b) {
  const aKeys = Object.keys(a || {});
  if (aKeys.length !== Object.keys(b || {}).length) return false;
  return aKeys.every((key) => Boolean(a[key]) === Boolean(b?.[key]));
}

function getDefaultVariantExportFolder() {
  const prefs = loadPrefs();
  return prefs?.defaults?.variantExportFolder || "";
}

function toErrorMessage(error, fallback) {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object" && typeof error.message === "string" && error.message.trim()) {
    return error.message.trim();
  }
  return fallback;
}

/* ═══════════════════════════════════════════════════════════
   Sub-components
   ═══════════════════════════════════════════════════════════ */

/* Drag handles are memo-wrapped so a resize never re-renders their parent's tree. */
const HResizer = memo(function HResizer({ onResize }) {
  const dragging = useRef(false);
  const startX = useRef(0);
  const onPointerDown = useCallback((e) => {
    dragging.current = true; startX.current = e.clientX;
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none";
  }, []);
  const onPointerMove = useCallback((e) => {
    if (!dragging.current) return;
    const dx = e.clientX - startX.current; startX.current = e.clientX; onResize(dx);
  }, [onResize]);
  const onPointerUp = useCallback(() => {
    dragging.current = false; document.body.style.cursor = ""; document.body.style.userSelect = "";
  }, []);
  useEffect(() => () => {
    if (dragging.current) {
      dragging.current = false;
      document.body.style.cursor = ""; document.body.style.userSelect = "";
    }
  }, []);
  return (
    <div
      className="vb-resizer vb-resizer--h"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize preview panes"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
});

const VResizer = memo(function VResizer({ onResize }) {
  const dragging = useRef(false);
  const startY = useRef(0);
  const onPointerDown = useCallback((e) => {
    dragging.current = true; startY.current = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.cursor = "row-resize"; document.body.style.userSelect = "none";
  }, []);
  const onPointerMove = useCallback((e) => {
    if (!dragging.current) return;
    const dy = startY.current - e.clientY; startY.current = e.clientY; onResize(dy);
  }, [onResize]);
  const onPointerUp = useCallback(() => {
    dragging.current = false; document.body.style.cursor = ""; document.body.style.userSelect = "";
  }, []);
  useEffect(() => () => {
    if (dragging.current) {
      dragging.current = false;
      document.body.style.cursor = ""; document.body.style.userSelect = "";
    }
  }, []);
  return (
    <div
      className="vb-resizer vb-resizer--v"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize layers panel"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
});

/* A pipeline step without a file: same disc, line and title as AssetSlot. */
function Step({ id, step, title, done, trailing, children }) {
  return (
    <section id={id} className="lv-slot">
      <header className="lv-slot-head">
        <span className={`lv-step ${done ? "is-done" : ""}`} aria-hidden="true">
          {done ? <Check /> : step}
        </span>
        <h3 className="lv-slot-title">{title}</h3>
        {trailing}
      </header>
      <div className="lv-slot-body">{children}</div>
    </section>
  );
}

function LayerRow({ layer, isOn, child, locked, onToggle, onSolo }) {
  return (
    <button
      type="button"
      className={`vb-layer ${isOn ? "is-on" : ""} ${child ? "is-child" : ""}`}
      onClick={() => onToggle(layer.id)}
      onDoubleClick={onSolo ? () => onSolo(layer.id) : undefined}
      aria-pressed={isOn}
      title={onSolo ? `${layer.name}. Double-click to show only this layer in its group.` : layer.name}
    >
      {isOn ? <Eye className="vb-layer-eye" aria-hidden="true" /> : <EyeOff className="vb-layer-eye" aria-hidden="true" />}
      <span className="vb-layer-name">{layer.name}</span>
      {locked ? <Lock className="vb-layer-lock" aria-hidden="true" /> : null}
    </button>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   VariantsPage: named layer-visibility sets of one layered file, previewed
   flat and on a vehicle, exported as one PNG per variant.
   Layout: [Pipeline dock | Stage (3D / texture) | Layers inspector]
   ═══════════════════════════════════════════════════════════════════════ */
export default function VariantsPage({ workspaceState, onStateChange, onRenameTab, settingsVersion, isActive, contextBarTarget }) {
  /* ── Source and variants ── */
  const [psdPath, setPsdPath] = useState(workspaceState?.psdPath || "");
  const [psdData, setPsdData] = useState(null);
  const [psdLoading, setPsdLoading] = useState(false);
  const [psdError, setPsdError] = useState("");
  const [psdReloadToken, setPsdReloadToken] = useState(0);
  // Saved lists from older or damaged workspaces are reshaped before use.
  const [variants, setVariants] = useState(() => normalizeVariantList(workspaceState?.variants, generateId));
  const [selectedVariantId, setSelectedVariantId] = useState(() => (
    variants.some((variant) => variant.id === workspaceState?.selectedVariantId) ? workspaceState.selectedVariantId : variants[0]?.id || ""
  ));
  const [editingName, setEditingName] = useState(null);
  const editNameRef = useRef(null);
  const [layerVisibility, setLayerVisibility] = useState({});
  const layerVisibilityRef = useRef(layerVisibility);
  layerVisibilityRef.current = layerVisibility;
  const [collapsedGroups, setCollapsedGroups] = useState(new Set());
  const [layerSearch, setLayerSearch] = useState("");
  const [layerFilter, setLayerFilter] = useState("all");

  /* ── Export ── */
  const [exportSize, setExportSize] = useState(workspaceState?.exportSize || 4096);
  // "source" keeps the file's aspect (long side = exportSize); "square" stretches to exportSize².
  const [exportShape, setExportShape] = useState(() => normalizeVariantExportShape(workspaceState?.exportShape));
  // Also save each variant on the loaded vehicle, from the vehicle pane's current view.
  const [exportRenders, setExportRenders] = useState(Boolean(workspaceState?.exportRenders));
  const [outputFolder, setOutputFolder] = useState(workspaceState?.outputFolder || getDefaultVariantExportFolder());
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportResult, setExportResult] = useState(null);
  // An export waiting on "Replace N files?": { conflicts, total, folder, mode }.
  const [exportReplace, setExportReplace] = useState(null);

  /* ── 3D preview ── */
  const [modelPath, setModelPath] = useState(workspaceState?.modelPath || "");
  const [viewerReady, setViewerReady] = useState(false);
  const [liveryTarget, setLiveryTarget] = useState("");
  const [liveryTargetReady, setLiveryTargetReady] = useState(false);
  const [modelError, setModelError] = useState("");
  const [modelLoading, setModelLoading] = useState(false);
  const viewerApiRef = useRef(null);
  const [lightingPreset, setLightingPreset] = useState("studio");
  const [showWireframe, setShowWireframe] = useState(false);
  const [lightMenuOpen, setLightMenuOpen] = useState(false);
  const lightMenuRef = useRef(null);

  // The composited preview stays a canvas: it is drawn into the texture pane and
  // handed to the Viewer as a CanvasTexture, never encoded to PNG.
  const previewCanvasRef = useRef(null);
  const scratchCanvasesRef = useRef(new Map());
  const [previewToken, setPreviewToken] = useState(0);

  /* ── Texture pane ── */
  const [uvZoom, setUvZoom] = useState(1);
  const [uvPan, setUvPan] = useState({ x: 0, y: 0 });
  const [uvPanning, setUvPanning] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [showChecker, setShowChecker] = useState(true);
  const [showSafeArea, setShowSafeArea] = useState(false);
  const [uvHover, setUvHover] = useState(null);
  const uvContainerRef = useRef(null);
  const uvImgRef = useRef(null);

  /* ── Layout ── */
  const [stageMode, setStageMode] = useState("split"); // "model" | "split" | "texture"
  const [viewerPanelWidth, setViewerPanelWidth] = useState(55);
  const [dockOpen, setDockOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const panes = usePaneWidths("cortex.variants.panes");
  const rootRef = useRef(null);
  const [legacyLayersLayout, setLegacyLayersLayout] = useState(() => loadPrefs()?.defaults?.legacyLayersLayout ?? false);
  const [legacyLayersHeight, setLegacyLayersHeight] = useState(240);
  const pendingVResizeDyRef = useRef(0);
  const legacyLayersRafRef = useRef(0);
  const stageRef = useRef(null);
  const persistTimerRef = useRef(null);
  const pendingHResizeDxRef = useRef(0);
  const hResizeRafRef = useRef(0);

  const isTauriRuntime = typeof window !== "undefined" && typeof window.__TAURI_INTERNALS__ !== "undefined";
  const selectedVariant = variants.find((v) => v.id === selectedVariantId) || variants[0];
  const selectedVariantIdRef = useRef(selectedVariantId);
  useEffect(() => { selectedVariantIdRef.current = selectedVariantId; }, [selectedVariantId]);
  const variantsRef = useRef(variants);
  variantsRef.current = variants;

  /* ── Undo: variant and layer edits, as snapshots of the variant list ── */
  const {
    record: recordVariantSnapshot,
    undo: undoVariantEdit,
    redo: redoVariantEdit,
    clear: clearVariantHistory,
    canUndo: canUndoVariants,
    canRedo: canRedoVariants,
  } = useEditHistory();
  // The last deleted variant, offered back with an inline Undo until the next edit.
  const [deletedVariant, setDeletedVariant] = useState(null);
  // Refs and stable setters only, so every callback below stays stable. A
  // layer's double-click solo (two clicks, then the solo) shares the layer's
  // key, so it undoes in one step.
  const recordVariantEdit = useCallback((key = null) => {
    recordVariantSnapshot({ variants: variantsRef.current, selectedVariantId: selectedVariantIdRef.current }, key);
    setDeletedVariant(null);
  }, [recordVariantSnapshot]);
  const applyVariantSnapshot = useCallback((snapshot) => {
    if (!snapshot) return;
    const selected = snapshot.variants.find((v) => v.id === snapshot.selectedVariantId) || snapshot.variants[0];
    setVariants(snapshot.variants);
    setSelectedVariantId(selected?.id || "");
    if (selected?.layerVisibility && Object.keys(selected.layerVisibility).length > 0) setLayerVisibility(selected.layerVisibility);
    setEditingName(null);
    setDeletedVariant(null);
  }, []);
  const handleUndoVariants = useCallback(() => {
    applyVariantSnapshot(undoVariantEdit({ variants: variantsRef.current, selectedVariantId: selectedVariantIdRef.current }));
  }, [applyVariantSnapshot, undoVariantEdit]);
  const handleRedoVariants = useCallback(() => {
    applyVariantSnapshot(redoVariantEdit({ variants: variantsRef.current, selectedVariantId: selectedVariantIdRef.current }));
  }, [applyVariantSnapshot, redoVariantEdit]);
  // Layer ids belong to one read of one file, so a new or reloaded file starts a fresh history.
  useEffect(() => {
    clearVariantHistory();
    setDeletedVariant(null);
  }, [psdPath, psdData, clearVariantHistory]);

  /* ── Export readiness ── */
  const exportIssues = useMemo(() => {
    const issues = [];
    if (!psdPath) issues.push({ type: "error", msg: "Open a layered file first." });
    if (!outputFolder) issues.push({ type: "error", msg: isTauriRuntime ? "Choose an output folder." : "Exporting needs the desktop app." });
    const rendersWanted = exportRenders && Boolean(modelPath);
    const seen = new Map();
    for (const variant of variants) {
      const files = rendersWanted ? [exportFileName(variant.name), renderFileName(variant.name)] : [exportFileName(variant.name)];
      const clash = files.find((file) => seen.has(file.toLowerCase()));
      if (clash) {
        issues.push({ type: "error", msg: `“${seen.get(clash.toLowerCase())}” and “${variant.name}” would both save as ${clash}. Rename one.` });
        break;
      }
      for (const file of files) seen.set(file.toLowerCase(), variant.name);
    }
    if (psdData && psdData.width !== psdData.height && exportShape === "square") {
      issues.push({ type: "warn", msg: `The source is ${psdData.width} × ${psdData.height}. Square exports stretch it to ${exportSize} × ${exportSize}.` });
    }
    if (rendersWanted) {
      if (modelError) issues.push({ type: "error", msg: "The vehicle didn't load, so renders can't be saved. Turn renders off or load another vehicle." });
      else if (psdPath && stageMode === "texture") issues.push({ type: "error", msg: "Show the vehicle (Vehicle or Split) to save renders." });
      else if (!viewerReady || modelLoading || !liveryTargetReady) issues.push({ type: "error", msg: "Renders wait for the vehicle to finish loading." });
    }
    return issues;
  }, [psdPath, outputFolder, variants, psdData, isTauriRuntime, exportShape, exportSize, exportRenders, modelPath, modelError, stageMode, viewerReady, modelLoading, liveryTargetReady]);
  const exportBlocked = exportIssues.some((issue) => issue.type === "error");

  /* ── Persist ── */
  // onStateChange lives in a ref and is deliberately NOT an effect dep: the
  // parent re-renders after every persisted change, and listing the callback
  // here would re-arm the persist timer on each render and loop indefinitely.
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  useEffect(() => {
    if (!onStateChangeRef.current) return;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      onStateChangeRef.current?.({ psdPath, modelPath, variants, selectedVariantId, exportSize, exportShape, exportRenders, outputFolder });
    }, 140);
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, [psdPath, modelPath, variants, selectedVariantId, exportSize, exportShape, exportRenders, outputFolder]);

  useEffect(() => {
    if (!settingsVersion) return;
    setOutputFolder((prev) => prev || getDefaultVariantExportFolder());
    setLegacyLayersLayout(loadPrefs()?.defaults?.legacyLayersLayout ?? false);
  }, [settingsVersion]);

  useEffect(() => () => {
    if (hResizeRafRef.current) cancelAnimationFrame(hResizeRafRef.current);
    if (legacyLayersRafRef.current) cancelAnimationFrame(legacyLayersRafRef.current);
  }, []);

  /* ── Load layer source ── */
  useEffect(() => {
    if (!psdPath) { setPsdData(null); setLayerVisibility({}); setPsdError(""); return; }
    let cancelled = false;
    setPsdLoading(true); setPsdError("");
    parsePsdLayers(psdPath).then((data) => {
      if (cancelled) return;
      setPsdData(data);
      const dv = buildDefaultVisibility(data);
      const iv = selectedVariant?.layerVisibility && Object.keys(selectedVariant.layerVisibility).length > 0
        ? selectedVariant.layerVisibility : buildVisibilityFromLegacy(selectedVariant, data, dv);
      setLayerVisibility(iv);
      setVariants((prev) => {
        const base = prev.find((v) => v.isBase);
        const bv = (base?.layerVisibility && Object.keys(base.layerVisibility).length > 0) ? base.layerVisibility : dv;
        const tog = {}; for (const t of data.toggleable) tog[t.name] = t.enabled;
        const vs = {}; for (const g of data.variantGroups) vs[g.name] = g.selectedIndex;
        return prev.map((v) => {
          const has = v.layerVisibility && Object.keys(v.layerVisibility).length > 0;
          const lv = has ? v.layerVisibility : v.isBase ? dv : { ...bv };
          return v.isBase ? { ...v, toggleable: tog, variantSelections: vs, layerVisibility: lv } : { ...v, layerVisibility: lv };
        });
      });
    }).catch((err) => { if (!cancelled) setPsdError(toErrorMessage(err, "The layered file could not be read.")); })
      .finally(() => { if (!cancelled) setPsdLoading(false); });
    return () => { cancelled = true; };
  }, [psdPath, psdReloadToken]);

  const compositorVisibility = useMemo(() => ({ ...layerVisibility }), [layerVisibility]);
  const visibilityKey = useMemo(() => JSON.stringify(compositorVisibility), [compositorVisibility]);

  /* ── Preview composite ── */
  const compositedRef = useRef(null);
  useEffect(() => {
    if (!isActive || !psdPath || !psdData) return;
    const composited = compositedRef.current;
    if (previewCanvasRef.current && composited?.psdPath === psdPath && composited.psdData === psdData
      && composited.visibilityKey === visibilityKey && composited.exportSize === exportSize) return;
    let cancelled = false;
    const gen = async () => {
      compositedRef.current = null;
      try {
        const maxDim = Math.max(psdData.width || 0, psdData.height || 0) || exportSize;
        const s = Math.min(1, Math.min(exportSize, maxDim) / maxDim);
        const pw = Math.max(1, Math.round((psdData.width || maxDim) * s));
        const ph = Math.max(1, Math.round((psdData.height || maxDim) * s));
        const canvas = await compositePsdVariant(psdPath, compositorVisibility, pw, ph, { reuseCanvas: true, scratchCanvases: scratchCanvasesRef.current });
        if (!cancelled) {
          previewCanvasRef.current = canvas;
          compositedRef.current = { psdPath, psdData, visibilityKey, exportSize };
          setPreviewToken((t) => t + 1);
        }
      } catch (err) {
        if (!cancelled) setPsdError(toErrorMessage(err, "The preview could not be composited."));
      }
    };
    const timer = setTimeout(gen, 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [isActive, psdPath, psdData, visibilityKey, exportSize, compositorVisibility]);

  useEffect(() => {
    if (!psdPath) { previewCanvasRef.current = null; setPreviewToken((t) => t + 1); }
  }, [psdPath]);

  useEffect(() => () => {
    for (const canvas of scratchCanvasesRef.current.values()) { canvas.width = 0; canvas.height = 0; }
    scratchCanvasesRef.current.clear();
    previewCanvasRef.current = null;
  }, []);

  useEffect(() => {
    if (!psdData || !selectedVariantId) return;
    const sel = variants.find((v) => v.id === selectedVariantId);
    const dv = buildDefaultVisibility(psdData);
    setLayerVisibility(sel?.layerVisibility && Object.keys(sel.layerVisibility).length > 0 ? sel.layerVisibility : buildVisibilityFromLegacy(sel, psdData, dv));
  }, [selectedVariantId, psdData]);

  useEffect(() => {
    const id = selectedVariantIdRef.current; if (!id) return;
    setVariants((prev) => prev.map((v) => v.id === id ? { ...v, layerVisibility: { ...layerVisibility } } : v));
  }, [layerVisibility]);

  /* ── File selectors ── */
  const handleSelectPsd = useCallback(async () => {
    if (!isTauriRuntime) return;
    try {
      const s = await open({ filters: [{ name: "Layered file", extensions: ["psd", "pdn", "ai"] }] });
      if (typeof s === "string") { setPsdPath(s); const n = s.split(/[\\/]/).pop(); if (n && onRenameTab) onRenameTab(n); }
    } catch {}
  }, [isTauriRuntime, onRenameTab]);

  const handleSelectModel = useCallback(async () => {
    if (!isTauriRuntime) return;
    try { const s = await open({ filters: [{ name: "Vehicle model", extensions: ["yft", "ydd"] }] }); if (typeof s === "string") setModelPath(s); } catch {}
  }, [isTauriRuntime]);

  const handleSelectOutput = useCallback(async () => {
    if (!isTauriRuntime) return;
    try { const s = await open({ directory: true }); if (typeof s === "string") setOutputFolder(s); } catch {}
  }, [isTauriRuntime]);

  /* ── Variant ops ── */
  const handleAddVariant = useCallback(() => {
    const base = variants.find((v) => v.isBase);
    const bv = base?.layerVisibility && Object.keys(base.layerVisibility).length > 0 ? base.layerVisibility : { ...layerVisibility };
    const taken = new Set(variants.map((v) => v.name.toLowerCase()));
    let n = variants.length;
    while (taken.has(`variant ${n}`)) n += 1;
    const nv = { id: generateId(), name: `Variant ${n}`, isBase: false,
      toggleable: base ? { ...base.toggleable } : {}, variantSelections: base ? { ...base.variantSelections } : {},
      layerVisibility: { ...bv }, locked: false };
    recordVariantEdit();
    setVariants((prev) => [...prev, nv]); setSelectedVariantId(nv.id);
  }, [variants, layerVisibility, recordVariantEdit]);

  // No confirmation: the inline Undo (and Ctrl+Z) brings a deleted variant back.
  const handleDeleteVariant = useCallback((id) => {
    const target = variantsRef.current.find((v) => v.id === id);
    if (!target || target.isBase) return;
    recordVariantEdit();
    setDeletedVariant({ name: target.name });
    setVariants((prev) => {
      const f = prev.filter((v) => v.id !== id);
      if (selectedVariantId === id && f.length > 0) setSelectedVariantId(f[0].id);
      return f;
    });
  }, [selectedVariantId, recordVariantEdit]);

  const handleDuplicateVariant = useCallback((id) => {
    const src = variants.find((v) => v.id === id); if (!src) return;
    const d = { ...src, id: generateId(), name: `${src.name} copy`, isBase: false, locked: false, layerVisibility: { ...(src.layerVisibility || {}) } };
    recordVariantEdit();
    setVariants((prev) => [...prev, d]); setSelectedVariantId(d.id);
  }, [variants, recordVariantEdit]);

  const handleStartRename = useCallback((id) => { setEditingName(id); setTimeout(() => editNameRef.current?.select(), 50); }, []);
  const handleFinishRename = useCallback((id, name) => {
    const next = typeof name === "string" ? name.trim() : "";
    const current = variantsRef.current.find((v) => v.id === id);
    if (current && next && next !== current.name) recordVariantEdit();
    setVariants((prev) => prev.map((v) => v.id === id ? { ...v, name: next || v.name } : v)); setEditingName(null);
  }, [recordVariantEdit]);

  /* ── Layer ops ── */
  // Edits read a layer the way the list shows it (stored value, else the
  // file's own), and an edit that changes nothing records no undo step.
  const handleToggleLayerById = useCallback((lid) => {
    const layer = psdData?.allLayers?.find((l) => l.id === lid); if (!layer) return;
    recordVariantEdit(`layer:${lid}`);
    setLayerVisibility((p) => toggleLayer(p, layer));
  }, [psdData, recordVariantEdit]);
  const handleToggleGroupCollapse = useCallback((gid) => {
    setCollapsedGroups((p) => { const n = new Set(p); if (n.has(gid)) n.delete(gid); else n.add(gid); return n; });
  }, []);
  const handleSetGroup = useCallback((gid, value) => {
    if (!psdData?.allLayers) return; const g = psdData.allLayers.find((l) => l.id === gid); if (!g) return;
    const children = g.childIds.map((id) => psdData.allLayers.find((l) => l.id === id));
    if (setLayers(layerVisibilityRef.current, children, value) === layerVisibilityRef.current) return;
    recordVariantEdit();
    setLayerVisibility((p) => setLayers(p, children, value));
  }, [psdData, recordVariantEdit]);
  const handleSoloLayer = useCallback((lid) => {
    if (!psdData?.allLayers) return; const l = psdData.allLayers.find((x) => x.id === lid);
    if (!l || !l.parentId) return; const par = psdData.allLayers.find((x) => x.id === l.parentId); if (!par) return;
    const siblings = par.childIds.map((id) => psdData.allLayers.find((x) => x.id === id));
    if (soloLayer(layerVisibilityRef.current, siblings, lid) === layerVisibilityRef.current) return;
    recordVariantEdit(`layer:${lid}`);
    setLayerVisibility((p) => soloLayer(p, siblings, lid));
  }, [psdData, recordVariantEdit]);

  /* ── Export ── */
  const handleExport = useCallback(async (mode, { replace = false } = {}) => {
    if (!psdPath || !psdData || !outputFolder || exporting || exportBlocked) return;
    const toExp = mode === "current" ? [selectedVariant].filter(Boolean) : variants;
    if (toExp.length === 0) return;
    setExportReplace(null);
    if (!replace && loadPrefs()?.defaults?.replaceExports !== true) {
      const names = toExp.flatMap((vr) => (exportRenders && modelPath
        ? [exportFileName(vr.name), renderFileName(vr.name)]
        : [exportFileName(vr.name)]));
      const conflicts = await countExistingFiles(names.map((name) => `${outputFolder}/${name}`), exists);
      if (conflicts > 0) {
        setExportResult(null);
        setExportReplace({ conflicts, total: names.length, folder: outputFolder, mode });
        return;
      }
    }
    setExporting(true); setExportProgress(0); setExportResult(null);
    const written = [];
    // Renders shoot the vehicle pane's live view with each variant swapped in;
    // the selected variant's preview goes back on the vehicle afterwards.
    const rendersWanted = exportRenders && Boolean(modelPath);
    const { width: outW, height: outH } = variantExportDimensions(psdData.width, psdData.height, exportSize, exportShape);
    let renders = 0;
    try {
      for (let i = 0; i < toExp.length; i++) {
        const vr = toExp[i]; let vis;
        if (vr.id === selectedVariantId) vis = { ...compositorVisibility };
        else if (vr.layerVisibility && Object.keys(vr.layerVisibility).length > 0) vis = { ...vr.layerVisibility };
        else {
          vis = {};
          for (const [n, en] of Object.entries(vr.toggleable || {})) vis[n] = en;
          for (const g of psdData.variantGroups || []) {
            const si = vr.variantSelections?.[g.name] ?? 0;
            for (let j = 0; j < g.options.length; j++) vis[g.options[j].name] = j === si;
          }
          for (const l of psdData.locked || []) vis[l.name] = true;
        }
        const canvas = await compositePsdVariant(psdPath, vis, outW, outH);
        const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
        if (!blob) throw new Error(`“${vr.name}” could not be encoded as PNG.`);
        const u8 = new Uint8Array(await blob.arrayBuffer());
        await writeFile(`${outputFolder}/${exportFileName(vr.name)}`, u8);
        written.push(vr.name);
        if (rendersWanted) {
          const viewer = viewerApiRef.current;
          if (!viewer?.setCompositeTexture) throw new Error("The vehicle preview isn't available for renders.");
          // Swapped in and shot in one task, so the frame always shows this variant.
          viewer.setCompositeTexture(canvas);
          const shot = await captureViewerFrameBytes(viewer, { watermark: loadPrefs()?.defaults?.watermark || null });
          if (!shot) throw new Error(`The vehicle render of “${vr.name}” came back empty.`);
          await writeFile(`${outputFolder}/${renderFileName(vr.name)}`, shot);
          renders += 1;
        }
        setExportProgress(((i + 1) / toExp.length) * 100);
      }
      setExportResult({
        tone: "ok",
        message: toExp.length === 1
          ? `Exported ${exportFileName(toExp[0].name)}${rendersWanted ? ` and ${renderFileName(toExp[0].name)}` : ""} to`
          : `Exported ${toExp.length} PNGs${rendersWanted ? ` and ${renders} renders` : ""} to`,
        folder: splitPath(outputFolder).name || outputFolder,
      });
    } catch (err) {
      const reason = toErrorMessage(err, "The file could not be written.");
      setExportResult({
        tone: "error",
        message: written.length
          ? `Stopped after ${written.length} of ${toExp.length}${rendersWanted ? ` (${renders} render${renders === 1 ? "" : "s"} saved)` : ""}. ${reason}`
          : `Nothing was exported. ${reason}`,
      });
    } finally {
      if (rendersWanted) viewerApiRef.current?.setCompositeTexture?.(liveryTargetReady ? previewCanvasRef.current : null);
      setExporting(false);
      trackUsage("livery", written.length);
      trackUsage("photo", renders);
    }
  }, [psdPath, psdData, outputFolder, exporting, exportBlocked, selectedVariant, variants, selectedVariantId, compositorVisibility, exportSize, exportShape, exportRenders, modelPath, liveryTargetReady]);

  useEffect(() => { setExportResult(null); }, [psdPath, outputFolder]);
  // The question was about these variants in this folder; any change asks again.
  useEffect(() => { setExportReplace(null); }, [psdPath, outputFolder, variants, selectedVariantId, exportRenders, modelPath]);

  const openOutputFolder = useCallback(async () => {
    if (await openFolderPath(outputFolder)) return;
    setExportResult({ tone: "error", message: `Couldn't open ${outputFolder} in File Explorer.` });
  }, [outputFolder]);

  /* ── Resize ── */
  // Stable callback (empty deps): the memo'd HResizer never re-renders.
  const handleHResize = useCallback((dx) => {
    pendingHResizeDxRef.current += dx;
    if (hResizeRafRef.current) return;
    hResizeRafRef.current = requestAnimationFrame(() => {
      hResizeRafRef.current = 0;
      const batchedDx = pendingHResizeDxRef.current;
      pendingHResizeDxRef.current = 0;
      const avail = stageRef.current?.getBoundingClientRect().width || 0;
      if (!batchedDx || avail <= 0) return;
      setViewerPanelWidth((p) => {
        const next = Math.max(20, Math.min(80, p + (batchedDx / avail) * 100));
        return Math.abs(next - p) < 0.01 ? p : next;
      });
    });
  }, []);

  const handleVResize = useCallback((dy) => {
    pendingVResizeDyRef.current += dy;
    if (legacyLayersRafRef.current) return;
    legacyLayersRafRef.current = requestAnimationFrame(() => {
      legacyLayersRafRef.current = 0;
      const batchedDy = pendingVResizeDyRef.current;
      pendingVResizeDyRef.current = 0;
      setLegacyLayersHeight((h) => Math.max(140, Math.min(600, h + batchedDy)));
    });
  }, []);

  /* ── Viewer ── */
  const handleViewerReady = useCallback((api) => { viewerApiRef.current = api; setViewerReady(true); }, []);

  /* Hand the composite to the viewer directly (no PNG round trip) and mirror it into the texture pane. */
  useEffect(() => {
    const canvas = previewCanvasRef.current;
    const display = uvImgRef.current;
    if (display && canvas) {
      if (display.width !== canvas.width || display.height !== canvas.height) {
        display.width = canvas.width;
        display.height = canvas.height;
      }
      const ctx = display.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, display.width, display.height);
        ctx.drawImage(canvas, 0, 0);
      }
    }
    if (!viewerReady) return;
    viewerApiRef.current?.setCompositeTexture?.(liveryTargetReady && canvas ? canvas : null);
  }, [previewToken, viewerReady, liveryTargetReady, stageMode]);
  const handleModelInfo = useCallback((info) => { setLiveryTarget(info.liveryTarget || ""); setLiveryTargetReady(true); }, []);
  useEffect(() => {
    setLiveryTarget(""); setLiveryTargetReady(false); setModelError("");
    if (!modelPath) { viewerApiRef.current = null; setViewerReady(false); }
  }, [modelPath]);

  /* ── Texture pan/zoom ── */
  const handleUvPointerDown = useCallback((e) => { if (e.button === 1 || (e.button === 0 && e.altKey)) { setUvPanning(true); e.currentTarget.setPointerCapture(e.pointerId); } }, []);
  const handleUvPointerMove = useCallback((e) => {
    if (uvContainerRef.current && uvImgRef.current) {
      const r = uvImgRef.current.getBoundingClientRect();
      const canvas = uvImgRef.current;
      const x = e.clientX - r.left, y = e.clientY - r.top;
      setUvHover(x >= 0 && y >= 0 && x <= r.width && y <= r.height && r.width > 0
        ? { px: Math.round((x / r.width) * canvas.width), py: Math.round((y / r.height) * canvas.height) }
        : null);
    }
    if (uvPanning) setUvPan((p) => ({ x: p.x + e.movementX, y: p.y + e.movementY }));
  }, [uvPanning]);
  const handleUvPointerUp = useCallback(() => { setUvPanning(false); }, []);
  const handleUvZoomFit = useCallback(() => { setUvZoom(1); setUvPan({ x: 0, y: 0 }); }, []);
  useEffect(() => {
    const element = uvContainerRef.current;
    if (!element) return undefined;
    const handleWheel = (event) => {
      event.preventDefault();
      setUvZoom((previous) => Math.max(0.1, Math.min(10, previous * (event.deltaY > 0 ? 0.9 : 1.1))));
    };
    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, [stageMode, psdPath, modelPath]);

  const currentLighting = LIGHTING_PRESETS.find((p) => p.key === lightingPreset) || LIGHTING_PRESETS[0];

  /* ── Keyboard shortcuts (only while this tab is showing) ── */
  // Layers follow the Toggle Control Panel binding; Ctrl+\ also still works.
  const hotkeys = useStoredHotkeys();
  const panelHotkey = hotkeys[HOTKEY_ACTIONS.TOGGLE_PANEL];
  const layersShortcut = [...new Set([hotkeyLabel(panelHotkey), "Ctrl+\\"].filter(Boolean))].join(" or ");
  useEffect(() => {
    if (!isActive) return undefined;
    const h = (e) => {
      const t = e.target;
      if (t?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t?.tagName)) return;
      if (typeof e.key !== "string") return;
      const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey, shift = e.shiftKey, alt = e.altKey;
      // Undo and redo handlers are stable (refs only), so they aren't effect deps.
      const historyAction = editHistoryKey(e);
      if (historyAction) { e.preventDefault(); if (historyAction === "undo") handleUndoVariants(); else handleRedoVariants(); return; }
      if (ctrl && !shift && k === "e") { e.preventDefault(); handleExport("current"); return; }
      if (ctrl && shift && k === "e") { e.preventDefault(); handleExport("all"); return; }
      if (ctrl && !shift && k === "b") { e.preventDefault(); setDockOpen((s) => !s); return; }
      if (hotkeyMatches(panelHotkey, e) || (ctrl && k === "\\")) { e.preventDefault(); setInspectorOpen((s) => !s); return; }
      if (!ctrl && !shift && !alt && k === "f") { handleUvZoomFit(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [isActive, handleExport, handleUvZoomFit, panelHotkey]);

  useEffect(() => {
    if (!lightMenuOpen) return undefined;
    const h = (e) => { if (lightMenuRef.current && !lightMenuRef.current.contains(e.target)) setLightMenuOpen(false); };
    const k = (e) => { if (e.key === "Escape") setLightMenuOpen(false); };
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => { document.removeEventListener("mousedown", h); document.removeEventListener("keydown", k); };
  }, [lightMenuOpen]);

  /* ── Derived for render ── */
  const hasPreview = previewToken > 0 && Boolean(previewCanvasRef.current);
  const viewerTextureTarget = liveryTarget || "all";
  const hasLayers = Boolean(psdData && psdData.allLayers?.length > 0);
  const bothLoaded = Boolean(modelPath && psdPath);
  const showModelPane = Boolean(modelPath) && (!bothLoaded || stageMode !== "texture");
  const showTexturePane = Boolean(psdPath) && (!bothLoaded || stageMode !== "model");
  const inspectorVisible = hasLayers && inspectorOpen;
  const layersDocked = legacyLayersLayout;

  const layerSections = useMemo(() => {
    if (!psdData?.allLayers) return { topLevel: [], groups: [], locked: [] };
    const topLevel = [], groups = [], locked = [], sl = layerSearch.toLowerCase();
    const matchSearch = (l) => !layerSearch || l.name.toLowerCase().includes(sl);
    const matchFilter = (l) => {
      if (layerFilter === "visible") return layerVisibility[l.id] ?? l.visible;
      if (layerFilter === "modified") return (layerVisibility[l.id] ?? l.visible) !== l.visible;
      return true;
    };
    const tl = psdData.allLayers.filter((l) => l.depth === 0);
    for (let i = tl.length - 1; i >= 0; i--) {
      const l = tl[i];
      if (l.category === "locked" || l.category === "base") { if (matchSearch(l) && matchFilter(l)) locked.push(l); }
      else if (l.isGroup) groups.push(l);
      else { if (matchSearch(l) && matchFilter(l)) topLevel.push(l); }
    }
    return { topLevel, groups, locked };
  }, [psdData, layerSearch, layerFilter, layerVisibility]);

  const getGroupChildren = useCallback((gid) => {
    if (!psdData?.allLayers) return [];
    const g = psdData.allLayers.find((l) => l.id === gid); if (!g) return [];
    const sl = layerSearch.toLowerCase();
    return g.childIds.map((id) => psdData.allLayers.find((l) => l.id === id)).filter(Boolean)
      .filter((l) => {
        if (layerSearch && !l.name.toLowerCase().includes(sl)) return false;
        if (layerFilter === "visible" && !(layerVisibility[l.id] ?? l.visible)) return false;
        if (layerFilter === "modified" && (layerVisibility[l.id] ?? l.visible) === l.visible) return false;
        return true;
      }).slice().reverse();
  }, [psdData, layerSearch, layerFilter, layerVisibility]);

  const layerCounts = useMemo(() => {
    const all = (psdData?.allLayers || []).filter((l) => !l.isGroup);
    return {
      all: all.length,
      visible: all.filter((l) => layerVisibility[l.id] ?? l.visible).length,
      modified: all.filter((l) => (layerVisibility[l.id] ?? l.visible) !== l.visible).length,
    };
  }, [psdData, layerVisibility]);

  const baseVariant = variants.find((v) => v.isBase);
  const changedFromBase = useMemo(() => {
    const map = {};
    for (const v of variants) {
      if (v.isBase) continue;
      map[v.id] = Boolean(baseVariant?.layerVisibility && v.layerVisibility && !sameVisibility(v.layerVisibility, baseVariant.layerVisibility));
    }
    return map;
  }, [variants, baseVariant]);

  const nothingInFilter = hasLayers
    && layerSections.topLevel.length === 0
    && layerSections.locked.length === 0
    && layerSections.groups.every((g) => getGroupChildren(g.id).length === 0);

  const psdSummary = psdData
    ? `${psdData.width} × ${psdData.height} · ${layerCounts.all} layer${layerCounts.all === 1 ? "" : "s"}`
    : "";
  const exportDims = psdData ? variantExportDimensions(psdData.width, psdData.height, exportSize, exportShape) : null;
  const { name: outputName } = splitPath(outputFolder);

  /* ══════════════════════════════════════════════════════════
     Pieces
     ══════════════════════════════════════════════════════════ */
  const contextBar = isActive && contextBarTarget
    ? createPortal(
        <div className="ctx-bar-inner lv-ctx">
          <PanelLayout
            start={{ shown: dockOpen, onToggle: () => setDockOpen((v) => !v), label: dockOpen ? "Hide the pipeline" : "Show the pipeline", hint: " (Ctrl+B)" }}
            end={hasLayers ? { shown: inspectorOpen, onToggle: () => setInspectorOpen((v) => !v), label: inspectorOpen ? "Hide layers" : "Show layers", hint: ` (${layersShortcut})` } : null}
          />
        </div>,
        contextBarTarget,
      )
    : null;

  const layersPanel = (
    <>
      <header className="vb-layers-head">
        <div className="vb-layers-title">
          <h2>Layers</h2>
          <span className="vb-layers-editing" title={selectedVariant?.name}>
            {selectedVariant?.name}
          </span>
        </div>
        <label className="vb-search">
          <Search className="vb-search-icon" aria-hidden="true" />
          <input
            type="text"
            value={layerSearch}
            onChange={(e) => setLayerSearch(e.target.value)}
            placeholder="Find a layer"
            aria-label="Find a layer"
          />
          {layerSearch ? (
            <button type="button" className="vb-search-clear" onClick={() => setLayerSearch("")} aria-label="Clear search">
              <X aria-hidden="true" />
            </button>
          ) : null}
        </label>
        <div className="vb-filters" role="tablist" aria-label="Layer filter">
          {LAYER_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={layerFilter === f.id}
              className={`lv-tab vb-filter ${layerFilter === f.id ? "is-active" : ""}`}
              onClick={() => setLayerFilter(f.id)}
            >
              {f.label}
              <span className="vb-filter-num">{layerCounts[f.id]}</span>
            </button>
          ))}
        </div>
      </header>

      <div className="vb-layers-body custom-scrollbar">
        {layerSections.topLevel.length > 0 ? (
          <section className="vb-layer-group" aria-label="Layers">
            {layerSections.topLevel.map((layer) => (
              <LayerRow key={layer.id} layer={layer} isOn={layerVisibility[layer.id] ?? layer.visible} onToggle={handleToggleLayerById} />
            ))}
          </section>
        ) : null}

        {layerSections.groups.map((group) => {
          const children = getGroupChildren(group.id);
          if ((layerSearch || layerFilter !== "all") && children.length === 0) return null;
          const collapsed = collapsedGroups.has(group.id) && !layerSearch;
          const allIds = group.childIds || [];
          const enCt = allIds.filter((id) => { const l = psdData.allLayers.find((x) => x.id === id); return layerVisibility[id] ?? l?.visible; }).length;
          const allOn = enCt === allIds.length && allIds.length > 0;
          const someOn = enCt > 0 && !allOn;
          return (
            <section key={group.id} className="vb-layer-group" aria-label={group.name}>
              <div className="vb-group-head">
                <button
                  type="button"
                  className="vb-group-toggle"
                  onClick={() => handleToggleGroupCollapse(group.id)}
                  aria-expanded={!collapsed}
                >
                  {collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
                  <span className="vb-group-name">{group.name}</span>
                  <span className="vb-group-count">{enCt}/{allIds.length}</span>
                </button>
                <button
                  type="button"
                  className={`vb-check ${allOn ? "is-all" : someOn ? "is-some" : ""}`}
                  role="checkbox"
                  aria-checked={allOn ? "true" : someOn ? "mixed" : "false"}
                  aria-label={`${allOn ? "Hide" : "Show"} every layer in ${group.name}`}
                  title={allOn ? "Hide all" : "Show all"}
                  onClick={() => handleSetGroup(group.id, !allOn)}
                >
                  {allOn ? <Check aria-hidden="true" /> : null}
                </button>
              </div>
              {!collapsed && children.map((child) => (
                <LayerRow
                  key={child.id}
                  layer={child}
                  child
                  isOn={layerVisibility[child.id] ?? child.visible}
                  onToggle={handleToggleLayerById}
                  onSolo={handleSoloLayer}
                />
              ))}
            </section>
          );
        })}

        {layerSections.locked.length > 0 ? (
          <section className="vb-layer-group" aria-label="Base layers">
            <div className="vb-group-head is-static">
              <span className="cx-label">Base layers</span>
              <span className="vb-group-count">{layerSections.locked.length}</span>
            </div>
            {layerSections.locked.map((layer) => (
              <LayerRow key={layer.id} layer={layer} locked isOn={layerVisibility[layer.id] ?? layer.visible} onToggle={handleToggleLayerById} />
            ))}
          </section>
        ) : null}

        {nothingInFilter ? (
          <p className="vb-layers-empty">
            {layerSearch ? `No layer matches “${layerSearch}”.` : layerFilter === "modified" ? "Every layer matches the source file." : "No layers are visible in this variant."}
          </p>
        ) : null}
      </div>
    </>
  );

  /* ══════════════════════════════════════════════════════════
     RENDER
     ══════════════════════════════════════════════════════════ */
  const rootClass = [
    "lv-root vb-root",
    dockOpen ? "" : "is-dock-closed",
    inspectorVisible && !layersDocked ? "" : "is-inspector-closed",
  ].filter(Boolean).join(" ");
  usePaneMotion(rootRef, rootClass);

  return (
    <div ref={rootRef} className={rootClass} style={panes.style}>
      {contextBar}

      {/* ──── Pipeline ──── */}
      <aside className="lv-dock" aria-label="Variant pipeline" inert={!dockOpen}>
        <div className="lv-dock-scroll custom-scrollbar">
          <AssetSlot
            id="vb-source"
            step={1}
            title="Layered file"
            path={psdPath}
            done={Boolean(psdData) && !psdError}
            emptyTitle="Open a layered file"
            emptyHint="PSD, PDN or AI"
            emptyDetail="Each variant is a set of visible layers in this file."
            onPick={handleSelectPsd}
            onUnload={() => setPsdPath("")}
          >
            {!psdPath && !isTauriRuntime ? (
              <p className="lv-slot-note">Opening files needs the desktop app.</p>
            ) : null}
            {psdPath ? (
              psdLoading ? (
                <p className="lv-slot-note is-idle"><span className="lv-dot" aria-hidden="true" />Reading layers…</p>
              ) : psdError ? (
                <p className="lv-slot-note is-error"><span className="lv-dot" aria-hidden="true" />{psdError}</p>
              ) : psdData ? (
                <p className="lv-slot-note is-ok">
                  <span className="lv-dot" aria-hidden="true" />
                  {psdSummary}
                  <button type="button" className="lv-link vb-reload" onClick={() => setPsdReloadToken((t) => t + 1)}>
                    Reload
                  </button>
                </p>
              ) : null
            ) : null}
          </AssetSlot>

          <AssetSlot
            id="vb-vehicle"
            step={2}
            title="Vehicle"
            path={modelPath}
            done={Boolean(modelPath) && viewerReady && !modelError}
            emptyTitle="Preview on a vehicle"
            emptyHint=".yft or .ydd"
            emptyDetail="Optional. A .yft or .ydd shows the current variant on the car."
            onPick={handleSelectModel}
            onUnload={() => setModelPath("")}
            trailing={<span className="vb-optional">Optional</span>}
          >
            {modelPath ? (
              modelLoading ? (
                <p className="lv-slot-note is-idle"><span className="lv-dot" aria-hidden="true" />Loading model…</p>
              ) : modelError ? (
                <p className="lv-slot-note is-error"><span className="lv-dot" aria-hidden="true" />{modelError}</p>
              ) : liveryTarget ? (
                <p className="lv-slot-note is-ok">
                  <span className="lv-dot" aria-hidden="true" />
                  Painted on {liveryTarget.replace("material:", "")}
                </p>
              ) : null
            ) : null}
          </AssetSlot>

          <Step
            id="vb-variants"
            step={3}
            title="Variants"
            done={variants.length > 1}
            trailing={(
              <span className="vb-history">
                <button
                  type="button"
                  className="cx-icon-btn"
                  onClick={handleUndoVariants}
                  disabled={!canUndoVariants}
                  aria-label="Undo"
                  title="Undo the last variant or layer change (Ctrl+Z)"
                >
                  <Undo2 aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="cx-icon-btn"
                  onClick={handleRedoVariants}
                  disabled={!canRedoVariants}
                  aria-label="Redo"
                  title="Redo (Ctrl+Shift+Z)"
                >
                  <Redo2 aria-hidden="true" />
                </button>
                <span className="vb-count">{variants.length}</span>
              </span>
            )}
          >
            <Ctx.Root>
              <Ctx.Trigger>
                <ul className="vb-variants" aria-label="Variants">
                  {variants.map((v) => {
                    const selected = v.id === selectedVariant?.id;
                    return (
                      <Ctx.Root key={v.id}>
                        <Ctx.Trigger>
                          <li className={`vb-variant ${selected ? "is-selected" : ""}`}>
                            {editingName === v.id ? (
                              <input
                                ref={editNameRef}
                                type="text"
                                className="vb-rename"
                                defaultValue={v.name}
                                aria-label="Variant name"
                                autoFocus
                                onBlur={(e) => handleFinishRename(v.id, e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") handleFinishRename(v.id, e.target.value);
                                  if (e.key === "Escape") setEditingName(null);
                                }}
                              />
                            ) : (
                              <button
                                type="button"
                                className="vb-variant-open"
                                onClick={() => setSelectedVariantId(v.id)}
                                onDoubleClick={() => handleStartRename(v.id)}
                                aria-current={selected ? "true" : undefined}
                              >
                                <span className="vb-variant-name">{v.name}</span>
                                {v.isBase && v.name.trim().toLowerCase() !== "base" ? <span className="vb-variant-tag">Base</span> : null}
                                {changedFromBase[v.id] ? (
                                  <span className="vb-variant-changed" title="Differs from the base variant" aria-label="Differs from base" />
                                ) : null}
                              </button>
                            )}
                            {editingName === v.id ? null : (
                              <span className="vb-variant-actions">
                                <button type="button" className="cx-icon-btn" onClick={() => handleStartRename(v.id)} aria-label={`Rename ${v.name}`} title="Rename">
                                  <Pencil aria-hidden="true" />
                                </button>
                                <button type="button" className="cx-icon-btn" onClick={() => handleDuplicateVariant(v.id)} aria-label={`Duplicate ${v.name}`} title="Duplicate">
                                  <Copy aria-hidden="true" />
                                </button>
                                {!v.isBase ? (
                                  <button type="button" className="cx-icon-btn is-danger" onClick={() => handleDeleteVariant(v.id)} aria-label={`Delete ${v.name}`} title="Delete">
                                    <Trash2 aria-hidden="true" />
                                  </button>
                                ) : null}
                              </span>
                            )}
                          </li>
                        </Ctx.Trigger>
                        <Ctx.Content>
                          <Ctx.Item onSelect={() => handleStartRename(v.id)}><Pencil className="w-3 h-3" /> Rename</Ctx.Item>
                          <Ctx.Item onSelect={() => handleDuplicateVariant(v.id)}><Copy className="w-3 h-3" /> Duplicate</Ctx.Item>
                          {!v.isBase ? (
                            <>
                              <Ctx.Separator />
                              <Ctx.Item onSelect={() => handleDeleteVariant(v.id)} destructive><Trash2 className="w-3 h-3" /> Delete</Ctx.Item>
                            </>
                          ) : null}
                        </Ctx.Content>
                      </Ctx.Root>
                    );
                  })}
                </ul>
              </Ctx.Trigger>
              <Ctx.Content>
                <Ctx.Item onSelect={handleAddVariant}><Plus className="w-3 h-3" /> Add variant</Ctx.Item>
              </Ctx.Content>
            </Ctx.Root>
            {deletedVariant ? (
              <p className="lv-slot-note vb-undo-note" role="status">
                <span>{`Deleted ${deletedVariant.name}.`}</span>
                <button type="button" className="lv-link" onClick={handleUndoVariants}>Undo</button>
              </p>
            ) : null}
            <button type="button" className="cx-btn is-quiet lv-btn-sm vb-add" onClick={handleAddVariant}>
              <Plus aria-hidden="true" />
              Add variant
            </button>
          </Step>
        </div>

        {/* Export is the dock's exit, pinned under the pipeline. */}
        <footer className="lv-dock-foot vb-export">
          <div className="lv-field">
            <span className="cx-label">Size</span>
            <div className="lv-seg" role="radiogroup" aria-label="Export size">
              {SIZE_OPTIONS.map((size) => (
                <button
                  key={size}
                  type="button"
                  role="radio"
                  aria-checked={exportSize === size}
                  aria-label={exportDims && exportDims.width !== exportDims.height ? `${size} pixels on the long side` : `${size} by ${size} pixels`}
                  className={`lv-seg-btn ${exportSize === size ? "is-on" : ""}`}
                  onClick={() => setExportSize(size)}
                >
                  {size >= 1024 ? `${size / 1024}K` : size}
                </button>
              ))}
            </div>
          </div>

          {psdData && psdData.width !== psdData.height ? (
            <div className="lv-field">
              <span className="cx-label">Shape</span>
              <div className="lv-seg" role="radiogroup" aria-label="Export shape">
                {EXPORT_SHAPES.map((shape) => (
                  <button
                    key={shape.id}
                    type="button"
                    role="radio"
                    aria-checked={exportShape === shape.id}
                    className={`lv-seg-btn ${exportShape === shape.id ? "is-on" : ""}`}
                    onClick={() => setExportShape(shape.id)}
                    title={shape.title}
                  >
                    {shape.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {exportDims ? <FootFact label="Output">{exportDims.width} × {exportDims.height} PNG</FootFact> : null}

          <FootFact label="Save to" title={outputFolder || undefined}>
            {outputFolder ? (
              <>
                <span className="vb-dest-name">{outputName || outputFolder}</span>
                <button type="button" className="cx-icon-btn" onClick={handleSelectOutput} disabled={!isTauriRuntime} aria-label="Change output folder" title="Change output folder">
                  <FolderInput aria-hidden="true" />
                </button>
                {isTauriRuntime ? (
                  <button type="button" className="cx-icon-btn" onClick={openOutputFolder} aria-label="Open output folder" title="Open output folder">
                    <FolderOpen aria-hidden="true" />
                  </button>
                ) : null}
              </>
            ) : (
              <button type="button" className="cx-btn lv-btn-sm vb-dest-pick" onClick={handleSelectOutput} disabled={!isTauriRuntime}>
                <FolderInput aria-hidden="true" />
                Choose a folder
              </button>
            )}
          </FootFact>

          {modelPath ? (
            <div className="lv-toggle-row" title="One per variant, from the vehicle view as framed now">
              <span>Save vehicle renders</span>
              <Toggle checked={exportRenders} onChange={setExportRenders} ariaLabel="Save a vehicle render of each variant" />
            </div>
          ) : null}

          {exportIssues.length > 0 && psdPath ? (
            <ul className="vb-issues">
              {exportIssues.map((issue) => (
                <li key={issue.msg} className={`lv-slot-note is-${issue.type === "error" ? "error" : "warn"}`}>
                  <span className="lv-dot" aria-hidden="true" />
                  {issue.msg}
                </li>
              ))}
            </ul>
          ) : null}

          {!psdPath ? (
            <p className="lv-foot-note">{isTauriRuntime ? "Open a layered file to export." : "Exporting needs the desktop app."}</p>
          ) : null}

          {exporting ? (
            <div className="vb-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(exportProgress)} aria-label="Export progress">
              <span style={{ width: `${exportProgress}%` }} />
            </div>
          ) : null}

          <button
            type="button"
            className="cx-btn is-primary"
            onClick={() => handleExport("all")}
            disabled={!psdData || exportBlocked || exporting}
            title={variants.length === 1 ? "Export variant (Ctrl+Shift+E)" : "Export every variant (Ctrl+Shift+E)"}
          >
            <Download aria-hidden="true" />
            {exporting
              ? `Exporting ${Math.round(exportProgress)}%`
              : variants.length === 1 ? "Export variant" : `Export ${variants.length} variants`}
          </button>
          {variants.length > 1 ? (
            <div className="lv-foot-row">
              <button
                type="button"
                className="cx-btn"
                onClick={() => handleExport("current")}
                disabled={!psdData || exportBlocked || exporting}
                title={`Export only ${selectedVariant?.name || "the selected variant"} (Ctrl+E)`}
              >
                Export selected
              </button>
            </div>
          ) : null}

          {exportReplace ? (
            <ReplacePrompt
              conflicts={exportReplace.conflicts}
              total={exportReplace.total}
              folder={exportReplace.folder}
              onConfirm={() => handleExport(exportReplace.mode, { replace: true })}
              onCancel={() => setExportReplace(null)}
            />
          ) : null}
          {exportResult ? (
            <p className={`vb-result is-${exportResult.tone}`} role={exportResult.tone === "error" ? "alert" : "status"}>
              {exportResult.tone === "ok" ? <Check aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
              <span>
                {exportResult.message}
                {exportResult.folder ? <> <span className="vb-result-path" title={outputFolder}>{exportResult.folder}</span></> : null}
              </span>
              {exportResult.tone === "ok" && isTauriRuntime && outputFolder ? (
                <button type="button" className="lv-link" onClick={openOutputFolder}>Open</button>
              ) : null}
            </p>
          ) : null}
        </footer>
        <PaneResizer side="dock" label="Resize the variant pipeline" setWidth={panes.setWidth} />
      </aside>

      {/* ──── Stage ──── */}
      <div className="vb-stage-col">
        <section className={`vb-stage ${bothLoaded ? `is-${stageMode}` : ""}`} ref={stageRef} aria-label="Preview">
          {!modelPath && !psdPath ? (
            <StageEmpty title="Nothing to preview yet" line="Each set of visible layers saves as its own PNG.">
              <button type="button" className="cx-btn is-primary" onClick={handleSelectPsd} disabled={!isTauriRuntime}>
                <FileImage aria-hidden="true" />
                Open layered file
              </button>
              <button type="button" className="cx-btn is-quiet" onClick={handleSelectModel} disabled={!isTauriRuntime}>
                Add a vehicle
              </button>
            </StageEmpty>
          ) : (
            <div className="vb-panes">
              {showModelPane ? (
                <section
                  className="vb-pane vb-pane--model"
                  aria-label="Vehicle preview"
                  style={showTexturePane ? { flexBasis: `${viewerPanelWidth}%` } : undefined}
                >
                  <div className="vb-pane-canvas">
                    <Viewer
                      modelPath={modelPath}
                      texturePath=""
                      textureReloadToken={0}
                      textureTarget={viewerTextureTarget}
                      textureMode="livery"
                      windowTexturePath=""
                      windowTextureTarget="none"
                      windowTextureReloadToken={0}
                      bodyColor="#e7ebf0"
                      backgroundColor="#111214"
                      lightIntensity={currentLighting.intensity}
                      glossiness={0.5}
                      showGrid={false}
                      showWireframe={showWireframe}
                      wasdEnabled={false}
                      isActive={isActive && showModelPane}
                      onReady={handleViewerReady}
                      onModelInfo={handleModelInfo}
                      onTextureReload={NOOP}
                      onTextureError={NOOP}
                      onWindowTextureError={NOOP}
                      onModelError={(message) => { setModelError(message || "The model could not be loaded."); setModelLoading(false); }}
                      onModelLoading={(loading) => { setModelLoading(Boolean(loading)); if (loading) setModelError(""); }}
                      onFormatWarning={NOOP}
                    />
                  </div>
                  {modelError ? (
                    <div className="vb-pane-state lv-slip is-error" role="alert">
                      <AlertTriangle aria-hidden="true" />
                      <span>
                        <strong>The vehicle could not be loaded</strong>
                        <small>{modelError}</small>
                      </span>
                    </div>
                  ) : modelLoading ? (
                    <div className="vb-pane-state lv-slip" role="status">
                      <span className="vb-spinner" aria-hidden="true" />
                      Loading model…
                    </div>
                  ) : null}
                  <div className="lv-deck vb-deck" role="toolbar" aria-label="Camera">
                    <div className="lv-deck-group" role="group" aria-label="Camera shots">
                      {CAMERA_SHOTS.map((shot) => (
                        <DeckButton
                          key={shot.key}
                          onClick={() => viewerApiRef.current?.setPreset?.(shot.key)}
                          title={`${shot.label} view`}
                          disabled={!viewerReady}
                        >
                          {shot.label}
                        </DeckButton>
                      ))}
                      <DeckButton onClick={() => viewerApiRef.current?.reset?.()} title="Re-centre on the model" disabled={!viewerReady} className="is-icon">
                        <Crosshair aria-hidden="true" />
                      </DeckButton>
                    </div>
                    <div className="lv-deck-group" role="group" aria-label="View">
                      <DeckButton active={showWireframe} onClick={() => setShowWireframe((w) => !w)} title="Wireframe" className="is-icon">
                        <Box aria-hidden="true" />
                      </DeckButton>
                      <div className="vb-light" ref={lightMenuRef}>
                        <DeckButton active={lightMenuOpen} onClick={() => setLightMenuOpen((o) => !o)} title={`Lighting: ${currentLighting.label}`} className="vb-light-btn">
                          <Sun aria-hidden="true" />
                          <span>{currentLighting.label}</span>
                        </DeckButton>
                        {lightMenuOpen ? (
                          <div className="vb-menu" role="menu" aria-label="Lighting">
                            {LIGHTING_PRESETS.map((lp) => (
                              <button
                                key={lp.key}
                                type="button"
                                role="menuitemradio"
                                aria-checked={lightingPreset === lp.key}
                                className={`vb-menu-item ${lightingPreset === lp.key ? "is-active" : ""}`}
                                onClick={() => { setLightingPreset(lp.key); setLightMenuOpen(false); }}
                              >
                                <Check className="vb-menu-check" aria-hidden="true" />
                                {lp.label}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </section>
              ) : null}

              {showModelPane && showTexturePane ? <HResizer onResize={handleHResize} /> : null}

              {showTexturePane ? (
                <section className="vb-pane vb-pane--texture" aria-label="Texture preview">
                  <div
                    className={`vb-texture ${showChecker ? "has-checker" : ""} ${showGrid ? "has-grid" : ""} ${uvPanning ? "is-panning" : ""}`}
                    ref={uvContainerRef}
                    onPointerDown={handleUvPointerDown}
                    onPointerMove={handleUvPointerMove}
                    onPointerUp={handleUvPointerUp}
                    onPointerLeave={() => setUvHover(null)}
                  >
                    {hasPreview ? (
                      <div className="vb-texture-canvas" style={{ transform: `translate(${uvPan.x}px, ${uvPan.y}px) scale(${uvZoom})` }}>
                        <div className="vb-texture-frame" style={{ "--ar": `${psdData?.width || 1} / ${psdData?.height || 1}` }}>
                          <canvas ref={uvImgRef} aria-label={`${selectedVariant?.name || "Variant"} texture`} className="vb-texture-img" />
                          {showSafeArea ? <div className="vb-safe-area" aria-hidden="true" /> : null}
                        </div>
                      </div>
                    ) : psdError ? (
                      <div className="vb-texture-state is-error" role="alert">
                        <AlertTriangle aria-hidden="true" />
                        <p className="vb-texture-title">The layered file could not be read</p>
                        <p className="vb-texture-copy">{psdError}</p>
                        <button type="button" className="cx-btn lv-btn-sm" onClick={() => setPsdReloadToken((t) => t + 1)}>
                          <RefreshCw aria-hidden="true" />
                          Try again
                        </button>
                      </div>
                    ) : (
                      <div className="vb-texture-state" role="status">
                        <span className="vb-spinner" aria-hidden="true" />
                        <p className="vb-texture-title">{psdLoading ? "Reading layers" : "Compositing preview"}</p>
                      </div>
                    )}
                  </div>
                  {psdData ? (
                    <span className="vb-texture-meta lv-slip">
                      {psdData.width} × {psdData.height}
                      <span>{Math.round(uvZoom * 100)}%</span>
                      {uvHover ? <span>{uvHover.px}, {uvHover.py}</span> : null}
                    </span>
                  ) : null}
                  <div className="lv-deck vb-deck" role="toolbar" aria-label="Texture view">
                    <div className="lv-deck-group">
                      <DeckButton onClick={handleUvZoomFit} title="Fit (F)" className="is-icon"><Maximize2 aria-hidden="true" /></DeckButton>
                      <DeckButton onClick={() => setUvZoom((z) => Math.max(0.1, z * 0.8))} title="Zoom out" className="is-icon"><ZoomOut aria-hidden="true" /></DeckButton>
                      <DeckButton onClick={() => setUvZoom(1)} title="Actual fit size">100%</DeckButton>
                      <DeckButton onClick={() => setUvZoom((z) => Math.min(10, z * 1.25))} title="Zoom in" className="is-icon"><ZoomIn aria-hidden="true" /></DeckButton>
                    </div>
                    <div className="lv-deck-group">
                      <DeckButton active={showChecker} onClick={() => setShowChecker((c) => !c)} title="Transparency checker" className="is-icon"><SquareDashed aria-hidden="true" /></DeckButton>
                      <DeckButton active={showGrid} onClick={() => setShowGrid((g) => !g)} title="Grid" className="is-icon"><Grid3x3 aria-hidden="true" /></DeckButton>
                      <DeckButton active={showSafeArea} onClick={() => setShowSafeArea((s) => !s)} title="Safe area" className="is-icon"><Frame aria-hidden="true" /></DeckButton>
                    </div>
                  </div>
                </section>
              ) : null}
            </div>
          )}

          {bothLoaded ? (
            <div className="lv-stage-switch vb-view-switch" role="radiogroup" aria-label="Layout">
              {[
                { id: "model", label: "Vehicle" },
                { id: "split", label: "Split" },
                { id: "texture", label: "Texture" },
              ].map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  role="radio"
                  aria-checked={stageMode === mode.id}
                  className={stageMode === mode.id ? "is-on" : ""}
                  onClick={() => setStageMode(mode.id)}
                >
                  {mode.label}
                </button>
              ))}
            </div>
          ) : null}
        </section>

        {layersDocked && hasLayers ? (
          inspectorOpen ? (
            <>
              <VResizer onResize={handleVResize} />
              <aside className="vb-layers is-docked" style={{ height: legacyLayersHeight }} aria-label="Layers">
                {layersPanel}
              </aside>
            </>
          ) : null
        ) : null}
      </div>

      {/* ──── Layers ──── */}
      {!layersDocked ? (
        <aside className="lv-inspector vb-layers" aria-label="Layers" inert={!inspectorVisible}>
          <PaneResizer side="insp" label="Resize the layers panel" setWidth={panes.setWidth} />
          {hasLayers ? layersPanel : null}
        </aside>
      ) : null}
    </div>
  );
}
