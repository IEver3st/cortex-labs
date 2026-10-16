// Builds three.js groups for freemode ped drawables.
//
// GTA ped drawables store bind-pose positions, so an unskinned mesh renders as
// the game's A-pose mannequin. Given the ped's shared skeleton, skinned meshes
// are bound to a per-slot copy of it so every slot can take the same pose.
// Parsed drawables and decoded DDS textures are cached per path; slot groups
// own their geometry/material/skeleton and hold texture references that are
// released on dispose.

import * as THREE from "three";
import { parseYftAsync } from "./yft-loader.js";
import { parseDDSAsync, parseDDSHeader } from "./dds.js";
import { baseName, classifyTextureName, isPropComponent } from "./eup.js";
import { computePosedBoneMatrix, propAttachmentMatrix } from "./ped-pose.js";

const YDD_PARSE_OPTIONS = Object.freeze({
  resourceType: "ydd",
  includeAllDrawables: true,
  preferBestDrawable: true,
  scanLimit: Number.POSITIVE_INFINITY,
  scanMaxCandidates: 32,
});

const MAX_CACHED_DRAWABLES = 32;
const MISSING_TEXTURE_COLOR = 0x8f8a84;

const drawableCache = new Map();
const textureCache = new Map();

function abortError(message = "Ped assembly cancelled") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function toArrayBuffer(bytes) {
  if (bytes instanceof ArrayBuffer) return bytes;
  if (ArrayBuffer.isView(bytes)) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  throw new Error("Unsupported byte source");
}

function toUint8(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  throw new Error("Unsupported byte source");
}

export function loadDrawableFromPath(path, { readFile } = {}) {
  if (typeof path !== "string" || !path) {
    return Promise.reject(new Error("Drawable path is required"));
  }
  if (typeof readFile !== "function") {
    return Promise.reject(new Error("readFile is required to load a drawable"));
  }
  const cached = drawableCache.get(path);
  if (cached) {
    drawableCache.delete(path);
    drawableCache.set(path, cached);
    return cached;
  }

  const promise = (async () => {
    const bytes = toUint8(await readFile(path));
    const drawable = await parseYftAsync(bytes, baseName(path).replace(/\.ydd$/i, ""), YDD_PARSE_OPTIONS);
    if (!drawable || !Array.isArray(drawable.models) || drawable.models.length === 0) {
      throw new Error(`No drawable geometry found in ${baseName(path)}`);
    }
    return drawable;
  })();

  promise.catch(() => {
    if (drawableCache.get(path) === promise) drawableCache.delete(path);
  });

  drawableCache.set(path, promise);
  while (drawableCache.size > MAX_CACHED_DRAWABLES) {
    const oldest = drawableCache.keys().next().value;
    drawableCache.delete(oldest);
  }
  return promise;
}

export function acquireTexture(path, { readFile, renderer } = {}) {
  if (typeof path !== "string" || !path) {
    return Promise.reject(new Error("Texture path is required"));
  }
  if (typeof readFile !== "function") {
    return Promise.reject(new Error("readFile is required to load a texture"));
  }
  let entry = textureCache.get(path);
  if (!entry) {
    const promise = (async () => {
      const buffer = toArrayBuffer(await readFile(path));
      const header = parseDDSHeader(buffer);
      const texture = await parseDDSAsync(buffer, { log: false, renderer });
      if (!texture) throw new Error(`Unsupported DDS in ${baseName(path)}`);
      texture.name = baseName(path);
      if (header) {
        texture.userData.ddsInfo = {
          width: header.width,
          height: header.height,
          mipMapCount: header.mipMapCount,
          fmt: header.fmt,
          bytes: buffer.byteLength,
        };
      }
      return texture;
    })();
    entry = { promise, refs: 0, texture: null };
    promise.then(
      (texture) => {
        entry.texture = texture;
        if (entry.refs <= 0) {
          texture.dispose();
          if (textureCache.get(path) === entry) textureCache.delete(path);
        }
      },
      () => {
        if (textureCache.get(path) === entry) textureCache.delete(path);
      },
    );
    textureCache.set(path, entry);
  }
  entry.refs += 1;
  return entry.promise;
}

export function releaseTexture(path) {
  const entry = textureCache.get(path);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  textureCache.delete(path);
  if (entry.texture) entry.texture.dispose();
}

export function getTextureCacheSize() {
  return textureCache.size;
}

export function clearPedAssetCaches() {
  drawableCache.clear();
  for (const entry of textureCache.values()) {
    if (entry.texture) entry.texture.dispose();
  }
  textureCache.clear();
}

export function invalidatePedDrawables(paths) {
  for (const path of paths || []) drawableCache.delete(path);
}

function materialProfile(materialName) {
  const name = String(materialName || "").toLowerCase();
  const isHair = name.includes("hair");
  const isCutout = isHair || name.includes("cutout");
  const isDecal = name.includes("decal");
  const isAlpha = !isCutout && (name.includes("alpha") || isDecal);
  return { isHair, isCutout, isDecal, isAlpha };
}

function createPedMaterial(materialName, textures = {}, { hairTint = true } = {}) {
  const profile = materialProfile(materialName);
  const material = new THREE.MeshStandardMaterial({
    color: textures.diffuse ? 0xffffff : MISSING_TEXTURE_COLOR,
    roughness: 0.82,
    metalness: 0,
    side: profile.isCutout || profile.isAlpha ? THREE.DoubleSide : THREE.FrontSide,
  });
  material.name = materialName || "ped";
  if (textures.diffuse) {
    material.map = textures.diffuse;
  }
  if (textures.normal) {
    textures.normal.colorSpace = THREE.NoColorSpace;
    material.normalMap = textures.normal;
    material.normalScale.set(1, 1);
  }
  if (profile.isCutout) {
    material.alphaTest = 0.5;
    material.transparent = false;
  } else if (profile.isAlpha) {
    material.transparent = true;
    material.depthWrite = true;
  }
  if (profile.isDecal) {
    material.polygonOffset = true;
    material.polygonOffsetFactor = -1;
    material.polygonOffsetUnits = -1;
  }
  if (profile.isHair && textures.diffuse && hairTint) applyHairShading(material);
  material.userData.pedProfile = profile;
  return material;
}

// Hair textures are masks, not colour: green is strand brightness, red marks
// highlight streaks, alpha is the cutout. Colour them the way the game does,
// with a hair and a highlight colour (setGroupHairColor). The texture is
// decoded as sRGB, so the masks are re-encoded before use.
const DEFAULT_HAIR_COLOR = "#2e2018";
const DEFAULT_HAIR_HIGHLIGHT = "#4c3424";

function applyHairShading(material) {
  const uniforms = {
    uHairColor: { value: new THREE.Color(DEFAULT_HAIR_COLOR) },
    uHairHighlight: { value: new THREE.Color(DEFAULT_HAIR_HIGHLIGHT) },
  };
  material.userData.hairUniforms = uniforms;
  // Strands are thin cards: coverage from alpha (with MSAA) keeps their edges soft.
  material.alphaTest = 0.45;
  material.alphaToCoverage = true;
  // Hair is matte: a glossy strand card catches the studio softbox as a white sheet.
  material.roughness = 0.9;
  material.envMapIntensity = 0.35;
  material.customProgramCacheKey = () => "ped-hair";
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uHairColor;\nuniform vec3 uHairHighlight;")
      .replace(
        "#include <map_fragment>",
        [
          "#ifdef USE_MAP",
          "  vec4 hairTexel = texture2D( map, vMapUv );",
          "  vec3 hairMask = sRGBTransferOETF( vec4( hairTexel.rgb, 1.0 ) ).rgb;",
          // Opaque strands average about 0.3 in green; scaling puts an average
          // strand at the chosen colour, lighter strands above it, and the
          // small floor keeps strand roots and tips from going black.
          "  float hairShade = min( 0.18 + hairMask.g * 2.8, 1.6 );",
          "  diffuseColor.rgb *= mix( uHairColor, uHairHighlight, hairMask.r ) * hairShade;",
          "  diffuseColor.a *= hairTexel.a;",
          "#endif",
        ].join("\n"),
      );
  };
}

/** Sets the hair and highlight colours on a slot's hair materials. */
export function setGroupHairColor(group, { color, highlight } = {}) {
  let changed = false;
  group?.traverse?.((child) => {
    if (!child.isMesh) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      const uniforms = material?.userData?.hairUniforms;
      if (!uniforms) continue;
      uniforms.uHairColor.value.set(color || DEFAULT_HAIR_COLOR);
      uniforms.uHairHighlight.value.set(highlight || DEFAULT_HAIR_HIGHLIGHT);
      changed = true;
    }
  });
  return changed;
}

// ped_hair_spiked drawables carry extra layers (an outer shell, mostly) with
// shader orderNumber > 0 that the game does not draw by default; drawn opaque
// they cover the strands like a helmet. CodeWalker skips them the same way.
export function isHiddenHairLayer(mesh) {
  return mesh?.materialName === "ped_hair_spiked" && Number(mesh.orderNumber) > 0;
}

function canSkin(mesh, boneCount) {
  const { skinIndices, skinWeights } = mesh;
  if (!skinIndices || !skinWeights || skinIndices.length !== (mesh.positions.length / 3) * 4) return false;
  for (let i = 0; i < skinIndices.length; i++) {
    if (skinWeights[i] > 0 && skinIndices[i] >= boneCount) return false;
  }
  return true;
}

// One bone hierarchy per slot, built from the parsed bind transforms.
function createBones(skeleton) {
  const bones = skeleton.bones.map((data) => {
    const bone = new THREE.Bone();
    bone.name = `bone_${data.tag.toString(16)}`;
    bone.position.set(data.tx, data.ty, data.tz);
    bone.quaternion.set(data.qx, data.qy, data.qz, data.qw).normalize();
    bone.userData.tag = data.tag;
    bone.userData.bindQuaternion = bone.quaternion.clone();
    bone.userData.bindPosition = bone.position.clone();
    return bone;
  });
  const roots = [];
  skeleton.bones.forEach((data, index) => {
    const parent = data.parentIndex;
    if (parent < bones.length && parent !== index) bones[parent].add(bones[index]);
    else roots.push(bones[index]);
  });
  return { bones, roots };
}

// Pure: turns a parsed drawable into a group. `textures` maps roles
// (diffuse/normal/specular) to THREE textures the caller owns. With
// `skeleton` (the ped's shared skeleton), skinned meshes become SkinnedMesh;
// props stay rigid because their vertices are bone-local. `hairTint: false`
// shows hair textures as they are: only freemode hair is a tint mask.
export function buildDrawableGroup(drawable, { component = "", textures = {}, skeleton = null, hairTint = true } = {}) {
  const root = new THREE.Group();
  root.name = component || drawable?.name || "drawable";
  root.userData.component = component;
  root.userData.skeleton = drawable?.skeleton || null;

  const boneCount = skeleton?.bones?.length || 0;
  const skinnable = boneCount > 0 && !isPropComponent(component) && PROP_BONES[component] === undefined;
  let rig = null;
  const rigFor = () => {
    if (!rig) {
      const { bones, roots } = createBones(skeleton);
      root.add(...roots);
      // Inverses are taken while the group is still at the origin.
      root.updateMatrixWorld(true);
      rig = { bones, skeleton: new THREE.Skeleton(bones) };
      root.userData.bones = bones;
      root.userData.rig = rig.skeleton;
    }
    return rig;
  };

  for (const model of drawable?.models || []) {
    for (const mesh of model.meshes || []) {
      if (!mesh?.positions || mesh.positions.length === 0) continue;
      if (isHiddenHairLayer(mesh)) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
      if (mesh.normals) {
        geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
      }
      if (mesh.uvs) geometry.setAttribute("uv", new THREE.BufferAttribute(mesh.uvs, 2));
      if (mesh.uvs2) geometry.setAttribute("uv1", new THREE.BufferAttribute(mesh.uvs2, 2));
      if (mesh.indices) geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
      if (!mesh.normals) geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();

      const material = createPedMaterial(mesh.materialName, textures, { hairTint });
      let threeMesh;
      if (skinnable && canSkin(mesh, boneCount)) {
        geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(mesh.skinIndices, 4));
        geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(mesh.skinWeights, 4));
        threeMesh = new THREE.SkinnedMesh(geometry, material);
        threeMesh.bind(rigFor().skeleton, new THREE.Matrix4());
        // Skinned bounds cost a CPU skin pass; the ped is always framed, so
        // skip culling rather than recompute them every animated frame.
        threeMesh.frustumCulled = false;
      } else {
        threeMesh = new THREE.Mesh(geometry, material);
      }
      threeMesh.name = mesh.name || material.name;
      threeMesh.userData.materialName = mesh.materialName || "";
      threeMesh.userData.textureRefs = mesh.textureRefs || {};
      threeMesh.frustumCulled = true;
      root.add(threeMesh);
    }
  }

  return root;
}

export function disposeSlotGroup(group) {
  if (!group) return;
  group.userData?.rig?.dispose?.();
  group.traverse((child) => {
    if (!child.isMesh) return;
    child.geometry?.dispose?.();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) material?.dispose?.();
  });
  const acquired = Array.isArray(group.userData?.acquiredTextures)
    ? group.userData.acquiredTextures
    : [];
  for (const path of acquired) releaseTexture(path);
  group.userData.acquiredTextures = [];
  for (const texture of group.userData?.ownedTextures || []) {
    try { texture.userData?.releaseSource?.(); } catch { /* already closed */ }
    texture.dispose?.();
  }
  group.userData.ownedTextures = [];
  group.removeFromParent?.();
}

function pickTexturePaths(texturePaths) {
  const roles = { diffuse: null, normal: null, specular: null };
  const list = Array.isArray(texturePaths) ? texturePaths : [];
  for (const path of list) {
    if (typeof path !== "string" || !path) continue;
    const role = classifyTextureName(baseName(path));
    if (role in roles && !roles[role]) roles[role] = path;
  }
  if (!roles.diffuse && list.length === 1 && classifyTextureName(baseName(list[0])) === "other") {
    roles.diffuse = list[0];
  }
  return roles;
}

/**
 * One drawable of a parsed dictionary, by its name hash: a component ped keeps
 * every component's drawables in one `<ped>.ydd`. Throws when the dictionary
 * has no drawable with that hash.
 */
export function selectDictionaryDrawable(drawable, hash) {
  const wanted = Number(hash) >>> 0;
  const models = (drawable?.models || []).filter((model) => model.drawableHash === wanted);
  if (models.length === 0) {
    throw new Error(`${drawable?.name || "The dictionary"} has no drawable ${wanted.toString(16).padStart(8, "0")}`);
  }
  return { ...drawable, models };
}

// Loads one component slot: parses the ydd, decodes its textures and returns
// a group. Textures are reference-counted; disposeSlotGroup releases them.
// `diffuseTexture` is an already decoded image (an addon piece painted as a
// PSD or PNG) used instead of a dictionary diffuse; the group takes ownership
// and disposes it with the slot.
export async function buildSlotGroup({
  component,
  drawablePath,
  texturePaths = [],
  diffuseTexture = null,
  readFile,
  renderer,
  signal,
  skeleton = null,
  drawableHash = null,
  hairTint = true,
} = {}) {
  throwIfAborted(signal);
  const roles = pickTexturePaths(texturePaths);
  if (diffuseTexture) roles.diffuse = null;
  const acquired = [];
  const textures = diffuseTexture ? { diffuse: diffuseTexture } : {};

  try {
    const drawablePromise = loadDrawableFromPath(drawablePath, { readFile });
    const textureJobs = Object.entries(roles)
      .filter(([role, path]) => path && role !== "specular")
      .map(async ([role, path]) => {
        acquired.push(path);
        try {
          textures[role] = await acquireTexture(path, { readFile, renderer });
        } catch (error) {
          // A broken texture should not hide the drawable; keep the slot
          // visible with the neutral material and report the texture error.
          textures[`${role}Error`] = error;
        }
      });
    const [parsed] = await Promise.all([drawablePromise, ...textureJobs]);
    throwIfAborted(signal);
    // `drawableHash` picks one drawable out of a whole-ped dictionary.
    const drawable = drawableHash === null ? parsed : selectDictionaryDrawable(parsed, drawableHash);

    const group = buildDrawableGroup(drawable, { component, textures, skeleton, hairTint });
    group.userData.drawablePath = drawablePath;
    group.userData.texturePaths = { ...roles };
    group.userData.acquiredTextures = acquired.filter((path) => textureCache.has(path));
    group.userData.ownedTextures = diffuseTexture ? [diffuseTexture] : [];
    group.userData.textureErrors = Object.entries(textures)
      .filter(([key]) => key.endsWith("Error"))
      .map(([key, error]) => ({ role: key.replace(/Error$/, ""), message: error?.message || String(error) }));
    group.userData.meshCount = group.children.length;
    group.userData.stats = computeGroupStats(group);
    group.userData.textureInfo = Object.fromEntries(
      Object.entries(roles)
        .filter(([role, path]) => path && textures[role])
        .map(([role, path]) => [role, { name: baseName(path), ...(textures[role].userData?.ddsInfo || {}) }]),
    );
    if (diffuseTexture) {
      const image = diffuseTexture.image || {};
      group.userData.textureInfo.diffuse = {
        name: diffuseTexture.name || "image",
        width: image.width || image.naturalWidth,
        height: image.height || image.naturalHeight,
      };
    }
    group.userData.textureNames = (Array.isArray(texturePaths) ? texturePaths : []).map((path) => baseName(path));
    return group;
  } catch (error) {
    for (const path of acquired) releaseTexture(path);
    throw error;
  }
}

// Root that converts GTA's Z-up, +Y-forward space into three.js Y-up with the
// ped facing +Z (toward the default front camera).
export function createPedRoot() {
  const root = new THREE.Group();
  root.name = "ped";
  root.rotation.x = -Math.PI / 2;
  return root;
}

// Anchor bone per prop slot. Wrist props (watches, bracelets) are modelled in
// the forearm roll bone's space, about 0.12 m out along its axis, which lands
// them on the wrist joint; hung from SKEL_*_Hand they sit on the knuckles.
// The foot, hip and PH_ hand anchors come from other peds' props.
const PROP_BONES = {
  p_head: 0x796e, p_eyes: 0x796e, p_ears: 0x796e, p_mouth: 0x796e,
  p_lhand: 0x49d9, p_rhand: 0xdead,
  p_lwrist: 0xee4f, p_rwrist: 0xab22, // RB_L_ForeArmRoll, RB_R_ForeArmRoll
  p_lhip: 0xe39f, p_rhip: 0xca72,
  p_hip: 0x2e28, // SKEL_Pelvis
  p_lfoot: 0x3779, p_rfoot: 0xcc4d, // SKEL_L_Foot, SKEL_R_Foot
  ph_lhand: 0xeb95, ph_rhand: 0x6f06, // PH_L_Hand, PH_R_Hand
};

export function findPedSkeleton(root) {
  return root?.children.find((group) => PROP_BONES[group.name] === undefined && !group.name.startsWith("p_") && group.userData.skeleton?.bones?.length)
    ?.userData.skeleton || null;
}

/**
 * Marks a group under the ped root as a held prop: a model hung from a bone
 * with an offset, the way AttachEntityToEntity holds a phone or clipboard.
 * `spec` is a normalized held prop (`bone`, `position`, `rotation`). Held props
 * follow the pose but stay out of the floor and framing bounds.
 */
export function setHeldPropSpec(group, spec) {
  if (!group) return;
  group.userData.heldProp = spec || null;
}

function applyHeldProp(group, skeleton, pose) {
  const matrix = propAttachmentMatrix(skeleton, pose, group.userData.heldProp);
  group.userData.attached = Boolean(matrix);
  if (matrix) matrix.decompose(group.position, group.quaternion, group.scale);
  group.visible = Boolean(matrix) && !group.userData.userHidden;
}

function poseParts(pose) {
  if (pose instanceof Map) return { rotations: pose, translations: null };
  return { rotations: pose?.rotations || null, translations: pose?.translations || null };
}

function hasPose(pose) {
  const { rotations, translations } = poseParts(pose);
  return (rotations?.size || 0) + (translations?.size || 0) > 0;
}

// Places a prop group on its anchor bone. Returns false when the skeleton has
// no matching bone, in which case the group is left untouched. With a `pose`
// (`{ rotations, translations }` or a rotation Map) the prop follows the posed
// bone instead of the bind pose.
export function applyPropAttachment(group, skeleton, pose = null) {
  const tag = PROP_BONES[group?.name];
  if (tag === undefined) return false;
  const index = skeleton?.bones?.findIndex((item) => item.tag === tag) ?? -1;
  if (index < 0) return false;
  if (hasPose(pose)) {
    const matrix = computePosedBoneMatrix(skeleton, pose, index);
    matrix.decompose(group.position, group.quaternion, new THREE.Vector3());
    return true;
  }
  const bone = skeleton.bones[index];
  group.position.set(bone.worldTx, bone.worldTy, bone.worldTz);
  group.quaternion.set(bone.worldQx, bone.worldQy, bone.worldQz, bone.worldQw).normalize();
  return true;
}

/**
 * Applies a pose to a slot's rig: `{ rotations, translations }` (Maps of bone
 * index -> Quaternion / Vector3) or a rotation Map. Missing bones and a null
 * pose return to the bind pose.
 */
// Freemode hair is partly skinned to two helper bones on top of the head. The
// game's multiplayer expression (multiplayer.yed, mp_freemode.expr) crushes them
// under a hat: MH_Hair_Scale scales by 1 + a; MH_Hair_Crown drops 0.05 * (a + b)
// along the head's up (local X) axis and narrows across it by 1 + 0.5 * (a + b).
// `a` is the hairstyle's crush (expressionMods[2], 0.18-0.21 in the game's hair)
// and `b` the hat's (expressionMods[3], 191 / 255 on base-game hats). Pack
// metadata isn't read, so every hat uses these values.
const HAIR_SCALE_TAG = 0xc664;
const HAIR_CROWN_TAG = 0x1675;
const HAT_HAIR_CRUSH = { hair: -0.19, hat: -0.75 };

function applyHatHair(bones) {
  const { hair, hat } = HAT_HAIR_CRUSH;
  for (const bone of bones) {
    if (bone.userData.tag === HAIR_SCALE_TAG) {
      bone.scale.setScalar(1 + hair);
    } else if (bone.userData.tag === HAIR_CROWN_TAG) {
      bone.position.x += 0.05 * (hair + hat);
      bone.scale.set(1, 1 + 0.5 * (hair + hat), 1 + 0.5 * (hair + hat));
    }
  }
}

export function setGroupPose(group, pose) {
  const bones = group?.userData?.bones;
  if (!bones) return false;
  const { rotations, translations } = poseParts(pose);
  bones.forEach((bone, index) => {
    bone.quaternion.copy(rotations?.get(index) || bone.userData.bindQuaternion);
    bone.position.copy(translations?.get(index) || bone.userData.bindPosition);
    bone.scale.set(1, 1, 1);
  });
  if (group.userData.hatHair) applyHatHair(bones);
  group.updateMatrixWorld(true);
  // Skinned bounds are computed from the current pose; drop the cached ones.
  group.traverse((child) => {
    if (!child.isSkinnedMesh) return;
    child.boundingBox = null;
    child.boundingSphere = null;
  });
  return true;
}

/**
 * Multiplies textured materials by `tint` (null restores them). Only groups
 * marked `userData.skinTintable` change; clothing keeps its own colours.
 */
export function setGroupSkinTint(group, tint) {
  if (!group?.userData?.skinTintable) return false;
  group.traverse((child) => {
    if (!child.isMesh) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (material?.map) material.color.set(tint || 0xffffff);
    }
  });
  return true;
}

/**
 * Poses every slot under the ped root and remembers the pose so slots added
 * later and prop attachments follow it. `skeleton` is the shared ped skeleton
 * the rotations were computed from.
 */
export function setPedPose(root, skeleton, pose) {
  if (!root) return;
  root.userData.poseSkeleton = skeleton || null;
  root.userData.pose = pose || null;
  for (const group of root.children) setGroupPose(group, pose);
  updatePedPropAttachments(root);
}

function applySlotVisibility(group) {
  const hidden = Boolean(group.userData.userHidden);
  const isProp = PROP_BONES[group.name] !== undefined;
  group.visible = !hidden && (!isProp || Boolean(group.userData.attached));
}

// User visibility is separate from attachment state: a hidden hat stays hidden
// after the skeleton loads, and a shown hat still waits for its bone.
export function setSlotHidden(group, hidden) {
  if (!group) return;
  group.userData.userHidden = Boolean(hidden);
  applySlotVisibility(group);
  if (group.name === "p_head" && group.parent) updatePedHatHair(group.parent);
}

/** Crushes the hair while a hat is shown, and restores it when the hat goes. */
export function updatePedHatHair(root) {
  const hat = root.children.some((group) => group.name === "p_head" && group.visible);
  for (const group of root.children) {
    if (PROP_BONES[group.name] !== undefined || Boolean(group.userData.hatHair) === hat) continue;
    group.userData.hatHair = hat;
    setGroupPose(group, root.userData.pose);
  }
}

// Props contain bone-local vertices. Reapply attachments when any slot loads,
// since the ped's skeleton and its props may finish loading in either order.
export function updatePedPropAttachments(root) {
  const skeleton = root.userData.poseSkeleton || findPedSkeleton(root);
  const pose = root.userData.poseSkeleton ? root.userData.pose : null;
  for (const group of root.children) {
    if (group.userData.heldProp) {
      applyHeldProp(group, skeleton, pose);
      continue;
    }
    if (PROP_BONES[group.name] === undefined) continue;
    group.userData.attached = applyPropAttachment(group, skeleton, pose);
    applySlotVisibility(group);
  }
  updatePedHatHair(root);
  root.updateMatrixWorld(true);
}

export function computeGroupStats(group) {
  const stats = { meshes: 0, vertices: 0, triangles: 0 };
  group?.traverse?.((child) => {
    if (!child.isMesh || !child.geometry) return;
    const position = child.geometry.getAttribute("position");
    const index = child.geometry.getIndex();
    stats.meshes += 1;
    stats.vertices += position?.count || 0;
    stats.triangles += Math.floor((index ? index.count : position?.count || 0) / 3);
  });
  return stats;
}

export function computePedBounds(root) {
  if (!root) return null;
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  // A held prop can reach below the feet or far from the body; the floor and
  // camera follow the ped alone.
  for (const child of root.children) {
    if (!child.userData.heldProp) box.expandByObject(child);
  }
  if (box.isEmpty()) return null;
  const values = [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z];
  if (!values.every((value) => Number.isFinite(value))) return null;
  return box;
}

// Convenience for one-shot assembly: `slots` maps component -> { drawablePath,
// texturePaths }. Failed slots are reported through onSlot and skipped.
export async function assemblePed({ slots = {}, readFile, signal, onSlot } = {}) {
  const root = createPedRoot();
  const entries = Object.entries(slots).filter(([, slot]) => slot?.drawablePath);
  await Promise.all(
    entries.map(async ([component, slot]) => {
      onSlot?.(component, { status: "loading" });
      try {
        const group = await buildSlotGroup({
          component,
          drawablePath: slot.drawablePath,
          texturePaths: slot.texturePaths,
          readFile,
          signal,
        });
        if (signal?.aborted) {
          disposeSlotGroup(group);
          return;
        }
        root.add(group);
        onSlot?.(component, { status: "ready", group });
      } catch (error) {
        if (error?.name === "AbortError") return;
        onSlot?.(component, { status: "error", error });
      }
    }),
  );
  return root;
}
