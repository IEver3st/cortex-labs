import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, Copy, Search, X } from "lucide-react";
import {
  getAppVersion,
  getChangelog,
  markWhatsNewSeen,
  shouldAutoOpenWhatsNew,
  toMarkdown,
} from "../lib/changelog";
import {
  KINDS,
  KIND_LABELS,
  countKinds,
  filterItems,
  formatReleaseDate,
  groupByKind,
  splitInlineCode,
} from "../lib/changelog-core";
import "./WhatsNew.css";

const FILTERS = [{ id: "all", label: "All" }, ...KINDS.map((id) => ({ id, label: KIND_LABELS[id] }))];

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

function isTypingTarget(target) {
  return Boolean(target?.closest?.('input, textarea, select, [contenteditable="true"]'));
}

function RichText({ text }) {
  return splitInlineCode(text).map((segment, index) =>
    segment.code
      ? <code key={index} className="wn-code">{segment.text}</code>
      : <span key={index}>{segment.text}</span>,
  );
}

function countPhrase(counts) {
  return KINDS.map((kind) => `${counts[kind]} ${KIND_LABELS[kind].toLowerCase()}`).join(", ");
}

/**
 * Release notes: a timeline of every release on the left and the selected
 * release's changes on the right. Opens once for the installed version's own
 * notes (unless turned off in Settings) and on demand from Settings or Home.
 */
export default function WhatsNew({ forceOpen = false, onClose, isManual = false }) {
  const [visible, setVisible] = useState(false);
  const [entries, setEntries] = useState([]);
  const [selectedVersion, setSelectedVersion] = useState("");
  const [kind, setKind] = useState("all");
  const [query, setQuery] = useState("");
  const [copyState, setCopyState] = useState("idle");
  const dialogRef = useRef(null);
  const railRef = useRef(null);
  const bodyRef = useRef(null);
  const searchRef = useRef(null);
  const doneRef = useRef(null);
  const copyTimerRef = useRef(null);
  const focusRailRef = useRef(false);
  const reduceMotion = useReducedMotion();
  const appVersion = getAppVersion();

  const clearCopyTimer = useCallback(() => {
    if (copyTimerRef.current) {
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearCopyTimer, [clearCopyTimer]);

  useEffect(() => {
    if (!forceOpen && !shouldAutoOpenWhatsNew()) return;
    const all = getChangelog();
    if (!forceOpen && !all.length) return;
    setEntries(all);
    setSelectedVersion(all[0]?.version || "");
    setKind("all");
    setQuery("");
    setCopyState("idle");
    setVisible(true);
  }, [forceOpen]);

  const latestVersion = entries[0]?.version || "";

  const railEntries = useMemo(() => {
    const needle = query.trim();
    return entries
      .map((entry) => ({
        entry,
        counts: needle ? countKinds(filterItems(entry, { query: needle })) : entry.counts,
      }))
      .filter(({ counts }) => !needle || KINDS.some((k) => counts[k] > 0));
  }, [entries, query]);

  const selected = useMemo(
    () => railEntries.find(({ entry }) => entry.version === selectedVersion)?.entry
      || railEntries[0]?.entry
      || null,
    [railEntries, selectedVersion],
  );

  const queryItems = useMemo(() => filterItems(selected, { query }), [selected, query]);
  const tabCounts = useMemo(() => countKinds(queryItems), [queryItems]);
  const groups = useMemo(
    () => groupByKind(kind === "all" ? queryItems : queryItems.filter((item) => item.kind === kind)),
    [queryItems, kind],
  );
  const shownCount = groups.reduce((total, group) => total + group.items.length, 0);

  const handleDismiss = useCallback(() => {
    clearCopyTimer();
    setVisible(false);
    // Reading the installed version's notes, either way they were opened, counts as seen.
    if (!isManual || latestVersion === appVersion) markWhatsNewSeen();
    onClose?.();
  }, [appVersion, clearCopyTimer, isManual, latestVersion, onClose]);

  const selectRelease = useCallback((version, { focusRail = false } = {}) => {
    focusRailRef.current = focusRail;
    setSelectedVersion(version);
    setCopyState("idle");
    clearCopyTimer();
  }, [clearCopyTimer]);

  const moveSelection = useCallback((step, { focusRail = false } = {}) => {
    if (!railEntries.length || !selected) return;
    const index = railEntries.findIndex(({ entry }) => entry.version === selected.version);
    const nextIndex = step === Infinity
      ? railEntries.length - 1
      : step === -Infinity
        ? 0
        : Math.min(railEntries.length - 1, Math.max(0, index + step));
    selectRelease(railEntries[nextIndex].entry.version, { focusRail });
  }, [railEntries, selectRelease, selected]);

  // Lock page scroll, focus the timeline, and give focus back on close.
  useEffect(() => {
    if (!visible) return undefined;
    const previous = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const row = railRef.current?.querySelector('[aria-current="true"]');
    (row || doneRef.current)?.focus({ preventScroll: true });
    row?.scrollIntoView?.({ block: "nearest" });
    return () => {
      document.body.style.overflow = previousOverflow;
      if (previous?.isConnected) previous.focus?.({ preventScroll: true });
    };
  }, [visible]);

  // Keep the selected row in view and start each release at the top.
  useEffect(() => {
    if (!visible || !selected) return;
    const row = railRef.current?.querySelector(`[data-version="${CSS.escape(selected.version)}"]`);
    if (focusRailRef.current) row?.focus({ preventScroll: true });
    focusRailRef.current = false;
    row?.scrollIntoView?.({ block: "nearest" });
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [visible, selected]);

  // Modal keyboard: handled in the capture phase so app hotkeys beneath the
  // dialog never see these keys.
  useEffect(() => {
    if (!visible) return undefined;
    const onKeyDown = (event) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      event.stopPropagation();
      const { key, target } = event;

      if (key === "Escape") {
        event.preventDefault();
        if (target === searchRef.current && searchRef.current.value) setQuery("");
        else handleDismiss();
        return;
      }

      if (key === "Tab") {
        const focusable = [...dialog.querySelectorAll(FOCUSABLE)];
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!dialog.contains(document.activeElement)) {
          event.preventDefault();
          first.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }

      if (event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(target)) return;

      const inRail = railRef.current?.contains(target);
      const inBody = bodyRef.current?.contains(target);
      let step = 0;
      if (key === "j" || (key === "ArrowDown" && !inBody)) step = 1;
      else if (key === "k" || (key === "ArrowUp" && !inBody)) step = -1;
      else if (key === "Home" && inRail) step = -Infinity;
      else if (key === "End" && inRail) step = Infinity;
      else if (key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (!step) return;
      event.preventDefault();
      moveSelection(step, { focusRail: Boolean(inRail) });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [visible, handleDismiss, moveSelection]);

  const handleCopy = useCallback(async () => {
    if (!selected) return;
    clearCopyTimer();
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(toMarkdown(selected));
      setCopyState("copied");
    } catch (error) {
      console.error("[WhatsNew] Copy failed:", error);
      setCopyState("error");
    }
    copyTimerRef.current = window.setTimeout(() => setCopyState("idle"), 2400);
  }, [clearCopyTimer, selected]);

  if (typeof document === "undefined") return null;

  const transition = reduceMotion ? { duration: 0 } : { duration: 0.16, ease: [0.2, 0.8, 0.2, 1] };
  const hasEntries = entries.length > 0;
  const trimmedQuery = query.trim();
  const activeFilterLabel = kind === "all" ? "" : KIND_LABELS[kind].toLowerCase();

  return createPortal(
    <AnimatePresence>
      {visible && (
        <motion.div
          key="wn"
          className="wn-root"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={transition}
        >
          <div className="wn-scrim" aria-hidden="true" onMouseDown={handleDismiss} />
          <div className="wn-center">
            <motion.div
              ref={dialogRef}
              className={`wn-dialog${hasEntries ? "" : " is-empty"}`}
              role="dialog"
              aria-modal="true"
              aria-label="What's New"
              aria-describedby={selected?.summary ? "wn-summary" : undefined}
              initial={reduceMotion ? false : { y: 8, scale: 0.99 }}
              animate={{ y: 0, scale: 1 }}
              exit={reduceMotion ? undefined : { y: 6, scale: 0.995 }}
              transition={transition}
            >
              {hasEntries && (
                <aside className="wn-rail" aria-label="Releases">
                  <div className="wn-rail-head">
                    <div className="wn-rail-heading">
                      <span className="cx-label">Releases</span>
                      <span className="wn-mono">{railEntries.length}</span>
                    </div>
                    <label className="wn-search">
                      <Search className="wn-search-icon" aria-hidden="true" />
                      <input
                        ref={searchRef}
                        type="search"
                        className="wn-search-input"
                        placeholder="Search all releases"
                        aria-label="Search all releases"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        spellCheck={false}
                      />
                      {query && (
                        <button
                          type="button"
                          className="wn-search-clear"
                          onClick={() => {
                            setQuery("");
                            searchRef.current?.focus();
                          }}
                          aria-label="Clear search"
                          title="Clear search"
                        >
                          <X aria-hidden="true" />
                        </button>
                      )}
                    </label>
                  </div>

                  <ol ref={railRef} className="wn-timeline custom-scrollbar">
                    {railEntries.map(({ entry, counts }, index) => {
                      const isSelected = entry.version === selected?.version;
                      const total = KINDS.reduce((sum, k) => sum + counts[k], 0);
                      return (
                        <li
                          key={entry.version}
                          className="wn-tl-item"
                          data-latest={entry.version === latestVersion || undefined}
                          data-first={index === 0 || undefined}
                          data-selected={isSelected || undefined}
                        >
                          <span className="wn-track" aria-hidden="true">
                            <span className="wn-track-lead" />
                            <span className="wn-node" />
                            <span className="wn-spine">
                              {total > 0
                                ? KINDS.map((k) => counts[k] > 0 && (
                                  <span key={k} data-kind={k} style={{ flexGrow: counts[k] }} />
                                ))
                                : <span className="is-blank" />}
                            </span>
                          </span>
                          <button
                            type="button"
                            className="wn-release"
                            data-version={entry.version}
                            aria-current={isSelected ? "true" : undefined}
                            tabIndex={isSelected ? 0 : -1}
                            onClick={() => selectRelease(entry.version)}
                          >
                            <span className="wn-release-top">
                              <span className="cx-display wn-release-ver">{entry.version}</span>
                              {entry.date && (
                                <span className="wn-mono wn-release-date">{formatReleaseDate(entry.date)}</span>
                              )}
                            </span>
                            <span className="wn-release-bottom">
                              <span className="wn-release-name">{entry.name}</span>
                              <span className="wn-release-counts" aria-label={countPhrase(counts)}>
                                {KINDS.map((k) => counts[k] > 0 && (
                                  <span key={k} className="wn-count" data-kind={k}>
                                    <i className="wn-marker" />
                                    {counts[k]}
                                  </span>
                                ))}
                              </span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                  {trimmedQuery && !railEntries.length && (
                    <p className="wn-rail-empty">No releases match.</p>
                  )}
                </aside>
              )}

              <section className="wn-main">
                <button
                  type="button"
                  className="cx-icon-btn wn-close"
                  onClick={handleDismiss}
                  aria-label="Close release notes"
                  title="Close (Esc)"
                >
                  <X aria-hidden="true" />
                </button>

                {!hasEntries && (
                  <div className="wn-empty is-page">
                    <p className="wn-empty-title">No release notes yet</p>
                    <p className="wn-empty-text">Cortex Studio {appVersion} was built without bundled release notes.</p>
                  </div>
                )}

                {hasEntries && !selected && (
                  <div className="wn-empty is-page">
                    <p className="wn-empty-title">No changes match "{trimmedQuery}"</p>
                    <p className="wn-empty-text">Search looks at titles and descriptions in every release.</p>
                    <button type="button" className="cx-btn" onClick={() => setQuery("")}>Clear search</button>
                  </div>
                )}

                {selected && (
                  <motion.div
                    key={selected.version}
                    className="wn-release-view"
                    initial={reduceMotion ? false : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={reduceMotion ? { duration: 0 } : { duration: 0.14 }}
                  >
                    <header className="wn-head">
                      <h2 className="cx-display wn-title" title={selected.name || selected.version}>
                        {selected.name || selected.version}
                      </h2>
                      <div className="wn-meta">
                        {selected.name && <span className="wn-mono">v{selected.version}</span>}
                        {selected.date && (
                          <span className="wn-mono">
                            <time dateTime={selected.date}>{formatReleaseDate(selected.date)}</time>
                          </span>
                        )}
                        {selected.version === appVersion && (
                          <span className="wn-installed"><i className="wn-dot" />Installed</span>
                        )}
                        {selected.version === latestVersion && selected.version !== appVersion && (
                          <span className="wn-installed is-latest"><i className="wn-dot" />Latest notes</span>
                        )}
                      </div>
                      {selected.summary && (
                        <p id="wn-summary" className="wn-summary"><RichText text={selected.summary} /></p>
                      )}

                      {selected.items.length > 0 && (
                        <div
                          className="wn-bar"
                          role="img"
                          aria-label={`${selected.items.length} changes: ${countPhrase(selected.counts)}`}
                        >
                          {KINDS.map((k) => selected.counts[k] > 0 && (
                            <span
                              key={k}
                              data-kind={k}
                              data-dim={(kind !== "all" && kind !== k) || undefined}
                              style={{ flexGrow: selected.counts[k] }}
                            />
                          ))}
                        </div>
                      )}

                      <div className="wn-filters" role="group" aria-label="Filter changes">
                        {FILTERS.map((filter) => {
                          const count = filter.id === "all" ? queryItems.length : tabCounts[filter.id];
                          const isActive = kind === filter.id;
                          return (
                            <button
                              key={filter.id}
                              type="button"
                              className={`wn-filter${isActive ? " is-active" : ""}`}
                              data-kind={filter.id === "all" ? undefined : filter.id}
                              aria-pressed={isActive}
                              onClick={() => setKind(filter.id)}
                            >
                              {filter.id !== "all" && <i className="wn-marker" aria-hidden="true" />}
                              <span>{filter.label}</span>
                              <span className="wn-filter-num">{count}</span>
                            </button>
                          );
                        })}
                      </div>
                    </header>

                    <div ref={bodyRef} className="wn-body custom-scrollbar" tabIndex={0} aria-label="Changes">
                      {shownCount > 0 ? groups.map((group) => (
                        <section
                          key={group.kind}
                          className="wn-group"
                          data-kind={group.kind}
                          aria-labelledby={`wn-group-${group.kind}`}
                        >
                          <h3 className="wn-group-head" id={`wn-group-${group.kind}`}>
                            <span className="wn-chip"><i className="wn-marker" />{group.label}</span>
                            <span className="wn-mono">{group.items.length}</span>
                          </h3>
                          <ul className="wn-items">
                            {group.items.map((item) => (
                              <li key={item.id} className="wn-item">
                                <i className="wn-marker" aria-hidden="true" />
                                <div className="wn-item-text">
                                  <p className="wn-item-title"><RichText text={item.title} /></p>
                                  {item.desc && <p className="wn-item-desc"><RichText text={item.desc} /></p>}
                                </div>
                              </li>
                            ))}
                          </ul>
                        </section>
                      )) : (
                        <div className="wn-empty">
                          <p className="wn-empty-title">
                            {selected.items.length === 0
                              ? "No changes listed for this release"
                              : `No ${activeFilterLabel ? `${activeFilterLabel} ` : ""}changes${trimmedQuery ? ` match "${trimmedQuery}"` : ""} in ${selected.name || selected.version}`}
                          </p>
                          {kind !== "all" && (
                            <>
                              <p className="wn-empty-text">This release has {queryItems.length} other {queryItems.length === 1 ? "change" : "changes"}{trimmedQuery ? " matching your search" : ""}.</p>
                              <button type="button" className="cx-btn" onClick={() => setKind("all")}>Show all changes</button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </section>

              <footer className="wn-footer">
                {hasEntries && (
                  <div className="wn-hints" aria-hidden="true">
                    <span className="cx-keys"><kbd className="cx-keycap">↑</kbd><kbd className="cx-keycap">↓</kbd></span>
                    <span>Release</span>
                    <span className="cx-keys"><kbd className="cx-keycap">/</kbd></span>
                    <span>Search</span>
                    <span className="cx-keys"><kbd className="cx-keycap">Esc</kbd></span>
                    <span>Close</span>
                  </div>
                )}
                <div
                  className={`wn-status${copyState === "error" ? " is-error" : ""}${copyState === "copied" ? " is-ok" : ""}`}
                  role="status"
                  aria-live="polite"
                >
                  {copyState === "copied" && selected && `Copied ${selected.name || selected.version} as Markdown`}
                  {copyState === "error" && "Clipboard unavailable. Try again."}
                </div>
                <div className="wn-actions">
                  {selected && (
                    <button
                      type="button"
                      className={`settings-secondary wn-copy${copyState === "copied" ? " is-copied" : ""}`}
                      onClick={handleCopy}
                    >
                      {copyState === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                      <span>{copyState === "copied" ? "Copied" : copyState === "error" ? "Copy failed" : "Copy as Markdown"}</span>
                    </button>
                  )}
                  <button ref={doneRef} type="button" className="settings-primary" onClick={handleDismiss}>
                    Done
                  </button>
                </div>
              </footer>
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
