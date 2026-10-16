import { useEffect } from "react";
import { AlertTriangle, X } from "lucide-react";
import "./FormatWarningDialog.css";

/* A file the user just picked needs a word before they work on it: a standard
   vehicle model where the game shows its _hi model up close, an image format
   the viewer can't read, or a PSD above 8 bits. Every way out (button, Escape,
   the scrim) goes through `onDismiss`. */

const baseName = (path) => String(path || "").split(/[\\/]/).pop();
const modelStem = (name) => baseName(name).replace(/\.yft$/i, "");

function StandardModel({ warning }) {
  const stem = modelStem(warning.path);
  return (
    <>
      <p className="fw-text">
        <strong>{baseName(warning.path)}</strong> is the standard model. Up close the game draws <strong>{stem}_hi.yft</strong>, so texture against that one.
      </p>
      <p className="fw-note">
        Depending on the author, the standard model can lack the window template, material slots and detail the _hi model has.
      </p>
      {warning.hiChecked && !warning.hiPath ? (
        <p className="fw-status"><span className="fw-dot" aria-hidden="true" />No {stem}_hi.yft in the same folder.</p>
      ) : null}
    </>
  );
}

function UnsupportedImage({ warning, supportedExtensions }) {
  return (
    <>
      <p className="fw-text">
        <strong>{baseName(warning.path)}</strong> is a .{warning.ext} file, which the viewer can't read. Export it as PNG or PSD from your image editor and load that.
      </p>
      <dl className="fw-facts">
        <dt className="cx-label">Supported</dt>
        <dd>{supportedExtensions.join(", ")}</dd>
      </dl>
    </>
  );
}

function DeepPsd({ warning }) {
  return (
    <>
      <p className="fw-text">
        <strong>{baseName(warning.path) || "This PSD"}</strong> is {warning.bitDepth}-bit. The viewer reads 8-bit PSDs only.
      </p>
      <p className="fw-note">
        In Photoshop, choose <span className="fw-code">Image › Mode › 8 Bits/Channel</span>, save, and load it again. Exporting as PNG also converts it to 8-bit. Game textures don't need more.
      </p>
    </>
  );
}

const TITLES = {
  "non-hi-model": "Standard model",
  "unsupported-format": "Unsupported image",
};

export default function FormatWarningDialog({ warning, supportedExtensions = [], onDismiss, onOpenHi, onNeverShow }) {
  useEffect(() => {
    if (!warning) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onDismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [warning, onDismiss]);

  if (!warning) return null;
  const standard = warning.type === "non-hi-model";
  const title = TITLES[warning.type] || `${warning.bitDepth}-bit PSD`;

  return (
    <div className="fw-scrim" onPointerDown={(event) => event.target === event.currentTarget && onDismiss()}>
      <div className={`fw-dialog ${standard ? "is-caution" : "is-error"}`} role="alertdialog" aria-modal="true"
        aria-labelledby="fw-title" aria-describedby="fw-body">
        <header className="fw-head">
          <AlertTriangle className="fw-icon" aria-hidden="true" />
          <h2 id="fw-title" className="cx-display fw-title">{title}</h2>
          <button type="button" className="cx-icon-btn" onClick={onDismiss} aria-label="Close" title="Close">
            <X aria-hidden="true" />
          </button>
        </header>

        <div id="fw-body" className="fw-body">
          {standard ? <StandardModel warning={warning} />
            : warning.type === "unsupported-format" ? <UnsupportedImage warning={warning} supportedExtensions={supportedExtensions} />
              : <DeepPsd warning={warning} />}
        </div>

        <footer className="fw-foot">
          {standard ? (
            <button type="button" className="cx-btn is-quiet fw-never" onClick={onNeverShow}
              title="Stop warning about standard models. Settings › Standard Model Warning turns it back on.">
              Never show this again
            </button>
          ) : null}
          <div className="fw-actions">
            {warning.hiPath ? (
              <>
                <button type="button" className="settings-secondary" onClick={onDismiss}>Keep this model</button>
                <button type="button" className="settings-primary" onClick={onOpenHi} autoFocus title={`Open ${warning.hiPath}`}>
                  Open _hi model
                </button>
              </>
            ) : (
              <button type="button" className="settings-primary" onClick={onDismiss} autoFocus>Got it</button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
