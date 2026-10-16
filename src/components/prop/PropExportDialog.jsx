import { useEffect, useRef, useState } from "react";
import { Check, FolderOpen, Loader2, X } from "lucide-react";
import { Slider } from "../workspace/parts";
import { THUMBNAIL_SIZES } from "../../lib/prop-studio.js";

const ANGLES = [
  { value: "camera", label: "As framed" },
  { value: "angle", label: "3/4" },
  { value: "front", label: "Front" },
  { value: "top", label: "Top" },
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
            disabled={disabled}
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
 * One PNG of the prop alone: inventory icons, store images, docs. The
 * preview renders through the same path as the file. Nothing is written
 * until the user picks a destination.
 */
export default function PropExportDialog({ options, onOptionsChange, onRender, onSave, onClose, onOpenFolder, backdrop }) {
  const [preview, setPreview] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [status, setStatus] = useState({ state: "idle", path: "", error: "" });
  const [openError, setOpenError] = useState("");
  const previewUrlRef = useRef("");
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
  }, [options, onRender]);

  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  const showInFolder = async () => {
    setOpenError("");
    if ((await onOpenFolder(status.path)) === false) setOpenError("Windows couldn't open the folder. The image is saved at the path above.");
  };

  const save = async () => {
    setOpenError("");
    setStatus({ state: "saving", path: "", error: "" });
    try {
      const path = await onSave(options);
      setStatus(path ? { state: "done", path, error: "" } : { state: "idle", path: "", error: "" });
    } catch (error) {
      setStatus({ state: "error", path: "", error: error?.message || String(error) });
    }
  };

  const update = (patch) => {
    setOpenError("");
    if (status.state !== "saving") setStatus({ state: "idle", path: "", error: "" });
    onOptionsChange(patch);
  };

  return (
    <div className="ps-scrim" onPointerDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <div className="ps-dialog" role="dialog" aria-modal="true" aria-labelledby="ps-export-title">
        <header className="ps-dialog-head">
          <h2 id="ps-export-title" className="cx-display ps-dialog-title">Export image</h2>
          <button type="button" className="cx-icon-btn" onClick={onClose} disabled={busy} aria-label="Close" title="Close">
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="ps-dialog-body">
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
            format={(value) => `${Math.round(value * 100)}%`}
            onChange={(padding) => update({ padding })}
          />
          <p className="ps-dialog-note">
            A square PNG of the prop alone, lit as the viewfinder lights it. Emissives render sharp; glow and haze stay in
            the viewfinder.
          </p>
          {status.state === "done" ? (
            <p className="ps-dialog-status is-done">
              <Check aria-hidden="true" />
              <span title={status.path}>{status.path}</span>
            </p>
          ) : null}
          {status.state === "error" ? <p className="ps-dialog-error" role="alert">The image wasn't saved: {status.error}</p> : null}
          {openError ? <p className="ps-dialog-error" role="alert">{openError}</p> : null}
          <footer className="ps-dialog-actions">
            {status.state === "done" ? (
              <button type="button" className="settings-secondary" onClick={showInFolder}>
                <FolderOpen aria-hidden="true" />
                Show in folder
              </button>
            ) : (
              <button type="button" className="settings-secondary" onClick={onClose} disabled={busy}>Cancel</button>
            )}
            <button type="button" className="settings-primary" onClick={save} disabled={busy} autoFocus>
              {busy ? "Saving…" : status.state === "done" ? "Save another" : "Save PNG…"}
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}
