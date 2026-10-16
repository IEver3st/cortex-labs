import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  SIREN_FACINGS,
  SIREN_PALETTE,
  TRAFFIC_ADVISOR_MODES,
  facingFromDelta,
  patternFromSequencer,
  trafficAdvisorSequencers,
} from "./siren-settings.js";
import { backupPathFor, linkVariationSirenSetting } from "./siren-install.js";
import { buildUlcTable, defaultUlcConfig, findUlcConfig, normalizeUlcConfig, parseLuaTable, serializeLua, upsertUlcConfig } from "./ulc-config.js";
import { checkModelName, modelNameWarning, planStreamRenames, planVehicleRename, renameInLuaText, renameInMetaText } from "./vehicle-rename.js";
import { parseCarvariationsMeta } from "./vehicle-meta.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "meta");
const policeVariations = () => readFileSync(path.join(FIXTURES, "police", "carvariations.meta"), "utf8");

// --- traffic advisor ---------------------------------------------------------

test("traffic advisor arrows build across the heads and go dark together", () => {
  const rows = trafficAdvisorSequencers(4, "build-forward").map(patternFromSequencer);
  assert.equal(rows.length, 4);
  // Two 16-step sweeps per loop.
  for (const row of rows) assert.equal(row.slice(0, 16), row.slice(16));
  assert.equal(rows[0].slice(0, 16), "1111111111111100");
  assert.equal(rows[3].slice(0, 16), "0000000001111100");
  const onsets = rows.map((row) => row.indexOf("1"));
  assert.deepEqual(onsets, [...onsets].sort((a, b) => a - b));
  const back = trafficAdvisorSequencers(4, "build-back").map(patternFromSequencer);
  assert.deepEqual(back, [...rows].reverse());
});

test("centre-out arrows light the middle heads first", () => {
  const rows = trafficAdvisorSequencers(5, "build-centre").map(patternFromSequencer);
  const onsets = rows.map((row) => row.indexOf("1"));
  assert.ok(onsets[2] < onsets[1] && onsets[1] === onsets[3] && onsets[0] === onsets[4] && onsets[1] < onsets[0]);
});

test("a chase lights one head at a time, and warn alternates halves", () => {
  const rows = trafficAdvisorSequencers(4, "chase-forward").map(patternFromSequencer);
  for (let step = 0; step < 32; step += 1) {
    assert.equal(rows.filter((row) => row[step] === "1").length, 1, `step ${step}`);
  }
  const many = trafficAdvisorSequencers(32, "chase-forward", { period: 16 }).map(patternFromSequencer);
  assert.ok(many.every((row) => row.includes("1")), "every head lights when there are more heads than steps");
  const warn = trafficAdvisorSequencers(4, "warn").map(patternFromSequencer);
  assert.equal(warn[0].slice(0, 16), "1111111100000000");
  assert.equal(warn[3].slice(0, 16), "0000000011111111");
});

test("traffic advisor rejects nonsense", () => {
  assert.deepEqual(trafficAdvisorSequencers(0, "warn"), []);
  assert.deepEqual(trafficAdvisorSequencers(4, "sideways"), []);
  assert.equal(trafficAdvisorSequencers(99, "warn").length, 32);
  assert.equal(TRAFFIC_ADVISOR_MODES.length, 6);
});

// --- palette and facings -----------------------------------------------------

test("palette colours are distinct lowercase hex", () => {
  assert.equal(SIREN_PALETTE.length, 6);
  assert.equal(new Set(SIREN_PALETTE.map((entry) => entry.color)).size, 6);
  for (const entry of SIREN_PALETTE) assert.match(entry.color, /^#[0-9a-f]{6}$/);
});

test("facings follow the delta convention: 0 front, +90 left", () => {
  const rad = (degrees) => (degrees * Math.PI) / 180;
  assert.equal(facingFromDelta(0).id, "front");
  assert.equal(facingFromDelta(rad(90)).id, "left");
  assert.equal(facingFromDelta(rad(-90)).id, "right");
  assert.equal(facingFromDelta(Math.PI).id, "rear");
  assert.equal(facingFromDelta(-Math.PI).id, "rear");
  assert.equal(facingFromDelta(rad(225)).id, "rear-right");
  assert.equal(facingFromDelta(rad(30)), null);
  assert.equal(facingFromDelta(Number.NaN), null);
  assert.deepEqual(SIREN_FACINGS.map((facing) => facing.cell).sort(), [0, 1, 2, 3, 5, 6, 7, 8]);
});

// --- carvariations link ------------------------------------------------------

const VARIATIONS = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  "<CVehicleModelInfoVariation>",
  "  <variationData>",
  "    <Item>",
  "      <modelName>fpiu25</modelName>",
  "      <colors />",
  '      <lightSettings value="1" />',
  "      <!-- keep me -->",
  "    </Item>",
  "    <Item>",
  "      <modelName>other</modelName>",
  '      <sirenSettings value="7"/>',
  "    </Item>",
  "  </variationData>",
  "</CVehicleModelInfoVariation>",
  "",
].join("\r\n");

test("linking adds sirenSettings after lightSettings and keeps the rest", () => {
  const { text, mode, previous } = linkVariationSirenSetting(VARIATIONS, "FPIU25", 2025);
  assert.equal(mode, "added");
  assert.equal(previous, null);
  assert.ok(text.includes('<lightSettings value="1" />\r\n      <sirenSettings value="2025" />\r\n      <!-- keep me -->'));
  assert.equal(text.replace('\r\n      <sirenSettings value="2025" />', ""), VARIATIONS);
  const parsed = parseCarvariationsMeta(text).variations;
  assert.equal(parsed.find((entry) => entry.modelName === "fpiu25").sirenSettings, 2025);
});

test("linking rewrites only the value of an existing sirenSettings", () => {
  const { text, mode, previous } = linkVariationSirenSetting(VARIATIONS, "other", 12);
  assert.equal(mode, "updated");
  assert.equal(previous, 7);
  assert.equal(text, VARIATIONS.replace('<sirenSettings value="7"/>', '<sirenSettings value="12"/>'));
  assert.equal(linkVariationSirenSetting(VARIATIONS, "other", 7).mode, "unchanged");
});

test("linking a real fixture round-trips", () => {
  const source = policeVariations();
  const model = parseCarvariationsMeta(source).variations[0].modelName;
  const { text } = linkVariationSirenSetting(source, model, 4242);
  assert.equal(parseCarvariationsMeta(text).variations[0].sirenSettings, 4242);
});

test("linking refuses the wrong file, an unknown model and a bad id", () => {
  assert.throws(() => linkVariationSirenSetting("<CVehicleModelInfoVarGlobal />", "x", 1), /carvariations root/);
  assert.throws(() => linkVariationSirenSetting(VARIATIONS, "missing", 1), /no entry for missing/);
  assert.throws(() => linkVariationSirenSetting(VARIATIONS, "fpiu25", -1), /whole number/);
});

test("backups sit beside the file with a timestamp", () => {
  assert.equal(backupPathFor("C:/res/data/carcols.meta", new Date(2026, 9, 8, 9, 5, 3)), "C:/res/data/carcols.meta.20261008-090503.bak");
});

// --- ULC writer ----------------------------------------------------------------

test("serializeLua writes data the ULC reader reads back", () => {
  const value = { names: ["a", "b"], nested: { flag: true, list: [1, 2] }, ["weird key"]: "q\"uote\\n", end: null };
  assert.deepEqual(parseLuaTable(`return ${serializeLua(value)}`), { names: ["a", "b"], nested: { flag: true, list: [1, 2] }, "weird key": "q\"uote\\n", end: null });
  assert.throws(() => serializeLua({ bad: Number.NaN }), /non-finite/);
});

const EXISTING_ULC = `-- my notes
return {
  names = {"fpiu25", "fpiu20"},
  parkConfig = { usePark = true, useSync = true, syncWith = {"fpiu20"}, pExtras = {10}, dExtras = {11} },
  brakeConfig = { useBrakes = true, speedThreshold = 3, brakeExtras = {12}, disableExtras = {} },
  doorConfig = { useDoors = true, driverSide = { enable = {}, disable = {1} } },
  buttons = {
    { label = "STAGE 2", key = 2, color = "green", extra = 2, linkedExtras = {}, oppositeExtras = {}, offExtras = {}, repair = true },
  },
}`;

test("upserting keeps fields the builder does not model", () => {
  const current = findUlcConfig(EXISTING_ULC, "fpiu25");
  const next = { ...current, brake: { ...current.brake, extras: [12, 9] }, buttons: [{ ...current.buttons[0], label: "Stage 2" }] };
  const { text, mode } = upsertUlcConfig(EXISTING_ULC, "fpiu25", next);
  assert.equal(mode, "replaced");
  const raw = parseLuaTable(text);
  assert.equal(raw.parkConfig.useSync, true);
  assert.deepEqual(raw.parkConfig.syncWith, ["fpiu20"]);
  assert.equal(raw.brakeConfig.speedThreshold, 3);
  assert.deepEqual(raw.brakeConfig.brakeExtras, [9, 12]);
  assert.deepEqual(raw.doorConfig.driverSide.disable, [1]);
  assert.equal(raw.buttons[0].repair, true);
  assert.equal(raw.buttons[0].label, "Stage 2");
  assert.deepEqual(normalizeUlcConfig(raw).names, ["fpiu25", "fpiu20"]);
});

test("upserting another vehicle turns one config into a list", () => {
  const { text, mode } = upsertUlcConfig(EXISTING_ULC, "slicktop", defaultUlcConfig("slicktop", [1], { 1: { sirens: [1] } }));
  assert.equal(mode, "added");
  const list = parseLuaTable(text);
  assert.equal(list.length, 2);
  assert.ok(findUlcConfig(text, "fpiu20"));
  assert.equal(findUlcConfig(text, "slicktop").buttons[0].extra, 1);
});

test("a new ulc.lua holds one config with buttons for lit extras", () => {
  const config = defaultUlcConfig("FPIU25", [1, 2, 3, 4], { 1: { sirens: [1, 2] }, 4: { sirens: [], steady: true } });
  assert.deepEqual(config.buttons.map((button) => [button.extra, button.key]), [[1, 1], [4, 2]]);
  const { text, mode } = upsertUlcConfig("", "fpiu25", config);
  assert.equal(mode, "created");
  assert.ok(text.startsWith("-- Ultimate Lighting Controller config\nreturn {"));
  assert.deepEqual(findUlcConfig(text, "fpiu25").names, ["fpiu25"]);
  assert.equal(buildUlcTable({ ...config, buttons: [{ extra: 1, color: "pink" }] }).buttons[0].color, "green");
});

// --- vehicle renamer ---------------------------------------------------------

test("model names are checked", () => {
  assert.equal(checkModelName("pd_fpiu", "fpiu25"), "");
  assert.match(checkModelName("", "x"), /Enter/);
  assert.match(checkModelName("pd fpiu", "x"), /letters, digits/);
  assert.match(checkModelName("car_hi", "x"), /_hi/);
  assert.match(checkModelName("FPIU25", "fpiu25"), /already/);
  assert.equal(modelNameWarning("pd_fpiu"), "");
  assert.match(modelNameWarning("pd_fpiu_2025x"), /11 characters/);
});

test("meta renames whole element text only, keeping case", () => {
  const text = "<modelName>fpiu25</modelName><gameName>FPIU25</gameName><txdName> fpiu25 </txdName><kitName>fpiu25_modkit</kitName><modelName>fpiu25_bumf</modelName>";
  const result = renameInMetaText(text, "fpiu25", "pd_fpiu");
  assert.equal(result.count, 3);
  assert.equal(result.text, "<modelName>pd_fpiu</modelName><gameName>PD_FPIU</gameName><txdName> pd_fpiu </txdName><kitName>fpiu25_modkit</kitName><modelName>fpiu25_bumf</modelName>");
});

test("Lua renames exact string literals", () => {
  const result = renameInLuaText(`names = {"fpiu25", 'fpiu25x'}\nAddTextEntry('FPIU25', "fpiu25 police")`, "fpiu25", "pd_fpiu");
  assert.equal(result.count, 2);
  assert.equal(result.text, `names = {"pd_fpiu", 'fpiu25x'}\nAddTextEntry('PD_FPIU', "fpiu25 police")`);
});

test("stream renames cover the model and its dictionaries", () => {
  const renames = planStreamRenames([
    "C:/res/stream/fpiu25.yft",
    "C:/res/stream/fpiu25_hi.yft",
    "C:/res/stream/fpiu25.ytd",
    "C:/res/stream/fpiu25+hi.ytd",
    "C:/res/stream/fpiu25_bumf.yft",
    "C:/res/stream/fpiu25.ycd",
  ], "fpiu25", "pd_fpiu");
  assert.deepEqual(renames.map((entry) => entry.to), [
    "C:/res/stream/pd_fpiu.yft",
    "C:/res/stream/pd_fpiu_hi.yft",
    "C:/res/stream/pd_fpiu.ytd",
    "C:/res/stream/pd_fpiu+hi.ytd",
  ]);
});

test("a rename plan lists edits, skips binary scripts and the manifest, and refuses clashes", () => {
  const files = [
    { path: "C:/res/data/vehicles.meta", text: "<modelName>fpiu25</modelName><txdName>fpiu25</txdName>" },
    { path: "C:/res/data/handling.meta", text: "<handlingName>FPIU25</handlingName>" },
    { path: "C:/res/data/carcols.meta", text: "<kitName>fpiu25_modkit</kitName>" },
    { path: "C:/res/ulc.lua", text: 'return { names = {"fpiu25"} }' },
    { path: "C:/res/fxmanifest.lua", text: "files { 'fpiu25' }" },
    { path: "C:/res/client.lua", text: "FXAP\u0000\u0001" },
  ];
  const streamPaths = ["C:/res/stream/fpiu25.yft", "C:/res/stream/fpiu25_hi.yft"];
  const plan = planVehicleRename({ files, streamPaths, from: "fpiu25", to: "pd_fpiu" });
  assert.equal(plan.error, "");
  assert.deepEqual(plan.edits.map((edit) => [edit.path, edit.count, edit.kind]), [
    ["C:/res/data/vehicles.meta", 2, "meta"],
    ["C:/res/data/handling.meta", 1, "meta"],
    ["C:/res/ulc.lua", 1, "script"],
  ]);
  assert.deepEqual(plan.skipped, ["C:/res/client.lua"]);
  assert.equal(plan.renames.length, 2);
  assert.match(planVehicleRename({ files, streamPaths, takenNames: ["PD_FPIU"], from: "fpiu25", to: "pd_fpiu" }).error, /already called/);
  assert.match(planVehicleRename({ files, streamPaths: [...streamPaths, "C:/res/stream/pd_fpiu.yft"], from: "fpiu25", to: "pd_fpiu" }).error, /already exists/);
  assert.match(planVehicleRename({ files: [], streamPaths: [], from: "fpiu25", to: "pd_fpiu" }).error, /Nothing in this resource/);
});
