import { applyWatermarkToDataUrl } from "./watermark";

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
} = {}) {
  if (!viewerApi?.captureScreenshot) return null;

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
