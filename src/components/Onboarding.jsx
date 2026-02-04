import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { LoadingGlyph } from "./AppLoader";

const SHAPES = ["cube", "sphere", "triangle"];

function ColorPick({ label, value, onChange }) {
  return (
    <div className="onb-row">
      <div className="onb-label">{label}</div>
      <div className="onb-color">
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
        <input className="onb-input mono" value={value} onChange={(event) => onChange(event.currentTarget.value)} />
      </div>
    </div>
  );
}

export default function Onboarding({ initialDefaults, onComplete }) {
  const [shapeIndex, setShapeIndex] = useState(0);
  const [draft, setDraft] = useState({ ...initialDefaults });
  const kind = SHAPES[shapeIndex % SHAPES.length];

  useEffect(() => {
    const interval = setInterval(() => setShapeIndex((p) => p + 1), 850);
    return () => clearInterval(interval);
  }, []);

  const motionEase = useMemo(() => [0.22, 1, 0.36, 1], []);

  return (
    <motion.div
      className="onb-shell"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.35, ease: motionEase }}
    >
      <motion.div
        className="onb-card"
        initial={{ opacity: 0, y: 12, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.99 }}
        transition={{ duration: 0.38, ease: motionEase }}
      >
        <div className="onb-left">
          <motion.div
            className="onb-glyph"
            animate={{ y: [0, -12, 0], rotate: [-1.5, 1.5, -1.5] }}
            transition={{ duration: 0.9, repeat: Infinity, ease: "easeInOut" }}
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={kind}
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.92 }}
                transition={{ duration: 0.18 }}
              >
                <LoadingGlyph kind={kind} className="onb-glyph-svg" />
              </motion.div>
            </AnimatePresence>
          </motion.div>
          <div className="onb-brand">Cortex Labs</div>
          <div className="onb-sub">Set your defaults once. You can change them later.</div>
        </div>

        <motion.div
          className="onb-right"
          initial="hidden"
          animate="show"
          variants={{
            hidden: { opacity: 0 },
            show: { opacity: 1, transition: { staggerChildren: 0.06 } },
          }}
        >
          <motion.div className="onb-section" variants={{ hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0 } }}>
            <div className="onb-title">Defaults</div>
            <div className="onb-hint">These will be applied on startup.</div>
          </motion.div>

          <motion.div className="onb-section" variants={{ hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0 } }}>
            <div className="onb-row">
              <div className="onb-label">Apply texture mode</div>
              <div className="onb-seg">
                <button
                  type="button"
                  className={`onb-seg-btn ${draft.textureMode === "everything" ? "is-on" : ""}`}
                  onClick={() => setDraft((p) => ({ ...p, textureMode: "everything" }))}
                >
                  Everything
                </button>
                <button
                  type="button"
                  className={`onb-seg-btn ${draft.textureMode === "livery" ? "is-on" : ""}`}
                  onClick={() => setDraft((p) => ({ ...p, textureMode: "livery" }))}
                >
                  Livery
                </button>
              </div>
            </div>

            <div className="onb-row">
              <div className="onb-label">Exterior only</div>
              <button
                type="button"
                className={`onb-toggle ${draft.liveryExteriorOnly ? "is-on" : ""}`}
                onClick={() => setDraft((p) => ({ ...p, liveryExteriorOnly: !p.liveryExteriorOnly }))}
                aria-pressed={draft.liveryExteriorOnly}
              >
                <span className="onb-toggle-dot" />
              </button>
            </div>
          </motion.div>

          <motion.div className="onb-section" variants={{ hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0 } }}>
            <ColorPick
              label="Body"
              value={draft.bodyColor}
              onChange={(value) => setDraft((p) => ({ ...p, bodyColor: value }))}
            />
            <ColorPick
              label="Background"
              value={draft.backgroundColor}
              onChange={(value) => setDraft((p) => ({ ...p, backgroundColor: value }))}
            />
          </motion.div>

          <motion.div className="onb-actions" variants={{ hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0 } }}>
            <button type="button" className="onb-primary" onClick={() => onComplete?.(draft)}>
              Continue
            </button>
          </motion.div>
        </motion.div>
      </motion.div>
    </motion.div>
  );
}
