import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  ambientOcclusionRadius,
  createAoPipeline,
  disposeAoPipeline,
  GLOW_LAYER,
  setAoBounds,
  skipsAmbientOcclusion,
} from "./viewer-render-effects.js";

const fakeRenderer = { getPixelRatio: () => 1 };

function mesh(materialOptions = {}) {
  return new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial(materialOptions));
}

test("opaque model meshes feed the AO depth pass", () => {
  assert.equal(skipsAmbientOcclusion(mesh()), false);
  assert.equal(skipsAmbientOcclusion(new THREE.Group()), false);
});

test("see-through, cut-out and wireframe surfaces never occlude", () => {
  assert.equal(skipsAmbientOcclusion(mesh({ transparent: true, opacity: 0.4 })), true);
  assert.equal(skipsAmbientOcclusion(mesh({ alphaTest: 0.5 })), true);
  assert.equal(skipsAmbientOcclusion(mesh({ depthWrite: false })), true);
  assert.equal(skipsAmbientOcclusion(mesh({ wireframe: true })), true);
  const physicalGlass = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshPhysicalMaterial({ transmission: 1 }));
  assert.equal(skipsAmbientOcclusion(physicalGlass), true);
});

test("native glass shaders, lamp glow and self-rendering objects are left out", () => {
  const glass = mesh();
  glass.userData.nativeMaterial = { shaderName: "vehicle_vehglass" };
  assert.equal(skipsAmbientOcclusion(glass), true);

  const glow = mesh();
  glow.layers.set(GLOW_LAYER);
  assert.equal(skipsAmbientOcclusion(glow), true);

  const mirror = mesh();
  mirror.onBeforeRender = () => {};
  assert.equal(skipsAmbientOcclusion(mirror), true);

  assert.equal(skipsAmbientOcclusion(new THREE.Sprite()), true);
  assert.equal(skipsAmbientOcclusion(new THREE.LineSegments()), true);
});

test("a mesh with one opaque material group still occludes", () => {
  const mixed = new THREE.Mesh(new THREE.BoxGeometry(), [
    new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.3 }),
    new THREE.MeshStandardMaterial(),
  ]);
  assert.equal(skipsAmbientOcclusion(mixed), false);
});

test("AO radius follows model size within sane limits", () => {
  const car = new THREE.Box3(new THREE.Vector3(-1, 0, -2.4), new THREE.Vector3(1, 1.5, 2.4));
  const radius = ambientOcclusionRadius(car);
  assert.ok(radius > 0.2 && radius < 0.4, `car radius ${radius}`);
  const bolt = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.01, 0.01, 0.01));
  assert.equal(ambientOcclusionRadius(bolt), 0.04);
  const ship = new THREE.Box3(new THREE.Vector3(-200, 0, -200), new THREE.Vector3(200, 50, 200));
  assert.equal(ambientOcclusionRadius(ship), 1.2);
  assert.ok(ambientOcclusionRadius(null) > 0);
  assert.ok(ambientOcclusionRadius(new THREE.Box3()) > 0);
});

test("AO clip box tracks model bounds and only changes when they move", () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const ao = createAoPipeline({ renderer: fakeRenderer, scene, camera, width: 640, height: 360 });
  assert.equal(ao.enabled, false);
  assert.equal(ao.aoPass.gtaoMaterial.defines.SCENE_CLIP_BOX, 0);

  const bounds = new THREE.Box3(new THREE.Vector3(-1, 0, -2), new THREE.Vector3(1, 1.4, 2));
  setAoBounds(ao, bounds);
  assert.equal(ao.aoPass.gtaoMaterial.defines.SCENE_CLIP_BOX, 1);
  assert.deepEqual(ao.aoPass.gtaoMaterial.uniforms.sceneBoxMax.value.toArray(), [1, 1.4, 2]);
  assert.equal(ao.aoPass.gtaoMaterial.uniforms.radius.value, ambientOcclusionRadius(bounds));

  let updates = 0;
  const update = ao.aoPass.updateGtaoMaterial.bind(ao.aoPass);
  ao.aoPass.updateGtaoMaterial = (parameters) => {
    updates += 1;
    update(parameters);
  };
  setAoBounds(ao, bounds.clone());
  assert.equal(updates, 0, "unchanged bounds leave the shader alone");
  setAoBounds(ao, new THREE.Box3(new THREE.Vector3(-1, 0, -2), new THREE.Vector3(1.5, 1.4, 2)));
  assert.equal(updates, 1);

  setAoBounds(ao, null);
  assert.equal(ao.aoPass.gtaoMaterial.defines.SCENE_CLIP_BOX, 0);
  disposeAoPipeline(ao);
});

test("the AO depth pass hides skipped objects and restores the scene exactly", () => {
  const scene = new THREE.Scene();
  const background = new THREE.Color(0x123456);
  scene.background = background;
  const body = mesh();
  const glass = mesh({ transparent: true, opacity: 0.4 });
  const hiddenPart = mesh();
  hiddenPart.visible = false;
  scene.add(body, glass, hiddenPart);
  const ao = createAoPipeline({ renderer: fakeRenderer, scene, camera: new THREE.PerspectiveCamera(), width: 8, height: 8 });

  ao.aoPass.overrideVisibility();
  assert.equal(scene.background, null);
  assert.equal(body.visible, true);
  assert.equal(glass.visible, false);
  assert.equal(hiddenPart.visible, false);

  ao.aoPass.restoreVisibility();
  assert.equal(scene.background, background);
  assert.equal(body.visible, true);
  assert.equal(glass.visible, true);
  assert.equal(hiddenPart.visible, false);
  disposeAoPipeline(ao);
});

test("a scene of several models sizes the AO radius from one model, not the whole set", () => {
  const ao = createAoPipeline({ renderer: fakeRenderer, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), width: 640, height: 360 });
  const set = new THREE.Box3(new THREE.Vector3(-7, 0, -4), new THREE.Vector3(7, 4, 4));
  const car = new THREE.Box3(new THREE.Vector3(-1, 0, -2.4), new THREE.Vector3(1, 1.5, 2.4));
  setAoBounds(ao, set, { radiusBounds: car });
  assert.equal(ao.aoPass.gtaoMaterial.uniforms.radius.value, ambientOcclusionRadius(car));
  assert.ok(ambientOcclusionRadius(car) < ambientOcclusionRadius(set));
  // The clip box still covers the whole set.
  assert.deepEqual(ao.aoPass.gtaoMaterial.uniforms.sceneBoxMax.value.toArray(), [7, 4, 4]);
});
