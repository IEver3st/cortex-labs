import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  buildModelTemplateMap,
  buildModelTemplatePsdSource,
  buildModelTemplateSets,
} from "./template-map.js";
import {
  getTemplateModelPolicy,
  isSupportedTemplateModel,
  normalizeTemplateViewMode,
} from "./template-model.js";
import { selectTemplateMeshes } from "./template-psd.js";
import {
  buildMarkerSelectionDraft,
  buildResetMarkerVisibility,
  isMarkerPlacementDecisionRequired,
  reconcileMarkerVisibility,
  resolveTemplateMarkerVisible,
} from "./template-marker-utils.js";

function createMesh({
  name,
  materialName,
  uv = [0, 0, 1, 0, 0, 1],
  uv2 = null,
  drawable = null,
}) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3),
  );
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  if (uv2) geometry.setAttribute("uv2", new THREE.Float32BufferAttribute(uv2, 2));
  geometry.setIndex([0, 1, 2]);

  const material = new THREE.MeshStandardMaterial();
  material.name = materialName;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.userData.meshLabel = name;
  if (drawable) {
    mesh.userData.drawableKey = drawable.key;
    mesh.userData.drawableIndex = drawable.index;
    mesh.userData.drawableHash = drawable.hash;
    mesh.userData.drawableHashHex = drawable.hashHex;
    mesh.userData.drawableName = drawable.name;
  }
  return mesh;
}

function createRoot(meshes) {
  const root = new THREE.Group();
  meshes.forEach((mesh) => root.add(mesh));
  root.updateMatrixWorld(true);
  return root;
}

test("template policy selects EUP behavior for YDD paths", () => {
  const policy = getTemplateModelPolicy("C:\\eup\\mp_m_freemode_01^jbib_000_u.YDD");
  assert.equal(policy.format, "ydd");
  assert.equal(policy.preferUv2, false);
  assert.equal(policy.meshSelectionMode, "all");
  assert.equal(policy.textureMode, "eup");
  assert.equal(policy.textureTarget, "all");
  assert.equal(policy.includeVehicleLayers, false);
  assert.equal(isSupportedTemplateModel("component.ydd"), true);
  assert.equal(isSupportedTemplateModel("texture.ytd"), false);
});

test("template view mode normalization preserves supported workspace layouts", () => {
  assert.equal(normalizeTemplateViewMode("model"), "model");
  assert.equal(normalizeTemplateViewMode("template"), "template");
  assert.equal(normalizeTemplateViewMode("split"), "split");
  assert.equal(normalizeTemplateViewMode("legacy"), "split");
  assert.equal(normalizeTemplateViewMode(null, "model"), "model");
});

test("EUP extraction uses UV0 and records ydd metadata", () => {
  const uv0 = [0, 0, 1, 0, 0, 1];
  const uv2 = [1, 1, 0, 1, 1, 0];
  const root = createRoot([
    createMesh({ name: "eup_mesh", materialName: "cloth_normal_spec", uv: uv0, uv2 }),
  ]);

  const source = buildModelTemplatePsdSource({
    object: root,
    modelPath: "component.ydd",
    fileType: "ydd",
    preferUv2: false,
  });
  const map = buildModelTemplateMap({ object: root, modelPath: "component.ydd", fileType: "ydd" });

  assert.equal(source.fileType, "ydd");
  assert.deepEqual(source.meshes[0].triangles.slice(0, 6), uv0);
  assert.equal(map.fileType, "ydd");
  assert.deepEqual(Object.keys(map.targets), ["material:cloth_normal_spec", "mesh:eup_mesh"]);
});

test("multi-drawable YDDs are split into uniquely named template sets", () => {
  const first = {
    key: "ydd:0:11111111",
    index: 0,
    hash: 0x11111111,
    hashHex: "11111111",
    name: "jbib_000_u",
  };
  const second = {
    key: "ydd:1:22222222",
    index: 1,
    hash: 0x22222222,
    hashHex: "22222222",
    name: "jbib_001_u",
  };
  const root = createRoot([
    createMesh({ name: "first_mesh", materialName: "cloth_a", drawable: first }),
    createMesh({ name: "second_mesh", materialName: "cloth_b", drawable: second }),
  ]);

  const result = buildModelTemplateSets({
    object: root,
    modelPath: "eup_pack.ydd",
    fileType: "ydd",
    preferUv2: false,
  });

  assert.equal(result.skipped.length, 0);
  assert.equal(result.sets.length, 2);
  assert.deepEqual(
    result.sets.map((set) => set.modelFileName),
    ["eup_pack_jbib_000_u.ydd", "eup_pack_jbib_001_u.ydd"],
  );
  assert.deepEqual(result.sets.map((set) => set.templatePsdSource.meshes.length), [1, 1]);
  assert.deepEqual(result.sets.map((set) => set.templateMap.source.drawable.key), [first.key, second.key]);

  const preferredResult = buildModelTemplateSets({
    object: root,
    modelPath: "eup_pack.ydd",
    fileType: "ydd",
    preferUv2: false,
    preferredDrawableKey: second.key,
  });
  assert.equal(preferredResult.sets[0].id, second.key);
});

test("EUP all-mesh selection does not collapse to one alphabetical material", () => {
  const root = createRoot([
    createMesh({ name: "torso", materialName: "cloth_a" }),
    createMesh({ name: "badge", materialName: "cloth_b" }),
  ]);
  const map = buildModelTemplateMap({ object: root, modelPath: "component.ydd", fileType: "ydd" });
  const source = buildModelTemplatePsdSource({
    object: root,
    modelPath: "component.ydd",
    fileType: "ydd",
    preferUv2: false,
  });

  const selected = selectTemplateMeshes(map, source, { meshSelectionMode: "all" });
  assert.equal(selected.length, 2);
  assert.deepEqual(new Set(selected.map((mesh) => mesh.meshName)), new Set(["torso", "badge"]));
});

test("explicit part selection ignores developer material naming", () => {
  const root = createRoot([
    createMesh({ name: "opaque_developer_part_17", materialName: "material_4" }),
    createMesh({ name: "body_shell", materialName: "vehicle_paint3" }),
  ]);
  const map = buildModelTemplateMap({ object: root, modelPath: "vehicle.yft", fileType: "yft" });
  const source = buildModelTemplatePsdSource({
    object: root,
    modelPath: "vehicle.yft",
    fileType: "yft",
    preferUv2: false,
  });

  const selected = selectTemplateMeshes(map, source, {
    meshSelectionMode: "selected",
    selectedMeshNames: ["opaque_developer_part_17"],
  });

  assert.deepEqual(new Set(selected.map((mesh) => mesh.meshName)), new Set(["opaque_developer_part_17"]));
});

test("explicit part selection fails closed when no selected mesh matches", () => {
  const root = createRoot([
    createMesh({ name: "body_shell", materialName: "vehicle_paint3" }),
  ]);
  const map = buildModelTemplateMap({ object: root, modelPath: "vehicle.yft", fileType: "yft" });
  const source = buildModelTemplatePsdSource({
    object: root,
    modelPath: "vehicle.yft",
    fileType: "yft",
    preferUv2: false,
  });

  const selected = selectTemplateMeshes(map, source, {
    meshSelectionMode: "selected",
    selectedMeshNames: ["missing_window"],
  });

  assert.deepEqual(selected, []);
});

test("detected marker candidates stay off until the user explicitly places them", () => {
  const markers = [
    { key: "door-handle", defaultVisible: true },
    { key: "badge", defaultVisible: false },
  ];

  assert.deepEqual(buildMarkerSelectionDraft(markers), {
    "door-handle": false,
    badge: false,
  });
  assert.deepEqual(buildResetMarkerVisibility(markers), {
    "door-handle": false,
    badge: false,
  });
  assert.equal(resolveTemplateMarkerVisible(markers[0], {}), false);
  assert.equal(resolveTemplateMarkerVisible(markers[0], { "door-handle": true }), true);
  assert.equal(isMarkerPlacementDecisionRequired(markers, false), true);
  assert.equal(isMarkerPlacementDecisionRequired(markers, true), false);
  assert.equal(isMarkerPlacementDecisionRequired([], false), false);
  assert.deepEqual(
    reconcileMarkerVisibility({
      markers,
      previousVisibility: { "door-handle": true },
    }),
    { "door-handle": true, badge: false },
  );
});
