import * as THREE from "three";
import { DDSLoader } from "three/examples/jsm/loaders/DDSLoader.js";
import { decodeDDSLevels, parseDDSHeader } from "./dds-decode.js";

const DDS_MAGIC = 0x20534444;
const DDSD_MIPMAPCOUNT = 0x20000;
const DDSCAPS2_CUBEMAP = 0x200;
const D3D10_RESOURCE_DIMENSION_TEXTURE2D = 3;
const DXGI_FORMAT_BC7_UNORM = 98;
const DXGI_FORMAT_BC7_UNORM_SRGB = 99;

function byteView(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

export function inspectDdsCompression(value) {
  const bytes = byteView(value);
  if (!bytes || bytes.byteLength < 128) return { fourCc: "", dxgiFormat: null };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== DDS_MAGIC) return { fourCc: "", dxgiFormat: null };
  const fourCc = String.fromCharCode(bytes[84], bytes[85], bytes[86], bytes[87]);
  const dxgiFormat = fourCc === "DX10" && bytes.byteLength >= 148
    ? view.getUint32(128, true)
    : null;
  return { fourCc, dxgiFormat };
}

/* True when every texel of a small DDS has zero alpha. Authors use such a
   texture to make a surface draw nothing while it still occludes; larger
   textures are never treated that way, so they are not decoded here. */
export const TRANSPARENT_PROBE_MAX_PIXELS = 64 * 64;

export function isFullyTransparentDds(value) {
  const bytes = byteView(value);
  if (!bytes) return false;
  const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer;
  const header = parseDDSHeader(buffer);
  if (!header?.width || !header?.height || header.width * header.height > TRANSPARENT_PROBE_MAX_PIXELS) return false;
  let decoded;
  try {
    decoded = decodeDDSLevels(buffer, { decodeMips: false, header });
  } catch {
    return false;
  }
  const pixels = decoded?.levels?.[0]?.data;
  if (!pixels?.length) return false;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] !== 0) return false;
  }
  return true;
}

/* Some GTA exports declare more mip levels than the file holds. DDSLoader
   trusts the header and reads past the end, so clamp the declared count to
   the levels actually present. Returns the buffer unchanged when it fits. */
export function clampDdsMipCount(buffer, blockBytes, headerBytes = 128) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < headerBytes) return buffer;
  const view = new DataView(buffer);
  if (!(view.getUint32(8, true) & DDSD_MIPMAPCOUNT)) return buffer;
  const declared = Math.max(1, view.getUint32(28, true));
  let width = view.getUint32(16, true);
  let height = view.getUint32(12, true);
  let offset = headerBytes;
  let present = 0;
  for (let level = 0; level < declared; level += 1) {
    const size = Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4)) * blockBytes;
    if (offset + size > buffer.byteLength) break;
    offset += size;
    present += 1;
    width = Math.max(1, width >> 1);
    height = Math.max(1, height >> 1);
  }
  if (present === declared || present === 0) return buffer;
  const copy = buffer.slice(0);
  new DataView(copy).setUint32(28, present, true);
  return copy;
}

export function createS3tcDdsTexture(buffer, fourCc) {
  const data = new DDSLoader().parse(clampDdsMipCount(buffer, fourCc === "DXT1" ? 8 : 16), true);
  if (!data?.width || !data?.height || !data?.format || !Array.isArray(data.mipmaps) || data.mipmaps.length === 0) {
    return null;
  }
  if (fourCc === "DXT1") {
    // The RGBA variant uses the same DXT1 payload while preserving its optional
    // one-bit alpha mode for cutout and decal textures.
    data.format = THREE.RGBA_S3TC_DXT1_Format;
  }
  const texture = new THREE.CompressedTexture(data.mipmaps, data.width, data.height, data.format);
  texture.minFilter = data.mipmapCount > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export function createBptcDdsTexture(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 164) return null;
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const { fourCc, dxgiFormat } = inspectDdsCompression(bytes);
  if (fourCc !== "DX10" || (dxgiFormat !== DXGI_FORMAT_BC7_UNORM && dxgiFormat !== DXGI_FORMAT_BC7_UNORM_SRGB)) {
    return null;
  }

  const width = view.getUint32(16, true);
  const height = view.getUint32(12, true);
  const resourceDimension = view.getUint32(132, true);
  const arraySize = view.getUint32(140, true);
  const caps2 = view.getUint32(112, true);
  if (!width || !height || resourceDimension !== D3D10_RESOURCE_DIMENSION_TEXTURE2D || arraySize !== 1 || (caps2 & DDSCAPS2_CUBEMAP)) {
    return null;
  }

  const flags = view.getUint32(8, true);
  const mipmapCount = flags & DDSD_MIPMAPCOUNT
    ? Math.max(1, view.getUint32(28, true))
    : 1;
  const mipmaps = [];
  let offset = 148;
  let mipWidth = width;
  let mipHeight = height;

  for (let level = 0; level < mipmapCount; level += 1) {
    const blockWidth = Math.max(1, Math.ceil(mipWidth / 4));
    const blockHeight = Math.max(1, Math.ceil(mipHeight / 4));
    const dataLength = blockWidth * blockHeight * 16;
    if (offset + dataLength > buffer.byteLength) {
      if (level === 0) return null;
      break;
    }
    mipmaps.push({
      data: new Uint8Array(buffer, offset, dataLength),
      width: mipWidth,
      height: mipHeight,
    });
    offset += dataLength;
    mipWidth = Math.max(1, mipWidth >> 1);
    mipHeight = Math.max(1, mipHeight >> 1);
  }

  const texture = new THREE.CompressedTexture(mipmaps, width, height, THREE.RGBA_BPTC_Format);
  texture.minFilter = mipmaps.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
