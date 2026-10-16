import { Slider } from "./workspace/parts";
import "./MetaPanel.css";
import "./VehicleLightsPanel.css";

// Doors, bonnet, boot and convertible roof of the loaded vehicle. The viewer's
// rig owns the pose; `parts` mirrors where each part is heading. Sliders run
// from closed (0) to the joint's open limit (1); a two-sided joint such as a
// turret goes negative too.

function openFraction(part) {
  const span = part.open - part.rest;
  return Math.abs(span) < 1e-6 ? 0 : (part.value - part.rest) / span;
}

// The far end of a two-sided joint as a negative fraction; 0 for one-sided ones.
function closedEnd(part) {
  const other = part.open === part.max ? part.min : part.max;
  const span = part.open - part.rest;
  return Math.abs(span) < 1e-6 ? 0 : Math.min(0, (other - part.rest) / span);
}

function partValue(part, fraction) {
  return part.rest + fraction * (part.open - part.rest);
}

function isTwoSided(part) {
  return part.rest !== part.min && part.rest !== part.max;
}

function formatPart(part) {
  const twoSided = isTwoSided(part);
  return (fraction) => {
    if (Math.abs(fraction) < 0.005) return twoSided ? "Centred" : "Closed";
    const offset = partValue(part, fraction) - part.rest;
    const value = twoSided ? offset : Math.abs(offset);
    return part.kind === "rotation" ? `${Math.round((value * 180) / Math.PI)}°` : `${Math.round(value * 100)} cm`;
  };
}

function roofStatus(roofClip) {
  if (!roofClip) return null;
  if (roofClip.status === "loading") return { text: roofClip.dict ? `Loading ${roofClip.dict}…` : "Reading vehicles.meta…" };
  if (roofClip.status === "error") return { text: `Roof animation ${roofClip.dict}/${roofClip.clip} failed: ${roofClip.error}`, error: true };
  if (roofClip.status === "ready") {
    return { text: `${roofClip.dict}/${roofClip.clip} from ${roofClip.source === "resource" ? "this resource" : "the game files"}`, mono: true };
  }
  return null;
}

export default function VehiclePartsPanel({ parts, controls, roofClip }) {
  const list = parts?.parts || [];
  const roof = parts?.roof || null;
  const status = roofStatus(roofClip);
  if (!parts || (list.length === 0 && !roof && !status)) return null;
  const openable = list.filter((part) => !isTwoSided(part));
  const anyOpen = openable.some((part) => Math.abs(openFraction(part)) >= 0.005);
  const roofDown = (roof?.value ?? 0) > 0.5;

  return (
    <section className="vl-root" aria-label="Doors and roof">
      <header className="vl-head">
        <h3 className="vl-title">Doors{roof || status ? " & roof" : ""}</h3>
        {openable.length > 1 ? (
          <button type="button" className="mp-link" onClick={() => controls?.setAll(!anyOpen)}>
            {anyOpen ? "Close all" : "Open all"}
          </button>
        ) : null}
      </header>
      {list.length > 0 ? (
        <p className="vl-muted">Click a part on the model to open or close it. Hold Alt and drag to set an angle.</p>
      ) : null}
      {list.map((part) => (
        <Slider
          key={part.id}
          id={`vehicle-part-${part.id}`}
          label={part.label}
          value={openFraction(part)}
          min={closedEnd(part)}
          max={1}
          step={0.005}
          format={formatPart(part)}
          onChange={(fraction) => controls?.set(part.id, partValue(part, fraction), { animate: false })}
        />
      ))}
      {roof ? (
        <div className="vl-rows">
          <div className="vl-row">
            <div className="vl-row-text">
              <span className="vl-row-label">Roof</span>
              <span className="vl-row-hint">{roof.duration.toFixed(1)} s clip</span>
            </div>
            <div className="lv-seg vl-seg" role="radiogroup" aria-label="Roof">
              {[["up", "Up", false], ["down", "Down", true]].map(([key, label, down]) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={roofDown === down}
                  className={roofDown === down ? "lv-seg-btn is-on" : "lv-seg-btn"}
                  onClick={() => controls?.set("roof", down ? 1 : 0)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <Slider
            id="vehicle-part-roof"
            label="Roof position"
            value={roof.value}
            min={0}
            max={1}
            step={0.005}
            format={(value) => (value < 0.005 ? "Up" : value > 0.995 ? "Down" : `${Math.round(value * 100)}%`)}
            onChange={(value) => controls?.set("roof", value, { animate: false })}
          />
        </div>
      ) : null}
      {status ? (
        <p className={status.error ? "vl-muted vl-plate-error" : status.mono ? "vl-muted vl-extras-on" : "vl-muted"} role={status.error ? "alert" : undefined}>
          {status.text}
        </p>
      ) : null}
    </section>
  );
}
