// EUP (freemode ped clothing) naming rules and grouping.
//
// Pure, deterministic helpers shared by the EUP page and its Node tests. Nothing
// here touches the filesystem, Tauri, or three.js. File naming policy for GTA
// ped assets lives in this module so the page and the assembly code stay free of
// filename folklore.

export const PED_IDS = Object.freeze(["mp_m_freemode_01", "mp_f_freemode_01"]);

export const PED_FOR_GENDER = Object.freeze({
  male: "mp_m_freemode_01",
  female: "mp_f_freemode_01",
});

export const GENDER_FOR_PED = Object.freeze({
  mp_m_freemode_01: "male",
  mp_f_freemode_01: "female",
});

// Component slot order follows the game's component ids 0..11.
export const COMPONENT_IDS = Object.freeze([
  "head",
  "berd",
  "hair",
  "uppr",
  "lowr",
  "hand",
  "feet",
  "teef",
  "accs",
  "task",
  "decl",
  "jbib",
]);

// Prop anchor slots (p_<anchor>).
export const PROP_IDS = Object.freeze([
  "p_head",
  "p_eyes",
  "p_ears",
  "p_mouth",
  "p_lhand",
  "p_rhand",
  "p_lwrist",
  "p_rwrist",
  "p_lhip",
  "p_rhip",
]);

export const RACE_IDS = Object.freeze([
  "uni",
  "whi",
  "bla",
  "chi",
  "lat",
  "ara",
  "bal",
  "jew",
  "pak",
  "kor",
]);

const COMPONENT_DISPLAY_NAMES = Object.freeze({
  head: "Head",
  berd: "Mask",
  hair: "Hair",
  uppr: "Torso",
  lowr: "Legs",
  hand: "Bags/Parachute",
  feet: "Shoes",
  teef: "Neck accessories",
  accs: "Undershirt",
  task: "Body armor",
  decl: "Decals",
  jbib: "Top",
  p_head: "Hat",
  p_eyes: "Glasses",
  p_ears: "Ears",
  p_mouth: "Mouth",
  p_lhand: "Left hand",
  p_rhand: "Right hand",
  p_lwrist: "Watch",
  p_rwrist: "Bracelet",
  p_lhip: "Left hip",
  p_rhip: "Right hip",
});

// Mannequin defaults for a freemode ped. jbib 15 is the "no top" drawable on
// both peds; torso/undershirt 15 provide the matching bare-body combination.
const BASE_OUTFIT = Object.freeze({
  head: 0,
  berd: 0,
  hair: 0,
  uppr: 15,
  lowr: 0,
  hand: 0,
  feet: 0,
  teef: 0,
  accs: 15,
  task: 0,
  decl: 0,
  jbib: 15,
});

export const DEFAULT_BASE_OUTFIT = Object.freeze({
  male: { ...BASE_OUTFIT },
  female: { ...BASE_OUTFIT },
});

export const DEFAULT_RACE = "whi";
export const MAX_YTD_BYTES = 16 * 1024 * 1024;

export const EUP_NAMING_ISSUES = Object.freeze({
  "unrecognized-name": {
    severity: "warning",
    label: "Unrecognized file name",
  },
  "unknown-component": {
    severity: "warning",
    label: "Unknown component slot",
  },
  uppercase: {
    severity: "error",
    label: "Uppercase characters (streaming is case-sensitive on Linux servers)",
  },
  whitespace: {
    severity: "error",
    label: "Spaces in file name",
  },
  "texture-without-drawable": {
    severity: "warning",
    label: "Texture has no matching drawable",
  },
  "drawable-without-texture": {
    severity: "warning",
    label: "Drawable has no texture variant",
  },
  "index-gap": {
    severity: "warning",
    label: "Drawable indices are not contiguous",
  },
  "race-texture-missing": {
    severity: "warning",
    label: "Race-dependent drawable (_r) has only universal textures",
  },
  "mixed-peds": {
    severity: "warning",
    label: "Files target more than one ped",
  },
  "duplicate-drawable": {
    severity: "error",
    label: "Same component index declared twice",
  },
  "ytd-too-large": {
    severity: "warning",
    label: "Texture dictionary larger than 16 MB",
  },
  "variant-gap": {
    severity: "warning",
    label: "Texture variants skip a letter (in-game texture ids are contiguous)",
  },
});

const PED_PATTERN = /^(mp_[mf]_freemode_01)(?:_p)?_(.*)$/;
const DRAWABLE_PATTERN = /^(p_)?([a-z0-9]+)_(\d{3,})(?:_([ru]))?$/;
const TEXTURE_PATTERN = /^(p_)?([a-z0-9]+)_diff_(\d{3,})_([a-z])(?:_([a-z]{3}))?$/;

export function baseName(path) {
  if (typeof path !== "string") return "";
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

export function formatIndex(index) {
  const value = Number.isInteger(index) && index >= 0 ? index : 0;
  return String(value).padStart(3, "0");
}

export function componentDisplayName(component) {
  if (!component) return "";
  return COMPONENT_DISPLAY_NAMES[component] || component.toUpperCase();
}

export function isPropComponent(component) {
  return typeof component === "string" && component.startsWith("p_");
}

function pedFromPathSegments(path) {
  if (typeof path !== "string") return null;
  const lower = path.toLowerCase();
  for (const ped of PED_IDS) {
    if (lower.includes(`${ped}`)) return ped;
  }
  return null;
}

// Parses either a base-game ped file name (uppr_000_u.ydd, p_head_diff_000_a.ytd)
// or an addon streaming name (mp_m_freemode_01_<pack>^uppr_000_u.ydd).
export function parseEupFileName(fileName) {
  const original = baseName(fileName);
  if (!original) return null;

  const hasUppercase = /[A-Z]/.test(original);
  const hasSpaces = /\s/.test(original);
  const lower = original.toLowerCase();
  const extMatch = lower.match(/\.(ydd|ytd)$/);
  if (!extMatch) return null;
  const ext = extMatch[1];
  const stem = lower.slice(0, -4);

  let ped = null;
  let pack = null;
  let componentPart = stem;
  const caret = stem.indexOf("^");
  if (caret >= 0) {
    const prefix = stem.slice(0, caret);
    componentPart = stem.slice(caret + 1);
    const pedMatch = prefix.match(PED_PATTERN);
    if (!pedMatch) return null;
    ped = pedMatch[1];
    pack = pedMatch[2] || null;
  }

  let parsed = null;
  if (ext === "ydd") {
    const m = componentPart.match(DRAWABLE_PATTERN);
    if (!m) return null;
    const component = `${m[1] || ""}${m[2]}`;
    parsed = {
      component,
      index: Number.parseInt(m[3], 10),
      kind: "drawable",
      textureVariant: null,
      race: null,
      raceDependent: m[4] === "r",
    };
  } else {
    const m = componentPart.match(TEXTURE_PATTERN);
    if (!m) return null;
    const component = `${m[1] || ""}${m[2]}`;
    parsed = {
      component,
      index: Number.parseInt(m[3], 10),
      kind: "texture",
      textureVariant: m[4],
      race: m[5] || null,
      raceDependent: Boolean(m[5]) && m[5] !== "uni",
    };
  }

  const isProp = isPropComponent(parsed.component);
  const known = isProp
    ? PROP_IDS.includes(parsed.component)
    : COMPONENT_IDS.includes(parsed.component);

  return {
    name: original,
    ped,
    gender: ped ? GENDER_FOR_PED[ped] : null,
    pack,
    isProp,
    known,
    ext,
    hasUppercase,
    hasSpaces,
    ...parsed,
  };
}

function normalizeFileEntry(entry) {
  if (!entry) return null;
  if (typeof entry === "string") return { path: entry, name: baseName(entry), size: null };
  const path = typeof entry.path === "string" ? entry.path : "";
  const name = typeof entry.name === "string" && entry.name ? entry.name : baseName(path);
  const size = Number.isFinite(entry.size) ? entry.size : null;
  if (!path && !name) return null;
  return { path: path || name, name, size };
}

function emptyPed() {
  return { components: {}, props: {} };
}

function ensureDrawableEntry(bucket, component, index, pack, localIndex) {
  if (!bucket[component]) bucket[component] = { component, drawables: {} };
  const drawables = bucket[component].drawables;
  if (!drawables[index]) {
    drawables[index] = {
      component,
      index,
      pack,
      localIndex,
      drawablePath: null,
      drawableName: null,
      raceDependent: false,
      textures: [],
    };
  }
  return drawables[index];
}

// Every pack numbers its files from 000. Loaded together, each pack's
// drawables follow the previous pack's in the same slot, the way the game
// appends addon collections, so two packs never claim the same number. Packs
// keep the order their first file was listed in; files without a pack in
// their name come first. Textures count too, so a stray texture can never
// land on the next pack's drawable.
function packOffsets(parsedFiles) {
  const slots = new Map();
  for (const { parsed, ped } of parsedFiles) {
    const key = `${ped}|${parsed.isProp ? "p" : "c"}|${parsed.component}`;
    if (!slots.has(key)) slots.set(key, new Map());
    const counts = slots.get(key);
    const pack = parsed.pack || "";
    counts.set(pack, Math.max(counts.get(pack) || 0, parsed.index + 1));
  }
  const offsets = new Map();
  for (const [key, counts] of slots) {
    const packs = [...counts.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : 0));
    let start = 0;
    for (const pack of packs) {
      offsets.set(`${key}|${pack}`, start);
      start += counts.get(pack);
    }
  }
  return offsets;
}

function compareTextures(a, b) {
  if (a.variant !== b.variant) return a.variant < b.variant ? -1 : 1;
  const ra = a.race || "";
  const rb = b.race || "";
  if (ra === rb) return 0;
  if (ra === "uni") return -1;
  if (rb === "uni") return 1;
  return ra < rb ? -1 : 1;
}

// Groups ydd/ytd files by ped -> component -> drawable index. Files without a
// ped in their name are attributed to the ped found in their path, otherwise to
// options.defaultPed. Unparseable files end up in `unknown`. A drawable's index
// is its file number plus the drawables of the packs listed before its own
// (see packOffsets); `pack` and `localIndex` keep the file's own identity.
export function groupEupAssets(fileList, options = {}) {
  const defaultPed = PED_IDS.includes(options.defaultPed) ? options.defaultPed : null;
  const result = { peds: {}, unknown: [], files: [] };
  const entries = Array.isArray(fileList) ? fileList : [];
  const parsedFiles = [];

  for (const raw of entries) {
    const file = normalizeFileEntry(raw);
    if (!file) continue;
    const parsed = parseEupFileName(file.name);
    if (!parsed) {
      result.unknown.push(file.path);
      continue;
    }
    const ped = parsed.ped || pedFromPathSegments(file.path) || defaultPed || "unassigned";
    parsedFiles.push({ file, parsed, ped });
  }

  const offsets = packOffsets(parsedFiles);
  for (const { file, parsed, ped } of parsedFiles) {
    if (!result.peds[ped]) result.peds[ped] = emptyPed();
    const bucket = parsed.isProp ? result.peds[ped].props : result.peds[ped].components;
    const pack = parsed.pack || "";
    const offset = offsets.get(`${ped}|${parsed.isProp ? "p" : "c"}|${parsed.component}|${pack}`) || 0;
    const entry = ensureDrawableEntry(bucket, parsed.component, offset + parsed.index, pack, parsed.index);

    if (parsed.kind === "drawable") {
      if (entry.drawablePath && entry.drawablePath !== file.path) {
        entry.duplicates = entry.duplicates || [];
        entry.duplicates.push(file.path);
      } else {
        entry.drawablePath = file.path;
        entry.drawableName = file.name;
        entry.raceDependent = parsed.raceDependent;
      }
    } else {
      entry.textures.push({
        variant: parsed.textureVariant,
        race: parsed.race,
        path: file.path,
        name: file.name,
        size: file.size,
      });
    }
    result.files.push({ ...file, parsed, ped });
  }

  for (const ped of Object.values(result.peds)) {
    for (const bucket of [ped.components, ped.props]) {
      for (const comp of Object.values(bucket)) {
        for (const drawable of Object.values(comp.drawables)) {
          drawable.textures.sort(compareTextures);
        }
      }
    }
  }

  return result;
}

export function listDrawableIndices(componentEntry) {
  if (!componentEntry?.drawables) return [];
  return Object.keys(componentEntry.drawables)
    .map((key) => Number.parseInt(key, 10))
    .filter((value) => Number.isInteger(value))
    .sort((a, b) => a - b);
}

export function listTextureVariants(drawableEntry) {
  const seen = new Set();
  for (const texture of drawableEntry?.textures || []) {
    if (texture?.variant) seen.add(texture.variant);
  }
  return Array.from(seen).sort();
}

// Picks the ytd for a texture variant. Falls back to variant "a", then the
// first texture. Race preference: requested race, then "uni", then "whi".
export function resolveTextureForDrawable(drawableEntry, variant, options = {}) {
  const textures = Array.isArray(drawableEntry?.textures) ? drawableEntry.textures : [];
  if (textures.length === 0) return null;
  const preferredRace = typeof options.race === "string" ? options.race : null;

  const pickRace = (candidates) => {
    if (candidates.length === 0) return null;
    const order = [preferredRace, "uni", DEFAULT_RACE].filter(Boolean);
    for (const race of order) {
      const found = candidates.find((texture) => texture.race === race);
      if (found) return found;
    }
    return candidates.find((texture) => !texture.race) || candidates[0];
  };

  const wanted = typeof variant === "string" && variant ? variant : "a";
  const exact = pickRace(textures.filter((texture) => texture.variant === wanted));
  if (exact) return exact;
  const fallback = pickRace(textures.filter((texture) => texture.variant === "a"));
  if (fallback) return fallback;
  return pickRace(textures);
}

export function buildOutfitLabel({ gender, selections } = {}) {
  const parts = [];
  const entries = selections && typeof selections === "object" ? Object.entries(selections) : [];
  const order = [...COMPONENT_IDS, ...PROP_IDS];
  entries
    .filter(([, value]) => value && Number.isInteger(value.index))
    .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
    .forEach(([component, value]) => {
      parts.push(`${component} ${formatIndex(value.index)}${value.variant || ""}`);
    });
  const prefix = gender === "female" ? "Female" : gender === "male" ? "Male" : "EUP";
  if (parts.length === 0) return `${prefix} base`;
  const shown = parts.slice(0, 4).join(", ");
  const extra = parts.length > 4 ? ` +${parts.length - 4}` : "";
  return `${prefix}: ${shown}${extra}`;
}

function issue(code, path, detail) {
  const spec = EUP_NAMING_ISSUES[code];
  return {
    code,
    severity: spec?.severity || "warning",
    message: detail ? `${spec?.label || code}: ${detail}` : spec?.label || code,
    path: path || null,
  };
}

// Names a drawable the way its files are numbered: pack, slot, file number.
function drawableLabel(pedId, component, drawable) {
  const pack = drawable.pack ? ` ${drawable.pack}` : "";
  return `${pedId}${pack} ${component} ${formatIndex(drawable.localIndex)}`;
}

// Reports naming problems that break streaming or produce missing textures in
// game. Size checks only run for entries that carry a size.
export function validateEupNames(fileList, options = {}) {
  const issues = [];
  const grouped = groupEupAssets(fileList, options);

  for (const path of grouped.unknown) {
    issues.push(issue("unrecognized-name", path, baseName(path)));
  }

  const pedsSeen = new Set();
  for (const file of grouped.files) {
    const { parsed } = file;
    if (parsed.hasUppercase) issues.push(issue("uppercase", file.path, file.name));
    if (parsed.hasSpaces) issues.push(issue("whitespace", file.path, file.name));
    if (!parsed.known) issues.push(issue("unknown-component", file.path, parsed.component));
    if (parsed.ped) pedsSeen.add(parsed.ped);
    if (
      parsed.ext === "ytd" &&
      Number.isFinite(file.size) &&
      file.size > MAX_YTD_BYTES
    ) {
      issues.push(
        issue("ytd-too-large", file.path, `${file.name} (${(file.size / 1048576).toFixed(1)} MB)`),
      );
    }
  }
  if (pedsSeen.size > 1) {
    issues.push(issue("mixed-peds", null, Array.from(pedsSeen).join(", ")));
  }

  for (const [pedId, ped] of Object.entries(grouped.peds)) {
    for (const bucket of [ped.components, ped.props]) {
      for (const comp of Object.values(bucket)) {
        const indices = listDrawableIndices(comp);
        for (const index of indices) {
          const drawable = comp.drawables[index];
          const label = drawableLabel(pedId, comp.component, drawable);
          if (!drawable.drawablePath) {
            issues.push(
              issue("texture-without-drawable", drawable.textures[0]?.path || null, label),
            );
          } else if (drawable.textures.length === 0) {
            issues.push(issue("drawable-without-texture", drawable.drawablePath, label));
          }
          if (drawable.duplicates?.length) {
            for (const duplicate of drawable.duplicates) {
              issues.push(issue("duplicate-drawable", duplicate, label));
            }
          }
          const variants = listTextureVariants(drawable);
          const missing = missingVariantLetters(variants);
          if (missing.length > 0) {
            issues.push(
              issue("variant-gap", drawable.textures[0]?.path || null, `${label} missing ${missing.join(", ")}`),
            );
          }
          if (
            drawable.drawablePath &&
            drawable.raceDependent &&
            drawable.textures.length > 0 &&
            !drawable.textures.some((texture) => texture.race && texture.race !== "uni")
          ) {
            issues.push(issue("race-texture-missing", drawable.drawablePath, label));
          }
        }
        if (indices.length > 1) {
          for (let i = 1; i < indices.length; i += 1) {
            if (indices[i] !== indices[i - 1] + 1) {
              issues.push(
                issue(
                  "index-gap",
                  null,
                  `${drawableLabel(pedId, comp.component, comp.drawables[indices[i - 1]])} -> ${formatIndex(comp.drawables[indices[i]].localIndex)}`,
                ),
              );
            }
          }
        }
      }
    }
  }

  return issues;
}

function localDrawableIndex(file, component) {
  const name = String(file || "").toLowerCase();
  const pattern = isPropComponent(component)
    ? new RegExp(`^${component}_(\\d{3})\\.ydd$`)
    : new RegExp(`^${component}_(\\d{3})_[ur](?:_\\d+)?\\.ydd$`);
  const match = name.match(pattern);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * In-game drawable numbers for one component. The game numbers a ped's
 * drawables across its clothing collections in load order: the ped's own
 * folder first, then each DLC collection (`collections`, as ordered by the
 * bridge). Each DLC folder numbers its files from 000, so a collection's range
 * starts where the previous one ended.
 */
export function buildDrawableRanges(entries, collections, component) {
  const counts = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.kind && entry.kind !== "ydd") continue;
    const local = localDrawableIndex(entry?.file, component);
    if (local === null) continue;
    const folder = String(entry.folder || "").toLowerCase();
    counts.set(folder, Math.max(counts.get(folder) || 0, local + 1));
  }
  const ranges = [];
  let start = 0;
  for (const collection of Array.isArray(collections) ? collections : []) {
    const folder = String(collection?.folder || "").toLowerCase();
    const count = counts.get(folder) || 0;
    if (count === 0) continue;
    ranges.push({ folder, pack: collection.pack || "", start, count, server: collection.server === true });
    start += count;
  }
  return ranges;
}

/**
 * What the game offers for one component: the in-game numbers that have a
 * drawable file (gaps are skipped), and the texture letters of each number.
 */
export function buildGameDrawableIndex(entries, collections, component) {
  const ranges = buildDrawableRanges(entries, collections, component);
  const prop = isPropComponent(component);
  const textureRe = prop
    ? new RegExp(`^${component}_diff_(\\d{3})_([a-z])\\.ytd$`)
    : new RegExp(`^${component}_diff_(\\d{3})_([a-z])_[a-z]+\\.ytd$`);
  const byFolder = new Map(ranges.map((range) => [range.folder, { range, drawables: new Set(), letters: new Map() }]));
  for (const entry of Array.isArray(entries) ? entries : []) {
    const folder = byFolder.get(String(entry?.folder || "").toLowerCase());
    if (!folder) continue;
    const local = localDrawableIndex(entry.file, component);
    if (local !== null) {
      folder.drawables.add(local);
      continue;
    }
    const match = String(entry.file || "").toLowerCase().match(textureRe);
    if (!match) continue;
    const key = Number.parseInt(match[1], 10);
    if (!folder.letters.has(key)) folder.letters.set(key, new Set());
    folder.letters.get(key).add(match[2]);
  }
  const numbers = [];
  const variants = new Map();
  for (const { range, drawables, letters } of byFolder.values()) {
    for (const local of [...drawables].sort((a, b) => a - b)) {
      const number = range.start + local;
      numbers.push(number);
      variants.set(number, [...(letters.get(local) || [])].sort());
    }
  }
  numbers.sort((a, b) => a - b);
  const last = ranges[ranges.length - 1];
  const lastGame = ranges.filter((range) => !range.server).pop();
  return {
    ranges,
    numbers,
    variants,
    total: last ? last.start + last.count : 0,
    // Where the game's own clothing ends and loaded server packs begin.
    gameTotal: lastGame ? lastGame.start + lastGame.count : 0,
  };
}

/** The next (step 1) or previous (step -1) number that has a drawable, wrapping. */
export function stepGameDrawable(numbers, current, step) {
  if (!Array.isArray(numbers) || numbers.length === 0) return current;
  if (step > 0) return numbers.find((n) => n > current) ?? numbers[0];
  for (let i = numbers.length - 1; i >= 0; i -= 1) if (numbers[i] < current) return numbers[i];
  return numbers[numbers.length - 1];
}

/** The collection and file number behind an in-game drawable number, or null. */
export function resolveDrawableNumber(ranges, index) {
  if (!Number.isInteger(index) || index < 0) return null;
  const range = (ranges || []).find((item) => index >= item.start && index < item.start + item.count);
  if (!range) return null;
  const resolved = { folder: range.folder, pack: range.pack, local: index - range.start };
  if (range.server) resolved.server = true;
  return resolved;
}

/** The in-game drawable number of a collection's file number, or null when this install lacks it. */
export function drawableNumberFor(ranges, folder, local) {
  if (!Number.isInteger(local) || local < 0 || typeof folder !== "string") return null;
  const lower = folder.toLowerCase();
  const range = (ranges || []).find((item) => item.folder === lower);
  if (!range || local >= range.count) return null;
  return range.start + local;
}

/**
 * Loaded addon clothing as clothing collections for one ped, shaped like the
 * `list_ped_assets` listing: a folder per pack named the way the game names
 * DLC folders (`<ped>_<pack>`, props `<ped>_p_<pack>`), entries with the
 * file's `path`, and collections marked `server`. On a server the same packs
 * number their drawables after the game's clothing, so a vMenu save's
 * collection name finds its pack here. Packs keep the order their first file
 * was listed in. Files without a pack in their name replace game files
 * instead of adding drawables, so they are left out.
 */
export function buildServerPackListing(files, ped) {
  const entries = [];
  const collections = [];
  const seen = new Set();
  for (const file of Array.isArray(files) ? files : []) {
    const parsed = file?.parsed;
    if (!parsed?.pack || !parsed.known || file.ped !== ped || parsed.ped !== ped) continue;
    const folder = parsed.isProp ? `${ped}_p_${parsed.pack}` : `${ped}_${parsed.pack}`;
    const name = baseName(file.path || file.name).toLowerCase();
    entries.push({ folder, file: name.slice(name.indexOf("^") + 1), kind: parsed.ext, path: file.path });
    if (!seen.has(folder)) {
      seen.add(folder);
      collections.push({ folder, pack: parsed.pack, server: true });
    }
  }
  return { entries, collections };
}

/**
 * The game listing with loaded server packs after the game's own
 * collections. Without the game's collections there is no numbering to
 * extend. A pack whose folder the game already has is skipped: its numbers
 * would be ambiguous.
 */
export function extendPedListing(listing, server) {
  if (!listing?.collections?.length || !server?.collections?.length) return listing;
  const taken = new Set(listing.collections.map((item) => String(item.folder || "").toLowerCase()));
  const added = server.collections.filter((item) => !taken.has(item.folder));
  if (added.length === 0) return listing;
  const folders = new Set(added.map((item) => item.folder));
  return {
    ...listing,
    entries: [...(listing.entries || []), ...server.entries.filter((entry) => folders.has(entry.folder))],
    collections: [...listing.collections, ...added],
  };
}

// Chooses the base-game ydd and diffuse ytd for one slot from a
// `list_ped_assets` listing. With `options.collections`, `index` is the
// in-game drawable number and is resolved to its DLC folder; without it, the
// ped's own folder wins over DLC folders. `_u` (universal) drawables win over
// `_r` unless only `_r` exists.
export function selectBaseGameAssets(entries, ped, component, index, options = {}) {
  let list = Array.isArray(entries) ? entries : [];
  const race = typeof options.race === "string" ? options.race : DEFAULT_RACE;
  const prop = isPropComponent(component);
  let fileIndex = index;
  if (Array.isArray(options.collections) && options.collections.length > 0) {
    const resolved = resolveDrawableNumber(buildDrawableRanges(list, options.collections, component), index);
    if (!resolved) return { drawable: null, texture: null };
    list = list.filter((entry) => String(entry?.folder || "").toLowerCase() === resolved.folder);
    fileIndex = resolved.local;
  }
  const idx = formatIndex(fileIndex);
  const variant = /^[a-z]$/.test(options.variant || "") ? options.variant : "a";
  const folderRank = (folder) => {
    const lower = String(folder || "").toLowerCase();
    if (lower === ped) return 0;
    if (lower === `${ped}_p`) return prop ? 0 : 2;
    if (lower.startsWith(`${ped}_`)) return 1;
    return 3;
  };
  const byPreference = (a, b) => folderRank(a.folder) - folderRank(b.folder);

  const drawableNames = prop
    ? [`${component}_${idx}.ydd`]
    : [`${component}_${idx}_u.ydd`, `${component}_${idx}_r.ydd`];
  const textureNames = prop
    ? [`${component}_diff_${idx}_${variant}.ytd`]
    : [
        `${component}_diff_${idx}_${variant}_uni.ytd`,
        `${component}_diff_${idx}_${variant}_${race}.ytd`,
        `${component}_diff_${idx}_${variant}_whi.ytd`,
      ];

  const find = (names, kind) => {
    return list.filter((entry) => entry && (!entry.kind || entry.kind === kind) &&
      names.includes(String(entry.file || "").toLowerCase()))
      .sort((a, b) => byPreference(a, b) ||
        names.indexOf(String(a.file).toLowerCase()) - names.indexOf(String(b.file).toLowerCase()))[0] || null;
  };

  const drawable = find(drawableNames, "ydd");
  let texture = null;
  if (drawable) {
    const raceDependent = /_r\.ydd$/i.test(drawable.file || "");
    const names = raceDependent
      ? [
          `${component}_diff_${idx}_${variant}_${race}.ytd`,
          `${component}_diff_${idx}_${variant}_whi.ytd`,
          `${component}_diff_${idx}_${variant}_uni.ytd`,
        ]
      : textureNames;
    texture = find(names, "ytd");
    if (!texture) {
      const prefix = `${component}_diff_${idx}_`;
      const any = list
        .filter(
          (entry) =>
            entry?.kind === "ytd" && String(entry.file || "").toLowerCase().startsWith(prefix),
        )
        .sort(byPreference);
      texture = any[0] || null;
    }
  }

  return { drawable, texture };
}

// Classifies an exported DDS by its name so the assembler can bind it.
export function classifyTextureName(name) {
  const lower = String(name || "").toLowerCase().replace(/\.dds$/, "");
  if (/_normal(_|$)|_n$|_nrm|bump/.test(lower)) return "normal";
  if (/_spec(_|$)|_s$|specmap/.test(lower)) return "specular";
  if (/_diff(_|$)|_d$/.test(lower)) return "diffuse";
  return "other";
}

// Letters a..z map to in-game texture ids 0..25, so a missing letter shifts or
// drops every later variant.
export function missingVariantLetters(variants) {
  const present = new Set((variants || []).filter((value) => /^[a-z]$/.test(value)));
  if (present.size === 0) return [];
  const last = Math.max(...Array.from(present, (value) => value.charCodeAt(0)));
  const missing = [];
  for (let code = 97; code < last; code += 1) {
    const letter = String.fromCharCode(code);
    if (!present.has(letter)) missing.push(letter);
  }
  return missing;
}

export function variantTextureIndex(variant) {
  if (typeof variant !== "string" || !/^[a-z]$/.test(variant)) return 0;
  return variant.charCodeAt(0) - 97;
}

// SetPedComponentVariation component ids follow COMPONENT_IDS order;
// SetPedPropIndex anchor ids follow PROP_IDS order.
export function componentGameId(component) {
  const index = COMPONENT_IDS.indexOf(component);
  return index >= 0 ? index : null;
}

export function propAnchorId(component) {
  const index = PROP_IDS.indexOf(component);
  return index >= 0 ? index : null;
}

// Steps through `list` from `current`, wrapping at both ends. An unknown
// current value starts at the first (delta > 0) or last (delta < 0) entry.
export function cycleValue(list, current, delta) {
  const values = Array.isArray(list) ? list : [];
  if (values.length === 0) return null;
  const position = values.indexOf(current);
  if (position < 0) return delta < 0 ? values[values.length - 1] : values[0];
  const step = delta < 0 ? -1 : 1;
  return values[(position + step + values.length) % values.length];
}

// Case- and separator-insensitive key so watcher paths match scanned paths.
export function pathKey(path) {
  return typeof path === "string" ? path.replace(/\//g, "\\").toLowerCase() : "";
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export const MAX_TEXTURE_DIMENSION = 2048;
const UNCOMPRESSED_FORMATS = new Set(["RGBA", "BGRA"]);

function isPowerOfTwo(value) {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

// Streaming-budget hints for one DDS header ({ width, height, mipMapCount,
// fmt }). These are advisories; the game still loads the file.
export function textureBudgetWarnings(info) {
  if (!info || !Number.isFinite(info.width) || !Number.isFinite(info.height)) return [];
  const warnings = [];
  const largest = Math.max(info.width, info.height);
  if (largest > MAX_TEXTURE_DIMENSION) {
    warnings.push(`${info.width}x${info.height} exceeds ${MAX_TEXTURE_DIMENSION} px`);
  }
  if (!isPowerOfTwo(info.width) || !isPowerOfTwo(info.height)) {
    warnings.push("not a power of two");
  }
  if (largest >= 64 && (!Number.isFinite(info.mipMapCount) || info.mipMapCount <= 1)) {
    warnings.push("no mipmaps");
  }
  if (UNCOMPRESSED_FORMATS.has(info.fmt)) {
    warnings.push("uncompressed");
  }
  return warnings;
}

export function thumbnailFileName({ gender, component, index, variant } = {}) {
  const prefix = gender === "female" ? "female" : "male";
  const letter = typeof variant === "string" && /^[a-z]$/.test(variant) ? variant : "a";
  return `${prefix}_${component}_${formatIndex(index)}_${letter}.png`;
}

// One job per drawable (and per texture variant when allVariants is set).
// Drawables without a ydd are skipped; they cannot render.
export function listThumbnailJobs(pedAssets, { gender, components = null, allVariants = false, race } = {}) {
  const jobs = [];
  const wanted = Array.isArray(components) && components.length > 0 ? new Set(components) : null;
  const order = [...COMPONENT_IDS, ...PROP_IDS];
  const rank = (component) => {
    const position = order.indexOf(component);
    return position < 0 ? order.length : position;
  };
  const buckets = [
    ...Object.values(pedAssets?.components || {}),
    ...Object.values(pedAssets?.props || {}),
  ].sort((a, b) => rank(a.component) - rank(b.component));
  for (const entry of buckets) {
    if (wanted && !wanted.has(entry.component)) continue;
    for (const index of listDrawableIndices(entry)) {
      const drawable = entry.drawables[index];
      if (!drawable?.drawablePath) continue;
      const variants = listTextureVariants(drawable);
      const targets = allVariants && variants.length > 0 ? variants : [variants[0] || "a"];
      for (const variant of targets) {
        const texture = resolveTextureForDrawable(drawable, variant, { race });
        jobs.push({
          component: entry.component,
          index,
          variant,
          drawablePath: drawable.drawablePath,
          ytdPath: texture?.path || null,
          fileName: thumbnailFileName({ gender, component: entry.component, index, variant }),
        });
      }
    }
  }
  return jobs;
}

function luaComment(text) {
  return String(text || "").replace(/[\r\n]+/g, " ");
}

// `slots` entries: { component, index, variant, source: "eup" | "piece" |
// "base", file }. Pack drawables carry their stream-file index; the game
// appends addon drawables after its own, so the header tells the author which
// ids need an offset. Addon pieces carry the index in their file name when it
// has one; a piece without one is written as a commented line to fill in.
// Base slots from a loaded server pack (`server: true`, `pack`) already carry
// the in-game number, which holds when the server loads the same packs in the
// same order. Head and hair base slots are left to the player's character.
export function buildOutfitLua({ name, gender, slots } = {}) {
  const ped = gender === "female" ? PED_FOR_GENDER.female : PED_FOR_GENDER.male;
  const list = Array.isArray(slots) ? slots : [];
  const isAddon = (slot) => slot.source === "eup" || slot.source === "piece";
  const components = list
    .filter((slot) => componentGameId(slot.component) !== null)
    .filter((slot) => isAddon(slot) || (slot.component !== "head" && slot.component !== "hair"))
    .sort((a, b) => componentGameId(a.component) - componentGameId(b.component));
  const props = list
    .filter((slot) => propAnchorId(slot.component) !== null)
    .sort((a, b) => propAnchorId(a.component) - propAnchorId(b.component));
  const hasPackSlots = list.some(isAddon);
  const hasServerSlots = [...components, ...props].some((slot) => slot.source === "base" && slot.server);

  const note = (slot) => {
    if (slot.source === "piece") return `addon piece ${luaComment(slot.file)}`.trimEnd();
    if (slot.source === "eup") return `pack ${luaComment(slot.file)}`.trimEnd();
    if (slot.server) return `server pack ${luaComment(slot.pack)}`.trimEnd();
    return "base";
  };
  const line = (slot, call) => {
    if (Number.isInteger(slot.index)) return `${call(slot.index)} -- ${slot.component} ${note(slot)}`;
    return `-- ${call("DRAWABLE_ID")} -- ${slot.component} ${note(slot)}: name it <slot>_<000>_u.ydd to get an id`;
  };

  const lines = [`-- ${luaComment(name || "Cortex Studio outfit")} (${ped})`];
  if (hasPackSlots) {
    lines.push("-- Pack ids are stream-file indices. Add the drawables the game and earlier");
    lines.push("-- clothing packs register for that slot before using them in game.");
  }
  if (hasServerSlots) {
    lines.push("-- Server pack ids count from the game's clothing through your loaded packs,");
    lines.push("-- in load order. They match a server that loads the same packs in that order.");
  }
  lines.push("local ped = PlayerPedId()");
  for (const slot of components) {
    const id = componentGameId(slot.component);
    const texture = variantTextureIndex(slot.variant);
    lines.push(line(slot, (index) => `SetPedComponentVariation(ped, ${id}, ${index}, ${texture}, 0)`));
  }
  for (const slot of props) {
    const id = propAnchorId(slot.component);
    const texture = variantTextureIndex(slot.variant);
    lines.push(line(slot, (index) => `SetPedPropIndex(ped, ${id}, ${index}, ${texture}, true)`));
  }
  return `${lines.join("\n")}\n`;
}

export const MAX_OUTFIT_PRESETS = 64;

const MAX_SAVED_PATH = 1024;

function normalizeSlotMap(value) {
  const result = {};
  if (!value || typeof value !== "object") return result;
  for (const [component, slot] of Object.entries(value)) {
    if (!slot || typeof slot !== "object") continue;
    const next = {};
    if (Number.isInteger(slot.index) && slot.index >= 0) next.index = slot.index;
    if (typeof slot.variant === "string" && /^[a-z]$/.test(slot.variant)) next.variant = slot.variant;
    if (typeof slot.enabled === "boolean") next.enabled = slot.enabled;
    // The pack file a selection wore, so the outfit finds it in any session.
    if (typeof slot.path === "string" && slot.path && slot.path.length <= MAX_SAVED_PATH) next.path = slot.path;
    if (Object.keys(next).length > 0) result[component] = next;
  }
  return result;
}

/**
 * Pack selections with the loaded pack's file path added, for saving. A pack
 * index only means something next to the pack it came from.
 */
export function selectionsWithPaths(selections, pedAssets) {
  const result = {};
  for (const [component, selection] of Object.entries(selections || {})) {
    if (!selection || typeof selection !== "object") continue;
    const bucket = isPropComponent(component) ? pedAssets?.props : pedAssets?.components;
    const path = bucket?.[component]?.drawables?.[selection.index]?.drawablePath;
    result[component] = path ? { ...selection, path } : { ...selection };
  }
  return result;
}

/**
 * A saved outfit's pack selections against the loaded pack. A selection saved
 * with a path wears that file wherever it sits now, or is left out (listed in
 * `missing`) when that file is not loaded. Selections saved before paths were
 * kept use their index, as they always did.
 */
export function resolveOutfitSelections(selections, pedAssets) {
  const resolved = {};
  const missing = [];
  for (const [component, selection] of Object.entries(selections || {})) {
    if (!selection || typeof selection !== "object") continue;
    const { path, ...rest } = selection;
    if (!path) {
      resolved[component] = rest;
      continue;
    }
    const bucket = isPropComponent(component) ? pedAssets?.props : pedAssets?.components;
    const drawables = bucket?.[component]?.drawables || {};
    const wanted = pathKey(path);
    const found = Object.entries(drawables).find(([, drawable]) => drawable?.drawablePath && pathKey(drawable.drawablePath) === wanted);
    if (found) resolved[component] = { ...rest, index: Number(found[0]) };
    else missing.push({ component, path });
  }
  return { selections: resolved, missing };
}

// Saved outfits restored from storage. Malformed entries are dropped instead
// of guessed.
export function normalizeOutfitPresets(value) {
  const source = value && typeof value === "object" ? value : {};
  const result = { male: [], female: [] };
  for (const gender of ["male", "female"]) {
    const list = Array.isArray(source[gender]) ? source[gender] : [];
    for (const preset of list) {
      if (result[gender].length >= MAX_OUTFIT_PRESETS) break;
      if (!preset || typeof preset !== "object") continue;
      if (typeof preset.id !== "string" || !preset.id) continue;
      const name = typeof preset.name === "string" ? preset.name.trim().slice(0, 80) : "";
      if (!name) continue;
      result[gender].push({
        id: preset.id,
        name,
        selections: normalizeSlotMap(preset.selections),
        baseOverrides: normalizeSlotMap(preset.baseOverrides),
        // Ids of the addon pieces the outfit wears. Ids of pieces removed
        // since are skipped when the outfit is applied.
        pieces: Array.isArray(preset.pieces)
          ? [...new Set(preset.pieces.filter((id) => typeof id === "string" && PIECE_ID.test(id)))].slice(0, MAX_ADDON_PIECES)
          : [],
        // Their files: piece ids belong to one session, files do not.
        piecePaths: Array.isArray(preset.piecePaths)
          ? [...new Set(preset.piecePaths.filter((path) => typeof path === "string" && /\.ydd$/i.test(path) && path.length <= MAX_SAVED_PATH))].slice(0, MAX_ADDON_PIECES)
          : [],
      });
    }
  }
  return result;
}

// Freemode bodies ship as `_whi` textures only; the game sets skin tone from
// the character's heritage. Each tone is the skin colour of the game's own
// heritage heads (median cheek and forehead texels of head_diff_*_<race>),
// and `tint` is that colour divided by the `_whi` head's, so multiplying a
// `_whi` texture by it lands on the game's colour. `swatch` is the measured
// skin colour, shown in the picker.
export const SKIN_TONES = Object.freeze([
  { id: "light", label: "Light", tint: null, swatch: "#a37a6a" },
  { id: "fair", label: "Fair", tint: "#e6e2c8", swatch: "#936c53" },
  { id: "tan", label: "Tan", tint: "#d5bea8", swatch: "#885b46" },
  { id: "olive", label: "Olive", tint: "#c8b8ab", swatch: "#805847" },
  { id: "brown", label: "Brown", tint: "#b99f90", swatch: "#764c3c" },
  { id: "dark", label: "Dark", tint: "#776d6a", swatch: "#4c342c" },
]);
export const DEFAULT_SKIN_TONE = "light";

// Earlier saved tone ids map to the nearest calibrated tone.
const LEGACY_SKIN_TONES = { medium: "fair", deep: "dark" };

export function normalizeSkinTone(value) {
  const id = LEGACY_SKIN_TONES[value] || value;
  return SKIN_TONES.some((tone) => tone.id === id) ? id : DEFAULT_SKIN_TONE;
}

// Hair textures are not colour images: green is strand brightness, red marks
// highlight streaks, alpha is the cutout. The game colours them with a hair
// and a highlight colour; these are the preview's choices.
export const HAIR_COLORS = Object.freeze([
  { id: "black", label: "Black", color: "#1b1a19" },
  { id: "dark-brown", label: "Dark brown", color: "#2e2018" },
  { id: "brown", label: "Brown", color: "#4c3424" },
  { id: "light-brown", label: "Light brown", color: "#6d4c33" },
  { id: "auburn", label: "Auburn", color: "#6b2c19" },
  { id: "ginger", label: "Ginger", color: "#a0532b" },
  { id: "dark-blonde", label: "Dark blonde", color: "#8a6a45" },
  { id: "blonde", label: "Blonde", color: "#b8955f" },
  { id: "platinum", label: "Platinum", color: "#d6c7a4" },
  { id: "grey", label: "Grey", color: "#878582" },
  { id: "white", label: "White", color: "#d9d6d0" },
  { id: "red", label: "Red", color: "#8c1d1d" },
  { id: "pink", label: "Pink", color: "#c25a85" },
  { id: "purple", label: "Purple", color: "#5b3a8c" },
  { id: "blue", label: "Blue", color: "#2b4b8c" },
  { id: "green", label: "Green", color: "#2f6b33" },
]);
export const DEFAULT_HAIR = Object.freeze({ color: "#2e2018", highlight: "#4c3424" });

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function normalizeHair(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    color: HEX_COLOR.test(source.color || "") ? source.color.toLowerCase() : DEFAULT_HAIR.color,
    highlight: HEX_COLOR.test(source.highlight || "") ? source.highlight.toLowerCase() : DEFAULT_HAIR.highlight,
  };
}

export function skinToneTint(id) {
  return SKIN_TONES.find((tone) => tone.id === id)?.tint || null;
}

const SKIN_TINT_COMPONENTS = new Set(["head", "uppr"]);

/** Whether a loaded slot shows freemode skin that the skin tone should tint. */
export function isSkinTintSlot({ component, drawableFile, textureFile } = {}) {
  if (!SKIN_TINT_COMPONENTS.has(component)) return false;
  if (!/_r(?:_\d+)?\.ydd$/i.test(baseName(drawableFile || ""))) return false;
  return /_whi\.ytd$/i.test(baseName(textureFile || ""));
}

/** Race codes that the loaded clothing ships textures for, besides `uni`. */
export function listPackRaces(pedAssets) {
  const races = new Set();
  for (const bucket of [pedAssets?.components, pedAssets?.props]) {
    for (const entry of Object.values(bucket || {})) {
      for (const drawable of Object.values(entry?.drawables || {})) {
        for (const texture of drawable?.textures || []) {
          if (texture?.race && texture.race !== "uni") races.add(texture.race);
        }
      }
    }
  }
  return RACE_IDS.filter((id) => races.has(id));
}

// Body presets: a heritage face with its matching skin tone, a base-game
// hairstyle and a hair colour. Heads 0-20 and 42-44 are the game's male
// parent faces, 21-41 and 45 the female ones; each face's race comes from its
// head_diff texture suffix, and the tone is the calibrated match for it.
// Hair numbers stay inside the base game's 0-15 so every preset loads on an
// unmodded install. Labels describe what changes, not who it is.
export const BODY_PRESETS = Object.freeze({
  male: Object.freeze([
    { id: "m-light-brown", head: 0, skin: "light", hair: 4, hairColor: "brown" },
    { id: "m-light-blonde", head: 1, skin: "light", hair: 11, hairColor: "blonde" },
    { id: "m-light-ginger", head: 12, skin: "light", hair: 5, hairColor: "ginger" },
    { id: "m-fair-black", head: 6, skin: "fair", hair: 10, hairColor: "black" },
    { id: "m-tan-dark-brown", head: 10, skin: "tan", hair: 2, hairColor: "dark-brown" },
    { id: "m-olive-black", head: 4, skin: "olive", hair: 9, hairColor: "black" },
    { id: "m-brown-black", head: 8, skin: "brown", hair: 5, hairColor: "black" },
    { id: "m-dark-black", head: 15, skin: "dark", hair: 12, hairColor: "black" },
  ]),
  female: Object.freeze([
    { id: "f-light-brown", head: 21, skin: "light", hair: 4, hairColor: "brown" },
    { id: "f-light-blonde", head: 22, skin: "light", hair: 7, hairColor: "blonde" },
    { id: "f-light-auburn", head: 33, skin: "light", hair: 15, hairColor: "auburn" },
    { id: "f-fair-black", head: 27, skin: "fair", hair: 12, hairColor: "black" },
    { id: "f-tan-dark-brown", head: 31, skin: "tan", hair: 11, hairColor: "dark-brown" },
    { id: "f-olive-dark-brown", head: 25, skin: "olive", hair: 10, hairColor: "dark-brown" },
    { id: "f-brown-black", head: 29, skin: "brown", hair: 9, hairColor: "black" },
    { id: "f-dark-black", head: 23, skin: "dark", hair: 14, hairColor: "black" },
  ]),
});

/** Presets for a gender with display data resolved (labels, swatches, hair colours). */
export function bodyPresetsFor(gender) {
  const list = BODY_PRESETS[gender === "female" ? "female" : "male"];
  return list.map((preset) => {
    const tone = SKIN_TONES.find((item) => item.id === preset.skin) || SKIN_TONES[0];
    const hair = HAIR_COLORS.find((item) => item.id === preset.hairColor) || HAIR_COLORS[1];
    return {
      ...preset,
      label: `${tone.label} skin, ${hair.label.toLowerCase()} hair`,
      skinSwatch: tone.swatch,
      hairColors: { color: hair.color, highlight: hair.color },
    };
  });
}

// Clothing presets for Photo Mode extras: base-game outfits over the bare body.
// Every pairing was rendered from the game files, skinned in the walk and
// hands-on-belt animations, and checked: tops are paired with the arm torso
// (uppr) their sleeves expect, so no arm pokes through or goes missing at the
// shoulder, and open tops with an undershirt (accs) short enough to stay
// inside the jacket and cover the torso's hidden chest.
export const CLOTHING_PRESETS = Object.freeze({
  male: Object.freeze([
    { id: "m-polo", label: "Polo and trousers", slots: { jbib: 9, uppr: 0, accs: 15, lowr: 8, feet: 9 } },
    { id: "m-work", label: "Work shirt and cargos", slots: { jbib: 13, uppr: 0, accs: 15, lowr: 9, feet: 12 } },
    { id: "m-suit", label: "Suit", slots: { jbib: 4, uppr: 4, accs: 4, lowr: 10, feet: 10 } },
    { id: "m-hoodie", label: "Hoodie and joggers", slots: { jbib: 7, uppr: 4, accs: 0, lowr: 5, feet: 7 } },
    { id: "m-plaid", label: "Plaid shirt and shorts", slots: { jbib: 14, uppr: 1, accs: 15, lowr: 15, feet: 6 } },
    { id: "m-leather", label: "Leather jacket", slots: { jbib: 6, uppr: 4, accs: 2, lowr: 1, feet: 12 } },
    { id: "m-tank", label: "Tank top and jeans", slots: { jbib: 5, uppr: 5, accs: 15, lowr: 1, feet: 4 } },
    { id: "m-base", label: "Base layer", slots: { jbib: 15, uppr: 15, accs: 15, lowr: 14, feet: 5 } },
  ]),
  female: Object.freeze([
    { id: "f-tee", label: "Tee and jeans", slots: { jbib: 2, uppr: 2, accs: 15, lowr: 0, feet: 1 } },
    { id: "f-hoodie", label: "Hoodie and joggers", slots: { jbib: 3, uppr: 3, accs: 15, lowr: 2, feet: 4 } },
    { id: "f-blazer", label: "Blazer and trousers", slots: { jbib: 6, uppr: 1, accs: 0, lowr: 6, feet: 14 } },
    { id: "f-denim", label: "Denim jacket and skirt", slots: { jbib: 1, uppr: 0, accs: 0, lowr: 8, feet: 9 } },
    { id: "f-leather", label: "Leather jacket and jeans", slots: { jbib: 8, uppr: 1, accs: 13, lowr: 4, feet: 7 } },
    { id: "f-polo", label: "Polo and shorts", slots: { jbib: 14, uppr: 0, accs: 15, lowr: 14, feet: 1 } },
    { id: "f-tank", label: "Tank top and cargos", slots: { jbib: 0, uppr: 15, accs: 15, lowr: 11, feet: 2 } },
    { id: "f-base", label: "Base layer", slots: { jbib: 15, uppr: 15, accs: 15, lowr: 15, feet: 13 } },
  ]),
});

/* ── Addon pieces ──
   Single clothing items added by file, whatever their name: a .ydd and an
   optional texture (a .ytd, or an image such as the PSD being painted). Each
   targets one component slot and is worn over the pack and base clothing.
   The game wears one drawable per slot, so a ped wears one piece per slot. */

export const MAX_ADDON_PIECES = 48;
const PIECE_ID = /^piece-[a-z0-9-]{1,40}$/;
export const PIECE_IMAGE_EXTENSIONS = Object.freeze(["png", "jpg", "jpeg", "webp", "bmp", "tga", "dds", "tif", "tiff", "psd", "pdn"]);
export const PIECE_TEXTURE_EXTENSIONS = Object.freeze(["ytd", ...PIECE_IMAGE_EXTENSIONS]);

// Words artists use in loose file names, mapped to the slot they usually
// mean. Only a suggestion: the piece's slot stays editable.
const PIECE_SLOT_WORDS = Object.freeze({
  mask: "berd",
  balaclava: "berd",
  hairstyle: "hair",
  haircut: "hair",
  ponytail: "hair",
  braid: "hair",
  braids: "hair",
  dreads: "hair",
  dreadlocks: "hair",
  afro: "hair",
  mohawk: "hair",
  curls: "hair",
  wig: "hair",
  shirt: "jbib",
  tshirt: "jbib",
  tee: "jbib",
  sweater: "jbib",
  jumper: "jbib",
  blazer: "jbib",
  polo: "jbib",
  cardigan: "jbib",
  dress: "jbib",
  cargos: "lowr",
  joggers: "lowr",
  sweatpants: "lowr",
  leggings: "lowr",
  trainers: "feet",
  sandals: "feet",
  heels: "feet",
  scarf: "teef",
  necklace: "teef",
  beanie: "p_head",
  jacket: "jbib",
  coat: "jbib",
  top: "jbib",
  hoodie: "jbib",
  pants: "lowr",
  trousers: "lowr",
  jeans: "lowr",
  shorts: "lowr",
  skirt: "lowr",
  shoes: "feet",
  boots: "feet",
  sneakers: "feet",
  vest: "task",
  armor: "task",
  armour: "task",
  kevlar: "task",
  belt: "teef",
  badge: "teef",
  tie: "teef",
  chain: "teef",
  undershirt: "accs",
  bag: "hand",
  backpack: "hand",
  parachute: "hand",
  decal: "decl",
  gloves: "uppr",
  arms: "uppr",
  hat: "p_head",
  helmet: "p_head",
  cap: "p_head",
  glasses: "p_eyes",
  sunglasses: "p_eyes",
  earpiece: "p_ears",
  watch: "p_lwrist",
  bracelet: "p_rwrist",
});

function extensionOf(path) {
  const match = baseName(path).toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : "";
}

export function isPieceTexturePath(path) {
  return PIECE_TEXTURE_EXTENSIONS.includes(extensionOf(path));
}

export function isYtdPath(path) {
  return extensionOf(path) === "ytd";
}

/**
 * The slot a piece file most likely fills: from a GTA stream name when it has
 * one (`jbib_003_u.ydd`, `mp_f_freemode_01_pack^task_000_u.ydd`), otherwise
 * from a slot code or a common word in the name. `detected` is false when
 * nothing matched and the slot is only a default.
 */
export function detectPieceComponent(fileName) {
  const parsed = parseEupFileName(fileName);
  if (parsed?.kind === "drawable" && parsed.known) return { component: parsed.component, detected: true };
  const stem = baseName(fileName).toLowerCase().replace(/\.[a-z0-9]+$/, "");
  const tokens = stem.split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === "p" && PROP_IDS.includes(`p_${tokens[i + 1]}`)) return { component: `p_${tokens[i + 1]}`, detected: true };
    if (COMPONENT_IDS.includes(tokens[i])) return { component: tokens[i], detected: true };
  }
  for (const token of tokens) {
    if (PIECE_SLOT_WORDS[token]) return { component: PIECE_SLOT_WORDS[token], detected: true };
  }
  return { component: "jbib", detected: false };
}

/** The ped a piece file is made for, from its stream name or folder, if either says. */
export function detectPieceGender(path) {
  const parsed = parseEupFileName(path);
  if (parsed?.gender) return parsed.gender;
  const ped = pedFromPathSegments(path);
  return ped ? GENDER_FOR_PED[ped] : null;
}

/** The stream-file drawable index in a piece's name, or null for a loose name. */
export function pieceDrawableIndex(path) {
  const parsed = parseEupFileName(path);
  return parsed?.kind === "drawable" ? parsed.index : null;
}

/**
 * Texture files that may belong to a piece, in preference order: the GTA
 * texture name for a stream-named drawable, then a same-name file next to it.
 * The caller checks which exist; nothing here reads the disk.
 */
export function pieceTextureCandidates(drawablePath) {
  if (typeof drawablePath !== "string" || !/\.ydd$/i.test(drawablePath)) return [];
  const file = baseName(drawablePath);
  const folder = drawablePath.slice(0, drawablePath.length - file.length);
  const stem = file.slice(0, -4);
  const names = [];
  const parsed = parseEupFileName(file);
  if (parsed?.kind === "drawable") {
    const caret = stem.indexOf("^");
    const prefix = caret >= 0 ? stem.slice(0, caret + 1) : "";
    const index = formatIndex(parsed.index);
    if (parsed.isProp) {
      names.push(`${prefix}${parsed.component}_diff_${index}_a.ytd`);
    } else {
      names.push(`${prefix}${parsed.component}_diff_${index}_a_uni.ytd`, `${prefix}${parsed.component}_diff_${index}_a_whi.ytd`);
    }
  }
  for (const ext of ["ytd", "psd", "png", "dds"]) names.push(`${stem}.${ext}`);
  return [...new Set(names)].map((name) => `${folder}${name}`);
}

function isPieceComponent(component) {
  return COMPONENT_IDS.includes(component) || PROP_IDS.includes(component);
}

// One worn piece per ped and slot: the first worn entry keeps it.
function enforceOneWornPerSlot(pieces) {
  const taken = new Set();
  return pieces.map((piece) => {
    if (!piece.worn) return piece;
    const key = `${piece.gender}|${piece.component}`;
    if (taken.has(key)) return { ...piece, worn: false };
    taken.add(key);
    return piece;
  });
}

/** Pieces restored from workspace storage; malformed entries are dropped. */
export function normalizeAddonPieces(value) {
  const list = Array.isArray(value) ? value : [];
  const result = [];
  const seen = new Set();
  for (const raw of list) {
    if (result.length >= MAX_ADDON_PIECES) break;
    if (!raw || typeof raw !== "object") continue;
    if (typeof raw.id !== "string" || !PIECE_ID.test(raw.id) || seen.has(raw.id)) continue;
    const drawablePath = typeof raw.drawablePath === "string" ? raw.drawablePath.trim() : "";
    if (!/\.ydd$/i.test(drawablePath)) continue;
    if (!isPieceComponent(raw.component)) continue;
    const texturePath = typeof raw.texturePath === "string" && isPieceTexturePath(raw.texturePath.trim())
      ? raw.texturePath.trim()
      : "";
    seen.add(raw.id);
    result.push({
      id: raw.id,
      gender: raw.gender === "female" ? "female" : "male",
      component: raw.component,
      drawablePath,
      texturePath,
      worn: raw.worn !== false,
    });
  }
  return enforceOneWornPerSlot(result);
}

/** Puts a piece on (taking its slot from any other worn piece) or takes it off. */
export function wearAddonPiece(pieces, id, worn = true) {
  const target = (pieces || []).find((piece) => piece.id === id);
  if (!target) return pieces || [];
  return pieces.map((piece) => {
    if (piece.id === id) return { ...piece, worn: Boolean(worn) };
    if (worn && piece.worn && piece.gender === target.gender && piece.component === target.component) {
      return { ...piece, worn: false };
    }
    return piece;
  });
}

/** Moves a piece to another slot; a worn piece takes that slot over. */
export function setAddonPieceComponent(pieces, id, component) {
  if (!isPieceComponent(component)) return pieces || [];
  const moved = (pieces || []).map((piece) => (piece.id === id ? { ...piece, component } : piece));
  const target = moved.find((piece) => piece.id === id);
  return target?.worn ? wearAddonPiece(moved, id, true) : moved;
}

/** Worn pieces for one ped, keyed by slot. */
export function wornAddonPieces(pieces, gender) {
  const result = {};
  for (const piece of pieces || []) {
    if (piece.worn && piece.gender === gender && !result[piece.component]) result[piece.component] = piece;
  }
  return result;
}
