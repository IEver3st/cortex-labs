import {
  DEFAULT_PAINT_FINISH,
  GTA_PAINT_FINISHES,
  GTA_VEHICLE_COLORS,
  getVehicleColor,
} from "./data/gta-vehicle-colors.js";

// A vehicle's paint as the game holds it: six body colours, each a carcols
// palette index or a custom RGB with a finish. Meshes take a colour through
// their shader's paint layer (see resolvePaintLayerSlot).

export const VEHICLE_PAINT_SLOTS = Object.freeze([
  { key: "primary", label: "Primary" },
  { key: "secondary", label: "Secondary" },
  { key: "pearlescent", label: "Pearlescent" },
  { key: "wheels", label: "Wheels" },
  { key: "interior", label: "Interior trim" },
  { key: "dashboard", label: "Dashboard" },
]);

export const VEHICLE_PAINT_KEYS = Object.freeze(VEHICLE_PAINT_SLOTS.map((slot) => slot.key));

// Slots whose finish shapes the material; the others only tint.
export const FINISHED_PAINT_KEYS = Object.freeze(["primary", "secondary"]);

export const DEFAULT_BODY_COLOR = "#e7ebf0";
export const DEFAULT_WHEEL_INDEX = 156;
const CHROME_FINISH = 7;
// Palette chrome is black diffuse; the game draws it as a mirror. Custom RGB
// on a chrome finish tints the mirror instead.
const PALETTE_CHROME_COLOR = "#c9ccd1";
// Wheels before paint slots followed the game palette were this hex.
const LEGACY_DEFAULT_WHEEL = "#81827f";
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

// Defaults for a vehicle with no preset: the game leaves pearlescent, interior
// and dashboard at index 0 and wheels at Default Alloy.
const STOCK_INDICES = { pearlescent: 0, wheels: DEFAULT_WHEEL_INDEX, interior: 0, dashboard: 0 };

function cleanHex(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  const hex = text.startsWith("#") ? text : `#${text}`;
  return HEX_COLOR.test(hex) ? hex : null;
}

function cleanFinish(value) {
  return Number.isInteger(value) && value >= 0 && value < GTA_PAINT_FINISHES.length ? value : null;
}

/** Paint for a palette index; null for an index outside the table. */
export function paintFromIndex(index) {
  const entry = Number.isInteger(index) ? getVehicleColor(index) : null;
  return entry ? { index: entry.index, color: entry.hex, finish: entry.finish } : null;
}

/** Custom RGB paint; null when the colour is not a #rrggbb hex. */
export function customPaint(color, finish = DEFAULT_PAINT_FINISH) {
  const hex = cleanHex(color);
  return hex ? { index: null, color: hex, finish: cleanFinish(finish) ?? DEFAULT_PAINT_FINISH } : null;
}

/**
 * Paint for a resolved carvariations colour ({ index, hex, finish, known }):
 * the palette entry, or a custom colour when a carcols <Colors> list
 * redefines the index. Null for an unknown colour.
 */
export function paintFromMetaColor(color) {
  if (!color?.known) return null;
  const vanilla = paintFromIndex(color.index);
  if (vanilla && vanilla.color === color.hex) return vanilla;
  return customPaint(color.hex, color.finish);
}

/** Paint for every slot: primary and secondary in the base colour, the rest stock. */
export function buildVehiclePaint(baseColor = DEFAULT_BODY_COLOR) {
  const body = customPaint(baseColor) || customPaint(DEFAULT_BODY_COLOR);
  const paint = { primary: body, secondary: { ...body } };
  for (const [key, index] of Object.entries(STOCK_INDICES)) paint[key] = paintFromIndex(index);
  return paint;
}

function normalizeSlot(key, value, fallback) {
  if (typeof value === "string") {
    if (key === "wheels" && value.trim().toLowerCase() === LEGACY_DEFAULT_WHEEL) return paintFromIndex(DEFAULT_WHEEL_INDEX);
    return customPaint(value) || fallback;
  }
  if (!value || typeof value !== "object") return fallback;
  if (Number.isInteger(value.index)) return paintFromIndex(value.index) || fallback;
  return customPaint(value.color, value.finish) || fallback;
}

/**
 * Restores saved paint. Accepts the current shape and the earlier hex-per-slot
 * map (primary, secondary, accent, glass, wheels); accent and glass were not
 * game paint and are dropped.
 */
export function normalizeVehiclePaint(paint, baseColor = DEFAULT_BODY_COLOR) {
  const fallback = buildVehiclePaint(baseColor);
  if (!paint || typeof paint !== "object") return fallback;
  const out = {};
  for (const key of VEHICLE_PAINT_KEYS) out[key] = normalizeSlot(key, paint[key], fallback[key]);
  return out;
}

/** Colour a slot shows and renders with (sRGB hex). */
export function paintDisplayColor(paint) {
  if (!paint) return DEFAULT_BODY_COLOR;
  if (paint.finish === CHROME_FINISH && paint.index != null) return PALETTE_CHROME_COLOR;
  return paint.color;
}

/** Palette name, or the custom colour's hex. */
export function paintLabel(paint) {
  if (!paint) return "";
  if (paint.index != null) return getVehicleColor(paint.index)?.name || `Colour ${paint.index}`;
  return paint.color;
}

export function finishLabel(finish) {
  return GTA_PAINT_FINISHES[finish]?.label || GTA_PAINT_FINISHES[DEFAULT_PAINT_FINISH].label;
}

/**
 * Preview material for a carcols metallic setting. The setting's highlight
 * (falloff as a Blinn-Phong exponent) becomes the clear coat on glossy paint
 * and the base roughness on matte and worn paint; a low fresnel marks a mirror
 * metal. An approximation of the game's paint shader, not parity.
 */
export function paintFinishProfile(finish) {
  const setting = GTA_PAINT_FINISHES[finish] || GTA_PAINT_FINISHES[DEFAULT_PAINT_FINISH];
  const lobe = Math.sqrt(2 / (setting.specFalloff + 2));
  if (setting.specFresnel < 0.5) {
    return { metalness: 1, roughness: Math.max(0.04, lobe), clearcoat: 0, clearcoatRoughness: 0, specularIntensity: 1 };
  }
  if (setting.specFresnel <= 0.8) {
    return { metalness: 0.85, roughness: Math.min(0.45, lobe * 2), clearcoat: 0, clearcoatRoughness: 0, specularIntensity: 1 };
  }
  if (setting.specFalloff >= 100) {
    return {
      metalness: 0.05 + 0.25 * setting.specInt,
      roughness: 0.38,
      clearcoat: setting.specInt,
      clearcoatRoughness: lobe,
      specularIntensity: setting.specInt,
    };
  }
  return {
    metalness: 0.05,
    roughness: Math.min(0.9, Math.max(0.3, lobe * 1.4)),
    clearcoat: 0,
    clearcoatRoughness: 0,
    specularIntensity: setting.specInt,
  };
}

// Palette groups in the order the game lists them, named by finish.
export const PAINT_PALETTE_GROUPS = Object.freeze(
  [
    { label: "Metallic", finishes: [0, 1, 2] },
    { label: "Matte", finishes: [3] },
    { label: "Util", finishes: [4] },
    { label: "Worn", finishes: [5] },
    { label: "Metals", finishes: [6, 7, 8, 9] },
  ].map((group) => ({
    label: group.label,
    colors: GTA_VEHICLE_COLORS.filter((entry) => group.finishes.includes(entry.finish)),
  })),
);
