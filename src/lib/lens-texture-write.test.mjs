import test from "node:test";
import assert from "node:assert/strict";
import { encodeDxt5, writeDds } from "./dds-encode.js";
import {
  canWriteLens,
  encodeLensWriteBody,
  lensConflictGroups,
  prepareLensWrite,
  writeLensTextures,
} from "./lens-texture-write.js";

function dds(rgb) {
  const pixels = new Uint8Array(8 * 8 * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([...rgb, 255], i);
  return writeDds({ format: "DXT5", width: 8, height: 8, levels: [encodeDxt5(pixels, 8, 8)] });
}

const quad = (u0, u1) => ({ uvs: new Float32Array([u0, 0, u1, 0, u1, 1, u0, 1]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) });

function vehicle(lenses, inputs) {
  const meshes = lenses.map(([name, , , u0, u1]) => ({ name, ...quad(u0, u1) }));
  const manifest = {
    meshes: lenses.map(([name, bone, texture]) => ({
      name,
      lightBone: bone,
      shaderName: "vehicle_lightsemissive",
      textureBindings: [{ paramName: "diffusesampler", uvSet: 0, ...texture }],
    })),
    textures: [{ name: "Shared_Emis", relativePath: "textures/shared/PackTxd/Shared_Emis.dds" }],
    inputs,
  };
  return { meshes, manifest, manifestPath: "C:\\cache\\key\\manifest.json" };
}

const OWN = { textureName: "lens_a", relativePath: "textures/ytd/Lens_A.dds", source: "ytd" };
const PACK = { textureName: "shared_emis", relativePath: "textures/shared/PackTxd/Shared_Emis.dds", source: "ytd" };
const GAME = { textureName: "vehicle_generic_emis", relativePath: "../.shared-textures/abc.dds", source: "shared" };
const INNER = { textureName: "inner", relativePath: "textures/embedded/inner.dds", source: "embedded" };

const PACK_YTD = "C:\\res\\stream\\PackTxd.ytd";
const INPUTS = [
  { path: "C:\\res\\stream\\car.ytd", mtimeMs: 1, size: 1 },
  { path: PACK_YTD, mtimeMs: 1, size: 1 },
  { path: "C:\\res\\stream\\PackTxd+hi.ytd", missing: true },
];

function setup({
  lenses,
  dictionaries = { "car+hi.ytd": [["Lens_A", "hi/Lens_A.dds"]], "car.ytd": [["LENS_A", "low/Lens_A.dds"]] },
  inputs = INPUTS,
  resource = "C:\\res\\fxmanifest.lua",
}) {
  const files = new Map([
    ["hi/Lens_A.dds", dds([200, 0, 0])],
    ["low/Lens_A.dds", dds([180, 0, 0])],
    ["C:\\cache\\key\\textures\\shared\\PackTxd\\Shared_Emis.dds", dds([0, 0, 200])],
    ["C:\\cache\\.shared-textures\\abc.dds", dds([200, 200, 200])],
  ]);
  const read = [];
  return {
    read,
    deps: {
      modelPath: "C:\\res\\stream\\car_hi.yft",
      readModel: async () => vehicle(lenses, inputs),
      readFile: async (path) => {
        read.push(path);
        if (!files.has(path)) throw new Error(`missing ${path}`);
        return files.get(path);
      },
      exists: async (path) => path === resource || Object.keys(dictionaries).some((name) => path === `C:\\res\\stream\\${name}`),
      exportYtd: async (path) => ({ textures: dictionaries[path.split("\\").pop()].map(([name, file]) => ({ name, path: file })) }),
      pause: async () => {},
    },
  };
}

test("a lens write replaces the vehicle's own copies and adds copies of its resource's shared textures", async () => {
  const { deps } = setup({ lenses: [["a", "siren1", OWN, 0, 0.5], ["b", "siren1", PACK, 0, 0.5]] });
  const prepared = await prepareLensWrite({ ...deps, colours: { 1: "#00ff00" } });
  assert.equal(prepared.blocked, null);
  assert.deepEqual(prepared.problems, []);
  assert.deepEqual(prepared.outside, []);
  assert.ok(canWriteLens(prepared));
  assert.deepEqual(prepared.files.map((file) => [file.name, file.textures.map((texture) => `${texture.mode} ${texture.name} ${texture.source || "-"}`)]), [
    ["car+hi.ytd", ["replace Lens_A -", `add Shared_Emis ${PACK_YTD}`]],
    ["car.ytd", ["replace LENS_A -", `add Shared_Emis ${PACK_YTD}`]],
  ]);
  const byName = new Map(prepared.textures.map((texture) => [texture.name, texture]));
  assert.equal(byName.get("lens_a").from, null);
  assert.equal(byName.get("shared_emis").from, "PackTxd.ytd");
  assert.deepEqual(byName.get("lens_a").files, ["car+hi.ytd", "car.ytd"]);
  assert.deepEqual(byName.get("lens_a").sirens, [1]);
});

test("textures from the game's files or outside the vehicle's resource are never copied", async () => {
  const outsideOf = async (options, colours = { 2: "#0000ff" }) => {
    const prepared = await prepareLensWrite({ ...setup(options).deps, colours });
    assert.equal(canWriteLens(prepared), false);
    assert.equal(prepared.files.some((file) => file.textures.some((texture) => texture.mode === "add")), false);
    await assert.rejects(writeLensTextures({ invoke: async () => ({}), prepared }), /unresolved problems/);
    return prepared.outside;
  };

  assert.deepEqual(await outsideOf({ lenses: [["c", "siren2", GAME, 0, 1]] }), [
    { texture: "vehicle_generic_emis", sirens: [2], reason: "which comes from the game's files" },
  ]);
  const other = [{ path: "C:\\other\\stream\\PackTxd.ytd", mtimeMs: 1, size: 1 }];
  assert.match((await outsideOf({ lenses: [["b", "siren2", PACK, 0, 1]], inputs: other }))[0].reason, /PackTxd\.ytd, outside this vehicle's resource/);
  assert.match((await outsideOf({ lenses: [["b", "siren2", PACK, 0, 1]], inputs: [] }))[0].reason, /cannot tell which file/);
  // Without a resource manifest only the model's own folder counts.
  const above = [{ path: "C:\\res\\PackTxd.ytd", mtimeMs: 1, size: 1 }];
  assert.equal((await outsideOf({ lenses: [["b", "siren2", PACK, 0, 1]], inputs: above, resource: null })).length, 1);

  const beside = await prepareLensWrite({ ...setup({ lenses: [["b", "siren2", PACK, 0, 1]], resource: null }).deps, colours: { 2: "#0000ff" } });
  assert.ok(canWriteLens(beside));
  assert.equal(beside.files[0].textures[0].source, PACK_YTD);

  // An untinted lens on a game texture is left alone and does not block the write.
  const untinted = await prepareLensWrite({ ...setup({ lenses: [["a", "siren1", OWN, 0, 1], ["c", "siren2", GAME, 0, 1]] }).deps, colours: { 1: "#00ff00" } });
  assert.deepEqual(untinted.outside, []);
  assert.ok(canWriteLens(untinted));
});

test("each dictionary's copy is recoloured from that copy", async () => {
  const { deps, read } = setup({ lenses: [["a", "siren1", OWN, 0, 1]] });
  await prepareLensWrite({ ...deps, colours: { 1: "#00ff00" } });
  assert.deepEqual(read, ["hi/Lens_A.dds", "low/Lens_A.dds"]);
});

test("untinted sirens on the same texels are listed, and different colours conflict", async () => {
  const lenses = [["a", "siren1", OWN, 0, 1], ["b", "siren2", OWN, 0, 1], ["c", "headlight_l", OWN, 0, 1]];
  const shared = await prepareLensWrite({ ...setup({ lenses }).deps, colours: { 1: "#00ff00" } });
  assert.deepEqual(shared.textures[0].alsoSirens, [2]);
  assert.equal(shared.textures[0].alsoOther, 1);
  assert.ok(canWriteLens(shared));

  const clash = await prepareLensWrite({ ...setup({ lenses }).deps, colours: { 1: "#00ff00", 2: "#ff0000" } });
  assert.deepEqual(clash.conflicts, [{ texture: "lens_a", sirens: [1, 2] }]);
  assert.equal(canWriteLens(clash), false);
  assert.deepEqual(lensConflictGroups(clash.conflicts, { 1: "#00ff00", 2: "#ff0000" }), [{
    sirens: [1, 2],
    textures: ["lens_a"],
    options: [{ colour: "#00ff00", sirens: [1] }, { colour: "#ff0000", sirens: [2] }],
  }]);
});

test("pairwise conflicts across textures merge into one group per set of sirens", () => {
  const conflicts = [
    { texture: "front", sirens: [3, 4] },
    { texture: "front", sirens: [3, 5] },
    { texture: "emissives", sirens: [5, 6] },
    { texture: "fog", sirens: [21, 28] },
  ];
  // Siren 7 already matches siren 3, so it joins the group rather than conflicting after the fix.
  const shares = [{ texture: "front", sirens: [3, 7] }, { texture: "other", sirens: [40, 41] }];
  const colours = { 3: "#ff0000", 4: "#0000ff", 5: "#ff0000", 6: "#0000ff", 7: "#ff0000", 21: "#ffffff", 28: "#ff0000", 40: "#ff0000", 41: "#ff0000" };
  assert.deepEqual(lensConflictGroups(conflicts, colours, shares), [
    { sirens: [3, 4, 5, 6, 7], textures: ["front", "emissives"], options: [{ colour: "#ff0000", sirens: [3, 5, 7] }, { colour: "#0000ff", sirens: [4, 6] }] },
    { sirens: [21, 28], textures: ["fog"], options: [{ colour: "#ffffff", sirens: [21] }, { colour: "#ff0000", sirens: [28] }] },
  ]);
});

test("textures inside the model and vehicles without their own dictionary are refused", async () => {
  const inner = await prepareLensWrite({ ...setup({ lenses: [["a", "siren3", INNER, 0, 1]] }).deps, colours: { 3: "#00ff00" } });
  assert.match(inner.problems[0], /inner \(siren 3\) is stored inside car_hi\.yft/);
  assert.equal(canWriteLens(inner), false);
  await assert.rejects(writeLensTextures({ invoke: async () => ({}), prepared: inner }), /unresolved problems/);

  const bare = await prepareLensWrite({ ...setup({ lenses: [["a", "siren1", PACK, 0, 1]], dictionaries: {} }).deps, colours: { 1: "#00ff00" } });
  assert.match(bare.blocked, /no texture dictionary of its own \(car\.ytd\)/);

  const none = await prepareLensWrite({ ...setup({ lenses: [["a", "siren1", OWN, 0, 1]] }).deps, colours: { 4: "#00ff00" } });
  assert.match(none.blocked, /None of these sirens/);
});

test("an unreadable copy is a problem, not a silent skip", async () => {
  const { deps } = setup({ lenses: [["a", "siren1", OWN, 0, 1]], dictionaries: { "car.ytd": [["Lens_A", "gone.dds"]] } });
  const prepared = await prepareLensWrite({ ...deps, colours: { 1: "#00ff00" } });
  assert.match(prepared.problems[0], /Lens_A in car\.ytd cannot be recoloured: missing gone\.dds/i);
  assert.equal(canWriteLens(prepared), false);
});

test("the write body carries a header and every texture in order", async () => {
  const { deps } = setup({ lenses: [["a", "siren1", OWN, 0, 0.5], ["b", "siren1", PACK, 0.5, 1]] });
  const prepared = await prepareLensWrite({ ...deps, colours: { 1: "#00ff00" } });
  const body = encodeLensWriteBody(prepared, "20261015-153012");
  const length = new DataView(body.buffer).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + length)));
  assert.equal(header.modelPath, "C:\\res\\stream\\car_hi.yft");
  assert.equal(header.stamp, "20261015-153012");
  assert.deepEqual(header.ytds.map((ytd) => ytd.path), ["C:\\res\\stream\\car+hi.ytd", "C:\\res\\stream\\car.ytd"]);
  // Only an added texture names a source, so the host can check where it came from.
  assert.deepEqual(header.ytds[0].textures.map(({ name, mode, source }) => [name, mode, source]), [
    ["Lens_A", "replace", undefined],
    ["Shared_Emis", "add", PACK_YTD],
  ]);
  const first = prepared.files[0].textures[0].bytes;
  assert.deepEqual(Array.from(body.subarray(4 + length, 4 + length + first.length)), Array.from(first));
  assert.equal(body.length, 4 + length + header.ytds.reduce((sum, ytd) => sum + ytd.textures.reduce((inner, texture) => inner + texture.length, 0), 0));

  let sent = null;
  await writeLensTextures({ invoke: async (command, payload) => { sent = [command, payload]; return { files: [] }; }, prepared, date: new Date(2026, 9, 15, 15, 30, 12) });
  assert.equal(sent[0], "write_lens_textures");
  assert.ok(sent[1] instanceof Uint8Array);
});
