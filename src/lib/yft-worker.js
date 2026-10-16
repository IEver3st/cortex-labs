import { parseYft } from "./yft.js";

self.onmessage = ({ data: { id, buffer, name, options } }) => {
  try {
    const drawable = parseYft(new Uint8Array(buffer), name, options);
    const transfers = new Set();
    const visit = (value) => {
      if (ArrayBuffer.isView(value)) transfers.add(value.buffer);
      else if (value && typeof value === "object") for (const child of Object.values(value)) visit(child);
    };
    visit(drawable);
    self.postMessage({ id, drawable }, [...transfers]);
  } catch (error) { self.postMessage({ id, error: String(error?.message || error) }); }
};
