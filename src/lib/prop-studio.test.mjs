import test from "node:test";
import assert from "node:assert/strict";

import {
  emissiveLevel,
  formatLength,
  gtaLightToThree,
  isEmissiveShader,
  isIdentityOrientation,
  isNightOnlyShader,
  isPropModelPath,
  lightColorHex,
  listAvailableLods,
  materialGroupKey,
  normalizeManifestDrawables,
  normalizeModelLights,
  normalizeOrientation,
  normalizePropState,
  propModelFormat,
  resolveLod,
  rotateOrientation,
  thumbnailFileName,
} from "./prop-studio.js";

test("accepts drawables, drawable dictionaries and fragments only", () => {
  assert.equal(propModelFormat("C:\\stream\\prop_flashlight.YDR"), "ydr");
  assert.equal(propModelFormat("/x/props.ydd"), "ydd");
  assert.equal(propModelFormat("car.yft"), "yft");
  assert.equal(isPropModelPath("texture.ytd"), false);
  assert.equal(isPropModelPath(""), false);
  assert.equal(isPropModelPath(null), false);
});

test("thumbnail names follow the model and stay filesystem safe", () => {
  assert.equal(thumbnailFileName("C:\\a\\prop_flashlight_01.ydr", 256), "prop_flashlight_01_256.png");
  assert.equal(thumbnailFileName("C:\\a\\weird name!.ydr"), "weird_name_.png");
  assert.equal(thumbnailFileName(""), "prop.png");
});

test("state defaults are complete and hostile values are clamped", () => {
  const fresh = normalizePropState(null, { background: "#202020", light: 1.5 });
  assert.equal(fresh.scene.backdrop, "#202020");
  assert.equal(fresh.scene.lightLevel, 1.5);
  assert.equal(fresh.view.mode, "textured");
  assert.equal(fresh.view.drawable, -1);
  assert.deepEqual(fresh.view.orientation, [0, 0, 0, 1]);
  assert.equal(fresh.thumbnail.size, 512);

  const hostile = normalizePropState({
    modelPath: "C:\\x\\texture.ytd",
    extraYtds: ["a.ytd", "a.ytd", 5, "b.png", "c.YTD"],
    scene: { stage: "moon", spot: 99, dark: -3, backdrop: "red", floor: "lava" },
    view: { mode: "x-ray", drawable: 1.5, turntableSpeed: 0, hiddenMaterials: { a: true, b: "yes" } },
    emissive: { strength: Number.NaN, levels: { a: 20, b: "x" } },
    thumbnail: { size: 300 },
  });
  assert.equal(hostile.modelPath, "");
  assert.deepEqual(hostile.extraYtds, ["a.ytd", "c.YTD"]);
  assert.equal(hostile.scene.stage, "workbench");
  assert.equal(hostile.scene.spot, 2);
  assert.equal(hostile.scene.dark, 0);
  assert.equal(hostile.scene.backdrop, "#141414");
  assert.equal(hostile.scene.floor, "polished");
  assert.equal(hostile.view.mode, "textured");
  assert.equal(hostile.view.drawable, -1);
  assert.equal(hostile.view.turntableSpeed, 2);
  assert.deepEqual(hostile.view.hiddenMaterials, { a: true });
  assert.equal(hostile.emissive.strength, 1);
  assert.deepEqual(hostile.emissive.levels, { a: 8 });
  assert.equal(hostile.thumbnail.size, 512);
});

test("quarter turns compose, round-trip and survive persistence", () => {
  let q = [0, 0, 0, 1];
  for (let i = 0; i < 4; i += 1) q = rotateOrientation(q, "x");
  assert.equal(isIdentityOrientation(q), true);

  const turned = rotateOrientation([0, 0, 0, 1], "y");
  assert.deepEqual(rotateOrientation(turned, "y", -1), [0, 0, 0, 1]);
  assert.deepEqual(normalizeOrientation(JSON.parse(JSON.stringify(turned))), turned);
  assert.deepEqual(normalizeOrientation([0, 0, 0, -1]), [0, 0, 0, 1]);
  assert.deepEqual(normalizeOrientation([1, 2, 3]), [0, 0, 0, 1]);
  assert.deepEqual(normalizeOrientation([0, 0, 0, 0]), [0, 0, 0, 1]);
  assert.deepEqual(rotateOrientation(turned, "w"), turned);
});

test("manifest drawables are unique, ordered and named", () => {
  assert.deepEqual(
    normalizeManifestDrawables({ drawables: [{ index: 1, name: "b" }, { index: 0, name: " " }, { index: 1, name: "dup" }, { index: -1 }] }),
    [{ index: 0, name: "drawable_0" }, { index: 1, name: "b" }],
  );
  assert.deepEqual(normalizeManifestDrawables({}), []);
});

test("model lights keep authored values and drop malformed entries", () => {
  const lights = normalizeModelLights({
    lights: [
      {
        drawableIndex: 0, index: 0, type: "spot", position: [0, 0.12, 0], direction: [0, 2, 0],
        color: [255, 240, 300], intensity: 12, falloff: 8, falloffExponent: 16, coneInnerAngle: 30, coneOuterAngle: 10,
      },
      { type: "point", position: [0, 0, 0], intensity: 2, falloff: 1.5 },
      { type: "spot", position: [0, 0, 0], direction: [0, 0, 0], intensity: 1, falloff: 1 },
      { type: "point", position: [0, Number.NaN, 0], intensity: 1, falloff: 1 },
      { type: "laser", position: [0, 0, 0], intensity: 1, falloff: 1 },
      { type: "point", position: [0, 0, 0], intensity: 1, falloff: 0 },
    ],
  });
  assert.equal(lights.length, 2);
  const [spot, point] = lights;
  assert.equal(spot.id, "0:0");
  assert.deepEqual(spot.direction, [0, 1, 0]);
  assert.deepEqual(spot.color, [255, 240, 255]);
  // Inner can't exceed outer.
  assert.equal(spot.coneInnerAngle, 30);
  assert.equal(spot.coneOuterAngle, 30);
  assert.equal(point.type, "point");
  assert.equal(lightColorHex(spot), "#fff0ff");
  assert.deepEqual(normalizeModelLights({ lights: "nope" }), []);
});

test("GTA lights map to range-limited three.js lights", () => {
  const spot = gtaLightToThree({ type: "spot", color: [255, 128, 0], intensity: 10, falloff: 6, coneInnerAngle: 10, coneOuterAngle: 20 }, 0.5);
  assert.equal(spot.kind, "spot");
  assert.equal(spot.intensity, 5);
  assert.equal(spot.distance, 6);
  assert.equal(spot.decay, 0);
  assert.ok(Math.abs(spot.angle - (20 * Math.PI) / 180) < 1e-9);
  assert.ok(Math.abs(spot.penumbra - 0.5) < 1e-9);
  assert.deepEqual(spot.color, [1, 128 / 255, 0]);

  const wide = gtaLightToThree({ type: "spot", intensity: 1, falloff: 1, coneInnerAngle: 0, coneOuterAngle: 90 });
  assert.ok(wide.angle < Math.PI / 2);
  const capsule = gtaLightToThree({ type: "capsule", intensity: 1, falloff: 2 });
  assert.equal(capsule.kind, "point");
  assert.equal(gtaLightToThree({ type: "point", intensity: 3, falloff: 1 }, -2).intensity, 0);
});

test("emissive multipliers compress into a usable preview range", () => {
  assert.equal(emissiveLevel(null), 1);
  assert.equal(emissiveLevel(0), 0);
  assert.equal(emissiveLevel(1), 1);
  assert.equal(emissiveLevel(16), 4);
  assert.equal(emissiveLevel(500), 4);
  assert.equal(emissiveLevel(0.01), 0.25);
  assert.equal(isEmissiveShader("emissivestrong_alpha"), true);
  assert.equal(isEmissiveShader("normal_spec"), false);
  assert.equal(isNightOnlyShader("emissivenight"), true);
  assert.equal(isNightOnlyShader("emissive"), false);
});

test("materials group by shader and colour texture", () => {
  const a = { shaderName: "Emissive", textureBindings: [{ usage: "baseColor", textureName: "Lens" }] };
  const b = { shaderName: "emissive", textureBindings: [{ usage: "normal", textureName: "x" }, { usage: "baseColor", textureName: "lens" }] };
  assert.equal(materialGroupKey(a), materialGroupKey(b));
  assert.equal(materialGroupKey(null, "Body"), "mesh:body");
});

test("LOD choice falls back to the nearest available detail", () => {
  assert.deepEqual(listAvailableLods(["low", "high", "Medium", "unknown"]), ["high", "med", "low"]);
  assert.equal(resolveLod("med", ["high", "med"]), "med");
  assert.equal(resolveLod("low", ["high", "med"]), "med");
  assert.equal(resolveLod("high", ["low", "vlow"]), "low");
  assert.equal(resolveLod("bogus", ["low"]), "low");
  assert.equal(resolveLod("high", []), null);
});

test("lengths read in the unit a prop artist expects", () => {
  assert.equal(formatLength(0.004), "4.0 mm");
  assert.equal(formatLength(0.245), "24.5 cm");
  assert.equal(formatLength(1.5), "1.50 m");
  assert.equal(formatLength(Number.NaN), "–");
});
