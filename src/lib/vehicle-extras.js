// Which extras are on, from the vehicle's state. The vehicle spawns with every
// extra off; lighting scripts then switch extras as the vehicle drives, parks,
// brakes or reverses and as buttons are pressed. With a ULC config the rules are
// the config's own; without one, extras that carry siren geometry come on with
// the sirens. Manual toggles override everything. Pure and deterministic.

export const DEFAULT_EXTRAS_STATE = Object.freeze({
  motion: "drive", // drive | park
  buttons: [], // ULC button extras that are pressed
  overrides: {}, // { [extra]: boolean } manual toggles
});

export function normalizeExtrasState(value) {
  const input = value && typeof value === "object" ? value : {};
  const overrides = {};
  for (const [key, on] of Object.entries(input.overrides || {})) {
    const index = Number(key);
    if (Number.isInteger(index) && typeof on === "boolean") overrides[index] = on;
  }
  return {
    motion: input.motion === "park" ? "park" : "drive",
    buttons: (Array.isArray(input.buttons) ? input.buttons : []).filter(Number.isInteger),
    overrides,
  };
}

/**
 * Plans extras for one frame of vehicle state.
 * available: extra indices the model has.
 * lightExtras: { [extra]: { sirens: number[], steady: boolean } } from the model.
 * switches: the light switches (sirens, brakes, reverse, horn, headlights).
 * Returns { on: number[], reasons: { [extra]: string }, manual: number[] };
 * `manual` lists extras a manual toggle decides, on or off.
 */
export function planExtras({ available = [], ulc = null, lightExtras = {}, switches = {}, state } = {}) {
  const extrasState = normalizeExtrasState(state);
  const reasons = new Map();
  const on = (extra, reason) => { if (!reasons.has(extra)) reasons.set(extra, reason); };
  const off = (extra) => { reasons.delete(extra); };
  const sirens = Boolean(switches.sirens);

  if (ulc) {
    if (sirens) {
      if (ulc.park.enabled) {
        const parked = extrasState.motion === "park";
        for (const extra of parked ? ulc.park.parkExtras : ulc.park.driveExtras) on(extra, parked ? "Park pattern" : "Drive pattern");
      } else {
        for (const [extra, info] of Object.entries(lightExtras)) {
          if (info?.sirens?.length) on(Number(extra), "Siren lights");
        }
      }
    }
    if (ulc.steadyBurn.extras.length && (ulc.steadyBurn.forceOn || (switches.headlights && switches.headlights !== "off"))
      && !(ulc.steadyBurn.disableWithLights && sirens)) {
      for (const extra of ulc.steadyBurn.extras) on(extra, "Steady burn");
    }
    for (const [feature, active, label] of [
      [ulc.brake, switches.brakes, "Brakes"],
      [ulc.reverse, switches.reverse, "Reverse"],
      [ulc.horn, switches.horn, "Horn"],
    ]) {
      if (!feature.enabled || !active) continue;
      for (const extra of feature.extras) on(extra, label);
      for (const extra of feature.disable) off(extra);
    }
    // In press order: a later button's opposite/off extras switch earlier ones off.
    for (const extra of extrasState.buttons) {
      const button = ulc.buttons.find((entry) => entry.extra === extra);
      if (!button) continue;
      on(button.extra, button.label);
      for (const extra of button.linked) on(extra, button.label);
      for (const extra of [...button.off, ...button.opposite]) off(extra);
    }
  } else if (sirens) {
    for (const [extra, info] of Object.entries(lightExtras)) {
      if (info?.sirens?.length) on(Number(extra), "Siren lights");
    }
  }

  for (const [extra, value] of Object.entries(extrasState.overrides)) {
    if (value) reasons.set(Number(extra), "Manual");
    else reasons.delete(Number(extra));
  }

  const has = new Set(available);
  const result = [...reasons.keys()].filter((extra) => has.has(extra)).sort((a, b) => a - b);
  const manual = Object.keys(extrasState.overrides).map(Number).filter((extra) => has.has(extra)).sort((a, b) => a - b);
  return { on: result, reasons: Object.fromEntries(result.map((extra) => [extra, reasons.get(extra)])), manual };
}
