import * as THREE from "three";

// GTA spec maps are channel-packed data: specular intensity in red, gloss in
// green, fresnel in blue. They are never a colour (as one they tint every
// reflection blue), and three reads specular intensity from alpha, so the
// physical lighting chunk is rewritten to read red instead.
const SPECULAR_INTENSITY_ALPHA = "texture2D( specularIntensityMap, vSpecularIntensityMapUv ).a";
const SPECULAR_INTENSITY_RED = "texture2D( specularIntensityMap, vSpecularIntensityMapUv ).r";

// Point lights on a vehicle are only ever siren spill: a broad wash of
// coloured light, not a lamp. Lit with three's full BRDF, each one mirrors as a
// hard pinpoint on glossy paint and reads as a stray light on the panel, so
// vehicle materials take point lights as diffuse only. Spot and directional
// lights (the studio) keep their highlights.
const POINT_LIGHT_LOOP = "for ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {";
const DIRECT_LIGHT = "RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );";
const DIFFUSE_LIGHT = "reflectedLight.directDiffuse += saturate( dot( geometryNormal, directLight.direction ) ) * directLight.color * BRDF_Lambert( material.diffuseColor );";

let diffusePointLightsChunk = null;

/** Returns `fragmentShader` with point lights lighting diffuse only. */
export function diffusePointLights(fragmentShader) {
  if (!diffusePointLightsChunk) {
    const chunk = THREE.ShaderChunk.lights_fragment_begin;
    const loop = chunk.indexOf(POINT_LIGHT_LOOP);
    const call = loop < 0 ? -1 : chunk.indexOf(DIRECT_LIGHT, loop);
    if (call < 0) throw new Error("three's lights_fragment_begin changed; point lights can no longer be made diffuse only.");
    diffusePointLightsChunk = chunk.slice(0, call) + DIFFUSE_LIGHT + chunk.slice(call + DIRECT_LIGHT.length);
  }
  return fragmentShader.replace("#include <lights_fragment_begin>", diffusePointLightsChunk);
}

export const EMISSIVE_DIM_ATTRIBUTE = "emissiveDim";

export function emissiveDimAttribute(colors, vertexCount) {
  if (!colors || !(vertexCount > 0) || colors.length < vertexCount * 4) return null;
  let painted = false;
  for (let i = 0; i < vertexCount && !painted; i += 1) painted = colors[i * 4] < 255;
  if (!painted) return null;
  const red = new Uint8Array(vertexCount);
  for (let i = 0; i < vertexCount; i += 1) red[i] = colors[i * 4];
  return new THREE.BufferAttribute(red, 1, true);
}

export function hasEmissiveDim(geometry) {
  return Boolean(geometry?.attributes?.[EMISSIVE_DIM_ATTRIBUTE]);
}

export function declareEmissiveDim(shader) {
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", `#include <common>\nattribute float ${EMISSIVE_DIM_ATTRIBUTE};\nvarying float vEmissiveDim;`)
    .replace("#include <begin_vertex>", `#include <begin_vertex>\nvEmissiveDim = ${EMISSIVE_DIM_ATTRIBUTE};`);
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", "#include <common>\nvarying float vEmissiveDim;");
  return shader;
}

export function patchNativeShader(shader, { overlay = false, specularFromRed = false, diffusePoints = false, emissiveDim = false } = {}) {
  if (emissiveDim) {
    declareEmissiveDim(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vEmissiveDim;");
  }
  if (overlay) {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec2 nativeOverlayUv;\nvarying vec2 vNativeOverlayUv;")
      .replace("#include <uv_vertex>", "#include <uv_vertex>\nvNativeOverlayUv = nativeOverlayUv;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform sampler2D nativeOverlayMap;\nvarying vec2 vNativeOverlayUv;")
      .replace(
        "#include <map_fragment>",
        "#include <map_fragment>\nvec4 nativeOverlayColor = texture2D(nativeOverlayMap, vNativeOverlayUv);\ndiffuseColor.rgb = mix(diffuseColor.rgb, nativeOverlayColor.rgb, nativeOverlayColor.a);\ndiffuseColor.a = max(diffuseColor.a, nativeOverlayColor.a);",
      );
  }
  if (specularFromRed) {
    const chunk = THREE.ShaderChunk.lights_physical_fragment;
    if (!chunk.includes(SPECULAR_INTENSITY_ALPHA)) {
      throw new Error("three's lights_physical_fragment changed; native spec maps can no longer be read from red.");
    }
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <lights_physical_fragment>",
      chunk.replace(SPECULAR_INTENSITY_ALPHA, SPECULAR_INTENSITY_RED),
    );
  }
  if (diffusePoints) shader.fragmentShader = diffusePointLights(shader.fragmentShader);
  return shader;
}
