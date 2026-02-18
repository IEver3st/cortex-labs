import { useEffect, useMemo, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, Settings, Car, FlaskConical, AlertTriangle, Monitor, Clock, Palette, Info } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import appMeta from "../../package.json";
import HotkeyInput from "./HotkeyInput";
import {
  DEFAULT_HOTKEYS,
  HOTKEY_CATEGORIES,
  HOTKEY_LABELS,
  mergeHotkeys,
} from "../lib/hotkeys";
import { loadPrefs, savePrefs } from "../lib/prefs";
import { hasSeenWhatsNew, getAppVersion } from "../lib/changelog";

/* ─── Built-in defaults (canonical source) ─── */
const BUILT_IN_DEFAULTS = {
  liveryExteriorOnly: false,
  windowTemplateEnabled: false,
  windowTextureTarget: "auto",
  cameraWASD: false,
  bodyColor: "#e7ebf0",
  backgroundColor: "#141414",
  experimentalSettings: false,
  showHints: true,
  hideRotText: false,
  showGrid: false,
  showRecents: true,
  lightIntensity: 1.0,
  glossiness: 0.5,
  windowControlsStyle: "windows",
  toolbarInTitlebar: false,
  uiScale: 1.0,
  previewFolder: "",
  variantExportFolder: "",
};

function getStoredDefaults() {
  const prefs = loadPrefs();
  const stored = prefs?.defaults && typeof prefs.defaults === "object" ? prefs.defaults : {};
  return { ...BUILT_IN_DEFAULTS, ...stored };
}

function getStoredHotkeys() {
  const prefs = loadPrefs();
  const stored = prefs?.hotkeys && typeof prefs.hotkeys === "object" ? prefs.hotkeys : {};
  return mergeHotkeys(stored, DEFAULT_HOTKEYS);
}

function ColorField({ label, value, onChange, onReset }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[9px] uppercase tracking-[0.12em] font-mono" style={{ color: 'var(--mg-muted)' }}>{label}</div>
      <div className="flex items-center gap-2">
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
          className="settings-input flex-1 min-w-0"
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
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

/**
 * SettingsMenu — self-contained settings panel.
 * Reads/writes prefs directly via loadPrefs()/savePrefs().
 * Shell renders this in the chrome bar; it emits onSettingsSaved when prefs are persisted.
 */
export default function SettingsMenu({ onSettingsSaved, onOpenReleaseNotes }) {
  const [open, setOpen] = useState(false);
  const [hoveringIcon, setHoveringIcon] = useState(false);
  const [activeSection, setActiveSection] = useState("general");
  const [portalNode, setPortalNode] = useState(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const [draft, setDraft] = useState(() => getStoredDefaults());
  const [hotkeysDraft, setHotkeysDraft] = useState(() => getStoredHotkeys());

  const isTauriRuntime =
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__ !== "undefined";

  // Refresh draft from storage when the dialog opens
  useEffect(() => {
    if (open) {
      setDraft(getStoredDefaults());
      setHotkeysDraft(getStoredHotkeys());
      setConfirmReset(false);
    }
  }, [open]);

  const performReset = () => {
    setDraft({ ...BUILT_IN_DEFAULTS });
    setHotkeysDraft({ ...DEFAULT_HOTKEYS });
    setConfirmReset(false);
  };

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    setPortalNode(document.body);
  }, []);

  const sections = useMemo(
    () => [
      { id: "general", label: "System", description: "Interface scaling and core behavior.", icon: Monitor },
      { id: "viewer", label: "Viewer", description: "Interaction and rendering defaults.", icon: Car },
      { id: "hotkeys", label: "Shortcuts", description: "Global keyboard configurations.", icon: Clock },
      { id: "appearance", label: "Design", description: "Color schemes and interface aesthetics.", icon: Palette },
      { id: "experimental", label: "Experimental", description: "Beta features and diagnostic tools.", icon: FlaskConical },
      { id: "about", label: "About", description: "Version info and release notes.", icon: Info },
    ],
    [],
  );

  const activeMeta = sections.find((section) => section.id === activeSection) ?? sections[0];

  const save = useCallback(() => {
    const prefs = loadPrefs() || {};
    savePrefs({ ...prefs, defaults: draft, hotkeys: hotkeysDraft });
    // Apply UI scale immediately
    document.documentElement.style.setProperty("--es-ui-scale", String(draft.uiScale ?? 1.0));
    setOpen(false);
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
    setOpen((prev) => !prev);
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

    onSettingsSaved?.();
  }, [draft.showRecents, onSettingsSaved]);

  return (
    <div className="settings-anchor">
      <motion.button
        type="button"
        className="settings-cog"
        aria-label="Settings"
        onClick={toggleOpen}
        onMouseEnter={() => setHoveringIcon(true)}
        onMouseLeave={() => setHoveringIcon(false)}
      >
        <motion.span
          className="settings-cog-icon"
          animate={hoveringIcon ? { rotate: 360 } : { rotate: 0 }}
          transition={
            hoveringIcon
              ? { repeat: Infinity, duration: 0.8, ease: "linear" }
              : { duration: 0.2, ease: [0.22, 1, 0.36, 1] }
          }
        >
          <Settings className="settings-cog-svg" />
        </motion.span>
      </motion.button>

      {portalNode
        ? createPortal(
            <AnimatePresence>
              {open ? (
                <motion.div
                  className="settings-page"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                  onClick={() => setOpen(false)}
                >
                  <motion.div
                    className="settings-dialog"
                    initial={{ opacity: 0, y: 12, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 8, scale: 0.98 }}
                    transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="settings-dialog-header">
                      <button
                        type="button"
                        className="settings-back"
                        onClick={() => setOpen(false)}
                        aria-label="Back"
                      >
                        <ArrowLeft className="settings-back-icon" aria-hidden="true" />
                      </button>
                      <div className="settings-dialog-title-group">
                        <div className="settings-dialog-title">Settings</div>
                        <div className="settings-dialog-sub">Cortex Studio</div>
                      </div>
                    </div>
                    <div className="settings-shell">
                      <nav className="settings-nav" aria-label="Settings sections">
                        <div className="settings-nav-list" role="list">
                          {sections.map((section) => {
                            const Icon = section.icon;
                            const isActive = activeSection === section.id;
                            return (
                              <motion.button
                                key={section.id}
                                type="button"
                                className={`settings-nav-item ${isActive ? "is-active" : ""}`}
                                onClick={() => setActiveSection(section.id)}
                                aria-current={isActive ? "page" : undefined}
                                whileTap={{ scale: 0.98 }}
                              >
                                <div className="flex items-center gap-2.5">
                                  <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: isActive ? 'var(--mg-primary)' : 'var(--mg-muted)', opacity: isActive ? 1 : 0.6 }} />
                                  <div className="flex flex-col text-left">
                                    <span className="settings-nav-item-label">{section.label}</span>
                                    <span className="settings-nav-item-meta line-clamp-1">{section.description}</span>
                                  </div>
                                </div>
                              </motion.button>
                            );
                          })}
                        </div>
                         <div className="settings-version">v{appMeta.version}</div>
                      </nav>

                      <div className="settings-content">
                        <div className="settings-content-header">
                          <div className="settings-content-title">{activeMeta.label}</div>
                          <div className="settings-content-sub">{activeMeta.description}</div>
                        </div>

                        <AnimatePresence mode="wait">
                          <motion.div
                            key={activeSection}
                            className="settings-content-body custom-scrollbar"
                            initial={{ opacity: 0, x: 10 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: -10 }}
                            transition={{ duration: 0.15, ease: "easeOut" }}
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
                                        max={2.0}
                                        step={0.05}
                                        value={draft.uiScale ?? 1.0}
                                        onChange={(e) => setDraft((p) => ({ ...p, uiScale: parseFloat(e.target.value) }))}
                                      />
                                      <span className="font-mono text-[10px] w-12 text-right" style={{ color: 'var(--mg-primary)' }}>{Math.round((draft.uiScale ?? 1.0) * 100)}%</span>
                                    </div>
                                  </div>

                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="font-medium" style={{ color: 'var(--mg-fg)' }}>Session Persistence</div>
                                      <div className="text-[9px] mt-0.5" style={{ color: 'var(--mg-muted)' }}>Show recent activity on home screen</div>
                                    </div>
                                    <button
                                      type="button"
                                      className={`settings-toggle ${draft.showRecents !== false ? "is-on" : ""}`}
                                      onClick={toggleShowRecents}
                                    >
                                      <span className="settings-toggle-dot" />
                                    </button>
                                  </div>
                                </section>

                                  <section className="settings-panel">
                                    <div className="settings-panel-title">Data & Storage</div>
                                    <div className="settings-row">
                                      <div className="settings-row-label">
                                        <div className="font-medium" style={{ color: 'var(--mg-fg)' }}>Preview Export Path</div>
                                        <div className="text-[9px] mt-0.5" style={{ color: 'var(--mg-muted)' }}>{draft.previewFolder || "Not configured (Default: System Temp)"}</div>
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
                                            style={{ color: 'var(--mg-destructive)', borderColor: 'oklch(0.704 0.191 22.216 / 20%)' }}
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
                                            style={{ color: 'var(--mg-destructive)', borderColor: 'oklch(0.704 0.191 22.216 / 20%)' }}
                                            onClick={() => setDraft((p) => ({ ...p, variantExportFolder: "" }))}
                                          >
                                            Clear
                                          </button>
                                        )}
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
                                      <div className="font-medium" style={{ color: 'var(--mg-fg)' }}>WASD Free-Cam</div>
                                      <div className="text-[9px] mt-0.5" style={{ color: 'var(--mg-muted)' }}>W/A/S/D pan, Q/E rise, Shift to boost</div>
                                    </div>
                                    <button
                                      type="button"
                                      className={`settings-toggle ${draft.cameraWASD ? "is-on" : ""}`}
                                      onClick={() => setDraft((p) => ({ ...p, cameraWASD: !p.cameraWASD }))}
                                    >
                                      <span className="settings-toggle-dot" />
                                    </button>
                                  </div>

                                <div className="settings-row">
                                  <div className="settings-row-label">Hide text labels</div>
                                  <button
                                    type="button"
                                    className={`settings-toggle ${draft.hideRotText ? "is-on" : ""}`}
                                    onClick={() => setDraft((p) => ({ ...p, hideRotText: !p.hideRotText }))}
                                    aria-pressed={draft.hideRotText}
                                  >
                                    <span className="settings-toggle-dot" />
                                  </button>
                                </div>
                              </section>
                              </div>
                            ) : null}

                            {/* ─── Display (UI Scale) ─── */}
                            {activeSection === "display" ? (
                              <section className="settings-panel" id="settings-panel-display" aria-label="Display">
                                <div className="settings-panel-title">Interface scaling</div>
                                <div className="settings-row">
                                  <div className="settings-row-label">
                                    <div className="flex items-center gap-2">
                                      <Monitor className="h-3 w-3 opacity-60" />
                                      <span>UI Scale</span>
                                    </div>
                                  </div>
                                  <div className="settings-scale-control">
                                    <input
                                      type="range"
                                      className="settings-slider"
                                      min={0.8}
                                      max={1.4}
                                      step={0.05}
                                      value={draft.uiScale ?? 1.0}
                                      onChange={(e) => setDraft((p) => ({ ...p, uiScale: parseFloat(e.target.value) }))}
                                    />
                                    <span className="settings-scale-value">{Math.round((draft.uiScale ?? 1.0) * 100)}%</span>
                                  </div>
                                </div>
                                <div className="settings-row">
                                  <div className="settings-row-note">
                                    Adjusts the overall UI text and element sizes. Default is 100%.
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  className="settings-mini"
                                  style={{ marginTop: 4 }}
                                  onClick={() => setDraft((p) => ({ ...p, uiScale: 1.0 }))}
                                >
                                  Reset to 100%
                                </button>
                                <div className="settings-row" style={{ marginTop: 16 }}>
                                  <div className="settings-row-label">Show recent sessions</div>
                                  <button
                                    type="button"
                                    className={`settings-toggle ${draft.showRecents ? "is-on" : ""}`}
                                    onClick={() => setDraft((p) => ({ ...p, showRecents: !p.showRecents }))}
                                    aria-pressed={draft.showRecents}
                                  >
                                    <span className="settings-toggle-dot" />
                                  </button>
                                </div>
                                <div className="settings-row">
                                  <div className="settings-row-note">
                                    Hide the Recent list on the Home page when you want a cleaner launch screen.
                                  </div>
                                </div>
                              </section>
                            ) : null}

                            {/* ─── Hotkeys ─── */}
                            {activeSection === "hotkeys" ? (
                              <div className="space-y-6">
                                {Object.entries(HOTKEY_CATEGORIES).map(([categoryId, category]) => (
                                  <section key={categoryId} className="settings-panel">
                                    <div className="settings-panel-title">{category.label}</div>
                                    <div className="grid grid-cols-1 gap-1">
                                      {category.actions.map((action) => (
                                <div className="settings-row hover:bg-white/[0.02] px-2 transition-colors gap-4 border-b last:border-none" style={{ borderColor: 'var(--mg-border)' }}>
                                          <div className="flex-1 min-w-0 py-2">
                                            <div className="text-[10px] font-medium" style={{ color: 'oklch(0.985 0.002 286.375 / 80%)' }}>{HOTKEY_LABELS[action]}</div>
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
                              <div className="space-y-6">
                                  <section className="settings-panel">
                                    <div className="settings-panel-title">Environment Controls</div>
                                    <div className="settings-row">
                                      <div className="settings-row-label">
                                        <div className="font-medium" style={{ color: 'var(--mg-fg)' }}>Show 3D Grid</div>
                                        <div className="text-[9px] mt-0.5" style={{ color: 'var(--mg-muted)' }}>Display ground grid in the viewer</div>
                                      </div>
                                      <button
                                        type="button"
                                        className={`settings-toggle ${draft.showGrid ? "is-on" : ""}`}
                                        onClick={() => setDraft((p) => ({ ...p, showGrid: !p.showGrid }))}
                                      >
                                        <span className="settings-toggle-dot" />
                                      </button>
                                    </div>
                                  </section>

                                  <section className="settings-panel">
                                    <div className="settings-panel-title">Interface Aesthetic</div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="font-medium" style={{ color: 'var(--mg-fg)' }}>Window Controls Style</div>
                                      <div className="text-[9px] mt-0.5" style={{ color: 'var(--mg-muted)' }}>Select visual theme for window buttons</div>
                                    </div>
                                    <div className="flex p-0.5" style={{ background: 'var(--mg-input-bg)', border: '1px solid var(--mg-border)', borderRadius: 'var(--mg-radius)' }}>
                                      <button
                                        type="button"
                                        className={`px-3 py-1 text-[9px] transition-all ${draft.windowControlsStyle !== "mac" ? "font-bold" : ""}`}
                                        style={{
                                          borderRadius: 'calc(var(--mg-radius) - 2px)',
                                          background: draft.windowControlsStyle !== "mac" ? 'oklch(0.648 0.116 182.503 / 15%)' : 'transparent',
                                          color: draft.windowControlsStyle !== "mac" ? 'var(--mg-primary)' : 'var(--mg-muted)'
                                        }}
                                        onClick={() => setDraft((p) => ({ ...p, windowControlsStyle: "windows" }))}
                                      >
                                        Standard
                                      </button>
                                      <button
                                        type="button"
                                        className={`px-3 py-1 text-[9px] transition-all ${draft.windowControlsStyle === "mac" ? "font-bold" : ""}`}
                                        style={{
                                          borderRadius: 'calc(var(--mg-radius) - 2px)',
                                          background: draft.windowControlsStyle === "mac" ? 'oklch(0.648 0.116 182.503 / 15%)' : 'transparent',
                                          color: draft.windowControlsStyle === "mac" ? 'var(--mg-primary)' : 'var(--mg-muted)'
                                        }}
                                        onClick={() => setDraft((p) => ({ ...p, windowControlsStyle: "mac" }))}
                                      >
                                        Elegant
                                      </button>
                                    </div>
                                  </div>
                                </section>

                                <section className="settings-panel">
                                  <div className="settings-panel-title">Default Environment Colors</div>
                                   <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6 mt-2">
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
                                  </div>
                                </section>
                              </div>
                            ) : null}

                            {/* ─── Experimental ─── */}
                            {activeSection === "experimental" ? (
                              <div className="space-y-6">
                                <section className="settings-panel" style={{ border: '1px solid oklch(0.704 0.191 22.216 / 15%)', background: 'oklch(0.704 0.191 22.216 / 4%)' }}>
                                  <div className="flex gap-4 items-start">
                                    <FlaskConical className="h-4 w-4 shrink-0 mt-0.5" style={{ color: 'var(--mg-destructive)' }} />
                                    <div className="flex-1">
                                      <div className="font-bold uppercase text-[9px] tracking-[0.12em] mb-2" style={{ color: 'var(--mg-destructive)' }}>Beta Access Protocol</div>
                                      <div className="settings-row border-none p-0 mb-4">
                                        <div className="text-[10px] max-w-[28ch]" style={{ color: 'var(--mg-muted)' }}>Unlock unstable features and engineering tools</div>
                                        <button
                                          type="button"
                                          className={`settings-toggle ${draft.experimentalSettings ? "is-on" : ""}`}
                                          onClick={() => setDraft((p) => ({ ...p, experimentalSettings: !p.experimentalSettings }))}
                                        >
                                          <span className="settings-toggle-dot" />
                                        </button>
                                      </div>
                                      <div className="text-[9px] leading-relaxed italic" style={{ color: 'oklch(0.704 0.191 22.216 / 50%)' }}>
                                        Warning: These features are not production-ready. Enabling them may cause memory leaks or renderer crashes.
                                      </div>
                                    </div>
                                  </div>
                                </section>
                              </div>
                            ) : null}

                            {/* ─── About ─── */}
                            {activeSection === "about" ? (
                              <div className="space-y-6">
                                <section className="settings-panel">
                                  <div className="settings-panel-title">Application</div>
                                  <div className="settings-row">
                                    <div className="settings-row-label">
                                      <div className="font-medium" style={{ color: 'var(--mg-fg)' }}>Version</div>
                                      <div className="text-[9px] mt-0.5" style={{ color: 'var(--mg-muted)' }}>Current installed version</div>
                                    </div>
                                    <span className="font-mono text-[11px]" style={{ color: 'var(--mg-primary)' }}>v{getAppVersion()}</span>
                                  </div>
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
                                        setOpen(false);
                                        setTimeout(() => onOpenReleaseNotes?.(), 220);
                                      }}
                                    >
                                      View Release Notes
                                    </button>
                                  </div>
                                </section>
                              </div>
                            ) : null}
                          </motion.div>
                        </AnimatePresence>

                        <div className="settings-footer">
                          {confirmReset ? (
                            <div className="settings-confirm-overlay">
                              <div className="settings-confirm-content">
                                <AlertTriangle className="h-4 w-4 text-orange-400" />
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
                              <button type="button" className="settings-primary" onClick={save}>
                                Save
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </motion.div>
                </motion.div>
              ) : null}
            </AnimatePresence>,
            portalNode,
          )
        : null}
    </div>
  );
}
