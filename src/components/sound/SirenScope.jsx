import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { Coach, repaintOnResizeAndTheme } from "./parts";

const TRACE_POINTS = 420;
const HZ_LOW = 250;
const HZ_HIGH = 2600;
const GRID = [500, 1000, 1500, 2000];

function yFor(hz, height) {
  const t = (Math.log(hz) - Math.log(HZ_LOW)) / (Math.log(HZ_HIGH) - Math.log(HZ_LOW));
  return height - Math.min(1, Math.max(0, t)) * height;
}

function fitCanvas(canvas) {
  const box = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(box.width * ratio));
  const height = Math.max(1, Math.round(box.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return { width, height, ratio };
}

const SirenScope = forwardRef(function SirenScope({ label, sub, state, roleText, coach }, ref) {
  const canvasRef = useRef(null);
  const hzRef = useRef(null);
  const carRef = useRef(null);
  const laneRef = useRef(null);
  const traceRef = useRef({ points: new Float32Array(TRACE_POINTS), head: 0, count: 0, shown: -1, frame: 0, recent: [0, 0, 0, 0, 0] });

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { width, height, ratio } = fitCanvas(canvas);
    const context = canvas.getContext("2d");
    const styles = getComputedStyle(canvas);
    const ink = styles.getPropertyValue("--es-trace-ink").trim() || "#888";
    const line = styles.getPropertyValue("--es-trace-line").trim() || "#ccc";
    context.clearRect(0, 0, width, height);
    context.strokeStyle = line;
    context.lineWidth = 1;
    for (const hz of GRID) {
      const y = Math.round(yFor(hz, height)) + 0.5;
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }
    const trace = traceRef.current;
    if (trace.count < 2) return;
    const step = width / (TRACE_POINTS - 1);
    const start = TRACE_POINTS - trace.count;
    context.strokeStyle = ink;
    context.lineWidth = 2 * ratio;
    context.lineJoin = "round";
    context.beginPath();
    let last = 0;
    for (let n = 0; n < trace.count; n += 1) {
      const hz = trace.points[(trace.head - trace.count + n + TRACE_POINTS) % TRACE_POINTS];
      if (hz <= 0) {
        last = 0;
        continue;
      }
      const x = (start + n) * step;
      const y = yFor(hz, height);
      const ratio = last ? hz / last : 0;
      if (ratio > 0.57 && ratio < 1.75) context.lineTo(x, y);
      else context.moveTo(x, y);
      last = hz;
    }
    context.stroke();
  }, []);

  useImperativeHandle(ref, () => ({
    push(raw) {
      const trace = traceRef.current;
      trace.recent.shift();
      trace.recent.push(raw);
      const hz = [...trace.recent].sort((a, b) => a - b)[2];
      trace.points[trace.head] = hz;
      trace.head = (trace.head + 1) % TRACE_POINTS;
      trace.count = Math.min(TRACE_POINTS, trace.count + 1);
      trace.frame += 1;
      if (trace.frame % 4 === 0 && hzRef.current) {
        const shown = hz > 0 ? Math.round(hz / 5) * 5 : 0;
        if (shown !== trace.shown) {
          trace.shown = shown;
          hzRef.current.textContent = shown ? String(shown) : "";
        }
      }
      draw();
    },
    drive(progress) {
      const lane = laneRef.current;
      if (!lane) return;
      lane.toggleAttribute("data-live", progress !== null);
      if (progress !== null && carRef.current) carRef.current.style.left = `${(progress * 100).toFixed(2)}%`;
    },
    clear() {
      const trace = traceRef.current;
      trace.count = 0;
      trace.shown = -1;
      trace.recent = [0, 0, 0, 0, 0];
      if (hzRef.current) hzRef.current.textContent = "";
      draw();
    },
  }), [draw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    return repaintOnResizeAndTheme(canvas, draw);
  }, [draw]);

  return (
    <div className="sn-scope">
      <div className="sn-scope-head">
        <div className="es-identity">
          {label
            ? <span className="es-name cx-display" title={label}>{label}</span>
            : <span className="es-name-empty">No tone selected</span>}
          <span className="es-sub" title={sub}>{sub}</span>
        </div>
        <div className="sn-hz">
          <span ref={hzRef} className="sn-hz-value cx-display" />
          <span className="es-state" data-state={state === "Horn" ? "limiter" : undefined}>{state || roleText}</span>
        </div>
      </div>
      <div className="sn-trace-wrap">
        <canvas ref={canvasRef} className="es-trace sn-trace" aria-hidden="true" />
        <div className="sn-grid-labels" aria-hidden="true">
          {GRID.map((hz) => (
            <span key={hz} style={{ top: `${(1 - (Math.log(hz) - Math.log(HZ_LOW)) / (Math.log(HZ_HIGH) - Math.log(HZ_LOW))) * 100}%` }}>{hz >= 1000 ? `${hz / 1000}k` : hz}</span>
          ))}
        </div>
        <Coach>{coach}</Coach>
      </div>
      <div ref={laneRef} className="sn-lane" aria-hidden="true">
        <span className="sn-lane-you">You</span>
        <span ref={carRef} className="sn-car" />
      </div>
    </div>
  );
});

export default SirenScope;

export function SirenWave({ samples, seconds, start, end }) {
  const canvasRef = useRef(null);
  const peaksRef = useRef(null);

  useEffect(() => {
    peaksRef.current = null;
    if (!samples?.length) return;
    const bins = 480;
    const peaks = new Float32Array(bins);
    const size = Math.max(1, Math.floor(samples.length / bins));
    for (let bin = 0; bin < bins; bin += 1) {
      let peak = 0;
      const from = bin * size;
      const to = Math.min(samples.length, from + size);
      for (let index = from; index < to; index += 4) {
        const value = Math.abs(samples[index]);
        if (value > peak) peak = value;
      }
      peaks[bin] = peak;
    }
    let top = 0;
    for (const value of peaks) top = Math.max(top, value);
    if (top > 0) for (let bin = 0; bin < bins; bin += 1) peaks[bin] /= top;
    peaksRef.current = peaks;
  }, [samples]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const paint = () => {
      const { width, height } = fitCanvas(canvas);
      const context = canvas.getContext("2d");
      const styles = getComputedStyle(canvas);
      const ink = styles.getPropertyValue("--sn-wave-ink").trim() || "#888";
      const dim = styles.getPropertyValue("--sn-wave-dim").trim() || "#ccc";
      context.clearRect(0, 0, width, height);
      const peaks = peaksRef.current;
      if (!peaks || !seconds) return;
      const from = (start / seconds) * width;
      const to = ((end > start ? end : seconds) / seconds) * width;
      const bar = width / peaks.length;
      for (let bin = 0; bin < peaks.length; bin += 1) {
        const x = bin * bar;
        const h = Math.max(1, peaks[bin] * height * 0.92);
        context.fillStyle = x >= from && x <= to ? ink : dim;
        context.fillRect(x, (height - h) / 2, Math.max(1, bar - 0.5), h);
      }
    };
    paint();
    return repaintOnResizeAndTheme(canvas, paint);
  }, [samples, seconds, start, end]);

  return <canvas ref={canvasRef} className="sn-wave" aria-hidden="true" />;
}
