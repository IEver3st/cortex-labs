export const GEAR_RATIOS = Object.freeze([3.4, 2.25, 1.65, 1.3, 1.05, 0.86]);
export const LIMITER_REV = 1;
export const LAUNCH_REV = 0.62;
export const SHIFT_TIME = 0.14;
const GEAR_PULL = 0.2;
const AUTO_ENGAGE_PEDAL = 0.6;
const AUTO_DOWNSHIFT_REV = 0.28;
const KICKDOWN_REV = 0.42;
const LUGGING_REV = 0.2;
const LIFTED_PEDAL = 0.15;
export const POP_STYLES = Object.freeze(["off", "pack", "crackle"]);

export function createEngineState() {
  return {
    running: false,
    rev: 0,
    throttle: 0,
    fuel: 1,
    gear: 0,
    shift: null,
    limiter: false,
    launch: false,
    wobble: 0,
    wobbleTime: 0,
    peakThrottle: 0,
    peakRev: 0,
    nextLimiterPop: 0,
    nextLaunchBang: 0,
    time: 0,
  };
}

export function stepEngine(previous, input, dt, random) {
  const s = { ...previous, time: previous.time + dt };
  const events = [];
  if (!s.running) {
    s.rev = Math.max(0, s.rev - dt * 2);
    s.throttle = 0;
    return { state: s, events, control: controlFor(s) };
  }

  const pedal = clamp01(input.throttle);
  s.throttle += (pedal - s.throttle) * Math.min(1, dt * 14);
  s.launch = Boolean(input.brake) && pedal > 0.5 && s.gear <= 1;

  if (input.shiftUp && s.gear < GEAR_RATIOS.length && !s.shift) beginShift(s, s.gear + 1, events);
  if (input.shiftDown && s.gear > 0 && !s.shift) beginShift(s, s.gear - 1, events);
  if (input.auto && !s.shift) autoShift(s, pedal, Boolean(input.brake), events);

  if (s.shift) {
    s.shift.left -= dt;
    const t = 1 - Math.max(0, s.shift.left) / SHIFT_TIME;
    s.rev = s.shift.from + (s.shift.to - s.shift.from) * easeOut(t);
    s.fuel = 0.15;
    if (s.shift.left <= 0) {
      s.gear = s.shift.gear;
      s.shift = null;
      s.wobble = 1;
      s.wobbleTime = 0;
    }
  } else {
    const ceiling = s.launch ? LAUNCH_REV : LIMITER_REV;
    const cutting = s.rev >= ceiling - 0.005 || (s.limiter && s.rev > ceiling - 0.035);
    s.limiter = pedal > 0.4 && cutting;
    s.fuel = s.limiter ? 0 : 1;
    const drive = s.throttle * s.fuel;
    const load = s.gear === 0 || s.launch ? 1 : GEAR_RATIOS[s.gear - 1] / GEAR_RATIOS[0];
    const rise = s.gear === 0 || s.launch ? 2.4 * (1 - s.rev * 0.3) : 1.35 * GEAR_PULL * load * (1 - s.rev * 0.25);
    const fall = s.gear === 0 || s.launch ? 1.5 * (0.35 + s.rev) : 0.32 * (0.4 + s.rev) * Math.max(0.35, load);
    const braking = input.brake && s.gear > 0 && !s.launch ? 1.1 : 0;
    const coast = s.gear === 0 || s.launch ? 1 - drive : (1 - drive) ** 3;
    s.rev += (drive * rise - coast * fall - braking) * dt;
    s.rev = Math.min(ceiling + 0.006, Math.max(0, s.rev));
  }

  if (s.wobble > 0) {
    s.wobbleTime += dt;
    s.wobble = Math.max(0, s.wobble - dt * 3.2);
  }

  if (s.limiter && !s.launch && input.pops !== "off" && s.time >= s.nextLimiterPop) {
    events.push({ type: "pop", set: "limiter_pop", strength: 0.55 + random() * 0.35 });
    s.nextLimiterPop = s.time + 0.09 + random() * 0.32;
  }
  if (s.launch && s.limiter && input.pops !== "off" && s.time >= s.nextLaunchBang) {
    events.push({ type: "pop", set: "exhaust_pops", strength: 0.75 + random() * 0.25, bang: true });
    s.nextLaunchBang = s.time + 0.07 + random() * 0.11;
  }

  s.peakThrottle = Math.max(pedal, s.peakThrottle - dt * 2.5);
  s.peakRev = Math.max(s.rev, s.peakRev - dt * 1.2);
  const lifted = pedal < 0.12 && s.peakThrottle > 0.65 && s.peakRev > 0.5;
  if (lifted && input.pops !== "off" && !s.crackleArmed) {
    s.crackleArmed = true;
    const count = input.pops === "crackle" ? 6 + Math.floor(random() * 8) : 2 + Math.floor(random() * 4);
    let delay = 0.05 + random() * 0.08;
    for (let i = 0; i < count; i += 1) {
      const decay = 1 - i / (count + 1);
      events.push({ type: "pop", set: "exhaust_pops", strength: (0.45 + random() * 0.5) * decay * Math.min(1, s.peakRev + 0.2), delay });
      delay += 0.035 + random() * (input.pops === "crackle" ? 0.13 : 0.2);
    }
  }
  if (pedal > 0.5) s.crackleArmed = false;

  return { state: s, events, control: controlFor(s) };
}

function autoShift(s, pedal, brake, events) {
  if (s.gear === 0) {
    if (pedal > AUTO_ENGAGE_PEDAL && !brake) beginShift(s, 1, events);
    return;
  }
  if (s.gear < GEAR_RATIOS.length && pedal > LIFTED_PEDAL && s.rev >= 0.4 + 0.57 * pedal) {
    beginShift(s, s.gear + 1, events);
    return;
  }
  if (s.gear < 2) return;
  const lower = (s.rev * GEAR_RATIOS[s.gear - 2]) / GEAR_RATIOS[s.gear - 1];
  const coasting = pedal <= LIFTED_PEDAL && s.rev < AUTO_DOWNSHIFT_REV;
  const kickdown = pedal > 0.9 && s.rev < KICKDOWN_REV;
  const lugging = s.rev < LUGGING_REV;
  if ((coasting || kickdown || lugging) && lower < 0.85) beginShift(s, s.gear - 1, events);
}

function beginShift(s, gear, events) {
  const fromRatio = s.gear === 0 ? GEAR_RATIOS[0] : GEAR_RATIOS[s.gear - 1];
  const toRatio = gear === 0 ? fromRatio : GEAR_RATIOS[gear - 1];
  const to = gear === 0 || s.gear === 0 ? s.rev : Math.max(0.05, Math.min(LIMITER_REV, s.rev * (toRatio / fromRatio)));
  s.shift = { gear, from: s.rev, to, left: SHIFT_TIME };
  events.push({ type: "shift", gear, up: gear > s.gear });
}

function controlFor(s) {
  const idle = s.running ? clamp01(1 - s.rev / 0.12) * (1 - s.throttle) : 0;
  const pitchMod = s.wobble > 0 ? Math.sin(s.wobbleTime * 38) * 0.012 * s.wobble : 0;
  return {
    running: s.running,
    rev: s.rev,
    throttle: s.throttle,
    fuel: s.fuel,
    idle,
    limiter: s.limiter,
    pitchMod,
  };
}

function easeOut(t) {
  const x = clamp01(t);
  return 1 - (1 - x) * (1 - x);
}

function clamp01(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0;
}
