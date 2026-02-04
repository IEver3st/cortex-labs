import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

const GRID = 32;

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

function buildSpherePoints() {
  const r = GRID * 0.31;
  const cx = (GRID - 1) / 2;
  const cy = (GRID - 1) / 2;
  const hx = cx - r * 0.35;
  const hy = cy - r * 0.45;

  const points = [];
  for (let y = 0; y < GRID; y += 1) {
    for (let x = 0; x < GRID; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy);
      if (dist > r) continue;

      const rim = 1 - dist / r;
      const highlight = 1 - Math.hypot(x - hx, y - hy) / (r * 1.35);
      const alpha = clamp(0.25 + rim * 0.5 + highlight * 0.4, 0.22, 0.95);
      const dither = (x + y) % 2 === 0 ? 1 : 0.92;
      points.push({ x, y, alpha: alpha * dither });
    }
  }
  return points;
}

function buildTrianglePoints() {
  const cx = (GRID - 1) / 2;
  const apexY = Math.round(GRID * 0.18);
  const baseY = Math.round(GRID * 0.83);
  const baseHalf = Math.round(GRID * 0.28);

  const points = [];
  for (let y = apexY; y <= baseY; y += 1) {
    const t = (y - apexY) / Math.max(1, baseY - apexY);
    const half = Math.round(baseHalf * t);
    const x0 = Math.round(cx - half);
    const x1 = Math.round(cx + half);
    for (let x = x0; x <= x1; x += 1) {
      if (x < 0 || x >= GRID) continue;
      const leftShade = x <= cx ? 0.55 : 0.8;
      const taper = 1 - t * 0.25;
      const alpha = clamp(leftShade * taper, 0.22, 0.9);
      const dither = (x + y) % 2 === 0 ? 1 : 0.9;
      points.push({ x, y, alpha: alpha * dither });
    }
  }
  return points;
}

const GLYPHS = {
  cube: buildCubePoints(),
  sphere: buildSpherePoints(),
  triangle: buildTrianglePoints(),
};

export function LoadingGlyph({ kind, className }) {
  const points = GLYPHS[kind] ?? GLYPHS.cube;
  return (
    <svg
      className={className || "loader-glyph"}
      viewBox={`0 0 ${GRID} ${GRID}`}
      role="img"
      aria-label={`Loading shape: ${kind}`}
      shapeRendering="crispEdges"
    >
      {points.map((point) => (
        <rect
          key={`${point.x}-${point.y}`}
          x={point.x}
          y={point.y}
          width={0.92}
          height={0.92}
          rx={0.18}
          fill="currentColor"
          opacity={point.alpha}
        />
      ))}
    </svg>
  );
}

export default function AppLoader({ variant = "boot" }) {
  const shapeOrder = useMemo(() => ["cube", "sphere", "triangle"], []);
  const [shapeIndex, setShapeIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setShapeIndex((prev) => (prev + 1) % shapeOrder.length);
    }, 900);

    return () => clearInterval(interval);
  }, [shapeOrder.length]);

  const kind = shapeOrder[shapeIndex] ?? "cube";
  const isBackground = variant === "background";

  return (
    <motion.div
      className={`app-loader${isBackground ? " app-loader--bg" : ""}`}
      initial={isBackground ? { opacity: 0 } : { opacity: 1 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
    >
      <motion.div
        className="loader-stage"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      >
        <motion.div
          className="loader-shape"
          animate={{ y: [0, -14, 0], rotate: [-2, 2, -2] }}
          transition={{ duration: 0.9, repeat: Infinity, ease: "easeInOut" }}
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={kind}
              className="loader-shape-inner"
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.92 }}
              transition={{ duration: 0.18 }}
            >
              <LoadingGlyph kind={kind} />
            </motion.div>
          </AnimatePresence>
        </motion.div>

        <div className="loader-meta">
          <div className="loader-title">Cortex Labs</div>
          <div className="loader-subtitle">Initializing...</div>
        </div>
      </motion.div>
    </motion.div>
  );
}
