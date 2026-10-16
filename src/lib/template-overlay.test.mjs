import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_VEHICLE_OVERLAY_COLOR,
  colorizeMask,
  dilateMaskEuclidean,
  findLogoPlacement,
  normalizeVehicleOverlayColor,
  rasterizeCoverageMask,
} from "./template-overlay.js";

// Distance from a point to a segment, used as an independent oracle for
// "within N pixels of the geometry".
function pointSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function triangleBoundaryDistance(px, py, tri) {
  const [x0, y0, x1, y1, x2, y2] = tri;
  return Math.min(
    pointSegmentDistance(px, py, x0, y0, x1, y1),
    pointSegmentDistance(px, py, x1, y1, x2, y2),
    pointSegmentDistance(px, py, x2, y2, x0, y0),
  );
}

test("overlay colour normalizes to lowercase six-digit hex and falls back to black", () => {
  assert.equal(normalizeVehicleOverlayColor(" #AbC "), "#aabbcc");
  assert.equal(normalizeVehicleOverlayColor("#12ABef"), "#12abef");
  assert.equal(normalizeVehicleOverlayColor("#12abef80"), DEFAULT_VEHICLE_OVERLAY_COLOR);
  assert.equal(normalizeVehicleOverlayColor("red"), DEFAULT_VEHICLE_OVERLAY_COLOR);
  assert.equal(normalizeVehicleOverlayColor(null), DEFAULT_VEHICLE_OVERLAY_COLOR);
});

test("coverage keeps sliver strips that contain no pixel centre", () => {
  // A 0.2 px tall strip lying between pixel-centre rows.
  const strip = [2.1, 4.05, 30.9, 4.05, 2.1, 4.25, 30.9, 4.05, 30.9, 4.25, 2.1, 4.25];
  const mask = rasterizeCoverageMask(strip, 40);
  for (let x = 3; x <= 30; x += 1) {
    assert.equal(mask[4 * 40 + x], 1, `pixel ${x},4 should be covered`);
  }
  assert.equal(mask[3 * 40 + 10], 0);
  assert.equal(mask[5 * 40 + 10], 0);
});

test("mirrored and reordered triangles produce identical coverage", () => {
  const forward = [5, 5, 25, 7, 9, 28];
  const mirrored = [5, 5, 9, 28, 25, 7];
  const a = rasterizeCoverageMask(forward, 32);
  const b = rasterizeCoverageMask(mirrored, 32);
  const both = rasterizeCoverageMask([...forward, ...mirrored], 32);
  assert.deepEqual(a, b);
  assert.deepEqual(a, both);
});

test("two triangles sharing a diagonal leave no seam", () => {
  const quad = [4, 4, 20, 4, 20, 20, 4, 4, 20, 20, 4, 20];
  const mask = rasterizeCoverageMask(quad, 24);
  for (let y = 4; y < 20; y += 1) {
    for (let x = 4; x < 20; x += 1) assert.equal(mask[y * 24 + x], 1, `${x},${y}`);
  }
});

for (const size of [512, 1024, 2048, 4096]) {
  test(`overlay bleed is at least 5 px around the geometry at ${size}`, () => {
    const c = size / 2;
    const tri = [c - 40.3, c - 30.7, c + 52.6, c - 11.2, c - 7.9, c + 44.4];
    const mask = dilateMaskEuclidean(rasterizeCoverageMask(tri, size), size);

    // Every pixel whose square contains a point within 5 px of the
    // triangle must be covered; sample pixel corners and centres.
    for (let y = Math.floor(c - 45); y <= Math.ceil(c + 56); y += 1) {
      for (let x = Math.floor(c - 52); x <= Math.ceil(c + 64); x += 1) {
        let nearest = Infinity;
        for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]]) {
          nearest = Math.min(nearest, triangleBoundaryDistance(x + ox, y + oy, tri));
        }
        if (nearest <= 5) assert.equal(mask[y * size + x], 1, `pixel ${x},${y} at ${nearest.toFixed(2)} px`);
      }
    }

    // And it stays a bleed, not a blob: 10 px out is clear.
    assert.equal(mask[Math.round(c - 30.7 - 10) * size + Math.round(c - 40.3 - 10)], 0);
  });
}

test("dilation is circular, not square", () => {
  const size = 41;
  const seed = new Uint8Array(size * size);
  seed[20 * size + 20] = 1;
  const mask = dilateMaskEuclidean(seed, size);
  // Radius is 5 + sqrt(2) between pixel centres: (6, 0) in, (5, 5) out.
  assert.equal(mask[20 * size + 26], 1);
  assert.equal(mask[20 * size + 27], 0);
  assert.equal(mask[25 * size + 24], 1);
  assert.equal(mask[25 * size + 25], 0);
});

test("dilation clips at the canvas edge without wrapping rows", () => {
  const size = 32;
  const seed = new Uint8Array(size * size);
  seed[10 * size + 31] = 1;
  const mask = dilateMaskEuclidean(seed, size);
  assert.equal(mask[10 * size + 31], 1);
  assert.equal(mask[10 * size + 0], 0, "right-edge bleed must not appear on the left");
  assert.equal(mask[11 * size + 0], 0);
});

test("dilation rejects a mask that does not match its size", () => {
  assert.throws(() => dilateMaskEuclidean(new Uint8Array(10), 4), /does not match/);
});

test("colorize writes the chosen colour opaque and clears the rest", () => {
  const mask = new Uint8Array([1, 0]);
  const rgba = new Uint8ClampedArray(8);
  colorizeMask(mask, rgba, "#12abef");
  assert.deepEqual([...rgba], [0x12, 0xab, 0xef, 255, 0, 0, 0, 0]);
});

test("logo lands in clear space and never overlaps occupied pixels", () => {
  const size = 1024;
  const occupied = new Uint8Array(size * size);
  // Everything is taken except a 300 px square in the bottom-left.
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!(x < 300 && y >= size - 300)) occupied[y * size + x] = 1;
    }
  }
  const placement = findLogoPlacement(occupied, size);
  assert.ok(placement, "a 300 px clearing fits the logo");
  assert.ok(placement.size >= size * 0.035);
  for (let y = placement.y; y < placement.y + placement.size; y += 1) {
    for (let x = placement.x; x < placement.x + placement.size; x += 1) {
      assert.equal(occupied[y * size + x], 0, `logo pixel ${x},${y} covers geometry`);
    }
  }
});

test("logo prefers the lower-left of equally good clearings", () => {
  const size = 512;
  const placement = findLogoPlacement(new Uint8Array(size * size), size);
  assert.ok(placement);
  assert.ok(placement.x < size / 4, `x=${placement.x}`);
  assert.ok(placement.y + placement.size > (size * 3) / 4, `y=${placement.y}`);
});

test("logo is omitted when no clearing is big enough", () => {
  const size = 512;
  const occupied = new Uint8Array(size * size);
  for (let y = 0; y < size; y += 8) {
    for (let x = 0; x < size; x += 1) occupied[y * size + x] = 1;
  }
  assert.equal(findLogoPlacement(occupied, size), null);
});
