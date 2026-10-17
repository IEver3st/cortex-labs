import assert from "node:assert/strict";
import test from "node:test";
import { filterVehicles, listFolderVehicles, scanVehicleFolder, stepVehicle, vehicleIndexOf } from "./vehicle-folder.js";

const dir = (name) => ({ name, isDirectory: true });
const file = (name) => ({ name, isDirectory: false });

const vehiclesMeta = (...names) => `<CVehicleModelInfo__InitDataList><InitDatas>${names
  .map((name) => `<Item><modelName>${name}</modelName><gameName>${name.toUpperCase()}</gameName></Item>`).join("")}</InitDatas></CVehicleModelInfo__InitDataList>`;
const carcols = (...parts) => `<CVehicleModelInfoVarGlobal><Kits><Item><kitName>1_pack_modkit</kitName><id value="1" /><kitType>MKT_SPECIAL</kitType><visibleMods>${parts
  .map((part) => `<Item><modelName>${part}</modelName><modShopLabel /><linkedModels /><turnOffBones /><type>VMT_SPOILER</type><bone>chassis</bone><collisionBone>chassis</collisionBone></Item>`).join("")}</visibleMods><linkMods /><statMods /></Item></Kits></CVehicleModelInfoVarGlobal>`;

function fakeFs(tree, texts = {}) {
  const reads = [];
  return {
    reads,
    readDir: async (path) => {
      if (!tree[path]) throw new Error(`no folder ${path}`);
      return tree[path];
    },
    readTextFile: async (path) => {
      reads.push(path);
      if (!(path in texts)) throw new Error(`no file ${path}`);
      return texts[path];
    },
  };
}

test("a pack lists the cars its vehicles.meta names, not the mod kit parts beside them", async () => {
  const fs = fakeFs({
    "C:/res/[cars]": [dir("pack"), dir("solo"), dir("loose")],
    "C:/res/[cars]/pack": [file("fxmanifest.lua"), dir("data"), dir("stream")],
    "C:/res/[cars]/pack/data": [file("vehicles.meta"), file("carcols.meta")],
    "C:/res/[cars]/pack/stream": [dir("charger"), dir("explorer"), file("stray.meta")],
    "C:/res/[cars]/pack/stream/charger": [file("charger.yft"), file("charger_hi.yft"), file("charger.ytd"), file("charger_spoiler1.yft"), file("charger_bumper.yft")],
    "C:/res/[cars]/pack/stream/explorer": [file("Explorer10.yft"), file("explorer10_hi.yft")],
    "C:/res/[cars]/solo": [file("__resource.lua"), file("vehicles.meta"), dir("stream")],
    "C:/res/[cars]/solo/stream": [file("tahoe.yft")],
    "C:/res/[cars]/loose": [file("bike.yft"), file("bike_hi.yft"), file("box.ytd")],
  }, {
    "C:/res/[cars]/pack/data/vehicles.meta": vehiclesMeta("charger", "explorer10", "ghost"),
    "C:/res/[cars]/pack/data/carcols.meta": carcols("charger_spoiler1", "charger_bumper"),
    "C:/res/[cars]/solo/vehicles.meta": vehiclesMeta("tahoe"),
  });
  const result = await scanVehicleFolder("C:\\res\\[cars]\\", fs);
  assert.deepEqual(result.vehicles.map((v) => [v.resource, v.name, v.path, v.declared]), [
    ["[cars]", "bike", "C:/res/[cars]/loose/bike_hi.yft", false],
    ["pack", "charger", "C:/res/[cars]/pack/stream/charger/charger_hi.yft", true],
    ["pack", "explorer10", "C:/res/[cars]/pack/stream/explorer/explorer10_hi.yft", true],
    ["solo", "tahoe", "C:/res/[cars]/solo/stream/tahoe.yft", true],
  ]);
  assert.equal(result.vehicles[1].gameName, "CHARGER");
  assert.deepEqual(result.vehicles.map((v) => v.problems.length), [0, 0, 0, 0]);
  assert.deepEqual(result.missing, [{ name: "ghost", resource: "pack" }]);
  // Meta in stream folders is not read.
  assert.ok(!fs.reads.some((path) => path.endsWith("stray.meta")));
  assert.deepEqual(result.errors, []);
  assert.equal(result.truncated, false);
});

test("a folder picked inside a resource, like its stream folder, lists what the resource's vehicles.meta names", async () => {
  const fs = fakeFs({
    "C:/res/pack": [file("fxmanifest.lua"), dir("data"), dir("stream")],
    "C:/res/pack/data": [file("vehicles.meta"), file("carcols.meta")],
    "C:/res/pack/stream": [dir("charger"), dir("gator"), file("stray.meta")],
    "C:/res/pack/stream/charger": [file("charger.yft"), file("charger_hi.yft"), file("charger_decalbed_1.yft")],
    "C:/res/pack/stream/gator": [file("gator_hi.yft"), file("gator_alpr_1.yft")],
  }, {
    "C:/res/pack/data/vehicles.meta": vehiclesMeta("charger", "gator", "tahoe"),
    "C:/res/pack/data/carcols.meta": carcols("charger_decalbed_1"),
  });
  const asked = [];
  const result = await scanVehicleFolder("C:\\res\\pack\\stream", { ...fs, allowResource: async (path) => { asked.push(path); } });
  assert.deepEqual(result.vehicles.map((v) => [v.resource, v.name, v.path, v.resourcePath]), [
    ["pack", "charger", "C:/res/pack/stream/charger/charger_hi.yft", "C:/res/pack"],
    ["pack", "gator", "C:/res/pack/stream/gator/gator_hi.yft", "C:/res/pack"],
  ]);
  // Part of a resource is expected to miss most of its vehicles.
  assert.deepEqual(result.missing, []);
  assert.ok(asked.length === 1 && asked[0].endsWith(".yft"));
  assert.ok(!fs.reads.some((path) => path.endsWith("stray.meta")));
  assert.deepEqual(result.errors, []);
});

test("a loose folder with no resource above it still lists every model", async () => {
  const fs = fakeFs({
    "C:/dl": [dir("cars")],
    "C:/dl/cars": [file("bike.yft"), file("box.yft")],
  });
  const result = await scanVehicleFolder("C:/dl/cars", fs);
  assert.deepEqual(result.vehicles.map((v) => [v.resource, v.name]), [["cars", "bike"], ["cars", "box"]]);
});

test("a vehicle carries the errors its resource's meta has for it", async () => {
  const fs = fakeFs({
    "C:/res/pack": [file("fxmanifest.lua"), file("vehicles.meta"), file("carvariations.meta"), file("car.yft"), file("van.yft")],
  }, {
    "C:/res/pack/vehicles.meta": vehiclesMeta("car", "van"),
    // car lists a livery slot, but vehicles.meta gives it no FLAG_HAS_LIVERY.
    "C:/res/pack/carvariations.meta": `<CVehicleModelInfoVariation><variationData>${["car", "van"]
      .map((name) => `<Item><modelName>${name}</modelName><colors><Item><indices content="char_array">0 0 0 0</indices><liveries>${name === "car" ? "<Item value=\"true\" />" : ""}</liveries></Item></colors><kits /></Item>`).join("")}</variationData></CVehicleModelInfoVariation>`,
  });
  const result = await scanVehicleFolder("C:/res/pack", fs);
  const byName = Object.fromEntries(result.vehicles.map((v) => [v.name, v.problems]));
  assert.equal(byName.car.length, 1);
  assert.match(byName.car[0], /FLAG_HAS_LIVERY/);
  assert.deepEqual(byName.van, []);
});

test("without a vehicles.meta, kit parts still stay out", () => {
  const { vehicles } = listFolderVehicles([{
    path: "C:/dev/charger",
    models: ["C:/dev/charger/charger.yft", "C:/dev/charger/CHARGER_hi.yft", "C:/dev/charger/charger_spoiler1.yft", "C:/dev/charger/charger_wing_hi.yft"],
    meta: { vehicles: [], kits: [{ visibleMods: [{ modelName: "charger_spoiler1", linkedModels: [] }], linkMods: [{ modelName: "", linkedModels: ["charger_wing"] }] }] },
  }]);
  assert.deepEqual(vehicles.map((v) => [v.name, v.path]), [["charger", "C:/dev/charger/CHARGER_hi.yft"]]);
});

test("a drive root is read as the root, not the drive's current folder", async () => {
  const fs = fakeFs({
    "D:/": [dir("pack")],
    "D:/pack": [file("fxmanifest.lua"), file("car.yft")],
  });
  const result = await scanVehicleFolder("D:\\", fs);
  assert.equal(result.folder, "D:/");
  assert.deepEqual(result.vehicles.map((v) => [v.resource, v.path]), [["pack", "D:/pack/car.yft"]]);
  assert.deepEqual(result.errors, []);
});

test("unreadable folders and meta are reported and the rest still list", async () => {
  const fs = fakeFs({
    "C:/res": [dir("a"), dir("locked")],
    "C:/res/a": [file("fxmanifest.lua"), file("broken.meta"), file("car.yft")],
  }, { "C:/res/a/broken.meta": "<CVehicleModelInfo__InitDataList><InitDatas>" });
  const result = await scanVehicleFolder("C:/res", fs);
  assert.deepEqual(result.vehicles.map((v) => v.name), ["car"]);
  assert.ok(result.errors.some((error) => error.path === "C:/res/locked"));
  assert.ok(result.errors.some((error) => error.path === "C:/res/a/broken.meta"));
});

test("a scan stops when cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(scanVehicleFolder("C:/res", { ...fakeFs({ "C:/res": [] }), signal: controller.signal }), { name: "AbortError" });
});

test("the open model finds its vehicle, its _hi or base twin included, and steps stop at the ends", () => {
  const vehicles = [
    { name: "a", path: "C:/r/a_hi.yft", resource: "r", gameName: "" },
    { name: "b", path: "C:/r/b.yft", resource: "r", gameName: "BRAVO" },
    { name: "c", path: "C:/s/c_hi.yft", resource: "s", gameName: "" },
  ];
  assert.equal(vehicleIndexOf(vehicles, "C:\\r\\A_HI.yft"), 0);
  assert.equal(vehicleIndexOf(vehicles, "C:/r/a.yft"), 0);
  assert.equal(vehicleIndexOf(vehicles, "C:/other/a.yft"), -1);
  assert.equal(stepVehicle(vehicles, "C:/r/a.yft", 1).name, "b");
  assert.equal(stepVehicle(vehicles, "C:/s/c_hi.yft", 1), null);
  assert.equal(stepVehicle(vehicles, "C:/r/a_hi.yft", -1), null);
  assert.equal(stepVehicle(vehicles, "", 1).name, "a");
  assert.equal(stepVehicle(vehicles, "", -1).name, "c");
  assert.deepEqual(filterVehicles(vehicles, " bra ").map((v) => v.name), ["b"]);
  assert.deepEqual(filterVehicles(vehicles, "s").map((v) => v.name), ["c"]);
  assert.equal(filterVehicles(vehicles, "").length, 3);
});
