import { parseClmesh } from "./clmesh.js";
import { buildClmeshObject } from "./clmesh-object.js";
import { applyNativeManifestToMeshes, resolveBindingsFromParentManifest } from "./native-material-plan.js";
import { getFileNameWithoutExtension, normalizeLoadedMeshes } from "./viewer-utils.js";

/* Mod kit parts and model extras for any viewer that shows a bridge-loaded
   vehicle (Livery/All and Photo Mode). Mod parts are exported in vehicle
   space, so a part group is added beside the vehicle's meshes and the
   vehicle rig's attach() moves it with the bone its kit entry names. */

/**
 * The vehicle's texture dictionary chain from its bridge manifest, or null.
 * Mod models have no dictionary of their own and fill their bindings from it.
 */
export function summarizeParentTextures(manifest, manifestPath) {
  const textures = (Array.isArray(manifest?.textures) ? manifest.textures : [])
    .map((texture) => ({ name: texture?.name, source: texture?.source, relativePath: texture?.relativePath }));
  return textures.length ? { manifestPath, textures } : null;
}

/** Parses one mod part through the bridge and returns its group of meshes. */
export async function loadVehicleModPart(path, parentTextures, { invoke, readFile }) {
  const result = await invoke("parse_yft", { path });
  const meshPath = typeof result?.meshPath === "string" ? result.meshPath.trim() : "";
  const manifestPath = typeof result?.manifestPath === "string" ? result.manifestPath.trim() : "";
  if (!meshPath) throw new Error("The CodeWalker bridge returned no mesh cache.");
  let meshes = parseClmesh(await readFile(meshPath));
  if (manifestPath) {
    const manifest = JSON.parse(new TextDecoder("utf-8").decode(await readFile(manifestPath)));
    meshes = applyNativeManifestToMeshes(meshes, manifest, manifestPath);
    if (parentTextures) meshes = resolveBindingsFromParentManifest(meshes, parentTextures, parentTextures.manifestPath);
  }
  if (!meshes?.length) throw new Error("The mod model contains no meshes.");
  const group = buildClmeshObject(meshes);
  group.name = "mod:" + (getFileNameWithoutExtension(path) || "part");
  group.userData.sourceFormat = "yft";
  normalizeLoadedMeshes(group);
  group.traverse((child) => {
    if (child.isMesh) child.userData.vehicleModPart = true;
  });
  return group;
}

/**
 * Tags every extra mesh with `userData.extraIndex` (from the manifest, or an
 * `extra_N` mesh name) and lists the extras as { index, label, visible }.
 */
export function getModelExtras(object) {
  const extras = new Map();
  object?.traverse((child) => {
    if (!child.isMesh) return;
    const match = /(?:^|[_.\s])extra[_\s]?(\d+)(?:$|[_.\s])/i.exec(child.name);
    const index = Number.isInteger(child.userData?.nativeMaterial?.extraIndex)
      ? child.userData.nativeMaterial.extraIndex : match ? Number(match[1]) : null;
    if (index === null) return;
    child.userData.extraIndex = index;
    extras.set(index, { index, label: `Extra ${index}`, visible: child.visible });
  });
  return [...extras.values()].sort((a, b) => a.index - b.index);
}
