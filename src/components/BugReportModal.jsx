import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { AlertCircle, Bug, ExternalLink, Loader2, ScrollText } from "lucide-react";
import { Toggle } from "./ui/toggle.jsx";
import {
  buildBugReportPayload,
  getBugReportEndpoint,
  submitBugReport,
  validateBugReportDraft,
  BUG_REPORT_SUMMARY_MAX,
} from "../lib/bug-report";

const EMPTY_DRAFT = {
  summary: "",
  reproSteps: "",
  expectedBehavior: "",
  actualBehavior: "",
  priority: "normal",
  includeConsoleLogs: false,
  honeypot: "",
};

export default function BugReportModal({ open, onClose }) {
  const [portalNode, setPortalNode] = useState(null);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [submitResult, setSubmitResult] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [openedAt, setOpenedAt] = useState("");
  const summaryRef = useRef(null);
  const successTimerRef = useRef(null);

  const endpoint = useMemo(() => getBugReportEndpoint(), []);
  const notConfiguredMsg = "Bug reporting is not configured in this build.";

  const resetDraftState = useCallback(() => {
    setDraft(EMPTY_DRAFT);
    setFieldErrors({});
    setFormError(endpoint ? "" : notConfiguredMsg);
    setSubmitResult(null);
    setOpenedAt(new Date().toISOString());
  }, [endpoint, notConfiguredMsg]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    setPortalNode(document.body);
  }, []);

  useEffect(() => {
    if (!open) return;
    setFieldErrors({});
    setFormError(endpoint ? "" : notConfiguredMsg);
    setSubmitResult(null);
    setOpenedAt(new Date().toISOString());
  }, [endpoint, notConfiguredMsg, open]);

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  useEffect(() => {
    if (!open || submitting) return;
    const handler = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose?.();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, submitting, onClose]);

  useEffect(() => {
    if (open && !submitting && !submitResult) {
      summaryRef.current?.focus();
    }
  }, [open, submitting, submitResult]);

  useEffect(() => {
    return () => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
    };
  }, []);

  const updateField = (field, value) => {
    setDraft((prev) => ({ ...prev, [field]: value }));
    setFieldErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
    if (formError) setFormError("");
    if (submitResult) setSubmitResult(null);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    const validation = validateBugReportDraft(draft, { endpoint, openedAt });
    setFieldErrors(validation.fieldErrors);
    setFormError(validation.formError);
    setSubmitResult(null);
    if (validation.formError || Object.keys(validation.fieldErrors).length > 0) return;

    setSubmitting(true);
    try {
      const payload = await buildBugReportPayload(draft, {
        endpoint,
        openedAt,
      });
      const result = await submitBugReport(payload, endpoint);
      setSubmitResult(result);
      setDraft(EMPTY_DRAFT);
      setFieldErrors({});
      setFormError("");
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
      successTimerRef.current = setTimeout(() => {
        setSubmitResult(null);
        setOpenedAt("");
        onClose?.();
      }, 2000);
    } catch (error) {
      setFormError(
        error && typeof error === "object" && "message" in error
          ? error.message
          : "Failed to submit the bug report.",
      );
      if (error?.fieldErrors && typeof error.fieldErrors === "object") {
        setFieldErrors(error.fieldErrors);
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (!portalNode) return null;

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          className="bug-report-page"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          onClick={() => {
            if (!submitting) onClose?.();
          }}
        >
          <motion.div
            className="bug-report-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="bug-report-title"
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="bug-report-header">
              <div className="bug-report-title-wrap">
                <div className="bug-report-badge">
                  <Bug className="bug-report-badge-icon" />
                </div>
                <div>
                  <div id="bug-report-title" className="bug-report-title">Report a bug</div>
                  <div className="bug-report-subtitle">
                    Submit a formatted GitHub issue without leaving the app.
                  </div>
                </div>
              </div>
              <button
                type="button"
                className="settings-secondary"
                onClick={() => onClose?.()}
                disabled={submitting}
              >
                Close
              </button>
            </div>

            <form className="bug-report-form" onSubmit={handleSubmit}>
              <div className="bug-report-grid">
                <div className="bug-report-field bug-report-field--full">
                  <label className="bug-report-label" htmlFor="bug-report-summary">
                    Summary
                  </label>
                  <input
                    ref={summaryRef}
                    id="bug-report-summary"
                    className={`bug-report-input ${fieldErrors.summary ? "is-invalid" : ""}`}
                    value={draft.summary}
                    onChange={(event) => updateField("summary", event.currentTarget.value)}
                    maxLength={BUG_REPORT_SUMMARY_MAX}
                    placeholder="Short description of the problem"
                    disabled={submitting}
                  />
                  <div className="bug-report-meta-row">
                    <span className="bug-report-help">Required. Keep it concise.</span>
                    <span className="bug-report-counter">
                      {draft.summary.length}/{BUG_REPORT_SUMMARY_MAX}
                    </span>
                  </div>
                  {fieldErrors.summary ? <div className="bug-report-error">{fieldErrors.summary}</div> : null}
                </div>

                <div className="bug-report-field bug-report-field--full">
                  <label className="bug-report-label" htmlFor="bug-report-repro">
                    Repro steps
                  </label>
                  <textarea
                    id="bug-report-repro"
                    className={`bug-report-textarea ${fieldErrors.reproSteps ? "is-invalid" : ""}`}
                    value={draft.reproSteps}
                    onChange={(event) => updateField("reproSteps", event.currentTarget.value)}
                    placeholder={"1. Open ...\n2. Click ...\n3. Observe ..."}
                    rows={5}
                    disabled={submitting}
                  />
                  {fieldErrors.reproSteps ? <div className="bug-report-error">{fieldErrors.reproSteps}</div> : null}
                </div>

                <div className="bug-report-field">
                  <label className="bug-report-label" htmlFor="bug-report-expected">
                    Expected behavior
                  </label>
                  <textarea
                    id="bug-report-expected"
                    className={`bug-report-textarea ${fieldErrors.expectedBehavior ? "is-invalid" : ""}`}
                    value={draft.expectedBehavior}
                    onChange={(event) => updateField("expectedBehavior", event.currentTarget.value)}
                    placeholder="What should have happened?"
                    rows={4}
                    disabled={submitting}
                  />
                  {fieldErrors.expectedBehavior ? (
                    <div className="bug-report-error">{fieldErrors.expectedBehavior}</div>
                  ) : null}
                </div>

                <div className="bug-report-field">
                  <label className="bug-report-label" htmlFor="bug-report-actual">
                    Actual behavior
                  </label>
                  <textarea
                    id="bug-report-actual"
                    className={`bug-report-textarea ${fieldErrors.actualBehavior ? "is-invalid" : ""}`}
                    value={draft.actualBehavior}
                    onChange={(event) => updateField("actualBehavior", event.currentTarget.value)}
                    placeholder="What happened instead?"
                    rows={4}
                    disabled={submitting}
                  />
                  {fieldErrors.actualBehavior ? (
                    <div className="bug-report-error">{fieldErrors.actualBehavior}</div>
                  ) : null}
                </div>

                <div className="bug-report-field">
                  <label className="bug-report-label" htmlFor="bug-report-priority">
                    Priority
                  </label>
                  <div
                    className="bug-report-seg"
                    data-priority={draft.priority}
                    role="radiogroup"
                    aria-label="Priority"
                  >
                    <div className="bug-report-seg-thumb" />
                    <button
                      type="button"
                      className={`bug-report-seg-option ${draft.priority === "normal" ? "is-active" : ""}`}
                      role="radio"
                      aria-checked={draft.priority === "normal"}
                      onClick={() => updateField("priority", "normal")}
                      disabled={submitting}
                    >
                      Normal
                    </button>
                    <button
                      type="button"
                      className={`bug-report-seg-option ${draft.priority === "high" ? "is-active" : ""}`}
                      role="radio"
                      aria-checked={draft.priority === "high"}
                      onClick={() => updateField("priority", "high")}
                      disabled={submitting}
                    >
                      High
                    </button>
                  </div>
                </div>

                <div className="bug-report-field">
                  <label className="bug-report-label">Diagnostics</label>
                  <div className="bug-report-diag-row">
                    <ScrollText className="bug-report-diag-icon" />
                    <span className="bug-report-diag-label">Include recent console logs</span>
                    <Toggle
                      checked={draft.includeConsoleLogs}
                      onChange={(val) => updateField("includeConsoleLogs", val)}
                      ariaLabel="Include recent console logs"
                      disabled={submitting}
                    />
                  </div>
                </div>

              </div>

              <input
                className="bug-report-honeypot"
                tabIndex={-1}
                autoComplete="off"
                value={draft.honeypot}
                onChange={(event) => updateField("honeypot", event.currentTarget.value)}
                aria-hidden="true"
              />

              <div aria-live="polite" aria-atomic="true">
                {formError ? (
                  <div className="bug-report-status bug-report-status--error">
                    <AlertCircle className="bug-report-status-icon" />
                    <span>{formError}</span>
                  </div>
                ) : null}

                {submitResult?.ok ? (
                  <div className="bug-report-status bug-report-status--success">
                    <Bug className="bug-report-status-icon" />
                    <span>Issue #{submitResult.issueNumber} created successfully.</span>
                    <a
                      href={submitResult.issueUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="bug-report-link"
                    >
                      View issue
                      <ExternalLink className="bug-report-link-icon" />
                    </a>
                  </div>
                ) : null}
              </div>

              <div className="bug-report-actions">
                <button
                  type="button"
                  className="settings-secondary"
                  onClick={() => {
                    resetDraftState();
                    onClose?.();
                  }}
                  disabled={submitting}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="settings-primary"
                  disabled={submitting || !endpoint}
                >
                  {submitting ? (
                    <>
                      <Loader2 className="bug-report-spinner" />
                      Submitting...
                    </>
                  ) : "Create GitHub Issue"}
                </button>
              </div>
            </form>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    portalNode,
  );
}
