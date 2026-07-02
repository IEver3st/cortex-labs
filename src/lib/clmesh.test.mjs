import test from "node:test";
import assert from "node:assert/strict";

import { parseClmesh } from "./clmesh.js";

function assertFloatArrayClose(actual, expected, epsilon = 1e-6) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => {
    assert.ok(Math.abs(value - expected[index]) <= epsilon, `value mismatch at index ${index}: expected ${expected[index]}, got ${value}`);
  });
}

function u16(value) {
  const buffer = Buffer.allocUnsafe(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function encodeString(value) {
  const text = Buffer.from(value || "", "utf8");
  return Buffer.concat([u16(text.length), text]);
}

function encodeFloatArray(values) {
  const buffer = Buffer.allocUnsafe(values.length * 4);
  values.forEach((value, index) => {
    buffer.writeFloatLE(value, index * 4);
  });
  return buffer;
}

function encodeUintArray(values) {
  const buffer = Buffer.allocUnsafe(values.length * 4);
  values.forEach((value, index) => {
    buffer.writeUInt32LE(value, index * 4);
  });
  return buffer;
}

function buildClmesh(version, meshes) {
  const chunks = [Buffer.from("CLM1", "ascii"), u16(version), u16(meshes.length)];
  for (const mesh of meshes) {
    let flags = 0;
    if (mesh.normals) flags |= 0x1;
    if (mesh.uvs) flags |= 0x2;
    if (mesh.uvs2) flags |= 0x4;
    if (mesh.uvs3) flags |= 0x8;
    if (mesh.uvs4) flags |= 0x10;

    chunks.push(
      encodeString(mesh.name),
      encodeString(mesh.materialName),
      u32(mesh.positions.length / 3),
      u32(mesh.indices.length),
      Buffer.from([flags]),
      encodeFloatArray(mesh.positions),
    );

    if (mesh.normals) chunks.push(encodeFloatArray(mesh.normals));
    if (mesh.uvs) chunks.push(encodeFloatArray(mesh.uvs));
    if (version >= 2 && mesh.uvs2) chunks.push(encodeFloatArray(mesh.uvs2));
    if (version >= 2 && mesh.uvs3) chunks.push(encodeFloatArray(mesh.uvs3));
    if (version >= 2 && mesh.uvs4) chunks.push(encodeFloatArray(mesh.uvs4));
    chunks.push(encodeUintArray(mesh.indices));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

test("parseClmesh reads version 1 payloads", () => {
  const bytes = buildClmesh(1, [{
    name: "body",
    materialName: "vehicle_paint1",
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    uvs: [0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2],
  }]);

  const [mesh] = parseClmesh(bytes);
  assert.equal(mesh.name, "body");
  assert.equal(mesh.materialName, "vehicle_paint1");
  assert.deepEqual(Array.from(mesh.positions), [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.deepEqual(Array.from(mesh.normals), [0, 0, 1, 0, 0, 1, 0, 0, 1]);
  assert.deepEqual(Array.from(mesh.uvs), [0, 0, 1, 0, 0, 1]);
  assert.equal(mesh.uvs2, null);
  assert.deepEqual(Array.from(mesh.indices), [0, 1, 2]);
});

test("parseClmesh reads version 2 extended UV payloads", () => {
  const bytes = buildClmesh(2, [{
    name: "body",
    materialName: "vehicle_paint1",
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    normals: null,
    uvs: [0, 0, 1, 0, 0, 1],
    uvs2: [0.1, 0.2, 0.9, 0.2, 0.1, 0.8],
    uvs3: [0.3, 0.4, 0.7, 0.4, 0.3, 0.6],
    uvs4: [0.5, 0.6, 0.5, 0.2, 0.8, 0.6],
    indices: [0, 1, 2],
  }]);

  const [mesh] = parseClmesh(bytes);
  assertFloatArrayClose(Array.from(mesh.uvs2), [0.1, 0.2, 0.9, 0.2, 0.1, 0.8]);
  assertFloatArrayClose(Array.from(mesh.uvs3), [0.3, 0.4, 0.7, 0.4, 0.3, 0.6]);
  assertFloatArrayClose(Array.from(mesh.uvs4), [0.5, 0.6, 0.5, 0.2, 0.8, 0.6]);
});

test("parseClmesh rejects unknown versions", () => {
  const bytes = buildClmesh(9, [{
    name: "body",
    materialName: "vehicle_paint1",
    positions: [0, 0, 0],
    indices: [0],
  }]);

  assert.throws(() => parseClmesh(bytes), /Unsupported mesh cache version 9/);
});