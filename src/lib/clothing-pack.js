// Freemode clothing packs: the names the game streams clothing under, a
// folder's files grouped into packs and items, and the plans for writing
// textures into a pack and for building a new addon pack from several.
//
// A pack is one DLC for one ped: `<ped>_<dlc>.ymt` (its ped variation file,
// see ped-variation-xml.js) plus files named `<ped>_<dlc>^<slot>_<NNN>_<u|r>.ydd`
// with textures `<ped>_<dlc>^<slot>_diff_<NNN>_<letter>_<race>.ytd`. Props use
// `<ped>_p_<dlc>^p_<anchor>_<NNN>.ydd` and `…_diff_<NNN>_<letter>.ytd`. The
// game derives every file name from the .ymt, so a write keeps them in step.
// Pure: the panels supply listings, texture sizes and .ymt XML; the desktop
// host validates every path and does the writing.

import { COMPONENT_IDS, PED_IDS, pathKey } from "./eup.js";
import { FEET_SLOT, HAT_ANCHOR, creatureFileName, creatureMetadataXml, editedComponentInfo, editedPropMeta, hatFlatten, heelHeight, normalizeItemEdit } from "./clothing-properties.js";
import {
  ANCHOR_NAMES,
  buildPedVariation,
  componentData,
  defaultComponentInfo,
  defaultPropMeta,
  drawableEntry,
  pedVariationXml,
  propEntry,
  withAddedTextures,
} from "./ped-variation-xml.js";

/** Prop slots by anchor id, named as grzyClothTool and DurtyClothTool write them. */
export const PROP_SLOTS = Object.freeze([
  "p_head",
  "p_eyes",
  "p_ears",
  "p_mouth",
  "p_lhand",
  "p_rhand",
  "p_lwrist",
  "p_rwrist",
  "p_hip",
  "p_lfoot",
  "p_rfoot",
  "p_ph_l_hand",
  "p_ph_r_hand",
]);

export const COMPONENT_SLOTS = COMPONENT_IDS;

/** Letters a to z: the game numbers an item's textures 0 to 25. */
export const MAX_ITEM_TEXTURES = 26;
/** Drawables per slot in one pack: FiveM's limit. */
export const MAX_SLOT_ITEMS = 128;
/** A slot's texture total is stored in one byte. */
export const MAX_SLOT_TEXTURES = 255;

// Race suffixes of component textures by the texId the .ymt stores, as
// CodeWalker names them. Ids without a known suffix are refused, not guessed.
const RACE_FOR_TEX_ID = Object.freeze({ 0: "uni", 1: "whi", 2: "bla", 3: "chi", 4: "lat", 5: "ara", 8: "kor", 10: "pak" });
const TEX_ID_FOR_RACE = Object.freeze(Object.fromEntries(Object.entries(RACE_FOR_TEX_ID).map(([id, race]) => [race, Number(id)])));

const PREFIX = /^(mp_[mf]_freemode_01)(?:_(.+))?$/;
const DRAWABLE = /^(p_[a-z_]+?|[a-z]+)_(\d{3})(?:_([ur]))?(?:_(\d))?$/;
const TEXTURE = /^(p_[a-z_]+?|[a-z]+)_diff_(\d{3})_([a-z])(?:_([a-z]{3}))?$/;
const PACK_NAME = /^[a-z][a-z0-9_]{0,31}$/;

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
export const letterOf = (index) => LETTERS[index] || "";
const indexOfLetter = (letter) => LETTERS.indexOf(letter);
const pad3 = (index) => String(index).padStart(3, "0");

export function fileNameOf(path) {
  return String(path || "").split(/[\\/]/).pop() || "";
}

function folderOf(path) {
  const text = String(path || "");
  const name = fileNameOf(text);
  return text.slice(0, text.length - name.length).replace(/[\\/]$/, "");
}

const samePath = (a, b) => String(a || "").replace(/\\/g, "/").toLowerCase() === String(b || "").replace(/\\/g, "/").toLowerCase();

/** The game's name for a slot: "Top", "Hat" and so on. */
export function slotLabel(slot) {
  const labels = {
    head: "Head", berd: "Mask", hair: "Hair", uppr: "Torso", lowr: "Legs", hand: "Bag", feet: "Shoes",
    teef: "Accessory", accs: "Undershirt", task: "Armour", decl: "Decal", jbib: "Top",
    p_head: "Hat", p_eyes: "Glasses", p_ears: "Earring", p_mouth: "Mouth", p_lhand: "Left hand", p_rhand: "Right hand",
    p_lwrist: "Watch", p_rwrist: "Bracelet", p_hip: "Hip", p_lfoot: "Left foot", p_rfoot: "Right foot",
    p_ph_l_hand: "Left hand prop", p_ph_r_hand: "Right hand prop",
  };
  return labels[slot] || slot;
}

export const pedLabel = (ped) => (ped === "mp_f_freemode_01" ? "Female" : ped === "mp_m_freemode_01" ? "Male" : "Unknown ped");

/**
 * Reads a clothing file name: `{ kind, ped, dlc, isProp, slot, slotId, index,
 * suffix, alternate, letter, race, problems }`, or null when the name is not
 * a clothing drawable or texture. `ped` and `dlc` are null for a name without
 * a pack prefix (`jbib_000_u.ydd`, as tools export them); `problems` lists
 * what stops the game from finding the file under this name.
 */
export function parseClothingName(name) {
  const file = fileNameOf(name);
  const lower = file.toLowerCase();
  const ext = /\.(ydd|ytd|yld)$/.exec(lower)?.[1];
  if (!ext) return null;
  const stem = lower.slice(0, -4);
  const caret = stem.lastIndexOf("^");
  const prefix = caret >= 0 ? stem.slice(0, caret) : "";
  const rest = caret >= 0 ? stem.slice(caret + 1) : stem;
  const problems = [];
  if (file !== lower) problems.push("has capital letters; FiveM servers on Linux stream names exactly");

  let ped = null;
  let after = null;
  if (caret >= 0) {
    const match = PREFIX.exec(prefix);
    if (!match) return null;
    ped = match[1];
    after = match[2] ?? null;
  }

  let parsed;
  if (ext === "ytd") {
    const match = TEXTURE.exec(rest);
    if (!match) return null;
    parsed = { kind: "texture", slot: match[1], index: Number(match[2]), letter: match[3], race: match[4] || null, suffix: null, alternate: 0 };
  } else {
    const match = DRAWABLE.exec(rest);
    if (!match) return null;
    parsed = { kind: ext === "yld" ? "cloth" : "drawable", slot: match[1], index: Number(match[2]), letter: null, race: null, suffix: match[3] || null, alternate: Number(match[4] || 0) };
  }
  const isProp = parsed.slot.startsWith("p_");
  const slotId = isProp ? PROP_SLOTS.indexOf(parsed.slot) : COMPONENT_SLOTS.indexOf(parsed.slot);
  if (slotId < 0) return null;

  // A prop's prefix is `<ped>_p_<dlc>` (`<ped>_p` for the base game's).
  let dlc = null;
  if (ped) {
    if (isProp) {
      if (after === "p") dlc = null;
      else if (after?.startsWith("p_")) dlc = after.slice(2);
      else {
        dlc = after;
        problems.push("is a prop without _p after the ped name, so the game does not look for it");
      }
    } else {
      dlc = after;
    }
  }
  if (parsed.kind === "texture") {
    if (isProp && parsed.race) problems.push("is a prop texture with a race suffix, which props do not use");
    if (!isProp && !parsed.race) problems.push("has no race suffix (_uni), which component textures need");
  } else if (isProp && parsed.suffix) {
    problems.push("is a prop with a _u or _r suffix, which props do not use");
  } else if (!isProp && !parsed.suffix) {
    problems.push("has no _u or _r suffix, which component drawables need");
  }
  return { ...parsed, file, ext, ped, dlc, isProp, slotId, problems };
}

/** `<ped>_<dlc>` for components, `<ped>_p_<dlc>` for props. */
export function streamPrefix(ped, dlc, isProp) {
  if (!dlc) return isProp ? `${ped}_p` : ped;
  return isProp ? `${ped}_p_${dlc}` : `${ped}_${dlc}`;
}

export function drawableFileName({ ped, dlc, isProp, slot, index, suffix, alternate = 0 }, ext = "ydd") {
  const tail = isProp ? "" : `_${suffix || "u"}`;
  return `${streamPrefix(ped, dlc, isProp)}^${slot}_${pad3(index)}${tail}${alternate ? `_${alternate}` : ""}.${ext}`;
}

export function textureFileName({ ped, dlc, isProp, slot, index, letter, race }) {
  return `${streamPrefix(ped, dlc, isProp)}^${slot}_diff_${pad3(index)}_${letter}${isProp ? "" : `_${race || "uni"}`}.ytd`;
}

/** The pack's ped variation file name. */
export const ymtFileName = (ped, dlc) => `${ped}_${dlc}.ymt`;

/** The race suffix of a component texture id, or null when unknown. */
export const raceForTexId = (texId) => RACE_FOR_TEX_ID[texId] ?? null;
export const texIdForRace = (race) => TEX_ID_FOR_RACE[race] ?? null;

/* ── Grouping a folder's files ── */

function pedFromPath(path) {
  const lower = String(path || "").toLowerCase();
  return PED_IDS.find((ped) => lower.includes(ped)) || null;
}

/**
 * Groups a folder listing (`[{ path }]`, any files) into packs and their
 * items. Files without a pack prefix take the ped found in their path, else
 * `ped`. Returns `{ packs, stray, unknown }`: each pack is `{ key, ped, dlc,
 * ymtPath, items }` (`dlc` null for files without a prefix, `ymtPath` null
 * when the folder has none) and each item `{ key, ped, dlc, isProp, slot,
 * slotId, index, suffix, drawable, alternates, cloth, textures, problems }`
 * with textures `{ letter, race, path }` sorted by letter. `stray` lists
 * textures without a drawable; `unknown` lists .ydd and .ytd files whose
 * names are not clothing names.
 */
export function groupClothingFiles(files, { ped: fallbackPed = null } = {}) {
  const packs = new Map();
  const stray = [];
  const unknown = [];
  const ymts = new Map();
  for (const entry of files || []) {
    const path = typeof entry === "string" ? entry : entry?.path;
    if (!path) continue;
    const name = fileNameOf(path).toLowerCase();
    if (name.endsWith(".ymt")) ymts.set(name, path);
  }
  const packFor = (ped, dlc) => {
    const key = `${ped}|${dlc || ""}`;
    if (!packs.has(key)) {
      packs.set(key, { key, ped, dlc, ymtPath: dlc ? ymts.get(ymtFileName(ped, dlc)) || null : null, items: new Map() });
    }
    return packs.get(key);
  };
  const itemFor = (pack, parsed) => {
    const key = `${pack.key}|${parsed.isProp ? "p" : "c"}|${parsed.slot}|${parsed.index}`;
    if (!pack.items.has(key)) {
      pack.items.set(key, {
        key, ped: pack.ped, dlc: pack.dlc, isProp: parsed.isProp, slot: parsed.slot, slotId: parsed.slotId,
        index: parsed.index, suffix: null, drawable: null, alternates: [], cloth: null, textures: [], problems: [],
      });
    }
    return pack.items.get(key);
  };

  for (const entry of files || []) {
    const path = typeof entry === "string" ? entry : entry?.path;
    if (!path || !/\.(ydd|ytd|yld)$/i.test(path)) continue;
    const parsed = parseClothingName(path);
    if (!parsed) {
      if (!/\.yld$/i.test(path)) unknown.push(path);
      continue;
    }
    const ped = parsed.ped || pedFromPath(path) || fallbackPed;
    if (!ped) {
      unknown.push(path);
      continue;
    }
    const item = itemFor(packFor(ped, parsed.dlc), parsed);
    for (const problem of parsed.problems) item.problems.push(`${parsed.file} ${problem}.`);
    if (parsed.kind === "drawable" && parsed.alternate) item.alternates.push({ alternate: parsed.alternate, path });
    else if (parsed.kind === "drawable") {
      if (item.drawable) item.problems.push(`${parsed.file} and ${fileNameOf(item.drawable)} are the same item.`);
      else {
        item.drawable = path;
        item.suffix = parsed.suffix;
      }
    } else if (parsed.kind === "cloth") item.cloth = path;
    else item.textures.push({ letter: parsed.letter, race: parsed.race, path });
  }

  const result = [];
  for (const pack of packs.values()) {
    const items = [];
    for (const item of pack.items.values()) {
      item.textures.sort((a, b) => a.letter.localeCompare(b.letter) || String(a.race).localeCompare(String(b.race)));
      if (!item.drawable) {
        stray.push(...item.textures.map((texture) => texture.path));
        continue;
      }
      items.push(item);
    }
    items.sort((a, b) => Number(a.isProp) - Number(b.isProp) || a.slotId - b.slotId || a.index - b.index);
    if (items.length) result.push({ key: pack.key, ped: pack.ped, dlc: pack.dlc, ymtPath: pack.ymtPath, items });
  }
  result.sort((a, b) => PED_IDS.indexOf(a.ped) - PED_IDS.indexOf(b.ped) || String(a.dlc).localeCompare(String(b.dlc)));
  return { packs: result, stray, unknown };
}

/**
 * The item's texture files by letter, one per letter. A letter with files for
 * several races takes the one `raceOf(letter)` names (the race its pack's .ymt
 * gives it, which is the file the game loads), else the first.
 */
function texturesByLetter(item, raceOf = () => null) {
  const byLetter = new Map();
  for (const texture of item.textures) {
    const chosen = byLetter.get(texture.letter);
    const wanted = raceOf(texture.letter);
    if (!chosen || (wanted && chosen.race !== wanted && texture.race === wanted)) byLetter.set(texture.letter, texture);
  }
  return byLetter;
}

/** The race a component's .ymt texture entries give each letter, for texturesByLetter. */
function ymtRaces(item, textures) {
  return (letter) => (item.isProp ? null : raceForTexId(textures?.[indexOfLetter(letter)]?.texId));
}

/**
 * The item's first-person alternates (`_1`, `_2`…) as a pack uses them: the
 * files in a row from `_1`, no more than its .ymt counts when it lists the item.
 */
function usedAlternates(item, drawable) {
  const sorted = [...item.alternates].sort((a, b) => a.alternate - b.alternate);
  let run = 0;
  while (sorted[run]?.alternate === run + 1) run += 1;
  const counted = drawable?.numAlternatives;
  return sorted.slice(0, counted != null ? Math.min(counted, run) : run);
}

/* ── Writing textures into a pack ── */

/**
 * What writing textures into one clothing item does, in place. `item` is the
 * drawable as groupClothingFiles found it; `model` is its pack's parsed .ymt
 * (null when the pack has none); `variants` maps each existing texture file's
 * path to `{ legacy, texture: { name, width, height, levels } }` (its diffuse
 * texture, null while it is read). `staged` is `[{ id, path, letter }]`: a
 * letter the item has replaces that texture, the next letters add new ones.
 * `sources` maps a staged id to its image `{ width, height }` or `{ error }`.
 *
 * Returns `{ blocked, pending, files, ymt, checks }`: `files[]` is
 * `{ path, name, mode: "replace"|"create", template, textures }` with
 * `textures` as the bridge's writeYtdTextures takes them plus `itemId` and
 * the size to build; `ymt` is `{ path, xml, before, after }` when the
 * texture count changes.
 */
export function planClothingTextureWrite({ item, model = null, ymtPath = null, ymtXml = null, variants = {}, staged = [], sources = {} }) {
  const plan = { blocked: null, pending: false, files: [], ymt: null, checks: [] };
  if (!item?.drawable) {
    plan.blocked = "Open a clothing item to write its textures.";
    return plan;
  }
  if (!staged.length) {
    plan.blocked = "Add textures to write.";
    return plan;
  }
  const listed = model && item.dlc
    ? (item.isProp ? propEntry(model, item.slotId, item.index) : drawableEntry(model, item.slotId, item.index))
    : null;
  const listedTextures = item.isProp ? listed?.textures : listed?.drawable.textures;
  const existing = texturesByLetter(item, ymtRaces(item, listedTextures));
  const count = existing.size;
  const letters = [...existing.keys()];
  const missing = letters.filter((letter) => indexOfLetter(letter) >= count);
  if (missing.length) {
    plan.blocked = `${fileNameOf(item.drawable)} skips a letter before ${missing.join(", ")}, so new textures would land on the wrong number. Rename its textures a, b, c… first.`;
    return plan;
  }
  const template = existing.get("a") || null;
  const templateInfo = template ? variants[template.path] : null;
  const adding = staged.filter((entry) => indexOfLetter(entry.letter) >= count);
  // New textures continue the item's letters, or the .ymt would count a file that is not there.
  const out = adding.map((entry) => entry.letter).sort().filter((letter, index) => indexOfLetter(letter) !== count + index);
  if (out.length) {
    plan.blocked = `${fileNameOf(item.drawable)} has ${count} ${count === 1 ? "texture" : "textures"}, so new ones start at ${letterOf(count)}. Remove the staged ${out.join(", ")} and add ${out.length === 1 ? "it" : "them"} again.`;
    return plan;
  }

  if (adding.length) {
    if (!item.dlc) {
      plan.blocked = `${fileNameOf(item.drawable)} has no pack name in it, so its pack's ped variation file decides its textures and Cortex cannot add more. Replace them instead, or build it into an addon pack first.`;
      return plan;
    }
    if (!model) {
      plan.blocked = `${ymtFileName(item.ped, item.dlc)} was not found in this resource, so textures cannot be added. Replace existing ones instead.`;
      return plan;
    }
    if (!listed) {
      plan.blocked = `${ymtFileName(item.ped, item.dlc)} does not list ${fileNameOf(item.drawable)}, so textures cannot be added.`;
      return plan;
    }
    const known = item.isProp ? listed.textures.length : listed.drawable.textures.length;
    if (known !== count) {
      plan.blocked = `${ymtFileName(item.ped, item.dlc)} gives ${fileNameOf(item.drawable)} ${known} ${known === 1 ? "texture" : "textures"} but the folder has ${count}. Fix the pack before adding more.`;
      return plan;
    }
    if (count + adding.length > MAX_ITEM_TEXTURES) {
      plan.blocked = `A clothing item holds ${MAX_ITEM_TEXTURES} textures (a to z); this would make ${count + adding.length}.`;
      return plan;
    }
    const total = item.isProp ? null : componentData(model, item.slotId)?.numAvailTex;
    if (total != null && total + adding.length > MAX_SLOT_TEXTURES) {
      plan.blocked = `This pack's ${slotLabel(item.slot).toLowerCase()} slot would hold ${total + adding.length} textures; one pack holds ${MAX_SLOT_TEXTURES} per slot.`;
      return plan;
    }
    if (!template) {
      plan.blocked = `${fileNameOf(item.drawable)} has no texture a to model new ones on.`;
      return plan;
    }
  }
  // A new component texture takes its last texture's race id in the .ymt
  // (withAddedTextures), so its file is named for that race.
  const lastTexId = listedTextures?.[listedTextures.length - 1]?.texId;
  const newRace = item.isProp ? null : (lastTexId == null ? template?.race || "uni" : raceForTexId(lastTexId));
  if (adding.length && !item.isProp && !newRace) {
    plan.blocked = `${fileNameOf(item.drawable)}'s last texture has race id ${lastTexId}, which Cortex cannot name a file for, so textures cannot be added.`;
    return plan;
  }

  const unreadable = [...existing.values()].filter((texture) => variants[texture.path]?.legacy === false);
  if (unreadable.length) {
    plan.blocked = `${unreadable.map((texture) => fileNameOf(texture.path)).join(", ")} ${unreadable.length === 1 ? "is not a" : "are not"} legacy GTA V texture ${unreadable.length === 1 ? "dictionary" : "dictionaries"}, so Cortex cannot write ${unreadable.length === 1 ? "it" : "them"}.`;
    return plan;
  }

  for (const entry of staged) {
    const source = sources[entry.id];
    if (source?.error) {
      plan.checks.push({ tone: "destructive", text: `${fileNameOf(entry.path)} could not be read: ${source.error}` });
      plan.blocked ||= "Remove or replace the images that could not be read.";
    } else if (!source) plan.pending = true;
  }
  // The sizes come from the textures being replaced, and from texture a for new ones.
  const needed = staged.map((entry) => existing.get(entry.letter)?.path).filter(Boolean);
  if (adding.length) needed.push(template.path);
  if (needed.some((path) => !variants[path])) plan.pending = true;
  if (plan.pending && !plan.blocked) plan.blocked = "Reading the textures…";

  const folder = folderOf(item.drawable);
  const sep = item.drawable.includes("\\") ? "\\" : "/";
  const stretched = [];
  const upscaled = [];
  for (const entry of [...staged].sort((a, b) => a.letter.localeCompare(b.letter))) {
    const own = existing.get(entry.letter);
    const info = own ? variants[own.path] : templateInfo;
    const shape = info?.texture || null;
    const source = sources[entry.id];
    if (own) {
      plan.files.push({
        path: own.path, name: fileNameOf(own.path), mode: "replace", template: null, letter: entry.letter,
        textures: [{ itemId: entry.id, name: shape?.name || "", mode: "replace", width: shape?.width || 0, height: shape?.height || 0, levels: shape?.levels || 0 }],
      });
    } else {
      const name = textureFileName({ ped: item.ped, dlc: item.dlc, isProp: item.isProp, slot: item.slot, index: item.index, letter: entry.letter, race: newRace });
      const internal = name.slice(name.indexOf("^") + 1, -4);
      const size = { width: shape?.width || 0, height: shape?.height || 0, levels: shape?.levels || 0 };
      // The new file starts as a copy of texture a, whose texture is swapped
      // for the new one under the new file's name (the game reads whichever
      // texture the file holds; the name is for people opening it).
      const textures = !shape?.name || shape.name.toLowerCase() === internal
        ? [{ itemId: entry.id, name: shape?.name || internal, mode: "replace", ...size }]
        : [
          { itemId: entry.id, name: internal, mode: "insert", like: shape.name, ...size },
          { itemId: null, name: shape.name, mode: "delete", width: 0, height: 0, levels: 0 },
        ];
      plan.files.push({ path: `${folder}${sep}${name}`, name, mode: "create", template: template.path, letter: entry.letter, textures });
    }
    if (shape?.width && source?.width) {
      if (source.width < shape.width || source.height < shape.height) upscaled.push(`${fileNameOf(entry.path)} (${source.width} × ${source.height})`);
      const aspect = source.width / source.height;
      const target = shape.width / shape.height;
      if (Math.abs(aspect - target) / target > 0.02) stretched.push(fileNameOf(entry.path));
    }
  }

  if (adding.length) {
    const next = withAddedTextures(model, item, adding.length);
    plan.ymt = { path: ymtPath, name: fileNameOf(ymtPath), xml: pedVariationXml(next), base: ymtXml, before: count, after: count + adding.length };
  }
  const shape = templateInfo?.texture;
  if (upscaled.length) plan.checks.push({ tone: "caution", text: `${upscaled.join(", ")} ${upscaled.length === 1 ? "is" : "are"} smaller than the ${shape?.width || ""} × ${shape?.height || ""} texture, so ${upscaled.length === 1 ? "it is" : "they are"} scaled up.` });
  if (stretched.length) plan.checks.push({ tone: "caution", text: `${stretched.join(", ")} ${stretched.length === 1 ? "has" : "have"} another shape than the item's textures, so ${stretched.length === 1 ? "it is" : "they are"} stretched to fit.` });
  const total = count + adding.length;
  plan.checks.push({
    tone: "confirm",
    text: adding.length
      ? `${fileNameOf(item.drawable)} goes from ${count} to ${total} textures (a to ${letterOf(total - 1)}), and the pack's ${fileNameOf(ymtPath)} counts them.`
      : `Replaces ${staged.length === 1 ? "texture" : "textures"} ${staged.map((entry) => entry.letter).sort().join(", ")}; the item keeps ${count} ${count === 1 ? "texture" : "textures"}.`,
  });
  return plan;
}

/** True when a texture plan can be written now. */
export function canWriteClothingTextures(plan) {
  return Boolean(plan && !plan.blocked && !plan.pending && plan.files.length
    && plan.files.every((file) => file.textures.every((texture) => texture.mode === "delete" || (texture.name && texture.width && texture.height))));
}

/**
 * Stages image files as textures of an item with `count` textures: they take
 * the letters after the last, in natural file-name order; with `at`, the
 * first replaces that letter. Returns `{ staged, skipped: [{ path, reason }] }`.
 */
export function stageClothingTextures(staged, paths, { count, at = null, makeId }) {
  const skipped = [];
  const accepted = [];
  const sorted = [...new Set(paths)].sort((a, b) => fileNameOf(a).localeCompare(fileNameOf(b), undefined, { numeric: true, sensitivity: "base" }));
  const known = new Set(staged.map((entry) => entry.path.toLowerCase()));
  for (const path of sorted) {
    if (known.has(path.toLowerCase()) && at == null) skipped.push({ path, reason: "is already staged" });
    else accepted.push(path);
  }
  let next = staged.slice();
  if (at != null && accepted.length) {
    const [first] = accepted.splice(0, 1);
    next = next.filter((entry) => entry.letter !== at && entry.path.toLowerCase() !== first.toLowerCase());
    next.push({ id: makeId(), path: first, letter: at });
  }
  let last = Math.max(count - 1, ...next.map((entry) => indexOfLetter(entry.letter)));
  for (const path of accepted) {
    if (last + 1 >= MAX_ITEM_TEXTURES) {
      skipped.push({ path, reason: `would be texture ${MAX_ITEM_TEXTURES + 1}; an item holds a to z` });
      continue;
    }
    last += 1;
    next.push({ id: makeId(), path, letter: letterOf(last) });
  }
  return { staged: next.sort((a, b) => a.letter.localeCompare(b.letter)), skipped };
}

/**
 * A staged set from saved session data, `{ items: [{ id, path, letter }] }`,
 * keeping items with a path and a distinct letter. Null when nothing is left.
 */
export function normalizeClothingSet(value) {
  if (!value || typeof value !== "object") return null;
  const letters = new Set();
  const ids = new Set();
  const items = [];
  for (const item of Array.isArray(value.items) ? value.items : []) {
    const letter = typeof item?.letter === "string" ? item.letter : "";
    if (typeof item?.path !== "string" || !item.path || indexOfLetter(letter) < 0 || letter.length !== 1 || letters.has(letter)) continue;
    const id = typeof item.id === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(item.id) && !ids.has(item.id) ? item.id : `r${letter}`;
    letters.add(letter);
    ids.add(id);
    items.push({ id, path: item.path, letter });
  }
  return items.length ? { items: items.sort((a, b) => a.letter.localeCompare(b.letter)) } : null;
}

/* ── Building an addon pack ── */

export const itemKey = (item) => pathKey(item.drawable);
export const slotOrderKey = ({ ped, isProp, slotId }) => `${ped}|${isProp ? "p" : "c"}|${slotId}`;

export const MAX_PACK_EDITS = 4096;
const MAX_ORDER_ITEMS = 512;
const ORDER_KEY = /^mp_[mf]_freemode_01\|[pc]\|\d{1,2}$/;

const validKey = (key) => typeof key === "string" && key.length > 0 && key.length <= 1024;

export function normalizePackProject(value) {
  const source = value && typeof value === "object" ? value : {};
  const edits = {};
  for (const [key, edit] of Object.entries(source.edits && typeof source.edits === "object" ? source.edits : {}).slice(0, MAX_PACK_EDITS)) {
    const clean = normalizeItemEdit(edit);
    if (clean && validKey(key)) edits[key] = clean;
  }
  const order = {};
  for (const [key, list] of Object.entries(source.order && typeof source.order === "object" ? source.order : {})) {
    if (ORDER_KEY.test(key) && Array.isArray(list)) order[key] = [...new Set(list.filter(validKey))].slice(0, MAX_ORDER_ITEMS);
  }
  return {
    name: typeof source.name === "string" ? source.name.trim().slice(0, 32) : "",
    parent: typeof source.parent === "string" && source.parent.length <= 1024 ? source.parent : "",
    merge: source.merge !== false,
    edits,
    order,
  };
}

export function withItemEdits(edits, keys, patch) {
  const next = { ...edits };
  for (const key of keys) {
    const merged = normalizeItemEdit({ ...next[key], ...patch });
    const cleared = Object.entries(patch).filter(([, value]) => value == null).map(([field]) => field);
    for (const field of cleared) delete merged?.[field];
    if (merged && Object.keys(merged).length) next[key] = merged;
    else delete next[key];
  }
  return next;
}

export function withoutItemProperties(edits, keys) {
  const next = { ...edits };
  for (const key of keys) {
    if (next[key]?.out) next[key] = { out: true };
    else delete next[key];
  }
  return next;
}

export function movedInOrder(order, slotKey, keys, key, delta) {
  const at = keys.indexOf(key);
  const to = at + delta;
  if (at < 0 || to < 0 || to >= keys.length) return order;
  const list = keys.slice();
  [list[at], list[to]] = [list[to], list[at]];
  return { ...order, [slotKey]: list };
}

/** A pack name for the files and the .ymt: lowercase letters, digits and _. */
export function checkPackName(value) {
  const name = String(value || "").trim();
  if (!name) return { error: "Name the pack." };
  if (!PACK_NAME.test(name)) return { error: "Use lowercase letters, digits and _, starting with a letter, up to 32 characters." };
  return { name };
}

// The ymt data an item brings: its drawable and component info, or its prop
// data, from its own pack's .ymt when that lists it, else the defaults.
function sourceData(item, model) {
  if (item.isProp) {
    const prop = model ? propEntry(model, item.slotId, item.index) : null;
    return { prop: prop ? structuredClone(prop) : null };
  }
  const entry = model ? drawableEntry(model, item.slotId, item.index) : null;
  return entry ? { drawable: structuredClone(entry.drawable), info: entry.info ? structuredClone(entry.info) : null } : {};
}

/**
 * Every source item with its textures as the build uses them. A texture's
 * race and id come from its pack's .ymt when that lists the item, else from
 * its file name. Returns `{ items, checks }`.
 */
function collectItems(sources, models, edits) {
  const items = [];
  const checks = [];
  const left = [];
  for (const source of sources) {
    for (const pack of source.packs) {
      const model = pack.ymtPath ? models[pack.ymtPath] : null;
      for (const item of pack.items) {
        const label = fileNameOf(item.drawable);
        if (edits[itemKey(item)]?.out) {
          const data = sourceData(item, model);
          left.push({
            key: itemKey(item), label, source: source.label, ped: item.ped, isProp: item.isProp, slot: item.slot, slotId: item.slotId, sourceDrawable: item.drawable,
            suffix: item.suffix, info: data.info || null, prop: data.prop || null,
          });
          continue;
        }
        const data = sourceData(item, model);
        const listed = item.isProp ? data.prop : data.drawable;
        const files = [...texturesByLetter(item, ymtRaces(item, listed?.textures)).values()].sort((a, b) => a.letter.localeCompare(b.letter));
        if (item.textures.length > files.length) {
          const doubled = [...new Set(item.textures.map((texture) => texture.letter).filter((letter, index, all) => all.indexOf(letter) !== index))];
          checks.push({ tone: "caution", text: `${label} has files for more than one race of texture ${doubled.join(", ")}; the new pack keeps the one its pack's .ymt names, else the first.` });
        }
        const gap = files.findIndex((texture, index) => indexOfLetter(texture.letter) !== index);
        if (gap >= 0) checks.push({ tone: "caution", text: `${label} has no texture ${letterOf(gap)}, so its later textures move up a letter in the new pack.` });
        const known = listed?.textures.length ?? null;
        if (known != null && known !== files.length) {
          checks.push({ tone: "caution", text: `${pack.ymtPath ? fileNameOf(pack.ymtPath) : "Its pack"} gives ${label} ${known} textures but its folder has ${files.length}; the new pack uses the ${files.length} files.` });
        }
        const textures = [];
        let refused = null;
        for (const texture of files) {
          // The .ymt counts textures by letter, so a gap does not shift what it says.
          const data = listed?.textures[indexOfLetter(texture.letter)] || null;
          if (item.isProp) {
            textures.push({ path: texture.path, race: null, texId: 0, data });
            continue;
          }
          const fromYmt = data?.texId;
          const texId = fromYmt ?? texIdForRace(texture.race || "uni");
          const race = raceForTexId(texId);
          if (texId == null || !race) refused = `${fileNameOf(texture.path)} has a race Cortex does not know (${texture.race || `id ${fromYmt}`}).`;
          textures.push({ path: texture.path, race, texId, data });
        }
        if (refused) {
          checks.push({ tone: "caution", text: `${refused} ${label} is left out.` });
          continue;
        }
        if (!textures.length) {
          checks.push({ tone: "caution", text: `${label} has no textures, so the game could not show it. It is left out.` });
          continue;
        }
        if (!item.isProp && data.drawable && ((data.drawable.propMask >> 4) & 3) !== (item.suffix === "r" ? 1 : 0)) {
          checks.push({ tone: "caution", text: `${label} is named _${item.suffix} but its pack's ${fileNameOf(pack.ymtPath)} says otherwise; the new pack follows the file name.` });
          data.drawable.propMask = (data.drawable.propMask & ~0x30) | (item.suffix === "r" ? 0x10 : 0);
        }
        const alternates = item.isProp ? [] : usedAlternates(item, data.drawable);
        if (alternates.length < item.alternates.length) {
          const unused = item.alternates.filter((alternate) => !alternates.includes(alternate)).map((alternate) => fileNameOf(alternate.path));
          checks.push({ tone: "caution", text: `${unused.join(", ")} ${unused.length === 1 ? "is" : "are"} not used by ${label}'s pack, so the new pack leaves ${unused.length === 1 ? "it" : "them"} out.` });
        }
        items.push({ source, pack, item, data, textures, label, alternates });
      }
    }
  }
  return { items, checks, left };
}

function inSlotOrder(built, order) {
  const groups = new Map();
  for (const entry of built) {
    const key = slotOrderKey(entry.item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const sorted = [];
  for (const [key, list] of groups) {
    const wanted = Array.isArray(order[key]) ? order[key] : [];
    const rank = (entry, position) => {
      const at = wanted.indexOf(itemKey(entry.item));
      return at >= 0 ? at : wanted.length + position;
    };
    sorted.push(...list.map((entry, position) => ({ entry, rank: rank(entry, position) })).sort((a, b) => a.rank - b.rank).map(({ entry }) => entry));
  }
  return sorted;
}

/**
 * What building one addon pack from `sources` does. Each source is `{ id,
 * label, packs }` (groupClothingFiles' packs, already filtered to what the
 * user keeps); `models` maps a pack's ymtPath to its parsed .ymt. `identical`
 * maps a file path to a group id shared by files with the same bytes (the
 * host's comparison); with `merge`, items with the same model (same ped and
 * slot, same group) become one item with all their textures, each texture
 * once. Items are numbered in source order; a slot over FiveM's limits
 * continues in a second pack (`<name>_02`) in the same resource.
 *
 * Returns `{ blocked, checks, items, dlcs, copies, texts, ymts, summary }`:
 * `copies[]` is `{ from, to }` relative to the resource folder, `ymts[]`
 * `{ to, xml }`, `texts[]` `{ to, text }`; `items` lists each built item with
 * its new name, textures and the sources merged into it.
 */
export function planClothingPackBuild({ name, sources = [], models = {}, identical = {}, merge = true, edits = {}, order = {} }) {
  const plan = { blocked: null, checks: [], items: [], left: [], dlcs: [], copies: [], texts: [], ymts: [], creatures: [], summary: { items: 0, textures: 0, merged: 0, packs: 0, left: 0 } };
  const checked = checkPackName(name);
  if (checked.error) plan.blocked = checked.error;
  const { items: collected, checks, left } = collectItems(sources, models, edits);
  plan.checks.push(...checks);
  plan.left = left;
  plan.summary.left = left.length;
  if (!collected.length) {
    plan.blocked ||= left.length ? "Every item is left out. Put one back to build a pack." : "Add clothing to build a pack.";
    return plan;
  }

  // Items that share a model fold into the first of them.
  const built = [];
  const byModel = new Map();
  for (const entry of collected) {
    const group = identical[entry.item.drawable];
    const key = merge && group != null ? `${entry.item.ped}|${entry.item.isProp ? "p" : "c"}|${entry.item.slot}|${entry.item.suffix || ""}|${group}` : null;
    const target = key ? byModel.get(key) : null;
    if (target) {
      const textureKey = (texture) => `${texture.texId}|${identical[texture.path] ?? texture.path.toLowerCase()}`;
      const seen = new Set(target.textures.map(textureKey));
      const fresh = entry.textures.filter((texture) => !seen.has(textureKey(texture)));
      if (target.textures.length + fresh.length > MAX_ITEM_TEXTURES) {
        plan.checks.push({ tone: "caution", text: `${entry.label} has the same model as ${target.label}, but together they would have ${target.textures.length + fresh.length} textures (an item holds ${MAX_ITEM_TEXTURES}), so they stay apart.` });
      } else {
        // The merged item keeps the first one's first-person and cloth files.
        if (entry.alternates.length > target.alternates.length || (entry.item.cloth && !target.item.cloth)) {
          plan.checks.push({ tone: "caution", text: `${entry.label} has first-person or cloth files that ${target.label} lacks; the merged item uses ${target.label}'s, so they are left out.` });
        }
        if (Object.keys(edits[itemKey(entry.item)] || {}).some((field) => field !== "out")) {
          plan.checks.push({ tone: "caution", text: `${entry.label} merges into ${target.label}, so the settings you gave ${entry.label} are not used.` });
        }
        target.textures.push(...fresh);
        target.merged.push({ label: entry.label, source: entry.source.label, added: fresh.length, duplicates: entry.textures.length - fresh.length });
        continue;
      }
    }
    const own = { ...entry, textures: entry.textures.slice(), merged: [] };
    built.push(own);
    if (key && !target) byModel.set(key, own);
  }

  // Number the items per ped and slot; a full slot continues in the next pack.
  const ordered = inSlotOrder(built, order);
  const packs = new Map();
  const packFor = (ped, part) => {
    const key = `${ped}|${part}`;
    if (!packs.has(key)) {
      const suffix = part ? `_${String(part + 1).padStart(2, "0")}` : "";
      const dlc = `${ped === "mp_f_freemode_01" ? "mp_f" : "mp_m"}_${checked.name || "pack"}${suffix}`;
      packs.set(key, { ped, part, dlc, components: new Map(), props: new Map(), textures: new Map() });
    }
    return packs.get(key);
  };
  for (const entry of ordered) {
    const { item } = entry;
    let part = 0;
    for (;;) {
      const pack = packFor(item.ped, part);
      const list = item.isProp ? (pack.props.get(item.slotId) || []) : (pack.components.get(item.slotId) || []);
      const used = pack.textures.get(item.slotId) || 0;
      const fits = list.length < MAX_SLOT_ITEMS && (item.isProp || used + entry.textures.length <= MAX_SLOT_TEXTURES);
      if (!fits) {
        part += 1;
        continue;
      }
      entry.pack = pack;
      entry.index = list.length;
      list.push(entry);
      if (item.isProp) pack.props.set(item.slotId, list);
      else {
        pack.components.set(item.slotId, list);
        pack.textures.set(item.slotId, used + entry.textures.length);
      }
      break;
    }
  }

  const sortedPacks = [...packs.values()].sort((a, b) => PED_IDS.indexOf(a.ped) - PED_IDS.indexOf(b.ped) || a.part - b.part);
  for (const pack of sortedPacks) {
    const components = new Map();
    for (const [slotId, list] of pack.components) {
      components.set(slotId, list.map((entry) => {
        const edit = edits[itemKey(entry.item)];
        const info = entry.data.info || null;
        return {
          drawable: {
            propMask: entry.data.drawable?.propMask ?? (entry.item.suffix === "r" ? 17 : 1),
            // Alternates are the first-person `_1` models: as many as are copied.
            numAlternatives: entry.alternates.length,
            textures: entry.textures.map((texture) => ({ texId: texture.texId, distribution: texture.data?.distribution ?? 255 })),
            ownsCloth: Boolean(entry.item.cloth) && (entry.data.drawable?.ownsCloth ?? true),
          },
          info: edit ? editedComponentInfo(info || defaultComponentInfo(slotId, entry.index), edit) : info,
        };
      }));
    }
    const props = new Map();
    for (const [anchorId, list] of pack.props) {
      props.set(anchorId, list.map((entry) => {
        const base = entry.data.prop || defaultPropMeta(anchorId, entry.index, 0);
        return editedPropMeta({
          ...base,
          textures: entry.textures.map((texture, texId) => ({ ...(texture.data || defaultPropMeta(anchorId, entry.index, 1).textures[0]), texId })),
        }, edits[itemKey(entry.item)]);
      }));
    }
    const model = buildPedVariation({ name: pack.dlc, dlcName: pack.dlc, components, props });
    const ymt = `stream/${ymtFileName(pack.ped, pack.dlc)}`;
    plan.ymts.push({ to: ymt, xml: pedVariationXml(model) });
    const hats = (props.get(HAT_ANCHOR) || []).flatMap((prop, index) => (hatFlatten(prop.expressionMods) > 0 ? [index] : []));
    const heels = (components.get(FEET_SLOT) || []).flatMap(({ info }, index) => (heelHeight(info?.expressionMods) > 0 ? [index] : []));
    const creature = creatureMetadataXml({ hats, heels });
    if (creature) plan.creatures.push({ to: `stream/${creatureFileName(pack.dlc)}`, xml: creature, hats: hats.length, heels: heels.length });
    const meta = `${pack.ped}_${pack.dlc}.meta`;
    plan.texts.push({ to: meta, text: shopMetaXml(pack.ped, pack.dlc) });
    plan.dlcs.push({ ped: pack.ped, dlc: pack.dlc, ymt, meta });
  }

  for (const entry of ordered) {
    const { item, pack, index } = entry;
    const at = { ped: item.ped, dlc: pack.dlc, isProp: item.isProp, slot: item.slot, index, suffix: item.suffix };
    const folder = `stream/${streamPrefix(item.ped, pack.dlc, item.isProp)}`;
    const drawable = `${folder}/${drawableFileName(at)}`;
    plan.copies.push({ from: item.drawable, to: drawable });
    for (const alternate of entry.alternates) plan.copies.push({ from: alternate.path, to: `${folder}/${drawableFileName({ ...at, alternate: alternate.alternate })}` });
    if (item.cloth) plan.copies.push({ from: item.cloth, to: `${folder}/${drawableFileName(at, "yld")}` });
    const textures = entry.textures.map((texture, letterIndex) => {
      const to = `${folder}/${textureFileName({ ...at, letter: letterOf(letterIndex), race: texture.race })}`;
      plan.copies.push({ from: texture.path, to });
      return { from: texture.path, to };
    });
    plan.items.push({
      key: itemKey(item), ped: item.ped, dlc: pack.dlc, isProp: item.isProp, slot: item.slot, slotId: item.slotId, index, label: entry.label, source: entry.source.label,
      sourceDrawable: item.drawable, drawable, textures, merged: entry.merged, info: entry.data.info || null, prop: entry.data.prop || null,
      alternates: entry.alternates.length, cloth: Boolean(item.cloth), suffix: item.suffix,
    });
  }

  plan.texts.unshift({ to: "fxmanifest.lua", text: fxManifestLua(plan.dlcs.map((dlc) => dlc.meta)) });
  const merged = built.reduce((sum, entry) => sum + entry.merged.length, 0);
  plan.summary = { items: built.length, textures: built.reduce((sum, entry) => sum + entry.textures.length, 0), merged, packs: plan.dlcs.length, left: left.length };
  if (merged) {
    const duplicates = built.reduce((sum, entry) => sum + entry.merged.reduce((count, part) => count + part.duplicates, 0), 0);
    plan.checks.push({ tone: "confirm", text: `${merged} ${merged === 1 ? "item shares its model" : "items share their model"} with another, so ${merged === 1 ? "its textures join that item" : "their textures join those items"}${duplicates ? `; ${duplicates} identical ${duplicates === 1 ? "texture is" : "textures are"} kept once` : ""}.` });
  }
  const split = sortedPacks.filter((pack) => pack.part > 0);
  if (split.length) plan.checks.push({ tone: "caution", text: `A slot holds more than ${MAX_SLOT_ITEMS} items or ${MAX_SLOT_TEXTURES} textures, so it continues in ${split.map((dlc) => dlc.dlc).join(", ")} in the same resource.` });
  const seenNames = new Set();
  for (const copy of plan.copies) {
    const key = copy.to.toLowerCase();
    if (seenNames.has(key)) plan.blocked ||= `${copy.to} would be written twice.`;
    seenNames.add(key);
  }
  return plan;
}

/** The shop meta that registers a pack with the game (SHOP_PED_APPAREL_META_FILE). */
export function shopMetaXml(ped, dlc) {
  const female = ped === "mp_f_freemode_01";
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<ShopPedApparel>",
    `\t<pedName>${ped}</pedName>`,
    `\t<dlcName>${dlc}</dlcName>`,
    `\t<fullDlcName>${ped}_${dlc}</fullDlcName>`,
    `\t<eCharacter>${female ? "SCR_CHAR_MULTIPLAYER_F" : "SCR_CHAR_MULTIPLAYER"}</eCharacter>`,
    `\t<creatureMetaData>MP_CreatureMetadata_${dlc}</creatureMetaData>`,
    "\t<pedOutfits>",
    "\t</pedOutfits>",
    "\t<pedComponents>",
    "\t</pedComponents>",
    "\t<pedProps>",
    "\t</pedProps>",
    "</ShopPedApparel>",
    "",
  ].join("\n");
}

/** The resource manifest: every shop meta as a data file; `stream/` streams on its own. */
export function fxManifestLua(metas) {
  return [
    "-- Built with Cortex Studio",
    "",
    "fx_version 'cerulean'",
    "game 'gta5'",
    "",
    "files {",
    ...metas.map((meta, index) => `  '${meta}'${index < metas.length - 1 ? "," : ""}`),
    "}",
    "",
    ...metas.map((meta) => `data_file 'SHOP_PED_APPAREL_META_FILE' '${meta}'`),
    "",
  ].join("\n");
}
