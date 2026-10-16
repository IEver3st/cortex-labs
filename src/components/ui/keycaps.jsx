import { formatHotkey } from "../../lib/hotkeys";

/** Renders a stored hotkey as Cortex keycaps; renders nothing when unbound. */
export function Keycaps({ hotkey, className = "" }) {
  if (!hotkey?.key) return null;
  const parts = formatHotkey(hotkey).split(" + ");
  return (
    <span className={`cx-keys ${className}`.trim()} aria-hidden="true">
      {parts.map((part) => (
        <kbd className="cx-keycap" key={part}>
          {part}
        </kbd>
      ))}
    </span>
  );
}

export function hotkeyLabel(hotkey) {
  return hotkey?.key ? formatHotkey(hotkey).replace(/ \+ /g, "+") : undefined;
}
