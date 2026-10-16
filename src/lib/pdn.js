/**
 * Paint.NET (.pdn) reader.
 *
 * A PDN3 file is "PDN3", a 24-bit little-endian header length, an XML header
 * (`<pdnImage width height layers ...>`), the bytes 0x00 0x01, a .NET
 * BinaryFormatter (NRBF) document that describes the layers, and then each
 * layer's pixels as "deferred" chunks after the document.
 *
 * The layer list is read from the document (Document -> LayerList ->
 * BitmapLayer -> LayerProperties / BitmapLayerProperties / Surface ->
 * MemoryBlock), the same way the native decoder in `src-tauri/src/pdn.rs`
 * reads it. Damaged, truncated or unsupported files throw an error that says
 * why; nothing is guessed from the compressed data.
 */

import pako from "pako";

const PDN_MAGIC = [0x50, 0x44, 0x4e, 0x33]; // "PDN3"
const MAX_PDN_DIMENSION = 16_384;
const MAX_PDN_OUTPUT_BYTES = 384 * 1024 * 1024;
const MAX_PDN_CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_PDN_TOTAL_INFLATED_BYTES = 768 * 1024 * 1024;
const MAX_HEADER_BYTES = 1024 * 1024;
const MAX_NRBF_DEPTH = 64;
const MAX_NRBF_MEMBERS = 4096;

/** Paint.NET's blend modes in `LayerBlendMode` order: the enum value is the index. */
const PDN_BLEND_MODES = [
  "Normal", "Multiply", "Additive", "ColorBurn", "ColorDodge", "Reflect", "Glow",
  "Overlay", "Difference", "Negation", "Lighten", "Darken", "Screen", "Xor",
];

export function isPdnFile(bytes) {
  if (!bytes || bytes.length < 4) return false;
  return PDN_MAGIC.every((value, index) => bytes[index] === value);
}

/* ── Header ── */

function xmlAttribute(tag, name) {
  const needle = ` ${name}="`;
  const start = tag.indexOf(needle);
  if (start < 0) return null;
  const valueStart = start + needle.length;
  const end = tag.indexOf('"', valueStart);
  return end < 0 ? null : tag.slice(valueStart, end);
}

function parseUnsigned(value) {
  return value != null && /^\d+$/.test(value) ? Number(value) : null;
}

function parseHeader(bytes) {
  if (!isPdnFile(bytes) || bytes.length < 7) {
    throw new Error("Not a Paint.NET file (missing PDN3 signature).");
  }
  const length = bytes[4] | (bytes[5] << 8) | (bytes[6] << 16);
  const xmlEnd = 7 + length;
  if (length === 0 || length > MAX_HEADER_BYTES || xmlEnd + 2 > bytes.length) {
    throw new Error("The .pdn header is damaged or the file is truncated.");
  }
  const xml = new TextDecoder("utf-8").decode(bytes.subarray(7, xmlEnd));
  const tagStart = xml.indexOf("<pdnImage");
  const tagEnd = tagStart < 0 ? -1 : xml.indexOf(">", tagStart);
  if (tagEnd < 0) throw new Error("The .pdn header has no image description.");
  const tag = xml.slice(tagStart, tagEnd);
  const dimension = (name) => {
    const value = parseUnsigned(xmlAttribute(tag, name));
    if (value == null) throw new Error(`The .pdn header has no valid image ${name}.`);
    return value;
  };
  const width = dimension("width");
  const height = dimension("height");
  const layers = parseUnsigned(xmlAttribute(tag, "layers"));
  const marker0 = bytes[xmlEnd];
  const marker1 = bytes[xmlEnd + 1];
  if (marker0 === 0x1f && marker1 === 0x8b) {
    throw new Error(
      "This .pdn uses an older compressed layout that can't be read. Open and save it in a current Paint.NET, or save a PNG copy.",
    );
  }
  if (marker0 !== 0x00 || marker1 !== 0x01) {
    throw new Error("The .pdn document layout is not recognised.");
  }
  return { width, height, layers, bodyStart: xmlEnd + 2 };
}

/* ── NRBF ([MS-NRBF]) document ──
   Only the records BinaryFormatter writes for object graphs: class, string,
   array, reference and null records. Member values are kept as
   { kind: "bool" | "int" | "str" | "ref" | "obj" | "null" | "other", ... }. */

const NULL_VALUE = Object.freeze({ kind: "null" });
const OTHER_VALUE = Object.freeze({ kind: "other" });

const PRIMITIVE_SIZES = {
  1: 1, 2: 1, 10: 1,
  7: 2, 14: 2,
  8: 4, 11: 4, 15: 4,
  6: 8, 9: 8, 12: 8, 13: 8, 16: 8,
  17: 0,
};

class NrbfReader {
  constructor(bytes, pos) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = pos;
    this.classes = new Map();
    /** Objects in the order their records finished, as the native reader keeps them. */
    this.objects = [];
    this.strings = new Map();
    /** Non-null elements of object and string arrays: id -> [[index, value]]. */
    this.arrays = new Map();
    this.decoder = new TextDecoder("utf-8");
  }

  error(message) {
    return new Error(`The .pdn layer document could not be read (${message} at byte ${this.pos}).`);
  }

  take(count) {
    const end = this.pos + count;
    if (!Number.isSafeInteger(end) || count < 0 || end > this.bytes.length) {
      throw this.error("unexpected end of file");
    }
    const start = this.pos;
    this.pos = end;
    return start;
  }

  u8() {
    return this.bytes[this.take(1)];
  }

  i32() {
    return this.view.getInt32(this.take(4), true);
  }

  count() {
    const value = this.i32();
    if (value < 0) throw this.error("negative length");
    return value;
  }

  string() {
    let length = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = this.u8();
      length += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) {
        const start = this.take(length);
        return this.decoder.decode(this.bytes.subarray(start, start + length));
      }
    }
    throw this.error("bad string length");
  }

  primitive(kind) {
    switch (kind) {
      case 1: return { kind: "bool", value: this.u8() !== 0 };
      case 2: return { kind: "int", value: this.u8() };
      case 10: return { kind: "int", value: this.view.getInt8(this.take(1)) };
      case 7: return { kind: "int", value: this.view.getInt16(this.take(2), true) };
      case 14: return { kind: "int", value: this.view.getUint16(this.take(2), true) };
      case 8: return { kind: "int", value: this.i32() };
      case 15: return { kind: "int", value: this.view.getUint32(this.take(4), true) };
      case 9: return { kind: "int", value: Number(this.view.getBigInt64(this.take(8), true)) };
      case 3: {
        // A UTF-8 encoded char: the lead byte gives its length.
        const lead = this.u8();
        const extra = lead <= 0x7f ? 0 : lead >= 0xc0 && lead <= 0xdf ? 1 : lead >= 0xe0 && lead <= 0xef ? 2
          : lead >= 0xf0 && lead <= 0xf7 ? 3 : -1;
        if (extra < 0) throw this.error("bad char value");
        this.take(extra);
        return OTHER_VALUE;
      }
      case 5:
      case 18:
        return { kind: "str", value: this.string() };
      case 17:
        return NULL_VALUE;
      default: {
        const size = PRIMITIVE_SIZES[kind];
        if (size === undefined) throw this.error(`unknown primitive type ${kind}`);
        this.take(size);
        return OTHER_VALUE;
      }
    }
  }

  classInfo() {
    const id = this.i32();
    const name = this.string();
    const count = this.count();
    if (count > MAX_NRBF_MEMBERS) throw this.error("too many class members");
    const names = [];
    for (let index = 0; index < count; index += 1) names.push(this.string());
    return { id, name, names };
  }

  /** A BinaryTypeEnumeration's additional info: the primitive type when values are inline. */
  additionalTypeInfo(binaryType) {
    switch (binaryType) {
      case 0: return this.u8();
      case 7: this.u8(); return null;
      case 3: this.string(); return null;
      case 4: this.string(); this.i32(); return null;
      case 1: case 2: case 5: case 6: return null;
      default: throw this.error(`unknown member type ${binaryType}`);
    }
  }

  typedMembers(names) {
    const start = this.take(names.length);
    const binaryTypes = this.bytes.slice(start, start + names.length);
    return names.map((name, index) => ({ name, primitive: this.additionalTypeInfo(binaryTypes[index]) }));
  }

  defineClass(id, name, members) {
    const meta = { name, members };
    this.classes.set(id, meta);
    return meta;
  }

  members(id, meta, depth) {
    const members = new Map();
    for (const member of meta.members) {
      members.set(member.name, member.primitive == null ? this.value(depth + 1) : this.primitive(member.primitive));
    }
    this.objects.push({ id, className: meta.name, members });
    return { type: "value", value: { kind: "obj", id } };
  }

  value(depth) {
    for (;;) {
      const record = this.record(depth);
      if (record.type === "value") return record.value;
      if (record.type !== "library") throw this.error("unexpected record in a member");
    }
  }

  elements(id, count, depth) {
    let read = 0;
    const values = [];
    while (read < count) {
      const record = this.record(depth + 1);
      if (record.type === "value") {
        if (record.value.kind !== "null") values.push([read, record.value]);
        read += 1;
      } else if (record.type === "nulls" && record.count > 0) {
        read += record.count;
      } else if (record.type !== "library") {
        throw this.error("unexpected record in an array");
      }
    }
    if (read > count) throw this.error("array overrun");
    this.arrays.set(id, values);
  }

  primitiveElements(kind, count) {
    const size = PRIMITIVE_SIZES[kind];
    if (size !== undefined) {
      this.take(count * size);
      return;
    }
    for (let index = 0; index < count; index += 1) this.primitive(kind);
  }

  record(depth) {
    if (depth > MAX_NRBF_DEPTH) throw this.error("objects nest too deeply");
    const type = this.u8();
    switch (type) {
      case 0:
        this.take(16);
        return { type: "header" };
      case 1: {
        const id = this.i32();
        const metadata = this.i32();
        const meta = this.classes.get(metadata);
        if (!meta) throw this.error("reference to an unknown class");
        return this.members(id, meta, depth);
      }
      case 2:
      case 3: {
        const { id, name, names } = this.classInfo();
        if (type === 3) this.i32();
        const meta = this.defineClass(id, name, names.map((member) => ({ name: member, primitive: null })));
        return this.members(id, meta, depth);
      }
      case 4:
      case 5: {
        const { id, name, names } = this.classInfo();
        const members = this.typedMembers(names);
        if (type === 5) this.i32();
        const meta = this.defineClass(id, name, members);
        return this.members(id, meta, depth);
      }
      case 6: {
        const id = this.i32();
        const value = this.string();
        this.strings.set(id, value);
        return { type: "value", value: { kind: "str", value } };
      }
      case 7: {
        const id = this.i32();
        const arrayType = this.u8();
        const rank = this.count();
        if (rank === 0 || rank > 32) throw this.error("bad array rank");
        let count = 1;
        for (let index = 0; index < rank; index += 1) {
          count *= this.count();
          if (!Number.isSafeInteger(count)) throw this.error("array too large");
        }
        if (arrayType >= 3 && arrayType <= 5) this.take(4 * rank);
        const primitive = this.additionalTypeInfo(this.u8());
        if (primitive == null) this.elements(id, count, depth);
        else this.primitiveElements(primitive, count);
        return { type: "value", value: { kind: "obj", id } };
      }
      case 8:
        return { type: "value", value: this.primitive(this.u8()) };
      case 9:
        return { type: "value", value: { kind: "ref", id: this.i32() } };
      case 10:
        return { type: "value", value: NULL_VALUE };
      case 11:
        return { type: "end" };
      case 12:
        this.i32();
        this.string();
        return { type: "library" };
      case 13:
        return { type: "nulls", count: this.u8() };
      case 14:
        return { type: "nulls", count: this.count() };
      case 15: {
        const id = this.i32();
        const count = this.count();
        this.primitiveElements(this.u8(), count);
        return { type: "value", value: { kind: "obj", id } };
      }
      case 16:
      case 17: {
        const id = this.i32();
        const count = this.count();
        this.elements(id, count, depth);
        return { type: "value", value: { kind: "obj", id } };
      }
      default:
        throw this.error(`unsupported record type ${type}`);
    }
  }

  /** Reads records up to MessageEnd; the deferred pixel data starts after it. */
  readDocument() {
    while (this.record(0).type !== "end") { /* keep reading */ }
  }
}

/* ── Layer list ── */

/** The class name after its namespace and declaring type. */
function shortName(className) {
  const parts = String(className).split(/[.+]/);
  return parts[parts.length - 1];
}

function referenceId(value) {
  return value && (value.kind === "ref" || value.kind === "obj") ? value.id : null;
}

function intMember(object, name) {
  const value = object?.members.get(name);
  return value?.kind === "int" ? value.value : null;
}

function boolMember(object, name) {
  const value = object?.members.get(name);
  return value?.kind === "bool" ? value.value : null;
}

/**
 * Reads the layer list and the order of the pixel blocks after the document.
 * Every layer is checked against the canvas, whether it is visible or not.
 */
function readLayout(doc, header) {
  const objects = new Map(doc.objects.map((object) => [object.id, object]));
  const resolve = (value) => {
    const id = referenceId(value);
    return id == null ? null : objects.get(id) || null;
  };
  const unreadable = () => new Error("The .pdn layer list could not be read.");
  const field = (object, suffix) => {
    for (const [name, value] of object.members) if (name.endsWith(suffix)) return value;
    return null;
  };

  // Document.layers is a LayerList (an ArrayList); index 0 is the bottom layer.
  const document = doc.objects.find((object) => shortName(object.className) === "Document");
  if (!document) throw unreadable();
  const list = resolve(document.members.get("layers"));
  if (!list) throw unreadable();
  const size = field(list, "_size");
  const count = size?.kind === "int" && size.value >= 0 ? size.value : null;
  const items = doc.arrays.get(referenceId(field(list, "_items")));
  if (count == null || !items) throw unreadable();
  if (count === 0 || (header.layers != null && header.layers !== count)) {
    const expected = header.layers != null ? `, ${header.layers} in the header` : "";
    throw new Error(`The .pdn layer list does not match its header (${count} layers${expected}).`);
  }

  // Deferred pixel data follows the document in the order the blocks were written.
  const memoryBlocks = doc.objects.filter((object) => shortName(object.className) === "MemoryBlock");
  const expectedLength = header.width * header.height * 4;
  const blocks = memoryBlocks.map((block) => {
    if (boolMember(block, "deferred") !== true || boolMember(block, "hasParent") === true) {
      throw new Error("This .pdn stores layer pixels inline (an older layout) that can't be read. Open and save it in a current Paint.NET, or save a PNG copy.");
    }
    const length = intMember(block, "length64") ?? intMember(block, "length");
    if (!Number.isSafeInteger(length) || length < 0) throw new Error("A .pdn pixel block has no valid length.");
    return { length, layer: null };
  });

  const layers = [];
  for (let index = 0; index < count; index += 1) {
    const item = items.find(([at]) => at === index);
    const layer = item ? resolve(item[1]) : null;
    if (!layer) throw unreadable();
    if (shortName(layer.className) !== "BitmapLayer") {
      throw new Error(`Layer ${index + 1} is not a bitmap layer, which can't be read.`);
    }
    let props = null;
    let bitmap = null;
    let surface = null;
    for (const value of layer.members.values()) {
      const object = resolve(value);
      if (!object) continue;
      const kind = shortName(object.className);
      if (kind === "LayerProperties") props = object;
      else if (kind === "BitmapLayerProperties") bitmap = object;
      else if (kind === "Surface") surface = object;
    }
    if (!props || !surface) throw unreadable();

    const nameValue = props.members.get("name");
    const rawName = nameValue?.kind === "str" ? nameValue.value
      : nameValue?.kind === "ref" ? doc.strings.get(nameValue.id) || "" : "";
    const name = rawName.trim() ? rawName : `Layer ${index + 1}`;
    const visible = boolMember(props, "visible");
    if (visible == null) throw new Error(`Layer “${name}” has no visibility setting.`);
    const opacity = intMember(props, "opacity");
    if (!Number.isInteger(opacity) || opacity < 0 || opacity > 255) {
      throw new Error(`Layer “${name}” has no valid opacity.`);
    }

    const width = intMember(surface, "width");
    const height = intMember(surface, "height");
    const stride = intMember(surface, "stride");
    if (width !== header.width || height !== header.height || (stride != null && stride !== header.width * 4)) {
      throw new Error(`Layer “${name}” does not match the ${header.width}x${header.height} canvas.`);
    }
    const scan0 = referenceId(surface.members.get("scan0"));
    const block = scan0 == null ? -1 : memoryBlocks.findIndex((candidate) => candidate.id === scan0);
    if (block < 0) throw new Error(`Layer “${name}” has no pixel data.`);
    if (blocks[block].length !== expectedLength || blocks[block].layer != null) {
      throw new Error(`Layer “${name}” pixel data does not match the canvas size.`);
    }
    blocks[block].layer = index;

    // Paint.NET takes the blend from the layer's BlendOp class when it has one
    // and from the LayerBlendMode enum otherwise (BitmapLayer's deserialization
    // callback). A blend that isn't one of its 14 is "Unknown", which
    // flattening refuses.
    const blendOp = bitmap?.members.get("blendOp");
    let blendMode = "Normal";
    let blendDetail = "";
    if (blendOp && blendOp.kind !== "null") {
      const op = resolve(blendOp);
      const opName = op ? shortName(op.className) : "";
      blendMode = PDN_BLEND_MODES.find((mode) => `${mode}BlendOp` === opName) || "Unknown";
      blendDetail = opName;
    } else {
      const modeValue = intMember(resolve(props.members.get("blendMode")), "value__");
      if (modeValue != null) {
        blendMode = PDN_BLEND_MODES[modeValue] || "Unknown";
        blendDetail = `value ${modeValue}`;
      }
    }

    layers.push({
      name,
      visible,
      opacity,
      isBackground: boolMember(props, "isBackground") ?? index === 0,
      blendMode,
      blendDetail,
    });
  }

  // BinaryFormatter writes the pixel data in layer-list order; flattening
  // relies on it, so anything else is refused rather than reordered.
  let previous = -1;
  for (const block of blocks) {
    if (block.layer == null) continue;
    if (block.layer < previous) {
      throw new Error("The .pdn pixel data is not in layer order, so it can't be flattened.");
    }
    previous = block.layer;
  }
  return { layers, blocks };
}

function readDocument(bytes) {
  const header = parseHeader(bytes);
  if (header.width === 0 || header.height === 0 || header.width > MAX_PDN_DIMENSION || header.height > MAX_PDN_DIMENSION) {
    throw new Error(`Invalid PDN dimensions: ${header.width}x${header.height}`);
  }
  const canvasBytes = header.width * header.height * 4;
  if (canvasBytes > MAX_PDN_OUTPUT_BYTES) {
    throw new Error(`PDN image dimensions exceed the safety output limit (${canvasBytes} bytes > ${MAX_PDN_OUTPUT_BYTES} bytes).`);
  }
  const doc = new NrbfReader(bytes, header.bodyStart);
  doc.readDocument();
  const { layers, blocks } = readLayout(doc, header);
  return { header, layers, blocks, dataStart: doc.pos, canvasBytes };
}

/* ── Pixel data ── */

function readU32BE(bytes, pos, what) {
  if (pos + 4 > bytes.length) throw new Error(`The .pdn file is truncated in ${what}.`);
  return ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
}

function inflateExact(payload, target, what) {
  let inflated;
  try {
    // pako checks the gzip CRC and length trailer.
    inflated = pako.ungzip(payload);
  } catch (error) {
    throw new Error(`The pixel data of ${what} is damaged and could not be decompressed: ${error?.message || error}`);
  }
  if (inflated.length !== target.length) {
    throw new Error(`The pixel data of ${what} is damaged and could not be decompressed: the chunk has the wrong size.`);
  }
  target.set(inflated);
}

/**
 * Walks the pixel blocks after the document. `wants(layer)` decides which
 * layers are decompressed; `onLayer(layer, bgra)` receives each one, in layer
 * order, before the shared buffer is reused.
 */
function readPixelBlocks(bytes, documentInfo, wants, onLayer) {
  const { layers, blocks, canvasBytes } = documentInfo;
  const pixels = new Uint8Array(canvasBytes);
  let inflatedTotal = 0;
  let pos = documentInfo.dataStart;
  for (const block of blocks) {
    const layer = block.layer == null ? null : layers[block.layer];
    const what = layer ? `layer “${layer.name}”` : "a pixel block";
    const wanted = Boolean(layer && wants(layer));

    if (pos >= bytes.length) throw new Error(`The .pdn file is truncated in ${what}.`);
    const format = bytes[pos];
    pos += 1;
    if (format > 1) throw new Error(`The pixel data of ${what} uses an unknown format.`);
    const chunkSize = readU32BE(bytes, pos, what);
    pos += 4;
    if (chunkSize === 0 || chunkSize > MAX_PDN_CHUNK_BYTES) {
      throw new Error(`The pixel data of ${what} has an invalid chunk size.`);
    }
    const chunks = Math.ceil(block.length / chunkSize);
    const seen = new Uint8Array(chunks);
    for (let index = 0; index < chunks; index += 1) {
      const number = readU32BE(bytes, pos, what);
      const size = readU32BE(bytes, pos + 4, what);
      pos += 8;
      if (number >= chunks || seen[number]) {
        throw new Error(`The pixel data of ${what} is damaged (bad chunk number).`);
      }
      seen[number] = 1;
      if (pos + size > bytes.length) throw new Error(`The .pdn file is truncated in ${what}.`);
      const payload = bytes.subarray(pos, pos + size);
      pos += size;
      if (!wanted) continue;
      const start = number * chunkSize;
      const end = Math.min(start + chunkSize, block.length);
      inflatedTotal += end - start;
      if (inflatedTotal > MAX_PDN_TOTAL_INFLATED_BYTES) {
        throw new Error(`PDN decode exceeded the total inflate safety limit (${MAX_PDN_TOTAL_INFLATED_BYTES} bytes).`);
      }
      const target = pixels.subarray(start, end);
      if (format === 0) {
        inflateExact(payload, target, what);
      } else if (payload.length === target.length) {
        target.set(payload);
      } else {
        throw new Error(`The pixel data of ${what} has the wrong size.`);
      }
    }
    if (wanted) onLayer(block.layer, pixels);
  }
}

/** a*b/255 rounded, for bytes, the way Paint.NET scales colours and alpha. */
function mulDiv255(a, b) {
  const r = a * b + 128;
  return ((r >> 8) + r) >> 8;
}

/**
 * Paint.NET's per-channel blend of a bottom colour `d` and a layer colour `s`
 * (0-255) for each mode other than Normal (whose blend is `s`). Integer
 * division truncates, as Paint.NET's does; the results were measured equal to
 * Paint.NET 5's for every input (docs/fixes/p9-pdn-blend.md).
 */
const PDN_BLEND_CHANNEL = {
  Multiply: (d, s) => mulDiv255(d, s),
  Additive: (d, s) => Math.min(255, d + s),
  ColorBurn: (d, s) => (s === 0 ? 0 : Math.max(0, 255 - Math.floor(((255 - d) * 255) / s))),
  ColorDodge: (d, s) => (s === 255 ? 255 : Math.min(255, Math.floor((d * 255) / (255 - s)))),
  Reflect: (d, s) => (s === 255 ? 255 : Math.min(255, Math.floor((d * d) / (255 - s)))),
  Glow: (d, s) => (d === 255 ? 255 : Math.min(255, Math.floor((s * s) / (255 - d)))),
  Overlay: (d, s) => (d < 128 ? mulDiv255(2 * d, s) : 255 - mulDiv255(2 * (255 - d), 255 - s)),
  Difference: (d, s) => Math.abs(s - d),
  Negation: (d, s) => 255 - Math.abs(255 - d - s),
  Lighten: (d, s) => Math.max(d, s),
  Darken: (d, s) => Math.min(d, s),
  Screen: (d, s) => d + s - mulDiv255(d, s),
  Xor: (d, s) => d ^ s,
};

/** 256x256 lookup tables of PDN_BLEND_CHANNEL, built on first use. */
const blendTables = new Map();

function blendTable(blendMode) {
  let table = blendTables.get(blendMode);
  if (!table) {
    const channel = PDN_BLEND_CHANNEL[blendMode];
    table = new Uint8Array(256 * 256);
    for (let d = 0; d < 256; d += 1) {
      for (let s = 0; s < 256; s += 1) table[(d << 8) | s] = channel(d, s);
    }
    blendTables.set(blendMode, table);
  }
  return table;
}

function unknownBlendError(layer) {
  const detail = layer.blendDetail ? ` (${layer.blendDetail})` : "";
  return new Error(
    `Layer “${layer.name}” uses an unrecognised blend mode${detail}, which can't be flattened here. Set the layer's blend mode to Normal in Paint.NET, or save a flattened PNG copy.`,
  );
}

/**
 * Composites one layer over a straight-alpha RGBA `canvas` the way Paint.NET
 * flattens: the layer's alpha is scaled by `opacity` (0-255), then where layer
 * and canvas overlap the mode's blended colour shows, and where only one
 * covers the pixel its own colour shows, in proportion to alpha. `layer` holds
 * straight-alpha pixels in BGRA order (as stored in a .pdn) when `bgra` is
 * true, else RGBA. All integer arithmetic: byte-identical to the native
 * decoder and to Paint.NET for every mode, Normal included.
 */
export function compositePdnLayer(canvas, layer, opacity, blendMode, bgra = false) {
  const normal = blendMode === "Normal";
  if (!normal && !PDN_BLEND_CHANNEL[blendMode]) throw new Error(`“${blendMode}” is not a Paint.NET blend mode.`);
  const table = normal ? null : blendTable(blendMode);
  const alpha = new Uint8Array(256);
  for (let a = 0; a < 256; a += 1) alpha[a] = mulDiv255(a, opacity);
  const rAt = bgra ? 2 : 0;
  const bAt = bgra ? 0 : 2;
  const length = Math.min(canvas.length, layer.length) & ~3;
  for (let i = 0; i < length; i += 4) {
    const sa = alpha[layer[i + 3]];
    if (sa === 0) continue;
    const r = layer[i + rAt];
    const g = layer[i + 1];
    const b = layer[i + bAt];
    const da = canvas[i + 3];
    // Exact shortcuts of the general case below: over a transparent pixel
    // every mode shows the layer, and an opaque Normal layer replaces it.
    if (da === 0 || (normal && sa === 255)) {
      canvas[i] = r;
      canvas[i + 1] = g;
      canvas[i + 2] = b;
      canvas[i + 3] = sa;
      continue;
    }
    const bottomOnly = mulDiv255(da, 255 - sa);
    const total = bottomOnly + sa;
    const dr = canvas[i];
    const dg = canvas[i + 1];
    const db = canvas[i + 2];
    if (normal) {
      canvas[i] = ((dr * bottomOnly + r * sa) / total) | 0;
      canvas[i + 1] = ((dg * bottomOnly + g * sa) / total) | 0;
      canvas[i + 2] = ((db * bottomOnly + b * sa) / total) | 0;
    } else {
      const both = mulDiv255(da, sa);
      const layerOnly = sa - both;
      canvas[i] = ((dr * bottomOnly + r * layerOnly + table[(dr << 8) | r] * both) / total) | 0;
      canvas[i + 1] = ((dg * bottomOnly + g * layerOnly + table[(dg << 8) | g] * both) / total) | 0;
      canvas[i + 2] = ((db * bottomOnly + b * layerOnly + table[(db << 8) | b] * both) / total) | 0;
    }
    canvas[i + 3] = total;
  }
}

/**
 * Throws the refusal for the first layer picked by `isVisible(layer, index)`
 * whose blend mode Paint.NET doesn't have, so a caller can check before any
 * work starts.
 */
export function assertPdnLayersFlattenable(layers, isVisible = (layer) => layer.visible) {
  layers.forEach((layer, index) => {
    if (layer.blendMode === "Unknown" && isVisible(layer, index)) throw unknownBlendError(layer);
  });
}

/**
 * Flattens the layers `decodePdnLayers` returned, bottom to top, with each
 * layer's opacity and blend mode, exactly as Paint.NET would.
 * `isVisible(layer, index)` picks the layers drawn (default: the file's own
 * visibility). Throws, before drawing, for a picked layer whose blend mode
 * Paint.NET doesn't have. Writes into `out` (RGBA, cleared first) when it
 * has the right size, otherwise into a new Uint8ClampedArray, and returns it.
 */
export function flattenPdnLayers({ width, height, layers }, isVisible = (layer) => layer.visible, out = null) {
  assertPdnLayersFlattenable(layers, isVisible);
  const size = width * height * 4;
  let canvas = out;
  if (canvas?.length === size) canvas.fill(0);
  else canvas = new Uint8ClampedArray(size);
  layers.forEach((layer, index) => {
    if (!(layer.opacity > 0) || !isVisible(layer, index)) return;
    compositePdnLayer(canvas, layer.image, layer.opacity, layer.blendMode);
  });
  return canvas;
}

function bgraToRgba(bgra) {
  const rgba = new Uint8Array(bgra.length);
  for (let i = 0; i + 3 < bgra.length; i += 4) {
    rgba[i] = bgra[i + 2];
    rgba[i + 1] = bgra[i + 1];
    rgba[i + 2] = bgra[i];
    rgba[i + 3] = bgra[i + 3];
  }
  return rgba;
}

/* ── Public API ── */

/**
 * Decodes a .pdn into its layers, bottom first. Returns null for bytes that
 * are not a Paint.NET file and throws for a damaged or unsupported one.
 *
 * Returns: {
 *   width, height,
 *   layers: [{ name, visible, opacity (0-255), blendMode (Paint.NET name, or
 *              "Unknown"), blendDetail, isBackground,
 *              image (RGBA, width*height*4) }]
 * }
 */
export function decodePdnLayers(bytes) {
  if (!isPdnFile(bytes)) return null;
  const documentInfo = readDocument(bytes);
  const images = new Array(documentInfo.layers.length).fill(null);
  readPixelBlocks(bytes, documentInfo, () => true, (index, bgra) => {
    images[index] = bgraToRgba(bgra);
  });
  const { width, height } = documentInfo.header;
  return {
    width,
    height,
    layers: documentInfo.layers.map((layer, index) => ({
      name: layer.name,
      visible: layer.visible,
      opacity: layer.opacity,
      blendMode: layer.blendMode,
      blendDetail: layer.blendDetail,
      isBackground: layer.isBackground,
      image: images[index] || new Uint8Array(documentInfo.canvasBytes),
    })),
  };
}

/**
 * Flattens a .pdn the way Paint.NET shows it: visible layers bottom to top
 * with their opacity and blend mode. Hidden layers are skipped without
 * decompressing them. Returns null for bytes that are not a Paint.NET file
 * and throws for a damaged or unsupported one, including a visible layer
 * whose blend mode isn't one of Paint.NET's.
 *
 * Returns { width, height, data (RGBA), layerCount, headerLayerCount,
 * layerNames }; the last three let a caller check what was read.
 */
export function decodePdn(bytes) {
  if (!isPdnFile(bytes)) return null;
  const documentInfo = readDocument(bytes);
  assertPdnLayersFlattenable(documentInfo.layers);
  const canvas = new Uint8Array(documentInfo.canvasBytes);
  readPixelBlocks(
    bytes,
    documentInfo,
    (layer) => layer.visible && layer.opacity > 0,
    (index, bgra) => {
      const { opacity, blendMode } = documentInfo.layers[index];
      compositePdnLayer(canvas, bgra, opacity, blendMode, true);
    },
  );
  const { width, height, layers: headerLayerCount } = documentInfo.header;
  return {
    width,
    height,
    data: canvas,
    layerCount: documentInfo.layers.length,
    headerLayerCount,
    layerNames: documentInfo.layers.map((layer) => layer.name),
  };
}

export function parsePdn(bytes) {
  return decodePdn(bytes);
}

export const __pdnTest = {
  readDocument,
};
