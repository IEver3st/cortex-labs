export const SPEED_PER_BPM = 0.16;
export const SYNCED_PERCENT = 100;

export const ROTATOR_STEPS = Object.freeze([
  { id: "slowest", label: "Slowest", percent: 6.25 },
  { id: "slow", label: "Slow", percent: 12.5 },
  { id: "fast", label: "Fast", percent: 25 },
  { id: "fastest", label: "Fastest", percent: 50 },
]);

export const STROBE_STEPS = Object.freeze([
  { id: "strobe", label: "Strobe", percent: 200 },
  { id: "short", label: "Short strobe", percent: 300 },
  { id: "flicker", label: "Flicker", percent: 400 },
]);

const PRECISION = 1e6;

const tidy = (value) => Math.round(value * PRECISION) / PRECISION;

export function baseSpeed(bpm) {
  return Number.isFinite(bpm) && bpm > 0 ? bpm * SPEED_PER_BPM : 0;
}

export function speedFromPercent(bpm, percent) {
  const speed = baseSpeed(bpm) * (Number.isFinite(percent) ? Math.max(0, percent) : 0) / 100;
  return Number.isFinite(speed) ? tidy(speed) : 0;
}

export function percentFromSpeed(bpm, speed) {
  const base = baseSpeed(bpm);
  if (!base) return null;
  return ((Number.isFinite(speed) ? speed : 0) / base) * 100;
}

export function isSynced(channel) {
  return channel?.syncToBpm !== false;
}

export function channelPercent(channel, bpm) {
  return isSynced(channel) ? SYNCED_PERCENT : percentFromSpeed(bpm, channel?.speed);
}

export function channelSpeedRatio(channel, bpm) {
  if (isSynced(channel)) return 1;
  const base = baseSpeed(bpm);
  if (!base) return 1;
  const speed = Number.isFinite(channel?.speed) ? channel.speed : 0;
  return Math.max(0, speed / base);
}

export function channelSpeedPatch(bpm, percent) {
  const synced = percent === SYNCED_PERCENT;
  if (!baseSpeed(bpm)) return { syncToBpm: synced };
  return { syncToBpm: synced, speed: speedFromPercent(bpm, percent) };
}

export function retimeChannel(channel, fromBpm, toBpm) {
  if (!channel || isSynced(channel) || !Number.isFinite(channel.speed)) return channel;
  const percent = percentFromSpeed(fromBpm, channel.speed);
  if (percent == null || !baseSpeed(toBpm)) return channel;
  const speed = speedFromPercent(toBpm, percent);
  return speed === channel.speed ? channel : { ...channel, speed };
}

export function retimeSirenSpeeds(setting, fromBpm, toBpm) {
  if (!setting) return setting;
  const current = setting.sirens || [];
  let changed = false;
  const sirens = current.map((light) => {
    const rotation = retimeChannel(light.rotation, fromBpm, toBpm);
    const flashiness = retimeChannel(light.flashiness, fromBpm, toBpm);
    if (rotation === light.rotation && flashiness === light.flashiness) return light;
    changed = true;
    return { ...light, rotation, flashiness };
  });
  return { ...setting, sequencerBpm: toBpm, sirens: changed ? sirens : current };
}
