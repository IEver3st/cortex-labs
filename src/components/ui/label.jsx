import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "../../lib/utils";

const Label = React.forwardRef(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn("text-xs uppercase tracking-[0.12em] text-white/50", className)}
    {...props}
  />
));
Label.displayName = LabelPrimitive.Root.displayName;

export { Label };
