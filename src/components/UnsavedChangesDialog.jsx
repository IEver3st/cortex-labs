import { AnimatePresence, motion } from "motion/react";
// Same confirm dialog as Home's project delete (.home-modal in HomePage.css).
import "./HomePage.css";

/* Asks before closing tabs, or the window, while a tab holds siren or ELS
   edits that aren't written to their carcols.meta or VCF yet. `pending` is { names, scope, run }:
   the tabs holding edits, "tab", "tabs" or "window", and the close to run. */

export default function UnsavedChangesDialog({ pending, onCancel, onConfirm }) {
  const names = pending?.names || [];
  const closing = pending?.scope === "window" ? "Closing Cortex Studio" : names.length > 1 ? "Closing the tabs" : "Closing the tab";
  return (
    <AnimatePresence>
      {pending ? (
        <motion.div
          className="home-modal-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14 }}
          onClick={onCancel}
        >
          <motion.div
            className="home-modal home-modal--confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="unsaved-close-title"
            aria-describedby="unsaved-close-desc"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") onCancel();
            }}
          >
            <div className="home-modal-header">
              <h3 className="cx-display" id="unsaved-close-title">Unsaved siren edits</h3>
            </div>
            <div className="home-modal-body">
              {names.length === 1 ? (
                <p className="home-modal-copy" id="unsaved-close-desc">
                  <strong>{names[0]}</strong> has siren edits that aren't saved to a carcols.meta or ELS VCF yet. {closing} discards them.
                </p>
              ) : (
                <>
                  <p className="home-modal-copy" id="unsaved-close-desc">
                    These tabs have siren edits that aren't saved to a carcols.meta or ELS VCF yet. {closing} discards the edits.
                  </p>
                  <ul className="home-modal-names">
                    {names.slice(0, 6).map((name, index) => (
                      <li key={`${index}:${name}`}>{name}</li>
                    ))}
                    {names.length > 6 ? <li className="home-modal-names-more">and {names.length - 6} more</li> : null}
                  </ul>
                </>
              )}
            </div>
            <div className="home-modal-footer">
              <button type="button" className="cx-btn is-quiet" onClick={onCancel} autoFocus>
                Keep editing
              </button>
              <button type="button" className="cx-btn is-danger" onClick={onConfirm}>
                {pending.scope === "window" ? "Discard and quit" : "Discard and close"}
              </button>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
