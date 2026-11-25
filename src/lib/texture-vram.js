// Read-only GPU VRAM estimator for loaded native textures / DDS assets.
// Pure functions — runs under node:test.

const HALF_BYTE_FORMATS = new Set(["DXT1", "BC1", "BC4", "ATI1"]);
const ONE_BYTE_FORMATS = new Set(["DXT3", "DXT5", "BC2", "BC3", "BC5", "BC7", "ATI2", "DX10"]);

function isPowerOfTwo(n) {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

export function formatLabelForDds({ fourCc = "", dxgiFormat = 0, source = "" } = {}) {
  const cc = String(fourCc || "").toUpperCase();
  if (dxgiFormat === 98 || dxgiFormat === 99) return "BC7";
  if (dxgiFormat === 71 || dxgiFormat === 72) return "BC1";
  if (dxgiFormat === 74 || dxgiFormat === 75) return "BC2";
  if (dxgiFormat === 77 || dxgiFormat === 78) return "BC3";
  if (dxgiFormat === 80 || dxgiFormat === 81) return "BC4";
  if (dxgiFormat === 83 || dxgiFormat === 84) return "BC5";
  if (cc === "DXT1" || cc === "DXT3" || cc === "DXT5" || cc === "ATI1" || cc === "ATI2") return cc;
  if (source === "dds-decoded") return "RGBA8";
  return cc || "RGBA8";
}

/**
 * Estimates uncompressed GPU VRAM in bytes for a texture based on dimensions,
 * block-compression format, and mipmap count.
 */
export function estimateTextureVram({ width = 0, height = 0, format = "RGBA8", mipmaps = 1 } = {}) {
  const w = Math.max(0, Math.round(Number(width) || 0));
  const h = Math.max(0, Math.round(Number(height) || 0));
  if (!w || !h) return 0;
  const fmt = String(format || "RGBA8").toUpperCase();
  let bpp = 4;
  if (HALF_BYTE_FORMATS.has(fmt)) bpp = 0.5;
  else if (ONE_BYTE_FORMATS.has(fmt)) bpp = 1;
  const baseBytes = w * h * bpp;
  const hasMips = Number(mipmaps) > 1;
  return Math.round(baseBytes * (hasMips ? 4 / 3 : 1));
}

export function formatVram(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KiB";
  const mib = bytes / (1024 * 1024);
  if (mib >= 1) return `${mib.toFixed(mib >= 10 ? 1 : 2)} MiB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
}

/**
 * Sorts textures largest GPU VRAM first and annotates optimization flags
 * (4K+, 2K+ on small props, missing mipmaps, non-power-of-two).
 */
export function summarizeTextureVram(textures, { smallProp = false } = {}) {
  const items = [];
  let totalBytes = 0;

  for (const entry of textures || []) {
    if (!entry) continue;
    const width = Math.round(Number(entry.width) || 0);
    const height = Math.round(Number(entry.height) || 0);
    const mipmaps = Math.max(1, Math.round(Number(entry.mipmaps) || 1));
    const format = entry.format || formatLabelForDds(entry);
    const vramBytes = estimateTextureVram({ width, height, format, mipmaps });
    totalBytes += vramBytes;

    const flags = [];
    const maxEdge = Math.max(width, height);
    if (maxEdge >= 4096) flags.push("4K+");
    else if (smallProp && maxEdge >= 2048) flags.push("2K on small prop");
    if (maxEdge > 128 && mipmaps <= 1) flags.push("No mipmaps");
    if (width > 0 && height > 0 && (!isPowerOfTwo(width) || !isPowerOfTwo(height))) flags.push("NPOT");

    items.push({
      name: entry.name || "texture",
      path: entry.path || "",
      width,
      height,
      mipmaps,
      format,
      vramBytes,
      flags,
    });
  }

  items.sort((a, b) => b.vramBytes - a.vramBytes || a.name.localeCompare(b.name));
  return {
    totalBytes,
    count: items.length,
    flaggedCount: items.filter((item) => item.flags.length > 0).length,
    items,
  };
}
