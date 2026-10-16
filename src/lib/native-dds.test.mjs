import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import {
  clampDdsMipCount,
  createBptcDdsTexture,
  createS3tcDdsTexture,
  inspectDdsCompression,
  isFullyTransparentDds,
} from "./native-dds.js";

function createBc7Dds({ width = 4, height = 4, dxgiFormat = 98, truncate = false } = {}) {
  const blockLength = Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4)) * 16;
  const buffer = new ArrayBuffer(148 + blockLength - (truncate ? 1 : 0));
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  view.setUint32(0, 0x20534444, true);
  view.setUint32(4, 124, true);
  view.setUint32(8, 0x1007, true);
  view.setUint32(12, height, true);
  view.setUint32(16, width, true);
  view.setUint32(76, 32, true);
  bytes.set(new TextEncoder().encode("DX10"), 84);
  view.setUint32(128, dxgiFormat, true);
  view.setUint32(132, 3, true);
  view.setUint32(140, 1, true);
  return buffer;
}

test("inspects DX10 BC7 compression metadata", () => {
  assert.deepEqual(inspectDdsCompression(createBc7Dds()), {
    fourCc: "DX10",
    dxgiFormat: 98,
  });
});

test("builds a GPU-ready BPTC texture without decoding RGBA", () => {
  const texture = createBptcDdsTexture(createBc7Dds({ width: 8, height: 4 }));
  assert.ok(texture?.isCompressedTexture);
  assert.equal(texture.image.width, 8);
  assert.equal(texture.image.height, 4);
  assert.equal(texture.format, THREE.RGBA_BPTC_Format);
  assert.equal(texture.mipmaps.length, 1);
  assert.equal(texture.mipmaps[0].data.byteLength, 32);
  texture.dispose();
});

test("rejects truncated BC7 payloads", () => {
  assert.equal(createBptcDdsTexture(createBc7Dds({ width: 8, height: 8, truncate: true })), null);
});

function createDxt5WithMips({ width = 8, height = 8, declared = 4, present = 3 } = {}) {
  let size = 0;
  let w = width;
  let h = height;
  for (let level = 0; level < present; level += 1) {
    size += Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * 16;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
  const buffer = new ArrayBuffer(128 + size);
  const view = new DataView(buffer);
  view.setUint32(0, 0x20534444, true);
  view.setUint32(4, 124, true);
  view.setUint32(8, 0x21007, true);
  view.setUint32(12, height, true);
  view.setUint32(16, width, true);
  view.setUint32(28, declared, true);
  view.setUint32(76, 32, true);
  view.setUint32(80, 0x4, true);
  new Uint8Array(buffer).set(new TextEncoder().encode("DXT5"), 84);
  return buffer;
}

test("clamps a declared mip count to the levels the file actually holds", () => {
  const truncated = createDxt5WithMips({ declared: 4, present: 3 });
  const clamped = clampDdsMipCount(truncated, 16);
  assert.notEqual(clamped, truncated, "the caller's buffer is not modified");
  assert.equal(new DataView(clamped).getUint32(28, true), 3);
  assert.equal(new DataView(truncated).getUint32(28, true), 4);

  const complete = createDxt5WithMips({ declared: 4, present: 4 });
  assert.equal(clampDdsMipCount(complete, 16), complete);
});

test("S3TC textures with a short mip chain load instead of throwing", () => {
  const texture = createS3tcDdsTexture(createDxt5WithMips({ declared: 4, present: 3 }), "DXT5");
  assert.ok(texture instanceof THREE.CompressedTexture);
  assert.equal(texture.mipmaps.length, 3);
});

function createDxt5Dds({ width = 4, height = 4, alpha = 0 } = {}) {
  const blocks = Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4));
  const buffer = new ArrayBuffer(128 + blocks * 16);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  view.setUint32(0, 0x20534444, true);
  view.setUint32(4, 124, true);
  view.setUint32(8, 0x1007, true);
  view.setUint32(12, height, true);
  view.setUint32(16, width, true);
  view.setUint32(76, 32, true);
  view.setUint32(80, 0x4, true);
  bytes.set(new TextEncoder().encode("DXT5"), 84);
  for (let block = 0; block < blocks; block += 1) {
    // Both alpha endpoints equal, all indices 0: every texel takes that alpha.
    bytes[128 + block * 16] = alpha;
    bytes[128 + block * 16 + 1] = alpha;
  }
  return buffer;
}

test("recognises a small fully transparent texture such as an emissive blocker", () => {
  assert.equal(isFullyTransparentDds(createDxt5Dds({ alpha: 0 })), true);
  assert.equal(isFullyTransparentDds(new Uint8Array(createDxt5Dds({ alpha: 0 }))), true);
});

test("visible or large textures are never treated as transparent", () => {
  assert.equal(isFullyTransparentDds(createDxt5Dds({ alpha: 255 })), false);
  assert.equal(isFullyTransparentDds(createDxt5Dds({ alpha: 1 })), false);
  // Not decoded at all past the probe limit.
  assert.equal(isFullyTransparentDds(createDxt5Dds({ width: 128, height: 128, alpha: 0 })), false);
  assert.equal(isFullyTransparentDds(new Uint8Array(64)), false);
});
