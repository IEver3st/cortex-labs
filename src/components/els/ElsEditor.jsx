import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, Copy, Pause, Play, Plus, Redo2, Trash2, Undo2, X } from "lucide-react";
import { Toggle } from "../ui/toggle";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { NumberInput } from "../siren-editor/SirenInspector";
import { normalizeLightSwitches } from "../../lib/emergency-lights.js";
import {
  ELS_COLORS,
  ELS_EXTRA_COUNT,
  ELS_STAGE2_EXTRAS,
  ELS_V8_FORMATS,
  ELS_V8_GROUPS,
  ELS_V8_GROUP_KEYS,
  MISS_MAX_FLASHES,
  MISS_PATTERN_KEYS,
  MISS_PATTERN_LABELS,
  createVcf,
  elsColorHex,
  elsExtraRole,
  elsLightKey,
  ensureLight,
} from "../../lib/els-vcf.js";
import { elsAnimates, elsPlaybackNotes, elsRunning, elsSwitchBlocks, evaluateEls, v8GroupLane } from "../../lib/els-lights.js";
import { patternNumbers } from "../../lib/els-patterns.js";
import "../siren-editor/SirenEditor.css";
import "./Els.css";

// The Sirens centre in ELS mode. The bar switches the light stage (ELS V8) or
// the pattern keys (MISS-ELS) the way the scripts do in game, and a live strip
// shows the lit extras. Below it every VCF section is edited in place; each
// change goes to the draft in useEls, which the viewer's light rig plays.

const SPEEDS = [[0.25, "¼×"], [0.5, "½×"], [1, "1×"]];
const STAGES = [[0, "Off"], [1, "1"], [2, "2"], [3, "3"]];
const OVERRIDES = [["auto", "Stage"], ["on", "On"], ["off", "Off"]];
const MISC_LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

function isTextTarget(target) {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function lightLabel(light) {
  return light.kind === "misc" ? `Misc ${String(light.id).toUpperCase()}` : `Extra ${light.id}`;
}

function IconButton({ label, onClick, disabled, children }) {
  return (
    <button type="button" className="cx-icon-btn se-icon-btn" onClick={onClick} disabled={disabled} aria-label={label} title={label}>
      {children}
    </button>
  );
}

function Seg({ label, options, value, onChange, disabled }) {
  return (
    <div className="lv-seg se-seg" role="radiogroup" aria-label={label}>
      {options.map(([option, text]) => (
        <button key={option} type="button" role="radio" aria-checked={value === option} disabled={disabled}
          className={cx("lv-seg-btn", value === option && "is-on")} onClick={() => onChange(option)}>{text}</button>
      ))}
    </div>
  );
}

function Chip({ on, onClick, disabled, title, children }) {
  return (
    <button type="button" className={cx("se-chip", on && "is-on")} aria-pressed={on} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

function Field({ label, title, children }) {
  return (
    <div className="se-field">
      <span className="se-field-label" title={title || label}>{label}</span>
      <div className="se-field-control">{children}</div>
    </div>
  );
}

function Card({ title, meta, tools, children, className }) {
  return (
    <section className={cx("els-card", className)}>
      <header className="els-card-head">
        <h4 className="cx-label">{title}</h4>
        {meta ? <span className="sw-meta">{meta}</span> : null}
        {tools ? <div className="els-card-tools">{tools}</div> : null}
      </header>
      {children}
    </section>
  );
}

/* ─── Lights (EOVERRIDE) ─── */

function Swatches({ value, onChange, label }) {
  return (
    <div className="els-swatches" role="radiogroup" aria-label={label}>
      {ELS_COLORS.map((entry) => (
        <button key={entry.id} type="button" role="radio" aria-checked={value === entry.id}
          className={cx("se-palette-swatch", value === entry.id && "is-on")} style={{ "--se-swatch": entry.color }}
          onClick={() => onChange(entry.id)} aria-label={entry.label} title={entry.label} />
      ))}
    </div>
  );
}

function LightsCard({ els, modelExtras }) {
  const draft = els.draft;
  const v8 = draft.dialect === "els-v8";
  const rows = v8 ? draft.lights.filter((light) => light.kind === "extra") : draft.lights;
  const setLight = (light, patch, key) => els.edit((next) => {
    Object.assign(ensureLight(next, light.kind, light.id), patch);
  }, key);
  // ELS V8 lists extras only; a file may leave some out.
  const addable = [
    ...Array.from({ length: ELS_EXTRA_COUNT }, (_, index) => ({ kind: "extra", id: index + 1 })),
    ...(v8 ? [] : MISC_LETTERS.map((id) => ({ kind: "misc", id }))),
  ].filter((entry) => !draft.lights.some((light) => light.kind === entry.kind && light.id === entry.id));
  const add = (value) => {
    const [kind, raw] = value.split(":");
    const id = kind === "misc" ? raw : Number(raw);
    els.edit((next) => {
      Object.assign(ensureLight(next, kind, id), { controlled: true, envLight: kind === "extra", color: "white" });
    });
  };
  const known = modelExtras.size > 0;
  return (
    <Card title="Lights" meta={v8 ? "EOVERRIDE · ELS switches the controlled extras" : "EOVERRIDE · MISS-ELS switches the listed lights"}
      tools={addable.length ? (
        <Select value="" onValueChange={add}>
          <SelectTrigger className="lv-select els-add" aria-label="Add a light">
            <SelectValue placeholder="Add a light" />
          </SelectTrigger>
          <SelectContent className="lv-select-content">
            {addable.map((entry) => (
              <SelectItem key={elsLightKey(entry.kind, entry.id)} value={`${entry.kind}:${entry.id}`}
                description={entry.kind === "extra" && known && !modelExtras.has(entry.id) ? "Not on this model" : undefined}>
                {lightLabel(entry)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}>
      <div className="els-lights" role="table" aria-label="Lights">
        <div className="els-light els-light-head" role="row">
          <span role="columnheader">Light</span>
          <span role="columnheader" className="els-col-role">Role</span>
          <span role="columnheader" title={v8 ? "IsElsControlled" : "Listed in EOVERRIDE"}>{v8 ? "ELS" : "Listed"}</span>
          <span role="columnheader" title="AllowEnvLight: the light casts onto its surroundings">Env</span>
          <span role="columnheader">Colour</span>
          <span role="columnheader" className="els-col-offset" title="Environment light offset from the extra, in metres">Offset x · y · z</span>
        </div>
        {rows.map((light) => {
          const key = elsLightKey(light.kind, light.id);
          const missing = light.kind === "extra" && known && !modelExtras.has(light.id);
          const role = elsExtraRole(draft.dialect, light.id) || (light.kind === "misc" ? "Mod kit misc" : "");
          return (
            <div key={key} role="row" className={cx("els-light", !light.controlled && "is-off")}>
              <span role="cell" className="els-light-name">
                <span className="se-swatch" style={{ background: elsColorHex(light.color) }} aria-hidden="true" />
                {lightLabel(light)}
                {missing ? <span className="se-unbound" title={`The model has no extra_${light.id}`} aria-label="Not on the model">∅</span> : null}
              </span>
              <span role="cell" className="els-col-role sw-meta">{role}</span>
              <span role="cell">
                <Toggle checked={light.controlled} onChange={(value) => setLight(light, { controlled: value })}
                  ariaLabel={`${lightLabel(light)} ${v8 ? "ELS-controlled" : "listed"}`} />
              </span>
              <span role="cell">
                <Toggle checked={light.envLight} onChange={(value) => setLight(light, { envLight: value })} ariaLabel={`${lightLabel(light)} environment light`} />
              </span>
              <span role="cell">
                <Swatches value={light.color} onChange={(color) => setLight(light, { color })} label={`${lightLabel(light)} colour`} />
              </span>
              <span role="cell" className="els-col-offset els-offset">
                {[0, 1, 2].map((axis) => (
                  <NumberInput key={axis} value={light.offset[axis]} min={-10} max={10} step={0.05} digits={3}
                    label={`${lightLabel(light)} offset ${"xyz"[axis]}`}
                    onChange={(value) => setLight(light, { offset: light.offset.map((current, index) => (index === axis ? value : current)) }, `${key}:offset${axis}`)} />
                ))}
              </span>
            </div>
          );
        })}
        {!rows.length ? <p className="se-empty">No lights listed. Add the extras MISS-ELS should switch.</p> : null}
      </div>
    </Card>
  );
}

/* ─── ELS V8 ─── */

function PatternLane({ bits, onChar, length, color }) {
  const runs = useMemo(() => {
    const out = [];
    let start = -1;
    for (let index = 0; index < length; index += 1) {
      const on = bits.length > 0 && bits[index % bits.length] === onChar;
      if (on && start < 0) start = index;
      if (!on && start >= 0) {
        out.push([start, index - start]);
        start = -1;
      }
    }
    if (start >= 0) out.push([start, length - start]);
    return out;
  }, [bits, onChar, length]);
  return (
    <svg className="els-lane" viewBox={`0 0 ${length} 1`} preserveAspectRatio="none" aria-hidden="true">
      {runs.map(([x, width]) => <rect key={x} x={x} y={0} width={width} height={1} fill={color} />)}
    </svg>
  );
}

function PresetRow({ stage, preset, onChange }) {
  const scan = preset?.pattern === "scan";
  return (
    <div className="els-preset">
      <span className="els-preset-stage">Stage {stage}</span>
      <Toggle checked={Boolean(preset?.enabled)} onChange={(value) => onChange({ enabled: value, pattern: preset?.pattern ?? 1 })} ariaLabel={`Stage ${stage} preset pattern`} />
      {scan ? <span className="sw-meta els-preset-scan">scan</span> : (
        <NumberInput value={Number.isInteger(preset?.pattern) ? preset.pattern : 1} min={0} max={999} step={1} integer digits={0}
          label={`Stage ${stage} pattern number`} onChange={(value) => onChange({ enabled: preset?.enabled ?? true, pattern: value })} />
      )}
      <Chip on={scan} title="ScanPattern: cycle through the script's patterns"
        onClick={() => onChange({ enabled: preset?.enabled ?? true, pattern: scan ? 1 : "scan" })}>Scan</Chip>
    </div>
  );
}

function GroupCard({ els, groupKey }) {
  const draft = els.draft;
  const group = draft.v8?.[groupKey];
  const meta = ELS_V8_GROUPS[groupKey];
  const preview = els.preview;
  const lane = useMemo(() => v8GroupLane(draft, preview, groupKey, els.pack), [draft, preview, groupKey, els.pack]);
  const numbers = useMemo(() => (group && lane ? patternNumbers(els.pack, group.format, groupKey, lane.stage) : []), [els.pack, group, groupKey, lane]);
  const editGroup = (recipe, key) => els.edit((next) => {
    recipe(next.v8[groupKey]);
  }, key);
  const title = `${meta.label} (${meta.element})`;
  const extrasText = `extras ${meta.extras[0]}-${meta.extras[meta.extras.length - 1]}`;
  if (!group) {
    return (
      <Card title={title} meta={extrasText}>
        <p className="lv-slot-note is-error">This VCF has no {meta.element} section, so ELS will not load it.</p>
        <div className="lv-slot-actions">
          <button type="button" className="cx-btn lv-btn-sm" onClick={() => els.edit((next) => { next.v8[groupKey] = createVcf("els-v8").v8[groupKey]; })}>
            <Plus aria-hidden="true" />
            Add {meta.element}
          </button>
        </div>
      </Card>
    );
  }
  const formats = ELS_V8_FORMATS[groupKey].includes(group.format) ? ELS_V8_FORMATS[groupKey] : [...ELS_V8_FORMATS[groupKey], group.format];
  const manual = preview.patterns[groupKey];
  const playing = lane?.pattern;
  const stepPattern = (delta) => {
    if (!numbers.length) return;
    const at = numbers.indexOf(playing);
    const next = at < 0 ? numbers[0] : numbers[(at + delta + numbers.length) % numbers.length];
    els.setPreview((current) => ({ patterns: { ...current.patterns, [groupKey]: next } }));
  };
  const colors = new Map(draft.lights.filter((light) => light.kind === "extra").map((light) => [light.id, elsColorHex(light.color)]));
  return (
    <Card title={title} meta={extrasText}
      tools={<Seg label={`${meta.label} lights in the preview`} options={OVERRIDES} value={preview.groups[groupKey]}
        onChange={(value) => els.setPreview((current) => ({ groups: { ...current.groups, [groupKey]: value } }))} />}>
      <div className="els-group-row">
        <Field label="Format" title="LightingFormat: which of the script's pattern tables this group reads">
          <Select value={group.format} onValueChange={(value) => editGroup((target) => { target.format = value; })}>
            <SelectTrigger className="lv-select els-select" aria-label={`${meta.label} lighting format`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="lv-select-content">
              {formats.map((format) => <SelectItem key={format} value={format}>{format.toUpperCase()}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <div className="els-group-slot">
          {groupKey === "primary" ? (
            <Field label="Stage 2 extras" title="ExtrasActiveAtLstg2: the primary extras that flash at stage 2">
              <Select value={String(group.extrasAtStage2 || "1and4").toLowerCase()} onValueChange={(value) => editGroup((target) => { target.extrasAtStage2 = value; })}>
                <SelectTrigger className="lv-select els-select is-wide" aria-label="Primary extras at stage 2">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="lv-select-content">
                  {(ELS_STAGE2_EXTRAS.includes(String(group.extrasAtStage2 || "1and4").toLowerCase()) ? ELS_STAGE2_EXTRAS : [...ELS_STAGE2_EXTRAS, String(group.extrasAtStage2).toLowerCase()]).map((value) => (
                    <SelectItem key={value} value={value}>{value.replace("and", " and ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : groupKey === "secondary" || group.disableAtStage3 === true ? (
            // Warning lights run only at stage 3; their switch shows only to undo a file that sets it.
            <Field label="Off at stage 3" title="DisableAtLstg3: stop this group when the primaries take over">
              <Toggle checked={group.disableAtStage3 === true} onChange={(value) => editGroup((target) => { target.disableAtStage3 = value; })} ariaLabel={`${meta.label} off at stage 3`} />
            </Field>
          ) : null}
        </div>
        <div className="els-presets" role="group" aria-label="Preset patterns per stage">
          {[1, 2, 3].map((stage) => (
            <PresetRow key={stage} stage={stage} preset={group.presets?.[stage]}
              onChange={(preset) => editGroup((target) => { target.presets = { ...target.presets, [stage]: preset }; }, `${groupKey}:preset${stage}`)} />
          ))}
        </div>
      </div>
      {lane ? (
        <div className="els-playback">
          <div className="els-playback-head">
            <span className="cx-label">Stage {lane.stage}</span>
            <div className="els-pattern-step" role="group" aria-label={`${meta.label} pattern in the preview`}>
              <IconButton label="Previous pattern" onClick={() => stepPattern(-1)} disabled={numbers.length < 2}><ChevronLeft aria-hidden="true" /></IconButton>
              <span className="cx-display els-pattern-number" title={manual != null ? "Chosen in the preview, not saved" : "The stage's preset"}>
                {playing === "scan" ? "Scan" : playing ?? "-"}
              </span>
              <IconButton label="Next pattern" onClick={() => stepPattern(1)} disabled={numbers.length < 2}><ChevronRight aria-hidden="true" /></IconButton>
              {manual != null ? (
                <button type="button" className="cx-btn is-quiet lv-btn-sm" onClick={() => els.setPreview((current) => ({ patterns: { ...current.patterns, [groupKey]: null } }))}
                  title="Play the stage's preset again">Preset</button>
              ) : null}
            </div>
            <span className={cx("sw-meta els-source", lane.approximate && "is-approximate")} title={lane.reason || undefined}>
              {lane.approximate
                ? `Approximate. ${lane.reason}`
                : `${lane.source} ${group.format.toUpperCase()} ${lane.pattern} · ${lane.length} × ${lane.stepMs} ms`}
            </span>
          </div>
          {lane.rows.length ? (
            <div className="els-lanes">
              <span className="els-playhead" data-els-playhead="" data-group={groupKey} data-step-ms={lane.stepMs} data-length={lane.length} aria-hidden="true" />
              {lane.rows.map((row) => (
                <div key={row.extra} className="els-lane-row">
                  <span className="els-lane-label">{row.extra}</span>
                  <PatternLane bits={row.bits} onChar={lane.onChar} length={lane.length} color={colors.get(row.extra) || "#ffffff"} />
                </div>
              ))}
            </div>
          ) : (
            <p className="lv-slot-note">None of {extrasText} is ELS-controlled{groupKey === "primary" && lane.stage === 2 ? ` at stage 2 (${String(group.extrasAtStage2 || "1and4").replace("and", " and ")})` : ""}.</p>
          )}
        </div>
      ) : null}
    </Card>
  );
}

function MiscCard({ els }) {
  const misc = els.draft.v8?.misc;
  if (!misc) return null;
  const editMisc = (recipe, key) => els.edit((next) => {
    recipe(next.v8.misc);
  }, key);
  return (
    <Card title="Misc (MISC)">
      <div className="els-fields">
        <Field label="Slicktop" title="VehicleIsSlicktop">
          <Toggle checked={misc.slicktop} onChange={(value) => editMisc((target) => { target.slicktop = value; })} ariaLabel="Slicktop" />
        </Field>
        <Field label="Steady burn" title="UseSteadyBurnLights: extra 10 burns while any stage is on">
          <Toggle checked={misc.steadyBurn} onChange={(value) => editMisc((target) => { target.steadyBurn = value; })} ariaLabel="Steady burn" />
        </Field>
        <Field label="Carcols sirens" title="DfltSirenLtsActivateAtLstg: the stage that also runs the carcols.meta siren lights">
          <Seg label="Carcols sirens from stage" value={misc.sirenLightsAtStage}
            options={[[0, "Never"], [1, "1"], [2, "2"], [3, "3"]]}
            onChange={(value) => editMisc((target) => { target.sirenLightsAtStage = value; })} />
        </Field>
        <Field label="Arrowboard" title="ArrowboardType">
          <input className="se-text els-arrowboard" value={misc.arrowboard} spellCheck={false} aria-label="Arrowboard type"
            onChange={(event) => editMisc((target) => { target.arrowboard = event.target.value; }, "arrowboard")} />
        </Field>
        <Field label="Takedowns" title="Takedowns: extra 11">
          <Toggle checked={misc.takedowns.allow} onChange={(value) => editMisc((target) => { target.takedowns.allow = value; })} ariaLabel="Allow takedowns" />
          <label className="se-switch">
            <span>Mirrored</span>
            <Toggle checked={misc.takedowns.mirrored} onChange={(value) => editMisc((target) => { target.takedowns.mirrored = value; })} ariaLabel="Mirrored takedowns" />
          </label>
        </Field>
        <Field label="Scene lights" title="SceneLights: extra 12">
          <Toggle checked={misc.sceneLights.allow} onChange={(value) => editMisc((target) => { target.sceneLights.allow = value; })} ariaLabel="Allow scene lights" />
          <label className="se-switch">
            <span>Sides only</span>
            <Toggle checked={misc.sceneLights.sidesOnly} onChange={(value) => editMisc((target) => { target.sceneLights.sidesOnly = value; })} ariaLabel="Scene lights on the sides only" />
          </label>
        </Field>
      </div>
    </Card>
  );
}

function CruiseCard({ els }) {
  const cruise = els.draft.v8?.cruise;
  if (!cruise) return null;
  const editCruise = (recipe) => els.edit((next) => {
    recipe(next.v8.cruise);
  });
  return (
    <Card title="Cruise (CRUISE)" meta="steady primaries">
      <div className="els-fields">
        <Field label="Extras" title="UseExtras: the primary extras that burn steady in cruise mode">
          <div className="se-chips" role="group" aria-label="Cruise extras">
            {[1, 2, 3, 4].map((id) => (
              <Chip key={id} on={cruise.extras.includes(id)} onClick={() => editCruise((target) => {
                target.extras = target.extras.includes(id) ? target.extras.filter((value) => value !== id) : [...target.extras, id].sort((a, b) => a - b);
              })}>{id}</Chip>
            ))}
          </div>
        </Field>
        <Field label="Off at stage 3" title="DisableAtLstg3">
          <Toggle checked={cruise.disableAtStage3} onChange={(value) => editCruise((target) => { target.disableAtStage3 = value; })} ariaLabel="Cruise off at stage 3" />
        </Field>
      </div>
    </Card>
  );
}

/* ─── MISS-ELS ─── */

function flashWidth(duration) {
  return Math.max(18, Math.min(72, Math.round((Number(duration) || 0) / 4)));
}

function MissPatternCard({ els, patternKey }) {
  const draft = els.draft;
  const pattern = draft.miss?.patterns?.[patternKey];
  const [selected, setSelected] = useState(0);
  const paint = useRef(null);
  const label = MISS_PATTERN_LABELS[patternKey];
  useEffect(() => {
    const stop = () => { paint.current = null; };
    window.addEventListener("pointerup", stop);
    return () => window.removeEventListener("pointerup", stop);
  }, []);
  if (!pattern) {
    return (
      <Card title={label} meta="not in this VCF">
        <div className="lv-slot-actions">
          <button type="button" className="cx-btn lv-btn-sm"
            onClick={() => els.edit((next) => { next.miss.patterns[patternKey] = { isEmergency: true, flashHighBeam: false, warningBeep: false, flashes: [{ duration: 100, extras: [], miscs: [] }], attrs: {} }; })}>
            <Plus aria-hidden="true" />
            Add {label.toLowerCase()} pattern
          </button>
        </div>
      </Card>
    );
  }
  const flashes = pattern.flashes;
  const index = Math.min(selected, flashes.length - 1);
  const total = flashes.reduce((sum, flash) => sum + (Number(flash.duration) || 0), 0);
  const rows = draft.lights.filter((light) => light.controlled);
  const editPattern = (recipe, key) => els.edit((next) => {
    recipe(next.miss.patterns[patternKey]);
  }, key);
  const setFlag = (field, value) => editPattern((target) => { target[field] = value; });
  const has = (flash, light) => (light.kind === "misc" ? flash.miscs : flash.extras).includes(light.id);
  const setCell = (at, light, on) => editPattern((target) => {
    const flash = target.flashes[at];
    const field = light.kind === "misc" ? "miscs" : "extras";
    const without = flash[field].filter((value) => value !== light.id);
    flash[field] = on ? [...without, light.id].sort() : without;
    if (light.kind === "extra" && on) flash.extras.sort((a, b) => a - b);
  }, `paint:${patternKey}`);
  const insert = (at, flash) => {
    editPattern((target) => { target.flashes.splice(at, 0, flash); });
    setSelected(at);
  };
  const current = flashes[index];
  const full = flashes.length >= MISS_MAX_FLASHES;
  return (
    <Card title={label} meta={`${flashes.length} ${flashes.length === 1 ? "flash" : "flashes"} · ${(total / 1000).toFixed(2)} s loop`}
      tools={(
        <>
          <label className="se-switch" title="IsEmergency: the pattern counts as emergency lighting">
            <span>Emergency</span>
            <Toggle checked={pattern.isEmergency} onChange={(value) => setFlag("isEmergency", value)} ariaLabel={`${label} is emergency`} />
          </label>
          <label className="se-switch" title="FlashHighBeam: flash the headlights with the pattern">
            <span>High beams</span>
            <Toggle checked={pattern.flashHighBeam} onChange={(value) => setFlag("flashHighBeam", value)} ariaLabel={`${label} flashes the high beams`} />
          </label>
          <label className="se-switch" title="EnableWarningBeep">
            <span>Beep</span>
            <Toggle checked={pattern.warningBeep} onChange={(value) => setFlag("warningBeep", value)} ariaLabel={`${label} warning beep`} />
          </label>
        </>
      )}>
      <div className="se-tools els-flash-tools" role="toolbar" aria-label={`${label} flashes`}>
        <div className="se-tools-group">
          <span className="sw-meta">{current ? `Flash ${index + 1}` : "No flashes"}</span>
          {current ? (
            <NumberInput value={current.duration} min={1} max={10000} step={10} integer digits={0} label={`Flash ${index + 1} duration`} unit="ms"
              onChange={(value) => editPattern((target) => { target.flashes[index].duration = value; }, `${patternKey}:duration${index}`)} />
          ) : null}
        </div>
        <div className="se-tools-group">
          <IconButton label="Add a dark flash after this one" disabled={full}
            onClick={() => insert(current ? index + 1 : flashes.length, { duration: current?.duration || 100, extras: [], miscs: [] })}><Plus aria-hidden="true" /></IconButton>
          <IconButton label="Duplicate this flash" disabled={!current || full}
            onClick={() => insert(index + 1, JSON.parse(JSON.stringify(current)))}><Copy aria-hidden="true" /></IconButton>
          <IconButton label="Move earlier" disabled={!current || index === 0}
            onClick={() => { editPattern((target) => { target.flashes.splice(index - 1, 0, ...target.flashes.splice(index, 1)); }); setSelected(index - 1); }}><ArrowLeft aria-hidden="true" /></IconButton>
          <IconButton label="Move later" disabled={!current || index === flashes.length - 1}
            onClick={() => { editPattern((target) => { target.flashes.splice(index + 1, 0, ...target.flashes.splice(index, 1)); }); setSelected(index + 1); }}><ArrowRight aria-hidden="true" /></IconButton>
          <IconButton label="Delete this flash" disabled={!current}
            onClick={() => { editPattern((target) => { target.flashes.splice(index, 1); }); setSelected(Math.max(0, index - 1)); }}><Trash2 aria-hidden="true" /></IconButton>
        </div>
      </div>
      {flashes.length ? (
        <div className="els-timeline custom-scrollbar" role="grid" aria-label={`${label} flashes`}>
          <div className="els-tl-row" role="row">
            <span className="els-tl-head sw-meta" role="columnheader">ms</span>
            {flashes.map((flash, at) => (
              <button key={at} type="button" role="columnheader" data-els-flash={at} data-group={patternKey}
                className={cx("els-tl-col", at === index && "is-selected")} style={{ "--els-w": `${flashWidth(flash.duration)}px` }}
                onClick={() => setSelected(at)} title={`Flash ${at + 1}: ${flash.duration} ms`}>{flash.duration}</button>
            ))}
          </div>
          {rows.map((light) => (
            <div key={elsLightKey(light.kind, light.id)} className="els-tl-row" role="row">
              <span className="els-tl-head" role="rowheader">{lightLabel(light)}</span>
              {flashes.map((flash, at) => {
                const on = has(flash, light);
                return (
                  <button key={at} type="button" role="gridcell" aria-pressed={on} tabIndex={-1}
                    className={cx("els-tl-cell", at === index && "is-selected")} data-on={on ? "" : undefined}
                    style={{ "--els-w": `${flashWidth(flash.duration)}px`, "--els-color": elsColorHex(light.color) }}
                    aria-label={`${lightLabel(light)}, flash ${at + 1}`}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      paint.current = !on;
                      setSelected(at);
                      setCell(at, light, !on);
                    }}
                    onPointerEnter={(event) => {
                      if (paint.current == null || !(event.buttons & 1)) return;
                      if (on !== paint.current) setCell(at, light, paint.current);
                    }} />
                );
              })}
            </div>
          ))}
          {!rows.length ? <p className="se-empty">List lights in EOVERRIDE to switch them here.</p> : null}
        </div>
      ) : null}
    </Card>
  );
}

function StaticsCard({ els }) {
  const draft = els.draft;
  const statics = draft.miss?.statics || [];
  const candidates = draft.lights.filter((light) => !statics.some((entry) => entry.kind === light.kind && entry.id === light.id));
  const editStatics = (recipe, key) => els.edit((next) => {
    recipe(next.miss.statics);
  }, key);
  const shown = new Set(els.preview.statics);
  const toggleShown = (key, value) => els.setPreview((current) => ({
    statics: value ? [...new Set([...current.statics, key])] : current.statics.filter((entry) => entry !== key),
  }));
  return (
    <Card title="Statics (STATIC)" meta="steady lights on their own key"
      tools={candidates.length ? (
        <Select value="" onValueChange={(value) => {
          const light = candidates.find((entry) => elsLightKey(entry.kind, entry.id) === value);
          if (light) editStatics((target) => { target.push({ kind: light.kind, id: light.id, name: "" }); });
        }}>
          <SelectTrigger className="lv-select els-add" aria-label="Add a static light">
            <SelectValue placeholder="Add a static" />
          </SelectTrigger>
          <SelectContent className="lv-select-content">
            {candidates.map((light) => (
              <SelectItem key={elsLightKey(light.kind, light.id)} value={elsLightKey(light.kind, light.id)}>{lightLabel(light)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}>
      {statics.length ? (
        <div className="els-statics">
          {statics.map((entry, at) => {
            const key = elsLightKey(entry.kind, entry.id);
            return (
              <div key={key} className="els-static">
                <span className="els-light-name">{lightLabel(entry)}</span>
                <input className="se-text" value={entry.name || ""} placeholder="Name" spellCheck={false} aria-label={`${lightLabel(entry)} name`}
                  onChange={(event) => editStatics((target) => { target[at].name = event.target.value; }, `static:${key}`)} />
                <label className="se-switch">
                  <span>Preview</span>
                  <Toggle checked={shown.has(key)} onChange={(value) => toggleShown(key, value)} ariaLabel={`Show ${lightLabel(entry)} in the preview`} />
                </label>
                <IconButton label={`Remove ${lightLabel(entry)} from the statics`}
                  onClick={() => { editStatics((target) => { target.splice(at, 1); }); toggleShown(key, false); }}><X aria-hidden="true" /></IconButton>
              </div>
            );
          })}
        </div>
      ) : <p className="lv-slot-note">No statics. Takedowns and alley lights usually go here.</p>}
    </Card>
  );
}

/* ─── Editor ─── */

export default function ElsEditor({ s, els }) {
  const draft = els.draft;
  const preview = els.preview;
  const pack = els.pack;
  const lights = s.vehicleLights || {};
  const switches = normalizeLightSwitches(lights.switches);
  const speed = Number.isFinite(lights.speed) ? lights.speed : 1;
  const setLights = s.updateVehicleLights;
  const resumeSpeed = useRef(speed > 0 ? speed : 1);
  useEffect(() => {
    if (speed > 0) resumeSpeed.current = speed;
  }, [speed]);
  const togglePlay = useCallback(() => setLights({ speed: speed > 0 ? 0 : resumeSpeed.current }), [setLights, speed]);
  const modelExtras = useMemo(() => new Set((s.metaModelInfo?.extras || []).map((extra) => extra.index)), [s.metaModelInfo]);
  const v8 = draft?.dialect === "els-v8";
  const running = elsRunning(draft, preview);
  // Steady-only lights need no frame loop: one placement draws them.
  const animates = elsAnimates(draft, preview);
  const stripLights = useMemo(() => (draft?.lights || []).filter((light) => light.kind === "extra" && light.controlled), [draft]);
  const notes = useMemo(() => elsPlaybackNotes(evaluateEls(draft, preview, 0, pack)), [draft, preview, pack]);
  const sheet = useRef(null);
  const strip = useRef(null);

  // The strip, lane playheads and current MISS flash follow the light clock
  // through the DOM (data attributes React does not own), so playback does
  // not re-render the editor.
  useEffect(() => {
    if (!draft) return undefined;
    const root = sheet.current;
    const cells = [...(strip.current?.children || [])];
    const heads = root ? [...root.querySelectorAll("[data-els-playhead]")] : [];
    const columns = root ? [...root.querySelectorAll("[data-els-flash]")] : [];
    const placed = new Map();
    const place = () => {
      const seconds = s.getLightTime?.();
      const time = Number.isFinite(seconds) ? seconds * 1000 : 0;
      const frame = evaluateEls(draft, preview, time, pack);
      for (const cell of cells) cell.toggleAttribute("data-on", frame.lit.has(Number(cell.dataset.extra)));
      for (const head of heads) {
        const group = frame.groups[head.dataset.group];
        const live = Boolean(group?.active);
        head.toggleAttribute("data-live", live);
        if (!live) continue;
        const stepMs = Number(head.dataset.stepMs) || 1;
        const length = Number(head.dataset.length) || 1;
        head.style.setProperty("--els-at", String((Math.floor(time / stepMs) % length) / length));
      }
      for (const key of MISS_PATTERN_KEYS) {
        const group = frame.groups[key];
        const now = group?.active ? group.flashIndex : null;
        if (placed.get(key) === now) continue;
        placed.set(key, now);
        for (const column of columns) {
          if (column.dataset.group === key) column.toggleAttribute("data-now", Number(column.dataset.elsFlash) === now);
        }
      }
    };
    place();
    if (s.isActive === false || !(animates && speed > 0)) return undefined;
    let frame = requestAnimationFrame(function tick() {
      place();
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [draft, preview, pack, animates, speed, s]);

  const onKeyDown = (event) => {
    if (isTextTarget(event.target) || event.altKey) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === "z") {
      event.preventDefault();
      if (event.shiftKey) els.redo();
      else els.undo();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key === "y") {
      event.preventDefault();
      els.redo();
      return;
    }
    if (event.ctrlKey || event.metaKey) return;
    if (key === " ") {
      if (event.target instanceof Element && event.target.closest("button")) return;
      event.preventDefault();
      togglePlay();
      return;
    }
    if (v8 && ["0", "1", "2", "3"].includes(key)) {
      event.preventDefault();
      els.setPreview({ stage: Number(key) });
    }
  };

  if (!draft) return null;
  const misc = draft.v8?.misc;
  const blocks = elsSwitchBlocks(draft);

  return (
    <section ref={sheet} className="se-sheet els-sheet" aria-label="ELS lights" tabIndex={-1} onKeyDown={onKeyDown}>
      <header className="se-bar">
        <div className="se-transport" role="group" aria-label="Playback">
          <IconButton label={speed > 0 ? "Pause (Space)" : "Play (Space)"} onClick={togglePlay}>
            {speed > 0 ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          </IconButton>
        </div>
        {v8 ? (
          <div className="els-stage">
            <span className="cx-label">Stage</span>
            <Seg label="Light stage (0-3)" options={STAGES} value={preview.stage} onChange={(value) => els.setPreview({ stage: value })} />
          </div>
        ) : (
          <div className="se-chips els-keys" role="group" aria-label="Pattern keys">
            {MISS_PATTERN_KEYS.map((key) => (
              <Chip key={key} on={preview.miss[key]} disabled={Boolean(blocks.miss[key])} title={blocks.miss[key] || undefined}
                onClick={() => els.setPreview((current) => ({ miss: { ...current.miss, [key]: !current.miss[key] } }))}>
                {MISS_PATTERN_LABELS[key]}
              </Chip>
            ))}
          </div>
        )}
        <div ref={strip} className="se-strip els-strip" role="img" aria-label="ELS extras lit now" title="Which ELS extras are lit now">
          {stripLights.map((light) => (
            <span key={light.id} className="els-strip-cell" data-extra={light.id} style={{ "--els-color": elsColorHex(light.color) }}>{light.id}</span>
          ))}
        </div>
        <Seg label="Playback speed" options={SPEEDS} value={speed} onChange={(value) => setLights({ speed: value })} />
        <div className="se-switches">
          <label className="se-switch">
            <span>Night</span>
            <Toggle checked={switches.night} onChange={(value) => setLights({ switches: { ...switches, night: value } })} ariaLabel="Night" />
          </label>
        </div>
        <div className="se-actions">
          <IconButton label="Undo (Ctrl+Z)" onClick={els.undo} disabled={!els.canUndo}><Undo2 aria-hidden="true" /></IconButton>
          <IconButton label="Redo (Ctrl+Y)" onClick={els.redo} disabled={!els.canRedo}><Redo2 aria-hidden="true" /></IconButton>
        </div>
      </header>

      {v8 ? (
        <div className="se-tools" role="toolbar" aria-label="ELS switches">
          <div className="se-tools-group">
            <Chip on={preview.cruise} disabled={Boolean(blocks.cruise)} title={blocks.cruise || "Cruise lights: steady primaries"}
              onClick={() => els.setPreview({ cruise: !preview.cruise })}>Cruise</Chip>
            <Chip on={preview.takedowns && !blocks.takedowns} disabled={Boolean(blocks.takedowns)} title={blocks.takedowns || "Takedowns: extra 11"}
              onClick={() => els.setPreview({ takedowns: !preview.takedowns })}>Takedowns</Chip>
            <Chip on={preview.scene && !blocks.scene} disabled={Boolean(blocks.scene)} title={blocks.scene || "Scene lights: extra 12"}
              onClick={() => els.setPreview({ scene: !preview.scene })}>Scene</Chip>
          </div>
          {notes.length ? (
            <span className="els-notes" title={notes.map((note) => `${ELS_V8_GROUPS[note.group]?.label}: ${note.message}`).join("\n")}>
              Approximate flash: {notes.map((note) => ELS_V8_GROUPS[note.group]?.label).join(", ")}
            </span>
          ) : null}
          {running && misc?.sirenLightsAtStage > 0 ? (
            <span className="se-tools-count">carcols sirens from stage {misc.sirenLightsAtStage}</span>
          ) : null}
        </div>
      ) : null}

      <div className="els-body custom-scrollbar">
        <LightsCard els={els} modelExtras={modelExtras} />
        {v8 ? (
          <>
            {ELS_V8_GROUP_KEYS.map((key) => <GroupCard key={key} els={els} groupKey={key} />)}
            <MiscCard els={els} />
            <CruiseCard els={els} />
          </>
        ) : (
          <>
            {MISS_PATTERN_KEYS.map((key) => <MissPatternCard key={key} els={els} patternKey={key} />)}
            <StaticsCard els={els} />
          </>
        )}
      </div>
    </section>
  );
}
