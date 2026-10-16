// Emergency and vehicle light simulation for the viewer. Pure and deterministic:
// given parsed carcols siren settings, the user's light switches and a time in
// seconds, it reports which lights are lit, how bright, which way each siren
// points and how far rotators have turned. The viewer owns the Three.js side.
//
// What follows the game exactly: the 32-bit sequencers are read most significant
// bit first, one bit per beat, at sequencerBpm x timeMultiplier beats per minute;
// colours are 0xAARRGGBB; vehicle_lightsemissive light ids come from the alpha of
// vertex colour 0. Approximations (no public decompile documents them): how
// `multiples` splits a beat, rotation speed units, unsynced `speed` timing, the
// indicator blink rate, and the brightness curve below.

export const VANILLA_SIREN_COUNT = 20;
export const MAX_SIREN_COUNT = 32;
export const SEQUENCER_STEPS = 32;

const LENS_HEX = /^#[0-9a-f]{6}$/i;

/**
 * Preview-only lens glow colours by siren number. In game a lens glows in its
 * emissive texture's colour whatever the carcols colour says; a tint shows it
 * recoloured: "siren" follows the siren's carcols colour, "#rrggbb" is a picked
 * colour. Sirens left out keep the texture's hue. Nothing here reaches a file.
 */
export function normalizeLensTints(value) {
  const tints = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return tints;
  for (const [key, tint] of Object.entries(value)) {
    const siren = Number(key);
    if (!Number.isInteger(siren) || siren < 1 || siren > MAX_SIREN_COUNT) continue;
    if (tint === "siren") tints[siren] = "siren";
    else if (typeof tint === "string" && LENS_HEX.test(tint)) tints[siren] = tint.toLowerCase();
  }
  return tints;
}

// Vertex colour0 alpha on vehicle_lightsemissive*. Id 0 is the game's default
// light (visualsettings `car.defaultlight`): on a sirenN bone the siren drives
// it, on an extra it is a steady burn, and anywhere else it burns whenever the
// vehicle runs, which is how running lights (DRLs), side markers and lit
// screens are built.
export const DEFAULT_LIGHT_NAME = "defaultlight";
export const LIGHT_ID_NAMES = Object.freeze({
  1: "headlight_l",
  2: "headlight_r",
  3: "taillight_l",
  4: "taillight_r",
  5: "indicator_lf",
  6: "indicator_rf",
  7: "indicator_lr",
  8: "indicator_rr",
  9: "brakelight_l",
  10: "brakelight_r",
  11: "brakelight_m",
  12: "reversinglight_l",
  13: "reversinglight_r",
  14: "extralight_1",
  15: "extralight_2",
  16: "extralight_3",
  17: "extralight_4",
});

// visualsettings.dat emissive values (day, night) for lit lamps.
const GAME_EMISSIVE = Object.freeze({
  siren: { day: 150, night: 150 },
  headlight: { day: 25, night: 15 },
  taillight: { day: 25, night: 25 },
  brakelight: { day: 45, night: 30 },
  indicator: { day: 10, night: 10 },
  reversinglight: { day: 20, night: 3 },
  extralight: { day: 15, night: 6 },
  always: { day: 15, night: 6 },
});

// Fallback lens colours for light meshes without a texture.
const LAMP_COLORS = Object.freeze({
  headlight: "#fff4e0",
  taillight: "#ff1a0a",
  brakelight: "#ff1a0a",
  indicator: "#ffa000",
  reversinglight: "#ffffff",
  extralight: "#ffffff",
  always: "#ffffff",
});

// Approximate indicator flash: on for half of a 0.75 s cycle.
const INDICATOR_PERIOD = 0.75;

/**
 * Maps the game's emissive values onto viewer emission strength. The game's
 * values span 3 to 150 in HDR units; the viewer compresses them so a siren
 * blooms while an indicator still reads as lit. Ratios keep their order.
 */
export function emissionStrength(gameValue) {
  if (!Number.isFinite(gameValue) || gameValue <= 0) return 0;
  return 0.65 * Math.log2(1 + gameValue / 4);
}

function lower(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/** Lamp family from a light name: "brakelight_l" -> "brakelight". */
export function lampKind(name) {
  const key = lower(name);
  if (/^headlight_/.test(key)) return "headlight";
  if (/^taillight_/.test(key)) return "taillight";
  if (/^brakelight_/.test(key)) return "brakelight";
  if (/^indicator_/.test(key)) return "indicator";
  if (/^reversinglight_/.test(key)) return "reversinglight";
  if (/^extralight_/.test(key)) return "extralight";
  if (key === DEFAULT_LIGHT_NAME) return "always";
  return null;
}

/**
 * Classifies one mesh from its manifest fields. Everything on a sirenN bone turns
 * with a rotator, but only emissive shaders light up: lamp lenses
 * (vehicle_vehglass), rotator mirrors (vehicle_mesh) and the breakable
 * siren_glassN covers share those bones without glowing.
 * Returns { kind: "siren", siren, lit } | { kind: "lamp", name, lamp } |
 * { kind: "steady", extra } | null.
 */
export function classifyLightMesh({ lightBone, lightId, shaderName, extraIndex } = {}) {
  const bone = lower(lightBone);
  const emissive = lower(shaderName).includes("emissive");
  const siren = /^siren(\d+)$/.exec(bone);
  if (siren) {
    const index = Number(siren[1]);
    return index >= 1 && index <= MAX_SIREN_COUNT ? { kind: "siren", siren: index, lit: emissive } : null;
  }
  if (!emissive || /^siren_glass\d+$/.test(bone)) return null;
  // The game picks the lamp from the vertex light id, not the bone: addon cars
  // put taillight-id geometry on brakelight bones and running lights (id 0) on
  // headlight bones. The bone only decides when the id is unknown.
  if (lower(shaderName).includes("lightsemissive") && Number.isInteger(lightId)) {
    // Id 0 on an extra is a steady-burn light (cruise, takedown, scene,
    // interior): it glows while its extra is switched on. Off an extra it is
    // the default light: DRLs, markers and screens that burn while the vehicle
    // runs. Its texture decides where it glows, so dark trim stays dark.
    if (lightId === 0) {
      return Number.isInteger(extraIndex)
        ? { kind: "steady", extra: extraIndex }
        : { kind: "lamp", name: DEFAULT_LIGHT_NAME, lamp: "always" };
    }
    const name = LIGHT_ID_NAMES[lightId];
    if (name) return { kind: "lamp", name, lamp: lampKind(name) };
  }
  if (bone && lampKind(bone)) return { kind: "lamp", name: bone, lamp: lampKind(bone) };
  return null;
}

/** True when `step` (0-31, wrapping) is lit in a 32-bit sequencer, MSB first. */
export function sequencerBit(sequencer, step) {
  const value = Number.isFinite(sequencer) ? sequencer >>> 0 : 0;
  const index = ((Math.floor(step) % SEQUENCER_STEPS) + SEQUENCER_STEPS) % SEQUENCER_STEPS;
  return ((value >>> (SEQUENCER_STEPS - 1 - index)) & 1) === 1;
}

/**
 * Sequencer output at a fractional beat. With multiples > 1 an on-beat splits
 * into that many equal flashes, each lit for the first half of its slot.
 */
export function sequencerOn(sequencer, multiples, beat) {
  if (!Number.isFinite(beat)) return false;
  if (!sequencerBit(sequencer, beat)) return false;
  const count = Math.max(1, Math.floor(finite(multiples, 1)));
  if (count === 1) return true;
  const fraction = beat - Math.floor(beat);
  return Math.floor(fraction * count * 2) % 2 === 0;
}

/** Beats per second for a siren setting: sequencerBpm x timeMultiplier / 60. */
export function beatsPerSecond(setting) {
  const bpm = finite(setting?.sequencerBpm, 0);
  const multiplier = finite(setting?.timeMultiplier, 1);
  return Math.max(0, (bpm * multiplier) / 60);
}

// Unsynced channels run their own beat from `speed`. Community testing matches an
// all-ones synced sequencer when speed = bpm / 100 x 16.
function unsyncedBeatsPerSecond(speed) {
  return Math.max(0, (finite(speed, 0) * 100) / 16 / 60);
}

function channelBeat(channel, time, syncedBps) {
  return channel?.syncToBpm === false ? time * unsyncedBeatsPerSecond(channel.speed) : time * syncedBps;
}

// Rotation rate: pi / 16 rad per second per speed unit, so a 600 bpm synced
// rotator (speed equivalent 96) turns about three times a second.
function rotationRate(channel, syncedBps) {
  const speed = channel?.syncToBpm === false ? finite(channel.speed, 0) : syncedBps * 60 / 100 * 16;
  return (speed * Math.PI) / 16;
}

/**
 * The heading a bone faces at rest, as a siren yaw, from its [x, y, z, w]
 * vehicle-space rotation: where its forward (+Y) axis points on the ground.
 */
export function boneHeading(rotation) {
  const [x, y, z, w] = Array.isArray(rotation) && rotation.length === 4 ? rotation : [0, 0, 0, 1];
  const yaw = Math.atan2(-2 * (x * y - w * z), 1 - 2 * (x * x + z * z));
  // atan2 reports a bone turned to pi as -pi, and an unturned one as -0; carcols writes pi and 0.
  return Math.abs(yaw + Math.PI) < 1e-6 ? Math.PI : yaw || 0;
}

/**
 * A siren's carcols heading, before any spin: a yaw about the vehicle's up
 * axis (0 front, +pi/2 left, pi rear) from the rotation delta for rotators and
 * the flashiness delta otherwise. The game turns the sirenN bone to this
 * heading, so it aims the light and turns the bone's meshes with it.
 */
export function sirenHeading(siren) {
  const rotation = siren?.rotation || {};
  return siren?.rotate
    ? finite(rotation.delta, 0)
    : finite(siren?.flashiness?.delta, finite(rotation.delta, 0));
}

/**
 * Evaluates every siren at `time` seconds.
 * Returns [{ siren, on, yaw, spin, color, alpha, intensity, ... }] in carcols order;
 * `siren` is the 1-based index matching the sirenN bone.
 */
export function evaluateSirens(setting, time) {
  const sirens = Array.isArray(setting?.sirens) ? setting.sirens : [];
  const bps = beatsPerSecond(setting);
  const t = finite(time, 0);
  return sirens.slice(0, MAX_SIREN_COUNT).map((siren, index) => {
    const flash = siren.flashiness || {};
    const rotation = siren.rotation || {};
    let on = true;
    if (siren.flash !== false) on = sequencerOn(flash.sequencer, flash.multiples, channelBeat(flash, t, bps));
    let spin = 0;
    if (siren.rotate) {
      on = on && sequencerOn(rotation.sequencer, rotation.multiples, channelBeat(rotation, t, bps));
      const direction = rotation.direction === false ? -1 : 1;
      spin = direction * (finite(rotation.start, 0) + rotationRate(rotation, bps) * t);
    }
    const yaw = sirenHeading(siren) + spin;
    return {
      siren: index + 1,
      on,
      yaw,
      spin,
      color: siren.color || "#ffffff",
      alpha: finite(siren.alpha, 1),
      intensity: finite(siren.intensity, 1),
      light: siren.light !== false,
      spotLight: siren.spotLight !== false,
      corona: siren.corona || null,
      rotate: Boolean(siren.rotate),
      // `scale` grows the siren bone's meshes while the siren is on; packs size
      // their LED geometry for this, so it is what fills a light head.
      scale: siren.scale && on ? sirenFlashScale(siren.scaleFactor) : 1,
    };
  });
}

/**
 * Size a `scale` siren's bone reaches while on. Pack authors shrink siren
 * emissives in their modelling tool by 1/scaleFactor about the siren dummy
 * (vanilla 0.5 with factor 2, packs 0.1 with 10); the game scales the bone back
 * up by scaleFactor while the siren is on, so the emitters land in their light
 * heads, and leaves them small and hidden while off. Emitters stored at a
 * fraction of their offset from the bone (front fascia lights packed onto a
 * lightbar siren) only reach their real position this way.
 */
export function sirenFlashScale(scaleFactor) {
  return Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
}

/** Wig-wag state of the four lamps carcols can flash while sirens run. */
export function evaluateLampSequencers(setting, time) {
  const bps = beatsPerSecond(setting);
  const beat = finite(time, 0) * bps;
  const out = {};
  for (const [name, key] of [
    ["headlight_l", "leftHeadLight"],
    ["headlight_r", "rightHeadLight"],
    ["taillight_l", "leftTailLight"],
    ["taillight_r", "rightTailLight"],
  ]) {
    const lamp = setting?.lamps?.[key];
    if (!lamp || !lamp.sequencer) continue;
    out[name] = sequencerOn(lamp.sequencer, lamp.multiples, beat);
  }
  return out;
}

export const DEFAULT_LIGHT_SWITCHES = Object.freeze({
  sirens: false,
  headlights: "off", // off | on | full
  brakes: false,
  reverse: false,
  indicators: "off", // off | left | right | hazard
  extras: false,
  horn: false,
  night: false,
});

// Fog over the siren preview (rig `haze`): beams along the lit spot lights.
export const DEFAULT_HAZE = 0.6;

export function normalizeLightSwitches(value) {
  const input = value && typeof value === "object" ? value : {};
  const pick = (key, allowed) => (allowed.includes(input[key]) ? input[key] : DEFAULT_LIGHT_SWITCHES[key]);
  return {
    sirens: Boolean(input.sirens),
    headlights: pick("headlights", ["off", "on", "full"]),
    brakes: Boolean(input.brakes),
    reverse: Boolean(input.reverse),
    indicators: pick("indicators", ["off", "left", "right", "hazard"]),
    extras: Boolean(input.extras),
    horn: Boolean(input.horn),
    night: Boolean(input.night),
  };
}

function lampOnFromSwitches(name, lamp, switches, time) {
  switch (lamp) {
    case "headlight":
      return switches.headlights !== "off";
    case "taillight":
      return switches.headlights !== "off" || switches.brakes;
    case "brakelight":
      return switches.brakes;
    case "reversinglight":
      return switches.reverse;
    case "extralight":
      return switches.extras;
    case "always":
      // The viewer has no engine switch: any lit lamp means the vehicle runs.
      return anyLightOn(switches);
    case "indicator": {
      const side = /_l[fr]$/.test(name) ? "left" : "right";
      const active = switches.indicators === "hazard" || switches.indicators === side;
      return active && (finite(time, 0) % INDICATOR_PERIOD) < INDICATOR_PERIOD / 2;
    }
    default:
      return false;
  }
}

/**
 * The full frame: lamp and siren states plus emission strength for each.
 * `setting` may be null when the model has no siren settings.
 * Returns { sirens: [...], lamps: { [name]: { on, strength, energy, color } }, steady: { strength, energy } }.
 * Sirens carry `energy` too: see the lamp note below.
 * `lampTime` clocks the indicator flash; it defaults to `time`, but siren
 * playback speed, pause and scrubbing must not hold an indicator lit.
 */
export function evaluateLights(setting, switchesInput, time, lampNames = [], lampTime = time) {
  const switches = normalizeLightSwitches(switchesInput);
  const period = switches.night ? "night" : "day";
  const sirenActive = switches.sirens && Boolean(setting);
  const sirenStrength = emissionStrength(GAME_EMISSIVE.siren[period]);
  const sirens = sirenActive
    ? evaluateSirens(setting, time).map((state) => ({
      ...state,
      strength: state.on ? sirenStrength : 0,
      energy: state.on ? GAME_EMISSIVE.siren.day : 0,
    }))
    : [];
  const wigwag = sirenActive ? evaluateLampSequencers(setting, time) : {};
  const lamps = {};
  for (const name of lampNames) {
    const lamp = lampKind(name);
    if (!lamp) continue;
    let on = lampOnFromSwitches(name, lamp, switches, lampTime);
    // Carcols lamp sequencers take over the head and tail lamps while sirens run.
    if (Object.prototype.hasOwnProperty.call(wigwag, name)) on = wigwag[name];
    let value = GAME_EMISSIVE[lamp][period];
    if (lamp === "taillight" && switches.brakes) value = GAME_EMISSIVE.brakelight[period];
    if (lamp === "headlight" && switches.headlights === "full") value *= 1.3;
    // `energy` is the game's HDR emissive (day value, so Night does not thin
    // the lens): lamp textures keep alpha low, and texel x alpha x energy is
    // what burns through. `strength` stays the compressed bloom level.
    let energy = GAME_EMISSIVE[lamp].day;
    if (lamp === "taillight" && switches.brakes) energy = GAME_EMISSIVE.brakelight.day;
    if (lamp === "headlight" && switches.headlights === "full") energy *= 1.3;
    lamps[name] = { on, strength: on ? emissionStrength(value) : 0, energy: on ? energy : 0, color: LAMP_COLORS[lamp] };
  }
  return {
    sirens,
    lamps,
    // Steady-burn extras glow at the game's default light level while shown.
    steady: { strength: emissionStrength(GAME_EMISSIVE.always[period]), energy: GAME_EMISSIVE.always.day },
    night: switches.night,
  };
}

/**
 * Siren-level emission for lights a script flashes by switching extras (ELS):
 * they are warning lights, so they glow like sirens, not like steady burns.
 */
export function sirenEmission(night = false) {
  return { strength: emissionStrength(GAME_EMISSIVE.siren[night ? "night" : "day"]), energy: GAME_EMISSIVE.siren.day };
}

/** True when any switch would light something. */
export function anyLightOn(switchesInput) {
  const s = normalizeLightSwitches(switchesInput);
  return s.sirens || s.headlights !== "off" || s.brakes || s.reverse || s.extras || s.indicators !== "off";
}

/**
 * What a loaded model can light: siren indices with emissive meshes, siren bones
 * from the skeleton, and lamp names. `natives` are mesh nativeMaterial records,
 * `lightBones` the manifest's light bones.
 */
export function summarizeVehicleLights(natives, lightBones = []) {
  const sirens = new Set();
  const lamps = new Set();
  // Per extra: the sirens it carries and whether it has steady-burn lights.
  const extras = {};
  const extraInfo = (index) => (extras[index] ||= { sirens: [], steady: false });
  for (const native of natives || []) {
    const light = classifyLightMesh(native || {});
    const extra = Number.isInteger(native?.extraIndex) ? native.extraIndex : null;
    if (light?.kind === "siren" && light.lit) {
      sirens.add(light.siren);
      if (extra != null && !extraInfo(extra).sirens.includes(light.siren)) extraInfo(extra).sirens.push(light.siren);
    } else if (light?.kind === "lamp") lamps.add(light.name);
    else if (light?.kind === "steady") extraInfo(light.extra).steady = true;
  }
  for (const info of Object.values(extras)) info.sirens.sort((a, b) => a - b);
  const boneNames = (lightBones || []).map((bone) => lower(bone?.name)).filter(Boolean);
  // Where each sirenN bone faces at rest. A new setting starts its sirens
  // there, so the game leaves their meshes where the model has them.
  const sirenHeadings = {};
  for (const bone of lightBones || []) {
    const index = /^siren(\d+)$/.exec(lower(bone?.name))?.[1];
    if (index) sirenHeadings[index] = boneHeading(bone.rotation);
  }
  const steady = Object.values(extras).some((info) => info.steady);
  return {
    sirens: [...sirens].sort((a, b) => a - b),
    lamps: [...lamps].sort(),
    extras,
    lightBones: boneNames,
    sirenHeadings,
    available: sirens.size > 0 || lamps.size > 0 || steady,
  };
}

/** True when any light is animating and the viewer must keep rendering frames. */
export function lightsAnimate(setting, switchesInput) {
  const switches = normalizeLightSwitches(switchesInput);
  return (switches.sirens && Boolean(setting?.sirens?.length)) || switches.indicators !== "off";
}

/** Formats a sequencer as 32 characters of 1/0, MSB first, for display. */
export function sequencerPattern(sequencer) {
  let out = "";
  for (let step = 0; step < SEQUENCER_STEPS; step += 1) out += sequencerBit(sequencer, step) ? "1" : "0";
  return out;
}
