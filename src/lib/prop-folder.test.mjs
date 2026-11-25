import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterPropModels,
  findEnclosingPropRoot,
  isPathInside,
  scanPropFolder,
} from "./prop-folder.js";

function makeVirtualFs(tree) {
  const normalized = new Map();
  for (const [dir, entries] of Object.entries(tree)) {
    normalized.set(dir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase(), entries);
  }
  return async (dirPath) => {
    const key = String(dirPath || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (!normalized.has(key)) throw new Error(`ENOENT: ${dirPath}`);
    return normalized.get(key);
  };
}

const file = (name) => ({ name, isDirectory: false });
const dir = (name) => ({ name, isDirectory: true });

test("scanPropFolder auto-detects stream/ inside a FiveM script and skips code folders", async () => {
  const readDir = makeVirtualFs({
    "C:/server/resources/my-prop-script": [
      file("fxmanifest.lua"),
      dir("client"),
      dir("server"),
      dir("web"),
      dir("stream"),
    ],
    "C:/server/resources/my-prop-script/client": [file("main.lua")],
    "C:/server/resources/my-prop-script/stream": [
      file("prop_radio.ydr"),
      file("prop_radio.ytd"),
      file("my_props.ytyp.xml"),
      dir("furniture"),
    ],
    "C:/server/resources/my-prop-script/stream/furniture": [
      file("desk_chair.ydr"),
      file("lamp_kit.yft"),
    ],
  });

  const result = await scanPropFolder("C:\\server\\resources\\my-prop-script", { readDir });
  assert.equal(result.kind, "script");
  assert.equal(result.detectedStream, true);
  assert.equal(result.hasManifest, true);
  assert.equal(result.label, "my-prop-script");
  assert.match(result.scanRoot, /my-prop-script\\stream$/i);
  assert.deepEqual(
    result.models.map((m) => ({ name: m.name, subPath: m.subPath })),
    [
      { name: "prop_radio.ydr", subPath: "" },
      { name: "desk_chair.ydr", subPath: "furniture" },
      { name: "lamp_kit.yft", subPath: "furniture" },
    ],
  );
  assert.equal(result.ytypXmls.length, 1);
  assert.ok(result.ytdStems.includes("prop_radio"));
});

test("scanPropFolder handles a multi-resource category folder like [props]/", async () => {
  const readDir = makeVirtualFs({
    "C:/server/resources/[props]": [dir("food-props"), dir("leo-props")],
    "C:/server/resources/[props]/food-props": [
      file("fxmanifest.lua"),
      dir("client"),
      dir("stream"),
    ],
    "C:/server/resources/[props]/food-props/stream": [file("burger.ydr")],
    "C:/server/resources/[props]/leo-props": [
      file("fxmanifest.lua"),
      dir("stream"),
    ],
    "C:/server/resources/[props]/leo-props/stream": [file("cone.ydr"), file("radar.ydd")],
  });

  const result = await scanPropFolder("C:/server/resources/[props]", { readDir });
  assert.equal(result.kind, "pack");
  assert.equal(result.detectedStream, true);
  assert.deepEqual(
    result.models.map((m) => `${m.resourceName}:${m.name}`),
    ["food-props:burger.ydr", "leo-props:cone.ydr", "leo-props:radar.ydd"],
  );
});

test("scanPropFolder handles picking a stream/ folder or plain prop folder directly", async () => {
  const readDir = makeVirtualFs({
    "D:/props/stream": [file("crate_01.ydr"), file("crate_02.ydr")],
  });
  const result = await scanPropFolder("D:\\props\\stream", { readDir });
  assert.equal(result.kind, "stream");
  assert.equal(result.detectedStream, true);
  assert.equal(result.models.length, 2);
});

test("findEnclosingPropRoot resolves a single prop inside stream/sub/ back to its FiveM script root", async () => {
  const readDir = makeVirtualFs({
    "C:/server/resources/my-script": [file("fxmanifest.lua"), dir("stream")],
    "C:/server/resources/my-script/stream": [dir("weapons")],
    "C:/server/resources/my-script/stream/weapons": [file("baton.ydr")],
  });

  const root = await findEnclosingPropRoot("C:\\server\\resources\\my-script\\stream\\weapons\\baton.ydr", { readDir });
  assert.equal(root, "C:\\server\\resources\\my-script");
});

test("isPathInside and filterPropModels handle Windows paths and subfolder queries", () => {
  assert.equal(isPathInside("C:\\Res\\my-script\\stream\\a.ydr", "C:/res/my-script/"), true);
  assert.equal(isPathInside("C:\\Res\\my-script-2\\stream\\a.ydr", "C:\\Res\\my-script"), false);

  const models = [
    { name: "prop_chair.ydr", stem: "prop_chair", subPath: "office", resourceName: "my-script" },
    { name: "prop_cone.ydr", stem: "prop_cone", subPath: "road", resourceName: "my-script" },
  ];
  assert.equal(filterPropModels(models, "office").length, 1);
  assert.equal(filterPropModels(models, "cone").length, 1);
});
