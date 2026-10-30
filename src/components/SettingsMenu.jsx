import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Search, X, Settings, Car, AlertTriangle, Monitor, Keyboard, Palette, Info, RefreshCw, Download, CheckCircle2, AlertCircle, Loader, Stamp, Bug, Lightbulb, Sparkles, Aperture, UserRound, ShieldCheck } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { exists as fsExists } from "@tauri-apps/plugin-fs";
import HotkeyInput from "./HotkeyInput";
import WatermarkSettings from "./WatermarkSettings";
import StudioDefaultsSettings from "./StudioDefaultsSettings";
import CortexAccountSettings from "./CortexAccountSettings";
import UsageStatsSettings from "./UsageStatsSettings";
import { ColorField } from "./SettingsColorField";
import { Toggle } from "./ui/toggle";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import cortexLogo from "../../src-tauri/icons/128x128@2x.png";
import "./SettingsMenu.css";
import {
  DEFAULT_HOTKEYS,
  HOTKEY_CATEGORIES,
  HOTKEY_LABELS,
  findDuplicateHotkeys,
  findHotkeyConflict,
  formatHotkey,
  mergeHotkeys,
} from "../lib/hotkeys";
import { emitPrefsUpdated, loadPrefs, sanitizeStoredDefaults, savePrefs } from "../lib/prefs";
import {
  THEME_PRESETS,
  applyAppearance,
  applyColorScheme,
  applyThemePreset,
  normalizeColorScheme,
  normalizeThemePreset,
  resolveColorScheme,
} from "../lib/theme";
import { hasSeenWhatsNew, hasNotesForAppVersion, getAppVersion } from "../lib/changelog";
import { useUpdateChecker } from "../lib/updater";
import { normalizeWatermarkConfig } from "../lib/watermark";
import {
  normalizeLightDefaults,
  normalizePlateDefault,
  normalizeShowroomDefaults,
  normalizeSteeringDefault,
} from "../lib/studio-defaults";
import { BUILT_IN_DEFAULTS } from "../lib/settings-defaults";
import {
  CAPTURE_ANGLES,
  CAPTURE_SIZES,
  CAPTURE_ZOOM_MAX,
  CAPTURE_ZOOM_MIN,
  normalizeCaptureAngles,
  normalizeCaptureSize,
  normalizeCaptureZoom,
} from "../lib/capture-settings";
import { PREVIEW_DETAIL_LEVELS, normalizePreviewDetail } from "../lib/preview-detail";
import { OUTPUT_PRESETS, normalizeOutputPreset } from "../lib/photo-mode";


const HOME_SORT_OPTIONS = [
  ["recent", "Last opened"],
  ["name", "Name"],
  ["type", "Type"],
];

const MIN_UI_SCALE = 0.5;
const MAX_UI_SCALE = 1.4;

function clampUiScale(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return BUILT_IN_DEFAULTS.uiScale;
  return Math.min(MAX_UI_SCALE, Math.max(MIN_UI_SCALE, num));
}

function normalizeAutoTemplateExportFormat(value) {
  if (value === "png" || value === "psd_png") return value;
  return BUILT_IN_DEFAULTS.autoTemplateExportFormat;
}

function normalizeCaptureDefaults(source) {
  return {
    captureAngles: normalizeCaptureAngles(source.captureAngles),
    captureZoom: normalizeCaptureZoom(source.captureZoom),
    captureSize: normalizeCaptureSize(source.captureSize),
    photoOutput: normalizeOutputPreset(source.photoOutput),
    previewDetail: normalizePreviewDetail(source.previewDetail),
  };
}

// Studio defaults (Settings > Studio) clamped to values the workspaces accept.
function normalizeStudioDefaults(source) {
  const light = normalizeLightDefaults(source);
  return {
    lightIntensity: light.intensity,
    lightAzimuth: light.azimuth,
    lightElevation: light.elevation,
    showroom: normalizeShowroomDefaults(source.showroom),
    licensePlate: normalizePlateDefault(source.licensePlate),
    steeringAngle: normalizeSteeringDefault(source.steeringAngle),
  };
}

function getStoredDefaults() {
  const prefs = loadPrefs();
  const stored = sanitizeStoredDefaults(prefs?.defaults);
  const merged = { ...BUILT_IN_DEFAULTS, ...stored };
  const colorScheme = normalizeColorScheme(merged.colorScheme, merged.darkMode);
  return {
    ...merged,
    colorScheme,
    themePreset: normalizeThemePreset(merged.themePreset),
    darkMode: resolveColorScheme(colorScheme) === "dark",
    uiScale: clampUiScale(merged.uiScale),
    autoTemplateExportFormat: normalizeAutoTemplateExportFormat(merged.autoTemplateExportFormat),
    watermark: normalizeWatermarkConfig(merged.watermark),
    ...normalizeStudioDefaults(merged),
    ...normalizeCaptureDefaults(merged),
    homeSort: HOME_SORT_OPTIONS.some(([id]) => id === merged.homeSort) ? merged.homeSort : "recent",
    reduceMotion: merged.reduceMotion === "always" ? "always" : "system",
  };
}

// An imported watermark logo can be megabytes of base64; compare a short
// fingerprint instead of re-serializing it on every slider move.
function signatureReplacer(key, value) {
  if (key === "dataUrl" && typeof value === "string") return `${value.length}:${value.slice(-48)}`;
  return value;
}

function settingsSignature(defaults, hotkeys) {
  return JSON.stringify({ defaults, hotkeys }, signatureReplacer);
}

function getStoredHotkeys() {
  const prefs = loadPrefs();
  const stored = prefs?.hotkeys && typeof prefs.hotkeys === "object" ? prefs.hotkeys : {};
  return mergeHotkeys(stored, DEFAULT_HOTKEYS);
}

const THEME_OPTIONS = [
  { id: "system", label: "System", description: "Match your operating system" },
  { id: "light", label: "Light", description: "Bright, neutral studio surfaces" },
  { id: "dark", label: "Dark", description: "Lower-glare workspace surfaces" },
];

const SETTINGS_SECTION_GROUPS = [
  {
    id: "workspace",
    label: "Workspace",
    items: [
      {
        id: "general",
        label: "System",
        description: "Interface scaling and core behavior.",
        icon: Monitor,
        keywords: ["UI scale", "Interface size>UI scale", "Zoom>UI scale", "Show projects", "Home>Show projects", "Default order", "Sort>Default order", "Confirm before deleting", "Reopen tabs on launch", "Restore>Reopen tabs on launch", "Session>Reopen tabs on launch", "Capture folder", "Screenshots>Capture folder", "Variant and template folder", "Export folder>Variant and template folder", "Auto template format", "PSD>Auto template format", "PNG>Auto template format", "Replace existing files", "Overwrite>Replace existing files", "Capture size", "Resolution>Capture size", "4K>Capture size", "Capture angles", "Capture framing", "Zoom>Capture framing", "Photo Mode size", "Reset all settings"],
      },
      {
        id: "viewer",
        label: "Viewer",
        description: "Interaction and rendering defaults.",
        icon: Car,
        keywords: ["Start in exterior only", "Load EUP textures", "Standard model warning", "_hi>Standard model warning", "Camera presets in the panel", "Variant Builder layers at the bottom", "Layers>Variant Builder layers at the bottom", "Preview detail", "Performance>Preview detail", "Resolution>Preview detail", "Sharp>Preview detail", "Zoom toward cursor", "Scroll>Zoom toward cursor", "Render effects", "3D grid", "Ground shadows", "Ambient occlusion"],
      },
      {
        id: "studio",
        label: "Studio",
        description: "Showroom, lighting, plate, and steering that new work starts with.",
        icon: Aperture,
        keywords: ["Showroom", "Open in", "Light from", "Spotlight", "Floor reflections", "Light beam", "Floor", "Rim light", "Dark room", "Light intensity", "Light direction", "Light height", "Plate style", "Plate text", "Front wheel angle", "Steering>Front wheel angle"],
      },
      {
        id: "appearance",
        label: "Appearance",
        description: "Theme, window chrome, and studio colors.",
        icon: Palette,
        keywords: ["Color scheme", "Theme>Color scheme", "Dark mode>Color scheme", "Light mode>Color scheme", "Studio palette", "Preset>Studio palette", "Window controls", "Reduce motion", "Animations>Reduce motion", "Show shortcut keys", "Keycaps>Show shortcut keys", "Starting colors", "Base body>Starting colors", "Base background>Starting colors", "Auto template fill>Starting colors", "Auto template background>Starting colors"],
      },
      {
        id: "watermark",
        label: "Watermark",
        description: "Stamp captures with your text or logo.",
        icon: Stamp,
        keywords: ["Stamp captures", "Presets", "Content", "Text", "Logo", "Logo size", "Match watermark color", "Font", "Weight", "Italic", "Capitals", "Letter spacing", "Finish", "Opacity", "Size", "Rotation", "Placement", "Position", "Edge margin", "Tile spacing"],
      },
    ],
  },
  {
    id: "input",
    label: "Input",
    items: [
      {
        id: "hotkeys",
        label: "Shortcuts",
        description: "Global keyboard configurations.",
        icon: Keyboard,
        keywords: ["Keyboard", "Hotkeys", "Keybindings", ...Object.values(HOTKEY_LABELS)],
      },
    ],
  },
  {
    id: "account",
    label: "Account",
    items: [
      {
        id: "account",
        label: "Cortex account",
        description: "Optional. Sign in to use Juno in the Sirens editor.",
        icon: UserRound,
        keywords: ["Sign in>Not signed in", "Sign out", "Discord", "Juno", "Status>Juno", "Ready>Juno", "Plan>This month", "This month", "Allowance>This month", "Usage>This month", "Used>This month", "Resets>This month"],
      },
    ],
  },
  {
    id: "support",
    label: "Support",
    items: [
      {
        id: "privacy",
        label: "Privacy",
        description: "Anonymous usage stats and what they send.",
        icon: ShieldCheck,
        keywords: ["Usage stats>Share usage stats", "Share usage stats", "Analytics>Share usage stats", "Telemetry>Share usage stats", "Tracking>Share usage stats", "Usage ID", "New ID>Usage ID", "Privacy policy"],
      },
      {
        id: "about",
        label: "About",
        description: "Version, updates, release notes, and feedback.",
        icon: Info,
        keywords: ["Version>Updates", "Software update>Updates", "Check for updates>Check automatically", "Check automatically", "Changelog", "Release notes>Changelog", "Show after updates", "Feedback", "Send feedback", "Report a bug>Send feedback", "Request a feature>Send feedback", "Console logs>Attach console logs by default"],
      },
    ],
  },
];

const SETTINGS_SECTIONS = SETTINGS_SECTION_GROUPS.flatMap((group) => group.items);

const SAVE_DELAY_MS = 350;

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

function normalizeQuery(value) {
  return String(value || "").trim().toLowerCase();
}

function searchSections(query) {
  const needle = normalizeQuery(query);
  if (!needle) return [];
  return SETTINGS_SECTIONS.flatMap((section) => {
    const hits = [...new Set(
      section.keywords
        .map((keyword) => keyword.split(">"))
        .filter(([term]) => term.toLowerCase().includes(needle))
        .map(([term, target]) => target ?? term),
    )];
    const named = section.label.toLowerCase().includes(needle);
    if (!named && !hits.length) return [];
    return [{ section, hits }];
  });
}

function isTypingTarget(target) {
  return Boolean(target?.closest?.('input, textarea, select, [contenteditable="true"]'));
}

function ThemeChoice({ option, selected, onSelect }) {
  return (
    <button
      type="button"
      className={`settings-theme-choice ${selected ? "is-selected" : ""}`}
      aria-pressed={selected}
      onClick={() => onSelect(option.id)}
    >
      <span className={`settings-theme-preview is-${option.id}`} aria-hidden="true">
        <span className="settings-theme-preview-rail">
          <span />
          <span />
          <span />
        </span>
        <span className="settings-theme-preview-canvas">
          <span className="settings-theme-preview-toolbar" />
          <span className="settings-theme-preview-line is-wide" />
          <span className="settings-theme-preview-line" />
          <span className="settings-theme-preview-control" />
        </span>
      </span>
      <span className="settings-theme-choice-label">{option.label}</span>
    </button>
  );
}

function ThemePresetChoice({ option, scheme, selected, onSelect }) {
  const mode = option.modes[scheme] ?? option.modes.dark;
  const previewStyle = {
    "--theme-preset-bg": mode.background,
    "--theme-preset-surface": mode.surface,
    "--theme-preset-ink": mode.foreground,
    "--theme-preset-accent": mode.primary,
  };

  return (
    <label
      className={`settings-preset-choice ${selected ? "is-selected" : ""}`}
      style={previewStyle}
      title={option.description}
    >
      <input
        type="radio"
        name="theme-preset"
        value={option.id}
        checked={selected}
        onChange={() => onSelect(option.id)}
      />
      <span className="settings-preset-preview" aria-hidden="true">
        <span className="settings-preset-preview-rail">
          <span />
          <span />
          <span />
        </span>
        <span className="settings-preset-preview-workspace">
          <span className="settings-preset-preview-title" />
          <span className="settings-preset-preview-line is-wide" />
          <span className="settings-preset-preview-line" />
          <span className="settings-preset-preview-action" />
        </span>
      </span>
      <span className="settings-preset-choice-label">{option.name}</span>
    </label>
  );
}

/**
 * SettingsMenu — self-contained settings panel.
 * Reads/writes prefs directly via loadPrefs()/savePrefs().
 * Shell renders this in the chrome bar; it emits onSettingsSaved when prefs are persisted.
 */
export default function SettingsMenu({
  pageOpen = false,
  onOpenChange,
  onSettingsSaved,
  onOpenReleaseNotes,
}) {
  const open = Boolean(pageOpen);
  const [hoveringIcon, setHoveringIcon] = useState(false);
  const [activeSection, setActiveSection] = useState("general");
  const [confirmReset, setConfirmReset] = useState(false);
  const [previewFolderExists, setPreviewFolderExists] = useState(true);
  const [saveError, setSaveError] = useState("");
  const [query, setQuery] = useState("");
  const [uiScaleInput, setUiScaleInput] = useState(null);
  const updater = useUpdateChecker();
  const prefersReducedMotion = useReducedMotion();

  const [draft, setDraft] = useState(() => getStoredDefaults());
  const [hotkeysDraft, setHotkeysDraft] = useState(() => getStoredHotkeys());
  const [savedSignature, setSavedSignature] = useState(() =>
    settingsSignature(getStoredDefaults(), getStoredHotkeys()),
  );
  const dialogRef = useRef(null);
  const bodyRef = useRef(null);
  const searchRef = useRef(null);
  const settingsButtonRef = useRef(null);
  const returnFocusRef = useRef(null);
  const resetButtonRef = useRef(null);
  const wasOpenRef = useRef(false);
  const closeAnywayRef = useRef(false);
  const savedSignatureRef = useRef(savedSignature);
  savedSignatureRef.current = savedSignature;
  const latestRef = useRef({ draft, hotkeysDraft });
  latestRef.current = {
    draft: uiScaleInput === null ? draft : { ...draft, uiScale: clampUiScale(uiScaleInput) },
    hotkeysDraft,
  };

  const setOpen = useCallback((nextOpen) => {
    onOpenChange?.(Boolean(nextOpen));
  }, [onOpenChange]);

  const isTauriRuntime =
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__ !== "undefined";

  const persist = useCallback((nextDraft, nextHotkeys) => {
    const normalizedUiScale = clampUiScale(nextDraft.uiScale);
    const normalizedDraft = {
      ...nextDraft,
      colorScheme: normalizeColorScheme(nextDraft.colorScheme, nextDraft.darkMode),
      themePreset: normalizeThemePreset(nextDraft.themePreset),
      uiScale: normalizedUiScale,
      autoTemplateExportFormat: normalizeAutoTemplateExportFormat(nextDraft.autoTemplateExportFormat),
      watermark: normalizeWatermarkConfig(nextDraft.watermark),
      ...normalizeStudioDefaults(nextDraft),
      ...normalizeCaptureDefaults(nextDraft),
    };
    normalizedDraft.darkMode = resolveColorScheme(normalizedDraft.colorScheme) === "dark";
    const prefs = loadPrefs() || {};
    if (!savePrefs({ ...prefs, defaults: normalizedDraft, hotkeys: nextHotkeys })) {
      setSaveError(
        normalizedDraft.watermark?.image
          ? "Couldn't save. Storage may be full; try a smaller watermark logo. Closing will discard unsaved changes."
          : "Couldn't save. Storage may be full or unavailable. Closing will discard unsaved changes.",
      );
      closeAnywayRef.current = true;
      return false;
    }
    closeAnywayRef.current = false;
    savedSignatureRef.current = settingsSignature(nextDraft, nextHotkeys);
    setSaveError("");
    emitPrefsUpdated();
    document.documentElement.style.setProperty("--es-ui-scale", String(normalizedUiScale));
    window.dispatchEvent(
      new CustomEvent("cortex:ui-scale-changed", { detail: { scale: normalizedUiScale } }),
    );
    setSavedSignature(settingsSignature(nextDraft, nextHotkeys));
    onSettingsSaved?.();
    return true;
  }, [onSettingsSaved]);

  const draftSignature = useMemo(
    () => settingsSignature(draft, hotkeysDraft),
    [draft, hotkeysDraft],
  );
  const hasChanges = draftSignature !== savedSignature;

  useEffect(() => {
    if (!open || !hasChanges) return undefined;
    const timer = window.setTimeout(() => persist(draft, hotkeysDraft), SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [draft, hotkeysDraft, hasChanges, open, persist]);

  const flushPending = useCallback(() => {
    const { draft: latestDraft, hotkeysDraft: latestHotkeys } = latestRef.current;
    if (settingsSignature(latestDraft, latestHotkeys) === savedSignatureRef.current) return true;
    return persist(latestDraft, latestHotkeys);
  }, [persist]);

  const closeSettings = useCallback(() => {
    const discardArmed = closeAnywayRef.current;
    if (!flushPending() && !discardArmed) return;
    setOpen(false);
  }, [flushPending, setOpen]);

  useEffect(() => {
    if (open) {
      const nextDraft = getStoredDefaults();
      const nextHotkeys = getStoredHotkeys();
      setDraft(nextDraft);
      setHotkeysDraft(nextHotkeys);
      setSavedSignature(settingsSignature(nextDraft, nextHotkeys));
      setConfirmReset(false);
      setSaveError("");
      setQuery("");
      setUiScaleInput(null);
      closeAnywayRef.current = false;
      returnFocusRef.current = document.activeElement;
      window.setTimeout(() => dialogRef.current?.focus({ preventScroll: true }), 0);
    } else if (wasOpenRef.current) {
      flushPending();
      const stored = getStoredDefaults();
      applyAppearance({
        colorScheme: stored.colorScheme,
        themePreset: stored.themePreset,
        legacyDarkMode: stored.darkMode,
      });
      const previous = returnFocusRef.current;
      const dialogNode = dialogRef.current;
      window.setTimeout(() => {
        const active = document.activeElement;
        if (active && active !== document.body && !dialogNode?.contains(active)) return;
        const target = previous?.isConnected ? previous : settingsButtonRef.current;
        target?.focus?.({ preventScroll: true });
      }, 0);
    }
    wasOpenRef.current = open;
  }, [flushPending, open]);

  const focusResetButton = () => {
    window.requestAnimationFrame(() => resetButtonRef.current?.focus({ preventScroll: true }));
  };

  const cancelReset = useCallback(() => {
    setConfirmReset(false);
    window.requestAnimationFrame(() => resetButtonRef.current?.focus({ preventScroll: true }));
  }, []);

  const performReset = () => {
    setDraft({ ...BUILT_IN_DEFAULTS });
    setHotkeysDraft({ ...DEFAULT_HOTKEYS });
    setUiScaleInput(null);
    setConfirmReset(false);
    focusResetButton();
    applyAppearance({
      colorScheme: BUILT_IN_DEFAULTS.colorScheme,
      themePreset: BUILT_IN_DEFAULTS.themePreset,
      legacyDarkMode: BUILT_IN_DEFAULTS.darkMode,
    });
  };

  const selectColorScheme = useCallback((colorScheme) => {
    const normalized = normalizeColorScheme(colorScheme);
    const { resolvedTheme } = applyColorScheme(normalized);
    setDraft((prev) => ({
      ...prev,
      colorScheme: normalized,
      darkMode: resolvedTheme === "dark",
    }));
  }, []);

  const selectThemePreset = useCallback((themePreset) => {
    const normalized = normalizeThemePreset(themePreset);
    applyThemePreset(normalized);
    setDraft((prev) => ({ ...prev, themePreset: normalized }));
  }, []);

  const updateStudioDefaults = useCallback((patch) => {
    setDraft((prev) => ({ ...prev, ...patch }));
  }, []);

  const updateWatermark = useCallback((watermark) => {
    setDraft((prev) => ({ ...prev, watermark }));
  }, []);

  const commitUiScale = useCallback(() => {
    if (uiScaleInput === null) return;
    setDraft((prev) => ({ ...prev, uiScale: clampUiScale(uiScaleInput) }));
    setUiScaleInput(null);
  }, [uiScaleInput]);

  const openFromSettings = useCallback((eventName, detail) => {
    closeSettings();
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent(eventName, detail ? { detail } : undefined));
    }, 220);
  }, [closeSettings]);

  const results = useMemo(() => searchSections(query), [query]);
  const searching = normalizeQuery(query).length > 0;

  const changeQuery = useCallback((value) => {
    setQuery(value);
    const matches = searchSections(value);
    if (matches.length && !matches.some((match) => match.section.id === activeSection)) {
      setActiveSection(matches[0].section.id);
    }
  }, [activeSection]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const { key, target } = event;
      if (key === "Escape") {
        if (event.defaultPrevented) return;
        event.preventDefault();
        if (target === searchRef.current && searchRef.current.value) {
          changeQuery("");
          return;
        }
        if (confirmReset) {
          cancelReset();
          return;
        }
        closeSettings();
        return;
      }
      if (key === "Tab") {
        const focusable = [...dialog.querySelectorAll(FOCUSABLE)].filter((node) => node.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!dialog.contains(document.activeElement) || document.activeElement === dialog) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !isTypingTarget(target)) {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [cancelReset, changeQuery, closeSettings, confirmReset, open]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!open || !body) return;
    const needle = normalizeQuery(query);
    const hits = needle
      ? (searchSections(query).find((result) => result.section.id === activeSection)?.hits ?? []).map(normalizeQuery)
      : [];
    const matches = (text) => {
      const value = normalizeQuery(text);
      return Boolean(needle) && (value.includes(needle) || hits.includes(value));
    };
    let first = null;
    body.querySelectorAll(".settings-panel-title, .settings-row").forEach((node) => {
      const hit = node.classList.contains("settings-row")
        ? matches(node.querySelector(".settings-row-title")?.textContent) ||
          (Boolean(needle) && normalizeQuery(node.querySelector(".settings-row-desc")?.textContent).includes(needle))
        : matches(node.textContent);
      node.toggleAttribute("data-match", hit);
      if (hit && !first) first = node;
    });
    first?.scrollIntoView({ block: "nearest" });
  }, [activeSection, open, query]);

  useEffect(() => {
    if (!open || !isTauriRuntime) return;

    const previewFolder = typeof draft.previewFolder === "string" ? draft.previewFolder.trim() : "";
    if (!previewFolder) {
      setPreviewFolderExists(true);
      return;
    }

    let cancelled = false;
    const checkPreviewFolder = async () => {
      try {
        const exists = await fsExists(previewFolder);
        if (!cancelled) setPreviewFolderExists(Boolean(exists));
      } catch {
        // A failed check is not proof the folder is gone; only warn on a definite "no".
        if (!cancelled) setPreviewFolderExists(true);
      }
    };

    checkPreviewFolder();
    return () => {
      cancelled = true;
    };
  }, [draft.previewFolder, isTauriRuntime, open]);

  useEffect(() => {
    const handleOpen = () => setOpen(true);
    const handleClose = () => closeSettings();
    const handleNav = (e) => {
      if (e.detail?.section) {
        setActiveSection(e.detail.section === "experimental" ? "about" : e.detail.section);
      }
    };

    window.addEventListener("cortex:open-settings", handleOpen);
    window.addEventListener("cortex:close-settings", handleClose);
    window.addEventListener("cortex:nav-settings", handleNav);

    return () => {
      window.removeEventListener("cortex:open-settings", handleOpen);
      window.removeEventListener("cortex:close-settings", handleClose);
      window.removeEventListener("cortex:nav-settings", handleNav);
    };
  }, [closeSettings, setOpen]);

  const activeMeta = SETTINGS_SECTIONS.find((section) => section.id === activeSection) ?? SETTINGS_SECTIONS[0];

  // Keys already bound to another action wait here until the user swaps or
  // cancels. The offer belongs to the draft it was made against, so reopening
  // Settings or changing another shortcut drops it.
  const [hotkeyConflict, setHotkeyConflict] = useState(null);
  const pendingConflict = hotkeyConflict?.draft === hotkeysDraft ? hotkeyConflict : null;
  const duplicateHotkeys = useMemo(() => findDuplicateHotkeys(hotkeysDraft), [hotkeysDraft]);

  const updateHotkey = (action, hotkey) => {
    const other = findHotkeyConflict(hotkeysDraft, action, hotkey);
    if (other) {
      setHotkeyConflict({ action, hotkey, other, draft: hotkeysDraft });
      return;
    }
    setHotkeyConflict(null);
    setHotkeysDraft((prev) => ({ ...prev, [action]: hotkey }));
  };

  const swapHotkey = () => {
    if (!pendingConflict) return;
    const { action, hotkey, other } = pendingConflict;
    setHotkeysDraft((prev) => ({
      ...prev,
      [action]: hotkey,
      [other]: prev[action]?.key ? { ...prev[action] } : { key: "", ctrl: false, alt: false, shift: false },
    }));
    setHotkeyConflict(null);
  };

  const clearHotkey = (action) => {
    setHotkeysDraft((prev) => ({
      ...prev,
      [action]: { key: "", ctrl: false, alt: false, shift: false },
    }));
  };

  const resetAllHotkeys = () => {
    setHotkeysDraft({ ...DEFAULT_HOTKEYS });
  };

  const toggleOpen = () => {
    if (open) closeSettings();
    else setOpen(true);
  };

  const handleSelectPreviewFolder = useCallback(async () => {
    if (!isTauriRuntime) return;
    try {
      const selected = await openDialog({ directory: true, title: "Select Preview Export Folder" });
      if (typeof selected === "string") {
        setDraft((p) => ({ ...p, previewFolder: selected }));
      }
    } catch {}
  }, [isTauriRuntime]);

  const handleSelectVariantExportFolder = useCallback(async () => {
    if (!isTauriRuntime) return;
    try {
      const selected = await openDialog({ directory: true, title: "Select Variant Export Folder" });
      if (typeof selected === "string") {
        setDraft((p) => ({ ...p, variantExportFolder: selected }));
      }
    } catch {}
  }, [isTauriRuntime]);

  const uiScaleValue = clampUiScale(uiScaleInput ?? draft.uiScale);
  const dialogTransition = { duration: prefersReducedMotion ? 0 : 0.18, ease: [0.2, 0.8, 0.2, 1] };

  const renderNavItem = (section, hint) => {
    const Icon = section.icon;
    const isActive = activeSection === section.id;
    return (
      <button
        key={section.id}
        type="button"
        className={`settings-nav-item ${isActive ? "is-active" : ""}`}
        onClick={() => setActiveSection(section.id)}
        aria-current={isActive ? "page" : undefined}
      >
        <Icon className="settings-nav-item-icon" aria-hidden="true" />
        <span className="settings-nav-item-copy">
          <span className="settings-nav-item-label">{section.label}</span>
          {hint ? <span className="settings-nav-item-hint">{hint}</span> : null}
        </span>
        {section.id === "about" && updater.available ? (
          <span className="settings-nav-item-dot" title="Update available" />
        ) : null}
      </button>
    );
  };

  return (
    <div className="settings-anchor">
      <motion.button
        ref={settingsButtonRef}
        type="button"
        className={`settings-cog ${open ? "is-active" : ""}`}
        aria-label="Settings"
        aria-pressed={open}
        title="Settings"
        onClick={toggleOpen}
        onMouseEnter={() => setHoveringIcon(true)}
        onMouseLeave={() => setHoveringIcon(false)}
      >
        <motion.span
          className="settings-cog-icon"
          animate={prefersReducedMotion ? { rotate: 0 } : hoveringIcon ? { rotate: 90 } : { rotate: 0 }}
          transition={{ duration: prefersReducedMotion ? 0 : 0.14, ease: [0.22, 1, 0.36, 1] }}
        >
          <Settings className="settings-cog-svg" />
        </motion.span>
      </motion.button>

      {typeof document !== "undefined"
        ? createPortal(
            <AnimatePresence>
              {open ? (
                <motion.div
                  key="settings"
                  className="settings-page"
                  initial={prefersReducedMotion ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={prefersReducedMotion ? { opacity: 1 } : { opacity: 0 }}
                  transition={dialogTransition}
                >
                  <div className="settings-scrim" aria-hidden="true" onPointerDown={closeSettings} />
                  <div className="settings-center">
                    <motion.div
                      ref={dialogRef}
                      className="settings-dialog"
                      role="dialog"
                      aria-modal="true"
                      aria-labelledby="settings-page-title"
                      tabIndex={-1}
                      initial={prefersReducedMotion ? false : { opacity: 0, scale: 0.985, y: 6 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, scale: 0.985, y: 6 }}
                      transition={dialogTransition}
                    >
                      <aside className="settings-nav">
                        <label className="settings-search">
                          <Search className="settings-search-icon" aria-hidden="true" />
                          <input
                            ref={searchRef}
                            className="settings-search-input"
                            type="text"
                            value={query}
                            placeholder="Search settings"
                            aria-label="Search settings"
                            spellCheck={false}
                            autoComplete="off"
                            onChange={(event) => changeQuery(event.currentTarget.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" && results.length) {
                                event.preventDefault();
                                setActiveSection(results[0].section.id);
                              }
                            }}
                          />
                          {query ? (
                            <button
                              type="button"
                              className="settings-search-clear"
                              aria-label="Clear search"
                              onClick={() => {
                                changeQuery("");
                                searchRef.current?.focus();
                              }}
                            >
                              <X aria-hidden="true" />
                            </button>
                          ) : (
                            <kbd className="cx-keycap" aria-hidden="true">/</kbd>
                          )}
                        </label>

                        <nav className="settings-nav-list custom-scrollbar" aria-label="Settings sections">
                          {searching ? (
                            results.length ? (
                              <div className="settings-nav-group">
                                <div className="settings-nav-group-label" aria-live="polite">
                                  {results.length === 1 ? "1 section" : `${results.length} sections`}
                                </div>
                                {results.map(({ section, hits }) =>
                                  renderNavItem(section, hits.slice(0, 2).join(" · ")),
                                )}
                              </div>
                            ) : (
                              <p className="settings-nav-empty" aria-live="polite">
                                Nothing matches “{query.trim()}”.
                              </p>
                            )
                          ) : (
                            SETTINGS_SECTION_GROUPS.map((group) => (
                              <div className="settings-nav-group" key={group.id}>
                                <div className="settings-nav-group-label">{group.label}</div>
                                {group.items.map((section) => renderNavItem(section))}
                              </div>
                            ))
                          )}
                        </nav>

                      </aside>

                      <main className="settings-content">
                        <header className="settings-content-header">
                          <div className="settings-crumbs">
                            <span className="settings-crumb" id="settings-page-title">Settings</span>
                            <span className="settings-crumb-sep" aria-hidden="true">/</span>
                            <h2 className="settings-content-title cx-display">{activeMeta.label}</h2>
                          </div>

                          {saveError ? (
                            <span className="settings-save-state has-error" role="alert">
                              <AlertCircle className="settings-save-icon" aria-hidden="true" />
                              {saveError}
                            </span>
                          ) : null}
                        </header>
                        <button
                          type="button"
                          className="cx-icon-btn settings-close"
                          onClick={closeSettings}
                          aria-label="Close settings"
                          title="Close (Esc)"
                        >
                          <X aria-hidden="true" />
                        </button>

                        <div
                          key={activeSection}
                          ref={bodyRef}
                          className="settings-content-body custom-scrollbar"
                        >
                            {activeSection === "account" ? (
                              <div className="settings-stack">
                                <CortexAccountSettings isTauriRuntime={isTauriRuntime} />
                              </div>
                            ) : null}

                            {/* ─── General (System) ─── */}
                            {activeSection === "general" ? (
                              <div className="settings-stack">
                                <section className="settings-panel">
                                  <div className="settings-panel-title">Interface</div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="settings-row-title">UI scale</div>
                                      <div className="settings-row-desc">Size of every panel, menu and label. Applies when you let go. Default 100%.</div>
                                    </div>
                                    <div className="settings-slider-field">
                                      <input
                                        type="range"
                                        className="settings-slider"
                                        min={MIN_UI_SCALE}
                                        max={MAX_UI_SCALE}
                                        step={0.05}
                                        value={uiScaleValue}
                                        aria-label="UI scale"
                                        onChange={(e) => setUiScaleInput(clampUiScale(parseFloat(e.target.value)))}
                                        onPointerUp={commitUiScale}
                                        onKeyUp={commitUiScale}
                                        onBlur={commitUiScale}
                                      />
                                      <span className="settings-slider-value">{Math.round(uiScaleValue * 100)}%</span>
                                    </div>
                                  </div>
                                </section>

                                <section className="settings-panel">
                                  <div className="settings-panel-title">Home</div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="settings-row-title">Show projects</div>
                                      <div className="settings-row-desc">List saved projects on Home so you can pick up where you left off</div>
                                    </div>
                                    <Toggle
                                      checked={draft.showRecents !== false}
                                      onChange={(v) => setDraft((p) => ({ ...p, showRecents: v }))}
                                      ariaLabel="Show projects on Home"
                                    />
                                  </div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="settings-row-title">Default order</div>
                                      <div className="settings-row-desc">How the project list is sorted when Home opens</div>
                                    </div>
                                    <div className="settings-seg" role="radiogroup" aria-label="Default project order">
                                      {HOME_SORT_OPTIONS.map(([value, label]) => (
                                        <button
                                          key={value}
                                          type="button"
                                          role="radio"
                                          aria-checked={draft.homeSort === value}
                                          className={`settings-seg-btn ${draft.homeSort === value ? "is-on" : ""}`}
                                          onClick={() => setDraft((p) => ({ ...p, homeSort: value }))}
                                        >
                                          {label}
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="settings-row-title">Confirm before deleting</div>
                                      <div className="settings-row-desc">Ask first when a project is deleted from Home. Files on disk are never touched.</div>
                                    </div>
                                    <Toggle
                                      checked={draft.confirmProjectDelete !== false}
                                      onChange={(v) => setDraft((p) => ({ ...p, confirmProjectDelete: v }))}
                                      ariaLabel="Confirm before deleting projects"
                                    />
                                  </div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="settings-row-title">Reopen tabs on launch</div>
                                      <div className="settings-row-desc">Bring back the tabs that were open when you last closed Cortex. Off starts on Home.</div>
                                    </div>
                                    <Toggle
                                      checked={draft.reopenTabs !== false}
                                      onChange={(v) => setDraft((p) => ({ ...p, reopenTabs: v }))}
                                      ariaLabel="Reopen tabs on launch"
                                    />
                                  </div>
                                </section>

                                  <section className="settings-panel">
                                    <div className="settings-panel-title">Exports</div>
                                    <div className="settings-row">
                                      <div className="settings-row-label">
                                        <div className="settings-row-title">Capture folder</div>
                                        <div className={`settings-row-desc ${draft.previewFolder ? "settings-path" : ""}`.trim()}>
                                          {draft.previewFolder || "Not set. You'll be asked where to save each capture."}
                                        </div>
                                      </div>
                                      {draft.previewFolder && !previewFolderExists ? null : (
                                      <div className="settings-row-actions">
                                        <button
                                          type="button"
                                          className="settings-mini"
                                          onClick={handleSelectPreviewFolder}
                                        >
                                          Browse
                                        </button>
                                        {draft.previewFolder && (
                                          <button
                                            type="button"
                                            className="settings-mini is-danger"
                                            onClick={() => setDraft((p) => ({ ...p, previewFolder: "" }))}
                                          >
                                            Clear
                                          </button>
                                        )}
                                      </div>
                                      )}
                                    </div>
                                    {draft.previewFolder && !previewFolderExists ? (
                                      <div className="settings-callout is-warning" role="alert">
                                        <AlertTriangle className="settings-callout-icon" aria-hidden="true" />
                                        <div className="settings-callout-copy">
                                          <div className="settings-callout-title">Preview folder not found</div>
                                          <div className="settings-callout-text">
                                            Captures can't be saved until you pick a folder that exists, or clear this to be asked each time.
                                          </div>
                                        </div>
                                        <div className="settings-callout-actions">
                                          <button
                                            type="button"
                                            className="cx-btn is-primary"
                                            onClick={handleSelectPreviewFolder}
                                          >
                                            Choose folder
                                          </button>
                                          <button
                                            type="button"
                                            className="cx-btn is-quiet"
                                            onClick={() => setDraft((p) => ({ ...p, previewFolder: "" }))}
                                          >
                                            Clear
                                          </button>
                                        </div>
                                      </div>
                                    ) : null}

                                    <div className="settings-row">
                                      <div className="settings-row-label">
                                        <div className="settings-row-title">Variant and template folder</div>
                                        <div className={`settings-row-desc ${draft.variantExportFolder ? "settings-path" : ""}`.trim()}>{draft.variantExportFolder || "Not set. Variant Builder and Template Generator ask for a folder on each export."}</div>
                                      </div>
                                      <div className="settings-row-actions">
                                        <button
                                          type="button"
                                          className="settings-mini"
                                          onClick={handleSelectVariantExportFolder}
                                        >
                                          Browse
                                        </button>
                                        {draft.variantExportFolder && (
                                          <button
                                            type="button"
                                            className="settings-mini is-danger"
                                            onClick={() => setDraft((p) => ({ ...p, variantExportFolder: "" }))}
                                          >
                                            Clear
                                          </button>
                                        )}
                                      </div>
                                    </div>

                                    <div className="settings-row">
                                      <div className="settings-row-label">
                                        <div className="settings-row-title">Auto template format</div>
                                        <div className="settings-row-desc">Files written when a template auto-saves</div>
                                      </div>
                                    <div className="settings-seg" role="radiogroup" aria-label="Auto template format">
                                        <button
                                          type="button"
                                          role="radio"
                                          aria-checked={draft.autoTemplateExportFormat === "psd"}
                                          className={`settings-seg-btn ${draft.autoTemplateExportFormat === "psd" ? "is-on" : ""}`}
                                          onClick={() => setDraft((p) => ({ ...p, autoTemplateExportFormat: "psd" }))}
                                        >
                                          PSD
                                        </button>
                                        <button
                                          type="button"
                                          role="radio"
                                          aria-checked={draft.autoTemplateExportFormat === "png"}
                                          className={`settings-seg-btn ${draft.autoTemplateExportFormat === "png" ? "is-on" : ""}`}
                                          onClick={() => setDraft((p) => ({ ...p, autoTemplateExportFormat: "png" }))}
                                        >
                                          PNG
                                        </button>
                                        <button
                                          type="button"
                                          role="radio"
                                          aria-checked={draft.autoTemplateExportFormat === "psd_png"}
                                          className={`settings-seg-btn ${draft.autoTemplateExportFormat === "psd_png" ? "is-on" : ""}`}
                                          onClick={() => setDraft((p) => ({ ...p, autoTemplateExportFormat: "psd_png" }))}
                                        >
                                          PSD + PNG
                                        </button>
                                      </div>
                                    </div>

                                    <div className="settings-row">
                                      <div className="settings-row-label">
                                        <div className="settings-row-title">Replace existing files</div>
                                        <div className="settings-row-desc">Skip the replace prompt for angle captures, variant exports, EUP shots and EUP thumbnails</div>
                                      </div>
                                      <Toggle
                                        checked={draft.replaceExports === true}
                                        onChange={(v) => setDraft((p) => ({ ...p, replaceExports: v }))}
                                        ariaLabel="Replace existing files without asking"
                                      />
                                    </div>
                                  </section>

                                  <section className="settings-panel">
                                    <div className="settings-panel-title">Captures</div>
                                    <div className="settings-row">
                                      <div className="settings-row-label">
                                        <div className="settings-row-title">Capture size</div>
                                        <div className="settings-row-desc">Size of angle captures and Save this view. Multi lineups always use Window.</div>
                                      </div>
                                      <Select value={draft.captureSize} onValueChange={(value) => setDraft((p) => ({ ...p, captureSize: value }))}>
                                        <SelectTrigger className="settings-select" aria-label="Capture size"><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                          {CAPTURE_SIZES.map((size) => (
                                            <SelectItem key={size.id} value={size.id}>{size.label}</SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                    </div>
                                    <div className="settings-row">
                                      <div className="settings-row-label">
                                        <div className="settings-row-title">Capture angles</div>
                                        <div className="settings-row-desc">Angles that are on when a Vehicle or EUP workspace opens</div>
                                      </div>
                                      <div className="settings-chips" role="group" aria-label="Default capture angles">
                                        {CAPTURE_ANGLES.map((angle) => {
                                          const on = draft.captureAngles.includes(angle.key);
                                          const last = on && draft.captureAngles.length === 1;
                                          return (
                                            <button
                                              key={angle.key}
                                              type="button"
                                              aria-pressed={on}
                                              aria-disabled={last || undefined}
                                              title={last ? "At least one angle stays on" : undefined}
                                              className={`settings-chip ${on ? "is-on" : ""}`}
                                              onClick={() => {
                                                if (last) return;
                                                setDraft((p) => ({
                                                  ...p,
                                                  captureAngles: normalizeCaptureAngles(
                                                    on ? p.captureAngles.filter((key) => key !== angle.key) : [...p.captureAngles, angle.key],
                                                  ),
                                                }));
                                              }}
                                            >
                                              {angle.label}
                                            </button>
                                          );
                                        })}
                                      </div>
                                    </div>
                                    <div className="settings-row">
                                      <div className="settings-row-label">
                                        <div className="settings-row-title">Capture framing</div>
                                        <div className="settings-row-desc">How tightly angle captures frame the vehicle when a workspace opens</div>
                                      </div>
                                      <div className="settings-slider-field">
                                        <input
                                          type="range"
                                          className="settings-slider"
                                          min={CAPTURE_ZOOM_MIN}
                                          max={CAPTURE_ZOOM_MAX}
                                          step={0.02}
                                          value={draft.captureZoom}
                                          aria-label="Default capture framing"
                                          onChange={(e) => setDraft((p) => ({ ...p, captureZoom: normalizeCaptureZoom(e.target.value) }))}
                                        />
                                        <span className="settings-slider-value">{draft.captureZoom.toFixed(2)}×</span>
                                      </div>
                                    </div>
                                    <div className="settings-row">
                                      <div className="settings-row-label">
                                        <div className="settings-row-title">Photo Mode size</div>
                                        <div className="settings-row-desc">Output size a new Photo Mode scene starts with. Saved scenes keep their own.</div>
                                      </div>
                                      <Select value={draft.photoOutput} onValueChange={(value) => setDraft((p) => ({ ...p, photoOutput: value }))}>
                                        <SelectTrigger className="settings-select" aria-label="Photo Mode output size"><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                          {OUTPUT_PRESETS.map((preset) => (
                                            <SelectItem key={preset.id} value={preset.id}>{preset.label}</SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                    </div>
                                  </section>

                                <section className="settings-panel">
                                  <div className="settings-panel-title">Reset</div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="settings-row-title">Reset all settings</div>
                                      <div className="settings-row-desc">
                                        {confirmReset
                                          ? "Every setting and shortcut in every section goes back to its default."
                                          : "Projects and files on disk stay as they are."}
                                      </div>
                                    </div>
                                    {confirmReset ? (
                                      <div className="settings-row-actions" role="group" aria-label="Confirm reset">
                                        <button type="button" className="settings-mini" onClick={cancelReset} autoFocus>
                                          Cancel
                                        </button>
                                        <button type="button" className="settings-mini is-danger is-solid" onClick={performReset}>
                                          Reset all
                                        </button>
                                      </div>
                                    ) : (
                                      <button
                                        ref={resetButtonRef}
                                        type="button"
                                        className="settings-mini is-danger"
                                        onClick={() => setConfirmReset(true)}
                                      >
                                        Reset all
                                      </button>
                                    )}
                                  </div>
                                </section>
                              </div>
                            ) : null}

                            {/* ─── Viewer ─── */}
                            {activeSection === "viewer" ? (
                              <div className="settings-stack">
                                <section className="settings-panel">
                                  <div className="settings-panel-title">Workspaces</div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="settings-row-title">Start in exterior only</div>
                                      <div className="settings-row-desc">New Vehicle workspaces open with interior, glass and wheels hidden. The camera deck toggles it per workspace.</div>
                                    </div>
                                    <Toggle
                                      checked={draft.liveryExteriorOnly === true}
                                      onChange={(v) => setDraft((p) => ({ ...p, liveryExteriorOnly: v }))}
                                      ariaLabel="Start new Vehicle workspaces in Exterior Only"
                                    />
                                  </div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="settings-row-title">Load EUP textures</div>
                                      <div className="settings-row-desc">Picking a clothing model in EUP also loads the texture dictionary beside it (its _diff_ .ytd). A texture you choose yourself is never replaced.</div>
                                    </div>
                                    <Toggle
                                      checked={draft.eupAutoTextures !== false}
                                      onChange={(v) => setDraft((p) => ({ ...p, eupAutoTextures: v }))}
                                      ariaLabel="Load a clothing model's own textures in EUP"
                                    />
                                  </div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="settings-row-title">Standard model warning</div>
                                      <div className="settings-row-desc">Opening a vehicle .yft that isn't the _hi model says so, and offers the _hi model when it is in the same folder.</div>
                                    </div>
                                    <Toggle
                                      checked={draft.warnStandardModel !== false}
                                      onChange={(v) => setDraft((p) => ({ ...p, warnStandardModel: v }))}
                                      ariaLabel="Warn when a vehicle model isn't the _hi model"
                                    />
                                  </div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="settings-row-title">Camera presets in the panel</div>
                                      <div className="settings-row-desc">Move the camera presets to the side panel. Rotate buttons stay on the bottom bar.</div>
                                    </div>
                                    <Toggle
                                      checked={draft.cameraControlsInPanel}
                                      onChange={(v) => setDraft((p) => ({ ...p, cameraControlsInPanel: v }))}
                                      ariaLabel="Toggle panel camera controls"
                                    />
                                  </div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="settings-row-title">Variant Builder layers at the bottom</div>
                                      <div className="settings-row-desc">The older Variant Builder layout, with layers under the viewer instead of on the right</div>
                                    </div>
                                    <Toggle
                                      checked={draft.legacyLayersLayout}
                                      onChange={(v) => setDraft((p) => ({ ...p, legacyLayersLayout: v }))}
                                      ariaLabel="Toggle legacy layers layout"
                                    />
                                  </div>
                                </section>

                                <section className="settings-panel">
                                  <div className="settings-panel-title">Camera and detail</div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="settings-row-title">Preview detail</div>
                                      <div className="settings-row-desc">Sharpness of 3D viewers on scaled and high-DPI screens. Performance keeps orbiting smooth; Sharp uses more GPU.</div>
                                    </div>
                                    <div className="settings-seg" role="radiogroup" aria-label="Preview detail">
                                      {PREVIEW_DETAIL_LEVELS.map((level) => (
                                        <button
                                          key={level.id}
                                          type="button"
                                          role="radio"
                                          aria-checked={draft.previewDetail === level.id}
                                          className={`settings-seg-btn ${draft.previewDetail === level.id ? "is-on" : ""}`}
                                          onClick={() => setDraft((p) => ({ ...p, previewDetail: level.id }))}
                                        >
                                          {level.label}
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="settings-row-title">Zoom toward cursor</div>
                                      <div className="settings-row-desc">Scrolling zooms toward the point under the mouse instead of the center of the view</div>
                                    </div>
                                    <Toggle
                                      checked={draft.zoomToCursor === true}
                                      onChange={(v) => setDraft((p) => ({ ...p, zoomToCursor: v }))}
                                      ariaLabel="Zoom toward cursor"
                                    />
                                  </div>
                                </section>

                                <section className="settings-panel">
                                  <div className="settings-panel-title">Render effects</div>
                                  <p className="settings-panel-description">
                                    Shared by Vehicle, EUP, Multi and Sirens; other workspaces keep their own.
                                  </p>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="settings-row-title">3D grid</div>
                                      <div className="settings-row-desc">Display the ground grid on the workbench</div>
                                    </div>
                                    <Toggle
                                      checked={draft.showGrid}
                                      onChange={(v) => setDraft((p) => ({ ...p, showGrid: v }))}
                                      ariaLabel="Toggle 3D grid"
                                    />
                                  </div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="settings-row-title">Ground shadows</div>
                                      <div className="settings-row-desc">Project a floor shadow under the vehicle on the workbench. The showroom always has shadows.</div>
                                    </div>
                                    <Toggle
                                      checked={draft.showShadows}
                                      onChange={(v) => setDraft((p) => ({ ...p, showShadows: v }))}
                                      ariaLabel="Toggle ground shadows"
                                    />
                                  </div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="settings-row-title">Ambient occlusion</div>
                                      <div className="settings-row-desc">Darkens creases, panel gaps and wheel wells. Uses more GPU while orbiting.</div>
                                    </div>
                                    <Toggle
                                      checked={draft.ambientOcclusion}
                                      onChange={(v) => setDraft((p) => ({ ...p, ambientOcclusion: v }))}
                                      ariaLabel="Toggle ambient occlusion"
                                    />
                                  </div>
                                </section>
                              </div>
                            ) : null}

                            {/* ─── Hotkeys ─── */}
                            {activeSection === "hotkeys" ? (
                              <div className="settings-stack">
                                {Object.entries(HOTKEY_CATEGORIES).map(([categoryId, category]) => (
                                  <section key={categoryId} className="settings-panel">
                                    <div className="settings-panel-title">{category.label}</div>
                                    {category.actions.flatMap((action) => [
                                      <div key={action} className="settings-row settings-hotkey-row">
                                        <div className="settings-row-label">
                                          <div className="settings-row-title">{HOTKEY_LABELS[action]}</div>
                                          {duplicateHotkeys[action] ? (
                                            <div className="settings-row-desc">
                                              Also used by {duplicateHotkeys[action].map((other) => HOTKEY_LABELS[other]).join(", ")}
                                            </div>
                                          ) : null}
                                        </div>
                                        <HotkeyInput
                                          value={hotkeysDraft[action]}
                                          pending={pendingConflict?.action === action ? pendingConflict.hotkey : null}
                                          onChange={(hotkey) => updateHotkey(action, hotkey)}
                                          onClear={() => clearHotkey(action)}
                                        />
                                      </div>,
                                      pendingConflict?.action === action ? (
                                        <div key={`${action}-conflict`} className="settings-callout is-warning" role="alert">
                                          <AlertTriangle className="settings-callout-icon" aria-hidden="true" />
                                          <div className="settings-callout-copy">
                                            <div className="settings-callout-title">
                                              {formatHotkey(pendingConflict.hotkey)} already runs {HOTKEY_LABELS[pendingConflict.other]}
                                            </div>
                                            <div className="settings-callout-text">
                                              {hotkeysDraft[action]?.key
                                                ? `Swap gives ${HOTKEY_LABELS[pendingConflict.other]} ${formatHotkey(hotkeysDraft[action])}. Cancel keeps both as they are.`
                                                : `Swap moves it here and leaves ${HOTKEY_LABELS[pendingConflict.other]} without a shortcut.`}
                                            </div>
                                          </div>
                                          <div className="settings-callout-actions">
                                            <button type="button" className="cx-btn is-primary" onClick={swapHotkey}>
                                              Swap
                                            </button>
                                            <button type="button" className="cx-btn is-quiet" onClick={() => setHotkeyConflict(null)}>
                                              Cancel
                                            </button>
                                          </div>
                                        </div>
                                      ) : null,
                                    ])}
                                  </section>
                                ))}
                                <div className="settings-hotkey-foot">
                                  <div className="settings-row-desc">Click a binding, then press the new key combination.</div>
                                  <button type="button" className="settings-mini" onClick={resetAllHotkeys}>
                                    Restore default shortcuts
                                  </button>
                                </div>
                              </div>
                            ) : null}

                            {/* ─── Appearance (Design) ─── */}
                            {activeSection === "appearance" ? (
                              <div className="settings-appearance-stack">
                                <section className="settings-panel settings-theme-panel">
                                  <div className="settings-panel-title">Color scheme</div>
                                  <div className="settings-theme-grid" role="group" aria-label="Color scheme">
                                    {THEME_OPTIONS.map((option) => (
                                      <ThemeChoice
                                        key={option.id}
                                        option={option}
                                        selected={draft.colorScheme === option.id}
                                        onSelect={selectColorScheme}
                                      />
                                    ))}
                                  </div>
                                </section>

                                <section className="settings-panel settings-preset-panel">
                                  <div className="settings-panel-heading-row">
                                    <div>
                                      <div className="settings-panel-title">Studio palette</div>
                                      <p className="settings-panel-description">
                                        Recolor the full workbench while preserving your selected light or dark mode.
                                      </p>
                                    </div>
                                    <span className="settings-panel-count">{THEME_PRESETS.length} presets</span>
                                  </div>
                                  <fieldset className="settings-preset-grid">
                                    <legend className="sr-only">Studio palette</legend>
                                    {THEME_PRESETS.map((option) => (
                                      <ThemePresetChoice
                                        key={option.id}
                                        option={option}
                                        scheme={resolveColorScheme(draft.colorScheme)}
                                        selected={draft.themePreset === option.id}
                                        onSelect={selectThemePreset}
                                      />
                                    ))}
                                  </fieldset>
                                </section>

                                <section className="settings-panel">
                                  <div className="settings-panel-title">Window</div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="settings-row-title">Window controls</div>
                                      <div className="settings-row-desc">Style of minimize, maximize and close</div>
                                    </div>
                                    <div className="settings-seg" role="radiogroup" aria-label="Window controls">
                                      <button
                                        type="button"
                                        role="radio"
                                        aria-checked={draft.windowControlsStyle !== "mac"}
                                        className={`settings-seg-btn ${draft.windowControlsStyle !== "mac" ? "is-on" : ""}`}
                                        onClick={() => setDraft((p) => ({ ...p, windowControlsStyle: "windows" }))}
                                      >
                                        Standard
                                      </button>
                                      <button
                                        type="button"
                                        role="radio"
                                        aria-checked={draft.windowControlsStyle === "mac"}
                                        className={`settings-seg-btn ${draft.windowControlsStyle === "mac" ? "is-on" : ""}`}
                                        onClick={() => setDraft((p) => ({ ...p, windowControlsStyle: "mac" }))}
                                      >
                                        Elegant
                                      </button>
                                    </div>
                                  </div>
                                </section>

                                <section className="settings-panel">
                                  <div className="settings-panel-title">Motion and hints</div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="settings-row-title">Reduce motion</div>
                                      <div className="settings-row-desc">Turn off interface animations, or follow your Windows setting</div>
                                    </div>
                                    <div className="settings-seg" role="radiogroup" aria-label="Reduce motion">
                                      {[
                                        ["system", "Follow system"],
                                        ["always", "Always reduce"],
                                      ].map(([value, label]) => (
                                        <button
                                          key={value}
                                          type="button"
                                          role="radio"
                                          aria-checked={draft.reduceMotion === value}
                                          className={`settings-seg-btn ${draft.reduceMotion === value ? "is-on" : ""}`}
                                          onClick={() => setDraft((p) => ({ ...p, reduceMotion: value }))}
                                        >
                                          {label}
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="settings-row-title">Show shortcut keys</div>
                                      <div className="settings-row-desc">Display keycaps next to actions on Home, menus, and workspaces. Shortcuts keep working either way.</div>
                                    </div>
                                    <Toggle
                                      checked={draft.showKeycaps !== false}
                                      onChange={(v) => setDraft((p) => ({ ...p, showKeycaps: v }))}
                                      ariaLabel="Show shortcut keys"
                                    />
                                  </div>
                                </section>

                                <section className="settings-panel">
                                  <div className="settings-panel-title">Starting colors</div>
                                  <p className="settings-panel-description">
                                    Used by new viewers and generated templates.
                                  </p>
                                   <div className="settings-color-grid">
                                    <ColorField
                                      label="Base body"
                                      value={draft.bodyColor}
                                      onChange={(value) => setDraft((p) => ({ ...p, bodyColor: value }))}
                                      onReset={() => setDraft((p) => ({ ...p, bodyColor: BUILT_IN_DEFAULTS.bodyColor }))}
                                    />
                                    <ColorField
                                      label="Base background"
                                      value={draft.backgroundColor}
                                      onChange={(value) => setDraft((p) => ({ ...p, backgroundColor: value }))}
                                      onReset={() => setDraft((p) => ({ ...p, backgroundColor: BUILT_IN_DEFAULTS.backgroundColor }))}
                                    />
                                    <ColorField
                                      label="Auto template fill"
                                      value={draft.autoTemplateColor}
                                      onChange={(value) => setDraft((p) => ({ ...p, autoTemplateColor: value }))}
                                      onReset={() => setDraft((p) => ({ ...p, autoTemplateColor: BUILT_IN_DEFAULTS.autoTemplateColor }))}
                                    />
                                    <ColorField
                                      label="Auto template background"
                                      value={draft.autoTemplateBackgroundColor}
                                      onChange={(value) => setDraft((p) => ({ ...p, autoTemplateBackgroundColor: value }))}
                                      onReset={() =>
                                        setDraft((p) => ({
                                          ...p,
                                          autoTemplateBackgroundColor: BUILT_IN_DEFAULTS.autoTemplateBackgroundColor,
                                        }))
                                      }
                                    />
                                  </div>
                                </section>
                              </div>
                            ) : null}

                            {/* ─── Studio defaults ─── */}
                            {activeSection === "studio" ? (
                              <StudioDefaultsSettings value={draft} onChange={updateStudioDefaults} />
                            ) : null}

                            {/* ─── Watermark ─── */}
                            {activeSection === "watermark" ? (
                              <WatermarkSettings value={draft.watermark} onChange={updateWatermark} />
                            ) : null}

                            {activeSection === "privacy" ? (
                              <div className="settings-stack">
                                <UsageStatsSettings
                                  enabled={draft.usageStats !== false}
                                  onChange={(v) => setDraft((p) => ({ ...p, usageStats: v }))}
                                />
                              </div>
                            ) : null}

                            {/* ─── About ─── */}
                            {activeSection === "about" ? (
                              <div className="settings-about-stack">
                                <section className="settings-about-intro" aria-labelledby="settings-about-product">
                                  <img src={cortexLogo} alt="" className="settings-about-logo" draggable={false} />
                                  <div className="settings-about-copy">
                                    <h3 className="settings-about-product cx-display" id="settings-about-product">Cortex Studio</h3>
                                    <p>Windows-first livery development for GTA V and FiveM, from source asset to verified export.</p>
                                  </div>
                                  <div className="settings-about-version-block">
                                    <span>Installed version</span>
                                    <strong>v{getAppVersion()}</strong>
                                  </div>
                                </section>

                                {/* ─── Update Panel ─── */}
                                <section className="settings-panel settings-update-panel">
                                  <div className="settings-panel-title">Updates</div>

                                  {/* Published feed behind installed build */}
                                  {!updater.available && !updater.checking && !updater.error && updater.lastChecked && updater.statusKind === "ahead" ? (
                                    <div className="settings-update-status settings-update-status--error" role="alert">
                                      <AlertTriangle className="settings-status-icon" />
                                      <div className="flex-1 min-w-0">
                                        <div className="settings-status-title is-error">Published feed is behind this build</div>
                                        <div className="settings-row-desc">
                                          {updater.statusNote}
                                        </div>
                                      </div>
                                      <button
                                        type="button"
                                        className="settings-mini settings-update-check-btn"
                                        onClick={updater.checkNow}
                                        disabled={updater.checking}
                                      >
                                        <RefreshCw className="h-3 w-3" />
                                        Check again
                                      </button>
                                    </div>
                                  ) : null}

                                  {/* Up-to-date state */}
                                  {!updater.available && !updater.checking && !updater.error && updater.lastChecked && updater.statusKind !== "ahead" ? (
                                    <div className="settings-update-status settings-update-status--ok" role="status">
                                      <CheckCircle2 className="settings-status-icon" />
                                      <div className="flex-1 min-w-0">
                                        <div className="settings-status-title">You're up to date</div>
                                        <div className="settings-row-desc">
                                          {updater.statusNote || `Last checked ${new Date(updater.lastChecked).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
                                        </div>
                                      </div>
                                      <button
                                        type="button"
                                        className="settings-mini settings-update-check-btn"
                                        onClick={updater.checkNow}
                                        disabled={updater.checking}
                                      >
                                        <RefreshCw className="h-3 w-3" />
                                        Check again
                                      </button>
                                    </div>
                                  ) : null}

                                  {/* Never checked / idle */}
                                  {!updater.available && !updater.checking && !updater.error && !updater.lastChecked ? (
                                    <div className="settings-update-status" role="status">
                                      <RefreshCw className="settings-status-icon" />
                                      <div className="flex-1 min-w-0">
                                        <div className="settings-status-title">Check for updates</div>
                                        <div className="settings-row-desc">
                                          {draft.autoCheckUpdates !== false ? "Checks automatically every 30 minutes" : "Automatic checks are off"}
                                        </div>
                                      </div>
                                      <button
                                        type="button"
                                        className="settings-mini settings-update-check-btn"
                                        onClick={updater.checkNow}
                                        disabled={updater.checking}
                                      >
                                        Check now
                                      </button>
                                    </div>
                                  ) : null}

                                  {/* Checking spinner */}
                                  {updater.checking ? (
                                    <div className="settings-update-status" role="status">
                                      <motion.div
                                        animate={prefersReducedMotion ? { rotate: 0 } : { rotate: 360 }}
                                        transition={prefersReducedMotion ? { duration: 0 } : { repeat: Infinity, duration: 1, ease: "linear" }}
                                        className="shrink-0"
                                      >
                                        <Loader className="settings-status-icon" />
                                      </motion.div>
                                      <div className="settings-status-title is-muted">Checking for updates…</div>
                                    </div>
                                  ) : null}

                                  {/* Error state */}
                                  {updater.error && !updater.checking && !updater.available ? (
                                    <div className="settings-update-status settings-update-status--error" role="alert">
                                      <AlertCircle className="settings-status-icon" />
                                      <div className="flex-1 min-w-0">
                                        <div className="settings-status-title is-error">Check failed</div>
                                        <div className="settings-status-desc is-truncated">{updater.error}</div>
                                      </div>
                                      <button
                                        type="button"
                                        className="settings-mini settings-update-check-btn"
                                        onClick={updater.checkNow}
                                      >
                                        Retry
                                      </button>
                                    </div>
                                  ) : null}

                                  {/* Update available */}
                                  {updater.available ? (
                                    <div className="settings-update-available">
                                      <div className="settings-update-available-header">
                                        {updater.installing ? (
                                          <motion.span
                                            className="shrink-0"
                                            animate={prefersReducedMotion ? { rotate: 0 } : { rotate: 360 }}
                                            transition={prefersReducedMotion ? { duration: 0 } : { repeat: Infinity, duration: 1, ease: "linear" }}
                                          >
                                            <Loader className="settings-status-icon" />
                                          </motion.span>
                                        ) : updater.error ? (
                                          <AlertCircle className="settings-status-icon" />
                                        ) : updater.downloaded || updater.installed ? (
                                          <CheckCircle2 className="settings-status-icon" />
                                        ) : (
                                          <Download className="settings-status-icon" />
                                        )}
                                        <div className="flex-1 min-w-0">
                                          <div className="settings-status-title is-accent">
                                            Update available: v{updater.latest}
                                          </div>
                                          <div className="settings-row-desc">
                                            {updater.installing
                                              ? "Updating and reopening Cortex Studio…"
                                              : updater.error
                                                ? updater.error
                                                : updater.installed
                                                  ? "Installed. Restart Cortex Studio to finish."
                                                  : updater.downloaded
                                                    ? "Downloaded and ready to install"
                                                    : "Downloading in the background…"}
                                          </div>
                                        </div>
                                        {!updater.installing && (updater.downloaded || updater.installed) ? (
                                          <button
                                            type="button"
                                            className="settings-update-install-btn"
                                            onClick={updater.install}
                                          >
                                            {updater.installed ? "Restart" : updater.error ? "Retry update" : "Restart to update"}
                                          </button>
                                        ) : updater.error && !updater.downloading ? (
                                          <button
                                            type="button"
                                            className="settings-update-install-btn"
                                            onClick={updater.download}
                                          >
                                            Retry download
                                          </button>
                                        ) : null}
                                      </div>

                                      {updater.downloading ? (
                                        <div
                                          className="settings-update-progress"
                                          role="progressbar"
                                          aria-label={`Downloading Cortex Studio v${updater.latest}`}
                                          aria-valuemin={0}
                                          aria-valuemax={100}
                                          aria-valuenow={updater.progressKnown ? updater.progressPercent : undefined}
                                          aria-valuetext={updater.progressKnown ? `${updater.progressPercent}% downloaded` : "Downloading update"}
                                        >
                                          <div className="settings-update-progress-track">
                                            <div
                                              className={`settings-update-progress-fill ${updater.progressKnown ? "" : "is-indeterminate"}`.trim()}
                                              style={{ width: updater.progressKnown ? `${updater.progressPercent}%` : "38%" }}
                                            />
                                          </div>
                                          <span className="settings-update-progress-pct">
                                            {updater.progressKnown ? `${updater.progressPercent}%` : "···"}
                                          </span>
                                        </div>
                                      ) : null}

                                      {updater.notes ? (
                                        <div className="settings-update-notes">
                                          <div className="cx-label settings-update-notes-label">Release notes</div>
                                          <div className="settings-update-notes-body">{updater.notes}</div>
                                        </div>
                                      ) : null}
                                    </div>
                                  ) : null}

                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="settings-row-title">Check automatically</div>
                                      <div className="settings-row-desc">Look for updates in the background and download them when found</div>
                                    </div>
                                    <Toggle
                                      checked={draft.autoCheckUpdates !== false}
                                      onChange={(v) => setDraft((p) => ({ ...p, autoCheckUpdates: v }))}
                                      ariaLabel="Check for updates automatically"
                                    />
                                  </div>
                                </section>

                                <section className="settings-panel">
                                  <div className="settings-panel-title">Release notes</div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="settings-row-title">Changelog</div>
                                      <div className="settings-row-desc">
                                        Every release on one timeline.{hasNotesForAppVersion() && !hasSeenWhatsNew() ? " This version has notes you haven't read." : ""}
                                      </div>
                                    </div>
                                    <button
                                      type="button"
                                      className="settings-mini"
                                      onClick={() => {
                                        closeSettings();
                                        setTimeout(() => onOpenReleaseNotes?.(), 220);
                                      }}
                                    >
                                      <Sparkles aria-hidden="true" />
                                      Open changelog
                                    </button>
                                  </div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="settings-row-title">Show after updates</div>
                                      <div className="settings-row-desc">Open the changelog once after Cortex Studio updates</div>
                                    </div>
                                    <Toggle
                                      checked={draft.showWhatsNewOnUpdate !== false}
                                      onChange={(v) => setDraft((p) => ({ ...p, showWhatsNewOnUpdate: v }))}
                                      ariaLabel="Show the changelog after updates"
                                    />
                                  </div>
                                </section>

                                <section className="settings-panel">
                                  <div className="settings-panel-title">Feedback</div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="settings-row-title">Send feedback</div>
                                      <div className="settings-row-desc">Report a bug or request a feature. It is filed on the Cortex Labs issue tracker.</div>
                                    </div>
                                    <div className="settings-row-actions">
                                      <button
                                        type="button"
                                        className="settings-mini"
                                        onClick={() => openFromSettings("cortex:open-feedback", { type: "bug" })}
                                      >
                                        <Bug aria-hidden="true" />
                                        Report a bug
                                      </button>
                                      <button
                                        type="button"
                                        className="settings-mini"
                                        onClick={() => openFromSettings("cortex:open-feedback", { type: "feature" })}
                                      >
                                        <Lightbulb aria-hidden="true" />
                                        Request a feature
                                      </button>
                                    </div>
                                  </div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="settings-row-title">Attach console logs by default</div>
                                      <div className="settings-row-desc">Pre-select recent app logs on bug reports. You can still turn it off per report.</div>
                                    </div>
                                    <Toggle
                                      checked={draft.feedbackIncludeLogs === true}
                                      onChange={(v) => setDraft((p) => ({ ...p, feedbackIncludeLogs: v }))}
                                      ariaLabel="Attach console logs to bug reports by default"
                                    />
                                  </div>
                                </section>
                              </div>
                            ) : null}
                        </div>
                      </main>
                    </motion.div>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>,
            document.body,
          )
        : null}
    </div>
  );
}
