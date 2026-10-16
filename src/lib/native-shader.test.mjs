import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { patchNativeShader } from "./native-shader.js";

const physical = () => ({
  uniforms: {},
  vertexShader: THREE.ShaderLib.physical.vertexShader,
  fragmentShader: THREE.ShaderLib.physical.fragmentShader,
});

test("GTA spec maps drive specular intensity from red, never alpha", () => {
  const shader = patchNativeShader(physical(), { specularFromRed: true });
  assert.ok(!shader.fragmentShader.includes("#include <lights_physical_fragment>"));
  assert.match(shader.fragmentShader, /texture2D\( specularIntensityMap, vSpecularIntensityMapUv \)\.r;/);
  assert.doesNotMatch(shader.fragmentShader, /texture2D\( specularIntensityMap, vSpecularIntensityMapUv \)\.a;/);
});

test("materials without a spec map keep three's lighting chunk untouched", () => {
  const shader = patchNativeShader(physical(), {});
  assert.equal(shader.fragmentShader, THREE.ShaderLib.physical.fragmentShader);
  assert.equal(shader.vertexShader, THREE.ShaderLib.physical.vertexShader);
});

test("overlay and spec patches compose on one shader", () => {
  const shader = patchNativeShader(physical(), { overlay: true, specularFromRed: true });
  assert.match(shader.vertexShader, /attribute vec2 nativeOverlayUv;/);
  assert.match(shader.fragmentShader, /uniform sampler2D nativeOverlayMap;/);
  assert.match(shader.fragmentShader, /nativeOverlayColor = texture2D\(nativeOverlayMap, vNativeOverlayUv\)/);
  assert.match(shader.fragmentShader, /vSpecularIntensityMapUv \)\.r;/);
});

test("vehicle materials take point lights (siren spill) as diffuse only", () => {
  const stock = THREE.ShaderLib.physical.fragmentShader;
  const shader = patchNativeShader(physical(), { diffusePoints: true });
  assert.ok(!shader.fragmentShader.includes("#include <lights_fragment_begin>"));
  const loop = shader.fragmentShader.indexOf("for ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {");
  const spot = shader.fragmentShader.indexOf("for ( int i = 0; i < NUM_SPOT_LIGHTS; i ++ ) {");
  assert.ok(loop >= 0 && spot > loop);
  const pointBody = shader.fragmentShader.slice(loop, spot);
  assert.match(pointBody, /reflectedLight\.directDiffuse \+= .*BRDF_Lambert\( material\.diffuseColor \);/);
  assert.doesNotMatch(pointBody, /RE_Direct\(/, "no specular from point lights");
  const directCalls = (text) => text.split("RE_Direct( directLight").length - 1;
  const stockCalls = directCalls(THREE.ShaderChunk.lights_fragment_begin);
  assert.equal(directCalls(shader.fragmentShader), stockCalls - 1, "spot and directional lights keep their highlights");
  assert.ok(stock.includes("#include <common>") && THREE.ShaderChunk.common.includes("vec3 BRDF_Lambert("), "BRDF_Lambert is in scope");
});
