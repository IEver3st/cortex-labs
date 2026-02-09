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
 * Parse a PSD file and extract layer structure for the variant builder.
 */
export async function parsePsdLayers(filePath) {
  const bytes = await readFile(filePath);
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

  const toggleable = [];
  const variantGroups = [];
  const locked = [];

  if (useColorLabels) {
    for (const layer of layers) {
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
    }
  } else {
    for (const layer of layers) {
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

  return { width, height, layers, toggleable, variantGroups, locked };
}

/**
 * Apply the visibility map to the raw PSD layer tree BEFORE ag-psd composites.
 * This mutates the layer objects in place, setting .hidden appropriately.
 *
 * The visibility map uses top-level names:
 *  - toggleable layer names → true/false
 *  - variant group CHILD names → true/false
 *  - locked layer names → true (always)
 *
 * For variant groups, the parent group itself must stay visible
 * while only the selected child is shown.
 */
function applyVisibilityToTree(layers, visibility) {
  if (!layers) return;
  for (const layer of layers) {
    const name = layer.name || "";

    if (name in visibility) {
      layer.hidden = !visibility[name];
    }
    // Always recurse into children to apply child-level visibility
    if (layer.children) {
      applyVisibilityToTree(layer.children, visibility);

      // If any child is being shown, make sure this group is also visible
      const anyChildVisible = layer.children.some((c) => !c.hidden);
      if (anyChildVisible) {
        layer.hidden = false;
      }
    }
  }
}

/**
 * Composite a PSD with specific layer visibility into a canvas.
 *
 * Strategy: We let ag-psd do the compositing by:
 *   1. Reading the PSD without skipping composite
 *   2. Applying visibility to the layer tree
 *   3. Re-reading with the modified visibility using a two-pass approach
 *
 * Actually, since ag-psd composites on read (not separately), we use
 * a manual layer-by-layer draw approach with proper parent propagation.
 */
export async function compositePsdVariant(filePath, layerVisibility = {}, targetWidth, targetHeight) {
  const bytes = await readFile(filePath);
  const buffer = bytes.buffer || bytes;

  // First, apply visibility to the raw buffer's layer tree, then let ag-psd
  // do the compositing. We need to read twice:
  //   Pass 1: get layer tree structure to apply visibility
  //   Pass 2: read with applied visibility for composite
  //
  // But since we can't modify the buffer, we'll do manual compositing.

  const psd = readPsd(new DataView(buffer), {
    skipThumbnail: true,
    skipCompositeImageData: true,
    skipLayerImageData: false,  // Need individual layer canvases
  });

  const psdW = psd.width;
  const psdH = psd.height;
  const opacityDivisor = getOpacityScaleDivisor(psd.children || []);
  const outW = targetWidth || psdW;
  const outH = targetHeight || psdH;

  // Apply visibility to the tree before drawing
  applyVisibilityToTree(psd.children || [], layerVisibility);

  // Create working canvas
  const workCanvas = document.createElement("canvas");
  workCanvas.width = psdW;
  workCanvas.height = psdH;
  const workCtx = workCanvas.getContext("2d");

  /**
   * Draw layers bottom-to-top with proper group handling.
   *
   * ag-psd stores children in visual order (topmost layer first in array).
   * For canvas compositing we need bottom-to-top, so reverse iterate.
   *
   * For groups: if the group itself has .canvas, it means ag-psd has
   * pre-composited the group content — use that directly.
   * Otherwise, recurse into children.
   */
  function drawLayers(layers, ctx) {
    if (!layers) return;

    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];

      // Skip hidden layers
      if (layer.hidden) continue;

      const opacity = normalizeOpacity(layer.opacity, opacityDivisor);

      // Map blend modes
      let compositeOp = "source-over";
      const blend = (layer.blendMode || "normal").toLowerCase().replace(/\s+/g, "");
      const blendMap = {
        normal: "source-over",
        multiply: "multiply",
        screen: "screen",
        overlay: "overlay",
        darken: "darken",
        lighten: "lighten",
        colordodge: "color-dodge",
        colorburn: "color-burn",
        hardlight: "hard-light",
        softlight: "soft-light",
        difference: "difference",
        exclusion: "exclusion",
        hue: "hue",
        saturation: "saturation",
        color: "color",
        luminosity: "luminosity",
      };
      compositeOp = blendMap[blend] || "source-over";

      if (layer.children && layer.children.length > 0) {
        // Group layer
        if (layer.canvas) {
          // ag-psd pre-composited this group (has effects/clipping)
          ctx.save();
          ctx.globalAlpha = opacity;
          ctx.globalCompositeOperation = compositeOp;
          ctx.drawImage(layer.canvas, layer.left || 0, layer.top || 0);
          ctx.restore();
        } else {
          // Recurse into children — draw onto same context
          // Apply group opacity via an offscreen canvas
          if (opacity < 1 || compositeOp !== "source-over") {
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
          } else {
            drawLayers(layer.children, ctx);
          }
        }
      } else if (layer.canvas) {
        // Leaf layer with pixel data
        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.globalCompositeOperation = compositeOp;
        ctx.drawImage(layer.canvas, layer.left || 0, layer.top || 0);
        ctx.restore();
      }
    }
  }

  drawLayers(psd.children || [], workCtx);

  // Scale if needed
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
