import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { FullScreenQuad, Pass } from "three/examples/jsm/postprocessing/Pass.js";

const SHADOW_RECEIVER_EPSILON = 0.002;
const SHADOW_RECEIVER_MIN_SIZE = 1;
const SHADOW_RECEIVER_PADDING = 0.35;

// Selective glow for vehicle lights. Only objects on GLOW_LAYER (light glow
// overlays and coronas) feed it, so paint under a bright studio light never
// blooms. The glow source is rendered offscreen over a black depth pre-pass of
// the opaque scene, so the body still hides lights behind it; see-through
// lenses and self-rendering objects (the showroom floor's reflection) are left
// out of that pre-pass. The scene itself then renders exactly as it does with
// the lights off, and the glow and its blur are added on top through the
// renderer's tone mapping and colour space, so stage shaders never change.
export const GLOW_LAYER = 11;
// Light that falls on the floor (the siren ground pool). The main camera draws
// it; the showroom floor's mirror camera, which renders layer 0 only, must not,
// or the floor reflects its own lighting and the pool doubles and shifts with
// every camera move.
export const FLOOR_LIGHT_LAYER = 12;
// Calibrated so Glow 1x matches the game's emissive bloom.
export const BLOOM_STRENGTH = 0.14;

const occluderMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
const clearColor = new THREE.Color();
const defaultOnBeforeRender = THREE.Object3D.prototype.onBeforeRender;
// Lenses in front of a lit lamp tint its glow, as a red tail lens over a white
// reflector does in game. The lamp is HDR there, so a lens changes its hue but
// barely dims it: the filter multiplies the glow by the lens texture's hue,
// weighted by its alpha, and leaves near-black (smoked) texels neutral.
const LENS_FILTER_LAYER = 13;
const lensFilters = new WeakMap();
// Invisible lamp blockers (native-occluder.js) sit a millimetre or two outside
// the lens and win by polygon offset, which the shared occluder would drop.
const DEPTH_ONLY_LAYER = 14;
const depthOnlyOccluderMaterial = new THREE.MeshBasicMaterial({
  color: 0x000000,
  side: THREE.DoubleSide,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -2,
});

function isLensSurface(object) {
  if (!object.isMesh || !object.userData?.nativeMaterial) return false;
  if (/lightsemissive/i.test(object.userData.nativeMaterial.shaderName || "")) return false;
  const material = Array.isArray(object.material) ? object.material[0] : object.material;
  return Boolean(material?.map) && (material.transparent || material.transmission > 0 || /glass/i.test(object.userData.nativeMaterial.shaderName || ""));
}

function lensFilterFor(source) {
  let filter = lensFilters.get(source);
  if (filter && filter.map === source.map) return filter;
  filter?.dispose();
  filter = new THREE.MeshBasicMaterial({
    map: source.map,
    side: source.side,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.DstColorFactor,
    blendDst: THREE.ZeroFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  filter.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <opaque_fragment>",
      [
        "float lensLevel = max( diffuseColor.r, max( diffuseColor.g, diffuseColor.b ) );",
        "float lensTint = clamp( diffuseColor.a * 2.0, 0.0, 1.0 ) * smoothstep( 0.03, 0.15, lensLevel );",
        "gl_FragColor = vec4( mix( vec3( 1.0 ), diffuseColor.rgb / max( lensLevel, 1e-4 ), lensTint ), 1.0 );",
      ].join("\n"),
    );
  };
  filter.customProgramCacheKey = () => "glow-lens-filter";
  lensFilters.set(source, filter);
  return filter;
}

function skipsOcclusion(object) {
  if (object.isSprite) return true;
  if (!(object.isMesh || object.isLine || object.isPoints)) return false;
  if (object.onBeforeRender !== defaultOnBeforeRender) return true;
  // Only what writes depth in the real render may hide a lamp: lenses, the
  // showroom light beam and other depthWrite-off effects never do.
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  if (materials.some((entry) => entry?.transparent || entry?.transmission > 0 || entry?.depthWrite === false)) return true;
  return /glass/i.test(object.userData?.nativeMaterial?.shaderName || "");
}

class GlowSourcePass extends Pass {
  constructor(scene, camera) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.needsSwap = false;
  }

  render(renderer, writeBuffer, readBuffer) {
    const { scene, camera } = this;
    const savedMask = camera.layers.mask;
    const savedBackground = scene.background;
    const savedOverride = scene.overrideMaterial;
    const savedAutoClear = renderer.autoClear;
    const savedAlpha = renderer.getClearAlpha();
    renderer.getClearColor(clearColor);

    const hidden = [];
    const lenses = [];
    const blockers = [];
    scene.traverse((object) => {
      if (!object.visible || object.layers.isEnabled(GLOW_LAYER)) return;
      if (object.userData?.nativeDepthOnly && object.isMesh) {
        object.visible = false;
        hidden.push(object);
        blockers.push(object);
      } else if (skipsOcclusion(object)) {
        object.visible = false;
        hidden.push(object);
        if (isLensSurface(object)) lenses.push(object);
      }
    });

    renderer.setRenderTarget(readBuffer);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.autoClear = false;
    scene.background = null;
    scene.overrideMaterial = occluderMaterial;
    camera.layers.set(0);
    renderer.render(scene, camera);
    for (const object of hidden) object.visible = true;
    if (blockers.length) {
      for (const object of blockers) object.layers.enable(DEPTH_ONLY_LAYER);
      scene.overrideMaterial = depthOnlyOccluderMaterial;
      camera.layers.set(DEPTH_ONLY_LAYER);
      renderer.render(scene, camera);
      for (const object of blockers) object.layers.disable(DEPTH_ONLY_LAYER);
    }
    scene.overrideMaterial = savedOverride;
    camera.layers.set(GLOW_LAYER);
    renderer.render(scene, camera);

    // Lit overlays wrote depth, so only lens surfaces in front of a lamp pass;
    // elsewhere the glow buffer is black and the multiply changes nothing.
    if (lenses.length) {
      const swapped = lenses.map((object) => {
        const material = object.material;
        object.material = Array.isArray(material) ? material.map(lensFilterFor) : lensFilterFor(material);
        object.layers.enable(LENS_FILTER_LAYER);
        return material;
      });
      camera.layers.set(LENS_FILTER_LAYER);
      renderer.render(scene, camera);
      lenses.forEach((object, index) => {
        object.material = swapped[index];
        object.layers.disable(LENS_FILTER_LAYER);
      });
    }

    camera.layers.mask = savedMask;
    scene.background = savedBackground;
    renderer.autoClear = savedAutoClear;
    renderer.setClearColor(clearColor, savedAlpha);
  }
}

function createGlowCompositeMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { tGlow: { value: null } },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: `uniform sampler2D tGlow; varying vec2 vUv;
      void main() {
        gl_FragColor = vec4(texture2D(tGlow, vUv).rgb, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
}

export function createBloomPipeline({ renderer, scene, camera, width, height }) {
  if (!renderer || !scene || !camera) return null;
  const glowComposer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
  glowComposer.renderToScreen = false;
  const glowPass = new GlowSourcePass(scene, camera);
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(width || 1, height || 1), BLOOM_STRENGTH, 0.4, 0);
  glowComposer.addPass(glowPass);
  glowComposer.addPass(bloomPass);
  const composite = new FullScreenQuad(createGlowCompositeMaterial());
  const pipeline = { glowComposer, glowPass, bloomPass, composite, enabled: false };
  resizeBloomPipeline(pipeline, width, height, renderer.getPixelRatio?.() || 1);
  return pipeline;
}

export function resizeBloomPipeline(pipeline, width, height, pixelRatio = 1) {
  if (!pipeline?.glowComposer || !width || !height) return;
  pipeline.glowComposer.setPixelRatio(pixelRatio);
  pipeline.glowComposer.setSize(width, height);
}

export function disposeBloomPipeline(pipeline) {
  if (!pipeline) return;
  pipeline.bloomPass.dispose();
  pipeline.composite.material.dispose();
  pipeline.composite.dispose();
  pipeline.glowComposer.renderTarget1.dispose();
  pipeline.glowComposer.renderTarget2.dispose();
  pipeline.glowComposer.dispose();
}

// Solid wireframe: the shaded frame stays exactly as drawn and every model
// triangle's edges are drawn over it, depth-tested against that frame so hidden
// edges stay hidden. It is one override pass over the model only, so skinned
// peds, opening doors and swapped parts are wired as they render, with no
// extra objects in the scene for other traversals to trip over.
export const SOLID_WIRE_COLOR = 0x3dbaa3; // the cage overlay's teal
const SOLID_WIRE_OPACITY = 0.45;
// Edges move this fraction of their distance toward the camera, which keeps
// their screen position and lets them win the depth test against their own
// faces without showing through panels (about 7 mm at 5 m).
const SOLID_WIRE_PULL = 0.9985;

export function createSolidWireMaterial() {
  const material = new THREE.MeshBasicMaterial({
    color: SOLID_WIRE_COLOR,
    wireframe: true,
    transparent: true,
    opacity: SOLID_WIRE_OPACITY,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
    fog: false,
    // Each pixel takes one line at most. Shared edges are drawn twice and a
    // dense mesh packs many edges into a pixel; without this they pile up into
    // a flat teal fill that hides the shading.
    stencilWrite: true,
    stencilRef: 1,
    stencilFunc: THREE.NotEqualStencilFunc,
    stencilZPass: THREE.ReplaceStencilOp,
  });
  material.name = "__solidWire";
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      "#include <project_vertex>",
      `#include <project_vertex>
      if ( projectionMatrix[ 3 ][ 3 ] == 0.0 ) gl_Position = projectionMatrix * vec4( mvPosition.xyz * ${SOLID_WIRE_PULL}, 1.0 );
      else gl_Position.z -= 0.0005;`,
    );
  };
  material.customProgramCacheKey = () => "solid-wire";
  return material;
}

// Real model geometry only: lamp glow, floor light, invisible lamp blockers,
// sprites and self-rendering objects are effects, not topology.
export function skipsSolidWire(object) {
  if (!object) return true;
  if (object.isSprite || object.isPoints || object.isLine) return true;
  if (!object.isMesh) return false;
  if (object.userData?.propHelper) return true;
  if (!object.geometry?.attributes?.position) return true;
  if (object.layers?.isEnabled?.(GLOW_LAYER) || object.layers?.isEnabled?.(FLOOR_LIGHT_LAYER)) return true;
  if (object.onBeforeRender !== defaultOnBeforeRender) return true;
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  return materials.every((entry) => !entry || entry.visible === false || entry.colorWrite === false);
}

function hideOutsideWire(object, roots, ancestors, inside, hidden) {
  if (!object.visible) return;
  const within = inside || roots.includes(object);
  if (within ? skipsSolidWire(object) : !ancestors.has(object)) {
    object.visible = false;
    hidden.push(object);
    return;
  }
  for (const child of object.children) hideOutsideWire(child, roots, ancestors, within, hidden);
}

export function renderSolidWire(renderer, scene, camera, wire) {
  const roots = (wire?.roots || []).filter(Boolean);
  if (!roots.length || !wire.material) return;
  const ancestors = new Set();
  for (const root of roots) {
    for (let node = root.parent; node; node = node.parent) ancestors.add(node);
  }
  const hidden = [];
  for (const child of scene.children) hideOutsideWire(child, roots, ancestors, false, hidden);
  const background = scene.background;
  const override = scene.overrideMaterial;
  const autoClear = renderer.autoClear;
  const shadowAutoUpdate = renderer.shadowMap.autoUpdate;
  const shadowNeedsUpdate = renderer.shadowMap.needsUpdate;
  scene.background = null;
  scene.overrideMaterial = wire.material;
  renderer.autoClear = false;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = false;
  try {
    renderer.clearStencil();
    renderer.render(scene, camera);
  } finally {
    for (const object of hidden) object.visible = true;
    scene.background = background;
    scene.overrideMaterial = override;
    renderer.autoClear = autoClear;
    renderer.shadowMap.autoUpdate = shadowAutoUpdate;
    renderer.shadowMap.needsUpdate = shadowNeedsUpdate;
  }
}

export function renderWithEffects({ renderer, scene, camera, ao, bloom, wire = null }) {
  const occlusion = ao?.enabled ? ao : null;
  // Glow objects render with the scene unless the glow pipeline adds them.
  camera.layers.enable(GLOW_LAYER);
  if (bloom?.enabled) {
    bloom.glowPass.scene = scene;
    bloom.glowPass.camera = camera;
    bloom.glowComposer.render();
    // The glow texture already carries the sharp lamp, so the scene skips it.
    camera.layers.disable(GLOW_LAYER);
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    if (occlusion) renderAmbientOcclusion(renderer, occlusion, scene, camera);
    camera.layers.enable(GLOW_LAYER);
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    bloom.composite.material.uniforms.tGlow.value = bloom.glowComposer.readBuffer.texture;
    bloom.composite.render(renderer);
    renderer.autoClear = autoClear;
    // The composites never write depth, so the scene's depth still hides edges.
    if (wire) renderSolidWire(renderer, scene, camera, wire);
    return;
  }
  renderer.render(scene, camera);
  if (occlusion) renderAmbientOcclusion(renderer, occlusion, scene, camera);
  if (wire) renderSolidWire(renderer, scene, camera, wire);
}

// Ambient occlusion for the model. The scene still renders straight to the
// canvas exactly as it does without AO (tone mapping, MSAA, dithering and the
// stage shaders are untouched); GTAO then rebuilds depth and normals for the
// solid model only, and its denoised result multiplies onto the frame before
// lamp glow is added. AO is clipped to the model's bounds, so the stage floor,
// grid and backdrop never darken, and its radius follows the model's size.
export const AO_INTENSITY = 0.85;
const AO_RADIUS_SCALE = 0.05;
const AO_MIN_RADIUS = 0.04;
const AO_MAX_RADIUS = 1.2;

// Only opaque, depth-writing model surfaces may occlude. Glass, see-through
// decals, cut-out grilles (the override material would make them solid),
// wireframes, lamp glow and self-rendering objects such as the showroom
// floor's mirror stay out of the AO depth pass.
export function skipsAmbientOcclusion(object) {
  if (!object) return true;
  if (object.isSprite || object.isPoints || object.isLine) return true;
  if (!object.isMesh) return false;
  if (object.layers?.isEnabled?.(GLOW_LAYER)) return true;
  if (object.onBeforeRender !== defaultOnBeforeRender) return true;
  if (/glass/i.test(object.userData?.nativeMaterial?.shaderName || "")) return true;
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  return materials.every((entry) =>
    !entry ||
    entry.visible === false ||
    entry.transparent ||
    entry.colorWrite === false ||
    entry.transmission > 0 ||
    entry.depthWrite === false ||
    entry.alphaTest > 0 ||
    entry.wireframe,
  );
}

const _aoSize = new THREE.Vector3();

export function ambientOcclusionRadius(bounds) {
  if (!bounds?.isBox3 || bounds.isEmpty()) return AO_MIN_RADIUS * 4;
  const diagonal = bounds.getSize(_aoSize).length();
  return Math.min(AO_MAX_RADIUS, Math.max(AO_MIN_RADIUS, diagonal * AO_RADIUS_SCALE));
}

class ModelGTAOPass extends GTAOPass {
  overrideVisibility() {
    const cache = this._visibilityCache;
    const scene = this.scene;
    this._savedBackground = scene.background;
    scene.background = null;
    scene.traverse((object) => {
      cache.set(object, object.visible);
      if (object.visible && skipsAmbientOcclusion(object)) object.visible = false;
    });
  }

  restoreVisibility() {
    super.restoreVisibility();
    this.scene.background = this._savedBackground;
    this._savedBackground = null;
  }
}

function createAoCompositeMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { tAO: { value: null }, intensity: { value: AO_INTENSITY } },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: `uniform sampler2D tAO; uniform float intensity; varying vec2 vUv;
      void main() {
        gl_FragColor = vec4(vec3(mix(1.0, texture2D(tAO, vUv).r, intensity)), 1.0);
      }`,
    // Multiplies the frame already on the canvas; its alpha is left alone.
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.DstColorFactor,
    blendDst: THREE.ZeroFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    depthTest: false,
    depthWrite: false,
  });
}

export function createAoPipeline({ renderer, scene, camera, width, height }) {
  if (!renderer || !scene || !camera) return null;
  const aoPass = new ModelGTAOPass(scene, camera, 1, 1);
  aoPass.output = GTAOPass.OUTPUT.Off;
  const composite = new FullScreenQuad(createAoCompositeMaterial());
  const pipeline = {
    aoPass,
    composite,
    enabled: false,
    intensity: AO_INTENSITY,
    radius: null,
    clipBox: new THREE.Box3(),
    hasClipBox: false,
  };
  resizeAoPipeline(pipeline, width, height, renderer.getPixelRatio?.() || 1);
  setAoBounds(pipeline, null);
  return pipeline;
}

export function resizeAoPipeline(pipeline, width, height, pixelRatio = 1) {
  if (!pipeline?.aoPass || !width || !height) return;
  pipeline.aoPass.setSize(Math.max(1, Math.round(width * pixelRatio)), Math.max(1, Math.round(height * pixelRatio)));
}

// Fits radius and clip box to the model. Cheap enough to call every frame:
// the shader only changes when the bounds actually move. A scene of several
// models passes `radiusBounds`, one model's bounds, so the radius stays sized
// to a model instead of the whole set (a set-wide radius smears occlusion
// across neighbouring models).
export function setAoBounds(pipeline, bounds, { radiusBounds = null } = {}) {
  if (!pipeline?.aoPass) return;
  const hasBounds = Boolean(bounds?.isBox3 && !bounds.isEmpty());
  const sizing = radiusBounds?.isBox3 && !radiusBounds.isEmpty() ? radiusBounds : hasBounds ? bounds : null;
  const radius = ambientOcclusionRadius(sizing);
  if (hasBounds) {
    if (pipeline.hasClipBox && pipeline.clipBox.equals(bounds) && pipeline.radius === radius) return;
    pipeline.clipBox.copy(bounds);
    pipeline.hasClipBox = true;
    pipeline.aoPass.setSceneClipBox(bounds);
  } else {
    if (!pipeline.hasClipBox && pipeline.radius !== null) return;
    pipeline.hasClipBox = false;
    pipeline.aoPass.setSceneClipBox(null);
  }
  pipeline.radius = radius;
  pipeline.aoPass.updateGtaoMaterial({ radius: pipeline.radius, distanceExponent: 1, thickness: 1, scale: 1, samples: 16 });
}

function renderAmbientOcclusion(renderer, ao, scene, camera) {
  const { aoPass, composite } = ao;
  aoPass.scene = scene;
  aoPass.camera = camera;
  // The scene render already refreshed the shadow maps; the depth pass must
  // not draw them again.
  const shadowAutoUpdate = renderer.shadowMap.autoUpdate;
  const shadowNeedsUpdate = renderer.shadowMap.needsUpdate;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = false;
  aoPass.render(renderer, null, null);
  renderer.shadowMap.autoUpdate = shadowAutoUpdate;
  renderer.shadowMap.needsUpdate = shadowNeedsUpdate;

  renderer.setRenderTarget(null);
  const autoClear = renderer.autoClear;
  renderer.autoClear = false;
  composite.material.uniforms.tAO.value = aoPass.pdRenderTarget.texture;
  composite.material.uniforms.intensity.value = ao.intensity;
  composite.render(renderer);
  renderer.autoClear = autoClear;
}

export function disposeAoPipeline(pipeline) {
  if (!pipeline) return;
  pipeline.aoPass.dispose();
  pipeline.composite.material.dispose();
  pipeline.composite.dispose();
}

export function applyShadowFlags(root, enabled) {
  if (!root) return;
  root.traverse((child) => {
    if (!child?.isMesh) return;
    // Depth-only occluders (see native-occluder.js) are invisible.
    child.castShadow = Boolean(enabled) && !child.userData?.nativeDepthOnly;
    child.receiveShadow = Boolean(enabled);
  });
}

export function createShadowReceiver() {
  const geometry = new THREE.PlaneGeometry(1, 1);
  const material = new THREE.ShadowMaterial({
    color: 0x000000,
    opacity: 0.22,
  });
  material.depthWrite = false;

  const receiver = new THREE.Mesh(geometry, material);
  receiver.name = "shadow-receiver";
  receiver.rotation.x = -Math.PI / 2;
  receiver.receiveShadow = true;
  receiver.visible = false;
  receiver.renderOrder = -1;
  return receiver;
}

// Scratch vectors: updateShadowReceiver runs per frame.
const _receiverSize = new THREE.Vector3();
const _receiverCenter = new THREE.Vector3();

export function updateShadowReceiver(receiver, { bounds, enabled } = {}) {
  if (!receiver) return null;

  const shouldShow = Boolean(enabled && bounds?.isBox3 && !bounds.isEmpty?.());
  receiver.visible = shouldShow;
  if (!shouldShow) return receiver;

  const size = bounds.getSize(_receiverSize);
  const center = bounds.getCenter(_receiverCenter);
  const width = Math.max(SHADOW_RECEIVER_MIN_SIZE, size.x + SHADOW_RECEIVER_PADDING * 2);
  const depth = Math.max(SHADOW_RECEIVER_MIN_SIZE, size.z + SHADOW_RECEIVER_PADDING * 2);

  receiver.scale.set(width, depth, 1);
  receiver.position.set(center.x, bounds.min.y + SHADOW_RECEIVER_EPSILON, center.z);
  return receiver;
}

export function disposeShadowReceiver(receiver) {
  if (!receiver) return;
  receiver.parent?.remove(receiver);
  receiver.geometry?.dispose?.();
  receiver.material?.dispose?.();
}

export function updateDirectionalShadowFrustum(light, fitDistance) {
  if (!light?.isDirectionalLight || !light.shadow?.camera) return;

  const radius = Math.max(1, Number.isFinite(fitDistance) ? fitDistance : 1);
  const camera = light.shadow.camera;

  light.castShadow = true;
  camera.left = -radius;
  camera.right = radius;
  camera.top = radius;
  camera.bottom = -radius;
  camera.near = Math.max(0.5, radius * 0.05);
  camera.far = Math.max(10, radius * 6);
  camera.updateProjectionMatrix?.();
}

export function configureShadowLight(light, enabled) {
  if (!light?.isDirectionalLight) return;

  light.castShadow = Boolean(enabled);
  if (light.shadow.mapSize.x !== 2048) {
    light.shadow.map?.dispose?.();
    light.shadow.map = null;
    light.shadow.mapSize.set(2048, 2048);
  }
  light.shadow.radius = 4;
  light.shadow.bias = -0.0005;
  light.shadow.normalBias = 0.02;
}
