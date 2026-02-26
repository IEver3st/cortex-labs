import { memo, useCallback, useEffect, useRef, useState, useMemo } from "react";
import { motion, AnimatePresence } from "motion/react";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import {
  FileImage, Plus, Trash2, Download, Lock, Copy, Car, X,
  Eye, EyeOff, FolderOpen, Check, Pencil,
  ChevronRight, ChevronDown, Layers, AlertTriangle,
  PanelRightOpen, PanelLeftOpen, Palette,
  Maximize2, ZoomIn, ZoomOut, Grid3x3, SquareDashedBottom,
  RotateCcw, Sun, MoreHorizontal, RefreshCw,
  Play, Pause, Box, Search, FolderTree,
  ChevronUp, Save, FileWarning,
  Monitor, Upload,
} from "lucide-react";
import { parsePsdLayers, compositePsdVariant } from "../lib/psd-layers";
import { loadPrefs } from "../lib/prefs";
import { openFolderPath } from "../lib/open-folder";
import * as Ctx from "./ContextMenu";
import Viewer from "./Viewer";

/* ═══════════════════════════════════════════════════════════
   Constants
   ═══════════════════════════════════════════════════════════ */
const DEFAULT_SIZES = [
  { label: "4096", value: 4096 },
  { label: "2048", value: 2048 },
  { label: "1024", value: 1024 },
  { label: "512", value: 512 },
];

const CAMERA_PRESETS = [
  { key: "front", label: "Front" },
  { key: "back", label: "Back" },
  { key: "left", label: "Left" },
  { key: "right", label: "Right" },
  { key: "top", label: "Top" },
  { key: "34", label: "3/4" },
];

const LIGHTING_PRESETS = [
  { key: "studio", label: "Studio", intensity: 1.0 },
  { key: "sunlight", label: "Harsh Sun", intensity: 1.6 },
  { key: "night", label: "Night", intensity: 0.3 },
  { key: "overcast", label: "Overcast", intensity: 0.7 },
];

const BLEND_MODES = ["Normal", "Multiply", "Add", "Screen", "Overlay"];
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

function isPowerOfTwo(n) { return n > 0 && (n & (n - 1)) === 0; }

function getDefaultVariantExportFolder() {
  const prefs = loadPrefs();
  return prefs?.defaults?.variantExportFolder || "";
}

/* ═══════════════════════════════════════════════════════════
   Sub-components
   ═══════════════════════════════════════════════════════════ */

/* --- Horizontal drag handle (memo-wrapped to skip re-renders during panel drag) --- */
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
  return (
    <div className="vp-resizer vp-resizer--h" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
      <div className="vp-resizer-grip" />
    </div>
  );
});

/* --- Vertical drag handle for legacy bottom layers panel --- */
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
  return (
    <div className="vp-resizer vp-resizer--v" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
      <div className="vp-resizer-grip vp-resizer-grip--v" />
    </div>
  );
});

/* --- Opacity slider with double-click number entry --- */
function OpacitySlider({ value, onChange }) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef(null);
  const pct = Math.round((value ?? 1) * 100);
  const commit = useCallback((val) => {
    const n = parseInt(val, 10);
    if (!isNaN(n)) onChange(Math.max(0, Math.min(100, n)) / 100);
    setEditing(false);
  }, [onChange]);
  if (editing) {
    return (
      <input ref={inputRef} type="text" className="vp-opacity-input" defaultValue={pct} autoFocus
        onClick={(e) => e.stopPropagation()} onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") commit(e.target.value); if (e.key === "Escape") setEditing(false); }} />
    );
  }
  return (
    <div className="vp-opacity-slider" onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); setTimeout(() => inputRef.current?.select(), 30); }} onClick={(e) => e.stopPropagation()}>
      <input type="range" min="0" max="100" value={pct} className="vp-opacity-range"
        onChange={(e) => { e.stopPropagation(); onChange(parseInt(e.target.value, 10) / 100); }} onClick={(e) => e.stopPropagation()} />
      <span className="vp-opacity-val">{pct}%</span>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   VariantsPage — Restructured IDE-style PSD Variant Builder
   Layout: [Header] / [Workflow Bar] / [Sidebar | Canvas | Inspector]
   ═══════════════════════════════════════════════════════════════════════ */
export default function VariantsPage({ workspaceState, onStateChange, onRenameTab, settingsVersion, isActive, contextBarTarget }) {
  /* ── State ── */
  const [psdPath, setPsdPath] = useState(workspaceState?.psdPath || "");
  const [psdData, setPsdData] = useState(null);
  const [psdLoading, setPsdLoading] = useState(false);
  const [psdError, setPsdError] = useState("");
  const [variants, setVariants] = useState(workspaceState?.variants || [
    { id: generateId(), name: "Base", isBase: true, toggleable: {}, variantSelections: {}, locked: true },
  ]);
  const [selectedVariantId, setSelectedVariantId] = useState(workspaceState?.selectedVariantId || variants[0]?.id || "");
  const [editingName, setEditingName] = useState(null);
  const editNameRef = useRef(null);
  const [exportSize, setExportSize] = useState(workspaceState?.exportSize || 4096);
  const [outputFolder, setOutputFolder] = useState(
    workspaceState?.outputFolder || getDefaultVariantExportFolder()
  );
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [modelPath, setModelPath] = useState(workspaceState?.modelPath || "");
  const [viewerReady, setViewerReady] = useState(false);
  const [liveryTarget, setLiveryTarget] = useState("");
  const [liveryTargetReady, setLiveryTargetReady] = useState(false);
  const viewerApiRef = useRef(null);
  const [turntableActive, setTurntableActive] = useState(false);
  const [lightingPreset, setLightingPreset] = useState("studio");
  const [showWireframe, setShowWireframe] = useState(false);
  const [showLightMenu, setShowLightMenu] = useState(false);
  const turntableRef = useRef(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewToken, setPreviewToken] = useState(0);
  const [layerVisibility, setLayerVisibility] = useState({});
  const [collapsedGroups, setCollapsedGroups] = useState(new Set());
  const [layerOpacities, setLayerOpacities] = useState({});
  const [layerLocks, setLayerLocks] = useState({});
  const [layerBlendModes, setLayerBlendModes] = useState({});
  const [layerSearch, setLayerSearch] = useState("");
  const [layerFilter, setLayerFilter] = useState("all");
  const [viewerPanelWidth, setViewerPanelWidth] = useState(55);
  const [viewerCollapsed, setViewerCollapsed] = useState(false);
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const [activePanel, setActivePanel] = useState("viewer");
  const [uvZoom, setUvZoom] = useState(1);
  const [uvPan, setUvPan] = useState({ x: 0, y: 0 });
  const [uvPanning, setUvPanning] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [showChecker, setShowChecker] = useState(true);
  const [showSafeArea, setShowSafeArea] = useState(false);
  const [uvHover, setUvHover] = useState(null);
  const uvContainerRef = useRef(null);
  const uvImgRef = useRef(null);
  const [isDirty, setIsDirty] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const initialStateRef = useRef(null);
  const [selectedVariantIds, setSelectedVariantIds] = useState(new Set());
  const [compactLayers, setCompactLayers] = useState(false);
  const [selectedLayerId, setSelectedLayerId] = useState(null);

  /* Legacy bottom layers layout (read from prefs, reloaded on settingsVersion) */
  const [legacyLayersLayout, setLegacyLayersLayout] = useState(() => {
    const prefs = loadPrefs();
    return prefs?.defaults?.legacyLayersLayout ?? false;
  });
  const [legacyLayersHeight, setLegacyLayersHeight] = useState(220);
  const pendingVResizeDyRef = useRef(0);
  const legacyLayersRafRef = useRef(0);

  /* New layout state */
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);

  /* Breadcrumb dropdown menus */
  const [openMenu, setOpenMenu] = useState(null); // "vehicle" | "template" | "output" | "variant" | null
  const vehicleMenuRef = useRef(null);
  const templateMenuRef = useRef(null);
  const outputMenuRef = useRef(null);
  const variantMenuRef = useRef(null);

  const containerRef = useRef(null);
  const exportMenuRef = useRef(null);
  const lightMenuRef = useRef(null);
  const [showSavedToast, setShowSavedToast] = useState(false);
  const savedToastTimer = useRef(null);
  const persistTimerRef = useRef(null);
  const pendingHResizeDxRef = useRef(0);
  const hResizeRafRef = useRef(0);
  const sidebarOpenRef = useRef(sidebarOpen);
  const inspectorOpenRef = useRef(inspectorOpen);
  useEffect(() => { sidebarOpenRef.current = sidebarOpen; }, [sidebarOpen]);
  useEffect(() => { inspectorOpenRef.current = inspectorOpen; }, [inspectorOpen]);

  const isTauriRuntime = typeof window !== "undefined" && typeof window.__TAURI_INTERNALS__ !== "undefined";
  const selectedVariant = variants.find((v) => v.id === selectedVariantId) || variants[0];
  const selectedVariantIdRef = useRef(selectedVariantId);
  useEffect(() => { selectedVariantIdRef.current = selectedVariantId; }, [selectedVariantId]);

  /* ── Derived: live validation status for context header ── */
  const validationStatus = useMemo(() => {
    if (!psdPath && !modelPath) return { type: "empty", label: "No files loaded", issues: [] };
    const issues = [];
    if (!outputFolder) issues.push({ type: "error", msg: "No output folder" });
    if (!psdPath) issues.push({ type: "error", msg: "No layer source loaded" });
    if (psdData) {
      if (!isPowerOfTwo(exportSize)) issues.push({ type: "warn", msg: `Size ${exportSize} not power-of-two` });
      if (psdData.width !== psdData.height) issues.push({ type: "warn", msg: `Non-square (${psdData.width}\u00D7${psdData.height})` });
    }
    const errors = issues.filter((i) => i.type === "error");
    const warns = issues.filter((i) => i.type === "warn");
    if (errors.length > 0) return { type: "error", label: `${errors.length} error${errors.length > 1 ? "s" : ""}`, issues };
    if (warns.length > 0) return { type: "warn", label: `${warns.length} warning${warns.length > 1 ? "s" : ""}`, issues };
    return { type: "ok", label: "Ready to export", issues: [] };
  }, [psdPath, modelPath, outputFolder, psdData, exportSize]);

  /* ── Dirty tracking ── */
  useEffect(() => {
    if (!initialStateRef.current && psdPath) initialStateRef.current = JSON.stringify({ variants, layerVisibility });
    if (initialStateRef.current) setIsDirty(JSON.stringify({ variants, layerVisibility }) !== initialStateRef.current);
  }, [variants, layerVisibility, psdPath]);

  /* ── Persist ── */
  useEffect(() => {
    if (!onStateChange) return;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      onStateChange({ psdPath, modelPath, variants, selectedVariantId, exportSize, outputFolder });
    }, 140);
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, [psdPath, modelPath, variants, selectedVariantId, exportSize, outputFolder, onStateChange]);

  useEffect(() => {
    if (!settingsVersion) return;
    setOutputFolder((prev) => prev || getDefaultVariantExportFolder());
    const prefs = loadPrefs();
    setLegacyLayersLayout(prefs?.defaults?.legacyLayersLayout ?? false);
  }, [settingsVersion]);

  useEffect(() => () => {
    if (hResizeRafRef.current) cancelAnimationFrame(hResizeRafRef.current);
    if (legacyLayersRafRef.current) cancelAnimationFrame(legacyLayersRafRef.current);
  }, []);

  /* ── Load PSD ── */
  useEffect(() => {
    if (!psdPath) { setPsdData(null); setLayerVisibility({}); return; }
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
      initialStateRef.current = null;
    }).catch((err) => { if (!cancelled) setPsdError(typeof err === "string" ? err : err?.message || "Failed to parse layer source"); })
      .finally(() => { if (!cancelled) setPsdLoading(false); });
    return () => { cancelled = true; };
  }, [psdPath]);

  const compositorVisibility = useMemo(() => ({ ...layerVisibility }), [layerVisibility]);
  const visibilityKey = useMemo(() => JSON.stringify(compositorVisibility), [compositorVisibility]);

  /* ── Preview generation ── */
  useEffect(() => {
    if (!isActive || !psdPath || !psdData) return;
    let cancelled = false;
    const gen = async () => {
      try {
        const maxDim = Math.max(psdData.width || 0, psdData.height || 0) || exportSize;
        const s = Math.min(1, Math.min(exportSize, maxDim) / maxDim);
        const pw = Math.max(1, Math.round((psdData.width || maxDim) * s));
        const ph = Math.max(1, Math.round((psdData.height || maxDim) * s));
        const canvas = await compositePsdVariant(psdPath, compositorVisibility, pw, ph);
        if (!cancelled) { setPreviewUrl(canvas.toDataURL("image/png")); setPreviewToken((t) => t + 1); }
      } catch (err) { console.error("Preview failed:", err); }
    };
    const timer = setTimeout(gen, 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [isActive, psdPath, psdData, visibilityKey, exportSize, compositorVisibility]);

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

  /* ── Turntable ── */
  useEffect(() => {
    if (!turntableActive || !isActive) { if (turntableRef.current) { cancelAnimationFrame(turntableRef.current); turntableRef.current = null; } return; }
    const rot = () => { turntableRef.current = requestAnimationFrame(rot); };
    turntableRef.current = requestAnimationFrame(rot);
    return () => { if (turntableRef.current) cancelAnimationFrame(turntableRef.current); };
  }, [turntableActive, isActive]);

  /* ── File selectors ── */
  const handleSelectPsd = useCallback(async () => {
    if (!isTauriRuntime) return;
    try {
      const s = await open({ filters: [{ name: "Layer Source", extensions: ["psd", "pdn", "ai"] }] });
      if (typeof s === "string") { setPsdPath(s); const n = s.split(/[\\/]/).pop(); if (n && onRenameTab) onRenameTab(n); }
    } catch {}
  }, [isTauriRuntime, onRenameTab]);

  const handleSelectModel = useCallback(async () => {
    if (!isTauriRuntime) return;
    try { const s = await open({ filters: [{ name: "Vehicle Model", extensions: ["yft", "ydd"] }] }); if (typeof s === "string") setModelPath(s); } catch {}
  }, [isTauriRuntime]);

  const handleSelectOutput = useCallback(async () => {
    if (!isTauriRuntime) return;
    try { const s = await open({ directory: true }); if (typeof s === "string") setOutputFolder(s); } catch {}
  }, [isTauriRuntime]);

  /* ── Variant ops ── */
  const handleAddVariant = useCallback(() => {
    const base = variants.find((v) => v.isBase);
    const bv = base?.layerVisibility && Object.keys(base.layerVisibility).length > 0 ? base.layerVisibility : { ...layerVisibility };
    const nv = { id: generateId(), name: `Variant ${variants.length}`, isBase: false,
      toggleable: base ? { ...base.toggleable } : {}, variantSelections: base ? { ...base.variantSelections } : {},
      layerVisibility: { ...bv }, locked: false };
    setVariants((prev) => [...prev, nv]); setSelectedVariantId(nv.id);
  }, [variants, layerVisibility]);

  const handleDeleteVariant = useCallback((id) => {
    setVariants((prev) => {
      const f = prev.filter((v) => v.id !== id);
      if (selectedVariantId === id && f.length > 0) setSelectedVariantId(f[0].id);
      return f;
    });
  }, [selectedVariantId]);

  const handleDuplicateVariant = useCallback((id) => {
    const src = variants.find((v) => v.id === id); if (!src) return;
    const d = { ...src, id: generateId(), name: `${src.name} Copy`, isBase: false, locked: false, layerVisibility: { ...(src.layerVisibility || {}) } };
    setVariants((prev) => [...prev, d]); setSelectedVariantId(d.id);
  }, [variants]);

  const handleStartRename = useCallback((id) => { setEditingName(id); setTimeout(() => editNameRef.current?.select(), 50); }, []);
  const handleFinishRename = useCallback((id, name) => {
    setVariants((prev) => prev.map((v) => v.id === id ? { ...v, name: name || v.name } : v)); setEditingName(null);
  }, []);

  /* ── Layer ops ── */
  const handleToggleLayerById = useCallback((lid) => { setLayerVisibility((p) => ({ ...p, [lid]: !p[lid] })); }, []);
  const handleToggleGroupCollapse = useCallback((gid) => {
    setCollapsedGroups((p) => { const n = new Set(p); if (n.has(gid)) n.delete(gid); else n.add(gid); return n; });
  }, []);
  const handleEnableAllInGroup = useCallback((gid) => {
    if (!psdData?.allLayers) return; const g = psdData.allLayers.find((l) => l.id === gid); if (!g) return;
    setLayerVisibility((p) => { const n = { ...p }; for (const c of g.childIds) n[c] = true; return n; });
  }, [psdData]);
  const handleDisableAllInGroup = useCallback((gid) => {
    if (!psdData?.allLayers) return; const g = psdData.allLayers.find((l) => l.id === gid); if (!g) return;
    setLayerVisibility((p) => { const n = { ...p }; for (const c of g.childIds) n[c] = false; return n; });
  }, [psdData]);
  const handleSoloLayer = useCallback((lid) => {
    if (!psdData?.allLayers) return; const l = psdData.allLayers.find((x) => x.id === lid);
    if (!l || !l.parentId) return; const par = psdData.allLayers.find((x) => x.id === l.parentId); if (!par) return;
    setLayerVisibility((p) => { const n = { ...p }; for (const s of par.childIds) n[s] = s === lid; return n; });
  }, [psdData]);
  const handleToggleLock = useCallback((lid) => { setLayerLocks((p) => ({ ...p, [lid]: !p[lid] })); }, []);
  const handleSetOpacity = useCallback((lid, o) => { setLayerOpacities((p) => ({ ...p, [lid]: o })); }, []);
  const handleSetBlendMode = useCallback((lid, m) => { setLayerBlendModes((p) => ({ ...p, [lid]: m })); }, []);

  /* ── Save ── */
  const handleSave = useCallback(() => {
    initialStateRef.current = JSON.stringify({ variants, layerVisibility }); setIsDirty(false); setLastSavedAt(new Date());
    setShowSavedToast(true);
    if (savedToastTimer.current) clearTimeout(savedToastTimer.current);
    savedToastTimer.current = setTimeout(() => setShowSavedToast(false), 2000);
  }, [variants, layerVisibility]);

  /* ── Export ── */
  const handleExport = useCallback(async (mode) => {
    if (!psdPath || !psdData || !outputFolder) return;
    if (validationStatus.issues.some((i) => i.type === "error")) return;
    setExporting(true); setExportProgress(0); setShowExportMenu(false);
    try {
      let toExp = variants;
      if (mode === "current") toExp = [selectedVariant].filter(Boolean);
      else if (mode === "selected") toExp = variants.filter((v) => selectedVariantIds.has(v.id));
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
        const canvas = await compositePsdVariant(psdPath, vis, exportSize, exportSize);
        const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
        const u8 = new Uint8Array(await blob.arrayBuffer());
        await writeFile(`${outputFolder}/${vr.name.replace(/[^a-zA-Z0-9_\- ]/g, "_")}.png`, u8);
        setExportProgress(((i + 1) / toExp.length) * 100);
      }
    } catch (err) { console.error("Export failed:", err); } finally { setExporting(false); }
  }, [psdPath, psdData, variants, exportSize, outputFolder, selectedVariantId, compositorVisibility, selectedVariant, selectedVariantIds, validationStatus]);

  /* ── Resize ── */
  // Stable callback (empty deps) — reads sidebar/inspector from refs so the
  // function identity never changes and memo'd HResizer never re-renders.
  const handleHResize = useCallback((dx) => {
    pendingHResizeDxRef.current += dx;
    if (hResizeRafRef.current) return;
    hResizeRafRef.current = requestAnimationFrame(() => {
      hResizeRafRef.current = 0;
      const batchedDx = pendingHResizeDxRef.current;
      pendingHResizeDxRef.current = 0;
      if (!batchedDx || !containerRef.current) return;
      const sidebar = sidebarOpenRef.current ? 260 : 36;
      const inspector = inspectorOpenRef.current ? 320 : 0;
      const avail = containerRef.current.getBoundingClientRect().width - sidebar - inspector;
      if (avail <= 0) return;
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
      setLegacyLayersHeight((h) => Math.max(120, Math.min(600, h + batchedDy)));
    });
  }, []);

  /* ── Model info ── */
  const handleViewerReady = useCallback((api) => { viewerApiRef.current = api; setViewerReady(true); }, []);
  const handleModelInfo = useCallback((info) => { setLiveryTarget(info.liveryTarget || ""); setLiveryTargetReady(true); }, []);
  useEffect(() => { setLiveryTarget(""); setLiveryTargetReady(false); }, [modelPath]);

  /* ── UV pan/zoom ── */
  const handleUvWheel = useCallback((e) => { e.preventDefault(); setUvZoom((p) => Math.max(0.1, Math.min(10, p * (e.deltaY > 0 ? 0.9 : 1.1)))); }, []);
  const handleUvPointerDown = useCallback((e) => { if (e.button === 1 || (e.button === 0 && e.altKey)) { setUvPanning(true); e.currentTarget.setPointerCapture(e.pointerId); } }, []);
  const handleUvPointerMove = useCallback((e) => {
    if (uvContainerRef.current && uvImgRef.current) {
      const r = uvImgRef.current.getBoundingClientRect();
      const x = Math.round(e.clientX - r.left), y = Math.round(e.clientY - r.top);
      setUvHover(x >= 0 && y >= 0 && x <= r.width && y <= r.height ? { x, y, px: Math.round(x / uvZoom), py: Math.round(y / uvZoom) } : null);
    }
    if (uvPanning) setUvPan((p) => ({ x: p.x + e.movementX, y: p.y + e.movementY }));
  }, [uvPanning, uvZoom]);
  const handleUvPointerUp = useCallback(() => { setUvPanning(false); }, []);
  const handleUvZoomFit = useCallback(() => { setUvZoom(1); setUvPan({ x: 0, y: 0 }); }, []);

  /* ── Camera ── */
  const handleCameraPreset = useCallback((k) => { viewerApiRef.current?.setPreset?.(k); }, []);
  const handleCameraReset = useCallback(() => { viewerApiRef.current?.reset?.(); }, []);
  const currentLighting = LIGHTING_PRESETS.find((p) => p.key === lightingPreset) || LIGHTING_PRESETS[0];

  /* ── Keyboard shortcuts ── */
  useEffect(() => {
    const h = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
      const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey, shift = e.shiftKey, alt = e.altKey;
      if (ctrl && !shift && k === "e") { e.preventDefault(); handleExport("current"); return; }
      if (ctrl && shift && k === "e") { e.preventDefault(); handleExport("all"); return; }
      if (ctrl && k === "s") { e.preventDefault(); handleSave(); return; }
      if (!ctrl && !shift && !alt && k === "f") { handleUvZoomFit(); return; }
      if (!ctrl && !shift && !alt && k === "tab") { e.preventDefault(); setActivePanel((p) => p === "viewer" ? "texture" : p === "texture" ? "layers" : "viewer"); return; }
      if (!ctrl && shift && !alt && k === "tab") { e.preventDefault(); setActivePanel((p) => p === "viewer" ? "layers" : p === "layers" ? "texture" : "viewer"); return; }
      if (ctrl && k === "b") { e.preventDefault(); setSidebarOpen((s) => !s); return; }
      if (ctrl && k === "\\") { e.preventDefault(); setInspectorOpen((s) => !s); return; }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [handleExport, handleSave, handleUvZoomFit]);

  /* ── Click-away ── */
  useEffect(() => {
    if (!showExportMenu) return;
    const h = (e) => { if (exportMenuRef.current && !exportMenuRef.current.contains(e.target)) setShowExportMenu(false); };
    document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h);
  }, [showExportMenu]);
  useEffect(() => {
    if (!showLightMenu) return;
    const h = (e) => { if (lightMenuRef.current && !lightMenuRef.current.contains(e.target)) setShowLightMenu(false); };
    document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h);
  }, [showLightMenu]);
  useEffect(() => {
    if (!openMenu) return;
    const refs = { vehicle: vehicleMenuRef, template: templateMenuRef, output: outputMenuRef, variant: variantMenuRef };
    const h = (e) => {
      const ref = refs[openMenu];
      if (ref?.current && !ref.current.contains(e.target)) setOpenMenu(null);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [openMenu]);

  /* ── Derived for render ── */
  const viewerTexturePath = liveryTargetReady ? (previewUrl || "") : "";
  const viewerTextureTarget = liveryTarget || "all";
  const psdFileName = psdPath ? psdPath.split(/[\\/]/).pop() : "";
  const modelFileName = modelPath ? modelPath.split(/[\\/]/).pop() : "";
  const hasLayers = psdData && (psdData.allLayers?.length > 0);
  const hasContent = !!(modelPath || psdPath);

  const statusChip = useMemo(() => {
    if (exporting) return { type: "exporting", label: `${Math.round(exportProgress)}%` };
    if (!hasContent) return null;
    if (validationStatus.type === "error") return { type: "error", label: validationStatus.label };
    if (isDirty) return { type: "dirty", label: "Unsaved" };
    if (validationStatus.type === "warn") return { type: "warn", label: validationStatus.label };
    if (validationStatus.type === "ok") return { type: "ok", label: "Ready" };
    return null;
  }, [exporting, exportProgress, validationStatus, isDirty, hasContent]);

  const layerSections = useMemo(() => {
    if (!psdData?.allLayers) return { topLevel: [], groups: [], locked: [] };
    const topLevel = [], groups = [], locked = [], sl = layerSearch.toLowerCase();
    const matchSearch = (l) => !layerSearch || l.name.toLowerCase().includes(sl);
    const matchFilter = (l) => {
      if (layerFilter === "all") return true;
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

  const exportSummary = useMemo(() => ({
    visibleCount: Object.values(layerVisibility).filter(Boolean).length,
    format: "PNG", size: exportSize, variantCount: variants.length,
  }), [layerVisibility, exportSize, variants]);

  const variantStatuses = useMemo(() => {
    const map = {};
    const baseV = variants.find(b => b.isBase);
    for (const v of variants) {
      const hasLv = v.layerVisibility && Object.keys(v.layerVisibility).length > 0;
      const isModified = v.id === selectedVariantId ? isDirty : (hasLv && baseV && JSON.stringify(v.layerVisibility) !== JSON.stringify(baseV.layerVisibility));
      if (validationStatus.type === "error") map[v.id] = "error";
      else if (validationStatus.type === "warn") map[v.id] = "warn";
      else if (isModified) map[v.id] = "modified";
      else map[v.id] = "ok";
    }
    return map;
  }, [variants, selectedVariantId, isDirty, validationStatus]);

  const selectedLayerInfo = useMemo(() => {
    if (!selectedLayerId || !psdData?.allLayers) return null;
    return psdData.allLayers.find(l => l.id === selectedLayerId) || null;
  }, [selectedLayerId, psdData]);

  /* ── Layers panel inner content — shared between right and legacy-bottom panels ── */
  const renderLayersContent = () => (
    <>
      <div className="vp-inspector-head">
        <div className="vp-inspector-title">
          <Layers className="w-3.5 h-3.5" />
          <span>Layers</span>
        </div>
        <button type="button" className="vp-inspector-close" onClick={() => setInspectorOpen(false)} title="Close (Ctrl+\\)">
          <PanelRightOpen className="w-3 h-3" />
        </button>
      </div>

      {/* Search + Filters */}
      <div className="vp-inspector-toolbar">
        <div className="vp-inspector-search">
          <Search className="w-3 h-3 vp-inspector-search-icon" />
          <input type="text" className="vp-inspector-search-input" placeholder="Search layers..." value={layerSearch} onChange={(e) => setLayerSearch(e.target.value)} />
        </div>
        <div className="vp-inspector-filters">
          {["all", "visible", "modified"].map((f) => (
            <button key={f} type="button" className={`vp-filter-btn ${layerFilter === f ? "is-active" : ""}`} onClick={() => setLayerFilter(f)}>
              {f === "all" ? "All" : f === "visible" ? "Visible" : "Modified"}
            </button>
          ))}
          <button type="button" className={`vp-filter-btn vp-compact-toggle ${compactLayers ? "is-active" : ""}`} onClick={() => setCompactLayers(c => !c)} title={compactLayers ? "Comfortable view" : "Compact view"}>
            {compactLayers ? "Dense" : "Comfy"}
          </button>
        </div>
      </div>

      {/* Layer list */}
      <div className="vp-inspector-body">
        {layerSections.topLevel.length > 0 && (
          <div className="vp-layer-section">
            <div className="vp-layer-section-head">
              <span>Layers</span>
              <span className="vp-layer-section-count">{layerSections.topLevel.length}</span>
            </div>
            {layerSections.topLevel.map((layer) => {
              const isOn = layerVisibility[layer.id] ?? layer.visible;
              const isLocked = layerLocks[layer.id] || false;
              const opacity = layerOpacities[layer.id] ?? layer.opacity;
              const bm = layerBlendModes[layer.id] || "Normal";
              const isSel = selectedLayerId === layer.id;
              return (
                <div key={layer.id} className={`vp-layer-row ${isOn ? "is-on" : ""} ${isLocked ? "is-locked" : ""} ${compactLayers ? "vp-layer-row--compact" : ""} ${isSel ? "is-selected" : ""}`}
                  onClick={() => setSelectedLayerId(layer.id)}>
                  <button type="button" className="vp-layer-vis-btn" onClick={(e) => { e.stopPropagation(); handleToggleLayerById(layer.id); }}>
                    {isOn ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                  </button>
                  <span className="vp-layer-name">{layer.name}</span>
                  <div className="vp-layer-props">
                    <select className="vp-layer-blend" value={bm} onChange={(e) => { e.stopPropagation(); handleSetBlendMode(layer.id, e.target.value); }} onClick={(e) => e.stopPropagation()}>
                      {BLEND_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                    <OpacitySlider value={opacity} onChange={(v) => handleSetOpacity(layer.id, v)} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {layerSections.groups.map((group) => {
          const collapsed = collapsedGroups.has(group.id);
          const children = getGroupChildren(group.id);
          const allIds = psdData.allLayers.find((l) => l.id === group.id)?.childIds || [];
          const enCt = allIds.filter((id) => { const l = psdData.allLayers.find((x) => x.id === id); return layerVisibility[id] ?? l?.visible; }).length;
          const allOn = enCt === allIds.length && allIds.length > 0;
          const someOn = enCt > 0 && !allOn;
          return (
            <div key={group.id} className="vp-layer-section">
              <div className="vp-layer-section-head vp-layer-section-head--group">
                <button type="button" className="vp-layer-collapse-btn" onClick={() => handleToggleGroupCollapse(group.id)}>
                  {collapsed ? <ChevronRight className="w-2.5 h-2.5" /> : <ChevronDown className="w-2.5 h-2.5" />}
                </button>
                <button type="button" className={`vp-layer-group-check ${allOn ? "is-all" : someOn ? "is-partial" : ""}`}
                  onClick={() => allOn ? handleDisableAllInGroup(group.id) : handleEnableAllInGroup(group.id)}>
                  {allOn ? <Check className="vp-layer-group-check-icon" /> : <div className="vp-layer-group-check-inner" />}
                </button>
                <FolderTree className="w-3 h-3" style={{ opacity: 0.35, flexShrink: 0 }} />
                <span className="vp-layer-section-name">{group.name}</span>
                <span className="vp-layer-section-count">{enCt}/{allIds.length}</span>
                <div className="vp-layer-group-actions">
                  <button type="button" className="vp-layer-group-act" onClick={() => handleEnableAllInGroup(group.id)}>All</button>
                  <button type="button" className="vp-layer-group-act" onClick={() => handleDisableAllInGroup(group.id)}>None</button>
                </div>
              </div>
              {!collapsed && children.map((child) => {
                const isOn = layerVisibility[child.id] ?? child.visible;
                const isLocked = layerLocks[child.id] || false;
                const opacity = layerOpacities[child.id] ?? child.opacity;
                const bm = layerBlendModes[child.id] || "Normal";
                const isSel = selectedLayerId === child.id;
                return (
                  <div key={child.id} className={`vp-layer-row vp-layer-row--child ${isOn ? "is-on" : ""} ${isLocked ? "is-locked" : ""} ${compactLayers ? "vp-layer-row--compact" : ""} ${isSel ? "is-selected" : ""}`}
                    onClick={() => setSelectedLayerId(child.id)}
                    onDoubleClick={() => handleSoloLayer(child.id)} title="Double-click to solo">
                    <button type="button" className="vp-layer-vis-btn" onClick={(e) => { e.stopPropagation(); handleToggleLayerById(child.id); }}>
                      {isOn ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                    </button>
                    <span className="vp-layer-name">{child.name}</span>
                    <div className="vp-layer-props">
                      <select className="vp-layer-blend" value={bm} onChange={(e) => { e.stopPropagation(); handleSetBlendMode(child.id, e.target.value); }} onClick={(e) => e.stopPropagation()}>
                        {BLEND_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                      <OpacitySlider value={opacity} onChange={(v) => handleSetOpacity(child.id, v)} />
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
        {layerSections.locked.length > 0 && (
          <div className="vp-layer-section vp-layer-section--locked">
            <div className="vp-layer-section-head">
              <Lock className="w-2.5 h-2.5" /><span>Base Layers</span>
              <span className="vp-layer-section-count">{layerSections.locked.length}</span>
            </div>
            {layerSections.locked.map((layer) => {
              const isOn = layerVisibility[layer.id] ?? layer.visible;
              return (
                <div key={layer.id} className={`vp-layer-row vp-layer-row--locked ${isOn ? "is-on" : ""}`}>
                  <button type="button" className="vp-layer-vis-btn" onClick={() => handleToggleLayerById(layer.id)}>
                    {isOn ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                  </button>
                  <Lock className="w-2.5 h-2.5 vp-layer-lock-icon" />
                  <span className="vp-layer-name">{layer.name}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {selectedLayerInfo && (
        <div className="vp-layer-inspector">
          <div className="vp-layer-inspector-head">
            <span className="vp-layer-inspector-name">{selectedLayerInfo.name}</span>
            <button type="button" className="vp-layer-inspector-close" onClick={() => setSelectedLayerId(null)}><X className="w-3 h-3" /></button>
          </div>
          <div className="vp-layer-inspector-body">
            <div className="vp-layer-inspector-row">
              <span className="vp-layer-inspector-label">Blend</span>
              <select className="vp-layer-blend" value={layerBlendModes[selectedLayerInfo.id] || "Normal"} onChange={(e) => handleSetBlendMode(selectedLayerInfo.id, e.target.value)}>
                {BLEND_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div className="vp-layer-inspector-row">
              <span className="vp-layer-inspector-label">Opacity</span>
              <OpacitySlider value={layerOpacities[selectedLayerInfo.id] ?? selectedLayerInfo.opacity} onChange={(v) => handleSetOpacity(selectedLayerInfo.id, v)} />
            </div>
            {selectedLayerInfo.isGroup && (
              <div className="vp-layer-inspector-row">
                <span className="vp-layer-inspector-label">Children</span>
                <span className="vp-layer-inspector-val">{selectedLayerInfo.childIds?.length || 0}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );

  /* ══════════════════════════════════════════════════════════
     RENDER
     ══════════════════════════════════════════════════════════ */
  return (
    <div className="vp" ref={containerRef}>

      {/* ── Row 2 Portal: Unified Toolbar ── */}
      {isActive && contextBarTarget && createPortal(
        <div className="ctx-bar-inner">
          {/* LEFT ZONE: Setup Breadcrumbs */}
          <nav className="vp-crumb">
            {/* Vehicle ▾ */}
            <div className="vp-crumb-anchor" ref={vehicleMenuRef}>
              <button type="button" className={`vp-crumb-chip ${!modelPath ? "vp-crumb-chip--empty" : ""}`}
                onClick={() => modelPath ? setOpenMenu((m) => m === "vehicle" ? null : "vehicle") : handleSelectModel()}
                title={modelPath || "Load vehicle model"}>
                <span className="vp-crumb-chip-label">Vehicle</span>
                <span className="vp-crumb-chip-value">{modelFileName ? modelFileName.replace(/\.(yft|ydd)$/i, "") : "None"}</span>
                {modelPath && <ChevronDown className="vp-crumb-chip-chevron" />}
              </button>
              {openMenu === "vehicle" && modelPath && (
                <div className="vp-dropdown-menu vp-dropdown-menu--crumb">
                  <button type="button" className="vp-dropdown-item" onClick={() => { handleSelectModel(); setOpenMenu(null); }}>
                    <Car className="w-3 h-3" /> Load vehicle
                  </button>
                  <div className="vp-dropdown-sep" />
                  <button type="button" className="vp-dropdown-item vp-dropdown-item--danger" onClick={() => { setModelPath(""); setOpenMenu(null); }}>
                    <X className="w-3 h-3" /> Unload vehicle
                  </button>
                </div>
              )}
            </div>

            <span className="vp-crumb-sep">/</span>

            {/* Template ▾ */}
            <div className="vp-crumb-anchor" ref={templateMenuRef}>
              <button type="button" className={`vp-crumb-chip ${!psdFileName ? "vp-crumb-chip--empty" : ""}`}
                onClick={() => psdPath ? setOpenMenu((m) => m === "template" ? null : "template") : handleSelectPsd()}
                title={psdPath || "Import PSD/PDN/AI layer source"}>
                <span className="vp-crumb-chip-label">Template</span>
                <span className="vp-crumb-chip-value">{psdFileName ? psdFileName.replace(/\.(psd|pdn|ai)$/i, "") : "None"}</span>
                {psdPath && <ChevronDown className="vp-crumb-chip-chevron" />}
              </button>
              {openMenu === "template" && psdPath && (
                <div className="vp-dropdown-menu vp-dropdown-menu--crumb">
                  <button type="button" className="vp-dropdown-item" onClick={() => { handleSelectPsd(); setOpenMenu(null); }}>
                    <FileImage className="w-3 h-3" /> Import layer source
                  </button>
                  <button type="button" className="vp-dropdown-item" onClick={() => { setPsdPath(psdPath); setOpenMenu(null); }}>
                    <RefreshCw className="w-3 h-3" /> Reload
                  </button>
                  <div className="vp-dropdown-sep" />
                  <button type="button" className="vp-dropdown-item vp-dropdown-item--danger" onClick={() => { setPsdPath(""); setOpenMenu(null); }}>
                    <X className="w-3 h-3" /> Unload template
                  </button>
                </div>
              )}
            </div>

            <span className="vp-crumb-sep">/</span>

            {/* Output ▾ */}
            <div className="vp-crumb-anchor" ref={outputMenuRef}>
              <button type="button" className={`vp-crumb-chip ${!outputFolder ? "vp-crumb-chip--empty" : ""}`}
                onClick={() => outputFolder ? setOpenMenu((m) => m === "output" ? null : "output") : handleSelectOutput()}
                title={outputFolder || "Set output folder"}>
                <span className="vp-crumb-chip-label">Output</span>
                <span className="vp-crumb-chip-value">{outputFolder ? `\u2026/${outputFolder.split(/[\\/]/).pop()}` : "None"}</span>
                {outputFolder && <ChevronDown className="vp-crumb-chip-chevron" />}
              </button>
              {openMenu === "output" && outputFolder && (
                <div className="vp-dropdown-menu vp-dropdown-menu--crumb">
                  <button type="button" className="vp-dropdown-item" onClick={() => { handleSelectOutput(); setOpenMenu(null); }}>
                    <FolderOpen className="w-3 h-3" /> Change folder
                  </button>
                  <button type="button" className="vp-dropdown-item" onClick={async () => { setOpenMenu(null); if (isTauriRuntime) await openFolderPath(outputFolder); }}>
                    <FolderTree className="w-3 h-3" /> Open output folder
                  </button>
                </div>
              )}
            </div>

            <span className="vp-crumb-sep">/</span>

            {/* Variant ▾ */}
            <div className="vp-crumb-anchor" ref={variantMenuRef}>
              {editingName === selectedVariantId ? (
                <div className="vp-crumb-chip vp-crumb-chip--editing">
                  <span className="vp-crumb-chip-label">Variant</span>
                  <input ref={editNameRef} type="text" className="vp-crumb-input" defaultValue={selectedVariant?.name} autoFocus
                    onBlur={(e) => handleFinishRename(selectedVariantId, e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleFinishRename(selectedVariantId, e.target.value); if (e.key === "Escape") setEditingName(null); }} />
                </div>
              ) : (
                <button type="button" className="vp-crumb-chip vp-crumb-chip--variant"
                  onClick={() => setOpenMenu((m) => m === "variant" ? null : "variant")}
                  title={selectedVariant?.name || "Select variant"}>
                  <span className="vp-crumb-chip-label">Variant</span>
                  {isDirty && <span className="vp-crumb-dirty" />}
                  <span className="vp-crumb-chip-value">{selectedVariant?.name || "None"}</span>
                  {selectedVariant?.isBase && <span className="vp-crumb-tag">base</span>}
                  <ChevronDown className="vp-crumb-chip-chevron" />
                </button>
              )}
              {openMenu === "variant" && (
                <div className="vp-dropdown-menu vp-dropdown-menu--crumb vp-dropdown-menu--variant">
                  <button type="button" className="vp-dropdown-item" onClick={() => { handleStartRename(selectedVariantId); setOpenMenu(null); }}>
                    <Pencil className="w-3 h-3" /> Rename
                  </button>
                  <button type="button" className="vp-dropdown-item" onClick={() => { handleDuplicateVariant(selectedVariantId); setOpenMenu(null); }}>
                    <Copy className="w-3 h-3" /> Duplicate
                  </button>
                  {variants.length > 1 && <div className="vp-dropdown-sep" />}
                  {variants.length > 1 && variants.map((v) => (
                    <button key={v.id} type="button" className={`vp-dropdown-item ${v.id === selectedVariantId ? "is-active" : ""}`}
                      onClick={() => { setSelectedVariantId(v.id); setOpenMenu(null); }}>
                      <span className={`vp-variant-dot vp-variant-dot--${variantStatuses[v.id] || "ok"}`} style={{ width: 5, height: 5, borderRadius: "50%", flexShrink: 0 }} />
                      {v.name}{v.isBase ? " (base)" : ""}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </nav>

          {/* RIGHT ZONE: View toggles + Size + Status + Export — unified strip */}
          <div className="ctx-bar-right">
            {/* View toggles */}
            <div className="vp-view-toggles">
              {modelPath && (
                <button type="button" className={`vp-wf-toggle ${!viewerCollapsed ? "is-active" : ""}`} onClick={() => setViewerCollapsed((c) => !c)} title="Toggle 3D viewer">
                  <Box className="w-2.5 h-2.5" /><span>3D</span>
                </button>
              )}
              {psdPath && (
                <button type="button" className={`vp-wf-toggle ${!previewCollapsed ? "is-active" : ""}`} onClick={() => setPreviewCollapsed((c) => !c)} title="Toggle texture">
                  <FileImage className="w-2.5 h-2.5" /><span>Tex</span>
                </button>
              )}
              <button type="button" className={`vp-wf-toggle ${inspectorOpen ? "is-active" : ""}`} onClick={() => setInspectorOpen((o) => !o)} title="Toggle layers (Ctrl+\)">
                <Layers className="w-2.5 h-2.5" /><span>Layers</span>
              </button>
            </div>
            <div className="ctx-bar-sep" />
            {/* Resolution selector */}
            <div className="vp-sizes vp-segmented">
              {DEFAULT_SIZES.map((s) => (
                <button key={s.value} type="button" className={`vp-size ${exportSize === s.value ? "is-active" : ""}`} onClick={() => setExportSize(s.value)}>{s.label}</button>
              ))}
            </div>
            <div className="ctx-bar-sep" />
            {showSavedToast && <span className="vp-toast">Saved</span>}
            {!exporting && statusChip && (
              <button type="button" className={`vp-status-chip vp-status-chip--${statusChip.type}`}
                title={validationStatus.issues.map((i) => i.msg).join("\n") || undefined}
                onClick={statusChip.type === "error" || statusChip.type === "warn" ? () => { setInspectorOpen(true); setActivePanel("layers"); } : undefined}>
                {statusChip.type === "ok" && <Check className="w-2.5 h-2.5" />}
                {statusChip.type === "warn" && <AlertTriangle className="w-2.5 h-2.5" />}
                {statusChip.type === "error" && <FileWarning className="w-2.5 h-2.5" />}
                {statusChip.type === "dirty" && <span className="vp-chip-dot" />}
                <span>{statusChip.label}</span>
              </button>
            )}
            <button type="button" className={`vp-wf-save ${isDirty ? "is-dirty" : ""}`} onClick={handleSave} title="Save (Ctrl+S)"><Save className="w-3 h-3" /></button>
            {exporting ? (
              <div className="vp-export-progress"><div className="vp-export-bar" style={{ width: `${exportProgress}%` }} /><span className="vp-export-pct">{Math.round(exportProgress)}%</span></div>
            ) : (
              <div className="vp-cmd-export" ref={exportMenuRef}>
                <button type="button" className="vp-cmd-export-btn" onClick={() => handleExport("all")} disabled={!psdPath || !outputFolder || variants.length === 0}>
                  <Download className="w-3 h-3" /><span>Export</span>
                </button>
                <button type="button" className="vp-cmd-export-arrow" onClick={() => setShowExportMenu((s) => !s)} disabled={!psdPath || !outputFolder}>
                  <ChevronDown className="w-2.5 h-2.5" />
                </button>
                {showExportMenu && (
                  <div className="vp-dropdown-menu vp-dropdown-menu--export">
                    <button type="button" className="vp-dropdown-item" onClick={() => { handleExport("current"); setShowExportMenu(false); }}>Export current variant</button>
                    {selectedVariantIds.size > 0 && (
                      <button type="button" className="vp-dropdown-item" onClick={() => { handleExport("selected"); setShowExportMenu(false); }}>Export selected ({selectedVariantIds.size})</button>
                    )}
                    <button type="button" className="vp-dropdown-item" onClick={() => { handleExport("all"); setShowExportMenu(false); }}>Export all ({variants.length})</button>
                    <div className="vp-dropdown-sep" />
                    <button type="button" className="vp-dropdown-item" onClick={async () => { await handleExport("all"); setShowExportMenu(false); if (outputFolder && isTauriRuntime) await openFolderPath(outputFolder); }}>Export all + open folder</button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>,
        contextBarTarget
      )}

      {/* ── Main Workspace ── */}
      <div className="vp-workspace">

        {/* ── Left Sidebar: Variants ── */}
        <motion.div
          style={{ overflow: "hidden", flexShrink: 0, display: "flex" }}
          animate={{ width: sidebarOpen ? 260 : 28 }}
          transition={{ type: "spring", stiffness: 380, damping: 38, mass: 0.8 }}
        >
          <AnimatePresence mode="wait" initial={false}>
            {sidebarOpen ? (
              <motion.div
                key="sidebar-open"
                className="vp-sidebar"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.1 }}
              >
            <div className="vp-sidebar-head">
              <span className="vp-sidebar-title">Variants</span>
              <span className="vp-sidebar-count">{variants.length}</span>
              <div className="vp-sidebar-head-actions">
                <button type="button" className="vp-sidebar-act" onClick={handleAddVariant} title="Add variant"><Plus className="w-3 h-3" /></button>
                <button type="button" className="vp-sidebar-act" onClick={() => handleDuplicateVariant(selectedVariantId)} disabled={!selectedVariant} title="Duplicate variant"><Copy className="w-3 h-3" /></button>
              </div>
              <button type="button" className="vp-sidebar-collapse" onClick={() => setSidebarOpen(false)} title="Collapse (Ctrl+B)"><PanelLeftOpen className="w-3.5 h-3.5" /></button>
            </div>
            <Ctx.Root><Ctx.Trigger>
              <div className="vp-sidebar-list">
                {variants.map((v) => {
                  const vs = variantStatuses[v.id] || "ok";
                  return (
                    <Ctx.Root key={v.id}><Ctx.Trigger>
                      <div className={`vp-sidebar-item ${selectedVariantId === v.id ? "is-active" : ""}`} onClick={() => setSelectedVariantId(v.id)} onDoubleClick={() => handleStartRename(v.id)}>
                        <span className={`vp-variant-dot vp-variant-dot--${vs}`} />
                        {v.isBase && <span className="vp-badge">BASE</span>}
                        {editingName === v.id
                          ? <input ref={editNameRef} type="text" className="vp-rename-input" defaultValue={v.name} autoFocus
                              onBlur={(e) => handleFinishRename(v.id, e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter") handleFinishRename(v.id, e.target.value); if (e.key === "Escape") setEditingName(null); }}
                              onClick={(e) => e.stopPropagation()} />
                          : <span className="vp-sidebar-name">{v.name}</span>}
                        <div className="vp-sidebar-actions">
                          <button type="button" className="vp-sidebar-act" onClick={(e) => { e.stopPropagation(); handleStartRename(v.id); }} title="Rename"><Pencil className="w-2.5 h-2.5" /></button>
                          <button type="button" className="vp-sidebar-act" onClick={(e) => { e.stopPropagation(); handleDuplicateVariant(v.id); }} title="Duplicate"><Copy className="w-2.5 h-2.5" /></button>
                          {!v.isBase && (
                            <button type="button" className="vp-sidebar-act vp-sidebar-act--danger" onClick={(e) => { e.stopPropagation(); handleDeleteVariant(v.id); }} title="Delete"><Trash2 className="w-2.5 h-2.5" /></button>
                          )}
                        </div>
                      </div>
                    </Ctx.Trigger><Ctx.Content>
                      <Ctx.Item onSelect={() => handleStartRename(v.id)}><Pencil className="w-3 h-3" /> Rename</Ctx.Item>
                      <Ctx.Item onSelect={() => handleDuplicateVariant(v.id)}><Copy className="w-3 h-3" /> Duplicate</Ctx.Item>
                      {!v.isBase && <><Ctx.Separator /><Ctx.Item onSelect={() => handleDeleteVariant(v.id)} destructive><Trash2 className="w-3 h-3" /> Delete</Ctx.Item></>}
                    </Ctx.Content></Ctx.Root>
                  );
                })}
              </div>
            </Ctx.Trigger><Ctx.Content><Ctx.Item onSelect={handleAddVariant}><Plus className="w-3 h-3" /> Add Variant</Ctx.Item></Ctx.Content></Ctx.Root>
            <div className="vp-sidebar-foot">
              <button type="button" className="vp-add-btn" onClick={handleAddVariant}><Plus className="w-3 h-3" /><span>Add Variant</span></button>
              {selectedVariant && !selectedVariant.isBase && (
                <button type="button" className="vp-del-btn" onClick={() => handleDeleteVariant(selectedVariantId)}><Trash2 className="w-3 h-3" /></button>
              )}
            </div>
            {variants.length > 1 && (
              <div className="vp-sidebar-batch">
                <button type="button" className="vp-batch-btn" onClick={() => handleExport("all")} disabled={!psdPath || !outputFolder}>
                  <Download className="w-3 h-3" /><span>Export all</span>
                </button>
              </div>
            )}
              </motion.div>
            ) : (
              <motion.button
                key="sidebar-collapsed"
                type="button"
                className="vp-sidebar-expand"
                onClick={() => setSidebarOpen(true)}
                title="Show sidebar (Ctrl+B)"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.1 }}
              >
                <Palette className="w-3.5 h-3.5 vp-collpanel-icon" />
                <span className="vp-collpanel-label">Variants</span>
              </motion.button>
            )}
          </AnimatePresence>
        </motion.div>

        {/* ── Center Canvas + Legacy Bottom Layers ── */}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div className="vp-canvas">
          {!hasContent ? (
            /* Empty state */
            <div className="vp-empty-state">
              <div className="vp-empty-graphic">
                <div className="vp-empty-icon-ring">
                  <FileImage className="w-10 h-10" strokeWidth={1.2} />
                </div>
              </div>
              <div className="vp-empty-title">Start Building</div>
              <div className="vp-empty-desc">Use the breadcrumbs above or click a button below to load your assets.</div>
              <div className="vp-empty-actions">
                <button type="button" className="vp-empty-btn" onClick={handleSelectModel}>
                  <Car className="w-4 h-4" /><span>Vehicle</span>
                </button>
                <button type="button" className="vp-empty-btn vp-empty-btn--primary" onClick={handleSelectPsd}>
                  <FileImage className="w-4 h-4" /><span>Template</span>
                </button>
                <button type="button" className="vp-empty-btn" onClick={handleSelectOutput}>
                  <FolderOpen className="w-4 h-4" /><span>Output</span>
                </button>
              </div>
              <div className="vp-empty-drop">
                <Upload className="w-3 h-3" /><span>or drop files here</span>
              </div>
            </div>
          ) : (
            /* Canvas views */
            <div className="vp-canvas-views">
              {/* 3D Viewer */}
              {!viewerCollapsed && modelPath && (
                <div className={`vp-viewer-pane ${activePanel === "viewer" ? "is-focused" : ""}`}
                  style={{ width: previewCollapsed || !psdPath ? "100%" : `${viewerPanelWidth}%` }}
                  onClick={() => setActivePanel("viewer")}>
                  <div className="vp-pane-label">
                    <Car className="w-3 h-3" /><span>3D Preview</span>
                    {liveryTarget && <span className="vp-pane-target">{liveryTarget.replace("material:", "")}</span>}
                  </div>
                  <div className="vp-camera-bar">
                    {CAMERA_PRESETS.map((cp) => (
                      <button key={cp.key} type="button" className="vp-camera-btn" onClick={() => handleCameraPreset(cp.key)} title={cp.label}>{cp.label}</button>
                    ))}
                    <button type="button" className="vp-camera-btn vp-camera-btn--reset" onClick={handleCameraReset} title="Reset"><RotateCcw className="w-2.5 h-2.5" /></button>
                    <div className="vp-camera-sep" />
                    <button type="button" className={`vp-camera-btn ${turntableActive ? "is-active" : ""}`} onClick={() => setTurntableActive((t) => !t)} title="Turntable">
                      {turntableActive ? <Pause className="w-2.5 h-2.5" /> : <Play className="w-2.5 h-2.5" />}
                    </button>
                    <div className="vp-camera-sep" />
                    <div className="vp-light-dropdown" ref={lightMenuRef}>
                      <button type="button" className="vp-camera-btn" onClick={(e) => { e.stopPropagation(); setShowLightMenu((s) => !s); }} title="Lighting">
                        <Sun className="w-2.5 h-2.5" /><span>{currentLighting.label}</span>
                      </button>
                      {showLightMenu && (
                        <div className="vp-dropdown-menu">
                          {LIGHTING_PRESETS.map((lp) => (
                            <button key={lp.key} type="button" className={`vp-dropdown-item ${lightingPreset === lp.key ? "is-active" : ""}`}
                              onClick={() => { setLightingPreset(lp.key); setShowLightMenu(false); }}>{lp.label}</button>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="vp-camera-sep" />
                    <button type="button" className={`vp-camera-btn ${showWireframe ? "is-active" : ""}`} onClick={() => setShowWireframe((w) => !w)} title="Wireframe"><Box className="w-2.5 h-2.5" /></button>
                  </div>
                  <Viewer modelPath={modelPath} texturePath={viewerTexturePath} textureReloadToken={previewToken} textureTarget={viewerTextureTarget}
                    textureMode="livery" windowTexturePath="" windowTextureTarget="none" windowTextureReloadToken={0}
                    bodyColor="#e7ebf0" backgroundColor="#111214" lightIntensity={currentLighting.intensity} glossiness={0.5}
                    showGrid={false} showWireframe={showWireframe} wasdEnabled={false}
                    isActive={isActive}
                    onReady={handleViewerReady} onModelInfo={handleModelInfo}
                    onTextureReload={NOOP} onTextureError={NOOP} onWindowTextureError={NOOP} onModelError={NOOP} onModelLoading={NOOP} onFormatWarning={NOOP} />
                </div>
              )}

              {!viewerCollapsed && !previewCollapsed && modelPath && psdPath && <HResizer onResize={handleHResize} />}

              {/* 2D Texture */}
              {!previewCollapsed && psdPath && (
                <div className={`vp-texture-pane ${activePanel === "texture" ? "is-focused" : ""}`}
                  style={{ width: (!modelPath || viewerCollapsed) ? "100%" : `${100 - viewerPanelWidth}%` }}
                  onClick={() => setActivePanel("texture")}>
                  <div className="vp-pane-label">
                    <FileImage className="w-3 h-3" /><span>Livery Texture</span>
                    {psdData && <span className="vp-pane-dim">{psdData.width}&times;{psdData.height}</span>}
                  </div>
                  <div className="vp-uv-toolbar">
                    <button type="button" className="vp-uv-btn" onClick={handleUvZoomFit} title="Fit (F)"><Maximize2 className="w-2.5 h-2.5" /><span>Fit</span></button>
                    <button type="button" className="vp-uv-btn" onClick={() => setUvZoom(1)} title="100%">100%</button>
                    <button type="button" className="vp-uv-btn" onClick={() => setUvZoom((z) => Math.min(10, z * 1.25))} title="Zoom in"><ZoomIn className="w-2.5 h-2.5" /></button>
                    <button type="button" className="vp-uv-btn" onClick={() => setUvZoom((z) => Math.max(0.1, z * 0.8))} title="Zoom out"><ZoomOut className="w-2.5 h-2.5" /></button>
                    <div className="vp-uv-sep" />
                    <button type="button" className={`vp-uv-btn ${showGrid ? "is-active" : ""}`} onClick={() => setShowGrid((g) => !g)} title="Grid"><Grid3x3 className="w-2.5 h-2.5" /></button>
                    <button type="button" className={`vp-uv-btn ${showChecker ? "is-active" : ""}`} onClick={() => setShowChecker((c) => !c)} title="Checker"><SquareDashedBottom className="w-2.5 h-2.5" /></button>
                    <button type="button" className={`vp-uv-btn ${showSafeArea ? "is-active" : ""}`} onClick={() => setShowSafeArea((s) => !s)} title="Safe area"><Monitor className="w-2.5 h-2.5" /></button>
                    <div className="vp-uv-sep" />
                    <span className="vp-uv-zoom-label">{Math.round(uvZoom * 100)}%</span>
                    {uvHover && <span className="vp-uv-readout">{uvHover.px},{uvHover.py}</span>}
                  </div>
                  <div className={`vp-texture-view ${showChecker ? "vp-texture-view--checker" : ""} ${showGrid ? "vp-texture-view--grid" : ""}`}
                    ref={uvContainerRef} onWheel={handleUvWheel} onPointerDown={handleUvPointerDown} onPointerMove={handleUvPointerMove} onPointerUp={handleUvPointerUp}>
                    {previewUrl ? (
                      <div className="vp-uv-canvas" style={{ transform: `translate(${uvPan.x}px, ${uvPan.y}px) scale(${uvZoom})`, transformOrigin: "center center" }}>
                        <img ref={uvImgRef} src={previewUrl} alt="Variant preview" className="vp-texture-img" draggable={false} />
                        {showSafeArea && <div className="vp-safe-area-overlay" />}
                      </div>
                    ) : psdLoading ? (
                      <div className="vp-placeholder"><div className="vp-spinner" /><span>Parsing layer source...</span></div>
                    ) : psdError ? (
                      <div className="vp-placeholder vp-placeholder--error"><AlertTriangle className="w-5 h-5" /><span>{psdError}</span></div>
                    ) : (
                      <div className="vp-placeholder"><Eye className="w-5 h-5 opacity-30" /><span>Generating preview...</span></div>
                    )}
                  </div>
                </div>
              )}

              {/* Both hidden */}
              {viewerCollapsed && previewCollapsed && (
                <div className="vp-empty-state vp-empty-state--compact">
                  <span className="vp-empty-desc">All preview panels hidden</span>
                  <span className="vp-empty-desc" style={{ opacity: 0.4 }}>Use the View toggles in the workflow bar</span>
                </div>
              )}
            </div>
          )}
        </div>

          {/* ── Legacy Bottom Layers Panel ── */}
          {legacyLayersLayout && hasLayers && (
            <>
              {inspectorOpen && <VResizer onResize={handleVResize} />}
              <div className="vp-legacy-layers" style={{ height: inspectorOpen ? legacyLayersHeight : 28, flexShrink: 0 }}>
                {!inspectorOpen ? (
                  <button type="button" className="vp-legacy-layers-expand" onClick={() => setInspectorOpen(true)}>
                    <Layers className="w-3.5 h-3.5 vp-collpanel-icon" />
                    <span className="vp-collpanel-label">Layers</span>
                  </button>
                ) : (
                  <div className={`vp-inspector ${activePanel === "layers" ? "is-focused" : ""}`} onClick={() => setActivePanel("layers")}>
                    {renderLayersContent()}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* ── Right Panel: Layers Inspector ── */}
        {hasLayers && (
          <motion.div
            style={{ overflow: "hidden", flexShrink: 0, display: "flex" }}
            animate={{ width: legacyLayersLayout ? 0 : (inspectorOpen ? 320 : 28) }}
            transition={{ type: "spring", stiffness: 380, damping: 38, mass: 0.8 }}
          >
            <AnimatePresence mode="wait" initial={false}>
              {!inspectorOpen ? (
                <motion.button
                  key="inspector-collapsed"
                  type="button"
                  className="vp-inspector-expand"
                  onClick={() => setInspectorOpen(true)}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.1 }}
                >
                  <Layers className="w-3.5 h-3.5 vp-collpanel-icon" />
                  <span className="vp-collpanel-label">Layers</span>
                </motion.button>
              ) : (
                <motion.div
                  key="inspector-open"
                  className={`vp-inspector ${activePanel === "layers" ? "is-focused" : ""}`}
                  onClick={() => setActivePanel("layers")}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.1 }}
                >
                  {renderLayersContent()}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </div>

      {/* ── Footer ── */}
      <div className="vp-footer">
        <div className="vp-footer-left">
          {psdData && (
            <span className="vp-footer-summary">
              {exportSummary.visibleCount} layers &middot; {exportSize}&sup2; &middot; {exportSummary.format} &middot; {variants.length} variant{variants.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        <div className="vp-footer-right">
          {activePanel && <span className="vp-footer-panel-hint"><span className="vp-footer-panel-active">{activePanel === "viewer" ? "3D" : activePanel === "texture" ? "Texture" : "Layers"}</span></span>}
          <span className="vp-footer-hint"><kbd>Tab</kbd> cycle panels</span>
          <span className="vp-footer-hint"><kbd>Ctrl+B</kbd> sidebar</span>
          <span className="vp-footer-hint"><kbd>Ctrl+S</kbd> save</span>
          <span className="vp-footer-hint"><kbd>Ctrl+E</kbd> export</span>
        </div>
      </div>
    </div>
  );
}
