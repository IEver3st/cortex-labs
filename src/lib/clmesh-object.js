import * as THREE from "three";

// .clmesh UVs keep GTA's top-left origin (v grows down the image), which native
// DDS uploads sample as-is. User-loaded textures (PNG/PSD/DDS through the viewer
// loaders) follow the JS parser's flipped, bottom-left convention instead, so
// they must sample a V-flipped copy on geometry tagged with this origin.
export const UV_ORIGIN_TOP = "top";

const flippedUvCache = new WeakMap();
// Copies already in user-texture orientation; a caller that left one on
// geometry.attributes.uv may hand it back, and it must not flip again.
const flippedUvs = new WeakSet();

/**
 * The UV attribute a user-loaded texture should sample for `attribute` on
 * `geometry`: the attribute itself, or a cached V-flipped copy when the
 * geometry's UVs have a top-left origin.
 */
export function userTextureUvAttribute(geometry, attribute) {
  if (!attribute || geometry?.userData?.uvOrigin !== UV_ORIGIN_TOP || flippedUvs.has(attribute)) return attribute;
  let flipped = flippedUvCache.get(attribute);
  if (!flipped) {
    const { array, itemSize, count } = attribute;
    const values = new Float32Array(count * 2);
    for (let i = 0; i < count; i += 1) {
      values[i * 2] = array[i * itemSize];
      values[i * 2 + 1] = 1 - array[i * itemSize + 1];
    }
    flipped = new THREE.BufferAttribute(values, 2);
    flippedUvCache.set(attribute, flipped);
    flippedUvs.add(flipped);
  }
  return flipped;
}

// Builds a group from parsed .clmesh meshes (see clmesh.js), keeping all four
// GTA UV sets on geometry.userData.gtaUvSets and the manifest's native material
// record on each mesh for native-materials.js. Meshes stay in GTA model space.
export function buildClmeshObject(meshes) {
  const root = new THREE.Group();
  root.name = "clmesh";

  for (const mesh of Array.isArray(meshes) ? meshes : []) {
    if (!mesh?.positions?.length) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    if (mesh.normals) geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
    const gtaUvSets = [
      mesh.uvs ? new THREE.BufferAttribute(mesh.uvs, 2) : null,
      mesh.uvs2 ? new THREE.BufferAttribute(mesh.uvs2, 2) : null,
      mesh.uvs3 ? new THREE.BufferAttribute(mesh.uvs3, 2) : null,
      mesh.uvs4 ? new THREE.BufferAttribute(mesh.uvs4, 2) : null,
    ];
    if (gtaUvSets[0]) geometry.setAttribute("uv", gtaUvSets[0]);
    if (gtaUvSets[1]) geometry.setAttribute("uv2", gtaUvSets[1]);
    if (gtaUvSets[2]) geometry.setAttribute("uv3", gtaUvSets[2]);
    if (gtaUvSets[3]) geometry.setAttribute("uv4", gtaUvSets[3]);
    geometry.userData.gtaUvSets = gtaUvSets;
    geometry.userData.uvOrigin = UV_ORIGIN_TOP;
    if (mesh.indices) geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    if (!mesh.normals) geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const material = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.2, roughness: 0.6, side: THREE.FrontSide });
    material.name = mesh.materialName || "";

    const threeMesh = new THREE.Mesh(geometry, material);
    threeMesh.name = mesh.name || material.name || "mesh";
    if (mesh.textureRefs && Object.keys(mesh.textureRefs).length > 0) threeMesh.userData.textureRefs = mesh.textureRefs;
    if (mesh.nativeMaterial) {
      threeMesh.userData.nativeMaterial = mesh.nativeMaterial;
      threeMesh.userData.nativeLodActive = mesh.nativeMaterial.lodActive !== false;
    }
    root.add(threeMesh);
  }

  return root;
}
