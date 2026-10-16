/**
 * DDS files Cortex writes back into texture dictionaries: DXT5 (BC3) or
 * 32-bit BGRA, with legacy headers. CodeWalker's DDS import reads both, and
 * they are the formats GTA texture dictionaries hold. Rows are stored top row
 * first, as the game samples them and as dds-decode reads them with
 * `flipY: false`. Pure, so it runs in Node tests and workers alike.
 */

const DDS_MAGIC = 0x20534444;
const DDSD_CAPS = 0x1;
const DDSD_HEIGHT = 0x2;
const DDSD_WIDTH = 0x4;
const DDSD_PITCH = 0x8;
const DDSD_PIXELFORMAT = 0x1000;
const DDSD_MIPMAPCOUNT = 0x20000;
const DDSD_LINEARSIZE = 0x80000;
const DDPF_ALPHAPIXELS = 0x1;
const DDPF_FOURCC = 0x4;
const DDPF_RGB = 0x40;
const DDSCAPS_COMPLEX = 0x8;
const DDSCAPS_TEXTURE = 0x1000;
const DDSCAPS_MIPMAP = 0x400000;

/** Width and height of each level of a mip chain, as DDS stores them. */
export function mipLevelSizes(width, height, count) {
  const sizes = [];
  let w = width;
  let h = height;
  for (let level = 0; level < count; level += 1) {
    sizes.push({ width: w, height: h });
    if (w === 1 && h === 1) break;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
  return sizes;
}

/** Bytes of one stored level. */
export function ddsLevelByteLength(format, width, height) {
  if (format === "DXT5") return Math.ceil(width / 4) * Math.ceil(height / 4) * 16;
  if (format === "BGRA") return width * height * 4;
  throw new Error(`Cannot write ${format} textures.`);
}

/**
 * A DDS file from encoded levels (`levels[i]` is the payload of level i).
 * Every level must have the size its place in the chain gives it.
 */
export function writeDds({ format, width, height, levels }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384) {
    throw new Error(`Cannot write a ${width}x${height} texture.`);
  }
  if (!Array.isArray(levels) || !levels.length) throw new Error("A texture needs at least one level.");
  const sizes = mipLevelSizes(width, height, levels.length);
  if (sizes.length !== levels.length) throw new Error(`A ${width}x${height} texture has at most ${sizes.length} levels.`);
  let payload = 0;
  sizes.forEach((size, index) => {
    const expected = ddsLevelByteLength(format, size.width, size.height);
    if (levels[index]?.length !== expected) {
      throw new Error(`Level ${index} of a ${width}x${height} ${format} texture should be ${expected} bytes.`);
    }
    payload += expected;
  });

  const bytes = new Uint8Array(128 + payload);
  const view = new DataView(bytes.buffer);
  const mipped = levels.length > 1;
  const compressed = format === "DXT5";
  view.setUint32(0, DDS_MAGIC, true);
  view.setUint32(4, 124, true);
  view.setUint32(8, DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PIXELFORMAT
    | (compressed ? DDSD_LINEARSIZE : DDSD_PITCH) | (mipped ? DDSD_MIPMAPCOUNT : 0), true);
  view.setUint32(12, height, true);
  view.setUint32(16, width, true);
  view.setUint32(20, compressed ? ddsLevelByteLength(format, width, height) : width * 4, true);
  view.setUint32(28, levels.length, true);
  view.setUint32(76, 32, true);
  if (compressed) {
    view.setUint32(80, DDPF_FOURCC, true);
    bytes.set([0x44, 0x58, 0x54, 0x35], 84); // "DXT5"
  } else {
    view.setUint32(80, DDPF_RGB | DDPF_ALPHAPIXELS, true);
    view.setUint32(88, 32, true);
    view.setUint32(92, 0x00ff0000, true);
    view.setUint32(96, 0x0000ff00, true);
    view.setUint32(100, 0x000000ff, true);
    view.setUint32(104, 0xff000000, true);
  }
  view.setUint32(108, DDSCAPS_TEXTURE | (mipped ? DDSCAPS_COMPLEX | DDSCAPS_MIPMAP : 0), true);
  let offset = 128;
  for (const level of levels) {
    bytes.set(level, offset);
    offset += level.length;
  }
  return bytes;
}

/** RGBA rows to BGRA, the byte order of a legacy A8R8G8B8 DDS. */
export function rgbaToBgra(rgba) {
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = rgba[i + 2];
    out[i + 1] = rgba[i + 1];
    out[i + 2] = rgba[i];
    out[i + 3] = rgba[i + 3];
  }
  return out;
}

/**
 * DXT5 blocks for one RGBA level. `reuse(blockIndex)` may return 16 encoded
 * bytes to keep for a block the caller knows is unchanged, so untouched parts
 * of a re-encoded texture stay bit for bit what they were.
 */
export function encodeDxt5(rgba, width, height, { reuse = null } = {}) {
  if (rgba?.length !== width * height * 4) throw new Error(`Expected ${width}x${height} RGBA pixels.`);
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  const out = new Uint8Array(blocksX * blocksY * 16);
  const block = new Uint8Array(64);
  for (let by = 0; by < blocksY; by += 1) {
    for (let bx = 0; bx < blocksX; bx += 1) {
      const index = by * blocksX + bx;
      const kept = reuse ? reuse(index) : null;
      if (kept) {
        out.set(kept, index * 16);
        continue;
      }
      // Partial edge blocks repeat the last row and column.
      for (let py = 0; py < 4; py += 1) {
        const y = Math.min(height - 1, by * 4 + py);
        for (let px = 0; px < 4; px += 1) {
          const x = Math.min(width - 1, bx * 4 + px);
          const from = (y * width + x) * 4;
          const to = (py * 4 + px) * 4;
          block[to] = rgba[from];
          block[to + 1] = rgba[from + 1];
          block[to + 2] = rgba[from + 2];
          block[to + 3] = rgba[from + 3];
        }
      }
      encodeAlphaBlock(block, out, index * 16);
      encodeColorBlock(block, out, index * 16 + 8);
    }
  }
  return out;
}

// Eight-value mode (a0 > a1) between the block's extremes, so fully opaque and
// fully clear texels keep their exact values when they bound the block.
function encodeAlphaBlock(block, out, offset) {
  let min = 255;
  let max = 0;
  for (let i = 0; i < 16; i += 1) {
    const a = block[i * 4 + 3];
    if (a < min) min = a;
    if (a > max) max = a;
  }
  out[offset] = max;
  out[offset + 1] = min;
  if (max === min) {
    out.fill(0, offset + 2, offset + 8);
    return;
  }
  ALPHA_PALETTE[0] = max;
  ALPHA_PALETTE[1] = min;
  for (let i = 1; i < 7; i += 1) ALPHA_PALETTE[i + 1] = Math.floor(((7 - i) * max + i * min) / 7);
  // 3-bit indices, 8 texels per 24-bit half.
  let low = 0;
  let high = 0;
  for (let i = 0; i < 16; i += 1) {
    const a = block[i * 4 + 3];
    let best = 0;
    let bestError = Infinity;
    for (let p = 0; p < 8; p += 1) {
      const error = Math.abs(ALPHA_PALETTE[p] - a);
      if (error < bestError) {
        bestError = error;
        best = p;
      }
    }
    if (i < 8) low |= best << (i * 3);
    else high |= best << ((i - 8) * 3);
  }
  out[offset + 2] = low & 0xff;
  out[offset + 3] = (low >>> 8) & 0xff;
  out[offset + 4] = (low >>> 16) & 0xff;
  out[offset + 5] = high & 0xff;
  out[offset + 6] = (high >>> 8) & 0xff;
  out[offset + 7] = (high >>> 16) & 0xff;
}

const ALPHA_PALETTE = new Int32Array(8);

function to565(r, g, b) {
  const r5 = Math.max(0, Math.min(31, Math.round((r * 31) / 255)));
  const g6 = Math.max(0, Math.min(63, Math.round((g * 63) / 255)));
  const b5 = Math.max(0, Math.min(31, Math.round((b * 31) / 255)));
  return (r5 << 11) | (g6 << 5) | b5;
}

function from565(value) {
  const r = (value >> 11) & 31;
  const g = (value >> 5) & 63;
  const b = value & 31;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}

// Endpoints at the block's extremes along its principal colour axis, in
// four-colour mode (c0 > c1) as BC3 decodes it. A block decoded from DXT
// already lies on such a line, so re-encoding it lands on its old endpoints.
function encodeColorBlock(block, out, offset) {
  let mr = 0;
  let mg = 0;
  let mb = 0;
  for (let i = 0; i < 16; i += 1) {
    mr += block[i * 4];
    mg += block[i * 4 + 1];
    mb += block[i * 4 + 2];
  }
  mr /= 16;
  mg /= 16;
  mb /= 16;
  let crr = 0, crg = 0, crb = 0, cgg = 0, cgb = 0, cbb = 0;
  for (let i = 0; i < 16; i += 1) {
    const r = block[i * 4] - mr;
    const g = block[i * 4 + 1] - mg;
    const b = block[i * 4 + 2] - mb;
    crr += r * r; crg += r * g; crb += r * b;
    cgg += g * g; cgb += g * b; cbb += b * b;
  }
  // Power iteration from the covariance row with the most energy: a fixed
  // start such as (1, 1, 1) is orthogonal to the axis of a red-green ramp.
  const rows = [[crr, crg, crb], [crg, cgg, cgb], [crb, cgb, cbb]];
  let [ar, ag, ab] = rows.reduce((best, row) => (Math.hypot(...row) > Math.hypot(...best) ? row : best));
  for (let step = 0; step < 6; step += 1) {
    const nr = crr * ar + crg * ag + crb * ab;
    const ng = crg * ar + cgg * ag + cgb * ab;
    const nb = crb * ar + cgb * ag + cbb * ab;
    const length = Math.hypot(nr, ng, nb);
    if (length < 1e-6) break;
    ar = nr / length;
    ag = ng / length;
    ab = nb / length;
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < 16; i += 1) {
    const t = (block[i * 4] - mr) * ar + (block[i * 4 + 1] - mg) * ag + (block[i * 4 + 2] - mb) * ab;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  let c0 = to565(mr + ar * hi, mg + ag * hi, mb + ab * hi);
  let c1 = to565(mr + ar * lo, mg + ag * lo, mb + ab * lo);
  if (c0 < c1) [c0, c1] = [c1, c0];
  out[offset] = c0 & 0xff;
  out[offset + 1] = c0 >> 8;
  out[offset + 2] = c1 & 0xff;
  out[offset + 3] = c1 >> 8;
  if (c0 === c1) {
    out.fill(0, offset + 4, offset + 8);
    return;
  }
  const p0 = from565(c0);
  const p1 = from565(c1);
  const palette = [
    p0,
    p1,
    [0, 1, 2].map((channel) => Math.floor((2 * p0[channel] + p1[channel]) / 3)),
    [0, 1, 2].map((channel) => Math.floor((p0[channel] + 2 * p1[channel]) / 3)),
  ];
  let bits = 0;
  for (let i = 0; i < 16; i += 1) {
    let best = 0;
    let bestError = Infinity;
    for (let p = 0; p < 4; p += 1) {
      const dr = palette[p][0] - block[i * 4];
      const dg = palette[p][1] - block[i * 4 + 1];
      const db = palette[p][2] - block[i * 4 + 2];
      const error = dr * dr + dg * dg + db * db;
      if (error < bestError) {
        bestError = error;
        best = p;
      }
    }
    bits |= best << (i * 2);
  }
  out[offset + 4] = bits & 0xff;
  out[offset + 5] = (bits >>> 8) & 0xff;
  out[offset + 6] = (bits >>> 16) & 0xff;
  out[offset + 7] = (bits >>> 24) & 0xff;
}
