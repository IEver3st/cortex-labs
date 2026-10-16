import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_REMEMBERED_VARIATIONS,
  characterKey,
  characterLabel,
  characterName,
  clipRefusedNote,
  clipSkeletonMatch,
  keepsSlotOnScreen,
  describedCandidates,
  normalizeCharacterModel,
  normalizePedVariation,
  normalizePedVariations,
  pedGenderHint,
  resolveCharacterSlots,
  skeletonFromDescription,
  withCharacterVariation,
  withComponentChoice,
  withPropChoice,
} from "./ped-character.js";
import { castSnapshot, createCastMember, normalizeCastMember, restoreCast } from "./eup-cast.js";
import { selectDictionaryDrawable } from "./ped-assembly.js";

// Trimmed from the bridge's describeGamePed s_m_y_cop_01 result.
const COP = Object.freeze({
  ped: "s_m_y_cop_01",
  source: "game",
  files: [
    { kind: "ydd", dictionary: true, folder: "", file: "s_m_y_cop_01.ydd" },
    { kind: "ytd", dictionary: true, folder: "", file: "s_m_y_cop_01.ytd" },
    { kind: "ydd", dictionary: true, folder: "", file: "s_m_y_cop_01_p.ydd" },
    { kind: "ytd", dictionary: true, folder: "", file: "s_m_y_cop_01_p.ytd" },
  ],
  components: [
    {
      component: "head",
      id: 0,
      drawables: [
        {
          index: 0,
          name: "head_000_r",
          drawable: { name: "head_000_r", hash: 2540683012, file: 0 },
          textures: [
            { letter: "a", texId: 1, diffuse: { name: "head_diff_000_a_whi", file: 1 } },
            { letter: "b", texId: 1, diffuse: { name: "head_diff_000_b_whi", file: 1 } },
          ],
          normal: { name: "head_normal_000", file: 1 },
          specular: { name: "head_spec_000", file: 1 },
        },
        {
          index: 1,
          name: "head_001_r",
          drawable: { name: "head_001_r", hash: 1, file: 0 },
          textures: [{ letter: "a", texId: 2, diffuse: { name: "head_diff_001_a_bla", file: 1 } }],
          normal: null,
          specular: null,
        },
      ],
    },
    {
      component: "uppr",
      id: 3,
      drawables: [
        {
          index: 0,
          name: "uppr_000_r",
          drawable: { name: "uppr_000_r", hash: 1471150075, file: 0 },
          textures: [
            { letter: "a", texId: 1, diffuse: { name: "uppr_diff_000_a_whi", file: 1 } },
            { letter: "b", texId: 2, diffuse: { name: "uppr_diff_000_b_bla", file: 1 } },
            { letter: "c", texId: 4, diffuse: { name: "uppr_diff_000_c_lat", file: 1 } },
          ],
          normal: { name: "uppr_normal_000", file: 1 },
          specular: { name: "uppr_spec_000", file: 1 },
        },
      ],
    },
    // A drawable the .ymt lists but the files lack still takes its slot.
    { component: "accs", id: 8, drawables: [{ index: 0, name: "accs_000_u", drawable: null, textures: [], normal: null, specular: null }] },
  ],
  props: [
    {
      anchor: "p_head",
      anchorId: 0,
      props: [
        {
          index: 0,
          name: "p_head_000",
          drawable: { name: "p_head_000", hash: 3386910804, file: 2 },
          textures: [{ letter: "a", texId: 0, diffuse: { name: "p_head_diff_000_a", file: 3 } }],
          normal: { name: "p_head_normal_000", file: 3 },
          specular: null,
        },
      ],
    },
    {
      anchor: "p_eyes",
      anchorId: 1,
      props: [0, 1, 2, 3].map((index) => ({
        index,
        name: `p_eyes_00${index}`,
        drawable: { name: `p_eyes_00${index}`, hash: 100 + index, file: 2 },
        textures: [{ letter: "a", texId: 0, diffuse: { name: `p_eyes_diff_00${index}_a`, file: 3 } }],
        normal: null,
        specular: null,
      })),
    },
  ],
});

test("character models normalize to freemode unless they name a game ped or ped files", () => {
  assert.deepEqual(normalizeCharacterModel(undefined), { kind: "freemode", gender: "male" });
  assert.deepEqual(normalizeCharacterModel(null, "female"), { kind: "freemode", gender: "female" });
  assert.deepEqual(normalizeCharacterModel({ kind: "freemode", gender: "female" }, "male"), { kind: "freemode", gender: "male" });
  assert.deepEqual(normalizeCharacterModel({ kind: "game", ped: " S_M_Y_COP_01 " }), { kind: "game", ped: "s_m_y_cop_01" });
  assert.deepEqual(normalizeCharacterModel({ kind: "game", ped: "../x" }, "female"), { kind: "freemode", gender: "female" });
  assert.deepEqual(normalizeCharacterModel({ kind: "game", ped: "mp_f_freemode_01" }, "male"), { kind: "freemode", gender: "female" });
  assert.deepEqual(normalizeCharacterModel({ kind: "alien" }), { kind: "freemode", gender: "male" });

  const files = normalizeCharacterModel({
    kind: "file",
    ped: "My_Ped",
    paths: ["D:\\peds\\stream", "D:/peds/stream", 7, "", "D:\\peds\\my_ped.ymt"],
  });
  assert.deepEqual(files, { kind: "file", ped: "my_ped", paths: ["D:\\peds\\stream", "D:\\peds\\my_ped.ymt"] });
  assert.equal(normalizeCharacterModel({ kind: "file", ped: "a/b", paths: ["D:\\p"] }).ped, "");
  assert.deepEqual(normalizeCharacterModel({ kind: "file", paths: [] }), { kind: "freemode", gender: "male" });
});

test("character keys are stable and independent of path order", () => {
  assert.equal(characterKey({ kind: "freemode", gender: "female" }), "freemode:female");
  assert.equal(characterKey({ kind: "game", ped: "s_m_y_cop_01" }), "game:s_m_y_cop_01");
  const one = characterKey({ kind: "file", ped: "x", paths: ["D:\\A", "D:\\b"] });
  const two = characterKey({ kind: "file", ped: "x", paths: ["d:/b", "d:/a"] });
  assert.equal(one, two);
  assert.match(one, /^file:x:[0-9a-f]{8}$/);
  assert.notEqual(one, characterKey({ kind: "file", ped: "y", paths: ["D:\\A", "D:\\b"] }));
  assert.equal(characterLabel({ kind: "file", ped: "", paths: ["D:\\peds\\stream"] }), "stream");
  assert.equal(pedGenderHint("s_f_y_cop_01"), "female");
  assert.equal(pedGenderHint("a_c_chop"), null);
  assert.equal(pedGenderHint("player_zero"), null);
});

test("variations keep bounded choices and the most recent characters", () => {
  assert.deepEqual(
    normalizePedVariation({
      components: { uppr: { drawable: 2, texture: 40 }, lowr: { drawable: -1 }, nope: { drawable: 1 } },
      props: { p_eyes: { prop: 3, texture: 1 }, p_lfoot: { prop: 0 }, "../x": { prop: 1 }, p_head: { prop: "1" } },
    }),
    { components: { uppr: { drawable: 2, texture: 0 } }, props: { p_eyes: { prop: 3, texture: 1 }, p_lfoot: { prop: 0, texture: 0 } } },
  );

  const many = {};
  for (let i = 0; i < MAX_REMEMBERED_VARIATIONS + 4; i += 1) many[`game:ped_${i}`] = { components: { head: { drawable: 1 } } };
  many["freemode:male"] = {};
  const kept = normalizePedVariations(many);
  assert.equal(Object.keys(kept).length, MAX_REMEMBERED_VARIATIONS);
  assert.equal(kept["game:ped_0"], undefined);
  assert.deepEqual(kept[`game:ped_${MAX_REMEMBERED_VARIATIONS + 3}`].components.head, { drawable: 1, texture: 0 });

  // Re-choosing an old character makes it the most recent.
  const touched = withCharacterVariation(kept, "game:ped_4", { components: {} });
  assert.equal(Object.keys(touched).at(-1), "game:ped_4");

  let variation = withComponentChoice({}, "uppr", { drawable: 0, texture: 2 });
  variation = withPropChoice(variation, "p_eyes", { prop: 1, texture: 0 });
  assert.deepEqual(variation, { components: { uppr: { drawable: 0, texture: 2 } }, props: { p_eyes: { prop: 1, texture: 0 } } });
  assert.deepEqual(withPropChoice(variation, "p_eyes", null).props, {});
});

test("slots wear drawable 0 and texture a by default, chosen ones clamped, props only when chosen", () => {
  const defaults = resolveCharacterSlots(COP, null);
  assert.deepEqual(defaults.map((slot) => [slot.slot, slot.kind, slot.index, slot.texture]), [
    ["head", "component", 0, 0],
    ["uppr", "component", 0, 0],
    ["accs", "component", 0, 0],
  ]);
  assert.equal(defaults[0].drawable.hash, 2540683012);
  assert.equal(defaults[0].diffuse.name, "head_diff_000_a_whi");
  assert.equal(defaults[0].normal.name, "head_normal_000");
  assert.equal(defaults[2].drawable, null, "a missing drawable stays visible as a slot without a model");

  const chosen = resolveCharacterSlots(COP, {
    components: { head: { drawable: 9, texture: 9 }, uppr: { drawable: 0, texture: 2 } },
    props: { p_eyes: { prop: 3, texture: 5 }, p_head: { prop: 7 } },
  });
  const bySlot = Object.fromEntries(chosen.map((slot) => [slot.slot, slot]));
  assert.equal(bySlot.head.index, 1, "past the last drawable clamps to it");
  assert.equal(bySlot.head.diffuse.name, "head_diff_001_a_bla");
  assert.equal(bySlot.uppr.diffuse.name, "uppr_diff_000_c_lat");
  assert.equal(bySlot.p_eyes.kind, "prop");
  assert.equal(bySlot.p_eyes.drawable.name, "p_eyes_003");
  assert.equal(bySlot.p_eyes.texture, 0);
  assert.equal(bySlot.p_head, undefined, "a prop the ped doesn't have is not worn");
  assert.deepEqual(resolveCharacterSlots(null, null), []);
});

test("bridge skeletons convert to the renderer's bone format with world transforms", () => {
  const skeleton = skeletonFromDescription([
    { name: "SKEL_ROOT", tag: 0, parent: -1, translation: [0, 0, 1], rotation: [0, 0, 1, 0] },
    { name: "SKEL_Pelvis", tag: 11816, parent: 0, translation: [1, 0, 0], rotation: [0, 0, 0, 1] },
    { name: "SKEL_Head", tag: 31086, parent: 1, translation: [0, 2, 0], rotation: [0, 0, 0.7071068, 0.7071068] },
  ]);
  assert.equal(skeleton.bones.length, 3);
  const [root, pelvis, head] = skeleton.bones;
  assert.equal(root.parentIndex, 65535, "roots use the u16 sentinel the bone builder expects");
  assert.equal(pelvis.parentIndex, 0);
  assert.equal(head.tag, 31086);
  // Half a turn about Z sends the pelvis offset to -X.
  assert.ok(Math.abs(pelvis.worldTx + 1) < 1e-6 && Math.abs(pelvis.worldTz - 1) < 1e-6);
  assert.ok(Math.abs(head.worldTy + 2) < 1e-6);
  assert.ok(Math.abs(Math.abs(head.worldQw) - 0.7071068) < 1e-6);

  const looped = skeletonFromDescription([
    { tag: 1, parent: 1, translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
    { tag: 2, parent: 0, translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
  ]);
  assert.ok(looped.bones.some((bone) => bone.parentIndex === 65535), "a parent loop is broken at a root");

  assert.equal(skeletonFromDescription([]), null);
  assert.equal(skeletonFromDescription([{ tag: 0, parent: -1, translation: [0, Number.NaN, 0], rotation: [0, 0, 0, 1] }]), null);
  assert.equal(skeletonFromDescription([{ tag: 0, parent: -1, translation: [0, 0], rotation: [0, 0, 0, 1] }]), null);
});

test("a clip fits a skeleton only when most of its bones exist there", () => {
  const skeleton = { bones: [0, 11816, 58271, 31086].map((tag) => ({ tag })) };
  const human = { rotations: [0, 11816, 58271, 31086].map((bone) => ({ bone })) };
  assert.deepEqual(clipSkeletonMatch(skeleton, human), { matched: 4, total: 4, fits: true });
  const animal = { rotations: [0, 11816, 7, 8].map((bone) => ({ bone })) };
  assert.equal(clipSkeletonMatch(skeleton, animal).fits, false);
  assert.equal(clipSkeletonMatch(skeleton, { rotations: [] }).fits, true);
});

test("a ped file selection with several peds offers them as candidates", () => {
  assert.deepEqual(describedCandidates({ ped: "", candidates: ["a_c_chop", "s_m_y_cop_01"] }), ["a_c_chop", "s_m_y_cop_01"]);
  assert.deepEqual(describedCandidates(COP), []);
});

test("cast members carry their model and variations through a snapshot", () => {
  const legacy = normalizeCastMember({ gender: "female", pose: "idle" });
  assert.deepEqual(legacy.model, { kind: "freemode", gender: "female" });
  assert.deepEqual(legacy.variations, {});

  const cop = createCastMember("male", null, { kind: "game", ped: "s_m_y_cop_01" });
  assert.deepEqual(cop.model, { kind: "game", ped: "s_m_y_cop_01" });
  const dressed = { ...cop, variations: { "game:s_m_y_cop_01": { components: { uppr: { drawable: 0, texture: 2 } }, props: { p_eyes: { prop: 1 } } } } };
  const own = createCastMember("female", null, { kind: "file", ped: "my_ped", paths: ["D:\\peds\\stream"] });

  const restored = restoreCast(JSON.parse(JSON.stringify(castSnapshot({ pieces: [], a: { ...dressed, worn: [] }, b: { ...own, worn: [] }, focus: "b" }))));
  assert.deepEqual(restored.a.model, { kind: "game", ped: "s_m_y_cop_01" });
  assert.deepEqual(restored.a.variations["game:s_m_y_cop_01"].props.p_eyes, { prop: 1, texture: 0 });
  assert.deepEqual(restored.b.model, { kind: "file", ped: "my_ped", paths: ["D:\\peds\\stream"] });
  assert.equal(restored.b.gender, "female");

  // A game pick of the freemode ped is the freemode character with that gender.
  assert.equal(normalizeCastMember({ gender: "male", model: { kind: "game", ped: "mp_f_freemode_01" } }).gender, "female");
});

test("a whole-ped dictionary yields the one drawable a component wears", () => {
  const dictionary = {
    name: "s_m_y_cop_01",
    skeleton: { bones: [] },
    models: [
      { drawableHash: 2540683012, meshes: ["head"] },
      { drawableHash: 1471150075, meshes: ["uppr"] },
      { drawableHash: 1471150075, meshes: ["uppr lod"] },
    ],
  };
  const uppr = selectDictionaryDrawable(dictionary, 1471150075);
  assert.deepEqual(uppr.models.map((model) => model.meshes[0]), ["uppr", "uppr lod"]);
  assert.equal(uppr.skeleton, dictionary.skeleton);
  assert.equal(dictionary.models.length, 3, "the cached dictionary is left whole");
  assert.throws(() => selectDictionaryDrawable(dictionary, 5), /no drawable 00000005/);
});

test("a custom character is named after the ped its description resolved", () => {
  const files = { kind: "file", ped: "", paths: ["D:/peds/stream"] };
  assert.equal(characterName(files, null), "stream", "the folder until the bridge has read it");
  assert.equal(characterName(files, { ped: "my_ped" }), "my_ped");
  assert.equal(characterName({ kind: "game", ped: "s_m_y_cop_01" }, { ped: "s_m_y_cop_01" }), "s_m_y_cop_01");
  assert.equal(characterName({ kind: "file", ped: "", paths: ["D:/peds/my_ped.ymt"] }, { ped: "", candidates: ["a", "b"] }), "my_ped.ymt");
  assert.equal(characterName({ kind: "freemode", gender: "female" }, { ped: "ignored" }), "Freemode female");
});

test("a refused clip is described as refused, not as a failed load", () => {
  const note = clipRefusedNote({ matched: 35, total: 61, fits: false }, "a_c_chop");
  assert.match(note, /made for a different skeleton/);
  assert.match(note, /35 of its 61 animated bones exist on a_c_chop/);
  assert.doesNotMatch(note, /didn't load/);
});

test("a slot's drawable stays on screen only while the same rig reloads it", () => {
  const eup = (path) => ({ source: "eup", drawablePath: path });
  const base = (path = null) => ({ source: "base", drawablePath: path });
  const character = (modelKey) => ({ source: "character", modelKey });
  // Freemode reloads keep the old drawable until the new one lands, as before.
  assert.equal(keepsSlotOnScreen(eup("a.ydd"), eup("a.ydd")), true);
  assert.equal(keepsSlotOnScreen(base("pack.ydd"), base("pack.ydd")), true);
  assert.equal(keepsSlotOnScreen(base(), base()), false, "a game base slot changes drawable");
  assert.equal(keepsSlotOnScreen(character("game:cop"), character("game:cop")), true, "a re-read of the same ped");
  // Across skeletons the old drawable would be posed with the wrong bones.
  assert.equal(keepsSlotOnScreen(character("game:cop"), eup("a.ydd")), false);
  assert.equal(keepsSlotOnScreen(eup("a.ydd"), character("game:cop")), false);
  assert.equal(keepsSlotOnScreen(character("game:cop"), character("game:a_c_chop")), false);
  assert.equal(keepsSlotOnScreen(null, eup("a.ydd")), false);
  assert.equal(keepsSlotOnScreen(eup("a.ydd"), undefined), false);
});
