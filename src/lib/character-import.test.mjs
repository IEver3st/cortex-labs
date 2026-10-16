import assert from "node:assert/strict";
import test from "node:test";

import {
  GTA_HAIR_COLORS,
  decodeVmenuCode,
  genderForModelHash,
  headRacesFromListing,
  joaat,
  planCharacterImport,
  LSPDFR_SAVE_MESSAGE,
  isLspdfrSave,
  readCharacterFile,
  readCharacterText,
  readKvsRecords,
} from "./character-import.js";
import { buildGameDrawableIndex, COMPONENT_IDS, PROP_IDS } from "./eup.js";

const MALE_HASH = 1885233650;
const FEMALE_HASH = 2627665880;

async function gzipCode(json) {
  const stream = new Blob([new TextEncoder().encode(json)]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return `VME1G:${Buffer.from(bytes).toString("base64")}`;
}

function legacyCharacter(overrides = {}) {
  return {
    PedHeadBlendData: {
      FirstFaceShape: 21,
      SecondFaceShape: 4,
      FirstSkinTone: 21,
      SecondSkinTone: 4,
      ParentFaceShapePercent: 0.7,
      ParentSkinTonePercent: 0.2,
      IsParentInheritance: false,
    },
    DrawableVariations: {
      clothes: {
        0: { Key: 0, Value: 0 },
        2: { Key: 4, Value: 0 },
        3: { Key: 1, Value: 0 },
        4: { Key: 2, Value: 1 },
        11: { Key: 900, Value: 2 },
      },
    },
    PropVariations: { props: { 0: { Key: -1, Value: -1 }, 1: { Key: 3, Value: 1 } } },
    FaceShapeFeatures: { features: { 0: 0.4 } },
    PedAppearance: { hairStyle: 4, hairColor: 3, hairHighlightColor: 40, beardStyle: 2, beardOpacity: 1 },
    PedTatttoos: { TorsoTattoos: [{ Key: "mpbeach_overlays", Value: "fm_hip_m_tat_000" }] },
    IsMale: true,
    ModelHash: MALE_HASH,
    SaveName: "mp_ped_Paul",
    Version: 1,
    ...overrides,
  };
}

// A game listing: base folder with drawables 0..2 per component, one DLC
// folder with two more, plus prop and head texture entries.
function listing(ped) {
  const entries = [];
  for (const component of ["head", "hair", "uppr", "lowr", "jbib"]) {
    for (let i = 0; i < 3; i += 1) {
      const n = String(i).padStart(3, "0");
      entries.push({ folder: ped, file: `${component}_${n}_r.ydd`, kind: "ydd" });
      entries.push({ folder: ped, file: `${component}_diff_${n}_a_whi.ytd`, kind: "ytd" });
      entries.push({ folder: ped, file: `${component}_diff_${n}_b_whi.ytd`, kind: "ytd" });
    }
    for (let i = 0; i < 2; i += 1) {
      const n = String(i).padStart(3, "0");
      entries.push({ folder: `${ped}_mp_m_beach`, file: `${component}_${n}_u.ydd`, kind: "ydd" });
      entries.push({ folder: `${ped}_mp_m_beach`, file: `${component}_diff_${n}_a_uni.ytd`, kind: "ytd" });
    }
  }
  for (let i = 0; i < 25; i += 1) {
    const n = String(i).padStart(3, "0");
    entries.push({ folder: ped, file: `head_${n}_r.ydd`, kind: "ydd" });
  }
  entries.push({ folder: ped, file: "head_diff_004_a_lat.ytd", kind: "ytd" });
  entries.push({ folder: ped, file: "head_diff_021_a_whi.ytd", kind: "ytd" });
  entries.push({ folder: `${ped}_p`, file: "p_eyes_003.ydd", kind: "ydd" });
  entries.push({ folder: `${ped}_p`, file: "p_eyes_diff_003_a.ytd", kind: "ytd" });
  entries.push({ folder: `${ped}_p`, file: "p_eyes_diff_003_b.ytd", kind: "ytd" });
  const collections = [
    { folder: ped, pack: "", order: -1 },
    { folder: `${ped}_p`, pack: "", order: -1 },
    { folder: `${ped}_mp_m_beach`, pack: "mpbeach", order: 0 },
  ];
  return { entries, collections };
}

function context(ped) {
  const { entries, collections } = listing(ped);
  return {
    gameIndexes: Object.fromEntries([...COMPONENT_IDS, ...PROP_IDS].map((component) => [
      component,
      buildGameDrawableIndex(entries, collections, component),
    ])),
    headRaces: headRacesFromListing(entries, ped),
  };
}

test("joaat matches the freemode ped hashes, signed or not", () => {
  assert.equal(joaat("mp_m_freemode_01"), MALE_HASH);
  assert.equal(joaat("mp_f_freemode_01"), FEMALE_HASH);
  assert.equal(genderForModelHash(-1667301416), "female");
  assert.equal(genderForModelHash(3265820418), null);
});

test("reads a legacy vMenu character and plans the base ped", async () => {
  const { characters } = await readCharacterText(JSON.stringify(legacyCharacter()));
  assert.equal(characters.length, 1);
  const [paul] = characters;
  assert.equal(paul.name, "Paul");
  assert.equal(paul.gender, "male");
  assert.deepEqual(paul.outfits[0].components.lowr, { drawable: 2, texture: 1, collection: null, local: null });
  assert.equal(paul.outfits[0].props.p_head.drawable, -1);

  const plan = planCharacterImport(paul, 0, context("mp_m_freemode_01"));
  assert.equal(plan.gender, "male");
  assert.deepEqual(plan.overrides.lowr, { index: 2, variant: "b", enabled: true });
  assert.deepEqual(plan.overrides.p_eyes, { index: 3, variant: "b", enabled: true });
  assert.equal(plan.overrides.p_head, undefined, "an empty prop slot stays empty");
  // Shape mix 0.7 favours the second parent (4); skin mix 0.2 the first (21, whi).
  assert.deepEqual(plan.overrides.head, { index: 4, variant: "a", enabled: true });
  assert.equal(plan.skinTone, "light");
  // Hair 4 is the DLC folder's second drawable (after 3 base drawables).
  assert.deepEqual(plan.overrides.hair, { index: 4, variant: "a", enabled: true });
  assert.deepEqual(plan.hair, { color: GTA_HAIR_COLORS[3], highlight: GTA_HAIR_COLORS[40] });
  // jbib 900 is past the game's drawables: server clothing, refused rather than guessed.
  assert.equal(plan.overrides.jbib, undefined);
  assert.match(plan.skipped.find((item) => item.component === "jbib").reason, /server clothing/);
  assert.deepEqual(plan.notShown, ["face shape sliders", "beard, eyebrows and makeup", "1 tattoo"]);
});

test("reads fork saves with arrays, signed hashes and recorded collections", async () => {
  const fork = {
    IsMale: false,
    ModelHash: -1667301416,
    SaveName: "White Top",
    HairColor: 26,
    HairHighlightColor: 26,
    PedAppearance: { hairStyle: 1, hairColor: 26, hairHighlightColor: 26 },
    PedHeadBlendData: { shapeFirstID: 4, shapeSecondID: 21, skinFirstID: 4, skinSecondID: 21, shapeMix: 0.2, skinMix: 0.4 },
    DrawableVariations: { clothes: { 2: [1, 0, 0], 4: [112, 0, 0], 11: [273, 0, 0] } },
    ComponentCollections: {
      2: { index: 1, name: "" },
      4: { index: 1, name: "mp_m_beach" },
      11: { index: 9, name: "mp_f_battle" },
    },
    PropVariations: { props: { 1: [-1, -1] } },
    HeadOverlays: { 1: { style: 255, opacity: 0 }, 2: { style: 32, opacity: 0.9 } },
  };
  const { characters } = await readCharacterText(JSON.stringify(fork));
  const plan = planCharacterImport(characters[0], 0, context("mp_f_freemode_01"));
  assert.equal(plan.gender, "female");
  // lowr 112 on the server is the beach pack's drawable 1: game number 3 + 1.
  assert.deepEqual(plan.overrides.lowr, { index: 4, variant: "a", enabled: true });
  assert.match(plan.skipped.find((item) => item.component === "jbib").reason, /mp_f_battle isn't in your game files/);
  assert.equal(plan.overrides.head.index, 4);
  assert.equal(plan.skinTone, "olive");
  assert.deepEqual(plan.notShown, ["beard, eyebrows and makeup"]);
});

test("reads legacy saved peds and counts other models instead of guessing", async () => {
  const saved = {
    version: 1,
    model: FEMALE_HASH,
    isMpPed: true,
    drawableVariations: { 0: 0, 2: 1, 4: 2, 18: 33554944 },
    drawableVariationTextures: { 0: 0, 2: 0, 4: 1 },
    props: { 1: 3, 6: -1 },
    propTextures: { 1: 0, 6: -1 },
  };
  const animal = { ...saved, model: 3265820418, isMpPed: false };
  const result = readKvsRecords([
    { store: "kvs", resource: "vMenu", key: "ped_Officer", value: JSON.stringify(saved) },
    { store: "kvs", resource: "vMenu", key: "ped_Juan", value: JSON.stringify(animal) },
    { store: "kvs", resource: "es_admin", key: "mp_ped_Paul", value: JSON.stringify(legacyCharacter()) },
    { store: "kvs", resource: "vMenu", key: "mp_ped_Broken", value: "{not json" },
  ]);
  assert.equal(result.characters.length, 2);
  assert.equal(result.otherModels, 1);
  assert.equal(result.unreadable, 1);
  const officer = result.characters.find((item) => item.name === "Officer");
  assert.equal(officer.format, "vmenu-legacy-ped");
  assert.equal(officer.id, "fivem:kvs:vMenu:ped_Officer");
  assert.deepEqual(Object.keys(officer.outfits[0].components), ["head", "hair", "lowr"], "only saved slots 0-11 are read");
  assert.equal(result.characters.find((item) => item.name === "Paul").resource, "es_admin");
});

test("reads vMenu Enhanced codes with several outfits", async () => {
  const character = {
    name: "Ana",
    core: {
      isMale: false,
      blend: { firstShape: 21, secondShape: 4, firstSkin: 21, secondSkin: 4, shapeMix: 0.1, skinMix: 0.1 },
      faceFeatures: [0, 0],
      overlays: [],
      tattoos: { torso: [] },
    },
    currentStyle: { name: "Day", hairStyle: 2, hairColour: 10, hairHighlight: 12 },
    currentOutfit: { name: "Patrol", outfit: { components: [{ slot: 4, drawable: 200, texture: 0, collection: "mp_m_beach", localDrawable: 0 }], props: [] } },
    outfits: [
      { name: "Patrol", outfit: { components: [], props: [] } },
      { name: "Off duty", outfit: { components: [{ slot: 11, drawable: 1, texture: 1, collection: "", localDrawable: 1 }], props: [{ slot: 1, drawable: 3, texture: 0, collection: "", localDrawable: 3 }] } },
    ],
    lastOutfit: "Off duty",
  };
  const ped = { name: "Fido", appearance: { modelHash: 1462895032, components: [], props: [] } };
  const bundle = {
    format: "vmenu.enhanced.kvp",
    version: 1,
    entries: [
      { key: "vmenu_mpchar_Ana", raw: JSON.stringify({ key: "vmenu_mpchar_Ana", value: character, type: "json", version: 2 }) },
      { key: "vmenu_ped_Fido", raw: JSON.stringify({ key: "vmenu_ped_Fido", value: ped, type: "json", version: 2 }) },
      { key: "vmenu_default_x", raw: JSON.stringify({ key: "vmenu_default_x", value: true, type: "bool", version: 1 }) },
    ],
  };
  const code = await gzipCode(JSON.stringify(bundle));
  // A code pasted out of a chat comes back wrapped.
  const wrapped = `${code.slice(0, 40)}\n${code.slice(40)}`;
  const { characters, otherModels } = await readCharacterText(wrapped);
  assert.equal(otherModels, 1);
  assert.equal(characters.length, 1);
  const [ana] = characters;
  assert.deepEqual(ana.outfits.map((outfit) => outfit.name), ["Patrol", "Off duty"]);
  assert.equal(ana.defaultOutfit, 1);

  const ctx = context("mp_f_freemode_01");
  const patrol = planCharacterImport(ana, 0, ctx);
  assert.deepEqual(patrol.overrides.lowr, { index: 3, variant: "a", enabled: true });
  const offDuty = planCharacterImport(ana, 1, ctx);
  assert.deepEqual(offDuty.overrides.jbib, { index: 1, variant: "b", enabled: true });
  assert.deepEqual(offDuty.overrides.p_eyes, { index: 3, variant: "a", enabled: true });
  assert.equal(offDuty.overrides.hair.index, 2);
  assert.deepEqual(offDuty.hair, { color: GTA_HAIR_COLORS[10], highlight: GTA_HAIR_COLORS[12] });
  assert.equal(offDuty.overrides.head.index, 21);
});

test("rejects damaged codes and unrelated text with a reason", async () => {
  await assert.rejects(readCharacterText(""), /Paste a vMenu code/);
  await assert.rejects(readCharacterText("hello"), /isn't a vMenu code or JSON/);
  await assert.rejects(readCharacterText("VME1G:!!!"), /damaged/);
  await assert.rejects(readCharacterText(`VME1G:${Buffer.from("not gzip").toString("base64")}`), /damaged or incomplete/);
  await assert.rejects(readCharacterText('{"hello":1}'), /No saved characters found/);
  const plain = `VME1P:${Buffer.from(JSON.stringify(legacyCharacter())).toString("base64")}`;
  assert.equal(JSON.parse(await decodeVmenuCode(plain)).SaveName, "mp_ped_Paul");
});

test("plans without game files by trusting saved numbers", async () => {
  const { characters } = await readCharacterText(JSON.stringify(legacyCharacter()));
  const plan = planCharacterImport(characters[0], 0, {});
  assert.deepEqual(plan.overrides.jbib, { index: 900, variant: "c", enabled: true });
  assert.equal(plan.skinTone, null);
});

/* ── Menyoo outfits and LSPDFR saves ── */

const MENYOO_OUTFIT = `<?xml version="1.0" encoding="ISO-8859-1"?>
<OutfitPedData>
  <ModelHash>${FEMALE_HASH}</ModelHash>
  <PedProperties>
    <PedProps>
      <_0>12,2</_0>
      <_1>-1,-1</_1>
      <_6>3,0</_6>
    </PedProps>
    <PedComps>
      <_0>0,0</_0>
      <_2>15,0</_2>
      <_4>34,1</_4>
      <_11>55,3</_11>
    </PedComps>
    <HeadFeatures WasInArray="true">
      <HairColour>4</HairColour>
      <HairColourStreaks>12</HairColourStreaks>
      <FacialFeatures><F0>0.5</F0><F1>0</F1></FacialFeatures>
      <Overlays>
        <O1 index="255" colour="0" colourSecondary="0" opacity="1" />
        <O2 index="3" colour="0" colourSecondary="0" opacity="0.8" />
      </Overlays>
      <ShapeAndSkinTone>
        <ShapeFatherId>4</ShapeFatherId>
        <ShapeMotherId>21</ShapeMotherId>
        <ToneFatherId>4</ToneFatherId>
        <ToneMotherId>21</ToneMotherId>
        <ShapeVal>0.8</ShapeVal>
        <ToneVal>0.3</ToneVal>
      </ShapeAndSkinTone>
    </HeadFeatures>
    <TattooLogoDecals><D collection="1" value="2" /></TattooLogoDecals>
  </PedProperties>
</OutfitPedData>`;

test("readCharacterFile reads a Menyoo outfit as the freemode character it dresses", async () => {
  const bytes = new TextEncoder().encode(MENYOO_OUTFIT);
  const { characters } = await readCharacterFile(bytes, String.raw`C:\GTA\menyooStuff\Outfits\Samantha.xml`);
  assert.equal(characters.length, 1);
  const [samantha] = characters;
  assert.equal(samantha.name, "Samantha");
  assert.equal(samantha.format, "menyoo-outfit");
  assert.equal(samantha.gender, "female");
  const { components, props } = samantha.outfits[0];
  assert.deepEqual(components.lowr, { drawable: 34, texture: 1, collection: null, local: null });
  assert.equal(components.jbib.drawable, 55);
  assert.equal(props.p_head.drawable, 12);
  assert.equal(props.p_eyes, undefined, "-1 means no prop");
  assert.equal(props.p_lwrist.drawable, 3);
  assert.deepEqual(samantha.hair, { style: 15, color: 4, highlight: 12 });
  assert.deepEqual(samantha.headBlend, { shapeFirst: 4, shapeSecond: 21, skinFirst: 4, skinSecond: 21, shapeMix: 0.8, skinMix: 0.3 });
  assert.deepEqual(samantha.extras, { tattoos: 1, overlays: 1, faceFeatures: 1 });
});

test("readCharacterText reads Spooner ped placements with hex hashes and C/P slot names", async () => {
  const xml = `<SpoonerPlacements>
    <Placement><ModelHash>0x${MALE_HASH.toString(16).toUpperCase()}</ModelHash><Type>1</Type>
      <PedProperties><PedComps><C3>4,0</C3></PedComps><PedProps><P0>8,1</P0></PedProps></PedProperties>
    </Placement>
    <Placement><ModelHash>0x2F8845A3</ModelHash><Type>1</Type><PedProperties /></Placement>
    <Placement><ModelHash>0x12345678</ModelHash><Type>3</Type></Placement>
  </SpoonerPlacements>`;
  const result = await readCharacterText(xml, { name: "Scene" });
  assert.equal(result.characters.length, 1);
  assert.equal(result.otherModels, 1, "a non-freemode ped is counted, not listed");
  assert.equal(result.characters[0].gender, "male");
  assert.equal(result.characters[0].outfits[0].components.uppr.drawable, 4);
  assert.equal(result.characters[0].outfits[0].props.p_head.texture, 1);
});

test("Menyoo XML without a ped or with broken markup is refused with a reason", async () => {
  await assert.rejects(readCharacterText("<OutfitPedData></OutfitPedData>"), /No ped in that XML/);
  await assert.rejects(readCharacterText("<OutfitPedData><ModelHash>1"), /XML is damaged/);
});

test("LSPDFR .ls and .bak saves are recognised and explained, opened or pasted", async () => {
  // The header of a real LSPDFR character save: "LSE02", four zero bytes, 0x01, then ciphertext.
  const save = new Uint8Array([0x4c, 0x53, 0x45, 0x30, 0x32, 0, 0, 0, 0, 1, 0x3d, 0x6c, 0xcf, 0x9c, 0x0a, 0xde]);
  assert.equal(isLspdfrSave(save), true);
  await assert.rejects(readCharacterFile(save, "Samantha Jorine.bak"), (error) => {
    assert.equal(error.message, LSPDFR_SAVE_MESSAGE);
    assert.match(error.message, /Menyoo/);
    return true;
  });
  await assert.rejects(readCharacterText("LSE02=lF\uFFFDn\uFFFD\uFFFDd"), /LSPDFR character save/);
  assert.equal(isLspdfrSave(new TextEncoder().encode("{\"name\":\"x\"}")), false);
});

test("readCharacterFile falls back to Latin-1 and refuses empty files", async () => {
  const latin = Uint8Array.from(MENYOO_OUTFIT.replace("<ModelHash>", "<HashName>Zo\u00eb</HashName><ModelHash>"), (char) => char.charCodeAt(0));
  const { characters } = await readCharacterFile(latin, "zoe.xml");
  assert.equal(characters[0].name, "Zo\u00eb");
  await assert.rejects(readCharacterFile(new Uint8Array(), "empty.json"), /empty/);
});

test("server clothing resolves from loaded packs: by collection exactly, by number in load order", async () => {
  const { buildServerPackListing, extendPedListing, groupEupAssets } = await import("./eup.js");
  const ped = "mp_m_freemode_01";
  const files = [
    "mp_m_freemode_01_cityhair^hair_000_u.ydd",
    "mp_m_freemode_01_cityhair^hair_diff_000_a_uni.ytd",
    "mp_m_freemode_01_citytops^jbib_000_u.ydd",
    "mp_m_freemode_01_citytops^jbib_diff_000_a_uni.ytd",
    "mp_m_freemode_01_citytops^jbib_001_u.ydd",
    "mp_m_freemode_01_citytops^jbib_diff_001_a_uni.ytd",
    "mp_m_freemode_01_citytops^jbib_diff_001_b_uni.ytd",
  ].map((name) => ({ path: `c:/server/${name}` }));
  const extended = extendPedListing(listing(ped), buildServerPackListing(groupEupAssets(files).files, ped));
  const serverContext = {
    gameIndexes: Object.fromEntries([...COMPONENT_IDS, ...PROP_IDS].map((component) => [
      component,
      buildGameDrawableIndex(extended.entries, extended.collections, component),
    ])),
  };

  // vMenu Enhanced records the collection and the number inside it.
  const enhanced = {
    core: { isMale: true },
    name: "Street",
    currentOutfit: {
      name: "Street",
      outfit: { components: [{ slot: 11, drawable: 344, texture: 1, collection: "citytops", localDrawable: 1 }] },
    },
  };
  const { characters } = await readCharacterText(JSON.stringify(enhanced));
  const plan = planCharacterImport(characters[0], 0, serverContext);
  // The game has 3 + 2 jbib drawables; citytops' drawable 1 is number 6.
  assert.deepEqual(plan.overrides.jbib, { index: 6, variant: "b", enabled: true });
  assert.ok(plan.notes.some((note) => /top from citytops/.test(note)));
  assert.ok(!plan.notes.some((note) => /order you added/.test(note)), "a recorded collection needs no order assumption");

  // A plain number lands in the loaded packs only in their load order.
  const plain = await readCharacterText(JSON.stringify(legacyCharacter({
    DrawableVariations: { clothes: { 11: { Key: 5, Value: 0 } } },
    PedAppearance: { hairStyle: 5, hairColor: 3, hairHighlightColor: 3 },
  })));
  const plainPlan = planCharacterImport(plain.characters[0], 0, serverContext);
  assert.deepEqual(plainPlan.overrides.hair, { index: 5, variant: "a", enabled: true });
  assert.deepEqual(plainPlan.overrides.jbib, { index: 5, variant: "a", enabled: true });
  assert.ok(plainPlan.notes.some((note) => /hair from cityhair, top from citytops/.test(note)));
  assert.ok(plainPlan.notes.some((note) => /order you added/.test(note)));

  // Past the loaded packs, or a pack that isn't loaded: refused, not guessed.
  const far = await readCharacterText(JSON.stringify(legacyCharacter()));
  const farPlan = planCharacterImport(far.characters[0], 0, serverContext);
  assert.equal(farPlan.overrides.jbib, undefined);
  assert.match(farPlan.skipped.find((item) => item.component === "jbib").reason, /past the game's 5 and your loaded packs' 2/);
  const missing = planCharacterImport({
    ...characters[0],
    outfits: [{ name: "x", components: { jbib: { drawable: 400, texture: 0, collection: "othertops", local: 0 } }, props: {} }],
  }, 0, serverContext);
  assert.match(missing.skipped.find((item) => item.component === "jbib").reason, /othertops isn't in your game files or loaded packs/);
});
