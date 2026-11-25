import test from "node:test";
import assert from "node:assert/strict";

import {
  STUDIO_LOOK_PRESETS,
  getStudioPresetPatch,
  matchStudioPreset,
} from "./studio-presets.js";

test("studio look presets apply cleanly to Prop Studio and Photo Mode and match back", () => {
  assert.ok(STUDIO_LOOK_PRESETS.length >= 5);
  for (const preset of STUDIO_LOOK_PRESETS) {
    const propPatch = getStudioPresetPatch(preset.id, "prop");
    assert.ok(propPatch);
    assert.equal(matchStudioPreset(propPatch, "prop"), preset.id);

    const photoPatch = getStudioPresetPatch(preset.id, "photo");
    assert.ok(photoPatch);
    assert.equal(typeof photoPatch.grid, "boolean");
    assert.equal(typeof photoPatch.shadows, "boolean");
    assert.equal(matchStudioPreset(photoPatch, "photo"), preset.id);
  }
  assert.equal(getStudioPresetPatch("nope", "prop"), null);
  assert.equal(matchStudioPreset({ stage: "workbench", backdrop: "#123456" }, "prop"), "");
});
