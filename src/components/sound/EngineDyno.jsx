import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { rpmForRev } from "../../lib/engine-grains.js";
import { formatRpm } from "../../lib/engine-sounds.js";
import { Coach, repaintOnResizeAndTheme } from "./parts";

const SWEEP = 270;
const START = 360 - SWEEP / 2;
const CENTER = 200;
const BAND = 170;
const SEGMENT_RPM = 250;
const SEGMENT_DASH = "0.74 0.26";
const NUMBER_RADIUS = 124;
const NEEDLE_FROM = 96;
const NEEDLE_TO = 190;
const PEAK_HOLD = 1.2;
const PEAK_FALL = 3000;
const TRACE_SECONDS = 8;
const TRACE_RATE = 30;
const OFF_GEAR = 255;

function polar(angle, radius) {
  const rad = ((angle - 90) * Math.PI) / 180;
  return [CENTER + radius * Math.cos(rad), CENTER + radius * Math.sin(rad)];
}

function arc(from, to, radius) {
  const [x1, y1] = polar(from, radius);
  const [x2, y2] = polar(to, radius);
  const large = to - from > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

function scaleFor(maxRpm) {
  const top = Math.max(4000, Math.ceil((maxRpm * 1.06) / 1000) * 1000);
  const redFrom = Math.min(top - SEGMENT_RPM, Math.floor((maxRpm * 0.92) / SEGMENT_RPM) * SEGMENT_RPM);
  return { top, redFrom, angleFor: (rpm) => START + (Math.min(top, Math.max(0, rpm)) / top) * SWEEP };
}

function setBand(node, scale, from, to) {
  if (!node) return;
  if (to - from < 1) {
    node.setAttribute("d", "");
    return;
  }
  node.setAttribute("d", arc(scale.angleFor(from), scale.angleFor(to), BAND));
  node.setAttribute("pathLength", ((to - from) / SEGMENT_RPM).toFixed(4));
}

function gearText(sim) {
  if (!sim.running) return "Off";
  if (sim.shift) return "–";
  return sim.gear === 0 ? "N" : String(sim.gear);
}

const EngineDyno = forwardRef(function EngineDyno({ range, label, sublabel, coach }, ref) {
  const rootRef = useRef(null);
  const litRef = useRef(null);
  const hotRef = useRef(null);
  const needleRef = useRef(null);
  const peakRef = useRef(null);
  const rpmRef = useRef(null);
  const gearRef = useRef(null);
  const stateRef = useRef(null);
  const canvasRef = useRef(null);
  const size = TRACE_SECONDS * TRACE_RATE;
  const traceRef = useRef({ points: new Float32Array(size), flags: new Uint8Array(size), gears: new Uint8Array(size), head: 0, count: 0, last: 0 });
  const lastRef = useRef({ rpm: -1, gear: "", state: "", throttle: -1, running: null });
  const peakStateRef = useRef({ rpm: 0, time: 0, last: 0, shown: -1 });
  const scale = useMemo(() => scaleFor(range?.maxRpm || 8000), [range]);

  const drawTrace = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const box = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(box.width * ratio));
    const height = Math.max(1, Math.round(box.height * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const context = canvas.getContext("2d");
    const styles = getComputedStyle(canvas);
    const read = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
    const ink = read("--es-trace-ink", "#888");
    const hot = read("--es-trace-hot", "#c84");
    const line = read("--es-trace-line", "#ccc");
    const label = read("--es-chart-label", "#888");
    const redZone = read("--es-chart-red", "rgba(200,60,60,0.08)");
    const redLabel = read("--es-chart-red-label", "#c44");
    const under = read("--es-chart-fill", "rgba(128,128,128,0.06)");
    const fontSize = parseFloat(styles.fontSize) || 13;
    const fontFamily = styles.fontFamily;
    context.clearRect(0, 0, width, height);

    const figure = Math.round(fontSize * ratio);
    const gutter = Math.round(figure * 1.6);
    const headroom = Math.round(figure * 1.7);
    const left = gutter;
    const right = width;
    const top = headroom;
    const bottom = height - Math.round(ratio);
    const plotHeight = Math.max(1, bottom - top);
    const yFor = (rpm) => bottom - (Math.min(scale.top, Math.max(0, rpm)) / scale.top) * plotHeight;

    context.fillStyle = redZone;
    context.fillRect(left, yFor(scale.top), right - left, yFor(scale.redFrom) - yFor(scale.top));

    context.font = `italic 800 ${figure}px ${fontFamily}`;
    context.textAlign = "right";
    context.textBaseline = "middle";
    context.lineWidth = Math.max(1, Math.round(ratio));
    const labelEvery = (plotHeight / scale.top) * 1000 < figure * 1.6 ? 2000 : 1000;
    for (let k = 0; k <= scale.top; k += 1000) {
      const y = Math.round(yFor(k)) + (k === 0 ? -0.5 : 0.5);
      context.strokeStyle = line;
      context.beginPath();
      context.moveTo(left, y);
      context.lineTo(right, y);
      context.stroke();
      if (k === 0 || k % labelEvery) continue;
      context.fillStyle = k >= scale.redFrom ? redLabel : label;
      context.fillText(String(k / 1000), left - Math.round(figure * 0.5), y);
    }

    const trace = traceRef.current;
    if (trace.count < 2) return;
    const step = (right - left) / (size - 1);
    const first = size - trace.count;
    const index = (n) => (trace.head - trace.count + n + size) % size;
    const xFor = (n) => left + (first + n) * step;

    context.fillStyle = under;
    context.beginPath();
    context.moveTo(xFor(0), bottom);
    for (let n = 0; n < trace.count; n += 1) context.lineTo(xFor(n), yFor(trace.points[index(n)]));
    context.lineTo(xFor(trace.count - 1), bottom);
    context.closePath();
    context.fill();

    context.textAlign = "center";
    context.textBaseline = "alphabetic";
    context.setLineDash([Math.round(3 * ratio), Math.round(4 * ratio)]);
    for (let n = 1; n < trace.count; n += 1) {
      const gear = trace.gears[index(n)];
      const before = trace.gears[index(n - 1)];
      if (gear === before || gear === OFF_GEAR || before === OFF_GEAR) continue;
      const x = Math.round(xFor(n)) + 0.5;
      context.strokeStyle = line;
      context.beginPath();
      context.moveTo(x, top - Math.round(figure * 0.3));
      context.lineTo(x, bottom);
      context.stroke();
      context.fillStyle = label;
      context.fillText(gear === 0 ? "N" : String(gear), x, top - Math.round(figure * 0.55));
    }
    context.setLineDash([]);

    context.lineWidth = 2 * ratio;
    context.lineJoin = "round";
    context.lineCap = "round";
    let current = -1;
    for (let n = 0; n < trace.count; n += 1) {
      const x = xFor(n);
      const y = yFor(trace.points[index(n)]);
      const hotNow = trace.flags[index(n)] ? 1 : 0;
      if (hotNow !== current) {
        if (current !== -1) {
          context.lineTo(x, y);
          context.stroke();
        }
        context.strokeStyle = hotNow ? hot : ink;
        context.beginPath();
        context.moveTo(x, y);
        current = hotNow;
      } else {
        context.lineTo(x, y);
      }
    }
    context.stroke();
  }, [scale, size]);

  useImperativeHandle(ref, () => ({
    update(sim, time) {
      if (!range) return;
      const rpm = sim.running ? rpmForRev(range, sim.rev) : Math.round((sim.rev * range.maxRpm) / 50) * 50;
      const last = lastRef.current;
      if (sim.running !== last.running) {
        last.running = sim.running;
        rootRef.current?.toggleAttribute("data-running", sim.running);
      }
      if (rpm !== last.rpm) {
        last.rpm = rpm;
        setBand(litRef.current, scale, 0, Math.min(rpm, scale.redFrom));
        setBand(hotRef.current, scale, scale.redFrom, Math.max(scale.redFrom, rpm));
        needleRef.current?.setAttribute("transform", `rotate(${scale.angleFor(rpm).toFixed(2)} ${CENTER} ${CENTER})`);
        if (rpmRef.current) rpmRef.current.textContent = formatRpm(rpm);
      }
      const peak = peakStateRef.current;
      const elapsed = Math.max(0, time - peak.last);
      peak.last = time;
      if (!sim.running || rpm >= peak.rpm) {
        peak.rpm = rpm;
        peak.time = time;
      } else if (time - peak.time > PEAK_HOLD) {
        peak.rpm = Math.max(rpm, peak.rpm - PEAK_FALL * elapsed);
      }
      const shown = Math.round(peak.rpm / 10) * 10;
      if (shown !== peak.shown) {
        peak.shown = shown;
        peakRef.current?.setAttribute("transform", `rotate(${scale.angleFor(shown).toFixed(2)} ${CENTER} ${CENTER})`);
      }
      const gear = gearText(sim);
      if (gear !== last.gear) {
        last.gear = gear;
        if (gearRef.current) gearRef.current.textContent = gear;
      }
      const state = !sim.running ? "" : sim.launch && sim.limiter ? "launch" : sim.limiter ? "limiter" : sim.shift ? "shift" : "";
      if (state !== last.state) {
        last.state = state;
        const node = stateRef.current;
        if (node) {
          node.dataset.state = state;
          node.textContent = state === "launch" ? "Two-step" : state === "limiter" ? "Limiter" : state === "shift" ? "Shifting" : "";
        }
      }
      const throttle = Math.round(sim.throttle * 100);
      if (throttle !== last.throttle) {
        last.throttle = throttle;
        rootRef.current?.parentElement?.style.setProperty("--es-throttle", `${throttle}%`);
      }
      const trace = traceRef.current;
      if (time - trace.last >= 1 / TRACE_RATE) {
        trace.last = time;
        trace.points[trace.head] = rpm;
        trace.flags[trace.head] = sim.limiter ? 1 : 0;
        trace.gears[trace.head] = sim.running ? (sim.shift ? sim.shift.gear : sim.gear) : OFF_GEAR;
        trace.head = (trace.head + 1) % size;
        trace.count = Math.min(size, trace.count + 1);
        drawTrace();
      }
    },
    clearTrace() {
      const trace = traceRef.current;
      trace.count = 0;
      trace.head = 0;
      drawTrace();
    },
  }), [drawTrace, range, scale, size]);

  useEffect(() => {
    lastRef.current = { rpm: -1, gear: "", state: "", throttle: -1, running: null };
    peakStateRef.current = { rpm: 0, time: 0, last: 0, shown: -1 };
    traceRef.current.count = 0;
    drawTrace();
  }, [drawTrace, range]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return undefined;
    return repaintOnResizeAndTheme(canvas, drawTrace);
  }, [drawTrace]);

  const marks = [];
  for (let k = 0; k <= scale.top; k += 500) {
    const major = k % 1000 === 0;
    const angle = scale.angleFor(k);
    const [x1, y1] = polar(angle, BAND - (major ? 26 : 19));
    const [x2, y2] = polar(angle, BAND - 13);
    marks.push(<line key={k} className={`es-mark ${major ? "is-major" : ""}`} x1={x1} y1={y1} x2={x2} y2={y2} />);
    if (major && k > 0) {
      const [lx, ly] = polar(angle, NUMBER_RADIUS);
      marks.push(
        <text key={`n${k}`} className={`es-number ${k >= scale.redFrom ? "is-red" : ""}`} x={lx} y={ly} textAnchor="middle" dominantBaseline="central">
          {k / 1000}
        </text>,
      );
    }
  }
  const sweepEnd = START + SWEEP;
  const redAngle = scale.angleFor(scale.redFrom);
  const restSegments = scale.redFrom / SEGMENT_RPM;
  const redSegments = (scale.top - scale.redFrom) / SEGMENT_RPM;

  return (
    <div ref={rootRef} className="es-dyno">
      <div className="es-gauge">
        <svg className="es-dial" viewBox="0 0 400 400" role="img" aria-label="Tachometer">
          <path className="es-band" d={arc(START, redAngle, BAND)} pathLength={restSegments} strokeDasharray={SEGMENT_DASH} />
          <path className="es-band is-red" d={arc(redAngle, sweepEnd, BAND)} pathLength={redSegments} strokeDasharray={SEGMENT_DASH} />
          <path ref={litRef} className="es-band is-lit" d="" strokeDasharray={SEGMENT_DASH} />
          <path ref={hotRef} className="es-band is-hot" d="" strokeDasharray={SEGMENT_DASH} />
          {marks}
          <line ref={peakRef} className="es-peak" x1={CENTER} y1={CENTER - BAND - 15} x2={CENTER} y2={CENTER - BAND - 25} transform={`rotate(${START} ${CENTER} ${CENTER})`} />
          <polygon
            ref={needleRef}
            className="es-needle"
            points={`${CENTER - 4.5},${CENTER - NEEDLE_FROM} ${CENTER + 4.5},${CENTER - NEEDLE_FROM} ${CENTER + 1.3},${CENTER - NEEDLE_TO} ${CENTER - 1.3},${CENTER - NEEDLE_TO}`}
            transform={`rotate(${START} ${CENTER} ${CENTER})`}
          />
          <text ref={rpmRef} className="es-rpm" x={CENTER} y={CENTER - 4} textAnchor="middle" dominantBaseline="central">0</text>
          <text className="es-unit" x={CENTER} y={CENTER + 38} textAnchor="middle" dominantBaseline="central">RPM</text>
          <text ref={gearRef} className="es-gear" x={CENTER} y={CENTER + 128} textAnchor="middle" dominantBaseline="central">Off</text>
          <text ref={stateRef} className="es-gauge-state" data-state="" x={CENTER} y={CENTER + 176} textAnchor="middle" dominantBaseline="central" aria-live="polite" />
        </svg>
      </div>
      <div className="es-chart">
        <div className="es-identity">
          <span className="es-name cx-display" title={label}>{label}</span>
          {sublabel ? <span className="es-sub" title={sublabel}>{sublabel}</span> : null}
        </div>
        <div className="es-chart-plot">
          <canvas ref={canvasRef} className="es-trace es-chart-canvas" aria-label="RPM over the last eight seconds" />
          <Coach>{coach}</Coach>
        </div>
      </div>
    </div>
  );
});

export default EngineDyno;
