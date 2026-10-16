import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  VcfError,
  checkVcf,
  cloneVcf,
  createVcf,
  createVcfText,
  describeVcfChanges,
  elsExtraRole,
  ensureLight,
  isVcfText,
  parseVcf,
  serializeVcf,
  stage2Extras,
} from "./els-vcf.js";
import {
  PatternImportError,
  loadPatternPack,
  lookupPattern,
  normalizePatternPack,
  packFromElsFivem,
  parseLuaAssignments,
  patternNumbers,
  savePatternPack,
  summarizePatternPack,
} from "./els-patterns.js";
import { defaultElsPreview, elsAnimates, elsPlaybackNotes, elsRunning, elsSwitchBlocks, evaluateEls, missFlashAt, v8GroupLane } from "./els-lights.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "els");
// Git may check fixtures out with CRLF (core.autocrlf); expectations here are
// written with LF, and the CRLF path has its own test below.
const fixture = (name) => readFileSync(path.join(FIXTURES, name), "utf8").replace(/\r\n/g, "\n");

// A tiny ELS-FiveM-shaped pattern file written for these tests.
const LEDS_LUA = `
led_PrimaryPatterns = {
    [1] = {
        [1] = "0011",
        [2] = "0011",
        [3] = "1100",
        [4] = "1100",
    },
}
    led_SecondaryPatterns = {
    [1] = { [7] = "01", [8] = "10", [9] = "01" },
    }
-- warning table has the script's own spelling
    leds_WarningPatterns = { [2] = { [5] = "0", [6] = "1" } }
`;
const TRAF_LUA = `traf_Patterns = { [1] = { [7] = "0111", [8] = "1011", [9] = "1101" }, [2] = { [7] = "0", [8] = "0", [9] = "0" } }`;

function testPack() {
  return packFromElsFivem([{ name: "leds.lua", text: LEDS_LUA }, { name: "traf.lua", text: TRAF_LUA }], { path: "C:/els" });
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

// ---------------------------------------------------------------------------
// VCF parsing and writing

test("parses an ELS V8 VCF into groups, stages and lights", () => {
  const config = parseVcf(fixture("v8-cruiser.xml"));
  assert.equal(config.dialect, "els-v8");
  assert.equal(config.description, "Test cruiser");
  assert.equal(config.lights.length, 12);
  assert.deepEqual(config.lights[0], { kind: "extra", id: 1, controlled: true, envLight: true, color: "red", offset: [-0.6, 0.1, 0.4], attrs: {} });
  assert.equal(config.lights[9].controlled, false);
  assert.equal(config.v8.primary.format, "leds");
  assert.equal(config.v8.primary.extrasAtStage2, "2and3");
  assert.deepEqual(config.v8.primary.presets, { 1: null, 2: { enabled: true, pattern: 1 }, 3: { enabled: true, pattern: 3 } });
  assert.deepEqual(config.v8.primary.scanPool, { enabled: false, sequential: true, patterns: [1, 2] });
  assert.equal(config.v8.secondary.format, "traf");
  assert.equal(config.v8.secondary.disableAtStage3, true);
  assert.match(config.v8.warning.forcedXml, /^<ForcedPatterns>[\s\S]*<\/ForcedPatterns>$/);
  assert.equal(config.v8.misc.sirenLightsAtStage, 3);
  assert.deepEqual(config.v8.misc.takedowns, { allow: true, mirrored: true });
  assert.deepEqual(config.v8.misc.extraXml, ['<LadderControl enabled="false" />']);
  assert.deepEqual(config.v8.cruise.extras, [1, 4]);
  assert.equal(elsExtraRole("els-v8", 5), "Warning");
  assert.equal(elsExtraRole("els-v8", 11), "Takedowns");
});

test("parses a MISS-ELS VCF with flashes, statics and miscs", () => {
  const config = parseVcf(fixture("miss-patrol.xml"));
  assert.equal(config.dialect, "miss-els");
  assert.deepEqual(config.rootAttrs, { Version: "1.1.0" });
  assert.deepEqual(config.lights.map((light) => `${light.kind}:${light.id}`), ["extra:1", "extra:2", "extra:5", "extra:7", "extra:11", "misc:a"]);
  assert.ok(config.lights.every((light) => light.controlled));
  assert.deepEqual(config.miss.statics, [{ kind: "extra", id: 11, name: "Push bar" }]);
  assert.deepEqual(config.miss.patterns.primary.flashes[2], { duration: 100, extras: [2], miscs: ["a"] });
  assert.equal(config.miss.patterns.rearReds.isEmergency, false);
  assert.equal(config.miss.patterns.secondary.isEmergency, null);
});

test("an unedited VCF writes back byte for byte, CRLF, tabs and comments included", () => {
  for (const name of ["v8-cruiser.xml", "miss-patrol.xml"]) {
    const text = fixture(name);
    assert.equal(serializeVcf(parseVcf(text), text), text, name);
  }
  const bom = `\ufeff${fixture("miss-patrol.xml")}`;
  assert.equal(serializeVcf(parseVcf(bom), bom), bom);
});

test("an edit rewrites only the values it changed", () => {
  const text = fixture("v8-cruiser.xml");
  const config = parseVcf(text);
  config.v8.primary.presets[3].pattern = 7;
  const lstg3 = (value) => text.replace('<Lstg3 Enabled="true" Pattern="3" />', `<Lstg3 Enabled="true" Pattern="${value}" />`);
  assert.equal(serializeVcf(config, text), lstg3(7));
  // MISC: two values change; its unknown child and the other values stay put.
  config.v8.misc.steadyBurn = true;
  config.v8.misc.takedowns.mirrored = false;
  const out = serializeVcf(config, text);
  assert.equal(out, lstg3(7)
    .replace("<UseSteadyBurnLights>false</UseSteadyBurnLights>", "<UseSteadyBurnLights>true</UseSteadyBurnLights>")
    .replace('<Takedowns AllowUse="true" Mirrored="true" />', '<Takedowns AllowUse="true" Mirrored="false" />'));
  assert.deepEqual(parseVcf(out).v8.misc.extraXml, ['<LadderControl enabled="false" />']);
});

test("edited ELS V8 sections keep comments, unknown elements and attributes", () => {
  const lines = (list) => list.join("\r\n");
  const text = lines([
    '<?xml version="1.0" encoding="utf-8"?>',
    '<vcfroot Description="Odd" Author="Someone">',
    "\t<EOVERRIDE>",
    "\t\t<!-- lightbar -->",
    '\t\t<Extra01 IsElsControlled="true" AllowEnvLight="true" Color="red" OffsetX="0.00" OffsetY="0.00" OffsetZ="0.00" Glow="2" />',
    '\t\t<Extra04 IsElsControlled="true" AllowEnvLight="false" Color="blue" OffsetX="0.00" OffsetY="0.00" OffsetZ="0.00" />',
    '\t\t<Extra10 IsElsControlled="false" /> <!-- steady -->',
    '\t\t<MiscA Color="amber" />',
    "\t</EOVERRIDE>",
    '\t<PRML LightingFormat="leds" ExtrasActiveAtLstg2="1and4" Custom="x">',
    "\t\t<PresetPatterns>",
    "\t\t\t<!-- pursuit -->",
    '\t\t\t<Lstg2 Enabled="true" />',
    '\t\t\t<Lstg3 Enabled="true" Pattern="3" Speed="fast" />',
    "\t\t\t<Note>keep</Note>",
    "\t\t</PresetPatterns>",
    '\t\t<Experimental on="1" />',
    "\t</PRML>",
    "</vcfroot>",
    "",
  ]);
  const config = parseVcf(text);
  // A stage preset without a Pattern stays without one.
  assert.equal(config.v8.primary.presets[2].pattern, null);
  assert.equal(serializeVcf(config, text), text);
  config.lights.find((light) => light.id === 1).color = "blue";
  config.lights.find((light) => light.id === 10).controlled = true;
  ensureLight(config, "extra", 2).controlled = true;
  config.v8.primary.presets[3].pattern = 5;
  config.v8.primary.presets[1] = { enabled: true, pattern: 9 };
  config.v8.primary.attrs.Custom = "y";
  config.author = "Someone else";
  assert.equal(serializeVcf(config, text), lines([
    '<?xml version="1.0" encoding="utf-8"?>',
    '<vcfroot Description="Odd" Author="Someone else">',
    "\t<EOVERRIDE>",
    "\t\t<!-- lightbar -->",
    '\t\t<Extra01 IsElsControlled="true" AllowEnvLight="true" Color="blue" OffsetX="0.00" OffsetY="0.00" OffsetZ="0.00" Glow="2" />',
    '\t\t<Extra02 IsElsControlled="true" AllowEnvLight="false" Color="red" OffsetX="0.00" OffsetY="0.00" OffsetZ="0.00" />',
    '\t\t<Extra04 IsElsControlled="true" AllowEnvLight="false" Color="blue" OffsetX="0.00" OffsetY="0.00" OffsetZ="0.00" />',
    '\t\t<Extra10 IsElsControlled="true" AllowEnvLight="false" Color="red" OffsetX="0.00" OffsetY="0.00" OffsetZ="0.00" /> <!-- steady -->',
    '\t\t<MiscA Color="amber" />',
    "\t</EOVERRIDE>",
    '\t<PRML LightingFormat="leds" ExtrasActiveAtLstg2="1and4" Custom="y">',
    "\t\t<PresetPatterns>",
    "\t\t\t<!-- pursuit -->",
    '\t\t\t<Lstg1 Enabled="true" Pattern="9" />',
    '\t\t\t<Lstg2 Enabled="true" />',
    '\t\t\t<Lstg3 Enabled="true" Pattern="5" Speed="fast" />',
    "\t\t\t<Note>keep</Note>",
    "\t\t</PresetPatterns>",
    '\t\t<Experimental on="1" />',
    "\t</PRML>",
    "</vcfroot>",
    "",
  ]));
});

test("MISS-ELS edits move only the flashes, lights and statics they touch", () => {
  const text = fixture("miss-patrol.xml").replace('<Flash Duration="500" Extras="7" />', '<Flash Duration="500" Extras="7" Label="rear" />');
  const config = parseVcf(text);
  const primary = config.miss.patterns.primary.flashes;
  primary.splice(2, 0, { duration: 75, extras: [1, 2], miscs: [] });
  config.miss.patterns.secondary.flashes.splice(1, 1);
  config.miss.patterns.rearReds.flashes[0].extras = [7, 9];
  config.lights.find((light) => light.id === 5).controlled = false;
  Object.assign(ensureLight(config, "extra", 3), { controlled: true, color: "amber" });
  config.miss.statics[0].name = "Push bumper";
  config.miss.statics.push({ kind: "misc", id: "a", name: "Alley" });
  const expected = text
    .replace('OffsetZ="0.20" />\n', 'OffsetZ="0.20" />\n        <Extra03 AllowEnvLight="false" Color="amber" />\n')
    .replace('        <Extra05 AllowEnvLight="false" Color="white" />\n', "")
    .replace('        <Extra11 Name="Push bar" />\n', '        <Extra11 Name="Push bumper" />\n        <MiscA Name="Alley" />\n')
    .replace('<Flash Duration="50" />\n            <Flash Duration="100" Extras="2"', '<Flash Duration="50" />\n            <Flash Duration="75" Extras="1,2" />\n            <Flash Duration="100" Extras="2"')
    .replace('            <Flash Duration="300" Extras="5" />\n            <Flash Duration="300" />\n', '            <Flash Duration="300" Extras="5" />\n')
    .replace('<Flash Duration="500" Extras="7" Label="rear" />', '<Flash Duration="500" Extras="7,9" Label="rear" />');
  assert.equal(serializeVcf(config, text), expected);
  assert.ok(expected.includes("<!-- left then right -->"));
  // Emptying a list and refilling it, or filling a self-closing one, stays well formed.
  const small = '<vcfroot><EOVERRIDE>\n  <Extra01 Color="red" />\n</EOVERRIDE><STATIC /><PATTERN /></vcfroot>';
  const edit = parseVcf(small);
  edit.lights[0].controlled = false;
  Object.assign(ensureLight(edit, "extra", 2), { controlled: true });
  edit.miss.statics.push({ kind: "extra", id: 2, name: "Spot" });
  const written = serializeVcf(edit, small);
  assert.equal(written, '<vcfroot><EOVERRIDE>\n  <Extra02 AllowEnvLight="false" Color="red" />\n</EOVERRIDE><STATIC>\n  <Extra02 Name="Spot" />\n</STATIC><PATTERN /></vcfroot>');
  assert.deepEqual(parseVcf(written).miss.statics, [{ kind: "extra", id: 2, name: "Spot" }]);
});

test("a self-closing element takes attribute edits and children in one save", () => {
  const v8 = '<vcfroot>\n  <PRML LightingFormat="leds">\n    <ScanPatternCustomPool Enabled="false" Sequential="true" />\n  </PRML>\n  <SECL LightingFormat="leds" />\n</vcfroot>\n';
  const config = parseVcf(v8);
  Object.assign(config.v8.primary.scanPool, { enabled: true, patterns: [3, 5] });
  config.v8.secondary.format = "traf";
  config.v8.secondary.presets[1] = { enabled: true, pattern: 2 };
  config.v8.secondary.scanPool = { enabled: true, sequential: false, patterns: [4] };
  const out = serializeVcf(config, v8);
  assert.equal(out, [
    "<vcfroot>",
    '  <PRML LightingFormat="leds">',
    '    <ScanPatternCustomPool Enabled="true" Sequential="true">',
    "      <Pattern>3</Pattern>",
    "      <Pattern>5</Pattern>",
    "    </ScanPatternCustomPool>",
    "  </PRML>",
    '  <SECL LightingFormat="traf">',
    "    <PresetPatterns>",
    '      <Lstg1 Enabled="true" Pattern="2" />',
    "    </PresetPatterns>",
    '    <ScanPatternCustomPool Enabled="true" Sequential="false">',
    "      <Pattern>4</Pattern>",
    "    </ScanPatternCustomPool>",
    "  </SECL>",
    "</vcfroot>",
    "",
  ].join("\n"));
  assert.deepEqual(parseVcf(out).v8.secondary.scanPool, config.v8.secondary.scanPool);

  const miss = '<vcfroot>\n  <PATTERN>\n    <PRIMARY IsEmergency="true">\n      <Flash Duration="100" Extras="1" />\n    </PRIMARY>\n    <REARREDS IsEmergency="false" />\n  </PATTERN>\n</vcfroot>\n';
  const edit = parseVcf(miss);
  edit.miss.patterns.rearReds.isEmergency = true;
  edit.miss.patterns.rearReds.flashes.push({ duration: 200, extras: [1], miscs: [] });
  assert.equal(serializeVcf(edit, miss), miss.replace('<REARREDS IsEmergency="false" />', '<REARREDS IsEmergency="true">\n      <Flash Duration="200" Extras="1" />\n    </REARREDS>'));

  // A self-closing root opens to take a new section.
  const empty = '<vcfroot Description="x" />\n';
  const filled = parseVcf(empty);
  filled.description = "y";
  Object.assign(ensureLight(filled, "extra", 1), { controlled: true });
  assert.equal(serializeVcf(filled, empty), '<vcfroot Description="y">\n\t<EOVERRIDE>\n\t\t<Extra01 AllowEnvLight="false" Color="red" />\n\t</EOVERRIDE>\n</vcfroot>\n');
});

test("edits keep the file's indentation style and add missing sections", () => {
  const text = fixture("miss-patrol.xml").replace(/\s*<STATIC>[\s\S]*?<\/STATIC>/, "");
  const config = parseVcf(text);
  assert.deepEqual(config.miss.statics, []);
  config.miss.statics.push({ kind: "extra", id: 11, name: "Push bar" });
  config.miss.patterns.secondary.flashes[0].duration = 250;
  config.description = "Renamed & checked";
  const out = serializeVcf(config, text);
  assert.ok(out.includes('    <STATIC>\n        <Extra11 Name="Push bar" />\n    </STATIC>\n</vcfroot>'));
  assert.ok(out.includes('<vcfroot Description="Renamed &amp; checked" Author="Cortex" Version="1.1.0">'));
  assert.ok(out.includes('            <Flash Duration="250" Extras="5" />'));
  const back = parseVcf(out);
  assert.equal(back.description, "Renamed & checked");
  assert.deepEqual(back.miss.statics, [{ kind: "extra", id: 11, name: "Push bar" }]);
});

test("new VCFs parse back to the model they were written from", () => {
  for (const dialect of ["els-v8", "miss-els"]) {
    const config = createVcf(dialect, { extras: [1, 2, 3, 4, 5, 6, 7, 8, 9, 11], modelName: "cruiser" });
    const text = createVcfText(config);
    assert.ok(isVcfText(text));
    assert.deepEqual(parseVcf(text), config, dialect);
    assert.equal(checkVcf(config, { modelExtras: [1, 2, 3, 4, 5, 6, 7, 8, 9, 11] }).filter((entry) => entry.level === "error").length, 0);
  }
  const v8 = createVcf("els-v8", { extras: [1, 4, 7] });
  assert.deepEqual(v8.lights.filter((light) => light.controlled).map((light) => light.id), [1, 4, 7]);
  // Takedowns and scene lights work out of the box on a model that has extras 11 and 12.
  const lit = createVcf("els-v8", { extras: [1, 10, 11, 12] });
  assert.deepEqual(lit.lights.filter((light) => light.controlled).map((light) => light.id), [1, 11, 12]);
  const frame = evaluateEls(lit, { ...defaultElsPreview(), takedowns: true, scene: true }, 0, null);
  assert.deepEqual([...frame.lit].sort((a, b) => a - b), [11, 12]);
});

test("rejects files that are not VCFs or carry unreadable values", () => {
  assert.throws(() => parseVcf("<CVehicleModelInfoVarGlobal />"), VcfError);
  assert.throws(() => parseVcf("<vcfroot><EOVERRIDE>"), /XML parse error/);
  assert.throws(() => parseVcf('<vcfroot><PATTERN><PRIMARY><Flash Duration="50" Extras="1,x" /></PRIMARY></PATTERN></vcfroot>'), /Primary flash 1: "x" is not an extra number/);
  assert.throws(() => parseVcf('<vcfroot><PATTERN><PRIMARY><Flash Duration="50" Extras="13" /></PRIMARY></PATTERN></vcfroot>'), VcfError);
  assert.throws(() => parseVcf('<vcfroot><EOVERRIDE><Extra01 /><Extra01 /></EOVERRIDE><PATTERN /></vcfroot>'), /listed twice/);
  const v8 = fixture("v8-cruiser.xml");
  assert.throws(() => serializeVcf(createVcf("miss-els"), v8), /save the MISS-ELS version as a new file/);
  assert.equal(isVcfText("<CVehicleModelInfoVarGlobal />"), false);
});

test("checks report what would break in game", () => {
  const config = parseVcf(fixture("miss-patrol.xml"));
  config.miss.patterns.primary.flashes[0].duration = 0;
  config.miss.patterns.primary.flashes[1].extras = [9];
  const issues = checkVcf(config, { modelExtras: [1, 2] });
  const messages = issues.map((entry) => `${entry.level}: ${entry.message}`);
  assert.ok(messages.includes("error: Primary, flash 1: duration must be more than 0 ms."));
  assert.ok(messages.includes("warning: Primary, flash 2: extra 9 is not in EOVERRIDE, so MISS-ELS will not switch it."));
  assert.ok(messages.some((message) => message.startsWith("warning: Extra 5 is ELS-controlled but the model has no extra_5")));
  const v8 = parseVcf(fixture("v8-cruiser.xml"));
  v8.v8.primary.presets[2].pattern = "fast";
  v8.lights[0].color = "purple";
  const v8Messages = checkVcf(v8).map((entry) => entry.message);
  assert.ok(v8Messages.includes('Primary, stage 2: pattern "fast" is not a number or "scan".'));
  assert.ok(v8Messages.includes('Extra 1: "purple" is not an ELS colour (red, blue, amber, white, green).'));
  // A preset with no pattern, and warning lights told to stop at the only stage they run at.
  v8.v8.primary.presets[3].pattern = null;
  v8.v8.warning.disableAtStage3 = true;
  const more = checkVcf(v8).map((entry) => `${entry.level}: ${entry.message}`);
  assert.ok(more.includes("warning: Primary, stage 3: the preset is on but names no pattern."));
  assert.ok(more.includes("warning: Warning: Off at stage 3 is on, and warning lights run only at stage 3, so they never light."));
  assert.deepEqual(stage2Extras("2and3"), [2, 3]);
  assert.deepEqual(stage2Extras("bogus"), [1, 4]);
});

test("clones are independent of the original", () => {
  const config = parseVcf(fixture("v8-cruiser.xml"));
  const copy = cloneVcf(config);
  copy.lights[0].offset[0] = 5;
  assert.equal(config.lights[0].offset[0], -0.6);
});

// ---------------------------------------------------------------------------
// Pattern tables

test("reads ELS-FiveM pattern globals as data", () => {
  const globals = parseLuaAssignments(LEDS_LUA, "leds.lua");
  assert.deepEqual(Object.keys(globals), ["led_PrimaryPatterns", "led_SecondaryPatterns", "leds_WarningPatterns"]);
  assert.equal(globals.led_PrimaryPatterns[1][3], "1100");
  assert.throws(() => parseLuaAssignments("x = { os.exit() }", "bad.lua"), /bad\.lua 1:/);
  assert.throws(() => parseLuaAssignments("print('hi')", "bad.lua"), PatternImportError);
  assert.throws(() => parseLuaAssignments('x = { [1] = "a" @ }', "bad.lua"), /unexpected "@"/);
});

test("builds a pack with the script's polarity and step", () => {
  const pack = testPack();
  assert.equal(pack.source, "ELS-FiveM");
  assert.equal(pack.onChar, "0");
  assert.equal(pack.stepMs, 15);
  assert.deepEqual(summarizePatternPack(pack), {
    formats: { leds: { primary: 1, secondary: 1, warning: 1 }, traf: { secondary: 2 } },
    total: 5,
  });
  assert.deepEqual(lookupPattern(pack, "leds", "primary", 1).bits[1], "0011");
  assert.equal(lookupPattern(pack, "leds", "primary", 9), null);
  assert.deepEqual(patternNumbers(pack, "traf", "secondary"), [1, 2]);
  assert.throws(() => packFromElsFivem([{ name: "other.lua", text: "x = { [1] = 2 }" }]), /No ELS-FiveM pattern tables found/);
});

test("drops malformed rows and foreign packs", () => {
  const pack = normalizePatternPack({
    version: 1,
    onChar: "1",
    stepMs: 38,
    formats: { leds: { primary: { 1: { 1: "0102", 2: "11" }, x: { 1: "1" } }, bogus: { 1: { 1: "1" } } } },
  });
  assert.deepEqual(pack.formats, { leds: { primary: { 1: { 2: "11" } } } });
  assert.equal(pack.stepMs, 38);
  assert.equal(normalizePatternPack({ version: 2, formats: {} }), null);
});

test("stores and clears the imported pack", () => {
  const storage = memoryStorage();
  const pack = testPack();
  assert.deepEqual(savePatternPack(pack, storage), { ok: true, error: null });
  assert.deepEqual(loadPatternPack(storage), pack);
  savePatternPack(null, storage);
  assert.equal(loadPatternPack(storage), null);
  const full = { ...storage, setItem: () => { throw new Error("QuotaExceededError"); } };
  assert.deepEqual(savePatternPack(pack, full), { ok: false, error: "QuotaExceededError" });
});

// ---------------------------------------------------------------------------
// Playback

test("ELS V8 stages switch groups the way the V8 ports do", () => {
  const config = parseVcf(fixture("v8-cruiser.xml"));
  const pack = testPack();
  const at = (preview, ms) => evaluateEls(config, { ...defaultElsPreview(), ...preview }, ms, pack);

  const off = at({}, 0);
  assert.equal(off.running, false);
  assert.equal(off.driven.size, 0);

  // Stage 1: secondary only (traf pattern 1; "0" lights in ELS-FiveM tables).
  const one = at({ stage: 1 }, 0);
  assert.equal(one.running, true);
  assert.deepEqual([...one.lit], [7]);
  assert.equal(one.groups.secondary.source, "ELS-FiveM");
  assert.equal(one.groups.primary.active, false);
  assert.equal(at({ stage: 1 }, 15).lit.has(8), true);

  // Stage 2: primary extras 2 and 3 only (ExtrasActiveAtLstg2="2and3"), traf pattern 2.
  const two = at({ stage: 2 }, 0);
  assert.deepEqual(two.groups.primary.extras, [2, 3]);
  assert.deepEqual([...two.lit].sort(), [2, 7, 8, 9]);

  // Stage 3: every primary extra; SECL stops (DisableAtLstg3); WRNL pattern 2 runs.
  const three = at({ stage: 3 }, 0);
  assert.equal(three.groups.secondary.active, false);
  assert.equal(three.groups.warning.active, true);
  assert.deepEqual(three.groups.primary.extras, [1, 2, 3, 4]);
  assert.equal(three.sirens, true, "DfltSirenLtsActivateAtLstg=3");
  assert.equal(at({ stage: 2 }, 0).sirens, false);
  // Warning pattern 2: extra 5 "0" lit, extra 6 "1" dark.
  assert.ok(three.lit.has(5) && !three.lit.has(6));
  // Every controlled extra is ELS's while running, lit or not; 10 and 12 are not controlled.
  assert.deepEqual([...three.driven].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 11]);
});

test("primary pattern 3 is not in the pack, so it plays an approximate flash and says why", () => {
  const config = parseVcf(fixture("v8-cruiser.xml"));
  const frame = evaluateEls(config, { ...defaultElsPreview(), stage: 3 }, 0, testPack());
  assert.equal(frame.groups.primary.pattern, 3);
  assert.equal(frame.groups.primary.approximate, true);
  assert.deepEqual(elsPlaybackNotes(frame), [{ group: "primary", message: "LEDS pattern 3 is not in the imported ELS-FiveM tables." }]);
  // Left half lights first.
  assert.ok(frame.lit.has(1) && frame.lit.has(2) && !frame.lit.has(3));
  const noPack = evaluateEls(config, { ...defaultElsPreview(), stage: 1 }, 0, null);
  assert.equal(noPack.groups.secondary.reason, "No pattern tables imported.");
  // A manual pattern choice overrides the preset.
  const manual = evaluateEls(config, { ...defaultElsPreview(), stage: 3, patterns: { primary: 1 } }, 0, testPack());
  assert.equal(manual.groups.primary.approximate, false);
  assert.deepEqual([...manual.lit].filter((id) => id <= 4).sort(), [1, 2]);
});

test("a group's lane draws exactly what playback lights", () => {
  const config = parseVcf(fixture("v8-cruiser.xml"));
  const pack = testPack();
  for (const [stage, key, packed] of [[1, "secondary", pack], [3, "warning", pack], [3, "primary", pack], [2, "primary", null]]) {
    const preview = { ...defaultElsPreview(), stage };
    const lane = v8GroupLane(config, preview, key, packed);
    assert.equal(lane.approximate, !packed || key === "primary");
    for (let step = 0; step < lane.length * 2; step += 1) {
      const frame = evaluateEls(config, preview, step * lane.stepMs, packed);
      for (const row of lane.rows) {
        const drawn = row.bits[step % row.bits.length] === lane.onChar;
        assert.equal(frame.lit.has(row.extra), drawn, `${key} stage ${stage} extra ${row.extra} step ${step}`);
      }
    }
  }
  // With the lights off the lane shows stage 3; a VCF without the group has none.
  assert.equal(v8GroupLane(config, defaultElsPreview(), "warning", pack).stage, 3);
  assert.equal(v8GroupLane(createVcf("miss-els", { extras: [1] }), defaultElsPreview(), "primary", pack), null);
});

test("cruise, takedowns, steady burn and env lights", () => {
  const config = parseVcf(fixture("v8-cruiser.xml"));
  const cruise = evaluateEls(config, { ...defaultElsPreview(), cruise: true, takedowns: true, scene: true }, 0, null);
  assert.equal(cruise.running, true);
  // Cruise extras 1 and 4; takedowns on 11; scene lights allowed but extra 12 is not ELS-controlled.
  assert.deepEqual([...cruise.lit].sort((a, b) => a - b), [1, 4, 11]);
  assert.deepEqual(cruise.env.map((entry) => [entry.extra, entry.color, entry.offset]), [[1, "#ff1a1a", [-0.6, 0.1, 0.4]], [4, "#1a4dff", [0.6, 0.1, 0.4]]]);
  // Cruise stops at stage 3.
  const stage3 = evaluateEls(config, { ...defaultElsPreview(), cruise: true, stage: 3 }, 0, testPack());
  assert.equal(stage3.groups.primary.active, true);
  // Group overrides: secondary forced on at stage 0 runs.
  const forced = evaluateEls(config, { ...defaultElsPreview(), groups: { secondary: "on" } }, 0, testPack());
  assert.equal(forced.running, true);
  assert.equal(forced.groups.secondary.active, true);
});

test("MISS-ELS flashes play exactly as written", () => {
  const config = parseVcf(fixture("miss-patrol.xml"));
  const preview = { ...defaultElsPreview(), miss: { primary: true, secondary: false, rearReds: true } };
  assert.equal(elsRunning(config, preview), true);
  const lit = (ms) => [...evaluateEls(config, preview, ms).lit].sort((a, b) => a - b);
  // Primary: 100 ms extra 1, 50 off, 100 extra 2, 50 off (300 ms loop). Rear reds: 500 on 7, 500 off.
  assert.deepEqual(lit(0), [1, 7]);
  assert.deepEqual(lit(99), [1, 7]);
  assert.deepEqual(lit(100), [7]);
  assert.deepEqual(lit(150), [2, 7]);
  assert.deepEqual(lit(299), [7]);
  assert.deepEqual(lit(300), [1, 7]);
  assert.deepEqual(lit(500), [2]);
  assert.equal(missFlashAt(config.miss.patterns.primary, 160).index, 2);
  // Statics burn while switched on.
  const statics = evaluateEls(config, { ...defaultElsPreview(), statics: ["extra:11"] }, 0);
  assert.deepEqual([...statics.lit], [11]);
  assert.deepEqual([...statics.driven].sort((a, b) => a - b), [1, 2, 5, 7, 11]);
  // A pattern with no usable flashes lights nothing.
  const empty = cloneVcf(config);
  empty.miss.patterns.primary.flashes = [{ duration: 0, extras: [1], miscs: [] }];
  assert.deepEqual([...evaluateEls(empty, preview, 0).lit], [7]);
});

// ---------------------------------------------------------------------------
// Library: discovery, choices, folders, ELS-FiveM registration

import {
  elsFolderKind,
  findVcf,
  linkFor,
  loadElsFolders,
  loadElsLinks,
  decodeVcfBytes,
  encodeVcfText,
  modelNameFromPath,
  registerVcfInVcfLua,
  saveElsFolders,
  saveElsLinks,
  vcfPathIn,
  withFolder,
  withLink,
  withoutFolder,
} from "./els-library.js";

// A fake disk: { "C:/dir": [{ name, isDirectory }] } and { "C:/dir/file": text }.
function fakeFs(dirs, files) {
  return {
    readDir: async (dir) => {
      if (!dirs[dir]) throw new Error(`no access: ${dir}`);
      return dirs[dir];
    },
    readTextFile: async (file) => {
      if (!(file in files)) throw new Error(`missing: ${file}`);
      return files[file];
    },
  };
}

const VCF = '<vcfroot><EOVERRIDE /><PATTERN /></vcfroot>';

test("finds a model's VCF beside it, in its resource, then in ELS folders", async () => {
  const fs = fakeFs({
    "C:/res/stream": [{ name: "cruiser.yft" }, { name: "Cruiser.XML" }],
    "C:/res": [{ name: "stream", isDirectory: true }, { name: "vcf", isDirectory: true }],
    "C:/res/vcf": [{ name: "cruiser.xml" }],
    "F:/GTA/ELS/pack_default": [{ name: "CRUISER.xml" }],
  }, {
    "C:/res/stream/Cruiser.XML": VCF,
    "C:/res/vcf/cruiser.xml": VCF,
    "F:/GTA/ELS/pack_default/CRUISER.xml": VCF,
  });
  const modelPath = "C:/res/stream/cruiser.yft";
  assert.equal(modelNameFromPath(modelPath), "cruiser");
  assert.deepEqual(await findVcf({ modelPath, ...fs }), { path: "C:/res/stream/Cruiser.XML", text: VCF, encoding: null, origin: "model" });
  // Not beside the model: the resource's vcf folder.
  const noModelCopy = fakeFs({ ...{ "C:/res/stream": [{ name: "cruiser.yft" }], "C:/res": [{ name: "vcf", isDirectory: true }], "C:/res/vcf": [{ name: "cruiser.xml" }] } }, { "C:/res/vcf/cruiser.xml": VCF });
  assert.equal((await findVcf({ modelPath, ...noModelCopy })).origin, "resource");
  // Only in an ELS folder; an unreadable folder is skipped.
  const folderOnly = fakeFs({ "C:/res/stream": [], "F:/GTA/ELS/pack_default": [{ name: "CRUISER.xml" }] }, { "F:/GTA/ELS/pack_default/CRUISER.xml": VCF });
  const found = await findVcf({ modelPath, folders: [{ path: "X:/gone" }, { path: "F:/GTA/ELS/pack_default" }], ...folderOnly });
  assert.deepEqual(found, { path: "F:/GTA/ELS/pack_default/CRUISER.xml", text: VCF, encoding: null, origin: "folder" });
  // A linked file wins; a file that is not a VCF is passed over.
  const linked = fakeFs({ "C:/res/stream": [{ name: "cruiser.xml" }] }, { "D:/mine/custom.xml": VCF, "C:/res/stream/cruiser.xml": "<CVehicleModelInfoVarGlobal />" });
  assert.equal((await findVcf({ modelPath, linkedPath: "D:/mine/custom.xml", ...linked })).origin, "linked");
  assert.equal(await findVcf({ modelPath, ...linked }), null);
  // A reader that reports the encoding passes it through.
  const encoded = await findVcf({ modelPath, readDir: fs.readDir, readTextFile: async (file) => ({ text: await fs.readTextFile(file), encoding: "windows-1252" }) });
  assert.equal(encoded.encoding, "windows-1252");
});

test("remembers per-model choices and ELS folders", () => {
  const storage = memoryStorage();
  let links = withLink({}, "C:\\Res\\Cruiser.yft", { vcfPath: "F:/els/cruiser.xml", enabled: true }, 1);
  assert.deepEqual(linkFor(links, "c:/res/cruiser.yft"), { vcfPath: "F:/els/cruiser.xml", enabled: true, at: 1 });
  links = withLink(links, "C:/res/cruiser.yft", { enabled: false }, 2);
  assert.equal(linkFor(links, "C:/res/cruiser.yft").vcfPath, "F:/els/cruiser.xml");
  saveElsLinks(links, storage);
  assert.deepEqual(loadElsLinks(storage), links);
  let folders = withFolder([], { path: "F:/GTA/ELS/pack_default", kind: "lspdfr" });
  folders = withFolder(folders, { path: "f:/gta/els/pack_default", kind: "lspdfr" });
  assert.equal(folders.length, 1);
  saveElsFolders(folders, storage);
  assert.deepEqual(loadElsFolders(storage), folders);
  assert.deepEqual(withoutFolder(folders, "F:/GTA/ELS/pack_default"), []);
  assert.equal(elsFolderKind("F:/Grand Theft Auto V/ELS/pack_default"), "lspdfr");
  assert.equal(elsFolderKind("C:/server/resources/ELS-FiveM/vcf", { hasVcfLua: true }), "els-fivem");
  assert.equal(elsFolderKind("C:/server/resources/MISS-ELS/xmlFiles"), "miss-els");
  assert.equal(vcfPathIn("F:\\GTA\\ELS\\pack_default", "cruiser"), "F:\\GTA\\ELS\\pack_default\\cruiser.xml");
  assert.deepEqual(loadElsLinks({ getItem: () => "{not json" }), {});
});

test("registers a new VCF in ELS-FiveM's vcf.lua without touching the rest", () => {
  const text = 'vcf_files = {\r\n\t"POLICE.xml",\r\n\t"FBI.xml"\r\n}\r\n-- end\r\n';
  const { text: out, changed } = registerVcfInVcfLua(text, "cruiser.xml");
  assert.equal(changed, true);
  assert.equal(out, 'vcf_files = {\r\n\t"POLICE.xml",\r\n\t"FBI.xml",\r\n\t"cruiser.xml"\r\n}\r\n-- end\r\n');
  assert.equal(registerVcfInVcfLua(out, "CRUISER.xml").changed, false);
  assert.throws(() => registerVcfInVcfLua("return {}", "a.xml"), /no vcf_files/);
});

test("vcf.lua registration reads past comments", () => {
  // A comment after the last entry: the comma goes after the entry, not into the comment.
  const trailing = 'vcf_files = {\n    "POLICE.xml", -- stock\n    "FBI.xml" -- unmarked\n}\n';
  assert.equal(registerVcfInVcfLua(trailing, "cruiser.xml").text, 'vcf_files = {\n    "POLICE.xml", -- stock\n    "FBI.xml", -- unmarked\n    "cruiser.xml"\n}\n');
  // A commented-out example table and entry are not the list.
  const commented = '-- vcf_files = { "example.xml" }\nvcf_files = {\n    -- "cruiser.xml",\n    "FBI.xml",\n}\n';
  assert.equal(registerVcfInVcfLua(commented, "cruiser.xml").text, '-- vcf_files = { "example.xml" }\nvcf_files = {\n    -- "cruiser.xml",\n    "FBI.xml",\n    "cruiser.xml",\n}\n');
  // A long comment after the last entry is stepped over.
  const long = 'vcf_files = {\n  "FBI.xml" --[[ was\n  "OLD.xml" ]]\n}';
  assert.equal(registerVcfInVcfLua(long, "new.xml").text, 'vcf_files = {\n  "FBI.xml", --[[ was\n  "OLD.xml" ]]\n  "new.xml"\n}');
  // One that runs on to the "}" line keeps the entry inside the list.
  const onBrace = 'vcf_files = {\n    "POLICE.xml", --[[ note\n    end ]] }\n';
  assert.equal(registerVcfInVcfLua(onBrace, "SHERIFF.xml").text, 'vcf_files = {\n    "POLICE.xml", "SHERIFF.xml", --[[ note\n    end ]] }\n');
  assert.equal(registerVcfInVcfLua('vcf_files = {\n "A.xml" --[[ a\n b ]] }', "B.xml").text, 'vcf_files = {\n "A.xml", "B.xml" --[[ a\n b ]] }');
  // One-line and empty lists.
  assert.equal(registerVcfInVcfLua('vcf_files = { "a.xml", "b.xml" }', "c.xml").text, 'vcf_files = { "a.xml", "b.xml", "c.xml" }');
  assert.equal(registerVcfInVcfLua("vcf_files = {}", "c.xml").text, 'vcf_files = { "c.xml" }');
  assert.equal(registerVcfInVcfLua("vcf_files = {\n}\n", "c.xml").text, 'vcf_files = {\n    "c.xml",\n}\n');
  // Listed in other casing: reported, not added twice.
  assert.deepEqual(registerVcfInVcfLua('vcf_files = { "FBI.xml" }', "fbi.xml"), { text: 'vcf_files = { "FBI.xml" }', changed: false, listedAs: "FBI.xml" });
  assert.throws(() => registerVcfInVcfLua('-- vcf_files = { "a.xml" }', "a.xml"), /no vcf_files/);
});

test("files keep their encoding and BOM from read to write", () => {
  // <vcfroot A="é€"/> saved as ANSI.
  const ansi = Uint8Array.from([0x3c, 0x76, 0x63, 0x66, 0x72, 0x6f, 0x6f, 0x74, 0x20, 0x41, 0x3d, 0x22, 0xe9, 0x80, 0x22, 0x2f, 0x3e]);
  const read = decodeVcfBytes(ansi);
  assert.deepEqual(read, { text: '<vcfroot A="é€"/>', encoding: "windows-1252" });
  assert.deepEqual(encodeVcfText(read.text, read.encoding), ansi);
  assert.throws(() => encodeVcfText("✓", "windows-1252"), /ANSI/);
  const bom = Uint8Array.from([0xef, 0xbb, 0xbf, 0x3c, 0x61, 0x2f, 0x3e]);
  const utf8 = decodeVcfBytes(bom);
  assert.deepEqual(utf8, { text: "﻿<a/>", encoding: "utf-8" });
  assert.deepEqual(encodeVcfText(utf8.text, utf8.encoding), bom);
});

test("ELS-FiveM CHP mode plays one table per stage across extras 1-10", () => {
  const config = createVcf("els-v8", { extras: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
  for (const key of ["primary", "secondary", "warning"]) config.v8[key].format = "chp";
  config.lights.find((light) => light.id === 10).controlled = true;
  const pack = packFromElsFivem([{ name: "chp.lua", text: 'chp_StageOne = { [1] = { [1] = "0", [2] = "1", [5] = "0", [6] = "1", [10] = "0" } }' }], { path: "C:/els" });
  const frame = evaluateEls(config, { ...defaultElsPreview(), stage: 1 }, 0, pack);
  assert.deepEqual([...frame.lit].sort((a, b) => a - b), [1, 5, 10]);
  assert.equal(frame.groups.warning.active, true);
  assert.equal(frame.groups.primary.active, false);
  // One group on another format: the usual per-group stages again.
  config.v8.secondary.format = "leds";
  assert.equal(evaluateEls(config, { ...defaultElsPreview(), stage: 1 }, 0, pack).groups.warning.active, false);
});

test("switches the VCF does not allow do not take the extras over", () => {
  const config = createVcf("els-v8", { extras: [1, 2, 11] });
  config.v8.misc.takedowns.allow = false;
  const preview = { ...defaultElsPreview(), takedowns: true };
  assert.equal(elsRunning(config, preview), false);
  config.v8.misc.takedowns.allow = true;
  assert.equal(elsRunning(config, preview), true);
  assert.equal(elsAnimates(config, preview), false, "a steady takedown needs no frame loop");
  assert.equal(elsAnimates(config, { ...preview, stage: 3 }), true);
});

test("a switch the panels disable is one that would light nothing", () => {
  const config = createVcf("els-v8", { extras: [1, 2, 11] });
  config.v8.misc.sceneLights.allow = false;
  let blocks = elsSwitchBlocks(config);
  assert.equal(blocks.takedowns, null);
  assert.equal(blocks.scene, "Scene lights are off in MISC");
  config.v8.misc.sceneLights.allow = true;
  assert.equal(elsSwitchBlocks(config).scene, "Extra 12 is not ELS-controlled");
  config.lights.find((light) => light.kind === "extra" && light.id === 11).controlled = false;
  assert.equal(elsSwitchBlocks(config).takedowns, "Extra 11 is not ELS-controlled");
  config.lights.find((light) => light.kind === "extra" && light.id === 11).controlled = true;
  // The playback agrees: a blocked switch never takes the extras over.
  blocks = elsSwitchBlocks(config);
  for (const key of ["takedowns", "scene"]) {
    assert.equal(elsRunning(config, { ...defaultElsPreview(), [key]: true }), blocks[key] === null, key);
  }
  config.v8.cruise = null;
  assert.equal(elsSwitchBlocks(config).cruise, "The VCF has no cruise section");

  const miss = createVcf("miss-els", { extras: [1, 2, 3, 4] });
  miss.miss.patterns.rearReds.flashes = [];
  const missBlocks = elsSwitchBlocks(miss);
  assert.equal(missBlocks.miss.primary, null);
  assert.equal(missBlocks.miss.rearReds, "This pattern has no flashes");
  assert.equal(elsSwitchBlocks(null).miss.primary, "This pattern has no flashes");
});

test("the VCF change list names the lights and sections an edit changed", () => {
  const base = parseVcf(fixture("v8-cruiser.xml"));
  const draft = cloneVcf(base);
  draft.description = "Test cruiser 2";
  ensureLight(draft, "misc", "k");
  draft.lights.find((light) => light.kind === "extra" && light.id === 1).color = "blue";
  draft.lights.find((light) => light.kind === "extra" && light.id === 2).color = "blue";
  draft.v8.primary.presets[3].pattern = 7;
  draft.v8.misc.steadyBurn = true;
  assert.deepEqual(describeVcfChanges(base, draft), [
    "Description Test cruiser → Test cruiser 2",
    "Added Misc K",
    "Extra 1, Extra 2: colour red → blue",
    "Primary: stage 3 pattern 3 → 7",
    "Misc: steady burn off → on",
  ]);
  assert.deepEqual(describeVcfChanges(base, cloneVcf(base)), []);

  const miss = parseVcf(fixture("miss-patrol.xml"));
  const edited = cloneVcf(miss);
  edited.miss.patterns.primary.flashHighBeam = true;
  edited.miss.patterns.primary.flashes[1].duration = 80;
  edited.miss.patterns.primary.flashes[3].duration = 80;
  const rear = edited.miss.patterns.rearReds.flashes.length;
  edited.miss.patterns.rearReds.flashes.push({ duration: 100, extras: [], miscs: [] });
  edited.miss.statics[0].name = "Bumper";
  assert.deepEqual(describeVcfChanges(miss, edited), [
    "Primary: flash high beam off → on, flashes 2, 4",
    `Rear reds: flashes ${rear} → ${rear + 1}`,
    "Statics: renamed Extra 11",
  ]);

  const fresh = describeVcfChanges(null, createVcf("els-v8", { extras: [1, 2, 3, 4] }));
  assert.equal(fresh[0], "New ELS V8 VCF, not saved to a file yet.");
  assert.match(fresh[1], /^\d+ lights? under ELS control$/);
});
