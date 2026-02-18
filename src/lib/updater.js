import { useEffect, useRef, useState } from "react";
import { check as checkForAppUpdate } from "@tauri-apps/plugin-updater";

const CHECK_INTERVAL = 30 * 60 * 1000;
const INITIAL_DELAY_MS = 5000;

function isTauriRuntime() {
  return (
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__ !== "undefined" &&
    typeof window.__TAURI_INTERNALS__?.invoke === "function"
  );
}

export function useUpdateChecker() {
  const [state, setState] = useState({
    available: false,
    latest: null,
    notes: "",
    installing: false,
    progressPercent: 0,
    error: "",
  });
  const [dismissed, setDismissed] = useState(false);
  const timerRef = useRef(null);
  const updateRef = useRef(null);
  const downloadedBytesRef = useRef(0);
  const totalBytesRef = useRef(0);

  useEffect(() => {
    if (!isTauriRuntime()) return undefined;

    let cancelled = false;

    const checkForUpdates = async () => {
      try {
        const update = await checkForAppUpdate();
        if (cancelled) return;
        updateRef.current = update;

        if (update) {
          setState({
            available: true,
            latest: update.version ?? null,
            notes: update.body ?? "",
            installing: false,
            progressPercent: 0,
            error: "",
          });
        } else {
          setState((prev) => ({
            ...prev,
            available: false,
            latest: null,
            notes: "",
            installing: false,
            progressPercent: 0,
            error: "",
          }));
        }
      } catch (error) {
        console.error("Failed to check for updates:", error);
        setState((prev) => ({
          ...prev,
          error: "Unable to check for updates right now.",
          installing: false,
        }));
      }
    };

    const initialDelay = setTimeout(checkForUpdates, INITIAL_DELAY_MS);

    timerRef.current = setInterval(checkForUpdates, CHECK_INTERVAL);

    return () => {
      cancelled = true;
      clearTimeout(initialDelay);
      clearInterval(timerRef.current);
    };
  }, []);

  const dismiss = () => setDismissed(true);

  const install = async () => {
    if (!isTauriRuntime()) return false;

    const update = updateRef.current;
    if (!update) return false;

    downloadedBytesRef.current = 0;
    totalBytesRef.current = 0;

    setState((prev) => ({
      ...prev,
      installing: true,
      progressPercent: 0,
      error: "",
    }));

    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          downloadedBytesRef.current = 0;
          totalBytesRef.current = Number(event.data?.contentLength || 0);
          setState((prev) => ({ ...prev, progressPercent: 0 }));
          return;
        }

        if (event.event === "Progress") {
          downloadedBytesRef.current += Number(event.data?.chunkLength || 0);
          const nextTotal = Number(event.data?.contentLength || totalBytesRef.current || 0);
          if (nextTotal > 0) {
            totalBytesRef.current = nextTotal;
            const ratio = downloadedBytesRef.current / nextTotal;
            const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
            setState((prev) => ({ ...prev, progressPercent: percent }));
          }
          return;
        }

        if (event.event === "Finished") {
          setState((prev) => ({ ...prev, progressPercent: 100 }));
        }
      });

      updateRef.current = null;
      setDismissed(true);
      setState({
        available: false,
        latest: null,
        notes: "",
        installing: false,
        progressPercent: 100,
        error: "",
      });
      return true;
    } catch (error) {
      console.error("Failed to install update:", error);
      setState((prev) => ({
        ...prev,
        installing: false,
        error: "Update download/install failed.",
      }));
      return false;
    }
  };

  return { ...state, dismissed, dismiss, install };
}
