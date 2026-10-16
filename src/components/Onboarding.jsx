import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Check, Home, Minus, Square, X } from "lucide-react";
import { emitPrefsUpdated, loadPrefs, savePrefs } from "../lib/prefs";
import { DEFAULT_HOTKEYS, mergeHotkeys } from "../lib/hotkeys";
import {
  COLOR_SCHEMES,
  THEME_PRESETS,
  normalizeColorScheme,
  normalizeThemePreset,
  resolveColorScheme,
} from "../lib/theme";
import { WORKSPACE_MODES, WORKSPACE_MODE_GROUPS } from "../lib/workspace-modes";
import { Keycaps } from "./ui/keycaps";
import { Toggle } from "./ui/toggle";
import appMeta from "../../package.json";
import cortexLogo from "../../src-tauri/icons/128x128@2x.png";
import "./Onboarding.css";

const HOME_ID = "home";
const SCHEME_LABELS = { system: "System", light: "Light", dark: "Dark" };
const MIN_SCALE = 0.5;
const MAX_SCALE = 1.4;
const ENTER_KEY = { key: "Enter", ctrl: false, alt: false, shift: false };
const ESCAPE_KEY = { key: "Esc", ctrl: false, alt: false, shift: false };
const SCALE_COMMIT_KEYS = new Set(["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Home", "PageDown", "PageUp"]);

function isTauriRuntime() {
  return typeof window !== "undefined" && typeof window.__TAURI_INTERNALS__?.invoke === "function";
}

function readDefaults() {
  const defaults = loadPrefs()?.defaults;
  return defaults && typeof defaults === "object" ? defaults : {};
}

function readLook() {
  const defaults = readDefaults();
  const scale = Number(defaults.uiScale);
  return {
    colorScheme: normalizeColorScheme(defaults.colorScheme, defaults.darkMode ?? true),
    themePreset: normalizeThemePreset(defaults.themePreset),
    uiScale: Number.isFinite(scale) ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale)) : 1,
    showKeycaps: defaults.showKeycaps !== false,
  };
}

// Choices apply as they are made: Shell re-reads prefs on this event and
// restyles the whole app, so the user sees the look they picked.
function saveDefaults(patch) {
  const stored = loadPrefs() ?? {};
  const defaults = stored.defaults && typeof stored.defaults === "object" ? stored.defaults : {};
  savePrefs({ ...stored, defaults: { ...defaults, ...patch } });
  emitPrefsUpdated();
}

function readHotkeys() {
  const stored = loadPrefs()?.hotkeys;
  return mergeHotkeys(stored && typeof stored === "object" ? stored : {}, DEFAULT_HOTKEYS);
}

function buildStartOptions(hotkeys) {
  const home = {
    id: HOME_ID,
    label: "Home",
    desc: "Recent projects and every workspace",
    icon: Home,
    cat: "all",
    group: null,
    hotkey: null,
  };
  return [home, ...WORKSPACE_MODES.map((mode) => ({ ...mode, hotkey: hotkeys[mode.action] }))];
}

function WindowControls() {
  if (!isTauriRuntime()) return null;
  const win = () => getCurrentWindow();
  return (
    <div className="shell-window-controls onb-window-controls">
      <button type="button" className="shell-wc-btn shell-wc-min" onClick={() => win().minimize()} aria-label="Minimize">
        <Minus className="shell-wc-icon" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="shell-wc-btn shell-wc-max"
        onClick={async () => ((await win().isMaximized()) ? win().unmaximize() : win().maximize())}
        aria-label="Maximize"
      >
        <Square className="shell-wc-icon" aria-hidden="true" />
      </button>
      <button type="button" className="shell-wc-btn shell-wc-close" onClick={() => win().close()} aria-label="Close">
        <X className="shell-wc-icon" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * First-run setup: pick the look and where to start. Everything applies
 * immediately and can be changed later in Settings or on Home. Completes with
 * `{ type: "home" }` or `{ type: "launch", target }`.
 */
export default function Onboarding({ onComplete }) {
  const reduceMotion = useReducedMotion();
  const [look, setLook] = useState(readLook);
  const [selected, setSelected] = useState(HOME_ID);
  const options = useMemo(() => buildStartOptions(readHotkeys()), []);
  const rootRef = useRef(null);
  const titleRef = useRef(null);
  const optionRefs = useRef(new Map());
  const committedScaleRef = useRef(look.uiScale);

  const selectedOption = options.find((option) => option.id === selected) || options[0];
  const resolvedScheme = resolveColorScheme(look.colorScheme);

  const complete = useCallback((action) => onComplete?.(action), [onComplete]);
  const launch = useCallback(() => {
    if (selected === HOME_ID) complete({ type: "home" });
    else complete({ type: "launch", target: selected });
  }, [complete, selected]);
  const skip = useCallback(() => complete({ type: "home" }), [complete]);

  const updateLook = useCallback((patch) => {
    setLook((current) => ({ ...current, ...patch }));
    saveDefaults(patch);
  }, []);

  const commitScale = useCallback((value) => {
    const next = Number.parseFloat(value);
    if (!Number.isFinite(next) || Object.is(next, committedScaleRef.current)) return;
    committedScaleRef.current = next;
    saveDefaults({ uiScale: next });
  }, []);

  const moveSelection = useCallback((event, index) => {
    const last = options.length - 1;
    const next = {
      ArrowDown: Math.min(last, index + 1),
      ArrowUp: Math.max(0, index - 1),
      Home: 0,
      End: last,
    }[event.key];
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (options[index].id === selected) launch();
      else setSelected(options[index].id);
      return;
    }
    if (next === undefined) return;
    event.preventDefault();
    setSelected(options[next].id);
    optionRefs.current.get(options[next].id)?.focus();
  }, [launch, options, selected]);

  // Focus moves in on open and returns on close; it is set once, so changing
  // the selection never pulls focus back to the title.
  useEffect(() => {
    const previousFocus = document.activeElement;
    titleRef.current?.focus({ preventScroll: true });
    return () => {
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);

  const actionsRef = useRef({ launch, skip });
  actionsRef.current = { launch, skip };

  // Escape skips, Enter starts, and Tab stays inside the dialog.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        actionsRef.current.skip();
        return;
      }
      if (event.key === "Enter" && !event.target.closest?.("button, input, [role='radio']")) {
        event.preventDefault();
        actionsRef.current.launch();
        return;
      }
      if (event.key !== "Tab" || !rootRef.current) return;
      const focusable = [...rootRef.current.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex="0"]')];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === titleRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const renderOption = (option) => {
    const index = options.indexOf(option);
    const isSelected = option.id === selected;
    const Icon = option.icon;
    return (
      <button
        key={option.id}
        ref={(node) => {
          if (node) optionRefs.current.set(option.id, node);
          else optionRefs.current.delete(option.id);
        }}
        type="button"
        role="radio"
        aria-checked={isSelected}
        tabIndex={isSelected ? 0 : -1}
        className={`onb-option ${isSelected ? "is-selected" : ""}`}
        data-cat={option.cat}
        onClick={() => setSelected(option.id)}
        onDoubleClick={() => (option.id === HOME_ID ? skip() : complete({ type: "launch", target: option.id }))}
        onKeyDown={(event) => moveSelection(event, index)}
      >
        <Icon className="onb-option-icon" aria-hidden="true" />
        <span className="onb-option-copy">
          <span className="onb-option-label">{option.label}</span>
          <span className="onb-option-desc">{option.desc}</span>
        </span>
        <Keycaps hotkey={option.hotkey} />
      </button>
    );
  };

  return (
    <motion.div
      ref={rootRef}
      className="onb"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onb-title"
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.2, 0.8, 0.2, 1] }}
    >
      <div className="onb-frame" data-tauri-drag-region="">
        <WindowControls />
      </div>

      <div className="onb-stage">
        <section className="onb-sheet">
          <header className="onb-head">
            <div className="onb-brand">
              <img src={cortexLogo} alt="" className="onb-brand-mark" draggable={false} />
              <span className="cx-display onb-brand-name">Cortex Studio</span>
              <span className="onb-brand-version">{appMeta.version}</span>
            </div>
            <h1 id="onb-title" ref={titleRef} tabIndex={-1} className="cx-display onb-title">
              Get started
            </h1>
            <p className="onb-head-desc">Pick a look and where to begin. Both stay in reach: the look in Settings, every workspace on Home.</p>
          </header>

          <div className="onb-body custom-scrollbar">
            <div className="onb-columns">
              <section className="onb-start" aria-labelledby="onb-start-label">
                <h2 id="onb-start-label" className="cx-label">Start in</h2>
                <div className="onb-options" role="radiogroup" aria-labelledby="onb-start-label">
                  {renderOption(options[0])}
                  {WORKSPACE_MODE_GROUPS.map((group) => (
                    <div key={group.id} className="onb-group" role="presentation">
                      <span className="cx-label onb-group-label" aria-hidden="true">{group.label}</span>
                      {options.filter((option) => option.group === group.id).map(renderOption)}
                    </div>
                  ))}
                </div>
              </section>

              <section className="onb-look" aria-labelledby="onb-look-label">
                <h2 id="onb-look-label" className="cx-label">Appearance</h2>

                <div className="onb-field">
                  <span className="onb-field-label" id="onb-scheme-label">Mode</span>
                  <div className="onb-seg" role="radiogroup" aria-labelledby="onb-scheme-label">
                    {COLOR_SCHEMES.map((scheme) => (
                      <button
                        key={scheme}
                        type="button"
                        role="radio"
                        aria-checked={look.colorScheme === scheme}
                        className={`onb-seg-btn ${look.colorScheme === scheme ? "is-on" : ""}`}
                        onClick={() => updateLook({ colorScheme: scheme })}
                      >
                        {SCHEME_LABELS[scheme]}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="onb-field">
                  <span className="onb-field-label" id="onb-theme-label">Theme</span>
                  <div className="onb-themes" role="radiogroup" aria-labelledby="onb-theme-label">
                    {THEME_PRESETS.map((preset) => {
                      const colors = preset.modes[resolvedScheme] || preset.modes.dark;
                      const isOn = look.themePreset === preset.id;
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          role="radio"
                          aria-checked={isOn}
                          className={`onb-theme ${isOn ? "is-on" : ""}`}
                          onClick={() => updateLook({ themePreset: preset.id })}
                          title={preset.description}
                        >
                          <span
                            className="onb-theme-swatch"
                            style={{ "--sw-bg": colors.background, "--sw-surface": colors.surface, "--sw-ink": colors.foreground, "--sw-accent": colors.primary }}
                            aria-hidden="true"
                          >
                            <span />
                          </span>
                          <span className="onb-theme-name">{preset.name}</span>
                          {isOn ? <Check className="onb-theme-check" aria-hidden="true" /> : null}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="onb-field">
                  <label className="onb-field-label onb-scale-head" htmlFor="onb-scale">
                    <span>Interface size</span>
                    <output htmlFor="onb-scale">{Math.round(look.uiScale * 100)}%</output>
                  </label>
                  <input
                    id="onb-scale"
                    className="onb-slider"
                    type="range"
                    min={MIN_SCALE}
                    max={MAX_SCALE}
                    step="0.05"
                    value={look.uiScale}
                    style={{ "--fill": `${((look.uiScale - MIN_SCALE) / (MAX_SCALE - MIN_SCALE)) * 100}%` }}
                    aria-valuetext={`${Math.round(look.uiScale * 100)} percent`}
                    onChange={(event) => setLook((current) => ({ ...current, uiScale: Number.parseFloat(event.currentTarget.value) }))}
                    onPointerUp={(event) => commitScale(event.currentTarget.value)}
                    onKeyUp={(event) => SCALE_COMMIT_KEYS.has(event.key) && commitScale(event.currentTarget.value)}
                    onBlur={(event) => commitScale(event.currentTarget.value)}
                  />
                </div>

                <div className="onb-toggle-row">
                  <span>
                    <span className="onb-field-label">Shortcut keycaps</span>
                    <span className="onb-toggle-hint">Show keyboard shortcuts beside actions</span>
                  </span>
                  <Toggle
                    checked={look.showKeycaps}
                    onChange={(value) => updateLook({ showKeycaps: value })}
                    ariaLabel="Show shortcut keycaps"
                  />
                </div>
              </section>
            </div>
          </div>

          <footer className="onb-foot">
            <span className="onb-foot-note">
              {selected === HOME_ID ? "Home lists every workspace and your recent projects." : `${selectedOption.label} opens in a new tab.`}
            </span>
            <button type="button" className="cx-btn is-quiet onb-skip" onClick={skip}>
              Skip
              <Keycaps hotkey={ESCAPE_KEY} />
            </button>
            <button type="button" className="cx-btn is-primary onb-go" onClick={launch}>
              {selected === HOME_ID ? "Go to Home" : `Open ${selectedOption.label}`}
              <Keycaps hotkey={ENTER_KEY} />
            </button>
          </footer>
        </section>
      </div>
    </motion.div>
  );
}
