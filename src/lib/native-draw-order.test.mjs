import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { applyMaterialDrawOrder, releaseMaterialDrawOrder } from "./native-draw-order.js";

// Bridge meshes of one model share an origin; their geometry sits anywhere in it.
function lampPart(x, y, z, size) {
  return new THREE.Mesh(new THREE.BoxGeometry(size, size, size).translate(x, y, z), new THREE.MeshBasicMaterial({ transparent: true }));
}

test("a model's transparent meshes share one depth, so creation (material) order decides", () => {
  const lens = lampPart(0.6, -2.3, 0.4, 0.3);
  const decal = lampPart(0.1, -1.4, 0.6, 0.5);
  applyMaterialDrawOrder(lens);
  applyMaterialDrawOrder(decal);
  assert.deepEqual(lens.boundingSphere.center.toArray(), [0, 0, 0]);
  assert.deepEqual(decal.boundingSphere.center.toArray(), [0, 0, 0]);
});

test("the sorting sphere still contains the geometry, so culling stays correct", () => {
  const mesh = lampPart(0.6, -2.3, 0.4, 0.3);
  applyMaterialDrawOrder(mesh);
  mesh.geometry.computeBoundingBox();
  const box = mesh.geometry.boundingBox;
  for (const corner of [box.min, box.max, new THREE.Vector3(box.min.x, box.max.y, box.min.z)]) {
    assert.ok(mesh.boundingSphere.containsPoint(corner));
  }
});

test("release hands bounds back to the geometry", () => {
  const mesh = lampPart(0, 1, 0, 0.2);
  applyMaterialDrawOrder(mesh);
  releaseMaterialDrawOrder(mesh);
  assert.equal(mesh.boundingSphere, undefined);
  assert.equal(mesh.userData.nativeDrawOrder, undefined);
  // Releasing a mesh that never took the order is a no-op.
  releaseMaterialDrawOrder(mesh);
  assert.equal(mesh.boundingSphere, undefined);
});

test("skinned meshes keep the bounds three computes for their pose", () => {
  const skinned = new THREE.SkinnedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 2, 0), new THREE.MeshBasicMaterial({ transparent: true }));
  applyMaterialDrawOrder(skinned);
  assert.equal(skinned.boundingSphere, null);
  assert.equal(skinned.userData.nativeDrawOrder, undefined);
});
