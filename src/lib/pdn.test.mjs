import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import pako from "pako";

import { decodePdn, decodePdnLayers, flattenPdnLayers } from "./pdn.js";
import { flattenPdnLayersAsync, pdnDecodeProblem, selectPdnImage } from "./pdn-reader.js";
import { WORKER_TIMEOUT } from "./worker-client.js";

/** Paint.NET's LayerBlendMode enum, by value. */
const BLEND_MODES = [
  "Normal", "Multiply", "Additive", "ColorBurn", "ColorDodge", "Reflect", "Glow",
  "Overlay", "Difference", "Negation", "Lighten", "Darken", "Screen", "Xor",
];

/* Expectations measured with Paint.NET's own Document.Flatten (see
   docs/fixes/p9-pdn-blend.md); the native decoder's tests use the same file. */
const BLEND_TABLE = JSON.parse(readFileSync(new URL("./__fixtures__/pdn-blend-expectations.json", import.meta.url), "utf8"));

/* A minimal NRBF writer for the records Paint.NET documents use, mirroring
   the native decoder's test writer (src-tauri/src/pdn.rs). */
class Writer {
  constructor() {
    this.bytes = [];
  }
  u8(value) {
    this.bytes.push(value & 0xff);
    return this;
  }
  i32(value) {
    const view = new DataView(new ArrayBuffer(4));
    view.setInt32(0, value, true);
    this.bytes.push(...new Uint8Array(view.buffer));
    return this;
  }
  i64(value) {
    const view = new DataView(new ArrayBuffer(8));
    view.setBigInt64(0, BigInt(value), true);
    this.bytes.push(...new Uint8Array(view.buffer));
    return this;
  }
  string(value) {
    const encoded = new TextEncoder().encode(value);
    let length = encoded.length;
    for (;;) {
      const byte = length & 0x7f;
      length >>= 7;
      if (length === 0) {
        this.u8(byte);
        break;
      }
      this.u8(byte | 0x80);
    }
    this.bytes.push(...encoded);
    return this;
  }
  /** ClassWithMembersAndTypes; the caller writes the member values next. */
  class(id, name, members) {
    this.u8(5).i32(id).string(name).i32(members.length);
    for (const [member] of members) this.string(member);
    const binaryType = { bool: 0, byte: 0, int32: 0, int64: 0, str: 1, objectArray: 5 };
    for (const [, kind] of members) this.u8(kind.startsWith("class:") ? 4 : binaryType[kind]);
    const primitive = { bool: 1, byte: 2, int32: 8, int64: 9 };
    for (const [, kind] of members) {
      if (kind.startsWith("class:")) this.string(kind.slice(6)).i32(2);
      else if (primitive[kind]) this.u8(primitive[kind]);
    }
    return this.i32(2);
  }
  /** ClassWithId: another instance of an already described class. */
  instance(id, metadata) {
    return this.u8(1).i32(id).i32(metadata);
  }
  text(id, value) {
    return this.u8(6).i32(id).string(value);
  }
  reference(id) {
    return this.u8(9).i32(id);
  }
}

function u32be(value) {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/**
 * A PDN3 file shaped like Paint.NET 5 output: header, the NRBF document
 * (Document -> LayerList -> BitmapLayer -> properties, surface, memory
 * block), then deferred gzip chunks written last chunk first.
 * Layers: { name, visible, opacity, blend ("" writes a null blendOp), blendEnum?, pixels (BGRA) }.
 */
function buildPdn(width, height, layers, chunkSize, { headerLayers = layers.length } = {}) {
  const xml = `<pdnImage width="${width}" height="${height}" layers="${headerLayers}" savedWithVersion="5.102"><custom /></pdnImage>`;
  const doc = new Writer();
  doc.u8(0).i32(1).i32(-1).i32(1).i32(0);
  doc.u8(12).i32(2).string("PaintDotNet.Core");
  doc.class(1, "PaintDotNet.Document", [
    ["width", "int32"],
    ["height", "int32"],
    ["layers", "class:PaintDotNet.LayerList"],
  ]).i32(width).i32(height).reference(3);
  doc.class(3, "PaintDotNet.LayerList", [
    ["ArrayList+_items", "objectArray"],
    ["ArrayList+_size", "int32"],
  ]).reference(7).i32(layers.length);
  // ArraySingleObject with spare capacity, like ArrayList's backing array.
  doc.u8(16).i32(7).i32(layers.length + 2);
  const base = (index) => 20 + 10 * index;
  for (let index = 0; index < layers.length; index += 1) doc.reference(base(index));
  doc.u8(13).u8(2);

  for (let index = 0; index < layers.length; index += 1) {
    const l = base(index);
    if (index === 0) {
      doc.class(l, "PaintDotNet.BitmapLayer", [
        ["properties", "class:PaintDotNet.BitmapLayer+BitmapLayerProperties"],
        ["surface", "class:PaintDotNet.Surface"],
        ["Layer+properties", "class:PaintDotNet.Layer+LayerProperties"],
      ]);
    } else {
      doc.instance(l, 20);
    }
    doc.reference(l + 3).reference(l + 2).reference(l + 1);
  }
  const length = width * height * 4;
  layers.forEach((layer, index) => {
    const l = base(index);
    if (index === 0) {
      doc.class(l + 1, "PaintDotNet.Layer+LayerProperties", [
        ["name", "str"],
        ["visible", "bool"],
        ["isBackground", "bool"],
        ["opacity", "byte"],
        ["blendMode", "class:PaintDotNet.LayerBlendMode"],
      ]);
    } else {
      doc.instance(l + 1, 21);
    }
    doc.text(l + 6, layer.name).u8(layer.visible ? 1 : 0).u8(index === 0 ? 1 : 0).u8(layer.opacity);
    // The enum is a value type, written inline with a negative id.
    if (index === 0) doc.class(-(l + 7), "PaintDotNet.LayerBlendMode", [["value__", "int32"]]);
    else doc.instance(-(l + 7), -27);
    doc.i32(layer.blendEnum ?? Math.max(0, BLEND_MODES.indexOf(layer.blend)));
    if (index === 0) {
      doc.class(l + 2, "PaintDotNet.Surface", [
        ["width", "int32"],
        ["height", "int32"],
        ["stride", "int32"],
        ["scan0", "class:PaintDotNet.MemoryBlock"],
      ]);
    } else {
      doc.instance(l + 2, 22);
    }
    doc.i32(width).i32(height).i32(width * 4).reference(l + 4);
    if (index === 0) {
      doc.class(l + 3, "PaintDotNet.BitmapLayer+BitmapLayerProperties", [
        ["blendOp", "class:PaintDotNet.UserBlendOp"],
      ]);
    } else {
      doc.instance(l + 3, 23);
    }
    if (layer.blend) doc.reference(l + 5);
    else doc.u8(10); // ObjectNull
  });
  layers.forEach((layer, index) => {
    const l = base(index);
    if (layer.blend) doc.class(l + 5, `PaintDotNet.UserBlendOps+${layer.blend}BlendOp`, []);
    if (index === 0) {
      doc.class(l + 4, "PaintDotNet.MemoryBlock", [
        ["length64", "int64"],
        ["hasParent", "bool"],
        ["deferred", "bool"],
      ]);
    } else {
      doc.instance(l + 4, 24);
    }
    doc.i64(length).u8(0).u8(1);
  });
  doc.u8(11);

  const xmlBytes = new TextEncoder().encode(xml);
  const file = [0x50, 0x44, 0x4e, 0x33, xmlBytes.length & 0xff, (xmlBytes.length >>> 8) & 0xff, (xmlBytes.length >>> 16) & 0xff];
  file.push(...xmlBytes, 0x00, 0x01, ...doc.bytes);
  for (const layer of layers) {
    file.push(0, ...u32be(chunkSize));
    const chunks = [];
    for (let offset = 0; offset < layer.pixels.length; offset += chunkSize) {
      chunks.push(layer.pixels.subarray(offset, Math.min(offset + chunkSize, layer.pixels.length)));
    }
    for (let number = chunks.length - 1; number >= 0; number -= 1) {
      const compressed = pako.gzip(chunks[number]);
      file.push(...u32be(number), ...u32be(compressed.length), ...compressed);
    }
  }
  return Uint8Array.from(file);
}

function layer(name, visible, opacity, blend, bgra, pixelCount = 4, extra = {}) {
  const pixels = new Uint8Array(pixelCount * 4);
  for (let index = 0; index < pixels.length; index += 4) pixels.set(bgra, index);
  return { name, visible, opacity, blend, pixels, ...extra };
}

function indexOfBytes(bytes, text) {
  const needle = new TextEncoder().encode(text);
  outer: for (let index = 0; index + needle.length <= bytes.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (bytes[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

/* ── Decoding ── */

test("decodePdn flattens visible layers with their opacity, like the native decoder", () => {
  const file = buildPdn(2, 2, [
    layer("Background", true, 255, "Normal", [0, 0, 255, 255]),
    layer("Tint", true, 128, "Normal", [255, 0, 0, 255]),
  ], 5);
  const image = decodePdn(file);
  assert.equal(image.width, 2);
  assert.equal(image.height, 2);
  assert.equal(image.data.length, 16);
  // 128/255 blue over opaque red; the native decoder's test expects the same bytes.
  assert.deepEqual([...image.data.subarray(0, 4)], [127, 0, 128, 255]);
  assert.equal(image.layerCount, 2);
  assert.equal(image.headerLayerCount, 2);
  assert.deepEqual(image.layerNames, ["Background", "Tint"]);
});

test("hidden layers stay hidden in the flattened image, whatever their blend mode", () => {
  const file = buildPdn(2, 2, [
    layer("Background", true, 255, "Normal", [10, 20, 30, 255]),
    layer("Shadows", false, 255, "Multiply", [0, 0, 0, 255]),
  ], 16);
  assert.deepEqual([...decodePdn(file).data.subarray(0, 4)], [30, 20, 10, 255]);
});

test("decodePdnLayers reads the real layer names, visibility, opacity and blend modes", () => {
  const file = buildPdn(2, 2, [
    layer("Background", true, 255, "Normal", [10, 20, 30, 255]),
    layer("Decals", true, 200, "Normal", [1, 2, 3, 128]),
    layer("Shadows", false, 64, "Multiply", [0, 0, 0, 255]),
  ], 8);
  const result = decodePdnLayers(file);
  assert.deepEqual(
    result.layers.map(({ name, visible, opacity, blendMode, isBackground }) => ({ name, visible, opacity, blendMode, isBackground })),
    [
      { name: "Background", visible: true, opacity: 255, blendMode: "Normal", isBackground: true },
      { name: "Decals", visible: true, opacity: 200, blendMode: "Normal", isBackground: false },
      { name: "Shadows", visible: false, opacity: 64, blendMode: "Multiply", isBackground: false },
    ],
  );
  // Every layer keeps its own pixels (RGBA), the hidden one too.
  assert.deepEqual([...result.layers[1].image.subarray(0, 4)], [3, 2, 1, 128]);
  assert.deepEqual([...result.layers[2].image.subarray(0, 4)], [0, 0, 0, 255]);
});

test("every Paint.NET blend mode flattens as Paint.NET does, with partial alpha and layer opacity", () => {
  const { pairs, opacities, expected } = BLEND_TABLE;
  assert.deepEqual(Object.keys(expected), BLEND_MODES);
  const toBgra = ([r, g, b, a]) => [b, g, r, a];
  const bottom = Uint8Array.from(pairs.flatMap(([below]) => toBgra(below)));
  const top = Uint8Array.from(pairs.flatMap(([, above]) => toBgra(above)));
  for (const mode of BLEND_MODES) {
    opacities.forEach((opacity, row) => {
      const file = buildPdn(pairs.length, 1, [
        { name: "Background", visible: true, opacity: 255, blend: "Normal", pixels: bottom },
        { name: "Top", visible: true, opacity, blend: mode, pixels: top },
      ], 16);
      const { data } = decodePdn(file);
      expected[mode][row].forEach((want, index) => {
        assert.deepEqual([...data.subarray(index * 4, index * 4 + 4)], want, `${mode} @${opacity} pair ${index}`);
      });
    });
  }
});

test("the blend mode comes from the layer's BlendOp, then its enum, as Paint.NET reads it", () => {
  const background = () => layer("Background", true, 255, "Normal", [200, 100, 50, 255]);
  const shadows = (blend, extra = {}) => layer("Shadows", true, 255, blend, [128, 128, 128, 255], 4, extra);
  const pixel = (top) => [...decodePdn(buildPdn(2, 2, [background(), top], 16)).data.subarray(0, 4)];
  // Multiply: 50*128/255, 100*128/255, 200*128/255 (RGBA).
  const multiplied = [25, 50, 100, 255];
  assert.deepEqual(pixel(shadows("Multiply")), multiplied);
  // Paint.NET ignores the enum when there is a BlendOp.
  assert.deepEqual(pixel(shadows("Multiply", { blendEnum: 0 })), multiplied);
  // Without a BlendOp, the enum decides (1 is Multiply).
  assert.deepEqual(pixel(shadows("", { blendEnum: 1 })), multiplied);
  assert.deepEqual(pixel(shadows("", { blendEnum: 0 })), [128, 128, 128, 255]);
  assert.equal(decodePdnLayers(buildPdn(2, 2, [background(), shadows("", { blendEnum: 5 })], 16)).layers[1].blendMode, "Reflect");

  // Blends Paint.NET doesn't have are refused, naming the layer.
  const unknownOp = buildPdn(2, 2, [background(), shadows("Hologram")], 16);
  assert.throws(() => decodePdn(unknownOp), /“Shadows” uses an unrecognised blend mode \(HologramBlendOp\).*Normal.*flattened PNG/);
  assert.equal(decodePdnLayers(unknownOp).layers[1].blendMode, "Unknown");
  assert.throws(() => decodePdn(buildPdn(2, 2, [background(), shadows("", { blendEnum: 42 })], 16)), /“Shadows”.*\(value 42\)/);
  // A hidden layer's blend doesn't matter.
  const hidden = buildPdn(2, 2, [background(), layer("Shadows", false, 255, "Hologram", [0, 0, 0, 255])], 16);
  assert.deepEqual([...decodePdn(hidden).data.subarray(0, 4)], [50, 100, 200, 255]);
});

/* ── Variant Builder: flattening decoded layers with another visibility ── */

/** Four layers over the measured pairs: Normal, Multiply, Glow and Xor at partial opacity. */
function variantStack(visible = [true, true, false, true]) {
  const { pairs } = BLEND_TABLE;
  const toBgra = ([r, g, b, a]) => [b, g, r, a];
  const below = Uint8Array.from(pairs.flatMap(([pixel]) => toBgra(pixel)));
  const above = Uint8Array.from(pairs.flatMap(([, pixel]) => toBgra(pixel)));
  const reversed = Uint8Array.from(pairs.toReversed().flatMap(([, pixel]) => toBgra(pixel)));
  return buildPdn(pairs.length, 1, [
    { name: "Base", visible: visible[0], opacity: 255, blend: "Normal", pixels: below },
    { name: "Shading", visible: visible[1], opacity: 200, blend: "Multiply", pixels: above },
    { name: "Glow", visible: visible[2], opacity: 128, blend: "Glow", pixels: reversed },
    { name: "Stripes", visible: visible[3], opacity: 77, blend: "Xor", pixels: below.toReversed() },
  ], 16);
}

test("flattenPdnLayers draws a variant's visibility exactly as the file would flatten with it", () => {
  const document = decodePdnLayers(variantStack());
  const same = flattenPdnLayers(document);
  assert.deepEqual([...same], [...decodePdn(variantStack()).data]);

  // The Variant Builder's visibility, not the file's: hide Shading, show Glow.
  const variant = [true, false, true, true];
  const out = flattenPdnLayers(document, (_, index) => variant[index], same);
  assert.equal(out, same, "a buffer of the right size is reused");
  assert.deepEqual([...out], [...decodePdn(variantStack(variant)).data]);
  // Nothing drawn is transparent black, not the previous variant.
  assert.ok(flattenPdnLayers(document, () => false, out).every((value) => value === 0));
});

test("an unknown blend mode is refused only when its layer is drawn, before drawing anything", () => {
  const document = decodePdnLayers(variantStack());
  document.layers[2] = { ...document.layers[2], blendMode: "Unknown", blendDetail: "HologramBlendOp" };
  const out = flattenPdnLayers(document);
  const before = [...out];
  assert.throws(() => flattenPdnLayers(document, () => true, out), /“Glow” uses an unrecognised blend mode \(HologramBlendOp\).*Normal/);
  assert.deepEqual([...out], before);
});

test("flattenPdnLayersAsync returns the layer images with the flatten (main thread without workers)", async () => {
  assert.equal(typeof Worker, "undefined");
  const document = decodePdnLayers(variantStack());
  const images = document.layers.map((pdnLayer) => pdnLayer.image);
  const visible = [true, false, true, false];
  const { images: returned, data } = await flattenPdnLayersAsync(document, visible, null);
  assert.deepEqual(returned, images);
  assert.deepEqual([...data], [...decodePdn(variantStack(visible)).data]);
});

test("0x0B bytes inside the document and out-of-order chunks don't confuse the reader", () => {
  // Width 11 writes 0x0B (the NRBF MessageEnd record type) into the document
  // several times, and the layer name contains one; chunks arrive last first.
  const pixels = new Uint8Array(11 * 4);
  for (let index = 0; index < pixels.length; index += 4) pixels.set([index, 0x0b, 255 - index, 255], index);
  const file = buildPdn(11, 1, [{ name: "\u000bTop", visible: true, opacity: 255, blend: "Normal", pixels }], 12);
  const image = decodePdn(file);
  assert.equal(image.width, 11);
  assert.deepEqual(image.layerNames, ["\u000bTop"]);
  for (let index = 0; index < pixels.length; index += 4) {
    assert.deepEqual([...image.data.subarray(index, index + 4)], [255 - index, 0x0b, index, 255]);
  }
});

test("damaged, truncated and mismatched files are errors, not guesses", () => {
  const good = buildPdn(2, 2, [layer("Background", true, 255, "Normal", [1, 2, 3, 255])], 16);

  assert.throws(() => decodePdn(good.subarray(0, good.length - 3)), /truncated/);

  const corrupt = good.slice();
  corrupt[corrupt.length - 8] ^= 0xff; // the gzip CRC of the only chunk
  assert.throws(() => decodePdn(corrupt), /damaged/);

  const wrongCount = buildPdn(2, 2, [layer("Background", true, 255, "Normal", [1, 2, 3, 255])], 16, { headerLayers: 2 });
  assert.throws(() => decodePdn(wrongCount), /does not match its header/);
  assert.throws(() => decodePdnLayers(wrongCount), /does not match its header/);

  const noWidth = good.slice();
  noWidth.set(new TextEncoder().encode("wodth"), indexOfBytes(noWidth, "width=\"2\""));
  assert.throws(() => decodePdn(noWidth), /width/);

  // Older Paint.NET files gzip the whole document after the header.
  const xmlEnd = 7 + (good[4] | (good[5] << 8) | (good[6] << 16));
  const older = good.slice();
  older[xmlEnd] = 0x1f;
  older[xmlEnd + 1] = 0x8b;
  assert.throws(() => decodePdn(older), /older compressed layout/);

  assert.equal(decodePdn(new TextEncoder().encode("PNG not a pdn")), null);
});

/* ── Which decoder a texture uses ── */

const flat = (extra = {}) => ({
  width: 1,
  height: 1,
  data: Uint8Array.from([1, 2, 3, 255]),
  layerCount: 2,
  headerLayerCount: 2,
  layerNames: ["Background", "Layer 2"],
  ...extra,
});

test("pdnDecodeProblem accepts only a decode that carries a matching layer list", () => {
  assert.equal(pdnDecodeProblem(flat()), "");
  assert.match(pdnDecodeProblem(flat({ layerCount: undefined, layerNames: undefined })), /did not read the layer list/);
  assert.match(pdnDecodeProblem(flat({ headerLayerCount: 5 })), /read 2 layers but the file lists 5/);
  assert.match(pdnDecodeProblem(flat({ layerNames: ["Background"] })), /layer names/);
  assert.match(pdnDecodeProblem(flat({ data: new Uint8Array(4) })), /fully transparent/);
  assert.match(pdnDecodeProblem(flat({ data: new Uint8Array(2) })), /truncated/);
  assert.match(pdnDecodeProblem(null), /no image/);
});

test("a JS decode that checks out is used without asking the native decoder", async () => {
  let nativeCalls = 0;
  const { source } = await selectPdnImage({
    decodeInWorker: async () => flat(),
    decodeNative: async () => { nativeCalls += 1; return flat(); },
  });
  assert.equal(source, "pdn-js-worker");
  assert.equal(nativeCalls, 0);
});

test("in the desktop app the native decoder wins over a JS decode that disagrees with the file", async () => {
  const native = { width: 1, height: 1, data: Uint8Array.from([9, 9, 9, 255]) };
  for (const workerResult of [
    flat({ headerLayerCount: 5 }), // layer count disagrees with the header
    flat({ layerCount: undefined, layerNames: undefined }), // no layer list at all
    flat({ data: new Uint8Array(4) }), // fully transparent
  ]) {
    const fallbacks = [];
    const { image, source } = await selectPdnImage({
      decodeInWorker: async () => workerResult,
      decodeNative: async () => native,
      onFallback: (reason) => fallbacks.push(reason),
    });
    assert.equal(source, "pdn-tauri");
    assert.equal(image, native);
    assert.equal(fallbacks.length, 1);
  }
});

test("a native refusal is final: no main-thread JS decode after it", async () => {
  let mainThreadCalls = 0;
  await assert.rejects(
    selectPdnImage({
      decodeInWorker: async () => { throw new Error("Layer “Shadows” uses an unrecognised blend mode (HologramBlendOp)"); },
      decodeNative: async () => { throw "Layer “Shadows” uses an unrecognised blend mode (HologramBlendOp), which the fallback decoder cannot reproduce."; },
      decodeOnMainThread: async () => { mainThreadCalls += 1; return flat(); },
    }),
    /fallback decoder cannot reproduce/,
  );
  assert.equal(mainThreadCalls, 0);
});

test("without a native decoder, the main thread retries a failed worker but not a timed-out one", async () => {
  const { source } = await selectPdnImage({
    decodeInWorker: async () => { throw new Error("PDN worker failed."); },
    decodeOnMainThread: async () => flat(),
  });
  assert.equal(source, "pdn-js");

  let mainThreadCalls = 0;
  const timeout = Object.assign(new Error("PDN worker timed out."), { code: WORKER_TIMEOUT });
  await assert.rejects(
    selectPdnImage({
      decodeInWorker: async () => { throw timeout; },
      decodeOnMainThread: async () => { mainThreadCalls += 1; return flat(); },
    }),
    /timed out/,
  );
  assert.equal(mainThreadCalls, 0);

  // No worker (null) in the browser: the main thread decodes.
  const { source: noWorker } = await selectPdnImage({
    decodeInWorker: async () => null,
    decodeOnMainThread: async () => flat(),
  });
  assert.equal(noWorker, "pdn-js");
});

/* ── Opt-in probe against a real Paint.NET file ──
   CORTEX_PDN_SAMPLE=<file.pdn> bun run test:pdn
   Compares the flattened image with the thumbnail Paint.NET stored in the
   header, when the image is small enough for the thumbnail to be full size. */

function decodeThumbnailPng(png) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (pos < png.length) {
    const length = png.readUInt32BE(pos);
    const type = png.toString("ascii", pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) return null;
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    }
    pos += 12 + length;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!bpp) return null;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const rgba = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const current = new Uint8Array(stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? current[x - bpp] : 0;
      const b = previous[x];
      const c = x >= bpp ? previous[x - bpp] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      current[x] = (line[x] + predictor) & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      for (let channel = 0; channel < bpp; channel += 1) rgba[(y * width + x) * 4 + channel] = current[x * bpp + channel];
      if (bpp === 3) rgba[(y * width + x) * 4 + 3] = 255;
    }
    previous = current;
  }
  return { width, height, rgba };
}

test("a real Paint.NET file flattens like Paint.NET's own thumbnail", { skip: !process.env.CORTEX_PDN_SAMPLE }, () => {
  const bytes = new Uint8Array(readFileSync(process.env.CORTEX_PDN_SAMPLE));
  const image = decodePdn(bytes);
  assert.equal(pdnDecodeProblem(image), "");
  const layers = decodePdnLayers(bytes).layers;
  console.log(`${image.width}x${image.height}, layers: ${layers.map((entry) => `${entry.name}${entry.visible ? "" : " (hidden)"}`).join(", ")}`);
  let visible = 0;
  for (let index = 3; index < image.data.length; index += 4) if (image.data[index]) visible += 1;
  console.log(`${visible} non-transparent pixels`);

  const headerLength = bytes[4] | (bytes[5] << 8) | (bytes[6] << 16);
  const xml = Buffer.from(bytes.subarray(7, 7 + headerLength)).toString("utf8");
  const thumbnail = /png="([^"]+)"/.exec(xml);
  const png = thumbnail ? decodeThumbnailPng(Buffer.from(thumbnail[1], "base64")) : null;
  if (!png || png.width !== image.width || png.height !== image.height) {
    console.log("No full-size thumbnail to compare with.");
    return;
  }
  let maxDifference = 0;
  for (let index = 0; index < image.data.length; index += 4) {
    const alpha = image.data[index + 3];
    assert.equal(alpha === 0, png.rgba[index + 3] === 0, `pixel ${index / 4} visibility differs from the thumbnail`);
    maxDifference = Math.max(maxDifference, Math.abs(alpha - png.rgba[index + 3]));
    if (alpha) {
      for (let channel = 0; channel < 3; channel += 1) {
        maxDifference = Math.max(maxDifference, Math.abs(image.data[index + channel] - png.rgba[index + channel]));
      }
    }
  }
  assert.ok(maxDifference <= 1, `differs from the thumbnail by up to ${maxDifference} levels`);
});

/* ── Opt-in probe against files Paint.NET wrote ──
   CORTEX_PDN_BLEND_DIR=<dir> bun run test:pdn
   Each <name>.pdn sits next to <name>.rgba, Paint.NET's own flatten of it
   (docs/fixes/p9-pdn-blend.md). Every file must match exactly. */

test("files Paint.NET wrote flatten like Paint.NET flattens them", { skip: !process.env.CORTEX_PDN_BLEND_DIR }, () => {
  const dir = process.env.CORTEX_PDN_BLEND_DIR;
  const files = readdirSync(dir).filter((name) => name.endsWith(".pdn")).sort();
  assert.ok(files.length > 0, "no .pdn files");
  for (const name of files) {
    const bytes = new Uint8Array(readFileSync(join(dir, name)));
    const image = decodePdn(bytes);
    const expected = readFileSync(join(dir, name.replace(/\.pdn$/, ".rgba")));
    assert.equal(image.data.length, expected.length, name);
    let max = 0;
    for (let index = 0; index < expected.length; index += 4) {
      let difference = Math.abs(image.data[index + 3] - expected[index + 3]);
      if (image.data[index + 3] === 0) {
        // Paint.NET may keep a colour under zero alpha. Both decoders leave
        // zeros there, so they also match each other exactly.
        assert.deepEqual([...image.data.subarray(index, index + 4)], [0, 0, 0, 0], name);
      } else {
        for (let channel = 0; channel < 3; channel += 1) {
          difference = Math.max(difference, Math.abs(image.data[index + channel] - expected[index + channel]));
        }
      }
      max = Math.max(max, difference);
    }
    console.log(`${name}: max difference ${max}`);
    assert.equal(max, 0, `${name} differs from Paint.NET`);
    // The Variant Builder's path: decode the layers, then flatten them.
    const layered = flattenPdnLayers(decodePdnLayers(bytes));
    assert.equal(Buffer.compare(Buffer.from(layered), Buffer.from(image.data)), 0, `${name}: flattenPdnLayers differs from decodePdn`);
  }
});
