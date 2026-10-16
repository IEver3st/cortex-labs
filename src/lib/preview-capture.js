import { applyWatermarkToDataUrl, hasDrawableWatermark } from "./watermark.js";

function delay(ms) {
  const waitMs = Number(ms);
  if (!Number.isFinite(waitMs) || waitMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, waitMs));
}

export async function captureTemporaryViewerFrame(viewerApi, {
  presetKey = "angle",
  zoomFactor = 1,
  delayMs = 0,
  watermark = null,
  thumbWidth = 0,
} = {}) {
  if (!viewerApi?.captureScreenshot) return null;

  // Viewers that can shoot from a throwaway camera never disturb the live view.
  if (typeof viewerApi.captureFrame === "function") {
    if (delayMs) await delay(delayMs);
    let dataUrl = viewerApi.captureFrame({ presetKey, zoomFactor, thumbWidth }) || null;
    if (dataUrl && watermark?.enabled) {
      dataUrl = await applyWatermarkToDataUrl(dataUrl, watermark);
    }
    return dataUrl;
  }

  const viewState = viewerApi.getViewState?.() || null;

  try {
    if (presetKey) {
      viewerApi.setPreset?.(presetKey);
    }
    if (Number.isFinite(zoomFactor)) {
      viewerApi.setZoom?.(zoomFactor);
    }
    await delay(delayMs);
    let dataUrl = viewerApi.captureScreenshot() || null;
    if (dataUrl && watermark?.enabled) {
      dataUrl = await applyWatermarkToDataUrl(dataUrl, watermark);
    }
    return dataUrl;
  } finally {
    if (viewState && viewerApi.restoreViewState) {
      viewerApi.restoreViewState(viewState);
    }
  }
}

/**
 * PNG bytes for a preview frame: the live view when `presetKey` is empty, or
 * a framing preset. Without a watermark the canvas is read with toBlob (async,
 * no base64 round trip); the watermark path still composes on a data URL and
 * is decoded once.
 */
export async function captureViewerFrameBytes(viewerApi, { presetKey = null, zoomFactor, delayMs = 0, watermark = null } = {}) {
  if (!viewerApi) return null;
  const stampWatermark = hasDrawableWatermark(watermark);
  if (!stampWatermark && typeof viewerApi.captureFrameBlob === "function") {
    const blob = await viewerApi.captureFrameBlob({ presetKey, zoomFactor: Number.isFinite(zoomFactor) ? zoomFactor : 1 });
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  }
  if (!stampWatermark && typeof viewerApi.captureScreenshotBlob === "function") {
    const viewState = viewerApi.getViewState?.() || null;
    try {
      if (presetKey) viewerApi.setPreset?.(presetKey);
      if (presetKey && Number.isFinite(zoomFactor)) viewerApi.setZoom?.(zoomFactor);
      await delay(delayMs);
      const blob = await viewerApi.captureScreenshotBlob();
      if (!blob) return null;
      return new Uint8Array(await blob.arrayBuffer());
    } finally {
      if (viewState && viewerApi.restoreViewState) viewerApi.restoreViewState(viewState);
    }
  }
  // An explicit null keeps the live view: captureTemporaryViewerFrame treats
  // an omitted preset as the 3/4 shot and an omitted zoom as 1x.
  const dataUrl = await captureTemporaryViewerFrame(viewerApi, {
    presetKey: presetKey || null,
    zoomFactor: presetKey && Number.isFinite(zoomFactor) ? zoomFactor : null,
    delayMs,
    watermark,
  });
  if (!dataUrl) return null;
  const binary = atob(dataUrl.split(",")[1] || "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
