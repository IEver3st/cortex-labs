import { holdAudioContext, releaseAudioContext, sharedAudioContext, volumeGain } from "./engine-audio.js";
import { encodeWav } from "./engine-grains.js";

const SWITCH_FADE = 0.012;
const PREVIEW_TRIM = 0.37;
const SPEED_OF_SOUND = 343;
const DRIVE_BY_LANE = 6;
const DRIVE_BY_SPAN = 140;

const SCENES = {
  street: { cutoff: 16000, gain: 1, wet: 0.16, pan: 0 },
  cabin: { cutoff: 1600, gain: 0.55, wet: 0.05, pan: 0 },
  far: { cutoff: 3400, gain: 0.22, wet: 0.42, pan: 0.35 },
};

function cityImpulse(context) {
  const seconds = 1.8;
  const length = Math.floor(context.sampleRate * seconds);
  const buffer = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    let seed = channel ? 0x9e3779b9 : 0x85ebca6b;
    for (let index = 0; index < length; index += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const noise = seed / 2147483648 - 1;
      const t = index / context.sampleRate;
      const echo = (t > 0.09 && t < 0.1) || (t > 0.23 && t < 0.235) ? 3 : 1;
      data[index] = noise * echo * Math.exp(-t * 3.2) * 0.5;
    }
  }
  return buffer;
}

function bufferFromSamples(context, samples, sampleRate) {
  const buffer = context.createBuffer(1, samples.length, sampleRate);
  buffer.copyToChannel(samples, 0);
  return buffer;
}

function driveByCurves(speedKmh, steps) {
  const speed = Math.max(5, speedKmh) / 3.6;
  const duration = DRIVE_BY_SPAN / speed;
  const rate = new Float32Array(steps);
  const gain = new Float32Array(steps);
  const pan = new Float32Array(steps);
  const cutoff = new Float32Array(steps);
  for (let index = 0; index < steps; index += 1) {
    const t = (index / (steps - 1)) * duration;
    const x = -DRIVE_BY_SPAN / 2 + speed * t;
    const distance = Math.hypot(x, DRIVE_BY_LANE);
    const radial = (-x / distance) * speed;
    rate[index] = SPEED_OF_SOUND / (SPEED_OF_SOUND - radial);
    gain[index] = Math.min(1, DRIVE_BY_LANE / distance) ** 1.15;
    pan[index] = Math.max(-0.95, Math.min(0.95, x / (distance + 4)));
    cutoff[index] = Math.max(1800, 17000 * Math.exp(-distance / 45));
  }
  return { duration, rate, gain, pan, cutoff };
}

export class SirenAudio {
  constructor() {
    this.context = null;
    this.buffers = new Map();
    this.levels = new Map();
    this.voice = null;
    this.rumble = null;
    this.horn = null;
    this.manual = null;
    this.scene = "street";
    this.rumbler = false;
    this.volume = 0.8;
    this.driveBy = null;
    this.recording = null;
    this.disposed = false;
    this.ready = null;
    this.frame = null;
  }

  async ensure() {
    if (this.disposed) throw new Error("The siren audio was closed.");
    this.ready ||= this.createGraph().catch((error) => {
      this.ready = null;
      throw error;
    });
    const context = await this.ready;
    if (this.disposed) throw new Error("The siren audio was closed.");
    if (context.state === "suspended") await context.resume();
    return context;
  }

  async createGraph() {
    const context = await sharedAudioContext();
    if (this.disposed) throw new Error("The siren audio was closed.");
    this.context = context;
    holdAudioContext();
    this.voiceBus = context.createGain();
    this.rateless = context.createGain();
    this.panner = context.createStereoPanner();
    this.filter = context.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.Q.value = 0.5;
    this.distance = context.createGain();
    this.dry = context.createGain();
    this.wet = context.createGain();
    this.reverb = context.createConvolver();
    this.reverb.buffer = cityImpulse(context);
    this.rumbleBus = context.createGain();
    this.rumbleFilter = context.createBiquadFilter();
    this.rumbleFilter.type = "lowpass";
    this.rumbleFilter.frequency.value = 160;
    this.master = context.createGain();
    this.limiter = context.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.ratio.value = 10;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.15;
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 2048;
    this.recorder = new AudioWorkletNode(context, "cortex-recorder", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    this.voiceBus.connect(this.panner);
    this.rateless.connect(this.panner);
    this.panner.connect(this.filter);
    this.filter.connect(this.distance);
    this.distance.connect(this.dry);
    this.distance.connect(this.wet);
    this.distance.connect(this.analyser);
    this.wet.connect(this.reverb);
    this.reverb.connect(this.master);
    this.dry.connect(this.master);
    this.rumbleBus.connect(this.rumbleFilter);
    this.rumbleFilter.connect(this.distance);
    this.master.connect(this.limiter);
    this.limiter.connect(this.recorder);
    this.recorder.connect(context.destination);
    this.frame = new Float32Array(this.analyser.fftSize);
    this.applyScene(0);
    return context;
  }

  async load(key, samples, sampleRate, level = 1) {
    const context = await this.ensure();
    if (!this.buffers.has(key)) {
      this.buffers.set(key, bufferFromSamples(context, samples, sampleRate));
      this.levels.set(key, level);
    }
    return this.buffers.get(key);
  }

  has(key) {
    return this.buffers.has(key);
  }

  forget(key) {
    this.buffers.delete(key);
    this.levels.delete(key);
  }

  startSource(buffer, destination, { loop = true, rate = 1, level = 1 } = {}) {
    const context = this.context;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    const gain = context.createGain();
    const now = context.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(level, now + SWITCH_FADE);
    source.connect(gain);
    gain.connect(destination);
    this.applyDopplerTo(source, rate);
    source.start(now);
    return { source, gain, buffer, rate, level };
  }

  stopVoice(voice) {
    if (!voice || !this.context) return;
    const now = this.context.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.linearRampToValueAtTime(0, now + SWITCH_FADE);
    try {
      voice.source.stop(now + SWITCH_FADE + 0.01);
    } catch {
      voice.source.disconnect();
    }
  }

  async setTone(key, { loop = true } = {}) {
    await this.ensure();
    const buffer = key ? this.buffers.get(key) : null;
    this.stopVoice(this.voice);
    this.stopVoice(this.rumble);
    this.voice = null;
    this.rumble = null;
    if (!buffer) return false;
    const level = this.levels.get(key) ?? 1;
    this.voice = this.startSource(buffer, this.voiceBus, { loop, level });
    this.voice.key = key;
    if (this.rumbler) {
      this.rumble = this.startSource(buffer, this.rumbleBus, { loop, rate: 0.25, level });
      this.rumbleBus.gain.value = 1.6;
    }
    return true;
  }

  currentTone() {
    return this.voice?.key || null;
  }

  setRumbler(on) {
    this.rumbler = Boolean(on);
    if (!this.context) return;
    if (!this.rumbler) {
      this.stopVoice(this.rumble);
      this.rumble = null;
    } else if (this.voice && !this.rumble) {
      this.rumble = this.startSource(this.voice.buffer, this.rumbleBus, { loop: this.voice.source.loop, rate: 0.25, level: this.voice.level });
      this.rumbleBus.gain.value = 1.6;
    }
  }

  async hornDown(key) {
    await this.ensure();
    if (this.horn) return;
    const buffer = key ? this.buffers.get(key) : null;
    if (buffer) {
      this.horn = this.startSource(buffer, this.voiceBus, { loop: true, level: this.levels.get(key) ?? 1 });
      return;
    }
    const context = this.context;
    const gain = context.createGain();
    const shape = context.createBiquadFilter();
    shape.type = "lowpass";
    shape.frequency.value = 2400;
    const oscillators = [349, 440, 523].map((frequency) => {
      const osc = context.createOscillator();
      osc.type = "square";
      osc.frequency.value = frequency;
      osc.connect(shape);
      osc.start();
      return osc;
    });
    shape.connect(gain);
    gain.connect(this.voiceBus);
    const now = context.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.16, now + 0.02);
    this.horn = { oscillators, gain, synth: true };
  }

  hornUp() {
    const horn = this.horn;
    this.horn = null;
    if (!horn || !this.context) return;
    if (!horn.synth) {
      this.stopVoice(horn);
      return;
    }
    const now = this.context.currentTime;
    horn.gain.gain.cancelScheduledValues(now);
    horn.gain.gain.setValueAtTime(horn.gain.gain.value, now);
    horn.gain.gain.linearRampToValueAtTime(0, now + 0.04);
    for (const osc of horn.oscillators) osc.stop(now + 0.06);
  }

  async manualDown() {
    await this.ensure();
    const context = this.context;
    const now = context.currentTime;
    if (!this.manual) {
      const osc = context.createOscillator();
      osc.type = "sawtooth";
      const shape = context.createBiquadFilter();
      shape.type = "bandpass";
      shape.Q.value = 0.7;
      const gain = context.createGain();
      osc.frequency.setValueAtTime(220, now);
      shape.frequency.setValueAtTime(900, now);
      gain.gain.setValueAtTime(0, now);
      osc.connect(shape);
      shape.connect(gain);
      gain.connect(this.rateless);
      osc.start(now);
      this.manual = { osc, shape, gain };
    }
    const { osc, shape, gain } = this.manual;
    for (const param of [osc.frequency, shape.frequency, gain.gain]) {
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
    }
    osc.frequency.setTargetAtTime(1350, now, 0.9);
    shape.frequency.setTargetAtTime(1600, now, 0.9);
    gain.gain.setTargetAtTime(0.2, now, 0.08);
  }

  manualUp() {
    if (!this.manual || !this.context) return;
    const { osc, shape, gain } = this.manual;
    const now = this.context.currentTime;
    for (const param of [osc.frequency, shape.frequency, gain.gain]) {
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
    }
    osc.frequency.setTargetAtTime(180, now, 1.1);
    shape.frequency.setTargetAtTime(700, now, 1.1);
    gain.gain.setTargetAtTime(0, now + 1.2, 0.6);
    const manual = this.manual;
    clearTimeout(manual.timer);
    manual.timer = setTimeout(() => {
      if (this.manual !== manual) return;
      osc.stop();
      osc.disconnect();
      this.manual = null;
    }, 6000);
  }

  stopAll() {
    this.stopVoice(this.voice);
    this.stopVoice(this.rumble);
    this.voice = null;
    this.rumble = null;
    this.hornUp();
    if (this.manual) {
      clearTimeout(this.manual.timer);
      try {
        this.manual.osc.stop();
      } catch {
        this.manual.osc.disconnect();
      }
      this.manual = null;
    }
  }

  setVolume(volume) {
    this.volume = Math.max(0, Math.min(1, Number(volume) || 0));
    if (this.master) this.master.gain.setTargetAtTime(this.outputGain(), this.context.currentTime, 0.03);
  }

  setScene(scene) {
    this.scene = SCENES[scene] ? scene : "street";
    if (this.context && !this.driveBy) this.applyScene(0.08);
  }

  applyScene(ramp) {
    const scene = SCENES[this.scene];
    const now = this.context.currentTime;
    const set = (param, value) => {
      param.cancelScheduledValues(now);
      if (ramp > 0) param.setTargetAtTime(value, now, ramp / 3);
      else param.setValueAtTime(value, now);
    };
    set(this.filter.frequency, scene.cutoff);
    set(this.distance.gain, scene.gain);
    set(this.wet.gain, scene.wet);
    set(this.dry.gain, 1);
    set(this.panner.pan, scene.pan);
    set(this.master.gain, this.outputGain());
  }

  outputGain() {
    return volumeGain(this.volume) * PREVIEW_TRIM;
  }

  applyDopplerTo(source, base) {
    const drive = this.driveBy;
    const now = this.context.currentTime;
    source.playbackRate.setValueAtTime(base, now);
    if (!drive) return;
    const elapsed = now - drive.start;
    if (elapsed >= drive.duration) return;
    const steps = drive.rate.length;
    const from = Math.min(steps - 2, Math.floor((elapsed / drive.duration) * (steps - 1)));
    const rest = drive.rate.slice(from).map((value) => value * base);
    source.playbackRate.setValueCurveAtTime(rest, now, Math.max(0.05, drive.duration - elapsed));
  }

  async startDriveBy(speedKmh = 90) {
    await this.ensure();
    const context = this.context;
    const steps = 256;
    const curves = driveByCurves(speedKmh, steps);
    const now = context.currentTime + 0.02;
    this.driveBy = { ...curves, start: now };
    const params = [
      [this.distance.gain, curves.gain],
      [this.panner.pan, curves.pan],
      [this.filter.frequency, curves.cutoff],
      [this.wet.gain, curves.gain.map((value) => 0.1 + (1 - value) * 0.45)],
    ];
    for (const [param, curve] of params) {
      param.cancelScheduledValues(now);
      param.setValueCurveAtTime(curve, now, curves.duration);
    }
    for (const voice of [this.voice, this.rumble, this.horn?.synth ? null : this.horn]) {
      if (!voice) continue;
      voice.source.playbackRate.cancelScheduledValues(now);
      voice.source.playbackRate.setValueCurveAtTime(curves.rate.map((value) => value * voice.rate), now, curves.duration);
    }
    const drive = this.driveBy;
    clearTimeout(this.driveTimer);
    this.driveTimer = setTimeout(() => {
      if (this.driveBy !== drive) return;
      this.driveBy = null;
      this.applyScene(0.2);
    }, curves.duration * 1000 + 60);
    return curves.duration;
  }

  stopDriveBy() {
    if (!this.driveBy || !this.context) return;
    this.driveBy = null;
    clearTimeout(this.driveTimer);
    const now = this.context.currentTime;
    for (const voice of [this.voice, this.rumble]) {
      if (!voice) continue;
      voice.source.playbackRate.cancelScheduledValues(now);
      voice.source.playbackRate.setValueAtTime(voice.rate, now);
    }
    this.applyScene(0.1);
  }

  driveProgress() {
    if (!this.driveBy || !this.context) return null;
    const t = (this.context.currentTime - this.driveBy.start) / this.driveBy.duration;
    return t >= 0 && t <= 1 ? t : null;
  }

  readFrame() {
    if (!this.analyser) return null;
    this.analyser.getFloatTimeDomainData(this.frame);
    return this.frame;
  }

  sampleRate() {
    return this.context?.sampleRate || 48000;
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
    clearTimeout(this.driveTimer);
    this.stopAll();
    if (this.recorder) this.recorder.port.onmessage = null;
    for (const node of [this.voiceBus, this.rateless, this.panner, this.filter, this.distance, this.dry, this.wet, this.reverb, this.rumbleBus, this.rumbleFilter, this.master, this.limiter, this.analyser, this.recorder]) {
      node?.disconnect();
    }
    this.buffers.clear();
    this.levels.clear();
  }
}
