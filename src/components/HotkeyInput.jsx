import { useCallback, useEffect, useRef, useState } from "react";
import { formatHotkey, hotkeyProblem, parseKeyEvent } from "../lib/hotkeys";

const PROBLEM_TEXT = {
  needsModifier: "Add a modifier",
  needsCtrlOrAlt: "Add Ctrl or Alt",
  reserved: "Pick another key",
};

// `pending` is a captured key the parent hasn't applied yet (a conflict it is
// asking about). The field shows it until the parent applies or drops it, then
// shows `value` again; a capture never keeps its own copy of the key.
export default function HotkeyInput({ value, pending = null, onChange, onClear }) {
  const [isCapturing, setIsCapturing] = useState(false);
  const [tempValue, setTempValue] = useState(null);
  const inputRef = useRef(null);

  const handleKeyDown = useCallback(
    (event) => {
      if (!isCapturing) return;

      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        setIsCapturing(false);
        setTempValue(null);
        inputRef.current?.blur();
        return;
      }

      if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) {
        return;
      }

      const parsed = parseKeyEvent(event);
      const problem = hotkeyProblem(parsed);

      if (!problem) {
        setTempValue(null);
        onChange?.(parsed);
        setIsCapturing(false);
        inputRef.current?.blur();
      } else {
        setTempValue({ ...parsed, invalid: PROBLEM_TEXT[problem] || PROBLEM_TEXT.reserved });
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
      ? tempValue.invalid
      : formatHotkey(tempValue)
    : isCapturing
      ? "Press keys..."
      : formatHotkey(pending?.key ? pending : value);

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
