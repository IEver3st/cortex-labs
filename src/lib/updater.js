import { useCallback, useEffect, useState } from "react";
import { getVersion as getAppVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { check as checkForAppUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import tauriConfig from "../../src-tauri/tauri.conf.json";
import { createDownloadMetrics, reduceDownloadEvent } from "./updater-state";

const CHECK_INTERVAL = 30 * 60 * 1000;
const IS_DEV = typeof import.meta !== "undefined" && Boolean(import.meta.env?.DEV);
const PREVIEW_UPDATE_MODE = IS_DEV
  ? String(import.meta.env?.VITE_PREVIEW_UPDATE ?? "").trim().toLowerCase()
  : "";
const UPDATER_ENDPOINT = tauriConfig?.plugins?.updater?.endpoints?.[0] ?? "";

const PREVIEW_UPDATE_VERSION = "4.2.0";
const PREVIEW_UPDATE_BODY = "Preview mode — no update package will be downloaded or installed.";

const INITIAL_STATE = {
  available: false,
  latest: null,
  notes: "",
  downloading: false,
  downloaded: false,
  installed: false,
  installing: false,
  checking: false,
  progressPercent: 0,
  progressKnown: false,
  error: "",
  lastChecked: null,
  currentVersion: null,
  publishedLatest: null,
  statusKind: "idle",
  statusNote: "",
};

const store = {
  state: { ...INITIAL_STATE },
  listeners: new Set(),
  initialized: false,
  timerId: null,
  update: null,
  downloadMetrics: createDownloadMetrics(),
  downloadInFlight: null,
  installInFlight: null,
  previewMode: "",
  previewTimerId: null,
  checkInFlight: false,
  currentVersionPromise: null,
};

function isTauriRuntime() {
  return (
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__ !== "undefined" &&
    typeof window.__TAURI_INTERNALS__?.invoke === "function"
  );
}

function emit(nextState) {
  store.state = nextState;
  store.listeners.forEach((listener) => listener(store.state));
}

function setStoreState(updater) {
  const nextState =
    typeof updater === "function"
      ? updater(store.state)
      : { ...store.state, ...updater };
  emit(nextState);
}

function compareVersions(left, right) {
  const leftParts = String(left || "")
    .replace(/^v/i, "")
    .split(".")
    .map((part) => {
      const match = String(part).match(/^(\d+)/);
      return match ? Number(match[1]) : 0;
    });
  const rightParts = String(right || "")
    .replace(/^v/i, "")
    .split(".")
    .map((part) => {
      const match = String(part).match(/^(\d+)/);
      return match ? Number(match[1]) : 0;
    });
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue > rightValue) return 1;
    if (leftValue < rightValue) return -1;
  }

  return 0;
}

async function ensureCurrentVersionLoaded() {
  if (!isTauriRuntime()) return null;
  if (store.state.currentVersion) return store.state.currentVersion;
  if (store.currentVersionPromise) return store.currentVersionPromise;

  store.currentVersionPromise = getAppVersion()
    .then((version) => {
      if (typeof version === "string" && version.trim()) {
        setStoreState((prev) => ({ ...prev, currentVersion: version.trim() }));
        return version.trim();
      }
      return null;
    })
    .catch(() => null)
    .finally(() => {
      store.currentVersionPromise = null;
    });

  return store.currentVersionPromise;
}

async function inspectPublishedRelease(currentVersion) {
  if (!isTauriRuntime() || !UPDATER_ENDPOINT) return null;

  try {
    const feed = await invoke("inspect_updater_release", { endpoint: UPDATER_ENDPOINT });
    const publishedLatest =
      typeof feed?.version === "string" && feed.version.trim() ? feed.version.trim() : null;

    if (!publishedLatest) {
      return {
        publishedLatest: null,
        statusKind: "unknown",
        statusNote: "",
      };
    }

    if (currentVersion) {
      const comparison = compareVersions(currentVersion, publishedLatest);
      if (comparison > 0) {
        return {
          publishedLatest,
          statusKind: "ahead",
          statusNote: `Installed v${currentVersion} is newer than the published updater feed (v${publishedLatest}). Push and publish a newer GitHub release to test updates.`,
        };
      }
      if (comparison === 0) {
        return {
          publishedLatest,
          statusKind: "latest",
          statusNote: `Published feed version: v${publishedLatest}.`,
        };
      }
    }

    return {
      publishedLatest,
      statusKind: "unknown",
      statusNote: "",
    };
  } catch {
    return null;
  }
}

function subscribe(listener) {
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

function mapUpdateCheckError(error) {
  const message = String(error || "").toLowerCase();
  if (message.includes("valid release json")) {
    return "Update feed is unavailable right now.";
  }
  return "Unable to reach update server.";
}

function mapDownloadError(error) {
  const message = String(error || "").toLowerCase();

  if (message.includes("404")) {
    return "Update download failed (404). The release asset URL in latest.json is missing.";
  }
  if (message.includes("403")) {
    return "Update download was denied (403). Check release visibility and asset permissions.";
  }
  if (message.includes("signature")) {
    return "Update package signature verification failed.";
  }
  if (message.includes("download request failed")) {
    return "Update download failed. Check latest.json URL and release assets.";
  }

  return "Update download failed. Check your connection and try again.";
}

function mapInstallError(error) {
  const message = String(error || "").toLowerCase();
  if (message.includes("signature")) {
    return "Update package signature verification failed.";
  }
  return "Update could not be installed. Try again or restart Cortex Studio manually.";
}

function isInvalidReleaseJsonError(error) {
  const message = String(error || "").toLowerCase();
  return message.includes("valid release json");
}

function normalizePreviewUpdateMode(value) {
  if (["1", "true", "available", "ready"].includes(value)) return "ready";
  if (["downloading", "progress"].includes(value)) return "downloading";
  if (["error", "failed"].includes(value)) return "error";
  if (["installing", "updating"].includes(value)) return "installing";
  return "";
}

function getPreviewUpdateState(mode) {
  const common = {
    available: true,
    latest: PREVIEW_UPDATE_VERSION,
    notes: PREVIEW_UPDATE_BODY,
    downloading: false,
    downloaded: false,
    installed: false,
    installing: false,
    checking: false,
    progressPercent: 100,
    progressKnown: true,
    error: "",
    lastChecked: Date.now(),
    currentVersion: "4.1.0",
    publishedLatest: PREVIEW_UPDATE_VERSION,
    statusKind: "available",
    statusNote: "Preview update state",
  };

  if (mode === "downloading") {
    return {
      ...common,
      downloading: true,
      progressPercent: 62,
      statusNote: "Preview download progress",
    };
  }

  if (mode === "error") {
    return {
      ...common,
      progressPercent: 0,
      progressKnown: false,
      error: "Preview download failed. Choose Retry update to test the recovery state.",
      statusNote: "Preview download error",
    };
  }

  if (mode === "installing") {
    return {
      ...common,
      downloaded: true,
      installing: true,
      statusNote: "Preview install and relaunch state",
    };
  }

  return {
    ...common,
    downloaded: true,
    statusNote: "Preview ready-to-restart state",
  };
}

function initializePreviewUpdater() {
  const mode = normalizePreviewUpdateMode(PREVIEW_UPDATE_MODE);
  if (!mode) return false;

  store.previewMode = mode;
  store.update = {
    version: PREVIEW_UPDATE_VERSION,
    currentVersion: "4.1.0",
    body: PREVIEW_UPDATE_BODY,
  };
  emit({ ...store.state, ...getPreviewUpdateState(mode) });

  if (mode === "installing") {
    store.previewTimerId = setTimeout(() => {
      setStoreState((prev) => ({ ...prev, installing: false, error: "" }));
      store.previewTimerId = null;
    }, 2400);
  }

  return true;
}

function startPreviewDownload() {
  if (store.previewTimerId) clearTimeout(store.previewTimerId);

  setStoreState((prev) => ({
    ...prev,
    downloading: true,
    downloaded: false,
    installed: false,
    installing: false,
    progressPercent: 62,
    progressKnown: true,
    error: "",
  }));

  store.previewTimerId = setTimeout(() => {
    setStoreState((prev) => ({
      ...prev,
      downloading: false,
      downloaded: true,
      progressPercent: 100,
      progressKnown: true,
      error: "",
    }));
    store.previewTimerId = null;
  }, 1200);
}

async function runCheck({ manual = false } = {}) {
  if (!isTauriRuntime()) return;
  if (store.checkInFlight || store.state.available) return;

  store.checkInFlight = true;
  setStoreState((prev) => ({
    ...prev,
    checking: true,
    error: manual ? "" : prev.error,
  }));

  try {
    const currentVersion = await ensureCurrentVersionLoaded();
    const update = await checkForAppUpdate();
    store.update = update;

    if (update) {
      const resolvedCurrentVersion =
        typeof update.currentVersion === "string" && update.currentVersion.trim()
          ? update.currentVersion.trim()
          : currentVersion ?? store.state.currentVersion;
      emit({
        ...store.state,
        available: true,
        latest: update.version ?? null,
        notes: update.body ?? "",
        downloading: true,
        downloaded: false,
        installed: false,
        installing: false,
        checking: false,
        progressPercent: 0,
        progressKnown: false,
        error: "",
        lastChecked: Date.now(),
        currentVersion: resolvedCurrentVersion,
        publishedLatest: update.version ?? null,
        statusKind: "available",
        statusNote: "",
      });
      void downloadUpdate();
    } else {
      const diagnostics = await inspectPublishedRelease(currentVersion ?? store.state.currentVersion);
      emit({
        ...store.state,
        available: false,
        latest: null,
        notes: "",
        downloading: false,
        downloaded: false,
        installed: false,
        installing: false,
        checking: false,
        progressPercent: 0,
        progressKnown: false,
        error: "",
        lastChecked: Date.now(),
        currentVersion: currentVersion ?? store.state.currentVersion,
        publishedLatest: diagnostics?.publishedLatest ?? store.state.publishedLatest,
        statusKind: diagnostics?.statusKind ?? "latest",
        statusNote: diagnostics?.statusNote ?? "",
      });
    }
  } catch (error) {
    if (manual && !isInvalidReleaseJsonError(error)) {
      console.error("Failed to check for updates:", error);
    }
    setStoreState((prev) => ({
      ...prev,
      checking: false,
      error: manual ? mapUpdateCheckError(error) : prev.error,
      lastChecked: Date.now(),
    }));
  } finally {
    store.checkInFlight = false;
  }
}

function ensureUpdaterInitialized() {
  if (store.initialized) return;
  store.initialized = true;

  if (initializePreviewUpdater()) return;
  if (!isTauriRuntime()) return;

  void ensureCurrentVersionLoaded();

  if (IS_DEV) return;

  void runCheck({ manual: false });

  store.timerId = setInterval(() => {
    runCheck({ manual: false });
  }, CHECK_INTERVAL);
}

async function downloadUpdate() {
  if (store.previewMode) {
    if (store.previewMode === "error") {
      startPreviewDownload();
      return false;
    }
    setStoreState((prev) => ({
      ...prev,
      downloading: false,
      downloaded: true,
      progressPercent: 100,
      progressKnown: true,
      error: "",
    }));
    return true;
  }

  if (!isTauriRuntime()) return false;
  const update = store.update;
  if (!update) return false;
  if (store.downloadInFlight) return store.downloadInFlight;

  const task = (async () => {
    store.downloadMetrics = createDownloadMetrics();

    setStoreState((prev) => ({
      ...prev,
      available: true,
      downloading: true,
      downloaded: false,
      installed: false,
      installing: false,
      progressPercent: 0,
      progressKnown: false,
      error: "",
    }));

    try {
      await update.download((event) => {
        const previousMetrics = store.downloadMetrics;
        const nextMetrics = reduceDownloadEvent(previousMetrics, event);
        store.downloadMetrics = nextMetrics;

        if (
          nextMetrics.progressPercent !== previousMetrics.progressPercent ||
          nextMetrics.progressKnown !== previousMetrics.progressKnown ||
          event.event === "Started" ||
          event.event === "Finished"
        ) {
          setStoreState((prev) => ({
            ...prev,
            progressPercent: nextMetrics.progressPercent,
            progressKnown: nextMetrics.progressKnown,
          }));
        }
      });

      setStoreState((prev) => ({
        ...prev,
        downloading: false,
        downloaded: true,
        progressPercent: 100,
        error: "",
      }));
      return true;
    } catch (error) {
      console.error("Failed to download update:", error);
      setStoreState((prev) => ({
        ...prev,
        downloading: false,
        downloaded: false,
        progressPercent: 0,
        progressKnown: false,
        error: mapDownloadError(error),
      }));
      return false;
    }
  })();

  store.downloadInFlight = task;
  try {
    return await task;
  } finally {
    if (store.downloadInFlight === task) store.downloadInFlight = null;
  }
}

async function installUpdate() {
  if (store.previewMode) {
    if (store.previewTimerId) clearTimeout(store.previewTimerId);
    setStoreState((prev) => ({ ...prev, installing: true, error: "" }));
    store.previewTimerId = setTimeout(() => {
      setStoreState((prev) => ({
        ...prev,
        installing: false,
        downloaded: false,
        installed: true,
        error: "",
      }));
      store.previewTimerId = null;
    }, 1200);
    return true;
  }

  if (!isTauriRuntime()) return false;
  if (store.installInFlight) return store.installInFlight;

  const update = store.update;
  if (!update || (!store.state.downloaded && !store.state.installed)) return false;

  const task = (async () => {
    setStoreState((prev) => ({
      ...prev,
      installing: true,
      error: "",
    }));

    try {
      if (!store.state.installed) {
        await update.install();
        setStoreState((prev) => ({
          ...prev,
          downloaded: false,
          installed: true,
        }));
      }

      await relaunch();
      return true;
    } catch (error) {
      console.error("Failed to install or relaunch update:", error);
      setStoreState((prev) => ({
        ...prev,
        installing: false,
        error: prev.installed
          ? "Update installed. Restart Cortex Studio manually to finish."
          : mapInstallError(error),
      }));
      return false;
    }
  })();

  store.installInFlight = task;
  try {
    return await task;
  } finally {
    if (store.installInFlight === task) store.installInFlight = null;
  }
}

export function useUpdateChecker() {
  const [state, setState] = useState(store.state);

  useEffect(() => {
    const unsubscribe = subscribe(setState);
    ensureUpdaterInitialized();
    return unsubscribe;
  }, []);

  const checkNow = useCallback(() => {
    runCheck({ manual: true });
  }, []);

  const download = useCallback(async () => {
    return downloadUpdate();
  }, []);

  const install = useCallback(async () => {
    return installUpdate();
  }, []);

  return { ...state, download, install, checkNow };
}
