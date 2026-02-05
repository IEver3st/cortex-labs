/**
 * Web Worker for YTD parsing — offloads heavy decompression and texture
 * decoding from the main thread so the UI never freezes.
 *
 * Supports two message types:
 *   { type: "parse",  bytes: ArrayBuffer }          → metadata-only parse (fast)
 *   { type: "decode", bytes: ArrayBuffer, names: string[] } → decode specific textures
 */
import { parseYtd } from "./ytd";

self.onmessage = (e) => {
  const { type, bytes, names } = e.data;

  try {
    if (type === "decode") {
      // Phase 2: decode only the requested textures
      const textures = parseYtd(new Uint8Array(bytes), { decodeNames: names });

      if (!textures || Object.keys(textures).length === 0) {
        self.postMessage({ type: "decoded", textures: {} });
        return;
      }

      // Only return textures that were actually decoded (have rgba)
      const decoded = {};
      const transferable = [];
      for (const [name, tex] of Object.entries(textures)) {
        if (tex.rgba) {
          decoded[name] = tex;
          transferable.push(tex.rgba.buffer);
        }
      }

      self.postMessage({ type: "decoded", textures: decoded }, transferable);
    } else {
      // Phase 1 (default): metadata-only parse — no RGBA decoding
      const textures = parseYtd(new Uint8Array(bytes), { metadataOnly: true });

      if (!textures || Object.keys(textures).length === 0) {
        self.postMessage({ type: "parsed", error: "No textures found in YTD file." });
        return;
      }

      // Metadata only — no large buffers to transfer
      self.postMessage({ type: "parsed", textures });
    }
  } catch (err) {
    self.postMessage({ type: "error", error: err?.message || "Failed to parse YTD file." });
  }
};
