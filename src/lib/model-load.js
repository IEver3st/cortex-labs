/**
 * Model-load helpers for the viewers: the parsed-model cache identity and the
 * CodeWalker bridge's non-fatal warnings. Free of three.js so Node tests can
 * import them.
 */

/**
 * Cache key for a parsed model: the path plus the file's modification time and
 * size (a plugin-fs `stat` result), so a model saved again is parsed again.
 * `variant` separates parses of the same file that differ in content, such as
 * the bridge and the JS parser. Null when the file identity is unknown; the
 * caller must then neither reuse nor store a cached parse.
 */
export function getModelCacheKey(path, info, variant = "") {
  if (!path || info?.mtime == null || info?.size == null) return null;
  const mtime = info.mtime instanceof Date ? info.mtime.getTime() : Number(info.mtime);
  const size = Number(info.size);
  if (!Number.isFinite(mtime) || !Number.isFinite(size)) return null;
  const key = `${path}::${mtime}::${size}`;
  return variant ? `${key}::${variant}` : key;
}

/**
 * Identity of the parse a `parse_yft` result points at: the bridge cache key
 * plus the modification time and size of its `manifest.json` (a plugin-fs
 * `stat` result). The native side parses the model again when a texture
 * dictionary or meta file it read has changed, and that rewrites the manifest
 * under the same cache key, so a model built from an older parse never matches.
 * Null when either part is unknown; the caller must then neither reuse nor
 * store a cached model.
 */
export function getBridgeParseIdentity(result, manifestInfo) {
  const cacheKey = typeof result?.cacheKey === "string" ? result.cacheKey.trim() : "";
  if (!cacheKey) return null;
  return getModelCacheKey(cacheKey, manifestInfo);
}

/**
 * Key for the in-memory model built from a load of `path`: per bridge parse
 * when the bridge returned one (`bridgeResult` with its manifest's `stat`), or
 * per file version for a model the JS parser read. Null disables the cache.
 */
export function getLoadedModelCacheKey(path, fileInfo, { bridgeResult = null, manifestInfo = null } = {}) {
  if (!bridgeResult) return getModelCacheKey(path, fileInfo, "direct");
  const identity = getBridgeParseIdentity(bridgeResult, manifestInfo);
  return identity ? getModelCacheKey(path, fileInfo, `bridge:${identity}`) : null;
}

/**
 * The `warnings` a `parse_yft` result carries: problems the bridge worked
 * around while still producing a model. Tolerates results without the field.
 */
export function readBridgeWarnings(result) {
  const list = Array.isArray(result?.warnings) ? result.warnings : [];
  const warnings = list
    .filter((warning) => typeof warning === "string")
    .map((warning) => warning.trim())
    .filter(Boolean);
  return [...new Set(warnings)];
}

/** What a `parse_yft` stopped by `cancel_bridge_request` rejects with. */
export const BRIDGE_CANCELLED = "Bridge request cancelled.";

/** True when a bridge rejection is a cancel, which is not an error to report. */
export function isBridgeCancelled(error) {
  const message = typeof error === "string" ? error : error?.message;
  return message === BRIDGE_CANCELLED;
}

let tokenCount = 0;

/** A `requestToken`: 1-64 characters of [A-Za-z0-9_-], unique while in flight. */
export function createBridgeRequestToken() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  tokenCount += 1;
  return `parse-${Date.now().toString(36)}-${tokenCount.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** How long a parse nobody waits for any more keeps running before it is cancelled. */
export const ORPHANED_PARSE_GRACE_MS = 2000;
// A cancel can reach the native side before the parse has registered its
// token (it answers "none"); it is repeated while the parse is still pending.
const CANCEL_ATTEMPTS = 5;
const CANCEL_RETRY_MS = 100;

function abortError() {
  const error = new Error("Model loading was cancelled.");
  error.name = "AbortError";
  return error;
}

/**
 * CodeWalker bridge parses (`parse_yft`) shared by every caller, so a load that
 * is replaced can stop its parse without stopping one another load still
 * waits for.
 *
 * `parse(path, { force, signal })` joins a parse of the same model that is
 * still pending (a forced parse also serves a plain request, never the other
 * way round), or starts one with a fresh request token. When `signal`
 * aborts, that caller's promise rejects with an AbortError at once, and the
 * parse is orphaned if nobody else waits for it. An orphaned parse is
 * cancelled when a parse of another model starts (which would otherwise
 * queue behind it) or after `graceMs`; a load of the same model within that
 * time, such as a viewer that remounted, joins it instead. A parse that has
 * finished is never cancelled.
 *
 * Cancelling a running parse kills the bridge process, so the next archive
 * request repeats its game-file scan: only an abandoned parse is cancelled.
 */
export function createBridgeParses({
  invoke,
  graceMs = ORPHANED_PARSE_GRACE_MS,
  createToken = createBridgeRequestToken,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const pending = new Map();
  const wait = (ms) => new Promise((resolve) => { setTimer(resolve, ms); });

  const sendCancel = async (entry) => {
    for (let attempt = 0; attempt < CANCEL_ATTEMPTS && !entry.settled; attempt += 1) {
      if (attempt > 0) await wait(CANCEL_RETRY_MS);
      if (entry.settled) return;
      const state = await invoke("cancel_bridge_request", { token: entry.token });
      if (state !== "none") return;
    }
  };

  const cancel = (entry) => {
    if (entry.settled || entry.cancelled) return;
    entry.cancelled = true;
    clearTimer(entry.timer);
    if (pending.get(entry.key) === entry) pending.delete(entry.key);
    sendCancel(entry).catch((error) => {
      console.warn("[bridge] Could not cancel a replaced model parse:", error);
    });
  };

  return function parse(path, { force = false, signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortError());
    const forcedKey = `force:${path}`;
    const key = force ? forcedKey : `auto:${path}`;
    let entry = pending.get(forcedKey) || pending.get(key) || null;
    // Orphans would run ahead of this request on the bridge.
    for (const other of [...pending.values()]) {
      if (other !== entry && other.waiters === 0) cancel(other);
    }

    if (!entry) {
      const token = createToken();
      entry = { key, token, waiters: 0, settled: false, cancelled: false, timer: null, promise: null };
      const created = entry;
      const args = force ? { path, force: true, requestToken: token } : { path, requestToken: token };
      created.promise = new Promise((resolve) => {
        resolve(invoke("parse_yft", args));
      });
      const settle = () => {
        created.settled = true;
        clearTimer(created.timer);
        if (pending.get(created.key) === created) pending.delete(created.key);
      };
      created.promise.then(settle, settle);
      pending.set(key, created);
    }

    const joined = entry;
    joined.waiters += 1;
    clearTimer(joined.timer);
    joined.timer = null;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      joined.waiters -= 1;
      if (joined.waiters === 0 && !joined.settled && !joined.cancelled) {
        joined.timer = setTimer(() => cancel(joined), graceMs);
      }
    };

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        release();
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      joined.promise.then(
        (value) => {
          signal?.removeEventListener("abort", onAbort);
          release();
          resolve(value);
        },
        (error) => {
          signal?.removeEventListener("abort", onAbort);
          release();
          reject(error);
        },
      );
    });
  };
}

const sharedParses = new WeakMap();

/**
 * `parse_yft` through the parses shared by every caller of this `invoke`
 * (see `createBridgeParses`). Without a `signal` the parse is never cancelled.
 */
export function requestBridgeParse(invoke, path, options) {
  let parse = sharedParses.get(invoke);
  if (!parse) {
    parse = createBridgeParses({ invoke });
    sharedParses.set(invoke, parse);
  }
  return parse(path, options);
}
