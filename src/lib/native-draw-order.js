// Game draw order for a model's see-through materials. The game draws an
// entity's alpha bucket in material order (geometry order in the drawable),
// so a lamp lens drawn after the emitters, reflectors and cabin decals behind
// it covers them. three instead sorts every transparent mesh by the depth of
// its own geometry's bounding sphere, which reorders overlapping shells as the
// camera moves: a lens can draw first and everything behind it paints over it.
//
// three takes a mesh's own `boundingSphere` over its geometry's when it has
// one, for both depth sorting and frustum culling. Centring that sphere on the
// mesh's origin, which every bridge mesh of one model shares, gives the
// model's meshes one depth: three's tie-break is creation order, which is the
// bridge's geometry order, while separate models (mod parts, other vehicles)
// still sort by distance like game entities. The radius still contains the
// geometry, so culling stays correct.

import * as THREE from "three";

/** Gives a transparent mesh its model's depth for sorting (see above). */
export function applyMaterialDrawOrder(mesh) {
  const geometry = mesh?.geometry;
  if (!geometry || mesh.userData?.nativeDrawOrder) return;
  // Skinned, instanced and batched meshes keep the bounds three computes for them.
  if (mesh.boundingSphere !== undefined) return;
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const bounds = geometry.boundingSphere;
  if (!bounds || !Number.isFinite(bounds.radius) || bounds.radius < 0) return;
  mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), bounds.center.length() + bounds.radius);
  mesh.userData.nativeDrawOrder = true;
}

/** Hands sorting and culling back to the geometry's own bounds. */
export function releaseMaterialDrawOrder(mesh) {
  if (!mesh?.userData?.nativeDrawOrder) return;
  delete mesh.boundingSphere;
  delete mesh.userData.nativeDrawOrder;
}
