import { useCallback, useEffect, useMemo, useState } from "react";
import { cloneSirenSetting, serializeSirenSetting } from "../../lib/siren-settings.js";

// Siren editor state for the loaded model. The draft is what the viewer's light
// preview runs while it exists, so every edit shows on the model at once. The
// draft outlives the editor sheet until it is saved, reverted or the model
// changes; carcols.meta is only written by an explicit save.

const HISTORY_LIMIT = 200;
// Edits with the same key this close together (a slider drag, a paint stroke)
// undo as one step.
const COALESCE_MS = 700;
// How siren markers draw over the model, kept across sessions: numbered
// callouts on leaders, or the original chips.
const MARKER_STYLE_KEY = "cortex-labs:siren-marker-style.v1";
export const MARKER_STYLES = Object.freeze(["callouts", "classic"]);

function loadMarkerStyle() {
  try {
    const stored = localStorage.getItem(MARKER_STYLE_KEY);
    return MARKER_STYLES.includes(stored) ? stored : MARKER_STYLES[0];
  } catch {
    return MARKER_STYLES[0];
  }
}

const EMPTY = Object.freeze({
  path: "",
  open: false,
  base: null,
  draft: null,
  past: [],
  future: [],
  selection: [0],
  primary: 0,
  lastKey: null,
  lastAt: 0,
  saved: null,
  markers: true,
});

function samePath(a, b) {
  const normalize = (path) => String(path || "").replace(/\\/g, "/").toLowerCase();
  return normalize(a) === normalize(b);
}

function fingerprint(setting) {
  return setting ? serializeSirenSetting(setting) : "";
}

function clampSelection(selection, primary, count) {
  const valid = selection.filter((index) => index >= 0 && index < count);
  const nextPrimary = valid.includes(primary) ? primary : valid[valid.length - 1] ?? (count ? Math.min(primary, count - 1) : 0);
  return { selection: valid.length ? valid : count ? [nextPrimary] : [], primary: nextPrimary };
}

export default function useSirenEditor({ modelPath, fileSetting }) {
  const [entries, setEntries] = useState({ model: EMPTY, pattern: EMPTY });
  const slot = modelPath ? "model" : "pattern";
  const entry = entries[slot];
  const state = entry.path === (modelPath || "") ? entry : EMPTY;

  const update = useCallback((recipe) => setEntries((current) => {
    const own = current[slot];
    const base = own.path === (modelPath || "") ? own : { ...EMPTY, path: modelPath || "" };
    const next = recipe(base);
    return next === own ? current : { ...current, [slot]: next };
  }), [modelPath, slot]);

  const baseFingerprint = useMemo(() => fingerprint(state.base), [state.base]);
  const draftFingerprint = useMemo(() => fingerprint(state.draft), [state.draft]);
  const dirty = Boolean(state.draft) && (!state.base || baseFingerprint !== draftFingerprint);
  const patternEntry = entries.pattern;
  const patternDirty = useMemo(() => Boolean(patternEntry.draft)
    && (!patternEntry.base || fingerprint(patternEntry.base) !== fingerprint(patternEntry.draft)), [patternEntry.base, patternEntry.draft]);

  // A rescan that changes the file: a clean draft follows it (same setting in
  // the same file) or steps aside so the preview shows the file again. Unsaved
  // edits stay.
  useEffect(() => {
    update((current) => {
      if (!current.draft || current.base == null) return current;
      if (fingerprint(current.base) !== fingerprint(current.draft)) return current;
      if (fileSetting && fileSetting.id === current.base.id && samePath(fileSetting.sourcePath, current.base.sourcePath)) {
        if (fingerprint(fileSetting) === fingerprint(current.base)) return current;
        const next = cloneSirenSetting(fileSetting);
        return { ...current, base: next, draft: cloneSirenSetting(next), past: [], future: [], ...clampSelection(current.selection, current.primary, next.sirens.length) };
      }
      return current.open ? current : { ...current, base: null, draft: null, past: [], future: [] };
    });
  }, [fileSetting, update]);

  /** Opens the editor on the file's setting, or on `created` for a model without
      one. `asFile`: `created` is already saved in its sourcePath, so it starts clean. */
  const start = useCallback((created = null, { asFile = false } = {}) => update((current) => {
    if (current.draft && !created) return { ...current, open: true };
    const base = created ? (asFile ? cloneSirenSetting(created) : null) : cloneSirenSetting(fileSetting);
    const draft = created ? cloneSirenSetting(created) : cloneSirenSetting(fileSetting);
    if (!draft) return current;
    return { ...EMPTY, path: modelPath || "", open: true, base, draft, markers: current.markers, ...clampSelection([0], 0, draft.sirens.length) };
  }), [fileSetting, modelPath, update]);

  const close = useCallback(() => update((current) => ({ ...current, open: false })), [update]);

  /** Applies `recipe(draft) -> draft`; `key` groups rapid edits into one undo step. */
  const edit = useCallback((recipe, key = null) => update((current) => {
    if (!current.draft) return current;
    const next = recipe(current.draft);
    if (!next || next === current.draft) return current;
    const now = Date.now();
    const merge = key && key === current.lastKey && now - current.lastAt < COALESCE_MS;
    const past = merge ? current.past : [...current.past, current.draft].slice(-HISTORY_LIMIT);
    return {
      ...current,
      draft: next,
      past,
      future: [],
      lastKey: key,
      lastAt: now,
      ...clampSelection(current.selection, current.primary, next.sirens.length),
    };
  }), [update]);

  const undo = useCallback(() => update((current) => {
    if (!current.past.length) return current;
    const draft = current.past[current.past.length - 1];
    return {
      ...current,
      draft,
      past: current.past.slice(0, -1),
      future: [current.draft, ...current.future].slice(0, HISTORY_LIMIT),
      lastKey: null,
      ...clampSelection(current.selection, current.primary, draft.sirens.length),
    };
  }), [update]);

  const redo = useCallback(() => update((current) => {
    if (!current.future.length) return current;
    const [draft, ...future] = current.future;
    return {
      ...current,
      draft,
      past: [...current.past, current.draft].slice(-HISTORY_LIMIT),
      future,
      lastKey: null,
      ...clampSelection(current.selection, current.primary, draft.sirens.length),
    };
  }), [update]);

  /** Back to the file's values; a setting that was never saved is discarded. */
  const revert = useCallback(() => update((current) => {
    if (!current.base) return { ...current, open: false, draft: null, past: [], future: [] };
    return { ...current, draft: cloneSirenSetting(current.base), past: [...current.past, current.draft].slice(-HISTORY_LIMIT), future: [], lastKey: null,
      ...clampSelection(current.selection, current.primary, current.base.sirens.length) };
  }), [update]);

  const select = useCallback((selection, primary) => update((current) => ({
    ...current,
    ...clampSelection(selection, primary ?? selection[selection.length - 1] ?? 0, current.draft?.sirens.length || 0),
  })), [update]);

  /** After a write: the saved draft becomes the clean base. */
  const markSaved = useCallback((path) => update((current) => {
    if (!current.draft) return current;
    const base = { ...cloneSirenSetting(current.draft), sourcePath: path };
    return { ...current, base, draft: { ...current.draft, sourcePath: path }, saved: { path, at: Date.now() } };
  }), [update]);

  const setMarkers = useCallback((markers) => update((current) => ({ ...current, markers })), [update]);

  const [markerStyle, setMarkerStyleState] = useState(loadMarkerStyle);
  const setMarkerStyle = useCallback((style) => {
    if (!MARKER_STYLES.includes(style)) return;
    setMarkerStyleState(style);
    try {
      localStorage.setItem(MARKER_STYLE_KEY, style);
    } catch (err) {
      console.error("[Sirens] Could not save the marker style:", err);
    }
  }, []);

  return {
    open: state.open,
    markers: state.markers,
    setMarkers,
    markerStyle,
    setMarkerStyle,
    draft: state.draft,
    base: state.base,
    patternOnly: !modelPath,
    pattern: patternEntry.draft,
    patternDirty,
    dirty,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    selection: state.selection,
    primary: state.primary,
    saved: state.saved,
    start,
    close,
    edit,
    undo,
    redo,
    revert,
    select,
    markSaved,
  };
}
