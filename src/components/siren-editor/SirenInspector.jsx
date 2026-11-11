import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Toggle } from "../ui/toggle";
import { LensWriteDialog } from "./LensWriteDialog";
import {
  LAMP_KEYS,
  LAMP_LABELS,
  SIREN_FACINGS,
  argbFromColor,
  colorFromArgb,
  facingFromDelta,
  patternFromSequencer,
  sequencerFromPattern,
  updateSirens,
} from "../../lib/siren-settings.js";
import {
  ROTATOR_STEPS,
  STROBE_STEPS,
  SYNCED_PERCENT,
  baseSpeed,
  channelPercent,
  channelSpeedPatch,
  isSynced,
  retimeSirenSpeeds,
  speedFromPercent,
} from "../../lib/siren-speed.js";
import "./SirenEditor.css";
import { ColorInput } from "../ui/color-input";

// Inspector panels for the Sirens workspace: the selected sirens' fields and
// the setting's fields and checks. Edits go through the siren editor draft, so
// the model shows them at once; several selected sirens change together.

const DEG = 180 / Math.PI;

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

// Number entry that edits live while the text parses and snaps back on blur.
export function NumberInput({ value, onChange, min = -Infinity, max = Infinity, step = 1, integer = false, label, scale = 1, digits = 3, unit = "", disabled = false }) {
  const shown = Number.isFinite(value) ? Number((value * scale).toFixed(digits)) : "";
  const [text, setText] = useState(String(shown));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(String(shown));
  }, [shown]);
  const commit = (raw) => {
    const parsed = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(parsed)) return;
    let next = Math.min(max, Math.max(min, parsed));
    if (integer) next = Math.round(next);
    onChange(next / scale);
  };
  const input = (
    <input className={cx("se-num", unit && "has-unit")} value={text} inputMode="decimal" spellCheck={false} aria-label={label} disabled={disabled}
      onFocus={() => { focused.current = true; }}
      onBlur={() => { focused.current = false; setText(String(shown)); }}
      onChange={(event) => { setText(event.target.value); commit(event.target.value); }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        const base = Number.isFinite(Number(text)) ? Number(text) : 0;
        const next = base + (event.key === "ArrowUp" ? 1 : -1) * step * (event.shiftKey ? 10 : 1);
        const rounded = Number(next.toFixed(digits));
        setText(String(rounded));
        commit(String(rounded));
      }} />
  );
  if (!unit) return input;
  return (
    <span className="se-num-field" style={{ "--se-unit-ch": unit.length }}>
      {input}
      <span className="se-num-unit" aria-hidden="true">{unit}</span>
    </span>
  );
}

export function Field({ label, hint, className, children }) {
  return (
    <div className={cx("se-field", className)}>
      <span className="se-field-label" title={hint}>{label}</span>
      <div className="se-field-control">{children}</div>
    </div>
  );
}

// The slider covers the usual range; typed values may go past its top end.
export function RangeField({ label, hint, value, onChange, min, max, step, integer, scale = 1, digits = 3, unit = "", disabled = false }) {
  const scaled = Number.isFinite(value) ? value * scale : min;
  const fill = `${Math.max(0, Math.min(100, ((scaled - min) / (max - min)) * 100))}%`;
  return (
    <Field label={label} hint={hint}>
      <input className="se-range" type="range" min={min} max={max} step={step} value={Math.max(min, Math.min(max, scaled))}
        style={{ "--fill": fill }} aria-label={label} disabled={disabled} title={disabled ? hint : undefined}
        onChange={(event) => onChange(Number(event.target.value) / scale)} />
      <NumberInput value={value} onChange={onChange} min={min} step={step} disabled={disabled}
        integer={integer} label={`${label} value`} scale={scale} digits={digits} unit={unit} />
    </Field>
  );
}

function ToggleField({ label, hint, checked, onChange }) {
  return (
    <Field label={label} hint={hint}>
      <Toggle checked={checked} onChange={onChange} ariaLabel={label} />
    </Field>
  );
}

function TextField({ label, hint, value, onChange, placeholder }) {
  return (
    <Field label={label} hint={hint}>
      <input className="se-text" value={value} placeholder={placeholder} spellCheck={false} aria-label={label}
        onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}

function PatternField({ label, value, onChange }) {
  const pattern = patternFromSequencer(value);
  const [text, setText] = useState(pattern);
  useEffect(() => setText(pattern), [pattern]);
  const valid = sequencerFromPattern(text) != null;
  return (
    <Field label={label} hint="32 steps, 1 lit and 0 dark, first step first. Saved as the decimal sequencer.">
      <textarea className={cx("se-text se-pattern", !valid && "is-invalid")} value={text} maxLength={32} spellCheck={false}
        rows={2} aria-label={`${label} steps`} aria-invalid={!valid}
        onChange={(event) => {
          const next = event.target.value.replace(/[^01]/g, "");
          setText(next);
          const parsed = sequencerFromPattern(next);
          if (parsed != null) onChange(parsed);
        }}
        onBlur={() => setText(pattern)} />
    </Field>
  );
}

function ColorField({ light, onChange }) {
  const argb = argbFromColor(light.color, light.alpha);
  const [text, setText] = useState(argb);
  useEffect(() => setText(argb), [argb]);
  return (
    <Field label="Colour" hint="carcols stores siren colours as 0xAARRGGBB">
      <ColorInput className="se-color" swatch value={light.color || "#ffffff"} label="Siren colour"
        onChange={(color) => onChange({ color })} />
      <input className={cx("se-text se-hex", !colorFromArgb(text) && "is-invalid")} value={text} spellCheck={false} maxLength={10}
        aria-label="Siren colour ARGB"
        onChange={(event) => {
          setText(event.target.value);
          const parsed = colorFromArgb(event.target.value);
          if (parsed) onChange(parsed);
        }}
        onBlur={() => setText(argb)} />
    </Field>
  );
}

const LENS_MODES = [["texture", "Texture"], ["siren", "Siren"], ["custom", "Custom"]];
const HEX_RE = /^#?([0-9a-f]{6})$/i;

// Lens glow for the selected sirens (normalizeLensTints): the texture's own
// hue, the siren's carcols colour, or a picked colour. It previews at once; in
// game a lens glows in its emissive texture's colour, so "Write to textures"
// puts the colours into the vehicle's own texture dictionaries.
function LensFields({ s, light, sirens, primary }) {
  const [writing, setWriting] = useState(false);
  const tints = s.vehicleLights?.lens || {};
  const current = tints[primary];
  const mode = current === "siren" ? "siren" : current ? "custom" : "texture";
  const custom = mode === "custom" ? current : light.color || "#ffffff";
  const [text, setText] = useState(custom);
  useEffect(() => setText(custom), [custom]);
  const apply = (tint) => {
    const next = { ...tints };
    for (const siren of sirens) {
      if (tint) next[siren] = tint;
      else delete next[siren];
    }
    s.updateVehicleLights({ lensTints: next });
  };
  const choose = (option) => apply(option === "texture" ? null : option === "siren" ? "siren" : custom.toLowerCase());
  const tinted = Object.keys(tints).length;
  return (
    <Group title="Lens glow" order={2} trailing={tinted ? (
      <button type="button" className="cx-btn is-quiet lv-btn-sm" onClick={() => s.updateVehicleLights({ lensTints: {} })}
        title={`Back to the texture's colour on ${tinted === 1 ? "the 1 tinted siren" : `all ${tinted} tinted sirens`}`}>
        <RotateCcw aria-hidden="true" />
        Reset all
      </button>
    ) : null}>
      <Field label="Colour" hint="The colour the lens glows in the preview" className="se-field-wrap">
        <div className="lv-seg se-seg se-lens-seg" role="radiogroup" aria-label="Lens glow colour">
          {LENS_MODES.map(([option, label]) => (
            <button key={option} type="button" role="radio" aria-checked={mode === option}
              className={cx("lv-seg-btn", mode === option && "is-on")} onClick={() => choose(option)}>{label}</button>
          ))}
        </div>
      </Field>
      {mode === "custom" ? (
        <Field label="Glow colour">
          <ColorInput className="se-color" swatch value={current} label="Lens glow colour"
            onChange={(color) => apply(color.toLowerCase())} />
          <input className={cx("se-text se-hex", !HEX_RE.test(text) && "is-invalid")} value={text} spellCheck={false} maxLength={7}
            aria-label="Lens glow colour hex"
            onChange={(event) => {
              setText(event.target.value);
              const match = HEX_RE.exec(event.target.value.trim());
              if (match) apply(`#${match[1].toLowerCase()}`);
            }}
            onBlur={() => setText(custom)} />
        </Field>
      ) : null}
      <p className="se-note">Preview only until written. In game a lens glows in its texture's colour.</p>
      {tinted ? (
        <button type="button" className="cx-btn lv-btn-sm se-lens-write" onClick={() => setWriting(true)} disabled={!s.isTauriRuntime || !s.modelPath}
          title={!s.isTauriRuntime ? "Writing textures needs the desktop app." : "Write every tinted siren's lens colour into the vehicle's texture dictionaries"}>
          Write to textures…
        </button>
      ) : null}
      {writing ? <LensWriteDialog s={s} onClose={() => setWriting(false)} /> : null}
    </Group>
  );
}

// Groups keep their reading order in one column; wider panels place them in
// fixed columns (se-flow), so toggling a group never moves another one.
function Group({ title, trailing, order, children }) {
  return (
    <section className="se-group" style={order ? { order } : undefined}>
      <header className="se-group-head">
        <h4 className="cx-label">{title}</h4>
        {trailing}
      </header>
      {children}
    </section>
  );
}


// Field setters bound to the current selection. Rapid edits to one field undo
// as one step.
export function useSirenOps(editor) {
  const { edit, selection } = editor;
  const setField = useCallback((path, value) => {
    const [head, tail] = path.split(".");
    edit((current) => updateSirens(current, selection, (light) => {
      if (tail) light[head][tail] = value;
      else light[head] = value;
    }), `field:${path}:${selection.join(",")}`);
  }, [edit, selection]);
  const setLightPatch = useCallback((patch, key) => {
    edit((current) => updateSirens(current, selection, (light) => Object.assign(light, patch)), `field:${key}:${selection.join(",")}`);
  }, [edit, selection]);
  const setSettingField = useCallback((field, value) => {
    edit((current) => ({ ...current, [field]: value }), `setting:${field}`);
  }, [edit]);
  const setChannel = useCallback((channel, patch, key) => {
    edit((current) => updateSirens(current, selection, (light) => {
      light[channel] = { ...light[channel], ...patch };
    }), `field:${key}:${selection.join(",")}`);
  }, [edit, selection]);
  const setLampMultiples = useCallback((key, value) => {
    edit((current) => ({ ...current, lamps: { ...current.lamps, [key]: { sequencer: 0, ...current.lamps?.[key], multiples: value } } }), `lamp:${key}`);
  }, [edit]);
  const pausedTempo = useRef({ sirens: null, bpm: 0 });
  const setSequencerBpm = useCallback((value) => {
    edit((current) => {
      const paused = pausedTempo.current;
      const from = current.sequencerBpm > 0 ? current.sequencerBpm : paused.sirens === current.sirens ? paused.bpm : 0;
      const next = retimeSirenSpeeds(current, from, value);
      if (!(value > 0)) pausedTempo.current = { sirens: next.sirens, bpm: from };
      return next;
    }, "setting:sequencerBpm");
  }, [edit]);
  return { setField, setLightPatch, setChannel, setSettingField, setSequencerBpm, setLampMultiples };
}

/** The selected sirens' fields. */
export function SirenPanel({ s }) {
  const editor = s.sirenEditor;
  const { setField, setLightPatch, setChannel } = useSirenOps(editor);
  const light = editor?.draft?.sirens[editor.primary] || null;
  if (!editor?.draft) return <p className="se-empty">No siren setting open yet.</p>;
  if (!light) return <p className="se-empty">Select a siren in the grid or on the model.</p>;
  return (
    <div className="se-panel">
      <SirenFields light={light} multi={editor.selection.length > 1} count={editor.selection.length} index={editor.primary + 1}
        bpm={editor.draft.sequencerBpm} setField={setField} setLightPatch={setLightPatch} setChannel={setChannel}
        lens={s.modelPath ? <LensFields s={s} light={light} sirens={editor.selection.map((index) => index + 1)} primary={editor.primary + 1} /> : null} />
    </div>
  );
}

/** The setting's fields. Tempo, checks and saving live in the workspace dock. */
export function SettingPanel({ s }) {
  const editor = s.sirenEditor;
  const { setSettingField, setLampMultiples } = useSirenOps(editor);
  if (!editor?.draft) return <p className="se-empty">No siren setting open yet.</p>;
  return (
    <div className="se-panel">
      <SettingFields draft={editor.draft} setSettingField={setSettingField} setLampMultiples={setLampMultiples}
        lampLanes={Boolean(editor.lampLanes)} lampPatterns={editor.lampPatterns || 0} setLampLanes={editor.setLampLanes} />
    </div>
  );
}

function SirenFields({ light, multi, count, index, bpm, setField, setLightPatch, setChannel, lens }) {
  return (
    <>
      {multi ? (
        <p className="se-panel-title">
          <span className="se-note">Changes apply to every selected siren. Values shown are siren {index}'s.</span>
        </p>
      ) : null}
      <div className="se-flow">
        <div className="se-pair se-slot se-slot-1">
          <Group title="Light" order={1}>
            <ColorField light={light} onChange={(patch) => setLightPatch(patch, "color")} />
            <RangeField label="Intensity" value={light.intensity ?? 0} min={0} max={10} step={0.05} onChange={(value) => setField("intensity", value)} />
            <Field label="Light group" hint="Lights sharing a group share one real light in game">
              <NumberInput value={light.lightGroup ?? 0} min={0} max={255} integer label="Light group" onChange={(value) => setField("lightGroup", value)} />
            </Field>
            <ToggleField label="Casts light" hint="Lights the world and the body, not only the lens" checked={light.light} onChange={(value) => setField("light", value)} />
            <ToggleField label="Spot light" hint="A cone along the aim instead of a point light" checked={light.spotLight} onChange={(value) => setField("spotLight", value)} />
            <ToggleField label="Cast shadows" checked={light.castShadows} onChange={(value) => setField("castShadows", value)} />
          </Group>

          {lens}

          <Group title="Corona" order={6}>
            <RangeField label="Intensity" value={light.corona.intensity ?? 0} min={0} max={100} step={0.5} onChange={(value) => setField("corona.intensity", value)} />
            <RangeField label="Size" hint="0 turns the corona off" value={light.corona.size ?? 0} min={0} max={3} step={0.01} onChange={(value) => setField("corona.size", value)} />
            <RangeField label="Pull" hint="Pulls the corona toward the camera" value={light.corona.pull ?? 0} min={0} max={1} step={0.01} onChange={(value) => setField("corona.pull", value)} />
            <ToggleField label="Face camera" hint="Off fades the corona when the light points away" checked={light.corona.faceCamera} onChange={(value) => setField("corona.faceCamera", value)} />
          </Group>
        </div>

        <div className="se-pair">
          <div className="se-slot se-slot-2">
            <Group title="Flash" order={3} trailing={<Toggle checked={light.flash} onChange={(value) => setField("flash", value)} ariaLabel="Flash" />}>
              <PatternField label="Pattern" value={light.flashiness.sequencer} onChange={(value) => setField("flashiness.sequencer", value)} />
              <ChannelFields channel={light.flashiness} prefix="flashiness" bpm={bpm} setField={setField} setChannel={setChannel} />
            </Group>
          </div>

          <div className="se-slot se-slot-3">
            <Group title="Rotation" order={4} trailing={<Toggle checked={light.rotate} onChange={(value) => setField("rotate", value)} ariaLabel="Rotate" />}>
              {light.rotate ? (
                <>
                  <PatternField label="Pattern" value={light.rotation.sequencer} onChange={(value) => setField("rotation.sequencer", value)} />
                  <ChannelFields channel={light.rotation} prefix="rotation" bpm={bpm} setField={setField} setChannel={setChannel} rotation />
                </>
              ) : <p className="se-note">Turn on to spin everything on this siren's bone.</p>}
            </Group>

            <Group title="Scale" order={5} trailing={<Toggle checked={light.scale} onChange={(value) => setField("scale", value)} ariaLabel="Scale" />}>
              <RangeField label="Scale factor" hint="How much the bone's meshes grow while lit" value={light.scaleFactor ?? 1}
                min={0} max={20} step={0.5} digits={2} onChange={(value) => setField("scaleFactor", value)} />
            </Group>
          </div>
        </div>
      </div>

      {light.extraXml?.length ? (
        <p className="se-note">Keeps {light.extraXml.length} other {light.extraXml.length === 1 ? "tag" : "tags"} from carcols.meta on save.</p>
      ) : null}
    </>
  );
}

// Eight facings around a top-down vehicle (front at the top) for a flash's aim.
function FacingPicker({ value, onChange }) {
  const current = facingFromDelta(value)?.id;
  const cells = Array.from({ length: 9 }, (_, cell) => SIREN_FACINGS.find((facing) => facing.cell === cell) || null);
  return (
    <Field label="Facing" hint="Which way the light points: sets the aim to one of eight directions">
      <div className="se-facing" role="radiogroup" aria-label="Facing">
        {cells.map((facing, cell) => (facing ? (
          <button key={facing.id} type="button" role="radio" aria-checked={current === facing.id} aria-label={facing.label} title={`${facing.label} (${facing.degrees}°)`}
            className={cx("se-facing-cell", current === facing.id && "is-on")} onClick={() => onChange((facing.degrees * Math.PI) / 180)}>
            <span className="se-facing-dot" style={{ "--se-facing": `${-facing.degrees}deg` }} aria-hidden="true" />
          </button>
        ) : <span key={cell} className="se-facing-car" aria-hidden="true" />))}
      </div>
    </Field>
  );
}

// delta and start are radians in carcols; the editor shows degrees.
const SPEED_SLIDER_MAX = 400;

const formatSpeed = (value) => String(Number(value.toFixed(3)));

function SpeedFields({ channel, prefix, bpm, setChannel, rotation }) {
  const synced = isSynced(channel);
  const percent = channelPercent(channel, bpm);
  const base = baseSpeed(bpm);
  const steps = rotation ? ROTATOR_STEPS : STROBE_STEPS;
  const noTempo = base ? null : "Set a bpm first: the percentage is of the setting's bpm";
  const key = `${prefix}.speed`;
  const setPercent = (value) => setChannel(prefix, channelSpeedPatch(bpm, value), key);
  return (
    <>
      <ToggleField label="Sync to bpm" hint="Lights each step for exactly one beat, the same as 100%" checked={synced}
        onChange={(on) => setChannel(prefix, base ? { syncToBpm: on, speed: speedFromPercent(bpm, SYNCED_PERCENT) } : { syncToBpm: on }, `${prefix}.syncToBpm`)} />
      <RangeField label="Speed" value={percent} min={0} max={SPEED_SLIDER_MAX} step={1} digits={2} unit="%" disabled={Boolean(noTempo)} onChange={setPercent}
        hint={noTempo || "Percent of the bpm's own pace. 100% syncs to the bpm; higher shortens each flash, lower stretches it into the next steps. The pattern keeps the bpm either way."} />
      <Field label={rotation ? "Rotator" : "Strobe"}
        hint={noTempo || (rotation
          ? "Slower rotator, wig-wag and halogen speeds: bpm ÷ 100 × 1, 2, 4 or 8. A flashing mesh wants twice these."
          : "Above 100% shortens each flash. 200 to 300% or higher suits strobes.")}>
        <div className="se-chips se-speed-steps" role="group" aria-label={rotation ? "Rotator speeds" : "Strobe speeds"}>
          {steps.map((step) => {
            const on = !synced && Number.isFinite(percent) && Math.abs(percent - step.percent) < 1e-6;
            return (
              <button key={step.id} type="button" className={cx("se-chip", on && "is-on")} aria-pressed={on} disabled={Boolean(noTempo)}
                title={`${step.label}: ${step.percent}%${base ? `, speed ${formatSpeed(speedFromPercent(bpm, step.percent))}` : ""}`}
                onClick={() => setPercent(step.percent)}>{step.percent}</button>
            );
          })}
        </div>
      </Field>
      <Field label="Speed value" hint={synced
        ? "The stored speed. The game ignores it while synced. Typing one turns sync off."
        : "Written to carcols as speed. Type one to match a file and the percentage follows."}>
        <span className="se-speed-base">{base ? `100% = ${formatSpeed(base)}` : "No bpm"}</span>
        <NumberInput value={channel.speed} onChange={(value) => setChannel(prefix, { syncToBpm: false, speed: value }, key)} min={0} step={0.5}
          label="Speed value" />
      </Field>
    </>
  );
}

function ChannelFields({ channel, prefix, bpm, setField, setChannel, rotation = false }) {
  return (
    <>
      {rotation ? null : <FacingPicker value={channel.delta ?? 0} onChange={(value) => setField(`${prefix}.delta`, value)} />}
      <Field label="Multiples" hint="Flashes per lit step">
        <NumberInput value={channel.multiples ?? 1} min={1} max={16} integer label="Multiples" onChange={(value) => setField(`${prefix}.multiples`, value)} />
      </Field>
      <RangeField label={rotation ? "Delta" : "Aim"}
        hint={rotation ? "rotation delta: the turn's offset" : "flashiness delta: which way the light points while flashing; its meshes turn with it. 0 front, 90 left, 180 rear."}
        value={channel.delta ?? 0} min={-180} max={180} step={1} scale={DEG} digits={1} unit="°" onChange={(value) => setField(`${prefix}.delta`, value)} />
      <RangeField label="Start" hint={rotation ? "Angle the turn starts from" : "Stored for the game; the preview does not use it on a flash"}
        value={channel.start ?? 0} min={-180} max={180} step={1} scale={DEG} digits={1} unit="°"
        onChange={(value) => setField(`${prefix}.start`, value)} />
      <SpeedFields channel={channel} prefix={prefix} bpm={bpm} setChannel={setChannel} rotation={rotation} />
      <ToggleField label="Direction" hint={rotation ? "Off turns the other way" : "Stored for the game; no visible effect on a flash"}
        checked={channel.direction !== false} onChange={(value) => setField(`${prefix}.direction`, value)} />
    </>
  );
}

function SettingFields({ draft, setSettingField, setLampMultiples, lampLanes, lampPatterns, setLampLanes }) {
  return (
    <>
      <div className="se-flow">
        <div className="se-pair">
          <div className="se-slot se-slot-1">
            <Group title="Setting" order={1}>
              <TextField label="Name" value={draft.name || ""} placeholder="police" onChange={(value) => setSettingField("name", value)} />
              <Field label="Id" hint="carvariations.meta links a model to this id with sirenSettings">
                <NumberInput value={draft.id} min={0} max={4294967295} integer label="Siren setting id" onChange={(value) => setSettingField("id", value)} />
              </Field>
              <TextField label="Texture" value={draft.textureName || ""} placeholder="VehicleLight_sirenlight" onChange={(value) => setSettingField("textureName", value)} />
              <ToggleField label="Use real lights" checked={draft.useRealLights !== false} onChange={(value) => setSettingField("useRealLights", value)} />
            </Group>
          </div>
          <div className="se-slot se-slot-3">
            <Group title="Head and tail lights" order={3}>
              <ToggleField label="Grid lanes" hint="Four lanes at the end of the grid that flash the headlights and tail lights with the sirens"
                checked={lampLanes} onChange={setLampLanes} />
              {lampLanes ? (
                <>
                  {LAMP_KEYS.map((key) => (
                    <Field key={key} label={LAMP_LABELS[key]} hint="Flashes per lit step">
                      <NumberInput value={draft.lamps?.[key]?.multiples ?? 1} min={1} max={16} integer label={`${LAMP_LABELS[key]} multiples`}
                        onChange={(value) => setLampMultiples(key, value)} />
                    </Field>
                  ))}
                  <p className="se-note">Paint their patterns in the last four lanes of the grid. Each number is that lamp's flashes per lit step.</p>
                </>
              ) : (
                <p className="se-note">
                  {lampPatterns
                    ? `This setting flashes ${lampPatterns === 4 ? "all four lamps" : `${lampPatterns} of the four lamps`}. Their patterns still play and save while the lanes are hidden.`
                    : "Turn on to paint headlight and tail light flashes in the grid."}
                </p>
              )}
            </Group>
          </div>
        </div>
        <div className="se-pair se-slot se-slot-2">
          <Group title="Light spill" order={2}>
            <RangeField label="Falloff max" hint="How far siren light reaches, in metres" value={draft.lightFalloffMax ?? 0} min={0} max={100} step={0.5}
              onChange={(value) => setSettingField("lightFalloffMax", value)} />
            <RangeField label="Falloff exponent" value={draft.lightFalloffExponent ?? 0} min={0} max={100} step={0.5}
              onChange={(value) => setSettingField("lightFalloffExponent", value)} />
            <RangeField label="Inner cone" hint="Half-angle of the full-strength cone" value={draft.lightInnerConeAngle ?? 0} min={0} max={90} step={0.5} unit="°"
              onChange={(value) => setSettingField("lightInnerConeAngle", value)} />
            <RangeField label="Outer cone" hint="Half-angle where the light fades out" value={draft.lightOuterConeAngle ?? 0} min={0} max={90} step={0.5} unit="°"
              onChange={(value) => setSettingField("lightOuterConeAngle", value)} />
            <RangeField label="Light offset" value={draft.lightOffset ?? 0} min={-2} max={2} step={0.01}
              onChange={(value) => setSettingField("lightOffset", value)} />
          </Group>
        </div>
      </div>
      {draft.extraXml?.length ? (
        <p className="se-note">Keeps {draft.extraXml.length} other {draft.extraXml.length === 1 ? "tag" : "tags"} from carcols.meta on save.</p>
      ) : null}
    </>
  );
}
