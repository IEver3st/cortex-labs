import assert from "node:assert/strict";
import test from "node:test";

import { RETIRED_DEFAULT_KEYS, sanitizeStoredDefaults } from "./prefs.js";

test("retired settings keys are dropped from stored defaults so a save does not write them back", () => {
  const stored = {
    hideRotText: true,
    experimentalSettings: true,
    cameraWASD: true,
    showHints: false,
    toolbarInTitlebar: true,
    glossiness: 0.9,
    showAmbientOcclusion: true,
    autoModelTexturesEnabled: true,
    liveryExteriorOnly: true,
    autoTemplateBackgroundColor: "#1e90ff",
    showGrid: true,
  };
  const clean = sanitizeStoredDefaults(stored);
  for (const key of RETIRED_DEFAULT_KEYS) assert.equal(key in clean, false, key);
  assert.deepEqual(clean, { liveryExteriorOnly: true, autoTemplateBackgroundColor: "#1e90ff", showGrid: true });
  // The stored object is left as it was.
  assert.equal(stored.hideRotText, true);
});

test("malformed stored defaults read as empty", () => {
  assert.deepEqual(sanitizeStoredDefaults(null), {});
  assert.deepEqual(sanitizeStoredDefaults("defaults"), {});
  assert.deepEqual(sanitizeStoredDefaults([1, 2]), {});
});
