/**
 * GTA V YTD (Texture Dictionary) Parser
 * Extracts textures from YTD files and decodes DXT/BC compressed formats
 */

import { inflate, inflateRaw } from "pako";
import { decodeBC7Block as _decodeBC7Block } from "./bc7";

const RSC7_MAGIC = 0x37435352;
const RSC85_MAGIC = 0x38355352;

// Texture formats used in GTA V
const TEXTURE_FORMAT = {
  DXT1: 0,       // BC1 - RGB with 1-bit alpha
  DXT3: 1,       // BC2 - RGB with explicit alpha
  DXT5: 2,       // BC3 - RGB with interpolated alpha
  BC4: 8,        // BC4 - Single channel (Red), often used for Height/Gloss
  BC5: 9,        // BC5 - Two channels (RG), used for Normal Maps
  BC7: 3,        // BC7 - High quality RGB(A)
  A8R8G8B8: 4,   // Uncompressed BGRA in memory (D3DFMT_A8R8G8B8)
  A1R5G5B5: 5,   // 16-bit with 1-bit alpha
  A8: 6,         // 8-bit alpha only
  L8: 7,         // 8-bit luminance
  A8B8G8R8: 10,  // Uncompressed RGBA in memory (D3DFMT_A8B8G8R8)
  X8R8G8B8: 11,  // Uncompressed BGRX in memory (alpha forced to 0xFF)
};

// D3DFORMAT / DXGI_FORMAT codes found in GTA V textures
// Sourced from CodeWalker TextureFormat enum & DXGI_FORMAT spec
const FORMAT_MAP = {
  // ── D3DFMT legacy integer codes (used in gen7/gen8 resources) ──
  // Values match the D3D9 D3DFORMAT enum exactly.
  21: TEXTURE_FORMAT.A8R8G8B8,    // D3DFMT_A8R8G8B8 — BGRA in memory
  22: TEXTURE_FORMAT.X8R8G8B8,    // D3DFMT_X8R8G8B8 — BGRX in memory (alpha = 0xFF)
  25: TEXTURE_FORMAT.A1R5G5B5,    // D3DFMT_A1R5G5B5
  28: TEXTURE_FORMAT.A8,          // D3DFMT_A8
  32: TEXTURE_FORMAT.A8B8G8R8,    // D3DFMT_A8B8G8R8 — RGBA in memory
  50: TEXTURE_FORMAT.L8,          // D3DFMT_L8

  // ── FourCC codes (MAKEFOURCC, stored as uint32 little-endian ASCII) ──
  0x31545844: TEXTURE_FORMAT.DXT1, // "DXT1" = MAKEFOURCC('D','X','T','1')
  0x33545844: TEXTURE_FORMAT.DXT3, // "DXT3" = MAKEFOURCC('D','X','T','3')
  0x35545844: TEXTURE_FORMAT.DXT5, // "DXT5" = MAKEFOURCC('D','X','T','5')
  0x31495441: TEXTURE_FORMAT.BC4,  // "ATI1" = MAKEFOURCC('A','T','I','1')
  0x32495441: TEXTURE_FORMAT.BC5,  // "ATI2" = MAKEFOURCC('A','T','I','2')
  0x20374342: TEXTURE_FORMAT.BC7,  // "BC7 " = MAKEFOURCC('B','C','7',' ')

  // ── DXGI_FORMAT codes (used in gen9 / newer resources) ──
  // Values match CodeWalker TextureFormatG9 enum.
  // BC1 (DXT1): DXGI 0x46-0x48
  0x46: TEXTURE_FORMAT.DXT1,       // DXGI_FORMAT_BC1_TYPELESS
  0x47: TEXTURE_FORMAT.DXT1,       // DXGI_FORMAT_BC1_UNORM
  0x48: TEXTURE_FORMAT.DXT1,       // DXGI_FORMAT_BC1_UNORM_SRGB
  // BC2 (DXT3): DXGI 0x49-0x4B
  0x49: TEXTURE_FORMAT.DXT3,       // DXGI_FORMAT_BC2_TYPELESS
  0x4A: TEXTURE_FORMAT.DXT3,       // DXGI_FORMAT_BC2_UNORM
  0x4B: TEXTURE_FORMAT.DXT3,       // DXGI_FORMAT_BC2_UNORM_SRGB
  // BC3 (DXT5): DXGI 0x4C-0x4E
  0x4C: TEXTURE_FORMAT.DXT5,       // DXGI_FORMAT_BC3_TYPELESS
  0x4D: TEXTURE_FORMAT.DXT5,       // DXGI_FORMAT_BC3_UNORM
  0x4E: TEXTURE_FORMAT.DXT5,       // DXGI_FORMAT_BC3_UNORM_SRGB
  // BC4 (ATI1): DXGI 0x4F-0x51
  0x4F: TEXTURE_FORMAT.BC4,        // DXGI_FORMAT_BC4_TYPELESS
  0x50: TEXTURE_FORMAT.BC4,        // DXGI_FORMAT_BC4_UNORM
  0x51: TEXTURE_FORMAT.BC4,        // DXGI_FORMAT_BC4_SNORM
  // BC5 (ATI2): DXGI 0x52-0x54
  0x52: TEXTURE_FORMAT.BC5,        // DXGI_FORMAT_BC5_TYPELESS
  0x53: TEXTURE_FORMAT.BC5,        // DXGI_FORMAT_BC5_UNORM
  0x54: TEXTURE_FORMAT.BC5,        // DXGI_FORMAT_BC5_SNORM
  // BC7: DXGI 0x61-0x63
  0x61: TEXTURE_FORMAT.BC7,        // DXGI_FORMAT_BC7_TYPELESS
  0x62: TEXTURE_FORMAT.BC7,        // DXGI_FORMAT_BC7_UNORM
  0x63: TEXTURE_FORMAT.BC7,        // DXGI_FORMAT_BC7_UNORM_SRGB
  // Uncompressed DXGI formats (gen9) — only codes that don't collide with D3DFMT
  // NOTE: 0x1B-0x1D (R8G8B8A8) collide with D3DFMT_A8 (28=0x1C) so are excluded;
  //       legacy parser reads D3DFMT at offset 0x58, gen9 uses a different struct.
  0x3D: TEXTURE_FORMAT.L8,         // DXGI_FORMAT_R8_UNORM
  0x41: TEXTURE_FORMAT.A8,         // DXGI_FORMAT_A8_UNORM
  0x56: TEXTURE_FORMAT.A1R5G5B5,   // DXGI_FORMAT_B5G5R5A1_UNORM
  0x57: TEXTURE_FORMAT.A8R8G8B8,   // DXGI_FORMAT_B8G8R8A8_UNORM
  0x5A: TEXTURE_FORMAT.A8R8G8B8,   // DXGI_FORMAT_B8G8R8A8_TYPELESS
  0x5B: TEXTURE_FORMAT.A8R8G8B8,   // DXGI_FORMAT_B8G8R8A8_UNORM_SRGB
};

/**
 * Parse a YTD file and extract all textures
 * @param {Uint8Array} bytes - Raw YTD file data
 * @param {Object} [options] - { metadataOnly: boolean, decodeNames: string[] }
 *   - metadataOnly: if true, skip RGBA decoding (returns rgba: null for each texture)
 *   - decodeNames: if provided, only decode RGBA for textures whose name is in this set
 * @returns {Object} - Dictionary of textures { name: { width, height, rgba, format } }
 */
export function parseYtd(bytes, options = {}) {
  if (!bytes || bytes.length < 16) {
    console.warn("[YTD] File too small");
    return null;
  }

  try {
    const resource = decodeResource(bytes);
    if (!resource || !resource.data || resource.data.length < 64) {
      console.warn("[YTD] Failed to decode resource");
      return null;
    }

    // Resource decoded — skip verbose logging for performance

    const reader = createReader(
      resource.data,
      resource.systemSize,
      resource.graphicsSize
    );

    const metadataOnly = options.metadataOnly || false;
    const decodeSet = options.decodeNames
      ? new Set(options.decodeNames.map((n) => n.toLowerCase()))
      : null;

    const textures = parseTextureDictionary(reader, metadataOnly, decodeSet);

    if (!textures || Object.keys(textures).length === 0) {
      console.warn("[YTD] No textures found");
      return null;
    }

    // Parsed successfully
    return textures;
  } catch (error) {
    console.error("[YTD] Parse error:", error);
    return null;
  }
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
    slice: function(offset, length) {
      if (offset < 0 || offset + length > len) return null;
      return bytes.subarray(offset, offset + length);
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

export function parseTextureDictionary(reader, metadataOnly = false, decodeSet = null, explicitOffset = null) {
  const textures = {};

  // CodeWalker TextureDictionary (BlockLength = 64):
  //   0x00-0x0F: ResourceFileBase (VFT, Unknown_4h, PagesInfo ptr, ...)
  //   0x10: Unknown_10h (u32)
  //   0x14: Unknown_14h (u32)
  //   0x18: Unknown_18h (u32) = 1
  //   0x1C: Unknown_1Ch (u32)
  //   0x20: TextureNameHashes — ResourceSimpleList64_uint (ptr @ 0x20, count @ 0x28)
  //   0x30: Textures — ResourcePointerList64<Texture> (ptr @ 0x30, count @ 0x38)
  //
  // When embedded inside a ShaderGroup, the dictionary base is at an explicit offset.
  const dictOffsets = explicitOffset !== null ? [explicitOffset] : [0x00];

  for (const baseOffset of dictOffsets) {
    // Primary layout (CodeWalker-verified)
    const hashesPtr = reader.u64(baseOffset + 0x20);
    const texturesPtr = reader.u64(baseOffset + 0x30);

    // ResourceSimpleList64 / ResourcePointerList64 store count as u16 at ptr+8
    // but the list header itself is { pointer(8), count(2), capacity(2) }
    let hashCount = reader.u16(baseOffset + 0x28);
    let textureCount = reader.u16(baseOffset + 0x38);

    // Fallback: try capacity field
    if (textureCount === 0 || textureCount > 512) {
      textureCount = reader.u16(baseOffset + 0x3A);
    }
    if (hashCount === 0 || hashCount > 512) {
      hashCount = reader.u16(baseOffset + 0x2A);
    }

    if (textureCount === 0 || textureCount > 512) continue;
    if (!reader.validPtr(texturesPtr)) continue;

    const texturesArrayOffset = reader.resolvePtr(texturesPtr);
    const hashesArrayOffset = reader.validPtr(hashesPtr) ? reader.resolvePtr(hashesPtr) : 0;

    let parsedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < textureCount; i++) {
      const texturePtr = reader.u64(texturesArrayOffset + i * 8);

      if (!texturePtr || texturePtr === 0n) {
        failedCount++;
        continue;
      }

      const textureOffset = reader.resolvePtr(texturePtr);

      if (textureOffset === 0 || textureOffset >= reader.len) {
        failedCount++;
        continue;
      }

      const texture = parseTexture(reader, textureOffset, i, metadataOnly, decodeSet);

      if (texture) {
        let name = texture.name;
        if (!name && hashesArrayOffset > 0) {
          const hash = reader.u32(hashesArrayOffset + i * 4);
          name = `texture_${hash.toString(16)}`;
        }
        if (!name) {
          name = `texture_${i}`;
        }

        textures[name] = texture;
        parsedCount++;
      } else {
        failedCount++;
      }
    }

    if (Object.keys(textures).length > 0) break;
  }

  return textures;
}

function parseTexture(reader, offset, debugIndex = -1, metadataOnly = false, decodeSet = null) {
  // Texture (extends TextureBase) total BlockLength = 144 (legacy)
  if (!reader.valid(offset) || offset + 144 > reader.len) return null;

  // CodeWalker TextureBase layout (legacy, BlockLength = 80):
  //   0x00: VFT (u32)
  //   0x04: Unknown_4h (u32) = 1
  //   0x08-0x27: Unknown fields
  //   0x28: NamePointer (u64)
  //   0x30-0x4F: Unknown fields + UsageData @ 0x40
  //
  // Texture subclass fields (starting at 0x50):
  //   0x50: Width (u16)
  //   0x52: Height (u16)
  //   0x54: Depth (u16)
  //   0x56: Stride (u16)
  //   0x58: Format (u32) — D3DFMT / DXGI_FORMAT enum value
  //   0x5C: Unknown_5Ch (u8)
  //   0x5D: Levels / MipCount (u8)
  //   0x5E: Unknown_5Eh (u16)
  //   0x60-0x6F: Unknown fields
  //   0x70: DataPointer (u64)

  const width = reader.u16(offset + 0x50);
  const height = reader.u16(offset + 0x52);
  const mipCount = reader.u8(offset + 0x5D);
  const stride = reader.u16(offset + 0x56);

  // Format is a D3DFMT enum (uint32), not an ASCII string
  const formatCode = reader.u32(offset + 0x58);
  let format = FORMAT_MAP[formatCode];

  // If the numeric code didn't match, try interpreting as ASCII FourCC
  // (some modded/custom YTDs may store "DXT5" etc. as ASCII)
  if (format === undefined) {
    const fmtBytes = [
      reader.u8(offset + 0x58),
      reader.u8(offset + 0x59),
      reader.u8(offset + 0x5A),
      reader.u8(offset + 0x5B),
    ];
    const formatStr = String.fromCharCode(...fmtBytes).trim();
    if (formatStr === "DXT1" || formatStr === "BC1") format = TEXTURE_FORMAT.DXT1;
    else if (formatStr === "DXT3" || formatStr === "BC2") format = TEXTURE_FORMAT.DXT3;
    else if (formatStr === "DXT5" || formatStr === "BC3") format = TEXTURE_FORMAT.DXT5;
    else if (formatStr === "ATI1" || formatStr === "BC4") format = TEXTURE_FORMAT.BC4;
    else if (formatStr === "ATI2" || formatStr === "BC5") format = TEXTURE_FORMAT.BC5;
    else if (formatStr === "BC7" || formatStr.startsWith("BC7")) format = TEXTURE_FORMAT.BC7;
    else format = TEXTURE_FORMAT.DXT5; // fallback
  }

  // Validate dimensions
  const isValidDim = (d) => d > 0 && d <= 8192;
  // Allow non-power-of-2 textures (some modded assets use them)
  if (!isValidDim(width) || !isValidDim(height)) {
    return null;
  }

  // Read name from NamePointer at 0x28
  let name = null;
  const namePtr = reader.u64(offset + 0x28);
  if (namePtr && namePtr !== 0n) {
    const nameOffset = reader.resolvePtr(namePtr);
    if (nameOffset > 0 && nameOffset < reader.len) {
      name = readCString(reader, nameOffset);
    }
  }

  // Read UsageData at 0x40 to extract texture usage hint
  const usageData = reader.u32(offset + 0x40);
  const usage = usageData & 0x1F; // TextureUsage enum (lower 5 bits)

  // DataPointer at 0x70 (primary, CodeWalker-verified)
  let dataOffset = 0;
  const dataPtr = reader.u64(offset + 0x70);
  if (dataPtr && dataPtr !== 0n) {
    const resolved = reader.resolvePtr(dataPtr);
    if (resolved > 0 && resolved < reader.len) {
      dataOffset = resolved;
    }
  }

  if (dataOffset === 0) {
    return null;
  }

  // Decide whether to decode RGBA for this texture.
  // - metadataOnly: never decode (fast first pass)
  // - decodeSet: only decode if this texture's name is in the set
  const shouldDecode = !metadataOnly &&
    (!decodeSet || (name && decodeSet.has(name.toLowerCase())));

  let rgba = null;
  let mipmaps = null;
  if (shouldDecode) {
    const result = decodeTextureWithMips(reader, dataOffset, width, height, format, stride, mipCount);
    if (!result) {
      return null;
    }
    rgba = result.rgba;
    mipmaps = result.mipmaps;
  }

  return {
    name,
    nameHash: 0,
    width,
    height,
    format,
    formatCode,
    mipCount,
    stride,
    usage,
    rgba,
    mipmaps,
  };
}

function readCString(reader, offset, maxLength = 256) {
  if (!reader.valid(offset)) return null;
  let str = "";
  for (let i = 0; i < maxLength; i++) {
    const byte = reader.u8(offset + i);
    if (byte === 0) break;
    str += String.fromCharCode(byte);
  }
  return str || null;
}

// Calculate the byte size of a single mip level for a given format
function getMipDataSize(w, h, format, stride) {
  const bw = Math.ceil(w / 4);
  const bh = Math.ceil(h / 4);
  switch (format) {
    case TEXTURE_FORMAT.DXT1:    return bw * bh * 8;   // 8 bytes per 4x4 block
    case TEXTURE_FORMAT.DXT3:    return bw * bh * 16;  // 16 bytes per 4x4 block
    case TEXTURE_FORMAT.DXT5:    return bw * bh * 16;
    case TEXTURE_FORMAT.BC4:     return bw * bh * 8;
    case TEXTURE_FORMAT.BC5:     return bw * bh * 16;
    case TEXTURE_FORMAT.BC7:     return bw * bh * 16;
    case TEXTURE_FORMAT.A8R8G8B8: return (stride > 0 ? stride : w * 4) * h;
    case TEXTURE_FORMAT.A8B8G8R8: return (stride > 0 ? stride : w * 4) * h;
    case TEXTURE_FORMAT.X8R8G8B8: return (stride > 0 ? stride : w * 4) * h;
    case TEXTURE_FORMAT.A1R5G5B5: return (stride > 0 ? stride : w * 2) * h;
    case TEXTURE_FORMAT.A8:      return (stride > 0 ? stride : w) * h;
    case TEXTURE_FORMAT.L8:      return (stride > 0 ? stride : w) * h;
    default:                     return bw * bh * 16; // assume BC3-like
  }
}

// Decode a single mip level at the given offset
function decodeSingleMip(reader, offset, width, height, format, stride) {
  const rgba = new Uint8Array(width * height * 4);

  switch (format) {
    case TEXTURE_FORMAT.DXT1:
      decodeDXT1(reader, offset, width, height, rgba);
      break;
    case TEXTURE_FORMAT.DXT3:
      decodeDXT3(reader, offset, width, height, rgba);
      break;
    case TEXTURE_FORMAT.DXT5:
      decodeDXT5(reader, offset, width, height, rgba);
      break;
    case TEXTURE_FORMAT.BC4:
      decodeBC4(reader, offset, width, height, rgba);
      break;
    case TEXTURE_FORMAT.BC5:
      decodeBC5(reader, offset, width, height, rgba);
      break;
    case TEXTURE_FORMAT.BC7:
      decodeBC7(reader, offset, width, height, rgba);
      break;
    case TEXTURE_FORMAT.A8R8G8B8:
      decodeARGB8(reader, offset, width, height, rgba, stride);
      break;
    case TEXTURE_FORMAT.A8B8G8R8:
      decodeABGR8(reader, offset, width, height, rgba, stride);
      break;
    case TEXTURE_FORMAT.X8R8G8B8:
      decodeXRGB8(reader, offset, width, height, rgba, stride);
      break;
    case TEXTURE_FORMAT.A1R5G5B5:
      decodeA1R5G5B5(reader, offset, width, height, rgba, stride);
      break;
    case TEXTURE_FORMAT.A8:
      decodeA8(reader, offset, width, height, rgba, stride);
      break;
    case TEXTURE_FORMAT.L8:
      decodeL8(reader, offset, width, height, rgba, stride);
      break;
    default:
      decodeDXT5(reader, offset, width, height, rgba);
      break;
  }

  return rgba;
}

// Decode texture with all mip levels
function decodeTextureWithMips(reader, offset, width, height, format, stride, mipCount) {
  if (!decodeTextureWithMips._formatStats) decodeTextureWithMips._formatStats = {};
  const fmtName = Object.entries(TEXTURE_FORMAT).find(([,v]) => v === format)?.[0] || `unknown(${format})`;
  decodeTextureWithMips._formatStats[fmtName] = (decodeTextureWithMips._formatStats[fmtName] || 0) + 1;
  if (!decodeTextureWithMips._logged) {
    decodeTextureWithMips._logged = true;
    setTimeout(() => {
      console.log("[YTD] Texture format stats:", decodeTextureWithMips._formatStats);
    }, 2000);
  }

  // Decode base level (mip 0)
  const rgba = decodeSingleMip(reader, offset, width, height, format, stride);
  if (!rgba) return null;

  // Decode additional mip levels if available
  const mipmaps = [];
  if (mipCount > 1) {
    let mipOffset = offset + getMipDataSize(width, height, format, stride);
    let mw = width;
    let mh = height;

    for (let level = 1; level < mipCount; level++) {
      mw = Math.max(1, mw >> 1);
      mh = Math.max(1, mh >> 1);

      // Safety: check we have enough data
      const mipSize = getMipDataSize(mw, mh, format, stride);
      if (mipOffset + mipSize > reader.len) break;

      try {
        const mipRgba = decodeSingleMip(reader, mipOffset, mw, mh, format, 0);
        if (mipRgba) {
          mipmaps.push({ data: mipRgba, width: mw, height: mh });
        }
      } catch {
        break; // Stop on decode errors
      }

      mipOffset += mipSize;
    }
  }

  return { rgba, mipmaps: mipmaps.length > 0 ? mipmaps : null };
}

// Pre-allocated scratch buffers for block decoders — avoids per-block allocations
// Each color palette has 4 entries x 4 channels (RGBA) = 16 values
const _colorPalette = new Uint8Array(16); // 4 colors x 4 channels
const _alphaPalette = new Uint8Array(8);  // 8 alpha values

// Decode RGB565 color directly into palette at the given slot (0-3)
function decode565Into(c, slot) {
  const base = slot << 2;
  _colorPalette[base]     = ((c >> 11) & 0x1F) * 255 / 31 + 0.5 | 0;
  _colorPalette[base + 1] = ((c >> 5) & 0x3F) * 255 / 63 + 0.5 | 0;
  _colorPalette[base + 2] = (c & 0x1F) * 255 / 31 + 0.5 | 0;
  _colorPalette[base + 3] = 255;
}

// Build the 4-color palette in-place from two 565 endpoints
function buildColorPalette(c0, c1, fourColor) {
  decode565Into(c0, 0);
  decode565Into(c1, 1);

  if (fourColor) {
    // 4-color mode: interpolate 2/3 and 1/3
    _colorPalette[8]  = ((_colorPalette[0] * 2 + _colorPalette[4]) / 3) | 0;
    _colorPalette[9]  = ((_colorPalette[1] * 2 + _colorPalette[5]) / 3) | 0;
    _colorPalette[10] = ((_colorPalette[2] * 2 + _colorPalette[6]) / 3) | 0;
    _colorPalette[11] = 255;
    _colorPalette[12] = ((_colorPalette[0] + _colorPalette[4] * 2) / 3) | 0;
    _colorPalette[13] = ((_colorPalette[1] + _colorPalette[5] * 2) / 3) | 0;
    _colorPalette[14] = ((_colorPalette[2] + _colorPalette[6] * 2) / 3) | 0;
    _colorPalette[15] = 255;
  } else {
    // 3-color + transparent mode
    _colorPalette[8]  = ((_colorPalette[0] + _colorPalette[4]) >> 1);
    _colorPalette[9]  = ((_colorPalette[1] + _colorPalette[5]) >> 1);
    _colorPalette[10] = ((_colorPalette[2] + _colorPalette[6]) >> 1);
    _colorPalette[11] = 255;
    _colorPalette[12] = 0;
    _colorPalette[13] = 0;
    _colorPalette[14] = 0;
    _colorPalette[15] = 0;
  }
}

// DXT1 (BC1) Decoder — optimized with pre-allocated palette and direct byte writes
function decodeDXT1(reader, offset, width, height, rgba) {
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  const w4 = width << 2; // width * 4 bytes per pixel

  let blockOffset = offset;

  for (let by = 0; by < blocksY; by++) {
    const baseY = by << 2;
    for (let bx = 0; bx < blocksX; bx++) {
      const baseX = bx << 2;
      const c0 = reader.u16(blockOffset);
      const c1 = reader.u16(blockOffset + 2);
      const indices = reader.u32(blockOffset + 4);
      blockOffset += 8;

      buildColorPalette(c0, c1, c0 > c1);

      for (let py = 0; py < 4; py++) {
        const y = baseY + py;
        if (y >= height) break;
        const rowBase = y * w4;
        for (let px = 0; px < 4; px++) {
          const x = baseX + px;
          if (x >= width) continue;

          const idx = ((indices >> ((py * 4 + px) << 1)) & 0x3) << 2;
          const pixelOffset = rowBase + (x << 2);
          rgba[pixelOffset]     = _colorPalette[idx];
          rgba[pixelOffset + 1] = _colorPalette[idx + 1];
          rgba[pixelOffset + 2] = _colorPalette[idx + 2];
          rgba[pixelOffset + 3] = _colorPalette[idx + 3];
        }
      }
    }
  }
}

// DXT3 (BC2) Decoder — optimized
function decodeDXT3(reader, offset, width, height, rgba) {
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  const w4 = width << 2;

  let blockOffset = offset;

  for (let by = 0; by < blocksY; by++) {
    const baseY = by << 2;
    for (let bx = 0; bx < blocksX; bx++) {
      const baseX = bx << 2;
      // Alpha block (8 bytes)
      const alphaLo = reader.u32(blockOffset);
      const alphaHi = reader.u32(blockOffset + 4);
      blockOffset += 8;

      // Color block (8 bytes)
      const c0 = reader.u16(blockOffset);
      const c1 = reader.u16(blockOffset + 2);
      const indices = reader.u32(blockOffset + 4);
      blockOffset += 8;

      buildColorPalette(c0, c1, true);

      for (let py = 0; py < 4; py++) {
        const y = baseY + py;
        if (y >= height) break;
        const rowBase = y * w4;
        for (let px = 0; px < 4; px++) {
          const x = baseX + px;
          if (x >= width) continue;

          const idx = ((indices >> ((py * 4 + px) << 1)) & 0x3) << 2;

          // Get explicit alpha
          const alphaIdx = py * 4 + px;
          const alphaBits = alphaIdx < 8 ? alphaLo : alphaHi;
          const alphaShift = (alphaIdx % 8) * 4;
          const alpha = ((alphaBits >> alphaShift) & 0xF) * 17;

          const pixelOffset = rowBase + (x << 2);
          rgba[pixelOffset]     = _colorPalette[idx];
          rgba[pixelOffset + 1] = _colorPalette[idx + 1];
          rgba[pixelOffset + 2] = _colorPalette[idx + 2];
          rgba[pixelOffset + 3] = alpha;
        }
      }
    }
  }
}

// Build alpha palette in-place for BC3 blocks
function buildAlphaPalette(a0, a1) {
  _alphaPalette[0] = a0;
  _alphaPalette[1] = a1;

  if (a0 > a1) {
    _alphaPalette[2] = ((6 * a0 + 1 * a1) / 7) | 0;
    _alphaPalette[3] = ((5 * a0 + 2 * a1) / 7) | 0;
    _alphaPalette[4] = ((4 * a0 + 3 * a1) / 7) | 0;
    _alphaPalette[5] = ((3 * a0 + 4 * a1) / 7) | 0;
    _alphaPalette[6] = ((2 * a0 + 5 * a1) / 7) | 0;
    _alphaPalette[7] = ((1 * a0 + 6 * a1) / 7) | 0;
  } else {
    _alphaPalette[2] = ((4 * a0 + 1 * a1) / 5) | 0;
    _alphaPalette[3] = ((3 * a0 + 2 * a1) / 5) | 0;
    _alphaPalette[4] = ((2 * a0 + 3 * a1) / 5) | 0;
    _alphaPalette[5] = ((1 * a0 + 4 * a1) / 5) | 0;
    _alphaPalette[6] = 0;
    _alphaPalette[7] = 255;
  }
}

// DXT5 (BC3) Decoder — optimized with pre-allocated palettes
function decodeDXT5(reader, offset, width, height, rgba) {
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  const w4 = width << 2;

  let blockOffset = offset;

  for (let by = 0; by < blocksY; by++) {
    const baseY = by << 2;
    for (let bx = 0; bx < blocksX; bx++) {
      const baseX = bx << 2;
      // Alpha block (8 bytes)
      const alpha0 = reader.u8(blockOffset);
      const alpha1 = reader.u8(blockOffset + 1);
      const alphaBitsLo = reader.u8(blockOffset + 2) | (reader.u8(blockOffset + 3) << 8) | (reader.u8(blockOffset + 4) << 16);
      const alphaBitsHi = reader.u8(blockOffset + 5) | (reader.u8(blockOffset + 6) << 8) | (reader.u8(blockOffset + 7) << 16);
      blockOffset += 8;

      buildAlphaPalette(alpha0, alpha1);

      // Color block (8 bytes)
      const c0 = reader.u16(blockOffset);
      const c1 = reader.u16(blockOffset + 2);
      const indices = reader.u32(blockOffset + 4);
      blockOffset += 8;

      buildColorPalette(c0, c1, true);

      for (let py = 0; py < 4; py++) {
        const y = baseY + py;
        if (y >= height) break;
        const rowBase = y * w4;
        for (let px = 0; px < 4; px++) {
          const x = baseX + px;
          if (x >= width) continue;

          const colorIdx = ((indices >> ((py * 4 + px) << 1)) & 0x3) << 2;

          // Get interpolated alpha
          const alphaPixelIdx = py * 4 + px;
          const alphaBits = alphaPixelIdx < 8 ? alphaBitsLo : alphaBitsHi;
          const alphaShift = alphaPixelIdx < 8 ? alphaPixelIdx * 3 : (alphaPixelIdx - 8) * 3;
          const alphaIdx = (alphaBits >> alphaShift) & 0x7;

          const pixelOffset = rowBase + (x << 2);
          rgba[pixelOffset]     = _colorPalette[colorIdx];
          rgba[pixelOffset + 1] = _colorPalette[colorIdx + 1];
          rgba[pixelOffset + 2] = _colorPalette[colorIdx + 2];
          rgba[pixelOffset + 3] = _alphaPalette[alphaIdx];
        }
      }
    }
  }
}

// BC4 Decoder (Single channel Red)
function decodeBC4(reader, offset, width, height, rgba) {
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  const w4 = width << 2;

  let blockOffset = offset;

  for (let by = 0; by < blocksY; by++) {
    const baseY = by << 2;
    for (let bx = 0; bx < blocksX; bx++) {
      const baseX = bx << 2;
      
      const r0 = reader.u8(blockOffset);
      const r1 = reader.u8(blockOffset + 1);
      const rBitsLo = reader.u8(blockOffset + 2) | (reader.u8(blockOffset + 3) << 8) | (reader.u8(blockOffset + 4) << 16);
      const rBitsHi = reader.u8(blockOffset + 5) | (reader.u8(blockOffset + 6) << 8) | (reader.u8(blockOffset + 7) << 16);
      blockOffset += 8;

      buildAlphaPalette(r0, r1); // Reusing alpha palette builder for Red channel
      const redPalette = new Uint8Array(_alphaPalette); // Copy it

      for (let py = 0; py < 4; py++) {
        const y = baseY + py;
        if (y >= height) break;
        const rowBase = y * w4;
        for (let px = 0; px < 4; px++) {
          const x = baseX + px;
          if (x >= width) continue;

          const pIdx = py * 4 + px;
          const bits = pIdx < 8 ? rBitsLo : rBitsHi;
          const shift = pIdx < 8 ? pIdx * 3 : (pIdx - 8) * 3;
          const idx = (bits >> shift) & 0x7;

          const r = redPalette[idx];

          const pixelOffset = rowBase + (x << 2);
          rgba[pixelOffset]     = r;
          rgba[pixelOffset + 1] = r;
          rgba[pixelOffset + 2] = r;
          rgba[pixelOffset + 3] = 255;
        }
      }
    }
  }
}

// BC5 Decoder (Two channels RG - typically Normal Map)
function decodeBC5(reader, offset, width, height, rgba) {
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  const w4 = width << 2;

  let blockOffset = offset;

  for (let by = 0; by < blocksY; by++) {
    const baseY = by << 2;
    for (let bx = 0; bx < blocksX; bx++) {
      const baseX = bx << 2;

      // Block 0: Red (X)
      const r0 = reader.u8(blockOffset);
      const r1 = reader.u8(blockOffset + 1);
      const rBitsLo = reader.u8(blockOffset + 2) | (reader.u8(blockOffset + 3) << 8) | (reader.u8(blockOffset + 4) << 16);
      const rBitsHi = reader.u8(blockOffset + 5) | (reader.u8(blockOffset + 6) << 8) | (reader.u8(blockOffset + 7) << 16);
      blockOffset += 8;

      buildAlphaPalette(r0, r1);
      const redPalette = new Uint8Array(_alphaPalette);

      // Block 1: Green (Y)
      const g0 = reader.u8(blockOffset);
      const g1 = reader.u8(blockOffset + 1);
      const gBitsLo = reader.u8(blockOffset + 2) | (reader.u8(blockOffset + 3) << 8) | (reader.u8(blockOffset + 4) << 16);
      const gBitsHi = reader.u8(blockOffset + 5) | (reader.u8(blockOffset + 6) << 8) | (reader.u8(blockOffset + 7) << 16);
      blockOffset += 8;

      buildAlphaPalette(g0, g1);
      const greenPalette = new Uint8Array(_alphaPalette);

      for (let py = 0; py < 4; py++) {
        const y = baseY + py;
        if (y >= height) break;
        const rowBase = y * w4;
        for (let px = 0; px < 4; px++) {
          const x = baseX + px;
          if (x >= width) continue;

          const pIdx = py * 4 + px;
          
          // Red lookup
          const rShift = pIdx < 8 ? pIdx * 3 : (pIdx - 8) * 3;
          const rIdx = ((pIdx < 8 ? rBitsLo : rBitsHi) >> rShift) & 0x7;
          const r = redPalette[rIdx];

          // Green lookup
          const gShift = pIdx < 8 ? pIdx * 3 : (pIdx - 8) * 3;
          const gIdx = ((pIdx < 8 ? gBitsLo : gBitsHi) >> gShift) & 0x7;
          const g = greenPalette[gIdx];

          // Reconstruct Blue (Z) for normal map: Z = sqrt(1 - x*x - y*y)
          // Map 0..255 to -1..1
          const nx = (r / 255.0) * 2.0 - 1.0;
          const ny = (g / 255.0) * 2.0 - 1.0;
          const nz = Math.sqrt(Math.max(0, 1.0 - nx * nx - ny * ny));
          const b = Math.floor((nz * 0.5 + 0.5) * 255);

          const pixelOffset = rowBase + (x << 2);
          rgba[pixelOffset]     = r;
          rgba[pixelOffset + 1] = g;
          rgba[pixelOffset + 2] = b; // Reconstructed Z
          rgba[pixelOffset + 3] = 255;
        }
      }
    }
  }
}

// BC7 Decoder — full spec-compliant implementation in bc7.js
function decodeBC7(reader, offset, width, height, rgba) {
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);

  let blockOffset = offset;

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const block = reader.slice(blockOffset, 16);
      blockOffset += 16;

      if (!block) continue;

      _decodeBC7Block(block, bx, by, width, height, rgba);
    }
  }
}

// Decode A8R8G8B8 format — optimized with direct byte array access
function decodeARGB8(reader, offset, width, height, rgba, stride) {
  const rowStride = stride > 0 ? stride : width * 4;
  const bytes = reader.bytes;
  const len = reader.len;
  const rowPixels = width << 2;

  for (let y = 0; y < height; y++) {
    const srcRowBase = offset + y * rowStride;
    const dstRowBase = y * rowPixels;
    if (srcRowBase + rowPixels > len) break;

    for (let x = 0; x < width; x++) {
      const srcOff = srcRowBase + (x << 2);
      const dstOff = dstRowBase + (x << 2);

      // BGRA -> RGBA swizzle
      rgba[dstOff]     = bytes[srcOff + 2]; // R
      rgba[dstOff + 1] = bytes[srcOff + 1]; // G
      rgba[dstOff + 2] = bytes[srcOff];     // B
      rgba[dstOff + 3] = bytes[srcOff + 3]; // A
    }
  }
}

// Decode A8B8G8R8 format — data is RGBA in memory, direct copy
function decodeABGR8(reader, offset, width, height, rgba, stride) {
  const rowStride = stride > 0 ? stride : width * 4;
  const bytes = reader.bytes;
  const len = reader.len;
  const rowPixels = width << 2;

  for (let y = 0; y < height; y++) {
    const srcRowBase = offset + y * rowStride;
    const dstRowBase = y * rowPixels;
    if (srcRowBase + rowPixels > len) break;

    for (let x = 0; x < width; x++) {
      const srcOff = srcRowBase + (x << 2);
      const dstOff = dstRowBase + (x << 2);

      // RGBA — no swizzle needed
      rgba[dstOff]     = bytes[srcOff];     // R
      rgba[dstOff + 1] = bytes[srcOff + 1]; // G
      rgba[dstOff + 2] = bytes[srcOff + 2]; // B
      rgba[dstOff + 3] = bytes[srcOff + 3]; // A
    }
  }
}

// Decode X8R8G8B8 format — BGRA in memory with alpha forced to 0xFF
function decodeXRGB8(reader, offset, width, height, rgba, stride) {
  const rowStride = stride > 0 ? stride : width * 4;
  const bytes = reader.bytes;
  const len = reader.len;
  const rowPixels = width << 2;

  for (let y = 0; y < height; y++) {
    const srcRowBase = offset + y * rowStride;
    const dstRowBase = y * rowPixels;
    if (srcRowBase + rowPixels > len) break;

    for (let x = 0; x < width; x++) {
      const srcOff = srcRowBase + (x << 2);
      const dstOff = dstRowBase + (x << 2);

      // BGRA -> RGBA swizzle, alpha forced to 0xFF (X channel ignored)
      rgba[dstOff]     = bytes[srcOff + 2]; // R
      rgba[dstOff + 1] = bytes[srcOff + 1]; // G
      rgba[dstOff + 2] = bytes[srcOff];     // B
      rgba[dstOff + 3] = 255;               // A (forced opaque)
    }
  }
}

// A1R5G5B5 (16-bit with 1-bit alpha) Decoder
function decodeA1R5G5B5(reader, offset, width, height, rgba, stride) {
  const rowStride = stride > 0 ? stride : width * 2;
  const bytes = reader.bytes;
  const len = reader.len;
  const rowPixels = width << 2;

  for (let y = 0; y < height; y++) {
    const srcRowBase = offset + y * rowStride;
    const dstRowBase = y * rowPixels;
    if (srcRowBase + width * 2 > len) break;

    for (let x = 0; x < width; x++) {
      const srcOff = srcRowBase + x * 2;
      const pixel = bytes[srcOff] | (bytes[srcOff + 1] << 8);
      const dstOff = dstRowBase + (x << 2);

      rgba[dstOff]     = ((pixel >> 10) & 0x1F) * 255 / 31 + 0.5 | 0; // R
      rgba[dstOff + 1] = ((pixel >> 5) & 0x1F) * 255 / 31 + 0.5 | 0;  // G
      rgba[dstOff + 2] = (pixel & 0x1F) * 255 / 31 + 0.5 | 0;         // B
      rgba[dstOff + 3] = (pixel >> 15) ? 255 : 0;                      // A
    }
  }
}

// A8 (8-bit alpha only) Decoder — renders as grayscale
function decodeA8(reader, offset, width, height, rgba, stride) {
  const rowStride = stride > 0 ? stride : width;
  const bytes = reader.bytes;
  const len = reader.len;
  const rowPixels = width << 2;

  for (let y = 0; y < height; y++) {
    const srcRowBase = offset + y * rowStride;
    const dstRowBase = y * rowPixels;
    if (srcRowBase + width > len) break;

    for (let x = 0; x < width; x++) {
      const a = bytes[srcRowBase + x];
      const dstOff = dstRowBase + (x << 2);
      rgba[dstOff]     = 255;
      rgba[dstOff + 1] = 255;
      rgba[dstOff + 2] = 255;
      rgba[dstOff + 3] = a;
    }
  }
}

// L8 (8-bit luminance) Decoder
function decodeL8(reader, offset, width, height, rgba, stride) {
  const rowStride = stride > 0 ? stride : width;
  const bytes = reader.bytes;
  const len = reader.len;
  const rowPixels = width << 2;

  for (let y = 0; y < height; y++) {
    const srcRowBase = offset + y * rowStride;
    const dstRowBase = y * rowPixels;
    if (srcRowBase + width > len) break;

    for (let x = 0; x < width; x++) {
      const l = bytes[srcRowBase + x];
      const dstOff = dstRowBase + (x << 2);
      rgba[dstOff]     = l;
      rgba[dstOff + 1] = l;
      rgba[dstOff + 2] = l;
      rgba[dstOff + 3] = 255;
    }
  }
}


// CodeWalker TextureUsage enum values (lower 5 bits of UsageData)
const TEXTURE_USAGE = {
  UNKNOWN: 0,
  DEFAULT: 1,
  TERRAIN: 2,
  CLOUDDENSITY: 3,
  CLOUDNORMAL: 4,
  CABLE: 5,
  FENCE: 6,
  SCRIPT: 8,
  WATERFLOW: 9,
  WATERFOAM: 10,
  WATERFOG: 11,
  WATEROCEAN: 12,
  FOAMOPACITY: 14,
  DIFFUSEMIPSHARPEN: 16,
  DIFFUSEDARK: 18,
  DIFFUSEALPHAOPAQUE: 19,
  DIFFUSE: 20,
  DETAIL: 21,
  NORMAL: 22,
  SPECULAR: 23,
  EMISSIVE: 24,
  TINTPALETTE: 25,
  SKIPPROCESSING: 26,
};

/**
 * Categorize textures by type using CodeWalker's TextureUsage metadata
 * when available, falling back to naming conventions.
 * @param {Object} textures - Dictionary of parsed textures
 * @returns {Object} - Categorized textures { diffuse: {}, normal: {}, specular: {}, detail: {}, other: {} }
 */
export function categorizeTextures(textures) {
  const categories = {
    diffuse: {},
    normal: {},
    specular: {},
    detail: {},
    other: {},
  };

  for (const [name, texture] of Object.entries(textures)) {
    const lowerName = name.toLowerCase();
    const baseName = getTextureBaseName(lowerName);
    const entry = { ...texture, originalName: name };

    // Strategy 1: Use TextureUsage metadata from the file (most reliable)
    const usage = texture.usage;
    if (usage === TEXTURE_USAGE.NORMAL || usage === TEXTURE_USAGE.CLOUDNORMAL) {
      categories.normal[baseName] = entry;
      continue;
    }
    if (usage === TEXTURE_USAGE.SPECULAR) {
      categories.specular[baseName] = entry;
      continue;
    }
    if (usage === TEXTURE_USAGE.DETAIL) {
      categories.detail[baseName] = entry;
      continue;
    }
    if (usage === TEXTURE_USAGE.DIFFUSE || usage === TEXTURE_USAGE.DIFFUSEMIPSHARPEN ||
        usage === TEXTURE_USAGE.DIFFUSEDARK || usage === TEXTURE_USAGE.DIFFUSEALPHAOPAQUE) {
      categories.diffuse[baseName] = entry;
      continue;
    }

    // Strategy 2: Fall back to naming conventions
    if (lowerName.endsWith("_n") || lowerName.includes("_normal") || lowerName.includes("_nrm")) {
      categories.normal[baseName] = entry;
    } else if (lowerName.endsWith("_s") || lowerName.includes("_spec") || lowerName.includes("_specular")) {
      categories.specular[baseName] = entry;
    } else if (lowerName.includes("_detail") || lowerName.endsWith("_d2")) {
      categories.detail[baseName] = entry;
    } else if (lowerName.endsWith("_d") || !lowerName.match(/_[a-z]$/)) {
      // Diffuse textures end with _d or have no suffix
      categories.diffuse[baseName] = entry;
    } else {
      categories.other[name] = texture;
    }
  }

  return categories;
}

function getTextureBaseName(name) {
  // Remove common suffixes to get base name for matching
  return name
    .replace(/_d$/, "")
    .replace(/_n$/, "")
    .replace(/_s$/, "")
    .replace(/_normal$/, "")
    .replace(/_nrm$/, "")
    .replace(/_spec$/, "")
    .replace(/_specular$/, "")
    .replace(/_detail$/, "")
    .replace(/_d2$/, "");
}

/**
 * Shader role mapping: what semantic role each GTA V shader type plays.
 * Used to match shaders to textures via the qualifier system below.
 */
const SHADER_ROLE = {
  // Paint / body shaders — the main vehicle body
  vehicle_paint1: "paint", vehicle_paint2: "paint", vehicle_paint3: "paint",
  vehicle_paint4: "paint", vehicle_paint5: "paint", vehicle_paint6: "paint",
  vehicle_paint7: "paint", vehicle_paint8: "paint", vehicle_paint9: "paint",
  vehicle_paint1_enveff: "paint", vehicle_paint2_enveff: "paint", vehicle_paint3_enveff: "paint",
  vehicle_paint3_lvr: "paint", vehicle_paint4_emissive: "paint", vehicle_paint4_enveff: "paint",
  // Interior
  vehicle_interior: "interior", vehicle_interior2: "interior",
  vehicle_dash: "interior", vehicle_dash_emissive: "interior", vehicle_dash_emissive_opaque: "interior",
  // Detail / decal
  vehicle_detail: "detail", vehicle_detail2: "detail",
  vehicle_decal: "decal", vehicle_decal2: "decal",
  vehicle_badges: "detail", vehicle_licenseplate: "detail",
  // Generic mesh
  vehicle_mesh: "mesh", vehicle_mesh2: "mesh",
  vehicle_mesh_enveff: "mesh", vehicle_mesh2_enveff: "mesh",
  vehicle_shuts: "mesh", vehicle_generic: "mesh", vehicle_basic: "mesh",
  vehicle_nosplash: "mesh", vehicle_nowater: "mesh",
  vehicle_cutout: "mesh", vehicle_cloth: "mesh", vehicle_cloth2: "mesh",
  vehicle_blurredrotor: "mesh", vehicle_blurredrotor_emissive: "mesh",
  // Glass / windows
  glass: "glass", glass_pv: "glass", glass_env: "glass",
  vehicle_vehglass: "glass", vehicle_vehglass_inner: "glass",
  // Lights / emissive
  vehicle_lights: "lights", vehicle_lights2: "lights",
  vehicle_lightsemissive: "lights", vehicle_lightsemissive_siren: "lights",
  vehicle_emissive_alpha: "lights", vehicle_emissive_opaque: "lights",
  // Tires / tracks
  vehicle_tire: "tire", vehicle_tire_emissive: "tire",
  vehicle_track: "tire", vehicle_track2: "tire",
  vehicle_track_ammo: "tire", vehicle_track_cutout: "tire",
  vehicle_track_emissive: "tire", vehicle_track_siren: "tire", vehicle_track2_emissive: "tire",
  // Sign materials (livery overlay areas)
  vehicle_sign: "sign", vehicle_sign2: "sign",
};

/**
 * Maps texture qualifier suffixes (the part after the vehicle name prefix)
 * to the shader role they correspond to.
 * e.g. "tillertrl1_interior_d" → qualifier "interior" → role "interior"
 */
const QUALIFIER_TO_ROLE = {
  interior: "interior", cabin: "interior", inside: "interior", dash: "interior",
  sign: "sign", sign_1: "sign", sign_2: "sign", sign_3: "sign",
  lights: "lights", light: "lights", lamp: "lights", emissive: "lights",
  detail: "detail", badge: "detail", emblem: "detail", logo: "detail", plate: "detail",
  decal: "decal",
  glass: "glass", window: "glass", windshield: "glass",
  tire: "tire", tyre: "tire", wheel: "tire", rubber: "tire", track: "tire",
  mesh: "mesh", chrome: "mesh", metal: "mesh", trim: "mesh",
  body: "paint", paint: "paint", livery: "paint", skin: "paint",
};

/**
 * Match YTD textures to model materials.
 *
 * Uses a prioritised strategy:
 *   1. **Direct texture references** – if the YFT shader parameters contain
 *      explicit texture names (DiffuseSampler, BumpSampler, SpecSampler), match
 *      those names against YTD entries.  This is the most accurate method.
 *   2. **Direct name match** – material name equals a texture base name.
 *   3. **Role-based heuristic** – shader type (vehicle_paint3 → "paint") is
 *      matched to a texture qualifier (vehiclename_interior → "interior").
 *
 * @param {Object} categorizedTextures - { diffuse, normal, specular, detail, other }
 * @param {Array} materialNames - Shader/material names from the model
 * @param {Object} [materialTextureRefs] - { materialName: { diffuse: "texName", normal: "texName_n", specular: "texName_s" } }
 * @returns {Object} mapping + { _meta: { rootBase, assignments[] } }
 */
export function matchTexturesToMaterials(categorizedTextures, materialNames, materialTextureRefs = {}) {
  const mapping = {};
  const assignments = []; // for UI display

  // Build a case-insensitive lookup of ALL raw textures by original name
  const allTexturesByName = {};  // lowerName → { texture, category, baseName }
  for (const cat of ["diffuse", "normal", "specular", "detail", "other"]) {
    for (const [baseName, tex] of Object.entries(categorizedTextures[cat] || {})) {
      const origName = (tex.originalName || tex.name || baseName).toLowerCase();
      allTexturesByName[origName] = { texture: tex, category: cat, baseName };
      // Also index by baseName in case the ref uses the stripped form
      allTexturesByName[baseName.toLowerCase()] = { texture: tex, category: cat, baseName };
    }
  }

  const allDiffuse = Object.entries(categorizedTextures.diffuse || {});
  const allNormal = Object.entries(categorizedTextures.normal || {});
  const allSpecular = Object.entries(categorizedTextures.specular || {});

  // Track which textures have been assigned (for the UI browser)
  const assignedTextures = new Map(); // textureName → materialName

  // --- Assign textures to each material ---
  for (const materialName of materialNames) {
    mapping[materialName] = { diffuse: null, normal: null, specular: null };

    // ── Strategy 1: Direct shader texture references ──
    const refs = materialTextureRefs[materialName];
    if (refs) {
      let matched = false;
      for (const [role, texRefName] of Object.entries(refs)) {
        if (!texRefName) continue;
        const lowerRef = texRefName.toLowerCase();
        const found = allTexturesByName[lowerRef];
        if (!found) continue;

        // Map shader param role to our channel name
        const channel = role === "normal" || role === "normal2" ? "normal"
          : role === "specular" ? "specular"
          : "diffuse";  // diffuse, diffuse2, diffuse3, detail, etc. → diffuse

        if (!mapping[materialName][channel]) {
          mapping[materialName][channel] = found.texture;
          assignedTextures.set(texRefName, materialName);
          matched = true;
        }
      }

      // If we got at least a diffuse from refs, also try to find matching
      // normal/specular by convention (same base name + _n / _s suffix)
      if (matched && mapping[materialName].diffuse) {
        const diffName = (mapping[materialName].diffuse.originalName || mapping[materialName].diffuse.name || "").toLowerCase();
        const diffBase = getTextureBaseName(diffName);
        if (!mapping[materialName].normal) {
          mapping[materialName].normal = findByBaseName(allNormal, diffBase);
        }
        if (!mapping[materialName].specular) {
          mapping[materialName].specular = findByBaseName(allSpecular, diffBase);
        }
      }

      if (matched) continue;
    }

    // ── Strategy 2: Direct name match ──
    const lowerMat = materialName.toLowerCase().trim();
    const baseMat = getTextureBaseName(lowerMat);
    const directDiffuse = categorizedTextures.diffuse?.[lowerMat] || categorizedTextures.diffuse?.[baseMat];
    if (directDiffuse) {
      mapping[materialName].diffuse = directDiffuse;
      mapping[materialName].normal = categorizedTextures.normal?.[lowerMat] || categorizedTextures.normal?.[baseMat] || null;
      mapping[materialName].specular = categorizedTextures.specular?.[lowerMat] || categorizedTextures.specular?.[baseMat] || null;
      continue;
    }

    // ── Strategy 3: Role-based heuristic (legacy fallback) ──
    const shaderRole = SHADER_ROLE[lowerMat];
    if (shaderRole) {
      // Find the first diffuse texture that matches this role by qualifier
      for (const [baseName, tex] of allDiffuse) {
        const lowerBase = baseName.toLowerCase();
        let texRole = null;

        // Check qualifier keywords
        for (const [qKey, qRole] of Object.entries(QUALIFIER_TO_ROLE)) {
          if (lowerBase === qKey || lowerBase.endsWith("_" + qKey) || lowerBase.includes("_" + qKey + "_")) {
            texRole = qRole;
            break;
          }
        }

        if (texRole === shaderRole) {
          mapping[materialName].diffuse = tex;
          mapping[materialName].normal = findByBaseName(allNormal, baseName);
          mapping[materialName].specular = findByBaseName(allSpecular, baseName);
          break;
        }
      }
    }
  }

  // --- Build assignments list for the YTD Browser UI ---
  for (const cat of ["diffuse", "normal", "specular", "detail", "other"]) {
    for (const [baseName, tex] of Object.entries(categorizedTextures[cat] || {})) {
      const texName = tex.originalName || tex.name || baseName;
      const assignedMat = assignedTextures.get(texName) || null;

      // Also check non-ref assignments
      let materialName = assignedMat;
      if (!materialName) {
        for (const matName of materialNames) {
          const m = mapping[matName];
          if (!m) continue;
          for (const ch of ["diffuse", "normal", "specular"]) {
            const t = m[ch];
            if (t && (t.originalName || t.name) === texName) {
              materialName = matName;
              break;
            }
          }
          if (materialName) break;
        }
      }

      // Determine role based on category
      const role = cat === "diffuse" ? "diffuse" : cat === "normal" ? "normal" : cat === "specular" ? "specular" : cat;

      assignments.push({
        textureName: texName,
        baseName,
        role,
        materialName,
      });
    }
  }

  mapping._meta = { rootBase: null, assignments, materialNames };
  return mapping;
}

/**
 * Find a texture entry whose base name matches.
 */
function findByBaseName(entries, targetBase) {
  for (const [baseName, tex] of entries) {
    if (baseName === targetBase) return tex;
  }
  return null;
}
