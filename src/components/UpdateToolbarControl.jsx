import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { AlertCircle, Download, LoaderCircle, RotateCw } from "lucide-react";
import { useUpdateChecker } from "../lib/updater";
import { getUpdatePhase, UPDATE_PHASE } from "../lib/updater-state";

function UpdateControlContent({ phase, updater, transition }) {
  const versionLabel = updater.latest ? `v${updater.latest}` : "";

  if (phase === UPDATE_PHASE.DOWNLOADING) {
    const progressLabel = updater.progressKnown
      ? `${updater.progressPercent}% downloaded`
      : "Downloading update";

    return (
      <motion.div
        key={phase}
        className={`shell-update-control is-downloading ${updater.progressKnown ? "" : "is-indeterminate"}`.trim()}
        role="progressbar"
        aria-label={`Downloading Cortex Studio ${versionLabel}`.trim()}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={updater.progressKnown ? updater.progressPercent : undefined}
        aria-valuetext={progressLabel}
        data-tauri-drag-region="false"
        initial={{ opacity: 0, x: 5 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: -5 }}
        transition={transition}
      >
        <span className="shell-update-control-content">
          <Download className="shell-update-icon" aria-hidden="true" />
          <span className="shell-update-label">Downloading</span>
          {versionLabel ? <span className="shell-update-version">{versionLabel}</span> : null}
          <span className="shell-update-percent">
            {updater.progressKnown ? `${updater.progressPercent}%` : "···"}
          </span>
        </span>
        <span className="shell-update-progress" aria-hidden="true">
          <span
            className="shell-update-progress-fill"
            style={{ width: updater.progressKnown ? `${updater.progressPercent}%` : "38%" }}
          />
        </span>
      </motion.div>
    );
  }

  if (phase === UPDATE_PHASE.INSTALLING) {
    return (
      <motion.button
        key={phase}
        type="button"
        className="shell-update-control is-installing"
        disabled
        data-tauri-drag-region="false"
        initial={{ opacity: 0, x: 5 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: -5 }}
        transition={transition}
      >
        <LoaderCircle className="shell-update-icon shell-update-spinner" aria-hidden="true" />
        <span className="shell-update-label">Updating…</span>
      </motion.button>
    );
  }

  if (phase === UPDATE_PHASE.ERROR) {
    return (
      <motion.button
        key={phase}
        type="button"
        className="shell-update-control is-error"
        onClick={() => void updater.download()}
        title={updater.error || "Retry update download"}
        aria-label={`Update download failed. Retry download. ${updater.error || ""}`.trim()}
        data-tauri-drag-region="false"
        initial={{ opacity: 0, x: 5 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: -5 }}
        transition={transition}
      >
        <AlertCircle className="shell-update-icon" aria-hidden="true" />
        <span className="shell-update-label">Retry update</span>
      </motion.button>
    );
  }

  const readyHasError = Boolean(updater.error);
  const readyLabel = updater.installed
    ? "Restart Cortex"
    : readyHasError
      ? "Retry update"
      : "Restart to update";
  const readyTitle = readyHasError
    ? updater.error
    : updater.installed
      ? "Restart Cortex Studio"
      : `Install ${versionLabel} and restart Cortex Studio`;
  const ReadyIcon = readyHasError ? AlertCircle : RotateCw;

  return (
    <motion.button
      key={phase}
      type="button"
      className={`shell-update-control is-ready ${readyHasError ? "has-error" : ""}`.trim()}
      onClick={() => void updater.install()}
      title={readyTitle}
      aria-label={readyHasError ? `${readyLabel}. ${updater.error}` : updater.installed ? "Restart Cortex Studio" : `Restart to update Cortex Studio ${versionLabel}`.trim()}
      data-tauri-drag-region="false"
      initial={{ opacity: 0, x: 5 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -5 }}
      transition={transition}
    >
      <ReadyIcon className="shell-update-icon" aria-hidden="true" />
      <span className="shell-update-label">{readyLabel}</span>
    </motion.button>
  );
}

export default function UpdateToolbarControl() {
  const updater = useUpdateChecker();
  const phase = getUpdatePhase(updater);
  const prefersReducedMotion = useReducedMotion();
  const transition = prefersReducedMotion
    ? { duration: 0 }
    : { duration: 0.18, ease: [0.22, 1, 0.36, 1] };

  const liveMessage =
    phase === UPDATE_PHASE.READY
      ? updater.error
        ? updater.error
        : "Cortex Studio update downloaded. Restart to update."
      : phase === UPDATE_PHASE.INSTALLING
        ? "Updating Cortex Studio. The app will reopen automatically."
        : phase === UPDATE_PHASE.ERROR
          ? "Cortex Studio update download failed."
          : phase === UPDATE_PHASE.DOWNLOADING
            ? "Cortex Studio update is downloading."
            : "";

  return (
    <AnimatePresence initial={false}>
      {phase !== UPDATE_PHASE.HIDDEN ? (
        <motion.div
          className="shell-update-slot"
          data-tauri-drag-region="false"
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.96 }}
          transition={transition}
        >
          <span className="sr-only" aria-live="polite" aria-atomic="true">
            {liveMessage}
          </span>
          <AnimatePresence initial={false} mode="wait">
            <UpdateControlContent key={phase} phase={phase} updater={updater} transition={transition} />
          </AnimatePresence>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
