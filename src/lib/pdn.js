/**
 * PDN (Paint.NET) File Parser for Cortex Studio.
 *
 * Supports Paint.NET .pdn files by parsing the .NET BinaryFormatter
 * serialization stream to extract layer pixel data (BGRA32) and compositing
 * into a final RGBA image.
 *
 * Format overview:
 *   - Magic: "PDN3" (0x50 0x44 0x4E 0x33)
 *   - 20-byte header (magic + 16 bytes)
 *   - .NET BinaryFormatter stream containing Document → LayerList → BitmapLayer → Surface
 *   - Pixel data is stored in gzip-compressed chunks (BGRA32)
 *
 * Strategy:
 *   1. Validate PDN3 magic
 *   2. Parse header to extract document dimensions
 *   3. Locate gzip-compressed chunks by scanning for 0x1F 0x8B signatures
 *   4. Decompress each chunk and assemble BGRA pixel strips
 *   5. Composite layers with alpha blending into final RGBA output
 */

import pako from "pako";

/* ─── Constants ─── */
const PDN_MAGIC = [0x50, 0x44, 0x4e, 0x33]; // "PDN3"
const GZIP_MAGIC = [0x1f, 0x8b];

/* ─── Public API ─── */

/**
 * Detect if bytes start with the PDN3 magic.
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function isPdnFile(bytes) {
  if (!bytes || bytes.length < 4) return false;
  return (
    bytes[0] === PDN_MAGIC[0] &&
    bytes[1] === PDN_MAGIC[1] &&
    bytes[2] === PDN_MAGIC[2] &&
    bytes[3] === PDN_MAGIC[3]
  );
}

/**
 * Parse a Paint.NET .pdn file and return the flattened RGBA image.
 * @param {Uint8Array} bytes  Raw file bytes
 * @returns {{ width: number, height: number, data: Uint8Array } | null}
 *   data is RGBA, row-major, top-to-bottom
 */
export function parsePdn(bytes) {
  if (!isPdnFile(bytes)) return null;

  // ─── Parse header ───
  // PDN3 header: 4 bytes magic + 3x 24-bit LE integers (custom header varies by version)
  // We extract dimensions from the serialized .NET stream instead.
  const dims = extractDimensions(bytes);
  if (!dims) return null;

  const { width, height } = dims;
  if (width <= 0 || height <= 0 || width > 65536 || height > 65536) return null;

  // ─── Find and decompress all gzip chunks ───
  const chunks = findGzipChunks(bytes);
  if (chunks.length === 0) return null;

  // ─── Decode layers from chunks ───
  const layers = decodeLayers(chunks, width, height);
  if (layers.length === 0) return null;

  // ─── Composite layers ───
  const rgba = compositeLayers(layers, width, height);
  return { width, height, data: rgba };
}

/* ─── Internal: Dimension extraction ─── */

/**
 * Scan the .NET serialization stream for width/height fields.
 * The Document contains "width" and "height" as Int32 fields.
 * We look for the serialized field names followed by their values.
 */
function extractDimensions(bytes) {
  // Strategy 1: Scan for the strings "width" and "height" in the binary stream
  // .NET BinaryFormatter writes field names as length-prefixed strings
  let width = 0;
  let height = 0;

  // Search for "width" field (lowercase, as stored in PdnLib.Document)
  const widthIdx = findStringInBytes(bytes, "width");
  const heightIdx = findStringInBytes(bytes, "height");

  if (widthIdx >= 0 && heightIdx >= 0) {
    // The Int32 value follows after the field name + type info
    // In .NET BinaryFormatter, after the field name reference, the value is written.
    // We scan forward from the found position for a reasonable Int32 value
    width = scanForDimension(bytes, widthIdx);
    height = scanForDimension(bytes, heightIdx);
  }

  // Strategy 2: If we found gzip chunks, infer dimensions from the first decompressed chunk
  // PDN stores pixel data as horizontal strips; the strip width equals image width.
  if (width <= 0 || height <= 0) {
    const firstChunk = findGzipChunks(bytes, 1);
    if (firstChunk.length > 0) {
      const decompressed = tryInflate(bytes, firstChunk[0].offset);
      if (decompressed && decompressed.length >= 4) {
        // Each pixel is 4 bytes (BGRA). The strip width must divide evenly.
        // Common PDN strip height is typically matched to scanlines.
        // Try to detect width from chunk size heuristic.
        const pixelCount = decompressed.length / 4;
        // Try common power-of-2 widths
        for (const candidateW of [4096, 2048, 1024, 512, 256, 128, 64]) {
          if (pixelCount % candidateW === 0) {
            width = candidateW;
            break;
          }
        }
        if (width <= 0 && pixelCount > 0) {
          // Fallback: guess square
          const sq = Math.sqrt(pixelCount);
          if (Number.isInteger(sq)) {
            width = sq;
          }
        }
      }
    }

    // If we have width but not height, compute from total decompressed pixels
    if (width > 0 && height <= 0) {
      const allChunks = findGzipChunks(bytes);
      let totalPixels = 0;
      for (const chunk of allChunks) {
        const inflated = tryInflate(bytes, chunk.offset);
        if (inflated) {
          totalPixels += inflated.length / 4;
        }
      }
      if (totalPixels > 0 && totalPixels % width === 0) {
        // totalPixels might be for multiple layers
        const rawHeight = totalPixels / width;
        // PDN stores each layer separately, so divide by number of layers
        // We'll just use the first layer's data to determine height
        const firstInflated = tryInflate(bytes, allChunks[0].offset);
        if (firstInflated) {
          const firstPixels = firstInflated.length / 4;
          if (firstPixels % width === 0) {
            height = firstPixels / width;
          }
        }
      }
    }
  }

  // Strategy 3: Look for two consecutive Int32 values that look like dimensions
  // This is a fallback scanning for reasonable dimension pairs
  if (width <= 0 || height <= 0) {
    const result = scanForDimensionPair(bytes);
    if (result) {
      width = result.width;
      height = result.height;
    }
  }

  if (width > 0 && height > 0) return { width, height };
  return null;
}

/**
 * Find a length-prefixed .NET string in the byte stream.
 * .NET BinaryFormatter writes strings as: length (7-bit encoded int) + UTF8 bytes
 */
function findStringInBytes(bytes, target) {
  const targetBytes = new TextEncoder().encode(target);
  const targetLen = targetBytes.length;

  for (let i = 0; i < bytes.length - targetLen - 1; i++) {
    // Check if this position has a length prefix matching our target
    if (bytes[i] === targetLen) {
      let match = true;
      for (let j = 0; j < targetLen; j++) {
        if (bytes[i + 1 + j] !== targetBytes[j]) {
          match = false;
          break;
        }
      }
      if (match) return i;
    }
  }
  return -1;
}

/**
 * Scan forward from a position to find a reasonable dimension value (Int32).
 */
function scanForDimension(bytes, fromIdx) {
  // Scan up to 32 bytes ahead for an Int32 that looks like a dimension
  for (let off = fromIdx; off < Math.min(fromIdx + 64, bytes.length - 4); off++) {
    const val = readInt32LE(bytes, off);
    if (val >= 1 && val <= 65536) {
      // Check if this is a power of 2 or common texture size - more likely to be a dimension
      if (isPowerOfTwo(val) || val % 64 === 0 || val % 100 === 0) {
        return val;
      }
    }
  }
  // Broader scan: any reasonable value
  for (let off = fromIdx; off < Math.min(fromIdx + 64, bytes.length - 4); off++) {
    const val = readInt32LE(bytes, off);
    if (val >= 16 && val <= 65536) {
      return val;
    }
  }
  return 0;
}

/**
 * Scan for two consecutive Int32 values that look like image dimensions.
 */
function scanForDimensionPair(bytes) {
  // PDN documents typically have width/height stored near each other
  for (let i = 24; i < Math.min(bytes.length - 8, 4096); i++) {
    const a = readInt32LE(bytes, i);
    const b = readInt32LE(bytes, i + 4);
    if (a >= 16 && a <= 16384 && b >= 16 && b <= 16384) {
      // Both look like reasonable dimensions
      if ((isPowerOfTwo(a) || a % 64 === 0) && (isPowerOfTwo(b) || b % 64 === 0)) {
        return { width: a, height: b };
      }
    }
  }
  return null;
}

/* ─── Internal: Gzip chunk scanning ─── */

/**
 * Find gzip-compressed chunks within the byte stream.
 * @param {Uint8Array} bytes
 * @param {number} [maxChunks] Maximum chunks to find
 * @returns {Array<{offset: number}>}
 */
function findGzipChunks(bytes, maxChunks = Infinity) {
  const chunks = [];
  for (let i = 24; i < bytes.length - 2; i++) {
    if (bytes[i] === GZIP_MAGIC[0] && bytes[i + 1] === GZIP_MAGIC[1]) {
      // Verify it's a valid gzip header (check method byte)
      if (i + 2 < bytes.length && bytes[i + 2] === 0x08) {
        chunks.push({ offset: i });
        if (chunks.length >= maxChunks) break;

        // Skip ahead past this gzip stream to avoid finding sub-offsets
        // Minimum gzip overhead is ~18 bytes
        i += 18;
      }
    }
  }
  return chunks;
}

/**
 * Try to inflate (decompress) gzip data starting at offset.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {Uint8Array|null}
 */
function tryInflate(bytes, offset) {
  try {
    const slice = bytes.subarray(offset);
    return pako.ungzip(slice);
  } catch {
    // Try inflate (raw deflate, no gzip header) as fallback
    try {
      return pako.inflate(bytes.subarray(offset + 10)); // Skip gzip header
    } catch {
      return null;
    }
  }
}

/* ─── Internal: Layer decoding ─── */

/**
 * Decode BGRA pixel layers from decompressed chunks.
 * PDN stores each layer's pixel data as a series of gzip-compressed strips.
 * Each strip contains raw BGRA32 pixel data for a band of scanlines.
 *
 * @param {Array<{offset: number}>} chunks
 * @param {number} width
 * @param {number} height
 * @returns {Array<Uint8Array>} Array of BGRA pixel buffers, one per layer
 */
function decodeLayers(chunks, width, height) {
  const expectedSize = width * height * 4;
  const layers = [];
  let currentLayer = [];
  let currentSize = 0;

  for (const chunk of chunks) {
    const inflated = tryInflate(
      /* We need the original bytes — pass them by closing over parsePdn's scope */
      chunk._bytes || chunk.bytes,
      chunk.offset,
    );
    if (!inflated || inflated.length === 0) continue;

    currentLayer.push(inflated);
    currentSize += inflated.length;

    // If we've accumulated enough data for one layer, save it
    if (currentSize >= expectedSize) {
      const layerData = mergeChunks(currentLayer, expectedSize);
      if (layerData) layers.push(layerData);
      currentLayer = [];
      currentSize = 0;
    }
  }

  // Handle remaining data as a partial/final layer
  if (currentLayer.length > 0 && currentSize > 0) {
    const layerData = mergeChunks(currentLayer, Math.min(currentSize, expectedSize));
    if (layerData) layers.push(layerData);
  }

  return layers;
}

/**
 * Merge multiple Uint8Arrays into a single buffer, truncated to maxSize.
 */
function mergeChunks(chunks, maxSize) {
  const merged = new Uint8Array(maxSize);
  let offset = 0;
  for (const chunk of chunks) {
    const remaining = maxSize - offset;
    if (remaining <= 0) break;
    const toCopy = Math.min(chunk.length, remaining);
    merged.set(chunk.subarray(0, toCopy), offset);
    offset += toCopy;
  }
  return offset > 0 ? merged : null;
}

/* ─── Internal: Layer compositing ─── */

/**
 * Composite BGRA layers into a final RGBA image.
 * Layers are composited bottom-to-top with standard alpha blending.
 *
 * @param {Array<Uint8Array>} layers  BGRA pixel data per layer
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array} RGBA pixel data
 */
function compositeLayers(layers, width, height) {
  const pixelCount = width * height;
  const rgba = new Uint8Array(pixelCount * 4);

  // Start with transparent background
  for (const layer of layers) {
    const bgraLen = Math.min(layer.length, pixelCount * 4);

    for (let i = 0; i < bgraLen; i += 4) {
      const pixIdx = (i / 4) * 4;
      if (pixIdx + 3 >= rgba.length) break;

      // BGRA → extract components
      const srcB = layer[i];
      const srcG = layer[i + 1];
      const srcR = layer[i + 2];
      const srcA = layer[i + 3];

      if (srcA === 0) continue;

      const dstR = rgba[pixIdx];
      const dstG = rgba[pixIdx + 1];
      const dstB = rgba[pixIdx + 2];
      const dstA = rgba[pixIdx + 3];

      if (srcA === 255 || dstA === 0) {
        // Fully opaque source or transparent destination: direct copy
        rgba[pixIdx] = srcR;
        rgba[pixIdx + 1] = srcG;
        rgba[pixIdx + 2] = srcB;
        rgba[pixIdx + 3] = srcA;
      } else {
        // Alpha blending: src over dst
        const sa = srcA / 255;
        const da = dstA / 255;
        const outA = sa + da * (1 - sa);
        if (outA > 0) {
          rgba[pixIdx] = Math.round((srcR * sa + dstR * da * (1 - sa)) / outA);
          rgba[pixIdx + 1] = Math.round((srcG * sa + dstG * da * (1 - sa)) / outA);
          rgba[pixIdx + 2] = Math.round((srcB * sa + dstB * da * (1 - sa)) / outA);
          rgba[pixIdx + 3] = Math.round(outA * 255);
        }
      }
    }
  }

  return rgba;
}

/* ─── Internal: Helpers ─── */

function readInt32LE(bytes, offset) {
  if (offset + 4 > bytes.length) return 0;
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0; // unsigned
}

function isPowerOfTwo(n) {
  return n > 0 && (n & (n - 1)) === 0;
}

/**
 * High-level: parse a PDN file and return the flattened RGBA image,
 * with the gzip chunk references patched so decodeLayers can access the raw bytes.
 * This is the main entry point intended for external use.
 *
 * @param {Uint8Array} bytes  Raw .pdn file bytes
 * @returns {{ width: number, height: number, data: Uint8Array } | null}
 */
export function decodePdn(bytes) {
  if (!isPdnFile(bytes)) return null;

  const dims = extractDimensions(bytes);
  if (!dims) return null;

  const { width, height } = dims;
  if (width <= 0 || height <= 0 || width > 65536 || height > 65536) return null;

  const chunks = findGzipChunks(bytes);
  if (chunks.length === 0) return null;

  // Attach bytes reference to each chunk so decodeLayers can access the source
  for (const chunk of chunks) {
    chunk._bytes = bytes;
    chunk.bytes = bytes;
  }

  const layers = decodeLayers(chunks, width, height);
  if (layers.length === 0) return null;

  const rgba = compositeLayers(layers, width, height);
  return { width, height, data: rgba };
}
