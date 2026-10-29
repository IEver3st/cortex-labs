// Photo Mode's saved scene: the objects on set (base-game or user vehicles,
// peds and props), their placement, paint, doors and poses, the camera, saved
// shots, the stage and the output size. Pure, so it runs under node:test; the
// page and viewport own every three.js and Tauri side effect.

import { CLOTHING_PRESETS, BODY_PRESETS } from "./eup.js";
import { normalizePlateDefault, normalizeShowroomSubject } from "./studio-defaults.js";
import { SHOWROOM_FLOORS } from "./showroom-floors.js";
import { normalizeVehiclePaint } from "./vehicle-paint.js";
import { normalizeLightSwitches } from "./emergency-lights.js";

export const PHOTO_KINDS = Object.freeze(["vehicle", "ped", "prop"]);
export const PHOTO_OBJECT_LIMIT = 16;
export const PHOTO_SHOT_LIMIT = 12;
export const PHOTO_MODEL_EXTENSIONS = Object.freeze({
  vehicle: ["yft"],
  prop: ["ydr", "yft", "ydd"],
});

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const GAME_NAME = /^[a-z0-9_-]{1,128}$/;
const CLIP_NAME = /^[a-z0-9_@.-]{1,128}$/;
const LIGHT_DIRECTIONS = ["top", "front", "back", "left", "right"];
const POSITION_LIMIT = 200;
const LIFT_LIMIT = 50;

/* ── Lens ── */

// Focal lengths on a full-frame (36 × 24 mm) sensor; the vertical field of view
// follows from the 24 mm sensor height.
export const LENS_MIN_MM = 14;
export const LENS_MAX_MM = 200;
export const DEFAULT_LENS_MM = 35;
export const LENS_PRESETS = Object.freeze([18, 24, 35, 50, 85, 135]);

export function lensToFov(mm) {
  const focal = clamp(mm, LENS_MIN_MM, LENS_MAX_MM, DEFAULT_LENS_MM);
  return (2 * Math.atan(12 / focal) * 180) / Math.PI;
}

/* ── Output ── */

export const OUTPUT_PRESETS = Object.freeze([
  { id: "hd", label: "1920 × 1080", width: 1920, height: 1080 },
  { id: "qhd", label: "2560 × 1440", width: 2560, height: 1440 },
  { id: "uhd", label: "3840 × 2160", width: 3840, height: 2160 },
  { id: "square", label: "2048 × 2048", width: 2048, height: 2048 },
  { id: "portrait", label: "1080 × 1350", width: 1080, height: 1350 },
  { id: "story", label: "1080 × 1920", width: 1080, height: 1920 },
]);
export const DEFAULT_OUTPUT = "hd";
export const MAX_OUTPUT_EDGE = 4096;

export function normalizeOutputPreset(value, fallback = DEFAULT_OUTPUT) {
  return OUTPUT_PRESETS.some((item) => item.id === value) ? value : fallback;
}

export function outputSize(output) {
  const preset = OUTPUT_PRESETS.find((item) => item.id === output?.preset) || OUTPUT_PRESETS[0];
  return { width: preset.width, height: preset.height };
}

/** Default file name for a photo, from the scene's first visible object. */
export function photoFileName(objects, extension = "png") {
  const lead = (objects || []).find((object) => !object.hidden) || objects?.[0];
  const stem = String(lead?.name || "").replace(/\.[^.]+$/, "").replace(/[^a-z0-9_-]+/gi, "_");
  return stem ? `${stem}_photo.${extension}` : `photo.${extension}`;
}

/* ── Poses ── */

// Stills and loops from the game's own animation dictionaries. Each entry is
// [dictionary, clip] per gender; one pair serves both where the game has no
// female version (the skeletons share bone tags). A missing dictionary is
// reported by the export, never faked.
export const PHOTO_POSES = Object.freeze([
  { id: "bind", label: "A-pose" },
  { id: "idle", label: "Standing", male: ["move_m@generic", "idle"], female: ["move_f@generic", "idle"] },
  { id: "walk", label: "Walking", male: ["move_m@generic", "walk"], female: ["move_f@generic", "walk"] },
  {
    id: "belt",
    label: "Hands on belt",
    male: ["amb@world_human_cop_idles@male@base", "base"],
    female: ["amb@world_human_cop_idles@female@base", "base"],
  },
  {
    id: "crossed",
    label: "Arms crossed",
    male: ["anim@heists@heist_corona@single_team", "single_team_loop_boss"],
    female: ["amb@world_human_hang_out_street@female_arms_crossed@base", "base"],
  },
  { id: "clasped", label: "Hands clasped", both: ["amb@world_human_stand_guard@male@base", "base"] },
  { id: "lean", label: "Leaning back", both: ["amb@world_human_leaning@male@wall@back@foot_up@idle_a", "idle_a"] },
  { id: "phone", label: "On the phone", both: ["amb@world_human_stand_mobile@male@text@base", "base"] },
  { id: "smoke", label: "Smoking", both: ["amb@world_human_smoking@male@male_a@idle_a", "idle_a"] },
  { id: "flex", label: "Flexing", both: ["amb@world_human_muscle_flex@arms_at_side@base", "base"] },
  { id: "binoculars", label: "Binoculars", both: ["amb@world_human_binoculars@male@base", "base"] },
  { id: "handsup", label: "Hands up", both: ["missminuteman_1ig_2", "handsup_base"] },
  { id: "kneel", label: "Kneeling", both: ["amb@medic@standing@kneel@base", "base"] },
  { id: "busted", label: "Hands on head", both: ["random@arrests@busted", "idle_a"] },
  { id: "cuffed", label: "Cuffed", both: ["mp_arresting", "idle"] },
  { id: "chair", label: "Seated", both: ["amb@prop_human_seat_chair@male@generic@base", "base"] },
  { id: "ground", label: "Sitting on the ground", both: ["amb@world_human_picnic@male@base", "base"] },
]);
export const DEFAULT_PHOTO_POSE = "idle";

/**
 * `{ dict, clip }` for a ped's pose, or null for the bind pose. A custom pose
 * carries its own dictionary and clip.
 */
export function photoPoseClip(ped) {
  if (ped?.pose === "custom") {
    return CLIP_NAME.test(ped.dict || "") && CLIP_NAME.test(ped.clip || "") ? { dict: ped.dict, clip: ped.clip } : null;
  }
  const pose = PHOTO_POSES.find((item) => item.id === ped?.pose);
  const pair = pose?.both || pose?.[ped?.gender === "female" ? "female" : "male"];
  return pair ? { dict: pair[0], clip: pair[1] } : null;
}

/* ── Vehicle classes ── */

export const VEHICLE_CLASS_LABELS = Object.freeze({
  VC_COMPACT: "Compacts",
  VC_SEDAN: "Sedans",
  VC_SUV: "SUVs",
  VC_COUPE: "Coupes",
  VC_MUSCLE: "Muscle",
  VC_SPORT_CLASSIC: "Sports classics",
  VC_SPORT: "Sports",
  VC_SUPER: "Super",
  VC_MOTORCYCLE: "Motorcycles",
  VC_OFF_ROAD: "Off-road",
  VC_INDUSTRIAL: "Industrial",
  VC_UTILITY: "Utility",
  VC_VAN: "Vans",
  VC_CYCLE: "Cycles",
  VC_BOAT: "Boats",
  VC_HELICOPTER: "Helicopters",
  VC_PLANE: "Planes",
  VC_SERVICE: "Service",
  VC_EMERGENCY: "Emergency",
  VC_MILITARY: "Military",
  VC_COMMERCIAL: "Commercial",
  VC_RAIL: "Trains",
  VC_OPEN_WHEEL: "Open wheel",
});

// The game spells one class two ways across DLC vehicles.meta files.
const VEHICLE_CLASS_ALIASES = Object.freeze({ VC_COMPACTS: "VC_COMPACT" });

export function canonicalVehicleClass(value) {
  return VEHICLE_CLASS_ALIASES[value] || value || "";
}

export function vehicleClassLabel(value) {
  return VEHICLE_CLASS_LABELS[canonicalVehicleClass(value)] || "Other";
}

/**
 * Filters the game's vehicle catalogue by class and a free-text query over the
 * model name, display name and make. Every token must match.
 */
export function filterGameVehicles(vehicles, { query = "", vehicleClass = "" } = {}) {
  const tokens = String(query).trim().toLowerCase().split(/\s+/).filter(Boolean);
  return (Array.isArray(vehicles) ? vehicles : []).filter((vehicle) => {
    if (vehicleClass && canonicalVehicleClass(vehicle.vehicleClass) !== vehicleClass) return false;
    if (!tokens.length) return true;
    const haystack = `${vehicle.name} ${vehicle.gameName || ""} ${vehicle.make || ""}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

/* ── Objects ── */

function clamp(value, min, max, fallback) {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function cleanId(value) {
  return typeof value === "string" && /^[a-z0-9-]{1,40}$/i.test(value) ? value : null;
}

let idCounter = 0;
export function newObjectId() {
  idCounter = (idCounter + 1) % 1e6;
  return `o${Date.now().toString(36)}${idCounter.toString(36)}`;
}

function baseName(path) {
  return String(path || "").split(/[\\/]/).pop() || "";
}

/** The label a row shows: the ped model, the game name, or the file name without its extension. */
export function objectLabel(object) {
  if (object?.kind === "ped") return object.ped?.gender === "female" ? "mp_f_freemode_01" : "mp_m_freemode_01";
  if (object?.source === "file") return baseName(object.path).replace(/\.[^.]+$/, "") || "Model";
  return object?.name || "Object";
}

export function normalizePedLook(value) {
  const source = value && typeof value === "object" ? value : {};
  const gender = source.gender === "female" ? "female" : "male";
  const bodies = BODY_PRESETS[gender];
  const outfits = CLOTHING_PRESETS[gender];
  const pose = source.pose === "custom" || PHOTO_POSES.some((item) => item.id === source.pose) ? source.pose : DEFAULT_PHOTO_POSE;
  return {
    gender,
    body: bodies.some((item) => item.id === source.body) ? source.body : bodies[0].id,
    outfit: outfits.some((item) => item.id === source.outfit) ? source.outfit : outfits[0].id,
    pose,
    dict: CLIP_NAME.test(source.dict || "") ? source.dict : "",
    clip: CLIP_NAME.test(source.clip || "") ? source.clip : "",
    time: clamp(source.time, 0, 600, 0),
    playing: source.playing === true,
  };
}

function normalizeDoors(value) {
  const out = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, amount] of Object.entries(value)) {
    if (!/^[a-z0-9_]{1,64}$/.test(key)) continue;
    const open = clamp(amount, 0, 1, 0);
    if (open > 0) out[key] = open;
  }
  return out;
}

// The widest front wheel angle Photo Mode offers; a vehicle's own steering
// lock narrows it when its handling is known.
export const STEERING_LIMIT = 60;
const MOD_SLOT = /^[A-Z0-9_]{1,40}$/;

/** A mod kit selection: the kit's name and a mod index per slot type. */
export function normalizeVehicleMods(value) {
  const source = value && typeof value === "object" ? value : {};
  const slots = {};
  for (const [type, index] of Object.entries(source.slots && typeof source.slots === "object" ? source.slots : {})) {
    const key = String(type).trim().toUpperCase();
    if (MOD_SLOT.test(key) && Number.isInteger(index) && index >= 0 && index < 1000) slots[key] = index;
  }
  const kit = typeof source.kit === "string" ? source.kit.trim().slice(0, 128) : "";
  return { kit, slots };
}

function normalizeExtras(value) {
  const out = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, on] of Object.entries(value)) {
    const index = Number(key);
    if (Number.isInteger(index) && index >= 0 && index < 100 && on === true) out[index] = true;
  }
  return out;
}

/** Vehicle-only settings: paint, doors, roof, steering, mods, extras, livery, plate. */
export function normalizeVehicleSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    paint: normalizeVehiclePaint(source.paint),
    doors: normalizeDoors(source.doors),
    roof: clamp(source.roof, 0, 1, 0),
    steering: clamp(source.steering, -STEERING_LIMIT, STEERING_LIMIT, 0),
    mods: normalizeVehicleMods(source.mods),
    extras: normalizeExtras(source.extras),
    livery: Number.isInteger(source.livery) && source.livery >= 0 && source.livery < 100 ? source.livery : null,
    plate: normalizePlateDefault(source.plate),
    // Sirens, headlights, brakes, indicators and extra lamps, as the Livery viewer's light preview takes them.
    lights: normalizeLightSwitches(source.lights),
  };
}

// The showroom lights up to this many objects with their own spotlight; the
// stage renders one shadowed spot per object, so the count is capped.
export const PHOTO_SPOTLIGHT_LIMIT = 6;
export const SPOTLIGHT_DIRECTIONS = Object.freeze(["", "top", "front", "back", "left", "right"]);

/**
 * An object's own showroom spotlight. `from` is measured from the object's
 * front; "" follows the Scene tab's direction. `color` null is the studio white.
 */
export function normalizeObjectLight(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    on: source.on !== false,
    strength: clamp(source.strength, 0, 3, 1),
    from: SPOTLIGHT_DIRECTIONS.includes(source.from) ? source.from : "",
    color: typeof source.color === "string" && HEX_COLOR.test(source.color) ? source.color.toLowerCase() : null,
    beam: source.beam !== false,
  };
}

/** Ids of the objects that get a spotlight: visible, switched on, in list order, capped. */
export function litObjectIds(objects) {
  return (Array.isArray(objects) ? objects : [])
    .filter((object) => !object.hidden && object.light?.on !== false)
    .slice(0, PHOTO_SPOTLIGHT_LIMIT)
    .map((object) => object.id);
}

/** One scene object, or null when it cannot name a model. */
export function normalizePhotoObject(value) {
  if (!value || typeof value !== "object" || !PHOTO_KINDS.includes(value.kind)) return null;
  const kind = value.kind;
  const object = {
    id: cleanId(value.id) || newObjectId(),
    kind,
    source: "game",
    name: "",
    path: "",
    hidden: value.hidden === true,
    position: [0, 0, 0],
    yaw: ((clamp(value.yaw, -3600, 3600, 0) % 360) + 360) % 360,
    light: normalizeObjectLight(value.light),
  };
  const position = Array.isArray(value.position) ? value.position : [];
  object.position = [
    clamp(position[0], -POSITION_LIMIT, POSITION_LIMIT, 0),
    clamp(position[1], -LIFT_LIMIT, LIFT_LIMIT, 0),
    clamp(position[2], -POSITION_LIMIT, POSITION_LIMIT, 0),
  ];
  if (kind === "ped") {
    object.ped = normalizePedLook(value.ped);
    object.name = object.ped.gender === "female" ? "mp_f_freemode_01" : "mp_m_freemode_01";
    return object;
  }
  if (value.source === "file") {
    const path = typeof value.path === "string" ? value.path.trim() : "";
    const extension = path.split(".").pop()?.toLowerCase();
    if (!path || !PHOTO_MODEL_EXTENSIONS[kind].includes(extension)) return null;
    object.source = "file";
    object.path = path;
    object.name = baseName(path);
  } else {
    const name = typeof value.name === "string" ? value.name.trim().toLowerCase() : "";
    if (!GAME_NAME.test(name)) return null;
    object.name = name;
  }
  if (kind === "vehicle") {
    object.vehicle = normalizeVehicleSettings(value.vehicle);
  }
  return object;
}

// New objects stand in a row along X, alternating either side of the first,
// spaced for the largest kind already on set, so nothing spawns overlapping.
const SPACING = { vehicle: 3.4, ped: 1.1, prop: 1.2 };

export function placeNewObject(objects, kind) {
  const list = Array.isArray(objects) ? objects : [];
  if (list.length === 0) return [0, 0, 0];
  const spacing = Math.max(SPACING[kind] || 1, ...list.map((object) => SPACING[object.kind] || 1));
  const taken = list.map((object) => object.position?.[0] ?? 0);
  for (let step = 1; step < 64; step += 1) {
    const x = Math.ceil(step / 2) * spacing * (step % 2 ? 1 : -1);
    if (taken.every((value) => Math.abs(value - x) >= spacing * 0.75)) return [Number(x.toFixed(3)), 0, 0];
  }
  return [0, 0, list.length * spacing];
}

/* ── Camera and shots ── */

function vector(value) {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)
    ? value.map((n) => clamp(n, -1000, 1000, 0))
    : null;
}

export function normalizeCamera(value) {
  if (!value || typeof value !== "object") return null;
  const position = vector(value.position);
  const target = vector(value.target);
  if (!position || !target) return null;
  return { position, target, lens: clamp(value.lens, LENS_MIN_MM, LENS_MAX_MM, DEFAULT_LENS_MM) };
}

function normalizeShots(value) {
  if (!Array.isArray(value)) return [];
  const shots = [];
  for (const item of value) {
    const camera = normalizeCamera(item);
    if (!camera) continue;
    const name = typeof item.name === "string" ? item.name.trim().slice(0, 40) : "";
    shots.push({ id: cleanId(item.id) || newObjectId(), name: name || `Shot ${shots.length + 1}`, ...camera });
    if (shots.length >= PHOTO_SHOT_LIMIT) break;
  }
  return shots;
}

/* ── Whole state ── */

export function normalizePhotoScene(value, prefs = {}) {
  const source = value && typeof value === "object" ? value : {};
  // A new scene starts from Settings > Studio's vehicle showroom.
  const start = prefs.showroom || normalizeShowroomSubject(null, "vehicle");
  return {
    stage: source.stage === "showroom" || source.stage === "workbench" ? source.stage : "showroom",
    light: LIGHT_DIRECTIONS.includes(source.light) ? source.light : start.light,
    spot: clamp(source.spot, 0, 2, start.spot),
    reflect: clamp(source.reflect, 0, 1, start.reflect),
    beam: typeof source.beam === "boolean" ? source.beam : start.beam,
    floor: SHOWROOM_FLOORS.includes(source.floor) ? source.floor : start.floor || "concrete",
    grid: typeof source.grid === "boolean" ? source.grid : true,
    shadows: typeof source.shadows === "boolean" ? source.shadows : true,
    ambientOcclusion: source.ambientOcclusion === true,
    backdrop: typeof source.backdrop === "string" && HEX_COLOR.test(source.backdrop) ? source.backdrop.toLowerCase() : prefs.background || "#141414",
    lightLevel: clamp(source.lightLevel, 0, 3, prefs.light ?? 1),
    // Dims the studio so vehicle lights carry the shot (0 lit, 1 dark).
    dark: clamp(source.dark, 0, 1, 0),
    // Vehicle lights: lamp glow (bloom), light thrown on the body and floor, and beam haze.
    lightGlow: clamp(source.lightGlow, 0, 2, 1),
    lightSpill: clamp(source.lightSpill, 0, 3, 1),
    haze: clamp(source.haze, 0, 2, 0),
  };
}

export function normalizePhotoState(value, prefs = {}) {
  const source = value && typeof value === "object" ? value : {};
  const objects = [];
  const seen = new Set();
  for (const item of Array.isArray(source.objects) ? source.objects : []) {
    const object = normalizePhotoObject(item);
    if (!object || seen.has(object.id)) continue;
    seen.add(object.id);
    objects.push(object);
    if (objects.length >= PHOTO_OBJECT_LIMIT) break;
  }
  const selectedId = objects.some((object) => object.id === source.selectedId) ? source.selectedId : objects[0]?.id || null;
  return {
    objects,
    selectedId,
    camera: normalizeCamera(source.camera),
    lens: clamp(source.lens, LENS_MIN_MM, LENS_MAX_MM, DEFAULT_LENS_MM),
    shots: normalizeShots(source.shots),
    scene: normalizePhotoScene(source.scene, prefs),
    output: {
      preset: normalizeOutputPreset(source.output?.preset, normalizeOutputPreset(prefs.output, DEFAULT_OUTPUT)),
      transparent: source.output?.transparent === true,
      guides: source.output?.guides !== false,
    },
    gizmo: source.gizmo === "rotate" ? "rotate" : "translate",
  };
}
