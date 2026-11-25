import { parseYft } from "./yft.js";
import { createWorkerPool } from "./worker-client.js";

let pool;
function getYftPool() {
  if (!pool) {
    const cores = typeof navigator !== "undefined" && Number.isFinite(navigator.hardwareConcurrency)
      ? navigator.hardwareConcurrency
      : 4;
    const size = Math.max(2, Math.min(4, cores - 1));
    pool = createWorkerPool(
      () => new Worker(new URL("./yft-worker.js", import.meta.url), { type: "module" }),
      { size, label: "Model parser", timeoutMs: 90000 },
    );
  }
  return pool;
}

export async function parseYftAsync(bytes, name, options) {
  if (typeof Worker === "undefined") return parseYft(bytes, name, options);
  // Callers may reuse the source for full-dictionary template geometry.
  const buffer = ArrayBuffer.isView(bytes)
    ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    : bytes.slice(0);
  return (await getYftPool().request({ buffer, name, options }, [buffer])).drawable;
}
