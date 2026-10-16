import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  applySirenPreset,
  argbFromColor,
  checkSirenSetting,
  colorFromArgb,
  countSequencerSteps,
  createCarcolsFile,
  createSirenLight,
  createSirenSetting,
  describeSirenChanges,
  invertSequencer,
  nextFreeSirenId,
  patternFromSequencer,
  presetLights,
  SEQUENCER_PRESETS,
  sequencerFromPattern,
  sequencerStep,
  serializeSirenSetting,
  setSequencerStep,
  shiftSequencer,
  sirenImportTarget,
  spliceSirenSetting,
  updateSirens,
} from "./siren-settings.js";
import { sequencerPattern } from "./emergency-lights.js";
import { parseCarcolsMeta } from "./vehicle-meta.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "meta");
const policeCarcols = () => readFileSync(path.join(FIXTURES, "police", "carcols.meta"), "utf8");

// Fields the preview and the writer care about, without source bookkeeping.
function comparable(setting) {
  const { sourcePath, sirenCount, ...rest } = setting;
  return rest;
}

test("sequencer patterns round-trip MSB first and match the light preview", () => {
  const value = sequencerFromPattern("1".repeat(16) + "0".repeat(16));
  assert.equal(value, 4294901760);
  assert.equal(patternFromSequencer(value), sequencerPattern(value));
  assert.equal(sequencerFromPattern("101"), null);
  assert.equal(sequencerFromPattern("10".repeat(16)), 2863311530);
  assert.equal(sequencerStep(0x80000000, 0), true);
  assert.equal(setSequencerStep(0, 0, true), 0x80000000);
  assert.equal(setSequencerStep(0xffffffff, 31, false), 0xfffffffe);
  assert.equal(invertSequencer(0), 0xffffffff);
  assert.equal(countSequencerSteps(2863311530), 16);
});

test("shifting rotates the loop without losing steps", () => {
  const start = sequencerFromPattern("1" + "0".repeat(31));
  assert.equal(patternFromSequencer(shiftSequencer(start, 1)), "01" + "0".repeat(30));
  assert.equal(patternFromSequencer(shiftSequencer(start, -1)), "0".repeat(31) + "1");
  assert.equal(shiftSequencer(start, 32), start);
  assert.equal(countSequencerSteps(shiftSequencer(2863311530, 5)), 16);
});

test("preset phases never overlap", () => {
  for (const preset of SEQUENCER_PRESETS) {
    if (preset.a === preset.b) continue;
    assert.equal((preset.a & preset.b) >>> 0, 0, preset.id);
  }
});

test("ARGB colours keep alpha", () => {
  assert.equal(argbFromColor("#ff0000", 1), "0xFFFF0000");
  assert.equal(argbFromColor("#0000ff", 0.5), "0x800000FF");
  assert.deepEqual(colorFromArgb("0x800000FF"), { color: "#0000ff", alpha: 128 / 255 });
  assert.deepEqual(colorFromArgb("#00ff00"), { color: "#00ff00", alpha: 1 });
  assert.equal(colorFromArgb("red"), null);
});

test("a parsed setting serializes back to the same values", () => {
  const original = parseCarcolsMeta(policeCarcols(), "carcols.meta").sirens[0];
  const xml = serializeSirenSetting(original);
  const wrapped = `<CVehicleModelInfoVarGlobal><Sirens>${xml}</Sirens></CVehicleModelInfoVarGlobal>`;
  const reparsed = parseCarcolsMeta(wrapped, "carcols.meta").sirens[0];
  assert.deepEqual(comparable(reparsed), comparable(original));
});

test("splicing replaces only the matching setting and keeps the rest byte for byte", () => {
  const source = policeCarcols();
  const original = parseCarcolsMeta(source, "carcols.meta").sirens[0];
  const edited = updateSirens({ ...original, sequencerBpm: 450 }, [0], (light) => {
    light.color = "#00ff00";
    light.flashiness.sequencer = 4294901760;
  });
  const { text, mode } = spliceSirenSetting(source, edited, { matchId: original.id });
  assert.equal(mode, "replaced");
  const before = source.slice(0, source.indexOf("<Sirens>"));
  assert.ok(text.startsWith(before), "everything before <Sirens> is untouched");
  const after = parseCarcolsMeta(text, "carcols.meta");
  assert.equal(after.sirens.length, 1);
  assert.equal(after.sirens[0].sequencerBpm, 450);
  assert.equal(after.sirens[0].sirens[0].color, "#00ff00");
  assert.equal(after.sirens[0].sirens[0].flashiness.sequencer, 4294901760);
  assert.equal(after.sirens[0].sirens[1].color, original.sirens[1].color);
  assert.equal(after.lights.length, 1);
  // Saving the unedited setting reproduces the file.
  assert.equal(spliceSirenSetting(source, original, { matchId: original.id }).text, source);
});

test("splicing keeps CRLF, tabs, a BOM and unknown siren tags", () => {
  const source = "﻿<?xml version=\"1.0\"?>\r\n<CVehicleModelInfoVarGlobal>\r\n\t<Sirens>\r\n\t\t<Item>\r\n\t\t\t<id value=\"7\" />\r\n"
    + "\t\t\t<name>old</name>\r\n\t\t\t<sequencerBpm value=\"300\" />\r\n\t\t\t<customFlag value=\"3\" />\r\n\t\t\t<sirens>\r\n"
    + "\t\t\t\t<Item>\r\n\t\t\t\t\t<color value=\"0xFFFF0000\" />\r\n\t\t\t\t\t<flash value=\"true\" />\r\n\t\t\t\t\t<packFlag>yes</packFlag>\r\n"
    + "\t\t\t\t</Item>\r\n\t\t\t</sirens>\r\n\t\t</Item>\r\n\t</Sirens>\r\n<!-- keep me -->\r\n</CVehicleModelInfoVarGlobal>\r\n";
  const setting = parseCarcolsMeta(source, "carcols.meta").sirens[0];
  assert.deepEqual(setting.extraXml, ['<customFlag value="3" />']);
  assert.deepEqual(setting.sirens[0].extraXml, ["<packFlag>yes</packFlag>"]);
  const { text } = spliceSirenSetting(source, { ...setting, name: "new" }, { matchId: 7 });
  assert.ok(text.startsWith("﻿<?xml"));
  assert.ok(!/[^\r]\n/.test(text), "every line ends with CRLF");
  assert.ok(text.includes("\r\n\t\t\t<name>new</name>\r\n"));
  assert.ok(text.includes("<!-- keep me -->"));
  const reparsed = parseCarcolsMeta(text, "carcols.meta").sirens[0];
  assert.equal(reparsed.name, "new");
  assert.deepEqual(reparsed.extraXml, ['<customFlag value="3" />']);
  assert.deepEqual(reparsed.sirens[0].extraXml, ["<packFlag>yes</packFlag>"]);
});

test("splicing writes numbers and self-closing tags the way the file does", () => {
  const source = '<CVehicleModelInfoVarGlobal>\n  <Sirens>\n    <Item>\n      <id value="3"/>\n      <name>tight</name>\n'
    + '      <timeMultiplier value="1.00000000"/>\n      <sequencerBpm value="600"/>\n      <useRealLights value="true"/>\n'
    + '      <sirens>\n        <Item>\n          <color value="0xFFFF0000"/>\n          <intensity value="2.50000000"/>\n'
    + '          <flash value="true"/>\n        </Item>\n      </sirens>\n    </Item>\n  </Sirens>\n</CVehicleModelInfoVarGlobal>\n';
  const setting = parseCarcolsMeta(source).sirens[0];
  const { text } = spliceSirenSetting(source, { ...setting, timeMultiplier: 1.5 }, { matchId: 3 });
  assert.ok(text.includes('<timeMultiplier value="1.50000000"/>'));
  assert.ok(text.includes('<intensity value="2.50000000"/>'));
  assert.ok(!text.includes(" />"), "keeps the file's tight self-closing tags");
});

const PACK = [
  "<CVehicleModelInfoVarGlobal>",
  "  <Sirens>",
  "    <Item>",
  '      <id value="9"/>',
  "      <name>pack</name>",
  '       <timeMultiplier value="1.00000000"/>',
  '      <sequencerBpm value="830"/>',
  '      <useRealLights value="true"/>',
  "      <sirens>",
  ...[1, 2, 3].flatMap((index) => [
    `        <!-- Siren ${index} -->`,
    "        <Item> ",
    "          <rotation>",
    '            <delta value="0.000000000"/>',
    '            <start value="0.000"/>',
    '            <speed value="1.000"/>',
    '            <sequencer value="4294967295"/>',
    '            <multiples value="1"/>',
    '            <direction value="false"/>',
    '            <syncToBpm value="true"/>',
    "          </rotation>",
    "          <flashiness>",
    '            <delta value="0.000000000"/>',
    '            <start value="0.000"/>',
    '            <speed value="1.000"/>',
    '            <sequencer value="2863311530"/>',
    '            <multiples value="1"/>',
    '            <direction value="false"/>',
    '            <syncToBpm value="true"/>',
    "          </flashiness>",
    "          <corona>",
    '            <intensity value="1"/>',
    '            <size value="0.000"/>',
    '            <pull value="0.02"/>',
    '            <faceCamera value="false"/>',
    "          </corona>",
    `          <color value="${index === 2 ? "0xFF0000FF" : "0xFFFF0000"}"/>`,
    '          <intensity value="1.00000000"/>',
    '          <lightGroup value="0"/>',
    '          <rotate value="false"/>',
    '          <scale value="true"/>',
    '          <scaleFactor value="10"/>',
    '          <flash value="true"/>',
    '          <light value="true"/>',
    '          <spotLight value="true"/>',
    "        </Item>",
  ]),
  "      </sirens>",
  "    </Item>",
  "  </Sirens>",
  "</CVehicleModelInfoVarGlobal>",
  "",
].join("\n");

function changedLines(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  return b.length === a.length ? a.flatMap((line, index) => (line === b[index] ? [] : [[line, b[index]]])) : null;
}

test("saving into a hand-formatted pack changes only the edited values", () => {
  const setting = parseCarcolsMeta(PACK).sirens[0];
  assert.equal(spliceSirenSetting(PACK, setting, { matchId: 9 }).text, PACK, "an unedited save is byte for byte");
  const edited = updateSirens({ ...setting, sequencerBpm: 600 }, [1], (light) => {
    light.flashiness.sequencer = 1431655765;
    light.flashiness.speed = 2.5;
    light.color = "#00ff00";
  });
  const { text } = spliceSirenSetting(PACK, edited, { matchId: 9 });
  assert.deepEqual(changedLines(PACK, text), [
    ['      <sequencerBpm value="830"/>', '      <sequencerBpm value="600"/>'],
    ['            <speed value="1.000"/>', '            <speed value="2.500"/>'],
    ['            <sequencer value="2863311530"/>', '            <sequencer value="1431655765"/>'],
    ['          <color value="0xFF0000FF"/>', '          <color value="0xFF00FF00"/>'],
  ]);
  assert.ok(text.includes("<!-- Siren 2 -->"));
});

test("patching adds and removes sirens and writes tags the pack left out", () => {
  const setting = parseCarcolsMeta(PACK).sirens[0];
  const withShadows = updateSirens(setting, [0], (light) => { light.castShadows = true; });
  const shadowed = spliceSirenSetting(PACK, withShadows, { matchId: 9 }).text;
  assert.equal(parseCarcolsMeta(shadowed).sirens[0].sirens[0].castShadows, true);
  assert.equal(shadowed.split("\n").length, PACK.split("\n").length + 1);

  const added = spliceSirenSetting(PACK, { ...setting, sirens: [...setting.sirens, ...presetLights("amber")] }, { matchId: 9 }).text;
  const addedSetting = parseCarcolsMeta(added).sirens[0];
  assert.equal(addedSetting.sirens.length, 4);
  assert.equal(addedSetting.sirens[3].color, "#ff8800");
  assert.ok(added.startsWith(PACK.slice(0, PACK.lastIndexOf("      </sirens>"))), "existing sirens untouched");
  assert.ok(!/ \/>/.test(added), "new sirens follow the pack's tight tags");

  const removed = spliceSirenSetting(PACK, { ...setting, sirens: setting.sirens.slice(0, 1) }, { matchId: 9 }).text;
  assert.equal(parseCarcolsMeta(removed).sirens[0].sirens.length, 1);
  assert.ok(!removed.includes("<!-- Siren 2 -->"), "a removed siren takes its comment with it");
  assert.ok(removed.includes("<!-- Siren 1 -->"));
});

test("a new setting is appended, into an empty list or a file without one", () => {
  const setting = createSirenSetting({ id: 42, name: "new", count: 2 });
  const withList = "<CVehicleModelInfoVarGlobal>\n  <Sirens>\n    <Item>\n      <id value=\"1\" />\n    </Item>\n  </Sirens>\n</CVehicleModelInfoVarGlobal>\n";
  const appended = spliceSirenSetting(withList, setting, { matchId: 42 });
  assert.equal(appended.mode, "appended");
  assert.deepEqual(parseCarcolsMeta(appended.text).sirens.map((entry) => entry.id), [1, 42]);

  const selfClosing = "<CVehicleModelInfoVarGlobal>\n  <Kits />\n  <Sirens />\n</CVehicleModelInfoVarGlobal>\n";
  const filled = spliceSirenSetting(selfClosing, setting);
  assert.deepEqual(parseCarcolsMeta(filled.text).sirens.map((entry) => entry.id), [42]);
  assert.equal(parseCarcolsMeta(filled.text).sirens[0].sirens.length, 2);

  const noList = "<CVehicleModelInfoVarGlobal>\n  <Kits />\n</CVehicleModelInfoVarGlobal>\n";
  const created = spliceSirenSetting(noList, setting);
  assert.deepEqual(parseCarcolsMeta(created.text).sirens.map((entry) => entry.id), [42]);
  assert.ok(created.text.includes("  <Kits />\n  <Sirens>\n"));
});

test("splicing rejects files that are not carcols", () => {
  assert.throws(() => spliceSirenSetting("<CVehicleModelInfo__InitDataList />", createSirenSetting({ id: 1 })), /carcols root/);
  assert.throws(() => spliceSirenSetting("<CVehicleModelInfoVarGlobal>", createSirenSetting({ id: 1 })), /XML parse error/);
});

test("a fresh carcols file parses back to the setting", () => {
  const setting = createSirenSetting({ id: 9, name: "pack", count: 3 });
  const parsed = parseCarcolsMeta(createCarcolsFile(setting)).sirens[0];
  assert.deepEqual(comparable(parsed), comparable(setting));
});

test("presets build complete lights", () => {
  const lights = presetLights("lightbar");
  assert.equal(lights.length, 16);
  assert.equal(lights[0].color, "#ff0000");
  assert.equal(lights[1].color, "#0000ff");
  assert.equal(((lights[0].flashiness.sequencer & lights[1].flashiness.sequencer) >>> 0), 0);
  const rotator = presetLights("rotator")[0];
  assert.equal(rotator.rotate, true);
  assert.equal(rotator.flash, false);
  assert.equal(rotator.rotation.multiples, 1);
  assert.deepEqual(presetLights("missing"), []);
});

test("free ids skip every used id", () => {
  assert.equal(nextFreeSirenId([1, 2, 3], 1), 4);
  assert.equal(nextFreeSirenId([], 100), 100);
  assert.equal(nextFreeSirenId([100, 101], 100), 102);
});

test("checks name the problem and the siren", () => {
  const setting = createSirenSetting({ id: 5, name: "x", count: 3 });
  setting.sirens[1].flashiness.sequencer = 0;
  setting.sequencerBpm = 0;
  const issues = checkSirenSetting(setting, {
    sirenBones: [1, 2, 4],
    otherSettings: [{ id: 5, name: "other" }],
    variationId: 6,
  });
  const codes = issues.map((entry) => entry.code);
  assert.equal(codes[0], "ID_CONFLICT");
  assert.ok(codes.includes("LINK_MISMATCH"));
  assert.ok(codes.includes("NO_TEMPO"));
  assert.ok(issues.find((entry) => entry.code === "EMPTY_PATTERN").message.startsWith("Siren 2 "));
  assert.ok(issues.find((entry) => entry.code === "NO_BONE").message.startsWith("Siren 3 "));
  assert.ok(issues.find((entry) => entry.code === "BONE_UNUSED").message.includes("siren 4"));
  assert.deepEqual(checkSirenSetting({ ...setting, id: null }).map((entry) => entry.code).slice(0, 1), ["ID_MISSING"]);
  assert.ok(checkSirenSetting(createSirenSetting({ id: 8, count: 1 }), { variationId: null }).some((entry) => entry.code === "NOT_LINKED"));
});

test("the unsaved change list names what an edit changed against the file", () => {
  const base = createSirenSetting({ id: 7265, name: "UMTAHOE", count: 4 });
  const draft = structuredClone(base);
  draft.sequencerBpm = 700;
  draft.lamps.leftHeadLight.sequencer = sequencerFromPattern("10".repeat(16));
  draft.sirens[0].flashiness.sequencer = sequencerFromPattern("1100".repeat(8));
  draft.sirens[1].intensity = 3;
  draft.sirens[2].intensity = 3;
  draft.sirens[3].flashiness.delta = Math.PI;
  draft.sirens[3].rotation.delta = Math.PI;
  assert.deepEqual(describeSirenChanges(base, draft), [
    "Sequencer bpm 600 → 700",
    "Left headlight: pattern",
    "Siren 1: flash pattern",
    "Sirens 2, 3: intensity 2 → 3",
    "Siren 4: rotation offset, aim",
  ]);

  const grown = structuredClone(base);
  grown.sirens.push(createSirenLight());
  grown.sirens[0].color = "#00ff00";
  assert.deepEqual(describeSirenChanges(base, grown), ["Siren count 4 → 5", "Siren 1: colour #ff0000 → #00ff00"]);
  assert.deepEqual(describeSirenChanges(base, structuredClone(base)), []);
  assert.deepEqual(describeSirenChanges(null, base), [
    "New setting: no carcols.meta has it yet. Install or Save to carcols.meta adds it as id 7265.",
    "4 sirens at 600 bpm",
  ]);
});

test("importing the resource's own setting edits it instead of adding a copy", () => {
  const imported = { id: 7265 };
  const resourceSettings = [{ id: 7265, sourcePath: "C:\\res\\umtahoe\\data\\carcols.meta" }];
  const own = "c:/res/umtahoe/data/carcols.meta";
  assert.deepEqual(sirenImportTarget({ imported, path: own, draft: null, resourceSettings }), { mode: "adopt", id: 7265, sourcePath: own });
  // An unsaved new draft is replaced by the file's own setting too.
  assert.equal(sirenImportTarget({ imported, path: own, draft: { id: 7266, sourcePath: "" }, resourceSettings }).mode, "adopt");
  assert.equal(sirenImportTarget({ imported, path: own, draft: null, resourceSettings, linkedId: 7265 }).mode, "adopt");
  // The vehicle links another id: the file's setting is not this vehicle's.
  assert.deepEqual(sirenImportTarget({ imported, path: own, draft: null, resourceSettings, linkedId: 12 }), { mode: "new", id: 12 });
  // The same id from another file gets a free id.
  const copy = sirenImportTarget({ imported, path: "D:/packs/carcols.meta", draft: null, resourceSettings });
  assert.equal(copy.mode, "new");
  assert.notEqual(copy.id, 7265);
  // A draft that lives in a file takes only the pattern.
  assert.deepEqual(sirenImportTarget({ imported, path: own, draft: { id: 9, sourcePath: own }, resourceSettings }), { mode: "pattern", id: 9 });
});

test("a preset restyles the selected sirens in place and keeps their aim", () => {
  const setting = createSirenSetting({ id: 1, count: 5, colors: ["#ffffff"], headings: { 2: Math.PI / 2, 4: Math.PI } });
  setting.sirens[3].extraXml = ["<custom>1</custom>"];
  const next = applySirenPreset(setting, [3, 1, 2], "red-blue");
  assert.equal(next.sirens.length, 5);
  assert.deepEqual(next.sirens.map((light) => light.color), ["#ffffff", "#ff0000", "#0000ff", "#ff0000", "#ffffff"]);
  const [redPhase, bluePhase] = presetLights("red-blue").map((light) => light.flashiness.sequencer);
  assert.deepEqual([1, 2, 3].map((index) => next.sirens[index].flashiness.sequencer), [redPhase, bluePhase, redPhase]);
  // Bones keep pointing where they did; untouched sirens are the same objects.
  assert.equal(next.sirens[1].flashiness.delta, Math.PI / 2);
  assert.equal(next.sirens[1].rotation.delta, Math.PI / 2);
  assert.equal(next.sirens[3].flashiness.delta, Math.PI);
  assert.deepEqual(next.sirens[3].extraXml, ["<custom>1</custom>"]);
  assert.equal(next.sirens[0], setting.sirens[0]);
  assert.equal(setting.sirens[1].color, "#ffffff");

  const rotator = applySirenPreset(setting, [0], "rotator").sirens[0];
  assert.equal(rotator.rotate, true);
  assert.equal(rotator.flash, false);
  assert.equal(applySirenPreset(setting, [], "red-blue"), setting);
  assert.equal(applySirenPreset(setting, [0], "missing"), setting);
});

test("ids above 255 note the singleplayer limit", () => {
  const codes = (id) => checkSirenSetting(createSirenSetting({ id, count: 1 }), { variationId: id }).map((entry) => entry.code);
  assert.ok(codes(7265).includes("ID_ABOVE_255"));
  assert.equal(checkSirenSetting(createSirenSetting({ id: 7265, count: 1 })).find((entry) => entry.code === "ID_ABOVE_255").severity, "info");
  assert.ok(!codes(255).includes("ID_ABOVE_255"));
});
