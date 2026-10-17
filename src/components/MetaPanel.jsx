import { useMemo, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, FileText, RefreshCw, X } from "lucide-react";
import { Slider } from "./workspace/parts";
import { clampSteeringAngle } from "../lib/vehicle-steering.js";
import "./MetaPanel.css";

// Presentational panel for the vehicle meta simulation. The host reads the
// resource folder, runs simulateVehicle(), and owns viewer state; this
// component only renders the result and raises intents. Sections with nothing
// to preview are omitted, and reference data sits in one collapsed Details.

const LIVERY_SYSTEM_LABEL = {
  texture: "Texture liveries",
  modkit: "Mod kit liveries",
  both: "Texture and mod kit liveries",
  none: "No liveries",
};

const KIND_LABEL = {
  vehicles: "Vehicles",
  carvariations: "Variations",
  carcols: "Carcols",
  handling: "Handling",
  unknown: "Other",
};

const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 };
const SEVERITY_LABEL = { error: "Error", warn: "Warning", info: "Note" };

const SWATCH_SLOTS = [
  ["primary", "Primary"],
  ["secondary", "Secondary"],
  ["pearlescent", "Pearlescent"],
  ["wheels", "Wheels"],
  ["interior", "Interior"],
  ["dashboard", "Dashboard"],
];

function fileName(path) {
  if (typeof path !== "string") return "";
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

function joinOr(items) {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

function Section({ title, aside, children }) {
  return (
    <section className="mp-section">
      <header className="mp-section-head">
        <h3 className="mp-section-title">{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  );
}

function formatSteering(value) {
  if (Math.abs(value) < 0.05) return "Straight";
  return `${Math.abs(value).toFixed(1)}° ${value < 0 ? "left" : "right"}`;
}

function steeringReason(steering, steerableWheels) {
  if (!steerableWheels) return "No front wheel parts were loaded from the model.";
  if (!steering?.handlingId) return "vehicles.meta sets no handlingId for this model.";
  if (steering.lockDegrees == null) return `No fSteeringLock for ${steering.handlingId} in handling.meta.`;
  return "";
}

function Issue({ warning }) {
  return (
    <li className={`mp-issue is-${warning.severity}`}>
      <details>
        <summary>
          <span className="mp-issue-dot" aria-hidden="true" />
          <span className="mp-issue-message">
            <span className="mp-sr">{SEVERITY_LABEL[warning.severity]}: </span>
            {warning.message}
          </span>
          <ChevronDown className="mp-chevron" aria-hidden="true" />
        </summary>
        <div className="mp-issue-more">
          {warning.fix ? <p>{warning.fix}</p> : null}
          <span className="mp-mono">{warning.code}</span>
        </div>
      </details>
    </li>
  );
}

function Checks({ warnings }) {
  const [showNotes, setShowNotes] = useState(false);
  const problems = warnings.filter((warning) => warning.severity !== "info");
  const notes = warnings.filter((warning) => warning.severity === "info");
  if (warnings.length === 0) {
    return (
      <p className="mp-clear">
        <span className="mp-clear-dot" aria-hidden="true" />
        No problems in the meta files.
      </p>
    );
  }
  return (
    <Section
      title="Checks"
      aside={problems.length ? <span className="mp-status is-warn">{problems.length} to fix</span> : null}
    >
      {problems.length ? (
        <ul className="mp-issues">{problems.map((warning, index) => <Issue key={`${warning.code}-${index}`} warning={warning} />)}</ul>
      ) : null}
      {notes.length ? (
        <>
          <button type="button" className="mp-link" onClick={() => setShowNotes((open) => !open)} aria-expanded={showNotes}>
            {showNotes ? "Hide" : "Show"} {notes.length} {notes.length === 1 ? "note" : "notes"}
          </button>
          {showNotes ? (
            <ul className="mp-issues">{notes.map((warning, index) => <Issue key={`${warning.code}-${index}`} warning={warning} />)}</ul>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}

function IdList({ ids, conflicts }) {
  if (!ids.length) return <span className="mp-muted">None</span>;
  const conflictSet = new Set(conflicts || []);
  return (
    <span className="mp-ids">
      {ids.map((id) => (
        <span key={id} className={cx("mp-id", conflictSet.has(id) && "is-conflict")} title={conflictSet.has(id) ? `${id} is defined more than once` : undefined}>
          {id}
        </span>
      ))}
    </span>
  );
}

function ErrorList({ errors }) {
  return (
    <ul className="mp-errors">
      {errors.map((entry, index) => (
        <li key={`${entry.path}-${index}`} title={entry.path}>
          <span className="mp-mono">{fileName(entry.path) || "file"}</span> {entry.message}
        </li>
      ))}
    </ul>
  );
}

function SourceFiles({ sources, onOpenFile }) {
  return (
    <ul className="mp-files">
      {sources.map((source) => (
        <li key={source.path}>
          <button type="button" className="mp-file" onClick={() => onOpenFile?.(source.path)} title={`Open ${source.path}`}>
            <FileText aria-hidden="true" />
            <span className="mp-file-name">{fileName(source.path)}</span>
            <span className="mp-file-kind">{KIND_LABEL[source.kind] || source.kind}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function MetaPanel({
  status = "idle",
  resourceRoot = "",
  sources = [],
  errors = [],
  sim = null,
  liveryIndex = 0,
  onLiveryIndexChange,
  selectedColorPreset = null,
  onApplyColorPreset,
  extras = [],
  onToggleExtra,
  steerableWheels = false,
  steeringAngle = 0,
  onSteeringChange,
  onRescan,
  onOpenFile,
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const hasSources = Array.isArray(sources) && sources.length > 0;
  const hasErrors = Array.isArray(errors) && errors.length > 0;

  const warnings = useMemo(
    () => (sim ? [...sim.warnings].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3)) : []),
    [sim],
  );

  const scanning = status === "scanning";
  const rescanButton = (
    <button
      type="button"
      className="cx-icon-btn mp-rescan"
      onClick={onRescan}
      disabled={scanning || !onRescan}
      aria-label="Rescan the resource's meta files"
      title="Rescan the resource's meta files"
    >
      <RefreshCw aria-hidden="true" className={scanning ? "is-spinning" : undefined} />
    </button>
  );

  if (scanning && !hasSources) {
    return (
      <div className="mp-root" aria-busy="true">
        <div className="mp-empty">
          <strong>Reading meta files…</strong>
          <span className="mp-mono" title={resourceRoot}>{resourceRoot || "Resource folder"}</span>
        </div>
      </div>
    );
  }

  if (!hasSources) {
    return (
      <div className="mp-root">
        <div className="mp-empty">
          <strong>No vehicle meta found</strong>
          <span>
            Open a model inside a resource with a <span className="mp-mono">data</span> folder holding vehicles.meta,
            carvariations.meta or carcols.meta.
          </span>
          {hasErrors ? <ErrorList errors={errors} /> : null}
          <button type="button" className="mp-link" onClick={onRescan} disabled={!onRescan}>
            <RefreshCw aria-hidden="true" />
            Rescan
          </button>
        </div>
      </div>
    );
  }

  const texture = sim ? sim.textureLiveries : null;
  const textureCount = texture ? texture.count : 0;
  const current = textureCount > 0 ? Math.min(Math.max(liveryIndex, 0), textureCount - 1) : 0;
  const stepLivery = (delta) => {
    if (!onLiveryIndexChange || textureCount === 0) return;
    onLiveryIndexChange((current + delta + textureCount) % textureCount);
  };
  const conflictCount = sim ? sim.ids.conflicts.kit.length + sim.ids.conflicts.siren.length + sim.ids.conflicts.light.length : 0;
  const visibleExtras = extras.filter((extra) => extra.visible).length;
  const hasLiveries = sim && (textureCount > 0 || texture?.textures.length > 0 || sim.modkitLiveries.count > 0);
  const lock = sim?.steering?.lockDegrees ?? null;
  const canSteer = Boolean(onSteeringChange) && steerableWheels && lock !== null;
  const steeringValue = canSteer ? clampSteeringAngle(steeringAngle, lock) : 0;
  const absent = sim ? [
    !hasLiveries && "liveries",
    sim.colorPresets.length === 0 && "colour presets",
    extras.length === 0 && "extras",
  ].filter(Boolean) : [];

  return (
    <div className="mp-root">
      <header className="mp-head">
        <div className="mp-head-text">
          {sim ? <h2 className="mp-model cx-display" title={sim.modelName}>{sim.modelName}</h2> : null}
          <p className="mp-sub">
            {!sim ? "Open a vehicle model to check it against these files." : null}
            {hasLiveries ? <>{LIVERY_SYSTEM_LABEL[sim.liverySystem]}<span aria-hidden="true"> · </span></> : null}
            {sources.length} meta {sources.length === 1 ? "file" : "files"}
          </p>
        </div>
        {rescanButton}
      </header>

      {hasErrors ? <ErrorList errors={errors} /> : null}

      {sim ? (
        <>
          <Checks warnings={warnings} />

          {hasLiveries ? (
            <Section title="Liveries" aside={<span className="mp-count">{textureCount + sim.modkitLiveries.count}</span>}>
              {textureCount > 0 ? (
                <div className="mp-stepper" role="group" aria-label="Preview livery">
                  <button type="button" className="cx-icon-btn" onClick={() => stepLivery(-1)} disabled={!onLiveryIndexChange} aria-label="Previous livery">
                    <ChevronLeft aria-hidden="true" />
                  </button>
                  <div className="mp-stepper-readout">
                    <strong>Livery {texture.slotIndices?.[current] ?? current}</strong>
                    <span className="mp-mono">{texture.expectedTextureNames[current]}</span>
                  </div>
                  <button type="button" className="cx-icon-btn" onClick={() => stepLivery(1)} disabled={!onLiveryIndexChange} aria-label="Next livery">
                    <ChevronRight aria-hidden="true" />
                  </button>
                </div>
              ) : null}
              {textureCount > 0 && !onLiveryIndexChange ? (
                <p className="mp-muted">No nearby texture dictionary to preview these from.</p>
              ) : null}
              {texture && texture.textures.some((entry) => entry.found === false) ? (
                <ul className="mp-rows" aria-label="Expected livery textures">
                  {texture.textures.map((entry, index) => (
                    <li key={entry.name} className={cx("mp-row", index === current && "is-current", entry.found === false && "is-missing")}>
                      <span className="mp-row-mark" aria-hidden="true">
                        {entry.found === true ? <Check /> : entry.found === false ? <X /> : null}
                      </span>
                      <span className="mp-row-name mp-mono">{entry.name}</span>
                      <span className="mp-row-meta">{entry.found === true ? "Found" : entry.found === false ? "Missing" : ""}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {sim.modkitLiveries.kits.map((kit) => (
                <p key={kit.kitName} className="mp-muted">
                  {kit.liveryMods.length} mod kit {kit.liveryMods.length === 1 ? "livery" : "liveries"} in{" "}
                  <span className="mp-mono" title={kit.kitName}>{kit.kitName}</span>. Preview them from the Liveries tab in Vehicle.
                </p>
              ))}
            </Section>
          ) : null}

          {sim.colorPresets.length > 0 ? (
            <Section title="Colours" aside={<span className="mp-count">{sim.colorPresets.length}</span>}>
              <div className="mp-presets" role="group" aria-label="Colour presets">
                {sim.colorPresets.map((preset) => {
                  const selected = selectedColorPreset === preset.index;
                  return (
                    <button
                      key={preset.index}
                      type="button"
                      className={cx("mp-preset", selected && "is-selected")}
                      onClick={() => onApplyColorPreset?.(preset)}
                      aria-pressed={selected}
                      title={`Apply preset ${preset.index}`}
                    >
                      <span className="mp-swatches">
                        {SWATCH_SLOTS.map(([key, label]) => {
                          const color = preset[key];
                          if (!color) return null;
                          return (
                            <span
                              key={key}
                              className={cx("mp-swatch", !color.known && "is-unknown")}
                              style={{ background: color.hex }}
                              title={`${label}: ${color.name} (${color.index})`}
                            />
                          );
                        })}
                      </span>
                      <span className="mp-preset-name">
                        {preset.primary?.name || "Unknown"}
                        <span className="mp-preset-second"> / {preset.secondary?.name || "Unknown"}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </Section>
          ) : null}

          {extras.length > 0 ? (
            <Section title="Extras" aside={<span className="mp-count">{visibleExtras}/{extras.length}</span>}>
              <div className="mp-extras" role="group" aria-label="Extras visible in the viewer">
                {extras.map((extra) => (
                  <button
                    key={extra.index}
                    type="button"
                    className={cx("mp-extra", extra.visible && "is-on")}
                    onClick={() => onToggleExtra?.(extra.index, !extra.visible)}
                    aria-pressed={Boolean(extra.visible)}
                    title={extra.label || `Extra ${extra.index}`}
                  >
                    {extra.index}
                  </button>
                ))}
              </div>
            </Section>
          ) : null}

          {canSteer ? (
            <Section
              title="Steering"
              aside={Math.abs(steeringValue) >= 0.05 ? (
                <button type="button" className="mp-link" onClick={() => onSteeringChange(0)} title="Point the front wheels straight ahead">
                  Straighten
                </button>
              ) : null}
            >
              <Slider
                id="meta-steering-angle"
                label={`Front wheels, lock ±${lock}°`}
                value={steeringValue}
                min={-lock}
                max={lock}
                step={0.5}
                format={formatSteering}
                onChange={(next) => onSteeringChange(clampSteeringAngle(next, lock))}
              />
            </Section>
          ) : null}

          {absent.length ? <p className="mp-muted mp-absent">No {joinOr(absent)} in the meta files.</p> : null}
        </>
      ) : null}

      <section className="mp-section mp-details">
        <button type="button" className="mp-disclosure" onClick={() => setDetailsOpen((open) => !open)} aria-expanded={detailsOpen}>
          <h3 className="mp-section-title">Details</h3>
          {conflictCount > 0 ? <span className="mp-status is-warn">{conflictCount} id {conflictCount === 1 ? "conflict" : "conflicts"}</span> : null}
          <ChevronDown className={cx("mp-chevron", detailsOpen && "is-open")} aria-hidden="true" />
        </button>
        {detailsOpen ? (
          <>
            {sim ? (
              <dl className="mp-facts">
                <div className="mp-fact">
                  <dt>Texture dictionary</dt>
                  <dd className="mp-mono">
                    {sim.txd.txdName || "Unknown"}
                    {sim.txd.parentChain.length > 0 ? ` → ${sim.txd.parentChain.join(" → ")}` : ""}
                  </dd>
                </div>
                <div className="mp-fact"><dt>Plate</dt><dd>{sim.plate.type || "Unknown"}</dd></div>
                <div className="mp-fact"><dt>Wheels</dt><dd>{sim.wheels.type || "Unknown"}</dd></div>
                <div className="mp-fact"><dt>Kit ids</dt><dd><IdList ids={sim.ids.kitIds} conflicts={sim.ids.conflicts.kit} /></dd></div>
                <div className="mp-fact"><dt>Siren ids</dt><dd><IdList ids={sim.ids.sirenIds} conflicts={sim.ids.conflicts.siren} /></dd></div>
                <div className="mp-fact"><dt>Light ids</dt><dd><IdList ids={sim.ids.lightIds} conflicts={sim.ids.conflicts.light} /></dd></div>
                {extras.length > 0 ? (
                  <div className="mp-fact">
                    <dt>Extra flags</dt>
                    <dd>
                      {Object.keys(sim.extras.flags).length > 0 ? (
                        <span className="mp-mono">{Object.keys(sim.extras.flags).map((flag) => `FLAG_EXTRAS_${flag.toUpperCase()}`).join(", ")}</span>
                      ) : null}
                      {sim.extras.note ? <span className="mp-fact-note">{sim.extras.note}</span> : null}
                    </dd>
                  </div>
                ) : null}
                {!canSteer ? (
                  <div className="mp-fact"><dt>Steering</dt><dd>{steeringReason(sim.steering, steerableWheels) || "Unavailable"}</dd></div>
                ) : (
                  <div className="mp-fact">
                    <dt>Steering lock</dt>
                    <dd>
                      {onOpenFile && sim.steering.sourcePath ? (
                        <button type="button" className="mp-link" onClick={() => onOpenFile(sim.steering.sourcePath)} title={sim.steering.sourcePath}>
                          {sim.steering.handlingId}
                        </button>
                      ) : <span className="mp-mono">{sim.steering.handlingId}</span>}
                    </dd>
                  </div>
                )}
              </dl>
            ) : null}
            <SourceFiles sources={sources} onOpenFile={onOpenFile} />
          </>
        ) : null}
      </section>
    </div>
  );
}

export default MetaPanel;
