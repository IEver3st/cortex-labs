import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Car,
  Layers,
  Shirt,
  Link2,
  Palette,
  Monitor,
  Keyboard,
  Settings,
  Sparkles,
  ChevronRight,
  ChevronLeft,
  Check,
  Command,
  Eye,
  Grid3x3,
  Gamepad2,
  LayoutPanelLeft,
  SlidersHorizontal,
  Zap,
  Rocket,
  ArrowRight,
} from "lucide-react";
import { loadPrefs, savePrefs } from "../lib/prefs";

/* ─── Step definitions ────────────────────────────────────────────── */
const STEPS = [
  { id: "welcome", label: "Welcome" },
  { id: "workspace", label: "Mode" },
  { id: "preferences", label: "Setup" },
  { id: "ready", label: "Launch" },
];

const START_OPTIONS = [
  {
    id: "livery",
    label: "Livery",
    desc: "Vehicle textures, paint jobs, and livery editing with real-time preview",
    icon: Car,
    color: "var(--mg-primary)",
    shortcut: "Alt + 1",
  },
  {
    id: "everything",
    label: "All",
    desc: "Full mesh browser — preview every model, material, and texture in one view",
    icon: Layers,
    color: "#3b82f6",
    shortcut: "Alt + 2",
  },
  {
    id: "eup",
    label: "EUP",
    desc: "Emergency uniforms — clothing textures and EUP outfit editing",
    icon: Shirt,
    color: "#f59e0b",
    shortcut: "Alt + 3",
  },
  {
    id: "multi",
    label: "Multi",
    desc: "Dual viewport for side-by-side model comparison and diffing",
    icon: Link2,
    color: "#ec4899",
    shortcut: "Alt + 4",
  },
  {
    id: "variants",
    label: "Variants",
    desc: "PSD workflow — apply layer groups and export texture variants in bulk",
    icon: Palette,
    color: "#a855f7",
    shortcut: "Alt + 5",
  },
];

/* ─── Settings that can be configured during onboarding ───────────── */
function getInitialPrefs() {
  const prefs = loadPrefs();
  const d = prefs?.defaults ?? {};
  return {
    showGrid: d.showGrid ?? false,
    showHints: d.showHints ?? true,
    cameraWASD: d.cameraWASD ?? false,
    legacyLayersLayout: d.legacyLayersLayout ?? false,
    liveryExteriorOnly: d.liveryExteriorOnly ?? false,
    showRecents: d.showRecents ?? true,
    uiScale: d.uiScale ?? 1.0,
  };
}

function persistPref(key, value) {
  const prefs = loadPrefs() ?? {};
  const defaults = prefs.defaults ?? {};
  defaults[key] = value;
  savePrefs({ ...prefs, defaults });
}

/* ─── Reusable toggle row ─────────────────────────────────────────── */
function SettingToggle({ icon: Icon, label, hint, checked, onChange }) {
  return (
    <button
      type="button"
      className="onb-setting-row"
      onClick={() => onChange(!checked)}
    >
      <div className="onb-setting-icon">
        <Icon className="w-4 h-4" />
      </div>
      <div className="onb-setting-text">
        <span className="onb-setting-label">{label}</span>
        {hint && <span className="onb-setting-hint">{hint}</span>}
      </div>
      <div className={`onb-switch ${checked ? "is-on" : ""}`}>
        <motion.div
          className="onb-switch-thumb"
          animate={{ x: checked ? 16 : 0 }}
          transition={{ type: "spring", stiffness: 500, damping: 35 }}
        />
      </div>
    </button>
  );
}

/* ─── Step progress bar ───────────────────────────────────────────── */
function StepIndicator({ current, total }) {
  return (
    <div className="onb-steps">
      {Array.from({ length: total }, (_, i) => (
        <div key={i} className="onb-step-track">
          <motion.div
            className="onb-step-fill"
            initial={false}
            animate={{
              scaleX: i < current ? 1 : i === current ? 0.5 : 0,
            }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          />
        </div>
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
export default function Onboarding({ onComplete }) {
  const [step, setStep] = useState(0);
  const [selectedStart, setSelectedStart] = useState("livery");
  const [prefs, setPrefs] = useState(getInitialPrefs);
  const ease = useMemo(() => [0.22, 1, 0.36, 1], []);

  const next = useCallback(
    () => setStep((s) => Math.min(s + 1, STEPS.length - 1)),
    [],
  );
  const prev = useCallback(() => setStep((s) => Math.max(s - 1, 0)), []);

  const complete = useCallback(
    (payload = { type: "home" }) => onComplete?.(payload),
    [onComplete],
  );

  const togglePref = useCallback((key, value) => {
    setPrefs((p) => ({ ...p, [key]: value }));
    persistPref(key, value);
  }, []);

  const selectedMeta = useMemo(
    () => START_OPTIONS.find((opt) => opt.id === selectedStart) ?? START_OPTIONS[0],
    [selectedStart],
  );
  const SelectedStartIcon = selectedMeta.icon;

  const launchSelected = useCallback(
    () => complete({ type: "launch", target: selectedStart }),
    [complete, selectedStart],
  );

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        complete({ type: "home" });
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [complete]);

  /* ─── slide transition props ─── */
  const slideMotion = {
    initial: { opacity: 0, x: 40 },
    animate: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: -40 },
    transition: { duration: 0.28, ease },
  };

  return (
    <motion.div
      className="onb-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.35, ease }}
    >
      <motion.div
        className="onb-container"
        initial={{ opacity: 0, y: 20, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 12, scale: 0.97 }}
        transition={{ duration: 0.45, ease }}
      >
        {/* ─── Header bar ─── */}
        <div className="onb-header">
          <StepIndicator current={step} total={STEPS.length} />
          <button
            type="button"
            className="onb-skip-btn"
            onClick={() => complete({ type: "home" })}
          >
            Skip
            <ArrowRight className="w-3 h-3" />
          </button>
        </div>

        {/* ─── Body ─── */}
        <div className="onb-body">
          <AnimatePresence mode="wait" initial={false}>

            {/* ═══ Step 0: Welcome ═══ */}
            {step === 0 && (
              <motion.div key="welcome" className="onb-slide onb-slide--welcome" {...slideMotion}>
                <motion.div
                  className="onb-welcome-glow"
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.6, delay: 0.1, ease }}
                >
                  <Zap className="w-8 h-8 text-[var(--mg-primary)]" />
                </motion.div>

                <motion.div
                  className="onb-welcome-brand"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: 0.15, ease }}
                >
                  Cortex Studio
                </motion.div>

                <motion.div
                  className="onb-welcome-sub"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.4, delay: 0.25, ease }}
                >
                  A 3D livery previewer and texture workspace for FiveM modders.
                  This guide helps you pick a workspace, configure your preferences, and launch.
                </motion.div>

                <div className="onb-feature-grid">
                  {[
                    { icon: Sparkles, color: "var(--mg-primary)", title: "Quick Launch", body: "Pick a mode and open a working tab in one click. No file setup needed." },
                    { icon: Command, color: "#a78bfa", title: "Keyboard First", body: "Alt+1 through Alt+5 create mode tabs instantly from anywhere." },
                    { icon: SlidersHorizontal, color: "#f59e0b", title: "Your Preferences", body: "Configure viewer, UI scale, and layout settings right in this wizard." },
                  ].map((feat, i) => (
                    <motion.div
                      key={feat.title}
                      className="onb-feature-card"
                      initial={{ opacity: 0, y: 16 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.35, delay: 0.3 + i * 0.08, ease }}
                    >
                      <div className="onb-feature-icon" style={{ color: feat.color }}>
                        <feat.icon className="w-5 h-5" />
                      </div>
                      <div className="onb-feature-title">{feat.title}</div>
                      <div className="onb-feature-body">{feat.body}</div>
                    </motion.div>
                  ))}
                </div>
              </motion.div>
            )}

            {/* ═══ Step 1: Pick Workspace ═══ */}
            {step === 1 && (
              <motion.div key="workspace" className="onb-slide" {...slideMotion}>
                <div className="onb-section-header">
                  <div className="onb-section-badge">Step 2</div>
                  <div className="onb-slide-title">Choose Your Workspace</div>
                  <div className="onb-slide-hint">
                    Select the mode you want to open first. You can add more tabs anytime via the toolbar.
                  </div>
                </div>

                <div className="onb-mode-grid">
                  {START_OPTIONS.map((opt) => {
                    const Icon = opt.icon;
                    const isActive = selectedStart === opt.id;
                    return (
                      <motion.button
                        key={opt.id}
                        type="button"
                        className={`onb-mode-card ${isActive ? "is-active" : ""}`}
                        style={{ "--mode-color": opt.color }}
                        onClick={() => setSelectedStart(opt.id)}
                        whileHover={{ y: -3, transition: { duration: 0.15 } }}
                        whileTap={{ scale: 0.97 }}
                      >
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
                        <div className="onb-mode-icon-wrap">
                          <Icon className="onb-mode-icon" />
                        </div>
                        <span className="onb-mode-label">{opt.label}</span>
                        <span className="onb-mode-desc">{opt.desc}</span>
                        <span className="onb-mode-shortcut">{opt.shortcut}</span>
                      </motion.button>
                    );
                  })}
                </div>
              </motion.div>
            )}

            {/* ═══ Step 2: Preferences ═══ */}
            {step === 2 && (
              <motion.div key="preferences" className="onb-slide" {...slideMotion}>
                <div className="onb-section-header">
                  <div className="onb-section-badge">Step 3</div>
                  <div className="onb-slide-title">Configure Preferences</div>
                  <div className="onb-slide-hint">
                    Customize the experience. These can all be changed later in Settings.
                  </div>
                </div>

                <div className="onb-settings-grid">
                  {/* ── Viewer group ── */}
                  <div className="onb-settings-group">
                    <div className="onb-settings-group-title">
                      <Eye className="w-3.5 h-3.5" />
                      Viewer
                    </div>
                    <SettingToggle
                      icon={Grid3x3}
                      label="Show Grid"
                      hint="Display a ground-plane grid in the 3D viewport"
                      checked={prefs.showGrid}
                      onChange={(v) => togglePref("showGrid", v)}
                    />
                    <SettingToggle
                      icon={Gamepad2}
                      label="WASD Camera"
                      hint="FPS-style camera controls instead of orbit mode"
                      checked={prefs.cameraWASD}
                      onChange={(v) => togglePref("cameraWASD", v)}
                    />
                    <SettingToggle
                      icon={Car}
                      label="Exterior Only"
                      hint="Hide interior, glass, and wheel meshes in livery mode"
                      checked={prefs.liveryExteriorOnly}
                      onChange={(v) => togglePref("liveryExteriorOnly", v)}
                    />
                  </div>

                  {/* ── UI group ── */}
                  <div className="onb-settings-group">
                    <div className="onb-settings-group-title">
                      <Monitor className="w-3.5 h-3.5" />
                      Interface
                    </div>
                    <SettingToggle
                      icon={LayoutPanelLeft}
                      label="Legacy Layers Layout"
                      hint="Use the classic side-by-side variant builder panel"
                      checked={prefs.legacyLayersLayout}
                      onChange={(v) => togglePref("legacyLayersLayout", v)}
                    />
                    <SettingToggle
                      icon={Sparkles}
                      label="Show Hints"
                      hint="Display contextual help text in the interface"
                      checked={prefs.showHints}
                      onChange={(v) => togglePref("showHints", v)}
                    />
                    <SettingToggle
                      icon={Keyboard}
                      label="Show Recents"
                      hint="Show recently opened files on the home screen"
                      checked={prefs.showRecents}
                      onChange={(v) => togglePref("showRecents", v)}
                    />
                  </div>
                </div>

                {/* ── UI Scale slider ── */}
                <div className="onb-scale-row">
                  <div className="onb-scale-info">
                    <span className="onb-setting-label">UI Scale</span>
                    <span className="onb-scale-value">{(prefs.uiScale * 100).toFixed(0)}%</span>
                  </div>
                  <input
                    type="range"
                    min="0.5"
                    max="1.4"
                    step="0.05"
                    value={prefs.uiScale}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      togglePref("uiScale", v);
                    }}
                    className="onb-slider"
                  />
                </div>
              </motion.div>
            )}

            {/* ═══ Step 3: Ready ═══ */}
            {step === 3 && (
              <motion.div key="ready" className="onb-slide onb-slide--ready" {...slideMotion}>
                <motion.div
                  className="onb-ready-check"
                  initial={{ scale: 0, rotate: -20 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ type: "spring", stiffness: 400, damping: 18, delay: 0.1 }}
                >
                  <Rocket className="w-7 h-7" />
                </motion.div>

                <motion.div
                  className="onb-slide-title"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2, duration: 0.3, ease }}
                >
                  You're Ready
                </motion.div>
                <motion.div
                  className="onb-slide-hint"
                  style={{ textAlign: "center", maxWidth: 340 }}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.3, duration: 0.3, ease }}
                >
                  Your preferences are saved. Launch <strong style={{ color: "var(--mg-fg)" }}>{selectedMeta.label}</strong> to
                  start working, or head to the home screen.
                </motion.div>

                <div className="onb-ready-actions">
                  <motion.button
                    type="button"
                    className="onb-launch-btn"
                    onClick={launchSelected}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.35, duration: 0.3, ease }}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                  >
                    <SelectedStartIcon className="w-4 h-4" />
                    <span>Launch {selectedMeta.label}</span>
                    <ArrowRight className="w-4 h-4 ml-auto opacity-50" />
                  </motion.button>

                  <motion.button
                    type="button"
                    className="onb-nav-btn onb-nav-back onb-ready-secondary"
                    onClick={() => complete({ type: "home" })}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.45, duration: 0.3, ease }}
                  >
                    Go to Home Screen
                  </motion.button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* ─── Navigation footer ─── */}
        <div className="onb-nav">
          {step > 0 ? (
            <button type="button" className="onb-nav-btn onb-nav-back" onClick={prev}>
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>Back</span>
            </button>
          ) : (
            <div />
          )}

          {step < STEPS.length - 1 && (
            <button type="button" className="onb-nav-btn onb-nav-next" onClick={next}>
              <span>{step === 0 ? "Get Started" : "Next"}</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
