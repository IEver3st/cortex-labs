import { useEffect, useState } from "react";
import { motion } from "motion/react";
import cortexLogo from "../../src-tauri/icons/cortex-logo.svg";

const GRID = 32;
const SEGMENTS = 16;

const BOOT_LINES = [
  "renderer.init() → ok",
  "workspace.mount() → ok",
  "shaders compiled",
  "runtime ready",
];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function buildCubePoints() {
  const S = 8;
  const scaleX = 2;
  const scaleY = 1;

  const temp = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  const pushPoint = (x, y, z, alpha) => {
    const px = (x - y) * scaleX;
    const py = (x + y - 2 * z) * scaleY;
    temp.push({ px, py, alpha });
    minX = Math.min(minX, px);
    maxX = Math.max(maxX, px);
    minY = Math.min(minY, py);
    maxY = Math.max(maxY, py);
  };

  for (let x = 0; x < S; x += 1) {
    for (let y = 0; y < S; y += 1) {
      const z = S - 1;
      pushPoint(x, y, z, 0.95);
    }
  }

  for (let y = 0; y < S; y += 1) {
    for (let z = 0; z < S; z += 1) {
      const x = S - 1;
      const dither = (y + z) % 2 === 0;
      if (dither) pushPoint(x, y, z, 0.65);
    }
  }

  for (let x = 0; x < S; x += 1) {
    for (let z = 0; z < S; z += 1) {
      const y = S - 1;
      const dither = (x + z) % 2 === 0;
      if (dither) pushPoint(x, y, z, 0.45);
    }
  }

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const offsetX = Math.floor((GRID - width) / 2) - minX;
  const offsetY = Math.floor((GRID - height) / 2) - minY;

  const map = new Map();
  for (const point of temp) {
    const x = point.px + offsetX;
    const y = point.py + offsetY;
    if (x < 0 || y < 0 || x >= GRID || y >= GRID) continue;
    const key = `${x},${y}`;
    const prev = map.get(key);
    map.set(key, prev ? Math.max(prev, point.alpha) : point.alpha);
  }

  return Array.from(map.entries())
    .map(([key, alpha]) => {
      const [x, y] = key.split(",").map((value) => Number.parseInt(value, 10));
      return { x, y, alpha };
    })
    .sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));
}

const CUBE_POINTS = buildCubePoints();

// Compute per-dot diagonal wave delay for materialization effect
const CUBE_DELAYS = (() => {
  const maxDiag = (GRID - 1) * 2;
  return CUBE_POINTS.map((p) => ((p.x + p.y) / maxDiag) * 0.55);
})();

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

export default function AppLoader({ variant = "boot" }) {
  const [visibleLines, setVisibleLines] = useState(0);
  const [litSegments, setLitSegments] = useState(0);

  const isBackground = variant === "background";

  useEffect(() => {
    if (isBackground) return;
    // Reveal boot lines one by one, paired with segment fill
    const timers = BOOT_LINES.map((_, i) =>
      setTimeout(() => {
        setVisibleLines(i + 1);
        setLitSegments(Math.round(((i + 1) / BOOT_LINES.length) * SEGMENTS));
      }, 600 + i * 480)
    );
    return () => timers.forEach(clearTimeout);
  }, [isBackground]);

  if (isBackground) {
    return (
      <motion.div
        className="app-loader app-loader--bg"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="loader-bg-inner">
          <motion.div
            className="loader-shape-sm"
            animate={{ opacity: [0.35, 0.6, 0.35] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
          >
            <LoadingGlyph />
          </motion.div>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      className="app-loader"
      initial={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.5, ease: "easeInOut" }}
    >
      <div className="loader-stage">
        {/* Logo */}
        <motion.div
          className="loader-glyph-wrap"
          initial={{ opacity: 0, scale: 0.88 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
        >
          <LoadingGlyph animate />
        </motion.div>

        {/* Title */}
        <motion.div
          className="loader-meta"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3, duration: 0.4 }}
        >
          <div className="loader-title">CORTEX STUDIO</div>
        </motion.div>

        {/* Boot log */}
        <motion.div
          className="loader-boot-log"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5, duration: 0.3 }}
        >
          {BOOT_LINES.map((line, i) => (
            <div
              key={line}
              className="loader-log-line"
              style={{
                opacity: i < visibleLines ? 1 : 0,
                color: i === visibleLines - 1
                  ? "oklch(0.72 0.13 182)"
                  : "oklch(0.45 0.05 182)",
                transition: "opacity 0.2s ease, color 0.6s ease",
              }}
            >
              <span className="loader-log-prompt">›</span>
              {line}
            </div>
          ))}
        </motion.div>


      </div>
    </motion.div>
  );
}
