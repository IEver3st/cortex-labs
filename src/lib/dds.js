/**
 * Standalone DDS file parser — handles DXT1/3/5, BC4, BC5, BC7, and
 * uncompressed formats with full mipmap chain support.
 *
 * Three.js's built-in DDSLoader only supports DXT1/3/5.  This parser
 * decodes all formats to RGBA and returns a THREE.DataTexture with
 * pre-decoded mipmaps so Three.js can use them directly.
 */

import * as THREE from "three";
import { decodeBC7Block } from "./bc7";

// ── DDS header constants ──
const DDS_MAGIC = 0x20534444; // "DDS "
const DDSD_MIPMAPCOUNT = 0x20000;
const DDPF_FOURCC = 0x4;
const DDPF_RGB = 0x40;
const DDPF_LUMINANCE = 0x20000;
const DDPF_ALPHA = 0x2;

// DX10 header resource dimension
const D3D10_RESOURCE_DIMENSION_TEXTURE2D = 3;

// FourCC helpers
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

// DXGI format enum values we care about
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
};

// ── Block decoders (reused from ytd.js patterns) ──

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

// ── Format info ──
function getFormatInfo(fmt) {
  // Returns { blockBytes, blockSize, decode }
  // blockSize: pixels per block edge (4 for compressed, 1 for uncompressed)
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

// Flip RGBA pixel rows vertically in-place (top-down → bottom-up)
// This avoids Three.js canvas-based flipY which can cause quality loss
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

// ── Main parser ──

/**
 * Parse a DDS file buffer and return a THREE.DataTexture with decoded RGBA
 * data and pre-decoded mipmaps.
 *
 * @param {ArrayBuffer} buffer - Raw DDS file data
 * @returns {THREE.DataTexture|null}
 */
export function parseDDS(buffer) {
  const data = new Uint8Array(buffer);
  const view = new DataView(buffer);

  if (data.length < 128) return null;

  // Validate magic
  const magic = view.getUint32(0, true);
  if (magic !== DDS_MAGIC) return null;

  // Parse header (starts at byte 4)
  const headerSize = view.getUint32(4, true);
  if (headerSize !== 124) return null;

  const flags = view.getUint32(8, true);
  const height = view.getUint32(12, true);
  const width = view.getUint32(16, true);
  // const pitchOrLinearSize = view.getUint32(20, true);
  // const depth = view.getUint32(24, true);
  const mipMapCount = (flags & DDSD_MIPMAPCOUNT) ? view.getUint32(28, true) : 1;

  // Pixel format at offset 76
  const pfFlags = view.getUint32(80, true);
  const pfFourCC = view.getUint32(84, true);
  const pfRGBBitCount = view.getUint32(88, true);
  // const pfRMask = view.getUint32(92, true);
  // const pfGMask = view.getUint32(96, true);
  // const pfBMask = view.getUint32(100, true);
  // const pfAMask = view.getUint32(104, true);

  let dataOffset = 128; // After 4-byte magic + 124-byte header
  let fmt = null;

  if (pfFlags & DDPF_FOURCC) {
    if (pfFourCC === FOURCC_DX10) {
      // DX10 extended header (20 bytes after main header)
      if (data.length < 148) return null;
      const dxgiFormat = view.getUint32(128, true);
      dataOffset = 148;

      switch (dxgiFormat) {
        case DXGI.BC1_UNORM: case DXGI.BC1_UNORM_SRGB: fmt = "DXT1"; break;
        case DXGI.BC2_UNORM: case DXGI.BC2_UNORM_SRGB: fmt = "DXT3"; break;
        case DXGI.BC3_UNORM: case DXGI.BC3_UNORM_SRGB: fmt = "DXT5"; break;
        case DXGI.BC4_UNORM: case DXGI.BC4_SNORM: fmt = "BC4"; break;
        case DXGI.BC5_UNORM: case DXGI.BC5_SNORM: fmt = "BC5"; break;
        case DXGI.BC7_UNORM: case DXGI.BC7_UNORM_SRGB: fmt = "BC7"; break;
        case DXGI.R8G8B8A8_UNORM: case DXGI.R8G8B8A8_UNORM_SRGB: fmt = "RGBA"; break;
        case DXGI.B8G8R8A8_UNORM: case DXGI.B8G8R8A8_UNORM_SRGB: fmt = "BGRA"; break;
        case DXGI.R8_UNORM: fmt = "L8"; break;
        default:
          console.warn("[DDS] Unsupported DXGI format:", dxgiFormat);
          return null;
      }
    } else {
      // Legacy FourCC
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
  } else if (pfFlags & DDPF_RGB) {
    if (pfRGBBitCount === 32) {
      fmt = "BGRA"; // Most common uncompressed DDS format
    } else {
      console.warn("[DDS] Unsupported RGB bit count:", pfRGBBitCount);
      return null;
    }
  } else if (pfFlags & DDPF_LUMINANCE) {
    fmt = "L8";
  } else if (pfFlags & DDPF_ALPHA) {
    fmt = "L8"; // Treat alpha-only as luminance
  } else {
    console.warn("[DDS] Unsupported pixel format flags:", pfFlags.toString(16));
    return null;
  }

  const info = getFormatInfo(fmt);
  if (!info) return null;

  console.log(`[DDS] Parsing: ${width}x${height}, format=${fmt}, mips=${mipMapCount}`);

  // Decode base level
  const baseSize = getMipSize(width, height, info);
  if (dataOffset + baseSize > data.length) {
    console.warn("[DDS] Not enough data for base mip level");
    return null;
  }

  const baseRgba = new Uint8Array(width * height * 4);
  info.decode(data, dataOffset, width, height, baseRgba);
  flipRows(baseRgba, width, height);

  // Decode mip levels
  const mipmaps = [];
  let mipOffset = dataOffset + baseSize;
  let mw = width, mh = height;

  for (let level = 1; level < mipMapCount; level++) {
    mw = Math.max(1, mw >> 1);
    mh = Math.max(1, mh >> 1);
    const mipSize = getMipSize(mw, mh, info);
    if (mipOffset + mipSize > data.length) break;

    try {
      const mipRgba = new Uint8Array(mw * mh * 4);
      info.decode(data, mipOffset, mw, mh, mipRgba);
      flipRows(mipRgba, mw, mh);
      mipmaps.push({ data: mipRgba, width: mw, height: mh });
    } catch {
      break;
    }
    mipOffset += mipSize;
  }

  // Create Three.js DataTexture — data is already flipped so flipY = false
  const texture = new THREE.DataTexture(baseRgba, width, height, THREE.RGBAFormat);
  texture.type = THREE.UnsignedByteType;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.userData = { ddsDecoded: true };

  if (mipmaps.length > 0) {
    texture.mipmaps = mipmaps;
    texture.generateMipmaps = false;
  } else {
    texture.generateMipmaps = true;
  }

  texture.needsUpdate = true;
  return texture;
}
