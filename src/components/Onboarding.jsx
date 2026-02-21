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
} from "lucide-react";

const STEPS = [
  { id: "welcome", title: "Welcome" },
  { id: "workspace", title: "Workspace" },
  { id: "workflow", title: "Workflow" },
  { id: "ready", title: "Ready" },
];

const START_OPTIONS = [
  {
    id: "livery",
    label: "Livery",
    desc: "Vehicle textures and paint",
    icon: Car,
    color: "#00d9ff",
    shortcut: "Alt + 1",
  },
  {
    id: "everything",
    label: "All",
    desc: "Preview all meshes and materials",
    icon: Layers,
    color: "#3b82f6",
    shortcut: "Alt + 2",
  },
  {
    id: "eup",
    label: "EUP",
    desc: "Uniforms and clothing textures",
    icon: Shirt,
    color: "#f59e0b",
    shortcut: "Alt + 3",
  },
  {
    id: "multi",
    label: "Multi",
    desc: "Side-by-side model comparison",
    icon: Link2,
    color: "#ec4899",
    shortcut: "Alt + 4",
  },
  {
    id: "variants",
    label: "Variant Builder",
    desc: "PSD workflow and grouped exports",
    icon: Palette,
    color: "#a855f7",
    shortcut: "Alt + 5",
  },
];

const WORKFLOW_TIPS = [
  {
    id: "new-tab",
    title: "Use quick launch tabs",
    detail: "Use the + button in the toolbar to spin up mode-specific tabs instantly.",
    icon: Sparkles,
  },
  {
    id: "shortcuts",
    title: "Keyboard-first workflow",
    detail: "Default mode hotkeys are Alt+1 through Alt+5. Change them anytime in Shortcuts.",
    icon: Keyboard,
  },
  {
    id: "settings",
    title: "Tune behavior in Settings",
    detail: "UI scale, recents, viewer controls, and export paths all live in Settings.",
    icon: Monitor,
  },
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
  const [selectedStart, setSelectedStart] = useState("livery");
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

  const selectedMeta = useMemo(
    () => START_OPTIONS.find((opt) => opt.id === selectedStart) ?? START_OPTIONS[0],
    [selectedStart],
  );

  const launchSelected = useCallback(
    () => complete({ type: "launch", target: selectedStart }),
    [complete, selectedStart],
  );

  const openSettings = useCallback(
    (section) => complete({ type: "openSettings", section }),
    [complete],
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
        <div className="flex items-center justify-between gap-4">
          <StepIndicator current={step} total={STEPS.length} />
          <button
            type="button"
            className="text-[10px] uppercase tracking-[0.12em] text-white/60 hover:text-white transition-colors"
            onClick={() => complete({ type: "home" })}
          >
            Skip
          </button>
        </div>

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
                  This walkthrough is now workflow-first. Launch faster, then tune settings when needed.
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-6">
                  <div className="border border-white/10 bg-black/25 p-3">
                    <div className="flex items-center gap-2 text-[#00d9ff] text-[11px] uppercase tracking-[0.12em]">
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>Fast Start</span>
                    </div>
                    <p className="text-[12px] text-white/70 mt-2">
                      Pick a mode and open a working tab in one click.
                    </p>
                  </div>
                  <div className="border border-white/10 bg-black/25 p-3">
                    <div className="flex items-center gap-2 text-[#00ff9d] text-[11px] uppercase tracking-[0.12em]">
                      <Command className="w-3.5 h-3.5" />
                      <span>Hotkeys</span>
                    </div>
                    <p className="text-[12px] text-white/70 mt-2">
                      Use Alt+1..Alt+5 to create mode tabs immediately.
                    </p>
                  </div>
                  <div className="border border-white/10 bg-black/25 p-3">
                    <div className="flex items-center gap-2 text-[#ffd700] text-[11px] uppercase tracking-[0.12em]">
                      <Settings className="w-3.5 h-3.5" />
                      <span>Settings</span>
                    </div>
                    <p className="text-[12px] text-white/70 mt-2">
                      Tweak system, viewer, and export options after launch.
                    </p>
                  </div>
                </div>
              </motion.div>
            )}

            {/* Step 1: Workspace */}
            {step === 1 && (
              <motion.div
                key="workspace"
                className="onb-slide"
                initial={{ opacity: 0, x: 30 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -30 }}
                transition={{ duration: 0.25, ease }}
              >
                <div className="onb-slide-title">Pick Your First Workspace</div>
                <div className="onb-slide-hint">
                  Choose what you want to open first. You can open additional modes anytime.
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
                        whileHover={{ y: -2 }}
                        whileTap={{ scale: 0.97 }}
                      >
                        <Icon className="onb-mode-icon" />
                        <span className="onb-mode-label">{opt.label}</span>
                        <span className="onb-mode-desc">{opt.desc}</span>
                        <span className="text-[10px] text-white/40 mt-1">{opt.shortcut}</span>
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
              </motion.div>
            )}

            {/* Step 2: Workflow */}
            {step === 2 && (
              <motion.div
                key="workflow"
                className="onb-slide"
                initial={{ opacity: 0, x: 30 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -30 }}
                transition={{ duration: 0.25, ease }}
              >
                <div className="onb-slide-title">Workflow Essentials</div>
                <div className="onb-slide-hint">The core loop is quick launch, iterate, and export.</div>

                <div className="space-y-3 mt-4">
                  {WORKFLOW_TIPS.map((tip) => {
                    const Icon = tip.icon;
                    return (
                      <div key={tip.id} className="border border-white/10 bg-black/25 p-3">
                        <div className="flex items-center gap-2 text-[#00d9ff] text-[10px] uppercase tracking-[0.12em]">
                          <Icon className="w-3.5 h-3.5" />
                          <span>{tip.title}</span>
                        </div>
                        <p className="text-[12px] text-white/70 mt-1.5">{tip.detail}</p>
                      </div>
                    );
                  })}
                </div>

                <div className="flex flex-wrap gap-2 mt-5">
                  <button
                    type="button"
                    className="onb-nav-btn onb-nav-next"
                    onClick={() => openSettings("hotkeys")}
                  >
                    <Keyboard className="w-3.5 h-3.5" />
                    <span>Edit Shortcuts</span>
                  </button>
                  <button
                    type="button"
                    className="onb-nav-btn onb-nav-back"
                    onClick={() => openSettings("viewer")}
                  >
                    <Settings className="w-3.5 h-3.5" />
                    <span>Open Viewer Settings</span>
                  </button>
                </div>
              </motion.div>
            )}

            {/* Step 3: Ready */}
            {step === 3 && (
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
                <div className="onb-slide-hint">
                  Ready to launch <strong>{selectedMeta.label}</strong>. You can reopen this anytime from the toolbar info button.
                </div>

                <div className="grid grid-cols-1 gap-2 mt-6 w-full max-w-[440px]">
                  <button
                    type="button"
                    className="onb-nav-btn onb-nav-finish w-full justify-center"
                    onClick={launchSelected}
                  >
                    <selectedMeta.icon className="w-3.5 h-3.5" />
                    <span>Launch {selectedMeta.label}</span>
                  </button>
                  <button
                    type="button"
                    className="onb-nav-btn onb-nav-next w-full justify-center"
                    onClick={() => openSettings("general")}
                  >
                    <Settings className="w-3.5 h-3.5" />
                    <span>Open System Settings</span>
                  </button>
                  <button
                    type="button"
                    className="onb-nav-btn onb-nav-back w-full justify-center"
                    onClick={() => complete({ type: "home" })}
                  >
                    <span>Go To Home</span>
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Navigation */}
        {step < STEPS.length - 1 ? (
          <div className="onb-nav">
            {step > 0 ? (
              <button type="button" className="onb-nav-btn onb-nav-back" onClick={prev}>
                <ChevronLeft className="w-3.5 h-3.5" />
                <span>Back</span>
              </button>
            ) : (
              <div />
            )}

            <button type="button" className="onb-nav-btn onb-nav-next" onClick={next}>
              <span>{step === 0 ? "Get Started" : "Next"}</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <div className="onb-nav">
            <button type="button" className="onb-nav-btn onb-nav-back" onClick={prev}>
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>Back</span>
            </button>
            <button
              type="button"
              className="onb-nav-btn onb-nav-next"
              onClick={() => complete({ type: "home" })}
            >
              <span>Finish</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
