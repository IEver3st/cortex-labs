import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  assignNativePlaceholder,
  assignNativeTextureSlot,
  createNativeMaterial,
} from "./native-materials.js";

function makeMesh(shaderName = "vehicle_mesh") {
  const geom = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
  mesh.userData.nativeMaterial = { shaderName, renderBucket: 0 };
  return mesh;
}

function makeTexture(channel = 0, colorSpace = THREE.SRGBColorSpace) {
  const tex = new THREE.DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
  tex.channel = channel;
  tex.colorSpace = colorSpace;
  return tex;
}

test("createNativeMaterial uses lighter MeshStandardMaterial for non-physical profiles without specular maps", () => {
  const meshMat = createNativeMaterial(makeMesh("vehicle_mesh"), { shaderName: "vehicle_mesh" }, {});
  assert.equal(meshMat.isMeshStandardMaterial, true);
  assert.equal(meshMat.isMeshPhysicalMaterial, undefined);

  const glassMat = createNativeMaterial(makeMesh("vehicle_vehglass"), { shaderName: "vehicle_vehglass" }, {});
  assert.equal(glassMat.isMeshStandardMaterial, true);
  assert.equal(glassMat.isMeshPhysicalMaterial, undefined);

  const paintMat = createNativeMaterial(makeMesh("vehicle_paint3"), { shaderName: "vehicle_paint3" }, {});
  assert.equal(paintMat.isMeshPhysicalMaterial, true);

  const rubberMat = createNativeMaterial(makeMesh("vehicle_tire"), { shaderName: "vehicle_tire" }, {});
  assert.equal(rubberMat.isMeshPhysicalMaterial, true);

  const specMat = createNativeMaterial(
    makeMesh("vehicle_mesh"),
    { shaderName: "vehicle_mesh" },
    { specular: { resolvedPath: "C:/cache/spec.dds" } },
  );
  assert.equal(specMat.isMeshPhysicalMaterial, true);

  meshMat.dispose();
  glassMat.dispose();
  paintMat.dispose();
  rubberMat.dispose();
  specMat.dispose();
});

test("assignNativeTextureSlot swaps placeholders to real textures without bumping material.version", () => {
  const mesh = makeMesh("vehicle_paint3");
  const material = createNativeMaterial(mesh, mesh.userData.nativeMaterial, {
    baseColor: { resolvedPath: "C:/cache/diff.dds", uvSet: 0 },
    overlay: { resolvedPath: "C:/cache/sign.dds", uvSet: 0 },
    normal: { resolvedPath: "C:/cache/norm.dds", uvSet: 0 },
    specular: { resolvedPath: "C:/cache/spec.dds", uvSet: 0 },
    emissive: { resolvedPath: "C:/cache/emis.dds", uvSet: 0 },
    ambientOcclusion: { resolvedPath: "C:/cache/ao.dds", uvSet: 0 },
  });

  for (const role of ["baseColor", "overlay", "normal", "specular", "emissive", "ambientOcclusion"]) {
    assignNativePlaceholder(material, mesh, role, { uvSet: 0 });
  }
  const compiledVersion = material.version;
  // Simulate compiled overlay uniform from onBeforeCompile.
  material.userData.nativeOverlayUniform = { value: material.userData.nativeOverlayMap };

  const realDiffuse = makeTexture(0, THREE.SRGBColorSpace);
  const realOverlay = makeTexture(0, THREE.SRGBColorSpace);
  const realNormal = makeTexture(0, THREE.NoColorSpace);
  const realSpec = makeTexture(0, THREE.NoColorSpace);
  const realEmissive = makeTexture(0, THREE.SRGBColorSpace);
  const realAo = makeTexture(0, THREE.NoColorSpace);

  assignNativeTextureSlot(material, mesh, "baseColor", realDiffuse, { uvSet: 0 });
  assignNativeTextureSlot(material, mesh, "overlay", realOverlay, { uvSet: 0 });
  assignNativeTextureSlot(material, mesh, "normal", realNormal, { uvSet: 0 });
  assignNativeTextureSlot(material, mesh, "specular", realSpec, { uvSet: 0 });
  assignNativeTextureSlot(material, mesh, "emissive", realEmissive, { uvSet: 0 });
  assignNativeTextureSlot(material, mesh, "ambientOcclusion", realAo, { uvSet: 0 });

  assert.equal(material.version, compiledVersion, "real texture arrivals must not trigger shader recompiles");
  assert.equal(material.map, realDiffuse);
  assert.equal(material.userData.nativeOverlayUniform.value, realOverlay);
  assert.equal(material.normalMap, realNormal);
  assert.equal(material.specularIntensityMap, realSpec);
  assert.equal(material.emissiveMap, realEmissive);
  assert.equal(material.aoMap, realAo);

  // Changing UV channel DOES require a recompile.
  const uv1Diffuse = makeTexture(1, THREE.SRGBColorSpace);
  assignNativeTextureSlot(material, mesh, "baseColor", uv1Diffuse, { uvSet: 1 });
  assert.equal(material.version, compiledVersion + 1);

  material.dispose();
  mesh.geometry.dispose();
});

test("assignNativeTextureSlot triggers material.needsUpdate when turning a closed badge box into a depth-only occluder", () => {
  const mesh = makeMesh("vehicle_badges");
  const material = createNativeMaterial(mesh, mesh.userData.nativeMaterial, {});
  assignNativePlaceholder(material, mesh, "baseColor", { uvSet: 0 });
  const versionBefore = material.version;

  const blank = makeTexture(0, THREE.SRGBColorSpace);
  blank.userData.fullyTransparent = true;
  const becameOccluder = assignNativeTextureSlot(material, mesh, "baseColor", blank, {
    textureName: "emiblocker",
    uvSet: 0,
  });
  assert.equal(becameOccluder, true);
  assert.equal(material.userData.nativeDepthOnly, true);
  assert.equal(material.colorWrite, false);
  assert.ok(material.version > versionBefore, "occluder conversion must bump material.version");

  material.dispose();
  mesh.geometry.dispose();
});
