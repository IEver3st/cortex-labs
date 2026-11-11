import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeFile } from "@tauri-apps/plugin-fs";
import { open, save } from "@tauri-apps/plugin-dialog";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  AudioWaveform,
  Car,
  Check,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  Copy,
  FolderOpen,
  Loader2,
  Monitor,
  Package,
  Plus,
  Power,
  Server,
  Trash2,
  X,
} from "lucide-react";
import { HOTKEY_ACTIONS } from "../../lib/hotkeys";
import { useWorkspaceHotkeys } from "../../lib/use-workspace-hotkeys";
import { openFolderPath } from "../../lib/open-folder";
import { EngineAudio } from "../../lib/engine-audio.js";
import { POP_STYLES, createEngineState, stepEngine } from "../../lib/engine-sim.js";
import { mulberry32 } from "../../lib/engine-grains.js";
import {
  CHANNEL_LABELS,
  ONE_SHOT_LABELS,
  engineKey,
  findEngine,
  fivemEnsureLines,
  formatBytes,
  formatRpm,
  kindLabel,
  normalizeEngineState,
  sourceKey,
  downloadLabel,
  sourceLabel,
} from "../../lib/engine-sounds.js";
import EngineDyno from "./EngineDyno";
import { CopyButton, FolderField, Key, Note, Seg, errorText, isTauri, isTyping, pickedThisSession, useDeckClearance } from "./parts";
import { useSoundLibrary } from "./use-sound-library";
import { Toggle } from "../ui/toggle";
import { DeckButton, DropButton, ErrorText, InspectorTabs, Slider, StageEmpty, WorkspaceFrame, splitPath } from "../workspace/parts";
import { PaneResizer } from "../workspace/PaneResizer";

const PERSIST_DEBOUNCE_MS = 400;
const POP_LABELS = { off: "Off", pack: "Pops", crackle: "Crackle" };
const KEY_THROTTLE = new Set(["KeyW", "Space", "ArrowUp"]);
const KEY_BRAKE = new Set(["KeyS", "ArrowDown"]);
const coachedThisSession = { started: false, revved: false, compared: false };


function readPreviewFile(path) {
  return invoke("engine_sounds_read_wav", { path });
}

function EngineHelp() {
  const rows = [
    ["W", "Throttle (or Space, or hold the pedal)"],
    ["S", "Brake. Hold with throttle in N or 1st for the two-step"],
    ["E", "Shift up"],
    ["Q", "Shift down"],
    ["I", "Ignition"],
    ["P", "Pops: off, pops, crackle"],
    ["X", "Switch A and B"],
    ["R", "Record"],
  ];
  return (
    <div className="lv-help" role="dialog" aria-label="Keyboard controls">
      <dl>
        {rows.map(([key, text]) => (
          <div key={key}>
            <dt><kbd className="cx-keycap">{key}</kbd></dt>
            <dd>{text}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export default function EngineBench({ workspaceState, onStateChange, onRenameTab, isActive, contextBarTarget, viewSwitch, panes }) {
  const desktop = isTauri();
  const [settings, setSettings] = useState(() => normalizeEngineState(workspaceState));
  const [loaded, setLoaded] = useState({ a: null, b: null });
  const [loading, setLoading] = useState({ a: "", b: "" });
  const [loadError, setLoadError] = useState({ a: "", b: "" });
  const [running, setRunning] = useState(false);
  const [recording, setRecording] = useState(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [notice, setNotice] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [inspectorTab, setInspectorTab] = useState("sound");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [check, setCheck] = useState({ status: "idle", result: null, error: "", key: "" });
  const [install, setInstall] = useState({ status: "idle", result: null, error: "" });
  const [confirmRemove, setConfirmRemove] = useState("");
  const [singlePlayerOk, setSinglePlayerOk] = useState(false);
  const [forge, setForge] = useState({ available: false, status: "idle", error: "" });
  const [coached, setCoached] = useState(() => ({ ...coachedThisSession }));
  const deckRef = useDeckClearance();

  const audioRef = useRef(null);
  const dynoRef = useRef(null);
  const simRef = useRef(createEngineState());
  const inputRef = useRef({ keys: new Set(), pedal: 0, brake: false, shiftUp: false, shiftDown: false });
  const randomRef = useRef(mulberry32(11));
  const frameRef = useRef(0);
  const lastTimeRef = useRef(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  const onRenameTabRef = useRef(onRenameTab);
  onRenameTabRef.current = onRenameTab;
  const pedalRef = useRef(null);
  const liftRef = useRef({ peak: 0 });
  const startTimerRef = useRef(0);

  const slot = settings.slot;
  const activeRef = settings[slot];
  const activeLoaded = loaded[slot];
  const otherSlot = slot === "a" ? "b" : "a";
  const otherRef = settings[otherSlot];

  const flash = useCallback((message) => setNotice({ id: Date.now(), message }), []);
  const markCoached = useCallback((step) => {
    if (coachedThisSession[step]) return;
    coachedThisSession[step] = true;
    setCoached({ ...coachedThisSession });
  }, []);
  const pushAlert = useCallback((label, text) => {
    setAlerts((list) => [...list.filter((alert) => alert.label !== label), { id: `${label}-${Date.now()}`, label, text }].slice(-3));
  }, []);
  const dismissAlert = useCallback((id) => setAlerts((list) => list.filter((alert) => alert.id !== id)), []);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 2600);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const timer = setTimeout(() => onStateChangeRef.current?.(settings), PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [settings]);

  useEffect(() => () => onStateChangeRef.current?.(settingsRef.current), []);

  useEffect(() => {
    onRenameTabRef.current?.(activeRef?.audioName || "Sound Studio");
  }, [activeRef?.audioName]);

  const onImported = useCallback((entry, isFirst) => {
    const first = (entry.sources || []).flatMap((source) => (source.engines || []).filter((engine) => engine.previewable).map((engine) => ({ id: entry.id, source: source.id, audioName: engine.audioName })))[0];
    setSettings((prev) => {
      const picks = new Set(prev.install.picks);
      for (const source of entry.sources || []) if ((source.engines || []).length) picks.add(sourceKey({ id: entry.id, source: source.id }));
      const slotRef = isFirst && first ? first : prev[prev.slot];
      return { ...prev, [prev.slot]: slotRef, install: { ...prev.install, picks: [...picks] } };
    });
  }, []);

  const onRemoved = useCallback((id) => {
    setSettings((prev) => ({
      ...prev,
      a: prev.a?.id === id ? null : prev.a,
      b: prev.b?.id === id ? null : prev.b,
      install: { ...prev.install, picks: prev.install.picks.filter((key) => !key.startsWith(`${id}|`)) },
    }));
  }, []);

  const { library, libraryReady, importing, importErrors, dragging, pickDownload, pickFolder, removeEntry: removeLibraryEntry } = useSoundLibrary({ desktop, isActive, flash, pushAlert, onImported, onRemoved });
  const activeRow = useMemo(() => findEngine(library, activeRef), [library, activeRef]);
  const engineEntries = useMemo(() => library.filter((entry) => (entry.sources || []).some((source) => (source.engines || []).length)), [library]);

  const audio = useCallback(() => {
    audioRef.current ||= new EngineAudio();
    const engine = audioRef.current;
    engine.setMix(settingsRef.current.mix);
    return engine;
  }, []);

  useEffect(() => () => {
    cancelAnimationFrame(frameRef.current);
    clearTimeout(startTimerRef.current);
    audioRef.current?.dispose();
    audioRef.current = null;
  }, []);

  useEffect(() => {
    audioRef.current?.setMix(settings.mix);
  }, [settings.mix]);

  useEffect(() => {
    audioRef.current?.select(slot);
  }, [slot]);

  const loadSlot = useCallback(async (key, ref) => {
    if (!ref || !desktop) return;
    const wanted = engineKey(ref);
    setLoading((prev) => ({ ...prev, [key]: wanted }));
    setLoadError((prev) => ({ ...prev, [key]: "" }));
    try {
      const preview = await invoke("engine_sounds_preview", { id: ref.id, source: ref.source, audioName: ref.audioName });
      if (engineKey(settingsRef.current[key]) !== wanted) return;
      const info = await audio().load(key, preview, readPreviewFile);
      if (!info || engineKey(settingsRef.current[key]) !== wanted) return;
      audioRef.current?.select(settingsRef.current.slot);
      setLoaded((prev) => ({ ...prev, [key]: { ...info, key: wanted, preview } }));
    } catch (error) {
      if (engineKey(settingsRef.current[key]) !== wanted) return;
      audioRef.current?.clear(key);
      setLoaded((prev) => ({ ...prev, [key]: null }));
      setLoadError((prev) => ({ ...prev, [key]: errorText(error) }));
    } finally {
      setLoading((prev) => (prev[key] === wanted ? { ...prev, [key]: "" } : prev));
    }
  }, [audio, desktop]);

  const aKey = engineKey(settings.a);
  const bKey = engineKey(settings.b);
  useEffect(() => {
    if (!libraryReady) return;
    if (settings.a && findEngine(library, settings.a)) {
      if (loaded.a?.key !== aKey) loadSlot("a", settings.a);
    } else if (loaded.a) {
      audioRef.current?.clear("a");
      setLoaded((prev) => ({ ...prev, a: null }));
    }
  }, [aKey, libraryReady, library]);

  useEffect(() => {
    if (!libraryReady) return;
    if (settings.b && findEngine(library, settings.b)) {
      if (loaded.b?.key !== bKey) loadSlot("b", settings.b);
    } else if (loaded.b) {
      audioRef.current?.clear("b");
      setLoaded((prev) => ({ ...prev, b: null }));
    }
  }, [bKey, libraryReady, library]);

  const chooseEngine = useCallback((ref) => {
    setSettings((prev) => ({ ...prev, [prev.slot]: ref }));
  }, []);

  const selectSlot = useCallback((key) => {
    if (settingsRef.current.a && settingsRef.current.b && settingsRef.current.slot !== key) markCoached("compared");
    setSettings((prev) => ({ ...prev, slot: key }));
  }, [markCoached]);

  const togglePick = useCallback((key) => {
    setSettings((prev) => {
      const picks = prev.install.picks.includes(key) ? prev.install.picks.filter((pick) => pick !== key) : [...prev.install.picks, key];
      return { ...prev, install: { ...prev.install, picks } };
    });
  }, []);

  const updateInstall = useCallback((patch) => {
    setSettings((prev) => ({ ...prev, install: { ...prev.install, ...patch } }));
    setInstall({ status: "idle", result: null, error: "" });
  }, []);

  const removeEntry = useCallback((id) => {
    setConfirmRemove("");
    removeLibraryEntry(id);
  }, [removeLibraryEntry]);

  const tick = useCallback((now) => {
    if (!isActiveRef.current) {
      frameRef.current = 0;
      lastTimeRef.current = 0;
      return;
    }
    const last = lastTimeRef.current || now;
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
    lastTimeRef.current = now;
    const input = inputRef.current;
    const keyThrottle = [...input.keys].some((code) => KEY_THROTTLE.has(code)) ? 1 : 0;
    const throttle = Math.max(keyThrottle, input.pedal);
    const brake = input.brake || [...input.keys].some((code) => KEY_BRAKE.has(code));
    const prefs = settingsRef.current;
    const result = stepEngine(simRef.current, {
      throttle,
      brake,
      shiftUp: input.shiftUp,
      shiftDown: input.shiftDown,
      auto: prefs.autoShift,
      pops: prefs.pops,
    }, dt, randomRef.current);
    input.shiftUp = false;
    input.shiftDown = false;
    simRef.current = result.state;
    const engine = audioRef.current;
    if (engine) {
      engine.control(result.control);
      for (const event of result.events) {
        if (event.type === "pop") engine.play(event.set, { strength: event.strength, delay: event.delay || 0, bang: event.bang });
      }
      const lift = liftRef.current;
      lift.peak = Math.max(throttle * (result.state.rev > 0.45 ? 1 : 0), lift.peak - dt * 3);
      if (lift.peak > 0.7 && throttle < 0.15 && !lift.fired && engine.hasShot("dump_valve")) {
        engine.play("dump_valve", { strength: 0.8 });
        lift.fired = true;
      }
      if (throttle > 0.5) lift.fired = false;
    }
    dynoRef.current?.update(result.state, now / 1000);
    const sim = result.state;
    if (sim.running || sim.rev > 0.002) frameRef.current = requestAnimationFrame(tick);
    else {
      frameRef.current = 0;
      lastTimeRef.current = 0;
    }
  }, []);

  const kick = useCallback(() => {
    if (frameRef.current) return;
    lastTimeRef.current = 0;
    frameRef.current = requestAnimationFrame(tick);
  }, [tick]);

  useEffect(() => {
    if (isActive) {
      if (simRef.current.running || simRef.current.rev > 0.002) kick();
      return;
    }
    cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    inputRef.current.keys.clear();
    inputRef.current.pedal = 0;
    inputRef.current.brake = false;
    audioRef.current?.control({ ...simRef.current, running: false });
  }, [isActive, kick]);

  const ignition = useCallback(async () => {
    if (!activeLoaded) return;
    clearTimeout(startTimerRef.current);
    const engine = audio();
    try {
      await engine.ensure();
    } catch (error) {
      pushAlert("Audio didn't start", errorText(error));
      return;
    }
    const sim = simRef.current;
    if (sim.running) {
      engine.play("shutdown", { strength: 0.9 });
      simRef.current = { ...sim, running: false, throttle: 0, gear: 0, shift: null, limiter: false, launch: false };
      setRunning(false);
      kick();
      return;
    }
    markCoached("started");
    const crank = engine.hasShot("startup") ? Math.min(0.9, Math.max(0.25, engine.shotLength("startup") * 0.45)) : 0;
    if (crank) engine.play("startup", { strength: 0.9 });
    setRunning(true);
    startTimerRef.current = setTimeout(() => {
      simRef.current = { ...createEngineState(), running: true, rev: 0.02 };
      if (engine.hasShot("startup_revs")) engine.play("startup_revs", { strength: 0.8 });
      else {
        inputRef.current.pedal = 0.55;
        setTimeout(() => {
          if (inputRef.current.pedal === 0.55) inputRef.current.pedal = 0;
        }, 220);
      }
      dynoRef.current?.clearTrace();
      kick();
    }, crank * 1000);
  }, [activeLoaded, audio, kick, markCoached, pushAlert]);

  useEffect(() => {
    if (!activeLoaded && simRef.current.running) {
      simRef.current = { ...simRef.current, running: false };
      setRunning(false);
    }
  }, [activeLoaded]);

  const cyclePops = useCallback(() => {
    setSettings((prev) => ({ ...prev, pops: POP_STYLES[(POP_STYLES.indexOf(prev.pops) + 1) % POP_STYLES.length] }));
  }, []);

  const toggleRecording = useCallback(async () => {
    const engine = audioRef.current;
    if (!engine) return;
    if (!recording) {
      try {
        await engine.ensure();
      } catch (error) {
        pushAlert("Audio didn't start", errorText(error));
        return;
      }
      if (engine.startRecording()) setRecording({ startedAt: Date.now() });
      return;
    }
    setRecording(null);
    const take = await engine.stopRecording();
    if (!take) return;
    const name = `${(activeRef?.audioName || "engine").replace(/[^a-z0-9_-]+/gi, "_")}_rev.wav`;
    const target = await save({ title: "Save the recording", defaultPath: name, filters: [{ name: "WAV audio", extensions: ["wav"] }] }).catch(() => null);
    if (!target) return;
    try {
      await writeFile(target, take.wav);
      flash(`Saved ${take.seconds.toFixed(1)} s to ${splitPath(target).name}`);
    } catch (error) {
      pushAlert("Recording not saved", `${target}: ${errorText(error)}`);
    }
  }, [activeRef?.audioName, flash, pushAlert, recording]);

  const swapSlots = useCallback(() => {
    if (settingsRef.current.a && settingsRef.current.b) markCoached("compared");
    setSettings((prev) => (prev.a && prev.b ? { ...prev, slot: prev.slot === "a" ? "b" : "a" } : prev));
  }, [markCoached]);

  useEffect(() => {
    if (!isActive) return undefined;
    const down = (event) => {
      if (isTyping(event.target) || event.ctrlKey || event.altKey || event.metaKey) return;
      const code = event.code;
      const input = inputRef.current;
      if (KEY_THROTTLE.has(code) || KEY_BRAKE.has(code)) {
        event.preventDefault();
        if (KEY_THROTTLE.has(code) && simRef.current.running) markCoached("revved");
        if (!input.keys.has(code)) {
          input.keys.add(code);
          kick();
        }
        return;
      }
      if (event.repeat) return;
      if (code === "KeyE") input.shiftUp = true;
      else if (code === "KeyQ") input.shiftDown = true;
      else if (code === "KeyI") ignition();
      else if (code === "KeyP") cyclePops();
      else if (code === "KeyX") swapSlots();
      else if (code === "KeyR") toggleRecording();
      else return;
      event.preventDefault();
      kick();
    };
    const up = (event) => {
      inputRef.current.keys.delete(event.code);
    };
    const blur = () => inputRef.current.keys.clear();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [cyclePops, ignition, isActive, kick, markCoached, swapSlots, toggleRecording]);

  const pedalFrom = useCallback((event) => {
    const box = pedalRef.current?.getBoundingClientRect();
    if (!box) return 0;
    return Math.min(1, Math.max(0, (box.bottom - event.clientY) / box.height));
  }, []);

  const pedalHandlers = {
    onPointerDown: (event) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      inputRef.current.pedal = pedalFrom(event);
      markCoached("revved");
      kick();
    },
    onPointerMove: (event) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) inputRef.current.pedal = pedalFrom(event);
    },
    onPointerUp: () => {
      inputRef.current.pedal = 0;
    },
    onPointerCancel: () => {
      inputRef.current.pedal = 0;
    },
  };

  const hotkeys = useWorkspaceHotkeys({
    isActive,
    handlers: {
      [HOTKEY_ACTIONS.TOGGLE_PANEL]: () => setPanelCollapsed((value) => !value),
    },
  });

  const installItems = useMemo(() => {
    const items = [];
    for (const entry of library) {
      for (const source of entry.sources || []) {
        if (!(source.engines || []).length) continue;
        const key = sourceKey({ id: entry.id, source: source.id });
        if (settings.install.picks.includes(key)) items.push({ id: entry.id, source: source.id, kind: source.kind, label: sourceLabel(source) });
      }
    }
    return items;
  }, [library, settings.install.picks]);

  const { target, resourcesDir, spDir } = settings.install;
  const checkKey = `${resourcesDir}|${installItems.map(sourceKey).join(",")}`;
  const singlePlayerPicks = target === "fivem" ? installItems.filter((item) => item.kind === "rpf") : [];
  const singlePlayerDownloads = [...new Set(singlePlayerPicks.map((item) => downloadLabel(library.find((entry) => entry.id === item.id)?.name || "")))];

  useEffect(() => {
    setSinglePlayerOk(false);
  }, [checkKey]);

  useEffect(() => {
    if (!desktop) return;
    invoke("forge_find")
      .then((found) => setForge((prev) => ({ ...prev, available: Boolean(found) })))
      .catch(() => {});
  }, [desktop]);

  const assignInForge = useCallback(async (audioName) => {
    setForge((prev) => ({ ...prev, status: "working", error: "" }));
    try {
      await navigator.clipboard?.writeText(audioName).catch(() => {});
      const picked = await open({ multiple: false, directory: true, title: "Choose the vehicle resource that should use this sound" }).catch(() => null);
      if (typeof picked !== "string") {
        setForge((prev) => ({ ...prev, status: "idle" }));
        return;
      }
      const folder = await invoke("forge_resource_folder", { path: picked });
      if (!folder) throw new Error(`${picked} isn't a FiveM resource (no fxmanifest.lua).`);
      await invoke("forge_check_resource", { folder });
      setForge((prev) => ({ ...prev, status: "done" }));
      flash(`Opened in Forge. ${audioName} is on the clipboard for the engine sound field.`);
    } catch (error) {
      setForge((prev) => ({ ...prev, status: "error", error: errorText(error) }));
    }
  }, [flash]);

  useEffect(() => {
    if (target !== "fivem" || !resourcesDir || !installItems.length || !desktop) {
      setCheck({ status: "idle", result: null, error: "", key: "" });
      return undefined;
    }
    let cancelled = false;
    setCheck((prev) => ({ ...prev, status: "checking", key: checkKey }));
    const timer = setTimeout(() => {
      invoke("engine_sounds_check_fivem", { resourcesDir, items: installItems })
        .then((result) => !cancelled && setCheck({ status: "ready", result, error: "", key: checkKey }))
        .catch((error) => !cancelled && setCheck({ status: "error", result: null, error: errorText(error), key: checkKey }));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [checkKey, desktop, target]);

  const chooseFolder = useCallback(async (field, title) => {
    const current = settingsRef.current.install[field];
    const path = await open({ multiple: false, directory: true, title, defaultPath: current || undefined }).catch(() => null);
    if (typeof path !== "string") return "";
    pickedThisSession.add(path);
    updateInstall({ [field]: path });
    return path;
  }, [updateInstall]);

  const runInstall = useCallback(async () => {
    const field = target === "fivem" ? "resourcesDir" : "spDir";
    let folder = settingsRef.current.install[field];
    if (!pickedThisSession.has(folder)) {
      folder = await chooseFolder(field, target === "fivem" ? "Confirm your server's resources folder" : "Choose where the single-player packs go");
      if (!folder) return;
    }
    setInstall({ status: "working", result: null, error: "" });
    try {
      const items = installItems.map(({ id, source }) => ({ id, source }));
      const result = target === "fivem"
        ? await invoke("engine_sounds_install_fivem", { resourcesDir: folder, items, singlePlayerOk })
        : await invoke("engine_sounds_build_sp", { outDir: folder, items });
      setInstall({ status: "done", result, error: "" });
      setCheck((prev) => ({ ...prev, key: "" }));
    } catch (error) {
      setInstall({ status: "error", result: null, error: errorText(error) });
    }
  }, [chooseFolder, installItems, singlePlayerOk, target]);

  const frameState = { isActive, isBooting: false, contextBarTarget, panelCollapsed, setPanelCollapsed, hotkeys };
  const busyLoading = Boolean(loading[slot]);
  const slotError = loadError[slot];
  const conflicts = check.status === "ready" ? check.result?.conflicts || [] : [];
  const blocking = conflicts.filter((conflict) => !conflict.studio);
  const installBlocked = !desktop
    ? "Installing needs the desktop app."
    : !installItems.length
      ? "Include at least one download above."
      : target === "fivem" && !resourcesDir
        ? "Choose your server's resources folder."
        : target === "sp" && !spDir
          ? "Choose a folder for the packs."
          : target === "fivem" && blocking.length
            ? "Another resource already loads these sound files."
            : singlePlayerPicks.length && !singlePlayerOk
              ? "Turn on the switch once you've checked the credits."
              : "";
  const folderMissing = desktop && installItems.length
    ? target === "fivem" && !resourcesDir ? "resourcesDir" : target === "sp" && !spDir ? "spDir" : ""
    : "";
  const ensureLines = target === "fivem" && install.status === "done" ? fivemEnsureLines(install.result?.resources, check.result) : [];
  const preview = activeLoaded?.preview;
  const granular = preview?.granular || {};
  const range = activeLoaded?.range || null;
  const activeSource = activeRow?.source;
  const activeEntry = activeRow?.entry;
  const creditEntries = [activeEntry, ...installItems.map((item) => library.find((entry) => entry.id === item.id))]
    .filter((entry, index, list) => entry && list.findIndex((other) => other?.id === entry.id) === index);
  const openCredits = () => {
    setInspectorTab("credits");
    setInspectorOpen(true);
  };
  const metaLine = activeRef ? `<audioNameHash>${activeRef.audioName}</audioNameHash>` : "";
  const coach = !activeLoaded || busyLoading
    ? null
    : !running && !coached.started
      ? <>Press <Key>I</Key> or the power button to start the engine</>
      : running && !coached.revved
        ? <>Hold <Key>W</Key> or the pedal to rev.<br /><Key>E</Key> and <Key>Q</Key> change gear.</>
        : settings.a && settings.b && !coached.compared
          ? <>Press <Key>X</Key> to flip between A and B as you rev.</>
          : null;

  return (
    <WorkspaceFrame s={frameState} inspectorOpen={inspectorOpen} setInspectorOpen={setInspectorOpen} style={panes.style} className="es-root" viewSwitch={viewSwitch}>
      <aside className="lv-dock" aria-label="Engine sounds" inert={panelCollapsed}>
        <div className="lv-dock-scroll custom-scrollbar">
          <section className={`lv-slot ${engineEntries.length ? "is-filled" : "is-empty"}`}>
            <header className="lv-slot-head">
              <span className={`lv-step ${activeLoaded ? "is-done" : ""}`} aria-hidden="true">{activeLoaded ? <Check /> : 1}</span>
              <h3 className="lv-slot-title">Sound packs</h3>
              {engineEntries.length ? (
                <button type="button" className="cx-icon-btn" onClick={pickFolder} title="Import an unpacked folder" aria-label="Import an unpacked folder" disabled={!desktop || Boolean(importing)}>
                  <FolderOpen aria-hidden="true" />
                </button>
              ) : null}
            </header>
            <div className="lv-slot-body">
              {!desktop ? (
                <p className="lv-slot-note">Importing engine sounds needs the desktop app.</p>
              ) : (
                <>
                  {!engineEntries.length ? (
                    <>
                      <DropButton
                        title="Import a download"
                        hint="Drop a download from gta5-mods, or click to choose it."
                        onClick={pickDownload}
                      />
                      <button type="button" className="cx-btn is-quiet lv-btn-sm lv-folder-link" onClick={pickFolder}>
                        <FolderOpen aria-hidden="true" />
                        Import an unpacked folder
                      </button>
                    </>
                  ) : null}
                </>
              )}
              {importing ? (
                <p className="lv-slot-note is-idle" role="status">
                  <Loader2 className="es-spin" aria-hidden="true" />
                  <span title={importing.path}>Reading {splitPath(importing.path).name}{importing.total > 1 ? ` (${importing.index} of ${importing.total})` : ""}…</span>
                </p>
              ) : null}
              {importErrors.map((message) => <Note key={message} tone="error">{message}</Note>)}

              {engineEntries.length ? (
                <ul className="es-library custom-scrollbar" aria-label="Imported engine sounds">
                  {engineEntries.map((entry) => {
                    const engineSources = (entry.sources || []).filter((source) => (source.engines || []).length);
                    const single = engineSources.length === 1;
                    const includeChip = (source) => {
                      const pickKey = sourceKey({ id: entry.id, source: source.id });
                      const picked = settings.install.picks.includes(pickKey);
                      return (
                        <button
                          type="button"
                          className={`es-pick ${picked ? "is-on" : ""}`}
                          role="checkbox"
                          aria-checked={picked}
                          onClick={() => togglePick(pickKey)}
                          title={`${picked ? "Included in the install" : "Left out of the install"}\n${kindLabel(source.kind)} · ${source.path || sourceLabel(source)}`}
                        >
                          {picked ? <Check aria-hidden="true" /> : null}
                          <span>Include</span>
                        </button>
                      );
                    };
                    return (
                    <li key={entry.id} className="es-entry">
                      <div className="es-entry-head">
                        <span className="es-entry-name" title={entry.origin}>{downloadLabel(entry.name)}</span>
                        {single && confirmRemove !== entry.id ? includeChip(engineSources[0]) : null}
                        {confirmRemove === entry.id ? (
                          <span className="es-confirm">
                            <button type="button" className="cx-btn is-danger lv-btn-sm" onClick={() => removeEntry(entry.id)}>Remove</button>
                            <button type="button" className="cx-icon-btn" onClick={() => setConfirmRemove("")} aria-label="Keep it" title="Keep it"><X aria-hidden="true" /></button>
                          </span>
                        ) : (
                          <button type="button" className="cx-icon-btn es-entry-remove" onClick={() => setConfirmRemove(entry.id)} title="Remove from Studio. Your download stays where it is." aria-label={`Remove ${downloadLabel(entry.name)} from Studio`}>
                            <Trash2 aria-hidden="true" />
                          </button>
                        )}
                      </div>
                      {engineSources.map((source) => {
                        return (
                          <div key={source.id} className="es-source">
                            {single ? null : (
                              <div className="es-source-head">
                                <span className="es-source-kind" title={source.path}>{sourceLabel(source)}</span>
                                {includeChip(source)}
                              </div>
                            )}
                            <ul className="es-engines">
                              {source.engines.map((engine) => {
                                const ref = { id: entry.id, source: source.id, audioName: engine.audioName };
                                const key = engineKey(ref);
                                const inA = engineKey(settings.a) === key;
                                const inB = engineKey(settings.b) === key;
                                const selected = engineKey(activeRef) === key;
                                const available = (engine.channels || []).filter((channel) => channel.available).length;
                                const meta = !engine.previewable ? "Install only" : available < 6 ? `${available} of 6 channels` : "";
                                return (
                                  <li key={engine.audioName}>
                                    <button
                                      type="button"
                                      className={`es-engine ${selected ? "is-selected" : ""}`}
                                      onClick={() => chooseEngine(ref)}
                                      disabled={!engine.previewable}
                                      title={engine.previewable ? `Rev ${engine.audioName}` : "This sound has no granular engine data, so it can be installed but not revved here"}
                                    >
                                      <span className="es-engine-name">{engine.audioName}</span>
                                      {meta ? <span className="es-engine-meta">{meta}</span> : null}
                                      {inA || inB ? <span className="es-engine-slots">{inA ? <span>A</span> : null}{inB ? <span>B</span> : null}</span> : null}
                                    </button>
                                  </li>
                                );
                              })}
                            </ul>
                            {(source.missingBanks || []).length ? (
                              source.missingBanks.every((bank) => /_npc$/i.test(bank))
                                ? <Note tone="idle">No traffic version in this download. Your own car is unaffected.</Note>
                                : <Note tone="warn">Missing sound banks: {source.missingBanks.join(", ")}</Note>
                            ) : null}
                          </div>
                        );
                      })}
                    </li>
                    );
                  })}
                </ul>
              ) : null}
              {desktop && engineEntries.length ? (
                <button type="button" className="cx-btn lv-btn-sm es-import-more" onClick={pickDownload} disabled={Boolean(importing)}>
                  <Plus aria-hidden="true" />
                  Import another download
                </button>
              ) : null}
            </div>
          </section>

          <section className={`lv-slot ${install.status === "done" ? "is-filled" : "is-empty"} ${!engineEntries.length ? "is-disabled" : ""}`}>
            <header className="lv-slot-head">
              <span className={`lv-step ${install.status === "done" ? "is-done" : ""}`} aria-hidden="true">{install.status === "done" ? <Check /> : 2}</span>
              <h3 className="lv-slot-title">Install</h3>
            </header>
            <div className="lv-slot-body">
              {!engineEntries.length ? (
                <p className="lv-slot-note">Import an engine sound to install it.</p>
              ) : (
                <>
                  <Seg
                    label="Where"
                    value={target}
                    options={[
                      { id: "fivem", label: "FiveM server" },
                      { id: "sp", label: "Single player" },
                    ]}
                    onChange={(value) => updateInstall({ target: value })}
                  />
                  {target === "fivem" ? (
                    <>
                      {folderMissing === "resourcesDir" ? null : (
                        <FolderField
                          label="Resources folder"
                          path={resourcesDir}
                          emptyTitle="Choose the resources folder"
                          emptyHint="Your server's resources, or a [category] inside it"
                          onPick={() => chooseFolder("resourcesDir", "Choose your server's resources folder")}
                        />
                      )}
                      {check.status === "checking" ? <Note>Checking the server for clashes…</Note> : null}
                      {check.status === "error" ? <Note tone="error">{check.error}</Note> : null}
                      {conflicts.map((conflict) => (
                        <Note key={`${conflict.resource}-${conflict.file}`} tone={conflict.studio ? "idle" : "warn"}>
                          {conflict.studio
                            ? `${splitPath(conflict.resource).name} already has ${conflict.file}; installing again updates it.`
                            : `${splitPath(conflict.resource).name} already loads ${conflict.file}. Remove one of them first, or the game keeps only one.`}
                        </Note>
                      ))}
                    </>
                  ) : (
                    <>
                      {folderMissing === "spDir" ? null : (
                        <FolderField
                          label="Output folder"
                          path={spDir}
                          emptyTitle="Choose an output folder"
                          emptyHint="Studio writes a dlc.rpf folder and an .oiv per pack"
                          onPick={() => chooseFolder("spDir", "Choose where the single-player packs go")}
                        />
                      )}
                      <p className="lv-slot-note">For GTA V Legacy. Install the .oiv with OpenIV, or follow INSTALL.txt in each folder.</p>
                    </>
                  )}
                </>
              )}
            </div>
          </section>
        </div>
        {engineEntries.length ? (
        <div className="lv-dock-foot">
          {singlePlayerPicks.length ? (
            <div className="es-consent">
              <Note tone="warn">
                {singlePlayerDownloads.length > 2 ? `${singlePlayerDownloads.length} downloads` : singlePlayerDownloads.join(" and ")} {singlePlayerDownloads.length === 1 ? "was" : "were"} made for single player. FiveM streams {singlePlayerDownloads.length === 1 ? "it" : "them"} to every player. <button type="button" className="lv-link" onClick={openCredits}>Read the credits</button>
              </Note>
              <div className="lv-toggle-row">
                <span>The author allows FiveM use</span>
                <Toggle checked={singlePlayerOk} onChange={setSinglePlayerOk} ariaLabel="The author allows FiveM use" />
              </div>
            </div>
          ) : null}
          {folderMissing ? (
            <button type="button" className="cx-btn is-primary" onClick={() => chooseFolder(folderMissing, target === "fivem" ? "Choose your server's resources folder" : "Choose where the single-player packs go")}>
              <FolderOpen aria-hidden="true" />
              {target === "fivem" ? "Choose the resources folder" : "Choose an output folder"}
            </button>
          ) : (
            <button
              type="button"
              className="cx-btn is-primary"
              disabled={Boolean(installBlocked) || install.status === "working"}
              onClick={runInstall}
              title={installBlocked || undefined}
            >
              {install.status === "working" ? <Loader2 className="es-spin" aria-hidden="true" /> : target === "fivem" ? <Server aria-hidden="true" /> : <Package aria-hidden="true" />}
              {target === "fivem" ? "Install to the server" : "Build for single player"}
            </button>
          )}
          {folderMissing ? <p className="lv-foot-note">{target === "fivem" ? "Your server's resources, or a [category] inside it." : "Studio writes a dlc.rpf folder and an .oiv per pack."}</p> : null}
          {installBlocked && !folderMissing ? <p className="lv-foot-note">{installBlocked}</p> : null}
          {install.status === "error" ? <p className="lv-foot-note is-error"><ErrorText error={install.error} /></p> : null}
          {install.status === "done" && target === "fivem" ? (
            <div className="es-result" role="status">
              {(install.result?.resources || []).map((resource) => (
                <div key={resource.path} className="es-result-row">
                  <Check className="es-ok" aria-hidden="true" />
                  <span className="es-result-path" title={resource.path}>{resource.name}</span>
                  <button type="button" className="cx-icon-btn" onClick={() => openFolderPath(resource.path)} title="Open the folder" aria-label={`Open ${resource.name}`}>
                    <FolderOpen aria-hidden="true" />
                  </button>
                </div>
              ))}
              {ensureLines.length ? (
                <div className="es-ensure">
                  <span className="cx-label">Add to server.cfg</span>
                  <code>{ensureLines.join("\n")}</code>
                  <CopyButton text={ensureLines.join("\n")} label="Copy the ensure lines" />
                </div>
              ) : check.result?.category ? (
                <p className="lv-foot-note">Starts with {check.result.category} on the next restart.</p>
              ) : null}
            </div>
          ) : null}
          {install.status === "done" && target === "sp" ? (
            <div className="es-result" role="status">
              {(install.result?.packs || []).map((pack) => (
                <div key={pack.oiv} className="es-result-row">
                  <Check className="es-ok" aria-hidden="true" />
                  <span className="es-result-path" title={`${pack.folder}\n${pack.oiv}`}>{pack.pack}.oiv and dlc.rpf</span>
                  <button type="button" className="cx-icon-btn" onClick={() => openFolderPath(pack.folder)} title="Open the folder" aria-label={`Open ${pack.pack}`}>
                    <FolderOpen aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        ) : null}
        <PaneResizer side="dock" label="Resize the engine sounds panel" setWidth={panes.setWidth} />
      </aside>

      <section className={`lv-finder es-finder ${dragging ? "is-dragging" : ""}`} aria-label="Engine dyno">
        <div className="lv-stage es-stage">
          {!desktop ? (
            <StageEmpty icon={Monitor} title="Desktop app required" line="Reading engine sound packs needs the Cortex Studio desktop app." />
          ) : !activeRef && otherRef ? (
            <StageEmpty icon={AudioWaveform} title={`Pick a sound for ${slot.toUpperCase()}`} line={`Choose one in the list to compare it with ${otherRef.audioName}. X switches between them.`}>
              <button type="button" className="cx-btn" onClick={() => selectSlot(otherSlot)}>Back to {otherSlot.toUpperCase()}</button>
            </StageEmpty>
          ) : !activeRef ? (
            <StageEmpty icon={AudioWaveform} title={engineEntries.length ? "Pick an engine sound" : "No engine sound yet"} line={engineEntries.length ? "Choose one in the list to rev it." : "Import a download from gta5-mods, or drop one here."}>
              {!engineEntries.length ? <button type="button" className="cx-btn is-primary" onClick={pickDownload}><Plus aria-hidden="true" />Import a download</button> : null}
            </StageEmpty>
          ) : slotError ? (
            <StageEmpty tone="error" title={`${activeRef.audioName} didn't load`} line={slotError}>
              <button type="button" className="cx-btn" onClick={() => loadSlot(slot, activeRef)}>Try again</button>
            </StageEmpty>
          ) : (
            <div className="es-bench">
              <EngineDyno ref={dynoRef} range={range} label={activeRef.audioName} sublabel={activeEntry ? downloadLabel(activeEntry.name) : ""} coach={coach} />
              <div
                ref={pedalRef}
                className={`es-pedal ${activeLoaded && running ? "" : "is-off"}`}
                {...(activeLoaded && running ? pedalHandlers : {})}
                role="slider"
                aria-label="Throttle pedal"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={0}
                title={running ? "Hold to rev. Higher is more throttle." : "Start the engine first"}
              >
                <span className="cx-label">Pedal</span>
                <span className="es-pedal-well" />
              </div>
              {busyLoading ? (
                <div className="es-loading" role="status">
                  <Loader2 className="es-spin" aria-hidden="true" />
                  <span>Decoding {activeRef.audioName}…</span>
                </div>
              ) : null}
            </div>
          )}
        </div>

        <div className="lv-hud">
          <div className="lv-alerts" role="status" aria-live="polite">
            <AnimatePresence initial={false}>
              {alerts.map((alert) => (
                <motion.div key={alert.id} className="lv-alert" role="alert" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.16 }}>
                  <AlertTriangle className="lv-alert-icon" aria-hidden="true" />
                  <div className="lv-alert-copy">
                    <strong>{alert.label}</strong>
                    <ErrorText error={alert.text} />
                  </div>
                  <button type="button" className="cx-icon-btn" onClick={() => dismissAlert(alert.id)} aria-label="Dismiss">
                    <X aria-hidden="true" />
                  </button>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>

          <div className="lv-toasts">
            <AnimatePresence>
              {notice ? (
                <motion.div key={notice.id} className="lv-toast" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 12 }} transition={{ duration: 0.18 }}>
                  <Check aria-hidden="true" />
                  <span title={notice.message}>{notice.message}</span>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>

          {dragging ? (
            <div className="lv-dropzone" aria-hidden="true">
              <span className="cx-display">Release to import</span>
              <span>A .zip, .rar, .7z, .oiv, dlc.rpf or folder from gta5-mods.</span>
            </div>
          ) : null}

          {activeRef && !slotError ? (
            <div ref={deckRef} className="lv-deck es-deck" role="toolbar" aria-label="Engine controls">
              <div className="lv-deck-group">
                <DeckButton active={running} onClick={ignition} disabled={!activeLoaded} title={running ? "Turn the engine off (I)" : "Start the engine (I)"} className="is-icon">
                  <Power aria-hidden="true" />
                </DeckButton>
                <DeckButton onClick={() => { inputRef.current.shiftDown = true; kick(); }} disabled={!running} title="Shift down (Q)" className="is-icon">
                  <ChevronDown aria-hidden="true" />
                </DeckButton>
                <DeckButton onClick={() => { inputRef.current.shiftUp = true; kick(); }} disabled={!running} title="Shift up (E)" className="is-icon">
                  <ChevronUp aria-hidden="true" />
                </DeckButton>
                <DeckButton active={settings.autoShift} onClick={() => setSettings((prev) => ({ ...prev, autoShift: !prev.autoShift }))} title="Shift up at the limiter on its own">
                  Auto
                </DeckButton>
              </div>
              <div className="lv-deck-group" role="radiogroup" aria-label="Pops">
                {POP_STYLES.map((style) => (
                  <DeckButton key={style} active={settings.pops === style} onClick={() => setSettings((prev) => ({ ...prev, pops: style }))} title={style === "off" ? "No pops (P)" : style === "pack" ? "Pops on lift-off and at the limiter (P)" : "Long crackle on lift-off (P)"}>
                    {POP_LABELS[style]}
                  </DeckButton>
                ))}
              </div>
              <div className="lv-deck-group" role="radiogroup" aria-label="Compare">
                {["a", "b"].map((key) => (
                  <DeckButton
                    key={key}
                    active={slot === key}
                    onClick={() => selectSlot(key)}
                    title={settings[key] ? `${key.toUpperCase()}: ${settings[key].audioName} (X switches)` : key === "b" ? "Load a second sound to compare: pick B, then choose a sound" : "Slot A"}
                    className="es-slot-btn"
                  >
                    {key.toUpperCase()}
                  </DeckButton>
                ))}
              </div>
              <div className="lv-deck-group">
                <DeckButton active={Boolean(recording)} onClick={toggleRecording} disabled={!activeLoaded} title={recording ? "Stop and save the recording (R)" : "Record what you hear (R)"} className={`is-icon es-rec ${recording ? "is-live" : ""}`}>
                  <span className="es-rec-dot" aria-hidden="true" />
                </DeckButton>
                <DeckButton active={helpOpen} onClick={() => setHelpOpen((value) => !value)} title="Keyboard controls" className="is-icon">
                  <CircleHelp aria-hidden="true" />
                </DeckButton>
              </div>
              {helpOpen ? <EngineHelp /> : null}
            </div>
          ) : null}
        </div>
      </section>

      <aside className="lv-inspector" aria-label="Inspector" inert={panelCollapsed || !inspectorOpen}>
        <PaneResizer side="insp" label="Resize the inspector" setWidth={panes.setWidth} />
        <InspectorTabs
          tabs={[
            { id: "sound", label: "Sound" },
            { id: "details", label: "Details" },
            { id: "credits", label: "Credits" },
          ]}
          active={inspectorTab}
          onChange={setInspectorTab}
        />
        <div className="lv-inspector-scroll custom-scrollbar">
          {inspectorTab === "sound" ? (
            activeRef ? (
              <>
                <section className="lv-group">
                  <h3 className="lv-group-title">Use it on a car</h3>
                  <div className="es-meta-line">
                    <code title={metaLine}>&lt;audioNameHash&gt;<wbr />{activeRef.audioName}<wbr />&lt;/audioNameHash&gt;</code>
                    <CopyButton text={metaLine} label="Copy the vehicles.meta line" />
                  </div>
                  <p className="lv-slot-note">Paste into the car's vehicles.meta.</p>
                  {forge.available ? (
                    <button type="button" className="cx-btn lv-btn-sm" onClick={() => assignInForge(activeRef.audioName)} disabled={forge.status === "working"} title="Pick a vehicle resource. Forge opens it with the sound name on your clipboard.">
                      <Car aria-hidden="true" />
                      Assign to a vehicle in Forge
                    </button>
                  ) : null}
                  {forge.status === "error" ? <Note tone="error">{forge.error}</Note> : null}
                </section>
                <section className="lv-group">
                  <h3 className="lv-group-title">Mix</h3>
                  <Slider id="es-mix-engine" label="Engine" value={settings.mix.engine} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(engine) => setSettings((prev) => ({ ...prev, mix: { ...prev.mix, engine } }))} />
                  <Slider id="es-mix-exhaust" label="Exhaust" value={settings.mix.exhaust} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(exhaust) => setSettings((prev) => ({ ...prev, mix: { ...prev.mix, exhaust } }))} />
                  <Slider id="es-mix-volume" label="Volume" value={settings.mix.volume} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(volume) => setSettings((prev) => ({ ...prev, mix: { ...prev.mix, volume } }))} />
                </section>
              </>
            ) : (
              <p className="es-empty">Pick an engine sound to see its details.</p>
            )
          ) : null}

          {inspectorTab === "details" ? (
            activeLoaded && activeSource ? (
              <>
                <section className="lv-group">
                  <h3 className="lv-group-title">Engine</h3>
                  <dl className="es-facts">
                    <div><dt>Idle</dt><dd>{formatRpm(range?.idleRpm)} rpm</dd></div>
                    <div><dt>Redline</dt><dd>{formatRpm(range?.maxRpm)} rpm</dd></div>
                    <div><dt>Limiter</dt><dd>{granular.revLimiterGrainsToPlay || "?"} on, {granular.revLimiterGrainsToSkip || "?"} off</dd></div>
                  </dl>
                  <p className="lv-slot-note">A close preview. In game the car's handling shapes it further.</p>
                </section>
                <section className="lv-group">
                  <h3 className="lv-group-title">Channels</h3>
                  <ul className="es-rows">
                    {(activeSource?.engines || []).find((engine) => engine.audioName === activeRef.audioName)?.channels?.map((channel) => (
                      <li key={channel.role} className={`es-row ${channel.available ? "" : "is-missing"}`}>
                        <span className="es-row-label">{CHANNEL_LABELS[channel.role] || channel.role}</span>
                        <span className="es-row-meta">{channel.available ? `${channel.grains} grains · ${channel.seconds.toFixed(1)} s` : "Missing"}</span>
                      </li>
                    ))}
                  </ul>
                </section>
                <section className="lv-group">
                  <h3 className="lv-group-title">One-shots</h3>
                  <ul className="es-rows">
                    {(preview?.oneShots || []).map((shot) => (
                      <li key={shot.role} className="es-row">
                        <span className="es-row-label">{ONE_SHOT_LABELS[shot.role] || shot.role}</span>
                        <span className="es-row-meta">
                          {shot.files?.length
                            ? `${shot.files.length} from the pack`
                            : shot.stock
                              ? "Uses the game's own"
                              : "None"}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {activeLoaded.standIn && settings.pops !== "off" ? (
                    <Note tone="warn">This pack has no pop sounds, so Studio plays its own stand-in pops here. In game the car uses the game's pops.</Note>
                  ) : null}
                </section>
                <section className="lv-group">
                  <h3 className="lv-group-title">Source</h3>
                  <dl className="es-facts">
                    <div><dt>Type</dt><dd>{kindLabel(activeSource.kind)}</dd></div>
                    <div><dt>From</dt><dd title={activeEntry?.origin}>{activeEntry ? downloadLabel(activeEntry.name) : ""}</dd></div>
                  </dl>
                  {(activeSource.warnings || []).map((warning) => <Note key={warning} tone="warn">{warning}</Note>)}
                </section>
                <section className="lv-group">
                  <div className="lv-group-head">
                    <h3 className="lv-group-title">Audio data</h3>
                    <span className="es-count">{(activeSource.relFiles || []).length}</span>
                  </div>
                  <ul className="es-rows">
                    {(activeSource.relFiles || []).map((file) => (
                      <li key={file.path} className="es-row">
                        <span className="es-row-label" title={file.path}>{splitPath(file.path).name}</span>
                        <span className="es-row-meta">{file.type || "unused"} · {formatBytes(file.bytes)}</span>
                      </li>
                    ))}
                  </ul>
                </section>
                <section className="lv-group">
                  <div className="lv-group-head">
                    <h3 className="lv-group-title">Wave banks</h3>
                    <span className="es-count">{(activeSource.awcFiles || []).length}</span>
                  </div>
                  <ul className="es-rows">
                    {(activeSource.awcFiles || []).map((file) => (
                      <li key={file.path} className="es-row">
                        <span className="es-row-label" title={file.path}>{splitPath(file.path).name}</span>
                        <span className="es-row-meta">{formatBytes(file.bytes)}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              </>
            ) : (
              <p className="es-empty">{activeRef ? "Decoding the sound…" : "Pick an engine sound to see its details."}</p>
            )
          ) : null}

          {inspectorTab === "credits" ? (
            creditEntries.length ? (
              <>
                {creditEntries.map((entry) => (
                  <section key={entry.id} className="lv-group">
                    <h3 className="lv-group-title">{downloadLabel(entry.name)}</h3>
                    {entry.readme ? (
                      <div className="es-readme">{entry.readme}</div>
                    ) : (
                      <p className="lv-slot-note">No readme. Credit the author from its gta5-mods page.</p>
                    )}
                  </section>
                ))}
                <p className="lv-slot-note">Installs carry these notes as CREDITS.txt. Use each sound the way its author allows.</p>
              </>
            ) : (
              <p className="es-empty">Pick an engine sound to see its credits.</p>
            )
          ) : null}
        </div>
      </aside>
    </WorkspaceFrame>
  );
}
