import { memo, useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { GTA_PAINT_FINISHES } from "../../lib/data/gta-vehicle-colors.js";
import {
  FINISHED_PAINT_KEYS,
  PAINT_PALETTE_GROUPS,
  VEHICLE_PAINT_SLOTS,
  customPaint,
  finishLabel,
  paintDisplayColor,
  paintFromIndex,
  paintLabel,
} from "../../lib/vehicle-paint.js";
import { SelectField } from "./parts";

/* The vehicle's six game colours. Each slot holds a carcols palette colour or
   a custom RGB with a finish; the model's shaders decide which meshes take
   which slot. */

const HEX_RE = /^#[0-9a-f]{6}$/i;

function HexInput({ value, onCommit, label }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const next = draft.startsWith("#") ? draft : `#${draft}`;
    if (HEX_RE.test(next) && next.toLowerCase() !== value) onCommit(next.toLowerCase());
    else setDraft(value);
  };
  return (
    <input
      className="lv-hex"
      value={draft}
      spellCheck={false}
      maxLength={7}
      aria-label={`${label} custom colour hex`}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function PaintLine({ slot, paint, unused, selected, onSelect, onChange, onReset }) {
  const display = paintDisplayColor(paint);
  const custom = paint?.index == null;
  const detail = custom ? `Custom · ${finishLabel(paint?.finish)}` : paintLabel(paint);
  const setCustom = (hex) => onChange(customPaint(hex, paint?.finish));
  const title = custom ? detail : `${detail}, palette colour ${paint.index}`;
  return (
    <div
      className={`lv-color lv-paint ${selected ? "is-selected" : ""} ${unused ? "is-unused" : ""}`}
      title={unused ? `Not on this model: no mesh in it uses the ${slot.label.toLowerCase()} slot` : undefined}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onKeyDown={(event) => {
        if ((event.key === "Enter" || event.key === " ") && event.target === event.currentTarget) {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <label className="lv-chip" style={{ "--chip": display }} onClick={(event) => event.stopPropagation()}>
        <input
          type="color"
          value={display}
          onChange={(event) => setCustom(event.target.value)}
          aria-label={`${slot.label} custom colour`}
        />
      </label>
      <span className="lv-paint-text">
        <span className="lv-color-label">{slot.label}</span>
        <span className="lv-paint-detail" title={title}>{unused ? "Not on this model" : detail}</span>
      </span>
      <span className="lv-paint-hex" onClick={(event) => event.stopPropagation()}>
        <HexInput value={display} onCommit={setCustom} label={slot.label} />
      </span>
      <button
        type="button"
        className="cx-icon-btn lv-color-reset"
        onClick={(event) => {
          event.stopPropagation();
          onReset();
        }}
        title={`Reset ${slot.label.toLowerCase()}`}
        aria-label={`Reset ${slot.label.toLowerCase()}`}
      >
        <RotateCcw aria-hidden="true" />
      </button>
    </div>
  );
}

function moveFocus(event) {
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: "up", ArrowDown: "down", Home: "home", End: "end" }[event.key];
  if (step === undefined || !event.target.matches(".lv-pal")) return;
  const buttons = [...event.currentTarget.querySelectorAll(".lv-pal")];
  const from = buttons.indexOf(event.target);
  let to = from;
  if (typeof step === "number") to = from + step;
  else if (step === "home") to = 0;
  else if (step === "end") to = buttons.length - 1;
  else {
    // Same column in the next or previous row, across group breaks.
    const origin = event.target.getBoundingClientRect();
    const rows = buttons
      .map((button, index) => ({ index, rect: button.getBoundingClientRect() }))
      .filter(({ rect }) => (step === "down" ? rect.top > origin.top + 2 : rect.top < origin.top - 2));
    if (rows.length) {
      const rowTop = step === "down" ? Math.min(...rows.map(({ rect }) => rect.top)) : Math.max(...rows.map(({ rect }) => rect.top));
      const row = rows.filter(({ rect }) => Math.abs(rect.top - rowTop) < 2);
      to = row.reduce((best, entry) =>
        Math.abs(entry.rect.left - origin.left) < Math.abs(best.rect.left - origin.left) ? entry : best).index;
    }
  }
  if (to < 0 || to >= buttons.length || to === from) return;
  event.preventDefault();
  buttons[from].tabIndex = -1;
  buttons[to].tabIndex = 0;
  buttons[to].focus();
}

function paintFamily(paint) {
  if (!paint) return null;
  if (paint.index != null) return PAINT_PALETTE_GROUPS.find((group) => group.colors.some((entry) => entry.index === paint.index))?.label ?? null;
  return PAINT_PALETTE_GROUPS.find((group) => group.colors.some((entry) => entry.finish === paint.finish))?.label ?? null;
}

const Palette = memo(function Palette({ slotLabel, selectedIndex, family, onFamilyChange, onPick }) {
  const group = PAINT_PALETTE_GROUPS.find((entry) => entry.label === family) || PAINT_PALETTE_GROUPS[0];
  const inGroup = group.colors.some((entry) => entry.index === selectedIndex);
  const focusIndex = inGroup ? selectedIndex : group.colors[0].index;
  return (
    <div className="lv-palette">
      <div className="lv-seg lv-palette-families" role="radiogroup" aria-label="Palette">
        {PAINT_PALETTE_GROUPS.map((entry) => (
          <button
            key={entry.label}
            type="button"
            role="radio"
            aria-checked={entry.label === group.label}
            className={`lv-seg-btn ${entry.label === group.label ? "is-on" : ""}`}
            onClick={() => onFamilyChange(entry.label)}
            title={`${entry.label} colours`}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div className="lv-palette-group" role="group" aria-label={`${group.label} colours`} onKeyDown={moveFocus}>
        <div className="lv-palette-grid">
          {group.colors.map((entry) => {
            const on = entry.index === selectedIndex;
            const name = `${entry.name} (${entry.index})`;
            return (
              <button
                key={entry.index}
                type="button"
                className={`lv-pal ${on ? "is-on" : ""}`}
                style={{ "--chip": paintDisplayColor(paintFromIndex(entry.index)) }}
                tabIndex={entry.index === focusIndex ? 0 : -1}
                aria-pressed={on}
                aria-label={`Set ${slotLabel.toLowerCase()} to ${name}`}
                title={name}
                onClick={() => onPick(entry.index)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
});

/** `usedSlots`: slot keys the loaded model paints, or null when unknown. */
export default function PaintSlots({ paint, onChange, onReset, usedSlots = null, title = "Paint slots" }) {
  const [selected, setSelected] = useState(VEHICLE_PAINT_SLOTS[0].key);
  const slot = VEHICLE_PAINT_SLOTS.find((entry) => entry.key === selected) || VEHICLE_PAINT_SLOTS[0];
  const current = paint?.[slot.key];
  const pickRef = useRef(null);
  pickRef.current = (index) => onChange(slot.key, paintFromIndex(index));
  const [onPick] = useState(() => (index) => pickRef.current(index));
  const currentFamily = paintFamily(current);
  const [family, setFamily] = useState(currentFamily ?? PAINT_PALETTE_GROUPS[0].label);
  useEffect(() => {
    if (currentFamily) setFamily(currentFamily);
  }, [slot.key, currentFamily]);

  return (
    <section className="lv-group" id="panel-colors">
      <h3 className="lv-group-title">{title}</h3>
      <div className="lv-colors">
        {VEHICLE_PAINT_SLOTS.map((entry) => (
          <PaintLine
            key={entry.key}
            slot={entry}
            paint={paint?.[entry.key]}
            unused={Array.isArray(usedSlots) && !usedSlots.includes(entry.key)}
            selected={entry.key === slot.key}
            onSelect={() => setSelected(entry.key)}
            onChange={(value) => onChange(entry.key, value)}
            onReset={() => onReset(entry.key)}
          />
        ))}
      </div>
      {FINISHED_PAINT_KEYS.includes(slot.key) ? (
        <SelectField label={`${slot.label} finish`}>
          <Select
            value={String(current?.finish ?? 0)}
            onValueChange={(value) => onChange(slot.key, customPaint(paintDisplayColor(current), Number(value)))}
          >
            <SelectTrigger className="lv-select" aria-label={`${slot.label} finish`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="lv-select-content">
              {GTA_PAINT_FINISHES.map((finish) => (
                <SelectItem key={finish.id} value={String(finish.id)}>{finish.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {current?.index == null ? null : (
            <p className="lv-slot-note">A palette colour has its own finish. Changing it makes a custom colour.</p>
          )}
        </SelectField>
      ) : slot.key === "pearlescent" ? (
        <p className="lv-slot-note">Shows as a sheen on glossy primary paint.</p>
      ) : null}
      <Palette slotLabel={slot.label} selectedIndex={current?.index ?? null} family={family} onFamilyChange={setFamily} onPick={onPick} />
    </section>
  );
}
