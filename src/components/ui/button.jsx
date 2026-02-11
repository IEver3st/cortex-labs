import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-[calc(8px*var(--es-ui-scale))] rounded-[var(--es-radius-control)] text-[calc(14px*var(--es-ui-scale))] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20 disabled:opacity-50 disabled:pointer-events-none",
  {
    variants: {
      variant: {
        default: "bg-white/10 text-white hover:bg-white/15",
        outline: "border border-white/10 text-white hover:bg-white/10",
        ghost: "text-white/80 hover:text-white hover:bg-white/10",
      },
      size: {
        default: "h-[calc(36px*var(--es-ui-scale))] px-[calc(16px*var(--es-ui-scale))]",
        sm: "h-[calc(32px*var(--es-ui-scale))] px-[calc(12px*var(--es-ui-scale))] text-[calc(12px*var(--es-ui-scale))]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

const Button = React.forwardRef(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size }), className)}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
