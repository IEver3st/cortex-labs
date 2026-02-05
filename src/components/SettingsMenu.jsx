import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, Settings, Car, Layers, Shirt, FlaskConical } from "lucide-react";
import appMeta from "../../package.json";
import HotkeyInput from "./HotkeyInput";
import {
  DEFAULT_HOTKEYS,
  HOTKEY_ACTIONS,
  HOTKEY_CATEGORIES,
  HOTKEY_LABELS,
  mergeHotkeys,
} from "../lib/hotkeys";

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

export default function SettingsMenu({
  defaults,
  builtInDefaults,
  onSave,
  hotkeys,
  onSaveHotkeys,
}) {
  const [open, setOpen] = useState(false);
  const [hoveringIcon, setHoveringIcon] = useState(false);
  const [activeSection, setActiveSection] = useState("defaults");
  const [portalNode, setPortalNode] = useState(null);

  const initialDraft = useMemo(() => ({ ...defaults }), [defaults]);
  const [draft, setDraft] = useState(initialDraft);

  const initialHotkeysDraft = useMemo(
    () => mergeHotkeys(hotkeys, DEFAULT_HOTKEYS),
    [hotkeys]
  );
  const [hotkeysDraft, setHotkeysDraft] = useState(initialHotkeysDraft);

  useEffect(() => {
    setDraft({ ...defaults });
  }, [defaults]);

  useEffect(() => {
    setHotkeysDraft(mergeHotkeys(hotkeys, DEFAULT_HOTKEYS));
  }, [hotkeys]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    setPortalNode(document.body);
  }, []);

  const sections = useMemo(
    () => [
      {
        id: "defaults",
        label: "Defaults",
        description: "Baseline texture behavior and viewing rules.",
      },
      {
        id: "hotkeys",
        label: "Hotkeys",
        description: "Keyboard shortcuts for quick actions.",
      },
      {
        id: "camera",
        label: "Camera",
        description: "Keyboard movement and camera controls.",
      },
      {
        id: "colors",
        label: "Colors",
        description: "Body and background hues for new sessions.",
      },
      {
        id: "experimental",
        label: "Experimental",
        description: "Bleeding edge features and debug tools.",
      },
    ],
    [],
  );

  const activeMeta = sections.find((section) => section.id === activeSection) ?? sections[0];

  const save = () => {
    onSave?.(draft);
    onSaveHotkeys?.(hotkeysDraft);
    setOpen(false);
  };

  const updateHotkey = (action, hotkey) => {
    setHotkeysDraft((prev) => ({
      ...prev,
      [action]: hotkey,
    }));
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
          animate={
            hoveringIcon
              ? { rotate: 360 }
              : { rotate: 0 }
          }
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
                                    whileTap={{ scale: 0.98 }}
                                  >
                                    <Car className="mode-tab-icon" aria-hidden="true" />
                                    <span>Livery</span>
                                  </motion.button>
                                  <motion.button
                                    type="button"
                                    className={`mode-tab ${draft.textureMode === "everything" ? "is-active" : ""}`}
                                    onClick={() => setDraft((p) => ({ ...p, textureMode: "everything" }))}
                                    whileTap={{ scale: 0.98 }}
                                  >
                                    <Layers className="mode-tab-icon" aria-hidden="true" />
                                    <span>All</span>
                                  </motion.button>
                                  <motion.button
                                    type="button"
                                    className={`mode-tab ${draft.textureMode === "eup" ? "is-active" : ""}`}
                                    onClick={() => setDraft((p) => ({ ...p, textureMode: "eup" }))}
                                    whileTap={{ scale: 0.98 }}
                                  >
                                    <Shirt className="mode-tab-icon" aria-hidden="true" />
                                    <span>EUP</span>
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
                              </section>
                            ) : null}

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
                                  <button
                                    type="button"
                                    className="settings-mini"
                                    onClick={resetAllHotkeys}
                                  >
                                    Reset all hotkeys
                                  </button>
                                </div>
                              </section>
                            ) : null}

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

                            {activeSection === "colors" ? (
                              <section className="settings-panel" id="settings-panel-colors" aria-label="Colors">
                                <div className="settings-panel-title">Color defaults</div>
                                <div className="settings-panel-grid">
                                  <ColorField
                                    label="Body"
                                    value={draft.bodyColor}
                                    onChange={(value) => setDraft((p) => ({ ...p, bodyColor: value }))}
                                    onReset={() => setDraft((p) => ({ ...p, bodyColor: builtInDefaults.bodyColor }))}
                                  />
                                  <ColorField
                                    label="Background"
                                    value={draft.backgroundColor}
                                    onChange={(value) => setDraft((p) => ({ ...p, backgroundColor: value }))}
                                    onReset={() => setDraft((p) => ({ ...p, backgroundColor: builtInDefaults.backgroundColor }))}
                                  />
                                </div>
                              </section>
                            ) : null}

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
                          <div className="settings-actions">
                            <button
                              type="button"
                              className="settings-secondary"
                              onClick={() => {
                                setDraft({ ...builtInDefaults });
                                setHotkeysDraft({ ...DEFAULT_HOTKEYS });
                              }}
                            >
                              Reset all
                            </button>
                            <button type="button" className="settings-primary" onClick={save}>
                              Save
                            </button>
                          </div>
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
