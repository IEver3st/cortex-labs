import { motion } from "motion/react";
import cortexLogo from "../../src-tauri/icons/128x128@2x.png";
import appMeta from "../../package.json";
import markLeft from "../assets/brand/mark-left.png";
import markRight from "../assets/brand/mark-right.png";
import markLid from "../assets/brand/mark-lid.png";
import markBase from "../assets/brand/mark-base.png";
import markInner from "../assets/brand/mark-inner.png";
import "./AppLoader.css";

/* The mark's faces, cut from the real icon by colour with
   tools/split-mark-faces.py. Stacked in place they recombine into the icon,
   so the assembly always lands on the true logo. */
const FACES = [
  { id: "left", src: markLeft },
  { id: "right", src: markRight },
  { id: "lid", src: markLid },
  { id: "base", src: markBase },
  { id: "inner", src: markInner },
];

function MarkFaces({ className }) {
  return (
    <div className={`cx-faces ${className}`} aria-hidden="true">
      {FACES.map((face) => (
        <img
          key={face.id}
          className={`cx-face cx-face--${face.id}`}
          src={face.src}
          alt=""
          draggable={false}
        />
      ))}
      <img className="cx-face-whole" src={cortexLogo} alt="" draggable={false} />
    </div>
  );
}

export function LoadingGlyph({ className, animate: doAnimate = false, ...props }) {
  const classes = [className || "loader-glyph", doAnimate ? "loader-glyph-animated" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <img
      src={cortexLogo}
      className={classes}
      alt="Cortex Studio logo"
      draggable={false}
      {...props}
    />
  );
}

/** Compact loader for panes and in-viewer loading: the mark's faces drift
 *  apart and rejoin while work is genuinely in progress. */
function MarkLoader({ label, variant }) {
  return (
    <motion.div
      className={`app-loader app-loader--${variant}`}
      role="status"
      aria-live="polite"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
    >
      <div className="cx-mark-loader">
        <MarkFaces className="cx-mark-loader-glyph is-looping" />
        <span className="cx-mark-loader-label">{label}</span>
      </div>
    </motion.div>
  );
}

export default function AppLoader({ variant = "boot" }) {
  if (variant === "background") return <MarkLoader variant="background" label="Loading model" />;
  if (variant === "pane") return <MarkLoader variant="pane" label="Loading workspace" />;

  return (
    <motion.div
      className="app-loader app-loader--boot"
      role="status"
      aria-label="Starting Cortex Studio"
      initial={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25, ease: [0.2, 0.8, 0.2, 1] }}
    >
      <div className="cx-intro-field" aria-hidden="true" />
      <motion.div
        className="cx-intro"
        exit={{ scale: 1.04, y: -6 }}
        transition={{ duration: 0.25, ease: [0.2, 0.8, 0.2, 1] }}
      >
        <MarkFaces className="cx-intro-mark is-assembling" />
        <div className="cx-intro-lockup">
          <span className="cx-intro-word cx-display">
            <span>Cortex <span className="cx-intro-accent">Studio</span></span>
          </span>
          <span className="cx-intro-version">v{appMeta.version}</span>
        </div>
        <div className="cx-intro-progress" aria-hidden="true">
          <span />
        </div>
      </motion.div>
    </motion.div>
  );
}
