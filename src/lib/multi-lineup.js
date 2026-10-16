// Multi lineup: the vehicles shown side by side in a Multi tab.
//
// Pure helpers shared by App, the Multi workspace and Node tests. Slot order is
// display order (letters A..F follow it). Nothing here touches three.js, Tauri
// or the filesystem.

import { SHOWROOM_FLOORS } from "./showroom-floors.js";
import { VEHICLE_PAINT_KEYS, normalizeVehiclePaint } from "./vehicle-paint.js";

export const MAX_LINEUP_SLOTS = 6;
export const LINEUP_GAP = 0.6;
export const VEHICLE_MODEL_EXTENSIONS = Object.freeze(["yft", "clmesh", "dff"]);
export const PAINT_KEYS = VEHICLE_PAINT_KEYS;
export const WINDOW_TARGET_PRESETS = Object.freeze(["auto", "none", "all"]);

const DEFAULT_PAINT = "#e7ebf0";
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const SLOT_ID = /^slot-(\d{1,6})$/;

export function slotLetter(index) {
  return Number.isInteger(index) && index >= 0 && index < 26 ? String.fromCharCode(65 + index) : "?";
}

function extensionOf(path) {
  const match = String(path || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : "";
}

export function isVehicleModelPath(path) {
  return typeof path === "string" && VEHICLE_MODEL_EXTENSIONS.includes(extensionOf(path));
}

function cleanPath(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanColor(value, fallback) {
  return typeof value === "string" && HEX_COLOR.test(value) ? value.toLowerCase() : fallback;
}

/** A vehicle's game paint (see vehicle-paint.js); `source` may be saved paint in either format. */
export function buildPaint(base = DEFAULT_PAINT, source = null) {
  return normalizeVehiclePaint(source, cleanColor(base, DEFAULT_PAINT));
}

function cleanPosition(value) {
  if (!Array.isArray(value) || value.length !== 3) return null;
  return value.every((item) => Number.isFinite(item)) ? value.map((item) => Number(item)) : null;
}

/** Facing about the vertical axis, in degrees [0, 360); 0 faces the way the model was built. */
export function normalizeYaw(value) {
  if (!Number.isFinite(value)) return 0;
  const degrees = ((value % 360) + 360) % 360;
  return Number(degrees.toFixed(2)) % 360;
}

function cleanWindowTarget(value) {
  if (typeof value !== "string" || !value) return "auto";
  if (WINDOW_TARGET_PRESETS.includes(value)) return value;
  return /^(material|mesh):/.test(value) ? value : "auto";
}

export function nextSlotId(slots) {
  let max = 0;
  for (const slot of slots || []) {
    const match = typeof slot?.id === "string" ? slot.id.match(SLOT_ID) : null;
    if (match) max = Math.max(max, Number.parseInt(match[1], 10));
  }
  return `slot-${max + 1}`;
}

export function createSlot(slots, { bodyColor = DEFAULT_PAINT, ...overrides } = {}) {
  return {
    id: nextSlotId(slots),
    modelPath: "",
    liveryPath: "",
    windowPath: "",
    windowTarget: "auto",
    paint: buildPaint(bodyColor),
    visible: true,
    position: null,
    yaw: 0,
    ...overrides,
  };
}

function normalizeSlot(raw, bodyColor) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" && SLOT_ID.test(raw.id) ? raw.id : null;
  if (!id) return null;
  const modelPath = cleanPath(raw.modelPath);
  return {
    id,
    // Multi compares vehicles only; clothing belongs to EUP Studio.
    modelPath: isVehicleModelPath(modelPath) ? modelPath : "",
    liveryPath: cleanPath(raw.liveryPath),
    windowPath: cleanPath(raw.windowPath),
    windowTarget: cleanWindowTarget(raw.windowTarget),
    paint: buildPaint(bodyColor, raw.paint),
    visible: raw.visible !== false,
    position: cleanPosition(raw.position),
    yaw: normalizeYaw(raw.yaw),
  };
}

/**
 * Restores a saved lineup. Malformed slots and duplicate ids are dropped, the
 * list is capped at MAX_LINEUP_SLOTS, and there is always at least one slot.
 */
export function normalizeLineup(value, { bodyColor = DEFAULT_PAINT } = {}) {
  const source = value && typeof value === "object" ? value : {};
  const slots = [];
  const seen = new Set();
  for (const raw of Array.isArray(source.slots) ? source.slots : []) {
    if (slots.length >= MAX_LINEUP_SLOTS) break;
    const slot = normalizeSlot(raw, bodyColor);
    if (!slot || seen.has(slot.id)) continue;
    seen.add(slot.id);
    slots.push(slot);
  }
  if (slots.length === 0) slots.push(createSlot([], { bodyColor }));
  const selectedId = slots.some((slot) => slot.id === source.selectedId) ? source.selectedId : slots[0].id;
  return { slots, selectedId };
}

/**
 * Lineup from a workspace saved before Multi held a list (dual A/B fields).
 * Clothing comparisons (dualTextureMode "eup") are not carried over; the
 * caller tells the user they moved to EUP Studio.
 */
export function migrateDualState(state, { bodyColor = DEFAULT_PAINT } = {}) {
  const source = state && typeof state === "object" ? state : {};
  if (source.lineup && typeof source.lineup === "object") {
    return { lineup: normalizeLineup(source.lineup, { bodyColor }), droppedClothing: false };
  }
  const hasDual = ["dualModelAPath", "dualModelBPath", "dualTextureAPath", "dualTextureBPath"]
    .some((key) => cleanPath(source[key]));
  if (!hasDual) return { lineup: normalizeLineup(null, { bodyColor }), droppedClothing: false };
  if (source.dualTextureMode === "eup") {
    return { lineup: normalizeLineup(null, { bodyColor }), droppedClothing: true };
  }
  const slots = [];
  for (const letter of ["A", "B"]) {
    const modelPath = cleanPath(source[`dualModel${letter}Path`]);
    const liveryPath = cleanPath(source[`dualTexture${letter}Path`]);
    const windowPath = cleanPath(source[`dualWindowTexture${letter}Path`]);
    if (!modelPath && !liveryPath && !windowPath) continue;
    const color = cleanColor(source[`dualBodyColor${letter}`], cleanColor(source.bodyColor, bodyColor));
    slots.push({
      id: `slot-${slots.length + 1}`,
      modelPath,
      liveryPath,
      windowPath,
      windowTarget: source[`dualWindowTexture${letter}Target`],
      paint: buildPaint(color),
      visible: true,
      position: source[`dualModel${letter}Pos`],
    });
  }
  const selectedIndex = source.dualSelectedSlot === "B" && slots.length > 1 ? 1 : 0;
  const lineup = normalizeLineup({ slots, selectedId: slots[selectedIndex]?.id }, { bodyColor });
  return { lineup, droppedClothing: false };
}

/**
 * Centres of vehicles placed side by side along Z (the width axis after the
 * viewer levels a model), `gap` metres apart, centred on zero.
 */
export function lineUpOffsets(widths, gap = LINEUP_GAP) {
  const list = (Array.isArray(widths) ? widths : []).map((width) => (Number.isFinite(width) && width > 0 ? width : 0));
  if (list.length === 0) return [];
  const offsets = [0];
  for (let i = 1; i < list.length; i += 1) {
    offsets.push(offsets[i - 1] + list[i - 1] / 2 + gap + list[i] / 2);
  }
  const span = offsets[offsets.length - 1];
  return offsets.map((offset) => offset - span / 2);
}

export function lineupWatchPaths(slots) {
  const paths = [];
  const seen = new Set();
  for (const slot of slots || []) {
    for (const path of [slot?.liveryPath, slot?.windowPath]) {
      const key = pathKey(path);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      paths.push(path);
    }
  }
  return paths;
}

export function pathKey(path) {
  return typeof path === "string" ? path.trim().replace(/\\/g, "/").toLowerCase() : "";
}

/** Copies a slot's settings, facing included, into a new slot (a free id, no saved position). */
export function duplicateSlot(slots, id) {
  const source = (slots || []).find((slot) => slot.id === id);
  if (!source || (slots || []).length >= MAX_LINEUP_SLOTS) return null;
  return { ...source, id: nextSlotId(slots), paint: { ...source.paint }, position: null, visible: true };
}

export const LINEUP_SHOWROOM_LIGHTS = Object.freeze(["each", "one"]);
export const LINEUP_SHOWROOM_FLOORS = SHOWROOM_FLOORS;

/**
 * Multi's showroom options: a spotlight per vehicle ("each") or one over the
 * whole lineup ("one"), and the floor finish. A saved floor is kept; a new
 * lineup, or one saved without a floor, takes `defaultFloor` (Settings >
 * Studio > Vehicles).
 */
export function normalizeLineupShowroom(value, defaultFloor = "concrete") {
  const source = value && typeof value === "object" ? value : {};
  const fallbackFloor = LINEUP_SHOWROOM_FLOORS.includes(defaultFloor) ? defaultFloor : "concrete";
  return {
    lights: LINEUP_SHOWROOM_LIGHTS.includes(source.lights) ? source.lights : "each",
    floor: LINEUP_SHOWROOM_FLOORS.includes(source.floor) ? source.floor : fallbackFloor,
  };
}

/** The window target the viewer applies: "auto" resolves to the detected glass. */
export function resolveWindowTarget(target, detected) {
  if (target === "auto") return detected || "none";
  return target || "none";
}
