import { invoke } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import { selectBaseGameAssets } from "../../lib/eup";
import { loadDrawableFromPath } from "../../lib/ped-assembly";

// Game-file exports shared by every character and every EUP tab: switching a
// ped back, or a second character on the same ped, does not export again.
const pedListingCache = new Map();
const pedExportCache = new Map();
const pedSkeletonCache = new Map();
const pedClipCache = new Map();

function cachedCall(cache, key, factory) {
  let promise = cache.get(key);
  if (!promise) {
    promise = factory();
    promise.catch(() => {
      if (cache.get(key) === promise) cache.delete(key);
    });
    cache.set(key, promise);
  }
  return promise;
}

export function getPedListing(ped) {
  return cachedCall(pedListingCache, ped, () => invoke("list_ped_assets", { ped }));
}

export function exportPedAsset(ped, entry) {
  const key = `${ped}|${entry.folder}|${entry.file}`;
  return cachedCall(pedExportCache, key, () =>
    invoke("export_ped_asset", { ped, folder: entry.folder, file: entry.file }),
  );
}

// Component drawables carry no skeleton; they are skinned against the ped's.
// The base head embeds a full copy of it, so it is the skeleton source.
export function getPedSkeleton(ped) {
  return cachedCall(pedSkeletonCache, ped, async () => {
    const listing = await getPedListing(ped);
    const { drawable } = selectBaseGameAssets(listing?.entries, ped, "head", 0);
    if (!drawable) throw new Error(`No base head for ${ped} in the game files`);
    const exported = await exportPedAsset(ped, drawable);
    const parsed = await loadDrawableFromPath(exported?.path, { readFile });
    if (!parsed?.skeleton?.bones?.length) throw new Error(`${drawable.file} has no skeleton`);
    return parsed.skeleton;
  });
}

export function getPedClip(dict, clip) {
  return cachedCall(pedClipCache, `${dict}/${clip}`, () => invoke("export_ped_clip", { dict, clip }));
}

/**
 * A clip by key: `game:<dict>/<clip>` from the game files (cached), or
 * `file:<path>\n<clip>` from the user's .ycd, read again on every call so a
 * re-exported file shows its new version.
 */
export function getClipByKey(key) {
  if (key.startsWith("file:")) {
    const [path, clip] = key.slice(5).split("\n");
    return invoke("export_ycd_file_clip", { path, clip });
  }
  const body = key.startsWith("game:") ? key.slice(5) : key;
  const slash = body.indexOf("/");
  return getPedClip(body.slice(0, slash), body.slice(slash + 1));
}

const gameClipListCache = new Map();
const searchCache = new Map();
const gamePropCache = new Map();

/** `{ dict, clips: [{ name, duration }] }` for a game dictionary. */
export function listGameClips(dict) {
  return cachedCall(gameClipListCache, dict, () => invoke("list_ped_clips", { dict }));
}

/** Clips in the user's .ycd; never cached, the file may have changed. */
export function listYcdFileClips(path) {
  return invoke("list_ycd_file_clips", { path });
}

function cachedSearch(command, field, query) {
  return cachedCall(searchCache, `${command}|${query}`, async () => {
    const result = await invoke(command, { query });
    return { names: Array.isArray(result?.[field]) ? result[field] : [], total: Number(result?.total) || 0 };
  });
}

/** Game animation dictionaries matching `query`: `{ names, total }`. */
export function searchAnimDicts(query) {
  return cachedSearch("search_anim_dicts", "dicts", query);
}

/** Game drawables (.ydr) matching `query`: `{ names, total }`. */
export function searchGameProps(query) {
  return cachedSearch("search_game_props", "props", query);
}

/** Extracts a game prop into the prop cache; resolves to `{ path, name }`. */
export function exportGameProp(name) {
  return cachedCall(gamePropCache, name, () => invoke("export_game_prop", { name }));
}

/** Drops a ped's listing and skeleton so the next request reads the game files again. */
export function forgetPedGameFiles(ped) {
  pedListingCache.delete(ped);
  pedSkeletonCache.delete(ped);
}

export function exportYtd(path) {
  // The native cache includes mtime and size. A path-only JS cache would keep
  // old exports after an artist saves the texture dictionary again.
  return invoke("export_ytd", { path });
}

const pedDescriptionCache = new Map();

/** Game ped models matching `query`: `{ names, total }`. */
export function searchPeds(query) {
  return cachedSearch("search_peds", "peds", query);
}

/**
 * A custom character's description: skeleton, components, props and the
 * files they live in. Game peds are cached for the session; the user's ped
 * files are described again on every call (the native side caches them while
 * the files are unchanged), so an edited ped shows its new variations.
 */
export function describeCharacter(model) {
  if (model?.kind === "game") {
    return cachedCall(pedDescriptionCache, model.ped, () => invoke("describe_game_ped", { ped: model.ped }));
  }
  if (model?.kind === "file") {
    return invoke("describe_ped_files", { paths: model.paths, ped: model.ped || null });
  }
  return Promise.reject(new Error("Freemode characters are not described by the bridge"));
}

/**
 * The bytes of one of the user's ped drawables, read natively: the native side
 * only serves `.ydd` files a ped description named this session, so a restored
 * ped on another drive needs no filesystem permission (and gets no write access).
 */
export function readPedDrawable(path) {
  return invoke("read_ped_drawable", { path });
}

/**
 * A file a description refers to (`files[index]`), ready to read: `{ path }`
 * for a drawable, `{ textures: [{ name, path }] }` for a texture dictionary.
 * Game files are exported into the ped cache; the user's drawables are read
 * where they are (through `readPedDrawable`) and their texture dictionaries go
 * through the .ytd export.
 */
export function fetchCharacterFile(description, index) {
  const ref = description?.files?.[index];
  if (!ref) return Promise.reject(new Error(`The ped description has no file ${index}`));
  if (ref.path) {
    return ref.kind === "ytd" ? exportYtd(ref.path) : Promise.resolve({ path: ref.path });
  }
  return exportPedAsset(description.ped, { folder: ref.folder || "", file: ref.file });
}
