// Synthetic ped asset builders shared by the yft and ped-assembly tests.
// Produces uncompressed system-segment ydd bytes and a tiny BGRA DDS.

const PTR = 0x50000000;

export function joaat(input) {
  const str = input.toLowerCase();
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash += str.charCodeAt(i);
    hash = (hash + (hash << 10)) >>> 0;
    hash ^= hash >>> 6;
  }
  hash = (hash + (hash << 3)) >>> 0;
  hash ^= hash >>> 11;
  hash = (hash + (hash << 15)) >>> 0;
  return hash >>> 0;
}

export function floatToHalf(value) {
  const floatView = new Float32Array(1);
  const intView = new Uint32Array(floatView.buffer);
  floatView[0] = value;
  const x = intView[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = ((x >>> 23) & 0xff) - 127 + 15;
  const mant = x & 0x7fffff;
  if (exp <= 0) return sign;
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | (mant >>> 13);
}

class Writer {
  constructor(size) {
    this.buffer = Buffer.alloc(size);
  }
  u8(offset, value) { this.buffer.writeUInt8(value, offset); }
  u16(offset, value) { this.buffer.writeUInt16LE(value, offset); }
  u32(offset, value) { this.buffer.writeUInt32LE(value >>> 0, offset); }
  u64(offset, value) { this.buffer.writeBigUInt64LE(BigInt(value), offset); }
  f32(offset, value) { this.buffer.writeFloatLE(value, offset); }
  ptr(offset, target) { this.u64(offset, PTR | target); }
}

export const YDD_OFFSETS = Object.freeze({
  dict: 0x000,
  hashes: 0x040,
  drawablePtrs: 0x050,
  drawable: 0x060,
  shaderGroup: 0x110,
  shaderPtrs: 0x150,
  shader: 0x160,
  modelsArray: 0x190,
  modelPtrs: 0x1a0,
  model: 0x1b0,
  geometryPtrs: 0x1e0,
  shaderMapping: 0x1e8,
  geometry: 0x1f0,
  vertexBuffer: 0x290,
  vertexDecl: 0x2d0,
  indexBuffer: 0x2e0,
  indexData: 0x300,
  vertexData: 0x310,
});

export const PED_TEST_VERTICES = Object.freeze([
  { pos: [0.1, -0.2, 0.3], normal: [0, 0, 1], uv: [0.25, 0.75] },
  { pos: [1.5, 0.0, -0.75], normal: [1, 0, 0], uv: [0.5, 0.5] },
  { pos: [-0.4, 0.9, 1.8], normal: [0, 1, 0], uv: [0.0, 1.0] },
]);

export function buildSyntheticYdd({
  flags,
  types,
  stride,
  vertexCount,
  writeVertex,
  shaderName = "ped_default",
  drawableName = "uppr_000_u",
  boneIds = null,
}) {
  const OFF = YDD_OFFSETS;
  const boneIdsOffset = OFF.vertexData + stride * vertexCount + 16;
  const writer = new Writer(boneIdsOffset + (boneIds ? boneIds.length * 2 : 0) + 64);

  writer.ptr(OFF.dict + 0x20, OFF.hashes);
  writer.u16(OFF.dict + 0x28, 1);
  writer.ptr(OFF.dict + 0x30, OFF.drawablePtrs);
  writer.u16(OFF.dict + 0x38, 1);
  writer.u32(OFF.hashes, joaat(drawableName));
  writer.ptr(OFF.drawablePtrs, OFF.drawable);

  writer.ptr(OFF.drawable + 0x10, OFF.shaderGroup);
  writer.ptr(OFF.drawable + 0x50, OFF.modelsArray);

  writer.ptr(OFF.shaderGroup + 0x10, OFF.shaderPtrs);
  writer.u16(OFF.shaderGroup + 0x18, 1);
  writer.ptr(OFF.shaderPtrs, OFF.shader);
  writer.u32(OFF.shader + 0x08, joaat(shaderName));

  writer.ptr(OFF.modelsArray, OFF.modelPtrs);
  writer.u16(OFF.modelsArray + 0x08, 1);
  writer.ptr(OFF.modelPtrs, OFF.model);

  writer.ptr(OFF.model + 0x08, OFF.geometryPtrs);
  writer.u16(OFF.model + 0x10, 1);
  writer.ptr(OFF.model + 0x20, OFF.shaderMapping);
  // Skinned ped model: HasSkin byte set, bone index 0.
  writer.u32(OFF.model + 0x28, 0x00000100);
  writer.ptr(OFF.geometryPtrs, OFF.geometry);
  writer.u16(OFF.shaderMapping, 0);

  writer.ptr(OFF.geometry + 0x18, OFF.vertexBuffer);
  writer.ptr(OFF.geometry + 0x38, OFF.indexBuffer);
  writer.u16(OFF.geometry + 0x60, vertexCount);
  writer.u16(OFF.geometry + 0x70, stride);
  if (boneIds) {
    // Geometry matrix palette: blend index -> skeleton bone index.
    writer.ptr(OFF.geometry + 0x68, boneIdsOffset);
    writer.u16(OFF.geometry + 0x72, boneIds.length);
    boneIds.forEach((id, i) => writer.u16(boneIdsOffset + i * 2, id));
  }

  writer.u16(OFF.vertexBuffer + 0x08, stride);
  writer.ptr(OFF.vertexBuffer + 0x10, OFF.vertexData);
  writer.u32(OFF.vertexBuffer + 0x18, vertexCount);
  writer.ptr(OFF.vertexBuffer + 0x30, OFF.vertexDecl);

  writer.u32(OFF.vertexDecl + 0x00, flags);
  writer.u16(OFF.vertexDecl + 0x04, stride);
  writer.u8(OFF.vertexDecl + 0x07, 1);
  writer.u64(OFF.vertexDecl + 0x08, types);

  writer.u32(OFF.indexBuffer + 0x08, 3);
  writer.ptr(OFF.indexBuffer + 0x10, OFF.indexData);
  writer.u16(OFF.indexData + 0, 0);
  writer.u16(OFF.indexData + 2, 1);
  writer.u16(OFF.indexData + 4, 2);

  for (let i = 0; i < vertexCount; i++) {
    writeVertex(writer, OFF.vertexData + i * stride, i);
  }

  return new Uint8Array(writer.buffer);
}

// Standard GTA V ped layout: P, BW, BI, N, C0, T0, Tangent0 -> stride 60.
export function buildStandardPedYdd(options = {}) {
  return buildSyntheticYdd({
    flags: 0x405f,
    types: 0x7755555555996996n,
    stride: 60,
    vertexCount: PED_TEST_VERTICES.length,
    writeVertex: (writer, base, i) => {
      const v = PED_TEST_VERTICES[i];
      writer.f32(base + 0, v.pos[0]);
      writer.f32(base + 4, v.pos[1]);
      writer.f32(base + 8, v.pos[2]);
      writer.u32(base + 12, 0xff000000);
      writer.u32(base + 16, 0x04030201);
      writer.f32(base + 20, v.normal[0]);
      writer.f32(base + 24, v.normal[1]);
      writer.f32(base + 28, v.normal[2]);
      writer.u32(base + 32, 0xff8040c0);
      writer.f32(base + 36, v.uv[0]);
      writer.f32(base + 40, v.uv[1]);
      writer.f32(base + 44, 1);
      writer.f32(base + 48, 0);
      writer.f32(base + 52, 0);
      writer.f32(base + 56, 1);
    },
    ...options,
  });
}

// 2x2 uncompressed BGRA DDS (DDPF_RGB, 32bpp), no mipmaps.
export function buildSyntheticDds({ width = 2, height = 2 } = {}) {
  const header = Buffer.alloc(128);
  header.writeUInt32LE(0x20534444, 0); // "DDS "
  header.writeUInt32LE(124, 4);
  header.writeUInt32LE(0x1 | 0x2 | 0x4 | 0x1000, 8);
  header.writeUInt32LE(height, 12);
  header.writeUInt32LE(width, 16);
  header.writeUInt32LE(width * 4, 20);
  header.writeUInt32LE(32, 76); // pixel format size
  header.writeUInt32LE(0x40 | 0x1, 80); // DDPF_RGB | DDPF_ALPHAPIXELS
  header.writeUInt32LE(32, 88);
  header.writeUInt32LE(0x00ff0000, 92);
  header.writeUInt32LE(0x0000ff00, 96);
  header.writeUInt32LE(0x000000ff, 100);
  header.writeUInt32LE(0xff000000, 104);
  header.writeUInt32LE(0x1000, 108); // DDSCAPS_TEXTURE
  const pixels = Buffer.alloc(width * height * 4, 0x80);
  return new Uint8Array(Buffer.concat([header, pixels]));
}
