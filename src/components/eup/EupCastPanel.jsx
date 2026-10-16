import { memo } from "react";
import { AlertTriangle, Loader2, Plus, X } from "lucide-react";
import { buildOutfitLabel } from "../../lib/eup";
import { CAST_SEATS, castLetter } from "../../lib/eup-cast";
import { PED_POSES } from "../../lib/ped-pose";
import { characterLabel, isCustomCharacter } from "../../lib/ped-character";

const GENDER_LABELS = { male: "Male", female: "Female" };

function outfitLine(member) {
  if (isCustomCharacter(member.model)) return member.model.kind === "game" ? "Game ped" : "Your ped files";
  const label = buildOutfitLabel({ gender: member.gender, selections: member.selections?.[member.gender] });
  const cut = label.indexOf(": ");
  const pack = cut >= 0 ? label.slice(cut + 2) : "Game outfit";
  const worn = member.worn?.length || 0;
  return worn ? `${pack} +${worn} ${worn === 1 ? "piece" : "pieces"}` : pack;
}

function CastRow({ seat, member, selected, status, canRemove, onSelect, onRemove }) {
  const letter = castLetter(seat);
  const pose = PED_POSES.find((item) => item.id === member.pose)?.label;
  return (
    <li className={`mw-row ${selected ? "is-selected" : ""}`}>
      <button
        type="button"
        className="mw-row-main"
        onClick={onSelect}
        aria-pressed={selected}
        title={selected ? `Editing character ${letter}` : `Edit character ${letter}`}
      >
        <span className="mw-letter cx-display" aria-hidden="true">{letter}</span>
        <span className="mw-row-text">
          <span className="mw-row-name">
            <span className="sr-only">Character {letter}: </span>
            {isCustomCharacter(member.model) ? status.label || characterLabel(member.model) : GENDER_LABELS[member.gender]}
            {pose ? ` · ${pose}` : ""}
          </span>
          <span className="mw-row-sub">{outfitLine(member)}</span>
        </span>
        {status.loading ? (
          <Loader2 className="mw-row-state is-busy" aria-label="Loading" />
        ) : status.errors ? (
          <AlertTriangle className="mw-row-state is-error" aria-label={`${status.errors} ${status.errors === 1 ? "slot didn't" : "slots didn't"} load`} />
        ) : null}
      </button>
      {canRemove ? (
        <button
          type="button"
          className="cx-icon-btn mw-row-eye"
          onClick={onRemove}
          aria-label={`Remove character ${letter}`}
          title="Take this character off the stage"
        >
          <X aria-hidden="true" />
        </button>
      ) : null}
    </li>
  );
}

/**
 * The characters on the stage. A is always there; B is optional. Selecting a
 * row (or the character in the viewfinder) points the dock and the inspector
 * at that character.
 */
function EupCastPanel({ cast, focus, statuses, onFocus, onAdd, onRemove }) {
  const seats = CAST_SEATS.filter((seat) => cast[seat]);
  const full = seats.length >= CAST_SEATS.length;
  return (
    <section className="mw-lineup eup-cast" aria-labelledby="eup-cast-title">
      <header className="mw-lineup-head">
        <h3 className="lv-slot-title" id="eup-cast-title">Characters</h3>
        <span className="mw-count">{seats.length}/{CAST_SEATS.length}</span>
      </header>
      {full ? (
        <>
          <ol className="mw-rows">
            {seats.map((seat) => (
              <CastRow
                key={seat}
                seat={seat}
                member={cast[seat]}
                selected={seat === focus}
                status={statuses[seat] || {}}
                canRemove
                onSelect={() => onFocus(seat)}
                onRemove={() => onRemove(seat)}
              />
            ))}
          </ol>
          <p className="lv-slot-note mw-tip">
            Each character keeps its own ped, look and outfit. Click one in the viewfinder to edit it.
          </p>
        </>
      ) : (
        <>
          <div className="lv-slot-actions" role="group" aria-label="Add a second character">
            <button type="button" className="cx-btn lv-btn-sm" onClick={() => onAdd("male")} title="Stand a male ped beside this one">
              <Plus aria-hidden="true" />
              Male
            </button>
            <button type="button" className="cx-btn lv-btn-sm" onClick={() => onAdd("female")} title="Stand a female ped beside this one">
              <Plus aria-hidden="true" />
              Female
            </button>
          </div>
          <p className="lv-slot-note">Add a second character with its own ped, look and outfit, side by side on one stage.</p>
        </>
      )}
    </section>
  );
}

export default memo(EupCastPanel);
