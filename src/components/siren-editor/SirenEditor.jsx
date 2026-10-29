import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  FlipHorizontal2,
  MapPin,
  Pause,
  Play,
  Plus,
  Redo2,
  RotateCw,
  StepBack,
  StepForward,
  Trash2,
  Undo2,
} from "lucide-react";
import { Toggle } from "../ui/toggle";
import { Menu, MenuItem } from "./SirenMenu";
import { NumberInput, useSirenOps } from "./SirenInspector";
import { beatsPerSecond, evaluateSirens, normalizeLightSwitches } from "../../lib/emergency-lights.js";
import {
  LAMP_KEYS,
  LAMP_LABELS,
  MAX_SIRENS,
  COLOUR_TURN_RHYTHMS,
  DUAL_OFF,
  SEQUENCER_PRESETS,
  SEQUENCER_STEPS,
  SIREN_LIGHT_PRESETS,
  SIREN_PALETTE,
  TRAFFIC_ADVISOR_MODES,
  applySirenPreset,
  cloneSirenLight,
  createDualHead,
  dualHeads,
  dualStep,
  duplicateLights,
  nextDualState,
  pairSirens,
  setDualStep,
  unpairSirens,
  colourTurnSequencers,
  countColours,
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
const COLUMN_MIN = 16;
const COLUMN_MAX = 44;
const COLUMN_TIGHT = 24;
const COLUMN_GAP = 4;
const COLUMN_GAP_TIGHT = 2;
const SHORTCUTS = [
  [["1–6"], "Colour"],
  [["Click"], "Draw"],
  [["Right"], "Erase"],
  [["Space", "P"], "Play, pause"],
  [["↑", "↓"], "Step"],
  [["←", "→"], "Select head"],
  [["Alt", "←→"], "Move head"],
  [["Del"], "Delete"],
  [["Ctrl", "Z"], "Undo"],
];

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

function IconButton({ label, onClick, disabled, children, pressed }) {
  return (
    <button type="button" className={cx("cx-icon-btn se-icon-btn", pressed && "is-on")} onClick={onClick} disabled={disabled}
      aria-label={label} title={label} aria-pressed={pressed}>
      {children}
    </button>
  );
}

/* ─── Track grid ─── */

function stepAt(event) {
  const step = Number(event.target.dataset?.step);
  return Number.isInteger(step) ? step : null;
}

function Lane({ sequencer, color, dim, kind, label, onPaint }) {
  const pattern = patternFromSequencer(sequencer);
  const begin = (event) => {
    const step = stepAt(event);
    if (step == null || (event.button !== 0 && event.button !== 2)) return;
    event.preventDefault();
    onPaint(step, event.button === 2 ? false : pattern[step] !== "1", true, event.button === 2);
  };
  const enter = (event) => {
    if (!(event.buttons & 3)) return;
    const step = stepAt(event);
    if (step != null) onPaint(step, null, false);
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

function GhostLane({ onStart }) {
  const begin = (event) => {
    const step = stepAt(event);
    if (!onStart || step == null || event.button !== 0) return;
    event.preventDefault();
    onStart(step);
  };
  return (
    <div className="se-lane is-ghost" onPointerDown={begin}>
      {Array.from({ length: SEQUENCER_STEPS }, (_, step) => (
        <span key={step} data-step={step} className={cx("se-cell", step % 4 === 0 && "is-beat")} />
      ))}
    </div>
  );
}

function DualLane({ first, second, dim, label, onPaint }) {
  const a = patternFromSequencer(first.flashiness.sequencer);
  const b = patternFromSequencer(second.flashiness.sequencer);
  const state = (step) => (a[step] === "1" ? 1 : 0) | (b[step] === "1" ? 2 : 0);
  const begin = (event) => {
    const step = stepAt(event);
    if (step == null || (event.button !== 0 && event.button !== 2)) return;
    event.preventDefault();
    onPaint(step, event.button === 2 ? DUAL_OFF : nextDualState(state(step)), true, event.button === 2);
  };
  const enter = (event) => {
    if (!(event.buttons & 3)) return;
    const step = stepAt(event);
    if (step != null) onPaint(step, null, false);
  };
  return (
    <div className={cx("se-lane is-flash is-dual", dim && "is-dim")} role="group" aria-label={label}
      onPointerDown={begin} onPointerOver={enter}>
      {Array.from({ length: SEQUENCER_STEPS }, (_, step) => {
        const value = state(step);
        const style = value === 1 ? { "--se-cell": first.color } : value === 2 ? { "--se-cell": second.color }
          : value === 3 ? { "--se-cell": first.color, "--se-cell-b": second.color } : undefined;
        return (
          <span key={step} data-step={step} className={cx("se-cell", value && "is-on", value === 3 && "is-both", step % 4 === 0 && "is-beat")}
            style={style} />
        );
      })}
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

function lampInitials(label) {
  return label.split(/\s+/).map((word) => word[0]).join("").toUpperCase();
}

/* ─── Sequencer ─── */

export default function SirenEditor({ s, head = null, assist = null, foot = null }) {
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
  const playing = s.sirenTrial || draft;
  const playBps = beatsPerSecond(playing);
  const [seekTick, setSeekTick] = useState(0);
  const sheet = useRef(null);
  const clipboard = useRef(null);
  const stroke = useRef(null);
  const column = useRef(null);
  const ruler = useRef(null);
  const stepLabel = useRef(null);
  const strip = useRef(null);
  const canvas = useRef(null);
  const fade = useRef(null);
  const resumeSpeed = useRef(speed > 0 ? speed : 1);
  const { edit, select } = editor;
  const notify = (message) => s.showToast?.(message);

  useEffect(() => {
    if (speed > 0) resumeSpeed.current = speed;
  }, [speed]);

  /* Playback. The step column, step number and live strip follow the light
     clock through refs, so playing does not re-render the grid. */
  const setLights = s.updateVehicleLights;
  const running = s.isActive !== false && switches.sirens && speed > 0 && bps > 0;
  const togglePlay = useCallback(() => setLights({ speed: speed > 0 ? 0 : resumeSpeed.current }), [setLights, speed]);
  const seekStep = useCallback((step) => {
    if (!(playBps > 0)) return;
    if (!switches.sirens) setLights({ switches: { ...switches, sirens: true } });
    s.setLightTime?.(((step % SEQUENCER_STEPS) + SEQUENCER_STEPS) % SEQUENCER_STEPS / playBps);
    setSeekTick((value) => value + 1);
  }, [playBps, s, setLights, switches]);
  const stepBy = useCallback((delta) => {
    const time = s.getLightTime?.();
    const beat = Number.isFinite(time) && playBps > 0 ? Math.floor(time * playBps + 1e-6) : 0;
    if (speed > 0) setLights({ speed: 0 });
    seekStep(beat + delta);
  }, [playBps, s, seekStep, setLights, speed]);
  useEffect(() => {
    if (!draft) return undefined;
    let placed = { step: -1, height: 0, width: 0 };
    const placeRow = (step, live) => {
      const band = column.current;
      const cells = ruler.current?.children;
      if (!band || !cells) return;
      band.hidden = !live;
      const cols = strip.current;
      const height = cols?.clientHeight || 0;
      const width = cols?.clientWidth || 0;
      if (placed.step === (live ? step : -1) && placed.height === height && placed.width === width) return;
      if (placed.step >= 0) cells[placed.step]?.classList.remove("is-now");
      placed = { step: live ? step : -1, height, width };
      if (!live) return;
      const cell = cells[step];
      if (!cell) return;
      cell.classList.add("is-now");
      const cellRect = cell.getBoundingClientRect();
      const trackRect = band.parentElement.getBoundingClientRect();
      const lastRect = cols.querySelector(".se-lamp-group > .se-col:last-child")?.getBoundingClientRect();
      band.style.transform = `translateY(${cellRect.top - trackRect.top - 2}px)`;
      band.style.height = `${cellRect.height + 4}px`;
      band.style.width = lastRect ? `${lastRect.right - trackRect.left + 2}px` : "";
    };
    const place = () => {
      const time = s.getLightTime?.();
      const live = switches.sirens && Number.isFinite(time) && playBps > 0;
      const step = live ? Math.floor(time * playBps + 1e-6) % SEQUENCER_STEPS : 0;
      placeRow(step, live);
      if (stepLabel.current) stepLabel.current.textContent = live ? String(step + 1).padStart(2, "0") : "--";
      const lamps = strip.current?.querySelectorAll("[data-members]");
      if (!lamps) return;
      const states = live ? evaluateSirens(playing, time) : [];
      for (const lamp of lamps) {
        const lit = lamp.dataset.members.split(",").map(Number)
          .filter((index) => states[index]?.on && !muted.has(index + 1))
          .map((index) => states[index].color);
        lamp.style.background = lit.length > 1 ? `linear-gradient(90deg, ${lit[0]} 50%, ${lit[1]} 50%)` : lit[0] || "";
        lamp.classList.toggle("is-on", lit.length > 0);
      }
    };
    place();
    const resize = new ResizeObserver(() => {
      placed = { ...placed, height: -1 };
      place();
    });
    if (strip.current) resize.observe(strip.current);
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
  }, [draft, playing, playBps, running, muted, switches.sirens, s, seekTick]);

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
    delete light.head;
    if (last) {
      light.color = last.color === "#ff0000" ? "#0000ff" : "#ff0000";
      light.flashiness.sequencer = invertSequencer(last.flashiness.sequencer);
    }
    append([light]);
  };
  const heads = useMemo(() => dualHeads(draft), [draft]);
  const columns = useMemo(() => (draft?.sirens || []).flatMap((_, offset) => {
    const pair = heads.get(offset);
    if (pair) return pair[0] === offset ? [pair] : [];
    return [[offset]];
  }), [draft, heads]);
  const rotating = draft?.sirens.filter((light) => light.rotate).length ?? 0;
  useLayoutEffect(() => {
    const box = canvas.current;
    const cols = strip.current;
    if (!box || !cols) return undefined;
    const fit = () => {
      const flexible = cols.querySelectorAll(".se-col:not(.se-col-steps):not(.is-ghost):not(.is-sub)");
      const n = flexible.length;
      if (!n || !box.clientWidth) return;
      const style = getComputedStyle(box);
      const room = box.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const width = parseFloat(style.getPropertyValue("--se-col-w")) || COLUMN_MAX;
      const gap = parseFloat(style.getPropertyValue("--se-col-gap")) || COLUMN_GAP;
      const ghosts = cols.querySelector(".se-ghosts");
      const spare = ghosts ? ghosts.getBoundingClientRect().width + gap : 0;
      const gapCount = n + cols.querySelectorAll(".se-col.is-sub").length;
      const used = flexible[n - 1].getBoundingClientRect().right - cols.getBoundingClientRect().left - spare;
      const fixed = used - n * width - gapCount * gap;
      const columnFor = (between) => Math.floor((room - fixed - gapCount * between) / n);
      const tight = columnFor(COLUMN_GAP) < COLUMN_TIGHT;
      const nextGap = tight ? COLUMN_GAP_TIGHT : COLUMN_GAP;
      const next = Math.max(COLUMN_MIN, Math.min(COLUMN_MAX, columnFor(nextGap)));
      if (next !== width) box.style.setProperty("--se-col-w", `${next}px`);
      if (nextGap !== gap) box.style.setProperty("--se-col-gap", `${nextGap}px`);
    };
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(box);
    return () => watch.disconnect();
  }, [columns.length, rotating]);
  const hasDraft = Boolean(draft);
  useLayoutEffect(() => {
    const box = canvas.current;
    const edge = fade.current;
    if (!box || !edge) return undefined;
    const mark = () => {
      edge.hidden = box.scrollWidth - box.clientWidth - box.scrollLeft <= 1;
      edge.style.right = `${box.offsetWidth - box.clientWidth}px`;
      edge.style.bottom = `${box.offsetHeight - box.clientHeight}px`;
    };
    mark();
    const watch = new ResizeObserver(mark);
    watch.observe(box);
    if (strip.current) watch.observe(strip.current);
    box.addEventListener("scroll", mark, { passive: true });
    return () => {
      watch.disconnect();
      box.removeEventListener("scroll", mark);
    };
  }, [hasDraft]);
  const [brush, setBrush] = useState(SIREN_PALETTE[0].color);
  const paintGhost = (step) => {
    if (count >= MAX_SIRENS) return;
    const light = createSirenLight();
    light.color = brush;
    light.flash = true;
    light.flashiness.sequencer = setSequencerStep(0, step, true);
    stroke.current = { kind: "step", value: true, key: `paint:${Date.now()}` };
    append([light]);
  };
  const ghostStart = useRef(paintGhost);
  ghostStart.current = paintGhost;
  const ghosts = useMemo(() => (count < MAX_SIRENS ? (
    <div className="se-ghosts" aria-hidden="true">
      {Array.from({ length: MAX_SIRENS - count }, (_, offset) => (
        <div key={offset} className={cx("se-col is-ghost", offset === 0 && "is-next")}
          title={offset === 0 ? `Paint a step here to add siren ${count + 1} in the picked colour` : undefined}>
          <div className="se-col-top">
            <span className="se-col-head is-ghost">{count + offset + 1}</span>
          </div>
          <GhostLane onStart={offset === 0 ? (step) => ghostStart.current(step) : null} />
        </div>
      ))}
    </div>
  ) : null), [count]);
  const duplicate = () => append(duplicateLights(draft.sirens, sortedSelection));
  const addDualHead = () => append(createDualHead(draft.sirens));
  const selectionPair = selection.length === 2 ? sortedSelection : null;
  const canPair = Boolean(selectionPair) && heads.get(selectionPair[0])?.[1] !== selectionPair[1];
  const canSplit = selection.some((index) => heads.has(index));
  const pairSelection = () => {
    if (canPair) edit((current) => pairSirens(current, selectionPair[0], selectionPair[1]));
  };
  const splitSelection = () => {
    if (canSplit) edit((current) => unpairSirens(current, selection));
  };
  const remove = () => {
    if (!selection.length) return;
    edit((current) => withSirens(current, current.sirens.filter((_, index) => !selected.has(index))));
    const next = Math.min(sortedSelection[0], count - selection.length - 1);
    select(next >= 0 ? [next] : [], Math.max(0, next));
  };
  const picked = columns.map((members) => members.some((index) => selected.has(index)));
  const canMoveLeft = picked.some(Boolean) && !picked[0];
  const canMoveRight = picked.some(Boolean) && !picked[picked.length - 1];
  const move = (direction) => {
    if (!(direction < 0 ? canMoveLeft : canMoveRight)) return;
    const order = [...columns];
    const flags = [...picked];
    const scan = order.map((_, at) => at);
    for (const at of direction < 0 ? scan : scan.reverse()) {
      if (!flags[at]) continue;
      const to = at + direction;
      [order[at], order[to]] = [order[to], order[at]];
      [flags[at], flags[to]] = [flags[to], flags[at]];
    }
    const sequence = order.flat();
    edit((current) => withSirens(current, sequence.map((index) => current.sirens[index])));
    select(selection.map((index) => sequence.indexOf(index)), sequence.indexOf(editor.primary));
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
  const selectionColours = countColours(sortedSelection.map((index) => draft?.sirens[index]?.color));
  const applyColourTurns = (rhythm) => {
    const rank = new Map(sortedSelection.map((index, order) => [index, order]));
    edit((current) => {
      const sequencers = colourTurnSequencers(sortedSelection.map((index) => current.sirens[index]?.color), rhythm);
      return updateSirens(current, selection, (light, index) => {
        light[patternChannel(light)].sequencer = sequencers[rank.get(index)];
      });
    });
  };
  const setColor = (color) => edit((current) => updateSirens(current, selection, (light) => {
    light.color = color;
  }), `field:color:${selection.join(",")}`);
  const pickColour = (color) => {
    setBrush(color);
    if (selection.length) setColor(color);
  };
  const { setSettingField } = useSirenOps(editor);
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

  const paintSiren = (index, channel) => (step, value, start, erase) => {
    if (start) {
      stroke.current = { kind: "step", value, key: `paint:${Date.now()}` };
      if (!erase && !selected.has(index)) select([index], index);
    }
    if (stroke.current?.kind !== "step") return;
    const { value: on, key } = stroke.current;
    edit((current) => {
      const light = current.sirens[index];
      if (!light || sequencerStep(light[channel].sequencer, step) === on) return current;
      return updateSirens(current, [index], (next) => {
        next[channel].sequencer = setSequencerStep(next[channel].sequencer, step, on);
      });
    }, key);
  };
  const paintDual = (pair) => (step, value, start, erase) => {
    if (start) {
      stroke.current = { kind: "dual", value, key: `paint:${Date.now()}` };
      if (!erase && !pair.every((index) => selected.has(index))) select(pair, pair[0]);
    }
    if (stroke.current?.kind !== "dual") return;
    const { value: wanted, key } = stroke.current;
    edit((current) => {
      const [first, second] = pair.map((index) => current.sirens[index]);
      if (!first || !second || dualStep(first.flashiness.sequencer, second.flashiness.sequencer, step) === wanted) return current;
      const [a, b] = setDualStep(first.flashiness.sequencer, second.flashiness.sequencer, step, wanted);
      return updateSirens(current, pair, (next, index) => {
        next.flashiness.sequencer = index === pair[0] ? a : b;
      });
    }, key);
  };
  const paintLamp = (lampKey) => (step, value, start) => {
    if (start) stroke.current = { kind: "step", value, key: `paint:${Date.now()}` };
    if (stroke.current?.kind !== "step") return;
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

  const clickHead = (event, pair) => {
    if (event.shiftKey && selection.length) {
      const anchor = editor.primary;
      const from = Math.min(anchor, pair[0]);
      const to = Math.max(anchor, pair[1]);
      select(Array.from({ length: to - from + 1 }, (_, offset) => from + offset), pair[0]);
    } else if (event.ctrlKey || event.metaKey) {
      const on = pair.every((index) => selected.has(index));
      select(on ? selection.filter((entry) => !pair.includes(entry)) : [...new Set([...selection, ...pair])], pair[0]);
    } else select(pair, pair[0]);
  };
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
    else if (event.altKey && key === "arrowleft") move(-1);
    else if (event.altKey && key === "arrowright") move(1);
    else if (!ctrl && (key === "arrowleft" || key === "arrowright") && columns.length) {
      const at = Math.max(0, columns.findIndex((members) => members.includes(editor.primary)));
      const next = columns[Math.max(0, Math.min(columns.length - 1, at + (key === "arrowleft" ? -1 : 1)))];
      select(event.shiftKey ? [...new Set([...selection, ...next])] : next, next[0]);
    } else if (!ctrl && key === "arrowup") stepBy(-1);
    else if (!ctrl && key === "arrowdown") stepBy(1);
    else if (!ctrl && !event.altKey && key === "p") togglePlay();
    else if (!ctrl && !event.altKey && SIREN_PALETTE[Number(key) - 1]) pickColour(SIREN_PALETTE[Number(key) - 1].color);
    else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  if (!draft) return null;

  return (
    <section ref={sheet} className="se-sheet is-tool" aria-label="Siren sequencer" tabIndex={-1} onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        // Grid cells are not focusable; keep the sequencer's shortcuts live after painting.
        if (!(event.target instanceof Element) || event.target.closest("button, input, select, textarea, [tabindex]:not(.se-sheet)")) return;
        if (!sheet.current.contains(document.activeElement)) sheet.current.focus({ preventScroll: true });
      }}>
      <aside className="se-rail has-foot" aria-label="Siren setting and sequencer tools">
        <div className="se-rail-scroll custom-scrollbar">
          {head}
          {assist}
          <div className="se-rail-block se-rail-tempo">
            <div className="se-tempo">
              <div className="se-tempo-field" title="Steps per minute: one sequencer bit per step">
                <span className="cx-label">BPM</span>
                <NumberInput value={draft.sequencerBpm ?? 0} onChange={(value) => setSettingField("sequencerBpm", value)} min={0} step={10}
                  integer label="Sequencer bpm" />
              </div>
              <div className="se-tempo-field is-multiplier" title="Multiplies the bpm in game">
                <span className="cx-label">Multiplier</span>
                <NumberInput value={draft.timeMultiplier ?? 1} min={0} max={10} step={0.05} label="Time multiplier"
                  onChange={(value) => setSettingField("timeMultiplier", value)} />
              </div>
            </div>
            <span className="se-rail-meta">
              {bps > 0 ? `${(draft.timeMultiplier ?? 1) !== 1 ? `${Math.round((draft.sequencerBpm || 0) * (draft.timeMultiplier ?? 1))} bpm in game · ` : ""}${(SEQUENCER_STEPS / bps).toFixed(2)} s loop` : "Stopped: set a bpm to play"}
            </span>
          </div>

          <dl className="se-rail-block se-keys" aria-label="Shortcuts">
            {SHORTCUTS.map(([keys, action]) => (
              <div key={action} className="se-key">
                <dt>{keys.map((cap) => <kbd key={cap} className="cx-keycap">{cap}</kbd>)}</dt>
                <dd>{action}</dd>
              </div>
            ))}
          </dl>
          <div className="se-rail-block se-rail-tools" role="toolbar" aria-label="Sirens">
            <div className="se-rail-head">
              <span className="cx-label">Sirens</span>
              <span className="se-rail-meta">{count}/{MAX_SIRENS}</span>
            </div>
            <div className="se-colours" role="group" aria-label="Colour for new sirens and the selected sirens">
              {SIREN_PALETTE.map((entry, rank) => (
                <button key={entry.id} type="button" className={cx("se-colour", brush === entry.color && "is-on")} style={{ "--se-swatch": entry.color }}
                  onClick={() => pickColour(entry.color)} aria-pressed={brush === entry.color}
                  aria-label={`${entry.label} (${rank + 1})`} title={`${entry.label}: sirens you paint into an empty column, and the selected sirens (${rank + 1})`}>
                  <kbd className="cx-keycap se-colour-key" aria-hidden="true">{rank + 1}</kbd>
                </button>
              ))}
            </div>
            <div className="se-rail-grid">
              <button type="button" className="cx-btn lv-btn-sm" onClick={addSiren} disabled={count >= MAX_SIRENS}
                title={count >= MAX_SIRENS ? "A setting holds up to 32 sirens" : "Add a siren after the last one"}>
                <Plus aria-hidden="true" />
                Siren
              </button>
              <Menu label="Dual colour" title="Heads that flash two colours: two sirens in one column">
                <MenuItem hint="2 sirens" disabled={count + 2 > MAX_SIRENS} onSelect={addDualHead}>Add a dual-colour head</MenuItem>
                <MenuItem disabled={!canPair} onSelect={pairSelection}
                  hint={selectionPair ? `${selectionPair[0] + 1}+${selectionPair[1] + 1}` : "select 2"}>Pair the selected sirens</MenuItem>
                <MenuItem disabled={!canSplit} onSelect={splitSelection}>Split into single sirens</MenuItem>
              </Menu>
              <Menu label="Presets" disabled={!selection.length && count >= MAX_SIRENS}
                title={selection.length
                  ? `Restyle the ${selection.length === 1 ? "selected siren" : `${selection.length} selected sirens`} with a preset. Each keeps its aim.`
                  : "Add a set of preset sirens after the last one"}>
                <span className="cx-label se-menu-label">
                  {selection.length ? `Restyle ${selection.length === 1 ? "siren" : "sirens"} ${compactNumbers(selection.map((index) => index + 1))}` : "Add after the last siren"}
                </span>
                {SIREN_LIGHT_PRESETS.map((preset) => (
                  <MenuItem key={preset.id} hint={!selection.length ? `${preset.lights.length}`
                    : selection.length < countColours(preset.lights.map((light) => light.color)) ? `${countColours(preset.lights.map((light) => light.color))}+ sirens` : undefined}
                    disabled={!selection.length && count + preset.lights.length > MAX_SIRENS}
                    onSelect={() => applyLightPreset(preset.id)}>{preset.label}</MenuItem>
                ))}
              </Menu>
              <Menu label="Pattern" disabled={!selection.length} title="Set the selected sirens' pattern">
                {SEQUENCER_PRESETS.map((preset) => (
                  <MenuItem key={preset.id} onSelect={() => applyPreset(preset, false)}>{preset.label}</MenuItem>
                ))}
                <div className="se-menu-rule" role="separator" />
                <span className="cx-label se-menu-label">Colours take turns</span>
                {COLOUR_TURN_RHYTHMS.map((rhythm) => (
                  <MenuItem key={`turns-${rhythm.id}`} hint={selectionColours > 1 ? `${selectionColours} colours` : "2+ colours"} disabled={selectionColours < 2}
                    onSelect={() => applyColourTurns(rhythm.id)}>{rhythm.label}</MenuItem>
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
            </div>
            <div className="se-rail-icons">
              <div className="se-icon-group" role="group" aria-label="Edit">
                <IconButton label="Duplicate (Ctrl+D)" onClick={duplicate} disabled={!selection.length || count + selection.length > MAX_SIRENS}><Copy aria-hidden="true" /></IconButton>
                <IconButton label="Delete (Del). Later sirens move up a bone." onClick={remove} disabled={!selection.length}><Trash2 aria-hidden="true" /></IconButton>
              </div>
              <div className="se-icon-group" role="group" aria-label="Order">
                <IconButton label="Move left: earlier siren bone (Alt+Left)" onClick={() => move(-1)} disabled={!canMoveLeft}><ArrowLeft aria-hidden="true" /></IconButton>
                <IconButton label="Move right: later siren bone (Alt+Right)" onClick={() => move(1)} disabled={!canMoveRight}><ArrowRight aria-hidden="true" /></IconButton>
              </div>
              <div className="se-icon-group is-wide" role="group" aria-label="Pattern">
                <IconButton label="Shift pattern a step earlier ([)" onClick={() => patternEdit((value) => shiftSequencer(value, -1))} disabled={!selection.length}><ChevronUp aria-hidden="true" /></IconButton>
                <IconButton label="Shift pattern a step later (])" onClick={() => patternEdit((value) => shiftSequencer(value, 1))} disabled={!selection.length}><ChevronDown aria-hidden="true" /></IconButton>
                <IconButton label="Invert pattern (I)" onClick={() => patternEdit(invertSequencer)} disabled={!selection.length}><FlipHorizontal2 aria-hidden="true" /></IconButton>
                <IconButton label="Copy pattern (Ctrl+C)" onClick={copyPattern} disabled={!primary}><ClipboardCopy aria-hidden="true" /></IconButton>
                <IconButton label="Paste pattern (Ctrl+V)" onClick={pastePattern} disabled={clipboard.current == null || !selection.length}><ClipboardPaste aria-hidden="true" /></IconButton>
              </div>
            </div>
            <div className="se-rail-row">
              <button type="button" className={cx("cx-btn lv-btn-sm se-solo", soloed && "is-on")} onClick={toggleSolo} disabled={!selection.length}
                aria-pressed={soloed} title="Light only the selected sirens on the model">Solo</button>
              {muted.size && !soloed ? (
                <button type="button" className="cx-btn is-quiet lv-btn-sm" onClick={() => setLights({ muted: [] })}>Unmute all</button>
              ) : null}
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
            </div>
          </div>
        </div>
        {foot}
      </aside>

      <div className="se-stage">
        <div className="se-stage-head">
          <div className="se-counter" aria-label="Current step">
            <span ref={stepLabel} className="cx-display se-counter-step">--</span>
            <span className="se-counter-total">/ {SEQUENCER_STEPS}</span>
          </div>
          <div className="se-transport" role="group" aria-label="Playback">
            <IconButton label="Previous step (Up arrow)" onClick={() => stepBy(-1)} disabled={!(bps > 0)}><StepBack aria-hidden="true" /></IconButton>
            <IconButton label={speed > 0 ? "Pause (Space or P)" : "Play (Space or P)"} onClick={togglePlay}>
              {speed > 0 ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
            </IconButton>
            <IconButton label="Next step (Down arrow)" onClick={() => stepBy(1)} disabled={!(bps > 0)}><StepForward aria-hidden="true" /></IconButton>
          </div>
          <div className="lv-seg se-seg se-speed" role="radiogroup" aria-label="Playback speed">
            {SPEEDS.map(([value, text]) => (
              <button key={value} type="button" role="radio" aria-checked={speed === value}
                className={cx("lv-seg-btn", speed === value && "is-on")} onClick={() => setLights({ speed: value })}>{text}</button>
            ))}
          </div>
          <span className="se-tools-count">
            {count} {count === 1 ? "siren" : "sirens"} · {columns.length} {columns.length === 1 ? "head" : "heads"}
            {selection.length > 1 ? ` · ${selection.length} selected` : ""}
          </span>
          {count === 0 ? <span className="se-tools-hint">Paint the next empty column to add a siren</span> : null}
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
        </div>

        <div className="se-canvas-wrap">
          <div ref={canvas} className="se-canvas custom-scrollbar" onContextMenu={(event) => event.preventDefault()}>
            <div ref={strip} className="se-cols" role="group" aria-label="Siren patterns: a column per head, a row per step">
              <div className="se-col se-col-steps">
                <div className="se-col-top" aria-hidden="true">
                  <span className="se-col-head is-steps">Step</span>
                </div>
                <div ref={ruler} className="se-step-cells" title={bps > 0 ? "Jump to a step" : "Set a bpm to scrub the pattern"}>
                  {Array.from({ length: SEQUENCER_STEPS }, (_, step) => (
                    <button key={step} type="button" className={cx("se-step-cell", step % 4 === 0 && "is-beat")} tabIndex={-1}
                      disabled={!(bps > 0)} onClick={() => seekStep(step)} aria-label={`Step ${step + 1}`} data-label={step + 1}>
                      {step % 4 === 0 ? step + 1 : ""}
                    </button>
                  ))}
                </div>
              </div>

              <span className="se-step-track" aria-hidden="true">
                <span ref={column} className="se-step-band" hidden />
              </span>

              <div className="se-col-group" role="group" aria-label="Sirens">
                {columns.map((members) => {
                  const [first, second] = members;
                  const light = draft.sirens[first];
                  const partner = second == null ? null : draft.sirens[second];
                  const isSelected = members.some((member) => selected.has(member));
                  const isMuted = members.every((member) => muted.has(member + 1));
                  const names = members.map((member) => member + 1).join("+");
                  const unbound = modelLights ? members.filter((member) => !meshSirens.has(member + 1)).map((member) => member + 1) : [];
                  const title = partner
                    ? `Dual-colour head: sirens ${names}. Click a step for the first colour, again for the second, again for off; right-click clears it. In game each colour needs its own siren bone.${unbound.length ? ` Siren ${unbound.join(", ")} has no light on the model.` : ""}`
                    : sirenTitle(light, first + 1, !unbound.length);
                  const muteColumn = () => setLights({
                    muted: isMuted
                      ? [...muted].filter((entry) => !members.includes(entry - 1))
                      : [...new Set([...muted, ...members.map((member) => member + 1)])].sort((a, b) => a - b),
                  });
                  return (
                    <div key={first} className={cx("se-head-cols", isSelected && "is-selected", isMuted && "is-muted")}>
                      <div className={cx("se-col", partner && "is-dual")}>
                        <div className="se-col-top">
                          <button type="button" className={cx("se-col-head", partner && "is-dual")} onClick={(event) => (partner ? clickHead(event, members) : clickRow(event, first))}
                            title={title} aria-label={`${partner ? "Sirens" : "Siren"} ${names}`} aria-pressed={isSelected}>
                            <span className="se-col-index" aria-hidden="true">
                              {members.map((member) => <span key={member}>{member + 1}</span>)}
                            </span>
                            <span className={cx("se-col-swatch", partner && "is-dual")} aria-hidden="true"
                              style={{ "--se-a": light.color || "#ffffff", "--se-b": (partner || light).color || "#ffffff", opacity: partner ? 1 : Math.max(0.25, light.alpha ?? 1) }} />
                            {unbound.length ? <span className="se-unbound" title={partner ? "Not every colour has a light on the model" : "No light on the model"} aria-label={partner ? "Not every colour has a light on the model" : "No light on the model"}>∅</span> : null}
                          </button>
                          <button type="button" className={cx("se-mute", isMuted && "is-on")} onClick={partner ? muteColumn : () => toggleMute(first + 1)}
                            aria-pressed={isMuted} aria-label={`Mute ${partner ? "sirens" : "siren"} ${names}`} title={isMuted ? "Unmute" : "Mute on the model"}>M</button>
                          <span className="se-col-lamp" data-members={members.join(",")} aria-hidden="true" />
                        </div>
                        {partner ? (
                          <DualLane first={light} second={partner} dim={!light.flash && !partner.flash}
                            label={`Sirens ${names} dual-colour flash pattern`} onPaint={paintDual(members)} />
                        ) : (
                          <Lane sequencer={light.flashiness.sequencer} color={light.color} dim={!light.flash} kind="flash"
                            label={`Siren ${names} flash pattern`} onPaint={paintSiren(first, "flashiness")} />
                        )}
                      </div>
                      {members.filter((member) => draft.sirens[member].rotate).map((member) => (
                        <div key={member} className="se-col is-sub">
                          <div className="se-col-top">
                            <span className="se-col-head is-sub" title={`Siren ${member + 1} rotation pattern`}>
                              <RotateCw aria-hidden="true" />
                            </span>
                          </div>
                          <Lane sequencer={draft.sirens[member].rotation.sequencer} color={draft.sirens[member].color} kind="rotation"
                            label={`Siren ${member + 1} rotation pattern`} onPaint={paintSiren(member, "rotation")} />
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>

              {ghosts}

              <div className="se-col-group se-lamp-group" role="group" aria-label="Head and tail lights">
                {LAMP_KEYS.map((key) => (
                  <div key={key} className="se-col is-lamp">
                    <div className="se-col-top">
                      <span className="se-col-head is-lamp" title={`${LAMP_LABELS[key]} sequencer while the sirens run`}>{lampInitials(LAMP_LABELS[key])}</span>
                    </div>
                    <Lane sequencer={draft.lamps?.[key]?.sequencer ?? 0} color={key.includes("Head") ? "#fff4e0" : "#ff1a0a"} kind="lamp"
                      label={`${LAMP_LABELS[key]} pattern`} onPaint={paintLamp(key)} />
                  </div>
                ))}
              </div>
            </div>
          </div>
          <span ref={fade} className="se-canvas-fade" aria-hidden="true" hidden />
        </div>
      </div>
    </section>
  );
}
