import { useLayoutEffect, useRef } from "react";
import { prefersReducedMotion } from "../../lib/motion";

const PANES = ":scope > .lv-dock, :scope > .lv-inspector";
const DURATION = 240;
const EASING = "cubic-bezier(0.2, 0.8, 0.2, 1)";

function release(pane) {
  delete pane.dataset.sliding;
  pane.style.removeProperty("width");
  pane.style.removeProperty("height");
  pane.style.removeProperty("justify-self");
  pane.style.removeProperty("align-self");
}

function currentOffset(pane) {
  const transform = getComputedStyle(pane).transform;
  if (!transform || transform === "none") return 0;
  return new DOMMatrixReadOnly(transform).m41;
}

export function usePaneMotion(rootRef, layoutKey) {
  const observerRef = useRef(null);
  const observedRef = useRef(new Set());
  const panesRef = useRef(new WeakMap());
  const slidesRef = useRef(new Map());
  const keyRef = useRef(layoutKey);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    if (!observerRef.current) {
      observerRef.current = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const pane = entry.target;
          if (pane.dataset.sliding !== undefined) continue;
          const { width, height } = pane.getBoundingClientRect();
          const open = width > 0 && height > 0;
          const known = panesRef.current.get(pane);
          panesRef.current.set(pane, open ? { open, width, height } : { ...known, open });
        }
      });
    }
    const current = new Set(root.querySelectorAll(PANES));
    for (const pane of observedRef.current) {
      if (current.has(pane)) continue;
      observerRef.current.unobserve(pane);
      observedRef.current.delete(pane);
    }
    for (const pane of current) {
      if (observedRef.current.has(pane)) continue;
      observerRef.current.observe(pane);
      observedRef.current.add(pane);
    }
  });

  useLayoutEffect(() => () => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    observedRef.current.clear();
    for (const animation of slidesRef.current.values()) animation.cancel();
    slidesRef.current.clear();
  }, []);

  useLayoutEffect(() => {
    if (keyRef.current === layoutKey) return;
    keyRef.current = layoutKey;
    const root = rootRef.current;
    if (!root) return;
    const offsets = new Map();
    for (const [pane, animation] of slidesRef.current) {
      offsets.set(pane, currentOffset(pane));
      slidesRef.current.delete(pane);
      animation.cancel();
      release(pane);
    }
    const animate = !prefersReducedMotion();
    for (const pane of root.querySelectorAll(PANES)) {
      const before = panesRef.current.get(pane);
      const rect = pane.getBoundingClientRect();
      const open = rect.width > 0 && rect.height > 0;
      const width = open ? rect.width : before?.width ?? 0;
      const height = open ? rect.height : before?.height ?? 0;
      panesRef.current.set(pane, { open, width, height });
      const interrupted = offsets.has(pane);
      if (!animate || !before || (before.open === open && !interrupted)) continue;
      if (width <= 0 || height <= 0 || typeof pane.animate !== "function") continue;
      const isDock = pane.classList.contains("lv-dock");
      const hidden = isDock ? -width : width;
      const from = interrupted ? offsets.get(pane) : open ? hidden : 0;
      const to = open ? 0 : hidden;
      if (from === to) continue;
      pane.dataset.sliding = "";
      pane.style.width = `${width}px`;
      pane.style.height = `${height}px`;
      pane.style.justifySelf = isDock ? "unsafe start" : "unsafe end";
      pane.style.alignSelf = "unsafe end";
      const animation = pane.animate(
        [{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }],
        { duration: DURATION, easing: EASING },
      );
      slidesRef.current.set(pane, animation);
      const settle = () => {
        if (slidesRef.current.get(pane) !== animation) return;
        slidesRef.current.delete(pane);
        release(pane);
      };
      animation.finished.then(settle, settle);
    }
  }, [layoutKey, rootRef]);
}
