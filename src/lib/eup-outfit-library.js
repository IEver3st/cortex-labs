/* ── Saved outfits ──
   One library for every EUP Studio session. Outfits used to live inside the
   workspace they were saved in, and opening EUP Studio again starts a new
   workspace, so they seemed to vanish. The first time the library is read it
   gathers the outfits saved in earlier workspaces. */

import { MAX_OUTFIT_PRESETS, normalizeOutfitPresets } from "./eup.js";
import { loadWorkspaces } from "./workspace.js";

export const OUTFIT_LIBRARY_KEY = "cortex-studio:eup-outfits.v1";
const GENDERS = ["male", "female"];

function uniqueName(name, taken) {
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n += 1) {
    const candidate = `${name.slice(0, 74)} (${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Outfit lists merged in order. An outfit already present by id is kept once;
 * a different outfit with a name in use gets a numbered name, so nothing is
 * silently dropped. Each ped keeps at most MAX_OUTFIT_PRESETS.
 */
export function mergeOutfitPresets(...sources) {
  const result = { male: [], female: [] };
  for (const gender of GENDERS) {
    const ids = new Set();
    const names = new Set();
    for (const source of sources) {
      for (const preset of normalizeOutfitPresets(source)[gender]) {
        if (result[gender].length >= MAX_OUTFIT_PRESETS) break;
        if (ids.has(preset.id)) continue;
        const name = uniqueName(preset.name, names);
        ids.add(preset.id);
        names.add(name.toLowerCase());
        result[gender].push(name === preset.name ? preset : { ...preset, name });
      }
    }
  }
  return result;
}

/** Outfits saved inside EUP Studio workspaces, oldest workspace first. */
export function workspaceOutfits(workspaces) {
  return Object.values(workspaces || {})
    .filter((workspace) => workspace?.page === "eupstudio" && workspace.state?.outfits)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .map((workspace) => workspace.state.outfits);
}

/**
 * The saved library from storage. Without one yet, it is built from the
 * outfits in earlier workspaces and written back.
 */
export function readOutfitLibrary(storage = globalThis.localStorage, workspaces = null) {
  let raw = null;
  try {
    raw = storage?.getItem(OUTFIT_LIBRARY_KEY) ?? null;
  } catch {
    raw = null;
  }
  if (raw !== null) {
    try {
      return { outfits: normalizeOutfitPresets(JSON.parse(raw)), migrated: false };
    } catch {
      // A damaged library is copied aside before the next save replaces it.
      try {
        storage.setItem(`${OUTFIT_LIBRARY_KEY}.damaged`, raw);
      } catch {}
      return { outfits: normalizeOutfitPresets(null), migrated: false, error: "The saved outfits could not be read. A copy was kept for recovery." };
    }
  }
  const outfits = mergeOutfitPresets(...workspaceOutfits(workspaces ?? loadWorkspaces()));
  const saved = writeOutfitLibrary(outfits, storage);
  return { outfits, migrated: true, ...(saved.ok ? {} : { error: saved.error }) };
}

export function writeOutfitLibrary(outfits, storage = globalThis.localStorage) {
  try {
    storage.setItem(OUTFIT_LIBRARY_KEY, JSON.stringify(normalizeOutfitPresets(outfits)));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error || "Storage is unavailable.") };
  }
}

/* Every open EUP tab reads the same library and hears each change. */
let cache = null;
const listeners = new Set();

function notify() {
  for (const listener of listeners) listener();
}

export function getOutfitLibrary() {
  if (!cache) cache = readOutfitLibrary();
  return cache.outfits;
}

/** The error from the first read, if the library could not be read or created. */
export function outfitLibraryError() {
  getOutfitLibrary();
  return cache.error || "";
}

export function subscribeOutfitLibrary(listener) {
  listeners.add(listener);
  const onStorage = (event) => {
    if (event.key !== OUTFIT_LIBRARY_KEY) return;
    cache = null;
    listener();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

/**
 * Changes the library and saves it at once. Returns the save result; a failed
 * save leaves the library as it was so the list never shows an unsaved outfit.
 */
export function updateOutfitLibrary(update) {
  const current = getOutfitLibrary();
  const next = normalizeOutfitPresets(typeof update === "function" ? update(current) : update);
  const saved = writeOutfitLibrary(next);
  if (!saved.ok) return saved;
  cache = { outfits: next, migrated: false };
  notify();
  return saved;
}
