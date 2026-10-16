// Ultimate Lighting Controller (ULC) configs. A resource's ulc.lua returns a
// Lua table naming the vehicles it covers and which extras the script switches
// for park and drive patterns, brakes, reverse, horn, doors and its buttons.
// This reads the table as data: a small parser for Lua table constructors
// (strings, numbers, booleans, nil, nested tables, comments). Nothing is
// executed; anything outside that grammar is rejected with its position.

class LuaReader {
  constructor(text) {
    this.text = text;
    this.index = 0;
  }

  fail(message) {
    const before = this.text.slice(0, this.index);
    const line = before.split("\n").length;
    const column = this.index - before.lastIndexOf("\n");
    throw new Error(`ulc.lua ${line}:${column}: ${message}`);
  }

  skip() {
    for (;;) {
      const rest = this.text.slice(this.index);
      const space = /^\s+/.exec(rest);
      if (space) {
        this.index += space[0].length;
        continue;
      }
      const block = /^--\[(=*)\[[\s\S]*?\]\1\]/.exec(rest);
      if (block) {
        this.index += block[0].length;
        continue;
      }
      const line = /^--[^\n]*/.exec(rest);
      if (line) {
        this.index += line[0].length;
        continue;
      }
      return;
    }
  }

  peek(token) {
    this.skip();
    return this.text.startsWith(token, this.index);
  }

  expect(token) {
    if (!this.peek(token)) this.fail(`expected "${token}"`);
    this.index += token.length;
  }

  identifier() {
    this.skip();
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.index));
    if (!match) return null;
    this.index += match[0].length;
    return match[0];
  }

  string() {
    this.skip();
    const quote = this.text[this.index];
    if (quote === "[") {
      const match = /^\[(=*)\[([\s\S]*?)\]\1\]/.exec(this.text.slice(this.index));
      if (!match) this.fail("unterminated long string");
      this.index += match[0].length;
      return match[2];
    }
    this.index += 1;
    let out = "";
    while (this.index < this.text.length) {
      const char = this.text[this.index];
      if (char === quote) {
        this.index += 1;
        return out;
      }
      if (char === "\\") {
        const next = this.text[this.index + 1];
        out += { n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"', "'": "'" }[next] ?? next;
        this.index += 2;
        continue;
      }
      if (char === "\n") break;
      out += char;
      this.index += 1;
    }
    return this.fail("unterminated string");
  }

  value() {
    this.skip();
    const char = this.text[this.index];
    if (char === "{") return this.table();
    if (char === '"' || char === "'" || this.text.startsWith("[[", this.index) || /^\[=+\[/.test(this.text.slice(this.index))) {
      return this.string();
    }
    const number = /^-?(0x[0-9a-f]+|\d+(\.\d+)?([eE][-+]?\d+)?|\.\d+)/i.exec(this.text.slice(this.index));
    if (number) {
      this.index += number[0].length;
      return Number(number[0]);
    }
    const word = this.identifier();
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "nil") return null;
    return this.fail(word ? `unsupported expression "${word}"` : "expected a value");
  }

  table() {
    this.expect("{");
    const list = [];
    const fields = {};
    let hasFields = false;
    while (!this.peek("}")) {
      this.skip();
      const save = this.index;
      let key = null;
      if (this.peek("[") && !/^\[=*\[/.test(this.text.slice(this.index))) {
        this.expect("[");
        key = this.value();
        this.expect("]");
        this.expect("=");
      } else {
        const name = this.identifier();
        if (name && this.peek("=") && !this.peek("==")) {
          this.expect("=");
          key = name;
        } else {
          this.index = save;
        }
      }
      const value = this.value();
      if (key == null) list.push(value);
      else {
        fields[key] = value;
        hasFields = true;
      }
      if (this.peek(",")) this.expect(",");
      else if (this.peek(";")) this.expect(";");
      else if (!this.peek("}")) this.fail('expected "," or "}"');
    }
    this.expect("}");
    if (!hasFields) return list;
    list.forEach((value, index) => { fields[index + 1] = value; });
    return fields;
  }
}

/** Parses the table a ulc.lua returns. Throws with line:column on anything else. */
export function parseLuaTable(text) {
  const reader = new LuaReader(String(text ?? ""));
  reader.skip();
  if (reader.text.startsWith("return", reader.index)) reader.index += "return".length;
  const value = reader.table();
  reader.skip();
  if (reader.index < reader.text.length) reader.fail("unexpected text after the table");
  return value;
}

function ints(value) {
  return (Array.isArray(value) ? value : []).filter(Number.isInteger);
}

/** A normalised ULC config: lowercase vehicle names and extras lists per feature. */
export function normalizeUlcConfig(raw) {
  const config = raw && typeof raw === "object" ? raw : {};
  const park = config.parkConfig || {};
  const brake = config.brakeConfig || {};
  const reverse = config.reverseConfig || {};
  const horn = config.hornConfig || {};
  const steady = config.steadyBurnConfig || {};
  return {
    names: (Array.isArray(config.names) ? config.names : []).filter((name) => typeof name === "string").map((name) => name.toLowerCase()),
    park: { enabled: Boolean(park.usePark), parkExtras: ints(park.pExtras), driveExtras: ints(park.dExtras) },
    brake: { enabled: Boolean(brake.useBrakes), extras: ints(brake.brakeExtras), disable: ints(brake.disableExtras) },
    reverse: { enabled: Boolean(reverse.useReverse), extras: ints(reverse.reverseExtras), disable: ints(reverse.disableExtras) },
    horn: { enabled: Boolean(horn.useHorn), extras: ints(horn.hornExtras), disable: ints(horn.disableExtras) },
    steadyBurn: { forceOn: Boolean(steady.forceOn), disableWithLights: Boolean(steady.disableWithLights), extras: ints(steady.sbExtras) },
    buttons: (Array.isArray(config.buttons) ? config.buttons : [])
      .filter((button) => button && Number.isInteger(button.extra))
      .map((button) => ({
        label: typeof button.label === "string" ? button.label.replace(/\s+/g, " ").trim() : `Extra ${button.extra}`,
        key: Number.isInteger(button.key) ? button.key : null,
        color: typeof button.color === "string" ? button.color : "",
        extra: button.extra,
        linked: ints(button.linkedExtras),
        opposite: ints(button.oppositeExtras),
        off: ints(button.offExtras),
      })),
  };
}

/**
 * Reads a ulc.lua and returns the config covering `modelName`, or null. A file
 * may return one config or a list of them.
 */
export function findUlcConfig(text, modelName) {
  const parsed = parseLuaTable(text);
  const configs = Array.isArray(parsed) ? parsed : [parsed];
  const wanted = String(modelName || "").toLowerCase();
  for (const raw of configs) {
    const config = normalizeUlcConfig(raw);
    if (config.names.includes(wanted)) return config;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export const ULC_BUTTON_COLORS = Object.freeze(["green", "amber", "red", "blue"]);

const LUA_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LUA_KEYWORDS = new Set(["and", "break", "do", "else", "elseif", "end", "false", "for", "function", "goto", "if", "in", "local", "nil", "not", "or", "repeat", "return", "then", "true", "until", "while"]);

function luaString(value) {
  const escapes = { "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r" };
  return `"${String(value).replace(/[\\"\n\r]/g, (char) => escapes[char])}"`;
}

function luaKey(key) {
  if (/^\d+$/.test(key)) return `[${key}]`;
  return LUA_IDENTIFIER.test(key) && !LUA_KEYWORDS.has(key) ? key : `[${luaString(key)}]`;
}

function isScalar(value) {
  return value == null || typeof value !== "object";
}

/** A Lua table constructor for plain data: lists of scalars stay on one line. */
export function serializeLua(value, indent = "    ", depth = 0) {
  if (value == null) return "nil";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("ulc.lua cannot hold a non-finite number");
    return String(value);
  }
  if (typeof value === "string") return luaString(value);
  const pad = indent.repeat(depth + 1);
  const end = indent.repeat(depth);
  if (Array.isArray(value)) {
    if (!value.length) return "{}";
    if (value.every(isScalar)) return `{${value.map((entry) => serializeLua(entry)).join(", ")}}`;
    return `{\n${value.map((entry) => `${pad}${serializeLua(entry, indent, depth + 1)},`).join("\n")}\n${end}}`;
  }
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  if (!entries.length) return "{}";
  return `{\n${entries.map(([key, entry]) => `${pad}${luaKey(key)} = ${serializeLua(entry, indent, depth + 1)},`).join("\n")}\n${end}}`;
}

const uniqueInts = (list) => [...new Set(ints(list))].sort((a, b) => a - b);
const KNOWN_ORDER = ["names", "steadyBurnConfig", "parkConfig", "hornConfig", "brakeConfig", "reverseConfig", "buttons"];

/**
 * A raw ULC config table for `config` (the normalized shape), merged over
 * `base` (the raw table it replaces) so fields the editor does not model, such
 * as door or sync settings, are kept.
 */
export function buildUlcTable(config, base = {}) {
  const raw = base && typeof base === "object" && !Array.isArray(base) ? base : {};
  const sub = (key) => (raw[key] && typeof raw[key] === "object" && !Array.isArray(raw[key]) ? raw[key] : {});
  const baseButtons = Array.isArray(raw.buttons) ? raw.buttons : [];
  const table = {
    names: [...new Set((config.names || []).map((name) => String(name).trim().toLowerCase()).filter(Boolean))],
    steadyBurnConfig: {
      ...sub("steadyBurnConfig"),
      forceOn: Boolean(config.steadyBurn?.forceOn),
      disableWithLights: Boolean(config.steadyBurn?.disableWithLights),
      sbExtras: uniqueInts(config.steadyBurn?.extras),
    },
    parkConfig: {
      ...sub("parkConfig"),
      usePark: Boolean(config.park?.enabled),
      pExtras: uniqueInts(config.park?.parkExtras),
      dExtras: uniqueInts(config.park?.driveExtras),
    },
    hornConfig: {
      ...sub("hornConfig"),
      useHorn: Boolean(config.horn?.enabled),
      hornExtras: uniqueInts(config.horn?.extras),
      disableExtras: uniqueInts(config.horn?.disable),
    },
    brakeConfig: {
      ...sub("brakeConfig"),
      useBrakes: Boolean(config.brake?.enabled),
      brakeExtras: uniqueInts(config.brake?.extras),
      disableExtras: uniqueInts(config.brake?.disable),
    },
    reverseConfig: {
      ...sub("reverseConfig"),
      useReverse: Boolean(config.reverse?.enabled),
      reverseExtras: uniqueInts(config.reverse?.extras),
      disableExtras: uniqueInts(config.reverse?.disable),
    },
    buttons: (config.buttons || []).filter((button) => Number.isInteger(button?.extra)).map((button) => {
      const previous = baseButtons.find((entry) => entry && entry.extra === button.extra) || {};
      return {
        ...previous,
        label: String(button.label || `Extra ${button.extra}`).trim(),
        key: Number.isInteger(button.key) ? button.key : previous.key ?? null,
        color: ULC_BUTTON_COLORS.includes(button.color) ? button.color : previous.color || "green",
        extra: button.extra,
        linkedExtras: uniqueInts(button.linked),
        oppositeExtras: uniqueInts(button.opposite),
        offExtras: uniqueInts(button.off),
      };
    }),
  };
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_ORDER.includes(key)) table[key] = value;
  }
  return table;
}

const ULC_HEADER = "-- Ultimate Lighting Controller config";

/**
 * Writes `config` for `modelName` into ulc.lua text (null or empty for a new
 * file). The config whose names include the model is replaced, merged over its
 * old fields; otherwise it is added, turning a single config into a list.
 * Comments in the old file are not kept. Returns { text, mode }.
 */
export function upsertUlcConfig(sourceText, modelName, config) {
  const wanted = String(modelName || "").toLowerCase();
  const source = String(sourceText ?? "");
  if (!source.trim()) {
    return { text: `${ULC_HEADER}\nreturn ${serializeLua(buildUlcTable(config))}\n`, mode: "created" };
  }
  const parsed = parseLuaTable(source);
  const list = Array.isArray(parsed);
  const configs = list ? [...parsed] : [parsed];
  const at = configs.findIndex((raw) => normalizeUlcConfig(raw).names.includes(wanted));
  const table = buildUlcTable(config, at >= 0 ? configs[at] : {});
  if (at >= 0) configs[at] = table;
  else configs.push(table);
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const body = configs.length === 1 && !list ? serializeLua(configs[0]) : serializeLua(configs);
  return { text: `${ULC_HEADER}${eol}return ${body}${eol}`.replace(/\r?\n/g, eol), mode: at >= 0 ? "replaced" : "added" };
}

/** A starting config for a model with no ULC entry: one button per extra that carries lights. */
export function defaultUlcConfig(modelName, extras = [], lightExtras = {}) {
  const lit = extras.filter((extra) => lightExtras?.[extra]?.sirens?.length || lightExtras?.[extra]?.steady);
  return {
    names: [String(modelName || "").toLowerCase()].filter(Boolean),
    park: { enabled: false, parkExtras: [], driveExtras: [] },
    brake: { enabled: false, extras: [], disable: [] },
    reverse: { enabled: false, extras: [], disable: [] },
    horn: { enabled: false, extras: [], disable: [] },
    steadyBurn: { forceOn: false, disableWithLights: false, extras: [] },
    buttons: lit.slice(0, 9).map((extra, index) => ({
      label: `Extra ${extra}`, key: index + 1, color: "green", extra, linked: [], opposite: [], off: [],
    })),
  };
}
