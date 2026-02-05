import { useCallback, useEffect, useRef, useState } from "react";
import { formatHotkey, isValidHotkey, parseKeyEvent } from "../lib/hotkeys";

export default function HotkeyInput({ value, onChange, onClear }) {
  const [isCapturing, setIsCapturing] = useState(false);
  const [tempValue, setTempValue] = useState(null);
  const inputRef = useRef(null);

  const handleKeyDown = useCallback(
    (event) => {
      if (!isCapturing) return;

      event.preventDefault();
      event.stopPropagation();

      // Escape cancels capture
      if (event.key === "Escape") {
        setIsCapturing(false);
        setTempValue(null);
        inputRef.current?.blur();
        return;
      }

      // Ignore lone modifier keys
      if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) {
        return;
      }

      const parsed = parseKeyEvent(event);

      if (isValidHotkey(parsed)) {
        setTempValue(parsed);
        onChange?.(parsed);
        setIsCapturing(false);
        inputRef.current?.blur();
      } else {
        // Show temporary invalid state
        setTempValue({ ...parsed, invalid: true });
      }
    },
    [isCapturing, onChange]
  );

  useEffect(() => {
    if (!isCapturing) return;

    const handleGlobalKeyDown = (event) => {
      handleKeyDown(event);
    };

    window.addEventListener("keydown", handleGlobalKeyDown, true);

    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown, true);
    };
  }, [isCapturing, handleKeyDown]);

  const startCapture = () => {
    setIsCapturing(true);
    setTempValue(null);
  };

  const stopCapture = () => {
    setIsCapturing(false);
    setTempValue(null);
  };

  const handleClear = (event) => {
    event.stopPropagation();
    onClear?.();
  };

  const displayValue = tempValue
    ? tempValue.invalid
      ? "Add modifier key"
      : formatHotkey(tempValue)
    : isCapturing
      ? "Press keys..."
      : formatHotkey(value);

  return (
    <div className="hotkey-input-wrapper">
      <button
        ref={inputRef}
        type="button"
        className={`hotkey-input ${isCapturing ? "is-capturing" : ""} ${tempValue?.invalid ? "is-invalid" : ""}`}
        onClick={startCapture}
        onBlur={stopCapture}
      >
        <span className="hotkey-input-value">{displayValue}</span>
      </button>
      {value && value.key && !isCapturing && (
        <button
          type="button"
          className="hotkey-clear"
          onClick={handleClear}
          aria-label="Clear hotkey"
        >
          &times;
        </button>
      )}
    </div>
  );
}
