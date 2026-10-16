import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  FlipHorizontal2,
  MapPin,
  Pause,
  Play,
  Plus,
  Redo2,
  StepBack,
  StepForward,
  Trash2,
  Undo2,
} from "lucide-react";
import { Toggle } from "../ui/toggle";
import { beatsPerSecond, evaluateSirens, normalizeLightSwitches } from "../../lib/emergency-lights.js";
import {
  LAMP_KEYS,
  LAMP_LABELS,
  MAX_SIRENS,
  SEQUENCER_PRESETS,
  SEQUENCER_STEPS,
  SIREN_LIGHT_PRESETS,
  SIREN_PALETTE,
  TRAFFIC_ADVISOR_MODES,
  applySirenPreset,
  cloneSirenLight,
  createSirenLight,
  invertSequencer,
  patternFromSequencer,
  presetLights,
  sequencerStep,
  setSequencerStep,
  shiftSequencer,
  toSequencer,
  trafficAdvisorSequencers,
  updateSirens,
  withSirens,
} from "../../lib/siren-settings.js";
import { compactNumbers } from "../../lib/change-summary.js";
import "./SirenEditor.css";

// The sequencer under the Sirens viewfinder: transport, a live strip of which
// sirens are lit, and one 32-step lane per siren. Every control edits the draft
// in useSirenEditor, and the draft is what the viewer's light rig runs, so the
// model shows each change as it is made. Saving lives in the workspace dock.

const SPEEDS = [[0.25, "¼×"], [0.5, "½×"], [1, "1×"]];

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

// The channel a pattern tool edits: flash, unless the siren only rotates.
function patternChannel(light) {
  return light.rotate && !light.flash ? "rotation" : "flashiness";
}

function isTextTarget(target) {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/* ─── Small controls ─── */

function Menu({ label, icon, disabled, title, children, ariaLabel, pressed, className }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState(null);
  const trigger = useRef(null);
  const panel = useRef(null);
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const height = panel.current?.offsetHeight || 0;
    const below = rect.bottom + 4 + height < window.innerHeight;
    setPlace({ left: Math.min(rect.left, window.innerWidth - 240), top: below ? rect.bottom + 4 : Math.max(8, rect.top - 4 - height) });
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (panel.current?.contains(event.target) || trigger.current?.contains(event.target)) return;
      setOpen(false);
    };
    const key = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", key);
    };
  }, [open]);
  useEffect(() => {
    if (open && place) panel.current?.querySelector("button:not(:disabled)")?.focus();
  }, [open, place]);
  return (
    <>
      <button ref={trigger} type="button" className={cx("cx-btn lv-btn-sm se-menu-trigger", className, pressed && "is-on")} disabled={disabled}
        title={title} aria-label={ariaLabel} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {icon}
        {label}
        <ChevronDown aria-hidden="true" />
      </button>
      {open ? createPortal(
        <div ref={panel} className="se-menu" role="menu" style={place ? { left: place.left, top: place.top } : { visibility: "hidden" }}
          onClick={(event) => { if (event.target.closest("button")) setOpen(false); }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            const items = [...panel.current.querySelectorAll("button:not(:disabled)")];
            const at = items.indexOf(document.activeElement);
            items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
          }}>
          {children}
        </div>,
        document.body,
      ) : null}
    </>
  );
}

function MenuItem({ children, hint, onSelect, disabled, checked }) {
  const radio = checked !== undefined;
  return (
    <button type="button" role={radio ? "menuitemradio" : "menuitem"} aria-checked={radio ? checked : undefined}
      className="se-menu-item" onClick={onSelect} disabled={disabled}>
      <span>{children}</span>
      {hint ? <span className="se-menu-hint">{hint}</span> : null}
      {checked ? <Check className="se-menu-check" aria-hidden="true" /> : null}
    </button>
  );
}

function IconButton({ label, onClick, disabled, children, pressed }) {
  return (
    <button type="button" className={cx("cx-icon-btn se-icon-btn", pressed && "is-on")} onClick={onClick} disabled={disabled}
      aria-label={label} title={label} aria-pressed={pressed}>
      {children}
    </button>
  );
}

/* ─── Track grid ─── */

function Lane({ sequencer, color, dim, kind, label, onPaint }) {
  const pattern = patternFromSequencer(sequencer);
  const begin = (event) => {
    const step = Number(event.target.dataset?.step);
    if (!Number.isInteger(step) || event.button !== 0) return;
    event.preventDefault();
    onPaint(step, pattern[step] !== "1", true);
  };
  const enter = (event) => {
    if (!(event.buttons & 1)) return;
    const step = Number(event.target.dataset?.step);
    if (Number.isInteger(step)) onPaint(step, null, false);
  };
  return (
    <div className={cx("se-lane", `is-${kind}`, dim && "is-dim")} role="group" aria-label={label}
      onPointerDown={begin} onPointerOver={enter}>
      {pattern.split("").map((bit, step) => (
        <span key={step} data-step={step} className={cx("se-cell", bit === "1" && "is-on", step % 4 === 0 && "is-beat")}
          style={bit === "1" ? { "--se-cell": color } : undefined} />
      ))}
    </div>
  );
}

function sirenTitle(light, index, hasMesh) {
  const parts = [`Siren ${index}`];
  parts.push(light.flash ? "flash" : light.rotate ? "rotate only" : "steady");
  if (light.rotate && light.flash) parts.push("rotate");
  if (light.scale) parts.push(`scale ×${light.scaleFactor ?? 1}`);
  if (!hasMesh) parts.push("no light on the model");
  return parts.join(" · ");
}

// What a siren does when it is not a plain flasher, shown in its row; plain
// flashers, the usual case, stay unlabelled.
function sirenKind(light) {
  if (light.flash && light.rotate) return "flash+rot";
  if (light.flash) return "";
  if (light.rotate) return "rotate";
  return "steady";
}

/* ─── Sequencer ─── */

export default function SirenEditor({ s }) {
  const editor = s.sirenEditor;
  const draft = editor.draft;
  const lights = s.vehicleLights || {};
  const switches = normalizeLightSwitches(lights.switches);
  const muted = useMemo(() => new Set(lights.muted || []), [lights.muted]);
  const speed = Number.isFinite(lights.speed) ? lights.speed : 1;
  const modelLights = s.metaModelInfo?.lights || null;
  const meshSirens = useMemo(() => new Set(modelLights?.sirens || []), [modelLights?.sirens]);
  const selection = editor.selection;
  const selected = useMemo(() => new Set(selection), [selection]);
  const primary = draft?.sirens[editor.primary] || null;
  const bps = beatsPerSecond(draft);
  const [seekTick, setSeekTick] = useState(0);
  const sheet = useRef(null);
  const clipboard = useRef(null);
  const stroke = useRef(null);
  const column = useRef(null);
  const ruler = useRef(null);
  const stepLabel = useRef(null);
  const strip = useRef(null);
  const grid = useRef(null);
  const [laneHeight, setLaneHeight] = useState(16);
  const resumeSpeed = useRef(speed > 0 ? speed : 1);
  const { edit, select } = editor;
  const notify = (message) => s.showToast?.(message);

  useEffect(() => {
    if (speed > 0) resumeSpeed.current = speed;
  }, [speed]);

  /* Playback. The step column, step number and live strip follow the light
     clock through refs, so playing does not re-render the grid. */
  const setLights = s.updateVehicleLights;
  const running = switches.sirens && speed > 0 && bps > 0;
  const togglePlay = useCallback(() => setLights({ speed: speed > 0 ? 0 : resumeSpeed.current }), [setLights, speed]);
  const seekStep = useCallback((step) => {
    if (!(bps > 0)) return;
    if (!switches.sirens) setLights({ switches: { ...switches, sirens: true } });
    s.setLightTime?.(((step % SEQUENCER_STEPS) + SEQUENCER_STEPS) % SEQUENCER_STEPS / bps);
    setSeekTick((value) => value + 1);
  }, [bps, s, setLights, switches]);
  const stepBy = useCallback((delta) => {
    const time = s.getLightTime?.();
    const beat = Number.isFinite(time) && bps > 0 ? Math.floor(time * bps + 1e-6) : 0;
    if (speed > 0) setLights({ speed: 0 });
    seekStep(beat + delta);
  }, [bps, s, seekStep, setLights, speed]);
  useEffect(() => {
    if (!draft) return undefined;
    // The playhead follows the ruler cell itself: beat gaps make the columns
    // uneven, so a 1/32 slice of the lane would drift off them.
    let placed = { step: -1, width: 0 };
    const placeColumn = (step, live) => {
      const band = column.current;
      const cells = ruler.current?.children;
      if (!band || !cells) return;
      band.hidden = !live;
      const width = band.parentElement?.clientWidth || 0;
      if (placed.step === (live ? step : -1) && placed.width === width) return;
      if (placed.step >= 0) cells[placed.step]?.classList.remove("is-now");
      placed = { step: live ? step : -1, width };
      if (!live) return;
      const cell = cells[step];
      if (!cell) return;
      cell.classList.add("is-now");
      const cellRect = cell.getBoundingClientRect();
      const trackRect = band.parentElement.getBoundingClientRect();
      band.style.transform = `translateX(${cellRect.left - trackRect.left - 2}px)`;
      band.style.width = `${cellRect.width + 4}px`;
    };
    const place = () => {
      const time = s.getLightTime?.();
      const live = switches.sirens && Number.isFinite(time) && bps > 0;
      const step = live ? Math.floor(time * bps + 1e-6) % SEQUENCER_STEPS : 0;
      placeColumn(step, live);
      if (stepLabel.current) stepLabel.current.textContent = live ? String(step + 1).padStart(2, "0") : "--";
      const cells = strip.current?.children;
      if (!cells) return;
      const states = live ? evaluateSirens(draft, time) : [];
      for (let index = 0; index < cells.length; index += 1) {
        const state = states[index];
        const on = Boolean(state?.on) && !muted.has(index + 1);
        cells[index].style.background = on ? state.color : "";
        cells[index].classList.toggle("is-on", on);
      }
    };
    place();
    // A resized sheet moves the columns; place the playhead again.
    const resize = new ResizeObserver(() => {
      placed = { ...placed, width: -1 };
      place();
    });
    if (ruler.current) resize.observe(ruler.current);
    const cleanup = () => {
      resize.disconnect();
      if (placed.step >= 0) ruler.current?.children[placed.step]?.classList.remove("is-now");
    };
    if (!running) return cleanup;
    let frame = requestAnimationFrame(function tick() {
      place();
      frame = requestAnimationFrame(tick);
    });
    return () => {
      cancelAnimationFrame(frame);
      cleanup();
    };
  }, [draft, bps, running, muted, switches.sirens, s, seekTick]);

  /* Draft operations. */
  const count = draft?.sirens.length || 0;
  const sortedSelection = useMemo(() => [...selection].sort((a, b) => a - b), [selection]);
  const append = useCallback((newLights) => {
    if (!newLights.length) return;
    edit((current) => withSirens(current, [...current.sirens, ...newLights]));
    const added = newLights.slice(0, Math.max(0, MAX_SIRENS - count)).map((_, offset) => count + offset);
    if (added.length) select(added, added[added.length - 1]);
  }, [count, edit, select]);
  const addSiren = () => {
    const last = draft.sirens[count - 1];
    const light = last ? cloneSirenLight(last) : createSirenLight();
    if (last) {
      light.color = last.color === "#ff0000" ? "#0000ff" : "#ff0000";
      light.flashiness.sequencer = invertSequencer(last.flashiness.sequencer);
    }
    append([light]);
  };
  const duplicate = () => append(sortedSelection.map((index) => cloneSirenLight(draft.sirens[index])));
  const remove = () => {
    if (!selection.length) return;
    edit((current) => withSirens(current, current.sirens.filter((_, index) => !selected.has(index))));
    const next = Math.min(sortedSelection[0], count - selection.length - 1);
    select(next >= 0 ? [next] : [], Math.max(0, next));
  };
  const move = (direction) => {
    const order = direction < 0 ? sortedSelection : [...sortedSelection].reverse();
    if (!order.length) return;
    if (direction < 0 ? order[0] === 0 : order[0] === count - 1) return;
    edit((current) => {
      const sirens = [...current.sirens];
      for (const index of order) {
        const target = index + direction;
        [sirens[index], sirens[target]] = [sirens[target], sirens[index]];
      }
      return withSirens(current, sirens);
    });
    select(selection.map((index) => index + direction), editor.primary + direction);
  };
  const patternEdit = (recipe, key) => edit((current) => updateSirens(current, selection, (light) => {
    const channel = patternChannel(light);
    light[channel].sequencer = recipe(toSequencer(light[channel].sequencer), light);
  }), key);
  // With sirens selected a preset restyles them in place; otherwise it adds
  // its lights after the last siren.
  const applyLightPreset = (presetId) => {
    if (selection.length) edit((current) => applySirenPreset(current, selection, presetId));
    else append(presetLights(presetId));
  };
  const applyPreset = (preset, alternate) => {
    const order = new Map(sortedSelection.map((index, rank) => [index, rank]));
    edit((current) => updateSirens(current, selection, (light, index) => {
      const channel = patternChannel(light);
      light[channel].sequencer = alternate && order.get(index) % 2 ? preset.b : preset.a;
    }));
  };
  // Traffic advisor: the selected sirens, lowest number first, as one row of heads.
  const applyTrafficAdvisor = (mode) => {
    const sequencers = trafficAdvisorSequencers(sortedSelection.length, mode);
    const rank = new Map(sortedSelection.map((index, order) => [index, order]));
    edit((current) => updateSirens(current, selection, (light, index) => {
      light[patternChannel(light)].sequencer = sequencers[rank.get(index)];
    }));
  };
  const setColor = (color) => edit((current) => updateSirens(current, selection, (light) => {
    light.color = color;
  }), `field:color:${selection.join(",")}`);
  const copyPattern = () => {
    if (!primary) return;
    clipboard.current = toSequencer(primary[patternChannel(primary)].sequencer);
    notify(`Copied siren ${editor.primary + 1}'s pattern`);
  };
  const pastePattern = () => {
    if (clipboard.current == null) return;
    const value = clipboard.current;
    patternEdit(() => value);
  };
  const toggleMute = (index) => {
    const next = new Set(muted);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    setLights({ muted: [...next].sort((a, b) => a - b) });
  };
  const soloed = count > 0 && selection.length > 0 && muted.size === count - selection.length
    && sortedSelection.every((index) => !muted.has(index + 1));
  const toggleSolo = () => {
    if (soloed) setLights({ muted: [] });
    else setLights({ muted: Array.from({ length: count }, (_, index) => index + 1).filter((index) => !selected.has(index - 1)) });
  };

  const paintSiren = (index, channel) => (step, value, start) => {
    if (start) {
      stroke.current = { value, key: `paint:${Date.now()}` };
      if (!selected.has(index)) select([index], index);
    }
    if (!stroke.current) return;
    const { value: on, key } = stroke.current;
    edit((current) => {
      const light = current.sirens[index];
      if (!light || sequencerStep(light[channel].sequencer, step) === on) return current;
      return updateSirens(current, [index], (next) => {
        next[channel].sequencer = setSequencerStep(next[channel].sequencer, step, on);
      });
    }, key);
  };
  const paintLamp = (lampKey) => (step, value, start) => {
    if (start) stroke.current = { value, key: `paint:${Date.now()}` };
    if (!stroke.current) return;
    const { value: on, key } = stroke.current;
    edit((current) => {
      const lamp = current.lamps?.[lampKey] || { sequencer: 0, multiples: 1 };
      if (sequencerStep(lamp.sequencer, step) === on) return current;
      return { ...current, lamps: { ...current.lamps, [lampKey]: { ...lamp, sequencer: setSequencerStep(lamp.sequencer, step, on) } } };
    }, key);
  };
  useEffect(() => {
    const end = () => { stroke.current = null; };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, []);

  const clickRow = (event, index) => {
    if (event.shiftKey && selection.length) {
      const anchor = editor.primary;
      const [from, to] = anchor < index ? [anchor, index] : [index, anchor];
      select(Array.from({ length: to - from + 1 }, (_, offset) => from + offset), index);
    } else if (event.ctrlKey || event.metaKey) {
      select(selected.has(index) ? selection.filter((entry) => entry !== index) : [...selection, index], index);
    } else select([index], index);
  };

  /* Keyboard. */
  const onKeyDown = (event) => {
    if (isTextTarget(event.target) || event.defaultPrevented) return;
    const ctrl = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    let handled = true;
    if (ctrl && key === "z" && !event.shiftKey) editor.undo();
    else if (ctrl && (key === "y" || (key === "z" && event.shiftKey))) editor.redo();
    else if (ctrl && key === "a") select(Array.from({ length: count }, (_, index) => index), editor.primary);
    else if (ctrl && key === "d") duplicate();
    else if (ctrl && key === "c") copyPattern();
    else if (ctrl && key === "v") pastePattern();
    else if (!ctrl && (key === "delete" || key === "backspace")) remove();
    // Space still presses a focused button or switch.
    else if (!ctrl && key === " " && !(event.target instanceof Element && event.target.closest("button"))) togglePlay();
    else if (!ctrl && key === "[") patternEdit((value) => shiftSequencer(value, -1));
    else if (!ctrl && key === "]") patternEdit((value) => shiftSequencer(value, 1));
    else if (!ctrl && key === "i") patternEdit(invertSequencer);
    else if (event.altKey && key === "arrowup") move(-1);
    else if (event.altKey && key === "arrowdown") move(1);
    else if (!ctrl && (key === "arrowup" || key === "arrowdown") && count) {
      const next = Math.max(0, Math.min(count - 1, editor.primary + (key === "arrowup" ? -1 : 1)));
      if (event.shiftKey) select(selected.has(next) ? selection : [...selection, next], next);
      else select([next], next);
    } else if (!ctrl && key === "arrowleft") stepBy(-1);
    else if (!ctrl && key === "arrowright") stepBy(1);
    else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  // Siren lanes share the column's free height: taller when there are few
  // sirens or a tall window, never under 16 px (the grid scrolls) or over 30.
  const rotating = draft ? draft.sirens.filter((light) => light.rotate).length : 0;
  useLayoutEffect(() => {
    const node = grid.current;
    if (!node || !count) return undefined;
    const measure = () => {
      const fixed = [".se-ruler", ".se-lamps"].reduce((sum, selector) => sum + (node.querySelector(selector)?.offsetHeight || 0), 0);
      // 12 px grid padding; each rotation sub-lane is 15 px with its gap.
      const free = node.clientHeight - fixed - 12 - 16 - rotating * 15;
      // A siren row is its lane plus 2 px of head and 2 px of gap.
      const next = Math.max(16, Math.min(30, Math.floor(free / count) - 4));
      setLaneHeight((current) => (current === next ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [count, rotating]);

  if (!draft) return null;

  return (
    <section ref={sheet} className="se-sheet" style={{ "--se-lane": `${laneHeight}px` }} aria-label="Siren sequencer" tabIndex={-1} onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        // Grid cells are not focusable; keep the sequencer's shortcuts live after painting.
        if (!(event.target instanceof Element) || event.target.closest("button, input, select, textarea, [tabindex]:not(.se-sheet)")) return;
        if (!sheet.current.contains(document.activeElement)) sheet.current.focus({ preventScroll: true });
      }}>
      <header className="se-bar">
        <div className="se-transport" role="group" aria-label="Playback">
          <IconButton label="Previous step (Left arrow)" onClick={() => stepBy(-1)} disabled={!(bps > 0)}><StepBack aria-hidden="true" /></IconButton>
          <IconButton label={speed > 0 ? "Pause (Space)" : "Play (Space)"} onClick={togglePlay}>
            {speed > 0 ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          </IconButton>
          <IconButton label="Next step (Right arrow)" onClick={() => stepBy(1)} disabled={!(bps > 0)}><StepForward aria-hidden="true" /></IconButton>
        </div>
        <div className="se-counter" aria-label="Current step">
          <span ref={stepLabel} className="cx-display se-counter-step">--</span>
          <span className="se-counter-total">/ {SEQUENCER_STEPS}</span>
        </div>
        <div ref={strip} className="se-strip" role="img" aria-label="Sirens lit at the current step"
          title="Which sirens are lit at the current step">
          {draft.sirens.map((light, offset) => (
            <span key={offset} className={cx("se-strip-cell", selected.has(offset) && "is-selected")} />
          ))}
        </div>
        <div className="lv-seg se-seg" role="radiogroup" aria-label="Playback speed">
          {SPEEDS.map(([value, text]) => (
            <button key={value} type="button" role="radio" aria-checked={speed === value}
              className={cx("lv-seg-btn", speed === value && "is-on")} onClick={() => setLights({ speed: value })}>{text}</button>
          ))}
        </div>
        <div className="se-switches">
          <label className="se-switch">
            <span>Sirens</span>
            <Toggle checked={switches.sirens} onChange={(value) => setLights({ switches: { ...switches, sirens: value } })} ariaLabel="Sirens" />
          </label>
          <label className="se-switch">
            <span>Night</span>
            <Toggle checked={switches.night} onChange={(value) => setLights({ switches: { ...switches, night: value } })} ariaLabel="Night" />
          </label>
        </div>
        <div className="se-actions">
          <Menu icon={<MapPin aria-hidden="true" />} ariaLabel="Siren markers" title="Siren markers on the model"
            pressed={editor.markers} className="se-marker-menu">
            <span className="cx-label se-menu-label">Markers</span>
            <MenuItem checked={editor.markers && editor.markerStyle === "callouts"}
              onSelect={() => { editor.setMarkerStyle("callouts"); editor.setMarkers(true); }}>Callouts</MenuItem>
            <MenuItem checked={editor.markers && editor.markerStyle === "classic"}
              onSelect={() => { editor.setMarkerStyle("classic"); editor.setMarkers(true); }}>Classic</MenuItem>
            <MenuItem checked={!editor.markers} onSelect={() => editor.setMarkers(false)}>Off</MenuItem>
          </Menu>
          <IconButton label="Undo (Ctrl+Z)" onClick={editor.undo} disabled={!editor.canUndo}><Undo2 aria-hidden="true" /></IconButton>
          <IconButton label="Redo (Ctrl+Y)" onClick={editor.redo} disabled={!editor.canRedo}><Redo2 aria-hidden="true" /></IconButton>
        </div>
      </header>

      <div className="se-tools" role="toolbar" aria-label="Sirens">
        <div className="se-tools-group">
          <button type="button" className="cx-btn lv-btn-sm" onClick={addSiren} disabled={count >= MAX_SIRENS}
            title={count >= MAX_SIRENS ? "A setting holds up to 32 sirens" : "Add a siren after the last one"}>
            <Plus aria-hidden="true" />
            Siren
          </button>
          <Menu label="Presets" disabled={!selection.length && count >= MAX_SIRENS}
            title={selection.length
              ? `Restyle the ${selection.length === 1 ? "selected siren" : `${selection.length} selected sirens`} with a preset. Each keeps its aim.`
              : "Add a set of preset sirens after the last one"}>
            <span className="cx-label se-menu-label">
              {selection.length ? `Restyle ${selection.length === 1 ? "siren" : "sirens"} ${compactNumbers(selection.map((index) => index + 1))}` : "Add after the last siren"}
            </span>
            {SIREN_LIGHT_PRESETS.map((preset) => (
              <MenuItem key={preset.id} hint={selection.length ? undefined : `${preset.lights.length}`}
                disabled={!selection.length && count + preset.lights.length > MAX_SIRENS}
                onSelect={() => applyLightPreset(preset.id)}>{preset.label}</MenuItem>
            ))}
          </Menu>
        </div>
        <div className="se-tools-group">
          <IconButton label="Duplicate (Ctrl+D)" onClick={duplicate} disabled={!selection.length || count + selection.length > MAX_SIRENS}><Copy aria-hidden="true" /></IconButton>
          <IconButton label="Move up: earlier siren bone (Alt+Up)" onClick={() => move(-1)} disabled={!selection.length || sortedSelection[0] === 0}><ArrowUp aria-hidden="true" /></IconButton>
          <IconButton label="Move down: later siren bone (Alt+Down)" onClick={() => move(1)} disabled={!selection.length || sortedSelection[sortedSelection.length - 1] === count - 1}><ArrowDown aria-hidden="true" /></IconButton>
          <IconButton label="Delete (Del). Later sirens move up a bone." onClick={remove} disabled={!selection.length}><Trash2 aria-hidden="true" /></IconButton>
        </div>
        <div className="se-tools-group">
          <Menu label="Pattern" disabled={!selection.length} title="Set the selected sirens' pattern">
            {SEQUENCER_PRESETS.map((preset) => (
              <MenuItem key={preset.id} onSelect={() => applyPreset(preset, false)}>{preset.label}</MenuItem>
            ))}
            <div className="se-menu-rule" role="separator" />
            {SEQUENCER_PRESETS.filter((preset) => preset.a !== preset.b).map((preset) => (
              <MenuItem key={`${preset.id}-alt`} hint="A/B" disabled={selection.length < 2}
                onSelect={() => applyPreset(preset, true)}>{preset.label}, alternating</MenuItem>
            ))}
            <div className="se-menu-rule" role="separator" />
            <span className="cx-label se-menu-label">Traffic advisor</span>
            {TRAFFIC_ADVISOR_MODES.map((mode) => (
              <MenuItem key={mode.id} hint={selection.length > 1 ? `${selection.length} heads` : "2+"} disabled={selection.length < 2}
                onSelect={() => applyTrafficAdvisor(mode.id)}>{mode.label}</MenuItem>
            ))}
          </Menu>
          <IconButton label="Shift pattern a step earlier ([)" onClick={() => patternEdit((value) => shiftSequencer(value, -1))} disabled={!selection.length}><ChevronLeft aria-hidden="true" /></IconButton>
          <IconButton label="Shift pattern a step later (])" onClick={() => patternEdit((value) => shiftSequencer(value, 1))} disabled={!selection.length}><ChevronRight aria-hidden="true" /></IconButton>
          <IconButton label="Invert pattern (I)" onClick={() => patternEdit(invertSequencer)} disabled={!selection.length}><FlipHorizontal2 aria-hidden="true" /></IconButton>
          <IconButton label="Copy pattern (Ctrl+C)" onClick={copyPattern} disabled={!primary}><ClipboardCopy aria-hidden="true" /></IconButton>
          <IconButton label="Paste pattern (Ctrl+V)" onClick={pastePattern} disabled={clipboard.current == null || !selection.length}><ClipboardPaste aria-hidden="true" /></IconButton>
        </div>
        <div className="se-tools-group se-palette" role="group" aria-label="Colour of the selected sirens">
          {SIREN_PALETTE.map((entry) => (
            <button key={entry.id} type="button" className={cx("se-palette-swatch", primary?.color?.toLowerCase() === entry.color && "is-on")}
              style={{ "--se-swatch": entry.color }} disabled={!selection.length} onClick={() => setColor(entry.color)}
              aria-label={`${entry.label} lens`} title={`${entry.label}: colour the selected sirens`} />
          ))}
        </div>
        <div className="se-tools-group">
          <button type="button" className={cx("cx-btn lv-btn-sm se-solo", soloed && "is-on")} onClick={toggleSolo} disabled={!selection.length}
            aria-pressed={soloed} title="Light only the selected sirens on the model">Solo</button>
          {muted.size && !soloed ? (
            <button type="button" className="cx-btn is-quiet lv-btn-sm" onClick={() => setLights({ muted: [] })}>Unmute all</button>
          ) : null}
        </div>
        <span className="se-tools-count">{selection.length > 1 ? `${selection.length} selected · ` : ""}{count}/{MAX_SIRENS} sirens</span>
      </div>

      <div ref={grid} className="se-grid custom-scrollbar" role="grid" aria-label="Siren patterns" aria-multiselectable="true">
        <div className="se-row se-ruler">
          <span className="se-head-cell se-ruler-label">Siren</span>
          <div ref={ruler} className="se-ruler-cells" title={bps > 0 ? "Jump to a step" : "Set a bpm to scrub the pattern"}>
            {Array.from({ length: SEQUENCER_STEPS }, (_, step) => (
              <button key={step} type="button" className={cx("se-ruler-cell", step % 4 === 0 && "is-beat")} tabIndex={-1}
                disabled={!(bps > 0)} onClick={() => seekStep(step)} aria-label={`Step ${step + 1}`} data-label={step + 1}>
                {step % 4 === 0 ? step + 1 : ""}
              </button>
            ))}
          </div>
          <span className="se-tail-cell" />
        </div>

        <div className="se-rows">
          <span className="se-step-track" aria-hidden="true">
            <span ref={column} className="se-step-band" hidden />
          </span>
          {draft.sirens.map((light, offset) => {
            const index = offset + 1;
            const isSelected = selected.has(offset);
            const hasMesh = meshSirens.has(index);
            return (
              <div key={offset} className={cx("se-siren", isSelected && "is-selected", muted.has(index) && "is-muted")} role="row" aria-selected={isSelected}>
                <div className="se-row">
                  <button type="button" className="se-head-cell se-siren-head" onClick={(event) => clickRow(event, offset)}
                    title={sirenTitle(light, index, hasMesh)}>
                    <span className="se-siren-index">{index}</span>
                    <span className="se-swatch" style={{ background: light.color || "#ffffff", opacity: Math.max(0.25, light.alpha ?? 1) }} aria-hidden="true" />
                    <span className="se-siren-tags">{sirenKind(light)}</span>
                    {hasMesh ? null : <span className="se-unbound" aria-label="No light on the model">∅</span>}
                  </button>
                  <Lane sequencer={light.flashiness.sequencer} color={light.color} dim={!light.flash} kind="flash"
                    label={`Siren ${index} flash pattern`} onPaint={paintSiren(offset, "flashiness")} />
                  <button type="button" className={cx("se-tail-cell se-mute", muted.has(index) && "is-on")} onClick={() => toggleMute(index)}
                    aria-pressed={muted.has(index)} aria-label={`Mute siren ${index}`} title={muted.has(index) ? "Unmute" : "Mute on the model"}>M</button>
                </div>
                {light.rotate ? (
                  <div className="se-row se-subrow">
                    <span className="se-head-cell se-sub-label">rotation</span>
                    <Lane sequencer={light.rotation.sequencer} color={light.color} kind="rotation"
                      label={`Siren ${index} rotation pattern`} onPaint={paintSiren(offset, "rotation")} />
                    <span className="se-tail-cell" />
                  </div>
                ) : null}
              </div>
            );
          })}
          {!count ? <p className="se-empty">No sirens yet. Add one, or append a preset set.</p> : null}
        </div>

        <div className="se-lamps">
          <span className="cx-label se-lamps-title">Head and tail lights</span>
          {LAMP_KEYS.map((key) => (
            <div key={key} className="se-row se-lamp">
              <span className="se-head-cell se-sub-label" title={`${LAMP_LABELS[key]} sequencer while the sirens run`}>{LAMP_LABELS[key]}</span>
              <Lane sequencer={draft.lamps?.[key]?.sequencer ?? 0} color={key.includes("Head") ? "#fff4e0" : "#ff1a0a"} kind="lamp"
                label={`${LAMP_LABELS[key]} pattern`} onPaint={paintLamp(key)} />
              <span className="se-tail-cell" />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
