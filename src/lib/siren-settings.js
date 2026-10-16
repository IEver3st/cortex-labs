// carcols.meta siren settings for the siren editor: defaults, sequencer
// patterns, presets, draft checks, and the XML writer that puts an edited
// setting back into a carcols file. Pure and deterministic; the caller reads
// and writes files.
//
// A setting has the shape vehicle-meta.js parses (parseSiren), so a draft runs
// straight through the viewer's light preview. Fields the editor does not model
// ride along in `extraXml` and are written back verbatim.

import { findChild, findChildren, numberValue, parseXml } from "./xml-lite.js";
import { describeFields, formatChangeValue, groupByChange, humanizeKey, leafChanges } from "./change-summary.js";

export const MAX_SIRENS = 32;
export const SEQUENCER_STEPS = 32;
export const LAMP_KEYS = Object.freeze(["leftHeadLight", "rightHeadLight", "leftTailLight", "rightTailLight"]);
export const LAMP_LABELS = Object.freeze({
  leftHeadLight: "Left headlight",
  rightHeadLight: "Right headlight",
  leftTailLight: "Left taillight",
  rightTailLight: "Right taillight",
});

const FULL = 0xffffffff;

// ---------------------------------------------------------------------------
// Sequencers
// ---------------------------------------------------------------------------

/** 32-bit unsigned value, or 0 for anything that is not one. */
export function toSequencer(value) {
  return Number.isFinite(value) ? Math.trunc(value) >>> 0 : 0;
}

/** "1010..." (32 characters, MSB first) to a sequencer, or null when malformed. */
export function sequencerFromPattern(pattern) {
  const text = String(pattern ?? "").replace(/\s+/g, "");
  if (!/^[01]{32}$/.test(text)) return null;
  return parseInt(text, 2) >>> 0;
}

export function patternFromSequencer(sequencer) {
  return toSequencer(sequencer).toString(2).padStart(SEQUENCER_STEPS, "0");
}

export function sequencerStep(sequencer, step) {
  return ((toSequencer(sequencer) >>> (SEQUENCER_STEPS - 1 - step)) & 1) === 1;
}

export function setSequencerStep(sequencer, step, on) {
  const mask = (1 << (SEQUENCER_STEPS - 1 - step)) >>> 0;
  const value = toSequencer(sequencer);
  return (on ? value | mask : value & ~mask) >>> 0;
}

/** Rotates the pattern by `steps` (positive moves it later in the loop). */
export function shiftSequencer(sequencer, steps) {
  const value = toSequencer(sequencer);
  const amount = ((Math.trunc(steps) % SEQUENCER_STEPS) + SEQUENCER_STEPS) % SEQUENCER_STEPS;
  if (!amount) return value;
  return ((value >>> amount) | (value << (SEQUENCER_STEPS - amount))) >>> 0;
}

export function invertSequencer(sequencer) {
  return (~toSequencer(sequencer)) >>> 0;
}

export function countSequencerSteps(sequencer) {
  let count = 0;
  for (let value = toSequencer(sequencer); value; value >>>= 1) count += value & 1;
  return count;
}

const pattern = (text) => sequencerFromPattern(text.repeat(SEQUENCER_STEPS / text.length));

// Phase pairs: `a` and `b` never overlap, so alternating them across heads
// gives the usual left/right or red/blue wig-wag.
export const SEQUENCER_PRESETS = Object.freeze([
  { id: "steady", label: "Steady", a: FULL, b: FULL },
  { id: "strobe", label: "Fast strobe", a: pattern("10"), b: pattern("01") },
  { id: "pulse", label: "Slow pulse", a: pattern("11110000"), b: pattern("00001111") },
  { id: "half", label: "Wig-wag", a: pattern("1".repeat(16) + "0".repeat(16)), b: pattern("0".repeat(16) + "1".repeat(16)) },
  { id: "quarter", label: "Alternate", a: pattern("1".repeat(8) + "0".repeat(8)), b: pattern("0".repeat(8) + "1".repeat(8)) },
  { id: "double", label: "Double flash", a: pattern("1100110000000000"), b: pattern("0000000011001100") },
  { id: "triple", label: "Triple flash", a: pattern("1010100000000000"), b: pattern("0000000010101000") },
  { id: "quad", label: "Quad flash", a: pattern("1010101000000000"), b: pattern("0000000010101010") },
  { id: "quad-burst", label: "Quad burst", a: sequencerFromPattern("10101010000000000000000000000000"), b: sequencerFromPattern("00000000000000001010101000000000") },
  { id: "scan", label: "Scan", a: sequencerFromPattern("11000000000000001100000000000000"), b: sequencerFromPattern("00110000000000000011000000000000") },
  { id: "off", label: "Off", a: 0, b: 0 },
]);

// Traffic advisor patterns across a row of heads, first head to last. A loop
// of 32 steps holds 32 / `period` sweeps.
export const TRAFFIC_ADVISOR_MODES = Object.freeze([
  { id: "build-forward", label: "Arrow, first to last" },
  { id: "build-back", label: "Arrow, last to first" },
  { id: "build-centre", label: "Arrow, centre out" },
  { id: "chase-forward", label: "Chase, first to last" },
  { id: "chase-back", label: "Chase, last to first" },
  { id: "warn", label: "Warning, halves alternate" },
]);

const TRAFFIC_PERIODS = new Set([4, 8, 16, 32]);

/** One sequencer per head for a traffic advisor `mode`, or [] for an unknown mode. */
export function trafficAdvisorSequencers(count, mode, { period = 16 } = {}) {
  const heads = Math.max(0, Math.min(MAX_SIRENS, Math.trunc(Number(count)) || 0));
  if (!heads || !TRAFFIC_ADVISOR_MODES.some((entry) => entry.id === mode)) return [];
  const span = TRAFFIC_PERIODS.has(period) ? period : 16;
  const centre = mode === "build-centre";
  const ranks = centre ? Math.ceil(heads / 2) : heads;
  const rankOf = (index) => (centre ? Math.floor(Math.abs(index - (heads - 1) / 2))
    : mode.endsWith("back") ? heads - 1 - index : index);
  // Arrows build over three quarters of the sweep, hold full for an eighth, then go dark.
  const build = (span * 3) / 4;
  const hold = build + span / 8;
  const lit = (index, step) => {
    if (mode === "warn") return index < heads / 2 ? step < span / 2 : step >= span / 2;
    const rank = rankOf(index);
    if (mode.startsWith("build")) return step >= Math.floor((rank * build) / ranks) && step < hold;
    return ranks <= span ? Math.floor((step * ranks) / span) === rank : Math.floor((rank * span) / ranks) === step;
  };
  return Array.from({ length: heads }, (_, index) => {
    const sweep = Array.from({ length: span }, (_, step) => (lit(index, step) ? "1" : "0")).join("");
    return sequencerFromPattern(sweep.repeat(SEQUENCER_STEPS / span));
  });
}

// ---------------------------------------------------------------------------
// Colours and facings
// ---------------------------------------------------------------------------

// One-click lens colours.
export const SIREN_PALETTE = Object.freeze([
  { id: "red", label: "Red", color: "#ff0000" },
  { id: "blue", label: "Blue", color: "#0000ff" },
  { id: "amber", label: "Amber", color: "#ff8800" },
  { id: "white", label: "White", color: "#ffffff" },
  { id: "green", label: "Green", color: "#00ff00" },
  { id: "purple", label: "Purple", color: "#8800ff" },
]);

// Eight facings for a siren's aim (flashiness delta), a yaw about the
// vehicle's up axis: 0 front, +90 left, 180 rear. `cell` places each on a 3x3
// grid around the vehicle, row by row from the front.
export const SIREN_FACINGS = Object.freeze([
  { id: "front-left", label: "Front left", degrees: 45, cell: 0 },
  { id: "front", label: "Front", degrees: 0, cell: 1 },
  { id: "front-right", label: "Front right", degrees: -45, cell: 2 },
  { id: "left", label: "Left", degrees: 90, cell: 3 },
  { id: "right", label: "Right", degrees: -90, cell: 5 },
  { id: "rear-left", label: "Rear left", degrees: 135, cell: 6 },
  { id: "rear", label: "Rear", degrees: 180, cell: 7 },
  { id: "rear-right", label: "Rear right", degrees: -135, cell: 8 },
]);

/** The facing a delta (radians) points along, within half a degree, or null. */
export function facingFromDelta(radians) {
  if (!Number.isFinite(radians)) return null;
  const degrees = (((radians * 180) / Math.PI) % 360 + 540) % 360 - 180;
  return SIREN_FACINGS.find((facing) => {
    const gap = Math.abs((((degrees - facing.degrees) % 360) + 540) % 360 - 180);
    return gap < 0.5;
  }) || null;
}

// ---------------------------------------------------------------------------
// Defaults and presets
// ---------------------------------------------------------------------------

// Vanilla police values for a new setting.
export const SETTING_DEFAULTS = Object.freeze({
  timeMultiplier: 1,
  lightFalloffMax: 50,
  lightFalloffExponent: 10,
  lightInnerConeAngle: 2,
  lightOuterConeAngle: 70,
  lightOffset: 0,
  textureName: "VehicleLight_sirenlight",
  sequencerBpm: 600,
  useRealLights: true,
});

export function createChannel(overrides = {}) {
  return { delta: 0, start: 0, speed: 0, sequencer: 0, multiples: 1, direction: true, syncToBpm: true, ...overrides };
}

export function createSirenLight(overrides = {}) {
  const { rotation, flashiness, corona, ...rest } = overrides;
  return {
    rotation: createChannel({ speed: 3, sequencer: FULL, ...rotation }),
    flashiness: createChannel({ sequencer: pattern("10"), direction: false, ...flashiness }),
    corona: { intensity: 20, size: 0.2, pull: 0.1, faceCamera: false, ...corona },
    color: "#ff0000",
    alpha: 1,
    intensity: 2,
    lightGroup: 0,
    rotate: false,
    scale: true,
    scaleFactor: 2,
    flash: true,
    light: true,
    spotLight: true,
    castShadows: false,
    extraXml: [],
    ...rest,
  };
}

/**
 * A new siren setting. `headings` maps a 1-based siren index to the yaw its
 * bone faces; the game turns a siren's meshes from there to its delta, so each
 * siren starts aimed the way its bone points.
 */
export function createSirenSetting({ id = null, name = "", count = 0, colors = ["#ff0000", "#0000ff"], headings = {} } = {}) {
  const half = SEQUENCER_PRESETS.find((entry) => entry.id === "half");
  const delta = (index) => (Number.isFinite(headings?.[index + 1]) ? headings[index + 1] : 0);
  const sirens = Array.from({ length: Math.max(0, Math.min(MAX_SIRENS, count)) }, (_, index) => createSirenLight({
    color: colors[index % colors.length],
    rotation: { delta: delta(index) },
    flashiness: { delta: delta(index), sequencer: index % 2 === 0 ? half.a : half.b },
  }));
  return {
    id,
    name,
    ...SETTING_DEFAULTS,
    lamps: Object.fromEntries(LAMP_KEYS.map((key) => [key, { sequencer: 0, multiples: 1 }])),
    sirens,
    sirenCount: sirens.length,
    extraXml: [],
    sourcePath: "",
  };
}

const red = "#ff0000";
const blue = "#0000ff";
const white = "#ffffff";
const amber = "#ff8800";
const phase = (id, which) => SEQUENCER_PRESETS.find((entry) => entry.id === id)[which];

export const SIREN_LIGHT_PRESETS = Object.freeze([
  {
    id: "red-blue",
    label: "Red and blue pair",
    lights: [
      { color: red, flashiness: { sequencer: phase("half", "a") } },
      { color: blue, flashiness: { sequencer: phase("half", "b") } },
    ],
  },
  {
    id: "red-white",
    label: "Red and white pair",
    lights: [
      { color: red, flashiness: { sequencer: phase("pulse", "a") } },
      { color: white, flashiness: { sequencer: phase("pulse", "b") } },
    ],
  },
  { id: "amber", label: "Amber strobe", lights: [{ color: amber, flashiness: { sequencer: phase("strobe", "a") } }] },
  {
    id: "rotator",
    label: "Halogen rotator",
    lights: [{
      color: red,
      flash: false,
      rotate: true,
      scale: false,
      rotation: { speed: 3, sequencer: FULL, syncToBpm: false },
      corona: { intensity: 50, size: 0.4 },
    }],
  },
  {
    id: "corners",
    label: "Corner strobes",
    lights: [0, 1, 2, 3].map((index) => ({
      color: white,
      intensity: 1,
      flashiness: { sequencer: phase("double", index % 2 ? "b" : "a") },
    })),
  },
  {
    id: "lightbar",
    label: "Full lightbar",
    lights: Array.from({ length: 16 }, (_, index) => ({
      color: index % 2 ? blue : red,
      flashiness: { sequencer: phase("half", index % 2 ? "b" : "a") },
    })),
  },
]);

export function presetLights(presetId) {
  const preset = SIREN_LIGHT_PRESETS.find((entry) => entry.id === presetId);
  return preset ? preset.lights.map((light) => createSirenLight(light)) : [];
}

/**
 * The sirens at `indices` take a preset's look, lowest index first, cycling
 * through the preset's lights. Each siren is a bone on the model, so it keeps
 * its aim (the delta that points it the way its bone faces) and the XML the
 * editor doesn't model.
 */
export function applySirenPreset(setting, indices, presetId) {
  const looks = presetLights(presetId);
  if (!looks.length || !indices.length) return setting;
  const rank = new Map([...new Set(indices)].sort((a, b) => a - b).map((index, order) => [index, order]));
  return updateSirens(setting, indices, (light, index) => {
    const look = looks[rank.get(index) % looks.length];
    return {
      ...look,
      rotation: { ...look.rotation, delta: light.rotation?.delta ?? 0 },
      flashiness: { ...look.flashiness, delta: light.flashiness?.delta ?? 0 },
      extraXml: [...(light.extraXml || [])],
    };
  });
}

// ---------------------------------------------------------------------------
// Draft editing
// ---------------------------------------------------------------------------

export function cloneSirenLight(light) {
  return {
    ...light,
    rotation: { ...light.rotation },
    flashiness: { ...light.flashiness },
    corona: { ...light.corona },
    extraXml: [...(light.extraXml || [])],
  };
}

export function cloneSirenSetting(setting) {
  if (!setting) return null;
  return {
    ...setting,
    lamps: Object.fromEntries(Object.entries(setting.lamps || {}).map(([key, lamp]) => [key, { ...lamp }])),
    sirens: (setting.sirens || []).map(cloneSirenLight),
    extraXml: [...(setting.extraXml || [])],
  };
}

/** Returns a new setting with `update(light, index)` applied to each listed siren. */
export function updateSirens(setting, indices, update) {
  const targets = new Set(indices);
  const sirens = setting.sirens.map((light, index) => {
    if (!targets.has(index)) return light;
    const next = cloneSirenLight(light);
    return update(next, index) || next;
  });
  return { ...setting, sirens, sirenCount: sirens.length };
}

export function withSirens(setting, sirens) {
  return { ...setting, sirens: sirens.slice(0, MAX_SIRENS), sirenCount: Math.min(sirens.length, MAX_SIRENS) };
}

/** First id from `start` up that no setting in `usedIds` takes. */
export function nextFreeSirenId(usedIds, start = 1) {
  const used = new Set((usedIds || []).filter(Number.isInteger));
  let id = Math.max(0, Math.trunc(start) || 0);
  while (used.has(id)) id += 1;
  return id;
}

function sameFile(a, b) {
  const normalize = (path) => String(path || "").replace(/\\/g, "/").toLowerCase();
  return Boolean(a) && normalize(a) === normalize(b);
}

/**
 * Where a setting imported from a carcols.meta lands. `draft`: the open draft
 * or null. `resourceSettings`: [{ id, sourcePath }] in this resource's
 * carcols. `linkedId`: the carvariations sirenSettings (null when unlinked).
 * - "pattern": the draft is the vehicle's saved setting, so only the lights
 *   come in and its id, name and file stay.
 * - "adopt": the pick is this resource's own setting and nothing links the
 *   vehicle elsewhere, so the draft becomes that setting (its id, name and
 *   file) and Install updates it instead of adding a copy under a new id.
 * - "new": a new setting, on the linked id when that one is free.
 */
export function sirenImportTarget({ imported, path, draft, resourceSettings = [], linkedId = null }) {
  if (draft?.sourcePath) return { mode: "pattern", id: draft.id };
  const own = resourceSettings.some((entry) => entry.id === imported.id && sameFile(entry.sourcePath, path));
  if (own && (linkedId == null || linkedId === imported.id)) return { mode: "adopt", id: imported.id, sourcePath: path };
  if (draft) return { mode: "pattern", id: draft.id };
  const used = resourceSettings.map((entry) => entry.id);
  const id = linkedId != null && !used.includes(linkedId) ? linkedId
    : used.includes(imported.id) ? nextFreeSirenId(used, imported.id) : imported.id;
  return { mode: "new", id };
}

// ARGB colour helpers. carcols stores 0xAARRGGBB.
export function argbFromColor(color, alpha = 1) {
  const rgb = /^#?([0-9a-f]{6})$/i.exec(String(color || ""))?.[1] || "ffffff";
  const a = Math.round(Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 1)) * 255);
  return `0x${`${a.toString(16).padStart(2, "0")}${rgb}`.toUpperCase()}`;
}

export function colorFromArgb(text) {
  const match = /^(?:0x|#)?([0-9a-f]{8}|[0-9a-f]{6})$/i.exec(String(text || "").trim());
  if (!match) return null;
  const digits = match[1].toLowerCase();
  return {
    color: `#${digits.slice(-6)}`,
    alpha: digits.length === 8 ? parseInt(digits.slice(0, 2), 16) / 255 : 1,
  };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function issue(code, severity, message) {
  return { code, severity, message };
}

function listIndices(indices) {
  return indices.length === 1 ? `Siren ${indices[0]}` : `Sirens ${indices.join(", ")}`;
}

/**
 * Problems with a draft before it is saved. `context`: { sirenBones: number[]
 * (1-based sirenN bones on the model), otherSettings: [{ id, name, sourcePath }]
 * (every other setting in the resource), variationId (carvariations
 * sirenSettings, null when unlinked, undefined when unknown) }.
 */
export function checkSirenSetting(setting, context = {}) {
  const issues = [];
  if (!setting) return issues;
  const sirens = Array.isArray(setting.sirens) ? setting.sirens : [];
  if (!Number.isInteger(setting.id) || setting.id < 0) {
    issues.push(issue("ID_MISSING", "error", "The siren setting needs a whole-number id."));
  } else {
    const clash = (context.otherSettings || []).find((entry) => entry.id === setting.id);
    if (clash) {
      issues.push(issue("ID_CONFLICT", "error", `Id ${setting.id} is already used by "${clash.name || "another setting"}". Only one definition wins in game.`));
    }
    if (setting.id > 255) {
      // Singleplayer keeps the id in a byte; SSLA lifts that.
      issues.push(issue("ID_ABOVE_255", "info", `Id ${setting.id} is above 255. Singleplayer (LSPDFR) reads it only with SirenSetting Limit Adjuster installed.`));
    }
    if (context.variationId === null) {
      issues.push(issue("NOT_LINKED", "warn", `carvariations.meta does not link a siren setting to this model, so in game the vehicle won't use this one. Add <sirenSettings value="${setting.id}" /> to its entry.`));
    } else if (context.variationId !== undefined && context.variationId !== setting.id) {
      issues.push(issue("LINK_MISMATCH", "warn", `carvariations.meta still links id ${context.variationId}. Change its sirenSettings to ${setting.id}.`));
    }
  }
  if (!(setting.sequencerBpm > 0)) {
    issues.push(issue("NO_TEMPO", "warn", "Sequencer bpm is 0, so flash patterns never advance."));
  }
  const dark = sirens.flatMap((light, index) =>
    (light.flash && toSequencer(light.flashiness?.sequencer) === 0) || (light.rotate && toSequencer(light.rotation?.sequencer) === 0)
      ? [index + 1] : []);
  if (dark.length) issues.push(issue("EMPTY_PATTERN", "info", `${listIndices(dark)} never ${dark.length === 1 ? "lights" : "light"}: the pattern has no lit steps.`));
  const badMultiples = sirens.flatMap((light, index) =>
    (light.flash && !(light.flashiness?.multiples >= 1)) || (light.rotate && !(light.rotation?.multiples >= 1)) ? [index + 1] : []);
  if (badMultiples.length) issues.push(issue("MULTIPLES", "warn", `${listIndices(badMultiples)} ${badMultiples.length === 1 ? "has" : "have"} multiples below 1.`));
  const bones = Array.isArray(context.sirenBones) ? context.sirenBones : null;
  if (bones && bones.length) {
    const boneSet = new Set(bones);
    const unbound = sirens.flatMap((_, index) => boneSet.has(index + 1) ? [] : [index + 1]);
    const unused = bones.filter((index) => index > sirens.length).sort((a, b) => a - b);
    if (unbound.length) issues.push(issue("NO_BONE", "info", `${listIndices(unbound)} ${unbound.length === 1 ? "has" : "have"} no siren bone on this model and light nothing.`));
    if (unused.length) issues.push(issue("BONE_UNUSED", "warn", `The model has siren ${unused.join(", ")} but this setting stops at ${sirens.length}. Those lights never flash.`));
  }
  const rank = { error: 0, warn: 1, info: 2 };
  return issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// ---------------------------------------------------------------------------
// Unsaved changes
// ---------------------------------------------------------------------------

const SETTING_FIELD_LABELS = Object.freeze({
  id: "Id",
  name: "Name",
  textureName: "Texture",
  useRealLights: "Use real lights",
  sequencerBpm: "Sequencer bpm",
  timeMultiplier: "Time multiplier",
  lightFalloffMax: "Falloff max",
  lightFalloffExponent: "Falloff exponent",
  lightInnerConeAngle: "Inner cone",
  lightOuterConeAngle: "Outer cone",
  lightOffset: "Light offset",
});

// The inspector's names for a siren's fields.
const SIREN_FIELD_LABELS = Object.freeze({
  color: "colour",
  alpha: "colour",
  intensity: "intensity",
  lightGroup: "light group",
  rotate: "rotate",
  flash: "flash",
  scale: "scale",
  scaleFactor: "scale factor",
  light: "casts light",
  spotLight: "spot light",
  castShadows: "cast shadows",
  "flashiness.sequencer": "flash pattern",
  "rotation.sequencer": "rotation pattern",
  "flashiness.delta": "aim",
  "rotation.delta": "rotation offset",
  "corona.intensity": "corona intensity",
  "corona.size": "corona size",
  "corona.pull": "corona pull",
  "corona.faceCamera": "corona face camera",
});

function sirenFieldLabel(path) {
  if (SIREN_FIELD_LABELS[path]) return SIREN_FIELD_LABELS[path];
  const [channel, key] = path.split(".");
  if (key && (channel === "flashiness" || channel === "rotation")) return `${channel === "flashiness" ? "flash" : "rotation"} ${humanizeKey(key)}`;
  return humanizeKey(path);
}

// Patterns are too long to print; delta and start are radians the editor shows
// in degrees, so only their names are listed.
const quietValue = (path) => /(?:sequencer|delta|start)$/.test(path);

/**
 * What a siren setting draft changes against `base`, the setting in its file,
 * as short lines for the dock. A new setting (no base) says where it will go.
 */
export function describeSirenChanges(base, draft) {
  if (!draft) return [];
  const sirens = Array.isArray(draft.sirens) ? draft.sirens : [];
  if (!base) {
    return [
      `New setting: no carcols.meta has it yet. Install or Save to carcols.meta adds it as id ${draft.id ?? "(none)"}.`,
      `${sirens.length} ${sirens.length === 1 ? "siren" : "sirens"} at ${formatChangeValue(draft.sequencerBpm)} bpm`,
    ];
  }
  const lines = [];
  for (const [key, label] of Object.entries(SETTING_FIELD_LABELS)) {
    if (JSON.stringify(base[key]) !== JSON.stringify(draft[key])) {
      lines.push(`${label} ${formatChangeValue(base[key])} → ${formatChangeValue(draft[key])}`);
    }
  }
  for (const key of LAMP_KEYS) {
    const text = describeFields(leafChanges(base.lamps?.[key] || {}, draft.lamps?.[key] || {}), (path) => (path === "sequencer" ? "pattern" : humanizeKey(path)), quietValue);
    if (text) lines.push(`${LAMP_LABELS[key]}: ${text}`);
  }
  const before = Array.isArray(base.sirens) ? base.sirens : [];
  if (before.length !== sirens.length) lines.push(`Siren count ${before.length} → ${sirens.length}`);
  const shared = Math.min(before.length, sirens.length);
  lines.push(...groupByChange(
    Array.from({ length: shared }, (_, index) => ({
      index: index + 1,
      text: describeFields(leafChanges(before[index], sirens[index], { skip: ["extraXml"] }), sirenFieldLabel, quietValue),
    })),
    "Siren",
    "Sirens",
  ));
  return lines;
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

function escapeXml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// carcols writes floats with fixed decimals and counts, ids and patterns as
// integers. Files differ in how many decimals and whether "/>" has a space;
// a save follows the file it writes into so only changed values differ.
const DEFAULT_STYLE = Object.freeze({ decimals: 6, close: " />" });

/** The number and self-closing style an XML text uses. */
export function detectXmlStyle(text) {
  const source = String(text || "");
  const counts = new Map();
  let seen = 0;
  for (const match of source.matchAll(/value="-?\d+\.(\d+)"/g)) {
    counts.set(match[1].length, (counts.get(match[1].length) || 0) + 1);
    if ((seen += 1) >= 200) break;
  }
  const decimals = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? DEFAULT_STYLE.decimals;
  const tight = (source.match(/[^\s]\/>/g) || []).length;
  const spaced = (source.match(/\s\/>/g) || []).length;
  return { decimals: Math.min(12, decimals), close: tight > spaced ? "/>" : " />" };
}

function formatInt(value) {
  return String(Math.trunc(Number(value)));
}

function sirenLines(setting, style = DEFAULT_STYLE) {
  const lines = [];
  const close = style.close;
  const formatFloat = (value) => Number(value).toFixed(style.decimals);
  const add = (depth, text) => lines.push([depth, text]);
  const value = (depth, tag, raw, format) => {
    if (raw == null || raw === "" || (typeof raw === "number" && !Number.isFinite(raw))) return;
    add(depth, `<${tag} value="${format(raw)}"${close}`);
  };
  const bool = (depth, tag, raw) => add(depth, `<${tag} value="${raw ? "true" : "false"}"${close}`);
  const extras = (depth, list) => {
    for (const raw of list || []) {
      const [first, ...rest] = String(raw).split(/\r?\n/);
      add(depth, first);
      // Later lines of a multi-line element keep their own indentation.
      for (const line of rest) lines.push([null, line]);
    }
  };
  const channel = (depth, tag, data = {}) => {
    add(depth, `<${tag}>`);
    value(depth + 1, "delta", data.delta ?? 0, formatFloat);
    value(depth + 1, "start", data.start ?? 0, formatFloat);
    value(depth + 1, "speed", data.speed ?? 0, formatFloat);
    value(depth + 1, "sequencer", toSequencer(data.sequencer), formatInt);
    value(depth + 1, "multiples", data.multiples ?? 1, formatInt);
    bool(depth + 1, "direction", data.direction !== false);
    bool(depth + 1, "syncToBpm", data.syncToBpm !== false);
    add(depth, `</${tag}>`);
  };

  add(0, "<Item>");
  value(1, "id", setting.id, formatInt);
  add(1, setting.name ? `<name>${escapeXml(setting.name)}</name>` : `<name${close}`);
  value(1, "timeMultiplier", setting.timeMultiplier, formatFloat);
  value(1, "lightFalloffMax", setting.lightFalloffMax, formatFloat);
  value(1, "lightFalloffExponent", setting.lightFalloffExponent, formatFloat);
  value(1, "lightInnerConeAngle", setting.lightInnerConeAngle, formatFloat);
  value(1, "lightOuterConeAngle", setting.lightOuterConeAngle, formatFloat);
  value(1, "lightOffset", setting.lightOffset, formatFloat);
  add(1, setting.textureName ? `<textureName>${escapeXml(setting.textureName)}</textureName>` : `<textureName${close}`);
  value(1, "sequencerBpm", setting.sequencerBpm, formatInt);
  const lamps = setting.lamps || {};
  for (const key of LAMP_KEYS) {
    if (!lamps[key]) continue;
    add(1, `<${key}>`);
    value(2, "sequencer", toSequencer(lamps[key].sequencer), formatInt);
    add(1, `</${key}>`);
  }
  for (const key of LAMP_KEYS) {
    if (lamps[key]) value(1, `${key}Multiples`, lamps[key].multiples, formatInt);
  }
  bool(1, "useRealLights", setting.useRealLights !== false);
  const sirens = (setting.sirens || []).slice(0, MAX_SIRENS);
  if (!sirens.length) add(1, `<sirens${close}`);
  else {
    add(1, "<sirens>");
    for (const light of sirens) {
      add(2, "<Item>");
      channel(3, "rotation", light.rotation);
      channel(3, "flashiness", light.flashiness);
      const corona = light.corona || {};
      add(3, "<corona>");
      value(4, "intensity", corona.intensity ?? 0, formatFloat);
      value(4, "size", corona.size ?? 0, formatFloat);
      value(4, "pull", corona.pull ?? 0, formatFloat);
      bool(4, "faceCamera", Boolean(corona.faceCamera));
      add(3, "</corona>");
      add(3, `<color value="${argbFromColor(light.color, light.alpha)}"${close}`);
      value(3, "intensity", light.intensity, formatFloat);
      value(3, "lightGroup", light.lightGroup, formatInt);
      bool(3, "rotate", light.rotate);
      bool(3, "scale", light.scale);
      value(3, "scaleFactor", light.scaleFactor, (raw) => (Number.isInteger(raw) ? formatInt(raw) : formatFloat(raw)));
      bool(3, "flash", light.flash);
      bool(3, "light", light.light);
      bool(3, "spotLight", light.spotLight);
      bool(3, "castShadows", light.castShadows);
      extras(3, light.extraXml);
      add(2, "</Item>");
    }
    add(1, "</sirens>");
  }
  extras(1, setting.extraXml);
  add(0, "</Item>");
  return lines;
}

/**
 * One siren setting as a carcols `<Sirens>` Item. `base` prefixes every line
 * but the first (the caller places the first line), `indent` is one level.
 */
export function serializeSirenSetting(setting, { indent = "  ", base = "", eol = "\n", style = DEFAULT_STYLE } = {}) {
  return sirenLines(setting, style)
    .map(([depth, text], index) => (depth == null ? text : `${index === 0 ? "" : base}${indent.repeat(depth)}${text}`))
    .join(eol);
}

/** A carcols.meta holding only this siren setting. */
export function createCarcolsFile(setting, { indent = "  ", eol = "\n" } = {}) {
  const item = serializeSirenSetting(setting, { indent, base: indent.repeat(2), eol });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<CVehicleModelInfoVarGlobal>",
    `${indent}<Sirens>`,
    `${indent.repeat(2)}${item}`,
    `${indent}</Sirens>`,
    "</CVehicleModelInfoVarGlobal>",
    "",
  ].join(eol);
}

function lineIndent(text, offset) {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const lead = text.slice(lineStart, offset);
  return /^[ \t]*$/.test(lead) ? lead : null;
}

function detectIndentUnit(text, root) {
  const first = root.children[0];
  const unit = first ? lineIndent(text, first.start) : null;
  return unit || "  ";
}

// ---------------------------------------------------------------------------
// In-place patching
// ---------------------------------------------------------------------------

// Siren light Items, as serialized lines relative to the Item.
function lightItemLines(lights, style) {
  const lines = sirenLines({ id: null, sirens: lights, lamps: {}, extraXml: [] }, style);
  const open = lines.findIndex(([depth, text]) => depth === 1 && text === "<sirens>");
  const close = lines.findIndex(([depth, text]) => depth === 1 && text === "</sirens>");
  return open < 0 || close < 0 ? [] : lines.slice(open + 1, close).map(([depth, text]) => [depth == null ? null : depth - 2, text]);
}

const VALUE_ATTR = /\bvalue\s*=\s*(["'])(.*?)\1/;

function nearlyEqual(a, b) {
  return Math.abs(a - b) <= 1e-7 * Math.max(1, Math.abs(a), Math.abs(b));
}

// Writes a number the way the token it replaces was written: same decimals,
// more only when the value needs them, integers stay integers.
function formatLike(token, value, integer) {
  if (integer || (Number.isInteger(value) && !/\./.test(token))) return String(Math.trunc(value));
  const had = /\.(\d+)/.exec(token)?.[1].length ?? 0;
  const needed = (String(Number(value.toFixed(6))).split(".")[1] || "").length;
  return value.toFixed(Math.max(had, needed, 1));
}

/**
 * Edits that turn the `item` (a `<Sirens>` Item in `text`, parsed with
 * positions) into `setting`, touching only values that differ. Returns the new
 * text, or null when the Item's layout needs a full rewrite instead.
 */
function patchSirenItem(text, item, setting, { unit, eol }) {
  const style = detectXmlStyle(text.slice(item.start, item.end));
  const edits = [];
  let failed = false;

  const replaceValue = (node, next) => {
    const raw = text.slice(node.start, node.end);
    const attr = VALUE_ATTR.exec(raw);
    if (attr) {
      const at = node.start + attr.index + attr[0].indexOf(attr[1]) + 1;
      edits.push({ start: at, end: at + attr[2].length, text: next });
      return;
    }
    const open = raw.indexOf(">");
    const close = raw.lastIndexOf("</");
    if (open < 0 || close <= open || raw[open - 1] === "/") { failed = true; return; }
    edits.push({ start: node.start + open + 1, end: node.start + close, text: next });
  };
  const insertChild = (parent, markup) => {
    const raw = text.slice(parent.start, parent.end);
    if (/\/>$/.test(raw)) { failed = true; return; }
    const close = text.lastIndexOf("</", parent.end - 1);
    const closeIndent = lineIndent(text, close);
    if (closeIndent == null) { failed = true; return; }
    const childIndent = (parent.children[0] && lineIndent(text, parent.children[0].start)) ?? closeIndent + unit;
    const at = close - closeIndent.length;
    const body = markup.map(([depth, line]) => `${childIndent}${unit.repeat(depth)}${line}`).join(eol);
    edits.push({ start: at, end: at, text: `${body}${eol}` });
  };
  const tokenOf = (node) => {
    const attr = VALUE_ATTR.exec(text.slice(node.start, node.end));
    return attr ? attr[2] : node.text;
  };

  // A value field: number, sequencer, bool or text. `fallback` is what the
  // reader assumes when the node is absent.
  const field = (parent, tag, kind, next, fallback = null) => {
    if (failed || next == null || (typeof next === "number" && !Number.isFinite(next))) return;
    const node = findChild(parent, tag);
    if (!node) {
      if (next === fallback) return;
      const formatted = kind === "bool" ? String(Boolean(next))
        : kind === "text" ? escapeXml(next)
          : kind === "color" ? next
            : kind === "int" || kind === "seq" ? String(Math.trunc(next)) : Number(next).toFixed(style.decimals);
      insertChild(parent, [[0, kind === "text" ? `<${tag}>${formatted}</${tag}>` : `<${tag} value="${formatted}"${style.close}`]]);
      return;
    }
    const token = tokenOf(node);
    if (kind === "bool") {
      const current = /^(true|1)$/i.test(String(token).trim()) ? true : /^(false|0)$/i.test(String(token).trim()) ? false : fallback;
      if (current !== Boolean(next)) replaceValue(node, String(Boolean(next)));
    } else if (kind === "text") {
      if (String(token).trim() !== next) replaceValue(node, escapeXml(next));
    } else if (kind === "color") {
      const current = colorFromArgb(token);
      const wanted = colorFromArgb(next);
      const same = current && wanted && current.color === wanted.color && Math.round(current.alpha * 255) === Math.round(wanted.alpha * 255);
      // Keep the file's hex case.
      const lowercase = /[a-f]/.test(String(token).replace(/^0x/i, "")) && !/[A-F]/.test(String(token).replace(/^0x/i, ""));
      if (!same) replaceValue(node, lowercase ? next.toLowerCase() : next);
    } else {
      const current = numberValue(node, Number.NaN);
      const equal = kind === "seq" ? toSequencer(current) === toSequencer(next) : Number.isFinite(current) && nearlyEqual(current, next);
      if (!equal) replaceValue(node, kind === "seq" ? String(toSequencer(next)) : formatLike(String(token), Number(next), kind === "int"));
    }
  };

  field(item, "id", "int", setting.id);
  field(item, "name", "text", setting.name ?? "", "");
  for (const tag of ["timeMultiplier", "lightFalloffMax", "lightFalloffExponent", "lightInnerConeAngle", "lightOuterConeAngle", "lightOffset"]) {
    field(item, tag, "number", setting[tag]);
  }
  field(item, "textureName", "text", setting.textureName ?? "", "");
  field(item, "sequencerBpm", "number", setting.sequencerBpm);
  for (const key of LAMP_KEYS) {
    const lamp = setting.lamps?.[key];
    if (!lamp) continue;
    const node = findChild(item, key);
    if (node) field(node, "sequencer", "seq", toSequencer(lamp.sequencer));
    else if (toSequencer(lamp.sequencer)) insertChild(item, [[0, `<${key}>`], [1, `<sequencer value="${toSequencer(lamp.sequencer)}"${style.close}`], [0, `</${key}>`]]);
    if (lamp.multiples != null) field(item, `${key}Multiples`, "int", lamp.multiples, 1);
  }
  field(item, "useRealLights", "bool", setting.useRealLights !== false, true);

  const lights = (setting.sirens || []).slice(0, MAX_SIRENS);
  const list = findChild(item, "sirens");
  if (!list) {
    if (lights.length) return null;
  } else {
    const listRaw = text.slice(list.start, list.end);
    const originals = findChildren(list, "Item");
    if (/\/>$/.test(listRaw) && lights.length) return null;
    const shared = Math.min(originals.length, lights.length);
    for (let index = 0; index < shared && !failed; index += 1) {
      const node = originals[index];
      const light = lights[index];
      for (const [tag, channelData] of [["rotation", light.rotation], ["flashiness", light.flashiness]]) {
        const channel = findChild(node, tag);
        if (!channel) { failed = true; break; }
        for (const name of ["delta", "start", "speed"]) field(channel, name, "number", channelData?.[name] ?? 0);
        field(channel, "sequencer", "seq", toSequencer(channelData?.sequencer));
        field(channel, "multiples", "int", channelData?.multiples ?? 1);
        field(channel, "direction", "bool", channelData?.direction !== false, true);
        field(channel, "syncToBpm", "bool", channelData?.syncToBpm !== false, true);
      }
      const corona = findChild(node, "corona");
      if (!corona) { failed = true; break; }
      for (const name of ["intensity", "size", "pull"]) field(corona, name, "number", light.corona?.[name] ?? 0);
      field(corona, "faceCamera", "bool", Boolean(light.corona?.faceCamera), false);
      field(node, "color", "color", argbFromColor(light.color, light.alpha));
      field(node, "intensity", "number", light.intensity);
      field(node, "lightGroup", "int", light.lightGroup);
      for (const name of ["rotate", "scale", "flash", "light", "spotLight", "castShadows"]) field(node, name, "bool", Boolean(light[name]), false);
      field(node, "scaleFactor", "number", light.scaleFactor);
    }
    if (lights.length > originals.length) {
      // New sirens go after the last one, above </sirens>.
      const close = text.lastIndexOf("</", list.end - 1);
      const closeIndent = lineIndent(text, close);
      if (closeIndent == null) return null;
      const itemIndent = (originals[0] && lineIndent(text, originals[0].start)) ?? closeIndent + unit;
      const at = close - closeIndent.length;
      const body = lightItemLines(lights.slice(originals.length), style)
        .map(([depth, line]) => (depth == null ? line : `${itemIndent}${unit.repeat(depth)}${line}`)).join(eol);
      edits.push({ start: at, end: at, text: `${body}${eol}` });
    } else if (lights.length < originals.length) {
      // Removed sirens: from the end of the last kept one (or the list's open
      // tag) to the end of the last original, with the comments between them.
      const from = lights.length ? originals[lights.length - 1].end : text.indexOf(">", list.start) + 1;
      edits.push({ start: from, end: originals[originals.length - 1].end, text: "" });
    }
  }
  if (failed) return null;

  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  let floor = Infinity;
  for (const edit of edits) {
    if (edit.end > floor) return null; // overlapping edits: rewrite instead
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    floor = edit.start;
  }
  return out;
}

/**
 * Writes `setting` into an existing carcols.meta. The `<Sirens>` Item whose id
 * is `matchId` is replaced; without one the setting is appended to `<Sirens>`
 * (creating the list when the file has none). Everything else in the file,
 * including comments and formatting, is kept byte for byte.
 * Returns { text, mode: "replaced" | "appended" }.
 */
export function spliceSirenSetting(sourceText, setting, { matchId = null } = {}) {
  if (typeof sourceText !== "string") throw new TypeError("carcols.meta text is required");
  const bom = sourceText.charCodeAt(0) === 0xfeff ? "﻿" : "";
  const text = bom ? sourceText.slice(1) : sourceText;
  const root = parseXml(text, { positions: true });
  if (root.name !== "CVehicleModelInfoVarGlobal") {
    throw new Error(`expected a <CVehicleModelInfoVarGlobal> carcols root, found <${root.name}>`);
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const unit = detectIndentUnit(text, root);
  const sirensNode = findChild(root, "Sirens");

  if (sirensNode && matchId != null) {
    const target = findChildren(sirensNode, "Item").find((item) => {
      const id = numberValue(findChild(item, "id"), Number.NaN);
      return Number.isFinite(id) && Math.trunc(id) === matchId;
    });
    if (target) {
      // Change only what differs, in the file's own formatting; rewrite the
      // whole Item only when its layout is beyond patching.
      const patched = patchSirenItem(text, target, setting, { unit, eol });
      if (patched != null) return { text: bom + patched, mode: "replaced" };
      const base = lineIndent(text, target.start) ?? unit.repeat(2);
      const xml = serializeSirenSetting(setting, { indent: unit, base, eol, style: detectXmlStyle(text.slice(target.start, target.end)) });
      return { text: bom + text.slice(0, target.start) + xml + text.slice(target.end), mode: "replaced" };
    }
  }

  if (sirensNode) {
    const listIndent = lineIndent(text, sirensNode.start) ?? unit;
    const itemIndent = listIndent + unit;
    const xml = serializeSirenSetting(setting, { indent: unit, base: itemIndent, eol, style: detectXmlStyle(text) });
    const raw = text.slice(sirensNode.start, sirensNode.end);
    if (/\/>$/.test(raw)) {
      const name = /^<([^\s/>]+)/.exec(raw)[1];
      const replacement = `<${name}>${eol}${itemIndent}${xml}${eol}${listIndent}</${name}>`;
      return { text: bom + text.slice(0, sirensNode.start) + replacement + text.slice(sirensNode.end), mode: "appended" };
    }
    const close = text.lastIndexOf("</", sirensNode.end - 1);
    const closeIndent = lineIndent(text, close);
    // Insert on its own line above the closing tag, keeping that line's indent.
    const at = closeIndent != null ? close - closeIndent.length : close;
    const insertion = closeIndent != null ? `${itemIndent}${xml}${eol}` : `${eol}${itemIndent}${xml}${eol}${listIndent}`;
    return { text: bom + text.slice(0, at) + insertion + text.slice(at), mode: "appended" };
  }

  const rootRaw = text.slice(root.start, root.end);
  if (/\/>$/.test(rootRaw)) throw new Error("the carcols root element is empty and self-closing");
  const close = text.lastIndexOf("</", root.end - 1);
  const closeIndent = lineIndent(text, close) ?? "";
  const xml = serializeSirenSetting(setting, { indent: unit, base: unit.repeat(2), eol, style: detectXmlStyle(text) });
  const block = `${unit}<Sirens>${eol}${unit.repeat(2)}${xml}${eol}${unit}</Sirens>${eol}`;
  const at = close - closeIndent.length;
  const prefix = text.slice(0, at).endsWith("\n") ? "" : eol;
  return { text: bom + text.slice(0, at) + prefix + block + text.slice(at), mode: "appended" };
}

/** Reads the siren setting ids defined in carcols text (for conflict checks). */
export function listSirenIds(sourceText) {
  const root = parseXml(sourceText);
  return findChildren(findChild(root, "Sirens"), "Item")
    .map((item) => ({ id: Math.trunc(numberValue(findChild(item, "id"), Number.NaN)), name: findChild(item, "name")?.text || "" }))
    .filter((entry) => Number.isFinite(entry.id));
}
