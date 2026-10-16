// Kit Shoot: photographs a vehicle's carcols mod kit. Plans which shots a run
// takes and where they are written, aims per-slot cameras, compares frames to
// find what a part changed, turns run results into QA issues, and describes
// the run in a versioned manifest that other tools (the website importer) can
// read. Pure; the workspace hook drives the viewer and writes the files.

import { EXPORT_FORMATS, exportFileStem } from "./eup-export.js";
import { getVehicleColor } from "./data/gta-vehicle-colors.js";

export const KIT_SHOOT_SCHEMA = "cortex.kitShoot";
export const KIT_SHOOT_VERSION = 1;

// eVehicleModType order: a slot's position here is the modType that
// SetVehicleMod / GetVehicleMod take. Performance and wheel types are listed
// so the numbering stays right; carcols visibleMods never use them.
const MOD_TYPE_ORDER = [
  "VMT_SPOILER", "VMT_BUMPER_F", "VMT_BUMPER_R", "VMT_SKIRT", "VMT_EXHAUST",
  "VMT_CHASSIS", "VMT_GRILL", "VMT_BONNET", "VMT_WING_L", "VMT_WING_R",
  "VMT_ROOF", "VMT_ENGINE", "VMT_BRAKES", "VMT_GEARBOX", "VMT_HORN",
  "VMT_SUSPENSION", "VMT_ARMOUR", "VMT_NITROUS", "VMT_TURBO", "VMT_SUBWOOFER",
  "VMT_TYRE_SMOKE", "VMT_HYDRAULICS", "VMT_XENON_LIGHTS", "VMT_WHEELS", "VMT_WHEELS_REAR_OR_HYDRAULICS",
  "VMT_PLTHOLDER", "VMT_PLTVANITY", "VMT_INTERIOR1", "VMT_INTERIOR2", "VMT_INTERIOR3",
  "VMT_INTERIOR4", "VMT_INTERIOR5", "VMT_SEATS", "VMT_STEERING", "VMT_KNOB",
  "VMT_PLAQUE", "VMT_ICE", "VMT_TRUNK", "VMT_HYDRO", "VMT_ENGINEBAY1",
  "VMT_ENGINEBAY2", "VMT_ENGINEBAY3", "VMT_CHASSIS2", "VMT_CHASSIS3", "VMT_CHASSIS4",
  "VMT_CHASSIS5", "VMT_DOOR_L", "VMT_DOOR_R", "VMT_LIVERY_MOD", "VMT_LIGHTBAR",
];

/** The numeric modType for a carcols slot type, or null when the type is unknown. */
export function modTypeId(type) {
  const index = MOD_TYPE_ORDER.indexOf(String(type || "").trim().toUpperCase());
  return index < 0 ? null : index;
}

export const SHOOT_MODES = Object.freeze(["parts", "builds"]);
export const SHOOT_BASES = Object.freeze(["stock", "build"]);
export const SHOOT_CAMERAS = Object.freeze(["auto", "view"]);
export const BEFORE_AFTER_STYLES = Object.freeze(["side", "wipe"]);
export const CURRENT_BUILD = "__current__";
export const MAX_PAINTS = 8;

/** Whole-vehicle angles for build shots. `view` is the viewfinder as framed when the run starts. */
export const BUILD_ANGLES = Object.freeze([
  { id: "view", label: "This view" },
  { id: "front34", label: "Front 3/4", direction: [0.8, 0.14, -0.8] },
  { id: "rear34", label: "Rear 3/4", direction: [0.8, 0.16, 0.8] },
  { id: "front", label: "Front", direction: [0, 0.06, -1] },
  { id: "side", label: "Side", direction: [1, 0.04, 0] },
  { id: "back", label: "Rear", direction: [0, 0.06, 1] },
  { id: "top", label: "Top", direction: [0, 1, 0.02] },
]);

export const DEFAULT_KIT_SHOOT_SETTINGS = Object.freeze({
  mode: "parts",
  base: "stock",
  camera: "auto",
  slots: null,
  format: "landscape",
  high: false,
  beforeAfter: true,
  beforeAfterStyle: "side",
  zoomToChange: false,
  sheets: true,
  videos: false,
  angles: ["front34", "rear34"],
  builds: [CURRENT_BUILD],
  paints: [],
});

function pickEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function uniqueStrings(values) {
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = typeof value === "string" ? value.trim() : "";
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

/** Settings from storage or the panel, with unknown values replaced by defaults. */
export function normalizeKitShootSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  const defaults = DEFAULT_KIT_SHOOT_SETTINGS;
  const angles = Array.isArray(source.angles)
    ? BUILD_ANGLES.map((angle) => angle.id).filter((id) => source.angles.includes(id))
    : [...defaults.angles];
  const paints = [];
  for (const entry of Array.isArray(source.paints) ? source.paints : []) {
    if (Number.isInteger(entry) && getVehicleColor(entry) && !paints.includes(entry)) paints.push(entry);
    if (paints.length >= MAX_PAINTS) break;
  }
  return {
    mode: pickEnum(source.mode, SHOOT_MODES, defaults.mode),
    base: pickEnum(source.base, SHOOT_BASES, defaults.base),
    camera: pickEnum(source.camera, SHOOT_CAMERAS, defaults.camera),
    // null means every slot; a list is an explicit choice kept across kits.
    slots: Array.isArray(source.slots)
      ? uniqueStrings(source.slots.map((type) => (typeof type === "string" ? type.toUpperCase() : type)))
      : null,
    format: EXPORT_FORMATS.some((item) => item.id === source.format) ? source.format : defaults.format,
    high: source.high === true,
    beforeAfter: source.beforeAfter !== false,
    beforeAfterStyle: pickEnum(source.beforeAfterStyle, BEFORE_AFTER_STYLES, defaults.beforeAfterStyle),
    zoomToChange: source.zoomToChange === true,
    sheets: source.sheets !== false,
    videos: source.videos === true,
    angles,
    builds: Array.isArray(source.builds) ? uniqueStrings(source.builds) : [...defaults.builds],
    paints,
  };
}

/**
 * Parses "0, 27 64" into GTA colour indices. Unknown or repeated entries are
 * reported, not guessed; the list stops at MAX_PAINTS.
 */
export function parsePaintList(text) {
  const indices = [];
  const invalid = [];
  for (const token of String(text || "").split(/[\s,;]+/).filter(Boolean)) {
    const value = /^\d+$/.test(token) ? Number(token) : NaN;
    if (!Number.isInteger(value) || !getVehicleColor(value)) {
      invalid.push(token);
      continue;
    }
    if (!indices.includes(value) && indices.length < MAX_PAINTS) indices.push(value);
  }
  return { indices, invalid };
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

/** Folder name for a slot: modType first so folders sort in game order. */
export function slotFolderName(slot) {
  const id = modTypeId(slot?.type);
  const stem = exportFileStem(slot?.label || slot?.type, "slot");
  return `${id == null ? "zz" : pad2(id)}-${stem}`;
}

/** File name for a part shot: `stock.png`, or the carcols index and name. */
export function partFileName(modIndex, name) {
  if (!Number.isInteger(modIndex)) return "stock.png";
  return `${pad2(modIndex)}-${exportFileStem(name, "part")}.png`;
}

/** Where a shot's small JPEG preview is written: the same path under `thumbs/`. */
export function thumbPath(file) {
  return `thumbs/${String(file).replace(/\.png$/i, ".jpg")}`;
}

function modName(mod) {
  return mod ? mod.displayName || mod.label || mod.modelName : "Stock";
}

/**
 * Every part of each chosen slot, shot on a base. The first shot of a slot is
 * its base (stock, or the build's part for that slot) and is the "before" for
 * that slot's before/after pairs. Selections are `{ [slotType]: modIndex }`.
 */
export function planPartsShoot({ kit, base = {}, slotTypes = null }) {
  const wanted = Array.isArray(slotTypes) ? new Set(slotTypes.map((type) => String(type).toUpperCase())) : null;
  const slots = [];
  for (const slot of kit?.slots || []) {
    if (wanted && !wanted.has(slot.type)) continue;
    const baseIndex = Number.isInteger(base?.[slot.type]) && slot.mods.some((mod) => mod.index === base[slot.type])
      ? base[slot.type]
      : null;
    const folder = slotFolderName(slot);
    const baseMod = slot.mods.find((mod) => mod.index === baseIndex) || null;
    const baseSelection = { ...base };
    if (baseIndex == null) delete baseSelection[slot.type];
    const shots = [{
      id: `${slot.type}:${baseIndex ?? "stock"}`,
      modIndex: baseIndex,
      isBase: true,
      name: modName(baseMod),
      mod: baseMod,
      selection: baseSelection,
      file: `${folder}/${partFileName(baseIndex, modName(baseMod))}`,
    }];
    for (const mod of slot.mods) {
      if (mod.index === baseIndex) continue;
      shots.push({
        id: `${slot.type}:${mod.index}`,
        modIndex: mod.index,
        isBase: false,
        name: modName(mod),
        mod,
        selection: { ...base, [slot.type]: mod.index },
        file: `${folder}/${partFileName(mod.index, modName(mod))}`,
      });
    }
    slots.push({
      type: slot.type,
      modType: modTypeId(slot.type),
      label: slot.label,
      displayName: slot.displayName,
      folder,
      baseIndex,
      shots,
    });
  }
  return { slots, shotCount: slots.reduce((sum, slot) => sum + slot.shots.length, 0) };
}

/** The selection a saved build applies to a kit, dropping slots or indices the kit no longer has. */
export function buildSelectionForKit(kit, mods) {
  const selection = {};
  for (const slot of kit?.slots || []) {
    const index = mods?.[slot.type];
    if (Number.isInteger(index) && slot.mods.some((mod) => mod.index === index)) selection[slot.type] = index;
  }
  return selection;
}

function paintStem(index) {
  const color = getVehicleColor(index);
  return `paint-${pad2(index)}-${exportFileStem(color?.name, "colour")}`;
}

/**
 * Builds x paints x angles. A null paint is the paint on the vehicle when the
 * run starts. When `stockBefore` is on, the stock vehicle is shot at every
 * angle and paint too, as the "before" of each build's before/after pairs.
 */
export function planBuildsShoot({ kit, builds = [], angles = [], paints = [], stockBefore = false }) {
  const angleList = BUILD_ANGLES.filter((angle) => angles.includes(angle.id));
  const paintList = [null, ...paints.filter((index) => getVehicleColor(index))];
  const usedStems = new Set();
  const planned = [];
  for (const build of builds) {
    let stem = exportFileStem(build.name, "build");
    for (let n = 2; usedStems.has(stem); n += 1) stem = `${exportFileStem(build.name, "build")}-${n}`;
    usedStems.add(stem);
    planned.push({
      name: build.name,
      stem,
      selection: buildSelectionForKit(kit, build.mods),
      shots: paintList.flatMap((paint) => angleList.map((angle) => ({
        angle: angle.id,
        paint,
        file: `builds/${stem}/${angle.id}${paint == null ? "" : `-${paintStem(paint)}`}.png`,
      }))),
    });
  }
  const stock = stockBefore
    ? paintList.flatMap((paint) => angleList.map((angle) => ({
        angle: angle.id,
        paint,
        file: `builds/stock/${angle.id}${paint == null ? "" : `-${paintStem(paint)}`}.png`,
      })))
    : [];
  return {
    angles: angleList,
    paints: paintList,
    stock,
    builds: planned,
    shotCount: stock.length + planned.reduce((sum, build) => sum + build.shots.length, 0),
  };
}

// ── Cameras ──

const INTERIOR_TYPES = new Set([
  "VMT_INTERIOR1", "VMT_INTERIOR2", "VMT_INTERIOR3", "VMT_INTERIOR4", "VMT_INTERIOR5",
  "VMT_SEATS", "VMT_STEERING", "VMT_KNOB", "VMT_PLAQUE", "VMT_ICE",
]);

// Stock bones hidden while a slot is shot, so parts the body would cover can
// be seen: the mod shop opens the hood and boot for these instead.
const REVEAL_BONES = new Map([
  ["VMT_ENGINEBAY1", ["bonnet"]],
  ["VMT_ENGINEBAY2", ["bonnet"]],
  ["VMT_ENGINEBAY3", ["bonnet"]],
  ["VMT_TRUNK", ["boot"]],
]);

/** Stock bones to hide while shooting a slot with the automatic camera. */
export function revealBonesForSlot(type) {
  return REVEAL_BONES.get(String(type || "").toUpperCase()) || [];
}

function center(box) {
  return [0, 1, 2].map((i) => (box.min[i] + box.max[i]) / 2);
}

function normalize(vector) {
  const length = Math.hypot(...vector);
  return length > 0 ? vector.map((value) => value / length) : [0, 0, 1];
}

/**
 * Aims the automatic camera for a slot. `focus` is the union of the slot's
 * parts (and the stock meshes they replace) and `vehicle` the vehicle's
 * framing bounds, both `{ min: [x,y,z], max: [x,y,z] }` in a space where the
 * vehicle's front faces -z and +y is up. The camera looks from the side of the
 * vehicle the parts sit on; interior parts get a close, wide camera from the
 * cabin. The framed box is never smaller than a share of the vehicle, so a
 * small part keeps enough body around it to read.
 */
export function planFocusShot({ slotType, focus, vehicle }) {
  const type = String(slotType || "").toUpperCase();
  const vehicleCenter = center(vehicle);
  const half = [0, 1, 2].map((i) => Math.max((vehicle.max[i] - vehicle.min[i]) / 2, 1e-6));
  const target = focus ? center(focus) : vehicleCenter;
  const offset = [0, 1, 2].map((i) => (target[i] - vehicleCenter[i]) / half[i]);
  const vehicleSize = Math.max(...half) * 2;

  if (INTERIOR_TYPES.has(type)) {
    return {
      direction: normalize([0.18, 0.5, 1]),
      box: boxAround(target, focus, vehicleSize * 0.12),
      interior: true,
      fov: 70,
      minDistance: 0.25,
      maxDistance: Math.max(0.6, Math.min(1.2, half[2] * 0.55)),
    };
  }

  let direction;
  if (REVEAL_BONES.has(type) && type !== "VMT_TRUNK") {
    direction = [0.35, 1.3, -0.55];
  } else {
    const x = Math.abs(offset[0]) > 0.4 ? Math.sign(offset[0]) : 0.85;
    const z = Math.abs(offset[2]) > 0.4 ? Math.sign(offset[2]) : -0.45;
    const y = offset[1] > 0.45 ? 0.9 : offset[1] < -0.3 ? 0.1 : 0.24;
    direction = [x, y, z];
  }
  return {
    direction: normalize(direction),
    box: boxAround(target, focus, vehicleSize * 0.38),
    interior: false,
    fov: null,
    minDistance: null,
    maxDistance: null,
  };
}

function boxAround(target, focus, minSize) {
  const min = [];
  const max = [];
  for (let i = 0; i < 3; i += 1) {
    const lo = focus ? focus.min[i] : target[i];
    const hi = focus ? focus.max[i] : target[i];
    const grow = Math.max(0, minSize - (hi - lo)) / 2;
    min.push(lo - grow);
    max.push(hi + grow);
  }
  return { min, max };
}

// ── Finding the angle ──

const PROBE_AZIMUTHS = [0, 45, 90, 135, 180, 225, 270, 315];
const PROBE_ELEVATIONS = [
  { id: "low", y: 0.16, prior: 0.06 },
  { id: "high", y: 0.62, prior: 0 },
];
const AZIMUTH_NAMES = {
  0: "front", 45: "front-right", 90: "right", 135: "rear-right",
  180: "rear", 225: "rear-left", 270: "left", 315: "front-left",
};

/**
 * Camera directions tried for a slot before shooting it. Each frames the
 * whole vehicle from one side, so every part is in view; the probe keeps the
 * one where the parts change the most pixels. 3/4 views get a small head
 * start so a tie falls to the angle a photographer would pick. Directions use
 * the viewer's space: the vehicle's front faces -z and +x is its right.
 */
export function probeCandidates(slotType) {
  const type = String(slotType || "").toUpperCase();
  const candidates = [];
  for (const elevation of PROBE_ELEVATIONS) {
    for (const azimuth of PROBE_AZIMUTHS) {
      const radians = (azimuth * Math.PI) / 180;
      candidates.push({
        id: `${AZIMUTH_NAMES[azimuth]}-${elevation.id}`,
        kind: "vehicle",
        direction: normalize([Math.sin(radians), elevation.y, -Math.cos(radians)]),
        prior: (azimuth % 90 === 45 ? 0.18 : 0.04) + elevation.prior,
      });
    }
  }
  candidates.push({ id: "top", kind: "vehicle", direction: normalize([0, 1, 0.02]), prior: REVEAL_BONES.has(type) ? 0.2 : 0 });
  if (INTERIOR_TYPES.has(type)) candidates.push({ id: "cabin", kind: "cabin", direction: null, prior: 0.25 });
  return candidates;
}

/** Below this share of a probe frame, a part doesn't count as seen. */
export const PROBE_VISIBLE_FRACTION = 0.0006;

/**
 * Scores one candidate from each part's change against the base. Seeing more
 * parts wins first; among those, larger changes win, capped so one big part
 * can't outvote the rest.
 */
export function scoreProbe(results, prior = 0) {
  const seen = results.filter((result) => result && result.fraction >= PROBE_VISIBLE_FRACTION);
  if (!seen.length) return 0;
  const size = seen.reduce((sum, result) => sum + Math.sqrt(Math.min(result.fraction, 0.08) / 0.08), 0) / seen.length;
  return seen.length + size * 0.9 + prior;
}

/** Index of the best candidate, or -1 when no candidate shows any part. */
export function pickProbe(candidates, resultsByCandidate) {
  let best = -1;
  let bestScore = 0;
  candidates.forEach((candidate, index) => {
    const score = scoreProbe(resultsByCandidate[index] || [], candidate.prior);
    if (score > bestScore + 1e-9 && score > candidate.prior) {
      best = index;
      bestScore = score;
    }
  });
  return best;
}

/** The box around every box given, or null. */
export function unionBoxes(boxes) {
  const list = (boxes || []).filter(Boolean);
  if (!list.length) return null;
  const minX = Math.min(...list.map((box) => box.x));
  const minY = Math.min(...list.map((box) => box.y));
  const maxX = Math.max(...list.map((box) => box.x + box.width));
  const maxY = Math.max(...list.map((box) => box.y + box.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * A crop of a width x height frame, as fractions of it, around the changes
 * in `boxes` (frame pixels). It keeps the frame's aspect, pads the parts so
 * they sit inside the body around them, and never zooms past `minShare` of
 * the frame, which keeps enough vehicle in view to place the part.
 */
export function partsCrop({ boxes, width, height, pad = 0.32, minShare = 0.26 }) {
  const union = unionBoxes(boxes);
  if (!union) return null;
  const crop = cropAround({ box: union, width, height, pad, minShare });
  return { x: crop.x / width, y: crop.y / height, width: crop.width / width, height: crop.height / height };
}

// ── Image comparison ──

/**
 * Compares two RGBA buffers of the same size. A pixel changes when its RGB
 * difference sums above `threshold`. Returns the changed share and the box
 * around the changes, or a null box when too little changed to count.
 */
export function diffImages(a, b, width, height, { threshold = 48, minFraction = 0.0004 } = {}) {
  if (!a || !b || a.length !== b.length || a.length < width * height * 4) {
    throw new Error("diffImages needs two RGBA buffers of the same size");
  }
  let changed = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const delta = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (delta <= threshold) continue;
      changed += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const fraction = changed / (width * height);
  const box = fraction >= minFraction && maxX >= 0
    ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
    : null;
  return { changed, fraction, box };
}

/**
 * A crop of a width x height frame with the frame's aspect that contains `box`
 * (in the same pixels) plus padding, never smaller than `minShare` of the
 * frame and never outside it. A null box crops nothing.
 */
export function changeCrop({ box, width, height, pad = 0.18, minShare = 0.4 }) {
  if (!box) return { x: 0, y: 0, width, height };
  const crop = cropAround({ box, width, height, pad, minShare });
  return { x: Math.round(crop.x), y: Math.round(crop.y), width: Math.round(crop.width), height: Math.round(crop.height) };
}

function cropAround({ box, width, height, pad, minShare }) {
  const aspect = width / height;
  let cropWidth = Math.max(box.width * (1 + pad * 2), box.height * (1 + pad * 2) * aspect, width * minShare);
  cropWidth = Math.min(width, cropWidth);
  const cropHeight = cropWidth / aspect;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const x = Math.min(Math.max(cx - cropWidth / 2, 0), width - cropWidth);
  const y = Math.min(Math.max(cy - cropHeight / 2, 0), height - cropHeight);
  return { x, y, width: cropWidth, height: cropHeight };
}

/** Where a wipe divides before and after: through the change, kept off the edges. */
export function wipeSplit(box, width) {
  if (!box) return Math.round(width / 2);
  const middle = box.x + box.width / 2;
  return Math.round(Math.min(Math.max(middle, width * 0.25), width * 0.75));
}

/**
 * Groups shots whose frames are the same. `entries` are `{ id, pixels }` with
 * RGBA buffers of one size. Returns a map from a shot id to the earlier id it
 * duplicates.
 */
export function findDuplicateShots(entries, width, height, options = {}) {
  const duplicates = new Map();
  for (let i = 0; i < entries.length; i += 1) {
    if (!entries[i]?.pixels || duplicates.has(entries[i].id)) continue;
    for (let j = i + 1; j < entries.length; j += 1) {
      if (!entries[j]?.pixels || duplicates.has(entries[j].id)) continue;
      const { box } = diffImages(entries[i].pixels, entries[j].pixels, width, height, options);
      if (!box) duplicates.set(entries[j].id, entries[i].id);
    }
  }
  return duplicates;
}

// ── QA ──

export const ISSUE_CODES = Object.freeze({
  KIT_NOT_LINKED: "warning",
  MODEL_MISSING: "error",
  LOAD_FAILED: "error",
  CAPTURE_FAILED: "error",
  TEXTURES_FAILED: "warning",
  TEXTURES_MISSING: "warning",
  NO_VISIBLE_CHANGE: "warning",
  DUPLICATE_PART: "warning",
  // Packs often list bones that only other mods use, so this is a note.
  STOCK_NOT_HIDDEN: "info",
  UNNAMED_PART: "info",
  BUILD_PARTS_DROPPED: "warning",
});

function issue(code, message, context = {}) {
  return { code, severity: ISSUE_CODES[code] || "warning", message, ...context };
}

/**
 * QA issues from a parts run. Each shot result carries what the run observed:
 * `missing` model names, `loadErrors`, texture counts, the change against its
 * slot's base (`changeFraction`, null when not compared), `duplicateOf`, and
 * whether stock meshes were hidden for a part that lists turnOffBones.
 */
export function collectShotIssues({ kit, slots, camera = "auto", namesAvailable = true }) {
  const issues = [];
  if (kit && kit.linked === false) {
    issues.push(issue("KIT_NOT_LINKED", `${kit.kitName} isn't listed under kits in carvariations.meta, so the game won't offer these parts.`));
  }
  for (const slot of slots || []) {
    for (const shot of slot.shots || []) {
      if (!Number.isInteger(shot.modIndex)) continue;
      const where = { slotType: slot.type, modType: slot.modType, modIndex: shot.modIndex };
      const name = `${slot.displayName || slot.label}: ${shot.name}`;
      for (const modelName of shot.missing || []) {
        issues.push(issue("MODEL_MISSING", `${name} uses ${modelName}.yft, which isn't in this resource.`, where));
      }
      for (const error of shot.loadErrors || []) {
        issues.push(issue("LOAD_FAILED", `${name}: ${error.modelName} didn't load (${error.message}).`, where));
      }
      if (shot.captureError) {
        issues.push(issue("CAPTURE_FAILED", `${name} wasn't saved: ${shot.captureError}`, where));
      }
      if (shot.textures?.failed > 0) {
        issues.push(issue("TEXTURES_FAILED", `${name}: ${shot.textures.failed} texture${shot.textures.failed === 1 ? "" : "s"} couldn't load.`, where));
      }
      if (shot.textures?.missing > 0) {
        issues.push(issue("TEXTURES_MISSING", `${name}: ${shot.textures.missing} texture${shot.textures.missing === 1 ? "" : "s"} weren't found.`, where));
      }
      const loaded = !(shot.missing?.length) && !(shot.loadErrors?.length) && !shot.captureError;
      if (loaded && shot.duplicateOf) {
        issues.push(issue("DUPLICATE_PART", `${name} looks identical to ${shot.duplicateOf}.`, where));
      } else if (loaded && shot.changeFraction != null && shot.changeFraction < 0.0004) {
        const hint = camera === "view" ? " from this camera" : "";
        issues.push(issue("NO_VISIBLE_CHANGE", `${name} looks the same as ${slot.baseName || "stock"}${hint}.`, where));
      }
      if (loaded && shot.mod?.turnOffBones?.length && shot.boneDataAvailable && shot.hiddenMeshCount === 0) {
        issues.push(issue("STOCK_NOT_HIDDEN", `${name} turns off ${shot.mod.turnOffBones.join(", ")}, but no stock mesh uses ${shot.mod.turnOffBones.length === 1 ? "that bone" : "those bones"}.`, where));
      }
      // Without any readable names (often escrowed scripts) every part would
      // be flagged, so this only runs when the resource registers some.
      if (namesAvailable && shot.mod?.label && shot.mod.named === false) {
        issues.push(issue("UNNAMED_PART", `${name} has no AddTextEntry for ${shot.mod.label}, so the game shows the raw label.`, where));
      }
    }
  }
  return issues;
}

// ── Manifest and report ──

function selectionList(selection) {
  return Object.entries(selection || {})
    .filter(([, index]) => Number.isInteger(index))
    .map(([slotType, modIndex]) => ({ slotType, modType: modTypeId(slotType), modIndex }))
    .sort((a, b) => (a.modType ?? 99) - (b.modType ?? 99) || a.slotType.localeCompare(b.slotType));
}

function paintEntry(index) {
  if (index == null) return null;
  const color = getVehicleColor(index);
  return color ? { index, name: color.name, hex: color.hex } : { index };
}

/**
 * The run as JSON-ready data. Every path is relative to the manifest and uses
 * forward slashes. Part shots carry the modType and modIndex that
 * SetVehicleMod takes (-1 is stock), so an importer can key them directly.
 */
export function buildKitShootManifest({
  createdAt,
  appVersion = "",
  modelName,
  kit,
  settings,
  size,
  complete,
  base = {},
  parts = null,
  builds = null,
  sheets = [],
  videos = [],
  issues = [],
}) {
  return {
    schema: KIT_SHOOT_SCHEMA,
    version: KIT_SHOOT_VERSION,
    generator: appVersion ? `Cortex Studio ${appVersion}` : "Cortex Studio",
    createdAt,
    complete: complete === true,
    vehicle: {
      modelName,
      kit: kit ? { name: kit.kitName, id: kit.id ?? null, linked: kit.linked !== false } : null,
    },
    settings: {
      mode: settings.mode,
      camera: settings.mode === "parts" ? settings.camera : null,
      base: settings.mode === "parts" ? settings.base : null,
      format: settings.format,
      width: size.width,
      height: size.height,
      beforeAfter: settings.beforeAfter ? settings.beforeAfterStyle : null,
      zoomToChange: settings.beforeAfter && settings.zoomToChange,
    },
    base: selectionList(base),
    slots: (parts || []).map((slot) => ({
      slotType: slot.type,
      modType: slot.modType,
      label: slot.label,
      name: slot.displayName,
      folder: slot.folder,
      sheet: slot.sheet || null,
      video: slot.video || null,
      camera: slot.camera || null,
      parts: slot.shots.map((shot) => ({
        modIndex: Number.isInteger(shot.modIndex) ? shot.modIndex : -1,
        isBase: shot.isBase === true,
        name: shot.name,
        label: shot.mod?.label || null,
        modelName: shot.mod?.modelName || null,
        linkedModels: shot.mod?.linkedModels || [],
        file: shot.saved ? shot.file : null,
        thumb: shot.saved && shot.thumb ? shot.thumb : null,
        beforeAfter: shot.beforeAfter || null,
        changed: shot.changeFraction == null ? null : Number(shot.changeFraction.toFixed(5)),
      })),
    })),
    builds: (builds || []).map((build) => ({
      name: build.name,
      mods: selectionList(build.selection),
      shots: build.shots.map((shot) => ({
        angle: shot.angle,
        paint: paintEntry(shot.paint),
        file: shot.saved ? shot.file : null,
        thumb: shot.saved && shot.thumb ? shot.thumb : null,
        beforeAfter: shot.beforeAfter || null,
      })),
    })),
    sheets: sheets.filter(Boolean),
    videos: videos.filter(Boolean),
    issues,
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function encodePath(path) {
  return String(path).split("/").map(encodeURIComponent).join("/");
}

function figure(file, caption, sub = "") {
  if (!file) {
    return `<figure class="missing"><div class="hole">Not saved</div><figcaption>${escapeHtml(caption)}${sub ? `<small>${escapeHtml(sub)}</small>` : ""}</figcaption></figure>`;
  }
  return `<figure><a href="${encodePath(file)}"><img loading="lazy" src="${encodePath(file)}" alt="${escapeHtml(caption)}"></a><figcaption>${escapeHtml(caption)}${sub ? `<small>${escapeHtml(sub)}</small>` : ""}</figcaption></figure>`;
}

/** A self-contained HTML page for the run, linking images beside it. */
export function renderKitShootReport(manifest) {
  const kit = manifest.vehicle?.kit;
  const counts = { error: 0, warning: 0, info: 0 };
  for (const entry of manifest.issues || []) counts[entry.severity] = (counts[entry.severity] || 0) + 1;
  const issueRows = (manifest.issues || []).map((entry) => `<li class="${escapeHtml(entry.severity)}"><span>${escapeHtml(entry.severity)}</span><code>${escapeHtml(entry.code)}</code>${escapeHtml(entry.message)}</li>`).join("");
  const slotSections = (manifest.slots || []).map((slot) => {
    const media = [
      slot.sheet ? `<a href="${encodePath(slot.sheet)}">Sheet</a>` : "",
      slot.video ? `<a href="${encodePath(slot.video)}">Video</a>` : "",
    ].filter(Boolean).join(" · ");
    const parts = slot.parts.map((part) => figure(
      part.file,
      part.name,
      `${part.modIndex < 0 ? "stock" : `index ${part.modIndex}`}${part.isBase ? " · base" : ""}${part.modelName ? ` · ${part.modelName}` : ""}`,
    )).join("");
    const pairs = slot.parts.filter((part) => part.beforeAfter).map((part) => figure(part.beforeAfter, `${part.name}: before and after`)).join("");
    return `<section><h2>${escapeHtml(slot.name)} <small>${escapeHtml(slot.slotType)} · modType ${slot.modType ?? "?"}</small></h2>${media ? `<p class="media">${media}</p>` : ""}<div class="grid">${parts}</div>${pairs ? `<h3>Before and after</h3><div class="grid wide">${pairs}</div>` : ""}</section>`;
  }).join("");
  const buildSections = (manifest.builds || []).map((build) => {
    const mods = build.mods.length ? build.mods.map((mod) => `${mod.slotType} ${mod.modIndex}`).join(", ") : "stock parts";
    const shots = build.shots.map((shot) => figure(shot.file, `${shot.angle}${shot.paint ? ` · ${shot.paint.name || shot.paint.index}` : ""}`)).join("");
    const pairs = build.shots.filter((shot) => shot.beforeAfter).map((shot) => figure(shot.beforeAfter, `${shot.angle}: stock and ${build.name}`)).join("");
    return `<section><h2>${escapeHtml(build.name)} <small>${escapeHtml(mods)}</small></h2><div class="grid">${shots}</div>${pairs ? `<h3>Before and after</h3><div class="grid wide">${pairs}</div>` : ""}</section>`;
  }).join("");
  const sheets = (manifest.sheets || []).map((sheet) => figure(sheet, "Builds sheet")).join("");
  const videos = (manifest.videos || []).map((video) => `<a href="${encodePath(video)}">${escapeHtml(video)}</a>`).join(" · ");
  const title = `${manifest.vehicle?.modelName || "Vehicle"}${kit ? ` · ${kit.name}` : ""}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kit shoot · ${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--paper:#f0f0e9;--ink:#0f1012;--muted:#575b61;--line:#d2d2c7;--accent:#3462bd;--warn:#a8741a;--err:#b94842}
@media (prefers-color-scheme:dark){:root{--paper:#121316;--ink:#f0f0e9;--muted:#a2a6ad;--line:#2c2f35;--accent:#558bf6;--warn:#e0b45c;--err:#dc7c72}}
*{box-sizing:border-box}body{margin:0;padding:32px clamp(16px,4vw,48px);background:var(--paper);color:var(--ink);font:14px/1.5 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif}
h1{margin:0;font:italic 800 clamp(30px,4vw,48px)/1 "Barlow Condensed","Arial Narrow",sans-serif;text-transform:uppercase}
h2{margin:0 0 12px;font-size:15px;font-weight:650}h2 small,figcaption small{display:block;color:var(--muted);font:12px/1.4 Consolas,"Cascadia Mono",monospace}
h3{margin:18px 0 10px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.facts{display:flex;flex-wrap:wrap;gap:6px 22px;margin:12px 0 0;color:var(--muted);font:12px Consolas,"Cascadia Mono",monospace}
section{padding:24px 0;border-top:1px solid var(--line)}header{padding-bottom:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px}.grid.wide{grid-template-columns:repeat(auto-fill,minmax(360px,1fr))}
figure{margin:0}figure img{display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:6px;background:var(--line)}
figcaption{margin-top:6px;font-size:13px;font-weight:600}.hole{display:grid;place-items:center;aspect-ratio:16/9;border:1px dashed var(--line);border-radius:6px;color:var(--muted);font-size:12px}
ul.issues{list-style:none;margin:0;padding:0}ul.issues li{display:flex;gap:10px;align-items:baseline;padding:7px 0;border-bottom:1px solid var(--line)}
ul.issues span{min-width:58px;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}ul.issues .error span{color:var(--err)}ul.issues .warning span{color:var(--warn)}ul.issues .info span{color:var(--muted)}
code{font:11.5px Consolas,"Cascadia Mono",monospace;color:var(--muted)}a{color:var(--accent)}.media{margin:-4px 0 12px;font-size:13px}
</style>
</head>
<body>
<header>
<h1>${escapeHtml(title)}</h1>
<p class="facts"><span>${escapeHtml(manifest.settings?.mode === "builds" ? "Builds" : "Every part")}</span><span>${manifest.settings?.width}×${manifest.settings?.height}</span><span>${escapeHtml(manifest.createdAt || "")}</span><span>${manifest.complete ? "complete" : "partial run"}</span><span>${counts.error} errors · ${counts.warning} warnings · ${counts.info} notes</span></p>
</header>
${manifest.issues?.length ? `<section><h2>Checks</h2><ul class="issues">${issueRows}</ul></section>` : `<section><h2>Checks</h2><p>No problems found.</p></section>`}
${slotSections}${buildSections}${sheets ? `<section><h2>Sheets</h2><div class="grid wide">${sheets}</div></section>` : ""}${videos ? `<section><h2>Videos</h2><p class="media">${videos}</p></section>` : ""}
</body>
</html>
`;
}

// ── Saved builds ──

const BUILDS_VERSION = 1;
const MAX_BUILDS_PER_VEHICLE = 24;

/** A mod selection `{ [slotType]: modIndex }` with unknown keys and bad indices dropped. */
export function normalizeModChoices(mods) {
  const out = {};
  for (const [type, index] of Object.entries(mods && typeof mods === "object" ? mods : {})) {
    const slot = String(type).trim().toUpperCase();
    if (slot && Number.isInteger(index) && index >= 0) out[slot] = index;
  }
  return out;
}

/** Saved builds from storage: `{ version, vehicles: { [model]: [{ name, kitName, mods }] } }`. */
export function normalizeSavedBuilds(value) {
  const vehicles = {};
  const source = value && typeof value === "object" && value.vehicles && typeof value.vehicles === "object" ? value.vehicles : {};
  for (const [model, list] of Object.entries(source)) {
    const key = String(model).trim().toLowerCase();
    if (!key || !Array.isArray(list)) continue;
    const builds = [];
    for (const entry of list) {
      const name = typeof entry?.name === "string" ? entry.name.trim().slice(0, 60) : "";
      if (!name || name === CURRENT_BUILD || builds.some((build) => build.name === name)) continue;
      builds.push({ name, kitName: typeof entry.kitName === "string" ? entry.kitName : "", mods: normalizeModChoices(entry.mods) });
      if (builds.length >= MAX_BUILDS_PER_VEHICLE) break;
    }
    if (builds.length) vehicles[key] = builds;
  }
  return { version: BUILDS_VERSION, vehicles };
}

/** Adds or replaces a named build for a vehicle. */
export function upsertSavedBuild(store, modelName, build) {
  const normalized = normalizeSavedBuilds(store);
  const key = String(modelName || "").trim().toLowerCase();
  const name = String(build?.name || "").trim().slice(0, 60);
  if (!key || !name || name === CURRENT_BUILD) return normalized;
  const list = (normalized.vehicles[key] || []).filter((entry) => entry.name !== name);
  list.push({ name, kitName: build.kitName || "", mods: normalizeModChoices(build.mods) });
  normalized.vehicles[key] = list.slice(-MAX_BUILDS_PER_VEHICLE);
  return normalized;
}

export function removeSavedBuild(store, modelName, name) {
  const normalized = normalizeSavedBuilds(store);
  const key = String(modelName || "").trim().toLowerCase();
  const list = (normalized.vehicles[key] || []).filter((entry) => entry.name !== name);
  if (list.length) normalized.vehicles[key] = list;
  else delete normalized.vehicles[key];
  return normalized;
}

// ── Review ──

const ANGLE_LABELS = new Map(BUILD_ANGLES.map((angle) => [angle.id, angle.label]));

/**
 * What the review screen shows for a manifest: one group per slot (or per
 * build), each with its shots in order. Every item knows the item it compares
 * with (the slot's base, or stock at the same angle and paint) and the issues
 * that name it. Issues that name no part stay in `general`.
 */
export function reviewGroups(manifest) {
  const issues = Array.isArray(manifest?.issues) ? manifest.issues : [];
  const partIssues = new Map();
  const general = [];
  for (const entry of issues) {
    if (entry.slotType && Number.isInteger(entry.modIndex)) {
      const key = `${entry.slotType}:${entry.modIndex}`;
      if (!partIssues.has(key)) partIssues.set(key, []);
      partIssues.get(key).push(entry);
    } else {
      general.push(entry);
    }
  }

  const groups = [];
  for (const slot of manifest?.slots || []) {
    const items = slot.parts.map((part) => ({
      id: `${slot.slotType}:${part.modIndex}`,
      title: part.name,
      detail: [part.modIndex < 0 ? "Stock" : `Index ${part.modIndex}`, part.modelName].filter(Boolean).join(" · "),
      isBase: part.isBase === true,
      file: part.file,
      thumb: part.thumb || part.file,
      beforeAfter: part.beforeAfter,
      changed: part.changed,
      issues: partIssues.get(`${slot.slotType}:${part.modIndex}`) || [],
    }));
    const base = items.find((item) => item.isBase && item.file) || null;
    for (const item of items) item.compareTo = item === base ? null : base;
    groups.push({
      id: slot.slotType,
      title: slot.name,
      subtitle: slot.label !== slot.name ? slot.label : slot.slotType,
      baseTitle: base?.title || "",
      items,
      sheet: slot.sheet || null,
      video: slot.video || null,
      issueCount: items.reduce((sum, item) => sum + item.issues.length, 0),
    });
  }

  const builds = manifest?.builds || [];
  const stock = builds.find((build) => build.name === "Stock" && build.mods.length === 0) || null;
  const shotKey = (shot) => `${shot.angle}|${shot.paint?.index ?? ""}`;
  const stockByKey = new Map((stock?.shots || []).map((shot) => [shotKey(shot), shot]));
  const shotItem = (build, shot) => ({
    id: `build:${build.name}:${shotKey(shot)}`,
    title: [ANGLE_LABELS.get(shot.angle) || shot.angle, shot.paint?.name].filter(Boolean).join(" · "),
    detail: build.name,
    isBase: build === stock,
    file: shot.file,
    thumb: shot.thumb || shot.file,
    beforeAfter: shot.beforeAfter,
    changed: null,
    issues: [],
  });
  const stockItems = new Map();
  if (stock) {
    for (const shot of stock.shots) stockItems.set(shotKey(shot), shotItem(stock, shot));
  }
  for (const build of builds) {
    const items = build === stock
      ? stock.shots.map((shot) => stockItems.get(shotKey(shot)))
      : build.shots.map((shot) => shotItem(build, shot));
    if (build !== stock) {
      build.shots.forEach((shot, index) => {
        const match = stockByKey.has(shotKey(shot)) ? stockItems.get(shotKey(shot)) : null;
        items[index].compareTo = match?.file ? match : null;
      });
    } else {
      items.forEach((item) => { item.compareTo = null; });
    }
    groups.push({
      id: `build:${build.name}`,
      title: build.name,
      subtitle: build.mods.length ? `${build.mods.length} part${build.mods.length === 1 ? "" : "s"}` : "Stock parts",
      baseTitle: "Stock",
      items,
      sheet: null,
      video: null,
      issueCount: 0,
    });
  }

  return {
    groups,
    general,
    sheets: manifest?.sheets || [],
    videos: manifest?.videos || [],
    shotCount: groups.reduce((sum, group) => sum + group.items.filter((item) => item.file).length, 0),
  };
}
