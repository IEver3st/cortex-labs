import test from "node:test";
import assert from "node:assert/strict";

import { decodeMatDiffuseColor, parseYft } from "./yft.js";
import {
  PED_TEST_VERTICES,
  YDD_OFFSETS,
  buildStandardPedYdd,
  buildSyntheticYdd,
  floatToHalf,
  joaat,
} from "./eup-fixtures.mjs";

test("parseYft decodes a skinned ped drawable with blend weights and indices", () => {
  // Standard GTA V ped layout 0x7755555555996996 with flags 0x405f: the
  // BlendWeights/BlendIndices (type 9, 4 bytes each) sit between position and
  // normal and must advance the stride offset.
  const bytes = buildStandardPedYdd();
  const drawable = parseYft(bytes, "uppr_000_u", { resourceType: "ydd", includeAllDrawables: true });
  assert.ok(drawable, "drawable should parse");
  assert.equal(drawable.models.length, 1);
  const mesh = drawable.models[0].meshes[0];
  assert.ok(mesh);
  assert.equal(mesh.materialName, "ped_default");
  assert.equal(mesh.positions.length, 9);
  assert.ok(mesh.normals, "normals should decode from the Float3 after blend data");
  assert.ok(mesh.uvs, "uv0 should decode");
  assert.ok(mesh.colors, "colour0 should decode");
  assert.deepEqual(Array.from(mesh.indices), [0, 1, 2]);

  PED_TEST_VERTICES.forEach((v, i) => {
    assert.ok(Math.abs(mesh.positions[i * 3] - v.pos[0]) < 1e-6);
    assert.ok(Math.abs(mesh.positions[i * 3 + 1] - v.pos[1]) < 1e-6);
    assert.ok(Math.abs(mesh.positions[i * 3 + 2] - v.pos[2]) < 1e-6);
    assert.ok(Math.abs(mesh.normals[i * 3] - v.normal[0]) < 1e-6);
    assert.ok(Math.abs(mesh.normals[i * 3 + 1] - v.normal[1]) < 1e-6);
    assert.ok(Math.abs(mesh.normals[i * 3 + 2] - v.normal[2]) < 1e-6);
    assert.ok(Math.abs(mesh.uvs[i * 2] - v.uv[0]) < 1e-6);
    assert.ok(Math.abs(mesh.uvs[i * 2 + 1] - (1 - v.uv[1])) < 1e-6, "V is flipped for three.js");
  });
  assert.ok(Math.abs(mesh.colors[0] - 0xc0 / 255) < 1e-6);
  assert.equal(drawable.drawableEntries.length, 1);
  assert.equal(drawable.drawableEntries[0].hash, joaat("uppr_000_u"));
});

test("parseYft decodes half-precision UV channels from the vertex declaration", () => {
  // P, N, C0, T0 (Half2), T1 (Half4) -> stride 40. The stride-40 fallback
  // table would misplace these, so this proves the declaration path is used.
  // nibble0 = Float3, nibble3 = Float3, nibble4 = Colour, nibble6 = Half2, nibble7 = Half4
  const bytes = buildSyntheticYdd({
    flags: 0x00d9,
    types: 0x0000000031096006n,
    stride: 40,
    vertexCount: PED_TEST_VERTICES.length,
    drawableName: "hair_000_u",
    writeVertex: (writer, base, i) => {
      const v = PED_TEST_VERTICES[i];
      writer.f32(base + 0, v.pos[0]);
      writer.f32(base + 4, v.pos[1]);
      writer.f32(base + 8, v.pos[2]);
      writer.f32(base + 12, v.normal[0]);
      writer.f32(base + 16, v.normal[1]);
      writer.f32(base + 20, v.normal[2]);
      writer.u32(base + 24, 0xffffffff);
      writer.u16(base + 28, floatToHalf(v.uv[0]));
      writer.u16(base + 30, floatToHalf(v.uv[1]));
      writer.u16(base + 32, floatToHalf(v.uv[1]));
      writer.u16(base + 34, floatToHalf(v.uv[0]));
      writer.u16(base + 36, 0);
      writer.u16(base + 38, 0);
    },
  });

  const drawable = parseYft(bytes, "hair_000_u", { resourceType: "ydd" });
  assert.ok(drawable);
  const mesh = drawable.models[0].meshes[0];
  assert.ok(mesh.uvs && mesh.uvs2);
  PED_TEST_VERTICES.forEach((v, i) => {
    assert.ok(Math.abs(mesh.uvs[i * 2] - v.uv[0]) < 1e-3);
    assert.ok(Math.abs(mesh.uvs[i * 2 + 1] - (1 - v.uv[1])) < 1e-3);
    assert.ok(Math.abs(mesh.uvs2[i * 2] - v.uv[1]) < 1e-3);
    assert.ok(Math.abs(mesh.uvs2[i * 2 + 1] - (1 - v.uv[0])) < 1e-3);
    assert.ok(Math.abs(mesh.normals[i * 3 + 2] - v.normal[2]) < 1e-6);
  });
});

test("parseYft rejects truncated ped data instead of fabricating geometry", () => {
  const bytes = buildStandardPedYdd();
  const truncated = bytes.subarray(0, YDD_OFFSETS.vertexData + 30);
  const drawable = parseYft(truncated, "uppr_000_u", { resourceType: "ydd" });
  assert.equal(drawable, null);
});

test("ped skeleton pointers address the first bone and include parent zero", () => {
  const source = buildStandardPedYdd();
  const bytes = new Uint8Array(source.length + 320);
  bytes.set(source);
  const view = new DataView(bytes.buffer);
  const skeleton = source.length;
  const bones = skeleton + 112;
  view.setBigUint64(YDD_OFFSETS.drawable + 0x18, BigInt(0x50000000 + skeleton), true);
  view.setBigUint64(skeleton + 0x20, BigInt(0x50000000 + bones), true);
  view.setUint16(skeleton + 0x5e, 2, true);
  for (let i = 0; i < 2; i++) {
    const bone = bones + i * 80;
    view.setFloat32(bone + 0x0c, 1, true);
    view.setFloat32(bone + 0x18, i === 0 ? 1 : 0.6, true);
    view.setUint16(bone + 0x32, i === 0 ? 0xffff : 0, true);
    view.setUint16(bone + 0x44, i === 0 ? 0 : 0x796e, true);
  }
  const parsed = parseYft(bytes, "head_000_r", { resourceType: "ydd" });
  assert.equal(parsed.skeleton.bones[1].tag, 0x796e);
  assert.ok(Math.abs(parsed.skeleton.bones[1].worldTz - 1.6) < 1e-6);
  // Malformed bone count cannot read past the resource.
  view.setUint16(skeleton + 0x5e, 256, true);
  assert.equal(parseYft(bytes, "head_000_r", { resourceType: "ydd" }).skeleton, null);
});

test("parseYft keeps ped skin weights and maps blend indices through the geometry bone ids", () => {
  // The standard fixture weights the fourth influence fully (bytes 0,0,0,255)
  // with blend indices 1,2,3,4 into the geometry's matrix palette.
  const bytes = buildStandardPedYdd({ boneIds: [40, 41, 42, 43, 44] });
  const mesh = parseYft(bytes, "uppr_000_u", { resourceType: "ydd", includeAllDrawables: true }).models[0].meshes[0];
  assert.ok(mesh.skinIndices instanceof Uint16Array);
  assert.deepEqual(Array.from(mesh.skinIndices.slice(0, 4)), [41, 42, 43, 44]);
  assert.deepEqual(Array.from(mesh.skinWeights.slice(0, 4)), [0, 0, 0, 1]);
  assert.equal(mesh.skinWeights.length, PED_TEST_VERTICES.length * 4);

  const raw = parseYft(buildStandardPedYdd(), "uppr_000_u", { resourceType: "ydd", includeAllDrawables: true }).models[0].meshes[0];
  assert.deepEqual(Array.from(raw.skinIndices.slice(0, 4)), [1, 2, 3, 4], "without bone ids the palette index is the bone index");
});

test("parseYft drops skin data whose palette index falls outside the bone ids", () => {
  const bytes = buildStandardPedYdd({ boneIds: [7, 8, 9] });
  const mesh = parseYft(bytes, "uppr_000_u", { resourceType: "ydd", includeAllDrawables: true }).models[0].meshes[0];
  assert.equal(mesh.positions.length, 9, "geometry still parses");
  assert.equal(mesh.skinIndices, null);
  assert.equal(mesh.skinWeights, null);
});

test("matDiffuseColor (2, layer, 0) selects a paint layer; anything else is a fixed colour", () => {
  assert.deepEqual(decodeMatDiffuseColor([2, 1, 0, 0]), { paintLayer: 1, diffuseColor: null });
  assert.deepEqual(decodeMatDiffuseColor([2, 7, 0, 0]), { paintLayer: 7, diffuseColor: null });
  assert.deepEqual(decodeMatDiffuseColor([2, 8, 0, 0]), { paintLayer: null, diffuseColor: [2, 8, 0, 0] });
  assert.deepEqual(decodeMatDiffuseColor([2, 1.5, 0, 0]), { paintLayer: null, diffuseColor: [2, 1.5, 0, 0] });
  assert.deepEqual(decodeMatDiffuseColor([0.8, 0.8, 0.8, 0]), { paintLayer: null, diffuseColor: [0.8, 0.8, 0.8, 0] });
  assert.deepEqual(decodeMatDiffuseColor(null), { paintLayer: null, diffuseColor: null });
  assert.deepEqual(decodeMatDiffuseColor([2, NaN, 0, 0]), { paintLayer: null, diffuseColor: null });
});
