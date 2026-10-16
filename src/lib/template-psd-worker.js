import { buildAutoTemplatePsdAsync } from "./template-psd";

self.onmessage = async (event) => {
  const payload = event?.data || {};
  const templateMap = payload?.templateMap;
  const options = payload?.options || {};

  try {
    const result = await buildAutoTemplatePsdAsync(templateMap, options);
    const bytes = result?.bytes instanceof Uint8Array
      ? result.bytes
      : result?.bytes instanceof ArrayBuffer
        ? new Uint8Array(result.bytes)
        : null;

    if (!result || !bytes || bytes.length === 0) {
      self.postMessage({ error: "Template worker returned invalid output." });
      return;
    }

    const overlayPngBytes = result.overlayPngBytes instanceof Uint8Array ? result.overlayPngBytes : null;
    self.postMessage(
      {
        result: {
          ...result,
          bytes,
          overlayPngBytes,
        },
      },
      overlayPngBytes ? [bytes.buffer, overlayPngBytes.buffer] : [bytes.buffer],
    );
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
