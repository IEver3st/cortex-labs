import assert from "node:assert/strict";
import test from "node:test";

import {
  MIN_TEMPLATE_MARKER_SIZE,
  buildTemplateMarkerMask,
  hitTemplateMarker,
  markerFromDrag,
  markerPixelBounds,
  moveTemplateMarker,
  normalizeTemplateMarkers,
  resizeTemplateMarker,
} from "./template-markers.js";

test("a drag in any direction makes the same box, clamped to the sheet", () => {
  const forward = markerFromDrag({ x: 0.2, y: 0.3 }, { x: 0.5, y: 0.6 }, "a");
  const backward = markerFromDrag({ x: 0.5, y: 0.6 }, { x: 0.2, y: 0.3 }, "a");
  assert.deepEqual(forward, { id: "a", x: 0.2, y: 0.3, w: 0.3, h: 0.3, fill: "pieces" });
  assert.deepEqual(backward, forward);

  const clamped = markerFromDrag({ x: -0.2, y: 0.9 }, { x: 0.1, y: 1.4 }, "b");
  assert.deepEqual(clamped, { id: "b", x: 0, y: 0.9, w: 0.1, h: 0.1, fill: "pieces" });
});

test("a click without a real drag makes no box", () => {
  assert.equal(markerFromDrag({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }), null);
  assert.equal(markerFromDrag({ x: 0.5, y: 0.5 }, { x: 0.5 + MIN_TEMPLATE_MARKER_SIZE / 2, y: 0.6 }), null);
});

test("moving keeps the box size and keeps it on the sheet", () => {
  const marker = { id: "a", x: 0.8, y: 0.1, w: 0.15, h: 0.2, fill: "box" };
  assert.deepEqual(moveTemplateMarker(marker, 0.5, -0.5), { ...marker, x: 0.85, y: 0 });
  assert.deepEqual(moveTemplateMarker(marker, -0.3, 0.05), { ...marker, x: 0.5, y: 0.15 });
});

test("resizing a corner keeps the opposite corner fixed and flips past it", () => {
  const marker = { id: "a", x: 0.2, y: 0.2, w: 0.2, h: 0.2, fill: "pieces" };
  assert.deepEqual(resizeTemplateMarker(marker, "se", { x: 0.5, y: 0.6 }), { ...marker, w: 0.3, h: 0.4 });
  assert.deepEqual(resizeTemplateMarker(marker, "nw", { x: 0.1, y: 0.15 }), {
    ...marker,
    x: 0.1,
    y: 0.15,
    w: 0.3,
    h: 0.25,
  });
  // Dragging the north-west corner past the south-east one flips the box.
  assert.deepEqual(resizeTemplateMarker(marker, "nw", { x: 0.5, y: 0.5 }), {
    ...marker,
    x: 0.4,
    y: 0.4,
    w: 0.1,
    h: 0.1,
  });
});

test("stored markers are validated, not guessed", () => {
  const markers = normalizeTemplateMarkers([
    { id: "a", x: 0.1, y: 0.1, w: 0.2, h: 0.2, fill: "box" },
    { id: "a", x: 0.5, y: 0.5, w: 0.1, h: 0.1 },
    { id: "bad", x: "0.1", y: 0, w: 0.2, h: 0.2 },
    { id: "tiny", x: 0.1, y: 0.1, w: 0, h: 0.2 },
    { id: "spill", x: 0.9, y: 0.9, w: 0.5, h: 0.5, fill: "glow" },
    null,
  ]);
  assert.equal(markers.length, 3);
  assert.equal(markers[0].fill, "box");
  assert.notEqual(markers[1].id, "a", "duplicate ids get a fresh id");
  assert.deepEqual(markers[2], { id: "spill", x: 0.9, y: 0.9, w: 0.1, h: 0.1, fill: "pieces" });
  assert.deepEqual(normalizeTemplateMarkers("nope"), []);
});

test("the topmost box wins a hit", () => {
  const markers = [
    { id: "under", x: 0, y: 0, w: 0.5, h: 0.5, fill: "pieces" },
    { id: "over", x: 0.25, y: 0.25, w: 0.5, h: 0.5, fill: "pieces" },
  ];
  assert.equal(hitTemplateMarker(markers, { x: 0.3, y: 0.3 }).id, "over");
  assert.equal(hitTemplateMarker(markers, { x: 0.1, y: 0.1 }).id, "under");
  assert.equal(hitTemplateMarker(markers, { x: 0.9, y: 0.9 }), null);
});

for (const size of [512, 1024, 2048, 4096]) {
  test(`a box lands on the same texture pixels at ${size}`, () => {
    const marker = { id: "a", x: 0.25, y: 0.5, w: 0.125, h: 0.0625, fill: "box" };
    assert.deepEqual(markerPixelBounds(marker, size), {
      x0: size * 0.25,
      y0: size * 0.5,
      x1: size * 0.375,
      y1: size * 0.5625,
    });
  });
}

test("pieces markers colour only paint geometry inside the box", () => {
  const size = 8;
  const pieceMask = new Uint8Array(size * size);
  // Paint geometry occupies columns 2-5 of rows 2-5.
  for (let y = 2; y < 6; y += 1) for (let x = 2; x < 6; x += 1) pieceMask[y * size + x] = 1;
  const pieces = { id: "p", x: 0, y: 0, w: 0.5, h: 0.5, fill: "pieces" };
  const empty = { id: "e", x: 0.75, y: 0.75, w: 0.25, h: 0.25, fill: "pieces" };
  const box = { id: "b", x: 0.75, y: 0, w: 0.25, h: 0.25, fill: "box" };
  const { mask, counts, painted } = buildTemplateMarkerMask([pieces, empty, box], pieceMask, size);

  // Pieces box covers rows/cols 0-3; only the 2x2 of geometry inside it is marked.
  assert.equal(counts.p, 4);
  assert.equal(mask[2 * size + 2], 1);
  assert.equal(mask[3 * size + 3], 1);
  assert.equal(mask[4 * size + 4], 0, "geometry outside the box stays unmarked");
  assert.equal(mask[0], 0, "empty texture inside a pieces box stays unmarked");
  // A pieces box over no geometry reports zero so the UI can say so.
  assert.equal(counts.e, 0);
  // A box marker fills its whole 2x2 box.
  assert.equal(counts.b, 4);
  assert.equal(mask[0 * size + 7], 1);
  assert.equal(painted, 8);
});
