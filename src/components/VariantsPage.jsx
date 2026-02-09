import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import {
  FileImage, Plus, Trash2, Download, Lock, Copy, Car,
  Radio, Eye, FolderOpen, Check, Pencil,
  CheckSquare, AlertTriangle,
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

/* VResizer removed — layer strip is auto-height */

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
  const viewerApiRef = useRef(null);

  // Composited preview
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewToken, setPreviewToken] = useState(0);

  // Panel layout
  const [viewerPanelWidth, setViewerPanelWidth] = useState(55); // percentage
  const [layerStripHidden, setLayerStripHidden] = useState(false);
  const [viewerCollapsed, setViewerCollapsed] = useState(false);
  const [previewCollapsed, setPreviewCollapsed] = useState(false);

  const containerRef = useRef(null);

  const isTauriRuntime =
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__ !== "undefined";

  const selectedVariant = variants.find((v) => v.id === selectedVariantId) || variants[0];

  // Persist state
  useEffect(() => {
    if (onStateChange) {
      onStateChange({ psdPath, modelPath, variants, selectedVariantId, exportSize, outputFolder });
    }
  }, [psdPath, modelPath, variants, selectedVariantId, exportSize, outputFolder]);

  // Load PSD
  useEffect(() => {
    if (!psdPath) { setPsdData(null); return; }
    let cancelled = false;
    setPsdLoading(true);
    setPsdError("");

    parsePsdLayers(psdPath)
      .then((data) => {
        if (cancelled) return;
        setPsdData(data);
        setVariants((prev) => {
          const base = prev.find((v) => v.isBase);
          if (!base) return prev;
          const toggleable = {};
          for (const t of data.toggleable) toggleable[t.name] = t.enabled;
          const variantSelections = {};
          for (const g of data.variantGroups) variantSelections[g.name] = g.selectedIndex;
          return prev.map((v) => v.isBase ? { ...v, toggleable, variantSelections } : v);
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setPsdError(typeof err === "string" ? err : err?.message || "Failed to parse PSD");
      })
      .finally(() => { if (!cancelled) setPsdLoading(false); });

    return () => { cancelled = true; };
  }, [psdPath]);

  // Serialize variant state for stable dependency tracking
  const variantKey = selectedVariant
    ? JSON.stringify({ t: selectedVariant.toggleable, v: selectedVariant.variantSelections })
    : "";

  // Auto-generate preview when variant or PSD changes
  useEffect(() => {
    if (!psdPath || !psdData || !selectedVariant) return;
    let cancelled = false;

    const generate = async () => {
      try {
        const visibility = {};
        for (const [name, enabled] of Object.entries(selectedVariant.toggleable || {})) {
          visibility[name] = enabled;
        }
        for (const group of psdData.variantGroups || []) {
          const selectedIdx = selectedVariant.variantSelections?.[group.name] ?? 0;
          for (let i = 0; i < group.options.length; i++) {
            visibility[group.options[i].name] = i === selectedIdx;
          }
        }
        for (const l of psdData.locked || []) {
          visibility[l.name] = true;
        }
        // Use 1024 for real-time preview (fast), full exportSize is for final export
        const previewRes = Math.min(exportSize, 1024);
        const canvas = await compositePsdVariant(psdPath, visibility, previewRes, previewRes);
        if (!cancelled) {
          setPreviewUrl(canvas.toDataURL("image/png"));
          setPreviewToken((t) => t + 1);
        }
      } catch (err) {
        console.error("Preview failed:", err);
      }
    };

    // Debounce preview generation
    const timer = setTimeout(generate, 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [psdPath, psdData, variantKey, exportSize]);

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
    const nv = {
      id: generateId(),
      name: `Variant ${variants.length}`,
      isBase: false,
      toggleable: base ? { ...base.toggleable } : {},
      variantSelections: base ? { ...base.variantSelections } : {},
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
    const dup = { ...source, id: generateId(), name: `${source.name} Copy`, isBase: false, locked: false };
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

  // Export all
  const handleExportAll = useCallback(async () => {
    if (!psdPath || !psdData || !outputFolder) return;
    setExporting(true);
    setExportProgress(0);
    try {
      for (let i = 0; i < variants.length; i++) {
        const variant = variants[i];
        const visibility = {};
        for (const [name, enabled] of Object.entries(variant.toggleable || {})) visibility[name] = enabled;
        for (const group of psdData.variantGroups || []) {
          const selectedIdx = variant.variantSelections?.[group.name] ?? 0;
          for (let j = 0; j < group.options.length; j++) visibility[group.options[j].name] = j === selectedIdx;
        }
        for (const l of psdData.locked || []) visibility[l.name] = true;
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
  }, [psdPath, psdData, variants, exportSize, outputFolder]);

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

  // VResizer removed — layer strip is auto-height

  // Model info callback — capture livery target
  const handleModelInfo = useCallback((info) => {
    if (info.liveryTarget) setLiveryTarget(info.liveryTarget);
  }, []);

  const psdFileName = psdPath ? psdPath.split(/[\\/]/).pop() : "";
  const modelFileName = modelPath ? modelPath.split(/[\\/]/).pop() : "";
  const hasLayers = psdData && (psdData.toggleable.length > 0 || psdData.variantGroups.length > 0 || psdData.locked.length > 0);

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
              className={`vp-panel-toggle ${layerStripHidden ? "is-off" : ""}`}
              onClick={() => setLayerStripHidden((c) => !c)}
              title={layerStripHidden ? "Show Layers" : "Hide Layers"}
            >
              <PanelBottomOpen className="w-3 h-3" />
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
                  texturePath={previewUrl || ""}
                  textureReloadToken={previewToken}
                  textureTarget={liveryTarget || "all"}
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
            {!previewCollapsed && (
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

          {/* ─── Layer Strip (compact horizontal bar) ─── */}
          {hasLayers && !layerStripHidden && (
            <div className="vp-strip">
              {/* Toggleable layers */}
              {psdData.toggleable.length > 0 && (
                <div className="vp-strip-section">
                  <div className="vp-strip-label">
                    <CheckSquare className="w-2.5 h-2.5" />
                    <span>Toggles</span>
                  </div>
                  <div className="vp-strip-items">
                    {psdData.toggleable.map((layer) => {
                      const isOn = selectedVariant?.toggleable?.[layer.name] ?? layer.enabled;
                      return (
                        <button
                          key={layer.name}
                          type="button"
                          className={`vp-chip ${isOn ? "is-on" : ""}`}
                          onClick={() => handleToggleLayer(layer.name)}
                        >
                          <div className={`vp-chip-check ${isOn ? "is-checked" : ""}`}>
                            {isOn && <Check className="w-2 h-2" />}
                          </div>
                          <span>{layer.name}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Variant Groups — inline radio chips */}
              {psdData.variantGroups.map((group, gi) => {
                const selectedIdx = selectedVariant?.variantSelections?.[group.name] ?? 0;
                return (
                  <div key={group.name} className="vp-strip-section">
                    {(gi > 0 || psdData.toggleable.length > 0) && <div className="vp-strip-divider" />}
                    <div className="vp-strip-label">
                      <Radio className="w-2.5 h-2.5" />
                      <span>{group.name}</span>
                    </div>
                    <div className="vp-strip-items">
                      {group.options.map((opt, idx) => (
                        <button
                          key={opt.name}
                          type="button"
                          className={`vp-chip vp-chip--radio ${selectedIdx === idx ? "is-on" : ""}`}
                          onClick={() => handleSelectVariantOption(group.name, idx)}
                        >
                          <div className={`vp-chip-radio ${selectedIdx === idx ? "is-checked" : ""}`}>
                            {selectedIdx === idx && <div className="vp-chip-dot" />}
                          </div>
                          <span>{opt.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}

              {/* Locked layers — compact, always-on indicators */}
              {psdData.locked.length > 0 && (
                <div className="vp-strip-section vp-strip-section--locked">
                  {(psdData.toggleable.length > 0 || psdData.variantGroups.length > 0) && (
                    <div className="vp-strip-divider" />
                  )}
                  <div className="vp-strip-label">
                    <Lock className="w-2.5 h-2.5" />
                    <span>Locked</span>
                  </div>
                  <div className="vp-strip-items">
                    {psdData.locked.map((layer) => (
                      <div key={layer.name} className="vp-chip vp-chip--locked">
                        <Lock className="w-2 h-2" />
                        <span>{layer.name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
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
