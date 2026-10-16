// License plates as the game draws them. vehicle_licenseplate composes the
// plate background with up to 8 letters sampled from a distance-field font
// atlas (vehicle_generic_plate_font, 16 x 4 cells). The plate style's
// background, font colour, outline and text box come from the game's
// carcols.ymt <VehiclePlates>, exported by the bridge. Pure and deterministic:
// image data in, image data out.

export const PLATE_MAX_LENGTH = 8;
export const PLATE_FONT_COLUMNS = 16;
export const PLATE_FONT_ROWS = 4;
// GTA's default plate format: two digits, three letters, three digits.
export const DEFAULT_PLATE_TEXT = "46EEK572";

// SetVehicleNumberPlateTextIndex order.
export const PLATE_STYLE_NAMES = Object.freeze([
  "Blue on White 1",
  "Yellow on Black",
  "Yellow on Blue",
  "Blue on White 2",
  "Blue on White 3 (SA Exempt)",
  "Yankton",
  "eCola",
  "Las Venturas",
  "Liberty City",
  "LS Car Meet",
  "LS Panic",
  "LS Pounders",
  "Sprunk",
]);

// A custom plate image replaces a style's background. Larger images are scaled
// down to this edge before the text is composed over them.
export const PLATE_IMAGE_EXTENSIONS = Object.freeze(["png", "jpg", "jpeg", "webp", "dds"]);
export const PLATE_IMAGE_MAX_EDGE = 1024;
const PLATE_IMAGE_MAX_SOURCE_EDGE = 16384;

/**
 * A stored custom plate image: { path, stamp } where stamp marks the import so
 * re-importing an edited file at the same path redraws it. Null when absent or
 * not a supported image path.
 */
export function normalizePlateImage(value) {
  const path = typeof value?.path === "string" ? value.path.trim() : "";
  if (!path || path.length > 2048) return null;
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  if (!PLATE_IMAGE_EXTENSIONS.includes(extension)) return null;
  const stamp = Number.isFinite(value.stamp) && value.stamp >= 0 ? value.stamp : 0;
  return { path, stamp };
}

/**
 * Size a custom plate image is decoded at: within PLATE_IMAGE_MAX_EDGE on both
 * edges, aspect kept. Throws for empty or absurd dimensions.
 */
export function fitPlateImageSize(width, height, maxEdge = PLATE_IMAGE_MAX_EDGE) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width > PLATE_IMAGE_MAX_SOURCE_EDGE || height > PLATE_IMAGE_MAX_SOURCE_EDGE) {
    throw new Error(`Unsupported plate image size ${width} x ${height}.`);
  }
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Compose scale that keeps letters crisp on small backgrounds without growing large ones past the cap. */
export function plateComposeScale(background, maxEdge = PLATE_IMAGE_MAX_EDGE) {
  return Math.min(2, maxEdge / Math.max(1, background.width, background.height));
}

// Atlas offsets when the game data is unavailable: 0-9, then A-Z, space last.
const DEFAULT_OFFSETS = Object.freeze({ numericOffset: 0, alphabeticOffset: 10, spaceOffset: 63 });

/** Uppercases and keeps only characters a plate can show (A-Z, 0-9, space), up to 8. */
export function normalizePlateText(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, "")
    .slice(0, PLATE_MAX_LENGTH);
}

/**
 * Font atlas cell per plate slot. Text shorter than 8 characters is centred,
 * as the game draws custom plates.
 */
export function plateLetterIndices(text, offsets = DEFAULT_OFFSETS) {
  const { numericOffset, alphabeticOffset, spaceOffset } = { ...DEFAULT_OFFSETS, ...offsets };
  const normalized = normalizePlateText(text);
  const lead = Math.floor((PLATE_MAX_LENGTH - normalized.length) / 2);
  const padded = " ".repeat(lead) + normalized + " ".repeat(PLATE_MAX_LENGTH - lead - normalized.length);
  return [...padded].map((char) => {
    if (char >= "0" && char <= "9") return numericOffset + (char.charCodeAt(0) - 48);
    if (char >= "A" && char <= "Z") return alphabeticOffset + (char.charCodeAt(0) - 65);
    return spaceOffset;
  });
}

/** The game's plate definitions keyed by style index, with names attached. */
export function normalizePlateDefinitions(definitions) {
  const plates = Array.isArray(definitions?.plates) ? definitions.plates : [];
  return {
    offsets: {
      numericOffset: Number.isInteger(definitions?.numericOffset) ? definitions.numericOffset : DEFAULT_OFFSETS.numericOffset,
      alphabeticOffset: Number.isInteger(definitions?.alphabeticOffset) ? definitions.alphabeticOffset : DEFAULT_OFFSETS.alphabeticOffset,
      spaceOffset: Number.isInteger(definitions?.spaceOffset) ? definitions.spaceOffset : DEFAULT_OFFSETS.spaceOffset,
    },
    defaultIndex: Number.isInteger(definitions?.defaultIndex) ? definitions.defaultIndex : 0,
    plates: plates
      .filter((plate) => Number.isInteger(plate?.index) && typeof plate.diffuse === "string" && plate.diffuse)
      .map((plate) => ({
        ...plate,
        name: PLATE_STYLE_NAMES[plate.index] || `Plate ${plate.index}`,
      })),
  };
}

function hexToRgb(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  const value = match ? parseInt(match[1], 16) : 0;
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// Bilinear sample of one channel. Images are stored bottom row first (as the
// DDS decoder hands them to WebGL); u/v use the game's convention, v = 0 at the top.
function sampleChannel(image, u, v, channel) {
  const x = Math.min(image.width - 1, Math.max(0, u * image.width - 0.5));
  const y = Math.min(image.height - 1, Math.max(0, (1 - v) * image.height - 0.5));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(image.width - 1, x0 + 1);
  const y1 = Math.min(image.height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const at = (px, py) => image.data[(py * image.width + px) * 4 + channel];
  const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
  const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
  return (top * (1 - fy) + bottom * fy) / 255;
}

/**
 * Composes a plate image: the style's background with the text drawn from the
 * distance-field font, in the style's font colour and, when enabled, outline.
 * `background` and `font` are { data, width, height } RGBA, bottom row first.
 * Returns { data, width, height } in the same layout, `scale` times the
 * background size so letters stay crisp.
 */
export function composePlateImage({ background, font, plate, text, offsets, scale = 2 }) {
  const width = Math.max(1, Math.round(background.width * scale));
  const height = Math.max(1, Math.round(background.height * scale));
  const out = new Uint8ClampedArray(width * height * 4);
  const [x0, y0, x1, y1] = Array.isArray(plate?.fontExtents) && plate.fontExtents.length === 4
    ? plate.fontExtents
    : [0.08, 0.355, 0.92, 0.816];
  const letters = plateLetterIndices(text, offsets);
  const fill = hexToRgb(plate?.fontColor);
  const outline = hexToRgb(plate?.fontOutlineColor);
  const outlineOn = Boolean(plate?.fontOutline);
  const [outlineMin] = Array.isArray(plate?.fontOutlineDepth) ? plate.fontOutlineDepth : [0.475, 0.5];
  // Distance field edge at 0.5; the soft band keeps edges antialiased at 2x.
  const edge = 0.5;
  const soft = 0.06;
  for (let py = 0; py < height; py += 1) {
    // Output rows are bottom first, like the inputs.
    const v = 1 - (py + 0.5) / height;
    for (let px = 0; px < width; px += 1) {
      const u = (px + 0.5) / width;
      const index = (py * width + px) * 4;
      let r = sampleChannel(background, u, v, 0) * 255;
      let g = sampleChannel(background, u, v, 1) * 255;
      let b = sampleChannel(background, u, v, 2) * 255;
      if (u >= x0 && u < x1 && v >= y0 && v < y1) {
        const slotU = ((u - x0) / (x1 - x0)) * PLATE_MAX_LENGTH;
        const slot = Math.min(PLATE_MAX_LENGTH - 1, Math.floor(slotU));
        const cell = letters[slot];
        const cellU = (cell % PLATE_FONT_COLUMNS + (slotU - slot)) / PLATE_FONT_COLUMNS;
        const cellV = (Math.floor(cell / PLATE_FONT_COLUMNS) + (v - y0) / (y1 - y0)) / PLATE_FONT_ROWS;
        const distance = sampleChannel(font, cellU, cellV, 0);
        if (outlineOn) {
          const ring = smoothstep(outlineMin - soft, outlineMin + soft, distance);
          r += (outline[0] - r) * ring;
          g += (outline[1] - g) * ring;
          b += (outline[2] - b) * ring;
        }
        const coverage = smoothstep(edge - soft, edge + soft, distance);
        r += (fill[0] - r) * coverage;
        g += (fill[1] - g) * coverage;
        b += (fill[2] - b) * coverage;
      }
      out[index] = r;
      out[index + 1] = g;
      out[index + 2] = b;
      out[index + 3] = 255;
    }
  }
  return { data: out, width, height };
}
