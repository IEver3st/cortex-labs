import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTextureVram, formatLabelForDds, summarizeTextureVram } from "./texture-vram.js";

test("estimateTextureVram computes expected GPU bytes for BC1, BC7, RGBA8 and mipmaps", () => {
  // 2048x2048 DXT1 without mips = 2 MiB; with mips ~ 2.67 MiB
  assert.equal(estimateTextureVram({ width: 2048, height: 2048, format: "DXT1", mipmaps: 1 }), 2 * 1024 * 1024);
  assert.equal(estimateTextureVram({ width: 2048, height: 2048, format: "BC7", mipmaps: 1 }), 4 * 1024 * 1024);
  assert.equal(estimateTextureVram({ width: 1024, height: 1024, format: "RGBA8", mipmaps: 1 }), 4 * 1024 * 1024);
  assert.ok(estimateTextureVram({ width: 4096, height: 4096, format: "BC7", mipmaps: 13 }) > 21 * 1024 * 1024);
});

test("summarizeTextureVram sorts largest first and flags 4K, missing mips, NPOT and 2K on small props", () => {
  assert.equal(formatLabelForDds({ dxgiFormat: 98 }), "BC7");
  assert.equal(formatLabelForDds({ fourCc: "DXT5" }), "DXT5");

  const summary = summarizeTextureVram([
    { name: "small_bump", width: 512, height: 512, format: "DXT1", mipmaps: 9 },
    { name: "huge_diff", width: 4096, height: 4096, format: "BC7", mipmaps: 1 },
    { name: "prop_2k", width: 2048, height: 2048, format: "DXT5", mipmaps: 11 },
    { name: "odd_size", width: 600, height: 400, format: "DXT5", mipmaps: 1 },
  ], { smallProp: true });

  assert.equal(summary.items[0].name, "huge_diff");
  assert.ok(summary.items[0].flags.includes("4K+"));
  assert.ok(summary.items[0].flags.includes("No mipmaps"));
  assert.ok(summary.items.find((i) => i.name === "prop_2k").flags.includes("2K on small prop"));
  assert.ok(summary.items.find((i) => i.name === "odd_size").flags.includes("NPOT"));
  assert.equal(summary.flaggedCount, 3);
});
