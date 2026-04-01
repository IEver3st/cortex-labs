import * as THREE from "three";

const shadowReceiverSize = new THREE.Vector3();
const shadowReceiverCenter = new THREE.Vector3();
const shadowReceiverDirection = new THREE.Vector3();

export function renderWithEffects({ renderer, scene, camera }) {
  renderer.render(scene, camera);
}

export function applyShadowFlags(root, enabled) {
  if (!root) return;
  root.traverse((child) => {
    if (!child?.isMesh) return;
    child.castShadow = Boolean(enabled);
    child.receiveShadow = Boolean(enabled);
  });
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

export function createShadowReceiver() {
  const receiver = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.ShadowMaterial({
      color: 0x000000,
      opacity: 0.26,
    }),
  );
  receiver.rotation.x = -Math.PI / 2;
  receiver.receiveShadow = true;
  receiver.castShadow = false;
  receiver.frustumCulled = false;
  receiver.visible = false;
  receiver.renderOrder = -1;
  receiver.userData = { ...(receiver.userData || {}), isShadowReceiver: true };
  return receiver;
}

export function shouldShowShadowReceiver({ cameraY, targetY, viewDirectionY }) {
  if (!Number.isFinite(cameraY) || !Number.isFinite(targetY) || !Number.isFinite(viewDirectionY)) {
    return true;
  }
  return !(cameraY < targetY - 0.02 && viewDirectionY > 0.05);
}

export function updateShadowReceiver(receiver, { bounds, camera, enabled }) {
  if (!receiver) return;
  if (!enabled || !bounds?.isBox3) {
    receiver.visible = false;
    return;
  }

  bounds.getSize(shadowReceiverSize);
  bounds.getCenter(shadowReceiverCenter);

  const width = Math.max(2, shadowReceiverSize.x * 1.35);
  const depth = Math.max(2, shadowReceiverSize.z * 1.35);
  const yOffset = Math.max(0.02, shadowReceiverSize.y * 0.03);

  receiver.position.set(
    shadowReceiverCenter.x,
    bounds.min.y - yOffset,
    shadowReceiverCenter.z,
  );
  receiver.scale.set(width, depth, 1);

  const material = receiver.material;
  if (material) {
    material.opacity = 0.26;
  }

  camera?.getWorldDirection?.(shadowReceiverDirection);
  receiver.visible = shouldShowShadowReceiver({
    cameraY: camera?.position?.y,
    targetY: shadowReceiverCenter.y,
    viewDirectionY: shadowReceiverDirection.y,
  });
}

export function disposeShadowReceiver(receiver) {
  if (!receiver) return;
  receiver.geometry?.dispose?.();
  receiver.material?.dispose?.();
}
