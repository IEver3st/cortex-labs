import { POP_STYLES } from "./engine-sim.js";

export const IMPORT_EXTENSIONS = Object.freeze(["zip", "rar", "7z", "oiv", "rpf"]);
export const INSTALL_TARGETS = Object.freeze(["fivem", "sp"]);

function text(value, max = 400) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function pick(value, options, fallback) {
  return options.includes(value) ? value : fallback;
}

function unit(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback;
}

export function engineKey(ref) {
  return ref ? `${ref.id}|${ref.source}|${ref.audioName}` : "";
}

export function sourceKey(ref) {
  return ref ? `${ref.id}|${ref.source}` : "";
}

function normalizeRef(raw) {
  if (!raw || typeof raw !== "object") return null;
  const ref = { id: text(raw.id, 64), source: text(raw.source), audioName: text(raw.audioName, 80) };
  return ref.id && ref.source && ref.audioName ? ref : null;
}

export function normalizeEngineState(raw) {
  const state = raw && typeof raw === "object" ? raw : {};
  const install = state.install && typeof state.install === "object" ? state.install : {};
  return {
    a: normalizeRef(state.a),
    b: normalizeRef(state.b),
    slot: state.slot === "b" ? "b" : "a",
    pops: pick(state.pops, POP_STYLES, "pack"),
    autoShift: state.autoShift !== false,
    mix: {
      engine: unit(state.mix?.engine, 0.8),
      exhaust: unit(state.mix?.exhaust, 1),
      volume: unit(state.mix?.volume, 0.7),
    },
    install: {
      target: pick(install.target, INSTALL_TARGETS, "fivem"),
      resourcesDir: text(install.resourcesDir, 1024),
      spDir: text(install.spDir, 1024),
      picks: Array.isArray(install.picks) ? install.picks.filter((key) => typeof key === "string").slice(0, 200) : [],
    },
  };
}

export function isImportPath(path) {
  const ext = String(path || "").split(".").pop()?.toLowerCase();
  return IMPORT_EXTENSIONS.includes(ext);
}

export function libraryEngines(library) {
  const rows = [];
  for (const entry of library || []) {
    for (const source of entry.sources || []) {
      for (const engine of source.engines || []) {
        rows.push({ entry, source, engine, ref: { id: entry.id, source: source.id, audioName: engine.audioName } });
      }
    }
  }
  return rows;
}

export function findEngine(library, ref) {
  if (!ref) return null;
  return libraryEngines(library).find((row) => engineKey(row.ref) === engineKey(ref)) || null;
}

export function sourceLabel(source) {
  const path = String(source?.path || "").replace(/\\/g, "/");
  const parts = path.split("/").filter(Boolean);
  if (source?.kind === "rpf") {
    const parent = parts.length > 1 ? parts[parts.length - 2] : "";
    return parent && parent !== "dlc.rpf" ? `${parent}/dlc.rpf` : parts.at(-1) || "dlc.rpf";
  }
  return parts.at(-1) || "Folder";
}

export function kindLabel(kind) {
  if (kind === "rpf") return "Single-player dlc.rpf";
  if (kind === "folder") return "FiveM resource";
  return "Audio files";
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

export function formatRpm(rpm) {
  const value = Math.max(0, Math.round(Number(rpm) || 0));
  return value.toLocaleString("en-US");
}

export function fivemEnsureLines(resources, check) {
  if (!resources?.length) return [];
  if (check?.category && check.startsWithServer) return [];
  return resources.map((resource) => `ensure ${resource.name}`);
}

export const ONE_SHOT_LABELS = Object.freeze({
  exhaust_pops: "Exhaust pops",
  limiter_pop: "Limiter pops",
  startup: "Start-up",
  shutdown: "Shut-down",
  dump_valve: "Dump valve",
  startup_revs: "Start-up blip",
});

export const CHANNEL_LABELS = Object.freeze({
  engine_accel: "Engine, on throttle",
  exhaust_accel: "Exhaust, on throttle",
  engine_decel: "Engine, off throttle",
  exhaust_decel: "Exhaust, off throttle",
  engine_idle: "Engine idle",
  exhaust_idle: "Exhaust idle",
});

export function downloadLabel(name) {
  let label = String(name || "");
  try {
    label = decodeURIComponent(label.replace(/%(?![0-9a-f]{2})/gi, "%25"));
  } catch {
    label = String(name || "");
  }
  label = label.replace(/^[0-9a-f]{6}-(?=.)/i, "").replace(/\.(zip|rar|7z|oiv)$/i, "").replace(/_/g, " ").replace(/\s+/g, " ").trim();
  return label || String(name || "");
}
