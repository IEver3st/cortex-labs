import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowLeft, Settings, Car, FlaskConical, AlertTriangle, Monitor, Clock, Palette, Info, RefreshCw, Download, CheckCircle2, AlertCircle, Loader, Stamp, Check } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { exists as fsExists } from "@tauri-apps/plugin-fs";
import HotkeyInput from "./HotkeyInput";
import { Toggle } from "./ui/toggle";
import {
  DEFAULT_HOTKEYS,
  HOTKEY_CATEGORIES,
  HOTKEY_LABELS,
  mergeHotkeys,
} from "../lib/hotkeys";
import { emitPrefsUpdated, loadPrefs, savePrefs } from "../lib/prefs";
import {
  THEME_PRESETS,
  applyAppearance,
  applyColorScheme,
  applyThemePreset,
  normalizeColorScheme,
  normalizeThemePreset,
  resolveColorScheme,
} from "../lib/theme";
import { hasSeenWhatsNew, getAppVersion } from "../lib/changelog";
import { useUpdateChecker } from "../lib/updater";
import {
  DEFAULT_TEMPLATE_MARKER_PICK_MODIFIER,
  DEFAULT_TEMPLATE_MARKER_REGENERATE_BEHAVIOR,
  normalizeTemplateMarkerPickModifier,
  normalizeTemplateMarkerRegenerateBehavior,
} from "../lib/template-marker-utils";
import {
  DEFAULT_WATERMARK,
  WATERMARK_FONTS,
  WATERMARK_POSITIONS,
  normalizeWatermarkConfig,
  renderWatermarkPreview,
} from "../lib/watermark";

/* ─── Built-in defaults (canonical source) ─── */
const BUILT_IN_DEFAULTS = {
  colorScheme: "dark",
  themePreset: "roan",
  darkMode: true,
  liveryExteriorOnly: false,
  windowTemplateEnabled: false,
  windowTextureTarget: "auto",
  cameraWASD: false,
  bodyColor: "#e7ebf0",
  autoTemplateColor: "#c9d8ee",
  autoTemplateBackgroundColor: "#000000",
  backgroundColor: "#141414",
  experimentalSettings: false,
  showHints: true,
  hideRotText: false,
  showGrid: false,
  showShadows: false,
  showRecents: true,
  lightIntensity: 1.0,
  glossiness: 0.5,
  windowControlsStyle: "windows",
  toolbarInTitlebar: false,
  uiScale: 1.0,
  previewFolder: "",
  variantExportFolder: "",
  autoTemplateExportFormat: "psd",
  cameraControlsInPanel: false,
  legacyLayersLayout: false,
  templateMarkerPickModifier: DEFAULT_TEMPLATE_MARKER_PICK_MODIFIER,
  templateMarkerRegenerateBehavior: DEFAULT_TEMPLATE_MARKER_REGENERATE_BEHAVIOR,
  watermark: { ...DEFAULT_WATERMARK },
};

function sanitizeStoredDefaults(stored) {
  if (!stored || typeof stored !== "object") return {};
  const {
    showAmbientOcclusion: _removedAmbientOcclusion,
    autoModelTexturesEnabled: _removedAutoModelTexturesEnabled,
    ...rest
  } = stored;
  return rest;
}

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
    templateMarkerPickModifier: normalizeTemplateMarkerPickModifier(
      merged.templateMarkerPickModifier,
    ),
    templateMarkerRegenerateBehavior: normalizeTemplateMarkerRegenerateBehavior(
      merged.templateMarkerRegenerateBehavior,
    ),
  };
}

function settingsSignature(defaults, hotkeys) {
  return JSON.stringify({ defaults, hotkeys });
}

function getStoredHotkeys() {
  const prefs = loadPrefs();
  const stored = prefs?.hotkeys && typeof prefs.hotkeys === "object" ? prefs.hotkeys : {};
  return mergeHotkeys(stored, DEFAULT_HOTKEYS);
}

function ColorField({ label, value, onChange, onReset }) {
  return (
    <div className="flex flex-col gap-2 min-w-0">
      <div className="text-[9px] uppercase tracking-[0.12em] font-mono" style={{ color: 'var(--mg-muted)' }}>{label}</div>
      <div className="flex items-center gap-2 min-w-0">
        <div className="relative shrink-0">
          <div className="w-7 h-7 border" style={{ background: value, borderColor: 'var(--mg-border)', borderRadius: 'var(--mg-radius)' }} />
          <input
            type="color"
            value={value}
            onChange={(event) => onChange(event.currentTarget.value)}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            aria-label={`${label} picker`}
          />
        </div>
        <input
          className="settings-input flex-1"
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          aria-label={`${label} hex color`}
        />
        <button
          type="button"
          className="settings-mini shrink-0"
          onClick={onReset}
        >
          Reset
        </button>
      </div>
    </div>
  );
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
      { id: "appearance", label: "Appearance", description: "Theme, window chrome, and studio colors.", icon: Palette },
      { id: "watermark", label: "Watermark", description: "Automatic preview watermarks.", icon: Stamp },
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
      { id: "about", label: "About", description: "Version, updates, and advanced access.", icon: Info },
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
  const [watermarkPreview, setWatermarkPreview] = useState("");
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
      window.setTimeout(() => {
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

  const updateWatermark = useCallback((key, value) => {
    setDraft((prev) => ({
      ...prev,
      watermark: { ...prev.watermark, [key]: value },
    }));
  }, []);

  useEffect(() => {
    if (!open || activeSection !== "watermark") return;
    let cancelled = false;
    renderWatermarkPreview(draft.watermark).then((url) => {
      if (!cancelled) setWatermarkPreview(url);
    });
    return () => { cancelled = true; };
  }, [open, activeSection, draft.watermark]);

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
        if (!cancelled) setPreviewFolderExists(false);
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
      templateMarkerPickModifier: normalizeTemplateMarkerPickModifier(
        draft.templateMarkerPickModifier,
      ),
      templateMarkerRegenerateBehavior: normalizeTemplateMarkerRegenerateBehavior(
        draft.templateMarkerRegenerateBehavior,
      ),
    };
    const { resolvedTheme } = applyAppearance({
      colorScheme: normalizedDraft.colorScheme,
      themePreset: normalizedDraft.themePreset,
      legacyDarkMode: normalizedDraft.darkMode,
    });
    normalizedDraft.darkMode = resolvedTheme === "dark";
    const prefs = loadPrefs() || {};
    savePrefs({ ...prefs, defaults: normalizedDraft, hotkeys: hotkeysDraft });
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

  const updateHotkey = (action, hotkey) => {
    setHotkeysDraft((prev) => ({ ...prev, [action]: hotkey }));
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
                            <h1 className="settings-dialog-title" id="settings-page-title">Settings</h1>
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
                            <h2 className="settings-content-title">{activeMeta.label}</h2>
                            <div className="settings-content-sub">{activeMeta.description}</div>
                          </div>
                          {hasChanges ? (
                            <div className="settings-save-state has-changes" aria-live="polite">
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
                              <div className="space-y-6">
                                <section className="settings-panel">
                                  <div className="settings-panel-title">Interface Configuration</div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="font-medium" style={{ color: 'var(--mg-fg)' }}>UI Scaling</div>
                                      <div className="text-[9px] mt-0.5" style={{ color: 'var(--mg-muted)' }}>Adjust interface density (Default 100%)</div>
                                    </div>
                                    <div className="flex items-center gap-4 min-w-[200px]">
                                      <input
                                        type="range"
                                        className="settings-slider flex-1 h-1 appearance-none cursor-pointer"
                                        style={{ background: 'var(--mg-border)', accentColor: 'var(--mg-primary)', borderRadius: 'var(--mg-radius)' }}
                                        min={0.5}
                                        max={1.4}
                                        step={0.05}
                                        value={clampUiScale(draft.uiScale)}
                                        onChange={(e) => setDraft((p) => ({ ...p, uiScale: clampUiScale(parseFloat(e.target.value)) }))}
                                      />
                                      <span className="font-mono text-[10px] w-12 text-right" style={{ color: 'var(--mg-primary)' }}>{Math.round(clampUiScale(draft.uiScale) * 100)}%</span>
                                    </div>
                                  </div>

                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="font-medium" style={{ color: 'var(--mg-fg)' }}>Session Persistence</div>
                                      <div className="text-[9px] mt-0.5" style={{ color: 'var(--mg-muted)' }}>Show recent activity on home screen</div>
                                    </div>
                                    <Toggle
                                      checked={draft.showRecents !== false}
                                      onChange={toggleShowRecents}
                                      ariaLabel="Toggle recent activity"
                                    />
                                  </div>
                                </section>

                                  <section className="settings-panel">
                                    <div className="settings-panel-title">Data & Storage</div>
                                    <div className="settings-row">
                                      <div className="settings-row-label">
                                        <div className="font-medium" style={{ color: 'var(--mg-fg)' }}>Preview Export Path</div>
                                        <div className="text-[9px] mt-0.5" style={{ color: 'var(--mg-muted)' }}>
                                          {draft.previewFolder || "Not configured (You will be prompted when capturing previews)"}
                                        </div>
                                        {draft.previewFolder && !previewFolderExists ? (
                                          <div className="text-[9px] mt-1" style={{ color: 'var(--mg-destructive)' }}>
                                            Saved folder no longer exists. Choose a new folder before capturing previews.
                                          </div>
                                        ) : null}
                                      </div>
                                      <div className="flex items-center gap-2">
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
                                            className="settings-mini"
                                            style={{ color: 'var(--mg-destructive)', borderColor: 'color-mix(in srgb, var(--mg-destructive) 20%, transparent)' }}
                                            onClick={() => setDraft((p) => ({ ...p, previewFolder: "" }))}
                                          >
                                            Clear
                                          </button>
                                        )}
                                      </div>
                                    </div>

                                    <div className="settings-row">
                                      <div className="settings-row-label">
                                        <div className="font-medium" style={{ color: 'var(--mg-fg)' }}>Variant Export Path</div>
                                        <div className="text-[9px] mt-0.5" style={{ color: 'var(--mg-muted)' }}>{draft.variantExportFolder || "Not configured (Default: Manual select)"}</div>
                                      </div>
                                      <div className="flex items-center gap-2">
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
                                            className="settings-mini"
                                            style={{ color: 'var(--mg-destructive)', borderColor: 'color-mix(in srgb, var(--mg-destructive) 20%, transparent)' }}
                                            onClick={() => setDraft((p) => ({ ...p, variantExportFolder: "" }))}
                                          >
                                            Clear
                                          </button>
                                        )}
                                      </div>
                                    </div>

                                    <div className="settings-row">
                                      <div className="settings-row-label">
                                        <div className="font-medium" style={{ color: 'var(--mg-fg)' }}>Auto Template Save Format</div>
                                        <div className="text-[9px] mt-0.5" style={{ color: 'var(--mg-muted)' }}>Choose which files are exported when templates auto-save</div>
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
                              <div className="space-y-6">
                                <section className="settings-panel">
                                  <div className="settings-panel-title">Navigation Defaults</div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="font-medium" style={{ color: 'var(--mg-fg)' }}>Free-Cam</div>
                                      <div className="text-[9px] mt-0.5" style={{ color: 'var(--mg-muted)' }}>Always available: W/A/S/D move, Q/E rise, Shift to boost</div>
                                    </div>
                                    <div className="settings-row-note">Enabled in every viewer mode</div>
                                  </div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="font-medium" style={{ color: 'var(--mg-fg)' }}>Hide Text Labels</div>
                                      <div className="text-[9px] mt-0.5" style={{ color: 'var(--mg-muted)' }}>Suppress rotation gizmo text in the viewport</div>
                                    </div>
                                    <Toggle
                                      checked={draft.hideRotText}
                                      onChange={(v) => setDraft((p) => ({ ...p, hideRotText: v }))}
                                      ariaLabel="Toggle text labels"
                                    />
                                  </div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="font-medium" style={{ color: 'var(--mg-fg)' }}>Panel Camera Controls</div>
                                      <div className="text-[9px] mt-0.5" style={{ color: 'var(--mg-muted)' }}>Move camera presets &amp; rotation to the side panel</div>
                                    </div>
                                    <Toggle
                                      checked={draft.cameraControlsInPanel}
                                      onChange={(v) => setDraft((p) => ({ ...p, cameraControlsInPanel: v }))}
                                      ariaLabel="Toggle panel camera controls"
                                    />
                                  </div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="font-medium" style={{ color: 'var(--mg-fg)' }}>Legacy Layers Layout</div>
                                      <div className="text-[9px] mt-0.5" style={{ color: 'var(--mg-muted)' }}>Place the layers panel at the bottom instead of the right side</div>
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
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="font-medium" style={{ color: 'var(--mg-fg)' }}>Show 3D Grid</div>
                                      <div className="text-[9px] mt-0.5" style={{ color: 'var(--mg-muted)' }}>Display the ground grid in Studio viewers</div>
                                    </div>
                                    <Toggle
                                      checked={draft.showGrid}
                                      onChange={(v) => setDraft((p) => ({ ...p, showGrid: v }))}
                                      ariaLabel="Toggle 3D grid"
                                    />
                                  </div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="font-medium" style={{ color: 'var(--mg-fg)' }}>Ground Shadows</div>
                                      <div className="text-[9px] mt-0.5" style={{ color: 'var(--mg-muted)' }}>Project a floor shadow under the vehicle in Studio viewers</div>
                                    </div>
                                    <Toggle
                                      checked={draft.showShadows}
                                      onChange={(v) => setDraft((p) => ({ ...p, showShadows: v }))}
                                      ariaLabel="Toggle ground shadows"
                                    />
                                  </div>
                                </section>

                                <section className="settings-panel">
                                  <div className="settings-panel-title">Template Marker Interaction</div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="font-medium" style={{ color: 'var(--mg-fg)' }}>Marker Pick Modifier</div>
                                      <div className="text-[9px] mt-0.5" style={{ color: 'var(--mg-muted)' }}>
                                        Hold this key while edit mode is active to pick chunks from the model or template preview.
                                      </div>
                                    </div>
                                    <div className="settings-seg">
                                      {[
                                        ["alt", "Alt"],
                                        ["shift", "Shift"],
                                        ["ctrl", "Ctrl"],
                                      ].map(([value, label]) => (
                                        <button
                                          key={value}
                                          type="button"
                                          className={`settings-seg-btn ${draft.templateMarkerPickModifier === value ? "is-on" : ""}`}
                                          onClick={() =>
                                            setDraft((prev) => ({
                                              ...prev,
                                              templateMarkerPickModifier: value,
                                            }))
                                          }
                                        >
                                          {label}
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                </section>
                              </div>
                            ) : null}

                            {/* ─── Hotkeys ─── */}
                            {activeSection === "hotkeys" ? (
                              <div className="space-y-6">
                                {Object.entries(HOTKEY_CATEGORIES).map(([categoryId, category]) => (
                                  <section key={categoryId} className="settings-panel">
                                    <div className="settings-panel-title">{category.label}</div>
                                    <div className="grid grid-cols-1 gap-1">
                                      {category.actions.map((action) => (
                                <div key={action} className="settings-row px-2 transition-colors gap-4 border-b last:border-none" style={{ borderColor: 'var(--mg-border)' }}>
                                          <div className="flex-1 min-w-0 py-2">
                                            <div className="text-[10px] font-medium" style={{ color: 'var(--mg-fg)' }}>{HOTKEY_LABELS[action]}</div>
                                          </div>
                                          <HotkeyInput
                                            value={hotkeysDraft[action]}
                                            onChange={(hotkey) => updateHotkey(action, hotkey)}
                                            onClear={() => clearHotkey(action)}
                                          />
                                        </div>
                                      ))}
                                    </div>
                                  </section>
                                ))}
                                <div className="pt-4 flex justify-between items-center" style={{ borderTop: '1px solid var(--mg-border)' }}>
                                  <div className="text-[9px] italic" style={{ color: 'var(--mg-muted)' }}>Click a field to rebind keys</div>
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
                                      <div className="font-medium" style={{ color: 'var(--mg-fg)' }}>Window Controls Style</div>
                                      <div className="text-[9px] mt-0.5" style={{ color: 'var(--mg-muted)' }}>Choose the visual style for minimize, maximize, and close</div>
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
                                  <div className="settings-panel-title">Studio Defaults</div>
                                  <p className="settings-panel-description">
                                    Set the starting colors used by viewers and generated templates.
                                  </p>
                                   <div className="grid grid-cols-2 gap-4 mt-2">
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

                            {/* ─── Watermark ─── */}
                            {activeSection === "watermark" ? (
                              <div className="space-y-6">
                                <section className="settings-panel">
                                  <div className="settings-panel-title">Watermark Configuration</div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="font-medium" style={{ color: 'var(--mg-fg)' }}>Enable Watermark</div>
                                      <div className="text-[9px] mt-0.5" style={{ color: 'var(--mg-muted)' }}>Automatically stamp previews with your text</div>
                                    </div>
                                    <Toggle
                                      checked={draft.watermark?.enabled}
                                      onChange={(v) => updateWatermark("enabled", v)}
                                      ariaLabel="Toggle watermark"
                                    />
                                  </div>
                                </section>

                                <section className="settings-panel">
                                  <div className="settings-panel-title">Content</div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="font-medium" style={{ color: 'var(--mg-fg)' }}>Watermark Text</div>
                                      <div className="text-[9px] mt-0.5" style={{ color: 'var(--mg-muted)' }}>Text to display on previews</div>
                                    </div>
                                    <input
                                      className="settings-input flex-1"
                                      value={draft.watermark?.text ?? ""}
                                      onChange={(e) => updateWatermark("text", e.target.value)}
                                      placeholder="© Your Name"
                                    />
                                  </div>

                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="font-medium" style={{ color: 'var(--mg-fg)' }}>Font Family</div>
                                      <div className="text-[9px] mt-0.5" style={{ color: 'var(--mg-muted)' }}>Typeface for watermark text</div>
                                    </div>
                                    <select
                                      className="settings-input"
                                      value={draft.watermark?.font ?? "Inter"}
                                      onChange={(e) => updateWatermark("font", e.target.value)}
                                    >
                                      {WATERMARK_FONTS.map((f) => (
                                        <option key={f.value} value={f.value}>{f.label}</option>
                                      ))}
                                    </select>
                                  </div>

                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="font-medium" style={{ color: 'var(--mg-fg)' }}>Font Size</div>
                                      <div className="text-[9px] mt-0.5" style={{ color: 'var(--mg-muted)' }}>Size in pixels</div>
                                    </div>
                                    <div className="flex items-center gap-4 min-w-[200px]">
                                      <input
                                        type="range"
                                        className="settings-slider flex-1 h-1 appearance-none cursor-pointer"
                                        style={{ background: 'var(--mg-border)', accentColor: 'var(--mg-primary)', borderRadius: 'var(--mg-radius)' }}
                                        min={8}
                                        max={120}
                                        step={1}
                                        value={draft.watermark?.fontSize ?? 32}
                                        onChange={(e) => updateWatermark("fontSize", parseInt(e.target.value, 10))}
                                      />
                                      <span className="font-mono text-[10px] w-12 text-right" style={{ color: 'var(--mg-primary)' }}>{draft.watermark?.fontSize ?? 32}px</span>
                                    </div>
                                  </div>
                                </section>

                                <section className="settings-panel">
                                  <div className="settings-panel-title">Appearance</div>
                                  <div className="grid grid-cols-2 gap-4 mt-2">
                                    <ColorField
                                      label="Text Color"
                                      value={draft.watermark?.color ?? "#ffffff"}
                                      onChange={(value) => updateWatermark("color", value)}
                                      onReset={() => updateWatermark("color", DEFAULT_WATERMARK.color)}
                                    />
                                  </div>

                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="font-medium" style={{ color: 'var(--mg-fg)' }}>Opacity</div>
                                      <div className="text-[9px] mt-0.5" style={{ color: 'var(--mg-muted)' }}>Transparency of watermark text</div>
                                    </div>
                                    <div className="flex items-center gap-4 min-w-[200px]">
                                      <input
                                        type="range"
                                        className="settings-slider flex-1 h-1 appearance-none cursor-pointer"
                                        style={{ background: 'var(--mg-border)', accentColor: 'var(--mg-primary)', borderRadius: 'var(--mg-radius)' }}
                                        min={0}
                                        max={1}
                                        step={0.05}
                                        value={draft.watermark?.opacity ?? 0.5}
                                        onChange={(e) => updateWatermark("opacity", parseFloat(e.target.value))}
                                      />
                                      <span className="font-mono text-[10px] w-12 text-right" style={{ color: 'var(--mg-primary)' }}>{Math.round((draft.watermark?.opacity ?? 0.5) * 100)}%</span>
                                    </div>
                                  </div>
                                </section>

                                <section className="settings-panel">
                                  <div className="settings-panel-title">Position &amp; Direction</div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="font-medium" style={{ color: 'var(--mg-fg)' }}>Position</div>
                                      <div className="text-[9px] mt-0.5" style={{ color: 'var(--mg-muted)' }}>Where the watermark appears on the image</div>
                                    </div>
                                    <div className="settings-seg">
                                      {WATERMARK_POSITIONS.map((p) => (
                                        <button
                                          key={p.value}
                                          type="button"
                                          className={`settings-seg-btn ${draft.watermark?.position === p.value ? "is-on" : ""}`}
                                          onClick={() => updateWatermark("position", p.value)}
                                          title={p.value}
                                        >
                                          {p.label}
                                        </button>
                                      ))}
                                    </div>
                                  </div>

                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="font-medium" style={{ color: 'var(--mg-fg)' }}>Rotation</div>
                                      <div className="text-[9px] mt-0.5" style={{ color: 'var(--mg-muted)' }}>Angle in degrees (-180 to 180)</div>
                                    </div>
                                    <div className="flex items-center gap-4 min-w-[200px]">
                                      <input
                                        type="range"
                                        className="settings-slider flex-1 h-1 appearance-none cursor-pointer"
                                        style={{ background: 'var(--mg-border)', accentColor: 'var(--mg-primary)', borderRadius: 'var(--mg-radius)' }}
                                        min={-180}
                                        max={180}
                                        step={1}
                                        value={draft.watermark?.rotation ?? 0}
                                        onChange={(e) => updateWatermark("rotation", parseInt(e.target.value, 10))}
                                      />
                                      <span className="font-mono text-[10px] w-12 text-right" style={{ color: 'var(--mg-primary)' }}>{draft.watermark?.rotation ?? 0}°</span>
                                    </div>
                                  </div>
                                </section>

                                <section className="settings-panel">
                                  <div className="settings-panel-title">Live Preview</div>
                                  <div className="rounded-lg overflow-hidden border" style={{ borderColor: 'var(--mg-border)', background: 'var(--mg-bg-elevated)' }}>
                                    {watermarkPreview ? (
                                      <img src={watermarkPreview} alt="Watermark preview" className="w-full h-auto block" />
                                    ) : (
                                      <div className="flex items-center justify-center h-48 text-[10px]" style={{ color: 'var(--mg-muted)' }}>
                                        Loading preview...
                                      </div>
                                    )}
                                  </div>
                                </section>
                              </div>
                            ) : null}

                            {/* ─── About ─── */}
                            {activeSection === "about" ? (
                              <div className="settings-about-stack">
                                <section className="settings-about-intro" aria-labelledby="settings-about-product">
                                  <div className="settings-about-copy">
                                    <div className="settings-about-kicker">Cortex Studio</div>
                                    <h3 className="settings-about-product" id="settings-about-product">Built for the livery workflow</h3>
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
                                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--mg-destructive)' }} />
                                      <div className="flex-1 min-w-0">
                                        <div className="text-[10px]" style={{ color: 'var(--mg-destructive)' }}>Published feed is behind this build</div>
                                        <div className="text-[9px] mt-0.5" style={{ color: 'var(--mg-muted)' }}>
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
                                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--mg-primary)' }} />
                                      <div className="flex-1 min-w-0">
                                        <div className="text-[10px]" style={{ color: 'var(--mg-fg)' }}>You're up to date</div>
                                        <div className="text-[9px] mt-0.5" style={{ color: 'var(--mg-muted)' }}>
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
                                      <RefreshCw className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--mg-muted)' }} />
                                      <div className="flex-1 min-w-0">
                                        <div className="text-[10px]" style={{ color: 'var(--mg-fg)' }}>Check for updates</div>
                                        <div className="text-[9px] mt-0.5" style={{ color: 'var(--mg-muted)' }}>Manual check or auto-checks every 30 min</div>
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
                                        <Loader className="h-3.5 w-3.5" style={{ color: 'var(--mg-primary)' }} />
                                      </motion.div>
                                      <div className="text-[10px]" style={{ color: 'var(--mg-muted)' }}>Checking for updates...</div>
                                    </div>
                                  ) : null}

                                  {/* Error state */}
                                  {updater.error && !updater.checking ? (
                                    <div className="settings-update-status settings-update-status--error" role="alert">
                                      <AlertCircle className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--mg-destructive)' }} />
                                      <div className="flex-1 min-w-0">
                                        <div className="text-[10px]" style={{ color: 'var(--mg-destructive)' }}>Check failed</div>
                                        <div className="text-[9px] mt-0.5 truncate" style={{ color: 'var(--mg-muted)' }}>{updater.error}</div>
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
                                        <Download className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--mg-primary)' }} />
                                        <div className="flex-1 min-w-0">
                                          <div className="text-[10px] font-medium" style={{ color: 'var(--mg-primary)' }}>
                                            Update available — v{updater.latest}
                                          </div>
                                          <div className="text-[9px] mt-0.5" style={{ color: 'var(--mg-muted)' }}>
                                            {updater.installing ? "Downloading and installing..." : "Ready to install"}
                                          </div>
                                        </div>
                                        {!updater.installing ? (
                                          <button
                                            type="button"
                                            className="settings-update-install-btn"
                                            onClick={updater.install}
                                          >
                                            Install
                                          </button>
                                        ) : null}
                                      </div>

                                      {updater.installing ? (
                                        <div className="settings-update-progress">
                                          <div className="settings-update-progress-track">
                                            <motion.div
                                              className="settings-update-progress-fill"
                                              animate={{ width: `${updater.progressPercent}%` }}
                                              transition={{ duration: 0.3, ease: "easeOut" }}
                                            />
                                          </div>
                                          <span className="settings-update-progress-pct">{updater.progressPercent}%</span>
                                        </div>
                                      ) : null}

                                      {updater.notes ? (
                                        <div className="settings-update-notes">
                                          <div className="text-[9px] uppercase tracking-[0.08em] mb-1" style={{ color: 'var(--mg-muted)' }}>Release notes</div>
                                          <div className="settings-update-notes-body">{updater.notes}</div>
                                        </div>
                                      ) : null}
                                    </div>
                                  ) : null}
                                </section>

                                <section className="settings-panel">
                                  <div className="settings-panel-title">Release Notes</div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="font-medium" style={{ color: 'var(--mg-fg)' }}>What's New</div>
                                      <div className="text-[9px] mt-0.5" style={{ color: 'var(--mg-muted)' }}>
                                        {hasSeenWhatsNew() ? "You've seen the latest notes" : "New changes since last update"}
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
                                      View Release Notes
                                    </button>
                                  </div>
                                </section>

                                <section className="settings-panel settings-experimental-panel">
                                  <div className="settings-panel-heading-row">
                                    <div>
                                      <div className="settings-panel-title">Experimental</div>
                                      <p className="settings-panel-description">
                                        Opt into early features and engineering diagnostics from one advanced area.
                                      </p>
                                    </div>
                                  </div>
                                  <div className="settings-experimental-row">
                                    <FlaskConical className="settings-experimental-icon" aria-hidden="true" />
                                    <div className="settings-experimental-copy">
                                      <div className="settings-experimental-label">Experimental features</div>
                                      <div className="settings-experimental-description">
                                        Enable features that are still being validated for everyday projects.
                                      </div>
                                    </div>
                                    <Toggle
                                      checked={draft.experimentalSettings}
                                      onChange={(v) => setDraft((p) => ({ ...p, experimentalSettings: v }))}
                                      ariaLabel="Toggle experimental features"
                                    />
                                  </div>
                                  <div className="settings-experimental-note" role="note">
                                    <AlertTriangle aria-hidden="true" />
                                    <span>
                                      Experimental features may be unstable. If a workflow behaves unexpectedly, disable this setting and restart Cortex Studio.
                                    </span>
                                  </div>
                                </section>
                              </div>
                            ) : null}
                        </div>

                        <div className="settings-footer">
                          {confirmReset ? (
                            <div className="settings-confirm-overlay">
                              <div className="settings-confirm-content">
                                <AlertTriangle className="h-4 w-4" style={{ color: 'var(--mg-destructive)' }} />
                                <span>Are you sure? This cannot be undone.</span>
                              </div>
                              <div className="settings-confirm-actions">
                                <button type="button" className="settings-mini" onClick={() => setConfirmReset(false)}>
                                  Cancel
                                </button>
                                <button type="button" className="settings-danger-btn" onClick={performReset}>
                                  Yes, Reset All
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
