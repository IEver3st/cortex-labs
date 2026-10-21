export const ITEM_FLAGS = Object.freeze([
  { bit: 0x10000, label: "Hidden in first person", game: "PV_FLAG_HIDE_IN_FIRST_PERSON" },
  { bit: 0x20, label: "Not in vehicles", game: "PV_FLAG_NOT_IN_CAR" },
  { bit: 0x200, label: "Armoured", game: "PV_FLAG_ARMOURED" },
  { bit: 0x400, label: "Lightly armoured", game: "PV_FLAG_LIGHTLY_ARMOURED" },
  { bit: 0x100, label: "Fire retardant", game: "PV_FLAG_FIRE_RETARDENT" },
  { bit: 0x1, label: "Bulky", game: "PV_FLAG_BULKY" },
]);

export const HELMET_FLAGS = Object.freeze([
  { bit: 0x1000, label: "Default helmet", game: "PV_FLAG_DEFAULT_HELMET" },
  { bit: 0x2000, label: "Random helmet", game: "PV_FLAG_RANDOM_HELMET" },
  { bit: 0x4000, label: "Script helmet", game: "PV_FLAG_SCRIPT_HELMET" },
  { bit: 0x8000, label: "Flight helmet", game: "PV_FLAG_FLIGHT_HELMET" },
  { bit: 0x40000, label: "Pilot helmet", game: "PV_FLAG_PILOT_HELMET" },
  { bit: 0x20000, label: "Physics hat", game: "PV_FLAG_USE_PHYSICS_HAT_2" },
]);

const SOUND_SETS = Object.freeze({
  feet: [
    ["none", "None"],
    ["shoe_trainers", "Trainers"],
    ["shoe_heels", "Heels"],
    ["shoe_heavy_boots", "Heavy boots"],
    ["shoe_dress_shoes", "Dress shoes"],
    ["shoe_rubber", "Rubber soles"],
    ["shoe_rubber_boots", "Rubber boots"],
    ["shoe_flip_flops", "Flip-flops"],
    ["shoe_barefoot", "Barefoot"],
  ],
  upper: [
    ["none", "None"],
    ["cloth_upper_shirt_tee", "T-shirt"],
    ["cloth_upper_shirt_cotton_lite", "Light cotton shirt"],
    ["cloth_upper_shirt_cotton_heavy", "Heavy cotton shirt"],
    ["cloth_upper_cotton", "Cotton"],
    ["cloth_upper_sweater", "Sweater"],
    ["cloth_upper_jacket_cotton", "Cotton jacket"],
    ["cloth_upper_jacket_puffy", "Puffer jacket"],
    ["cloth_upper_jacket_suit", "Suit jacket"],
    ["cloth_upper_jacket_leather", "Leather jacket"],
    ["cloth_upper_bikini_top", "Bikini top"],
    ["cloth_upper_spacesuit", "Spacesuit"],
  ],
  lower: [
    ["none", "None"],
    ["cloth_lower_cotton", "Cotton"],
    ["cloth_lower_pants_denim", "Denim"],
    ["cloth_lower_pants_suit", "Suit trousers"],
    ["cloth_lower_pants_tight", "Tight trousers"],
    ["cloth_lower_pants_leather", "Leather trousers"],
    ["cloth_lower_shorts", "Shorts"],
    ["cloth_lower_skirt_short", "Short skirt"],
    ["cloth_lower_skirt_long", "Long skirt"],
    ["cloth_lower_swat", "Tactical"],
    ["cloth_lower_bare", "Bare"],
  ],
  hand: [
    ["none", "None"],
    ["cloth_rappel_parachute", "Parachute bag"],
  ],
});

const SOUND_SET_FOR_SLOT = Object.freeze({ 3: "upper", 4: "lower", 5: "hand", 6: "feet", 11: "upper" });

export const HAIR_SLOT = 2;
export const FEET_SLOT = 6;
export const HAT_ANCHOR = 0;

export const HAIR_SQUASH_INDEX = 2;
export const HEEL_INDEX = 4;
export const HAT_FLATTEN_INDEX = 0;

export const GAME_HAIR_SQUASH = 0.184;
export const GAME_HAT_FLATTEN = 0.5;

const HAT_EXPRESSION = Object.freeze({ index: HAT_FLATTEN_INDEX, track: 33, id: 13201 });
const HEEL_EXPRESSION = Object.freeze({ index: HEEL_INDEX, track: 33, id: 28462 });

export const RENDER_MODES = Object.freeze([
  ["", "Opaque"],
  ["PRF_ALPHA", "Alpha blend"],
  ["PRF_CUTOUT", "Cutout"],
  ["PRF_DECAL", "Decal"],
]);

export function soundChoices(slotId, current) {
  const set = SOUND_SETS[SOUND_SET_FOR_SLOT[slotId]];
  if (!set) return null;
  const value = current || "none";
  if (set.some(([id]) => id === value)) return set;
  return [...set, [value, value]];
}

export function expressionValues(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").trim().split(/\s+/);
  return Array.from({ length: 5 }, (_, index) => {
    const number = Number(list[index]);
    return Number.isFinite(number) ? number : 0;
  });
}

function formatNumber(value) {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

export function expressionText(values) {
  return expressionValues(values).map(formatNumber).join(" ");
}

export function withExpression(values, index, value) {
  const next = expressionValues(values);
  next[index] = Math.round(value * 1000) / 1000;
  return next;
}

export function hasFlag(flags, bit) {
  return (Number(flags) & bit) === bit;
}

export function withFlag(flags, bit, on) {
  const value = Number(flags) || 0;
  return (on ? value | bit : value & ~bit) >>> 0;
}

export function otherFlags(flags, known) {
  return known.reduce((rest, flag) => rest & ~flag.bit, Number(flags) || 0) >>> 0;
}

export function itemProperties({ isProp, info, prop, edit }) {
  const base = isProp
    ? { audioId: prop?.audioId ?? "", flags: prop?.propFlags ?? 0, expressionMods: expressionValues(prop?.expressionMods), renderFlags: prop?.renderFlags ?? "" }
    : { audioId: info?.audioId || "none", flags: info?.flags ?? 0, expressionMods: expressionValues(info?.expressionMods), renderFlags: "" };
  if (!edit) return base;
  return {
    audioId: edit.audioId ?? base.audioId,
    flags: edit.flags ?? base.flags,
    expressionMods: edit.expressionMods ? expressionValues(edit.expressionMods) : base.expressionMods,
    renderFlags: edit.renderFlags ?? base.renderFlags,
  };
}

export function editedComponentInfo(info, edit) {
  if (!edit) return info;
  return {
    ...info,
    ...(edit.audioId != null ? { audioId: edit.audioId } : {}),
    ...(edit.flags != null ? { flags: edit.flags } : {}),
    ...(edit.expressionMods ? { expressionMods: expressionText(edit.expressionMods) } : {}),
  };
}

export function editedPropMeta(prop, edit) {
  if (!edit) return prop;
  return {
    ...prop,
    ...(edit.flags != null ? { propFlags: edit.flags } : {}),
    ...(edit.expressionMods ? { expressionMods: expressionText(edit.expressionMods) } : {}),
    ...(edit.renderFlags != null ? { renderFlags: edit.renderFlags } : {}),
  };
}

export function normalizeItemEdit(value) {
  if (!value || typeof value !== "object") return null;
  const edit = {};
  if (value.out === true) edit.out = true;
  if (typeof value.audioId === "string" && /^[a-z0-9_]{1,64}$/i.test(value.audioId)) edit.audioId = value.audioId;
  if (Number.isInteger(value.flags) && value.flags >= 0 && value.flags <= 0xffffffff) edit.flags = value.flags;
  if (Array.isArray(value.expressionMods) && value.expressionMods.length === 5 && value.expressionMods.every((number) => Number.isFinite(number) && Math.abs(number) <= 10)) {
    edit.expressionMods = value.expressionMods.slice();
  }
  if (typeof value.renderFlags === "string" && RENDER_MODES.some(([mode]) => mode === value.renderFlags)) edit.renderFlags = value.renderFlags;
  return Object.keys(edit).length ? edit : null;
}

export const hatFlatten = (values) => Math.max(0, -expressionValues(values)[HAT_FLATTEN_INDEX]);
export const hairSquash = (values) => Math.max(0, expressionValues(values)[HAIR_SQUASH_INDEX]);
export const heelHeight = (values) => Math.max(0, expressionValues(values)[HEEL_INDEX]);

export function previewHairCrush({ hat = null, hair = null }) {
  if (hat == null) return null;
  return { hat: -1.5 * hat, hair: hair == null ? null : -hair };
}

export const creatureFileName = (dlc) => `mp_creaturemetadata_${dlc}.ymt`;

function expressionItem(lines, kind, slot, index, expression) {
  const tag = kind === "prop" ? "pedProp" : "pedComp";
  lines.push(
    "  <Item>",
    `   <${tag}ID value="${slot}" />`,
    `   <${tag}VarIndex value="${index}" />`,
    `   <${tag}ExpressionIndex value="${expression.index}" />`,
    `   <tracks>${expression.track}</tracks>`,
    `   <ids>${expression.id}</ids>`,
    "   <types>2</types>",
    "   <components>1</components>",
    "  </Item>",
  );
}

export function creatureMetadataXml({ hats = [], heels = [] }) {
  if (!hats.length && !heels.length) return null;
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', "<CCreatureMetaData>", ' <shaderVariableComponents itemType="CShaderVariableComponent" />'];
  if (hats.length) {
    lines.push(' <pedPropExpressions itemType="CPedPropExpressionData">');
    for (const index of hats) expressionItem(lines, "prop", HAT_ANCHOR, index, HAT_EXPRESSION);
    lines.push(" </pedPropExpressions>");
  } else lines.push(' <pedPropExpressions itemType="CPedPropExpressionData" />');
  if (heels.length) {
    lines.push(' <pedCompExpressions itemType="CPedCompExpressionData">');
    for (const index of heels) expressionItem(lines, "comp", FEET_SLOT, index, HEEL_EXPRESSION);
    lines.push(" </pedCompExpressions>");
  } else lines.push(' <pedCompExpressions itemType="CPedCompExpressionData" />');
  lines.push("</CCreatureMetaData>", "");
  return lines.join("\n");
}
