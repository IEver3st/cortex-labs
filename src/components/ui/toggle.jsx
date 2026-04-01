import * as React from "react";

const Toggle = React.forwardRef(
  ({ checked, onChange, ariaLabel, className, ...props }, ref) => {
    return (
      <button
        ref={ref}
        type="button"
        className={`settings-toggle ${checked ? "is-on" : ""}${className ? ` ${className}` : ""}`}
        onClick={() => onChange(!checked)}
        aria-pressed={checked}
        aria-label={ariaLabel}
        {...props}
      >
        <span className="settings-toggle-dot" />
      </button>
    );
  }
);
Toggle.displayName = "Toggle";

export { Toggle };