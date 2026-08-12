import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowRight,
  Car,
  Check,
  ChevronDown,
  Layers,
  Link2,
  Palette,
  RotateCcw,
  Shirt,
  Zap,
} from "lucide-react";
import { emitPrefsUpdated, loadPrefs, savePrefs } from "../lib/prefs";
import {
  DEFAULT_HOTKEYS,
  HOTKEY_ACTIONS,
  formatHotkey,
  mergeHotkeys,
} from "../lib/hotkeys";
import cortexLogo from "../../src-tauri/icons/cortex-logo.svg";

const RECOMMENDED_PREFS = {
  showGrid: false,
  showHints: true,
  legacyLayersLayout: false,
  liveryExteriorOnly: false,
  showRecents: true,
  uiScale: 1,
};

const UI_SCALE_KEYS = new Set([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
]);

const START_OPTIONS = [
  {
    id: "livery",
    label: "Livery",
    desc: "Vehicle textures, liveries, and surface inspection",
    actionLabel: "Open Livery",
    icon: Car,
    hotkeyAction: HOTKEY_ACTIONS.NEW_TAB_LIVERY,
  },
  {
    id: "everything",
    label: "All",
    desc: "Every mesh and texture in one general viewer",
    actionLabel: "Open All",
    icon: Layers,
    hotkeyAction: HOTKEY_ACTIONS.NEW_TAB_ALL,
  },
  {
    id: "eup",
    label: "EUP",
    desc: "Uniform, clothing, and character texture work",
    actionLabel: "Open EUP",
    icon: Shirt,
    hotkeyAction: HOTKEY_ACTIONS.NEW_TAB_EUP,
  },
  {
    id: "multi",
    label: "Multi",
    desc: "Side-by-side model and material comparison",
    actionLabel: "Open Multi",
    icon: Link2,
    hotkeyAction: HOTKEY_ACTIONS.NEW_TAB_MULTI,
  },
  {
    id: "variants",
    label: "Variant Builder",
    desc: "Layered PSD and PDN recipes with grouped exports",
    actionLabel: "Open Variant Builder",
    icon: Palette,
    hotkeyAction: HOTKEY_ACTIONS.NEW_TAB_VARIANTS,
  },
  {
    id: "templategen",
    label: "Template Generation",
    desc: "Generate layered PSD templates from supported YFT assets",
    actionLabel: "Open Template Generation",
    icon: Zap,
    hotkeyAction: HOTKEY_ACTIONS.NEW_TAB_TEMPLATE_GEN,
  },
];

function getInitialPrefs() {
  const storedDefaults = loadPrefs()?.defaults;
  const defaults =
    storedDefaults && typeof storedDefaults === "object" ? storedDefaults : {};
  return Object.fromEntries(
    Object.entries(RECOMMENDED_PREFS).map(([key, value]) => [key, defaults[key] ?? value]),
  );
}

function getWorkspaceOptions() {
  const prefs = loadPrefs();
  const stored = prefs?.hotkeys && typeof prefs.hotkeys === "object" ? prefs.hotkeys : {};
  const hotkeys = mergeHotkeys(stored, DEFAULT_HOTKEYS);

  return START_OPTIONS.map((option) => {
    const formatted = formatHotkey(hotkeys[option.hotkeyAction]);
    const shortcut = formatted === "Not set" ? null : formatted.replaceAll(" + ", "+");
    return { ...option, shortcut };
  });
}

function saveOnboardingPrefs(nextPrefs) {
  const stored = loadPrefs() ?? {};
  const defaults =
    stored.defaults && typeof stored.defaults === "object" ? stored.defaults : {};
  savePrefs({ ...stored, defaults: { ...defaults, ...nextPrefs } });
  emitPrefsUpdated();
}

function SettingToggle({ label, hint, checked, onChange }) {
  return (
    <button
      type="button"
      className="onb-setting-row"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
    >
      <span className="onb-setting-copy">
        <span className="onb-setting-label">{label}</span>
        <span className="onb-setting-hint">{hint}</span>
      </span>
      <span className={`onb-switch ${checked ? "is-on" : ""}`} aria-hidden="true">
        <span className="onb-switch-thumb" />
      </span>
    </button>
  );
}

export default function Onboarding({ onComplete }) {
  const [selectedStart, setSelectedStart] = useState(null);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [prefs, setPrefs] = useState(getInitialPrefs);
  const committedUiScaleRef = useRef(prefs.uiScale);
  const rootRef = useRef(null);
  const headingRef = useRef(null);
  const workspaceRefs = useRef([]);
  const reduceMotion = useReducedMotion();
  const workspaceOptions = useMemo(getWorkspaceOptions, []);

  const selectedMeta = useMemo(
    () => workspaceOptions.find((option) => option.id === selectedStart) ?? null,
    [selectedStart, workspaceOptions],
  );

  const isRecommended = useMemo(
    () =>
      Object.entries(RECOMMENDED_PREFS).every(([key, value]) => Object.is(prefs[key], value)),
    [prefs],
  );

  const complete = useCallback(
    (action = { type: "home" }) => onComplete?.(action),
    [onComplete],
  );

  const togglePref = useCallback((key, value) => {
    setPrefs((current) => ({ ...current, [key]: value }));
    saveOnboardingPrefs({ [key]: value });
  }, []);

  const updateUiScaleDraft = useCallback((value) => {
    setPrefs((current) => ({ ...current, uiScale: value }));
  }, []);

  const commitUiScale = useCallback((value) => {
    const nextValue = Number.parseFloat(value);
    if (!Number.isFinite(nextValue) || Object.is(nextValue, committedUiScaleRef.current)) {
      return;
    }

    committedUiScaleRef.current = nextValue;
    saveOnboardingPrefs({ uiScale: nextValue });
  }, []);

  const resetRecommended = useCallback(() => {
    const next = { ...RECOMMENDED_PREFS };
    committedUiScaleRef.current = next.uiScale;
    setPrefs(next);
    saveOnboardingPrefs(next);
  }, []);

  const launch = useCallback(() => {
    if (!selectedStart) {
      complete({ type: "home" });
      return;
    }
    complete({ type: "launch", target: selectedStart });
  }, [complete, selectedStart]);

  const handleWorkspaceKeyDown = useCallback(
    (event, index) => {
      const key = event.key;
      let nextIndex = index;
      if (key === "ArrowDown" || key === "ArrowRight") {
        nextIndex = (index + 1) % workspaceOptions.length;
      } else if (key === "ArrowUp" || key === "ArrowLeft") {
        nextIndex = (index - 1 + workspaceOptions.length) % workspaceOptions.length;
      } else if (key === "Home") {
        nextIndex = 0;
      } else if (key === "End") {
        nextIndex = workspaceOptions.length - 1;
      } else {
        return;
      }

      event.preventDefault();
      const option = workspaceOptions[nextIndex];
      setSelectedStart(option.id);
      workspaceRefs.current[nextIndex]?.focus();
    },
    [workspaceOptions],
  );

  useEffect(() => {
    const previousFocus = document.activeElement;
    headingRef.current?.focus({ preventScroll: true });
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        complete({ type: "home" });
        return;
      }
      if (event.key !== "Tab" || !rootRef.current) return;

      const focusable = Array.from(
        rootRef.current.querySelectorAll(
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute("aria-hidden"));
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === headingRef.current)
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, [complete]);

  return (
    <main
      ref={rootRef}
      className="onb-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onb-heading"
    >
      <div className="onb-container">
        <header className="onb-header">
          <div className="onb-brand-lockup">
            <img src={cortexLogo} alt="" className="onb-brand-logo" draggable={false} />
            <span className="onb-brand-name">Cortex Studio</span>
            <span className="onb-brand-divider" aria-hidden="true" />
            <span className="onb-brand-context">Getting started</span>
          </div>

          <button
            type="button"
            className="onb-skip-btn"
            onClick={() => complete({ type: "home" })}
          >
            Skip to Studio
            <ArrowRight aria-hidden="true" />
          </button>
        </header>

        <div className="onb-scroll">
          <section className="onb-content" aria-describedby="onb-supporting-copy">
            <div className="onb-intro">
              <div className="onb-eyebrow">First run</div>
              <h1 id="onb-heading" ref={headingRef} tabIndex={-1}>
                Choose where you want to start.
              </h1>
              <p id="onb-supporting-copy">
                You can access every workspace later from Studio Home.
              </p>
            </div>

            <div
              className="onb-workspace-list"
              role="radiogroup"
              aria-label="Starting destination"
            >
              {workspaceOptions.map((option, index) => {
                const Icon = option.icon;
                const isSelected = selectedStart === option.id;
                const isTabStop = selectedStart ? isSelected : index === 0;
                return (
                  <button
                    key={option.id}
                    ref={(node) => {
                      workspaceRefs.current[index] = node;
                    }}
                    type="button"
                    className={`onb-workspace-row ${isSelected ? "is-selected" : ""}`}
                    role="radio"
                    aria-checked={isSelected}
                    aria-keyshortcuts={option.shortcut ?? undefined}
                    tabIndex={isTabStop ? 0 : -1}
                    onClick={() => setSelectedStart(option.id)}
                    onKeyDown={(event) => handleWorkspaceKeyDown(event, index)}
                  >
                    <span className="onb-workspace-icon" aria-hidden="true">
                      <Icon />
                    </span>
                    <span className="onb-workspace-copy">
                      <span className="onb-workspace-label">{option.label}</span>
                      <span className="onb-workspace-desc">{option.desc}</span>
                    </span>
                    {option.shortcut ? (
                      <kbd className="onb-workspace-shortcut">{option.shortcut}</kbd>
                    ) : null}
                    <span className="onb-workspace-choice" aria-hidden="true">
                      {isSelected ? <Check /> : null}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="onb-preferences">
              <div className="onb-preferences-summary">
                <span>
                  {isRecommended
                    ? "Recommended Studio settings will be used."
                    : "Your saved Studio settings will be used."}
                </span>
                <button
                  type="button"
                  className="onb-customize-btn"
                  aria-expanded={customizeOpen}
                  aria-controls="onb-customize-panel"
                  onClick={() => setCustomizeOpen((open) => !open)}
                >
                  {customizeOpen ? "Close" : "Customize"}
                  <ChevronDown aria-hidden="true" />
                </button>
              </div>

              <AnimatePresence initial={false}>
                {customizeOpen ? (
                  <motion.section
                    id="onb-customize-panel"
                    className="onb-customize-panel"
                    aria-labelledby="onb-customize-heading"
                    initial={reduceMotion ? false : { opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: reduceMotion ? 0 : 0.16 }}
                  >
                    <div className="onb-customize-heading-row">
                      <div>
                        <span className="onb-panel-kicker">Optional</span>
                        <h2 id="onb-customize-heading">Customize your starting settings</h2>
                      </div>
                      <button
                        type="button"
                        className="onb-reset-btn"
                        onClick={resetRecommended}
                        disabled={isRecommended}
                      >
                        <RotateCcw aria-hidden="true" />
                        Reset to recommended
                      </button>
                    </div>

                    <div className="onb-customize-grid">
                      <section className="onb-settings-group" aria-labelledby="onb-viewport-settings">
                        <h3 id="onb-viewport-settings">Viewport</h3>
                        <SettingToggle
                          label="Show grid"
                          hint="Display the ground grid in viewers."
                          checked={prefs.showGrid}
                          onChange={(value) => togglePref("showGrid", value)}
                        />
                        <SettingToggle
                          label="Show hints"
                          hint="Keep contextual guidance visible."
                          checked={prefs.showHints}
                          onChange={(value) => togglePref("showHints", value)}
                        />
                        <SettingToggle
                          label="Exterior only"
                          hint="Focus Livery on exterior surfaces."
                          checked={prefs.liveryExteriorOnly}
                          onChange={(value) => togglePref("liveryExteriorOnly", value)}
                        />
                      </section>

                      <section className="onb-settings-group" aria-labelledby="onb-studio-settings">
                        <h3 id="onb-studio-settings">Studio</h3>
                        <SettingToggle
                          label="Show recent projects"
                          hint="Keep recent work available on Home."
                          checked={prefs.showRecents}
                          onChange={(value) => togglePref("showRecents", value)}
                        />
                        <SettingToggle
                          label="Legacy layers"
                          hint="Place layers below the viewer."
                          checked={prefs.legacyLayersLayout}
                          onChange={(value) => togglePref("legacyLayersLayout", value)}
                        />
                      </section>

                      <section className="onb-settings-group onb-settings-group--interface" aria-labelledby="onb-interface-settings">
                        <h3 id="onb-interface-settings">Interface</h3>
                        <div className="onb-scale-row">
                          <label htmlFor="onb-ui-scale">
                            <span>Interface scale</span>
                            <span>{Math.round(prefs.uiScale * 100)}%</span>
                          </label>
                          <input
                            id="onb-ui-scale"
                            type="range"
                            min="0.5"
                            max="1.4"
                            step="0.05"
                            value={prefs.uiScale}
                            aria-valuetext={`${Math.round(prefs.uiScale * 100)} percent`}
                            onChange={(event) =>
                              updateUiScaleDraft(Number.parseFloat(event.currentTarget.value))
                            }
                            onPointerUp={(event) => commitUiScale(event.currentTarget.value)}
                            onPointerCancel={(event) => commitUiScale(event.currentTarget.value)}
                            onKeyUp={(event) => {
                              if (UI_SCALE_KEYS.has(event.key)) {
                                commitUiScale(event.currentTarget.value);
                              }
                            }}
                            onBlur={(event) => commitUiScale(event.currentTarget.value)}
                            className="onb-slider"
                          />
                        </div>
                      </section>
                    </div>
                  </motion.section>
                ) : null}
              </AnimatePresence>
            </div>

            <div className="onb-launch-row">
              <span className="onb-launch-context">
                {selectedMeta
                  ? `${selectedMeta.label} will open in a new Studio tab.`
                  : "Start from Home to keep every workspace within reach."}
              </span>
              <button type="button" className="onb-launch-btn" onClick={launch}>
                {selectedMeta?.actionLabel ?? "Start from Home"}
                <ArrowRight aria-hidden="true" />
              </button>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
