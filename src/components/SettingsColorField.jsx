import { ColorInput } from "./ui/color-input";

export function ColorField({ label, value, onChange, onReset }) {
  return (
    <div className="settings-color-field">
      <div className="settings-row-title">{label}</div>
      <div className="settings-color-controls">
        <div className="settings-color-swatch">
          <div className="settings-color-chip" style={{ background: value }} />
          <ColorInput value={value} onChange={onChange} label={`${label} picker`} />
        </div>
        <input
          className="settings-input flex-1"
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          aria-label={`${label} hex color`}
        />
        <button
          type="button"
          className="settings-mini shrink-0"
          onClick={onReset}
        >
          Reset
        </button>
      </div>
    </div>
  );
}
