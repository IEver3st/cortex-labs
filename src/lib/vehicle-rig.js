import * as THREE from "three";

// Poses a vehicle's moving parts (doors, bonnet, boot, convertible roofs) from
// the bridge skeleton. Meshes stay in GTA model space (+X right, +Y forward,
// +Z up); a posed bone moves its meshes by its world delta from the bind pose.

const MAX_BONES = 1024;
const IDENTITY_EPSILON = 1e-6;
const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];

const KNOWN_PARTS = [
  ["door_dside_f", "Driver door"],
  ["door_pside_f", "Passenger door"],
  ["door_dside_r", "Rear driver door"],
  ["door_pside_r", "Rear passenger door"],
  ["bonnet", "Bonnet"],
  ["boot", "Boot"],
  ["boot_2", "Second boot"],
];
const KNOWN_ORDER = new Map(KNOWN_PARTS.map(([name], index) => [name, index]));
const KNOWN_LABELS = new Map(KNOWN_PARTS);

function finiteArray(value, length) {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite) ? value.slice() : null;
}

/**
 * Skeleton from manifest v10: { bones: [{ name, tag, parent, translation, rotation }],
 * joints: [{ bone (tag), kind, min, max }] }. Returns null when absent or
 * malformed; a bone with a bad parent becomes a root rather than a cycle.
 */
export function normalizeManifestSkeleton(manifest) {
  const source = manifest?.skeleton;
  if (!Array.isArray(source?.bones) || source.bones.length === 0 || source.bones.length > MAX_BONES) return null;
  const bones = [];
  for (let index = 0; index < source.bones.length; index += 1) {
    const bone = source.bones[index];
    const translation = finiteArray(bone?.translation, 3);
    const rotation = finiteArray(bone?.rotation, 4);
    if (!translation || !rotation) return null;
    const parent = Number.isInteger(bone.parent) && bone.parent >= 0 && bone.parent < index ? bone.parent : -1;
    bones.push({
      name: typeof bone.name === "string" ? bone.name.trim().toLowerCase() : "",
      tag: Number.isInteger(bone.tag) ? bone.tag : -1,
      parent,
      translation,
      rotation,
    });
  }
  const joints = [];
  for (const joint of Array.isArray(source.joints) ? source.joints : []) {
    const min = finiteArray(joint?.min, 3);
    const max = finiteArray(joint?.max, 3);
    if (!Number.isInteger(joint?.bone) || !min || !max) continue;
    if (joint.kind !== "rotation" && joint.kind !== "translation") continue;
    joints.push({ bone: joint.bone, kind: joint.kind, min, max });
  }
  return { bones, joints };
}

function partLabel(name) {
  if (KNOWN_LABELS.has(name)) return KNOWN_LABELS.get(name);
  const words = name.replace(/_/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Part";
}

/**
 * One moving part per joint limit: the axis with the widest range, its rest
 * value (zero clamped into range) and the open end furthest from rest. Rotation
 * values are radians and translations metres, both along the bone's own axis.
 */
export function describeJointParts(skeleton) {
  if (!skeleton) return [];
  const indexByTag = new Map();
  skeleton.bones.forEach((bone, index) => {
    if (bone.tag >= 0 && !indexByTag.has(bone.tag)) indexByTag.set(bone.tag, index);
  });
  const parts = new Map();
  for (const joint of skeleton.joints) {
    const boneIndex = indexByTag.get(joint.bone);
    if (boneIndex == null) continue;
    let axis = 0;
    for (let i = 1; i < 3; i += 1) {
      if (joint.max[i] - joint.min[i] > joint.max[axis] - joint.min[axis]) axis = i;
    }
    const min = joint.min[axis];
    const max = joint.max[axis];
    if (!(max - min > 1e-4)) continue;
    const rest = Math.min(max, Math.max(min, 0));
    const open = Math.abs(max - rest) >= Math.abs(min - rest) ? max : min;
    const name = skeleton.bones[boneIndex].name || `bone${boneIndex}`;
    // A bone with both kinds keeps its rotation; vehicles hinge far more than they slide.
    if (parts.has(name) && parts.get(name).kind === "rotation") continue;
    parts.set(name, { id: name, label: partLabel(name), boneIndex, kind: joint.kind, axis, min, max, rest, open });
  }
  return [...parts.values()].sort((a, b) =>
    (KNOWN_ORDER.get(a.id) ?? 99) - (KNOWN_ORDER.get(b.id) ?? 99) || a.id.localeCompare(b.id));
}

/**
 * Validates a bridge clip ({ duration, samples, rotations, translations }, tracks
 * keyed by bone tag) against the skeleton. Tracks for bones the model lacks are
 * dropped; a clip with no usable track is rejected.
 */
export function normalizeModelClip(clip, skeleton) {
  const samples = clip?.samples;
  const duration = Number(clip?.duration);
  if (!skeleton || !Number.isInteger(samples) || samples < 2 || samples > 100000 || !(duration > 0)) return null;
  const indexByTag = new Map();
  skeleton.bones.forEach((bone, index) => {
    if (bone.tag >= 0 && !indexByTag.has(bone.tag)) indexByTag.set(bone.tag, index);
  });
  const tracks = (list, stride) => (Array.isArray(list) ? list : []).flatMap((track) => {
    const boneIndex = indexByTag.get(track?.bone);
    const values = track?.values;
    if (boneIndex == null || !Array.isArray(values) || values.length !== samples * stride || !values.every(Number.isFinite)) return [];
    return [{ boneIndex, values: Float32Array.from(values) }];
  });
  const rotations = tracks(clip.rotations, 4);
  const translations = tracks(clip.translations, 3);
  if (rotations.length === 0 && translations.length === 0) return null;
  const bones = new Set([...rotations, ...translations].map((track) => track.boneIndex));
  return { duration, samples, rotations, translations, bones };
}

function isIdentity(matrix) {
  const e = matrix.elements;
  for (let i = 0; i < 16; i += 1) {
    if (Math.abs(e[i] - (i % 5 === 0 ? 1 : 0)) > IDENTITY_EPSILON) return false;
  }
  return true;
}

function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Builds the pose controller for a loaded vehicle. `meshes` are the model's
 * THREE.Mesh objects carrying userData.nativeMaterial.boneIndex and, for
 * blended geometry, geometry.userData.skin = { indices: Uint16Array, weights:
 * Uint8Array }. Skin lives on the geometry because Object3D.clone JSON-copies
 * mesh userData, which would turn typed arrays into plain objects.
 * Returns null when the model has no skeleton or nothing that can move.
 */
export function createVehicleRig({ skeleton, meshes }) {
  if (!skeleton || !Array.isArray(meshes)) return null;
  const bones = skeleton.bones;
  const count = bones.length;

  const bindLocal = bones.map((bone) => new THREE.Matrix4().compose(
    new THREE.Vector3().fromArray(bone.translation),
    new THREE.Quaternion().fromArray(bone.rotation).normalize(),
    new THREE.Vector3(1, 1, 1),
  ));
  const bindWorld = [];
  for (let i = 0; i < count; i += 1) {
    const parent = bones[i].parent;
    bindWorld.push(parent >= 0 ? new THREE.Matrix4().multiplyMatrices(bindWorld[parent], bindLocal[i]) : bindLocal[i].clone());
  }
  const bindInverse = bindWorld.map((matrix) => matrix.clone().invert());

  const rigid = [];
  const skinned = [];
  for (const mesh of meshes) {
    if (!mesh?.isMesh) continue;
    const skin = mesh.geometry?.userData?.skin;
    const position = mesh.geometry?.attributes?.position;
    if (skin?.indices && skin?.weights && position && skin.indices.length === position.count * 4 && skin.weights.length === position.count * 4) {
      const bonesUsed = new Set();
      for (let i = 0; i < skin.indices.length; i += 1) {
        if (skin.weights[i] > 0 && skin.indices[i] < count) bonesUsed.add(skin.indices[i]);
      }
      // Loaded geometry is shared read-only with the viewer's model cache, so
      // a mesh that deforms gets its own copy. The original's GPU buffers are
      // released; its arrays stay intact for later cache hits.
      const shared = mesh.geometry;
      mesh.geometry = shared.clone();
      shared.dispose();
      const normal = mesh.geometry.attributes.normal;
      skinned.push({
        mesh,
        skin,
        bonesUsed: [...bonesUsed],
        restPositions: Float32Array.from(mesh.geometry.attributes.position.array),
        restNormals: normal ? Float32Array.from(normal.array) : null,
        posed: false,
      });
      continue;
    }
    const boneIndex = mesh.userData?.nativeMaterial?.boneIndex;
    if (Number.isInteger(boneIndex) && boneIndex >= 0 && boneIndex < count) {
      rigid.push({ mesh, boneIndex, posed: false });
    }
  }

  // A part needs geometry that follows its bone or a descendant of it.
  const geometryBones = new Set([...rigid.map((entry) => entry.boneIndex), ...skinned.flatMap((entry) => entry.bonesUsed)]);
  const movesGeometry = (boneIndex) => {
    for (let i = 0; i < count; i += 1) {
      if (!geometryBones.has(i)) continue;
      for (let bone = i, guard = 0; bone >= 0 && guard < count; bone = bones[bone].parent, guard += 1) {
        if (bone === boneIndex) return true;
      }
    }
    return false;
  };
  const parts = describeJointParts(skeleton).filter((part) => movesGeometry(part.boneIndex));
  const partsById = new Map(parts.map((part) => [part.id, part]));
  if (parts.length === 0 && skinned.length === 0 && rigid.length === 0) return null;

  const indexByName = new Map();
  bones.forEach((bone, index) => {
    if (bone.name && !indexByName.has(bone.name)) indexByName.set(bone.name, index);
  });
  // Objects fitted to a bone from outside the model, such as mod kit parts.
  // The bridge exports them in vehicle space, so each takes its bone's delta.
  const attached = new Map();
  const attachedMeshBones = new WeakMap();

  const values = new Map(parts.map((part) => [part.id, part.rest]));
  const transitions = new Map();
  let clip = null;
  let roofValue = 0;
  let roofTransition = null;
  let dirty = false;

  const local = Array.from({ length: count }, () => new THREE.Matrix4());
  const world = Array.from({ length: count }, () => new THREE.Matrix4());
  const delta = Array.from({ length: count }, () => new THREE.Matrix4());
  const deltaIdentity = new Array(count).fill(true);
  const translation = new THREE.Vector3();
  const slideAxis = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const jointRotation = new THREE.Quaternion();
  const unitScale = new THREE.Vector3(1, 1, 1);
  const scratch = new Float32Array(4);

  function sampleClip(boneTranslations, boneRotations) {
    if (!clip || roofValue <= 0) return;
    const position = Math.min(1, Math.max(0, roofValue)) * (clip.samples - 1);
    const frame = Math.min(clip.samples - 2, Math.floor(position));
    const t = position - frame;
    for (const track of clip.translations) {
      const a = frame * 3;
      const b = a + 3;
      boneTranslations.set(track.boneIndex, new THREE.Vector3(
        track.values[a] + (track.values[b] - track.values[a]) * t,
        track.values[a + 1] + (track.values[b + 1] - track.values[a + 1]) * t,
        track.values[a + 2] + (track.values[b + 2] - track.values[a + 2]) * t,
      ));
    }
    for (const track of clip.rotations) {
      THREE.Quaternion.slerpFlat(scratch, 0, track.values, frame * 4, track.values, frame * 4 + 4, t);
      boneRotations.set(track.boneIndex, new THREE.Quaternion().fromArray(scratch).normalize());
    }
  }

  function computeDeltas() {
    const clipTranslations = new Map();
    const clipRotations = new Map();
    sampleClip(clipTranslations, clipRotations);
    const offsets = new Map();
    for (const part of parts) {
      const value = values.get(part.id);
      if (Math.abs(value) > 1e-7) offsets.set(part.boneIndex, { part, value });
    }
    for (let i = 0; i < count; i += 1) {
      const bone = bones[i];
      const offset = offsets.get(i);
      if (!offset && !clipTranslations.has(i) && !clipRotations.has(i)) {
        local[i].copy(bindLocal[i]);
      } else {
        translation.copy(clipTranslations.get(i) || translation.fromArray(bone.translation));
        rotation.copy(clipRotations.get(i) || rotation.fromArray(bone.rotation)).normalize();
        if (offset?.part.kind === "rotation") {
          rotation.multiply(jointRotation.setFromAxisAngle(AXES[offset.part.axis], offset.value));
        } else if (offset?.part.kind === "translation") {
          // Slides run along the bone's own axis. Sliding doors tilt their dummy a few
          // degrees so the door travels outward and clears the body instead of clipping.
          translation.addScaledVector(slideAxis.copy(AXES[offset.part.axis]).applyQuaternion(rotation), offset.value);
        }
        local[i].compose(translation, rotation, unitScale);
      }
      const parent = bone.parent;
      if (parent >= 0) world[i].multiplyMatrices(world[parent], local[i]);
      else world[i].copy(local[i]);
      delta[i].multiplyMatrices(world[i], bindInverse[i]);
      deltaIdentity[i] = isIdentity(delta[i]);
    }
  }

  function applyRigid() {
    for (const entry of rigid) {
      const identity = deltaIdentity[entry.boneIndex];
      if (identity && !entry.posed) continue;
      const { mesh } = entry;
      if (identity) {
        mesh.position.set(0, 0, 0);
        mesh.quaternion.identity();
      } else {
        delta[entry.boneIndex].decompose(mesh.position, mesh.quaternion, translation);
      }
      mesh.scale.set(1, 1, 1);
      mesh.updateMatrix();
      entry.posed = !identity;
    }
  }

  function applySkinned() {
    const point = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const sum = new THREE.Vector3();
    const sumNormal = new THREE.Vector3();
    const normalMatrices = delta.map((matrix) => new THREE.Matrix3().setFromMatrix4(matrix));
    for (const entry of skinned) {
      const identity = entry.bonesUsed.every((bone) => deltaIdentity[bone]);
      if (identity && !entry.posed) continue;
      const geometry = entry.mesh.geometry;
      const positions = geometry.attributes.position.array;
      const normals = geometry.attributes.normal?.array || null;
      if (identity) {
        positions.set(entry.restPositions);
        if (normals && entry.restNormals) normals.set(entry.restNormals);
      } else {
        const { indices, weights } = entry.skin;
        const vertexCount = positions.length / 3;
        for (let v = 0; v < vertexCount; v += 1) {
          sum.set(0, 0, 0);
          sumNormal.set(0, 0, 0);
          let total = 0;
          for (let k = 0; k < 4; k += 1) {
            const weight = weights[v * 4 + k];
            const bone = indices[v * 4 + k];
            if (weight === 0 || bone >= count) continue;
            total += weight;
            point.fromArray(entry.restPositions, v * 3).applyMatrix4(delta[bone]);
            sum.addScaledVector(point, weight);
            if (entry.restNormals) {
              normal.fromArray(entry.restNormals, v * 3).applyMatrix3(normalMatrices[bone]);
              sumNormal.addScaledVector(normal, weight);
            }
          }
          if (total === 0) {
            positions[v * 3] = entry.restPositions[v * 3];
            positions[v * 3 + 1] = entry.restPositions[v * 3 + 1];
            positions[v * 3 + 2] = entry.restPositions[v * 3 + 2];
            continue;
          }
          sum.multiplyScalar(1 / total).toArray(positions, v * 3);
          if (normals && entry.restNormals) sumNormal.normalize().toArray(normals, v * 3);
        }
      }
      geometry.attributes.position.needsUpdate = true;
      if (geometry.attributes.normal) geometry.attributes.normal.needsUpdate = true;
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      entry.posed = !identity;
    }
  }

  function placeAttached(object, boneIndex) {
    if (deltaIdentity[boneIndex]) object.matrix.identity();
    else object.matrix.copy(delta[boneIndex]);
    object.matrixWorldNeedsUpdate = true;
  }

  function apply() {
    computeDeltas();
    applyRigid();
    applySkinned();
    for (const [object, boneIndex] of attached) placeAttached(object, boneIndex);
    dirty = false;
  }

  // Mod part meshes carry bone indices into their own one-bone skeleton, so
  // only the bone they were attached to counts.
  function meshBoneIndex(mesh) {
    const fitted = mesh ? attachedMeshBones.get(mesh) : undefined;
    if (fitted !== undefined) return fitted;
    if (mesh?.userData?.vehicleModPart) return null;
    const boneIndex = mesh?.userData?.nativeMaterial?.boneIndex;
    return Number.isInteger(boneIndex) ? boneIndex : null;
  }

  function clampValue(part, value) {
    return Math.min(part.max, Math.max(part.min, Number(value) || 0));
  }

  const rig = {
    parts,
    /** Set by the render loop so it can report when motion settles. */
    wasAnimating: false,
    get hasRoof() {
      return Boolean(clip);
    },
    get roofDuration() {
      return clip?.duration ?? 0;
    },
    /** Current value of a part (joint units), or the roof's 0-1 progress for "roof". */
    getValue(id) {
      if (id === "roof") return roofValue;
      return values.get(id) ?? null;
    },
    /** Target a part or the roof would settle at, including running transitions. */
    getTarget(id) {
      if (id === "roof") return roofTransition ? roofTransition.to : roofValue;
      return transitions.get(id)?.to ?? values.get(id) ?? null;
    },
    /** 0 closed .. 1 fully open, for display. */
    getOpenAmount(id) {
      if (id === "roof") return roofValue;
      const part = partsById.get(id);
      if (!part) return 0;
      return Math.abs(values.get(id) - part.rest) / Math.max(1e-6, Math.abs(part.open - part.rest));
    },
    isOpen(id) {
      if (id === "roof") return rig.getTarget("roof") > 0.5;
      const part = partsById.get(id);
      if (!part) return false;
      const target = rig.getTarget(id);
      return Math.abs(target - part.rest) > Math.abs(part.open - part.rest) * 0.5;
    },
    /**
     * Moves a part (joint units) or the roof (0-1). Animated moves ease over a
     * duration that scales with the distance; the roof plays at clip speed.
     */
    setValue(id, value, { animate = true, now = performance.now() } = {}) {
      if (id === "roof") {
        if (!clip) return false;
        const to = Math.min(1, Math.max(0, Number(value) || 0));
        if (!animate) {
          roofTransition = null;
          roofValue = to;
        } else if (Math.abs(to - roofValue) > 1e-6) {
          roofTransition = { from: roofValue, to, start: now, duration: Math.abs(to - roofValue) * clip.duration * 1000, linear: true };
        }
        dirty = true;
        return true;
      }
      const part = partsById.get(id);
      if (!part) return false;
      const to = clampValue(part, value);
      const from = values.get(id);
      if (!animate) {
        transitions.delete(id);
        values.set(id, to);
      } else if (Math.abs(to - from) > 1e-6) {
        const travel = Math.abs(to - from) / Math.max(1e-6, part.max - part.min);
        transitions.set(id, { from, to, start: now, duration: 250 + 650 * travel });
      }
      dirty = true;
      return true;
    },
    toggle(id, options) {
      if (id === "roof") return rig.setValue("roof", rig.isOpen("roof") ? 0 : 1, options);
      const part = partsById.get(id);
      if (!part) return false;
      return rig.setValue(id, rig.isOpen(id) ? part.rest : part.open, options);
    },
    /** Opens or closes every part that rests at one end of its range; turrets and other two-sided joints stay put. */
    setAll(open, options) {
      for (const part of parts) {
        if (part.rest !== part.min && part.rest !== part.max) continue;
        rig.setValue(part.id, open ? part.open : part.rest, options);
      }
    },
    /** Replaces the convertible roof clip; null removes it and lowers nothing. */
    setClip(nextClip) {
      clip = nextClip ? normalizeModelClip(nextClip, skeleton) : null;
      if (!clip) {
        roofValue = 0;
        roofTransition = null;
      }
      dirty = true;
      return Boolean(clip);
    },
    /** The moving part a mesh belongs to: its bone or the nearest posed ancestor. */
    partForMesh(mesh) {
      const boneIndex = meshBoneIndex(mesh);
      if (boneIndex == null) return null;
      for (let bone = boneIndex, guard = 0; bone >= 0 && guard < count; bone = bones[bone].parent, guard += 1) {
        const part = parts.find((entry) => entry.boneIndex === bone);
        if (part) return part;
      }
      return null;
    },
    /**
     * What clicking a mesh moves: { kind: "part", part } for a door, bonnet or
     * boot, { kind: "roof" } for geometry the roof clip animates, else null.
     */
    targetForMesh(mesh) {
      const part = rig.partForMesh(mesh);
      if (part) return { kind: "part", part };
      if (!clip) return null;
      const skinnedEntry = skinned.find((entry) => entry.mesh === mesh);
      const meshBones = skinnedEntry ? skinnedEntry.bonesUsed : [meshBoneIndex(mesh)];
      for (const boneIndex of meshBones) {
        if (!Number.isInteger(boneIndex)) continue;
        for (let bone = boneIndex, guard = 0; bone >= 0 && guard < count; bone = bones[bone].parent, guard += 1) {
          if (clip.bones.has(bone)) return { kind: "roof" };
        }
      }
      return null;
    },
    /**
     * Fits `object` (a sibling of the model's meshes, in vehicle space) to the
     * named bone so it moves with the door, bonnet or boot that bone belongs
     * to, and clicking its meshes moves that part. Returns false and leaves
     * the object in place for a bone this skeleton lacks.
     */
    attach(object, boneName) {
      const boneIndex = indexByName.get(String(boneName || "").trim().toLowerCase());
      if (!object || boneIndex == null) return false;
      attached.set(object, boneIndex);
      object.traverse((child) => {
        if (child.isMesh) attachedMeshBones.set(child, boneIndex);
      });
      object.matrixAutoUpdate = false;
      placeAttached(object, boneIndex);
      return true;
    },
    /** Stops posing an attached object and returns it to vehicle space. */
    detach(object) {
      if (!attached.delete(object)) return;
      object.traverse((child) => {
        if (child.isMesh) attachedMeshBones.delete(child);
      });
      object.matrix.identity();
      object.matrixWorldNeedsUpdate = true;
    },
    /**
     * Model-space pivot and axis of a part as currently posed, for dragging it
     * in the viewport. Turning a hinge about its axis or sliding along it leaves
     * that axis in place.
     */
    getPartFrame(id) {
      const part = partsById.get(id);
      if (!part) return null;
      const origin = new THREE.Vector3().setFromMatrixPosition(world[part.boneIndex]);
      const axis = AXES[part.axis].clone().transformDirection(world[part.boneIndex]);
      return { origin, axis, part };
    },
    /** Advances transitions and reposes the meshes. Returns true while anything is still moving. */
    update(now = performance.now()) {
      let moving = false;
      for (const [id, transition] of transitions) {
        const t = transition.duration > 0 ? Math.min(1, (now - transition.start) / transition.duration) : 1;
        values.set(id, transition.from + (transition.to - transition.from) * easeInOut(t));
        if (t >= 1) transitions.delete(id);
        else moving = true;
        dirty = true;
      }
      if (roofTransition) {
        const t = roofTransition.duration > 0 ? Math.min(1, (now - roofTransition.start) / roofTransition.duration) : 1;
        roofValue = roofTransition.from + (roofTransition.to - roofTransition.from) * t;
        if (t >= 1) roofTransition = null;
        else moving = true;
        dirty = true;
      }
      if (dirty) apply();
      return moving;
    },
    /** Returns every posed mesh to its bind pose and stops all motion. */
    reset() {
      transitions.clear();
      roofTransition = null;
      roofValue = 0;
      for (const part of parts) values.set(part.id, part.rest);
      apply();
    },
    dispose() {
      rig.reset();
      attached.clear();
      rigid.length = 0;
      skinned.length = 0;
    },
  };
  apply();
  return rig;
}
