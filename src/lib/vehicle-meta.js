// Reads GTA V / FiveM vehicle meta files (vehicles.meta, carvariations.meta,
// carcols.meta, handling.meta) and simulates what the game would do for one model: which
// livery system applies, which texture names the YTD must contain, colour
// presets, extras flags, and id conflicts. Pure and deterministic; the caller
// reads files and passes `{ path, text }` pairs.

import {
  attrValue,
  boolValue,
  childText,
  findChild,
  findChildren,
  numberValue,
  parseCharArray,
  parseXml,
} from "./xml-lite.js";
import {
  DEFAULT_PAINT_FINISH,
  GTA_VEHICLE_COLOR_MAX_INDEX,
  UNKNOWN_COLOR_HEX,
  gameColorToHex,
  getVehicleColor,
  parseMetallicId,
} from "./data/gta-vehicle-colors.js";

export const META_ROOTS = Object.freeze({
  CVehicleModelInfo__InitDataList: "vehicles",
  CVehicleModelInfoVariation: "carvariations",
  CVehicleModelInfoVarGlobal: "carcols",
  CHandlingDataMgr: "handling",
});

export const META_FILE_SUFFIXES = Object.freeze([
  "vehicles.meta",
  "carvariations.meta",
  "carcols.meta",
  "handling.meta",
]);

// Vanilla siren settings ids. The SirenSetting Limit Adjuster plugin raises it.
export const VANILLA_SIREN_ID_MAX = 255;
// Sirens per setting the game drives; siren21-32 need the limit adjuster.
export const VANILLA_SIREN_COUNT = 20;
// Base game mod kit ids live below this; addon kits should use higher ids.
export const VANILLA_KIT_ID_CEILING = 1000;
export const DEFAULT_MODKIT_NAME = "0_default_modkit";

const COLOR_SLOT_KEYS = ["primary", "secondary", "pearlescent", "wheels", "interior", "dashboard"];

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function lower(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function textOrEmpty(node, name) {
  return childText(node, name, "").trim();
}

function textList(node, name) {
  const list = findChild(node, name);
  if (!list) return [];
  return findChildren(list, "Item")
    .map((item) => item.text.trim())
    .filter(Boolean);
}

function splitFlags(flagText) {
  if (!flagText) return [];
  return flagText
    .split(/\s+/)
    .map((flag) => flag.trim())
    .filter(Boolean);
}

function intOrNull(node) {
  const value = numberValue(node, Number.NaN);
  return Number.isFinite(value) ? Math.trunc(value) : null;
}

function numberOrNull(node) {
  const value = numberValue(node, Number.NaN);
  return Number.isFinite(value) ? value : null;
}

function rootKind(root) {
  if (!root) return "unknown";
  return META_ROOTS[root.name] || "unknown";
}

function baseName(path) {
  if (typeof path !== "string") return "";
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

function parseHexColor(raw) {
  if (raw == null) return null;
  const text = String(raw).trim();
  const match = /^(?:0x)?([0-9a-f]{6,8})$/i.exec(text);
  if (!match) return null;
  const digits = match[1];
  // Base carcols stores 0xAARRGGBB or 0xRRGGBB. Keep the low 24 bits.
  return `#${digits.slice(-6).toLowerCase()}`;
}

function expectRoot(root, expectedName, sourcePath) {
  if (!root || root.name !== expectedName) {
    const found = root ? root.name : "nothing";
    throw new Error(
      `${sourcePath || "meta"}: expected <${expectedName}> root element, found <${found}>`,
    );
  }
}

// ---------------------------------------------------------------------------
// vehicles.meta
// ---------------------------------------------------------------------------

function extrasFlagsFromList(flags) {
  const out = {};
  for (const flag of flags) {
    if (flag.startsWith("FLAG_EXTRAS_")) {
      out[flag.slice("FLAG_EXTRAS_".length).toLowerCase()] = true;
    }
  }
  return out;
}

function liveryFlagsFromList(flags) {
  const set = new Set(flags);
  const out = {
    hasLivery: set.has("FLAG_HAS_LIVERY"),
    liveryMatchExtra: set.has("FLAG_LIVERY_MATCH_EXTRA"),
  };
  if (set.has("FLAG_HAS_LIVERY2")) out.hasLivery2 = true;
  return out;
}

// The roof clip a convertible plays; the game writes "null" for hardtops.
function convertibleRoofFromItem(item) {
  const dict = textOrEmpty(item, "animConvRoofDictName").trim();
  const clip = textOrEmpty(item, "animConvRoofName").trim();
  if (!dict || !clip || lower(dict) === "null" || lower(clip) === "null") return null;
  return { dict: lower(dict), clip: lower(clip) };
}

function vehiclesFromRoot(root, sourcePath) {
  expectRoot(root, "CVehicleModelInfo__InitDataList", sourcePath);
  const vehicles = [];
  const initDatas = findChild(root, "InitDatas");
  for (const item of findChildren(initDatas, "Item")) {
    const flags = splitFlags(textOrEmpty(item, "flags"));
    vehicles.push({
      modelName: textOrEmpty(item, "modelName"),
      txdName: textOrEmpty(item, "txdName"),
      handlingId: textOrEmpty(item, "handlingId"),
      gameName: textOrEmpty(item, "gameName"),
      vehicleMakeName: textOrEmpty(item, "vehicleMakeName"),
      layout: textOrEmpty(item, "layout"),
      type: textOrEmpty(item, "type"),
      vehicleClass: textOrEmpty(item, "vehicleClass"),
      plateType: textOrEmpty(item, "plateType"),
      dashboardType: textOrEmpty(item, "dashboardType"),
      wheelType: textOrEmpty(item, "wheelType"),
      flags,
      liveryFlags: liveryFlagsFromList(flags),
      extrasFlags: extrasFlagsFromList(flags),
      convertibleRoof: convertibleRoofFromItem(item),
      sourcePath: sourcePath || "",
    });
  }

  const txdRelationships = [];
  const relationships = findChild(root, "txdRelationships");
  for (const item of findChildren(relationships, "Item")) {
    const parent = textOrEmpty(item, "parent");
    const child = textOrEmpty(item, "child");
    if (parent || child) txdRelationships.push({ parent, child });
  }

  return {
    vehicles,
    txdRelationships,
    residentTxd: textOrEmpty(root, "residentTxd"),
  };
}

export function parseVehiclesMeta(xmlText, sourcePath = "") {
  return vehiclesFromRoot(parseXml(xmlText), sourcePath);
}

function handlingFromRoot(root, sourcePath) {
  expectRoot(root, "CHandlingDataMgr", sourcePath);
  const handling = [];
  for (const item of findChildren(findChild(root, "HandlingData"), "Item")) {
    const handlingName = textOrEmpty(item, "handlingName");
    if (!handlingName) continue;
    // fSteeringLock is the maximum front wheel angle in degrees.
    const lock = numberOrNull(findChild(item, "fSteeringLock"));
    handling.push({
      handlingName,
      steeringLock: lock !== null && lock > 0 && lock <= 90 ? lock : null,
      sourcePath: sourcePath || "",
    });
  }
  return { handling };
}

export function parseHandlingMeta(xmlText, sourcePath = "") {
  return handlingFromRoot(parseXml(xmlText), sourcePath);
}

// ---------------------------------------------------------------------------
// carvariations.meta
// ---------------------------------------------------------------------------

function parseColorItem(item, sourcePath) {
  const indicesNode = findChild(item, "indices");
  let indices = [];
  if (indicesNode) {
    try {
      indices = parseCharArray(indicesNode.text);
    } catch (error) {
      throw new Error(`${sourcePath || "carvariations"}: ${error.message}`);
    }
  }
  const liveriesNode = findChild(item, "liveries");
  const liveries = findChildren(liveriesNode, "Item").map((entry) => boolValue(entry, false));
  return { indices, liveries };
}

function parsePlateProbabilities(item) {
  const container = findChild(item, "plateProbabilities");
  if (!container) return [];
  // Both <plateProbabilities><Probabilities><Item/> and a flat <Item/> list occur in the wild.
  const list = findChild(container, "Probabilities") || container;
  return findChildren(list, "Item").map((entry) => ({
    name: textOrEmpty(entry, "Name"),
    value: numberOrNull(findChild(entry, "Value")),
  }));
}

function variationsFromRoot(root, sourcePath) {
  expectRoot(root, "CVehicleModelInfoVariation", sourcePath);
  const variations = [];
  const data = findChild(root, "variationData");
  for (const item of findChildren(data, "Item")) {
    const colorsNode = findChild(item, "colors");
    const colors = findChildren(colorsNode, "Item").map((entry) => parseColorItem(entry, sourcePath));
    variations.push({
      modelName: textOrEmpty(item, "modelName"),
      colors,
      kits: textList(item, "kits"),
      windowsWithExposedEdges: textList(item, "windowsWithExposedEdges"),
      plateProbabilities: parsePlateProbabilities(item),
      lightSettings: intOrNull(findChild(item, "lightSettings")),
      sirenSettings: intOrNull(findChild(item, "sirenSettings")),
      sourcePath: sourcePath || "",
    });
  }
  return { variations };
}

export function parseCarvariationsMeta(xmlText, sourcePath = "") {
  return variationsFromRoot(parseXml(xmlText), sourcePath);
}

// ---------------------------------------------------------------------------
// carcols.meta
// ---------------------------------------------------------------------------

function parseVisibleMod(item) {
  return {
    modelName: textOrEmpty(item, "modelName"),
    modShopLabel: textOrEmpty(item, "modShopLabel"),
    linkedModels: textList(item, "linkedModels"),
    turnOffBones: textList(item, "turnOffBones"),
    type: textOrEmpty(item, "type"),
    bone: textOrEmpty(item, "bone"),
    collisionBone: textOrEmpty(item, "collisionBone"),
    cameraPos: textOrEmpty(item, "cameraPos"),
    audioApply: numberOrNull(findChild(item, "audioApply")),
    weight: numberOrNull(findChild(item, "weight")),
    turnOffExtra: boolValue(findChild(item, "turnOffExtra"), false),
    disableBonnetCamera: boolValue(findChild(item, "disableBonnetCamera"), false),
    allowBonnetSlide: boolValue(findChild(item, "allowBonnetSlide"), false),
  };
}

function parseStatMod(item) {
  return {
    identifier: textOrEmpty(item, "identifier"),
    modifier: numberOrNull(findChild(item, "modifier")),
    audioApply: numberOrNull(findChild(item, "audioApply")),
    weight: numberOrNull(findChild(item, "weight")),
    type: textOrEmpty(item, "type"),
  };
}

function parseKit(item, sourcePath) {
  return {
    kitName: textOrEmpty(item, "kitName"),
    id: intOrNull(findChild(item, "id")),
    kitType: textOrEmpty(item, "kitType"),
    visibleMods: findChildren(findChild(item, "visibleMods"), "Item").map(parseVisibleMod),
    linkMods: findChildren(findChild(item, "linkMods"), "Item").map(parseVisibleMod),
    statMods: findChildren(findChild(item, "statMods"), "Item").map(parseStatMod),
    slotNames: findChildren(findChild(item, "slotNames"), "Item")
      .map((entry) => ({ slot: textOrEmpty(entry, "slot"), name: textOrEmpty(entry, "name") }))
      .filter((entry) => entry.slot && entry.name),
    liveryNames: textList(item, "liveryNames"),
    sourcePath: sourcePath || "",
  };
}

function parseLight(item, sourcePath) {
  const light = { id: intOrNull(findChild(item, "id")), sourcePath: sourcePath || "" };
  for (const child of item.children) {
    if (child.name === "id") continue;
    light[child.name] = {
      intensity: numberOrNull(findChild(child, "intensity")),
      falloffMax: numberOrNull(findChild(child, "falloffMax")),
      falloffExponent: numberOrNull(findChild(child, "falloffExponent")),
      innerConeAngle: numberOrNull(findChild(child, "innerConeAngle")),
      outerConeAngle: numberOrNull(findChild(child, "outerConeAngle")),
      color: parseHexColor(attrValue(findChild(child, "color"), "value")),
    };
  }
  return light;
}

// 32-bit sequencer, or null when the value is missing or out of range.
function sequencerOrNull(node) {
  const value = numberValue(node, Number.NaN);
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff ? value : null;
}

function parseSirenChannel(node) {
  return {
    delta: numberOrNull(findChild(node, "delta")),
    start: numberOrNull(findChild(node, "start")),
    speed: numberOrNull(findChild(node, "speed")),
    sequencer: sequencerOrNull(findChild(node, "sequencer")),
    multiples: intOrNull(findChild(node, "multiples")),
    direction: boolValue(findChild(node, "direction"), true),
    syncToBpm: boolValue(findChild(node, "syncToBpm"), true),
  };
}

// Tags the siren editor models. Anything else inside a siren setting or a
// siren light is kept verbatim (see extraXml) so a save does not drop it.
export const SIREN_SETTING_TAGS = Object.freeze([
  "id", "name", "timeMultiplier", "lightFalloffMax", "lightFalloffExponent", "lightInnerConeAngle",
  "lightOuterConeAngle", "lightOffset", "textureName", "sequencerBpm", "leftHeadLight", "rightHeadLight",
  "leftTailLight", "rightTailLight", "leftHeadLightMultiples", "rightHeadLightMultiples",
  "leftTailLightMultiples", "rightTailLightMultiples", "useRealLights", "sirens",
]);
export const SIREN_LIGHT_TAGS = Object.freeze([
  "rotation", "flashiness", "corona", "color", "intensity", "lightGroup", "rotate", "scale", "scaleFactor",
  "flash", "light", "spotLight", "castShadows",
]);

// Raw source of child elements outside `known`, when the tree carries offsets.
function unknownChildXml(item, known, sourceText) {
  if (typeof sourceText !== "string" || !item) return [];
  const names = new Set(known.map((name) => name.toLowerCase()));
  return item.children
    .filter((child) => !names.has(child.name.toLowerCase()) && Number.isInteger(child.start) && Number.isInteger(child.end))
    .map((child) => sourceText.slice(child.start, child.end));
}

function parseSirenLight(item, sourceText) {
  const corona = findChild(item, "corona");
  const rawColor = attrValue(findChild(item, "color"), "value");
  // carcols siren colours are 0xAARRGGBB.
  const argb = /^(?:0x)?([0-9a-f]{8})$/i.exec(String(rawColor ?? "").trim());
  return {
    rotation: parseSirenChannel(findChild(item, "rotation")),
    flashiness: parseSirenChannel(findChild(item, "flashiness")),
    corona: {
      intensity: numberOrNull(findChild(corona, "intensity")),
      size: numberOrNull(findChild(corona, "size")),
      pull: numberOrNull(findChild(corona, "pull")),
      faceCamera: boolValue(findChild(corona, "faceCamera"), false),
    },
    color: parseHexColor(rawColor),
    alpha: argb ? parseInt(argb[1].slice(0, 2), 16) / 255 : 1,
    intensity: numberOrNull(findChild(item, "intensity")),
    lightGroup: intOrNull(findChild(item, "lightGroup")),
    rotate: boolValue(findChild(item, "rotate"), false),
    scale: boolValue(findChild(item, "scale"), false),
    scaleFactor: numberOrNull(findChild(item, "scaleFactor")),
    flash: boolValue(findChild(item, "flash"), false),
    light: boolValue(findChild(item, "light"), false),
    spotLight: boolValue(findChild(item, "spotLight"), false),
    castShadows: boolValue(findChild(item, "castShadows"), false),
    extraXml: unknownChildXml(item, SIREN_LIGHT_TAGS, sourceText),
  };
}

function parseSirenLamps(item) {
  const lamps = {};
  for (const key of ["leftHeadLight", "rightHeadLight", "leftTailLight", "rightTailLight"]) {
    const node = findChild(item, key);
    if (!node) continue;
    lamps[key] = {
      sequencer: sequencerOrNull(findChild(node, "sequencer")),
      multiples: intOrNull(findChild(item, `${key}Multiples`)),
    };
  }
  return lamps;
}

function parseSiren(item, sourcePath, sourceText) {
  const sirens = findChildren(findChild(item, "sirens"), "Item");
  return {
    id: intOrNull(findChild(item, "id")),
    name: textOrEmpty(item, "name"),
    timeMultiplier: numberOrNull(findChild(item, "timeMultiplier")),
    lightFalloffMax: numberOrNull(findChild(item, "lightFalloffMax")),
    lightFalloffExponent: numberOrNull(findChild(item, "lightFalloffExponent")),
    lightInnerConeAngle: numberOrNull(findChild(item, "lightInnerConeAngle")),
    lightOuterConeAngle: numberOrNull(findChild(item, "lightOuterConeAngle")),
    lightOffset: numberOrNull(findChild(item, "lightOffset")),
    textureName: textOrEmpty(item, "textureName"),
    sequencerBpm: numberOrNull(findChild(item, "sequencerBpm")),
    useRealLights: boolValue(findChild(item, "useRealLights"), true),
    lamps: parseSirenLamps(item),
    sirens: sirens.map((light) => parseSirenLight(light, sourceText)),
    sirenCount: sirens.length,
    extraXml: unknownChildXml(item, SIREN_SETTING_TAGS, sourceText),
    sourcePath: sourcePath || "",
  };
}

function parseColorEntry(item, index) {
  return {
    index,
    color: parseHexColor(attrValue(findChild(item, "color"), "value")) || UNKNOWN_COLOR_HEX,
    metallicID: textOrEmpty(item, "metallicID") || attrValue(findChild(item, "metallicID"), "value", ""),
    audioColor: textOrEmpty(item, "audioColor"),
    audioPrefix: textOrEmpty(item, "audioPrefix"),
    audioColorHash: textOrEmpty(item, "audioColorHash") || attrValue(findChild(item, "audioColorHash"), "value", ""),
    name: textOrEmpty(item, "name") || undefined,
  };
}

function carcolsFromRoot(root, sourcePath, sourceText) {
  expectRoot(root, "CVehicleModelInfoVarGlobal", sourcePath);
  return {
    kits: findChildren(findChild(root, "Kits"), "Item").map((item) => parseKit(item, sourcePath)),
    lights: findChildren(findChild(root, "Lights"), "Item").map((item) => parseLight(item, sourcePath)),
    sirens: findChildren(findChild(root, "Sirens"), "Item").map((item) => parseSiren(item, sourcePath, sourceText)),
    colors: findChildren(findChild(root, "Colors"), "Item").map(parseColorEntry),
    sourcePath: sourcePath || "",
  };
}

// The text offsets from parseXml({ positions }) are relative to the source
// without its BOM.
function stripBom(text) {
  return typeof text === "string" && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function parseCarcolsMeta(xmlText, sourcePath = "") {
  return carcolsFromRoot(parseXml(xmlText, { positions: true }), sourcePath, stripBom(xmlText));
}

// ---------------------------------------------------------------------------
// Resource folder aggregation
// ---------------------------------------------------------------------------

export function classifyMetaPath(path) {
  const name = lower(baseName(path));
  if (!name) return null;
  for (const suffix of META_FILE_SUFFIXES) {
    if (name === suffix || name.endsWith(`_${suffix}`) || name.endsWith(`-${suffix}`) || name.endsWith(`.${suffix}`)) {
      return suffix.replace(/\.meta$/, "");
    }
  }
  // Prefixed names without a separator (e.g. "policecarcols.meta") are rare
  // but FiveM loads them fine; accept a plain suffix match too.
  for (const suffix of META_FILE_SUFFIXES) {
    if (name.endsWith(suffix)) return suffix.replace(/\.meta$/, "");
  }
  return null;
}

/** Filters a path list to vehicle meta files by filename (case-insensitive). */
export function findMetaFilesForModel(paths) {
  if (!Array.isArray(paths)) return [];
  return paths.filter((path) => classifyMetaPath(path) != null);
}

export function createEmptyResourceMeta() {
  return {
    vehicles: [],
    txdRelationships: [],
    residentTxds: [],
    variations: [],
    kits: [],
    lights: [],
    sirens: [],
    colors: [],
    handling: [],
    sources: [],
    errors: [],
  };
}

/**
 * Parses already-read files and merges them by root element (not filename).
 * Unparseable files are reported in `errors`; the rest still load.
 */
export function loadResourceMeta(files) {
  const meta = createEmptyResourceMeta();
  if (!Array.isArray(files)) return meta;

  for (const file of files) {
    const path = file && typeof file.path === "string" ? file.path : "";
    const text = file ? file.text : null;
    if (typeof text !== "string") {
      meta.errors.push({ path, message: "file content is not text" });
      continue;
    }
    let root;
    try {
      root = parseXml(text, { positions: true });
    } catch (error) {
      meta.errors.push({ path, message: error.message });
      continue;
    }
    const kind = rootKind(root);
    meta.sources.push({ path, kind });
    try {
      if (kind === "vehicles") {
        const parsed = vehiclesFromRoot(root, path);
        meta.vehicles.push(...parsed.vehicles);
        meta.txdRelationships.push(...parsed.txdRelationships);
        if (parsed.residentTxd) meta.residentTxds.push(parsed.residentTxd);
      } else if (kind === "carvariations") {
        meta.variations.push(...variationsFromRoot(root, path).variations);
      } else if (kind === "carcols") {
        const parsed = carcolsFromRoot(root, path, stripBom(text));
        meta.kits.push(...parsed.kits);
        meta.lights.push(...parsed.lights);
        meta.sirens.push(...parsed.sirens);
        meta.colors.push(...parsed.colors);
      } else if (kind === "handling") {
        meta.handling.push(...handlingFromRoot(root, path).handling);
      }
    } catch (error) {
      meta.errors.push({ path, message: error.message });
    }
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Id scanning
// ---------------------------------------------------------------------------

function groupById(entries, nameKey) {
  const byId = new Map();
  for (const entry of entries) {
    if (entry.id == null) continue;
    const list = byId.get(entry.id) || [];
    list.push({ name: entry[nameKey] || "", sourcePath: entry.sourcePath || "" });
    byId.set(entry.id, list);
  }
  return byId;
}

function conflictsFrom(kind, byId) {
  const conflicts = [];
  for (const [id, entries] of byId) {
    if (entries.length > 1) conflicts.push({ kind, id, entries });
  }
  return conflicts.sort((a, b) => a.id - b.id);
}

/** Collects every kit/siren/light id in the resource plus conflicts and range issues. */
export function scanResourceForIds(resourceMeta) {
  const meta = resourceMeta || createEmptyResourceMeta();
  const kitsById = groupById(meta.kits, "kitName");
  const sirensById = groupById(meta.sirens, "name");
  const lightsById = groupById(meta.lights, "id");

  const outOfRange = [];
  for (const siren of meta.sirens) {
    if (siren.id != null && (siren.id < 0 || siren.id > VANILLA_SIREN_ID_MAX)) {
      outOfRange.push({ kind: "siren", id: siren.id, name: siren.name, sourcePath: siren.sourcePath });
    }
  }

  return {
    kits: meta.kits.map((kit) => ({ id: kit.id, name: kit.kitName, sourcePath: kit.sourcePath })),
    sirens: meta.sirens.map((siren) => ({ id: siren.id, name: siren.name, sourcePath: siren.sourcePath })),
    lights: meta.lights.map((light) => ({ id: light.id, name: "", sourcePath: light.sourcePath })),
    conflicts: [
      ...conflictsFrom("kit", kitsById),
      ...conflictsFrom("siren", sirensById),
      ...conflictsFrom("light", lightsById),
    ],
    outOfRange,
  };
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

export function kitMatchesName(kit, name) {
  const wanted = lower(name);
  if (!wanted) return false;
  if (lower(kit.kitName) === wanted) return true;
  if (kit.id != null && lower(`${kit.id}_${kit.kitName}`) === wanted) return true;
  return false;
}

function kitLiveryMods(kit) {
  return kit.visibleMods.filter((mod) => lower(mod.type) === "vmt_livery_mod");
}

function resolveColor(index, overrides) {
  if (!Number.isInteger(index)) {
    return { index, hex: UNKNOWN_COLOR_HEX, name: "Unknown", known: false };
  }
  const override = overrides.get(index);
  if (override) {
    return {
      index,
      hex: gameColorToHex(override.color) || UNKNOWN_COLOR_HEX,
      name: override.name || `Colour ${index}`,
      finish: parseMetallicId(override.metallicID) ?? DEFAULT_PAINT_FINISH,
      known: true,
    };
  }
  const entry = getVehicleColor(index);
  if (entry) return { index, hex: entry.hex, name: entry.name, finish: entry.finish, known: true };
  return { index, hex: UNKNOWN_COLOR_HEX, name: `Unknown ${index}`, known: false };
}

function buildTxdChain(txdName, relationships) {
  const chain = [];
  const seen = new Set();
  let current = lower(txdName);
  while (current && !seen.has(current)) {
    seen.add(current);
    const rel = relationships.find((entry) => lower(entry.child) === current);
    if (!rel || !rel.parent) break;
    chain.push(rel.parent);
    current = lower(rel.parent);
  }
  return chain;
}

function extrasNote(flags) {
  const parts = [];
  if (flags.require) parts.push("at least one extra always spawns (REQUIRE)");
  if (flags.all) parts.push("every extra spawns (ALL)");
  if (flags.strong) parts.push("extras do not break off (STRONG)");
  if (flags.script) parts.push("extras only change by script (SCRIPT)");
  if (flags.rare) parts.push("extras spawn rarely (RARE)");
  if (flags.only_break_when_destroyed) parts.push("extras only detach when the vehicle is destroyed");
  if (flags.convertible) parts.push("extras are convertible roof parts");
  if (flags.gen) parts.push("extras are generated as a group (GEN)");
  if (flags.match_livery || flags.matchLivery) parts.push("extras follow the livery index");
  if (parts.length === 0) return "No FLAG_EXTRAS_* flags: the game picks random extras on spawn.";
  return `${parts.join("; ")}.`;
}

/**
 * Front wheel steering limit from the vehicle's handlingId. The game keeps the
 * last loaded entry for a name, so the last match wins here too.
 */
function resolveSteering(meta, vehicle) {
  const handlingId = vehicle ? vehicle.handlingId : "";
  const matches = handlingId
    ? (meta.handling || []).filter((entry) => lower(entry.handlingName) === lower(handlingId))
    : [];
  const entry = matches[matches.length - 1] || null;
  return {
    handlingId,
    lockDegrees: entry ? entry.steeringLock : null,
    sourcePath: entry ? entry.sourcePath : "",
  };
}

function makeWarning(code, severity, message, fix) {
  const warning = { code, severity, message };
  if (fix) warning.fix = fix;
  return warning;
}

/**
 * Builds the view model for one model name.
 * options.availableTextureNames: string[] of texture names found in the model's YTD.
 */
export function simulateVehicle(resourceMeta, modelName, options = {}) {
  const meta = resourceMeta || createEmptyResourceMeta();
  const model = lower(modelName);
  const warnings = [];

  const vehicleEntries = meta.vehicles.filter((entry) => lower(entry.modelName) === model);
  const variationEntries = meta.variations.filter((entry) => lower(entry.modelName) === model);
  const vehicle = vehicleEntries[0] || null;
  const variation = variationEntries[0] || null;

  if (vehicleEntries.length > 1 || variationEntries.length > 1) {
    const paths = [...vehicleEntries, ...variationEntries].map((entry) => baseName(entry.sourcePath)).filter(Boolean);
    warnings.push(
      makeWarning(
        "DUPLICATE_MODEL",
        "warn",
        `"${modelName}" is defined more than once (${paths.join(", ")}). The game keeps whichever loads last.`,
        "Keep a single entry per model across the resource.",
      ),
    );
  }

  if (!vehicle) {
    warnings.push(
      makeWarning(
        "NO_VEHICLES_ENTRY",
        "warn",
        `"${modelName}" has no vehicles.meta entry in this resource. A replacement may inherit an entry from the game or another resource.`,
        "For an addon model, add an <Item> with <modelName> and declare vehicles.meta in fxmanifest.",
      ),
    );
  }
  if (!variation) {
    warnings.push(
      makeWarning(
        "NO_VARIATION_ENTRY",
        "warn",
        `"${modelName}" has no carvariations.meta entry in this resource. External or default variations may still apply.`,
        "Add a variationData <Item> with colours, liveries and kits.",
      ),
    );
  }

  // Texture liveries (FLAG_HAS_LIVERY + <model>_sign_N in the YTD).
  const hasLiveryFlag = Boolean(vehicle && vehicle.liveryFlags.hasLivery);
  const liveryList = variation && variation.colors.length > 0 ? variation.colors[0].liveries : [];
  const liveryTrueCount = liveryList.filter(Boolean).length;
  const textureLiveryCount = hasLiveryFlag || liveryTrueCount > 0 ? liveryTrueCount : 0;
  const prefix = lower(options.liveryTexturePrefix) || modelName;
  const slotIndices = liveryList.flatMap((enabled, index) => enabled ? [index] : []);
  const expectedTextureNames = slotIndices.map((index) => `${prefix}_sign_${index + 1}`);

  const availableTextures = Array.isArray(options.availableTextureNames)
    ? new Set(options.availableTextureNames.map(lower))
    : null;
  const textures = expectedTextureNames.map((name) => ({
    name,
    found: availableTextures ? availableTextures.has(lower(name)) : null,
  }));

  if (liveryTrueCount > 0 && vehicle && !hasLiveryFlag) {
    warnings.push(
      makeWarning(
        "LIVERY_FLAG_MISSING",
        "error",
        `carvariations lists ${liveryTrueCount} livery slot(s) but vehicles.meta has no FLAG_HAS_LIVERY. SetVehicleLivery will do nothing in game.`,
        "Add FLAG_HAS_LIVERY to <flags> in vehicles.meta, or use a mod kit livery instead.",
      ),
    );
  }
  if (availableTextures && textures.some((texture) => texture.found === false)) {
    const missing = textures.filter((texture) => texture.found === false).map((texture) => texture.name);
    warnings.push(
      makeWarning(
        "LIVERY_TEXTURES_MISSING",
        "error",
        `The YTD is missing ${missing.length} livery texture(s): ${missing.join(", ")}.`,
        "Name livery textures <model>_sign_1 .. _sign_N in the model's YTD, or reduce the liveries list.",
      ),
    );
  }

  // Mod kit liveries (VMT_LIVERY_MOD in carcols, linked from carvariations kits).
  const linkedKitNames = variation ? variation.kits : [];
  const linkedKits = [];
  for (const name of linkedKitNames) {
    const kit = meta.kits.find((candidate) => kitMatchesName(candidate, name));
    if (kit) linkedKits.push(kit);
  }
  const liveryKits = linkedKits.filter((kit) => kitLiveryMods(kit).length > 0);
  const modkitLiveries = {
    kitNames: linkedKitNames.slice(),
    kits: liveryKits.map((kit) => ({
      kitName: kit.kitName,
      id: kit.id,
      liveryMods: kitLiveryMods(kit).map((mod) => ({
        modelName: mod.modelName,
        modShopLabel: mod.modShopLabel,
        linkedModels: mod.linkedModels.slice(),
      })),
      liveryNames: kit.liveryNames.slice(),
    })),
    count: liveryKits.reduce((sum, kit) => sum + kitLiveryMods(kit).length, 0),
  };

  // Kits with livery mods that nothing in the resource links. Attribute them to
  // this model when the kit name mentions it or the resource has one model.
  const allLinkedNames = new Set();
  for (const entry of meta.variations) for (const name of entry.kits) allLinkedNames.add(lower(name));
  const modelCount = new Set(meta.vehicles.map((entry) => lower(entry.modelName))).size;
  for (const kit of meta.kits) {
    if (kitLiveryMods(kit).length === 0) continue;
    const isLinked = allLinkedNames.has(lower(kit.kitName)) || (kit.id != null && allLinkedNames.has(lower(`${kit.id}_${kit.kitName}`)));
    if (isLinked) continue;
    const mentionsModel = model && lower(kit.kitName).includes(model);
    if (!mentionsModel && modelCount > 1) continue;
    warnings.push(
      makeWarning(
        "MODKIT_NOT_LINKED",
        "error",
        `Mod kit "${kit.kitName}" has VMT_LIVERY_MOD entries but no carvariations <kits> entry references it. Its liveries will not appear in game.`,
        `Add <Item>${kit.kitName}</Item> under <kits> for ${modelName} in carvariations.meta.`,
      ),
    );
  }

  // Colour presets.
  const overrides = new Map(meta.colors.map((entry) => [entry.index, entry]));
  const colorPresets = [];
  const badIndices = new Set();
  const variationColors = variation ? variation.colors : [];
  variationColors.forEach((entry, presetIndex) => {
    const preset = { index: presetIndex, liveries: entry.liveries.slice() };
    COLOR_SLOT_KEYS.forEach((key, slot) => {
      if (slot >= entry.indices.length) return;
      if (slot >= 4 && entry.indices.length < 6) return;
      const colorIndex = entry.indices[slot];
      const resolved = resolveColor(colorIndex, overrides);
      preset[key] = resolved;
      if (!resolved.known) badIndices.add(colorIndex);
    });
    colorPresets.push(preset);
  });
  if (badIndices.size > 0) {
    const list = [...badIndices].sort((a, b) => a - b).join(", ");
    warnings.push(
      makeWarning(
        "COLOR_INDEX_INVALID",
        "warn",
        `Colour index ${list} is outside 0-${GTA_VEHICLE_COLOR_MAX_INDEX} and not defined by a carcols <Colors> list. The game falls back to a default colour.`,
        "Use a vanilla colour index or define the colour in carcols.meta.",
      ),
    );
  }

  // Ids and conflicts.
  const idScan = scanResourceForIds(meta);
  const kitIds = linkedKits.map((kit) => kit.id).filter((id) => id != null);
  const sirenIds = variation && variation.sirenSettings != null ? [variation.sirenSettings] : [];
  const lightIds = variation && variation.lightSettings != null ? [variation.lightSettings] : [];
  const conflicts = { kit: [], siren: [], light: [] };
  const conflictCodes = { kit: "MODKIT_ID_CONFLICT", siren: "SIREN_ID_CONFLICT", light: "LIGHT_ID_CONFLICT" };
  const conflictLabels = { kit: "Mod kit", siren: "Siren setting", light: "Light setting" };
  const usedIds = { kit: new Set(kitIds), siren: new Set(sirenIds), light: new Set(lightIds) };
  for (const conflict of idScan.conflicts) {
    // Report conflicts the model touches, plus kit conflicts when the resource has one model.
    const relevant = usedIds[conflict.kind].has(conflict.id) || modelCount <= 1;
    if (!relevant) continue;
    conflicts[conflict.kind].push(conflict.id);
    const where = conflict.entries.map((entry) => baseName(entry.sourcePath) || "?").join(", ");
    warnings.push(
      makeWarning(
        conflictCodes[conflict.kind],
        "error",
        `${conflictLabels[conflict.kind]} id ${conflict.id} is defined ${conflict.entries.length} times (${where}). Only one definition wins.`,
        `Give each ${conflictLabels[conflict.kind].toLowerCase()} a unique id across the server.`,
      ),
    );
  }
  for (const [kind, ids] of Object.entries(usedIds)) {
    if (kind === "kit") continue;
    const defined = kind === "siren" ? meta.sirens : meta.lights;
    for (const id of ids) {
      if (id === 0 && kind === "light") continue; // 0 is the vanilla default light set
      if (!defined.some((entry) => entry.id === id)) {
        warnings.push(
          makeWarning(
            kind === "siren" ? "SIREN_ID_UNDEFINED" : "LIGHT_ID_UNDEFINED",
            "info",
            `${conflictLabels[kind]} id ${id} is referenced by carvariations but not defined in this resource's carcols. It must come from the base game or another resource.`,
          ),
        );
      }
    }
  }

  // Siren settings the model uses, checked against the model's sirenN bones.
  const sirenSetting = sirenIds.length ? meta.sirens.find((entry) => entry.id === sirenIds[0]) || null : null;
  if (sirenSetting) {
    const badSequencers = sirenSetting.sirens.flatMap((siren, index) =>
      (siren.flash && siren.flashiness.sequencer == null) || (siren.rotate && siren.rotation.sequencer == null) ? [index + 1] : []);
    if (badSequencers.length) {
      warnings.push(
        makeWarning(
          "SIREN_SEQUENCER_INVALID",
          "error",
          `Siren ${badSequencers.join(", ")} ${badSequencers.length === 1 ? "has" : "have"} a missing or out-of-range sequencer. Sequencers are 32-bit values from 0 to 4294967295.`,
          "Write each sequencer as a decimal 32-bit pattern, for example 2863311530 for 1010...",
        ),
      );
    }
  }
  const sirenBones = Array.isArray(options.lightBones)
    ? options.lightBones.map(lower).flatMap((name) => /^siren(\d+)$/.exec(name)?.slice(1).map(Number) ?? [])
    : null;
  if (sirenSetting && sirenBones) {
    const boneSet = new Set(sirenBones);
    const unbound = sirenSetting.sirens.flatMap((_, index) => boneSet.has(index + 1) ? [] : [index + 1]);
    const unused = sirenBones.filter((index) => index > sirenSetting.sirens.length).sort((a, b) => a - b);
    if (unbound.length && sirenBones.length) {
      warnings.push(
        makeWarning(
          "SIREN_BONE_MISSING",
          "info",
          `Siren ${unbound.join(", ")} ${unbound.length === 1 ? "has" : "have"} settings but the model has no matching siren bone. Those entries light nothing.`,
          "Rig the light geometry to sirenN bones, or trim the unused carcols entries.",
        ),
      );
    }
    if (unused.length) {
      warnings.push(
        makeWarning(
          "SIREN_SETTINGS_MISSING",
          "warn",
          `The model has siren ${unused.join(", ")} but "${sirenSetting.name || sirenSetting.id}" only defines ${sirenSetting.sirens.length} sirens. Those lights never flash.`,
          "Add a carcols <sirens> Item for each siren bone.",
        ),
      );
    }
  }

  // TXD chain.
  const txdName = vehicle ? vehicle.txdName : "";
  const parentChain = buildTxdChain(txdName, meta.txdRelationships);
  if (parentChain.length > 0) {
    const known = new Set([
      ...meta.vehicles.map((entry) => lower(entry.txdName)),
      ...meta.txdRelationships.map((entry) => lower(entry.child)),
      ...meta.residentTxds.map(lower),
    ]);
    const top = parentChain[parentChain.length - 1];
    const topLower = lower(top);
    const looksVanilla = topLower.startsWith("vehshare") || topLower.startsWith("vehicles_");
    if (!known.has(topLower) && !looksVanilla) {
      warnings.push(
        makeWarning(
          "TXD_PARENT_UNRESOLVED",
          "info",
          `Texture dictionary parent "${top}" is not defined in this resource. Shared textures must come from the base game or another streamed YTD.`,
          "Stream the parent YTD or point the txdRelationships parent at vehshare.",
        ),
      );
    }
  }

  const extrasFlags = vehicle ? vehicle.extrasFlags : {};
  const hasTexture = hasLiveryFlag || textureLiveryCount > 0;
  const hasModkit = modkitLiveries.count > 0;
  const liverySystem = hasTexture && hasModkit ? "both" : hasTexture ? "texture" : hasModkit ? "modkit" : "none";

  const severityRank = { error: 0, warn: 1, info: 2 };
  warnings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

  return {
    modelName,
    found: { vehicles: Boolean(vehicle), variations: Boolean(variation) },
    liverySystem,
    textureLiveries: {
      enabled: hasLiveryFlag,
      count: textureLiveryCount,
      expectedTextureNames,
      slotIndices,
      textures,
      matchExtra: Boolean(vehicle && vehicle.liveryFlags.liveryMatchExtra),
    },
    modkitLiveries,
    colorPresets,
    extras: { flags: extrasFlags, note: extrasNote(extrasFlags) },
    plate: {
      type: vehicle ? vehicle.plateType : "",
      probabilities: variation ? variation.plateProbabilities.slice() : [],
    },
    wheels: { type: vehicle ? vehicle.wheelType : "" },
    steering: resolveSteering(meta, vehicle),
    convertibleRoof: vehicle?.convertibleRoof || null,
    txd: { txdName, parentChain },
    ids: { kitIds, sirenIds, lightIds, conflicts },
    sirenSetting,
    vehicle,
    variation,
    warnings,
  };
}
