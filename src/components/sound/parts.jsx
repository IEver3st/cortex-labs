import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, FolderOpen } from "lucide-react";
import { DropButton, FileCard, splitPath } from "../workspace/parts";
import { plainError } from "../../lib/plain-error";

export function isTauri() {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

export function errorText(error) {
  return String(error?.message || error || "Unknown error");
}

export function isTyping(target) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function Seg({ label, value, options, onChange }) {
  return (
    <div className="lv-field">
      {label ? <span className="cx-label">{label}</span> : null}
      <div className="lv-seg" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={value === option.id}
            className={`lv-seg-btn ${value === option.id ? "is-on" : ""}`}
            disabled={option.disabled}
            title={option.title}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Note({ tone = "idle", children }) {
  const plain = tone === "error" && typeof children === "string" ? plainError(children) : null;
  return (
    <p className={`lv-slot-note is-${tone}`}>
      <span className="lv-dot" aria-hidden="true" />
      <span title={plain?.detail || undefined}>{plain ? plain.text : children}</span>
    </p>
  );
}

export function FolderField({ label, path, emptyTitle, emptyHint, onPick }) {
  const { name, folder } = splitPath(path);
  return (
    <div className="lv-field">
      <span className="cx-label">{label}</span>
      {path ? (
        <FileCard
          path={path}
          name={name}
          folder={folder}
          actions={(
            <button type="button" className="cx-icon-btn lv-file-act" onClick={onPick} title={`Choose another ${label.toLowerCase()}`} aria-label={`Choose another ${label.toLowerCase()}`}>
              <FolderOpen aria-hidden="true" />
            </button>
          )}
        />
      ) : (
        <DropButton title={emptyTitle} hint={emptyHint} onClick={onPick} />
      )}
    </div>
  );
}

export function CopyButton({ text, label }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className="cx-icon-btn"
      title={copied ? "Copied" : label}
      aria-label={label}
      onClick={() => navigator.clipboard?.writeText(text).then(() => setCopied(true)).catch(() => {})}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </button>
  );
}

export const pickedThisSession = new Set();

export function Key({ children }) {
  return <kbd className="cx-keycap">{children}</kbd>;
}

export function Coach({ children }) {
  if (!children) return null;
  return (
    <p className="es-coach" role="note">
      <span>{children}</span>
    </p>
  );
}

export function useDeckClearance() {
  const stateRef = useRef({ observer: null, host: null });
  return useCallback((node) => {
    const state = stateRef.current;
    state.observer?.disconnect();
    state.host?.style.removeProperty("--es-deck-clear");
    state.observer = null;
    state.host = null;
    if (!node || typeof ResizeObserver === "undefined") return;
    const host = node.closest(".lv-finder");
    if (!host) return;
    const observer = new ResizeObserver(() => host.style.setProperty("--es-deck-clear", `${node.offsetHeight}px`));
    observer.observe(node);
    state.observer = observer;
    state.host = host;
  }, []);
}

export function repaintOnResizeAndTheme(canvas, paint) {
  const resize = new ResizeObserver(() => paint());
  resize.observe(canvas);
  const theme = new MutationObserver(() => paint());
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-resolved-theme", "data-theme-preset", "style"] });
  return () => {
    resize.disconnect();
    theme.disconnect();
  };
}
