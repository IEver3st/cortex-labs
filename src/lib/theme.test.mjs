import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_THEME_PRESET,
  THEME_PRESETS,
  applyAppearance,
  applyColorScheme,
  applyThemePreset,
  getThemePreset,
  normalizeColorScheme,
  normalizeThemePreset,
  resolveColorScheme,
} from "./theme.js";

function relativeLuminance(hex) {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  return channels
    .map((channel) => (
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    ))
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrastRatio(first, second) {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort(
    (a, b) => b - a,
  );
  return (lighter + 0.05) / (darker + 0.05);
}

test("normalizes explicit and legacy color scheme preferences", () => {
  assert.equal(normalizeColorScheme("system", false), "system");
  assert.equal(normalizeColorScheme("light", true), "light");
  assert.equal(normalizeColorScheme("dark", false), "dark");
  assert.equal(normalizeColorScheme(undefined, false), "light");
  assert.equal(normalizeColorScheme("unknown", true), "dark");
});

test("resolves system, light, and dark schemes deterministically", () => {
  assert.equal(resolveColorScheme("system", "light"), "light");
  assert.equal(resolveColorScheme("system", "dark"), "dark");
  assert.equal(resolveColorScheme("light", "dark"), "light");
  assert.equal(resolveColorScheme("dark", "light"), "dark");
});

test("ships unique, complete theme presets and normalizes unknown values", () => {
  const ids = THEME_PRESETS.map((preset) => preset.id);
  assert.equal(ids.length, 12);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(normalizeThemePreset("ocean"), "ocean");
  assert.equal(normalizeThemePreset("unknown"), DEFAULT_THEME_PRESET);
  assert.equal(getThemePreset("unknown").id, DEFAULT_THEME_PRESET);

  for (const preset of THEME_PRESETS) {
    assert.ok(preset.name);
    assert.ok(preset.description);
    for (const mode of [preset.modes.light, preset.modes.dark]) {
      for (const value of Object.values(mode)) {
        assert.match(value, /^#[\da-f]{6}$/i);
      }
    }
  }
});

test("keeps theme text tokens at WCAG AA contrast", () => {
  for (const preset of THEME_PRESETS) {
    for (const [modeName, mode] of Object.entries(preset.modes)) {
      for (const foreground of ["foreground", "muted", "primary"]) {
        for (const background of ["background", "surface"]) {
          const ratio = contrastRatio(mode[foreground], mode[background]);
          assert.ok(
            ratio >= 4.5,
            `${preset.id} ${modeName} ${foreground}/${background} contrast was ${ratio.toFixed(2)}:1`,
          );
        }
      }
    }
  }
});

test("applies a palette across scheme changes without losing the selected preset", () => {
  const properties = new Map();
  const classes = new Set();
  const previousDocument = globalThis.document;

  globalThis.document = {
    documentElement: {
      dataset: {},
      classList: {
        toggle(name, enabled) {
          if (enabled) classes.add(name);
          else classes.delete(name);
        },
      },
      style: {
        setProperty(property, value) {
          properties.set(property, value);
        },
      },
    },
  };

  try {
    const initial = applyAppearance({ colorScheme: "light", themePreset: "ocean" });
    assert.deepEqual(initial, {
      colorScheme: "light",
      resolvedTheme: "light",
      themePreset: "ocean",
    });
    assert.equal(globalThis.document.documentElement.dataset.themePreset, "ocean");
    assert.equal(properties.get("--mg-primary"), getThemePreset("ocean").modes.light.primary);
    assert.equal(properties.get("--mg-primary-rgb"), "64, 109, 102");
    assert.equal(classes.has("dark"), false);

    applyColorScheme("dark");
    assert.equal(globalThis.document.documentElement.dataset.themePreset, "ocean");
    assert.equal(properties.get("--mg-primary"), getThemePreset("ocean").modes.dark.primary);
    assert.equal(properties.get("--mg-primary-rgb"), "127, 183, 173");
    assert.equal(classes.has("dark"), true);

    assert.equal(applyThemePreset("not-a-preset"), DEFAULT_THEME_PRESET);
    assert.equal(globalThis.document.documentElement.dataset.themePreset, DEFAULT_THEME_PRESET);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
