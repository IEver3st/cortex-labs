import * as CM from "@radix-ui/react-context-menu";

/**
 * ContextMenu — thin wrapper around @radix-ui/react-context-menu
 * with Cortex Studio dark styling. Exported primitives mirror Radix's API.
 */

export function Root({ children, ...props }) {
  return <CM.Root {...props}>{children}</CM.Root>;
}

export function Trigger({ children, ...props }) {
  return <CM.Trigger asChild {...props}>{children}</CM.Trigger>;
}

export function Portal({ children, ...props }) {
  return <CM.Portal {...props}>{children}</CM.Portal>;
}

export function Content({ children, className = "", ...props }) {
  return (
    <CM.Portal>
      <CM.Content
        className={`ctx-menu-content ${className}`}
        sideOffset={4}
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
