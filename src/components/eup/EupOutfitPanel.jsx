import { memo, useState } from "react";
import { ClipboardCopy, Trash2 } from "lucide-react";
import { EupStep } from "./EupSourcePanel";

// Named outfits for the current ped, kept across every EUP Studio session.
// Applying one replaces the pack selection and base slots; pack files that
// are not loaded fall back to base.
function EupOutfitPanel({ step, outfits, otherCount = 0, otherPed, suggestedName, onSave, onApply, onDelete, onCopyLua, onCopyCurrentLua, blockedNote = "" }) {
  const [name, setName] = useState("");
  const list = Array.isArray(outfits) ? outfits : [];
  // An empty name saves under the suggested one shown in the field.
  const pending = name.trim() || String(suggestedName || "").trim();
  const replaces = pending && list.some((preset) => preset.name.toLowerCase() === pending.toLowerCase());

  const submit = (event) => {
    event.preventDefault();
    if (!pending) return;
    if (onSave(pending) !== false) setName("");
  };

  // Outfits are freemode drawable numbers; another ped has nothing to save or export.
  if (blockedNote) {
    return (
      <EupStep step={step} done={false} title="Outfit">
        <p className="lv-slot-note">{blockedNote}</p>
      </EupStep>
    );
  }

  return (
    <EupStep
      step={step}
      done={list.length > 0}
      title="Outfit"
      trailing={(
        <button
          type="button"
          className="cx-icon-btn"
          onClick={onCopyCurrentLua}
          aria-label="Copy the current outfit as Lua"
          title="Copy the current outfit as Lua"
        >
          <ClipboardCopy aria-hidden="true" />
        </button>
      )}
    >
      <form className="eup-outfit-form" onSubmit={submit}>
        <input
          className="eup-input"
          value={name}
          maxLength={80}
          placeholder={suggestedName}
          aria-label="Outfit name"
          onChange={(event) => setName(event.target.value)}
        />
        <button
          type="submit"
          className="cx-btn lv-btn-sm"
          disabled={!pending}
          title={replaces ? "Replace the saved outfit with this name" : "Save the current outfit"}
        >
          {replaces ? "Replace" : "Save"}
        </button>
      </form>
      {list.length === 0 ? (
        <p className="lv-slot-note">Name the current outfit to keep it for this ped in every session.</p>
      ) : (
        <ul className="eup-outfits" aria-label="Saved outfits">
          {list.map((preset) => (
            <li key={preset.id} className="eup-outfit">
              <button type="button" className="eup-outfit-apply" onClick={() => onApply(preset)} title={`Wear ${preset.name}`}>
                {preset.name}
              </button>
              <button
                type="button"
                className="cx-icon-btn"
                aria-label={`Copy ${preset.name} as Lua`}
                title="Copy as Lua"
                onClick={() => onCopyLua(preset)}
              >
                <ClipboardCopy aria-hidden="true" />
              </button>
              <button
                type="button"
                className="cx-icon-btn is-danger"
                aria-label={`Delete ${preset.name}`}
                title="Delete outfit"
                onClick={() => onDelete(preset)}
              >
                <Trash2 aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {otherCount > 0 ? (
        <p className="lv-slot-note">
          {otherCount} saved for the {otherPed} ped. Switch the ped to see {otherCount === 1 ? "it" : "them"}.
        </p>
      ) : null}
    </EupStep>
  );
}

export default memo(EupOutfitPanel);
