// Bounded undo/redo of whole-state snapshots, for editors whose state is a
// small immutable value (Variant Builder variants, Template Generator
// markers). Callers record the state as it was before each edit; undo hands
// back the snapshot to restore and keeps the current state for redo.
// Pure functions, so the history can live in React state or a ref.

export const EDIT_HISTORY_LIMIT = 100;
// Repeated edits with the same key this close together undo as one step
// (a held arrow key nudging one marker).
export const EDIT_HISTORY_COALESCE_MS = 700;

export function createEditHistory() {
  return { past: [], future: [], lastKey: null, lastAt: 0 };
}

/**
 * Records `before`, the state an edit is about to replace. Clears redo. With
 * a `key` equal to the previous record's and within `coalesceMs`, the edit
 * joins the previous step instead.
 */
export function recordEdit(history, before, {
  key = null,
  now = Date.now(),
  limit = EDIT_HISTORY_LIMIT,
  coalesceMs = EDIT_HISTORY_COALESCE_MS,
} = {}) {
  const current = history || createEditHistory();
  const merge = Boolean(key) && key === current.lastKey && now - current.lastAt < coalesceMs && current.past.length > 0;
  return {
    past: merge ? current.past : [...current.past, before].slice(-Math.max(1, limit)),
    future: [],
    lastKey: key || null,
    lastAt: now,
  };
}

/** `{ history, snapshot }` to restore, or null when there is nothing to undo. */
export function undoEdit(history, current, { limit = EDIT_HISTORY_LIMIT } = {}) {
  if (!history?.past?.length) return null;
  const snapshot = history.past[history.past.length - 1];
  return {
    snapshot,
    history: {
      past: history.past.slice(0, -1),
      future: [current, ...history.future].slice(0, Math.max(1, limit)),
      lastKey: null,
      lastAt: 0,
    },
  };
}

/** `{ history, snapshot }` to restore, or null when there is nothing to redo. */
export function redoEdit(history, current, { limit = EDIT_HISTORY_LIMIT } = {}) {
  if (!history?.future?.length) return null;
  const [snapshot, ...future] = history.future;
  return {
    snapshot,
    history: {
      past: [...history.past, current].slice(-Math.max(1, limit)),
      future,
      lastKey: null,
      lastAt: 0,
    },
  };
}

/** Ctrl+Z undoes; Ctrl+Shift+Z and Ctrl+Y redo (Cmd on macOS). */
export function editHistoryKey(event) {
  if (!event || !(event.ctrlKey || event.metaKey) || event.altKey) return null;
  const key = String(event.key || "").toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y" && !event.shiftKey) return "redo";
  return null;
}
