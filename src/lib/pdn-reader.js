import { createWorkerClient, WORKER_TIMEOUT } from "./worker-client.js";

let client;
export async function readPdnLayersAsync(bytes) {
  if (typeof Worker === "undefined") {
    const { decodePdnLayers, decodePdn } = await import("./pdn.js");
    const result = decodePdnLayers(bytes);
    return result?.layers?.length ? { result } : { flat: decodePdn(bytes) };
  }
  client ||= createWorkerClient(() => new Worker(new URL("./pdn-worker.js", import.meta.url), { type: "module" }),
    { label: "Layered Paint.NET parser", timeoutMs: 90000 });
  const copy = bytes.slice();
  return client.request({ mode: "layers", bytes: copy }, [copy.buffer]);
}

let compositor;
/**
 * Flattens layers `readPdnLayersAsync` returned with Paint.NET's arithmetic,
 * drawing the layers whose `visible[index]` is true. Runs in a worker: the
 * layer images and `out` (an earlier result to reuse, or null) are moved
 * there and back rather than copied, so they are unusable until this settles
 * and lost if it rejects. Resolves { images (the layer images, in order),
 * data (RGBA) }. A drawn layer with an unknown blend mode is refused here,
 * before anything moves.
 */
export async function flattenPdnLayersAsync({ width, height, layers }, visible, out = null) {
  const { assertPdnLayersFlattenable, flattenPdnLayers } = await import("./pdn.js");
  const isVisible = (_, index) => Boolean(visible[index]);
  if (typeof Worker === "undefined") {
    const data = flattenPdnLayers({ width, height, layers }, isVisible, out);
    return { images: layers.map((layer) => layer.image), data };
  }
  assertPdnLayersFlattenable(layers, isVisible);
  compositor ||= createWorkerClient(() => new Worker(new URL("./pdn-worker.js", import.meta.url), { type: "module" }),
    { label: "Paint.NET layer compositor", timeoutMs: 90000 });
  const sent = layers.map(({ name, opacity, blendMode, blendDetail, image }) => ({ name, opacity, blendMode, blendDetail, image }));
  const buffers = new Set(sent.map((layer) => layer.image.buffer));
  if (out) buffers.add(out.buffer);
  const { images, data } = await compositor.request({ mode: "flatten", width, height, layers: sent, visible: [...visible], out }, [...buffers]);
  return { images, data };
}

function errorText(error) {
  if (typeof error === "string") return error;
  return error?.message || String(error || "Unknown error");
}

/** Why a flattened image `{ width, height, data }` can't be shown, or "". */
function imageProblem(result, decoder) {
  const width = Number(result?.width);
  const height = Number(result?.height);
  if (!result?.data || !(width > 0) || !(height > 0)) return `The ${decoder} returned no image.`;
  if (result.data.length < width * height * 4) return `The ${decoder} returned a truncated image.`;
  for (let index = 3; index < result.data.length; index += 4) {
    if (result.data[index] !== 0) return "";
  }
  return `The ${decoder} produced a fully transparent image.`;
}

/**
 * Why a flattened JS decode (`decodePdn`) can't be trusted, or "". It must
 * carry the layer list it read: a count that matches the header's and one
 * name per layer. A result without one did not come from the document reader.
 */
export function pdnDecodeProblem(result) {
  const problem = imageProblem(result, "Paint.NET decoder");
  if (problem) return problem;
  const count = result.layerCount;
  if (!Number.isInteger(count) || count < 1) return "The Paint.NET decoder did not read the layer list.";
  if (result.headerLayerCount != null && result.headerLayerCount !== count) {
    return `The Paint.NET decoder read ${count} layers but the file lists ${result.headerLayerCount}.`;
  }
  const names = result.layerNames;
  if (!Array.isArray(names) || names.length !== count || names.some((name) => typeof name !== "string" || !name.trim())) {
    return "The Paint.NET decoder's layer names don't match its layer list.";
  }
  return "";
}

/**
 * Picks the flattened image shown for a .pdn texture.
 *
 * 1. The JS decoder in a worker; its result is used only when it checks out
 *    (`pdnDecodeProblem`).
 * 2. In the desktop app (`decodeNative` given), the native decoder otherwise.
 *    Its refusal is final: the JS decoder already failed or was rejected, and
 *    retrying it on the main thread would only repeat that.
 * 3. Without a native decoder, the JS decoder on the main thread, unless the
 *    worker timed out (the same decode would then freeze the UI).
 *
 * `onFallback(reason)` hears why the worker's result was not used. Resolves
 * `{ image, source }`; rejects with the reason the last decoder gave.
 */
export async function selectPdnImage({ decodeInWorker, decodeNative = null, decodeOnMainThread = null, onFallback = null }) {
  let reason = "";
  let workerTimedOut = false;
  try {
    const result = await decodeInWorker?.();
    if (result) {
      reason = pdnDecodeProblem(result);
      if (!reason) return { image: result, source: "pdn-js-worker" };
    }
  } catch (error) {
    workerTimedOut = error?.code === WORKER_TIMEOUT;
    reason = errorText(error);
  }
  if (reason) onFallback?.(reason);

  if (decodeNative) {
    let result;
    try {
      result = await decodeNative();
    } catch (error) {
      throw new Error(errorText(error));
    }
    const problem = imageProblem(result, "native Paint.NET decoder");
    if (problem) throw new Error(problem);
    return { image: result, source: "pdn-tauri" };
  }

  if (decodeOnMainThread && !workerTimedOut) {
    let result;
    try {
      result = await decodeOnMainThread();
    } catch (error) {
      throw new Error(errorText(error));
    }
    const problem = pdnDecodeProblem(result);
    if (problem) throw new Error(problem);
    return { image: result, source: "pdn-js" };
  }

  throw new Error(reason || "No Paint.NET decoder is available.");
}
