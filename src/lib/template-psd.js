import { writePsdUint8Array } from "ag-psd";

/* ── Constants ───────────────────────────────────────────────────── */

const DEFAULT_SIZE = 2048;
const MIN_SIZE = 256;
const MAX_SIZE = 8192;
const MIN_TRIANGLE_AREA_PIXELS = 0.005;

/* ── Utility ─────────────────────────────────────────────────────── */

function clampSize(size) {
  const parsed = Number(size);
  if (!Number.isFinite(parsed)) return DEFAULT_SIZE;
  return Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(parsed)));
}

function sanitizeStem(value) {
  if (!value) return "template";
  const stem = value
    .toString()
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return stem || "template";
}

function getModelFileName(path) {
  if (!path) return "";
  const parts = path.toString().split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

function createCanvas(size) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function resolveGradientAxis(bounds, axis = "diag") {
  const minX = bounds.minX;
  const minY = bounds.minY;
  const maxX = Math.max(minX + 1, bounds.maxX);
  const maxY = Math.max(minY + 1, bounds.maxY);
  const midX = (minX + maxX) * 0.5;
  const midY = (minY + maxY) * 0.5;

  switch (axis) {
    case "x":
      return [minX, midY, maxX, midY];
    case "x-reverse":
      return [maxX, midY, minX, midY];
    case "y":
      return [midX, minY, midX, maxY];
    case "y-reverse":
      return [midX, maxY, midX, minY];
    case "diag-reverse":
      return [maxX, minY, minX, maxY];
    case "diag":
    default:
      return [minX, minY, maxX, maxY];
  }
}

function createGradientFromStops(ctx, bounds, axis, stops) {
  const [x0, y0, x1, y1] = resolveGradientAxis(bounds, axis);
  const gradient = ctx.createLinearGradient(x0, y0, x1, y1);
  const safeStops = Array.isArray(stops) && stops.length > 0 ? stops : [{ t: 0, color: "#c9d8ee" }, { t: 1, color: "#8ccfd1" }];
  safeStops.forEach((stop, index) => {
    const t = clamp01(Number.isFinite(stop?.t) ? stop.t : index / Math.max(1, safeStops.length - 1));
    gradient.addColorStop(t, stop?.color || "#c9d8ee");
  });
  return gradient;
}

/* ── Color palette ───────────────────────────────────────────────── */

const ROLE_PALETTE = {
  bodyUpper: {
    wire: "rgba(16, 20, 42, 0.52)",
    primaryAxis: "x",
    primaryStops: [
      { t: 0, color: "#c48cf0" },
      { t: 0.18, color: "#e0a0d8" },
      { t: 0.44, color: "#f4b0c4" },
      { t: 0.70, color: "#f6c4a8" },
      { t: 0.90, color: "#f4d098" },
      { t: 1, color: "#93f47b" },
    ],
    secondaryAxis: "y",
    secondaryStops: [
      { t: 0, color: "rgba(178, 219, 255, 0.28)" },
      { t: 0.48, color: "rgba(255, 255, 255, 0.03)" },
      { t: 1, color: "rgba(255, 200, 230, 0.24)" },
    ],
    secondaryAlpha: 0.55,
  },
  bodyLower: {
    wire: "rgba(14, 20, 42, 0.50)",
    primaryAxis: "x-reverse",
    primaryStops: [
      { t: 0, color: "#5c8ef4" },
      { t: 0.10, color: "#48b8e8" },
      { t: 0.34, color: "#38d4d8" },
      { t: 0.58, color: "#2cccc0" },
      { t: 0.82, color: "#40dcaa" },
      { t: 1, color: "#7fee8e" },
    ],
    secondaryAxis: "y",
    secondaryStops: [
      { t: 0, color: "rgba(140, 210, 255, 0.22)" },
      { t: 0.54, color: "rgba(255, 255, 255, 0.03)" },
      { t: 1, color: "rgba(100, 248, 210, 0.22)" },
    ],
    secondaryAlpha: 0.50,
  },
  topPanel: {
    wire: "rgba(16, 22, 48, 0.46)",
    primaryAxis: "diag",
    primaryStops: [
      { t: 0, color: "#c2daff" },
      { t: 0.45, color: "#c4c8fa" },
      { t: 1, color: "#d6baf6" },
    ],
    secondaryAxis: "x",
    secondaryStops: [
      { t: 0, color: "rgba(120, 231, 217, 0.20)" },
      { t: 1, color: "rgba(220, 170, 230, 0.18)" },
    ],
    secondaryAlpha: 0.45,
  },
  frontClip: {
    wire: "rgba(16, 28, 38, 0.46)",
    primaryAxis: "x",
    primaryStops: [
      { t: 0, color: "#c8f8a8" },
      { t: 0.36, color: "#98f47c" },
      { t: 0.72, color: "#6ce8b8" },
      { t: 1, color: "#5ce0c4" },
    ],
    secondaryAxis: "diag",
    secondaryStops: [
      { t: 0, color: "rgba(255, 250, 210, 0.20)" },
      { t: 1, color: "rgba(120, 244, 210, 0.18)" },
    ],
    secondaryAlpha: 0.55,
  },
  rearPanel: {
    wire: "rgba(20, 16, 42, 0.52)",
    primaryAxis: "x",
    primaryStops: [
      { t: 0, color: "#c458e8" },
      { t: 0.40, color: "#d850d8" },
      { t: 0.75, color: "#e44cc8" },
      { t: 1, color: "#e060b8" },
    ],
    secondaryAxis: "diag-reverse",
    secondaryStops: [
      { t: 0, color: "rgba(180, 140, 255, 0.24)" },
      { t: 1, color: "rgba(245, 120, 210, 0.22)" },
    ],
    secondaryAlpha: 0.50,
  },
  trim: {
    wire: "rgba(18, 22, 44, 0.50)",
    primaryAxis: "x",
    primaryStops: [
      { t: 0, color: "#9df57a" },
      { t: 0.32, color: "#60dfcf" },
      { t: 0.68, color: "#dca2e6" },
      { t: 1, color: "#a56af1" },
    ],
    secondaryAxis: "y",
    secondaryStops: [
      { t: 0, color: "rgba(212, 230, 255, 0.20)" },
      { t: 1, color: "rgba(250, 217, 236, 0.20)" },
    ],
    secondaryAlpha: 0.45,
  },
  accent: {
    wire: "rgba(18, 24, 44, 0.46)",
    primaryAxis: "diag",
    primaryStops: [
      { t: 0, color: "#a5eef4" },
      { t: 0.38, color: "#6cd8d8" },
      { t: 0.74, color: "#e0a7e8" },
      { t: 1, color: "#b06af2" },
    ],
    secondaryAxis: "x",
    secondaryStops: [
      { t: 0, color: "rgba(152, 245, 123, 0.20)" },
      { t: 1, color: "rgba(243, 169, 218, 0.20)" },
    ],
    secondaryAlpha: 0.42,
  },
};

function deriveGlobalUvBounds(shells) {
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;

  for (const shell of shells) {
    const bounds = shell?.bounds;
    if (!bounds) continue;
    minU = Math.min(minU, bounds.minU);
    minV = Math.min(minV, bounds.minV);
    maxU = Math.max(maxU, bounds.maxU);
    maxV = Math.max(maxV, bounds.maxV);
  }

  if (!Number.isFinite(minU) || !Number.isFinite(minV) || !Number.isFinite(maxU) || !Number.isFinite(maxV)) {
    return {
      minU: 0,
      minV: 0,
      maxU: 1,
      maxV: 1,
      spanU: 1,
      spanV: 1,
    };
  }

  const spanU = Math.max(1e-6, maxU - minU);
  const spanV = Math.max(1e-6, maxV - minV);
  return { minU, minV, maxU, maxV, spanU, spanV };
}

function normalizeShellBounds(bounds, globalBounds) {
  const minX = (bounds.minU - globalBounds.minU) / globalBounds.spanU;
  const maxX = (bounds.maxU - globalBounds.minU) / globalBounds.spanU;
  const minY = (globalBounds.maxV - bounds.maxV) / globalBounds.spanV;
  const maxY = (globalBounds.maxV - bounds.minV) / globalBounds.spanV;

  const width = Math.max(1e-6, maxX - minX);
  const height = Math.max(1e-6, maxY - minY);

  return {
    minX,
    maxX,
    minY,
    maxY,
    width,
    height,
    area: width * height,
    centerX: (minX + maxX) * 0.5,
    centerY: (minY + maxY) * 0.5,
  };
}

function assignShellRoles(shells) {
  if (!Array.isArray(shells) || shells.length === 0) return [];

  const globalBounds = deriveGlobalUvBounds(shells);
  const shellStats = shells.map((shell, index) => ({
    index,
    ...normalizeShellBounds(shell.bounds || globalBounds, globalBounds),
  }));

  const roles = new Array(shells.length).fill("accent");

  const sidePanels = shellStats
    .filter((entry) => entry.width >= 0.35 && entry.area >= 0.035)
    .sort((a, b) => b.area - a.area)
    .slice(0, 2)
    .sort((a, b) => a.centerY - b.centerY);

  if (sidePanels[0]) roles[sidePanels[0].index] = "bodyUpper";
  if (sidePanels[1]) roles[sidePanels[1].index] = "bodyLower";

  const remainingByArea = shellStats
    .filter((entry) => roles[entry.index] === "accent")
    .sort((a, b) => b.area - a.area);

  for (const entry of remainingByArea) {
    if (roles[entry.index] !== "accent") continue;
    if (entry.centerY < 0.28 && entry.area >= 0.025) {
      roles[entry.index] = "topPanel";
      continue;
    }
    if (entry.centerX < 0.5 && entry.centerY < 0.5 && entry.area >= 0.015) {
      roles[entry.index] = "frontClip";
      continue;
    }
    if (entry.centerX >= 0.5 && entry.centerY < 0.52 && entry.area >= 0.015) {
      roles[entry.index] = "rearPanel";
      continue;
    }
    if (entry.width >= 0.2 && entry.height <= 0.11) {
      roles[entry.index] = "trim";
    }
  }

  return roles;
}

function getMeshPalette(role) {
  return ROLE_PALETTE[role] || ROLE_PALETTE.accent;
}

/* ── Target scoring & selection ──────────────────────────────────── */

function scoreTargetKey(key) {
  if (!key || typeof key !== "string") return 0;
  const raw = key.toLowerCase();
  let score = 0;
  if (raw.startsWith("material:")) score += 120;
  if (raw.includes("vehicle_paint") || raw.includes("carpaint") || raw.includes("car_paint")) score += 80;
  if (raw.includes("livery")) score += 75;
  if (raw.includes("sign_1") || raw.includes("sign-1") || raw.includes("sign1")) score += 65;
  if (raw.includes("decal")) score += 48;
  if (raw.includes("logo")) score += 36;
  if (raw.includes("window") || raw.includes("glass") || raw.includes("interior") || raw.includes("wheel")) {
    score -= 75;
  }
  return score;
}

function selectTemplateMeshes(templateMap, templatePsdSource, options = {}) {
  const meshes = Array.isArray(templatePsdSource?.meshes) ? templatePsdSource.meshes : [];
  if (meshes.length === 0) return [];

  const targets = templateMap?.targets && typeof templateMap.targets === "object" ? templateMap.targets : {};
  const targetKeys = Object.keys(targets);
  if (targetKeys.length === 0) return meshes;

  const forcedTarget =
    typeof options.preferredTarget === "string" ? options.preferredTarget.trim() : "";
  const inferredTarget = templateMap?.inference?.liveryTarget || "";

  const scoredTargets = targetKeys
    .filter((key) => Array.isArray(targets[key]) && targets[key].length > 0)
    .map((key) => ({ key, score: scoreTargetKey(key) }))
    .sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;
      return a.key.localeCompare(b.key);
    });

  const preferredTarget =
    forcedTarget && Array.isArray(targets[forcedTarget]) && targets[forcedTarget].length > 0
      ? forcedTarget
      : inferredTarget && Array.isArray(targets[inferredTarget]) && targets[inferredTarget].length > 0
        ? inferredTarget
        : scoredTargets[0]?.key || "";

  if (!preferredTarget) return meshes;

  const preferredScore = scoreTargetKey(preferredTarget);
  const companionThreshold = Math.max(150, preferredScore - 20);
  const candidateTargetKeys = scoredTargets
    .filter((entry) => entry.score >= companionThreshold)
    .map((entry) => entry.key);

  if (!candidateTargetKeys.includes(preferredTarget)) {
    candidateTargetKeys.unshift(preferredTarget);
  }

  const meshNames = new Set();
  for (const key of candidateTargetKeys) {
    const entries = Array.isArray(targets[key]) ? targets[key] : [];
    for (const entry of entries) {
      if (entry?.meshName) meshNames.add(entry.meshName);
    }
  }

  if (meshNames.size === 0) return meshes;

  const filtered = meshes.filter((mesh) => meshNames.has(mesh.meshName));
  return filtered.length > 0 ? filtered : meshes;
}

/* ── MaxRects bin packing ────────────────────────────────────────── */

/**
 * MaxRects-BSSF (Best Short Side Fit) bin packing algorithm.
 * This is a significant upgrade from the old shelf-packing approach.
 * It produces much tighter, more space-efficient layouts by maintaining
 * a list of free rectangles and placing each shell in the position
 * that minimizes wasted space.
 *
 * Supports rotation: if a shell fits better when rotated 90°, it will
 * be placed rotated.
 */
function maxRectsPack(rects, binWidth, binHeight) {
  const freeRects = [{ x: 0, y: 0, width: binWidth, height: binHeight }];
  const placements = [];

  // Sort rects by area descending, then by longest side
  const sorted = rects
    .map((r, i) => ({ ...r, originalIndex: i }))
    .sort((a, b) => {
      const areaDiff = b.width * b.height - a.width * a.height;
      if (Math.abs(areaDiff) > 0.01) return areaDiff;
      return Math.max(b.width, b.height) - Math.max(a.width, a.height);
    });

  for (const rect of sorted) {
    let bestScore = Infinity;
    let bestFreeIndex = -1;
    let bestX = 0;
    let bestY = 0;
    let bestRotated = false;

    for (let fi = 0; fi < freeRects.length; fi += 1) {
      const free = freeRects[fi];

      // Try normal orientation
      if (rect.width <= free.width + 0.001 && rect.height <= free.height + 0.001) {
        const shortSide = Math.min(free.width - rect.width, free.height - rect.height);
        if (shortSide < bestScore) {
          bestScore = shortSide;
          bestFreeIndex = fi;
          bestX = free.x;
          bestY = free.y;
          bestRotated = false;
        }
      }

      // Try rotated (swap width/height)
      if (rect.height <= free.width + 0.001 && rect.width <= free.height + 0.001) {
        const shortSide = Math.min(free.width - rect.height, free.height - rect.width);
        if (shortSide < bestScore) {
          bestScore = shortSide;
          bestFreeIndex = fi;
          bestX = free.x;
          bestY = free.y;
          bestRotated = true;
        }
      }
    }

    if (bestFreeIndex === -1) {
      // Doesn't fit — skip this rect
      continue;
    }

    const placedW = bestRotated ? rect.height : rect.width;
    const placedH = bestRotated ? rect.width : rect.height;

    placements.push({
      index: rect.originalIndex,
      x: bestX,
      y: bestY,
      width: placedW,
      height: placedH,
      rotated: bestRotated,
    });

    // Split free rectangles around the placed rect
    const placed = { x: bestX, y: bestY, width: placedW, height: placedH };
    const newFreeRects = [];

    for (const free of freeRects) {
      // If no intersection, keep the free rect as-is
      if (
        placed.x >= free.x + free.width ||
        placed.x + placed.width <= free.x ||
        placed.y >= free.y + free.height ||
        placed.y + placed.height <= free.y
      ) {
        newFreeRects.push(free);
        continue;
      }

      // Split into up to 4 sub-rectangles
      // Left
      if (placed.x > free.x) {
        newFreeRects.push({
          x: free.x,
          y: free.y,
          width: placed.x - free.x,
          height: free.height,
        });
      }
      // Right
      if (placed.x + placed.width < free.x + free.width) {
        newFreeRects.push({
          x: placed.x + placed.width,
          y: free.y,
          width: free.x + free.width - placed.x - placed.width,
          height: free.height,
        });
      }
      // Top
      if (placed.y > free.y) {
        newFreeRects.push({
          x: free.x,
          y: free.y,
          width: free.width,
          height: placed.y - free.y,
        });
      }
      // Bottom
      if (placed.y + placed.height < free.y + free.height) {
        newFreeRects.push({
          x: free.x,
          y: placed.y + placed.height,
          width: free.width,
          height: free.y + free.height - placed.y - placed.height,
        });
      }
    }

    // Remove redundant free rects (contained within another)
    freeRects.length = 0;
    for (let i = 0; i < newFreeRects.length; i += 1) {
      let contained = false;
      for (let j = 0; j < newFreeRects.length; j += 1) {
        if (i === j) continue;
        const a = newFreeRects[i];
        const b = newFreeRects[j];
        if (a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height) {
          contained = true;
          break;
        }
      }
      if (!contained) freeRects.push(newFreeRects[i]);
    }
  }

  return placements;
}

/* ── Direct UV → pixel mapping ───────────────────────────────────── */

/**
 * Create the shell mapper that transforms UV coordinates directly to
 * pixel positions on the template canvas.  Shells are rendered at
 * their original UV-space positions — the same layout a human
 * template artist would produce — instead of being bin-packed.
 */
function createShellMapper(size, shells) {
  if (!Array.isArray(shells) || shells.length === 0) return null;

  const maxCoord = Math.max(1, size - 1);

  // Preserve the original texture-space mapping exactly:
  // u=0/v=0 maps to texture edge, u=1/v=1 maps to opposite edge.
  const mapU = (u) => clamp01(u) * maxCoord;
  const mapV = (v) => (1 - clamp01(v)) * maxCoord;

  const toPoint = (_shellIndex, u, v) => [mapU(u), mapV(v)];

  const mapBounds = (shellIndex) => {
    const shell = shells[shellIndex];
    if (!shell?.bounds) {
      return { minX: 0, minY: 0, maxX: maxCoord, maxY: maxCoord };
    }
    const b = shell.bounds;
    return {
      minX: mapU(b.minU),
      minY: mapV(b.maxV),
      maxX: mapU(b.maxU),
      maxY: mapV(b.minV),
    };
  };

  return {
    toPoint,
    mapBounds,
    placedCount: shells.length,
    globalBounds: { minU: 0, minV: 0, maxU: 1, maxV: 1, spanU: 1, spanV: 1 },
  };
}

/* ── Canvas dilation (UV island padding) ──────────────────────────── */

/**
 * Expand painted (non-transparent) pixels outward into adjacent
 * transparent regions only.  Uses `destination-over` compositing
 * so dilated colour is drawn BEHIND existing content — existing
 * painted pixels are never overwritten and shells keep sharp,
 * clean edges with no colour-bleed halos.
 *
 * Each iteration expands the painted region by 1 pixel in all
 * 8 directions.  Only fully-transparent areas receive new colour.
 */
function dilateCanvas(canvas, iterations) {
  const { width, height } = canvas;
  if (iterations <= 0) return canvas;

  const temp = createCanvas(width);
  temp.height = height;
  const tempCtx = temp.getContext("2d");
  const ctx = canvas.getContext("2d");

  for (let i = 0; i < iterations; i += 1) {
    // Build the 1-pixel-expanded fringe on a temp canvas.
    tempCtx.clearRect(0, 0, width, height);
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        tempCtx.drawImage(canvas, dx, dy);
      }
    }

    // Composite the fringe BEHIND the existing canvas content.
    // This fills only transparent gaps; painted pixels stay pristine.
    ctx.globalCompositeOperation = "destination-over";
    ctx.drawImage(temp, 0, 0);
    ctx.globalCompositeOperation = "source-over";
  }

  return canvas;
}

/**
 * Returns a dilation iteration count appropriate for the given
 * texture size.  Larger textures need more pixel iterations to
 * cover the same proportional UV-space gap.
 */
function dilateSizeForCanvas(size) {
  // ~4 px at 1024, ~8 px at 2048, ~14 px at 4096
  return Math.max(4, Math.round(size * 0.004));
}

/* ── Layer painting ──────────────────────────────────────────────── */

function paintBackgroundLayer(canvas) {
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "rgb(0, 0, 0)";
  ctx.fillRect(0, 0, width, height);

  return canvas;
}

function fillShellTriangles(ctx, triangles, mapper, shellIndex, edgeBleed = 0) {
  const safeBleed = Number.isFinite(edgeBleed) ? Math.max(0, edgeBleed) : 0;

  for (let i = 0; i + 5 < triangles.length; i += 6) {
    const [x0, y0] = mapper.toPoint(shellIndex, triangles[i], triangles[i + 1]);
    const [x1, y1] = mapper.toPoint(shellIndex, triangles[i + 2], triangles[i + 3]);
    const [x2, y2] = mapper.toPoint(shellIndex, triangles[i + 4], triangles[i + 5]);

    const area = Math.abs((x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)) * 0.5;
    if (!Number.isFinite(area) || area < MIN_TRIANGLE_AREA_PIXELS) continue;

    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.closePath();
    ctx.fill();

    if (safeBleed > 0) {
      ctx.lineWidth = safeBleed;
      ctx.stroke();
    }
  }
}

function paintMeshFillLayer(canvas, shells, mapper) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const shellRoles = assignShellRoles(shells);

  shells.forEach((shell, index) => {
    const triangles = Array.isArray(shell?.triangles) ? shell.triangles : [];
    if (triangles.length < 6) return;

    const role = shellRoles[index] || "accent";
    const palette = getMeshPalette(role);
    const shellBounds = mapper.mapBounds(index);

    ctx.fillStyle = createGradientFromStops(
      ctx,
      shellBounds,
      palette.primaryAxis || "diag",
      palette.primaryStops,
    );
    fillShellTriangles(ctx, triangles, mapper, index, 0);

    if (Array.isArray(palette.secondaryStops) && palette.secondaryStops.length > 0) {
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.globalAlpha = clamp01(
        Number.isFinite(palette.secondaryAlpha) ? palette.secondaryAlpha : 0.5,
      );
      ctx.fillStyle = createGradientFromStops(
        ctx,
        shellBounds,
        palette.secondaryAxis || "y",
        palette.secondaryStops,
      );
      fillShellTriangles(ctx, triangles, mapper, index, 0);
      ctx.restore();
    }
  });

  return canvas;
}

function paintWireframeLayer(canvas, shells, mapper) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const shellRoles = assignShellRoles(shells);
  const baseWidth = Math.max(0.52, canvas.width * 0.00042);

  shells.forEach((shell, index) => {
    const triangles = Array.isArray(shell?.triangles) ? shell.triangles : [];
    if (triangles.length < 6) return;

    const role = shellRoles[index] || "accent";
    const palette = getMeshPalette(role);
    ctx.strokeStyle = palette.wire;

    const bounds = mapper.mapBounds(index);
    const shellSize = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
    ctx.lineWidth = shellSize < 56 ? baseWidth * 1.28 : baseWidth;

    for (let i = 0; i + 5 < triangles.length; i += 6) {
      const [x0, y0] = mapper.toPoint(index, triangles[i], triangles[i + 1]);
      const [x1, y1] = mapper.toPoint(index, triangles[i + 2], triangles[i + 3]);
      const [x2, y2] = mapper.toPoint(index, triangles[i + 4], triangles[i + 5]);

      const area = Math.abs((x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)) * 0.5;
      if (!Number.isFinite(area) || area < MIN_TRIANGLE_AREA_PIXELS) continue;

      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.closePath();
      ctx.stroke();
    }
  });

  return canvas;
}

function paintAnnotationLayer(canvas, modelName, targetCount, meshCount) {
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;

  ctx.clearRect(0, 0, width, height);

  const scale = width / 2048;
  const calloutX = Math.round(248 * scale);
  const calloutY = Math.round(1296 * scale);
  const calloutFont = Math.max(9, Math.round(11 * scale));
  const lineGap = Math.max(10, Math.round(13 * scale));

  ctx.fillStyle = "rgba(244, 247, 252, 0.86)";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = `bold ${calloutFont}px "Share Tech Mono", monospace`;

  const notes = [
    "PAINTABLE TRIMS BELOW ARE TO BE LEFT AS DEFAULT OEM COLOURS",
    "UNLESS OTHERWISE USED BY DEPARTMENTAL LIVERIES",
    "MUST BE FILLED AND COPIED ONTO YOUR LIVERY",
  ];

  notes.forEach((line, index) => {
    ctx.fillText(line, calloutX, calloutY + index * lineGap);
  });

  ctx.fillStyle = "rgba(230, 236, 246, 0.68)";
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.font = `${Math.max(8, Math.round(width * 0.0072))}px "Share Tech Mono", monospace`;
  ctx.fillText(
    `${modelName} | ${meshCount} UV shells | ${targetCount} targets`,
    width - Math.round(width * 0.018),
    height - Math.round(height * 0.012),
  );

  return canvas;
}

/* ── Licence plate labels ────────────────────────────────────────── */

function paintLicencePlateLayer(canvas) {
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;

  ctx.clearRect(0, 0, width, height);

  const scale = width / 2048;
  const plateW = Math.round(248 * scale);
  const plateH = Math.round(122 * scale);
  const gap = Math.round(14 * scale);
  const marginL = Math.round(16 * scale);
  const marginB = Math.round(330 * scale);
  const radius = Math.max(5, Math.round(8 * scale));

  const plateX = marginL;
  const frontY = height - marginB;
  const backY = frontY - gap - plateH;

  const drawRoundedRect = (x, y, w, h, r) => {
    const rr = Math.min(r, w * 0.5, h * 0.5);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.arcTo(x + w, y, x + w, y + rr, rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
    ctx.lineTo(x + rr, y + h);
    ctx.arcTo(x, y + h, x, y + h - rr, rr);
    ctx.lineTo(x, y + rr);
    ctx.arcTo(x, y, x + rr, y, rr);
    ctx.closePath();
  };

  const drawPlate = (label, y) => {
    drawRoundedRect(plateX, y, plateW, plateH, radius);
    ctx.fillStyle = "rgba(251, 253, 255, 0.98)";
    ctx.fill();

    ctx.lineWidth = Math.max(2, 2.8 * scale);
    ctx.strokeStyle = "rgba(20, 20, 22, 0.95)";
    ctx.stroke();

    const slotW = Math.round(16 * scale);
    const slotH = Math.round(5 * scale);
    const slotOffsetX = Math.round(36 * scale);
    const slotGap = Math.round(152 * scale);
    const slotTop = y + Math.round(11 * scale);
    const slotBottom = y + plateH - Math.round(16 * scale);

    ctx.fillStyle = "rgba(21, 21, 23, 0.95)";
    for (const x of [plateX + slotOffsetX, plateX + slotOffsetX + slotGap]) {
      drawRoundedRect(x, slotTop, slotW, slotH, Math.round(2 * scale));
      ctx.fill();
      drawRoundedRect(x, slotBottom, slotW, slotH, Math.round(2 * scale));
      ctx.fill();
    }

    ctx.fillStyle = "rgba(10, 10, 11, 0.96)";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = `800 ${Math.max(30, Math.round(56 * scale))}px "Outfit", "Arial Black", sans-serif`;
    ctx.fillText(label, plateX + Math.round(36 * scale), y + Math.round(22 * scale));

    ctx.font = `700 ${Math.max(11, Math.round(35 * scale * 0.42))}px "Outfit", "Arial Narrow", sans-serif`;
    ctx.fillText("LICENCE PLATE", plateX + Math.round(36 * scale), y + Math.round(82 * scale));
  };

  drawPlate("BACK", backY);
  drawPlate("FRONT", frontY);

  return canvas;
}

/* ── Color reference swatches ────────────────────────────────────── */

function paintColorSwatchLayer(canvas, templateMap) {
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;

  ctx.clearRect(0, 0, width, height);
  void templateMap;

  const scale = width / 2048;
  const plateX = Math.round(16 * scale);
  const plateW = Math.round(248 * scale);
  const swatchX = plateX + plateW + Math.round(18 * scale);
  const swatchYStart = height - Math.round(324 * scale);
  const swatchSize = Math.round(48 * scale);
  const swatchGap = Math.round(66 * scale);

  const swatches = [
    {
      color: "#030303",
      label: "BOOT SPOILER UPPER COLOUR",
      value: "(ALWAYS BLACK)",
    },
    {
      color: "#1dff25",
      label: "DOORSHUTS COLOUR",
      value: "(ALWAYS BODY COLOUR)",
    },
  ];

  swatches.forEach((entry, index) => {
    const y = swatchYStart + index * swatchGap;

    ctx.fillStyle = entry.color;
    ctx.fillRect(swatchX, y, swatchSize, swatchSize);
    ctx.strokeStyle = "rgba(236, 242, 251, 0.96)";
    ctx.lineWidth = Math.max(1.2, 1.8 * scale);
    ctx.strokeRect(swatchX, y, swatchSize, swatchSize);

    ctx.fillStyle = "rgba(244, 248, 252, 0.92)";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = `600 ${Math.max(10, Math.round(20 * scale * 0.52))}px "Outfit", "Share Tech Mono", sans-serif`;
    ctx.fillText(entry.label, swatchX + swatchSize + Math.round(8 * scale), y + Math.round(3 * scale));

    ctx.fillStyle = "rgba(226, 233, 244, 0.84)";
    ctx.font = `600 ${Math.max(9, Math.round(16 * scale * 0.5))}px "Outfit", "Share Tech Mono", sans-serif`;
    ctx.fillText(
      entry.value,
      swatchX + swatchSize + Math.round(8 * scale),
      y + Math.round(3 * scale) + Math.max(10, Math.round(20 * scale * 0.52)) + Math.round(3 * scale),
    );
  });

  return canvas;
}

/* ── Preview compositing ─────────────────────────────────────────── */

function renderPreview(size, layers) {
  const preview = createCanvas(size);
  const ctx = preview.getContext("2d");

  for (const layer of layers) {
    if (layer?.hidden) continue;
    ctx.drawImage(layer.canvas, 0, 0);
  }

  return preview.toDataURL("image/png");
}

/* ── Validation ──────────────────────────────────────────────────── */

function validatePsdSource(templatePsdSource) {
  if (!templatePsdSource || typeof templatePsdSource !== "object") {
    throw new Error("Template UV source is required.");
  }

  const meshes = Array.isArray(templatePsdSource.meshes) ? templatePsdSource.meshes : [];
  if (meshes.length === 0) {
    throw new Error("Template UV source contains no meshes.");
  }

  const hasTriangles = meshes.some((mesh) => Array.isArray(mesh?.triangles) && mesh.triangles.length >= 6);
  if (!hasTriangles) {
    throw new Error("Template UV source has no renderable UV triangles.");
  }
}

/* ── Main entry point ────────────────────────────────────────────── */

export function buildAutoTemplatePsd(templateMap, options = {}) {
  if (!templateMap || typeof templateMap !== "object") {
    throw new Error("Template map is required.");
  }

  const templatePsdSource = options.templatePsdSource;
  validatePsdSource(templatePsdSource);

  const size = clampSize(options.size ?? DEFAULT_SIZE);
  const modelFileName =
    options.modelFileName ||
    templateMap?.source?.fileName ||
    templatePsdSource?.source?.fileName ||
    getModelFileName(options.modelPath || "");
  const modelName = sanitizeStem(modelFileName || templateMap?.source?.modelName || "template");

  const targetCount = Object.keys(templateMap?.targets || {}).length;
  const selectedMeshes = selectTemplateMeshes(templateMap, templatePsdSource, {
    preferredTarget: options.preferredTarget,
  });
  if (selectedMeshes.length === 0) {
    throw new Error("Template UV source has no eligible shell geometry.");
  }

  const mapper = createShellMapper(size, selectedMeshes);
  if (!mapper) {
    throw new Error("Failed to layout UV shells for template export.");
  }

  const backgroundCanvas = paintBackgroundLayer(createCanvas(size));
  const fillCanvas = paintMeshFillLayer(createCanvas(size), selectedMeshes, mapper);
  const wireCanvas = paintWireframeLayer(createCanvas(size), selectedMeshes, mapper);
  const annotationCanvas = paintAnnotationLayer(createCanvas(size), modelName, targetCount, selectedMeshes.length);
  const plateCanvas = paintLicencePlateLayer(createCanvas(size));
  const swatchCanvas = paintColorSwatchLayer(createCanvas(size), templateMap);

  const layers = [
    { name: "_BG_BLACK", canvas: backgroundCanvas },
    { name: "_UV_FILL", canvas: fillCanvas },
    { name: "_UV_WIREFRAME", canvas: wireCanvas },
    { name: "_ANNOTATIONS", canvas: annotationCanvas, hidden: true },
    { name: "_LICENCE_PLATES", canvas: plateCanvas, hidden: true },
    { name: "_COLOR_REFS", canvas: swatchCanvas, hidden: true },
  ];

  const psd = {
    width: size,
    height: size,
    children: layers,
  };

  const bytes = writePsdUint8Array(psd);
  const previewDataUrl = renderPreview(size, layers);

  return {
    bytes,
    size,
    layerCount: layers.length,
    previewDataUrl,
    fileName: `${modelName}_auto_template.psd`,
    targetCount,
  };
}
