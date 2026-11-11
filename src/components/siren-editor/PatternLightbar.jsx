import { useEffect, useMemo, useRef } from "react";
import { beatsPerSecond, evaluateSirens, normalizeLightSwitches } from "../../lib/emergency-lights.js";
import { dualHeads } from "../../lib/siren-settings.js";

export default function PatternLightbar({ s }) {
  const editor = s.sirenEditor;
  const playing = s.sirenTrial || editor.draft;
  const lights = s.vehicleLights || {};
  const switches = normalizeLightSwitches(lights.switches);
  const speed = Number.isFinite(lights.speed) ? lights.speed : 1;
  const muted = useMemo(() => new Set(lights.muted || []), [lights.muted]);
  const bar = useRef(null);
  const columns = useMemo(() => {
    const heads = dualHeads(playing);
    return (playing?.sirens || []).flatMap((_, index) => {
      const pair = heads.get(index);
      if (pair) return pair[0] === index ? [pair] : [];
      return [[index]];
    });
  }, [playing]);
  const bps = beatsPerSecond(playing);
  const running = s.isActive !== false && switches.sirens && speed > 0 && bps > 0;
  const { getLightTime } = s;

  useEffect(() => {
    const lamps = Array.from(bar.current?.children || [], (node) => ({
      node,
      members: node.dataset.members.split(",").map(Number),
      key: null,
    }));
    const paint = () => {
      const time = getLightTime?.();
      const live = switches.sirens && Number.isFinite(time) && bps > 0;
      const states = live ? evaluateSirens(playing, time) : [];
      for (const lamp of lamps) {
        const lit = [];
        for (const index of lamp.members) {
          if (states[index]?.on && !muted.has(index + 1)) lit.push(states[index].color);
        }
        const key = lit.join(" ");
        if (lamp.key === key) continue;
        lamp.key = key;
        lamp.node.style.setProperty("--lit", lit[0] || "transparent");
        lamp.node.style.setProperty("--lit-b", lit[1] || lit[0] || "transparent");
        lamp.node.classList.toggle("is-on", lit.length > 0);
      }
    };
    paint();
    if (!running) return undefined;
    let frame = requestAnimationFrame(function tick() {
      paint();
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing, bps, running, muted, switches.sirens, getLightTime]);

  if (!columns.length) return null;
  return (
    <div className="sw-lightbar" role="img" aria-label={`Pattern preview: ${columns.length} siren ${columns.length === 1 ? "head" : "heads"}`}>
      <div className="sw-lightbar-housing" ref={bar} style={{ "--lamps": columns.length }}>
        {columns.map((members) => {
          const colors = members.map((index) => playing.sirens[index]?.color || "#ffffff");
          return (
            <span
              key={members.join(",")}
              className="sw-lamp"
              data-members={members.join(",")}
              style={{ "--off": colors[0], "--off-b": colors[1] || colors[0] }}
              title={members.map((index) => `Siren ${index + 1}`).join(" + ")}
            />
          );
        })}
      </div>
      {switches.sirens ? null : <span className="sw-lightbar-note">Sirens are off</span>}
    </div>
  );
}
