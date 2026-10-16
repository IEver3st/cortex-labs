/*
 * Template markers are boxes the painter draws on the template sheet.
 *
 * A marker is { id, x, y, w, h, fill } in normalized texture space with a
 * top-left origin, the same space as the preview image, so a box lands on
 * the exported texture exactly where it was drawn at every resolution.
 * fill "pieces" colours the paint geometry inside the box; "box" colours the
 * whole box.
 */

export const DEFAULT_TEMPLATE_MARKER_COLOR = "#00ff00";
export const TEMPLATE_MARKER_FILLS = ["pieces", "box"];
export const MAX_TEMPLATE_MARKERS = 256;
// Smallest box worth keeping, in normalized units (2 px at 4K).
export const MIN_TEMPLATE_MARKER_SIZE = 2 / 4096;

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const round6 = (value) => Math.round(value * 1e6) / 1e6;

let markerSequence = 0;
export function createTemplateMarkerId() {
  markerSequence += 1;
  return `m${Date.now().toString(36)}${markerSequence.toString(36)}`;
}

function normalizeRect(x0, y0, x1, y1) {
  const left = clamp01(Math.min(x0, x1));
  const top = clamp01(Math.min(y0, y1));
  const right = clamp01(Math.max(x0, x1));
  const bottom = clamp01(Math.max(y0, y1));
  return { x: round6(left), y: round6(top), w: round6(right - left), h: round6(bottom - top) };
}

/** Validates stored markers; drops anything malformed instead of guessing. */
export function normalizeTemplateMarkers(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const markers = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { x, y, w, h } = entry;
    if (![x, y, w, h].every(Number.isFinite)) continue;
    const rect = normalizeRect(x, y, x + w, y + h);
    if (rect.w < MIN_TEMPLATE_MARKER_SIZE || rect.h < MIN_TEMPLATE_MARKER_SIZE) continue;
    let id = typeof entry.id === "string" && entry.id ? entry.id : createTemplateMarkerId();
    while (seen.has(id)) id = createTemplateMarkerId();
    seen.add(id);
    markers.push({ id, ...rect, fill: entry.fill === "box" ? "box" : "pieces" });
    if (markers.length >= MAX_TEMPLATE_MARKERS) break;
  }
  return markers;
}

/** A box between two dragged points, or null when the drag is too small. */
export function markerFromDrag(start, end, id = createTemplateMarkerId()) {
  if (!start || !end) return null;
  const rect = normalizeRect(start.x, start.y, end.x, end.y);
  if (rect.w < MIN_TEMPLATE_MARKER_SIZE || rect.h < MIN_TEMPLATE_MARKER_SIZE) return null;
  return { id, ...rect, fill: "pieces" };
}

/** Moves a box, keeping its size and keeping it on the sheet. */
export function moveTemplateMarker(marker, dx, dy) {
  const x = Math.min(1 - marker.w, Math.max(0, marker.x + dx));
  const y = Math.min(1 - marker.h, Math.max(0, marker.y + dy));
  return { ...marker, x: round6(x), y: round6(y) };
}

/**
 * Drags one corner ("nw", "ne", "sw", "se") to `point`; the opposite
 * corner stays put. Dragging past it flips the box rather than inverting.
 */
export function resizeTemplateMarker(marker, handle, point) {
  const right = marker.x + marker.w;
  const bottom = marker.y + marker.h;
  const anchorX = handle === "nw" || handle === "sw" ? right : marker.x;
  const anchorY = handle === "nw" || handle === "ne" ? bottom : marker.y;
  const rect = normalizeRect(anchorX, anchorY, point.x, point.y);
  return {
    ...marker,
    ...rect,
    w: Math.max(MIN_TEMPLATE_MARKER_SIZE, rect.w),
    h: Math.max(MIN_TEMPLATE_MARKER_SIZE, rect.h),
  };
}

/** Topmost marker containing the point (last drawn wins), or null. */
export function hitTemplateMarker(markers, point) {
  for (let i = markers.length - 1; i >= 0; i -= 1) {
    const m = markers[i];
    if (point.x >= m.x && point.x <= m.x + m.w && point.y >= m.y && point.y <= m.y + m.h) return m;
  }
  return null;
}

/** Integer pixel bounds [x0, x1) x [y0, y1) of a marker on a size x size texture. */
export function markerPixelBounds(marker, size) {
  const x0 = Math.max(0, Math.min(size, Math.floor(marker.x * size)));
  const y0 = Math.max(0, Math.min(size, Math.floor(marker.y * size)));
  const x1 = Math.max(x0, Math.min(size, Math.ceil((marker.x + marker.w) * size)));
  const y1 = Math.max(y0, Math.min(size, Math.ceil((marker.y + marker.h) * size)));
  return { x0, y0, x1, y1 };
}

/**
 * Builds the marker mask. `pieceMask` marks paint geometry (with any bleed
 * already applied); "pieces" markers keep only those pixels inside their box,
 * "box" markers take the whole box. Returns the mask and per-marker pixel
 * counts so the UI can flag a box that covers no paint geometry.
 */
export function buildTemplateMarkerMask(markers, pieceMask, size) {
  const out = new Uint8Array(size * size);
  const counts = {};
  let painted = 0;
  for (const marker of markers) {
    const { x0, y0, x1, y1 } = markerPixelBounds(marker, size);
    let count = 0;
    for (let y = y0; y < y1; y += 1) {
      const row = y * size;
      for (let x = x0; x < x1; x += 1) {
        const i = row + x;
        if (marker.fill === "box" || pieceMask[i]) {
          if (!out[i]) painted += 1;
          out[i] = 1;
          count += 1;
        }
      }
    }
    counts[marker.id] = count;
  }
  return { mask: out, counts, painted };
}

/** The largest centered square that fits the preview area. */
export function getContainedTemplateViewport(containerWidth, containerHeight) {
  const width = Number.isFinite(containerWidth) ? Math.max(0, containerWidth) : 0;
  const height = Number.isFinite(containerHeight) ? Math.max(0, containerHeight) : 0;
  const size = Math.min(width, height);
  return {
    size,
    offsetX: Math.max(0, (width - size) / 2),
    offsetY: Math.max(0, (height - size) / 2),
  };
}
