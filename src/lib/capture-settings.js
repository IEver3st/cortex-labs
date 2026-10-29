export const CAPTURE_ANGLES = Object.freeze([
  { key: "front", label: "Front" },
  { key: "back", label: "Rear" },
  { key: "side", label: "Side" },
  { key: "angle", label: "3/4" },
  { key: "top", label: "Top" },
]);
export const CAPTURE_ANGLE_KEYS = Object.freeze(CAPTURE_ANGLES.map((angle) => angle.key));

export const CAPTURE_ZOOM_MIN = 0.6;
export const CAPTURE_ZOOM_MAX = 1.8;
export const DEFAULT_CAPTURE_ZOOM = 1;

export const CAPTURE_SIZES = Object.freeze([
  { id: "window", label: "Window" },
  { id: "hd", label: "1920 × 1080", width: 1920, height: 1080 },
  { id: "qhd", label: "2560 × 1440", width: 2560, height: 1440 },
  { id: "uhd", label: "3840 × 2160", width: 3840, height: 2160 },
]);
export const DEFAULT_CAPTURE_SIZE = "window";

export function normalizeCaptureAngles(value) {
  const angles = Array.isArray(value) ? CAPTURE_ANGLE_KEYS.filter((key) => value.includes(key)) : [];
  return angles.length ? angles : [...CAPTURE_ANGLE_KEYS];
}

export function normalizeCaptureZoom(value) {
  const zoom = Number(value);
  if (!Number.isFinite(zoom)) return DEFAULT_CAPTURE_ZOOM;
  return Math.min(CAPTURE_ZOOM_MAX, Math.max(CAPTURE_ZOOM_MIN, zoom));
}

export function normalizeCaptureSize(value) {
  return CAPTURE_SIZES.some((size) => size.id === value) ? value : DEFAULT_CAPTURE_SIZE;
}

export function captureDimensions(value) {
  const size = CAPTURE_SIZES.find((entry) => entry.id === value);
  return size?.width ? { width: size.width, height: size.height } : null;
}
