// ELS light playback for the viewer. Pure and deterministic: given a VCF
// model (els-vcf.js), the preview switches and a time, it reports which
// extras are lit, which environment lights burn and whether the vehicle's
// carcols siren lights run too. The light rig owns the Three.js side.
//
// MISS-ELS VCFs carry their own flash timings, so their playback is exact.
// ELS V8 VCFs name numbered patterns whose timings live in the lighting
// script; those come from an imported pattern pack (els-patterns.js) and say
// so. A pattern the pack lacks plays a plain alternating flash marked
// "approximate" instead of a guess dressed up as the real thing.
//
// Light stages follow how the ELS V8 ports switch groups: stage 1 runs the
// secondary lights; stage 2 adds the primary extras named by
// ExtrasActiveAtLstg2; stage 3 runs every primary extra and the warning lights
// (secondary and warning stop at stage 3 when their DisableAtLstg3 is set).

import { ELS_V8_GROUPS, ELS_V8_GROUP_KEYS, MISS_PATTERN_KEYS, elsColorHex, elsLightKey, stage2Extras } from "./els-vcf.js";
import { lookupPattern, patternNumbers } from "./els-patterns.js";

export const ELS_STAGES = Object.freeze([0, 1, 2, 3]);
// The approximate flash: half the group, then the other half, double-flashed.
const GENERIC_STEP_MS = 75;
const GENERIC_PATTERN = "1010000000";

/** Preview switches for a VCF; everything off. */
export function defaultElsPreview() {
  return {
    stage: 0,
    // ELS V8: per-group manual override ("auto" follows the stage).
    groups: { primary: "auto", secondary: "auto", warning: "auto" },
    // ELS V8: pattern chosen with the pattern keys; null uses the stage preset.
    patterns: { primary: null, secondary: null, warning: null },
    cruise: false,
    takedowns: false,
    scene: false,
    // MISS-ELS: the three pattern toggles and the statics switched on.
    miss: { primary: false, secondary: false, rearReds: false },
    statics: [],
  };
}

export function normalizeElsPreview(value) {
  const base = defaultElsPreview();
  const input = value && typeof value === "object" ? value : {};
  const stage = Number(input.stage);
  const mode = (entry) => (entry === "on" || entry === "off" ? entry : "auto");
  const pattern = (entry) => (Number.isInteger(entry) && entry >= 0 ? entry : null);
  return {
    stage: ELS_STAGES.includes(stage) ? stage : 0,
    groups: Object.fromEntries(ELS_V8_GROUP_KEYS.map((key) => [key, mode(input.groups?.[key])])),
    patterns: Object.fromEntries(ELS_V8_GROUP_KEYS.map((key) => [key, pattern(input.patterns?.[key])])),
    cruise: Boolean(input.cruise),
    takedowns: Boolean(input.takedowns),
    scene: Boolean(input.scene),
    miss: Object.fromEntries(MISS_PATTERN_KEYS.map((key) => [key, Boolean(input.miss?.[key])])),
    statics: Array.isArray(input.statics) ? input.statics.filter((key) => typeof key === "string") : base.statics,
  };
}

function controlledExtras(config) {
  return new Set((config?.lights || []).filter((light) => light.kind === "extra" && light.controlled).map((light) => light.id));
}

/**
 * Why each preview switch has nothing to light, or null when it can: ELS V8's
 * cruise, takedowns and scene, and MISS-ELS's pattern keys. The Sirens editor
 * and the Lights panel both disable their switches from this.
 */
export function elsSwitchBlocks(config) {
  const misc = config?.v8?.misc;
  const controlled = controlledExtras(config);
  return {
    cruise: config?.v8?.cruise ? null : "The VCF has no cruise section",
    takedowns: misc?.takedowns?.allow !== true ? "Takedowns are off in MISC"
      : !controlled.has(11) ? "Extra 11 is not ELS-controlled" : null,
    scene: misc?.sceneLights?.allow !== true ? "Scene lights are off in MISC"
      : !controlled.has(12) ? "Extra 12 is not ELS-controlled" : null,
    miss: Object.fromEntries(MISS_PATTERN_KEYS.map((key) => [
      key,
      config?.miss?.patterns?.[key]?.flashes?.length ? null : "This pattern has no flashes",
    ])),
  };
}

/** Whether any ELS light would be switched on: the rig only drives extras then. */
export function elsRunning(config, previewInput) {
  if (!config) return false;
  const preview = normalizeElsPreview(previewInput);
  if (config.dialect === "miss-els") {
    return MISS_PATTERN_KEYS.some((key) => preview.miss[key]) || preview.statics.length > 0;
  }
  // A switch the VCF does not allow (or whose extra ELS does not control) lights
  // nothing, so it must not take the extras over either.
  const misc = config.v8?.misc;
  const controlled = controlledExtras(config);
  return preview.stage > 0
    || (preview.cruise && (config.v8?.cruise?.extras || []).some((id) => controlled.has(id)))
    || (preview.takedowns && misc?.takedowns?.allow === true && controlled.has(11))
    || (preview.scene && misc?.sceneLights?.allow === true && controlled.has(12))
    || ELS_V8_GROUP_KEYS.some((key) => preview.groups[key] === "on");
}

/** Whether the preview plays a pattern (changes over time), not only steady lights. */
export function elsAnimates(config, previewInput) {
  if (!elsRunning(config, previewInput)) return false;
  return Object.values(evaluateEls(config, previewInput, 0, null).groups).some((group) => group.active);
}

// ELS-FiveM's CHP mode: with every group on chp, each stage plays one table
// across extras 1-10, with the warning group's pattern at stage 1, the
// secondary's at 2 and the primary's at 3.
const CHP_STAGE_GROUPS = Object.freeze({ 1: "warning", 2: "secondary", 3: "primary" });
const CHP_EXTRAS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

function chpMode(config) {
  return ELS_V8_GROUP_KEYS.every((key) => config.v8?.[key]?.format === "chp");
}

/** ELS V8: whether a group runs at the preview's stage and overrides. */
export function v8GroupActive(config, preview, key) {
  const override = preview.groups[key];
  if (override === "on") return true;
  if (override === "off") return false;
  const group = config.v8?.[key];
  const stage = preview.stage;
  if (!group || stage === 0) return false;
  if (chpMode(config)) return CHP_STAGE_GROUPS[stage] === key;
  if (key === "secondary") return stage < 3 || group.disableAtStage3 !== true;
  if (key === "primary") return stage >= 2;
  return stage === 3 && group.disableAtStage3 !== true;
}

/** The extras a V8 group flashes at the preview's stage. */
function v8GroupExtras(config, preview, key, controlled) {
  if (chpMode(config)) return CHP_EXTRAS.filter((id) => controlled.has(id));
  const extras = ELS_V8_GROUPS[key].extras.filter((id) => controlled.has(id));
  if (key === "primary" && preview.stage === 2 && preview.groups.primary === "auto") {
    const subset = new Set(stage2Extras(config.v8?.primary?.extrasAtStage2));
    return extras.filter((id) => subset.has(id));
  }
  return extras;
}

/**
 * The pattern a V8 group plays: a manual choice, else the enabled preset for
 * the stage, else the first pattern the pack has. Returns number | "scan" | null.
 */
export function v8GroupPattern(config, preview, key, pack) {
  const chosen = preview.patterns[key];
  if (chosen != null) return chosen;
  const group = config.v8?.[key];
  const stage = preview.stage || 3;
  const preset = group?.presets?.[stage];
  if (preset?.enabled && preset.pattern != null) return preset.pattern;
  const numbers = patternNumbers(pack, group?.format, key, stage);
  return numbers.length ? numbers[0] : null;
}

function bitOn(bits, onChar, step) {
  const index = ((step % bits.length) + bits.length) % bits.length;
  return bits[index] === onChar;
}

// The approximate flash per extra: the group's left half flashes, then its right half.
const GENERIC_BITS = Object.freeze([
  GENERIC_PATTERN + "0".repeat(GENERIC_PATTERN.length),
  "0".repeat(GENERIC_PATTERN.length) + GENERIC_PATTERN,
]);

function genericBits(extras, id) {
  return GENERIC_BITS[extras.indexOf(id) < Math.ceil(extras.length / 2) ? 0 : 1];
}

function approximateReason(pack, group, pattern) {
  if (!pack) return "No pattern tables imported.";
  if (pattern === "scan") return "Scan mode cycles the script's patterns; Cortex plays an approximate flash.";
  return `${String(group?.format).toUpperCase()} pattern ${pattern ?? "?"} is not in the imported ${pack.source} tables.`;
}

function evaluateV8(config, preview, timeMs, pack, out) {
  const controlled = controlledExtras(config);
  for (const key of ELS_V8_GROUP_KEYS) {
    const group = config.v8?.[key];
    const active = Boolean(group) && v8GroupActive(config, preview, key);
    const extras = active ? v8GroupExtras(config, preview, key, controlled) : [];
    const report = { key, active, extras, format: group?.format || null, pattern: null, source: null, approximate: false };
    out.groups[key] = report;
    if (!active || !extras.length) continue;
    const pattern = v8GroupPattern(config, preview, key, pack);
    report.pattern = pattern;
    const found = Number.isInteger(pattern) ? lookupPattern(pack, group.format, key, pattern, preview.stage || 3) : null;
    if (found) {
      report.source = pack.source;
      const step = Math.floor(timeMs / found.stepMs);
      for (const id of extras) {
        const bits = found.bits[id];
        if (bits && bitOn(bits, found.onChar, step)) out.lit.add(id);
      }
    } else {
      report.approximate = true;
      report.source = null;
      report.reason = approximateReason(pack, group, pattern);
      const step = Math.floor(timeMs / GENERIC_STEP_MS);
      for (const id of extras) if (bitOn(genericBits(extras, id), "1", step)) out.lit.add(id);
    }
  }
  const misc = config.v8?.misc;
  // Cruise lights burn steady on primary extras the primary pattern is not running.
  const cruise = config.v8?.cruise;
  const stage3Off = preview.stage === 3 && cruise?.disableAtStage3;
  if (preview.cruise && cruise && !stage3Off) {
    const flashing = new Set(out.groups.primary?.extras || []);
    for (const id of cruise.extras) if (controlled.has(id) && !flashing.has(id)) out.lit.add(id);
  }
  if (misc?.steadyBurn && preview.stage > 0 && controlled.has(10)) out.lit.add(10);
  if (preview.takedowns && misc?.takedowns?.allow && controlled.has(11)) out.lit.add(11);
  if (preview.scene && misc?.sceneLights?.allow && controlled.has(12)) out.lit.add(12);
  const sirenStage = misc?.sirenLightsAtStage || 0;
  out.sirens = sirenStage > 0 && preview.stage >= sirenStage;
  for (const id of controlled) out.driven.add(id);
}

/**
 * What a V8 group plays at the preview's stage (stage 3 while the lights are
 * off), for drawing: one bit string per extra, read with `onChar` every
 * `stepMs`. Shorter rows repeat, as they do in playback.
 * { pattern, stage, stepMs, length, onChar, rows: [{ extra, bits }], source, approximate, reason }
 * or null when the VCF has no such group.
 */
export function v8GroupLane(config, previewInput, key, pack = null) {
  const group = config?.v8?.[key];
  if (!group) return null;
  const preview = normalizeElsPreview(previewInput);
  const shown = { ...preview, stage: preview.stage || 3 };
  const extras = v8GroupExtras(config, shown, key, controlledExtras(config));
  const pattern = v8GroupPattern(config, shown, key, pack);
  const found = Number.isInteger(pattern) ? lookupPattern(pack, group.format, key, pattern, shown.stage) : null;
  const lane = found
    ? { stepMs: found.stepMs, onChar: found.onChar, rows: extras.map((extra) => ({ extra, bits: found.bits[extra] || "" })), source: pack.source, approximate: false, reason: null }
    : { stepMs: GENERIC_STEP_MS, onChar: "1", rows: extras.map((extra) => ({ extra, bits: genericBits(extras, extra) })), source: null, approximate: true, reason: approximateReason(pack, group, pattern) };
  const length = Math.max(1, ...lane.rows.map((row) => row.bits.length));
  return { pattern, stage: shown.stage, length, ...lane };
}

/** Position of `timeMs` in a MISS-ELS pattern: the flash running then. */
export function missFlashAt(pattern, timeMs) {
  const flashes = (pattern?.flashes || []).filter((flash) => Number.isFinite(flash.duration) && flash.duration > 0);
  const total = flashes.reduce((sum, flash) => sum + flash.duration, 0);
  if (!total) return null;
  let t = ((timeMs % total) + total) % total;
  for (let index = 0; index < flashes.length; index += 1) {
    if (t < flashes[index].duration) return { flash: flashes[index], index, total };
    t -= flashes[index].duration;
  }
  return { flash: flashes[flashes.length - 1], index: flashes.length - 1, total };
}

function evaluateMiss(config, preview, timeMs, out) {
  const controlled = controlledExtras(config);
  const patterns = config.miss?.patterns || {};
  for (const key of MISS_PATTERN_KEYS) {
    const active = preview.miss[key] && Boolean(patterns[key]?.flashes?.length);
    const at = active ? missFlashAt(patterns[key], timeMs) : null;
    out.groups[key] = { key, active, flashIndex: at?.index ?? null, source: "VCF", approximate: false };
    if (!at) continue;
    // MISS-ELS switches only the lights listed in EOVERRIDE.
    for (const id of at.flash.extras) if (controlled.has(id)) out.lit.add(id);
  }
  for (const key of preview.statics) {
    const match = /^extra:(\d+)$/.exec(key);
    if (match && controlled.has(Number(match[1]))) out.lit.add(Number(match[1]));
  }
  for (const id of controlled) out.driven.add(id);
}

/**
 * The frame at `timeMs`:
 * {
 *   running,          ELS has something switched on (drive extras only then)
 *   driven: Set,      extras ELS owns while running (lit or dark)
 *   lit: Set,         extras shown this frame
 *   env: [{ extra, color, offset }]  environment lights of lit extras
 *   sirens,           ELS V8 also runs the carcols siren lights
 *   groups: { [key]: { active, pattern, source, approximate, reason } }
 * }
 */
export function evaluateEls(config, previewInput, timeMs, pack = null) {
  const out = { running: false, driven: new Set(), lit: new Set(), env: [], sirens: false, groups: {} };
  if (!config) return out;
  const preview = normalizeElsPreview(previewInput);
  out.running = elsRunning(config, preview);
  if (!out.running) return out;
  const t = Number.isFinite(timeMs) ? timeMs : 0;
  if (config.dialect === "miss-els") evaluateMiss(config, preview, t, out);
  else evaluateV8(config, preview, t, pack, out);
  for (const light of config.lights) {
    if (light.kind !== "extra" || !light.envLight || !out.lit.has(light.id)) continue;
    out.env.push({ extra: light.id, key: elsLightKey("extra", light.id), color: elsColorHex(light.color), offset: light.offset });
  }
  return out;
}

/**
 * Notes for the preview strip: groups playing approximate flashes and why.
 * Returns [{ group, message }].
 */
export function elsPlaybackNotes(frame) {
  return Object.values(frame?.groups || {})
    .filter((group) => group.active && group.approximate)
    .map((group) => ({ group: group.key, message: group.reason || "Approximate flash." }));
}
