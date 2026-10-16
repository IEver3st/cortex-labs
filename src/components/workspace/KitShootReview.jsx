import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ChevronLeft, ChevronRight, Columns2, FileText, FolderOpen, Image as ImageIcon, LayoutGrid, Play, X } from "lucide-react";
import { reviewGroups } from "../../lib/kit-shoot.js";
import { createShootFileCache, useShootFile } from "./shootFiles.js";
import { openFolderPath } from "../../lib/open-folder.js";
import "./KitShootReview.css";

/* Full-window review of a Kit Shoot run: slots (or builds) on the left, the
   selected shot large with a drag-to-compare against its base, the saved
   before/after, the slot sheet and video, and the run's checks. Everything is
   read back from the run folder, so earlier runs open the same way. */

const CHECKS = "__checks__";

const CODE_TITLES = {
  MODEL_MISSING: "Missing models",
  LOAD_FAILED: "Failed to load",
  CAPTURE_FAILED: "Not saved",
  TEXTURES_FAILED: "Textures failed",
  TEXTURES_MISSING: "Textures not found",
  NO_VISIBLE_CHANGE: "No visible change",
  DUPLICATE_PART: "Look identical",
  STOCK_NOT_HIDDEN: "turnOffBones hide nothing",
  UNNAMED_PART: "No display name",
  KIT_NOT_LINKED: "Kit not linked",
  BUILD_PARTS_DROPPED: "Build parts dropped",
  UNTEXTURED: "Shot untextured",
};
const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

function countBySeverity(issues) {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const entry of issues) counts[entry.severity] = (counts[entry.severity] || 0) + 1;
  return counts;
}

function percent(changed) {
  if (changed == null) return "";
  if (changed < 0.001) return "<0.1% changed";
  return `${(changed * 100).toFixed(changed < 0.1 ? 1 : 0)}% changed`;
}

function Picture({ cache, path, alt, className = "" }) {
  const file = useShootFile(cache, path);
  if (!path) return <div className={`kr-hole ${className}`}>Not saved</div>;
  if (file.error) return <div className={`kr-hole is-error ${className}`} title={file.error}>Couldn't load</div>;
  if (!file.url) return <div className={`kr-hole is-loading ${className}`} aria-label="Loading" />;
  return <img className={className} src={file.url} alt={alt} draggable={false} />;
}

function Compare({ cache, before, after, beforeLabel, afterLabel }) {
  const [split, setSplit] = useState(50);
  const frameRef = useRef(null);
  const dragging = useRef(false);
  const moveTo = (clientX) => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect?.width) return;
    setSplit(Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100)));
  };
  return (
    <div
      ref={frameRef}
      className="kr-compare"
      onPointerDown={(event) => {
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        moveTo(event.clientX);
      }}
      onPointerMove={(event) => dragging.current && moveTo(event.clientX)}
      onPointerUp={() => { dragging.current = false; }}
      onPointerCancel={() => { dragging.current = false; }}
    >
      <Picture cache={cache} path={after} alt={afterLabel} className="kr-compare-img" />
      <div className="kr-compare-before" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>
        <Picture cache={cache} path={before} alt={beforeLabel} className="kr-compare-img" />
      </div>
      <div
        className="kr-compare-handle"
        style={{ left: `${split}%` }}
        role="slider"
        tabIndex={0}
        aria-label="Compare with the base"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(split)}
        aria-valuetext={`${Math.round(split)}% ${beforeLabel}`}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            event.stopPropagation();
            setSplit((value) => Math.min(100, Math.max(0, value + (event.key === "ArrowLeft" ? -5 : 5))));
          }
        }}
      >
        <span className="kr-compare-grip" aria-hidden="true"><ChevronLeft /><ChevronRight /></span>
      </div>
      <span className="kr-tag is-left">{beforeLabel}</span>
      <span className="kr-tag is-right">{afterLabel}</span>
    </div>
  );
}

function Thumb({ cache, item, selected, onSelect, index }) {
  const ref = useRef(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);
  const worst = item.issues.reduce((acc, entry) => Math.min(acc, SEVERITY_ORDER[entry.severity] ?? 2), 3);
  return (
    <button
      ref={ref}
      type="button"
      className={`kr-thumb ${selected ? "is-on" : ""}`}
      aria-pressed={selected}
      title={item.title}
      onClick={() => onSelect(index)}
    >
      <span className="kr-thumb-frame">
        <Picture cache={cache} path={item.thumb} alt="" />
        {item.isBase ? <span className="kr-thumb-base">Base</span> : null}
        {worst < 3 ? <span className={`kr-thumb-flag is-${["error", "warning", "info"][worst]}`} aria-label="Has checks" /> : null}
      </span>
      <span className="kr-thumb-label">{item.title}</span>
    </button>
  );
}

const CHECKS_SHOWN = 8;

function ChecksView({ review, onJump }) {
  const [expanded, setExpanded] = useState(() => new Set());
  const all = [...review.general, ...review.groups.flatMap((group) => group.items.flatMap((item) => item.issues.map((entry) => ({ ...entry, group, item }))))];
  const byCode = new Map();
  for (const entry of all) {
    if (!byCode.has(entry.code)) byCode.set(entry.code, []);
    byCode.get(entry.code).push(entry);
  }
  const codes = [...byCode.keys()].sort((a, b) => (SEVERITY_ORDER[byCode.get(a)[0].severity] - SEVERITY_ORDER[byCode.get(b)[0].severity]) || a.localeCompare(b));
  if (!codes.length) {
    return (
      <div className="kr-checks-empty">
        <p className="kr-empty-title">No problems found</p>
        <p className="kr-empty-note">Every part loaded, changed the vehicle, and looks different from the others in its slot.</p>
      </div>
    );
  }
  return (
    <div className="kr-checks">
      {codes.map((code) => {
        const entries = byCode.get(code);
        const open = expanded.has(code);
        const shown = open ? entries : entries.slice(0, CHECKS_SHOWN);
        return (
          <section key={code} className="kr-check">
            <h3 className={`kr-check-title is-${entries[0].severity}`}>
              <span className="kr-dot" aria-hidden="true" />
              {CODE_TITLES[code] || code}
              <span className="kr-count">{entries.length}</span>
              <code>{code}</code>
            </h3>
            <ul>
              {shown.map((entry, index) => (
                <li key={`${code}-${index}`}>
                  {entry.item ? (
                    <button type="button" className="kr-check-row" onClick={() => onJump(entry.group, entry.item)}>
                      <span>{entry.message}</span>
                      <span className="kr-check-go">View</span>
                    </button>
                  ) : (
                    <p className="kr-check-row">{entry.message}</p>
                  )}
                </li>
              ))}
            </ul>
            {entries.length > CHECKS_SHOWN ? (
              <button
                type="button"
                className="lv-link kr-check-more"
                onClick={() => setExpanded((current) => {
                  const next = new Set(current);
                  if (open) next.delete(code);
                  else next.add(code);
                  return next;
                })}
              >
                {open ? "Show fewer" : `Show all ${entries.length}`}
              </button>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

export default function KitShootReview({ root, manifest, onClose }) {
  const review = useMemo(() => reviewGroups(manifest), [manifest]);
  const [cache, setCache] = useState(null);
  const [groupId, setGroupId] = useState(() => review.groups[0]?.id || CHECKS);
  const [itemIndex, setItemIndex] = useState(() => (review.groups[0]?.items.length > 1 ? 1 : 0));
  const [view, setView] = useState("compare");
  const [openError, setOpenError] = useState("");
  const dialogRef = useRef(null);

  useEffect(() => {
    const next = createShootFileCache(root);
    setCache(next);
    return () => next.dispose();
  }, [root]);

  useEffect(() => {
    const previous = document.activeElement;
    dialogRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  const group = review.groups.find((entry) => entry.id === groupId) || null;
  const item = group?.items[Math.min(itemIndex, group.items.length - 1)] || null;
  const canCompare = Boolean(item?.compareTo?.file && item.file);
  const mode = view === "compare" && !canCompare ? "shot" : view === "pair" && !item?.beforeAfter ? "shot" : view;

  const selectGroup = useCallback((id) => {
    setGroupId(id);
    const next = review.groups.find((entry) => entry.id === id);
    setItemIndex(next && next.items.length > 1 && next.items[0].isBase ? 1 : 0);
    if (view === "sheet" || view === "video") setView("compare");
  }, [review.groups, view]);

  const step = useCallback((delta) => {
    if (!group) return;
    setItemIndex((index) => Math.min(group.items.length - 1, Math.max(0, index + delta)));
    if (view === "sheet" || view === "video") setView("compare");
  }, [group, view]);

  const stepGroup = useCallback((delta) => {
    const ids = [...review.groups.map((entry) => entry.id), CHECKS];
    const index = ids.indexOf(groupId);
    selectGroup(ids[Math.min(ids.length - 1, Math.max(0, index + delta))]);
  }, [review.groups, groupId, selectGroup]);

  const onKeyDown = (event) => {
    // The review owns the keyboard while it is open; app hotkeys wait.
    event.stopPropagation();
    if (event.target.closest?.("input, textarea, select")) return;
    const keys = {
      Escape: onClose,
      ArrowRight: () => step(1),
      ArrowLeft: () => step(-1),
      ArrowDown: () => stepGroup(1),
      ArrowUp: () => stepGroup(-1),
      c: () => setView((value) => (value === "compare" ? "shot" : "compare")),
    };
    const action = keys[event.key];
    if (action && !(event.target.getAttribute?.("role") === "slider" && event.key.startsWith("Arrow"))) {
      event.preventDefault();
      action();
    }
  };

  const openFolder = async () => {
    setOpenError("");
    const opened = await openFolderPath(root).catch(() => false);
    if (!opened) setOpenError("Windows couldn't open the folder.");
  };
  const openReport = async () => {
    setOpenError("");
    const opened = await openFolderPath(`${root}/report.html`).catch(() => false);
    if (!opened) setOpenError("Windows couldn't open report.html.");
  };

  const totals = countBySeverity([...review.general, ...review.groups.flatMap((entry) => entry.items.flatMap((part) => part.issues))]);
  const kit = manifest.vehicle?.kit;
  const created = manifest.createdAt ? new Date(manifest.createdAt) : null;

  return createPortal(
    <div className="kr-layer">
      <div
        ref={dialogRef}
        className="kr"
        role="dialog"
        aria-modal="true"
        aria-label={`Kit shoot review for ${manifest.vehicle?.modelName || "vehicle"}`}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="kr-head">
          <div className="kr-id">
            <h2 className="cx-display kr-name">{manifest.vehicle?.modelName || "Vehicle"}</h2>
            <p className="kr-meta">
              {kit ? <span>{kit.name}</span> : null}
              <span>{`${review.shotCount} shots`}</span>
              <span>{`${manifest.settings?.width}×${manifest.settings?.height}`}</span>
              {created && !Number.isNaN(created.getTime()) ? <span>{created.toLocaleString()}</span> : null}
              {manifest.complete === false ? <span className="is-warn">Partial run</span> : null}
            </p>
          </div>
          <div className="kr-actions">
            {openError ? <span className="kr-open-error" role="alert">{openError}</span> : null}
            <button type="button" className="cx-btn lv-btn-sm" onClick={openReport}>
              <FileText aria-hidden="true" />
              Report
            </button>
            <button type="button" className="cx-btn lv-btn-sm" onClick={openFolder}>
              <FolderOpen aria-hidden="true" />
              Folder
            </button>
            <button type="button" className="cx-icon-btn" aria-label="Close review" title="Close (Esc)" onClick={onClose}>
              <X aria-hidden="true" />
            </button>
          </div>
        </header>

        <nav className="kr-rail" aria-label="Slots">
          <ul>
            {review.groups.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className={`kr-rail-item ${entry.id === groupId ? "is-on" : ""}`}
                  aria-current={entry.id === groupId ? "true" : undefined}
                  onClick={() => selectGroup(entry.id)}
                >
                  <span className="kr-rail-title" title={entry.title}>{entry.title}</span>
                  <span className="kr-rail-sub">{entry.subtitle}</span>
                  <span className="kr-rail-count">{entry.items.length}</span>
                  {entry.issueCount ? <span className="kr-rail-flag" aria-label={`${entry.issueCount} checks`}>{entry.issueCount}</span> : null}
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className={`kr-rail-item kr-rail-checks ${groupId === CHECKS ? "is-on" : ""}`}
            aria-current={groupId === CHECKS ? "true" : undefined}
            onClick={() => selectGroup(CHECKS)}
          >
            <AlertTriangle aria-hidden="true" />
            <span className="kr-rail-title">Checks</span>
            <span className="kr-rail-sub">
              {totals.error + totals.warning + totals.info
                ? [totals.error ? `${totals.error} errors` : "", totals.warning ? `${totals.warning} warnings` : "", totals.info ? `${totals.info} notes` : ""].filter(Boolean).join(" · ")
                : "No problems"}
            </span>
          </button>
        </nav>

        {groupId === CHECKS || !group ? (
          <main className="kr-main is-checks">
            <ChecksView
              review={review}
              onJump={(target, part) => {
                setGroupId(target.id);
                setItemIndex(target.items.indexOf(part));
                setView(part.compareTo ? "compare" : "shot");
              }}
            />
          </main>
        ) : (
          <main className="kr-main">
            <div className="kr-toolbar">
              <div className="lv-seg kr-views" role="group" aria-label="View">
                <button type="button" className={`lv-seg-btn ${mode === "compare" ? "is-on" : ""}`} disabled={!canCompare} onClick={() => setView("compare")} title="Drag to compare with the base (C)">
                  <Columns2 aria-hidden="true" />Compare
                </button>
                <button type="button" className={`lv-seg-btn ${mode === "shot" ? "is-on" : ""}`} onClick={() => setView("shot")}>
                  <ImageIcon aria-hidden="true" />Shot
                </button>
                {item?.beforeAfter ? (
                  <button type="button" className={`lv-seg-btn ${mode === "pair" ? "is-on" : ""}`} onClick={() => setView("pair")}>
                    <Columns2 aria-hidden="true" />Saved pair
                  </button>
                ) : null}
                {group.sheet ? (
                  <button type="button" className={`lv-seg-btn ${mode === "sheet" ? "is-on" : ""}`} onClick={() => setView("sheet")}>
                    <LayoutGrid aria-hidden="true" />Sheet
                  </button>
                ) : null}
                {group.video ? (
                  <button type="button" className={`lv-seg-btn ${mode === "video" ? "is-on" : ""}`} onClick={() => setView("video")}>
                    <Play aria-hidden="true" />Video
                  </button>
                ) : null}
              </div>
              <span className="kr-pos">{`${Math.min(itemIndex, group.items.length - 1) + 1} / ${group.items.length}`}</span>
            </div>

            <div className="kr-stage">
              {mode === "compare" ? (
                <Compare
                  key={item.id}
                  cache={cache}
                  before={item.compareTo.file}
                  after={item.file}
                  beforeLabel={item.compareTo.title}
                  afterLabel={item.title}
                />
              ) : mode === "pair" ? (
                <Picture cache={cache} path={item.beforeAfter} alt={`${item.title} before and after`} className="kr-stage-img" />
              ) : mode === "sheet" ? (
                <Picture cache={cache} path={group.sheet} alt={`${group.title} sheet`} className="kr-stage-img" />
              ) : mode === "video" ? (
                <StageVideo cache={cache} path={group.video} />
              ) : (
                <Picture cache={cache} path={item?.file} alt={item?.title || ""} className="kr-stage-img" />
              )}
              <button type="button" className="kr-nav is-prev" aria-label="Previous shot" disabled={itemIndex <= 0} onClick={() => step(-1)}>
                <ChevronLeft aria-hidden="true" />
              </button>
              <button type="button" className="kr-nav is-next" aria-label="Next shot" disabled={itemIndex >= group.items.length - 1} onClick={() => step(1)}>
                <ChevronRight aria-hidden="true" />
              </button>
            </div>

            {item ? (
              <div className="kr-info">
                <div className="kr-info-id">
                  <h3 className="cx-display kr-part">{item.title}</h3>
                  <p className="kr-meta">
                    <span>{item.detail}</span>
                    {item.changed != null ? <span>{percent(item.changed)}</span> : null}
                    {item.isBase ? <span>Base for this {manifest.settings?.mode === "builds" ? "angle" : "slot"}</span> : null}
                  </p>
                </div>
                {item.issues.length ? (
                  <ul className="kr-issues">
                    {item.issues.map((entry, index) => (
                      <li key={`${entry.code}-${index}`} className={`is-${entry.severity}`}>
                        <span className="kr-dot" aria-hidden="true" />
                        {entry.message}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            <div className="kr-strip" role="group" aria-label={`${group.title} shots`}>
              {group.items.map((entry, index) => (
                <Thumb
                  key={entry.id}
                  cache={cache}
                  item={entry}
                  index={index}
                  selected={index === itemIndex}
                  onSelect={(next) => {
                    setItemIndex(next);
                    if (view === "sheet" || view === "video") setView("compare");
                  }}
                />
              ))}
            </div>
          </main>
        )}
      </div>
    </div>,
    document.body,
  );
}

function StageVideo({ cache, path }) {
  const file = useShootFile(cache, path);
  if (file.error) return <div className="kr-hole is-error">{`The video couldn't load: ${file.error}`}</div>;
  if (!file.url) return <div className="kr-hole is-loading" aria-label="Loading" />;
  return <video className="kr-stage-img" src={file.url} controls autoPlay loop muted playsInline />;
}
