import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { save } from "@tauri-apps/plugin-dialog";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  Aperture,
  Camera,
  Car,
  Check,
  CircleHelp,
  Contrast,
  Crosshair,
  Eye,
  EyeOff,
  Frame,
  Grid3x3,
  Lamp,
  Loader2,
  Monitor,
  Move,
  Plus,
  RotateCw,
  Sun,
  User,
  X,
} from "lucide-react";
import { loadPrefs } from "../lib/prefs";
import { HOTKEY_ACTIONS } from "../lib/hotkeys";
import { useWorkspaceHotkeys } from "../lib/use-workspace-hotkeys";
import { openFolderPath } from "../lib/open-folder";
import { applyWatermarkToPngBytes } from "../lib/watermark.js";
import { trackUsage } from "../lib/usage";
import { normalizeShowroomSubject } from "../lib/studio-defaults.js";
import { buildPlateImage } from "../lib/license-plate-assets.js";
import { resolveModSelection } from "../lib/vehicle-modkits.js";
import {
  PHOTO_OBJECT_LIMIT,
  PHOTO_SHOT_LIMIT,
  STEERING_LIMIT,
  newObjectId,
  normalizePhotoObject,
  normalizePhotoState,
  objectLabel,
  outputSize,
  photoFileName,
  placeNewObject,
} from "../lib/photo-mode.js";
import { loadPhotoModel, loadPhotoPed } from "./photo/photo-objects.js";
import { exportRoofClip, readVehicleModFiles, readVehicleSetup } from "./photo/photo-vehicle-setup.js";
import PhotoViewport from "./photo/PhotoViewport";
import PhotoInspector from "./photo/PhotoInspector";
import AddToSetDialog from "./photo/AddToSetDialog";
import { DeckButton, DeckViewMenu, deckButtonItems, FootFact, StageEmpty, StageToggle, WorkspaceFrame, splitPath } from "./workspace/parts";
import { PaneResizer, usePaneWidths } from "./workspace/PaneResizer";
import "./PhotoModePage.css";

const PERSIST_DEBOUNCE_MS = 160;
const DEFAULT_BACKGROUND = "#141414";
const KIND_ICONS = { vehicle: Car, ped: User, prop: Lamp };
const SHOTS = [
  { key: "front", label: "Front" },
  { key: "back", label: "Rear" },
  { key: "side", label: "Side" },
  { key: "angle", label: "3/4" },
  { key: "low", label: "Low" },
  { key: "top", label: "Top" },
];

function isTauriRuntimeAvailable() {
  return (
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__ !== "undefined" &&
    typeof window.__TAURI_INTERNALS__?.invoke === "function"
  );
}

function errorMessage(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (typeof error.message === "string") return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function readViewerPrefs() {
  const defaults = loadPrefs()?.defaults;
  const source = defaults && typeof defaults === "object" ? defaults : {};
  return {
    background: typeof source.backgroundColor === "string" && source.backgroundColor ? source.backgroundColor : DEFAULT_BACKGROUND,
    light: Number.isFinite(source.lightIntensity) ? source.lightIntensity : 1,
    showroom: normalizeShowroomSubject(source.showroom?.vehicle, "vehicle"),
    output: source.photoOutput,
  };
}

function isEditableTarget(target) {
  return Boolean(target?.closest?.("input, textarea, select, [contenteditable='true'], [role='listbox']"));
}

/** What a reload depends on; pose, paint, doors and placement apply in place. */
function loadKeyOf(object) {
  if (object.kind === "ped") return `ped|${object.ped.gender}|${object.ped.body}|${object.ped.outfit}`;
  return `${object.kind}|${object.source}|${object.name}|${object.path}`;
}

function poseKeyOf(object) {
  const ped = object.ped;
  return ped.pose === "custom" ? `custom|${ped.dict}|${ped.clip}` : `${ped.pose}|${ped.gender}`;
}

function objectMeta(object) {
  if (object.source === "file") return splitPath(object.path).folder;
  if (object.kind === "ped") return object.ped.gender === "female" ? "Freemode female" : "Freemode male";
  return object.kind === "vehicle" ? "Game vehicle" : "Game prop";
}

function PhotoHelp() {
  return (
    <div className="lv-help" role="dialog" aria-label="Viewer controls">
      <dl>
        <div><dt><kbd className="cx-keycap">LMB</kbd></dt><dd>Orbit, or click to select</dd></div>
        <div><dt><kbd className="cx-keycap">RMB</kbd></dt><dd>Pan</dd></div>
        <div><dt>Scroll</dt><dd>Zoom</dd></div>
        <div><dt><kbd className="cx-keycap">G</kbd></dt><dd>Move the selection</dd></div>
        <div><dt><kbd className="cx-keycap">R</kbd></dt><dd>Turn the selection</dd></div>
        <div><dt><kbd className="cx-keycap">F</kbd></dt><dd>Frame the selection</dd></div>
        <div><dt><kbd className="cx-keycap">H</kbd></dt><dd>Hide or show it</dd></div>
        <div><dt><kbd className="cx-keycap">Del</kbd></dt><dd>Remove it</dd></div>
        <div><dt><kbd className="cx-keycap">Space</kbd></dt><dd>Play or pause a pose</dd></div>
        <div><dt><kbd className="cx-keycap">P</kbd></dt><dd>Take the photo</dd></div>
      </dl>
    </div>
  );
}

/**
 * The output frame drawn over the viewfinder: the largest rectangle of the
 * photo's aspect that fits, which is exactly what a capture renders.
 */
function FrameGuide({ width, height, viewport }) {
  if (!viewport?.width || !viewport?.height) return null;
  const aspect = width / height;
  const viewAspect = viewport.width / viewport.height;
  const frameWidth = aspect > viewAspect ? viewport.width : viewport.height * aspect;
  const frameHeight = aspect > viewAspect ? viewport.width / aspect : viewport.height;
  return (
    <div className="pm-frame" aria-hidden="true" style={{ width: frameWidth, height: frameHeight }}>
      <span className="pm-frame-third is-v1" />
      <span className="pm-frame-third is-v2" />
      <span className="pm-frame-third is-h1" />
      <span className="pm-frame-third is-h2" />
      <span className="lv-slip pm-frame-size">{width} × {height}</span>
    </div>
  );
}

export default function PhotoModePage({ workspaceState, onStateChange, isActive, contextBarTarget }) {
  const isTauriRuntime = isTauriRuntimeAvailable();
  const prefsRef = useRef(null);
  if (!prefsRef.current) prefsRef.current = readViewerPrefs();
  const [settings, setSettings] = useState(() => normalizePhotoState(workspaceState, prefsRef.current));
  const [runtime, setRuntime] = useState({});
  // Ready controllers by object id; changes only when a load finishes or an
  // object leaves, so texture progress never re-syncs the scene.
  const [controllers, setControllers] = useState({});
  const [reloadToken, setReloadToken] = useState(0);
  // Bumped when a vehicle's setup or mod files arrive, so changes waiting on
  // them are applied.
  const [setupTick, setSetupTick] = useState(0);
  const [inspectorTab, setInspectorTab] = useState("object");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const panes = usePaneWidths("cortex.photo.panes");
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [adding, setAdding] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [notice, setNotice] = useState(null);
  const [capturing, setCapturing] = useState(false);
  const [viewSize, setViewSize] = useState(null);

  const viewportRef = useRef(null);
  const runtimeRef = useRef(new Map());
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // The camera is restored (or the set framed) once the first object is on
  // set; until then the viewport's default camera must not be saved.
  const cameraSettledRef = useRef(false);

  const { scene, objects, selectedId } = settings;
  const selected = objects.find((object) => object.id === selectedId) || null;

  const raiseAlert = useCallback((id, label, text) => {
    setAlerts((prev) => [...prev.filter((alert) => alert.id !== id), { id, label, text }]);
  }, []);
  const dismissAlert = useCallback((id) => setAlerts((prev) => prev.filter((alert) => alert.id !== id)), []);
  const patchRuntime = useCallback((id, patch) => {
    setRuntime((prev) => (prev[id] || patch.status ? { ...prev, [id]: { ...prev[id], ...patch } } : prev));
  }, []);

  /* ── Persist (debounced; Shell skips unchanged state) ── */
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  useEffect(() => {
    const timer = setTimeout(() => onStateChangeRef.current?.(settings), PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [settings]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const updateObject = useCallback((id, patch) => {
    setSettings((prev) => ({
      ...prev,
      objects: prev.objects.map((object) => (object.id === id ? { ...object, ...patch } : object)),
    }));
  }, []);
  const updateScene = useCallback((patch) => setSettings((prev) => ({ ...prev, scene: { ...prev.scene, ...patch } })), []);
  const select = useCallback((id) => setSettings((prev) => (prev.selectedId === id ? prev : { ...prev, selectedId: id })), []);
  // Selecting from the Camera or Scene tab brings the selection's own tab forward.
  const showSelectionTab = useCallback((kind) => {
    setInspectorTab((prev) => (prev === "camera" || prev === "scene" ? (kind === "vehicle" ? "vehicle" : "object") : prev));
  }, []);

  /* ── Load objects: one controller per object, rebuilt only when its load key changes ── */
  const loadSignature = objects.map((object) => `${object.id}=${loadKeyOf(object)}`).join("\n");
  useEffect(() => {
    if (!isTauriRuntime) return;
    const live = new Set();
    for (const object of settingsRef.current.objects) {
      live.add(object.id);
      const key = loadKeyOf(object);
      const current = runtimeRef.current.get(object.id);
      if (current?.key === key) continue;
      current?.abort.abort();
      const entry = { key, abort: new AbortController(), controller: current?.controller || null, applied: {} };
      runtimeRef.current.set(object.id, entry);
      const { signal } = entry.abort;
      const id = object.id;
      patchRuntime(id, { status: "loading", message: "Loading…", error: "", poseStatus: "", textures: null });
      const onStatus = (message) => !signal.aborted && patchRuntime(id, { message });
      (async () => {
        try {
          const controller = object.kind === "ped"
            ? await loadPhotoPed({ look: object.ped, renderer: viewportRef.current?.getRenderer(), signal, onStatus })
            : await loadPhotoModel({ kind: object.kind, source: object.source, name: object.name, path: object.path, signal, onStatus });
          if (signal.aborted) {
            controller.dispose();
            return;
          }
          // The previous build stays on set until its replacement is ready.
          entry.controller?.dispose();
          entry.controller = controller;
          entry.applied = {};
          setControllers((prev) => ({ ...prev, [id]: controller }));
          patchRuntime(id, {
            status: "ready",
            parser: controller.parser || "",
            warnings: controller.warnings,
            message: "",
          });
          if (controller.nativeAvailable) {
            patchRuntime(id, { textures: { state: "loading", loaded: 0, planned: 0 } });
            controller.loadTextures({
              renderer: viewportRef.current?.getRenderer(),
              signal,
              onProgress: (progress) => !signal.aborted && patchRuntime(id, { textures: { state: "loading", ...progress } }),
              onRender: () => viewportRef.current?.requestRender(),
            }).then(
              (summary) => {
                if (signal.aborted) return;
                entry.applied.paint = null;
                entry.applied.livery = undefined;
                patchRuntime(id, { textures: { state: "ready", ...summary } });
                setSetupTick((tick) => tick + 1);
              },
              (error) => {
                if (error?.name !== "AbortError" && !signal.aborted) {
                  patchRuntime(id, { textures: { state: "error", error: errorMessage(error) } });
                }
              },
            );
          }
          if (object.kind === "vehicle") {
            entry.setup = null;
            entry.modFiles = null;
            entry.modFilesPromise = null;
            patchRuntime(id, { setup: { status: "loading" }, mods: null, plate: null });
            readVehicleSetup({ object, modelPath: controller.modelPath, signal })
              .then(async (setup) => {
                if (signal.aborted) return;
                let roofError = "";
                if (setup.roof) {
                  try {
                    const clip = await exportRoofClip({ modelPath: controller.modelPath, roof: setup.roof });
                    if (!signal.aborted && !controller.setRoofClip(clip)) roofError = "The roof animation doesn't match this model's skeleton.";
                  } catch (error) {
                    roofError = `The roof animation didn't load: ${errorMessage(error)}`;
                  }
                }
                if (signal.aborted) return;
                entry.setup = setup;
                patchRuntime(id, {
                  setup: {
                    status: "ready",
                    kits: setup.kits,
                    steeringLock: setup.steeringLock,
                    sirenSetting: setup.sirenSetting,
                    roof: controller.hasRoof,
                    roofError,
                    warnings: setup.warnings,
                  },
                });
                setSetupTick((tick) => tick + 1);
              })
              .catch((error) => {
                if (error?.name === "AbortError" || signal.aborted) return;
                patchRuntime(id, { setup: { status: "error", error: errorMessage(error) } });
              });
          }
        } catch (error) {
          if (error?.name === "AbortError" || signal.aborted) return;
          patchRuntime(id, { status: "error", error: errorMessage(error), message: "" });
        }
      })();
    }
    for (const [id, entry] of runtimeRef.current) {
      if (live.has(id)) continue;
      entry.abort.abort();
      entry.controller?.dispose();
      runtimeRef.current.delete(id);
      const drop = (prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      };
      setRuntime(drop);
      setControllers(drop);
    }
  }, [isTauriRuntime, loadSignature, reloadToken, patchRuntime]);

  useEffect(() => () => {
    for (const entry of runtimeRef.current.values()) {
      entry.abort.abort();
      entry.controller?.dispose();
    }
    runtimeRef.current.clear();
  }, []);

  const readyCount = Object.keys(controllers).length;
  useEffect(() => {
    if (cameraSettledRef.current || readyCount === 0) return;
    const frame = requestAnimationFrame(() => {
      cameraSettledRef.current = true;
      const viewport = viewportRef.current;
      const saved = settingsRef.current.camera;
      viewport?.refit();
      if (saved) viewport?.setCamera(saved);
      else viewport?.frameAll("angle");
    });
    return () => cancelAnimationFrame(frame);
  }, [readyCount]);

  /* ── Vehicle settings beyond paint and doors, applied in place ── */
  const applyVehicleSettings = (object, entry, controller) => {
    const vehicle = object.vehicle;
    const id = object.id;
    const render = () => viewportRef.current?.requestRender();
    if (entry.applied.extras !== vehicle.extras) {
      controller.setExtras(vehicle.extras);
      entry.applied.extras = vehicle.extras;
    }
    const lock = entry.setup?.steeringLock ?? STEERING_LIMIT;
    const steering = Math.max(-lock, Math.min(lock, vehicle.steering));
    if (entry.applied.steering !== steering) {
      controller.setSteering(steering);
      entry.applied.steering = steering;
    }
    if (controller.hasRoof && entry.applied.roof !== vehicle.roof) {
      controller.setRoof(vehicle.roof, { animate: entry.applied.roof !== undefined });
      entry.applied.roof = vehicle.roof;
    }
    if (controller.liveries && entry.applied.livery !== vehicle.livery) {
      entry.applied.livery = vehicle.livery;
      controller.setLivery(vehicle.livery, { renderer: viewportRef.current?.getRenderer() })
        .then(render, (error) => patchRuntime(id, { liveryError: `The livery didn't load: ${errorMessage(error)}` }));
    }
    const plateImage = vehicle.plate.image;
    const plateKey = controller.hasPlate
      ? `${vehicle.plate.style}|${vehicle.plate.text}|${plateImage ? `${plateImage.path}|${plateImage.stamp}` : ""}`
      : "";
    if (plateKey && entry.applied.plate !== plateKey) {
      entry.applied.plate = plateKey;
      buildPlateImage(vehicle.plate, { invoke, readFile }).then(
        (image) => {
          if (entry.applied.plate !== plateKey) return;
          controller.setPlateImage(image);
          patchRuntime(id, { plate: { ok: true } });
          render();
        },
        (error) => patchRuntime(id, { plate: { ok: false, error: errorMessage(error) } }),
      );
    }

    // Vehicle lights. A hidden vehicle keeps its switches but shows no light.
    const lightScene = settingsRef.current.scene;
    const sirenSetting = entry.setup?.sirenSetting || null;
    const lightsKey = JSON.stringify([vehicle.lights, object.hidden, lightScene.lightGlow, lightScene.lightSpill, lightScene.haze, sirenSetting?.id ?? null]);
    if (entry.applied.lights !== lightsKey) {
      entry.applied.lights = lightsKey;
      controller.setLights({
        setting: sirenSetting,
        switches: object.hidden ? null : vehicle.lights,
        spill: lightScene.lightSpill > 0,
        spillStrength: lightScene.lightSpill,
        glow: lightScene.lightGlow,
        haze: lightScene.haze,
      });
      render();
    }

    const modsKey = JSON.stringify(vehicle.mods);
    if (entry.applied.mods === modsKey) return;
    const picked = Object.keys(vehicle.mods.slots).length > 0;
    if (!picked) {
      entry.applied.mods = modsKey;
      controller.setMods(null, { onRender: render });
      patchRuntime(id, { mods: null });
      return;
    }
    if (!entry.setup) return;
    if (!entry.modFiles) {
      // Mod parts are prepared once, the first time a mod is picked.
      if (!entry.modFilesPromise) {
        patchRuntime(id, { mods: { status: "preparing" } });
        entry.modFilesPromise = readVehicleModFiles({
          object,
          root: entry.setup.root,
          modelPath: controller.modelPath,
          signal: entry.abort.signal,
        }).then(
          (files) => {
            if (entry.abort.signal.aborted) return;
            entry.modFiles = files;
            setSetupTick((tick) => tick + 1);
          },
          (error) => {
            entry.modFilesPromise = null;
            if (error?.name !== "AbortError") patchRuntime(id, { mods: { status: "error", error: errorMessage(error) } });
          },
        );
      }
      return;
    }
    const kit = entry.setup.kits.find((item) => item.kitName === vehicle.mods.kit) || entry.setup.kits[0];
    if (!kit) return;
    entry.applied.mods = modsKey;
    const resolution = resolveModSelection(kit, vehicle.mods.slots, entry.modFiles.modelIndex);
    patchRuntime(id, { mods: { status: "loading", missing: resolution.missing } });
    controller.setMods(resolution, { renderer: viewportRef.current?.getRenderer(), onRender: render }).then((result) => {
      if (!result.current) return;
      patchRuntime(id, { mods: { status: "ready", missing: resolution.missing, failed: result.failed } });
      render();
    });
  };

  /* ── Apply paint, doors and poses in place ── */
  useEffect(() => {
    for (const object of objects) {
      const entry = runtimeRef.current.get(object.id);
      const controller = controllers[object.id];
      if (!controller || entry?.controller !== controller) continue;
      if (object.kind === "vehicle") {
        if (entry.applied.paint !== object.vehicle.paint) {
          controller.setPaint(object.vehicle.paint);
          entry.applied.paint = object.vehicle.paint;
        }
        if (entry.applied.doors !== object.vehicle.doors) {
          controller.setDoors(object.vehicle.doors, { animate: entry.applied.doors !== undefined });
          entry.applied.doors = object.vehicle.doors;
        }
        applyVehicleSettings(object, entry, controller);
      }
      if (object.kind === "ped") {
        const poseKey = poseKeyOf(object);
        if (entry.applied.pose !== poseKey) {
          entry.applied.pose = poseKey;
          const poseAbort = new AbortController();
          entry.poseAbort?.abort();
          entry.poseAbort = poseAbort;
          patchRuntime(object.id, { poseStatus: "loading", poseError: "" });
          controller.setPose(object.ped, poseAbort.signal).then(
            (result) => {
              if (poseAbort.signal.aborted) return;
              patchRuntime(object.id, { poseStatus: "ready", duration: result?.duration || 0 });
              viewportRef.current?.refit();
            },
            (error) => {
              if (error?.name === "AbortError" || poseAbort.signal.aborted) return;
              patchRuntime(object.id, { poseStatus: "error", poseError: `The pose didn't load: ${errorMessage(error)}`, duration: 0 });
            },
          );
        } else if (!object.ped.playing && entry.applied.time !== object.ped.time) {
          controller.setTime(object.ped.time);
        }
        entry.applied.time = object.ped.time;
      }
    }
    viewportRef.current?.requestRender();
    // applyVehicleSettings reads only refs and stable callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objects, controllers, setupTick, scene, patchRuntime]);

  const anyPlaying = objects.some((object) => object.kind === "ped" && object.ped.playing && !object.hidden);
  const handleStep = useCallback((dt, now) => {
    let moving = false;
    for (const object of settingsRef.current.objects) {
      const controller = runtimeRef.current.get(object.id)?.controller;
      if (!controller) continue;
      if (object.kind === "ped") {
        if (object.ped.playing) controller.step(dt);
      } else if (controller.step(dt, now)) {
        moving = true;
      }
    }
    return moving;
  }, []);

  const togglePart = useCallback((id, target) => {
    const object = settingsRef.current.objects.find((item) => item.id === id);
    if (object?.kind !== "vehicle") return;
    if (target.kind === "roof") {
      updateObject(id, { vehicle: { ...object.vehicle, roof: object.vehicle.roof >= 0.5 ? 0 : 1 } });
      return;
    }
    const doors = { ...object.vehicle.doors };
    if ((doors[target.id] || 0) >= 0.5) delete doors[target.id];
    else doors[target.id] = 1;
    updateObject(id, { vehicle: { ...object.vehicle, doors } });
  }, [updateObject]);

  const togglePlay = useCallback((id) => {
    const object = settingsRef.current.objects.find((item) => item.id === id);
    if (object?.kind !== "ped") return;
    const controller = runtimeRef.current.get(id)?.controller;
    const playing = !object.ped.playing;
    // Pausing keeps the frame the animation stopped on.
    const time = !playing && controller ? Number(controller.time.toFixed(3)) : object.ped.time;
    updateObject(id, { ped: { ...object.ped, playing, time } });
  }, [updateObject]);

  /* ── Set dressing ── */
  const addObject = useCallback((partial) => {
    let refused = false;
    setSettings((prev) => {
      if (prev.objects.length >= PHOTO_OBJECT_LIMIT) {
        refused = true;
        return prev;
      }
      const object = normalizePhotoObject({
        ...partial,
        id: newObjectId(),
        position: placeNewObject(prev.objects, partial.kind),
      });
      if (!object) return prev;
      return { ...prev, objects: [...prev.objects, object], selectedId: object.id };
    });
    if (refused) raiseAlert("limit", "The set is full", `Photo Mode holds up to ${PHOTO_OBJECT_LIMIT} objects. Remove one to add another.`);
    setAdding(null);
    setInspectorTab(partial.kind === "vehicle" ? "vehicle" : "object");
  }, [raiseAlert]);

  const removeObject = useCallback((id) => {
    setSettings((prev) => {
      const index = prev.objects.findIndex((object) => object.id === id);
      if (index < 0) return prev;
      const next = prev.objects.filter((object) => object.id !== id);
      const selectedNext = prev.selectedId === id ? next[Math.min(index, next.length - 1)]?.id || null : prev.selectedId;
      return { ...prev, objects: next, selectedId: selectedNext };
    });
  }, []);

  const toggleHidden = useCallback((id) => {
    const object = settingsRef.current.objects.find((item) => item.id === id);
    if (object) updateObject(id, { hidden: !object.hidden });
  }, [updateObject]);

  const retry = useCallback((id) => {
    const entry = runtimeRef.current.get(id);
    if (entry) entry.key = "";
    // The loader re-runs and rebuilds only the object whose key was cleared.
    setReloadToken((token) => token + 1);
  }, []);

  /* ── Camera ── */
  const handleCameraChange = useCallback(() => {
    if (!cameraSettledRef.current) return;
    const camera = viewportRef.current?.getCamera();
    if (!camera) return;
    setSettings((prev) => ({ ...prev, camera: { ...camera, lens: prev.lens } }));
  }, []);

  const handleResize = useCallback((size) => {
    setViewSize((prev) => (prev?.width === size.width && prev?.height === size.height ? prev : size));
  }, []);

  const saveShot = useCallback(() => {
    const camera = viewportRef.current?.getCamera();
    if (!camera) return;
    setSettings((prev) => {
      if (prev.shots.length >= PHOTO_SHOT_LIMIT) return prev;
      const used = new Set(prev.shots.map((shot) => shot.name));
      let n = prev.shots.length + 1;
      while (used.has(`View ${n}`)) n += 1;
      return { ...prev, shots: [...prev.shots, { id: newObjectId(), name: `View ${n}`, ...camera, lens: prev.lens }] };
    });
  }, []);

  const useShot = useCallback((shot) => {
    setSettings((prev) => ({ ...prev, lens: shot.lens }));
    viewportRef.current?.setCamera(shot);
  }, []);

  /* ── Photo ── */
  const takePhoto = useCallback(async () => {
    const viewport = viewportRef.current;
    const current = settingsRef.current;
    if (!viewport || !isTauriRuntime || capturing) return;
    const { width, height } = outputSize(current.output);
    const transparent = current.output.transparent && current.scene.stage !== "showroom";
    try {
      const target = await save({
        defaultPath: photoFileName(current.objects.map((object) => ({ ...object, name: objectLabel(object) }))),
        filters: [{ name: "PNG image", extensions: ["png"] }],
        title: "Save photo",
      });
      if (!target) return;
      setCapturing(true);
      const bytes = await viewport.capture({ width, height, transparent });
      await writeFile(target, await applyWatermarkToPngBytes(bytes, loadPrefs()?.defaults?.watermark));
      trackUsage("photo");
      dismissAlert("capture");
      setNotice({ id: Date.now(), path: target });
    } catch (error) {
      raiseAlert("capture", "Photo not saved", errorMessage(error));
    } finally {
      setCapturing(false);
    }
  }, [capturing, dismissAlert, isTauriRuntime, raiseAlert]);

  const showSavedPhoto = useCallback(async (path) => {
    const { folder } = splitPath(path);
    if (await openFolderPath(folder)) return;
    raiseAlert("open-folder", "Folder not opened", `Windows couldn't open ${folder}. The photo is saved there.`);
  }, [raiseAlert]);

  /* ── Keyboard ── */
  useEffect(() => {
    if (!isActive || adding) return undefined;
    const onKeyDown = (event) => {
      if (event.ctrlKey || event.altKey || event.metaKey || isEditableTarget(event.target)) return;
      const key = event.key.toLowerCase();
      const current = settingsRef.current;
      const id = current.selectedId;
      if (key === "g") setSettings((prev) => ({ ...prev, gizmo: "translate" }));
      else if (key === "r") setSettings((prev) => ({ ...prev, gizmo: "rotate" }));
      else if (key === "f") {
        if (id) viewportRef.current?.frameObject(id, "angle");
        else viewportRef.current?.frameAll("angle");
      } else if (key === "h" && id) toggleHidden(id);
      else if (key === "delete" && id) removeObject(id);
      else if (key === " " && id) togglePlay(id);
      else if (key === "p") takePhoto();
      else if (key === "escape" && id) select(null);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [adding, isActive, removeObject, select, takePhoto, toggleHidden, togglePlay]);

  /* ── Keyboard: the customizable view and camera shortcuts ── */
  // The shots frame the whole set, like the deck; Reset View frames as F does.
  const showShot = (key) => {
    if (readyCount === 0) return false;
    viewportRef.current?.frameAll(key);
    return true;
  };
  const hotkeys = useWorkspaceHotkeys({
    isActive,
    enabled: !adding,
    handlers: {
      [HOTKEY_ACTIONS.TOGGLE_PANEL]: () => setPanelCollapsed((value) => !value),
      [HOTKEY_ACTIONS.RESET_VIEW]: () => {
        const id = settingsRef.current.selectedId;
        if (id) viewportRef.current?.frameObject(id, "angle");
        else viewportRef.current?.frameAll("angle");
      },
      [HOTKEY_ACTIONS.CAMERA_PRESET_FRONT]: () => showShot("front"),
      [HOTKEY_ACTIONS.CAMERA_PRESET_BACK]: () => showShot("back"),
      [HOTKEY_ACTIONS.CAMERA_PRESET_SIDE]: () => showShot("side"),
      [HOTKEY_ACTIONS.CAMERA_PRESET_ANGLE]: () => showShot("angle"),
      [HOTKEY_ACTIONS.CAMERA_PRESET_TOP]: () => showShot("top"),
      [HOTKEY_ACTIONS.CAPTURE_VIEW]: () => (isTauriRuntime && readyCount > 0 ? takePhoto() : false),
    },
  });

  /* ── Derived ── */
  const showroomOn = scene.stage === "showroom";
  const showroomOptions = useMemo(
    () => ({ light: scene.light, spot: scene.spot, reflect: scene.reflect, beam: scene.beam, floor: scene.floor }),
    [scene.light, scene.spot, scene.reflect, scene.beam, scene.floor],
  );
  const viewportObjects = useMemo(
    () => objects.map((object) => ({
      id: object.id,
      controller: controllers[object.id] || null,
      hidden: object.hidden,
      position: object.position,
      yaw: object.yaw,
      light: object.light,
    })),
    [objects, controllers],
  );
  const loadingCount = objects.filter((object) => runtime[object.id]?.status === "loading").length;
  const hasReady = readyCount > 0;
  const output = outputSize(settings.output);
  const frameState = { isActive, isBooting: false, contextBarTarget, panelCollapsed, setPanelCollapsed, hotkeys };
  const photoBlocked = !isTauriRuntime ? "Saving photos needs the desktop app." : !hasReady ? "Add something to the set first." : "";

  return (
    <WorkspaceFrame s={frameState} inspectorOpen={inspectorOpen} setInspectorOpen={setInspectorOpen} className="pm-root" style={panes.style}>
      {/* ──── On set ──── */}
      <aside className="lv-dock" aria-label="On set" inert={panelCollapsed}>
        <div className="lv-dock-scroll custom-scrollbar pm-dock-scroll">
          <div className="pm-set-head">
            <h3 className="lv-group-title">On set</h3>
            <span className="pm-set-count">{objects.length}/{PHOTO_OBJECT_LIMIT}</span>
            {objects.length > 0 ? (
              <button
                type="button"
                className="cx-btn lv-btn-sm pm-set-add"
                onClick={() => setAdding("vehicle")}
                disabled={!isTauriRuntime || objects.length >= PHOTO_OBJECT_LIMIT}
                title={objects.length >= PHOTO_OBJECT_LIMIT ? "The set is full" : "Add a vehicle, person or prop"}
              >
                <Plus aria-hidden="true" />
                Add
              </button>
            ) : null}
          </div>

          {objects.length === 0 ? (
            <div className="pm-set-empty">
              <p className="lv-slot-note">
                {isTauriRuntime ? "Nothing on set yet." : "Reading game files needs the desktop app."}
              </p>
              <div className="pm-add-list" role="group" aria-label="Add to set">
                {[
                  { kind: "vehicle", title: "Vehicle", hint: "Any car, bike, aircraft or boat in the game" },
                  { kind: "ped", title: "Person", hint: "A freemode ped, dressed and posed" },
                  { kind: "prop", title: "Prop", hint: "Cones, barriers, furniture and more" },
                ].map((item) => {
                  const Icon = KIND_ICONS[item.kind];
                  return (
                    <button
                      key={item.kind}
                      type="button"
                      className="cx-btn is-quiet lv-btn-sm pm-add-btn"
                      onClick={() => setAdding(item.kind)}
                      disabled={!isTauriRuntime}
                      title={item.hint}
                    >
                      <Icon aria-hidden="true" />
                      {item.title}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <ul className="pm-set-list" aria-label="Objects on set">
              {objects.map((object) => {
                const Icon = KIND_ICONS[object.kind];
                const state = runtime[object.id];
                const isSelected = object.id === selectedId;
                return (
                  <li key={object.id} className={`pm-row ${isSelected ? "is-selected" : ""} ${object.hidden ? "is-hidden" : ""}`}>
                    <button
                      type="button"
                      className="pm-row-main"
                      aria-pressed={isSelected}
                      onClick={() => {
                        select(object.id);
                        showSelectionTab(object.kind);
                      }}
                      onDoubleClick={() => viewportRef.current?.frameObject(object.id, "angle")}
                      title={object.path || object.name}
                    >
                      <Icon className="pm-row-icon" aria-hidden="true" />
                      <span className="pm-row-text">
                        <span className="pm-row-name">{objectLabel(object)}</span>
                        <span className="pm-row-meta">{objectMeta(object)}</span>
                      </span>
                      {state?.status === "loading" ? <Loader2 className="pm-spin pm-row-state" aria-label="Loading" /> : null}
                      {state?.status === "error" ? <AlertTriangle className="pm-row-state is-error" aria-label="Didn't load" /> : null}
                    </button>
                    <span className="pm-row-actions">
                      {state?.status === "error" ? (
                        <button type="button" className="cx-icon-btn" onClick={() => retry(object.id)} aria-label={`Retry ${objectLabel(object)}`} title="Try again">
                          <RotateCw aria-hidden="true" />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="cx-icon-btn"
                        onClick={() => toggleHidden(object.id)}
                        aria-label={object.hidden ? `Show ${objectLabel(object)}` : `Hide ${objectLabel(object)}`}
                        title={object.hidden ? "Show (H)" : "Hide (H)"}
                      >
                        {object.hidden ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                      </button>
                      <button
                        type="button"
                        className="cx-icon-btn"
                        onClick={() => removeObject(object.id)}
                        aria-label={`Remove ${objectLabel(object)}`}
                        title="Remove from set (Del)"
                      >
                        <X aria-hidden="true" />
                      </button>
                    </span>
                    {state?.status === "error" && isSelected ? <p className="pm-row-error">{state.error}</p> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="lv-dock-foot pm-dock-foot">
          <FootFact label="Size">{output.width} × {output.height}</FootFact>
          <FootFact label="Background">{settings.output.transparent && !showroomOn ? "transparent" : showroomOn ? "showroom" : "backdrop"}</FootFact>
          <button
            type="button"
            className="cx-btn is-primary lv-capture-btn"
            onClick={takePhoto}
            disabled={Boolean(photoBlocked) || capturing}
            title={photoBlocked || "Take the photo (P)"}
          >
            {capturing ? <Loader2 className="pm-spin" aria-hidden="true" /> : <Camera aria-hidden="true" />}
            {capturing ? "Rendering…" : "Take photo"}
            <kbd className="cx-keycap">P</kbd>
          </button>
          {photoBlocked && isTauriRuntime ? <p className="lv-foot-note">{photoBlocked}</p> : null}
        </div>
        <PaneResizer side="dock" label="Resize the on-set panel" setWidth={panes.setWidth} />
      </aside>

      {/* ──── Viewfinder ──── */}
      <section className="lv-finder" aria-label="Viewfinder">
        <div className="lv-stage">
          {isTauriRuntime ? (
            <PhotoViewport
              ref={viewportRef}
              objects={viewportObjects}
              selectedId={selectedId}
              gizmoMode={settings.gizmo}
              gizmoVisible={!capturing}
              lens={settings.lens}
              isActive={isActive}
              backgroundColor={scene.backdrop}
              lightIntensity={scene.lightLevel}
              dark={scene.dark}
              lightGlow={scene.lightGlow}
              stage={scene.stage}
              showroom={showroomOptions}
              showGrid={scene.grid && objects.length > 0}
              showShadows={scene.shadows}
              ambientOcclusion={scene.ambientOcclusion}
              playing={anyPlaying}
              onStep={handleStep}
              onSelect={(id) => {
                select(id);
                if (id) showSelectionTab(settingsRef.current.objects.find((item) => item.id === id)?.kind);
              }}
              onTransform={(id, transform) => updateObject(id, transform)}
              onTogglePart={togglePart}
              onCameraChange={handleCameraChange}
              onResize={handleResize}
            />
          ) : (
            <StageEmpty
              icon={Monitor}
              title="Desktop app required"
              line="Photo Mode reads vehicles, peds, animations and props from your GTA V install, which needs the Cortex Studio desktop app."
            />
          )}
          {isTauriRuntime && objects.length === 0 ? (
            <StageEmpty icon={Aperture} title="The set is empty" line="Add a vehicle, a person or props from the game, then frame your shot.">
              <button type="button" className="cx-btn is-primary" onClick={() => setAdding("vehicle")}>Add to set</button>
            </StageEmpty>
          ) : null}
        </div>

        <div className="lv-hud">
          {settings.output.guides && hasReady ? (
            <div className="pm-frame-host">
              <FrameGuide width={output.width} height={output.height} viewport={viewSize} />
            </div>
          ) : null}

          {objects.length ? (
            <StageToggle showroom={showroomOn} onChange={(on) => updateScene({ stage: on ? "showroom" : "workbench" })} title="A dark studio with a reflective floor and a spotlight you can aim" />
          ) : null}

          {loadingCount > 0 ? (
            <div className="lv-slip pm-status" role="status" aria-live="polite">
              <Loader2 className="pm-spin" aria-hidden="true" />
              <span>{loadingCount === 1 ? "Loading 1 object…" : `Loading ${loadingCount} objects…`}</span>
            </div>
          ) : null}

          <div className="lv-alerts" role="status" aria-live="polite">
            <AnimatePresence initial={false}>
              {alerts.map((alert) => (
                <motion.div key={alert.id} className="lv-alert" role="alert" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.16 }}>
                  <AlertTriangle className="lv-alert-icon" aria-hidden="true" />
                  <div className="lv-alert-copy">
                    <strong>{alert.label}</strong>
                    <span>{alert.text}</span>
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
                <motion.div key={notice.id} className="lv-toast pm-saved" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 12 }} transition={{ duration: 0.18 }}>
                  <Check aria-hidden="true" />
                  <span className="pm-saved-path" title={notice.path}>{notice.path}</span>
                  <button type="button" className="lv-link" onClick={() => showSavedPhoto(notice.path)}>Show</button>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>

          {hasReady ? (
            <div className="lv-deck" role="toolbar" aria-label="Camera and set">
              <div className="lv-deck-group" role="group" aria-label="Camera shots">
                {SHOTS.map((shot) => (
                  <DeckButton key={shot.key} onClick={() => viewportRef.current?.frameAll(shot.key)} title={`${shot.label} view of the whole set`}>
                    {shot.label}
                  </DeckButton>
                ))}
                <DeckButton
                  onClick={() => (selectedId ? viewportRef.current?.frameObject(selectedId, "angle") : viewportRef.current?.frameAll("angle"))}
                  title={selectedId ? "Frame the selection (F)" : "Frame the set (F)"}
                  className="is-icon"
                >
                  <Crosshair aria-hidden="true" />
                </DeckButton>
              </div>
              <div className="lv-deck-group" role="group" aria-label="Gizmo">
                <DeckButton active={settings.gizmo === "translate"} onClick={() => setSettings((prev) => ({ ...prev, gizmo: "translate" }))} title="Move the selection (G)" className="is-icon">
                  <Move aria-hidden="true" />
                </DeckButton>
                <DeckButton active={settings.gizmo === "rotate"} onClick={() => setSettings((prev) => ({ ...prev, gizmo: "rotate" }))} title="Turn the selection (R)" className="is-icon">
                  <RotateCw aria-hidden="true" />
                </DeckButton>
              </div>
              <DeckViewMenu
                groups={[deckButtonItems(
                  <>
                    <DeckButton active={scene.grid && !showroomOn} onClick={() => updateScene({ grid: !scene.grid })} title="Ground grid" note="Workbench only" disabled={showroomOn} className="is-icon">
                      <Grid3x3 aria-hidden="true" />
                    </DeckButton>
                    <DeckButton active={scene.shadows || showroomOn} onClick={() => updateScene({ shadows: !scene.shadows })} title="Ground shadows" note="Always on in the showroom" disabled={showroomOn} className="is-icon">
                      <Sun aria-hidden="true" />
                    </DeckButton>
                    <DeckButton active={scene.ambientOcclusion} onClick={() => updateScene({ ambientOcclusion: !scene.ambientOcclusion })} title="Ambient occlusion" className="is-icon">
                      <Contrast aria-hidden="true" />
                    </DeckButton>
                    <DeckButton
                      active={settings.output.guides}
                      onClick={() => setSettings((prev) => ({ ...prev, output: { ...prev.output, guides: !prev.output.guides } }))}
                      title="Photo frame and thirds"
                      className="is-icon"
                    >
                      <Frame aria-hidden="true" />
                    </DeckButton>
                  </>,
                )]}
              />
              <div className="lv-deck-group">
                <DeckButton active={helpOpen} onClick={() => setHelpOpen((value) => !value)} title="Mouse and keyboard controls" className="is-icon">
                  <CircleHelp aria-hidden="true" />
                </DeckButton>
              </div>
              {helpOpen ? <PhotoHelp /> : null}
            </div>
          ) : null}
        </div>
      </section>

      <PhotoInspector
        onResize={panes.setWidth}
        tab={inspectorTab}
        onTab={setInspectorTab}
        inert={panelCollapsed || !inspectorOpen}
        settings={settings}
        selected={selected}
        runtime={selected ? { ...runtime[selected.id], controller: controllers[selected.id] || null } : null}
        desktop={isTauriRuntime}
        defaultBackdrop={prefsRef.current.background}
        onObject={(patch) => selected && updateObject(selected.id, patch)}
        onTogglePlay={() => selected && togglePlay(selected.id)}
        onScene={updateScene}
        onLens={(lens) => setSettings((prev) => ({ ...prev, lens }))}
        onSaveShot={saveShot}
        onUseShot={useShot}
        onDeleteShot={(id) => setSettings((prev) => ({ ...prev, shots: prev.shots.filter((shot) => shot.id !== id) }))}
        onOutput={(patch) => setSettings((prev) => ({ ...prev, output: { ...prev.output, ...patch } }))}
      />

      {adding ? (
        <AddToSetDialog initialKind={adding} desktop={isTauriRuntime} onAdd={addObject} onClose={() => setAdding(null)} />
      ) : null}
    </WorkspaceFrame>
  );
}
