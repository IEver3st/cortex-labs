import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import {
  FileImage, Plus, Trash2, Download, Lock, Copy, Car,
  Eye, FolderOpen, Check, Pencil,
  ChevronRight, ChevronDown, Layers, AlertTriangle,
  PanelBottomOpen, PanelRightOpen, PanelLeftOpen,
} from "lucide-react";
import { parsePsdLayers, compositePsdVariant } from "../lib/psd-layers";
import * as Ctx from "./ContextMenu";
import Viewer from "./Viewer";

const DEFAULT_SIZES = [
  { label: "4096", value: 4096 },
  { label: "2048", value: 2048 },
  { label: "1024", value: 1024 },
  { label: "512", value: 512 },
];

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function buildDefaultVisibility(data) {
  const vis = {};
  for (const layer of data?.allLayers || []) {
    vis[layer.id] = layer.visible;
  }
  return vis;
}

function buildVisibilityFromLegacy(variant, data, fallback) {
  if (!variant || !data) return fallback || {};
  const vis = { ...(fallback || {}) };
  const toggleable = variant.toggleable || {};
  const variantSelections = variant.variantSelections || {};

  for (const layer of data.allLayers || []) {
    if (Object.prototype.hasOwnProperty.call(toggleable, layer.name)) {
      vis[layer.id] = toggleable[layer.name];
    }
  }

  for (const group of data.variantGroups || []) {
    const selectedIdx = variantSelections[group.name] ?? 0;
    for (let j = 0; j < group.options.length; j++) {
      const option = group.options[j];
      const enabled = j === selectedIdx;
      for (const layer of data.allLayers || []) {
        if (layer.name === option.name) vis[layer.id] = enabled;
      }
    }
  }

  return vis;
}

/* ─── Resizable split handle (horizontal) ─── */
function HResizer({ onResize }) {
  const dragging = useRef(false);
  const startX = useRef(0);

  const onPointerDown = useCallback((e) => {
    dragging.current = true;
    startX.current = e.clientX;
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const onPointerMove = useCallback((e) => {
    if (!dragging.current) return;
    const dx = e.clientX - startX.current;
    startX.current = e.clientX;
    onResize(dx);
  }, [onResize]);

  const onPointerUp = useCallback(() => {
    dragging.current = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  return (
    <div
      className="vp-resizer vp-resizer--h"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div className="vp-resizer-grip" />
    </div>
  );
}

/* ─── Resizable split handle (vertical — for layer panel) ─── */
function VResizer({ onResize }) {
  const dragging = useRef(false);
  const startY = useRef(0);

  const onPointerDown = useCallback((e) => {
    dragging.current = true;
    startY.current = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }, []);

  const onPointerMove = useCallback((e) => {
    if (!dragging.current) return;
    const dy = e.clientY - startY.current;
    startY.current = e.clientY;
    onResize(dy);
  }, [onResize]);

  const onPointerUp = useCallback(() => {
    dragging.current = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  return (
    <div
      className="vp-layer-resizer"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  );
}

/**
 * VariantsPage — PSD Variant Builder
 * IDE-style layout: [Sidebar | 3D Preview | 2D Preview] / [Layer Panel] / [Footer]
 */
export default function VariantsPage({ workspaceState, onStateChange, onRenameTab }) {
  // PSD state
  const [psdPath, setPsdPath] = useState(workspaceState?.psdPath || "");
  const [psdData, setPsdData] = useState(null);
  const [psdLoading, setPsdLoading] = useState(false);
  const [psdError, setPsdError] = useState("");

  // Variants
  const [variants, setVariants] = useState(workspaceState?.variants || [
    { id: generateId(), name: "Base", isBase: true, toggleable: {}, variantSelections: {}, locked: true }
  ]);
  const [selectedVariantId, setSelectedVariantId] = useState(
    workspaceState?.selectedVariantId || variants[0]?.id || ""
  );
  const [editingName, setEditingName] = useState(null);
  const editNameRef = useRef(null);

  // Export settings
  const [exportSize, setExportSize] = useState(workspaceState?.exportSize || 4096);
  const [outputFolder, setOutputFolder] = useState(workspaceState?.outputFolder || "");
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);

  // Model preview (3D)
  const [modelPath, setModelPath] = useState(workspaceState?.modelPath || "");
  const [viewerReady, setViewerReady] = useState(false);
  const [liveryTarget, setLiveryTarget] = useState("");
  const [liveryTargetReady, setLiveryTargetReady] = useState(false);
  const viewerApiRef = useRef(null);

  // Composited preview
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewToken, setPreviewToken] = useState(0);

  // Layer visibility — keyed by layer path ID
  const [layerVisibility, setLayerVisibility] = useState({});
  const [collapsedGroups, setCollapsedGroups] = useState(new Set());

  // Panel layout
  const [viewerPanelWidth, setViewerPanelWidth] = useState(55); // percentage
  const [layerPanelHeight, setLayerPanelHeight] = useState(220); // pixels
  const [layerPanelHidden, setLayerPanelHidden] = useState(false);
  const [viewerCollapsed, setViewerCollapsed] = useState(false);
  const [previewCollapsed, setPreviewCollapsed] = useState(false);

  const containerRef = useRef(null);

  const isTauriRuntime =
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__ !== "undefined";

  const selectedVariant = variants.find((v) => v.id === selectedVariantId) || variants[0];
  const selectedVariantIdRef = useRef(selectedVariantId);

  useEffect(() => {
    selectedVariantIdRef.current = selectedVariantId;
  }, [selectedVariantId]);

  // Persist state
  useEffect(() => {
    if (onStateChange) {
      onStateChange({ psdPath, modelPath, variants, selectedVariantId, exportSize, outputFolder });
    }
  }, [psdPath, modelPath, variants, selectedVariantId, exportSize, outputFolder]);

  // Load PSD
  useEffect(() => {
    if (!psdPath) { setPsdData(null); setLayerVisibility({}); return; }
    let cancelled = false;
    setPsdLoading(true);
    setPsdError("");

    parsePsdLayers(psdPath)
      .then((data) => {
        if (cancelled) return;
        setPsdData(data);
        setPsdError("");
        setLayerVisibility(buildDefaultVisibility(data));
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to parse PSD:", err);
        if (err?.type === "unsupported-bit-depth") {
          setPsdError(`${err.bitDepth}-bit PSD is not supported. Please export as 8-bit PSD.`);
        } else {
          setPsdError("Failed to parse PSD. Make sure it's a valid Photoshop file.");
        }
        setPsdData(null);
      })
      .finally(() => {
        if (!cancelled) setPsdLoading(false);
      });

    return () => { cancelled = true; };
  }, [psdPath]);

  // Pass path-based IDs directly — the compositor now supports path matching
  const compositorVisibility = useMemo(() => {
    return { ...layerVisibility };
  }, [layerVisibility]);

  const visibilityKey = JSON.stringify(compositorVisibility);

  // Auto-generate preview when layer visibility or PSD changes
  useEffect(() => {
    if (!psdPath || !psdData) return;
    let cancelled = false;

    const generate = async () => {
      try {
        const maxDim = Math.max(psdData.width || 0, psdData.height || 0) || exportSize;
        const targetMax = Math.min(exportSize, maxDim);
        const scale = Math.min(1, targetMax / maxDim);
        const previewW = Math.max(1, Math.round((psdData.width || maxDim) * scale));
        const previewH = Math.max(1, Math.round((psdData.height || maxDim) * scale));
        const canvas = await compositePsdVariant(psdPath, compositorVisibility, previewW, previewH);
        if (cancelled) return;
        setPreviewUrl(canvas.toDataURL());
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to composite PSD:", err);
        if (err?.type === "unsupported-bit-depth") {
          setPsdError(`${err.bitDepth}-bit PSD is not supported.`);
        }
      }
    };

    // Debounce preview generation
    const timer = setTimeout(generate, 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [psdPath, psdData, visibilityKey, exportSize, compositorVisibility]);

  useEffect(() => {
    if (!psdData || !selectedVariantId) return;
    const selected = variants.find((v) => v.id === selectedVariantId);
    const defaultVisibility = buildDefaultVisibility(psdData);
    const nextVisibility = selected?.layerVisibility && Object.keys(selected.layerVisibility).length > 0
      ? selected.layerVisibility
      : buildVisibilityFromLegacy(selected, psdData, defaultVisibility);
    setLayerVisibility(nextVisibility);
  }, [selectedVariantId, psdData]);

  useEffect(() => {
    const id = selectedVariantIdRef.current;
    if (!id) return;
    setVariants((prev) => prev.map((v) => (
      v.id === id
        ? { ...v, layerVisibility: { ...layerVisibility } }
        : v
    )));
  }, [layerVisibility]);

  // File selectors
  const handleSelectPsd = useCallback(async () => {
    if (!isTauriRuntime) return;
    try {
      const selected = await open({ filters: [{ name: "Photoshop", extensions: ["psd"] }] });
      if (typeof selected === "string") {
        setPsdPath(selected);
        const name = selected.split(/[\\/]/).pop();
        if (name && onRenameTab) onRenameTab(name);
      }
    } catch {}
  }, [isTauriRuntime, onRenameTab]);

  const handleSelectModel = useCallback(async () => {
    if (!isTauriRuntime) return;
    try {
      const selected = await open({ filters: [{ name: "Vehicle Model", extensions: ["yft", "ydd"] }] });
      if (typeof selected === "string") setModelPath(selected);
    } catch {}
  }, [isTauriRuntime]);

  const handleSelectOutput = useCallback(async () => {
    if (!isTauriRuntime) return;
    try {
      const selected = await open({ directory: true });
      if (typeof selected === "string") setOutputFolder(selected);
    } catch {}
  }, [isTauriRuntime]);

  // Variant operations
  const handleAddVariant = useCallback(() => {
    const base = variants.find((v) => v.isBase);
    const baseVisibility = base?.layerVisibility && Object.keys(base.layerVisibility).length > 0
      ? base.layerVisibility
      : { ...layerVisibility };
    const nv = {
      id: generateId(),
      name: `Variant ${variants.length}`,
      isBase: false,
      toggleable: base ? { ...base.toggleable } : {},
      variantSelections: base ? { ...base.variantSelections } : {},
      layerVisibility: { ...baseVisibility },
      locked: false,
    };
    setVariants((prev) => [...prev, nv]);
    setSelectedVariantId(nv.id);
  }, [variants]);

  const handleDeleteVariant = useCallback((id) => {
    setVariants((prev) => {
      const filtered = prev.filter((v) => v.id !== id);
      if (selectedVariantId === id && filtered.length > 0) setSelectedVariantId(filtered[0].id);
      return filtered;
    });
  }, [selectedVariantId]);

  const handleDuplicateVariant = useCallback((id) => {
    const source = variants.find((v) => v.id === id);
    if (!source) return;
    const dup = {
      ...source,
      id: generateId(),
      name: `${source.name} Copy`,
      isBase: false,
      locked: false,
      layerVisibility: { ...(source.layerVisibility || {}) },
    };
    setVariants((prev) => [...prev, dup]);
    setSelectedVariantId(dup.id);
  }, [variants]);

  const handleStartRename = useCallback((id) => {
    setEditingName(id);
    setTimeout(() => editNameRef.current?.select(), 50);
  }, []);

  const handleFinishRename = useCallback((id, name) => {
    setVariants((prev) => prev.map((v) => (v.id === id ? { ...v, name: name || v.name } : v)));
    setEditingName(null);
  }, []);

  // Toggle a layer by its path-based ID
  const handleToggleLayerById = useCallback((layerId) => {
    setLayerVisibility((prev) => ({
      ...prev,
      [layerId]: !prev[layerId],
    }));
  }, []);

  // Toggle a group's collapsed state
  const handleToggleGroupCollapse = useCallback((groupId) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  // Enable all children of a group
  const handleEnableAllInGroup = useCallback((groupId) => {
    if (!psdData?.allLayers) return;
    const group = psdData.allLayers.find((l) => l.id === groupId);
    if (!group) return;
    setLayerVisibility((prev) => {
      const next = { ...prev };
      for (const childId of group.childIds) {
        next[childId] = true;
      }
      return next;
    });
  }, [psdData]);

  // Disable all children of a group
  const handleDisableAllInGroup = useCallback((groupId) => {
    if (!psdData?.allLayers) return;
    const group = psdData.allLayers.find((l) => l.id === groupId);
    if (!group) return;
    setLayerVisibility((prev) => {
      const next = { ...prev };
      for (const childId of group.childIds) {
        next[childId] = false;
      }
      return next;
    });
  }, [psdData]);

  // Solo a layer (enable only this one, disable siblings)
  const handleSoloLayer = useCallback((layerId) => {
    if (!psdData?.allLayers) return;
    const layer = psdData.allLayers.find((l) => l.id === layerId);
    if (!layer || !layer.parentId) return;
    const parent = psdData.allLayers.find((l) => l.id === layer.parentId);
    if (!parent) return;
    setLayerVisibility((prev) => {
      const next = { ...prev };
      for (const siblingId of parent.childIds) {
        next[siblingId] = siblingId === layerId;
      }
      return next;
    });
  }, [psdData]);

  // Legacy handlers kept for backward compat with export
  const handleToggleLayer = useCallback((layerName) => {
    setVariants((prev) =>
      prev.map((v) => {
        if (v.id !== selectedVariantId) return v;
        return { ...v, toggleable: { ...v.toggleable, [layerName]: !v.toggleable[layerName] } };
      })
    );
  }, [selectedVariantId]);

  const handleSelectVariantOption = useCallback((groupName, optionIndex) => {
    setVariants((prev) =>
      prev.map((v) => {
        if (v.id !== selectedVariantId) return v;
        return { ...v, variantSelections: { ...v.variantSelections, [groupName]: optionIndex } };
      })
    );
  }, [selectedVariantId]);

  // Export all — uses current layer visibility for the active variant
  const handleExportAll = useCallback(async () => {
    if (!psdPath || !psdData || !outputFolder) return;
    setExporting(true);
    setExportProgress(0);
    try {
      for (let i = 0; i < variants.length; i++) {
        const variant = variants[i];
        // For the currently selected variant, use the live layer panel state
        // For other variants, fall back to legacy toggleable/variantSelections
        let visibility;
        if (variant.id === selectedVariantId) {
          visibility = { ...compositorVisibility };
        } else if (variant.layerVisibility && Object.keys(variant.layerVisibility).length > 0) {
          visibility = { ...variant.layerVisibility };
        } else {
          visibility = {};
          for (const [name, enabled] of Object.entries(variant.toggleable || {})) visibility[name] = enabled;
          for (const group of psdData.variantGroups || []) {
            const selectedIdx = variant.variantSelections?.[group.name] ?? 0;
            for (let j = 0; j < group.options.length; j++) visibility[group.options[j].name] = j === selectedIdx;
          }
          for (const l of psdData.locked || []) visibility[l.name] = true;
        }
        const canvas = await compositePsdVariant(psdPath, visibility, exportSize, exportSize);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
        const arrayBuffer = await blob.arrayBuffer();
        const uint8 = new Uint8Array(arrayBuffer);
        const safeName = variant.name.replace(/[^a-zA-Z0-9_\- ]/g, "_");
        await writeFile(`${outputFolder}/${safeName}.png`, uint8);
        setExportProgress(((i + 1) / variants.length) * 100);
      }
    } catch (err) {
      console.error("Export failed:", err);
    } finally {
      setExporting(false);
    }
  }, [psdPath, psdData, variants, exportSize, outputFolder, selectedVariantId, compositorVisibility]);

  // Resizer handlers
  const handleHResize = useCallback((dx) => {
    if (!containerRef.current) return;
    const w = containerRef.current.getBoundingClientRect().width;
    const sidebarW = 180;
    const available = w - sidebarW;
    if (available <= 0) return;
    setViewerPanelWidth((prev) => {
      const next = prev + (dx / available) * 100;
      return Math.max(20, Math.min(80, next));
    });
  }, []);

  // Layer panel vertical resize
  const handleLayerPanelResize = useCallback((dy) => {
    setLayerPanelHeight((prev) => Math.max(60, Math.min(500, prev - dy)));
  }, []);

  // Model info callback — capture livery target
  const handleModelInfo = useCallback((info) => {
    if (info.liveryTarget) {
      setLiveryTarget(info.liveryTarget);
      setLiveryTargetReady(true);
    } else {
      // No livery target found — still mark as ready so texture can apply with "all"
      setLiveryTargetReady(true);
    }
  }, []);

  // Reset livery target when model changes
  useEffect(() => {
    setLiveryTarget("");
    setLiveryTargetReady(false);
  }, [modelPath]);

  // Only pass texture to viewer once livery target is detected (prevents wrong UV mapping)
  const viewerTexturePath = liveryTargetReady ? (previewUrl || "") : "";
  const viewerTextureTarget = liveryTarget || "all";

  const psdFileName = psdPath ? psdPath.split(/[\\/]/).pop() : "";
  const modelFileName = modelPath ? modelPath.split(/[\\/]/).pop() : "";
  const hasLayers = psdData && (psdData.allLayers?.length > 0);

  // Organize layers into sections for the panel.
  // ag-psd order: children[0]=bottommost, children[last]=topmost.
  // We reverse for display so topmost layers appear first (matching Photoshop).
  const layerSections = useMemo(() => {
    if (!psdData?.allLayers) return { topLevel: [], groups: [], locked: [] };
    const topLevel = [];
    const groups = [];
    const locked = [];
    // Iterate top-level layers in reverse for Photoshop-style display order
    const topLevelLayers = psdData.allLayers.filter((l) => l.depth === 0);
    for (let i = topLevelLayers.length - 1; i >= 0; i--) {
      const layer = topLevelLayers[i];
      if (layer.category === "locked" || layer.category === "base") {
        locked.push(layer);
      } else if (layer.isGroup) {
        groups.push(layer);
      } else {
        topLevel.push(layer);
      }
    }
    return { topLevel, groups, locked };
  }, [psdData]);

  // Helper to get children of a group from allLayers (reversed for Photoshop display order)
  const getGroupChildren = useCallback((groupId) => {
    if (!psdData?.allLayers) return [];
    const group = psdData.allLayers.find((l) => l.id === groupId);
    if (!group) return [];
    const children = group.childIds.map((id) => psdData.allLayers.find((l) => l.id === id)).filter(Boolean);
    return children.slice().reverse();
  }, [psdData]);

  return (
    <div className="vp" ref={containerRef}>

      {/* ─── Toolbar ─── */}
      <div className="vp-toolbar">
        <div className="vp-toolbar-left">
          <button type="button" className="vp-file-btn vp-file-btn--model" onClick={handleSelectModel}>
            <Car className="w-3.5 h-3.5" />
            <span className="vp-file-label">{modelFileName || "Load Vehicle"}</span>
          </button>
          <div className="vp-toolbar-sep" />
          <button type="button" className="vp-file-btn vp-file-btn--psd" onClick={handleSelectPsd}>
            <FileImage className="w-3.5 h-3.5" />
            <span className="vp-file-label">{psdFileName || "Load Livery PSD"}</span>
          </button>
        </div>

        <div className="vp-toolbar-right">
          {modelPath && (
            <button
              type="button"
              className={`vp-panel-toggle ${viewerCollapsed ? "is-off" : ""}`}
              onClick={() => setViewerCollapsed((c) => !c)}
              title={viewerCollapsed ? "Show 3D Preview" : "Hide 3D Preview"}
            >
              <PanelLeftOpen className="w-3 h-3" />
              <span>3D</span>
            </button>
          )}
          {psdPath && (
            <button
              type="button"
              className={`vp-panel-toggle ${previewCollapsed ? "is-off" : ""}`}
              onClick={() => setPreviewCollapsed((c) => !c)}
              title={previewCollapsed ? "Show Texture" : "Hide Texture"}
            >
              <PanelRightOpen className="w-3 h-3" />
              <span>TEX</span>
            </button>
          )}
          {hasLayers && (
            <button
              type="button"
              className={`vp-panel-toggle ${layerPanelHidden ? "is-off" : ""}`}
              onClick={() => setLayerPanelHidden((c) => !c)}
              title={layerPanelHidden ? "Show Layers" : "Hide Layers"}
            >
              <Layers className="w-3 h-3" />
              <span>Layers</span>
            </button>
          )}
        </div>
      </div>

      {/* ─── Main workspace: sidebar + previews + layers ─── */}
      <div className="vp-workspace">

        {/* Sidebar: Variant list */}
        <div className="vp-sidebar">
          <div className="vp-sidebar-head">
            <span className="vp-sidebar-title">Variants</span>
            <span className="vp-sidebar-count">{variants.length}</span>
          </div>

          <Ctx.Root>
            <Ctx.Trigger>
              <div className="vp-sidebar-list">
                {variants.map((v) => (
                  <Ctx.Root key={v.id}>
                    <Ctx.Trigger>
                      <div
                        className={`vp-sidebar-item ${selectedVariantId === v.id ? "is-active" : ""}`}
                        onClick={() => setSelectedVariantId(v.id)}
                        onDoubleClick={() => handleStartRename(v.id)}
                      >
                        {v.isBase && <span className="vp-badge">BASE</span>}
                        {editingName === v.id ? (
                          <input
                            ref={editNameRef}
                            type="text"
                            className="vp-rename-input"
                            defaultValue={v.name}
                            autoFocus
                            onBlur={(e) => handleFinishRename(v.id, e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleFinishRename(v.id, e.target.value);
                              if (e.key === "Escape") setEditingName(null);
                            }}
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : (
                          <span className="vp-sidebar-name">{v.name}</span>
                        )}
                        {selectedVariantId === v.id && editingName !== v.id && (
                          <button
                            type="button"
                            className="vp-sidebar-edit"
                            onClick={(e) => { e.stopPropagation(); handleStartRename(v.id); }}
                            title="Rename"
                          >
                            <Pencil className="w-2.5 h-2.5" />
                          </button>
                        )}
                      </div>
                    </Ctx.Trigger>
                    <Ctx.Content>
                      <Ctx.Item onSelect={() => handleStartRename(v.id)}>
                        <Pencil className="w-3 h-3" /> Rename
                      </Ctx.Item>
                      <Ctx.Item onSelect={() => handleDuplicateVariant(v.id)}>
                        <Copy className="w-3 h-3" /> Duplicate
                      </Ctx.Item>
                      {!v.isBase && (
                        <>
                          <Ctx.Separator />
                          <Ctx.Item onSelect={() => handleDeleteVariant(v.id)} destructive>
                            <Trash2 className="w-3 h-3" /> Delete
                          </Ctx.Item>
                        </>
                      )}
                    </Ctx.Content>
                  </Ctx.Root>
                ))}
              </div>
            </Ctx.Trigger>
            <Ctx.Content>
              <Ctx.Item onSelect={handleAddVariant}>
                <Plus className="w-3 h-3" /> Add Variant
              </Ctx.Item>
            </Ctx.Content>
          </Ctx.Root>

          <div className="vp-sidebar-foot">
            <button type="button" className="vp-add-btn" onClick={handleAddVariant}>
              <Plus className="w-3 h-3" />
              <span>Add</span>
            </button>
            {selectedVariant && !selectedVariant.isBase && (
              <button type="button" className="vp-del-btn" onClick={() => handleDeleteVariant(selectedVariantId)}>
                <Trash2 className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>

        {/* Preview Area: 3D + 2D split */}
        <div className="vp-center">
          <div className="vp-previews">
            {/* 3D Vehicle Viewer */}
            {!viewerCollapsed && modelPath && (
              <div className="vp-viewer-pane" style={{ width: previewCollapsed ? "100%" : `${viewerPanelWidth}%` }}>
                <div className="vp-pane-label">
                  <Car className="w-3 h-3" />
                  <span>Vehicle Preview</span>
                  {liveryTarget && (
                    <span className="vp-pane-target">{liveryTarget.replace("material:", "")}</span>
                  )}
                </div>
                <Viewer
                  modelPath={modelPath}
                  texturePath={viewerTexturePath}
                  textureReloadToken={previewToken}
                  textureTarget={viewerTextureTarget}
                  textureMode="livery"
                  windowTexturePath=""
                  windowTextureTarget="none"
                  windowTextureReloadToken={0}
                  bodyColor="#e7ebf0"
                  backgroundColor="#111214"
                  lightIntensity={1.0}
                  glossiness={0.5}
                  showGrid={false}
                  wasdEnabled={false}
                  onReady={(api) => {
                    viewerApiRef.current = api;
                    setViewerReady(true);
                  }}
                  onModelInfo={handleModelInfo}
                  onTextureReload={() => {}}
                  onTextureError={() => {}}
                  onWindowTextureError={() => {}}
                  onModelError={() => {}}
                  onModelLoading={() => {}}
                  onFormatWarning={() => {}}
                />
              </div>
            )}

            {/* Horizontal resizer between 3D and 2D panels */}
            {!viewerCollapsed && !previewCollapsed && modelPath && psdPath && (
              <HResizer onResize={handleHResize} />
            )}

            {/* 2D Texture Preview */}
            {!previewCollapsed && (psdPath || modelPath) && (
              <div
                className="vp-texture-pane"
                style={{
                  width: (!modelPath || viewerCollapsed)
                    ? "100%"
                    : `${100 - viewerPanelWidth}%`,
                }}
              >
                <div className="vp-pane-label">
                  <FileImage className="w-3 h-3" />
                  <span>Livery Texture</span>
                  {psdData && (
                    <span className="vp-pane-dim">{psdData.width}x{psdData.height}</span>
                  )}
                </div>
                <div className="vp-texture-view">
                  {previewUrl ? (
                    <img src={previewUrl} alt="Variant preview" className="vp-texture-img" />
                  ) : psdLoading ? (
                    <div className="vp-placeholder">
                      <div className="vp-spinner" />
                      <span>Parsing PSD layers...</span>
                    </div>
                  ) : psdError ? (
                    <div className="vp-placeholder vp-placeholder--error">
                      <AlertTriangle className="w-5 h-5" />
                      <span>{psdError}</span>
                    </div>
                  ) : !psdPath ? (
                    <div className="vp-placeholder">
                      <FileImage className="w-8 h-8 opacity-20" />
                      <span>Import a PSD livery file</span>
                    </div>
                  ) : (
                    <div className="vp-placeholder">
                      <Eye className="w-5 h-5 opacity-30" />
                      <span>Generating preview...</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Empty state: no model AND no PSD */}
            {viewerCollapsed && previewCollapsed && (
              <div className="vp-empty-center">
                <div className="vp-placeholder">
                  <span>All preview panels are hidden</span>
                  <span style={{ fontSize: 10, opacity: 0.4 }}>Use the toolbar toggles to show them</span>
                </div>
              </div>
            )}

            {!modelPath && !psdPath && (
              <div className="vp-empty-center">
                <div className="vp-onboard">
                  <div className="vp-onboard-title">Variant Builder</div>
                  <div className="vp-onboard-sub">Load a vehicle model and a PSD livery file to begin building variants.</div>
                  <div className="vp-onboard-actions">
                    <button type="button" className="vp-onboard-btn" onClick={handleSelectModel}>
                      <Car className="w-4 h-4" />
                      <span>Load Vehicle</span>
                    </button>
                    <button type="button" className="vp-onboard-btn vp-onboard-btn--psd" onClick={handleSelectPsd}>
                      <FileImage className="w-4 h-4" />
                      <span>Load PSD</span>
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ─── Layer Panel (vertical resizable) ─── */}
          {hasLayers && !layerPanelHidden && (
            <div className="vp-layer-panel" style={{ height: layerPanelHeight }}>
              <VResizer onResize={handleLayerPanelResize} />
              <div className="vp-layer-panel-head">
                <Layers className="w-3.5 h-3.5" />
                <span>Layers</span>
                <span className="vp-layer-count">{psdData.allLayers?.length || 0}</span>
              </div>
              <div className="vp-layer-panel-body">

                {/* Toggleable layers section */}
                {layerSections.topLevel.length > 0 && (
                  <div className="vp-layer-section">
                    <div className="vp-layer-section-head">
                      <span>Layers</span>
                      <span className="vp-layer-section-count">{layerSections.topLevel.length}</span>
                    </div>
                    {layerSections.topLevel.map((layer) => {
                      const isOn = layerVisibility[layer.id] ?? layer.visible;
                      return (
                        <button
                          key={layer.id}
                          type="button"
                          className={`vp-layer-row ${isOn ? "is-on" : ""}`}
                          onClick={() => handleToggleLayerById(layer.id)}
                        >
                          <div className="vp-layer-check">
                            <Check className="vp-layer-check-icon" />
                          </div>
                          <span className="vp-layer-name">{layer.name}</span>
                          {layer.opacity < 1 && (
                            <span className="vp-layer-opacity">{Math.round(layer.opacity * 100)}%</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Group sections — collapsible with checkbox children */}
                {layerSections.groups.map((group) => {
                  const isCollapsed = collapsedGroups.has(group.id);
                  const children = getGroupChildren(group.id);
                  const enabledCount = children.filter((c) => layerVisibility[c.id] ?? c.visible).length;
                  const allOn = enabledCount === children.length && children.length > 0;
                  const someOn = enabledCount > 0 && !allOn;

                  return (
                    <div key={group.id} className="vp-layer-section">
                      <div className="vp-layer-section-head vp-layer-section-head--group">
                        <button
                          type="button"
                          className="vp-layer-collapse-btn"
                          onClick={() => handleToggleGroupCollapse(group.id)}
                        >
                          {isCollapsed
                            ? <ChevronRight className="w-2.5 h-2.5" />
                            : <ChevronDown className="w-2.5 h-2.5" />
                          }
                        </button>
                        <button
                          type="button"
                          className={`vp-layer-group-check ${allOn ? "is-all" : someOn ? "is-partial" : ""}`}
                          onClick={() => allOn ? handleDisableAllInGroup(group.id) : handleEnableAllInGroup(group.id)}
                          title={allOn ? "Uncheck all" : "Check all"}
                        >
                          {allOn ? (
                            <Check className="vp-layer-group-check-icon" />
                          ) : (
                            <div className="vp-layer-group-check-inner" />
                          )}
                        </button>
                        <span className="vp-layer-section-name">{group.name}</span>
                        <span className="vp-layer-section-count">{enabledCount}/{children.length}</span>
                        <div className="vp-layer-group-actions">
                          <button type="button" className="vp-layer-group-act" onClick={() => handleEnableAllInGroup(group.id)} title="Enable all">All</button>
                          <button type="button" className="vp-layer-group-act" onClick={() => handleDisableAllInGroup(group.id)} title="Disable all">None</button>
                        </div>
                      </div>
                      {!isCollapsed && children.map((child) => {
                        const isOn = layerVisibility[child.id] ?? child.visible;
                        return (
                          <button
                            key={child.id}
                            type="button"
                            className={`vp-layer-row vp-layer-row--child ${isOn ? "is-on" : ""}`}
                            onClick={() => handleToggleLayerById(child.id)}
                            onDoubleClick={() => handleSoloLayer(child.id)}
                            title="Click to toggle, double-click to solo"
                          >
                            <div className="vp-layer-check">
                              <Check className="vp-layer-check-icon" />
                            </div>
                            <span className="vp-layer-name">{child.name}</span>
                            {child.opacity < 1 && (
                              <span className="vp-layer-opacity">{Math.round(child.opacity * 100)}%</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}

                {/* Locked / base layers section */}
                {layerSections.locked.length > 0 && (
                  <div className="vp-layer-section vp-layer-section--locked">
                    <div className="vp-layer-section-head">
                      <Lock className="w-2.5 h-2.5" />
                      <span>Base Layers</span>
                      <span className="vp-layer-section-count">{layerSections.locked.length}</span>
                    </div>
                    {layerSections.locked.map((layer) => {
                      const isOn = layerVisibility[layer.id] ?? layer.visible;
                      return (
                        <button
                          key={layer.id}
                          type="button"
                          className={`vp-layer-row vp-layer-row--locked ${isOn ? "is-on" : ""}`}
                          onClick={() => handleToggleLayerById(layer.id)}
                        >
                          <div className="vp-layer-check">
                            <Check className="vp-layer-check-icon" />
                          </div>
                          <span className="vp-layer-name">{layer.name}</span>
                          <Lock className="w-2.5 h-2.5 vp-layer-lock-icon" />
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ─── Footer: Export controls ─── */}
      <div className="vp-footer">
        <div className="vp-footer-left">
          {selectedVariant && (
            <div className="vp-footer-field">
              <span className="vp-footer-label">Variant</span>
              {editingName === selectedVariantId ? (
                <input
                  type="text"
                  className="vp-footer-name-input"
                  defaultValue={selectedVariant.name}
                  autoFocus
                  onBlur={(e) => handleFinishRename(selectedVariantId, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleFinishRename(selectedVariantId, e.target.value);
                    if (e.key === "Escape") setEditingName(null);
                  }}
                />
              ) : (
                <button type="button" className="vp-footer-name" onClick={() => handleStartRename(selectedVariantId)}>
                  {selectedVariant.name}
                </button>
              )}
            </div>
          )}

          <div className="vp-footer-sep" />

          <div className="vp-footer-field">
            <span className="vp-footer-label">Size</span>
            <div className="vp-sizes">
              {DEFAULT_SIZES.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  className={`vp-size ${exportSize === s.value ? "is-active" : ""}`}
                  onClick={() => setExportSize(s.value)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div className="vp-footer-sep" />

          <div className="vp-footer-field">
            <button type="button" className="vp-folder-btn" onClick={handleSelectOutput}>
              <FolderOpen className="w-3 h-3" />
              <span>{outputFolder ? outputFolder.split(/[\\/]/).pop() : "Output..."}</span>
            </button>
          </div>
        </div>

        <div className="vp-footer-right">
          {exporting ? (
            <div className="vp-export-progress">
              <div className="vp-export-bar" style={{ width: `${exportProgress}%` }} />
              <span className="vp-export-pct">{Math.round(exportProgress)}%</span>
            </div>
          ) : (
            <button
              type="button"
              className="vp-export-btn"
              onClick={handleExportAll}
              disabled={!psdPath || !outputFolder || variants.length === 0}
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export All</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
