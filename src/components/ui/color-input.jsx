import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pipette } from "lucide-react";

const HEX_RE = /^#?([\da-f]{6})$/i;
const GAP = 8;
const EDGE = 8;
const RECENT_KEY = "cortex-studio:recent-colours.v1";
const RECENT_MAX = 10;

function readRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(list) ? list.filter((entry) => HEX_RE.test(entry)).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function rememberRecent(hex) {
  const next = [hex, ...readRecent().filter((entry) => entry !== hex)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    return;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeHex(value, fallback = "#ffffff") {
  const match = HEX_RE.exec(String(value || "").trim());
  return match ? `#${match[1].toLowerCase()}` : fallback;
}

function hexToHsv(hex) {
  const value = normalizeHex(hex).slice(1);
  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  let h = 0;
  if (delta) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
  }
  return { h: (h * 60 + 360) % 360, s: max ? delta / max : 0, v: max };
}

function hsvToHex({ h, s, v }) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `#${[r, g, b].map((part) => Math.round((part + m) * 255).toString(16).padStart(2, "0")).join("")}`;
}

function placePanel(anchor, panel) {
  const rect = anchor.getBoundingClientRect();
  const { width, height } = panel.getBoundingClientRect();
  const viewW = window.innerWidth;
  const viewH = window.innerHeight;
  const column = anchor.closest("aside");
  const fitTop = (top) => clamp(top, EDGE, viewH - height - EDGE);
  if (column) {
    const box = column.getBoundingClientRect();
    const onRight = box.left + box.width / 2 > viewW / 2;
    const left = onRight ? box.left - GAP - width : box.right + GAP;
    if (left >= EDGE && left + width <= viewW - EDGE) return { left, top: fitTop(rect.top - EDGE) };
  }
  const left = clamp(rect.left, EDGE, viewW - width - EDGE);
  const below = rect.bottom + GAP + height <= viewH - EDGE;
  return { left, top: below ? rect.bottom + GAP : fitTop(rect.top - GAP - height) };
}

function useDrag(onMove) {
  return useCallback((event) => {
    if (event.button !== 0) return;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move = (next) => {
      const rect = target.getBoundingClientRect();
      onMove(clamp((next.clientX - rect.left) / rect.width, 0, 1), clamp((next.clientY - rect.top) / rect.height, 0, 1));
    };
    move(event);
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }, [onMove]);
}

function ColorPanel({ anchor, value, label, onChange, onClose }) {
  const panelRef = useRef(null);
  const [hsv, setHsv] = useState(() => hexToHsv(value));
  const [text, setText] = useState(normalizeHex(value).toUpperCase());
  const [position, setPosition] = useState(null);
  const lastSent = useRef(normalizeHex(value));
  const [recent] = useState(readRecent);

  useEffect(() => {
    const opened = normalizeHex(value);
    return () => {
      if (lastSent.current !== opened) rememberRecent(lastSent.current);
    };
  }, []);

  useEffect(() => {
    const next = normalizeHex(value);
    if (next === lastSent.current) return;
    lastSent.current = next;
    setHsv(hexToHsv(next));
    setText(next.toUpperCase());
  }, [value]);

  useLayoutEffect(() => {
    const place = () => {
      if (panelRef.current) setPosition(placePanel(anchor, panelRef.current));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor]);

  useEffect(() => {
    panelRef.current?.querySelector(".cx-color-plane")?.focus({ preventScroll: true });
    const onDown = (event) => {
      if (panelRef.current?.contains(event.target) || anchor.contains(event.target)) return;
      onClose(false);
    };
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose(true);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [anchor, onClose]);

  const commit = useCallback((next) => {
    setHsv(next);
    const hex = hsvToHex(next);
    setText(hex.toUpperCase());
    if (hex !== lastSent.current) {
      lastSent.current = hex;
      onChange(hex);
    }
  }, [onChange]);

  const dragPlane = useDrag(useCallback((x, y) => commit({ ...hsv, s: x, v: 1 - y }), [commit, hsv]));
  const dragHue = useDrag(useCallback((x) => commit({ ...hsv, h: Math.min(359.9, x * 360) }), [commit, hsv]));

  const nudgePlane = (event) => {
    const step = event.shiftKey ? 0.1 : 0.02;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    commit({ ...hsv, s: clamp(hsv.s + move[0], 0, 1), v: clamp(hsv.v + move[1], 0, 1) });
  };
  const nudgeHue = (event) => {
    const step = event.shiftKey ? 15 : 2;
    const delta = event.key === "ArrowLeft" || event.key === "ArrowDown" ? -step : event.key === "ArrowRight" || event.key === "ArrowUp" ? step : 0;
    if (!delta) return;
    event.preventDefault();
    commit({ ...hsv, h: (hsv.h + delta + 360) % 360 });
  };

  const pick = async () => {
    try {
      const result = await new window.EyeDropper().open();
      if (result?.sRGBHex) commit(hexToHsv(normalizeHex(result.sRGBHex)));
    } catch {
      return;
    }
  };

  const hueColor = hsvToHex({ h: hsv.h, s: 1, v: 1 });
  const current = hsvToHex(hsv);

  return createPortal(
    <div
      className="cx-color-layer"
      style={position ? { left: position.left, top: position.top } : { left: 0, top: 0, visibility: "hidden" }}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div
        ref={panelRef}
        className="cx-color-panel"
        role="dialog"
        aria-label={label}
        onBlur={(event) => {
          const next = event.relatedTarget;
          if (next && !panelRef.current?.contains(next) && !anchor.contains(next)) onClose(false);
        }}
      >
        <div
          className="cx-color-plane"
          style={{ "--hue": hueColor }}
          role="slider"
          tabIndex={0}
          aria-label="Saturation and brightness"
          aria-valuetext={`${Math.round(hsv.s * 100)}% saturation, ${Math.round(hsv.v * 100)}% brightness`}
          onPointerDown={dragPlane}
          onKeyDown={nudgePlane}
        >
          <span className="cx-color-plane-thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: current }} />
        </div>
        <div
          className="cx-color-hue"
          role="slider"
          tabIndex={0}
          aria-label="Hue"
          aria-valuemin={0}
          aria-valuemax={360}
          aria-valuenow={Math.round(hsv.h)}
          onPointerDown={dragHue}
          onKeyDown={nudgeHue}
        >
          <span className="cx-color-hue-thumb" style={{ left: `${(hsv.h / 360) * 100}%`, background: hueColor }} />
        </div>
        <div className="cx-color-row">
          <span className="cx-color-preview" style={{ background: current }} aria-hidden="true" />
          <input
            className="cx-color-hex"
            value={text}
            spellCheck={false}
            maxLength={7}
            aria-label={`${label} hex`}
            onChange={(event) => {
              setText(event.target.value);
              const match = HEX_RE.exec(event.target.value.trim());
              if (match) commit(hexToHsv(`#${match[1]}`));
            }}
            onBlur={() => setText(current.toUpperCase())}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              onClose(true);
            }}
          />
          {typeof window !== "undefined" && "EyeDropper" in window ? (
            <button type="button" className="cx-icon-btn" onClick={pick} aria-label="Pick a colour from the screen" title="Pick a colour from the screen">
              <Pipette aria-hidden="true" />
            </button>
          ) : null}
        </div>
        {recent.length ? (
          <div className="cx-color-recent" role="group" aria-label="Recent colours">
            <span className="cx-label cx-color-recent-label" aria-hidden="true">Recent</span>
            {recent.map((hex) => (
              <button
                key={hex}
                type="button"
                className={`cx-color-recent-chip ${hex === current ? "is-on" : ""}`}
                style={{ background: hex }}
                aria-label={`Use ${hex.toUpperCase()}`}
                title={hex.toUpperCase()}
                onClick={() => commit(hexToHsv(hex))}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

export function ColorInput({ value, onChange, label, className = "cx-color-hit", swatch = false, disabled = false }) {
  const buttonRef = useRef(null);
  const [open, setOpen] = useState(false);
  const close = useCallback((refocus) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={className}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((state) => !state);
        }}
      >
        {swatch ? <span className="cx-color-swatch" style={{ background: normalizeHex(value) }} aria-hidden="true" /> : null}
      </button>
      {open && buttonRef.current ? (
        <ColorPanel anchor={buttonRef.current} value={value} label={label} onChange={onChange} onClose={close} />
      ) : null}
    </>
  );
}
