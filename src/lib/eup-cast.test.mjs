import test from "node:test";
import assert from "node:assert/strict";
import {
  CAST_SPACING,
  applyCastPieces,
  castOffsets,
  castSnapshot,
  createCastMember,
  normalizeCastMember,
  projectPieces,
  restoreCast,
} from "./eup-cast.js";

const piece = (id, overrides = {}) => ({
  id,
  gender: "male",
  component: "jbib",
  drawablePath: `C:\\eup\\${id}.ydd`,
  texturePath: "",
  worn: true,
  ...overrides,
});

test("restoreCast reads a workspace saved before the cast as character A alone", () => {
  const cast = restoreCast({
    gender: "female",
    race: "bla",
    pose: "walk",
    selections: { female: { jbib: { index: 2, variant: "b" } } },
    pieces: [piece("piece-1", { gender: "female" }), piece("piece-2", { worn: false })],
  });
  assert.equal(cast.b, null);
  assert.equal(cast.focus, "a");
  assert.equal(cast.a.gender, "female");
  assert.equal(cast.a.race, "bla");
  assert.equal(cast.a.pose, "walk");
  assert.deepEqual(cast.a.selections.female.jbib, { index: 2, variant: "b" });
  assert.deepEqual(cast.a.worn, ["piece-1"]);
  assert.ok(cast.pieces.every((item) => !("worn" in item)), "the library holds no worn flags");
});

test("castSnapshot round-trips both characters and keeps A in the top-level fields", () => {
  const library = [piece("piece-1", { worn: undefined }), piece("piece-2", { component: "lowr", worn: undefined })];
  const cast = {
    pieces: library,
    a: { ...createCastMember("male"), worn: ["piece-1"] },
    b: { ...createCastMember("female"), skinTone: normalizeCastMember({}).skinTone, worn: ["piece-2"] },
    focus: "b",
  };
  const saved = castSnapshot(cast);
  assert.equal(saved.gender, "male");
  assert.deepEqual(saved.pieces.map((item) => item.worn), [true, false]);
  assert.equal(saved.partner.gender, "female");
  assert.equal(saved.focus, "b");
  const restored = restoreCast(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(restored.a.worn, ["piece-1"]);
  assert.deepEqual(restored.b.worn, ["piece-2"]);
  assert.equal(restored.focus, "b");
});

test("restoreCast drops worn ids for missing pieces and focus on an absent B", () => {
  const cast = restoreCast({
    pieces: [piece("piece-1")],
    partner: { gender: "male", worn: ["piece-1", "piece-gone", 4] },
    focus: "b",
  });
  assert.deepEqual(cast.b.worn, ["piece-1"]);
  assert.equal(restoreCast({ focus: "b" }).focus, "a");
  assert.equal(restoreCast({ partner: "nope" }).b, null);
});

test("normalizeCastMember keeps one worn piece per slot", () => {
  const library = [piece("piece-1"), piece("piece-2"), piece("piece-3", { component: "lowr" })];
  assert.deepEqual(normalizeCastMember({ worn: ["piece-1", "piece-2", "piece-3"] }, library).worn, ["piece-1", "piece-3"]);
});

test("applyCastPieces changes one character's worn pieces and leaves the other's", () => {
  const library = [piece("piece-1"), piece("piece-2", { component: "lowr" })];
  const cast = {
    pieces: library,
    a: { ...createCastMember("male"), worn: ["piece-1"] },
    b: { ...createCastMember("male"), worn: ["piece-1", "piece-2"] },
    focus: "a",
  };
  const next = applyCastPieces(cast, "a", projectPieces(library, []).filter((item) => item.id !== "piece-2"));
  assert.deepEqual(next.a.worn, []);
  assert.deepEqual(next.b.worn, ["piece-1"], "a removed piece leaves B too");
  assert.deepEqual(next.pieces.map((item) => item.id), ["piece-1"]);
});

test("createCastMember starts in the default outfit with the other character's pose", () => {
  const member = createCastMember("female", { pose: "walk", race: "bla" });
  assert.equal(member.gender, "female");
  assert.equal(member.pose, "walk");
  assert.deepEqual(member.selections, { male: {}, female: {} });
  assert.deepEqual(member.worn, []);
});

test("castOffsets centres one character and spaces two", () => {
  assert.equal(castOffsets({ a: {}, b: null }).a, 0);
  const pair = castOffsets({ a: {}, b: {} });
  assert.equal(pair.b - pair.a, CAST_SPACING);
  assert.equal(pair.a + pair.b, 0);
});

test("custom animations and held props round-trip per character", () => {
  const animation = { source: "game", dict: "cellphone@", clip: "cellphone_text_read_base" };
  const heldProps = [{ id: "p1", source: "game", name: "prop_npc_phone_02", bone: 28422, position: [0, 0, 0], rotation: [0, 0, 90] }];
  const saved = castSnapshot({
    pieces: [],
    a: normalizeCastMember({ pose: "custom", animation, heldProps }),
    b: normalizeCastMember({ gender: "female", heldProps: [{ id: "x", source: "game", name: "../bad" }] }),
    focus: "a",
  });
  assert.deepEqual(saved.animation, animation, "character A keeps the top-level field");
  const restored = restoreCast(JSON.parse(JSON.stringify(saved)));
  assert.equal(restored.a.pose, "custom");
  assert.deepEqual(restored.a.animation, animation);
  assert.equal(restored.a.heldProps[0].name, "prop_npc_phone_02");
  assert.deepEqual(restored.b.heldProps, [], "unusable props are dropped");
  assert.equal(restored.b.animation, null);
  assert.deepEqual(createCastMember("female", restored.a).animation, animation, "a new character copies the clip, not the props");
  assert.deepEqual(createCastMember("female", restored.a).heldProps, []);
});
