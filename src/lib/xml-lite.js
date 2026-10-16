// Minimal XML reader for GTA V meta files (vehicles.meta, carvariations.meta,
// carcols.meta). Dependency free so the same code runs in Node tests and the
// renderer. It is not a conformant XML parser: no namespaces, no DTD
// processing, no external entities. Malformed input throws XmlParseError with
// a line/column instead of producing a partial tree.

export class XmlParseError extends Error {
  constructor(message, line, column) {
    super(`XML parse error at ${line}:${column}: ${message}`);
    this.name = "XmlParseError";
    this.line = line;
    this.column = column;
  }
}

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[A-Za-z0-9_:.\-]/;
const WHITESPACE = /\s/;

const ENTITIES = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

function createNode(name) {
  return { name, attrs: {}, children: [], text: "" };
}

class Reader {
  constructor(text, { positions = false } = {}) {
    this.text = text;
    this.pos = 0;
    this.len = text.length;
    this.positions = positions;
  }

  location(pos = this.pos) {
    let line = 1;
    let lastBreak = -1;
    for (let i = 0; i < pos && i < this.len; i += 1) {
      if (this.text.charCodeAt(i) === 10) {
        line += 1;
        lastBreak = i;
      }
    }
    return { line, column: pos - lastBreak };
  }

  fail(message, pos = this.pos) {
    const { line, column } = this.location(pos);
    throw new XmlParseError(message, line, column);
  }

  peek(offset = 0) {
    return this.text[this.pos + offset];
  }

  startsWith(str) {
    return this.text.startsWith(str, this.pos);
  }

  eof() {
    return this.pos >= this.len;
  }

  skipWhitespace() {
    while (this.pos < this.len && WHITESPACE.test(this.text[this.pos])) this.pos += 1;
  }

  readName() {
    const start = this.pos;
    if (this.eof() || !NAME_START.test(this.text[this.pos])) {
      this.fail("expected a name");
    }
    this.pos += 1;
    while (this.pos < this.len && NAME_CHAR.test(this.text[this.pos])) this.pos += 1;
    return this.text.slice(start, this.pos);
  }

  expect(str) {
    if (!this.startsWith(str)) this.fail(`expected "${str}"`);
    this.pos += str.length;
  }

  // Skips a construct that ends with `terminator`; throws if it never ends.
  skipUntil(terminator, what) {
    const end = this.text.indexOf(terminator, this.pos);
    if (end === -1) this.fail(`unterminated ${what}`);
    this.pos = end + terminator.length;
  }

  decodeEntities(raw, startPos) {
    if (raw.indexOf("&") === -1) return raw;
    let out = "";
    let i = 0;
    while (i < raw.length) {
      const ch = raw[i];
      if (ch !== "&") {
        out += ch;
        i += 1;
        continue;
      }
      const semi = raw.indexOf(";", i);
      if (semi === -1 || semi - i > 12) {
        this.fail("bad entity: missing ';'", startPos + i);
      }
      const body = raw.slice(i + 1, semi);
      if (body[0] === "#") {
        const isHex = body[1] === "x" || body[1] === "X";
        const digits = isHex ? body.slice(2) : body.slice(1);
        if (!digits || !(isHex ? /^[0-9A-Fa-f]+$/ : /^[0-9]+$/).test(digits)) {
          this.fail(`bad character reference "&${body};"`, startPos + i);
        }
        const code = parseInt(digits, isHex ? 16 : 10);
        if (!Number.isFinite(code) || code > 0x10ffff) {
          this.fail(`bad character reference "&${body};"`, startPos + i);
        }
        out += String.fromCodePoint(code);
      } else if (Object.prototype.hasOwnProperty.call(ENTITIES, body)) {
        out += ENTITIES[body];
      } else {
        this.fail(`unknown entity "&${body};"`, startPos + i);
      }
      i = semi + 1;
    }
    return out;
  }

  readAttrValue() {
    const quote = this.peek();
    if (quote !== '"' && quote !== "'") this.fail("expected quoted attribute value");
    this.pos += 1;
    const start = this.pos;
    const end = this.text.indexOf(quote, this.pos);
    if (end === -1) this.fail("unterminated attribute value", start);
    const raw = this.text.slice(start, end);
    if (raw.indexOf("<") !== -1) this.fail("'<' is not allowed inside an attribute value", start);
    this.pos = end + 1;
    return this.decodeEntities(raw, start);
  }

  // Parses prolog/misc constructs before, between, or after elements.
  // Returns true if something was consumed.
  skipMisc() {
    if (this.startsWith("<?")) {
      this.skipUntil("?>", "processing instruction");
      return true;
    }
    if (this.startsWith("<!--")) {
      this.skipUntil("-->", "comment");
      return true;
    }
    if (this.startsWith("<!DOCTYPE") || this.startsWith("<!doctype")) {
      this.skipUntil(">", "DOCTYPE");
      return true;
    }
    return false;
  }

  parseElement() {
    const openPos = this.pos;
    this.expect("<");
    const name = this.readName();
    const node = createNode(name);
    if (this.positions) node.start = openPos;

    for (;;) {
      this.skipWhitespace();
      if (this.eof()) this.fail(`unterminated start tag <${name}>`, openPos);
      if (this.startsWith("/>")) {
        this.pos += 2;
        if (this.positions) node.end = this.pos;
        return node;
      }
      if (this.peek() === ">") {
        this.pos += 1;
        break;
      }
      const attrName = this.readName();
      this.skipWhitespace();
      this.expect("=");
      this.skipWhitespace();
      node.attrs[attrName] = this.readAttrValue();
    }

    const textParts = [];
    for (;;) {
      if (this.eof()) this.fail(`unterminated element <${name}>`, openPos);
      if (this.startsWith("</")) {
        this.pos += 2;
        const closeName = this.readName();
        if (closeName !== name) {
          this.fail(`mismatched closing tag </${closeName}> for <${name}>`);
        }
        this.skipWhitespace();
        this.expect(">");
        break;
      }
      if (this.startsWith("<![CDATA[")) {
        const start = this.pos + 9;
        const end = this.text.indexOf("]]>", start);
        if (end === -1) this.fail("unterminated CDATA section");
        textParts.push(this.text.slice(start, end));
        this.pos = end + 3;
        continue;
      }
      if (this.startsWith("<!--")) {
        this.skipUntil("-->", "comment");
        continue;
      }
      if (this.startsWith("<?")) {
        this.skipUntil("?>", "processing instruction");
        continue;
      }
      if (this.peek() === "<") {
        node.children.push(this.parseElement());
        continue;
      }
      const start = this.pos;
      let end = this.text.indexOf("<", this.pos);
      if (end === -1) end = this.len;
      textParts.push(this.decodeEntities(this.text.slice(start, end), start));
      this.pos = end;
    }

    node.text = textParts.join("").trim();
    if (this.positions) node.end = this.pos;
    return node;
  }

  parseDocument() {
    let root = null;
    for (;;) {
      this.skipWhitespace();
      if (this.eof()) break;
      if (this.skipMisc()) continue;
      if (this.peek() !== "<") {
        this.fail("text outside of the root element");
      }
      if (root) this.fail("more than one root element");
      root = this.parseElement();
    }
    if (!root) this.fail("document has no root element", 0);
    return root;
  }
}

/**
 * Parses an XML string into a plain tree of `{ name, attrs, children, text }`.
 * `text` is the trimmed concatenation of the element's own text and CDATA
 * nodes; element children are listed in `children` in document order.
 * With `positions`, each node also carries `start`/`end` offsets of its markup
 * in the text after a leading BOM is removed, so callers can splice the source.
 */
export function parseXml(text, { positions = false } = {}) {
  if (typeof text !== "string") throw new TypeError("parseXml expects a string");
  // Strip a UTF-8 BOM; GTA tools write them routinely.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return new Reader(source, { positions }).parseDocument();
}

function sameName(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

export function findChild(node, name) {
  if (!node || !Array.isArray(node.children)) return null;
  for (const child of node.children) {
    if (sameName(child.name, name)) return child;
  }
  return null;
}

export function findChildren(node, name) {
  if (!node || !Array.isArray(node.children)) return [];
  if (name == null) return node.children.slice();
  return node.children.filter((child) => sameName(child.name, name));
}

export function childText(node, name, fallback = "") {
  const child = findChild(node, name);
  if (!child) return fallback;
  return child.text;
}

export function attrValue(node, name, fallback = undefined) {
  if (!node || !node.attrs) return fallback;
  if (Object.prototype.hasOwnProperty.call(node.attrs, name)) return node.attrs[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(node.attrs)) {
    if (key.toLowerCase() === lower) return node.attrs[key];
  }
  return fallback;
}

/**
 * Reads a numeric value from `value="..."` or the element text. Returns
 * `fallback` (default NaN) when the node is missing or not numeric.
 */
export function numberValue(node, fallback = Number.NaN) {
  if (!node) return fallback;
  const raw = attrValue(node, "value");
  const source = raw != null ? raw : node.text;
  if (source == null || source === "") return fallback;
  const trimmed = String(source).trim();
  const parsed = /^0x[0-9a-f]+$/i.test(trimmed) ? parseInt(trimmed, 16) : Number(trimmed);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function boolValue(node, fallback = false) {
  if (!node) return fallback;
  const raw = attrValue(node, "value");
  const source = (raw != null ? raw : node.text || "").trim().toLowerCase();
  if (source === "true" || source === "1") return true;
  if (source === "false" || source === "0") return false;
  return fallback;
}

/** Parses `content="char_array"` style text (whitespace or comma separated numbers). */
export function parseCharArray(text) {
  if (text == null) return [];
  const out = [];
  for (const token of String(text).split(/[\s,]+/)) {
    if (!token) continue;
    const value = Number(token);
    if (!Number.isFinite(value)) {
      throw new Error(`parseCharArray: "${token}" is not a number`);
    }
    out.push(value);
  }
  return out;
}
