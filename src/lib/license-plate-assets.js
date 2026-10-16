import { decodeDDSLevels } from "./dds-decode.js";
import {
  composePlateImage,
  fitPlateImageSize,
  normalizePlateDefinitions,
  normalizePlateImage,
  plateComposeScale,
} from "./license-plate.js";

// Game plate textures and definitions, exported once by the bridge (Tauri
// command export_plate_textures) and decoded on demand. Shared by every viewer.

const FONT_TEXTURE = "vehicle_generic_plate_font";

let assetsPromise = null;
const decoded = new Map();

/** Resolves { definitions, texturePaths } or rejects with the bridge's error. */
export function loadPlateAssets(invoke) {
  if (!assetsPromise) {
    assetsPromise = Promise.resolve()
      .then(() => invoke("export_plate_textures"))
      .then((listing) => {
        const definitions = normalizePlateDefinitions(listing?.definitions);
        if (!definitions.plates.length) throw new Error("The game's carcols.ymt defines no license plates.");
        const texturePaths = new Map(
          (Array.isArray(listing?.textures) ? listing.textures : [])
            .filter((texture) => texture?.name && texture?.path)
            .map((texture) => [texture.name.toLowerCase(), texture.path]),
        );
        if (!texturePaths.has(FONT_TEXTURE)) throw new Error("The plate font texture was not found in the game files.");
        return { definitions, texturePaths };
      })
      .catch((error) => {
        // Let a later request retry (for example after the GTA path is fixed).
        assetsPromise = null;
        throw error;
      });
  }
  return assetsPromise;
}

async function decodeTexture(path, readFile) {
  if (!decoded.has(path)) {
    decoded.set(path, readFile(path).then((bytes) => {
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const level = decodeDDSLevels(buffer, { decodeMips: false })?.levels?.[0];
      if (!level) throw new Error(`Unsupported plate texture format: ${path}`);
      return level;
    }).catch((error) => {
      decoded.delete(path);
      throw error;
    }));
  }
  return decoded.get(path);
}

const customDecoded = new Map();
const CUSTOM_CACHE_LIMIT = 4;

function fileName(path) {
  return String(path).split(/[\\/]/).pop() || String(path);
}

// PNG, JPEG and WebP decode through the webview; rows come back top first and
// are flipped to the bottom-first layout composePlateImage reads.
async function decodeBitmap(bytes) {
  const bitmap = await createImageBitmap(new Blob([bytes]));
  try {
    const { width, height } = fitPlateImageSize(bitmap.width, bitmap.height);
    const canvas = typeof OffscreenCanvas === "function"
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement("canvas"), { width, height });
    const context = canvas.getContext("2d");
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, width, height);
    const top = context.getImageData(0, 0, width, height).data;
    const data = new Uint8Array(top.length);
    const stride = width * 4;
    for (let y = 0; y < height; y += 1) data.set(top.subarray(y * stride, (y + 1) * stride), (height - 1 - y) * stride);
    return { data, width, height };
  } finally {
    bitmap.close?.();
  }
}

/**
 * Decodes the user's plate image (read only; the file is never changed).
 * Cached per path and import stamp so typing plate text does not re-read it.
 */
async function decodeCustomPlateImage(image, readFile) {
  const key = `${image.path}|${image.stamp}`;
  if (!customDecoded.has(key)) {
    const job = readFile(image.path).then(async (bytes) => {
      if (/\.dds$/i.test(image.path)) {
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const level = decodeDDSLevels(buffer, { decodeMips: false })?.levels?.[0];
        if (!level) throw new Error("unsupported DDS format");
        fitPlateImageSize(level.width, level.height);
        return level;
      }
      return decodeBitmap(bytes);
    }).catch((error) => {
      customDecoded.delete(key);
      throw new Error(`Couldn't read the plate image ${fileName(image.path)}: ${error?.message || error}. Import it again.`);
    });
    customDecoded.set(key, job);
    while (customDecoded.size > CUSTOM_CACHE_LIMIT) customDecoded.delete(customDecoded.keys().next().value);
  }
  return customDecoded.get(key);
}

/**
 * Composes the plate image for { style, text, image } from the game's assets.
 * A custom `image` ({ path, stamp }) replaces the style's background; the
 * style still sets the font colour, outline and text box.
 */
export async function buildPlateImage({ style, text, image }, { invoke, readFile }) {
  const { definitions, texturePaths } = await loadPlateAssets(invoke);
  const plate = definitions.plates.find((entry) => entry.index === style)
    || definitions.plates.find((entry) => entry.index === definitions.defaultIndex)
    || definitions.plates[0];
  const custom = normalizePlateImage(image);
  const backgroundPath = custom ? null : texturePaths.get(plate.diffuse.toLowerCase());
  if (!custom && !backgroundPath) throw new Error(`Plate texture ${plate.diffuse} was not found in the game files.`);
  const [background, font] = await Promise.all([
    custom ? decodeCustomPlateImage(custom, readFile) : decodeTexture(backgroundPath, readFile),
    decodeTexture(texturePaths.get(FONT_TEXTURE), readFile),
  ]);
  const scale = custom ? plateComposeScale(background) : 2;
  return composePlateImage({ background, font, plate, text, offsets: definitions.offsets, scale });
}
