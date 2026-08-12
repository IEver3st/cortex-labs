import test from "node:test";
import assert from "node:assert/strict";

import {
  applyNativeManifestToMeshes,
  canonicalTextureUsage,
  classifyNativeShaderProfile,
  resolveManifestAssetPath,
  selectNativeMaterialBindings,
  summarizeNativeMaterialMeshes,
} from "./native-material-plan.js";

test("resolves manifest-relative asset paths on Windows and Unix", () => {
  assert.equal(
    resolveManifestAssetPath("C:\\cache\\vehicle\\manifest.json", "textures/shared/body.dds"),
    "C:\\cache\\vehicle\\textures\\shared\\body.dds",
  );
  assert.equal(
    resolveManifestAssetPath("/tmp/vehicle/manifest.json", "textures\\embedded\\body.dds"),
    "/tmp/vehicle/textures/embedded/body.dds",
  );
  assert.equal(
    resolveManifestAssetPath("C:\\cache\\manifest.json", "D:\\textures\\body.dds"),
    "D:\\textures\\body.dds",
  );
});

test("uses shader sampler names before misleading texture filenames", () => {
  assert.equal(
    canonicalTextureUsage({
      paramName: "DiffuseSampler",
      textureName: "vehicle_generic_smallspecmap",
      usage: "specular",
    }),
    "baseColor",
  );
});

test("classifies normal, specular, emissive, and ambient-occlusion samplers", () => {
  assert.equal(canonicalTextureUsage({ paramName: "BumpSampler" }), "normal");
  assert.equal(canonicalTextureUsage({ paramName: "SpecSampler" }), "specular");
  assert.equal(canonicalTextureUsage({ paramName: "EmissiveSampler" }), "emissive");
  assert.equal(canonicalTextureUsage({ paramName: "AoSampler" }), "ambientOcclusion");
});

test("selects the highest available LOD independently for each drawable", () => {
  const meshes = [
    { name: "vehicle_d0_m0_g0" },
    { name: "vehicle_d0_m1_g0" },
    { name: "vehicle_d1_m2_g0" },
  ];
  const manifest = {
    meshes: [
      { name: meshes[0].name, drawableIndex: 0, lodLevel: "high", lodModelIndex: 0 },
      { name: meshes[1].name, drawableIndex: 0, lodLevel: "med", lodModelIndex: 0 },
      { name: meshes[2].name, drawableIndex: 1, lodLevel: "low", lodModelIndex: 0 },
    ],
  };

  const planned = applyNativeManifestToMeshes(meshes, manifest, "C:\\cache\\manifest.json");
  assert.equal(planned[0].nativeMaterial.selectedLod, "high");
  assert.equal(planned[0].nativeMaterial.lodActive, true);
  assert.equal(planned[1].nativeMaterial.selectedLod, "high");
  assert.equal(planned[1].nativeMaterial.lodActive, false);
  assert.equal(planned[2].nativeMaterial.selectedLod, "low");
  assert.equal(planned[2].nativeMaterial.lodActive, true);
});

test("keeps legacy manifest meshes active when LOD fields are absent", () => {
  const meshes = [{ name: "legacy_a" }, { name: "legacy_b" }];
  const manifest = {
    meshes: meshes.map((mesh) => ({
      name: mesh.name,
      shaderName: "vehicle_default",
      textureBindings: [],
    })),
  };

  const planned = applyNativeManifestToMeshes(meshes, manifest, "/tmp/manifest.json");
  assert.deepEqual(planned.map((mesh) => mesh.nativeMaterial.lodActive), [true, true]);
  assert.deepEqual(planned.map((mesh) => mesh.nativeMaterial.selectedLod), ["", ""]);
});

test("selects primary and overlay color bindings plus supporting maps", () => {
  const binding = (paramName, usage, resolvedPath) => ({ paramName, usage, resolvedPath });
  const selected = selectNativeMaterialBindings({
    shaderName: "vehicle_emissive",
    textureBindings: [
      binding("DiffuseSampler2", "baseColor", "/textures/overlay.dds"),
      binding("NormalSampler", "normal", "/textures/normal.dds"),
      binding("DiffuseSampler", "baseColor", "/textures/base.dds"),
      binding("SpecSampler", "specular", "/textures/spec.dds"),
      binding("EmissiveSampler", "emissive", "/textures/glow.dds"),
    ],
  });

  assert.equal(selected.baseColor.paramName, "DiffuseSampler");
  assert.equal(selected.overlay.paramName, "DiffuseSampler2");
  assert.equal(selected.normal.paramName, "NormalSampler");
  assert.equal(selected.specular.paramName, "SpecSampler");
  assert.equal(selected.emissive.paramName, "EmissiveSampler");
  assert.equal(classifyNativeShaderProfile({ shaderName: "vehicle_paint3" }), "paint");
  assert.equal(classifyNativeShaderProfile({ shaderName: "vehicle_glass" }), "glass");
});

test("summarizes active bindings, deduplicated textures, and hidden LOD meshes", () => {
  const activeMaterial = {
    shaderName: "vehicle_default",
    lodActive: true,
    textureBindings: [
      { paramName: "DiffuseSampler", usage: "baseColor", resolvedPath: "/textures/base.dds" },
      { paramName: "NormalSampler", usage: "normal", resolvedPath: "/textures/normal.dds" },
      { paramName: "SpecSampler", usage: "specular", resolvedPath: "" },
      { paramName: "DirtSampler", usage: "dirt", resolvedPath: "/textures/dirt.dds" },
    ],
  };
  const hiddenMaterial = {
    shaderName: "vehicle_default",
    lodActive: false,
    textureBindings: [
      { paramName: "DiffuseSampler", usage: "baseColor", resolvedPath: "/textures/hidden.dds" },
    ],
  };

  assert.deepEqual(
    summarizeNativeMaterialMeshes([
      { nativeMaterial: activeMaterial },
      { nativeMaterial: hiddenMaterial },
      {},
    ]),
    {
      available: true,
      meshCount: 2,
      activeMeshCount: 1,
      hiddenLodMeshCount: 1,
      bindingCount: 4,
      resolvedBindingCount: 3,
      missingBindingCount: 1,
      uniqueTextureCount: 3,
      shaderCount: 1,
      unsupportedBindingCount: 1,
    },
  );
});
