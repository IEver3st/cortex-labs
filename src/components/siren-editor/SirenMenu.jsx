import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

function getUiZoom() {
  const zoom = Number.parseFloat(window.getComputedStyle(document.body).zoom);
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

export function Menu({ label, icon, disabled, title, children, ariaLabel, pressed, className }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState(null);
  const trigger = useRef(null);
  const panel = useRef(null);
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const zoom = getUiZoom();
    const rect = trigger.current.getBoundingClientRect();
    const rectLeft = rect.left / zoom;
    const rectTop = rect.top / zoom;
    const rectBottom = rect.bottom / zoom;
    const viewW = window.innerWidth / zoom;
    const viewH = window.innerHeight / zoom;
    const height = panel.current?.offsetHeight || 0;
    const width = Math.max(panel.current?.offsetWidth || 0, 240);
    const below = rectBottom + 4 + height < viewH;
    setPlace({
      left: Math.max(8, Math.min(rectLeft, viewW - width - 8)),
      top: below ? rectBottom + 4 : Math.max(8, rectTop - 4 - height),
    });
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (panel.current?.contains(event.target) || trigger.current?.contains(event.target)) return;
      setOpen(false);
    };
    const key = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", key);
    };
  }, [open]);
  useEffect(() => {
    if (open && place) panel.current?.querySelector("button:not(:disabled)")?.focus();
  }, [open, place]);
  return (
    <>
      <button ref={trigger} type="button" className={cx("cx-btn lv-btn-sm se-menu-trigger", className, pressed && "is-on")} disabled={disabled}
        title={title} aria-label={ariaLabel} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {icon}
        {label}
        <ChevronDown aria-hidden="true" />
      </button>
      {open ? createPortal(
        <div ref={panel} className="se-menu" role="menu" style={place ? { left: place.left, top: place.top } : { visibility: "hidden" }}
          onClick={(event) => { if (event.target.closest("button")) setOpen(false); }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            const items = [...panel.current.querySelectorAll("button:not(:disabled)")];
            const at = items.indexOf(document.activeElement);
            items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
          }}>
          {children}
        </div>,
        document.body,
      ) : null}
    </>
  );
}

export function MenuItem({ children, hint, onSelect, disabled, checked, title }) {
  const radio = checked !== undefined;
  return (
    <button type="button" role={radio ? "menuitemradio" : "menuitem"} aria-checked={radio ? checked : undefined}
      className="se-menu-item" onClick={onSelect} disabled={disabled} title={title}>
      <span>{children}</span>
      {hint ? <span className="se-menu-hint">{hint}</span> : null}
      {checked ? <Check className="se-menu-check" aria-hidden="true" /> : null}
    </button>
  );
}
