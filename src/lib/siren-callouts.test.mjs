import test from "node:test";
import assert from "node:assert/strict";
import { clusterKey, clusterMarkers, leaderEnd, relaxCallouts } from "./siren-callouts.js";

// Projected siren positions from a GSD 2024 Explorer at a 3/4 front view:
// a packed lightbar, stacked heads, grille and interior lights.
const EXPLORER = [
  [1, 643.5, 274.9], [2, 640.3, 275.5], [3, 605.7, 305.6], [4, 605.7, 305.6], [5, 726.4, 323.7], [6, 726.4, 323.7],
  [7, 759.1, 289.4], [8, 761.9, 290.6], [9, 657, 276], [10, 749.8, 287.5], [11, 702.3, 281.5], [12, 846.3, 381.3],
  [13, 846.4, 381.3], [14, 848.5, 382.6], [15, 848.5, 382.6], [16, 830.8, 326.1], [17, 877.9, 332.8], [18, 866, 345.1],
  [19, 840.5, 341.3], [20, 416.4, 580.5], [21, 417.1, 580.9], [22, 416, 577.5], [23, 781.1, 526], [24, 621, 465.9],
  [25, 771.9, 508], [26, 581.7, 474.6], [27, 732.7, 330.5], [28, 591.8, 308.8], [29, 742.1, 285.9], [30, 664.5, 276.4],
  [31, 582, 474.7], [32, 776.1, 529.1],
].map(([siren, x, y]) => ({ siren, x, y, behind: false, far: siren >= 12 && siren <= 19 }));

const overlaps = (a, b, gap = 0) => Math.abs(a.x - b.x) < (a.w + b.w) / 2 + gap && Math.abs(a.y - b.y) < (a.h + b.h) / 2 + gap;

test("lights that share a spot on screen share one callout", () => {
  const clusters = clusterMarkers([
    { siren: 4, x: 100, y: 100, far: true },
    { siren: 3, x: 102, y: 101, far: false },
    { siren: 9, x: 300, y: 100, far: true },
    { siren: 10, x: 302, y: 100, far: true },
    { siren: 5, x: 50, y: 50, behind: true },
  ]);
  assert.deepEqual(clusters.map((cluster) => [cluster.id, cluster.sirens, cluster.far]), [
    [3, [3, 4], false],
    [9, [9, 10], true],
  ]);
  assert.equal(clusterKey(clusters), "3+4,9+10~");
});

test("callouts settle clear of each other, of every light and of the stage edge", () => {
  const clusters = clusterMarkers(EXPLORER);
  const labels = new Map();
  const sizes = new Map(clusters.map((cluster) => [cluster.id, { w: 10 + cluster.sirens.join(" ").length * 7, h: 18 }]));
  for (let frame = 0; frame < 60; frame += 1) relaxCallouts(clusters, labels, { width: 1370, height: 818, sizes });
  const placed = clusters.map((cluster) => labels.get(cluster.id));
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      assert.ok(!overlaps(placed[i], placed[j]), `labels ${clusters[i].id} and ${clusters[j].id} overlap`);
    }
    for (const cluster of clusters) {
      assert.ok(!overlaps(placed[i], { x: cluster.x, y: cluster.y, w: 0, h: 0 }, 2), `label ${clusters[i].id} covers light ${cluster.id}`);
    }
    const { x, y, w, h } = placed[i];
    assert.ok(x - w / 2 >= 0 && x + w / 2 <= 1370 && y - h / 2 >= 0 && y + h / 2 <= 818);
  }
  // Every label stays near its own light.
  for (const cluster of clusters) {
    const label = labels.get(cluster.id);
    assert.ok(Math.hypot(label.x - cluster.x, label.y - cluster.y) < 90, `label ${cluster.id} drifted from its light`);
  }
});

test("settled callouts hold still and follow their lights when the view moves", () => {
  const clusters = clusterMarkers(EXPLORER);
  const labels = new Map();
  for (let frame = 0; frame < 60; frame += 1) relaxCallouts(clusters, labels, { width: 1370, height: 818 });
  assert.ok(relaxCallouts(clusters, labels, { width: 1370, height: 818 }) < 0.5);

  // Panning the view carries every label with its light.
  const panned = clusters.map((cluster) => ({ ...cluster, x: cluster.x + 40 }));
  const before = new Map([...labels].map(([id, label]) => [id, { ...label }]));
  assert.ok(relaxCallouts(panned, labels, { width: 1370, height: 818 }) < 0.5);
  for (const [id, label] of labels) assert.ok(Math.abs(label.x - before.get(id).x - 40) < 0.5, `label ${id} did not follow its light`);

  // A light moving into a crowd rearranges its neighbours a little per frame.
  const crowded = panned.map((cluster) => (cluster.id === 20 ? { ...cluster, x: panned.find((other) => other.id === 9).x, y: panned.find((other) => other.id === 9).y + 20 } : cluster));
  for (let frame = 0; frame < 5; frame += 1) {
    assert.ok(relaxCallouts(crowded, labels, { width: 1370, height: 818, maxStep: 8 }) <= 8 + 1e-9);
  }
});

test("labels of lights that left the view are dropped", () => {
  const labels = new Map();
  relaxCallouts(clusterMarkers(EXPLORER), labels, { width: 1370, height: 818 });
  relaxCallouts(clusterMarkers(EXPLORER.slice(0, 2)), labels, { width: 1370, height: 818 });
  assert.deepEqual([...labels.keys()], [1]);
  relaxCallouts([], labels, { width: 1370, height: 818 });
  assert.equal(labels.size, 0);
});

test("a leader ends on the label edge nearest its light", () => {
  const label = { x: 100, y: 50, w: 20, h: 10 };
  assert.deepEqual(leaderEnd({ x: 100, y: 80 }, label), { x: 100, y: 55 });
  assert.deepEqual(leaderEnd({ x: 60, y: 50 }, label), { x: 90, y: 50 });
  assert.equal(leaderEnd({ x: 101, y: 51 }, label), null);
});
