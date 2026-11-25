import { useEffect, useRef, useState } from "react";
import { Check, Film, FolderOpen, Grid2x2, ImageDown, Layers, Loader2, X } from "lucide-react";
import { Slider } from "../workspace/parts";
import { THUMBNAIL_SIZES } from "../../lib/prop-studio.js";

const MODES = [
  { id: "single", label: "Icon PNG", icon: ImageDown },
  { id: "sheet", label: "Sheet", icon: Grid2x2 },
  { id: "batch", label: "Batch", icon: Layers },
  { id: "video", label: "Turntable", icon: Film },
];

const ANGLES = [
  { value: "camera", label: "As framed" },
  { value: "angle", label: "3/4" },
  { value: "front", label: "Front" },
  { value: "top", label: "Top" },
];

const VIDEO_SIZES = [
  { value: "square", label: "1080 × 1080", width: 1080, height: 1080 },
  { value: "hd", label: "1920 × 1080", width: 1920, height: 1080 },
];

const VIDEO_LENGTHS = [
  { value: 4, label: "4 s" },
  { value: 6, label: "6 s" },
  { value: 8, label: "8 s" },
  { value: 12, label: "12 s" },
];

const PREVIEW_SIZE = 192;
const PREVIEW_DEBOUNCE_MS = 120;

function Segmented({ label, value, options, onChange, disabled }) {
  return (
    <div className="ps-dialog-row">
      <span className="ps-dialog-label">{label}</span>
      <div className="lv-seg" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            className={`lv-seg-btn ${value === option.value ? "is-on" : ""}`}
            aria-checked={value === option.value}
            disabled={disabled || option.disabled}
            title={option.title}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Prop Studio export dialog:
 * - Single PNG (inventory icon / store cutout)
 * - Contact sheet (4-angle showcase, all drawables in .ydd, or whole prop folder)
 * - Batch icons (transparent <prop>.png for every prop in the folder or drawable in .ydd)
 * - Turntable video (30 fps 360° MP4/WebM straight from the viewport)
 */
export default function PropExportDialog({
  options,
  onOptionsChange,
  onRender,
  onSave,
  onExportSheet,
  onExportBatch,
  onExportVideo,
  folderProps = [],
  drawables = [],
  onClose,
  onOpenFolder,
  backdrop,
}) {
  const [mode, setMode] = useState("single");
  const [sheetScope, setSheetScope] = useState("angles");
  const [batchScope, setBatchScope] = useState(() => (folderProps.length > 1 ? "folder" : drawables.length > 1 ? "drawables" : "folder"));
  const [videoSize, setVideoSize] = useState("square");
  const [videoSeconds, setVideoSeconds] = useState(6);

  const [preview, setPreview] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [status, setStatus] = useState({ state: "idle", path: "", detail: "", error: "" });
  const [progress, setProgress] = useState({ current: 0, total: 0, label: "" });
  const [openError, setOpenError] = useState("");
  const previewUrlRef = useRef("");
  const abortRef = useRef(null);
  const busy = status.state === "saving";

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  useEffect(() => {
    if (mode !== "single") return undefined;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const bytes = await onRender({ ...options, size: PREVIEW_SIZE });
        if (cancelled) return;
        const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = url;
        setPreview(url);
        setPreviewError("");
      } catch (error) {
        if (!cancelled) setPreviewError(error?.message || String(error));
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mode, options, onRender]);

  useEffect(() => () => {
    abortRef.current?.abort();
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  const showInFolder = async () => {
    setOpenError("");
    if ((await onOpenFolder(status.path)) === false) {
      setOpenError("Windows couldn't open the folder. The files are saved at the path above.");
    }
  };

  const handleCancel = () => {
    if (busy) {
      abortRef.current?.abort();
    } else {
      onClose();
    }
  };

  const runAction = async () => {
    setOpenError("");
    setStatus({ state: "saving", path: "", detail: "", error: "" });
    setProgress({ current: 0, total: 0, label: "" });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      if (mode === "single") {
        const path = await onSave(options);
        setStatus(path ? { state: "done", path, detail: "", error: "" } : { state: "idle", path: "", detail: "", error: "" });
      } else if (mode === "sheet") {
        const result = await onExportSheet({
          scope: sheetScope,
          options,
          signal: controller.signal,
          onProgress: setProgress,
        });
        setStatus(result?.path
          ? { state: "done", path: result.path, detail: result.detail || "", error: "" }
          : { state: "idle", path: "", detail: "", error: "" });
      } else if (mode === "batch") {
        const result = await onExportBatch({
          scope: batchScope,
          options,
          signal: controller.signal,
          onProgress: setProgress,
        });
        setStatus(result?.folder
          ? { state: "done", path: result.folder, detail: result.detail || "", error: result.partialError || "" }
          : { state: "idle", path: "", detail: "", error: "" });
      } else if (mode === "video") {
        const preset = VIDEO_SIZES.find((item) => item.value === videoSize) || VIDEO_SIZES[0];
        const result = await onExportVideo({
          width: preset.width,
          height: preset.height,
          seconds: videoSeconds,
          signal: controller.signal,
          onProgress: setProgress,
        });
        setStatus(result?.path
          ? { state: "done", path: result.path, detail: result.detail || "", error: "" }
          : { state: "idle", path: "", detail: "", error: "" });
      }
    } catch (error) {
      if (error?.name === "AbortError" || controller.signal.aborted) {
        setStatus({ state: "idle", path: "", detail: "", error: "" });
      } else {
        setStatus({ state: "error", path: "", detail: "", error: error?.message || String(error) });
      }
    } finally {
      abortRef.current = null;
    }
  };

  const update = (patch) => {
    setOpenError("");
    if (status.state !== "saving") setStatus({ state: "idle", path: "", detail: "", error: "" });
    onOptionsChange(patch);
  };

  const hasFolderProps = folderProps.length > 0;
  const hasDrawables = drawables.length > 1;
  const batchDisabled = mode === "batch" && ((batchScope === "folder" && !hasFolderProps) || (batchScope === "drawables" && !hasDrawables));

  const batchCount = batchScope === "drawables" ? drawables.length : folderProps.length;
  const actionLabel = busy
    ? progress.total > 0 ? `${progress.current} / ${progress.total}…` : "Exporting…"
    : mode === "single"
      ? status.state === "done" ? "Save another" : "Save PNG…"
      : mode === "sheet"
        ? "Save contact sheet…"
        : mode === "batch"
          ? `Export ${batchCount} ${batchCount === 1 ? "PNG" : "PNGs"}…`
          : "Record turntable…";

  return (
    <div className="ps-scrim" onPointerDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <div className="ps-dialog" role="dialog" aria-modal="true" aria-labelledby="ps-export-title">
        <header className="ps-dialog-head">
          <h2 id="ps-export-title" className="cx-display ps-dialog-title">Export prop media</h2>
          <button type="button" className="cx-icon-btn" onClick={onClose} disabled={busy} aria-label="Close" title="Close">
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="ps-dialog-body">
          <div className="lv-seg" role="tablist" aria-label="Export mode">
            {MODES.map((entry) => {
              const Icon = entry.icon;
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={mode === entry.id}
                  className={`lv-seg-btn ps-mode-tab ${mode === entry.id ? "is-on" : ""}`}
                  disabled={busy}
                  onClick={() => {
                    setMode(entry.id);
                    setStatus({ state: "idle", path: "", detail: "", error: "" });
                  }}
                >
                  <Icon aria-hidden="true" />
                  <span>{entry.label}</span>
                </button>
              );
            })}
          </div>

          {mode === "single" ? (
            <>
              <div
                className={`ps-preview ${options.transparent ? "is-clear" : ""}`}
                style={options.transparent ? undefined : { background: backdrop }}
                aria-live="polite"
              >
                {preview ? <img src={preview} alt="Preview of the exported image" /> : null}
                {!preview && !previewError ? <Loader2 className="ps-spin" aria-hidden="true" /> : null}
                {previewError ? <span className="ps-dialog-error">{previewError}</span> : null}
              </div>
              <Segmented
                label="Size"
                value={options.size}
                onChange={(size) => update({ size })}
                options={THUMBNAIL_SIZES.map((value) => ({ value, label: `${value}` }))}
                disabled={busy}
              />
              <Segmented label="Angle" value={options.angle} onChange={(angle) => update({ angle })} options={ANGLES} disabled={busy} />
              <Segmented
                label="Background"
                value={options.transparent ? "clear" : "backdrop"}
                onChange={(value) => update({ transparent: value === "clear" })}
                options={[
                  { value: "clear", label: "Transparent" },
                  { value: "backdrop", label: "Backdrop colour" },
                ]}
                disabled={busy}
              />
              <Slider
                id="ps-export-padding"
                label="Padding"
                value={options.padding}
                min={0}
                max={0.5}
                step={0.01}
                disabled={busy}
                format={(value) => `${Math.round(value * 100)}%`}
                onChange={(padding) => update({ padding })}
              />
              <p className="ps-dialog-note">
                A square PNG of the prop alone, lit as the viewfinder lights it. Ideal for ox_inventory, qb-inventory and store icons.
              </p>
            </>
          ) : null}

          {mode === "sheet" ? (
            <>
              <Segmented
                label="Contents"
                value={sheetScope}
                onChange={setSheetScope}
                options={[
                  { value: "angles", label: "4 angles" },
                  { value: "drawables", label: `Drawables (${drawables.length})`, disabled: !hasDrawables, title: hasDrawables ? undefined : "This file has a single drawable" },
                  { value: "folder", label: `Folder (${folderProps.length})`, disabled: folderProps.length < 2, title: folderProps.length < 2 ? "Needs at least 2 props in the folder" : undefined },
                ]}
                disabled={busy}
              />
              <Segmented
                label="Angle"
                value={options.angle === "camera" ? "angle" : options.angle}
                onChange={(angle) => update({ angle })}
                options={ANGLES.filter((a) => a.value !== "camera")}
                disabled={busy || sheetScope === "angles"}
              />
              <p className="ps-dialog-note">
                {sheetScope === "angles"
                  ? "Renders 3/4, Front, Side and Top shots into one labelled showcase sheet."
                  : sheetScope === "drawables"
                    ? `Renders all ${drawables.length} drawables in this file into a labelled contact sheet.`
                    : `Renders all ${folderProps.length} props in this folder into one labelled pack contact sheet.`}
              </p>
            </>
          ) : null}

          {mode === "batch" ? (
            <>
              <Segmented
                label="Source"
                value={batchScope}
                onChange={setBatchScope}
                options={[
                  { value: "folder", label: `Folder (${folderProps.length})`, disabled: !hasFolderProps, title: hasFolderProps ? undefined : "No sibling props found in this folder" },
                  { value: "drawables", label: `Drawables (${drawables.length})`, disabled: !hasDrawables, title: hasDrawables ? undefined : "This file has a single drawable" },
                ]}
                disabled={busy}
              />
              <Segmented
                label="Size"
                value={options.size}
                onChange={(size) => update({ size })}
                options={THUMBNAIL_SIZES.map((value) => ({ value, label: `${value}` }))}
                disabled={busy}
              />
              <Segmented
                label="Angle"
                value={options.angle === "camera" ? "angle" : options.angle}
                onChange={(angle) => update({ angle })}
                options={ANGLES.filter((a) => a.value !== "camera")}
                disabled={busy}
              />
              <Segmented
                label="Background"
                value={options.transparent ? "clear" : "backdrop"}
                onChange={(value) => update({ transparent: value === "clear" })}
                options={[
                  { value: "clear", label: "Transparent" },
                  { value: "backdrop", label: "Backdrop colour" },
                ]}
                disabled={busy}
              />
              <Slider
                id="ps-batch-padding"
                label="Padding"
                value={options.padding}
                min={0}
                max={0.5}
                step={0.01}
                disabled={busy}
                format={(value) => `${Math.round(value * 100)}%`}
                onChange={(padding) => update({ padding })}
              />
              <p className="ps-dialog-note">
                Saves one <code>&lt;name&gt;.png</code> per prop with identical framing and lighting — drop straight into <code>ox_inventory/web/images</code> or a Tebex store.
              </p>
            </>
          ) : null}

          {mode === "video" ? (
            <>
              <Segmented
                label="Format"
                value={videoSize}
                onChange={setVideoSize}
                options={VIDEO_SIZES.map((item) => ({ value: item.value, label: item.label }))}
                disabled={busy}
              />
              <Segmented
                label="Length"
                value={videoSeconds}
                onChange={setVideoSeconds}
                options={VIDEO_LENGTHS}
                disabled={busy}
              />
              <p className="ps-dialog-note">
                Records one full 360° turntable spin at 30 fps using the current stage, lighting, emissives and showroom reflections.
              </p>
            </>
          ) : null}

          {busy && progress.total > 0 ? (
            <div className="ps-progress-wrap">
              <div className="lv-progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.current}>
                <span style={{ width: `${Math.round((progress.current / progress.total) * 100)}%` }} />
              </div>
              {progress.label ? <span className="ps-row-meta">{progress.label}</span> : null}
            </div>
          ) : null}

          {status.state === "done" ? (
            <p className="ps-dialog-status is-done">
              <Check aria-hidden="true" />
              <span title={status.path}>{status.detail ? `${status.detail} · ` : ""}{status.path}</span>
            </p>
          ) : null}
          {status.error ? <p className="ps-dialog-error" role="alert">{status.error}</p> : null}
          {openError ? <p className="ps-dialog-error" role="alert">{openError}</p> : null}

          <footer className="ps-dialog-actions">
            {status.state === "done" ? (
              <button type="button" className="settings-secondary" onClick={showInFolder}>
                <FolderOpen aria-hidden="true" />
                Show in folder
              </button>
            ) : (
              <button type="button" className="settings-secondary" onClick={handleCancel}>
                {busy ? "Stop" : "Cancel"}
              </button>
            )}
            <button type="button" className="settings-primary" onClick={runAction} disabled={busy || batchDisabled} autoFocus>
              {actionLabel}
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}
