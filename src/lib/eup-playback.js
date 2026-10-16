// EUP Studio clip playback: speed, loop and the paused frame, plus the clip
// time arithmetic the figures and the timeline share. Pure helpers for
// EupPage, usePedFigure and Node tests.
//
// Bridge clips are sampled across their duration with the last sample on the
// loop point (sampleRate = (samples - 1) / duration), so sampleClipPose at
// exactly `duration` wraps to the first frame. Holding at the end stops just
// short of it.

export const PLAYBACK_SPEEDS = Object.freeze([0.25, 0.5, 1, 2]);
const END_FRACTION = 1 - 1e-6;
const MAX_SAVED_TIME = 3600;

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor || 0;
}

/** The last time a clip can show without wrapping to its first frame. */
export function clipEndTime(duration) {
  return duration > 0 ? duration * END_FRACTION : 0;
}

/** `time` inside the clip: 0 for anything unusable, the end for anything past it. */
export function clampClipTime(time, duration) {
  if (!(duration > 0)) return 0;
  const number = Number(time);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(number, clipEndTime(duration));
}

/** Whether a clip with loop off has reached its last frame. */
export function isClipAtEnd(time, duration) {
  return duration > 0 && time >= clipEndTime(duration);
}

/**
 * The clip time after `dt` seconds. A looping clip wraps exactly as the
 * figures always have; with loop off it holds the last frame.
 */
export function advanceClipTime(time, dt, duration, loop = true) {
  if (!(duration > 0)) return 0;
  if (loop) return (time + dt) % duration;
  return Math.min(time + dt, clipEndTime(duration));
}

/** `{ frame, frames }` at `time`: the nearest sample and the last sample index. */
export function clipFrame(time, clip) {
  const samples = clip?.samples;
  const rate = clip?.sampleRate;
  if (!Number.isInteger(samples) || samples < 2 || !(rate > 0)) return { frame: 0, frames: 0 };
  const frames = samples - 1;
  const frame = Math.round((Number.isFinite(time) ? time : 0) * rate);
  return { frame: Math.min(frames, Math.max(0, frame)), frames };
}

/**
 * Saved playback: `{ speed, loop, paused, time }`. `time` is the frame the
 * clip was paused on; it only matters while paused. Missing or older
 * workspaces play at 1x, looping, from the start.
 */
export function normalizePlayback(value) {
  const source = value && typeof value === "object" ? value : {};
  const time = typeof source.time === "number" && Number.isFinite(source.time) && source.time > 0
    ? Math.min(source.time, MAX_SAVED_TIME)
    : 0;
  return {
    speed: PLAYBACK_SPEEDS.includes(source.speed) ? source.speed : 1,
    loop: source.loop !== false,
    paused: source.paused === true,
    time: round(time, 3),
  };
}

/** "0.42 s" style readout for a clip time. The no-break space keeps the
 *  unit with its figure when a narrow readout wraps. */
export function formatClipSeconds(seconds) {
  const value = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  return `${value.toFixed(2)}\u00a0s`;
}
