import { decodeDDSLevels } from "./dds-decode.js";

self.onmessage = (event) => {
  const payload = event?.data || {};
  const { id } = payload;
  try {
    const buffer = payload.buffer instanceof ArrayBuffer
      ? payload.buffer
      : ArrayBuffer.isView(payload.buffer)
        ? payload.buffer.buffer.slice(payload.buffer.byteOffset, payload.buffer.byteOffset + payload.buffer.byteLength)
        : null;
    if (!buffer) {
      self.postMessage({ id, error: "DDS worker received invalid bytes." });
      return;
    }
    const decoded = decodeDDSLevels(buffer, { decodeMips: Boolean(payload.decodeMips), flipY: payload.flipY !== false });
    if (!decoded?.levels?.length) {
      self.postMessage({ id, error: "DDS worker could not decode the texture." });
      return;
    }
    self.postMessage(
      { id, width: decoded.width, height: decoded.height, fmt: decoded.fmt, levels: decoded.levels },
      decoded.levels.map((level) => level.data.buffer),
    );
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
