const TAU = Math.PI * 2;

export const RECORDING_DEFAULT_FPS = 30;
export const RECORDING_MAX_SECONDS = 60;
export const RECORDING_MAX_EDGE = 4096;

export function normalizeRecordingFps(value) {
  const fps = Math.round(Number(value));
  return Number.isFinite(fps) && fps >= 1 ? Math.min(60, fps) : RECORDING_DEFAULT_FPS;
}

export function normalizeRecordingSize(width, height) {
  const even = (value) => {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number) || number < 16) return null;
    const capped = Math.min(RECORDING_MAX_EDGE, number);
    return capped - (capped % 2);
  };
  const w = even(width);
  const h = even(height);
  return w && h ? { width: w, height: h } : null;
}

export function planRecordingFrames({ fps = RECORDING_DEFAULT_FPS, seconds = 8, startYaw = 0, turns = 1, spin = true } = {}) {
  const rate = normalizeRecordingFps(fps);
  const length = Number(seconds);
  if (!Number.isFinite(length) || length <= 0) throw new Error("A recording needs a length in seconds above 0");
  const count = Math.max(1, Math.round(rate * Math.min(length, RECORDING_MAX_SECONDS)));
  const start = Number.isFinite(startYaw) ? startYaw : 0;
  const step = spin ? (TAU * (Number.isFinite(turns) ? turns : 1)) / count : 0;
  const clamp = (index) => Math.min(Math.max(0, Math.floor(index)), count - 1);
  return {
    fps: rate,
    count,
    intervalMs: 1000 / rate,
    step,
    yawAt: (index) => start + step * clamp(index),
    timeAt: (index) => clamp(index) / rate,
  };
}
