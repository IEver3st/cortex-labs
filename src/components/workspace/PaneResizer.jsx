import { useCallback, useEffect, useState } from "react";

// User-resizable dock and inspector widths for a viewer workspace. Widths are
// pixels stored per workspace kind; null keeps the stylesheet's default. The
// stage keeps at least MIN_STAGE pixels whatever the panes ask for.

const LIMITS = { dock: [220, 520], insp: [260, 560] };
const MIN_STAGE = 360;

function readWidths(storageKey) {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) || "null");
    const pick = (side) => {
      const value = Number(parsed?.[side]);
      const [min, max] = LIMITS[side];
      return Number.isFinite(value) && value >= min && value <= max ? Math.round(value) : null;
    };
    return { dock: pick("dock"), insp: pick("insp") };
  } catch {
    return { dock: null, insp: null };
  }
}

export function usePaneWidths(storageKey) {
  const [widths, setWidths] = useState(() => readWidths(storageKey));
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
export function PaneResizer({ side, label, setWidth, minStage = MIN_STAGE }) {
  const clampFor = (element, value) => {
    const [min, max] = LIMITS[side];
    const root = element.closest(".lv-root");
    const other = root?.querySelector(side === "dock" ? ".lv-inspector" : ".lv-dock");
    const room = root ? root.getBoundingClientRect().width - (other?.getBoundingClientRect().width || 0) - minStage : max;
    return Math.round(Math.max(min, Math.min(max, room, value)));
  };
  const paneWidth = (element) => element.parentElement.getBoundingClientRect().width;
  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const start = paneWidth(handle);
    const direction = side === "dock" ? 1 : -1;
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("is-dragging");
    const move = (moveEvent) => setWidth(side, clampFor(handle, start + direction * (moveEvent.clientX - startX)));
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
