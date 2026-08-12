import * as React from "react";
import * as CM from "@radix-ui/react-context-menu";
import {
  DEFAULT_SIDE_OFFSET,
  positionContextMenuPortal,
} from "../lib/portalPositionGuard";

/**
 * ContextMenu — thin wrapper around @radix-ui/react-context-menu
 * with Cortex Studio styling. Exported primitives mirror Radix's API.
 */

const ContextMenuAnchorContext = React.createContext(null);

export function Root({ children, ...props }) {
  const pointerRef = React.useRef({ x: 0, y: 0 });
  return (
    <ContextMenuAnchorContext.Provider value={pointerRef}>
      <CM.Root {...props}>{children}</CM.Root>
    </ContextMenuAnchorContext.Provider>
  );
}

export function Trigger({ children, ...props }) {
  const pointerRef = React.useContext(ContextMenuAnchorContext);
  const { onContextMenu, ...rest } = props;

  const handleContextMenu = React.useCallback(
    (event) => {
      if (pointerRef) {
        let x = event.clientX;
        let y = event.clientY;

        // Keyboard-invoked context menus report 0,0. Anchor those beside the
        // focused element so Shift+F10 follows the same spatial contract.
        if (x === 0 && y === 0 && event.target instanceof Element) {
          const rect = event.target.getBoundingClientRect();
          x = rect.left + Math.min(rect.width / 2, 16);
          y = rect.top + Math.min(rect.height, 24);
        }

        pointerRef.current = { x, y };
      }
      onContextMenu?.(event);
      event.stopPropagation();
    },
    [onContextMenu, pointerRef],
  );

  return (
    <CM.Trigger
      asChild
      data-cortex-context-menu-trigger=""
      {...rest}
      onContextMenu={handleContextMenu}
    >
      {children}
    </CM.Trigger>
  );
}

export function Portal({ children, ...props }) {
  return <CM.Portal {...props}>{children}</CM.Portal>;
}

export function Content({
  children,
  className = "",
  sideOffset = DEFAULT_SIDE_OFFSET,
  ...props
}) {
  const pointerRef = React.useContext(ContextMenuAnchorContext);
  const [contentNode, setContentNode] = React.useState(null);

  React.useLayoutEffect(() => {
    if (typeof window === "undefined" || !contentNode) return undefined;

    let rafId = 0;
    let settleTimer = 0;

    const syncPosition = () => {
      positionContextMenuPortal({
        contentEl: contentNode,
        pointer: pointerRef?.current,
        sideOffset,
      });
    };

    syncPosition();
    rafId = requestAnimationFrame(syncPosition);
    settleTimer = window.setTimeout(syncPosition, 140);

    window.addEventListener("resize", syncPosition);
    window.addEventListener("cortex:ui-scale-changed", syncPosition);
    contentNode.addEventListener("animationend", syncPosition);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      if (settleTimer) window.clearTimeout(settleTimer);
      window.removeEventListener("resize", syncPosition);
      window.removeEventListener("cortex:ui-scale-changed", syncPosition);
      contentNode.removeEventListener("animationend", syncPosition);
    };
  }, [contentNode, pointerRef, sideOffset]);

  return (
    <CM.Portal>
      <CM.Content
        ref={setContentNode}
        className={`ctx-menu-content ${className}`}
        sideOffset={sideOffset}
        {...props}
      >
        {children}
      </CM.Content>
    </CM.Portal>
  );
}

export function Item({ children, className = "", destructive = false, ...props }) {
  return (
    <CM.Item
      className={`ctx-menu-item ${destructive ? "is-destructive" : ""} ${className}`}
      {...props}
    >
      {children}
    </CM.Item>
  );
}

export function Separator() {
  return <CM.Separator className="ctx-menu-separator" />;
}

export function Label({ children, ...props }) {
  return (
    <CM.Label className="ctx-menu-label" {...props}>
      {children}
    </CM.Label>
  );
}

export function Shortcut({ children, ...props }) {
  return (
    <span className="ctx-menu-shortcut" aria-hidden="true" {...props}>
      {children}
    </span>
  );
}
