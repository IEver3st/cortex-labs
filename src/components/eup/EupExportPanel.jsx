import { memo } from "react";
import { Check, Clapperboard, FolderOpen, Grid2x2, Images, Loader2 } from "lucide-react";
import { Toggle } from "../ui/toggle";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { EXPORT_FORMATS, SHOT_ANGLES, VIDEO_LENGTHS, formatSize } from "../../lib/eup-export";

const MODES = [
  { id: "shots", label: "Shots" },
  { id: "video", label: "Video" },
  { id: "sheet", label: "Colourways" },
];

function Segmented({ label, id, value, options, onChange }) {
  return (
    <div className="lv-field">
      <span className="cx-label" id={id}>{label}</span>
      <div className="lv-seg" role="radiogroup" aria-labelledby={id}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={value === option.id}
            className={`lv-seg-btn ${value === option.id ? "is-on" : ""}`}
            onClick={() => onChange(option.id)}
            disabled={option.disabled}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function RunStatus({ run, onCancel, onConfirm, onDismiss, onOpenFolder }) {
  if (!run) return null;
  if (run.status === "confirm") {
    return (
      <div className="eup-run is-confirm" role="alert">
        <p>
          {run.conflicts} of {run.total} files already exist in <code title={run.folder}>{run.folder}</code>. Replace them?
        </p>
        <div className="lv-slot-actions">
          <button type="button" className="cx-btn is-danger lv-btn-sm" onClick={onConfirm}>
            Replace {run.conflicts} {run.conflicts === 1 ? "file" : "files"}
          </button>
          <button type="button" className="cx-btn is-quiet lv-btn-sm" onClick={onDismiss}>Cancel</button>
        </div>
      </div>
    );
  }
  if (run.status === "running") {
    return (
      <div className="eup-run" role="status" aria-live="polite">
        <div className="lv-progress" role="progressbar" aria-label={run.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(run.progress * 100)}>
          <span style={{ width: `${Math.round(run.progress * 100)}%` }} />
        </div>
        <p className="eup-run-line">
          <Loader2 className="eup-spin" aria-hidden="true" />
          <span>{run.label}</span>
        </p>
        <button type="button" className="cx-btn is-quiet lv-btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    );
  }
  if (run.status === "done") {
    return (
      <div className="lv-done" role="status">
        <div className="lv-done-head">
          <span className="lv-done-check" aria-hidden="true"><Check /></span>
          <div>
            <strong>{run.label}</strong>
            {run.output ? <span title={run.output}>{run.output}</span> : null}
          </div>
        </div>
        <div className="lv-slot-actions">
          {run.folder ? (
            <button type="button" className="cx-btn lv-btn-sm" onClick={() => onOpenFolder(run.folder)}>
              <FolderOpen aria-hidden="true" />
              Open folder
            </button>
          ) : null}
          <button type="button" className="cx-btn is-quiet lv-btn-sm" onClick={onDismiss}>Dismiss</button>
        </div>
      </div>
    );
  }
  // Cancelled or stopped runs that wrote files still say where they are.
  return (
    <div className={`eup-run ${run.status === "error" ? "is-error" : ""}`} role={run.status === "error" ? "alert" : "status"}>
      <p>{run.label}</p>
      {run.error ? <p className="eup-run-error">{run.error}</p> : null}
      {run.folder ? <p><code title={run.folder}>{run.folder}</code></p> : null}
      <div className="lv-slot-actions">
        {run.folder ? (
          <button type="button" className="cx-btn lv-btn-sm" onClick={() => onOpenFolder(run.folder)}>
            <FolderOpen aria-hidden="true" />
            Open folder
          </button>
        ) : null}
        <button type="button" className="cx-btn is-quiet lv-btn-sm" onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  );
}

/**
 * Exports built on the live scene: still shots, a turntable or fixed-camera
 * video, and a colourway sheet of one drawable's textures. Everything renders
 * through the viewfinder's stage, light, pose and hair, and "This view" is
 * exactly the frame drawn on the viewfinder.
 */
function EupExportPanel({
  settings,
  onChange,
  stem,
  stemPlaceholder,
  onStemChange,
  isTauriRuntime,
  showroomOn,
  videoType,
  sheetOptions,
  sheetComponent,
  onSheetComponentChange,
  run,
  onShots,
  onVideo,
  onSheet,
  onCancel,
  onConfirm,
  onDismiss,
  onOpenFolder,
  onThumbnails,
  thumbnailsBlocked,
  sheetNote = "",
}) {
  const running = run?.status === "running" || run?.status === "confirm";
  const size = formatSize(settings.format, settings.mode === "shots" && settings.high);
  const formatOptions = EXPORT_FORMATS.map((format) => ({ id: format.id, label: format.label }));
  const transparentAllowed = !showroomOn && settings.mode !== "video";
  const transparent = transparentAllowed && settings.transparent;
  const sheet = sheetOptions.find((option) => option.component === sheetComponent) || sheetOptions[0] || null;
  const blocked = !isTauriRuntime ? "Exporting needs the desktop app." : "";

  let action = null;
  if (settings.mode === "shots") {
    const count = settings.angles.length;
    action = (
      <button type="button" className="cx-btn is-primary lv-capture-btn" disabled={Boolean(blocked) || running || count === 0} onClick={onShots}>
        <Images aria-hidden="true" />
        {count === 0 ? "Pick an angle" : `Export ${count} ${count === 1 ? "shot" : "shots"}`}
      </button>
    );
  } else if (settings.mode === "video") {
    action = (
      <button type="button" className="cx-btn is-primary lv-capture-btn" disabled={Boolean(blocked) || running || !videoType} onClick={onVideo}>
        <Clapperboard aria-hidden="true" />
        Record {settings.videoLength} s video
      </button>
    );
  } else {
    action = (
      <button type="button" className="cx-btn is-primary lv-capture-btn" disabled={Boolean(blocked) || running || !sheet} onClick={onSheet}>
        <Grid2x2 aria-hidden="true" />
        {sheet ? `Export ${sheet.variants.length} colourways` : "No colourways to show"}
      </button>
    );
  }

  return (
    <>
      <section className="lv-group">
        <div className="lv-seg" role="radiogroup" aria-label="Export">
          {MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              role="radio"
              aria-checked={settings.mode === mode.id}
              className={`lv-seg-btn ${settings.mode === mode.id ? "is-on" : ""}`}
              onClick={() => onChange({ mode: mode.id })}
              disabled={running}
            >
              {mode.label}
            </button>
          ))}
        </div>
        <p className="lv-slot-note">
          {showroomOn ? "Rendered in the Showroom" : "Rendered on the Workbench"} with the current pose, light and hair. The frame on the
          viewfinder is what This view captures.
        </p>
      </section>

      <section className="lv-group">
        <Segmented label="Format" id="eup-export-format" value={settings.format} options={formatOptions} onChange={(format) => onChange({ format })} />
        <p className="eup-export-size">
          {size.width} × {size.height}
        </p>
        {settings.mode === "shots" ? (
          <div className="lv-toggle-row">
            <span>Double size</span>
            <Toggle checked={settings.high} onChange={(high) => onChange({ high })} ariaLabel="Render shots at double size" />
          </div>
        ) : null}
        {settings.mode !== "video" ? (
          <>
            <div className="lv-toggle-row">
              <span>Transparent background</span>
              <Toggle
                checked={transparent}
                onChange={(value) => onChange({ transparent: value })}
                disabled={!transparentAllowed}
                ariaLabel="Export with a transparent background"
              />
            </div>
            {showroomOn ? <p className="lv-slot-note">The Showroom is the background. Switch to Workbench for a transparent one.</p> : null}
          </>
        ) : null}
      </section>

      {settings.mode === "shots" ? (
        <section className="lv-group">
          <div className="lv-field">
            <span className="cx-label" id="eup-export-angles">Angles</span>
            <div className="lv-chips" role="group" aria-labelledby="eup-export-angles">
              {SHOT_ANGLES.map((angle) => {
                const on = settings.angles.includes(angle.id);
                return (
                  <button
                    key={angle.id}
                    type="button"
                    className={`lv-chip-btn ${on ? "is-on" : ""}`}
                    aria-pressed={on}
                    onClick={() => onChange({ angles: on ? settings.angles.filter((id) => id !== angle.id) : [...settings.angles, angle.id] })}
                  >
                    {angle.label}
                  </button>
                );
              })}
            </div>
          </div>
          <p className="lv-slot-note">This view keeps your framing; the others frame the ped automatically. All shots use the same frame of the pose.</p>
        </section>
      ) : null}

      {settings.mode === "video" ? (
        <section className="lv-group">
          <Segmented
            label="Camera"
            id="eup-export-camera"
            value={settings.videoCamera}
            options={[{ id: "turntable", label: "Turntable" }, { id: "fixed", label: "Fixed" }]}
            onChange={(videoCamera) => onChange({ videoCamera })}
          />
          <Segmented
            label="Length"
            id="eup-export-length"
            value={settings.videoLength}
            options={VIDEO_LENGTHS.map((seconds) => ({ id: seconds, label: `${seconds} s` }))}
            onChange={(videoLength) => onChange({ videoLength })}
          />
          <p className="lv-slot-note">
            {settings.videoCamera === "turntable"
              ? "One full turn around the ped, starting from this view."
              : "Holds this view."}{" "}
            Records in real time at 30 fps; an animated pose keeps playing, and Walk moves the floor.
            {videoType ? ` Saves ${videoType.extension.toUpperCase()}.` : " This system can't record video."}
          </p>
        </section>
      ) : null}

      {settings.mode === "sheet" ? (
        <section className="lv-group">
          {sheetOptions.length > 0 ? (
            <div className="lv-field">
              <span className="cx-label">Drawable</span>
              <Select value={sheet?.component} onValueChange={onSheetComponentChange}>
                <SelectTrigger className="lv-select" aria-label="Drawable for the colourway sheet">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="lv-select-content">
                  {sheetOptions.map((option) => (
                    <SelectItem key={option.component} value={option.component}>
                      {option.label} ({option.variants.length})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <p className="lv-slot-note">{sheetNote || "Select a drawable with two or more textures in the Clothing tab first."}</p>
          )}
          <div className="lv-toggle-row">
            <span>Texture letters</span>
            <Toggle checked={settings.sheetLabels} onChange={(sheetLabels) => onChange({ sheetLabels })} ariaLabel="Label each colourway with its texture letter" />
          </div>
          <p className="lv-slot-note">One image with every texture of the drawable, worn in this view.</p>
        </section>
      ) : null}

      <section className="lv-group">
        <label className="lv-field">
          <span className="cx-label">File name</span>
          <input
            className="eup-input eup-mono"
            value={stem}
            placeholder={stemPlaceholder}
            maxLength={60}
            onChange={(event) => onStemChange(event.target.value)}
            spellCheck={false}
            disabled={running}
          />
        </label>
        {blocked ? <p className="lv-slot-note">{blocked}</p> : null}
        {action}
        <RunStatus run={run} onCancel={onCancel} onConfirm={onConfirm} onDismiss={onDismiss} onOpenFolder={onOpenFolder} />
      </section>

      <section className="lv-group">
        <h3 className="lv-group-title">Thumbnails</h3>
        <p className="lv-slot-note">A PNG per drawable for clothing menus and docs, rendered on its own.</p>
        <button type="button" className="cx-btn lv-btn-sm eup-export-secondary" onClick={onThumbnails} disabled={Boolean(thumbnailsBlocked) || running} title={thumbnailsBlocked || undefined}>
          <Images aria-hidden="true" />
          Batch thumbnails…
        </button>
      </section>
    </>
  );
}

export default memo(EupExportPanel);
