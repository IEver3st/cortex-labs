// Pure helpers for Prop Studio: persisted state, manifest v9 lights and
// drawables, emissive levels, LOD choice, orientation and formatting. Nothing
// here touches three.js or Tauri, so it runs under node:test.

import { SHOWROOM_FLOORS as STAGE_FLOORS } from "./showroom-floors.js";
import { normalizeShowroomSubject } from "./studio-defaults.js";

export const PROP_MODEL_EXTENSIONS = Object.freeze(["ydr", "ydd", "yft"]);
export const PROP_VIEW_MODES = Object.freeze(["textured", "clay", "normals", "uv"]);
export const PROP_LODS = Object.freeze(["high", "med", "low", "vlow"]);
export const PROP_LOD_LABELS = Object.freeze({ high: "High", med: "Medium", low: "Low", vlow: "Very low" });
export const PROP_CAMERA_PRESETS = Object.freeze([
  { key: "front", label: "Front" },
  { key: "back", label: "Back" },
  { key: "left", label: "Left" },
  { key: "right", label: "Right" },
  { key: "top", label: "Top" },
  { key: "angle", label: "3/4" },
]);
export const THUMBNAIL_SIZES = Object.freeze([128, 256, 512, 1024, 2048]);
export const THUMBNAIL_ANGLES = Object.freeze(["camera", "front", "angle", "top"]);
const STAGE_LIGHTS = ["top", "front", "back", "left", "right"];
const HEX_RE = /^#[0-9a-f]{6}$/i;
const MAX_LIGHTS = 64;

/* ── Paths ── */

export function propModelFormat(path) {
  const match = /\.([a-z0-9]+)$/i.exec(String(path || "").trim());
  const extension = match?.[1]?.toLowerCase() || "";
  return PROP_MODEL_EXTENSIONS.includes(extension) ? extension : null;
}

export function isPropModelPath(path) {
  return propModelFormat(path) !== null;
}

function fileStem(path) {
  const name = String(path || "").split(/[\\/]/).pop() || "";
  return name.replace(/\.[^.]+$/, "");
}

/** `<model>_<size>.png`, or `<model>.png` for an inventory-style default. */
export function thumbnailFileName(modelPath, size, { suffix = "" } = {}) {
  const stem = fileStem(modelPath).replace(/[^\w.+-]+/g, "_") || "prop";
  const parts = [stem];
  if (suffix) parts.push(suffix);
  if (Number.isInteger(size)) parts.push(String(size));
  return `${parts.join("_")}.png`;
}

/* ── Persisted state ── */

function clamp(value, min, max, fallback) {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function bool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function oneOf(value, options, fallback) {
  return options.includes(value) ? value : fallback;
}

function stringList(value, limit = 16) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim() || out.includes(item)) continue;
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function flagMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "boolean" && key) out[key] = entry;
  }
  return out;
}

function levelMap(value, max) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key && typeof entry === "number" && Number.isFinite(entry)) out[key] = Math.min(max, Math.max(0, entry));
  }
  return out;
}

/**
 * Every Prop Studio setting with defaults; older or hand-edited workspace
 * state is clamped rather than trusted. `prefs` supplies the app's backdrop
 * colour, light level and showroom defaults for a new workspace.
 */
export function normalizePropState(value, prefs = {}) {
  const source = value && typeof value === "object" ? value : {};
  const scene = source.scene && typeof source.scene === "object" ? source.scene : {};
  const view = source.view && typeof source.view === "object" ? source.view : {};
  const emissive = source.emissive && typeof source.emissive === "object" ? source.emissive : {};
  const lights = source.lights && typeof source.lights === "object" ? source.lights : {};
  const thumbnail = source.thumbnail && typeof source.thumbnail === "object" ? source.thumbnail : {};
  const backdrop = HEX_RE.test(prefs.background || "") ? prefs.background : "#141414";
  const start = normalizeShowroomSubject(prefs.showroom, "prop");

  return {
    modelPath: typeof source.modelPath === "string" && isPropModelPath(source.modelPath) ? source.modelPath : "",
    extraYtds: stringList(source.extraYtds).filter((path) => /\.ytd$/i.test(path)),
    liveReload: bool(source.liveReload, true),
    cameraPreset: oneOf(source.cameraPreset, PROP_CAMERA_PRESETS.map((preset) => preset.key), "angle"),
    scene: {
      stage: oneOf(scene.stage, ["workbench", "showroom"], start.stage),
      light: oneOf(scene.light, STAGE_LIGHTS, start.light),
      spot: clamp(scene.spot, 0, 2, start.spot),
      reflect: clamp(scene.reflect, 0, 1, start.reflect),
      beam: bool(scene.beam, start.beam),
      rim: clamp(scene.rim, 0, 2, start.rim),
      floor: oneOf(scene.floor, STAGE_FLOORS, start.floor),
      grid: bool(scene.grid, true),
      shadows: bool(scene.shadows, true),
      ambientOcclusion: bool(scene.ambientOcclusion, false),
      backdrop: HEX_RE.test(scene.backdrop || "") ? scene.backdrop : backdrop,
      lightLevel: clamp(scene.lightLevel, 0, 3, clamp(prefs.light, 0, 3, 1)),
      // 0 = studio lights as set, 1 = studio fully dark so emissives and the
      // prop's own lights carry the shot.
      dark: clamp(scene.dark, 0, 1, start.dark),
    },
    view: {
      mode: oneOf(view.mode, PROP_VIEW_MODES, "textured"),
      wireframe: bool(view.wireframe, false),
      meshStats: bool(view.meshStats, false),
      collisions: bool(view.collisions, false),
      lod: oneOf(view.lod, PROP_LODS, "high"),
      drawable: Number.isInteger(view.drawable) && view.drawable >= -1 ? view.drawable : -1,
      origin: bool(view.origin, false),
      bounds: bool(view.bounds, false),
      turntable: bool(view.turntable, false),
      turntableSpeed: clamp(view.turntableSpeed, 2, 90, 20),
      orientation: normalizeOrientation(view.orientation),
      hiddenMaterials: flagMap(view.hiddenMaterials),
    },
    emissive: {
      enabled: bool(emissive.enabled, true),
      strength: clamp(emissive.strength, 0, 8, 1),
      glow: clamp(emissive.glow, 0, 3, 1),
      nightOnly: bool(emissive.nightOnly, true),
      useGameMultiplier: bool(emissive.useGameMultiplier, true),
      off: flagMap(emissive.off),
      levels: levelMap(emissive.levels, 8),
    },
    lights: {
      enabled: bool(lights.enabled, true),
      strength: clamp(lights.strength, 0, 4, 1),
      haze: clamp(lights.haze, 0, 2, 0.6),
      off: flagMap(lights.off),
    },
    thumbnail: {
      size: THUMBNAIL_SIZES.includes(thumbnail.size) ? thumbnail.size : 512,
      angle: oneOf(thumbnail.angle, THUMBNAIL_ANGLES, "camera"),
      padding: clamp(thumbnail.padding, 0, 0.5, 0.08),
      transparent: bool(thumbnail.transparent, true),
    },
  };
}

/* ── Orientation (quaternion [x, y, z, w], snapped to quarter turns) ── */

const IDENTITY = Object.freeze([0, 0, 0, 1]);
const HALF_SQRT2 = Math.SQRT1_2;

function snap(value) {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function normalizeOrientation(value) {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((item) => typeof item === "number" && Number.isFinite(item))) {
    return IDENTITY.slice();
  }
  const length = Math.hypot(...value);
  if (length < 1e-6) return IDENTITY.slice();
  const normalized = value.map((item) => snap(item / length));
  // q and -q are the same rotation; keep w non-negative so state compares equal.
  return normalized[3] < 0 ? normalized.map((item) => snap(-item)) : normalized;
}

function multiply(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Turns the model a quarter turn (direction 1 or -1) about a world axis. */
export function rotateOrientation(orientation, axis, direction = 1) {
  const sign = direction < 0 ? -1 : 1;
  const turn = {
    x: [sign * HALF_SQRT2, 0, 0, HALF_SQRT2],
    y: [0, sign * HALF_SQRT2, 0, HALF_SQRT2],
    z: [0, 0, sign * HALF_SQRT2, HALF_SQRT2],
  }[axis];
  if (!turn) return normalizeOrientation(orientation);
  return normalizeOrientation(multiply(turn, normalizeOrientation(orientation)));
}

export function isIdentityOrientation(orientation) {
  const q = normalizeOrientation(orientation);
  return q[0] === 0 && q[1] === 0 && q[2] === 0 && q[3] === 1;
}

/* ── Manifest v9: drawables and authored lights ── */

function vector3(value) {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const out = value.map(Number);
  return out.every(Number.isFinite) ? out : null;
}

export function normalizeManifestDrawables(manifest) {
  if (!Array.isArray(manifest?.drawables)) return [];
  const out = [];
  for (const entry of manifest.drawables) {
    const index = Number(entry?.index);
    if (!Number.isInteger(index) || index < 0 || out.some((item) => item.index === index)) continue;
    const name = typeof entry?.name === "string" && entry.name.trim() ? entry.name.trim() : `drawable_${index}`;
    out.push({ index, name });
  }
  return out.sort((a, b) => a.index - b.index);
}

/**
 * Validated lights from manifest v9 `lights[]`, in GTA model space. Entries
 * with non-finite vectors, an unknown type or a non-positive range are
 * dropped; the cone stays as authored (half-angle degrees, as CodeWalker
 * reads it). Direction is unit length or the light is dropped for a spot.
 */
export function normalizeModelLights(manifest) {
  if (!Array.isArray(manifest?.lights)) return [];
  const out = [];
  for (const entry of manifest.lights) {
    if (out.length >= MAX_LIGHTS) break;
    const type = ["point", "spot", "capsule"].includes(entry?.type) ? entry.type : null;
    const position = vector3(entry?.position);
    const rawDirection = vector3(entry?.direction);
    const falloff = Number(entry?.falloff);
    const intensity = Number(entry?.intensity);
    if (!type || !position || !Number.isFinite(falloff) || falloff <= 0 || !Number.isFinite(intensity)) continue;

    let direction = [0, 0, -1];
    if (rawDirection) {
      const length = Math.hypot(...rawDirection);
      if (length > 1e-6) direction = rawDirection.map((value) => value / length);
      else if (type === "spot") continue;
    } else if (type === "spot") {
      continue;
    }

    const color = Array.isArray(entry?.color) && entry.color.length === 3
      ? entry.color.map((value) => Math.min(255, Math.max(0, Math.round(Number(value) || 0))))
      : [255, 255, 255];
    const inner = Math.min(90, Math.max(0, Number(entry?.coneInnerAngle) || 0));
    const outer = Math.min(90, Math.max(inner, Number(entry?.coneOuterAngle) || 0));
    const drawableIndex = Number.isInteger(entry?.drawableIndex) && entry.drawableIndex >= 0 ? entry.drawableIndex : 0;
    const index = Number.isInteger(entry?.index) && entry.index >= 0 ? entry.index : out.length;
    out.push({
      id: `${drawableIndex}:${index}`,
      drawableIndex,
      index,
      type,
      position,
      direction,
      color,
      intensity: Math.max(0, intensity),
      falloff,
      falloffExponent: Number.isFinite(entry?.falloffExponent) ? Math.max(0, entry.falloffExponent) : 1,
      coneInnerAngle: inner,
      coneOuterAngle: outer,
      extent: vector3(entry?.extent) || [0, 0, 0],
      flashiness: Number.isInteger(entry?.flashiness) ? entry.flashiness : 0,
      volumeIntensity: Number.isFinite(entry?.volumeIntensity) ? Math.max(0, entry.volumeIntensity) : 0,
      coronaSize: Number.isFinite(entry?.coronaSize) ? Math.max(0, entry.coronaSize) : 0,
      coronaIntensity: Number.isFinite(entry?.coronaIntensity) ? Math.max(0, entry.coronaIntensity) : 0,
    });
  }
  return out;
}

export function lightColorHex(light) {
  const [r, g, b] = Array.isArray(light?.color) ? light.color : [255, 255, 255];
  return `#${[r, g, b].map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
}

const DEG = Math.PI / 180;
const MAX_SPOT_ANGLE = Math.PI / 2 - 0.01;

/**
 * three.js parameters for a GTA light. GTA attenuates by range rather than
 * inverse square, so the light uses decay 0 with its falloff as the cutoff
 * distance; intensity is the authored value times the user's strength. A
 * spot's cone is the authored half angle; the inner angle sets the penumbra.
 * Capsules preview as points.
 */
export function gtaLightToThree(light, strength = 1) {
  const scale = Number.isFinite(strength) ? Math.max(0, strength) : 1;
  const base = {
    kind: light?.type === "spot" ? "spot" : "point",
    color: (light?.color || [255, 255, 255]).map((value) => value / 255),
    intensity: Math.max(0, Number(light?.intensity) || 0) * scale,
    distance: Math.max(0.01, Number(light?.falloff) || 0.01),
    decay: 0,
  };
  if (base.kind !== "spot") return base;
  const outer = Math.min(MAX_SPOT_ANGLE, Math.max(0.01, (light.coneOuterAngle || 0) * DEG));
  const inner = Math.min(outer, Math.max(0, (light.coneInnerAngle || 0) * DEG));
  return { ...base, angle: outer, penumbra: outer > 0 ? Math.min(1, Math.max(0, 1 - inner / outer)) : 0 };
}

/* ── Emissives ── */

/**
 * Brightness for a shader emissiveMultiplier. Game values run from 0 to the
 * hundreds; the preview compresses them (square root, 0.25x to 4x) so a
 * strong lamp still reads brighter than a dim panel without blowing out.
 * Zero keeps the surface dark, as in game; no multiplier reads as 1x.
 */
export function emissiveLevel(multiplier) {
  if (multiplier === null || multiplier === undefined || !Number.isFinite(multiplier)) return 1;
  if (multiplier <= 0) return 0;
  return Math.min(4, Math.max(0.25, Math.sqrt(multiplier)));
}

export function isEmissiveShader(shaderName) {
  const name = String(shaderName || "").toLowerCase();
  return name.includes("emissive") || name.includes("lightsemissive");
}

/** Shaders the game lights only between dusk and dawn. */
export function isNightOnlyShader(shaderName) {
  return /emissivenight/i.test(String(shaderName || ""));
}

/* ── Materials, LODs ── */

/** Groups meshes that share a shader and colour texture into one inspector row. */
export function materialGroupKey(nativeMaterial, fallbackName = "") {
  const shader = String(nativeMaterial?.shaderName || "").toLowerCase();
  const bindings = Array.isArray(nativeMaterial?.textureBindings) ? nativeMaterial.textureBindings : [];
  const color = bindings.find((binding) => binding?.usage === "baseColor")?.textureName || "";
  const key = [shader, String(color).toLowerCase()].filter(Boolean).join("|");
  return key || `mesh:${String(fallbackName || "").toLowerCase() || "unnamed"}`;
}

export function materialGroupLabel(nativeMaterial, fallbackName = "") {
  const bindings = Array.isArray(nativeMaterial?.textureBindings) ? nativeMaterial.textureBindings : [];
  const color = bindings.find((binding) => binding?.usage === "baseColor")?.textureName;
  return color || nativeMaterial?.shaderName || fallbackName || "Material";
}

function normalizeLod(value) {
  const lod = String(value || "").toLowerCase().replace(/[^a-z]/g, "");
  if (lod === "medium") return "med";
  if (lod === "verylow") return "vlow";
  return lod;
}

/** LOD levels present in the meshes, best first. */
export function listAvailableLods(lodLevels) {
  const present = new Set((Array.isArray(lodLevels) ? lodLevels : []).map(normalizeLod));
  return PROP_LODS.filter((lod) => present.has(lod));
}

/**
 * The LOD to show for one drawable: the requested level when it exists,
 * otherwise the nearest more detailed one, otherwise the nearest less detailed.
 */
export function resolveLod(requested, available) {
  const levels = listAvailableLods(available);
  if (levels.length === 0) return null;
  const want = PROP_LODS.indexOf(normalizeLod(requested));
  if (want < 0) return levels[0];
  if (levels.includes(PROP_LODS[want])) return PROP_LODS[want];
  for (let index = want - 1; index >= 0; index -= 1) if (levels.includes(PROP_LODS[index])) return PROP_LODS[index];
  return levels.find((lod) => PROP_LODS.indexOf(lod) > want) || levels[0];
}

/* ── Formatting ── */

export function formatLength(metres) {
  if (!Number.isFinite(metres)) return "–";
  const value = Math.abs(metres);
  if (value < 0.01) return `${(metres * 1000).toFixed(1)} mm`;
  if (value < 1) return `${(metres * 100).toFixed(1)} cm`;
  return `${metres.toFixed(2)} m`;
}

export function formatCount(value) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "–";
}
