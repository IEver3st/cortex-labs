import test from "node:test";
import assert from "node:assert/strict";

import { isYtdTexturePath, pickDictionaryTexture } from "./ytd-texture.js";

const dict = "C:/pack/stream/mp_m_freemode_01_mp_m_pack^task_diff_000_a_uni.ytd";

test("the texture named after the dictionary wins", () => {
  const picked = pickDictionaryTexture([
    { name: "task_normal_000", path: "n.dds" },
    { name: "task_diff_000_a_uni", path: "d.dds" },
  ], dict);
  assert.equal(picked.path, "d.dds");
});

test("a diffuse map comes before other maps", () => {
  const picked = pickDictionaryTexture([
    { name: "vest_n", path: "n.dds" },
    { name: "vest_spec", path: "s.dds" },
    { name: "vest_diff_a", path: "d.dds" },
  ], "C:/x/vest.ytd");
  assert.equal(picked.path, "d.dds");
});

test("normal and specular maps are skipped when nothing is named diffuse", () => {
  const picked = pickDictionaryTexture([
    { name: "vest_n", path: "n.dds" },
    { name: "vest_s", path: "s.dds" },
    { name: "vest_colour", path: "c.dds" },
  ], "C:/x/vest.ytd");
  assert.equal(picked.path, "c.dds");
});

test("a dictionary of detail maps still shows its first texture", () => {
  const picked = pickDictionaryTexture([{ name: "a_n", path: "n.dds" }], "C:/x/a.ytd");
  assert.equal(picked.path, "n.dds");
});

test("an empty or malformed export has no texture", () => {
  assert.equal(pickDictionaryTexture([], dict), null);
  assert.equal(pickDictionaryTexture(null, dict), null);
  assert.equal(pickDictionaryTexture([{ name: "x" }, { path: "y.dds" }], dict), null);
});

test("ytd paths are recognised by extension", () => {
  assert.ok(isYtdTexturePath(dict));
  assert.ok(isYtdTexturePath("C:/A.YTD"));
  assert.ok(!isYtdTexturePath("C:/a.ytd.png"));
  assert.ok(!isYtdTexturePath(""));
});
