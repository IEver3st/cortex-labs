import test from "node:test";
import assert from "node:assert/strict";
import { decodeDDSLevels, parseDDSHeader } from "./dds-decode.js";
import { encodeDxt5, writeDds } from "./dds-encode.js";
import { buildLiveryTexture, buildMipChain, hasTransparency, resizeRgba, thumbnailRgba } from "./livery-texture.js";

function solid(width, height, rgba) {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set(rgba, i);
  return pixels;
}

// Top half red, bottom half blue: rows must stay top first through the write.
function halves(width, height) {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) pixels.set(y < height / 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * width + x) * 4);
  }
  return pixels;
}

test("resizing keeps flat colour and clear edges", () => {
  const down = resizeRgba(solid(64, 64, [10, 200, 30, 255]), 64, 64, 16, 16);
  assert.equal(down.length, 16 * 16 * 4);
  assert.deepEqual([...down.subarray(0, 4)], [10, 200, 30, 255]);
  const up = resizeRgba(solid(4, 4, [10, 200, 30, 255]), 4, 4, 32, 8);
  assert.deepEqual([...up.subarray(up.length - 4)], [10, 200, 30, 255]);

  // Clear texels hold black; averaging them in would darken the white edge.
  const edge = new Uint8Array(4 * 1 * 4);
  edge.set([255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0]);
  const half = resizeRgba(edge, 4, 1, 1, 1);
  assert.deepEqual([...half], [255, 255, 255, 128]);
  assert.throws(() => resizeRgba(new Uint8Array(3), 1, 1, 2, 2), /RGBA/);
});

test("mip chains stop at 4x4 unless a count is asked for", () => {
  assert.deepEqual(buildMipChain(solid(64, 16, [0, 0, 0, 255]), 64, 16).map((level) => [level.width, level.height]), [[64, 16], [32, 8], [16, 4]]);
  assert.equal(buildMipChain(solid(8, 8, [0, 0, 0, 255]), 8, 8, 4).length, 4);
  const clear = buildMipChain(solid(4, 4, [255, 0, 0, 0]), 4, 4, 2)[1];
  assert.deepEqual([...clear.data.subarray(0, 4)], [0, 0, 0, 0]);
});

test("a livery is written as DXT5 at the dictionary's size, top row first", () => {
  const built = buildLiveryTexture({ width: 32, height: 32, rgba: halves(32, 32) }, { width: 64, height: 64 });
  assert.equal(built.format, "DXT5");
  assert.equal(built.passthrough, false);
  assert.equal(built.levels, 5);
  const header = parseDDSHeader(built.bytes);
  assert.deepEqual([header.width, header.height, header.mipMapCount, header.fmt], [64, 64, 5, "DXT5"]);
  const [top] = decodeDDSLevels(built.bytes, { flipY: false, decodeMips: false }).levels;
  assert.ok(top.data[0] > 200 && top.data[2] < 40, "first row is red");
  assert.ok(top.data[top.data.length - 2] > 200 && top.data[top.data.length - 4] < 40, "last row is blue");

  const oneLevel = buildLiveryTexture({ width: 64, height: 64, rgba: halves(64, 64) }, { width: 64, height: 64, levels: 1 });
  assert.equal(oneLevel.levels, 1);
  assert.throws(() => buildLiveryTexture({ width: 4, height: 4, rgba: solid(4, 4, [0, 0, 0, 255]) }, { width: 3, height: 64 }), /3x64/);
  assert.throws(() => buildLiveryTexture({ width: 4, height: 4 }, { width: 64, height: 64 }), /no pixels/);
});

test("the user's own DDS at the right size goes in as it is", () => {
  const dds = writeDds({ format: "DXT5", width: 8, height: 8, levels: [encodeDxt5(solid(8, 8, [1, 2, 3, 255]), 8, 8)] });
  const source = { width: 8, height: 8, rgba: solid(8, 8, [1, 2, 3, 255]), dds };
  const kept = buildLiveryTexture(source, { width: 8, height: 8, levels: 4 });
  assert.equal(kept.passthrough, true);
  assert.equal(kept.bytes, dds);
  const resized = buildLiveryTexture(source, { width: 16, height: 16 });
  assert.equal(resized.passthrough, false);
  assert.equal(parseDDSHeader(resized.bytes).width, 16);

  // A DDS whose last mip level is cut short is rebuilt from its pixels instead.
  const chain = [8, 4, 2, 1].map((size) => encodeDxt5(solid(size, size, [1, 2, 3, 255]), size, size));
  const full = writeDds({ format: "DXT5", width: 8, height: 8, levels: chain });
  assert.equal(buildLiveryTexture({ ...source, dds: full }, { width: 8, height: 8, levels: 4 }).passthrough, true);
  const cut = buildLiveryTexture({ ...source, dds: full.subarray(0, full.length - 8) }, { width: 8, height: 8, levels: 4 });
  assert.equal(cut.passthrough, false);
  assert.equal(parseDDSHeader(cut.bytes).mipMapCount, 4);
});

test("thumbnails and transparency", () => {
  const thumb = thumbnailRgba(solid(400, 200, [9, 9, 9, 255]), 400, 200, 96);
  assert.deepEqual([thumb.width, thumb.height], [96, 48]);
  assert.equal(hasTransparency(solid(2, 2, [0, 0, 0, 255])), false);
  assert.equal(hasTransparency(solid(2, 2, [0, 0, 0, 254])), true);
});
