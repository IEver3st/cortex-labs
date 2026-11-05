import { decodeDDSLevels } from "./dds-decode.js";

export const MAX_DECODE_SIDE = 8192;

export async function decodeImageFile(bytes, ext) {
  if (ext === "dds") {
    const decoded = decodeDDSLevels(bytes, { decodeMips: false, flipY: false });
    if (!decoded?.levels?.length) throw new Error("this DDS format cannot be read");
    return { width: decoded.width, height: decoded.height, rgba: decoded.levels[0].data, dds: bytes };
  }
  if (ext === "tif" || ext === "tiff") {
    const mod = await import("utif");
    const UTIF = mod.default || mod;
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const ifds = UTIF.decode(buffer);
    if (!ifds?.length) throw new Error("the TIFF holds no image");
    UTIF.decodeImage(buffer, ifds[0]);
    return { width: ifds[0].width, height: ifds[0].height, rgba: new Uint8Array(UTIF.toRGBA8(ifds[0])) };
  }
  const bitmap = await createImageBitmap(new Blob([bytes]), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  try {
    if (bitmap.width > MAX_DECODE_SIDE || bitmap.height > MAX_DECODE_SIDE) return { width: bitmap.width, height: bitmap.height, rgba: null };
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: bitmap.width, height: bitmap.height, rgba: new Uint8Array(data.buffer) };
  } finally {
    bitmap.close();
  }
}
