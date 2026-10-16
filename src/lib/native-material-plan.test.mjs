import test from "node:test";
import assert from "node:assert/strict";

import {
  applyNativeManifestToMeshes,
  findLiveryTexturePrefix,
  isLightDrivenEmissive,
  canonicalTextureUsage,
  classifyNativeShaderProfile,
  resolveManifestAssetPath,
  resolveBindingsFromParentManifest,
  resolvePaintLayerSlot,
  selectNativeMaterialBindings,
  summarizeNativeMaterialMeshes,
  usesNativeAlphaBlending,
} from "./native-material-plan.js";

test("livery texture prefixes come from the shader and may differ from the model name", () => {
  assert.equal(findLiveryTexturePrefix([{ diffusesampler: "generic", diffusesampler2: "policenew_sign_1" }]), "policenew");
  assert.equal(findLiveryTexturePrefix([{ normalsampler: "fake_sign_1", diffusesampler: "body" }]), null);
});

test("extra metadata survives the bridge manifest without turning null into extra zero", () => {
  const meshes = applyNativeManifestToMeshes([{ name: "body" }, { name: "roof" }], {
    meshes: [{ name: "body", extraIndex: null }, { name: "roof", extraIndex: 10 }],
  }, "C:/cache/manifest.json");
  assert.equal(meshes[0].nativeMaterial.extraIndex, null);
  assert.equal(meshes[1].nativeMaterial.extraIndex, 10);
});

test("same-named meshes keep their own manifest entry", () => {
  // The bridge splits a headlight by vertex light id and both subsets keep the bone name.
  const meshes = applyNativeManifestToMeshes(
    [{ name: "car_g67_headlight_l" }, { name: "car_g67_headlight_l" }, { name: "car_g72_headlight_l" }, { name: "car_g72_headlight_l" }],
    {
      meshes: [
        { name: "car_g67_headlight_l", lightBone: "headlight_l", lightId: 1 },
        { name: "car_g67_headlight_l", lightBone: "headlight_l", lightId: 0 },
        { name: "car_g72_headlight_l", lightBone: "headlight_l", lightId: 0 },
        { name: "car_g72_headlight_l", lightBone: "headlight_l", lightId: 1 },
      ],
    },
    "C:/cache/manifest.json",
  );
  assert.deepEqual(meshes.map((mesh) => mesh.nativeMaterial.lightId), [1, 0, 0, 1]);
});

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

test("alpha-bucket emissives blend by texture alpha; opaque buckets do not", () => {
  assert.equal(usesNativeAlphaBlending({ shaderName: "vehicle_lightsemissive", renderBucket: 1 }), true);
  assert.equal(usesNativeAlphaBlending({ shaderName: "vehicle_dash_emissive_opaque", renderBucket: 0 }), false);
  assert.equal(usesNativeAlphaBlending({ shaderName: "vehicle_lightsemissive" }), false);
  assert.equal(usesNativeAlphaBlending(null), false);
});

test("light-driven emissives do not self-emit from their diffuse; other emissives still do", () => {
  const diffuse = { paramName: "DiffuseSampler", usage: "baseColor", resolvedPath: "C:/cache/quad_emi.dds" };
  const light = { shaderName: "vehicle_lightsemissive", textureBindings: [diffuse] };
  const dash = { shaderName: "vehicle_dash_emissive", textureBindings: [diffuse] };
  assert.equal(isLightDrivenEmissive(light), true);
  assert.equal(isLightDrivenEmissive({ shaderName: "vehicle_lightsemissive_siren" }), true);
  assert.equal(isLightDrivenEmissive(dash), false);
  assert.equal(selectNativeMaterialBindings(light).baseColor, diffuse);
  assert.equal(selectNativeMaterialBindings(light).emissive, null);
  assert.equal(selectNativeMaterialBindings(dash).emissive, diffuse);
  assert.equal(classifyNativeShaderProfile(light), "emissive");
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

test("shared texture paths are resolved without parent-directory segments", () => {
  assert.equal(
    resolveManifestAssetPath("C:\\cache\\yft-cache\\abc123\\manifest.json", "../.shared-textures/f00d.dds"),
    "C:\\cache\\yft-cache\\.shared-textures\\f00d.dds",
  );
  assert.equal(
    resolveManifestAssetPath("/cache/yft-cache/abc123/manifest.json", "./textures/../textures/body.dds"),
    "/cache/yft-cache/abc123/textures/body.dds",
  );
});

test("game paint layers survive the manifest and pick the paint slot", () => {
  const meshes = applyNativeManifestToMeshes(
    [
      { name: "tire" }, { name: "rim" }, { name: "body" }, { name: "trim" }, { name: "dash" },
      { name: "badge" }, { name: "glass" }, { name: "paint" }, { name: "ped" }, { name: "legacy" },
    ],
    {
      meshes: [
        { name: "tire", shaderName: "vehicle_tire", drawableIndex: 1, part: "wheel", partName: "wheel_lf", paintLayer: 5 },
        { name: "rim", shaderName: "vehicle_mesh", drawableIndex: 1, part: "wheel", partName: "wheel_lf", paintLayer: 4 },
        { name: "body", shaderName: "vehicle_paint3", drawableIndex: 0, paintLayer: 1 },
        { name: "trim", shaderName: "vehicle_mesh", drawableIndex: 0, paintLayer: 6 },
        { name: "dash", shaderName: "vehicle_interior", drawableIndex: 0, paintLayer: 7 },
        { name: "badge", shaderName: "vehicle_badges", drawableIndex: 0, paintLayer: 2 },
        { name: "glass", shaderName: "vehicle_vehglass", drawableIndex: 0, diffuseColor: [0.8, 0.8, 0.8, 0] },
        { name: "paint", shaderName: "vehicle_paint1", drawableIndex: 0 },
        { name: "ped", shaderName: "ped", drawableIndex: 0 },
        { name: "legacy", drawableIndex: 0 },
      ],
    },
  );
  const [tire, rim, body, trim, dash, badge, glass, paint, ped, legacy] = meshes.map((mesh) => mesh.nativeMaterial);

  assert.deepEqual([tire.part, tire.partName, tire.paintLayer], ["wheel", "wheel_lf", 5]);
  assert.equal(resolvePaintLayerSlot(tire), null, "layer 5 is unpainted");
  assert.equal(resolvePaintLayerSlot(rim), "wheels");
  assert.equal(resolvePaintLayerSlot(body), "primary");
  assert.equal(resolvePaintLayerSlot(trim), "interior");
  assert.equal(resolvePaintLayerSlot(dash), "dashboard");
  assert.equal(resolvePaintLayerSlot(badge), "secondary", "the layer decides, not the shader name");
  assert.deepEqual(glass.diffuseColor, [0.8, 0.8, 0.8, 0]);
  assert.equal(resolvePaintLayerSlot(glass), null, "fixed colours are not paint");
  assert.equal(resolvePaintLayerSlot(paint), "primary", "a paint shader without matDiffuseColor is body paint");
  assert.equal(resolvePaintLayerSlot(ped), undefined, "non-vehicle shaders fall back to names");
  assert.deepEqual([legacy.part, legacy.paintLayer, legacy.diffuseColor], [null, null, null]);
  assert.equal(resolvePaintLayerSlot(legacy), undefined);
});

test("bone chains survive the manifest and absent chains stay unknown", () => {
  const meshes = applyNativeManifestToMeshes([{ name: "spoiler" }, { name: "body" }], {
    meshes: [{ name: "spoiler", boneChain: ["misc_a", " boot ", "", "chassis"] }, { name: "body" }],
  }, "C:/cache/manifest.json");
  assert.deepEqual(meshes[0].nativeMaterial.boneChain, ["misc_a", "boot", "chassis"]);
  assert.equal(meshes[1].nativeMaterial.boneChain, null);
});

test("mod bindings resolve from the parent vehicle dictionary but not its embedded textures", () => {
  const mod = applyNativeManifestToMeshes([{ name: "wing" }], {
    meshes: [{
      name: "wing",
      textureBindings: [
        { paramName: "DiffuseSampler", textureName: "MyCar_Sign_1", relativePath: "" },
        { paramName: "BumpSampler", textureName: "mycar_n", relativePath: "" },
        { paramName: "SpecSampler", textureName: "own_spec", relativePath: "textures/embedded/own_spec.dds", source: "embedded" },
      ],
    }],
  }, "C:/cache/mod/manifest.json");
  const parentManifest = {
    textures: [
      { name: "mycar_sign_1", source: "ytd", relativePath: "textures/ytd/mycar_sign_1.dds" },
      { name: "mycar_n", source: "embedded", relativePath: "textures/embedded/mycar_n.dds" },
      { name: "own_spec", source: "ytd", relativePath: "textures/ytd/own_spec.dds" },
    ],
  };
  const [wing] = resolveBindingsFromParentManifest(mod, parentManifest, "C:/cache/car/manifest.json");
  const [diffuse, bump, spec] = wing.nativeMaterial.textureBindings;
  assert.equal(diffuse.resolvedPath, "C:/cache/car/textures/ytd/mycar_sign_1.dds");
  assert.equal(diffuse.source, "parent");
  assert.equal(bump.resolvedPath, "", "the parent's embedded textures are not visible to mods");
  assert.equal(spec.resolvedPath, "C:/cache/mod/textures/embedded/own_spec.dds", "the mod's own textures win");
  assert.equal(resolveBindingsFromParentManifest(mod, null, "")[0], mod[0]);
});

test("light bones and light ids survive the manifest", async () => {
  const { normalizeManifestLightBones } = await import("./native-material-plan.js");
  const manifest = {
    lightBones: [
      { name: "Siren1", position: [0.5, -0.1, 0.9], rotation: [0, 0, 0, 1] },
      { name: "siren2", position: [0.1, "x", 0.9] },
      { name: "headlight_l", position: [-0.7, 2.5, 0.1] },
    ],
    meshes: [
      { name: "bar", lightBone: " Siren1 ", lightId: 0 },
      { name: "head", lightBone: "headlight_l", lightId: 1 },
      { name: "body", lightId: 300 },
    ],
  };
  const meshes = applyNativeManifestToMeshes([{ name: "bar" }, { name: "head" }, { name: "body" }], manifest, "C:/cache/manifest.json");
  assert.equal(meshes[0].nativeMaterial.lightBone, "siren1");
  assert.equal(meshes[0].nativeMaterial.lightId, 0);
  assert.equal(meshes[1].nativeMaterial.lightId, 1);
  assert.equal(meshes[2].nativeMaterial.lightBone, null);
  assert.equal(meshes[2].nativeMaterial.lightId, null);
  assert.deepEqual(normalizeManifestLightBones(manifest), [
    { name: "siren1", position: [0.5, -0.1, 0.9], rotation: [0, 0, 0, 1] },
    { name: "headlight_l", position: [-0.7, 2.5, 0.1], rotation: [0, 0, 0, 1] },
  ]);
  assert.deepEqual(normalizeManifestLightBones({}), []);
});
