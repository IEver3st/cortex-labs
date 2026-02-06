/**
 * BC7 (BPTC) Texture Block Decoder — spec-compliant implementation.
 *
 * Reference: richgel999/bc7enc  bc7decomp.cpp (MIT license)
 * https://github.com/richgel999/bc7enc/blob/master/bc7decomp.cpp
 *
 * BC7 encodes 4×4 pixel blocks in 128 bits (16 bytes).
 * There are 8 modes (0–7), each with different numbers of subsets,
 * endpoint precision, index precision, and optional alpha.
 */

// ── Interpolation weight tables ──
const W2 = [0, 21, 43, 64];
const W3 = [0, 9, 18, 27, 37, 46, 55, 64];
const W4 = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];

// ── Partition tables (flat per-pixel, from bc7decomp.cpp) ──
// 2-subset: 64 partitions × 16 pixels, values 0 or 1
/* eslint-disable */
const P2 = new Uint8Array([
  0,0,1,1,0,0,1,1,0,0,1,1,0,0,1,1, 0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,
  0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1, 0,0,0,1,0,0,1,1,0,0,1,1,0,1,1,1,
  0,0,0,0,0,0,0,1,0,0,0,1,0,0,1,1, 0,0,1,1,0,1,1,1,0,1,1,1,1,1,1,1,
  0,0,0,1,0,0,1,1,0,1,1,1,1,1,1,1, 0,0,0,0,0,0,0,1,0,0,1,1,0,1,1,1,
  0,0,0,0,0,0,0,0,0,0,0,1,0,0,1,1, 0,0,1,1,0,1,1,1,1,1,1,1,1,1,1,1,
  0,0,0,0,0,0,0,1,0,1,1,1,1,1,1,1, 0,0,0,0,0,0,0,0,0,0,0,1,0,1,1,1,
  0,0,0,1,0,1,1,1,1,1,1,1,1,1,1,1, 0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,
  0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1, 0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,
  0,0,0,0,1,0,0,0,1,1,1,0,1,1,1,1, 0,1,1,1,0,0,0,1,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,1,0,0,0,1,1,1,0, 0,1,1,1,0,0,1,1,0,0,0,1,0,0,0,0,
  0,0,1,1,0,0,0,1,0,0,0,0,0,0,0,0, 0,0,0,0,1,0,0,0,1,1,0,0,1,1,1,0,
  0,0,0,0,0,0,0,0,1,0,0,0,1,1,0,0, 0,1,1,1,0,0,1,1,0,0,1,1,0,0,0,1,
  0,0,1,1,0,0,0,1,0,0,0,1,0,0,0,0, 0,0,0,0,1,0,0,0,1,0,0,0,1,1,0,0,
  0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,0, 0,0,1,1,0,1,1,0,0,1,1,0,1,1,0,0,
  0,0,0,1,0,1,1,1,1,1,1,0,1,0,0,0, 0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0,
  0,1,1,1,0,0,0,1,1,0,0,0,1,1,1,0, 0,0,1,1,1,0,0,1,1,0,0,1,1,1,0,0,
  0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1, 0,0,0,0,1,1,1,1,0,0,0,0,1,1,1,1,
  0,1,0,1,1,0,1,0,0,1,0,1,1,0,1,0, 0,0,1,1,0,0,1,1,1,1,0,0,1,1,0,0,
  0,0,1,1,1,1,0,0,0,0,1,1,1,1,0,0, 0,1,0,1,0,1,0,1,1,0,1,0,1,0,1,0,
  0,1,1,0,1,0,0,1,0,1,1,0,1,0,0,1, 0,1,0,1,1,0,1,0,1,0,1,0,0,1,0,1,
  0,1,1,1,0,0,1,1,1,1,0,0,1,1,1,0, 0,0,0,1,0,0,1,1,1,1,0,0,1,0,0,0,
  0,0,1,1,0,0,1,0,0,1,0,0,1,1,0,0, 0,0,1,1,1,0,1,1,1,1,0,1,1,1,0,0,
  0,1,1,0,1,0,0,1,1,0,0,1,0,1,1,0, 0,0,1,1,1,1,0,0,1,1,0,0,0,0,1,1,
  0,1,1,0,0,1,1,0,1,0,0,1,1,0,0,1, 0,0,0,0,0,1,1,0,0,1,1,0,0,0,0,0,
  0,1,0,0,1,1,1,0,0,1,0,0,0,0,0,0, 0,0,1,0,0,1,1,1,0,0,1,0,0,0,0,0,
  0,0,0,0,0,0,1,0,0,1,1,1,0,0,1,0, 0,0,0,0,0,1,0,0,1,1,1,0,0,1,0,0,
  0,1,1,0,1,1,0,0,1,0,0,1,0,0,1,1, 0,0,1,1,0,1,1,0,1,1,0,0,1,0,0,1,
  0,1,1,0,0,0,1,1,1,0,0,1,1,1,0,0, 0,0,1,1,1,0,0,1,1,1,0,0,0,1,1,0,
  0,1,1,0,1,1,0,0,1,1,0,0,1,0,0,1, 0,1,1,0,0,0,1,1,0,0,1,1,1,0,0,1,
  0,1,1,1,1,1,1,0,1,0,0,0,0,0,0,1, 0,0,0,1,1,0,0,0,1,1,1,0,0,1,1,1,
  0,0,0,0,1,1,1,1,0,0,1,1,0,0,1,1, 0,0,1,1,0,0,1,1,1,1,1,1,0,0,0,0,
  0,0,1,0,0,0,1,0,1,1,1,0,1,1,1,0, 0,1,0,0,0,1,0,0,0,1,1,1,0,1,1,1,
]);

// 3-subset: 64 partitions × 16 pixels, values 0, 1, or 2
const P3 = new Uint8Array([
  0,0,1,1,0,0,1,1,0,2,2,1,2,2,2,2, 0,0,0,1,0,0,1,1,2,2,1,1,2,2,2,1,
  0,0,0,0,2,0,0,1,2,2,1,1,2,2,1,1, 0,2,2,2,0,0,2,2,0,0,1,1,0,1,1,1,
  0,0,0,0,0,0,0,0,1,1,2,2,1,1,2,2, 0,0,1,1,0,0,1,1,0,0,2,2,0,0,2,2,
  0,0,2,2,0,0,2,2,1,1,1,1,1,1,1,1, 0,0,1,1,0,0,1,1,2,2,1,1,2,2,1,1,
  0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2, 0,0,0,0,1,1,1,1,1,1,1,1,2,2,2,2,
  0,0,0,0,1,1,1,1,2,2,2,2,2,2,2,2, 0,0,1,2,0,0,1,2,0,0,1,2,0,0,1,2,
  0,1,1,2,0,1,1,2,0,1,1,2,0,1,1,2, 0,1,2,2,0,1,2,2,0,1,2,2,0,1,2,2,
  0,0,1,1,0,1,1,2,1,1,2,2,1,2,2,2, 0,0,1,1,2,0,0,1,2,2,0,0,2,2,2,0,
  0,0,0,1,0,0,1,1,0,1,1,2,1,1,2,2, 0,1,1,1,0,0,1,1,2,0,0,1,2,2,0,0,
  0,0,0,0,1,1,2,2,1,1,2,2,1,1,2,2, 0,0,2,2,0,0,2,2,0,0,2,2,1,1,1,1,
  0,1,1,1,0,1,1,1,0,2,2,2,0,2,2,2, 0,0,0,1,0,0,0,1,2,2,2,1,2,2,2,1,
  0,0,0,0,0,0,1,1,0,1,2,2,0,1,2,2, 0,0,0,0,1,1,0,0,2,2,1,0,2,2,1,0,
  0,1,2,2,0,1,2,2,0,0,1,1,0,0,0,0, 0,0,1,2,0,0,1,2,1,1,2,2,2,2,2,2,
  0,1,1,0,1,2,2,1,1,2,2,1,0,1,1,0, 0,0,0,0,0,1,1,0,1,2,2,1,1,2,2,1,
  0,0,2,2,1,1,0,2,1,1,0,2,0,0,2,2, 0,1,1,0,0,1,1,0,2,0,0,2,2,2,2,2,
  0,0,1,1,0,1,2,2,0,1,2,2,0,0,1,1, 0,0,0,0,2,0,0,0,2,2,1,1,2,2,2,1,
  0,0,0,0,0,0,0,2,1,1,2,2,1,2,2,2, 0,2,2,2,0,0,2,2,0,0,1,2,0,0,1,1,
  0,0,1,1,0,0,1,2,0,0,2,2,0,2,2,2, 0,1,2,0,0,1,2,0,0,1,2,0,0,1,2,0,
  0,0,0,0,1,1,1,1,2,2,2,2,0,0,0,0, 0,1,2,0,1,2,0,1,2,0,1,2,0,1,2,0,
  0,1,2,0,2,0,1,2,1,2,0,1,0,1,2,0, 0,0,1,1,2,2,0,0,1,1,2,2,0,0,1,1,
  0,0,1,1,1,1,2,2,2,2,0,0,0,0,1,1, 0,1,0,1,0,1,0,1,2,2,2,2,2,2,2,2,
  0,0,0,0,0,0,0,0,2,1,2,1,2,1,2,1, 0,0,2,2,1,1,2,2,0,0,2,2,1,1,2,2,
  0,0,2,2,0,0,1,1,0,0,2,2,0,0,1,1, 0,2,2,0,1,2,2,1,0,2,2,0,1,2,2,1,
  0,1,0,1,2,2,2,2,2,2,2,2,0,1,0,1, 0,0,0,0,2,1,2,1,2,1,2,1,2,1,2,1,
  0,1,0,1,0,1,0,1,0,1,0,1,2,2,2,2, 0,2,2,2,0,1,1,1,0,2,2,2,0,1,1,1,
  0,0,0,2,1,1,1,2,0,0,0,2,1,1,1,2, 0,0,0,0,2,1,1,2,2,1,1,2,2,1,1,2,
  0,2,2,2,0,1,1,1,0,1,1,1,0,2,2,2, 0,0,0,2,1,1,1,2,1,1,1,2,0,0,0,2,
  0,1,1,0,0,1,1,0,0,1,1,0,2,2,2,2, 0,0,0,0,0,0,0,0,2,1,1,2,2,1,1,2,
  0,1,1,0,0,1,1,0,2,2,2,2,2,2,2,2, 0,0,2,2,0,0,1,1,0,0,1,1,0,0,2,2,
  0,0,2,2,1,1,2,2,1,1,2,2,0,0,2,2, 0,0,0,0,0,0,0,0,0,0,0,0,2,1,1,2,
  0,0,0,2,0,0,0,1,0,0,0,2,0,0,0,1, 0,2,2,2,1,2,2,2,0,2,2,2,1,2,2,2,
  0,1,0,1,2,2,2,2,2,2,2,2,2,2,2,2, 0,1,1,1,2,0,1,1,2,2,0,1,2,2,2,0,
]);
/* eslint-enable */

// Anchor index tables
const ANCHOR2 = new Uint8Array([
  15,15,15,15,15,15,15,15, 15,15,15,15,15,15,15,15,
  15, 2, 8, 2, 2, 8, 8,15,  2, 8, 2, 2, 8, 8, 2, 2,
  15,15, 6, 8, 2, 8,15,15,  2, 8, 2, 2, 2,15,15, 6,
   6, 2, 6, 8,15,15, 2, 2, 15,15,15,15,15, 2, 2,15,
]);

const ANCHOR3A = new Uint8Array([
   3, 3,15,15, 8, 3,15,15,  8, 8, 6, 6, 6, 5, 3, 3,
   3, 3, 8,15, 3, 3, 6,10,  5, 8, 8, 6, 8, 5,15,15,
   8,15, 3, 5, 6,10, 8,15, 15, 3,15, 5,15,15,15,15,
   3,15, 5, 5, 5, 8, 5,10,  5,10, 8,13,15,12, 3, 3,
]);

const ANCHOR3B = new Uint8Array([
  15, 8, 8, 3,15,15, 3, 8, 15,15,15,15,15,15,15, 8,
  15, 8,15, 3,15, 8,15, 8,  3,15, 6,10,15,15,10, 8,
  15, 3,15,10,10, 8, 9,10,  6,15, 8,15, 3, 6, 6, 8,
  15, 3,15,15,15,15,15,15, 15,15,15,15, 3,15,15, 8,
]);

// ── Mode table ──
// ns=subsets, pb=partBits, rb=rotBits, isb=idxSelBit, cb=colorBits, ab=alphaBits,
// epb=endpointPBits, spb=sharedPBits, ib=indexBits, ib2=secondIndexBits
const MODES = [
  { ns:3, pb:4, rb:0, isb:0, cb:4, ab:0, epb:1, spb:0, ib:3, ib2:0 },
  { ns:2, pb:6, rb:0, isb:0, cb:6, ab:0, epb:0, spb:1, ib:3, ib2:0 },
  { ns:3, pb:6, rb:0, isb:0, cb:5, ab:0, epb:0, spb:0, ib:2, ib2:0 },
  { ns:2, pb:6, rb:0, isb:0, cb:7, ab:0, epb:1, spb:0, ib:2, ib2:0 },
  { ns:1, pb:0, rb:2, isb:1, cb:5, ab:6, epb:0, spb:0, ib:2, ib2:3 },
  { ns:1, pb:0, rb:2, isb:0, cb:7, ab:8, epb:0, spb:0, ib:2, ib2:2 },
  { ns:1, pb:0, rb:0, isb:0, cb:7, ab:7, epb:1, spb:0, ib:4, ib2:0 },
  { ns:2, pb:6, rb:0, isb:0, cb:5, ab:5, epb:1, spb:0, ib:2, ib2:0 },
];

// ── Bit reader ──
function readBits(block, pos, count) {
  let val = 0;
  for (let i = 0; i < count; i++) {
    const b = pos + i;
    val |= ((block[b >> 3] >>> (b & 7)) & 1) << i;
  }
  return val;
}

function dequant(val, pbit, totalBits) {
  // totalBits = endpoint bits + 1 (for p-bit)
  val = (val << 1) | pbit;
  val <<= (8 - totalBits);
  val |= (val >>> totalBits);
  return val & 0xFF;
}

function dequantNoPbit(val, bits) {
  val <<= (8 - bits);
  val |= (val >>> bits);
  return val & 0xFF;
}

function interp(l, h, w) {
  return (l * (64 - w) + h * w + 32) >> 6;
}

/**
 * Decode a single BC7 block into the RGBA output buffer.
 */
export function decodeBC7Block(block, bx, by, width, height, rgba) {
  // Find mode
  let mode = 0;
  while (mode < 8 && ((block[0] >> mode) & 1) === 0) mode++;
  if (mode >= 8) {
    // Reserved mode — fill black
    for (let py = 0; py < 4; py++) for (let px = 0; px < 4; px++) {
      const x = bx*4+px, y = by*4+py;
      if (x >= width || y >= height) continue;
      const o = (y*width+x)*4;
      rgba[o] = rgba[o+1] = rgba[o+2] = 0; rgba[o+3] = 255;
    }
    return;
  }

  const m = MODES[mode];
  let bp = mode + 1; // bit position (skip mode bits)

  const part = readBits(block, bp, m.pb); bp += m.pb;
  const rot = readBits(block, bp, m.rb); bp += m.rb;
  const idxSel = readBits(block, bp, m.isb); bp += m.isb;

  // Read endpoints: [subset][endpoint][channel]
  // Channels: R, G, B then A
  const numEP = m.ns * 2;
  const ep = new Array(numEP);
  for (let i = 0; i < numEP; i++) ep[i] = [0, 0, 0, 255];

  for (let c = 0; c < 3; c++)
    for (let e = 0; e < numEP; e++) {
      ep[e][c] = readBits(block, bp, m.cb); bp += m.cb;
    }
  if (m.ab > 0)
    for (let e = 0; e < numEP; e++) {
      ep[e][3] = readBits(block, bp, m.ab); bp += m.ab;
    }

  // Read p-bits
  const numPBits = m.epb ? numEP : (m.spb ? m.ns : 0);
  const pbits = new Uint8Array(numPBits);
  for (let i = 0; i < numPBits; i++) {
    pbits[i] = readBits(block, bp, 1); bp += 1;
  }

  // Dequantize endpoints
  const hasPBit = m.epb > 0 || m.spb > 0;
  const cBits = m.cb + (hasPBit ? 1 : 0);
  const aBits = m.ab > 0 ? m.ab + (hasPBit ? 1 : 0) : 0;

  for (let e = 0; e < numEP; e++) {
    const pb = m.epb ? pbits[e] : (m.spb ? pbits[e >> 1] : 0);
    for (let c = 0; c < 3; c++) {
      ep[e][c] = hasPBit ? dequant(ep[e][c], pb, cBits) : dequantNoPbit(ep[e][c], m.cb);
    }
    if (m.ab > 0) {
      ep[e][3] = hasPBit ? dequant(ep[e][3], pb, aBits) : dequantNoPbit(ep[e][3], m.ab);
    }
  }

  // Read indices
  const wt1 = m.ib === 2 ? W2 : m.ib === 3 ? W3 : W4;
  const wt2 = m.ib2 === 0 ? null : m.ib2 === 2 ? W2 : W3;

  const idx1 = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    let anchor = false;
    if (i === 0) anchor = true;
    else if (m.ns === 2 && i === ANCHOR2[part]) anchor = true;
    else if (m.ns === 3 && (i === ANCHOR3A[part] || i === ANCHOR3B[part])) anchor = true;
    const bits = anchor ? m.ib - 1 : m.ib;
    idx1[i] = readBits(block, bp, bits); bp += bits;
  }

  const idx2 = new Uint8Array(16);
  if (m.ib2 > 0) {
    for (let i = 0; i < 16; i++) {
      const bits = (i === 0) ? m.ib2 - 1 : m.ib2;
      idx2[i] = readBits(block, bp, bits); bp += bits;
    }
  }

  // Partition table lookup
  const ptable = m.ns === 3 ? P3 : P2;
  const poff = part * 16;

  // Write pixels
  for (let py = 0; py < 4; py++) for (let px = 0; px < 4; px++) {
    const x = bx*4+px, y = by*4+py;
    if (x >= width || y >= height) continue;

    const pi = py*4+px;
    const subset = m.ns === 1 ? 0 : ptable[poff + pi];
    const e0 = ep[subset * 2];
    const e1 = ep[subset * 2 + 1];

    let r, g, b, a;
    if (m.ib2 === 0) {
      const w = wt1[idx1[pi]];
      r = interp(e0[0], e1[0], w);
      g = interp(e0[1], e1[1], w);
      b = interp(e0[2], e1[2], w);
      a = m.ab > 0 ? interp(e0[3], e1[3], w) : 255;
    } else {
      const w1 = wt1[idx1[pi]];
      const w2 = wt2[idx2[pi]];
      if (idxSel === 0) {
        r = interp(e0[0], e1[0], w1); g = interp(e0[1], e1[1], w1);
        b = interp(e0[2], e1[2], w1); a = interp(e0[3], e1[3], w2);
      } else {
        r = interp(e0[0], e1[0], w2); g = interp(e0[1], e1[1], w2);
        b = interp(e0[2], e1[2], w2); a = interp(e0[3], e1[3], w1);
      }
    }

    // Rotation
    if (rot === 1) { const t = a; a = r; r = t; }
    else if (rot === 2) { const t = a; a = g; g = t; }
    else if (rot === 3) { const t = a; a = b; b = t; }

    const o = (y*width+x)*4;
    rgba[o] = r; rgba[o+1] = g; rgba[o+2] = b; rgba[o+3] = a;
  }
}
