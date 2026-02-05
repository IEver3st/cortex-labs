import { useCallback, useEffect, useRef, useState, memo } from "react";
import { X, ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

/* ───── Thumbnail — renders RGBA data onto a tiny canvas ───── */
const TextureThumb = memo(function TextureThumb({ rgba, width, height }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;

    const maxDim = 96;
    const scale = Math.min(maxDim / width, maxDim / height, 1);
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    cvs.width = w;
    cvs.height = h;
    const ctx = cvs.getContext("2d");
    if (!ctx) return;

    if (!rgba) {
      // No pixel data yet — draw a placeholder
      ctx.fillStyle = "#1a1a2e";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "rgba(255,255,255,0.12)";
      ctx.font = "10px monospace";
      ctx.textAlign = "center";
      ctx.fillText(`${width}x${height}`, w / 2, h / 2 + 3);
      return;
    }

    // Create ImageData from the full RGBA, draw it scaled
    try {
      const full = new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height);
      const offscreen = new OffscreenCanvas(width, height);
      const offCtx = offscreen.getContext("2d");
      offCtx.putImageData(full, 0, 0);
      ctx.drawImage(offscreen, 0, 0, w, h);
    } catch {
      // Fallback: draw a placeholder
      ctx.fillStyle = "#1a1a2e";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "rgba(255,255,255,0.15)";
      ctx.font = "10px monospace";
      ctx.fillText("?", w / 2 - 3, h / 2 + 3);
    }
  }, [rgba, width, height]);

  return <canvas ref={canvasRef} className="ytd-thumb-canvas" />;
});

/* ───── Role badge ───── */
function RoleBadge({ role }) {
  return (
    <span className={`ytd-modal-role ytd-modal-role--${role || "unknown"}`}>
      {role || "?"}
    </span>
  );
}

/* ───── Material picker dropdown ───── */
function MaterialPicker({ currentMaterial, materialNames, onAssign }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className="ytd-mat-picker" ref={ref}>
      <button
        type="button"
        className={`ytd-mat-picker-btn ${currentMaterial ? "" : "ytd-mat-picker-btn--none"}`}
        onClick={() => setOpen((p) => !p)}
      >
        <span className="ytd-mat-picker-label mono">{currentMaterial || "Unassigned"}</span>
        <ChevronDown className="ytd-mat-picker-chevron" />
      </button>
      {open ? (
        <div className="ytd-mat-picker-dropdown">
          <button
            type="button"
            className={`ytd-mat-picker-option ${!currentMaterial ? "is-active" : ""}`}
            onClick={() => { onAssign(null); setOpen(false); }}
          >
            <span className="ytd-mat-picker-option-label">Unassigned</span>
          </button>
          {materialNames.map((mat) => (
            <button
              key={mat}
              type="button"
              className={`ytd-mat-picker-option ${currentMaterial === mat ? "is-active" : ""}`}
              onClick={() => { onAssign(mat); setOpen(false); }}
            >
              <span className="ytd-mat-picker-option-label mono">{mat}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ───── Category filter tabs ───── */
const CATEGORY_FILTERS = [
  { key: "all", label: "All" },
  { key: "diffuse", label: "Diffuse" },
  { key: "normal", label: "Normal" },
  { key: "specular", label: "Specular" },
  { key: "other", label: "Other" },
];

/* ═════════════════════════════════════════════════════════════════
   YtdBrowser — Full-screen modal for browsing & assigning YTD textures
   ═════════════════════════════════════════════════════════════════ */
export default function YtdBrowser({
  open,
  onClose,
  rawTextures,       // { name: { rgba, width, height, format, ... } } — flat dict
  categorizedTextures, // { diffuse, normal, specular, detail, other }
  mappingMeta,       // { rootBase, assignments: [{ textureName, baseName, role, materialName }] }
  materialNames,     // string[] — all material names from the model
  onOverride,        // (textureName, materialName|null) => void
}) {
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");

  // Build a flat list of all textures with their category
  const allTextures = useCallback(() => {
    if (!rawTextures) return [];
    const result = [];
    const catLookup = {};

    // Build reverse lookup from categorized textures
    if (categorizedTextures) {
      for (const [cat, entries] of Object.entries(categorizedTextures)) {
        if (cat === "_meta") continue;
        for (const [, tex] of Object.entries(entries)) {
          const name = tex.originalName || tex.name;
          if (name) catLookup[name] = cat;
        }
      }
    }

    for (const [name, tex] of Object.entries(rawTextures)) {
      const category = catLookup[name] || "other";
      // Find the assignment from meta
      const assignment = mappingMeta?.assignments?.find((a) => a.textureName === name);
      result.push({
        name,
        category,
        width: tex.width,
        height: tex.height,
        rgba: tex.rgba,
        role: assignment?.role || null,
        materialName: assignment?.materialName || null,
      });
    }

    return result;
  }, [rawTextures, categorizedTextures, mappingMeta]);

  const textures = allTextures();

  const filtered = textures.filter((t) => {
    if (filter !== "all" && t.category !== filter) return false;
    if (search && !t.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const counts = {
    all: textures.length,
    diffuse: textures.filter((t) => t.category === "diffuse").length,
    normal: textures.filter((t) => t.category === "normal").length,
    specular: textures.filter((t) => t.category === "specular").length,
    other: textures.filter((t) => t.category === "detail" || t.category === "other").length,
  };

  if (!open) return null;

  return (
    <AnimatePresence>
      <motion.div
        className="ytd-modal-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <motion.div
          className="ytd-modal"
          initial={{ opacity: 0, y: 16, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 10, scale: 0.97 }}
          transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
        >
          {/* Header */}
          <div className="ytd-modal-header">
            <div className="ytd-modal-header-left">
              <div className="ytd-modal-title">Texture Dictionary</div>
              <div className="ytd-modal-subtitle">
                {textures.length} textures{mappingMeta?.rootBase ? ` — root: ${mappingMeta.rootBase}` : ""}
              </div>
            </div>
            <button type="button" className="ytd-modal-close" onClick={onClose}>
              <X className="ytd-modal-close-icon" />
            </button>
          </div>

          {/* Filter bar */}
          <div className="ytd-modal-filters">
            <div className="ytd-modal-tabs">
              {CATEGORY_FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className={`ytd-modal-tab ${filter === f.key ? "is-active" : ""}`}
                  onClick={() => setFilter(f.key)}
                >
                  {f.label}
                  <span className="ytd-modal-tab-count">{counts[f.key] || 0}</span>
                </button>
              ))}
            </div>
            <input
              type="text"
              className="ytd-modal-search"
              placeholder="Search textures..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {/* Texture grid */}
          <div className="ytd-modal-body">
            {filtered.length === 0 ? (
              <div className="ytd-modal-empty">No textures match the current filter.</div>
            ) : (
              <div className="ytd-modal-grid">
                {filtered.map((tex) => (
                  <div key={tex.name} className="ytd-modal-card">
                    <div className="ytd-modal-card-preview">
                      <TextureThumb rgba={tex.rgba} width={tex.width} height={tex.height} />
                      <div className="ytd-modal-card-dims">{tex.width}x{tex.height}</div>
                    </div>
                    <div className="ytd-modal-card-info">
                      <div className="ytd-modal-card-name mono" title={tex.name}>{tex.name}</div>
                      <div className="ytd-modal-card-row">
                        <span className={`ytd-modal-cat ytd-modal-cat--${tex.category}`}>{tex.category}</span>
                        {tex.role ? <RoleBadge role={tex.role} /> : null}
                      </div>
                      <div className="ytd-modal-card-assign">
                        <span className="ytd-modal-card-assign-label">Material:</span>
                        <MaterialPicker
                          currentMaterial={tex.materialName}
                          materialNames={materialNames || []}
                          onAssign={(mat) => onOverride?.(tex.name, mat)}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
