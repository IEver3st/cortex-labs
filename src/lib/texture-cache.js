/**
 * Shared GPU texture cache used by the viewers.
 *
 * Entries are keyed by `path::flip` (never by reload token) so a file-watch
 * save replaces the previous decode instead of accumulating 4K textures.
 * A replaced texture that is still referenced by another viewer is "retired":
 * it leaves the map immediately and is disposed when its last ref is released.
 *
 * Eviction honours both an entry-count limit and an estimated byte budget.
 * The module is deliberately free of three.js imports so the math stays
 * testable under plain Node.
 */

export const DEFAULT_TEXTURE_CACHE_LIMIT = 16;
export const DEFAULT_TEXTURE_BYTE_BUDGET = 768 * 1024 * 1024;
// RGBA8 plus a full mip chain (1 + 1/4 + 1/16 + ... ~= 1.33).
const MIP_CHAIN_FACTOR = 1.33;

function readDimension(image, keys) {
  for (const key of keys) {
    const value = Number(image?.[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

export function getTextureCacheKey(path, flipY) {
  if (!path) return "";
  return `${path.toString()}::${flipY ? "fy" : "nf"}`;
}

export function estimateTextureBytes(texture) {
  const image = texture?.image;
  if (!image) return 0;
  const width = readDimension(image, ["width", "naturalWidth", "videoWidth"]);
  const height = readDimension(image, ["height", "naturalHeight", "videoHeight"]);
  if (!width || !height) return 0;
  return Math.ceil(width * height * 4 * MIP_CHAIN_FACTOR);
}

function finalDispose(entry) {
  const texture = entry?.texture;
  if (!texture) return;
  try {
    texture.userData?.releaseSource?.();
  } catch {}
  texture.dispose?.();
}

export function createTextureCache({
  limit = DEFAULT_TEXTURE_CACHE_LIMIT,
  byteBudget = DEFAULT_TEXTURE_BYTE_BUDGET,
  estimateBytes = estimateTextureBytes,
} = {}) {
  const entries = new Map();
  let totalBytes = 0;

  const entryOf = (texture) => texture?.userData?.cacheEntry || null;

  // `protect` is the entry that was just inserted: the caller retains it right
  // after `set`, so it must never be the victim of its own insertion.
  function prune(protect = null) {
    if (entries.size <= limit && totalBytes <= byteBudget) return;
    for (const [key, entry] of entries) {
      if (entries.size <= limit && totalBytes <= byteBudget) break;
      if (entry.refs > 0 || entry === protect) continue;
      entries.delete(key);
      totalBytes -= entry.bytes;
      finalDispose(entry);
    }
  }

  function get(key) {
    if (!key) return null;
    const entry = entries.get(key);
    if (!entry) return null;
    entries.delete(key);
    entries.set(key, entry);
    return entry.texture;
  }

  function getGeneration(key) {
    return entries.get(key)?.generation || 0;
  }

  function set(key, texture) {
    if (!key || !texture) return null;
    const existing = entries.get(key);
    if (existing && existing.texture === texture) {
      entries.delete(key);
      entries.set(key, existing);
      return existing;
    }
    let generation = 1;
    if (existing) {
      generation = existing.generation + 1;
      entries.delete(key);
      totalBytes -= existing.bytes;
      if (existing.refs > 0) {
        existing.retired = true;
      } else {
        finalDispose(existing);
      }
    }
    const bytes = Math.max(0, Number(estimateBytes(texture)) || 0);
    const entry = { key, texture, refs: 0, bytes, generation, retired: false };
    texture.userData = texture.userData || {};
    texture.userData.cacheKey = key;
    texture.userData.cacheEntry = entry;
    entries.set(key, entry);
    totalBytes += bytes;
    prune(entry);
    return entry;
  }

  function retain(texture) {
    const entry = entryOf(texture);
    if (!entry) return;
    entry.refs += 1;
  }

  function release(texture) {
    if (!texture) return;
    const entry = entryOf(texture);
    if (!entry) {
      finalDispose({ texture });
      return;
    }
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0) return;
    if (entry.retired) {
      finalDispose(entry);
      return;
    }
    prune();
  }

  function refsOf(texture) {
    return entryOf(texture)?.refs || 0;
  }

  function stats() {
    return { size: entries.size, totalBytes, limit, byteBudget };
  }

  return { get, set, retain, release, prune, refsOf, getGeneration, stats };
}
