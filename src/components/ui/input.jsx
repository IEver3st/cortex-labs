import * as React from "react";
import { cn } from "../../lib/utils";

const Input = React.forwardRef(({ className, type, ...props }, ref) => (
  <input
    type={type}
    className={cn(
      "flex h-[calc(36px*var(--es-ui-scale))] w-full rounded-[var(--es-radius-control)] border border-white/10 bg-white/5 px-[calc(12px*var(--es-ui-scale))] py-[calc(8px*var(--es-ui-scale))] text-[calc(14px*var(--es-ui-scale))] text-white placeholder:text-white/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20",
      className,
    )}
    ref={ref}
    {...props}
  />
));
Input.displayName = "Input";

export { Input };
