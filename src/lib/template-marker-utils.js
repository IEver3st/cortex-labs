const SUPPORTED_TEMPLATE_MARKER_PICK_MODIFIERS = ["alt", "ctrl", "shift"];
const SUPPORTED_TEMPLATE_MARKER_REGENERATE_BEHAVIORS = [
  "persist-until-reset",
  "reset-on-regenerate",
];

export const DEFAULT_TEMPLATE_MARKER_PICK_MODIFIER = "alt";
export const DEFAULT_TEMPLATE_MARKER_REGENERATE_BEHAVIOR = "persist-until-reset";

function normalizeStringValue(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function normalizeTemplateMarkerPickModifier(value) {
  const normalized = normalizeStringValue(value);
  return SUPPORTED_TEMPLATE_MARKER_PICK_MODIFIERS.includes(normalized)
    ? normalized
    : DEFAULT_TEMPLATE_MARKER_PICK_MODIFIER;
}

export function normalizeTemplateMarkerRegenerateBehavior(value) {
  const normalized = normalizeStringValue(value);
  return SUPPORTED_TEMPLATE_MARKER_REGENERATE_BEHAVIORS.includes(normalized)
    ? normalized
    : DEFAULT_TEMPLATE_MARKER_REGENERATE_BEHAVIOR;
}

export function isTemplateMarkerModifierPressed(event, modifier = DEFAULT_TEMPLATE_MARKER_PICK_MODIFIER) {
  const normalizedModifier = normalizeTemplateMarkerPickModifier(modifier);
  if (!event || typeof event !== "object") return false;
  if (normalizedModifier === "ctrl") return Boolean(event.ctrlKey);
  if (normalizedModifier === "shift") return Boolean(event.shiftKey);
  return Boolean(event.altKey);
}

export function resolveTemplateMarkerVisible(marker, visibilityMap = {}) {
  const explicitValue = visibilityMap?.[marker?.key];
  if (explicitValue === true) return true;
  if (explicitValue === false) return false;
  return marker?.defaultVisible !== false;
}

export function buildBulkMarkerVisibility(markers, nextVisible) {
  const next = {};
  for (const marker of Array.isArray(markers) ? markers : []) {
    if (!marker?.key) continue;
    next[marker.key] = Boolean(nextVisible);
  }
  return next;
}

export function buildResetMarkerVisibility(markers) {
  const next = {};
  for (const marker of Array.isArray(markers) ? markers : []) {
    if (!marker?.key) continue;
    if (marker.defaultVisible === false) {
      next[marker.key] = false;
    }
  }
  return next;
}

export function buildMarkerSelectionDraft(markers, previousSelection = {}) {
  const next = {};
  const previous = previousSelection && typeof previousSelection === "object" ? previousSelection : {};
  for (const marker of Array.isArray(markers) ? markers : []) {
    if (!marker?.key) continue;
    if (previous[marker.key] === true) {
      next[marker.key] = true;
    }
  }
  return next;
}

export function toggleMarkerSelection(selectionMap = {}, markerKey) {
  if (!markerKey) return selectionMap && typeof selectionMap === "object" ? selectionMap : {};
  const next = { ...(selectionMap && typeof selectionMap === "object" ? selectionMap : {}) };
  if (next[markerKey] === true) {
    delete next[markerKey];
  } else {
    next[markerKey] = true;
  }
  return next;
}

export function countSelectedMarkers(selectionMap = {}) {
  let count = 0;
  const selection = selectionMap && typeof selectionMap === "object" ? selectionMap : {};
  for (const value of Object.values(selection)) {
    if (value === true) count += 1;
  }
  return count;
}

export function buildConfirmedMarkerVisibility(markers, selectionMap = {}) {
  const next = {};
  const selection = selectionMap && typeof selectionMap === "object" ? selectionMap : {};
  for (const marker of Array.isArray(markers) ? markers : []) {
    if (!marker?.key) continue;
    next[marker.key] = selection[marker.key] === true;
  }
  return next;
}

export function reconcileMarkerVisibility({
  markers,
  previousVisibility = {},
  regenerateBehavior = DEFAULT_TEMPLATE_MARKER_REGENERATE_BEHAVIOR,
}) {
  const normalizedBehavior = normalizeTemplateMarkerRegenerateBehavior(regenerateBehavior);
  if (normalizedBehavior === "reset-on-regenerate") {
    return buildResetMarkerVisibility(markers);
  }

  const next = {};
  const previous = previousVisibility && typeof previousVisibility === "object" ? previousVisibility : {};

  for (const marker of Array.isArray(markers) ? markers : []) {
    if (!marker?.key) continue;
    const explicitValue = previous[marker.key];
    if (explicitValue === true || explicitValue === false) {
      next[marker.key] = explicitValue;
      continue;
    }
    if (marker.defaultVisible === false) {
      next[marker.key] = false;
    }
  }

  return next;
}

export function getContainedTemplateViewport(containerWidth, containerHeight) {
  const width = Math.max(0, Number(containerWidth) || 0);
  const height = Math.max(0, Number(containerHeight) || 0);
  const size = Math.min(width, height);
  return {
    size,
    offsetX: (width - size) * 0.5,
    offsetY: (height - size) * 0.5,
  };
}

export function getMarkerTextureRect(marker) {
  const width = Number.isFinite(marker?.width) ? marker.width : Number.isFinite(marker?.size) ? marker.size : 0;
  const height = Number.isFinite(marker?.height) ? marker.height : Number.isFinite(marker?.size) ? marker.size : 0;
  const x = Number(marker?.x);
  const y = Number(marker?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || width <= 0 || height <= 0) return null;
  return {
    x,
    y,
    width,
    height,
    maxX: x + width,
    maxY: y + height,
    area: width * height,
  };
}

export function uvToTemplateTexturePoint(uv, textureSize) {
  const maxCoord = Math.max(1, (Number(textureSize) || 0) - 1);
  const u = Number.isFinite(uv?.x) ? uv.x : Number.isFinite(uv?.u) ? uv.u : 0;
  const v = Number.isFinite(uv?.y) ? uv.y : Number.isFinite(uv?.v) ? uv.v : 0;
  const clampedU = Math.min(1, Math.max(0, u));
  const clampedV = Math.min(1, Math.max(0, v));
  return {
    x: clampedU * maxCoord,
    y: (1 - clampedV) * maxCoord,
  };
}

function compareMarkerHitCandidates(a, b) {
  const areaDiff = a.rect.area - b.rect.area;
  if (Math.abs(areaDiff) > 0.001) return areaDiff;
  const confidenceDiff =
    (Number.isFinite(b.marker?.confidenceScore) ? b.marker.confidenceScore : 0) -
    (Number.isFinite(a.marker?.confidenceScore) ? a.marker.confidenceScore : 0);
  if (Math.abs(confidenceDiff) > 0.001) return confidenceDiff;
  return a.index - b.index;
}

export function pickMarkerAtTexturePoint(markers, point) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  const hits = [];
  for (const [index, marker] of (Array.isArray(markers) ? markers : []).entries()) {
    if (!marker?.key) continue;
    const rect = getMarkerTextureRect(marker);
    if (!rect) continue;
    if (x < rect.x || x > rect.maxX || y < rect.y || y > rect.maxY) continue;
    hits.push({ marker, rect, index });
  }

  if (hits.length === 0) return null;
  hits.sort(compareMarkerHitCandidates);
  return hits[0].marker;
}
