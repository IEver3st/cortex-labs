import { useEffect, useMemo, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, Settings, Car, Layers, Shirt, FlaskConical, AlertTriangle, FolderOpen, Monitor } from "lucide-react";
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

/* ─── Built-in defaults (canonical source) ─── */
const BUILT_IN_DEFAULTS = {
  textureMode: "everything",
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
  lightIntensity: 1.0,
  glossiness: 0.5,
  windowControlsStyle: "windows",
  toolbarInTitlebar: false,
  uiScale: 1.0,
  previewFolder: "",
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
    <div className="settings-row">
      <div className="settings-row-label">{label}</div>
      <div className="settings-color">
        <div className="color-swatch-wrapper">
          <div className="color-swatch" style={{ background: value }} />
          <input
            type="color"
            value={value}
            onChange={(event) => onChange(event.currentTarget.value)}
            className="color-picker-native"
            aria-label={`${label} picker`}
          />
        </div>
        <input
          className="settings-input mono"
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
        <button type="button" className="settings-mini" onClick={onReset} aria-label={`Reset ${label}`}>
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
export default function SettingsMenu({ onSettingsSaved }) {
  const [open, setOpen] = useState(false);
  const [hoveringIcon, setHoveringIcon] = useState(false);
  const [activeSection, setActiveSection] = useState("defaults");
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
      { id: "defaults", label: "Defaults", description: "Baseline texture behavior and viewing rules." },
      { id: "display", label: "Display", description: "UI scaling and layout preferences." },
      { id: "hotkeys", label: "Hotkeys", description: "Keyboard shortcuts for quick actions." },
      { id: "camera", label: "Camera", description: "Keyboard movement and camera controls." },
      { id: "colors", label: "Appearance", description: "Window style and interface colors." },
      { id: "export", label: "Export", description: "Preview and export output settings." },
      { id: "experimental", label: "Experimental", description: "Bleeding edge features and debug tools." },
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
                        <div className="settings-nav-title">Sections</div>
                        <div className="settings-nav-list" role="list">
                          {sections.map((section) => (
                            <motion.button
                              key={section.id}
                              type="button"
                              className={`settings-nav-item ${activeSection === section.id ? "is-active" : ""}`}
                              onClick={() => setActiveSection(section.id)}
                              aria-current={activeSection === section.id ? "page" : undefined}
                              whileTap={{ scale: 0.98 }}
                            >
                              <span className="settings-nav-item-label">{section.label}</span>
                              <span className="settings-nav-item-meta">{section.description}</span>
                            </motion.button>
                          ))}
                        </div>
                        <div className="settings-version">Cortex Studio v{appMeta.version}</div>
                      </nav>

                      <div className="settings-content">
                        <div className="settings-content-header">
                          <div className="settings-content-title">{activeMeta.label}</div>
                          <div className="settings-content-sub">{activeMeta.description}</div>
                        </div>

                        <AnimatePresence mode="wait">
                          <motion.div
                            key={activeSection}
                            className="settings-content-body"
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -8 }}
                            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                          >
                            {/* ─── Defaults ─── */}
                            {activeSection === "defaults" ? (
                              <section className="settings-panel" id="settings-panel-defaults" aria-label="Defaults">
                                <div className="settings-panel-title">Texture defaults</div>
                                <div className="settings-row">
                                  <div className="settings-row-label">Default mode</div>
                                  <div className="mode-tabs">
                                    <motion.button
                                      type="button"
                                      className={`mode-tab ${draft.textureMode === "livery" ? "is-active" : ""}`}
                                      onClick={() => setDraft((p) => ({ ...p, textureMode: "livery" }))}
                                      whileTap={{ scale: 0.95 }}
                                    >
                                      <div className="mode-tab-content">
                                        <Car className="mode-tab-icon" aria-hidden="true" />
                                        <span>Livery</span>
                                      </div>
                                      {draft.textureMode === "livery" && (
                                        <motion.div
                                          layoutId="settings-mode-highlight"
                                          className="mode-tab-bg"
                                          transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
                                        />
                                      )}
                                    </motion.button>
                                    <motion.button
                                      type="button"
                                      className={`mode-tab ${draft.textureMode === "everything" ? "is-active" : ""}`}
                                      onClick={() => setDraft((p) => ({ ...p, textureMode: "everything" }))}
                                      whileTap={{ scale: 0.95 }}
                                    >
                                      <div className="mode-tab-content">
                                        <Layers className="mode-tab-icon" aria-hidden="true" />
                                        <span>All</span>
                                      </div>
                                      {draft.textureMode === "everything" && (
                                        <motion.div
                                          layoutId="settings-mode-highlight"
                                          className="mode-tab-bg"
                                          transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
                                        />
                                      )}
                                    </motion.button>
                                    <motion.button
                                      type="button"
                                      className={`mode-tab ${draft.textureMode === "eup" ? "is-active" : ""}`}
                                      onClick={() => setDraft((p) => ({ ...p, textureMode: "eup" }))}
                                      whileTap={{ scale: 0.95 }}
                                    >
                                      <div className="mode-tab-content">
                                        <Shirt className="mode-tab-icon" aria-hidden="true" />
                                        <span>EUP</span>
                                      </div>
                                      {draft.textureMode === "eup" && (
                                        <motion.div
                                          layoutId="settings-mode-highlight"
                                          className="mode-tab-bg"
                                          transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
                                        />
                                      )}
                                    </motion.button>
                                  </div>
                                </div>

                                <div className="settings-row">
                                  <div className="settings-row-label">Exterior only</div>
                                  <button
                                    type="button"
                                    className={`settings-toggle ${draft.liveryExteriorOnly ? "is-on" : ""}`}
                                    onClick={() => setDraft((p) => ({ ...p, liveryExteriorOnly: !p.liveryExteriorOnly }))}
                                    aria-pressed={draft.liveryExteriorOnly}
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
                              </section>
                            ) : null}

                            {/* ─── Hotkeys ─── */}
                            {activeSection === "hotkeys" ? (
                              <section className="settings-panel" id="settings-panel-hotkeys" aria-label="Hotkeys">
                                {Object.entries(HOTKEY_CATEGORIES).map(([categoryId, category]) => (
                                  <div key={categoryId} className="settings-hotkey-category">
                                    <div className="settings-panel-title">{category.label}</div>
                                    {category.actions.map((action) => (
                                      <div key={action} className="settings-row">
                                        <div className="settings-row-label">{HOTKEY_LABELS[action]}</div>
                                        <HotkeyInput
                                          value={hotkeysDraft[action]}
                                          onChange={(hotkey) => updateHotkey(action, hotkey)}
                                          onClear={() => clearHotkey(action)}
                                        />
                                      </div>
                                    ))}
                                  </div>
                                ))}
                                <div className="settings-row">
                                  <div className="settings-row-note">
                                    Click a hotkey field and press your desired key combination.
                                  </div>
                                </div>
                                <div className="settings-hotkey-reset">
                                  <button type="button" className="settings-mini" onClick={resetAllHotkeys}>
                                    Reset all hotkeys
                                  </button>
                                </div>
                              </section>
                            ) : null}

                            {/* ─── Camera ─── */}
                            {activeSection === "camera" ? (
                              <section className="settings-panel" id="settings-panel-camera" aria-label="Camera">
                                <div className="settings-panel-title">Camera controls</div>
                                <div className="settings-row">
                                  <div className="settings-row-label">WASD mode</div>
                                  <button
                                    type="button"
                                    className={`settings-toggle ${draft.cameraWASD ? "is-on" : ""}`}
                                    onClick={() => setDraft((p) => ({ ...p, cameraWASD: !p.cameraWASD }))}
                                    aria-pressed={draft.cameraWASD}
                                  >
                                    <span className="settings-toggle-dot" />
                                  </button>
                                </div>
                                <div className="settings-row">
                                  <div className="settings-row-note">
                                    W/A/S/D pan, Q/E rise, Shift to boost.
                                  </div>
                                </div>

                                <div className="settings-row">
                                  <div className="settings-row-label">Grid background</div>
                                  <button
                                    type="button"
                                    className={`settings-toggle ${draft.showGrid ? "is-on" : ""}`}
                                    onClick={() => setDraft((p) => ({ ...p, showGrid: !p.showGrid }))}
                                    aria-pressed={draft.showGrid}
                                  >
                                    <span className="settings-toggle-dot" />
                                  </button>
                                </div>

                                <div className="settings-row">
                                  <div className="settings-row-label">Show hints</div>
                                  <button
                                    type="button"
                                    className={`settings-toggle ${draft.showHints ? "is-on" : ""}`}
                                    onClick={() => setDraft((p) => ({ ...p, showHints: !p.showHints }))}
                                    aria-pressed={draft.showHints}
                                  >
                                    <span className="settings-toggle-dot" />
                                  </button>
                                </div>
                              </section>
                            ) : null}

                            {/* ─── Appearance ─── */}
                            {activeSection === "colors" ? (
                              <section className="settings-panel" id="settings-panel-colors" aria-label="Appearance">
                                <div className="settings-panel-title">Interface Style</div>
                                <div className="settings-row">
                                  <div className="settings-row-label">Window Controls</div>
                                  <div className="style-pill-toggle">
                                    <button
                                      type="button"
                                      className={`style-pill-option ${draft.windowControlsStyle !== "mac" ? "is-active" : ""}`}
                                      onClick={() => setDraft((p) => ({ ...p, windowControlsStyle: "windows" }))}
                                    >
                                      Standard
                                    </button>
                                    <button
                                      type="button"
                                      className={`style-pill-option ${draft.windowControlsStyle === "mac" ? "is-active" : ""}`}
                                      onClick={() => setDraft((p) => ({ ...p, windowControlsStyle: "mac" }))}
                                    >
                                      Elegant
                                    </button>
                                  </div>
                                </div>

                                <div className="settings-panel-title" style={{ marginTop: 16 }}>Colors</div>
                                <div className="settings-panel-grid">
                                  <ColorField
                                    label="Body"
                                    value={draft.bodyColor}
                                    onChange={(value) => setDraft((p) => ({ ...p, bodyColor: value }))}
                                    onReset={() => setDraft((p) => ({ ...p, bodyColor: BUILT_IN_DEFAULTS.bodyColor }))}
                                  />
                                  <ColorField
                                    label="Background"
                                    value={draft.backgroundColor}
                                    onChange={(value) => setDraft((p) => ({ ...p, backgroundColor: value }))}
                                    onReset={() => setDraft((p) => ({ ...p, backgroundColor: BUILT_IN_DEFAULTS.backgroundColor }))}
                                  />
                                </div>
                              </section>
                            ) : null}

                            {/* ─── Export ─── */}
                            {activeSection === "export" ? (
                              <section className="settings-panel" id="settings-panel-export" aria-label="Export">
                                <div className="settings-panel-title">Preview export</div>
                                <div className="settings-row">
                                  <div className="settings-row-label">
                                    <div className="flex items-center gap-2">
                                      <FolderOpen className="h-3 w-3 opacity-60" />
                                      <span>Preview Folder</span>
                                    </div>
                                  </div>
                                  <div className="settings-folder-control">
                                    <button
                                      type="button"
                                      className="settings-folder-btn"
                                      onClick={handleSelectPreviewFolder}
                                    >
                                      {draft.previewFolder
                                        ? draft.previewFolder.split(/[\\/]/).pop()
                                        : "Select folder..."}
                                    </button>
                                    {draft.previewFolder && (
                                      <button
                                        type="button"
                                        className="settings-mini"
                                        onClick={() => setDraft((p) => ({ ...p, previewFolder: "" }))}
                                      >
                                        Clear
                                      </button>
                                    )}
                                  </div>
                                </div>
                                <div className="settings-row">
                                  <div className="settings-row-note">
                                    Where generated preview images will be saved. You can also set this during onboarding.
                                  </div>
                                </div>
                                {draft.previewFolder && (
                                  <div className="settings-row">
                                    <div className="settings-row-note mono" style={{ fontSize: 10, opacity: 0.5 }}>
                                      {draft.previewFolder}
                                    </div>
                                  </div>
                                )}
                              </section>
                            ) : null}

                            {/* ─── Experimental ─── */}
                            {activeSection === "experimental" ? (
                              <section className="settings-panel" id="settings-panel-experimental" aria-label="Experimental">
                                <div className="settings-panel-title">Experimental features</div>
                                <div className="settings-row">
                                  <div className="settings-row-label">
                                    <div className="flex items-center gap-2">
                                      <FlaskConical className="h-3 w-3 text-orange-400" />
                                      <span>Enable experimental settings</span>
                                    </div>
                                  </div>
                                  <button
                                    type="button"
                                    className={`settings-toggle ${draft.experimentalSettings ? "is-on" : ""}`}
                                    onClick={() => setDraft((p) => ({ ...p, experimentalSettings: !p.experimentalSettings }))}
                                    aria-pressed={draft.experimentalSettings}
                                  >
                                    <span className="settings-toggle-dot" />
                                  </button>
                                </div>
                                <div className="settings-row">
                                  <div className="settings-row-note text-orange-400/80">
                                    These features are not fully stable and may cause issues. Use at your own risk.
                                  </div>
                                </div>
                              </section>
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
