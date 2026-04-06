import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";

const SHADOW_RECEIVER_EPSILON = 0.002;
const SHADOW_RECEIVER_MIN_SIZE = 1;
const SHADOW_RECEIVER_PADDING = 0.35;

export function createAoPipeline({ renderer, scene, camera, width, height, enabled = false }) {
  if (!renderer || !scene || !camera) return null;

  const composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, camera);
  const aoPass = new GTAOPass(scene, camera, width, height);

  aoPass.output = GTAOPass.OUTPUT.Default;
  composer.addPass(renderPass);
  composer.addPass(aoPass);

  const pipeline = { composer, renderPass, aoPass, enabled: false };
  resizeAoPipeline(pipeline, width, height, renderer.getPixelRatio?.() || 1);
  setAoEnabled(pipeline, enabled);
  return pipeline;
}

export function setAoEnabled(pipeline, enabled) {
  if (!pipeline) return null;
  pipeline.enabled = Boolean(enabled);
  if (pipeline.aoPass) {
    pipeline.aoPass.enabled = pipeline.enabled;
  }
  return pipeline;
}

export function resizeAoPipeline(pipeline, width, height, pixelRatio = 1) {
  if (!pipeline?.composer || !width || !height) return;
  pipeline.composer.setPixelRatio?.(pixelRatio);
  pipeline.composer.setSize(width, height);
  pipeline.aoPass?.setSize?.(width, height);
}

export function renderWithEffects({ renderer, composer, scene, camera, aoEnabled }) {
  if (aoEnabled && composer) {
    composer.render();
    return;
  }
  renderer.render(scene, camera);
}

export function disposeAoPipeline(pipeline) {
  if (!pipeline) return;
  pipeline.aoPass?.dispose?.();
  pipeline.renderPass?.dispose?.();
  pipeline.composer?.dispose?.();
}

export function applyShadowFlags(root, enabled) {
  if (!root) return;
  root.traverse((child) => {
    if (!child?.isMesh) return;
    child.castShadow = Boolean(enabled);
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

export function updateShadowReceiver(receiver, { bounds, enabled } = {}) {
  if (!receiver) return null;

  const shouldShow = Boolean(enabled && bounds?.isBox3 && !bounds.isEmpty?.());
  receiver.visible = shouldShow;
  if (!shouldShow) return receiver;

  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
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
  light.shadow.mapSize = new THREE.Vector2(1024, 1024);
  light.shadow.bias = -0.0005;
  light.shadow.normalBias = 0.02;
}
