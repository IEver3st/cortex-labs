import * as React from "react";
import { motion } from "motion/react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "../../lib/utils";
import {
  DEFAULT_SIDE_OFFSET,
  positionSelectPortal,
} from "../../lib/portalPositionGuard";

const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

const SelectTrigger = React.forwardRef(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      "flex h-[calc(36px*var(--es-ui-scale))] w-full items-center justify-between rounded-[var(--es-radius-control)] border border-white/10 bg-white/5 px-[calc(12px*var(--es-ui-scale))] py-[calc(8px*var(--es-ui-scale))] text-[calc(14px*var(--es-ui-scale))] text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-white/20 disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1",
      "font-hud",
      className,
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown className="h-4 w-4 opacity-50" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectScrollUpButton = React.forwardRef(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpButton
    ref={ref}
    className={cn("flex cursor-default items-center justify-center py-1", className)}
    {...props}
  >
    <ChevronUp className="h-4 w-4" />
  </SelectPrimitive.ScrollUpButton>
));
SelectScrollUpButton.displayName = SelectPrimitive.ScrollUpButton.displayName;

const SelectScrollDownButton = React.forwardRef(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownButton
    ref={ref}
    className={cn("flex cursor-default items-center justify-center py-1", className)}
    {...props}
  >
    <ChevronDown className="h-4 w-4" />
  </SelectPrimitive.ScrollDownButton>
));
SelectScrollDownButton.displayName = SelectPrimitive.ScrollDownButton.displayName;

function findTriggerForContent(contentEl) {
  if (!contentEl || typeof document === "undefined") return null;
  const contentId = contentEl.getAttribute("id");
  if (!contentId) return null;

  const candidates = document.querySelectorAll("[aria-controls]");
  for (const node of candidates) {
    if (node.getAttribute("aria-controls") !== contentId) continue;
    if (node.getAttribute("aria-expanded") === "true") return node;
  }

  for (const node of candidates) {
    if (node.getAttribute("aria-controls") === contentId) return node;
  }

  return null;
}

const SelectContent = React.forwardRef(
  (
    {
      className,
      children,
      position = "popper",
      side = "bottom",
      align = "start",
      avoidCollisions = false,
      sideOffset = DEFAULT_SIDE_OFFSET,
      ...props
    },
    forwardedRef,
  ) => {
    const contentRef = React.useRef(null);

    const setContentRef = React.useCallback(
      (node) => {
        contentRef.current = node;
        if (typeof forwardedRef === "function") {
          forwardedRef(node);
        } else if (forwardedRef) {
          forwardedRef.current = node;
        }
      },
      [forwardedRef],
    );

    React.useLayoutEffect(() => {
      if (position !== "popper" || typeof window === "undefined") return undefined;

      let rafOne = 0;
      let rafTwo = 0;

      const syncPosition = () => {
        const contentNode = contentRef.current;
        if (!contentNode) return;
        const triggerNode = findTriggerForContent(contentNode);
        if (!triggerNode) return;
        positionSelectPortal({
          contentEl: contentNode,
          triggerEl: triggerNode,
          sideOffset,
        });
      };

      syncPosition();
      rafOne = requestAnimationFrame(() => {
        syncPosition();
        rafTwo = requestAnimationFrame(syncPosition);
      });

      window.addEventListener("resize", syncPosition);
      window.addEventListener("scroll", syncPosition, true);
      window.addEventListener("cortex:ui-scale-changed", syncPosition);

      return () => {
        if (rafOne) cancelAnimationFrame(rafOne);
        if (rafTwo) cancelAnimationFrame(rafTwo);
        window.removeEventListener("resize", syncPosition);
        window.removeEventListener("scroll", syncPosition, true);
        window.removeEventListener("cortex:ui-scale-changed", syncPosition);
      };
    }, [position, sideOffset]);

    return (
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          asChild
          position={position}
          side={side}
          align={align}
          avoidCollisions={avoidCollisions}
          sideOffset={sideOffset}
          {...props}
        >
          <motion.div
            ref={setContentRef}
            className={cn(
              "relative z-50 max-h-96 min-w-[8rem] overflow-hidden rounded-[var(--es-radius-control)] border border-white/10 bg-[#0f1113] text-white shadow-md",
              "font-hud",
              position === "popper" &&
                "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
              className,
            )}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          >
            <SelectScrollUpButton />
            <SelectPrimitive.Viewport
              className={cn(
                "p-1",
                position === "popper" &&
                  "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]",
              )}
            >
              {children}
            </SelectPrimitive.Viewport>
            <SelectScrollDownButton />
          </motion.div>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    );
  },
);
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectLabel = React.forwardRef(({ className, ...props }, ref) => (
  <SelectPrimitive.Label
    ref={ref}
    className={cn("py-1.5 pl-8 pr-2 text-sm font-semibold", className)}
    {...props}
  />
));
SelectLabel.displayName = SelectPrimitive.Label.displayName;

const SelectItem = React.forwardRef(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex w-full cursor-default select-none items-center rounded-[var(--es-radius-control)] py-[calc(6px*var(--es-ui-scale))] pl-[calc(32px*var(--es-ui-scale))] pr-[calc(8px*var(--es-ui-scale))] text-[calc(14px*var(--es-ui-scale))] outline-none focus:bg-white/10 focus:text-white data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      "font-hud",
      className,
    )}
    {...props}
  >
    <span className="absolute left-[calc(8px*var(--es-ui-scale))] flex h-[calc(14px*var(--es-ui-scale))] w-[calc(14px*var(--es-ui-scale))] items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check className="h-[calc(16px*var(--es-ui-scale))] w-[calc(16px*var(--es-ui-scale))]" />
      </SelectPrimitive.ItemIndicator>
    </span>

    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

const SelectSeparator = React.forwardRef(({ className, ...props }, ref) => (
  <SelectPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 my-1 h-px bg-white/10", className)}
    {...props}
  />
));
SelectSeparator.displayName = SelectPrimitive.Separator.displayName;

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
  SelectScrollUpButton,
  SelectScrollDownButton,
};
