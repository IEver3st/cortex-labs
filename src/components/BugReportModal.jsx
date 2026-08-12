import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  AlertCircle,
  Bug,
  ExternalLink,
  Lightbulb,
  Loader2,
  MonitorCog,
  ScrollText,
  X,
} from "lucide-react";
import { Toggle } from "./ui/toggle.jsx";
import {
  buildBugReportPayload,
  getBugReportEndpoint,
  submitBugReport,
  validateBugReportDraft,
  BUG_REPORT_SUMMARY_MAX,
} from "../lib/bug-report";

const EMPTY_DRAFT = {
  reportType: "bug",
  summary: "",
  reproSteps: "",
  expectedBehavior: "",
  actualBehavior: "",
  featureProblem: "",
  featureOutcome: "",
  featureValue: "",
  priority: "normal",
  includeConsoleLogs: false,
  honeypot: "",
};

function normalizeReportType(value) {
  return value === "feature" ? "feature" : "bug";
}

function createEmptyDraft(reportType = "bug") {
  return { ...EMPTY_DRAFT, reportType: normalizeReportType(reportType) };
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([tabindex='-1'])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export default function BugReportModal({ open, onClose, initialType = "bug" }) {
  const [portalNode, setPortalNode] = useState(null);
  const [draft, setDraft] = useState(() => createEmptyDraft(initialType));
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [submitResult, setSubmitResult] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [openedAt, setOpenedAt] = useState("");
  const dialogRef = useRef(null);
  const summaryRef = useRef(null);
  const returnFocusRef = useRef(null);
  const successTimerRef = useRef(null);
  const reduceMotion = useReducedMotion();

  const endpoint = useMemo(() => getBugReportEndpoint(), []);
  const notConfiguredMsg = "Feedback submission is not configured in this build.";
  const isFeature = draft.reportType === "feature";
  const ReportIcon = isFeature ? Lightbulb : Bug;
  const reportName = isFeature ? "feature request" : "bug report";

  const resetDraftState = useCallback(() => {
    setDraft(createEmptyDraft(initialType));
    setFieldErrors({});
    setFormError(endpoint ? "" : notConfiguredMsg);
    setSubmitResult(null);
    setOpenedAt(new Date().toISOString());
  }, [endpoint, initialType, notConfiguredMsg]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    setPortalNode(document.body);
  }, []);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement;
    setDraft((prev) => ({ ...prev, reportType: normalizeReportType(initialType) }));
    setFieldErrors({});
    setFormError(endpoint ? "" : notConfiguredMsg);
    setSubmitResult(null);
    setOpenedAt(new Date().toISOString());

    return () => {
      const returnTarget = returnFocusRef.current;
      if (returnTarget instanceof HTMLElement && document.contains(returnTarget)) {
        returnTarget.focus();
      }
    };
  }, [endpoint, initialType, notConfiguredMsg, open]);

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
    const handler = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose?.();
        return;
      }

      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll(FOCUSABLE_SELECTOR) || []);
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
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

  const updateReportType = (reportType) => {
    const nextType = normalizeReportType(reportType);
    if (nextType === draft.reportType) return;
    setDraft((prev) => ({ ...prev, reportType: nextType }));
    setFieldErrors({});
    setFormError(endpoint ? "" : notConfiguredMsg);
    setSubmitResult(null);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    const validation = validateBugReportDraft(draft, { endpoint, openedAt });
    setFieldErrors(validation.fieldErrors);
    setFormError(validation.formError);
    setSubmitResult(null);
    if (validation.formError || Object.keys(validation.fieldErrors).length > 0) {
      requestAnimationFrame(() => {
        dialogRef.current?.querySelector("[aria-invalid='true']")?.focus();
      });
      return;
    }

    setSubmitting(true);
    try {
      const payload = await buildBugReportPayload(draft, {
        endpoint,
        openedAt,
      });
      const result = await submitBugReport(payload, endpoint);
      setSubmitResult(result);
      setDraft(createEmptyDraft(draft.reportType));
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
          : `Failed to submit the ${reportName}.`,
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
          transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}
          onClick={() => {
            if (!submitting) onClose?.();
          }}
        >
          <motion.div
            ref={dialogRef}
            className="bug-report-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="bug-report-title"
            aria-describedby="bug-report-subtitle"
            tabIndex={-1}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.99 }}
            transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="bug-report-header">
              <div className="bug-report-title-wrap">
                <ReportIcon className="bug-report-badge-icon" aria-hidden="true" />
                <div>
                  <div className="bug-report-eyebrow">Cortex Studio feedback</div>
                  <h2 id="bug-report-title" className="bug-report-title">Send feedback</h2>
                  <p id="bug-report-subtitle" className="bug-report-subtitle">
                    Create a structured GitHub issue without leaving your workspace.
                  </p>
                </div>
              </div>
              <button
                type="button"
                className="bug-report-close"
                aria-label="Close feedback dialog"
                title="Close"
                onClick={() => onClose?.()}
                disabled={submitting}
              >
                <X aria-hidden="true" />
              </button>
            </header>

            <form className="bug-report-form" onSubmit={handleSubmit} noValidate>
              <div className="bug-report-content">
                <fieldset className="bug-report-type-fieldset">
                  <legend className="bug-report-label">What are you sending?</legend>
                  <div className="bug-report-type-switch" role="radiogroup" aria-label="Feedback type">
                    <button
                      type="button"
                      className={`bug-report-type-option ${!isFeature ? "is-active" : ""}`}
                      role="radio"
                      aria-checked={!isFeature}
                      onClick={() => updateReportType("bug")}
                      disabled={submitting}
                    >
                      <Bug aria-hidden="true" />
                      <span>
                        <strong>Bug report</strong>
                        <small>Something is not working</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`bug-report-type-option ${isFeature ? "is-active" : ""}`}
                      role="radio"
                      aria-checked={isFeature}
                      onClick={() => updateReportType("feature")}
                      disabled={submitting}
                    >
                      <Lightbulb aria-hidden="true" />
                      <span>
                        <strong>Feature request</strong>
                        <small>Suggest a workflow improvement</small>
                      </span>
                    </button>
                  </div>
                </fieldset>

                <div className="bug-report-guidance">
                  <ReportIcon aria-hidden="true" />
                  <span>
                    {isFeature
                      ? "Start with the problem. A useful outcome matters more than a finished solution."
                      : "Tell us what you did, what you expected, and what Cortex Studio did instead."}
                  </span>
                </div>

                <div className="bug-report-grid">
                  <div className="bug-report-field bug-report-field--full">
                    <label className="bug-report-label" htmlFor="bug-report-summary">
                      {isFeature ? "Request title" : "Bug summary"}
                    </label>
                    <input
                      ref={summaryRef}
                      id="bug-report-summary"
                      className={`bug-report-input ${fieldErrors.summary ? "is-invalid" : ""}`}
                      value={draft.summary}
                      onChange={(event) => updateField("summary", event.currentTarget.value)}
                      maxLength={BUG_REPORT_SUMMARY_MAX}
                      placeholder={isFeature ? "A concise name for the improvement" : "A concise description of the problem"}
                      disabled={submitting}
                      aria-invalid={Boolean(fieldErrors.summary)}
                      aria-describedby={fieldErrors.summary ? "bug-report-summary-error" : "bug-report-summary-help"}
                    />
                    <div className="bug-report-meta-row" id="bug-report-summary-help">
                      <span className="bug-report-help">Required · {isFeature ? "Name the outcome" : "Name the failure"}</span>
                      <span className="bug-report-counter">
                        {draft.summary.length}/{BUG_REPORT_SUMMARY_MAX}
                      </span>
                    </div>
                    {fieldErrors.summary ? (
                      <div className="bug-report-error" id="bug-report-summary-error">{fieldErrors.summary}</div>
                    ) : null}
                  </div>

                  {isFeature ? (
                    <>
                      <div className="bug-report-field bug-report-field--full">
                        <label className="bug-report-label" htmlFor="bug-report-feature-problem">
                          Problem or opportunity
                        </label>
                        <textarea
                          id="bug-report-feature-problem"
                          className={`bug-report-textarea bug-report-textarea--wide ${fieldErrors.featureProblem ? "is-invalid" : ""}`}
                          value={draft.featureProblem}
                          onChange={(event) => updateField("featureProblem", event.currentTarget.value)}
                          placeholder="What is difficult, missing, or taking too many steps today?"
                          rows={4}
                          disabled={submitting}
                          aria-invalid={Boolean(fieldErrors.featureProblem)}
                          aria-describedby={fieldErrors.featureProblem ? "bug-report-feature-problem-error" : undefined}
                        />
                        {fieldErrors.featureProblem ? (
                          <div className="bug-report-error" id="bug-report-feature-problem-error">{fieldErrors.featureProblem}</div>
                        ) : null}
                      </div>

                      <div className="bug-report-field">
                        <label className="bug-report-label" htmlFor="bug-report-feature-outcome">
                          Desired outcome
                        </label>
                        <textarea
                          id="bug-report-feature-outcome"
                          className={`bug-report-textarea ${fieldErrors.featureOutcome ? "is-invalid" : ""}`}
                          value={draft.featureOutcome}
                          onChange={(event) => updateField("featureOutcome", event.currentTarget.value)}
                          placeholder="What should you be able to accomplish?"
                          rows={3}
                          disabled={submitting}
                          aria-invalid={Boolean(fieldErrors.featureOutcome)}
                          aria-describedby={fieldErrors.featureOutcome ? "bug-report-feature-outcome-error" : undefined}
                        />
                        {fieldErrors.featureOutcome ? (
                          <div className="bug-report-error" id="bug-report-feature-outcome-error">{fieldErrors.featureOutcome}</div>
                        ) : null}
                      </div>

                      <div className="bug-report-field">
                        <label className="bug-report-label" htmlFor="bug-report-feature-value">
                          Why it matters
                        </label>
                        <textarea
                          id="bug-report-feature-value"
                          className={`bug-report-textarea ${fieldErrors.featureValue ? "is-invalid" : ""}`}
                          value={draft.featureValue}
                          onChange={(event) => updateField("featureValue", event.currentTarget.value)}
                          placeholder="Who benefits, and what becomes faster or clearer?"
                          rows={3}
                          disabled={submitting}
                          aria-invalid={Boolean(fieldErrors.featureValue)}
                          aria-describedby={fieldErrors.featureValue ? "bug-report-feature-value-error" : undefined}
                        />
                        {fieldErrors.featureValue ? (
                          <div className="bug-report-error" id="bug-report-feature-value-error">{fieldErrors.featureValue}</div>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="bug-report-field bug-report-field--full">
                        <label className="bug-report-label" htmlFor="bug-report-repro">
                          Steps to reproduce
                        </label>
                        <textarea
                          id="bug-report-repro"
                          className={`bug-report-textarea bug-report-textarea--wide ${fieldErrors.reproSteps ? "is-invalid" : ""}`}
                          value={draft.reproSteps}
                          onChange={(event) => updateField("reproSteps", event.currentTarget.value)}
                          placeholder={"1. Open ...\n2. Choose ...\n3. Observe ..."}
                          rows={4}
                          disabled={submitting}
                          aria-invalid={Boolean(fieldErrors.reproSteps)}
                          aria-describedby={fieldErrors.reproSteps ? "bug-report-repro-error" : undefined}
                        />
                        {fieldErrors.reproSteps ? (
                          <div className="bug-report-error" id="bug-report-repro-error">{fieldErrors.reproSteps}</div>
                        ) : null}
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
                          rows={3}
                          disabled={submitting}
                          aria-invalid={Boolean(fieldErrors.expectedBehavior)}
                          aria-describedby={fieldErrors.expectedBehavior ? "bug-report-expected-error" : undefined}
                        />
                        {fieldErrors.expectedBehavior ? (
                          <div className="bug-report-error" id="bug-report-expected-error">{fieldErrors.expectedBehavior}</div>
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
                          rows={3}
                          disabled={submitting}
                          aria-invalid={Boolean(fieldErrors.actualBehavior)}
                          aria-describedby={fieldErrors.actualBehavior ? "bug-report-actual-error" : undefined}
                        />
                        {fieldErrors.actualBehavior ? (
                          <div className="bug-report-error" id="bug-report-actual-error">{fieldErrors.actualBehavior}</div>
                        ) : null}
                      </div>
                    </>
                  )}

                  <div className="bug-report-field">
                    <span className="bug-report-label" id="bug-report-priority-label">
                      {isFeature ? "Importance" : "Priority"}
                    </span>
                    <div
                      className="bug-report-seg"
                      data-priority={draft.priority}
                      role="radiogroup"
                      aria-labelledby="bug-report-priority-label"
                    >
                      <div className="bug-report-seg-thumb" aria-hidden="true" />
                      <button
                        type="button"
                        className={`bug-report-seg-option ${draft.priority === "normal" ? "is-active" : ""}`}
                        role="radio"
                        aria-checked={draft.priority === "normal"}
                        onClick={() => updateField("priority", "normal")}
                        disabled={submitting}
                      >
                        {isFeature ? "Standard" : "Normal"}
                      </button>
                      <button
                        type="button"
                        className={`bug-report-seg-option ${draft.priority === "high" ? "is-active" : ""}`}
                        role="radio"
                        aria-checked={draft.priority === "high"}
                        onClick={() => updateField("priority", "high")}
                        disabled={submitting}
                      >
                        {isFeature ? "Important" : "High"}
                      </button>
                    </div>
                  </div>

                  <div className="bug-report-field">
                    <span className="bug-report-label">{isFeature ? "Submission context" : "Diagnostics"}</span>
                    {isFeature ? (
                      <div className="bug-report-context-row">
                        <MonitorCog className="bug-report-diag-icon" aria-hidden="true" />
                        <span>
                          <strong>App context included</strong>
                          <small>Version and device details only</small>
                        </span>
                      </div>
                    ) : (
                      <div className="bug-report-diag-row">
                        <ScrollText className="bug-report-diag-icon" aria-hidden="true" />
                        <span className="bug-report-diag-label">Include recent console logs</span>
                        <Toggle
                          checked={draft.includeConsoleLogs}
                          onChange={(value) => updateField("includeConsoleLogs", value)}
                          ariaLabel="Include recent console logs"
                          disabled={submitting}
                        />
                      </div>
                    )}
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
                      <AlertCircle className="bug-report-status-icon" aria-hidden="true" />
                      <span>{formError}</span>
                    </div>
                  ) : null}

                  {submitResult?.ok ? (
                    <div className="bug-report-status bug-report-status--success">
                      <ReportIcon className="bug-report-status-icon" aria-hidden="true" />
                      <span>{isFeature ? "Feature request" : "Bug report"} #{submitResult.issueNumber} created.</span>
                      <a
                        href={submitResult.issueUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="bug-report-link"
                      >
                        View issue
                        <ExternalLink className="bug-report-link-icon" aria-hidden="true" />
                      </a>
                    </div>
                  ) : null}
                </div>
              </div>

              <footer className="bug-report-actions">
                <div className="bug-report-submit-note">
                  <ReportIcon aria-hidden="true" />
                  <span>
                    <strong>Ready to send?</strong>
                    Your report is added to the Cortex Labs issue tracker.
                  </span>
                </div>
                <div className="bug-report-action-buttons">
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
                        <Loader2 className="bug-report-spinner" aria-hidden="true" />
                        Submitting...
                      </>
                    ) : `Submit ${reportName}`}
                  </button>
                </div>
              </footer>
            </form>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    portalNode,
  );
}
