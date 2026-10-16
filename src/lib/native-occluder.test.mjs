import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  DEPTH_ONLY_RENDER_ORDER,
  isClosedSurface,
  isLampBlocker,
  makeDepthOnlyOccluder,
  releaseDepthOnlyOccluder,
} from "./native-occluder.js";

function blank() {
  const texture = new THREE.Texture();
  texture.userData.fullyTransparent = true;
  return texture;
}

function binding(textureName, paramName = "DiffuseSampler") {
  return { paramName, textureName, usage: "baseColor", uvSet: 0, resolvedPath: `C:/cache/${textureName}.dds` };
}

// A GSD blocker box: 1-3 mm outside a lens, corners split per face like bridge meshes.
function box(width = 0.05, height = 0.005, depth = 0.02) {
  return new THREE.BoxGeometry(width, height, depth);
}

function merge(...geometries) {
  const positions = [];
  for (const geometry of geometries) {
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    positions.push(...flat.getAttribute("position").array);
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return merged;
}

test("a GSD emiblocker badge box with a blank diffuse is a lamp blocker", () => {
  assert.equal(isLampBlocker({ shaderName: "vehicle_badges", boneChain: ["chassis", "misc_d"] }, binding("emiblocker"), blank(), box()), true);
  // Several boxes in one mesh, one per hidden lamp.
  const boxes = merge(box(), box().translate(0.2, 0, 0), box(0.1, 0.01, 0.01).translate(-0.3, 0, 0));
  assert.equal(isLampBlocker({ shaderName: "vehicle_badges" }, binding("emiblocker"), blank(), boxes), true);
});

test("a blank badge sheet over a window is not a lamp blocker", () => {
  // Window decal templates are open sheets; occluding with one hid every
  // rear deck and interior siren behind the glass.
  const sheet = new THREE.PlaneGeometry(1.1, 0.7, 6, 4);
  assert.equal(isLampBlocker({ shaderName: "vehicle_badges", boneChain: ["chassis", "windscreen_r"] }, binding("2022chargerwindowtemplate"), blank(), sheet), false);
  assert.equal(isLampBlocker({ shaderName: "vehicle_badges" }, binding("emiblocker"), blank(), null), false);
  // An open-ended tube is not closed either.
  assert.equal(isClosedSurface(new THREE.CylinderGeometry(0.05, 0.05, 0.2, 8, 1, true)), false);
});

test("two coincident sheets wound against each other enclose nothing", () => {
  const front = new THREE.PlaneGeometry(0.3, 0.2);
  const back = new THREE.PlaneGeometry(0.3, 0.2).rotateY(Math.PI);
  assert.equal(isClosedSurface(merge(front, back)), false);
  assert.equal(isClosedSurface(box()), true);
  assert.equal(isClosedSurface(merge(box())), true);
});

test("a blank _sign_1 livery decal is not a lamp blocker", () => {
  assert.equal(isLampBlocker({ shaderName: "vehicle_decal2" }, binding("police4_sign_1"), blank()), false);
  assert.equal(isLampBlocker({ shaderName: "vehicle_decal" }, binding("police4_sign_1"), blank()), false);
  // Even a badge shader leaves a livery sign alone.
  assert.equal(isLampBlocker({ shaderName: "vehicle_badges" }, binding("police4_sign_1"), blank()), false);
});

test("blank decals, visible badges and non-decal badge shaders are not lamp blockers", () => {
  assert.equal(isLampBlocker({ shaderName: "vehicle_decal" }, binding("blank_decal"), blank()), false);
  assert.equal(isLampBlocker({ shaderName: "vehicle_badges" }, binding("emiblocker"), new THREE.Texture()), false);
  assert.equal(isLampBlocker({ shaderName: "vehicle_badges" }, binding("emiblocker"), null), false);
  // A cutout alpha-tests every texel away in game, so it writes no depth either.
  assert.equal(isLampBlocker({ shaderName: "vehicle_badges_cutout" }, binding("emiblocker"), blank()), false);
  assert.equal(isLampBlocker(null, binding("emiblocker"), blank()), false);
});

test("an occluder writes depth only and is released to the mesh's bucket and shadow flag", () => {
  const material = new THREE.MeshStandardMaterial({ map: new THREE.Texture(), transparent: true });
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  mesh.userData.nativeMaterial = { shaderName: "vehicle_badges", renderBucket: 0 };
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  makeDepthOnlyOccluder(material, mesh);
  assert.equal(material.colorWrite, false);
  assert.equal(material.depthWrite, true);
  assert.equal(material.transparent, false);
  assert.equal(material.map, null);
  assert.equal(material.polygonOffsetFactor, -2);
  assert.equal(mesh.renderOrder, DEPTH_ONLY_RENDER_ORDER);
  assert.equal(mesh.castShadow, false);
  assert.equal(mesh.userData.nativeDepthOnly, true);

  releaseDepthOnlyOccluder(mesh);
  assert.equal(mesh.renderOrder, 0);
  assert.equal(mesh.castShadow, true);
  assert.equal(mesh.userData.nativeDepthOnly, undefined);
});

test("release restores render state even when the mesh flag was cleared elsewhere", () => {
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
  mesh.userData.nativeMaterial = { shaderName: "vehicle_badges", renderBucket: 2 };
  mesh.receiveShadow = true;
  makeDepthOnlyOccluder(mesh.material, mesh);
  mesh.userData.nativeDepthOnly = false;

  releaseDepthOnlyOccluder(mesh);
  assert.equal(mesh.renderOrder, 2);
  assert.equal(mesh.castShadow, true);
});
