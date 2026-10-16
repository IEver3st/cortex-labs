import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_WATERMARK,
  WATERMARK_CONFIG_VERSION,
  applyWatermarkToPngBytes,
  computeWatermarkPlacements,
  hasDrawableWatermark,
  normalizeWatermarkConfig,
  resolveWatermarkContent,
  stampCanvas,
} from "./watermark.js";

test("missing or malformed config falls back to defaults", () => {
  assert.deepEqual(normalizeWatermarkConfig(null), DEFAULT_WATERMARK);
  const cfg = normalizeWatermarkConfig({
    version: WATERMARK_CONFIG_VERSION,
    kind: "hologram",
    style: "glow",
    position: "everywhere",
    color: "red",
    opacity: 9,
    size: -4,
    weight: 950,
    rotation: "nope",
  });
  assert.equal(cfg.kind, "text");
  assert.equal(cfg.style, "plain");
  assert.equal(cfg.position, DEFAULT_WATERMARK.position);
  assert.equal(cfg.color, DEFAULT_WATERMARK.color);
  assert.equal(cfg.opacity, 1);
  assert.equal(cfg.size, 0.5);
  assert.equal(cfg.weight, DEFAULT_WATERMARK.weight);
  assert.equal(cfg.rotation, 0);
});

test("an untouched v1 config adopts the new default design but keeps on/off", () => {
  const cfg = normalizeWatermarkConfig({
    enabled: true,
    text: "© Cortex Labs",
    font: "Inter",
    fontSize: 32,
    color: "#ffffff",
    opacity: 0.5,
    position: "bottom-right",
    rotation: 0,
  });
  assert.equal(cfg.version, WATERMARK_CONFIG_VERSION);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.style, DEFAULT_WATERMARK.style);
  assert.equal(cfg.font, DEFAULT_WATERMARK.font);
});

test("a customized v1 config keeps its look, with pixel size made relative", () => {
  const cfg = normalizeWatermarkConfig({
    enabled: true,
    text: "Ever3st",
    font: "Georgia",
    fontSize: 54,
    color: "#ff0000",
    opacity: 0.4,
    position: "tiled",
    rotation: -30,
  });
  assert.equal(cfg.text, "Ever3st");
  assert.equal(cfg.font, "Georgia");
  assert.equal(cfg.size, 5);
  assert.equal(cfg.style, "plain");
  assert.equal(cfg.weight, 400);
  assert.equal(cfg.italic, false);
  assert.equal(cfg.position, "tiled");
  assert.equal(cfg.rotation, -30);
  assert.equal(cfg.opacity, 0.4);
});

test("imported images must be data URLs with real dimensions", () => {
  const base = { version: WATERMARK_CONFIG_VERSION, kind: "image" };
  assert.equal(normalizeWatermarkConfig({ ...base, image: { dataUrl: "https://x/y.png", width: 10, height: 10 } }).image, null);
  assert.equal(normalizeWatermarkConfig({ ...base, image: { dataUrl: "data:image/png;base64,AA", width: 0, height: 10 } }).image, null);
  const ok = normalizeWatermarkConfig({ ...base, image: { dataUrl: "data:image/png;base64,AA", width: 64.4, height: 32, name: "logo.png" } });
  assert.deepEqual(ok.image, { dataUrl: "data:image/png;base64,AA", width: 64, height: 32, name: "logo.png" });
});

test("content resolution reports empty logo-only and blank-text watermarks", () => {
  const v = WATERMARK_CONFIG_VERSION;
  assert.equal(resolveWatermarkContent(normalizeWatermarkConfig({ version: v, kind: "image" })).isEmpty, true);
  assert.equal(resolveWatermarkContent(normalizeWatermarkConfig({ version: v, kind: "text", text: "   " })).isEmpty, true);
  assert.equal(resolveWatermarkContent(normalizeWatermarkConfig({ version: v, kind: "text", text: "pro", uppercase: true })).text, "PRO");
  assert.equal(hasDrawableWatermark({ version: v, enabled: false, text: "x" }), false);
  assert.equal(hasDrawableWatermark({ version: v, enabled: true, kind: "image" }), false);
  assert.equal(hasDrawableWatermark({ version: v, enabled: true, text: "x" }), true);
});

test("anchored placement respects the margin on every side", () => {
  const image = { width: 1920, height: 1080 };
  const stamp = { width: 200, height: 40 };
  const at = (position) =>
    computeWatermarkPlacements(image, stamp, { version: WATERMARK_CONFIG_VERSION, position, margin: 5 }).points[0];
  const margin = 54; // 5% of the 1080 short side
  assert.deepEqual(at("top-left"), { x: margin + 100, y: margin + 20 });
  assert.deepEqual(at("bottom-right"), { x: 1920 - margin - 100, y: 1080 - margin - 20 });
  assert.deepEqual(at("top"), { x: 960, y: margin + 20 });
  assert.deepEqual(at("left"), { x: margin + 100, y: 540 });
  assert.deepEqual(at("center"), { x: 960, y: 540 });
});

test("rotated corner stamps stay inside the image", () => {
  const image = { width: 1000, height: 600 };
  const stamp = { width: 300, height: 60 };
  const { points, rotation } = computeWatermarkPlacements(image, stamp, {
    version: WATERMARK_CONFIG_VERSION,
    position: "bottom-right",
    margin: 0,
    rotation: 90,
  });
  assert.equal(rotation, Math.PI / 2);
  // Rotated 90°, the stamp's box is 60 wide and 300 tall.
  assert.ok(Math.abs(points[0].x - (1000 - 30)) < 1e-6);
  assert.ok(Math.abs(points[0].y - (600 - 150)) < 1e-6);
});

test("tiling covers the image and skips copies far outside it", () => {
  const image = { width: 800, height: 600 };
  const stamp = { width: 120, height: 30 };
  const { points } = computeWatermarkPlacements(image, stamp, {
    version: WATERMARK_CONFIG_VERSION,
    position: "tiled",
    rotation: -30,
    tileGap: 100,
  });
  assert.ok(points.length > 8);
  for (const p of points) {
    assert.ok(p.x >= -120 && p.x <= 920 && p.y >= -120 && p.y <= 720);
  }
  assert.ok(points.some((p) => p.x < 200 && p.y < 200));
  assert.ok(points.some((p) => p.x > 600 && p.y > 400));
});

test("normalized sizes compare equal to preset values", () => {
  const cfg = normalizeWatermarkConfig({ version: WATERMARK_CONFIG_VERSION, size: 2.4, opacity: 0.92, margin: 2.5 });
  assert.equal(cfg.size, 2.4);
  assert.equal(cfg.opacity, 0.92);
  assert.equal(cfg.margin, 2.5);
});

test("zero-sized images or stamps produce no placements", () => {
  assert.deepEqual(computeWatermarkPlacements({ width: 0, height: 10 }, { width: 5, height: 5 }, {}).points, []);
  assert.deepEqual(computeWatermarkPlacements({ width: 10, height: 10 }, { width: 0, height: 5 }, {}).points, []);
});

test("an off or empty watermark leaves captured bytes untouched", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71]);
  // No DOM is needed: nothing is decoded or re-encoded when there is nothing to draw.
  assert.equal(await applyWatermarkToPngBytes(bytes, null), bytes);
  assert.equal(await applyWatermarkToPngBytes(bytes, { ...DEFAULT_WATERMARK, enabled: false }), bytes);
  assert.equal(await applyWatermarkToPngBytes(bytes, { ...DEFAULT_WATERMARK, enabled: true, kind: "text", text: "   " }), bytes);
});

test("stamping a canvas is a no-op when the watermark is off", async () => {
  let touched = false;
  const canvas = { width: 100, height: 100, getContext: () => { touched = true; return null; } };
  assert.equal(await stampCanvas(canvas, { ...DEFAULT_WATERMARK, enabled: false }), false);
  assert.equal(await stampCanvas(canvas, undefined), false);
  assert.equal(await stampCanvas(null, { ...DEFAULT_WATERMARK, enabled: true }), false);
  assert.equal(touched, false);
});
