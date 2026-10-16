import * as THREE from "three";
import {
  MIP_DECODE_THRESHOLD,
  decodeDDSLevels,
  parseDDSHeader,
  readCompressedMipmaps,
  shouldDecodeMipChain,
} from "./dds-decode.js";
import { createWorkerClient, WORKER_TIMEOUT } from "./worker-client.js";

export { MIP_DECODE_THRESHOLD, parseDDSHeader, shouldDecodeMipChain };

const S3TC_EXTENSION = "WEBGL_compressed_texture_s3tc";
const BPTC_EXTENSION = "EXT_texture_compression_bptc";
const RGTC_EXTENSION = "EXT_texture_compression_rgtc";

export function getCompressedTextureSupport(renderer) {
  const has = (name) => {
    try {
      return Boolean(renderer?.extensions?.has?.(name));
    } catch {
      return false;
    }
  };
  if (!renderer) return { s3tc: false, bptc: false, rgtc: false };
  return { s3tc: has(S3TC_EXTENSION), bptc: has(BPTC_EXTENSION), rgtc: has(RGTC_EXTENSION) };
}

/**
 * GPU format for a raw upload, or null when the decode path must be used.
 * BC4/BC5 intentionally stay on the decode path: the decoder expands them to
 * grey / reconstructed-normal RGB, which an RGTC upload would not reproduce.
 */
export function selectCompressedFormat(fmt, support) {
  switch (fmt) {
    case "DXT1": return support?.s3tc ? THREE.RGBA_S3TC_DXT1_Format : null;
    case "DXT3": return support?.s3tc ? THREE.RGBA_S3TC_DXT3_Format : null;
    case "DXT5": return support?.s3tc ? THREE.RGBA_S3TC_DXT5_Format : null;
    case "BC7": return support?.bptc ? THREE.RGBA_BPTC_Format : null;
    default: return null;
  }
}

function applyCommonSettings(texture) {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.userData = { ...(texture.userData || {}), ddsDecoded: true };
  texture.needsUpdate = true;
  return texture;
}

function createCompressedTexture(buffer, header, format) {
  const mipmaps = readCompressedMipmaps(buffer, header);
  if (!mipmaps.length) return null;
  const texture = new THREE.CompressedTexture(mipmaps, header.width, header.height, format);
  applyCommonSettings(texture);
  texture.generateMipmaps = false;
  texture.minFilter = mipmaps.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  // Compressed blocks cannot be row-flipped like the decoded path, so the
  // vertical flip is applied through the per-texture UV transform instead.
  texture.repeat.set(1, -1);
  texture.offset.set(0, 1);
  texture.userData.ddsCompressed = true;
  return texture;
}

function createDecodedTexture(decoded) {
  if (!decoded?.levels?.length) return null;
  const [base, ...rest] = decoded.levels;
  const texture = new THREE.DataTexture(base.data, decoded.width, decoded.height, THREE.RGBAFormat);
  texture.type = THREE.UnsignedByteType;
  applyCommonSettings(texture);
  if (rest.length > 0) {
    texture.mipmaps = decoded.levels;
    texture.generateMipmaps = false;
  } else {
    texture.generateMipmaps = true;
  }
  texture.needsUpdate = true;
  return texture;
}

function tryCompressed(buffer, header, options) {
  if (!options?.renderer) return null;
  const format = selectCompressedFormat(header.fmt, getCompressedTextureSupport(options.renderer));
  if (!format) return null;
  return createCompressedTexture(buffer, header, format);
}

function logHeader(header, options, mode) {
  if (options.log === false) return;
  console.log(`[DDS] Parsing: ${header.width}x${header.height}, format=${header.fmt}, mips=${header.mipMapCount}, ${mode}`);
}

/**
 * Synchronous parse. Pass `{ renderer }` to upload supported block formats
 * without decoding; otherwise the pixels are decoded on the calling thread.
 */
export function parseDDS(buffer, options = {}) {
  const header = parseDDSHeader(buffer);
  if (!header) return null;

  const compressed = tryCompressed(buffer, header, options);
  if (compressed) {
    logHeader(header, options, "gpu-compressed");
    return compressed;
  }

  const decodeMips = options.decodeMips ?? shouldDecodeMipChain(header.width, header.height);
  logHeader(header, options, decodeMips ? "decode+mips" : "decode");
  return createDecodedTexture(decodeDDSLevels(buffer, { decodeMips, header, flipY: options.flipY !== false }));
}

let ddsWorkerClient = null;
function getDdsWorkerClient() {
  if (typeof Worker === "undefined") return null;
  if (!ddsWorkerClient) {
    ddsWorkerClient = createWorkerClient(
      () => new Worker(new URL("./dds-worker.js", import.meta.url), { type: "module" }),
      { label: "DDS worker", timeoutMs: 45_000 },
    );
  }
  return ddsWorkerClient;
}

/**
 * Async parse for the viewers: compressed upload when the renderer supports
 * the format, otherwise the decode runs in a worker. It falls back to the main
 * thread when no worker is available or the worker fails; a timed-out decode
 * is rejected.
 */
export async function parseDDSAsync(buffer, options = {}) {
  const header = parseDDSHeader(buffer);
  if (!header) return null;

  const compressed = tryCompressed(buffer, header, options);
  if (compressed) {
    logHeader(header, options, "gpu-compressed");
    return compressed;
  }

  const decodeMips = options.decodeMips ?? shouldDecodeMipChain(header.width, header.height);
  const flipY = options.flipY !== false;
  logHeader(header, options, decodeMips ? "worker-decode+mips" : "worker-decode");

  const client = getDdsWorkerClient();
  if (client) {
    try {
      const copy = buffer.slice(0);
      const result = await client.request({ buffer: copy, decodeMips, flipY }, [copy]);
      if (result?.levels?.length) {
        return createDecodedTexture({
          width: result.width,
          height: result.height,
          fmt: result.fmt,
          levels: result.levels.map((level) => ({
            data: level.data instanceof Uint8Array ? level.data : new Uint8Array(level.data),
            width: level.width,
            height: level.height,
          })),
        });
      }
    } catch (error) {
      // A decode that used up its time in the worker would block the UI at
      // least as long here, so it fails instead.
      if (error?.code === WORKER_TIMEOUT) throw error;
      console.warn("[DDS] Worker decode failed, decoding on the main thread:", error);
    }
  }

  return createDecodedTexture(decodeDDSLevels(buffer, { decodeMips, header, flipY }));
}
