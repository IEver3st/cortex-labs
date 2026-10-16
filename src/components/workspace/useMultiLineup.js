import { useCallback, useMemo, useRef, useState } from "react";
import {
  MAX_LINEUP_SLOTS,
  buildPaint,
  createSlot,
  duplicateSlot,
  migrateDualState,
  normalizeLineup,
  normalizeLineupShowroom,
  normalizeYaw,
  pathKey,
  resolveWindowTarget,
} from "../../lib/multi-lineup.js";
import { paintDisplayColor } from "../../lib/vehicle-paint.js";

const RELOAD_DEBOUNCE_MS = 350;

// New vehicles start in the colour of the one they are added next to.
function baseColorOf(slot) {
  return slot?.paint?.primary ? paintDisplayColor(slot.paint.primary) : "";
}

/**
 * Multi's lineup state: the persisted slot list plus per-slot runtime facts
 * the viewer reports (loading, errors, detected glass). App owns persistence,
 * pickers and the file watcher; this hook owns the list's rules.
 * `defaultFloor` is the vehicle showroom floor from Settings > Studio; it
 * seeds a new lineup and one saved without a floor.
 */
export function useMultiLineup(initialBodyColor, defaultFloor) {
  const [lineup, setLineup] = useState(() => normalizeLineup(null, { bodyColor: initialBodyColor }));
  const [status, setStatus] = useState({});
  const [info, setInfo] = useState({});
  const [reloadTokens, setReloadTokens] = useState({});
  const [gizmoVisible, setGizmoVisible] = useState(true);
  // "translate" moves the selected vehicle, "rotate" turns it in place.
  const [gizmoMode, setGizmoMode] = useState("translate");
  const [movedClothing, setMovedClothing] = useState(false);
  const defaultFloorRef = useRef(defaultFloor);
  defaultFloorRef.current = defaultFloor;
  const [showroom, setShowroomState] = useState(() => normalizeLineupShowroom(null, defaultFloor));
  const setShowroom = useCallback((patch) => {
    setShowroomState((prev) => normalizeLineupShowroom({ ...prev, ...patch }));
  }, []);
  const reloadTimersRef = useRef(new Map());

  const { slots, selectedId } = lineup;
  const selected = slots.find((slot) => slot.id === selectedId) || slots[0];

  const updateSlot = useCallback((id, patch) => {
    setLineup((prev) => ({
      ...prev,
      slots: prev.slots.map((slot) => (slot.id === id ? { ...slot, ...(typeof patch === "function" ? patch(slot) : patch) } : slot)),
    }));
  }, []);

  const select = useCallback((id) => {
    setLineup((prev) => (prev.selectedId === id || !prev.slots.some((slot) => slot.id === id) ? prev : { ...prev, selectedId: id }));
  }, []);

  const selectNext = useCallback(() => {
    setLineup((prev) => {
      const index = prev.slots.findIndex((slot) => slot.id === prev.selectedId);
      const next = prev.slots[(index + 1) % prev.slots.length];
      return next ? { ...prev, selectedId: next.id } : prev;
    });
  }, []);

  const addSlot = useCallback((overrides = {}) => {
    let added = null;
    setLineup((prev) => {
      if (prev.slots.length >= MAX_LINEUP_SLOTS) return prev;
      const base = baseColorOf(prev.slots.find((slot) => slot.id === prev.selectedId)) || initialBodyColor;
      added = createSlot(prev.slots, { bodyColor: base, ...overrides });
      return { slots: [...prev.slots, added], selectedId: added.id };
    });
    return added;
  }, [initialBodyColor]);

  // Fills the selected slot when it has no model, otherwise appends slots;
  // extra paths past the cap are reported back to the caller.
  // Drops are discrete events, so this works from the latest committed lineup
  // and can report the skipped count synchronously.
  const lineupRef = useRef(lineup);
  lineupRef.current = lineup;
  const placeModels = useCallback((paths) => {
    const list = (paths || []).filter(Boolean);
    const prev = lineupRef.current;
    let skipped = 0;
    let next = prev.slots;
    let selectedNext = prev.selectedId;
    for (const path of list) {
      const target = next.find((slot) => slot.id === selectedNext);
      if (target && !target.modelPath) {
        next = next.map((slot) => (slot.id === target.id ? { ...slot, modelPath: path, position: null } : slot));
        continue;
      }
      if (next.length >= MAX_LINEUP_SLOTS) {
        skipped += 1;
        continue;
      }
      const slot = createSlot(next, { bodyColor: baseColorOf(target) || initialBodyColor, modelPath: path });
      next = [...next, slot];
      selectedNext = slot.id;
    }
    const updated = { slots: next, selectedId: selectedNext };
    lineupRef.current = updated;
    setLineup(updated);
    return skipped;
  }, [initialBodyColor]);

  const setModel = useCallback((id, path) => {
    updateSlot(id, (slot) => ({ modelPath: path, position: slot.modelPath ? slot.position : null }));
    setStatus((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), error: "" } }));
  }, [updateSlot]);

  const duplicate = useCallback((id) => {
    setLineup((prev) => {
      const copy = duplicateSlot(prev.slots, id);
      if (!copy) return prev;
      const index = prev.slots.findIndex((slot) => slot.id === id);
      const next = [...prev.slots];
      next.splice(index + 1, 0, copy);
      return { slots: next, selectedId: copy.id };
    });
  }, []);

  const remove = useCallback((id) => {
    setLineup((prev) => {
      const index = prev.slots.findIndex((slot) => slot.id === id);
      if (index < 0) return prev;
      const next = prev.slots.filter((slot) => slot.id !== id);
      if (next.length === 0) return normalizeLineup(null, { bodyColor: baseColorOf(prev.slots[0]) || initialBodyColor });
      const selectedNext = prev.selectedId === id ? next[Math.max(0, index - 1)].id : prev.selectedId;
      return { slots: next, selectedId: selectedNext };
    });
    setStatus((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setInfo((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, [initialBodyColor]);

  const move = useCallback((id, delta) => {
    setLineup((prev) => {
      const index = prev.slots.findIndex((slot) => slot.id === id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= prev.slots.length) return prev;
      const next = [...prev.slots];
      [next[index], next[target]] = [next[target], next[index]];
      return { ...prev, slots: next };
    });
  }, []);

  const setPaint = useCallback((id, key, value) => {
    updateSlot(id, (slot) => ({ paint: { ...slot.paint, [key]: value } }));
  }, [updateSlot]);

  const copyToAll = useCallback((id, fields) => {
    setLineup((prev) => {
      const source = prev.slots.find((slot) => slot.id === id);
      if (!source) return prev;
      const patch = {};
      for (const field of fields) patch[field] = field === "paint" ? { ...source.paint } : source[field];
      return { ...prev, slots: prev.slots.map((slot) => (slot.id === id ? slot : { ...slot, ...patch })) };
    });
  }, []);

  const repaintAll = useCallback((color) => {
    setLineup((prev) => ({ ...prev, slots: prev.slots.map((slot) => ({ ...slot, paint: buildPaint(color) })) }));
  }, []);

  // Where the viewer left each vehicle: { [id]: { position, yaw } }.
  const setPlacements = useCallback((placements) => {
    setLineup((prev) => ({
      ...prev,
      slots: prev.slots.map((slot) => {
        const placement = placements[slot.id];
        if (!placement) return slot;
        return {
          ...slot,
          position: placement.position || slot.position,
          yaw: Number.isFinite(placement.yaw) ? normalizeYaw(placement.yaw) : slot.yaw,
        };
      }),
    }));
  }, []);

  // Shows the gizmo in `mode`; picking the mode already showing hides it.
  // Stable so hotkey listeners bound once still see the current gizmo state.
  const gizmoStateRef = useRef({ visible: gizmoVisible, mode: gizmoMode });
  gizmoStateRef.current = { visible: gizmoVisible, mode: gizmoMode };
  const toggleGizmo = useCallback((mode) => {
    const current = gizmoStateRef.current;
    if (current.visible && current.mode === mode) {
      setGizmoVisible(false);
      return;
    }
    setGizmoMode(mode);
    setGizmoVisible(true);
  }, []);

  const reportStatus = useCallback((id, patch) => {
    setStatus((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), ...patch } }));
  }, []);

  // Keeps a manual glass target while the new model still has it.
  const reportInfo = useCallback((id, next) => {
    setInfo((prev) => ({ ...prev, [id]: next }));
    const targets = next?.targets || [];
    setLineup((prev) => ({
      ...prev,
      slots: prev.slots.map((slot) => {
        if (slot.id !== id || ["auto", "none", "all"].includes(slot.windowTarget)) return slot;
        if (targets.length === 0 || targets.some((target) => target.value === slot.windowTarget)) return slot;
        return { ...slot, windowTarget: "auto" };
      }),
    }));
  }, []);

  // A watched file changed: reload every slot that uses it, debounced per path.
  const scheduleReload = useCallback((path) => {
    const key = pathKey(path);
    if (!key) return;
    const timers = reloadTimersRef.current;
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      setReloadTokens((prev) => ({ ...prev, [key]: (prev[key] || 0) + 1 }));
    }, RELOAD_DEBOUNCE_MS));
  }, []);

  const restore = useCallback((state, bodyColor) => {
    const migrated = migrateDualState(state, { bodyColor });
    setLineup(migrated.lineup);
    setMovedClothing(migrated.droppedClothing);
    if (typeof state?.multiGizmoVisible === "boolean") setGizmoVisible(state.multiGizmoVisible);
    setShowroomState(normalizeLineupShowroom(state?.multiShowroom, defaultFloorRef.current));
  }, []);

  // What the viewer renders: "auto" glass resolved against detection.
  const viewerSlots = useMemo(() => slots.map((slot) => ({
    ...slot,
    windowTarget: resolveWindowTarget(slot.windowTarget, info[slot.id]?.windowTarget),
  })), [slots, info]);

  return {
    lineup,
    slots,
    selectedId: selected?.id || null,
    selected,
    viewerSlots,
    status,
    info,
    reloadTokens,
    gizmoVisible,
    setGizmoVisible,
    gizmoMode,
    toggleGizmo,
    showroom,
    setShowroom,
    movedClothing,
    dismissMovedClothing: () => setMovedClothing(false),
    select,
    selectNext,
    addSlot,
    placeModels,
    setModel,
    updateSlot,
    duplicate,
    remove,
    move,
    setPaint,
    copyToAll,
    repaintAll,
    setPlacements,
    reportStatus,
    reportInfo,
    scheduleReload,
    restore,
  };
}
