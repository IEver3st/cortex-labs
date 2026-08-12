import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const TOOLTIP_DELAY_MS = 500;
const TOOLTIP_GAP_PX = 7;
const TOOLTIP_ID = "studio-tooltip";
const VIEWPORT_MARGIN_PX = 8;

function findTooltipTarget(node) {
  if (!(node instanceof Element)) return null;
  const target = node.closest("[data-tooltip], [title]");
  return target instanceof HTMLElement ? target : null;
}

function readTooltip(target) {
  if (!target) return "";
  return target.dataset.tooltip?.trim() || target.getAttribute("title")?.trim() || "";
}

function getUiZoom() {
  const zoom = Number.parseFloat(window.getComputedStyle(document.body).zoom);
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

function pickPlacement(targetRect, tooltipRect, zoom) {
  const roomBelow = window.innerHeight - targetRect.bottom;
  const roomAbove = targetRect.top;
  const placement = roomBelow >= tooltipRect.height + TOOLTIP_GAP_PX || roomBelow >= roomAbove
    ? "bottom"
    : "top";
  const top = placement === "bottom"
    ? targetRect.bottom + TOOLTIP_GAP_PX
    : targetRect.top - tooltipRect.height - TOOLTIP_GAP_PX;
  const unclampedLeft = targetRect.left + (targetRect.width - tooltipRect.width) / 2;
  const maxLeft = Math.max(VIEWPORT_MARGIN_PX, window.innerWidth - tooltipRect.width - VIEWPORT_MARGIN_PX);

  return {
    left: Math.min(Math.max(unclampedLeft, VIEWPORT_MARGIN_PX), maxLeft) / zoom,
    top: Math.min(
      Math.max(top, VIEWPORT_MARGIN_PX),
      Math.max(VIEWPORT_MARGIN_PX, window.innerHeight - tooltipRect.height - VIEWPORT_MARGIN_PX),
    ) / zoom,
    maxWidth: Math.min(280, Math.max(0, window.innerWidth - VIEWPORT_MARGIN_PX * 2) / zoom),
    placement,
  };
}

export default function TooltipProvider() {
  const [tooltip, setTooltip] = useState(null);
  const [position, setPosition] = useState(null);
  const tooltipRef = useRef(null);
  const timerRef = useRef(null);
  const activeTargetRef = useRef(null);
  const activeLabelRef = useRef("");
  const originalDescribedByRef = useRef(null);
  const originalTitleRef = useRef(null);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const restoreTitle = () => {
      const target = activeTargetRef.current;
      if (target?.isConnected) {
        if (originalTitleRef.current !== null) {
          target.setAttribute("title", originalTitleRef.current);
        }
        if (originalDescribedByRef.current === null) {
          target.removeAttribute("aria-describedby");
        } else {
          target.setAttribute("aria-describedby", originalDescribedByRef.current);
        }
      }
      activeTargetRef.current = null;
      activeLabelRef.current = "";
      originalDescribedByRef.current = null;
      originalTitleRef.current = null;
    };

    const hide = () => {
      clearTimer();
      restoreTitle();
      setTooltip(null);
      setPosition(null);
    };

    const show = (target, immediate = false) => {
      const isNewTarget = target !== activeTargetRef.current;
      const label = !isNewTarget
        ? activeLabelRef.current
        : readTooltip(target);
      if (!label) return;

      clearTimer();
      if (isNewTarget) {
        restoreTitle();
        activeTargetRef.current = target;
        activeLabelRef.current = label;
        originalDescribedByRef.current = target.getAttribute("aria-describedby");
        if (target.hasAttribute("title")) {
          originalTitleRef.current = target.getAttribute("title");
          target.removeAttribute("title");
        }
      }

      const commit = () => {
        timerRef.current = null;
        if (!target.isConnected) {
          hide();
          return;
        }
        const describedBy = originalDescribedByRef.current
          ? `${originalDescribedByRef.current} ${TOOLTIP_ID}`
          : TOOLTIP_ID;
        target.setAttribute("aria-describedby", describedBy);
        setPosition(null);
        setTooltip({ label, target });
      };

      if (immediate) commit();
      else timerRef.current = window.setTimeout(commit, TOOLTIP_DELAY_MS);
    };

    const handlePointerOver = (event) => {
      const target = findTooltipTarget(event.target);
      if (!target || target === activeTargetRef.current) return;
      show(target);
    };

    const handlePointerOut = (event) => {
      const target = activeTargetRef.current;
      if (!target) return;
      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node && target.contains(nextTarget)) return;
      if (document.activeElement instanceof Node && target.contains(document.activeElement)) return;
      hide();
    };

    const handleFocusIn = (event) => show(findTooltipTarget(event.target), true);
    const handleFocusOut = (event) => {
      const target = activeTargetRef.current;
      if (!target) return;
      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node && target.contains(nextTarget)) return;
      if (target.matches(":hover")) return;
      hide();
    };

    const handleKeyDown = (event) => {
      if (event.key === "Escape") hide();
    };

    document.addEventListener("pointerover", handlePointerOver);
    document.addEventListener("pointerout", handlePointerOut);
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("focusout", handleFocusOut);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", hide, true);
    window.addEventListener("blur", hide);
    window.addEventListener("resize", hide);
    window.addEventListener("scroll", hide, true);

    return () => {
      document.removeEventListener("pointerover", handlePointerOver);
      document.removeEventListener("pointerout", handlePointerOut);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("focusout", handleFocusOut);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", hide, true);
      window.removeEventListener("blur", hide);
      window.removeEventListener("resize", hide);
      window.removeEventListener("scroll", hide, true);
      clearTimer();
      restoreTitle();
    };
  }, []);

  useLayoutEffect(() => {
    if (!tooltip || !tooltipRef.current) return;

    const zoom = getUiZoom();
    tooltipRef.current.style.maxWidth = `${Math.min(
      280,
      Math.max(0, window.innerWidth - VIEWPORT_MARGIN_PX * 2) / zoom,
    )}px`;
    const targetRect = tooltip.target.getBoundingClientRect();
    const tooltipRect = tooltipRef.current.getBoundingClientRect();
    setPosition(pickPlacement(targetRect, tooltipRect, zoom));
  }, [tooltip]);

  if (!tooltip || typeof document === "undefined") return null;

  return createPortal(
    <div
      id={TOOLTIP_ID}
      ref={tooltipRef}
      className="studio-tooltip"
      data-placement={position?.placement ?? "bottom"}
      role="tooltip"
      style={position
        ? { left: position.left, maxWidth: position.maxWidth, top: position.top }
        : { visibility: "hidden" }}
    >
      {tooltip.label}
    </div>,
    document.body,
  );
}
