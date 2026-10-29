import { sirenHeading } from "./emergency-lights.js";
import { checkSirenSetting, facingFromDelta, sequencerFromPattern, updateSirens } from "./siren-settings.js";

export const JUNO_ASK_LIMIT = 700;
export const JUNO_LABEL_LIMIT = 24;
export const DISCARD_NOTE = "The same description gives the same pattern. Change the wording to get a different one.";

export function isFlashLight(light) {
  return light?.flash !== false;
}

export function isRotatingOnly(light) {
  return light?.flash === false && Boolean(light?.rotate);
}

export function flashRows(setting) {
  const sirens = Array.isArray(setting?.sirens) ? setting.sirens : [];
  return sirens.flatMap((light, index) => (isFlashLight(light) ? [index] : []));
}

export function rotatingOnlyCount(setting) {
  const sirens = Array.isArray(setting?.sirens) ? setting.sirens : [];
  return sirens.filter(isRotatingOnly).length;
}

function axis(bounds, key) {
  const min = Number(bounds?.min?.[key]);
  const max = Number(bounds?.max?.[key]);
  return Number.isFinite(min) && Number.isFinite(max) && max > min ? { min, size: max - min } : null;
}

export function sirenPositionLabel(point, bounds, light) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  const z = Number(point?.z);
  if (!point || ![x, y, z].every(Number.isFinite)) return "unplaced";
  const width = axis(bounds, "x");
  const length = axis(bounds, "y");
  const height = axis(bounds, "z");
  if (!width || !length || !height) return "unplaced";
  const level = z >= height.min + height.size * 0.75 ? "roof" : "body";
  const along = (y - length.min) / length.size;
  const zone = along >= 2 / 3 ? "front" : along <= 1 / 3 ? "rear" : "mid";
  const across = x - (width.min + width.size / 2);
  const side = Math.abs(across) <= width.size / 10 ? "C" : across < 0 ? "L" : "R";
  const facing = facingFromDelta(sirenHeading(light));
  const label = `${level} ${zone} ${side}${facing ? `>${facing.id}` : ""}`;
  return label.slice(0, JUNO_LABEL_LIMIT);
}

export function sirenPositionLabels(setting, located) {
  const sirens = Array.isArray(setting?.sirens) ? setting.sirens : [];
  const points = new Map((located?.points || []).map((entry) => [entry.siren, entry.position]));
  return flashRows(setting).map((index) => sirenPositionLabel(points.get(index + 1), located?.bounds, sirens[index]));
}

export function describeVehicle({ modelName, entry, resourceName }) {
  const parts = [String(modelName || "").trim() || "vehicle"];
  for (const value of [entry?.gameName, entry?.vehicleMakeName, entry?.vehicleClass, entry?.type]) {
    const text = String(value || "").trim();
    if (text && !parts.some((part) => part.toLowerCase() === text.toLowerCase())) parts.push(text);
  }
  const resource = String(resourceName || "").trim();
  if (resource) parts.push(`in resource ${resource}`);
  return parts.join(", ").slice(0, 380);
}

export function sirenAsk({ setting, located, vehicle, ask }) {
  const rows = flashRows(setting);
  return {
    vehicle,
    setting: String(setting?.name || "").slice(0, 100),
    bpm: Math.max(0, Math.trunc(Number(setting?.sequencerBpm) || 0)),
    colors: rows.map((index) => String(setting.sirens[index].color || "")),
    positions: sirenPositionLabels(setting, located),
    ask: String(ask || "").trim().slice(0, JUNO_ASK_LIMIT),
  };
}

export function applySirenPattern(setting, result) {
  if (!setting || !result || !Array.isArray(result.flash)) return null;
  const rows = flashRows(setting);
  if (rows.length !== result.flash.length) return null;
  const sequencers = result.flash.map(sequencerFromPattern);
  if (sequencers.some((value) => value == null)) return null;
  const colors = Array.isArray(result.color) ? result.color : null;
  const next = updateSirens(setting, rows, (light, index) => {
    const row = rows.indexOf(index);
    light.flashiness = { ...light.flashiness, sequencer: sequencers[row] };
    if (colors?.[row]) light.color = String(colors[row]).toLowerCase();
    return light;
  });
  return Number.isFinite(result.bpm) ? { ...next, sequencerBpm: result.bpm } : next;
}

export function darkLightsNote(preview) {
  return checkSirenSetting(preview).find((entry) => entry.code === "EMPTY_PATTERN")?.message || "";
}
