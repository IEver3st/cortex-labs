/**
 * Livery textures as Cortex writes them into a vehicle's texture dictionary:
 * the user's image fitted to the size that dictionary keeps its liveries at,
 * with a mip chain, as DXT5. A DDS the user exported at exactly that size
 * goes in untouched, so their own compression choice (BC7, mip count) stands.
 * Pure, so it runs in Node tests and in the livery worker alike.
 */

import { parseDDSHeader } from "./dds-decode.js";
import { encodeDxt5, mipLevelSizes, writeDds } from "./dds-encode.js";

// A user's DDS that already has the size a dictionary needs goes in as it is
// when it is a format GTA texture dictionaries hold.
function keepsAsIs(header) {
  if (["DXT1", "DXT3", "DXT5", "BC7", "BGRA"].includes(header.fmt)) return true;
  const masks = header.layout?.masks || [];
  return header.fmt === "MASKED" && header.layout.bitCount === 32
    && masks[0] === 0x00ff0000 && masks[1] === 0x0000ff00 && masks[2] === 0x000000ff && masks[3] === 0xff000000;
}

// The header is checked only as far as its first level; a DDS going in as it
// is must also hold every mip level it declares, or the bridge reads past its end.
function holdsEveryLevel(bytes, header) {
  const count = Math.max(1, header.mipMapCount);
  const levels = mipLevelSizes(header.width, header.height, count);
  if (levels.length < count) return false;
  const block = header.blockSize > 1 ? header.blockSize : 1;
  const length = levels.reduce((sum, level) => sum + Math.ceil(level.width / block) * Math.ceil(level.height / block) * header.blockBytes, header.dataOffset);
  return bytes.length >= length;
}

/** True when any texel is less than fully opaque. */
export function hasTransparency(rgba) {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) return true;
  }
  return false;
}

// Contributions of source samples to each output sample along one axis:
// area coverage when shrinking, linear interpolation when growing.
function axisWeights(source, target) {
  const weights = [];
  if (target <= source) {
    const scale = source / target;
    for (let i = 0; i < target; i += 1) {
      const start = i * scale;
      const end = start + scale;
      const taps = [];
      for (let s = Math.floor(start); s < Math.min(source, Math.ceil(end)); s += 1) {
        const cover = Math.min(end, s + 1) - Math.max(start, s);
        if (cover > 1e-6) taps.push([s, cover / scale]);
      }
      weights.push(taps);
    }
  } else {
    const scale = source / target;
    for (let i = 0; i < target; i += 1) {
      const at = Math.min(source - 1, Math.max(0, (i + 0.5) * scale - 0.5));
      const low = Math.floor(at);
      const high = Math.min(source - 1, low + 1);
      const t = at - low;
      weights.push(high === low || t === 0 ? [[low, 1]] : [[low, 1 - t], [high, t]]);
    }
  }
  return weights;
}

// One separable pass on alpha-weighted colour (premultiplied in float), so
// the colour hidden under clear texels never bleeds into visible edges.
function resamplePass(src, width, height, weights, horizontal) {
  const outW = horizontal ? weights.length : width;
  const outH = horizontal ? height : weights.length;
  const out = new Float32Array(outW * outH * 4);
  for (let y = 0; y < outH; y += 1) {
    for (let x = 0; x < outW; x += 1) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [s, w] of weights[horizontal ? x : y]) {
        const i = horizontal ? (y * width + s) * 4 : (s * width + x) * 4;
        r += src[i] * w;
        g += src[i + 1] * w;
        b += src[i + 2] * w;
        a += src[i + 3] * w;
      }
      const o = (y * outW + x) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = a;
    }
  }
  return out;
}

function premultiplied(rgba) {
  const out = new Float32Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] / 255;
    out[i] = rgba[i] * a;
    out[i + 1] = rgba[i + 1] * a;
    out[i + 2] = rgba[i + 2] * a;
    out[i + 3] = rgba[i + 3];
  }
  return out;
}

function unpremultiplied(values) {
  const out = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i += 4) {
    const a = values[i + 3];
    const scale = a > 1e-3 ? 255 / a : 0;
    out[i] = Math.min(255, Math.round(values[i] * scale));
    out[i + 1] = Math.min(255, Math.round(values[i + 1] * scale));
    out[i + 2] = Math.min(255, Math.round(values[i + 2] * scale));
    out[i + 3] = Math.min(255, Math.round(a));
  }
  return out;
}

/** `rgba` (width x height) resampled to `toWidth` x `toHeight`. */
export function resizeRgba(rgba, width, height, toWidth, toHeight) {
  if (rgba?.length !== width * height * 4) throw new Error(`Expected ${width}x${height} RGBA pixels.`);
  if (width === toWidth && height === toHeight) return rgba;
  const horizontal = resamplePass(premultiplied(rgba), width, height, axisWeights(width, toWidth), true);
  return unpremultiplied(resamplePass(horizontal, toWidth, height, axisWeights(height, toHeight), false));
}

/**
 * The levels of a mip chain, each a 2x2 alpha-weighted average of the last:
 * `count` of them when given, else down to the last level at least 4 texels
 * on its shorter side (one compressed block), as GTA's own textures stop.
 */
export function buildMipChain(rgba, width, height, count = 0) {
  const full = mipLevelSizes(width, height, 32);
  const blocks = full.filter((size) => Math.min(size.width, size.height) >= 4).length || 1;
  const sizes = full.slice(0, count > 0 ? Math.min(count, full.length) : blocks);
  const levels = [{ width, height, data: rgba }];
  for (let index = 1; index < sizes.length; index += 1) {
    const previous = levels[index - 1];
    const { width: w, height: h } = sizes[index];
    const out = new Uint8Array(w * h * 4);
    const src = previous.data;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let dy = 0; dy < 2; dy += 1) {
          const sy = Math.min(previous.height - 1, y * 2 + dy);
          for (let dx = 0; dx < 2; dx += 1) {
            const i = (sy * previous.width + Math.min(previous.width - 1, x * 2 + dx)) * 4;
            const alpha = src[i + 3];
            r += src[i] * alpha;
            g += src[i + 1] * alpha;
            b += src[i + 2] * alpha;
            a += alpha;
          }
        }
        const o = (y * w + x) * 4;
        if (a > 0) {
          out[o] = Math.round(r / a);
          out[o + 1] = Math.round(g / a);
          out[o + 2] = Math.round(b / a);
        }
        out[o + 3] = Math.round(a / 4);
      }
    }
    levels.push({ width: w, height: h, data: out });
  }
  return levels;
}

/**
 * The DDS bytes for one dictionary's copy of a livery. `source` is
 * `{ width, height, rgba }` (top row first) and may carry `dds`, the user's
 * own DDS file, used as it is when it already has the target size. `levels`
 * is the mip count to write (the count the replaced texture had); without it
 * the chain stops at 4x4.
 * Returns `{ bytes, width, height, format, levels, passthrough }`.
 */
export function buildLiveryTexture(source, { width, height, levels = 0 }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 4 || height < 4 || width > 8192 || height > 8192) {
    throw new Error(`Cannot write a ${width}x${height} livery.`);
  }
  if (source?.dds) {
    const header = parseDDSHeader(source.dds);
    if (header && header.width === width && header.height === height && keepsAsIs(header) && holdsEveryLevel(source.dds, header)) {
      return { bytes: source.dds, width, height, format: header.fmt === "MASKED" ? "BGRA" : header.fmt, levels: header.mipMapCount, passthrough: true };
    }
  }
  if (!source?.rgba) throw new Error("The livery image has no pixels to write.");
  const fitted = resizeRgba(source.rgba, source.width, source.height, width, height);
  const chain = buildMipChain(fitted, width, height, levels);
  const bytes = writeDds({
    format: "DXT5",
    width,
    height,
    levels: chain.map((level) => encodeDxt5(level.data, level.width, level.height)),
  });
  return { bytes, width, height, format: "DXT5", levels: chain.length, passthrough: false };
}

/** A small preview of `rgba`, `size` pixels on its longer side, as RGBA. */
export function thumbnailRgba(rgba, width, height, size = 96) {
  const scale = Math.min(1, size / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  return { width: w, height: h, data: resizeRgba(rgba, width, height, w, h) };
}
