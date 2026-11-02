import { chooseNextGrain, crossfadeLength, idlePitch, loopForPitch, mulberry32, nextLoopGrain, pitchForRev } from "./engine-grains.js";

const SMOOTH = 0.0025;
const STEADY_DRIFT = 0.006;
const STEADY_GRAINS = 3;
const ACCEL = new Set(["engine_accel", "exhaust_accel"]);
const DECEL = new Set(["engine_decel", "exhaust_decel"]);

function readAt(samples, position) {
  const index = Math.floor(position);
  if (index < 0 || index + 1 >= samples.length) return 0;
  const fraction = position - index;
  return samples[index] + (samples[index + 1] - samples[index]) * fraction;
}

class GrainVoice {
  constructor(role, channel, random) {
    this.role = role;
    this.samples = channel.samples;
    this.table = channel.table;
    this.ratio = channel.sampleRate / sampleRate;
    this.gain = channel.gain;
    this.bus = channel.bus;
    this.idle = role.endsWith("_idle");
    this.idleMean = idlePitch(channel.table);
    this.random = random;
    this.grain = -1;
    this.position = 0;
    this.rate = 1;
    this.fadeIn = 1;
    this.fadeStep = 1;
    this.tail = null;
    this.level = 0;
    this.lastPitch = 0;
    this.steady = 0;
  }

  pick(pitch) {
    if (this.idle) return (this.grain + 1) % this.table.count;
    const drift = this.lastPitch > 0 ? Math.abs(pitch - this.lastPitch) / pitch : 1;
    this.lastPitch = pitch;
    this.steady = drift < STEADY_DRIFT ? this.steady + 1 : 0;
    if (this.steady >= STEADY_GRAINS && this.table.loops?.length) {
      const loop = loopForPitch(this.table, pitch);
      if (loop >= 0) return nextLoopGrain(this.table, loop, this.grain, pitch);
    }
    return chooseNextGrain(this.table, this.grain, pitch, this.random);
  }

  start(pitch) {
    const next = this.pick(pitch);
    if (next < 0) return false;
    const contiguous = this.grain >= 0 && next === this.grain + 1;
    if (this.grain >= 0 && !contiguous) {
      const length = crossfadeLength(this.table.lengths[next]);
      this.tail = { position: this.table.starts[this.grain] + this.position, rate: this.rate, left: length, total: length };
      this.fadeIn = 0;
      this.fadeStep = 1 / length;
      this.position = 0;
    } else if (contiguous) {
      this.position -= this.table.lengths[this.grain];
    } else {
      this.position = 0;
    }
    this.grain = next;
    const ratio = this.idle
      ? Math.min(1.35, Math.max(1, pitch / this.idleMean))
      : pitch / this.table.pitches[next];
    this.rate = Math.max(0.35, Math.min(2.6, ratio)) * this.ratio;
    return true;
  }

  render(pitch, target) {
    if (!this.table.count) return 0;
    this.level += (target - this.level) * SMOOTH;
    if (this.level < 1e-4 && target < 1e-4) {
      this.tail = null;
      return 0;
    }
    if (this.grain < 0 || this.position >= this.table.lengths[this.grain]) {
      if (!this.start(pitch)) return 0;
    }
    let value = readAt(this.samples, this.table.starts[this.grain] + this.position);
    if (this.fadeIn < 1) {
      value *= this.fadeIn;
      this.fadeIn = Math.min(1, this.fadeIn + this.fadeStep);
    }
    if (this.tail) {
      const fade = this.tail.left / this.tail.total;
      value += readAt(this.samples, this.tail.position) * fade;
      this.tail.position += this.tail.rate;
      this.tail.left -= 1;
      if (this.tail.left <= 0) this.tail = null;
    }
    this.position += this.rate;
    return value * this.gain * this.level;
  }
}

class EngineProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voices = [];
    this.range = null;
    this.limiter = { play: 3, skip: 2, cut: 0.2 };
    this.control = { rev: 0, throttle: 0, idle: 1, fuel: 1, limiter: false, pitchMod: 0, running: false };
    this.smooth = { rev: 0, fuel: 1, pitchMod: 0 };
    this.gate = { open: true, left: 0 };
    this.port.onmessage = (event) => this.receive(event.data);
  }

  receive(message) {
    if (message.type === "load") {
      const random = mulberry32(message.seed || 1);
      this.range = message.range;
      this.limiter = message.limiter || this.limiter;
      this.voices = Object.entries(message.channels).map(([role, channel]) => new GrainVoice(role, channel, random));
      this.smooth.rev = 0;
    } else if (message.type === "control") {
      Object.assign(this.control, message.control);
    } else if (message.type === "unload") {
      this.voices = [];
      this.range = null;
    }
  }

  gateFor(pitch) {
    if (!this.control.limiter) {
      this.gate.open = true;
      this.gate.left = 0;
      return 1;
    }
    if (this.gate.left <= 0) {
      this.gate.open = !this.gate.open;
      const grains = this.gate.open ? this.limiter.play : this.limiter.skip;
      this.gate.left = Math.max(1, Math.round((grains * sampleRate) / Math.max(1, pitch)));
    }
    this.gate.left -= 1;
    return this.gate.open ? 1 : this.limiter.cut;
  }

  process(_inputs, outputs) {
    const engine = outputs[0]?.[0];
    const exhaust = outputs[1]?.[0];
    if (!engine) return true;
    engine.fill(0);
    exhaust?.fill(0);
    if (!this.range || !this.voices.length || !this.control.running) return true;
    const c = this.control;
    for (let frame = 0; frame < engine.length; frame += 1) {
      this.smooth.rev += (c.rev - this.smooth.rev) * SMOOTH * 4;
      this.smooth.fuel += (c.fuel - this.smooth.fuel) * SMOOTH * 6;
      this.smooth.pitchMod += (c.pitchMod - this.smooth.pitchMod) * SMOOTH * 4;
      const pitch = pitchForRev(this.range, this.smooth.rev) * (1 + this.smooth.pitchMod);
      const gate = this.gateFor(pitch);
      const moving = 1 - c.idle;
      for (const voice of this.voices) {
        let level;
        if (voice.idle) level = c.idle;
        else if (ACCEL.has(voice.role)) level = moving * c.throttle * this.smooth.fuel;
        else if (DECEL.has(voice.role)) level = moving * (1 - c.throttle * this.smooth.fuel);
        else level = 0;
        const sample = voice.render(pitch, level) * gate;
        if (voice.bus === 1 && exhaust) exhaust[frame] += sample;
        else engine[frame] += sample;
      }
    }
    return true;
  }
}

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.chunks = [[], []];
    this.frames = 0;
    this.port.onmessage = (event) => {
      if (event.data?.type === "start") {
        this.recording = true;
        this.chunks = [[], []];
        this.frames = 0;
      } else if (event.data?.type === "stop") {
        this.recording = false;
        this.flush(true);
      }
    };
  }

  flush(done) {
    this.port.postMessage({ type: done ? "done" : "chunk", left: this.chunks[0], right: this.chunks[1] });
    this.chunks = [[], []];
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    for (let channel = 0; channel < output.length; channel += 1) {
      const source = input[channel] || input[0];
      if (source) output[channel].set(source);
      else output[channel].fill(0);
    }
    if (this.recording && input[0]) {
      this.chunks[0].push(new Float32Array(input[0]));
      this.chunks[1].push(new Float32Array(input[1] || input[0]));
      this.frames += input[0].length;
      if (this.chunks[0].length >= 64) this.flush(false);
    }
    return true;
  }
}

registerProcessor("cortex-engine", EngineProcessor);
registerProcessor("cortex-recorder", RecorderProcessor);
