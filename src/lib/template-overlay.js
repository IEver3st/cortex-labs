/*
 * Vehicle overlay and logo placement for generated templates.
 *
 * Everything here works on plain typed arrays so it runs unchanged in the
 * template worker, the main-thread fallback, and direct Node tests.
 */

export const DEFAULT_VEHICLE_OVERLAY_COLOR = "#000000";
export const VEHICLE_OVERLAY_MIN_BLEED_PX = 5;
const VEHICLE_OVERLAY_MAX_BLEED_PX = 64;

const LOGO_GRID_CELLS = 256;
const LOGO_TARGET_RATIO = 0.1;
const LOGO_MIN_RATIO = 0.035;
const LOGO_PADDING_RATIO = 0.006;

/** Lowercase #rrggbb, or the fallback for anything else (alpha, names, CSS functions). */
export function normalizeOpaqueHexColor(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  const short = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(trimmed);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  return fallback;
}

export function normalizeVehicleOverlayColor(value) {
  return normalizeOpaqueHexColor(value, DEFAULT_VEHICLE_OVERLAY_COLOR);
}

export function hexToRgb(hex) {
  const normalized = normalizeOpaqueHexColor(hex, DEFAULT_VEHICLE_OVERLAY_COLOR);
  return [
    parseInt(normalized.slice(1, 3), 16),
    parseInt(normalized.slice(3, 5), 16),
    parseInt(normalized.slice(5, 7), 16),
  ];
}

function assertSize(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Overlay mask size must be positive integers (got ${width}x${height}).`);
  }
}

/**
 * Conservative coverage: marks every pixel whose square [x, x+1] x [y, y+1]
 * intersects a triangle. Pixel-centre sampling would drop thin trims and
 * sliver triangles, which is exactly where a painter needs the bleed.
 *
 * `pixelTriangles` is a flat array of canvas-space coordinates
 * [x0, y0, x1, y1, x2, y2, ...]. Non-finite triangles are skipped.
 */
export function rasterizeCoverageMask(pixelTriangles, width, height = width) {
  assertSize(width, height);
  const mask = new Uint8Array(width * height);
  const tris = pixelTriangles || [];

  for (let i = 0; i + 5 < tris.length; i += 6) {
    let x0 = tris[i];
    let y0 = tris[i + 1];
    let x1 = tris[i + 2];
    let y1 = tris[i + 3];
    const x2 = tris[i + 4];
    const y2 = tris[i + 5];
    if (![x0, y0, x1, y1, x2, y2].every(Number.isFinite)) continue;

    // Orient counter-clockwise in canvas space so every edge function is
    // non-negative inside; mirrored islands must not cancel out.
    const cross = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
    if (cross < 0) {
      [x0, x1] = [x1, x0];
      [y0, y1] = [y1, y0];
    }

    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
    const maxX = Math.min(width - 1, Math.floor(Math.max(x0, x1, x2)));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const maxY = Math.min(height - 1, Math.floor(Math.max(y0, y1, y2)));
    if (minX > maxX || minY > maxY) continue;

    // Edge function e(x, y) = a*x + b*y + c, >= 0 on the inner side. A pixel
    // square touches the half-plane when e at its centre plus half the
    // projected square extent is non-negative (separating-axis test).
    const edges = [
      [x0, y0, x1, y1],
      [x1, y1, x2, y2],
      [x2, y2, x0, y0],
    ].map(([ax, ay, bx, by]) => {
      const a = -(by - ay);
      const b = bx - ax;
      const c = -(a * ax + b * ay);
      const slack = 0.5 * (Math.abs(a) + Math.abs(b)) + 1e-9 * (Math.abs(a) + Math.abs(b) + 1);
      return [a, b, c, slack];
    });
    const degenerate = Math.abs(cross) < 1e-12;

    for (let py = minY; py <= maxY; py += 1) {
      const cy = py + 0.5;
      const row = py * width;
      for (let px = minX; px <= maxX; px += 1) {
        if (mask[row + px]) continue;
        const cx = px + 0.5;
        let inside = true;
        if (!degenerate) {
          for (let e = 0; e < 3; e += 1) {
            const [a, b, c, slack] = edges[e];
            if (a * cx + b * cy + c + slack < 0) {
              inside = false;
              break;
            }
          }
        }
        if (inside) mask[row + px] = 1;
      }
    }
  }

  return mask;
}

/**
 * Euclidean dilation. With conservative coverage, any point within
 * `minBleedPx` of the geometry lies in a pixel whose centre is at most
 * minBleedPx + sqrt(2) from a covered pixel centre, so thresholding the
 * centre-to-centre distance at that radius guarantees the minimum bleed in
 * every direction (an 8-neighbour square dilation would not).
 */
export function dilateMaskEuclidean(mask, width, height = width, minBleedPx = VEHICLE_OVERLAY_MIN_BLEED_PX) {
  const bleed = Math.min(
    VEHICLE_OVERLAY_MAX_BLEED_PX,
    Math.max(VEHICLE_OVERLAY_MIN_BLEED_PX, Number.isFinite(minBleedPx) ? minBleedPx : VEHICLE_OVERLAY_MIN_BLEED_PX),
  );
  return dilateMaskWithinRadius(mask, width, height, bleed + Math.SQRT2);
}

/** Covers every pixel whose centre is within `radius` of a covered pixel centre. */
export function dilateMaskWithinRadius(mask, width, height, radius) {
  assertSize(width, height);
  if (!(mask instanceof Uint8Array) || mask.length !== width * height) {
    throw new Error("Overlay mask does not match its declared size.");
  }
  if (!(radius > 0)) return mask.slice();
  const limit = Math.floor(radius * radius);
  const reach = Math.floor(radius);
  const cap = Math.min(255, reach + 1);

  // Horizontal distance (in pixels, capped) to the nearest covered pixel.
  const horizontal = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let last = -Infinity;
    for (let x = 0; x < width; x += 1) {
      if (mask[row + x]) last = x;
      horizontal[row + x] = Math.min(cap, x - last);
    }
    last = Infinity;
    for (let x = width - 1; x >= 0; x -= 1) {
      if (mask[row + x]) last = x;
      const d = last - x;
      if (d < horizontal[row + x]) horizontal[row + x] = d;
    }
  }

  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - reach);
    const y1 = Math.min(height - 1, y + reach);
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      for (let sy = y0; sy <= y1; sy += 1) {
        const h = horizontal[sy * width + x];
        if (h > reach) continue;
        const dy = sy - y;
        if (h * h + dy * dy <= limit) {
          out[row + x] = 1;
          break;
        }
      }
    }
  }
  return out;
}

/** Writes the mask into an RGBA buffer: chosen colour, opaque or clear. */
export function colorizeMask(mask, rgba, color) {
  const [r, g, b] = hexToRgb(color);
  for (let i = 0, p = 0; i < mask.length; i += 1, p += 4) {
    if (mask[i]) {
      rgba[p] = r;
      rgba[p + 1] = g;
      rgba[p + 2] = b;
      rgba[p + 3] = 255;
    } else {
      rgba[p] = 0;
      rgba[p + 1] = 0;
      rgba[p + 2] = 0;
      rgba[p + 3] = 0;
    }
  }
  return rgba;
}

/**
 * Finds a square of clear texture space for the logo. `occupied` should be
 * the dilated coverage mask so the logo also keeps clear of overlay bleed.
 *
 * Returns { x, y, size } in pixels, or null when no square of at least the
 * minimum size fits; the caller omits the logo rather than covering UVs.
 */
export function findLogoPlacement(occupied, width, height = width) {
  assertSize(width, height);
  const cells = Math.min(LOGO_GRID_CELLS, width, height);
  const cellW = width / cells;
  const cellH = height / cells;
  const grid = new Uint8Array(cells * cells);

  for (let y = 0; y < height; y += 1) {
    const gy = Math.min(cells - 1, Math.floor(y / cellH));
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (occupied[row + x]) grid[gy * cells + Math.min(cells - 1, Math.floor(x / cellW))] = 1;
    }
  }

  const minDim = Math.min(width, height);
  const padding = Math.max(2, Math.ceil(minDim * LOGO_PADDING_RATIO));
  const padCells = Math.ceil(padding / Math.min(cellW, cellH));
  const targetCells = Math.max(1, Math.floor((minDim * LOGO_TARGET_RATIO) / Math.min(cellW, cellH)));
  const minCells = Math.max(1, Math.ceil((minDim * LOGO_MIN_RATIO) / Math.min(cellW, cellH)));

  // Treat a padding band around occupied cells and the canvas edge as blocked.
  const blocked = new Uint8Array(cells * cells);
  for (let gy = 0; gy < cells; gy += 1) {
    for (let gx = 0; gx < cells; gx += 1) {
      if (gx < padCells || gy < padCells || gx >= cells - padCells || gy >= cells - padCells) {
        blocked[gy * cells + gx] = 1;
        continue;
      }
      if (!grid[gy * cells + gx]) continue;
      for (let dy = -padCells; dy <= padCells; dy += 1) {
        const ny = gy + dy;
        if (ny < 0 || ny >= cells) continue;
        for (let dx = -padCells; dx <= padCells; dx += 1) {
          const nx = gx + dx;
          if (nx >= 0 && nx < cells) blocked[ny * cells + nx] = 1;
        }
      }
    }
  }

  // Largest clear square ending at each cell (bottom-right corner), capped
  // at the target size. Ties prefer the lowest, then left-most spot, which
  // matches where template packs conventionally sign their sheets.
  const dp = new Uint16Array(cells * cells);
  let best = null;
  for (let gy = 0; gy < cells; gy += 1) {
    for (let gx = 0; gx < cells; gx += 1) {
      const i = gy * cells + gx;
      if (blocked[i]) continue;
      const up = gy > 0 ? dp[i - cells] : 0;
      const left = gx > 0 ? dp[i - 1] : 0;
      const diag = gy > 0 && gx > 0 ? dp[i - cells - 1] : 0;
      dp[i] = 1 + Math.min(up, left, diag);
      const side = Math.min(dp[i], targetCells);
      if (side < minCells) continue;
      if (
        !best ||
        side > best.side ||
        (side === best.side && (gy > best.gy || (gy === best.gy && gx - side < best.gx - best.side)))
      ) {
        best = { gx, gy, side };
      }
    }
  }
  if (!best) return null;

  return {
    x: Math.round((best.gx - best.side + 1) * cellW),
    y: Math.round((best.gy - best.side + 1) * cellH),
    size: Math.floor(best.side * Math.min(cellW, cellH)),
  };
}
