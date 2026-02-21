import * as React from "react";
import * as CM from "@radix-ui/react-context-menu";
import {
  DEFAULT_SIDE_OFFSET,
  positionContextMenuPortal,
} from "../lib/portalPositionGuard";

/**
 * ContextMenu — thin wrapper around @radix-ui/react-context-menu
 * with Cortex Studio dark styling. Exported primitives mirror Radix's API.
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
        pointerRef.current = { x: event.clientX, y: event.clientY };
      }
      onContextMenu?.(event);
    },
    [onContextMenu, pointerRef],
  );

  return (
    <CM.Trigger asChild {...rest} onContextMenu={handleContextMenu}>
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
  const contentRef = React.useRef(null);

  React.useLayoutEffect(() => {
    if (typeof window === "undefined") return undefined;

    let rafId = 0;

    const syncPosition = () => {
      const node = contentRef.current;
      if (!node) return;
      positionContextMenuPortal({
        contentEl: node,
        pointer: pointerRef?.current,
        sideOffset,
      });
    };

    syncPosition();
    rafId = requestAnimationFrame(syncPosition);

    window.addEventListener("resize", syncPosition);
    window.addEventListener("cortex:ui-scale-changed", syncPosition);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener("resize", syncPosition);
      window.removeEventListener("cortex:ui-scale-changed", syncPosition);
    };
  }, [pointerRef, sideOffset]);

  return (
    <CM.Portal>
      <CM.Content
        ref={contentRef}
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
