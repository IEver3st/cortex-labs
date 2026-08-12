import assert from "node:assert/strict";
import test from "node:test";
import {
  UPDATE_PHASE,
  createDownloadMetrics,
  getUpdatePhase,
  reduceDownloadEvent,
} from "./updater-state.js";

test("download progress follows the Tauri Started, Progress, and Finished contract", () => {
  let metrics = reduceDownloadEvent(createDownloadMetrics(), {
    event: "Started",
    data: { contentLength: 200 },
  });
  assert.deepEqual(metrics, {
    downloadedBytes: 0,
    totalBytes: 200,
    progressPercent: 0,
    progressKnown: true,
  });

  metrics = reduceDownloadEvent(metrics, {
    event: "Progress",
    data: { chunkLength: 75 },
  });
  assert.equal(metrics.downloadedBytes, 75);
  assert.equal(metrics.progressPercent, 38);

  metrics = reduceDownloadEvent(metrics, { event: "Finished" });
  assert.equal(metrics.downloadedBytes, 200);
  assert.equal(metrics.progressPercent, 100);
});

test("download progress stays indeterminate when the server omits content length", () => {
  let metrics = reduceDownloadEvent(createDownloadMetrics(), {
    event: "Started",
    data: { contentLength: 0 },
  });
  metrics = reduceDownloadEvent(metrics, {
    event: "Progress",
    data: { chunkLength: 64 },
  });

  assert.equal(metrics.downloadedBytes, 64);
  assert.equal(metrics.progressKnown, false);
  assert.equal(metrics.progressPercent, 0);

  metrics = reduceDownloadEvent(metrics, { event: "Finished" });
  assert.equal(metrics.progressPercent, 100);
});

test("toolbar phase prioritizes install, ready, and recoverable error states", () => {
  assert.equal(getUpdatePhase({ available: false }), UPDATE_PHASE.HIDDEN);
  assert.equal(getUpdatePhase({ available: true, downloading: true }), UPDATE_PHASE.DOWNLOADING);
  assert.equal(getUpdatePhase({ available: true, error: "offline" }), UPDATE_PHASE.ERROR);
  assert.equal(getUpdatePhase({ available: true, downloaded: true }), UPDATE_PHASE.READY);
  assert.equal(
    getUpdatePhase({ available: true, downloaded: true, installing: true }),
    UPDATE_PHASE.INSTALLING,
  );
});
