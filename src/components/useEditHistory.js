import { useCallback, useRef, useState } from "react";
import { createEditHistory, recordEdit, redoEdit, undoEdit } from "../lib/edit-history.js";

/**
 * Undo/redo for a page's editable state (see lib/edit-history.js). Call
 * `record(before, key)` with the state an edit replaces; `undo(current)` and
 * `redo(current)` return the snapshot to restore, or null. The history sits in
 * a ref so key handlers never read a stale copy; only the can-undo/can-redo
 * flags re-render.
 */
export default function useEditHistory() {
  const historyRef = useRef(createEditHistory());
  const [depth, setDepth] = useState({ past: 0, future: 0 });

  const sync = useCallback(() => {
    const past = historyRef.current.past.length;
    const future = historyRef.current.future.length;
    setDepth((current) => (current.past === past && current.future === future ? current : { past, future }));
  }, []);

  const record = useCallback((before, key = null) => {
    historyRef.current = recordEdit(historyRef.current, before, { key });
    sync();
  }, [sync]);

  const step = useCallback((apply, current) => {
    const result = apply(historyRef.current, current);
    if (!result) return null;
    historyRef.current = result.history;
    sync();
    return result.snapshot;
  }, [sync]);

  const undo = useCallback((current) => step(undoEdit, current), [step]);
  const redo = useCallback((current) => step(redoEdit, current), [step]);
  const clear = useCallback(() => {
    historyRef.current = createEditHistory();
    sync();
  }, [sync]);

  return { canUndo: depth.past > 0, canRedo: depth.future > 0, record, undo, redo, clear };
}
