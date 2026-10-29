import { useEffect, useMemo, useRef } from "react";
import { Toggle } from "./ui/toggle";
import { Slider } from "./workspace/parts";
import { beatsPerSecond, DEFAULT_HAZE, normalizeLightSwitches, sequencerPattern, SEQUENCER_STEPS } from "../lib/emergency-lights.js";
import { elsRunning, elsSwitchBlocks } from "../lib/els-lights.js";
import { MISS_PATTERN_KEYS, MISS_PATTERN_LABELS } from "../lib/els-vcf.js";
import "./VehicleLightsPanel.css";

// Light preview controls for a loaded vehicle. Every control writes the light
// state the host passes to the viewer; the viewer's rig does the rendering.

const HEADLIGHT_OPTIONS = [["off", "Off"], ["on", "On"], ["full", "Full"]];
const INDICATOR_OPTIONS = [["off", "Off"], ["left", "Left"], ["right", "Right"], ["hazard", "Hazard"]];
const SPEED_OPTIONS = [[0, "Pause"], [0.25, "¼×"], [0.5, "½×"], [1, "1×"]];

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

function Segmented({ label, options, value, onChange, disabled }) {
  return (
    <div className="lv-seg vl-seg" role="radiogroup" aria-label={label}>
      {options.map(([key, text]) => (
        <button
          key={String(key)}
          type="button"
          role="radio"
          aria-checked={value === key}
          className={cx("lv-seg-btn", value === key && "is-on")}
          onClick={() => onChange(key)}
          disabled={disabled}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function Row({ label, hint, title, stacked, children }) {
  return (
    <div className={cx("vl-row", stacked && "is-stacked")} title={title}>
      <div className="vl-row-text">
        <span className="vl-row-label">{label}</span>
        {hint ? <span className="vl-row-hint">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

function sirenSummary(siren, index) {
  const parts = [`Siren ${index}`];
  if (siren.flash) parts.push("flash");
  if (siren.rotate) parts.push("rotate");
  if (siren.light) parts.push(siren.spotLight ? "spot light" : "point light");
  if (siren.color) parts.push(siren.color);
  return parts.join(" · ");
}

// Playhead across the 32 steps, driven from the viewer's light clock. It runs
// only while sirens play and this panel is mounted.
function Playhead({ getTime, bps, running }) {
  const ref = useRef(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const place = () => {
      const time = getTime?.();
      const beat = Number.isFinite(time) && bps > 0 ? time * bps : 0;
      node.style.left = `${((beat % SEQUENCER_STEPS) / SEQUENCER_STEPS) * 100}%`;
    };
    place();
    if (!running) return undefined;
    let frame = requestAnimationFrame(function tick() {
      place();
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [getTime, bps, running]);
  return <span ref={ref} className="vl-playhead" aria-hidden="true" />;
}

const MOTION_OPTIONS = [["drive", "Driving"], ["park", "Parked"]];
const SYSTEM_OPTIONS = [[false, "Carcols"], [true, "ELS"]];
const ELS_STAGE_OPTIONS = [[0, "Off"], [1, "1"], [2, "2"], [3, "3"]];
const ELS_DIALECTS = { "els-v8": "ELS V8", "miss-els": "MISS-ELS" };

function listExtras(extras) {
  return extras.length ? extras.join(", ") : "none";
}

function fileName(path) {
  return String(path || "").split(/[\\/]/).pop();
}

// What the lighting controller (ULC) or the siren geometry does with extras, the
// buttons the config defines, and which extras are on right now and why.
function ExtrasControls({ ulc, ulcPath, ulcError, modelLights, extrasPlan, extrasState, onExtrasStateChange, elsExtras }) {
  const pressed = new Set(extrasState?.buttons || []);
  const toggleButton = (extra) => {
    const buttons = (extrasState?.buttons || []).filter((entry) => entry !== extra);
    onExtrasStateChange?.({ buttons: pressed.has(extra) ? buttons : [...buttons, extra] });
  };
  const sirenExtras = Object.entries(modelLights?.extras || {})
    .filter(([, info]) => info.sirens.length)
    .map(([extra, info]) => `${extra} (siren ${info.sirens[0]}${info.sirens.length > 1 ? `-${info.sirens[info.sirens.length - 1]}` : ""})`);
  const on = extrasPlan?.on || [];
  return (
    <div className="vl-pattern">
      <div className="vl-pattern-head">
        <span className="vl-subtitle">Extras</span>
        <span className="vl-count" title={ulcPath || undefined}>{ulc ? `ULC · ${fileName(ulcPath)}` : "No ULC config"}</span>
      </div>
      {ulcError ? <p className="vl-muted vl-plate-error">{fileName(ulcPath)} could not be read: {ulcError}</p> : null}
      {ulc?.buttons.length ? (
        <div className="vl-chips" role="group" aria-label="Lighting controller buttons">
          {ulc.buttons.map((button) => (
            <button
              key={button.extra}
              type="button"
              className={pressed.has(button.extra) ? "vl-chip is-on" : "vl-chip"}
              aria-pressed={pressed.has(button.extra)}
              onClick={() => toggleButton(button.extra)}
              title={`Extra ${button.extra}${button.linked.length ? ` with ${listExtras(button.linked)}` : ""}${button.key != null ? ` · ULC key ${button.key}` : ""}`}
            >
              <span>{button.label}</span>
              {button.key != null ? <span className="vl-chip-key">{button.key}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      <p className="vl-muted">
        {ulc
          ? `Spawns with no extras. ${ulc.park.enabled ? `Sirens use extra ${listExtras(ulc.park.driveExtras)} driving and ${listExtras(ulc.park.parkExtras)} parked. ` : ""}${ulc.brake.enabled ? `Brakes add ${listExtras(ulc.brake.extras)}. ` : ""}${ulc.reverse.enabled ? `Reverse adds ${listExtras(ulc.reverse.extras)}. ` : ""}${ulc.horn.enabled ? `Horn adds ${listExtras(ulc.horn.extras)}. ` : ""}`
          : sirenExtras.length
            ? `No ULC config in this resource. Spawns with no extras; extras carrying siren lights come on with the sirens: ${sirenExtras.join(", ")}.`
            : "No ULC config in this resource. Spawns with no extras; switch them in the Extras grid."}
      </p>
      <p className="vl-muted vl-extras-on">
        {elsExtras ? "ELS is switching the extras it controls."
          : on.length ? `On: ${on.map((extra) => `${extra} ${extrasPlan.reasons[extra]}`).join(" · ")}` : "No extras on."}
      </p>
    </div>
  );
}

function Chip({ on, disabled, title, onClick, children }) {
  return (
    <button type="button" className={cx("vl-chip", on && "is-on")} aria-pressed={on} disabled={disabled} title={title} onClick={onClick}>
      {children}
    </button>
  );
}

// Which system drives the lights, and while ELS does, the VCF's own switches.
// The VCF is edited in Sirens; these switch only the preview.
function ElsRows({ els }) {
  const draft = els.draft;
  const live = els.enabled && Boolean(draft);
  const name = els.file ? fileName(els.file.path) : "New VCF";
  const hint = draft
    ? `${name} · ${ELS_DIALECTS[draft.dialect] || "ELS"}${els.onDisk?.text != null ? " · changed on disk" : els.dirty ? " · unsaved" : ""}`
    : els.status === "scanning" ? "Looking for the vehicle's VCF…"
      : "No VCF found for this vehicle. Open or start one in Sirens.";
  const preview = els.preview;
  const blocks = live ? elsSwitchBlocks(draft) : null;
  const toggle = (key) => els.setPreview((current) => ({ [key]: !current[key] }));
  return (
    <>
      <Row label="Lighting" hint={hint} title={els.file?.path}>
        <Segmented label="Lighting system" options={SYSTEM_OPTIONS} value={els.enabled} onChange={els.setEnabled} />
      </Row>
      {live && draft.dialect === "els-v8" ? (
        <>
          <Row label="Stage" hint={preview.stage ? `Light stage ${preview.stage}` : "Lights off"}>
            <Segmented label="ELS light stage" options={ELS_STAGE_OPTIONS} value={preview.stage}
              onChange={(value) => els.setPreview({ stage: value })} />
          </Row>
          <Row label="Switches" stacked>
            <div className="vl-chips" role="group" aria-label="ELS switches">
              <Chip on={preview.cruise && !blocks.cruise} disabled={Boolean(blocks.cruise)} title={blocks.cruise || "Cruise lights: steady primaries"}
                onClick={() => toggle("cruise")}>Cruise</Chip>
              <Chip on={preview.takedowns && !blocks.takedowns} disabled={Boolean(blocks.takedowns)} title={blocks.takedowns || "Takedowns: extra 11"}
                onClick={() => toggle("takedowns")}>Takedowns</Chip>
              <Chip on={preview.scene && !blocks.scene} disabled={Boolean(blocks.scene)} title={blocks.scene || "Scene lights: extra 12"}
                onClick={() => toggle("scene")}>Scene</Chip>
            </div>
          </Row>
        </>
      ) : null}
      {live && draft.dialect === "miss-els" ? (
        <Row label="Patterns" stacked>
          <div className="vl-chips" role="group" aria-label="MISS-ELS pattern keys">
            {MISS_PATTERN_KEYS.map((key) => (
              <Chip key={key} on={preview.miss[key] && !blocks.miss[key]} disabled={Boolean(blocks.miss[key])} title={blocks.miss[key] || undefined}
                onClick={() => els.setPreview((current) => ({ miss: { ...current.miss, [key]: !current.miss[key] } }))}>
                {MISS_PATTERN_LABELS[key]}
              </Chip>
            ))}
          </div>
        </Row>
      ) : null}
    </>
  );
}

export default function VehicleLightsPanel({ lights, onChange, modelLights, setting, sirenStatus, getTime, ulc = null, ulcPath = "", ulcError = "", extrasPlan, extrasState, onExtrasStateChange, showPattern = true, els = null, active = true }) {
  const switches = normalizeLightSwitches(lights?.switches);
  // While ELS drives this vehicle, its stage runs the sirens, not the toggle.
  const elsLive = Boolean(els?.enabled && els.draft);
  const sirensOn = elsLive ? elsRunning(els.draft, els.preview) : switches.sirens;
  const muted = useMemo(() => new Set(lights?.muted || []), [lights?.muted]);
  const speed = Number.isFinite(lights?.speed) ? lights.speed : 1;
  const available = Boolean(modelLights?.available);
  const meshSirens = useMemo(() => new Set(modelLights?.sirens || []), [modelLights?.sirens]);
  const lampNames = modelLights?.lamps || [];
  const hasLamp = (prefix) => lampNames.some((name) => name.startsWith(prefix));
  const sirens = Array.isArray(setting?.sirens) ? setting.sirens : [];
  const bps = beatsPerSecond(setting);
  const patterns = useMemo(() => sirens.map((siren) => sequencerPattern(
    siren.flash ? siren.flashiness?.sequencer : siren.rotate ? siren.rotation?.sequencer : 0xffffffff,
  )), [sirens]);

  const setSwitch = (key, value) => onChange?.({ switches: { ...switches, [key]: value } });
  const toggleMute = (index) => {
    const next = new Set(muted);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    onChange?.({ muted: [...next].sort((a, b) => a - b) });
  };

  if (!available) {
    return (
      <section className="vl-root" aria-label="Lights">
        <header className="vl-head">
          <h3 className="vl-title">Lights</h3>
        </header>
        <p className="vl-muted">No emissive light meshes on this model. Lights preview needs a YFT whose lights use vehicle_lightsemissive.</p>
      </section>
    );
  }

  const sirenDisabledReason = !setting
    ? sirenStatus || "No siren setting for this model in the resource's carcols.meta."
    : meshSirens.size === 0
      ? "The model has no emissive meshes on sirenN bones."
      : "";
  const loopSeconds = bps > 0 ? SEQUENCER_STEPS / bps : 0;
  const hornHint = !ulc ? ""
    : !ulc.horn.enabled ? "useHorn is off in the ULC config. Turn on Horn in the ULC builder."
      : [ulc.horn.extras.length ? `ULC adds extra ${listExtras(ulc.horn.extras)}` : "", ulc.horn.disable.length ? `turns off ${listExtras(ulc.horn.disable)}` : ""]
        .filter(Boolean).join(", ") || "ULC lists no horn extras";

  return (
    <section className="vl-root" aria-label="Lights">
      <header className="vl-head">
        <h3 className="vl-title">Lights</h3>
        <span className="vl-count">
          {meshSirens.size} {meshSirens.size === 1 ? "siren" : "sirens"} · {lampNames.length} {lampNames.length === 1 ? "lamp" : "lamps"}
        </span>
      </header>

      <div className="vl-rows">
        {els && (els.draft || els.enabled) ? <ElsRows els={els} /> : null}
        {elsLive ? null : (
          <Row label="Sirens" hint={sirenDisabledReason || (setting?.name ? `${setting.name} · id ${setting.id}` : `id ${setting.id}`)}>
            <Toggle
              checked={switches.sirens && !sirenDisabledReason}
              onChange={(value) => setSwitch("sirens", value)}
              ariaLabel="Sirens"
              disabled={Boolean(sirenDisabledReason)}
              title={sirenDisabledReason || "Run the carcols siren pattern"}
            />
          </Row>
        )}
        {ulc?.park.enabled ? (
          <Row label="Vehicle" hint="ULC switches park and drive patterns">
            <Segmented label="Vehicle motion" options={MOTION_OPTIONS} value={extrasState?.motion || "drive"}
              onChange={(value) => onExtrasStateChange?.({ motion: value })} />
          </Row>
        ) : null}
        {ulc ? (
          <Row label="Horn" hint={hornHint}>
            <Toggle checked={switches.horn && ulc.horn.enabled} onChange={(value) => setSwitch("horn", value)} ariaLabel="Horn"
              disabled={!ulc.horn.enabled} title={ulc.horn.enabled ? "Hold the horn: ULC's horn extras" : hornHint} />
          </Row>
        ) : null}
        {hasLamp("headlight") || hasLamp("taillight") ? (
          <Row label="Headlights">
            <Segmented label="Headlights" options={HEADLIGHT_OPTIONS} value={switches.headlights} onChange={(value) => setSwitch("headlights", value)} />
          </Row>
        ) : null}
        {hasLamp("indicator") ? (
          <Row label="Indicators">
            <Segmented label="Indicators" options={INDICATOR_OPTIONS} value={switches.indicators} onChange={(value) => setSwitch("indicators", value)} />
          </Row>
        ) : null}
        {hasLamp("brakelight") || hasLamp("taillight") ? (
          <Row label="Brakes">
            <Toggle checked={switches.brakes} onChange={(value) => setSwitch("brakes", value)} ariaLabel="Brakes" />
          </Row>
        ) : null}
        {hasLamp("reversinglight") ? (
          <Row label="Reverse">
            <Toggle checked={switches.reverse} onChange={(value) => setSwitch("reverse", value)} ariaLabel="Reverse" />
          </Row>
        ) : null}
        {hasLamp("extralight") ? (
          <Row label="Extra lights">
            <Toggle checked={switches.extras} onChange={(value) => setSwitch("extras", value)} ariaLabel="Extra lights" />
          </Row>
        ) : null}
        <Row label="Night" hint="Dims the studio so emissives and light spill read as after dark">
          <Toggle checked={switches.night} onChange={(value) => setSwitch("night", value)} ariaLabel="Night" />
        </Row>
        <div className="vl-slider">
          <Slider id="vl-glow" label="Glow" value={Number.isFinite(lights?.glow) ? lights.glow : 1} min={0} max={2} step={0.05}
            format={(value) => (value === 0 ? "Off" : `${value.toFixed(2)}×`)} onChange={(value) => onChange?.({ glow: value })} />
        </div>
        {setting ? (
          <Row label="Light spill" hint="Siren colour on the ground and the body panels.">
            <Toggle checked={lights?.spill !== false} onChange={(value) => onChange?.({ spill: value })} ariaLabel="Light spill" />
          </Row>
        ) : null}
        {setting && lights?.spill !== false ? (
          <div className="vl-slider">
            <Slider id="vl-spill" label="Spill" value={Number.isFinite(lights?.spillStrength) ? lights.spillStrength : 1} min={0} max={3} step={0.05}
              format={(value) => (value === 0 ? "Off" : `${value.toFixed(2)}×`)} onChange={(value) => onChange?.({ spillStrength: value })} />
          </div>
        ) : null}
        {setting ? (
          <div className="vl-slider">
            <Slider id="vl-haze" label="Fog" value={Number.isFinite(lights?.haze) ? lights.haze : DEFAULT_HAZE} min={0} max={2} step={0.05}
              format={(value) => (value === 0 ? "Off" : `${Math.round(value * 100)}%`)} onChange={(value) => onChange?.({ haze: value })} />
          </div>
        ) : null}
      </div>

      {onExtrasStateChange ? (
        <ExtrasControls ulc={ulc} ulcPath={ulcPath} ulcError={ulcError} modelLights={modelLights}
          extrasPlan={extrasPlan} extrasState={extrasState} onExtrasStateChange={onExtrasStateChange} elsExtras={elsLive && sirensOn} />
      ) : null}

      {showPattern && setting && sirens.length > 0 ? (
        <div className="vl-pattern">
          <div className="vl-pattern-head">
            <span className="vl-subtitle">Pattern</span>
            <span className="vl-count">
              {Math.round((setting.sequencerBpm || 0) * (setting.timeMultiplier ?? 1))} bpm · {loopSeconds ? `${loopSeconds.toFixed(1)} s loop` : "no tempo"}
            </span>
          </div>
          <Segmented label="Playback speed" options={SPEED_OPTIONS} value={speed} onChange={(value) => onChange?.({ speed: value })} disabled={!sirensOn} />
          <div className="vl-grid" role="group" aria-label="Siren sequencers. Select a siren to mute it.">
            {sirens.map((siren, offset) => {
              const index = offset + 1;
              const isMuted = muted.has(index);
              const hasMesh = meshSirens.has(index);
              return (
                <button
                  key={index}
                  type="button"
                  className={cx("vl-siren", isMuted && "is-muted", !hasMesh && "is-unbound")}
                  aria-pressed={!isMuted}
                  onClick={() => toggleMute(index)}
                  title={`${sirenSummary(siren, index)}${hasMesh ? "" : " · no siren mesh on the model"}${isMuted ? " · muted" : ""}`}
                >
                  <span className="vl-siren-index">{index}</span>
                  <span className="vl-siren-swatch" style={{ background: siren.color || "#ffffff" }} aria-hidden="true" />
                  <span className="vl-steps" aria-hidden="true">
                    {patterns[offset].split("").map((bit, step) => (
                      <span key={step} className={cx("vl-step", bit === "1" && "is-on")} style={bit === "1" ? { background: siren.color || "#ffffff" } : undefined} />
                    ))}
                  </span>
                </button>
              );
            })}
            {sirensOn ? (
              <span className="vl-track" aria-hidden="true">
                <Playhead getTime={getTime} bps={bps} running={active && speed > 0} />
              </span>
            ) : null}
          </div>
          <p className="vl-muted">
            Timing, order and colours follow carcols exactly. Rotation speed, multiples and brightness are close approximations; the game's coronas and volumetrics are not reproduced.
          </p>
        </div>
      ) : null}
    </section>
  );
}
