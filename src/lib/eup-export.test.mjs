import test from "node:test";
import assert from "node:assert/strict";

import {
  contactSheetLayout,
  exportFileStem,
  formatSize,
  guideRect,
  normalizeExportSettings,
  pickVideoType,
  sheetCellSize,
  shotFov,
} from "./eup-export.js";

test("the frame guide and the capture camera agree on what is inside the shot", () => {
  // A 16:10 viewfinder exporting 4:5 keeps the full height and crops the sides.
  const narrow = guideRect(1600, 1000, 0.8);
  assert.deepEqual(narrow, { x: 400, y: 0, width: 800, height: 1000 });
  assert.equal(shotFov(40, 1.6, 0.8), 40, "the vertical view is unchanged");

  // Exporting 21:9 from the same view keeps the full width and crops top and bottom.
  const wide = guideRect(1600, 1000, 21 / 9);
  assert.equal(wide.width, 1600);
  assert.ok(Math.abs(wide.height - 1600 / (21 / 9)) < 1e-9);
  // The narrower vertical field must show exactly that height of the viewfinder.
  const fov = shotFov(40, 1.6, 21 / 9);
  const ratio = Math.tan((fov * Math.PI) / 360) / Math.tan((40 * Math.PI) / 360);
  assert.ok(Math.abs(ratio - wide.height / 1000) < 1e-9);

  assert.equal(guideRect(0, 1000, 1), null);
});

test("formats double for high quality without passing 4096", () => {
  assert.deepEqual(formatSize("portrait"), { width: 1080, height: 1350 });
  assert.deepEqual(formatSize("portrait", true), { width: 2160, height: 2700 });
  assert.deepEqual(formatSize("story", true), { width: 2160, height: 3840 });
  assert.deepEqual(formatSize("nope"), { width: 1080, height: 1350 });
});

test("colourway sheets lay cells in rows without gaps and stay under 4096", () => {
  const layout = contactSheetLayout(6, 300, 400, 4);
  assert.equal(layout.columns, 4);
  assert.equal(layout.rows, 2);
  assert.deepEqual(layout.cells[5], { x: 300, y: 400 });
  assert.equal(layout.width, 1200);
  const cell = sheetCellSize("portrait", 26, 4);
  assert.ok(cell.width * 4 <= 4096 && cell.height * 7 <= 4096);
  assert.deepEqual(contactSheetLayout(1, 10, 10).cells, [{ x: 0, y: 0 }]);
});

test("export settings normalise and keep angles in display order", () => {
  const settings = normalizeExportSettings({ mode: "video", angles: ["back", "view", "bogus"], videoLength: 5, format: "story" });
  assert.equal(settings.mode, "video");
  assert.deepEqual(settings.angles, ["view", "back"]);
  assert.equal(settings.videoLength, 8, "unknown lengths fall back");
  assert.equal(settings.format, "story");
  assert.equal(normalizeExportSettings(null).mode, "shots");
});

test("file stems and video types", () => {
  assert.equal(exportFileStem("Male: task 000a"), "male-task-000a");
  assert.equal(exportFileStem("   "), "eup");
  assert.deepEqual(pickVideoType((type) => type.startsWith("video/webm")), { mimeType: "video/webm;codecs=vp9", extension: "webm" });
  assert.equal(pickVideoType(() => false), null);
  assert.equal(pickVideoType(undefined), null);
});
