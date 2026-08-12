import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Copy,
  FileText,
  List,
  Plus,
  Wrench,
  X,
} from "lucide-react";
import {
  getLatestChangelog,
  hasSeenWhatsNew,
  markWhatsNewSeen,
  toMarkdown,
} from "../lib/changelog";
import "./WhatsNew.css";

const TAG_META = {
  new: { label: "New", icon: Plus },
  improved: { label: "Improved", icon: ArrowUpRight },
  fixed: { label: "Fixed", icon: Wrench },
};

const FILTERS = [
  { id: "all", label: "All changes", icon: List },
  ...Object.entries(TAG_META).map(([id, meta]) => ({ id, ...meta })),
];

/**
 * Structured release notes shown once per version and available from Settings.
 */
export default function WhatsNew({ forceOpen = false, onClose, isManual = false }) {
  const [visible, setVisible] = useState(false);
  const [entry, setEntry] = useState(null);
  const [activeTag, setActiveTag] = useState("all");
  const [copyState, setCopyState] = useState("idle");
  const modalRef = useRef(null);
  const primaryRef = useRef(null);
  const copiedTimerRef = useRef(null);
  const previouslyFocused = useRef(null);
  const reduceMotion = useReducedMotion();

  const clearCopyTimer = useCallback(() => {
    if (copiedTimerRef.current) {
      clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearCopyTimer(), [clearCopyTimer]);

  useEffect(() => {
    if (!visible) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [visible]);

  useEffect(() => {
    if (!visible) return undefined;
    previouslyFocused.current = document.activeElement;
    const focusTimer = window.setTimeout(() => primaryRef.current?.focus(), 60);
    return () => {
      window.clearTimeout(focusTimer);
      previouslyFocused.current?.focus?.();
    };
  }, [visible]);

  useEffect(() => {
    if (!visible || !modalRef.current) return undefined;
    const handleFocusTrap = (event) => {
      if (event.key !== "Tab") return;
      const focusable = modalRef.current?.querySelectorAll(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
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
    window.addEventListener("keydown", handleFocusTrap);
    return () => window.removeEventListener("keydown", handleFocusTrap);
  }, [visible]);

  useEffect(() => {
    const shouldOpen = forceOpen || !hasSeenWhatsNew();
    if (!shouldOpen) return;
    const data = getLatestChangelog();
    if (!data || (!data.heroTitle && !data.items.length)) return;
    setEntry(data);
    setActiveTag("all");
    setCopyState("idle");
    setVisible(true);
  }, [forceOpen]);

  const handleDismiss = useCallback(() => {
    clearCopyTimer();
    setVisible(false);
    if (!isManual) markWhatsNewSeen();
    onClose?.();
  }, [clearCopyTimer, isManual, onClose]);

  useEffect(() => {
    if (!visible) return undefined;
    const handleEscape = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      handleDismiss();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [visible, handleDismiss]);

  const groups = useMemo(() => {
    const grouped = { new: [], improved: [], fixed: [] };
    entry?.items.forEach((item, index) => {
      const tag = grouped[item.tag] ? item.tag : "new";
      grouped[tag].push({ ...item, ordinal: index + 1 });
    });
    return grouped;
  }, [entry]);

  const visibleTags = activeTag === "all" ? Object.keys(TAG_META) : [activeTag];
  const visibleCount = visibleTags.reduce((total, tag) => total + groups[tag].length, 0);
  const totalCount = entry?.items.length || 0;

  const handleCopy = useCallback(async () => {
    clearCopyTimer();
    try {
      await navigator.clipboard.writeText(toMarkdown(entry));
      setCopyState("copied");
    } catch (error) {
      console.error("[WhatsNew] Copy failed:", error);
      setCopyState("error");
    }
    copiedTimerRef.current = window.setTimeout(() => setCopyState("idle"), 2400);
  }, [clearCopyTimer, entry]);

  if (!entry || typeof document === "undefined") return null;

  const motionTransition = reduceMotion
    ? { duration: 0.01 }
    : { duration: 0.18, ease: [0.22, 1, 0.36, 1] };

  const copyLabel = copyState === "copied"
    ? "Copied"
    : copyState === "error"
      ? "Retry copy"
      : "Copy Markdown";

  return createPortal(
    <AnimatePresence>
      {visible && (
        <>
          <motion.div
            className="cs-changelog-backdrop"
            aria-hidden="true"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={motionTransition}
            onMouseDown={handleDismiss}
          />

          <div className="cs-changelog-center">
            <motion.div
              ref={modalRef}
              className="cs-changelog-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="cs-changelog-title"
              aria-describedby={entry.heroDesc ? "cs-changelog-summary" : undefined}
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
              transition={motionTransition}
            >
              <header className="cs-changelog-toolbar">
                <div className="cs-changelog-toolbar-title">
                  <FileText aria-hidden="true" />
                  <span>// RELEASE NOTES</span>
                  <strong>v{entry.version}</strong>
                </div>
                <div className="cs-changelog-toolbar-actions">
                  <button
                    type="button"
                    className={`cs-changelog-copy ${copyState === "error" ? "is-error" : ""}`}
                    onClick={handleCopy}
                    aria-label="Copy changelog as Markdown"
                  >
                    {copyState === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                    <span>{copyLabel}</span>
                  </button>
                  <button
                    type="button"
                    className="cs-changelog-close"
                    onClick={handleDismiss}
                    aria-label="Close release notes"
                    title="Close"
                  >
                    <X aria-hidden="true" />
                  </button>
                </div>
              </header>

              <div className="cs-changelog-workspace">
                <aside className="cs-changelog-index">
                  <div className="cs-changelog-release">
                    <div className="cs-changelog-release-meta">
                      <span>Latest release</span>
                      {!isManual && <span className="cs-changelog-updated">Updated</span>}
                    </div>
                    <h2 id="cs-changelog-title">{entry.heroTitle || "What's New"}</h2>
                    {entry.heroDesc && (
                      <p id="cs-changelog-summary">{entry.heroDesc}</p>
                    )}
                  </div>

                  <nav className="cs-changelog-nav" aria-label="Release note categories">
                    <div className="cs-changelog-nav-heading">
                      <span>// RELEASE INDEX</span>
                      <span>{totalCount} total</span>
                    </div>
                    <div className="cs-changelog-filters">
                      {FILTERS.map((filter) => {
                        const Icon = filter.icon;
                        const count = filter.id === "all" ? totalCount : groups[filter.id].length;
                        const isActive = activeTag === filter.id;
                        return (
                          <button
                            key={filter.id}
                            type="button"
                            className={isActive ? "is-active" : ""}
                            onClick={() => setActiveTag(filter.id)}
                            aria-pressed={isActive}
                          >
                            <Icon aria-hidden="true" />
                            <span>{filter.label}</span>
                            <strong>{count}</strong>
                          </button>
                        );
                      })}
                    </div>
                  </nav>
                </aside>

                <section className="cs-changelog-ledger" aria-label="Release changes">
                  <header className="cs-changelog-ledger-header">
                    <div>
                      <span>// CHANGE LOG</span>
                      <h3>{activeTag === "all" ? "All changes" : TAG_META[activeTag].label}</h3>
                    </div>
                    <span>{visibleCount} {visibleCount === 1 ? "entry" : "entries"}</span>
                  </header>

                  <div className="cs-changelog-scroll custom-scrollbar">
                    {visibleCount > 0 ? visibleTags.map((tag) => {
                      const meta = TAG_META[tag];
                      const SectionIcon = meta.icon;
                      return (
                        <section
                          className="cs-changelog-section"
                          key={tag}
                          aria-labelledby={`cs-changelog-${tag}`}
                        >
                          <div className="cs-changelog-section-heading">
                            <SectionIcon aria-hidden="true" />
                            <h4 id={`cs-changelog-${tag}`}>{meta.label}</h4>
                            <span>{groups[tag].length}</span>
                          </div>
                          <ol className="cs-changelog-list">
                            {groups[tag].map((item) => (
                              <li key={`${tag}-${item.ordinal}`} className="cs-changelog-row">
                                <span className="cs-changelog-ordinal" aria-hidden="true">
                                  {String(item.ordinal).padStart(2, "0")}
                                </span>
                                <div>
                                  <h5>{item.title}</h5>
                                  {item.desc && <p>{item.desc}</p>}
                                </div>
                              </li>
                            ))}
                          </ol>
                        </section>
                      );
                    }) : (
                      <div className="cs-changelog-empty">
                        <List aria-hidden="true" />
                        <div>
                          <strong>No entries in this category</strong>
                          <span>Select another section from the release index.</span>
                        </div>
                      </div>
                    )}
                  </div>
                </section>
              </div>

              <footer className="cs-changelog-footer">
                <div className="cs-changelog-status" role="status" aria-live="polite">
                  {copyState === "copied" && "Markdown copied to clipboard"}
                  {copyState === "error" && "Clipboard unavailable — try again"}
                  {copyState === "idle" && `${visibleCount} of ${totalCount} changes shown`}
                </div>
                <div className="cs-changelog-footer-actions">
                  <span>Esc closes</span>
                  <button
                    ref={primaryRef}
                    type="button"
                    className="cs-changelog-primary"
                    onClick={handleDismiss}
                  >
                    <span>Done</span>
                    <ArrowRight aria-hidden="true" />
                  </button>
                </div>
              </footer>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}
