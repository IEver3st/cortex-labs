// ELS vehicle configuration files (VCFs): the per-vehicle XML that ELS-style
// lighting scripts read instead of carcols sirens. Two dialects share the
// <vcfroot> element:
//
//   els-v8    ELS V8 (LSPDFR) and the FiveM ports that read its files
//             (ELS-FiveM, ELS-Plus). Extras 1-4 are primary, 5-6 warning,
//             7-9 secondary, 10 steady burn, 11 takedowns, 12 scene lights.
//             PRML/SECL/WRNL name numbered patterns; their timings live in the
//             lighting script, not the file (see els-patterns.js).
//   miss-els  MISS-ELS. Any extra 1-12 or misc a-z; <PATTERN> spells out each
//             flash's duration and lit extras, so playback is exact.
//
// Pure and deterministic; the caller reads and writes files. Saving patches
// the original text: an edited value is rewritten where it stands, and
// elements the edit added or dropped are inserted or removed. Everything else
// (comments, spacing, line endings, unknown elements and attributes) keeps
// its bytes.

import { findChild, findChildren, parseXml } from "./xml-lite.js";
import { compactNumbers, describeFields, formatChangeValue, leafChanges } from "./change-summary.js";

export const ELS_DIALECTS = Object.freeze(["els-v8", "miss-els"]);
export const ELS_EXTRA_COUNT = 12;
export const ELS_COLORS = Object.freeze([
  { id: "red", label: "Red", color: "#ff1a1a" },
  { id: "blue", label: "Blue", color: "#1a4dff" },
  { id: "amber", label: "Amber", color: "#ff9a00" },
  { id: "white", label: "White", color: "#ffffff" },
  { id: "green", label: "Green", color: "#1aff4d" },
]);
const COLOR_IDS = new Set(ELS_COLORS.map((entry) => entry.id));

// ELS V8 light groups. The group an extra belongs to is fixed by its number.
export const ELS_V8_GROUPS = Object.freeze({
  primary: Object.freeze({ element: "PRML", label: "Primary", extras: Object.freeze([1, 2, 3, 4]) }),
  warning: Object.freeze({ element: "WRNL", label: "Warning", extras: Object.freeze([5, 6]) }),
  secondary: Object.freeze({ element: "SECL", label: "Secondary", extras: Object.freeze([7, 8, 9]) }),
});
export const ELS_V8_GROUP_KEYS = Object.freeze(["primary", "secondary", "warning"]);
export const ELS_V8_SPECIAL = Object.freeze({ 10: "steadyBurn", 11: "takedowns", 12: "sceneLights" });
// LightingFormat values ELS V8 VCFs use. `leds`, `traf` and `chp` are the
// formats the FiveM ports ship tables for.
export const ELS_V8_FORMATS = Object.freeze({
  primary: Object.freeze(["leds", "strb", "rota", "dro1", "dro2", "dro3", "chp", "custom"]),
  secondary: Object.freeze(["leds", "strb", "traf", "arrw", "marq", "chp", "custom"]),
  warning: Object.freeze(["leds", "strb", "chp", "custom"]),
});
export const ELS_STAGE2_EXTRAS = Object.freeze(["1and4", "2and3", "1and3", "2and4", "1and2", "3and4", "1", "2", "3", "4"]);

// MISS-ELS pattern blocks, in file order.
export const MISS_PATTERN_KEYS = Object.freeze(["primary", "secondary", "rearReds"]);
const MISS_PATTERN_ELEMENTS = Object.freeze({ primary: "PRIMARY", secondary: "SECONDARY", rearReds: "REARREDS" });
export const MISS_PATTERN_LABELS = Object.freeze({ primary: "Primary", secondary: "Secondary", rearReds: "Rear reds" });
export const MISS_MAX_FLASHES = 256;

export class VcfError extends Error {
  constructor(message) {
    super(message);
    this.name = "VcfError";
  }
}

// ---------------------------------------------------------------------------
// Small helpers

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function attr(node, name) {
  if (!node?.attrs) return undefined;
  if (Object.prototype.hasOwnProperty.call(node.attrs, name)) return node.attrs[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(node.attrs)) if (key.toLowerCase() === lower) return node.attrs[key];
  return undefined;
}

function otherAttrs(node, known) {
  const skip = new Set(known.map((name) => name.toLowerCase()));
  const out = {};
  for (const [key, value] of Object.entries(node?.attrs || {})) if (!skip.has(key.toLowerCase())) out[key] = value;
  return out;
}

function parseBool(value, fallback = null) {
  if (value == null) return fallback;
  const text = String(value).trim().toLowerCase();
  if (text === "true" || text === "1" || text === "yes") return true;
  if (text === "false" || text === "0" || text === "no") return false;
  return fallback;
}

function parseNum(value, fallback = 0) {
  if (value == null || String(value).trim() === "") return fallback;
  const number = Number(String(value).trim());
  return Number.isFinite(number) ? number : fallback;
}

function lowerName(node) {
  return typeof node?.name === "string" ? node.name.toLowerCase() : "";
}

function escapeAttr(value, quote = '"') {
  const text = String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return quote === "'" ? text.replace(/'/g, "&apos;") : text.replace(/"/g, "&quot;");
}

function escapeText(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatOffset(value) {
  const number = Number.isFinite(value) ? value : 0;
  const rounded = Math.round(number * 10000) / 10000;
  return Math.abs(rounded * 100 - Math.round(rounded * 100)) < 1e-9 ? rounded.toFixed(2) : String(rounded);
}

function attrList(pairs, extra = {}) {
  const parts = [];
  for (const [key, value] of pairs) if (value != null) parts.push(`${key}="${escapeAttr(value)}"`);
  for (const [key, value] of Object.entries(extra)) parts.push(`${key}="${escapeAttr(value)}"`);
  return parts.length ? ` ${parts.join(" ")}` : "";
}

/** "extra:3" or "misc:k": the key a light is known by everywhere else. */
export function elsLightKey(kind, id) {
  return kind === "misc" ? `misc:${String(id).toLowerCase()}` : `extra:${Number(id)}`;
}

/** Group key ("primary" | "warning" | "secondary") of an ELS V8 extra, or null. */
export function elsV8GroupOf(extra) {
  for (const key of ELS_V8_GROUP_KEYS) if (ELS_V8_GROUPS[key].extras.includes(extra)) return key;
  return null;
}

/** Human role of an extra in a dialect, for labels. */
export function elsExtraRole(dialect, extra) {
  if (dialect !== "els-v8") return null;
  const group = elsV8GroupOf(extra);
  if (group) return ELS_V8_GROUPS[group].label;
  return { 10: "Steady burn", 11: "Takedowns", 12: "Scene lights" }[extra] || null;
}

export function elsColorHex(id) {
  return ELS_COLORS.find((entry) => entry.id === id)?.color || "#ffffff";
}

/** Extras listed in a stage-2 subset such as "2and3". */
export function stage2Extras(value) {
  const text = String(value || "1and4").trim().toLowerCase();
  const ids = text.split("and").map((part) => Number(part)).filter((id) => Number.isInteger(id) && id >= 1 && id <= 6);
  return ids.length ? ids : [1, 4];
}

function parseIdList(value, kind) {
  if (value == null) return [];
  const out = [];
  for (const token of String(value).split(/[\s,;]+/)) {
    if (!token) continue;
    if (kind === "misc") {
      if (/^[a-z]$/i.test(token)) out.push(token.toLowerCase());
      else throw new VcfError(`"${token}" is not a misc letter (a-z).`);
    } else {
      const id = Number(token);
      if (!Number.isInteger(id) || id < 1 || id > ELS_EXTRA_COUNT) throw new VcfError(`"${token}" is not an extra number (1-${ELS_EXTRA_COUNT}).`);
      out.push(id);
    }
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Parsing

function parseLightElement(node, dialect) {
  const name = node.name;
  const extra = /^extra(\d{1,2})$/i.exec(name);
  const misc = /^misc([a-z])$/i.exec(name);
  if (!extra && !misc) return null;
  const kind = extra ? "extra" : "misc";
  const id = extra ? Number(extra[1]) : misc[1].toLowerCase();
  if (kind === "extra" && (id < 1 || id > ELS_EXTRA_COUNT)) return null;
  const controlledAttr = parseBool(attr(node, "IsElsControlled"));
  const color = String(attr(node, "Color") ?? "").trim().toLowerCase();
  return {
    kind,
    id,
    // MISS-ELS controls every listed light; ELS V8 only those marked.
    controlled: dialect === "els-v8" ? controlledAttr === true : controlledAttr !== false,
    envLight: parseBool(attr(node, "AllowEnvLight"), false),
    color: color || "red",
    offset: [parseNum(attr(node, "OffsetX")), parseNum(attr(node, "OffsetY")), parseNum(attr(node, "OffsetZ"))],
    attrs: otherAttrs(node, ["IsElsControlled", "AllowEnvLight", "Color", "OffsetX", "OffsetY", "OffsetZ"]),
  };
}

// A number, "scan", the raw text when it is neither, or null when absent.
function parsePatternValue(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (/^scan$/i.test(text)) return "scan";
  const number = Number(text);
  return Number.isInteger(number) && number >= 0 ? number : text;
}

function parseV8Group(node, key, source) {
  if (!node) return null;
  const presets = { 1: null, 2: null, 3: null };
  let scanPool = null;
  let forcedXml = null;
  const extraXml = [];
  for (const child of node.children) {
    const name = lowerName(child);
    if (name === "presetpatterns") {
      for (const stage of child.children) {
        const match = /^lstg([123])$/i.exec(stage.name);
        if (!match) continue;
        presets[match[1]] = {
          enabled: parseBool(attr(stage, "Enabled"), false),
          pattern: parsePatternValue(attr(stage, "Pattern")),
        };
      }
    } else if (name === "scanpatterncustompool") {
      scanPool = {
        enabled: parseBool(attr(child, "Enabled"), false),
        sequential: parseBool(attr(child, "Sequential"), true),
        patterns: findChildren(child, "Pattern").map((entry) => parsePatternValue(entry.text)).filter(Number.isInteger),
      };
    } else if (name === "forcedpatterns") {
      forcedXml = source.slice(child.start, child.end);
    } else {
      extraXml.push(source.slice(child.start, child.end));
    }
  }
  const disable = attr(node, "DisableAtLstg3");
  return {
    format: String(attr(node, "LightingFormat") ?? "leds").trim().toLowerCase() || "leds",
    extrasAtStage2: key === "primary" ? (attr(node, "ExtrasActiveAtLstg2") ?? null) : null,
    disableAtStage3: disable == null ? null : parseBool(disable, false),
    presets,
    scanPool,
    forcedXml,
    extraXml,
    attrs: otherAttrs(node, ["LightingFormat", "DisableAtLstg3", ...(key === "primary" ? ["ExtrasActiveAtLstg2"] : [])]),
  };
}

function childValue(node, name) {
  const child = findChild(node, name);
  return child ? child.text : undefined;
}

function parseV8Misc(node, source) {
  if (!node) return null;
  const known = new Set(["vehicleisslicktop", "arrowboardtype", "usesteadyburnlights", "dfltsirenltsactivateatlstg", "takedowns", "scenelights"]);
  const takedowns = findChild(node, "Takedowns");
  const scene = findChild(node, "SceneLights");
  return {
    slicktop: parseBool(childValue(node, "VehicleIsSlicktop"), false),
    arrowboard: String(childValue(node, "ArrowboardType") ?? "off").trim().toLowerCase() || "off",
    steadyBurn: parseBool(childValue(node, "UseSteadyBurnLights"), false),
    sirenLightsAtStage: Math.max(0, Math.min(3, Math.round(parseNum(childValue(node, "DfltSirenLtsActivateAtLstg"), 0)))),
    takedowns: { allow: parseBool(attr(takedowns, "AllowUse"), false), mirrored: parseBool(attr(takedowns, "Mirrored"), false) },
    sceneLights: { allow: parseBool(attr(scene, "AllowUse"), false), sidesOnly: parseBool(attr(scene, "IlluminateSidesOnly"), false) },
    extraXml: node.children.filter((child) => !known.has(lowerName(child))).map((child) => source.slice(child.start, child.end)),
  };
}

function parseV8Cruise(node, source) {
  if (!node) return null;
  const use = findChild(node, "UseExtras");
  const extras = [];
  for (let id = 1; id <= 4; id += 1) if (parseBool(attr(use, `Extra${id}`), false)) extras.push(id);
  const known = new Set(["disableatlstg3", "useextras"]);
  return {
    disableAtStage3: parseBool(childValue(node, "DisableAtLstg3"), false),
    extras,
    extraXml: node.children.filter((child) => !known.has(lowerName(child))).map((child) => source.slice(child.start, child.end)),
  };
}

function parseMissStatics(node) {
  if (!node) return [];
  const out = [];
  for (const child of node.children) {
    const extra = /^extra(\d{1,2})$/i.exec(child.name);
    const misc = /^misc([a-z])$/i.exec(child.name);
    if (!extra && !misc) continue;
    out.push({
      kind: extra ? "extra" : "misc",
      id: extra ? Number(extra[1]) : misc[1].toLowerCase(),
      name: attr(child, "Name") ?? "",
    });
  }
  return out;
}

function parseMissPattern(node, label) {
  if (!node) return null;
  const flashes = [];
  for (const child of findChildren(node, "Flash")) {
    const duration = parseNum(attr(child, "Duration"), Number.NaN);
    let extras;
    let miscs;
    try {
      extras = parseIdList(attr(child, "Extras"), "extra");
      miscs = parseIdList(attr(child, "Miscs"), "misc");
    } catch (error) {
      throw new VcfError(`${label} flash ${flashes.length + 1}: ${error.message}`);
    }
    flashes.push({ duration, extras, miscs });
  }
  return {
    isEmergency: parseBool(attr(node, "IsEmergency")),
    flashHighBeam: parseBool(attr(node, "FlashHighBeam")),
    warningBeep: parseBool(attr(node, "EnableWarningBeep")),
    flashes,
    attrs: otherAttrs(node, ["IsEmergency", "FlashHighBeam", "EnableWarningBeep"]),
  };
}

/** True when `text` looks like a VCF (root element vcfroot). */
export function isVcfText(text) {
  return /<vcfroot[\s>/]/i.test(String(text || "").slice(0, 4096));
}

function detectDialect(root) {
  const pattern = findChild(root, "PATTERN");
  const flashes = pattern ? MISS_PATTERN_KEYS.some((key) => findChildren(findChild(pattern, MISS_PATTERN_ELEMENTS[key]), "Flash").length > 0) : false;
  if (flashes || findChild(root, "STATIC")) return "miss-els";
  if (findChild(root, "PRML") || findChild(root, "SECL") || findChild(root, "WRNL")) return "els-v8";
  if (pattern) return "miss-els";
  // An EOVERRIDE with IsElsControlled attributes is V8 style.
  const lights = findChild(root, "EOVERRIDE")?.children || [];
  return lights.some((node) => attr(node, "IsElsControlled") != null) ? "els-v8" : "miss-els";
}

/**
 * Parses a VCF into the editor model. Throws VcfError (or XmlParseError with a
 * line and column) when the file is not a VCF or a value cannot be read.
 */
export function parseVcf(text, sourcePath = "") {
  if (typeof text !== "string") throw new VcfError("VCF text must be a string.");
  const source = stripBom(text);
  const root = parseXml(source, { positions: true });
  if (lowerName(root) !== "vcfroot") {
    throw new VcfError(`${sourcePath || "File"} is not an ELS VCF: its root element is <${root.name}>, not <vcfroot>.`);
  }
  const dialect = detectDialect(root);
  const lights = [];
  const seen = new Set();
  for (const node of findChild(root, "EOVERRIDE")?.children || []) {
    const light = parseLightElement(node, dialect);
    if (!light) continue;
    const key = elsLightKey(light.kind, light.id);
    if (seen.has(key)) throw new VcfError(`${node.name} is listed twice in EOVERRIDE.`);
    seen.add(key);
    lights.push(light);
  }
  lights.sort(compareLights);
  const config = {
    dialect,
    description: attr(root, "Description") ?? "",
    author: attr(root, "Author") ?? "",
    rootAttrs: otherAttrs(root, ["Description", "Author"]),
    lights,
    v8: null,
    miss: null,
  };
  if (dialect === "els-v8") {
    config.v8 = {
      primary: parseV8Group(findChild(root, "PRML"), "primary", source),
      secondary: parseV8Group(findChild(root, "SECL"), "secondary", source),
      warning: parseV8Group(findChild(root, "WRNL"), "warning", source),
      misc: parseV8Misc(findChild(root, "MISC"), source),
      cruise: parseV8Cruise(findChild(root, "CRUISE"), source),
    };
  } else {
    const pattern = findChild(root, "PATTERN");
    const patterns = {};
    for (const key of MISS_PATTERN_KEYS) patterns[key] = parseMissPattern(findChild(pattern, MISS_PATTERN_ELEMENTS[key]), MISS_PATTERN_LABELS[key]);
    config.miss = { statics: parseMissStatics(findChild(root, "STATIC")), patterns };
  }
  return config;
}

function compareLights(a, b) {
  if (a.kind !== b.kind) return a.kind === "extra" ? -1 : 1;
  return a.kind === "extra" ? a.id - b.id : String(a.id).localeCompare(String(b.id));
}

// ---------------------------------------------------------------------------
// New files

const DEFAULT_V8_COLORS = { 1: "red", 2: "red", 3: "blue", 4: "blue", 5: "white", 6: "white", 7: "amber", 8: "amber", 9: "amber" };
const DEFAULT_MISS_COLORS = { 1: "red", 2: "blue", 3: "red", 4: "blue", 5: "red", 6: "blue", 7: "amber", 8: "amber", 9: "amber" };

function defaultV8Group(key) {
  const stages = key === "secondary" ? [1, 2, 3] : key === "primary" ? [2, 3] : [3];
  const presets = { 1: null, 2: null, 3: null };
  for (const stage of [1, 2, 3]) presets[stage] = { enabled: stages.includes(stage), pattern: 1 };
  return {
    format: "leds",
    extrasAtStage2: key === "primary" ? "1and4" : null,
    // Warning lights run only at stage 3, so only the secondaries can stop there.
    disableAtStage3: key === "secondary" ? false : null,
    presets,
    scanPool: { enabled: false, sequential: true, patterns: [] },
    forcedXml: null,
    extraXml: [],
    attrs: {},
  };
}

function defaultMissPattern(key, extras) {
  const ids = (list) => list.filter((id) => extras.includes(id));
  if (key === "primary") {
    const left = ids([1, 2]);
    const right = ids([3, 4]);
    if (!left.length && !right.length) return { isEmergency: true, flashHighBeam: false, warningBeep: false, flashes: [], attrs: {} };
    return {
      isEmergency: true,
      flashHighBeam: false,
      warningBeep: false,
      attrs: {},
      flashes: [
        { duration: 60, extras: left, miscs: [] }, { duration: 40, extras: [], miscs: [] },
        { duration: 60, extras: left, miscs: [] }, { duration: 120, extras: [], miscs: [] },
        { duration: 60, extras: right, miscs: [] }, { duration: 40, extras: [], miscs: [] },
        { duration: 60, extras: right, miscs: [] }, { duration: 120, extras: [], miscs: [] },
      ],
    };
  }
  if (key === "secondary") {
    const pair = ids([5, 6]);
    return {
      isEmergency: true,
      flashHighBeam: false,
      warningBeep: false,
      attrs: {},
      flashes: pair.length ? pair.flatMap((id) => [{ duration: 280, extras: [id], miscs: [] }, { duration: 160, extras: [], miscs: [] }]) : [],
    };
  }
  const rear = ids([7, 8, 9]);
  return {
    isEmergency: false,
    flashHighBeam: false,
    warningBeep: false,
    attrs: {},
    flashes: rear.length ? rear.flatMap((id) => [{ duration: 160, extras: [id], miscs: [] }, { duration: 160, extras: [], miscs: [] }]) : [],
  };
}

/**
 * A new VCF model for a vehicle. `extras` are the extra numbers the model
 * has; lights default to the dialect's usual layout for those extras.
 */
export function createVcf(dialect, { extras = [], modelName = "", author = "" } = {}) {
  const kind = dialect === "miss-els" ? "miss-els" : "els-v8";
  const available = [...new Set(extras.filter((id) => Number.isInteger(id) && id >= 1 && id <= ELS_EXTRA_COUNT))].sort((a, b) => a - b);
  const lights = [];
  if (kind === "els-v8") {
    for (let id = 1; id <= ELS_EXTRA_COUNT; id += 1) {
      const flashing = id <= 9 && available.includes(id);
      // Takedowns (11) and scene lights (12) are ELS's when the model has them;
      // steady burn (10) stays the model's until the user opts in.
      const special = (id === 11 || id === 12) && available.includes(id);
      lights.push({
        kind: "extra",
        id,
        controlled: flashing || special,
        envLight: flashing,
        color: flashing ? DEFAULT_V8_COLORS[id] : special ? "white" : "red",
        offset: [0, 0, 0],
        attrs: {},
      });
    }
  } else {
    for (const id of available.filter((value) => value <= 9)) {
      lights.push({ kind: "extra", id, controlled: true, envLight: true, color: DEFAULT_MISS_COLORS[id] || "white", offset: [0, 0, 0], attrs: {} });
    }
  }
  const description = modelName ? `${modelName} lighting` : "Vehicle lighting";
  const config = { dialect: kind, description, author, rootAttrs: {}, lights, v8: null, miss: null };
  if (kind === "els-v8") {
    config.v8 = {
      primary: defaultV8Group("primary"),
      secondary: defaultV8Group("secondary"),
      warning: defaultV8Group("warning"),
      misc: {
        slicktop: false,
        arrowboard: "off",
        steadyBurn: false,
        sirenLightsAtStage: 0,
        takedowns: { allow: available.includes(11), mirrored: true },
        sceneLights: { allow: available.includes(12), sidesOnly: true },
        extraXml: [],
      },
      cruise: { disableAtStage3: true, extras: [], extraXml: [] },
    };
  } else {
    const flashing = lights.map((light) => light.id);
    config.miss = {
      statics: [],
      patterns: Object.fromEntries(MISS_PATTERN_KEYS.map((key) => [key, defaultMissPattern(key, flashing)])),
    };
  }
  return config;
}

// ---------------------------------------------------------------------------
// Writing

function v8LightLine(light) {
  const name = `Extra${String(light.id).padStart(2, "0")}`;
  const plain = !light.controlled && !light.envLight && light.offset.every((value) => !value) && !Object.keys(light.attrs || {}).length;
  if (plain) return `<${name} IsElsControlled="false" />`;
  return `<${name}${attrList([
    ["IsElsControlled", String(Boolean(light.controlled))],
    ["AllowEnvLight", String(Boolean(light.envLight))],
    ["Color", light.color || "red"],
    ["OffsetX", formatOffset(light.offset[0])],
    ["OffsetY", formatOffset(light.offset[1])],
    ["OffsetZ", formatOffset(light.offset[2])],
  ], light.attrs)} />`;
}

function missLightLine(light) {
  const name = light.kind === "misc" ? `Misc${String(light.id).toUpperCase()}` : `Extra${String(light.id).padStart(2, "0")}`;
  const hasOffset = light.offset.some((value) => value);
  return `<${name}${attrList([
    ["AllowEnvLight", String(Boolean(light.envLight))],
    ["Color", light.color || "red"],
    ["OffsetX", hasOffset ? formatOffset(light.offset[0]) : null],
    ["OffsetY", hasOffset ? formatOffset(light.offset[1]) : null],
    ["OffsetZ", hasOffset ? formatOffset(light.offset[2]) : null],
  ], light.attrs)} />`;
}

// Writers build a small tree: a string is one line, { raw } is source kept
// verbatim, and { open, children, close } is an element with child lines.
function block(name, attrs, children) {
  if (!children.length) return `<${name}${attrs}></${name}>`;
  return { open: `<${name}${attrs}>`, children, close: `</${name}>` };
}

function sectionEoverride(config) {
  const lines = [];
  const lights = [...config.lights].sort(compareLights);
  for (const light of lights) {
    if (config.dialect === "els-v8") {
      if (light.kind === "extra") lines.push(v8LightLine(light));
    } else if (light.controlled) lines.push(missLightLine(light));
  }
  return block("EOVERRIDE", "", lines);
}

function sectionV8Group(key, group) {
  const element = ELS_V8_GROUPS[key].element;
  const attrs = attrList([
    ["LightingFormat", group.format || "leds"],
    ["ExtrasActiveAtLstg2", key === "primary" ? group.extrasAtStage2 : null],
    ["DisableAtLstg3", group.disableAtStage3 == null ? null : String(Boolean(group.disableAtStage3))],
  ], group.attrs);
  const children = [presetsBlock(group.presets)];
  if (group.forcedXml) children.push({ raw: group.forcedXml });
  if (group.scanPool) children.push(scanPoolBlock(group.scanPool));
  for (const raw of group.extraXml || []) children.push({ raw });
  return block(element, attrs, children);
}

function presetLine(preset, stage) {
  return `<Lstg${stage}${attrList([["Enabled", String(Boolean(preset.enabled))], ["Pattern", preset.pattern == null ? null : String(preset.pattern)]])} />`;
}

function presetsBlock(presets) {
  return block("PresetPatterns", "", [1, 2, 3].filter((stage) => presets?.[stage]).map((stage) => presetLine(presets[stage], stage)));
}

function poolLine(value) {
  return `<Pattern>${escapeText(value)}</Pattern>`;
}

function scanPoolBlock(pool) {
  return block("ScanPatternCustomPool", attrList([["Enabled", String(Boolean(pool.enabled))], ["Sequential", String(Boolean(pool.sequential))]]), pool.patterns.map(poolLine));
}

function sectionV8Misc(misc) {
  return block("MISC", "", [
    `<VehicleIsSlicktop>${misc.slicktop ? "true" : "false"}</VehicleIsSlicktop>`,
    `<ArrowboardType>${escapeText(misc.arrowboard || "off")}</ArrowboardType>`,
    `<UseSteadyBurnLights>${misc.steadyBurn ? "true" : "false"}</UseSteadyBurnLights>`,
    `<DfltSirenLtsActivateAtLstg>${Math.max(0, Math.min(3, Math.round(misc.sirenLightsAtStage || 0)))}</DfltSirenLtsActivateAtLstg>`,
    `<Takedowns${attrList([["AllowUse", String(Boolean(misc.takedowns?.allow))], ["Mirrored", String(Boolean(misc.takedowns?.mirrored))]])} />`,
    `<SceneLights${attrList([["AllowUse", String(Boolean(misc.sceneLights?.allow))], ["IlluminateSidesOnly", String(Boolean(misc.sceneLights?.sidesOnly))]])} />`,
    ...(misc.extraXml || []).map((raw) => ({ raw })),
  ]);
}

function sectionV8Cruise(cruise) {
  const use = [1, 2, 3, 4].map((id) => [`Extra${id}`, String(cruise.extras.includes(id))]);
  return block("CRUISE", "", [
    `<DisableAtLstg3>${cruise.disableAtStage3 ? "true" : "false"}</DisableAtLstg3>`,
    `<UseExtras${attrList(use)} />`,
    ...(cruise.extraXml || []).map((raw) => ({ raw })),
  ]);
}

function staticLine(entry) {
  const name = entry.kind === "misc" ? `Misc${String(entry.id).toUpperCase()}` : `Extra${String(entry.id).padStart(2, "0")}`;
  return `<${name}${attrList([["Name", entry.name ? entry.name : null]])} />`;
}

function sectionMissStatic(statics) {
  return block("STATIC", "", statics.map(staticLine));
}

function flashLine(flash) {
  return `<Flash${attrList([
    ["Duration", String(Math.round(flash.duration))],
    ["Extras", flash.extras.length ? flash.extras.join(",") : null],
    ["Miscs", flash.miscs.length ? flash.miscs.join(",") : null],
  ])} />`;
}

function missPatternBlock(key, pattern) {
  const element = MISS_PATTERN_ELEMENTS[key];
  if (!pattern) return `<${element}></${element}>`;
  const attrs = attrList([
    ["IsEmergency", pattern.isEmergency == null ? null : String(pattern.isEmergency)],
    ["FlashHighBeam", pattern.flashHighBeam == null ? null : String(pattern.flashHighBeam)],
    ["EnableWarningBeep", pattern.warningBeep == null ? null : String(pattern.warningBeep)],
  ], pattern.attrs);
  return block(element, attrs, pattern.flashes.map(flashLine));
}

// A pattern the model lacks is left out rather than written empty.
function sectionMissPattern(patterns) {
  return block("PATTERN", "", MISS_PATTERN_KEYS.filter((key) => patterns[key]).map((key) => missPatternBlock(key, patterns[key])));
}

// Raw source keeps its own inner indentation; only its first line moves.
function renderNode(node, indent, unit, eol) {
  if (typeof node === "string") return indent + node;
  if ("raw" in node) return indent + node.raw.trim();
  return [indent + node.open, ...node.children.map((child) => renderNode(child, indent + unit, unit, eol)), indent + node.close].join(eol);
}

// The sections each dialect writes, in file order: `write` builds a missing
// section, `patch` edits an existing one toward the model.
function sectionPlan(config) {
  if (config.dialect === "els-v8") {
    const v8 = config.v8 || {};
    const group = (name, key) => ({
      name,
      model: () => v8[key],
      write: () => (v8[key] ? sectionV8Group(key, v8[key]) : null),
      patch: (patch, node, base) => patchV8Group(patch, node, key, base.v8?.[key], v8[key]),
    });
    return [
      { name: "EOVERRIDE", model: () => config.lights, write: () => sectionEoverride(config), patch: (patch, node) => patchEoverride(patch, node, config) },
      { name: "MISC", model: () => v8.misc, write: () => (v8.misc ? sectionV8Misc(v8.misc) : null), patch: (patch, node, base) => patchV8Misc(patch, node, base.v8?.misc, v8.misc) },
      { name: "CRUISE", model: () => v8.cruise, write: () => (v8.cruise ? sectionV8Cruise(v8.cruise) : null), patch: (patch, node, base) => patchV8Cruise(patch, node, base.v8?.cruise, v8.cruise) },
      group("WRNL", "warning"),
      group("PRML", "primary"),
      group("SECL", "secondary"),
    ];
  }
  const miss = config.miss || { statics: [], patterns: {} };
  return [
    { name: "EOVERRIDE", model: () => config.lights.filter((light) => light.controlled), write: () => sectionEoverride(config), patch: (patch, node) => patchEoverride(patch, node, config) },
    { name: "STATIC", model: () => miss.statics, write: () => sectionMissStatic(miss.statics), patch: (patch, node, base) => patchMissStatics(patch, node, base.miss?.statics || [], miss.statics) },
    { name: "PATTERN", model: () => miss.patterns, write: () => sectionMissPattern(miss.patterns), patch: (patch, node, base) => patchMissPatterns(patch, node, base.miss?.patterns || {}, miss.patterns) },
  ];
}

const V8_SOUNDS = [
  '<MainHorn InterruptsSiren="true" AudioString="SIRENS_AIRHORN" />',
  '<ManTone1 AllowUse="true" AudioString="VEHICLES_HORNS_SIREN_1" />',
  '<ManTone2 AllowUse="true" AudioString="VEHICLES_HORNS_SIREN_2" />',
  '<SrnTone1 AllowUse="true" AudioString="VEHICLES_HORNS_SIREN_1" />',
  '<SrnTone2 AllowUse="true" AudioString="VEHICLES_HORNS_SIREN_2" />',
  '<SrnTone3 AllowUse="true" AudioString="VEHICLES_HORNS_POLICE_WARNING" />',
  '<SrnTone4 AllowUse="true" AudioString="VEHICLES_HORNS_AMBULANCE_WARNING" />',
  '<AuxSiren AllowUse="true" AudioString="VEHICLES_HORNS_SIREN_1" />',
  '<PanicMde AllowUse="true" AudioString="VEHICLES_HORNS_POLICE_WARNING" />',
];

const MISS_SOUNDS = [
  '<MainHorn AllowUse="false" />',
  '<NineMode AllowUse="false" />',
  '<SrnTone1 AllowUse="true" AudioString="VEHICLES_HORNS_SIREN_1" />',
  '<SrnTone2 AllowUse="true" AudioString="VEHICLES_HORNS_SIREN_2" />',
  '<SrnTone3 AllowUse="true" AudioString="VEHICLES_HORNS_POLICE_WARNING" />',
  '<SrnTone4 AllowUse="false" />',
];

/** A complete new VCF file for `config` (from createVcf or an edited model). */
export function createVcfText(config, { eol = "\r\n", unit = "\t" } = {}) {
  const sections = [];
  const write = (lines) => sections.push(renderNode(lines, unit, unit, eol));
  const plan = new Map(sectionPlan(config).map((entry) => [entry.name, entry]));
  const emit = (name) => {
    const lines = plan.get(name)?.write();
    if (lines) write(lines);
  };
  if (config.dialect === "els-v8") {
    write(block("INTERFACE", "", [
      "<LstgActivationType>manual</LstgActivationType>",
      "<DefaultSirenMode>standby</DefaultSirenMode>",
      "<InfoPanelHeaderColor>grey</InfoPanelHeaderColor>",
      "<InfoPanelButtonLightColor>orange</InfoPanelButtonLightColor>",
    ]));
    emit("EOVERRIDE");
    emit("MISC");
    emit("CRUISE");
    write(block("SOUNDS", "", V8_SOUNDS));
    emit("WRNL");
    emit("PRML");
    emit("SECL");
  } else {
    emit("EOVERRIDE");
    emit("STATIC");
    write(block("SOUNDS", "", MISS_SOUNDS));
    emit("PATTERN");
  }
  const rootAttrs = attrList([["Description", config.description || ""], ["Author", config.author || ""]], config.rootAttrs);
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<!-- ELS VEHICLE CONFIGURATION FILE -->",
    `<vcfroot${rootAttrs}>`,
    ...sections,
    "</vcfroot>",
    "",
  ].join(eol);
}

function detectIndentUnit(source) {
  let best = null;
  for (const match of source.matchAll(/^([ \t]+)</gm)) {
    if (best == null || match[1].length < best.length) best = match[1];
  }
  if (!best) return "\t";
  return best.includes("\t") ? "\t" : best;
}

function lineIndent(source, offset) {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const prefix = source.slice(lineStart, offset);
  return /^[ \t]*$/.test(prefix) ? prefix : "";
}

function sameModel(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// ---------------------------------------------------------------------------
// Patching the original text

// Edits against one source string, applied together. Insertions at the same
// offset keep the order they were made in.
class SourcePatch {
  constructor(source, eol, unit) {
    this.source = source;
    this.eol = eol;
    this.unit = unit;
    this.edits = [];
    this.opened = new Map();
  }

  replace(start, end, text) {
    this.edits.push({ start, end, text, order: this.edits.length });
  }

  insert(at, text) {
    this.replace(at, at, text);
  }

  // Content for a self-closing element replaces only its "/>" (and the spaces
  // before it), so edits to the tag's attributes still apply. Everything added
  // to one element goes into that one replacement.
  fill(node, text, closeIndent = "") {
    let opened = this.opened.get(node.start);
    if (!opened) {
      let at = startTag(this.source, node).end - 2;
      while (at > node.start && /\s/.test(this.source[at - 1])) at -= 1;
      opened = { start: at, end: node.end, name: node.name, closeIndent, parts: [] };
      this.opened.set(node.start, opened);
    }
    opened.parts.push(text);
  }

  apply() {
    const edits = [...this.edits];
    for (const opened of this.opened.values()) {
      edits.push({ start: opened.start, end: opened.end, text: `>${opened.parts.join("")}${opened.closeIndent}</${opened.name}>`, order: edits.length });
    }
    edits.sort((a, b) => b.start - a.start || b.end - a.end || b.order - a.order);
    let out = this.source;
    let floor = Infinity;
    for (const edit of edits) {
      if (edit.end > floor) throw new VcfError("The edits overlap in the original file; use Save as to write a new VCF.");
      out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
      floor = edit.start;
    }
    return out;
  }
}

// Where a node's start tag ends (just after ">") and whether it closes itself.
function startTag(source, node) {
  let quote = null;
  for (let index = node.start + 1; index < node.end; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return { end: index + 1, selfClosing: source[index - 1] === "/" };
    }
  }
  throw new VcfError(`Cannot read the <${node.name}> tag.`);
}

function closeTagStart(source, node) {
  return source.lastIndexOf("</", node.end - 1);
}

function findAttr(source, node, name) {
  const tag = startTag(source, node);
  const lower = name.toLowerCase();
  const pattern = /(\s+)([^\s=/>]+)(\s*=\s*)("[^"]*"|'[^']*')/g;
  for (const match of source.slice(node.start, tag.end).matchAll(pattern)) {
    if (match[2].toLowerCase() !== lower) continue;
    const start = node.start + match.index;
    const valueStart = start + match[1].length + match[2].length + match[3].length + 1;
    return { tag, start, end: start + match[0].length, valueStart, valueEnd: valueStart + match[4].length - 2, quote: match[4][0] };
  }
  return { tag, start: null };
}

/** Sets one attribute in the original tag; null removes it. */
function setAttr(patch, node, name, value) {
  const found = findAttr(patch.source, node, name);
  if (value == null) {
    if (found.start != null) patch.replace(found.start, found.end, "");
    return;
  }
  if (found.start != null) {
    const text = escapeAttr(value, found.quote);
    if (patch.source.slice(found.valueStart, found.valueEnd) !== text) patch.replace(found.valueStart, found.valueEnd, text);
    return;
  }
  // A new attribute goes after the last one, before "/>" or ">".
  let at = found.tag.end - (found.tag.selfClosing ? 2 : 1);
  while (at > node.start && /\s/.test(patch.source[at - 1])) at -= 1;
  patch.insert(at, ` ${name}="${escapeAttr(value)}"`);
}

function hasAttr(source, node, name) {
  return findAttr(source, node, name).start != null;
}

function patchAttrs(patch, node, before = {}, after = {}) {
  for (const [name, value] of Object.entries(after || {})) if (before?.[name] !== value) setAttr(patch, node, name, value);
  for (const name of Object.keys(before || {})) if (!Object.prototype.hasOwnProperty.call(after || {}, name)) setAttr(patch, node, name, null);
}

/** Replaces an element's content with `value`. */
function setText(patch, node, value) {
  const { source } = patch;
  const tag = startTag(source, node);
  const text = escapeText(value);
  if (tag.selfClosing) {
    patch.fill(node, text);
    return;
  }
  const close = closeTagStart(source, node);
  if (source.slice(tag.end, close) !== text) patch.replace(tag.end, close, text);
}

// Removes an element. Alone on its line, the line goes too: the cut runs from
// the previous line's end, so an insertion right after the element stays valid.
function removeNode(patch, node) {
  const { source } = patch;
  const lineStart = source.lastIndexOf("\n", node.start - 1) + 1;
  const trailing = /^[ \t]*(?=\r?\n|$)/.exec(source.slice(node.end, node.end + 256));
  if (lineStart > 0 && trailing && /^[ \t]*$/.test(source.slice(lineStart, node.start))) {
    const cut = source[lineStart - 2] === "\r" ? lineStart - 2 : lineStart - 1;
    patch.replace(cut, node.end + trailing[0].length, "");
  } else {
    patch.replace(node.start, node.end, "");
  }
}

function insertAfter(patch, node, items) {
  const indent = lineIndent(patch.source, node.start);
  patch.insert(node.end, items.map((item) => patch.eol + renderNode(item, indent, patch.unit, patch.eol)).join(""));
}

function insertBefore(patch, node, items) {
  const indent = lineIndent(patch.source, node.start);
  patch.insert(node.start, items.map((item) => renderNode(item, indent, patch.unit, patch.eol).slice(indent.length) + patch.eol + indent).join(""));
}

// Adds children at the end of `parent`, before its closing tag (opening a
// self-closing parent).
function insertInto(patch, parent, items) {
  const { source, eol, unit } = patch;
  const indent = lineIndent(source, parent.start);
  const body = items.map((item) => eol + renderNode(item, indent + unit, unit, eol)).join("");
  const tag = startTag(source, parent);
  if (tag.selfClosing) {
    patch.fill(parent, body, `${eol}${indent}`);
    return;
  }
  const close = closeTagStart(source, parent);
  const lineStart = source.lastIndexOf("\n", close - 1) + 1;
  if (lineStart > tag.end && /^[ \t]*$/.test(source.slice(lineStart, close))) {
    // The closing tag has its own line: add the children at the end of the line before it.
    patch.insert(source[lineStart - 2] === "\r" ? lineStart - 2 : lineStart - 1, body);
  } else {
    patch.insert(close, `${body}${eol}${indent}`);
  }
}

function appendChildren(patch, parent, items) {
  const last = parent.children[parent.children.length - 1];
  if (last) insertAfter(patch, last, items);
  else insertInto(patch, parent, items);
}

// Edits the source children `entries` ({ key, node, value }, file order) into
// `items` ({ key, value }, model order): updates elements both have, removes
// those the model dropped and inserts new ones beside their model neighbours.
// Other children of `parent` are left alone.
function patchKeyed(patch, parent, entries, items, { update, render }) {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const wanted = new Set(items.map((item) => item.key));
  const removed = new Set();
  for (const entry of entries) {
    if (wanted.has(entry.key)) continue;
    removeNode(patch, entry.node);
    removed.add(entry.node);
  }
  let anchor = null;
  let pending = [];
  const place = (next) => {
    if (!pending.length) return;
    const lines = pending.map((item) => render(item.value, item.key));
    if (anchor) insertAfter(patch, anchor, lines);
    else if (next) insertBefore(patch, next, lines);
    else {
      const kept = parent.children.filter((child) => !removed.has(child));
      if (kept.length) insertAfter(patch, kept[kept.length - 1], lines);
      else insertInto(patch, parent, lines);
    }
    pending = [];
  };
  for (const item of items) {
    const entry = byKey.get(item.key);
    if (!entry) {
      pending.push(item);
      continue;
    }
    place(entry.node);
    if (!sameModel(entry.value, item.value)) update(entry.node, entry.value, item.value);
    anchor = entry.node;
  }
  place(null);
}

// Edits a run of like children (`nodes`, holding `before`) into `after` by
// position. A shared head and tail stay untouched, so inserting or deleting
// one entry touches only that entry.
function patchIndexed(patch, parent, nodes, before, after, { same, update, render }) {
  let head = 0;
  while (head < nodes.length && head < after.length && same(before[head], after[head])) head += 1;
  let tail = 0;
  while (tail < nodes.length - head && tail < after.length - head && same(before[nodes.length - 1 - tail], after[after.length - 1 - tail])) tail += 1;
  const oldCount = nodes.length - head - tail;
  const newCount = after.length - head - tail;
  const common = Math.min(oldCount, newCount);
  for (let index = head; index < head + common; index += 1) {
    if (!same(before[index], after[index])) update(nodes[index], before[index], after[index]);
  }
  if (newCount > common) {
    const lines = after.slice(head + common, head + newCount).map(render);
    const previous = head + common - 1;
    if (previous >= 0) insertAfter(patch, nodes[previous], lines);
    else if (nodes.length) insertBefore(patch, nodes[0], lines);
    else appendChildren(patch, parent, lines);
  }
  for (let index = head + common; index < head + oldCount; index += 1) removeNode(patch, nodes[index]);
}

const LIGHT_ATTRS = ["IsElsControlled", "AllowEnvLight", "Color", "OffsetX", "OffsetY", "OffsetZ"];

function updateLight(patch, node, before, after, v8) {
  const values = {
    IsElsControlled: String(Boolean(after.controlled)),
    AllowEnvLight: String(Boolean(after.envLight)),
    Color: after.color || "red",
    OffsetX: formatOffset(after.offset[0]),
    OffsetY: formatOffset(after.offset[1]),
    OffsetZ: formatOffset(after.offset[2]),
  };
  const changed = {
    IsElsControlled: before.controlled !== after.controlled,
    AllowEnvLight: before.envLight !== after.envLight,
    Color: before.color !== after.color,
    OffsetX: !Object.is(before.offset[0], after.offset[0]),
    OffsetY: !Object.is(before.offset[1], after.offset[1]),
    OffsetZ: !Object.is(before.offset[2], after.offset[2]),
  };
  const hasOffset = after.offset.some((value) => value);
  for (const name of LIGHT_ATTRS) {
    const present = hasAttr(patch.source, node, name);
    // ELS V8 reads every attribute of a controlled extra; MISS-ELS only what is set.
    const needed = v8 ? after.controlled : name.startsWith("Offset") && hasOffset;
    if (!changed[name] && (present || !needed)) continue;
    if (!v8 && !present && (name === "IsElsControlled" || (name.startsWith("Offset") && !hasOffset))) continue;
    setAttr(patch, node, name, values[name]);
  }
  patchAttrs(patch, node, before.attrs, after.attrs);
}

function patchEoverride(patch, node, config) {
  const v8 = config.dialect === "els-v8";
  const entries = [];
  for (const child of node.children) {
    const light = parseLightElement(child, config.dialect);
    if (light) entries.push({ key: elsLightKey(light.kind, light.id), node: child, value: light });
  }
  const listed = new Map(entries.map((entry) => [entry.key, entry.value]));
  // ELS V8 lists extras whether or not it controls them. MISS-ELS lists the
  // lights it controls, so unchecking one removes its element; one the file
  // already marks uncontrolled stays as written.
  const items = config.lights
    .filter((light) => {
      const key = elsLightKey(light.kind, light.id);
      if (v8) return light.kind === "extra" || listed.has(key);
      return light.controlled || listed.get(key)?.controlled === false;
    })
    .map((light) => ({ key: elsLightKey(light.kind, light.id), value: light }));
  patchKeyed(patch, node, entries, items, {
    update: (child, before, after) => updateLight(patch, child, before, after, v8),
    render: (light) => (v8 ? v8LightLine(light) : missLightLine(light)),
  });
}

function patchV8Group(patch, node, key, before, after) {
  if (!before || !after) return;
  if (before.format !== after.format) setAttr(patch, node, "LightingFormat", after.format || "leds");
  if (key === "primary" && before.extrasAtStage2 !== after.extrasAtStage2) setAttr(patch, node, "ExtrasActiveAtLstg2", after.extrasAtStage2);
  if (before.disableAtStage3 !== after.disableAtStage3) {
    setAttr(patch, node, "DisableAtLstg3", after.disableAtStage3 == null ? null : String(Boolean(after.disableAtStage3)));
  }
  patchAttrs(patch, node, before.attrs, after.attrs);
  if (!sameModel(before.presets, after.presets)) {
    const holder = findChild(node, "PresetPatterns");
    if (!holder) {
      if ([1, 2, 3].some((stage) => after.presets?.[stage])) {
        const first = node.children[0];
        if (first) insertBefore(patch, first, [presetsBlock(after.presets)]);
        else insertInto(patch, node, [presetsBlock(after.presets)]);
      }
    } else {
      // The parser keeps the last <LstgN> of a stage; so does the patch.
      const byStage = new Map();
      for (const child of holder.children) {
        const match = /^lstg([123])$/i.exec(child.name);
        if (match) byStage.set(Number(match[1]), child);
      }
      const entries = [...byStage]
        .sort((a, b) => a[1].start - b[1].start)
        .map(([stage, child]) => ({ key: stage, node: child, value: before.presets[stage] }));
      const items = [1, 2, 3].filter((stage) => after.presets?.[stage]).map((stage) => ({ key: stage, value: after.presets[stage] }));
      patchKeyed(patch, holder, entries, items, {
        update: (child, was, now) => {
          if (was.enabled !== now.enabled) setAttr(patch, child, "Enabled", String(Boolean(now.enabled)));
          if (was.pattern !== now.pattern) setAttr(patch, child, "Pattern", now.pattern == null ? null : String(now.pattern));
        },
        render: presetLine,
      });
    }
  }
  if (after.scanPool && !sameModel(before.scanPool, after.scanPool)) {
    const pool = findChild(node, "ScanPatternCustomPool");
    if (!pool) {
      appendChildren(patch, node, [scanPoolBlock(after.scanPool)]);
    } else {
      const was = before.scanPool || { enabled: false, sequential: true, patterns: [] };
      if (was.enabled !== after.scanPool.enabled) setAttr(patch, pool, "Enabled", String(Boolean(after.scanPool.enabled)));
      if (was.sequential !== after.scanPool.sequential) setAttr(patch, pool, "Sequential", String(Boolean(after.scanPool.sequential)));
      const nodes = findChildren(pool, "Pattern").filter((child) => Number.isInteger(parsePatternValue(child.text)));
      patchIndexed(patch, pool, nodes, was.patterns, after.scanPool.patterns, {
        same: (a, b) => a === b,
        update: (child, _was, now) => setText(patch, child, String(now)),
        render: poolLine,
      });
    }
  }
}

function patchV8Misc(patch, node, before, after) {
  if (!before || !after) return;
  const bool = (value) => (value ? "true" : "false");
  const fields = [
    ["VehicleIsSlicktop", before.slicktop, after.slicktop, bool],
    ["ArrowboardType", before.arrowboard, after.arrowboard, (value) => value || "off"],
    ["UseSteadyBurnLights", before.steadyBurn, after.steadyBurn, bool],
    ["DfltSirenLtsActivateAtLstg", before.sirenLightsAtStage, after.sirenLightsAtStage, (value) => String(Math.max(0, Math.min(3, Math.round(value || 0))))],
  ];
  const added = [];
  for (const [name, was, now, text] of fields) {
    if (was === now) continue;
    const child = findChild(node, name);
    if (child) setText(patch, child, text(now));
    else added.push(`<${name}>${escapeText(text(now))}</${name}>`);
  }
  const flags = [
    ["Takedowns", [["AllowUse", "allow"], ["Mirrored", "mirrored"]], before.takedowns, after.takedowns],
    ["SceneLights", [["AllowUse", "allow"], ["IlluminateSidesOnly", "sidesOnly"]], before.sceneLights, after.sceneLights],
  ];
  for (const [name, attrs, was, now] of flags) {
    if (sameModel(was, now)) continue;
    const child = findChild(node, name);
    if (!child) {
      added.push(`<${name}${attrList(attrs.map(([attrName, field]) => [attrName, String(Boolean(now?.[field]))]))} />`);
      continue;
    }
    for (const [attrName, field] of attrs) {
      if (Boolean(was?.[field]) !== Boolean(now?.[field])) setAttr(patch, child, attrName, String(Boolean(now?.[field])));
    }
  }
  if (added.length) appendChildren(patch, node, added);
}

function patchV8Cruise(patch, node, before, after) {
  if (!before || !after) return;
  const added = [];
  if (before.disableAtStage3 !== after.disableAtStage3) {
    const child = findChild(node, "DisableAtLstg3");
    const text = after.disableAtStage3 ? "true" : "false";
    if (child) setText(patch, child, text);
    else added.push(`<DisableAtLstg3>${text}</DisableAtLstg3>`);
  }
  if (!sameModel(before.extras, after.extras)) {
    const use = findChild(node, "UseExtras");
    if (!use) {
      added.push(`<UseExtras${attrList([1, 2, 3, 4].map((id) => [`Extra${id}`, String(after.extras.includes(id))]))} />`);
    } else {
      for (const id of [1, 2, 3, 4]) {
        if (before.extras.includes(id) !== after.extras.includes(id)) setAttr(patch, use, `Extra${id}`, String(after.extras.includes(id)));
      }
    }
  }
  if (added.length) appendChildren(patch, node, added);
}

function patchMissStatics(patch, node, before, after) {
  // Keyed by light and occurrence, so a light listed twice keeps both entries.
  const keyed = (list) => {
    const seen = new Map();
    return list.map((entry) => {
      const light = elsLightKey(entry.kind, entry.id);
      const count = seen.get(light) || 0;
      seen.set(light, count + 1);
      return { key: `${light}#${count}`, value: entry };
    });
  };
  const nodes = node.children.filter((child) => /^(extra\d{1,2}|misc[a-z])$/i.test(child.name));
  const entries = keyed(before).map((item, index) => ({ ...item, node: nodes[index] }));
  patchKeyed(patch, node, entries, keyed(after), {
    update: (child, was, now) => {
      if (was.name !== now.name) setAttr(patch, child, "Name", now.name ? now.name : null);
    },
    render: staticLine,
  });
}

function patchMissPatterns(patch, node, before, after) {
  const listText = (list) => list.join(",");
  const sameFlash = (a, b) => Object.is(a.duration, b.duration) && listText(a.extras) === listText(b.extras) && listText(a.miscs) === listText(b.miscs);
  for (const key of MISS_PATTERN_KEYS) {
    const was = before[key];
    const now = after[key];
    if (!now || sameModel(was, now)) continue;
    const child = findChild(node, MISS_PATTERN_ELEMENTS[key]);
    if (!child || !was) {
      if (!child) appendChildren(patch, node, [missPatternBlock(key, now)]);
      continue;
    }
    const flags = [["IsEmergency", "isEmergency"], ["FlashHighBeam", "flashHighBeam"], ["EnableWarningBeep", "warningBeep"]];
    for (const [name, field] of flags) {
      if (was[field] !== now[field]) setAttr(patch, child, name, now[field] == null ? null : String(now[field]));
    }
    patchAttrs(patch, child, was.attrs, now.attrs);
    patchIndexed(patch, child, findChildren(child, "Flash"), was.flashes, now.flashes, {
      same: sameFlash,
      update: (flash, a, b) => {
        if (!Object.is(a.duration, b.duration)) setAttr(patch, flash, "Duration", String(Math.round(b.duration)));
        if (listText(a.extras) !== listText(b.extras)) setAttr(patch, flash, "Extras", b.extras.length ? listText(b.extras) : null);
        if (listText(a.miscs) !== listText(b.miscs)) setAttr(patch, flash, "Miscs", b.miscs.length ? listText(b.miscs) : null);
      },
      render: flashLine,
    });
  }
}

/**
 * Writes `config` over `originalText`. Untouched sections keep their bytes;
 * a changed section is edited in place (see the patch helpers above); a
 * missing one is added before </vcfroot>. Without `originalText` this is
 * createVcfText. The original's dialect decides what can be written:
 * converting a file between dialects is a new file, not an edit.
 */
export function serializeVcf(config, originalText = null) {
  if (originalText == null || originalText === "") return createVcfText(config);
  const hadBom = originalText.charCodeAt(0) === 0xfeff;
  const source = stripBom(originalText);
  const base = parseVcf(source);
  if (base.dialect !== config.dialect) {
    throw new VcfError(`This file is ${base.dialect === "els-v8" ? "an ELS V8" : "a MISS-ELS"} VCF; save the ${config.dialect === "els-v8" ? "ELS V8" : "MISS-ELS"} version as a new file.`);
  }
  const root = parseXml(source, { positions: true });
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const patch = new SourcePatch(source, eol, detectIndentUnit(source));
  const basePlan = new Map(sectionPlan(base).map((entry) => [entry.name, entry]));
  const insertions = [];
  for (const entry of sectionPlan(config)) {
    if (sameModel(entry.model(), basePlan.get(entry.name)?.model())) continue;
    const node = findChild(root, entry.name);
    if (node) {
      entry.patch(patch, node, base);
    } else {
      const lines = entry.write();
      if (lines) insertions.push(lines);
    }
  }
  if (base.description !== config.description) setAttr(patch, root, "Description", config.description || "");
  if (base.author !== config.author) setAttr(patch, root, "Author", config.author || "");
  patchAttrs(patch, root, base.rootAttrs, config.rootAttrs);
  if (insertions.length && startTag(source, root).selfClosing) {
    insertInto(patch, root, insertions);
  } else if (insertions.length) {
    const close = closeTagStart(source, root);
    const first = root.children[0];
    const childIndent = (first && lineIndent(source, first.start)) || patch.unit;
    const text = insertions.map((lines) => renderNode(lines, childIndent, patch.unit, eol)).join(eol) + eol;
    // At the start of the closing tag's line, or on a new line before it.
    const lineStart = source.lastIndexOf("\n", close - 1) + 1;
    const onOwnLine = /^[ \t]*$/.test(source.slice(lineStart, close));
    if (onOwnLine) patch.insert(lineStart, text);
    else patch.insert(close, eol + text);
  }
  return (hadBom ? "﻿" : "") + patch.apply();
}

// ---------------------------------------------------------------------------
// Editing helpers

export function cloneVcf(config) {
  return config ? JSON.parse(JSON.stringify(config)) : config;
}

/** The light entry for `kind`/`id`, creating a default one when absent. */
export function ensureLight(config, kind, id) {
  let light = config.lights.find((entry) => entry.kind === kind && entry.id === id);
  if (!light) {
    light = { kind, id, controlled: false, envLight: false, color: "red", offset: [0, 0, 0], attrs: {} };
    config.lights.push(light);
    config.lights.sort(compareLights);
  }
  return light;
}

/** Controlled extras and miscs, as light keys. */
export function controlledLightKeys(config) {
  return (config?.lights || []).filter((light) => light.controlled).map((light) => elsLightKey(light.kind, light.id));
}

// ---------------------------------------------------------------------------
// Unsaved changes

function lightName(light) {
  return light.kind === "misc" ? `Misc ${String(light.id).toUpperCase()}` : `Extra ${light.id}`;
}

const V8_GROUP_FIELD_LABELS = Object.freeze({
  format: "format",
  extrasAtStage2: "stage 2 extras",
  disableAtStage3: "off at stage 3",
});
const V8_MISC_FIELD_LABELS = Object.freeze({
  slicktop: "slicktop",
  arrowboard: "arrowboard",
  steadyBurn: "steady burn",
  sirenLightsAtStage: "carcols sirens at stage",
  "takedowns.allow": "takedowns",
  "takedowns.mirrored": "mirrored takedowns",
  "sceneLights.allow": "scene lights",
  "sceneLights.sidesOnly": "scene lights sides only",
});
const MISS_PATTERN_FIELD_LABELS = Object.freeze({
  isEmergency: "emergency",
  flashHighBeam: "flash high beam",
  warningBeep: "warning beep",
});

function v8GroupFieldLabel(path) {
  if (V8_GROUP_FIELD_LABELS[path]) return V8_GROUP_FIELD_LABELS[path];
  const preset = /^presets\.([123])(?:\.(\w+))?$/.exec(path);
  if (preset) return preset[2] === "pattern" ? `stage ${preset[1]} pattern` : `stage ${preset[1]}`;
  if (path.startsWith("scanPool")) return "scan pool";
  return null;
}

function flashChanges(before = [], after = []) {
  if (before.length !== after.length) return `flashes ${before.length} → ${after.length}`;
  const changed = after.map((flash, index) => (JSON.stringify(flash) !== JSON.stringify(before[index]) ? index + 1 : 0)).filter(Boolean);
  if (!changed.length) return "";
  return `${changed.length === 1 ? "flash" : "flashes"} ${compactNumbers(changed)}`;
}

// "Primary: added" or the fields that changed in one section.
function sectionLine(title, before, after, describe) {
  if (!before && !after) return null;
  if (!before) return `${title}: added`;
  if (!after) return `${title}: removed`;
  const text = describe(before, after);
  return text ? `${title}: ${text}` : null;
}

/**
 * What a VCF draft changes against `base`, the file it was read from, as
 * short lines for the dock. A new VCF (no base) says it has no file yet.
 */
export function describeVcfChanges(base, draft) {
  if (!draft) return [];
  const v8 = draft.dialect === "els-v8";
  const lights = draft.lights || [];
  if (!base) {
    const counted = v8 ? lights.filter((light) => light.controlled).length : lights.length;
    return [
      `New ${v8 ? "ELS V8" : "MISS-ELS"} VCF, not saved to a file yet.`,
      `${counted} ${counted === 1 ? "light" : "lights"} ${v8 ? "under ELS control" : "listed"}`,
    ];
  }
  const lines = [];
  for (const [key, label] of [["description", "Description"], ["author", "Author"]]) {
    if ((base[key] ?? "") !== (draft[key] ?? "")) lines.push(`${label} ${formatChangeValue(base[key])} → ${formatChangeValue(draft[key])}`);
  }

  const before = new Map((base.lights || []).map((light) => [elsLightKey(light.kind, light.id), light]));
  const after = new Map(lights.map((light) => [elsLightKey(light.kind, light.id), light]));
  const added = lights.filter((light) => !before.has(elsLightKey(light.kind, light.id)));
  const removed = (base.lights || []).filter((light) => !after.has(elsLightKey(light.kind, light.id)));
  if (added.length) lines.push(`Added ${added.map(lightName).join(", ")}`);
  if (removed.length) lines.push(`Removed ${removed.map(lightName).join(", ")}`);
  const lightLabels = { controlled: v8 ? "ELS control" : "listed", envLight: "environment light", color: "colour", offset: "offset" };
  const byChange = new Map();
  for (const light of lights) {
    const old = before.get(elsLightKey(light.kind, light.id));
    if (!old) continue;
    const text = describeFields(leafChanges(old, light, { skip: ["attrs", "kind", "id"] }), (path) => lightLabels[path] || null);
    if (!text) continue;
    if (!byChange.has(text)) byChange.set(text, []);
    byChange.get(text).push(lightName(light));
  }
  for (const [text, names] of byChange) lines.push(`${names.join(", ")}: ${text}`);

  if (v8) {
    const skip = ["attrs", "extraXml", "forcedXml"];
    for (const key of ELS_V8_GROUP_KEYS) {
      lines.push(sectionLine(ELS_V8_GROUPS[key].label, base.v8?.[key], draft.v8?.[key], (a, b) => describeFields(leafChanges(a, b, { skip }), v8GroupFieldLabel)));
    }
    lines.push(sectionLine("Misc", base.v8?.misc, draft.v8?.misc, (a, b) => describeFields(leafChanges(a, b, { skip }), (path) => V8_MISC_FIELD_LABELS[path] || null)));
    lines.push(sectionLine("Cruise", base.v8?.cruise, draft.v8?.cruise, (a, b) => describeFields(leafChanges(a, b, { skip }), (path) => ({ disableAtStage3: "off at stage 3", extras: "extras" })[path] || null)));
  } else {
    for (const key of MISS_PATTERN_KEYS) {
      lines.push(sectionLine(MISS_PATTERN_LABELS[key], base.miss?.patterns?.[key], draft.miss?.patterns?.[key], (a, b) => {
        const fields = describeFields(leafChanges(a, b, { skip: ["attrs", "flashes"] }), (path) => MISS_PATTERN_FIELD_LABELS[path] || null);
        return [fields, flashChanges(a.flashes, b.flashes)].filter(Boolean).join(", ");
      }));
    }
    const statics = (config) => new Map((config?.miss?.statics || []).map((entry) => [elsLightKey(entry.kind, entry.id), entry]));
    const was = statics(base);
    const now = statics(draft);
    const staticNames = (entries) => entries.map(lightName).join(", ");
    const staticAdded = [...now.values()].filter((entry) => !was.has(elsLightKey(entry.kind, entry.id)));
    const staticRemoved = [...was.values()].filter((entry) => !now.has(elsLightKey(entry.kind, entry.id)));
    const renamed = [...now.values()].filter((entry) => {
      const old = was.get(elsLightKey(entry.kind, entry.id));
      return old && (old.name || "") !== (entry.name || "");
    });
    if (staticAdded.length) lines.push(`Statics: added ${staticNames(staticAdded)}`);
    if (staticRemoved.length) lines.push(`Statics: removed ${staticNames(staticRemoved)}`);
    if (renamed.length) lines.push(`Statics: renamed ${staticNames(renamed)}`);
  }
  return lines.filter(Boolean);
}

function issue(level, message, key = null) {
  return { level, message, key };
}

/**
 * Problems that would stop the lights working in game or change what they
 * do. `modelExtras` (extra numbers on the loaded model) adds model checks.
 * Returns [{ level: "error" | "warning", message, key }].
 */
export function checkVcf(config, { modelExtras = null } = {}) {
  const issues = [];
  if (!config) return issues;
  const extras = Array.isArray(modelExtras) ? new Set(modelExtras) : null;
  for (const light of config.lights) {
    const label = light.kind === "misc" ? `Misc ${String(light.id).toUpperCase()}` : `Extra ${light.id}`;
    if (!COLOR_IDS.has(light.color) && light.envLight) issues.push(issue("error", `${label}: "${light.color}" is not an ELS colour (red, blue, amber, white, green).`, elsLightKey(light.kind, light.id)));
    if (light.offset.some((value) => !Number.isFinite(value) || Math.abs(value) > 10)) issues.push(issue("warning", `${label}: environment light offset is more than 10 m from the light.`, elsLightKey(light.kind, light.id)));
    if (config.dialect === "els-v8" && light.kind === "misc") issues.push(issue("error", `${label}: ELS V8 controls extras only.`, elsLightKey(light.kind, light.id)));
    if (extras && light.kind === "extra" && light.controlled && !extras.has(light.id)) issues.push(issue("warning", `${label} is ELS-controlled but the model has no extra_${light.id}.`, elsLightKey(light.kind, light.id)));
  }
  if (config.dialect === "els-v8") {
    const v8 = config.v8 || {};
    for (const key of ELS_V8_GROUP_KEYS) {
      const group = v8[key];
      const label = ELS_V8_GROUPS[key].label;
      if (!group) {
        issues.push(issue("error", `${label} lights (${ELS_V8_GROUPS[key].element}) section is missing.`));
        continue;
      }
      if (!ELS_V8_FORMATS[key].includes(group.format)) issues.push(issue("warning", `${label}: lighting format "${group.format}" is not one ELS V8 uses for this group.`));
      for (const stage of [1, 2, 3]) {
        const preset = group.presets?.[stage];
        if (!preset?.enabled) continue;
        if (preset.pattern == null) issues.push(issue("warning", `${label}, stage ${stage}: the preset is on but names no pattern.`));
        else if (preset.pattern !== "scan" && !Number.isInteger(preset.pattern)) {
          issues.push(issue("error", `${label}, stage ${stage}: pattern "${preset.pattern}" is not a number or "scan".`));
        }
      }
      const controlled = ELS_V8_GROUPS[key].extras.filter((id) => config.lights.some((light) => light.kind === "extra" && light.id === id && light.controlled));
      const used = [1, 2, 3].some((stage) => group.presets?.[stage]?.enabled);
      if (used && !controlled.length) issues.push(issue("warning", `${label} has patterns but none of extras ${ELS_V8_GROUPS[key].extras.join(", ")} is ELS-controlled.`));
    }
    if (v8.primary?.extrasAtStage2 && !ELS_STAGE2_EXTRAS.includes(String(v8.primary.extrasAtStage2).toLowerCase())) {
      issues.push(issue("warning", `Primary: stage 2 extras "${v8.primary.extrasAtStage2}" is not a value ELS reads; it falls back to 1 and 4.`));
    }
    if (v8.warning?.disableAtStage3 === true) {
      issues.push(issue("warning", "Warning: Off at stage 3 is on, and warning lights run only at stage 3, so they never light."));
    }
    if (!v8.misc) issues.push(issue("warning", "MISC section is missing; ELS uses its defaults."));
  } else {
    const miss = config.miss || { patterns: {}, statics: [] };
    const listed = new Set(controlledLightKeys(config));
    for (const key of MISS_PATTERN_KEYS) {
      const pattern = miss.patterns[key];
      const label = MISS_PATTERN_LABELS[key];
      if (!pattern) continue;
      if (pattern.flashes.length > MISS_MAX_FLASHES) issues.push(issue("error", `${label}: ${pattern.flashes.length} flashes; keep it under ${MISS_MAX_FLASHES}.`));
      let total = 0;
      pattern.flashes.forEach((flash, index) => {
        if (!Number.isFinite(flash.duration) || flash.duration <= 0) issues.push(issue("error", `${label}, flash ${index + 1}: duration must be more than 0 ms.`));
        else total += flash.duration;
        for (const id of flash.extras) if (!listed.has(elsLightKey("extra", id))) issues.push(issue("warning", `${label}, flash ${index + 1}: extra ${id} is not in EOVERRIDE, so MISS-ELS will not switch it.`, elsLightKey("extra", id)));
        for (const id of flash.miscs) if (!listed.has(elsLightKey("misc", id))) issues.push(issue("warning", `${label}, flash ${index + 1}: misc ${String(id).toUpperCase()} is not in EOVERRIDE, so MISS-ELS will not switch it.`, elsLightKey("misc", id)));
      });
      if (pattern.flashes.length && total < 30) issues.push(issue("warning", `${label}: the whole pattern lasts ${total} ms; MISS-ELS ticks every frame, so it will blur.`));
    }
    for (const entry of miss.statics) {
      if (!listed.has(elsLightKey(entry.kind, entry.id))) issues.push(issue("warning", `Static ${entry.kind === "misc" ? `misc ${String(entry.id).toUpperCase()}` : `extra ${entry.id}`} must also be listed in EOVERRIDE.`, elsLightKey(entry.kind, entry.id)));
    }
    if (config.lights.some((light) => light.kind === "misc" && light.controlled)) {
      issues.push(issue("warning", "Misc lights need the vehicle to use the MISS-ELS mod kit (miss_els_modkit); Cortex does not preview miscs."));
    }
  }
  return issues;
}
