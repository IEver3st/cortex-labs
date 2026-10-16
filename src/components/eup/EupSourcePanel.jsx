import { memo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Folder, RefreshCw, UserRound, X } from "lucide-react";
import { SKIN_TONES, baseName } from "../../lib/eup";
import { Toggle } from "../ui/toggle";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { DropButton, SelectField, splitPath } from "../workspace/parts";
import EupCharacterPicker from "./EupCharacterPicker";

export function EupStep({ step, done, title, trailing, children }) {
  return (
    <section className="lv-slot">
      <header className="lv-slot-head">
        <span className={`lv-step ${done ? "is-done" : ""}`} aria-hidden="true">
          {done ? <Check /> : step}
        </span>
        <h3 className="lv-slot-title">{title}</h3>
        {trailing}
      </header>
      <div className="lv-slot-body">{children}</div>
    </section>
  );
}

function SourceRow({ path, label, onRemove }) {
  const { folder } = splitPath(path);
  return (
    <li className="eup-source" title={path}>
      <Folder className="eup-source-icon" aria-hidden="true" />
      <span className="eup-source-text">
        <span className="eup-source-name">{label}</span>
        {folder ? <span className="eup-source-folder">{folder}</span> : null}
      </span>
      <button type="button" className="cx-icon-btn" aria-label={`Remove ${label}`} title="Remove from this session" onClick={onRemove}>
        <X aria-hidden="true" />
      </button>
    </li>
  );
}

const WATCH_COPY = {
  watching: { tone: "live", label: "Live reload on" },
  error: { tone: "error", label: "Live reload failed" },
  off: { tone: "idle", label: "Live reload off" },
};

/**
 * Pipeline steps 1 and 2: where the clothing comes from, and which character
 * wears it. A game ped or the user's ped (`model`) skips the freemode extras.
 */
function EupSourcePanel({
  isTauriRuntime,
  pedTitle = "Character",
  model,
  character,
  characterControls,
  searchPeds,
  onOpenBody,
  clothingNote = "",
  gender,
  race,
  onRaceChange,
  skinTone,
  onSkinToneChange,
  onImportCharacter,
  packRaces = [],
  sourceFolders,
  sourceFiles,
  fileCount,
  otherPedCount,
  scanNotice,
  scanning,
  onOpenFolder,
  onAddFiles,
  onRefresh,
  onRemoveFolder,
  onRemoveFile,
  liveReload,
  onLiveReloadChange,
  watchState,
  pedReady,
  baseError,
  onRetryBase,
  onRetryCharacter,
}) {
  const [filesOpen, setFilesOpen] = useState(false);
  const hasSources = sourceFolders.length > 0 || sourceFiles.length > 0;
  const watch = WATCH_COPY[liveReload ? watchState?.status || "off" : "off"] || WATCH_COPY.off;
  const custom = model?.kind === "game" || model?.kind === "file";
  const characterReady = Boolean(character?.description) && !character.error
    && character.slots.some((slot) => slot.kind === "component");

  return (
    <>
      <EupStep
        step={1}
        done={hasSources && fileCount > 0}
        title="Clothing"
        trailing={hasSources ? (
          <button
            type="button"
            className="cx-icon-btn"
            onClick={onRefresh}
            disabled={!isTauriRuntime || scanning}
            aria-label="Read the clothing files again"
            title="Read the clothing files again"
          >
            <RefreshCw aria-hidden="true" />
          </button>
        ) : null}
      >
        {!isTauriRuntime ? (
          <p className="lv-slot-note">Reading clothing files needs the desktop app.</p>
        ) : !hasSources ? (
          <>
            <DropButton
              title="Open an EUP folder"
              hint="A resource folder with .ydd and .ytd files. Subfolders are read too."
              onClick={onOpenFolder}
            />
            <button type="button" className="lv-link eup-alt-link" onClick={onAddFiles}>
              Or pick .ydd and .ytd files
            </button>
          </>
        ) : (
          <>
            <ul className="eup-sources">
              {sourceFolders.map((folder) => (
                <SourceRow key={folder} path={folder} label={baseName(folder) || folder} onRemove={() => onRemoveFolder(folder)} />
              ))}
            </ul>
            {sourceFiles.length > 0 ? (
              <div className="eup-files">
                <button
                  type="button"
                  className="eup-files-toggle"
                  aria-expanded={filesOpen}
                  onClick={() => setFilesOpen((open) => !open)}
                >
                  {filesOpen ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                  {sourceFiles.length} added {sourceFiles.length === 1 ? "file" : "files"}
                </button>
                {filesOpen ? (
                  <ul className="eup-files-list">
                    {sourceFiles.map((file) => (
                      <li key={file} title={file}>
                        <span>{baseName(file)}</span>
                        <button
                          type="button"
                          className="cx-icon-btn"
                          aria-label={`Remove ${baseName(file)}`}
                          title="Remove from this session"
                          onClick={() => onRemoveFile(file)}
                        >
                          <X aria-hidden="true" />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            <p className="lv-native-stats" aria-live="polite">
              {scanning ? (
                <span>Reading files…</span>
              ) : (
                <span><b>{fileCount}</b> {fileCount === 1 ? "file" : "files"} for this ped</span>
              )}
              {otherPedCount > 0 ? <span><b>{otherPedCount}</b> for the other ped</span> : null}
            </p>
            <div className="lv-slot-actions">
              <button type="button" className="cx-btn lv-btn-sm" onClick={onOpenFolder}>Add folder</button>
              <button type="button" className="cx-btn is-quiet lv-btn-sm" onClick={onAddFiles}>Add files</button>
            </div>
          </>
        )}
        {clothingNote ? <p className="lv-slot-note is-warn" role="status"><span className="lv-dot" aria-hidden="true" />{clothingNote}</p> : null}
        {scanNotice ? (
          <p className="lv-slot-note is-warn" role="status">
            <span className="lv-dot" aria-hidden="true" />
            {scanNotice}
          </p>
        ) : null}
        {isTauriRuntime ? (
          <div className="lv-option">
            <div className="lv-option-head">
              <span className="lv-option-title">Reload when files change</span>
              <Toggle checked={liveReload} onChange={onLiveReloadChange} ariaLabel="Reload clothing when files change on disk" />
            </div>
            {hasSources ? (
              <p className={`lv-slot-note is-${watch.tone}`} role="status">
                <span className="lv-dot" aria-hidden="true" />
                {watch.label}
              </p>
            ) : null}
            {liveReload && watchState?.status === "error" && watchState.error ? (
              <p className="lv-slot-note is-error" role="alert">{watchState.error}</p>
            ) : null}
          </div>
        ) : null}
      </EupStep>

      <EupStep step={2} done={custom ? characterReady : pedReady} title={pedTitle}>
        <EupCharacterPicker
          isTauriRuntime={isTauriRuntime}
          model={model}
          gender={gender}
          character={character}
          searchPeds={searchPeds}
          onChange={characterControls.setModel}
          onPickFolder={characterControls.pickFolder}
          onPickFiles={characterControls.pickFiles}
          onRetry={onRetryCharacter}
          onOpenBody={onOpenBody}
        />
        {custom ? null : (
        <>
        <div className="eup-import-entry">
          <button type="button" className="cx-btn lv-btn-sm" onClick={onImportCharacter}>
            <UserRound aria-hidden="true" />
            Import character…
          </button>
          <p className="lv-slot-note">Wear a vMenu character from FiveM, for photos of your own character.</p>
        </div>
        <div className="lv-field">
          <span className="eup-field-head">
            <span className="cx-label" id="eup-tone-label">Skin tone</span>
            <span className="eup-field-value">{SKIN_TONES.find((tone) => tone.id === skinTone)?.label}</span>
          </span>
          <div className="eup-tones" role="radiogroup" aria-labelledby="eup-tone-label">
            {SKIN_TONES.map((tone) => (
              <button
                key={tone.id}
                type="button"
                role="radio"
                aria-checked={skinTone === tone.id}
                aria-label={tone.label}
                title={tone.label}
                className={`eup-tone ${skinTone === tone.id ? "is-on" : ""}`}
                style={{ "--chip": tone.swatch }}
                onClick={() => onSkinToneChange(tone.id)}
              />
            ))}
          </div>
          <p className="lv-slot-note">Skin colours from the game's heritage faces, applied to the head and arms.</p>
        </div>
        {packRaces.some((id) => id !== "whi") ? (
          <SelectField label="Race textures">
            <Select value={race} onValueChange={onRaceChange}>
              <SelectTrigger className="lv-select eup-mono" aria-label="Race texture variant for race-dependent drawables">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="lv-select-content">
                {[...new Set([race, "whi", ...packRaces])].map((id) => (
                  <SelectItem key={id} value={id}>{id}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="lv-slot-note">Your clothing ships textures for {packRaces.join(", ")}.</p>
          </SelectField>
        ) : null}
        {baseError ? (
          <p className="lv-slot-note is-error" role="alert">
            <span className="lv-dot" aria-hidden="true" />
            <span>{baseError}</span>
            <button type="button" className="lv-link eup-note-action" onClick={onRetryBase}>Retry</button>
          </p>
        ) : (
          <p className="lv-slot-note">The game's default ped fills every slot your clothing doesn't replace.</p>
        )}
        </>
        )}
      </EupStep>
    </>
  );
}

export default memo(EupSourcePanel);
