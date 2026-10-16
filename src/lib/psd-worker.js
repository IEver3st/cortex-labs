import { initializeCanvas, readPsd } from "ag-psd";

// ag-psd needs a canvas factory even for image-data reads; workers have
// OffscreenCanvas and ImageData but no document.
initializeCanvas(
  (width, height) => new OffscreenCanvas(width, height),
  (width, height) => new ImageData(width, height),
);

self.onmessage = (event) => {
  const payload = event?.data || {};
  const { id } = payload;
  try {
    const raw = payload.bytes;
    const bytes = raw instanceof Uint8Array
      ? raw
      : raw instanceof ArrayBuffer
        ? new Uint8Array(raw)
        : null;
    if (!bytes || bytes.length === 0) {
      self.postMessage({ id, error: "PSD worker received invalid bytes." });
      return;
    }

    if (payload.mode === "tree") {
      const psd = readPsd(bytes, { ...payload.options, useImageData: true });
      const transfers = new Set();
      const visit = (value) => {
        if (ArrayBuffer.isView(value)) transfers.add(value.buffer);
        else if (value && typeof value === "object") for (const child of Object.values(value)) visit(child);
      };
      visit(psd);
      self.postMessage({ id, psd }, [...transfers]);
      return;
    }
    const psd = readPsd(bytes, {
      skipThumbnail: true,
      skipLayerImageData: true,
      useImageData: true,
    });
    const imageData = psd?.imageData;
    if (!imageData?.data || !imageData.width || !imageData.height) {
      self.postMessage({ id, missingComposite: true, width: psd?.width || 0, height: psd?.height || 0 });
      return;
    }
    const data = imageData.data instanceof Uint8ClampedArray || imageData.data instanceof Uint8Array
      ? imageData.data
      : new Uint8ClampedArray(imageData.data);
    self.postMessage(
      { id, width: imageData.width, height: imageData.height, bitsPerChannel: psd.bitsPerChannel, data },
      [data.buffer],
    );
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
