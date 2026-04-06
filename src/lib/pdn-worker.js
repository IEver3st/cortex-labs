import { decodePdn } from "./pdn";

self.onmessage = (event) => {
  try {
    const payload = event?.data || {};
    const rawBytes = payload.bytes;
    const bytes = rawBytes instanceof Uint8Array
      ? rawBytes
      : rawBytes instanceof ArrayBuffer
        ? new Uint8Array(rawBytes)
        : null;

    if (!bytes || bytes.length === 0) {
      self.postMessage({ error: "PDN worker received invalid bytes." });
      return;
    }

    const result = decodePdn(bytes, { fast: true });
    if (!result || !result.data || result.width <= 0 || result.height <= 0) {
      self.postMessage({ error: "PDN worker decode produced no image." });
      return;
    }

    self.postMessage(
      {
        width: result.width,
        height: result.height,
        data: result.data,
      },
      [result.data.buffer],
    );
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
