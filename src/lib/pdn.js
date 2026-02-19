import pako from "pako";

const PDN_MAGIC = [0x50, 0x44, 0x4e, 0x33]; // PDN3
const GZIP_ID1 = 0x1f;
const GZIP_ID2 = 0x8b;
const GZIP_CM_DEFLATE = 0x08;

const MIN_DIMENSION = 1;
const MAX_DIMENSION = 65536;
const MAX_DIMENSION_SCAN_BYTES = 1024 * 1024; // first 1MB is enough for metadata fields
const MAX_TRIM_BYTES = 128;
const MAX_PIXEL_COUNT = 64 * 1024 * 1024; // avoid runaway allocations

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function readU32LE(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) return 0;
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function isReasonableDimension(value) {
  return Number.isFinite(value) && value >= MIN_DIMENSION && value <= MAX_DIMENSION;
}

function isPlausibleDimensionPair(width, height) {
  if (!isReasonableDimension(width) || !isReasonableDimension(height)) return false;
  if (width * height > MAX_PIXEL_COUNT) return false;
  const ratio = width >= height ? width / Math.max(1, height) : height / Math.max(1, width);
  return ratio <= 64;
}

function isPowerOfTwo(value) {
  return value > 0 && (value & (value - 1)) === 0;
}

function asciiMatchesIgnoreCase(bytes, offset, textLower) {
  if (offset < 0 || offset + textLower.length > bytes.length) return false;
  for (let i = 0; i < textLower.length; i += 1) {
    let code = bytes[offset + i];
    if (code >= 65 && code <= 90) code += 32;
    if (code !== textLower.charCodeAt(i)) return false;
  }
  return true;
}

function findAsciiOffsets(bytes, text) {
  const out = [];
  const lower = text.toLowerCase();
  const end = Math.min(bytes.length - lower.length, MAX_DIMENSION_SCAN_BYTES);
  for (let i = 0; i <= end; i += 1) {
    if (asciiMatchesIgnoreCase(bytes, i, lower)) out.push(i);
  }
  return out;
}

function scoreDimensionValue(value, distanceFromToken = 0) {
  if (!isReasonableDimension(value)) return 0;
  let score = 1;
  if (isPowerOfTwo(value)) score += 2;
  if (value % 64 === 0) score += 1;
  if (value % 2 === 0) score += 0.5;
  score += Math.max(0, 1 - distanceFromToken / 64);
  return score;
}

function addMapScore(map, key, score) {
  if (!map.has(key)) map.set(key, 0);
  map.set(key, map.get(key) + score);
}

function collectDimensionsNearTokens(bytes, tokenOffsets) {
  const scoreMap = new Map();
  for (const tokenOffset of tokenOffsets) {
    const start = Math.max(0, tokenOffset - 24);
    const end = Math.min(bytes.length - 4, tokenOffset + 128);
    for (let off = start; off <= end; off += 1) {
      const value = readU32LE(bytes, off);
      if (!isReasonableDimension(value)) continue;
      const distance = Math.abs(off - tokenOffset);
      const score = scoreDimensionValue(value, distance);
      if (score > 0) addMapScore(scoreMap, value, score);
    }
  }
  return scoreMap;
}

function collectGenericDimensionPairs(bytes) {
  const pairs = [];
  const limit = Math.min(bytes.length - 8, MAX_DIMENSION_SCAN_BYTES);
  for (let i = 24; i <= limit; i += 1) {
    const a = readU32LE(bytes, i);
    const b = readU32LE(bytes, i + 4);
    if (!isPlausibleDimensionPair(a, b)) continue;
    let score = 0.1;
    if (isPowerOfTwo(a)) score += 0.2;
    if (isPowerOfTwo(b)) score += 0.2;
    if (a % 64 === 0) score += 0.1;
    if (b % 64 === 0) score += 0.1;
    pairs.push({ width: a, height: b, metadataScore: score });
  }
  return pairs;
}

function uniquePairKey(width, height) {
  return `${width}x${height}`;
}

function collectDimensionCandidates(bytes) {
  const candidates = [];
  const seen = new Set();

  const widthOffsets = findAsciiOffsets(bytes, "width");
  const heightOffsets = findAsciiOffsets(bytes, "height");
  const widthScores = collectDimensionsNearTokens(bytes, widthOffsets);
  const heightScores = collectDimensionsNearTokens(bytes, heightOffsets);

  const topValues = (map, maxCount = 20) =>
    Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxCount);

  const topWidths = topValues(widthScores, 24);
  const topHeights = topValues(heightScores, 24);

  for (const [width, wScore] of topWidths) {
    for (const [height, hScore] of topHeights) {
      if (!isPlausibleDimensionPair(width, height)) continue;
      const key = uniquePairKey(width, height);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        width,
        height,
        metadataScore: wScore + hScore,
      });
    }
  }

  const genericPairs = collectGenericDimensionPairs(bytes);
  for (const pair of genericPairs) {
    const key = uniquePairKey(pair.width, pair.height);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(pair);
  }

  candidates.sort((a, b) => (b.metadataScore || 0) - (a.metadataScore || 0));
  return candidates.slice(0, 256);
}

function isGzipHeaderAt(bytes, offset) {
  if (offset < 0 || offset + 3 > bytes.length) return false;
  return (
    bytes[offset] === GZIP_ID1 &&
    bytes[offset + 1] === GZIP_ID2 &&
    bytes[offset + 2] === GZIP_CM_DEFLATE
  );
}

function findGzipOffsets(bytes) {
  const offsets = [];
  for (let i = 24; i + 3 <= bytes.length; i += 1) {
    if (!isGzipHeaderAt(bytes, i)) continue;
    if (offsets.length > 0 && i - offsets[offsets.length - 1] < 8) continue;
    offsets.push(i);
  }
  return offsets;
}

function hashPayloadSignature(payload) {
  let hash = 2166136261;
  const mix = (byte) => {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  };

  const len = payload.length;
  const sampleFront = Math.min(256, len);
  const sampleBack = Math.min(256, Math.max(0, len - sampleFront));
  for (let i = 0; i < sampleFront; i += 1) mix(payload[i]);
  for (let i = len - sampleBack; i < len; i += 1) mix(payload[i]);
  mix((len >>> 0) & 0xff);
  mix((len >>> 8) & 0xff);
  mix((len >>> 16) & 0xff);
  mix((len >>> 24) & 0xff);

  return hash >>> 0;
}

function extractInflatedPayloads(bytes) {
  const offsets = findGzipOffsets(bytes);
  const payloads = [];
  const seen = new Set();

  for (const offset of offsets) {
    let inflated = null;
    try {
      inflated = pako.ungzip(bytes.subarray(offset));
    } catch {
      inflated = null;
    }
    if (!inflated || inflated.length === 0) continue;
    if (inflated.length % 4 !== 0) continue;
    if (inflated.length < 16) continue;

    const signature = `${inflated.length}:${hashPayloadSignature(inflated)}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    payloads.push(inflated);
  }

  return payloads;
}

function selectAlignedSegment(payload, rowBytes, maxTrim = MAX_TRIM_BYTES) {
  if (!payload || rowBytes <= 0) return null;
  if (payload.length < rowBytes) return null;

  const limit = Math.min(maxTrim, payload.length - 1);
  let best = null;

  for (let lead = 0; lead <= limit; lead += 1) {
    const usable = payload.length - lead;
    if (usable < rowBytes) continue;
    const remainder = usable % rowBytes;
    const trail = remainder;
    if (trail > limit) continue;

    const start = lead;
    const end = payload.length - trail;
    const len = end - start;
    if (len < rowBytes) continue;

    const rows = len / rowBytes;
    if (rows <= 0) continue;

    const discard = lead + trail;
    if (
      !best ||
      discard < best.discard ||
      (discard === best.discard && len > best.length)
    ) {
      best = { start, end, length: len, rows, discard };
    }
  }

  if (best) return best;

  if (payload.length % rowBytes === 0) {
    return {
      start: 0,
      end: payload.length,
      length: payload.length,
      rows: payload.length / rowBytes,
      discard: 0,
    };
  }

  return null;
}

function evaluateDimensionCandidate(payloads, width, height, metadataScore = 0) {
  if (!isPlausibleDimensionPair(width, height)) return null;
  const rowBytes = width * 4;
  const expectedSize = width * height * 4;
  if (!Number.isFinite(rowBytes) || rowBytes <= 0) return null;
  if (!Number.isFinite(expectedSize) || expectedSize <= 0) return null;

  let alignedPayloadCount = 0;
  let alignedBytes = 0;
  let totalBytes = 0;
  let discardedBytes = 0;
  let totalRows = 0;

  for (const payload of payloads) {
    totalBytes += payload.length;
    const segment = selectAlignedSegment(payload, rowBytes);
    if (!segment) continue;
    alignedPayloadCount += 1;
    alignedBytes += segment.length;
    discardedBytes += segment.discard;
    totalRows += segment.rows;
  }

  if (alignedPayloadCount === 0) return null;

  const coverage = totalRows / Math.max(1, height);
  const completeLayers = Math.floor(coverage);
  const alignmentRatio = alignedBytes / Math.max(1, totalBytes);
  const ratio = width >= height ? width / Math.max(1, height) : height / Math.max(1, width);
  const aspectPenalty = Math.max(0, ratio - 8) * 0.8;

  const score =
    metadataScore * 8 +
    completeLayers * 120 +
    Math.min(coverage, 4) * 24 +
    alignedPayloadCount * 2 +
    alignmentRatio * 40 -
    discardedBytes / 2048 -
    aspectPenalty;

  return {
    width,
    height,
    rowBytes,
    expectedSize,
    completeLayers,
    coverage,
    alignedPayloadCount,
    score,
  };
}

function makeByteQueue() {
  return {
    chunks: [],
    headIndex: 0,
    headOffset: 0,
    size: 0,
  };
}

function queuePush(queue, chunk) {
  if (!chunk || chunk.length === 0) return;
  queue.chunks.push(chunk);
  queue.size += chunk.length;
}

function queuePull(queue, count) {
  const out = new Uint8Array(count);
  let written = 0;

  while (written < count && queue.headIndex < queue.chunks.length) {
    const chunk = queue.chunks[queue.headIndex];
    const available = chunk.length - queue.headOffset;
    if (available <= 0) {
      queue.headIndex += 1;
      queue.headOffset = 0;
      continue;
    }
    const need = count - written;
    const take = Math.min(available, need);
    out.set(chunk.subarray(queue.headOffset, queue.headOffset + take), written);
    written += take;
    queue.headOffset += take;
    queue.size -= take;
    if (queue.headOffset >= chunk.length) {
      queue.headIndex += 1;
      queue.headOffset = 0;
    }
  }

  if (queue.headIndex > 64) {
    queue.chunks = queue.chunks.slice(queue.headIndex);
    queue.headIndex = 0;
  }

  return out;
}

function assembleLayers(payloads, width, height) {
  const rowBytes = width * 4;
  const expectedSize = width * height * 4;
  if (!rowBytes || !expectedSize) return [];

  const layers = [];
  const queue = makeByteQueue();

  for (const payload of payloads) {
    const segment = selectAlignedSegment(payload, rowBytes);
    if (!segment || segment.length <= 0) continue;
    queuePush(queue, payload.subarray(segment.start, segment.end));

    while (queue.size >= expectedSize) {
      layers.push(queuePull(queue, expectedSize));
    }
  }

  if (queue.size >= rowBytes) {
    const partial = queuePull(queue, queue.size);
    const padded = new Uint8Array(expectedSize);
    padded.set(partial.subarray(0, Math.min(partial.length, expectedSize)));
    layers.push(padded);
  }

  return layers;
}

function compositeBgraLayersToRgba(layers, width, height) {
  const pixelBytes = width * height * 4;
  const rgba = new Uint8Array(pixelBytes);

  for (const layer of layers) {
    if (!layer || layer.length === 0) continue;
    const len = Math.min(layer.length, pixelBytes);
    for (let i = 0; i + 3 < len; i += 4) {
      const dstR = rgba[i];
      const dstG = rgba[i + 1];
      const dstB = rgba[i + 2];
      const dstA = rgba[i + 3];

      const srcB = layer[i];
      const srcG = layer[i + 1];
      const srcR = layer[i + 2];
      const srcA = layer[i + 3];

      if (srcA === 0) continue;

      if (srcA === 255 || dstA === 0) {
        rgba[i] = srcR;
        rgba[i + 1] = srcG;
        rgba[i + 2] = srcB;
        rgba[i + 3] = srcA;
        continue;
      }

      const sa = srcA / 255;
      const da = dstA / 255;
      const outA = sa + da * (1 - sa);
      if (outA <= 0) continue;

      rgba[i] = clamp(Math.round((srcR * sa + dstR * da * (1 - sa)) / outA), 0, 255);
      rgba[i + 1] = clamp(Math.round((srcG * sa + dstG * da * (1 - sa)) / outA), 0, 255);
      rgba[i + 2] = clamp(Math.round((srcB * sa + dstB * da * (1 - sa)) / outA), 0, 255);
      rgba[i + 3] = clamp(Math.round(outA * 255), 0, 255);
    }
  }

  return rgba;
}

function selectBestDimension(payloads, dimensionCandidates) {
  const scored = [];
  for (const candidate of dimensionCandidates) {
    const evalResult = evaluateDimensionCandidate(
      payloads,
      candidate.width,
      candidate.height,
      candidate.metadataScore || 0,
    );
    if (evalResult) scored.push(evalResult);

    // Handle occasional width/height inversion in BinaryFormatter extraction.
    if (candidate.width !== candidate.height) {
      const swapped = evaluateDimensionCandidate(
        payloads,
        candidate.height,
        candidate.width,
        (candidate.metadataScore || 0) * 0.9,
      );
      if (swapped) scored.push(swapped);
    }
  }

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);
  return scored[0];
}

function fallbackDimensionsFromPayload(payloads) {
  if (!payloads || payloads.length === 0) return null;
  const largest = payloads.reduce((best, cur) => (cur.length > best.length ? cur : best), payloads[0]);
  const pixelCount = Math.floor(largest.length / 4);
  if (pixelCount <= 0) return null;

  const commonWidths = [
    64, 96, 128, 192, 256, 320, 384, 512, 640, 768, 800, 960, 1024, 1280, 1536, 1600,
    1920, 2048, 2560, 3072, 3200, 3840, 4096, 5120, 6144, 7680, 8192,
  ];

  let best = null;
  const consider = (width, height, scoreBase = 0) => {
    if (!isPlausibleDimensionPair(width, height)) return;
    if (width * height > pixelCount) return;
    const ratio = width >= height ? width / Math.max(1, height) : height / Math.max(1, width);
    const score = scoreBase - Math.abs(Math.log2(ratio));
    if (!best || score > best.score) {
      best = { width, height, score };
    }
  };

  for (const width of commonWidths) {
    if (pixelCount % width !== 0) continue;
    consider(width, pixelCount / width, 2);
  }

  const side = Math.floor(Math.sqrt(pixelCount));
  for (let delta = 0; delta <= 256; delta += 1) {
    const wA = side - delta;
    const wB = side + delta;
    if (wA > 0 && pixelCount % wA === 0) consider(wA, pixelCount / wA, 1.5);
    if (wB > 0 && pixelCount % wB === 0) consider(wB, pixelCount / wB, 1.5);
    if (best && delta > 32) break;
  }

  if (best) {
    return { width: best.width, height: best.height };
  }

  if (side > 0) {
    return { width: side, height: Math.max(1, Math.floor(pixelCount / side)) };
  }
  return null;
}

export function isPdnFile(bytes) {
  if (!bytes || bytes.length < 4) return false;
  return (
    bytes[0] === PDN_MAGIC[0] &&
    bytes[1] === PDN_MAGIC[1] &&
    bytes[2] === PDN_MAGIC[2] &&
    bytes[3] === PDN_MAGIC[3]
  );
}

export function decodePdn(bytes) {
  if (!isPdnFile(bytes)) return null;

  const payloads = extractInflatedPayloads(bytes);
  if (payloads.length === 0) return null;

  const dimensionCandidates = collectDimensionCandidates(bytes);
  let best = selectBestDimension(payloads, dimensionCandidates);

  if (!best) {
    const fallback = fallbackDimensionsFromPayload(payloads);
    if (!fallback) return null;
    const evaluated = evaluateDimensionCandidate(payloads, fallback.width, fallback.height, 0);
    if (!evaluated) return null;
    best = evaluated;
  }

  const layers = assembleLayers(payloads, best.width, best.height);
  if (layers.length === 0) return null;

  const rgba = compositeBgraLayersToRgba(layers, best.width, best.height);
  return {
    width: best.width,
    height: best.height,
    data: rgba,
  };
}

export function parsePdn(bytes) {
  return decodePdn(bytes);
}
