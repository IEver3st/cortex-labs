import assert from "node:assert/strict";
import test from "node:test";
import { normalizeVariantExportShape, variantExportDimensions } from "./variant-export.js";

test("a non-square source keeps its aspect with the long side at the export size", () => {
  assert.deepEqual(variantExportDimensions(4096, 2048, 2048), { width: 2048, height: 1024 });
  assert.deepEqual(variantExportDimensions(2048, 4096, 4096), { width: 2048, height: 4096 });
  assert.deepEqual(variantExportDimensions(3000, 2000, 4096), { width: 4096, height: 2731 });
  // Upscaling a small source follows the chosen size too.
  assert.deepEqual(variantExportDimensions(512, 256, 1024), { width: 1024, height: 512 });
});

test("square output is the explicit choice, and square sources stay square", () => {
  assert.deepEqual(variantExportDimensions(4096, 2048, 2048, "square"), { width: 2048, height: 2048 });
  assert.deepEqual(variantExportDimensions(1024, 1024, 4096), { width: 4096, height: 4096 });
});

test("missing source dimensions fall back to a square export", () => {
  assert.deepEqual(variantExportDimensions(0, 0, 512), { width: 512, height: 512 });
  assert.deepEqual(variantExportDimensions(undefined, 300, 512), { width: 512, height: 512 });
  assert.deepEqual(variantExportDimensions(1, 9000, 512), { width: 1, height: 512 });
});

test("unknown shapes read as keep aspect", () => {
  assert.equal(normalizeVariantExportShape("square"), "square");
  assert.equal(normalizeVariantExportShape(undefined), "source");
  assert.equal(normalizeVariantExportShape("stretch"), "source");
});
