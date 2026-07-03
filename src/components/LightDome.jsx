import { useRef, useCallback } from "react";

/**
 * LightDome — unified 3D hemisphere lighting control.
 *
 * A single interactive dome graphic where dragging the sun indicator
 * updates both azimuth (0–360°) and elevation (0–90°) simultaneously.
 *
 * Mapping:
 *   angle from center → azimuth (clockwise from north)
 *   distance from center → elevation (center = 90° zenith, edge = 0° horizon)
 */
export default function LightDome({
  azimuth = 54,
  elevation = 46,
  onAzimuthChange,
  onElevationChange,
}) {
  const svgRef = useRef(null);

  // Dome geometry constants (viewBox 0 0 100 100, center at 50,50)
  const CX = 50;
  const CY = 50;
  const R_MAX = 42; // outer ring radius (horizon)

  // Forward projection: (azimuth, elevation) → screen (x, y)
  const azRad = azimuth * (Math.PI / 180);
  const elRad = elevation * (Math.PI / 180);
  const r = ((90 - elevation) / 90) * R_MAX;
  const sunX = CX + r * Math.sin(azRad);
  const sunY = CY - r * Math.cos(azRad);

  // Inverse projection: screen (x, y) → (azimuth, elevation)
  const computeFromPointer = useCallback((clientX, clientY) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    // Map screen pixels to viewBox coordinates
    const sx = ((clientX - rect.left) / rect.width) * 100;
    const sy = ((clientY - rect.top) / rect.height) * 100;
    const dx = sx - CX;
    const dy = CY - sy; // flip y so up = positive
    const dist = Math.sqrt(dx * dx + dy * dy);
    const clampedDist = Math.min(dist, R_MAX);
    // Azimuth: atan2(dx, dy) gives clockwise from north
    let az = Math.atan2(dx, dy) * (180 / Math.PI);
    if (az < 0) az += 360;
    // Elevation: center = 90°, edge = 0°
    const el = 90 - (clampedDist / R_MAX) * 90;
    onAzimuthChange?.(Math.round(az));
    onElevationChange?.(Math.round(el));
  }, [onAzimuthChange, onElevationChange]);

  const onPointerDown = useCallback((e) => {
    e.preventDefault();
    const svg = e.currentTarget;
    svg.setPointerCapture(e.pointerId);
    computeFromPointer(e.clientX, e.clientY);
    const onMove = (ev) => computeFromPointer(ev.clientX, ev.clientY);
    const onUp = () => {
      svg.style.cursor = "crosshair";
      svg.removeEventListener("pointermove", onMove);
      svg.removeEventListener("pointerup", onUp);
      svg.removeEventListener("pointercancel", onUp);
    };
    svg.style.cursor = "grabbing";
    svg.addEventListener("pointermove", onMove);
    svg.addEventListener("pointerup", onUp);
    svg.addEventListener("pointercancel", onUp);
  }, [computeFromPointer]);

  // Elevation contour rings (30°, 60°)
  const elevationRings = [30, 60].map((deg) => {
    const ringR = ((90 - deg) / 90) * R_MAX;
    return { deg, r: ringR };
  });

  // Cardinal azimuth ticks
  const cardinals = [
    { label: "N", deg: 0 },
    { label: "E", deg: 90 },
    { label: "S", deg: 180 },
    { label: "W", deg: 270 },
  ];

  return (
    <div className="cs-light-dome">
      <svg
        ref={svgRef}
        viewBox="0 0 100 100"
        className="cs-light-dome-svg"
        style={{
          cursor: "crosshair",
          touchAction: "none",
          userSelect: "none",
          WebkitUserSelect: "none",
        }}
        onPointerDown={onPointerDown}
      >
        {/* Dome radial gradient fill */}
        <defs>
          <radialGradient id="cs-dome-grad" cx="50%" cy="42%" r="55%">
            <stop offset="0%" stopColor="rgba(217,121,82,0.06)" />
            <stop offset="60%" stopColor="rgba(90,85,79,0.04)" />
            <stop offset="100%" stopColor="rgba(31,30,29,0.12)" />
          </radialGradient>
        </defs>
        <circle cx={CX} cy={CY} r={R_MAX} fill="url(#cs-dome-grad)" />

        {/* Outer horizon ring */}
        <circle
          cx={CX} cy={CY} r={R_MAX}
          fill="none"
          stroke="rgba(90,85,79,0.35)"
          strokeWidth="0.6"
          style={{ pointerEvents: "none" }}
        />

        {/* Ghost ring slightly inside horizon */}
        <circle
          cx={CX} cy={CY} r={R_MAX + 2.5}
          fill="none"
          stroke="rgba(90,85,79,0.1)"
          strokeWidth="0.4"
          style={{ pointerEvents: "none" }}
        />

        {/* Elevation contour rings */}
        {elevationRings.map(({ deg, r: ringR }) => (
          <circle
            key={deg}
            cx={CX} cy={CY} r={ringR}
            fill="none"
            stroke="rgba(90,85,79,0.18)"
            strokeWidth="0.4"
            strokeDasharray="1.2 2"
            style={{ pointerEvents: "none" }}
          />
        ))}

        {/* Cardinal tick marks */}
        {cardinals.map(({ label, deg }) => {
          const rad = deg * (Math.PI / 180);
          const x1 = CX + (R_MAX - 3) * Math.sin(rad);
          const y1 = CY - (R_MAX - 3) * Math.cos(rad);
          const x2 = CX + (R_MAX + 3) * Math.sin(rad);
          const y2 = CY - (R_MAX + 3) * Math.cos(rad);
          const lx = CX + (R_MAX + 7) * Math.sin(rad);
          const ly = CY - (R_MAX + 7) * Math.cos(rad);
          return (
            <g key={label} style={{ pointerEvents: "none" }}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(90,85,79,0.5)" strokeWidth="0.7" />
              <text
                x={lx} y={ly}
                fontSize="4"
                fontFamily="var(--font-hud)"
                fill="rgba(90,85,79,0.6)"
                textAnchor="middle"
                dominantBaseline="central"
              >
                {label}
              </text>
            </g>
          );
        })}

        {/* Elevation label ticks (0°, 30°, 60°, 90°) along south axis */}
        {[0, 30, 60, 90].map((deg) => {
          const tickR = ((90 - deg) / 90) * R_MAX;
          return (
            <text
              key={deg}
              x={CX + tickR + 2}
              y={CY + 1}
              fontSize="3"
              fontFamily="var(--font-hud)"
              fill="rgba(90,85,79,0.35)"
              textAnchor="start"
              dominantBaseline="central"
              style={{ pointerEvents: "none" }}
            >
              {deg}°
            </text>
          );
        })}

        {/* Center dot (zenith) */}
        <circle cx={CX} cy={CY} r="1" fill="rgba(90,85,79,0.3)" style={{ pointerEvents: "none" }} />

        {/* Spoke from center to sun */}
        <line
          x1={CX} y1={CY} x2={sunX} y2={sunY}
          stroke="rgba(217,121,82,0.35)"
          strokeWidth="0.6"
          style={{ pointerEvents: "none" }}
        />

        {/* Sun indicator */}
        <g style={{ transform: `translate(${sunX}px, ${sunY}px)`, pointerEvents: "none" }}>
          <circle cx="0" cy="0" r="7" fill="rgba(217,121,82,0.1)" />
          <circle cx="0" cy="0" r="4" fill="rgba(217,121,82,0.22)" />
          <circle cx="0" cy="0" r="2.5" fill="#D97952" />
          <circle cx="0" cy="0" r="1.2" fill="rgba(252,248,240,0.9)" />
        </g>
      </svg>

      {/* Digital readouts */}
      <div className="cs-light-dome-readouts">
        <div className="cs-light-dome-readout">
          <span className="cs-light-dome-readout-label">AZ</span>
          <span className="cs-light-dome-readout-value">{azimuth}°</span>
        </div>
        <div className="cs-light-dome-readout">
          <span className="cs-light-dome-readout-label">EL</span>
          <span className="cs-light-dome-readout-value">{elevation}°</span>
        </div>
      </div>
    </div>
  );
}
