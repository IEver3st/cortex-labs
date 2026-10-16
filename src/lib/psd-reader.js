import { createWorkerClient } from "./worker-client.js";

let client;
export async function readPsdAsync(bytes, options) {
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") {
    return (await import("ag-psd")).readPsd(bytes, options);
  }
  client ||= createWorkerClient(() => new Worker(new URL("./psd-worker.js", import.meta.url), { type: "module" }),
    { label: "Layered PSD parser", timeoutMs: 90000 });
  const copy = bytes.slice();
  const { psd } = await client.request({ mode: "tree", bytes: copy, options }, [copy.buffer]);
  if (!options?.skipLayerImageData) {
    const hydrate = (node) => {
      if (node.imageData) {
        const { width, height, data } = node.imageData;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width, height), 0, 0);
        node.canvas = canvas;
        delete node.imageData;
      }
      if (node.mask) hydrate(node.mask);
      if (node.realMask) hydrate(node.realMask);
      for (const child of node.children || []) hydrate(child);
    };
    hydrate(psd);
  }
  return psd;
}
