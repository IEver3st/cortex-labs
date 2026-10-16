// Saved FiveM characters (vMenu and the menus that copy its save format)
// turned into an EUP Studio base ped.
//
// Pure and deterministic apart from gzip decoding, so Node tests cover every
// format. Three shapes exist in the wild:
//   - vMenu Enhanced: a transfer code (`VME1G:` gzip or `VME1P:` plain base64)
//     holding a bundle of envelopes; characters are `vmenu_mpchar_*`
//     (MpCharacter) and saved peds `vmenu_ped_*` (SavedPed).
//   - vMenu legacy `mp_ped_*` (MultiplayerPedData). Forks store clothes as
//     arrays instead of Key/Value pairs, rename the head blend fields, and may
//     record each drawable's clothing collection.
//   - vMenu legacy saved peds `ped_*` (PedInfo), flat slot maps.
// Menyoo outfit files (`OutfitPedData` XML, or ped placements in a Spooner
// file) are read the same way. LSPDFR's `.ls`/`.bak` character saves are
// encrypted with an unpublished format; they are recognised and refused with
// the in-game route through a Menyoo outfit instead.
// Clothing numbers are the game's drawable numbers on the server the character
// was saved on. A save that records a drawable's collection is resolved
// through that collection, so DLC numbering differences don't matter; a plain
// number is checked against the game files and refused when it isn't there
// instead of showing a different drawable. Server addon clothing resolves the
// same way once its packs are loaded (`extendPedListing` in eup.js): by
// collection name exactly, by plain number in the packs' load order.

import { COMPONENT_IDS, PED_FOR_GENDER, PROP_IDS, componentDisplayName, resolveDrawableNumber } from "./eup.js";
import { XmlParseError, attrValue, childText, findChild, parseXml } from "./xml-lite.js";

export const VMENU_CODE_PREFIXES = Object.freeze(["VME1G:", "VME1P:"]);
const VMENU_BUNDLE_FORMAT = "vmenu.enhanced.kvp";
const MAX_CODE_CHARS = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
// LSPDFR character saves start with "LSE" and a format number ("LSE02").
const LSPDFR_MAGIC = "LSE0";
export const LSPDFR_SAVE_MESSAGE = "This is an LSPDFR character save (.ls or .bak). LSPDFR encrypts its characters and doesn't publish the format, so only LSPDFR can read them. To bring one over, put the character on in GTA V, save the outfit in Menyoo's wardrobe and open that .xml from menyooStuff\\Outfits here.";
const MAX_CHARACTERS = 500;

// GetPedHairRgbColor for hair colour ids 0-63, as published in community
// character creators (two independent tables agree on every value).
export const GTA_HAIR_COLORS = Object.freeze([
  "#1c1f21", "#272a2c", "#312e2c", "#35261c", "#4b321f", "#5c3b24", "#6d4c35", "#6b503b",
  "#765c45", "#7f684e", "#99815d", "#a79369", "#af9c70", "#bba063", "#d6b97b", "#dac38e",
  "#9f7f59", "#845039", "#682b1f", "#61120c", "#640f0a", "#7c140f", "#a02e19", "#b64b28",
  "#a2502f", "#aa4e2b", "#626262", "#808080", "#aaaaaa", "#c5c5c5", "#463955", "#5a3f6b",
  "#763c76", "#ed74e3", "#eb4b93", "#f299bc", "#04959e", "#025f86", "#023974", "#3fa16a",
  "#217c61", "#185c55", "#b6c034", "#70a90b", "#439d13", "#dcb857", "#e5b103", "#e69102",
  "#f28831", "#fb8057", "#e28b58", "#d1593c", "#ce3120", "#ad0903", "#880302", "#1f1814",
  "#291f19", "#2e221b", "#37291e", "#2e2218", "#231b15", "#020202", "#706c66", "#9d7a50",
]);

// Skin tones were calibrated from the heritage heads of these races (see
// SKIN_TONES in eup.js). A head of any other race keeps the current tone.
export const RACE_SKIN_TONES = Object.freeze({
  whi: "light",
  chi: "fair",
  ara: "tan",
  lat: "olive",
  pak: "brown",
  bla: "dark",
});

// Prop anchors vMenu saves (0 hat, 1 glasses, 2 ears, 6 watch, 7 bracelet).
const SAVED_PROP_SLOTS = Object.freeze([0, 1, 2, 6, 7]);
// The game's heritage faces: head drawables 0-45 on both freemode peds.
const MAX_PARENT_FACE = 45;

/** GTA's Jenkins one-at-a-time hash, unsigned. */
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

const GENDER_FOR_HASH = new Map([
  [joaat(PED_FOR_GENDER.male), "male"],
  [joaat(PED_FOR_GENDER.female), "female"],
]);

/** "male", "female", or null for a ped model EUP Studio can't dress. */
export function genderForModelHash(hash) {
  const value = Number(hash);
  if (!Number.isFinite(value)) return null;
  return GENDER_FOR_HASH.get(value >>> 0) || null;
}

/* ── Loose JSON access ──
   vMenu Enhanced writes camelCase, legacy vMenu PascalCase, and forks mix
   both, so property names are matched case-insensitively. */

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function read(object, ...names) {
  if (!isObject(object)) return undefined;
  for (const name of names) {
    const wanted = name.toLowerCase();
    const key = Object.keys(object).find((item) => item.toLowerCase() === wanted);
    if (key !== undefined) return object[key];
  }
  return undefined;
}

// Numbers or numeric strings only: Number(null) and Number("") are 0, which
// would turn a missing field into drawable 0.
function number(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return Number.NaN;
}

function int(value) {
  const result = number(value);
  return Number.isInteger(result) ? result : null;
}

function float(value) {
  const result = number(value);
  return Number.isFinite(result) ? result : null;
}

function text(value) {
  return typeof value === "string" ? value : "";
}

/* ── vMenu Enhanced transfer codes ── */

function fromBase64(code) {
  if (typeof atob === "function") {
    const binary = atob(code);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new Uint8Array(Buffer.from(code, "base64"));
}

async function gunzip(bytes) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("This system can't unpack gzip, which the vMenu code needs.");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function isVmenuCode(value) {
  const cleaned = String(value || "").replace(/\s+/g, "");
  return VMENU_CODE_PREFIXES.some((prefix) => cleaned.startsWith(prefix));
}

/** The JSON text inside a vMenu Enhanced transfer code. */
export async function decodeVmenuCode(code) {
  // Chat apps wrap long codes; vMenu ignores the line breaks too.
  const cleaned = String(code || "").replace(/\s+/g, "");
  if (cleaned.length > MAX_CODE_CHARS) throw new Error("The vMenu code is too long to be a character export.");
  const prefix = VMENU_CODE_PREFIXES.find((item) => cleaned.startsWith(item));
  if (!prefix) throw new Error("A vMenu code starts with VME1.");
  let bytes;
  try {
    bytes = fromBase64(cleaned.slice(prefix.length));
  } catch {
    throw new Error("The vMenu code is damaged: it isn't valid base64. Copy the whole code, from VME1 to the end.");
  }
  if (prefix === "VME1G:") {
    try {
      bytes = await gunzip(bytes);
    } catch (error) {
      if (/can't unpack/.test(error?.message || "")) throw error;
      throw new Error("The vMenu code is damaged or incomplete. Copy the whole code, from VME1 to the end.");
    }
  }
  return new TextDecoder().decode(bytes);
}

/* ── Formats ── */

// One clothing value: the game drawable number, texture id and, when the save
// recorded it, the clothing collection and the drawable's number inside it.
function slotValue(drawable, texture, collection = null, local = null) {
  const d = int(drawable);
  if (d === null) return null;
  const t = int(texture);
  return {
    drawable: d,
    texture: t !== null && t >= 0 ? t : 0,
    collection: typeof collection === "string" ? collection.toLowerCase() : null,
    local: int(local) !== null && int(local) >= 0 ? int(local) : null,
  };
}

// Legacy pairs: {"Key": drawable, "Value": texture} or forks' [drawable, texture, palette].
function pairValue(value) {
  if (Array.isArray(value)) return slotValue(value[0], value[1]);
  if (isObject(value)) return slotValue(read(value, "Key"), read(value, "Value"));
  return null;
}

function componentName(slot) {
  return Number.isInteger(slot) && slot >= 0 && slot < COMPONENT_IDS.length ? COMPONENT_IDS[slot] : null;
}

function propName(slot) {
  return SAVED_PROP_SLOTS.includes(slot) ? PROP_IDS[slot] : null;
}

function emptyOutfit(name) {
  return { name, components: {}, props: {} };
}

function headBlend(source) {
  if (!isObject(source)) return null;
  const shapeFirst = int(read(source, "firstShape", "FirstFaceShape", "shapeFirstID", "shapeFirst"));
  const shapeSecond = int(read(source, "secondShape", "SecondFaceShape", "shapeSecondID", "shapeSecond"));
  const skinFirst = int(read(source, "firstSkin", "FirstSkinTone", "skinFirstID", "skinFirst"));
  const skinSecond = int(read(source, "secondSkin", "SecondSkinTone", "skinSecondID", "skinSecond"));
  const shapeMix = float(read(source, "shapeMix", "ParentFaceShapePercent"));
  const skinMix = float(read(source, "skinMix", "ParentSkinTonePercent"));
  if (shapeFirst === null && shapeSecond === null) return null;
  return {
    shapeFirst: shapeFirst ?? 0,
    shapeSecond: shapeSecond ?? 0,
    skinFirst: skinFirst ?? 0,
    skinSecond: skinSecond ?? 0,
    shapeMix: shapeMix ?? 0.5,
    skinMix: skinMix ?? 0.5,
  };
}

function hairValue(style, color, highlight) {
  const result = { style: int(style), color: int(color), highlight: int(highlight) };
  return result.style === null && result.color === null && result.highlight === null ? null : result;
}

function countTattoos(value) {
  if (Array.isArray(value)) return value.length;
  if (!isObject(value)) return 0;
  return Object.values(value).reduce((total, list) => total + (Array.isArray(list) ? list.length : 0), 0);
}

// Overlays a game face would show: beard, eyebrows, makeup and the like.
function countOverlays({ overlays, appearance }) {
  let count = 0;
  if (Array.isArray(overlays)) {
    count += overlays.filter((item) => isObject(item) && (float(read(item, "opacity")) ?? 0) > 0
      && (int(read(item, "style")) ?? 255) !== 255).length;
  } else if (isObject(overlays)) {
    count += Object.values(overlays).filter((item) => isObject(item) && (float(read(item, "opacity")) ?? 0) > 0
      && (int(read(item, "style")) ?? 255) !== 255).length;
  }
  if (isObject(appearance) && !overlays) {
    for (const [key, value] of Object.entries(appearance)) {
      const match = key.match(/^(.+)Opacity$/i);
      if (!match || !(Number(value) > 0)) continue;
      const style = int(read(appearance, `${match[1]}Style`));
      if (style !== null && style !== 255) count += 1;
    }
  }
  return count;
}

function countFeatures(value) {
  const source = isObject(value) && isObject(read(value, "features")) ? read(value, "features") : value;
  const list = Array.isArray(source) ? source : isObject(source) ? Object.values(source) : [];
  return list.filter((item) => Math.abs(Number(item) || 0) > 0.001).length;
}

function character({ name, format, gender, outfits, defaultOutfit = 0, hair = null, blend = null, extras = {} }) {
  return {
    name: String(name || "Unnamed").trim().slice(0, 80) || "Unnamed",
    format,
    gender,
    outfits,
    defaultOutfit: Math.min(Math.max(0, defaultOutfit), Math.max(0, outfits.length - 1)),
    hair,
    headBlend: blend,
    extras: {
      tattoos: extras.tattoos || 0,
      overlays: extras.overlays || 0,
      faceFeatures: extras.faceFeatures || 0,
    },
  };
}

function stripPrefix(key, prefixes) {
  const name = String(key || "");
  const prefix = prefixes.find((item) => name.startsWith(item));
  return prefix ? name.slice(prefix.length) : name;
}

function isLegacyMultiplayer(value) {
  const clothes = read(read(value, "DrawableVariations"), "clothes");
  return isObject(clothes) && (read(value, "IsMale") !== undefined || read(value, "ModelHash") !== undefined);
}

function readLegacyMultiplayer(value, key) {
  const male = read(value, "IsMale");
  const gender = genderForModelHash(read(value, "ModelHash")) || (male === true ? "male" : male === false ? "female" : null);
  if (!gender) return { skipped: "not-freemode" };
  const outfit = emptyOutfit("Saved outfit");
  const collections = read(value, "ComponentCollections");
  for (const [slotKey, raw] of Object.entries(read(read(value, "DrawableVariations"), "clothes") || {})) {
    const component = componentName(int(slotKey));
    const slot = pairValue(raw);
    if (!component || !slot) continue;
    // Forks record { index, name } per slot: the collection and the number in it.
    const known = isObject(collections) ? read(collections, slotKey) : null;
    if (isObject(known) && typeof read(known, "name") === "string") {
      slot.collection = read(known, "name").toLowerCase();
      slot.local = int(read(known, "index")) !== null && int(read(known, "index")) >= 0 ? int(read(known, "index")) : null;
    }
    outfit.components[component] = slot;
  }
  for (const [slotKey, raw] of Object.entries(read(read(value, "PropVariations"), "props") || {})) {
    const component = propName(int(slotKey));
    const slot = pairValue(raw);
    if (component && slot) outfit.props[component] = slot;
  }
  const appearance = read(value, "PedAppearance");
  const hair = hairValue(
    read(appearance, "hairStyle") ?? outfit.components.hair?.drawable,
    read(value, "HairColor") ?? read(appearance, "hairColor"),
    read(value, "HairHighlightColor") ?? read(appearance, "hairHighlightColor"),
  );
  const saveName = text(read(value, "SaveName")) || key;
  return {
    character: character({
      name: stripPrefix(saveName, ["mp_ped_"]),
      format: "vmenu-legacy",
      gender,
      outfits: [outfit],
      hair,
      blend: headBlend(read(value, "PedHeadBlendData")),
      extras: {
        tattoos: countTattoos(read(value, "PedTatttoos") ?? read(value, "PedTattoos") ?? read(value, "Tattoos")),
        overlays: countOverlays({ overlays: read(value, "HeadOverlays"), appearance }),
        faceFeatures: countFeatures(read(value, "FaceShapeFeatures")),
      },
    }),
  };
}

function isLegacyPedInfo(value) {
  return isObject(read(value, "drawableVariations")) && !isObject(read(read(value, "drawableVariations"), "clothes"))
    && read(value, "model") !== undefined;
}

function readLegacyPedInfo(value, key) {
  const gender = genderForModelHash(read(value, "model"));
  if (!gender) return { skipped: "not-freemode" };
  const outfit = emptyOutfit("Saved ped");
  const drawables = read(value, "drawableVariations") || {};
  const textures = read(value, "drawableVariationTextures") || {};
  for (let slot = 0; slot < COMPONENT_IDS.length; slot += 1) {
    const entry = slotValue(read(drawables, String(slot)), read(textures, String(slot)));
    if (entry) outfit.components[COMPONENT_IDS[slot]] = entry;
  }
  const props = read(value, "props") || {};
  const propTextures = read(value, "propTextures") || {};
  for (const slot of SAVED_PROP_SLOTS) {
    const entry = slotValue(read(props, String(slot)), read(propTextures, String(slot)));
    if (entry) outfit.props[PROP_IDS[slot]] = entry;
  }
  return {
    character: character({
      name: stripPrefix(key, ["ped_"]),
      format: "vmenu-legacy-ped",
      gender,
      outfits: [outfit],
      hair: hairValue(outfit.components.hair?.drawable, null, null),
    }),
  };
}

// vMenu Enhanced PedOutfit: lists of { slot, drawable, texture, collection, localDrawable }.
function enhancedOutfit(source, name) {
  const outfit = emptyOutfit(name);
  for (const item of Array.isArray(read(source, "components")) ? read(source, "components") : []) {
    const component = componentName(int(read(item, "slot")));
    const slot = slotValue(read(item, "drawable"), read(item, "texture"), read(item, "collection"), read(item, "localDrawable"));
    if (component && slot) outfit.components[component] = slot;
  }
  for (const item of Array.isArray(read(source, "props")) ? read(source, "props") : []) {
    const component = propName(int(read(item, "slot")));
    const slot = slotValue(read(item, "drawable"), read(item, "texture"), read(item, "collection"), read(item, "localDrawable"));
    if (component && slot) outfit.props[component] = slot;
  }
  return outfit;
}

function isEnhancedCharacter(value) {
  return isObject(read(value, "core")) && read(read(value, "core"), "isMale") !== undefined;
}

function readEnhancedCharacter(value, key) {
  const core = read(value, "core");
  const gender = read(core, "isMale") === false ? "female" : "male";
  const outfits = [];
  const current = read(value, "currentOutfit");
  if (isObject(current)) outfits.push(enhancedOutfit(read(current, "outfit"), text(read(current, "name")) || "Current outfit"));
  for (const item of Array.isArray(read(value, "outfits")) ? read(value, "outfits") : []) {
    if (!isObject(item)) continue;
    const name = text(read(item, "name")) || `Outfit ${outfits.length + 1}`;
    if (outfits.some((outfit) => outfit.name.toLowerCase() === name.toLowerCase())) continue;
    outfits.push(enhancedOutfit(read(item, "outfit"), name));
  }
  if (outfits.length === 0) outfits.push(emptyOutfit("No outfit"));
  const lastOutfit = text(read(value, "lastOutfit")).toLowerCase();
  const defaultOutfit = Math.max(0, outfits.findIndex((outfit) => outfit.name.toLowerCase() === lastOutfit));
  const styles = Array.isArray(read(value, "styles")) ? read(value, "styles") : [];
  const lastStyle = text(read(value, "lastStyle")).toLowerCase();
  const style = read(value, "currentStyle")
    || styles.find((item) => text(read(item, "name")).toLowerCase() === lastStyle)
    || styles[0];
  const overlays = [
    ...(Array.isArray(read(core, "overlays")) ? read(core, "overlays") : []),
    ...(Array.isArray(read(style, "overlays")) ? read(style, "overlays") : []),
  ];
  return {
    character: character({
      name: text(read(value, "name")) || stripPrefix(key, ["vmenu_mpchar_"]),
      format: "vmenu-enhanced",
      gender,
      outfits,
      defaultOutfit,
      hair: isObject(style) ? hairValue(read(style, "hairStyle"), read(style, "hairColour"), read(style, "hairHighlight")) : null,
      blend: headBlend(read(core, "blend")),
      extras: {
        tattoos: countTattoos(read(core, "tattoos")),
        overlays: countOverlays({ overlays }),
        faceFeatures: countFeatures(read(core, "faceFeatures")),
      },
    }),
  };
}

function isEnhancedSavedPed(value) {
  const appearance = read(value, "appearance");
  return isObject(appearance) && read(appearance, "modelHash") !== undefined;
}

function readEnhancedSavedPed(value, key) {
  const appearance = read(value, "appearance");
  const gender = genderForModelHash(read(appearance, "modelHash"));
  if (!gender) return { skipped: "not-freemode" };
  const outfit = enhancedOutfit(appearance, "Saved ped");
  return {
    character: character({
      name: text(read(value, "name")) || stripPrefix(key, ["vmenu_ped_"]),
      format: "vmenu-enhanced-ped",
      gender,
      outfits: [outfit],
      hair: hairValue(outfit.components.hair?.drawable, null, null),
    }),
  };
}

const READERS = [
  [isEnhancedCharacter, readEnhancedCharacter],
  [isEnhancedSavedPed, readEnhancedSavedPed],
  [isLegacyMultiplayer, readLegacyMultiplayer],
  [isLegacyPedInfo, readLegacyPedInfo],
];

function readOne(value, key, sink) {
  for (const [matches, reader] of READERS) {
    if (!matches(value)) continue;
    const result = reader(value, key);
    if (result.character) sink.characters.push(result.character);
    else sink.otherModels += 1;
    return true;
  }
  return false;
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function readValue(value, key, sink) {
  if (sink.characters.length >= MAX_CHARACTERS) return;
  if (Array.isArray(value)) {
    for (const item of value) readValue(item, key, sink);
    return;
  }
  if (!isObject(value)) return;
  // A vMenu Enhanced bundle: envelopes stored as JSON strings.
  if (read(value, "format") === VMENU_BUNDLE_FORMAT && Array.isArray(read(value, "entries"))) {
    for (const entry of read(value, "entries")) {
      const envelope = parseJson(text(read(entry, "raw")));
      if (envelope === undefined) {
        sink.unreadable += 1;
        continue;
      }
      readValue(envelope, text(read(entry, "key")), sink);
    }
    return;
  }
  // A single envelope: { key, value, type, version }.
  if (read(value, "value") !== undefined && typeof read(value, "key") === "string" && read(value, "type") !== undefined) {
    readValue(read(value, "value"), read(value, "key"), sink);
    return;
  }
  if (!readOne(value, key, sink)) sink.unrecognized += 1;
}

/* ── Menyoo outfits ── */

// Menyoo reads a slot's number from the child name after its first character,
// so `<_3>`, `<C3>` and `<P0>` all appear. Values are "drawable,texture".
function menyooSlots(node) {
  const slots = [];
  for (const child of node?.children || []) {
    const match = String(child.name || "").match(/^[A-Za-z_](\d{1,2})$/);
    if (!match) continue;
    const [drawable, texture] = String(child.text || "").split(",");
    slots.push({ slot: Number(match[1]), value: slotValue(drawable?.trim(), texture?.trim()) });
  }
  return slots;
}

function menyooNumber(node, name) {
  const raw = childText(node, name, "").trim();
  return raw === "" ? null : number(raw);
}

function readMenyooPed(node, name) {
  const gender = genderForModelHash(childText(node, "ModelHash", "").trim());
  if (!gender) return { skipped: "not-freemode" };
  const props = findChild(node, "PedProperties");
  const outfit = emptyOutfit("Saved outfit");
  for (const { slot, value } of menyooSlots(findChild(props, "PedComps"))) {
    const component = componentName(slot);
    if (component && value) outfit.components[component] = value;
  }
  for (const { slot, value } of menyooSlots(findChild(props, "PedProps"))) {
    const component = propName(slot);
    if (component && value && value.drawable >= 0) outfit.props[component] = value;
  }
  const head = findChild(props, "HeadFeatures");
  const shape = findChild(head, "ShapeAndSkinTone") || findChild(props, "ShapeAndSkinTone");
  const blend = shape
    ? headBlend({
      shapeFirst: menyooNumber(shape, "ShapeFatherId"),
      shapeSecond: menyooNumber(shape, "ShapeMotherId"),
      skinFirst: menyooNumber(shape, "ToneFatherId"),
      skinSecond: menyooNumber(shape, "ToneMotherId"),
      shapeMix: menyooNumber(shape, "ShapeVal"),
      skinMix: menyooNumber(shape, "ToneVal"),
    })
    : null;
  const overlays = (findChild(head, "Overlays")?.children || []).filter((item) => {
    const index = int(attrValue(item, "index"));
    return index !== null && index !== 255 && (float(attrValue(item, "opacity")) ?? 0) > 0;
  }).length;
  const features = (findChild(head, "FacialFeatures")?.children || [])
    .filter((item) => Math.abs(Number(item.text) || 0) > 0.001).length;
  return {
    character: character({
      name,
      format: "menyoo-outfit",
      gender,
      outfits: [outfit],
      hair: hairValue(outfit.components.hair?.drawable, menyooNumber(head, "HairColour"), menyooNumber(head, "HairColourStreaks")),
      blend,
      extras: {
        tattoos: findChild(props, "TattooLogoDecals")?.children?.length || 0,
        overlays,
        faceFeatures: features,
      },
    }),
  };
}

function looksLikeXml(raw) {
  return raw.startsWith("<");
}

// An outfit file is one ped; a Spooner file lists placements, peds among them.
function readMenyooXml(raw, name, sink) {
  let root;
  try {
    root = parseXml(raw);
  } catch (error) {
    throw new Error(error instanceof XmlParseError
      ? `The XML is damaged: ${error.message}.`
      : "That XML couldn't be read.");
  }
  const peds = [];
  const visit = (node, depth) => {
    if (!node || depth > 4) return;
    if (findChild(node, "ModelHash") && findChild(node, "PedProperties")) {
      peds.push(node);
      return;
    }
    for (const child of node.children || []) visit(child, depth + 1);
  };
  visit(root, 0);
  if (peds.length === 0) {
    throw new Error("No ped in that XML. Menyoo outfit files hold one under OutfitPedData.");
  }
  peds.slice(0, MAX_CHARACTERS).forEach((node, index) => {
    const label = childText(node, "HashName", "").trim() || (peds.length > 1 ? `${name} ${index + 1}` : name);
    const result = readMenyooPed(node, label);
    if (result.character) sink.characters.push(result.character);
    else sink.otherModels += 1;
  });
}

/** Whether text or bytes are an LSPDFR character save, which can't be read. */
export function isLspdfrSave(value) {
  if (typeof value === "string") return value.trimStart().startsWith(LSPDFR_MAGIC);
  if (!(value instanceof Uint8Array) || value.length < LSPDFR_MAGIC.length) return false;
  return [...LSPDFR_MAGIC].every((char, index) => value[index] === char.charCodeAt(0));
}

function emptyResult() {
  return { characters: [], otherModels: 0, unrecognized: 0, unreadable: 0 };
}

/**
 * Characters in pasted or opened text: a vMenu Enhanced code, a bundle, an
 * envelope, or a character's JSON. Throws with a user-facing reason when the
 * text holds nothing readable.
 */
export async function readCharacterText(input, { name = "Menyoo outfit" } = {}) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("Paste a vMenu code or a saved character's JSON.");
  if (isLspdfrSave(raw)) throw new Error(LSPDFR_SAVE_MESSAGE);
  if (looksLikeXml(raw)) {
    const result = emptyResult();
    readMenyooXml(raw, name, result);
    return result;
  }
  const json = isVmenuCode(raw) ? await decodeVmenuCode(raw) : raw;
  const value = parseJson(json);
  if (value === undefined) {
    throw new Error(isVmenuCode(raw)
      ? "The vMenu code unpacked to something that isn't JSON. It may be from a newer vMenu."
      : "That isn't a vMenu code or JSON.");
  }
  const result = emptyResult();
  readValue(value, "", result);
  if (result.characters.length === 0 && result.otherModels === 0) {
    throw new Error("No saved characters found. vMenu codes hold them under Custom characters and Saved peds.");
  }
  return result;
}

/**
 * Characters in an opened file: a Menyoo outfit or Spooner .xml, a vMenu code
 * or JSON saved as text. LSPDFR's encrypted .ls/.bak saves throw with the way
 * to bring them over instead.
 */
export async function readCharacterFile(bytes, fileName = "") {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (isLspdfrSave(data)) throw new Error(LSPDFR_SAVE_MESSAGE);
  if (data.length > MAX_FILE_BYTES) throw new Error("The file is too large to be a character save.");
  if (data.length === 0) throw new Error("The file is empty.");
  let content;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    // Menyoo declares ISO-8859-1.
    content = new TextDecoder("latin1").decode(data);
  }
  const stem = String(fileName).split(/[\\/]/).pop().replace(/\.[^.]+$/, "").trim();
  return readCharacterText(content, { name: stem || "Menyoo outfit" });
}

/**
 * Characters from the native FiveM store scan (`list_fivem_characters`).
 * Each keeps the resource it was saved under, so a menu's copies can be told
 * apart from vMenu's.
 */
export function readKvsRecords(records) {
  const result = emptyResult();
  for (const record of Array.isArray(records) ? records : []) {
    const value = parseJson(text(record?.value));
    if (value === undefined) {
      result.unreadable += 1;
      continue;
    }
    const before = result.characters.length;
    readValue(value, text(record?.key), result);
    for (const item of result.characters.slice(before)) {
      item.resource = text(record?.resource);
      item.store = text(record?.store);
      item.key = text(record?.key);
    }
  }
  result.characters.forEach((item, index) => {
    item.id = item.key ? `fivem:${item.store}:${item.resource}:${item.key}` : `fivem:${index}`;
  });
  return result;
}

/* ── Planning the base ped ── */

/** Race per heritage head from the game listing: head_diff_<nnn>_<letter>_<race>.ytd. */
export function headRacesFromListing(entries, ped) {
  const races = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (String(entry?.folder || "").toLowerCase() !== ped) continue;
    const match = String(entry.file || "").toLowerCase().match(/^head_diff_(\d{3})_[a-z]_([a-z]{3})\.ytd$/);
    if (match && !races.has(Number(match[1]))) races.set(Number(match[1]), match[2]);
  }
  return races;
}

// The game folder a saved collection name lives in. The base collection
// ("") is the ped's own folder; DLC folders are `<ped>_<collection>`, props
// `<ped>_p_<collection>`.
function collectionFolders(ped, collection) {
  if (!collection) return [ped, `${ped}_p`];
  return [`${ped}_${collection}`, `${ped}_p_${collection}`];
}

function letterFor(texture, variants) {
  const letter = texture >= 0 && texture < 26 ? String.fromCharCode(97 + texture) : null;
  if (!letter) return { variant: "a", missing: true };
  if (variants && variants.length > 0 && !variants.includes(letter)) return { variant: "a", missing: true };
  return { variant: letter, missing: false };
}

// Resolves one saved value to a game drawable number for this ped.
function resolveSlot(slot, ped, index) {
  if (!index) {
    // No game listing (browser preview): trust the saved number.
    return { index: slot.drawable, variant: letterFor(slot.texture, null).variant };
  }
  const gameTotal = index.gameTotal ?? index.total;
  const servers = index.total > gameTotal;
  let number = null;
  let byCollection = false;
  if (slot.collection !== null && slot.local !== null) {
    const folders = collectionFolders(ped, slot.collection);
    const range = index.ranges.find((item) => folders.includes(item.folder));
    if (!range || slot.local >= range.count) {
      return {
        error: slot.collection
          ? `clothing pack ${slot.collection} isn't in your game files${servers ? " or loaded packs" : ""}`
          : `drawable ${slot.drawable} isn't in your game files`,
      };
    }
    number = range.start + slot.local;
    byCollection = true;
  } else {
    number = slot.drawable;
  }
  if (!index.variants.has(number)) {
    let error = `drawable ${number} isn't in your game files`;
    if (number >= index.total) {
      error = servers
        ? `drawable ${number} is past the game's ${gameTotal} and your loaded packs' ${index.total - gameTotal}, so it comes from server clothing you haven't loaded`
        : `drawable ${number} is past the game's ${gameTotal}, so it comes from server clothing`;
    }
    return { error };
  }
  const { variant, missing } = letterFor(slot.texture, index.variants.get(number));
  const source = resolveDrawableNumber(index.ranges, number);
  return {
    index: number,
    variant,
    textureMissing: missing ? slot.texture : null,
    // A plain number only lands on the right server drawable when your packs
    // load in the server's order; a recorded collection doesn't depend on it.
    server: source?.server ? { pack: source.pack, byOrder: !byCollection } : null,
  };
}

function describeServerSlots(slots) {
  if (slots.length === 0) return [];
  const list = slots.map(({ component, pack }) => `${componentDisplayName(component).toLowerCase()} from ${pack}`);
  const notes = [`From your loaded clothing packs: ${list.join(", ")}.`];
  if (slots.some((slot) => slot.byOrder)) {
    notes.push("Numbers past the game's clothing assume the server loads your packs in the order you added them.");
  }
  return notes;
}

function dominant(first, second, mix) {
  return mix >= 0.5 ? second : first;
}

/**
 * What wearing one outfit of a character does to EUP Studio: the base
 * overrides for its ped (components and props), hair colours, skin tone, and
 * a list of what couldn't be carried over. `context.gameIndexes` maps
 * components and props to `buildGameDrawableIndex` results for the
 * character's ped; `context.headRaces` comes from `headRacesFromListing`.
 */
export function planCharacterImport(character, outfitIndex = character?.defaultOutfit ?? 0, context = {}) {
  const gender = character?.gender === "female" ? "female" : "male";
  const ped = PED_FOR_GENDER[gender];
  const outfit = character?.outfits?.[outfitIndex] || character?.outfits?.[0] || emptyOutfit("");
  const indexes = context.gameIndexes || null;
  const overrides = {};
  const skipped = [];
  const notes = [];
  const serverSlots = [];
  let carried = 0;

  for (const component of COMPONENT_IDS) {
    let slot = outfit.components[component];
    if (component === "hair" && character.hair?.style !== null && character.hair?.style !== undefined) {
      slot = { ...(slot || { texture: 0, collection: null, local: null }), drawable: character.hair.style };
      // A style's number is global: the collection recorded for the outfit's
      // hair slot may belong to a different drawable.
      if (outfit.components.hair?.drawable !== character.hair.style) {
        slot.collection = null;
        slot.local = null;
      }
    }
    if (!slot) continue;
    const resolved = resolveSlot(slot, ped, indexes?.[component]);
    if (resolved.error) {
      skipped.push({ component, reason: resolved.error });
      continue;
    }
    overrides[component] = { index: resolved.index, variant: resolved.variant, enabled: true };
    if (resolved.textureMissing !== null && resolved.textureMissing !== undefined) {
      skipped.push({ component, reason: `texture ${resolved.textureMissing} isn't in the game files, so it shows texture a` });
    }
    if (resolved.server) serverSlots.push({ component, ...resolved.server });
    carried += 1;
  }

  for (const component of PROP_IDS) {
    const slot = outfit.props[component];
    if (!slot || slot.drawable < 0) continue;
    const resolved = resolveSlot(slot, ped, indexes?.[component]);
    if (resolved.error) {
      skipped.push({ component, reason: resolved.error });
      continue;
    }
    overrides[component] = { index: resolved.index, variant: resolved.variant, enabled: true };
    if (resolved.server) serverSlots.push({ component, ...resolved.server });
    carried += 1;
  }
  notes.push(...describeServerSlots(serverSlots));

  // The face: the dominant heritage parent's head. vMenu's head slot is
  // almost always 0 because the game builds the face from the blend.
  let skinTone = null;
  const blend = character?.headBlend;
  if (blend) {
    const head = dominant(blend.shapeFirst, blend.shapeSecond, blend.shapeMix);
    const headIndex = indexes?.head;
    if (head >= 0 && head <= MAX_PARENT_FACE && (!headIndex || headIndex.variants.has(head))) {
      overrides.head = { index: head, variant: "a", enabled: true };
      notes.push(`Face ${head}, the closer of its two parent faces. Blended faces show one parent.`);
    } else {
      skipped.push({ component: "head", reason: `parent face ${head} isn't in your game files` });
    }
    const skinHead = dominant(blend.skinFirst, blend.skinSecond, blend.skinMix);
    const race = context.headRaces?.get?.(skinHead);
    skinTone = race ? RACE_SKIN_TONES[race] || null : null;
    if (!skinTone) notes.push("Skin tone kept: the saved skin parent has no matching tone here.");
  }

  const colorAt = (value) => (Number.isInteger(value) && value >= 0 && value < GTA_HAIR_COLORS.length ? GTA_HAIR_COLORS[value] : null);
  const hairColor = colorAt(character?.hair?.color);
  const hair = hairColor ? { color: hairColor, highlight: colorAt(character.hair.highlight) || hairColor } : null;

  const notShown = [];
  const extras = character?.extras || {};
  if (extras.faceFeatures > 0) notShown.push("face shape sliders");
  if (extras.overlays > 0) notShown.push("beard, eyebrows and makeup");
  if (extras.tattoos > 0) notShown.push(`${extras.tattoos} tattoo${extras.tattoos === 1 ? "" : "s"}`);

  return {
    gender,
    outfitName: outfit.name,
    overrides,
    hair,
    skinTone,
    carried,
    skipped,
    notes,
    notShown,
  };
}
