import { memo, useEffect, useRef, useState } from "react";
import { FileText, Folder, Search } from "lucide-react";
import { baseName } from "../../lib/eup";
import { DropButton, splitPath } from "../workspace/parts";

const SEARCH_DEBOUNCE_MS = 220;
const SEARCH_PATTERN = /^[a-z0-9_ ]{1,64}$/;
const PED_FILE = /\.(ymt|yft|ydd|ytd)$/i;

const MODES = [
  { id: "male", label: "Male", title: "The freemode male ped EUP clothing is made for" },
  { id: "female", label: "Female", title: "The freemode female ped EUP clothing is made for" },
  { id: "game", label: "Game ped", title: "Any ped in your GTA V files" },
  { id: "file", label: "Ped files", title: "Your own ped's .ymt, .yft, .ydd and .ytd files" },
];

function errorText(error) {
  if (!error) return "Unknown error";
  return typeof error === "string" ? error : error.message || String(error);
}

function modeOf(model, gender) {
  if (model?.kind === "game" || model?.kind === "file") return model.kind;
  return gender === "female" ? "female" : "male";
}

/** Debounced game ped search; stale responses are dropped. */
function PedSearch({ searchPeds, current, onPick, disabled }) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState({ status: "idle", results: [], total: 0, error: "" });
  const runRef = useRef(0);
  useEffect(() => {
    const text = query.trim().toLowerCase();
    if (disabled || !text) {
      runRef.current += 1;
      setState({ status: "idle", results: [], total: 0, error: "" });
      return undefined;
    }
    if (!SEARCH_PATTERN.test(text)) {
      setState({ status: "error", results: [], total: 0, error: "Ped names use letters, digits and _." });
      return undefined;
    }
    const run = ++runRef.current;
    const timer = setTimeout(() => {
      setState((prev) => ({ ...prev, status: "searching", error: "" }));
      searchPeds(text).then(
        (result) => run === runRef.current && setState({ status: "ready", results: result.names, total: result.total, error: "" }),
        (error) => run === runRef.current && setState({ status: "error", results: [], total: 0, error: errorText(error) }),
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, disabled, searchPeds]);

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
          placeholder={current ? "Search for another ped" : "Search peds, e.g. cop or hipster"}
          aria-label="Search game peds"
          disabled={disabled}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {state.status === "searching" ? (
        <p className="lv-slot-note is-busy" role="status">Searching the game files. The first search indexes them and can take a minute.</p>
      ) : state.status === "error" ? (
        <p className="lv-slot-note is-error" role="alert"><span className="lv-dot" aria-hidden="true" />{state.error}</p>
      ) : state.status === "ready" && state.results.length === 0 ? (
        <p className="lv-slot-note">No ped in the game files matches “{query.trim()}”.</p>
      ) : null}
      {state.results.length ? (
        <>
          <ul className="eup-anim-results custom-scrollbar" aria-label="Game peds">
            {state.results.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  className="eup-anim-result eup-mono"
                  title={name === current ? `${name} is on stage` : `Use ${name}`}
                  aria-current={name === current || undefined}
                  onClick={() => onPick(name)}
                >
                  {name}
                </button>
              </li>
            ))}
          </ul>
          {state.total > state.results.length ? (
            <p className="lv-slot-note">Showing {state.results.length} of {state.total}. Add words to narrow it down.</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function PickedPath({ path }) {
  const { folder } = splitPath(path);
  const Icon = PED_FILE.test(path) ? FileText : Folder;
  return (
    <li className="eup-source" title={path}>
      <Icon className="eup-source-icon" aria-hidden="true" />
      <span className="eup-source-text">
        <span className="eup-source-name">{baseName(path) || path}</span>
        {folder ? <span className="eup-source-folder">{folder}</span> : null}
      </span>
    </li>
  );
}

/** What the custom character's description says, or why there isn't one yet. */
function CharacterStatus({ model, character, onRetry, onPickFolder, onRemove, onOpenBody }) {
  if (!character) return null;
  if (character.loading && !character.description) {
    return (
      <p className="lv-slot-note is-busy" role="status">
        {model.kind === "game"
          ? `Reading ${model.ped} from the game files. The first read indexes them and can take a minute.`
          : "Reading the ped files…"}
      </p>
    );
  }
  if (character.error) {
    return (
      <p className="lv-slot-note is-error" role="alert">
        <span className="lv-dot" aria-hidden="true" />
        <span>{character.error}</span>
        {model.kind === "file" ? (
          <>
            <button type="button" className="lv-link eup-note-action" onClick={onPickFolder}>Locate…</button>
            <button type="button" className="lv-link eup-note-action" onClick={onRemove}>Remove</button>
          </>
        ) : (
          <button type="button" className="lv-link eup-note-action" onClick={onRetry}>Retry</button>
        )}
      </p>
    );
  }
  const description = character.description;
  if (!description) return null;
  const components = description.components?.length || 0;
  const anchors = description.props?.length || 0;
  const missing = character.slots.filter((slot) => !slot.drawable).length;
  return (
    <>
      <p className="lv-native-stats" aria-live="polite">
        <span><b>{description.skeleton?.bones?.length || 0}</b> bones</span>
        <span><b>{components}</b> {components === 1 ? "component" : "components"}</span>
        <span><b>{anchors}</b> prop {anchors === 1 ? "anchor" : "anchors"}</span>
      </p>
      {missing > 0 ? (
        <p className="lv-slot-note is-warn" role="status">
          <span className="lv-dot" aria-hidden="true" />
          {missing === 1 ? "One drawable the variations list isn't" : `${missing} drawables the variations list aren't`} in the files.
        </p>
      ) : null}
      {description.warnings?.length ? (
        <p className="lv-slot-note is-warn" role="status" title={description.warnings.join("\n")}>
          <span className="lv-dot" aria-hidden="true" />
          {description.warnings[0]}
        </p>
      ) : null}
      {/* One span, so the links flow inside the sentence instead of becoming note columns. */}
      <p className="lv-slot-note">
        <span>
          EUP clothing, addon pieces and outfits fit the freemode peds only. Pick this ped&apos;s own drawables and props in{" "}
          <button type="button" className="lv-link" onClick={onOpenBody}>Body</button>.
          {model.kind === "file" ? (
            <>
              {" "}After editing the files,{" "}
              <button type="button" className="lv-link" onClick={onRetry}>read them again</button>.
            </>
          ) : null}
        </span>
      </p>
    </>
  );
}

/**
 * Step 2's character choice: a freemode ped (male or female), any game ped,
 * or the user's own ped files. The stage changes once a ped is picked;
 * switching to Game ped or Ped files only opens the picker.
 */
function EupCharacterPicker({
  isTauriRuntime,
  model,
  gender,
  character,
  searchPeds,
  onChange,
  onPickFolder,
  onPickFiles,
  onRetry,
  onOpenBody,
}) {
  const current = modeOf(model, gender);
  const [mode, setMode] = useState(current);
  useEffect(() => setMode(current), [current]);
  const customHelp = !isTauriRuntime ? "Other peds need the desktop app and GTA V." : "";
  const toFreemode = () => onChange({ kind: "freemode", gender });

  const choose = (id) => {
    if (id === "male" || id === "female") {
      setMode(id);
      onChange({ kind: "freemode", gender: id });
      return;
    }
    setMode(id);
  };

  return (
    <>
      <div className="lv-seg eup-character-seg" role="radiogroup" aria-label="Character">
        {MODES.map((option) => {
          const custom = option.id === "game" || option.id === "file";
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={mode === option.id}
              className={`lv-seg-btn ${mode === option.id ? "is-on" : ""}`}
              disabled={custom && !isTauriRuntime}
              title={custom && !isTauriRuntime ? customHelp : option.title}
              onClick={() => choose(option.id)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {!isTauriRuntime ? <p className="lv-slot-note">{customHelp}</p> : null}

      {mode === "game" && isTauriRuntime ? (
        <>
          {model?.kind === "game" ? (
            <p className="lv-native-stats"><span className="eup-mono">{model.ped}</span></p>
          ) : null}
          <PedSearch
            searchPeds={searchPeds}
            current={model?.kind === "game" ? model.ped : ""}
            onPick={(ped) => onChange({ kind: "game", ped })}
            disabled={!isTauriRuntime}
          />
        </>
      ) : null}

      {mode === "file" && isTauriRuntime ? (
        model?.kind === "file" ? (
          <>
            <ul className="eup-sources">
              {model.paths.map((path) => <PickedPath key={path} path={path} />)}
            </ul>
            {character?.candidates?.length ? (
              <div className="eup-anim-search">
                <p className="lv-slot-note">These files hold more than one ped. Pick one:</p>
                <ul className="eup-anim-results custom-scrollbar" aria-label="Peds in these files">
                  {character.candidates.map((name) => (
                    <li key={name}>
                      <button type="button" className="eup-anim-result eup-mono" onClick={() => onChange({ ...model, ped: name })}>
                        {name}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="lv-slot-actions">
              <button type="button" className="cx-btn lv-btn-sm" onClick={onPickFolder}>Open folder</button>
              <button type="button" className="cx-btn is-quiet lv-btn-sm" onClick={onPickFiles}>Pick files</button>
              <button type="button" className="cx-btn is-quiet lv-btn-sm" onClick={toFreemode} title="Go back to the freemode ped">Remove</button>
            </div>
          </>
        ) : (
          <>
            <DropButton
              title="Open a ped folder"
              hint="The ped's .ymt, .yft, .ydd and .ytd files, in game layout or FiveM ped^file names. Subfolders are read too."
              onClick={onPickFolder}
            />
            <button type="button" className="lv-link eup-alt-link" onClick={onPickFiles}>
              Or pick the ped&apos;s files
            </button>
          </>
        )
      ) : null}

      {model?.kind === mode ? (
        <CharacterStatus
          model={model}
          character={character}
          onRetry={onRetry}
          onPickFolder={onPickFolder}
          onRemove={toFreemode}
          onOpenBody={onOpenBody}
        />
      ) : null}
    </>
  );
}

export default memo(EupCharacterPicker);
