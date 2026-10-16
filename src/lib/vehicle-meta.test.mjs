import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  classifyMetaPath,
  findMetaFilesForModel,
  loadResourceMeta,
  parseCarcolsMeta,
  parseCarvariationsMeta,
  parseVehiclesMeta,
  scanResourceForIds,
  simulateVehicle,
} from "./vehicle-meta.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "meta");

function fixture(...parts) {
  const filePath = path.join(FIXTURES, ...parts);
  return { path: filePath, text: readFileSync(filePath, "utf8") };
}

function loadFolder(folder, names) {
  return loadResourceMeta(names.map((name) => fixture(folder, name)));
}

function codes(sim) {
  return sim.warnings.map((warning) => warning.code);
}

test("parseVehiclesMeta reads init data, flags and txd relationships", () => {
  const file = fixture("police", "vehicles.meta");
  const parsed = parseVehiclesMeta(file.text, file.path);
  assert.equal(parsed.residentTxd, "vehshare");
  assert.equal(parsed.vehicles.length, 1);
  const police = parsed.vehicles[0];
  assert.equal(police.modelName, "police");
  assert.equal(police.txdName, "police");
  assert.equal(police.handlingId, "POLICE");
  assert.equal(police.vehicleMakeName, "VAPID");
  assert.equal(police.layout, "LAYOUT_STANDARD");
  assert.equal(police.type, "VEHICLE_TYPE_CAR");
  assert.equal(police.plateType, "VPT_FRONT_AND_BACK_PLATES");
  assert.equal(police.wheelType, "VWT_MUSCLE");
  assert.ok(police.flags.includes("FLAG_HAS_LIVERY"));
  assert.deepEqual(police.liveryFlags, { hasLivery: true, liveryMatchExtra: false });
  assert.deepEqual(police.extrasFlags, { require: true, strong: true });
  assert.equal(police.sourcePath, file.path);
  assert.deepEqual(parsed.txdRelationships, [{ parent: "vehicles_police_interior", child: "police" }]);
});

test("parseCarvariationsMeta reads colours, liveries, kits, plates and settings", () => {
  const file = fixture("police", "carvariations.meta");
  const parsed = parseCarvariationsMeta(file.text, file.path);
  assert.equal(parsed.variations.length, 1);
  const variation = parsed.variations[0];
  assert.equal(variation.modelName, "police");
  assert.equal(variation.colors.length, 2);
  assert.deepEqual(variation.colors[0].indices, [111, 0, 0, 156]);
  assert.deepEqual(variation.colors[0].liveries, [true, true, true, true, false, false, false, false]);
  assert.deepEqual(variation.colors[1].indices, [12, 134, 4, 156, 0, 0]);
  assert.deepEqual(variation.kits, ["0_default_modkit"]);
  assert.deepEqual(variation.plateProbabilities, [{ name: "Standard White", value: 100 }]);
  assert.equal(variation.lightSettings, 0);
  assert.equal(variation.sirenSettings, 1);
});

test("parseCarcolsMeta reads kits, lights, sirens and colour lists", () => {
  const kitsFile = fixture("mycar", "carcols.meta");
  const kits = parseCarcolsMeta(kitsFile.text, kitsFile.path);
  assert.equal(kits.kits.length, 1);
  const kit = kits.kits[0];
  assert.equal(kit.kitName, "1337_mycar_modkit");
  assert.equal(kit.id, 1337);
  assert.equal(kit.kitType, "MKT_STANDARD");
  assert.equal(kit.visibleMods.length, 3);
  assert.equal(kit.visibleMods[0].type, "VMT_LIVERY_MOD");
  assert.equal(kit.visibleMods[0].modShopLabel, "MYCAR_LIV1");
  assert.deepEqual(kit.visibleMods[1].linkedModels, ["mycar_livery2_wing"]);
  assert.deepEqual(kit.visibleMods[2].turnOffBones, ["misc_a"]);
  assert.equal(kit.visibleMods[2].bone, "boot");
  assert.equal(kit.visibleMods[2].weight, 20);
  assert.equal(kit.visibleMods[2].allowBonnetSlide, true);
  assert.equal(kit.statMods.length, 1);
  assert.equal(kit.statMods[0].type, "VMT_ENGINE");
  assert.deepEqual(kit.liveryNames, ["MYCAR_LIV1", "MYCAR_LIV2"]);

  const sirensFile = fixture("police", "carcols.meta");
  const sirens = parseCarcolsMeta(sirensFile.text, sirensFile.path);
  assert.equal(sirens.lights.length, 1);
  assert.equal(sirens.lights[0].id, 0);
  assert.equal(sirens.lights[0].indicator.color, "#ff8000");
  assert.equal(sirens.sirens.length, 1);
  assert.equal(sirens.sirens[0].id, 1);
  assert.equal(sirens.sirens[0].name, "police");
  assert.equal(sirens.sirens[0].sequencerBpm, 600);
  assert.equal(sirens.sirens[0].lightFalloffMax, 50);
  assert.equal(sirens.sirens[0].sirenCount, 2);

  const colorsFile = fixture("colors", "carcols.meta");
  const colors = parseCarcolsMeta(colorsFile.text, colorsFile.path);
  assert.equal(colors.colors.length, 2);
  assert.deepEqual(colors.colors.map((entry) => entry.color), ["#0d1116", "#123456"]);
  assert.equal(colors.colors[0].metallicID, "EVehicleModelColorMetallic_normal");
  assert.equal(colors.colors[0].audioColor, "POLICE_SCANNER_COLOUR_black");
});

test("parsers reject the wrong root element", () => {
  const file = fixture("police", "carcols.meta");
  assert.throws(() => parseVehiclesMeta(file.text, "x/carcols.meta"), /expected <CVehicleModelInfo__InitDataList>/);
});

test("loadResourceMeta classifies by root element and collects parse errors", () => {
  const meta = loadResourceMeta([
    { path: "stream/data/anything.meta", text: fixture("police", "vehicles.meta").text },
    fixture("police", "carvariations.meta"),
    fixture("police", "carcols.meta"),
    { path: "data/handling.meta", text: "<CHandlingDataMgr><HandlingData /></CHandlingDataMgr>" },
    { path: "data/broken.meta", text: "<CVehicleModelInfoVariation><variationData>" },
    { path: "data/other.meta", text: "<SomethingElse />" },
    { path: "data/binary.ytd", text: null },
  ]);
  assert.deepEqual(
    meta.sources.map((source) => source.kind),
    ["vehicles", "carvariations", "carcols", "handling", "unknown"],
  );
  assert.equal(meta.vehicles.length, 1);
  assert.equal(meta.variations.length, 1);
  assert.equal(meta.sirens.length, 1);
  assert.deepEqual(meta.residentTxds, ["vehshare"]);
  assert.equal(meta.errors.length, 2);
  assert.equal(meta.errors[0].path, "data/broken.meta");
  assert.match(meta.errors[0].message, /unterminated/);
  assert.equal(meta.errors[1].path, "data/binary.ytd");
});

test("findMetaFilesForModel filters by filename including prefixed names", () => {
  const paths = [
    "C:\\res\\data\\vehicles.meta",
    "C:\\res\\data\\police_carcols.meta",
    "/srv/res/data/Police-CarVariations.META",
    "/srv/res/data/sheriff.handling.meta",
    "/srv/res/stream/police.yft",
    "/srv/res/data/vehiclelayouts.meta",
    "/srv/res/fxmanifest.lua",
  ];
  assert.deepEqual(findMetaFilesForModel(paths), paths.slice(0, 4));
  assert.equal(classifyMetaPath("x/police_carcols.meta"), "carcols");
  assert.equal(classifyMetaPath("x/vehiclelayouts.meta"), null);
  assert.deepEqual(findMetaFilesForModel(null), []);
});

test("police: texture liveries with FLAG_HAS_LIVERY and four liveries", () => {
  const meta = loadFolder("police", ["vehicles.meta", "carvariations.meta", "carcols.meta"]);
  const sim = simulateVehicle(meta, "police");
  assert.deepEqual(sim.found, { vehicles: true, variations: true });
  assert.equal(sim.liverySystem, "texture");
  assert.equal(sim.textureLiveries.enabled, true);
  assert.equal(sim.textureLiveries.count, 4);
  assert.deepEqual(sim.textureLiveries.expectedTextureNames, [
    "police_sign_1",
    "police_sign_2",
    "police_sign_3",
    "police_sign_4",
  ]);
  assert.ok(sim.textureLiveries.textures.every((texture) => texture.found === null));
  assert.equal(sim.modkitLiveries.count, 0);
  assert.deepEqual(sim.modkitLiveries.kitNames, ["0_default_modkit"]);
  assert.deepEqual(sim.extras.flags, { require: true, strong: true });
  assert.match(sim.extras.note, /REQUIRE/);
  assert.match(sim.extras.note, /STRONG/);
  assert.equal(sim.plate.type, "VPT_FRONT_AND_BACK_PLATES");
  assert.deepEqual(sim.plate.probabilities, [{ name: "Standard White", value: 100 }]);
  assert.equal(sim.wheels.type, "VWT_MUSCLE");
  assert.deepEqual(sim.txd, { txdName: "police", parentChain: ["vehicles_police_interior"] });
  assert.deepEqual(sim.ids.kitIds, []);
  assert.deepEqual(sim.ids.sirenIds, [1]);
  assert.deepEqual(sim.ids.lightIds, [0]);
  assert.deepEqual(codes(sim), []);
});

test("livery slots preserve disabled gaps and use the model's shader texture prefix", () => {
  const meta = loadFolder("police", ["vehicles.meta", "carvariations.meta"]);
  meta.variations[0].colors[0].liveries = [true, false, true];
  const sim = simulateVehicle(meta, "police", {
    liveryTexturePrefix: "policenew", availableTextureNames: ["policenew_sign_1", "policenew_sign_3"],
  });
  assert.equal(sim.textureLiveries.count, 2);
  assert.deepEqual(sim.textureLiveries.slotIndices, [0, 2]);
  assert.deepEqual(sim.textureLiveries.expectedTextureNames, ["policenew_sign_1", "policenew_sign_3"]);
  assert.ok(sim.textureLiveries.textures.every((texture) => texture.found));
});

test("police: colour presets resolve from the vanilla table, 6-slot rows include interior", () => {
  const meta = loadFolder("police", ["vehicles.meta", "carvariations.meta"]);
  const sim = simulateVehicle(meta, "police");
  assert.equal(sim.colorPresets.length, 2);
  const first = sim.colorPresets[0];
  assert.equal(first.index, 0);
  assert.deepEqual(first.primary, { index: 111, hex: "#f8f8f8", name: "Metallic White", finish: 2, known: true });
  assert.deepEqual(first.secondary, { index: 0, hex: "#323232", name: "Metallic Black", finish: 1, known: true });
  assert.equal(first.pearlescent.index, 0);
  assert.deepEqual(first.wheels, { index: 156, hex: "#8a8c90", name: "Default Alloy", finish: 1, known: true });
  assert.equal(first.interior, undefined);
  const second = sim.colorPresets[1];
  assert.equal(second.primary.name, "Matte Black");
  assert.equal(second.secondary.hex, "#ffffff");
  assert.equal(second.interior.index, 0);
  assert.equal(second.dashboard.index, 0);
});

test("police: missing YTD textures produce LIVERY_TEXTURES_MISSING", () => {
  const meta = loadFolder("police", ["vehicles.meta", "carvariations.meta", "carcols.meta"]);
  const sim = simulateVehicle(meta, "police", {
    availableTextureNames: ["POLICE_SIGN_1", "police_sign_2", "police_sign_4", "police_lightsemissive"],
  });
  assert.deepEqual(
    sim.textureLiveries.textures.map((texture) => texture.found),
    [true, true, false, true],
  );
  const warning = sim.warnings.find((entry) => entry.code === "LIVERY_TEXTURES_MISSING");
  assert.ok(warning);
  assert.equal(warning.severity, "error");
  assert.match(warning.message, /police_sign_3/);
  assert.ok(warning.fix);
});

test("mycar: mod kit liveries linked through carvariations kits", () => {
  const meta = loadFolder("mycar", ["vehicles.meta", "carvariations.meta", "carcols.meta"]);
  const sim = simulateVehicle(meta, "mycar");
  assert.equal(sim.liverySystem, "modkit");
  assert.equal(sim.textureLiveries.enabled, false);
  assert.equal(sim.textureLiveries.count, 0);
  assert.deepEqual(sim.textureLiveries.expectedTextureNames, []);
  assert.equal(sim.modkitLiveries.count, 2);
  assert.deepEqual(sim.modkitLiveries.kitNames, ["1337_mycar_modkit"]);
  assert.equal(sim.modkitLiveries.kits.length, 1);
  assert.equal(sim.modkitLiveries.kits[0].id, 1337);
  assert.deepEqual(sim.modkitLiveries.kits[0].liveryMods, [
    { modelName: "mycar_livery1", modShopLabel: "MYCAR_LIV1", linkedModels: [] },
    { modelName: "mycar_livery2", modShopLabel: "MYCAR_LIV2", linkedModels: ["mycar_livery2_wing"] },
  ]);
  assert.deepEqual(sim.modkitLiveries.kits[0].liveryNames, ["MYCAR_LIV1", "MYCAR_LIV2"]);
  assert.deepEqual(sim.ids.kitIds, [1337]);
  assert.deepEqual(sim.extras.flags, { script: true });
  assert.deepEqual(sim.txd.parentChain, ["mycar_shared"]);
  const warningCodes = codes(sim);
  assert.ok(warningCodes.includes("COLOR_INDEX_INVALID"), warningCodes.join(","));
  assert.ok(warningCodes.includes("TXD_PARENT_UNRESOLVED"), warningCodes.join(","));
  assert.ok(!warningCodes.includes("MODKIT_NOT_LINKED"));
  assert.equal(sim.colorPresets[1].primary.known, false);
  assert.equal(sim.colorPresets[1].primary.hex, "#aaaaaa");
});

test("mycar: kit not referenced from carvariations produces MODKIT_NOT_LINKED", () => {
  const variations = fixture("mycar", "carvariations.meta");
  const meta = loadResourceMeta([
    fixture("mycar", "vehicles.meta"),
    { path: variations.path, text: variations.text.replace("<Item>1337_mycar_modkit</Item>", "<Item>0_default_modkit</Item>") },
    fixture("mycar", "carcols.meta"),
  ]);
  const sim = simulateVehicle(meta, "mycar");
  assert.equal(sim.liverySystem, "none");
  assert.equal(sim.modkitLiveries.count, 0);
  const warning = sim.warnings.find((entry) => entry.code === "MODKIT_NOT_LINKED");
  assert.ok(warning);
  assert.equal(warning.severity, "error");
  assert.match(warning.fix, /1337_mycar_modkit/);
});

test("broken: liveries listed without FLAG_HAS_LIVERY and siren id above 255", () => {
  const meta = loadFolder("broken", ["vehicles.meta", "carvariations.meta"]);
  const sim = simulateVehicle(meta, "sheriff3");
  assert.equal(sim.liverySystem, "texture");
  assert.equal(sim.textureLiveries.enabled, false);
  assert.equal(sim.textureLiveries.count, 2);
  const flag = sim.warnings.find((entry) => entry.code === "LIVERY_FLAG_MISSING");
  assert.ok(flag);
  assert.equal(flag.severity, "error");
  assert.match(flag.message, /SetVehicleLivery/);
  assert.match(flag.fix, /FLAG_HAS_LIVERY/);
  assert.ok(codes(sim).includes("SIREN_ID_UNDEFINED"));
  assert.equal(sim.warnings[0].severity, "error", "errors sort first");
});

test("broken: FLAG_HAS_LIVERY with an all-false liveries list is not a warning", () => {
  const vehicles = fixture("broken", "vehicles.meta");
  const variations = fixture("broken", "carvariations.meta");
  const meta = loadResourceMeta([
    { path: vehicles.path, text: vehicles.text.replace("<flags>", "<flags>FLAG_HAS_LIVERY ") },
    { path: variations.path, text: variations.text.replace(/value="true"/g, 'value="false"') },
  ]);
  const sim = simulateVehicle(meta, "sheriff3");
  assert.equal(sim.textureLiveries.enabled, true);
  assert.equal(sim.textureLiveries.count, 0);
  // <liveries> only limits random spawns; SetVehicleLivery still works.
  assert.ok(!codes(sim).some((code) => code.startsWith("LIVERY_")));
  assert.ok(!codes(sim).includes("LIVERY_FLAG_MISSING"));
});

test("missing entries produce NO_VEHICLES_ENTRY and NO_VARIATION_ENTRY", () => {
  const meta = loadFolder("police", ["carcols.meta"]);
  const sim = simulateVehicle(meta, "ghost");
  assert.deepEqual(sim.found, { vehicles: false, variations: false });
  assert.equal(sim.liverySystem, "none");
  assert.deepEqual(codes(sim), ["NO_VEHICLES_ENTRY", "NO_VARIATION_ENTRY"]);
  assert.equal(sim.warnings[0].severity, "warn");
  assert.match(sim.warnings[0].message, /this resource.*inherit/);
  assert.equal(sim.warnings[1].severity, "warn");
  assert.deepEqual(sim.colorPresets, []);
});

test("id conflicts between two carcols files are detected and surfaced", () => {
  const meta = loadFolder("conflict", ["a_carcols.meta", "b_carcols.meta"]);
  const scan = scanResourceForIds(meta);
  assert.equal(scan.kits.length, 2);
  assert.equal(scan.sirens.length, 2);
  assert.deepEqual(
    scan.conflicts.map((conflict) => [conflict.kind, conflict.id, conflict.entries.length]),
    [["kit", 500, 2], ["siren", 20, 2]],
  );
  assert.deepEqual(scan.outOfRange, []);

  // A vehicle that links one of the kits and uses the siren id sees both conflicts.
  const vehicles = fixture("mycar", "vehicles.meta");
  const variations = fixture("mycar", "carvariations.meta");
  const withLinks = loadResourceMeta([
    { path: vehicles.path, text: vehicles.text.replace(/mycar/g, "cara") },
    {
      path: variations.path,
      text: variations.text
        .replace(/mycar/g, "cara")
        .replace("1337_cara_modkit", "500_cara_modkit")
        .replace('<sirenSettings value="0" />', '<sirenSettings value="20" />'),
    },
    fixture("conflict", "a_carcols.meta"),
    fixture("conflict", "b_carcols.meta"),
  ]);
  const sim = simulateVehicle(withLinks, "cara");
  const warningCodes = codes(sim);
  assert.ok(warningCodes.includes("MODKIT_ID_CONFLICT"), warningCodes.join(","));
  assert.ok(warningCodes.includes("SIREN_ID_CONFLICT"), warningCodes.join(","));
  assert.ok(!warningCodes.includes("KIT_ID_RESERVED"), "kit ids below 1000 are common and not reported");
  assert.deepEqual(sim.ids.conflicts, { kit: [500], siren: [20], light: [] });
  const kitConflict = sim.warnings.find((entry) => entry.code === "MODKIT_ID_CONFLICT");
  assert.match(kitConflict.message, /a_carcols\.meta, b_carcols\.meta/);
});

test("siren ids above 255 are listed but not warned about", () => {
  const carcols = fixture("conflict", "a_carcols.meta");
  const meta = loadResourceMeta([
    fixture("broken", "vehicles.meta"),
    fixture("broken", "carvariations.meta"),
    { path: carcols.path, text: carcols.text.replace('<id value="20" />', '<id value="300" />') },
  ]);
  const scan = scanResourceForIds(meta);
  assert.deepEqual(scan.outOfRange.map((entry) => entry.id), [300]);
  const sim = simulateVehicle(meta, "sheriff3");
  // Addon packs ship the SirenSetting Limit Adjuster; the id is shown, not flagged.
  assert.ok(!codes(sim).includes("SIREN_ID_OUT_OF_RANGE"));
});

test("carcols Colors list overrides the vanilla table per index", () => {
  const meta = loadResourceMeta([
    fixture("police", "vehicles.meta"),
    fixture("police", "carvariations.meta"),
    fixture("colors", "carcols.meta"),
  ]);
  assert.equal(meta.colors.length, 2);
  const sim = simulateVehicle(meta, "police");
  // Index 0 is overridden, index 1 comes from the file. Both are raw game
  // colours, shown sRGB-encoded like the vanilla table.
  assert.equal(sim.colorPresets[0].secondary.hex, "#404953");
  assert.equal(sim.colorPresets[0].secondary.finish, 0);
  // The fixture may be checked out with CRLF line endings (core.autocrlf).
  const primaryIndex = /111(\r?\n {12}0\r?\n {12}0)/;
  const variations = fixture("police", "carvariations.meta").text;
  assert.match(variations, primaryIndex);
  const withIndexOne = loadResourceMeta([
    fixture("police", "vehicles.meta"),
    {
      path: "carvariations.meta",
      text: variations.replace(primaryIndex, "1$1"),
    },
    fixture("colors", "carcols.meta"),
  ]);
  const overridden = simulateVehicle(withIndexOne, "police");
  assert.equal(overridden.colorPresets[0].primary.index, 1);
  assert.equal(overridden.colorPresets[0].primary.hex, "#4b7d9d");
  assert.equal(overridden.colorPresets[0].primary.known, true);
});

test("duplicate model definitions across files warn DUPLICATE_MODEL", () => {
  const vehicles = fixture("police", "vehicles.meta");
  const meta = loadResourceMeta([
    vehicles,
    { path: "C:/other/vehicles.meta", text: vehicles.text },
    fixture("police", "carvariations.meta"),
  ]);
  const sim = simulateVehicle(meta, "police");
  const warning = sim.warnings.find((entry) => entry.code === "DUPLICATE_MODEL");
  assert.ok(warning);
  assert.equal(warning.severity, "warn");
  assert.match(warning.message, /vehicles\.meta, vehicles\.meta/);
});

test("model lookup is case-insensitive and simulate tolerates an empty resource", () => {
  const meta = loadFolder("police", ["vehicles.meta", "carvariations.meta"]);
  assert.equal(simulateVehicle(meta, "POLICE").found.vehicles, true);
  const empty = simulateVehicle(null, "police");
  assert.equal(empty.found.vehicles, false);
  assert.equal(empty.liverySystem, "none");
  assert.deepEqual(empty.ids, { kitIds: [], sirenIds: [], lightIds: [], conflicts: { kit: [], siren: [], light: [] } });
});

test("convertible roof clips come from vehicles.meta and hardtops have none", () => {
  const vehicles = `<CVehicleModelInfo__InitDataList><InitDatas>
    <Item><modelName>cabrio</modelName><animConvRoofDictName>VA_Cabrio</animConvRoofDictName><animConvRoofName>Roof</animConvRoofName></Item>
    <Item><modelName>hardtop</modelName><animConvRoofDictName>null</animConvRoofDictName><animConvRoofName>null</animConvRoofName></Item>
  </InitDatas></CVehicleModelInfo__InitDataList>`;
  const meta = loadResourceMeta([{ path: "data/vehicles.meta", text: vehicles }]);
  assert.deepEqual(simulateVehicle(meta, "cabrio").convertibleRoof, { dict: "va_cabrio", clip: "roof" });
  assert.equal(simulateVehicle(meta, "hardtop").convertibleRoof, null);
  assert.equal(simulateVehicle(meta, "missing").convertibleRoof, null);
  assert.equal(parseVehiclesMeta(readFileSync(path.join(FIXTURES, "police", "vehicles.meta"), "utf8"), "x").vehicles[0].convertibleRoof, null);
});

test("steering lock comes from the vehicle's handlingId in handling.meta", () => {
  const vehicles = `<CVehicleModelInfo__InitDataList><InitDatas>
    <Item><modelName>gsdtahoe</modelName><handlingId>GSDSS23Tahoe</handlingId></Item>
    <Item><modelName>other</modelName><handlingId>MISSING</handlingId></Item>
  </InitDatas></CVehicleModelInfo__InitDataList>`;
  const handling = `<CHandlingDataMgr><HandlingData>
    <Item type="CHandlingData"><handlingName>gsdss23tahoe</handlingName><fSteeringLock value="36.000000" /></Item>
    <Item type="CHandlingData"><handlingName>Broken</handlingName><fSteeringLock value="-4" /></Item>
  </HandlingData></CHandlingDataMgr>`;
  const meta = loadResourceMeta([
    { path: "data/vehicles.meta", text: vehicles },
    { path: "data/handling.meta", text: handling },
  ]);
  assert.equal(meta.handling.length, 2);
  assert.deepEqual(simulateVehicle(meta, "GSDTahoe").steering, {
    handlingId: "GSDSS23Tahoe",
    lockDegrees: 36,
    sourcePath: "data/handling.meta",
  });
  assert.equal(simulateVehicle(meta, "other").steering.lockDegrees, null, "unknown handling reports no lock");
  assert.equal(meta.handling[1].steeringLock, null, "out-of-range locks are rejected");
});
