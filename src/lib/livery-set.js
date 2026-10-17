// A vehicle's texture liveries as a numbered set, and the plan for writing
// new ones into its own texture dictionaries. GTA texture liveries are
// `<prefix>_sign_N` textures: the paint samples `<prefix>_sign_1` and the
// livery number picks N. Each dictionary keeps its own copy of each livery
// (`x+hi.ytd` at full size, `x.ytd` smaller for distance), so a write fits
// each image to the size that dictionary already uses. Pure: the panel and
// dialog supply the dictionaries (the `livery_dictionaries` command) and the
// decoded image sizes.

export const MAX_LIVERY_NUMBER = 99;
export const LIVERY_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "psd", "pdn", "dds"];

const NAME_CHARS = /^[A-Za-z0-9_.-]+$/;
const HI_STEM = /[_+]hi$/i;
const SIGN = /^(.+)_sign_\d+$/i;

export function fileNameOf(path) {
  return String(path || "").split(/[\\/]/).pop() || "";
}

function stemOf(path) {
  return fileNameOf(path).replace(/\.[^.]*$/, "");
}

export function isLiveryImagePath(path) {
  const match = /\.([^.\\/]+)$/.exec(String(path || ""));
  return Boolean(match) && LIVERY_IMAGE_EXTENSIONS.includes(match[1].toLowerCase());
}

/** File names in the order people number them: `livery2` before `livery10`. */
export function naturalCompare(a, b) {
  return fileNameOf(a).localeCompare(fileNameOf(b), undefined, { numeric: true, sensitivity: "base" });
}

/**
 * A names pattern such as `fpiu_sign_#`, where `#` is the livery number.
 * Returns `{ pattern, nameFor(n), numberOf(name) }`, or `{ error }`.
 * `numberOf` matches without case and only canonical numbers (`_sign_1`, not
 * `_sign_01`), as `nameFor` writes them.
 */
export function parseLiveryPattern(value) {
  const pattern = String(value || "").trim();
  const marks = pattern.split("#").length - 1;
  if (!marks) return { error: "Put # where the number goes, as in fpiu_sign_#." };
  if (marks > 1) return { error: "Use # once, where the number goes." };
  const [before, after] = pattern.split("#");
  if (!NAME_CHARS.test(`${before}1${after}`)) return { error: "Texture names use letters, digits, _, . and - only." };
  if (pattern.length > 120) return { error: "That name is too long for a texture." };
  const lowerBefore = before.toLowerCase();
  const lowerAfter = after.toLowerCase();
  return {
    pattern,
    nameFor: (number) => `${before}${number}${after}`,
    numberOf(name) {
      const lower = String(name || "").toLowerCase();
      if (!lower.startsWith(lowerBefore) || !lower.endsWith(lowerAfter)) return null;
      const digits = lower.slice(lowerBefore.length, lower.length - lowerAfter.length);
      return /^[1-9]\d*$/.test(digits) ? Number(digits) : null;
    },
  };
}

/**
 * The names pattern a vehicle's liveries use: the sign its paint samples
 * (`signPrefix`, from the model's materials), else the most common
 * `<prefix>_sign_N` in its dictionaries, else one named after the model.
 */
export function defaultLiveryPattern({ signPrefix = "", dictionaries = [], modelPath = "" } = {}) {
  if (signPrefix) return `${signPrefix}_sign_#`;
  const counts = new Map();
  for (const dictionary of dictionaries) {
    for (const texture of dictionary?.textures || []) {
      const prefix = SIGN.exec(texture?.name || "")?.[1]?.toLowerCase();
      if (prefix) counts.set(prefix, (counts.get(prefix) || 0) + 1);
    }
  }
  const common = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  if (common) return `${common}_sign_#`;
  const stem = stemOf(modelPath).replace(HI_STEM, "").toLowerCase().replace(/[^a-z0-9_.-]/g, "_");
  return `${stem || "vehicle"}_sign_#`;
}

/**
 * The vehicle's liveries and what a write does to them, by number: each
 * slot's `existing` copies (`{ dictionary, texture }`, one per dictionary
 * holding it), the staged `item` that replaces or adds it, and `removed` when
 * the write deletes it. `removed` lists livery numbers to delete; a number
 * with a staged image is replaced instead, and one the vehicle lacks is ignored.
 */
export function liverySlots({ dictionaries = [], pattern, items = [], removed = [] }) {
  const parsed = typeof pattern === "string" ? parseLiveryPattern(pattern) : pattern;
  if (!parsed || parsed.error) return [];
  const slots = new Map();
  const slot = (number) => {
    if (!slots.has(number)) slots.set(number, { number, name: parsed.nameFor(number), existing: [], item: null, removed: false });
    return slots.get(number);
  };
  for (const dictionary of dictionaries) {
    for (const texture of dictionary?.textures || []) {
      const number = parsed.numberOf(texture?.name);
      if (number != null) slot(number).existing.push({ dictionary, texture });
    }
  }
  for (const item of items) slot(item.number).item = item;
  for (const number of removed) {
    const target = slots.get(number);
    if (target?.existing.length && !target.item) target.removed = true;
  }
  return [...slots.values()].sort((a, b) => a.number - b.number);
}

/** The largest copy of an existing livery, the one to preview. */
export function largestCopy(slot) {
  return (slot?.existing || []).reduce((best, entry) => (
    !best || (entry.texture.width || 0) * (entry.texture.height || 0) > (best.texture.width || 0) * (best.texture.height || 0) ? entry : best
  ), null);
}

/**
 * Stages image files as liveries. They take the numbers after the highest in
 * use, in natural file-name order; with `at`, the first takes that number
 * instead (replacing what was staged there). `taken` lists the numbers the
 * vehicle already has. Returns `{ items, skipped: [{ path, reason }] }`.
 */
export function stageLiveryFiles(items, paths, { taken = [], at = null, makeId }) {
  const skipped = [];
  const staged = new Set(items.map((item) => item.path.toLowerCase()));
  const accepted = [];
  for (const path of [...new Set(paths)].sort(naturalCompare)) {
    if (!isLiveryImagePath(path)) skipped.push({ path, reason: "is not an image Cortex reads as a livery" });
    else if (staged.has(path.toLowerCase()) && at == null) skipped.push({ path, reason: "is already staged" });
    else accepted.push(path);
  }
  let next = items.filter((item) => !(at != null && accepted.length && item.number === at));
  if (at != null && accepted.length) {
    const [first] = accepted.splice(0, 1);
    next = next.filter((item) => item.path.toLowerCase() !== first.toLowerCase());
    next.push({ id: makeId(), path: first, number: at });
  }
  let highest = Math.max(0, ...taken, ...next.map((item) => item.number));
  for (const path of accepted) {
    if (highest >= MAX_LIVERY_NUMBER) {
      skipped.push({ path, reason: `would be livery ${highest + 1}; Cortex numbers up to ${MAX_LIVERY_NUMBER}` });
      continue;
    }
    highest += 1;
    next.push({ id: makeId(), path, number: highest });
  }
  return { items: next.sort((a, b) => a.number - b.number), skipped };
}

// The power of two at or below `value`, or the one above when `value` is
// within a tenth of it: a 4000 px image stays 4096, a 3000 px one is not
// stretched to it.
function liveryPowerOfTwo(value) {
  const below = 2 ** Math.floor(Math.log2(Math.max(1, value)));
  return value >= below * 2 * 0.9 ? below * 2 : below;
}

/** The size a livery is written at in a dictionary that holds none yet. */
export function fittedLiverySize({ width, height }) {
  const side = (value) => Math.min(4096, Math.max(64, liveryPowerOfTwo(value)));
  return { width: side(width), height: side(height) };
}

/** Bytes of a DXT5 texture with `levels` mips (all, when 0). */
export function dxt5Bytes(width, height, levels = 0) {
  let total = 0;
  let w = width;
  let h = height;
  for (let level = 0; levels ? level < levels : Math.min(w, h) >= 4 || level === 0; level += 1) {
    total += Math.ceil(w / 4) * Math.ceil(h / 4) * 16;
    if (w === 1 && h === 1) break;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
  return total;
}

function joinList(items) {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Livery numbers as people read them: "1 to 4, 7 and 9". */
export function numberRuns(numbers) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
    if (j - i >= 2) parts.push(`${sorted[i]} to ${sorted[j]}`);
    else parts.push(...sorted.slice(i, j + 1).map(String));
    i = j + 1;
  }
  return joinList(parts);
}

const liveryWord = (count) => `${count} ${count === 1 ? "livery" : "liveries"}`;

/** The write action's label: "Write 3 liveries", "Write 3, remove 1" or "Remove 1 livery". */
export function liveryWriteLabel(count, removals) {
  if (count && removals) return `Write ${count}, remove ${removals}`;
  return removals ? `Remove ${liveryWord(removals)}` : `Write ${liveryWord(count)}`;
}

// The dictionaries a write goes into: every one that holds a livery of this
// name already, else the model's base dictionary (`x.ytd`, not `x+hi.ytd`).
function targetDictionaries(dictionaries, parsed) {
  const holding = dictionaries.filter((dictionary) => (dictionary.textures || []).some((texture) => parsed.numberOf(texture?.name) != null));
  if (holding.length) return holding;
  const base = dictionaries.find((dictionary) => !HI_STEM.test(stemOf(dictionary.name || dictionary.path)));
  return base ? [base] : dictionaries.slice(0, 1);
}

/**
 * What writing the staged liveries and removing the `removed` ones does.
 * `sources` maps an item id to its decoded image `{ width, height }`,
 * `{ error }`, or nothing while it is read. Returns
 * `{ blocked, pending, files, removals, checks }`: `files[]` is
 * `{ path, name, textures: [{ itemId, number, name, mode, like, width, height, levels }] }`
 * with `added`, `replaced`, `removed` and `bytes`, where a removed texture has
 * mode `delete`, no item and no size; `removals` lists the livery numbers
 * removed; `checks[]` is `{ tone, text }` with tone confirm, caution or
 * destructive.
 */
export function planLiveryWrite({ modelPath = "", dictionaries = [], pattern, items = [], removed = [], sources = {}, signPrefix = null }) {
  const plan = { blocked: null, pending: false, files: [], removals: [], checks: [] };
  const parsed = parseLiveryPattern(pattern);
  if (parsed.error) {
    plan.blocked = parsed.error;
    return plan;
  }
  const slots = liverySlots({ dictionaries, pattern: parsed, items, removed });
  plan.removals = slots.filter((slot) => slot.removed).map((slot) => slot.number);
  if (!items.length && !plan.removals.length) {
    plan.blocked = "Add liveries to write.";
    return plan;
  }
  if (!dictionaries.length) {
    plan.blocked = `${fileNameOf(modelPath) || "This model"} has no texture dictionary of its own beside it to hold liveries.`;
    return plan;
  }
  const targets = targetDictionaries(dictionaries, parsed);
  const locked = targets.filter((dictionary) => dictionary.legacy === false);
  if (locked.length) {
    plan.blocked = `${joinList(locked.map((dictionary) => dictionary.name))} ${locked.length === 1 ? "is not a" : "are not"} legacy GTA V texture ${locked.length === 1 ? "dictionary" : "dictionaries"}, so Cortex cannot write ${locked.length === 1 ? "it" : "them"}.`;
    return plan;
  }

  for (const item of items) {
    const source = sources[item.id];
    if (source?.error) {
      plan.checks.push({ tone: "destructive", text: `${fileNameOf(item.path)} could not be read: ${source.error}` });
      plan.blocked = plan.blocked || "Remove or replace the images that could not be read.";
    } else if (!source) {
      plan.pending = true;
    }
  }
  if (plan.pending && !plan.blocked) plan.blocked = "Reading the images…";

  const upscaled = new Map();
  const stretched = new Map();
  const removing = new Set(plan.removals);
  for (const dictionary of targets) {
    const liveries = (dictionary.textures || [])
      .map((texture) => ({ texture, number: parsed.numberOf(texture?.name) }))
      .filter((entry) => entry.number != null)
      .sort((a, b) => a.number - b.number);
    // New liveries take the use of one that stays, when one does.
    const sized = (entry) => entry.texture.width && entry.texture.height;
    const model = (liveries.find((entry) => sized(entry) && !removing.has(entry.number)) || liveries.find(sized))?.texture || null;
    const file = { path: dictionary.path, name: dictionary.name || fileNameOf(dictionary.path), textures: [], added: 0, replaced: 0, removed: 0, bytes: 0 };
    for (const item of items) {
      const holder = liveries.find((entry) => entry.number === item.number)?.texture || null;
      const shape = holder?.width && holder?.height ? holder : model;
      const source = sources[item.id];
      const size = shape
        ? { width: shape.width, height: shape.height }
        : source?.width ? fittedLiverySize(source) : null;
      const levels = shape?.levels || 0;
      const name = holder ? holder.name : parsed.nameFor(item.number);
      file.textures.push({
        itemId: item.id,
        number: item.number,
        name,
        mode: holder ? "replace" : "insert",
        like: holder ? null : model?.name || null,
        width: size?.width || 0,
        height: size?.height || 0,
        levels,
      });
      if (holder) file.replaced += 1;
      else file.added += 1;
      if (size) file.bytes += dxt5Bytes(size.width, size.height, levels);
      if (source?.width && size) {
        const label = fileNameOf(item.path);
        if (source.width < size.width || source.height < size.height) {
          if (!upscaled.has(label)) upscaled.set(label, { source, files: [] });
          upscaled.get(label).files.push(file.name);
        }
        const aspect = source.width / source.height;
        const target = size.width / size.height;
        if (Math.abs(aspect - target) / target > 0.02 && !stretched.has(label)) stretched.set(label, { source, size });
      }
    }
    // Removals go last, so an insert modelled on a removed livery still finds it.
    for (const entry of liveries) {
      if (!removing.has(entry.number)) continue;
      file.textures.push({ itemId: null, number: entry.number, name: entry.texture.name, mode: "delete", like: null, width: 0, height: 0, levels: 0 });
      file.removed += 1;
    }
    if (!file.textures.length) continue;
    if ((dictionary.textures || []).length + file.added - file.removed <= 0) {
      plan.blocked = plan.blocked || `Removing these leaves ${file.name} with no textures, which the game cannot load. Keep at least one livery.`;
    }
    plan.files.push(file);
  }

  // One line per image size and set of files: a batch of 1024 images bound
  // for a 4096 dictionary reads as one check, not one per image.
  const upscaledGroups = new Map();
  for (const [label, { source, files }] of upscaled) {
    const key = `${source.width}x${source.height}|${files.join("|")}`;
    if (!upscaledGroups.has(key)) upscaledGroups.set(key, { source, files, labels: [] });
    upscaledGroups.get(key).labels.push(label);
  }
  for (const { source, files, labels } of upscaledGroups.values()) {
    const one = labels.length === 1;
    plan.checks.push({ tone: "caution", text: `${joinList(labels)} ${one ? "is" : "are"} ${source.width} × ${source.height}, so ${one ? "it is" : "they are"} scaled up for ${joinList(files)}.` });
  }
  for (const [label, { source, size }] of stretched) {
    plan.checks.push({ tone: "caution", text: `${label} is ${source.width} × ${source.height}, so it is stretched to the ${size.width} × ${size.height} livery shape.` });
  }

  const numbers = slots.filter((slot) => !slot.removed).map((slot) => slot.number);
  const highest = Math.max(0, ...numbers);
  const missing = [];
  for (let number = 1; number <= highest; number += 1) {
    if (!numbers.includes(number)) missing.push(number);
  }
  const changes = [
    items.length ? `writes ${numberRuns(items.map((item) => item.number))}` : "",
    plan.removals.length ? `removes ${numberRuns(plan.removals)}` : "",
  ].filter(Boolean).join(" and ");
  if (!highest) {
    plan.checks.push({ tone: "caution", text: "This removes every livery, so the vehicle has none in game." });
  } else if (missing.length) {
    plan.checks.push({ tone: "caution", text: `Livery ${numberRuns(missing)} ${missing.length === 1 ? "is" : "are"} missing. The game counts liveries 1, 2, 3… in order, so keep the numbers without gaps.` });
  } else {
    plan.checks.push({ tone: "confirm", text: `Liveries run 1 to ${highest} with no gaps; this ${changes}.` });
  }

  const expected = signPrefix ? `${signPrefix}_sign_1` : "";
  if (signPrefix && parsed.nameFor(1).toLowerCase() !== expected) {
    plan.checks.push({ tone: "caution", text: `The paint uses ${expected}, so textures named ${parsed.pattern} do not show as liveries.` });
  } else if (signPrefix === "") {
    plan.checks.push({ tone: "caution", text: "The model's paint samples no livery texture, so new liveries do not show in game until the model uses one." });
  }
  return plan;
}

const isLiveryNumber = (number) => Number.isInteger(number) && number >= 1 && number <= MAX_LIVERY_NUMBER;

/**
 * A staged set from saved session data, `{ pattern, items, removed }`,
 * keeping only items with a path and a distinct number from 1 to 99, and
 * removals of other numbers in that range. Null when unusable.
 */
export function normalizeLiverySet(value) {
  if (!value || typeof value !== "object") return null;
  const pattern = typeof value.pattern === "string" ? value.pattern.slice(0, 120) : "";
  const numbers = new Set();
  const ids = new Set();
  const items = [];
  for (const item of Array.isArray(value.items) ? value.items : []) {
    const number = Number(item?.number);
    if (typeof item?.path !== "string" || !item.path || !isLiveryNumber(number) || numbers.has(number)) continue;
    const id = typeof item.id === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(item.id) && !ids.has(item.id) ? item.id : `r${number}`;
    numbers.add(number);
    ids.add(id);
    items.push({ id, path: item.path, number });
  }
  const removed = [...new Set((Array.isArray(value.removed) ? value.removed : []).map(Number))]
    .filter((number) => isLiveryNumber(number) && !numbers.has(number))
    .sort((a, b) => a - b);
  return { pattern, items: items.sort((a, b) => a.number - b.number), removed };
}

/** True when a plan can be written now. */
export function canWriteLiveries(plan) {
  return Boolean(plan && !plan.blocked && !plan.pending && plan.files.length
    && plan.files.every((file) => file.textures.every((texture) => texture.mode === "delete" || (texture.width && texture.height))));
}
