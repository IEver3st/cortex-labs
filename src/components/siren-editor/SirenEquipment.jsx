import { Toggle } from "../ui/toggle";

// The vehicle's equipment: every extra on the model with what it carries, on or
// off. A switch here is a manual override on top of what the lighting
// controller (or the siren geometry) turns on; Reset hands control back.

function carries(extra, lightExtras, ulc) {
  const button = ulc?.buttons?.find((entry) => entry.extra === extra);
  const info = lightExtras?.[extra];
  const parts = [];
  if (button?.label) parts.push(button.label);
  if (info?.sirens?.length) {
    const first = info.sirens[0];
    const last = info.sirens[info.sirens.length - 1];
    parts.push(first === last ? `siren ${first}` : `sirens ${first}-${last}`);
  } else if (info?.steady) parts.push("steady light");
  return parts.join(" · ") || "no lights";
}

export default function SirenEquipment({ s }) {
  const extras = [...new Set((s.metaModelInfo?.extras || []).map((extra) => extra.index))].sort((a, b) => a - b);
  if (!extras.length) return null;
  const lightExtras = s.metaModelInfo?.lights?.extras || {};
  const ulc = s.vehicleLights?.ulc || null;
  const on = new Set(s.extrasPlan?.on || []);
  const reasons = s.extrasPlan?.reasons || {};
  const overrides = s.extrasState?.overrides || {};
  const overridden = Object.keys(overrides).length;
  const toggle = (extra, value) => s.updateExtrasState?.({ overrides: { ...overrides, [extra]: value } });

  return (
    <section className="se-group se-equipment" aria-label="Equipment">
      <header className="se-group-head">
        <h4 className="cx-label">Equipment</h4>
        <span className="sw-meta">{on.size}/{extras.length} on</span>
        {overridden ? (
          <button type="button" className="cx-btn is-quiet lv-btn-sm" onClick={() => s.updateExtrasState?.({ overrides: {} })}
            title="Hand every extra back to the vehicle state">Reset</button>
        ) : null}
      </header>
      <ul className="se-equipment-list">
        {extras.map((extra) => (
          <li key={extra} className={on.has(extra) ? "is-on" : ""}>
            <span className="cx-display se-equipment-index">{extra}</span>
            <span className="se-equipment-text">
              <span className="se-equipment-label">{carries(extra, lightExtras, ulc)}</span>
              <span className="se-equipment-reason">{on.has(extra) ? reasons[extra] || "On" : extra in overrides ? "Off, manual" : "Off"}</span>
            </span>
            <Toggle checked={on.has(extra)} onChange={(value) => toggle(extra, value)} ariaLabel={`Extra ${extra}`} />
          </li>
        ))}
      </ul>
      <p className="se-note">Switching one here overrides the vehicle state until Reset.</p>
    </section>
  );
}
