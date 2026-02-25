import { useCallback, useEffect, useState } from "react";
import { check as checkForAppUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

const CHECK_INTERVAL = 30 * 60 * 1000;
const INITIAL_DELAY_MS = 5000;
const IS_DEV = typeof import.meta !== "undefined" && Boolean(import.meta.env?.DEV);

const INITIAL_STATE = {
  available: false,
  latest: null,
  notes: "",
  installing: false,
  checking: false,
  progressPercent: 0,
  error: "",
  lastChecked: null,
  dismissed: false,
};

const store = {
  state: { ...INITIAL_STATE },
  listeners: new Set(),
  initialized: false,
  timerId: null,
  initialDelayId: null,
  update: null,
  downloadedBytes: 0,
  totalBytes: 0,
  checkInFlight: false,
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

function mapInstallError(error) {
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

  return "Update installed but relaunch failed. Please restart Cortex Studio manually.";
}

function isInvalidReleaseJsonError(error) {
  const message = String(error || "").toLowerCase();
  return message.includes("valid release json");
}

async function runCheck({ manual = false } = {}) {
  if (!isTauriRuntime()) return;
  if (store.checkInFlight) return;

  store.checkInFlight = true;
  setStoreState((prev) => ({
    ...prev,
    checking: true,
    error: manual ? "" : prev.error,
  }));

  try {
    const update = await checkForAppUpdate();
    store.update = update;

    if (update) {
      emit({
        ...store.state,
        available: true,
        latest: update.version ?? null,
        notes: update.body ?? "",
        installing: false,
        checking: false,
        progressPercent: 0,
        error: "",
        lastChecked: Date.now(),
      });
    } else {
      emit({
        ...store.state,
        available: false,
        latest: null,
        notes: "",
        installing: false,
        checking: false,
        progressPercent: 0,
        error: "",
        lastChecked: Date.now(),
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
  if (store.initialized || !isTauriRuntime()) return;
  store.initialized = true;

  if (IS_DEV) return;

  store.initialDelayId = setTimeout(() => {
    runCheck({ manual: false });
  }, INITIAL_DELAY_MS);

  store.timerId = setInterval(() => {
    runCheck({ manual: false });
  }, CHECK_INTERVAL);
}

function dismissUpdateNotice() {
  setStoreState((prev) => ({ ...prev, dismissed: true }));
}

async function installUpdate() {
  if (!isTauriRuntime()) return false;

  const update = store.update;
  if (!update) return false;

  store.downloadedBytes = 0;
  store.totalBytes = 0;

  setStoreState((prev) => ({
    ...prev,
    installing: true,
    progressPercent: 0,
    error: "",
  }));

  try {
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        store.downloadedBytes = 0;
        store.totalBytes = Number(event.data?.contentLength || 0);
        setStoreState((prev) => ({ ...prev, progressPercent: 0 }));
        return;
      }

      if (event.event === "Progress") {
        store.downloadedBytes += Number(event.data?.chunkLength || 0);
        const nextTotal = Number(event.data?.contentLength || store.totalBytes || 0);
        if (nextTotal > 0) {
          store.totalBytes = nextTotal;
          const ratio = store.downloadedBytes / nextTotal;
          const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
          setStoreState((prev) => ({ ...prev, progressPercent: percent }));
        }
        return;
      }

      if (event.event === "Finished") {
        setStoreState((prev) => ({ ...prev, progressPercent: 100 }));
      }
    });

    store.update = null;
    setStoreState((prev) => ({
      ...prev,
      available: false,
      latest: null,
      notes: "",
      installing: false,
      checking: false,
      progressPercent: 100,
      error: "",
      dismissed: true,
    }));
    await relaunch();
    return true;
  } catch (error) {
    console.error("Failed to install update:", error);
    setStoreState((prev) => ({
      ...prev,
      installing: false,
      error: mapInstallError(error),
    }));
    return false;
  }
}

export function useUpdateChecker() {
  const [state, setState] = useState(store.state);

  useEffect(() => {
    ensureUpdaterInitialized();
    return subscribe(setState);
  }, []);

  const dismiss = useCallback(() => {
    dismissUpdateNotice();
  }, []);

  const checkNow = useCallback(() => {
    runCheck({ manual: true });
  }, []);

  const install = useCallback(async () => {
    return installUpdate();
  }, []);

  return { ...state, dismiss, install, checkNow };
}
