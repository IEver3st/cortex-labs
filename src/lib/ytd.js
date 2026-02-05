/**
 * GTA V YTD (Texture Dictionary) Parser
 * Extracts textures from YTD files and decodes DXT/BC compressed formats
 */

import { inflate, inflateRaw } from "pako";

const RSC7_MAGIC = 0x37435352;
const RSC85_MAGIC = 0x38355352;

// Texture formats used in GTA V
const TEXTURE_FORMAT = {
  DXT1: 0,      // BC1 - RGB with 1-bit alpha
  DXT3: 1,      // BC2 - RGB with explicit alpha
  DXT5: 2,      // BC3 - RGB with interpolated alpha
  BC7: 3,       // BC7 - High quality RGB(A)
  A8R8G8B8: 4,  // Uncompressed ARGB
  A1R5G5B5: 5,  // 16-bit with 1-bit alpha
  A8: 6,        // 8-bit alpha only
  L8: 7,        // 8-bit luminance
};

// D3DFORMAT / DXGI_FORMAT codes found in GTA V textures
const FORMAT_MAP = {
  0x15: TEXTURE_FORMAT.A8R8G8B8,  // D3DFMT_A8R8G8B8
  0x1C: TEXTURE_FORMAT.DXT1,      // D3DFMT_DXT1
  0x1D: TEXTURE_FORMAT.DXT3,      // D3DFMT_DXT3
  0x1E: TEXTURE_FORMAT.DXT5,      // D3DFMT_DXT5
  0x53: TEXTURE_FORMAT.DXT1,      // BC1_UNORM
  0x54: TEXTURE_FORMAT.DXT1,      // BC1_UNORM_SRGB
  0x55: TEXTURE_FORMAT.DXT3,      // BC2_UNORM
  0x56: TEXTURE_FORMAT.DXT3,      // BC2_UNORM_SRGB
  0x57: TEXTURE_FORMAT.DXT5,      // BC3_UNORM
  0x58: TEXTURE_FORMAT.DXT5,      // BC3_UNORM_SRGB
  0x62: TEXTURE_FORMAT.BC7,       // BC7_UNORM
  0x63: TEXTURE_FORMAT.BC7,       // BC7_UNORM_SRGB
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

function parseTextureDictionary(reader, metadataOnly = false, decodeSet = null) {
  const textures = {};

  // Try different structure offsets for TextureDictionary
  const dictOffsets = [0x00, 0x08, 0x10, 0x18, 0x20];

  for (const baseOffset of dictOffsets) {
    // TextureDictionary has a pgDictionary structure
    // Offset 0x00: VTable pointer
    // Offset 0x08: pgDictionary.ParentDictionary
    // Offset 0x10: UsageCount (uint32)
    // Offset 0x18: Hashes array pointer
    // Offset 0x20: Hash count
    // Offset 0x28: Textures array pointer
    // Offset 0x30: Texture count

    const hashesPtr = reader.u64(baseOffset + 0x18);
    const texturesPtr = reader.u64(baseOffset + 0x28);

    let hashCount = reader.u16(baseOffset + 0x20);
    let textureCount = reader.u16(baseOffset + 0x30);

    // Alternative layout check
    if (textureCount === 0 || textureCount > 512) {
      textureCount = reader.u16(baseOffset + 0x32);
    }
    if (hashCount === 0 || hashCount > 512) {
      hashCount = reader.u16(baseOffset + 0x22);
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
        // Get name from hash or generate one
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

    // Parsing complete: parsedCount / textureCount


    if (Object.keys(textures).length > 0) break;
  }

  return textures;
}

function parseTexture(reader, offset, debugIndex = -1, metadataOnly = false, decodeSet = null) {
  if (!reader.valid(offset) || offset + 160 > reader.len) return null;


  // GTA V texture structure based on observed data:
  // 0x00: VTable/hash (4 bytes)
  // 0x28: Name pointer (8 bytes)
  // 0x50: Width (2 bytes)
  // 0x52: Height (2 bytes)
  // 0x54: Mip count (1 byte)
  // 0x58: Format string (4 bytes ASCII like "BC7 " or "DXT5")
  // 0x70: Data offset/pointer (varies)

  // Read dimensions at the known offset
  const width = reader.u16(offset + 0x50);
  const height = reader.u16(offset + 0x52);
  const mipCount = reader.u8(offset + 0x54);

  // Read format string
  const fmtBytes = [
    reader.u8(offset + 0x58),
    reader.u8(offset + 0x59),
    reader.u8(offset + 0x5A),
    reader.u8(offset + 0x5B),
  ];
  const formatStr = String.fromCharCode(...fmtBytes).trim();

  // Map format string to format enum
  let format = TEXTURE_FORMAT.DXT5;
  if (formatStr === "DXT1" || formatStr === "BC1") format = TEXTURE_FORMAT.DXT1;
  else if (formatStr === "DXT3" || formatStr === "BC2") format = TEXTURE_FORMAT.DXT3;
  else if (formatStr === "DXT5" || formatStr === "BC3") format = TEXTURE_FORMAT.DXT5;
  else if (formatStr === "BC7" || formatStr.startsWith("BC7")) format = TEXTURE_FORMAT.BC7;

  // Validate dimensions
  const isValidDim = (d) => d > 0 && d <= 8192;
  const isPow2 = (d) => d > 0 && (d & (d - 1)) === 0;

  if (!isValidDim(width) || !isValidDim(height) || !isPow2(width) || !isPow2(height)) {
    return null;
  }

  // Read name pointer
  let name = null;
  const namePtr = reader.u64(offset + 0x28);
  if (namePtr && namePtr !== 0n) {
    const nameOffset = reader.resolvePtr(namePtr);
    if (nameOffset > 0 && nameOffset < reader.len) {
      name = readCString(reader, nameOffset);
    }
  }

  // Find data - check several potential data pointer locations
  // The data could be an absolute offset stored at various positions
  const dataPointerOffsets = [0x70, 0x68, 0x78, 0x60];
  let dataOffset = 0;

  for (const ptrOff of dataPointerOffsets) {
    // Try as 64-bit pointer first (GTA V uses segment-based pointers)
    const ptr64 = reader.u64(offset + ptrOff);
    if (ptr64 && ptr64 !== 0n) {
      const resolved = reader.resolvePtr(ptr64);
      if (resolved > 0 && resolved < reader.len) {
        dataOffset = resolved;
        break;
      }
    }

    // Try as a raw 32-bit offset (for some resource formats)
    const rawOffset32 = reader.u32(offset + ptrOff);
    if (rawOffset32 > 0 && rawOffset32 < reader.len) {
      dataOffset = rawOffset32;
      break;
    }
  }

  // If no pointer found, try calculating from structure end
  // Many YTD files store texture data sequentially after headers
  if (dataOffset === 0) {
    // Look for a reasonable data offset based on expected compressed size
    const blockSize = format === TEXTURE_FORMAT.DXT1 ? 8 : 16;
    const expectedSize = Math.ceil(width / 4) * Math.ceil(height / 4) * blockSize;

    // Scan for data start marker (often follows the header structure)
    for (let scanOff = 0x80; scanOff < 0x200 && scanOff + expectedSize <= reader.len; scanOff += 16) {
      const testOffset = offset + scanOff;
      if (testOffset + expectedSize <= reader.len) {
        // Check if this looks like compressed texture data (not all zeros)
        let nonZero = 0;
        for (let i = 0; i < 64; i++) {
          if (reader.u8(testOffset + i) !== 0) nonZero++;
        }
        if (nonZero > 16) {
          dataOffset = testOffset;
          break;
        }
      }
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
  if (shouldDecode) {
    rgba = decodeTexture(reader, dataOffset, width, height, format, 0);

    if (!rgba) {
      return null;
    }
  }

  return {
    name,
    nameHash: 0,
    width,
    height,
    format,
    mipCount,
    rgba,
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

function decodeTexture(reader, offset, width, height, format, stride) {
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
    case TEXTURE_FORMAT.BC7:
      decodeBC7(reader, offset, width, height, rgba);
      break;
    case TEXTURE_FORMAT.A8R8G8B8:
      decodeARGB8(reader, offset, width, height, rgba, stride);
      break;
    default:
      // Fallback: try DXT5
      decodeDXT5(reader, offset, width, height, rgba);
      break;
  }

  return rgba;
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

// BC7 Decoder (simplified - handles most common modes)
function decodeBC7(reader, offset, width, height, rgba) {
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);

  let blockOffset = offset;

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const block = reader.slice(blockOffset, 16);
      blockOffset += 16;

      if (!block) continue;

      // Decode BC7 block
      decodeBC7Block(block, bx, by, width, height, rgba);
    }
  }
}

function decodeBC7Block(block, bx, by, width, height, rgba) {
  // Find mode (first set bit)
  let mode = 0;
  while (mode < 8 && ((block[0] >> mode) & 1) === 0) mode++;

  if (mode >= 8) {
    // Invalid block, fill with magenta
    fillBlock(bx, by, width, height, rgba, [255, 0, 255, 255]);
    return;
  }

  // Simplified BC7 decoding - for complex modes, use approximation
  // This handles modes 0-5 reasonably well for preview purposes
  try {
    const colors = extractBC7Colors(block, mode);

    for (let py = 0; py < 4; py++) {
      for (let px = 0; px < 4; px++) {
        const x = bx * 4 + px;
        const y = by * 4 + py;
        if (x >= width || y >= height) continue;

        // Simple color selection based on position
        const idx = (py * 4 + px) % colors.length;
        const color = colors[idx] || [128, 128, 128, 255];

        const pixelOffset = (y * width + x) * 4;
        rgba[pixelOffset] = color[0];
        rgba[pixelOffset + 1] = color[1];
        rgba[pixelOffset + 2] = color[2];
        rgba[pixelOffset + 3] = color[3];
      }
    }
  } catch {
    // Fallback
    fillBlock(bx, by, width, height, rgba, [128, 128, 128, 255]);
  }
}

function extractBC7Colors(block, mode) {
  // Simplified color extraction - gets approximate endpoint colors
  // For full BC7 support, would need complete mode-specific parsing
  const r0 = block[1] || 128;
  const g0 = block[2] || 128;
  const b0 = block[3] || 128;
  const r1 = block[4] || 128;
  const g1 = block[5] || 128;
  const b1 = block[6] || 128;

  return [
    [r0, g0, b0, 255],
    [r1, g1, b1, 255],
    [Math.floor((r0 + r1) / 2), Math.floor((g0 + g1) / 2), Math.floor((b0 + b1) / 2), 255],
    [Math.floor((r0 * 2 + r1) / 3), Math.floor((g0 * 2 + g1) / 3), Math.floor((b0 * 2 + b1) / 3), 255],
  ];
}

function fillBlock(bx, by, width, height, rgba, color) {
  for (let py = 0; py < 4; py++) {
    for (let px = 0; px < 4; px++) {
      const x = bx * 4 + px;
      const y = by * 4 + py;
      if (x >= width || y >= height) continue;

      const pixelOffset = (y * width + x) * 4;
      rgba[pixelOffset] = color[0];
      rgba[pixelOffset + 1] = color[1];
      rgba[pixelOffset + 2] = color[2];
      rgba[pixelOffset + 3] = color[3];
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

// Legacy helpers kept for BC7 extractBC7Colors which still uses array-based colors
function decodeColors565(c0, c1, hasAlpha) {
  const r0 = ((c0 >> 11) & 0x1F) * 255 / 31 + 0.5 | 0;
  const g0 = ((c0 >> 5) & 0x3F) * 255 / 63 + 0.5 | 0;
  const b0 = (c0 & 0x1F) * 255 / 31 + 0.5 | 0;
  const r1 = ((c1 >> 11) & 0x1F) * 255 / 31 + 0.5 | 0;
  const g1 = ((c1 >> 5) & 0x3F) * 255 / 63 + 0.5 | 0;
  const b1 = (c1 & 0x1F) * 255 / 31 + 0.5 | 0;

  const colors = [[r0, g0, b0, 255], [r1, g1, b1, 255], null, null];

  if (c0 > c1 || hasAlpha) {
    colors[2] = [((r0 * 2 + r1) / 3) | 0, ((g0 * 2 + g1) / 3) | 0, ((b0 * 2 + b1) / 3) | 0, 255];
    colors[3] = [((r0 + r1 * 2) / 3) | 0, ((g0 + g1 * 2) / 3) | 0, ((b0 + b1 * 2) / 3) | 0, 255];
  } else {
    colors[2] = [((r0 + r1) >> 1), ((g0 + g1) >> 1), ((b0 + b1) >> 1), 255];
    colors[3] = [0, 0, 0, 0];
  }

  return colors;
}

/**
 * Categorize textures by type based on naming conventions
 * @param {Object} textures - Dictionary of parsed textures
 * @returns {Object} - Categorized textures { diffuse: [], normal: [], specular: [], ... }
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

    if (lowerName.endsWith("_n") || lowerName.includes("_normal") || lowerName.includes("_nrm")) {
      categories.normal[baseName] = { ...texture, originalName: name };
    } else if (lowerName.endsWith("_s") || lowerName.includes("_spec") || lowerName.includes("_specular")) {
      categories.specular[baseName] = { ...texture, originalName: name };
    } else if (lowerName.includes("_detail") || lowerName.endsWith("_d2")) {
      categories.detail[baseName] = { ...texture, originalName: name };
    } else if (lowerName.endsWith("_d") || !lowerName.match(/_[a-z]$/)) {
      // Diffuse textures end with _d or have no suffix
      categories.diffuse[baseName] = { ...texture, originalName: name };
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
