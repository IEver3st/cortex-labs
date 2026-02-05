import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, Settings } from "lucide-react";

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
}) {
  const [open, setOpen] = useState(false);
  const [hoveringIcon, setHoveringIcon] = useState(false);
  const [activeSection, setActiveSection] = useState("defaults");
  const [portalNode, setPortalNode] = useState(null);

  const initialDraft = useMemo(() => ({ ...defaults }), [defaults]);
  const [draft, setDraft] = useState(initialDraft);

  useEffect(() => {
    setDraft({ ...defaults });
  }, [defaults]);

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
        id: "window",
        label: "Window",
        description: "Window overlay defaults and target behavior.",
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
    ],
    [],
  );

  const activeMeta = sections.find((section) => section.id === activeSection) ?? sections[0];

  const save = () => {
    onSave?.(draft);
    setOpen(false);
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
                >
                  <motion.div
                    className="settings-dialog"
                    initial={{ opacity: 0, y: 12, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 8, scale: 0.98 }}
                    transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
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
                                <div className="settings-seg">
                                  <button
                                    type="button"
                                    className={`settings-seg-btn ${draft.textureMode === "livery" ? "is-on" : ""}`}
                                    onClick={() => setDraft((p) => ({ ...p, textureMode: "livery" }))}
                                  >
                                    Livery
                                  </button>
                                  <button
                                    type="button"
                                    className={`settings-seg-btn ${draft.textureMode === "everything" ? "is-on" : ""}`}
                                    onClick={() => setDraft((p) => ({ ...p, textureMode: "everything" }))}
                                  >
                                    All
                                  </button>
                                  <button
                                    type="button"
                                    className={`settings-seg-btn ${draft.textureMode === "eup" ? "is-on" : ""}`}
                                    onClick={() => setDraft((p) => ({ ...p, textureMode: "eup" }))}
                                  >
                                    EUP
                                  </button>
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

                            {activeSection === "window" ? (
                              <section className="settings-panel" id="settings-panel-window" aria-label="Window">
                                <div className="settings-panel-title">Window overlay</div>
                                <div className="settings-row">
                                  <div className="settings-row-label">Enable overlay</div>
                                  <button
                                    type="button"
                                    className={`settings-toggle ${draft.windowTemplateEnabled ? "is-on" : ""}`}
                                    onClick={() => setDraft((p) => ({ ...p, windowTemplateEnabled: !p.windowTemplateEnabled }))}
                                    aria-pressed={draft.windowTemplateEnabled}
                                  >
                                    <span className="settings-toggle-dot" />
                                  </button>
                                </div>
                                <div className="settings-row">
                                  <div className="settings-row-label">Default target</div>
                                  <div className="settings-seg">
                                    <button
                                      type="button"
                                      className={`settings-seg-btn ${draft.windowTextureTarget === "auto" ? "is-on" : ""}`}
                                      onClick={() => setDraft((p) => ({ ...p, windowTextureTarget: "auto" }))}
                                    >
                                      Auto
                                    </button>
                                    <button
                                      type="button"
                                      className={`settings-seg-btn ${draft.windowTextureTarget === "all" ? "is-on" : ""}`}
                                      onClick={() => setDraft((p) => ({ ...p, windowTextureTarget: "all" }))}
                                    >
                                      All
                                    </button>
                                    <button
                                      type="button"
                                      className={`settings-seg-btn ${draft.windowTextureTarget === "none" ? "is-on" : ""}`}
                                      onClick={() => setDraft((p) => ({ ...p, windowTextureTarget: "none" }))}
                                    >
                                      None
                                    </button>
                                  </div>
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
                          </motion.div>
                        </AnimatePresence>

                        <div className="settings-footer">
                          <div className="settings-actions">
                            <button type="button" className="settings-secondary" onClick={() => setDraft({ ...builtInDefaults })}>
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
