/**
 * Preview watermarks.
 *
 * Config v2 sizes everything relative to the captured image's short side, so a
 * watermark looks the same on a 720p thumbnail and a 4K capture. v1 configs
 * (no `version`, absolute `fontSize` in px) are migrated on read against a
 * 1080px reference, which is what the old pixel sizes were tuned for.
 *
 * A watermark is drawn as one "stamp" (text, an imported logo, or both, with an
 * optional plate behind it) that is then placed once or tiled across the image
 * at the configured opacity and rotation.
 */

export const WATERMARK_CONFIG_VERSION = 2;
const LEGACY_REFERENCE_SHORT_SIDE = 1080;

// Imported logos are stored inside prefs (localStorage); keep them small.
export const WATERMARK_IMAGE_MAX_EDGE = 1024;
export const WATERMARK_IMAGE_MAX_SOURCE_BYTES = 20 * 1024 * 1024;
export const WATERMARK_IMAGE_MAX_STORED_CHARS = 2_500_000;
export const WATERMARK_IMAGE_ACCEPT = "image/png,image/webp,image/svg+xml,image/jpeg";

export const WATERMARK_FONTS = [
  { value: "Barlow Condensed", label: "Barlow Condensed", italicOnly: true },
  { value: "Segoe UI Variable Display", label: "Segoe UI" },
  { value: "Space Grotesk", label: "Space Grotesk" },
  { value: "Syne", label: "Syne" },
  { value: "JetBrains Mono", label: "JetBrains Mono" },
  { value: "Inter", label: "Inter" },
  { value: "Arial", label: "Arial" },
  { value: "Georgia", label: "Georgia" },
  { value: "Times New Roman", label: "Times New Roman" },
  { value: "Impact", label: "Impact" },
];

export const WATERMARK_KINDS = [
  { value: "text", label: "Text" },
  { value: "image", label: "Logo" },
  { value: "both", label: "Logo + text" },
];

export const WATERMARK_STYLES = [
  { value: "plain", label: "Plain" },
  { value: "shadow", label: "Shadow" },
  { value: "outline", label: "Outline" },
  { value: "plate", label: "Plate" },
];

export const WATERMARK_WEIGHTS = [
  { value: 400, label: "Regular" },
  { value: 600, label: "Semibold" },
  { value: 800, label: "Heavy" },
];

// Row-major 3x3 anchor grid, plus "tiled".
export const WATERMARK_ANCHORS = [
  "top-left", "top", "top-right",
  "left", "center", "right",
  "bottom-left", "bottom", "bottom-right",
];
export const WATERMARK_POSITIONS = [
  ...WATERMARK_ANCHORS.map((value) => ({ value, label: value.replace("-", " ") })),
  { value: "tiled", label: "tiled" },
];

export const DEFAULT_WATERMARK = {
  version: WATERMARK_CONFIG_VERSION,
  enabled: false,
  kind: "text",
  text: "© Cortex Labs",
  font: "Barlow Condensed",
  weight: 800,
  italic: true,
  uppercase: true,
  letterSpacing: 4,
  size: 3.2,
  color: "#ffffff",
  opacity: 0.85,
  style: "shadow",
  plateColor: "#0f1012",
  image: null,
  imageSize: 9,
  imageTint: false,
  position: "bottom-right",
  margin: 3,
  rotation: 0,
  tileGap: 120,
};

/** One-click starting points. They change the design, never the text or logo. */
export const WATERMARK_PRESETS = [
  {
    id: "signature",
    label: "Corner signature",
    description: "Condensed caps with a soft shadow in a corner.",
    patch: { font: "Barlow Condensed", weight: 800, italic: true, uppercase: true, letterSpacing: 4, size: 3.2, style: "shadow", opacity: 0.85, position: "bottom-right", margin: 3, rotation: 0 },
  },
  {
    id: "plate",
    label: "Studio plate",
    description: "Small label on a solid plate.",
    patch: { font: "Segoe UI Variable Display", weight: 600, italic: false, uppercase: false, letterSpacing: 0, size: 2.2, style: "plate", opacity: 0.92, position: "bottom-left", margin: 2.5, rotation: 0 },
  },
  {
    id: "stamp",
    label: "Center stamp",
    description: "Large outlined mark across the middle.",
    patch: { font: "Barlow Condensed", weight: 800, italic: true, uppercase: true, letterSpacing: 6, size: 11, style: "outline", opacity: 0.32, position: "center", margin: 3, rotation: -14 },
  },
  {
    id: "proof",
    label: "Tiled proof",
    description: "Faint repeating mark for work-in-progress shares.",
    patch: { font: "Space Grotesk", weight: 600, italic: false, uppercase: true, letterSpacing: 8, size: 2.4, style: "plain", opacity: 0.16, position: "tiled", rotation: -28, tileGap: 140 },
  },
  {
    id: "logo",
    label: "Logo corner",
    description: "Your imported logo, small and crisp.",
    patch: { kind: "image", style: "plain", imageSize: 9, opacity: 0.9, position: "bottom-right", margin: 3, rotation: 0 },
    needsImage: true,
  },
  {
    id: "lockup",
    label: "Logo + name",
    description: "Logo beside your name on a plate.",
    patch: { kind: "both", font: "Segoe UI Variable Display", weight: 600, italic: false, uppercase: false, letterSpacing: 0, size: 2.4, style: "plate", opacity: 0.92, position: "bottom-right", margin: 2.5, rotation: 0 },
    needsImage: true,
  },
];

const KIND_VALUES = new Set(WATERMARK_KINDS.map((k) => k.value));
const STYLE_VALUES = new Set(WATERMARK_STYLES.map((k) => k.value));
const POSITION_VALUES = new Set(WATERMARK_POSITIONS.map((p) => p.value));
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function clampNumber(value, min, max, fallback) {
  const num = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function round(value, step) {
  // toFixed trims float noise (24 * 0.1 is 2.4000000000000004) so presets compare equal.
  return Number((Math.round(value / step) * step).toFixed(4));
}

function normalizeColor(value, fallback) {
  return typeof value === "string" && HEX_COLOR.test(value.trim()) ? value.trim() : fallback;
}

function normalizeImage(image) {
  if (!image || typeof image !== "object") return null;
  if (typeof image.dataUrl !== "string" || !image.dataUrl.startsWith("data:image/")) return null;
  const width = Number(image.width);
  const height = Number(image.height);
  if (!(width > 0) || !(height > 0)) return null;
  return {
    dataUrl: image.dataUrl,
    width: Math.round(width),
    height: Math.round(height),
    name: typeof image.name === "string" ? image.name.slice(0, 200) : "Logo",
  };
}

const LEGACY_DEFAULT = {
  text: "© Cortex Labs",
  font: "Inter",
  fontSize: 32,
  color: "#ffffff",
  opacity: 0.5,
  position: "bottom-right",
  rotation: 0,
};

function migrateLegacyConfig(config) {
  // Never customized: adopt the new default design, keeping only the on/off choice.
  const untouched = Object.entries(LEGACY_DEFAULT).every(
    ([key, value]) => config[key] === undefined || config[key] === value,
  );
  if (untouched) return { ...DEFAULT_WATERMARK, enabled: Boolean(config.enabled) };
  const fontSize = clampNumber(config.fontSize, 8, 200, 32);
  return {
    ...config,
    size: round((fontSize / LEGACY_REFERENCE_SHORT_SIDE) * 100, 0.1),
    kind: "text",
    style: "plain",
    weight: 400,
    italic: false,
    uppercase: false,
    letterSpacing: 0,
    margin: 2.5,
  };
}

export function normalizeWatermarkConfig(config) {
  if (!config || typeof config !== "object") return { ...DEFAULT_WATERMARK };
  const source = config.version === WATERMARK_CONFIG_VERSION ? config : migrateLegacyConfig(config);
  const weight = Number(source.weight);
  return {
    version: WATERMARK_CONFIG_VERSION,
    enabled: Boolean(source.enabled),
    kind: KIND_VALUES.has(source.kind) ? source.kind : DEFAULT_WATERMARK.kind,
    text: typeof source.text === "string" ? source.text.slice(0, 120) : DEFAULT_WATERMARK.text,
    font: typeof source.font === "string" && source.font.trim() ? source.font.trim() : DEFAULT_WATERMARK.font,
    weight: [400, 600, 800].includes(weight) ? weight : DEFAULT_WATERMARK.weight,
    italic: Boolean(source.italic),
    uppercase: Boolean(source.uppercase),
    letterSpacing: round(clampNumber(source.letterSpacing, 0, 30, 0), 1),
    size: round(clampNumber(source.size, 0.5, 30, DEFAULT_WATERMARK.size), 0.1),
    color: normalizeColor(source.color, DEFAULT_WATERMARK.color),
    opacity: round(clampNumber(source.opacity, 0.05, 1, DEFAULT_WATERMARK.opacity), 0.01),
    style: STYLE_VALUES.has(source.style) ? source.style : "plain",
    plateColor: normalizeColor(source.plateColor, DEFAULT_WATERMARK.plateColor),
    image: normalizeImage(source.image),
    imageSize: round(clampNumber(source.imageSize, 2, 60, DEFAULT_WATERMARK.imageSize), 0.5),
    imageTint: Boolean(source.imageTint),
    position: POSITION_VALUES.has(source.position) ? source.position : DEFAULT_WATERMARK.position,
    margin: round(clampNumber(source.margin, 0, 20, DEFAULT_WATERMARK.margin), 0.5),
    rotation: Math.round(clampNumber(source.rotation, -180, 180, 0)),
    tileGap: Math.round(clampNumber(source.tileGap, 20, 400, DEFAULT_WATERMARK.tileGap)),
  };
}

/** What the stamp will actually contain once missing text or logo are accounted for. */
export function resolveWatermarkContent(cfg) {
  const text = cfg.kind !== "image" ? (cfg.uppercase ? cfg.text.toUpperCase() : cfg.text).trim() : "";
  const hasImage = cfg.kind !== "text" && Boolean(cfg.image);
  return { text, hasImage, isEmpty: !text && !hasImage };
}

export function hasDrawableWatermark(config) {
  const cfg = normalizeWatermarkConfig(config);
  return cfg.enabled && !resolveWatermarkContent(cfg).isEmpty;
}

/**
 * Where to draw each copy of a stamp. Pure geometry so it can be tested directly.
 * Returns centers in image pixels; every copy uses `rotation` (radians).
 */
export function computeWatermarkPlacements(imageSize, stampSize, config) {
  const cfg = normalizeWatermarkConfig(config);
  const width = Math.max(0, Number(imageSize?.width) || 0);
  const height = Math.max(0, Number(imageSize?.height) || 0);
  const sw = Math.max(0, Number(stampSize?.width) || 0);
  const sh = Math.max(0, Number(stampSize?.height) || 0);
  const rotation = (cfg.rotation * Math.PI) / 180;
  if (!width || !height || !sw || !sh) return { rotation, points: [] };

  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  if (cfg.position === "tiled") {
    const gap = cfg.tileGap / 100;
    const stepX = sw * (1 + gap);
    const stepY = sh * (1 + gap) * 1.6;
    const reach = Math.hypot(width, height) / 2 + Math.hypot(sw, sh);
    const cols = Math.ceil(reach / stepX);
    const rows = Math.ceil(reach / stepY);
    const points = [];
    for (let row = -rows; row <= rows; row++) {
      const offset = row % 2 === 0 ? 0 : stepX / 2;
      for (let col = -cols; col <= cols; col++) {
        const lx = col * stepX + offset;
        const ly = row * stepY;
        const x = width / 2 + lx * cos - ly * sin;
        const y = height / 2 + lx * sin + ly * cos;
        if (x < -sw || x > width + sw || y < -sw || y > height + sw) continue;
        points.push({ x, y });
      }
    }
    return { rotation, points };
  }

  // Keep the rotated stamp inside the margin box.
  const boxW = Math.abs(sw * cos) + Math.abs(sh * sin);
  const boxH = Math.abs(sw * sin) + Math.abs(sh * cos);
  const margin = (cfg.margin / 100) * Math.min(width, height);
  const [vertical, horizontal] = cfg.position.includes("-")
    ? cfg.position.split("-")
    : cfg.position === "left" || cfg.position === "right"
      ? ["center", cfg.position]
      : cfg.position === "top" || cfg.position === "bottom"
        ? [cfg.position, "center"]
        : ["center", "center"];
  const x = horizontal === "left"
    ? margin + boxW / 2
    : horizontal === "right"
      ? width - margin - boxW / 2
      : width / 2;
  const y = vertical === "top"
    ? margin + boxH / 2
    : vertical === "bottom"
      ? height - margin - boxH / 2
      : height / 2;
  return { rotation, points: [{ x, y }] };
}

/* ─── Rendering (browser only) ─── */

let cachedLogo = { src: "", promise: null };

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image could not be decoded"));
    img.src = src;
  });
}

function loadLogo(dataUrl) {
  if (cachedLogo.src !== dataUrl) {
    cachedLogo = { src: dataUrl, promise: loadImage(dataUrl) };
    cachedLogo.promise.catch(() => {
      if (cachedLogo.src === dataUrl) cachedLogo = { src: "", promise: null };
    });
  }
  return cachedLogo.promise;
}

function fontString(cfg, px) {
  const meta = WATERMARK_FONTS.find((f) => f.value === cfg.font);
  const italic = cfg.italic || meta?.italicOnly ? "italic " : "";
  return `${italic}${cfg.weight} ${px}px "${cfg.font}", "Segoe UI", sans-serif`;
}

async function ensureFont(cfg, px) {
  if (typeof document === "undefined" || !document.fonts?.load) return;
  try {
    await document.fonts.load(fontString(cfg, px));
  } catch {
    // A missing font falls back to the stack; never block a capture on it.
  }
}

function roundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function tintedLogo(logo, w, h, color) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(w));
  canvas.height = Math.max(1, Math.ceil(h));
  const ctx = canvas.getContext("2d");
  ctx.drawImage(logo, 0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Draws the stamp at full opacity onto its own canvas; opacity is applied when placed. */
async function buildStamp(cfg, shortSide) {
  const { text, hasImage, isEmpty } = resolveWatermarkContent(cfg);
  if (isEmpty) return null;

  const fontPx = Math.max(6, (cfg.size / 100) * shortSide);
  const logo = hasImage ? await loadLogo(cfg.image.dataUrl).catch(() => null) : null;
  if (!text && !logo) return null;
  if (text) await ensureFont(cfg, fontPx);

  const measure = document.createElement("canvas").getContext("2d");
  measure.font = fontString(cfg, fontPx);
  const spacingPx = (cfg.letterSpacing / 100) * fontPx;
  if ("letterSpacing" in measure) measure.letterSpacing = `${spacingPx}px`;
  const textWidth = text ? measure.measureText(text).width : 0;
  const textHeight = text ? fontPx * 1.08 : 0;

  // Alone, a logo is sized from the image; beside text it matches the type.
  const logoHeight = logo
    ? text
      ? fontPx * 1.3
      : (cfg.imageSize / 100) * shortSide
    : 0;
  const logoWidth = logo ? logoHeight * (logo.naturalWidth / logo.naturalHeight || 1) : 0;
  const gap = logo && text ? fontPx * 0.45 : 0;

  const contentW = logoWidth + gap + textWidth;
  const contentH = Math.max(logoHeight, textHeight);
  const isPlate = cfg.style === "plate";
  // Padding, shadow, and corner radius scale with the type, or the logo alone.
  const unit = text ? fontPx : logoHeight * 0.5;
  const padX = isPlate ? unit * 0.6 : 0;
  const padY = isPlate ? unit * 0.36 : 0;
  const bleed = cfg.style === "shadow" ? unit * 0.3 : cfg.style === "outline" ? unit * 0.06 : 0;

  const width = Math.ceil(contentW + padX * 2 + bleed * 2);
  const height = Math.ceil(contentH + padY * 2 + bleed * 2);
  if (width < 1 || height < 1) return null;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  if (isPlate) {
    ctx.fillStyle = cfg.plateColor;
    roundedRect(ctx, bleed, bleed, width - bleed * 2, height - bleed * 2, unit * 0.3);
    ctx.fill();
  }

  if (cfg.style === "shadow") {
    ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
    ctx.shadowBlur = Math.max(2, unit * 0.14);
    ctx.shadowOffsetY = Math.max(1, unit * 0.04);
  }

  let cursor = bleed + padX;
  const midY = height / 2;

  if (logo) {
    const source = cfg.imageTint ? tintedLogo(logo, logoWidth, logoHeight, cfg.color) : logo;
    ctx.drawImage(source, cursor, midY - logoHeight / 2, logoWidth, logoHeight);
    cursor += logoWidth + gap;
  }

  if (text) {
    ctx.font = fontString(cfg, fontPx);
    if ("letterSpacing" in ctx) ctx.letterSpacing = `${spacingPx}px`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    if (cfg.style === "outline") {
      ctx.shadowColor = "transparent";
      ctx.lineWidth = Math.max(1, fontPx * 0.05);
      ctx.lineJoin = "round";
      ctx.strokeStyle = cfg.color;
      ctx.strokeText(text, cursor, midY);
    } else {
      ctx.fillStyle = cfg.color;
      ctx.fillText(text, cursor, midY);
    }
  }

  return canvas;
}

/** Draws the watermark onto a 2D context covering `width` x `height`. Returns false if nothing was drawn. */
export async function drawWatermark(ctx, width, height, config) {
  const cfg = normalizeWatermarkConfig(config);
  const stamp = await buildStamp(cfg, Math.min(width, height));
  if (!stamp) return false;
  const { rotation, points } = computeWatermarkPlacements(
    { width, height },
    { width: stamp.width, height: stamp.height },
    cfg,
  );
  ctx.save();
  ctx.globalAlpha = cfg.opacity;
  for (const point of points) {
    ctx.save();
    ctx.translate(point.x, point.y);
    ctx.rotate(rotation);
    ctx.drawImage(stamp, -stamp.width / 2, -stamp.height / 2);
    ctx.restore();
  }
  ctx.restore();
  return points.length > 0;
}

export async function applyWatermarkToDataUrl(dataUrl, config) {
  const cfg = normalizeWatermarkConfig(config);
  if (!cfg.enabled || resolveWatermarkContent(cfg).isEmpty) return dataUrl;

  try {
    const img = await loadImage(dataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const drawn = await drawWatermark(ctx, canvas.width, canvas.height, cfg);
    return drawn ? canvas.toDataURL("image/png") : dataUrl;
  } catch (err) {
    console.error("[Watermark] Failed to apply watermark; saving the capture without it:", err);
    return dataUrl;
  }
}

/**
 * Stamps a 2D canvas in place before it is encoded. Returns false without
 * touching the canvas when the watermark is off or empty.
 */
export async function stampCanvas(canvas, config) {
  if (!canvas || !hasDrawableWatermark(config)) return false;
  const ctx = canvas.getContext?.("2d");
  if (!ctx) return false;
  return drawWatermark(ctx, canvas.width, canvas.height, config);
}

/**
 * PNG bytes with the watermark drawn on. Returns the same bytes, without
 * decoding them, when the watermark is off or empty. Like the data URL path, a
 * failed stamp keeps the capture rather than losing it.
 */
export async function applyWatermarkToPngBytes(bytes, config) {
  if (!bytes || !hasDrawableWatermark(config)) return bytes;
  const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  try {
    const img = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    if (!(await drawWatermark(ctx, canvas.width, canvas.height, config))) return bytes;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("The stamped image couldn't be encoded as PNG");
    return new Uint8Array(await blob.arrayBuffer());
  } catch (err) {
    console.error("[Watermark] Failed to apply watermark; saving the capture without it:", err);
    return bytes;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Neutral stand-in for a capture so contrast can be judged on dark and light scenes. */
function paintPreviewBackdrop(ctx, width, height, backdrop) {
  const dark = backdrop !== "light";
  const floorY = height * 0.68;
  ctx.fillStyle = dark ? "#16181b" : "#e9e9e2";
  ctx.fillRect(0, 0, width, height);
  const glow = ctx.createRadialGradient(width / 2, height * 0.35, 0, width / 2, height * 0.35, width * 0.6);
  glow.addColorStop(0, dark ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.7)");
  glow.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = dark ? "#202326" : "#d6d6cc";
  ctx.fillRect(0, floorY, width, height - floorY);
  ctx.fillStyle = dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)";
  ctx.fillRect(0, floorY, width, 1);
}

/**
 * Renders the Settings preview into an offscreen canvas. The caller copies the
 * newest result onto the visible canvas, so slower earlier renders never land
 * on top of newer ones and no PNG is encoded per change.
 */
export async function renderWatermarkPreviewCanvas(width, height, config, { backdrop = "dark" } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  paintPreviewBackdrop(ctx, width, height, backdrop);
  await drawWatermark(ctx, width, height, { ...normalizeWatermarkConfig(config), enabled: true });
  return canvas;
}

/**
 * Reads a user-picked image file into a compact PNG data URL suitable for prefs.
 * The source file is only read, never modified.
 */
export async function importWatermarkImage(file) {
  if (!file) throw new Error("No file was selected.");
  if (file.size > WATERMARK_IMAGE_MAX_SOURCE_BYTES) {
    throw new Error("That image is larger than 20 MB. Export a smaller logo and try again.");
  }
  if (file.type && !WATERMARK_IMAGE_ACCEPT.split(",").includes(file.type)) {
    throw new Error("Use a PNG, WebP, SVG, or JPEG image.");
  }
  const url = URL.createObjectURL(file);
  try {
    let img;
    try {
      img = await loadImage(url);
    } catch {
      throw new Error(`Could not read ${file.name || "the image"}. The file may be damaged or unsupported.`);
    }
    // SVGs without intrinsic size report 0; rasterize them at the max edge.
    const naturalW = img.naturalWidth || WATERMARK_IMAGE_MAX_EDGE;
    const naturalH = img.naturalHeight || WATERMARK_IMAGE_MAX_EDGE;
    const scale = Math.min(1, WATERMARK_IMAGE_MAX_EDGE / Math.max(naturalW, naturalH));
    const width = Math.max(1, Math.round(naturalW * scale));
    const height = Math.max(1, Math.round(naturalH * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(img, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/png");
    if (dataUrl.length > WATERMARK_IMAGE_MAX_STORED_CHARS) {
      throw new Error("That logo is too detailed to store. Try a simpler or smaller PNG.");
    }
    return { dataUrl, width, height, name: file.name || "Logo" };
  } finally {
    URL.revokeObjectURL(url);
  }
}
