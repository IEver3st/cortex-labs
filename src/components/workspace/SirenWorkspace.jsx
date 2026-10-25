import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Box, Boxes, CarFront, ClipboardCopy, ClipboardPaste, ExternalLink, FileInput, FolderOpen, Maximize2, Minimize2, PackageCheck, PanelRightClose, PanelRightOpen, Pause, PencilLine, Play, Plus, RefreshCw, Save, Settings2, SlidersHorizontal, SunMedium, Wrench, X } from "lucide-react";
import { HOTKEY_ACTIONS } from "../../lib/hotkeys";
import { normalizeLightSwitches } from "../../lib/emergency-lights.js";
import { adoptPattern, createPatternSetting, describeSirenChanges } from "../../lib/siren-settings.js";
import VehicleLightsPanel from "../VehicleLightsPanel";
import SirenEditor from "../siren-editor/SirenEditor";
import SirenMarkers from "../siren-editor/SirenMarkers";
import usePatternClock from "../siren-editor/usePatternClock";
import { SettingPanel, SirenPanel } from "../siren-editor/SirenInspector";
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
import { ChecksFact, Fact, Facts, StatusFact } from "./DockFacts";
import PaintSlots from "./PaintSlots";
import ModkitPanel from "./ModkitPanel";
import SaveVehicle from "./SaveVehicle";
import { PaneResizer, usePaneWidths, usePreviewHeight } from "./PaneResizer";
import { Toggle } from "../ui/toggle";
import {
  BackdropSection,
  CameraSection,
  CameraShots,
  DeckButton,
  FileCard,
  LightSection,
  RotateButtons,
  FloorField,
  StageSection,
  TurntableSection,
  Viewfinder,
  WorkspaceFrame,
  withShortcut,
} from "./parts";

// The narrowest the sequencer column gets from dragging the right column;
// matches --sw-main-min in SirenEditor.css, which also holds on window resize.
const SEQUENCER_MIN = 660;

const VIEWS = [
  { id: "setting", label: "Setting", Icon: Settings2 },
  { id: "vehicle", label: "Vehicle", Icon: CarFront },
  { id: "mods", label: "Mods", Icon: Wrench },
  { id: "scene", label: "Scene", Icon: SunMedium },
];

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

function UsePattern({ editor, resource, canCreate, className = "cx-btn lv-btn-sm" }) {
  const pattern = editor.pattern;
  if (!pattern?.sirens?.length) return null;
  const count = pattern.sirens.length;
  const apply = () => {
    if (editor.draft) editor.edit((current) => adoptPattern(current, pattern));
    else if (canCreate) editor.start(adoptPattern(resource.createSetting(), pattern));
  };
  const disabled = !editor.draft && !canCreate;
  const kept = editor.draft && editor.draft.sirens.length > count ? ` Sirens ${count + 1} to ${editor.draft.sirens.length} stay as they are.` : "";
  return (
    <button type="button" className={className} onClick={apply} disabled={disabled}
      title={`Replace sirens 1 to ${count} with the pattern you built without a vehicle: colours, patterns, tempo and lamp patterns. The vehicle keeps its id, name, file and each siren's facing.${kept}`}>
      <ClipboardPaste aria-hidden="true" />
      Use my pattern
    </button>
  );
}

function SirenSheet({ s, resource, hasModel, system, onStartPattern, stageAction }) {
  const editor = s.sirenEditor;
  const draft = editor?.draft;
  const native = Boolean(s.isTauriRuntime);
  const source = draft?.sourcePath || s.vehicleLights?.fileSetting?.sourcePath || "";
  const meshSirens = s.metaModelInfo?.lights?.sirens || [];
  const canCreate = hasModel && !draft && meshSirens.length > 0 && resource.status !== "scanning";
  const patternMode = !hasModel;
  const saver = useSirenSave(s);
  const installer = useSirenInstall(s, resource);
  const importer = useCarcolsImport(s, resource);
  const { issues } = useSirenIssues(s);
  const [openError, setOpenError] = useState("");
  const openFile = () => {
    setOpenError("");
    invoke("open_model_meta_file", { modelPath: s.modelPath, path: source })
      .catch((error) => setOpenError(`Open file failed: ${String(error)}`));
  };
  const importButton = (label, title, className = "cx-btn lv-btn-sm") => (
    <button type="button" className={className} onClick={importer.pick} disabled={Boolean(importer.disabledReason)}
      title={importer.disabledReason || title}>
      <FileInput aria-hidden="true" />
      {label}
    </button>
  );
  const imports = (
    <>
      <ImportChoices importer={importer} />
      <ToolStatus status={importer.status} onDismiss={importer.clearStatus} />
    </>
  );
  const readErrors = resource.errors.length ? (
    <p className="lv-slot-note is-warn" title={resource.errors.map((entry) => `${entry.path}: ${entry.message}`).join("\n")}>
      <span className="lv-dot" aria-hidden="true" />
      {resource.errors.length === 1 ? `${fileName(resource.errors[0].path)} could not be read` : `${resource.errors.length} meta files could not be read`}
    </p>
  ) : null;
  const rescan = hasModel && native ? (
    <button type="button" className="cx-icon-btn" onClick={resource.rescan} disabled={resource.status === "scanning"}
      aria-label="Read the meta files again" title="Read the meta files again">
      <RefreshCw aria-hidden="true" />
    </button>
  ) : null;

  if (!draft) {
    return (
      <div className="sw-empty">
        {hasModel ? system : null}
        <p className="sw-empty-title">{hasModel ? "No siren setting yet" : "Open a vehicle, or build a pattern"}</p>
        <p className={`sw-empty-hint ${resource.status === "scanning" ? "is-busy" : ""}`}>
          {hasModel ? resource.missingReason : "Edit a vehicle's sirens, or build a flash pattern without one."}
        </p>
        {hasModel && resource.status === "ready" && !meshSirens.length ? (
          <p className="sw-empty-hint">This model has no emissive geometry on sirenN bones, so there is nothing to flash.</p>
        ) : null}
        <div className="sw-empty-actions">
          {hasModel ? null : (
            <>
              <button type="button" className="cx-btn is-primary" onClick={s.selectModel}>Open a vehicle model</button>
              <button type="button" className="cx-btn" onClick={onStartPattern}>New pattern</button>
            </>
          )}
          {canCreate ? (
            <button type="button" className="cx-btn is-primary" onClick={() => editor.start(resource.createSetting())}
              title="One siren per siren bone on the model. Save it into a carcols.meta when it is ready.">
              <Plus aria-hidden="true" />
              New siren setting
            </button>
          ) : null}
          {canCreate ? <UsePattern editor={editor} resource={resource} canCreate={canCreate} className="cx-btn" /> : null}
          {native && (!hasModel || resource.status === "ready")
            ? importButton("Import from carcols.meta…", "Start from a siren setting in any carcols.meta", "cx-btn") : null}
          {rescan}
        </div>
        {imports}
        {readErrors}
      </div>
    );
  }

  const head = (
    <div className="se-rail-block se-rail-id">
      <div className="se-rail-head">
        <span className="cx-display se-rail-name" title={draft.name || undefined}>{draft.name || "Untitled setting"}</span>
        {rescan}
      </div>
      <span className="se-rail-meta">id {draft.id ?? "—"}</span>
      <Facts label="Siren setting">
        {source ? (
          <Fact label="File" title={source}>
            <span className="se-rail-file">{fileName(source)}</span>
            {native && !patternMode ? (
              <button type="button" className="lv-link" onClick={openFile} aria-label={`Open ${fileName(source)}`}
                title={`Open ${fileName(source)} in its default editor`}>
                <ExternalLink aria-hidden="true" />
              </button>
            ) : null}
          </Fact>
        ) : null}
        <StatusFact tone={editor.dirty ? "warn" : "live"}
          status={editor.dirty ? (editor.base ? "Unsaved edits" : "Not saved yet") : editor.saved ? "Saved" : "Matches the file"}
          describe={editor.dirty ? () => describeSirenChanges(editor.base, draft, { canInstall: !patternMode }) : null} />
        <ChecksFact checks={issues.map((entry) => ({ key: entry.code, text: entry.message, tone: entry.severity }))} />
      </Facts>
      {openError ? <p className="lv-slot-note is-error">{openError}</p> : null}
      {readErrors}
      {hasModel ? system : null}
    </div>
  );

  const foot = (
    <div className="se-rail-block se-rail-foot">
      {saver.disabledReason && native ? <p className="lv-slot-note is-error">{saver.disabledReason}</p>
        : installer.disabledReason && native && !patternMode ? <p className="lv-slot-note">{installer.disabledReason}</p> : null}
      <ToolStatus status={installer.status} onDismiss={installer.clearStatus} />
      {saver.status ? (
        <div className={`sw-status is-${saver.status.tone}`} role="status" aria-live="polite">
          <span className="lv-dot" aria-hidden="true" />
          <span>
            {saver.status.text}
            {saver.status.path ? <span className="sw-path" title={saver.status.path}>{saver.status.path}</span> : null}
            {saver.status.confirm ? (
              <button type="button" className="cx-btn lv-btn-sm sw-status-confirm" onClick={saver.confirmReplace} disabled={saver.saving}>
                {saver.status.confirm}
              </button>
            ) : null}
          </span>
          <button type="button" className="cx-icon-btn" aria-label="Dismiss" title="Dismiss" onClick={saver.clearStatus}>
            <X aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {imports}
      {patternMode ? null : (
        <button type="button" className="cx-btn is-primary sw-save" onClick={installer.install}
          disabled={Boolean(installer.disabledReason) || installer.busy}
          title={installer.disabledReason || `Write into ${fileName(installer.carcolsPath)} and link it in carvariations.meta. Each changed file gets a .bak first.`}>
          <PackageCheck aria-hidden="true" />
          {installer.busy ? "Installing…" : "Install to resource"}
        </button>
      )}
      <div className="se-rail-grid">
        <button type="button" className="cx-btn lv-btn-sm" onClick={saver.saveToFile}
          disabled={Boolean(saver.disabledReason) || saver.saving}
          title={saver.disabledReason || "Write this setting into a carcols.meta you choose"}>
          <Save aria-hidden="true" />
          {saver.saving ? "Saving…" : "Save to file…"}
        </button>
        {importButton("Import…", "Replace this setting's pattern with one from any carcols.meta")}
        <button type="button" className="cx-btn lv-btn-sm" onClick={saver.copyXml} title="Copy this setting's <Sirens> Item">
          <ClipboardCopy aria-hidden="true" />
          Copy XML
        </button>
        {editor.dirty ? (
          <button type="button" className="cx-btn is-quiet lv-btn-sm" onClick={editor.revert}
            title={editor.base ? "Back to the values in carcols.meta" : "Discard the new setting"}>
            {editor.base ? "Revert" : "Discard"}
          </button>
        ) : null}
      </div>
      {patternMode ? null : <UsePattern editor={editor} resource={resource} canCreate={canCreate} />}
    </div>
  );

  return <SirenEditor s={s} head={head} foot={foot} stageAction={stageAction} />;
}

function VehicleBar({ s }) {
  const hotkey = (s.hotkeys || {})[HOTKEY_ACTIONS.SELECT_MODEL];
  if (!s.modelPath) return s.modelLoading ? <div className="sw-vehicle"><p className="lv-slot-note is-busy">Loading model…</p></div> : null;
  return (
    <div className="sw-vehicle">
      <FileCard path={s.modelSourcePath || s.modelPath} actions={(
        <>
          <button type="button" className="cx-icon-btn lv-file-act" onClick={s.selectModel}
            title={withShortcut("Replace the vehicle", hotkey)} aria-label="Replace the vehicle">
            <FolderOpen aria-hidden="true" />
          </button>
          <button type="button" className="cx-icon-btn lv-file-act" onClick={s.unloadModel}
            title="Unload the vehicle" aria-label="Unload the vehicle">
            <X aria-hidden="true" />
          </button>
        </>
      )} />
      {s.modelLoading ? <p className="lv-slot-note is-busy">Loading model…</p> : null}
    </div>
  );
}

function VehicleView({ s, ps, resource, els, elsMode, setTool }) {
  const lights = s.vehicleLights || {};
  return (
    <div className="lv-meta">
      <Facts label="Vehicle">
        <GameTextures s={s} />
        <ModelWarnings s={s} />
        <SaveVehicle s={s} />
      </Facts>
      <SirenEquipment s={s} />
      <VehicleLightsPanel lights={lights} onChange={s.updateVehicleLights} modelLights={s.metaModelInfo?.lights}
        setting={lights.setting || null} getTime={ps.getLightTime} showPattern={false}
        ulc={lights.ulc || null} ulcPath={resource.ulcResult.path} ulcError={resource.ulcResult.error}
        extrasPlan={s.extrasPlan} extrasState={s.extrasState} onExtrasStateChange={s.updateExtrasState}
        sirenStatus={resource.missingReason} els={els} />
      {!elsMode && s.isTauriRuntime && resource.status === "ready" ? (
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
    </div>
  );
}

function SirenSide({ s, ps, resource, els, elsMode, hasModel, inert, setWidth, cameraShots, onClose, closeRef }) {
  const editor = s.sirenEditor;
  const [view, setView] = useState(null);
  const [tool, setTool] = useState(null);
  const selectionKey = editor?.selection?.join(",") ?? "";
  useEffect(() => setView(null), [selectionKey]);
  const views = VIEWS.filter((entry) => (entry.id === "setting" ? !elsMode : entry.id === "scene" || hasModel));
  const light = elsMode ? null : editor?.draft?.sirens[editor.primary] || null;
  const auto = elsMode ? (hasModel ? "vehicle" : "scene") : light ? null : "setting";
  const shown = views.some((entry) => entry.id === view) ? view : auto;
  const count = editor?.selection?.length || 0;
  const title = shown ? VIEWS.find((entry) => entry.id === shown).label : count > 1 ? `${count} sirens` : `Siren ${editor.primary + 1}`;

  let body = <SirenPanel s={s} />;
  if (shown === "setting") body = <SettingPanel s={s} />;
  else if (shown === "vehicle") body = <VehicleView s={s} ps={ps} resource={resource} els={els} elsMode={elsMode} setTool={setTool} />;
  else if (shown === "mods") body = <ModkitPanel s={s} />;
  else if (shown === "scene") {
    body = (
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
    );
  }

  return (
    <aside className="lv-inspector sw-side" aria-label="Selection and vehicle" inert={inert}>
      <PaneResizer side="insp" label="Resize the preview and panel column" setWidth={setWidth} minStage={SEQUENCER_MIN} />
      <VehicleBar s={s} />
      <header className="sw-side-head">
        <h3 className="cx-display sw-side-title" title={title}>{title}</h3>
        <div className="sw-side-views" role="group" aria-label="Panel">
          {views.map(({ id, label, Icon }) => {
            const on = shown === id;
            const toggled = view === id && light && id !== auto;
            return (
              <button key={id} type="button" className={`cx-icon-btn sw-side-view ${on ? "is-on" : ""}`} aria-pressed={on}
                aria-label={label} title={toggled ? `${label}. Click again for the selected siren.` : label}
                onClick={() => setView(view === id ? null : id)}>
                <Icon aria-hidden="true" />
              </button>
            );
          })}
          <span className="sw-side-rule" aria-hidden="true" />
          <button ref={closeRef} type="button" className="cx-icon-btn sw-side-view" onClick={onClose} aria-expanded="true"
            aria-label="Hide the preview and panel" title="Hide the preview and panel">
            <PanelRightClose aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="lv-inspector-scroll custom-scrollbar">{body}</div>
      {tool === "ulc" ? <UlcBuilderDialog s={s} resource={resource} onClose={() => setTool(null)} /> : null}
      {tool === "rename" ? <VehicleRenameDialog s={s} resource={resource} onClose={() => setTool(null)} /> : null}
    </aside>
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
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const closeButton = useRef(null);
  const reopenButton = useRef(null);
  const panelFocus = useRef(null);
  useEffect(() => {
    const target = panelFocus.current === "close" ? closeButton.current : panelFocus.current === "reopen" ? reopenButton.current : null;
    panelFocus.current = null;
    target?.focus();
  }, [inspectorOpen]);
  const showPanel = () => { panelFocus.current = "close"; setInspectorOpen(true); };
  const hidePanel = () => { panelFocus.current = "reopen"; setInspectorOpen(false); };
  const reopen = inspectorOpen ? null : (
    <button ref={reopenButton} type="button" className="cx-icon-btn se-icon-btn" onClick={showPanel} aria-expanded="false"
      aria-label="Show the preview and panel" title="Show the preview and panel">
      <PanelRightOpen aria-hidden="true" />
    </button>
  );
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
  const editor = s.sirenEditor;
  const els = s.els || null;
  const elsMode = Boolean(els?.enabled);
  const system = els ? <LightingSystemSwitch els={els} disabled={!hasModel} /> : null;
  const lights = s.vehicleLights || {};
  const switches = normalizeLightSwitches(lights.switches);
  const patternMode = !hasModel && !elsMode;
  const speed = Number.isFinite(lights.speed) ? lights.speed : 1;
  const clock = usePatternClock(patternMode && Boolean(editor.draft) && switches.sirens && s.isActive !== false, speed);
  const ps = useMemo(() => (patternMode ? { ...s, getLightTime: clock.get, setLightTime: clock.set } : s), [patternMode, s, clock]);
  const startPattern = () => {
    editor.start(createPatternSetting());
    clock.set(0);
    s.updateVehicleLights({ switches: { ...switches, sirens: true }, speed: speed > 0 ? speed : 1 });
  };
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
    <WorkspaceFrame s={s} inspectorOpen={inspectorOpen} setInspectorOpen={setInspectorOpen} className={`sw-root ${patternMode ? "is-pattern" : ""}`} style={{ ...panes.style, ...preview.style }}>
      <div className="sw-main" inert={expanded}>
        {elsMode ? (
          <div className="sw-els">
            <aside className="se-rail sw-els-rail custom-scrollbar" aria-label="ELS configuration">
              <ElsConsole s={s} els={els} hasModel={hasModel} system={system} />
            </aside>
            <div className="sw-els-main">
              {hasModel && els.draft ? <ElsEditor s={s} els={els} stageAction={reopen} /> : (
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
                  {hasModel && reopen ? (
                    <button ref={reopenButton} type="button" className="cx-btn" onClick={showPanel}>
                      <PanelRightOpen aria-hidden="true" />
                      Show the panel
                    </button>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        ) : <SirenSheet s={ps} resource={resource} hasModel={hasModel} system={system} onStartPattern={startPattern}
          stageAction={reopen} />}
      </div>

      <section className={`sw-preview ${expanded ? "is-expanded" : ""}`} aria-label="Model preview">
        <Viewfinder
          s={s}
          viewer={<>{viewer}{hasModel && draft && !elsMode ? <SirenMarkers s={s} /> : null}{patternMode ? (
            <button type="button" className="sw-pattern-drop" onClick={s.selectModel}
              title={withShortcut("Open a vehicle model: a .yft with siren bones", (s.hotkeys || {})[HOTKEY_ACTIONS.SELECT_MODEL])}>
              <span className="sw-pattern-drop-title">
                <FolderOpen aria-hidden="true" />
                Open a vehicle model
              </span>
              <span>{draft ? "Or drop one here to put this pattern on its siren bones." : "Or drop one here."}</span>
            </button>
          ) : null}</>}
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

      <SirenSide s={s} ps={ps} resource={resource} els={els} elsMode={elsMode} hasModel={hasModel}
        inert={s.panelCollapsed || !inspectorOpen} setWidth={panes.setWidth} cameraShots={cameraShots}
        onClose={hidePanel} closeRef={closeButton} />

      {overlays}
    </WorkspaceFrame>
  );
}
