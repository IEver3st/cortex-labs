import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Box, Boxes, Check, ClipboardCopy, ExternalLink, FileInput, Maximize2, Minimize2, PackageCheck, Pause, PencilLine, Play, Plus, RefreshCw, Save, SlidersHorizontal, X } from "lucide-react";
import { HOTKEY_ACTIONS } from "../../lib/hotkeys";
import { beatsPerSecond, normalizeLightSwitches } from "../../lib/emergency-lights.js";
import { SEQUENCER_STEPS, describeSirenChanges } from "../../lib/siren-settings.js";
import VehicleLightsPanel from "../VehicleLightsPanel";
import SirenEditor from "../siren-editor/SirenEditor";
import SirenMarkers from "../siren-editor/SirenMarkers";
import { NumberInput, RangeField, SettingPanel, SirenPanel, useSirenOps } from "../siren-editor/SirenInspector";
import useSirenResource from "../siren-editor/useSirenResource";
import useSirenIssues from "../siren-editor/useSirenIssues";
import useSirenSave from "../siren-editor/useSirenSave";
import { useCarcolsImport, useSirenInstall } from "../siren-editor/useSirenTools";
import { StatusLines, UlcBuilderDialog, VehicleRenameDialog } from "../siren-editor/SirenToolDialogs";
import SirenEquipment from "../siren-editor/SirenEquipment";
import ElsConsole, { LightingSystemSwitch } from "../els/ElsConsole";
import ElsEditor from "../els/ElsEditor";
import { MISS_PATTERN_LABELS } from "../../lib/els-vcf.js";
import { GameTextures, ModelWarnings } from "./SingleWorkspace";
import { ChecksFact, Facts, StatusFact } from "./DockFacts";
import PaintSlots from "./PaintSlots";
import ModkitPanel from "./ModkitPanel";
import SaveVehicle from "./SaveVehicle";
import { PaneResizer, usePaneWidths, usePreviewHeight } from "./PaneResizer";
import { Toggle } from "../ui/toggle";
import {
  AssetSlot,
  BackdropSection,
  CameraSection,
  CameraShots,
  DeckButton,
  FileCard,
  InspectorTabs,
  LightSection,
  RotateButtons,
  FloorField,
  StageSection,
  TurntableSection,
  Viewfinder,
  WorkspaceFrame,
} from "./parts";

/* Sirens: a workspace for programming a vehicle's emergency lights, laid out
   like the Template Generator: tools first, the model as a preview.
   - The dock is the setting's console: the vehicle, which setting and file it
     is, Save, tempo and the checks that gate saving.
   - The centre is the sequencer, the full height of the window.
   - The right column is a small live preview of the vehicle (loaded whole with
     its own textures, as in All) over the inspector. The preview's height and
     the column's width drag; Expand (or the focus key) fills the workspace
     with it, and Esc comes back. The viewer is never remounted: expanding only
     re-places the preview in the grid.
   The siren editor draft drives the light preview, so the model shows every
   edit as it is made.
   A vehicle can switch its lights to ELS instead (s.els, useEls): the dock
   and centre then edit its ELS vehicle configuration file, and the carcols
   siren tools step aside until it switches back. */

// The narrowest the sequencer column gets from dragging the right column;
// matches --sw-main-min in SirenEditor.css, which also holds on window resize.
const SEQUENCER_MIN = 560;

const TABS = [
  { id: "siren", label: "Siren" },
  { id: "setting", label: "Setting" },
  { id: "lights", label: "Lights" },
  { id: "mods", label: "Mods" },
  { id: "scene", label: "Scene" },
];
// The siren and setting tabs edit the carcols setting; ELS has its own editor.
const ELS_TABS = TABS.filter((tab) => tab.id !== "siren" && tab.id !== "setting");

function fileName(path) {
  return String(path || "").split(/[\\/]/).pop();
}

// A tool's result in the dock: one line per step, dismissable.
function ToolStatus({ status, onDismiss }) {
  if (!status) return null;
  const lines = status.lines || [{ tone: status.tone, text: status.text, path: status.path }];
  return (
    <div className="sw-tool-status">
      <StatusLines lines={lines} />
      {status.tone === "busy" ? null : (
        <button type="button" className="cx-icon-btn" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
          <X aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function ImportChoices({ importer }) {
  if (!importer.choices) return null;
  return (
    <div className="sw-import" role="group" aria-label="Pick a siren setting to import">
      <p className="lv-slot-note">{importer.choices.sirens.length} settings in {fileName(importer.choices.path)}. Pick one:</p>
      <ul className="sw-import-list">
        {importer.choices.sirens.map((setting, index) => (
          <li key={`${setting.id}:${index}`}>
            <button type="button" className="sw-import-item" onClick={() => importer.choose(setting)}>
              <span className="sw-import-name">{setting.name || "Unnamed"}</span>
              <span className="sw-meta">id {setting.id ?? "-"} · {setting.sirens.length} {setting.sirens.length === 1 ? "siren" : "sirens"}</span>
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="cx-btn is-quiet lv-btn-sm" onClick={importer.cancel}>Cancel</button>
    </div>
  );
}

function SettingConsole({ s, resource, hasModel, system }) {
  const editor = s.sirenEditor;
  const draft = editor?.draft;
  const source = draft?.sourcePath || s.vehicleLights?.fileSetting?.sourcePath || "";
  const meshSirens = s.metaModelInfo?.lights?.sirens || [];
  const canCreate = hasModel && !draft && meshSirens.length > 0 && resource.status !== "scanning";
  const done = Boolean(draft && !editor.dirty);
  const saver = useSirenSave(s);
  const installer = useSirenInstall(s, resource);
  const importer = useCarcolsImport(s, resource);
  const [tool, setTool] = useState(null);
  const { issues } = useSirenIssues(s);
  const { setSettingField } = useSirenOps(editor);
  const [openError, setOpenError] = useState("");
  const bpm = Math.round((draft?.sequencerBpm || 0) * (draft?.timeMultiplier ?? 1));
  const bps = beatsPerSecond(draft);
  const openFile = () => {
    setOpenError("");
    invoke("open_model_meta_file", { modelPath: s.modelPath, path: source })
      .catch((error) => setOpenError(`Open file failed: ${String(error)}`));
  };

  return (
    <section id="panel-siren-setting" className={`lv-slot sw-console ${draft ? "is-filled" : "is-empty"} ${hasModel ? "" : "is-disabled"}`}>
      <header className="lv-slot-head">
        <span className={`lv-step ${done ? "is-done" : ""}`} aria-hidden="true">{done ? <Check /> : 2}</span>
        <h3 className="lv-slot-title">Siren setting</h3>
        {hasModel && s.isTauriRuntime ? (
          <button type="button" className="cx-icon-btn" onClick={resource.rescan} disabled={resource.status === "scanning"}
            aria-label="Read the meta files again" title="Read the meta files again">
            <RefreshCw aria-hidden="true" />
          </button>
        ) : null}
      </header>

      <div className="lv-slot-body">
        {system}
        {!hasModel ? <p className="lv-slot-note">Load a vehicle to edit its sirens.</p> : null}

        {hasModel && !draft ? (
          <>
            <p className={`lv-slot-note ${resource.status === "scanning" ? "is-busy" : ""}`}>{resource.missingReason}</p>
            {canCreate ? (
              <button type="button" className="lv-drop" onClick={() => editor.start(resource.createSetting())}>
                <span className="lv-drop-title">
                  <Plus aria-hidden="true" />
                  New siren setting
                </span>
                <span className="lv-drop-hint">One siren per siren bone on the model. Save it into a carcols.meta when it is ready.</span>
              </button>
            ) : resource.status === "ready" && !meshSirens.length ? (
              <p className="lv-slot-note">This model has no emissive geometry on sirenN bones, so there is nothing to flash.</p>
            ) : null}
            {s.isTauriRuntime && resource.status === "ready" ? (
              <div className="lv-slot-actions">
                <button type="button" className="cx-btn lv-btn-sm" onClick={importer.pick} disabled={Boolean(importer.disabledReason)}
                  title={importer.disabledReason || "Start from a siren setting in any carcols.meta"}>
                  <FileInput aria-hidden="true" />
                  Import from carcols.meta…
                </button>
              </div>
            ) : null}
            <ImportChoices importer={importer} />
            <ToolStatus status={importer.status} onDismiss={importer.clearStatus} />
          </>
        ) : null}

        {draft ? (
          <>
            <div className="sw-identity">
              <span className="cx-display sw-name" title={draft.name || undefined}>{draft.name || "Untitled setting"}</span>
              <span className="sw-meta">id {draft.id ?? "—"} · {draft.sirens.length} {draft.sirens.length === 1 ? "siren" : "sirens"}</span>
            </div>
            {source ? <FileCard path={source} /> : <p className="lv-slot-note">Not in a carcols.meta yet.</p>}
            <Facts label="Siren setting">
              <StatusFact tone={editor.dirty ? "warn" : "live"}
                status={editor.dirty ? (editor.base ? "Unsaved edits on the model" : "New setting, not saved yet") : editor.saved ? "Saved" : "Matches the file"}
                describe={editor.dirty ? () => describeSirenChanges(editor.base, draft) : null} />
              <ChecksFact checks={issues.map((entry) => ({ key: entry.code, text: entry.message, tone: entry.severity }))} />
            </Facts>
            <button type="button" className="cx-btn is-primary sw-save" onClick={installer.install}
              disabled={Boolean(installer.disabledReason) || installer.busy}
              title={installer.disabledReason || `Write into ${fileName(installer.carcolsPath)} and link it in carvariations.meta. Each changed file gets a .bak first.`}>
              <PackageCheck aria-hidden="true" />
              {installer.busy ? "Installing…" : "Install to resource"}
            </button>
            {saver.disabledReason && s.isTauriRuntime ? <p className="lv-slot-note is-error">{saver.disabledReason}</p>
              : installer.disabledReason && s.isTauriRuntime ? <p className="lv-slot-note">{installer.disabledReason}</p> : null}
            <ToolStatus status={installer.status} onDismiss={installer.clearStatus} />
            <div className="lv-slot-actions">
              <button type="button" className="cx-btn lv-btn-sm" onClick={saver.saveToFile}
                disabled={Boolean(saver.disabledReason) || saver.saving}
                title={saver.disabledReason || "Write this setting into a carcols.meta you choose"}>
                <Save aria-hidden="true" />
                {saver.saving ? "Saving…" : "Save to file…"}
              </button>
              <button type="button" className="cx-btn lv-btn-sm" onClick={importer.pick} disabled={Boolean(importer.disabledReason)}
                title={importer.disabledReason || "Replace this setting's pattern with one from any carcols.meta"}>
                <FileInput aria-hidden="true" />
                Import…
              </button>
              <button type="button" className="cx-btn lv-btn-sm" onClick={saver.copyXml} title="Copy this setting's <Sirens> Item">
                <ClipboardCopy aria-hidden="true" />
                Copy XML
              </button>
              {source && s.isTauriRuntime ? (
                <button type="button" className="cx-btn lv-btn-sm" onClick={openFile} title={`Open ${fileName(source)} in its default editor`}>
                  <ExternalLink aria-hidden="true" />
                  Open file
                </button>
              ) : null}
              {editor.dirty ? (
                <button type="button" className="cx-btn is-quiet lv-btn-sm" onClick={editor.revert}
                  title={editor.base ? "Back to the values in carcols.meta" : "Discard the new setting"}>
                  {editor.base ? "Revert" : "Discard"}
                </button>
              ) : null}
            </div>
            {saver.status ? (
              <div className={`sw-status is-${saver.status.tone}`} role="status" aria-live="polite">
                <span className="lv-dot" aria-hidden="true" />
                <span>
                  {saver.status.text}
                  {saver.status.path ? <span className="sw-path" title={saver.status.path}>{saver.status.path}</span> : null}
                </span>
                <button type="button" className="cx-icon-btn" aria-label="Dismiss" title="Dismiss" onClick={saver.clearStatus}>
                  <X aria-hidden="true" />
                </button>
              </div>
            ) : null}
            {openError ? <p className="lv-slot-note is-error">{openError}</p> : null}
            <ImportChoices importer={importer} />
            <ToolStatus status={importer.status} onDismiss={importer.clearStatus} />

            <div className="sw-group">
              <div className="sw-group-head">
                <h4 className="cx-label">Tempo</h4>
                <span className="sw-meta">{bps > 0 ? `${(SEQUENCER_STEPS / bps).toFixed(2)} s loop` : "stopped"}</span>
              </div>
              <div className="sw-tempo">
                <span className="cx-display sw-bpm">{bpm}</span>
                <span className="sw-bpm-unit">bpm</span>
              </div>
              <RangeField label="Sequencer bpm" hint="Steps per minute; one sequencer bit per step" value={draft.sequencerBpm ?? 0}
                min={0} max={1500} step={10} integer onChange={(value) => setSettingField("sequencerBpm", value)} />
              <div className="se-field">
                <span className="se-field-label" title="Multiplies the bpm in game">Time multiplier</span>
                <div className="se-field-control">
                  <NumberInput value={draft.timeMultiplier ?? 1} min={0} max={10} step={0.05} label="Time multiplier"
                    onChange={(value) => setSettingField("timeMultiplier", value)} />
                </div>
              </div>
            </div>

          </>
        ) : null}

        {hasModel && s.isTauriRuntime && resource.status === "ready" ? (
          <div className="sw-group">
            <div className="sw-group-head">
              <h4 className="cx-label">Resource tools</h4>
            </div>
            <div className="lv-slot-actions">
              <button type="button" className="cx-btn lv-btn-sm" onClick={() => setTool("ulc")} disabled={!resource.root}
                title="Write the Ultimate Lighting Controller config for this vehicle">
                <SlidersHorizontal aria-hidden="true" />
                ULC builder…
              </button>
              <button type="button" className="cx-btn lv-btn-sm" onClick={() => setTool("rename")} disabled={!resource.root}
                title="Rename the vehicle's spawn name across its resource">
                <PencilLine aria-hidden="true" />
                Rename vehicle…
              </button>
            </div>
          </div>
        ) : null}
        {tool === "ulc" ? <UlcBuilderDialog s={s} resource={resource} onClose={() => setTool(null)} /> : null}
        {tool === "rename" ? <VehicleRenameDialog s={s} resource={resource} onClose={() => setTool(null)} /> : null}

        {resource.errors.length ? (
          <p className="lv-slot-note is-warn" title={resource.errors.map((entry) => `${entry.path}: ${entry.message}`).join("\n")}>
            <span className="lv-dot" aria-hidden="true" />
            {resource.errors.length === 1 ? `${fileName(resource.errors[0].path)} could not be read` : `${resource.errors.length} meta files could not be read`}
          </p>
        ) : null}
      </div>
    </section>
  );
}

// Expand/restore and, while expanded, play and the sirens switch, so the
// full view works without the sequencer.
function PreviewControls({ s, expanded, onToggle }) {
  const lights = s.vehicleLights || {};
  const switches = normalizeLightSwitches(lights.switches);
  const playing = (Number.isFinite(lights.speed) ? lights.speed : 1) > 0;
  const els = s.els?.enabled && s.els.draft ? s.els : null;
  return (
    <div className="sw-preview-tools lv-slip" role="toolbar" aria-label="Preview">
      {expanded ? (
        <>
          <button type="button" className="cx-icon-btn" onClick={() => s.updateVehicleLights({ speed: playing ? 0 : 1 })}
            aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause" : "Play"}>
            {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          </button>
          {els?.draft.dialect === "els-v8" ? (
            <div className="lv-seg se-seg" role="radiogroup" aria-label="Light stage">
              {[0, 1, 2, 3].map((stage) => (
                <button key={stage} type="button" role="radio" aria-checked={els.preview.stage === stage}
                  className={`lv-seg-btn ${els.preview.stage === stage ? "is-on" : ""}`} onClick={() => els.setPreview({ stage })}>
                  {stage ? stage : "Off"}
                </button>
              ))}
            </div>
          ) : els ? (
            <label className="sw-preview-switch">
              <span>{MISS_PATTERN_LABELS.primary}</span>
              <Toggle checked={els.preview.miss.primary} ariaLabel={MISS_PATTERN_LABELS.primary}
                onChange={(value) => els.setPreview((current) => ({ miss: { ...current.miss, primary: value } }))} />
            </label>
          ) : (
            <label className="sw-preview-switch">
              <span>Sirens</span>
              <Toggle checked={switches.sirens} onChange={(value) => s.updateVehicleLights({ switches: { ...switches, sirens: value } })} ariaLabel="Sirens" />
            </label>
          )}
          <span className="sw-preview-rule" aria-hidden="true" />
        </>
      ) : null}
      <button type="button" className="cx-icon-btn" onClick={onToggle}
        aria-label={expanded ? "Back to the workspace (Esc)" : "Expand the preview"} title={expanded ? "Back to the workspace (Esc)" : "Expand the preview"}>
        {expanded ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
      </button>
    </div>
  );
}

export default function SirenWorkspace({ s, viewer, overlays }) {
  const [inspectorTab, setInspectorTab] = useState("siren");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const panes = usePaneWidths("cortex.sirens.panes");
  const preview = usePreviewHeight("cortex.sirens.previewHeight");
  // The preview fills the workspace in focus mode, shared with the frame's
  // focus toggle and its hotkey.
  const expanded = Boolean(s.panelCollapsed);
  const setExpanded = s.setPanelCollapsed;
  useEffect(() => {
    if (!expanded) return undefined;
    const onKey = (event) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const tag = event.target instanceof Element ? event.target.tagName : "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, setExpanded]);

  const hasModel = Boolean(s.modelPath);
  const hk = s.hotkeys || {};
  const editor = s.sirenEditor;
  const els = s.els || null;
  const elsMode = Boolean(els?.enabled);
  const tabs = elsMode ? ELS_TABS : TABS;
  const shownTab = tabs.some((tab) => tab.id === inspectorTab) ? inspectorTab : "lights";
  const system = els ? <LightingSystemSwitch els={els} disabled={!hasModel} /> : null;
  const lights = s.vehicleLights || {};
  const switches = normalizeLightSwitches(lights.switches);
  const resource = useSirenResource({
    modelPath: s.modelPath,
    modelInfo: s.metaModelInfo,
    isTauriRuntime: s.isTauriRuntime,
    rescanToken: s.metaRescanToken,
    onLightsChange: s.updateVehicleLights,
  });

  // The editor is the workspace: it opens on the file's setting as soon as
  // the resource is read, and the pattern runs once per loaded vehicle.
  const fileSetting = lights.fileSetting || null;
  const { draft, start } = editor;
  useEffect(() => {
    if (fileSetting && !draft) start();
  }, [fileSetting, draft, start]);
  const sirensStarted = useRef("");
  const hasSetting = Boolean(lights.setting);
  useEffect(() => {
    // An ELS VCF decides when the carcols sirens run.
    if (elsMode || !hasModel || !hasSetting || sirensStarted.current === s.modelPath) return;
    sirensStarted.current = s.modelPath;
    if (!switches.sirens) s.updateVehicleLights({ switches: { ...switches, sirens: true } });
  }, [elsMode, hasModel, hasSetting, s, switches]);

  const alerts = useMemo(() => {
    const list = [];
    if (s.dialogError) list.push({ id: "dialog", label: "Can't load that file", text: s.dialogError, clear: () => s.setDialogError("") });
    if (s.photoError) list.push({ id: "photo", label: "Photo not saved", text: s.photoError, clear: () => s.setPhotoError("") });
    return list;
  }, [s]);

  // Rotation fixes the model, not the camera, so it stays on the bottom bar
  // when Settings moves the camera presets into the panel.
  const rotateButtons = <RotateButtons s={s} disabled={!hasModel} />;
  const cameraShots = <CameraShots s={s} disabled={!s.viewerReady} />;

  return (
    <WorkspaceFrame s={s} inspectorOpen={inspectorOpen} setInspectorOpen={setInspectorOpen} className="sw-root" style={{ ...panes.style, ...preview.style }}>
      <aside className="lv-dock" aria-label="Vehicle and siren setting" inert={s.panelCollapsed}>
        <div className="lv-dock-scroll custom-scrollbar">
          <AssetSlot
            id="panel-model"
            step={1}
            title="Vehicle"
            path={s.modelSourcePath || s.modelPath}
            done={hasModel}
            emptyTitle="Open a vehicle model"
            emptyHint=".yft with siren bones. You can also drop it on the viewfinder."
            hotkey={hk[HOTKEY_ACTIONS.SELECT_MODEL]}
            onPick={s.selectModel}
            onUnload={s.unloadModel}
            facts={hasModel ? (
              <Facts label="Vehicle">
                <GameTextures s={s} />
                <ModelWarnings s={s} />
                <SaveVehicle s={s} />
              </Facts>
            ) : null}
          >
            {s.modelLoading ? <p className="lv-slot-note is-busy">Loading model…</p> : null}
          </AssetSlot>
          {elsMode
            ? <ElsConsole s={s} els={els} hasModel={hasModel} system={system} />
            : <SettingConsole s={s} resource={resource} hasModel={hasModel} system={system} />}
        </div>
        <PaneResizer side="dock" label="Resize the setting panel" setWidth={panes.setWidth} />
      </aside>

      <div className="sw-main" inert={expanded}>
        {elsMode ? (hasModel && els.draft ? <ElsEditor s={s} els={els} /> : (
          <div className="sw-empty">
            <p className="sw-empty-title">{hasModel ? "No ELS configuration yet" : "Open a vehicle to program its ELS lights"}</p>
            <p className="sw-empty-hint">
              {!hasModel ? "Its ELS vehicle configuration file opens here."
                : els.status === "scanning" ? `Looking for ${els.modelName}.xml…`
                  : "Open the vehicle's VCF, add the folder your ELS script reads, or start a new VCF from the panel."}
            </p>
            {!hasModel ? (
              <button type="button" className="cx-btn is-primary" onClick={s.selectModel}>Open a vehicle model</button>
            ) : null}
          </div>
        )) : hasModel && draft ? <SirenEditor s={s} /> : (
          <div className="sw-empty">
            <p className="sw-empty-title">{hasModel ? "No siren setting yet" : "Open a vehicle to program its sirens"}</p>
            <p className="sw-empty-hint">{hasModel ? resource.missingReason : "Its carcols.meta siren setting opens here as a step sequencer."}</p>
            {!hasModel ? (
              <button type="button" className="cx-btn is-primary" onClick={s.selectModel}>Open a vehicle model</button>
            ) : null}
          </div>
        )}
      </div>

      <section className={`sw-preview ${expanded ? "is-expanded" : ""}`} aria-label="Model preview">
        <Viewfinder
          s={s}
          viewer={<>{viewer}{hasModel && draft && !elsMode ? <SirenMarkers s={s} /> : null}</>}
          hasModel={hasModel}
          alerts={alerts}
          dropHint={`${s.modelDropLabel} vehicle models`}
          progress={s.generatingPreview ? s.previewProgress : null}
          deckStart={s.cameraControlsInPanel ? rotateButtons : <>{cameraShots}{rotateButtons}</>}
          viewButtons={(
            <>
              <DeckButton active={s.showWireframe} onClick={() => s.setShowWireframe((v) => !v)} title="Wireframe" className="is-icon">
                <Box aria-hidden="true" />
              </DeckButton>
              <DeckButton active={s.showCageWireframe} onClick={() => s.setShowCageWireframe((v) => !v)} title="Cage wireframe" className="is-icon">
                <Boxes aria-hidden="true" />
              </DeckButton>
            </>
          )}
        />
        {hasModel ? <PreviewControls s={s} expanded={expanded} onToggle={() => setExpanded(!expanded)} /> : null}
        {expanded ? null : (
          <div className="sw-preview-resize" role="separator" aria-orientation="horizontal" aria-label="Resize the preview"
            title="Resize the preview. Double-click for the default height." tabIndex={0}
            onPointerDown={preview.onPointerDown} onKeyDown={preview.onKeyDown} onDoubleClick={preview.reset} />
        )}
        <PaneResizer side="insp" label="Resize the preview and inspector column" setWidth={panes.setWidth} minStage={SEQUENCER_MIN} />
      </section>

      <aside className="lv-inspector" aria-label="Inspector" inert={s.panelCollapsed || !inspectorOpen}>
        <PaneResizer side="insp" label="Resize the inspector" setWidth={panes.setWidth} minStage={SEQUENCER_MIN} />
        <InspectorTabs tabs={tabs} active={shownTab} onChange={setInspectorTab} />
        <div className="lv-inspector-scroll custom-scrollbar">
          {shownTab === "siren" ? <SirenPanel s={s} /> : null}
          {shownTab === "setting" ? <SettingPanel s={s} /> : null}
          {shownTab === "lights" ? (
            <div className="lv-meta">
              <SirenEquipment s={s} />
              <VehicleLightsPanel lights={lights} onChange={s.updateVehicleLights} modelLights={s.metaModelInfo?.lights}
                setting={lights.setting || null} getTime={s.getLightTime} showPattern={false}
                ulc={lights.ulc || null} ulcPath={resource.ulcResult.path} ulcError={resource.ulcResult.error}
                extrasPlan={s.extrasPlan} extrasState={s.extrasState} onExtrasStateChange={s.updateExtrasState}
                sirenStatus={resource.missingReason} els={els} />
            </div>
          ) : null}
          {shownTab === "mods" ? <ModkitPanel s={s} /> : null}
          {shownTab === "scene" ? (
            <>
              <StageSection s={s}>
                <FloorField id="se-stage-floor-label" value={s.stageFloor} onChange={s.setStageFloor} />
              </StageSection>
              <TurntableSection s={s} />
              <BackdropSection s={s} />
              <LightSection s={s} />
              <PaintSlots
                paint={s.vehiclePaint}
                usedSlots={s.paintSlotsInUse}
                onChange={s.setVehiclePaintSlot}
                onReset={s.resetVehiclePaintSlot}
              />
              {s.cameraControlsInPanel ? <CameraSection>{cameraShots}</CameraSection> : null}
            </>
          ) : null}
        </div>
      </aside>

      {overlays}
    </WorkspaceFrame>
  );
}
