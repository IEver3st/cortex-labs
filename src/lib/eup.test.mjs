import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_BASE_OUTFIT,
  buildOutfitLabel,
  classifyTextureName,
  buildOutfitLua,
  componentDisplayName,
  componentGameId,
  cycleValue,
  formatBytes,
  groupEupAssets,
  listThumbnailJobs,
  missingVariantLetters,
  normalizeOutfitPresets,
  pathKey,
  propAnchorId,
  textureBudgetWarnings,
  thumbnailFileName,
  variantTextureIndex,
  listDrawableIndices,
  listTextureVariants,
  parseEupFileName,
  resolveTextureForDrawable,
  selectBaseGameAssets,
  validateEupNames,
} from "./eup.js";

test("base ped drawables take priority over DLC universal names at the same index", () => {
  const ped = "mp_m_freemode_01";
  const result = selectBaseGameAssets([
    { folder: `${ped}_male_freemode_pilot`, file: "uppr_000_u.ydd", kind: "ydd" },
    { folder: `${ped}_male_freemode_pilot`, file: "uppr_diff_000_a_uni.ytd", kind: "ytd" },
    { folder: ped, file: "uppr_000_r.ydd", kind: "ydd" },
    { folder: ped, file: "uppr_diff_000_a_whi.ytd", kind: "ytd" },
  ], ped, "uppr", 0);
  assert.equal(result.drawable.folder, ped);
  assert.equal(result.texture.folder, ped);
});

test("parseEupFileName handles base-game component drawables and textures", () => {
  const drawable = parseEupFileName("uppr_012_r.ydd");
  assert.equal(drawable.ped, null);
  assert.equal(drawable.gender, null);
  assert.equal(drawable.pack, null);
  assert.equal(drawable.isProp, false);
  assert.equal(drawable.component, "uppr");
  assert.equal(drawable.index, 12);
  assert.equal(drawable.kind, "drawable");
  assert.equal(drawable.raceDependent, true);
  assert.equal(drawable.textureVariant, null);
  assert.equal(drawable.ext, "ydd");
  assert.equal(drawable.known, true);

  const texture = parseEupFileName("uppr_diff_012_c_whi.ytd");
  assert.equal(texture.kind, "texture");
  assert.equal(texture.component, "uppr");
  assert.equal(texture.index, 12);
  assert.equal(texture.textureVariant, "c");
  assert.equal(texture.race, "whi");
  assert.equal(texture.raceDependent, true);

  const universal = parseEupFileName("lowr_diff_000_a_uni.ytd");
  assert.equal(universal.race, "uni");
  assert.equal(universal.raceDependent, false);
});

test("parseEupFileName handles addon streaming names for both peds", () => {
  const male = parseEupFileName("mp_m_freemode_01_mypack^uppr_000_u.ydd");
  assert.equal(male.ped, "mp_m_freemode_01");
  assert.equal(male.gender, "male");
  assert.equal(male.pack, "mypack");
  assert.equal(male.component, "uppr");
  assert.equal(male.index, 0);
  assert.equal(male.raceDependent, false);

  const maleTexture = parseEupFileName("mp_m_freemode_01_mypack^uppr_diff_000_a_uni.ytd");
  assert.equal(maleTexture.pack, "mypack");
  assert.equal(maleTexture.kind, "texture");
  assert.equal(maleTexture.textureVariant, "a");
  assert.equal(maleTexture.race, "uni");

  const female = parseEupFileName("mp_f_freemode_01_sheriff^lowr_003_u.ydd");
  assert.equal(female.ped, "mp_f_freemode_01");
  assert.equal(female.gender, "female");
  assert.equal(female.pack, "sheriff");
  assert.equal(female.component, "lowr");
  assert.equal(female.index, 3);
});

test("parseEupFileName handles props with and without the _p_ collection marker", () => {
  const addonProp = parseEupFileName("mp_f_freemode_01_p_sheriff^p_head_000.ydd");
  assert.equal(addonProp.ped, "mp_f_freemode_01");
  assert.equal(addonProp.pack, "sheriff");
  assert.equal(addonProp.isProp, true);
  assert.equal(addonProp.component, "p_head");
  assert.equal(addonProp.index, 0);
  assert.equal(addonProp.kind, "drawable");

  const addonPropTexture = parseEupFileName("mp_f_freemode_01_p_sheriff^p_head_diff_000_a.ytd");
  assert.equal(addonPropTexture.isProp, true);
  assert.equal(addonPropTexture.textureVariant, "a");
  assert.equal(addonPropTexture.race, null);

  const baseProp = parseEupFileName("p_eyes_004.ydd");
  assert.equal(baseProp.isProp, true);
  assert.equal(baseProp.component, "p_eyes");
  assert.equal(baseProp.index, 4);
});

test("parseEupFileName tolerates paths, uppercase and spaces but flags them", () => {
  const parsed = parseEupFileName("C:\\packs\\stream\\MP_M_FREEMODE_01_MyPack^Uppr_001_U.ydd");
  assert.equal(parsed.ped, "mp_m_freemode_01");
  assert.equal(parsed.pack, "mypack");
  assert.equal(parsed.component, "uppr");
  assert.equal(parsed.index, 1);
  assert.equal(parsed.hasUppercase, true);
  assert.equal(parsed.hasSpaces, false);

  const spaced = parseEupFileName("uppr_001 _u.ydd");
  assert.equal(spaced, null);

  const unknownComponent = parseEupFileName("upper_001_u.ydd");
  assert.equal(unknownComponent.component, "upper");
  assert.equal(unknownComponent.known, false);
});

test("parseEupFileName rejects names that are not ped assets", () => {
  assert.equal(parseEupFileName("vehicle.yft"), null);
  assert.equal(parseEupFileName("uppr.ydd"), null);
  assert.equal(parseEupFileName("mp_m_freemode_01_pack^uppr_000_u.ytd"), null);
  assert.equal(parseEupFileName("readme.txt"), null);
  assert.equal(parseEupFileName(""), null);
  assert.equal(parseEupFileName(null), null);
});

test("componentDisplayName maps slots to user-facing labels", () => {
  assert.equal(componentDisplayName("uppr"), "Torso");
  assert.equal(componentDisplayName("jbib"), "Top");
  assert.equal(componentDisplayName("p_head"), "Hat");
  assert.equal(componentDisplayName("p_lwrist"), "Watch");
  assert.equal(componentDisplayName("p_rwrist"), "Bracelet");
  assert.equal(componentDisplayName("accs"), "Undershirt");
  assert.equal(componentDisplayName("task"), "Body armor");
  assert.equal(componentDisplayName("hand"), "Bags/Parachute");
  assert.equal(componentDisplayName("zzz"), "ZZZ");
});

test("DEFAULT_BASE_OUTFIT covers every component for both peds", () => {
  for (const gender of ["male", "female"]) {
    const outfit = DEFAULT_BASE_OUTFIT[gender];
    assert.equal(outfit.jbib, 15);
    assert.equal(outfit.uppr, 15);
    assert.equal(outfit.accs, 15);
    assert.equal(outfit.lowr, 0);
    assert.equal(outfit.feet, 0);
    assert.equal(Object.keys(outfit).length, 12);
  }
});

const PACK = [
  { path: "s/mp_m_freemode_01_pack^uppr_000_u.ydd" },
  { path: "s/mp_m_freemode_01_pack^uppr_diff_000_a_uni.ytd" },
  { path: "s/mp_m_freemode_01_pack^uppr_diff_000_b_uni.ytd" },
  { path: "s/mp_m_freemode_01_pack^uppr_001_r.ydd" },
  { path: "s/mp_m_freemode_01_pack^uppr_diff_001_a_whi.ytd" },
  { path: "s/mp_m_freemode_01_pack^uppr_diff_001_a_bla.ytd" },
  { path: "s/mp_m_freemode_01_pack^lowr_000_u.ydd" },
  { path: "s/mp_m_freemode_01_p_pack^p_head_000.ydd" },
  { path: "s/mp_m_freemode_01_p_pack^p_head_diff_000_a.ytd" },
  { path: "s/notes.txt" },
];

test("groupEupAssets groups drawables, textures and props per ped", () => {
  const grouped = groupEupAssets(PACK);
  assert.deepEqual(grouped.unknown, ["s/notes.txt"]);
  const ped = grouped.peds.mp_m_freemode_01;
  assert.ok(ped);
  assert.deepEqual(listDrawableIndices(ped.components.uppr), [0, 1]);
  const uppr0 = ped.components.uppr.drawables[0];
  assert.equal(uppr0.drawablePath, "s/mp_m_freemode_01_pack^uppr_000_u.ydd");
  assert.deepEqual(listTextureVariants(uppr0), ["a", "b"]);
  assert.equal(uppr0.textures[0].variant, "a");
  assert.equal(uppr0.textures[0].race, "uni");
  const uppr1 = ped.components.uppr.drawables[1];
  assert.equal(uppr1.raceDependent, true);
  assert.equal(uppr1.textures.length, 2);
  assert.equal(ped.components.lowr.drawables[0].textures.length, 0);
  assert.equal(ped.props.p_head.drawables[0].drawablePath, "s/mp_m_freemode_01_p_pack^p_head_000.ydd");
  assert.equal(ped.props.p_head.drawables[0].textures[0].variant, "a");
});

test("groupEupAssets attributes base-game names via path or defaultPed", () => {
  const fromPath = groupEupAssets([{ path: "x/mp_f_freemode_01/feet_002_u.ydd" }]);
  assert.ok(fromPath.peds.mp_f_freemode_01.components.feet.drawables[2]);

  const fromDefault = groupEupAssets([{ path: "feet_002_u.ydd" }], { defaultPed: "mp_m_freemode_01" });
  assert.ok(fromDefault.peds.mp_m_freemode_01.components.feet.drawables[2]);

  const unassigned = groupEupAssets(["feet_002_u.ydd"]);
  assert.ok(unassigned.peds.unassigned.components.feet.drawables[2]);
});

test("resolveTextureForDrawable prefers the requested variant and race", () => {
  const grouped = groupEupAssets(PACK);
  const uppr1 = grouped.peds.mp_m_freemode_01.components.uppr.drawables[1];
  assert.equal(resolveTextureForDrawable(uppr1, "a", { race: "bla" }).race, "bla");
  assert.equal(resolveTextureForDrawable(uppr1, "a").race, "whi");
  assert.equal(resolveTextureForDrawable(uppr1, "z").race, "whi");
  const uppr0 = grouped.peds.mp_m_freemode_01.components.uppr.drawables[0];
  assert.equal(resolveTextureForDrawable(uppr0, "b").variant, "b");
  assert.equal(resolveTextureForDrawable(uppr0, "c").variant, "a");
  assert.equal(resolveTextureForDrawable({ textures: [] }, "a"), null);
});

test("validateEupNames reports streaming and pairing problems", () => {
  const issues = validateEupNames([
    ...PACK,
    { path: "s/mp_m_freemode_01_pack^uppr_diff_005_a_uni.ytd" },
    { path: "s/mp_m_freemode_01_pack^Uppr_007_u.ydd" },
    { path: "s/mp_m_freemode_01_pack^uppr_007_r.ydd" },
    { path: "s/mp_m_freemode_01_pack^uppr_diff_007_a_uni.ytd" },
    { path: "s/mp_m_freemode_01_pack^uppr_009_r.ydd" },
    { path: "s/mp_m_freemode_01_pack^uppr_diff_009_a_uni.ytd" },
    { path: "s/mp_f_freemode_01_pack^feet_000_u.ydd" },
    { path: "s/mp_f_freemode_01_pack^feet_diff_000_a_uni.ytd", size: 17 * 1024 * 1024 },
  ]);
  const codes = issues.map((item) => item.code);
  assert.ok(codes.includes("unrecognized-name"));
  assert.ok(codes.includes("uppercase"));
  assert.ok(codes.includes("texture-without-drawable"));
  assert.ok(codes.includes("drawable-without-texture"));
  assert.ok(codes.includes("index-gap"));
  assert.ok(codes.includes("race-texture-missing"));
  assert.ok(codes.includes("mixed-peds"));
  assert.ok(codes.includes("duplicate-drawable"));
  assert.ok(codes.includes("ytd-too-large"));
  for (const item of issues) {
    assert.ok(["error", "warning"].includes(item.severity));
    assert.ok(typeof item.message === "string" && item.message.length > 0);
  }
});

test("validateEupNames is quiet for a clean pack", () => {
  const issues = validateEupNames([
    { path: "s/mp_m_freemode_01_pack^uppr_000_u.ydd" },
    { path: "s/mp_m_freemode_01_pack^uppr_diff_000_a_uni.ytd" },
    { path: "s/mp_m_freemode_01_pack^uppr_001_u.ydd" },
    { path: "s/mp_m_freemode_01_pack^uppr_diff_001_a_uni.ytd" },
  ]);
  assert.deepEqual(issues, []);
});

test("selectBaseGameAssets prefers the ped folder and universal drawables", () => {
  const entries = [
    { folder: "mp_m_freemode_01_heist", file: "uppr_000_u.ydd", kind: "ydd" },
    { folder: "mp_m_freemode_01", file: "uppr_000_r.ydd", kind: "ydd" },
    { folder: "mp_m_freemode_01", file: "uppr_000_u.ydd", kind: "ydd" },
    { folder: "mp_m_freemode_01", file: "uppr_diff_000_a_uni.ytd", kind: "ytd" },
    { folder: "mp_m_freemode_01", file: "head_000_r.ydd", kind: "ydd" },
    { folder: "mp_m_freemode_01", file: "head_diff_000_a_whi.ytd", kind: "ytd" },
    { folder: "mp_m_freemode_01", file: "head_diff_000_a_bla.ytd", kind: "ytd" },
    { folder: "mp_m_freemode_01_p", file: "p_head_000.ydd", kind: "ydd" },
    { folder: "mp_m_freemode_01_p", file: "p_head_diff_000_a.ytd", kind: "ytd" },
  ];
  const uppr = selectBaseGameAssets(entries, "mp_m_freemode_01", "uppr", 0);
  assert.equal(uppr.drawable.folder, "mp_m_freemode_01");
  assert.equal(uppr.drawable.file, "uppr_000_u.ydd");
  assert.equal(uppr.texture.file, "uppr_diff_000_a_uni.ytd");

  const head = selectBaseGameAssets(entries, "mp_m_freemode_01", "head", 0, { race: "bla" });
  assert.equal(head.drawable.file, "head_000_r.ydd");
  assert.equal(head.texture.file, "head_diff_000_a_bla.ytd");
  const headDefault = selectBaseGameAssets(entries, "mp_m_freemode_01", "head", 0);
  assert.equal(headDefault.texture.file, "head_diff_000_a_whi.ytd");

  const prop = selectBaseGameAssets(entries, "mp_m_freemode_01", "p_head", 0);
  assert.equal(prop.drawable.file, "p_head_000.ydd");
  assert.equal(prop.texture.file, "p_head_diff_000_a.ytd");

  const missing = selectBaseGameAssets(entries, "mp_m_freemode_01", "lowr", 3);
  assert.equal(missing.drawable, null);
  assert.equal(missing.texture, null);
});

test("buildOutfitLabel and classifyTextureName produce stable output", () => {
  assert.equal(buildOutfitLabel({ gender: "male" }), "Male base");
  assert.equal(
    buildOutfitLabel({ gender: "female", selections: { lowr: { index: 2, variant: "b" }, uppr: { index: 5, variant: "a" } } }),
    "Female: uppr 005a, lowr 002b",
  );
  assert.equal(classifyTextureName("uppr_diff_000_a_uni.dds"), "diffuse");
  assert.equal(classifyTextureName("uppr_normal_000.dds"), "normal");
  assert.equal(classifyTextureName("uppr_spec_000.dds"), "specular");
  assert.equal(classifyTextureName("mask.dds"), "other");
});

test("missingVariantLetters reports gaps before the last variant only", () => {
  assert.deepEqual(missingVariantLetters(["a", "b", "c"]), []);
  assert.deepEqual(missingVariantLetters(["a", "c", "e"]), ["b", "d"]);
  assert.deepEqual(missingVariantLetters(["b"]), ["a"]);
  assert.deepEqual(missingVariantLetters([]), []);
});

test("validateEupNames flags texture variant gaps", () => {
  const issues = validateEupNames([
    "jbib_000_u.ydd",
    "jbib_diff_000_a_uni.ytd",
    "jbib_diff_000_c_uni.ytd",
  ]);
  const gap = issues.find((item) => item.code === "variant-gap");
  assert.ok(gap);
  assert.match(gap.message, /missing b/);
});

test("game ids follow component and prop anchor order", () => {
  assert.equal(componentGameId("head"), 0);
  assert.equal(componentGameId("accs"), 8);
  assert.equal(componentGameId("jbib"), 11);
  assert.equal(componentGameId("p_head"), null);
  assert.equal(propAnchorId("p_head"), 0);
  assert.equal(propAnchorId("p_rwrist"), 7);
  assert.equal(propAnchorId("jbib"), null);
  assert.equal(variantTextureIndex("a"), 0);
  assert.equal(variantTextureIndex("c"), 2);
  assert.equal(variantTextureIndex("?"), 0);
});

test("cycleValue wraps both directions and enters from the matching end", () => {
  const list = [null, 0, 3, 7];
  assert.equal(cycleValue(list, null, 1), 0);
  assert.equal(cycleValue(list, 7, 1), null);
  assert.equal(cycleValue(list, null, -1), 7);
  assert.equal(cycleValue(list, 42, 1), null);
  assert.equal(cycleValue(list, 42, -1), 7);
  assert.equal(cycleValue([], 1, 1), null);
});

test("pathKey matches watcher and scanned paths regardless of case and separator", () => {
  assert.equal(pathKey("C:/Stream/JBIB_000_U.ydd"), pathKey("c:\\stream\\jbib_000_u.ydd"));
  assert.equal(pathKey(null), "");
});

test("formatBytes uses compact units", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(17 * 1048576), "17.0 MB");
  assert.equal(formatBytes(null), "");
});

test("textureBudgetWarnings flags oversize, NPOT, missing mips and uncompressed data", () => {
  assert.deepEqual(textureBudgetWarnings({ width: 1024, height: 1024, mipMapCount: 11, fmt: "DXT5" }), []);
  assert.deepEqual(textureBudgetWarnings({ width: 4096, height: 4096, mipMapCount: 13, fmt: "BC7" }), [
    "4096x4096 exceeds 2048 px",
  ]);
  assert.deepEqual(textureBudgetWarnings({ width: 1000, height: 512, mipMapCount: 1, fmt: "BGRA" }), [
    "not a power of two",
    "no mipmaps",
    "uncompressed",
  ]);
  assert.deepEqual(textureBudgetWarnings({ width: 32, height: 32, mipMapCount: 1, fmt: "DXT1" }), []);
  assert.deepEqual(textureBudgetWarnings(null), []);
});

test("listThumbnailJobs renders one file per drawable or per variant", () => {
  const grouped = groupEupAssets([
    "mp_m_freemode_01_pack^jbib_000_u.ydd",
    "mp_m_freemode_01_pack^jbib_diff_000_a_uni.ytd",
    "mp_m_freemode_01_pack^jbib_diff_000_b_uni.ytd",
    "mp_m_freemode_01_pack^jbib_diff_001_a_uni.ytd",
    "mp_m_freemode_01_pack_p^p_head_002.ydd",
    "mp_m_freemode_01_pack_p^p_head_diff_002_a.ytd",
    "mp_m_freemode_01_pack^lowr_004_r.ydd",
  ]);
  const assets = grouped.peds.mp_m_freemode_01;
  const first = listThumbnailJobs(assets, { gender: "male" });
  assert.deepEqual(first.map((job) => job.fileName), [
    "male_lowr_004_a.png",
    "male_jbib_000_a.png",
    "male_p_head_002_a.png",
  ]);
  assert.equal(first[0].ytdPath, null);
  assert.equal(first[1].ytdPath, "mp_m_freemode_01_pack^jbib_diff_000_a_uni.ytd");

  const every = listThumbnailJobs(assets, { gender: "male", allVariants: true, components: ["jbib"] });
  assert.deepEqual(every.map((job) => job.fileName), ["male_jbib_000_a.png", "male_jbib_000_b.png"]);
  assert.equal(every[1].ytdPath, "mp_m_freemode_01_pack^jbib_diff_000_b_uni.ytd");
  assert.equal(thumbnailFileName({ gender: "female", component: "feet", index: 7, variant: "zz" }), "female_feet_007_a.png");
});

test("buildOutfitLua emits component and prop natives with pack notes", () => {
  const lua = buildOutfitLua({
    name: "Patrol\nClass B",
    gender: "female",
    slots: [
      { component: "head", index: 0, variant: "a", source: "base" },
      { component: "hair", index: 0, variant: "a", source: "base" },
      { component: "jbib", index: 3, variant: "c", source: "eup", file: "mp_f_freemode_01_pd^jbib_003_u.ydd" },
      { component: "uppr", index: 15, variant: "a", source: "base" },
      { component: "p_head", index: 1, variant: "b", source: "eup", file: "p_head_001.ydd" },
    ],
  });
  const lines = lua.trim().split("\n");
  assert.equal(lines[0], "-- Patrol Class B (mp_f_freemode_01)");
  assert.ok(lines.some((line) => line.startsWith("-- Pack ids are stream-file indices")));
  assert.ok(lines.includes("local ped = PlayerPedId()"));
  assert.ok(!lua.includes("SetPedComponentVariation(ped, 0,"), "head base slot is left to the character");
  assert.ok(!lua.includes("SetPedComponentVariation(ped, 2,"), "hair base slot is left to the character");
  const natives = lines.filter((line) => line.startsWith("Set"));
  assert.deepEqual(natives, [
    "SetPedComponentVariation(ped, 3, 15, 0, 0) -- uppr base",
    "SetPedComponentVariation(ped, 11, 3, 2, 0) -- jbib pack mp_f_freemode_01_pd^jbib_003_u.ydd",
    "SetPedPropIndex(ped, 0, 1, 1, true) -- p_head pack p_head_001.ydd",
  ]);

  const baseOnly = buildOutfitLua({ gender: "male", slots: [{ component: "lowr", index: 4, source: "base" }] });
  assert.ok(!baseOnly.includes("Pack ids"));
});

test("normalizeOutfitPresets drops malformed entries and invalid slot values", () => {
  const result = normalizeOutfitPresets({
    male: [
      { id: "a", name: "  Patrol  ", selections: { jbib: { index: 3, variant: "b" }, lowr: { index: -1 } }, baseOverrides: { hair: { enabled: false } } },
      { id: "", name: "No id" },
      { id: "b", name: "   " },
      null,
    ],
    female: "nope",
  });
  assert.deepEqual(result.female, []);
  assert.equal(result.male.length, 1);
  assert.deepEqual(result.male[0], {
    id: "a",
    name: "Patrol",
    selections: { jbib: { index: 3, variant: "b" } },
    baseOverrides: { hair: { enabled: false } },
    pieces: [],
    piecePaths: [],
  });
  assert.deepEqual(normalizeOutfitPresets(undefined), { male: [], female: [] });
  const withPieces = normalizeOutfitPresets({
    male: [{ id: "c", name: "Vest", pieces: ["piece-1", "piece-1", "bad id", 4, "piece-2"] }],
  });
  assert.deepEqual(withPieces.male[0].pieces, ["piece-1", "piece-2"]);
});

test("skin tint applies to race-dependent head and arm drawables wearing _whi textures", async () => {
  const { isSkinTintSlot, listPackRaces, normalizeSkinTone, skinToneTint } = await import("./eup.js");
  assert.equal(isSkinTintSlot({ component: "uppr", drawableFile: "uppr_015_r.ydd", textureFile: "uppr_diff_015_a_whi.ytd" }), true);
  assert.equal(isSkinTintSlot({ component: "head", drawableFile: "C:\cache\head_000_r_1.ydd", textureFile: "head_diff_000_a_whi.ytd" }), true);
  assert.equal(isSkinTintSlot({ component: "uppr", drawableFile: "uppr_015_r.ydd", textureFile: "uppr_diff_015_a_bla.ytd" }), false, "a real race texture is not tinted");
  assert.equal(isSkinTintSlot({ component: "lowr", drawableFile: "lowr_000_r.ydd", textureFile: "lowr_diff_000_a_whi.ytd" }), false, "trousers keep their colour");
  assert.equal(isSkinTintSlot({ component: "jbib", drawableFile: "jbib_015_u.ydd", textureFile: "jbib_diff_015_a_uni.ytd" }), false);
  assert.equal(normalizeSkinTone("nope"), "light");
  assert.equal(skinToneTint("light"), null);
  assert.match(skinToneTint("dark"), /^#[0-9a-f]{6}$/);

  const pedAssets = { components: { uppr: { drawables: { 5: { textures: [{ race: "whi" }, { race: "bla" }, { race: "uni" }] } } } }, props: {} };
  assert.deepEqual(listPackRaces(pedAssets), ["whi", "bla"]);
  assert.deepEqual(listPackRaces({ components: {}, props: {} }), []);
});

test("in-game drawable numbers run across DLC collections in load order", async () => {
  const { buildDrawableRanges, resolveDrawableNumber } = await import("./eup.js");
  const ped = "mp_m_freemode_01";
  const entries = [
    ...Array.from({ length: 16 }, (_, i) => ({ folder: ped, file: `uppr_${String(i).padStart(3, "0")}_r.ydd`, kind: "ydd" })),
    { folder: `${ped}_male_heist`, file: "uppr_000_u.ydd", kind: "ydd" },
    { folder: `${ped}_male_heist`, file: "uppr_001_u.ydd", kind: "ydd" },
    { folder: `${ped}_male_heist`, file: "uppr_diff_001_a_uni.ytd", kind: "ytd" },
    { folder: `${ped}_mp_m_gunrunning_01`, file: "uppr_000_r.ydd", kind: "ydd" },
    { folder: `${ped}_mp_m_gunrunning_01`, file: "uppr_002_r.ydd", kind: "ydd" },
    { folder: `${ped}_mp_m_gunrunning_01`, file: "uppr_diff_002_a_whi.ytd", kind: "ytd" },
    { folder: `${ped}_mp_m_gunrunning_01`, file: "jbib_000_u.ydd", kind: "ydd" },
  ];
  const collections = [
    { folder: ped, pack: "" },
    { folder: `${ped}_male_heist`, pack: "mpheist" },
    { folder: `${ped}_empty`, pack: "mpempty" },
    { folder: `${ped}_mp_m_gunrunning_01`, pack: "mpgunrunning" },
  ];
  const ranges = buildDrawableRanges(entries, collections, "uppr");
  assert.deepEqual(ranges.map((r) => [r.pack, r.start, r.count]), [["", 0, 16], ["mpheist", 16, 2], ["mpgunrunning", 18, 3]]);
  assert.deepEqual(resolveDrawableNumber(ranges, 17), { folder: `${ped}_male_heist`, pack: "mpheist", local: 1 });
  assert.deepEqual(resolveDrawableNumber(ranges, 20), { folder: `${ped}_mp_m_gunrunning_01`, pack: "mpgunrunning", local: 2 });
  assert.equal(resolveDrawableNumber(ranges, 21), null);

  const picked = selectBaseGameAssets(entries, ped, "uppr", 20, { collections });
  assert.equal(picked.drawable.file, "uppr_002_r.ydd");
  assert.equal(picked.drawable.folder, `${ped}_mp_m_gunrunning_01`);
  assert.equal(picked.texture.file, "uppr_diff_002_a_whi.ytd");
  assert.equal(selectBaseGameAssets(entries, ped, "uppr", 99, { collections }).drawable, null);
  assert.equal(selectBaseGameAssets(entries, ped, "uppr", 3, { collections }).drawable.folder, ped, "base numbers stay in the ped's folder");
});

test("the game drawable index skips missing numbers and lists texture letters", async () => {
  const { buildGameDrawableIndex, stepGameDrawable } = await import("./eup.js");
  const ped = "mp_m_freemode_01";
  const entries = [
    { folder: ped, file: "jbib_000_u.ydd", kind: "ydd" },
    { folder: ped, file: "jbib_002_u.ydd", kind: "ydd" },
    { folder: ped, file: "jbib_diff_002_a_uni.ytd", kind: "ytd" },
    { folder: ped, file: "jbib_diff_002_c_uni.ytd", kind: "ytd" },
    { folder: ped, file: "jbib_diff_002_b_uni.ytd", kind: "ytd" },
    { folder: `${ped}_male_freemode_beach`, file: "jbib_000_u.ydd", kind: "ydd" },
  ];
  const collections = [{ folder: ped, pack: "" }, { folder: `${ped}_male_freemode_beach`, pack: "mpbeach" }];
  const index = buildGameDrawableIndex(entries, collections, "jbib");
  assert.deepEqual(index.numbers, [0, 2, 3], "number 1 has no drawable file");
  assert.equal(index.total, 4);
  assert.deepEqual(index.variants.get(2), ["a", "b", "c"]);
  assert.equal(stepGameDrawable(index.numbers, 0, 1), 2);
  assert.equal(stepGameDrawable(index.numbers, 3, 1), 0, "stepping past the end wraps");
  assert.equal(stepGameDrawable(index.numbers, 0, -1), 3);

  const variant = selectBaseGameAssets(entries, ped, "jbib", 2, { collections, variant: "c" });
  assert.equal(variant.texture.file, "jbib_diff_002_c_uni.ytd");
});

test("hair colours and saved skin tones normalise to known values", async () => {
  const { normalizeHair, normalizeSkinTone, DEFAULT_HAIR, SKIN_TONES } = await import("./eup.js");
  assert.deepEqual(normalizeHair({ color: "#AABBCC", highlight: "nope" }), { color: "#aabbcc", highlight: DEFAULT_HAIR.highlight });
  assert.deepEqual(normalizeHair(null), { ...DEFAULT_HAIR });
  assert.equal(normalizeSkinTone("medium"), "fair", "older saved tones map to the calibrated set");
  assert.equal(normalizeSkinTone("deep"), "dark");
  assert.equal(SKIN_TONES.length, 6);
});

test("body presets pair parent faces with calibrated skin tones and base hair", async () => {
  const { bodyPresetsFor, SKIN_TONES, HAIR_COLORS } = await import("./eup.js");
  for (const gender of ["male", "female"]) {
    const presets = bodyPresetsFor(gender);
    assert.ok(presets.length >= 6);
    assert.equal(new Set(presets.map((p) => p.label)).size, presets.length, "labels are unique");
    for (const preset of presets) {
      assert.ok(SKIN_TONES.some((tone) => tone.id === preset.skin));
      assert.ok(HAIR_COLORS.some((color) => color.color === preset.hairColors.color));
      assert.ok(preset.hair >= 0 && preset.hair <= 15, "base-game hairstyles only");
      const female = preset.head >= 21 && preset.head <= 41;
      assert.equal(female, gender === "female", "parent faces match the ped");
    }
  }
});

test("Photo Mode clothing presets stay in base-game numbers", async () => {
  const { CLOTHING_PRESETS } = await import("./eup.js");
  for (const gender of ["male", "female"]) {
    for (const preset of CLOTHING_PRESETS[gender]) {
      for (const index of Object.values(preset.slots)) assert.ok(index >= 0 && index <= 15, `${preset.id} uses base numbers`);
      assert.deepEqual(Object.keys(preset.slots).sort(), ["accs", "feet", "jbib", "lowr", "uppr"]);
    }
  }
});

test("packs loaded together number after each other instead of colliding", () => {
  const files = [
    "s/jbib_000_u.ydd",
    "s/jbib_diff_000_a_uni.ytd",
    "hair/mp_m_freemode_01_cityhair^hair_000_u.ydd",
    "hair/mp_m_freemode_01_cityhair^hair_diff_000_a_uni.ytd",
    "tops/mp_m_freemode_01_citytops^jbib_000_u.ydd",
    "tops/mp_m_freemode_01_citytops^jbib_diff_000_a_uni.ytd",
    "tops/mp_m_freemode_01_citytops^jbib_002_u.ydd",
    "tops/mp_m_freemode_01_citytops^jbib_diff_002_a_uni.ytd",
    "more/mp_m_freemode_01_moretops^jbib_000_u.ydd",
    "more/mp_m_freemode_01_moretops^jbib_diff_000_a_uni.ytd",
  ].map((path) => ({ path }));
  const ped = groupEupAssets(files, { defaultPed: "mp_m_freemode_01" }).peds.mp_m_freemode_01;
  // The unnamed files come first, then each pack in listing order.
  assert.deepEqual(listDrawableIndices(ped.components.jbib), [0, 1, 3, 4]);
  assert.equal(ped.components.jbib.drawables[0].drawablePath, "s/jbib_000_u.ydd");
  const second = ped.components.jbib.drawables[3];
  assert.equal(second.drawablePath, "tops/mp_m_freemode_01_citytops^jbib_002_u.ydd");
  assert.equal(second.pack, "citytops");
  assert.equal(second.localIndex, 2);
  assert.equal(ped.components.jbib.drawables[4].pack, "moretops");
  assert.equal(ped.components.hair.drawables[0].pack, "cityhair", "each slot numbers its own packs");

  const issues = validateEupNames(files, { defaultPed: "mp_m_freemode_01" });
  const codes = issues.map((item) => item.code);
  assert.ok(!codes.includes("duplicate-drawable"), "the same file number in two packs is not a duplicate");
  const gap = issues.find((item) => item.code === "index-gap");
  assert.match(gap.message, /citytops jbib 000 -> 002/, "gaps name the pack and its own file numbers");
});

test("loaded server packs continue the game's drawable numbers", async () => {
  const { buildGameDrawableIndex, buildServerPackListing, extendPedListing, resolveDrawableNumber } = await import("./eup.js");
  const ped = "mp_f_freemode_01";
  const game = {
    entries: [
      ...[0, 1, 2].map((i) => ({ folder: ped, file: `hair_00${i}_u.ydd`, kind: "ydd" })),
      { folder: ped, file: "hair_diff_002_a_uni.ytd", kind: "ytd" },
      { folder: `${ped}_p`, file: "p_head_000.ydd", kind: "ydd" },
    ],
    collections: [{ folder: ped, pack: "" }, { folder: `${ped}_p`, pack: "" }],
  };
  const files = [
    "c:/server/hair/mp_f_freemode_01_braids^hair_000_u.ydd",
    "c:/server/hair/mp_f_freemode_01_braids^hair_diff_000_a_uni.ytd",
    "c:/server/hair/mp_f_freemode_01_braids^hair_diff_000_b_uni.ytd",
    "c:/server/hair/mp_f_freemode_01_braids^hair_001_u.ydd",
    "c:/server/hats/mp_f_freemode_01_p_braids^p_head_000.ydd",
    "c:/server/hats/mp_f_freemode_01_p_braids^p_head_diff_000_a.ytd",
    "c:/server/loose/hair_005_u.ydd",
    "c:/server/male/mp_m_freemode_01_braids^hair_000_u.ydd",
  ].map((path) => ({ path }));
  const grouped = groupEupAssets(files, { defaultPed: ped });
  const server = buildServerPackListing(grouped.files, ped);
  assert.deepEqual(server.collections, [
    { folder: `${ped}_braids`, pack: "braids", server: true },
    { folder: `${ped}_p_braids`, pack: "braids", server: true },
  ], "one folder per pack and kind; loose names and the other ped are left out");
  assert.ok(server.entries.every((entry) => !entry.file.includes("^")), "entries use the game's file names");

  const listing = extendPedListing(game, server);
  assert.equal(extendPedListing(game, { entries: [], collections: [] }), game);
  assert.equal(extendPedListing({ entries: [], collections: [] }, server).collections.length, 0, "no game numbering, nothing to extend");

  const hair = buildGameDrawableIndex(listing.entries, listing.collections, "hair");
  assert.equal(hair.gameTotal, 3);
  assert.equal(hair.total, 5);
  assert.deepEqual(hair.numbers, [0, 1, 2, 3, 4]);
  assert.deepEqual(hair.variants.get(3), ["a", "b"]);
  assert.deepEqual(resolveDrawableNumber(hair.ranges, 4), { folder: `${ped}_braids`, pack: "braids", local: 1, server: true });
  assert.equal(resolveDrawableNumber(hair.ranges, 2).server, undefined, "game numbers are not server numbers");

  const picked = selectBaseGameAssets(listing.entries, ped, "hair", 3, { collections: listing.collections, variant: "b" });
  assert.equal(picked.drawable.path, "c:/server/hair/mp_f_freemode_01_braids^hair_000_u.ydd");
  assert.equal(picked.texture.path, "c:/server/hair/mp_f_freemode_01_braids^hair_diff_000_b_uni.ytd");
  const hat = selectBaseGameAssets(listing.entries, ped, "p_head", 1, { collections: listing.collections });
  assert.equal(hat.drawable.path, "c:/server/hats/mp_f_freemode_01_p_braids^p_head_000.ydd");

  // A pack named like a game folder would make its numbers ambiguous.
  const clash = extendPedListing({ ...game, collections: [...game.collections, { folder: `${ped}_braids`, pack: "mpbraids" }] }, server);
  assert.ok(!clash.collections.some((item) => item.server && item.folder === `${ped}_braids`));
});

test("the outfit Lua labels server pack slots and states the load-order assumption", () => {
  const lua = buildOutfitLua({
    name: "Street",
    gender: "female",
    slots: [
      { component: "jbib", index: 412, variant: "b", source: "base", server: true, pack: "citytops" },
      { component: "hair", index: 80, variant: "a", source: "base", server: true, pack: "braids" },
      { component: "lowr", index: 4, variant: "a", source: "base" },
    ],
  });
  assert.ok(lua.includes("SetPedComponentVariation(ped, 11, 412, 1, 0) -- jbib server pack citytops"));
  assert.ok(lua.includes("SetPedComponentVariation(ped, 4, 4, 0, 0) -- lowr base"));
  assert.ok(!lua.includes("SetPedComponentVariation(ped, 2,"), "hair stays with the player's character");
  assert.match(lua, /same packs in that order/);
  assert.ok(!buildOutfitLua({ slots: [{ component: "lowr", index: 4, source: "base" }] }).includes("Server pack"));
});
