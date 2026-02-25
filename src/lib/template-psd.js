import { writePsdUint8Array } from "ag-psd";

/* ── Constants ───────────────────────────────────────────────────── */

const DEFAULT_SIZE = 2048;
const MIN_SIZE = 256;
const MAX_SIZE = 8192;
const MIN_TRIANGLE_AREA_PIXELS = 0.005;
const AUTO_TEMPLATE_FILL_COLOR = "rgb(201, 216, 238)";

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

const UV_EPSILON = 1e-8;
const VERTEX_KEY_SCALE = 1e6;
const CLEAN_AXIS_ALIGNMENT_THRESHOLD = 0.93;
const SMALL_SHELL_MAX_TRIANGLES = 180;
const SMALL_SHELL_MAX_ASPECT = 4.8;
const SMALL_SHELL_MAX_DIM_RATIO = 96 / 2048;
const SMALL_SHELL_INNER_BOX_RATIO = 0.16;
const MIN_INTERIOR_EDGE_LENGTH_PX = 5;


/* ── Per-island palette + gradient helpers ───────────────────────── */

const ISLAND_PALETTES = [
  {
    left: { h: 274, s: 0.58, v: 0.92 },
    right: { h: 214, s: 0.56, v: 0.94 },
  },
  {
    left: { h: 326, s: 0.64, v: 0.92 },
    right: { h: 28, s: 0.64, v: 0.93 },
  },
  {
    left: { h: 188, s: 0.69, v: 0.89 },
    right: { h: 132, s: 0.62, v: 0.92 },
  },
  {
    left: { h: 314, s: 0.67, v: 0.9 },
    right: { h: 272, s: 0.66, v: 0.89 },
  },
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function stableHash64(value) {
  const input = String(value ?? "");
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;

  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & mask;
  }

  return hash;
}

function hashSliceUnit(hash, shiftBits) {
  const shifted = hash >> BigInt(shiftBits);
  const sample = Number(shifted & 0xffffn);
  return sample / 65535;
}

function buildIslandKey(shell, shellIndex) {
  const meshName = shell?.meshName || "mesh";
  const shellName = shell?.shellName;
  if (shellName && typeof shellName === "string") return shellName;
  const localIndex = Number.isFinite(shell?.shellIndex) ? shell.shellIndex : shellIndex;
  return `${meshName}::${localIndex}`;
}

function hueLerp(h0, h1, t) {
  const dh = (((h1 - h0) % 360) + 540) % 360 - 180;
  return (h0 + dh * t + 360) % 360;
}

function hsvToRgb(h, s, v) {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp(s, 0, 1);
  const val = clamp(v, 0, 1);

  const c = val * sat;
  const hp = hue / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = val - c;

  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (hp >= 0 && hp < 1) {
    r1 = c;
    g1 = x;
  } else if (hp < 2) {
    r1 = x;
    g1 = c;
  } else if (hp < 3) {
    g1 = c;
    b1 = x;
  } else if (hp < 4) {
    g1 = x;
    b1 = c;
  } else if (hp < 5) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }

  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

function hsvToCss(h, s, v) {
  const rgb = hsvToRgb(h, s, v);
  return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
}

function getIslandPalette(shell, shellIndex) {
  const islandKey = buildIslandKey(shell, shellIndex);
  const hash = stableHash64(islandKey);
  const paletteIndex = Number(hash % BigInt(ISLAND_PALETTES.length));
  const base = ISLAND_PALETTES[paletteIndex];

  const hueOffset = hashSliceUnit(hash, 8) * 16 - 8;
  const satOffset = hashSliceUnit(hash, 24) * 0.06 - 0.03;
  const valOffset = hashSliceUnit(hash, 40) * 0.04 - 0.02;

  const left = {
    h: (base.left.h + hueOffset + 360) % 360,
    s: clamp(base.left.s + satOffset, 0.55, 0.75),
    v: clamp(base.left.v + valOffset, 0.85, 0.95),
  };
  const right = {
    h: (base.right.h + hueOffset + 360) % 360,
    s: clamp(base.right.s + satOffset, 0.55, 0.75),
    v: clamp(base.right.v + valOffset, 0.85, 0.95),
  };

  return { left, right };
}

function collectShellUvPoints(triangles) {
  const points = [];
  for (let i = 0; i + 5 < triangles.length; i += 6) {
    points.push([triangles[i], triangles[i + 1]]);
    points.push([triangles[i + 2], triangles[i + 3]]);
    points.push([triangles[i + 4], triangles[i + 5]]);
  }
  return points;
}

function computeUvBounds(points) {
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;

  for (const [u, v] of points) {
    minU = Math.min(minU, u);
    minV = Math.min(minV, v);
    maxU = Math.max(maxU, u);
    maxV = Math.max(maxV, v);
  }

  if (!Number.isFinite(minU) || !Number.isFinite(minV) || !Number.isFinite(maxU) || !Number.isFinite(maxV)) {
    return { minU: 0, minV: 0, maxU: 1, maxV: 1, spanU: 1, spanV: 1 };
  }

  return {
    minU,
    minV,
    maxU,
    maxV,
    spanU: Math.max(UV_EPSILON, maxU - minU),
    spanV: Math.max(UV_EPSILON, maxV - minV),
  };
}

function normalizeLocalUvPoint(u, v, bounds) {
  return {
    uL: (u - bounds.minU) / bounds.spanU,
    vL: (v - bounds.minV) / bounds.spanV,
  };
}

function computePrincipalAxis(points) {
  if (!Array.isArray(points) || points.length < 2) return null;

  let meanU = 0;
  let meanV = 0;
  for (const [u, v] of points) {
    meanU += u;
    meanV += v;
  }
  meanU /= points.length;
  meanV /= points.length;

  let covUU = 0;
  let covUV = 0;
  let covVV = 0;
  for (const [u, v] of points) {
    const du = u - meanU;
    const dv = v - meanV;
    covUU += du * du;
    covUV += du * dv;
    covVV += dv * dv;
  }

  covUU /= Math.max(1, points.length);
  covUV /= Math.max(1, points.length);
  covVV /= Math.max(1, points.length);

  const trace = covUU + covVV;
  const det = covUU * covVV - covUV * covUV;
  const disc = Math.max(0, trace * trace - 4 * det);
  const lambda = (trace + Math.sqrt(disc)) * 0.5;

  let axisU = 0;
  let axisV = 0;
  if (Math.abs(covUV) > UV_EPSILON) {
    axisU = lambda - covVV;
    axisV = covUV;
  } else if (covUU >= covVV) {
    axisU = 1;
    axisV = 0;
  } else {
    axisU = 0;
    axisV = 1;
  }

  const axisLength = Math.hypot(axisU, axisV);
  if (!Number.isFinite(axisLength) || axisLength < UV_EPSILON) return null;

  axisU /= axisLength;
  axisV /= axisLength;

  if (Math.abs(axisU) >= Math.abs(axisV)) {
    if (axisU < 0) {
      axisU *= -1;
      axisV *= -1;
    }
  } else if (axisV < 0) {
    axisU *= -1;
    axisV *= -1;
  }

  return [axisU, axisV];
}

function buildIslandGradient(ctx, shell, shellIndex, triangles, mapper) {
  const uvPoints = collectShellUvPoints(triangles);
  const uvBounds = computeUvBounds(uvPoints);
  if (uvPoints.length === 0) {
    return "rgb(201, 216, 238)";
  }

  let sumU = 0;
  let sumV = 0;
  let localMinU = Infinity;
  let localMinV = Infinity;
  let localMaxU = -Infinity;
  let localMaxV = -Infinity;

  for (const [u, v] of uvPoints) {
    sumU += u;
    sumV += v;
    const local = normalizeLocalUvPoint(u, v, uvBounds);
    localMinU = Math.min(localMinU, local.uL);
    localMinV = Math.min(localMinV, local.vL);
    localMaxU = Math.max(localMaxU, local.uL);
    localMaxV = Math.max(localMaxV, local.vL);
  }

  const centerU = sumU / uvPoints.length;
  const centerV = sumV / uvPoints.length;

  let axis = computePrincipalAxis(uvPoints);
  if (!axis) {
    const localSpanU = Math.max(UV_EPSILON, localMaxU - localMinU);
    const localSpanV = Math.max(UV_EPSILON, localMaxV - localMinV);
    axis = localSpanU >= localSpanV ? [1, 0] : [0, 1];
  }

  const axisPxRaw = [axis[0], -axis[1]];
  const axisPxLength = Math.hypot(axisPxRaw[0], axisPxRaw[1]);
  const axisPx = axisPxLength > UV_EPSILON
    ? [axisPxRaw[0] / axisPxLength, axisPxRaw[1] / axisPxLength]
    : [1, 0];

  const [centerX, centerY] = mapper.toPoint(shellIndex, centerU, centerV);

  let minProj = Infinity;
  let maxProj = -Infinity;
  for (const [u, v] of uvPoints) {
    const [px, py] = mapper.toPoint(shellIndex, u, v);
    const projection = (px - centerX) * axisPx[0] + (py - centerY) * axisPx[1];
    minProj = Math.min(minProj, projection);
    maxProj = Math.max(maxProj, projection);
  }

  if (!Number.isFinite(minProj) || !Number.isFinite(maxProj) || maxProj - minProj < 1) {
    const horizontal = uvBounds.spanU >= uvBounds.spanV;
    const shellBounds = mapper.mapBounds(shellIndex);
    const x0 = shellBounds.minX;
    const x1 = horizontal ? shellBounds.maxX : shellBounds.minX;
    const y0 = horizontal ? shellBounds.minY : shellBounds.maxY;
    const y1 = shellBounds.minY;

    const fallbackPalette = getIslandPalette(shell, shellIndex);
    const fallbackGradient = ctx.createLinearGradient(x0, y0, x1, y1);
    fallbackGradient.addColorStop(0, hsvToCss(fallbackPalette.left.h, fallbackPalette.left.s, fallbackPalette.left.v));
    fallbackGradient.addColorStop(1, hsvToCss(fallbackPalette.right.h, fallbackPalette.right.s, fallbackPalette.right.v));
    return fallbackGradient;
  }

  const startX = centerX + axisPx[0] * minProj;
  const startY = centerY + axisPx[1] * minProj;
  const endX = centerX + axisPx[0] * maxProj;
  const endY = centerY + axisPx[1] * maxProj;

  const palette = getIslandPalette(shell, shellIndex);

  const gradient = ctx.createLinearGradient(startX, startY, endX, endY);
  gradient.addColorStop(0, hsvToCss(palette.left.h, palette.left.s, palette.left.v));
  gradient.addColorStop(
    0.5,
    hsvToCss(
      hueLerp(palette.left.h, palette.right.h, 0.5),
      palette.left.s + (palette.right.s - palette.left.s) * 0.5,
      palette.left.v + (palette.right.v - palette.left.v) * 0.5,
    ),
  );
  gradient.addColorStop(1, hsvToCss(palette.right.h, palette.right.s, palette.right.v));

  return gradient;
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

  shells.forEach((shell, index) => {
    const triangles = Array.isArray(shell?.triangles) ? shell.triangles : [];
    if (triangles.length < 6) return;

    ctx.fillStyle = AUTO_TEMPLATE_FILL_COLOR;
    fillShellTriangles(ctx, triangles, mapper, index, 0);
  });

  return canvas;
}

function quantizeUvKey(u, v) {
  return `${Math.round(u * VERTEX_KEY_SCALE)},${Math.round(v * VERTEX_KEY_SCALE)}`;
}

function extractShellTopology(triangles) {
  const vertices = [];
  const vertexLookup = new Map();
  const edgesByKey = new Map();
  let triangleCount = 0;

  const getVertexId = (u, v) => {
    const key = quantizeUvKey(u, v);
    const existing = vertexLookup.get(key);
    if (Number.isInteger(existing)) return existing;
    const id = vertices.length;
    vertices.push([u, v]);
    vertexLookup.set(key, id);
    return id;
  };

  const addEdge = (a, b) => {
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) return;
    const low = Math.min(a, b);
    const high = Math.max(a, b);
    const key = `${low}:${high}`;
    const existing = edgesByKey.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }

    const va = vertices[low];
    const vb = vertices[high];
    if (!va || !vb) return;

    edgesByKey.set(key, {
      a: low,
      b: high,
      count: 1,
      u0: va[0],
      v0: va[1],
      u1: vb[0],
      v1: vb[1],
    });
  };

  for (let i = 0; i + 5 < triangles.length; i += 6) {
    const u0 = triangles[i];
    const v0 = triangles[i + 1];
    const u1 = triangles[i + 2];
    const v1 = triangles[i + 3];
    const u2 = triangles[i + 4];
    const v2 = triangles[i + 5];

    if (![u0, v0, u1, v1, u2, v2].every((value) => Number.isFinite(value))) {
      continue;
    }

    const a = getVertexId(u0, v0);
    const b = getVertexId(u1, v1);
    const c = getVertexId(u2, v2);

    triangleCount += 1;
    addEdge(a, b);
    addEdge(b, c);
    addEdge(c, a);
  }

  return {
    triangleCount,
    vertices,
    edges: [...edgesByKey.values()],
  };
}

function appendSegment(segments, u0, v0, u1, v1) {
  if (![u0, v0, u1, v1].every((value) => Number.isFinite(value))) return;
  segments.push(u0, v0, u1, v1);
}

function appendLoopSegments(segments, loopPoints) {
  if (!Array.isArray(loopPoints) || loopPoints.length < 2) return;
  for (let i = 0; i < loopPoints.length; i += 1) {
    const current = loopPoints[i];
    const next = loopPoints[(i + 1) % loopPoints.length];
    if (!current || !next) continue;
    appendSegment(segments, current[0], current[1], next[0], next[1]);
  }
}

function normalizeDirection(u0, v0, u1, v1) {
  const dx = u1 - u0;
  const dy = v1 - v0;
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length <= UV_EPSILON) return null;
  return { dx: dx / length, dy: dy / length, length };
}

function dot2(ax, ay, bx, by) {
  return ax * bx + ay * by;
}

function buildOrientedBoxSegments(points, principalAxis) {
  if (!Array.isArray(points) || points.length < 2) return [];

  let centerU = 0;
  let centerV = 0;
  for (const [u, v] of points) {
    centerU += u;
    centerV += v;
  }
  centerU /= points.length;
  centerV /= points.length;

  const axis = principalAxis || [1, 0];
  const axisU = [axis[0], axis[1]];
  const axisV = [-axisU[1], axisU[0]];

  let minProjU = Infinity;
  let minProjV = Infinity;
  let maxProjU = -Infinity;
  let maxProjV = -Infinity;

  for (const [u, v] of points) {
    const du = u - centerU;
    const dv = v - centerV;
    const projU = dot2(du, dv, axisU[0], axisU[1]);
    const projV = dot2(du, dv, axisV[0], axisV[1]);
    minProjU = Math.min(minProjU, projU);
    minProjV = Math.min(minProjV, projV);
    maxProjU = Math.max(maxProjU, projU);
    maxProjV = Math.max(maxProjV, projV);
  }

  if (![minProjU, minProjV, maxProjU, maxProjV].every((value) => Number.isFinite(value))) {
    return [];
  }

  const spanU = maxProjU - minProjU;
  const spanV = maxProjV - minProjV;
  if (spanU <= UV_EPSILON || spanV <= UV_EPSILON) return [];

  const toWorld = (projU, projV) => [
    centerU + axisU[0] * projU + axisV[0] * projV,
    centerV + axisU[1] * projU + axisV[1] * projV,
  ];

  const outerLoop = [
    toWorld(minProjU, minProjV),
    toWorld(maxProjU, minProjV),
    toWorld(maxProjU, maxProjV),
    toWorld(minProjU, maxProjV),
  ];

  const segments = [];
  appendLoopSegments(segments, outerLoop);

  const insetU = spanU * SMALL_SHELL_INNER_BOX_RATIO;
  const insetV = spanV * SMALL_SHELL_INNER_BOX_RATIO;
  const innerMinU = minProjU + insetU;
  const innerMaxU = maxProjU - insetU;
  const innerMinV = minProjV + insetV;
  const innerMaxV = maxProjV - insetV;

  if (innerMaxU - innerMinU > UV_EPSILON && innerMaxV - innerMinV > UV_EPSILON) {
    const innerLoop = [
      toWorld(innerMinU, innerMinV),
      toWorld(innerMaxU, innerMinV),
      toWorld(innerMaxU, innerMaxV),
      toWorld(innerMinU, innerMaxV),
    ];

    appendLoopSegments(segments, innerLoop);

    for (let i = 0; i < outerLoop.length; i += 1) {
      appendSegment(
        segments,
        outerLoop[i][0],
        outerLoop[i][1],
        innerLoop[i][0],
        innerLoop[i][1],
      );
    }
  }

  return segments;
}

/**
 * Reconstruct quad-cage wireframe from a triangulated UV shell.
 *
 * Vehicle .yft meshes are originally quad SubD cages that get
 * triangulated for rendering.  Each original quad becomes two
 * triangles sharing a diagonal edge.  This function greedily pairs
 * adjacent triangles back into quads and removes the diagonal,
 * keeping only the quad perimeter edges — producing the clean,
 * boxy wireframe expected by livery artists.
 *
 * Algorithm:
 *  1. Build vertex + triangle lists from the flat UV array.
 *  2. Build edge → triangle adjacency.
 *  3. For every interior edge shared by exactly 2 triangles,
 *     evaluate the quad they would form (convexity + aspect).
 *  4. Greedily match best-quality pairs first; mark shared edge
 *     as a diagonal to be hidden.
 *  5. Emit all non-diagonal edges as line segments.
 */
function buildCleanWireSegments(shell, size) {
  const triangles = Array.isArray(shell?.triangles) ? shell.triangles : [];
  if (triangles.length < 6) return [];

  const pixelScale = Math.max(1, size - 1);

  /* ── 1.  Parse triangles into indexed vertex / face lists ────── */
  const vertices = [];
  const vertexLookup = new Map();
  const triList = []; // [[vId0, vId1, vId2], …]

  const getVertexId = (u, v) => {
    const key = quantizeUvKey(u, v);
    const existing = vertexLookup.get(key);
    if (Number.isInteger(existing)) return existing;
    const id = vertices.length;
    vertices.push([u, v]);
    vertexLookup.set(key, id);
    return id;
  };

  for (let i = 0; i + 5 < triangles.length; i += 6) {
    const u0 = triangles[i];
    const v0 = triangles[i + 1];
    const u1 = triangles[i + 2];
    const v1 = triangles[i + 3];
    const u2 = triangles[i + 4];
    const v2 = triangles[i + 5];
    if (![u0, v0, u1, v1, u2, v2].every((val) => Number.isFinite(val))) continue;
    const a = getVertexId(u0, v0);
    const b = getVertexId(u1, v1);
    const c = getVertexId(u2, v2);
    if (a === b || b === c || a === c) continue;
    triList.push([a, b, c]);
  }

  if (triList.length === 0) return [];
  if (vertices.length < 3) {
    const principalAxis = computePrincipalAxis(vertices) || [1, 0];
    return buildOrientedBoxSegments(vertices, principalAxis);
  }

  /* Degenerate shell — fall back to oriented bounding box */
  if (triList.length <= 2) {
    const principalAxis = computePrincipalAxis(vertices) || [1, 0];
    return buildOrientedBoxSegments(vertices, principalAxis);
  }

  /* ── 2.  Build edge → triangle adjacency ─────────────────────── */
  const makeEdgeKey = (a, b) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return (lo << 20) | hi; // safe for meshes with < ~1 M unique verts
  };

  const edgeTriMap = new Map();   // edgeKey → { lo, hi, tris: [triIdx…] }

  for (let ti = 0; ti < triList.length; ti += 1) {
    const [a, b, c] = triList[ti];
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const key = makeEdgeKey(p, q);
      let entry = edgeTriMap.get(key);
      if (!entry) {
        entry = { lo: Math.min(p, q), hi: Math.max(p, q), tris: [] };
        edgeTriMap.set(key, entry);
      }
      entry.tris.push(ti);
    }
  }

  /* ── 3.  Score candidate quad pairs ──────────────────────────── */
  const candidates = [];

  for (const edge of edgeTriMap.values()) {
    if (edge.tris.length !== 2) continue;
    const [ti0, ti1] = edge.tris;
    const tri0 = triList[ti0];
    const tri1 = triList[ti1];

    const lo = edge.lo;
    const hi = edge.hi;
    const opp0 = tri0.find((v) => v !== lo && v !== hi);
    const opp1 = tri1.find((v) => v !== lo && v !== hi);
    if (opp0 === undefined || opp1 === undefined || opp0 === opp1) continue;

    /* Quad vertex ring: opp0 → lo → opp1 → hi */
    const qp = [vertices[opp0], vertices[lo], vertices[opp1], vertices[hi]];

    /* Convexity — count cross-product signs around the ring */
    let positiveCount = 0;
    for (let i = 0; i < 4; i += 1) {
      const prev = qp[(i + 3) & 3];
      const curr = qp[i];
      const next = qp[(i + 1) & 3];
      const cross =
        (curr[0] - prev[0]) * (next[1] - curr[1]) -
        (curr[1] - prev[1]) * (next[0] - curr[0]);
      if (cross > 0) positiveCount += 1;
    }
    const sameSignCount = Math.max(positiveCount, 4 - positiveCount);
    if (sameSignCount < 3) continue; // reject badly non-convex

    /* Side-length regularity */
    const s0 = Math.hypot(qp[1][0] - qp[0][0], qp[1][1] - qp[0][1]);
    const s1 = Math.hypot(qp[2][0] - qp[1][0], qp[2][1] - qp[1][1]);
    const s2 = Math.hypot(qp[3][0] - qp[2][0], qp[3][1] - qp[2][1]);
    const s3 = Math.hypot(qp[0][0] - qp[3][0], qp[0][1] - qp[3][1]);
    const maxSide = Math.max(s0, s1, s2, s3);
    const minSide = Math.min(s0, s1, s2, s3);
    const sideRatio = minSide / Math.max(maxSide, UV_EPSILON);

    const quality =
      (sameSignCount === 4 ? 1.0 : 0.5) * (0.3 + 0.7 * sideRatio);

    candidates.push({ key: makeEdgeKey(lo, hi), ti0, ti1, quality });
  }

  /* Best-quality pairs first for greedy matching */
  candidates.sort((a, b) => b.quality - a.quality);

  /* ── 4.  Greedy triangle → quad matching ─────────────────────── */
  const matchedTri = new Set();
  const diagonalEdges = new Set();

  for (const cand of candidates) {
    if (matchedTri.has(cand.ti0) || matchedTri.has(cand.ti1)) continue;
    matchedTri.add(cand.ti0);
    matchedTri.add(cand.ti1);
    diagonalEdges.add(cand.key);
  }

  /* ── 5.  Emit all non-diagonal edges ─────────────────────────── */
  const segments = [];

  for (const edge of edgeTriMap.values()) {
    const key = makeEdgeKey(edge.lo, edge.hi);
    if (diagonalEdges.has(key)) continue;

    const va = vertices[edge.lo];
    const vb = vertices[edge.hi];
    if (!va || !vb) continue;

    /* Skip sub-pixel edges */
    const lengthPx = Math.hypot(
      (vb[0] - va[0]) * pixelScale,
      (vb[1] - va[1]) * pixelScale,
    );
    if (lengthPx < 0.5) continue;

    appendSegment(segments, va[0], va[1], vb[0], vb[1]);
  }

  if (segments.length >= 4) return segments;

  /* Fallback — oriented bounding box for degenerate shells */
  const principalAxis = computePrincipalAxis(vertices) || [1, 0];
  return buildOrientedBoxSegments(vertices, principalAxis);
}

function buildRenderShellsWithCleanWire(shells, size) {
  if (!Array.isArray(shells)) return [];
  return shells.map((shell) => ({
    ...shell,
    wireSegments: buildCleanWireSegments(shell, size),
  }));
}

function paintWireframeLayer(canvas, shells, mapper) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(16, 20, 42, 0.52)";

  const baseWidth = Math.max(0.52, canvas.width * 0.00042);

  shells.forEach((shell, index) => {
    const shellRects = Array.isArray(shell?.rectangles) ? shell.rectangles : [];
    const shellSegments = Array.isArray(shell?.wireSegments) ? shell.wireSegments : [];
    if (shellRects.length === 0 && shellSegments.length < 4) return;

    const bounds = mapper.mapBounds(index);
    const shellSize = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
    ctx.lineWidth = shellSize < 56 ? baseWidth * 1.28 : baseWidth;

    for (const rect of shellRects) {
      const [ax, ay] = mapper.toPoint(index, rect.minU, rect.minV);
      const [bx, by] = mapper.toPoint(index, rect.maxU, rect.maxV);
      const minX = Math.min(ax, bx);
      const maxX = Math.max(ax, bx);
      const minY = Math.min(ay, by);
      const maxY = Math.max(ay, by);

      if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
        continue;
      }

      const width = Math.max(0, maxX - minX);
      const height = Math.max(0, maxY - minY);
      if (width < 0.25 || height < 0.25) continue;

      ctx.strokeRect(minX, minY, width, height);
    }

    for (let i = 0; i + 3 < shellSegments.length; i += 4) {
      const [x0, y0] = mapper.toPoint(index, shellSegments[i], shellSegments[i + 1]);
      const [x1, y1] = mapper.toPoint(index, shellSegments[i + 2], shellSegments[i + 3]);

      if (![x0, y0, x1, y1].every((value) => Number.isFinite(value))) continue;
      const length = Math.hypot(x1 - x0, y1 - y0);
      if (length < 0.25) continue;

      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
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

  const renderMeshes = buildRenderShellsWithCleanWire(selectedMeshes, size);


  const mapper = createShellMapper(size, renderMeshes);
  if (!mapper) {
    throw new Error("Failed to layout UV shells for template export.");
  }

  const backgroundCanvas = paintBackgroundLayer(createCanvas(size));
  const fillCanvas = paintMeshFillLayer(createCanvas(size), renderMeshes, mapper);
  const wireCanvas = paintWireframeLayer(createCanvas(size), renderMeshes, mapper);
  const annotationCanvas = paintAnnotationLayer(createCanvas(size), modelName, targetCount, renderMeshes.length);
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
