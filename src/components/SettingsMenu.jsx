import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowLeft, Settings, Car, AlertTriangle, Monitor, Clock, Palette, Info, RefreshCw, Download, CheckCircle2, AlertCircle, Loader, Stamp, Check, Bug, Lightbulb, Sparkles, Aperture } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { exists as fsExists } from "@tauri-apps/plugin-fs";
import HotkeyInput from "./HotkeyInput";
import WatermarkSettings from "./WatermarkSettings";
import StudioDefaultsSettings from "./StudioDefaultsSettings";
import { ColorField } from "./SettingsColorField";
import { Toggle } from "./ui/toggle";
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
import { DEFAULT_WATERMARK, normalizeWatermarkConfig } from "../lib/watermark";
import {
  DEFAULT_LIGHT,
  DEFAULT_PLATE,
  normalizeLightDefaults,
  normalizePlateDefault,
  normalizeShowroomDefaults,
  normalizeSteeringDefault,
} from "../lib/studio-defaults";

/* ─── Built-in defaults (canonical source) ─── */
const BUILT_IN_DEFAULTS = {
  colorScheme: "dark",
  themePreset: "cortex",
  darkMode: true,
  liveryExteriorOnly: false,
  windowTemplateEnabled: false,
  windowTextureTarget: "auto",
  bodyColor: "#e7ebf0",
  autoTemplateColor: "#c9d8ee",
  autoTemplateBackgroundColor: "#000000",
  backgroundColor: "#141414",
  showGrid: false,
  showShadows: false,
  ambientOcclusion: false,
  showRecents: true,
  lightIntensity: DEFAULT_LIGHT.intensity,
  lightAzimuth: DEFAULT_LIGHT.azimuth,
  lightElevation: DEFAULT_LIGHT.elevation,
  showroom: normalizeShowroomDefaults(null),
  licensePlate: { ...DEFAULT_PLATE },
  steeringAngle: 0,
  windowControlsStyle: "windows",
  uiScale: 1.0,
  previewFolder: "",
  variantExportFolder: "",
  autoTemplateExportFormat: "psd",
  cameraControlsInPanel: false,
  eupAutoTextures: true,
  warnStandardModel: true,
  legacyLayersLayout: false,
  watermark: { ...DEFAULT_WATERMARK },
  homeSort: "recent",
  confirmProjectDelete: true,
  reduceMotion: "system",
  showKeycaps: true,
  showWhatsNewOnUpdate: true,
  autoCheckUpdates: true,
  feedbackIncludeLogs: false,
};

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
      { id: "general", label: "System", description: "Interface scaling and core behavior.", icon: Monitor },
      { id: "viewer", label: "Viewer", description: "Interaction and rendering defaults.", icon: Car },
      { id: "studio", label: "Studio", description: "Showroom, lighting, plate, and steering that new work starts with.", icon: Aperture },
      { id: "appearance", label: "Appearance", description: "Theme, window chrome, and studio colors.", icon: Palette },
      { id: "watermark", label: "Watermark", description: "Stamp captures with your text or logo.", icon: Stamp },
    ],
  },
  {
    id: "input",
    label: "Input",
    items: [
      { id: "hotkeys", label: "Shortcuts", description: "Global keyboard configurations.", icon: Clock },
    ],
  },
  {
    id: "support",
    label: "Support",
    items: [
      { id: "about", label: "About", description: "Version, updates, release notes, and feedback.", icon: Info },
    ],
  },
];

const SETTINGS_SECTIONS = SETTINGS_SECTION_GROUPS.flatMap((group) => group.items);

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
      <span className="settings-theme-choice-copy">
        <span className="settings-theme-choice-label">{option.label}</span>
        <span className="settings-theme-choice-description">{option.description}</span>
      </span>
      <span className="settings-theme-choice-check" aria-hidden="true">
        {selected ? <Check /> : null}
      </span>
    </button>
  );
}

function ThemePresetChoice({ option, selected, onSelect }) {
  const previewStyle = {
    "--theme-preset-dark": option.modes.dark.background,
    "--theme-preset-surface": option.modes.dark.surface,
    "--theme-preset-ink": option.modes.dark.foreground,
    "--theme-preset-light": option.modes.light.background,
    "--theme-preset-accent": option.modes.dark.primary,
  };

  return (
    <label
      className={`settings-preset-choice ${selected ? "is-selected" : ""}`}
      style={previewStyle}
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
      <span className="settings-preset-choice-copy">
        <span className="settings-preset-choice-label">{option.name}</span>
        <span className="settings-preset-choice-description">{option.description}</span>
      </span>
      <span className="settings-preset-swatches" aria-hidden="true">
        <span style={{ background: option.modes.dark.background }} />
        <span style={{ background: option.modes.light.background }} />
        <span style={{ background: option.modes.dark.primary }} />
      </span>
      <span className="settings-preset-choice-check" aria-hidden="true">
        {selected ? <Check /> : null}
      </span>
    </label>
  );
}

/**
 * SettingsMenu — self-contained settings panel.
 * Reads/writes prefs directly via loadPrefs()/savePrefs().
 * Shell renders this in the chrome bar; it emits onSettingsSaved when prefs are persisted.
 */
export default function SettingsMenu({
  pageTarget,
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
  const updater = useUpdateChecker();
  const prefersReducedMotion = useReducedMotion();

  const [draft, setDraft] = useState(() => getStoredDefaults());
  const [hotkeysDraft, setHotkeysDraft] = useState(() => getStoredHotkeys());
  const [savedSignature, setSavedSignature] = useState(() =>
    settingsSignature(getStoredDefaults(), getStoredHotkeys()),
  );
  const pageRef = useRef(null);
  const settingsButtonRef = useRef(null);
  const wasOpenRef = useRef(false);

  const setOpen = useCallback((nextOpen) => {
    onOpenChange?.(Boolean(nextOpen));
  }, [onOpenChange]);

  const isTauriRuntime =
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__ !== "undefined";

  const closeSettings = useCallback(() => {
    const stored = getStoredDefaults();
    applyAppearance({
      colorScheme: stored.colorScheme,
      themePreset: stored.themePreset,
      legacyDarkMode: stored.darkMode,
    });
    setOpen(false);
  }, [setOpen]);

  // Refresh draft from storage when the dialog opens
  useEffect(() => {
    if (open) {
      const nextDraft = getStoredDefaults();
      const nextHotkeys = getStoredHotkeys();
      setDraft(nextDraft);
      setHotkeysDraft(nextHotkeys);
      setSavedSignature(settingsSignature(nextDraft, nextHotkeys));
      setConfirmReset(false);
      setSaveError("");
      window.setTimeout(() => {
        (pageRef.current ?? document.querySelector(".settings-page"))?.focus();
      }, 0);
    } else if (wasOpenRef.current) {
      const stored = getStoredDefaults();
      applyAppearance({
        colorScheme: stored.colorScheme,
        themePreset: stored.themePreset,
        legacyDarkMode: stored.darkMode,
      });
      // Return focus to the gear only when it was in the page (Escape, Close)
      // or fell to the body; a tab or control the user clicked keeps it.
      const pageNode = pageRef.current;
      window.setTimeout(() => {
        const active = document.activeElement;
        if (active && active !== document.body && !pageNode?.contains(active)) return;
        (settingsButtonRef.current ?? document.querySelector('button[aria-label="Settings"]'))?.focus();
      }, 0);
    }
    wasOpenRef.current = open;
  }, [open]);

  const performReset = () => {
    setDraft({ ...BUILT_IN_DEFAULTS });
    setHotkeysDraft({ ...DEFAULT_HOTKEYS });
    setConfirmReset(false);
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

  const openFromSettings = useCallback((eventName, detail) => {
    closeSettings();
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent(eventName, detail ? { detail } : undefined));
    }, 220);
  }, [closeSettings]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        // Don't close if walkthrough is controlling this dialog
        if (document.querySelector(".settings-page.is-walkthrough-elevated")) return;
        closeSettings();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeSettings, open]);

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
  const draftSignature = useMemo(
    () => settingsSignature(draft, hotkeysDraft),
    [draft, hotkeysDraft],
  );
  const hasChanges = draftSignature !== savedSignature;

  const save = useCallback(() => {
    const normalizedUiScale = clampUiScale(draft.uiScale);
    const normalizedDraft = {
      ...draft,
      colorScheme: normalizeColorScheme(draft.colorScheme, draft.darkMode),
      themePreset: normalizeThemePreset(draft.themePreset),
      uiScale: normalizedUiScale,
      autoTemplateExportFormat: normalizeAutoTemplateExportFormat(draft.autoTemplateExportFormat),
      watermark: normalizeWatermarkConfig(draft.watermark),
      ...normalizeStudioDefaults(draft),
    };
    const { resolvedTheme } = applyAppearance({
      colorScheme: normalizedDraft.colorScheme,
      themePreset: normalizedDraft.themePreset,
      legacyDarkMode: normalizedDraft.darkMode,
    });
    normalizedDraft.darkMode = resolvedTheme === "dark";
    const prefs = loadPrefs() || {};
    if (!savePrefs({ ...prefs, defaults: normalizedDraft, hotkeys: hotkeysDraft })) {
      setSaveError(
        normalizedDraft.watermark?.image
          ? "Settings could not be saved. Storage may be full; try a smaller watermark logo."
          : "Settings could not be saved. Storage may be full or unavailable.",
      );
      return;
    }
    setSaveError("");
    emitPrefsUpdated();
    // Apply UI scale immediately
    document.documentElement.style.setProperty("--es-ui-scale", String(normalizedUiScale));
    window.dispatchEvent(
      new CustomEvent("cortex:ui-scale-changed", { detail: { scale: normalizedUiScale } }),
    );
    setDraft(normalizedDraft);
    setSavedSignature(settingsSignature(normalizedDraft, hotkeysDraft));
    onSettingsSaved?.();
  }, [draft, hotkeysDraft, onSettingsSaved]);

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

  const toggleShowRecents = useCallback(() => {
    const nextShowRecents = draft.showRecents === false;
    setDraft((prev) => ({ ...prev, showRecents: nextShowRecents }));

    const prefs = loadPrefs() || {};
    const storedDefaults = prefs?.defaults && typeof prefs.defaults === "object" ? prefs.defaults : {};
    savePrefs({
      ...prefs,
      defaults: {
        ...storedDefaults,
        showRecents: nextShowRecents,
      },
    });

    setSavedSignature((signature) => {
      try {
        const saved = JSON.parse(signature);
        return settingsSignature(
          { ...saved.defaults, showRecents: nextShowRecents },
          saved.hotkeys,
        );
      } catch {
        return signature;
      }
    });

    onSettingsSaved?.();
  }, [draft.showRecents, onSettingsSaved]);

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

      {pageTarget
        ? createPortal(
            <AnimatePresence>
              {open ? (
                <motion.section
                  ref={pageRef}
                  className="settings-page"
                  aria-labelledby="settings-page-title"
                  tabIndex={-1}
                  autoFocus
                  initial={prefersReducedMotion ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={prefersReducedMotion ? { opacity: 1 } : { opacity: 0 }}
                  transition={{ duration: prefersReducedMotion ? 0 : 0.16, ease: [0.22, 1, 0.36, 1] }}
                >
                  <motion.div
                    className="settings-dialog"
                    initial={prefersReducedMotion ? false : { opacity: 0, x: 8 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={prefersReducedMotion ? { opacity: 1, x: 0 } : { opacity: 0, x: 8 }}
                    transition={{ duration: prefersReducedMotion ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}
                  >
                    <div className="settings-shell">
                      <aside className="settings-nav">
                        <div className="settings-dialog-header">
                          <button
                            type="button"
                            className="settings-back"
                            onClick={closeSettings}
                            aria-label="Back to workspace"
                          >
                            <ArrowLeft className="settings-back-icon" aria-hidden="true" />
                          </button>
                          <div className="settings-dialog-title-group">
                            <h1 className="settings-dialog-title cx-display" id="settings-page-title">Settings</h1>
                            <div className="settings-dialog-sub">Cortex Studio</div>
                          </div>
                        </div>
                        <nav className="settings-nav-list" aria-label="Settings sections">
                          {SETTINGS_SECTION_GROUPS.map((group) => (
                            <div className="settings-nav-group" key={group.id}>
                              <div className="settings-nav-group-label">{group.label}</div>
                              {group.items.map((section) => {
                                const Icon = section.icon;
                                const isActive = activeSection === section.id;
                                return (
                                  <motion.button
                                    key={section.id}
                                    type="button"
                                    className={`settings-nav-item ${isActive ? "is-active" : ""}`}
                                    onClick={() => setActiveSection(section.id)}
                                    aria-current={isActive ? "page" : undefined}
                                    title={section.description}
                                  >
                                    <Icon className="settings-nav-item-icon" aria-hidden="true" />
                                    <span className="settings-nav-item-copy">
                                      <span className="settings-nav-item-label">{section.label}</span>
                                    </span>
                                  </motion.button>
                                );
                              })}
                            </div>
                          ))}
                        </nav>
                      </aside>

                      <main className="settings-content">
                        <div className="settings-content-header">
                          <div className="settings-content-heading">
                            <h2 className="settings-content-title cx-display">{activeMeta.label}</h2>
                            <div className="settings-content-sub">{activeMeta.description}</div>
                          </div>
                          {saveError ? (
                            <div className="settings-save-state has-error" role="alert">
                              <AlertCircle className="settings-save-icon" aria-hidden="true" />
                              {saveError}
                            </div>
                          ) : hasChanges ? (
                            <div className="settings-save-state has-changes" aria-live="polite">
                              <span className="settings-save-dot" aria-hidden="true" />
                              Unsaved changes
                            </div>
                          ) : null}
                        </div>

                        <div
                          key={activeSection}
                          className="settings-content-body custom-scrollbar"
                        >
                            {/* ─── General (System) ─── */}
                            {activeSection === "general" ? (
                              <div className="settings-stack">
                                <section className="settings-panel">
                                  <div className="settings-panel-title">Interface Configuration</div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="settings-row-title">UI Scaling</div>
                                      <div className="settings-row-desc">Adjust interface density (Default 100%)</div>
                                    </div>
                                    <div className="settings-slider-field">
                                      <input
                                        type="range"
                                        className="settings-slider"
                                        min={0.5}
                                        max={1.4}
                                        step={0.05}
                                        value={clampUiScale(draft.uiScale)}
                                        onChange={(e) => setDraft((p) => ({ ...p, uiScale: clampUiScale(parseFloat(e.target.value)) }))}
                                      />
                                      <span className="settings-slider-value">{Math.round(clampUiScale(draft.uiScale) * 100)}%</span>
                                    </div>
                                  </div>

                                </section>

                                <section className="settings-panel">
                                  <div className="settings-panel-title">Projects on Home</div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="settings-row-title">Show projects</div>
                                      <div className="settings-row-desc">List saved projects on Home so you can pick up where you left off</div>
                                    </div>
                                    <Toggle
                                      checked={draft.showRecents !== false}
                                      onChange={toggleShowRecents}
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
                                </section>

                                  <section className="settings-panel">
                                    <div className="settings-panel-title">Data & Storage</div>
                                    <div className="settings-row">
                                      <div className="settings-row-label">
                                        <div className="settings-row-title">Preview Export Path</div>
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
                                        <div className="settings-row-title">Variant Export Path</div>
                                        <div className={`settings-row-desc ${draft.variantExportFolder ? "settings-path" : ""}`.trim()}>{draft.variantExportFolder || "Not set. You'll choose a folder on each export."}</div>
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
                                        <div className="settings-row-title">Auto Template Save Format</div>
                                        <div className="settings-row-desc">Choose which files are exported when templates auto-save</div>
                                      </div>
                                    <div className="settings-seg">
                                        <button
                                          type="button"
                                          className={`settings-seg-btn ${draft.autoTemplateExportFormat === "psd" ? "is-on" : ""}`}
                                          onClick={() => setDraft((p) => ({ ...p, autoTemplateExportFormat: "psd" }))}
                                        >
                                          PSD
                                        </button>
                                        <button
                                          type="button"
                                          className={`settings-seg-btn ${draft.autoTemplateExportFormat === "png" ? "is-on" : ""}`}
                                          onClick={() => setDraft((p) => ({ ...p, autoTemplateExportFormat: "png" }))}
                                        >
                                          PNG
                                        </button>
                                        <button
                                          type="button"
                                          className={`settings-seg-btn ${draft.autoTemplateExportFormat === "psd_png" ? "is-on" : ""}`}
                                          onClick={() => setDraft((p) => ({ ...p, autoTemplateExportFormat: "psd_png" }))}
                                        >
                                          PSD + PNG
                                        </button>
                                      </div>
                                    </div>
                                  </section>
                              </div>
                            ) : null}

                            {/* ─── Viewer ─── */}
                            {activeSection === "viewer" ? (
                              <div className="settings-stack">
                                <section className="settings-panel">
                                  <div className="settings-panel-title">Workspace Defaults</div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="settings-row-title">Free-Cam</div>
                                      <div className="settings-row-desc">Focus the preview: WASD flies, RMB looks, Q/E elevates, Alt refines, Shift boosts</div>
                                    </div>
                                    <div className="settings-row-note">Enabled in Studio previews</div>
                                  </div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="settings-row-title">Start in Exterior Only</div>
                                      <div className="settings-row-desc">New Livery and All Textures workspaces open with interior, glass and wheels hidden. The camera deck toggles it per workspace.</div>
                                    </div>
                                    <Toggle
                                      checked={draft.liveryExteriorOnly === true}
                                      onChange={(v) => setDraft((p) => ({ ...p, liveryExteriorOnly: v }))}
                                      ariaLabel="Start new Livery and All Textures workspaces in Exterior Only"
                                    />
                                  </div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="settings-row-title">Load EUP Textures</div>
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
                                      <div className="settings-row-title">Standard Model Warning</div>
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
                                      <div className="settings-row-title">Panel Camera Controls</div>
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
                                      <div className="settings-row-title">Legacy Layers Layout</div>
                                      <div className="settings-row-desc">Place the layers panel at the bottom instead of the right side</div>
                                    </div>
                                    <Toggle
                                      checked={draft.legacyLayersLayout}
                                      onChange={(v) => setDraft((p) => ({ ...p, legacyLayersLayout: v }))}
                                      ariaLabel="Toggle legacy layers layout"
                                    />
                                  </div>
                                </section>

                                <section className="settings-panel">
                                  <div className="settings-panel-title">Render Effects</div>
                                  <p className="settings-panel-description">
                                    Livery, All Textures, EUP, Multi and Sirens tabs share these, and their camera deck buttons change them too. EUP Studio, Prop Studio and Photo Mode keep their own with each workspace.
                                  </p>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="settings-row-title">Show 3D Grid</div>
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
                                      <div className="settings-row-title">Ground Shadows</div>
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
                                      <div className="settings-row-title">Ambient Occlusion</div>
                                      <div className="settings-row-desc">Darken creases, panel gaps, and wheel wells on the model. Uses more GPU while orbiting</div>
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
                                  <div className="settings-panel-title">Color Scheme</div>
                                  <p className="settings-panel-description">
                                    Choose how Cortex Studio looks. System follows your operating system automatically.
                                  </p>
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
                                      <div className="settings-panel-title">Studio Palette</div>
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
                                        selected={draft.themePreset === option.id}
                                        onSelect={selectThemePreset}
                                      />
                                    ))}
                                  </fieldset>
                                </section>

                                <section className="settings-panel">
                                  <div className="settings-panel-title">Window Chrome</div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="settings-row-title">Window Controls Style</div>
                                      <div className="settings-row-desc">Choose the visual style for minimize, maximize, and close</div>
                                    </div>
                                    <div className="settings-seg">
                                      <button
                                        type="button"
                                        className={`settings-seg-btn ${draft.windowControlsStyle !== "mac" ? "is-on" : ""}`}
                                        onClick={() => setDraft((p) => ({ ...p, windowControlsStyle: "windows" }))}
                                      >
                                        Standard
                                      </button>
                                      <button
                                        type="button"
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
                                        ["always", "Always"],
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
                                  <div className="settings-panel-title">Studio Defaults</div>
                                  <p className="settings-panel-description">
                                    Set the starting colors used by viewers and generated templates.
                                  </p>
                                   <div className="settings-color-grid">
                                    <ColorField
                                      label="Base Body"
                                      value={draft.bodyColor}
                                      onChange={(value) => setDraft((p) => ({ ...p, bodyColor: value }))}
                                      onReset={() => setDraft((p) => ({ ...p, bodyColor: BUILT_IN_DEFAULTS.bodyColor }))}
                                    />
                                    <ColorField
                                      label="Base Background"
                                      value={draft.backgroundColor}
                                      onChange={(value) => setDraft((p) => ({ ...p, backgroundColor: value }))}
                                      onReset={() => setDraft((p) => ({ ...p, backgroundColor: BUILT_IN_DEFAULTS.backgroundColor }))}
                                    />
                                    <ColorField
                                      label="Auto Template Fill"
                                      value={draft.autoTemplateColor}
                                      onChange={(value) => setDraft((p) => ({ ...p, autoTemplateColor: value }))}
                                      onReset={() => setDraft((p) => ({ ...p, autoTemplateColor: BUILT_IN_DEFAULTS.autoTemplateColor }))}
                                    />
                                    <ColorField
                                      label="Auto Template Background"
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
                                  <div className="settings-panel-title">Software Update</div>

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

                        <div className="settings-footer">
                          {confirmReset ? (
                            <div className="settings-confirm-overlay">
                              <div className="settings-confirm-content">
                                <AlertTriangle className="settings-status-icon" aria-hidden="true" />
                                <span>Reset every setting and shortcut to its default? This cannot be undone.</span>
                              </div>
                              <div className="settings-confirm-actions">
                                <button type="button" className="settings-mini" onClick={() => setConfirmReset(false)}>
                                  Cancel
                                </button>
                                <button type="button" className="settings-danger-btn" onClick={performReset}>
                                  Reset everything
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="settings-actions">
                              <button type="button" className="settings-secondary" onClick={() => setConfirmReset(true)}>
                                Reset all
                              </button>
                              <button type="button" className="settings-primary" onClick={save} disabled={!hasChanges}>
                                Save changes
                              </button>
                            </div>
                          )}
                        </div>
                      </main>
                    </div>
                  </motion.div>
                </motion.section>
              ) : null}
            </AnimatePresence>,
            pageTarget,
          )
        : null}
    </div>
  );
}
