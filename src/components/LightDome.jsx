import { useCallback, useId, useRef } from "react";
import {
  getLightCompassLabel,
  LIGHT_DOME_CENTER,
  LIGHT_DOME_RADIUS,
  lightDirectionFromPoint,
  normalizeLightAzimuth,
  projectLightDirection,
} from "../lib/light-direction";

const LIGHT_PRESETS = [
  { id: "studio", label: "Studio", azimuth: 54, elevation: 46 },
  { id: "front", label: "Front", azimuth: 0, elevation: 32 },
  { id: "side", label: "Side", azimuth: 90, elevation: 28 },
  { id: "rim", label: "Rim", azimuth: 225, elevation: 18 },
];

const CARDINALS = [
  { label: "N", degrees: 0 },
  { label: "E", degrees: 90 },
  { label: "S", degrees: 180 },
  { label: "W", degrees: 270 },
];

export default function LightDome({
  azimuth = 54,
  elevation = 46,
  onAzimuthChange,
  onElevationChange,
}) {
  const fieldRef = useRef(null);
  const draggingRef = useRef(false);
  const instructionId = useId();
  const { x: sunX, y: sunY } = projectLightDirection(azimuth, elevation);
  const compassLabel = getLightCompassLabel(azimuth);

  const updateDirection = useCallback((nextAzimuth, nextElevation) => {
    onAzimuthChange?.(Math.round(normalizeLightAzimuth(nextAzimuth)));
    onElevationChange?.(Math.max(0, Math.min(90, Math.round(nextElevation))));
  }, [onAzimuthChange, onElevationChange]);

  const updateFromPointer = useCallback((clientX, clientY) => {
    const field = fieldRef.current;
    if (!field) return;
    const rect = field.getBoundingClientRect();
    const pointX = ((clientX - rect.left) / rect.width) * 100;
    const pointY = ((clientY - rect.top) / rect.height) * 100;
    const next = lightDirectionFromPoint(pointX, pointY);
    updateDirection(next.azimuth, next.elevation);
  }, [updateDirection]);

  const handlePointerDown = useCallback((event) => {
    event.preventDefault();
    draggingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    updateFromPointer(event.clientX, event.clientY);
  }, [updateFromPointer]);

  const handlePointerMove = useCallback((event) => {
    if (!draggingRef.current) return;
    updateFromPointer(event.clientX, event.clientY);
  }, [updateFromPointer]);

  const stopDragging = useCallback((event) => {
    draggingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handleKeyDown = useCallback((event) => {
    const step = event.shiftKey ? 1 : 5;
    let nextAzimuth = azimuth;
    let nextElevation = elevation;

    if (event.key === "ArrowLeft") nextAzimuth -= step;
    else if (event.key === "ArrowRight") nextAzimuth += step;
    else if (event.key === "ArrowUp") nextElevation += step;
    else if (event.key === "ArrowDown") nextElevation -= step;
    else return;

    event.preventDefault();
    updateDirection(nextAzimuth, nextElevation);
  }, [azimuth, elevation, updateDirection]);

  return (
    <div className="cs-light-control">
      <div className="cs-light-instrument">
        <div
          ref={fieldRef}
          className="cs-light-field"
          role="group"
          tabIndex={0}
          aria-label={`Light direction: ${compassLabel}, ${azimuth} degrees azimuth, ${elevation} degrees elevation`}
          aria-describedby={instructionId}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={stopDragging}
          onPointerCancel={stopDragging}
          onKeyDown={handleKeyDown}
        >
          <span id={instructionId} className="sr-only">
            Drag across the lighting field to move the key light. Use arrow keys to adjust it by five degrees, or hold Shift for one-degree adjustments.
          </span>
          <svg viewBox="0 0 100 100" className="cs-light-dome-svg" aria-hidden="true" focusable="false">
            <circle className="cs-light-dome-surface" cx={LIGHT_DOME_CENTER} cy={LIGHT_DOME_CENTER} r={LIGHT_DOME_RADIUS} />

            <line className="cs-light-dome-axis" x1="50" y1="10" x2="50" y2="90" />
            <line className="cs-light-dome-axis" x1="10" y1="50" x2="90" y2="50" />

            {CARDINALS.map(({ label, degrees }) => {
              const radians = degrees * (Math.PI / 180);
              const labelX = LIGHT_DOME_CENTER + (LIGHT_DOME_RADIUS + 6) * Math.sin(radians);
              const labelY = LIGHT_DOME_CENTER - (LIGHT_DOME_RADIUS + 6) * Math.cos(radians);
              return (
                <text
                  key={label}
                  className="cs-light-dome-cardinal"
                  x={labelX}
                  y={labelY}
                  textAnchor="middle"
                  dominantBaseline="central"
                >
                  {label}
                </text>
              );
            })}

            <circle className="cs-light-dome-zenith" cx={LIGHT_DOME_CENTER} cy={LIGHT_DOME_CENTER} r="1.2" />
            <line
              className="cs-light-dome-vector"
              x1={LIGHT_DOME_CENTER}
              y1={LIGHT_DOME_CENTER}
              x2={sunX}
              y2={sunY}
            />
            <g className="cs-light-dome-source" transform={`translate(${sunX} ${sunY})`}>
              <circle className="cs-light-dome-source-hit" r="7" />
              <circle className="cs-light-dome-source-ring" r="4" />
              <circle className="cs-light-dome-source-core" r="2.4" />
            </g>
          </svg>
        </div>

        <div className="cs-light-tuning">
          <div className="cs-light-axes">
            <label className="cs-light-axis-control">
              <span className="cs-light-axis-header">
                <span>Azimuth</span>
                <output>{azimuth}°</output>
              </span>
              <input
                type="range"
                min="0"
                max="359"
                step="1"
                value={azimuth}
                aria-valuetext={`${azimuth} degrees`}
                onChange={(event) => updateDirection(Number(event.currentTarget.value), elevation)}
              />
            </label>
            <label className="cs-light-axis-control">
              <span className="cs-light-axis-header">
                <span>Elevation</span>
                <output>{elevation}°</output>
              </span>
              <input
                type="range"
                min="0"
                max="90"
                step="1"
                value={elevation}
                aria-valuetext={`${elevation} degrees`}
                onChange={(event) => updateDirection(azimuth, Number(event.currentTarget.value))}
              />
            </label>
          </div>
        </div>
      </div>

      <div className="cs-light-presets" role="group" aria-label="Lighting presets">
        {LIGHT_PRESETS.map((preset) => {
          const isActive = azimuth === preset.azimuth && elevation === preset.elevation;
          return (
            <button
              key={preset.id}
              type="button"
              className={`cs-light-preset${isActive ? " is-active" : ""}`}
              aria-pressed={isActive}
              onClick={() => updateDirection(preset.azimuth, preset.elevation)}
            >
              {preset.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
