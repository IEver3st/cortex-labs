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

    self.postMessage(
      {
        result: {
          ...result,
          bytes,
        },
      },
      [bytes.buffer],
    );
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
