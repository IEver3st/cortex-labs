import { memo } from "react";
import { AlertTriangle, Image as ImageIcon, Loader2, X } from "lucide-react";
import { COMPONENT_IDS, MAX_ADDON_PIECES, PROP_IDS, baseName, componentDisplayName } from "../../lib/eup";
import { Toggle } from "../ui/toggle";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { DropButton } from "../workspace/parts";
import { EupStep } from "./EupSourcePanel";

const SLOT_OPTIONS = [...COMPONENT_IDS, ...PROP_IDS];

function formatCount(value) {
  return Number.isFinite(value) ? value.toLocaleString("en-US") : "0";
}

function PieceStatus({ piece, state }) {
  if (!piece.worn) return <p className="lv-slot-note">Not worn</p>;
  if (!state || state.pieceId !== piece.id) return null;
  if (state.status === "loading") {
    return (
      <p className="lv-slot-note is-busy" role="status">
        <Loader2 className="eup-spin" aria-hidden="true" />
        Loading…
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <p className="lv-slot-note is-error" role="alert">
        <span className="lv-dot" aria-hidden="true" />
        {state.error}
      </p>
    );
  }
  const stats = state.info?.stats;
  return (
    <>
      <p className="lv-slot-note is-live" role="status">
        <span className="lv-dot" aria-hidden="true" />
        Wearing{stats ? ` · ${formatCount(stats.triangles)} tris` : ""}
      </p>
      {state.error ? (
        <p className="lv-slot-note is-warn" role="status">
          <span className="lv-dot" aria-hidden="true" />
          {state.error}
        </p>
      ) : null}
    </>
  );
}

function PieceRow({ piece, state, onToggleWorn, onChangeComponent, onPickTexture, onClearTexture, onRemove }) {
  const name = baseName(piece.drawablePath);
  const texture = piece.texturePath ? baseName(piece.texturePath) : "";
  const failed = piece.worn && state?.pieceId === piece.id && state.status === "error";
  return (
    <li className={`eup-piece ${piece.worn ? "is-worn" : ""}`}>
      <div className="eup-piece-head">
        <Toggle checked={piece.worn} onChange={onToggleWorn} ariaLabel={piece.worn ? `Take off ${name}` : `Wear ${name}`} />
        <span className="eup-piece-name" title={piece.drawablePath}>{name}</span>
        {failed ? <AlertTriangle className="eup-error-icon" aria-hidden="true" /> : null}
        <button type="button" className="cx-icon-btn" onClick={onRemove} aria-label={`Remove ${name}`} title="Remove from this session">
          <X aria-hidden="true" />
        </button>
      </div>
      <div className="eup-piece-body">
        <Select value={piece.component} onValueChange={onChangeComponent}>
          <SelectTrigger className="lv-select" aria-label={`Slot for ${name}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="lv-select-content">
            {SLOT_OPTIONS.map((component) => (
              <SelectItem key={component} value={component}>
                {componentDisplayName(component)} · {component}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="eup-piece-texture">
          <ImageIcon aria-hidden="true" />
          <span className={texture ? "" : "is-empty"} title={piece.texturePath || undefined}>
            {texture || "No texture"}
          </span>
          <button type="button" className="lv-link" onClick={onPickTexture}>
            {texture ? "Change" : "Choose"}
          </button>
          {texture ? (
            <button type="button" className="lv-link" onClick={onClearTexture}>Clear</button>
          ) : null}
        </div>
        <PieceStatus piece={piece} state={state} />
      </div>
    </li>
  );
}

/**
 * Addon pieces: single .ydd files of any name, each worn in its own slot over
 * the pack and base clothing. Several can be worn at once, one per slot.
 */
function EupPiecesPanel({
  step,
  isTauriRuntime,
  pieces,
  otherGenderCount,
  totalCount,
  slotStates,
  onAdd,
  onToggleWorn,
  onChangeComponent,
  onPickTexture,
  onClearTexture,
  onRemove,
  blockedNote = "",
}) {
  const wornCount = pieces.filter((piece) => piece.worn).length;
  const full = totalCount >= MAX_ADDON_PIECES;
  return (
    <EupStep
      step={step}
      done={wornCount > 0}
      title="Addon pieces"
      trailing={pieces.length > 0 ? <span className="eup-step-count">{wornCount}/{pieces.length} worn</span> : null}
    >
      {!isTauriRuntime ? (
        <p className="lv-slot-note">Adding pieces needs the desktop app.</p>
      ) : blockedNote ? (
        <p className="lv-slot-note">{blockedNote}</p>
      ) : pieces.length === 0 ? (
        <DropButton
          title="Add addon pieces"
          hint="Any .ydd, named any way. A matching .ytd, PSD or PNG next to it is used as its texture."
          onClick={onAdd}
        />
      ) : (
        <>
          <ul className="eup-pieces">
            {pieces.map((piece) => (
              <PieceRow
                key={piece.id}
                piece={piece}
                state={slotStates?.[piece.component]}
                onToggleWorn={(worn) => onToggleWorn(piece.id, worn)}
                onChangeComponent={(component) => onChangeComponent(piece.id, component)}
                onPickTexture={() => onPickTexture(piece.id)}
                onClearTexture={() => onClearTexture(piece.id)}
                onRemove={() => onRemove(piece.id)}
              />
            ))}
          </ul>
          <div className="lv-slot-actions">
            <button
              type="button"
              className="cx-btn lv-btn-sm"
              onClick={onAdd}
              disabled={full}
              title={full ? `A session holds ${MAX_ADDON_PIECES} pieces` : "Add more .ydd pieces"}
            >
              Add pieces
            </button>
          </div>
          <p className="lv-slot-note">One piece per slot is worn at a time, as in game. Wearing one takes its slot from the pack and base clothing.</p>
        </>
      )}
      {otherGenderCount > 0 ? (
        <p className="lv-slot-note">{otherGenderCount} {otherGenderCount === 1 ? "piece is" : "pieces are"} for the other ped.</p>
      ) : null}
    </EupStep>
  );
}

export default memo(EupPiecesPanel);
