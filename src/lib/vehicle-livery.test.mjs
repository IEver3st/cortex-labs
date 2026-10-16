import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createLiveryOverride, findLiverySignPrefix, listTextureLiveries } from "./vehicle-livery.js";
import { DEPTH_ONLY_RENDER_ORDER, makeDepthOnlyOccluder, releaseDepthOnlyOccluder } from "./native-occluder.js";

function signMesh(textureName = "police4_sign_1") {
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
  mesh.userData.nativeMaterial = {
    shaderName: "vehicle_paint3",
    textureBindings: [{ paramName: "DiffuseSampler", textureName, usage: "baseColor", uvSet: 0, resolvedPath: `C:/cache/${textureName}.dds` }],
  };
  mesh.userData.nativeMaterialObject = mesh.material;
  return mesh;
}

const PARENT = {
  manifestPath: "C:\\cache\\police4\\manifest.json",
  textures: [
    { name: "police4_sign_1", relativePath: "textures/police4_sign_1.dds" },
    { name: "POLICE4_SIGN_3", relativePath: "textures/police4_sign_3.dds" },
    { name: "police4_sign_2", relativePath: "textures/police4_sign_2.dds" },
    { name: "other_sign_4", relativePath: "textures/other_sign_4.dds" },
    { name: "police4_sign_5", relativePath: "" },
  ],
};

test("texture liveries are the bound sign's numbers in the dictionary chain", () => {
  const meshes = [new THREE.Mesh(), signMesh()];
  assert.equal(findLiverySignPrefix(meshes), "police4");
  const list = listTextureLiveries(meshes, PARENT);
  assert.equal(list.prefix, "police4");
  assert.deepEqual(list.numbers, [1, 2, 3]);
  assert.equal(list.paths.get(3), "C:\\cache\\police4\\textures\\police4_sign_3.dds");
});

test("nothing to switch between gives no list", () => {
  assert.equal(listTextureLiveries([signMesh()], { ...PARENT, textures: PARENT.textures.slice(0, 1) }), null);
  assert.equal(listTextureLiveries([signMesh("police4_d")], PARENT), null);
  assert.equal(listTextureLiveries([signMesh()], null), null);
});

test("a texture livery swaps the bound sign and restores it exactly", () => {
  const mesh = signMesh();
  const original = new THREE.Texture();
  mesh.material.map = original;
  const sign = new THREE.Texture();
  const override = createLiveryOverride(() => true);

  override.apply([mesh], { sign });
  assert.notEqual(mesh.material.map, original);
  assert.equal(mesh.material.map.source, sign.source);
  assert.equal(override.active, true);

  override.apply([mesh], {});
  assert.equal(mesh.material.map, original);
  assert.equal(override.active, false);

  override.apply([mesh], { sign });
  override.dispose();
  assert.equal(mesh.material.map, original);
});

test("forget drops what was replaced without touching the materials", () => {
  const mesh = signMesh();
  const original = new THREE.Texture();
  mesh.material.map = original;
  const override = createLiveryOverride(() => true);
  override.apply([mesh], { sign: new THREE.Texture() });
  const shown = mesh.material.map;
  override.forget();
  override.restore();
  assert.equal(mesh.material.map, shown);
});

test("a blank sign decal stays a decal: picking a livery swaps its map and restoring puts the blank back", () => {
  const mesh = signMesh();
  const blank = new THREE.Texture();
  blank.userData.fullyTransparent = true;
  mesh.material.map = blank;
  const override = createLiveryOverride(() => true);

  override.apply([mesh], { sign: new THREE.Texture() });
  assert.notEqual(mesh.material.map, blank);
  assert.equal(mesh.material.colorWrite, true);

  override.restore();
  assert.equal(mesh.material.map, blank);
});

test("a livery override never changes a lamp blocker's occluder state", () => {
  const sign = signMesh();
  const blocker = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
  blocker.userData.nativeMaterial = {
    shaderName: "vehicle_badges",
    renderBucket: 0,
    textureBindings: [{ paramName: "DiffuseSampler", textureName: "emiblocker", usage: "baseColor", uvSet: 0, resolvedPath: "C:/cache/emiblocker.dds" }],
  };
  blocker.userData.nativeMaterialObject = blocker.material;
  makeDepthOnlyOccluder(blocker.material, blocker);
  const override = createLiveryOverride(() => true);

  override.apply([sign, blocker], { sign: new THREE.Texture() });
  override.forget();
  assert.equal(blocker.userData.nativeDepthOnly, true);
  assert.equal(blocker.material.userData.nativeDepthOnly, true);
  assert.equal(blocker.material.colorWrite, false);
  assert.equal(blocker.renderOrder, DEPTH_ONLY_RENDER_ORDER);

  // What native-materials' dispose runs for every occluder it made.
  blocker.receiveShadow = true;
  releaseDepthOnlyOccluder(blocker);
  assert.equal(blocker.renderOrder, 0);
  assert.equal(blocker.castShadow, true);
});
