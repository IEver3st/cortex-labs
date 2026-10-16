import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "../../lib/utils";

/* Studio select. Styles live in studio.css (`cx-select-*`); consumers may add
   a surface class for density. Portalled content inherits the UI scale fix in
   studio.css, so Floating UI's own placement and collision handling are exact. */

// Only one select menu may be open at a time, app-wide. Opening another one
// closes the previous menu even when its outside-press dismissal did not run.
let closeActiveSelect = null;

function Select({ open: openProp, defaultOpen = false, onOpenChange, ...props }) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const open = openProp ?? uncontrolledOpen;
  const handleOpenChange = React.useCallback((next) => {
    if (openProp === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }, [openProp, onOpenChange]);
  const closeRef = React.useRef(null);
  closeRef.current = () => handleOpenChange(false);

  React.useEffect(() => {
    if (!open) return undefined;
    const close = () => closeRef.current?.();
    if (closeActiveSelect && closeActiveSelect !== close) closeActiveSelect();
    closeActiveSelect = close;
    return () => {
      if (closeActiveSelect === close) closeActiveSelect = null;
    };
  }, [open]);

  return <SelectPrimitive.Root open={open} onOpenChange={handleOpenChange} {...props} />;
}

const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

const SelectTrigger = React.forwardRef(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger ref={ref} className={cn("cx-select-trigger", className)} {...props}>
    <span className="cx-select-value">{children}</span>
    <SelectPrimitive.Icon asChild>
      <ChevronDown className="cx-select-chevron" aria-hidden="true" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectScrollUpButton = React.forwardRef(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpButton ref={ref} className={cn("cx-select-scroll", className)} {...props}>
    <ChevronUp aria-hidden="true" />
  </SelectPrimitive.ScrollUpButton>
));
SelectScrollUpButton.displayName = SelectPrimitive.ScrollUpButton.displayName;

const SelectScrollDownButton = React.forwardRef(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownButton ref={ref} className={cn("cx-select-scroll", className)} {...props}>
    <ChevronDown aria-hidden="true" />
  </SelectPrimitive.ScrollDownButton>
));
SelectScrollDownButton.displayName = SelectPrimitive.ScrollDownButton.displayName;

const SelectContent = React.forwardRef(
  ({ className, children, position = "popper", side = "bottom", align = "start", sideOffset = 4, ...props }, ref) => (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        position={position}
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn("cx-select-content", className)}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport className="cx-select-viewport">{children}</SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  ),
);
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectLabel = React.forwardRef(({ className, ...props }, ref) => (
  <SelectPrimitive.Label ref={ref} className={cn("cx-select-label", className)} {...props} />
));
SelectLabel.displayName = SelectPrimitive.Label.displayName;

/* `description` renders under the label in the menu only; the trigger shows
   just the item text. */
const SelectItem = React.forwardRef(({ className, children, description, ...props }, ref) => (
  <SelectPrimitive.Item ref={ref} className={cn("cx-select-item", className)} {...props}>
    <span className="cx-select-item-text">
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      {description ? <span className="cx-select-item-desc">{description}</span> : null}
    </span>
    <SelectPrimitive.ItemIndicator className="cx-select-check">
      <Check aria-hidden="true" />
    </SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

const SelectSeparator = React.forwardRef(({ className, ...props }, ref) => (
  <SelectPrimitive.Separator ref={ref} className={cn("cx-select-separator", className)} {...props} />
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
