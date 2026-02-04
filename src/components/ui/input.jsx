import * as React from "react";
import { cn } from "../../lib/utils";

const Input = React.forwardRef(({ className, type, ...props }, ref) => (
  <input
    type={type}
    className={cn(
      "flex h-9 w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20",
      className,
    )}
    ref={ref}
    {...props}
  />
));
Input.displayName = "Input";

export { Input };
