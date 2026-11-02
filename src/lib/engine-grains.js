export const CHANNEL_ROLES = Object.freeze([
  "engine_accel",
  "exhaust_accel",
  "engine_decel",
  "exhaust_decel",
  "engine_idle",
  "exhaust_idle",
]);

export const RPM_PER_GRAIN_HZ = 120;

export function millibelsToGain(mb) {
  const value = Number(mb);
  return Number.isFinite(value) ? 10 ** (value / 2000) : 1;
}

export function normalizeGrainTable(grains, sampleCount, loops = []) {
  const total = Math.max(0, Math.floor(Number(sampleCount) || 0));
  const rows = (Array.isArray(grains) ? grains : [])
    .map((row, origin) => ({ start: Math.floor(Number(row?.[0])), pitch: Number(row?.[1]), origin }))
    .filter((row) => Number.isFinite(row.start) && Number.isFinite(row.pitch) && row.pitch > 0 && row.start >= 0 && row.start < total)
    .sort((a, b) => a.start - b.start);
  const unique = rows.filter((row, index) => index === 0 || row.start > rows[index - 1].start);
  const starts = new Uint32Array(unique.length);
  const lengths = new Uint32Array(unique.length);
  const pitches = new Float32Array(unique.length);
  unique.forEach((row, index) => {
    const end = index + 1 < unique.length ? unique[index + 1].start : Math.min(total, row.start + Math.round(lengthFromNeighbours(unique, index)));
    starts[index] = row.start;
    lengths[index] = Math.max(1, end - row.start);
    pitches[index] = row.pitch;
  });
  const usable = Array.from(lengths).findLastIndex((length, index) => starts[index] + length <= total) + 1;
  const count = Math.max(0, usable);
  const order = Array.from({ length: count }, (_, index) => index).sort((a, b) => pitches[a] - pitches[b]);
  let low = Infinity;
  let high = 0;
  for (let index = 0; index < count; index += 1) {
    low = Math.min(low, pitches[index]);
    high = Math.max(high, pitches[index]);
  }
  const remap = new Map(unique.slice(0, count).map((row, index) => [row.origin, index]));
  return {
    count,
    loops: normalizeLoops(loops, remap, pitches),
    starts: starts.subarray(0, count),
    lengths: lengths.subarray(0, count),
    pitches: pitches.subarray(0, count),
    byPitch: Uint32Array.from(order),
    pitchLow: count ? low : 0,
    pitchHigh: count ? high : 0,
  };
}

function normalizeLoops(loops, remap, pitches) {
  const result = [];
  for (const loop of Array.isArray(loops) ? loops : []) {
    const indices = (Array.isArray(loop) ? loop : []).map((origin) => remap.get(Number(origin))).filter((index) => index !== undefined);
    if (indices.length < 2) continue;
    let low = Infinity;
    let high = 0;
    for (const index of indices) {
      low = Math.min(low, pitches[index]);
      high = Math.max(high, pitches[index]);
    }
    result.push({ indices: Uint32Array.from(indices), low, high });
  }
  return result.sort((a, b) => a.low - b.low);
}

export function loopForPitch(table, pitch) {
  const loops = table.loops || [];
  let best = -1;
  let distance = Infinity;
  for (let index = 0; index < loops.length; index += 1) {
    const loop = loops[index];
    const gap = pitch < loop.low ? loop.low - pitch : pitch > loop.high ? pitch - loop.high : 0;
    if (gap < distance) {
      distance = gap;
      best = index;
    }
  }
  return best;
}

export function nextLoopGrain(table, loopIndex, current, pitch) {
  const indices = table.loops[loopIndex].indices;
  const at = current >= 0 ? indices.indexOf(current) : -1;
  if (at >= 0) return indices[(at + 1) % indices.length];
  let best = indices[0];
  for (const index of indices) {
    if (Math.abs(table.pitches[index] - pitch) < Math.abs(table.pitches[best] - pitch)) best = index;
  }
  return best;
}

function lengthFromNeighbours(rows, index) {
  const previous = index > 0 ? rows[index].start - rows[index - 1].start : 0;
  return previous > 0 ? previous : 1;
}

export function nearestGrainByPitch(table, pitch) {
  if (!table.count) return -1;
  const order = table.byPitch;
  let low = 0;
  let high = order.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (table.pitches[order[mid]] < pitch) low = mid + 1;
    else high = mid;
  }
  const after = order[low];
  const before = low > 0 ? order[low - 1] : after;
  return Math.abs(table.pitches[before] - pitch) <= Math.abs(table.pitches[after] - pitch) ? before : after;
}

export function chooseNextGrain(table, current, targetPitch, random, tolerance = 0.04) {
  if (!table.count) return -1;
  const next = current + 1;
  if (current >= 0 && next < table.count) {
    const drift = Math.abs(table.pitches[next] - targetPitch) / Math.max(1e-6, targetPitch);
    if (drift <= tolerance) return next;
  }
  const nearest = nearestGrainByPitch(table, targetPitch);
  const wander = Math.round((random() * 2 - 1) * 2);
  const candidate = Math.min(table.count - 1, Math.max(0, nearest + wander));
  const candidateDrift = Math.abs(table.pitches[candidate] - targetPitch) / Math.max(1e-6, targetPitch);
  return candidateDrift <= tolerance * 2 ? candidate : nearest;
}

export function crossfadeLength(grainLength, maxSamples = 384) {
  return Math.max(16, Math.min(maxSamples, Math.floor(grainLength * 0.5)));
}

export function pitchRange(tables) {
  let low = Infinity;
  let high = 0;
  for (const table of tables) {
    if (!table?.count) continue;
    low = Math.min(low, table.pitchLow);
    high = Math.max(high, table.pitchHigh);
  }
  return Number.isFinite(low) && high > low ? { low, high } : null;
}

export function idlePitch(table) {
  if (!table?.count) return 0;
  let sum = 0;
  for (let index = 0; index < table.count; index += 1) sum += table.pitches[index];
  return sum / table.count;
}

export function engineRange(tables) {
  const accel = pitchRange([tables.engine_accel, tables.exhaust_accel]) || pitchRange(Object.values(tables));
  if (!accel) return null;
  const idle = idlePitch(tables.engine_idle) || idlePitch(tables.exhaust_idle);
  const low = idle > 0 && idle < accel.high ? Math.min(idle, accel.high * 0.6) : accel.low;
  return {
    idlePitch: low,
    maxPitch: accel.high,
    idleRpm: roundRpm(low * RPM_PER_GRAIN_HZ),
    maxRpm: roundRpm(accel.high * RPM_PER_GRAIN_HZ),
  };
}

export function pitchForRev(range, rev) {
  const t = Math.min(1.02, Math.max(0, rev));
  return range.idlePitch + (range.maxPitch - range.idlePitch) * t;
}

export function rpmForRev(range, rev) {
  if (range.rpmOverride) return roundRpm(range.idleRpm + (range.maxRpm - range.idleRpm) * Math.min(1.02, Math.max(0, rev)));
  return roundRpm(pitchForRev(range, rev) * RPM_PER_GRAIN_HZ);
}

export function withRpmOverride(range, minRpm, maxRpm) {
  const low = Number(minRpm);
  const high = Number(maxRpm);
  if (!range || !(low > 0) || !(high > low)) return range;
  return { ...range, idleRpm: roundRpm(low), maxRpm: roundRpm(high), rpmOverride: true };
}

function roundRpm(value) {
  return Math.round(value / 50) * 50;
}

export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function parseWav(buffer) {
  const view = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer, buffer.byteOffset || 0, buffer.byteLength);
  const tag = (at) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
  if (view.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Not a WAV file.");
  let offset = 12;
  let format = null;
  while (offset + 8 <= view.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > view.byteLength && id !== "data") throw new Error("WAV chunk runs past the end of the file.");
    if (id === "fmt ") {
      format = {
        codec: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      if (!format) throw new Error("WAV data before its format.");
      if (format.codec !== 1 || format.bits !== 16 || format.channels < 1) throw new Error("Only 16-bit PCM WAV is supported.");
      const bytes = Math.min(size, view.byteLength - body);
      const frames = Math.floor(bytes / (2 * format.channels));
      const samples = new Float32Array(frames);
      for (let frame = 0; frame < frames; frame += 1) {
        let sum = 0;
        for (let channel = 0; channel < format.channels; channel += 1) {
          sum += view.getInt16(body + (frame * format.channels + channel) * 2, true);
        }
        samples[frame] = sum / (format.channels * 32768);
      }
      return { sampleRate: format.sampleRate, samples };
    }
    offset = body + size + (size & 1);
  }
  throw new Error("WAV has no data.");
}

export function encodeWav(channels, sampleRate) {
  const frames = channels[0]?.length || 0;
  const count = channels.length;
  const buffer = new ArrayBuffer(44 + frames * count * 2);
  const view = new DataView(buffer);
  const write = (at, text) => [...text].forEach((char, index) => view.setUint8(at + index, char.charCodeAt(0)));
  write(0, "RIFF");
  view.setUint32(4, 36 + frames * count * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, count, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * count * 2, true);
  view.setUint16(32, count * 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, frames * count * 2, true);
  let at = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < count; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channels[channel][frame]));
      view.setInt16(at, sample < 0 ? sample * 32768 : sample * 32767, true);
      at += 2;
    }
  }
  return new Uint8Array(buffer);
}
