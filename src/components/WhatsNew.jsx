import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import {
  X, Sparkles, ArrowRight, Copy, Check, ChevronDown,
  Wrench, Bug
} from "lucide-react";
import {
  getLatestChangelog, hasSeenWhatsNew, markWhatsNewSeen, toMarkdown, getAppVersion
} from "../lib/changelog";

const TAG_META = {
  new:      { label: "New",      icon: Sparkles, tag: "new"      },
  improved: { label: "Improved", icon: Wrench,   tag: "improved" },
  fixed:    { label: "Fix",      icon: Bug,       tag: "fixed"    },
};

const DEFAULT_VISIBLE = 6;

/**
 * WhatsNew — structured floating changelog modal.
 * Appears once per version on first launch; also openable from Settings.
 *
 * Props:
 *   forceOpen   – if true, show the modal regardless of seen state (Settings entry)
 *   onClose     – callback when modal is dismissed
 *   isManual    – if true, opened from Settings (hide "Updated" badge, don't auto-mark as seen)
 */
export default function WhatsNew({ forceOpen = false, onClose, isManual = false }) {
  const [visible, setVisible] = useState(false);
  const [entry, setEntry] = useState(null);
  const [copied, setCopied] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [expandedIdx, setExpandedIdx] = useState(-1);
  const modalRef = useRef(null);
  const primaryRef = useRef(null);

  useEffect(() => {
    if (forceOpen) {
      const data = getLatestChangelog();
      if (data) { setEntry(data); setVisible(true); }
      return;
    }
    if (hasSeenWhatsNew()) return;
    const data = getLatestChangelog();
    if (!data || (!data.heroTitle && !data.items.length)) return;
    setEntry(data);
    setVisible(true);
  }, [forceOpen]);

  const handleDismiss = useCallback(() => {
    setVisible(false);
    if (!isManual) markWhatsNewSeen();
    onClose?.();
  }, [isManual, onClose]);

  // Keyboard: Esc to close, Enter for primary CTA
  useEffect(() => {
    if (!visible) return;
    const handler = (e) => {
      if (e.key === "Escape") handleDismiss();
      if (e.key === "Enter" && document.activeElement === primaryRef.current) handleDismiss();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [visible, handleDismiss]);

  // Groups
  const groups = useMemo(() => {
    if (!entry) return { new: [], improved: [], fixed: [] };
    const g = { new: [], improved: [], fixed: [] };
    for (const item of entry.items) {
      (g[item.tag] || g.new).push(item);
    }
    return g;
  }, [entry]);

  const allItems = useMemo(() => {
    if (!entry) return [];
    return [...(groups.new), ...(groups.improved), ...(groups.fixed)];
  }, [entry, groups]);

  const visibleItems = showAll ? allItems : allItems.slice(0, DEFAULT_VISIBLE);
  const hasMore = allItems.length > DEFAULT_VISIBLE;

  // Copy markdown
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(toMarkdown(entry));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("[WhatsNew] Copy failed:", err);
    }
  }, [entry]);

  // Section header injection: render a section label before the first item of each tag type
  const sectionHeaders = useMemo(() => {
    const headers = {};
    let lastTag = null;
    for (let i = 0; i < visibleItems.length; i++) {
      if (visibleItems[i].tag !== lastTag) {
        headers[i] = visibleItems[i].tag;
        lastTag = visibleItems[i].tag;
      }
    }
    return headers;
  }, [visibleItems]);

  if (!entry) return null;

  const modal = (
    <AnimatePresence>
      {visible && (
        <>
          {/* Backdrop */}
          <motion.div
            className="cs-wn-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            onClick={handleDismiss}
          />

          {/* Modal */}
          <div className="cs-wn-center">
            <motion.div
              ref={modalRef}
              className="cs-wn-modal"
              role="dialog"
              aria-modal="true"
              aria-label="What's New"
              initial={{ opacity: 0, y: 16, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.99 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            >
            {/* ─── Scanline accent ─── */}
            <div className="cs-wn-scanline" />

            {/* ─── REGION A: Header ─── */}
            <div className="cs-wn-header">
              <div className="cs-wn-header-left">
                <h2 className="cs-wn-heading">What's New</h2>
                <span className="cs-wn-version-pill">v{entry.version}</span>
                {!isManual && (
                  <motion.span
                    className="cs-wn-updated-dot"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.2, duration: 0.3 }}
                  >
                    <span className="cs-wn-dot" />
                    Updated
                  </motion.span>
                )}
              </div>
              <div className="cs-wn-header-right">
                <button
                  type="button"
                  className="cs-wn-copy-btn"
                  onClick={handleCopy}
                  title="Copy changelog as Markdown"
                >
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copied ? "Copied" : "Copy MD"}</span>
                </button>
                <button
                  type="button"
                  className="cs-wn-close"
                  onClick={handleDismiss}
                  aria-label="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* ─── Scrollable body ─── */}
            <div className="cs-wn-body custom-scrollbar">
              {/* ─── REGION B: Hero Highlight Card ─── */}
              {entry.heroTitle && (
                <motion.div
                  className="cs-wn-hero"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1, duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                >
                  <span className="cs-wn-hero-label">// release highlights</span>
                  <h3 className="cs-wn-hero-title">{entry.heroTitle}</h3>
                  {entry.heroDesc && (
                    <p className="cs-wn-hero-desc">{entry.heroDesc}</p>
                  )}
                </motion.div>
              )}

              {/* ─── REGION C: Change List ─── */}
              <div className="cs-wn-list">
                {visibleItems.map((item, i) => {
                  const meta = TAG_META[item.tag] || TAG_META.new;
                  const Icon = meta.icon;
                  const globalIdx = allItems.indexOf(item);
                  const isExpanded = expandedIdx === globalIdx;
                  const showHeader = sectionHeaders[i] !== undefined;

                  return (
                    <div key={globalIdx}>
                      {showHeader && (
                        <motion.div
                          className="cs-wn-section-header"
                          data-tag={sectionHeaders[i]}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ delay: 0.08 + i * 0.03, duration: 0.3 }}
                        >
                          {TAG_META[sectionHeaders[i]]?.label || "New"}
                        </motion.div>
                      )}

                      <motion.div
                        className={`cs-wn-row ${isExpanded ? "is-expanded" : ""}`}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.12 + i * 0.04, duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                        onClick={() => item.desc && setExpandedIdx(isExpanded ? -1 : globalIdx)}
                        style={{ cursor: item.desc ? "pointer" : "default" }}
                      >
                        <div className="cs-wn-row-main">
                          <span className="cs-wn-tag" data-tag={meta.tag} title={meta.label}>
                            <Icon className="w-3 h-3" />
                          </span>
                          <span className="cs-wn-row-title">{item.title}</span>
                          {item.desc && (
                            <ChevronDown className={`cs-wn-row-chevron ${isExpanded ? "is-open" : ""}`} />
                          )}
                        </div>
                        <AnimatePresence>
                          {isExpanded && item.desc && (
                            <motion.div
                              className="cs-wn-row-desc"
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                            >
                              <p>{item.desc}</p>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    </div>
                  );
                })}

                {/* Show all / collapse toggle */}
                {hasMore && (
                  <button
                    type="button"
                    className="cs-wn-show-toggle"
                    onClick={() => setShowAll((p) => !p)}
                  >
                    {showAll ? "Show less" : `Show all (${allItems.length})`}
                  </button>
                )}
              </div>
            </div>

              {/* ─── Footer ─── */}
              <div className="cs-wn-footer">
                <motion.button
                  ref={primaryRef}
                  type="button"
                  className="cs-wn-primary"
                  onClick={handleDismiss}
                  whileHover={{ scale: 1.015 }}
                  whileTap={{ scale: 0.985 }}
                >
                  <span>GOT IT</span>
                  <ArrowRight className="w-4 h-4" />
                </motion.button>
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );

  return createPortal(modal, document.body);
}
