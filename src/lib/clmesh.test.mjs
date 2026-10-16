import test from "node:test";
import assert from "node:assert/strict";

import { parseClmesh } from "./clmesh.js";
import { buildClmeshObject, userTextureUvAttribute } from "./clmesh-object.js";

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
    if (version >= 3 && mesh.skinIndices) flags |= 0x20;

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
    if (version >= 3 && mesh.skinIndices) {
      chunks.push(Buffer.concat(mesh.skinIndices.map(u16)), Buffer.from(mesh.skinWeights));
    }
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

test("parseClmesh reads version 3 skin weights only where flagged", () => {
  const bytes = buildClmesh(3, [
    {
      name: "roof_soft",
      materialName: "vehicle_generic",
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      uvs: [0, 0, 1, 0, 0, 1],
      skinIndices: [27, 28, 0, 0, 27, 0, 0, 0, 300, 28, 0, 0],
      skinWeights: [128, 127, 0, 0, 255, 0, 0, 0, 64, 191, 0, 0],
      indices: [0, 1, 2],
    },
    {
      name: "door",
      materialName: "vehicle_paint1",
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
    },
  ]);

  const [soft, door] = parseClmesh(bytes);
  assert.deepEqual(Array.from(soft.skinIndices), [27, 28, 0, 0, 27, 0, 0, 0, 300, 28, 0, 0]);
  assert.deepEqual(Array.from(soft.skinWeights), [128, 127, 0, 0, 255, 0, 0, 0, 64, 191, 0, 0]);
  assert.deepEqual(Array.from(soft.indices), [0, 1, 2], "indices follow the skin channel");
  assert.equal(door.skinIndices, null);
  assert.equal(door.skinWeights, null);
  assert.deepEqual(Array.from(door.indices), [0, 1, 2]);
});

test("parseClmesh rejects a truncated skin channel", () => {
  const bytes = buildClmesh(3, [{
    name: "roof_soft",
    materialName: "vehicle_generic",
    positions: [0, 0, 0],
    skinIndices: [1, 2, 0, 0],
    skinWeights: [128, 127, 0, 0],
    indices: [0],
  }]);
  // Cut into the weights so neither they nor the indices fit.
  assert.throws(() => parseClmesh(bytes.subarray(0, bytes.length - 6)), /truncated/);
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

test("parseClmesh rejects indices past the vertex data", () => {
  const mesh = {
    name: "body",
    materialName: "vehicle_paint1",
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    indices: [0, 1, 2],
  };
  // The last valid index is vertexCount - 1; vertexCount itself is out of range.
  assert.equal(parseClmesh(buildClmesh(3, [mesh]))[0].indices[2], 2);
  const damaged = buildClmesh(3, [mesh, { ...mesh, name: "door", indices: [0, 1, 3] }]);
  assert.throws(() => parseClmesh(damaged), /damaged: mesh "door" has index 3 but 3 vertices/);
});

test("user textures sample V-flipped .clmesh UVs; native channels stay as authored", () => {
  const object = buildClmeshObject([{
    name: "body",
    materialName: "vehicle_paint3",
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    uvs2: new Float32Array([0.25, 0.1, 0.75, 0.1, 0.25, 0.9]),
    indices: new Uint32Array([0, 1, 2]),
  }]);
  const { geometry } = object.children[0];
  const [, livery] = geometry.userData.gtaUvSets;

  const flipped = userTextureUvAttribute(geometry, livery);
  assertFloatArrayClose(Array.from(flipped.array), [0.25, 0.9, 0.75, 0.9, 0.25, 0.1]);
  assertFloatArrayClose(Array.from(livery.array), [0.25, 0.1, 0.75, 0.1, 0.25, 0.9]);
  assert.equal(userTextureUvAttribute(geometry, livery), flipped);
  // A flipped copy left on the geometry must not flip back.
  assert.equal(userTextureUvAttribute(geometry, flipped), flipped);
  // Geometry from the JS parser already carries bottom-left UVs.
  assert.equal(userTextureUvAttribute({ userData: {} }, livery), livery);
});
