import { useCallback, useEffect, useState } from "react";

// User-resizable dock and inspector widths for a viewer workspace. Widths are
// pixels stored per workspace kind; null keeps the stylesheet's default. The
// stage keeps at least MIN_STAGE pixels whatever the panes ask for.

const LIMITS = { dock: [220, 520], insp: [260, 560] };
const MIN_STAGE = 360;

function readWidths(storageKey, limits) {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) || "null");
    const pick = (side) => {
      const value = Number(parsed?.[side]);
      const [min, max] = limits[side];
      return Number.isFinite(value) && value >= min && value <= max ? Math.round(value) : null;
    };
    return { dock: pick("dock"), insp: pick("insp") };
  } catch {
    return { dock: null, insp: null };
  }
}

export function usePaneWidths(storageKey, { inspectorMax = LIMITS.insp[1] } = {}) {
  const [widths, setWidths] = useState(() => readWidths(storageKey, { ...LIMITS, insp: [LIMITS.insp[0], inspectorMax] }));
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(widths));
    } catch {
      // Widths are a convenience; a full or blocked store only loses them.
    }
  }, [storageKey, widths]);
  const setWidth = useCallback((side, value) => setWidths((current) => ({ ...current, [side]: value })), []);
  const style = {
    ...(widths.dock ? { "--lv-dock": `${widths.dock}px` } : {}),
    ...(widths.insp ? { "--lv-insp": `${widths.insp}px` } : {}),
  };
  return { widths, setWidth, style };
}

const PREVIEW_MIN = 160;
// The pane under the preview keeps at least this much height.
const PREVIEW_BELOW_MIN = 180;

/**
 * Height of a preview pane that sits over the inspector in the same column,
 * dragged from its bottom edge. Null keeps the stylesheet's default
 * (--sw-preview-h unset). Returns the style to put on the workspace root and
 * the handle's event handlers.
 */
export function usePreviewHeight(storageKey) {
  const [height, setHeight] = useState(() => {
    try {
      const value = Number(localStorage.getItem(storageKey));
      return Number.isFinite(value) && value >= PREVIEW_MIN ? Math.round(value) : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    try {
      if (height == null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, String(height));
    } catch {
      // A convenience; a full or blocked store only loses it.
    }
  }, [storageKey, height]);
  const clampFor = (handle, value) => {
    const root = handle.closest(".lv-root");
    const max = root ? root.getBoundingClientRect().height - PREVIEW_BELOW_MIN : value;
    return Math.round(Math.max(PREVIEW_MIN, Math.min(max, value)));
  };
  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const startY = event.clientY;
    const start = handle.parentElement.getBoundingClientRect().height;
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("is-dragging");
    const move = (moveEvent) => setHeight(clampFor(handle, start + moveEvent.clientY - startY));
    const stop = () => {
      handle.classList.remove("is-dragging");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  };
  const onKeyDown = (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const handle = event.currentTarget;
    const current = handle.parentElement.getBoundingClientRect().height;
    const step = event.shiftKey ? 64 : 24;
    setHeight(clampFor(handle, current + (event.key === "ArrowDown" ? step : -step)));
  };
  return {
    style: height ? { "--sw-preview-h": `${height}px` } : {},
    onPointerDown,
    onKeyDown,
    reset: () => setHeight(null),
  };
}

/**
 * A drag handle on the inner edge of the dock (side "dock") or inspector
 * (side "insp"). Drag or use the arrow keys; double-click returns to the
 * default width. `minStage` raises the floor kept for the centre column.
 */
export function PaneResizer({ side, label, setWidth, minStage = MIN_STAGE, maxWidth = LIMITS[side][1] }) {
  const layoutWidth = (element) => (element ? element.offsetWidth || element.getBoundingClientRect().width : 0);
  const clampFor = (element, value) => {
    const min = LIMITS[side][0];
    const max = maxWidth;
    const root = element.closest(".lv-root");
    const other = root?.querySelector(side === "dock" ? ".lv-inspector" : ".lv-dock");
    const stageFloor = typeof minStage === "function" && root ? minStage(root) : Number(minStage) || MIN_STAGE;
    const room = root ? layoutWidth(root) - layoutWidth(other) - stageFloor : max;
    return Math.round(Math.max(min, Math.min(max, room, value)));
  };
  const paneWidth = (element) => layoutWidth(element.parentElement);
  const settleOther = (element) => {
    const root = element.closest(".lv-root");
    const otherSide = side === "dock" ? "insp" : "dock";
    const other = root?.querySelector(side === "dock" ? ".lv-inspector" : ".lv-dock");
    if (!root || !other) return;
    const stored = parseFloat(root.style.getPropertyValue(`--lv-${otherSide}`));
    const rendered = layoutWidth(other);
    if (Number.isFinite(stored) && rendered > 0 && stored > rendered + 1) setWidth(otherSide, Math.round(rendered));
  };
  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    settleOther(handle);
    const startX = event.clientX;
    const start = paneWidth(handle);
    const pane = handle.parentElement;
    const zoom = pane.offsetWidth ? pane.getBoundingClientRect().width / pane.offsetWidth || 1 : 1;
    const direction = side === "dock" ? 1 : -1;
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("is-dragging");
    const move = (moveEvent) => setWidth(side, clampFor(handle, start + (direction * (moveEvent.clientX - startX)) / zoom));
    const stop = () => {
      handle.classList.remove("is-dragging");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  };
  const onKeyDown = (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    settleOther(event.currentTarget);
    const grow = (event.key === "ArrowRight") === (side === "dock");
    const step = event.shiftKey ? 48 : 16;
    setWidth(side, clampFor(event.currentTarget, paneWidth(event.currentTarget) + (grow ? step : -step)));
  };
  return (
    <div
      className={`lv-pane-resizer is-${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={`${label}. Double-click for the default width.`}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => setWidth(side, null)}
    />
  );
}
