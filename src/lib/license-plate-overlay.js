import * as THREE from "three";

// Draws the composed license plate over every vehicle_licenseplate mesh. The
// overlays live in their own scene group and follow the plate meshes' world
// transforms, so material assignment, picking and export never see them, and a
// material rebuild never drops the plate.

function isShown(object, root) {
  for (let node = object; node; node = node.parent) {
    if (!node.visible) return false;
    if (node === root) return true;
  }
  return true;
}

export function findPlateMeshes(model) {
  const meshes = [];
  model?.traverse?.((child) => {
    if (child.isMesh && /licenseplate/i.test(child.userData?.nativeMaterial?.shaderName || "")) meshes.push(child);
  });
  return meshes;
}

/** Returns null when the model has no license plate meshes. */
export function createPlateOverlay({ scene, model }) {
  const meshes = findPlateMeshes(model);
  if (!scene || !meshes.length) return null;
  const group = new THREE.Group();
  group.name = "license-plates";
  scene.add(group);

  let texture = null;
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.42,
    metalness: 0.15,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const overlays = meshes.map((mesh) => {
    const overlay = new THREE.Mesh(mesh.geometry, material);
    overlay.name = `license-plate:${mesh.name}`;
    overlay.matrixAutoUpdate = false;
    overlay.castShadow = mesh.castShadow;
    overlay.receiveShadow = mesh.receiveShadow;
    overlay.visible = false;
    group.add(overlay);
    return { mesh, overlay };
  });

  return {
    model,
    /** `image` is { data, width, height } RGBA, rows bottom first; null hides the plates. */
    setImage(image) {
      if (!image) {
        texture?.dispose();
        texture = null;
        material.map = null;
        material.needsUpdate = true;
        return;
      }
      // Plate UVs use the game's convention (v = 0 at the top) and native maps
      // upload raw DDS rows top first, so the bottom-first image is flipped here.
      const stride = image.width * 4;
      const rows = new Uint8Array(image.data.length);
      for (let y = 0; y < image.height; y += 1) {
        rows.set(image.data.subarray(y * stride, (y + 1) * stride), (image.height - 1 - y) * stride);
      }
      if (texture && texture.image.width === image.width && texture.image.height === image.height) {
        texture.image.data.set(rows);
      } else {
        texture?.dispose();
        texture = new THREE.DataTexture(rows, image.width, image.height, THREE.RGBAFormat);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.flipY = false;
        texture.magFilter = THREE.LinearFilter;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.generateMipmaps = true;
        texture.anisotropy = 4;
        material.map = texture;
        material.needsUpdate = true;
      }
      texture.needsUpdate = true;
    },
    /** Follows the plate meshes; cheap enough to run every rendered frame. */
    update() {
      for (const { mesh, overlay } of overlays) {
        const visible = Boolean(material.map) && isShown(mesh, model);
        overlay.visible = visible;
        if (!visible) continue;
        overlay.matrix.copy(mesh.matrixWorld);
        overlay.matrixWorldNeedsUpdate = true;
      }
    },
    dispose() {
      scene.remove(group);
      material.dispose();
      texture?.dispose();
    },
  };
}
