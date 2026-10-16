import { useEffect, useMemo, useState } from "react";
import { Check, FolderOpen, Loader2, X } from "lucide-react";
import { componentDisplayName } from "../../lib/eup";

const SIZES = [256, 512, 1024];

function Segmented({ label, value, options, onChange, disabled }) {
  return (
    <div className="eup-dialog-row">
      <span className="eup-dialog-label">{label}</span>
      <div className="lv-seg" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            className={`lv-seg-btn ${value === option.value ? "is-on" : ""}`}
            aria-checked={value === option.value}
            disabled={disabled || option.disabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// Batch-renders drawables into PNGs inside a folder the user picks. Existing
// files are only replaced after an explicit confirmation.
export default function EupThumbnailDialog({
  gender,
  focusComponent,
  buildJobs,
  onPickFolder,
  onCountConflicts,
  onRun,
  onCancel,
  onClose,
  onOpenFolder,
  run,
}) {
  const [size, setSize] = useState(512);
  const [allVariants, setAllVariants] = useState(false);
  const [scope, setScope] = useState("all");
  const [angle, setAngle] = useState("angled");
  const [transparent, setTransparent] = useState(true);
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const jobs = useMemo(() => buildJobs({ scope, allVariants }), [buildJobs, scope, allVariants]);
  const running = run?.status === "running";
  const finished = run && !running;

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape" && !running) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, running]);

  const start = (folder, list) => {
    setPending(null);
    onRun({ folder, jobs: list, size, angle, transparent });
  };

  const chooseFolder = async () => {
    setError("");
    setBusy(true);
    try {
      const folder = await onPickFolder();
      if (!folder) return;
      const list = jobs;
      const conflicts = await onCountConflicts(folder, list);
      if (conflicts > 0) setPending({ folder, jobs: list, conflicts });
      else start(folder, list);
    } catch (pickError) {
      setError(pickError?.message || String(pickError));
    } finally {
      setBusy(false);
    }
  };

  const progress = run?.total ? Math.round((run.done / run.total) * 100) : 0;

  const openRunFolder = async () => {
    setError("");
    if ((await onOpenFolder(run.folder)) === false) setError("Windows couldn't open the folder. The thumbnails are saved at the path above.");
  };

  return (
    <div className="eup-scrim" onPointerDown={(event) => event.target === event.currentTarget && !running && onClose()}>
      <div className="eup-dialog" role="dialog" aria-modal="true" aria-labelledby="eup-thumb-title">
        <header className="eup-dialog-head">
          <h2 id="eup-thumb-title" className="cx-display eup-dialog-title">Thumbnails</h2>
          <button type="button" className="cx-icon-btn" onClick={onClose} disabled={running} aria-label="Close" title="Close">
            <X aria-hidden="true" />
          </button>
        </header>

        {!run && !pending && (
          <div className="eup-dialog-body">
            <Segmented
              label="Drawables"
              value={scope}
              onChange={setScope}
              options={[
                { value: "all", label: "All" },
                {
                  value: "focused",
                  label: focusComponent ? componentDisplayName(focusComponent) : "Focused",
                  disabled: !focusComponent,
                },
              ]}
            />
            <Segmented
              label="Textures"
              value={allVariants ? "all" : "first"}
              onChange={(value) => setAllVariants(value === "all")}
              options={[
                { value: "first", label: "First" },
                { value: "all", label: "Every variant" },
              ]}
            />
            <Segmented
              label="Size"
              value={size}
              onChange={setSize}
              options={SIZES.map((value) => ({ value, label: `${value}` }))}
            />
            <Segmented
              label="Angle"
              value={angle}
              onChange={setAngle}
              options={[
                { value: "angled", label: "Three-quarter" },
                { value: "front", label: "Front" },
              ]}
            />
            <Segmented
              label="Background"
              value={transparent ? "clear" : "viewport"}
              onChange={(value) => setTransparent(value === "clear")}
              options={[
                { value: "clear", label: "Transparent" },
                { value: "viewport", label: "Viewport" },
              ]}
            />
            <p className="eup-dialog-note">
              {jobs.length} {jobs.length === 1 ? "PNG" : "PNGs"} named like <code>{jobs[0]?.fileName || `${gender}_jbib_000_a.png`}</code>.
              Each drawable renders on its own; props use the loaded skeleton for their anchor bone.
            </p>
            {error && <p className="eup-dialog-error" role="alert">{error}</p>}
            <footer className="eup-dialog-actions">
              <button type="button" className="settings-secondary" onClick={onClose}>Cancel</button>
              <button
                type="button"
                className="settings-primary"
                onClick={chooseFolder}
                disabled={busy || jobs.length === 0}
                autoFocus
              >
                {busy ? "Checking folder…" : "Choose folder and export"}
              </button>
            </footer>
          </div>
        )}

        {pending && !run && (
          <div className="eup-dialog-body">
            <p className="eup-dialog-note">
              {pending.conflicts} of {pending.jobs.length} files already exist in{" "}
              <code title={pending.folder}>{pending.folder}</code> and will be replaced.
            </p>
            <footer className="eup-dialog-actions">
              <button type="button" className="settings-secondary" onClick={() => setPending(null)}>Back</button>
              <button
                type="button"
                className="cx-btn is-danger"
                onClick={() => start(pending.folder, pending.jobs)}
                autoFocus
              >
                Replace {pending.conflicts} file{pending.conflicts === 1 ? "" : "s"}
              </button>
            </footer>
          </div>
        )}

        {run && (
          <div className="eup-dialog-body">
            <div className="lv-progress" role="progressbar" aria-label="Thumbnail export" aria-valuemin={0} aria-valuemax={run.total} aria-valuenow={run.done}>
              <span style={{ width: `${progress}%` }} />
            </div>
            <p className={`eup-dialog-status ${run.status === "done" && run.failed?.length === 0 ? "is-done" : ""}`}>
              {running ? <Loader2 className="eup-spin" aria-hidden="true" /> : null}
              {run.status === "done" && run.failed?.length === 0 ? <Check aria-hidden="true" /> : null}
              <span>
                {running
                  ? `${run.done} of ${run.total}${run.current ? ` · ${run.current}` : ""}`
                  : run.status === "cancelled"
                    ? `Cancelled after ${run.written} of ${run.total}`
                    : run.status === "error"
                      ? `Stopped: wrote ${run.written} of ${run.total}`
                      : `Wrote ${run.written} of ${run.total}`}
              </span>
            </p>
            {finished && run.written > 0 && run.folder ? (
              <p className="eup-dialog-dest" title={run.folder}>{run.folder}</p>
            ) : null}
            {run.error && <p className="eup-dialog-error" role="alert">{run.error}</p>}
            {error && <p className="eup-dialog-error" role="alert">{error}</p>}
            {run.failed?.length > 0 && (
              <div className="eup-dialog-failures">
                <p className="eup-dialog-error">{run.failed.length} {run.failed.length === 1 ? "drawable" : "drawables"} didn't render</p>
                <ul>
                  {run.failed.slice(0, 6).map((item) => (
                    <li key={item.fileName} title={item.error}>
                      <code>{item.fileName}</code> {item.error}
                    </li>
                  ))}
                  {run.failed.length > 6 && <li>and {run.failed.length - 6} more</li>}
                </ul>
              </div>
            )}
            <footer className="eup-dialog-actions">
              {running ? (
                <button type="button" className="settings-secondary" onClick={onCancel}>Cancel</button>
              ) : (
                <>
                  {run.written > 0 && run.folder ? (
                    <button type="button" className="settings-secondary" onClick={openRunFolder}>
                      <FolderOpen aria-hidden="true" />
                      Open folder
                    </button>
                  ) : null}
                  <button type="button" className="settings-primary" onClick={onClose} autoFocus={finished}>Close</button>
                </>
              )}
            </footer>
          </div>
        )}
      </div>
    </div>
  );
}
