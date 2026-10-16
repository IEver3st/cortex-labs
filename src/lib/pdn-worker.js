import { decodePdn, decodePdnLayers, flattenPdnLayers } from "./pdn";

self.onmessage = (event) => {
  try {
    const payload = event?.data || {};
    const { id } = payload;

    // Layers decoded earlier ("layers" below) sent back with the variant's
    // visibility; the buffers are returned so the sender can keep them.
    if (payload.mode === "flatten") {
      const { width, height, layers, visible } = payload;
      const data = flattenPdnLayers({ width, height, layers }, (_, index) => Boolean(visible[index]), payload.out);
      const images = layers.map((layer) => layer.image);
      const buffers = new Set([...images.map((image) => image.buffer), data.buffer]);
      self.postMessage({ id, images, data }, [...buffers]);
      return;
    }

    const rawBytes = payload.bytes;
    const bytes = rawBytes instanceof Uint8Array
      ? rawBytes
      : rawBytes instanceof ArrayBuffer
        ? new Uint8Array(rawBytes)
        : null;

    if (!bytes || bytes.length === 0) {
      self.postMessage({ id, error: "PDN worker received invalid bytes." });
      return;
    }

    if (payload.mode === "layers") {
      const result = decodePdnLayers(bytes);
      if (result?.layers?.length) {
        const buffers = new Set(result.layers.map((layer) => layer.image?.buffer).filter(Boolean));
        self.postMessage({ id, result }, [...buffers]);
      } else {
        const flat = decodePdn(bytes);
        self.postMessage({ id, flat }, flat?.data ? [flat.data.buffer] : []);
      }
      return;
    }

    const result = decodePdn(bytes);
    if (!result || !result.data || result.width <= 0 || result.height <= 0) {
      self.postMessage({ id, error: "PDN worker decode produced no image." });
      return;
    }

    self.postMessage(
      {
        id,
        width: result.width,
        height: result.height,
        data: result.data,
        // The layer list that was read, so the caller can check it.
        layerCount: result.layerCount,
        headerLayerCount: result.headerLayerCount,
        layerNames: result.layerNames,
      },
      [result.data.buffer],
    );
  } catch (error) {
    self.postMessage({
      id: event?.data?.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
