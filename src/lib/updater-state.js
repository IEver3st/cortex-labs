export const UPDATE_PHASE = Object.freeze({
  HIDDEN: "hidden",
  DOWNLOADING: "downloading",
  READY: "ready",
  INSTALLING: "installing",
  ERROR: "error",
});

export function createDownloadMetrics() {
  return {
    downloadedBytes: 0,
    totalBytes: 0,
    progressPercent: 0,
    progressKnown: false,
  };
}

export function reduceDownloadEvent(metrics, event) {
  const current = metrics ?? createDownloadMetrics();

  if (event?.event === "Started") {
    const totalBytes = Math.max(0, Number(event.data?.contentLength) || 0);
    return {
      downloadedBytes: 0,
      totalBytes,
      progressPercent: 0,
      progressKnown: totalBytes > 0,
    };
  }

  if (event?.event === "Progress") {
    const chunkLength = Math.max(0, Number(event.data?.chunkLength) || 0);
    const downloadedBytes = current.downloadedBytes + chunkLength;
    const progressKnown = current.totalBytes > 0;
    const progressPercent = progressKnown
      ? Math.max(0, Math.min(100, Math.round((downloadedBytes / current.totalBytes) * 100)))
      : 0;

    return {
      ...current,
      downloadedBytes,
      progressPercent,
      progressKnown,
    };
  }

  if (event?.event === "Finished") {
    return {
      ...current,
      downloadedBytes: current.totalBytes || current.downloadedBytes,
      progressPercent: 100,
    };
  }

  return current;
}

export function getUpdatePhase(state) {
  if (!state?.available) return UPDATE_PHASE.HIDDEN;
  if (state.installing) return UPDATE_PHASE.INSTALLING;
  if (state.downloaded || state.installed) return UPDATE_PHASE.READY;
  if (state.error && !state.downloading) return UPDATE_PHASE.ERROR;
  return UPDATE_PHASE.DOWNLOADING;
}
