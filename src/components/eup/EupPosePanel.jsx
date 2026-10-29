import { memo, useEffect, useRef, useState } from "react";
import { FileUp, Move3d, RefreshCw, Search, X } from "lucide-react";
import { CUSTOM_POSE, MAX_HELD_PROPS, PED_POSES, PROP_ATTACH_BONES } from "../../lib/ped-pose";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { DropButton, FileCard, splitPath } from "../workspace/parts";
import { EupStep } from "./EupSourcePanel";

const SEARCH_DEBOUNCE_MS = 220;
const SEARCH_PATTERN = /^[a-z0-9_@.\- ]{1,64}$/;
const SLOW_SEARCH_NOTE = "Searching the game files. The first search indexes them and can take a minute.";
const OTHER_BONE = "other";

function errorText(error) {
  if (!error) return "Unknown error";
  return typeof error === "string" ? error : error.message || String(error);
}

function formatDuration(seconds) {
  return Number.isFinite(seconds) && seconds > 0 ? `${seconds.toFixed(seconds < 10 ? 2 : 1)}s` : "";
}

/**
 * Debounced search against the game files. `search(query)` resolves to a list
 * of names; stale responses are dropped.
 */
function useGameSearch(search, enabled) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState({ status: "idle", results: [], total: 0, error: "" });
  const runRef = useRef(0);
  useEffect(() => {
    const text = query.trim().toLowerCase();
    if (!enabled || !text) {
      runRef.current += 1;
      setState({ status: "idle", results: [], total: 0, error: "" });
      return undefined;
    }
    if (!SEARCH_PATTERN.test(text)) {
      setState({ status: "error", results: [], total: 0, error: "Use letters, digits, _ @ . - and spaces." });
      return undefined;
    }
    const run = ++runRef.current;
    const timer = setTimeout(() => {
      setState((prev) => ({ ...prev, status: "searching", error: "" }));
      search(text).then(
        (result) => run === runRef.current && setState({ status: "ready", results: result.names, total: result.total, error: "" }),
        (error) => run === runRef.current && setState({ status: "error", results: [], total: 0, error: errorText(error) }),
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, enabled, search]);
  return { query, setQuery, ...state };
}

export function SearchBox({ label, placeholder, search, onPick, disabled }) {
  const { query, setQuery, status, results, total, error } = useGameSearch(search, !disabled);
  return (
    <div className="eup-anim-search">
      <label className="eup-search-field">
        <Search aria-hidden="true" />
        <input
          className="eup-input eup-mono"
          type="search"
          value={query}
          maxLength={64}
          spellCheck={false}
          placeholder={placeholder}
          aria-label={label}
          disabled={disabled}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {status === "searching" ? (
        <p className="lv-slot-note is-busy" role="status">{SLOW_SEARCH_NOTE}</p>
      ) : status === "error" ? (
        <p className="lv-slot-note is-error" role="alert"><span className="lv-dot" aria-hidden="true" />{error}</p>
      ) : status === "ready" && results.length === 0 ? (
        <p className="lv-slot-note">Nothing in the game files matches “{query.trim()}”.</p>
      ) : null}
      {results.length ? (
        <>
          <ul className="eup-anim-results custom-scrollbar" aria-label={`${label} results`}>
            {results.map((name) => (
              <li key={name}>
                <button type="button" className="eup-anim-result eup-mono" title={name} onClick={() => onPick(name)}>
                  {name}
                </button>
              </li>
            ))}
          </ul>
          {total > results.length ? (
            <p className="lv-slot-note">Showing {results.length} of {total}. Add words to narrow it down.</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** Number input that lets the user type through "-" and "0." before committing. */
export function NumberField({ label, value, step, onCommit }) {
  const [draft, setDraft] = useState(String(value));
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!focusedRef.current) setDraft(String(value));
  }, [value]);
  return (
    <label className="eup-num">
      <span className="eup-num-label">{label}</span>
      <input
        className="eup-input eup-mono"
        type="number"
        inputMode="decimal"
        step={step}
        value={draft}
        aria-label={label}
        onFocus={() => { focusedRef.current = true; }}
        onBlur={() => {
          focusedRef.current = false;
          setDraft(String(value));
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          const number = Number(event.target.value);
          if (event.target.value.trim() !== "" && Number.isFinite(number)) onCommit(number);
        }}
      />
    </label>
  );
}

function ClipPicker({ listing, clip, onClipChange }) {
  if (listing.status === "loading") return <p className="lv-slot-note is-busy" role="status">Reading the clips…</p>;
  if (listing.status === "error") {
    return <p className="lv-slot-note is-error" role="alert"><span className="lv-dot" aria-hidden="true" />{listing.error}</p>;
  }
  if (listing.status !== "ready") return null;
  if (!listing.clips.length) return <p className="lv-slot-note is-warn"><span className="lv-dot" aria-hidden="true" />This dictionary has no clips.</p>;
  return (
    <Select value={clip || undefined} onValueChange={onClipChange}>
      <SelectTrigger className="lv-select eup-mono" aria-label="Clip">
        <SelectValue placeholder={`Choose one of ${listing.clips.length} clips`} />
      </SelectTrigger>
      <SelectContent className="lv-select-content">
        {listing.clips.map((item) => (
          <SelectItem key={item.name} value={item.name}>
            {item.name}
            {formatDuration(item.duration) ? <span className="eup-clip-duration"> {formatDuration(item.duration)}</span> : null}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function HeldPropRow({ prop, state, boneMissing, selected, onSelect, onChange, onRemove }) {
  const known = PROP_ATTACH_BONES.some((bone) => bone.tag === prop.bone);
  const [otherBone, setOtherBone] = useState(!known);
  const label = prop.source === "file" ? splitPath(prop.path).name : prop.name;
  const setAxis = (key, axis, number) => {
    const next = [...prop[key]];
    next[axis] = number;
    onChange({ [key]: next });
  };
  return (
    <li className={`eup-held ${selected ? "is-selected" : ""}`}>
      <div className="eup-held-head">
        <span className="eup-held-name eup-mono" title={prop.source === "file" ? prop.path : prop.name}>{label}</span>
        <span className="eup-held-source">{prop.source === "file" ? "File" : "Game"}</span>
        {onSelect ? (
          <button
            type="button"
            className="cx-icon-btn"
            aria-pressed={selected && !boneMissing}
            aria-label={`Move ${label} in the viewfinder`}
            title={boneMissing
              ? "Pick a bone this ped has to move it in the viewfinder"
              : selected ? "Put the gizmo away" : "Move and turn it with the gizmo in the viewfinder"}
            disabled={boneMissing}
            onClick={onSelect}
          >
            <Move3d aria-hidden="true" />
          </button>
        ) : null}
        <button type="button" className="cx-icon-btn" aria-label={`Remove ${label}`} title="Remove this prop" onClick={onRemove}>
          <X aria-hidden="true" />
        </button>
      </div>
      <div className="eup-held-bone">
        <Select
          value={otherBone ? OTHER_BONE : String(prop.bone)}
          onValueChange={(value) => {
            if (value === OTHER_BONE) {
              setOtherBone(true);
              return;
            }
            setOtherBone(false);
            onChange({ bone: Number(value) });
          }}
        >
          <SelectTrigger className="lv-select" aria-label={`Bone for ${label}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="lv-select-content">
            {PROP_ATTACH_BONES.map((bone) => (
              <SelectItem key={bone.tag} value={String(bone.tag)}>{bone.label}</SelectItem>
            ))}
            <SelectItem value={OTHER_BONE}>Other bone ID</SelectItem>
          </SelectContent>
        </Select>
        {otherBone ? (
          <NumberField
            label="Bone ID"
            value={prop.bone}
            step={1}
            onCommit={(number) => Number.isInteger(number) && number >= 0 && number <= 0xffff && onChange({ bone: number })}
          />
        ) : null}
      </div>
      <div className="eup-held-grid" role="group" aria-label={`Offset for ${label}`}>
        {["X", "Y", "Z"].map((axis, i) => (
          <NumberField key={`p${axis}`} label={`Offset ${axis}`} value={prop.position[i]} step={0.01} onCommit={(n) => setAxis("position", i, n)} />
        ))}
        {["X", "Y", "Z"].map((axis, i) => (
          <NumberField key={`r${axis}`} label={`Rotation ${axis}`} value={prop.rotation[i]} step={1} onCommit={(n) => setAxis("rotation", i, n)} />
        ))}
      </div>
      {state?.status === "loading" ? (
        <p className="lv-slot-note is-busy" role="status">Loading the model…</p>
      ) : state?.status === "error" ? (
        <p className="lv-slot-note is-error" role="alert"><span className="lv-dot" aria-hidden="true" />{state.error}</p>
      ) : boneMissing ? (
        <p className="lv-slot-note is-warn"><span className="lv-dot" aria-hidden="true" />Bone {prop.bone} isn't in this ped's skeleton, so the prop is hidden.</p>
      ) : state?.warning ? (
        <p className="lv-slot-note is-warn"><span className="lv-dot" aria-hidden="true" />{state.warning}</p>
      ) : null}
    </li>
  );
}

/**
 * Pipeline step 3: how the ped stands. A preset, any clip in the game files,
 * or a clip from the user's own .ycd, plus props held on a bone the way
 * FiveM's AttachEntityToEntity holds them.
 */
function EupPosePanel({
  step,
  isTauriRuntime,
  pose,
  onPoseChange,
  poseError,
  poseNote,
  poseNoteIsError,
  clipReady,
  customAnimation,
  onCustomAnimationChange,
  clipListing,
  onPickYcd,
  onReloadYcd,
  searchDicts,
  heldProps,
  heldStates,
  skeletonTags,
  onAddGameProp,
  onAddFileProp,
  onChangeProp,
  onRemoveProp,
  searchProps,
  onImportEmote,
  playback = null,
  selectedHeldId = null,
  onSelectHeld = null,
}) {
  const [source, setSource] = useState(customAnimation?.source === "file" ? "file" : "game");
  const [addingGameProp, setAddingGameProp] = useState(false);
  const [emoteOpen, setEmoteOpen] = useState(false);
  const [emoteText, setEmoteText] = useState("");
  const [emoteNote, setEmoteNote] = useState(null);
  const custom = pose === CUSTOM_POSE;
  const blocked = Boolean(poseError) || !isTauriRuntime;
  const gameAnim = customAnimation?.source === "game" ? customAnimation : null;
  const fileAnim = customAnimation?.source === "file" ? customAnimation : null;
  const canAddProp = heldProps.length < MAX_HELD_PROPS && isTauriRuntime;

  useEffect(() => {
    if (customAnimation?.source) setSource(customAnimation.source);
  }, [customAnimation?.source]);

  const applyEmote = () => {
    const result = onImportEmote(emoteText);
    setEmoteNote(result);
    if (result?.ok) setEmoteText("");
  };

  return (
    <EupStep step={step} done={clipReady} title="Pose">
      <div className="lv-field">
        <div className="lv-chips" role="radiogroup" aria-label="Pose" title={custom ? undefined : "Game animations, played in place. Space pauses on the frame you want."}>
          {[...PED_POSES, { id: CUSTOM_POSE, label: "Custom" }].map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={pose === option.id}
              className={`lv-chip-btn ${pose === option.id ? "is-on" : ""}`}
              disabled={blocked && option.id !== "bind"}
              onClick={() => onPoseChange(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        {poseError ? (
          <p className="lv-slot-note is-warn">
            <span className="lv-dot" aria-hidden="true" />
            Poses need the ped skeleton, which didn't load: {poseError}
          </p>
        ) : poseNote ? (
          <p className={`lv-slot-note ${poseNoteIsError ? "is-error" : "is-busy"}`} role="status">
            {poseNoteIsError ? <span className="lv-dot" aria-hidden="true" /> : null}
            {poseNote}
          </p>
        ) : null}
      </div>
      {playback}

      {custom && !blocked ? (
        <div className="lv-field eup-anim">
          <div className="lv-seg" role="radiogroup" aria-label="Animation source">
            {[
              { id: "game", label: "Game files" },
              { id: "file", label: "My .ycd" },
            ].map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={source === option.id}
                className={`lv-seg-btn ${source === option.id ? "is-on" : ""}`}
                onClick={() => setSource(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>

          {source === "game" ? (
            <>
              {gameAnim ? (
                <div className="eup-anim-current">
                  <FileCard path={gameAnim.dict} name={gameAnim.dict} folder="Game animation dictionary" />
                  <ClipPicker
                    listing={clipListing}
                    clip={gameAnim.clip}
                    onClipChange={(clip) => onCustomAnimationChange({ source: "game", dict: gameAnim.dict, clip })}
                  />
                </div>
              ) : null}
              <SearchBox
                label="Animation dictionaries"
                placeholder={gameAnim ? "Search for another dictionary" : "Search dictionaries, e.g. cop_idles"}
                search={searchDicts}
                onPick={(dict) => onCustomAnimationChange({ source: "game", dict, clip: "" })}
              />
            </>
          ) : fileAnim ? (
            <div className="eup-anim-current">
              <FileCard path={fileAnim.path} />
              <div className="lv-slot-actions">
                <button type="button" className="cx-btn lv-btn-sm" onClick={onPickYcd}>Replace</button>
                <button type="button" className="cx-btn is-quiet lv-btn-sm" onClick={onReloadYcd} title="Read the file again after you export a new version">
                  <RefreshCw aria-hidden="true" />
                  Reload
                </button>
              </div>
              <ClipPicker
                listing={clipListing}
                clip={fileAnim.clip}
                onClipChange={(clip) => onCustomAnimationChange({ source: "file", path: fileAnim.path, clip })}
              />
            </div>
          ) : (
            <DropButton title="Choose a .ycd" hint="Your own animation dictionary" onClick={onPickYcd} detail="Your own animation dictionary, from Sollumz, OpenIV or a resource." />
          )}

          <button
            type="button"
            className="lv-link eup-emote-toggle"
            aria-expanded={emoteOpen}
            onClick={() => setEmoteOpen((open) => !open)}
          >
            {emoteOpen ? "Hide emote import" : "Paste an emote line"}
          </button>
          {emoteOpen ? (
            <div className="eup-emote">
              <textarea
                className="eup-input eup-mono eup-emote-text"
                rows={4}
                spellCheck={false}
                value={emoteText}
                placeholder={'{"missfam4", "base", "Clipboard", AnimationOptions = { Prop = \'p_amb_clipboard_01\', PropBone = 36029, PropPlacement = {0.16, 0.08, 0.1, -130.0, -50.0, 0.0} }}'}
                aria-label="Emote line"
                title="An emote menu entry, a TaskPlayAnim call or an AttachEntityToEntity call."
                onChange={(event) => setEmoteText(event.target.value)}
              />
              <button type="button" className="cx-btn lv-btn-sm" disabled={!emoteText.trim()} onClick={applyEmote}>Apply</button>
              {emoteNote ? (
                <p className={`lv-slot-note ${emoteNote.ok ? "" : "is-error"}`} role="status">{emoteNote.message}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="lv-field eup-held-field">
        <span className="eup-field-head" title="Hung from a bone with a FiveM-style offset (metres) and rotation (degrees). They follow the animation.">
          <span className="cx-label" id="eup-held-label">Props</span>
          <span className="eup-field-value">{heldProps.length}/{MAX_HELD_PROPS}</span>
        </span>
        {heldProps.length ? (
          <ul className="eup-held-list" aria-labelledby="eup-held-label">
            {heldProps.map((prop) => (
              <HeldPropRow
                key={prop.id}
                prop={prop}
                state={heldStates[prop.id]}
                boneMissing={Boolean(skeletonTags) && !skeletonTags.has(prop.bone)}
                selected={prop.id === selectedHeldId}
                onSelect={onSelectHeld && (() => onSelectHeld(prop.id === selectedHeldId ? null : prop.id))}
                onChange={(patch) => onChangeProp(prop.id, patch)}
                onRemove={() => onRemoveProp(prop.id)}
              />
            ))}
          </ul>
        ) : null}
        {canAddProp ? (
          <div className="lv-slot-actions">
            <button
              type="button"
              className="cx-btn lv-btn-sm"
              aria-expanded={addingGameProp}
              onClick={() => setAddingGameProp((open) => !open)}
            >
              <Search aria-hidden="true" />
              Game prop
            </button>
            <button type="button" className="cx-btn lv-btn-sm" onClick={onAddFileProp}>
              <FileUp aria-hidden="true" />
              From file
            </button>
          </div>
        ) : null}
        {canAddProp && addingGameProp ? (
          <SearchBox
            label="Game props"
            placeholder="Search props, e.g. phone or clipboard"
            search={searchProps}
            onPick={(name) => {
              onAddGameProp(name);
              setAddingGameProp(false);
            }}
          />
        ) : null}
        {isTauriRuntime ? null : <p className="lv-slot-note">Props need the desktop app.</p>}
      </div>
    </EupStep>
  );
}

export default memo(EupPosePanel);
