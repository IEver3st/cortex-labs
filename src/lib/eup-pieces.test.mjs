import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ADDON_PIECES,
  buildOutfitLua,
  detectPieceComponent,
  detectPieceGender,
  isPieceTexturePath,
  normalizeAddonPieces,
  pieceDrawableIndex,
  pieceTextureCandidates,
  setAddonPieceComponent,
  wearAddonPiece,
  wornAddonPieces,
} from "./eup.js";

const piece = (id, overrides = {}) => ({
  id,
  gender: "male",
  component: "jbib",
  drawablePath: `C:\\eup\\${id}.ydd`,
  texturePath: "",
  worn: true,
  ...overrides,
});

test("detectPieceComponent reads stream names, slot codes and common words", () => {
  assert.deepEqual(detectPieceComponent("mp_m_freemode_01_pd^task_002_u.ydd"), { component: "task", detected: true });
  assert.deepEqual(detectPieceComponent("p_head_004.ydd"), { component: "p_head", detected: true });
  assert.deepEqual(detectPieceComponent("Sheriff Vest V2.ydd"), { component: "task", detected: true });
  assert.deepEqual(detectPieceComponent("swat_helmet.ydd"), { component: "p_head", detected: true });
  assert.deepEqual(detectPieceComponent("my_custom_lowr.ydd"), { component: "lowr", detected: true });
  assert.deepEqual(detectPieceComponent("badge-p-eyes.ydd"), { component: "p_eyes", detected: true });
  assert.deepEqual(detectPieceComponent("thing.ydd"), { component: "jbib", detected: false });
});

test("detectPieceGender uses the stream name, then the folder", () => {
  assert.equal(detectPieceGender("C:\\x\\mp_f_freemode_01_pack^jbib_000_u.ydd"), "female");
  assert.equal(detectPieceGender("C:\\stream\\mp_m_freemode_01\\vest.ydd"), "male");
  assert.equal(detectPieceGender("C:\\stream\\vest.ydd"), null);
});

test("pieceDrawableIndex only trusts stream names", () => {
  assert.equal(pieceDrawableIndex("C:\\x\\jbib_012_u.ydd"), 12);
  assert.equal(pieceDrawableIndex("C:\\x\\vest.ydd"), null);
});

test("pieceTextureCandidates lists the GTA name first, then same-name files", () => {
  assert.deepEqual(pieceTextureCandidates("C:\\eup\\mp_m_freemode_01_pd^jbib_003_u.ydd"), [
    "C:\\eup\\mp_m_freemode_01_pd^jbib_diff_003_a_uni.ytd",
    "C:\\eup\\mp_m_freemode_01_pd^jbib_diff_003_a_whi.ytd",
    "C:\\eup\\mp_m_freemode_01_pd^jbib_003_u.ytd",
    "C:\\eup\\mp_m_freemode_01_pd^jbib_003_u.psd",
    "C:\\eup\\mp_m_freemode_01_pd^jbib_003_u.png",
    "C:\\eup\\mp_m_freemode_01_pd^jbib_003_u.dds",
  ]);
  assert.deepEqual(pieceTextureCandidates("/home/a/p_head_001.ydd").slice(0, 2), [
    "/home/a/p_head_diff_001_a.ytd",
    "/home/a/p_head_001.ytd",
  ]);
  assert.deepEqual(pieceTextureCandidates("C:\\eup\\Vest.ydd")[0], "C:\\eup\\Vest.ytd");
  assert.deepEqual(pieceTextureCandidates("C:\\eup\\vest.ytd"), []);
});

test("isPieceTexturePath accepts dictionaries and images", () => {
  assert.equal(isPieceTexturePath("a.YTD"), true);
  assert.equal(isPieceTexturePath("a.psd"), true);
  assert.equal(isPieceTexturePath("a.ydd"), false);
  assert.equal(isPieceTexturePath(""), false);
});

test("normalizeAddonPieces drops malformed pieces and keeps one worn per slot", () => {
  const result = normalizeAddonPieces([
    piece("piece-1"),
    piece("piece-2"),
    piece("piece-2"),
    piece("piece-3", { gender: "female" }),
    piece("piece-4", { component: "nope" }),
    piece("piece-5", { drawablePath: "C:\\eup\\x.ytd" }),
    piece("piece-6", { texturePath: "C:\\eup\\x.exe", component: "task" }),
    { id: "bad id", drawablePath: "C:\\a.ydd", component: "jbib" },
    null,
  ]);
  assert.deepEqual(result.map((item) => item.id), ["piece-1", "piece-2", "piece-3", "piece-6"]);
  assert.equal(result[0].worn, true);
  assert.equal(result[1].worn, false, "second worn top for the same ped comes off");
  assert.equal(result[2].worn, true, "a female piece in the same slot is independent");
  assert.equal(result[3].texturePath, "");
  const many = Array.from({ length: MAX_ADDON_PIECES + 5 }, (_, i) => piece(`piece-${i}`, { worn: false }));
  assert.equal(normalizeAddonPieces(many).length, MAX_ADDON_PIECES);
  assert.deepEqual(normalizeAddonPieces("nope"), []);
});

test("wearAddonPiece takes the slot from the other worn piece", () => {
  const pieces = [piece("piece-1"), piece("piece-2", { worn: false }), piece("piece-3", { component: "task" })];
  const next = wearAddonPiece(pieces, "piece-2", true);
  assert.deepEqual(next.map((item) => item.worn), [false, true, true]);
  assert.deepEqual(wearAddonPiece(next, "piece-2", false).map((item) => item.worn), [false, false, true]);
  assert.equal(wearAddonPiece(pieces, "missing", true), pieces);
});

test("setAddonPieceComponent moves a worn piece and frees the old slot", () => {
  const pieces = [piece("piece-1"), piece("piece-2", { component: "task" })];
  const moved = setAddonPieceComponent(pieces, "piece-1", "task");
  assert.deepEqual(moved.map((item) => [item.component, item.worn]), [["task", true], ["task", false]]);
  assert.equal(setAddonPieceComponent(pieces, "piece-1", "bogus"), pieces);
});

test("wornAddonPieces keys worn pieces by slot for one ped", () => {
  const pieces = [piece("piece-1"), piece("piece-2", { component: "task", worn: false }), piece("piece-3", { gender: "female" })];
  assert.deepEqual(Object.keys(wornAddonPieces(pieces, "male")), ["jbib"]);
  assert.equal(wornAddonPieces(pieces, "female").jbib.id, "piece-3");
});

test("buildOutfitLua writes pieces with an id and comments out pieces without one", () => {
  const lua = buildOutfitLua({
    name: "Patrol",
    gender: "male",
    slots: [
      { component: "task", index: 2, variant: "b", source: "piece", file: "task_002_u.ydd" },
      { component: "jbib", index: null, variant: "a", source: "piece", file: "Sheriff Shirt.ydd" },
      { component: "head", index: 0, variant: "a", source: "piece", file: "head_000_r.ydd" },
      { component: "p_head", index: null, variant: "a", source: "piece", file: "helmet.ydd" },
    ],
  });
  assert.match(lua, /^SetPedComponentVariation\(ped, 9, 2, 1, 0\) -- task addon piece task_002_u\.ydd$/m);
  assert.match(lua, /^-- SetPedComponentVariation\(ped, 11, DRAWABLE_ID, 0, 0\) -- jbib addon piece Sheriff Shirt\.ydd: name it/m);
  assert.match(lua, /^SetPedComponentVariation\(ped, 0, 0, 0, 0\) -- head addon piece/m, "head pieces are written, unlike the base head");
  assert.match(lua, /^-- SetPedPropIndex\(ped, 0, DRAWABLE_ID, 0, true\) -- p_head addon piece helmet\.ydd/m);
  assert.match(lua, /Pack ids are stream-file indices/);
});

test("detectPieceComponent knows hairstyle and everyday clothing words", () => {
  assert.deepEqual(detectPieceComponent("long_ponytail_v2.ydd"), { component: "hair", detected: true });
  assert.deepEqual(detectPieceComponent("Box Braids.ydd"), { component: "hair", detected: true });
  assert.deepEqual(detectPieceComponent("oversized-tshirt.ydd"), { component: "jbib", detected: true });
  assert.deepEqual(detectPieceComponent("grey_joggers.ydd"), { component: "lowr", detected: true });
  assert.deepEqual(detectPieceComponent("knit beanie.ydd"), { component: "p_head", detected: true });
});
