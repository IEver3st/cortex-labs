// Custom EUP Studio characters: a game ped or the user's own ped files, next to
// the freemode peds the clothing workflow is built on.
//
// A cast member's `model` says which ped it is:
//   { kind: "freemode", gender }          the default; older snapshots restore to it
//   { kind: "game", ped }                 any ped in the game files
//   { kind: "file", ped, paths }          the user's ped files or folders
// The bridge describes a custom ped (describeGamePed / describePedFiles): its
// skeleton, the drawables and textures each component offers, its props per
// anchor, and the files those live in. `variations` keeps the drawable and
// texture chosen per component and the props worn, per character.
//
// Pure helpers shared by the EUP page and Node tests.

import { COMPONENT_IDS, GENDER_FOR_PED } from "./eup.js";

export const CHARACTER_KINDS = Object.freeze(["freemode", "game", "file"]);

const PED_NAME = /^[a-z0-9_]{1,64}$/;
// A ped name taken from the user's file names: no separators or control characters.
const FILE_PED_NAME = /^[^/\\:\u0000-\u001f]{1,128}$/;
const ANCHOR_NAME = /^ph?_[a-z]{2,8}$/;
const MAX_PICKED_PATHS = 64;
const MAX_PATH_LENGTH = 1024;
const MAX_ANCHORS = 16;
const MAX_DRAWABLE_INDEX = 254;
const MAX_TEXTURE_INDEX = 25;
const MAX_BONES = 1024;
const ROOT_PARENT = 65535;
/** Characters whose variations are remembered; the oldest are dropped first. */
export const MAX_REMEMBERED_VARIATIONS = 16;
/**
 * Share of a clip's rotation tracks the skeleton must have for the clip to
 * play. Human clips on human peds match every track; on a dog skeleton they
 * match about 55%, and a dog clip on a human about 65%. A dog clip on a dog
 * matches 87%: some tracks drive bones only one breed has.
 */
export const CLIP_MATCH_THRESHOLD = 0.75;

const COMPONENT_LABELS = Object.freeze({
  head: "Head",
  berd: "Beard / mask",
  hair: "Hair",
  uppr: "Upper body",
  lowr: "Lower body",
  hand: "Hands",
  feet: "Feet",
  teef: "Teeth / neck",
  accs: "Accessories",
  task: "Task gear",
  decl: "Decals",
  jbib: "Overlay",
});

const ANCHOR_LABELS = Object.freeze({
  p_head: "Hat",
  p_eyes: "Glasses",
  p_ears: "Ears",
  p_mouth: "Mouth",
  p_lhand: "Left hand",
  p_rhand: "Right hand",
  p_lwrist: "Left wrist",
  p_rwrist: "Right wrist",
  p_lhip: "Hip",
  p_hip: "Hip",
  p_lfoot: "Left foot",
  p_rfoot: "Right foot",
  ph_lhand: "Left hand (held)",
  ph_rhand: "Right hand (held)",
});

export function characterComponentLabel(component) {
  return COMPONENT_LABELS[component] || component;
}

export function characterAnchorLabel(anchor) {
  return ANCHOR_LABELS[anchor] || anchor;
}

function normalizeGender(value) {
  return value === "female" ? "female" : "male";
}

/** "male"/"female" for the two freemode peds, null for every other name. */
export function freemodeGenderOf(ped) {
  return GENDER_FOR_PED[ped] || null;
}

/**
 * A ped name's gender when the game's naming says so (`s_m_y_cop_01`,
 * `a_f_y_hipster_01`), else null. It picks the default preset clips only.
 */
export function pedGenderHint(ped) {
  const match = /^[a-z]+_([mf])_/.exec(String(ped || ""));
  if (!match) return null;
  return match[1] === "f" ? "female" : "male";
}

function normalizePaths(value) {
  const seen = new Set();
  const paths = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item !== "string") continue;
    const path = item.trim();
    if (!path || path.length > MAX_PATH_LENGTH || /[\u0000-\u001f]/.test(path)) continue;
    const key = path.replace(/\//g, "\\").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(path);
    if (paths.length >= MAX_PICKED_PATHS) break;
  }
  return paths;
}

/**
 * The character a cast member is. Anything unrecognised is the freemode ped of
 * `gender`, so snapshots saved before custom characters restore unchanged. A
 * game pick of a freemode ped is the freemode character itself.
 */
export function normalizeCharacterModel(raw, gender = "male") {
  const fallback = { kind: "freemode", gender: normalizeGender(gender) };
  if (!raw || typeof raw !== "object") return fallback;
  if (raw.kind === "game") {
    const ped = typeof raw.ped === "string" ? raw.ped.trim().toLowerCase() : "";
    if (!PED_NAME.test(ped)) return fallback;
    const freemode = freemodeGenderOf(ped);
    return freemode ? { kind: "freemode", gender: freemode } : { kind: "game", ped };
  }
  if (raw.kind === "file") {
    const paths = normalizePaths(raw.paths);
    if (paths.length === 0) return fallback;
    const name = typeof raw.ped === "string" ? raw.ped.trim().toLowerCase() : "";
    return { kind: "file", ped: FILE_PED_NAME.test(name) ? name : "", paths };
  }
  return fallback;
}

export function isCustomCharacter(model) {
  return model?.kind === "game" || model?.kind === "file";
}

function hashText(text) {
  // FNV-1a: short, stable keys for long path lists.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** A stable identity for a character: variations and descriptions are kept under it. */
export function characterKey(model) {
  if (model?.kind === "game") return `game:${model.ped}`;
  if (model?.kind === "file") {
    const paths = (model.paths || []).map((path) => path.replace(/\//g, "\\").toLowerCase()).sort();
    return `file:${model.ped || ""}:${hashText(paths.join("|"))}`;
  }
  return `freemode:${normalizeGender(model?.gender)}`;
}

function fileName(path) {
  return String(path || "").split(/[\\/]/).filter(Boolean).pop() || "";
}

/** What the character picker and cast list call a character. */
export function characterLabel(model) {
  if (model?.kind === "game") return model.ped;
  if (model?.kind === "file") return model.ped || fileName(model.paths?.[0]) || "Ped files";
  return model?.gender === "female" ? "Freemode female" : "Freemode male";
}

/**
 * A character's name once its description is in: the ped the bridge resolved
 * (a ped file selection names it only then), else {@link characterLabel}.
 */
export function characterName(model, description) {
  return (isCustomCharacter(model) && description?.ped) || characterLabel(model);
}

function boundedIndex(value, max) {
  return Number.isInteger(value) && value >= 0 && value <= max ? value : null;
}

function normalizeChoice(raw, field) {
  if (!raw || typeof raw !== "object") return null;
  const index = boundedIndex(raw[field], MAX_DRAWABLE_INDEX);
  if (index === null) return null;
  return { [field]: index, texture: boundedIndex(raw.texture, MAX_TEXTURE_INDEX) ?? 0 };
}

/**
 * One character's choices: `components` maps a component to
 * `{ drawable, texture }` and `props` an anchor to `{ prop, texture }`.
 * A component without a choice wears drawable 0; an anchor without one is bare.
 */
export function normalizePedVariation(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const components = {};
  for (const component of COMPONENT_IDS) {
    const choice = normalizeChoice(source.components?.[component], "drawable");
    if (choice) components[component] = choice;
  }
  const props = {};
  for (const [anchor, value] of Object.entries(source.props && typeof source.props === "object" ? source.props : {})) {
    if (!ANCHOR_NAME.test(anchor) || Object.keys(props).length >= MAX_ANCHORS) continue;
    const choice = normalizeChoice(value, "prop");
    if (choice) props[anchor] = choice;
  }
  return { components, props };
}

const VARIATION_KEY = /^(game|file):[^\u0000-\u001f]{1,160}$/;

/** Variations per custom character key, the most recent {@link MAX_REMEMBERED_VARIATIONS}. */
export function normalizePedVariations(raw) {
  const entries = Object.entries(raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {})
    .filter(([key]) => VARIATION_KEY.test(key))
    .slice(-MAX_REMEMBERED_VARIATIONS);
  return Object.fromEntries(entries.map(([key, value]) => [key, normalizePedVariation(value)]));
}

/** `variations` with one character's entry replaced, kept as the most recent. */
export function withCharacterVariation(variations, key, variation) {
  const { [key]: _previous, ...rest } = variations && typeof variations === "object" ? variations : {};
  return normalizePedVariations({ ...rest, [key]: variation });
}

/** A variation with `component` set to `{ drawable, texture }`. */
export function withComponentChoice(variation, component, choice) {
  const current = normalizePedVariation(variation);
  return normalizePedVariation({ ...current, components: { ...current.components, [component]: choice } });
}

/** A variation with the prop on `anchor` set to `{ prop, texture }`, or removed with null. */
export function withPropChoice(variation, anchor, choice) {
  const current = normalizePedVariation(variation);
  const props = { ...current.props };
  if (choice) props[anchor] = choice;
  else delete props[anchor];
  return normalizePedVariation({ ...current, props });
}

function clampIndex(value, count) {
  if (count <= 0) return 0;
  return Number.isInteger(value) ? Math.min(Math.max(value, 0), count - 1) : 0;
}

/**
 * The slots a described character wears: every component on its chosen (or
 * first) drawable and texture, and each anchor whose chosen prop the ped has.
 * Choices beyond what the ped offers clamp to its last drawable or texture.
 * Each slot is `{ slot, kind, index, texture, count, textureCount, name,
 * drawable, diffuse, normal }` with the description's file references.
 */
export function resolveCharacterSlots(description, variation) {
  const slots = [];
  const chosen = normalizePedVariation(variation);
  for (const component of Array.isArray(description?.components) ? description.components : []) {
    const list = Array.isArray(component?.drawables) ? component.drawables : [];
    if (list.length === 0 || !COMPONENT_IDS.includes(component.component)) continue;
    const choice = chosen.components[component.component];
    const index = clampIndex(choice?.drawable ?? 0, list.length);
    const entry = list[index];
    const textures = Array.isArray(entry?.textures) ? entry.textures : [];
    const texture = clampIndex(choice?.texture ?? 0, textures.length);
    slots.push({
      slot: component.component,
      kind: "component",
      index,
      texture,
      count: list.length,
      textureCount: textures.length,
      name: entry?.drawable?.name || entry?.name || "",
      drawable: entry?.drawable || null,
      diffuse: textures[texture]?.diffuse || null,
      normal: entry?.normal || null,
    });
  }
  for (const anchor of Array.isArray(description?.props) ? description.props : []) {
    const choice = chosen.props[anchor?.anchor];
    if (!choice) continue;
    const prop = (anchor.props || []).find((item) => item?.index === choice.prop);
    if (!prop) continue;
    const textures = Array.isArray(prop.textures) ? prop.textures : [];
    const texture = clampIndex(choice.texture, textures.length);
    slots.push({
      slot: anchor.anchor,
      kind: "prop",
      index: prop.index,
      texture,
      count: anchor.props.length,
      textureCount: textures.length,
      name: prop.drawable?.name || prop.name || "",
      drawable: prop.drawable || null,
      diffuse: textures[texture]?.diffuse || null,
      normal: prop.normal || null,
    });
  }
  return slots;
}

function finiteList(value, length) {
  return Array.isArray(value) && value.length === length && value.every((item) => Number.isFinite(item));
}

/**
 * The bridge's `skeleton.bones` (`{ name, tag, parent, translation, rotation }`,
 * parent -1 for a root) in the shape the ped renderer uses for drawables'
 * embedded skeletons: local `q*`/`t*`, `parentIndex` (65535 for a root),
 * `tag`, and the bind world transform in `world*`. Null when the list is
 * empty, too long or holds a non-finite transform.
 */
export function skeletonFromDescription(bones) {
  if (!Array.isArray(bones) || bones.length === 0 || bones.length > MAX_BONES) return null;
  if (!bones.every((bone) => finiteList(bone?.translation, 3) && finiteList(bone?.rotation, 4))) return null;
  const result = bones.map((bone, index) => {
    const [tx, ty, tz] = bone.translation;
    const [qx, qy, qz, qw] = bone.rotation;
    const parent = Number.isInteger(bone.parent) && bone.parent >= 0 && bone.parent < bones.length && bone.parent !== index
      ? bone.parent
      : ROOT_PARENT;
    return {
      name: typeof bone.name === "string" ? bone.name : "",
      qx, qy, qz, qw, tx, ty, tz,
      parentIndex: parent,
      tag: (Number(bone.tag) >>> 0) & 0xffff,
      worldQx: qx, worldQy: qy, worldQz: qz, worldQw: qw,
      worldTx: tx, worldTy: ty, worldTz: tz,
    };
  });
  // 0 unvisited, 1 resolving, 2 resolved. A parent loop leaves the bone where
  // the loop closes as a root rather than recursing forever.
  const state = new Uint8Array(result.length);
  const resolve = (index) => {
    if (state[index] === 2) return;
    state[index] = 1;
    const bone = result[index];
    const parentIndex = bone.parentIndex;
    if (parentIndex !== ROOT_PARENT && state[parentIndex] === 1) {
      bone.parentIndex = ROOT_PARENT;
    } else if (parentIndex !== ROOT_PARENT) {
      resolve(parentIndex);
      const p = result[parentIndex];
      bone.worldQx = p.worldQx * bone.qw + p.worldQw * bone.qx + p.worldQy * bone.qz - p.worldQz * bone.qy;
      bone.worldQy = p.worldQy * bone.qw + p.worldQw * bone.qy + p.worldQz * bone.qx - p.worldQx * bone.qz;
      bone.worldQz = p.worldQz * bone.qw + p.worldQw * bone.qz + p.worldQx * bone.qy - p.worldQy * bone.qx;
      bone.worldQw = p.worldQw * bone.qw - p.worldQx * bone.qx - p.worldQy * bone.qy - p.worldQz * bone.qz;
      const [x, y, z] = rotate(p.worldQx, p.worldQy, p.worldQz, p.worldQw, bone.tx, bone.ty, bone.tz);
      bone.worldTx = x + p.worldTx;
      bone.worldTy = y + p.worldTy;
      bone.worldTz = z + p.worldTz;
    }
    state[index] = 2;
  };
  for (let index = 0; index < result.length; index += 1) resolve(index);
  return { bones: result };
}

// The same rotation yft.js applies to drawables' embedded skeletons.
function rotate(qx, qy, qz, qw, vx, vy, vz) {
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + qy * tz - qz * ty,
    vy + qw * ty + qz * tx - qx * tz,
    vz + qw * tz + qx * ty - qy * tx,
  ];
}

/**
 * How well a clip fits a skeleton: rotation tracks whose bone tag the
 * skeleton has, out of all of them. `fits` is false below
 * {@link CLIP_MATCH_THRESHOLD}, where the pose would come out broken.
 */
export function clipSkeletonMatch(skeleton, clip) {
  const tags = new Set((skeleton?.bones || []).map((bone) => bone.tag));
  const tracks = Array.isArray(clip?.rotations) ? clip.rotations : [];
  const matched = tracks.filter((track) => tags.has(track?.bone)).length;
  const total = tracks.length;
  return { matched, total, fits: total === 0 || matched / total >= CLIP_MATCH_THRESHOLD };
}

/** Why a clip that loaded isn't played on `name`, from a failed {@link clipSkeletonMatch}. */
export function clipRefusedNote(fit, name) {
  return `This animation is made for a different skeleton: ${fit.matched} of its ${fit.total} animated bones exist on ${name}, so it keeps its rest pose.`;
}

/**
 * Whether a slot's drawable may stay on screen while its replacement loads:
 * a new revision of the same file or piece, or the same base drawable. A
 * drawable skinned to another skeleton (a custom character's slot and a
 * freemode one, or two characters') would tear under the new pose, so it goes
 * at once. Slot specs carry `source`, `drawablePath` and, for a custom
 * character, `modelKey`.
 */
export function keepsSlotOnScreen(previous, next) {
  if (!previous || !next) return false;
  const rig = (slot) => (slot.source === "character" ? `character|${slot.modelKey || ""}` : "freemode");
  if (rig(previous) !== rig(next)) return false;
  return next.source !== "base" || Boolean(next.drawablePath && next.drawablePath === previous.drawablePath);
}

/** The candidate ped names a ped file selection offers, or [] when it resolved. */
export function describedCandidates(description) {
  return description && !description.ped && Array.isArray(description.candidates)
    ? description.candidates.filter((name) => typeof name === "string" && name)
    : [];
}
