import { useCallback, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Car, Layers, Shirt, Eye, Palette, Monitor, ChevronRight, ChevronLeft, Check, FolderOpen } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

const DEFAULT_BODY = "#e7ebf0";
const DEFAULT_BG = "#141414";

const STEPS = [
  { id: "welcome", title: "Welcome" },
  { id: "mode", title: "Default Mode" },
  { id: "appearance", title: "Appearance" },
  { id: "export", title: "Export" },
  { id: "ready", title: "Ready" },
];

function StepIndicator({ current, total }) {
  return (
    <div className="onb-steps">
      {Array.from({ length: total }, (_, i) => (
        <motion.div
          key={i}
          className={`onb-step-dot ${i === current ? "is-current" : i < current ? "is-done" : ""}`}
          animate={{
            scale: i === current ? 1.2 : 1,
            backgroundColor: i <= current ? "var(--es-success)" : "rgba(255,255,255,0.12)",
          }}
          transition={{ duration: 0.25 }}
        />
      ))}
    </div>
  );
}

function ColorPickerRow({ label, value, onChange }) {
  return (
    <div className="onb-color-row">
      <span className="onb-color-label">{label}</span>
      <div className="onb-color-control">
        <div className="onb-color-swatch-wrap">
          <div className="onb-color-swatch" style={{ background: value }} />
          <input
            type="color"
            value={value}
            onChange={(e) => onChange(e.currentTarget.value)}
            className="onb-color-native"
            aria-label={`${label} color picker`}
          />
        </div>
        <input
          type="text"
          className="onb-color-hex"
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      </div>
    </div>
  );
}

export default function Onboarding({ onComplete }) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState({
    textureMode: "livery",
    liveryExteriorOnly: false,
    windowTemplateEnabled: false,
    windowTextureTarget: "auto",
    cameraWASD: false,
    bodyColor: DEFAULT_BODY,
    backgroundColor: DEFAULT_BG,
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
  });

  const isTauriRuntime =
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__ !== "undefined";

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

  const ease = useMemo(() => [0.22, 1, 0.36, 1], []);

  const next = useCallback(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), []);
  const prev = useCallback(() => setStep((s) => Math.max(s - 1, 0)), []);
  const finish = useCallback(() => onComplete?.(draft), [draft, onComplete]);

  const modeOptions = [
    { id: "livery", label: "Livery", desc: "Auto-targets carpaint materials", icon: Car, color: "#7dd3fc" },
    { id: "everything", label: "All", desc: "Texture applied to every mesh", icon: Layers, color: "#a78bfa" },
    { id: "eup", label: "EUP", desc: "Uniform & clothing textures", icon: Shirt, color: "#f97316" },
  ];

  return (
    <motion.div
      className="onb-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3, ease }}
    >
      <motion.div
        className="onb-container"
        initial={{ opacity: 0, y: 16, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.98 }}
        transition={{ duration: 0.4, ease }}
      >
        <StepIndicator current={step} total={STEPS.length} />

        <div className="onb-body">
          <AnimatePresence mode="wait" initial={false}>
            {/* Step 0: Welcome */}
            {step === 0 && (
              <motion.div
                key="welcome"
                className="onb-slide"
                initial={{ opacity: 0, x: 30 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -30 }}
                transition={{ duration: 0.25, ease }}
              >
                <div className="onb-welcome-brand">Cortex Studio</div>
                <div className="onb-welcome-sub">
                  Configure your workspace defaults. Everything here can be changed later in Settings.
                </div>
              </motion.div>
            )}

            {/* Step 1: Default Mode */}
            {step === 1 && (
              <motion.div
                key="mode"
                className="onb-slide"
                initial={{ opacity: 0, x: 30 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -30 }}
                transition={{ duration: 0.25, ease }}
              >
                <div className="onb-slide-title">Default Texture Mode</div>
                <div className="onb-slide-hint">Choose how textures are applied when you load a model.</div>
                <div className="onb-mode-grid">
                  {modeOptions.map((opt) => {
                    const Icon = opt.icon;
                    const isActive = draft.textureMode === opt.id;
                    return (
                      <motion.button
                        key={opt.id}
                        type="button"
                        className={`onb-mode-card ${isActive ? "is-active" : ""}`}
                        style={{ "--mode-color": opt.color }}
                        onClick={() => setDraft((p) => ({ ...p, textureMode: opt.id }))}
                        whileHover={{ y: -2 }}
                        whileTap={{ scale: 0.97 }}
                      >
                        <Icon className="onb-mode-icon" />
                        <span className="onb-mode-label">{opt.label}</span>
                        <span className="onb-mode-desc">{opt.desc}</span>
                        {isActive && (
                          <motion.div
                            className="onb-mode-check"
                            initial={{ scale: 0 }}
                            animate={{ scale: 1 }}
                            transition={{ type: "spring", stiffness: 500, damping: 25 }}
                          >
                            <Check className="w-3 h-3" />
                          </motion.div>
                        )}
                      </motion.button>
                    );
                  })}
                </div>

                <div className="onb-toggle-row">
                  <div className="onb-toggle-info">
                    <span className="onb-toggle-label">Exterior Only</span>
                    <span className="onb-toggle-hint">Hide interior, glass, and wheel meshes in livery mode</span>
                  </div>
                  <button
                    type="button"
                    className={`onb-switch ${draft.liveryExteriorOnly ? "is-on" : ""}`}
                    onClick={() => setDraft((p) => ({ ...p, liveryExteriorOnly: !p.liveryExteriorOnly }))}
                  >
                    <motion.div
                      className="onb-switch-thumb"
                      animate={{ x: draft.liveryExteriorOnly ? 16 : 0 }}
                      transition={{ type: "spring", stiffness: 500, damping: 30 }}
                    />
                  </button>
                </div>

                <div className="onb-toggle-row">
                  <div className="onb-toggle-info">
                    <span className="onb-toggle-label">Show Hints</span>
                    <span className="onb-toggle-hint">Display mouse control hints in the viewer</span>
                  </div>
                  <button
                    type="button"
                    className={`onb-switch ${draft.showHints ? "is-on" : ""}`}
                    onClick={() => setDraft((p) => ({ ...p, showHints: !p.showHints }))}
                  >
                    <motion.div
                      className="onb-switch-thumb"
                      animate={{ x: draft.showHints ? 16 : 0 }}
                      transition={{ type: "spring", stiffness: 500, damping: 30 }}
                    />
                  </button>
                </div>
              </motion.div>
            )}

            {/* Step 2: Appearance */}
            {step === 2 && (
              <motion.div
                key="appearance"
                className="onb-slide"
                initial={{ opacity: 0, x: 30 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -30 }}
                transition={{ duration: 0.25, ease }}
              >
                <div className="onb-slide-title">Appearance</div>
                <div className="onb-slide-hint">Set your preferred viewer colors and lighting.</div>

                <ColorPickerRow
                  label="Body Color"
                  value={draft.bodyColor}
                  onChange={(v) => setDraft((p) => ({ ...p, bodyColor: v }))}
                />
                <ColorPickerRow
                  label="Background"
                  value={draft.backgroundColor}
                  onChange={(v) => setDraft((p) => ({ ...p, backgroundColor: v }))}
                />

                <div className="onb-slider-row">
                  <div className="onb-slider-head">
                    <span className="onb-toggle-label">Light Intensity</span>
                    <span className="onb-slider-value">{draft.lightIntensity.toFixed(1)}</span>
                  </div>
                  <input
                    type="range"
                    min="0.5"
                    max="2.0"
                    step="0.1"
                    value={draft.lightIntensity}
                    onChange={(e) => setDraft((p) => ({ ...p, lightIntensity: parseFloat(e.target.value) }))}
                    className="onb-slider"
                  />
                </div>

                <div className="onb-slider-row">
                  <div className="onb-slider-head">
                    <span className="onb-toggle-label">Glossiness</span>
                    <span className="onb-slider-value">{Math.round(draft.glossiness * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={draft.glossiness}
                    onChange={(e) => setDraft((p) => ({ ...p, glossiness: parseFloat(e.target.value) }))}
                    className="onb-slider"
                  />
                </div>

                <div className="onb-toggle-row">
                  <div className="onb-toggle-info">
                    <span className="onb-toggle-label">Show Grid</span>
                    <span className="onb-toggle-hint">Display ground grid in the 3D viewer</span>
                  </div>
                  <button
                    type="button"
                    className={`onb-switch ${draft.showGrid ? "is-on" : ""}`}
                    onClick={() => setDraft((p) => ({ ...p, showGrid: !p.showGrid }))}
                  >
                    <motion.div
                      className="onb-switch-thumb"
                      animate={{ x: draft.showGrid ? 16 : 0 }}
                      transition={{ type: "spring", stiffness: 500, damping: 30 }}
                    />
                  </button>
                </div>
              </motion.div>
            )}

            {/* Step 3: Export */}
            {step === 3 && (
              <motion.div
                key="export"
                className="onb-slide"
                initial={{ opacity: 0, x: 30 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -30 }}
                transition={{ duration: 0.25, ease }}
              >
                <div className="onb-slide-title">Storage & Exports</div>
                <div className="onb-slide-hint">Configure default paths for your exports. You can change these later in Settings.</div>

                <div className="space-y-4 mt-6">
                  <div className="onb-export-folder">
                    <div className="text-[10px] uppercase tracking-widest text-white/40 mb-2 px-1">Preview Screenshots</div>
                    <button
                      type="button"
                      className="onb-export-folder-btn"
                      onClick={handleSelectPreviewFolder}
                    >
                      <FolderOpen className="w-5 h-5" style={{ opacity: 0.5 }} />
                      <div className="onb-export-folder-text">
                        <span className="onb-export-folder-label">
                          {draft.previewFolder
                            ? draft.previewFolder.split(/[\\/]/).pop()
                            : "Select preview folder"}
                        </span>
                        {draft.previewFolder && (
                          <span className="onb-export-folder-path">{draft.previewFolder}</span>
                        )}
                      </div>
                    </button>
                  </div>

                  <div className="onb-export-folder">
                    <div className="text-[10px] uppercase tracking-widest text-white/40 mb-2 px-1">Variant Builder Exports</div>
                    <button
                      type="button"
                      className="onb-export-folder-btn"
                      onClick={handleSelectVariantExportFolder}
                    >
                      <Palette className="w-5 h-5" style={{ opacity: 0.5 }} />
                      <div className="onb-export-folder-text">
                        <span className="onb-export-folder-label">
                          {draft.variantExportFolder
                            ? draft.variantExportFolder.split(/[\\/]/).pop()
                            : "Select variant export folder"}
                        </span>
                        {draft.variantExportFolder && (
                          <span className="onb-export-folder-path">{draft.variantExportFolder}</span>
                        )}
                      </div>
                    </button>
                  </div>
                </div>

                {!draft.previewFolder && !draft.variantExportFolder && (
                  <div className="onb-export-folder-skip">
                    You can skip this step — you'll be prompted when you first export.
                  </div>
                )}
              </motion.div>
            )}

            {/* Step 4: Ready */}
            {step === 4 && (
              <motion.div
                key="ready"
                className="onb-slide onb-slide--ready"
                initial={{ opacity: 0, x: 30 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -30 }}
                transition={{ duration: 0.25, ease }}
              >
                <motion.div
                  className="onb-ready-check"
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring", stiffness: 400, damping: 20, delay: 0.1 }}
                >
                  <Check className="w-6 h-6" />
                </motion.div>
                <div className="onb-slide-title">You're all set</div>
                <div className="onb-slide-hint">Your defaults have been configured. Start creating liveries.</div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Navigation */}
        <div className="onb-nav">
          {step > 0 ? (
            <button type="button" className="onb-nav-btn onb-nav-back" onClick={prev}>
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>Back</span>
            </button>
          ) : (
            <div />
          )}

          {step < STEPS.length - 1 ? (
            <button type="button" className="onb-nav-btn onb-nav-next" onClick={next}>
              <span>{step === 0 ? "Get Started" : "Next"}</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          ) : (
            <motion.button
              type="button"
              className="onb-nav-btn onb-nav-finish"
              onClick={finish}
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
            >
              <span>Start Building</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </motion.button>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
