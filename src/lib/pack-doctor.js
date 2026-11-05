import { classifyMetaPath, scanResourceForIds, simulateVehicle } from "./vehicle-meta.js";

export const PACK_DOCTOR_SCHEMA = "cortex.packDoctor";
export const PACK_DOCTOR_VERSION = 1;
export const MIB = 1024 * 1024;
export const MEMORY_BANDS_MIB = Object.freeze([64, 48, 32, 16]);
export const OVERSIZED_MIB = 48;
export const MAX_MANIFEST_CHARS = 1024 * 1024;
export const STREAMED_WALK_LIMIT = 20000;

export const META_DATA_FILES = Object.freeze({
  VEHICLE_METADATA_FILE: "vehicles",
  CARCOLS_FILE: "carcols",
  VEHICLE_VARIATION_FILE: "carvariations",
  HANDLING_FILE: "handling",
});

const DATA_FILE_FOR_KIND = Object.freeze(Object.fromEntries(Object.entries(META_DATA_FILES).map(([type, kind]) => [kind, type])));
const KIND_NAME = Object.freeze({ vehicles: "vehicles", carcols: "carcols", carvariations: "carvariations", handling: "handling" });
const SEVERITY_RANK = Object.freeze({ error: 0, warn: 1, info: 2 });
const SEVERITY_TITLE = Object.freeze({ error: "Errors", warn: "Warnings", info: "Notes" });
const UNCOMPRESSED_FORMAT = /^(rgba|bgra|\d+-bit)$/i;
const MODEL_KINDS = new Set(["yft", "ydr", "ydd"]);
const VARIATION_CODES = new Set(["NO_VARIATION_ENTRY", "MODKIT_NOT_LINKED", "COLOR_INDEX_INVALID", "SIREN_ID_UNDEFINED", "LIGHT_ID_UNDEFINED", "SIREN_SEQUENCER_INVALID", "SIREN_BONE_MISSING", "SIREN_SETTINGS_MISSING"]);
const ID_CONFLICT_CODES = new Set(["MODKIT_ID_CONFLICT", "SIREN_ID_CONFLICT", "LIGHT_ID_CONFLICT"]);
const ID_LABEL = Object.freeze({ kit: "Mod kit", siren: "Siren setting", light: "Light setting" });
const STRING_ESCAPES = Object.freeze({ n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', "\n": "\n" });

const lower = (value) => String(value ?? "").toLowerCase();
const slashes = (path) => String(path ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
const baseName = (path) => slashes(path).split("/").pop() || "";
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;
const isPowerOfTwo = (value) => isPositiveInteger(value) && (value & (value - 1)) === 0;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function fileExtension(path) {
  const match = /\.([^./]+)$/.exec(baseName(path));
  return match ? match[1].toLowerCase() : "";
}

export function relativePath(root, path) {
  const base = slashes(root);
  const own = slashes(path);
  if (base && lower(own).startsWith(`${lower(base)}/`)) return own.slice(base.length + 1);
  return own;
}

export function isInside(directory, path) {
  const folder = lower(slashes(directory));
  const own = lower(slashes(path));
  return Boolean(folder) && (own === folder || own.startsWith(`${folder}/`));
}

export function formatMiB(bytes) {
  if (!Number.isFinite(bytes)) return "?";
  const tenths = (bytes * 10) / MIB;
  const floor = Math.floor(tenths);
  const tie = tenths - floor === 0.5;
  const rounded = tie ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(tenths);
  return (rounded / 10).toFixed(1);
}

export function rsc7PageSize(flags) {
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xffffffff) return null;
  const pages = ((flags >>> 27) & 0x1)
    + (((flags >>> 26) & 0x1) << 1)
    + (((flags >>> 25) & 0x1) << 2)
    + (((flags >>> 24) & 0x1) << 3)
    + (((flags >>> 17) & 0x7f) << 4)
    + (((flags >>> 11) & 0x3f) << 5)
    + (((flags >>> 7) & 0xf) << 6)
    + (((flags >>> 5) & 0x3) << 7)
    + (((flags >>> 4) & 0x1) << 8);
  return 0x200 * 2 ** (flags & 0xf) * pages;
}

export function memoryBand(bytes) {
  if (!Number.isFinite(bytes)) return 0;
  return MEMORY_BANDS_MIB.find((band) => bytes > band * MIB) || 0;
}

export function describeStreamedFile(file) {
  if (!file || typeof file.path !== "string" || !file.path) return null;
  const kind = fileExtension(file.path);
  const base = { path: file.path, kind, bytes: Number.isFinite(file.bytes) ? file.bytes : null, physical: null, virtual: null };
  if (file.magic === "RSC7") {
    const physical = rsc7PageSize(file.physicalFlags);
    const virtual = rsc7PageSize(file.virtualFlags);
    if (physical == null || virtual == null) return { ...base, checked: false, reason: "Its resource header is damaged." };
    return { ...base, physical, virtual, checked: true, reason: "" };
  }
  if (file.magic === "RSC8") return { ...base, checked: false, reason: "It is a GTA V Enhanced (RSC8) file, which this check does not read." };
  return { ...base, checked: false, reason: "It is not an RSC7 resource file; it may be encrypted or damaged." };
}

function memoryFix(kind) {
  if (kind === "ytd") return "Lower the resolution of its largest textures (4096 to 2048 is a quarter of the memory) or split the dictionary.";
  if (MODEL_KINDS.has(kind)) return "This is the model's own geometry and any textures embedded in it. Cortex never changes models; reduce it in your modelling tool or ask the model's author.";
  return "Reduce it in the tool that made it, or split it into smaller files.";
}

export function memoryFindings(described) {
  const findings = [];
  for (const file of described || []) {
    if (!file?.checked) continue;
    for (const [size, label] of [[file.physical, "physical (graphics)"], [file.virtual, "virtual (system)"]]) {
      const band = memoryBand(size);
      if (!band) continue;
      const oversized = band >= OVERSIZED_MIB;
      const note = oversized
        ? "FiveM warns that oversized assets can and will cause streaming issues, such as models not loading."
        : "FiveM prints a console note for streamed assets above 16 MiB, and adds that they will cause streaming issues only above 48 MiB.";
      findings.push({
        severity: band >= 64 ? "error" : oversized ? "warn" : "info",
        code: oversized ? "ASSET_OVERSIZED" : "ASSET_LARGE",
        area: "memory",
        path: file.path,
        message: `${baseName(file.path)} uses ${formatMiB(size)} MiB of ${label} memory, past ${band} MiB. ${note}`,
        fix: memoryFix(file.kind),
      });
    }
  }
  return findings;
}

export function memorySummary(described, { truncated = false } = {}) {
  const files = (described || []).filter((file) => file?.checked)
    .map(({ path, kind, physical, virtual }) => ({ path, kind, physical, virtual }))
    .sort((a, b) => Math.max(b.physical, b.virtual) - Math.max(a.physical, a.virtual) || a.path.localeCompare(b.path));
  const total = truncated ? null : files.reduce((sum, file) => ({ physical: sum.physical + file.physical, virtual: sum.virtual + file.virtual }), { physical: 0, virtual: 0 });
  return { files, total, truncated: Boolean(truncated) };
}

function uncompressedBytes(texture) {
  const bits = /^(\d+)-bit$/i.exec(texture.format || "");
  const perPixel = bits ? Number(bits[1]) / 8 : 4;
  const mipFactor = texture.levels > 1 ? 4 / 3 : 1;
  return texture.width * texture.height * perPixel * mipFactor;
}

function dictionaryRoot(name) {
  return lower(name).replace(/\.ytd$/, "").replace(/[+_]hi$/, "");
}

function isHiDictionary(name) {
  return /[+_]hi$/.test(lower(name).replace(/\.ytd$/, ""));
}

function isHiPair(entries) {
  const names = entries.map((entry) => entry.dictionary.name || baseName(entry.dictionary.path));
  const roots = new Set(names.map(dictionaryRoot));
  return roots.size === 1 && names.some(isHiDictionary) && names.some((name) => !isHiDictionary(name));
}

const NORMAL_OR_GRADIENT = /(_n|_nrm|_norm|_normal|_bump|_emis|_emissive|_lights?|lightglass)$/i;
const NO_MIP_EXEMPT = /^script_rt_|(_emis|_emissive)$/i;

function listNames(names, limit = 6) {
  const shown = names.slice(0, limit).join(", ");
  return names.length > limit ? `${shown} and ${names.length - limit} more` : shown;
}

// Texture checks that repeat across a dictionary become one finding per
// dictionary, so a pack exported without mipmaps doesn't bury its other problems.
const TEXTURE_CHECKS = Object.freeze({
  TEXTURE_NOT_POWER_OF_TWO: {
    code: "TEXTURE_NOT_POWER_OF_TWO",
    severity: "info",
    one: (where, detail) => `${where} is ${detail}, not a power of two. The game draws it, but its smaller mipmaps round down and can look slightly soft.`,
    many: (count, dictName) => `${count} textures in ${dictName} aren't a power of two. The game draws them, but their smaller mipmaps round down and can look slightly soft`,
    fix: ["If you re-export it, use a power-of-two size, such as 1024×512.", "If you re-export them, use power-of-two sizes, such as 1024×512."],
  },
  TEXTURE_NO_MIPMAPS: {
    code: "TEXTURE_NO_MIPMAPS",
    severity: "warn",
    one: (where, detail) => `${where} (${detail}) has no mipmaps, so it's drawn at full resolution however far away it is and can shimmer or look grainy at a distance.`,
    many: (count, dictName) => `${count} textures in ${dictName} have no mipmaps, so they're drawn at full resolution however far away they are and can shimmer or look grainy at a distance`,
    fix: ["Export it with mipmaps.", "Export them with mipmaps."],
  },
  TEXTURE_NO_MIPMAPS_HI: {
    code: "TEXTURE_NO_MIPMAPS",
    severity: "info",
    one: (where, detail) => `${where} (${detail}) has no mipmaps. A high-detail dictionary is only used up close, so this rarely shows.`,
    many: (count, dictName) => `${count} textures in ${dictName} have no mipmaps. A high-detail dictionary is only used up close, so this rarely shows`,
    fix: ["Export it with mipmaps if it shimmers.", "Export them with mipmaps if they shimmer."],
  },
  TEXTURE_UNCOMPRESSED: {
    code: "TEXTURE_UNCOMPRESSED",
    severity: "warn",
    one: (where, detail) => `${where} is uncompressed ${detail}.`,
    many: (count, dictName) => `${count} textures in ${dictName} are uncompressed`,
    fix: ["Save it as DXT5 (BC3), or DXT1 (BC1) when it has no transparency: 1 or half a byte per pixel instead of 2 to 4.", "Save them as DXT5 (BC3), or DXT1 (BC1) where there is no transparency: 1 or half a byte per pixel instead of 2 to 4."],
  },
  TEXTURE_UNCOMPRESSED_SOFT: {
    code: "TEXTURE_UNCOMPRESSED",
    severity: "info",
    one: (where, detail) => `${where} is uncompressed ${detail}. Its name reads as a normal map or a light, where DXT compression causes visible artifacts.`,
    many: (count, dictName) => `${count} textures in ${dictName} are uncompressed. Their names read as normal maps or lights, where DXT compression causes visible artifacts`,
    fix: ["Keep it as it is, or use BC7 if it needs to be smaller.", "Keep them as they are, or use BC7 where they need to be smaller."],
  },
  TEXTURE_VERY_LARGE: {
    code: "TEXTURE_VERY_LARGE",
    severity: "warn",
    one: (where, detail) => `${where} is ${detail}.`,
    many: (count, dictName) => `${count} textures in ${dictName} are larger than 4096`,
    fix: ["Export it at 4096 or smaller; past that the extra detail rarely shows in game and costs a lot of memory.", "Export them at 4096 or smaller; past that the extra detail rarely shows in game and costs a lot of memory."],
  },
});

function textureFinding(key, entries, path, dictName) {
  const check = TEXTURE_CHECKS[key];
  const base = { area: "textures", path, severity: check.severity, code: check.code, fix: check.fix[entries.length === 1 ? 0 : 1] };
  if (entries.length === 1) {
    const [{ texture, detail }] = entries;
    return { ...base, subject: texture.name, message: check.one(`${texture.name} in ${dictName}`, detail) };
  }
  const subjects = entries.map((entry) => entry.texture.name);
  const listed = listNames(entries.map((entry) => `${entry.texture.name} (${entry.detail})`), 8);
  return { ...base, subject: subjects[0], subjects, message: `${check.many(entries.length, dictName)}: ${listed}.` };
}

export function textureFindings(dictionaries, options = {}) {
  const { modelName = "", liveryPrefix = "", kits = [], expectedMissing = [], parents = [] } = options;
  const findings = [];
  const notChecked = [];
  const list = Array.isArray(dictionaries) ? dictionaries.filter((entry) => entry && typeof entry.path === "string" && entry.path) : [];
  if (!list.length) {
    notChecked.push({ area: "textures", what: "Textures", reason: "No dictionaries of its own" });
    return { findings, notChecked, stats: { dictionaries: 0, textures: 0, liveries: 0 } };
  }
  const byName = new Map();
  let textureCount = 0;
  for (const dictionary of list) {
    const dictName = dictionary.name || baseName(dictionary.path);
    const textures = Array.isArray(dictionary.textures) ? dictionary.textures : [];
    const hiDictionary = isHiDictionary(dictName);
    let unreadable = 0;
    const flagged = new Map();
    const flag = (code, texture, detail) => {
      if (!flagged.has(code)) flagged.set(code, []);
      flagged.get(code).push({ texture, detail });
    };
    for (const texture of textures) {
      if (!texture || typeof texture.name !== "string" || !texture.name) continue;
      textureCount += 1;
      const key = lower(texture.name);
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push({ dictionary, texture });
      const { width, height } = texture;
      if (!isPositiveInteger(width) || !isPositiveInteger(height)) {
        unreadable += 1;
        continue;
      }
      const levels = isPositiveInteger(texture.levels) ? texture.levels : 1;
      const size = `${width}×${height}`;
      if (!isPowerOfTwo(width) || !isPowerOfTwo(height)) flag("TEXTURE_NOT_POWER_OF_TWO", texture, size);
      if (levels <= 1 && Math.max(width, height) >= 512 && !NO_MIP_EXEMPT.test(texture.name)) flag(hiDictionary ? "TEXTURE_NO_MIPMAPS_HI" : "TEXTURE_NO_MIPMAPS", texture, size);
      const bytes = uncompressedBytes({ ...texture, levels });
      if (UNCOMPRESSED_FORMAT.test(texture.format || "") && !/^8-bit$/i.test(texture.format) && (width * height >= 1024 * 1024 || bytes >= 4 * MIB)) {
        flag(NORMAL_OR_GRADIENT.test(texture.name) ? "TEXTURE_UNCOMPRESSED_SOFT" : "TEXTURE_UNCOMPRESSED", texture, `${texture.format} at ${size}, about ${formatMiB(bytes)} MiB`);
      }
      if (Math.max(width, height) > 4096) flag("TEXTURE_VERY_LARGE", texture, size);
    }
    for (const [code, entries] of flagged) findings.push(textureFinding(code, entries, dictionary.path, dictName));
    if (unreadable) {
      notChecked.push({ area: "textures", what: `${plural(unreadable, "texture")} in ${dictName}`, reason: "Their headers could not be read", path: dictionary.path });
    }
  }

  for (const [, entries] of byName) {
    const dictionariesWithIt = new Set(entries.map((entry) => lower(entry.dictionary.path)));
    if (dictionariesWithIt.size < 2 || isHiPair(entries)) continue;
    const names = [...new Set(entries.map((entry) => entry.dictionary.name || baseName(entry.dictionary.path)))];
    findings.push({ area: "textures", path: entries[0].dictionary.path, subject: entries[0].texture.name, severity: "warn", code: "TEXTURE_NAME_TWICE", message: `${entries[0].texture.name} is in ${names.join(" and ")}, so the game shows only one of them.`, fix: "Keep each texture in one of the vehicle's dictionaries." });
  }

  const prefix = lower(liveryPrefix || modelName);
  let liveryCount = 0;
  if (prefix) {
    const pattern = new RegExp(`^${escapeRegExp(prefix)}_sign_(\\d+)$`);
    const numbers = new Set();
    for (const key of byName.keys()) {
      const match = pattern.exec(key);
      if (match) numbers.add(Number(match[1]));
    }
    liveryCount = numbers.size;
    const reported = new Set((expectedMissing || []).map(lower));
    const highest = numbers.size ? Math.max(...numbers) : 0;
    const gaps = [];
    for (let number = 1; number < highest; number += 1) {
      const name = `${prefix}_sign_${number}`;
      if (!numbers.has(number) && !reported.has(name)) gaps.push(name);
    }
    if (gaps.length && highest <= 64) {
      const owner = (byName.get(`${prefix}_sign_${highest}`) || [])[0];
      findings.push({ area: "textures", path: owner?.dictionary.path || list[0].path, severity: "warn", code: "LIVERY_SIGN_GAP", message: `${listNames(gaps)} ${gaps.length === 1 ? "is" : "are"} missing below ${prefix}_sign_${highest}, so ${gaps.length === 1 ? "that livery shows" : "those liveries show"} no livery texture.`, fix: "Add the missing _sign_ textures, or renumber the ones after the gap." });
    }
    for (const kit of Array.isArray(kits) ? kits : []) {
      const names = Array.isArray(kit?.liveryNames) ? kit.liveryNames : [];
      if (!names.length || !liveryCount || names.length === liveryCount) continue;
      const short = names.length > liveryCount;
      findings.push({ area: "textures", path: kit.sourcePath || list[0].path, subject: kit.kitName, severity: short ? "warn" : "info", code: "LIVERY_NAMES_COUNT", message: `Mod kit ${kit.kitName || "?"} names ${plural(names.length, "livery", "liveries")}, but the dictionaries hold ${plural(liveryCount, `${prefix}_sign_ texture`)}${short ? ", so the extra liveries show no livery texture" : ", so the extra textures can't be picked in game"}.`, fix: "List one <liveryNames> entry per _sign_ texture in carcols.meta." });
    }
  }

  for (const parent of Array.isArray(parents) ? parents : []) {
    if (!parent) continue;
    if (!Array.isArray(parent.textures)) {
      notChecked.push({ area: "textures", what: `Overrides of the parent dictionary ${parent.name || baseName(parent.path)}`, reason: parent.error || "It could not be read", path: parent.path });
      continue;
    }
    const overridden = parent.textures.filter((name) => typeof name === "string" && byName.has(lower(name)));
    if (!overridden.length) continue;
    findings.push({ area: "textures", path: parent.path || list[0].path, subject: parent.name, severity: "info", code: "TEXTURE_OVERRIDES_PARENT", message: `${listNames(overridden)} ${overridden.length === 1 ? "replaces" : "replace"} the same ${overridden.length === 1 ? "texture" : "textures"} in the parent dictionary ${parent.name}.` });
  }

  return { findings, notChecked, stats: { dictionaries: list.length, textures: textureCount, liveries: liveryCount } };
}

function metaWarningPath(sim, code, fallback) {
  const vehiclePath = sim?.vehicle?.sourcePath || "";
  const variationPath = sim?.variation?.sourcePath || "";
  if (VARIATION_CODES.has(code)) return variationPath || vehiclePath || fallback;
  return vehiclePath || variationPath || fallback;
}

export function metaFindings(sim, { fallbackPath = "", skipCodes = null } = {}) {
  if (!sim || !Array.isArray(sim.warnings)) return [];
  return sim.warnings
    .filter((warning) => warning && SEVERITY_RANK[warning.severity] != null && !(skipCodes && skipCodes.has(warning.code)))
    .map((warning) => ({
      area: "meta",
      severity: warning.severity,
      code: warning.code,
      message: warning.message,
      fix: warning.fix || "",
      subject: sim.modelName || "",
      path: metaWarningPath(sim, warning.code, fallbackPath),
    }));
}

function tokenizeLua(text) {
  const tokens = [];
  const length = text.length;
  let at = 0;
  const longOpen = (from) => {
    const match = /^\[(=*)\[/.exec(text.slice(from, from + 66));
    return match ? match[1].length : -1;
  };
  const readLong = (from, level, what) => {
    const close = `]${"=".repeat(level)}]`;
    const start = from + level + 2;
    const end = text.indexOf(close, start);
    if (end < 0) throw new Error(`an unterminated ${what}`);
    return { value: text.slice(start, end), next: end + close.length };
  };
  while (at < length) {
    const char = text[at];
    if (char === " " || char === "\t" || char === "\r" || char === "\n" || char === "\f" || char === "\v") {
      at += 1;
      continue;
    }
    if (char === "-" && text[at + 1] === "-") {
      const level = longOpen(at + 2);
      if (level >= 0) at = readLong(at + 2, level, "comment").next;
      else {
        const end = text.indexOf("\n", at);
        at = end < 0 ? length : end + 1;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      let value = "";
      let cursor = at + 1;
      while (cursor < length && text[cursor] !== char) {
        if (text[cursor] === "\n") throw new Error("an unterminated string");
        if (text[cursor] === "\\") {
          const next = text[cursor + 1];
          if (next == null) throw new Error("an unterminated string");
          value += STRING_ESCAPES[next] ?? next;
          cursor += 2;
          continue;
        }
        value += text[cursor];
        cursor += 1;
      }
      if (cursor >= length) throw new Error("an unterminated string");
      tokens.push({ type: "string", value });
      at = cursor + 1;
      continue;
    }
    if (char === "[") {
      const level = longOpen(at);
      if (level >= 0) {
        const { value, next } = readLong(at, level, "string");
        tokens.push({ type: "string", value: value.replace(/^\r?\n/, "") });
        at = next;
        continue;
      }
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(at, at + 128));
    if (word) {
      tokens.push({ type: "name", value: word[0] });
      at += word[0].length;
      continue;
    }
    const number = /^[0-9][0-9A-Fa-fxX._]*/.exec(text.slice(at, at + 64));
    if (number) {
      tokens.push({ type: "number", value: number[0] });
      at += number[0].length;
      continue;
    }
    tokens.push({ type: "punct", value: char });
    at += 1;
  }
  return tokens;
}

const isPunct = (token, value) => token?.type === "punct" && token.value === value;

function readLiteralList(tokens, start) {
  const open = tokens[start].value;
  const close = open === "(" ? ")" : "}";
  const values = [];
  let at = start + 1;
  let expectValue = true;
  for (;;) {
    const token = tokens[at];
    if (!token) return null;
    if (isPunct(token, close)) return { values, next: at + 1 };
    if (expectValue && token.type === "string") {
      values.push(token.value);
      expectValue = false;
      at += 1;
    } else if (expectValue && open === "(" && isPunct(token, "{")) {
      const inner = readLiteralList(tokens, at);
      if (!inner) return null;
      values.push(...inner.values);
      expectValue = false;
      at = inner.next;
    } else if (!expectValue && (isPunct(token, ",") || (open === "{" && isPunct(token, ";")))) {
      expectValue = true;
      at += 1;
    } else return null;
  }
}

function readArguments(tokens, start) {
  const groups = [];
  let at = start;
  while (at < tokens.length) {
    const token = tokens[at];
    if (token.type === "string") {
      groups.push([token.value]);
      at += 1;
    } else if (isPunct(token, "(") || isPunct(token, "{")) {
      const list = readLiteralList(tokens, at);
      if (!list) return null;
      groups.push(list.values);
      at = list.next;
    } else break;
  }
  return { groups, next: at };
}

const MANIFEST_DIRECTIVES = new Set(["file", "files", "data_file"]);

export function parseManifest(text) {
  if (typeof text !== "string") return { ok: false, reason: "It could not be read as text." };
  if (text.length > MAX_MANIFEST_CHARS) return { ok: false, reason: "It is larger than 1 MiB." };
  let tokens;
  try {
    tokens = tokenizeLua(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    return { ok: false, reason: `Its Lua has ${error.message}.` };
  }
  const files = [];
  const dataFiles = [];
  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at];
    if (token.type !== "name" || !MANIFEST_DIRECTIVES.has(token.value)) continue;
    const before = tokens[at - 1];
    if (isPunct(before, ".") || isPunct(before, ":")) continue;
    if (isPunct(tokens[at + 1], "=")) continue;
    const next = tokens[at + 1];
    const readAsValue = (before && (["=", "(", ",", "{", "[", ".."].some((mark) => isPunct(before, mark)) || (before.type === "name" && ["return", "local", "and", "or", "not", "for", "in", "if", "elseif", "while", "until"].includes(before.value))))
      || !next || (next.type === "punct" && !isPunct(next, "(") && !isPunct(next, "{"));
    if (readAsValue) continue;
    const call = readArguments(tokens, at + 1);
    if (!call || !call.groups.length) {
      return { ok: false, reason: `A ${token.value} line uses values Cortex can't read without running the manifest.` };
    }
    if (token.value === "data_file") {
      const [type, path, ...rest] = call.groups;
      if (!path || rest.length || type.length !== 1 || path.length !== 1) {
        return { ok: false, reason: "A data_file line is not written as data_file 'TYPE' 'path'." };
      }
      dataFiles.push({ type: type[0], path: path[0] });
    } else {
      files.push(...call.groups.flat());
    }
    at = call.next - 1;
  }
  return { ok: true, files, dataFiles };
}

export function normalizeManifestPath(path) {
  return String(path ?? "").replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
}

export function globToRegExp(pattern, { caseSensitive = false } = {}) {
  const clean = normalizeManifestPath(pattern);
  let source = "";
  for (let at = 0; at < clean.length; at += 1) {
    const char = clean[at];
    if (char === "*" && clean[at + 1] === "*") {
      if (clean[at + 2] === "/") {
        source += "(?:.*/)?";
        at += 2;
      } else {
        source += ".*";
        at += 1;
      }
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`, caseSensitive ? "" : "i");
}

function metaKind(path, sources) {
  const source = (sources || []).find((entry) => lower(slashes(entry?.path)) === lower(slashes(path)));
  if (source && KIND_NAME[source.kind]) return source.kind;
  if (source) return "";
  return classifyMetaPath(path) || "";
}

export function checkManifest({ root, manifestPath, text, metaPaths = [], sources = [], listingComplete = true } = {}) {
  const findings = [];
  const notChecked = [];
  const manifestName = baseName(manifestPath) || "fxmanifest.lua";
  const parsed = parseManifest(text);
  if (!parsed.ok) {
    notChecked.push({ area: "manifest", what: `Meta entries in ${manifestName}`, reason: parsed.reason, path: manifestPath });
    return { findings, notChecked };
  }
  const metas = (Array.isArray(metaPaths) ? metaPaths : [])
    .filter((path) => typeof path === "string" && path)
    .map((path) => ({ path, rel: relativePath(root, path), kind: metaKind(path, sources) }));
  const patterns = parsed.files.map((pattern) => ({ loose: globToRegExp(pattern), strict: globToRegExp(pattern, { caseSensitive: true }) }));
  const listedAs = (rel) => (patterns.some((entry) => entry.strict.test(rel)) ? "yes" : patterns.some((entry) => entry.loose.test(rel)) ? "case" : "no");
  const loaded = new Set();
  const at = (path, extra) => ({ area: "manifest", path, ...extra });
  for (const entry of parsed.dataFiles) {
    const type = String(entry.type);
    const expected = META_DATA_FILES[type.toUpperCase()] || "";
    const target = normalizeManifestPath(entry.path);
    if (!expected && !/\.meta$/i.test(target)) continue;
    const loose = globToRegExp(target);
    const strict = globToRegExp(target, { caseSensitive: true });
    const matches = metas.filter((meta) => loose.test(meta.rel));
    if (!matches.length) {
      if (/(^|\/)stream\//i.test(target)) {
        notChecked.push({ area: "manifest", what: `data_file ${type} ${target}`, reason: "Meta inside stream folders is not listed", path: manifestPath });
      } else if (!listingComplete) {
        notChecked.push({ area: "manifest", what: `data_file ${type} ${target}`, reason: "Not checked (folder too large)", path: manifestPath });
      } else {
        findings.push(at(manifestPath, /[*?]/.test(target)
          ? { severity: "info", code: "DATA_FILE_NO_MATCH", message: `${manifestName} loads ${target} as ${type}, but no file in the resource matches it, so the line loads nothing.`, fix: "Fine if the pack has no such meta; remove the line to keep the manifest tidy." }
          : { severity: "error", code: "DATA_FILE_MISSING", message: `${manifestName} loads ${target} as ${type}, but the resource has no such file.`, fix: "Correct the path in the data_file line, or add the file." }));
      }
      continue;
    }
    for (const meta of matches) {
      if (loaded.has(lower(meta.path))) continue;
      loaded.add(lower(meta.path));
      if (!strict.test(meta.rel)) {
        findings.push(at(meta.path, { severity: "warn", code: "DATA_FILE_CASE", message: `${manifestName} names ${target}, but the file is ${meta.rel}. Windows finds it; a Linux server does not.`, fix: "Match the letter case in the data_file line." }));
      }
      const listed = listedAs(meta.rel);
      if (listed === "no") {
        findings.push(at(meta.path, { severity: "error", code: "META_NOT_IN_FILES", message: `${meta.rel} is loaded with data_file but is not in files, so players never download it.`, fix: `Add '${meta.rel}' to files { } in ${manifestName}.` }));
      } else if (listed === "case") {
        findings.push(at(meta.path, { severity: "warn", code: "FILES_CASE", message: `${meta.rel} is in files only with different letter case. Windows finds it; a Linux server does not.`, fix: "Match the letter case in files { }." }));
      }
      if (expected && meta.kind && meta.kind !== expected) {
        findings.push(at(meta.path, { severity: "error", code: "DATA_FILE_WRONG_TYPE", message: `${meta.rel} holds ${meta.kind} data but ${manifestName} loads it as ${type}.`, fix: `Load it as ${DATA_FILE_FOR_KIND[meta.kind]}.` }));
      }
    }
  }
  for (const meta of metas) {
    if (loaded.has(lower(meta.path)) || !DATA_FILE_FOR_KIND[meta.kind]) continue;
    findings.push(at(meta.path, { severity: "warn", code: "META_NOT_LOADED", message: `${meta.rel} is not loaded by any data_file line, so the game never reads it.`, fix: `Add data_file '${DATA_FILE_FOR_KIND[meta.kind]}' '${meta.rel}' to ${manifestName} and list the file in files { }.` }));
  }
  return { findings, notChecked };
}

export function aggregateResources(resources) {
  const findings = [];
  const list = (Array.isArray(resources) ? resources : []).filter((entry) => entry && typeof entry.path === "string");
  const nameOf = (resource) => resource.name || baseName(resource.path);

  const spawns = new Map();
  for (const resource of list) {
    for (const vehicle of resource.meta?.vehicles || []) {
      const key = lower(vehicle?.modelName);
      if (!key) continue;
      if (!spawns.has(key)) spawns.set(key, new Map());
      const owners = spawns.get(key);
      if (!owners.has(resource.path)) owners.set(resource.path, { resource, name: vehicle.modelName, sourcePath: vehicle.sourcePath || "" });
    }
  }
  for (const owners of spawns.values()) {
    if (owners.size < 2) continue;
    const entries = [...owners.values()];
    findings.push({ area: "names", severity: "error", code: "SPAWN_NAME_CLASH", resource: "", path: entries[0].sourcePath || entries[0].resource.path, subject: entries[0].name, message: `${entries[0].name} is a vehicle in ${entries.length} resources (${entries.map((entry) => nameOf(entry.resource)).join(", ")}). The server keeps whichever starts last.`, fix: "Keep one copy, or give one of them a new spawn name." });
  }

  const ids = new Map();
  for (const resource of list) {
    const scan = scanResourceForIds(resource.meta);
    for (const kind of ["kit", "siren", "light"]) {
      for (const entry of scan[`${kind}s`] || []) {
        if (!Number.isInteger(entry.id)) continue;
        const key = `${kind}:${entry.id}`;
        if (!ids.has(key)) ids.set(key, { kind, id: entry.id, entries: [] });
        ids.get(key).entries.push({ ...entry, resource });
      }
    }
    for (const entry of scan.outOfRange || []) {
      findings.push({ area: "ids", severity: "info", code: "SIREN_ID_OUT_OF_RANGE", resource: resource.path, path: entry.sourcePath || resource.path, subject: entry.name, message: `Siren setting id ${entry.id}${entry.name ? ` (${entry.name})` : ""} in ${nameOf(resource)} is outside 0-255, the base game's range. It works only where the server raises that limit.` });
    }
  }
  for (const { kind, id, entries } of ids.values()) {
    if (entries.length < 2) continue;
    const owners = new Set(entries.map((entry) => entry.resource.path));
    const label = ID_LABEL[kind];
    const where = entries.map((entry) => `${nameOf(entry.resource)}: ${entry.name || baseName(entry.sourcePath) || "?"}`).join(", ");
    findings.push(owners.size > 1
      ? { area: "ids", severity: "error", code: "ID_CLASH", resource: "", path: entries[0].sourcePath || entries[0].resource.path, subject: `${kind} ${id}`, message: `${label} id ${id} is used in ${owners.size} resources (${where}). Only one of them works on a server.`, fix: "Give each a unique id. Check in Forge compares ids with what your server already runs." }
      : { area: "ids", severity: "error", code: "ID_DEFINED_TWICE", resource: entries[0].resource.path, path: entries[0].sourcePath || entries[0].resource.path, subject: `${kind} ${id}`, message: `${label} id ${id} is defined ${entries.length} times in ${nameOf(entries[0].resource)} (${entries.map((entry) => baseName(entry.sourcePath) || "?").join(", ")}). Only one definition wins.`, fix: "Keep one definition per id." });
  }

  const streamed = new Map();
  for (const resource of list) {
    for (const path of resource.streamFiles || []) {
      if (typeof path !== "string" || !path) continue;
      const key = lower(baseName(path));
      if (!streamed.has(key)) streamed.set(key, new Map());
      streamed.get(key).set(lower(slashes(path)), { path, resource });
    }
  }
  for (const copies of streamed.values()) {
    if (copies.size < 2) continue;
    const entries = [...copies.values()];
    const owners = new Set(entries.map((entry) => entry.resource.path));
    findings.push({ area: "names", severity: "warn", code: "STREAM_NAME_CLASH", resource: owners.size > 1 ? "" : entries[0].resource.path, path: entries[0].path, subject: baseName(entries[0].path), message: `${baseName(entries[0].path)} is streamed ${entries.length} times${owners.size > 1 ? ` by ${owners.size} resources (${[...new Set(entries.map((entry) => nameOf(entry.resource)))].join(", ")})` : ` in ${nameOf(entries[0].resource)}`}. The game loads only one of them.`, fix: "Keep one copy, or rename one along with everything that refers to it." });
  }
  return findings;
}

function sortFindings(findings) {
  return findings.slice().sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3)
    || String(a.path || "").localeCompare(String(b.path || "")) || String(a.code).localeCompare(String(b.code)));
}

function dedupe(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    const key = `${finding.code}\n${lower(finding.path)}\n${lower(finding.vehiclePath || finding.subject || "")}\n${finding.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const CHECK_TITLES = Object.freeze({
  ASSET_OVERSIZED: "Over FiveM's oversized-asset limit",
  ASSET_LARGE: "Large streamed files",
  TEXTURE_NO_MIPMAPS: "Textures without mipmaps",
  TEXTURE_NOT_POWER_OF_TWO: "Texture sizes that aren't powers of two",
  TEXTURE_UNCOMPRESSED: "Uncompressed textures",
  TEXTURE_VERY_LARGE: "Very large textures",
  TEXTURE_NAME_TWICE: "Textures in two dictionaries",
  TEXTURE_OVERRIDES_PARENT: "Textures that replace the parent dictionary's",
  LIVERY_NAMES_COUNT: "Livery names that don't match the textures",
  LIVERY_SIGN_GAP: "Gaps in the livery numbers",
  NO_HI_MODEL: "Vehicles without a _hi model",
  MODEL_MISSING: "Vehicles with no model file",
  SPAWN_NAME_CLASH: "Spawn names in more than one resource",
  STREAM_NAME_CLASH: "Files streamed twice",
  ID_CLASH: "Ids shared between resources",
  ID_DEFINED_TWICE: "Ids defined twice",
  SIREN_ID_OUT_OF_RANGE: "Siren ids outside 0-255",
  DATA_FILE_MISSING: "data_file lines with no file",
  DATA_FILE_NO_MATCH: "data_file patterns that match nothing",
  DATA_FILE_WRONG_TYPE: "data_file lines with the wrong type",
  DATA_FILE_CASE: "data_file paths in the wrong letter case",
  FILES_CASE: "files entries in the wrong letter case",
  META_NOT_IN_FILES: "Meta files players never download",
  META_NOT_LOADED: "Meta files the game never reads",
  BASE_MODEL_MISSING: "Vehicles with only a _hi model",
  NO_VEHICLES_ENTRY: "Vehicles with no vehicles.meta entry",
  NO_VARIATION_ENTRY: "Vehicles with no carvariations entry",
  DUPLICATE_MODEL: "Models defined more than once",
  LIVERY_FLAG_MISSING: "Liveries without FLAG_HAS_LIVERY",
  LIVERY_TEXTURES_MISSING: "Livery textures missing from the dictionary",
  MODKIT_NOT_LINKED: "Mod kits no vehicle uses",
  MODKIT_ID_CONFLICT: "Mod kit ids used twice",
  COLOR_INDEX_INVALID: "Colour indexes outside the game's range",
  SIREN_ID_UNDEFINED: "Siren settings this resource doesn't define",
  LIGHT_ID_UNDEFINED: "Light settings this resource doesn't define",
  SIREN_ID_CONFLICT: "Siren ids used twice",
  LIGHT_ID_CONFLICT: "Light ids used twice",
  SIREN_SEQUENCER_INVALID: "Siren sequencers out of range",
  SIREN_BONE_MISSING: "Siren settings with no siren bone",
  SIREN_SETTINGS_MISSING: "Siren bones with no settings",
  TXD_PARENT_UNRESOLVED: "Parent dictionaries that aren't defined",
});

export function checkTitle(code) {
  if (CHECK_TITLES[code]) return CHECK_TITLES[code];
  const words = lower(code).replace(/_+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Other";
}

const sentencesOf = (text) => String(text || "").split(/(?<=[.!?])\s+(?=[A-Z0-9])/).map((part) => part.trim()).filter(Boolean);

export function groupDoctorFindings(findings = []) {
  const groups = new Map();
  for (const finding of findings) {
    const key = `${finding.severity}:${finding.code}`;
    if (!groups.has(key)) groups.set(key, { key, severity: finding.severity, code: finding.code, title: checkTitle(finding.code), findings: [] });
    groups.get(key).findings.push(finding);
  }
  return [...groups.values()].map((group) => {
    const split = group.findings.map((finding) => sentencesOf(finding.message));
    const shared = group.findings.length > 1
      ? split[0].slice(1).filter((sentence) => split.every((list) => list.indexOf(sentence) > 0))
      : [];
    const tally = new Map();
    for (const finding of group.findings) {
      if (finding.fix) tally.set(finding.fix, (tally.get(finding.fix) || 0) + 1);
    }
    const [common, uses] = [...tally].sort((a, b) => b[1] - a[1])[0] || ["", 0];
    const fix = tally.size === 1 || uses > 1 ? common : "";
    const items = group.findings.map((finding, index) => ({
      finding,
      text: split[index].filter((sentence, at) => at === 0 || !shared.includes(sentence)).join(" ") || finding.message,
      fix: finding.fix && finding.fix !== fix ? finding.fix : "",
    }));
    return { key: group.key, severity: group.severity, code: group.code, title: group.title, explanation: shared.join(" "), fix, items };
  }).sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) || b.items.length - a.items.length || a.title.localeCompare(b.title));
}

export const FOLDER_SCOPE_NOTE = "Texture detail is checked per vehicle: open one and see Health in its Meta tab.";

function countsOf(findings, notChecked) {
  const counts = { error: 0, warn: 0, info: 0, notChecked: notChecked.length };
  for (const finding of findings) counts[finding.severity] = (counts[finding.severity] || 0) + 1;
  return counts;
}

function modelFacts({ modelPath, described, meshStats, textureStats }) {
  const facts = [];
  const notChecked = [];
  const stem = baseName(modelPath).replace(/\.(yft|clmesh)$/i, "");
  const base = stem.replace(/_hi$/i, "");
  const names = new Set((described || []).map((file) => lower(baseName(file.path))));
  if (meshStats && Number.isFinite(meshStats.triangles)) {
    facts.push({ label: "Triangles drawn", value: meshStats.triangles.toLocaleString("en-US") });
    facts.push({ label: "Textures used", value: meshStats.textures == null ? "Unknown" : String(meshStats.textures) });
  } else {
    notChecked.push({ area: "model", what: "Triangle and texture counts", reason: "Solid wireframe was off, so the viewer did not count them" });
  }
  if (described) {
    const hasHi = names.has(lower(`${base}_hi.yft`));
    facts.push({ label: "High-detail model", value: hasHi ? `${base}_hi.yft` : `None; the game draws ${base}.yft up close` });
    const hasHiTxd = names.has(lower(`${base}+hi.ytd`));
    facts.push({ label: "High-detail textures", value: hasHiTxd ? `${base}+hi.ytd` : "None" });
  }
  if (textureStats?.dictionaries) {
    facts.push({ label: "Own dictionaries", value: `${textureStats.dictionaries}, ${plural(textureStats.textures, "texture")}` });
  }
  return { facts, notChecked };
}

function streamedNotChecked(described, root) {
  return (described || []).filter((file) => file && !file.checked)
    .map((file) => ({ area: "memory", what: relativePath(root, file.path), reason: file.reason, path: file.path }));
}

function unreadableNotChecked(assets, root) {
  return (assets?.unreadable || []).filter((entry) => entry && typeof entry.path === "string")
    .map((entry) => ({ area: "memory", what: relativePath(root, entry.path) || entry.path, reason: String(entry.message || "It could not be read"), path: entry.path }));
}

function describeAll(assets) {
  return (Array.isArray(assets?.files) ? assets.files : []).map(describeStreamedFile).filter(Boolean);
}

export function buildVehicleReport({
  modelPath = "",
  root = "",
  sim = null,
  metaStatus = "ready",
  liveryPrefix = "",
  kits = [],
  dictionaries = null,
  dictionariesError = "",
  parents = [],
  assets = null,
  assetsError = "",
  meshStats = null,
  createdAt = "",
  generator = "Cortex Studio",
} = {}) {
  const modelName = sim?.modelName || baseName(modelPath).replace(/\.(yft|clmesh)$/i, "").replace(/_hi$/i, "");
  const reportRoot = root || slashes(modelPath).replace(/\/[^/]*$/, "");
  const findings = [];
  const notChecked = [];

  if (sim) findings.push(...metaFindings(sim, { fallbackPath: modelPath }));
  else notChecked.push({ area: "meta", what: "Meta checks", reason: metaStatus === "error" ? "The meta files could not be read" : "No vehicle meta found in the resource" });

  let textureStats = null;
  if (dictionariesError) notChecked.push({ area: "textures", what: "Textures", reason: dictionariesError });
  else if (Array.isArray(dictionaries)) {
    const textures = textureFindings(dictionaries, {
      modelName,
      liveryPrefix,
      kits,
      expectedMissing: (sim?.textureLiveries?.textures || []).filter((entry) => entry.found === false).map((entry) => entry.name),
      parents,
    });
    findings.push(...textures.findings);
    notChecked.push(...textures.notChecked);
    textureStats = textures.stats;
  }

  const all = assets ? describeAll(assets) : null;
  const ownFiles = new Set([modelPath, ...(Array.isArray(dictionaries) ? dictionaries.map((entry) => entry?.path) : [])].map((path) => lower(slashes(path))));
  const inStream = (path) => /(^|\/)stream\//i.test(relativePath(reportRoot, path));
  const described = all && all.some((file) => inStream(file.path))
    ? all.filter((file) => inStream(file.path) || ownFiles.has(lower(slashes(file.path))))
    : all;
  if (assetsError) notChecked.push({ area: "memory", what: "Streamed memory", reason: assetsError });
  if (described) {
    findings.push(...memoryFindings(described));
    notChecked.push(...streamedNotChecked(described, reportRoot), ...unreadableNotChecked(assets, reportRoot));
  }
  const stem = baseName(modelPath).replace(/\.yft$/i, "");
  const baseFile = lower(`${stem.replace(/_hi$/i, "")}.yft`);
  const baseSeen = (assets?.unreadable || []).some((entry) => lower(baseName(entry?.path)) === baseFile) || (described || []).some((file) => lower(baseName(file.path)) === baseFile);
  if (described && /_hi$/i.test(stem) && !baseSeen && !(assets?.escrowed || []).length) {
    const name = stem.replace(/_hi$/i, "");
    findings.push({ area: "model", severity: sim?.vehicle ? "warn" : "info", code: "BASE_MODEL_MISSING", path: modelPath, subject: name, message: `${name} ships only ${baseName(modelPath)}, with no ${name}.yft beside it. The base model must come from the game or another resource, or the vehicle won't spawn.`, fix: "Add the base .yft to the resource's stream folder, unless this only replaces the high-detail model of a vehicle the game or another resource provides." });
  }
  const model = modelFacts({ modelPath, described, meshStats, textureStats });
  notChecked.push(...model.notChecked);
  const escrowed = (assets?.escrowed || []).filter((path) => typeof path === "string").map((path) => ({ name: baseName(path), path }));
  if (escrowed.length) notChecked.push({ area: "escrow", what: modelName, reason: "Escrowed, not checked" });

  const sorted = sortFindings(dedupe(findings));
  return {
    schema: PACK_DOCTOR_SCHEMA,
    version: PACK_DOCTOR_VERSION,
    scope: "vehicle",
    title: modelName || "Vehicle",
    root: reportRoot,
    subject: modelPath,
    createdAt,
    generator,
    complete: notChecked.length === 0,
    counts: countsOf(sorted, notChecked),
    findings: sorted,
    notChecked,
    escrowed,
    memory: described ? memorySummary(described) : null,
    facts: model.facts,
    resources: [],
  };
}

function ownerOf(resources, path) {
  let best = null;
  for (const resource of resources) {
    if (isInside(resource.path, path) && (!best || resource.path.length > best.path.length)) best = resource;
  }
  return best;
}

export function doctorManifestPaths(scan, assets) {
  const escrowedDirs = [...(scan?.escrowedDirs || []), ...(assets?.escrowed || [])].filter((path) => typeof path === "string" && path);
  return (Array.isArray(scan?.resources) ? scan.resources : [])
    .filter((resource) => resource?.manifest && !escrowedDirs.some((dir) => isInside(dir, resource.path) || isInside(resource.path, dir)))
    .map((resource) => resource.manifest);
}

export function buildFolderReport({
  folder = "",
  scan = null,
  assets = null,
  assetsError = "",
  manifests = {},
  cancelled = false,
  createdAt = "",
  generator = "Cortex Studio",
} = {}) {
  const root = slashes(folder || scan?.folder || "");
  const findings = [];
  const notChecked = [];
  const escrowedDirs = [...new Set([...(scan?.escrowedDirs || []), ...(assets?.escrowed || [])].filter((path) => typeof path === "string" && path).map(slashes))];
  const resources = (Array.isArray(scan?.resources) ? scan.resources : [])
    .filter((resource) => resource && typeof resource.path === "string")
    .map((resource) => ({
      ...resource,
      path: slashes(resource.path),
      name: resource.name || baseName(resource.path),
      escrowed: escrowedDirs.some((dir) => isInside(dir, resource.path) || isInside(resource.path, dir)),
    }));
  const checked = resources.filter((resource) => !resource.escrowed);
  const vehicles = Array.isArray(scan?.vehicles) ? scan.vehicles : [];

  const isStreamed = (path) => {
    const owner = ownerOf(resources, path);
    if (!owner) return !resources.length;
    if (!owner.manifest && resources.length === 1) return true;
    return /(^|\/)stream\//i.test(relativePath(owner.path, path));
  };
  const listingComplete = !scan?.truncated;
  const scanErrors = (scan?.errors || []).filter((entry) => entry && typeof entry.path === "string");
  const modelNames = new Set(resources.flatMap((resource) => (resource.models || []).filter(isStreamed).map((path) => lower(baseName(path)))));
  for (const vehicle of vehicles) {
    const resource = ownerOf(resources, vehicle.path) || resources.find((entry) => lower(entry.path) === lower(slashes(vehicle.resourcePath)));
    if (!resource || resource.escrowed) continue;
    let sim = null;
    try {
      sim = simulateVehicle(resource.meta, vehicle.name);
    } catch (error) {
      notChecked.push({ area: "meta", what: `Meta checks for ${vehicle.name}`, reason: String(error?.message || error), path: vehicle.path });
      continue;
    }
    findings.push(...metaFindings(sim, { fallbackPath: vehicle.path, skipCodes: ID_CONFLICT_CODES }).map((finding) => ({ ...finding, vehiclePath: vehicle.path, resource: resource.path })));
    const listedInFull = listingComplete && !resource.partial && !scanErrors.some((entry) => isInside(resource.path, entry.path));
    if (/_hi\.yft$/i.test(vehicle.path) && listedInFull && !modelNames.has(lower(`${vehicle.name}.yft`))) {
      findings.push({ area: "model", severity: sim?.vehicle ? "warn" : "info", code: "BASE_MODEL_MISSING", path: vehicle.path, subject: vehicle.name, vehiclePath: vehicle.path, resource: resource.path, message: `${vehicle.name} ships only ${baseName(vehicle.path)}, with no ${vehicle.name}.yft in the folder. The base model must come from the game or another resource, or the vehicle won't spawn.`, fix: "Add the base .yft to the resource's stream folder, unless this only replaces the high-detail model of a vehicle the game or another resource provides." });
    }
    if (!/_hi\.yft$/i.test(vehicle.path)) {
      findings.push({ area: "model", severity: "info", code: "NO_HI_MODEL", path: vehicle.path, subject: vehicle.name, vehiclePath: vehicle.path, resource: resource.path, message: `${vehicle.name} has no ${vehicle.name}_hi.yft, so the game draws ${baseName(vehicle.path)} up close too.` });
    }
  }
  for (const entry of scan?.missing || []) {
    const resource = resources.find((candidate) => candidate.name === entry.resource);
    if (resource?.escrowed) continue;
    findings.push({ area: "meta", severity: "info", code: "MODEL_MISSING", path: resource?.path || root, subject: entry.name, resource: resource?.path || "", message: `${entry.name} is named in vehicles.meta in ${entry.resource}, but the resource has no ${entry.name}.yft. That's expected when the entry changes a game vehicle or one that another resource streams; otherwise it won't spawn.`, fix: "If this is a new vehicle, add its model to the resource's stream folder, or remove its vehicles.meta entry." });
  }

  const described = assets ? describeAll(assets).filter((file) => isStreamed(file.path)) : null;
  const streamFiles = new Map(checked.map((resource) => [resource.path, []]));
  if (described) {
    findings.push(...memoryFindings(described).map((finding) => ({ ...finding, resource: ownerOf(resources, finding.path)?.path || "" })));
    notChecked.push(...streamedNotChecked(described, root), ...unreadableNotChecked({ unreadable: (assets.unreadable || []).filter((entry) => typeof entry?.path === "string" && isStreamed(entry.path)) }, root));
    for (const file of described) {
      const owner = ownerOf(checked, file.path);
      if (owner && /(^|\/)stream\//i.test(relativePath(owner.path, file.path))) streamFiles.get(owner.path).push(file.path);
    }
    if (assets.truncated) notChecked.push({ area: "memory", what: `Streamed files past the first ${STREAMED_WALK_LIMIT.toLocaleString("en-US")} entries, or more than 8 folders deep`, reason: "Not checked (folder too large or too deep)" });
  } else {
    notChecked.push({ area: "memory", what: "Streamed memory", reason: assetsError || (cancelled ? "Cancelled" : "Not measured") });
  }

  for (const resource of checked) {
    if (!resource.manifest) {
      if (resource.models?.length) notChecked.push({ area: "manifest", what: `${resource.name} manifest`, reason: "No fxmanifest.lua or __resource.lua", path: resource.path });
      continue;
    }
    const read = manifests?.[resource.manifest];
    if (!read || typeof read.text !== "string") {
      notChecked.push({ area: "manifest", what: `Meta entries in ${relativePath(root, resource.manifest)}`, reason: read?.error || (cancelled ? "Cancelled" : "It was not read"), path: resource.manifest });
      continue;
    }
    const result = checkManifest({ root: resource.path, manifestPath: resource.manifest, text: read.text, metaPaths: resource.metaPaths, sources: resource.meta?.sources, listingComplete });
    findings.push(...result.findings.map((finding) => ({ ...finding, resource: resource.path })));
    notChecked.push(...result.notChecked);
  }

  findings.push(...aggregateResources(checked.map((resource) => ({ ...resource, streamFiles: streamFiles.get(resource.path) || [] }))).map((finding) => ({ ...finding, resource: finding.resource ?? ownerOf(resources, finding.path)?.path ?? "" })));

  if (scan?.truncated) notChecked.push({ area: "meta", what: "Meta files, manifests and models past the listing limit or more than 8 folders deep", reason: "Not checked (folder too large or too deep)" });
  for (const entry of scan?.errors || []) {
    if (entry && typeof entry.path === "string") notChecked.push({ area: "meta", what: relativePath(root, entry.path) || entry.path, reason: String(entry.message || "It could not be read"), path: entry.path });
  }
  if (cancelled) notChecked.push({ area: "run", what: "The rest of the check", reason: "Cancelled" });

  const escrowed = resources.filter((resource) => resource.escrowed).map((resource) => ({ name: resource.name, path: resource.path }));
  for (const dir of escrowedDirs) {
    if (!escrowed.some((entry) => isInside(entry.path, dir) || isInside(dir, entry.path))) escrowed.push({ name: baseName(dir), path: dir });
  }

  const sorted = sortFindings(dedupe(findings));
  const memory = described ? memorySummary(described, { truncated: Boolean(assets?.truncated) }) : null;
  const facts = [
    { label: "Vehicles", value: String(vehicles.length) },
    { label: "Resources", value: String(resources.length) },
  ];
  if (escrowed.length) facts.push({ label: "Escrowed, not checked", value: String(escrowed.length) });
  if (memory) facts.push({ label: "Streamed files measured", value: String(memory.files.length) });

  return {
    schema: PACK_DOCTOR_SCHEMA,
    version: PACK_DOCTOR_VERSION,
    scope: "folder",
    title: baseName(root) || "Folder",
    root,
    subject: root,
    createdAt,
    generator,
    complete: !cancelled && notChecked.length === 0,
    scopeNote: FOLDER_SCOPE_NOTE,
    counts: countsOf(sorted, notChecked),
    findings: sorted,
    notChecked,
    escrowed,
    memory,
    facts,
    resources: resources.map((resource) => ({
      name: resource.name,
      path: resource.path,
      escrowed: resource.escrowed,
      vehicles: vehicles.filter((vehicle) => ownerOf(resources, vehicle.path)?.path === resource.path).length,
      findings: sorted.filter((finding) => finding.resource === resource.path).length,
    })),
  };
}

const PATH_SEGMENT = String.raw`(?:(?!\.[A-Za-z0-9]{1,8}[.,;:]?\s)(?![.,;]\s)[^\\/\r\n"'` + "`" + String.raw`<>|:*?])+`;
const ABSOLUTE_DIRS = new RegExp(String.raw`(?:[A-Za-z]:|\\\\${PATH_SEGMENT})(?:[\\/]${PATH_SEGMENT})*[\\/]`, "g");

function scrubPaths(text, known, shown) {
  let value = String(text ?? "");
  for (const path of known) {
    for (const form of new Set([path, path.replace(/\//g, "\\")])) {
      value = value.replace(new RegExp(String.raw`${escapeRegExp(form)}(?=[\\/]|$|[^\w-])`, "gi"), () => shown(path));
    }
  }
  return value.replace(ABSOLUTE_DIRS, "");
}

export function exportReport(report) {
  const root = report?.root || "";
  const rel = (path) => {
    if (!path) return "";
    if (lower(slashes(path)) === lower(slashes(root))) return baseName(root);
    return isInside(root, path) ? relativePath(root, path) : baseName(path);
  };
  const known = [...new Set([
    root,
    ...(report.resources || []).map((entry) => entry.path),
    ...report.findings.map((entry) => entry.path),
    ...report.notChecked.map((entry) => entry.path),
    ...(report.escrowed || []).map((entry) => entry.path),
    ...(report.memory?.files || []).map((entry) => entry.path),
  ].filter((path) => typeof path === "string" && /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path)).map(slashes))].sort((a, b) => b.length - a.length);
  const scrub = (text) => scrubPaths(text, known, rel);
  return {
    schema: PACK_DOCTOR_SCHEMA,
    version: PACK_DOCTOR_VERSION,
    scope: report.scope,
    title: report.title,
    root: baseName(root),
    createdAt: report.createdAt,
    generator: report.generator,
    complete: report.complete,
    counts: report.counts,
    findings: report.findings.map(({ severity, code, area, message, fix, subject, path }) => ({ severity, code, area, file: rel(path), subject: subject || "", message: scrub(message), fix: scrub(fix || "") })),
    notChecked: report.notChecked.map(({ area, what, reason, path }) => ({ area, what: scrub(what), reason: scrub(reason), file: rel(path) })),
    escrowed: report.escrowed.map(({ name, path }) => ({ name, file: rel(path) })),
    memory: report.memory ? {
      truncated: report.memory.truncated,
      total: report.memory.total,
      files: report.memory.files.map(({ path, kind, physical, virtual }) => ({ file: rel(path), kind, physical, virtual })),
    } : null,
    facts: report.facts,
    scopeNote: report.scopeNote || "",
    resources: (report.resources || []).map(({ name, path, escrowed, vehicles, findings }) => ({ name, file: rel(path), escrowed, vehicles, findings })),
  };
}

export function reportJson(report) {
  return `${JSON.stringify(exportReport(report), null, 2)}\n`;
}

function countsLine(counts) {
  return `${plural(counts.error, "error")}, ${plural(counts.warn, "warning")}, ${plural(counts.info, "note")}, ${counts.notChecked} not checked`;
}

const MARKDOWN_MEMORY_ROWS = 15;

export function namesSubject(finding) {
  const words = lower(finding?.subject).split(/\s+/).filter(Boolean);
  const message = lower(finding?.message);
  return words.length > 0 && !words.every((word) => message.includes(word));
}

function markdownText(text) {
  return String(text ?? "").replace(/([\\`*_[\]|<>])/g, "\\$1");
}

export function renderDoctorMarkdown(report) {
  const data = exportReport(report);
  const lines = [`### Pack Doctor: ${markdownText(data.title)}`, "", `${countsLine(data.counts)}. Checked with ${markdownText(data.generator)}${data.createdAt ? ` on ${data.createdAt.slice(0, 10)}` : ""}.`];
  for (const severity of ["error", "warn", "info"]) {
    const group = data.findings.filter((finding) => finding.severity === severity);
    if (!group.length) continue;
    lines.push("", `**${SEVERITY_TITLE[severity]} (${group.length})**`, "");
    for (const finding of group) {
      lines.push(`- ${namesSubject(finding) ? `${markdownText(finding.subject)}, ` : ""}${finding.file ? `\`${finding.file.replace(/`/g, "'")}\`: ` : ""}${markdownText(finding.message)}`);
      if (finding.fix) lines.push(`  Fix: ${markdownText(finding.fix)}`);
    }
  }
  if (!data.findings.length) lines.push("", data.complete ? "No problems found." : "No problems found in what was checked.");
  if (data.scopeNote) lines.push("", markdownText(data.scopeNote));
  if (data.memory?.files.length) {
    lines.push("", "**Streamed memory**", "", "| File | Graphics (physical) | System (virtual) |", "| --- | ---: | ---: |");
    for (const file of data.memory.files.slice(0, MARKDOWN_MEMORY_ROWS)) lines.push(`| ${markdownText(file.file)} | ${formatMiB(file.physical)} MiB | ${formatMiB(file.virtual)} MiB |`);
    if (data.memory.files.length > MARKDOWN_MEMORY_ROWS) lines.push(`| and ${data.memory.files.length - MARKDOWN_MEMORY_ROWS} more | | |`);
    lines.push("", data.memory.total
      ? `Total: ${formatMiB(data.memory.total.physical)} MiB graphics (physical), ${formatMiB(data.memory.total.virtual)} MiB system (virtual).`
      : "No total: the folder was too large to measure in full.");
  }
  if (data.escrowed.length) {
    lines.push("", "**Escrowed, not checked**", "");
    for (const entry of data.escrowed) lines.push(`- ${markdownText(entry.name)}`);
  }
  if (data.notChecked.length) {
    lines.push("", "**Not checked**", "");
    for (const entry of data.notChecked) lines.push(`- ${markdownText(entry.what)}: ${markdownText(entry.reason)}`);
  }
  return `${lines.join("\n")}\n`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderDoctorHtml(report) {
  const data = exportReport(report);
  const label = { error: "error", warn: "warning", info: "note" };
  const findingRows = data.findings.map((finding) => `<li class="${escapeHtml(finding.severity)}"><span>${label[finding.severity]}</span><div><p>${namesSubject(finding) ? `<b>${escapeHtml(finding.subject)}</b>: ` : ""}${escapeHtml(finding.message)}</p>${finding.fix ? `<p class="fix">${escapeHtml(finding.fix)}</p>` : ""}<code>${escapeHtml(finding.file)}${finding.file ? " · " : ""}${escapeHtml(finding.code)}</code></div></li>`).join("");
  const memoryRows = (data.memory?.files || []).map((file) => `<tr><td><code>${escapeHtml(file.file)}</code></td><td>${formatMiB(file.physical)} MiB</td><td>${formatMiB(file.virtual)} MiB</td></tr>`).join("");
  const memoryTotal = data.memory ? (data.memory.total
    ? `<p class="facts"><span>Total ${formatMiB(data.memory.total.physical)} MiB graphics (physical)</span><span>${formatMiB(data.memory.total.virtual)} MiB system (virtual)</span></p>`
    : "<p class=\"facts\"><span>No total: the folder was too large to measure in full</span></p>") : "";
  const notChecked = data.notChecked.map((entry) => `<li><span>not checked</span><div><p>${escapeHtml(entry.what)}: ${escapeHtml(entry.reason)}</p>${entry.file ? `<code>${escapeHtml(entry.file)}</code>` : ""}</div></li>`).join("");
  const escrowed = data.escrowed.map((entry) => `<li><span>escrowed</span><div><p>${escapeHtml(entry.name)}</p></div></li>`).join("");
  const facts = data.facts.map((fact) => `<div><dt>${escapeHtml(fact.label)}</dt><dd>${escapeHtml(fact.value)}</dd></div>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pack Doctor · ${escapeHtml(data.title)}</title>
<style>
:root{color-scheme:light dark;--paper:#f0f0e9;--ink:#0f1012;--muted:#575b61;--line:#d2d2c7;--accent:#3462bd;--warn:#a8741a;--err:#b94842}
@media (prefers-color-scheme:dark){:root{--paper:#121316;--ink:#f0f0e9;--muted:#a2a6ad;--line:#2c2f35;--accent:#558bf6;--warn:#e0b45c;--err:#dc7c72}}
*{box-sizing:border-box}body{margin:0;padding:32px clamp(16px,4vw,48px);background:var(--paper);color:var(--ink);font:14px/1.5 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif}
h1{margin:0;font:italic 800 clamp(30px,4vw,48px)/1 "Barlow Condensed","Arial Narrow",sans-serif;text-transform:uppercase;overflow-wrap:anywhere}
h2{margin:0 0 12px;font-size:15px;font-weight:650}
.facts{display:flex;flex-wrap:wrap;gap:6px 22px;margin:12px 0 0;color:var(--muted);font:12px Consolas,"Cascadia Mono",monospace}
section{padding:24px 0;border-top:1px solid var(--line)}header{padding-bottom:24px}
ul.issues{list-style:none;margin:0;padding:0}ul.issues li{display:flex;gap:10px;align-items:baseline;padding:8px 0;border-bottom:1px solid var(--line)}
ul.issues span{flex:0 0 92px;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}ul.issues .error span{color:var(--err)}ul.issues .warn span{color:var(--warn)}
ul.issues p{margin:0}ul.issues .fix{color:var(--muted)}ul.issues div{min-width:0}
code{font:11.5px Consolas,"Cascadia Mono",monospace;color:var(--muted);overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;font-size:13px}th{padding:6px 0;border-bottom:1px solid var(--line);text-align:left;font-size:11px;letter-spacing:.08em;text-transform:uppercase}th+th{text-align:right;padding-left:16px}td{padding:6px 0;border-bottom:1px solid var(--line)}td+td{text-align:right;font:12px Consolas,"Cascadia Mono",monospace;white-space:nowrap;padding-left:16px}
dl{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px 24px;margin:0}dt{font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}dd{margin:2px 0 0}
</style>
</head>
<body>
<header>
<h1>${escapeHtml(data.title)}</h1>
<p class="facts"><span>${data.scope === "folder" ? "Folder" : "Vehicle"}</span><span>${escapeHtml(data.createdAt)}</span><span>${data.complete ? "complete" : "partial check"}</span><span>${escapeHtml(countsLine(data.counts))}</span><span>${escapeHtml(data.generator)}</span></p>
</header>
<section><h2>Checks</h2>${findingRows ? `<ul class="issues">${findingRows}</ul>` : `<p>${data.complete ? "No problems found." : "No problems found in what was checked."}</p>`}</section>
${memoryRows ? `<section><h2>Streamed memory</h2><table><thead><tr><th>File</th><th>Graphics (physical)</th><th>System (virtual)</th></tr></thead><tbody>${memoryRows}</tbody></table>${memoryTotal}</section>` : ""}
${escrowed ? `<section><h2>Escrowed, not checked</h2><ul class="issues">${escrowed}</ul></section>` : ""}
${notChecked ? `<section><h2>Not checked</h2><ul class="issues">${notChecked}</ul></section>` : ""}
${data.scopeNote ? `<p class="facts"><span>${escapeHtml(data.scopeNote)}</span></p>` : ""}
${facts ? `<section><h2>Facts</h2><dl>${facts}</dl></section>` : ""}
</body>
</html>
`;
}
