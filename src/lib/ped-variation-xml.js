// A freemode clothing pack's ped variation file (`<ped>_<dlc>.ymt`, a
// CPedVariationInfo) as CodeWalker writes it in XML. The bridge converts the
// binary file to and from this XML (readPedVariation / writePedVariation);
// this module reads it into a plain model, edits it and writes it back in the
// same layout, so a file read and written unchanged comes out identical.
//
// The game finds a clothing item's files from this data: a drawable's
// `propMask` decides `_u` or `_r`, each texture's `texId` the race suffix of
// its `_diff_` file (props number their textures instead), and the counts
// say how many letters each item has. Every field CodeWalker writes is kept;
// an element this module does not know is an error, never silently dropped.

import { attrValue, findChild, findChildren, parseXml } from "./xml-lite.js";

export const ANCHOR_NAMES = Object.freeze([
  "ANCHOR_HEAD",
  "ANCHOR_EYES",
  "ANCHOR_EARS",
  "ANCHOR_MOUTH",
  "ANCHOR_LEFT_HAND",
  "ANCHOR_RIGHT_HAND",
  "ANCHOR_LEFT_WRIST",
  "ANCHOR_RIGHT_WRIST",
  "ANCHOR_HIP",
  "ANCHOR_LEFT_FOOT",
  "ANCHOR_RIGHT_FOOT",
  "ANCHOR_PH_L_HAND",
  "ANCHOR_PH_R_HAND",
]);

export const COMPONENT_COUNT = 12;
const UNUSED = 255;

const ROOT_FIELDS = ["bHasTexVariations", "bHasDrawblVariations", "bHasLowLODs", "bIsSuperLOD", "availComp", "aComponentData3", "aSelectionSets", "compInfos", "propInfo", "dlcName"];
const DRAWABLE_FIELDS = ["propMask", "numAlternatives", "aTexData", "clothData"];
const INFO_FIELDS = ["pedXml_audioID", "pedXml_audioID2", "pedXml_expressionMods", "flags", "inclusions", "exclusions", "pedXml_vfxComps", "pedXml_flags", "pedXml_compIdx", "pedXml_drawblIdx"];
const PROP_FIELDS = ["audioId", "expressionMods", "texData", "renderFlags", "propFlags", "flags", "anchorId", "propId", "stickyness"];
const PROP_TEXTURE_FIELDS = ["inclusions", "exclusions", "texId", "inclusionId", "exclusionId", "distribution"];

export class PedVariationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PedVariationError";
  }
}

function fail(message) {
  throw new PedVariationError(message);
}

function onlyFields(node, allowed, where) {
  for (const child of node.children || []) {
    if (!allowed.includes(child.name)) fail(`${where} has an element Cortex does not know: <${child.name}>.`);
  }
}

function need(node, name, where) {
  const child = findChild(node, name);
  if (!child) fail(`${where} is missing <${name}>.`);
  return child;
}

function int(node, name, where) {
  const raw = attrValue(need(node, name, where), "value");
  if (raw == null || !/^-?\d+$/.test(String(raw).trim())) fail(`${where} <${name}> is not a whole number.`);
  return Number(raw);
}

function bool(node, name, where) {
  const raw = String(attrValue(need(node, name, where), "value") ?? "").trim().toLowerCase();
  if (raw !== "true" && raw !== "false") fail(`${where} <${name}> is not true or false.`);
  return raw === "true";
}

const text = (node, name, where) => need(node, name, where).text;

function items(node, name, where) {
  const array = need(node, name, where);
  const list = findChildren(array, null);
  for (const item of list) {
    if (item.name !== "Item") fail(`${where} <${name}> holds <${item.name}> instead of items.`);
  }
  return list;
}

function numbers(value, where) {
  const parts = String(value || "").trim().split(/\s+/).filter(Boolean);
  if (parts.some((part) => !/^\d+$/.test(part))) fail(`${where} is not a list of numbers.`);
  return parts.map(Number);
}

function parseTexture(item, where) {
  onlyFields(item, ["texId", "distribution"], where);
  return { texId: int(item, "texId", where), distribution: int(item, "distribution", where) };
}

function parseDrawable(item, where) {
  onlyFields(item, DRAWABLE_FIELDS, where);
  const cloth = need(item, "clothData", where);
  onlyFields(cloth, ["ownsCloth"], `${where} clothData`);
  return {
    propMask: int(item, "propMask", where),
    numAlternatives: int(item, "numAlternatives", where),
    textures: items(item, "aTexData", where).map((texture, index) => parseTexture(texture, `${where} texture ${index}`)),
    ownsCloth: bool(cloth, "ownsCloth", `${where} clothData`),
  };
}

function parseInfo(item, where) {
  onlyFields(item, INFO_FIELDS, where);
  return {
    audioId: text(item, "pedXml_audioID", where),
    audioId2: text(item, "pedXml_audioID2", where),
    expressionMods: text(item, "pedXml_expressionMods", where),
    flags: int(item, "flags", where),
    inclusions: text(item, "inclusions", where),
    exclusions: text(item, "exclusions", where),
    vfxComps: text(item, "pedXml_vfxComps", where),
    pedFlags: int(item, "pedXml_flags", where),
    compIdx: int(item, "pedXml_compIdx", where),
    drawblIdx: int(item, "pedXml_drawblIdx", where),
  };
}

function parsePropTexture(item, where) {
  onlyFields(item, PROP_TEXTURE_FIELDS, where);
  return {
    inclusions: text(item, "inclusions", where),
    exclusions: text(item, "exclusions", where),
    texId: int(item, "texId", where),
    inclusionId: int(item, "inclusionId", where),
    exclusionId: int(item, "exclusionId", where),
    distribution: int(item, "distribution", where),
  };
}

function parseProp(item, where) {
  onlyFields(item, PROP_FIELDS, where);
  return {
    audioId: text(item, "audioId", where),
    expressionMods: text(item, "expressionMods", where),
    textures: items(item, "texData", where).map((texture, index) => parsePropTexture(texture, `${where} texture ${index}`)),
    renderFlags: text(item, "renderFlags", where),
    propFlags: int(item, "propFlags", where),
    flags: int(item, "flags", where),
    anchorId: int(item, "anchorId", where),
    propId: int(item, "propId", where),
    stickyness: int(item, "stickyness", where),
  };
}

// The raw markup of an element, kept as written: selection sets name
// drawables by number and are carried through untouched.
function rawElement(source, node) {
  return source.slice(node.start, node.end);
}

/**
 * Reads CodeWalker's XML for a ped variation file into
 * `{ name, flags, availComp, components, selectionSets, compInfos, props, dlcName }`.
 * `components[i]` is the i-th CPVComponentData with `type`, the component id
 * that `availComp` points at it (null when none does). Throws PedVariationError.
 */
export function parsePedVariationXml(xml) {
  const source = String(xml || "").replace(/^﻿/, "");
  let root;
  try {
    root = parseXml(source, { positions: true });
  } catch (error) {
    fail(`The ped variation XML could not be read: ${error.message}`);
  }
  if (root.name !== "CPedVariationInfo") fail(`This is a ${root.name}, not a ped variation file.`);
  onlyFields(root, ROOT_FIELDS, "The ped variation file");
  const where = "The ped variation file";

  const availComp = numbers(text(root, "availComp", where), "availComp");
  if (availComp.length !== COMPONENT_COUNT) fail("availComp does not list 12 components.");
  const components = items(root, "aComponentData3", where).map((item, index) => {
    const at = `Component data ${index}`;
    onlyFields(item, ["numAvailTex", "aDrawblData3"], at);
    return {
      type: null,
      numAvailTex: int(item, "numAvailTex", at),
      drawables: items(item, "aDrawblData3", at).map((drawable, slot) => parseDrawable(drawable, `${at} drawable ${slot}`)),
    };
  });
  availComp.forEach((value, type) => {
    if (value === UNUSED) return;
    if (value >= components.length) fail(`availComp points component ${type} at data ${value}, which the file does not hold.`);
    if (components[value].type != null) fail(`availComp points two components at data ${value}.`);
    components[value].type = type;
  });

  const propInfo = need(root, "propInfo", where);
  onlyFields(propInfo, ["numAvailProps", "aPropMetaData", "aAnchors"], "propInfo");
  const anchors = items(propInfo, "aAnchors", "propInfo").map((item, index) => {
    const at = `Anchor ${index}`;
    onlyFields(item, ["props", "anchor"], at);
    return { props: numbers(text(item, "props", at), `${at} props`), anchor: text(item, "anchor", at) };
  });

  return {
    // Rockstar's base peds leave the name out.
    name: attrValue(root, "name", null),
    flags: {
      texVariations: bool(root, "bHasTexVariations", where),
      drawblVariations: bool(root, "bHasDrawblVariations", where),
      lowLods: bool(root, "bHasLowLODs", where),
      superLod: bool(root, "bIsSuperLOD", where),
    },
    availComp,
    components,
    selectionSets: rawElement(source, need(root, "aSelectionSets", where)),
    compInfos: items(root, "compInfos", where).map((item, index) => parseInfo(item, `Component info ${index}`)),
    props: {
      numAvailProps: int(propInfo, "numAvailProps", "propInfo"),
      metas: items(propInfo, "aPropMetaData", "propInfo").map((item, index) => parseProp(item, `Prop ${index}`)),
      anchors,
    },
    dlcName: text(root, "dlcName", where),
  };
}

/* ── Writing ── */

const escapeText = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (value) => escapeText(value).replace(/"/g, "&quot;");

function lineWriter() {
  const lines = [];
  return {
    lines,
    value: (depth, name, value) => lines.push(`${" ".repeat(depth)}<${name} value="${escapeAttr(value)}" />`),
    text: (depth, name, value) => lines.push(String(value ?? "") === ""
      ? `${" ".repeat(depth)}<${name} />`
      : `${" ".repeat(depth)}<${name}>${escapeText(value)}</${name}>`),
    array(depth, name, type, list, writeItem) {
      const pad = " ".repeat(depth);
      if (!list.length) {
        lines.push(`${pad}<${name} itemType="${type}" />`);
        return;
      }
      lines.push(`${pad}<${name} itemType="${type}">`);
      for (const entry of list) {
        lines.push(`${pad} <Item>`);
        writeItem(entry, depth + 2);
        lines.push(`${pad} </Item>`);
      }
      lines.push(`${pad}</${name}>`);
    },
    // A byte array, as CodeWalker's WriteRawArray lays it out: one line up to
    // ten values, else rows of ten on their own lines.
    bytes(depth, name, list) {
      const pad = " ".repeat(depth);
      if (list.length <= 10) {
        this.text(depth, name, list.join(" "));
        return;
      }
      lines.push(`${pad}<${name}>`);
      for (let at = 0; at < list.length; at += 10) lines.push(`${pad} ${list.slice(at, at + 10).join(" ")}`);
      lines.push(`${pad}</${name}>`);
    },
    open: (depth, name) => lines.push(`${" ".repeat(depth)}<${name}>`),
    close: (depth, name) => lines.push(`${" ".repeat(depth)}</${name}>`),
    raw: (depth, markup) => lines.push(`${" ".repeat(depth)}${markup}`),
  };
}

/** The model as CodeWalker's XML, ready for the bridge's writePedVariation. */
export function pedVariationXml(model) {
  const w = lineWriter();
  w.lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  w.lines.push(model.name == null ? "<CPedVariationInfo>" : `<CPedVariationInfo name="${escapeAttr(model.name)}">`);
  w.value(1, "bHasTexVariations", model.flags.texVariations ? "true" : "false");
  w.value(1, "bHasDrawblVariations", model.flags.drawblVariations ? "true" : "false");
  w.value(1, "bHasLowLODs", model.flags.lowLods ? "true" : "false");
  w.value(1, "bIsSuperLOD", model.flags.superLod ? "true" : "false");
  w.text(1, "availComp", model.availComp.join(" "));
  w.array(1, "aComponentData3", "CPVComponentData", model.components, (component, depth) => {
    w.value(depth, "numAvailTex", component.numAvailTex);
    w.array(depth, "aDrawblData3", "CPVDrawblData", component.drawables, (drawable, inner) => {
      w.value(inner, "propMask", drawable.propMask);
      w.value(inner, "numAlternatives", drawable.numAlternatives);
      w.array(inner, "aTexData", "CPVTextureData", drawable.textures, (texture, deepest) => {
        w.value(deepest, "texId", texture.texId);
        w.value(deepest, "distribution", texture.distribution);
      });
      w.open(inner, "clothData");
      w.value(inner + 1, "ownsCloth", drawable.ownsCloth ? "true" : "false");
      w.close(inner, "clothData");
    });
  });
  w.raw(1, model.selectionSets || '<aSelectionSets itemType="CPedSelectionSet" />');
  w.array(1, "compInfos", "CComponentInfo", model.compInfos, (info, depth) => {
    w.text(depth, "pedXml_audioID", info.audioId);
    w.text(depth, "pedXml_audioID2", info.audioId2);
    w.text(depth, "pedXml_expressionMods", info.expressionMods);
    w.value(depth, "flags", info.flags);
    w.text(depth, "inclusions", info.inclusions);
    w.text(depth, "exclusions", info.exclusions);
    w.text(depth, "pedXml_vfxComps", info.vfxComps);
    w.value(depth, "pedXml_flags", info.pedFlags);
    w.value(depth, "pedXml_compIdx", info.compIdx);
    w.value(depth, "pedXml_drawblIdx", info.drawblIdx);
  });
  w.open(1, "propInfo");
  w.value(2, "numAvailProps", model.props.numAvailProps);
  w.array(2, "aPropMetaData", "CPedPropMetaData", model.props.metas, (prop, depth) => {
    w.text(depth, "audioId", prop.audioId);
    w.text(depth, "expressionMods", prop.expressionMods);
    w.array(depth, "texData", "CPedPropTexData", prop.textures, (texture, inner) => {
      w.text(inner, "inclusions", texture.inclusions);
      w.text(inner, "exclusions", texture.exclusions);
      w.value(inner, "texId", texture.texId);
      w.value(inner, "inclusionId", texture.inclusionId);
      w.value(inner, "exclusionId", texture.exclusionId);
      w.value(inner, "distribution", texture.distribution);
    });
    w.text(depth, "renderFlags", prop.renderFlags);
    w.value(depth, "propFlags", prop.propFlags);
    w.value(depth, "flags", prop.flags);
    w.value(depth, "anchorId", prop.anchorId);
    w.value(depth, "propId", prop.propId);
    w.value(depth, "stickyness", prop.stickyness);
  });
  w.array(2, "aAnchors", "CAnchorProps", model.props.anchors, (anchor, depth) => {
    w.bytes(depth, "props", anchor.props);
    w.text(depth, "anchor", anchor.anchor);
  });
  w.close(1, "propInfo");
  w.text(1, "dlcName", model.dlcName);
  w.lines.push("</CPedVariationInfo>");
  return `${w.lines.join("\n")}\n`;
}

/* ── Reading and editing items ── */

/** The CPVComponentData of component `type` (0 head … 11 jbib), or null. */
export function componentData(model, type) {
  const at = model.availComp[type];
  return at == null || at === UNUSED ? null : model.components[at] || null;
}

/** Drawable `index` of component `type` with its component info, or null. */
export function drawableEntry(model, type, index) {
  const drawable = componentData(model, type)?.drawables[index];
  if (!drawable) return null;
  const info = model.compInfos.find((entry) => entry.compIdx === type && entry.drawblIdx === index) || null;
  return { drawable, info };
}

/** Prop `propId` at anchor `anchorId`, or null. */
export function propEntry(model, anchorId, propId) {
  return model.props.metas.find((prop) => prop.anchorId === anchorId && prop.propId === propId) || null;
}

/** How many textures (letters) an item has according to the file. */
export function itemTextureCount(model, { isProp, slotId, index }) {
  if (isProp) return propEntry(model, slotId, index)?.textures.length ?? null;
  return drawableEntry(model, slotId, index)?.drawable.textures.length ?? null;
}

function hasTextureVariations(model) {
  return model.components.some((component) => component.drawables.some((drawable) => drawable.textures.length > 1))
    || model.props.metas.some((prop) => prop.textures.length > 1);
}

/**
 * A copy of `model` where the item has `count` more textures, each like its
 * last one (a component texture keeps that texture's race id; a prop texture
 * is numbered after it). The component's texture total, the anchor's
 * per-prop counts and the texture-variation flag follow. Throws when the
 * file does not list the item.
 */
export function withAddedTextures(model, { isProp, slotId, index }, count) {
  const next = structuredClone(model);
  if (isProp) {
    const prop = propEntry(next, slotId, index);
    if (!prop) fail(`The ped variation file has no prop ${index} at ${ANCHOR_NAMES[slotId] || slotId}.`);
    const last = prop.textures[prop.textures.length - 1];
    for (let n = 0; n < count; n += 1) {
      const texId = prop.textures.length;
      prop.textures.push(last ? { ...last, texId } : { inclusions: "0", exclusions: "0", texId, inclusionId: 0, exclusionId: 0, distribution: 255 });
    }
    const anchor = next.props.anchors.find((entry) => entry.anchor === ANCHOR_NAMES[slotId]);
    if (!anchor || anchor.props[index] == null) fail(`The ped variation file does not count prop ${index} at ${ANCHOR_NAMES[slotId]}.`);
    anchor.props[index] = prop.textures.length;
  } else {
    const component = componentData(next, slotId);
    const drawable = component?.drawables[index];
    if (!drawable) fail(`The ped variation file has no drawable ${index} for component ${slotId}.`);
    const last = drawable.textures[drawable.textures.length - 1];
    for (let n = 0; n < count; n += 1) drawable.textures.push(last ? { ...last } : { texId: 0, distribution: 255 });
    component.numAvailTex = component.drawables.reduce((sum, entry) => sum + entry.textures.length, 0);
  }
  next.flags.texVariations = hasTextureVariations(next);
  return next;
}

/* ── Building ── */

/** The component info a drawable gets when its source file had none. */
export function defaultComponentInfo(type, index) {
  return {
    audioId: "none",
    audioId2: "",
    expressionMods: "0 0 0 0 0",
    flags: 0,
    inclusions: "0",
    exclusions: "0",
    vfxComps: "PV_COMP_HEAD",
    pedFlags: 0,
    compIdx: type,
    drawblIdx: index,
  };
}

/** The prop data a prop gets when its source file had none. */
export function defaultPropMeta(anchorId, propId, textureCount) {
  return {
    audioId: "",
    expressionMods: "0 0 0 0 0",
    textures: Array.from({ length: textureCount }, (_, texId) => ({ inclusions: "0", exclusions: "0", texId, inclusionId: 0, exclusionId: 0, distribution: 255 })),
    renderFlags: "",
    propFlags: 0,
    flags: 0,
    anchorId,
    propId,
    stickyness: 0,
  };
}

/**
 * A new ped variation file for one pack. `components` maps a component id to
 * its drawables in order, each `{ drawable, info }` (CPVDrawblData and
 * CComponentInfo fields; `info` may be null); `props` maps an anchor id to its
 * props in order, each a CPedPropMetaData. Numbers, counts and flags are
 * worked out here, so the parts can come from different packs.
 */
export function buildPedVariation({ name, dlcName, components = new Map(), props = new Map() }) {
  const availComp = Array(COMPONENT_COUNT).fill(UNUSED);
  const data = [];
  const compInfos = [];
  for (let type = 0; type < COMPONENT_COUNT; type += 1) {
    const list = components.get(type) || [];
    if (!list.length) continue;
    availComp[type] = data.length;
    const drawables = list.map(({ drawable }) => ({
      propMask: drawable.propMask,
      numAlternatives: drawable.numAlternatives,
      textures: drawable.textures.map((texture) => ({ texId: texture.texId, distribution: texture.distribution })),
      ownsCloth: Boolean(drawable.ownsCloth),
    }));
    data.push({ type, numAvailTex: drawables.reduce((sum, drawable) => sum + drawable.textures.length, 0), drawables });
    list.forEach(({ info }, index) => compInfos.push({ ...(info || defaultComponentInfo(type, index)), compIdx: type, drawblIdx: index }));
  }
  const metas = [];
  const anchors = [];
  for (let anchorId = 0; anchorId < ANCHOR_NAMES.length; anchorId += 1) {
    const list = props.get(anchorId) || [];
    if (!list.length) continue;
    list.forEach((prop, propId) => metas.push({
      ...prop,
      textures: prop.textures.map((texture, texId) => ({ ...texture, texId })),
      anchorId,
      propId,
    }));
    anchors.push({ props: list.map((prop) => prop.textures.length), anchor: ANCHOR_NAMES[anchorId] });
  }
  const model = {
    name,
    flags: { texVariations: false, drawblVariations: true, lowLods: false, superLod: false },
    availComp,
    components: data,
    selectionSets: '<aSelectionSets itemType="CPedSelectionSet" />',
    compInfos,
    props: { numAvailProps: metas.length, metas, anchors },
    dlcName,
  };
  model.flags.texVariations = hasTextureVariations(model);
  return model;
}
