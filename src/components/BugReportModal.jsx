import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Copy,
  ExternalLink,
  LoaderCircle,
  TriangleAlert,
  X,
} from "lucide-react";
import { Toggle } from "./ui/toggle.jsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { loadPrefs } from "../lib/prefs";
import { getConsoleLogEntries } from "../lib/console-log-buffer.js";
import {
  BUG_REPORT_AREAS,
  BUG_REPORT_DETAILS_MAX,
  BUG_REPORT_DETAILS_MIN,
  BUG_REPORT_FREQUENCIES,
  BUG_REPORT_SUMMARY_MAX,
  BUG_REPORT_SUMMARY_MIN,
  buildBugReportMarkdown,
  buildBugReportPayload,
  collectBugReportEnvironment,
  formatEnvironmentSummary,
  getBugReportEndpoint,
  hasFeedbackDraftContent,
  hasFeedbackDraftText,
  loadFeedbackDrafts,
  normalizeFeedbackDraftStore,
  resolveBugReportEndpoint,
  saveFeedbackDrafts,
  submitBugReport,
  validateBugReportDraft,
} from "../lib/bug-report";
import "./BugReportModal.css";

const AREA_UNSURE = "__unsure";

const NOT_CONFIGURED_ERROR = "Feedback submission is not configured in this build.";
const DRAFT_SAVE_DELAY_MS = 350;
// Same public tracker the README links to; used only when this build cannot submit.
const NEW_ISSUE_URL = "https://github.com/IEver3st/cortex-labs/issues/new";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([tabindex='-1'])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const TYPES = {
  bug: {
    label: "Bug report",
    hint: "Something is broken or wrong",
    noun: "bug report",
    priorityLabel: "Priority",
    priority: { normal: "Normal", high: "High" },
    fields: [
      {
        key: "reproSteps",
        label: "Steps to reproduce",
        rows: 4,
        placeholder: "1. Open a Livery tab and load a .yft\n2. Pick a PSD texture\n3. Edit the PSD and save",
      },
      {
        key: "expectedBehavior",
        label: "What you expected",
        rows: 3,
        placeholder: "The preview updates with the saved texture.",
      },
      {
        key: "actualBehavior",
        label: "What happened instead",
        rows: 3,
        placeholder: "The preview stays on the old texture until the tab is reopened.",
      },
    ],
    summaryLabel: "Summary",
    summaryPlaceholder: "Texture reload ignores PSD saves",
  },
  feature: {
    label: "Feature request",
    hint: "An idea that would help your workflow",
    noun: "feature request",
    priorityLabel: "Importance",
    priority: { normal: "Nice to have", high: "Important" },
    fields: [
      {
        key: "featureProblem",
        label: "Problem or opportunity",
        rows: 4,
        placeholder: "What is slow, missing, or takes too many steps today?",
      },
      {
        key: "featureOutcome",
        label: "What you want to be able to do",
        rows: 3,
        placeholder: "Save a camera angle set and reuse it in another workspace.",
      },
      {
        key: "featureValue",
        label: "Why it matters",
        rows: 3,
        placeholder: "Who benefits, and what gets faster or clearer?",
      },
    ],
    summaryLabel: "Title",
    summaryPlaceholder: "Reusable camera angle sets",
  },
};

const TYPE_ORDER = ["bug", "feature"];

function normalizeReportType(value) {
  return value === "feature" ? "feature" : "bug";
}

function errorMessage(error) {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object" && typeof error.message === "string" && error.message.trim()) {
    return error.message.trim();
  }
  return "";
}

function defaultIncludeLogs() {
  return loadPrefs()?.defaults?.feedbackIncludeLogs === true;
}

export default function BugReportModal({ open, onClose, initialType = "bug", initialArea = "" }) {
  const uid = useId();
  const ids = useMemo(() => ({
    title: `${uid}-title`,
    sub: `${uid}-sub`,
    typeLabel: `${uid}-type`,
    unavailable: `${uid}-unavailable`,
    disclosure: `${uid}-disclosure`,
    footNote: `${uid}-footnote`,
  }), [uid]);
  const reduceMotion = useReducedMotion();
  const [endpoint, setEndpoint] = useState(() => getBugReportEndpoint());
  const canSubmit = Boolean(endpoint);

  // The desktop app only knows on the native side whether this build can send.
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    resolveBugReportEndpoint().then((resolved) => {
      if (live) setEndpoint(resolved);
    });
    return () => {
      live = false;
    };
  }, [open]);

  // Resolved during the first render so the dialog content (and its initial
  // focus target) exists in the same commit that opens it.
  const [portalNode] = useState(() => (typeof document !== "undefined" ? document.body : null));
  const [reportType, setReportType] = useState(() => normalizeReportType(initialType));
  const [drafts, setDrafts] = useState(() => normalizeFeedbackDraftStore(null).drafts);
  const [honeypot, setHoneypot] = useState("");
  const [logsDefault, setLogsDefault] = useState(false);
  const [logCount, setLogCount] = useState(0);
  // undefined while reading, null when it could not be read.
  const [environment, setEnvironment] = useState(undefined);
  const [openedAt, setOpenedAt] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitError, setSubmitError] = useState("");
  const [status, setStatus] = useState("idle");
  const [result, setResult] = useState(null);
  const [showDetails, setShowDetails] = useState(false);
  const [copyState, setCopyState] = useState("idle");
  const [draftSaveFailed, setDraftSaveFailed] = useState(false);
  const [discardArmed, setDiscardArmed] = useState(false);

  const dialogRef = useRef(null);
  const summaryRef = useRef(null);
  const successFocusRef = useRef(null);
  const returnFocusRef = useRef(null);
  const draftsRef = useRef(drafts);
  const hydratedRef = useRef(false);
  const saveTimerRef = useRef(0);
  const discardTimerRef = useRef(0);
  const onCloseRef = useRef(onClose);
  const openArgsRef = useRef({ initialType, initialArea });
  onCloseRef.current = onClose;
  openArgsRef.current = { initialType, initialArea };
  draftsRef.current = drafts;

  const submitting = status === "submitting";
  const succeeded = status === "success";
  const type = TYPES[reportType];
  const draft = drafts[reportType];
  const includeConsoleLogs = reportType === "bug" && (draft.includeConsoleLogs ?? logsDefault);
  const draftHasContent = hasFeedbackDraftContent(reportType, draft);
  const environmentRows = useMemo(() => formatEnvironmentSummary(environment), [environment]);

  const flushDraftSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = 0;
    }
    if (!hydratedRef.current) return true;
    const ok = saveFeedbackDrafts(draftsRef.current);
    setDraftSaveFailed(!ok);
    return ok;
  }, []);

  // Each open restores drafts from storage and starts a fresh anti-abuse window.
  useEffect(() => {
    if (!open) return undefined;
    const { initialType: openType, initialArea: openArea } = openArgsRef.current;
    returnFocusRef.current = document.activeElement;
    const stored = loadFeedbackDrafts().drafts;
    const area = BUG_REPORT_AREAS.some((entry) => entry.value === openArea) ? openArea : "";
    // An unwritten draft follows the workflow it was opened from; a draft the
    // user has started keeps the area they chose.
    if (area) {
      for (const key of TYPE_ORDER) {
        if (!stored[key].area || !hasFeedbackDraftText(key, stored[key])) {
          stored[key] = { ...stored[key], area };
        }
      }
    }
    hydratedRef.current = true;
    setDrafts(stored);
    setReportType(normalizeReportType(openType));
    setHoneypot("");
    setLogsDefault(defaultIncludeLogs());
    setLogCount(getConsoleLogEntries().length);
    setFieldErrors({});
    setSubmitError("");
    setStatus("idle");
    setResult(null);
    setShowDetails(false);
    setCopyState("idle");
    setDiscardArmed(false);
    setOpenedAt(new Date().toISOString());
    setEnvironment(undefined);

    let cancelled = false;
    collectBugReportEnvironment()
      .then((env) => {
        if (!cancelled) setEnvironment(env);
      })
      .catch(() => {
        if (!cancelled) setEnvironment(null);
      });

    return () => {
      cancelled = true;
      flushDraftSave();
      hydratedRef.current = false;
      setStatus("idle");
      setResult(null);
      const target = returnFocusRef.current;
      if (target instanceof HTMLElement && document.contains(target)) target.focus();
    };
  }, [open, flushDraftSave]);

  // Shell may reopen an already open dialog with another type.
  useEffect(() => {
    if (!open || status !== "idle") return;
    setReportType(normalizeReportType(initialType));
    // Deliberately keyed on initialType alone: only an incoming request switches type.
  }, [initialType]);

  useEffect(() => {
    if (!open || !hydratedRef.current) return undefined;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = 0;
      setDraftSaveFailed(!saveFeedbackDrafts(draftsRef.current));
    }, DRAFT_SAVE_DELAY_MS);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = 0;
    };
  }, [drafts, open]);

  useEffect(() => () => {
    if (discardTimerRef.current) clearTimeout(discardTimerRef.current);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const frame = requestAnimationFrame(() => {
      const target = succeeded ? successFocusRef.current : summaryRef.current;
      (target || dialogRef.current)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, succeeded]);

  const requestClose = useCallback(() => {
    if (submitting) return;
    onCloseRef.current?.();
  }, [submitting]);

  const submissionDraft = useCallback(() => ({
    ...draftsRef.current[reportType],
    reportType,
    includeConsoleLogs,
    honeypot,
  }), [reportType, includeConsoleLogs, honeypot]);

  const focusFirstInvalid = () => {
    requestAnimationFrame(() => {
      dialogRef.current?.querySelector("[aria-invalid='true']")?.focus();
    });
  };

  const updateDraft = (field, value) => {
    setDrafts((prev) => ({ ...prev, [reportType]: { ...prev[reportType], [field]: value } }));
    setFieldErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
    setCopyState("idle");
    setDiscardArmed(false);
  };

  const selectType = (next) => {
    const nextType = normalizeReportType(next);
    if (nextType === reportType) return;
    setReportType(nextType);
    setFieldErrors({});
    setSubmitError("");
    setCopyState("idle");
    setDiscardArmed(false);
  };

  const handleTypeKeyDown = (event) => {
    const keys = ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const next = reportType === "bug" ? "feature" : "bug";
    selectType(next);
    requestAnimationFrame(() => {
      dialogRef.current?.querySelector(`[data-fb-type='${next}']`)?.focus();
    });
  };

  const discardDraft = () => {
    if (!discardArmed) {
      setDiscardArmed(true);
      if (discardTimerRef.current) clearTimeout(discardTimerRef.current);
      discardTimerRef.current = setTimeout(() => setDiscardArmed(false), 4000);
      return;
    }
    if (discardTimerRef.current) clearTimeout(discardTimerRef.current);
    setDiscardArmed(false);
    const empty = normalizeFeedbackDraftStore(null).drafts[reportType];
    const next = { ...draftsRef.current, [reportType]: empty };
    draftsRef.current = next;
    setDrafts(next);
    setDraftSaveFailed(!saveFeedbackDrafts(next));
    setFieldErrors({});
    setSubmitError("");
    setCopyState("idle");
    summaryRef.current?.focus();
  };

  const handleCopyMarkdown = async () => {
    setCopyState("working");
    try {
      const { fieldErrors: errors, markdown } = await buildBugReportMarkdown(submissionDraft(), {
        environment: environment || undefined,
      });
      if (Object.keys(errors).length > 0) {
        setFieldErrors(errors);
        setCopyState("invalid");
        focusFirstInvalid();
        return;
      }
      await navigator.clipboard.writeText(markdown);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  const handleSubmit = async (event) => {
    event?.preventDefault();
    if (submitting || succeeded || !canSubmit) return;
    const current = submissionDraft();
    const validation = validateBugReportDraft(current, { endpoint, openedAt });
    setFieldErrors(validation.fieldErrors);
    setCopyState("idle");
    if (Object.keys(validation.fieldErrors).length > 0) {
      setSubmitError("");
      focusFirstInvalid();
      return;
    }
    if (validation.formError) {
      setSubmitError(validation.formError);
      return;
    }

    setSubmitError("");
    setStatus("submitting");
    try {
      const payload = await buildBugReportPayload(current, {
        endpoint,
        openedAt,
        environment: environment || undefined,
      });
      const response = await submitBugReport(payload, endpoint);
      const cleared = {
        ...draftsRef.current,
        [reportType]: normalizeFeedbackDraftStore(null).drafts[reportType],
      };
      draftsRef.current = cleared;
      setDrafts(cleared);
      setDraftSaveFailed(!saveFeedbackDrafts(cleared));
      setResult({
        reportType,
        issueNumber: response?.issueNumber ?? null,
        issueUrl: typeof response?.issueUrl === "string" ? response.issueUrl : "",
      });
      setStatus("success");
    } catch (error) {
      if (error?.fieldErrors && typeof error.fieldErrors === "object") {
        setFieldErrors(error.fieldErrors);
      }
      const detail = errorMessage(error);
      setSubmitError(detail || "No error details were returned.");
      setStatus("idle");
    }
  };

  const sendAnother = () => {
    setResult(null);
    setFieldErrors({});
    setSubmitError("");
    setCopyState("idle");
    setOpenedAt(new Date().toISOString());
    setStatus("idle");
    requestAnimationFrame(() => summaryRef.current?.focus());
  };

  const handleKeyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      requestClose();
      return;
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (!succeeded) handleSubmit();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll(FOCUSABLE_SELECTOR) || [])
      .filter((node) => !node.closest("[data-fb-hidden]"));
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (!dialogRef.current?.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && (active === first || active === dialogRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  // Listen on the document in the capture phase so Esc, Ctrl+Enter, and the
  // Tab trap still apply when focus has drifted outside the dialog.
  const keyHandlerRef = useRef(handleKeyDown);
  keyHandlerRef.current = handleKeyDown;
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => keyHandlerRef.current(event);
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  if (!portalNode) return null;

  const resultType = TYPES[result?.reportType || reportType];
  const showUnavailable = !canSubmit && !succeeded;
  const submitLabel = submitting ? "Sending…" : `Send ${type.noun}`;
  let footNote = "";
  if (draftSaveFailed) footNote = "Draft not saved. Local storage is unavailable.";
  else if (draftHasContent) footNote = "Draft saved on this device.";
  else if (!canSubmit) footNote = "Sending is unavailable in this build.";

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fb-scrim"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.14 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) requestClose();
          }}
        >
          <motion.div
            ref={dialogRef}
            className={`fb-dialog is-${reportType}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby={ids.title}
            aria-describedby={ids.sub}
            aria-busy={submitting || undefined}
            tabIndex={-1}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
            transition={{ duration: reduceMotion ? 0 : 0.16, ease: [0.2, 0.8, 0.2, 1] }}
          >
            <header className="fb-head">
              <div className="fb-head-copy">
                <h2 id={ids.title} className="cx-display fb-title">Send feedback</h2>
                <p id={ids.sub} className="fb-sub">
                  Each report opens an issue on the Cortex Studio GitHub tracker.
                </p>
              </div>
              <button
                type="button"
                className="cx-icon-btn fb-close"
                aria-label="Close feedback"
                title={submitting ? "Wait for sending to finish" : "Close (Esc)"}
                onClick={requestClose}
                disabled={submitting}
              >
                <X aria-hidden="true" />
              </button>
            </header>

            {succeeded ? (
              <>
                <div className="fb-body fb-body--done">
                  <div className="fb-done" role="status">
                    <CircleCheck className="fb-done-icon" aria-hidden="true" />
                    <h3 className="fb-done-title">{resultType.label} sent</h3>
                    <p className="fb-done-text">
                      {result?.issueNumber != null ? (
                        <>
                          Filed as issue <span className="cx-display fb-done-number">#{result.issueNumber}</span>.
                          Replies and status changes appear on the issue.
                        </>
                      ) : (
                        "The tracker accepted the report."
                      )}
                    </p>
                    {result?.issueUrl ? (
                      <>
                        <a
                          ref={successFocusRef}
                          className="cx-btn fb-done-link"
                          href={result.issueUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open issue
                          <ExternalLink aria-hidden="true" />
                        </a>
                        <span className="fb-done-url" title={result.issueUrl}>{result.issueUrl}</span>
                      </>
                    ) : null}
                  </div>
                </div>
                <footer className="fb-foot">
                  <div className="fb-foot-row">
                    <span className="fb-foot-note" />
                    <div className="fb-actions">
                      <button type="button" className="cx-btn" onClick={sendAnother}>
                        Send another
                      </button>
                      <button
                        ref={result?.issueUrl ? undefined : successFocusRef}
                        type="button"
                        className="cx-btn is-primary"
                        onClick={requestClose}
                      >
                        Done
                      </button>
                    </div>
                  </div>
                </footer>
              </>
            ) : (
              <form className="fb-form" onSubmit={handleSubmit} noValidate>
                <fieldset className="fb-fieldset" disabled={submitting}>
                <div className="fb-body">
                  <aside className="fb-aside">
                    <div className="fb-group">
                      <span className="cx-label" id={ids.typeLabel}>Type</span>
                      <div
                        className="fb-types"
                        role="radiogroup"
                        aria-labelledby={ids.typeLabel}
                        onKeyDown={handleTypeKeyDown}
                      >
                        {TYPE_ORDER.map((key) => {
                          const option = TYPES[key];
                          const selected = key === reportType;
                          return (
                            <button
                              key={key}
                              type="button"
                              role="radio"
                              aria-checked={selected}
                              tabIndex={selected ? 0 : -1}
                              data-fb-type={key}
                              className={`fb-type is-${key} ${selected ? "is-selected" : ""}`}
                              onClick={() => selectType(key)}
                            >
                              <span className="fb-type-marker" aria-hidden="true" />
                              <span className="fb-type-copy">
                                <span className="fb-type-label">{option.label}</span>
                                <span className="fb-type-hint">{option.hint}</span>
                              </span>
                              {hasFeedbackDraftContent(key, drafts[key]) && !selected ? (
                                <span className="fb-type-draft">Draft</span>
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="fb-group">
                      <label className="cx-label" htmlFor={`${uid}-area`}>Area</label>
                      {/* Radix items cannot carry "", so "Not sure" travels as a sentinel. */}
                      <Select
                        value={draft.area || AREA_UNSURE}
                        onValueChange={(value) => updateDraft("area", value === AREA_UNSURE ? "" : value)}
                      >
                        <SelectTrigger id={`${uid}-area`}><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value={AREA_UNSURE}>Not sure</SelectItem>
                          {BUG_REPORT_AREAS.map((entry) => (
                            <SelectItem key={entry.value} value={entry.value}>{entry.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {reportType === "bug" ? (
                      <SegmentedField
                        id={`${uid}-frequency`}
                        label="How often"
                        value={draft.frequency || ""}
                        options={BUG_REPORT_FREQUENCIES}
                        onChange={(value) => updateDraft("frequency", draft.frequency === value ? "" : value)}
                        hint="Optional. Select again to clear."
                      />
                    ) : null}

                    <SegmentedField
                      id={`${uid}-priority`}
                      label={type.priorityLabel}
                      value={draft.priority}
                      options={[
                        { value: "normal", label: type.priority.normal },
                        { value: "high", label: type.priority.high },
                      ]}
                      onChange={(value) => updateDraft("priority", value)}
                    />
                  </aside>

                  <div className="fb-main">
                    {showUnavailable ? (
                      <div className="fb-callout is-caution" id={ids.unavailable}>
                        <TriangleAlert className="fb-callout-icon" aria-hidden="true" />
                        <div className="fb-callout-copy">
                          <div className="fb-callout-title">Sending is unavailable in this build</div>
                          <div className="fb-callout-text">
                            This build has no feedback endpoint. Copy the report as Markdown
                            and paste it into a new issue on GitHub.
                          </div>
                          <CopyStatus state={copyState} />
                        </div>
                        <div className="fb-callout-actions">
                          <button
                            type="button"
                            className="cx-btn"
                            onClick={handleCopyMarkdown}
                            disabled={copyState === "working"}
                          >
                            <Copy aria-hidden="true" />
                            Copy as Markdown
                          </button>
                          <a
                            className="cx-btn is-quiet"
                            href={NEW_ISSUE_URL}
                            target="_blank"
                            rel="noreferrer"
                          >
                            New issue
                            <ExternalLink aria-hidden="true" />
                          </a>
                        </div>
                      </div>
                    ) : null}

                    <TextField
                      inputRef={summaryRef}
                      id={`${uid}-summary`}
                      label={type.summaryLabel}
                      value={draft.summary}
                      max={BUG_REPORT_SUMMARY_MAX}
                      min={BUG_REPORT_SUMMARY_MIN}
                      placeholder={type.summaryPlaceholder}
                      error={fieldErrors.summary}
                      onChange={(value) => updateDraft("summary", value)}
                    />

                    {type.fields.map((field) => (
                      <TextField
                        key={field.key}
                        multiline
                        id={`${uid}-${field.key}`}
                        label={field.label}
                        rows={field.rows}
                        value={draft[field.key]}
                        max={BUG_REPORT_DETAILS_MAX}
                        min={BUG_REPORT_DETAILS_MIN}
                        placeholder={field.placeholder}
                        error={fieldErrors[field.key]}
                        onChange={(value) => updateDraft(field.key, value)}
                      />
                    ))}

                    <section className="fb-sent" aria-labelledby={`${uid}-sent`}>
                      <h3 className="cx-label" id={`${uid}-sent`}>What gets sent</h3>
                      <p className="fb-sent-text">
                        Your text and choices, plus the environment details below. Nothing leaves this
                        device until you send.
                      </p>
                      {reportType === "bug" ? (
                        <div className="fb-sent-row">
                          <div className="fb-sent-row-copy">
                            <span className="fb-sent-row-label" id={`${uid}-logs`}>Include recent console logs</span>
                            <span className="fb-sent-row-hint">
                              {logCount > 0
                                ? `${logCount} ${logCount === 1 ? "entry" : "entries"} from this session. They can contain file paths.`
                                : "No entries recorded in this session yet."}
                            </span>
                          </div>
                          <Toggle
                            checked={includeConsoleLogs}
                            onChange={(value) => updateDraft("includeConsoleLogs", value)}
                            ariaLabel="Include recent console logs"
                          />
                        </div>
                      ) : null}
                      <button
                        type="button"
                        className="fb-disclosure"
                        aria-expanded={showDetails}
                        aria-controls={ids.disclosure}
                        onClick={() => setShowDetails((value) => !value)}
                      >
                        <ChevronDown className="fb-disclosure-icon" aria-hidden="true" />
                        Environment details
                        <span className="fb-disclosure-count">{environmentRows.length || "…"}</span>
                      </button>
                      <dl className="fb-env" id={ids.disclosure} hidden={!showDetails}>
                        {environmentRows.length ? environmentRows.map((row) => (
                          <div className="fb-env-row" key={row.label}>
                            <dt>{row.label}</dt>
                            <dd className={row.mono ? "is-mono" : undefined} title={row.value}>{row.value}</dd>
                          </div>
                        )) : (
                          <div className="fb-env-row">
                            <dt>Status</dt>
                            <dd>{environment === undefined ? "Reading environment…" : "Couldn't read the environment. The report will retry when sent."}</dd>
                          </div>
                        )}
                      </dl>
                    </section>

                    <div className="fb-hp" data-fb-hidden aria-hidden="true">
                      <label>
                        Website
                        <input
                          type="text"
                          name="website"
                          tabIndex={-1}
                          autoComplete="off"
                          value={honeypot}
                          onChange={(event) => setHoneypot(event.currentTarget.value)}
                        />
                      </label>
                    </div>
                  </div>
                </div>
                </fieldset>

                <footer className="fb-foot">
                  {submitError ? (
                    <div className="fb-callout is-error" role="alert">
                      <CircleAlert className="fb-callout-icon" aria-hidden="true" />
                      <div className="fb-callout-copy">
                        <div className="fb-callout-title">Couldn't send the {type.noun}</div>
                        <div className="fb-callout-text">
                          {submitError} Your draft is still here.
                        </div>
                        <CopyStatus state={copyState} />
                      </div>
                      <div className="fb-callout-actions">
                        <button
                          type="button"
                          className="cx-btn"
                          onClick={handleCopyMarkdown}
                          disabled={submitting || copyState === "working"}
                        >
                          <Copy aria-hidden="true" />
                          Copy as Markdown
                        </button>
                      </div>
                    </div>
                  ) : null}
                  <div className="fb-foot-row">
                    <div className="fb-draft">
                      <span
                        id={ids.footNote}
                        className={`fb-foot-note ${draftSaveFailed ? "is-error" : ""}`}
                        aria-live="polite"
                      >
                        {footNote}
                      </span>
                      {draftHasContent ? (
                        <button
                          type="button"
                          className={`cx-btn is-quiet fb-btn-sm ${discardArmed ? "is-armed-discard" : ""}`}
                          onClick={discardDraft}
                          disabled={submitting}
                        >
                          {discardArmed ? "Click again to discard" : "Discard draft"}
                        </button>
                      ) : null}
                    </div>
                    <div className="fb-actions">
                      <button type="button" className="cx-btn" onClick={requestClose} disabled={submitting}>
                        Close
                      </button>
                      <button
                        type="submit"
                        className="cx-btn is-primary"
                        disabled={submitting || !canSubmit}
                        aria-describedby={!canSubmit ? ids.unavailable : undefined}
                        title={!canSubmit ? NOT_CONFIGURED_ERROR : `${submitLabel} (Ctrl+Enter)`}
                      >
                        {submitting ? <LoaderCircle className="fb-spinner" aria-hidden="true" /> : null}
                        {submitLabel}
                        {!submitting && canSubmit ? (
                          <span className="cx-keys" aria-hidden="true">
                            <kbd className="cx-keycap">Ctrl</kbd>
                            <kbd className="cx-keycap">Enter</kbd>
                          </span>
                        ) : null}
                      </button>
                    </div>
                  </div>
                </footer>
              </form>
            )}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    portalNode,
  );
}

function TextField({ id, label, value, onChange, min, max, placeholder, error, multiline, rows, inputRef }) {
  const length = value.trim().length;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const Control = multiline ? "textarea" : "input";
  return (
    <div className={`fb-field ${error ? "is-invalid" : ""}`}>
      <div className="fb-field-head">
        <label className="cx-label" htmlFor={id}>{label}</label>
        <span className="fb-counter" aria-hidden="true">
          {value.length}/{max}
        </span>
      </div>
      <Control
        ref={inputRef}
        id={id}
        className={`fb-input ${multiline ? "fb-textarea" : ""}`}
        value={value}
        rows={multiline ? rows : undefined}
        maxLength={max}
        placeholder={placeholder}
        onChange={(event) => onChange(event.currentTarget.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${errorId} ${hintId}` : hintId}
        required
      />
      {error ? (
        <p className="fb-field-error" id={errorId}>
          <CircleAlert aria-hidden="true" />
          {error}
        </p>
      ) : null}
      <p className="fb-field-hint" id={hintId}>
        {length > 0 && length < min
          ? `${min - length} more ${min - length === 1 ? "character" : "characters"} needed`
          : `Required, at least ${min} characters`}
        <span className="fb-visually-hidden">. {value.length} of {max} characters used.</span>
      </p>
    </div>
  );
}

function SegmentedField({ id, label, value, options, onChange, hint }) {
  return (
    <div className="fb-group">
      <span className="cx-label" id={`${id}-label`}>{label}</span>
      <div className="fb-seg" role="group" aria-labelledby={`${id}-label`} aria-describedby={hint ? `${id}-hint` : undefined}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`fb-seg-btn ${value === option.value ? "is-on" : ""}`}
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {hint ? <span className="fb-group-hint" id={`${id}-hint`}>{hint}</span> : null}
    </div>
  );
}

function CopyStatus({ state }) {
  let text = "";
  if (state === "copied") text = "Copied. Paste it into a new GitHub issue.";
  else if (state === "failed") text = "Couldn't write to the clipboard.";
  else if (state === "invalid") text = "Fill in the highlighted fields first.";
  return (
    <div className={`fb-copy-status ${state === "failed" ? "is-error" : ""}`} aria-live="polite">
      {text}
    </div>
  );
}
