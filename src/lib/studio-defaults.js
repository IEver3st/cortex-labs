// Starting showroom, plate and steering for new work, chosen in Settings >
// Studio. Workspaces own their live values: these seed a new workspace, fill
// fields an older saved workspace never stored, and never overwrite a value
// the user set. Pure, so it runs under node:test.

import { DEFAULT_PLATE_TEXT, PLATE_STYLE_NAMES, normalizePlateImage, normalizePlateText } from "./license-plate.js";
import { clampLightElevation, normalizeLightAzimuth } from "./light-direction.js";
import { SHOWROOM_FLOORS } from "./showroom-floors.js";

export const SHOWROOM_SUBJECTS = Object.freeze(["vehicle", "ped", "prop"]);
export const SHOWROOM_STAGES = Object.freeze(["workbench", "showroom"]);
// viewer-stage.js owns the light list; it pulls in three.js, so it is repeated here.
export const SHOWROOM_LIGHT_DIRECTIONS = Object.freeze(["top", "front", "back", "left", "right"]);
export const SHOWROOM_FLOOR_FINISHES = SHOWROOM_FLOORS;

// Each workspace's tuned starting scene. Rim light only exists for peds and
// props; dark room only for props.
export const BUILT_IN_SHOWROOM = Object.freeze({
  vehicle: Object.freeze({ stage: "workbench", light: "top", spot: 1, reflect: 0.6, beam: true, floor: "concrete" }),
  ped: Object.freeze({ stage: "workbench", light: "front", spot: 1, reflect: 0.5, beam: false, rim: 0.6, floor: "concrete" }),
  prop: Object.freeze({ stage: "workbench", light: "front", spot: 1, reflect: 0.55, beam: false, rim: 0.5, floor: "polished", dark: 0 }),
});

export const DEFAULT_LIGHT = Object.freeze({ intensity: 1, azimuth: 54, elevation: 46 });
export const DEFAULT_PLATE = Object.freeze({ style: 0, text: DEFAULT_PLATE_TEXT });
// Widest default front wheel angle; each vehicle's steering lock caps it further.
export const STEERING_DEFAULT_LIMIT = 45;

function clamp(value, min, max, fallback) {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function oneOf(value, options, fallback) {
  return options.includes(value) ? value : fallback;
}

/** One subject's starting scene, with only the fields that subject uses. */
export function normalizeShowroomSubject(value, subject) {
  const base = BUILT_IN_SHOWROOM[subject] || BUILT_IN_SHOWROOM.vehicle;
  const source = value && typeof value === "object" ? value : {};
  const out = {
    stage: oneOf(source.stage, SHOWROOM_STAGES, base.stage),
    light: oneOf(source.light, SHOWROOM_LIGHT_DIRECTIONS, base.light),
    spot: clamp(source.spot, 0, 2, base.spot),
    reflect: clamp(source.reflect, 0, 1, base.reflect),
    beam: typeof source.beam === "boolean" ? source.beam : base.beam,
  };
  if ("rim" in base) out.rim = clamp(source.rim, 0, 2, base.rim);
  if ("floor" in base) out.floor = oneOf(source.floor, SHOWROOM_FLOOR_FINISHES, base.floor);
  if ("dark" in base) out.dark = clamp(source.dark, 0, 1, base.dark);
  return out;
}

export function normalizeShowroomDefaults(value) {
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(SHOWROOM_SUBJECTS.map((subject) => [subject, normalizeShowroomSubject(source[subject], subject)]));
}

/**
 * A plate style index the game defines and text a plate can show. Blank text
 * is a valid choice. A custom background image ({ path, stamp }) is kept only
 * when it names a supported image file.
 */
export function normalizePlateDefault(value) {
  const source = value && typeof value === "object" ? value : {};
  const style = Number.isInteger(source.style) && source.style >= 0 && source.style < PLATE_STYLE_NAMES.length
    ? source.style
    : DEFAULT_PLATE.style;
  const plate = { style, text: typeof source.text === "string" ? normalizePlateText(source.text) : DEFAULT_PLATE.text };
  const image = normalizePlateImage(source.image);
  return image ? { ...plate, image } : plate;
}

/** Degrees, positive steering right, in half-degree steps within ±STEERING_DEFAULT_LIMIT. */
export function normalizeSteeringDefault(value) {
  const angle = clamp(value, -STEERING_DEFAULT_LIMIT, STEERING_DEFAULT_LIMIT, 0);
  return Math.round(angle * 2) / 2 || 0;
}

/**
 * The default angle a vehicle actually starts at. Without a steering lock from
 * handling.meta the Meta panel cannot steer the wheels back, so they stay
 * straight; with one, the default is capped at the lock.
 */
export function resolveDefaultSteering(angle, lockDegrees) {
  const lock = Math.abs(Number(lockDegrees));
  if (lockDegrees == null || !Number.isFinite(lock) || lock <= 0) return 0;
  const value = normalizeSteeringDefault(angle);
  return Math.min(lock, Math.max(-lock, value));
}

export function normalizeLightDefaults(defaults) {
  const source = defaults && typeof defaults === "object" ? defaults : {};
  return {
    intensity: clamp(source.lightIntensity, 0, 3, DEFAULT_LIGHT.intensity),
    azimuth: Number.isFinite(source.lightAzimuth) ? normalizeLightAzimuth(source.lightAzimuth) : DEFAULT_LIGHT.azimuth,
    elevation: Number.isFinite(source.lightElevation) ? clampLightElevation(source.lightElevation) : DEFAULT_LIGHT.elevation,
  };
}
