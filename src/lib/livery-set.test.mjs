import test from "node:test";
import assert from "node:assert/strict";
import {
  canWriteLiveries,
  defaultLiveryPattern,
  dxt5Bytes,
  fittedLiverySize,
  liverySlots,
  naturalCompare,
  parseLiveryPattern,
  planLiveryWrite,
  stageLiveryFiles,
} from "./livery-set.js";

const MODEL = "C:\\res\\stream\\GSDSS24Explorer_hi.yft";
const sign = (name, width, levels = 1) => ({ name, path: `C:\\cache\\${name}.dds`, width, height: width, levels, format: "BC7" });
const HI = {
  path: "C:\\res\\stream\\GSDSS24Explorer+hi.ytd",
  name: "GSDSS24Explorer+hi.ytd",
  legacy: true,
  textures: [sign("fpiu_sign_1", 4096), sign("FPIU_SIGN_2", 4096), sign("fpiu_badge", 512)],
};
const BASE = {
  path: "C:\\res\\stream\\GSDSS24Explorer.ytd",
  name: "GSDSS24Explorer.ytd",
  legacy: true,
  textures: [sign("fpiu_sign_1", 1024, 11), sign("fpiu_sign_2", 1024, 11)],
};

let nextId = 0;
const makeId = () => `i${(nextId += 1)}`;

test("a names pattern puts the livery number where # is", () => {
  const parsed = parseLiveryPattern(" fpiu_sign_# ");
  assert.equal(parsed.nameFor(12), "fpiu_sign_12");
  assert.equal(parsed.numberOf("FPIU_Sign_3"), 3);
  assert.equal(parsed.numberOf("fpiu_sign_03"), null);
  assert.equal(parsed.numberOf("fpiu_sign_"), null);
  assert.equal(parsed.numberOf("fpiu_badge"), null);
  assert.equal(parseLiveryPattern("x_#_sign").numberOf("x_4_sign"), 4);
  assert.match(parseLiveryPattern("fpiu_sign_").error, /#/);
  assert.match(parseLiveryPattern("a#b#").error, /once/);
  assert.match(parseLiveryPattern("my livery #").error, /letters/);
  assert.match(parseLiveryPattern("a\\#").error, /letters/);
});

test("the default pattern follows the paint, then the dictionaries, then the model", () => {
  assert.equal(defaultLiveryPattern({ signPrefix: "fpiu", dictionaries: [] }), "fpiu_sign_#");
  assert.equal(defaultLiveryPattern({ dictionaries: [HI, BASE] }), "fpiu_sign_#");
  assert.equal(defaultLiveryPattern({ dictionaries: [], modelPath: MODEL }), "gsdss24explorer_sign_#");
  assert.equal(defaultLiveryPattern({ modelPath: "C:\\x\\car+hi.yft" }), "car_sign_#");
});

test("file names sort the way people number them", () => {
  const files = ["C:\\l\\livery10.png", "C:\\l\\Livery2.png", "C:\\l\\livery1.png"];
  assert.deepEqual(files.sort(naturalCompare), ["C:\\l\\livery1.png", "C:\\l\\Livery2.png", "C:\\l\\livery10.png"]);
});

test("new images follow the vehicle's liveries in file-name order", () => {
  const { items, skipped } = stageLiveryFiles([], ["C:\\l\\b10.png", "C:\\l\\b2.psd", "C:\\l\\notes.txt"], { taken: [1, 2], makeId });
  assert.deepEqual(items.map((item) => [item.path, item.number]), [["C:\\l\\b2.psd", 3], ["C:\\l\\b10.png", 4]]);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /not an image/);

  const again = stageLiveryFiles(items, ["C:\\l\\B2.PSD", "C:\\l\\c.dds"], { taken: [1, 2], makeId });
  assert.deepEqual(again.items.map((item) => item.number), [3, 4, 5]);
  assert.match(again.skipped[0].reason, /already staged/);
});

test("an image dropped on a livery takes its number and the rest follow", () => {
  const start = stageLiveryFiles([], ["C:\\l\\a.png", "C:\\l\\b.png"], { taken: [1, 2], makeId }).items;
  const { items } = stageLiveryFiles(start, ["C:\\l\\new.png", "C:\\l\\more.png"], { taken: [1, 2], at: 3, makeId });
  // Natural order puts more.png first, so it takes 3; a.png is no longer staged.
  assert.deepEqual(items.map((item) => [item.path, item.number]), [
    ["C:\\l\\more.png", 3],
    ["C:\\l\\b.png", 4],
    ["C:\\l\\new.png", 5],
  ]);
  const replaced = stageLiveryFiles([], ["C:\\l\\over.png"], { taken: [1, 2], at: 2, makeId }).items;
  assert.deepEqual(replaced.map((item) => [item.path, item.number]), [["C:\\l\\over.png", 2]]);
});

test("numbers stop at 99", () => {
  const { items, skipped } = stageLiveryFiles([], ["C:\\l\\a.png", "C:\\l\\b.png"], { taken: [98], makeId });
  assert.deepEqual(items.map((item) => item.number), [99]);
  assert.match(skipped[0].reason, /up to 99/);
});

test("slots list existing liveries with their copies and the staged images", () => {
  const items = [{ id: "a", path: "C:\\l\\a.png", number: 2 }, { id: "b", path: "C:\\l\\b.png", number: 3 }];
  const slots = liverySlots({ dictionaries: [HI, BASE], pattern: "fpiu_sign_#", items });
  assert.deepEqual(slots.map((slot) => [slot.number, slot.existing.length, slot.item?.id || null]), [[1, 2, null], [2, 2, "a"], [3, 0, "b"]]);
  assert.equal(slots[2].name, "fpiu_sign_3");
});

test("a write goes into every dictionary holding liveries, at that dictionary's size", () => {
  const items = [{ id: "a", path: "C:\\l\\a.png", number: 2 }, { id: "b", path: "C:\\l\\b.png", number: 3 }];
  const sources = { a: { width: 4096, height: 4096 }, b: { width: 2048, height: 2048 } };
  const plan = planLiveryWrite({ modelPath: MODEL, dictionaries: [HI, BASE], pattern: "fpiu_sign_#", items, sources, signPrefix: "fpiu" });
  assert.equal(plan.blocked, null);
  assert.ok(canWriteLiveries(plan));
  const [hi, base] = plan.files;
  assert.deepEqual(hi.textures.map((t) => [t.name, t.mode, t.like, t.width, t.levels]), [
    ["FPIU_SIGN_2", "replace", null, 4096, 1],
    ["fpiu_sign_3", "insert", "fpiu_sign_1", 4096, 1],
  ]);
  assert.deepEqual(base.textures.map((t) => [t.name, t.mode, t.width, t.levels]), [
    ["fpiu_sign_2", "replace", 1024, 11],
    ["fpiu_sign_3", "insert", 1024, 11],
  ]);
  assert.equal(hi.added, 1);
  assert.equal(hi.replaced, 1);
  assert.equal(hi.bytes, 2 * 4096 * 4096);
  const texts = plan.checks.map((check) => `${check.tone}: ${check.text}`);
  assert.ok(texts.includes("caution: b.png is 2048 × 2048, so it is scaled up for GSDSS24Explorer+hi.ytd."), texts.join("\n"));
  assert.ok(texts.some((text) => /^confirm: Liveries run 1 to 3 with no gaps/.test(text)), texts.join("\n"));

  const batch = [...items, { id: "c", path: "C:\\l\\c.png", number: 4 }];
  const grouped = planLiveryWrite({ modelPath: MODEL, dictionaries: [HI, BASE], pattern: "fpiu_sign_#", items: batch, sources: { ...sources, c: { width: 2048, height: 2048 } }, signPrefix: "fpiu" });
  const groupedTexts = grouped.checks.map((check) => check.text);
  assert.ok(groupedTexts.includes("b.png and c.png are 2048 × 2048, so they are scaled up for GSDSS24Explorer+hi.ytd."), groupedTexts.join("\n"));
});

test("a vehicle without liveries gets them in its base dictionary at the image's size", () => {
  const hi = { ...HI, textures: [sign("fpiu_badge", 512)] };
  const base = { ...BASE, textures: [] };
  const items = [{ id: "a", path: "C:\\l\\a.png", number: 1 }];
  const plan = planLiveryWrite({ modelPath: MODEL, dictionaries: [hi, base], pattern: "fpiu_sign_#", items, sources: { a: { width: 3000, height: 1900 } }, signPrefix: "fpiu" });
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0].name, "GSDSS24Explorer.ytd");
  assert.deepEqual(plan.files[0].textures.map((t) => [t.mode, t.like, t.width, t.height]), [["insert", null, 2048, 2048]]);
  assert.ok(plan.checks.some((check) => check.tone === "caution" && /stretched/.test(check.text)));
});

test("gaps, other names and unread images are reported", () => {
  const items = [{ id: "a", path: "C:\\l\\a.png", number: 5 }];
  const gap = planLiveryWrite({ modelPath: MODEL, dictionaries: [HI, BASE], pattern: "fpiu_sign_#", items, sources: { a: { width: 4096, height: 4096 } }, signPrefix: "other" });
  const texts = gap.checks.map((check) => check.text).join("\n");
  assert.match(texts, /Livery 3 and 4 are missing/);
  assert.match(texts, /The paint uses other_sign_1/);
  assert.ok(canWriteLiveries(gap));

  const unread = planLiveryWrite({ modelPath: MODEL, dictionaries: [HI, BASE], pattern: "fpiu_sign_#", items, sources: { a: { error: "bad PNG" } } });
  assert.match(unread.blocked, /could not be read/);
  assert.equal(unread.checks[0].tone, "destructive");
  assert.ok(!canWriteLiveries(unread));

  const pending = planLiveryWrite({ modelPath: MODEL, dictionaries: [HI, BASE], pattern: "fpiu_sign_#", items, sources: {} });
  assert.ok(pending.pending);
  assert.ok(!canWriteLiveries(pending));
});

test("writes stop before an unwritable or missing dictionary", () => {
  const items = [{ id: "a", path: "C:\\l\\a.png", number: 3 }];
  const sources = { a: { width: 1024, height: 1024 } };
  const enhanced = planLiveryWrite({ modelPath: MODEL, dictionaries: [{ ...HI, legacy: false }, BASE], pattern: "fpiu_sign_#", items, sources });
  assert.match(enhanced.blocked, /GSDSS24Explorer\+hi\.ytd is not a legacy GTA V texture dictionary/);
  assert.match(planLiveryWrite({ modelPath: MODEL, dictionaries: [], pattern: "fpiu_sign_#", items, sources }).blocked, /no texture dictionary/);
  assert.match(planLiveryWrite({ modelPath: MODEL, dictionaries: [HI], pattern: "fpiu", items, sources }).blocked, /#/);
  assert.match(planLiveryWrite({ modelPath: MODEL, dictionaries: [HI], pattern: "fpiu_sign_#", items: [], sources }).blocked, /Add liveries/);
});

test("sizes for a dictionary without liveries round to powers of two up to 4096", () => {
  assert.deepEqual(fittedLiverySize({ width: 3000, height: 700 }), { width: 2048, height: 512 });
  assert.deepEqual(fittedLiverySize({ width: 9000, height: 20 }), { width: 4096, height: 64 });
  assert.equal(dxt5Bytes(8, 8), 64 + 16);
  assert.equal(dxt5Bytes(8, 8, 1), 64);
});
