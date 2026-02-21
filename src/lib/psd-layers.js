/**
 * PSD Layer Parser & Compositor for Cortex Studio Variants system.
 *
 * Parsing strategy (priority):
 *   1. Color labels if set (blue=toggleable, variant colors, gray/none=locked)
 *   2. If NO color labels → heuristic mode based on structure & names
 *
 * Compositing strategy:
 *   Uses ag-psd's own composite by manipulating layer.hidden BEFORE readPsd
 *   processes the composite, ensuring correct blending, masks, and effects.
 */

import { readPsd } from "ag-psd";
import { readFile } from "@tauri-apps/plugin-fs";
import { decodePdn, decodePdnLayers, getPdnBlendCanvasOp } from "./pdn";
import { detectPsdBitDepth, getFileExtension } from "./viewer-utils";

const FLAT_LAYER_ID = "__layer_source__/image";
const FLAT_LAYER_NAME = "Image";

/* ─── Category mapping ─── */
const COLOR_CATEGORY_MAP = {
  blue: "toggleable",
  red: "variant",
  orange: "variant",
  yellow: "variant",
  green: "variant",
  violet: "variant",
  purple: "variant",
  gray: "locked",
  none: null,
};

const LOCKED_PATTERNS = [
  /^watermark$/i,
  /^ao[_ ]?map$/i,
  /^base$/i,
  /^background$/i,
  /^bg$/i,
  /^shadow$/i,
  /^ambient/i,
  /^mask$/i,
];

function isLockedName(name) {
  return LOCKED_PATTERNS.some((re) => re.test(name.trim()));
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 1;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function getOpacityMax(layers) {
  if (!layers || !Array.isArray(layers)) return 0;
  let max = 0;
  for (const layer of layers) {
    if (Number.isFinite(layer.opacity)) max = Math.max(max, layer.opacity);
    if (layer.children?.length) {
      max = Math.max(max, getOpacityMax(layer.children));
    }
  }
  return max;
}

function getOpacityScaleDivisor(layers) {
  const max = getOpacityMax(layers);
  if (!Number.isFinite(max) || max <= 0) return 255;
  if (max <= 1) return 1;
  if (max <= 100) return 100;
  return 255;
}

function normalizeOpacity(raw, divisor) {
  if (!Number.isFinite(raw)) return 1;
  if (divisor === 1) return clamp01(raw);
  return clamp01(raw / divisor);
}

/* ─── Layer tree walker (for parser) ─── */
function walkLayers(layers, depth = 0, opacityDivisor = 255) {
  if (!layers || !Array.isArray(layers)) return [];
  return layers.map((layer) => {
    const isGroup = Boolean(layer.children && layer.children.length > 0);
    const colorLabel = (layer.color || "none").toLowerCase();
    const opacity = normalizeOpacity(layer.opacity, opacityDivisor);
    const entry = {
      name: layer.name || "Unnamed",
      visible: layer.hidden !== true && opacity > 0,
      opacity,
      colorLabel,
      isGroup,
      depth,
    };
    if (isGroup) {
      entry.children = walkLayers(layer.children, depth + 1, opacityDivisor);
    }
    return entry;
  });
}

function hasColorLabels(layers) {
  for (const layer of layers) {
    const c = (layer.colorLabel || "none").toLowerCase();
    if (c !== "none" && c !== "gray") return true;
    if (layer.children?.length && hasColorLabels(layer.children)) return true;
  }
  return false;
}

/**
 * Build a unique path-based ID for each layer to avoid name collisions.
 * Returns a flat map of { uniqueId → layerName, parentPath, ... }
 */
function buildLayerIndex(layers, parentPath = "") {
  const index = [];
  if (!layers) return index;
  for (const layer of layers) {
    const name = layer.name || "Unnamed";
    const path = parentPath ? `${parentPath}/${name}` : name;
    index.push({ name, path, layer });
    if (layer.children) {
      index.push(...buildLayerIndex(layer.children, path));
    }
  }
  return index;
}

/**
 * Flatten the walked layer tree into a list with unique path-based IDs.
 * Each entry: { id, name, path, visible, opacity, colorLabel, isGroup, depth, parentId, children: [ids] }
 */
function flattenLayerTree(layers, parentPath = "", parentId = null) {
  const flat = [];
  if (!layers) return flat;
  for (const layer of layers) {
    const path = parentPath ? `${parentPath}/${layer.name}` : layer.name;
    const id = path;
    const entry = {
      id,
      name: layer.name,
      path,
      visible: layer.visible,
      opacity: layer.opacity,
      colorLabel: layer.colorLabel,
      isGroup: layer.isGroup,
      depth: layer.depth,
      parentId,
      childIds: [],
    };
    flat.push(entry);
    if (layer.isGroup && layer.children) {
      const childFlat = flattenLayerTree(layer.children, path, id);
      entry.childIds = childFlat.filter((c) => c.parentId === id).map((c) => c.id);
      flat.push(...childFlat);
    }
  }
  return flat;
}

/**
 * Categorize a layer for the UI sections.
 * Returns: "toggleable" | "variant-group" | "locked" | "base"
 */
function categorizeLayer(layer, useColorLabels) {
  if (useColorLabels) {
    const cat = COLOR_CATEGORY_MAP[layer.colorLabel] || null;
    if (cat === "toggleable") return "toggleable";
    if (cat === "variant" && layer.isGroup) return "variant-group";
    if (cat === "variant") return "toggleable";
    if (cat === "locked") return "locked";
    return "base";
  }
  // Heuristic mode
  if (isLockedName(layer.name)) return "locked";
  if (layer.isGroup) {
    const childCount = layer.childIds?.length || 0;
    if (childCount >= 2) return "variant-group";
    if (childCount === 1) return "toggleable";
    return "locked";
  }
  return "toggleable";
}

function isFlatLayerSourceExtension(extension) {
  return extension === "ai";
}

function isPdnExtension(extension) {
  return extension === "pdn";
}

function buildFlatLayerSourceData(width, height, name = FLAT_LAYER_NAME) {
  const layer = {
    name,
    visible: true,
    opacity: 1,
    colorLabel: "none",
    isGroup: false,
    depth: 0,
  };
  const allLayer = {
    id: FLAT_LAYER_ID,
    name,
    path: name,
    visible: true,
    opacity: 1,
    colorLabel: "none",
    isGroup: false,
    depth: 0,
    parentId: null,
    childIds: [],
    category: "base",
  };
  return {
    width,
    height,
    layers: [layer],
    allLayers: [allLayer],
    toggleable: [],
    variantGroups: [],
    locked: [{ name, colorLabel: "none" }],
  };
}

function canvasFromRgba(width, height, rgbaBytes) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable.");
  const clamped = new Uint8ClampedArray(
    rgbaBytes.buffer,
    rgbaBytes.byteOffset,
    rgbaBytes.byteLength,
  );
  const imageData = new ImageData(clamped, width, height);
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

async function decodeAiCanvas(bytes) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).href;

  const loadingTask = pdfjsLib.getDocument({ data: buffer });
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 2.0 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context unavailable.");
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas;
}

async function decodeFlatLayerSourceCanvas(extension, bytes, filePath = "") {
  void filePath;

  if (extension === "ai") {
    try {
      return await decodeAiCanvas(bytes);
    } catch {
      throw new Error("This .ai file is not PDF-compatible. Re-save/export it as PDF-compatible AI.");
    }
  }

  throw new Error("Unsupported non-PSD layer source.");
}

function isFlatLayerVisible(layerVisibility) {
  if (!layerVisibility || typeof layerVisibility !== "object") return true;
  if (Object.prototype.hasOwnProperty.call(layerVisibility, FLAT_LAYER_ID)) {
    return Boolean(layerVisibility[FLAT_LAYER_ID]);
  }
  if (Object.prototype.hasOwnProperty.call(layerVisibility, FLAT_LAYER_NAME)) {
    return Boolean(layerVisibility[FLAT_LAYER_NAME]);
  }
  return true;
}

/* ═══════════════════════════════════════════════════════════
   PDN Layer-Aware Processing
   ═══════════════════════════════════════════════════════════ */

/**
 * Parse a Paint.NET (.pdn) file into the standard layer structure
 * used by the variant builder. Format matches parsePsdLayers output.
 */
function parsePdnLayerSource(bytes) {
  const result = decodePdnLayers(bytes);

  // If layer-aware decoding failed, fall back to flat composite
  if (!result || !result.layers || result.layers.length === 0) {
    const flat = decodePdn(bytes);
    if (flat?.width && flat?.height && flat?.data) {
      return buildFlatLayerSourceData(flat.width, flat.height);
    }
    throw new Error("Failed to decode Paint.NET file.");
  }

  const { width, height, layers: pdnLayers } = result;

  // Build the walked layer tree (same shape as PSD walkLayers output)
  const layers = pdnLayers.map((pdnLayer) => ({
    name: pdnLayer.name || "Unnamed",
    visible: pdnLayer.visible !== false,
    opacity: (pdnLayer.opacity ?? 255) / 255,
    colorLabel: "none",
    isGroup: false,
    depth: 0,
  }));

  // Build flat layer list with unique IDs
  const allLayers = layers.map((layer) => ({
    id: layer.name,
    name: layer.name,
    path: layer.name,
    visible: layer.visible,
    opacity: layer.opacity,
    colorLabel: "none",
    isGroup: false,
    depth: 0,
    parentId: null,
    childIds: [],
    category: isLockedName(layer.name) ? "locked" : "toggleable",
  }));

  // Build legacy categorized buckets
  const toggleable = [];
  const locked = [];

  for (const layer of layers) {
    if (isLockedName(layer.name)) {
      locked.push({ name: layer.name, colorLabel: "none" });
    } else {
      toggleable.push({
        name: layer.name,
        enabled: layer.visible,
        colorLabel: "none",
      });
    }
  }

  return {
    width,
    height,
    layers,
    allLayers,
    toggleable,
    variantGroups: [],
    locked,
  };
}

/**
 * Composite a PDN file with specific layer visibility into a canvas.
 * Per-layer compositing with blend modes, opacity, and visibility control.
 */
function compositePdnVariant(bytes, layerVisibility, targetWidth, targetHeight) {
  const result = decodePdnLayers(bytes);

  // Fallback to flat composite
  if (!result || !result.layers || result.layers.length === 0) {
    const flat = decodePdn(bytes);
    if (!flat?.width || !flat?.height || !flat?.data) {
      throw new Error("Failed to decode Paint.NET file.");
    }
    const srcCanvas = canvasFromRgba(flat.width, flat.height, flat.data);
    const outW = targetWidth || flat.width;
    const outH = targetHeight || flat.height;
    const outCanvas = document.createElement("canvas");
    outCanvas.width = outW;
    outCanvas.height = outH;
    const outCtx = outCanvas.getContext("2d");
    if (!outCtx) throw new Error("Canvas 2D context unavailable.");
    outCtx.drawImage(srcCanvas, 0, 0, outW, outH);
    return outCanvas;
  }

  const { width, height, layers: pdnLayers } = result;

  // Create work canvas at native PDN dimensions
  const workCanvas = document.createElement("canvas");
  workCanvas.width = width;
  workCanvas.height = height;
  const workCtx = workCanvas.getContext("2d");
  if (!workCtx) throw new Error("Canvas 2D context unavailable.");

  // Draw each layer bottom-to-top with visibility/blend/opacity
  for (const pdnLayer of pdnLayers) {
    const layerName = pdnLayer.name || "";

    // Check visibility map (by name, matching the allLayers id format)
    let isVisible;
    if (Object.prototype.hasOwnProperty.call(layerVisibility, layerName)) {
      isVisible = Boolean(layerVisibility[layerName]);
    } else {
      isVisible = pdnLayer.visible !== false;
    }

    if (!isVisible) continue;

    const opacity = (pdnLayer.opacity ?? 255) / 255;
    if (opacity <= 0) continue;

    if (!pdnLayer.image || pdnLayer.image.length === 0) continue;

    // Create a temporary canvas for this layer's pixel data
    const layerCanvas = canvasFromRgba(width, height, pdnLayer.image);

    // Apply blend mode and opacity
    workCtx.save();
    workCtx.globalAlpha = opacity;
    workCtx.globalCompositeOperation = pdnLayer.blendModeCanvas || "source-over";
    workCtx.drawImage(layerCanvas, 0, 0);
    workCtx.restore();
  }

  // Scale to target dimensions if needed
  const outW = targetWidth || width;
  const outH = targetHeight || height;

  if (outW === width && outH === height) {
    return workCanvas;
  }

  const outCanvas = document.createElement("canvas");
  outCanvas.width = outW;
  outCanvas.height = outH;
  const outCtx = outCanvas.getContext("2d");
  outCtx.drawImage(workCanvas, 0, 0, outW, outH);
  return outCanvas;
}

/**
 * Parse a PSD file and extract layer structure for the variant builder.
 * Returns both the legacy categorized buckets AND a full flat layer list.
 */
export async function parsePsdLayers(filePath) {
  const bytes = await readFile(filePath);
  const extension = getFileExtension(filePath);

  if (isPdnExtension(extension)) {
    return parsePdnLayerSource(bytes);
  }

  if (isFlatLayerSourceExtension(extension)) {
    const canvas = await decodeFlatLayerSourceCanvas(extension, bytes, filePath);
    return buildFlatLayerSourceData(canvas.width, canvas.height);
  }

  const bitDepth = detectPsdBitDepth(bytes);
  if (bitDepth === 16 || bitDepth === 32) {
    const error = new Error(`${bitDepth}-bit PSD not supported`);
    error.type = "unsupported-bit-depth";
    error.bitDepth = bitDepth;
    throw error;
  }
  const buffer = bytes.buffer || bytes;

  const psd = readPsd(new DataView(buffer), {
    skipCompositeImageData: true,
    skipThumbnail: true,
    skipLayerImageData: true,
  });

  const width = psd.width;
  const height = psd.height;
  const rawLayers = psd.children || [];
  const opacityDivisor = getOpacityScaleDivisor(rawLayers);
  const layers = walkLayers(rawLayers, 0, opacityDivisor);
  const useColorLabels = hasColorLabels(layers);

  // Build full flat layer list with unique path IDs
  const allLayers = flattenLayerTree(layers);

  // Annotate each layer with its category
  for (const entry of allLayers) {
    entry.category = categorizeLayer(entry, useColorLabels);
  }

  // Legacy categorized buckets (still used by export and backward compat)
  const toggleable = [];
  const variantGroups = [];
  const locked = [];

  // Only categorize top-level layers for legacy buckets
  for (const layer of layers) {
    if (useColorLabels) {
      const cat = COLOR_CATEGORY_MAP[layer.colorLabel] || null;
      if (cat === "toggleable") {
        toggleable.push({ name: layer.name, enabled: layer.visible, colorLabel: layer.colorLabel });
      } else if (cat === "variant" && layer.isGroup) {
        const options = (layer.children || []).map((child) => ({
          name: child.name, visible: child.visible, colorLabel: child.colorLabel,
        }));
        variantGroups.push({
          name: layer.name, colorLabel: layer.colorLabel, options,
          selectedIndex: Math.max(0, options.findIndex((o) => o.visible)),
        });
      } else if (cat === "variant" && !layer.isGroup) {
        toggleable.push({ name: layer.name, enabled: layer.visible, colorLabel: layer.colorLabel });
      } else {
        locked.push({ name: layer.name, colorLabel: layer.colorLabel });
      }
    } else {
      if (isLockedName(layer.name)) {
        locked.push({ name: layer.name, colorLabel: layer.colorLabel });
        continue;
      }
      if (layer.isGroup) {
        const children = layer.children || [];
        if (children.length >= 2) {
          const options = children.map((child) => ({
            name: child.name, visible: child.visible, colorLabel: child.colorLabel,
          }));
          variantGroups.push({
            name: layer.name, colorLabel: layer.colorLabel, options,
            selectedIndex: Math.max(0, options.findIndex((o) => o.visible)),
          });
        } else if (children.length === 1) {
          toggleable.push({ name: layer.name, enabled: layer.visible, colorLabel: layer.colorLabel });
        } else {
          locked.push({ name: layer.name, colorLabel: layer.colorLabel });
        }
      } else {
        toggleable.push({ name: layer.name, enabled: layer.visible, colorLabel: layer.colorLabel });
      }
    }
  }

  return { width, height, layers, allLayers, toggleable, variantGroups, locked };
}

/**
 * Apply the visibility map to the raw ag-psd layer tree.
 * Matches by both path-based IDs ("Group/Child") and plain names.
 * Path-based matches take priority over name-based matches.
 *
 * For groups: if any child is explicitly shown, the parent group
 * is forced visible so the child can render.
 */
function applyVisibilityToTree(layers, visibility, parentPath = "") {
  if (!layers) return;
  for (const layer of layers) {
    const name = layer.name || "";
    const path = parentPath ? `${parentPath}/${name}` : name;

    const hasExplicitVisibility =
      Object.prototype.hasOwnProperty.call(visibility, path) ||
      Object.prototype.hasOwnProperty.call(visibility, name);

    // Path-based match takes priority
    if (path in visibility) {
      layer.hidden = !visibility[path];
    } else if (name in visibility) {
      layer.hidden = !visibility[name];
    }

    // Recurse into children
    if (layer.children) {
      applyVisibilityToTree(layer.children, visibility, path);

      // If any child is being shown, force this group visible
      const anyChildVisible = layer.children.some((c) => !c.hidden);
      if (!hasExplicitVisibility && anyChildVisible) {
        layer.hidden = false;
      }
    }
  }
}

/**
 * Map ag-psd blend mode strings to Canvas 2D globalCompositeOperation values.
 * ag-psd uses human-readable strings like "normal", "pass through", "multiply", etc.
 */
const BLEND_MAP = {
  "normal": "source-over",
  "dissolve": "source-over",
  "darken": "darken",
  "multiply": "multiply",
  "color burn": "color-burn",
  "linear burn": "multiply",
  "darker color": "darken",
  "lighten": "lighten",
  "screen": "screen",
  "color dodge": "color-dodge",
  "linear dodge": "lighten",
  "lighter color": "lighten",
  "overlay": "overlay",
  "soft light": "soft-light",
  "hard light": "hard-light",
  "vivid light": "hard-light",
  "linear light": "hard-light",
  "pin light": "hard-light",
  "hard mix": "hard-light",
  "difference": "difference",
  "exclusion": "exclusion",
  "subtract": "difference",
  "divide": "source-over",
  "hue": "hue",
  "saturation": "saturation",
  "color": "color",
  "luminosity": "luminosity",
};

function getCompositeOp(blendMode) {
  if (!blendMode) return "source-over";
  return BLEND_MAP[blendMode.toLowerCase()] || "source-over";
}

/**
 * Composite a PSD with specific layer visibility into a canvas.
 *
 * Uses manual layer-by-layer compositing with proper handling of:
 *   - "pass through" groups (children draw directly to parent context)
 *   - Isolated groups (non-pass-through: composited to offscreen buffer first)
 *   - Layer opacity and blend modes
 *   - Clipping masks (layers with .clipping flag)
 */
export async function compositePsdVariant(filePath, layerVisibility = {}, targetWidth, targetHeight) {
  const bytes = await readFile(filePath);
  const extension = getFileExtension(filePath);

  if (isPdnExtension(extension)) {
    return compositePdnVariant(bytes, layerVisibility, targetWidth, targetHeight);
  }

  if (isFlatLayerSourceExtension(extension)) {
    const sourceCanvas = await decodeFlatLayerSourceCanvas(extension, bytes, filePath);
    const outW = targetWidth || sourceCanvas.width;
    const outH = targetHeight || sourceCanvas.height;
    const outCanvas = document.createElement("canvas");
    outCanvas.width = outW;
    outCanvas.height = outH;
    if (isFlatLayerVisible(layerVisibility)) {
      const outCtx = outCanvas.getContext("2d");
      if (!outCtx) throw new Error("Canvas 2D context unavailable.");
      outCtx.drawImage(sourceCanvas, 0, 0, outW, outH);
    }
    return outCanvas;
  }

  const bitDepth = detectPsdBitDepth(bytes);
  if (bitDepth === 16 || bitDepth === 32) {
    const error = new Error(`${bitDepth}-bit PSD not supported`);
    error.type = "unsupported-bit-depth";
    error.bitDepth = bitDepth;
    throw error;
  }
  const buffer = bytes.buffer || bytes;

  const psd = readPsd(new DataView(buffer), {
    skipThumbnail: true,
    skipCompositeImageData: true,
    skipLayerImageData: false,
  });

  const psdW = psd.width;
  const psdH = psd.height;
  const opacityDivisor = getOpacityScaleDivisor(psd.children || []);
  const outW = targetWidth || psdW;
  const outH = targetHeight || psdH;

  // Apply visibility to the raw ag-psd tree
  applyVisibilityToTree(psd.children || [], layerVisibility);

  const workCanvas = document.createElement("canvas");
  workCanvas.width = psdW;
  workCanvas.height = psdH;
  const workCtx = workCanvas.getContext("2d");

  /**
   * Draw layers bottom-to-top.
   *
   * ag-psd builds children via unshift while iterating the PSD's bottom-to-top
   * layer list in reverse, so the resulting array order is:
   *   children[0]   = bottommost layer (drawn first)
   *   children[N-1] = topmost layer (drawn last)
   * We iterate FORWARD to draw bottom-to-top onto the canvas.
   *
   * Group blend mode handling:
   *   - "pass through": children draw directly to the parent context
   *     (the group is transparent to compositing — Photoshop default for groups)
   *   - Any other mode: children are composited to an offscreen buffer,
   *     then the buffer is drawn to the parent with the group's blend mode + opacity
   */
  function drawLayers(layers, ctx) {
    if (!layers) return;

    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      if (layer.hidden) continue;

      const opacity = normalizeOpacity(layer.opacity, opacityDivisor);
      if (opacity <= 0) continue;

      const blendMode = (layer.blendMode || "normal").toLowerCase();
      const compositeOp = getCompositeOp(blendMode);
      const isPassThrough = blendMode === "pass through";

      if (layer.children && layer.children.length > 0) {
        // ── Group layer ──
        if (isPassThrough) {
          // Pass-through: children draw directly to parent context.
          // Group opacity still applies to each child individually.
          if (opacity < 1) {
            // Apply group opacity via offscreen buffer
            const tmpCanvas = document.createElement("canvas");
            tmpCanvas.width = psdW;
            tmpCanvas.height = psdH;
            const tmpCtx = tmpCanvas.getContext("2d");
            drawLayers(layer.children, tmpCtx);
            ctx.save();
            ctx.globalAlpha = opacity;
            ctx.drawImage(tmpCanvas, 0, 0);
            ctx.restore();
          } else {
            // Full opacity pass-through: draw children directly
            drawLayers(layer.children, ctx);
          }
        } else if (layer.canvas) {
          // ag-psd pre-composited this group (has effects/clipping)
          ctx.save();
          ctx.globalAlpha = opacity;
          ctx.globalCompositeOperation = compositeOp;
          ctx.drawImage(layer.canvas, layer.left || 0, layer.top || 0);
          ctx.restore();
        } else {
          // Isolated group: composite children to offscreen buffer
          const groupCanvas = document.createElement("canvas");
          groupCanvas.width = psdW;
          groupCanvas.height = psdH;
          const groupCtx = groupCanvas.getContext("2d");
          drawLayers(layer.children, groupCtx);
          ctx.save();
          ctx.globalAlpha = opacity;
          ctx.globalCompositeOperation = compositeOp;
          ctx.drawImage(groupCanvas, 0, 0);
          ctx.restore();
        }
      } else if (layer.canvas) {
        // ── Leaf layer with pixel data ──
        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.globalCompositeOperation = compositeOp;
        ctx.drawImage(layer.canvas, layer.left || 0, layer.top || 0);
        ctx.restore();
      }
    }
  }

  drawLayers(psd.children || [], workCtx);

  if (outW === psdW && outH === psdH) {
    return workCanvas;
  }

  const outCanvas = document.createElement("canvas");
  outCanvas.width = outW;
  outCanvas.height = outH;
  const outCtx = outCanvas.getContext("2d");
  outCtx.drawImage(workCanvas, 0, 0, outW, outH);
  return outCanvas;
}

/**
 * Generate all variant permutations from toggleable + variantGroups config.
 */
export function generateVariantPermutations(toggleableState, variantGroups) {
  if (!variantGroups || variantGroups.length === 0) {
    return [{ ...toggleableState }];
  }
  const results = [];
  function recurse(groupIdx, current) {
    if (groupIdx >= variantGroups.length) {
      results.push({ ...current });
      return;
    }
    const group = variantGroups[groupIdx];
    for (let i = 0; i < group.options.length; i++) {
      const next = { ...current };
      for (let j = 0; j < group.options.length; j++) {
        next[group.options[j].name] = j === i;
      }
      recurse(groupIdx + 1, next);
    }
  }
  recurse(0, { ...toggleableState });
  return results;
}
