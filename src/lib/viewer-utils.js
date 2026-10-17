import * as THREE from "three";
import { DDSLoader } from "three/examples/jsm/loaders/DDSLoader";
import { TGALoader } from "three/examples/jsm/loaders/TGALoader";
import { DFFLoader } from "dff-loader";
import { invoke } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import { parseYftAsync } from "./yft-loader";
import { userTextureUvAttribute } from "./clmesh-object.js";
import { resolvePaintLayerSlot } from "./native-material-plan.js";
import { diffusePointLights } from "./native-shader.js";
import { normalizeVehiclePaint, paintDisplayColor } from "./vehicle-paint.js";
import { parseDDSAsync } from "./dds";
import { createWorkerClient } from "./worker-client.js";
import { selectPdnImage } from "./pdn-reader.js";
import {
  updateFlyLookQuaternion,
  updateFlyMovementVector,
} from "./camera-flight.js";

export {
  CAMERA_PRESETS,
  CAMERA_PRESET_KEYS,
  DEFAULT_CAMERA_PRESET,
  getCameraPreset,
  buildCameraFraming,
  computeFramingBounds,
} from "./camera-framing.js";

export const YDD_SCAN_SETTINGS = {
  resourceType: "ydd",
  scanLimit: Number.POSITIVE_INFINITY,
  scanMaxCandidates: 32,
  preferBestDrawable: true,
};

export function getFileExtension(path) {
  if (!path) return "";
  const normalized = path.toString();
  const lastDot = normalized.lastIndexOf(".");
  if (lastDot === -1) return "";
  return normalized.slice(lastDot + 1).toLowerCase();
}

export function getFileNameWithoutExtension(path) {
  if (!path) return "";
  const parts = path.toString().split(/[\\/]/);
  const filename = parts[parts.length - 1] || "";
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? filename : filename.slice(0, dot);
}

export function getTextureMimeType(extension) {
  switch ((extension || "").toLowerCase()) {
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    case "bmp": return "image/bmp";
    case "tif": case "tiff": return "image/tiff";
    case "avif": return "image/avif";
    case "ai": return "application/pdf";
    case "pdn": return "application/x-pdn";
    case "svg": return "image/svg+xml";
    case "ico": return "image/x-icon";
    default: return "";
  }
}

export function sniffTextureSignature(bytes) {
  if (!bytes || bytes.length < 4) return { kind: "", mime: "" };

  const b0 = bytes[0];
  const b1 = bytes[1];
  const b2 = bytes[2];
  const b3 = bytes[3];

  if (b0 === 0x44 && b1 === 0x44 && b2 === 0x53 && b3 === 0x20) {
    return { kind: "dds", mime: "application/octet-stream" };
  }

  if (b0 === 0x38 && b1 === 0x42 && b2 === 0x50 && b3 === 0x53) {
    return { kind: "psd", mime: "application/octet-stream" };
  }

  if (
    bytes.length >= 8 &&
    b0 === 0x89 &&
    b1 === 0x50 &&
    b2 === 0x4e &&
    b3 === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { kind: "png", mime: "image/png" };
  }

  if (bytes.length >= 3 && b0 === 0xff && b1 === 0xd8 && b2 === 0xff) {
    return { kind: "jpeg", mime: "image/jpeg" };
  }

  if (
    bytes.length >= 6 &&
    b0 === 0x47 &&
    b1 === 0x49 &&
    b2 === 0x46 &&
    b3 === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return { kind: "gif", mime: "image/gif" };
  }

  if (
    bytes.length >= 12 &&
    b0 === 0x52 &&
    b1 === 0x49 &&
    b2 === 0x46 &&
    b3 === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { kind: "webp", mime: "image/webp" };
  }

  if (b0 === 0x42 && b1 === 0x4d) {
    return { kind: "bmp", mime: "image/bmp" };
  }

  if (
    bytes.length >= 4 &&
    ((b0 === 0x49 && b1 === 0x49 && b2 === 0x2a && b3 === 0x00) ||
      (b0 === 0x4d && b1 === 0x4d && b2 === 0x00 && b3 === 0x2a) ||
      (b0 === 0x49 && b1 === 0x49 && b2 === 0x2b && b3 === 0x00) ||
      (b0 === 0x4d && b1 === 0x4d && b2 === 0x00 && b3 === 0x2b))
  ) {
    return { kind: "tiff", mime: "image/tiff" };
  }

  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70 &&
    bytes[8] === 0x61 &&
    bytes[9] === 0x76 &&
    bytes[10] === 0x69 &&
    (bytes[11] === 0x66 || bytes[11] === 0x73)
  ) {
    return { kind: "avif", mime: "image/avif" };
  }

  if (b0 === 0x25 && b1 === 0x50 && b2 === 0x44 && b3 === 0x46) {
    return { kind: "ai", mime: "application/pdf" };
  }

  if (b0 === 0x25 && b1 === 0x21 && b2 === 0x50 && b3 === 0x53) {
    return { kind: "ai-ps", mime: "application/postscript" };
  }

  // Paint.NET: "PDN3" magic
  if (b0 === 0x50 && b1 === 0x44 && b2 === 0x4e && b3 === 0x33) {
    return { kind: "pdn", mime: "application/x-pdn" };
  }

  return { kind: "", mime: "" };
}

export function heightToFootprintRatio(size) {
  if (!size) return Infinity;
  const footprint = Math.max(size.x, size.z);
  if (!Number.isFinite(footprint) || footprint <= 0) return Infinity;
  const ratio = size.y / footprint;
  return Number.isFinite(ratio) ? ratio : Infinity;
}

export function maybeAutoFixYftUpAxis(object, initialSize) {
  if (!object) return false;

  const scoreA = heightToFootprintRatio(initialSize);
  if (!Number.isFinite(scoreA) || scoreA <= 1.2) return false;

  const originalQuat = object.quaternion.clone();

  object.rotateX(-Math.PI / 2);
  object.updateMatrixWorld(true);

  const boxB = new THREE.Box3().setFromObject(object);
  const sizeB = new THREE.Vector3();
  boxB.getSize(sizeB);
  const scoreB = heightToFootprintRatio(sizeB);

  object.quaternion.copy(originalQuat);
  object.updateMatrixWorld(true);

  const isMeaningfullyBetter = Number.isFinite(scoreB) && scoreB < scoreA * 0.7;
  const isNoLongerStanding = scoreB <= 1.2;

  if (!isMeaningfullyBetter || !isNoLongerStanding) return false;

  object.rotateX(-Math.PI / 2);
  object.updateMatrixWorld(true);
  object.userData.autoOriented = true;
  return true;
}

export function setupLiveryShader(material) {
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = diffusePointLights(shader.fragmentShader).replace(
      "#include <map_fragment>",
      `
      #ifdef USE_MAP
        vec4 sampledDiffuseColor = texture2D( map, vMapUv );
        #ifdef DECODE_VIDEO_TEXTURE
          sampledDiffuseColor = vec4( mix( pow( sampledDiffuseColor.rgb * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), sampledDiffuseColor.rgb * 0.0773993808, vec3( lessThanEqual( sampledDiffuseColor.rgb, vec3( 0.04045 ) ) ) ), sampledDiffuseColor.w );
        #endif
        float liveryAlpha = sampledDiffuseColor.a;
        vec3 liveryRgb = sampledDiffuseColor.rgb * liveryAlpha;
        diffuseColor.rgb = diffuseColor.rgb * (1.0 - liveryAlpha) + liveryRgb;
        diffuseColor.a = 1.0;
      #endif
      `
    );
  };
  material.needsUpdate = true;
}

export function buildDrawableObject(drawable, options = {}) {
  const useVertexColors = options.useVertexColors !== false;
  const root = new THREE.Group();
  root.name = drawable.name || "yft";
  if (drawable.drawable?.key) {
    root.userData.selectedDrawableKey = drawable.drawable.key;
  }
  if (Array.isArray(drawable.drawableEntries)) {
    root.userData.drawableEntries = drawable.drawableEntries.map((entry) => ({ ...entry }));
  }

  drawable.models.forEach((model) => {
    const modelName = model.name || root.name;
    const group = new THREE.Group();
    group.name = modelName;
    const drawableMetadata = {
      key: model.drawableKey,
      index: model.drawableIndex,
      hash: model.drawableHash,
      hashHex: model.drawableHashHex,
      name: model.drawableName,
    };
    if (drawableMetadata.key) {
      group.userData.drawableKey = drawableMetadata.key;
      group.userData.drawableIndex = drawableMetadata.index;
      group.userData.drawableHash = drawableMetadata.hash;
      group.userData.drawableHashHex = drawableMetadata.hashHex;
      group.userData.drawableName = drawableMetadata.name;
    }

    model.meshes.forEach((mesh) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));

      if (mesh.normals) {
        geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
      }

      if (mesh.uvs) {
        geometry.setAttribute("uv", new THREE.BufferAttribute(mesh.uvs, 2));
      }

      if (mesh.uvs2) {
        geometry.setAttribute("uv2", new THREE.BufferAttribute(mesh.uvs2, 2));
      }

      if (mesh.uvs3) {
        geometry.setAttribute("uv3", new THREE.BufferAttribute(mesh.uvs3, 2));
      }

      if (mesh.uvs4) {
        geometry.setAttribute("uv4", new THREE.BufferAttribute(mesh.uvs4, 2));
      }

      const hasVertexColors = Boolean(mesh.colors && useVertexColors);
      if (hasVertexColors) {
        geometry.setAttribute("color", new THREE.BufferAttribute(mesh.colors, 4));
      }

      if (mesh.tangents) {
        geometry.setAttribute("tangent", new THREE.BufferAttribute(mesh.tangents, 4));
      }

      if (mesh.indices) {
        geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
      }

      const matName = (mesh.materialName || "").toLowerCase();
      const isGlass = matName.includes("glass") || matName.includes("window");
      const isChrome = matName.includes("chrome") || matName.includes("metal");
      const isTire = matName.includes("tire") || matName.includes("rubber");
      const isPaint = matName.includes("paint") || matName.includes("carpaint") || matName.includes("livery");

      let metalness = 0.2;
      let roughness = 0.6;
      let opacity = 1.0;
      let transparent = false;

      if (isGlass) {
        metalness = 0.0;
        roughness = 0.1;
        opacity = 0.3;
        transparent = true;
      } else if (isChrome) {
        metalness = 0.9;
        roughness = 0.1;
      } else if (isTire) {
        metalness = 0.0;
        roughness = 0.9;
      } else if (isPaint) {
        metalness = 0.4;
        roughness = 0.3;
      }

      const material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        metalness,
        roughness,
        opacity,
        transparent,
        side: THREE.FrontSide,
        vertexColors: hasVertexColors,
      });
      material.userData.baseRoughness = roughness;
      material.name = mesh.materialName || "";

      const threeMesh = new THREE.Mesh(geometry, material);
      threeMesh.name = mesh.name || material.name || "mesh";
      threeMesh.userData.materialType = isPaint ? "paint" : isGlass ? "glass" : isChrome ? "chrome" : "default";
      const meshDrawableKey = mesh.drawableKey || drawableMetadata.key;
      if (meshDrawableKey) {
        threeMesh.userData.drawableKey = meshDrawableKey;
        threeMesh.userData.drawableIndex = mesh.drawableIndex ?? drawableMetadata.index;
        threeMesh.userData.drawableHash = mesh.drawableHash ?? drawableMetadata.hash;
        threeMesh.userData.drawableHashHex = mesh.drawableHashHex || drawableMetadata.hashHex;
        threeMesh.userData.drawableName = mesh.drawableName || drawableMetadata.name;
      }
      if (mesh.textureRefs && Object.keys(mesh.textureRefs).length > 0) {
        threeMesh.userData.textureRefs = mesh.textureRefs;
      }
      // Paint data for models parsed here rather than by the bridge; same
      // shape as the manifest's nativeMaterial fields resolvePaintLayerSlot reads.
      threeMesh.userData.gtaShader = {
        shaderName: mesh.materialName || "",
        paintLayer: mesh.paintLayer ?? null,
        diffuseColor: mesh.diffuseColor ?? null,
      };

      group.add(threeMesh);
    });

    if (group.children.length > 0) {
      if (model.transform) {
        const m = new THREE.Matrix4();
        m.fromArray(model.transform);
        group.applyMatrix4(m);
      }
      if (group.parent !== root) {
        root.add(group);
      }
    }
  });

  return root;
}

export function hasRenderableMeshes(object) {
  if (!object) return false;
  let count = 0;
  object.traverse((child) => {
    if (child.isMesh && child.geometry?.attributes?.position?.count > 0) {
      count += 1;
    }
  });
  return count > 0;
}

export function disposeObject(object) {
  object.traverse((child) => {
    if (child.isMesh) {
      if (child.geometry) child.geometry.dispose?.();
      if (child.material) disposeMaterial(child.material);
      if (child.userData?.baseMaterial && child.userData.baseMaterial !== child.material) {
        disposeMaterial(child.userData.baseMaterial);
      }
      if (
        child.userData?.appliedMaterial &&
        child.userData.appliedMaterial !== child.material &&
        child.userData.appliedMaterial !== child.userData.baseMaterial
      ) {
        disposeMaterial(child.userData.appliedMaterial);
      }
    }
  });
}

export function disposeMaterial(material) {
  if (!material) return;
  if (Array.isArray(material)) {
    material.forEach((mat) => mat.dispose?.());
  } else {
    material.dispose?.();
  }
}

export function createFloorGrid() {
  const grid = new THREE.GridHelper(40, 40, 0x333333, 0x222222);
  grid.position.y = -0.01;
  grid.material.opacity = 0.35;
  grid.material.transparent = true;
  grid.userData.isFloor = true;
  return grid;
}

// ---------------------------------------------------------------------------
// Cage Wireframe Overlay
// ---------------------------------------------------------------------------
// Crease angle (degrees) for EdgesGeometry — edges between faces whose dihedral
// angle is less than this are discarded (removes internal triangle diagonals).
const CAGE_EDGE_CREASE_ANGLE = 15;
const CAGE_EDGE_COLOR = 0x3dbaa3; // teal — matches --es-success
const CAGE_BOX_COLOR = 0x5a5a5a; // subtle gray for bounding-box cubes
const CAGE_SMALL_MESH_MAX_DIM_RATIO = 0.075;
const CAGE_SMALL_MESH_MAX_ASPECT = 4.8;
const CAGE_SIZE_EPSILON = 1e-5;
const LIVERY_UV_MIN_CONFIDENCE = 0.55;
const LIVERY_UV_FALLBACK_MARGIN = 0.2;

function scoreUvAttributeForLivery(attribute) {
  if (!attribute || !attribute.array || attribute.itemSize < 2) return -1;
  const count = Math.min(attribute.count || 0, 2000);
  if (!count) return -1;
  const array = attribute.array;
  const stride = attribute.itemSize;
  let inRange = 0;
  let valid = 0;
  for (let i = 0; i < count; i += 1) {
    const u = array[i * stride];
    const v = array[i * stride + 1];
    if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
    valid += 1;
    if (u >= 0 && u <= 1 && v >= 0 && v <= 1) inRange += 1;
  }
  if (!valid) return -1;
  return inRange / valid;
}

function hasUvVariationForLivery(attribute) {
  if (!attribute || !attribute.array || attribute.itemSize < 2) return false;
  const count = Math.min(attribute.count || 0, 2000);
  if (count < 3) return false;
  const array = attribute.array;
  const stride = attribute.itemSize;
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  let valid = 0;
  for (let i = 0; i < count; i += 1) {
    const u = array[i * stride];
    const v = array[i * stride + 1];
    if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
    valid += 1;
    minU = Math.min(minU, u);
    minV = Math.min(minV, v);
    maxU = Math.max(maxU, u);
    maxV = Math.max(maxV, v);
  }
  if (valid < 3) return false;
  return Math.abs(maxU - minU) > 1e-8 || Math.abs(maxV - minV) > 1e-8;
}

function chooseLiveryUvAttribute(geometry) {
  if (!geometry?.attributes) return null;
  const candidates = [
    geometry.attributes.uv || null,
    geometry.attributes.uv2 || null,
    geometry.attributes.uv3 || null,
    geometry.attributes.uv4 || null,
  ];
  const preferredOrder = [1, 2, 3, 0];
  let preferredIndex = -1;
  for (const index of preferredOrder) {
    if (candidates[index]) {
      preferredIndex = index;
      break;
    }
  }
  if (preferredIndex === -1) return null;

  const preferred = candidates[preferredIndex];
  const preferredVaries = hasUvVariationForLivery(preferred);
  const preferredScore = scoreUvAttributeForLivery(preferred);
  let bestScored = null;
  for (let index = 0; index < candidates.length; index += 1) {
    const attribute = candidates[index];
    if (!attribute) continue;
    const score = scoreUvAttributeForLivery(attribute);
    if (score < 0) continue;
    if (!bestScored || score > bestScored.score) {
      bestScored = { index, attribute, score };
    }
  }

  if (bestScored && bestScored.index !== preferredIndex) {
    const shouldFallback =
      !preferredVaries ||
      preferredScore < 0 ||
      (bestScored.score >= LIVERY_UV_MIN_CONFIDENCE &&
        bestScored.score - Math.max(preferredScore, 0) >= LIVERY_UV_FALLBACK_MARGIN);
    if (shouldFallback) return bestScored.attribute;
  }

  return preferred;
}

function isSmallCageMesh(worldSize, modelMaxDimension) {
  if (!worldSize || !Number.isFinite(modelMaxDimension) || modelMaxDimension <= CAGE_SIZE_EPSILON) {
    return false;
  }

  const dims = [worldSize.x, worldSize.y, worldSize.z]
    .map((value) => (Number.isFinite(value) ? Math.abs(value) : 0))
    .filter((value) => value > CAGE_SIZE_EPSILON);
  if (dims.length === 0) return false;

  const maxDim = Math.max(...dims);
  const minDim = Math.max(CAGE_SIZE_EPSILON, Math.min(...dims));
  const dimRatio = maxDim / modelMaxDimension;
  const aspect = maxDim / minDim;
  return dimRatio <= CAGE_SMALL_MESH_MAX_DIM_RATIO && aspect <= CAGE_SMALL_MESH_MAX_ASPECT;
}

/**
 * Build a cage-style wireframe overlay for meshes in `object`:
 *  - Clean edge lines via THREE.EdgesGeometry (no internal triangle edges)
 *  - A wireframe bounding-box cube only for meshes classified as small
 *
 * All created objects are tagged with `userData.isCageOverlay = true` and
 * parented inside a single THREE.Group that is added to the scene root,
 * NOT inside the model hierarchy (so it won't interfere with materials /
 * applyMaterials traversals).
 *
 * Returns the overlay group (caller can keep a ref if needed).
 */
export function buildCageOverlay(object, scene) {
  if (!object || !scene) return null;

  const overlayGroup = new THREE.Group();
  overlayGroup.name = "__cageOverlay";
  overlayGroup.userData.isCageOverlay = true;

  const edgeMaterial = new THREE.LineBasicMaterial({
    color: CAGE_EDGE_COLOR,
    transparent: true,
    opacity: 0.85,
    depthTest: true,
  });

  const boxMaterial = new THREE.LineBasicMaterial({
    color: CAGE_BOX_COLOR,
    transparent: true,
    opacity: 0.45,
    depthTest: true,
  });

  object.updateWorldMatrix(true, true);

  const modelBounds = new THREE.Box3().setFromObject(object);
  const modelSize = new THREE.Vector3();
  modelBounds.getSize(modelSize);
  const modelMaxDimension = Math.max(
    CAGE_SIZE_EPSILON,
    modelSize.x || 0,
    modelSize.y || 0,
    modelSize.z || 0,
  );

  const worldBounds = new THREE.Box3();
  const worldSize = new THREE.Vector3();

  object.traverse((child) => {
    if (!child.isMesh || !child.geometry) return;

    // --- Edge lines ---
    const thresholdAngle = CAGE_EDGE_CREASE_ANGLE;
    const edgesGeo = new THREE.EdgesGeometry(child.geometry, thresholdAngle);
    const edgeLines = new THREE.LineSegments(edgesGeo, edgeMaterial.clone());
    edgeLines.userData.isCageOverlay = true;
    edgeLines.renderOrder = 1;

    // Copy the mesh's world transform so the edges sit exactly on top
    child.updateWorldMatrix(true, false);
    edgeLines.matrixAutoUpdate = false;
    edgeLines.matrix.copy(child.matrixWorld);
    edgeLines.matrixWorldNeedsUpdate = true;

    overlayGroup.add(edgeLines);

    // --- Bounding-box cube (small meshes only) ---
    child.geometry.computeBoundingBox();
    const bb = child.geometry.boundingBox;
    if (bb && !bb.isEmpty()) {
      worldBounds.copy(bb).applyMatrix4(child.matrixWorld);
      worldBounds.getSize(worldSize);
      if (!isSmallCageMesh(worldSize, modelMaxDimension)) return;

      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      bb.getSize(size);
      bb.getCenter(center);

      const boxGeo = new THREE.BoxGeometry(size.x, size.y, size.z);
      const boxEdges = new THREE.EdgesGeometry(boxGeo);
      const boxLines = new THREE.LineSegments(boxEdges, boxMaterial.clone());
      boxLines.userData.isCageOverlay = true;
      boxLines.renderOrder = 1;

      // Position the box in world space using the mesh's transform
      const m = child.matrixWorld.clone();
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scl = new THREE.Vector3();
      m.decompose(pos, quat, scl);

      // The center is in local geometry space — transform to world
      center.applyMatrix4(child.matrixWorld);
      boxLines.position.copy(center);
      boxLines.quaternion.copy(quat);
      boxLines.scale.copy(scl);

      overlayGroup.add(boxLines);
      boxGeo.dispose(); // intermediate geo no longer needed
    }
  });

  scene.add(overlayGroup);
  return overlayGroup;
}

/**
 * Remove and dispose all cage overlay objects from `root`.
 */
export function disposeCageOverlay(root) {
  if (!root) return;
  const toRemove = [];
  root.traverse((child) => {
    if (child.userData?.isCageOverlay) {
      toRemove.push(child);
    }
  });
  for (const obj of toRemove) {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) {
        obj.material.forEach((m) => m.dispose());
      } else {
        obj.material.dispose();
      }
    }
    obj.parent?.remove(obj);
  }
}

const DUAL_DEFAULT_BODY = "#e7ebf0";

function getMaterialNames(material) {
  if (!material) return [];
  if (Array.isArray(material)) {
    return material
      .map((entry) => entry?.name?.trim())
      .filter((name) => typeof name === "string" && name.length > 0);
  }
  const name = material.name?.trim();
  return name ? [name] : [];
}

function ensureMeshLabel(mesh) {
  if (!mesh?.isMesh) return "";
  if (mesh.userData?.meshLabel) return mesh.userData.meshLabel;
  const name = mesh.name?.trim();
  const label = name || `mesh-${mesh.id}`;
  mesh.userData.meshLabel = label;
  return label;
}

function matchesVehicleLiveryName(name) {
  if (!name) return false;
  const raw = name.toString().trim().toLowerCase();
  if (!raw) return false;
  return (
    raw.includes("vehicle_paint") ||
    raw.includes("carpaint") ||
    raw.includes("car_paint") ||
    raw.includes("car-paint") ||
    raw.includes("livery") ||
    raw.includes("vehicle_sign") ||
    raw.includes("sign_1") ||
    raw.includes("sign-1") ||
    raw.includes("sign1") ||
    raw.includes("vehicle_decal") ||
    raw.includes("decal") ||
    raw.includes("logo") ||
    raw.includes("wrap") ||
    raw.includes("body")
  );
}

// Paint slot by name for meshes without shader paint data. Lights, badges and
// trim are not body paint.
function detectVehicleColorSlot(names) {
  const raw = names
    .map((name) => (typeof name === "string" ? name.trim().toLowerCase() : ""))
    .filter(Boolean)
    .join(" ");

  if (!raw) return null;

  if (
    /vehicle[_-]?paint[_-]?2/.test(raw) ||
    /car[_-]?paint[_-]?2/.test(raw) ||
    /carpaint2/.test(raw) ||
    /secondary/.test(raw)
  ) {
    return "secondary";
  }

  if (
    raw.includes("lightsemissive") ||
    raw.includes("vehicle_lights") ||
    raw.includes("lightbar") ||
    raw.includes("emissive") ||
    raw.includes("siren") ||
    raw.includes("beacon") ||
    raw.includes("vehicle_detail") ||
    raw.includes("badge") ||
    raw.includes("accent") ||
    raw.includes("trim")
  ) {
    return null;
  }

  if (matchesVehicleLiveryName(raw)) {
    return "primary";
  }

  return null;
}

function getDualMeshMeta(child) {
  if (!child?.isMesh) {
    return {
      baseMaterial: null,
      materialNames: [],
      searchNames: [],
      isGlass: false,
      slotRole: null,
      isLiveryTarget: false,
    };
  }

  const baseMaterial = child.userData?.baseMaterial || child.material;
  const cached = child.userData?.dualTextureMeta;
  if (cached && cached.baseMaterial === baseMaterial) return cached;

  const meshLabel = ensureMeshLabel(child);
  const materialNames = getMaterialNames(baseMaterial);
  const textureRefNames = Object.values(child.userData?.textureRefs || {}).filter(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
  const searchNames = [meshLabel, ...materialNames, ...textureRefNames];
  const isGlass = searchNames.some((name) => {
    const lower = name.toString().trim().toLowerCase();
    return (
      lower.includes("glass") ||
      lower.includes("window") ||
      lower.includes("vehglass") ||
      lower.includes("sign_2") ||
      lower.includes("sign-2") ||
      lower.includes("sign2") ||
      lower.includes("sign_3") ||
      lower.includes("sign-3") ||
      lower.includes("sign3")
    );
  });

  const layerSlot = resolvePaintLayerSlot(child.userData?.nativeMaterial || child.userData?.gtaShader);
  const slotLocked = layerSlot !== undefined;
  const slotRole = isGlass ? null : slotLocked ? layerSlot : detectVehicleColorSlot(searchNames);
  const isLiveryTarget = searchNames.some((name) => matchesVehicleLiveryName(name));
  const meta = { baseMaterial, materialNames, searchNames, isGlass, slotRole, slotLocked, isLiveryTarget };
  child.userData.dualTextureMeta = meta;
  return meta;
}

function getOrCreateDualMaterial(mesh, color, texture, { isGlass = false, useLiveryShader = false } = {}) {
  const baseMaterial = mesh.userData?.baseMaterial || mesh.material;
  if (!mesh.userData.dualMaterial) {
    const baseRoughness = baseMaterial?.userData?.baseRoughness ?? baseMaterial?.roughness ?? (isGlass ? 0.2 : 0.35);
    const baseMetalness = baseMaterial?.metalness ?? (isGlass ? 0 : 0.35);
    const baseOpacity = typeof baseMaterial?.opacity === "number" ? baseMaterial.opacity : 1;
    const material = new THREE.MeshStandardMaterial({
      color,
      map: texture || null,
      side: THREE.DoubleSide,
      metalness: isGlass ? 0 : baseMetalness,
      roughness: isGlass ? Math.min(baseRoughness, 0.22) : baseRoughness,
      transparent: isGlass || baseOpacity < 0.995,
      opacity: isGlass ? Math.min(baseOpacity, 0.55) : baseOpacity,
      depthWrite: !isGlass,
    });
    material.userData.baseRoughness = baseRoughness;
    material.userData.baseMetalness = baseMetalness;
    material.userData.baseOpacity = baseOpacity;
    material.name = baseMaterial?.name || "";
    mesh.userData.dualMaterial = material;
  }

  const material = mesh.userData.dualMaterial;
  material.color.copy(color);
  if (material.map !== (texture || null)) {
    material.map = texture || null;
    material.needsUpdate = true;
  }

  const baseRoughness = material.userData.baseRoughness ?? baseMaterial?.roughness ?? (isGlass ? 0.2 : 0.35);
  const baseMetalness = material.userData.baseMetalness ?? baseMaterial?.metalness ?? (isGlass ? 0 : 0.35);
  const baseOpacity = material.userData.baseOpacity ?? (typeof baseMaterial?.opacity === "number" ? baseMaterial.opacity : 1);

  material.metalness = isGlass ? 0 : baseMetalness;
  material.roughness = isGlass ? Math.min(baseRoughness, 0.22) : baseRoughness;
  material.transparent = isGlass || baseOpacity < 0.995;
  material.opacity = isGlass ? Math.min(baseOpacity, 0.55) : baseOpacity;
  material.depthWrite = !isGlass;
  material.side = THREE.DoubleSide;

  if (useLiveryShader && !material.userData.hasLiveryShader) {
    setupLiveryShader(material);
    material.userData.hasLiveryShader = true;
    material.needsUpdate = true;
  }

  return material;
}

const NEUTRAL_TINT = new THREE.Color(0xffffff);

/**
 * Paints a Multi vehicle: each mesh takes its game paint slot, the livery goes
 * on primary paint and livery-named meshes, and glass keeps a clear tint.
 * With `native`, meshes that have a game material (loadNativeMaterialView)
 * wear it, tinted by their paint slot; the livery still wins on its meshes.
 * Every mesh is assigned its material on each pass, so a later pass (glass
 * designs) can layer over the result and restore it.
 */
export function applyLiveryToModel(object, bodyColor, texture, vehiclePaint, { native = false } = {}) {
  if (!object) return;
  const paint = normalizeVehiclePaint(vehiclePaint, bodyColor || DUAL_DEFAULT_BODY);

  object.traverse((child) => {
    if (!child.isMesh) return;
    if (!child.userData.baseMaterial) child.userData.baseMaterial = child.material;

    const meta = getDualMeshMeta(child);
    const slotRole = meta.slotRole || (meta.isLiveryTarget && !meta.slotLocked && !meta.isGlass ? "primary" : null);
    const shouldTexture = Boolean(texture) && meta.isLiveryTarget && !meta.isGlass && (slotRole === "primary" || !slotRole);
    const shouldApply = Boolean(slotRole) || shouldTexture || meta.isGlass;

    const nativeMaterial = native ? child.userData.nativeMaterialObject : null;
    if (nativeMaterial && !shouldTexture) {
      // Same tint rule as the single viewer: a paint slot's colour, else the
      // material's fixed diffuse colour (linear), else the texture as authored.
      const profile = nativeMaterial.userData?.nativeProfile;
      const nativeSlot = meta.isGlass ? null : meta.slotLocked ? meta.slotRole : meta.slotRole || (profile === "paint" ? "primary" : null);
      const fixedColor = nativeSlot ? null : child.userData.nativeMaterial?.diffuseColor;
      if (nativeSlot) nativeMaterial.color.set(paintDisplayColor(paint[nativeSlot]));
      else if (fixedColor) nativeMaterial.color.setRGB(...fixedColor.slice(0, 3).map((value) => Math.min(1, Math.max(0, value))));
      else nativeMaterial.color.copy(NEUTRAL_TINT);
      if (child.material !== nativeMaterial) child.material = nativeMaterial;
      return;
    }

    if (!shouldApply) {
      if (child.material !== child.userData.baseMaterial) child.material = child.userData.baseMaterial;
      return;
    }

    const color = slotRole ? new THREE.Color(paintDisplayColor(paint[slotRole])) : NEUTRAL_TINT;

    if (shouldTexture) {
      const liveryUv = userTextureUvAttribute(child.geometry, chooseLiveryUvAttribute(child.geometry));
      if (liveryUv && child.geometry.attributes.uv !== liveryUv) {
        child.geometry.setAttribute("uv", liveryUv);
        child.geometry.attributes.uv.needsUpdate = true;
      }
    }

    const material = getOrCreateDualMaterial(child, color, shouldTexture ? texture : null, {
      isGlass: meta.isGlass,
      useLiveryShader: shouldTexture,
    });
    if (child.material !== material) child.material = material;
  });
}

/**
 * Decode an encoded image (PNG/JPG/WebP...) into a texture. createImageBitmap
 * decodes off the main thread and bakes the vertical flip, so the texture is
 * uploaded with flipY=false and tagged `flipBaked` for the settings passes.
 * Falls back to TextureLoader (<img>) when ImageBitmap is unavailable.
 */
export async function loadBlobTexture(blob, { flipY = true, textureLoader = null } = {}) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob, {
        imageOrientation: flipY ? "flipY" : "none",
        premultiplyAlpha: "none",
        colorSpaceConversion: "none",
      });
      const texture = new THREE.Texture(bitmap);
      texture.flipY = false;
      texture.userData = {
        flipBaked: true,
        // Closed by the texture cache on final eviction; a plain dispose() keeps
        // the bitmap so a hidden tab can re-upload it later.
        releaseSource: () => {
          try { bitmap.close?.(); } catch {}
        },
      };
      texture.needsUpdate = true;
      return texture;
    } catch {
      /* fall through to the <img> path */
    }
  }
  const loader = textureLoader || new THREE.TextureLoader();
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Dispose a texture this caller owns outright (not shared through the viewer cache). */
export function disposeTexture(texture) {
  if (!texture) return;
  try { texture.userData?.releaseSource?.(); } catch {}
  texture.dispose?.();
}

export async function loadTextureFromPath(texturePath, textureLoader, renderer) {
  if (!texturePath) return null;

  let bytes = null;
  try { bytes = await readFile(texturePath); } catch { return null; }

  const extension = getFileExtension(texturePath);
  const signature = sniffTextureSignature(bytes);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

  const applySettings = (texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    if (!texture.isCompressedTexture && !texture.userData?.ddsDecoded && !texture.userData?.flipBaked) texture.flipY = true;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.needsUpdate = true;
    texture.anisotropy = renderer?.capabilities.getMaxAnisotropy() || 1;
    if (texture.isDataTexture) {
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      if (!texture.mipmaps || texture.mipmaps.length === 0) {
        texture.generateMipmaps = true;
      }
    }
  };

  const loadNative = async () => {
    const mime = signature.mime || getTextureMimeType(extension) || "application/octet-stream";
    return loadBlobTexture(new Blob([bytes], { type: mime }), { flipY: true, textureLoader });
  };

  const loadDdsCustom = async () => {
    const tex = await parseDDSAsync(buffer, { renderer });
    if (!tex) throw new Error("Custom DDS parser returned null");
    return tex;
  };

  const loadDdsFallback = async () => {
    const loader = new DDSLoader();
    if (typeof loader.parse === "function") return loader.parse(buffer, true);
    const blob = new Blob([bytes], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    try {
      return await new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
    } finally { URL.revokeObjectURL(url); }
  };

  const loadTga = async () => {
    const loader = new TGALoader();
    if (typeof loader.parse === "function") return loader.parse(buffer);
    const blob = new Blob([bytes], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    try {
      return await new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
    } finally { URL.revokeObjectURL(url); }
  };

  const loadPsd = async () => loadPsdTexture(bytes);

  const loadTiff = async () => {
    const mod = await import("utif");
    const UTIF = mod.default || mod;
    const ifds = UTIF.decode(buffer);
    if (!ifds?.length) throw new Error("TIFF contained no images.");
    UTIF.decodeImage(buffer, ifds[0]);
    const rgba = UTIF.toRGBA8(ifds[0]);
    const w = ifds[0].width;
    const h = ifds[0].height;
    if (!rgba || !w || !h) throw new Error("TIFF decode returned empty image data.");
    return new THREE.DataTexture(rgba, w, h, THREE.RGBAFormat);
  };

  const loadAi = async () => {
    const pdfjsLib = await import("pdfjs-dist");
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url
    ).href;
    const loadingTask = pdfjsLib.getDocument({ data: buffer });
    try {
      const pdf = await loadingTask.promise;
      const page = await pdf.getPage(1);
      const viewport = page.getViewport({ scale: 2.0 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const context = canvas.getContext("2d");
      await page.render({ canvasContext: context, viewport }).promise;
      return new THREE.CanvasTexture(canvas);
    } finally {
      // Each getDocument call starts its own pdf.js worker; this ends it.
      await loadingTask.destroy().catch(() => {});
    }
  };

  const loadPdn = async () => loadPdnTexture(bytes, texturePath);

  const attempts = [];
  const kind = (extension || "").toLowerCase();
  const sigKind = (signature.kind || "").toLowerCase();
  const isPdfCompatibleAi = sigKind === "ai" || kind === "ai";
  if (kind === "dds" || sigKind === "dds") { attempts.push(loadDdsCustom); attempts.push(loadDdsFallback); }
  if (kind === "tga") attempts.push(loadTga);
  if (kind === "psd" || sigKind === "psd") attempts.push(loadPsd);
  if (kind === "pdn" || sigKind === "pdn") attempts.push(loadPdn);
  if (kind === "tif" || kind === "tiff" || sigKind === "tif" || sigKind === "tiff") attempts.push(loadTiff);
  if ((kind === "ai" || sigKind === "ai" || sigKind === "ai-ps") && isPdfCompatibleAi) attempts.push(loadAi);
  attempts.push(loadNative);

  let texture = null;
  for (const attempt of attempts) {
    try {
      texture = await attempt();
      if (texture) break;
    } catch (error) {
      if (error?.type === "unsupported-bit-depth") throw error;
      /* continue */
    }
  }
  if (!texture) return null;
  applySettings(texture);
  return texture;
}

export async function loadModelFile(modelPath) {
  if (!modelPath) return null;

  const extension = getFileExtension(modelPath);
  if (extension === "obj") return null;

  if (extension === "yft" || extension === "ydd") {
    let bytes = null;
    try { bytes = await readFile(modelPath); } catch { return null; }
    const name = getFileNameWithoutExtension(modelPath) || `${extension}_model`;
    let drawable = null;
    try {
      drawable = await parseYftAsync(bytes, name, extension === "ydd" ? YDD_SCAN_SETTINGS : undefined);
    } catch { return null; }
    if (!drawable?.models?.length) return null;
    const object = buildDrawableObject(drawable, { useVertexColors: false });
    if (!hasRenderableMeshes(object)) return null;
    object.userData.sourceFormat = extension;
    return object;
  }

  if (extension === "dff") {
    let bytes = null;
    try { bytes = await readFile(modelPath); } catch { return null; }
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const loader = new DFFLoader();
    try { return loader.parse(buffer); } catch { return null; }
  }

  return null;
}

export function setupWasdControls({
  wasdStateRef,
  wasdFrameRef,
  cameraRef,
  controlsRef,
  fitRef,
  requestRenderRef,
  domElement,
  isActiveRef,
}) {
  const state = wasdStateRef.current;
  const controls = controlsRef.current;
  const camera = cameraRef.current;
  if (!state || !controls || !camera || !domElement) return undefined;

  const worldUp = new THREE.Vector3(0, 1, 0);
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const move = new THREE.Vector3();
  const lookForward = new THREE.Vector3();
  const lookEuler = new THREE.Euler(0, 0, 0, "YXZ");
  let lookDistance = 1;
  let orbitEnabledBeforeLook = true;
  let orbitDampingBeforeLook = true;

  state.precision = false;
  state.looking = false;
  state.lookButtonDown = false;
  state.pointerLocked = false;

  domElement.tabIndex = 0;
  domElement.setAttribute(
    "aria-label",
    "3D model preview. Focus this view and use W A S D to fly, Q and E to move vertically, right mouse to look, Alt for precision, and Shift to boost.",
  );

  const shouldIgnoreEvent = (event) => {
    if (event.defaultPrevented) return true;
    if (event.metaKey || event.ctrlKey) return true;
    const target = event.target;
    if (!target || !(target instanceof Element)) return false;
    const tag = target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (target.isContentEditable) return true;
    return false;
  };

  const isActive = () =>
    state.forward || state.back || state.left || state.right || state.up || state.down;

  const isControlSurfaceActive = () => isActiveRef?.current !== false;

  const isEngaged = () =>
    isControlSurfaceActive() && (
      state.looking ||
      document.pointerLockElement === domElement ||
      document.activeElement === domElement
    );

  const stopLoop = () => {
    if (wasdFrameRef.current) {
      cancelAnimationFrame(wasdFrameRef.current);
      wasdFrameRef.current = 0;
    }
  };

  let lastTime = 0;
  const tick = (time) => {
    if (!isControlSurfaceActive()) {
      resetKeys();
      finishLooking({ releasePointerLock: true });
      return;
    }

    const delta = Math.min((time - lastTime) / 1000, 0.05);
    lastTime = time;

    if (!isActive()) {
      stopLoop();
      return;
    }

    updateFlyMovementVector({
      target: move,
      forward,
      right,
      quaternion: camera.quaternion,
      state,
      framingDistance: fitRef.current?.baseDistance || fitRef.current?.distance || 4,
      deltaSeconds: delta,
    });

    if (move.lengthSq() > 0) {
      camera.position.add(move);
      controls.target.add(move);
      controls.update();
      requestRenderRef.current?.();
    }

    wasdFrameRef.current = requestAnimationFrame(tick);
  };

  const startLoop = () => {
    if (wasdFrameRef.current) return;
    lastTime = performance.now();
    wasdFrameRef.current = requestAnimationFrame(tick);
  };

  const setKey = (key, pressed) => {
    switch (key) {
      case "KeyW": state.forward = pressed; return true;
      case "KeyS": state.back = pressed; return true;
      case "KeyA": state.left = pressed; return true;
      case "KeyD": state.right = pressed; return true;
      case "KeyQ": state.down = pressed; return true;
      case "KeyE": state.up = pressed; return true;
      case "ShiftLeft": case "ShiftRight": state.boost = pressed; return true;
      case "AltLeft": case "AltRight": state.precision = pressed; return true;
      default: return false;
    }
  };

  const handleKeyDown = (event) => {
    if (!isEngaged()) return;
    if (shouldIgnoreEvent(event)) return;
    if (!event.code) return;
    const wasActive = isActive();
    const handled = setKey(event.code, true);
    if (!handled) return;
    event.preventDefault();
    if (!wasActive && isActive()) startLoop();
  };

  const handleKeyUp = (event) => {
    if (!event.code) return;
    const handled = setKey(event.code, false);
    if (!handled) return;
    if (!isActive()) stopLoop();
  };

  const resetKeys = () => {
    state.forward = false;
    state.back = false;
    state.left = false;
    state.right = false;
    state.up = false;
    state.down = false;
    state.boost = false;
    state.precision = false;
    stopLoop();
  };

  const syncLookTarget = () => {
    camera.getWorldDirection(lookForward);
    controls.target.copy(camera.position).addScaledVector(lookForward, lookDistance);
  };

  const finishLooking = ({ releasePointerLock = false } = {}) => {
    if (!state.looking && !state.pointerLocked) return;
    state.looking = false;
    state.lookButtonDown = false;
    state.pointerLocked = false;
    domElement.classList.remove("is-fly-looking");
    controls.enableDamping = orbitDampingBeforeLook;
    controls.enabled = orbitEnabledBeforeLook;
    if (releasePointerLock && document.pointerLockElement === domElement) {
      document.exitPointerLock?.();
    }
    requestRenderRef.current?.();
  };

  const handlePointerDown = (event) => {
    domElement.focus({ preventScroll: true });
    if (event.button !== 2) return;

    event.preventDefault();
    event.stopPropagation();
    state.lookButtonDown = true;
    state.looking = true;
    orbitEnabledBeforeLook = controls.enabled;
    orbitDampingBeforeLook = controls.enableDamping;
    controls.enabled = false;
    controls.enableDamping = false;
    controls.update();
    lookDistance = THREE.MathUtils.clamp(
      camera.position.distanceTo(controls.target),
      Math.max((fitRef.current?.baseDistance || 1) * 0.05, 0.05),
      Math.max((fitRef.current?.baseDistance || 1) * 10, 10),
    );
    camera.up.copy(worldUp);
    domElement.classList.add("is-fly-looking");

    try {
      const lockRequest = domElement.requestPointerLock?.();
      lockRequest?.catch?.(() => {});
    } catch {
      // Document-level movement still provides bounded drag-look when pointer lock is unavailable.
    }
  };

  const handlePointerMove = (event) => {
    if (!state.looking) return;
    const movementX = Number.isFinite(event.movementX) ? event.movementX : 0;
    const movementY = Number.isFinite(event.movementY) ? event.movementY : 0;
    if (movementX === 0 && movementY === 0) return;

    updateFlyLookQuaternion({
      quaternion: camera.quaternion,
      euler: lookEuler,
      movementX,
      movementY,
    });
    syncLookTarget();
    controls.update();
    requestRenderRef.current?.();
  };

  const handlePointerUp = (event) => {
    if (event.button !== 2 || !state.lookButtonDown) return;
    event.preventDefault();
    finishLooking({ releasePointerLock: true });
  };

  const handlePointerLockChange = () => {
    const ownsPointerLock = document.pointerLockElement === domElement;
    if (ownsPointerLock) {
      state.pointerLocked = true;
      if (!state.lookButtonDown) finishLooking({ releasePointerLock: true });
      return;
    }
    if (state.pointerLocked) finishLooking();
  };

  const handleWindowBlur = () => {
    resetKeys();
    finishLooking({ releasePointerLock: true });
  };

  const handleVisibilityChange = () => {
    if (document.hidden) handleWindowBlur();
  };

  window.addEventListener("keydown", handleKeyDown, true);
  window.addEventListener("keyup", handleKeyUp);
  window.addEventListener("pointerup", handlePointerUp, true);
  window.addEventListener("blur", handleWindowBlur);
  document.addEventListener("pointermove", handlePointerMove);
  document.addEventListener("pointerlockchange", handlePointerLockChange);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  domElement.addEventListener("pointerdown", handlePointerDown, true);

  return () => {
    window.removeEventListener("keydown", handleKeyDown, true);
    window.removeEventListener("keyup", handleKeyUp);
    window.removeEventListener("pointerup", handlePointerUp, true);
    window.removeEventListener("blur", handleWindowBlur);
    document.removeEventListener("pointermove", handlePointerMove);
    document.removeEventListener("pointerlockchange", handlePointerLockChange);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    domElement.removeEventListener("pointerdown", handlePointerDown, true);
    resetKeys();
    finishLooking({ releasePointerLock: true });
  };
}

export function setupWheelWhileDragging(controls, requestRenderRef) {
  const handler = (event) => {
    if (!controls.enabled || !controls.enableZoom) return;
    if (controls.state === -1) return;
    event.preventDefault();
    controls._handleMouseWheel(controls._customWheelEvent(event));
    requestRenderRef.current?.();
  };
  return handler;
}

export function normalizeLoadedMeshes(object) {
  object.traverse((child) => {
    if (!child.isMesh || !child.geometry) return;
    child.castShadow = false;
    child.receiveShadow = false;
    const normalAttr = child.geometry.attributes?.normal;
    if (!normalAttr || normalAttr.count === 0) {
      child.geometry.computeVertexNormals();
      child.geometry.normalizeNormals?.();
    }
  });
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function toByteFromU16(value) {
  return Math.min(255, Math.max(0, Math.round(value / 257)));
}

function toSrgbByteFromLinear(value) {
  return Math.min(255, Math.max(0, Math.round(Math.pow(clamp01(value), 1 / 2.2) * 255)));
}

function normalizePsdImageData(imageData, bitsPerChannel) {
  if (!imageData) return null;
  const width = imageData.width;
  const height = imageData.height;
  const source = imageData.data;
  if (!width || !height || !source) return null;
  const expected = width * height * 4;
  if (!Number.isFinite(expected) || expected <= 0) return null;
  if (source.length < expected) return null;

  const bitDepth = Number.isFinite(bitsPerChannel) ? bitsPerChannel : 8;

  if (bitDepth === 16 && source instanceof Uint16Array) {
    const data = new Uint8Array(expected);
    for (let i = 0; i < expected; i += 1) {
      data[i] = toByteFromU16(source[i]);
    }
    return { width, height, data };
  }

  if (bitDepth === 32 && source instanceof Float32Array) {
    const data = new Uint8Array(expected);
    for (let i = 0; i < expected; i += 4) {
      data[i] = toSrgbByteFromLinear(source[i]);
      data[i + 1] = toSrgbByteFromLinear(source[i + 1]);
      data[i + 2] = toSrgbByteFromLinear(source[i + 2]);
      data[i + 3] = Math.min(255, Math.max(0, Math.round(clamp01(source[i + 3]) * 255)));
    }
    return { width, height, data };
  }

  if (source instanceof Uint8Array) {
    return { width, height, data: source };
  }

  if (source instanceof Uint8ClampedArray) {
    const data = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    return { width, height, data };
  }

  const data = new Uint8Array(expected);
  for (let i = 0; i < expected; i += 1) {
    const value = source[i] ?? 0;
    data[i] = Math.min(255, Math.max(0, Math.round(value)));
  }
  return { width, height, data };
}

function createPsdTexture(imageData, bitsPerChannel) {
  const normalized = normalizePsdImageData(imageData, bitsPerChannel);
  if (!normalized) return null;
  const texture = new THREE.DataTexture(
    normalized.data,
    normalized.width,
    normalized.height,
    THREE.RGBAFormat,
  );
  texture.premultiplyAlpha = false;
  return texture;
}

let psdWorkerClient = null;
function getPsdWorkerClient() {
  if (typeof Worker === "undefined") return null;
  if (!psdWorkerClient) {
    psdWorkerClient = createWorkerClient(
      () => new Worker(new URL("./psd-worker.js", import.meta.url), { type: "module" }),
      { label: "PSD worker", timeoutMs: 60_000 },
    );
  }
  return psdWorkerClient;
}

async function decodePsdCompositeViaWorker(bytes) {
  const client = getPsdWorkerClient();
  if (!client) return null;
  const copy = bytes.slice(0);
  const result = await client.request({ bytes: copy }, [copy.buffer]);
  if (result?.missingComposite) return { missingComposite: true };
  const data = result?.data;
  const width = Number(result?.width || 0);
  const height = Number(result?.height || 0);
  if (!data || width <= 0 || height <= 0) return null;
  return {
    imageData: { width, height, data: data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data.buffer || data) },
    bitsPerChannel: result.bitsPerChannel,
  };
}

export async function loadPsdTexture(bytes) {
  const bitDepth = detectPsdBitDepth(bytes);
  if (bitDepth === 16 || bitDepth === 32) {
    const error = new Error(`${bitDepth}-bit PSD not supported`);
    error.type = "unsupported-bit-depth";
    error.bitDepth = bitDepth;
    throw error;
  }

  // Preferred: only the merged composite, decoded in a worker.
  try {
    const workerResult = await decodePsdCompositeViaWorker(bytes);
    if (workerResult?.imageData) {
      const texture = createPsdTexture(workerResult.imageData, workerResult.bitsPerChannel);
      if (texture) return texture;
    }
  } catch (error) {
    console.warn("[PSD] Worker decode failed, decoding on the main thread:", error);
  }

  // Fallback: full read on the main thread (also covers a missing composite).
  const { readPsd } = await import("ag-psd");
  let psd = null;
  try {
    psd = readPsd(bytes, { skipThumbnail: true, skipLayerImageData: true });
  } catch {
    psd = null;
  }
  if (!psd?.canvas && !psd?.imageData) {
    psd = readPsd(bytes, { skipThumbnail: true });
  }
  const canvas = psd?.canvas;
  if (canvas && typeof canvas.getContext === "function") {
    const texture = new THREE.CanvasTexture(canvas);
    texture.premultiplyAlpha = false;
    return texture;
  }
  const imageData = psd?.imageData;
  if (imageData) {
    const texture = createPsdTexture(imageData, psd?.bitsPerChannel);
    if (texture) return texture;
  }
  throw new Error("PSD parsed but no image data found.");
}

/**
 * A PSD's merged image as 8-bit RGBA, top row first: `{ width, height, data }`.
 * The composite is decoded in the PSD worker; the main thread reads the file
 * only when the worker cannot.
 */
export async function decodePsdRgba(bytes) {
  const bitDepth = detectPsdBitDepth(bytes);
  if (bitDepth === 16 || bitDepth === 32) throw new Error(`${bitDepth}-bit PSD files are not supported; save it as 8-bit`);
  let imageData = null;
  let bitsPerChannel;
  try {
    const workerResult = await decodePsdCompositeViaWorker(bytes);
    if (workerResult?.imageData) ({ imageData, bitsPerChannel } = workerResult);
  } catch (error) {
    console.warn("[PSD] Worker decode failed, decoding on the main thread:", error);
  }
  if (!imageData) {
    const { readPsd } = await import("ag-psd");
    let psd = null;
    try {
      psd = readPsd(bytes, { skipThumbnail: true, skipLayerImageData: true });
    } catch {
      psd = null;
    }
    if (!psd?.canvas && !psd?.imageData) psd = readPsd(bytes, { skipThumbnail: true });
    bitsPerChannel = psd?.bitsPerChannel;
    imageData = psd?.imageData
      || psd?.canvas?.getContext?.("2d")?.getImageData(0, 0, psd.canvas.width, psd.canvas.height)
      || null;
  }
  const normalized = normalizePsdImageData(imageData, bitsPerChannel);
  if (!normalized) throw new Error("the PSD holds no merged image; save it with Maximize Compatibility on");
  const { data } = normalized;
  return { width: normalized.width, height: normalized.height, data: new Uint8Array(data.buffer, data.byteOffset, normalized.width * normalized.height * 4) };
}

export function detectPsdBitDepth(bytes) {
  if (!bytes || bytes.length < 26) return 8;
  if (bytes[0] !== 0x38 || bytes[1] !== 0x42 || bytes[2] !== 0x50 || bytes[3] !== 0x53) {
    return 8;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint16(22, false);
}

function createPdnDataTexture(result, sourceKind = "pdn") {
  const texture = new THREE.DataTexture(
    result.data,
    result.width,
    result.height,
    THREE.RGBAFormat,
  );
  texture.premultiplyAlpha = false;
  texture.userData = texture.userData || {};
  texture.userData.sourceKind = sourceKind;
  return texture;
}

function pdnLog(level, message, details) {
  const payload = details && typeof details === "object" ? details : undefined;
  if (level === "error") {
    if (payload) console.error(`[PDN] ${message}`, payload);
    else console.error(`[PDN] ${message}`);
    return;
  }
  if (level === "warn") {
    if (payload) console.warn(`[PDN] ${message}`, payload);
    else console.warn(`[PDN] ${message}`);
    return;
  }
  if (payload) console.debug(`[PDN] ${message}`, payload);
  else console.debug(`[PDN] ${message}`);
}

function isTauriRuntimeAvailable() {
  return (
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__ !== "undefined" &&
    typeof window.__TAURI_INTERNALS__?.invoke === "function"
  );
}

function yieldToMainThread() {
  return new Promise((resolve) => {
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
}

async function decodeBase64ToUint8Array(base64Value) {
  if (!base64Value || typeof base64Value !== "string") return null;
  const binary = atob(base64Value);
  const bytes = new Uint8Array(binary.length);
  const chunkSize = 1024 * 1024;
  for (let start = 0; start < binary.length; start += chunkSize) {
    const end = Math.min(start + chunkSize, binary.length);
    for (let index = start; index < end; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    if (end < binary.length) {
      await yieldToMainThread();
    }
  }
  return bytes;
}

let pdnWorkerClient = null;
function getPdnWorkerClient() {
  if (typeof Worker === "undefined") return null;
  if (!pdnWorkerClient) {
    pdnWorkerClient = createWorkerClient(
      () => new Worker(new URL("./pdn-worker.js", import.meta.url), { type: "module" }),
      { label: "PDN worker", timeoutMs: 45_000 },
    );
  }
  return pdnWorkerClient;
}

async function decodePdnViaWorker(bytes) {
  if (!bytes || bytes.length === 0) return null;
  const client = getPdnWorkerClient();
  if (!client) return null;

  const workerBytes = bytes.slice(0);
  const payload = await client.request({ bytes: workerBytes }, [workerBytes.buffer]);
  const width = Number(payload?.width || 0);
  const height = Number(payload?.height || 0);
  const data = payload?.data instanceof Uint8Array
    ? payload.data
    : payload?.data instanceof ArrayBuffer
      ? new Uint8Array(payload.data)
      : null;
  if (!data || width <= 0 || height <= 0) return null;
  return {
    width,
    height,
    data,
    layerCount: payload.layerCount,
    headerLayerCount: payload.headerLayerCount,
    layerNames: payload.layerNames,
  };
}

/**
 * Native `decode_pdn` payload. New contract: raw bytes (ArrayBuffer/Uint8Array)
 * with a little-endian u32 width, u32 height header followed by RGBA pixels.
 * Legacy contract: `{ width, height, rgba_base64 }`. Both are accepted so the
 * Rust and JS changes can land in either order.
 */
export async function parseNativePdnPayload(payload) {
  if (!payload) return null;

  let bytes = null;
  if (payload instanceof ArrayBuffer) bytes = new Uint8Array(payload);
  else if (ArrayBuffer.isView(payload)) bytes = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  else if (Array.isArray(payload)) bytes = Uint8Array.from(payload);

  if (bytes) {
    if (bytes.length < 8) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(0, true);
    const height = view.getUint32(4, true);
    const expected = width * height * 4;
    if (width <= 0 || height <= 0 || bytes.length < 8 + expected) return null;
    return { width, height, data: bytes.subarray(8, 8 + expected) };
  }

  if (typeof payload === "object") {
    const width = Number(payload.width || 0);
    const height = Number(payload.height || 0);
    const rgba = await decodeBase64ToUint8Array(payload.rgba_base64);
    if (!rgba || width <= 0 || height <= 0) return null;
    return { width, height, data: rgba };
  }

  return null;
}

async function decodePdnViaTauri(filePath) {
  const isTauriRuntime = isTauriRuntimeAvailable();

  if (!isTauriRuntime || !filePath || typeof filePath !== "string") {
    pdnLog("debug", "Skipping Tauri decode fallback", {
      isTauriRuntime,
      hasFilePath: typeof filePath === "string" && filePath.length > 0,
    });
    return null;
  }

  pdnLog("debug", "Attempting Tauri decode fallback", { filePath });
  const payload = await invoke("decode_pdn", { path: filePath });
  const parsed = await parseNativePdnPayload(payload);

  pdnLog("debug", "Tauri decode response received", {
    width: parsed?.width || 0,
    height: parsed?.height || 0,
    rgbaLength: parsed?.data?.length || 0,
  });

  return parsed;
}

/**
 * A Paint.NET image as RGBA, top row first: `{ width, height, data }`, chosen
 * from the worker, native and main-thread decoders as loadPdnTexture does.
 */
export async function decodePdnRgba(bytes, filePath) {
  const native = isTauriRuntimeAvailable() && typeof filePath === "string" && filePath.length > 0;
  const { image } = await selectPdnImage({
    decodeInWorker: () => decodePdnViaWorker(bytes),
    decodeNative: native ? () => decodePdnViaTauri(filePath) : null,
    decodeOnMainThread: async () => (await import("./pdn")).decodePdn(bytes),
    onFallback: (reason) => pdnLog("warn", "Worker PDN decode not used", { reason }),
  });
  const data = image.data instanceof Uint8Array ? image.data : new Uint8Array(image.data.buffer || image.data);
  return { width: image.width, height: image.height, data };
}

/**
 * Load a Paint.NET (.pdn) file as a Three.js texture.
 *
 * @param {Uint8Array} bytes  Raw file bytes
 * @param {string} [filePath]  Original file path
 * @returns {Promise<THREE.DataTexture>}
 */
export async function loadPdnTexture(bytes, filePath) {
  const isDesktopTauriDecode =
    isTauriRuntimeAvailable() &&
    typeof filePath === "string" &&
    filePath.length > 0;

  pdnLog("debug", "Starting PDN texture load", {
    filePath: filePath || null,
    byteLength: bytes?.length || 0,
    nativeDecoder: isDesktopTauriDecode,
    workerSupported: typeof Worker !== "undefined",
  });

  try {
    // The worker's JS decode wins only when its layer list checks out; the
    // desktop app otherwise uses the native decoder, whose refusal is final.
    const { image, source } = await selectPdnImage({
      decodeInWorker: () => decodePdnViaWorker(bytes),
      decodeNative: isDesktopTauriDecode ? () => decodePdnViaTauri(filePath) : null,
      decodeOnMainThread: async () => (await import("./pdn")).decodePdn(bytes),
      onFallback: (reason) => pdnLog("warn", "Worker PDN decode not used", { reason }),
    });
    pdnLog("debug", "Using PDN decode result", { source, width: image.width, height: image.height });
    return createPdnDataTexture(image, source);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    pdnLog("error", "PDN texture load failed", { filePath: filePath || null, reason });
    throw new Error(`Failed to decode Paint.NET (.pdn) file (${reason}). Try re-saving in Paint.NET or exporting to PNG.`);
  }
}
