import assert from "node:assert/strict";
import test from "node:test";
import { isLayerVisible, setLayers, soloLayer, toggleLayer } from "./variant-layers.js";

const badge = { id: "Yellow badge", visible: true };
const stripe = { id: "Red stripe", visible: true };
const night = { id: "Lights/Night", visible: false };

test("a layer the map doesn't name shows as the file has it", () => {
  assert.equal(isLayerVisible({}, badge), true);
  assert.equal(isLayerVisible({ "Old file layer": false }, badge), true);
  assert.equal(isLayerVisible({}, night), false);
  assert.equal(isLayerVisible({ "Yellow badge": false }, badge), false);
  assert.equal(isLayerVisible({}, null), false);
});

test("the first toggle after a replaced file hides a visible layer the old map never named", () => {
  // A variant made against another file keeps that file's ids.
  const stale = { "Old stripe": false, "Old badge": true };
  const next = toggleLayer(stale, badge);
  assert.notEqual(next, stale);
  assert.equal(isLayerVisible(next, badge), false);
  assert.equal(next["Old stripe"], false, "other entries are kept");
  assert.equal(isLayerVisible(toggleLayer(next, badge), badge), true);
  assert.equal(isLayerVisible(toggleLayer({}, night), night), true);
});

test("setting a group that already matches changes nothing", () => {
  const visibility = { "Red stripe": true };
  assert.equal(setLayers(visibility, [badge, stripe], true), visibility);
  const hidden = setLayers(visibility, [badge, stripe], false);
  assert.deepEqual(hidden, { "Red stripe": false, "Yellow badge": false });
  assert.equal(setLayers(hidden, [badge, stripe], false), hidden);
  assert.deepEqual(visibility, { "Red stripe": true }, "the input map is not mutated");
});

test("solo shows one sibling and is a no-op when it already is the only one shown", () => {
  const siblings = [badge, stripe, night];
  const solo = soloLayer({}, siblings, "Red stripe");
  assert.deepEqual(solo, { "Yellow badge": false });
  assert.equal(isLayerVisible(solo, stripe), true);
  assert.equal(isLayerVisible(solo, night), false);
  assert.equal(soloLayer(solo, siblings, "Red stripe"), solo);
  const nightOnly = soloLayer(solo, siblings, "Lights/Night");
  assert.deepEqual(nightOnly, { "Yellow badge": false, "Red stripe": false, "Lights/Night": true });
});
