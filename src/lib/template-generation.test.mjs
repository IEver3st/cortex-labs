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
import { buildAutoTemplatePsd, resolveAutoTemplateColors, selectTemplateMeshes } from "./template-psd.js";
import { initializeCanvas, readPsd } from "ag-psd";

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

// Node has no canvas. This stand-in paints solid rectangles and round-trips
// pixels exactly, which is all the background layer needs; path drawing is a
// no-op, so fill, wireframe and annotation layers stay blank.
function parseSolidHex(style) {
  if (typeof style !== "string") return null;
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(style.trim());
  if (!match) return null;
  const hex = match[1].length === 3 ? match[1].replace(/./g, "$&$&") : match[1];
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

class SolidFillCanvas {
  constructor(width, height = width) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }

  getContext() {
    const canvas = this;
    const rect = (x, y, w, h, paint) => {
      const x0 = Math.max(0, Math.floor(x));
      const y0 = Math.max(0, Math.floor(y));
      const x1 = Math.min(canvas.width, Math.ceil(x + w));
      const y1 = Math.min(canvas.height, Math.ceil(y + h));
      for (let row = y0; row < y1; row += 1) {
        for (let col = x0; col < x1; col += 1) paint((row * canvas.width + col) * 4);
      }
    };
    const context = {
      canvas,
      fillStyle: "#000000",
      clearRect: (x, y, w, h) => rect(x, y, w, h, (i) => canvas.data.fill(0, i, i + 4)),
      fillRect(x, y, w, h) {
        const rgb = parseSolidHex(this.fillStyle);
        if (rgb) rect(x, y, w, h, (i) => canvas.data.set([...rgb, 255], i));
      },
      createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      getImageData: (x, y, w, h) => {
        const data = new Uint8ClampedArray(w * h * 4);
        for (let row = 0; row < h; row += 1) {
          const start = ((y + row) * canvas.width + x) * 4;
          data.set(canvas.data.subarray(start, start + w * 4), row * w * 4);
        }
        return { width: w, height: h, data };
      },
      putImageData: (image, x = 0, y = 0) => {
        for (let row = 0; row < image.height; row += 1) {
          const start = ((y + row) * canvas.width + x) * 4;
          canvas.data.set(image.data.subarray(row * image.width * 4, (row + 1) * image.width * 4), start);
        }
      },
      createLinearGradient: () => ({ addColorStop() {} }),
      measureText: () => ({ width: 0 }),
    };
    return new Proxy(context, {
      get: (target, key) => (key in target ? target[key] : () => {}),
    });
  }

  toDataURL() {
    return "data:image/png;base64,";
  }
}

async function buildBackgroundPixel(options) {
  const root = createRoot([createMesh({ name: "body_shell", materialName: "vehicle_paint3" })]);
  const policy = getTemplateModelPolicy("vehicle.yft");
  const templateMap = buildModelTemplateMap({ object: root, modelPath: "vehicle.yft", fileType: "yft" });
  const templatePsdSource = buildModelTemplatePsdSource({
    object: root,
    modelPath: "vehicle.yft",
    fileType: "yft",
    preferUv2: policy.preferUv2,
  });

  const previous = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = SolidFillCanvas;
  let result;
  try {
    result = await buildAutoTemplatePsd(templateMap, {
      size: 256,
      modelPath: "vehicle.yft",
      modelFileName: "vehicle.yft",
      templatePsdSource,
      sourceFormat: policy.format,
      meshSelectionMode: "all",
      includeVehicleLayers: false,
      ...options,
    });
  } finally {
    if (previous === undefined) delete globalThis.OffscreenCanvas;
    else globalThis.OffscreenCanvas = previous;
  }

  // Reading layer pixels back asks ag-psd for blank ImageData.
  initializeCanvas((width, height) => new SolidFillCanvas(width, height), (width, height) => new SolidFillCanvas(1).getContext().createImageData(width, height));
  const psd = readPsd(result.bytes, { useImageData: true, skipCompositeImageData: true, skipThumbnail: true });
  const background = psd.children.find((layer) => layer.name === "_BG_BLACK");
  assert.ok(background?.imageData, "the template keeps its background layer");
  const { data, width, height } = background.imageData;
  assert.equal(width, 256);
  assert.equal(height, 256);
  const last = (width * height - 1) * 4;
  // Solid colour: the first and last pixel match.
  assert.deepEqual([...data.subarray(last, last + 4)], [...data.subarray(0, 4)]);
  return [...data.subarray(0, 4)];
}

test("Settings template colours resolve from prefs and reject malformed values", () => {
  assert.deepEqual(resolveAutoTemplateColors({ autoTemplateColor: "#AABBCC", autoTemplateBackgroundColor: " #1e90ff " }), {
    fillColor: "#AABBCC",
    backgroundColor: "#1e90ff",
  });
  assert.deepEqual(resolveAutoTemplateColors(null), { fillColor: "#c9d8ee", backgroundColor: "#000000" });
  assert.deepEqual(resolveAutoTemplateColors({ autoTemplateBackgroundColor: "blue", autoTemplateColor: 7 }), {
    fillColor: "#c9d8ee",
    backgroundColor: "#000000",
  });
});

test("Auto Template Background from Settings paints the exported template's background layer", async () => {
  const { backgroundColor } = resolveAutoTemplateColors({ autoTemplateBackgroundColor: "#1e90ff" });
  assert.deepEqual(await buildBackgroundPixel({ backgroundColor }), [0x1e, 0x90, 0xff, 255]);
  assert.deepEqual(await buildBackgroundPixel({ backgroundColor: "#fff" }), [255, 255, 255, 255]);
  // Without the option, or with a malformed one, the background stays black.
  assert.deepEqual(await buildBackgroundPixel({}), [0, 0, 0, 255]);
  assert.deepEqual(await buildBackgroundPixel({ backgroundColor: "#12345" }), [0, 0, 0, 255]);
});
