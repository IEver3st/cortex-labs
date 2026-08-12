import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import {
  createBptcDdsTexture,
  inspectDdsCompression,
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
