import test from "node:test";
import assert from "node:assert/strict";
import pako from "pako";

import { decodePdn, __pdnTest } from "./pdn.js";

function writeU32BE(value) {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

function writeChunk(chunkNumber, rawBytes) {
  const payload = pako.gzip(rawBytes);
  return [
    ...writeU32BE(chunkNumber),
    ...writeU32BE(payload.length),
    ...payload,
  ];
}

function buildFalsePositivePdn(options = {}) {
  const width = 4;
  const height = 1;
  const expectedLength = width * height * 4;
  const actualChunkSize = options.actualChunkSize || expectedLength;
  const xml = `<pdnImage width="${width}" height="${height}" layers="1"></pdnImage>`;
  const xmlBytes = new TextEncoder().encode(xml);
  const headerEnd = 7 + xmlBytes.length;
  const falseStart = headerEnd + 2 + 1;

  const falseCandidate = [
    0x0b,
    0x00,
    ...writeU32BE(4),
    ...writeU32BE(1),
    ...writeU32BE(0),
    0x55,
    0x55,
    0x55,
    0x55,
  ];

  const layerBytes = Uint8Array.from([
    0x33, 0x22, 0x11, 0xff,
    0x66, 0x55, 0x44, 0xff,
    0x99, 0x88, 0x77, 0xff,
    0xcc, 0xbb, 0xaa, 0xff,
  ]);
  const expectedRgba = Uint8Array.from([
    0x11, 0x22, 0x33, 0xff,
    0x44, 0x55, 0x66, 0xff,
    0x77, 0x88, 0x99, 0xff,
    0xaa, 0xbb, 0xcc, 0xff,
  ]);

  const actualChunks = [];
  for (let offset = 0, chunkNumber = 0; offset < layerBytes.length; offset += actualChunkSize, chunkNumber += 1) {
    actualChunks.push(
      ...writeChunk(
        chunkNumber,
        layerBytes.subarray(offset, Math.min(offset + actualChunkSize, layerBytes.length)),
      ),
    );
  }

  const actualStart = headerEnd + 2 + falseCandidate.length + 4 + 1;

  const bytes = Uint8Array.from([
    0x50, 0x44, 0x4e, 0x33,
    xmlBytes.length & 0xff,
    (xmlBytes.length >>> 8) & 0xff,
    (xmlBytes.length >>> 16) & 0xff,
    ...xmlBytes,
    0x00, 0x01,
    ...falseCandidate,
    0x99, 0x99, 0x99, 0x99,
    0x0b,
    0x00,
    ...writeU32BE(actualChunkSize),
    ...actualChunks,
  ]);

  return {
    bytes,
    width,
    height,
    expectedLength,
    expectedRgba,
    headerEnd,
    falseStart,
    actualStart,
  };
}

test("findChunkedDataStart skips false NRBF candidates and picks the real layer stream", () => {
  const fixture = buildFalsePositivePdn();

  assert.equal(typeof __pdnTest?.findChunkedDataStart, "function");

  const detected = __pdnTest.findChunkedDataStart(
    fixture.bytes,
    fixture.headerEnd,
    fixture.expectedLength,
  );

  assert.equal(detected, fixture.actualStart);
});

test("readLayerChunkedData rejects invalid candidate chunk headers", () => {
  const fixture = buildFalsePositivePdn();

  assert.equal(typeof __pdnTest?.readLayerChunkedData, "function");

  const invalidStart = 7 + new TextEncoder().encode(`<pdnImage width="${fixture.width}" height="${fixture.height}" layers="1"></pdnImage>`).length + 2 + 1;
  const result = __pdnTest.readLayerChunkedData(
    fixture.bytes,
    fixture.falseStart,
    fixture.expectedLength,
  );

  assert.equal(result, null);
});

test("decodePdn fast path decodes a PDN with an early false chunked-data marker", () => {
  const fixture = buildFalsePositivePdn();
  const result = decodePdn(fixture.bytes, { fast: true });

  assert.ok(result);
  assert.equal(result.width, fixture.width);
  assert.equal(result.height, fixture.height);
  assert.equal(result.data.length, fixture.expectedLength);
  assert.deepEqual(Array.from(result.data), Array.from(fixture.expectedRgba));
});

test("decodePdn fast path handles multi-chunk gzip layers after a false marker", () => {
  const fixture = buildFalsePositivePdn({ actualChunkSize: 8 });
  const result = decodePdn(fixture.bytes, { fast: true });

  assert.ok(result);
  assert.equal(result.width, fixture.width);
  assert.equal(result.height, fixture.height);
  assert.equal(result.data.length, fixture.expectedLength);
  assert.deepEqual(Array.from(result.data), Array.from(fixture.expectedRgba));
});
