// Turns carcols.meta mod kits into what the viewer needs to preview them: the
// kits a vehicle can use, their visible mods grouped by slot type in game index
// order, the model files that implement each mod, and the stock bones a chosen
// mod turns off. Pure; the caller reads the resource and passes the results.

import { DEFAULT_MODKIT_NAME, kitMatchesName } from "./vehicle-meta.js";

const SLOT_LABELS = new Map([
  ["VMT_SPOILER", "Spoiler"],
  ["VMT_BUMPER_F", "Front bumper"],
  ["VMT_BUMPER_R", "Rear bumper"],
  ["VMT_SKIRT", "Side skirts"],
  ["VMT_EXHAUST", "Exhaust"],
  ["VMT_CHASSIS", "Roll cage"],
  ["VMT_GRILL", "Grille"],
  ["VMT_BONNET", "Hood"],
  ["VMT_WING_L", "Left fender"],
  ["VMT_WING_R", "Right fender"],
  ["VMT_ROOF", "Roof"],
  ["VMT_PLTHOLDER", "Plate holder"],
  ["VMT_PLTVANITY", "Vanity plate"],
  ["VMT_INTERIOR1", "Trim design"],
  ["VMT_INTERIOR2", "Ornaments"],
  ["VMT_INTERIOR3", "Dashboard"],
  ["VMT_INTERIOR4", "Dials"],
  ["VMT_INTERIOR5", "Door speakers"],
  ["VMT_SEATS", "Seats"],
  ["VMT_STEERING", "Steering wheel"],
  ["VMT_KNOB", "Shifter"],
  ["VMT_PLAQUE", "Plaque"],
  ["VMT_ICE", "Speakers"],
  ["VMT_TRUNK", "Trunk"],
  ["VMT_HYDRO", "Hydraulics"],
  ["VMT_ENGINEBAY1", "Engine block"],
  ["VMT_ENGINEBAY2", "Air filter"],
  ["VMT_ENGINEBAY3", "Struts"],
  ["VMT_CHASSIS2", "Arch covers"],
  ["VMT_CHASSIS3", "Aerials"],
  ["VMT_CHASSIS4", "Exterior trim"],
  ["VMT_CHASSIS5", "Fuel tank"],
  ["VMT_DOOR_L", "Left door"],
  ["VMT_DOOR_R", "Right door"],
  ["VMT_LIVERY_MOD", "Livery"],
  ["VMT_LIGHTBAR", "Lightbar"],
]);
const SLOT_ORDER = [...SLOT_LABELS.keys()];

function lower(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function modSlotLabel(type) {
  const key = String(type || "").trim().toUpperCase();
  if (SLOT_LABELS.has(key)) return SLOT_LABELS.get(key);
  const words = key.replace(/^VMT_/, "").replace(/_/g, " ").toLowerCase().trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Other";
}

/** GTA's one-at-a-time hash of the lower-cased text, as GetHashKey computes it. */
export function joaat(text) {
  let hash = 0;
  for (const char of String(text).toLowerCase()) {
    hash = (hash + char.charCodeAt(0)) >>> 0;
    hash = (hash + (hash << 10)) >>> 0;
    hash = (hash ^ (hash >>> 6)) >>> 0;
  }
  hash = (hash + (hash << 3)) >>> 0;
  hash = (hash ^ (hash >>> 11)) >>> 0;
  return (hash + (hash << 15)) >>> 0;
}

function unescapeScriptString(value) {
  return value.replace(/\\(.)/g, (_, char) => (char === "n" ? " " : char));
}

// Formatting tokens (~r~, ~n~, ~h~) are display markup, not part of the name.
function cleanGameText(value) {
  return value.replace(/~[a-z0-9_]+~/gi, " ").replace(/\s+/g, " ").trim();
}

const STRING = String.raw`(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')`;
const TEXT_ENTRY_PATTERN = new RegExp(String.raw`\bAddTextEntry\s*\(\s*${STRING}\s*,\s*${STRING}`, "g");
const HASH_KEY = String.raw`(?:\x60([^\x60]+)\x60|GetHashKey\s*\(\s*${STRING}\s*\)|joaat\s*\(\s*${STRING}\s*\)|(0x[0-9a-f]+|-?\d+))`;
const HASH_ENTRY_PATTERN = new RegExp(String.raw`\bAddTextEntryByHash\s*\(\s*${HASH_KEY}\s*,\s*${STRING}`, "gi");

/**
 * Collects the display text FiveM resources register for game text labels
 * (`AddTextEntry`, `AddTextEntryByHash`) from Lua or JavaScript source. Keys
 * are case-insensitive, so entries are stored by label hash. Calls with
 * computed arguments are skipped rather than guessed.
 */
export function parseTextEntries(source, entries = new Map()) {
  if (typeof source !== "string" || !/AddTextEntry/.test(source)) return entries;
  const code = source.replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, "").replace(/(^|[^:])--[^\n]*/g, "$1");
  for (const match of code.matchAll(TEXT_ENTRY_PATTERN)) {
    const key = unescapeScriptString(match[1] ?? match[2]);
    const text = cleanGameText(unescapeScriptString(match[3] ?? match[4]));
    if (key && text) entries.set(joaat(key), text);
  }
  for (const match of code.matchAll(HASH_ENTRY_PATTERN)) {
    const [, backtick, getHashDouble, getHashSingle, joaatDouble, joaatSingle, literal, textDouble, textSingle] = match;
    const name = backtick ?? getHashDouble ?? getHashSingle ?? joaatDouble ?? joaatSingle;
    const hash = name != null ? joaat(unescapeScriptString(name)) : Number(literal) >>> 0;
    const text = cleanGameText(unescapeScriptString(textDouble ?? textSingle));
    if (Number.isFinite(hash) && text) entries.set(hash, text);
  }
  return entries;
}

function lookupText(entries, label) {
  const key = String(label || "").trim();
  return key && entries?.size ? entries.get(joaat(key)) || "" : "";
}

function slotRank(type) {
  const index = SLOT_ORDER.indexOf(String(type || "").trim().toUpperCase());
  return index < 0 ? SLOT_ORDER.length : index;
}

function buildSlots(kit, textEntries) {
  const slotNames = new Map();
  for (const entry of kit.slotNames || []) {
    const slot = String(entry?.slot || "").trim().toUpperCase();
    const name = String(entry?.name || "").trim();
    if (slot && name && !slotNames.has(slot)) slotNames.set(slot, name);
  }
  const byType = new Map();
  for (const mod of kit.visibleMods || []) {
    const type = String(mod.type || "").trim().toUpperCase();
    if (!type) continue;
    if (!byType.has(type)) byType.set(type, []);
    // The game indexes mods per type in carcols order, model or not, so the
    // index is assigned before entries without a model are dropped.
    const index = byType.get(type).length;
    const modelName = String(mod.modelName || "").trim();
    const label = String(mod.modShopLabel || "").trim();
    byType.get(type).push({
      index,
      modelName,
      label,
      // Text the resource registers for the label, else the label itself;
      // the game shows the raw key when no entry exists.
      displayName: lookupText(textEntries, label) || label || modelName,
      named: Boolean(lookupText(textEntries, label)),
      linkedModels: (mod.linkedModels || []).map((name) => String(name).trim()).filter(Boolean),
      turnOffBones: (mod.turnOffBones || []).map((name) => String(name).trim()).filter(Boolean),
      bone: String(mod.bone || "").trim(),
    });
  }
  return [...byType.entries()]
    .map(([type, mods]) => {
      const custom = slotNames.get(type) || "";
      return {
        type,
        label: modSlotLabel(type),
        // carcols slotNames may be plain text or a text label.
        displayName: lookupText(textEntries, custom) || custom || modSlotLabel(type),
        mods: mods.filter((mod) => mod.modelName),
      };
    })
    .filter((slot) => slot.mods.length > 0)
    .sort((a, b) => slotRank(a.type) - slotRank(b.type) || a.type.localeCompare(b.type));
}

function describeKit(kit, linked, textEntries) {
  // A linked model is fitted to the bone of its own linkMods entry.
  const linkBones = {};
  for (const mod of kit.linkMods || []) {
    const name = lower(mod.modelName);
    const bone = String(mod.bone || "").trim();
    if (name && bone && !(name in linkBones)) linkBones[name] = bone;
  }
  return {
    kitName: kit.kitName,
    id: kit.id,
    linked,
    sourcePath: kit.sourcePath || "",
    slots: buildSlots(kit, textEntries),
    // Names for the vehicle's texture liveries, in livery order (sign_1 first).
    liveryNames: (kit.liveryNames || []).map((name) => String(name || "").trim()).map((name) => lookupText(textEntries, name) || name),
    linkBones,
  };
}

/**
 * Kits the vehicle can use, in carvariations `<kits>` order. When nothing is
 * linked, kits that name the model (or the only kit-bearing kits of a
 * single-vehicle resource) are offered with `linked: false`, since the game
 * will not apply them until carvariations references them.
 */
export function listVehicleModkits(resourceMeta, modelName, { textEntries } = {}) {
  const model = lower(modelName);
  const kits = Array.isArray(resourceMeta?.kits) ? resourceMeta.kits : [];
  const variations = Array.isArray(resourceMeta?.variations) ? resourceMeta.variations : [];
  const variation = variations.find((entry) => lower(entry.modelName) === model) || null;
  const linkedNames = variation ? variation.kits : [];

  const result = [];
  const seen = new Set();
  for (const name of linkedNames) {
    const kit = kits.find((candidate) => kitMatchesName(candidate, name));
    if (!kit || seen.has(kit)) continue;
    seen.add(kit);
    result.push(describeKit(kit, true, textEntries));
  }

  if (result.length === 0 && model) {
    const vehicleModels = new Set((resourceMeta?.vehicles || []).map((entry) => lower(entry.modelName)).filter(Boolean));
    const onlyVehicle = vehicleModels.size === 1 && vehicleModels.has(model);
    for (const kit of kits) {
      if (lower(kit.kitName) === DEFAULT_MODKIT_NAME) continue;
      if (!onlyVehicle && !lower(kit.kitName).includes(model)) continue;
      result.push(describeKit(kit, false, textEntries));
    }
  }

  return {
    modelName: modelName || "",
    kits: result.filter((kit) => kit.slots.length > 0),
  };
}

/** Maps lower-case file stems to `.yft` paths. The first path for a stem wins. */
export function indexModelFiles(paths) {
  const index = new Map();
  for (const path of paths || []) {
    if (typeof path !== "string") continue;
    const match = /([^\\/]+)\.yft$/i.exec(path);
    if (!match) continue;
    const stem = match[1].toLowerCase();
    if (!index.has(stem)) index.set(stem, path);
  }
  return index;
}

/** The game streams `<name>_hi.yft` up close, so preview that when it exists. */
export function findModelFile(index, modelName) {
  const name = lower(modelName);
  if (!name || !index) return null;
  return index.get(`${name}_hi`) || index.get(name) || null;
}

/**
 * Resolves a selection (`{ [slotType]: modIndex }`) against a kit into the
 * model files to load and the stock bones to hide. Linked models load with
 * their mod. Each part carries the vehicle `bone` it is fitted to: its mod's,
 * or for a linked model its linkMods entry's when the kit has one. Unknown
 * slots and indices are ignored rather than guessed.
 */
export function resolveModSelection(kit, selection, modelIndex) {
  const parts = [];
  const missing = [];
  const hiddenBones = new Set();
  const seenPaths = new Set();
  for (const slot of kit?.slots || []) {
    const chosen = selection?.[slot.type];
    if (!Number.isInteger(chosen)) continue;
    const mod = slot.mods.find((entry) => entry.index === chosen);
    if (!mod) continue;
    for (const bone of mod.turnOffBones) hiddenBones.add(bone.toLowerCase());
    for (const name of [mod.modelName, ...mod.linkedModels]) {
      const bone = name === mod.modelName ? mod.bone : kit.linkBones?.[lower(name)] || mod.bone;
      const path = findModelFile(modelIndex, name);
      if (!path) {
        missing.push({ slotType: slot.type, modelName: name });
        continue;
      }
      const key = path.toLowerCase();
      if (seenPaths.has(key)) continue;
      seenPaths.add(key);
      parts.push({ key, path, modelName: name, slotType: slot.type, bone: bone || "" });
    }
  }
  return { parts, missing, hiddenBones: [...hiddenBones].sort() };
}

/** True when any bone in the mesh's chain is turned off. Unknown chains stay visible. */
export function isHiddenByBones(boneChain, hiddenBones) {
  if (!Array.isArray(boneChain) || boneChain.length === 0 || !hiddenBones?.size) return false;
  return boneChain.some((bone) => hiddenBones.has(lower(bone)));
}
