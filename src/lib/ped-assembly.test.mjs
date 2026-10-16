import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import {
  acquireTexture,
  applyPropAttachment,
  assemblePed,
  buildDrawableGroup,
  buildSlotGroup,
  clearPedAssetCaches,
  computeGroupStats,
  computePedBounds,
  createPedRoot,
  disposeSlotGroup,
  findPedSkeleton,
  getTextureCacheSize,
  loadDrawableFromPath,
  releaseTexture,
  setGroupPose,
  setGroupSkinTint,
  setHeldPropSpec,
  setPedPose,
  setSlotHidden,
  updatePedHatHair,
  updatePedPropAttachments,
} from "./ped-assembly.js";
import { computeBoneRotations } from "./ped-pose.js";
import { buildStandardPedYdd, buildSyntheticDds } from "./eup-fixtures.mjs";

const YDD = buildStandardPedYdd();
const DDS = buildSyntheticDds();

test("props wait for the ped skeleton and follow their anchor bone transforms", () => {
  const root = createPedRoot();
  const hat = buildDrawableGroup({ models: [] }, { component: "p_head" });
  const watch = buildDrawableGroup({ models: [] }, { component: "p_lwrist" });
  root.add(hat, watch);
  updatePedPropAttachments(root);
  assert.equal(hat.visible, false);
  const body = buildDrawableGroup({ models: [], skeleton: { bones: [
    { tag: 0x796e, worldTx: 0, worldTy: 0.1, worldTz: 1.7, worldQx: 0, worldQy: 0, worldQz: 0, worldQw: 1 },
    { tag: 0xee4f, worldTx: 0.5, worldTy: 0.2, worldTz: 1, worldQx: 0, worldQy: 0, worldQz: 1, worldQw: 0 },
  ] } }, { component: "head" });
  root.add(body);
  updatePedPropAttachments(root);
  assert.equal(hat.visible, true);
  assert.deepEqual(hat.position.toArray(), [0, 0.1, 1.7]);
  assert.deepEqual(watch.position.toArray(), [0.5, 0.2, 1]);
  assert.deepEqual(watch.quaternion.toArray(), [0, 0, 1, 0]);
});

test("held props hang from their bone with an offset and stay out of the ped bounds", () => {
  const root = createPedRoot();
  const body = buildDrawableGroup({ models: [], skeleton: { bones: [
    { tag: 0x6f06, worldTx: 0.3, worldTy: 0, worldTz: 1, worldQx: 0, worldQy: 0, worldQz: 0, worldQw: 1 },
  ] } }, { component: "head" });
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 2));
  torso.position.z = 1;
  body.add(torso);
  const held = new THREE.Group();
  held.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1)));
  setHeldPropSpec(held, { bone: 0x6f06, position: [0, 0, -3], rotation: [0, 0, 0] });
  root.add(body, held);
  updatePedPropAttachments(root);
  assert.equal(held.visible, true);
  assert.deepEqual(held.position.toArray(), [0.3, 0, -2]);
  const bounds = computePedBounds(root);
  // The prop hangs 2 m below the floor; the bounds still end at the feet.
  assert.ok(Math.abs(bounds.min.y) < 1e-6, `min y ${bounds.min.y}`);

  setHeldPropSpec(held, { bone: 0x1234, position: [0, 0, 0], rotation: [0, 0, 0] });
  updatePedPropAttachments(root);
  assert.equal(held.visible, false, "a bone the skeleton lacks hides the prop");
});

function makeReadFile(log = []) {
  return async (path) => {
    log.push(path);
    if (path.endsWith(".ydd")) return YDD;
    if (path.endsWith(".dds")) return DDS;
    throw new Error(`missing ${path}`);
  };
}

test("buildDrawableGroup turns parsed meshes into standard materials with ped profiles", () => {
  const drawable = {
    name: "test",
    models: [
      {
        meshes: [
          {
            name: "body",
            materialName: "ped_default",
            positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
            uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
            indices: new Uint32Array([0, 1, 2]),
          },
          {
            name: "hair",
            materialName: "ped_hair_cutout_alpha",
            positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
            normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
            indices: new Uint32Array([0, 1, 2]),
          },
          { name: "empty", positions: new Float32Array(0) },
        ],
      },
    ],
  };
  const group = buildDrawableGroup(drawable, { component: "hair" });
  assert.equal(group.name, "hair");
  assert.equal(group.children.length, 2);
  const [body, hair] = group.children;
  assert.ok(body.geometry.attributes.normal, "normals are computed when missing");
  assert.equal(body.material.alphaTest, 0);
  assert.equal(hair.material.alphaTest, 0.5);
  assert.equal(hair.material.userData.pedProfile.isCutout, true);
  disposeSlotGroup(group);
});

test("loadDrawableFromPath caches by path and rejects invalid bytes", async () => {
  clearPedAssetCaches();
  const log = [];
  const readFile = makeReadFile(log);
  const first = await loadDrawableFromPath("a/uppr_000_u.ydd", { readFile });
  const second = await loadDrawableFromPath("a/uppr_000_u.ydd", { readFile });
  assert.equal(first, second);
  assert.equal(log.length, 1);
  await assert.rejects(
    loadDrawableFromPath("bad.ydd", { readFile: async () => new Uint8Array(8) }),
    /No drawable geometry/,
  );
  await assert.rejects(loadDrawableFromPath("", { readFile }), /required/);
});

test("texture references are counted and disposed on release", async () => {
  clearPedAssetCaches();
  const readFile = makeReadFile();
  const texture = await acquireTexture("t/uppr_diff_000_a_uni.dds", { readFile });
  const again = await acquireTexture("t/uppr_diff_000_a_uni.dds", { readFile });
  assert.equal(texture, again);
  assert.equal(getTextureCacheSize(), 1);
  let disposed = 0;
  texture.addEventListener("dispose", () => { disposed += 1; });
  releaseTexture("t/uppr_diff_000_a_uni.dds");
  assert.equal(getTextureCacheSize(), 1);
  releaseTexture("t/uppr_diff_000_a_uni.dds");
  assert.equal(getTextureCacheSize(), 0);
  assert.equal(disposed, 1);
});

test("buildSlotGroup binds the diffuse texture and disposeSlotGroup releases it", async () => {
  clearPedAssetCaches();
  const readFile = makeReadFile();
  const group = await buildSlotGroup({
    component: "uppr",
    drawablePath: "a/uppr_000_u.ydd",
    texturePaths: ["t/uppr_diff_000_a_uni.dds", "t/uppr_normal_000.dds", "t/uppr_spec_000.dds"],
    readFile,
  });
  assert.equal(group.userData.component, "uppr");
  assert.equal(group.children.length, 1);
  const mesh = group.children[0];
  assert.ok(mesh.material.map, "diffuse map bound");
  assert.ok(mesh.material.normalMap, "normal map bound");
  assert.equal(group.userData.texturePaths.specular, "t/uppr_spec_000.dds");
  assert.equal(getTextureCacheSize(), 2);
  disposeSlotGroup(group);
  assert.equal(getTextureCacheSize(), 0);
});

test("buildSlotGroup uses a caller's image as the diffuse and disposes it with the slot", async () => {
  clearPedAssetCaches();
  const readFile = makeReadFile();
  const image = await acquireTexture("t/design.dds", { readFile });
  let disposed = 0;
  image.addEventListener("dispose", () => { disposed += 1; });
  let released = 0;
  image.userData.releaseSource = () => { released += 1; };
  const group = await buildSlotGroup({
    component: "jbib",
    drawablePath: "a/vest.ydd",
    texturePaths: ["t/jbib_diff_000_a_uni.dds", "t/jbib_normal_000.dds"],
    diffuseTexture: image,
    readFile,
  });
  const mesh = group.children[0];
  assert.equal(mesh.material.map, image, "the image replaces the dictionary diffuse");
  assert.ok(mesh.material.normalMap, "the dictionary normal map still binds");
  assert.equal(group.userData.textureInfo.diffuse.name, image.name);
  disposeSlotGroup(group);
  assert.equal(disposed, 1);
  assert.equal(released, 1);
  assert.deepEqual(group.userData.ownedTextures, []);
  releaseTexture("t/design.dds");
});

test("buildSlotGroup keeps the drawable when a texture fails to decode", async () => {
  clearPedAssetCaches();
  const readFile = async (path) => {
    if (path.endsWith(".ydd")) return YDD;
    return new Uint8Array(16);
  };
  const group = await buildSlotGroup({
    component: "lowr",
    drawablePath: "a/lowr_000_u.ydd",
    texturePaths: ["t/lowr_diff_000_a_uni.dds"],
    readFile,
  });
  assert.equal(group.children.length, 1);
  assert.equal(group.children[0].material.map, null);
  assert.equal(group.userData.textureErrors.length, 1);
  assert.equal(group.userData.textureErrors[0].role, "diffuse");
  disposeSlotGroup(group);
  assert.equal(getTextureCacheSize(), 0);
});

test("buildSlotGroup honours an aborted signal and releases textures", async () => {
  clearPedAssetCaches();
  const controller = new AbortController();
  const readFile = async (path) => {
    controller.abort();
    if (path.endsWith(".ydd")) return YDD;
    return DDS;
  };
  await assert.rejects(
    buildSlotGroup({
      component: "uppr",
      drawablePath: "a/uppr_000_u.ydd",
      texturePaths: ["t/uppr_diff_000_a_uni.dds"],
      readFile,
      signal: controller.signal,
    }),
    (error) => error.name === "AbortError",
  );
  assert.equal(getTextureCacheSize(), 0);
});

test("assemblePed composes slots under a Y-up root and reports failures per slot", async () => {
  clearPedAssetCaches();
  const readFile = async (path) => {
    if (path.includes("broken")) throw new Error("disk error");
    if (path.endsWith(".ydd")) return YDD;
    return DDS;
  };
  const states = {};
  const root = await assemblePed({
    slots: {
      uppr: { drawablePath: "a/uppr_000_u.ydd", texturePaths: ["t/uppr_diff_000_a_uni.dds"] },
      lowr: { drawablePath: "a/broken_lowr_000_u.ydd", texturePaths: [] },
      skip: { drawablePath: null },
    },
    readFile,
    onSlot: (component, state) => { states[component] = state.status; },
  });
  assert.equal(root.rotation.x, -Math.PI / 2);
  assert.equal(root.children.length, 1);
  assert.equal(states.uppr, "ready");
  assert.equal(states.lowr, "error");
  assert.equal(states.skip, undefined);

  const bounds = computePedBounds(root);
  assert.ok(bounds);
  // GTA z (0.3 .. 1.8) becomes three.js y after the root rotation.
  assert.ok(Math.abs(bounds.min.y - -0.75) < 1e-5);
  assert.ok(Math.abs(bounds.max.y - 1.8) < 1e-5);

  for (const child of [...root.children]) disposeSlotGroup(child);
  assert.equal(root.children.length, 0);
  assert.equal(getTextureCacheSize(), 0);
  assert.equal(computePedBounds(createPedRoot()), null);
});

test("user-hidden props stay hidden after the skeleton attaches them", () => {
  const root = createPedRoot();
  const hat = buildDrawableGroup({ models: [] }, { component: "p_head" });
  const top = buildDrawableGroup({ models: [] }, { component: "jbib" });
  root.add(hat, top);
  setSlotHidden(hat, true);
  setSlotHidden(top, true);
  assert.equal(top.visible, false);
  const body = buildDrawableGroup({ models: [], skeleton: { bones: [
    { tag: 0x796e, worldTx: 0, worldTy: 0, worldTz: 1.7, worldQx: 0, worldQy: 0, worldQz: 0, worldQw: 1 },
  ] } }, { component: "head" });
  root.add(body);
  updatePedPropAttachments(root);
  assert.equal(hat.visible, false);
  assert.deepEqual(hat.position.toArray(), [0, 0, 1.7]);
  setSlotHidden(hat, false);
  setSlotHidden(top, false);
  assert.equal(hat.visible, true);
  assert.equal(top.visible, true);
  assert.equal(findPedSkeleton(root), body.userData.skeleton);

  const loose = buildDrawableGroup({ models: [] }, { component: "p_eyes" });
  assert.equal(applyPropAttachment(loose, null), false);
  assert.equal(applyPropAttachment(top, body.userData.skeleton), false);
  setSlotHidden(loose, false);
  assert.equal(loose.visible, false, "an unattached prop waits for its bone");
});

test("buildSlotGroup records geometry stats and decoded texture headers", async () => {
  clearPedAssetCaches();
  const readFile = async (path) => (path.endsWith(".ydd") ? YDD : DDS);
  const group = await buildSlotGroup({
    component: "uppr",
    drawablePath: "stats/uppr_000_u.ydd",
    texturePaths: ["t/uppr_diff_000_a_uni.dds", "t/uppr_normal_000.dds", "t/uppr_spec_000.dds", "t/extra.dds"],
    readFile,
  });
  const stats = group.userData.stats;
  assert.deepEqual(stats, computeGroupStats(group));
  assert.ok(stats.meshes > 0);
  assert.ok(stats.vertices > 0);
  assert.ok(stats.triangles > 0);
  assert.equal(group.userData.textureInfo.diffuse.name, "uppr_diff_000_a_uni.dds");
  assert.equal(group.userData.textureInfo.diffuse.width, 2);
  assert.equal(group.userData.textureInfo.diffuse.height, 2);
  assert.ok(group.userData.textureInfo.normal);
  assert.equal(group.userData.textureInfo.specular, undefined, "specular is listed, not decoded");
  assert.equal(group.userData.textureNames.length, 4);
  disposeSlotGroup(group);
  assert.equal(getTextureCacheSize(), 0);
});

// Root -> left upper arm -> forearm -> hand, arm hanging out from the body.
function armBone(tag, parentIndex, t, world) {
  return { tag, parentIndex, tx: t[0], ty: t[1], tz: t[2], qx: 0, qy: 0, qz: 0, qw: 1,
    worldTx: world[0], worldTy: world[1], worldTz: world[2], worldQx: 0, worldQy: 0, worldQz: 0, worldQw: 1 };
}
const ARM_SKELETON = { bones: [
  armBone(0, 0xffff, [0, 0, 0], [0, 0, 0]),
  armBone(0xb1c5, 0, [0.2, 0, 0.45], [0.2, 0, 0.45]),
  armBone(0xeeeb, 1, [0.15, 0, -0.23], [0.35, 0, 0.22]),
  armBone(0x49d9, 2, [0.14, 0, -0.21], [0.49, 0, 0.01]),
  armBone(0xee4f, 2, [0.07, 0, -0.105], [0.42, 0, 0.115]),
] };
// One triangle around the wrist, fully weighted to the forearm.
const FOREARM_DRAWABLE = { models: [{ meshes: [{
  materialName: "ped_default",
  positions: new Float32Array([0.45, 0, 0.05, 0.47, 0.02, 0.03, 0.46, -0.02, 0.02]),
  indices: new Uint16Array([0, 1, 2]),
  skinIndices: new Uint16Array([2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0]),
  skinWeights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
}] }] };

test("skinned slots follow the pose and props stay on their posed bone", () => {
  const root = createPedRoot();
  const sleeve = buildDrawableGroup(FOREARM_DRAWABLE, { component: "uppr", skeleton: ARM_SKELETON });
  const mesh = sleeve.children.find((child) => child.isSkinnedMesh);
  assert.ok(mesh, "a skinned mesh is built when the shared skeleton is known");
  assert.equal(sleeve.userData.bones.length, ARM_SKELETON.bones.length);
  const watch = buildDrawableGroup({ models: [] }, { component: "p_lwrist" });
  root.add(sleeve, watch);

  const bindMaxX = computePedBounds(root).max.x;
  const rotations = computeBoneRotations(ARM_SKELETON, [{ bone: "lUpperArm", axis: [0, 1, 0], deg: 27 }, { bone: "lForearm", axis: [1, 0, 0], deg: -14 }]);
  setPedPose(root, ARM_SKELETON, rotations);
  const posedMaxX = computePedBounds(root).max.x;
  assert.ok(posedMaxX < bindMaxX - 0.05, "the posed forearm moves in toward the body");

  assert.equal(watch.visible, true);
  assert.ok(watch.position.x < 0.42 - 0.03, "the watch follows the posed forearm roll bone");

  setGroupPose(sleeve, null);
  assert.ok(Math.abs(computePedBounds(root).max.x - bindMaxX) < 1e-6, "clearing the pose restores the bind pose");

  let disposed = false;
  sleeve.userData.rig.dispose = () => { disposed = true; };
  disposeSlotGroup(sleeve);
  assert.equal(disposed, true, "the slot's skeleton is disposed with it");
});

test("slots stay rigid without a shared skeleton or when bone indices do not fit it", () => {
  assert.ok(!buildDrawableGroup(FOREARM_DRAWABLE, { component: "uppr" }).children.some((child) => child.isSkinnedMesh));
  const short = { bones: ARM_SKELETON.bones.slice(0, 2) };
  assert.ok(!buildDrawableGroup(FOREARM_DRAWABLE, { component: "uppr", skeleton: short }).children.some((child) => child.isSkinnedMesh));
  const prop = buildDrawableGroup(FOREARM_DRAWABLE, { component: "p_lwrist", skeleton: ARM_SKELETON });
  assert.ok(!prop.children.some((child) => child.isSkinnedMesh), "props keep bone-local vertices");
});

test("skin tint only changes slots marked as skin", () => {
  const texture = { isTexture: true };
  const skin = buildDrawableGroup(FOREARM_DRAWABLE, { component: "uppr", textures: { diffuse: texture } });
  const shirt = buildDrawableGroup(FOREARM_DRAWABLE, { component: "jbib", textures: { diffuse: texture } });
  skin.userData.skinTintable = true;
  assert.equal(setGroupSkinTint(skin, "#6e5648"), true);
  assert.equal(setGroupSkinTint(shirt, "#6e5648"), false);
  assert.equal(skin.children[0].material.color.getHexString(), "6e5648");
  assert.equal(shirt.children[0].material.color.getHexString(), "ffffff");
  setGroupSkinTint(skin, null);
  assert.equal(skin.children[0].material.color.getHexString(), "ffffff");
});

test("hair materials take the hair and highlight colours; other materials ignore them", async () => {
  const { setGroupHairColor } = await import("./ped-assembly.js");
  const texture = { isTexture: true };
  const hairMesh = { materialName: "ped_hair_spiked", positions: new Float32Array(9), indices: new Uint16Array([0, 1, 2]) };
  const hair = buildDrawableGroup({ models: [{ meshes: [hairMesh] }] }, { component: "hair", textures: { diffuse: texture } });
  const shirt = buildDrawableGroup({ models: [{ meshes: [{ ...hairMesh, materialName: "ped" }] }] }, { component: "jbib", textures: { diffuse: texture } });
  const uniforms = hair.children[0].material.userData.hairUniforms;
  assert.ok(uniforms, "hair shading is installed on hair materials");
  assert.equal(hair.children[0].material.alphaToCoverage, true);
  assert.equal(setGroupHairColor(hair, { color: "#8c1d1d", highlight: "#b8955f" }), true);
  assert.equal(uniforms.uHairColor.value.getHexString(), "8c1d1d");
  assert.equal(uniforms.uHairHighlight.value.getHexString(), "b8955f");
  assert.equal(setGroupHairColor(shirt, { color: "#8c1d1d" }), false);
});

test("hair layers the game hides by default are not drawn", async () => {
  const { isHiddenHairLayer } = await import("./ped-assembly.js");
  const strands = { materialName: "ped_hair_spiked", orderNumber: 0, positions: new Float32Array(9), indices: new Uint16Array([0, 1, 2]) };
  const shell = { ...strands, orderNumber: 1 };
  assert.equal(isHiddenHairLayer(shell), true);
  assert.equal(isHiddenHairLayer(strands), false);
  assert.equal(isHiddenHairLayer({ ...shell, materialName: "ped_hair_cutout_alpha" }), false, "only spiked hair uses the order layers");
  const group = buildDrawableGroup({ models: [{ meshes: [strands, shell] }] }, { component: "hair" });
  assert.equal(group.children.filter((child) => child.isMesh).length, 1);
});

// Head with the two hair helper bones 0.093 above it, and one hair triangle
// fully weighted to the crown.
const HEAD_SKELETON = { bones: [
  armBone(0, 0xffff, [0, 0, 0], [0, 0, 0]),
  armBone(0x796e, 0, [0, 0, 0.6], [0, 0, 0.6]),
  armBone(0xc664, 1, [0.093, 0, 0], [0.093, 0, 0.6]),
  armBone(0x1675, 1, [0.093, 0, 0], [0.093, 0, 0.6]),
] };
const CROWN_HAIR = { models: [{ meshes: [{
  materialName: "ped_hair_cutout_alpha",
  positions: new Float32Array([0.15, 0.04, 0.6, 0.15, -0.04, 0.6, 0.12, 0, 0.66]),
  indices: new Uint16Array([0, 1, 2]),
  skinIndices: new Uint16Array([3, 0, 0, 0, 3, 0, 0, 0, 3, 0, 0, 0]),
  skinWeights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
}] }] };

test("a shown hat crushes the hair helper bones the way the game's expression does", () => {
  const root = createPedRoot();
  // The drawable carries the skeleton the way the head drawable does, so props can attach.
  const hair = buildDrawableGroup({ ...CROWN_HAIR, skeleton: HEAD_SKELETON }, { component: "hair", skeleton: HEAD_SKELETON });
  root.add(hair);
  const bareSize = computePedBounds(root).getSize(new THREE.Vector3());
  const [, , scale, crown] = hair.userData.bones;

  const hat = buildDrawableGroup({ models: [] }, { component: "p_head" });
  root.add(hat);
  updatePedPropAttachments(root);
  assert.equal(hat.visible, true);
  assert.equal(hair.userData.hatHair, true);
  assert.ok(Math.abs(scale.scale.x - 0.81) < 1e-6, "MH_Hair_Scale scales by 1 + hair crush");
  assert.ok(Math.abs(crown.position.x - (0.093 - 0.047)) < 1e-6, "MH_Hair_Crown drops along the head's up axis");
  assert.ok(Math.abs(crown.scale.y - 0.53) < 1e-6 && crown.scale.x === 1, "the crown narrows across, not along, the up axis");
  const crushedSize = computePedBounds(root).getSize(new THREE.Vector3());
  assert.ok(crushedSize.x + crushedSize.z < bareSize.x + bareSize.z - 0.03, "the hair narrows under the hat");

  // The crush survives posing, and hiding the hat restores the hair.
  setPedPose(root, HEAD_SKELETON, null);
  assert.ok(Math.abs(crown.scale.y - 0.53) < 1e-6);
  setSlotHidden(hat, true);
  assert.equal(hair.userData.hatHair, false);
  assert.equal(crown.position.x, 0.093);
  assert.equal(scale.scale.x, 1);
  updatePedHatHair(root);
  assert.equal(crown.scale.y, 1);
});

// mp_m_freemode_01: forearm -> RB_L_ForeArmRoll (0.1296 m) and SKEL_L_Hand (0.2592 m)
// along the forearm axis; p_lwrist_001.ydd is centred 0.1246 m along its anchor's X.
test("watches land on the wrist, not the hand", () => {
  const bone = (tag, x) => ({ tag, worldTx: x, worldTy: 0, worldTz: 0, worldQx: 0, worldQy: 0, worldQz: 0, worldQw: 1 });
  const skeleton = { bones: [bone(0xeeeb, 0), bone(0xee4f, 0.1296), bone(0x49d9, 0.2592), bone(0xab22, -0.1296), bone(0xdead, -0.2592)] };
  const left = buildDrawableGroup({ models: [] }, { component: "p_lwrist" });
  assert.equal(applyPropAttachment(left, skeleton), true);
  const centre = left.position.x + 0.1246;
  assert.ok(Math.abs(centre - 0.2592) < 0.01, `watch centre ${centre.toFixed(4)} sits within 1 cm of the wrist joint`);
  const right = buildDrawableGroup({ models: [] }, { component: "p_rwrist" });
  assert.equal(applyPropAttachment(right, skeleton), true);
  assert.equal(right.position.x, -0.1296, "right wrist props hang from RB_R_ForeArmRoll");
});
