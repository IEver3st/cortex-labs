// ELS V8 pattern tables. VCFs written for ELS V8 (and the FiveM ports that
// read them) name patterns by number; the on/off timings live in the lighting
// script, not the VCF. Cortex ships no tables. The user imports them from their
// own copy of a script, and playback names where its timings came from.
//
// A pack is plain data, safe to keep in localStorage:
// {
//   version: 1, source: "ELS-FiveM", path, importedAt,
//   onChar: "0" | "1",   which character lights the extra in this script
//   stepMs,              how long each character lasts
//   formats: { leds: { primary: { [n]: { [extra]: bits } }, secondary, warning },
//              traf: { secondary }, chp: { stage1, stage2, stage3 } }
// }
// ELS-FiveM and ELS-Plus carry the same tables but read them with opposite
// polarity (ELS-FiveM passes the character straight to SetVehicleExtra, whose
// argument means "disable"), so `onChar` travels with the pack.

export const ELS_PATTERN_PACK_VERSION = 1;
export const ELS_PATTERN_STORAGE_KEY = "cortex-studio:els-patterns.v1";
const MAX_TABLE_BYTES = 4 * 1024 * 1024;
const MAX_BITS = 4096;

// ELS-FiveM's client/_patternTypes globals and where each lands in a pack.
const ELS_FIVEM_TABLES = Object.freeze({
  led_primarypatterns: ["leds", "primary"],
  led_secondarypatterns: ["leds", "secondary"],
  led_warningpatterns: ["leds", "warning"],
  leds_warningpatterns: ["leds", "warning"],
  traf_patterns: ["traf", "secondary"],
  chp_stageone: ["chp", "stage1"],
  chp_stagetwo: ["chp", "stage2"],
  chp_stagethree: ["chp", "stage3"],
});

// ELS-FiveM's default els_flashDelay convar: milliseconds between characters.
export const ELS_FIVEM_STEP_MS = 15;

export class PatternImportError extends Error {
  constructor(message) {
    super(message);
    this.name = "PatternImportError";
  }
}

// ---------------------------------------------------------------------------
// Lua pattern files: `name = { [1] = { [1] = "0101", ... }, ... }` assignments.
// Read as data with sticky regexes (linear time on the 280 KB leds.lua);
// nothing is executed and anything else is rejected with its position.

const TOKEN = /\s+|--\[(=*)\[[\s\S]*?\]\1\]|--[^\n]*|([A-Za-z_][A-Za-z0-9_]*)|(-?\d+(?:\.\d+)?)|"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|([{}[\]=,;])/y;

function tokenize(text, label) {
  const tokens = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    const at = TOKEN.lastIndex;
    const match = TOKEN.exec(text);
    if (!match) {
      const before = text.slice(0, at);
      const line = before.split("\n").length;
      const column = at - before.lastIndexOf("\n");
      throw new PatternImportError(`${label} ${line}:${column}: unexpected "${text[at]}".`);
    }
    if (match[2] != null) tokens.push({ type: "name", value: match[2], at });
    else if (match[3] != null) tokens.push({ type: "number", value: Number(match[3]), at });
    else if (match[4] != null) tokens.push({ type: "string", value: match[4], at });
    else if (match[5] != null) tokens.push({ type: "string", value: match[5], at });
    else if (match[6] != null) tokens.push({ type: "punct", value: match[6], at });
  }
  return tokens;
}

/**
 * Global table assignments in a Lua file, as { [name]: value }. Tables keyed
 * `[n] =` become objects; positional entries take 1-based keys.
 */
export function parseLuaAssignments(text, label = "Lua file") {
  if (typeof text !== "string") throw new PatternImportError(`${label} is not text.`);
  if (text.length > MAX_TABLE_BYTES) throw new PatternImportError(`${label} is larger than 4 MB.`);
  const tokens = tokenize(text, label);
  let index = 0;
  const fail = (message) => {
    const at = tokens[index]?.at ?? text.length;
    const before = text.slice(0, at);
    throw new PatternImportError(`${label} ${before.split("\n").length}:${at - before.lastIndexOf("\n")}: ${message}`);
  };
  const peek = (value) => tokens[index]?.type === "punct" && tokens[index].value === value;
  const expect = (value) => {
    if (!peek(value)) fail(`expected "${value}"`);
    index += 1;
  };
  const value = () => {
    const token = tokens[index];
    if (!token) fail("expected a value");
    if (token.type === "punct" && token.value === "{") return table();
    if (token.type === "string" || token.type === "number") {
      index += 1;
      return token.value;
    }
    if (token.type === "name" && (token.value === "true" || token.value === "false")) {
      index += 1;
      return token.value === "true";
    }
    return fail(`unsupported value "${token.value}"`);
  };
  function table() {
    expect("{");
    const out = {};
    let position = 1;
    while (!peek("}")) {
      if (peek("[")) {
        index += 1;
        const key = value();
        expect("]");
        expect("=");
        out[key] = value();
      } else if (tokens[index]?.type === "name" && tokens[index + 1]?.type === "punct" && tokens[index + 1].value === "=") {
        const key = tokens[index].value;
        index += 2;
        out[key] = value();
      } else {
        out[position] = value();
        position += 1;
      }
      if (peek(",") || peek(";")) index += 1;
      else if (!peek("}")) fail('expected "," or "}"');
    }
    expect("}");
    return out;
  }
  const globals = {};
  while (index < tokens.length) {
    const name = tokens[index];
    if (name.type !== "name" || !(tokens[index + 1]?.type === "punct" && tokens[index + 1].value === "=")) {
      fail("expected a table assignment");
    }
    index += 2;
    globals[name.value] = value();
  }
  return globals;
}

// ---------------------------------------------------------------------------
// Packs

function bitsOrNull(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_BITS && /^[01]+$/.test(value) ? value : null;
}

/** Validates one { [n]: { [extra]: bits } } table; drops malformed rows. */
function normalizeTable(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [patternKey, extras] of Object.entries(raw)) {
    const pattern = Number(patternKey);
    if (!Number.isInteger(pattern) || pattern < 0 || !extras || typeof extras !== "object") continue;
    const row = {};
    for (const [extraKey, bits] of Object.entries(extras)) {
      const extra = Number(extraKey);
      const clean = bitsOrNull(bits);
      if (Number.isInteger(extra) && extra >= 1 && extra <= 12 && clean) row[extra] = clean;
    }
    if (Object.keys(row).length) out[pattern] = row;
  }
  return out;
}

function countPatterns(formats) {
  let total = 0;
  for (const roles of Object.values(formats || {})) for (const table of Object.values(roles || {})) total += Object.keys(table || {}).length;
  return total;
}

/** A clean pack from stored or imported data, or null when it is not one. */
export function normalizePatternPack(raw) {
  if (!raw || typeof raw !== "object" || raw.version !== ELS_PATTERN_PACK_VERSION) return null;
  const formats = {};
  for (const [format, roles] of Object.entries(raw.formats || {})) {
    if (!/^[a-z0-9]+$/.test(format) || !roles || typeof roles !== "object") continue;
    for (const [role, table] of Object.entries(roles)) {
      if (!/^(primary|secondary|warning|stage[123])$/.test(role)) continue;
      const clean = normalizeTable(table);
      if (Object.keys(clean).length) (formats[format] ||= {})[role] = clean;
    }
  }
  if (!countPatterns(formats)) return null;
  const stepMs = Number(raw.stepMs);
  return {
    version: ELS_PATTERN_PACK_VERSION,
    source: typeof raw.source === "string" && raw.source ? raw.source.slice(0, 80) : "Imported tables",
    path: typeof raw.path === "string" ? raw.path : "",
    importedAt: typeof raw.importedAt === "string" ? raw.importedAt : "",
    onChar: raw.onChar === "0" ? "0" : "1",
    stepMs: Number.isFinite(stepMs) && stepMs >= 5 && stepMs <= 1000 ? stepMs : ELS_FIVEM_STEP_MS,
    formats,
  };
}

/**
 * Builds a pack from ELS-FiveM's pattern files (client/_patternTypes/*.lua).
 * `files` is [{ name, text }]; unrecognised globals are ignored. Throws
 * PatternImportError when nothing usable is found.
 */
export function packFromElsFivem(files, { path = "", importedAt = "" } = {}) {
  const formats = {};
  const found = [];
  for (const file of files || []) {
    const globals = parseLuaAssignments(file.text, file.name || "pattern file");
    for (const [name, value] of Object.entries(globals)) {
      const target = ELS_FIVEM_TABLES[name.toLowerCase()];
      if (!target) continue;
      const table = normalizeTable(value);
      if (!Object.keys(table).length) continue;
      const [format, role] = target;
      (formats[format] ||= {})[role] = { ...(formats[format]?.[role] || {}), ...table };
      found.push(name);
    }
  }
  if (!found.length) {
    throw new PatternImportError("No ELS-FiveM pattern tables found. Pick the ELS-FiveM resource folder, or its client/_patternTypes folder (leds.lua, traf.lua, chp.lua).");
  }
  return normalizePatternPack({
    version: ELS_PATTERN_PACK_VERSION,
    source: "ELS-FiveM",
    path,
    importedAt,
    onChar: "0",
    stepMs: ELS_FIVEM_STEP_MS,
    formats,
  });
}

/** { formats: { leds: { primary: 140, ... } }, total } for the UI. */
export function summarizePatternPack(pack) {
  if (!pack) return { formats: {}, total: 0 };
  const formats = {};
  for (const [format, roles] of Object.entries(pack.formats)) {
    formats[format] = Object.fromEntries(Object.entries(roles).map(([role, table]) => [role, Object.keys(table).length]));
  }
  return { formats, total: countPatterns(pack.formats) };
}

/** Pattern numbers a pack has for a group, sorted; [] when none. */
export function patternNumbers(pack, format, role, stage = null) {
  const table = tableFor(pack, format, role, stage);
  return table ? Object.keys(table).map(Number).sort((a, b) => a - b) : [];
}

function tableFor(pack, format, role, stage) {
  const roles = pack?.formats?.[format];
  if (!roles) return null;
  if (format === "chp") return roles[`stage${stage || 1}`] || null;
  return roles[role] || null;
}

/**
 * The bit strings for one pattern: { bits: { [extra]: "0101" }, onChar, stepMs }
 * or null when the pack does not have it. CHP tables are per light stage.
 */
export function lookupPattern(pack, format, role, number, stage = null) {
  const row = tableFor(pack, format, role, stage)?.[number];
  if (!row) return null;
  return { bits: row, onChar: pack.onChar, stepMs: pack.stepMs };
}

// ---------------------------------------------------------------------------
// Storage. The pack is the user's imported data; a failed write is reported
// to the caller, never silently dropped.

export function loadPatternPack(storage = globalThis.localStorage) {
  try {
    const text = storage?.getItem(ELS_PATTERN_STORAGE_KEY);
    return text ? normalizePatternPack(JSON.parse(text)) : null;
  } catch {
    return null;
  }
}

/** Saves (or with null, removes) the pack. Returns { ok, error }. */
export function savePatternPack(pack, storage = globalThis.localStorage) {
  try {
    if (!pack) storage?.removeItem(ELS_PATTERN_STORAGE_KEY);
    else storage?.setItem(ELS_PATTERN_STORAGE_KEY, JSON.stringify(pack));
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}
