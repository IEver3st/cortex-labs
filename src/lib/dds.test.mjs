import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  MIP_DECODE_THRESHOLD,
  getCompressedTextureSupport,
  parseDDS,
  parseDDSAsync,
  parseDDSHeader,
  selectCompressedFormat,
  shouldDecodeMipChain,
} from "./dds.js";
import { decodeDDSLevels, describeDdsPixelFormat, readCompressedMipmaps } from "./dds-decode.js";

const DDSD_MIPMAPCOUNT = 0x20000;

function fourCC(str) {
  return str.charCodeAt(0) | (str.charCodeAt(1) << 8) | (str.charCodeAt(2) << 16) | (str.charCodeAt(3) << 24);
}

function buildDxt1(width, height, mipCount) {
  let payload = 0;
  let w = width, h = height;
  for (let i = 0; i < mipCount; i += 1) {
    payload += Math.ceil(w / 4) * Math.ceil(h / 4) * 8;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
  const buffer = new ArrayBuffer(128 + payload);
  const view = new DataView(buffer);
  view.setUint32(0, 0x20534444, true);
  view.setUint32(4, 124, true);
  view.setUint32(8, mipCount > 1 ? DDSD_MIPMAPCOUNT : 0, true);
  view.setUint32(12, height, true);
  view.setUint32(16, width, true);
  view.setUint32(28, mipCount, true);
  view.setUint32(76, 32, true);
  view.setUint32(80, 0x4, true);
  view.setUint32(84, fourCC("DXT1"), true);
  // Solid white block: c0 = c1 = 0xFFFF, indices 0.
  const bytes = new Uint8Array(buffer);
  for (let offset = 128; offset < buffer.byteLength; offset += 8) {
    bytes[offset] = 0xff; bytes[offset + 1] = 0xff; bytes[offset + 2] = 0xff; bytes[offset + 3] = 0xff;
  }
  return buffer;
}

function fakeRenderer(extensions) {
  return { extensions: { has: (name) => extensions.includes(name) } };
}

test("compressed format selection follows renderer support", () => {
  const all = { s3tc: true, bptc: true, rgtc: true };
  assert.equal(selectCompressedFormat("DXT1", all), THREE.RGBA_S3TC_DXT1_Format);
  assert.equal(selectCompressedFormat("DXT3", all), THREE.RGBA_S3TC_DXT3_Format);
  assert.equal(selectCompressedFormat("DXT5", all), THREE.RGBA_S3TC_DXT5_Format);
  assert.equal(selectCompressedFormat("BC7", all), THREE.RGBA_BPTC_Format);
  assert.equal(selectCompressedFormat("DXT5", { s3tc: false, bptc: true }), null);
  assert.equal(selectCompressedFormat("BC7", { s3tc: true, bptc: false }), null);
  assert.equal(selectCompressedFormat("BC5", all), null, "BC4/BC5 keep the decode path");
  assert.equal(selectCompressedFormat("BGRA", all), null);
});

test("renderer extension probing is defensive", () => {
  assert.deepEqual(getCompressedTextureSupport(null), { s3tc: false, bptc: false, rgtc: false });
  assert.deepEqual(
    getCompressedTextureSupport(fakeRenderer(["WEBGL_compressed_texture_s3tc"])),
    { s3tc: true, bptc: false, rgtc: false },
  );
});

test("mip chain decode is gated on texture size", () => {
  assert.equal(shouldDecodeMipChain(MIP_DECODE_THRESHOLD, MIP_DECODE_THRESHOLD), false);
  assert.equal(shouldDecodeMipChain(MIP_DECODE_THRESHOLD + 1, 4), true);
  assert.equal(shouldDecodeMipChain(0, 0), false);
});

test("header parse validates magic, size and base-level length", () => {
  const good = buildDxt1(8, 8, 2);
  const header = parseDDSHeader(good);
  assert.equal(header.fmt, "DXT1");
  assert.equal(header.width, 8);
  assert.equal(header.mipMapCount, 2);
  assert.equal(header.dataOffset, 128);

  const truncated = good.slice(0, 128 + 8);
  assert.equal(parseDDSHeader(truncated), null, "base level must fit");
  const badMagic = good.slice(0);
  new DataView(badMagic).setUint32(0, 0, true);
  assert.equal(parseDDSHeader(badMagic), null);
  assert.equal(parseDDSHeader(new ArrayBuffer(16)), null);
});

test("raw mip extraction stops at truncated levels", () => {
  const full = buildDxt1(8, 8, 3);
  const header = parseDDSHeader(full);
  assert.equal(readCompressedMipmaps(full, header).length, 3);
  const missingLast = full.slice(0, full.byteLength - 8);
  assert.equal(readCompressedMipmaps(missingLast, parseDDSHeader(missingLast)).length, 2);
});

test("decoded levels honour the decodeMips flag", () => {
  const buffer = buildDxt1(8, 8, 3);
  const withMips = decodeDDSLevels(buffer, { decodeMips: true });
  assert.equal(withMips.levels.length, 3);
  assert.deepEqual([...withMips.levels[0].data.subarray(0, 4)], [255, 255, 255, 255]);
  const baseOnly = decodeDDSLevels(buffer, { decodeMips: false });
  assert.equal(baseOnly.levels.length, 1);
});

test("decoded mip uploads include the full-resolution level at index zero", () => {
  const texture = parseDDS(buildDxt1(8, 8, 3), { log: false, decodeMips: true });
  assert.deepEqual(texture.mipmaps.map(({ width, height }) => [width, height]), [[8, 8], [4, 4], [2, 2]]);
  assert.equal(texture.mipmaps[0].data, texture.image.data);
});

test("parseDDS returns a compressed texture only when the renderer supports it", () => {
  const buffer = buildDxt1(8, 8, 2);
  const compressed = parseDDS(buffer, { log: false, renderer: fakeRenderer(["WEBGL_compressed_texture_s3tc"]) });
  assert.equal(compressed.isCompressedTexture, true);
  assert.equal(compressed.format, THREE.RGBA_S3TC_DXT1_Format);
  assert.equal(compressed.colorSpace, THREE.SRGBColorSpace);
  assert.equal(compressed.flipY, false);
  assert.equal(compressed.repeat.y, -1, "flip is applied through the UV transform");
  assert.equal(compressed.offset.y, 1);
  assert.equal(compressed.mipmaps.length, 2);

  const decoded = parseDDS(buffer, { log: false, renderer: fakeRenderer([]) });
  assert.equal(decoded.isDataTexture, true);
  assert.equal(decoded.colorSpace, THREE.SRGBColorSpace);
  assert.equal(decoded.generateMipmaps, true, "small textures get GPU mips");
  assert.equal(decoded.userData.ddsDecoded, true);

  const legacy = parseDDS(buffer, { log: false });
  assert.equal(legacy.isDataTexture, true);
});

/* Uncompressed textures are described by channel masks (legacy header) or a
   DXGI code (DX10 header); GTA exports use both. One 1x1 pixel each. */
function buildUncompressed({ flags, bitCount, masks = [0, 0, 0, 0], pixel, dxgi = null }) {
  const headerBytes = dxgi === null ? 128 : 148;
  const buffer = new ArrayBuffer(headerBytes + pixel.length);
  const view = new DataView(buffer);
  view.setUint32(0, 0x20534444, true);
  view.setUint32(4, 124, true);
  view.setUint32(12, 1, true);
  view.setUint32(16, 1, true);
  view.setUint32(76, 32, true);
  if (dxgi === null) {
    view.setUint32(80, flags, true);
    view.setUint32(88, bitCount, true);
    masks.forEach((mask, index) => view.setUint32(92 + index * 4, mask, true));
  } else {
    view.setUint32(80, 0x4, true);
    view.setUint32(84, fourCC("DX10"), true);
    view.setUint32(128, dxgi, true);
    view.setUint32(132, 3, true);
  }
  new Uint8Array(buffer).set(pixel, headerBytes);
  return buffer;
}

function firstPixel(buffer) {
  const decoded = decodeDDSLevels(buffer, { decodeMips: false });
  assert.ok(decoded, "texture should decode");
  return Array.from(decoded.levels[0].data.subarray(0, 4));
}

test("legacy 32-bit textures follow their channel masks, not a fixed BGRA order", () => {
  // A8B8G8R8: bytes are R, G, B, A.
  const abgr = buildUncompressed({ flags: 0x41, bitCount: 32, masks: [0xff, 0xff00, 0xff0000, 0xff000000], pixel: [10, 20, 30, 40] });
  assert.deepEqual(firstPixel(abgr), [10, 20, 30, 40]);
  // A8R8G8B8: bytes are B, G, R, A.
  const argb = buildUncompressed({ flags: 0x41, bitCount: 32, masks: [0xff0000, 0xff00, 0xff, 0xff000000], pixel: [10, 20, 30, 40] });
  assert.deepEqual(firstPixel(argb), [30, 20, 10, 40]);
});

test("legacy 16-bit and alpha-only textures decode instead of failing", () => {
  const r5g6b5 = buildUncompressed({ flags: 0x40, bitCount: 16, masks: [0xf800, 0x07e0, 0x001f, 0], pixel: [0x00, 0xf8] });
  assert.deepEqual(firstPixel(r5g6b5), [255, 0, 0, 255]);
  const a1r5g5b5 = buildUncompressed({ flags: 0x41, bitCount: 16, masks: [0x7c00, 0x03e0, 0x001f, 0x8000], pixel: [0x1f, 0x80] });
  assert.deepEqual(firstPixel(a1r5g5b5), [0, 0, 255, 255]);
  const a8 = buildUncompressed({ flags: 0x2, bitCount: 8, masks: [0, 0, 0, 0xff], pixel: [128] });
  assert.deepEqual(firstPixel(a8), [0, 0, 0, 128], "D3D samples A8 as black with alpha");
  const l8 = buildUncompressed({ flags: 0x20000, bitCount: 8, masks: [0xff, 0, 0, 0], pixel: [77] });
  assert.deepEqual(firstPixel(l8), [77, 77, 77, 255]);
});

test("DX10 uncompressed formats from GTA exports decode", () => {
  assert.deepEqual(firstPixel(buildUncompressed({ dxgi: 65, pixel: [200] })), [0, 0, 0, 200]);
  assert.deepEqual(firstPixel(buildUncompressed({ dxgi: 85, pixel: [0x1f, 0x00] })), [0, 0, 255, 255]);
  assert.deepEqual(firstPixel(buildUncompressed({ dxgi: 86, pixel: [0x00, 0xfc] })), [255, 0, 0, 255]);
  assert.deepEqual(firstPixel(buildUncompressed({ dxgi: 49, pixel: [255, 0] })), [255, 0, 0, 255]);
});

test("decoded rows flip for image uploads but keep file order for native game UVs", async () => {
  // 1x2 A8B8G8R8: red top row, blue bottom row, as stored in the file.
  const buffer = buildUncompressed({
    flags: 0x41,
    bitCount: 32,
    masks: [0xff, 0xff00, 0xff0000, 0xff000000],
    pixel: [255, 0, 0, 255, 0, 0, 255, 255],
  });
  new DataView(buffer).setUint32(12, 2, true);
  const rows = (decoded) => [
    Array.from(decoded.levels[0].data.subarray(0, 4)),
    Array.from(decoded.levels[0].data.subarray(4, 8)),
  ];
  const red = [255, 0, 0, 255];
  const blue = [0, 0, 255, 255];
  assert.deepEqual(rows(decodeDDSLevels(buffer, { decodeMips: false })), [blue, red]);
  assert.deepEqual(rows(decodeDDSLevels(buffer, { decodeMips: false, flipY: false })), [red, blue]);
  // parseDDSAsync decodes on the main thread here (no Worker in Node) and
  // must pass the native orientation through.
  const texture = await parseDDSAsync(buffer, { log: false, flipY: false });
  assert.deepEqual(Array.from(texture.image.data.subarray(0, 4)), red);
});

test("unsupported formats are named in error descriptions", () => {
  assert.equal(describeDdsPixelFormat(buildUncompressed({ dxgi: 95, pixel: [0] })), "BC6H_UF16 (DXGI 95)");
  assert.equal(parseDDSHeader(buildUncompressed({ dxgi: 95, pixel: [0] })), null);
  assert.equal(describeDdsPixelFormat(new ArrayBuffer(16)), "truncated header");
});
