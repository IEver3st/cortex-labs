import { memo, useState } from "react";
import { AlertTriangle, Box, Copy, Eye, EyeOff, FileUp, FolderSearch, Loader2, RotateCw, Search, X } from "lucide-react";
import { MAX_SCENE_PROPS, scenePropLabel } from "../../lib/eup-scene";
import { splitPath } from "../workspace/parts";
import { NumberField, SearchBox } from "./EupPosePanel";

const AXES = [
  { index: 0, label: "X", step: 0.05 },
  { index: 1, label: "Lift", step: 0.01 },
  { index: 2, label: "Z", step: 0.05 },
];

function SetRow({ prop, state, selected, full, onSelect, onToggleHidden, onDuplicate, onRemove, onRetry, onLocate }) {
  const label = scenePropLabel(prop);
  const status = state?.status;
  const meta = status === "missing"
    ? "File not found"
    : prop.source === "file"
      ? splitPath(prop.path).folder
      : "Game prop";
  return (
    <li className={`eup-set-row ${selected ? "is-selected" : ""} ${prop.hidden ? "is-hidden" : ""}`}>
      <button
        type="button"
        className="eup-set-main"
        aria-pressed={selected}
        onClick={() => onSelect(selected ? null : prop.id)}
        title={prop.source === "file" ? prop.path : prop.name}
      >
        <Box className="eup-set-icon" aria-hidden="true" />
        <span className="eup-set-text">
          <span className="eup-set-name">{label}</span>
          <span className={`eup-set-meta ${status === "missing" ? "is-error" : ""}`}>{meta}</span>
        </span>
        {status === "loading" ? <Loader2 className="eup-spin eup-set-state" aria-label="Loading" /> : null}
        {status === "error" || status === "missing" ? <AlertTriangle className="eup-set-state is-error" aria-label="Didn't load" /> : null}
      </button>
      <span className="eup-set-actions">
        {status === "missing" ? (
          <button type="button" className="cx-icon-btn" onClick={onLocate} aria-label={`Locate ${label}`} title="Locate the file">
            <FolderSearch aria-hidden="true" />
          </button>
        ) : null}
        {status === "error" ? (
          <button type="button" className="cx-icon-btn" onClick={onRetry} aria-label={`Retry ${label}`} title="Try again">
            <RotateCw aria-hidden="true" />
          </button>
        ) : null}
        <button
          type="button"
          className="cx-icon-btn"
          onClick={onToggleHidden}
          aria-label={prop.hidden ? `Show ${label}` : `Hide ${label}`}
          title={prop.hidden ? "Show" : "Hide"}
          aria-pressed={prop.hidden}
        >
          {prop.hidden ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        </button>
        <button
          type="button"
          className="cx-icon-btn"
          onClick={onDuplicate}
          disabled={full}
          aria-label={`Duplicate ${label}`}
          title={full ? `The set holds ${MAX_SCENE_PROPS} props` : "Duplicate"}
        >
          <Copy aria-hidden="true" />
        </button>
        <button type="button" className="cx-icon-btn" onClick={onRemove} aria-label={`Remove ${label}`} title="Remove (Delete)">
          <X aria-hidden="true" />
        </button>
      </span>
      {status === "missing" ? (
        <p className="eup-set-note">
          {prop.path} isn&apos;t there any more.{" "}
          <button type="button" className="lv-link" onClick={onLocate}>Locate…</button>{" "}
          <button type="button" className="lv-link" onClick={onRemove}>Remove</button>
        </p>
      ) : status === "error" ? (
        <p className="eup-set-note">
          {state.error}
          {prop.source === "file" ? (
            <>
              {" "}
              <button type="button" className="lv-link" onClick={onLocate}>Locate…</button>
            </>
          ) : null}
        </p>
      ) : state?.warning ? (
        <p className="eup-set-note is-warn">{state.warning}</p>
      ) : null}
    </li>
  );
}

function Placement({ prop, gizmoMode, onGizmoModeChange, onChange }) {
  const setAxis = (index, value) => {
    const position = [...prop.position];
    position[index] = value;
    onChange({ position });
  };
  return (
    <section className="lv-group">
      <div className="lv-group-head">
        <h3 className="lv-group-title">Placement</h3>
        <span className="eup-set-selected eup-mono" title={prop.source === "file" ? prop.path : prop.name}>{scenePropLabel(prop)}</span>
      </div>
      <div className="lv-seg" role="radiogroup" aria-label="Gizmo">
        {[
          { id: "translate", label: "Move", key: "G" },
          { id: "rotate", label: "Turn", key: "R" },
        ].map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={gizmoMode === option.id}
            className={`lv-seg-btn ${gizmoMode === option.id ? "is-on" : ""}`}
            onClick={() => onGizmoModeChange(option.id)}
            title={`${option.label} with the gizmo (${option.key})`}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className="eup-set-grid" role="group" aria-label="Position and turn">
        {AXES.map((axis) => (
          <NumberField
            key={axis.label}
            label={axis.label}
            value={prop.position[axis.index]}
            step={axis.step}
            onCommit={(value) => setAxis(axis.index, value)}
          />
        ))}
        <NumberField label="Turn" value={prop.yaw} step={5} onCommit={(yaw) => onChange({ yaw })} />
      </div>
      <div className="eup-set-foot">
        <button type="button" className="lv-link" disabled={prop.position[1] === 0} onClick={() => setAxis(1, 0)}>
          Put on the floor
        </button>
      </div>
      <p className="lv-slot-note">
        <span>
          Drag the gizmo in the viewfinder or type metres and degrees. <kbd className="cx-keycap">G</kbd> moves,{" "}
          <kbd className="cx-keycap">R</kbd> turns, <kbd className="cx-keycap">Del</kbd> removes, <kbd className="cx-keycap">Esc</kbd> lets go.
        </span>
      </p>
    </section>
  );
}

/**
 * The Scene tab's set: props standing on the floor around the characters,
 * from the game files or the user's own models. Selection is shared with the
 * viewfinder, where the gizmo moves the selected prop.
 */
function EupScenePanel({
  isTauriRuntime,
  props,
  states,
  selectedId,
  onSelect,
  searchProps,
  onAddGame,
  onAddFile,
  onChange,
  onToggleHidden,
  onDuplicate,
  onRemove,
  onRetry,
  onLocate,
  removed,
  onUndo,
  gizmoMode,
  onGizmoModeChange,
}) {
  const [searching, setSearching] = useState(false);
  const full = props.length >= MAX_SCENE_PROPS;
  const canAdd = isTauriRuntime && !full;
  const selected = props.find((prop) => prop.id === selectedId) || null;

  return (
    <>
      <section className="lv-group eup-set">
        <div className="lv-group-head">
          <h3 className="lv-group-title" id="eup-set-label">Props on set</h3>
          <span className="eup-set-count">{props.length}/{MAX_SCENE_PROPS}</span>
        </div>
        {props.length ? (
          <ul className="eup-set-list" aria-labelledby="eup-set-label">
            {props.map((prop) => (
              <SetRow
                key={prop.id}
                prop={prop}
                state={states[prop.id]}
                selected={prop.id === selectedId}
                full={full}
                onSelect={onSelect}
                onToggleHidden={() => onToggleHidden(prop.id)}
                onDuplicate={() => onDuplicate(prop.id)}
                onRemove={() => onRemove(prop.id)}
                onRetry={() => onRetry(prop.id)}
                onLocate={() => onLocate(prop.id)}
              />
            ))}
          </ul>
        ) : (
          <p className="lv-slot-note">
            {isTauriRuntime
              ? "Cones, barriers, a desk: props from the game files or your own models, standing on the floor beside the characters."
              : "Placing props needs the desktop app."}
          </p>
        )}
        {removed ? (
          <p className="lv-slot-note eup-undo-note" role="status">
            <span>{`Removed ${scenePropLabel(removed.prop)}.`}</span>
            <button type="button" className="lv-link" onClick={onUndo}>Undo</button>
          </p>
        ) : null}
        {full ? (
          <p className="lv-slot-note is-warn">
            <span className="lv-dot" aria-hidden="true" />
            The set holds {MAX_SCENE_PROPS} props. Remove one to add another.
          </p>
        ) : null}
        {isTauriRuntime ? (
          <div className="lv-slot-actions">
            <button
              type="button"
              className="cx-btn lv-btn-sm"
              aria-expanded={searching && canAdd}
              disabled={!canAdd}
              onClick={() => setSearching((open) => !open)}
            >
              <Search aria-hidden="true" />
              Game prop
            </button>
            <button type="button" className="cx-btn lv-btn-sm" disabled={!canAdd} onClick={onAddFile}>
              <FileUp aria-hidden="true" />
              From file
            </button>
          </div>
        ) : null}
        {searching && canAdd ? (
          <SearchBox
            label="Game props"
            placeholder="Search props, e.g. cone, barrier, desk"
            search={searchProps}
            onPick={(name) => {
              onAddGame(name);
              setSearching(false);
            }}
          />
        ) : null}
        {isTauriRuntime && props.length ? (
          <p className="lv-slot-note">
            Click a prop here or in the viewfinder to move it. Props show in views, shots, colourway sheets and videos, not in
            thumbnails, and the camera presets frame the characters only.
          </p>
        ) : null}
      </section>
      {selected ? (
        <Placement
          prop={selected}
          gizmoMode={gizmoMode}
          onGizmoModeChange={onGizmoModeChange}
          onChange={(patch) => onChange(selected.id, patch)}
        />
      ) : null}
    </>
  );
}

export default memo(EupScenePanel);
