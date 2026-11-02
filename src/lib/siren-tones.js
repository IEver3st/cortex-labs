import { encodeWav } from "./engine-grains.js";

export const AUDIO_EXTENSIONS = Object.freeze(["wav", "mp3", "ogg", "flac", "m4a", "aac"]);
export const SIREN_SCENES = Object.freeze(["street", "cabin", "far"]);
export const LVC_STOCK_TONES = 14;
const LVC_GAME_NAME = 11;
export const MAX_PACK_TONES = 24;
export const MAX_TONE_SECONDS = 30;

export const SIREN_ROLES = Object.freeze([
  { id: "wail", label: "Wail" },
  { id: "yelp", label: "Yelp" },
  { id: "priority", label: "Priority" },
  { id: "hilo", label: "Hi-lo" },
  { id: "horn", label: "Horn" },
  { id: "powercall", label: "Powercall" },
  { id: "other", label: "Tone" },
]);

const ROLE_IDS = new Set(SIREN_ROLES.map((role) => role.id));
const TARGET_RMS = 0.18;
const PEAK_CEILING = 0.89;
const LOOP_FADE_SECONDS = 0.06;
const MAX_RATE = 32000;
const SHORT_LOOP_SECONDS = 0.5;
const TILED_LOOP_SECONDS = 1;
const MIN_BUILD_SAMPLES = 4096;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

export function isAudioPath(path) {
  const ext = String(path || "").split(".").pop()?.toLowerCase();
  return AUDIO_EXTENSIONS.includes(ext);
}

export function roleLabel(role) {
  return SIREN_ROLES.find((entry) => entry.id === role)?.label || "Tone";
}

export function roleFromName(name) {
  const text = String(name || "").toLowerCase();
  if (/horn|airhorn|bull/.test(text)) return "horn";
  if (/power ?call|pcall|ambulance_warning/.test(text)) return "powercall";
  if (/hi_?lo|hilo|two_?tone|2_?tone|nee/.test(text)) return "hilo";
  if (/prior|phaser|piercer|warning|zzz|hyper|quick_0?[34]/.test(text)) return "priority";
  if (/yelp|quick|siren_2\b|fast/.test(text)) return "yelp";
  if (/wail|slow|siren/.test(text)) return "wail";
  return "other";
}

export function sanitizeName(value, fallback = "tone") {
  let name = String(value || "")
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  if (!name) name = fallback;
  if (!/^[a-z]/.test(name)) name = `s_${name}`.slice(0, 32);
  if (WINDOWS_DEVICE.test(name)) name = `${name}_${fallback}`;
  return name;
}

export function uniqueName(value, taken, fallback = "tone") {
  const base = sanitizeName(value, fallback);
  const used = new Set([...taken].map((name) => String(name)));
  if (!used.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base.slice(0, 28)}_${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base.slice(0, 24)}_${used.size + 1}`;
}

export function packDlcName(resourceName) {
  return sanitizeName(resourceName, "sirens").replace(/_/g, "").slice(0, 24) || "sirens";
}

export function toneRefKey(ref) {
  if (!ref) return "";
  if (ref.kind === "file") return `file|${ref.path}`;
  return `lib|${ref.id}|${ref.source}|${ref.tone}`;
}

function finite(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeRef(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.kind === "file" && typeof raw.path === "string" && raw.path) return { kind: "file", path: raw.path.slice(0, 1024) };
  if (raw.kind === "lib" && typeof raw.id === "string" && typeof raw.source === "string" && typeof raw.tone === "string") {
    return { kind: "lib", id: raw.id.slice(0, 64), source: raw.source.slice(0, 512), tone: raw.tone.slice(0, 64) };
  }
  return null;
}

function normalizePackTone(raw, taken) {
  const ref = normalizeRef(raw?.ref);
  if (!ref) return null;
  const name = uniqueName(raw.name, taken);
  taken.add(name);
  const start = finite(raw.start, 0, 0, MAX_TONE_SECONDS * 10);
  const end = finite(raw.end, 0, 0, MAX_TONE_SECONDS * 10);
  return {
    name,
    label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim().slice(0, 40) : name,
    role: ROLE_IDS.has(raw.role) ? raw.role : roleFromName(name),
    ref,
    start,
    end: end > start ? end : 0,
    gain: finite(raw.gain, 0, -12, 12),
    loop: raw.loop !== false,
  };
}

export function normalizeSirenState(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const pack = source.pack && typeof source.pack === "object" ? source.pack : {};
  const install = source.install && typeof source.install === "object" ? source.install : {};
  const taken = new Set();
  const tones = (Array.isArray(pack.tones) ? pack.tones : [])
    .slice(0, MAX_PACK_TONES)
    .map((tone) => normalizePackTone(tone, taken))
    .filter(Boolean);
  const files = (Array.isArray(source.files) ? source.files : [])
    .filter((path) => typeof path === "string" && isAudioPath(path))
    .slice(0, 64);
  return {
    selected: normalizeRef(source.selected),
    files: [...new Set(files)],
    pack: {
      name: sanitizeName(pack.name, "cortex_sirens"),
      tones,
      vehicles: typeof pack.vehicles === "string" ? pack.vehicles.slice(0, 400) : "",
      firstTone: firstToneNumber(pack.firstTone),
    },
    install: {
      target: install.target === "sp" ? "sp" : "fivem",
      resourcesDir: typeof install.resourcesDir === "string" ? install.resourcesDir : "",
      spDir: typeof install.spDir === "string" ? install.spDir : "",
      testCommand: install.testCommand !== false,
      picks: [...new Set((Array.isArray(install.picks) ? install.picks : []).filter((key) => typeof key === "string" && key.includes("|")))].slice(0, 64),
    },
    scene: SIREN_SCENES.includes(source.scene) ? source.scene : "street",
    rumbler: Boolean(source.rumbler),
    driveSpeed: finite(source.driveSpeed, 90, 30, 200),
    volume: finite(source.volume, 0.8, 0, 1),
    gtaFolder: typeof source.gtaFolder === "string" ? source.gtaFolder : "",
  };
}

export function librarySirens(library) {
  const rows = [];
  for (const entry of library || []) {
    for (const source of entry.sirens || []) {
      for (const tone of source.tones || []) {
        rows.push({ entry, source, tone, ref: { kind: "lib", id: entry.id, source: source.id, tone: tone.id } });
      }
    }
  }
  return rows;
}

export function findLibraryTone(library, ref) {
  if (!ref || ref.kind !== "lib") return null;
  const entry = (library || []).find((item) => item.id === ref.id);
  const source = entry?.sirens?.find((item) => item.id === ref.source);
  const tone = source?.tones?.find((item) => item.id === ref.tone);
  return tone ? { entry, source, tone } : null;
}

export function parseVehicles(text) {
  return [...new Set(String(text || "").split(/[\s,;]+/).map((name) => name.trim()).filter((name) => /^[A-Za-z0-9_]+$/.test(name)).map((name) => name.slice(0, LVC_GAME_NAME)))].slice(0, 40);
}

export function firstToneNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return LVC_STOCK_TONES + 1;
  return Math.round(finite(value, LVC_STOCK_TONES + 1, 1, 999));
}

function luaString(value) {
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export function lvcSnippet({ dlc, tones, vehicles, firstTone }) {
  const soundset = `${dlc}_soundset`;
  const first = firstToneNumber(firstTone);
  const lines = [
    "-- Luxart Vehicle Control v3, SIRENS.lua",
    `-- Add to the end of the SIRENS table, as tones ${first} to ${first + Math.max(0, tones.length - 1)}.`,
  ];
  tones.forEach((tone, index) => {
    lines.push(`{ Name = ${luaString(tone.label || tone.name)}, String = ${luaString(tone.name)}, Ref = ${luaString(soundset)} }, --${first + index}`);
  });
  const models = parseVehicles(vehicles);
  if (models.length && tones.length) {
    const ids = tones.map((_, index) => first + index).join(", ");
    lines.push("", "-- SIREN_ASSIGNMENTS: if a vehicle already has a line, add these numbers to it instead.");
    for (const model of models) lines.push(`['${model}'] = { ${ids} },`);
  }
  return lines.join("\n");
}

export function fleetReference({ dlc, tones }) {
  const bank = `dlc_${dlc}/${dlc}`;
  return tones.map((tone) => `${tone.label || tone.name}: String ${tone.name}, Ref ${dlc}_soundset, Bank ${bank}`).join("\n");
}

const SINC_ZEROS = 16;
const SINC_PHASES = 256;
const PASSBAND = 0.43;

function lowpassTable(cutoff) {
  const half = Math.ceil(SINC_ZEROS / (2 * cutoff));
  const table = new Float32Array(2 * half * SINC_PHASES + 1);
  for (let index = 0; index < table.length; index += 1) {
    const t = index / SINC_PHASES - half;
    const x = 2 * cutoff * t;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const window = 0.42 + 0.5 * Math.cos((Math.PI * t) / half) + 0.08 * Math.cos((2 * Math.PI * t) / half);
    table[index] = sinc * window;
  }
  return { half, table };
}

function resampleSpan(samples, from, to, first, count) {
  const out = new Float32Array(Math.max(0, count));
  const step = from / to;
  const { half, table } = lowpassTable(Math.min(0.5, (PASSBAND * to) / from));
  for (let index = 0; index < out.length; index += 1) {
    const position = (first + index) * step;
    const base = Math.floor(position);
    let sum = 0;
    let weight = 0;
    for (let tap = base - half + 1; tap <= base + half; tap += 1) {
      const w = table[Math.round((tap - position + half) * SINC_PHASES)];
      weight += w;
      if (tap >= 0 && tap < samples.length) sum += samples[tap] * w;
    }
    out[index] = weight > 0 ? sum / weight : 0;
  }
  return out;
}

function measure(samples) {
  let sum = 0;
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index];
    sum += value * value;
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
  }
  return { rms: samples.length ? Math.sqrt(sum / samples.length) : 0, peak };
}

export function playbackLevel(samples) {
  const { rms, peak } = measure(samples);
  if (peak < 1e-4) return 1;
  return Math.min(TARGET_RMS / Math.max(rms, 1e-6), PEAK_CEILING / peak);
}

export function renderTone(samples, sampleRate, { start = 0, end = 0, gain = 0, loop = true } = {}) {
  if (!samples?.length || !Number.isFinite(sampleRate) || sampleRate < 8000) throw new Error("That audio has no usable samples.");
  const rate = Math.min(MAX_RATE, Math.round(sampleRate));
  const total = rate === sampleRate ? samples.length : Math.max(1, Math.round(samples.length * (rate / sampleRate)));
  const first = Math.min(total - 1, Math.max(0, Math.round(start * rate)));
  const last = end > start ? Math.min(total, Math.round(end * rate)) : total;
  const count = Math.min(last, first + MAX_TONE_SECONDS * rate) - first;
  let body = rate === sampleRate ? samples.slice(first, first + Math.max(0, count)) : resampleSpan(samples, sampleRate, rate, first, count);
  if (body.length < (loop ? 32 : rate * 0.05)) throw new Error(loop ? "The trimmed tone is too short to loop." : "The trimmed tone is shorter than 50 ms.");
  if (loop && body.length < rate * SHORT_LOOP_SECONDS) {
    const repeats = Math.ceil((rate * TILED_LOOP_SECONDS) / body.length);
    const tiled = new Float32Array(body.length * repeats);
    for (let index = 0; index < repeats; index += 1) tiled.set(body, index * body.length);
    body = tiled;
  } else if (loop) {
    const fade = Math.min(Math.round(LOOP_FADE_SECONDS * rate), Math.floor(body.length / 4));
    if (fade > 8) {
      const looped = body.slice(0, body.length - fade);
      for (let index = 0; index < fade; index += 1) {
        const t = index / fade;
        looped[index] = body[index] * t + body[body.length - fade + index] * (1 - t);
      }
      body = looped;
    }
  }
  const { rms, peak } = measure(body);
  if (peak < 1e-4) throw new Error("The tone is silent.");
  const level = Math.min(TARGET_RMS / Math.max(rms, 1e-6), PEAK_CEILING / peak) * 10 ** (gain / 20);
  const safe = Math.min(level, 1 / peak);
  const out = new Float32Array(Math.max(body.length, MIN_BUILD_SAMPLES));
  for (let index = 0; index < body.length; index += 1) out[index] = body[index] * safe;
  return { samples: out, sampleRate: rate, seconds: out.length / rate };
}

export function renderedToneBytes(tone, sourceSeconds) {
  const end = tone.end > tone.start ? Math.min(tone.end, sourceSeconds) : sourceSeconds;
  const length = Math.min(MAX_TONE_SECONDS, Math.max(0, end - tone.start));
  const seconds = tone.loop && length < SHORT_LOOP_SECONDS ? TILED_LOOP_SECONDS : length;
  return Math.max(Math.round(seconds * MAX_RATE), MIN_BUILD_SAMPLES) * 2;
}

export function encodeToneWav(rendered) {
  return new Uint8Array(encodeWav([rendered.samples], rendered.sampleRate));
}

export function estimatePitch(frame, sampleRate, low = 180, high = 2600) {
  const size = frame.length;
  const minLag = Math.max(2, Math.floor(sampleRate / high));
  const maxLag = Math.min(size >> 1, Math.ceil(sampleRate / low));
  let energy = 0;
  for (let index = 0; index < size; index += 1) energy += frame[index] * frame[index];
  if (energy / size < 1e-5) return 0;
  const span = size - maxLag;
  const scores = new Float32Array(maxLag + 1);
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    let norm = 0;
    for (let index = 0; index < span; index += 1) {
      const a = frame[index];
      const b = frame[index + lag];
      sum += a * b;
      norm += a * a + b * b;
    }
    const score = norm > 0 ? (2 * sum) / norm : 0;
    scores[lag] = score;
    if (score > best) best = score;
  }
  if (best < 0.55) return 0;
  for (let lag = minLag + 1; lag < maxLag; lag += 1) {
    if (scores[lag] >= best * 0.9 && scores[lag] >= scores[lag - 1] && scores[lag] >= scores[lag + 1]) {
      const left = scores[lag - 1];
      const right = scores[lag + 1];
      const curve = left - 2 * scores[lag] + right;
      const shift = curve < 0 ? (0.5 * (left - right)) / curve : 0;
      return sampleRate / (lag + Math.max(-0.5, Math.min(0.5, shift)));
    }
  }
  return 0;
}

export function packToneKey(tone) {
  return `pack|${toneRefKey(tone.ref)}|${tone.start}|${tone.end}|${tone.gain}|${tone.loop ? 1 : 0}`;
}

export function toneLabelFrom(name, role) {
  const words = String(name || "").replace(/\.(wav|mp3|ogg|flac|m4a|aac)$/i, "").replace(/^siren_/i, "").replace(/[_\s]+/g, " ").trim();
  if (!/[a-z]/i.test(words)) return roleLabel(role || roleFromName(name));
  return (words[0].toUpperCase() + words.slice(1)).slice(0, 40);
}

export function pitchSweep(samples, sampleRate, seconds = 8) {
  const size = 2048;
  const hop = Math.round(sampleRate * 0.08);
  const limit = Math.min(samples.length - size, Math.round(sampleRate * seconds));
  const found = [];
  for (let at = 0; at < limit; at += hop) {
    const hz = estimatePitch(samples.subarray(at, at + size), sampleRate);
    if (hz > 0) found.push(hz);
  }
  if (found.length < 3) return null;
  found.sort((x, y) => x - y);
  const pick = (q) => found[Math.min(found.length - 1, Math.floor(q * found.length))];
  return { low: pick(0.05), high: pick(0.95) };
}
