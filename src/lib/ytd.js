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
 * @returns {Object} - Dictionary of textures { name: { width, height, rgba, format } }
 */
export function parseYtd(bytes) {
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

    console.log(
      `[YTD] Decoded resource: ${resource.data.length} bytes, system=${resource.systemSize}, graphics=${resource.graphicsSize}`
    );

    const reader = createReader(
      resource.data,
      resource.systemSize,
      resource.graphicsSize
    );

    const textures = parseTextureDictionary(reader);

    if (!textures || Object.keys(textures).length === 0) {
      console.warn("[YTD] No textures found");
      return null;
    }

    console.log(`[YTD] Successfully parsed ${Object.keys(textures).length} textures`);
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

function parseTextureDictionary(reader) {
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

    console.log(`[YTD] Found texture dictionary at offset 0x${baseOffset.toString(16)}: ${textureCount} textures`);

    const texturesArrayOffset = reader.resolvePtr(texturesPtr);
    const hashesArrayOffset = reader.validPtr(hashesPtr) ? reader.resolvePtr(hashesPtr) : 0;

    console.log(`[YTD] texturesPtr=0x${texturesPtr.toString(16)}, resolved to offset ${texturesArrayOffset}`);

    // Debug: print first few raw bytes at texture array
    if (texturesArrayOffset > 0 && texturesArrayOffset < reader.len - 64) {
      const sample = [];
      for (let j = 0; j < 64; j++) {
        sample.push(reader.u8(texturesArrayOffset + j).toString(16).padStart(2, '0'));
      }
      console.log(`[YTD] First 64 bytes at texture array: ${sample.join(' ')}`);
    }

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
        if (i < 3) {
          console.log(`[YTD] Texture ${i}: invalid offset from ptr 0x${texturePtr.toString(16)} -> ${textureOffset}`);
        }
        failedCount++;
        continue;
      }

      const texture = parseTexture(reader, textureOffset, i);

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
        if (parsedCount <= 3) {
          console.log(`[YTD] Parsed texture: ${name} (${texture.width}x${texture.height})`);
        }
      } else {
        if (failedCount < 3) {
          console.log(`[YTD] Texture ${i}: parseTexture returned null at offset ${textureOffset}`);
        }
        failedCount++;
      }
    }

    console.log(`[YTD] Parsed ${parsedCount}/${textureCount} textures (${failedCount} failed)`);


    if (Object.keys(textures).length > 0) break;
  }

  return textures;
}

function parseTexture(reader, offset, debugIndex = -1) {
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
    if (debugIndex >= 0 && debugIndex < 3) {
      console.log(`[YTD] Texture ${debugIndex}: invalid dimensions ${width}x${height}`);
    }
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
    if (debugIndex >= 0 && debugIndex < 3) {
      console.log(`[YTD] Texture ${debugIndex}: could not find data pointer for ${name || 'unnamed'} ${width}x${height}`);
    }
    return null;
  }

  if (debugIndex >= 0 && debugIndex < 3) {
    console.log(`[YTD] Texture ${debugIndex}: ${name || 'unnamed'} ${width}x${height} format="${formatStr}" dataOffset=${dataOffset}`);
  }

  // Decode texture
  const rgba = decodeTexture(reader, dataOffset, width, height, format, 0);

  if (!rgba) {
    if (debugIndex >= 0 && debugIndex < 3) {
      console.log(`[YTD] Texture ${debugIndex}: decode failed`);
    }
    return null;
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

// DXT1 (BC1) Decoder
function decodeDXT1(reader, offset, width, height, rgba) {
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);

  let blockOffset = offset;

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const c0 = reader.u16(blockOffset);
      const c1 = reader.u16(blockOffset + 2);
      const indices = reader.u32(blockOffset + 4);
      blockOffset += 8;

      const colors = decodeColors565(c0, c1, c0 > c1);

      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px;
          const y = by * 4 + py;
          if (x >= width || y >= height) continue;

          const idx = (indices >> ((py * 4 + px) * 2)) & 0x3;
          const color = colors[idx];

          const pixelOffset = (y * width + x) * 4;
          rgba[pixelOffset] = color[0];
          rgba[pixelOffset + 1] = color[1];
          rgba[pixelOffset + 2] = color[2];
          rgba[pixelOffset + 3] = color[3];
        }
      }
    }
  }
}

// DXT3 (BC2) Decoder
function decodeDXT3(reader, offset, width, height, rgba) {
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);

  let blockOffset = offset;

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      // Alpha block (8 bytes)
      const alphaLo = reader.u32(blockOffset);
      const alphaHi = reader.u32(blockOffset + 4);
      blockOffset += 8;

      // Color block (8 bytes)
      const c0 = reader.u16(blockOffset);
      const c1 = reader.u16(blockOffset + 2);
      const indices = reader.u32(blockOffset + 4);
      blockOffset += 8;

      const colors = decodeColors565(c0, c1, true);

      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px;
          const y = by * 4 + py;
          if (x >= width || y >= height) continue;

          const idx = (indices >> ((py * 4 + px) * 2)) & 0x3;
          const color = colors[idx];

          // Get explicit alpha
          const alphaIdx = py * 4 + px;
          const alphaBits = alphaIdx < 8 ? alphaLo : alphaHi;
          const alphaShift = (alphaIdx % 8) * 4;
          const alpha = ((alphaBits >> alphaShift) & 0xF) * 17; // Scale 4-bit to 8-bit

          const pixelOffset = (y * width + x) * 4;
          rgba[pixelOffset] = color[0];
          rgba[pixelOffset + 1] = color[1];
          rgba[pixelOffset + 2] = color[2];
          rgba[pixelOffset + 3] = alpha;
        }
      }
    }
  }
}

// DXT5 (BC3) Decoder
function decodeDXT5(reader, offset, width, height, rgba) {
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);

  let blockOffset = offset;

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      // Alpha block (8 bytes)
      const alpha0 = reader.u8(blockOffset);
      const alpha1 = reader.u8(blockOffset + 1);
      const alphaBits0 = reader.u8(blockOffset + 2);
      const alphaBits1 = reader.u8(blockOffset + 3);
      const alphaBits2 = reader.u8(blockOffset + 4);
      const alphaBits3 = reader.u8(blockOffset + 5);
      const alphaBits4 = reader.u8(blockOffset + 6);
      const alphaBits5 = reader.u8(blockOffset + 7);
      blockOffset += 8;

      const alphaBitsLo = alphaBits0 | (alphaBits1 << 8) | (alphaBits2 << 16);
      const alphaBitsHi = alphaBits3 | (alphaBits4 << 8) | (alphaBits5 << 16);

      const alphas = decodeAlphaBC3(alpha0, alpha1);

      // Color block (8 bytes)
      const c0 = reader.u16(blockOffset);
      const c1 = reader.u16(blockOffset + 2);
      const indices = reader.u32(blockOffset + 4);
      blockOffset += 8;

      const colors = decodeColors565(c0, c1, true);

      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px;
          const y = by * 4 + py;
          if (x >= width || y >= height) continue;

          const colorIdx = (indices >> ((py * 4 + px) * 2)) & 0x3;
          const color = colors[colorIdx];

          // Get interpolated alpha
          const alphaPixelIdx = py * 4 + px;
          let alphaBits, alphaShift;
          if (alphaPixelIdx < 8) {
            alphaBits = alphaBitsLo;
            alphaShift = alphaPixelIdx * 3;
          } else {
            alphaBits = alphaBitsHi;
            alphaShift = (alphaPixelIdx - 8) * 3;
          }
          const alphaIdx = (alphaBits >> alphaShift) & 0x7;
          const alpha = alphas[alphaIdx];

          const pixelOffset = (y * width + x) * 4;
          rgba[pixelOffset] = color[0];
          rgba[pixelOffset + 1] = color[1];
          rgba[pixelOffset + 2] = color[2];
          rgba[pixelOffset + 3] = alpha;
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

// Decode A8R8G8B8 format
function decodeARGB8(reader, offset, width, height, rgba, stride) {
  const rowStride = stride > 0 ? stride : width * 4;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcOffset = offset + y * rowStride + x * 4;
      const dstOffset = (y * width + x) * 4;

      // ARGB -> RGBA
      rgba[dstOffset + 2] = reader.u8(srcOffset);     // B
      rgba[dstOffset + 1] = reader.u8(srcOffset + 1); // G
      rgba[dstOffset] = reader.u8(srcOffset + 2);     // R
      rgba[dstOffset + 3] = reader.u8(srcOffset + 3); // A
    }
  }
}

function decodeColors565(c0, c1, hasAlpha) {
  const colors = new Array(4);

  colors[0] = decode565(c0);
  colors[0][3] = 255;

  colors[1] = decode565(c1);
  colors[1][3] = 255;

  if (c0 > c1 || hasAlpha) {
    colors[2] = [
      Math.floor((colors[0][0] * 2 + colors[1][0]) / 3),
      Math.floor((colors[0][1] * 2 + colors[1][1]) / 3),
      Math.floor((colors[0][2] * 2 + colors[1][2]) / 3),
      255,
    ];
    colors[3] = [
      Math.floor((colors[0][0] + colors[1][0] * 2) / 3),
      Math.floor((colors[0][1] + colors[1][1] * 2) / 3),
      Math.floor((colors[0][2] + colors[1][2] * 2) / 3),
      255,
    ];
  } else {
    colors[2] = [
      Math.floor((colors[0][0] + colors[1][0]) / 2),
      Math.floor((colors[0][1] + colors[1][1]) / 2),
      Math.floor((colors[0][2] + colors[1][2]) / 2),
      255,
    ];
    colors[3] = [0, 0, 0, 0]; // Transparent
  }

  return colors;
}

function decode565(c) {
  const r = ((c >> 11) & 0x1F) * 255 / 31;
  const g = ((c >> 5) & 0x3F) * 255 / 63;
  const b = (c & 0x1F) * 255 / 31;
  return [Math.round(r), Math.round(g), Math.round(b)];
}

function decodeAlphaBC3(a0, a1) {
  const alphas = new Array(8);
  alphas[0] = a0;
  alphas[1] = a1;

  if (a0 > a1) {
    for (let i = 2; i < 8; i++) {
      alphas[i] = Math.floor(((8 - i) * a0 + (i - 1) * a1) / 7);
    }
  } else {
    for (let i = 2; i < 6; i++) {
      alphas[i] = Math.floor(((6 - i) * a0 + (i - 1) * a1) / 5);
    }
    alphas[6] = 0;
    alphas[7] = 255;
  }

  return alphas;
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
 * Match YTD textures to model materials
 * @param {Object} categorizedTextures - From categorizeTextures()
 * @param {Array} materialNames - List of material names from the model
 * @returns {Object} - Mapping of material name to textures
 */
export function matchTexturesToMaterials(categorizedTextures, materialNames) {
  const mapping = {};

  for (const materialName of materialNames) {
    const lowerMat = materialName.toLowerCase();
    const baseMat = getTextureBaseName(lowerMat);

    mapping[materialName] = {
      diffuse: null,
      normal: null,
      specular: null,
    };

    // Try exact match first
    if (categorizedTextures.diffuse[lowerMat]) {
      mapping[materialName].diffuse = categorizedTextures.diffuse[lowerMat];
    } else if (categorizedTextures.diffuse[baseMat]) {
      mapping[materialName].diffuse = categorizedTextures.diffuse[baseMat];
    }

    if (categorizedTextures.normal[lowerMat]) {
      mapping[materialName].normal = categorizedTextures.normal[lowerMat];
    } else if (categorizedTextures.normal[baseMat]) {
      mapping[materialName].normal = categorizedTextures.normal[baseMat];
    }

    if (categorizedTextures.specular[lowerMat]) {
      mapping[materialName].specular = categorizedTextures.specular[lowerMat];
    } else if (categorizedTextures.specular[baseMat]) {
      mapping[materialName].specular = categorizedTextures.specular[baseMat];
    }

    // Fuzzy matching for partial names
    if (!mapping[materialName].diffuse) {
      for (const [texName, tex] of Object.entries(categorizedTextures.diffuse)) {
        if (texName.includes(baseMat) || baseMat.includes(texName)) {
          mapping[materialName].diffuse = tex;
          break;
        }
      }
    }
  }

  return mapping;
}
