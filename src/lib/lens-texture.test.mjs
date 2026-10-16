import test from "node:test";
import assert from "node:assert/strict";
import { decodeDDSLevels, parseDDSHeader, readCompressedMipmaps } from "./dds-decode.js";
import { encodeDxt5, mipLevelSizes, writeDds } from "./dds-encode.js";
import {
  collectDiffuseUsers,
  forEachCoveredTexel,
  planLensTextures,
  rasterizeLensOwners,
  recolourLensTexture,
  siblingYtdNames,
} from "./lens-texture.js";

function image(width, height, pick) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data.set(pick(x, y), (y * width + x) * 4);
  }
  return data;
}

function at(data, width, x, y) {
  return Array.from(data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4));
}

// A quad over u0..u1, v0..v1 as two triangles.
function quad(u0, v0, u1, v1) {
  return {
    uvs: new Float32Array([u0, v0, u1, v0, u1, v1, u0, v1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

function covered(width, height, mesh) {
  const texels = new Set();
  forEachCoveredTexel(width, height, mesh.uvs, mesh.indices, (texel) => texels.add(texel));
  return texels;
}

// A DXT5 file with its full mip chain, each level `pick` scaled down.
function dxt5File(width, height, pick, levels = mipLevelSizes(width, height, 32).length) {
  const sizes = mipLevelSizes(width, height, levels);
  return writeDds({
    format: "DXT5",
    width,
    height,
    levels: sizes.map((size) => encodeDxt5(
      image(size.width, size.height, (x, y) => pick(Math.floor((x * width) / size.width), Math.floor((y * height) / size.height))),
      size.width,
      size.height,
    )),
  });
}

test("sibling texture dictionaries follow the bridge's naming", () => {
  assert.deepEqual(siblingYtdNames("C:/res/stream/GSDSS24Explorer_hi.yft"), ["GSDSS24Explorer_hi.ytd", "GSDSS24Explorer+hi.ytd", "GSDSS24Explorer.ytd"]);
  assert.deepEqual(siblingYtdNames("car+hi.yft"), ["car+hi.ytd", "car_hi.ytd", "car.ytd"]);
  assert.deepEqual(siblingYtdNames("C:\\res\\police.yft"), ["police.ytd", "police+hi.ytd"]);
  assert.deepEqual(siblingYtdNames(""), []);
});

test("DXT5 keeps solid colours, alpha extremes and partial edge blocks", () => {
  const width = 6;
  const height = 5;
  const source = image(width, height, (x, y) => (x < 3 ? [200, 30, 10, y === 0 ? 0 : 255] : [10, 40, 220, 255]));
  const blocks = encodeDxt5(source, width, height);
  assert.equal(blocks.length, 2 * 2 * 16);
  const decoded = decodeDDSLevels(writeDds({ format: "DXT5", width, height, levels: [blocks] }), { flipY: false });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = at(decoded.levels[0].data, width, x, y);
      const [er, eg, eb, ea] = at(source, width, x, y);
      assert.ok(Math.abs(r - er) <= 8 && Math.abs(g - eg) <= 8 && Math.abs(b - eb) <= 8, `texel ${x},${y}: ${[r, g, b]}`);
      assert.equal(a, ea, "fully clear and fully opaque alpha survive exactly");
    }
  }
  // Four-colour mode: c0 > c1 in every block that has two endpoints.
  for (let offset = 8; offset < blocks.length; offset += 16) {
    const c0 = blocks[offset] | (blocks[offset + 1] << 8);
    const c1 = blocks[offset + 2] | (blocks[offset + 3] << 8);
    assert.ok(c0 >= c1);
  }
});

test("DXT5 follows a gradient and keeps blocks it is told to keep", () => {
  const width = 16;
  const source = image(width, 4, (x) => [x * 16, 255 - x * 16, 128, 255]);
  const decoded = decodeDDSLevels(writeDds({ format: "DXT5", width, height: 4, levels: [encodeDxt5(source, width, 4)] }), { flipY: false });
  for (let x = 0; x < width; x += 1) {
    const [r, g] = at(decoded.levels[0].data, width, x, 1);
    assert.ok(Math.abs(r - x * 16) <= 12 && Math.abs(g - (255 - x * 16)) <= 12, `x ${x}: ${r},${g}`);
  }
  const kept = new Uint8Array(16).fill(7);
  const blocks = encodeDxt5(source, width, 4, { reuse: (index) => (index === 2 ? kept : null) });
  assert.deepEqual(Array.from(blocks.subarray(32, 48)), Array.from(kept));
  assert.throws(() => encodeDxt5(source, width, 5), /16x5 RGBA/);
});

test("DDS files carry their size, format and mip chain, and reject bad levels", () => {
  const file = dxt5File(8, 4, () => [255, 0, 0, 255]);
  const header = parseDDSHeader(file);
  assert.equal(header.fmt, "DXT5");
  assert.equal(header.width, 8);
  assert.equal(header.height, 4);
  assert.equal(header.mipMapCount, 4);
  assert.deepEqual(readCompressedMipmaps(file, header).map((level) => [level.width, level.height]), [[8, 4], [4, 2], [2, 1], [1, 1]]);

  const pixels = image(3, 2, (x, y) => [x * 40, y * 90, 7, 200 + x]);
  const bgra = new Uint8Array(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) bgra.set([pixels[i + 2], pixels[i + 1], pixels[i], pixels[i + 3]], i);
  const plain = writeDds({ format: "BGRA", width: 3, height: 2, levels: [bgra] });
  assert.deepEqual(Array.from(decodeDDSLevels(plain, { flipY: false }).levels[0].data), Array.from(pixels));

  assert.throws(() => writeDds({ format: "DXT5", width: 8, height: 8, levels: [new Uint8Array(16)] }), /should be 64 bytes/);
  assert.throws(() => writeDds({ format: "DXT5", width: 0, height: 8, levels: [new Uint8Array(0)] }), /0x8/);
  assert.throws(() => writeDds({ format: "DXT5", width: 2, height: 2, levels: [new Uint8Array(16), new Uint8Array(16), new Uint8Array(16)] }), /at most 2 levels/);
  assert.throws(() => writeDds({ format: "BC7", width: 4, height: 4, levels: [new Uint8Array(16)] }), /Cannot write BC7/);
});

test("UV triangles cover texel centres, wrap past 0..1, and never vanish", () => {
  const left = covered(8, 8, quad(0, 0, 0.5, 1));
  assert.equal(left.size, 32);
  assert.ok([...left].every((texel) => texel % 8 < 4));
  assert.deepEqual([...covered(8, 8, quad(1, 0, 1.5, 1))].sort((a, b) => a - b), [...left].sort((a, b) => a - b));
  // Game UVs: v = 0 is the top row.
  assert.ok([...covered(8, 8, quad(0, 0, 1, 0.25))].every((texel) => texel < 16));
  const tiny = { uvs: new Float32Array([0.6, 0.6, 0.601, 0.6, 0.6, 0.601]), indices: new Uint32Array([0, 1, 2]) };
  assert.deepEqual([...covered(10, 10, tiny)], [66]);
  const broken = { uvs: new Float32Array([Number.NaN, 0, 1, 0, 1, 1]), indices: new Uint32Array([0, 1, 2]) };
  assert.equal(covered(4, 4, broken).size, 0);
});

test("lens owners report conflicts, shared meshes, and bleed only into unused texels", () => {
  const green = { ...quad(0, 0, 0.5, 1), colour: "#00ff00", siren: 1 };
  const alsoGreen = { ...quad(0.25, 0, 0.5, 1), colour: "#00ff00", siren: 2 };
  const red = { ...quad(0, 0, 0.5, 0.5), colour: "#ff0000", siren: 3 };
  const untinted = { ...quad(0, 0.5, 0.25, 1), colour: null, siren: 4 };
  const elsewhere = { ...quad(0.75, 0, 1, 1), colour: null, siren: null };

  const same = rasterizeLensOwners(16, 16, [green, alsoGreen]);
  assert.deepEqual(same.conflicts, []);
  assert.deepEqual(same.shares.map(({ a, b }) => [a, b]), [[0, 1]]);
  assert.deepEqual(same.colours, ["#00ff00"]);

  const clash = rasterizeLensOwners(16, 16, [green, red]);
  assert.equal(clash.conflicts.length, 1);
  assert.deepEqual([clash.conflicts[0].a, clash.conflicts[0].b].sort(), [0, 1]);

  const shared = rasterizeLensOwners(16, 16, [untinted, green, elsewhere]);
  assert.deepEqual(shared.alsoRecoloured, [0]);
  assert.equal(shared.owner[3 * 16 + 9], 0, "two texels of bleed past the island");
  assert.equal(shared.owner[3 * 16 + 10], -1, "no further");
  // A neighbouring mesh's texels keep their colour even within bleed range.
  const neighbour = rasterizeLensOwners(16, 16, [green, { ...quad(0.5, 0, 0.625, 1), colour: null }]);
  assert.equal(neighbour.owner[3 * 16 + 8], -1);
  assert.deepEqual(neighbour.alsoRecoloured, []);

  // A seam a texel wide is not shared texels.
  const seam = rasterizeLensOwners(64, 64, [green, { ...quad(0.49, 0, 1, 1), colour: "#ff0000" }]);
  assert.deepEqual(seam.conflicts, []);
});

test("a recoloured lens keeps brightness and alpha, untouched blocks, and the mip chain", () => {
  const source = dxt5File(16, 16, (x, y) => (x < 8 ? [180, 20, 20, 255] : [20, 20, 240, y < 8 ? 60 : 255]));
  const users = [{ ...quad(0, 0, 0.5, 1), colour: "#00ff00", siren: 1 }];
  const result = recolourLensTexture(source, users);
  assert.equal(result.format, "DXT5");
  assert.equal(result.levels, 5);
  assert.equal(result.bytes.length, source.length);
  const after = decodeDDSLevels(result.bytes, { flipY: false });
  const before = decodeDDSLevels(source, { flipY: false });
  const [r, g, b, a] = at(after.levels[0].data, 16, 2, 2);
  const [br] = at(before.levels[0].data, 16, 2, 2);
  assert.ok(r <= 8 && b <= 8 && Math.abs(g - br) <= 8, `green at the red texel's brightness: ${[r, g, b]}`);
  assert.equal(a, 255);
  // Columns 12..15 are past the bleed: their blocks are the source's, byte for byte.
  const sourceBlocks = readCompressedMipmaps(source, parseDDSHeader(source))[0].data;
  const writtenBlocks = readCompressedMipmaps(result.bytes, parseDDSHeader(result.bytes))[0].data;
  for (const block of [3, 7, 11, 15]) {
    assert.deepEqual(Array.from(writtenBlocks.subarray(block * 16, block * 16 + 16)), Array.from(sourceBlocks.subarray(block * 16, block * 16 + 16)));
  }
  // The 2x2 level blends: its left half is green.
  const [mr, mg] = at(after.levels[3].data, 2, 0, 1);
  assert.ok(mg > mr, `${mr},${mg}`);
});

test("lens writes keep DXT1 blocks, convert uncompressed copies, and refuse colourless formats", () => {
  const dxt1 = new Uint8Array(128 + 8);
  dxt1.set(writeDds({ format: "BGRA", width: 4, height: 4, levels: [new Uint8Array(64)] }).subarray(0, 128));
  const view = new DataView(dxt1.buffer);
  view.setUint32(8, 0x1007, true);
  view.setUint32(80, 0x4, true);
  dxt1.set([0x44, 0x58, 0x54, 0x31], 84);
  dxt1.set([0x00, 0xf8, 0x1f, 0x00, 0, 0, 0, 0], 128); // red over blue, every texel index 0
  const untouched = recolourLensTexture(dxt1, [{ ...quad(0, 0, 0.01, 0.01), colour: "#00ff00", siren: 1 }]);
  assert.equal(untouched.format, "DXT5");
  // The one texel the tiny quad owns changes the block, so it is re-encoded; a far-away one would be kept.
  const far = recolourLensTexture(new Uint8Array([...dxt1.subarray(0, 12), ...new Uint8Array([8, 0, 0, 0]), ...dxt1.subarray(16, 128), ...new Uint8Array(16)]), []);
  assert.equal(far.levels, 1);

  const bgra = writeDds({ format: "BGRA", width: 4, height: 4, levels: [new Uint8Array(64).fill(200)] });
  const plain = recolourLensTexture(bgra, [{ ...quad(0, 0, 1, 1), colour: "#0000ff", siren: 2 }]);
  assert.equal(plain.format, "BGRA");
  assert.deepEqual(at(decodeDDSLevels(plain.bytes, { flipY: false }).levels[0].data, 4, 1, 1), [0, 0, 200, 200]);

  const bc5 = new Uint8Array(dxt1.length + 8);
  bc5.set(dxt1);
  bc5.set([0x41, 0x54, 0x49, 0x32], 84); // ATI2
  assert.throws(() => recolourLensTexture(bc5, []), /holds no colour/);
  assert.throws(() => recolourLensTexture(new Uint8Array(40), []), /not a DDS/);
});

test("diffuse users pair manifest entries with meshes and only lit sirens take a colour", () => {
  const mesh = (name, extra = {}) => ({ name, ...quad(0, 0, 1, 1), uvs2: new Float32Array(8), ...extra });
  const binding = (textureName, uvSet = 0) => ({ paramName: "DiffuseSampler", textureName, relativePath: `textures/ytd/${textureName}.dds`, source: "ytd", uvSet });
  const entry = (name, lightBone, shaderName, textureName, uvSet) => ({ name, lightBone, shaderName, textureBindings: [binding(textureName, uvSet), { paramName: "specsampler", textureName: "spec" }] });
  const meshes = [mesh("a"), mesh("b"), mesh("c"), mesh("d"), mesh("e", { indices: new Uint32Array(0) })];
  const manifest = {
    meshes: [
      entry("a", "siren1", "vehicle_lightsemissive", "Lens_Emis"),
      entry("x", "siren2", "vehicle_lightsemissive", "Lens_Emis"),
      entry("c", "siren3", "vehicle_vehglass", "lens_emis", 1),
      entry("d", "headlight_l", "vehicle_lightsemissive", "other"),
      entry("e", "siren4", "vehicle_lightsemissive", "lens_emis"),
      entry("b", "siren5", "vehicle_lightsemissive", "lens_emis"),
    ],
  };
  const textures = collectDiffuseUsers(meshes, manifest);
  const lens = textures.get("lens_emis");
  assert.equal(lens.name, "Lens_Emis");
  assert.deepEqual(lens.users.map((user) => [user.name, user.siren]), [["a", 1], ["b", 5], ["c", null]]);
  assert.equal(lens.users[2].uvs, meshes[2].uvs2, "the binding's UV set");

  const plan = planLensTextures(textures, { 1: "#00FF00", 3: "#ff0000", 5: "red" });
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0].users.map((user) => user.colour), ["#00ff00", null, null]);
  assert.deepEqual(planLensTextures(textures, { 9: "#00ff00" }), []);
});
