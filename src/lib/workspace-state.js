// Normalizers for what a workspace saves and restores. Older snapshots lack
// newer fields and storage can hold anything, so restore reads each field
// through here: a missing or malformed value falls back to its default
// instead of reaching the viewer or a page.

import { DEFAULT_HAZE, normalizeLensTints, normalizeLightSwitches } from "./emergency-lights.js";

export const VIEWER_TEXTURE_MODES = Object.freeze(["livery", "everything", "eup", "multi", "sirens"]);
export const MATERIAL_SURFACES = Object.freeze(["paint", "chrome", "plastic", "metal", "glass"]);
export const MAX_MATERIAL_TEXTURES = 6;
// Wider than any handling.meta steering lock; the Meta panel caps the shown angle at the lock.
export const SAVED_STEERING_LIMIT = 90;

/** A viewer mode, or "" when the value is not one. */
export function normalizeTextureMode(value) {
  return VIEWER_TEXTURE_MODES.includes(value) ? value : "";
}

function clampNumber(value, min, max, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** The wheel angle saved for `modelPath`, or null when it belongs to another model or isn't a number. */
export function normalizeSavedSteering(value, modelPath) {
  const saved = plainObject(value);
  if (!saved || !modelPath || saved.path !== modelPath) return null;
  if (typeof saved.angle !== "number" || !Number.isFinite(saved.angle)) return null;
  return { path: modelPath, angle: clampNumber(saved.angle, -SAVED_STEERING_LIMIT, SAVED_STEERING_LIMIT, 0) };
}

/**
 * The Lights panel choices a workspace keeps: switches, muted sirens, playback
 * speed, spill, glow, fog and the preview lens colours with the model they
 * were picked on. The siren setting and ULC config are read from the model's
 * files again, so they are not part of it. Null when nothing was saved.
 */
export function normalizeSavedLightPreview(value) {
  const saved = plainObject(value);
  if (!saved) return null;
  const muted = Array.isArray(saved.muted)
    ? [...new Set(saved.muted.filter((index) => Number.isInteger(index) && index >= 0 && index < 256))].sort((a, b) => a - b)
    : [];
  const lens = plainObject(saved.lens);
  const tints = lens && typeof lens.path === "string" && lens.path ? normalizeLensTints(lens.tints) : {};
  return {
    switches: normalizeLightSwitches(saved.switches),
    muted,
    speed: clampNumber(saved.speed, 0, 4, 1),
    spill: saved.spill !== false,
    spillStrength: clampNumber(saved.spillStrength, 0, 3, 1),
    glow: clampNumber(saved.glow, 0, 2, 1),
    haze: clampNumber(saved.haze, 0, 2, DEFAULT_HAZE),
    lens: Object.keys(tints).length ? { path: lens.path, tints } : null,
  };
}

/** The Materials panel (surface, sliders and texture maps). Null when nothing was saved. */
export function normalizeSavedMaterials(value) {
  const saved = plainObject(value);
  if (!saved) return null;
  const textures = (Array.isArray(saved.textures) ? saved.textures : [])
    .filter((texture) => plainObject(texture) && typeof texture.path === "string" && texture.path.trim())
    .slice(0, MAX_MATERIAL_TEXTURES)
    .map((texture, index) => ({
      id: typeof texture.id === "string" && texture.id ? texture.id : `mat-tex-restored-${index}`,
      name: typeof texture.name === "string" && texture.name ? texture.name : texture.path.split(/[\\/]/).pop(),
      path: texture.path,
      thumbnail: null,
    }));
  return {
    type: MATERIAL_SURFACES.includes(saved.type) ? saved.type : "paint",
    lightIntensity: clampNumber(saved.lightIntensity, 0, 3, 1),
    glossiness: clampNumber(saved.glossiness, 0, 1, 0.5),
    roughness: clampNumber(saved.roughness, 0, 1, 0.3),
    clearcoat: clampNumber(saved.clearcoat, 0, 1, 0),
    textures,
  };
}

function pickValues(value, keep) {
  const source = plainObject(value);
  const out = {};
  if (!source) return out;
  for (const [key, entry] of Object.entries(source)) if (keep(entry)) out[key] = entry;
  return out;
}

/**
 * Variant Builder's variant list. Every entry gets a unique id, a name and
 * object-shaped layer choices, and exactly one entry is the base (the first
 * one marked, else the first). An empty or unreadable list becomes one base.
 */
export function normalizeVariantList(value, makeId) {
  const variants = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    if (!plainObject(raw)) continue;
    let id = typeof raw.id === "string" && raw.id ? raw.id : makeId();
    while (seen.has(id)) id = makeId();
    seen.add(id);
    const variant = {
      ...raw,
      id,
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name : `Variant ${variants.length + 1}`,
      isBase: raw.isBase === true,
      locked: raw.locked === true,
      toggleable: pickValues(raw.toggleable, (entry) => typeof entry === "boolean"),
      variantSelections: pickValues(raw.variantSelections, (entry) => Number.isInteger(entry) && entry >= 0),
    };
    if (raw.layerVisibility !== undefined) variant.layerVisibility = pickValues(raw.layerVisibility, (entry) => typeof entry === "boolean");
    variants.push(variant);
  }
  if (variants.length === 0) {
    return [{ id: makeId(), name: "Base", isBase: true, toggleable: {}, variantSelections: {}, locked: true }];
  }
  const baseIndex = Math.max(0, variants.findIndex((variant) => variant.isBase));
  return variants.map((variant, index) => (variant.isBase === (index === baseIndex) ? variant : { ...variant, isBase: index === baseIndex }));
}
