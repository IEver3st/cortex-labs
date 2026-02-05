import { useCallback, useEffect, useRef, useState, useMemo, memo } from "react";
import { X, ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

/* ───── Shared OffscreenCanvas for thumbnail scaling ───── */
let _sharedOffscreen = null;
function getSharedOffscreen(w, h) {
  if (!_sharedOffscreen || _sharedOffscreen.width < w || _sharedOffscreen.height < h) {
    _sharedOffscreen = new OffscreenCanvas(Math.max(w, _sharedOffscreen?.width || 0), Math.max(h, _sharedOffscreen?.height || 0));
  }
  return _sharedOffscreen;
}

// Simple bitmap cache keyed by texture name + dimensions to avoid re-rendering
const _thumbCache = new Map();
const THUMB_CACHE_LIMIT = 128;

function pruneThumbCache() {
  if (_thumbCache.size <= THUMB_CACHE_LIMIT) return;
  // Evict oldest entries (Map preserves insertion order)
  const toDelete = _thumbCache.size - THUMB_CACHE_LIMIT;
  let count = 0;
  for (const key of _thumbCache.keys()) {
    if (count >= toDelete) break;
    _thumbCache.delete(key);
    count++;
  }
}

/* ───── Thumbnail — renders RGBA data onto a tiny canvas ───── */
const TextureThumb = memo(function TextureThumb({ rgba, width, height, name }) {
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

    // Check bitmap cache first
    const cacheKey = `${name || ""}:${width}x${height}`;
    const cachedBitmap = _thumbCache.get(cacheKey);
    if (cachedBitmap) {
      ctx.drawImage(cachedBitmap, 0, 0, w, h);
      return;
    }

    // Create ImageData from the full RGBA, draw it scaled via shared OffscreenCanvas
    try {
      const full = new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height);
      const offscreen = getSharedOffscreen(width, height);
      const offCtx = offscreen.getContext("2d");
      offCtx.putImageData(full, 0, 0);
      ctx.drawImage(offscreen, 0, 0, width, height, 0, 0, w, h);

      // Cache the bitmap for future renders
      createImageBitmap(offscreen, 0, 0, width, height).then((bitmap) => {
        _thumbCache.set(cacheKey, bitmap);
        pruneThumbCache();
      }).catch(() => { /* ignore cache miss */ });
    } catch {
      // Fallback: draw a placeholder
      ctx.fillStyle = "#1a1a2e";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "rgba(255,255,255,0.15)";
      ctx.font = "10px monospace";
      ctx.fillText("?", w / 2 - 3, h / 2 + 3);
    }
  }, [rgba, width, height, name]);

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

  // Build a flat list of all textures with their category — memoized
  const textures = useMemo(() => {
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

    // Pre-build a Map for O(1) assignment lookups instead of O(n) find() per texture
    const assignmentMap = new Map();
    if (mappingMeta?.assignments) {
      for (const a of mappingMeta.assignments) {
        assignmentMap.set(a.textureName, a);
      }
    }

    for (const [name, tex] of Object.entries(rawTextures)) {
      const category = catLookup[name] || "other";
      const assignment = assignmentMap.get(name);
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

  // Memoize filtered list and counts together
  const { filtered, counts } = useMemo(() => {
    const searchLower = search ? search.toLowerCase() : "";
    const filteredList = textures.filter((t) => {
      if (filter !== "all" && t.category !== filter) return false;
      if (searchLower && !t.name.toLowerCase().includes(searchLower)) return false;
      return true;
    });

    // Single pass to count categories
    let diffuse = 0, normal = 0, specular = 0, other = 0;
    for (const t of textures) {
      switch (t.category) {
        case "diffuse": diffuse++; break;
        case "normal": normal++; break;
        case "specular": specular++; break;
        default: other++; break;
      }
    }

    return {
      filtered: filteredList,
      counts: {
        all: textures.length,
        diffuse,
        normal,
        specular,
        other,
      },
    };
  }, [textures, filter, search]);

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
                      <TextureThumb rgba={tex.rgba} width={tex.width} height={tex.height} name={tex.name} />
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
