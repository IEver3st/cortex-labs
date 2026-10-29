// EUP Studio export settings and the geometry shared by shots, videos and
// colourway sheets. Pure functions only, so the framing maths that decides
// what a capture contains can be tested outside the renderer.

/** Output formats. Shots can render at double size; videos stay at these sizes. */
export const EXPORT_FORMATS = Object.freeze([
  { id: "portrait", label: "4:5", width: 1080, height: 1350 },
  { id: "square", label: "1:1", width: 1080, height: 1080 },
  { id: "landscape", label: "16:9", width: 1920, height: 1080 },
  { id: "story", label: "9:16", width: 1080, height: 1920 },
]);

/** Shot angles. `view` is the viewfinder as framed; the rest are auto-framed camera presets. */
export const SHOT_ANGLES = Object.freeze([
  { id: "view", label: "This view" },
  { id: "front", label: "Front" },
  { id: "full", label: "3/4" },
  { id: "left", label: "Side" },
  { id: "back", label: "Back" },
  { id: "head", label: "Head" },
]);

export const EXPORT_MODES = Object.freeze(["shots", "video", "sheet"]);
export const VIDEO_LENGTHS = Object.freeze([4, 8, 12]);
export const VIDEO_CAMERAS = Object.freeze(["turntable", "fixed"]);
export const VIDEO_FPS = 30;
const MAX_TEXTURE_EDGE = 4096;

export const DEFAULT_EXPORT_SETTINGS = Object.freeze({
  mode: "shots",
  format: "portrait",
  high: false,
  angles: ["view", "front", "full", "back"],
  transparent: false,
  videoCamera: "turntable",
  videoLength: 8,
  sheetLabels: true,
});

export function normalizeExportSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  const angles = Array.isArray(source.angles)
    ? SHOT_ANGLES.map((angle) => angle.id).filter((id) => source.angles.includes(id))
    : [...DEFAULT_EXPORT_SETTINGS.angles];
  return {
    mode: EXPORT_MODES.includes(source.mode) ? source.mode : DEFAULT_EXPORT_SETTINGS.mode,
    format: EXPORT_FORMATS.some((item) => item.id === source.format) ? source.format : DEFAULT_EXPORT_SETTINGS.format,
    high: source.high === true,
    angles,
    transparent: source.transparent === true,
    videoCamera: VIDEO_CAMERAS.includes(source.videoCamera) ? source.videoCamera : DEFAULT_EXPORT_SETTINGS.videoCamera,
    videoLength: VIDEO_LENGTHS.includes(source.videoLength) ? source.videoLength : DEFAULT_EXPORT_SETTINGS.videoLength,
    sheetLabels: source.sheetLabels !== false,
  };
}

/** Pixel size of a format; `high` doubles it, capped at 4096 on the long edge. */
export function formatSize(formatId, high = false) {
  const format = EXPORT_FORMATS.find((item) => item.id === formatId) || EXPORT_FORMATS[0];
  if (!high) return { width: format.width, height: format.height };
  const scale = Math.min(2, MAX_TEXTURE_EDGE / Math.max(format.width, format.height));
  return { width: Math.round(format.width * scale), height: Math.round(format.height * scale) };
}

/**
 * Vertical field of view for a capture of `outAspect` taken from a viewfinder
 * of `viewAspect` with `fovDeg`. Narrower outputs keep the height (the sides
 * are cropped); wider ones keep the width (top and bottom are cropped), so the
 * capture is always the largest output-shaped area inside the viewfinder.
 */
export function shotFov(fovDeg, viewAspect, outAspect) {
  if (!(viewAspect > 0) || !(outAspect > 0) || outAspect <= viewAspect) return fovDeg;
  const half = (fovDeg * Math.PI) / 360;
  return (Math.atan(Math.tan(half) * (viewAspect / outAspect)) * 360) / Math.PI;
}

export function containFov(fovDeg, viewAspect, outAspect) {
  if (!(viewAspect > 0) || !(outAspect > 0) || outAspect >= viewAspect) return fovDeg;
  const half = (fovDeg * Math.PI) / 360;
  return (Math.atan(Math.tan(half) * (viewAspect / outAspect)) * 360) / Math.PI;
}

/** The viewfinder rectangle a capture covers, matching shotFov. */
export function guideRect(viewWidth, viewHeight, outAspect) {
  if (!(viewWidth > 0) || !(viewHeight > 0) || !(outAspect > 0)) return null;
  const viewAspect = viewWidth / viewHeight;
  const width = outAspect <= viewAspect ? viewHeight * outAspect : viewWidth;
  const height = outAspect <= viewAspect ? viewHeight : viewWidth / outAspect;
  return { x: (viewWidth - width) / 2, y: (viewHeight - height) / 2, width, height };
}

/** Grid for a colourway sheet: up to `maxColumns` across, rows as needed, no gaps. */
export function contactSheetLayout(count, cellWidth, cellHeight, maxColumns = 4) {
  const columns = Math.max(1, Math.min(count, maxColumns));
  const rows = Math.max(1, Math.ceil(count / columns));
  const cells = Array.from({ length: count }, (_, i) => ({
    x: (i % columns) * cellWidth,
    y: Math.floor(i / columns) * cellHeight,
  }));
  return { columns, rows, width: columns * cellWidth, height: rows * cellHeight, cells };
}

/** Cell size for a sheet: format proportions, scaled so the sheet stays under 4096 px. */
export function sheetCellSize(formatId, count, maxColumns = 4) {
  const { width, height } = formatSize(formatId, false);
  const columns = Math.max(1, Math.min(count, maxColumns));
  const rows = Math.max(1, Math.ceil(count / columns));
  const scale = Math.min(1, MAX_TEXTURE_EDGE / (columns * width), MAX_TEXTURE_EDGE / (rows * height), 0.75);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** A file-name stem from an outfit label: "Male: jbib 003a" -> "male-jbib-003a". */
export function exportFileStem(text, fallback = "eup") {
  const stem = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return stem || fallback;
}

const VIDEO_TYPES = [
  { mimeType: "video/mp4;codecs=avc1.640028", extension: "mp4" },
  { mimeType: "video/mp4", extension: "mp4" },
  { mimeType: "video/webm;codecs=vp9", extension: "webm" },
  { mimeType: "video/webm", extension: "webm" },
];

/** The first recorder format the runtime supports; MP4 first because it plays everywhere. */
export function pickVideoType(isTypeSupported) {
  if (typeof isTypeSupported !== "function") return null;
  return VIDEO_TYPES.find((type) => {
    try {
      return isTypeSupported(type.mimeType);
    } catch {
      return false;
    }
  }) || null;
}
