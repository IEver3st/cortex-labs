// EUP Studio cast: the characters standing on the stage.
//
// Character A is always there. Character B is optional and stands beside it
// with its own ped, look, outfit and worn addon pieces. The addon piece files
// are one library shared by both; each character keeps the ids it wears.
//
// Workspaces keep character A in the top-level fields they have always used,
// so tabs saved before the cast existed restore as character A alone. B is
// stored under `partner`. Pure helpers shared by EupPage and Node tests.

import { DEFAULT_RACE, RACE_IDS, normalizeAddonPieces, normalizeHair, normalizeSkinTone } from "./eup.js";
import { normalizeCustomAnimation, normalizeHeldProps, normalizePoseId } from "./ped-pose.js";
import { normalizeCharacterModel, normalizePedVariations } from "./ped-character.js";

export const CAST_SEATS = Object.freeze(["a", "b"]);
/** Metres between the two characters' centres. */
export const CAST_SPACING = 1;

export function castLetter(seat) {
  return seat === "b" ? "B" : "A";
}

function normalizeGender(value) {
  return value === "female" ? "female" : "male";
}

function normalizePerGender(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    male: source.male && typeof source.male === "object" ? source.male : {},
    female: source.female && typeof source.female === "object" ? source.female : {},
  };
}

/** The library with `worn` set from one character's worn ids. */
export function projectPieces(library, worn) {
  const ids = new Set(Array.isArray(worn) ? worn : []);
  return (library || []).map((piece) => ({ ...piece, worn: ids.has(piece.id) }));
}

/** Worn ids that still name a library piece, one per ped slot (the first wins). */
export function cleanWornIds(library, worn) {
  return normalizeAddonPieces(projectPieces(library, worn))
    .filter((piece) => piece.worn)
    .map((piece) => piece.id);
}

export function normalizeCastMember(raw, library = []) {
  const source = raw && typeof raw === "object" ? raw : {};
  // A freemode model follows the character's gender; a game pick of a
  // freemode ped carries its own.
  const model = normalizeCharacterModel(source.model, source.gender);
  return {
    gender: model.kind === "freemode" ? model.gender : normalizeGender(source.gender),
    // Which ped this is (freemode, a game ped or the user's ped files) and the
    // drawables, textures and props chosen per custom character.
    model,
    variations: normalizePedVariations(source.variations),
    race: RACE_IDS.includes(source.race) ? source.race : DEFAULT_RACE,
    pose: normalizePoseId(source.pose),
    // The clip behind the Custom pose, and props hung from the ped's bones.
    animation: normalizeCustomAnimation(source.animation),
    heldProps: normalizeHeldProps(source.heldProps),
    skinTone: normalizeSkinTone(source.skinTone),
    hair: normalizeHair(source.hair),
    selections: normalizePerGender(source.selections),
    baseOverrides: normalizePerGender(source.baseOverrides),
    worn: cleanWornIds(library, source.worn),
  };
}

/**
 * A new character in the game's default outfit, posed like `like` so the two
 * move together. `model` makes it a game ped or the user's ped instead.
 */
export function createCastMember(gender, like = null, model = null) {
  return normalizeCastMember({ gender, model, pose: like?.pose, animation: like?.animation, race: like?.race });
}

/**
 * Cast from a saved workspace: `{ pieces, a, b, focus }`. `pieces` is the
 * shared library without worn flags; older workspaces carry character A's
 * worn flags on the pieces themselves.
 */
export function restoreCast(state) {
  const source = state && typeof state === "object" ? state : {};
  const restored = normalizeAddonPieces(source.pieces);
  const pieces = restored.map(({ worn: _worn, ...piece }) => piece);
  const a = normalizeCastMember(
    { ...source, worn: restored.filter((piece) => piece.worn).map((piece) => piece.id) },
    pieces,
  );
  const b = source.partner && typeof source.partner === "object" ? normalizeCastMember(source.partner, pieces) : null;
  return { pieces, a, b, focus: b && source.focus === "b" ? "b" : "a" };
}

/** Workspace fields for a cast; the inverse of restoreCast. */
export function castSnapshot({ pieces, a, b, focus }) {
  const { worn, ...look } = a;
  return {
    ...look,
    pieces: projectPieces(pieces, worn),
    partner: b || null,
    focus: b && focus === "b" ? "b" : "a",
  };
}

/**
 * Applies a new piece list for one character. `next` carries that character's
 * worn flags; the other character keeps its own, minus pieces that are gone.
 */
export function applyCastPieces(cast, seat, next) {
  const pieces = (next || []).map(({ worn: _worn, ...piece }) => piece);
  const result = { ...cast, pieces };
  for (const key of CAST_SEATS) {
    const member = cast[key];
    if (!member) continue;
    const worn = key === seat
      ? cleanWornIds(pieces, (next || []).filter((piece) => piece.worn).map((piece) => piece.id))
      : cleanWornIds(pieces, member.worn);
    result[key] = { ...member, worn };
  }
  return result;
}

/** Stage X of each seat in the cast: one character at the centre, two side by side. */
export function castOffsets(cast) {
  return cast?.b ? { a: -CAST_SPACING / 2, b: CAST_SPACING / 2 } : { a: 0, b: CAST_SPACING / 2 };
}
