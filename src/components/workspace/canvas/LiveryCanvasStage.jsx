import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Layers, Maximize2, MousePointerClick } from "lucide-react";
import "./LiveryCanvas.css";

const MIN_SCALE = 0.02;
const MAX_SCALE = 8;
const HANDLE_PX = 7;
const ROTATE_GAP_PX = 26;
const CLICK_SLOP_PX = 4;

function itemGeometry(item, sheet) {
  const t = item.uvTransform;
  return { cx: t.u * sheet.width, cy: t.v * sheet.height, w: t.width * sheet.width, h: t.height * sheet.height, rotation: t.rotation };
}

function toLocal(point, box) {
  const dx = point.x - box.cx;
  const dy = point.y - box.cy;
  const cos = Math.cos(-box.rotation);
  const sin = Math.sin(-box.rotation);
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

function toSheet(local, box) {
  const cos = Math.cos(box.rotation);
  const sin = Math.sin(box.rotation);
  return { x: box.cx + local.x * cos - local.y * sin, y: box.cy + local.x * sin + local.y * cos };
}

function hitItem(items, sheet, point) {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.hidden || item.locked) continue;
    const box = itemGeometry(item, sheet);
    const local = toLocal(point, box);
    if (Math.abs(local.x) <= box.w / 2 && Math.abs(local.y) <= box.h / 2) return item;
  }
  return null;
}

function Selection({ item, sheet, scale }) {
  const box = itemGeometry(item, sheet);
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => toSheet({ x: (x * box.w) / 2, y: (y * box.h) / 2 }, box));
  const handle = toSheet({ x: box.w / 2, y: box.h / 2 }, box);
  const top = toSheet({ x: 0, y: -box.h / 2 }, box);
  const rotate = toSheet({ x: 0, y: -box.h / 2 - ROTATE_GAP_PX / scale }, box);
  const r = HANDLE_PX / scale;
  const stroke = 1.5 / scale;
  return (
    <g className={`lv-cv-selection ${item.locked ? "is-locked" : ""}`} style={{ "--lv-cv-stroke": `${stroke}px` }}>
      <polygon points={corners.map((corner) => `${corner.x},${corner.y}`).join(" ")} />
      {item.locked ? null : (
        <>
          <line x1={top.x} y1={top.y} x2={rotate.x} y2={rotate.y} />
          <circle className="lv-cv-handle" data-handle="rotate" cx={rotate.x} cy={rotate.y} r={r} />
          <rect className="lv-cv-handle" data-handle="scale" x={handle.x - r} y={handle.y - r} width={r * 2} height={r * 2} />
        </>
      )}
    </g>
  );
}

function SheetView({ canvas }) {
  const hostRef = useRef(null);
  const imageHostRef = useRef(null);
  const overlayRef = useRef(null);
  const dragRef = useRef(null);
  const hoverFrame = useRef(0);
  const [view, setView] = useState({ scale: 0, x: 0, y: 0 });
  const { sheet, doc } = canvas;
  const items = doc?.items || [];

  const fit = useCallback(() => {
    const host = hostRef.current;
    if (!host) return;
    const { width, height } = host.getBoundingClientRect();
    if (!width || !height) return;
    const scale = Math.min(width / sheet.width, height / sheet.height) * 0.94;
    setView({ scale, x: (width - sheet.width * scale) / 2, y: (height - sheet.height * scale) / 2 });
  }, [sheet.width, sheet.height]);

  useLayoutEffect(() => {
    fit();
  }, [fit]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let first = true;
    const observer = new ResizeObserver(() => {
      if (first) {
        first = false;
        return;
      }
      fit();
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [fit]);

  useEffect(() => {
    const target = imageHostRef.current;
    const image = canvas.previewCanvas();
    if (!target || !image) return undefined;
    target.appendChild(image);
    return () => {
      if (image.parentNode === target) target.removeChild(image);
    };
  }, [canvas.previewCanvas]);

  useEffect(() => {
    const element = overlayRef.current;
    if (!element) return;
    if (element.width !== sheet.width || element.height !== sheet.height) {
      element.width = sheet.width;
      element.height = sheet.height;
    }
    const context = element.getContext("2d");
    context.clearRect(0, 0, element.width, element.height);
    if (canvas.overlay.on && canvas.overlay.bitmap) context.drawImage(canvas.overlay.bitmap, 0, 0, element.width, element.height);
  }, [canvas.overlay, sheet.width, sheet.height]);

  useEffect(() => () => cancelAnimationFrame(hoverFrame.current), []);

  const sheetPoint = useCallback((event) => {
    const host = hostRef.current;
    const rect = host.getBoundingClientRect();
    return { x: (event.clientX - rect.left - view.x) / view.scale, y: (event.clientY - rect.top - view.y) / view.scale };
  }, [view]);

  const onWheel = useCallback((event) => {
    if (!view.scale) return;
    const host = hostRef.current;
    const rect = host.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const factor = Math.exp(-event.deltaY * 0.0015);
    setView((current) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor));
      const ratio = scale / current.scale;
      return { scale, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio };
    });
  }, [view.scale]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const listener = (event) => {
      event.preventDefault();
      onWheel(event);
    };
    host.addEventListener("wheel", listener, { passive: false });
    return () => host.removeEventListener("wheel", listener);
  }, [onWheel]);

  const onPointerDown = (event) => {
    if (event.button !== 0 && event.button !== 1) return;
    hostRef.current.focus({ preventScroll: true });
    const point = sheetPoint(event);
    const handle = event.target?.dataset?.handle;
    const selected = canvas.selected;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (event.button === 1 || event.altKey) {
      dragRef.current = { kind: "pan", startX: event.clientX, startY: event.clientY, view, moved: false };
      return;
    }
    if (handle && selected && !selected.locked) {
      const box = itemGeometry(selected, sheet);
      dragRef.current = {
        kind: handle,
        id: selected.id,
        box,
        start: point,
        startAngle: Math.atan2(point.y - box.cy, point.x - box.cx),
        startDistance: Math.hypot(point.x - box.cx, point.y - box.cy),
        transform: selected.uvTransform,
        moved: false,
      };
      return;
    }
    const hit = canvas.placing ? null : hitItem(items, sheet, point);
    if (hit) {
      canvas.select(hit.id);
      dragRef.current = { kind: "move", id: hit.id, start: point, transform: hit.uvTransform, startX: event.clientX, startY: event.clientY, moved: false };
      return;
    }
    dragRef.current = { kind: "pan", startX: event.clientX, startY: event.clientY, view, moved: false, click: point };
  };

  const onPointerMove = (event) => {
    const drag = dragRef.current;
    if (!drag) {
      if (canvas.placing) {
        const point = sheetPoint(event);
        cancelAnimationFrame(hoverFrame.current);
        hoverFrame.current = requestAnimationFrame(() => canvas.hoverSheet(point.x, point.y));
      }
      return;
    }
    if (drag.kind === "pan") {
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (Math.hypot(dx, dy) > CLICK_SLOP_PX) drag.moved = true;
      if (drag.moved) setView({ ...drag.view, x: drag.view.x + dx, y: drag.view.y + dy });
      return;
    }
    const point = sheetPoint(event);
    if (!drag.moved && Math.hypot(point.x - drag.start.x, point.y - drag.start.y) * view.scale < CLICK_SLOP_PX) return;
    drag.moved = true;
    const t = drag.transform;
    if (drag.kind === "move") {
      canvas.update(drag.id, (item) => ({ ...item, uvTransform: { ...t, u: t.u + (point.x - drag.start.x) / sheet.width, v: t.v + (point.y - drag.start.y) / sheet.height } }), `drag:${drag.id}`);
      return;
    }
    if (drag.kind === "scale") {
      const distance = Math.hypot(point.x - drag.box.cx, point.y - drag.box.cy);
      const factor = Math.max(0.02, distance / Math.max(1e-6, drag.startDistance));
      canvas.update(drag.id, (item) => ({ ...item, uvTransform: { ...t, width: t.width * factor, height: t.height * factor } }), `scale:${drag.id}`);
      return;
    }
    if (drag.kind === "rotate") {
      let rotation = t.rotation + Math.atan2(point.y - drag.box.cy, point.x - drag.box.cx) - drag.startAngle;
      if (event.shiftKey) rotation = Math.round(rotation / (Math.PI / 12)) * (Math.PI / 12);
      canvas.update(drag.id, (item) => ({ ...item, uvTransform: { ...t, rotation } }), `rotate:${drag.id}`);
    }
  };

  const onPointerUp = (event) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!drag || drag.kind !== "pan" || drag.moved || !drag.click) return;
    if (canvas.placing) canvas.placeOnSheet(drag.click.x, drag.click.y);
    else canvas.select(null);
  };

  const onKeyDown = (event) => {
    if (event.key === "f" || event.key === "F") {
      event.preventDefault();
      fit();
    }
  };

  const transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale || 0.0001})`;
  const hover = canvas.hover;

  return (
    <div className="lv-cv-sheet-pane">
      <div
        ref={hostRef}
        className={`lv-cv-sheet ${canvas.placing ? "is-placing" : ""}`}
        tabIndex={0}
        role="application"
        aria-label="Livery sheet. Drag to move items, Alt-drag or middle-drag to pan, scroll to zoom, F to fit."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { dragRef.current = null; }}
        onPointerLeave={() => { if (canvas.placing) canvas.clearHover(); }}
        onKeyDown={onKeyDown}
      >
        <div className="lv-cv-paper" style={{ width: sheet.width, height: sheet.height, transform }}>
          <div className="lv-cv-image-host" ref={imageHostRef} />
          <canvas ref={overlayRef} className="lv-cv-islands" aria-hidden="true" />
          <svg className="lv-cv-svg" viewBox={`0 0 ${sheet.width} ${sheet.height}`} width={sheet.width} height={sheet.height} aria-hidden="true">
            {canvas.selected && !canvas.selected.hidden && view.scale ? <Selection item={canvas.selected} sheet={sheet} scale={view.scale} /> : null}
          </svg>
        </div>
      </div>

      <div className="lv-cv-sheet-bar">
        <span className="lv-cv-sheet-size">{`${sheet.width} × ${sheet.height}`}</span>
        <button type="button" className={`lv-cv-bar-btn ${canvas.overlay.on ? "is-on" : ""}`} aria-pressed={canvas.overlay.on}
          onClick={() => canvas.setOverlayOn(!canvas.overlay.on)} title="Show the livery's parts on the sheet">
          <Layers aria-hidden="true" />
          Parts
        </button>
        <button type="button" className="lv-cv-bar-btn" onClick={fit} title="Fit the sheet (F)">
          <Maximize2 aria-hidden="true" />
          Fit
        </button>
      </div>

      {canvas.placing ? (
        <div className={`lv-slip lv-cv-place-slip ${hover?.level === "refuse" ? "is-refuse" : hover?.level === "warn" ? "is-warn" : ""}`} role="status">
          <MousePointerClick aria-hidden="true" />
          <span>{hover?.text || "Click a part to place it. Esc cancels."}</span>
        </div>
      ) : null}
    </div>
  );
}

export default function LiveryCanvasStage({ canvas, children }) {
  const mode = canvas?.engaged ? canvas.stage : "model";
  return (
    <div className="lv-cv-stage" data-mode={mode}>
      <div className="lv-cv-model">
        {children}
        {canvas?.engaged && canvas.placing && mode !== "sheet" ? (
          <div className={`lv-slip lv-cv-place-slip is-model ${canvas.hover?.level === "refuse" ? "is-refuse" : canvas.hover?.level === "warn" ? "is-warn" : ""}`} role="status">
            <MousePointerClick aria-hidden="true" />
            <span>{canvas.hover?.text || "Click the vehicle to place it. Esc cancels."}</span>
          </div>
        ) : null}
      </div>
      {mode !== "model" ? <SheetView canvas={canvas} /> : null}
    </div>
  );
}
