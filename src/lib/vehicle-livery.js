// A vehicle's own liveries, as the game switches them:
// - Texture liveries: the paint binds `<prefix>_sign_N` and SetVehicleLivery
//   picks which N from the vehicle's texture dictionary chain.
// - Mod kit liveries (VMT_LIVERY_MOD): the mod's model is a placeholder; the
//   livery texture it carries replaces the paint shaders' livery slot (the
//   second diffuse) and wins over a texture livery.
// Shared by the workspace viewer and Photo Mode. Overrides mutate the model's
// native materials in place and remember what they replaced, so restoring is
// exact and no material is recompiled after its first overlay.

import * as THREE from "three";
import { resolveManifestAssetPath, selectNativeMaterialBindings } from "./native-material-plan.js";

export const LIVERY_SIGN = /^(.+)_sign_(\d+)$/i;
// The paint shaders' livery slot: a second diffuse texture mixed over the paint.
const LIVERY_OVERLAY_PARAM = /^diffusesampler2$/i;

export function liveryOverlayBinding(mesh) {
  return (mesh?.userData?.nativeMaterial?.textureBindings || []).find((binding) => LIVERY_OVERLAY_PARAM.test(binding?.paramName || "")) || null;
}

/** The `<prefix>` of the first `<prefix>_sign_N` a mesh binds, lower-cased, or "". */
export function findLiverySignPrefix(meshes) {
  for (const mesh of meshes || []) {
    for (const binding of mesh?.userData?.nativeMaterial?.textureBindings || []) {
      const match = LIVERY_SIGN.exec(binding?.textureName || "");
      if (match) return match[1].toLowerCase();
    }
  }
  return "";
}

/**
 * Livery textures the vehicle's dictionary chain holds for the sign the model
 * binds: { prefix, numbers: [1, 2, ...], paths: Map(number -> DDS path) }, or
 * null when there is nothing to switch between.
 */
export function listTextureLiveries(meshes, parentTextures) {
  const prefix = findLiverySignPrefix(meshes);
  if (!prefix || !parentTextures?.textures?.length) return null;
  const paths = new Map();
  for (const texture of parentTextures.textures) {
    const match = LIVERY_SIGN.exec(texture?.name || "");
    if (!match || match[1].toLowerCase() !== prefix || !texture.relativePath) continue;
    const number = Number(match[2]);
    if (!paths.has(number)) paths.set(number, resolveManifestAssetPath(parentTextures.manifestPath, texture.relativePath));
  }
  if (paths.size < 2) return null;
  return { prefix, numbers: [...paths.keys()].sort((a, b) => a - b), paths };
}

/** The livery texture a loaded VMT_LIVERY_MOD model carries, as a DDS path, or "". */
export function findLiveryModTexturePath(object) {
  let path = "";
  object?.traverse?.((child) => {
    if (!path && child.isMesh) path = liveryOverlayBinding(child)?.resolvedPath || "";
  });
  return path;
}

// A blank `_sign_1` ("no livery") stays an ordinary transparent decal: lamp
// blockers never bind a livery sign (native-occluder.js), so an override never
// meets a depth-only occluder and never changes its flags.

// Hides an overlay without removing it: removing one would switch the shader
// program, and switching back reuses a program compiled without its uniform.
function createClearTexture() {
  const texture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

/**
 * Applies a livery to a vehicle's native materials. `apply(meshes, { sign,
 * mod })` restores the model's own livery first, then shows `mod` (a mod kit
 * livery texture) in the livery slot of every paint material that has one, or
 * else `sign` wherever the model binds a `_sign_N` texture. Textures passed in
 * stay owned by the caller; the override clones them per UV set.
 * `forget()` drops what it remembered without restoring, for when the native
 * materials were replaced underneath it. Takes native-materials' overlay setter
 * so this module loads without the DDS and Tauri stack (Node tests).
 */
export function createLiveryOverride(setNativeOverlayTexture) {
  const originals = new Map();
  const clones = new Set();
  let clearOverlay = null;

  // `like` is the texture being replaced; its filtering (the renderer's
  // anisotropy) carries over so a switched livery is as sharp as the stock one.
  const clone = (source, uvSet, like) => {
    const texture = source.clone();
    texture.channel = uvSet;
    texture.anisotropy = Math.max(texture.anisotropy, like?.anisotropy || 1);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.needsUpdate = true;
    clones.add(texture);
    return texture;
  };

  const remember = (mesh, material) => {
    if (originals.has(material)) return;
    originals.set(material, { mesh, map: material.map, overlay: material.userData.nativeOverlayMap || null });
  };

  const disposeClones = () => {
    for (const texture of clones) texture.dispose();
    clones.clear();
  };

  const restore = () => {
    for (const [material, original] of originals) {
      if (material.map !== original.map) {
        material.map = original.map;
        material.needsUpdate = true;
      }
      if (material.userData.nativeOverlayMap && material.userData.nativeOverlayMap !== original.overlay) {
        const uvSet = selectNativeMaterialBindings(original.mesh.userData.nativeMaterial).overlay?.uvSet ?? 0;
        clearOverlay ||= createClearTexture();
        setNativeOverlayTexture(material, original.mesh, original.overlay || clearOverlay, uvSet);
      }
    }
    originals.clear();
    disposeClones();
  };

  const apply = (meshes, { sign = null, mod = null } = {}) => {
    restore();
    if (mod) {
      for (const mesh of meshes) {
        const material = mesh.userData.nativeMaterialObject;
        const slot = liveryOverlayBinding(mesh);
        if (!material || !slot) continue;
        remember(mesh, material);
        const uvSet = slot.uvSet ?? 0;
        setNativeOverlayTexture(material, mesh, clone(mod, uvSet, material.userData.nativeOverlayMap || material.map), uvSet);
      }
      return;
    }
    if (!sign) return;
    for (const mesh of meshes) {
      const material = mesh.userData.nativeMaterialObject;
      if (!material) continue;
      const bindings = selectNativeMaterialBindings(mesh.userData.nativeMaterial);
      for (const role of ["baseColor", "overlay"]) {
        const binding = bindings[role];
        if (!LIVERY_SIGN.test(binding?.textureName || "")) continue;
        remember(mesh, material);
        const uvSet = binding.uvSet ?? 0;
        if (role === "baseColor") {
          material.map = clone(sign, uvSet, material.map);
          material.needsUpdate = true;
        } else {
          setNativeOverlayTexture(material, mesh, clone(sign, uvSet, material.userData.nativeOverlayMap || material.map), uvSet);
        }
      }
    }
  };

  return {
    apply,
    restore,
    get active() {
      return originals.size > 0;
    },
    forget() {
      originals.clear();
      disposeClones();
    },
    dispose() {
      restore();
      clearOverlay?.dispose();
      clearOverlay = null;
    },
  };
}
