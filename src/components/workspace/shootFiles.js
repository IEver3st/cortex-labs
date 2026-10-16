import { useEffect, useState } from "react";
import { readFile } from "@tauri-apps/plugin-fs";

/* Loads Kit Shoot output for the review screen as blob URLs. Paths come from
   a manifest, which may have been opened from anywhere, so only plain paths
   inside the run folder are read. URLs are cached per run and revoked when
   the cache is disposed. */

const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", mp4: "video/mp4", webm: "video/webm" };

export function isSafeRunPath(path) {
  if (typeof path !== "string" || !path) return false;
  if (/^[a-z]:|^[\\/]|^\w+:/i.test(path)) return false;
  return !path.split(/[\\/]/).some((part) => part === ".." || part === "");
}

export function createShootFileCache(root) {
  const entries = new Map();
  let disposed = false;
  return {
    root,
    get(path) {
      if (!isSafeRunPath(path)) return Promise.reject(new Error("the path isn't inside the shoot folder"));
      if (!entries.has(path)) {
        const extension = path.split(".").pop().toLowerCase();
        const pending = readFile(`${root}/${path}`).then((bytes) => {
          const url = URL.createObjectURL(new Blob([bytes], { type: MIME[extension] || "application/octet-stream" }));
          if (disposed) {
            URL.revokeObjectURL(url);
            throw new Error("the review closed");
          }
          return url;
        });
        // A failed read can be retried later (the file may have been restored).
        pending.catch(() => entries.delete(path));
        entries.set(path, pending);
      }
      return entries.get(path);
    },
    dispose() {
      disposed = true;
      for (const pending of entries.values()) pending.then((url) => URL.revokeObjectURL(url), () => {});
      entries.clear();
    },
  };
}

/** `{ url, error }` for a run file; empty while it loads or when there is no path. */
export function useShootFile(cache, path) {
  const [state, setState] = useState({ path: "", url: "", error: "" });
  useEffect(() => {
    if (!cache || !path) return undefined;
    let live = true;
    cache.get(path).then(
      (url) => live && setState({ path, url, error: "" }),
      (error) => live && setState({ path, url: "", error: String(error?.message || error) }),
    );
    return () => {
      live = false;
    };
  }, [cache, path]);
  return state.path === path ? state : { path, url: "", error: "" };
}
