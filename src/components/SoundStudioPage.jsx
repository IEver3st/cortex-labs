import { useCallback, useEffect, useRef, useState } from "react";
import { Gauge, Siren } from "lucide-react";
import EngineBench from "./sound/EngineBench";
import SirenBench from "./sound/SirenBench";
import { usePaneWidths } from "./workspace/PaneResizer";
import "./SoundStudioPage.css";

const MODES = [
  { id: "engines", label: "Engines", icon: Gauge, title: "Rev engine sounds and install them" },
  { id: "sirens", label: "Sirens", icon: Siren, title: "Run sirens and build server-side siren packs" },
];

function readState(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    mode: source.mode === "sirens" ? "sirens" : "engines",
    engines: source.engines && typeof source.engines === "object" ? source.engines : {},
    sirens: source.sirens && typeof source.sirens === "object" ? source.sirens : {},
  };
}

export default function SoundStudioPage({ workspaceState, onStateChange, onRenameTab, isActive, contextBarTarget }) {
  const [initial] = useState(() => readState(workspaceState));
  const [mode, setMode] = useState(initial.mode);
  const stateRef = useRef(initial);
  const panes = usePaneWidths("cortex.sounds.panes");
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;

  const save = useCallback((patch) => {
    stateRef.current = { ...stateRef.current, ...patch };
    onStateChangeRef.current?.(stateRef.current);
  }, []);

  useEffect(() => {
    if (stateRef.current.mode !== mode) save({ mode });
  }, [mode, save]);

  const saveEngines = useCallback((engines) => save({ engines }), [save]);
  const saveSirens = useCallback((sirens) => save({ sirens }), [save]);

  const viewSwitch = (
    <div className="lv-ctx-seg" role="group" aria-label="Sound Studio mode">
      {MODES.map(({ id, label, icon: Icon, title }) => (
        <button
          key={id}
          type="button"
          className={`lv-ctx-seg-btn ${mode === id ? "is-on" : ""}`}
          aria-pressed={mode === id}
          title={title}
          onClick={() => setMode(id)}
        >
          <Icon aria-hidden="true" />
          {label}
        </button>
      ))}
    </div>
  );

  const shared = { onRenameTab, isActive, contextBarTarget, viewSwitch, panes };
  return mode === "sirens" ? (
    <SirenBench key="sirens" workspaceState={stateRef.current.sirens} onStateChange={saveSirens} {...shared} />
  ) : (
    <EngineBench key="engines" workspaceState={stateRef.current.engines} onStateChange={saveEngines} {...shared} />
  );
}
