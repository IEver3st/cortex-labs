import { decodeBC7Block } from "./bc7.js";

const DDS_MAGIC = 0x20534444;
const DDSD_MIPMAPCOUNT = 0x20000;
const DDPF_ALPHAPIXELS = 0x1;
const DDPF_FOURCC = 0x4;
const DDPF_RGB = 0x40;
const DDPF_LUMINANCE = 0x20000;
const DDPF_ALPHA = 0x2;

const D3D10_RESOURCE_DIMENSION_TEXTURE2D = 3;

function fourCC(str) {
  return str.charCodeAt(0) | (str.charCodeAt(1) << 8) |
         (str.charCodeAt(2) << 16) | (str.charCodeAt(3) << 24);
}

const FOURCC_DXT1 = fourCC("DXT1");
const FOURCC_DXT3 = fourCC("DXT3");
const FOURCC_DXT5 = fourCC("DXT5");
const FOURCC_ATI1 = fourCC("ATI1");
const FOURCC_ATI2 = fourCC("ATI2");
const FOURCC_BC4U = fourCC("BC4U");
const FOURCC_BC4S = fourCC("BC4S");
const FOURCC_BC5U = fourCC("BC5U");
const FOURCC_BC5S = fourCC("BC5S");
const FOURCC_DX10 = fourCC("DX10");

const DXGI = {
  BC1_UNORM: 71, BC1_UNORM_SRGB: 72,
  BC2_UNORM: 74, BC2_UNORM_SRGB: 75,
  BC3_UNORM: 77, BC3_UNORM_SRGB: 78,
  BC4_UNORM: 80, BC4_SNORM: 81,
  BC5_UNORM: 83, BC5_SNORM: 84,
  BC7_UNORM: 98, BC7_UNORM_SRGB: 99,
  R8G8B8A8_UNORM: 28, R8G8B8A8_UNORM_SRGB: 29,
  B8G8R8A8_UNORM: 87, B8G8R8A8_UNORM_SRGB: 91,
  R8_UNORM: 61,
  R8G8_UNORM: 49,
  A8_UNORM: 65,
  B5G6R5_UNORM: 85,
  B5G5R5A1_UNORM: 86,
  B8G8R8X8_UNORM: 88, B8G8R8X8_UNORM_SRGB: 93,
  B4G4R4A4_UNORM: 115,
};

const DXGI_NAMES = {
  2: "R32G32B32A32_FLOAT", 10: "R16G16B16A16_FLOAT", 24: "R10G10B10A2_UNORM",
  95: "BC6H_UF16", 96: "BC6H_SF16",
};

/* Uncompressed layouts described by per-channel bit masks. GTA textures
   exported by CodeWalker use these for A8R8G8B8, A8B8G8R8, R5G6B5,
   A1R5G5B5, L8 and A8 (alpha-only masks). */
const MASKED_DXGI = {
  [DXGI.A8_UNORM]: { bitCount: 8, masks: [0, 0, 0, 0xff], alphaOnly: true },
  [DXGI.R8G8_UNORM]: { bitCount: 16, masks: [0x00ff, 0xff00, 0, 0] },
  [DXGI.B5G6R5_UNORM]: { bitCount: 16, masks: [0xf800, 0x07e0, 0x001f, 0] },
  [DXGI.B5G5R5A1_UNORM]: { bitCount: 16, masks: [0x7c00, 0x03e0, 0x001f, 0x8000] },
  [DXGI.B4G4R4A4_UNORM]: { bitCount: 16, masks: [0x0f00, 0x00f0, 0x000f, 0xf000] },
  [DXGI.B8G8R8X8_UNORM]: { bitCount: 32, masks: [0xff0000, 0xff00, 0xff, 0] },
  [DXGI.B8G8R8X8_UNORM_SRGB]: { bitCount: 32, masks: [0xff0000, 0xff00, 0xff, 0], srgb: true },
};

function maskShift(mask) {
  if (!mask) return 0;
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) shift += 1;
  return shift;
}

function maskMax(mask) {
  return mask ? (mask >>> maskShift(mask)) : 0;
}

/** Decoder for an uncompressed layout given channel masks (R, G, B, A). */
function createMaskedDecoder({ bitCount, masks, luminance = false, alphaOnly = false }) {
  const bytes = bitCount >> 3;
  const channels = masks.map((mask) => ({ mask: mask >>> 0, shift: maskShift(mask >>> 0), max: maskMax(mask >>> 0) }));
  const read = (channel, value, fallback) =>
    channel.mask ? Math.round((((value & channel.mask) >>> channel.shift) * 255) / channel.max) : fallback;
  return function decodeMasked(src, off, w, h, rgba) {
    const count = w * h;
    for (let i = 0; i < count; i += 1) {
      const si = off + i * bytes;
      let value = src[si];
      if (bytes > 1) value |= src[si + 1] << 8;
      if (bytes > 2) value |= src[si + 2] << 16;
      if (bytes > 3) value = (value | (src[si + 3] << 24)) >>> 0;
      const di = i * 4;
      if (alphaOnly) {
        // D3D samples A8 as (0, 0, 0, a); vehshare's "black" tire texture relies on it.
        rgba[di] = 0; rgba[di + 1] = 0; rgba[di + 2] = 0;
        rgba[di + 3] = channels[3].mask ? read(channels[3], value, 255) : value & 0xff;
      } else if (luminance) {
        const l = read(channels[0], value, 0);
        rgba[di] = l; rgba[di + 1] = l; rgba[di + 2] = l;
        rgba[di + 3] = read(channels[3], value, 255);
      } else {
        rgba[di] = read(channels[0], value, 0);
        rgba[di + 1] = read(channels[1], value, 0);
        rgba[di + 2] = read(channels[2], value, 0);
        rgba[di + 3] = read(channels[3], value, 255);
      }
    }
  };
}

const _cp = new Uint8Array(16);
const _ap = new Uint8Array(8);

function decode565(c, slot) {
  const b = slot << 2;
  _cp[b]     = ((c >> 11) & 0x1F) * 255 / 31 + 0.5 | 0;
  _cp[b + 1] = ((c >> 5) & 0x3F) * 255 / 63 + 0.5 | 0;
  _cp[b + 2] = (c & 0x1F) * 255 / 31 + 0.5 | 0;
  _cp[b + 3] = 255;
}

function buildPalette(c0, c1, fourColor) {
  decode565(c0, 0);
  decode565(c1, 1);
  if (fourColor) {
    _cp[8]  = ((_cp[0]*2+_cp[4])/3)|0; _cp[9]  = ((_cp[1]*2+_cp[5])/3)|0;
    _cp[10] = ((_cp[2]*2+_cp[6])/3)|0; _cp[11] = 255;
    _cp[12] = ((_cp[0]+_cp[4]*2)/3)|0; _cp[13] = ((_cp[1]+_cp[5]*2)/3)|0;
    _cp[14] = ((_cp[2]+_cp[6]*2)/3)|0; _cp[15] = 255;
  } else {
    _cp[8]  = (_cp[0]+_cp[4])>>1; _cp[9]  = (_cp[1]+_cp[5])>>1;
    _cp[10] = (_cp[2]+_cp[6])>>1; _cp[11] = 255;
    _cp[12] = 0; _cp[13] = 0; _cp[14] = 0; _cp[15] = 0;
  }
}

function buildAlpha(a0, a1) {
  _ap[0] = a0; _ap[1] = a1;
  if (a0 > a1) {
    _ap[2]=((6*a0+1*a1)/7)|0; _ap[3]=((5*a0+2*a1)/7)|0;
    _ap[4]=((4*a0+3*a1)/7)|0; _ap[5]=((3*a0+4*a1)/7)|0;
    _ap[6]=((2*a0+5*a1)/7)|0; _ap[7]=((1*a0+6*a1)/7)|0;
  } else {
    _ap[2]=((4*a0+1*a1)/5)|0; _ap[3]=((3*a0+2*a1)/5)|0;
    _ap[4]=((2*a0+3*a1)/5)|0; _ap[5]=((1*a0+4*a1)/5)|0;
    _ap[6]=0; _ap[7]=255;
  }
}

function decodeDXT1(src, off, w, h, rgba) {
  const bx = Math.ceil(w/4), by = Math.ceil(h/4), w4 = w<<2;
  let bo = off;
  for (let y=0; y<by; y++) for (let x=0; x<bx; x++) {
    const c0=src[bo]|src[bo+1]<<8, c1=src[bo+2]|src[bo+3]<<8;
    const idx=src[bo+4]|src[bo+5]<<8|src[bo+6]<<16|src[bo+7]<<24; bo+=8;
    buildPalette(c0,c1,c0>c1);
    for (let py=0;py<4;py++) { const ry=(y*4+py); if(ry>=h) break;
      for (let px=0;px<4;px++) { const rx=x*4+px; if(rx>=w) continue;
        const i=((idx>>((py*4+px)<<1))&3)<<2, o=ry*w4+(rx<<2);
        rgba[o]=_cp[i]; rgba[o+1]=_cp[i+1]; rgba[o+2]=_cp[i+2]; rgba[o+3]=_cp[i+3];
      }
    }
  }
}

function decodeDXT3(src, off, w, h, rgba) {
  const bx=Math.ceil(w/4), by=Math.ceil(h/4), w4=w<<2;
  let bo=off;
  for (let y=0;y<by;y++) for (let x=0;x<bx;x++) {
    const aLo=src[bo]|src[bo+1]<<8|src[bo+2]<<16|src[bo+3]<<24;
    const aHi=src[bo+4]|src[bo+5]<<8|src[bo+6]<<16|src[bo+7]<<24; bo+=8;
    const c0=src[bo]|src[bo+1]<<8, c1=src[bo+2]|src[bo+3]<<8;
    const idx=src[bo+4]|src[bo+5]<<8|src[bo+6]<<16|src[bo+7]<<24; bo+=8;
    buildPalette(c0,c1,true);
    for (let py=0;py<4;py++) { const ry=y*4+py; if(ry>=h) break;
      for (let px=0;px<4;px++) { const rx=x*4+px; if(rx>=w) continue;
        const i=((idx>>((py*4+px)<<1))&3)<<2;
        const ai=py*4+px, ab=ai<8?aLo:aHi, as=(ai%8)*4, a=((ab>>as)&0xF)*17;
        const o=ry*w4+(rx<<2);
        rgba[o]=_cp[i]; rgba[o+1]=_cp[i+1]; rgba[o+2]=_cp[i+2]; rgba[o+3]=a;
      }
    }
  }
}

function decodeDXT5(src, off, w, h, rgba) {
  const bx=Math.ceil(w/4), by=Math.ceil(h/4), w4=w<<2;
  let bo=off;
  for (let y=0;y<by;y++) for (let x=0;x<bx;x++) {
    const a0=src[bo], a1=src[bo+1];
    const abLo=src[bo+2]|src[bo+3]<<8|src[bo+4]<<16;
    const abHi=src[bo+5]|src[bo+6]<<8|src[bo+7]<<16; bo+=8;
    buildAlpha(a0,a1);
    const c0=src[bo]|src[bo+1]<<8, c1=src[bo+2]|src[bo+3]<<8;
    const idx=src[bo+4]|src[bo+5]<<8|src[bo+6]<<16|src[bo+7]<<24; bo+=8;
    buildPalette(c0,c1,true);
    for (let py=0;py<4;py++) { const ry=y*4+py; if(ry>=h) break;
      for (let px=0;px<4;px++) { const rx=x*4+px; if(rx>=w) continue;
        const ci=((idx>>((py*4+px)<<1))&3)<<2;
        const pi=py*4+px, ab=pi<8?abLo:abHi, as=pi<8?pi*3:(pi-8)*3;
        const ai=(ab>>as)&7;
        const o=ry*w4+(rx<<2);
        rgba[o]=_cp[ci]; rgba[o+1]=_cp[ci+1]; rgba[o+2]=_cp[ci+2]; rgba[o+3]=_ap[ai];
      }
    }
  }
}

function decodeBC4(src, off, w, h, rgba) {
  const bx=Math.ceil(w/4), by=Math.ceil(h/4), w4=w<<2;
  let bo=off;
  for (let y=0;y<by;y++) for (let x=0;x<bx;x++) {
    const r0=src[bo], r1=src[bo+1];
    const rLo=src[bo+2]|src[bo+3]<<8|src[bo+4]<<16;
    const rHi=src[bo+5]|src[bo+6]<<8|src[bo+7]<<16; bo+=8;
    buildAlpha(r0,r1);
    const rp=new Uint8Array(_ap);
    for (let py=0;py<4;py++) { const ry=y*4+py; if(ry>=h) break;
      for (let px=0;px<4;px++) { const rx=x*4+px; if(rx>=w) continue;
        const pi=py*4+px, b=pi<8?rLo:rHi, s=pi<8?pi*3:(pi-8)*3;
        const r=rp[(b>>s)&7], o=ry*w4+(rx<<2);
        rgba[o]=r; rgba[o+1]=r; rgba[o+2]=r; rgba[o+3]=255;
      }
    }
  }
}

function decodeBC5(src, off, w, h, rgba) {
  const bx=Math.ceil(w/4), by=Math.ceil(h/4), w4=w<<2;
  let bo=off;
  for (let y=0;y<by;y++) for (let x=0;x<bx;x++) {
    const r0=src[bo],r1=src[bo+1];
    const rLo=src[bo+2]|src[bo+3]<<8|src[bo+4]<<16;
    const rHi=src[bo+5]|src[bo+6]<<8|src[bo+7]<<16; bo+=8;
    buildAlpha(r0,r1); const rp=new Uint8Array(_ap);
    const g0=src[bo],g1=src[bo+1];
    const gLo=src[bo+2]|src[bo+3]<<8|src[bo+4]<<16;
    const gHi=src[bo+5]|src[bo+6]<<8|src[bo+7]<<16; bo+=8;
    buildAlpha(g0,g1); const gp=new Uint8Array(_ap);
    for (let py=0;py<4;py++) { const ry=y*4+py; if(ry>=h) break;
      for (let px=0;px<4;px++) { const rx=x*4+px; if(rx>=w) continue;
        const pi=py*4+px;
        const rs=pi<8?pi*3:(pi-8)*3, ri=((pi<8?rLo:rHi)>>rs)&7;
        const gs=pi<8?pi*3:(pi-8)*3, gi=((pi<8?gLo:gHi)>>gs)&7;
        const r=rp[ri], g=gp[gi];
        const nx=(r/255)*2-1, ny=(g/255)*2-1;
        const nz=Math.sqrt(Math.max(0,1-nx*nx-ny*ny));
        const b=Math.floor((nz*0.5+0.5)*255);
        const o=ry*w4+(rx<<2);
        rgba[o]=r; rgba[o+1]=g; rgba[o+2]=b; rgba[o+3]=255;
      }
    }
  }
}

function decodeBC7(src, off, w, h, rgba) {
  const bx=Math.ceil(w/4), by=Math.ceil(h/4);
  let bo=off;
  for (let y=0;y<by;y++) for (let x=0;x<bx;x++) {
    const block = src.subarray(bo, bo+16); bo+=16;
    decodeBC7Block(block, x, y, w, h, rgba);
  }
}

function decodeUncompressedBGRA(src, off, w, h, rgba) {
  for (let y=0;y<h;y++) for (let x=0;x<w;x++) {
    const si=off+(y*w+x)*4, di=(y*w+x)*4;
    rgba[di]=src[si+2]; rgba[di+1]=src[si+1]; rgba[di+2]=src[si]; rgba[di+3]=src[si+3];
  }
}

function decodeUncompressedRGBA(src, off, w, h, rgba) {
  rgba.set(src.subarray(off, off+w*h*4));
}

function decodeL8(src, off, w, h, rgba) {
  for (let y=0;y<h;y++) for (let x=0;x<w;x++) {
    const l=src[off+y*w+x], o=(y*w+x)*4;
    rgba[o]=l; rgba[o+1]=l; rgba[o+2]=l; rgba[o+3]=255;
  }
}

function getFormatInfo(fmt, header = null) {
  if (fmt === "MASKED") {
    if (!header?.layout) return null;
    return { blockBytes: header.layout.bitCount >> 3, blockSize: 1, decode: createMaskedDecoder(header.layout) };
  }
  switch (fmt) {
    case "DXT1": return { blockBytes: 8, blockSize: 4, decode: decodeDXT1 };
    case "DXT3": return { blockBytes: 16, blockSize: 4, decode: decodeDXT3 };
    case "DXT5": return { blockBytes: 16, blockSize: 4, decode: decodeDXT5 };
    case "BC4":  return { blockBytes: 8, blockSize: 4, decode: decodeBC4 };
    case "BC5":  return { blockBytes: 16, blockSize: 4, decode: decodeBC5 };
    case "BC7":  return { blockBytes: 16, blockSize: 4, decode: decodeBC7 };
    case "BGRA": return { blockBytes: 4, blockSize: 1, decode: decodeUncompressedBGRA };
    case "RGBA": return { blockBytes: 4, blockSize: 1, decode: decodeUncompressedRGBA };
    case "L8":   return { blockBytes: 1, blockSize: 1, decode: decodeL8 };
    default: return null;
  }
}

function flipRows(rgba, w, h) {
  const stride = w * 4;
  const tmp = new Uint8Array(stride);
  for (let top = 0, bot = h - 1; top < bot; top++, bot--) {
    const tOff = top * stride, bOff = bot * stride;
    tmp.set(rgba.subarray(tOff, tOff + stride));
    rgba.copyWithin(tOff, bOff, bOff + stride);
    rgba.set(tmp, bOff);
  }
}

function getMipSize(w, h, info) {
  if (info.blockSize > 1) {
    return Math.ceil(w / info.blockSize) * Math.ceil(h / info.blockSize) * info.blockBytes;
  }
  return w * h * info.blockBytes;
}

/**
 * Pure DDS header/pixel decoding shared by the main thread and dds-worker.js.
 * No three.js here so the worker bundle stays small and this stays testable.
 */

// Textures at or below this size get GPU-generated mips instead of decoded ones.
export const MIP_DECODE_THRESHOLD = 1024;

export function parseDDSHeader(buffer) {
  const data = new Uint8Array(buffer);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  if (data.length < 128) return null;

  const magic = view.getUint32(0, true);
  if (magic !== DDS_MAGIC) return null;

  const headerSize = view.getUint32(4, true);
  if (headerSize !== 124) return null;

  const flags = view.getUint32(8, true);
  const height = view.getUint32(12, true);
  const width = view.getUint32(16, true);
  const mipMapCount = (flags & DDSD_MIPMAPCOUNT) ? view.getUint32(28, true) : 1;

  const pfFlags = view.getUint32(80, true);
  const pfFourCC = view.getUint32(84, true);
  const pfRGBBitCount = view.getUint32(88, true);
  let dataOffset = 128;
  let fmt = null;
  let srgb = false;
  let layout = null;

  if (pfFlags & DDPF_FOURCC) {
    if (pfFourCC === FOURCC_DX10) {
      if (data.length < 148) return null;
      const dxgiFormat = view.getUint32(128, true);
      dataOffset = 148;

      switch (dxgiFormat) {
        case DXGI.BC1_UNORM: fmt = "DXT1"; break;
        case DXGI.BC1_UNORM_SRGB: fmt = "DXT1"; srgb = true; break;
        case DXGI.BC2_UNORM: fmt = "DXT3"; break;
        case DXGI.BC2_UNORM_SRGB: fmt = "DXT3"; srgb = true; break;
        case DXGI.BC3_UNORM: fmt = "DXT5"; break;
        case DXGI.BC3_UNORM_SRGB: fmt = "DXT5"; srgb = true; break;
        case DXGI.BC4_UNORM: case DXGI.BC4_SNORM: fmt = "BC4"; break;
        case DXGI.BC5_UNORM: case DXGI.BC5_SNORM: fmt = "BC5"; break;
        case DXGI.BC7_UNORM: fmt = "BC7"; break;
        case DXGI.BC7_UNORM_SRGB: fmt = "BC7"; srgb = true; break;
        case DXGI.R8G8B8A8_UNORM: case DXGI.R8G8B8A8_UNORM_SRGB: fmt = "RGBA"; break;
        case DXGI.B8G8R8A8_UNORM: case DXGI.B8G8R8A8_UNORM_SRGB: fmt = "BGRA"; break;
        case DXGI.R8_UNORM: fmt = "L8"; break;
        default:
          if (MASKED_DXGI[dxgiFormat]) {
            fmt = "MASKED";
            layout = MASKED_DXGI[dxgiFormat];
            srgb = Boolean(layout.srgb);
            break;
          }
          console.warn("[DDS] Unsupported DXGI format:", dxgiFormat);
          return null;
      }
    } else {
      switch (pfFourCC) {
        case FOURCC_DXT1: fmt = "DXT1"; break;
        case FOURCC_DXT3: fmt = "DXT3"; break;
        case FOURCC_DXT5: fmt = "DXT5"; break;
        case FOURCC_ATI1: case FOURCC_BC4U: case FOURCC_BC4S: fmt = "BC4"; break;
        case FOURCC_ATI2: case FOURCC_BC5U: case FOURCC_BC5S: fmt = "BC5"; break;
        default:
          console.warn("[DDS] Unsupported FourCC:", String.fromCharCode(pfFourCC&0xFF, (pfFourCC>>8)&0xFF, (pfFourCC>>16)&0xFF, (pfFourCC>>24)&0xFF));
          return null;
      }
    }
  } else if (pfFlags & (DDPF_RGB | DDPF_LUMINANCE | DDPF_ALPHA)) {
    // Legacy uncompressed: honour the declared channel masks instead of
    // assuming BGRA, so A8B8G8R8, 16-bit and alpha-only maps decode correctly.
    if (![8, 16, 24, 32].includes(pfRGBBitCount)) {
      console.warn("[DDS] Unsupported uncompressed bit count:", pfRGBBitCount);
      return null;
    }
    const masks = [92, 96, 100, 104].map((offset) => view.getUint32(offset, true));
    if (!(pfFlags & DDPF_ALPHAPIXELS) && !(pfFlags & DDPF_ALPHA)) masks[3] = 0;
    const alphaOnly = Boolean(pfFlags & DDPF_ALPHA) && !(pfFlags & (DDPF_RGB | DDPF_LUMINANCE));
    if (alphaOnly && !masks[3] && pfRGBBitCount === 8) masks[3] = 0xff;
    fmt = "MASKED";
    layout = { bitCount: pfRGBBitCount, masks, luminance: Boolean(pfFlags & DDPF_LUMINANCE), alphaOnly };
  } else {
    console.warn("[DDS] Unsupported pixel format flags:", pfFlags.toString(16));
    return null;
  }

  const info = getFormatInfo(fmt, { layout });
  if (!info) return null;
  if (!width || !height) return null;

  const baseSize = getMipSize(width, height, info);
  if (dataOffset + baseSize > data.length) {
    console.warn("[DDS] Not enough data for base mip level");
    return null;
  }

  return { width, height, mipMapCount, fmt, srgb, dataOffset, blockBytes: info.blockBytes, blockSize: info.blockSize, layout };
}

/** Human-readable pixel format for error messages, e.g. "BC6H_UF16 (DXGI 95)". */
export function describeDdsPixelFormat(buffer) {
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (data.length < 128) return "truncated header";
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0, true) !== DDS_MAGIC) return "not a DDS file";
  const pfFlags = view.getUint32(80, true);
  if (pfFlags & DDPF_FOURCC) {
    const code = String.fromCharCode(data[84], data[85], data[86], data[87]);
    if (code !== "DX10") return `FourCC ${code}`;
    if (data.length < 148) return "DX10 header truncated";
    const dxgi = view.getUint32(128, true);
    return DXGI_NAMES[dxgi] ? `${DXGI_NAMES[dxgi]} (DXGI ${dxgi})` : `DXGI ${dxgi}`;
  }
  return `uncompressed ${view.getUint32(88, true)}-bit`;
}

export function isBlockCompressedFormat(fmt) {
  return fmt === "DXT1" || fmt === "DXT3" || fmt === "DXT5" || fmt === "BC4" || fmt === "BC5" || fmt === "BC7";
}

export function shouldDecodeMipChain(width, height) {
  return Math.max(width || 0, height || 0) > MIP_DECODE_THRESHOLD;
}

/**
 * Raw block-compressed mip levels (no decoding) for direct GPU upload.
 * Returns [] when the file is truncated at the base level.
 */
export function readCompressedMipmaps(buffer, header) {
  const data = new Uint8Array(buffer);
  const info = getFormatInfo(header.fmt, header);
  if (!info || info.blockSize === 1) return [];
  const mipmaps = [];
  let offset = header.dataOffset;
  let mw = header.width;
  let mh = header.height;
  for (let level = 0; level < Math.max(1, header.mipMapCount); level += 1) {
    const size = getMipSize(mw, mh, info);
    if (offset + size > data.length) break;
    mipmaps.push({ data: data.subarray(offset, offset + size), width: mw, height: mh });
    offset += size;
    if (mw === 1 && mh === 1) break;
    mw = Math.max(1, mw >> 1);
    mh = Math.max(1, mh >> 1);
  }
  return mipmaps;
}

/**
 * Decode the base level (and, when `decodeMips`, the remaining chain) to RGBA.
 * Rows are flipped so the result matches a flipY=true image upload, unless
 * `flipY` is false: native game materials sample the game's own UVs, which
 * expect the file's top row at v = 0, as the unflipped compressed upload does.
 */
export function decodeDDSLevels(buffer, { decodeMips = true, header = null, flipY = true } = {}) {
  const parsed = header || parseDDSHeader(buffer);
  if (!parsed) return null;
  const data = new Uint8Array(buffer);
  const info = getFormatInfo(parsed.fmt, parsed);
  if (!info) return null;
  const { width, height, mipMapCount, dataOffset } = parsed;

  const baseRgba = new Uint8Array(width * height * 4);
  info.decode(data, dataOffset, width, height, baseRgba);
  if (flipY) flipRows(baseRgba, width, height);
  const levels = [{ data: baseRgba, width, height }];

  if (decodeMips) {
    let mipOffset = dataOffset + getMipSize(width, height, info);
    let mw = width, mh = height;
    for (let level = 1; level < mipMapCount; level++) {
      mw = Math.max(1, mw >> 1);
      mh = Math.max(1, mh >> 1);
      const mipSize = getMipSize(mw, mh, info);
      if (mipOffset + mipSize > data.length) break;
      try {
        const mipRgba = new Uint8Array(mw * mh * 4);
        info.decode(data, mipOffset, mw, mh, mipRgba);
        if (flipY) flipRows(mipRgba, mw, mh);
        levels.push({ data: mipRgba, width: mw, height: mh });
      } catch {
        break;
      }
      mipOffset += mipSize;
    }
  }

  return { width, height, fmt: parsed.fmt, srgb: parsed.srgb, levels };
}
