import { PREFS_UPDATED_EVENT, loadPrefs } from "./prefs.js";

export const PREVIEW_DETAIL_LEVELS = Object.freeze([
  { id: "performance", label: "Performance", maxPixelRatio: 1 },
  { id: "balanced", label: "Balanced", maxPixelRatio: 1.5 },
  { id: "sharp", label: "Sharp", maxPixelRatio: 2 },
]);
export const DEFAULT_PREVIEW_DETAIL = "balanced";

export function normalizePreviewDetail(value) {
  return PREVIEW_DETAIL_LEVELS.some((level) => level.id === value) ? value : DEFAULT_PREVIEW_DETAIL;
}

export function previewPixelRatio(detail, devicePixelRatio = globalThis.window?.devicePixelRatio) {
  const level = PREVIEW_DETAIL_LEVELS.find((entry) => entry.id === normalizePreviewDetail(detail));
  return Math.min(devicePixelRatio || 1, level.maxPixelRatio);
}

export function readViewerControls() {
  const defaults = loadPrefs()?.defaults;
  return {
    detail: normalizePreviewDetail(defaults?.previewDetail),
    zoomToCursor: defaults?.zoomToCursor === true,
  };
}

export function onViewerControlsChange(initial, callback) {
  if (typeof window === "undefined") return () => {};
  let current = initial;
  const handle = () => {
    const next = readViewerControls();
    if (next.detail === current.detail && next.zoomToCursor === current.zoomToCursor) return;
    current = next;
    callback(next);
  };
  window.addEventListener(PREFS_UPDATED_EVENT, handle);
  return () => window.removeEventListener(PREFS_UPDATED_EVENT, handle);
}
