import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export const JUNO_CHANGED = "cortex:juno-changed";

export function announceJunoChange() {
  window.dispatchEvent(new CustomEvent(JUNO_CHANGED));
}

export function junoError(error) {
  if (error && typeof error === "object" && typeof error.message === "string") {
    return { code: String(error.code || "error"), message: error.message };
  }
  return { code: "error", message: String(error || "Juno couldn't do that. Try again.") };
}

export async function callJuno(command, args) {
  try {
    return await invoke(command, args);
  } catch (raw) {
    const error = junoError(raw);
    if (error.code === "unauthorized") announceJunoChange();
    throw error;
  }
}

export function useJunoSignedIn(enabled = true) {
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setSignedIn(false);
      return undefined;
    }
    let alive = true;
    const refresh = () => {
      invoke("juno_local")
        .then((local) => { if (alive) setSignedIn(Boolean(local?.signedIn)); })
        .catch(() => { if (alive) setSignedIn(false); });
    };
    refresh();
    window.addEventListener(JUNO_CHANGED, refresh);
    return () => {
      alive = false;
      window.removeEventListener(JUNO_CHANGED, refresh);
    };
  }, [enabled]);
  return signedIn;
}
