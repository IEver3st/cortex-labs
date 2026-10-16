import assert from "node:assert/strict";
import test from "node:test";
import { listResourceModelFiles, readModelResourceMeta, readResourceTextEntries } from "./resource-meta-files.js";
import { joaat } from "./vehicle-modkits.js";


const dir = (name) => ({ name, isDirectory: true });
const file = (name) => ({ name, isDirectory: false });
const xml = '<CVehicleModelInfo__InitDataList><InitDatas><Item><modelName>police</modelName></Item></InitDatas></CVehicleModelInfo__InitDataList>';

test("meta discovery stays in the nearest resource and classifies arbitrary filenames", async () => {
  const calls = [];
  const tree = {
    "C:/resources/police/stream": [file("police_hi.yft")],
    "C:/resources/police": [file("fxmanifest.lua"), dir("stream"), dir("data"), dir("node_modules")],
    "C:/resources/police/data": [file("custom_vehicle.meta")],
  };
  const { root, meta } = await readModelResourceMeta("C:\\resources\\police\\stream\\police_hi.yft", {
    readDir: async (path) => { calls.push(path); assert.ok(tree[path], path); return tree[path]; },
    readTextFile: async (path) => { assert.equal(path, "C:/resources/police/data/custom_vehicle.meta"); return xml; },
  });
  assert.equal(root, "C:/resources/police");
  assert.equal(meta.vehicles[0].modelName, "police");
  assert.equal(meta.sources[0].kind, "vehicles");
  assert.equal(meta.errors.length, 0);
  assert.ok(!calls.includes("C:/resources"));
});

test("a failed meta file is reported while readable files remain available", async () => {
  const { meta } = await readModelResourceMeta("C:/police/model.yft", {
    readDir: async () => [file("fxmanifest.lua"), file("good.meta"), file("bad.meta")],
    readTextFile: async (path) => { if (path.endsWith("bad.meta")) throw new Error("Access denied"); return xml; },
  });
  assert.equal(meta.vehicles.length, 1);
  assert.equal(meta.errors[0].message, "Access denied");
});

test("cancellation after a native directory read prevents subsequent file reads", async () => {
  const controller = new AbortController();
  await assert.rejects(readModelResourceMeta("C:/police/model.yft", {
    signal: controller.signal,
    readDir: async () => { controller.abort(); return [file("fxmanifest.lua"), file("good.meta")]; },
    readTextFile: async () => assert.fail("cancelled scan must not read files"),
  }), { name: "AbortError" });
});

test("model discovery walks stream folders under the resource and the model folder outside it", async () => {
  const tree = {
    "C:/resources/mycar": [file("fxmanifest.lua"), dir("stream"), dir("node_modules")],
    "C:/resources/mycar/stream": [file("mycar.yft"), file("mycar.ytd"), dir("mods")],
    "C:/resources/mycar/stream/mods": [file("mycar_spoiler1.YFT")],
    "D:/loose": [file("mycar_wing.yft")],
  };
  const { paths, errors } = await listResourceModelFiles("C:/resources/mycar", "D:\\loose\\mycar_hi.yft", {
    readDir: async (path) => { assert.ok(tree[path], path); return tree[path]; },
  });
  assert.deepEqual(paths, [
    "C:/resources/mycar/stream/mycar.yft",
    "C:/resources/mycar/stream/mods/mycar_spoiler1.YFT",
    "D:/loose/mycar_wing.yft",
  ]);
  assert.equal(errors.length, 0);
});

test("model discovery reports unreadable folders and honours cancellation", async () => {
  const { paths, errors } = await listResourceModelFiles("C:/res", "C:/res/stream/car.yft", {
    readDir: async (path) => {
      if (path === "C:/res") return [dir("stream"), dir("locked")];
      if (path === "C:/res/locked") throw new Error("Access denied");
      return [file("car.yft")];
    },
  });
  assert.deepEqual(paths, ["C:/res/stream/car.yft"]);
  assert.deepEqual(errors, [{ path: "C:/res/locked", message: "Access denied" }]);

  const controller = new AbortController();
  await assert.rejects(listResourceModelFiles("C:/res", "C:/res/car.yft", {
    signal: controller.signal,
    readDir: async () => { controller.abort(); return [dir("stream")]; },
  }), { name: "AbortError" });
});

test("text entries are read from resource scripts outside stream folders", async () => {
  const tree = {
    "C:/res": [file("fxmanifest.lua"), file("names.lua"), dir("client"), dir("stream")],
    "C:/res/client": [file("main.lua"), file("escrowed.lua")],
  };
  const files = {
    "C:/res/fxmanifest.lua": "fx_version 'cerulean'",
    "C:/res/names.lua": "AddTextEntry('CAR_SPL1', 'Carbon wing')",
    "C:/res/client/main.lua": "print('no names')",
    "C:/res/client/escrowed.lua": null,
  };
  const { entries, sources, errors } = await readResourceTextEntries("C:/res", {
    readDir: async (path) => { assert.ok(tree[path], path); return tree[path]; },
    readTextFile: async (path) => { if (files[path] == null) throw new Error("Escrowed"); return files[path]; },
  });
  assert.equal(entries.get(joaat("car_spl1")), "Carbon wing");
  assert.deepEqual(sources, ["C:/res/names.lua"]);
  assert.deepEqual(errors, [{ path: "C:/res/client/escrowed.lua", message: "Escrowed" }]);
});
