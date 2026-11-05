import { defaultLiveryPattern, fileNameOf, liverySlots, parseLiveryPattern, planLiveryWrite } from "./livery-set.js";
import { normalizeShapeParams, PATTERN_KINDS, SHAPE_DEFAULTS, SHAPE_KINDS } from "./livery-canvas-shapes.js";
import { resolveManifestAssetPath, selectNativeMaterialBindings } from "./native-material-plan.js";

export const CANVAS_SCHEMA = "cortex.liveryCanvas";
export const CANVAS_VERSION = 1;
export const KIT_SCHEMA = "cortex.liveryDecalKit";
export const KIT_VERSION = 1;
export const CANVAS_KINDS = ["image", "text", "shape"];
export const CANVAS_BLENDS = ["normal", "multiply"];
export const CANVAS_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "svg"];
export const CANVAS_FONT_EXTENSIONS = ["ttf", "otf", "woff", "woff2"];
export const MAX_CANVAS_ITEMS = 200;
export const CANVAS_WRITE_ITEM_ID = "canvas";
export const DEFAULT_SHEET_SIZE = 2048;
export const MAX_SHEET_SIDE = 8192;

export const CANVAS_FONTS = [
  { id: "barlow-800i", family: "Barlow Condensed", weight: 800, style: "italic", label: "Barlow Condensed Extra Bold Italic" },
  { id: "barlow-700i", family: "Barlow Condensed", weight: 700, style: "italic", label: "Barlow Condensed Bold Italic" },
  { id: "space-700", family: "Space Grotesk", weight: 700, style: "normal", label: "Space Grotesk Bold" },
  { id: "space-500", family: "Space Grotesk", weight: 500, style: "normal", label: "Space Grotesk Medium" },
  { id: "syne-800", family: "Syne", weight: 800, style: "normal", label: "Syne Extra Bold" },
  { id: "jetbrains-600", family: "JetBrains Mono", weight: 600, style: "normal", label: "JetBrains Mono Semibold" },
  { id: "share-tech-400", family: "Share Tech Mono", weight: 400, style: "normal", label: "Share Tech Mono" },
];

const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const HEX_PATTERN = /^#[0-9a-f]{6}$/i;
const MAX_PATH = 4096;
const MAX_TEXT = 200;

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const finite = (value) => typeof value === "number" && Number.isFinite(value);

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function wrapAngle(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const turn = Math.PI * 2;
  let angle = ((number % turn) + turn) % turn;
  if (angle > Math.PI) angle -= turn;
  return angle;
}

function cleanString(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function normalizeHex(value, fallback = "#ffffff") {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(trimmed);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  return HEX_PATTERN.test(trimmed) ? trimmed.toLowerCase() : fallback;
}

function extensionOf(path) {
  return (/\.([^.\\/]+)$/.exec(String(path || ""))?.[1] || "").toLowerCase();
}

export function isCanvasImagePath(path) {
  return CANVAS_IMAGE_EXTENSIONS.includes(extensionOf(path));
}

export function isCanvasFontPath(path) {
  return CANVAS_FONT_EXTENSIONS.includes(extensionOf(path));
}

export function samePath(a, b) {
  return Boolean(a) && Boolean(b) && String(a).replace(/\//g, "\\").toLowerCase() === String(b).replace(/\//g, "\\").toLowerCase();
}

function normalizeFont(raw) {
  const source = isObject(raw) ? raw : {};
  const path = cleanString(source.path, MAX_PATH);
  if (path) {
    return {
      family: cleanString(source.family, 80) || fileNameOf(path).replace(/\.[^.]+$/, "") || "Custom font",
      weight: Math.round(clamp(source.weight, 100, 900, 400) / 100) * 100,
      style: source.style === "italic" ? "italic" : "normal",
      path,
    };
  }
  const bundled = CANVAS_FONTS.find((font) => font.id === source.id)
    || CANVAS_FONTS.find((font) => font.family === source.family && font.weight === Number(source.weight) && font.style === (source.style || "normal"))
    || CANVAS_FONTS[0];
  return { id: bundled.id, family: bundled.family, weight: bundled.weight, style: bundled.style };
}

function normalizeSource(kind, raw) {
  const source = isObject(raw) ? raw : {};
  if (kind === "image") {
    const path = cleanString(source.path, MAX_PATH);
    return path ? { path } : null;
  }
  if (kind === "text") {
    const text = typeof source.text === "string" ? source.text.replace(/[\r\n\t]+/g, " ").slice(0, MAX_TEXT) : "";
    if (!text.trim()) return null;
    return {
      text,
      font: normalizeFont(source.font),
      color: normalizeHex(source.color, "#ffffff"),
      letterSpacing: clamp(source.letterSpacing, -0.2, 1, 0),
    };
  }
  if (kind === "shape") {
    if (!SHAPE_KINDS.includes(source.shape)) return null;
    const pattern = PATTERN_KINDS.includes(source.shape);
    return {
      shape: source.shape,
      params: normalizeShapeParams(source.shape, source.params),
      color: normalizeHex(source.color, "#ffffff"),
      ...(pattern ? { color2: source.color2 === null ? null : normalizeHex(source.color2, "#111111") } : {}),
    };
  }
  return null;
}

function normalizeIsland(raw) {
  if (!isObject(raw)) return null;
  const mesh = cleanString(raw.mesh, 200);
  const index = Number(raw.index);
  return mesh && Number.isInteger(index) && index >= 0 ? { mesh, index } : null;
}

function normalizeAnchor(raw) {
  if (!isObject(raw)) return null;
  const mesh = cleanString(raw.mesh, 200);
  const face = Number(raw.face);
  const bary = Array.isArray(raw.bary) && raw.bary.length === 3 ? raw.bary.map(Number) : null;
  const ppu = Number(raw.ppu);
  const sheet = Array.isArray(raw.sheet) && raw.sheet.length === 2 ? raw.sheet.map(Number) : null;
  if (!mesh || !Number.isInteger(face) || face < 0 || !bary || !bary.every(Number.isFinite)) return null;
  return {
    mesh,
    face,
    bary,
    ...(ppu > 0 && Number.isFinite(ppu) ? { ppu } : {}),
    ...(sheet && sheet.every((value) => Number.isInteger(value) && value > 0) ? { sheet } : {}),
  };
}

function normalizeTransform(raw) {
  const source = isObject(raw) ? raw : {};
  return {
    u: clamp(source.u, -1, 2, 0.5),
    v: clamp(source.v, -1, 2, 0.5),
    width: clamp(source.width, 1e-4, 4, 0.2),
    height: clamp(source.height, 1e-4, 4, 0.1),
    rotation: wrapAngle(source.rotation),
    flipX: source.flipX === true,
  };
}

export function normalizeCanvasItem(raw, fallbackId) {
  if (!isObject(raw) || !CANVAS_KINDS.includes(raw.kind)) return null;
  const source = normalizeSource(raw.kind, raw.source);
  if (!source) return null;
  const symmetry = isObject(raw.symmetry) && ID_PATTERN.test(String(raw.symmetry.of || ""))
    ? { of: raw.symmetry.of, mode: raw.symmetry.mode === "mirrored" ? "mirrored" : "readable" }
    : null;
  return {
    id: typeof raw.id === "string" && ID_PATTERN.test(raw.id) ? raw.id : fallbackId,
    kind: raw.kind,
    name: cleanString(raw.name, 80),
    source,
    island: normalizeIsland(raw.island),
    anchor: normalizeAnchor(raw.anchor),
    uvTransform: normalizeTransform(raw.uvTransform),
    opacity: clamp(raw.opacity, 0, 1, 1),
    blend: CANVAS_BLENDS.includes(raw.blend) ? raw.blend : "normal",
    clip: raw.clip !== false,
    locked: raw.locked === true,
    hidden: raw.hidden === true,
    symmetry,
  };
}

function normalizeSheet(raw) {
  const source = isObject(raw) ? raw : {};
  const side = (value) => (Number.isInteger(value) && value > 0 && value <= MAX_SHEET_SIDE ? value : DEFAULT_SHEET_SIZE);
  return { width: side(source.width), height: side(source.height) };
}

function normalizeWritten(value) {
  return [...new Set((Array.isArray(value) ? value : []).filter((number) => Number.isInteger(number) && number >= 0 && number <= 999))].sort((a, b) => a - b);
}

export function createCanvasDoc({ sheet = null, model = "", written = [] } = {}) {
  return { schema: CANVAS_SCHEMA, version: CANVAS_VERSION, model: cleanString(model, MAX_PATH), sheet: normalizeSheet(sheet), items: [], written: normalizeWritten(written) };
}

export function parseCanvasDoc(value) {
  let data = value;
  if (typeof value === "string") {
    try {
      data = JSON.parse(value);
    } catch {
      throw new Error("The file is not a canvas: it is not valid JSON.");
    }
  }
  if (!isObject(data)) throw new Error("The file is not a canvas.");
  if (data.schema !== CANVAS_SCHEMA) throw new Error(`The file is not a canvas (expected ${CANVAS_SCHEMA}).`);
  if (!Number.isInteger(data.version) || data.version < 1) throw new Error("The canvas has no valid version.");
  if (data.version > CANVAS_VERSION) throw new Error(`The canvas was saved by a newer Cortex Studio (version ${data.version}). Update to open it.`);
  return normalizeCanvasDoc(data);
}

export function normalizeCanvasDoc(data) {
  const doc = createCanvasDoc({ sheet: data?.sheet, model: data?.model, written: data?.written });
  const dropped = [];
  const ids = new Set();
  const rawItems = Array.isArray(data?.items) ? data.items : [];
  rawItems.forEach((raw, index) => {
    if (doc.items.length >= MAX_CANVAS_ITEMS) {
      dropped.push(`Item ${index + 1} is past the ${MAX_CANVAS_ITEMS}-item limit.`);
      return;
    }
    const item = normalizeCanvasItem(raw, `i${index + 1}`);
    if (!item) {
      dropped.push(`Item ${index + 1} could not be read.`);
      return;
    }
    let id = item.id;
    for (let n = 2; ids.has(id); n += 1) id = `${item.id.slice(0, 34)}_${n}`;
    ids.add(id);
    doc.items.push({ ...item, id });
  });
  for (const item of doc.items) {
    if (item.symmetry && !ids.has(item.symmetry.of)) item.symmetry = null;
  }
  return { doc, dropped };
}

export function serializeCanvasDoc(doc) {
  return `${JSON.stringify({ schema: CANVAS_SCHEMA, version: CANVAS_VERSION, model: doc.model || "", sheet: doc.sheet, items: doc.items, written: normalizeWritten(doc.written) }, null, 2)}\n`;
}

export function itemLabel(item) {
  if (item.name) return item.name;
  if (item.kind === "image") return fileNameOf(item.source.path) || "Image";
  if (item.kind === "text") return item.source.text.trim() || "Text";
  const shape = item.source.shape;
  return shape.charAt(0).toUpperCase() + shape.slice(1);
}

export function addCanvasItem(doc, item) {
  if (doc.items.length >= MAX_CANVAS_ITEMS) throw new Error(`A canvas holds up to ${MAX_CANVAS_ITEMS} items.`);
  const normalized = normalizeCanvasItem(item, item?.id);
  if (!normalized || !normalized.id) throw new Error("That item could not be added.");
  if (doc.items.some((entry) => entry.id === normalized.id)) throw new Error("That item is already on the canvas.");
  return { ...doc, items: [...doc.items, normalized] };
}

export function updateCanvasItem(doc, id, patch) {
  let changed = false;
  const items = doc.items.map((item) => {
    if (item.id !== id) return item;
    const next = typeof patch === "function" ? patch(item) : { ...item, ...patch };
    if (next === item) return item;
    const normalized = normalizeCanvasItem({ ...next, id: item.id, kind: item.kind }, item.id);
    if (!normalized) return item;
    changed = true;
    return normalized;
  });
  if (!changed) return doc;
  return { ...doc, items: syncCounterparts(items, id) };
}

function syncCounterparts(items, id) {
  const source = items.find((item) => item.id === id);
  if (!source) return items;
  return items.map((item) => (item.symmetry?.of === id && item.kind === source.kind
    ? { ...item, source: source.source, opacity: source.opacity, blend: source.blend, clip: source.clip, hidden: source.hidden }
    : item));
}

export function removeCanvasItems(doc, ids) {
  const gone = new Set(ids);
  return {
    ...doc,
    items: doc.items
      .filter((item) => !gone.has(item.id))
      .map((item) => (item.symmetry && gone.has(item.symmetry.of) ? { ...item, symmetry: null } : item)),
  };
}

export function moveCanvasItem(doc, id, offset) {
  const index = doc.items.findIndex((item) => item.id === id);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= doc.items.length || !Number.isInteger(offset)) return doc;
  const items = [...doc.items];
  const [item] = items.splice(index, 1);
  items.splice(target, 0, item);
  return { ...doc, items };
}

export function canvasSourcePaths(doc) {
  const sources = new Map();
  const add = (path, kind, itemId) => {
    const key = `${kind}:${String(path).toLowerCase()}`;
    if (!sources.has(key)) sources.set(key, { path, kind, items: [] });
    sources.get(key).items.push(itemId);
  };
  for (const item of doc.items) {
    if (item.kind === "image") add(item.source.path, "image", item.id);
    if (item.kind === "text" && item.source.font.path) add(item.source.font.path, "font", item.id);
  }
  return [...sources.values()];
}

export function relinkCanvasSource(doc, kind, from, to) {
  if (!to || (kind === "image" ? !isCanvasImagePath(to) : !isCanvasFontPath(to))) return doc;
  return {
    ...doc,
    items: doc.items.map((item) => {
      if (kind === "image" && item.kind === "image" && samePath(item.source.path, from)) return { ...item, source: { path: to } };
      if (kind === "font" && item.kind === "text" && samePath(item.source.font.path, from)) {
        return { ...item, source: { ...item.source, font: { ...item.source.font, path: to } } };
      }
      return item;
    }),
  };
}

const SHARED_REASON = "comes from the game's files or another resource's dictionary, so Canvas won't flatten it or write it into the vehicle. Export the canvas as a transparent PNG and put it over your own base in your editor instead.";

export function classifyCanvasBase({ path = "", dictionaries = [], parentTextures = null } = {}) {
  if (!path) return { kind: "none", owned: false, label: "", reason: "There is no base texture. Choose your livery in the Livery step first." };
  const name = fileNameOf(path);
  for (const dictionary of dictionaries || []) {
    for (const texture of dictionary?.textures || []) {
      if (samePath(texture?.path, path)) {
        return { kind: "ytd", owned: true, label: `${texture.name} in ${dictionary.name || fileNameOf(dictionary.path)}`, reason: "" };
      }
    }
  }
  const manifestPath = parentTextures?.manifestPath || "";
  for (const record of parentTextures?.textures || []) {
    if (!record?.relativePath || !samePath(resolveManifestAssetPath(manifestPath, record.relativePath), path)) continue;
    const label = record.name || name;
    if (record.source === "ytd") return { kind: "ytd", owned: true, label: `${label} from the vehicle's own dictionary`, reason: "" };
    if (record.source === "shared") return { kind: "shared", owned: false, label, reason: `${label} ${SHARED_REASON}` };
    if (record.source === "embedded") {
      return { kind: "embedded", owned: false, label, reason: `${label} is embedded in the model, so Canvas won't flatten it or write it. Export the canvas as a transparent PNG instead.` };
    }
    return { kind: "unknown", owned: false, label, reason: `Cortex can't tell where ${label} comes from, so Canvas won't flatten it or write it. Export the canvas as a transparent PNG instead.` };
  }
  const cacheRoot = manifestPath ? manifestPath.replace(/[\\/][^\\/]*$/, "") : "";
  if (/[\\/]ytd-cache[\\/]/i.test(path) || (cacheRoot && String(path).toLowerCase().startsWith(cacheRoot.toLowerCase()))) {
    return { kind: "unknown", owned: false, label: name, reason: `Cortex can't tell which dictionary ${name} came from, so Canvas won't flatten it or write it. Export the canvas as a transparent PNG instead.` };
  }
  return { kind: "source", owned: true, label: name, reason: "" };
}

export function canvasLiverySlots({ dictionaries = [], signPrefix = null, modelPath = "" } = {}) {
  const pattern = defaultLiveryPattern({ signPrefix, dictionaries, modelPath });
  const parsed = parseLiveryPattern(pattern);
  if (parsed.error) return { pattern, slots: [] };
  return { pattern, slots: liverySlots({ dictionaries, pattern: parsed }).filter((slot) => slot.existing.length) };
}

export function replaceOnlyProblem(plan) {
  const offending = (plan?.files || []).flatMap((file) => file.textures
    .filter((texture) => texture.mode !== "replace")
    .map((texture) => ({ file: file.name, texture })));
  if (!offending.length) return "";
  const inserts = offending.filter((entry) => entry.texture.mode === "insert");
  if (inserts.length) {
    const files = [...new Set(inserts.map((entry) => entry.file))];
    return `${files.join(" and ")} ${files.length === 1 ? "has" : "have"} no ${inserts[0].texture.name}, so writing would add one. Canvas only replaces a livery the vehicle already has.`;
  }
  return "Canvas only replaces an existing livery; it never adds or removes one.";
}

export function planCanvasSlotWrite({ modelPath = "", dictionaries = [], signPrefix = null, number = null, sheet = null, base = null } = {}) {
  const items = Number.isInteger(number) ? [{ id: CANVAS_WRITE_ITEM_ID, path: "Canvas", number }] : [];
  if (!base?.owned) return { blocked: base?.reason || "Choose a base texture of your own first.", plan: null, items };
  if (!sheet?.width || !sheet?.height) return { blocked: "The canvas has no size yet.", plan: null, items };
  const { pattern, slots } = canvasLiverySlots({ dictionaries, signPrefix, modelPath });
  if (!items.length) return { blocked: "Choose the livery to replace.", plan: null, items };
  if (!slots.some((slot) => slot.number === number)) {
    return { blocked: `Livery ${number} isn't in ${fileNameOf(modelPath) || "the vehicle"}'s own dictionaries. Canvas only replaces a livery the vehicle already has; add new ones in the list above.`, plan: null, items };
  }
  const plan = planLiveryWrite({
    modelPath,
    dictionaries,
    pattern,
    items,
    removed: [],
    sources: { [CANVAS_WRITE_ITEM_ID]: { width: sheet.width, height: sheet.height } },
    signPrefix,
  });
  const problem = replaceOnlyProblem(plan);
  if (problem) return { blocked: problem, plan: null, items };
  return { blocked: plan.blocked, plan, items };
}

export function canvasExportNames(modelPath) {
  const stem = fileNameOf(modelPath).replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_.-]+/g, "_") || "livery";
  return {
    stack: `${stem}_canvas.png`,
    flat: `${stem}_canvas_flat.png`,
    psd: `${stem}_canvas_layers.psd`,
    doc: `${stem}.livery-canvas.json`,
    kit: `${stem}_decals.livery-kit.json`,
  };
}

export function itemMeters(item) {
  const anchor = item?.anchor;
  if (!anchor?.ppu || !anchor.sheet) return null;
  return {
    width: (item.uvTransform.width * anchor.sheet[0]) / anchor.ppu,
    height: (item.uvTransform.height * anchor.sheet[1]) / anchor.ppu,
  };
}

export function buildDecalKit(doc, ids, name = "") {
  const wanted = new Set(ids);
  const items = doc.items.filter((item) => wanted.has(item.id) && !item.symmetry).map((item) => ({
    kind: item.kind,
    name: itemLabel(item),
    source: item.source,
    opacity: item.opacity,
    blend: item.blend,
    clip: item.clip,
    flipX: item.uvTransform.flipX,
    size: itemMeters(item),
    aspect: item.uvTransform.height > 0 ? (item.uvTransform.width * doc.sheet.width) / (item.uvTransform.height * doc.sheet.height) : 1,
  }));
  if (!items.length) throw new Error("Choose the items to keep in the decal set.");
  return { schema: KIT_SCHEMA, version: KIT_VERSION, name: cleanString(name, 80) || "Decal set", items };
}

export function parseDecalKit(value) {
  let data = value;
  if (typeof value === "string") {
    try {
      data = JSON.parse(value);
    } catch {
      throw new Error("The file is not a decal set: it is not valid JSON.");
    }
  }
  if (!isObject(data) || data.schema !== KIT_SCHEMA) throw new Error(`The file is not a decal set (expected ${KIT_SCHEMA}).`);
  if (!Number.isInteger(data.version) || data.version < 1) throw new Error("The decal set has no valid version.");
  if (data.version > KIT_VERSION) throw new Error(`The decal set was saved by a newer Cortex Studio (version ${data.version}). Update to open it.`);
  const items = [];
  for (const raw of Array.isArray(data.items) ? data.items.slice(0, MAX_CANVAS_ITEMS) : []) {
    if (!isObject(raw) || !CANVAS_KINDS.includes(raw.kind)) continue;
    const source = normalizeSource(raw.kind, raw.source);
    if (!source) continue;
    const size = isObject(raw.size) && finite(raw.size.width) && finite(raw.size.height) && raw.size.width > 0 && raw.size.height > 0
      ? { width: Math.min(raw.size.width, 20), height: Math.min(raw.size.height, 20) }
      : null;
    items.push({
      kind: raw.kind,
      name: cleanString(raw.name, 80),
      source,
      opacity: clamp(raw.opacity, 0, 1, 1),
      blend: CANVAS_BLENDS.includes(raw.blend) ? raw.blend : "normal",
      clip: raw.clip !== false,
      flipX: raw.flipX === true,
      size,
      aspect: clamp(raw.aspect, 0.02, 50, 1),
    });
  }
  if (!items.length) throw new Error("The decal set holds no items Cortex can use.");
  return { name: cleanString(data.name, 80) || "Decal set", items };
}

function hashText(value) {
  let hash = 0x811c9dc5;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

export function canvasFontFamily(font) {
  if (font?.path) return `CortexCanvasFont-${hashText(String(font.path).toLowerCase())}`;
  return font?.family || CANVAS_FONTS[0].family;
}

export function canvasFontKey(font) {
  return font?.path ? `file:${String(font.path).toLowerCase()}` : `bundled:${font?.id || CANVAS_FONTS[0].id}`;
}

const SIGN_TEXTURE = /^(.+)_sign_(\d+)$/i;
const OVERLAY_PARAM = /^diffusesampler2$/i;

function uvSetOf(binding) {
  return Number.isInteger(binding?.uvSet) && binding.uvSet >= 0 && binding.uvSet <= 3 ? binding.uvSet : 0;
}

export function canvasLiveryBinding(nativeMaterial) {
  const selected = selectNativeMaterialBindings(nativeMaterial);
  for (const role of ["baseColor", "overlay"]) {
    const binding = selected[role];
    if (SIGN_TEXTURE.test(binding?.textureName || "")) return { kind: "sign", role, uvSet: uvSetOf(binding), textureName: binding.textureName };
  }
  const bindings = Array.isArray(nativeMaterial?.textureBindings) ? nativeMaterial.textureBindings : [];
  const sign = bindings.find((binding) => SIGN_TEXTURE.test(binding?.textureName || ""));
  if (sign) return { kind: "sign", role: sign.usage || "", uvSet: uvSetOf(sign), textureName: sign.textureName };
  const overlay = bindings.find((binding) => OVERLAY_PARAM.test(binding?.paramName || ""));
  if (overlay) return { kind: "overlay", role: "overlay", uvSet: uvSetOf(overlay), textureName: overlay.textureName || "" };
  return null;
}

export function defaultShapeSource(shape) {
  return {
    shape,
    params: { ...SHAPE_DEFAULTS[shape] },
    color: PATTERN_KINDS.includes(shape) ? "#f2d000" : "#ffffff",
    ...(PATTERN_KINDS.includes(shape) ? { color2: "#1d3f9e" } : {}),
  };
}
