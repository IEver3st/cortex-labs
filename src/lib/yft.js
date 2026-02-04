/**
 * GTA V YFT (Fragment/Drawable) Parser
 * Based on RAGE engine format specifications from CodeWalker
 */

import { inflate, inflateRaw } from "pako";

const RSC7_MAGIC = 0x37435352;
const RSC85_MAGIC = 0x38355352;
const MAX_MODELS = 64;
const MAX_GEOMETRIES = 256;
const MAX_VERTICES = 1000000;
const MAX_INDICES = 3000000;

// Shader name list adapted from CodeWalker.Core/strings.txt (shader names for gen9).
// Used to map ShaderFX.Name hashes to readable labels.
const GTA_SHADER_NAMES_TEXT = `
albedo_alpha
alpha
billboard_nobump
blend_2lyr
cable
cloth_default
cloth_normal_spec
cloth_normal_spec_alpha
cloth_normal_spec_cutout
cloth_normal_spec_tnt
cloth_spec_alpha
cloth_spec_cutout
clouds_altitude
clouds_anim
clouds_animsoft
clouds_billboard_fast
clouds_billboard_soft
clouds_fast
clouds_fog
clouds_soft
cpv_only
cubemap_reflect
cutout
cutout_fence
cutout_fence_normal
cutout_hard
cutout_spec_tnt
cutout_tnt
cutout_um
decal
decal_amb_only
decal_diff_only_um
decal_dirt
decal_emissive_only
decal_emissivenight_only
decal_glue
decal_normal_blend_2lyr
decal_normal_only
decal_normal_spec_um
decal_shadow_only
decal_spec_only
decal_tnt
default
default_detail
default_noedge
default_spec
default_terrain_wet
default_tnt
default_um
distance_map
emissive
emissive_additive_alpha
emissive_additive_uv_alpha
emissive_alpha
emissive_alpha_tnt
emissive_clip
emissive_speclum
emissive_tnt
emissivenight
emissivenight_alpha
emissivenight_geomnightonly
emissivestrong
emissivestrong_alpha
glass
glass_breakable
glass_breakable_screendooralpha
glass_displacement
glass_emissive
glass_emissive_alpha
glass_emissivenight
glass_emissivenight_alpha
glass_env
glass_normal_spec_reflect
glass_pv
glass_pv_env
glass_reflect
glass_spec
grass
grass_batch
grass_batch_camera_aligned
grass_batch_camera_facing
grass_camera_aligned
grass_camera_facing
grass_fur
grass_fur_lod
grass_fur_mask
grass_fur_tnt
gta_alpha
gta_cubemap_reflect
gta_cutout
gta_cutout_fence
gta_decal
gta_decal_amb_only
gta_decal_dirt
gta_decal_glue
gta_decal_normal_only
gta_default
gta_emissive
gta_emissive_alpha
gta_emissivenight
gta_emissivenight_alpha
gta_emissivestrong
gta_emissivestrong_alpha
gta_glass
gta_glass_emissive
gta_glass_emissive_alpha
gta_glass_emissivenight
gta_glass_emissivenight_alpha
gta_glass_normal_spec_reflect
gta_glass_reflect
gta_glass_spec
gta_hair_sorted_alpha_expensive
gta_leaves
gta_mirror
gta_normal
gta_normal_alpha
gta_normal_cubemap_reflect
gta_normal_cutout
gta_normal_decal
gta_normal_reflect
gta_normal_reflect_alpha
gta_normal_reflect_decal
gta_normal_reflect_screendooralpha
gta_normal_screendooralpha
gta_normal_spec
gta_normal_spec_alpha
gta_normal_spec_cubemap_reflect
gta_normal_spec_decal
gta_normal_spec_decal_nopuddle
gta_normal_spec_reflect
gta_normal_spec_reflect_alpha
gta_normal_spec_reflect_decal
gta_normal_spec_reflect_emissive
gta_normal_spec_reflect_emissive_alpha
gta_normal_spec_reflect_emissivenight
gta_normal_spec_reflect_emissivenight_alpha
gta_normal_spec_screendooralpha
gta_parallax
gta_parallax_specmap
gta_parallax_steep
gta_radar
gta_reflect
gta_reflect_alpha
gta_reflect_decal
gta_rmptfx_mesh
gta_spec
gta_spec_alpha
gta_spec_const
gta_spec_decal
gta_spec_reflect
gta_spec_reflect_alpha
gta_spec_reflect_decal
gta_spec_reflect_screendooralpha
gta_spec_screendooralpha
gta_trees
leaves
minimap
mirror
mirror_crack
mirror_decal
mirror_default
normal
normal_alpha
normal_cubemap_reflect
normal_cutout
normal_cutout_tnt
normal_cutout_um
normal_decal
normal_decal_pxm
normal_decal_pxm_tnt
normal_decal_tnt
normal_decal_tnt_pxm
normal_detail
normal_detail_dpm
normal_detail_dpm_tnt
normal_detail_tnt_dpm
normal_diffspec
normal_diffspec_detail
normal_diffspec_detail_dpm
normal_diffspec_detail_dpm_tnt
normal_diffspec_detail_dpm_wind
normal_diffspec_detail_tnt
normal_diffspec_detail_tnt_dpm
normal_diffspec_dpm
normal_diffspec_tnt
normal_pxm
normal_pxm_tnt
normal_reflect
normal_reflect_alpha
normal_reflect_decal
normal_reflect_screendooralpha
normal_screendooralpha
normal_spec
normal_spec_alpha
normal_spec_batch
normal_spec_cubemap_reflect
normal_spec_cutout
normal_spec_cutout_tnt
normal_spec_decal
normal_spec_decal_detail
normal_spec_decal_nopuddle
normal_spec_decal_pxm
normal_spec_decal_tnt
normal_spec_detail
normal_spec_detail_dpm
normal_spec_detail_dpm_texdecal_tnt
normal_spec_detail_dpm_tnt
normal_spec_detail_dpm_vertdecal_tnt
normal_spec_detail_tnt
normal_spec_detail_tnt_dpm
normal_spec_dpm
normal_spec_emissive
normal_spec_pxm
normal_spec_pxm_tnt
normal_spec_reflect
normal_spec_reflect_alpha
normal_spec_reflect_decal
normal_spec_reflect_emissivenight
normal_spec_reflect_emissivenight_alpha
normal_spec_screendooralpha
normal_spec_tnt
normal_spec_tnt_pxm
normal_spec_twiddle_tnt
normal_spec_um
normal_spec_wrinkle
normal_terrain_wet
normal_terrain_wet_pxm
normal_tnt
normal_tnt_alpha
normal_tnt_pxm
normal_um
normal_um_tnt
normal_wind
parallax
parallax_specmap
parallax_steep
ped
ped_alpha
ped_cloth
ped_cloth_enveff
ped_decal
ped_decal_decoration
ped_decal_exp
ped_decal_expensive
ped_decal_medals
ped_decal_nodiff
ped_default
ped_default_cloth
ped_default_cutout
ped_default_enveff
ped_default_mp
ped_default_palette
ped_emissive
ped_enveff
ped_fur
ped_hair_cutout_alpha
ped_hair_cutout_alpha_cloth
ped_hair_spiked
ped_hair_spiked_enveff
ped_hair_spiked_mask
ped_hair_spiked_noalpha
ped_nopeddamagedecals
ped_palette
ped_wrinkle
ped_wrinkle_cloth
ped_wrinkle_cloth_enveff
ped_wrinkle_cs
ped_wrinkle_enveff
ptfx_model
radar
rage_billboard_nobump
rage_default
reflect
reflect_alpha
reflect_decal
silhouettelayer
sky_system
spec
spec_alpha
spec_const
spec_decal
spec_reflect
spec_reflect_alpha
spec_reflect_decal
spec_reflect_screendooralpha
spec_screendooralpha
spec_tnt
spec_twiddle_tnt
terrain_cb_4lyr
terrain_cb_4lyr_2tex
terrain_cb_4lyr_2tex_blend
terrain_cb_4lyr_2tex_blend_lod
terrain_cb_4lyr_2tex_pxm
terrain_cb_4lyr_cm
terrain_cb_4lyr_cm_tnt
terrain_cb_4lyr_lod
terrain_cb_4lyr_pxm
terrain_cb_4lyr_spec
terrain_cb_w_4lyr
terrain_cb_w_4lyr_2tex
terrain_cb_w_4lyr_2tex_blend
terrain_cb_w_4lyr_2tex_blend_lod
terrain_cb_w_4lyr_2tex_blend_pxm
terrain_cb_w_4lyr_2tex_blend_pxm_spm
terrain_cb_w_4lyr_2tex_blend_pxm_tn_spm
terrain_cb_w_4lyr_2tex_blend_pxm_tt_spm
terrain_cb_w_4lyr_2tex_blend_tt
terrain_cb_w_4lyr_2tex_blend_ttn
terrain_cb_w_4lyr_2tex_pxm
terrain_cb_w_4lyr_cm
terrain_cb_w_4lyr_cm_pxm
terrain_cb_w_4lyr_cm_pxm_tnt
terrain_cb_w_4lyr_cm_tnt
terrain_cb_w_4lyr_cm_tnt_pxm
terrain_cb_w_4lyr_lod
terrain_cb_w_4lyr_pxm
terrain_cb_w_4lyr_pxm_spm
terrain_cb_w_4lyr_spec
terrain_cb_w_4lyr_spec_int
terrain_cb_w_4lyr_spec_int_pxm
terrain_cb_w_4lyr_spec_pxm
trees
trees_camera_aligned
trees_camera_facing
trees_lod
trees_lod_tnt
trees_lod2
trees_lod2d
trees_normal
trees_normal_diffspec
trees_normal_diffspec_tnt
trees_normal_spec
trees_normal_spec_camera_aligned
trees_normal_spec_camera_aligned_tnt
trees_normal_spec_camera_facing
trees_normal_spec_camera_facing_tnt
trees_normal_spec_tnt
trees_normal_spec_wind
trees_shadow_proxy
trees_tnt
vehicle_badges
vehicle_basic
vehicle_blurredrotor
vehicle_blurredrotor_emissive
vehicle_cloth
vehicle_cloth2
vehicle_cutout
vehicle_dash_emissive
vehicle_dash_emissive_opaque
vehicle_decal
vehicle_decal2
vehicle_detail
vehicle_detail2
vehicle_emissive_alpha
vehicle_emissive_opaque
vehicle_generic
vehicle_interior
vehicle_interior2
vehicle_licenseplate
vehicle_lights
vehicle_lightsemissive
vehicle_lightsemissive_siren
vehicle_mesh
vehicle_mesh_enveff
vehicle_mesh2_enveff
vehicle_nosplash
vehicle_nowater
vehicle_paint1
vehicle_paint1_enveff
vehicle_paint2
vehicle_paint2_enveff
vehicle_paint3
vehicle_paint3_enveff
vehicle_paint3_lvr
vehicle_paint4
vehicle_paint4_emissive
vehicle_paint4_enveff
vehicle_paint5_enveff
vehicle_paint6
vehicle_paint6_enveff
vehicle_paint7
vehicle_paint7_enveff
vehicle_paint8
vehicle_paint9
vehicle_shuts
vehicle_tire
vehicle_tire_emissive
vehicle_track
vehicle_track_ammo
vehicle_track_cutout
vehicle_track_emissive
vehicle_track_siren
vehicle_track2
vehicle_track2_emissive
vehicle_vehglass
vehicle_vehglass_inner
water_decal
water_foam
water_fountain
water_mesh
water_poolenv
water_river
water_riverfoam
water_riverlod
water_riverocean
water_rivershallow
water_shallow
water_terrainfoam
weapon_emissive_tnt
weapon_emissivestrong_alpha
weapon_normal_spec_alpha
weapon_normal_spec_cutout_palette
weapon_normal_spec_detail_palette
weapon_normal_spec_detail_tnt
weapon_normal_spec_palette
weapon_normal_spec_tnt
`;

function joaat(input) {
  if (!input) return 0;
  const str = input.toString().toLowerCase();
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash += str.charCodeAt(i);
    hash = (hash + (hash << 10)) >>> 0;
    hash ^= hash >>> 6;
  }
  hash = (hash + (hash << 3)) >>> 0;
  hash ^= hash >>> 11;
  hash = (hash + (hash << 15)) >>> 0;
  return hash >>> 0;
}

const SHADER_NAME_BY_HASH = (() => {
  const map = new Map();
  GTA_SHADER_NAMES_TEXT.split(/\r?\n/).forEach((line) => {
    const name = line.trim();
    if (!name || name.startsWith("//")) return;
    map.set(joaat(name), name);
  });
  return map;
})();

export function parseYft(bytes, name = "model") {
  if (!bytes || bytes.length < 16) {
    console.warn("[YFT] File too small");
    return null;
  }

  try {
    const resource = decodeResource(bytes);
    if (!resource || !resource.data || resource.data.length < 64) {
      console.warn("[YFT] Failed to decode resource");
      return null;
    }

    console.log(
      `[YFT] Decoded resource: ${resource.data.length} bytes, system=${resource.systemSize}, graphics=${resource.graphicsSize}`,
    );

    const reader = createReader(
      resource.data,
      resource.systemSize,
      resource.graphicsSize,
    );

    let drawable = parseFragType(reader, name);

    if (!drawable || !hasGeometry(drawable)) {
      drawable = parseDrawable(reader, 0, name);
    }

    if (!drawable || !hasGeometry(drawable)) {
      drawable = parseYdrDrawable(reader, name);
    }

    if (!drawable || !hasGeometry(drawable)) {
      const offset = scanForDrawable(reader);
      if (offset > 0) {
        drawable = parseDrawable(reader, offset, name);
      }
    }

    if (!drawable || !hasGeometry(drawable)) {
      console.warn("[YFT] No valid geometry found");
      return null;
    }

    const totalVerts = countTotalVertices(drawable);
    console.log(
      `[YFT] Successfully parsed: ${drawable.models?.length} models, ${totalVerts} total vertices`,
    );
    return drawable;
  } catch (error) {
    console.error("[YFT] Parse error:", error);
    return null;
  }
}

function countTotalVertices(drawable) {
  let total = 0;
  for (const model of drawable.models || []) {
    for (const mesh of model.meshes || []) {
      if (mesh.positions) total += mesh.positions.length / 3;
    }
  }
  return total;
}

function decodeResource(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);

  if (magic !== RSC7_MAGIC && magic !== RSC85_MAGIC) {
    return { data: bytes, systemSize: bytes.length, graphicsSize: 0 };
  }

  const version = view.getUint32(4, true);
  const systemFlags = view.getUint32(8, true);
  const graphicsFlags = view.getUint32(12, true);

  const systemSize = calcSegmentSize(systemFlags);
  const graphicsSize = calcSegmentSize(graphicsFlags);

  const compressed = bytes.subarray(16);
  let decompressed = null;

  try {
    decompressed = inflateRaw(compressed);
  } catch {
    decompressed = null;
  }

  if (!decompressed || decompressed.length === 0) {
    try {
      decompressed = inflate(compressed);
    } catch {
      decompressed = null;
    }
  }

  if (!decompressed || decompressed.length === 0) {
    return { data: compressed, systemSize: compressed.length, graphicsSize: 0 };
  }

  return {
    data: decompressed,
    systemSize: Math.min(systemSize, decompressed.length),
    graphicsSize,
    version,
  };
}

function calcSegmentSize(flags) {
  if (!flags) return 0;
  const baseShift = (flags >> 0) & 0xf;
  const count = (flags >> 8) & 0xff;
  if (baseShift > 30 || count === 0) return 0;
  const pageSize = 1 << (baseShift + 12);
  return count * pageSize;
}

function createReader(bytes, systemSize, graphicsSize) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.length;

  return {
    bytes,
    view,
    len,
    systemSize: systemSize || len,
    graphicsSize: graphicsSize || 0,
    u8: (offset) => (offset >= 0 && offset < len ? view.getUint8(offset) : 0),
    u16: (offset) =>
      offset >= 0 && offset + 2 <= len ? view.getUint16(offset, true) : 0,
    u32: (offset) =>
      offset >= 0 && offset + 4 <= len ? view.getUint32(offset, true) : 0,
    f32: (offset) =>
      offset >= 0 && offset + 4 <= len ? view.getFloat32(offset, true) : 0,
    u64: (offset) => {
      if (offset < 0 || offset + 8 > len) return 0n;
      const lo = BigInt(view.getUint32(offset, true) >>> 0);
      const hi = BigInt(view.getUint32(offset + 4, true) >>> 0);
      return (hi << 32n) | lo;
    },
    valid: (offset) => offset >= 0 && offset < len,
    resolvePtr: function (ptr) {
      return resolvePointer(this, ptr);
    },
    validPtr: function (ptr) {
      if (!ptr || ptr === 0n) return false;
      const offset = this.resolvePtr(ptr);
      return offset > 0 && offset < len;
    },
  };
}

function resolvePointer(reader, ptr) {
  if (!ptr || ptr === 0n) return 0;
  const p = typeof ptr === "bigint" ? ptr : BigInt(ptr);
  const segment = (p >> 28n) & 0xfn;

  if (segment === 5n) {
    return Number(p & 0x0fffffffn);
  } else if (segment === 6n) {
    const graphicsOffset = Number(p & 0x0fffffffn);
    const absoluteOffset = reader.systemSize + graphicsOffset;
    if (absoluteOffset < reader.len) return absoluteOffset;
    if (graphicsOffset < reader.len) return graphicsOffset;
    return 0;
  }

  const offset = Number(p);
  return offset >= 0 && offset < reader.len ? offset : 0;
}

function parseFragType(reader, name) {
  const drawablePtrOffsets = [0x28, 0x20, 0x30, 0x18, 0x38, 0x10, 0x08];

  for (const ptrOffset of drawablePtrOffsets) {
    const drawablePtr = reader.u64(ptrOffset);
    if (reader.validPtr(drawablePtr)) {
      const drawableOffset = reader.resolvePtr(drawablePtr);
      const drawable = parseDrawable(reader, drawableOffset, name);
      if (drawable && hasGeometry(drawable)) {
        console.log(
          `[YFT] Found drawable via FragType offset 0x${ptrOffset.toString(16)}`,
        );
        return drawable;
      }
    }
  }

  return parseDrawable(reader, 0, name);
}

function parseYdrDrawable(reader, name) {
  const ptrOffsets = [0x10, 0x08, 0x18, 0x20, 0x00];
  for (const ptrOffset of ptrOffsets) {
    const ptr = reader.u64(ptrOffset);
    if (!reader.validPtr(ptr)) continue;
    const offset = reader.resolvePtr(ptr);
    const drawable = parseDrawable(reader, offset, name);
    if (drawable && hasGeometry(drawable)) return drawable;
  }
  return null;
}

function parseDrawable(reader, offset, name) {
  if (!reader.valid(offset) || offset + 168 > reader.len) return null;

  const drawable = { name, models: [], shaders: [] };
  const baseOffset = offset;

  const shaderPtrOffsets = [0x10, 0x08, 0x00, 0x18];
  for (const ptrOffset of shaderPtrOffsets) {
    const shaderGroupPtr = reader.u64(baseOffset + ptrOffset);
    if (reader.validPtr(shaderGroupPtr)) {
      const shaderGroupOffset = reader.resolvePtr(shaderGroupPtr);
      const shaders = parseShaderGroup(reader, shaderGroupOffset);
      if (shaders.length > 0) {
        drawable.shaders = shaders;
        break;
      }
    }
  }

  const lodOffsets = [
    { offset: 0x50, name: "high" },
    { offset: 0x58, name: "med" },
    { offset: 0x60, name: "low" },
    { offset: 0x68, name: "vlow" },
  ];

  for (const lod of lodOffsets) {
    const modelsPtr = reader.u64(baseOffset + lod.offset);
    if (!reader.validPtr(modelsPtr)) continue;
    const modelsOffset = reader.resolvePtr(modelsPtr);
    const models = parseModelsPointerArray(
      reader,
      modelsOffset,
      name,
      lod.name,
      drawable.shaders,
    );
    if (models.length > 0) {
      drawable.models = models;
      break;
    }
  }

  if (drawable.models.length === 0) {
    const altOffsets = [0x48, 0x40, 0x38, 0x80, 0x88, 0x90, 0x98];
    for (const altOffset of altOffsets) {
      const modelsPtr = reader.u64(baseOffset + altOffset);
      if (!reader.validPtr(modelsPtr)) continue;
      const modelsOffset = reader.resolvePtr(modelsPtr);
      const models = parseModelsPointerArray(
        reader,
        modelsOffset,
        name,
        "high",
        drawable.shaders,
      );
      if (models.length > 0) {
        drawable.models = models;
        break;
      }
    }
  }

  return drawable;
}

function parseShaderGroup(reader, offset) {
  // CodeWalker ShaderGroup.BlockLength = 64
  if (!reader.valid(offset) || offset + 64 > reader.len) return [];
  const shaders = [];
  const shadersPtr = reader.u64(offset + 0x10);
  let count = reader.u16(offset + 0x18);
  if (count === 0) count = reader.u16(offset + 0x1a);
  if (count === 0 || count > 256 || !reader.validPtr(shadersPtr)) return [];

  const shadersArrayOffset = reader.resolvePtr(shadersPtr);
  for (let i = 0; i < count; i++) {
    const shaderPtr = reader.u64(shadersArrayOffset + i * 8);
    if (!reader.validPtr(shaderPtr)) continue;
    const shaderOffset = reader.resolvePtr(shaderPtr);
    const shader = parseShader(reader, shaderOffset, i);
    if (shader) shaders.push(shader);
  }
  return shaders;
}

function parseShader(reader, offset, index) {
  // CodeWalker ShaderFX.BlockLength = 48
  // ShaderFX.Name (MetaHash) lives at offset 0x08.
  if (!reader.valid(offset) || offset + 48 > reader.len) return null;
  const nameHash = reader.u32(offset + 0x08) >>> 0;
  const hashHex = nameHash.toString(16).padStart(8, "0");
  return {
    index,
    nameHash,
    name: identifyMaterialName(nameHash, hashHex),
    hashHex,
  };
}

function identifyMaterialName(hash, hashHex) {
  const normalized = hash >>> 0;
  const decoded = SHADER_NAME_BY_HASH.get(normalized);
  if (decoded) return decoded;
  if (normalized === 0) return "default";
  if (normalized < 256) return `material_${normalized}`;
  return `material_${hashHex}`;
}

function parseModelsPointerArray(reader, offset, baseName, lodName, shaders) {
  if (!reader.valid(offset) || offset + 16 > reader.len) return [];
  const models = [];
  const arrayPtr = reader.u64(offset);
  let count = reader.u16(offset + 8);

  if (count === 0 || count > MAX_MODELS) {
    const directModel = parseDrawableModel(
      reader,
      offset,
      `${baseName}_${lodName}_0`,
      shaders,
    );
    if (directModel && directModel.meshes.length > 0) return [directModel];
    return [];
  }

  if (!reader.validPtr(arrayPtr)) return [];
  const arrayOffset = reader.resolvePtr(arrayPtr);

  for (let i = 0; i < count; i++) {
    const modelPtr = reader.u64(arrayOffset + i * 8);
    if (!reader.validPtr(modelPtr)) continue;
    const modelOffset = reader.resolvePtr(modelPtr);
    const model = parseDrawableModel(
      reader,
      modelOffset,
      `${baseName}_${lodName}_${i}`,
      shaders,
    );
    if (model && model.meshes.length > 0) models.push(model);
  }
  return models;
}

function parseDrawableModel(reader, offset, name, shaders) {
  if (!reader.valid(offset) || offset + 48 > reader.len) return null;

  const model = { name, meshes: [] };
  const geometriesPtr = reader.u64(offset + 0x08);
  let geometriesCount = reader.u16(offset + 0x10);
  const shaderMappingPtr = reader.u64(offset + 0x20);

  if (geometriesCount === 0 || geometriesCount > MAX_GEOMETRIES)
    geometriesCount = 1;
  if (!reader.validPtr(geometriesPtr)) return null;

  const geometriesArrayOffset = reader.resolvePtr(geometriesPtr);
  const shaderMapping = [];
  if (reader.validPtr(shaderMappingPtr)) {
    const mappingOffset = reader.resolvePtr(shaderMappingPtr);
    for (let i = 0; i < geometriesCount; i++) {
      shaderMapping.push(reader.u16(mappingOffset + i * 2));
    }
  }

  for (let i = 0; i < geometriesCount; i++) {
    const geomPtr = reader.u64(geometriesArrayOffset + i * 8);
    if (!reader.validPtr(geomPtr)) continue;
    const geomOffset = reader.resolvePtr(geomPtr);
    const mesh = parseGeometry(reader, geomOffset, `${name}_geom${i}`);
    if (mesh && mesh.positions && mesh.positions.length > 0) {
      const shaderIndex = shaderMapping[i] ?? i;
      const shader = shaders[shaderIndex];
      mesh.materialName = shader?.name || `material_${shaderIndex}`;
      model.meshes.push(mesh);
    }
  }
  return model;
}

function parseGeometry(reader, offset, name) {
  if (!reader.valid(offset) || offset + 152 > reader.len) return null;

  const vertexBufferPtr = reader.u64(offset + 0x18);
  const indexBufferPtr = reader.u64(offset + 0x38);
  const verticesCount = reader.u16(offset + 0x60);
  const vertexStride = reader.u16(offset + 0x70);
  const vertexDataPtr = reader.u64(offset + 0x78);

  // Parse vertex declaration to get proper attribute offsets
  const vertexDecl = parseVertexDeclaration(reader, offset);

  let vertexData = null;
  if (reader.validPtr(vertexBufferPtr)) {
    const vbOffset = reader.resolvePtr(vertexBufferPtr);
    vertexData = parseVertexBuffer(reader, vbOffset, vertexDecl);
  }

  if (
    !vertexData &&
    reader.validPtr(vertexDataPtr) &&
    vertexStride > 0 &&
    verticesCount > 0
  ) {
    const dataOffset = reader.resolvePtr(vertexDataPtr);
    vertexData = parseVertexData(
      reader,
      dataOffset,
      vertexStride,
      verticesCount,
      vertexDecl,
    );
  }

  if (!vertexData || !vertexData.positions || vertexData.positions.length === 0)
    return null;

  let indices = null;
  if (reader.validPtr(indexBufferPtr)) {
    const ibOffset = reader.resolvePtr(indexBufferPtr);
    indices = parseIndexBuffer(reader, ibOffset);
  }

  if (!indices || indices.length === 0) {
    indices = generateSequentialIndices(vertexData.positions.length / 3);
  }

  return {
    name,
    materialName: "",
    positions: vertexData.positions,
    normals: vertexData.normals,
    uvs: vertexData.uvs,
    uvs2: vertexData.uvs2,
    uvs3: vertexData.uvs3,
    uvs4: vertexData.uvs4,
    colors: vertexData.colors,
    tangents: vertexData.tangents,
    indices,
  };
}

// Parse the vertex declaration from geometry to get proper attribute offsets
function parseVertexDeclaration(reader, geomOffset) {
  const stride = reader.u16(geomOffset + 0x70);
  const fallback = detectVertexFormat(stride);

  const vertexBufferPtr = reader.u64(geomOffset + 0x18);
  if (!reader.validPtr(vertexBufferPtr)) return fallback;

  const vbOffset = reader.resolvePtr(vertexBufferPtr);
  let infoPtr = reader.u64(vbOffset + 0x30);
  if (!reader.validPtr(infoPtr)) {
    infoPtr = reader.u64(vbOffset + 0x38);
  }
  const decl = parseLegacyVertexDeclaration(reader, infoPtr, stride);

  if (!decl) return fallback;

  console.log(
    `[YFT] Vertex format: stride=${decl.stride ?? stride}, normalOffset=${decl.normalOffset}, colorOffset=${decl.colorOffset}, uv0Offset=${decl.uv0Offset}, uv1Offset=${decl.uv1Offset}`,
  );

  return decl;
}

function parseLegacyVertexDeclaration(reader, infoPtr, fallbackStride) {
  if (!reader.validPtr(infoPtr)) return null;
  const infoOffset = reader.resolvePtr(infoPtr);
  if (!reader.valid(infoOffset) || infoOffset + 16 > reader.len) return null;

  const flags = reader.u32(infoOffset);
  const stride = reader.u16(infoOffset + 0x04);
  const count = reader.u8(infoOffset + 0x07);
  const types = reader.u64(infoOffset + 0x08);

  if (!flags || count === 0) return null;

  const decl = buildVertexDeclFromFlags(flags, types);
  if (!decl) return null;
  decl.stride = stride || fallbackStride || 0;
  return decl;
}

function buildVertexDeclFromFlags(flags, types) {
  const decl = {
    positionOffset: -1,
    normalOffset: -1,
    colorOffset: -1,
    uv0Offset: -1,
    uv1Offset: -1,
    uv2Offset: -1,
    uv3Offset: -1,
    uv4Offset: -1,
    texcoordOffsets: Array(8).fill(-1),
    texcoordTypes: Array(8).fill(null),
    tangentOffset: -1,
    positionType: null,
    normalType: null,
    colorType: null,
    uv0Type: null,
    uv1Type: null,
    uv2Type: null,
    uv3Type: null,
    uv4Type: null,
    tangentType: null,
  };

  let offset = 0;
  for (let i = 0; i < 16; i++) {
    if (((flags >>> i) & 1) === 0) continue;
    const type = getVertexComponentType(types, i);

    if (i === 0) {
      decl.positionOffset = offset;
      decl.positionType = type;
    } else if (i === 3) {
      decl.normalOffset = offset;
      decl.normalType = type;
    } else if (i === 4) {
      decl.colorOffset = offset;
      decl.colorType = type;
    } else if (i >= 6 && i <= 13) {
      const texIndex = i - 6;
      decl.texcoordOffsets[texIndex] = offset;
      decl.texcoordTypes[texIndex] = type;
      if (texIndex === 0) {
        decl.uv0Offset = offset;
        decl.uv0Type = type;
      } else if (texIndex === 1) {
        decl.uv1Offset = offset;
        decl.uv1Type = type;
      } else if (texIndex === 2) {
        decl.uv2Offset = offset;
        decl.uv2Type = type;
      } else if (texIndex === 3) {
        decl.uv3Offset = offset;
        decl.uv3Type = type;
      } else if (texIndex === 4) {
        decl.uv4Offset = offset;
        decl.uv4Type = type;
      }
    } else if (i === 14) {
      decl.tangentOffset = offset;
      decl.tangentType = type;
    }

    offset += getVertexComponentSize(type);
  }

  if (offset === 0) return null;

  return decl;
}

function getVertexComponentType(types, index) {
  if (types === null || types === undefined) return 0;
  const shift = BigInt(index * 4);
  return Number((types >> shift) & 0xfn);
}

function getVertexComponentSize(type) {
  switch (type) {
    case 1: // Half2
    case 2: // Float
    case 8: // UByte4
    case 9: // Colour
    case 10: // RGBA8SNorm
      return 4;
    case 3: // Half4
    case 5: // Float2
      return 8;
    case 6: // Float3
      return 12;
    case 7: // Float4
      return 16;
    default:
      return 0;
  }
}

function parseVertexBuffer(reader, offset, vertexDecl = null) {
  if (!reader.valid(offset) || offset + 64 > reader.len) return null;

  let stride = 0;
  let count = 0;
  let dataPtr = 0n;

  const legacyStride = reader.u16(offset + 0x08);
  const legacyCount = reader.u32(offset + 0x18);
  const legacyDataPtr = reader.u64(offset + 0x10);
  const legacyDataPtr2 = reader.u64(offset + 0x20);

  if (
    legacyStride > 0 &&
    legacyStride <= 256 &&
    legacyCount > 0 &&
    legacyCount <= MAX_VERTICES
  ) {
    stride = legacyStride;
    count = legacyCount;
    dataPtr = reader.validPtr(legacyDataPtr) ? legacyDataPtr : legacyDataPtr2;
  }

  if (
    (stride === 0 || count === 0 || !reader.validPtr(dataPtr)) &&
    offset + 64 <= reader.len
  ) {
    const gen9Count = reader.u32(offset + 0x08);
    const gen9Stride = reader.u16(offset + 0x0c);
    const gen9DataPtr = reader.u64(offset + 0x18);
    if (
      gen9Stride > 0 &&
      gen9Stride <= 256 &&
      gen9Count > 0 &&
      gen9Count <= MAX_VERTICES &&
      reader.validPtr(gen9DataPtr)
    ) {
      stride = gen9Stride;
      count = gen9Count;
      dataPtr = gen9DataPtr;
    }
  }

  if (stride === 0 || count === 0 || !reader.validPtr(dataPtr)) return null;
  const dataOffset = reader.resolvePtr(dataPtr);
  return parseVertexData(reader, dataOffset, stride, count, vertexDecl);
}

function parseVertexData(reader, offset, stride, count, vertexDecl = null) {
  if (!reader.valid(offset) || stride < 8 || count === 0) return null;

  const safeCount = Math.min(count, MAX_VERTICES);
  if (offset + safeCount * stride > reader.len) return null;

  const positions = new Float32Array(safeCount * 3);
  const normals = new Float32Array(safeCount * 3);
  const uvSets = [
    new Float32Array(safeCount * 2),
    new Float32Array(safeCount * 2),
    new Float32Array(safeCount * 2),
    new Float32Array(safeCount * 2),
  ];
  const colors = new Float32Array(safeCount * 4);
  const hasUVs = [false, false, false, false];
  let hasNormals = false,
    hasColors = false;

  // Use vertex declaration if available, otherwise fall back to stride-based detection
  const format = vertexDecl || detectVertexFormat(stride);

  for (let i = 0; i < safeCount; i++) {
    const vOffset = offset + i * stride;

    // Position (always at offset 0, float3)
    const posOffset = format.positionOffset ?? 0;
    let px = reader.f32(vOffset + posOffset);
    let py = reader.f32(vOffset + posOffset + 4);
    let pz = reader.f32(vOffset + posOffset + 8);

    if (
      Math.abs(px) > 50000 ||
      Math.abs(py) > 50000 ||
      Math.abs(pz) > 50000 ||
      !isFinite(px)
    ) {
      px = halfToFloat(reader.u16(vOffset + posOffset));
      py = halfToFloat(reader.u16(vOffset + posOffset + 2));
      pz = halfToFloat(reader.u16(vOffset + posOffset + 4));
    }

    positions[i * 3] = px;
    positions[i * 3 + 1] = py;
    positions[i * 3 + 2] = pz;

    // Normal
    const normalOffset = format.normalOffset;
    const normalType = format.normalType;
    const normalSize = getVertexComponentSize(normalType) || 4;
    if (normalOffset >= 0 && normalOffset + normalSize <= stride) {
      const normal = readNormal(reader, vOffset + normalOffset, normalType);
      if (normal) {
        const [nx, ny, nz] = normal;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len > 0.01 && len < 100) {
          normals[i * 3] = nx / len;
          normals[i * 3 + 1] = ny / len;
          normals[i * 3 + 2] = nz / len;
          hasNormals = true;
        }
      }
    }

    // Color
    const colorOffset = format.colorOffset;
    const colorSize = getVertexComponentSize(format.colorType) || 4;
    if (colorOffset >= 0 && colorOffset + colorSize <= stride) {
      const color = readColor(reader, vOffset + colorOffset, format.colorType);
      if (color) {
        colors[i * 4] = color[0];
        colors[i * 4 + 1] = color[1];
        colors[i * 4 + 2] = color[2];
        colors[i * 4 + 3] = color[3];
        hasColors = true;
      }
    }

    // UV0
    const texOffsets = format.texcoordOffsets || [];
    const texTypes = format.texcoordTypes || [];
    for (let t = 0; t < 4; t += 1) {
      const offsetT = texOffsets[t] ?? -1;
      const typeT = texTypes[t] ?? 1;
      if (offsetT < 0) continue;
      const sizeT = getVertexComponentSize(typeT) || 4;
      if (offsetT + sizeT > stride) continue;
      const uv = readTexcoord(reader, vOffset + offsetT, typeT);
      if (
        uv &&
        isFinite(uv[0]) &&
        isFinite(uv[1]) &&
        Math.abs(uv[0]) < 1000 &&
        Math.abs(uv[1]) < 1000
      ) {
        uvSets[t][i * 2] = uv[0];
        uvSets[t][i * 2 + 1] = uv[1];
        hasUVs[t] = true;
      }
    }
  }

  return {
    positions,
    normals: hasNormals ? normals : null,
    uvs: hasUVs[0] ? uvSets[0] : null,
    uvs2: hasUVs[1] ? uvSets[1] : null,
    uvs3: hasUVs[2] ? uvSets[2] : null,
    uvs4: hasUVs[3] ? uvSets[3] : null,
    colors: hasColors ? colors : null,
    tangents: null,
  };
}

function readTexcoord(reader, offset, type) {
  // GTA V uses DirectX texture coordinates (V=0 at top)
  // WebGL/Three.js uses OpenGL coordinates (V=0 at bottom)
  // We need to flip the V coordinate: v = 1 - v
  const resolvedType = type ?? 1;
  let u, v;
  switch (resolvedType) {
    case 5: // Float2
      u = reader.f32(offset);
      v = reader.f32(offset + 4);
      break;
    case 3: // Half4
      u = halfToFloat(reader.u16(offset));
      v = halfToFloat(reader.u16(offset + 2));
      break;
    case 7: // Float4
      u = reader.f32(offset);
      v = reader.f32(offset + 4);
      break;
    case 1: // Half2
    default:
      u = halfToFloat(reader.u16(offset));
      v = halfToFloat(reader.u16(offset + 2));
      break;
  }
  // Flip V coordinate from DirectX to OpenGL format
  return [u, 1.0 - v];
}

function readNormal(reader, offset, type) {
  switch (type) {
    case 6: // Float3
      return [
        reader.f32(offset),
        reader.f32(offset + 4),
        reader.f32(offset + 8),
      ];
    case 7: // Float4
      return [
        reader.f32(offset),
        reader.f32(offset + 4),
        reader.f32(offset + 8),
      ];
    case 10: {
      // RGBA8SNorm
      const x = toSnorm8(reader.u8(offset));
      const y = toSnorm8(reader.u8(offset + 1));
      const z = toSnorm8(reader.u8(offset + 2));
      return [x, y, z];
    }
    default:
      return decodeDec3n(reader.u32(offset));
  }
}

function readColor(reader, offset, type) {
  const r = reader.u8(offset);
  const g = reader.u8(offset + 1);
  const b = reader.u8(offset + 2);
  const a = reader.u8(offset + 3);
  if (type === 10) {
    return [
      toUnormFromSnorm8(r),
      toUnormFromSnorm8(g),
      toUnormFromSnorm8(b),
      toUnormFromSnorm8(a),
    ];
  }
  return [r / 255.0, g / 255.0, b / 255.0, a / 255.0];
}

function decodeDec3n(packed) {
  const nx = (packed & 0x3ff) / 511.5 - 1.0;
  const ny = ((packed >> 10) & 0x3ff) / 511.5 - 1.0;
  const nz = ((packed >> 20) & 0x3ff) / 511.5 - 1.0;
  return [nx, ny, nz];
}

function toSnorm8(value) {
  const signed = value > 127 ? value - 256 : value;
  return Math.max(-1, Math.min(1, signed / 127));
}

function toUnormFromSnorm8(value) {
  return (toSnorm8(value) + 1) * 0.5;
}

function detectVertexFormat(stride) {
  // Common GTA V vertex layouts based on stride:
  // 20: pos(12) + normal(4) + uv(4)
  // 24: pos(12) + normal(4) + color(4) + uv(4)
  // 28: pos(12) + normal(4) + color(4) + uv(4) + uv2(4)
  // 32: pos(12) + blendw(4) + blendi(4) + normal(4) + uv(4) or pos(12) + normal(4) + color(4) + uv(4) + tangent(4) + ???
  // 36: pos(12) + blendw(4) + blendi(4) + normal(4) + color(4) + uv(4)
  // 40: pos(12) + blendw(4) + blendi(4) + normal(4) + color(4) + uv(4) + tangent(4)
  // 44: pos(12) + blendw(4) + blendi(4) + normal(4) + color(4) + uv(4) + uv2(4) + tangent(4)

  const format = {
    positionOffset: 0,
    normalOffset: -1,
    colorOffset: -1,
    uv0Offset: -1,
    uv1Offset: -1,
    uv2Offset: -1,
    uv3Offset: -1,
    uv4Offset: -1,
    texcoordOffsets: Array(8).fill(-1),
    texcoordTypes: Array(8).fill(null),
    positionType: 6,
    normalType: null,
    colorType: 9,
    uv0Type: 1,
    uv1Type: 1,
    uv2Type: 1,
    uv3Type: 1,
    uv4Type: 1,
    tangentType: null,
  };

  switch (stride) {
    case 20:
      // pos(12) + normal(4) + uv(4)
      format.normalOffset = 12;
      format.uv0Offset = 16;
      format.texcoordOffsets[0] = 16;
      format.texcoordTypes[0] = format.uv0Type;
      break;
    case 24:
      // pos(12) + normal(4) + color(4) + uv(4)
      format.normalOffset = 12;
      format.colorOffset = 16;
      format.uv0Offset = 20;
      format.texcoordOffsets[0] = 20;
      format.texcoordTypes[0] = format.uv0Type;
      break;
    case 28:
      // pos(12) + normal(4) + color(4) + uv(4) + uv2(4)
      format.normalOffset = 12;
      format.colorOffset = 16;
      format.uv0Offset = 20;
      format.uv1Offset = 24;
      format.texcoordOffsets[0] = 20;
      format.texcoordTypes[0] = format.uv0Type;
      format.texcoordOffsets[1] = 24;
      format.texcoordTypes[1] = format.uv1Type;
      break;
    case 32:
      // pos(12) + blendw(4) + blendi(4) + normal(4) + uv(4)
      format.normalOffset = 20;
      format.uv0Offset = 24;
      format.texcoordOffsets[0] = 24;
      format.texcoordTypes[0] = format.uv0Type;
      break;
    case 36:
      // pos(12) + blendw(4) + blendi(4) + normal(4) + color(4) + uv(4)
      format.normalOffset = 20;
      format.colorOffset = 24;
      format.uv0Offset = 28;
      format.texcoordOffsets[0] = 28;
      format.texcoordTypes[0] = format.uv0Type;
      break;
    case 40:
      // pos(12) + blendw(4) + blendi(4) + normal(4) + color(4) + uv(4) + tangent(4)
      format.normalOffset = 20;
      format.colorOffset = 24;
      format.uv0Offset = 28;
      format.texcoordOffsets[0] = 28;
      format.texcoordTypes[0] = format.uv0Type;
      break;
    case 44:
      // pos(12) + blendw(4) + blendi(4) + normal(4) + color(4) + uv(4) + uv2(4) + tangent(4)
      format.normalOffset = 20;
      format.colorOffset = 24;
      format.uv0Offset = 28;
      format.uv1Offset = 32;
      format.texcoordOffsets[0] = 28;
      format.texcoordTypes[0] = format.uv0Type;
      format.texcoordOffsets[1] = 32;
      format.texcoordTypes[1] = format.uv1Type;
      break;
    default:
      // Generic fallback: assume pos(12) + normal(4) + maybe color(4) + uv(4)
      if (stride >= 16) format.normalOffset = 12;
      if (stride >= 20) format.uv0Offset = 16;
      if (stride >= 24) {
        format.colorOffset = 16;
        format.uv0Offset = 20;
      }
      if (format.uv0Offset >= 0) {
        format.texcoordOffsets[0] = format.uv0Offset;
        format.texcoordTypes[0] = format.uv0Type;
      }
      break;
  }

  return format;
}

function parseIndexBuffer(reader, offset) {
  if (!reader.valid(offset) || offset + 32 > reader.len) return null;

  let count = reader.u32(offset + 0x08);
  let dataPtr = reader.u64(offset + 0x10);

  if (count === 0 || count > MAX_INDICES || !reader.validPtr(dataPtr)) {
    count = reader.u32(offset + 0x08);
    dataPtr = reader.u64(offset + 0x18);
  }

  if (count === 0 || count > MAX_INDICES || !reader.validPtr(dataPtr))
    return null;

  const dataOffset = reader.resolvePtr(dataPtr);
  const safeCount = Math.min(count, MAX_INDICES);
  const indices = new Uint32Array(safeCount);

  for (let i = 0; i < safeCount; i++) {
    indices[i] = reader.u16(dataOffset + i * 2);
  }
  return indices;
}

function halfToFloat(h) {
  const sign = (h >> 15) & 0x1;
  let exp = (h >> 10) & 0x1f;
  let mant = h & 0x3ff;
  if (exp === 0) {
    if (mant === 0) return sign ? -0.0 : 0.0;
    while (!(mant & 0x400)) {
      mant <<= 1;
      exp -= 1;
    }
    exp += 1;
    mant &= 0x3ff;
  } else if (exp === 31) {
    return mant === 0 ? (sign ? -Infinity : Infinity) : NaN;
  }
  const bits = ((sign << 31) | ((exp + 127 - 15) << 23) | (mant << 13)) >>> 0;
  const buffer = new ArrayBuffer(4);
  new DataView(buffer).setUint32(0, bits, true);
  return new DataView(buffer).getFloat32(0, true);
}

function generateSequentialIndices(vertexCount) {
  const triCount = Math.floor(vertexCount / 3);
  const indices = new Uint32Array(triCount * 3);
  for (let i = 0; i < triCount * 3; i++) indices[i] = i;
  return indices;
}

function hasGeometry(drawable) {
  if (!drawable || !drawable.models || drawable.models.length === 0)
    return false;
  let totalVertices = 0;
  for (const model of drawable.models) {
    for (const mesh of model.meshes || []) {
      if (mesh.positions) totalVertices += mesh.positions.length / 3;
    }
  }
  return totalVertices > 0;
}

function scanForDrawable(reader) {
  const limit = Math.min(reader.len - 200, 0x10000);
  for (let offset = 0; offset <= limit; offset += 16) {
    const shaderPtr = reader.u64(offset + 0x10);
    if (!reader.validPtr(shaderPtr)) continue;
    const modelsHigh = reader.u64(offset + 0x50);
    const modelsMed = reader.u64(offset + 0x58);
    const modelsLow = reader.u64(offset + 0x60);
    if (
      reader.validPtr(modelsHigh) ||
      reader.validPtr(modelsMed) ||
      reader.validPtr(modelsLow)
    ) {
      return offset;
    }
  }
  return 0;
}
