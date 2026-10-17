import test from "node:test";
import assert from "node:assert/strict";
import {
  canWriteLiveries,
  defaultLiveryPattern,
  dxt5Bytes,
  fittedLiverySize,
  liverySlots,
  liveryWriteLabel,
  naturalCompare,
  normalizeLiverySet,
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

test("a livery marked for removal leaves every dictionary that holds it", () => {
  const four = (width, levels) => ["fpiu_sign_1", "fpiu_sign_2", "fpiu_sign_3", "fpiu_sign_4"].map((name) => sign(name, width, levels));
  const hi = { ...HI, textures: [...four(4096), sign("fpiu_badge", 512)] };
  const base = { ...BASE, textures: four(1024, 11) };
  const slots = liverySlots({ dictionaries: [hi, base], pattern: "fpiu_sign_#", removed: [4, 9] });
  assert.deepEqual(slots.map((slot) => [slot.number, slot.removed]), [[1, false], [2, false], [3, false], [4, true]]);

  const plan = planLiveryWrite({ modelPath: MODEL, dictionaries: [hi, base], pattern: "fpiu_sign_#", removed: [4, 9], signPrefix: "fpiu" });
  assert.equal(plan.blocked, null);
  assert.ok(canWriteLiveries(plan));
  assert.deepEqual(plan.removals, [4]);
  assert.deepEqual(plan.files.map((file) => [file.name, file.removed, file.textures.map((t) => [t.name, t.mode, t.itemId])]), [
    ["GSDSS24Explorer+hi.ytd", 1, [["fpiu_sign_4", "delete", null]]],
    ["GSDSS24Explorer.ytd", 1, [["fpiu_sign_4", "delete", null]]],
  ]);
  assert.ok(plan.checks.some((check) => check.tone === "confirm" && check.text === "Liveries run 1 to 3 with no gaps; this removes 4."), plan.checks.map((check) => check.text).join("\n"));

  // Replacing 1 to 3 and removing 4 leaves three liveries, removals listed last.
  const items = [1, 2, 3].map((number) => ({ id: `n${number}`, path: `C:\\l\\${number}.png`, number }));
  const sources = Object.fromEntries(items.map((item) => [item.id, { width: 4096, height: 4096 }]));
  const swap = planLiveryWrite({ modelPath: MODEL, dictionaries: [hi, base], pattern: "fpiu_sign_#", items, removed: [4], sources, signPrefix: "fpiu" });
  assert.ok(canWriteLiveries(swap));
  assert.deepEqual(swap.files[1].textures.map((t) => t.mode), ["replace", "replace", "replace", "delete"]);
  assert.ok(swap.checks.some((check) => check.text === "Liveries run 1 to 3 with no gaps; this writes 1 to 3 and removes 4."));

  // A staged image on a marked livery replaces it; removing a middle one leaves a gap.
  const staged = planLiveryWrite({ modelPath: MODEL, dictionaries: [hi, base], pattern: "fpiu_sign_#", items: [{ id: "x", path: "C:\\l\\x.png", number: 4 }], removed: [2, 4], sources: { x: { width: 4096, height: 4096 } } });
  assert.deepEqual(staged.removals, [2]);
  assert.deepEqual(staged.files[0].textures.map((t) => [t.name, t.mode]), [["fpiu_sign_4", "replace"], ["fpiu_sign_2", "delete"]]);
  assert.match(staged.checks.map((check) => check.text).join("\n"), /Livery 2 is missing/);
});

test("a new livery is modelled on one that stays", () => {
  const items = [{ id: "a", path: "C:\\l\\a.png", number: 3 }];
  const plan = planLiveryWrite({ modelPath: MODEL, dictionaries: [HI, BASE], pattern: "fpiu_sign_#", items, removed: [1], sources: { a: { width: 4096, height: 4096 } } });
  assert.deepEqual(plan.files[0].textures.map((t) => [t.name, t.mode, t.like]), [["fpiu_sign_3", "insert", "FPIU_SIGN_2"], ["fpiu_sign_1", "delete", null]]);
});

test("a removal that would empty a dictionary is refused", () => {
  const plan = planLiveryWrite({ modelPath: MODEL, dictionaries: [HI, BASE], pattern: "fpiu_sign_#", removed: [1, 2] });
  assert.match(plan.blocked, /leaves GSDSS24Explorer\.ytd with no textures/);
  assert.ok(!canWriteLiveries(plan));
  assert.ok(plan.checks.some((check) => /removes every livery/.test(check.text)));
  // The +hi dictionary keeps its badge, so it alone may lose every livery.
  assert.equal(planLiveryWrite({ modelPath: MODEL, dictionaries: [HI], pattern: "fpiu_sign_#", removed: [1, 2] }).blocked, null);
});

test("saved sets keep their removals, never on a staged number", () => {
  const set = normalizeLiverySet({ pattern: "fpiu_sign_#", items: [{ id: "a", path: "C:\\l\\a.png", number: 2 }], removed: [4, "3", 2, 0, 100, 4, 1.5] });
  assert.deepEqual(set.removed, [3, 4]);
  assert.deepEqual(normalizeLiverySet({ items: [] }).removed, []);
});

test("the write action names what it does", () => {
  assert.equal(liveryWriteLabel(3, 0), "Write 3 liveries");
  assert.equal(liveryWriteLabel(1, 0), "Write 1 livery");
  assert.equal(liveryWriteLabel(3, 1), "Write 3, remove 1");
  assert.equal(liveryWriteLabel(0, 2), "Remove 2 liveries");
});

test("sizes for a dictionary without liveries round to powers of two up to 4096", () => {
  assert.deepEqual(fittedLiverySize({ width: 3000, height: 700 }), { width: 2048, height: 512 });
  assert.deepEqual(fittedLiverySize({ width: 9000, height: 20 }), { width: 4096, height: 64 });
  assert.equal(dxt5Bytes(8, 8), 64 + 16);
  assert.equal(dxt5Bytes(8, 8, 1), 64);
});
