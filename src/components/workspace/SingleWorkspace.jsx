import { useCallback, useMemo, useState } from "react";
import { AlertTriangle, Aperture, Camera, Car, Check, ChevronUp, FolderOpen, FolderTree, Box, Boxes, LayoutGrid, RefreshCw } from "lucide-react";
import { Toggle } from "../ui/toggle";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { HOTKEY_ACTIONS } from "../../lib/hotkeys";
import VehicleMetaPanel from "../VehicleMetaPanel";
import ModkitPanel, { GameLiverySwitcher } from "./ModkitPanel";
import LiveriesPanel from "./LiveriesPanel";
import SaveVehicle from "./SaveVehicle";
import PackSheet, { PackBar } from "./PackSheet";
import KitShootReview from "./KitShootReview";
import PaintSlots from "./PaintSlots";
import {
  AssetSlot,
  BackdropSection,
  CameraSection,
  CameraShots,
  ColorSlots,
  DeckButton,
  InspectorTabs,
  LightSection,
  RotateButtons,
  SelectField,
  Slider,
  FloorField,
  StageSection,
  TurntableSection,
  SurfaceSection,
  Viewfinder,
  WorkspaceFrame,
  withShortcut,
} from "./parts";
import { PaneResizer, usePaneWidths } from "./PaneResizer";
import ReplacePrompt from "./ReplacePrompt";
import { Fact, FactDisclosure, FactList, Facts } from "./DockFacts";
import { describePreviewRun } from "../../lib/capture-output";
import { PAINT_TARGET } from "../../lib/workspace-state";

/* Vehicle and EUP share one workspace. Vehicle puts the livery on the
   detected paint material by default and the second texture on the detected
   glass, and either can be pointed at every mesh or one material or mesh;
   EUP previews one uniform texture on a clothing drawable over a body colour. */

const COPY = {
  vehicle: {
    asideLabel: "Vehicle assets",
    modelEmpty: "Open a vehicle model",
    modelHint: ".yft, .dff or .clmesh. You can also drop it on the viewfinder.",
    textureTitle: "Livery",
    textureEmpty: "Choose a livery",
    textureHint: "PSD, PDN, PNG, DDS and more, on the paint or the meshes you pick. Saved changes reload live.",
    textureError: "Livery didn't load",
    overlayTitle: "Glass",
    overlayEmpty: "Choose a glass texture",
    overlayHint: "Window decals and tint on the glass, or a second texture on the meshes you pick.",
    overlayOff: "Turn on to add window decals, tint or a second texture on top of the livery.",
    overlayToggle: "Use a glass texture",
    overlayError: "Glass texture didn't load",
    dropHint: "models, or a livery image",
    captureEmpty: "Load a model to export preview shots of your livery.",
  },
  eup: {
    asideLabel: "Uniform assets",
    modelEmpty: "Open a clothing model",
    modelHint: ".ydd, .yft, .dff or .clmesh. You can also drop it on the viewfinder.",
    textureTitle: "Uniform",
    textureEmpty: "Choose a uniform texture",
    textureHint: "PSD, PDN, PNG, DDS and more, applied to the meshes you pick. Saved changes reload live.",
    textureError: "Uniform didn't load",
    dropHint: "models, or a uniform image",
    captureEmpty: "Load a model to export preview shots of your uniform.",
  },
};

const INSPECTOR_TABS = {
  vehicle: [
    { id: "paint", label: "Paint" },
    { id: "liveries", label: "Liveries" },
    { id: "mods", label: "Mods" },
    { id: "scene", label: "Scene" },
    { id: "meta", label: "Meta" },
  ],
  eup: [{ id: "paint", label: "Material" }, { id: "scene", label: "Scene" }],
};

function TargetSelect({ value, onChange, children, placeholder }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="lv-select">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="lv-select-content">{children}</SelectContent>
    </Select>
  );
}

function groupFailures(failures) {
  const groups = new Map();
  for (const failure of failures || []) {
    const reason = failure.message || "Couldn't load";
    if (!groups.has(reason)) groups.set(reason, []);
    groups.get(reason).push((failure.path || "").split(/[\\/]/).pop());
  }
  return [...groups.entries()].map(([reason, names]) => ({ reason, names }));
}

/** Problems the CodeWalker bridge worked around while reading the model. */
export function modelWarnings(s) {
  const warnings = Array.isArray(s.metaModelInfo?.bridgeWarnings) ? s.metaModelInfo.bridgeWarnings : [];
  return !s.modelPath || s.modelLoading ? [] : warnings;
}

/** The Model step's warnings row; renders inside <Facts>. */
export function ModelWarnings({ s }) {
  const warnings = modelWarnings(s);
  if (warnings.length === 0) return null;
  return (
    <FactDisclosure label="Warnings" value={warnings.length} tone="warn" title="Problems worked around while reading the model">
      <FactList items={warnings.map((text) => ({ text, tone: "warn" }))} />
    </FactDisclosure>
  );
}

/** The model's own GTA textures: the switch, then what loaded. Renders inside
    <Facts>, so Sirens can list them with the model's warnings. */
export function GameTextures({ s }) {
  const status = s.nativeMaterialsStatus || {};
  const failureGroups = groupFailures(status.failures);
  const loaded = status.loadedTextureCount ?? 0;
  const planned = s.nativeMaterialsPlannedCount || status.uniqueTextureCount || 0;
  const failed = status.failedTextureCount || 0;
  const missing = status.missingBindingCount || 0;
  const unsupported = status.unsupportedBindingCount || 0;
  const active = s.nativeMaterialsActive;
  const loading = active && status.state === "loading";
  const showStats = active && s.nativeMaterialsAvailable && planned > 0 && !loading;
  const message = s.nativeMaterialsStatusMessage;
  const unavailable = !s.nativeMaterialsAvailable && !s.nativeMaterialsEnabled;
  const failedOnly = active && status.state === "error" && !failed && !missing;
  // One Retry, on the first problem row.
  const retry = (
    <button type="button" className="lv-link" onClick={s.retryNativeMaterials} title="Load the model's textures again">
      <RefreshCw aria-hidden="true" />
      Retry
    </button>
  );
  return (
    <>
      <Fact label="Model's own textures" title={message} note={unavailable ? message : null}>
        <Toggle
          checked={s.nativeMaterialsEnabled}
          onChange={s.setNativeMaterialsEnabled}
          disabled={unavailable}
          ariaLabel="Use the model's own GTA textures"
        />
      </Fact>
      {loading ? (
        <Fact label="Loading" title={message}>
          <span className="lv-fact-meter" role="progressbar" aria-label="Loading the model's textures" aria-valuemin={0} aria-valuemax={planned || undefined} aria-valuenow={s.nativeMaterialsCompleteCount}>
            <span style={{ width: `${s.nativeMaterialsProgress}%` }} />
          </span>
          {planned ? `${s.nativeMaterialsCompleteCount} / ${planned}` : "…"}
        </Fact>
      ) : null}
      {showStats ? (
        <>
          <Fact label="Loaded" title={message}>{loaded} / {planned}</Fact>
          <Fact label="Meshes">{status.activeMeshCount ?? status.meshCount ?? 0}</Fact>
        </>
      ) : null}
      {showStats && unsupported > 0 ? (
        <Fact label="Not previewed" title="Advanced shader maps the preview doesn't draw yet">
          {unsupported} {unsupported === 1 ? "map" : "maps"}
        </Fact>
      ) : null}
      {active && missing > 0 ? (
        <Fact label="Not found" tone="warn" title="Texture slots with no texture in the model's files">
          {missing}
          {retry}
        </Fact>
      ) : null}
      {active && failed > 0 ? (
        failureGroups.length ? (
          <FactDisclosure label="Couldn't load" value={failed} tone="warn" extra={missing ? null : retry}>
            <ul className="lv-failures">
              {failureGroups.map((group) => (
                <li key={group.reason}>
                  <span className="lv-failure-reason">{group.reason}</span>
                  <span className="lv-failure-names" title={group.names.join("\n")}>
                    {group.names.length} {group.names.length === 1 ? "texture" : "textures"}: {group.names.slice(0, 4).join(", ")}
                    {group.names.length > 4 ? `, and ${group.names.length - 4} more` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </FactDisclosure>
        ) : (
          <Fact label="Couldn't load" tone="warn">
            {failed}
            {missing ? null : retry}
          </Fact>
        )
      ) : null}
      {failedOnly ? (
        <Fact label="Status" tone="error" title={message} note={message}>
          Failed
          {retry}
        </Fact>
      ) : null}
    </>
  );
}

const CAPTURE_OPEN_KEY = "cortex.dock.capture";

/** Capture starts collapsed to its header and remembers the user's choice. */
export function useCaptureOpen() {
  const [open, setOpenState] = useState(() => {
    try {
      return localStorage.getItem(CAPTURE_OPEN_KEY) === "open";
    } catch {
      return false;
    }
  });
  const setOpen = useCallback((next) => {
    setOpenState(next);
    try {
      localStorage.setItem(CAPTURE_OPEN_KEY, next ? "open" : "closed");
    } catch {
      // Storage refused: the choice lasts until the tab closes.
    }
  }, []);
  return [open, setOpen];
}

/** The Capture header doubles as its disclosure. `locked` keeps it open while
    a capture runs or its result or a replace prompt is showing. */
export function CaptureHead({ bodyId, open, locked, onToggle, meta, children }) {
  const shown = open || locked;
  return (
    <header className="lv-slot-head">
      <h3 className="lv-slot-title">
        <button
          type="button"
          className="lv-capture-toggle"
          aria-expanded={shown}
          aria-controls={shown ? bodyId : undefined}
          aria-disabled={locked || undefined}
          title={locked ? "Stays open while its options, a capture or its result are showing" : undefined}
          onClick={() => (locked ? null : onToggle(!open))}
        >
          Capture
          <ChevronUp className="lv-capture-chev" aria-hidden="true" />
        </button>
      </h3>
      {shown ? children : meta ? <span className="lv-capture-meta">{meta}</span> : null}
    </header>
  );
}

export function CaptureSection({ s, hasModel, copy }) {
  const capturing = s.generatingPreview;
  // Folder captures write through the desktop app; the browser can only download a single view.
  const canCaptureAngles = Boolean(s.isTauriRuntime);
  const run = s.previewComplete && s.previewResult ? describePreviewRun(s.previewResult) : null;
  const [open, setOpen] = useCaptureOpen();
  const locked = Boolean(capturing || s.previewReplace || run || s.previewPromptOpen);
  const shown = open || locked;
  const angles = `${s.selectedPreviewPresetCount} ${s.selectedPreviewPresetCount === 1 ? "angle" : "angles"}`;
  return (
    <section id="panel-capture" className={`lv-capture ${hasModel ? "" : "is-disabled"} ${shown ? "is-open" : "is-collapsed"}`}>
      <CaptureHead bodyId="panel-capture-body" open={open} locked={locked} onToggle={setOpen} meta={hasModel && canCaptureAngles ? angles : null}>
        {hasModel ? (
          <button
            type="button"
            className="lv-link"
            onClick={() => (s.previewPromptOpen ? s.closeCapture() : s.openCapture())}
            aria-expanded={s.previewPromptOpen}
            aria-controls="lv-capture-setup"
            disabled={capturing || !s.viewerReady}
          >
            {s.previewPromptOpen ? "Hide options" : "Options"}
          </button>
        ) : null}
      </CaptureHead>
      {shown ? (
        <div className="lv-slot-body" id="panel-capture-body">
          {!hasModel ? (
            <p className="lv-slot-note">{copy.captureEmpty}</p>
          ) : (
            <>
              {s.previewPromptOpen ? (
                <div className="lv-capture-setup" id="lv-capture-setup">
                  <div className="lv-sheet-preview">
                    {s.previewZoomPreview ? (
                      <img src={s.previewZoomPreview} alt="Framing preview at the 3/4 angle" />
                    ) : (
                      <span>Framing…</span>
                    )}
                  </div>
                  <Slider
                    id="lv-capture-zoom"
                    label="Framing"
                    value={s.previewZoomDraft}
                    min={0.6}
                    max={1.8}
                    step={0.02}
                    format={(v) => `${v.toFixed(2)}×`}
                    onChange={s.setPreviewZoomDraft}
                  />
                  <div className="lv-sheet-angles">
                    <div className="lv-sheet-angles-head">
                      <span className="cx-label">Angles</span>
                      <button type="button" className="lv-link" onClick={s.toggleAllPreviewCapturePresets}>
                        {s.allPreviewPresetsSelected ? "Clear" : "Select all"}
                      </button>
                    </div>
                    <div className="lv-chips">
                      {s.capturePresets.map((preset) => {
                        const on = s.previewCapturePresets.includes(preset.key);
                        return (
                          <button
                            key={preset.key}
                            type="button"
                            className={`lv-chip-btn ${on ? "is-on" : ""}`}
                            aria-pressed={on}
                            onClick={() => s.togglePreviewCapturePreset(preset.key)}
                          >
                            {preset.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : (
                <p className="lv-slot-note">
                  {s.selectedPreviewPresetCount} {s.selectedPreviewPresetCount === 1 ? "angle" : "angles"} at{" "}
                  {(s.previewZoom || 1).toFixed(2)}× framing.
                </p>
              )}
              {canCaptureAngles ? (
                <p className="lv-sheet-dest" title={s.previewFolder || undefined}>
                  <FolderOpen aria-hidden="true" />
                  {s.previewFolder ? <span className="is-path">{s.previewFolder}</span> : <span>You'll choose a folder when you capture.</span>}
                </p>
              ) : (
                <p className="lv-slot-note">Capturing angles needs the desktop app. In the browser, Save this view downloads a PNG.</p>
              )}
              <button
                type="button"
                className="cx-btn is-primary lv-capture-btn"
                disabled={!canCaptureAngles || capturing || !s.viewerReady || s.selectedPreviewPresetCount === 0 || Boolean(s.previewReplace)}
                onClick={s.previewPromptOpen ? s.startCapture : s.captureNow}
                title={canCaptureAngles ? s.previewCaptureTooltip : "Capturing angles needs the desktop app."}
              >
                <Camera aria-hidden="true" />
                {capturing
                  ? `Capturing ${s.previewProgress.current} of ${s.previewProgress.total}`
                  : s.selectedPreviewPresetCount > 0
                    ? `Capture ${s.selectedPreviewPresetCount} ${s.selectedPreviewPresetCount === 1 ? "angle" : "angles"}`
                    : "Pick an angle"}
              </button>
              <button
                type="button"
                className="cx-btn lv-capture-btn"
                disabled={capturing || !s.viewerReady || s.savingPhoto}
                onClick={s.saveViewPhoto}
                title={canCaptureAngles ? "Save the viewfinder exactly as framed now" : "Download the viewfinder exactly as framed now"}
              >
                <Aperture aria-hidden="true" />
                {s.savingPhoto ? "Saving…" : "Save this view"}
              </button>
              {s.previewReplace ? (
                <ReplacePrompt
                  conflicts={s.previewReplace.conflicts}
                  total={s.previewReplace.total}
                  folder={s.previewReplace.folder}
                  onConfirm={s.confirmPreviewReplace}
                  onCancel={s.cancelPreviewReplace}
                />
              ) : null}
              {run ? (
                <div className={`lv-done ${run.tone === "done" ? "" : "is-partial"}`} role="status">
                  <div className="lv-done-head">
                    <span className="lv-done-check" aria-hidden="true">{run.tone === "done" ? <Check /> : <AlertTriangle />}</span>
                    <div>
                      <strong>{run.headline}</strong>
                      {s.previewResult.folder ? <span title={s.previewResult.folder}>{s.previewResult.folder}</span> : null}
                    </div>
                  </div>
                  {run.skippedNote ? <p className="lv-slot-note is-warn">{run.skippedNote}</p> : null}
                  {run.error ? <p className="lv-done-error" role="alert">{run.error}</p> : null}
                  {s.previewResult.note ? <p className="lv-slot-note">{s.previewResult.note}</p> : null}
                  {s.previewFolderOpenError ? <p className="lv-done-error" role="alert">{s.previewFolderOpenError}</p> : null}
                  <div className="lv-slot-actions">
                    {s.previewResult.folder ? (
                      <button type="button" className="cx-btn lv-btn-sm" disabled={s.previewFolderOpening} onClick={s.handleOpenPreviewFolder}>
                        <FolderOpen aria-hidden="true" />
                        {s.previewFolderOpening ? "Opening…" : "Open folder"}
                      </button>
                    ) : null}
                    <button type="button" className="cx-btn is-quiet lv-btn-sm" onClick={() => s.setPreviewComplete(false)}>
                      Dismiss
                    </button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

export default function SingleWorkspace({ s, viewer, overlays }) {
  const [inspectorTab, setInspectorTab] = useState("paint");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const isEup = s.mode === "eup";
  const isVehicle = !isEup;
  const copy = COPY[isEup ? "eup" : "vehicle"];
  const tabs = INSPECTOR_TABS[isEup ? "eup" : "vehicle"];
  // A tab another mode has (Mods, Liveries) falls back to Paint here.
  const activeTab = tabs.some((tab) => tab.id === inspectorTab) ? inspectorTab : "paint";
  // Each mode keeps its own dock and inspector widths; Vehicle keeps the ones
  // Livery mode saved.
  const panes = usePaneWidths(`cortex.${isEup ? "eup-textures" : "livery"}.panes`);
  const hasModel = Boolean(s.modelPath);
  const hk = s.hotkeys || {};
  // A folder of vehicles is a desktop read, so the Pack view is Vehicle mode in the app only.
  const canOpenFolder = isVehicle && Boolean(s.isTauriRuntime);
  const hasFolder = canOpenFolder && Boolean(s.vehicleFolder);
  const packShown = hasFolder && s.folderView === "pack";
  const viewSwitch = hasFolder ? (
    <div className="lv-ctx-seg" role="group" aria-label="Folder view">
      <button type="button" className={`lv-ctx-seg-btn ${packShown ? "is-on" : ""}`} aria-pressed={packShown}
        onClick={() => s.setFolderView("pack")} title="Every vehicle in the folder">
        <LayoutGrid aria-hidden="true" />
        Pack
      </button>
      <button type="button" className={`lv-ctx-seg-btn ${packShown ? "" : "is-on"}`} aria-pressed={!packShown}
        onClick={() => s.setFolderView("vehicle")} title="The open vehicle">
        <Car aria-hidden="true" />
        Vehicle
      </button>
    </div>
  ) : null;

  const alerts = useMemo(() => {
    const list = [];
    if (s.dialogError) list.push({ id: "dialog", label: "Can't load that file", text: s.dialogError, clear: () => s.setDialogError("") });
    if (s.textureError) list.push({ id: "texture", label: copy.textureError, text: s.textureError, clear: () => s.setTextureError("") });
    if (s.windowTextureError && !isEup) list.push({ id: "overlay", label: copy.overlayError, text: s.windowTextureError, clear: () => s.setWindowTextureError("") });
    if (s.photoError) list.push({ id: "photo", label: "Photo not saved", text: s.photoError, clear: () => s.setPhotoError("") });
    return list;
  }, [s, copy, isEup]);

  const onPaint = isVehicle && s.textureTarget === PAINT_TARGET;
  const paintOption = !hasModel ? "Detected paint" : s.liveryTargetLabel ? `Detected: ${s.liveryTargetLabel}` : "Detected: none found";
  // The select names the paint it found; the note covers what it can't say.
  const paintNote = !onPaint ? null : !hasModel
    ? { tone: "idle", text: "Load a model and the livery is placed on its paint material automatically." }
    : s.liveryTargetLabel ? null : { tone: "warn", text: "No paint material found, so the livery covers every mesh." };
  const glassOption = !hasModel ? "Detected glass" : s.windowLiveryTarget ? `Detected: ${s.windowStatusLabel}` : "Detected: none found";
  const watchTone = s.watchStatus === "watching" ? "live" : s.watchStatus === "error" ? "error" : "idle";
  const watchLabel = s.watchStatus === "watching" ? "Live reload on" : s.watchStatus === "error" ? "Live reload failed" : "Live reload idle";

  // Rotation fixes the model, not the camera, so it stays on the bottom bar
  // when Settings moves the camera presets into the panel.
  const rotateButtons = <RotateButtons s={s} disabled={!hasModel} />;
  const cameraShots = <CameraShots s={s} disabled={!s.viewerReady} />;

  const targetItems = s.textureTargets.map((target) => (
    <SelectItem key={target.value} value={target.value}>{target.label}</SelectItem>
  ));

  return (
    <WorkspaceFrame s={s} inspectorOpen={inspectorOpen} setInspectorOpen={setInspectorOpen} style={panes.style}
      className={packShown ? "is-pack" : ""} viewSwitch={viewSwitch} panelControls={!packShown}>
      {packShown ? <PackSheet s={s} /> : null}

      {/* ──── Asset pipeline ──── */}
      <aside className="lv-dock" aria-label={copy.asideLabel} inert={s.panelCollapsed}>
        {hasFolder ? <PackBar s={s} /> : null}
        <div className="lv-dock-scroll custom-scrollbar">
          <AssetSlot
            id="panel-model"
            step={1}
            title="Model"
            path={s.modelSourcePath || s.modelPath}
            done={hasModel}
            emptyTitle={copy.modelEmpty}
            emptyHint={copy.modelHint}
            hotkey={hk[HOTKEY_ACTIONS.SELECT_MODEL]}
            onPick={s.selectModel}
            onUnload={s.unloadModel}
            facts={modelWarnings(s).length || (!isEup && s.saveVehicle) ? (
              <Facts label="Model">
                <ModelWarnings s={s} />
                {isEup ? null : <SaveVehicle s={s} />}
              </Facts>
            ) : null}
          >
            {s.modelLoading ? <p className="lv-slot-note is-busy">Loading model…</p> : null}
            {canOpenFolder && !hasFolder ? (
              <button type="button" className="lv-link lv-folder-link" onClick={s.openVehicleFolder} title="See a pack's vehicles side by side and go through them one at a time">
                <FolderTree aria-hidden="true" />
                Open a folder of vehicles
              </button>
            ) : null}
          </AssetSlot>

          <AssetSlot
            id="panel-templates"
            step={2}
            title={copy.textureTitle}
            path={s.texturePath}
            done={Boolean(s.texturePath)}
            emptyTitle={copy.textureEmpty}
            emptyHint={copy.textureHint}
            hotkey={hk[HOTKEY_ACTIONS.SELECT_LIVERY]}
            onPick={s.selectTexture}
            onUnload={() => s.setTexturePath("")}
          >
            <SelectField label="Apply to">
              <TargetSelect value={s.textureTarget} onChange={s.setTextureTarget} placeholder="Meshes">
                {isVehicle ? <SelectItem value={PAINT_TARGET}>{paintOption}</SelectItem> : null}
                <SelectItem value="all">All meshes</SelectItem>
                {targetItems}
              </TargetSelect>
            </SelectField>
            {paintNote ? (
              <p className={`lv-slot-note is-${paintNote.tone}`}>
                <span className="lv-dot" aria-hidden="true" />
                {paintNote.text}
              </p>
            ) : null}
            {s.texturePath ? (
              <p className={`lv-slot-note is-${watchTone}`}>
                <span className="lv-dot" aria-hidden="true" />
                {watchLabel}
                {s.lastUpdate ? <span className="lv-slot-time">{s.lastUpdate}</span> : null}
              </p>
            ) : null}
            {isVehicle ? <Facts label="The model's own textures"><GameTextures s={s} /></Facts> : null}
          </AssetSlot>

          {isEup ? null : (
          <AssetSlot
            id="panel-overlays"
            step={3}
            title={copy.overlayTitle}
            path={s.windowTexturePath}
            done={s.windowTemplateEnabled && Boolean(s.windowTexturePath)}
            disabled={!s.windowTemplateEnabled}
            disabledNote={copy.overlayOff}
            emptyTitle={copy.overlayEmpty}
            emptyHint={copy.overlayHint}
            hotkey={hk[HOTKEY_ACTIONS.SELECT_GLASS]}
            onPick={s.selectWindowTexture}
            onUnload={() => s.setWindowTexturePath("")}
            trailing={<Toggle checked={s.windowTemplateEnabled} onChange={s.setWindowTemplateEnabled} ariaLabel={copy.overlayToggle} />}
          >
            <SelectField label="Apply to">
              <TargetSelect value={s.windowTextureTarget} onChange={s.setWindowTextureTarget} placeholder="Meshes">
                <SelectItem value="auto">{glassOption}</SelectItem>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="all">All meshes</SelectItem>
                {targetItems}
              </TargetSelect>
            </SelectField>
          </AssetSlot>
          )}
        </div>
        <div className="lv-dock-foot">
          <CaptureSection s={s} hasModel={hasModel} copy={copy} />
        </div>
        <PaneResizer side="dock" label="Resize the asset panel" setWidth={panes.setWidth} />
      </aside>

      <Viewfinder
        s={s}
        viewer={viewer}
        hasModel={hasModel}
        alerts={alerts}
        dropHint={`${s.modelDropLabel} ${copy.dropHint}`}
        progress={s.generatingPreview ? s.previewProgress : null}
        deckStart={s.cameraControlsInPanel ? rotateButtons : <>{cameraShots}{rotateButtons}</>}
        viewButtons={(
          <>
            {isEup ? null : (
            <DeckButton
              active={s.liveryExteriorOnly}
              onClick={() => s.setLiveryExteriorOnly(!s.liveryExteriorOnly)}
              title={withShortcut("Exterior only: hide interior, glass and wheels", hk[HOTKEY_ACTIONS.TOGGLE_EXTERIOR_ONLY])}
              className="is-icon"
            >
              <Car aria-hidden="true" />
            </DeckButton>
            )}
            <DeckButton active={s.showWireframe} onClick={() => s.setShowWireframe((v) => !v)} title="Wireframe" className="is-icon">
              <Box aria-hidden="true" />
            </DeckButton>
            <DeckButton active={s.showCageWireframe} onClick={() => s.setShowCageWireframe((v) => !v)} title="Cage wireframe" className="is-icon">
              <Boxes aria-hidden="true" />
            </DeckButton>
          </>
        )}
      />

      {/* ──── Inspector ──── */}
      <aside className="lv-inspector" aria-label="Inspector" inert={s.panelCollapsed || !inspectorOpen}>
        <PaneResizer side="insp" label="Resize the inspector" setWidth={panes.setWidth} />
        <InspectorTabs
          tabs={tabs}
          active={activeTab}
          onChange={setInspectorTab}
        />
        <div className="lv-inspector-scroll custom-scrollbar">
          {activeTab === "paint" && isEup ? (
            <>
              <ColorSlots
                id="panel-colors"
                title="Body"
                swatches={s.colorSwatches}
                slots={[{
                  key: "body",
                  label: "Body colour",
                  value: s.bodyColor,
                  onChange: s.setBodyColor,
                  onReset: () => s.setBodyColor(s.defaultBody),
                }]}
              />
              <SurfaceSection s={s} />
            </>
          ) : null}

          {activeTab === "paint" && !isEup ? (
            <>
              <PaintSlots
                paint={s.vehiclePaint}
                usedSlots={s.paintSlotsInUse}
                onChange={s.setVehiclePaintSlot}
                onReset={s.resetVehiclePaintSlot}
              />
            </>
          ) : null}

          {activeTab === "scene" ? (
            <>
              <StageSection
                s={s}
                notes={isEup ? { showroom: "Stood in a dark studio under one spotlight, on the floor you pick. Captures use it too." } : undefined}
              >
                <FloorField id="lv-stage-floor-label" value={s.stageFloor} onChange={s.setStageFloor} />
              </StageSection>
              <TurntableSection s={s} subject={isEup ? "clothing" : "vehicle"} />
              <BackdropSection s={s} />
              <LightSection s={s} />
              {s.cameraControlsInPanel ? <CameraSection>{cameraShots}</CameraSection> : null}
            </>
          ) : null}

          {/* The in-game livery switcher sits with the liveries it switches between. */}
          {activeTab === "mods" && isVehicle ? <ModkitPanel s={s} livery={false} /> : null}

          {activeTab === "liveries" && isVehicle ? <LiveriesPanel s={s} head={<GameLiverySwitcher s={s} />} /> : null}

          {activeTab === "meta" && !isEup ? (
            <div className="lv-meta">
              <VehicleMetaPanel
                modelPath={s.modelPath}
                modelInfo={s.metaModelInfo}
                isTauriRuntime={s.isTauriRuntime}
                onApplyLivery={s.onApplyMetaLivery}
                onApplyColors={s.onApplyMetaColors}
                onToggleExtra={s.onToggleMetaExtra}
                steeringAngle={s.steeringAngle}
                onSteeringChange={s.setSteeringAngle}
                vehicleParts={s.vehicleParts}
                vehiclePartControls={s.vehiclePartControls}
                roofClip={s.roofClip}
                lights={s.vehicleLights}
                onLightsChange={s.updateVehicleLights}
                getLightTime={s.getLightTime}
                extrasPlan={s.extrasPlan}
                extrasState={s.extrasState}
                onExtrasStateChange={s.updateExtrasState}
                els={s.els}
                plate={s.licensePlate}
                onPlateChange={s.updateLicensePlate}
                plateStatus={s.licensePlateStatus}
              />
            </div>
          ) : null}
        </div>
      </aside>

      {overlays}
      {s.kitShoot?.review ? (
        <KitShootReview
          root={s.kitShoot.review.root}
          manifest={s.kitShoot.review.manifest}
          onClose={s.kitShoot.closeReview}
        />
      ) : null}
    </WorkspaceFrame>
  );
}
