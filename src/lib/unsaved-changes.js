// Tabs holding edits that exist only in memory (today: a siren draft not yet
// written to a carcols.meta). Each tab reports itself under its tab id; the
// Shell asks before closing such a tab or the window. Module state rather than
// React state, so close handlers always read the current answer.

const unsaved = new Map();
const listeners = new Set();

/** Marks `key` as holding unsaved edits (`reason` truthy) or clean (falsy). */
export function setUnsavedChanges(key, reason) {
  if (!key) return;
  if (reason) {
    if (unsaved.get(key) === reason) return;
    unsaved.set(key, reason);
  } else {
    if (!unsaved.has(key)) return;
    unsaved.delete(key);
  }
  for (const listener of [...listeners]) listener();
}

/** The keys among `keys` (or all keys) that hold unsaved edits, in the order given. */
export function unsavedChangeKeys(keys) {
  if (keys == null) return [...unsaved.keys()];
  return [...keys].filter((key) => unsaved.has(key));
}

/** Calls `listener` whenever a key turns dirty or clean. Returns the unsubscribe. */
export function subscribeUnsavedChanges(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
