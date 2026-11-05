import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeFile } from "@tauri-apps/plugin-fs";
import { open, save } from "@tauri-apps/plugin-dialog";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Car,
  Check,
  CircleHelp,
  FileAudio,
  FolderOpen,
  Loader2,
  Megaphone,
  Monitor,
  Package,
  Play,
  Plus,
  Power,
  Server,
  Siren,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { HOTKEY_ACTIONS } from "../../lib/hotkeys";
import { useWorkspaceHotkeys } from "../../lib/use-workspace-hotkeys";
import { openFolderPath } from "../../lib/open-folder";
import { SirenAudio } from "../../lib/siren-audio.js";
import { sharedAudioContext } from "../../lib/engine-audio.js";
import { parseWav } from "../../lib/engine-grains.js";
import { downloadLabel } from "../../lib/engine-sounds.js";
import {
  AUDIO_EXTENSIONS,
  MAX_PACK_TONES,
  SIREN_ROLES,
  SIREN_SCENES,
  encodeToneWav,
  estimatePitch,
  fleetReference,
  librarySirens,
  findLibraryTone,
  firstToneNumber,
  lvcSnippet,
  normalizeSirenState,
  packDlcName,
  packToneKey,
  parseVehicles,
  pitchSweep,
  playbackLevel,
  renderTone,
  renderedToneBytes,
  roleFromName,
  roleLabel,
  sanitizeName,
  toneLabelFrom,
  toneRefKey,
  uniqueName,
} from "../../lib/siren-tones.js";
import SirenScope, { SirenWave } from "./SirenScope";
import { CopyButton, FolderField, Key, Note, Seg, errorText, isTauri, isTyping, pickedThisSession, useDeckClearance } from "./parts";
import { useSoundLibrary } from "./use-sound-library";
import { Toggle } from "../ui/toggle";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { DeckButton, DropButton, ErrorText, InspectorTabs, Slider, StageEmpty, WorkspaceFrame, splitPath } from "../workspace/parts";
import { PaneResizer } from "../workspace/PaneResizer";

const PERSIST_DEBOUNCE_MS = 400;
const BANK_WARN_BYTES = 10 * 1024 * 1024;
const SCENE_LABELS = { street: "Street", cabin: "Cabin", far: "Blocks away" };
const KIND_LABELS = { resident: "RESIDENT.rpf", wavs: "Siren Mastery", fivem: "FiveM resource" };
const SP_KINDS = new Set(["resident", "wavs"]);
const coachedThisSession = { raw: false, pack: false };

function sourceKeyOf(id, source) {
  return `${id}|${source}`;
}

function fileName(path) {
  return splitPath(path).name.replace(/\.[a-z0-9]{2,4}$/i, "");
}

function seconds(value) {
  if (!Number.isFinite(value) || value <= 0) return "";
  return value < 1 ? `${Math.max(1, Math.round(value * 1000))} ms` : `${value.toFixed(value < 10 ? 1 : 0)} s`;
}

function mixDown(buffer) {
  const out = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < data.length; index += 1) out[index] += data[index] / buffer.numberOfChannels;
  }
  return out;
}

function tryParseWav(bytes) {
  try {
    return parseWav(bytes);
  } catch {
    return null;
  }
}

function SirenHelp() {
  const rows = [
    ["1-9", "Run that tone from the pack"],
    ["Space", "Siren on or off"],
    ["H", "Hold for the horn"],
    ["M", "Hold for the manual wind-up"],
    ["D", "Drive-by: the car passes you"],
    ["C", "Clear an intersection"],
    ["B", "Rumbler"],
    ["V", "Where you stand: street, cabin, blocks away"],
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

function HoldButton({ active, disabled, title, onDown, onUp, children }) {
  return (
    <button
      type="button"
      className={`lv-deck-btn is-icon ${active ? "is-on" : ""}`}
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        onDown();
      }}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onLostPointerCapture={onUp}
    >
      {children}
    </button>
  );
}

export default function SirenBench({ workspaceState, onStateChange, onRenameTab, isActive, contextBarTarget, viewSwitch, panes }) {
  const desktop = isTauri();
  const [settings, setSettings] = useState(() => normalizeSirenState(workspaceState));
  const [decoded, setDecoded] = useState({});
  const [playing, setPlaying] = useState(null);
  const [holding, setHolding] = useState({ horn: false, manual: false });
  const [driving, setDriving] = useState(false);
  const [sequence, setSequence] = useState(false);
  const [recording, setRecording] = useState(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [notice, setNotice] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [inspectorTab, setInspectorTab] = useState("tone");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [focusTone, setFocusTone] = useState("");
  const [confirmRemove, setConfirmRemove] = useState("");
  const [authorOk, setAuthorOk] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const [install, setInstall] = useState({ status: "idle", result: null, error: "", step: "" });
  const [sweep, setSweep] = useState(null);
  const [coached, setCoached] = useState(() => ({ ...coachedThisSession }));
  const deckRef = useDeckClearance();

  const audioRef = useRef(null);
  const scopeRef = useRef(null);
  const samplesRef = useRef(new Map());
  const pendingRef = useRef(new Map());
  const previewsRef = useRef(new Map());
  const frameRef = useRef(0);
  const quietRef = useRef(0);
  const sequenceRef = useRef(null);
  const playingRef = useRef(null);
  playingRef.current = playing;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  const onRenameTabRef = useRef(onRenameTab);
  onRenameTabRef.current = onRenameTab;

  const flash = useCallback((message) => setNotice({ id: Date.now(), message }), []);
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

  const pack = settings.pack;
  useEffect(() => {
    onRenameTabRef.current?.(pack.tones.length ? pack.name : "Sound Studio");
  }, [pack.name, pack.tones.length]);

  const addFiles = useCallback((paths) => {
    const list = (paths || []).filter((path) => typeof path === "string" && AUDIO_EXTENSIONS.includes(path.split(".").pop()?.toLowerCase()));
    if (!list.length) return;
    setSettings((prev) => {
      const files = [...new Set([...prev.files, ...list])].slice(0, 64);
      const selected = prev.selected || { kind: "file", path: list[0] };
      return { ...prev, files, selected };
    });
    flash(list.length === 1 ? `Added ${splitPath(list[0]).name}` : `Added ${list.length} audio files`);
  }, [flash]);

  const onImported = useCallback((entry, isFirst) => {
    const first = (entry.sirens || []).flatMap((source) => (source.tones || []).map((tone) => ({ kind: "lib", id: entry.id, source: source.id, tone: tone.id })))[0] || null;
    setSettings((prev) => {
      const picks = new Set(prev.install.picks);
      for (const source of entry.sirens || []) if (SP_KINDS.has(source.kind)) picks.add(sourceKeyOf(entry.id, source.id));
      return { ...prev, selected: (isFirst && first) || prev.selected || first, install: { ...prev.install, picks: [...picks] } };
    });
  }, []);

  const onRemoved = useCallback((id) => {
    setSettings((prev) => ({
      ...prev,
      selected: prev.selected?.kind === "lib" && prev.selected.id === id ? null : prev.selected,
      pack: { ...prev.pack, tones: prev.pack.tones.filter((tone) => !(tone.ref.kind === "lib" && tone.ref.id === id)) },
      install: { ...prev.install, picks: prev.install.picks.filter((key) => !key.startsWith(`${id}|`)) },
    }));
    for (const key of [...previewsRef.current.keys()]) if (key.startsWith(`${id}|`)) previewsRef.current.delete(key);
  }, []);

  const { library, setLibrary, libraryReady, importing, importErrors, dragging, pickDownload, pickFolder, removeEntry: removeLibraryEntry } = useSoundLibrary({
    desktop,
    isActive,
    flash,
    pushAlert,
    onImported,
    onRemoved,
    onDropAudio: addFiles,
    gtaFolder: settings.gtaFolder,
  });

  const sirenEntries = useMemo(() => library.filter((entry) => (entry.sirens || []).length), [library]);
  const libraryTones = useMemo(() => librarySirens(library), [library]);
  const needsGame = useMemo(() => sirenEntries.filter((entry) => entry.sirens.some((source) => source.needsGame)), [sirenEntries]);

  const audio = useCallback(() => {
    if (!audioRef.current) {
      const engine = new SirenAudio();
      engine.setVolume(settingsRef.current.volume);
      engine.setScene(settingsRef.current.scene);
      engine.setRumbler(settingsRef.current.rumbler);
      audioRef.current = engine;
    }
    return audioRef.current;
  }, []);

  const loadPreview = useCallback((id, source) => {
    const key = sourceKeyOf(id, source);
    if (!previewsRef.current.has(key)) {
      const gtaFolder = settingsRef.current.gtaFolder || null;
      const promise = invoke("engine_sounds_siren_preview", { id, source, gtaFolder }).catch((error) => {
        previewsRef.current.delete(key);
        throw error;
      });
      previewsRef.current.set(key, promise);
    }
    return previewsRef.current.get(key);
  }, []);

  const readSamples = useCallback(async (ref) => {
    if (ref.kind === "lib") {
      const found = findLibraryTone(library, ref);
      if (!found) throw new Error("That tone isn't in the library any more.");
      if (found.source.needsGame) throw new Error("Choose your GTA V folder so Studio can read this RESIDENT.rpf pack.");
      const preview = await loadPreview(ref.id, ref.source);
      const tone = (preview?.tones || []).find((item) => (item.id && item.id === ref.tone) || item.name === found.tone.name);
      if (!tone?.path) throw new Error(`${found.tone.name} wasn't decoded.`);
      const bytes = await invoke("engine_sounds_read_wav", { path: tone.path });
      return parseWav(bytes);
    }
    const bytes = await invoke("engine_sounds_read_audio", { path: ref.path });
    const wav = /\.wav$/i.test(ref.path) ? tryParseWav(bytes) : null;
    if (wav) return wav;
    const context = await sharedAudioContext();
    const buffer = await context.decodeAudioData(bytes instanceof ArrayBuffer ? bytes.slice(0) : new Uint8Array(bytes).buffer);
    return { samples: mixDown(buffer), sampleRate: buffer.sampleRate };
  }, [library, loadPreview]);

  const ensureSamples = useCallback(async (ref) => {
    const key = toneRefKey(ref);
    const cached = samplesRef.current.get(key);
    if (cached) return cached;
    if (pendingRef.current.has(key)) return pendingRef.current.get(key);
    setDecoded((prev) => ({ ...prev, [key]: { status: "loading" } }));
    const job = readSamples(ref)
      .then((result) => {
        if (!result?.samples?.length) throw new Error("That audio has no samples.");
        const entry = { samples: result.samples, sampleRate: result.sampleRate, seconds: result.samples.length / result.sampleRate };
        samplesRef.current.set(key, entry);
        setDecoded((prev) => ({ ...prev, [key]: { status: "ready", seconds: entry.seconds, sampleRate: entry.sampleRate } }));
        return entry;
      })
      .catch((error) => {
        setDecoded((prev) => ({ ...prev, [key]: { status: "error", error: errorText(error) } }));
        throw error;
      })
      .finally(() => pendingRef.current.delete(key));
    pendingRef.current.set(key, job);
    return job;
  }, [readSamples]);

  const prepareRaw = useCallback(async (ref) => {
    const key = `raw|${toneRefKey(ref)}`;
    const engine = audio();
    if (!engine.has(key)) {
      const entry = await ensureSamples(ref);
      await engine.load(key, entry.samples, entry.sampleRate, playbackLevel(entry.samples));
    }
    return key;
  }, [audio, ensureSamples]);

  const preparePack = useCallback(async (tone) => {
    const key = packToneKey(tone);
    const engine = audio();
    if (!engine.has(key)) {
      const entry = await ensureSamples(tone.ref);
      const rendered = renderTone(entry.samples, entry.sampleRate, tone);
      await engine.load(key, rendered.samples, rendered.sampleRate);
    }
    return key;
  }, [audio, ensureSamples]);

  const tick = useCallback(() => {
    const engine = audioRef.current;
    const frame = engine?.readFrame();
    if (!engine || !frame) {
      frameRef.current = 0;
      return;
    }
    let energy = 0;
    for (let index = 0; index < frame.length; index += 1) energy += frame[index] * frame[index];
    const level = Math.sqrt(energy / frame.length);
    const hz = level > 0.003 ? estimatePitch(frame, engine.sampleRate()) : 0;
    scopeRef.current?.push(hz);
    const progress = engine.driveProgress();
    scopeRef.current?.drive(progress);
    if (progress === null) setDriving(false);
    const busy = engine.currentTone() || engine.horn || engine.manual || progress !== null;
    quietRef.current = busy || level > 0.002 ? 0 : quietRef.current + 1;
    if (quietRef.current > 90) {
      frameRef.current = 0;
      return;
    }
    frameRef.current = requestAnimationFrame(tick);
  }, []);

  const kick = useCallback(() => {
    quietRef.current = 0;
    if (!frameRef.current) frameRef.current = requestAnimationFrame(tick);
  }, [tick]);

  const startKey = useCallback(async (key, next) => {
    const engine = audio();
    try {
      await engine.ensure();
      await engine.setTone(key);
      setPlaying(next);
      kick();
      if (!coachedThisSession[next.kind]) {
        coachedThisSession[next.kind] = true;
        setCoached({ ...coachedThisSession });
      }
    } catch (error) {
      pushAlert("Tone didn't play", errorText(error));
    }
  }, [audio, kick, pushAlert]);

  const stopTone = useCallback(async () => {
    const engine = audioRef.current;
    if (engine) await engine.setTone(null).catch(() => {});
    setPlaying(null);
  }, []);

  const playPackTone = useCallback(async (index) => {
    const tone = settingsRef.current.pack.tones[index];
    if (!tone) return;
    setFocusTone(tone.name);
    try {
      const key = await preparePack(tone);
      await startKey(key, { kind: "pack", name: tone.name, key });
    } catch (error) {
      pushAlert(`${tone.label} didn't load`, errorText(error));
    }
  }, [preparePack, pushAlert, startKey]);

  const audition = useCallback(async (ref) => {
    setSettings((prev) => ({ ...prev, selected: ref }));
    setFocusTone("");
    const key = `raw|${toneRefKey(ref)}`;
    if (playingRef.current?.key === key) {
      await stopTone();
      return;
    }
    try {
      const ready = await prepareRaw(ref);
      await startKey(ready, { kind: "raw", key: ready, ref });
    } catch (error) {
      pushAlert("Tone didn't load", errorText(error));
    }
  }, [prepareRaw, pushAlert, startKey, stopTone]);

  const cancelSequence = useCallback(() => {
    const running = sequenceRef.current;
    if (!running) return;
    running.cancelled = true;
    for (const timer of running.timers) clearTimeout(timer);
    sequenceRef.current = null;
    audioRef.current?.hornUp();
    setSequence(false);
  }, []);

  const toggleSiren = useCallback(async () => {
    cancelSequence();
    if (playingRef.current) {
      await stopTone();
      return;
    }
    const prefs = settingsRef.current;
    const focusIndex = prefs.pack.tones.findIndex((tone) => tone.name === focusTone);
    if (prefs.pack.tones.length) {
      await playPackTone(focusIndex >= 0 ? focusIndex : 0);
      return;
    }
    if (prefs.selected) await audition(prefs.selected);
  }, [audition, cancelSequence, focusTone, playPackTone, stopTone]);

  const hornKey = useCallback(async () => {
    const tone = settingsRef.current.pack.tones.find((item) => item.role === "horn");
    if (!tone) return null;
    try {
      return await preparePack(tone);
    } catch {
      return null;
    }
  }, [preparePack]);

  const hornDown = useCallback(async () => {
    cancelSequence();
    setHolding((prev) => ({ ...prev, horn: true }));
    try {
      const engine = audio();
      await engine.hornDown(await hornKey());
      kick();
    } catch (error) {
      pushAlert("Horn didn't play", errorText(error));
    }
  }, [audio, cancelSequence, hornKey, kick, pushAlert]);

  const hornUp = useCallback(() => {
    setHolding((prev) => ({ ...prev, horn: false }));
    audioRef.current?.hornUp();
  }, []);

  const manualDown = useCallback(async () => {
    setHolding((prev) => ({ ...prev, manual: true }));
    try {
      await audio().manualDown();
      kick();
    } catch (error) {
      pushAlert("Manual didn't play", errorText(error));
    }
  }, [audio, kick, pushAlert]);

  const manualUp = useCallback(() => {
    setHolding((prev) => ({ ...prev, manual: false }));
    audioRef.current?.manualUp();
  }, []);

  const driveBy = useCallback(async () => {
    const engine = audio();
    if (engine.driveBy) {
      engine.stopDriveBy();
      setDriving(false);
      return;
    }
    if (!playingRef.current) {
      if (settingsRef.current.pack.tones.length) await playPackTone(0);
      else if (settingsRef.current.selected) await audition(settingsRef.current.selected);
    }
    try {
      await engine.startDriveBy(settingsRef.current.driveSpeed);
      setDriving(true);
      kick();
    } catch (error) {
      pushAlert("Drive-by didn't start", errorText(error));
    }
  }, [audio, audition, kick, playPackTone, pushAlert]);

  const intersection = useCallback(async () => {
    if (sequenceRef.current) {
      cancelSequence();
      return;
    }
    const tones = settingsRef.current.pack.tones;
    if (!tones.length) return;
    const nonHorn = tones.map((tone, index) => (tone.role === "horn" ? -1 : index)).filter((index) => index >= 0);
    const pick = (role, order) => {
      const index = tones.findIndex((tone) => tone.role === role);
      return index >= 0 ? index : nonHorn[Math.min(order, nonHorn.length - 1)] ?? 0;
    };
    const plan = [
      [0, "tone", pick("wail", 0)],
      [1900, "tone", pick("yelp", 1)],
      [3300, "tone", pick("priority", 2)],
      [4500, "down"],
      [4800, "up"],
      [4950, "down"],
      [5250, "up"],
      [5400, "down"],
      [6100, "up"],
      [6200, "tone", pick("wail", 0)],
    ];
    const hornReady = await hornKey();
    const running = { cancelled: false, timers: [] };
    sequenceRef.current = running;
    setSequence(true);
    for (const [at, kind, index] of plan) {
      running.timers.push(setTimeout(() => {
        if (running.cancelled) return;
        if (kind === "tone") playPackTone(index);
        else if (kind === "down") audioRef.current?.hornDown(hornReady).then(kick).catch(() => {});
        else audioRef.current?.hornUp();
      }, at));
    }
    running.timers.push(setTimeout(() => {
      if (sequenceRef.current === running) {
        sequenceRef.current = null;
        setSequence(false);
      }
    }, 6300));
  }, [cancelSequence, hornKey, kick, playPackTone]);

  const toggleRumbler = useCallback(() => {
    setSettings((prev) => ({ ...prev, rumbler: !prev.rumbler }));
  }, []);

  const cycleScene = useCallback(() => {
    setSettings((prev) => ({ ...prev, scene: SIREN_SCENES[(SIREN_SCENES.indexOf(prev.scene) + 1) % SIREN_SCENES.length] }));
  }, []);

  useEffect(() => {
    audioRef.current?.setRumbler(settings.rumbler);
  }, [settings.rumbler]);

  useEffect(() => {
    audioRef.current?.setScene(settings.scene);
  }, [settings.scene]);

  useEffect(() => {
    audioRef.current?.setVolume(settings.volume);
  }, [settings.volume]);

  const toggleRecording = useCallback(async () => {
    const engine = audio();
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
    const target = await save({ title: "Save the recording", defaultPath: `${settingsRef.current.pack.name}_run.wav`, filters: [{ name: "WAV audio", extensions: ["wav"] }] }).catch(() => null);
    if (!target) return;
    try {
      await writeFile(target, new Uint8Array(take.wav));
      flash(`Saved ${take.seconds.toFixed(1)} s to ${splitPath(target).name}`);
    } catch (error) {
      pushAlert("Recording not saved", `${target}: ${errorText(error)}`);
    }
  }, [audio, flash, pushAlert, recording]);

  useEffect(() => {
    if (isActive) return;
    cancelSequence();
    audioRef.current?.stopDriveBy();
    audioRef.current?.stopAll();
    setPlaying(null);
    setDriving(false);
    setHolding({ horn: false, manual: false });
  }, [cancelSequence, isActive]);

  useEffect(() => () => {
    cancelAnimationFrame(frameRef.current);
    const running = sequenceRef.current;
    if (running) for (const timer of running.timers) clearTimeout(timer);
    audioRef.current?.dispose();
    audioRef.current = null;
  }, []);

  const packKeys = useMemo(() => pack.tones.map(packToneKey).join(","), [pack.tones]);
  useEffect(() => {
    const engine = audioRef.current;
    if (!engine) return undefined;
    const current = playingRef.current;
    const live = new Set(packKeys.split(","));
    for (const key of [...engine.buffers.keys()]) {
      if (key.startsWith("pack|") && !live.has(key) && key !== current?.key) engine.forget(key);
    }
    if (current?.kind !== "pack") return undefined;
    const tone = settingsRef.current.pack.tones.find((item) => item.name === current.name);
    if (!tone) {
      stopTone();
      return undefined;
    }
    if (packToneKey(tone) === current.key) return undefined;
    const timer = setTimeout(async () => {
      try {
        const key = await preparePack(tone);
        if (playingRef.current?.name !== tone.name) return;
        await engine.setTone(key);
        setPlaying({ kind: "pack", name: tone.name, key });
        engine.forget(current.key);
      } catch (error) {
        pushAlert(`${tone.label} didn't load`, errorText(error));
      }
    }, 160);
    return () => clearTimeout(timer);
  }, [packKeys, preparePack, pushAlert, stopTone]);

  useEffect(() => {
    if (!isActive) return undefined;
    const down = (event) => {
      if (isTyping(event.target) || event.ctrlKey || event.altKey || event.metaKey) return;
      const code = event.code;
      if (code === "KeyH") {
        event.preventDefault();
        if (!event.repeat) hornDown();
        return;
      }
      if (code === "KeyM") {
        event.preventDefault();
        if (!event.repeat) manualDown();
        return;
      }
      if (event.repeat) return;
      const digit = /^Digit([1-9])$/.exec(code);
      if (digit) {
        cancelSequence();
        playPackTone(Number(digit[1]) - 1);
      } else if (code === "Space") toggleSiren();
      else if (code === "KeyD") driveBy();
      else if (code === "KeyC") intersection();
      else if (code === "KeyB") toggleRumbler();
      else if (code === "KeyV") cycleScene();
      else if (code === "KeyR") toggleRecording();
      else return;
      event.preventDefault();
    };
    const up = (event) => {
      if (event.code === "KeyH") hornUp();
      else if (event.code === "KeyM") manualUp();
    };
    const blur = () => {
      hornUp();
      manualUp();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [cancelSequence, cycleScene, driveBy, hornDown, hornUp, intersection, isActive, manualDown, manualUp, playPackTone, toggleRecording, toggleRumbler, toggleSiren]);

  const hotkeys = useWorkspaceHotkeys({
    isActive,
    handlers: {
      [HOTKEY_ACTIONS.TOGGLE_PANEL]: () => setPanelCollapsed((value) => !value),
    },
  });

  const updatePack = useCallback((patch) => {
    setSettings((prev) => ({ ...prev, pack: { ...prev.pack, ...patch } }));
    setInstall((prev) => (prev.status === "working" ? prev : { status: "idle", result: null, error: "", step: "" }));
  }, []);

  const updateTone = useCallback((name, patch) => {
    setSettings((prev) => ({
      ...prev,
      pack: { ...prev.pack, tones: prev.pack.tones.map((tone) => (tone.name === name ? { ...tone, ...patch } : tone)) },
    }));
  }, []);

  const renameTone = useCallback((name, value) => {
    const prev = settingsRef.current.pack.tones;
    const taken = prev.filter((tone) => tone.name !== name).map((tone) => tone.name);
    const next = uniqueName(value, taken);
    if (next === name) return;
    updateTone(name, { name: next });
    if (focusTone === name) setFocusTone(next);
    if (playingRef.current?.name === name) setPlaying((current) => (current ? { ...current, name: next } : current));
  }, [focusTone, updateTone]);

  const addTone = useCallback((ref, hint, role) => {
    const prev = settingsRef.current;
    if (prev.pack.tones.length >= MAX_PACK_TONES) {
      pushAlert("The pack is full", `A siren pack holds up to ${MAX_PACK_TONES} tones.`);
      return;
    }
    const name = uniqueName(hint, prev.pack.tones.map((tone) => tone.name));
    const tone = { name, label: toneLabelFrom(hint, role || roleFromName(hint)), role: role || roleFromName(hint), ref, start: 0, end: 0, gain: 0, loop: true };
    updatePack({ tones: [...prev.pack.tones, tone] });
    setFocusTone(name);
    setInspectorTab("tone");
    ensureSamples(ref).catch(() => {});
  }, [ensureSamples, pushAlert, updatePack]);

  const moveTone = useCallback((name, delta) => {
    const tones = [...settingsRef.current.pack.tones];
    const index = tones.findIndex((tone) => tone.name === name);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= tones.length) return;
    [tones[index], tones[target]] = [tones[target], tones[index]];
    updatePack({ tones });
  }, [updatePack]);

  const removeTone = useCallback((name) => {
    updatePack({ tones: settingsRef.current.pack.tones.filter((tone) => tone.name !== name) });
    if (focusTone === name) setFocusTone("");
  }, [focusTone, updatePack]);

  const removeFile = useCallback((path) => {
    setSettings((prev) => ({
      ...prev,
      files: prev.files.filter((item) => item !== path),
      selected: prev.selected?.kind === "file" && prev.selected.path === path ? null : prev.selected,
      pack: { ...prev.pack, tones: prev.pack.tones.filter((tone) => !(tone.ref.kind === "file" && tone.ref.path === path)) },
    }));
    const key = toneRefKey({ kind: "file", path });
    samplesRef.current.delete(key);
    audioRef.current?.forget(`raw|${key}`);
  }, []);

  const repickFile = useCallback(async (path) => {
    const picked = await open({
      multiple: false,
      directory: false,
      title: `Find ${splitPath(path).name}`,
      defaultPath: path,
      filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
    }).catch(() => null);
    if (typeof picked !== "string") return;
    const before = { kind: "file", path };
    const after = { kind: "file", path: picked };
    for (const key of [toneRefKey(before), toneRefKey(after)]) {
      samplesRef.current.delete(key);
      audioRef.current?.forget(`raw|${key}`);
    }
    setDecoded((prev) => {
      const next = { ...prev };
      delete next[toneRefKey(before)];
      delete next[toneRefKey(after)];
      return next;
    });
    const swap = (ref) => (ref?.kind === "file" && ref.path === path ? after : ref);
    setSettings((prev) => ({
      ...prev,
      files: [...new Set(prev.files.map((item) => (item === path ? picked : item)))],
      selected: swap(prev.selected),
      pack: { ...prev.pack, tones: prev.pack.tones.map((tone) => ({ ...tone, ref: swap(tone.ref) })) },
    }));
    ensureSamples(after).catch(() => {});
  }, [ensureSamples]);

  const pickAudio = useCallback(async () => {
    const picked = await open({
      multiple: true,
      directory: false,
      title: "Add your own siren audio",
      filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
    }).catch(() => null);
    const paths = (Array.isArray(picked) ? picked : [picked]).filter(Boolean);
    for (const path of paths) {
      const key = toneRefKey({ kind: "file", path });
      samplesRef.current.delete(key);
      setDecoded((prev) => {
        if (!prev[key]) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
    addFiles(paths);
  }, [addFiles]);

  const pickGtaFolder = useCallback(async () => {
    const path = await open({ multiple: false, directory: true, title: "Choose your GTA V folder (the one with the game's .exe)", defaultPath: settingsRef.current.gtaFolder || undefined }).catch(() => null);
    if (typeof path !== "string") return;
    pickedThisSession.add(path);
    setSettings((prev) => ({ ...prev, gtaFolder: path }));
    previewsRef.current.clear();
    const targets = library.filter((entry) => (entry.sirens || []).some((source) => source.kind === "resident"));
    if (!targets.length) return;
    setRescanning(true);
    let found = 0;
    for (const entry of targets) {
      try {
        const updated = await invoke("engine_sounds_siren_rescan", { id: entry.id, gtaFolder: path });
        setLibrary((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
        found += (updated.sirens || []).reduce((sum, source) => sum + (source.tones || []).length, 0);
      } catch (error) {
        pushAlert(`${downloadLabel(entry.name)} didn't read`, errorText(error));
      }
    }
    setRescanning(false);
    flash(found ? `Found ${found} changed ${found === 1 ? "tone" : "tones"} in your RESIDENT.rpf packs` : "No changed tones found");
  }, [flash, library, pushAlert, setLibrary]);

  const removeEntry = useCallback((id) => {
    setConfirmRemove("");
    removeLibraryEntry(id);
  }, [removeLibraryEntry]);

  const chooseFolder = useCallback(async (field, title) => {
    const current = settingsRef.current.install[field];
    const path = await open({ multiple: false, directory: true, title, defaultPath: current || undefined }).catch(() => null);
    if (typeof path !== "string") return "";
    pickedThisSession.add(path);
    setSettings((prev) => ({ ...prev, install: { ...prev.install, [field]: path } }));
    setInstall({ status: "idle", result: null, error: "", step: "" });
    return path;
  }, []);

  const updateInstall = useCallback((patch) => {
    setSettings((prev) => ({ ...prev, install: { ...prev.install, ...patch } }));
    setInstall({ status: "idle", result: null, error: "", step: "" });
  }, []);

  const togglePick = useCallback((key) => {
    setSettings((prev) => {
      const picks = prev.install.picks.includes(key) ? prev.install.picks.filter((pick) => pick !== key) : [...prev.install.picks, key];
      return { ...prev, install: { ...prev.install, picks } };
    });
    setInstall({ status: "idle", result: null, error: "", step: "" });
  }, []);

  const dlc = packDlcName(pack.name);
  const packSources = useMemo(() => {
    const seen = new Map();
    for (const tone of pack.tones) {
      if (tone.ref.kind !== "lib") continue;
      const key = sourceKeyOf(tone.ref.id, tone.ref.source);
      if (!seen.has(key)) seen.set(key, { id: tone.ref.id, source: tone.ref.source });
    }
    return [...seen.values()];
  }, [pack.tones]);
  const sourcesKey = packSources.map((item) => sourceKeyOf(item.id, item.source)).join(",");
  useEffect(() => {
    setAuthorOk(false);
  }, [sourcesKey]);

  const bankBytes = useMemo(() => pack.tones.reduce((sum, tone) => {
    const info = decoded[toneRefKey(tone.ref)];
    return info?.status === "ready" ? sum + renderedToneBytes(tone, info.seconds) : sum;
  }, 0), [decoded, pack.tones]);
  const lvc = useMemo(() => lvcSnippet({ dlc, tones: pack.tones, vehicles: pack.vehicles, firstTone: pack.firstTone }), [dlc, pack.tones, pack.vehicles, pack.firstTone]);
  const fleet = useMemo(() => fleetReference({ dlc, tones: pack.tones }), [dlc, pack.tones]);
  const vehicles = parseVehicles(pack.vehicles);

  const spItems = useMemo(() => {
    const items = [];
    for (const entry of sirenEntries) {
      for (const source of entry.sirens) {
        if (!SP_KINDS.has(source.kind)) continue;
        const key = sourceKeyOf(entry.id, source.id);
        if (settings.install.picks.includes(key)) items.push({ id: entry.id, source: source.id });
      }
    }
    return items;
  }, [settings.install.picks, sirenEntries]);

  const { target, resourcesDir, spDir, testCommand } = settings.install;

  const runInstall = useCallback(async () => {
    const field = target === "fivem" ? "resourcesDir" : "spDir";
    let folder = settingsRef.current.install[field];
    if (!pickedThisSession.has(folder)) {
      folder = await chooseFolder(field, target === "fivem" ? "Confirm your server's resources folder" : "Choose where the single-player packs go");
      if (!folder) return;
    }
    cancelSequence();
    if (target === "sp") {
      setInstall({ status: "working", result: null, error: "", step: "Packing" });
      try {
        const result = await invoke("engine_sounds_build_sirens_sp", { outDir: folder, items: spItems });
        setInstall({ status: "done", result, error: "", step: "" });
      } catch (error) {
        setInstall({ status: "error", result: null, error: errorText(error), step: "" });
      }
      return;
    }
    const current = settingsRef.current.pack;
    const build = `b${Date.now().toString(36)}`;
    try {
      for (const [index, tone] of current.tones.entries()) {
        setInstall({ status: "working", result: null, error: "", step: `Preparing ${tone.label} (${index + 1} of ${current.tones.length})` });
        let rendered;
        try {
          const entry = await ensureSamples(tone.ref);
          rendered = renderTone(entry.samples, entry.sampleRate, tone);
        } catch (error) {
          throw new Error(`${tone.label}: ${errorText(error)}`);
        }
        await invoke("engine_sounds_stage_tone", encodeToneWav(rendered), { headers: { "x-build": build, "x-tone": tone.name } });
      }
      setInstall({ status: "working", result: null, error: "", step: "Building the sound bank" });
      const result = await invoke("engine_sounds_install_sirens", {
        resourcesDir: folder,
        pack: {
          build,
          name: current.name,
          tones: current.tones.map((tone) => ({ name: tone.name, label: tone.label })),
          sources: packSources,
          lvc,
          fleet,
          testCommand: settingsRef.current.install.testCommand,
          authorOk,
        },
      });
      setInstall({ status: "done", result, error: "", step: "" });
    } catch (error) {
      setInstall({ status: "error", result: null, error: errorText(error), step: "" });
    }
  }, [authorOk, cancelSequence, chooseFolder, ensureSamples, fleet, lvc, packSources, spItems, target]);

  const focused = pack.tones.find((tone) => tone.name === focusTone) || null;
  const inspectRef = focused?.ref || settings.selected;
  const inspectKey = inspectRef ? toneRefKey(inspectRef) : "";
  const inspectInfo = inspectKey ? decoded[inspectKey] : null;
  const inspectLib = inspectRef?.kind === "lib" ? findLibraryTone(library, inspectRef) : null;
  const inspectSamples = inspectInfo?.status === "ready" ? samplesRef.current.get(inspectKey) : null;

  useEffect(() => {
    if (!inspectRef || !libraryReady) return;
    if (inspectRef.kind === "lib" && !findLibraryTone(library, inspectRef)) return;
    if (!decoded[inspectKey]) ensureSamples(inspectRef).catch(() => {});
  }, [inspectKey, libraryReady, library]);

  useEffect(() => {
    setSweep(null);
    if (!inspectSamples) return undefined;
    const timer = setTimeout(() => setSweep(pitchSweep(inspectSamples.samples, inspectSamples.sampleRate)), 30);
    return () => clearTimeout(timer);
  }, [inspectSamples]);

  const playingTone = playing?.kind === "pack" ? pack.tones.find((tone) => tone.name === playing.name) : null;
  const playingLib = playing?.kind === "raw" && playing.ref?.kind === "lib" ? findLibraryTone(library, playing.ref) : null;
  const pickedLib = !pack.tones.length && settings.selected?.kind === "lib" ? findLibraryTone(library, settings.selected) : null;
  const pickedFile = !pack.tones.length && settings.selected?.kind === "file" ? settings.selected.path : "";
  const scopeLabel = playingTone?.label
    || (playing?.kind === "raw" ? (playing.ref.kind === "file" ? fileName(playing.ref.path) : playingLib?.tone.name) : "")
    || (pack.tones.length ? pack.name : pickedLib?.tone.name || (pickedFile ? fileName(pickedFile) : ""));
  const scopeSub = playingTone
    ? `${playingTone.name} · ${dlc}_soundset`
    : playing?.kind === "raw"
      ? playing.ref.kind === "file" ? "Your audio, as recorded" : `${playingLib ? downloadLabel(playingLib.entry.name) : ""}, as it came`
      : pack.tones.length
        ? `${pack.tones.length} ${pack.tones.length === 1 ? "tone" : "tones"} · ${dlc}_soundset`
        : pickedLib ? downloadLabel(pickedLib.entry.name) : pickedFile ? "Your audio" : "";
  const toneCount = Math.min(9, pack.tones.length);
  const idle = !playing && !holding.horn && !holding.manual && !driving && !sequence;
  const coach = !idle
    ? null
    : pack.tones.length
      ? coached.pack
        ? null
        : <>Press {toneCount > 1 ? <><Key>1</Key> to <Key>{toneCount}</Key></> : <Key>1</Key>} to run a tone.<br /><Key>Space</Key> turns the siren off and on. Hold <Key>H</Key> for the horn.</>
      : !settings.selected
        ? <>Click a tone in the list to hear it.<br />The + beside it adds it to your pack.</>
        : !coached.raw
          ? <>Press <Key>Space</Key> to hear it.<br />The + beside a tone in the list adds it to your pack.</>
          : null;
  const scopeState = holding.horn ? "Horn" : holding.manual ? "Manual" : sequence ? "Clearing" : driving ? "Drive-by" : playing ? "" : "Off";
  const scopeRole = playingTone ? roleLabel(playingTone.role) : playing ? "Audition" : "";

  const hasTones = libraryTones.length > 0 || settings.files.length > 0;
  const frameState = { isActive, isBooting: false, contextBarTarget, panelCollapsed, setPanelCollapsed, hotkeys };
  const installBlocked = !desktop
    ? "Installing needs the desktop app."
    : target === "fivem"
      ? !pack.tones.length
        ? "Add at least one tone to the pack."
        : !resourcesDir
          ? "Choose your server's resources folder."
          : packSources.length && !authorOk
            ? "Turn on the switch once you've checked the credits."
            : ""
      : !spItems.length
        ? "Tick at least one siren download."
        : !spDir
          ? "Choose a folder for the packs."
          : "";
  const folderMissing = desktop && install.status !== "working"
    ? target === "fivem" && pack.tones.length && !resourcesDir ? "resourcesDir" : target === "sp" && spItems.length && !spDir ? "spDir" : ""
    : "";
  const openCredits = () => {
    setInspectorTab("credits");
    setInspectorOpen(true);
  };
  const ensureLine = install.status === "done" && target === "fivem" && install.result ? `ensure ${install.result.name}` : "";
  const testLine = install.status === "done" && target === "fivem" && install.result?.command ? `/${install.result.command} ${install.result.tones?.[0] || pack.tones[0]?.name || ""}`.trim() : "";
  const creditEntries = useMemo(() => {
    const ids = new Set(pack.tones.filter((tone) => tone.ref.kind === "lib").map((tone) => tone.ref.id));
    if (inspectRef?.kind === "lib") ids.add(inspectRef.id);
    return library.filter((entry) => ids.has(entry.id));
  }, [inspectRef, library, pack.tones]);

  const toneRow = (ref, name, meta, role, extra = null) => {
    const key = toneRefKey(ref);
    const state = decoded[key];
    const selected = !focused && toneRefKey(settings.selected) === key;
    const live = playing?.kind === "raw" && playing.key === `raw|${key}`;
    const inPack = pack.tones.some((tone) => toneRefKey(tone.ref) === key);
    const repick = ref.kind === "file" && state?.status === "error";
    return (
      <li key={key} className="sn-tone-row">
        <button
          type="button"
          className={`es-engine sn-tone ${selected ? "is-selected" : ""}`}
          onClick={() => (repick ? repickFile(ref.path) : audition(ref))}
          title={repick ? `${state.error} Click to pick ${splitPath(ref.path).name} again.` : live ? `Stop ${name}` : `Hear ${name}`}
        >
          <span className="es-engine-name">{name}</span>
          <span className={`es-engine-meta ${state?.status === "error" ? "is-error" : ""}`}>
            {state?.status === "loading" ? "Decoding…" : repick ? "Pick it again to use it" : state?.status === "error" ? state.error : meta}
          </span>
          <span className="sn-tone-play" aria-hidden="true">
            {state?.status === "loading" ? <Loader2 className="es-spin" /> : live ? <Square /> : <Play />}
          </span>
        </button>
        <button
          type="button"
          className={`cx-icon-btn sn-tone-add ${inPack ? "is-in" : ""}`}
          onClick={() => addTone(ref, name, role)}
          disabled={pack.tones.length >= MAX_PACK_TONES}
          title={inPack ? "Already in the pack. Add it again to make a second version." : "Add to the siren pack"}
          aria-label={`Add ${name} to the siren pack`}
        >
          {inPack ? <Check aria-hidden="true" /> : <Plus aria-hidden="true" />}
        </button>
        {extra}
      </li>
    );
  };

  return (
    <WorkspaceFrame s={frameState} inspectorOpen={inspectorOpen} setInspectorOpen={setInspectorOpen} style={panes.style} className="es-root sn-root" viewSwitch={viewSwitch}>
      <aside className="lv-dock" aria-label="Sirens" inert={panelCollapsed}>
        <div className="lv-dock-scroll custom-scrollbar">
          <section className={`lv-slot ${hasTones ? "is-filled" : "is-empty"}`}>
            <header className="lv-slot-head">
              <span className={`lv-step ${hasTones ? "is-done" : ""}`} aria-hidden="true">{hasTones ? <Check /> : 1}</span>
              <h3 className="lv-slot-title">Tones</h3>
              {desktop ? (
                <button type="button" className="cx-icon-btn" onClick={pickFolder} title="Import an unpacked folder" aria-label="Import an unpacked folder" disabled={Boolean(importing)}>
                  <FolderOpen aria-hidden="true" />
                </button>
              ) : null}
            </header>
            <div className="lv-slot-body">
              {!desktop ? (
                <p className="lv-slot-note">Reading siren packs needs the desktop app.</p>
              ) : !sirenEntries.length && !settings.files.length ? (
                <div className="sn-add">
                  <DropButton title="Import a siren download" hint="Drop a download, or click to choose it." onClick={pickDownload} />
                  <button type="button" className="cx-btn lv-btn-sm sn-own" onClick={pickAudio}>
                    <FileAudio aria-hidden="true" />
                    Add your own audio
                  </button>
                </div>
              ) : null}
              {importing ? (
                <p className="lv-slot-note is-idle" role="status">
                  <Loader2 className="es-spin" aria-hidden="true" />
                  <span title={importing.path}>Reading {splitPath(importing.path).name}{importing.total > 1 ? ` (${importing.index} of ${importing.total})` : ""}…</span>
                </p>
              ) : null}
              {importErrors.map((message) => <Note key={message} tone="error">{message}</Note>)}

              {needsGame.length || settings.gtaFolder ? (
                <div className="sn-game">
                  <FolderField
                    label="GTA V folder"
                    path={settings.gtaFolder}
                    emptyTitle="Choose your GTA V folder"
                    emptyHint="Studio compares the pack with your game to find the tones it changed."
                    onPick={pickGtaFolder}
                  />
                  {rescanning ? <Note>Comparing with your game's own sirens…</Note> : null}
                </div>
              ) : null}

              {settings.files.length ? (
                <div className="es-entry">
                  <div className="es-entry-head">
                    <span className="es-entry-name">Your audio</span>
                  </div>
                  <ul className="es-engines sn-tones">
                    {settings.files.map((path) => {
                      const ref = { kind: "file", path };
                      const info = decoded[toneRefKey(ref)];
                      return toneRow(ref, fileName(path), seconds(info?.seconds) || splitPath(path).name, roleFromName(path), (
                        <button type="button" className="cx-icon-btn sn-file-remove" onClick={() => removeFile(path)} title="Remove from the list. The file stays where it is." aria-label={`Remove ${fileName(path)}`}>
                          <X aria-hidden="true" />
                        </button>
                      ));
                    })}
                  </ul>
                </div>
              ) : null}

              {sirenEntries.length ? (
                <ul className="es-library custom-scrollbar" aria-label="Imported siren packs">
                  {sirenEntries.map((entry) => (
                    <li key={entry.id} className="es-entry">
                      <div className="es-entry-head">
                        <span className="es-entry-name" title={entry.origin}>{downloadLabel(entry.name)}</span>
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
                      {entry.sirens.map((source) => (
                        <div key={source.id} className="es-source">
                          {entry.sirens.length > 1 ? (
                            <div className="es-source-head">
                              <span className="es-source-kind is-text" title={`${KIND_LABELS[source.kind] || source.kind}\n${source.path || ""}`}>{source.label || fileName(source.path || "") || "Sirens"}</span>
                            </div>
                          ) : null}
                          {source.needsGame ? null : (source.warnings || []).map((warning) => <Note key={warning} tone={/silent or shorter|roles come from file names/.test(warning) ? "idle" : "warn"}>{warning}</Note>)}
                          {source.needsGame ? (
                            <p className="lv-slot-note">{!settings.gtaFolder ? "Needs your GTA V folder." : rescanning ? "Reading…" : "Not found in your GTA V folder."}</p>
                          ) : (
                            <ul className="es-engines sn-tones">
                              {(source.tones || []).map((tone) => toneRow(
                                { kind: "lib", id: entry.id, source: source.id, tone: tone.id },
                                tone.name,
                                [roleLabel(tone.role), seconds(tone.seconds), tone.stock && tone.stock !== tone.name ? `replaces ${tone.stock}` : ""].filter(Boolean).join(" · "),
                                tone.role,
                              ))}
                            </ul>
                          )}
                        </div>
                      ))}
                    </li>
                  ))}
                </ul>
              ) : null}
              {desktop && (sirenEntries.length || settings.files.length) ? (
                <div className="sn-add-more">
                  <button type="button" className="cx-btn lv-btn-sm" onClick={pickDownload} disabled={Boolean(importing)}>
                    <Plus aria-hidden="true" />
                    {sirenEntries.length ? "Import another download" : "Import a siren download"}
                  </button>
                  <button type="button" className="cx-btn lv-btn-sm" onClick={pickAudio}>
                    <FileAudio aria-hidden="true" />
                    Add your own audio
                  </button>
                </div>
              ) : null}
            </div>
          </section>

          <section className={`lv-slot ${pack.tones.length ? "is-filled" : "is-empty"} ${!hasTones ? "is-disabled" : ""}`}>
            <header className="lv-slot-head">
              <span className={`lv-step ${pack.tones.length ? "is-done" : ""}`} aria-hidden="true">{pack.tones.length ? <Check /> : 2}</span>
              <h3 className="lv-slot-title">Siren pack</h3>
              {pack.tones.length ? <span className="es-count">{pack.tones.length}/{MAX_PACK_TONES}</span> : null}
            </header>
            <div className="lv-slot-body">
              {!pack.tones.length ? (
                <p className="lv-slot-note">Press + on a tone to add it. Up to {MAX_PACK_TONES}.</p>
              ) : (
                <ol className="sn-pack" aria-label="Tones in the pack">
                  {pack.tones.map((tone, index) => {
                    const live = playing?.kind === "pack" && playing.name === tone.name;
                    const info = decoded[toneRefKey(tone.ref)];
                    return (
                      <li key={tone.name} className={`sn-pack-row ${focusTone === tone.name ? "is-focus" : ""} ${live ? "is-live" : ""}`}>
                        <button type="button" className="sn-pack-num" onClick={() => playPackTone(index)} title={live ? `${tone.label} is running` : `Run ${tone.label}${index < 9 ? ` (${index + 1})` : ""}`} aria-label={`Run ${tone.label}`}>
                          {index + 1}
                        </button>
                        <button type="button" className="sn-pack-main" onClick={() => { setFocusTone(tone.name); setInspectorTab("tone"); }}>
                          <span className="sn-pack-label">{tone.label}</span>
                          <span className="sn-pack-meta">
                            {tone.name}
                            {info?.status === "error" ? " · didn't load" : ""}
                          </span>
                        </button>
                        <span className="sn-pack-acts">
                          <button type="button" className="cx-icon-btn" onClick={() => moveTone(tone.name, -1)} disabled={index === 0} title="Move up" aria-label={`Move ${tone.label} up`}><ArrowUp aria-hidden="true" /></button>
                          <button type="button" className="cx-icon-btn" onClick={() => moveTone(tone.name, 1)} disabled={index === pack.tones.length - 1} title="Move down" aria-label={`Move ${tone.label} down`}><ArrowDown aria-hidden="true" /></button>
                          <button type="button" className="cx-icon-btn" onClick={() => removeTone(tone.name)} title="Take it out of the pack" aria-label={`Remove ${tone.label} from the pack`}><X aria-hidden="true" /></button>
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
          </section>

          <section className={`lv-slot ${install.status === "done" ? "is-filled" : "is-empty"} ${!hasTones ? "is-disabled" : ""}`}>
            <header className="lv-slot-head">
              <span className={`lv-step ${install.status === "done" ? "is-done" : ""}`} aria-hidden="true">{install.status === "done" ? <Check /> : 3}</span>
              <h3 className="lv-slot-title">Install</h3>
            </header>
            <div className="lv-slot-body">
              {!hasTones ? (
                <p className="lv-slot-note">Add tones to build a server pack, or import a download to pack it for single player.</p>
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
              {target === "fivem" && !pack.tones.length ? null : target === "fivem" ? (
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
                  <label className="lv-field">
                    <span className="cx-label">Resource name</span>
                    <input
                      className="sn-text"
                      type="text"
                      value={pack.name}
                      spellCheck={false}
                      autoComplete="off"
                      maxLength={32}
                      onChange={(event) => updatePack({ name: event.currentTarget.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })}
                      onBlur={(event) => updatePack({ name: sanitizeName(event.currentTarget.value, "cortex_sirens") })}
                    />
                  </label>
                  <div className="lv-toggle-row">
                    <span>Add a /{dlc} test command</span>
                    <Toggle checked={testCommand} onChange={(value) => updateInstall({ testCommand: value })} ariaLabel={`Add a /${dlc} test command`} />
                  </div>
                  {pack.tones.some((tone) => tone.ref.kind === "file") ? (
                    <p className="lv-slot-note">Use audio you recorded or have the rights to.</p>
                  ) : null}
                  {bankBytes > BANK_WARN_BYTES ? (
                    <Note tone="warn">
                      This sound bank is about {Math.round(bankBytes / 1048576)} MB, and every player downloads it when they join. Trim long tones to the part that loops.
                    </Note>
                  ) : null}
                </>
              ) : (
                <>
                  {sirenEntries.some((entry) => entry.sirens.some((source) => SP_KINDS.has(source.kind))) ? (
                    <ul className="sn-sp" aria-label="Siren downloads to pack">
                      {sirenEntries.flatMap((entry) => entry.sirens.filter((source) => SP_KINDS.has(source.kind)).map((source) => {
                        const key = sourceKeyOf(entry.id, source.id);
                        const picked = settings.install.picks.includes(key);
                        return (
                          <li key={key} className="es-source-head">
                            <span className="es-source-kind is-text" title={entry.origin}>{downloadLabel(entry.name)} · {KIND_LABELS[source.kind]}</span>
                            <button type="button" className={`es-pick ${picked ? "is-on" : ""}`} role="checkbox" aria-checked={picked} onClick={() => togglePick(key)}>
                              {picked ? <Check aria-hidden="true" /> : null}
                              <span>Pack</span>
                            </button>
                          </li>
                        );
                      }))}
                    </ul>
                  ) : (
                    <p className="lv-slot-note">Import a RESIDENT.rpf or Siren Mastery download to pack it for single player.</p>
                  )}
                  {folderMissing === "spDir" ? null : (
                    <FolderField
                      label="Output folder"
                      path={spDir}
                      emptyTitle="Choose an output folder"
                      emptyHint="Studio writes a folder and an .oiv per download"
                      onPick={() => chooseFolder("spDir", "Choose where the single-player packs go")}
                    />
                  )}
                  <p className="lv-slot-note">For GTA V Legacy. Studio packs the author's download as it came, with an .oiv for OpenIV. Your own tones and edits go to FiveM server packs.</p>
                </>
              )}
              </>
              )}
            </div>
          </section>
        </div>
        {hasTones ? (
          <div className="lv-dock-foot">
            {target === "fivem" && pack.tones.length && packSources.length ? (
              <div className="es-consent">
                <Note tone="warn">
                  {packSources.length === 1 ? "A tone comes" : "Some tones come"} from another author's pack. FiveM streams {packSources.length === 1 ? "it" : "them"} to every player. <button type="button" className="lv-link" onClick={openCredits}>Read the credits</button>
                </Note>
                <div className="lv-toggle-row">
                  <span>The author allows FiveM use</span>
                  <Toggle checked={authorOk} onChange={setAuthorOk} ariaLabel="The author allows FiveM use" />
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
            {install.status === "working" && install.step ? <p className="lv-foot-note">{install.step}…</p> : null}
            {folderMissing ? <p className="lv-foot-note">{target === "fivem" ? "Your server's resources, or a [category] inside it." : "Studio writes a folder and an .oiv per download."}</p> : null}
            {installBlocked && !folderMissing && install.status !== "working" ? <p className="lv-foot-note">{installBlocked}</p> : null}
            {install.status === "error" ? <p className="lv-foot-note is-error"><ErrorText error={install.error} /></p> : null}
            {install.status === "done" && target === "fivem" && install.result ? (
              <div className="es-result" role="status">
                <div className="es-result-row">
                  <Check className="es-ok" aria-hidden="true" />
                  <span className="es-result-path" title={install.result.path}>{install.result.name}</span>
                  <button type="button" className="cx-icon-btn" onClick={() => openFolderPath(install.result.path)} title="Open the folder" aria-label={`Open ${install.result.name}`}>
                    <FolderOpen aria-hidden="true" />
                  </button>
                </div>
                <div className="es-ensure">
                  <span className="cx-label">Add to server.cfg</span>
                  <code>{ensureLine}</code>
                  <CopyButton text={ensureLine} label="Copy the ensure line" />
                </div>
                {testLine ? (
                  <div className="es-ensure">
                    <span className="cx-label">Test it in game</span>
                    <code>{testLine}</code>
                    <CopyButton text={testLine} label="Copy the test command" />
                  </div>
                ) : null}
                <p className="lv-foot-note">
                  Next, paste the LVC lines into lvc/SIRENS.lua.{" "}
                  <button
                    type="button"
                    className="lv-link"
                    onClick={() => {
                      setPanelCollapsed(false);
                      setInspectorOpen(true);
                      setInspectorTab("pack");
                    }}
                  >
                    Show the LVC lines
                  </button>
                </p>
                {(install.result.warnings || []).map((warning) => <p key={warning} className="lv-foot-note">{warning}</p>)}
              </div>
            ) : null}
            {install.status === "done" && target === "sp" ? (
              <div className="es-result" role="status">
                {(install.result?.packs || []).map((item) => (
                  <div key={item.folder} className="es-result-row">
                    <Check className="es-ok" aria-hidden="true" />
                    <span className="es-result-path" title={item.folder}>{item.oiv ? `${item.pack}.oiv` : item.pack}</span>
                    <button type="button" className="cx-icon-btn" onClick={() => openFolderPath(item.folder)} title="Open the folder" aria-label={`Open ${item.pack}`}>
                      <FolderOpen aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <PaneResizer side="dock" label="Resize the sirens panel" setWidth={panes.setWidth} />
      </aside>

      <section className={`lv-finder es-finder ${dragging ? "is-dragging" : ""}`} aria-label="Siren controller">
        <div className="lv-stage es-stage">
          {!desktop ? (
            <StageEmpty icon={Monitor} title="Desktop app required" line="Reading siren packs needs the Cortex Studio desktop app." />
          ) : !hasTones ? (
            <StageEmpty icon={Siren} title="No siren tones yet" line="Import a siren download, add your own audio, or drop either here.">
              <button type="button" className="cx-btn is-primary" onClick={pickDownload}><Plus aria-hidden="true" />Import a download</button>
            </StageEmpty>
          ) : (
            <div className="sn-bench">
              <SirenScope ref={scopeRef} label={scopeLabel} sub={scopeSub} state={scopeState} roleText={scopeRole} coach={coach} />
              {pack.tones.length ? (
                <div className="sn-pads" role="group" aria-label="Siren tones">
                  {pack.tones.map((tone, index) => {
                    const live = playing?.kind === "pack" && playing.name === tone.name;
                    return (
                      <button
                        key={tone.name}
                        type="button"
                        className={`sn-pad ${live ? "is-on" : ""}`}
                        aria-pressed={live}
                        onClick={() => {
                          cancelSequence();
                          if (live) stopTone();
                          else playPackTone(index);
                        }}
                        title={`${tone.label}${index < 9 ? ` (${index + 1})` : ""}`}
                      >
                        <span className="sn-pad-num">{index + 1}</span>
                        <span className="sn-pad-label">{tone.label}</span>
                        <span className="sn-pad-role">{roleLabel(tone.role)}</span>
                      </button>
                    );
                  })}
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
              <span>A siren download, or your own .wav, .mp3, .ogg or .flac.</span>
            </div>
          ) : null}

          {desktop && hasTones ? (
            <div ref={deckRef} className="lv-deck es-deck" role="toolbar" aria-label="Siren controls">
              <div className="lv-deck-group">
                <DeckButton active={Boolean(playing)} onClick={toggleSiren} disabled={!pack.tones.length && !settings.selected} title={playing ? "Siren off (Space)" : "Siren on (Space)"} className="is-icon">
                  <Power aria-hidden="true" />
                </DeckButton>
                <HoldButton active={holding.horn} onDown={hornDown} onUp={hornUp} title="Hold for the horn (H)">
                  <Megaphone aria-hidden="true" />
                </HoldButton>
                <HoldButton active={holding.manual} onDown={manualDown} onUp={manualUp} title="Hold for the manual wind-up (M)">
                  <Siren aria-hidden="true" />
                </HoldButton>
                <DeckButton active={settings.rumbler} onClick={toggleRumbler} title="Rumbler: the low-frequency siren you feel (B)">
                  Rumbler
                </DeckButton>
              </div>
              <div className="lv-deck-group">
                <DeckButton active={driving} onClick={driveBy} disabled={!pack.tones.length && !settings.selected} title={`The car passes you at ${Math.round(settings.driveSpeed)} km/h (D)`} className="is-icon">
                  <Car aria-hidden="true" />
                </DeckButton>
                <DeckButton active={sequence} onClick={intersection} disabled={!pack.tones.length} title={pack.tones.length ? "Clear an intersection: wail, yelp, priority and horn (C)" : "Add tones to the pack to clear an intersection with them"}>
                  Intersection
                </DeckButton>
              </div>
              <div className="lv-deck-group" role="radiogroup" aria-label="Where you stand">
                {SIREN_SCENES.map((scene) => (
                  <DeckButton key={scene} active={settings.scene === scene} onClick={() => setSettings((prev) => ({ ...prev, scene }))} title={`${SCENE_LABELS[scene]} (V)`}>
                    {SCENE_LABELS[scene]}
                  </DeckButton>
                ))}
              </div>
              <div className="lv-deck-group">
                <DeckButton active={Boolean(recording)} onClick={toggleRecording} title={recording ? "Stop and save the recording (R)" : "Record what you hear (R)"} className={`is-icon es-rec ${recording ? "is-live" : ""}`}>
                  <span className="es-rec-dot" aria-hidden="true" />
                </DeckButton>
                <DeckButton active={helpOpen} onClick={() => setHelpOpen((value) => !value)} title="Keyboard controls" className="is-icon">
                  <CircleHelp aria-hidden="true" />
                </DeckButton>
              </div>
              {helpOpen ? <SirenHelp /> : null}
            </div>
          ) : null}
        </div>
      </section>

      <aside className="lv-inspector" aria-label="Inspector" inert={panelCollapsed || !inspectorOpen}>
        <PaneResizer side="insp" label="Resize the inspector" setWidth={panes.setWidth} />
        <InspectorTabs
          tabs={[
            { id: "tone", label: "Tone" },
            { id: "pack", label: "LVC" },
            { id: "credits", label: "Credits" },
          ]}
          active={inspectorTab}
          onChange={setInspectorTab}
        />
        <div className="lv-inspector-scroll custom-scrollbar">
          {inspectorTab === "tone" ? (
            <>
              {focused ? (
                <section className="lv-group">
                  <h3 className="lv-group-title">In the pack</h3>
                  <label className="lv-field">
                    <span className="cx-label">Menu name</span>
                    <input className="sn-text" type="text" value={focused.label} maxLength={40} onChange={(event) => updateTone(focused.name, { label: event.currentTarget.value })} onBlur={(event) => updateTone(focused.name, { label: event.currentTarget.value.trim() || toneLabelFrom(focused.name, focused.role) })} />
                  </label>
                  <label className="lv-field">
                    <span className="cx-label">Sound name</span>
                    <input key={focused.name} className="sn-text is-mono" type="text" defaultValue={focused.name} maxLength={32} spellCheck={false} onBlur={(event) => renameTone(focused.name, event.currentTarget.value)} onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()} />
                  </label>
                  <div className="lv-field">
                    <span className="cx-label">Kind</span>
                    <Select value={focused.role} onValueChange={(role) => updateTone(focused.name, { role })}>
                      <SelectTrigger className="lv-select" aria-label="Kind of tone"><SelectValue /></SelectTrigger>
                      <SelectContent className="lv-select-content">
                        {SIREN_ROLES.map((role) => <SelectItem key={role.id} value={role.id}>{role.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  {inspectSamples ? (
                    <>
                      <SirenWave samples={inspectSamples.samples} seconds={inspectSamples.seconds} start={focused.start} end={focused.end} />
                      <Slider id="sn-start" label="Start" value={focused.start} min={0} max={Math.max(0.05, inspectSamples.seconds - 0.05)} step={0.01} format={(v) => `${v.toFixed(2)} s`} onChange={(start) => updateTone(focused.name, { start, end: focused.end && focused.end <= start + 0.05 ? 0 : focused.end })} />
                      <Slider id="sn-end" label="End" value={focused.end || inspectSamples.seconds} min={Math.min(inspectSamples.seconds, focused.start + 0.05)} max={inspectSamples.seconds} step={0.01} format={(v) => `${v.toFixed(2)} s`} onChange={(end) => updateTone(focused.name, { end: end >= inspectSamples.seconds - 0.005 ? 0 : end })} />
                    </>
                  ) : inspectInfo?.status === "error" ? (
                    <Note tone="error">{inspectInfo.error}</Note>
                  ) : (
                    <p className="lv-slot-note">Decoding…</p>
                  )}
                  <Slider id="sn-gain" label="Level" value={focused.gain} min={-12} max={12} step={0.5} format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`} onChange={(gain) => updateTone(focused.name, { gain })} />
                  <div className="lv-toggle-row">
                    <span>Loop smoothly</span>
                    <Toggle checked={focused.loop} onChange={(loop) => updateTone(focused.name, { loop })} ariaLabel="Loop smoothly" />
                  </div>
                  <p className="lv-slot-note">Loop blends the end into the start so it doesn't click.</p>
                </section>
              ) : null}

              {inspectRef ? (
                <section className="lv-group">
                  <h3 className="lv-group-title">Recording</h3>
                  <dl className="es-facts">
                    <div><dt>From</dt><dd title={inspectRef.kind === "file" ? inspectRef.path : inspectLib?.entry.origin}>{inspectRef.kind === "file" ? splitPath(inspectRef.path).name : inspectLib ? downloadLabel(inspectLib.entry.name) : "Missing"}</dd></div>
                    {inspectLib ? <div><dt>Tone</dt><dd>{inspectLib.tone.name}{inspectLib.tone.stock && inspectLib.tone.stock !== inspectLib.tone.name ? `, replaces ${inspectLib.tone.stock}` : ""}</dd></div> : null}
                    <div><dt>Length</dt><dd>{seconds(inspectInfo?.seconds || inspectLib?.tone.seconds) || "?"}</dd></div>
                    <div><dt>Rate</dt><dd>{inspectInfo?.sampleRate || inspectLib?.tone.sampleRate ? `${Math.round((inspectInfo?.sampleRate || inspectLib.tone.sampleRate) / 100) / 10} kHz` : "?"}</dd></div>
                    <div><dt>Pitch</dt><dd>{sweep ? (sweep.high - sweep.low > 60 ? `Sweeps ${Math.round(sweep.low)} to ${Math.round(sweep.high)} Hz` : `Holds near ${Math.round((sweep.low + sweep.high) / 2)} Hz`) : inspectSamples ? "No clear pitch" : "?"}</dd></div>
                  </dl>
                  {!focused ? (
                    <button type="button" className="cx-btn lv-btn-sm" onClick={() => addTone(inspectRef, inspectRef.kind === "file" ? fileName(inspectRef.path) : inspectLib?.tone.name || "tone", inspectLib?.tone.role)} disabled={pack.tones.length >= MAX_PACK_TONES || (inspectRef.kind === "lib" && !inspectLib)}>
                      <Plus aria-hidden="true" />
                      Add to the pack
                    </button>
                  ) : null}
                </section>
              ) : (
                <p className="es-empty">Pick a tone to see it here.</p>
              )}

              <section className="lv-group">
                <h3 className="lv-group-title">Listen</h3>
                <Slider id="sn-volume" label="Volume" value={settings.volume} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(volume) => setSettings((prev) => ({ ...prev, volume }))} />
                <Slider id="sn-speed" label="Drive-by speed" value={settings.driveSpeed} min={30} max={200} step={5} format={(v) => `${Math.round(v)} km/h`} onChange={(driveSpeed) => setSettings((prev) => ({ ...prev, driveSpeed }))} />
              </section>
            </>
          ) : null}

          {inspectorTab === "pack" ? (
            pack.tones.length ? (
              <>
                <section className="lv-group">
                  <div className="lv-group-head">
                    <h3 className="lv-group-title">Luxart Vehicle Control v3</h3>
                    <CopyButton text={lvc} label="Copy the LVC lines" />
                  </div>
                  <pre className="sn-code">{lvc}</pre>
                  <label className="lv-field">
                    <span className="cx-label">First tone number</span>
                    <input className="sn-text is-mono" type="number" min={1} max={999} step={1} value={pack.firstTone} onChange={(event) => updatePack({ firstTone: event.currentTarget.value })} onBlur={(event) => updatePack({ firstTone: firstToneNumber(event.currentTarget.value) })} />
                  </label>
                  <p className="lv-slot-note">Paste into lvc/SIRENS.lua. Stock LVC ends at 14; if yours has more, start after your last one.</p>
                </section>
                <section className="lv-group">
                  <h3 className="lv-group-title">Vehicles (optional)</h3>
                  <label className="lv-field">
                    <span className="cx-label">Game names</span>
                    <input className="sn-text is-mono" type="text" value={pack.vehicles} placeholder="POLICE, SHERIFF, V19tahoe" spellCheck={false} onChange={(event) => updatePack({ vehicles: event.currentTarget.value })} />
                  </label>
                  <p className="lv-slot-note">{vehicles.length ? `LVC gives ${vehicles.join(", ")} these tones.` : "Each car's gameName, exact capitals."}</p>
                </section>
                <section className="lv-group">
                  <div className="lv-group-head">
                    <h3 className="lv-group-title">LVC Fleet and other menus</h3>
                    <CopyButton text={fleet} label="Copy the sound references" />
                  </div>
                  <pre className="sn-code">{fleet}</pre>
                  <p className="lv-slot-note">Any siren menu that takes a sound name, a sound set and a bank can play these.</p>
                </section>
              </>
            ) : (
              <p className="es-empty">Add tones to the pack to get your LVC lines.</p>
            )
          ) : null}

          {inspectorTab === "credits" ? (
            creditEntries.length ? (
              creditEntries.map((entry) => (
                <section key={entry.id} className="lv-group">
                  <h3 className="lv-group-title">{downloadLabel(entry.name)}</h3>
                  {entry.readme ? <div className="es-readme">{entry.readme}</div> : <p className="lv-slot-note">This download has no readme. Credit the author from its gta5-mods page.</p>}
                </section>
              ))
            ) : (
              <p className="es-empty">{pack.tones.length ? "Every tone in the pack is your own audio." : "Pick a tone from a download to see its author's notes."}</p>
            )
          ) : null}
          {inspectorTab === "credits" && creditEntries.length ? (
            <p className="lv-slot-note sn-credit-note">Installs carry these notes as CREDITS.txt. Use each sound the way its author allows.</p>
          ) : null}
        </div>
      </aside>
    </WorkspaceFrame>
  );
}
