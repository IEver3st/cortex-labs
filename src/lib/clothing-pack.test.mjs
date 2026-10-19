import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SLOT_ITEMS,
  canWriteClothingTextures,
  checkPackName,
  fxManifestLua,
  groupClothingFiles,
  parseClothingName,
  planClothingPackBuild,
  planClothingTextureWrite,
  shopMetaXml,
  stageClothingTextures,
} from "./clothing-pack.js";
import { buildPedVariation, componentData, drawableEntry, parsePedVariationXml, propEntry, defaultPropMeta } from "./ped-variation-xml.js";
import { clothingBuildRequest, clothingCommitRequest } from "./clothing-write.js";

const M = "mp_m_freemode_01";
const VESTS = `C:/res/vests/stream/${M}_mp_m_vests`;

function vestFiles({ textures = ["a", "b"], ymt = true } = {}) {
  return [
    `${VESTS}^task_000_u.ydd`,
    ...textures.map((letter) => `${VESTS}^task_diff_000_${letter}_uni.ytd`),
    `${VESTS}^task_001_r.ydd`,
    `${VESTS}^task_001_r.yld`,
    `${VESTS}^task_diff_001_a_whi.ytd`,
    `${VESTS}^task_diff_009_a_uni.ytd`,
    ...(ymt ? [`C:/res/vests/stream/${M}_mp_m_vests.ymt`] : []),
    "C:/res/vests/stream/readme.ytd",
  ].map((path) => ({ path }));
}

function vestModel(counts = [2, 1]) {
  const drawable = (count, propMask) => ({ propMask, numAlternatives: 0, textures: Array.from({ length: count }, () => ({ texId: 0, distribution: 255 })), ownsCloth: false });
  return buildPedVariation({
    name: "mp_m_vests",
    dlcName: "mp_m_vests",
    components: new Map([[9, [{ drawable: drawable(counts[0], 1), info: null }, { drawable: drawable(counts[1], 17), info: null }]]]),
  });
}

const shape = (name) => ({ legacy: true, texture: { name, width: 1024, height: 1024, levels: 11 } });

test("clothing file names give their pack, slot, number and texture", () => {
  assert.deepEqual(
    (({ kind, ped, dlc, isProp, slot, slotId, index, suffix, alternate }) => ({ kind, ped, dlc, isProp, slot, slotId, index, suffix, alternate }))(parseClothingName(`${VESTS}^task_003_u_1.ydd`)),
    { kind: "drawable", ped: M, dlc: "mp_m_vests", isProp: false, slot: "task", slotId: 9, index: 3, suffix: "u", alternate: 1 },
  );
  const hat = parseClothingName("mp_f_freemode_01_p_mp_f_hats^p_head_diff_002_c.ytd");
  assert.equal(hat.kind, "texture");
  assert.equal(hat.isProp, true);
  assert.equal(hat.letter, "c");
  assert.equal(hat.race, null);
  assert.equal(parseClothingName("jbib_000_r.yld").kind, "cloth");
  assert.equal(parseClothingName("jbib_000_r.yld").ped, null);
  assert.equal(parseClothingName("shirt.ydd"), null);
});

test("a folder groups into packs and items, with stray and unknown files", () => {
  const { packs, stray, unknown } = groupClothingFiles(vestFiles());
  assert.equal(packs.length, 1);
  const [pack] = packs;
  assert.equal(pack.dlc, "mp_m_vests");
  assert.equal(pack.ymtPath, `C:/res/vests/stream/${M}_mp_m_vests.ymt`);
  assert.deepEqual(pack.items.map((item) => [item.index, item.suffix, item.textures.map((texture) => texture.letter)]), [[0, "u", ["a", "b"]], [1, "r", ["a"]]]);
  assert.equal(pack.items[1].cloth, `${VESTS}^task_001_r.yld`);
  assert.deepEqual(stray, [`${VESTS}^task_diff_009_a_uni.ytd`]);
  assert.deepEqual(unknown, ["C:/res/vests/stream/readme.ytd"]);
});

test("replacing a texture keeps the pack file as it is", () => {
  const [pack] = groupClothingFiles(vestFiles()).packs;
  const item = pack.items[0];
  const variants = { [item.textures[0].path]: shape("task_diff_000_a_uni"), [item.textures[1].path]: shape("task_diff_000_b_uni") };
  const plan = planClothingTextureWrite({
    item, model: vestModel(), ymtPath: pack.ymtPath, variants,
    staged: [{ id: "one", path: "C:/art/b.png", letter: "b" }],
    sources: { one: { width: 1024, height: 1024 } },
  });
  assert.equal(plan.blocked, null);
  assert.equal(plan.ymt, null);
  assert.deepEqual(plan.files.map((file) => [file.mode, file.letter, file.textures[0].name]), [["replace", "b", "task_diff_000_b_uni"]]);
  assert.ok(canWriteClothingTextures(plan));
});

test("added textures become new files counted in the pack file", () => {
  const [pack] = groupClothingFiles(vestFiles()).packs;
  const item = pack.items[0];
  const variants = { [item.textures[0].path]: shape("task_diff_000_a_uni"), [item.textures[1].path]: shape("task_diff_000_b_uni") };
  const plan = planClothingTextureWrite({
    item, model: vestModel(), ymtPath: pack.ymtPath, ymtXml: "<read/>", variants,
    staged: [{ id: "c", path: "C:/art/c.png", letter: "c" }, { id: "d", path: "C:/art/d.png", letter: "d" }],
    sources: { c: { width: 1024, height: 1024 }, d: { width: 512, height: 1024 } },
  });
  assert.equal(plan.blocked, null);
  assert.deepEqual(plan.files.map((file) => [file.mode, file.path, file.template]), [
    ["create", `${VESTS}^task_diff_000_c_uni.ytd`, item.textures[0].path],
    ["create", `${VESTS}^task_diff_000_d_uni.ytd`, item.textures[0].path],
  ]);
  // The copy of texture a holds the new texture under its own name, a's removed.
  assert.deepEqual(plan.files[0].textures.map((texture) => [texture.mode, texture.name, texture.like || null]), [
    ["insert", "task_diff_000_c_uni", "task_diff_000_a_uni"],
    ["delete", "task_diff_000_a_uni", null],
  ]);
  assert.deepEqual([plan.ymt.before, plan.ymt.after], [2, 4]);
  const written = parsePedVariationXml(plan.ymt.xml);
  assert.equal(drawableEntry(written, 9, 0).drawable.textures.length, 4);
  assert.equal(componentData(written, 9).numAvailTex, 5);
  assert.ok(plan.checks.some((check) => check.tone === "caution" && /another shape/.test(check.text)));

  const request = clothingCommitRequest(plan, "token", "20261019-120000");
  // The commit sends the file as it was read, so the host can tell if it changed since.
  assert.deepEqual(request.ymt, { path: pack.ymtPath, xml: plan.ymt.xml, base: "<read/>" });
  assert.deepEqual(request.ytds[0].textures, [
    { name: "task_diff_000_c_uni", mode: "insert", id: "c-1024x1024-11", like: "task_diff_000_a_uni" },
    { name: "task_diff_000_a_uni", mode: "delete" },
  ]);
  assert.equal(request.ytds[0].template, item.textures[0].path);
});

test("textures follow the races the pack file gives", () => {
  const files = [`${VESTS}^task_000_u.ydd`, `${VESTS}^task_diff_000_a_uni.ytd`, `${VESTS}^task_diff_000_a_whi.ytd`, `${VESTS}^task_diff_000_b_whi.ytd`];
  const [pack] = groupClothingFiles(files.map((path) => ({ path }))).packs;
  const item = pack.items[0];
  const model = buildPedVariation({
    name: "mp_m_vests",
    dlcName: "mp_m_vests",
    components: new Map([[9, [{ drawable: { propMask: 1, numAlternatives: 0, textures: [{ texId: 1, distribution: 255 }, { texId: 1, distribution: 255 }], ownsCloth: false }, info: null }]]]),
  });
  const variants = Object.fromEntries(item.textures.map((texture) => [texture.path, shape("t")]));
  const sources = { a: { width: 1024, height: 1024 }, c: { width: 1024, height: 1024 } };
  // Texture a is the whi file the pack names, not the first by name.
  const replace = planClothingTextureWrite({ item, model, ymtPath: "C:/x.ymt", variants, staged: [{ id: "a", path: "C:/art/a.png", letter: "a" }], sources });
  assert.equal(replace.files[0].path, `${VESTS}^task_diff_000_a_whi.ytd`);
  // A new texture copies the last one's race id, so its file is named for that race.
  const add = planClothingTextureWrite({ item, model, ymtPath: "C:/x.ymt", variants, staged: [{ id: "c", path: "C:/art/c.png", letter: "c" }], sources });
  assert.equal(add.files[0].path, `${VESTS}^task_diff_000_c_whi.ytd`);
  assert.equal(drawableEntry(parsePedVariationXml(add.ymt.xml), 9, 0).drawable.textures[2].texId, 1);
});

test("textures are not added where the numbers would go wrong", () => {
  const base = { variants: {}, staged: [{ id: "x", path: "C:/art/x.png", letter: "c" }], sources: { x: { width: 1, height: 1 } } };
  const gap = groupClothingFiles(vestFiles({ textures: ["a", "c"] })).packs[0];
  assert.match(planClothingTextureWrite({ item: gap.items[0], model: vestModel(), ymtPath: gap.ymtPath, ...base }).blocked, /skips a letter/);

  const noYmt = groupClothingFiles(vestFiles({ ymt: false })).packs[0];
  assert.match(planClothingTextureWrite({ item: noYmt.items[0], model: null, ymtPath: null, ...base }).blocked, /was not found/);

  const [pack] = groupClothingFiles(vestFiles()).packs;
  assert.match(planClothingTextureWrite({ item: pack.items[0], model: vestModel([3, 1]), ymtPath: pack.ymtPath, ...base }).blocked, /gives .* 3 textures but the folder has 2/);

  const loose = groupClothingFiles([{ path: `C:/m/${M}/task_000_u.ydd` }, { path: `C:/m/${M}/task_diff_000_a_uni.ytd` }]).packs[0];
  assert.match(planClothingTextureWrite({ item: loose.items[0], ...base, staged: [{ id: "x", path: "C:/art/x.png", letter: "b" }] }).blocked, /no pack name/);

  const unreadable = planClothingTextureWrite({
    item: pack.items[0], model: vestModel(), ymtPath: pack.ymtPath,
    variants: { [pack.items[0].textures[0].path]: { legacy: false, texture: null } },
    staged: [{ id: "x", path: "C:/art/x.png", letter: "a" }], sources: { x: { width: 1, height: 1 } },
  });
  assert.match(unreadable.blocked, /not a legacy GTA V texture dictionary/);

  // A staged d after a and b (texture c gone since it was staged) would leave the .ymt counting c.
  const skipped = planClothingTextureWrite({ item: pack.items[0], model: vestModel(), ymtPath: pack.ymtPath, ...base, staged: [{ id: "x", path: "C:/art/x.png", letter: "d" }] });
  assert.match(skipped.blocked, /new ones start at c\. Remove the staged d/);
});

test("staging images takes the letters after the item's last", () => {
  let id = 0;
  const makeId = () => `s${++id}`;
  const first = stageClothingTextures([], ["C:/art/10.png", "C:/art/2.png"], { count: 2, makeId });
  assert.deepEqual(first.staged.map((entry) => [entry.letter, entry.path]), [["c", "C:/art/2.png"], ["d", "C:/art/10.png"]]);
  const swapped = stageClothingTextures(first.staged, ["C:/art/new-a.png"], { count: 2, at: "a", makeId });
  assert.deepEqual(swapped.staged.map((entry) => entry.letter), ["a", "c", "d"]);
  const full = stageClothingTextures([], ["C:/art/1.png", "C:/art/2.png"], { count: 25, makeId });
  assert.deepEqual(full.staged.map((entry) => entry.letter), ["z"]);
  assert.match(full.skipped[0].reason, /a to z/);
});

test("pack names follow the game's rules", () => {
  assert.deepEqual(checkPackName(" gsd_uniforms "), { name: "gsd_uniforms" });
  for (const bad of ["", "GSD", "1pack", "my-pack", "a".repeat(33)]) assert.ok(checkPackName(bad).error, bad);
});

function source(id, root, items) {
  const files = items.flatMap(({ slot = "jbib", index, letters, suffix = "u", prefix = `${M}_mp_m_${id}` }) => [
    `${root}/${prefix}^${slot}_${String(index).padStart(3, "0")}_${suffix}.ydd`,
    ...letters.map((letter) => `${root}/${prefix}^${slot}_diff_${String(index).padStart(3, "0")}_${letter}_uni.ytd`),
  ]);
  return { id, label: id, packs: groupClothingFiles(files.map((path) => ({ path }))).packs };
}

test("a build numbers items per slot and writes the resource files", () => {
  const one = source("one", "C:/a", [{ index: 0, letters: ["a"] }, { index: 4, letters: ["a", "b"] }]);
  const hats = { id: "hats", label: "hats", packs: groupClothingFiles([`C:/h/${M}_p_mp_m_hats^p_head_000.ydd`, `C:/h/${M}_p_mp_m_hats^p_head_diff_000_a.ytd`].map((path) => ({ path }))).packs };
  const plan = planClothingPackBuild({ name: "gsd", sources: [one, hats], merge: true });
  assert.equal(plan.blocked, null);
  assert.deepEqual(plan.dlcs, [{ ped: M, dlc: "mp_m_gsd", ymt: `stream/${M}_mp_m_gsd.ymt`, meta: `${M}_mp_m_gsd.meta` }]);
  assert.deepEqual(plan.copies.map((copy) => copy.to), [
    `stream/${M}_mp_m_gsd/${M}_mp_m_gsd^jbib_000_u.ydd`,
    `stream/${M}_mp_m_gsd/${M}_mp_m_gsd^jbib_diff_000_a_uni.ytd`,
    `stream/${M}_mp_m_gsd/${M}_mp_m_gsd^jbib_001_u.ydd`,
    `stream/${M}_mp_m_gsd/${M}_mp_m_gsd^jbib_diff_001_a_uni.ytd`,
    `stream/${M}_mp_m_gsd/${M}_mp_m_gsd^jbib_diff_001_b_uni.ytd`,
    `stream/${M}_p_mp_m_gsd/${M}_p_mp_m_gsd^p_head_000.ydd`,
    `stream/${M}_p_mp_m_gsd/${M}_p_mp_m_gsd^p_head_diff_000_a.ytd`,
  ]);
  const model = parsePedVariationXml(plan.ymts[0].xml);
  assert.equal(model.dlcName, "mp_m_gsd");
  assert.deepEqual(componentData(model, 11).drawables.map((drawable) => drawable.textures.length), [1, 2]);
  assert.equal(propEntry(model, 0, 0).textures.length, 1);
  assert.deepEqual(plan.texts.map((text) => text.to), ["fxmanifest.lua", `${M}_mp_m_gsd.meta`]);
  assert.match(plan.texts[0].text, /data_file 'SHOP_PED_APPAREL_META_FILE' 'mp_m_freemode_01_mp_m_gsd\.meta'/);
  assert.match(shopMetaXml(M, "mp_m_gsd"), /<eCharacter>SCR_CHAR_MULTIPLAYER<\/eCharacter>/);
  assert.match(shopMetaXml("mp_f_freemode_01", "mp_f_gsd"), /SCR_CHAR_MULTIPLAYER_F/);
  assert.equal(fxManifestLua(["a.meta", "b.meta"]).match(/data_file/g).length, 2);

  const request = clothingBuildRequest(plan, "C:/out", "gsd_pack");
  assert.equal(request.name, "gsd_pack");
  assert.equal(request.copies.length, plan.copies.length);
  assert.deepEqual(request.ymts[0], { to: plan.ymts[0].to, text: plan.ymts[0].xml });
});

test("items with the same model merge and keep each texture once", () => {
  const one = source("one", "C:/a", [{ index: 0, letters: ["a", "b"] }]);
  const two = source("two", "C:/b", [{ index: 3, letters: ["a", "b"] }, { index: 4, letters: ["a"] }]);
  const drawableA = one.packs[0].items[0].drawable;
  const drawableB = two.packs[0].items[0].drawable;
  const identical = {
    [drawableA]: 1,
    [drawableB]: 1,
    // two's texture a is the same file as one's texture b.
    [one.packs[0].items[0].textures[1].path]: 2,
    [two.packs[0].items[0].textures[0].path]: 2,
  };
  const merged = planClothingPackBuild({ name: "gsd", sources: [one, two], identical, merge: true });
  assert.equal(merged.summary.items, 2);
  assert.equal(merged.summary.merged, 1);
  assert.deepEqual(merged.items[0].textures.map((texture) => texture.from), [
    ...one.packs[0].items[0].textures.map((texture) => texture.path),
    two.packs[0].items[0].textures[1].path,
  ]);
  assert.ok(merged.checks.some((check) => /1 identical texture is kept once/.test(check.text)));

  const apart = planClothingPackBuild({ name: "gsd", sources: [one, two], identical, merge: false });
  assert.equal(apart.summary.items, 3);
  assert.equal(apart.summary.merged, 0);
});

test("a full slot continues in a second pack in the same resource", () => {
  const many = source("many", "C:/m", Array.from({ length: MAX_SLOT_ITEMS + 2 }, (_, index) => ({ index, letters: ["a"] })));
  const plan = planClothingPackBuild({ name: "big", sources: [many] });
  assert.deepEqual(plan.dlcs.map((dlc) => dlc.dlc), ["mp_m_big", "mp_m_big_02"]);
  assert.equal(componentData(parsePedVariationXml(plan.ymts[0].xml), 11).drawables.length, MAX_SLOT_ITEMS);
  assert.equal(componentData(parsePedVariationXml(plan.ymts[1].xml), 11).drawables.length, 2);
  assert.ok(plan.checks.some((check) => /continues in mp_m_big_02/.test(check.text)));
  // A pack name ending in digits is not a split.
  const named = planClothingPackBuild({ name: "shirt_01", sources: [source("one", "C:/a", [{ index: 0, letters: ["a"] }])] });
  assert.ok(!named.checks.some((check) => /continues in/.test(check.text)));
});

test("first-person models are copied as their pack counts them", () => {
  const prefix = `C:/alt/${M}_mp_m_alt`;
  const files = [`${prefix}^jbib_000_u.ydd`, `${prefix}^jbib_000_u_1.ydd`, `${prefix}^jbib_000_u_2.ydd`, `${prefix}^jbib_diff_000_a_uni.ytd`];
  const alt = { id: "alt", label: "alt", packs: groupClothingFiles(files.map((path) => ({ path }))).packs };
  const alternatesOf = (plan) => plan.copies.filter((copy) => /_u_\d\.ydd$/.test(copy.to)).map((copy) => copy.from);
  const loose = planClothingPackBuild({ name: "gsd", sources: [alt] });
  assert.equal(drawableEntry(parsePedVariationXml(loose.ymts[0].xml), 11, 0).drawable.numAlternatives, 2);
  assert.equal(alternatesOf(loose).length, 2);

  const ymtPath = "C:/alt/one.ymt";
  alt.packs[0].ymtPath = ymtPath;
  const model = buildPedVariation({
    name: "mp_m_alt",
    dlcName: "mp_m_alt",
    components: new Map([[11, [{ drawable: { propMask: 1, numAlternatives: 1, textures: [{ texId: 0, distribution: 255 }], ownsCloth: false }, info: null }]]]),
  });
  const counted = planClothingPackBuild({ name: "gsd", sources: [alt], models: { [ymtPath]: model } });
  assert.equal(drawableEntry(parsePedVariationXml(counted.ymts[0].xml), 11, 0).drawable.numAlternatives, 1);
  assert.deepEqual(alternatesOf(counted), [`${prefix}^jbib_000_u_1.ydd`]);
  assert.ok(counted.checks.some((check) => /jbib_000_u_2\.ydd is not used/.test(check.text)));
});

test("the source pack file's data carries into the build", () => {
  const one = source("one", "C:/a", [{ index: 0, letters: ["a", "b"], slot: "task" }]);
  const ymtPath = "C:/a/one.ymt";
  one.packs[0].ymtPath = ymtPath;
  const model = buildPedVariation({
    name: "mp_m_one",
    dlcName: "mp_m_one",
    components: new Map([[9, [{
      drawable: { propMask: 1, numAlternatives: 2, textures: [{ texId: 1, distribution: 200 }, { texId: 1, distribution: 255 }], ownsCloth: false },
      info: { audioId: "VEST_HEAVY", audioId2: "", expressionMods: "0 0 0 0 0", flags: 4, inclusions: "0", exclusions: "0", vfxComps: "PV_COMP_HEAD", pedFlags: 0, compIdx: 9, drawblIdx: 0 },
    }]]]),
    props: new Map([[1, [defaultPropMeta(1, 0, 1)]]]),
  });
  const plan = planClothingPackBuild({ name: "gsd", sources: [one], models: { [ymtPath]: model } });
  const built = parsePedVariationXml(plan.ymts[0].xml);
  const entry = drawableEntry(built, 9, 0);
  assert.deepEqual(entry.drawable.textures, [{ texId: 1, distribution: 200 }, { texId: 1, distribution: 255 }]);
  assert.equal(entry.drawable.numAlternatives, 0, "no first-person files, so no alternates");
  assert.equal(entry.info.audioId, "VEST_HEAVY");
  assert.equal(entry.info.flags, 4);
  // The race comes from the pack file: id 1 is whi.
  assert.ok(plan.copies.some((copy) => copy.to.endsWith("task_diff_000_b_whi.ytd")));
});
