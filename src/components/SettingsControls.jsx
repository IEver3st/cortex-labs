// Settings rows shared by the Settings sections: a labelled slider and a
// segmented choice. Options are { value, label }.

export function SliderRow({ title, desc, min, max, step, value, onChange, format }) {
  return (
    <div className="settings-row">
      <div className="settings-row-label">
        <div className="settings-row-title">{title}</div>
        {desc ? <div className="settings-row-desc">{desc}</div> : null}
      </div>
      <div className="settings-slider-field">
        <input
          type="range"
          className="settings-slider"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(parseFloat(event.currentTarget.value))}
          aria-label={title}
        />
        <span className="settings-slider-value">{format(value)}</span>
      </div>
    </div>
  );
}

export function Segmented({ label, options, value, onChange }) {
  return (
    <div className="settings-seg" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={`settings-seg-btn ${value === option.value ? "is-on" : ""}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
