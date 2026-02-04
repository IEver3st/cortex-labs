import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Settings } from "lucide-react";

function useHoverIntent({ closeDelayMs = 120 } = {}) {
  const [open, setOpen] = useState(false);
  const timerRef = useRef(null);

  const clear = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const onEnter = () => {
    clear();
    setOpen(true);
  };

  const onLeave = () => {
    clear();
    timerRef.current = setTimeout(() => setOpen(false), closeDelayMs);
  };

  useEffect(() => () => clear(), []);

  return { open, setOpen, onEnter, onLeave };
}

function ColorField({ label, value, onChange, onReset }) {
  return (
    <div className="settings-row">
      <div className="settings-row-label">{label}</div>
      <div className="settings-color">
        <div className="color-swatch-wrapper">
          <div className="color-swatch" style={{ background: value }} />
          <input
            type="color"
            value={value}
            onChange={(event) => onChange(event.currentTarget.value)}
            className="color-picker-native"
            aria-label={`${label} picker`}
          />
        </div>
        <input
          className="settings-input mono"
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
        <button type="button" className="settings-mini" onClick={onReset} aria-label={`Reset ${label}`}>
          Reset
        </button>
      </div>
    </div>
  );
}

export default function SettingsMenu({
  defaults,
  builtInDefaults,
  onSave,
}) {
  const { open, setOpen, onEnter, onLeave } = useHoverIntent({ closeDelayMs: 140 });
  const [hoveringIcon, setHoveringIcon] = useState(false);
  const wrapperRef = useRef(null);
  const popoverRef = useRef(null);
  const [popoverStyle, setPopoverStyle] = useState({});

  const initialDraft = useMemo(() => ({ ...defaults }), [defaults]);
  const [draft, setDraft] = useState(initialDraft);

  useEffect(() => {
    setDraft({ ...defaults });
  }, [defaults]);

  useLayoutEffect(() => {
    if (!open) return;
    if (typeof window === "undefined") return;

    let frame = 0;
    const padding = 12;
    const gap = 8;

    const update = () => {
      const anchor = wrapperRef.current?.getBoundingClientRect();
      const popover = popoverRef.current?.getBoundingClientRect();
      if (!anchor || !popover) return;

      const panel = wrapperRef.current?.closest?.(".control-panel");
      let panelLeft = anchor.left;
      let panelPaddingLeft = 0;
      let panelPaddingRight = 0;
      let panelWidth = popover.width;

      if (panel) {
        const panelRect = panel.getBoundingClientRect();
        panelLeft = panelRect.left;
        const styles = window.getComputedStyle(panel);
        panelPaddingLeft = parseFloat(styles.paddingLeft) || 0;
        panelPaddingRight = parseFloat(styles.paddingRight) || 0;
        panelWidth = Math.max(0, panelRect.width - panelPaddingLeft - panelPaddingRight);
      }

      const maxWidth = Math.max(160, window.innerWidth - padding * 2);
      const width = Math.min(panelWidth || popover.width, maxWidth);

      let left = panelLeft + panelPaddingLeft;
      left = Math.min(Math.max(left, padding), window.innerWidth - width - padding);

      let top = anchor.bottom + gap;
      const maxTop = window.innerHeight - popover.height - padding;
      if (top > maxTop) {
        const above = anchor.top - popover.height - gap;
        top = above >= padding ? above : Math.max(padding, maxTop);
      }

      setPopoverStyle({
        left: `${Math.round(left)}px`,
        top: `${Math.round(top)}px`,
        width: `${Math.round(width)}px`,
      });
    };

    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };

    schedule();

    const resizeObserver = new ResizeObserver(schedule);
    if (popoverRef.current) resizeObserver.observe(popoverRef.current);
    if (wrapperRef.current) resizeObserver.observe(wrapperRef.current);

    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [open]);

  const save = () => {
    onSave?.(draft);
    setOpen(false);
  };

  return (
    <div
      ref={wrapperRef}
      className="settings-anchor"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <motion.button
        type="button"
        className="settings-cog"
        aria-label="Settings"
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onMouseEnter={() => setHoveringIcon(true)}
        onMouseLeave={() => setHoveringIcon(false)}
      >
        <motion.span
          className="settings-cog-icon"
          animate={
            hoveringIcon
              ? { rotate: 360 }
              : { rotate: 0 }
          }
          transition={
            hoveringIcon
              ? { repeat: Infinity, duration: 0.8, ease: "linear" }
              : { duration: 0.2, ease: [0.22, 1, 0.36, 1] }
          }
        >
          <Settings className="settings-cog-svg" />
        </motion.span>
      </motion.button>

      <AnimatePresence>
        {open ? (
          <motion.div
            className="settings-pop"
            ref={popoverRef}
            style={popoverStyle}
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.985 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="settings-title">Defaults</div>

            <div className="settings-row">
              <div className="settings-row-label">Apply texture mode</div>
              <div className="settings-seg">
                <button
                  type="button"
                  className={`settings-seg-btn ${draft.textureMode === "everything" ? "is-on" : ""}`}
                  onClick={() => setDraft((p) => ({ ...p, textureMode: "everything" }))}
                >
                  Everything
                </button>
                <button
                  type="button"
                  className={`settings-seg-btn ${draft.textureMode === "livery" ? "is-on" : ""}`}
                  onClick={() => setDraft((p) => ({ ...p, textureMode: "livery" }))}
                >
                  Livery
                </button>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-label">Exterior only</div>
              <button
                type="button"
                className={`settings-toggle ${draft.liveryExteriorOnly ? "is-on" : ""}`}
                onClick={() => setDraft((p) => ({ ...p, liveryExteriorOnly: !p.liveryExteriorOnly }))}
                aria-pressed={draft.liveryExteriorOnly}
              >
                <span className="settings-toggle-dot" />
              </button>
            </div>

            <ColorField
              label="Body"
              value={draft.bodyColor}
              onChange={(value) => setDraft((p) => ({ ...p, bodyColor: value }))}
              onReset={() => setDraft((p) => ({ ...p, bodyColor: builtInDefaults.bodyColor }))}
            />
            <ColorField
              label="Background"
              value={draft.backgroundColor}
              onChange={(value) => setDraft((p) => ({ ...p, backgroundColor: value }))}
              onReset={() => setDraft((p) => ({ ...p, backgroundColor: builtInDefaults.backgroundColor }))}
            />

            <div className="settings-actions">
              <button
                type="button"
                className="settings-secondary"
                onClick={() => setDraft({ ...builtInDefaults })}
              >
                Reset all
              </button>
              <button type="button" className="settings-primary" onClick={save}>
                Save
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
