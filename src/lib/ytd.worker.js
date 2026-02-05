/**
 * Web Worker for YTD parsing — offloads heavy decompression and texture
 * decoding from the main thread so the UI never freezes.
 *
 * Supports two message types:
 *   { type: "parse",  bytes: ArrayBuffer }          → metadata-only parse (fast)
 *   { type: "decode", bytes: ArrayBuffer, names: string[] } → decode specific textures
 *
 * Caching strategy:
 *   After the first "parse" or "decode" call, the decompressed resource data
 *   and parsed metadata are cached in module-scope variables.  Subsequent
 *   "decode" requests can skip decompression + metadata parsing entirely and
 *   jump straight to RGBA decoding for the requested texture names.
 */
import { parseYtd } from "./ytd";

// ─── Decompression / metadata cache ───
// Keyed by a simple hash of the first 64 bytes of the input buffer so we
// can detect when the underlying file has changed and invalidate.
let _cachedFingerprint = null;
let _cachedMetadata = null;    // { name: { width, height, format, mipCount, rgba: null, ... } }

function fingerprint(bytes) {
  // Fast fingerprint: length + first 64 bytes hashed via FNV-1a
  let h = 0x811c9dc5;
  const len = Math.min(bytes.length, 64);
  for (let i = 0; i < len; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return `${bytes.length}:${(h >>> 0).toString(36)}`;
}

self.onmessage = (e) => {
  const { type, bytes, names } = e.data;

  try {
    if (type === "decode") {
      const input = new Uint8Array(bytes);
      const fp = fingerprint(input);

      // Fast path: if we already have cached metadata for the same file,
      // only decode the requested textures (skips decompression + full parse).
      if (fp === _cachedFingerprint && _cachedMetadata) {
        // Filter to only names that exist in the cached metadata
        const validNames = names.filter((n) => {
          const lower = n.toLowerCase();
          return Object.keys(_cachedMetadata).some(
            (k) => k.toLowerCase() === lower
          );
        });

        if (validNames.length > 0) {
          const textures = parseYtd(input, { decodeNames: validNames });
          if (textures && Object.keys(textures).length > 0) {
            const decoded = {};
            const transferable = [];
            for (const [name, tex] of Object.entries(textures)) {
              if (tex.rgba) {
                decoded[name] = tex;
                transferable.push(tex.rgba.buffer);
              }
            }
            self.postMessage({ type: "decoded", textures: decoded }, transferable);
            return;
          }
        }
      }

      // Slow path: full parse + decode
      const textures = parseYtd(input, { decodeNames: names });

      if (!textures || Object.keys(textures).length === 0) {
        self.postMessage({ type: "decoded", textures: {} });
        return;
      }

      // Cache metadata (without rgba) for future requests
      _cachedFingerprint = fp;
      _cachedMetadata = {};
      for (const [name, tex] of Object.entries(textures)) {
        _cachedMetadata[name] = {
          name: tex.name,
          width: tex.width,
          height: tex.height,
          format: tex.format,
          mipCount: tex.mipCount,
        };
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
      const input = new Uint8Array(bytes);
      const textures = parseYtd(input, { metadataOnly: true });

      if (!textures || Object.keys(textures).length === 0) {
        self.postMessage({ type: "parsed", error: "No textures found in YTD file." });
        return;
      }

      // Cache metadata for future decode requests
      const fp = fingerprint(input);
      _cachedFingerprint = fp;
      _cachedMetadata = {};
      for (const [name, tex] of Object.entries(textures)) {
        _cachedMetadata[name] = {
          name: tex.name,
          width: tex.width,
          height: tex.height,
          format: tex.format,
          mipCount: tex.mipCount,
        };
      }

      // Metadata only — no large buffers to transfer
      self.postMessage({ type: "parsed", textures });
    }
  } catch (err) {
    self.postMessage({ type: "error", error: err?.message || "Failed to parse YTD file." });
  }
};
