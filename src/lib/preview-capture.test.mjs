import assert from "node:assert/strict";
import test from "node:test";
import { captureViewerFrameBytes } from "./preview-capture.js";

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from([137, 80, 78, 71]).toString("base64")}`;

function fakeViewer() {
  const calls = [];
  return {
    calls,
    captureScreenshot: () => PNG_DATA_URL,
    captureFrame: (options) => {
      calls.push({ kind: "frame", ...options });
      return PNG_DATA_URL;
    },
    captureFrameBlob: async (options) => {
      calls.push({ kind: "blob", ...options });
      return new Blob([new Uint8Array([1, 2, 3])]);
    },
  };
}

test("a live-view capture with a watermark keeps the live view, not the 3/4 preset", async (t) => {
  // The watermark itself needs a DOM; without one the capture is saved unstamped.
  t.mock.method(console, "error", () => {});
  const viewer = fakeViewer();
  const bytes = await captureViewerFrameBytes(viewer, { watermark: { enabled: true, text: "Cortex" } });
  assert.deepEqual(Array.from(bytes), [137, 80, 78, 71]);
  assert.equal(viewer.calls.length, 1);
  assert.equal(viewer.calls[0].kind, "frame");
  assert.equal(viewer.calls[0].presetKey, null);
});

test("a live-view capture without a watermark reads the canvas as a blob", async () => {
  const viewer = fakeViewer();
  const bytes = await captureViewerFrameBytes(viewer, { watermark: null });
  assert.deepEqual(Array.from(bytes), [1, 2, 3]);
  assert.equal(viewer.calls[0].kind, "blob");
  assert.equal(viewer.calls[0].presetKey, null);
});

test("a preset capture passes its framing through on both paths", async (t) => {
  t.mock.method(console, "error", () => {});
  const plain = fakeViewer();
  await captureViewerFrameBytes(plain, { presetKey: "front", zoomFactor: 1.4 });
  assert.equal(plain.calls[0].presetKey, "front");
  assert.equal(plain.calls[0].zoomFactor, 1.4);

  const stamped = fakeViewer();
  await captureViewerFrameBytes(stamped, { presetKey: "side", zoomFactor: 0.8, watermark: { enabled: true, text: "Cortex" } });
  assert.equal(stamped.calls[0].presetKey, "side");
  assert.equal(stamped.calls[0].zoomFactor, 0.8);
});

test("no viewer, or a viewer that returns nothing, gives no bytes", async () => {
  assert.equal(await captureViewerFrameBytes(null), null);
  assert.equal(await captureViewerFrameBytes({ captureFrameBlob: async () => null }), null);
});
