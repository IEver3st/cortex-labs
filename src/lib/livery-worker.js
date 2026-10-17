// Livery images off the main thread. `inspect` gives an image's size and a
// small PNG thumbnail; `build` fits it to each dictionary's livery size and
// encodes the DDS the write stages. The input is a file's bytes (`ext` says
// which decoder) or RGBA the PSD and PDN decoders already produced.

import { decodeDDSLevels } from "./dds-decode.js";
import { buildLiveryTexture, thumbnailRgba } from "./livery-texture.js";

const MAX_SIDE = 8192;

async function decodeFile(bytes, ext) {
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
  // Straight alpha and the file's own colours, as the game will sample them.
  const bitmap = await createImageBitmap(new Blob([bytes]), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  try {
    if (bitmap.width > MAX_SIDE || bitmap.height > MAX_SIDE) return { width: bitmap.width, height: bitmap.height, rgba: null };
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: bitmap.width, height: bitmap.height, rgba: new Uint8Array(data.buffer) };
  } finally {
    bitmap.close();
  }
}

async function thumbnailUrl(image) {
  const thumb = thumbnailRgba(image.rgba, image.width, image.height, 96);
  const canvas = new OffscreenCanvas(thumb.width, thumb.height);
  canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(thumb.data.buffer, thumb.data.byteOffset, thumb.data.length), thumb.width, thumb.height), 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new FileReaderSync().readAsDataURL(blob);
}

self.onmessage = async (event) => {
  const { id, op, targets } = event.data || {};
  try {
    const image = event.data.rgba
      ? { width: event.data.width, height: event.data.height, rgba: event.data.rgba }
      : await decodeFile(event.data.bytes, event.data.ext);
    if (!image.width || !image.height) throw new Error("the image is empty");
    if (image.width > MAX_SIDE || image.height > MAX_SIDE || !image.rgba) {
      throw new Error(`it is ${image.width} × ${image.height}; liveries go up to ${MAX_SIDE} × ${MAX_SIDE}`);
    }
    if (image.rgba.length !== image.width * image.height * 4) throw new Error("its pixels could not be read");
    if (op === "inspect") {
      self.postMessage({ id, width: image.width, height: image.height, thumb: await thumbnailUrl(image) });
      return;
    }
    if (op !== "build") throw new Error(`unknown livery worker request "${op}"`);
    const outputs = (targets || []).map((target) => buildLiveryTexture(image, target));
    // A DDS kept as it is backs several outputs; transfer each buffer once.
    const transfer = [...new Set(outputs.map((output) => output.bytes.buffer))];
    self.postMessage({ id, outputs }, transfer);
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
