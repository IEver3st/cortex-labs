import { Check, ClipboardCopy, FileInput, Import, Plus, RefreshCw, Save, X } from "lucide-react";
import { summarizePatternPack } from "../../lib/els-patterns.js";
import { ELS_FOLDER_LABELS, baseName, vcfFileName } from "../../lib/els-library.js";
import { StatusLines } from "../siren-editor/SirenToolDialogs";
import { FileCard } from "../workspace/parts";
import { describeVcfChanges } from "../../lib/els-vcf.js";
import { ChecksFact, Fact, FactDisclosure, FactList, Facts, StatusFact } from "../workspace/DockFacts";
import "./Els.css";

/* The Sirens dock in ELS mode: which VCF drives the vehicle's lights, Save,
   the user's ELS folders and pattern tables, and the checks. The centre
   editor (ElsEditor) changes the draft; nothing is written until Save. */

const DIALECT_LABELS = { "els-v8": "ELS V8", "miss-els": "MISS-ELS" };
const ORIGIN_LABELS = {
  linked: "Chosen for this vehicle",
  model: "Found beside the model",
  resource: "Found in the model's resource",
  folder: "Found in an ELS folder",
};

/** Carcols sirens or ELS for this vehicle; the choice is remembered per vehicle. */
export function LightingSystemSwitch({ els, disabled }) {
  const found = !els.enabled && els.file ? `${baseName(els.file.path)} found` : "";
  return (
    <div className="els-system">
      <div className="lv-seg" role="radiogroup" aria-label="Lighting system">
        <button type="button" role="radio" aria-checked={!els.enabled} disabled={disabled}
          className={`lv-seg-btn ${els.enabled ? "" : "is-on"}`} onClick={() => els.setEnabled(false)}
          title="Program the carcols.meta siren setting">Carcols sirens</button>
        <button type="button" role="radio" aria-checked={els.enabled} disabled={disabled}
          className={`lv-seg-btn ${els.enabled ? "is-on" : ""}`} onClick={() => els.setEnabled(true)}
          title="Drive the vehicle's extras from an ELS vehicle configuration file (VCF)">ELS</button>
      </div>
      {found ? (
        <p className="lv-slot-note is-warn">
          <span className="lv-dot" aria-hidden="true" />
          {/* An ELS script drives this vehicle's lights in game, so carcols edits alone often change nothing there. */}
          <span>{found}. In game, ELS drives this vehicle's lights, so carcols edits may not show. Switch to ELS to edit them.</span>
        </p>
      ) : null}
    </div>
  );
}

function ToolStatus({ status, onDismiss }) {
  if (!status) return null;
  const lines = status.lines || [{ tone: status.tone, text: status.text, path: status.path }];
  return (
    <div className="sw-tool-status">
      <StatusLines lines={lines} />
      <button type="button" className="cx-icon-btn" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
        <X aria-hidden="true" />
      </button>
    </div>
  );
}

function controlledCount(draft) {
  return draft.lights.filter((light) => light.controlled).length;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

const IMPORT_HINT = "Pick your ELS-FiveM resource folder, or its client/_patternTypes folder";

function PatternTables({ els, native }) {
  const busy = els.busy === "patterns";
  if (!els.pack) {
    return (
      <Fact label="Pattern tables" title="ELS V8 names patterns by number; their timings live in the lighting script. Import them from your ELS-FiveM copy and numbered patterns play exactly. Until then they play an approximate flash, marked as such.">
        none
        {native ? (
          <button type="button" className="lv-link" onClick={els.importPatterns} disabled={busy} title={IMPORT_HINT}>
            {busy ? "Importing…" : "Import…"}
          </button>
        ) : null}
      </Fact>
    );
  }
  const summary = summarizePatternPack(els.pack);
  const formats = Object.entries(summary.formats)
    .map(([format, roles]) => `${format.toUpperCase()} ${Object.values(roles).reduce((sum, count) => sum + count, 0)}`)
    .join(" · ");
  return (
    <FactDisclosure label="Pattern tables" value={summary.total} title={`${els.pack.source}: ${formats}`}>
      <p className="els-fact-line">{els.pack.source}: {formats}</p>
      {els.pack.path ? <p className="els-fact-path" title={els.pack.path}>{els.pack.path}</p> : null}
      {summary.formats.leds ? null : <p className="lv-slot-note">No LEDS tables in this import, so LEDS groups play an approximate flash.</p>}
      {native ? (
        <div className="lv-slot-actions">
          <button type="button" className="cx-btn lv-btn-sm" onClick={els.importPatterns} disabled={busy} title={IMPORT_HINT}>
            <Import aria-hidden="true" />
            {busy ? "Importing…" : "Import again…"}
          </button>
          <button type="button" className="cx-btn is-quiet lv-btn-sm" onClick={els.clearPatterns}>Forget</button>
        </div>
      ) : null}
    </FactDisclosure>
  );
}

function Folders({ els }) {
  const help = `Cortex looks for ${els.modelName ? vcfFileName(els.modelName) : "<model>.xml"} beside the model, in its resource, then in these folders.`;
  const add = (
    <button type="button" className="lv-link" onClick={els.addFolder}
      title="Add a folder, for example GTA V/ELS/pack_default, resources/ELS-FiveM/vcf or resources/MISS-ELS/xmlFiles">
      Add…
    </button>
  );
  if (!els.folders.length) return <Fact label="ELS folders" title={help}>none{add}</Fact>;
  const broken = els.folders.filter((folder) => els.folderErrors[folder.path]).length;
  return (
    <FactDisclosure label="ELS folders" value={broken ? `${els.folders.length}, ${broken} unreadable` : els.folders.length}
      tone={broken ? "warn" : undefined} title={help} extra={add}>
      <ul className="els-folders">
        {els.folders.map((folder) => (
          <li key={folder.path} className={els.folderErrors[folder.path] ? "is-error" : ""}>
            <span className="els-folder-text" title={els.folderErrors[folder.path] || folder.path}>
              <span className="els-folder-kind">{ELS_FOLDER_LABELS[folder.kind] || ELS_FOLDER_LABELS.folder}</span>
              <span className="els-folder-path">{folder.path}</span>
            </span>
            <button type="button" className="cx-icon-btn" onClick={() => els.removeFolder(folder.path)}
              aria-label={`Forget ${folder.path}`} title="Forget this folder (its files stay)">
              <X aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </FactDisclosure>
  );
}

function Checks({ els }) {
  return (
    <ChecksFact checks={els.issues.map((entry, index) => ({
      key: `${entry.key || ""}:${index}`,
      text: entry.message,
      tone: entry.level === "error" ? "error" : "warn",
    }))} />
  );
}

export default function ElsConsole({ s, els, hasModel, system }) {
  const draft = els.draft;
  const native = Boolean(s.isTauriRuntime);
  const done = Boolean(draft && !els.dirty && els.file);
  const scanning = els.status === "scanning";
  const saveBlocked = els.blocking.length ? "Fix the blocking checks first" : "";
  const fileName = els.modelName ? vcfFileName(els.modelName) : "the vehicle's VCF";
  const showPatterns = hasModel && (!draft || draft.dialect === "els-v8");
  // A change on disk while there are unsaved edits waits for Load; one that
  // can't be read leaves the last good version playing.
  const changed = els.onDisk?.text != null;
  const diskError = els.onDisk?.error || "";
  const status = changed ? "Changed on disk" : diskError ? "Can't read the file"
    : els.dirty ? (els.base ? "Unsaved edits" : "Not saved yet") : els.saved ? "Saved" : "Matches the file";
  const statusTone = diskError ? "error" : changed || els.dirty ? "warn" : "live";
  const shortName = els.file ? baseName(els.file.path) : fileName;
  const fileTitle = els.file
    ? [ORIGIN_LABELS[els.file.origin], els.file.path, draft?.description].filter(Boolean).join("\n")
    : draft?.description || undefined;

  return (
    <section id="panel-els" className={`lv-slot sw-console ${draft ? "is-filled" : "is-empty"} ${hasModel ? "" : "is-disabled"}`}>
      <header className="lv-slot-head">
        <span className={`lv-step ${done ? "is-done" : ""}`} aria-hidden="true">{done ? <Check /> : 2}</span>
        <h3 className="lv-slot-title">ELS configuration</h3>
        {hasModel && native ? (
          <button type="button" className="cx-icon-btn" onClick={els.rescan} disabled={scanning}
            aria-label="Look for the VCF again" title="Look for the VCF again">
            <RefreshCw aria-hidden="true" />
          </button>
        ) : null}
      </header>

      <div className="lv-slot-body">
        {system}
        {!hasModel ? <p className="lv-slot-note">Load a vehicle to program its ELS lights.</p> : null}

        {hasModel && !draft ? (
          <>
            {scanning ? <p className="lv-slot-note is-busy">Looking for {fileName}…</p> : null}
            {els.error ? <p className="lv-slot-note is-error"><span className="lv-dot" aria-hidden="true" />{els.error}</p> : null}
            {!scanning && !els.error ? (
              <p className="lv-slot-note">
                {native
                  ? `No ${fileName} beside the model or in your ELS folders.`
                  : "Reading and saving VCFs needs the desktop app. A new VCF still previews here and copies as XML."}
              </p>
            ) : null}
            {native ? (
              <div className="lv-slot-actions">
                <button type="button" className="cx-btn lv-btn-sm" onClick={els.openDialog}>
                  <FileInput aria-hidden="true" />
                  Open VCF…
                </button>
              </div>
            ) : null}
            <button type="button" className="lv-drop" onClick={() => els.createNew("els-v8")}>
              <span className="lv-drop-title"><Plus aria-hidden="true" />New ELS V8 VCF</span>
              <span className="lv-drop-hint">For LSPDFR's ELS, ELS-FiveM and ELS-Plus. Extras 1-4 primary, 5-6 warning, 7-9 secondary.</span>
            </button>
            <button type="button" className="lv-drop" onClick={() => els.createNew("miss-els")}>
              <span className="lv-drop-title"><Plus aria-hidden="true" />New MISS-ELS VCF</span>
              <span className="lv-drop-hint">Flash patterns written out in the file, with exact timings.</span>
            </button>
            <ToolStatus status={els.toolStatus} onDismiss={els.clearStatus} />
            {showPatterns || native ? (
              <Facts label="ELS sources">
                {showPatterns ? <PatternTables els={els} native={native} /> : null}
                {native ? <Folders els={els} /> : null}
              </Facts>
            ) : null}
          </>
        ) : null}

        {draft ? (
          <>
            <FileCard path={els.file?.path} name={els.file ? undefined : fileName} title={fileTitle} />
            <Facts label="ELS configuration">
              <StatusFact status={status} tone={statusTone} note={diskError || null}
                title={changed ? `${shortName} changed outside Cortex while you had unsaved edits here. Load it to see its lights, or Save as to keep your edits.` : undefined}
                describe={els.dirty ? () => describeVcfChanges(els.base, draft) : null}
                extra={changed ? (
                  <button type="button" className="lv-link" onClick={els.loadFromDisk} title={`Load ${shortName} from disk. Your unsaved edits here are discarded.`}>
                    Load
                  </button>
                ) : null} />
              {native && els.file ? (
                <Fact label="Live reload" tone={els.liveReload === "error" ? "warn" : undefined}
                  title={els.liveReload === "error" ? `Not watching ${shortName}: ${els.watchError}` : `The lights follow ${shortName} when it changes on disk`}>
                  {els.liveReload === "on" ? "on" : els.liveReload === "error" ? "failed" : "off"}
                </Fact>
              ) : null}
              <Fact label="Format">{DIALECT_LABELS[draft.dialect]}</Fact>
              <Fact label={draft.dialect === "els-v8" ? "Controlled" : "Listed"}
                title={draft.dialect === "els-v8" ? "Extras the VCF hands to ELS" : "Extras the VCF lists"}>
                {plural(controlledCount(draft), "extra")}
              </Fact>
              <Checks els={els} />
              {showPatterns ? <PatternTables els={els} native={native} /> : null}
              {native ? <Folders els={els} /> : null}
            </Facts>
            {native ? (
              <button type="button" className="cx-btn is-primary sw-save" onClick={els.saveFile}
                disabled={Boolean(saveBlocked) || els.busy === "save" || (!els.dirty && Boolean(els.file))}
                title={saveBlocked || (els.file ? `Write ${baseName(els.file.path)}. The file gets a .bak first.` : "Choose where to save the VCF")}>
                <Save aria-hidden="true" />
                {els.busy === "save" ? "Saving…" : els.file ? "Save" : "Save as…"}
              </button>
            ) : null}
            <div className="lv-slot-actions">
              {native && els.file ? (
                <button type="button" className="cx-btn lv-btn-sm" onClick={els.saveAs} disabled={Boolean(saveBlocked) || els.busy === "save"}
                  title={saveBlocked || "Write the VCF somewhere else"}>
                  <Save aria-hidden="true" />
                  Save as…
                </button>
              ) : null}
              {native ? (
                <button type="button" className="cx-btn lv-btn-sm" onClick={els.openDialog} title="Use another VCF for this vehicle">
                  <FileInput aria-hidden="true" />
                  Open…
                </button>
              ) : null}
              <button type="button" className="cx-btn lv-btn-sm" onClick={els.copyXml} title="Copy the whole VCF">
                <ClipboardCopy aria-hidden="true" />
                Copy XML
              </button>
              {els.dirty ? (
                <button type="button" className="cx-btn is-quiet lv-btn-sm" onClick={els.revert}
                  title={els.base ? "Back to the values in the file" : "Discard the new VCF"}>
                  {els.base ? "Revert" : "Discard"}
                </button>
              ) : null}
            </div>
            {els.error ? <p className="lv-slot-note is-error"><span className="lv-dot" aria-hidden="true" />{els.error}</p> : null}
            <ToolStatus status={els.toolStatus} onDismiss={els.clearStatus} />
          </>
        ) : null}
      </div>
    </section>
  );
}
