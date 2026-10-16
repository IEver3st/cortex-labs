import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { countDrawnGeometry, meshTriangleCount, summarizeMeshStats } from "./mesh-stats.js";
import { createSolidWireMaterial, GLOW_LAYER, renderSolidWire, skipsSolidWire } from "./viewer-render-effects.js";

function box(width = 1, height = 1, depth = 1) {
  // BoxGeometry: 24 vertices, 12 triangles.
  return new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), new THREE.MeshStandardMaterial());
}

test("triangle count follows the index, draw range and visible groups", () => {
  const mesh = box();
  assert.equal(meshTriangleCount(mesh), 12);
  mesh.geometry.setDrawRange(0, 18);
  assert.equal(meshTriangleCount(mesh), 6);

  const soup = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  soup.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(27), 3));
  assert.equal(meshTriangleCount(soup), 3);

  const grouped = box();
  grouped.material = Array.from({ length: 6 }, () => new THREE.MeshBasicMaterial());
  grouped.material[0].visible = false;
  grouped.material[1].colorWrite = false;
  assert.equal(meshTriangleCount(grouped), 8);
});

test("counts only what the viewer draws", () => {
  const root = new THREE.Group();
  const body = box();
  const hiddenPart = box();
  hiddenPart.visible = false;
  const hiddenParent = new THREE.Group();
  hiddenParent.visible = false;
  hiddenParent.add(box());
  const glow = box();
  glow.layers.enable(GLOW_LAYER);
  const blocker = box();
  blocker.material.colorWrite = false;
  root.add(body, hiddenPart, hiddenParent, glow, blocker, new THREE.Sprite());
  assert.deepEqual(countDrawnGeometry([root]), { meshes: 1, triangles: 12, vertices: 24 });
  assert.deepEqual(countDrawnGeometry([root, null, body]), { meshes: 2, triangles: 24, vertices: 48 });
});

test("summary names GTA shaders and textures and sizes the model on the ground plane", () => {
  const root = new THREE.Group();
  const body = box(2, 1.5, 5);
  body.userData.nativeMaterial = { shaderName: "vehicle_paint3" };
  body.userData.textureRefs = { DiffuseSampler: "Livery_A", BumpSampler: "body_n" };
  const trim = box(1, 1, 1);
  trim.position.set(0, 0, 3);
  trim.userData.nativeMaterial = { shaderName: "VEHICLE_PAINT3" };
  trim.userData.textureRefs = { DiffuseSampler: "livery_a", SpecSampler: " " };
  const lamp = box();
  lamp.userData.nativeMaterial = { shaderName: "vehicle_lightsemissive" };
  root.add(body, trim, lamp);
  root.rotation.y = Math.PI / 2;
  root.updateMatrixWorld(true);

  const stats = summarizeMeshStats([root]);
  assert.equal(stats.meshes, 3);
  assert.equal(stats.triangles, 36);
  assert.equal(stats.vertices, 72);
  assert.equal(stats.shaders, 2);
  assert.equal(stats.textures, 2);
  // Turned a quarter, the 6 m run (body -2.5..2.5, trim to 3.5) lies along X.
  assert.ok(Math.abs(stats.size.length - 6) < 1e-6);
  assert.ok(Math.abs(stats.size.width - 2) < 1e-6);
  assert.ok(Math.abs(stats.size.height - 1.5) < 1e-6);
});

test("models without GTA metadata leave shaders and textures unknown", () => {
  const stats = summarizeMeshStats([box()]);
  assert.equal(stats.shaders, null);
  assert.equal(stats.textures, null);
  assert.deepEqual(summarizeMeshStats([]), { meshes: 0, triangles: 0, vertices: 0, shaders: null, textures: null, size: null });
});

test("solid wire skips effect geometry but keeps glass and skinned meshes", () => {
  assert.equal(skipsSolidWire(box()), false);
  const glass = box();
  glass.material.transparent = true;
  glass.material.opacity = 0.3;
  assert.equal(skipsSolidWire(glass), false);
  const skinned = new THREE.SkinnedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  assert.equal(skipsSolidWire(skinned), false);
  const glow = box();
  glow.layers.enable(GLOW_LAYER);
  assert.equal(skipsSolidWire(glow), true);
  const mirror = box();
  mirror.onBeforeRender = () => {};
  assert.equal(skipsSolidWire(mirror), true);
  assert.equal(skipsSolidWire(new THREE.LineSegments()), true);
});

test("the wire pass draws only the model and restores the scene", () => {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101010);
  const floor = box();
  const turntable = new THREE.Group();
  const model = new THREE.Group();
  const body = box();
  const glow = box();
  glow.layers.enable(GLOW_LAYER);
  const sibling = box();
  model.add(body, glow);
  turntable.add(model, sibling);
  scene.add(floor, turntable);

  const material = createSolidWireMaterial();
  let seen = null;
  const renderer = {
    autoClear: true,
    shadowMap: { autoUpdate: true, needsUpdate: false },
    clearStencil() {},
    render(target) {
      seen = {
        background: target.background,
        override: target.overrideMaterial,
        autoClear: this.autoClear,
        shadows: this.shadowMap.autoUpdate,
        visible: [floor, turntable, model, body, glow, sibling].map((object) => object.visible),
      };
    },
  };
  renderSolidWire(renderer, scene, new THREE.PerspectiveCamera(), { roots: [model], material });
  assert.equal(seen.background, null);
  assert.equal(seen.override, material);
  assert.equal(seen.autoClear, false);
  assert.equal(seen.shadows, false);
  assert.deepEqual(seen.visible, [false, true, true, true, false, false]);

  assert.ok(scene.background.isColor);
  assert.equal(scene.overrideMaterial, null);
  assert.equal(renderer.autoClear, true);
  assert.equal(renderer.shadowMap.autoUpdate, true);
  assert.ok([floor, turntable, model, body, glow, sibling].every((object) => object.visible));

  seen = null;
  renderSolidWire(renderer, scene, new THREE.PerspectiveCamera(), { roots: [], material });
  assert.equal(seen, null);
});
