// Reads livery images for the Liveries panel and the write. Files are read
// through the desktop host; PSD and PDN go through their own decoders, and
// everything else is decoded, thumbnailed and encoded in the livery worker.

import { readFile } from "@tauri-apps/plugin-fs";
import { createWorkerClient } from "./worker-client.js";
import { decodePdnRgba, decodePsdRgba } from "./viewer-utils.js";

let client = null;
function liveryWorker() {
  client ||= createWorkerClient(
    () => new Worker(new URL("./livery-worker.js", import.meta.url), { type: "module" }),
    { label: "Livery worker", timeoutMs: 180_000 },
  );
  return client;
}

function extensionOf(path) {
  return (/\.([^.\\/]+)$/.exec(String(path || ""))?.[1] || "").toLowerCase();
}

async function workerInput(path) {
  const ext = extensionOf(path);
  const bytes = await readFile(path);
  if (ext === "psd" || ext === "pdn") {
    const image = ext === "psd" ? await decodePsdRgba(bytes) : await decodePdnRgba(bytes, path);
    const rgba = image.data.byteLength === image.data.buffer.byteLength ? image.data : image.data.slice();
    return { payload: { rgba, width: image.width, height: image.height }, transfer: [rgba.buffer] };
  }
  return { payload: { bytes, ext }, transfer: [bytes.buffer] };
}

function failure(error) {
  return new Error(String(error?.message || error || "it could not be read").replace(/\.$/, ""));
}

/** `{ width, height, thumb }` for an image file; `thumb` is a PNG data URL. */
export async function inspectLiveryImage(path) {
  try {
    const { payload, transfer } = await workerInput(path);
    const result = await liveryWorker().request({ op: "inspect", ...payload }, transfer);
    return { width: result.width, height: result.height, thumb: result.thumb };
  } catch (error) {
    throw failure(error);
  }
}

/**
 * The image at `path` built for each target `{ width, height, levels }`:
 * `[{ bytes, width, height, format, levels, passthrough }]`, in target order.
 */
export async function buildLiveryTextures(path, targets) {
  try {
    const { payload, transfer } = await workerInput(path);
    const result = await liveryWorker().request({ op: "build", targets: targets.map(({ width, height, levels }) => ({ width, height, levels })), ...payload }, transfer);
    return result.outputs;
  } catch (error) {
    throw failure(error);
  }
}
