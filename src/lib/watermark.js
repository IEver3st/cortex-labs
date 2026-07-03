export const WATERMARK_FONTS = [
  { value: "Inter", label: "Inter" },
  { value: "Arial", label: "Arial" },
  { value: "Helvetica", label: "Helvetica" },
  { value: "Georgia", label: "Georgia" },
  { value: "Times New Roman", label: "Times New Roman" },
  { value: "Courier New", label: "Courier New" },
  { value: "Verdana", label: "Verdana" },
  { value: "Trebuchet MS", label: "Trebuchet MS" },
  { value: "Impact", label: "Impact" },
  { value: "Comic Sans MS", label: "Comic Sans MS" },
];

export const WATERMARK_POSITIONS = [
  { value: "top-left", label: "↖" },
  { value: "top-right", label: "↗" },
  { value: "bottom-left", label: "↙" },
  { value: "bottom-right", label: "↘" },
  { value: "center", label: "◎" },
  { value: "tiled", label: "▦" },
];

export const DEFAULT_WATERMARK = {
  enabled: false,
  text: "© Cortex Labs",
  font: "Inter",
  fontSize: 32,
  color: "#ffffff",
  opacity: 0.5,
  position: "bottom-right",
  rotation: 0,
};

const VALID_POSITIONS = new Set(WATERMARK_POSITIONS.map((p) => p.value));

export function normalizeWatermarkConfig(config) {
  if (!config || typeof config !== "object") return { ...DEFAULT_WATERMARK };
  return {
    enabled: Boolean(config.enabled),
    text: typeof config.text === "string" ? config.text : DEFAULT_WATERMARK.text,
    font: typeof config.font === "string" ? config.font : DEFAULT_WATERMARK.font,
    fontSize: Number.isFinite(config.fontSize)
      ? Math.max(8, Math.min(200, Math.round(config.fontSize)))
      : DEFAULT_WATERMARK.fontSize,
    color: typeof config.color === "string" ? config.color : DEFAULT_WATERMARK.color,
    opacity: Number.isFinite(config.opacity)
      ? Math.max(0, Math.min(1, config.opacity))
      : DEFAULT_WATERMARK.opacity,
    position: VALID_POSITIONS.has(config.position) ? config.position : DEFAULT_WATERMARK.position,
    rotation: Number.isFinite(config.rotation)
      ? Math.max(-180, Math.min(180, Math.round(config.rotation)))
      : DEFAULT_WATERMARK.rotation,
  };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function drawWatermark(ctx, width, height, cfg) {
  ctx.save();
  ctx.globalAlpha = cfg.opacity;
  ctx.fillStyle = cfg.color;
  ctx.font = `${cfg.fontSize}px "${cfg.font}", sans-serif`;
  const rad = (cfg.rotation * Math.PI) / 180;

  if (cfg.position === "tiled") {
    const metrics = ctx.measureText(cfg.text);
    const textWidth = metrics.width;
    const spacing = textWidth + 80;
    const rowSpacing = cfg.fontSize * 3;

    ctx.translate(width / 2, height / 2);
    ctx.rotate(rad);

    const diag = Math.sqrt(width * width + height * height);
    const cols = Math.ceil(diag / spacing) + 2;
    const rows = Math.ceil(diag / rowSpacing) + 2;

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for (let row = -rows; row <= rows; row++) {
      for (let col = -cols; col <= cols; col++) {
        const x = col * spacing + (row % 2 === 0 ? 0 : spacing / 2);
        const y = row * rowSpacing;
        ctx.fillText(cfg.text, x, y);
      }
    }
  } else {
    const padding = Math.max(20, cfg.fontSize * 0.5);
    let x, y;

    switch (cfg.position) {
      case "top-left":
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        x = padding;
        y = padding;
        break;
      case "top-right":
        ctx.textAlign = "right";
        ctx.textBaseline = "top";
        x = width - padding;
        y = padding;
        break;
      case "bottom-left":
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        x = padding;
        y = height - padding;
        break;
      case "bottom-right":
        ctx.textAlign = "right";
        ctx.textBaseline = "bottom";
        x = width - padding;
        y = height - padding;
        break;
      case "center":
      default:
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        x = width / 2;
        y = height / 2;
        break;
    }

    ctx.translate(x, y);
    ctx.rotate(rad);
    ctx.fillText(cfg.text, 0, 0);
  }

  ctx.restore();
}

export async function applyWatermarkToDataUrl(dataUrl, config) {
  const cfg = normalizeWatermarkConfig(config);
  if (!cfg.enabled || !cfg.text) return dataUrl;

  try {
    const img = await loadImage(dataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    drawWatermark(ctx, canvas.width, canvas.height, cfg);
    return canvas.toDataURL("image/png");
  } catch {
    return dataUrl;
  }
}

const STOCK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
  <rect width="800" height="600" fill="#1a1a2e"/>
  <path d="M320 280 Q320 220 380 220 Q400 180 450 190 Q510 180 520 240 Q570 250 560 300 Q550 330 510 330 L330 330 Q290 330 300 300 Q300 285 320 280 Z" fill="#3a3a4e" stroke="#5a6a80" stroke-width="2"/>
</svg>`;

const STOCK_DATA_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(STOCK_SVG)}`;

export async function renderWatermarkPreview(config) {
  const cfg = normalizeWatermarkConfig(config);
  const img = await loadImage(STOCK_DATA_URL);
  const canvas = document.createElement("canvas");
  canvas.width = 800;
  canvas.height = 600;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, 800, 600);
  if (cfg.enabled && cfg.text) {
    drawWatermark(ctx, canvas.width, canvas.height, cfg);
  }
  return canvas.toDataURL("image/png");
}
