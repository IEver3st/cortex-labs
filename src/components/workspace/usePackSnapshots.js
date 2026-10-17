import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const READ_CONCURRENCY = 4;
// Paths per index lookup; vehicle_snapshots.rs refuses more than 5000 at once.
const INDEX_CHUNK = 1000;
// Reads landing within this long show together, so a large pack re-renders a
// few times while it fills in rather than once per snapshot.
const PUBLISH_MS = 80;

/* The snapshots the Pack view shows for a folder's vehicles, as object URLs
   keyed by model path. `vehicles` is null while the folder is being listed
   again, which keeps what is shown; a listing then reads only snapshots that
   are new or changed. `save` keeps a new one. Every URL is revoked when it is
   replaced, when its vehicle leaves the list, and on unmount. */
export default function usePackSnapshots(vehicles, enabled) {
  const [urls, setUrls] = useState({});
  const [index, setIndex] = useState({ ready: false, taken: {} });
  // path -> { url, taken }
  const cacheRef = useRef(new Map());
  const publishTimerRef = useRef(0);
  const listing = vehicles == null;
  const paths = useMemo(() => (vehicles || []).map((vehicle) => vehicle.path), [vehicles]);
  const key = listing ? null : paths.join("\n");

  const publish = useCallback(() => {
    if (publishTimerRef.current) return;
    publishTimerRef.current = setTimeout(() => {
      publishTimerRef.current = 0;
      const next = {};
      for (const [path, entry] of cacheRef.current) next[path] = entry.url;
      setUrls(next);
    }, PUBLISH_MS);
  }, []);

  useEffect(() => {
    if (enabled && listing) return undefined;
    const cache = cacheRef.current;
    const keep = new Set(enabled ? paths : []);
    for (const [path, entry] of cache) {
      if (keep.has(path)) continue;
      URL.revokeObjectURL(entry.url);
      cache.delete(path);
    }
    publish();
    if (!enabled || !paths.length) {
      setIndex({ ready: false, taken: {} });
      return undefined;
    }
    let cancelled = false;
    setIndex((current) => ({ ...current, ready: false }));
    (async () => {
      const times = [];
      for (let at = 0; at < paths.length; at += INDEX_CHUNK) {
        times.push(...(await invoke("vehicle_snapshot_index", { modelPaths: paths.slice(at, at + INDEX_CHUNK) })));
        if (cancelled) return;
      }
      const taken = {};
      paths.forEach((path, at) => {
        if (times[at] != null) taken[path] = times[at];
      });
      setIndex({ ready: true, taken });
      const stale = paths.filter((path) => taken[path] != null && cache.get(path)?.taken !== taken[path]);
      let next = 0;
      const readNext = async () => {
        while (!cancelled && next < stale.length) {
          const path = stale[next++];
          try {
            const bytes = await invoke("read_vehicle_snapshot", { modelPath: path });
            if (cancelled || !bytes?.byteLength) continue;
            const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
            const old = cache.get(path);
            // A snapshot saved while this one was read is newer; keep it.
            if (old && old.taken > taken[path]) {
              URL.revokeObjectURL(url);
              continue;
            }
            if (old) URL.revokeObjectURL(old.url);
            cache.set(path, { url, taken: taken[path] });
            publish();
          } catch (error) {
            console.warn("[pack] snapshot not read:", path, error);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, stale.length) }, readNext));
    })().catch((error) => {
      // Without the index the pack can't tell which vehicles have a snapshot,
      // so it offers no pass rather than one that retakes every vehicle.
      if (!cancelled) console.warn("[pack] snapshot index failed:", error);
    });
    return () => {
      cancelled = true;
    };
    // `key` stands for `paths` and `listing`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key, publish]);

  useEffect(() => () => {
    clearTimeout(publishTimerRef.current);
    publishTimerRef.current = 0;
    for (const entry of cacheRef.current.values()) URL.revokeObjectURL(entry.url);
    cacheRef.current.clear();
  }, []);

  /** Keeps a JPEG blob as the snapshot of `path`; resolves false when it could not be saved. */
  const save = useCallback(async (path, blob) => {
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const taken = await invoke("save_vehicle_snapshot", { modelPath: path, jpeg: Array.from(bytes) });
      const cache = cacheRef.current;
      const old = cache.get(path);
      if (old) URL.revokeObjectURL(old.url);
      cache.set(path, { url: URL.createObjectURL(blob), taken });
      publish();
      setIndex((current) => ({ ...current, taken: { ...current.taken, [path]: taken } }));
      return true;
    } catch (error) {
      console.warn("[pack] snapshot not saved:", path, error);
      return false;
    }
  }, [publish]);

  return { urls, ready: index.ready, taken: index.taken, save };
}
