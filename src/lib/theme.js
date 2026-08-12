export const COLOR_SCHEMES = ["system", "light", "dark"];

export const DEFAULT_THEME_PRESET = "roan";

function createMode(background, surface, foreground, muted, border, input, primary) {
  return Object.freeze({ background, surface, foreground, muted, border, input, primary });
}

function createPreset(id, name, description, light, dark) {
  return Object.freeze({
    id,
    name,
    description,
    modes: Object.freeze({ light, dark }),
  });
}

export const THEME_PRESETS = Object.freeze([
  createPreset(
    "roan",
    "Roan",
    "Warm stone surfaces with the signature clay focus",
    createMode("#f3f1ec", "#eae7e0", "#1f1e1d", "#5a554f", "#dcd7ce", "#fcfaf8", "#9f5032"),
    createMode("#1f1e1d", "#33312f", "#f3f1ec", "#b0aaa3", "#4a4744", "#2a2827", "#e68b64"),
  ),
  createPreset(
    "everforest",
    "Everforest",
    "Warm graphite with calm green emphasis",
    createMode("#f2f0e7", "#e5e1d4", "#2d353b", "#5c625c", "#d3cdbf", "#fbf9f2", "#506a45"),
    createMode("#2d353b", "#374247", "#d3c6aa", "#b3ada2", "#4b585b", "#323b40", "#a7c080"),
  ),
  createPreset(
    "graphite",
    "Graphite",
    "Neutral surfaces with steel-blue focus",
    createMode("#f2f3f3", "#e5e7e7", "#252728", "#5d6264", "#d3d7d7", "#fbfcfc", "#4a6a81"),
    createMode("#252728", "#323536", "#e0e1dc", "#acb1b2", "#474b4c", "#2b2e2f", "#8ea9bc"),
  ),
  createPreset(
    "cobalt",
    "Cobalt",
    "Deep ink with confident cobalt controls",
    createMode("#eef2f5", "#e0e7ec", "#222b35", "#576675", "#cbd6de", "#f8fafc", "#3e6896"),
    createMode("#222b35", "#2e3945", "#dde5eb", "#a9b6c1", "#43515e", "#27323d", "#76a6d9"),
  ),
  createPreset(
    "ocean",
    "Ocean",
    "Blue-green charcoal with aqua focus",
    createMode("#edf3f1", "#dde8e4", "#223033", "#566966", "#c9d9d4", "#f8fbfa", "#406d66"),
    createMode("#223033", "#2d3d3f", "#d5e1dc", "#a5b8b2", "#415456", "#273638", "#7fb7ad"),
  ),
  createPreset(
    "ember",
    "Ember",
    "Warm charcoal with restrained amber",
    createMode("#f4efe9", "#e7ded5", "#302b28", "#6a6058", "#d9cbbf", "#fcf9f5", "#865823"),
    createMode("#302b28", "#3d3530", "#e5d9cc", "#b7aa9d", "#554941", "#372f2b", "#d6a264"),
  ),
  createPreset(
    "rose",
    "Rose",
    "Plum graphite with dusty rose focus",
    createMode("#f4eef0", "#e7dce0", "#30292d", "#6c5d64", "#d8c9ce", "#fcf8fa", "#805565"),
    createMode("#30292d", "#3d3237", "#e4d8dc", "#b7a7ae", "#55464d", "#372e32", "#c493a7"),
  ),
  createPreset(
    "violet",
    "Violet ink",
    "Neutral ink with a quiet violet accent",
    createMode("#f1eff5", "#e2dfea", "#292830", "#625f70", "#d0ccd9", "#faf9fc", "#655d86"),
    createMode("#292830", "#35333e", "#dfdce6", "#ada8bb", "#494653", "#2f2d37", "#a8a0cb"),
  ),
  createPreset(
    "mono",
    "Monochrome",
    "Grayscale surfaces with pure tonal focus",
    createMode("#f2f2ef", "#e4e5e1", "#282a2a", "#606362", "#d2d4d0", "#fbfbf9", "#555a58"),
    createMode("#282a2a", "#353737", "#e0e0dc", "#adafac", "#494c4b", "#2e3030", "#b8bbb7"),
  ),
  createPreset(
    "canopy",
    "Canopy",
    "Deep forest surfaces with lichen focus",
    createMode("#eff3ec", "#dee7d9", "#27342e", "#5a6860", "#ccd8c6", "#f9fbf7", "#506c3f"),
    createMode("#27342e", "#314239", "#d8dfd2", "#a8b4a5", "#45584d", "#2c3932", "#96ba74"),
  ),
  createPreset(
    "redline",
    "Redline",
    "Asphalt neutrals with measured red controls",
    createMode("#f4eeee", "#e7dddd", "#322f2f", "#6a5f5f", "#d8caca", "#fcf9f9", "#a4423c"),
    createMode("#322f2f", "#403b3b", "#e4dcdc", "#b7aaaa", "#585050", "#383434", "#e2938a"),
  ),
  createPreset(
    "blueprint",
    "Blueprint",
    "Drafting blue with precise cyan focus",
    createMode("#edf2f5", "#dce6eb", "#26343c", "#566770", "#c8d6dd", "#f8fbfc", "#306c7e"),
    createMode("#26343c", "#30434c", "#d8e2e7", "#a6b7bf", "#435963", "#2b3a42", "#72b9ca"),
  ),
]);

export const THEME_PRESET_IDS = Object.freeze(THEME_PRESETS.map((preset) => preset.id));

export function normalizeThemePreset(value) {
  return THEME_PRESET_IDS.includes(value) ? value : DEFAULT_THEME_PRESET;
}

export function getThemePreset(value) {
  const normalized = normalizeThemePreset(value);
  return THEME_PRESETS.find((preset) => preset.id === normalized) ?? THEME_PRESETS[0];
}

export function normalizeColorScheme(value, legacyDarkMode = true) {
  if (COLOR_SCHEMES.includes(value)) return value;
  return legacyDarkMode === false ? "light" : "dark";
}

export function resolveColorScheme(colorScheme, systemTheme = getSystemTheme()) {
  const normalized = normalizeColorScheme(colorScheme);
  if (normalized === "system") return systemTheme === "light" ? "light" : "dark";
  return normalized;
}

export function getSystemTheme() {
  if (typeof document !== "undefined") {
    const cached = document.documentElement.dataset.systemTheme;
    if (cached === "light" || cached === "dark") return cached;
  }

  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  return "dark";
}

function hexToRgbChannels(value) {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(value);
  if (!match) return "217, 121, 82";
  return `${Number.parseInt(match[1], 16)}, ${Number.parseInt(match[2], 16)}, ${Number.parseInt(match[3], 16)}`;
}

function applyThemeTokens(themePreset, resolvedTheme) {
  if (typeof document === "undefined") return;

  const preset = getThemePreset(themePreset);
  const mode = preset.modes[resolvedTheme === "light" ? "light" : "dark"];
  const root = document.documentElement;
  const tokenValues = {
    "--mg-bg": mode.background,
    "--mg-surface": mode.surface,
    "--mg-fg": mode.foreground,
    "--mg-primary": mode.primary,
    "--mg-primary-rgb": hexToRgbChannels(mode.primary),
    "--mg-secondary": mode.surface,
    "--mg-muted": mode.muted,
    "--mg-border": mode.border,
    "--mg-destructive": resolvedTheme === "light" ? "#b94842" : "#dc7c72",
    "--mg-input-bg": mode.input,
    "--mg-scroll-thumb": `color-mix(in srgb, ${mode.muted} 34%, transparent)`,
    "--panel-surface": mode.surface,
    "--panel-surface-strong": mode.border,
    "--panel-stroke": mode.border,
    "--panel-accent": mode.primary,
    "--panel-accent-soft": `color-mix(in srgb, ${mode.primary} 18%, transparent)`,
    "--panel-ink": mode.foreground,
    "--es-success": mode.primary,
    "--es-success-rgb": hexToRgbChannels(mode.primary),
    "--es-info": mode.primary,
    "--es-border": mode.border,
  };

  Object.entries(tokenValues).forEach(([property, value]) => {
    root.style.setProperty(property, value);
  });
}

export function applyColorScheme(colorScheme, legacyDarkMode = true) {
  const normalized = normalizeColorScheme(colorScheme, legacyDarkMode);
  const resolved = resolveColorScheme(normalized);

  if (typeof document !== "undefined") {
    const root = document.documentElement;
    const themePreset = normalizeThemePreset(root.dataset.themePreset);
    root.dataset.colorScheme = normalized;
    root.dataset.resolvedTheme = resolved;
    root.dataset.themePreset = themePreset;
    root.classList.toggle("dark", resolved === "dark");
    applyThemeTokens(themePreset, resolved);
  }

  return { colorScheme: normalized, resolvedTheme: resolved };
}

export function applyThemePreset(themePreset) {
  const normalized = normalizeThemePreset(themePreset);

  if (typeof document !== "undefined") {
    const root = document.documentElement;
    const resolvedTheme = root.dataset.resolvedTheme === "light" ? "light" : "dark";
    root.dataset.themePreset = normalized;
    applyThemeTokens(normalized, resolvedTheme);
  }

  return normalized;
}

export function applyAppearance({ colorScheme, themePreset, legacyDarkMode = true } = {}) {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.themePreset = normalizeThemePreset(themePreset);
  }
  const appearance = applyColorScheme(colorScheme, legacyDarkMode);
  return { ...appearance, themePreset: normalizeThemePreset(themePreset) };
}

export function setSystemTheme(theme) {
  if (theme !== "light" && theme !== "dark") return;
  if (typeof document === "undefined") return;

  document.documentElement.dataset.systemTheme = theme;
  if (document.documentElement.dataset.colorScheme === "system") {
    applyColorScheme("system");
  }
}
