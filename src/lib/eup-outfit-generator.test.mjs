import test from "node:test";
import assert from "node:assert/strict";

import { EUP_OUTFIT_CATALOG } from "./data/eup-outfit-catalog.js";
import {
  OUTFIT_COMPONENTS,
  OUTFIT_PROPS,
  OUTFIT_STYLES,
  createRandom,
  gameAvailability,
  generateOutfit,
  outfitSignature,
  overridesWithOutfit,
} from "./eup-outfit-generator.js";

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const GENDERS = ["male", "female"];
const everything = () => 1;

// An availability check numbering each collection file the way an install would.
function syntheticAvailability(catalog, { without = [] } = {}) {
  const numbers = new Map();
  return (component, folder, local, letter) => {
    if (without.includes(folder) || !LETTERS.includes(letter)) return null;
    const key = `${component}/${folder}/${local}`;
    if (!numbers.has(key)) numbers.set(key, numbers.size);
    return numbers.get(key);
  };
}

test("createRandom repeats for a seed", () => {
  const a = createRandom(42);
  const b = createRandom(42);
  const first = [a(), a(), a()];
  assert.deepEqual([b(), b(), b()], first);
  assert.ok(first.every((value) => value >= 0 && value < 1));
});

test("the catalogue only points at its own collections and valid letters", () => {
  for (const gender of GENDERS) {
    const catalog = EUP_OUTFIT_CATALOG[gender];
    const folderOk = (index) => Number.isInteger(index) && index >= 0 && index < catalog.folders.length;
    for (const key of ["tops", "bottoms", "shoes", "hats", "glasses", "watches", "ties"]) {
      for (const entry of catalog[key]) {
        assert.ok(folderOk(entry.r[0]), `${gender} ${key} ${entry.n} folder`);
        assert.ok(Number.isInteger(entry.r[1]) && entry.r[1] >= 0, `${gender} ${key} ${entry.n} local`);
        assert.match(entry.t, /^[a-z]+$/, `${gender} ${key} ${entry.n} letters`);
        assert.equal(entry.c.length, entry.t.length, `${gender} ${key} ${entry.n} colours`);
        for (const tuple of Object.values(entry.f || {})) assert.ok(folderOk(tuple[0]) && tuple[2] < 26);
      }
    }
    for (const [style, variants] of Object.entries(catalog.uniforms)) {
      assert.ok(variants.length > 0, `${gender} ${style}`);
      for (const variant of variants) {
        for (const tuple of Object.values(variant.p)) assert.ok(folderOk(tuple[0]) && tuple[2] < 26, `${gender} ${style} ${variant.n}`);
      }
    }
  }
});

test("watches are watches and neutral colourways are wholly neutral", () => {
  for (const gender of GENDERS) {
    const catalog = EUP_OUTFIT_CATALOG[gender];
    for (const watch of catalog.watches) assert.doesNotMatch(watch.n, /Bracelet|Bangle|Chain|Cuff/i);
    for (const glasses of catalog.glasses) assert.doesNotMatch(glasses.n, /New Year|Glow|Party/i);
    for (const key of ["tops", "bottoms", "shoes", "hats"]) {
      for (const entry of catalog[key]) {
        for (const color of entry.c) assert.doesNotMatch(`${color} ${entry.n}`, /Pudding|Ho-Ho|Christmas|Festive|Love\b|Correctional|Prison/i, `${gender} ${key}`);
      }
    }
    for (const key of ["tops", "bottoms", "shoes"]) {
      for (const entry of catalog[key]) {
        for (const letter of entry.q || "") assert.doesNotMatch(entry.c[entry.t.indexOf(letter)], /Check|Pinstripe|Mustard|Pink|Neon|Orange/i, `${gender} ${key} ${entry.n}`);
      }
    }
  }
});

test("every top in the catalogue brings the arms and undershirt the game pairs with it", () => {
  for (const gender of GENDERS) {
    for (const top of EUP_OUTFIT_CATALOG[gender].tops) {
      assert.ok(top.f?.uppr && top.f?.accs, `${gender} ${top.n} forces uppr and accs`);
    }
  }
});

test("every style generates an outfit for both peds", () => {
  for (const gender of GENDERS) {
    for (const style of OUTFIT_STYLES) {
      const outfit = generateOutfit(EUP_OUTFIT_CATALOG[gender], { style: style.id, seed: 7, available: everything });
      assert.ok(outfit, `${gender} ${style.id}`);
      assert.ok(outfit.parts.jbib && outfit.parts.lowr && outfit.parts.feet, `${gender} ${style.id} has top, legs and shoes`);
      assert.ok(outfit.parts.uppr && outfit.parts.accs, `${gender} ${style.id} has arms and undershirt`);
      assert.ok(outfit.name, `${gender} ${style.id} is named`);
    }
  }
});

test("an everyday outfit wears the forced arms and undershirt of its top", () => {
  for (const gender of GENDERS) {
    const catalog = EUP_OUTFIT_CATALOG[gender];
    for (let seed = 1; seed <= 40; seed += 1) {
      const outfit = generateOutfit(catalog, { style: "casual", seed, available: everything });
      const top = catalog.tops.find((entry) => catalog.folders[entry.r[0]] === outfit.parts.jbib.folder
        && entry.r[1] === outfit.parts.jbib.local
        && entry.t.includes(outfit.parts.jbib.letter)
        && entry.f.uppr[1] === outfit.parts.uppr.local);
      assert.ok(top, `${gender} seed ${seed}: top found`);
      for (const [component, tuple] of Object.entries(top.f)) {
        const part = outfit.parts[component];
        assert.equal(part.folder, catalog.folders[tuple[0]]);
        assert.equal(part.local, tuple[1]);
        assert.equal(part.letter, LETTERS[tuple[2]]);
      }
    }
  }
});

test("the same seed gives the same outfit and seeds vary it", () => {
  const catalog = EUP_OUTFIT_CATALOG.male;
  const a = generateOutfit(catalog, { style: "street", seed: 99, available: everything });
  const b = generateOutfit(catalog, { style: "street", seed: 99, available: everything });
  assert.deepEqual(a, b);
  const names = new Set();
  for (let seed = 1; seed <= 30; seed += 1) names.add(generateOutfit(catalog, { style: "street", seed, available: everything }).name);
  assert.ok(names.size >= 20, `30 seeds gave ${names.size} outfits`);
});

test("service uniforms come from the game's agency outfits", () => {
  for (const gender of GENDERS) {
    const catalog = EUP_OUTFIT_CATALOG[gender];
    const seen = (style) => Array.from({ length: 40 }, (_, seed) => generateOutfit(catalog, { style, seed, available: everything }));
    // LSPD wears the black uniform shirt with the LSPD patch.
    for (const outfit of seen("lspd")) {
      assert.equal(outfit.parts.jbib.letter, "a");
      assert.equal(outfit.parts.decl.letter, "a");
    }
    // Highway Patrol: cream shirt, highway patch.
    for (const outfit of seen("highway")) {
      assert.equal(outfit.parts.jbib.letter, "c");
      assert.equal(outfit.parts.decl.letter, "b");
    }
    // Sheriff: khaki or cream, no patch, no cap.
    for (const outfit of seen("sheriff")) {
      assert.ok(["c", "d"].includes(outfit.parts.jbib.letter));
      assert.equal(outfit.parts.decl, undefined);
      assert.equal(outfit.parts.p_head, undefined);
    }
    // Corrections: grey shirt and the game's correctional cargo.
    for (const outfit of seen("corrections")) {
      assert.ok(["g", "h"].includes(outfit.parts.jbib.letter));
      assert.match(outfit.parts.lowr.folder, /heist3$/);
    }
    // Park Ranger: the game's olive trousers and cap are Enhanced-only placeholders.
    for (const outfit of seen("ranger")) {
      assert.equal(outfit.parts.p_head, undefined);
      assert.equal(outfit.parts.lowr.folder, seen("sheriff")[0].parts.lowr.folder);
    }
    // Detective: a suit and tie in a quiet colourway.
    for (const outfit of seen("detective")) {
      const top = catalog.tops.find((entry) => catalog.folders[entry.r[0]] === outfit.parts.jbib.folder && entry.r[1] === outfit.parts.jbib.local
        && (entry.q || "").includes(outfit.parts.jbib.letter));
      assert.ok(top && outfit.parts.teef && /\b(Jacket|Coat|Blazer|Double Suit)\b/.test(top.n), `${gender} ${outfit.name}`);
    }
    // Season and tie vary; the hat comes and goes.
    const lspd = seen("lspd");
    assert.ok(new Set(lspd.map((outfit) => outfit.name)).size === 4);
    assert.ok(lspd.some((outfit) => outfit.parts.p_head) && lspd.some((outfit) => !outfit.parts.p_head));
  }
});

test("clothing the install lacks is never chosen", () => {
  for (const gender of GENDERS) {
    const catalog = EUP_OUTFIT_CATALOG[gender];
    const heist3 = catalog.folders.filter((folder) => /heist3$/.test(folder));
    const available = syntheticAvailability(catalog, { without: heist3 });
    // The agency uniforms are heist3 shirts: without it there is no LSPD outfit.
    assert.equal(generateOutfit(catalog, { style: "lspd", seed: 3, available }), null);
    for (let seed = 1; seed <= 20; seed += 1) {
      const outfit = generateOutfit(catalog, { style: "casual", seed, available });
      assert.ok(outfit);
      for (const part of Object.values(outfit.parts)) assert.ok(!heist3.includes(part.folder));
    }
  }
  assert.equal(generateOutfit(EUP_OUTFIT_CATALOG.male, { style: "casual", seed: 1, available: () => null }), null);
});

test("gameAvailability resolves against this install's ranges and texture letters", () => {
  const gameIndexes = {
    jbib: {
      ranges: [{ folder: "mp_m_freemode_01", start: 0, count: 16 }, { folder: "mp_m_freemode_01_mp_m_heist3", start: 16, count: 6 }],
      variants: new Map([[18, ["a", "b", "c"]]]),
    },
  };
  const available = gameAvailability(gameIndexes);
  assert.equal(available("jbib", "mp_m_freemode_01_mp_m_heist3", 2, "c"), 18);
  assert.equal(available("jbib", "mp_m_freemode_01_mp_m_heist3", 2, "d"), null);
  assert.equal(available("jbib", "mp_m_freemode_01_mp_m_heist3", 9, "a"), null);
  assert.equal(available("jbib", "mp_m_freemode_01_mp_m_2025_02", 0, "a"), null);
  assert.equal(available("lowr", "mp_m_freemode_01", 0, "a"), null);
});

test("wearing a generated outfit resets the outfit slots and keeps face and hair", () => {
  const outfit = generateOutfit(EUP_OUTFIT_CATALOG.male, { style: "lspd", seed: 5, available: everything });
  const before = {
    head: { index: 4, variant: "a", enabled: true },
    hair: { index: 11, variant: "a", enabled: true },
    berd: { index: 3, variant: "a", enabled: true },
    hand: { index: 2, variant: "b", enabled: true },
    p_eyes: { index: 5, variant: "a", enabled: true },
  };
  const next = overridesWithOutfit(before, outfit, everything);
  assert.deepEqual(next.head, before.head);
  assert.deepEqual(next.hair, before.hair);
  assert.equal(next.berd, undefined);
  assert.equal(next.hand, undefined);
  if (!outfit.parts.p_eyes) assert.equal(next.p_eyes.enabled, false);
  assert.deepEqual(next.jbib, { index: 1, variant: "a", enabled: true });
  for (const component of OUTFIT_PROPS) assert.equal(typeof next[component].enabled, "boolean");
  for (const component of OUTFIT_COMPONENTS) {
    if (!outfit.parts[component]) assert.equal(next[component], undefined);
  }
  assert.equal(outfitSignature(next), outfitSignature(overridesWithOutfit({}, outfit, everything)));
  assert.notEqual(outfitSignature(next), outfitSignature({ ...next, jbib: { index: 2, variant: "a", enabled: true } }));
});
