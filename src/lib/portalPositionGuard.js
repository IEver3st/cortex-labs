export const DEFAULT_SIDE_OFFSET = 4;
export const DRIFT_TOLERANCE_PX = 2;
export const VIEWPORT_MARGIN_PX = 8;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getUiScale(uiScale) {
  if (typeof uiScale === "number" && Number.isFinite(uiScale) && uiScale > 0) {
    return uiScale;
  }
  if (typeof window === "undefined") return 1;
  const raw = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue("--es-ui-scale");
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return parsed;
}

function findWrapper(contentEl) {
  if (!contentEl) return null;
  return (
    contentEl.closest?.("[data-radix-popper-content-wrapper]") ||
    contentEl.parentElement ||
    null
  );
}

function applyWrapperPosition(wrapper, left, top) {
  wrapper.style.left = "0px";
  wrapper.style.top = "0px";
  wrapper.style.margin = "0px";
  wrapper.style.transform = `translate3d(${left.toFixed(2)}px, ${top.toFixed(2)}px, 0)`;
}

function measureDrift(wrapper, desiredLeft, desiredTop) {
  const rect = wrapper.getBoundingClientRect();
  const dx = rect.left - desiredLeft;
  const dy = rect.top - desiredTop;
  return {
    dx,
    dy,
    driftPx: Math.max(Math.abs(dx), Math.abs(dy)),
  };
}

function clampLeft(left, width) {
  if (typeof window === "undefined") return left;
  const minLeft = VIEWPORT_MARGIN_PX;
  const maxLeft = Math.max(
    minLeft,
    window.innerWidth - Math.max(width, 1) - VIEWPORT_MARGIN_PX,
  );
  return clamp(left, minLeft, maxLeft);
}

function guardWrapperPosition({ wrapper, desiredLeft, desiredTop, scale }) {
  wrapper.style.zoom = "";
  wrapper.style.transformOrigin = "";

  applyWrapperPosition(wrapper, desiredLeft, desiredTop);
  let drift = measureDrift(wrapper, desiredLeft, desiredTop);
  let fallbackUsed = false;

  if (drift.driftPx > DRIFT_TOLERANCE_PX && Math.abs(scale - 1) > 0.001) {
    fallbackUsed = true;
    wrapper.style.zoom = String(1 / scale);
    wrapper.style.transformOrigin = "top left";
    applyWrapperPosition(wrapper, desiredLeft, desiredTop);
    drift = measureDrift(wrapper, desiredLeft, desiredTop);
  }

  if (drift.driftPx > DRIFT_TOLERANCE_PX) {
    applyWrapperPosition(wrapper, desiredLeft - drift.dx, desiredTop - drift.dy);
    drift = measureDrift(wrapper, desiredLeft, desiredTop);
  }

  return {
    corrected: drift.driftPx <= DRIFT_TOLERANCE_PX,
    fallbackUsed,
    driftPx: Number(drift.driftPx.toFixed(2)),
  };
}

export function positionSelectPortal({
  contentEl,
  triggerEl,
  sideOffset = DEFAULT_SIDE_OFFSET,
  uiScale,
}) {
  const wrapper = findWrapper(contentEl);
  if (!contentEl || !triggerEl || !wrapper || typeof window === "undefined") {
    return { corrected: false, fallbackUsed: false, driftPx: Infinity };
  }

  const triggerRect = triggerEl.getBoundingClientRect();
  const wrapperRect = wrapper.getBoundingClientRect();
  const desiredLeft = clampLeft(triggerRect.left, wrapperRect.width);
  const desiredTop = Math.max(
    VIEWPORT_MARGIN_PX,
    triggerRect.bottom + sideOffset,
  );

  const maxHeight = Math.floor(
    window.innerHeight - desiredTop - VIEWPORT_MARGIN_PX,
  );
  contentEl.style.maxHeight = `${Math.max(120, maxHeight)}px`;

  const scale = getUiScale(uiScale);
  return guardWrapperPosition({ wrapper, desiredLeft, desiredTop, scale });
}

export function positionContextMenuPortal({
  contentEl,
  pointer,
  sideOffset = DEFAULT_SIDE_OFFSET,
  uiScale,
}) {
  const wrapper = findWrapper(contentEl);
  if (!contentEl || !wrapper || typeof window === "undefined") {
    return { corrected: false, fallbackUsed: false, driftPx: Infinity };
  }

  const wrapperRect = wrapper.getBoundingClientRect();
  const fallbackX = VIEWPORT_MARGIN_PX;
  const fallbackY = VIEWPORT_MARGIN_PX;
  const pointerX = Number(pointer?.x);
  const pointerY = Number(pointer?.y);
  const baseX = Number.isFinite(pointerX) ? pointerX : fallbackX;
  const baseY = Number.isFinite(pointerY) ? pointerY : fallbackY;
  const desiredLeft = clampLeft(baseX + sideOffset, wrapperRect.width);
  const desiredTop = clamp(
    baseY + sideOffset,
    VIEWPORT_MARGIN_PX,
    Math.max(
      VIEWPORT_MARGIN_PX,
      window.innerHeight - wrapperRect.height - VIEWPORT_MARGIN_PX,
    ),
  );

  const scale = getUiScale(uiScale);
  return guardWrapperPosition({ wrapper, desiredLeft, desiredTop, scale });
}
