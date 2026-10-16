import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { clusterKey, clusterMarkers, leaderEnd, relaxCallouts } from "../../lib/siren-callouts.js";

// Siren markers over the viewfinder while the siren editor is open, so a row
// in the grid can be found on the model. They are DOM, not WebGL, so captures
// and exports never include them. Positions follow the camera every frame
// through refs; React renders only when the set of markers changes.

export default function SirenMarkers({ s }) {
  const editor = s.sirenEditor;
  const visible = Boolean(editor?.markers && editor?.draft && s.isActive !== false);
  if (!visible || !s.getSirenMarkers) return null;
  return editor.markerStyle === "classic"
    ? <ClassicMarkers editor={editor} getMarkers={s.getSirenMarkers} onViewerFrame={s.onViewerFrame} />
    : <CalloutMarkers editor={editor} getMarkers={s.getSirenMarkers} onViewerFrame={s.onViewerFrame} />;
}

// Runs `layout` right after each frame the viewer draws, so markers move in
// the same frame as the model; a layout from an earlier callback in that frame
// would show the camera before this frame's controls step. While the viewer is
// idle a frame loop keeps calling it, for labels still settling and the
// far-side scan. Returns a cleanup.
function followViewer(layout, onViewerFrame) {
  let frame = 0;
  let viewerDrew = false;
  const unsubscribe = onViewerFrame?.(() => {
    viewerDrew = true;
    layout();
  });
  const tick = () => {
    frame = requestAnimationFrame(tick);
    if (viewerDrew) viewerDrew = false;
    else layout();
  };
  frame = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(frame);
    unsubscribe?.();
  };
}

function selectSiren(editor, index, event) {
  const offset = index - 1;
  const selected = editor.selection.includes(offset);
  if (event.ctrlKey || event.metaKey) {
    editor.select(selected ? editor.selection.filter((entry) => entry !== offset) : [...editor.selection, offset], offset);
  } else editor.select([offset], offset);
}

function sirenLabel(light, index) {
  return light ? `Siren ${index}` : `Siren ${index} has no entry in this setting`;
}

/* ─── Callouts: numbers in the siren's colour on short leaders ─── */

function CalloutMarkers({ editor, getMarkers, onViewerFrame }) {
  const draft = editor.draft;
  const [clusters, setClusters] = useState([]);
  const root = useRef(null);
  const nodes = useRef(new Map());
  const sizes = useRef(new Map());
  const labels = useRef(new Map());
  const stage = useRef({ width: 0, height: 0 });
  // Bumped after each render of new groups, so the next layout places the new nodes.
  const rendered = useRef(0);
  const layoutRef = useRef(null);

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return undefined;
    const measure = () => {
      stage.current = { width: element.clientWidth, height: element.clientHeight };
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Label sizes change only when the groups render anew. New nodes are placed
  // before the browser paints them, never at the stage's corner.
  useLayoutEffect(() => {
    for (const cluster of clusters) {
      const label = nodes.current.get(cluster.id)?.label;
      if (label) sizes.current.set(cluster.id, { w: label.offsetWidth, h: label.offsetHeight });
    }
    rendered.current += 1;
    layoutRef.current?.(true);
  }, [clusters]);

  useEffect(() => {
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let shownKey = "";
    let lastInput = "";
    let lastMove = Infinity;
    let laidOut = -1;
    const layout = (fromCommit = false) => {
      const current = clusterMarkers(getMarkers());
      const key = clusterKey(current);
      if (key !== shownKey) {
        shownKey = key;
        const next = current.map(({ id, sirens, far }) => ({ id, sirens, far }));
        // Regroup in this frame, not the next, so no dot is drawn where its
        // old group was; the commit's layout effect places the new nodes.
        if (!fromCommit) {
          flushSync(() => setClusters(next));
          return;
        }
        setClusters(next);
      }
      const { width, height } = stage.current;
      const input = `${width}x${height}|${current.map((cluster) => `${cluster.x.toFixed(1)},${cluster.y.toFixed(1)}`).join(";")}`;
      // A still view with settled labels needs no layout or DOM writes.
      if (input === lastInput && lastMove < 0.05 && laidOut === rendered.current) return;
      lastInput = input;
      laidOut = rendered.current;
      lastMove = relaxCallouts(current, labels.current, {
        width,
        height,
        sizes: sizes.current,
        pull: reduceMotion ? 1 : 0.2,
        iterations: reduceMotion ? 12 : 6,
        maxStep: reduceMotion ? Infinity : 6,
      });
      for (const cluster of current) {
        const node = nodes.current.get(cluster.id);
        const label = labels.current.get(cluster.id);
        if (!node || !label) continue;
        node.dot.style.transform = `translate(${cluster.x.toFixed(1)}px, ${cluster.y.toFixed(1)}px)`;
        node.label.style.transform = `translate(${(label.x - label.w / 2).toFixed(1)}px, ${(label.y - label.h / 2).toFixed(1)}px)`;
        const end = leaderEnd(cluster, label);
        for (const line of [node.halo, node.lead]) {
          line.style.visibility = end ? "" : "hidden";
          if (!end) continue;
          line.setAttribute("x1", cluster.x.toFixed(1));
          line.setAttribute("y1", cluster.y.toFixed(1));
          line.setAttribute("x2", end.x.toFixed(1));
          line.setAttribute("y2", end.y.toFixed(1));
        }
      }
    };
    layoutRef.current = layout;
    const stop = followViewer(layout, onViewerFrame);
    return () => {
      stop();
      layoutRef.current = null;
    };
  }, [getMarkers, onViewerFrame]);

  const selected = new Set(editor.selection.map((offset) => offset + 1));
  const register = (id, part) => (node) => {
    const entry = nodes.current.get(id) || {};
    if (node) entry[part] = node;
    else delete entry[part];
    if (Object.keys(entry).length) nodes.current.set(id, entry);
    else nodes.current.delete(id);
  };
  const colorOf = (index) => draft.sirens[index - 1]?.color || null;
  const dotFill = (sirens) => {
    const colors = sirens.map((index) => colorOf(index) || "var(--mg-muted)");
    if (colors.length === 1) return colors[0];
    const step = 360 / colors.length;
    return `conic-gradient(${colors.map((color, at) => `${color} ${at * step}deg ${(at + 1) * step}deg`).join(", ")})`;
  };

  return (
    <div ref={root} className="se-markers" aria-label="Siren positions">
      <svg className="se-callout-leads" aria-hidden="true">
        {clusters.map((cluster) => (
          <line key={`halo-${cluster.id}`} ref={register(cluster.id, "halo")} className="se-callout-halo" />
        ))}
        {clusters.map((cluster) => (
          <line key={`lead-${cluster.id}`} ref={register(cluster.id, "lead")}
            className={["se-callout-lead", cluster.far && "is-far", cluster.sirens.some((index) => selected.has(index)) && "is-selected"].filter(Boolean).join(" ")} />
        ))}
      </svg>
      {clusters.map((cluster) => (
        <span key={`dot-${cluster.id}`} ref={register(cluster.id, "dot")} className={`se-callout-dot${cluster.far ? " is-far" : ""}`}
          style={{ "--se-dot": dotFill(cluster.sirens) }} aria-hidden="true" />
      ))}
      {clusters.map((cluster) => (
        <div key={`label-${cluster.id}`} ref={register(cluster.id, "label")} className={`se-callout${cluster.far ? " is-far" : ""}`}>
          {cluster.sirens.map((index) => {
            const light = draft.sirens[index - 1];
            const label = cluster.far ? `${sirenLabel(light, index)}, behind the body from this view` : sirenLabel(light, index);
            return (
              <button key={index} type="button" className={`se-callout-num${selected.has(index) ? " is-selected" : ""}`}
                style={light ? { "--se-num": light.color } : undefined} disabled={!light}
                aria-label={label} title={label} aria-pressed={selected.has(index)}
                onClick={(event) => selectSiren(editor, index, event)}>
                {index}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* ─── Classic: the original chips ─── */

function ClassicMarkers({ editor, getMarkers, onViewerFrame }) {
  const draft = editor.draft;
  const [indices, setIndices] = useState([]);
  const nodes = useRef(new Map());
  const layoutRef = useRef(null);

  // New chips are placed before the browser paints them.
  useLayoutEffect(() => {
    layoutRef.current?.();
  }, [indices]);

  useEffect(() => {
    let shownKey = "";
    const layout = () => {
      const markers = getMarkers();
      const key = markers.map((marker) => marker.siren).join(",");
      if (key !== shownKey) {
        shownKey = key;
        setIndices(markers.map((marker) => marker.siren));
      }
      for (const marker of markers) {
        const node = nodes.current.get(marker.siren);
        if (!node) continue;
        node.style.transform = `translate(${marker.x.toFixed(1)}px, ${marker.y.toFixed(1)}px)`;
        node.style.visibility = marker.behind ? "hidden" : "";
      }
    };
    layoutRef.current = layout;
    const stop = followViewer(layout, onViewerFrame);
    return () => {
      stop();
      layoutRef.current = null;
    };
  }, [getMarkers, onViewerFrame]);

  const selected = new Set(editor.selection.map((index) => index + 1));
  return (
    <div className="se-markers" aria-label="Siren positions">
      {indices.map((index) => {
        const light = draft.sirens[index - 1];
        return (
          <button
            key={index}
            ref={(node) => {
              if (node) nodes.current.set(index, node);
              else nodes.current.delete(index);
            }}
            type="button"
            className={`se-marker${selected.has(index) ? " is-selected" : ""}${light ? "" : " is-unset"}`}
            aria-label={light ? `Siren ${index}` : `Siren ${index}, no entry in this setting`}
            title={sirenLabel(light, index)}
            disabled={!light}
            onClick={(event) => selectSiren(editor, index, event)}
          >
            <span className="se-marker-dot" style={light ? { background: light.color } : undefined} aria-hidden="true" />
            {/* Numbers only on the selection, so a 30-light bar stays readable. */}
            {selected.has(index) ? <span className="se-marker-number">{index}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
