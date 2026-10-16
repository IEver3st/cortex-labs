import { parseYft } from "./yft.js";
import { createWorkerClient } from "./worker-client.js";

let client;
export async function parseYftAsync(bytes, name, options) {
  if (typeof Worker === "undefined") return parseYft(bytes, name, options);
  client ||= createWorkerClient(() => new Worker(new URL("./yft-worker.js", import.meta.url), { type: "module" }),
    { label: "Model parser", timeoutMs: 90000 });
  // Callers may reuse the source for full-dictionary template geometry.
  const buffer = ArrayBuffer.isView(bytes)
    ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes.slice(0);
  return (await client.request({ buffer, name, options }, [buffer])).drawable;
}
