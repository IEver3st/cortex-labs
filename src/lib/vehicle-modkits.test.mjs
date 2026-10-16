import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadResourceMeta } from "./vehicle-meta.js";
import {
  findModelFile,
  indexModelFiles,
  isHiddenByBones,
  joaat,
  listVehicleModkits,
  modSlotLabel,
  parseTextEntries,
  resolveModSelection,
} from "./vehicle-modkits.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "meta");

function loadFolder(folder, names) {
  return loadResourceMeta(names.map((name) => {
    const filePath = path.join(FIXTURES, folder, name);
    return { path: filePath, text: readFileSync(filePath, "utf8") };
  }));
}

const modXml = ([model, type, off = []]) => `<Item><modelName>${model}</modelName><linkedModels />` +
  `<turnOffBones>${off.map((bone) => `<Item>${bone}</Item>`).join("")}</turnOffBones><type>${type}</type><bone>chassis</bone></Item>`;
const kitXml = (kitName, mods) => `<CVehicleModelInfoVarGlobal><Kits><Item><kitName>${kitName}</kitName><id value="900" />` +
  `<visibleMods>${mods.map(modXml).join("")}</visibleMods></Item></Kits></CVehicleModelInfoVarGlobal>`;
const vehiclesXml = (...models) => `<CVehicleModelInfo__InitDataList><InitDatas>${models.map((model) => `<Item><modelName>${model}</modelName></Item>`).join("")}</InitDatas></CVehicleModelInfo__InitDataList>`;

test("linked kits group visible mods by slot in game order", () => {
  const meta = loadFolder("mycar", ["vehicles.meta", "carvariations.meta", "carcols.meta"]);
  const { kits } = listVehicleModkits(meta, "MyCar");
  assert.equal(kits.length, 1);
  const [kit] = kits;
  assert.equal(kit.kitName, "1337_mycar_modkit");
  assert.equal(kit.linked, true);
  assert.deepEqual(kit.slots.map((slot) => slot.type), ["VMT_SPOILER", "VMT_LIVERY_MOD"]);
  const livery = kit.slots[1];
  assert.equal(livery.label, "Livery");
  assert.deepEqual(livery.mods.map((mod) => [mod.index, mod.modelName]), [[0, "mycar_livery1"], [1, "mycar_livery2"]]);
  assert.deepEqual(livery.mods[1].linkedModels, ["mycar_livery2_wing"]);
  assert.deepEqual(kit.slots[0].mods[0].turnOffBones, ["misc_a"]);
});

test("mods without a model keep the game's per-type index for later entries", () => {
  const meta = loadResourceMeta([{ path: "carcols.meta", text: kitXml("car_kit", [["", "VMT_SPOILER"], ["car_wing", "VMT_SPOILER"]]) }]);
  const { kits } = listVehicleModkits(meta, "car");
  assert.deepEqual(kits[0].slots[0].mods.map((mod) => mod.index), [1]);
  assert.equal(kits[0].linked, false, "a kit that only names the model is offered but marked unlinked");
});

test("unlinked kits are only offered when they plausibly belong to the model", () => {
  const meta = loadResourceMeta([
    { path: "carcols.meta", text: kitXml("other_kit", [["other_wing", "VMT_SPOILER"]]) },
    { path: "vehicles.meta", text: vehiclesXml("car", "van") },
  ]);
  assert.equal(listVehicleModkits(meta, "car").kits.length, 0);
  const single = loadResourceMeta([
    { path: "carcols.meta", text: kitXml("other_kit", [["other_wing", "VMT_SPOILER"]]) },
    { path: "vehicles.meta", text: vehiclesXml("car") },
  ]);
  assert.equal(listVehicleModkits(single, "car").kits.length, 1);
  assert.equal(listVehicleModkits(null, "car").kits.length, 0);
});

test("selection resolves model files, linked models and turned-off bones", () => {
  const meta = loadFolder("mycar", ["carvariations.meta", "carcols.meta"]);
  const [kit] = listVehicleModkits(meta, "mycar").kits;
  const index = indexModelFiles([
    "C:/res/stream/mycar_livery2.yft",
    "C:/res/stream/mycar_livery2_hi.yft",
    "C:/res/stream/mycar_spoiler1.yft",
    "C:/res/stream/notes.txt",
  ]);
  const result = resolveModSelection(kit, { VMT_LIVERY_MOD: 1, VMT_SPOILER: 0, VMT_ROOF: 0 }, index);
  assert.deepEqual(result.parts.map((part) => part.path), [
    "C:/res/stream/mycar_spoiler1.yft",
    "C:/res/stream/mycar_livery2_hi.yft",
  ]);
  assert.deepEqual(result.missing, [{ slotType: "VMT_LIVERY_MOD", modelName: "mycar_livery2_wing" }]);
  assert.deepEqual(result.hiddenBones, ["misc_a"]);
  assert.deepEqual(resolveModSelection(kit, { VMT_SPOILER: 7 }, index).parts, []);
});

test("resolved parts carry the bone they are fitted to, linked models from linkMods", () => {
  const meta = loadResourceMeta([{ path: "carcols.meta", text: `<CVehicleModelInfoVarGlobal><Kits><Item><kitName>car_kit</kitName><id value="900" />` +
    `<visibleMods><Item><modelName>car_badge</modelName><linkedModels><Item>car_badge_link</Item><Item>car_badge_trim</Item></linkedModels>` +
    `<turnOffBones /><type>VMT_INTERIOR2</type><bone>door_dside_f</bone></Item></visibleMods>` +
    `<linkMods><Item><modelName>CAR_BADGE_LINK</modelName><bone>boot</bone></Item></linkMods></Item></Kits></CVehicleModelInfoVarGlobal>` }]);
  const [kit] = listVehicleModkits(meta, "car").kits;
  const index = indexModelFiles(["C:/res/car_badge.yft", "C:/res/car_badge_link.yft", "C:/res/car_badge_trim.yft"]);
  const { parts } = resolveModSelection(kit, { VMT_INTERIOR2: 0 }, index);
  assert.deepEqual(parts.map((part) => [part.modelName, part.bone]), [
    ["car_badge", "door_dside_f"],
    ["car_badge_link", "boot"],
    ["car_badge_trim", "door_dside_f"],
  ]);
});

test("model lookup prefers high detail files and ignores case", () => {
  const index = indexModelFiles(["C:/a/Car_Wing.yft", "C:/b/car_wing.yft", "C:/a/car_wing_hi.yft"]);
  assert.equal(findModelFile(index, "CAR_WING"), "C:/a/car_wing_hi.yft");
  assert.equal(indexModelFiles(["C:/a/Car_Wing.yft", "C:/b/car_wing.yft"]).get("car_wing"), "C:/a/Car_Wing.yft");
  assert.equal(findModelFile(index, ""), null);
});

test("bone hiding follows the chain and leaves unknown chains visible", () => {
  const hidden = new Set(["misc_a"]);
  assert.equal(isHiddenByBones(["misc_a", "boot", "chassis"], hidden), true);
  assert.equal(isHiddenByBones(["extra_1", "MISC_A"], hidden), true);
  assert.equal(isHiddenByBones(["boot", "chassis"], hidden), false);
  assert.equal(isHiddenByBones(null, hidden), false);
  assert.equal(isHiddenByBones(["misc_a"], new Set()), false);
});

test("slot labels cover known types and humanize unknown ones", () => {
  assert.equal(modSlotLabel("vmt_bumper_f"), "Front bumper");
  assert.equal(modSlotLabel("VMT_CUSTOM_THING"), "Custom thing");
});

test("joaat matches GetHashKey", () => {
  assert.equal(joaat("adder"), 0xb779a091);
  assert.equal(joaat("ADDER"), 0xb779a091);
});

test("text entries come from AddTextEntry and AddTextEntryByHash, skipping comments", () => {
  const entries = parseTextEntries([
    "Citizen.CreateThread(function()",
    "  AddTextEntry('CAR_SPL1', 'Carbon ~r~wing')",
    "  AddTextEntry(\"CAR_SPL2\", \"Duck \\\"tail\\\"\")",
    "  -- AddTextEntry('CAR_SPL3', 'Commented out')",
    "  --[[ AddTextEntry('CAR_SPL4', 'Block comment') ]]",
    "  AddTextEntryByHash(`car_bon1`, 'Vented hood')",
    "  AddTextEntryByHash(GetHashKey('car_bon2'), 'Cowl hood')",
    "  AddTextEntryByHash(0xB779A091, 'Adder')",
    "  AddTextEntry(label, name)",
    "end)",
  ].join("\n"));
  assert.equal(entries.get(joaat("car_spl1")), "Carbon wing");
  assert.equal(entries.get(joaat("CAR_SPL2")), 'Duck "tail"');
  assert.equal(entries.has(joaat("CAR_SPL3")), false);
  assert.equal(entries.has(joaat("CAR_SPL4")), false);
  assert.equal(entries.get(joaat("CAR_BON1")), "Vented hood");
  assert.equal(entries.get(joaat("car_bon2")), "Cowl hood");
  assert.equal(entries.get(joaat("adder")), "Adder");
  assert.equal(entries.size, 5);
});

test("slot and mod names come from carcols slotNames and registered text", () => {
  const meta = loadResourceMeta([{
    path: "carcols.meta",
    text: `<CVehicleModelInfoVarGlobal><Kits><Item><kitName>car_kit</kitName>
      <visibleMods>
        <Item><modelName>car_bon_1</modelName><modShopLabel>CAR_BON1</modShopLabel><type>VMT_BONNET</type></Item>
        <Item><modelName>car_bon_2</modelName><modShopLabel>CAR_BON2</modShopLabel><type>VMT_BONNET</type></Item>
        <Item><modelName>car_wing_1</modelName><modShopLabel /><type>VMT_WING_L</type></Item>
      </visibleMods>
      <slotNames>
        <Item><slot>VMT_BONNET</slot><name>Pushbar/Grill Options</name></Item>
        <Item><slot>VMT_WING_L</slot><name>CAR_SLOT_LAPTOP</name></Item>
      </slotNames>
      <liveryNames><Item>CAR_LIV1</Item><Item>CAR_LIV2</Item></liveryNames>
    </Item></Kits></CVehicleModelInfoVarGlobal>`,
  }]);
  const textEntries = parseTextEntries("AddTextEntry('car_bon1', 'Pushbar') AddTextEntry('CAR_SLOT_LAPTOP', 'Laptop') AddTextEntry('CAR_LIV1', 'LSPD Classic')");
  const [kit] = listVehicleModkits(meta, "car", { textEntries }).kits;
  const hood = kit.slots.find((slot) => slot.type === "VMT_BONNET");
  assert.equal(hood.displayName, "Pushbar/Grill Options");
  assert.equal(hood.label, "Hood");
  assert.deepEqual(hood.mods.map((mod) => [mod.displayName, mod.named]), [["Pushbar", true], ["CAR_BON2", false]]);
  const wing = kit.slots.find((slot) => slot.type === "VMT_WING_L");
  assert.equal(wing.displayName, "Laptop");
  assert.equal(wing.mods[0].displayName, "car_wing_1");
  assert.deepEqual(kit.liveryNames, ["LSPD Classic", "CAR_LIV2"]);
  assert.equal(listVehicleModkits(meta, "car").kits[0].slots[0].mods[0].displayName, "CAR_BON1");
});
