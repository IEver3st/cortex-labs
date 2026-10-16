/* ── Outfit generator ──
   Builds base-game outfits for the ped under the user's clothing from the
   game's own shop data (src/lib/data/eup-outfit-catalog.js). Everyday styles
   mix a top, bottoms and shoes; a top always brings the arm torso and
   undershirt the game pairs with it, so sleeves and chests line up. Service
   styles start from the game's uniform outfits and vary their season, tie,
   hat and accessories. Generation is deterministic for a seed. */

import { drawableNumberFor } from "./eup.js";

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

export const OUTFIT_STYLES = Object.freeze([
  { id: "casual", label: "Casual", kind: "everyday" },
  { id: "street", label: "Streetwear", kind: "everyday" },
  { id: "smart", label: "Smart casual", kind: "everyday" },
  { id: "business", label: "Business", kind: "everyday" },
  { id: "work", label: "Workwear", kind: "everyday" },
  { id: "athletic", label: "Athletic", kind: "everyday" },
  { id: "winter", label: "Cold weather", kind: "everyday" },
  { id: "lspd", label: "LSPD patrol", kind: "service" },
  { id: "sheriff", label: "Sheriff", kind: "service", note: "GTA has no sheriff patches, so the uniform is plain." },
  { id: "highway", label: "Highway Patrol", kind: "service" },
  { id: "ranger", label: "Park Ranger", kind: "service" },
  { id: "swat", label: "SWAT", kind: "service" },
  { id: "corrections", label: "Corrections", kind: "service" },
  { id: "detective", label: "Detective", kind: "service" },
  { id: "fib", label: "FIB agent", kind: "service" },
  { id: "security", label: "Security", kind: "service" },
  { id: "military", label: "Military", kind: "service" },
  { id: "coastguard", label: "Coast Guard", kind: "service" },
  { id: "pilot", label: "Pilot", kind: "service" },
]);

/** Slots a generated outfit owns. Face and hair stay as they are. */
export const OUTFIT_COMPONENTS = Object.freeze(["berd", "uppr", "lowr", "hand", "feet", "teef", "accs", "task", "decl", "jbib"]);
export const OUTFIT_PROPS = Object.freeze(["p_head", "p_eyes", "p_ears", "p_lwrist", "p_rwrist"]);

// Everyday styles: how often each accessory turns up, and how strongly the
// top (`topNeutral`) and the bottoms and shoes (`neutral`) keep to neutral
// colourways.
const EVERYDAY = Object.freeze({
  casual: { hat: 0.3, glasses: 0.25, watch: 0.3, topNeutral: 0.35, neutral: 0.75 },
  street: { hat: 0.45, glasses: 0.3, watch: 0.3, topNeutral: 0.3, neutral: 0.6 },
  smart: { hat: 0.12, glasses: 0.3, watch: 0.6, topNeutral: 0.6, neutral: 0.9 },
  business: { hat: 0.12, glasses: 0.2, watch: 0.7, topNeutral: 0.85, neutral: 1 },
  work: { hat: 0.4, glasses: 0.15, watch: 0.3, topNeutral: 0.6, neutral: 0.85 },
  athletic: { hat: 0.35, glasses: 0.3, watch: 0.4, topNeutral: 0.25, neutral: 0.6 },
  winter: { hat: 0.6, glasses: 0.1, watch: 0.2, topNeutral: 0.6, neutral: 0.85 },
  // Plain clothes: a jacket and tie in a quiet colourway, never a bare
  // waistcoat or a tux.
  detective: {
    pool: "business", hat: 0.1, glasses: 0.2, watch: 0.6, neutral: 1, neutralTop: true,
    top: (entry) => Boolean(entry.f?.teef) && /\b(Jacket|Coat|Blazer|Double Suit)\b/.test(entry.n),
  },
});

// Service styles: how often the uniform's own hat stays on, and how often
// glasses or a watch are added.
const SERVICE = Object.freeze({
  lspd: { hat: 0.5, glasses: 0.3, watch: 0.4 },
  sheriff: { hat: 0, glasses: 0.35, watch: 0.4 },
  highway: { hat: 0.6, glasses: 0.35, watch: 0.4 },
  ranger: { hat: 0.7, glasses: 0.25, watch: 0.4 },
  swat: { hat: 0.85, glasses: 0, watch: 0 },
  corrections: { hat: 0.5, glasses: 0.2, watch: 0.4 },
  fib: { hat: 1, glasses: 0.3, watch: 0.6 },
  security: { hat: 1, glasses: 0.2, watch: 0.3 },
  military: { hat: 0.8, glasses: 0, watch: 0 },
  coastguard: { hat: 1, glasses: 0.2, watch: 0.3 },
  pilot: { hat: 1, glasses: 0, watch: 0 },
});

/** Seeded generator (mulberry32): the same seed gives the same outfit. */
export function createRandom(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, list) => list[Math.floor(rng() * list.length)];

/**
 * An availability check over the player's install: the in-game number of a
 * collection drawable with that texture letter, or null when the install
 * lacks either. `gameIndexes` is the per-slot index the base body uses.
 */
export function gameAvailability(gameIndexes) {
  return (component, folder, local, letter) => {
    const index = gameIndexes?.[component];
    const number = drawableNumberFor(index?.ranges, folder, local);
    if (number === null) return null;
    const letters = index.variants?.get?.(number);
    if (!Array.isArray(letters) || !letters.includes(letter)) return null;
    return number;
  };
}

function partOf(catalog, component, tuple, letter) {
  return { component, folder: catalog.folders[tuple[0]], local: tuple[1], letter };
}

// A forced or uniform part as [folder, local, texture].
function fixedPart(catalog, component, tuple) {
  const letter = LETTERS[tuple[2]];
  return letter ? partOf(catalog, component, tuple, letter) : null;
}

function isAvailable(available, part) {
  return Boolean(part) && available(part.component, part.folder, part.local, part.letter) !== null;
}

function hasStyle(entry, style) {
  return ` ${entry.s} `.includes(` ${style} `);
}

// One piece from a list: a drawable the install has, then a texture letter.
// With probability `neutral` (always, with `neutralOnly`) the piece is one
// that comes in a neutral colourway, worn in it.
function pickPiece(rng, catalog, list, component, style, available, { neutral = 0, neutralOnly = false, filter = null } = {}) {
  const candidates = [];
  for (const entry of list || []) {
    if (style && !hasStyle(entry, style)) continue;
    if (filter && !filter(entry)) continue;
    const folder = catalog.folders[entry.r[0]];
    const letters = [...entry.t].filter((letter) => (!neutralOnly || (entry.q || "").includes(letter))
      && available(component, folder, entry.r[1], letter) !== null);
    if (letters.length === 0) continue;
    const forced = Object.entries(entry.f || {}).map(([slot, tuple]) => fixedPart(catalog, slot, tuple));
    if (!forced.every((part) => isAvailable(available, part))) continue;
    candidates.push({ entry, letters, forced });
  }
  if (candidates.length === 0) return null;
  const neutralOf = (candidate) => candidate.letters.filter((letter) => (candidate.entry.q || "").includes(letter));
  const neutralCandidates = candidates.filter((candidate) => neutralOf(candidate).length > 0);
  const wantNeutral = neutralCandidates.length > 0 && rng() < neutral;
  const chosen = pick(rng, wantNeutral ? neutralCandidates : candidates);
  const { entry, forced } = chosen;
  const letter = pick(rng, wantNeutral ? neutralOf(chosen) : chosen.letters);
  const color = entry.c?.[entry.t.indexOf(letter)] || "";
  return {
    part: partOf(catalog, component, entry.r, letter),
    forced,
    name: `${color} ${entry.n}`.trim(),
  };
}

function addAccessories(rng, catalog, parts, names, available, odds, style) {
  const add = (list, component, chance, poolStyle) => {
    if (!(chance > 0) || rng() >= chance) return;
    const piece = pickPiece(rng, catalog, list, component, poolStyle, available, { neutral: 0.8 });
    if (!piece) return;
    parts[component] = piece.part;
    names.push(piece.name);
  };
  if (style) add(catalog.hats, "p_head", odds.hat, style);
  add(catalog.glasses, "p_eyes", odds.glasses, null);
  add(catalog.watches, "p_lwrist", odds.watch, null);
}

function generateEveryday(rng, catalog, style, available) {
  const odds = EVERYDAY[style];
  const pool = odds.pool || style;
  const parts = {};
  const names = [];
  const top = pickPiece(rng, catalog, catalog.tops, "jbib", pool, available, {
    neutral: odds.topNeutral || 0,
    neutralOnly: Boolean(odds.neutralTop),
    filter: odds.top || null,
  });
  if (!top) return null;
  parts.jbib = top.part;
  names.push(top.name);
  for (const forced of top.forced) parts[forced.component] = forced;
  if (!parts.lowr) {
    const bottom = pickPiece(rng, catalog, catalog.bottoms, "lowr", pool, available, { neutral: odds.neutral });
    if (!bottom) return null;
    parts.lowr = bottom.part;
    names.push(bottom.name);
  }
  if (!parts.feet) {
    const shoes = pickPiece(rng, catalog, catalog.shoes, "feet", pool, available, { neutral: odds.neutral });
    if (!shoes) return null;
    parts.feet = shoes.part;
    names.push(shoes.name);
  }
  addAccessories(rng, catalog, parts, names, available, odds, pool);
  return { parts, name: names.slice(0, 3).join(", "), pieces: names };
}

function generateService(rng, catalog, style, available) {
  const odds = SERVICE[style];
  const variants = (catalog.uniforms?.[style] || [])
    .map((variant) => ({
      name: variant.n,
      parts: Object.fromEntries(Object.entries(variant.p).map(([component, tuple]) => [component, fixedPart(catalog, component, tuple)])),
    }))
    .filter((variant) => Object.values(variant.parts).every((part) => isAvailable(available, part)));
  if (variants.length === 0) return null;
  const variant = pick(rng, variants);
  const parts = { ...variant.parts };
  if (parts.p_head && rng() >= odds.hat) delete parts.p_head;
  const names = [];
  addAccessories(rng, catalog, parts, names, available, { ...odds, hat: 0 }, null);
  return { parts, name: variant.name, pieces: names };
}

/**
 * A generated outfit for one ped, or null when the player's install has none
 * of the clothing the style needs.
 *
 * @param {object} catalog EUP_OUTFIT_CATALOG[gender]
 * @param {{ style: string, seed: number, available: Function }} options
 * @returns {{ style: string, seed: number, name: string, pieces: string[], parts: Object<string, {component, folder, local, letter}> } | null}
 */
export function generateOutfit(catalog, { style, seed, available } = {}) {
  if (!catalog || typeof available !== "function") return null;
  const rng = createRandom(seed);
  const result = EVERYDAY[style]
    ? generateEveryday(rng, catalog, style, available)
    : SERVICE[style]
      ? generateService(rng, catalog, style, available)
      : null;
  return result ? { style, seed, ...result } : null;
}

/** What the outfit slots of a ped's overrides wear, comparable between renders. */
export function outfitSignature(overrides) {
  const slot = (component, prop) => {
    const value = overrides?.[component];
    if (prop ? value?.enabled !== true : value?.enabled === false) return "off";
    if (!Number.isInteger(value?.index)) return prop ? "off" : "base";
    return `${value.index}${/^[a-z]$/.test(value.variant || "") ? value.variant : "a"}`;
  };
  return [
    ...OUTFIT_COMPONENTS.map((component) => `${component}:${slot(component, false)}`),
    ...OUTFIT_PROPS.map((component) => `${component}:${slot(component, true)}`),
  ].join(" ");
}

/**
 * Base-slot overrides with a generated outfit worn: every outfit slot it does
 * not use goes back to the bare body, its props come off, and face and hair
 * keep the user's choice.
 */
export function overridesWithOutfit(overrides, outfit, available) {
  const next = { ...(overrides || {}) };
  for (const component of OUTFIT_COMPONENTS) delete next[component];
  for (const component of OUTFIT_PROPS) next[component] = { ...(next[component] || {}), enabled: false };
  for (const part of Object.values(outfit?.parts || {})) {
    const index = available(part.component, part.folder, part.local, part.letter);
    if (index === null) continue;
    next[part.component] = { index, variant: part.letter, enabled: true };
  }
  return next;
}
