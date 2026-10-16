import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Aperture,
  ArrowDown,
  ArrowUp,
  Box,
  Boxes,
  Copy,
  Eye,
  EyeOff,
  FolderOpen,
  Loader2,
  Move3d,
  Plus,
  RotateCw,
  Rows3,
  Trash2,
} from "lucide-react";
import { SelectItem, Select, SelectContent, SelectTrigger, SelectValue } from "../ui/select";
import { Keycaps } from "../ui/keycaps";
import { HOTKEY_ACTIONS } from "../../lib/hotkeys";
import { MAX_LINEUP_SLOTS, slotLetter } from "../../lib/multi-lineup";
import { buildVehiclePaint } from "../../lib/vehicle-paint.js";
import PaintSlots from "./PaintSlots";
import { CaptureHead, useCaptureOpen } from "./SingleWorkspace";
import { PaneResizer, usePaneWidths } from "./PaneResizer";
import {
  AssetSlot,
  BackdropSection,
  CameraSection,
  CameraShots,
  DeckButton,
  InspectorTabs,
  LightSection,
  SelectField,
  FloorField,
  StageSection,
  TurntableSection,
  Viewfinder,
  WorkspaceFrame,
  splitPath,
  withShortcut,
} from "./parts";

/* Multi: a lineup of up to six vehicles in one scene. The dock lists the
   lineup and edits the selected vehicle; clicking a vehicle in the viewfinder
   selects it and the move or turn gizmo follows the selection. */

const STAGE_NOTES = {
  showroom: "The lineup parked in a dark studio, each vehicle under its own spotlight on a satin floor.",
};

const SHOWROOM_LIGHT_MODES = [
  { id: "each", label: "Each vehicle", title: "A spotlight, pool and shadow for every visible vehicle" },
  { id: "one", label: "Whole lineup", title: "One wide spotlight over the whole lineup" },
];

function LineupRow({ slot, index, selected, status, onSelect, onToggleVisible }) {
  const letter = slotLetter(index);
  const model = slot.modelPath ? splitPath(slot.modelPath).name : "No model";
  const livery = slot.liveryPath ? splitPath(slot.liveryPath).name : "";
  const failed = status?.error || status?.liveryError || status?.windowError;
  return (
    <li className={`mw-row ${selected ? "is-selected" : ""} ${slot.visible ? "" : "is-hidden"}`}>
      <button
        type="button"
        className="mw-row-main"
        onClick={onSelect}
        aria-pressed={selected}
        title={slot.modelPath || `Vehicle ${letter}`}
      >
        <span className="mw-letter cx-display" aria-hidden="true">{letter}</span>
        <span className="mw-row-text">
          <span className={`mw-row-name ${slot.modelPath ? "" : "is-empty"}`}>
            <span className="sr-only">Vehicle {letter}: </span>
            {model}
          </span>
          {livery ? <span className="mw-row-sub">{livery}</span> : null}
        </span>
        {status?.loading ? (
          <Loader2 className="mw-row-state is-busy" aria-label="Loading" />
        ) : failed ? (
          <AlertTriangle className="mw-row-state is-error" aria-label="Didn't load" />
        ) : null}
      </button>
      <button
        type="button"
        className="cx-icon-btn mw-row-eye"
        onClick={onToggleVisible}
        aria-pressed={!slot.visible}
        aria-label={slot.visible ? `Hide vehicle ${letter}` : `Show vehicle ${letter}`}
        title={slot.visible ? "Hide in the viewfinder" : "Show in the viewfinder"}
      >
        {slot.visible ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
      </button>
    </li>
  );
}

function SlotNote({ tone, children }) {
  return (
    <p className={`lv-slot-note is-${tone}`} role={tone === "error" ? "alert" : "status"}>
      <span className="lv-dot" aria-hidden="true" />
      {children}
    </p>
  );
}

function SelectedVehicle({ s, slot, index }) {
  const L = s.lineup;
  const status = L.status[slot.id] || {};
  const info = L.info[slot.id] || {};
  const hk = s.hotkeys || {};
  const letter = slotLetter(index);
  const full = L.slots.length >= MAX_LINEUP_SLOTS;
  const others = L.slots.length > 1;

  return (
    <div className="mw-detail" aria-label={`Vehicle ${letter}`} role="group">
      <div className="mw-detail-head">
        <span className="cx-label">Vehicle {letter}</span>
        <div className="mw-detail-actions">
          <button
            type="button"
            className="cx-icon-btn"
            onClick={() => L.move(slot.id, -1)}
            disabled={index === 0}
            aria-label="Move earlier in the lineup"
            title="Move earlier in the lineup"
          >
            <ArrowUp aria-hidden="true" />
          </button>
          <button
            type="button"
            className="cx-icon-btn"
            onClick={() => L.move(slot.id, 1)}
            disabled={index === L.slots.length - 1}
            aria-label="Move later in the lineup"
            title="Move later in the lineup"
          >
            <ArrowDown aria-hidden="true" />
          </button>
          <button
            type="button"
            className="cx-icon-btn"
            onClick={() => L.duplicate(slot.id)}
            disabled={full}
            aria-label="Duplicate this vehicle"
            title={full ? `The lineup holds ${MAX_LINEUP_SLOTS} vehicles` : "Duplicate: same model, paint and liveries"}
          >
            <Copy aria-hidden="true" />
          </button>
          <button
            type="button"
            className="cx-icon-btn"
            onClick={() => L.remove(slot.id)}
            aria-label={`Remove vehicle ${letter}`}
            title="Remove from the lineup"
          >
            <Trash2 aria-hidden="true" />
          </button>
        </div>
      </div>

      <AssetSlot
        id="panel-multi-model"
        step={1}
        title="Model"
        path={slot.modelPath}
        emptyTitle="Open a vehicle"
        emptyHint={`${s.modelDropLabel}. Drop several to add them all.`}
        hotkey={hk[HOTKEY_ACTIONS.SELECT_MODEL]}
        onPick={() => s.selectMultiModel(slot.id)}
        onUnload={() => L.setModel(slot.id, "")}
        done={Boolean(slot.modelPath) && !status.loading && !status.error}
      >
        {status.loading ? (
          <p className="lv-slot-note is-busy">
            {status.queued ? "Waiting for the vehicles ahead of it to finish loading…" : "Loading model…"}
          </p>
        ) : null}
        {status.error ? <SlotNote tone="error">{status.error}</SlotNote> : null}
        {status.warning ? <SlotNote tone="warn">{status.warning}</SlotNote> : null}
        {status.textures === "loading" ? <p className="lv-slot-note is-busy">Loading game textures…</p> : null}
        {status.textures === "partial" ? <SlotNote tone="warn">Some game textures are missing, so parts show plain paint</SlotNote> : null}
        {status.texturesError ? <SlotNote tone="error">{status.texturesError}</SlotNote> : null}
      </AssetSlot>

      <AssetSlot
        id="panel-multi-livery"
        step={2}
        title="Livery"
        path={slot.liveryPath}
        emptyTitle="Choose a livery"
        emptyHint="PNG, PSD, PDN, DDS and more. Reloads when you save it."
        hotkey={hk[HOTKEY_ACTIONS.SELECT_LIVERY]}
        onPick={() => s.selectMultiLivery(slot.id)}
        onUnload={() => L.updateSlot(slot.id, { liveryPath: "" })}
        done={Boolean(slot.liveryPath) && !status.liveryError}
        trailing={slot.liveryPath && others ? (
          <button
            type="button"
            className="lv-link"
            onClick={() => L.copyToAll(slot.id, ["liveryPath"])}
            title="Put this livery on every vehicle in the lineup"
          >
            Use on all
          </button>
        ) : null}
      >
        {status.liveryError ? <SlotNote tone="error">{status.liveryError}</SlotNote> : null}
      </AssetSlot>

      <AssetSlot
        id="panel-multi-glass"
        step={3}
        title="Glass"
        path={slot.windowPath}
        emptyTitle="Choose a window design"
        emptyHint="Optional. Printed on the glass you pick below."
        hotkey={hk[HOTKEY_ACTIONS.SELECT_GLASS]}
        onPick={() => s.selectMultiWindow(slot.id)}
        onUnload={() => L.updateSlot(slot.id, { windowPath: "" })}
        done={Boolean(slot.windowPath) && !status.windowError}
      >
        {status.windowError ? <SlotNote tone="error">{status.windowError}</SlotNote> : null}
        {slot.windowPath ? (
          <SelectField label="Apply window design to">
            <Select value={slot.windowTarget} onValueChange={(value) => L.updateSlot(slot.id, { windowTarget: value })}>
              <SelectTrigger className="lv-select">
                <SelectValue placeholder="Meshes" />
              </SelectTrigger>
              <SelectContent className="lv-select-content">
                <SelectItem value="auto">
                  {info.windowTarget ? `Detected: ${info.windowLabel || info.windowTarget.replace(/^(material|mesh):/, "")}` : "Detected: none found"}
                </SelectItem>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="all">All meshes</SelectItem>
                {(info.targets || []).map((target) => (
                  <SelectItem key={target.value} value={target.value}>{target.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SelectField>
        ) : null}
      </AssetSlot>
    </div>
  );
}

export default function MultiWorkspace({ s, viewer, overlays }) {
  const [inspectorTab, setInspectorTab] = useState("paint");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const panes = usePaneWidths("cortex.multi.panes");
  const [captureOpen, setCaptureOpen] = useCaptureOpen();
  const L = s.lineup;
  const hk = s.hotkeys || {};
  const selectedIndex = Math.max(0, L.slots.findIndex((slot) => slot.id === L.selectedId));
  const selected = L.slots[selectedIndex];
  const loadedCount = L.slots.filter((slot) => slot.modelPath).length;
  const hasModel = loadedCount > 0;
  const full = L.slots.length >= MAX_LINEUP_SLOTS;
  const liveFiles = L.slots.some((slot) => slot.liveryPath || slot.windowPath);
  const moveOn = L.gizmoVisible && L.gizmoMode !== "rotate";
  const turnOn = L.gizmoVisible && L.gizmoMode === "rotate";

  const alerts = useMemo(() => {
    const list = [];
    if (s.dialogError) list.push({ id: "dialog", label: "Can't load that file", text: s.dialogError, clear: () => s.setDialogError("") });
    if (L.movedClothing) {
      list.push({
        id: "moved-clothing",
        label: "Clothing moved to EUP Studio",
        text: "This tab compared uniforms. Multi now lines up vehicles; open EUP Studio and add each piece under Addon pieces to wear them together.",
        clear: L.dismissMovedClothing,
      });
    }
    if (s.photoError) list.push({ id: "photo", label: "Photo not saved", text: s.photoError, clear: () => s.setPhotoError("") });
    return list;
  }, [s, L.movedClothing, L.dismissMovedClothing]);

  const cameraShots = <CameraShots s={s} disabled={!s.viewerReady} />;
  // Arranging stays on the deck even when camera controls live in the panel,
  // so the gizmo can always be shown and hidden where the vehicles are.
  const arrangeGroup = (
    <div className="lv-deck-group" role="group" aria-label="Arrange">
      <DeckButton
        onClick={s.lineUp}
        title="Line up: park the vehicles side by side in lineup order"
        disabled={loadedCount < 2}
        className="is-icon"
      >
        <Rows3 aria-hidden="true" />
      </DeckButton>
      <DeckButton
        active={moveOn}
        onClick={() => L.toggleGizmo("translate")}
        title={withShortcut(moveOn ? "Hide the move gizmo" : "Move the selected vehicle", hk[HOTKEY_ACTIONS.TOGGLE_DUAL_GIZMO])}
        className="is-icon"
      >
        <Move3d aria-hidden="true" />
      </DeckButton>
      <DeckButton
        active={turnOn}
        onClick={() => L.toggleGizmo("rotate")}
        title={turnOn ? "Hide the rotate gizmo" : "Rotate the selected vehicle in place"}
        className="is-icon"
      >
        <RotateCw aria-hidden="true" />
      </DeckButton>
    </div>
  );

  return (
    <WorkspaceFrame s={s} inspectorOpen={inspectorOpen} setInspectorOpen={setInspectorOpen} style={panes.style}>
      <aside className="lv-dock" aria-label="Vehicle lineup" inert={s.panelCollapsed}>
        <div className="lv-dock-scroll custom-scrollbar">
          <section className="mw-lineup" id="panel-multi-lineup" aria-labelledby="mw-lineup-title">
            <header className="mw-lineup-head">
              <h3 className="lv-slot-title" id="mw-lineup-title">Lineup</h3>
              <span className="mw-count">{L.slots.length}/{MAX_LINEUP_SLOTS}</span>
              <button
                type="button"
                className="cx-btn lv-btn-sm"
                onClick={() => L.addSlot()}
                disabled={full}
                title={full ? `The lineup holds ${MAX_LINEUP_SLOTS} vehicles` : "Add an empty vehicle slot"}
              >
                <Plus aria-hidden="true" />
                Add
              </button>
            </header>
            <ol className="mw-rows">
              {L.slots.map((slot, index) => (
                <LineupRow
                  key={slot.id}
                  slot={slot}
                  index={index}
                  selected={slot.id === L.selectedId}
                  status={L.status[slot.id]}
                  onSelect={() => L.select(slot.id)}
                  onToggleVisible={() => L.updateSlot(slot.id, { visible: !slot.visible })}
                />
              ))}
            </ol>
            <p className="lv-slot-note mw-tip">
              <span>
                Click a vehicle in the viewfinder to select it.
                {hk[HOTKEY_ACTIONS.SWAP_DUAL_SLOT] ? <> <Keycaps hotkey={hk[HOTKEY_ACTIONS.SWAP_DUAL_SLOT]} /> steps through the lineup.</> : null}
              </span>
            </p>
          </section>

          {selected ? <SelectedVehicle s={s} slot={selected} index={selectedIndex} /> : null}

          {liveFiles && s.isTauriRuntime ? (
            <SlotNote tone={s.watchStatus === "watching" ? "live" : s.watchStatus === "error" ? "error" : "idle"}>
              {s.watchStatus === "watching"
                ? "Liveries reload when you save them"
                : s.watchStatus === "error"
                  ? "Couldn't watch the livery files for changes"
                  : "Live reload is idle"}
            </SlotNote>
          ) : null}
        </div>
        <div className="lv-dock-foot">
          <section id="panel-multi-capture" className={`lv-capture ${hasModel ? "" : "is-disabled"} ${captureOpen || s.savingPhoto ? "is-open" : "is-collapsed"}`}>
            <CaptureHead bodyId="panel-multi-capture-body" open={captureOpen} locked={Boolean(s.savingPhoto)} onToggle={setCaptureOpen} />
            {captureOpen || s.savingPhoto ? (
              <div className="lv-slot-body" id="panel-multi-capture-body">
                {hasModel ? (
                  <>
                    <p className="lv-sheet-dest" title={s.previewFolder || undefined}>
                      <FolderOpen aria-hidden="true" />
                      {s.previewFolder ? <span className="is-path">{s.previewFolder}</span> : <span>You'll choose a folder when you save.</span>}
                    </p>
                    <button
                      type="button"
                      className="cx-btn is-primary lv-capture-btn"
                      disabled={!s.viewerReady || s.savingPhoto}
                      onClick={s.saveViewPhoto}
                      title="Save the viewfinder exactly as framed now, without the move gizmo"
                    >
                      <Aperture aria-hidden="true" />
                      {s.savingPhoto ? "Saving…" : "Save this view"}
                    </button>
                  </>
                ) : (
                  <p className="lv-slot-note">Load a vehicle to save a photo of the lineup.</p>
                )}
              </div>
            ) : null}
          </section>
        </div>
        <PaneResizer side="dock" label="Resize the lineup panel" setWidth={panes.setWidth} />
      </aside>

      <Viewfinder
        s={s}
        viewer={viewer}
        hasModel={hasModel}
        alerts={alerts}
        dropHint={`${s.modelDropLabel} to add vehicles, or an image for vehicle ${slotLetter(selectedIndex)}'s livery`}
        progress={null}
        deckStart={s.cameraControlsInPanel ? arrangeGroup : <>{cameraShots}{arrangeGroup}</>}
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

      <aside className="lv-inspector" aria-label="Inspector" inert={s.panelCollapsed || !inspectorOpen}>
        <PaneResizer side="insp" label="Resize the inspector" setWidth={panes.setWidth} />
        <InspectorTabs
          tabs={[{ id: "paint", label: "Paint" }, { id: "scene", label: "Scene" }]}
          active={inspectorTab}
          onChange={setInspectorTab}
        />
        <div className="lv-inspector-scroll custom-scrollbar">
          {inspectorTab === "paint" && selected ? (
            <>
              <PaintSlots
                key={selected.id}
                title={`Vehicle ${slotLetter(selectedIndex)} paint`}
                paint={selected.paint}
                onChange={(key, value) => value && L.setPaint(selected.id, key, value)}
                onReset={(key) => L.setPaint(selected.id, key, buildVehiclePaint(s.defaultBody)[key])}
              />
              {L.slots.length > 1 ? (
                <button
                  type="button"
                  className="lv-link mw-copy-all"
                  onClick={() => L.copyToAll(selected.id, ["paint"])}
                >
                  Use this paint on every vehicle
                </button>
              ) : null}
            </>
          ) : null}
          {inspectorTab === "scene" ? (
            <>
              <StageSection s={s} notes={STAGE_NOTES}>
                <div className="lv-field">
                  <span className="cx-label" id="mw-stage-lights-label">Spotlights</span>
                  <div className="lv-seg" role="radiogroup" aria-labelledby="mw-stage-lights-label">
                    {SHOWROOM_LIGHT_MODES.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        role="radio"
                        aria-checked={L.showroom.lights === option.id}
                        className={`lv-seg-btn ${L.showroom.lights === option.id ? "is-on" : ""}`}
                        onClick={() => L.setShowroom({ lights: option.id })}
                        title={option.title}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
                <FloorField id="mw-stage-floor-label" value={L.showroom.floor} onChange={(floor) => L.setShowroom({ floor })} />
              </StageSection>
              <TurntableSection s={s} />
              <BackdropSection s={s} />
              <LightSection s={s} />
              {s.cameraControlsInPanel ? <CameraSection>{cameraShots}</CameraSection> : null}
            </>
          ) : null}
        </div>
      </aside>

      {overlays}
    </WorkspaceFrame>
  );
}
