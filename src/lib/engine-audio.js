import workletUrl from "./engine-worklet.js?worker&url";
import { encodeWav, engineRange, millibelsToGain, normalizeGrainTable, parseWav, withRpmOverride } from "./engine-grains.js";

export const POP_ROLES = Object.freeze(["exhaust_pops", "limiter_pop"]);
const TARGET_RMS = 0.11;
const STANDIN_POPS = 6;
const SHOT_LEVELS = Object.freeze({ dump_valve: 0.45, exhaust_pops: 0.9, limiter_pop: 0.9 });
const OTHER_SHOT_LEVEL = 0.8;
const MAX_SHOT_GAIN = 4;

let contextPromise = null;
let holders = 0;

export function holdAudioContext() {
  holders += 1;
}

export function releaseAudioContext() {
  holders = Math.max(0, holders - 1);
  if (holders > 0 || !contextPromise) return;
  contextPromise
    .then((context) => {
      if (holders === 0 && context.state === "running") return context.suspend();
      return undefined;
    })
    .catch(() => {});
}

export function sharedAudioContext() {
  if (!contextPromise) {
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) return Promise.reject(new Error("This window can't play audio."));
    const context = new AudioContextClass({ latencyHint: "interactive" });
    contextPromise = context.audioWorklet
      .addModule(workletUrl)
      .then(() => context)
      .catch((error) => {
        contextPromise = null;
        context.close().catch(() => {});
        throw new Error(`Studio audio didn't start: ${error?.message || error}`);
      });
  }
  return contextPromise;
}

function rms(samples, gain) {
  if (!samples.length) return 0;
  const step = Math.max(1, Math.floor(samples.length / 200000));
  let sum = 0;
  let count = 0;
  for (let index = 0; index < samples.length; index += step) {
    const value = samples[index] * gain;
    sum += value * value;
    count += 1;
  }
  return Math.sqrt(sum / Math.max(1, count));
}

export function volumeGain(volume) {
  const value = Math.min(1, Math.max(0, Number(volume) || 0));
  return value * value;
}

function activeRms(buffer) {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
  const block = Math.max(1, Math.round(buffer.sampleRate * 0.02));
  const powers = [];
  let top = 0;
  for (let start = 0; start < buffer.length; start += block) {
    const end = Math.min(buffer.length, start + block);
    let sum = 0;
    for (const data of channels) for (let index = start; index < end; index += 1) sum += data[index] * data[index];
    const power = sum / ((end - start) * channels.length);
    powers.push(power);
    if (power > top) top = power;
  }
  let sum = 0;
  let count = 0;
  for (const power of powers) {
    if (power <= top * 0.01) continue;
    sum += power;
    count += 1;
  }
  return count ? Math.sqrt(sum / count) : 0;
}

function levelShot(buffer, target) {
  const level = activeRms(buffer);
  if (!level) return;
  let peak = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    for (const value of buffer.getChannelData(channel)) peak = Math.max(peak, Math.abs(value));
  }
  const gain = Math.min(MAX_SHOT_GAIN, target / level, 0.98 / Math.max(peak, 1e-6));
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < data.length; index += 1) data[index] *= gain;
  }
}

function standInPops(context) {
  const rate = context.sampleRate;
  return Array.from({ length: STANDIN_POPS }, (_, variant) => {
    const length = Math.floor(rate * (0.07 + variant * 0.012));
    const buffer = context.createBuffer(1, length, rate);
    const data = buffer.getChannelData(0);
    let seed = 0x9e3779b9 ^ (variant * 7919);
    let low = 0;
    let body = 0;
    const tone = 55 + variant * 9;
    for (let index = 0; index < length; index += 1) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const noise = ((seed >>> 0) / 4294967296) * 2 - 1;
      const t = index / rate;
      const attack = Math.min(1, t / 0.0015);
      const envelope = attack * Math.exp(-t / (0.012 + variant * 0.002));
      low += (noise - low) * 0.22;
      body = Math.sin(2 * Math.PI * tone * t) * Math.exp(-t / 0.03);
      data[index] = (low * 0.9 * envelope + body * 0.55 * attack) * 0.9;
    }
    return buffer;
  });
}

async function loadSlot(context, preview, readFile) {
  const tables = {};
  const channels = {};
  let loudness = 0;
  for (const channel of preview.channels || []) {
    if (!channel.available || !channel.wav) continue;
    const wav = parseWav(await readFile(channel.wav));
    const table = normalizeGrainTable(channel.grains, wav.samples.length, channel.loops);
    if (!table.count) continue;
    const gain = millibelsToGain(channel.volume);
    tables[channel.role] = table;
    channels[channel.role] = { samples: wav.samples, sampleRate: wav.sampleRate, table, gain, bus: channel.outputBuffer === 1 ? 1 : 0 };
    if (channel.role.endsWith("_accel")) loudness = Math.max(loudness, rms(wav.samples, gain));
  }
  const range = withRpmOverride(engineRange(tables), preview.granular?.minRpmOverride, preview.granular?.maxRpmOverride);
  if (!range) throw new Error(`${preview.audioName} has no grains Studio can play.`);

  const shots = {};
  const packShots = {};
  for (const shot of preview.oneShots || []) {
    const buffers = [];
    for (const file of shot.files || []) {
      try {
        const bytes = await readFile(file);
        buffers.push(await context.decodeAudioData(bytes.slice(0)));
      } catch {
        continue;
      }
    }
    if (buffers.length) {
      shots[shot.role] = buffers;
      packShots[shot.role] = buffers.length;
    }
  }
  const standIn = !POP_ROLES.some((role) => shots[role]?.length);
  if (standIn) {
    const pops = standInPops(context);
    shots.exhaust_pops = pops;
    shots.limiter_pop = pops;
  } else {
    shots.exhaust_pops ||= shots.limiter_pop;
    shots.limiter_pop ||= shots.exhaust_pops;
  }
  const levelled = new Set();
  for (const [role, buffers] of Object.entries(shots)) {
    for (const buffer of buffers) {
      if (levelled.has(buffer)) continue;
      levelled.add(buffer);
      levelShot(buffer, TARGET_RMS * (SHOT_LEVELS[role] ?? OTHER_SHOT_LEVEL));
    }
  }

  const node = new AudioWorkletNode(context, "cortex-engine", { numberOfInputs: 0, numberOfOutputs: 2, outputChannelCount: [1, 1] });
  const engineBus = context.createGain();
  const exhaustBus = context.createGain();
  const level = context.createGain();
  node.connect(engineBus, 0);
  node.connect(exhaustBus, 1);
  engineBus.connect(level);
  exhaustBus.connect(level);
  const g = preview.granular || {};
  node.port.postMessage({
    type: "load",
    channels,
    range,
    limiter: {
      play: Math.max(1, Number(g.revLimiterGrainsToPlay) || 3),
      skip: Math.max(1, Number(g.revLimiterGrainsToSkip) || 2),
      cut: Math.min(1, Math.max(0, Number(g.revLimiterVolumeCut) || 0.2)),
    },
    seed: 7,
  });
  const normalize = loudness > 0 ? Math.min(6, TARGET_RMS / loudness) : 1;
  return {
    audioName: preview.audioName,
    node,
    engineBus,
    exhaustBus,
    level,
    normalize,
    range,
    shots,
    packShots,
    standIn,
    channels: Object.keys(channels),
  };
}

function releaseSlot(slot) {
  if (!slot) return;
  slot.node.port.postMessage({ type: "unload" });
  slot.node.disconnect();
  slot.engineBus.disconnect();
  slot.exhaustBus.disconnect();
  slot.level.disconnect();
}

export class EngineAudio {
  constructor() {
    this.context = null;
    this.slots = { a: null, b: null };
    this.active = "a";
    this.mix = { engine: 0.8, exhaust: 1, volume: 0.8 };
    this.recording = null;
    this.disposed = false;
    this.ready = null;
  }

  async ensure() {
    if (this.disposed) throw new Error("The engine audio was closed.");
    this.ready ||= this.createGraph().catch((error) => {
      this.ready = null;
      throw error;
    });
    const context = await this.ready;
    if (this.disposed) throw new Error("The engine audio was closed.");
    if (context.state === "suspended") await context.resume();
    return context;
  }

  async createGraph() {
    const context = await sharedAudioContext();
    if (this.disposed) throw new Error("The engine audio was closed.");
    this.context = context;
    holdAudioContext();
    this.master = context.createGain();
    this.limiter = context.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 4;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;
    this.recorder = new AudioWorkletNode(context, "cortex-recorder", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    this.popBus = context.createGain();
    this.popBus.connect(this.master);
    this.master.connect(this.limiter);
    this.limiter.connect(this.recorder);
    this.recorder.connect(context.destination);
    this.applyMix();
    return context;
  }

  async load(slotKey, preview, readFile) {
    const context = await this.ensure();
    const slot = await loadSlot(context, preview, readFile);
    if (this.disposed) {
      releaseSlot(slot);
      return null;
    }
    releaseSlot(this.slots[slotKey]);
    this.slots[slotKey] = slot;
    slot.level.connect(this.master);
    this.applyMix();
    return { range: slot.range, standIn: slot.standIn, packShots: slot.packShots, channels: slot.channels };
  }

  clear(slotKey) {
    releaseSlot(this.slots[slotKey]);
    this.slots[slotKey] = null;
  }

  select(slotKey) {
    this.active = slotKey;
    this.applyMix();
  }

  current() {
    return this.slots[this.active];
  }

  setMix(mix) {
    this.mix = { ...this.mix, ...mix };
    this.applyMix();
  }

  applyMix() {
    if (!this.context) return;
    const now = this.context.currentTime;
    this.master.gain.setTargetAtTime(volumeGain(this.mix.volume), now, 0.02);
    for (const [key, slot] of Object.entries(this.slots)) {
      if (!slot) continue;
      const on = key === this.active ? slot.normalize : 0;
      slot.level.gain.setTargetAtTime(on, now, 0.03);
      slot.engineBus.gain.setTargetAtTime(this.mix.engine, now, 0.02);
      slot.exhaustBus.gain.setTargetAtTime(this.mix.exhaust, now, 0.02);
    }
    this.popBus.gain.setTargetAtTime(this.mix.exhaust, now, 0.02);
  }

  control(control) {
    for (const [key, slot] of Object.entries(this.slots)) {
      if (!slot) continue;
      slot.node.port.postMessage({ type: "control", control: key === this.active ? control : { ...control, running: false } });
    }
  }

  play(role, { strength = 1, delay = 0, rate = 1, bang = false } = {}) {
    const slot = this.current();
    const buffers = slot?.shots[role];
    if (!this.context || !buffers?.length) return false;
    const source = this.context.createBufferSource();
    source.buffer = buffers[Math.floor(Math.random() * buffers.length)];
    const jitter = 0.94 + Math.random() * 0.12;
    source.playbackRate.value = rate * jitter * (bang ? 0.86 : 1);
    const gain = this.context.createGain();
    gain.gain.value = Math.min(2, strength * (bang ? 1.5 : 1));
    source.connect(gain);
    const target = POP_ROLES.includes(role) ? this.popBus : this.master;
    gain.connect(target);
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
    };
    source.start(this.context.currentTime + Math.max(0, delay));
    return true;
  }

  hasShot(role) {
    return Boolean(this.current()?.shots[role]?.length);
  }

  shotLength(role) {
    const buffers = this.current()?.shots[role];
    return buffers?.length ? buffers[0].duration : 0;
  }

  startRecording() {
    if (!this.recorder) return false;
    const chunks = { left: [], right: [] };
    this.recording = { chunks, done: null };
    this.recorder.port.onmessage = (event) => {
      const data = event.data || {};
      chunks.left.push(...(data.left || []));
      chunks.right.push(...(data.right || []));
      if (data.type === "done") this.recording?.done?.();
    };
    this.recorder.port.postMessage({ type: "start" });
    return true;
  }

  stopRecording() {
    const recording = this.recording;
    if (!recording || !this.recorder) return Promise.resolve(null);
    return new Promise((resolve) => {
      recording.done = () => {
        this.recording = null;
        this.recorder.port.onmessage = null;
        const join = (parts) => {
          const total = parts.reduce((sum, part) => sum + part.length, 0);
          const out = new Float32Array(total);
          let at = 0;
          for (const part of parts) {
            out.set(part, at);
            at += part.length;
          }
          return out;
        };
        const left = join(recording.chunks.left);
        const right = join(recording.chunks.right);
        resolve(left.length ? { wav: encodeWav([left, right], this.context.sampleRate), seconds: left.length / this.context.sampleRate } : null);
      };
      this.recorder.port.postMessage({ type: "stop" });
    });
  }

  dispose() {
    this.disposed = true;
    if (this.context) releaseAudioContext();
    for (const key of Object.keys(this.slots)) this.clear(key);
    if (this.recorder) this.recorder.port.onmessage = null;
    this.popBus?.disconnect();
    this.master?.disconnect();
    this.limiter?.disconnect();
    this.recorder?.disconnect();
  }
}
