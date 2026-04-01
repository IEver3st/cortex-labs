import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { AlertCircle, Bug, ExternalLink, Loader2 } from "lucide-react";
import {
  buildBugReportPayload,
  collectBugReportEnvironment,
  formatEnvironmentSummary,
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
  const [environment, setEnvironment] = useState(null);
  const [environmentLoading, setEnvironmentLoading] = useState(false);
  const [openedAt, setOpenedAt] = useState("");

  const endpoint = getBugReportEndpoint();
  const environmentSummary = useMemo(() => formatEnvironmentSummary(environment), [environment]);

  const resetDraftState = () => {
    setDraft(EMPTY_DRAFT);
    setFieldErrors({});
    setFormError(endpoint ? "" : "Bug reporting is not configured in this build.");
    setSubmitResult(null);
    setOpenedAt(new Date().toISOString());
  };

  useEffect(() => {
    if (typeof document === "undefined") return;
    setPortalNode(document.body);
  }, []);

  useEffect(() => {
    if (!open) return;
    setFieldErrors({});
    setFormError(endpoint ? "" : "Bug reporting is not configured in this build.");
    setSubmitResult(null);
    if (!openedAt) {
      setOpenedAt(new Date().toISOString());
    }
    setEnvironmentLoading(true);

    let cancelled = false;
    collectBugReportEnvironment()
      .then((nextEnvironment) => {
        if (!cancelled) setEnvironment(nextEnvironment);
      })
      .catch(() => {
        if (!cancelled) setEnvironment(null);
      })
      .finally(() => {
        if (!cancelled) setEnvironmentLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [endpoint, open, openedAt]);

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
        environment,
      });
      const result = await submitBugReport(payload, endpoint);
      setSubmitResult(result);
      resetDraftState();
      onClose?.();
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
        >
          <motion.div
            className="bug-report-dialog"
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
                  <div className="bug-report-title">Report a bug</div>
                  <div className="bug-report-subtitle">
                    Submit a formatted GitHub issue without leaving the app.
                  </div>
                </div>
              </div>
              <button
                type="button"
                className="settings-mini"
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
                  <select
                    id="bug-report-priority"
                    className="bug-report-select"
                    value={draft.priority}
                    onChange={(event) => updateField("priority", event.currentTarget.value)}
                    disabled={submitting}
                  >
                    <option value="normal">Normal</option>
                    <option value="high">High</option>
                  </select>
                </div>

                <div className="bug-report-field">
                  <label className="bug-report-label">Diagnostics</label>
                  <label className="bug-report-toggle">
                    <input
                      type="checkbox"
                      checked={draft.includeConsoleLogs}
                      onChange={(event) => updateField("includeConsoleLogs", event.currentTarget.checked)}
                      disabled={submitting}
                    />
                    <span>Include recent console logs</span>
                  </label>
                </div>

                <div className="bug-report-field bug-report-field--full">
                  <div className="bug-report-label">Environment</div>
                  <div className="bug-report-environment">
                    {environmentLoading ? (
                      <div className="bug-report-environment-loading">
                        <Loader2 className="bug-report-spinner" />
                        <span>Collecting runtime details…</span>
                      </div>
                    ) : environmentSummary.length > 0 ? (
                      environmentSummary.map((item) => (
                        <div key={item.label} className="bug-report-environment-row">
                          <span>{item.label}</span>
                          <strong>{item.value}</strong>
                        </div>
                      ))
                    ) : (
                      <div className="bug-report-environment-loading">
                        <span>Environment details unavailable.</span>
                      </div>
                    )}
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
                  {submitting ? "Submitting..." : "Create GitHub Issue"}
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
