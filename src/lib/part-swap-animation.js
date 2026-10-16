import * as THREE from "three";

/* Mod kit part and extra swaps in the viewer. The outgoing part drops off and
   shrinks away; the incoming one lands from above with a short settle, after
   the outgoing one has started to fall.

   The motion is drawn by proxy meshes in a container of their own, so nothing
   here moves, hides or re-materials the model's meshes: the vehicle rig, the
   visibility rules and every model traversal see the model exactly as it is.
   An incoming part's real meshes are kept off every layer until it lands, then
   their layer mask is restored. Proxies share geometry and materials with the
   real meshes and are never disposed here; the caller keeps those alive until
   `onDone` (a removed mod part is disposed from there). */

export const SWAP_ENTER_MS = 520;
export const SWAP_EXIT_MS = 360;
// In a swap, the new part starts once the old one is on its way down.
export const SWAP_HANDOFF_MS = 140;
// Several parts changing at once land one after another.
export const SWAP_STAGGER_MS = 60;
const MAX_STAGGER_MS = 360;

const easeOutCubic = (t) => 1 - (1 - t) ** 3;

/**
 * Pose of a landing part at t in [0, 1]: `lift` in drop distances above its
 * rest place (dipping about 5% below before it settles) and `scale` about its
 * own centre. Exactly at rest from t = 1.
 */
export function enterPose(t) {
  if (!(t < 1)) return { lift: 0, scale: 1 };
  const u = Math.max(0, t);
  return {
    lift: Math.exp(-8 * u) * Math.cos(7 * u),
    scale: 0.6 + 0.4 * easeOutCubic(Math.min(1, u * 2.2)),
  };
}

/** Pose of a leaving part: a small hop, then a fall while it shrinks to nothing. */
export function exitPose(t) {
  const u = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 1));
  return { lift: 0.6 * u - 2.2 * u * u, scale: 1 - u ** 3 };
}

/** Start delay for the `index`-th part landing in one change. */
export function enterDelay(index, { handoff = false } = {}) {
  return (handoff ? SWAP_HANDOFF_MS : 0) + Math.min(MAX_STAGGER_MS, Math.max(0, index) * SWAP_STAGGER_MS);
}

/** Drop distance for a part of height `partHeight` on a vehicle of size `vehicleSize`. */
export function dropDistance(partHeight, vehicleSize) {
  const size = Number.isFinite(vehicleSize) && vehicleSize > 0 ? vehicleSize : 1;
  const height = Number.isFinite(partHeight) && partHeight > 0 ? partHeight : 0;
  return Math.min(size * 0.2, Math.max(size * 0.05, height * 1.2));
}

/** True when the app or the system asks for reduced motion. */
export function prefersReducedMotion() {
  if (typeof document !== "undefined" && document.documentElement?.dataset?.motion === "reduce") return true;
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

function effectivelyVisible(object, stop) {
  for (let node = object; node; node = node.parent) {
    if (!node.visible) return false;
    if (node === stop) return true;
  }
  return true;
}

/**
 * Animator for one viewer scene. `tick()` advances every running swap and
 * returns true while any is running, so the render loop keeps drawing.
 */
export function createPartSwapAnimator({ scene, now = () => performance.now() }) {
  const container = new THREE.Group();
  container.name = "part-swap-fx";
  container.matrixAutoUpdate = false;
  scene.add(container);
  const jobs = new Set();
  const jobByMesh = new WeakMap();
  const sizeByAnchor = new WeakMap();
  const box = new THREE.Box3();
  const meshBox = new THREE.Box3();
  const center = new THREE.Vector3();
  const pivot = new THREE.Matrix4();
  const step = new THREE.Matrix4();
  const world = new THREE.Matrix4();
  const inverse = new THREE.Matrix4();

  const vehicleSize = (anchor) => {
    let size = sizeByAnchor.get(anchor);
    if (size == null) {
      size = new THREE.Box3().setFromObject(anchor).getSize(new THREE.Vector3()).length();
      sizeByAnchor.set(anchor, size);
    }
    return size;
  };

  const finish = (job) => {
    if (!jobs.delete(job)) return;
    for (const entry of job.entries) {
      container.remove(entry.ghost);
      if (job.kind === "enter") entry.mesh.layers.mask = entry.mask;
      if (jobByMesh.get(entry.mesh) === job) jobByMesh.delete(entry.mesh);
    }
    job.onDone?.();
  };

  // A part already mid-swap finishes first, so its layers are restored before
  // a new swap reads them.
  const settle = (object) => {
    object.traverse((child) => {
      const job = child.isMesh ? jobByMesh.get(child) : null;
      if (job) finish(job);
    });
  };

  /**
   * Starts a swap on `target` (a mesh, a group, or a list of them moving as
   * one part) held by `anchor`, the vehicle root it moves with. kind "enter"
   * lands it; "exit" drops it. Only meshes visible now take part in an exit.
   * Returns false (and calls `onDone` at once) when there is nothing to animate.
   */
  const start = (target, { anchor, kind = "enter", delay = 0, onDone = null } = {}) => {
    const objects = (Array.isArray(target) ? target : [target]).filter(Boolean);
    if (!objects.length || !anchor) {
      onDone?.();
      return false;
    }
    objects.forEach(settle);
    anchor.updateWorldMatrix(true, false);
    for (const object of objects) object.updateWorldMatrix(true, true);
    inverse.copy(anchor.matrixWorld).invert();
    box.makeEmpty();
    const entries = [];
    const add = (child) => {
      if (!child.isMesh || child.isSkinnedMesh || !child.geometry) return;
      if (kind === "exit" && !effectivelyVisible(child, anchor)) return;
      if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
      meshBox.copy(child.geometry.boundingBox).applyMatrix4(child.matrixWorld);
      box.union(meshBox);
      const ghost = new THREE.Mesh(child.geometry, child.material);
      ghost.name = `part-swap:${child.name}`;
      ghost.matrixAutoUpdate = false;
      ghost.visible = false;
      ghost.castShadow = child.castShadow;
      ghost.receiveShadow = child.receiveShadow;
      ghost.renderOrder = child.renderOrder;
      ghost.frustumCulled = false;
      ghost.layers.mask = child.layers.mask;
      ghost.userData = { partSwapGhost: true, nativeMaterial: child.userData?.nativeMaterial };
      entries.push({ mesh: child, ghost, mask: child.layers.mask, local: new THREE.Matrix4().multiplyMatrices(inverse, child.matrixWorld) });
    };
    for (const object of objects) object.traverse(add);
    if (!entries.length || box.isEmpty()) {
      onDone?.();
      return false;
    }
    const job = {
      kind,
      anchor,
      entries,
      onDone,
      start: now() + Math.max(0, delay),
      duration: kind === "enter" ? SWAP_ENTER_MS : SWAP_EXIT_MS,
      center: box.getCenter(new THREE.Vector3()).applyMatrix4(inverse),
      distance: dropDistance(box.getSize(center).y, vehicleSize(anchor)),
    };
    for (const entry of entries) {
      if (kind === "enter") entry.mesh.layers.mask = 0;
      jobByMesh.set(entry.mesh, job);
      container.add(entry.ghost);
    }
    jobs.add(job);
    return true;
  };

  const tick = () => {
    if (!jobs.size) return false;
    const time = now();
    for (const job of [...jobs]) {
      const elapsed = time - job.start;
      const t = elapsed / job.duration;
      if (t >= 1) {
        finish(job);
        continue;
      }
      const waiting = elapsed < 0;
      const pose = job.kind === "enter" ? enterPose(t) : exitPose(t);
      job.anchor.updateWorldMatrix(true, false);
      center.copy(job.center).applyMatrix4(job.anchor.matrixWorld);
      // Scale about the part's centre, then lift it along world up.
      pivot.makeTranslation(center.x, center.y + pose.lift * job.distance, center.z)
        .multiply(step.makeScale(pose.scale, pose.scale, pose.scale))
        .multiply(step.makeTranslation(-center.x, -center.y, -center.z));
      for (const entry of job.entries) {
        const { ghost, mesh } = entry;
        if (job.kind === "enter") {
          // The real mesh may get new materials or be hidden while it lands.
          ghost.material = mesh.material;
          ghost.visible = !waiting && pose.scale > 0 && effectivelyVisible(mesh, job.anchor);
        } else {
          ghost.visible = !waiting ? pose.scale > 0.001 : true;
        }
        world.multiplyMatrices(job.anchor.matrixWorld, entry.local);
        ghost.matrix.multiplyMatrices(pivot, world);
        ghost.matrixWorldNeedsUpdate = true;
      }
    }
    return jobs.size > 0;
  };

  return {
    container,
    enter: (object, options) => start(object, { ...options, kind: "enter" }),
    exit: (object, options) => start(object, { ...options, kind: "exit" }),
    tick,
    get active() {
      return jobs.size > 0;
    },
    /** Ends every swap at once: parts at rest, layers restored, `onDone` run. */
    clear() {
      for (const job of [...jobs]) finish(job);
    },
    /** Forgets a cached vehicle size after the model changes. */
    forget(anchor) {
      if (anchor) sizeByAnchor.delete(anchor);
    },
    dispose() {
      for (const job of [...jobs]) finish(job);
      scene.remove(container);
    },
  };
}
