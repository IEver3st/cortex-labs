// Saved vehicles: named setups the user can reopen from Home as long as the
// model is still on disk. An entry points at the user's model file and keeps
// what the workspace layered on top of it: the mod kit parts, game livery,
// paint, extras, plate, and (in Livery and All) the livery texture and its
// mesh targets. Nothing
// here touches the model or its resource; reopening rebuilds the setup through the workspace's
// own restore path. Pure apart from the localStorage helpers at the bottom.

import { normalizeModChoices } from "./kit-shoot.js";
import { normalizeVehiclePaint } from "./vehicle-paint.js";
import { normalizeExtrasState } from "./vehicle-extras.js";
import { normalizePlateDefault } from "./studio-defaults.js";

export const SAVED_VEHICLES_KEY = "cortex-studio:saved-vehicles.v1";
export const SAVED_VEHICLES_EVENT = "cortex-studio:saved-vehicles-updated";
export const SAVED_VEHICLES_VERSION = 1;
export const SAVED_VEHICLE_MODES = Object.freeze(["livery", "everything", "sirens"]);
export const MAX_SAVED_VEHICLES = 200;
export const SAVED_VEHICLE_NAME_MAX = 60;

const MODEL_EXTENSION = /\.(yft|clmesh|dff)$/i;
// Only the modes whose viewer previews mod kit parts keep a kit selection.
const MOD_MODES = new Set(["everything", "sirens"]);
const LIVERY_MODES = new Set(["livery", "everything"]);

function text(value, max = 2048) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function stamp(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function savedVehicleFileName(path) {
  return String(path || "").split(/[\\/]/).pop() || "";
}

/** Name a new save starts with: the model file without its extension or `_hi`. */
export function defaultSavedVehicleName(modelPath) {
  return savedVehicleFileName(modelPath).replace(MODEL_EXTENSION, "").replace(/_hi$/i, "").slice(0, SAVED_VEHICLE_NAME_MAX);
}

function normalizeMods(value, mode) {
  if (!MOD_MODES.has(mode) || !value || typeof value !== "object") return null;
  const mods = normalizeModChoices(value.mods);
  if (Object.keys(mods).length === 0) return null;
  return { kitName: text(value.kitName, 120), mods };
}

/** One stored entry, or null when it can't be reopened (no name, id, or model path). */
export function normalizeSavedVehicle(value) {
  if (!value || typeof value !== "object") return null;
  const id = text(value.id, 64);
  const name = text(value.name, SAVED_VEHICLE_NAME_MAX);
  const modelPath = text(value.modelPath);
  if (!id || !name || !modelPath || !MODEL_EXTENSION.test(modelPath)) return null;
  const mode = SAVED_VEHICLE_MODES.includes(value.mode) ? value.mode : "everything";
  const bodyColor = /^#[0-9a-f]{6}$/i.test(value.bodyColor || "") ? value.bodyColor.toLowerCase() : undefined;
  const entry = {
    id,
    name,
    modelPath,
    mode,
    createdAt: stamp(value.createdAt),
    savedAt: stamp(value.savedAt),
    paint: normalizeVehiclePaint(value.paint, bodyColor),
    mods: normalizeMods(value.mods, mode),
    // The game texture livery (`_sign_N`) shown, where mods are previewed.
    livery: MOD_MODES.has(mode) && Number.isInteger(value.livery) && value.livery >= 0 && value.livery <= 999 ? value.livery : null,
    extras: normalizeExtrasState(value.extras),
    plate: value.plate && typeof value.plate === "object" ? normalizePlateDefault(value.plate) : null,
    texturePath: LIVERY_MODES.has(mode) ? text(value.texturePath) : "",
    windowTexturePath: LIVERY_MODES.has(mode) ? text(value.windowTexturePath) : "",
    // Mesh targets picked by hand; "" leaves the workspace's default. Entries
    // saved before these existed have none.
    textureTarget: LIVERY_MODES.has(mode) ? text(value.textureTarget, 512) : "",
    windowTextureTarget: LIVERY_MODES.has(mode) ? text(value.windowTextureTarget, 512) : "",
    liveryWindowOverride: LIVERY_MODES.has(mode) ? text(value.liveryWindowOverride, 512) : "",
    // null when unknown (older entries), so the workspace default stays.
    windowTemplateEnabled: LIVERY_MODES.has(mode) && typeof value.windowTemplateEnabled === "boolean" ? value.windowTemplateEnabled : null,
  };
  if (bodyColor) entry.bodyColor = bodyColor;
  if (!entry.createdAt) entry.createdAt = entry.savedAt;
  return entry;
}

/**
 * Splits stored data into the library (`{ version, vehicles }`, newest save
 * first, ids unique, at most MAX_SAVED_VEHICLES) and the raw entries that
 * didn't make it: unreadable, a repeated id, or past the cap.
 */
export function partitionSavedVehicles(value) {
  const source = Array.isArray(value?.vehicles) ? value.vehicles : [];
  const seen = new Set();
  const kept = [];
  const dropped = [];
  for (const raw of source) {
    const entry = normalizeSavedVehicle(raw);
    if (!entry || seen.has(entry.id)) {
      if (raw != null) dropped.push(raw);
      continue;
    }
    seen.add(entry.id);
    kept.push({ entry, raw });
  }
  kept.sort((a, b) => b.entry.savedAt - a.entry.savedAt);
  for (const { raw } of kept.slice(MAX_SAVED_VEHICLES)) dropped.push(raw);
  return {
    store: { version: SAVED_VEHICLES_VERSION, vehicles: kept.slice(0, MAX_SAVED_VEHICLES).map(({ entry }) => entry) },
    dropped,
  };
}

/** The library from storage: `{ version, vehicles }`, newest save first, ids unique. */
export function normalizeSavedVehicles(value) {
  return partitionSavedVehicles(value).store;
}

/**
 * Builds an entry from the workspace's current setup. `vehicleMods` is the mod
 * kit hook's saved selection ({ path, kitName, mods } or null); a selection
 * for a different model than the one saved is dropped.
 */
export function captureSavedVehicle({
  id,
  name,
  now,
  mode,
  modelPath,
  vehiclePaint,
  bodyColor,
  vehicleMods,
  livery,
  extras,
  plate,
  texturePath,
  windowTexturePath,
  textureTarget,
  windowTextureTarget,
  windowTemplateEnabled,
  liveryWindowOverride,
} = {}) {
  const mods = vehicleMods && vehicleMods.path === modelPath ? vehicleMods : null;
  return normalizeSavedVehicle({
    id,
    name,
    modelPath,
    mode,
    createdAt: now,
    savedAt: now,
    paint: vehiclePaint,
    bodyColor,
    mods,
    livery,
    extras,
    plate,
    texturePath,
    windowTexturePath,
    textureTarget,
    windowTextureTarget,
    windowTemplateEnabled,
    liveryWindowOverride,
  });
}

export function findSavedVehicleByName(store, name) {
  const key = text(name, SAVED_VEHICLE_NAME_MAX).toLowerCase();
  if (!key) return null;
  return normalizeSavedVehicles(store).vehicles.find((entry) => entry.name.toLowerCase() === key) || null;
}

/**
 * Adds an entry, or replaces the one with the same id or, failing that, the
 * same name (case-insensitive). A replaced entry keeps its id and createdAt so
 * tabs linked to it stay linked. Returns { store, entry }; a new entry while
 * the library is full returns { entry: null, error: "full" } and changes nothing.
 */
export function upsertSavedVehicle(store, value) {
  const normalized = normalizeSavedVehicles(store);
  const incoming = normalizeSavedVehicle(value);
  if (!incoming) return { store: normalized, entry: null };
  const nameKey = incoming.name.toLowerCase();
  const previous = normalized.vehicles.find((entry) => entry.id === incoming.id)
    || normalized.vehicles.find((entry) => entry.name.toLowerCase() === nameKey)
    || null;
  if (!previous && normalized.vehicles.length >= MAX_SAVED_VEHICLES) return { store: normalized, entry: null, error: "full" };
  const entry = previous
    ? { ...incoming, id: previous.id, createdAt: previous.createdAt || incoming.createdAt }
    : incoming;
  // A rename onto another entry's name replaces that entry too.
  const vehicles = normalized.vehicles.filter((other) => other.id !== entry.id && other.name.toLowerCase() !== nameKey);
  return { store: normalizeSavedVehicles({ vehicles: [entry, ...vehicles] }), entry };
}

function restoredName(name, taken) {
  for (let attempt = 1; ; attempt += 1) {
    const suffix = attempt === 1 ? " (restored)" : ` (restored ${attempt})`;
    const candidate = `${name.slice(0, SAVED_VEHICLE_NAME_MAX - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Puts a deleted entry back under its own id (Home's Undo). It never replaces
 * another entry: if a vehicle with the same name was saved since, the restored
 * one becomes "Name (restored)". Returns { store, entry } or, while the
 * library is full, { entry: null, error: "full" }.
 */
export function restoreSavedVehicle(store, value) {
  const normalized = normalizeSavedVehicles(store);
  const entry = normalizeSavedVehicle(value);
  if (!entry) return { store: normalized, entry: null };
  const existing = normalized.vehicles.find((other) => other.id === entry.id);
  if (existing) return { store: normalized, entry: existing };
  if (normalized.vehicles.length >= MAX_SAVED_VEHICLES) return { store: normalized, entry: null, error: "full" };
  const taken = new Set(normalized.vehicles.map((other) => other.name.toLowerCase()));
  const restored = taken.has(entry.name.toLowerCase()) ? { ...entry, name: restoredName(entry.name, taken) } : entry;
  return { store: normalizeSavedVehicles({ vehicles: [restored, ...normalized.vehicles] }), entry: restored };
}

function pathKey(path) {
  return text(path).replace(/\//g, "\\").toLowerCase();
}

/**
 * Whether a tab linked to entry `id` may update it in place: "linked" while
 * the entry still points at `modelPath`, "moved" when it was re-pointed at
 * another model since (Locate on Home, or another tab), "missing" once deleted.
 */
export function savedVehicleLinkStatus(store, id, modelPath) {
  const entry = normalizeSavedVehicles(store).vehicles.find((other) => other.id === id);
  if (!entry) return "missing";
  return pathKey(entry.modelPath) === pathKey(modelPath) ? "linked" : "moved";
}

export function removeSavedVehicle(store, id) {
  const normalized = normalizeSavedVehicles(store);
  return { ...normalized, vehicles: normalized.vehicles.filter((entry) => entry.id !== id) };
}

/** Points an entry at a model the user located after it moved. Keeps every other choice. */
export function relinkSavedVehicle(store, id, modelPath, now) {
  const normalized = normalizeSavedVehicles(store);
  const path = text(modelPath);
  if (!MODEL_EXTENSION.test(path)) return normalized;
  return normalizeSavedVehicles({
    vehicles: normalized.vehicles.map((entry) => (entry.id === id ? { ...entry, modelPath: path, savedAt: stamp(now) || entry.savedAt } : entry)),
  });
}

/**
 * Follows a model file the app itself moved (the vehicle renamer): every entry
 * on `fromPath` (compared case-insensitively, as Windows does) moves to `toPath`.
 * Returns { store, moved } so the caller can skip a write when nothing matched.
 */
export function moveSavedVehicleModel(store, fromPath, toPath, now) {
  const normalized = normalizeSavedVehicles(store);
  const from = text(fromPath).toLowerCase();
  const to = text(toPath);
  if (!from || !MODEL_EXTENSION.test(to)) return { store: normalized, moved: 0 };
  let moved = 0;
  const vehicles = normalized.vehicles.map((entry) => {
    if (entry.modelPath.toLowerCase() !== from) return entry;
    moved += 1;
    return { ...entry, modelPath: to, savedAt: stamp(now) || entry.savedAt };
  });
  return { store: moved ? normalizeSavedVehicles({ vehicles }) : normalized, moved };
}

/** Workspace state that reopens the entry through App's restore path. */
export function savedVehicleWorkspaceState(entry) {
  const vehicle = normalizeSavedVehicle(entry);
  if (!vehicle) return null;
  const state = {
    textureMode: vehicle.mode,
    modelPath: vehicle.modelPath,
    modelSourcePath: vehicle.modelPath,
    vehiclePaint: vehicle.paint,
    extras: vehicle.extras,
    vehicleMods: vehicle.mods ? { path: vehicle.modelPath, kitName: vehicle.mods.kitName, mods: vehicle.mods.mods } : null,
    savedVehicle: { id: vehicle.id, name: vehicle.name, path: vehicle.modelPath },
  };
  if (vehicle.bodyColor) state.bodyColor = vehicle.bodyColor;
  if (vehicle.livery != null) state.gameLivery = { path: vehicle.modelPath, number: vehicle.livery };
  if (vehicle.plate) state.licensePlate = vehicle.plate;
  if (vehicle.texturePath) state.texturePath = vehicle.texturePath;
  if (vehicle.windowTexturePath) state.windowTexturePath = vehicle.windowTexturePath;
  if (vehicle.textureTarget) state.textureTarget = vehicle.textureTarget;
  if (vehicle.windowTextureTarget) state.windowTextureTarget = vehicle.windowTextureTarget;
  if (vehicle.liveryWindowOverride) state.liveryWindowOverride = vehicle.liveryWindowOverride;
  if (vehicle.windowTemplateEnabled != null) state.windowTemplateEnabled = vehicle.windowTemplateEnabled;
  return state;
}

// What a saved vehicle decides in a workspace. Opening it over a project
// already linked to it replaces these and keeps the rest (stage, light, backdrop).
const SAVED_VEHICLE_STATE_KEYS = [
  "textureMode", "modelPath", "modelSourcePath", "openFile", "vehiclePaint", "vehicleSlotColors", "bodyColor",
  "extras", "vehicleMods", "savedVehicle", "gameLivery", "licensePlate", "texturePath", "windowTexturePath",
  "textureTarget", "windowTextureTarget", "liveryWindowOverride", "windowTemplateEnabled",
];

/** `projectState` with the entry's setup applied over it, or null when the entry can't be opened. */
export function applySavedVehicleToState(projectState, entry) {
  const vehicleState = savedVehicleWorkspaceState(entry);
  if (!vehicleState) return null;
  const base = projectState && typeof projectState === "object" ? { ...projectState } : {};
  for (const key of SAVED_VEHICLE_STATE_KEYS) delete base[key];
  return { ...base, ...vehicleState };
}

/**
 * The project already linked to saved vehicle `id`: one open in a tab
 * (`openWorkspaceIds`) first, else the most recently saved. Null when none is.
 */
export function findSavedVehicleWorkspace(workspaces, id, openWorkspaceIds = []) {
  if (!id || !workspaces || typeof workspaces !== "object") return null;
  const open = new Set(openWorkspaceIds);
  let best = null;
  for (const [key, ws] of Object.entries(workspaces)) {
    if (!ws || typeof ws !== "object" || (ws.page && ws.page !== "viewer")) continue;
    if (ws.state?.savedVehicle?.id !== id) continue;
    const candidate = { id: key, open: open.has(key), at: stamp(ws.updatedAt) };
    if (!best || (candidate.open && !best.open) || (candidate.open === best.open && candidate.at > best.at)) best = candidate;
  }
  return best ? best.id : null;
}

// ── Storage ──

const DROPPED_BACKUP_KEY = `${SAVED_VEHICLES_KEY}.dropped`;
const MAX_DROPPED_BACKUP = 1000;

// Entries normalization drops would vanish on the next write; keep their raw
// form aside first (once each) so nothing is lost silently.
function backUpDroppedSavedVehicles(dropped) {
  try {
    const existing = JSON.parse(localStorage.getItem(DROPPED_BACKUP_KEY) || "[]");
    const kept = Array.isArray(existing) ? existing : [];
    const known = new Set(kept.map((entry) => JSON.stringify(entry)));
    const added = [];
    for (const entry of dropped) {
      const key = JSON.stringify(entry);
      if (known.has(key)) continue;
      known.add(key);
      added.push(entry);
    }
    if (added.length === 0) return;
    localStorage.setItem(DROPPED_BACKUP_KEY, JSON.stringify([...kept, ...added].slice(-MAX_DROPPED_BACKUP)));
    console.warn(`[SavedVehicles] Kept ${added.length} unreadable or over-limit saved vehicle entries in ${DROPPED_BACKUP_KEY}.`);
  } catch {}
}

export function loadSavedVehicles() {
  let raw = null;
  try {
    raw = localStorage.getItem(SAVED_VEHICLES_KEY);
    const { store, dropped } = partitionSavedVehicles(JSON.parse(raw || "null"));
    if (dropped.length) backUpDroppedSavedVehicles(dropped);
    return store;
  } catch {
    // Keep unreadable data aside once, so the next save can't silently erase it.
    try {
      if (raw && localStorage.getItem(`${SAVED_VEHICLES_KEY}.unreadable`) == null) {
        localStorage.setItem(`${SAVED_VEHICLES_KEY}.unreadable`, raw);
      }
    } catch {}
    return normalizeSavedVehicles(null);
  }
}

/** Writes the library. Returns false when storage refused it, so callers can say so. */
export function writeSavedVehicles(store) {
  try {
    localStorage.setItem(SAVED_VEHICLES_KEY, JSON.stringify(normalizeSavedVehicles(store)));
  } catch (error) {
    console.error("[SavedVehicles] Failed to save:", error);
    return false;
  }
  try {
    window.dispatchEvent(new CustomEvent(SAVED_VEHICLES_EVENT));
  } catch {}
  return true;
}

export function generateSavedVehicleId(now = Date.now()) {
  return `veh-${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
