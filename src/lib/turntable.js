/* Vehicle turntable for the viewer stages: the vehicle turns about its own
   centre on the floor while the camera, lights and stage stay put, so the
   studio's highlights sweep across the paint. Switching it off eases the
   vehicle back to its resting yaw so camera presets keep their meaning. */

export const TURNTABLE_MIN_SPEED = 2;
export const TURNTABLE_MAX_SPEED = 90;
export const TURNTABLE_DEFAULT_SPEED = 20;

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
// Longest step one frame may take; a tab coming back from the background
// resumes where it was instead of jumping.
const MAX_STEP_SECONDS = 0.1;
// Time constant of the ease home, in seconds.
const HOME_EASE = 0.16;
// Within this of rest (radians) the vehicle snaps home.
const HOME_EPSILON = 1e-3;

/** Degrees per second, clamped; anything unreadable is the default. */
export function normalizeTurntableSpeed(value) {
  const speed = Number(value);
  if (!Number.isFinite(speed)) return TURNTABLE_DEFAULT_SPEED;
  return Math.min(TURNTABLE_MAX_SPEED, Math.max(TURNTABLE_MIN_SPEED, speed));
}

/** `yaw` wrapped into (-PI, PI]. */
export function wrapYaw(yaw) {
  if (!Number.isFinite(yaw)) return 0;
  const wrapped = ((yaw + Math.PI) % TAU + TAU) % TAU - Math.PI;
  return wrapped === -Math.PI ? Math.PI : wrapped;
}

/**
 * Advances a turntable by `seconds`: spinning at `speed` degrees per second
 * while `on`, otherwise easing home the short way. Returns { yaw, moving };
 * `moving` is false once the vehicle rests, so the render loop can idle.
 */
export function stepTurntable(yaw, { on = false, speed = TURNTABLE_DEFAULT_SPEED, seconds = 0 } = {}) {
  const dt = Number.isFinite(seconds) ? Math.min(MAX_STEP_SECONDS, Math.max(0, seconds)) : 0;
  if (on) return { yaw: wrapYaw(yaw + dt * normalizeTurntableSpeed(speed) * DEG), moving: true };
  const home = wrapYaw(yaw) * Math.exp(-dt / HOME_EASE);
  if (Math.abs(home) < HOME_EPSILON) return { yaw: 0, moving: false };
  return { yaw: home, moving: true };
}

/**
 * Runs `run` with every turntable group (rotation.y) at rest and world
 * matrices to match, then puts them back. For measuring a vehicle's own
 * bounds or rendering a named camera preset while it spins.
 */
export function withTurntableAtRest(groups, run) {
  const list = (Array.isArray(groups) ? groups : [groups]).filter((group) => group && group.rotation.y !== 0);
  if (!list.length) return run();
  const saved = list.map((group) => group.rotation.y);
  for (const group of list) {
    group.rotation.y = 0;
    group.updateMatrixWorld(true);
  }
  try {
    return run();
  } finally {
    list.forEach((group, index) => {
      group.rotation.y = saved[index];
      group.updateMatrixWorld(true);
    });
  }
}
