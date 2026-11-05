import { useCallback, useEffect, useRef, useState } from "react";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { exportFileStem, formatSize } from "../../lib/eup-export.js";
import {
  BUILD_ANGLES,
  KIT_SHOOT_SCHEMA,
  KIT_SHOOT_VERSION,
  normalizeKitShootSettings,
} from "../../lib/kit-shoot.js";
import { openFolderPath } from "../../lib/open-folder.js";
import {
  IDLE_PROGRESS,
  createModsStatusChannel,
  createShootRun,
  emptyKitRecord,
  nextFrames,
  shootBuilds,
  shootParts,
  supportedVideoType,
  timestamp,
  writeKitShootRecord,
} from "./shoot-runner.js";

/* Kit Shoot runs: steps the viewer through a mod kit's parts (or saved
   builds), waits until each state has loaded, renders it at the export size,
   and writes shots, before/after pairs, sheets, videos, a JSON manifest and an
   HTML report under a new folder in the user's preview export folder. The
   user's own mod selection, paint and grid are restored when a run ends. */

const SETTINGS_KEY = "cortex-labs:kit-shoot.v1";
const PREVIEW_WIDTH = 480;

function loadSettings() {
  try {
    return normalizeKitShootSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null"));
  } catch {
    return normalizeKitShootSettings(null);
  }
}

export default function useKitShoot({
  enabled,
  modkits,
  viewerApiRef,
  modelPath,
  viewerReady,
  isTauriRuntime,
  ensureFolder,
  watermark,
  nativeMaterialsEnabled,
  bodyColor,
  vehiclePaint,
  setBodyColor,
  setVehiclePaint,
  showGrid,
  setShowGrid,
}) {
  const [settings, setSettings] = useState(loadSettings);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(IDLE_PROGRESS);
  const [result, setResult] = useState(null);
  const [preview, setPreview] = useState({ url: "", note: "" });
  const [openError, setOpenError] = useState("");
  const [videoType] = useState(supportedVideoType);
  // The latest frame written, shown while a run is going.
  const [live, setLive] = useState(null);
  // The run open in the review screen: `{ root, manifest }`.
  const [review, setReview] = useState(null);
  const [reviewError, setReviewError] = useState("");

  const modkitsRef = useRef(modkits);
  modkitsRef.current = modkits;
  const paintRef = useRef({ bodyColor, vehiclePaint });
  paintRef.current = { bodyColor, vehiclePaint };
  const modsChannelRef = useRef(null);
  if (!modsChannelRef.current) modsChannelRef.current = createModsStatusChannel();
  const controllerRef = useRef(null);

  const update = useCallback((patch) => {
    setSettings((current) => {
      const next = normalizeKitShootSettings({ ...current, ...(typeof patch === "function" ? patch(current) : patch) });
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch {
        // Settings are a convenience; the run itself does not depend on them persisting.
      }
      return next;
    });
  }, []);

  /** App forwards the viewer's mod status here so a run can wait for it. */
  const handleModsStatus = useCallback((status) => {
    modsChannelRef.current.publish(status);
  }, []);

  // A different model, leaving Vehicle mode, or closing the workspace ends the run.
  useEffect(() => () => controllerRef.current?.abort(), [modelPath]);
  useEffect(() => {
    if (!enabled) controllerRef.current?.abort();
  }, [enabled]);

  const cancel = useCallback(() => controllerRef.current?.abort(), []);

  const refreshPreview = useCallback(() => {
    const api = viewerApiRef.current;
    if (!api?.captureShots || !viewerReady) {
      setPreview({ url: "", note: "" });
      return;
    }
    const size = formatSize(settings.format, false);
    const width = PREVIEW_WIDTH;
    const height = Math.round((size.height / size.width) * width);
    let pose = null;
    let note = "";
    if (settings.mode === "parts" && settings.camera === "view") {
      pose = { type: "view", camera: api.getCameraSnapshot() };
      note = "Every part is shot from this view.";
    } else if (settings.mode === "builds" && settings.angles.length) {
      const angle = BUILD_ANGLES.find((entry) => entry.id === settings.angles[0]);
      const measured = api.measureVehicleMods?.({});
      pose = angle.id === "view"
        ? { type: "view", camera: api.getCameraSnapshot() }
        : measured ? { type: "focus", box: measured.vehicle, direction: angle.direction } : null;
      note = `${angle.label}, the first angle of each build.`;
    }
    if (!pose) {
      setPreview({ url: "", note: settings.mode === "parts" ? "Each slot is tried from every side first, then shot close up from the angle that shows its parts best." : "" });
      return;
    }
    const [canvas] = api.captureShots({ width, height, shots: [{ pose }] });
    setPreview({ url: canvas ? canvas.toDataURL("image/jpeg", 0.86) : "", note });
  }, [viewerApiRef, viewerReady, settings.format, settings.mode, settings.camera, settings.angles]);

  const start = useCallback(async () => {
    const api = viewerApiRef.current;
    const kits = modkitsRef.current;
    const kit = kits.activeKit;
    if (running || !api?.captureShots || !kit || !isTauriRuntime || !viewerReady) return;

    const folderResult = await ensureFolder();
    if (!folderResult?.folder) return;

    const controller = new AbortController();
    controllerRef.current = controller;
    const { signal } = controller;
    const run = normalizeKitShootSettings(settings);
    const size = formatSize(run.format, run.high);
    const videoSize = formatSize(run.format, false);
    const createdAt = new Date();
    const modelName = kits.modelName || "vehicle";
    const root = `${folderResult.folder}/${modelName}/kit-shoot-${exportFileStem(kit.kitName, "kit")}-${timestamp(createdAt)}`;
    const startSelection = { ...kits.selection };
    const cameraSnapshot = api.getCameraSnapshot();
    const originalPaint = { ...paintRef.current };
    const gridWasOn = showGrid;
    const ctx = createShootRun({
      api,
      root,
      signal,
      watermark,
      modsChannel: modsChannelRef.current,
      setShootOverride: (mods) => modkitsRef.current.setShootOverride(mods),
      requestPrefix: "kit-shoot",
      setBodyColor,
      setVehiclePaint,
      originalPaint,
      onLive: setLive,
    });
    const progress = (current, total, label) => setProgress({ current, total, label });

    setRunning(true);
    setResult(null);
    setLive(null);
    setOpenError("");
    if (gridWasOn) setShowGrid(false);

    const record = emptyKitRecord();
    let fatal = "";
    try {
      await nextFrames(2);
      const options = { kit, kits, modelIndex: kits.modelIndex, modelName, run, size, videoSize, videoType, cameraSnapshot, startSelection, progress, record };
      if (run.mode === "parts") await shootParts(ctx, options);
      else await shootBuilds(ctx, options);
    } catch (error) {
      if (error?.name !== "AbortError") fatal = String(error?.message || error);
    } finally {
      modkitsRef.current.setShootOverride(null);
      if (run.mode === "builds" && run.paints.length) {
        setBodyColor(originalPaint.bodyColor);
        setVehiclePaint(originalPaint.vehiclePaint);
      }
      if (gridWasOn) setShowGrid(true);
    }

    const cancelled = signal.aborted;
    const failedWrites = [...ctx.writeErrors];
    const written = await writeKitShootRecord(ctx, {
      record, kit, kits, modelName, run, size, startSelection, createdAt, cancelled, fatal, nativeMaterialsEnabled, failedWrites,
    });

    controllerRef.current = null;
    setRunning(false);
    setProgress(IDLE_PROGRESS);
    setLive(null);
    const folder = written.filesBefore > 0 ? root : "";
    if (folder && written.manifestSaved) {
      setReviewError("");
      setReview({ root, manifest: written.manifest });
    }
    setResult({
      folder,
      manifest: folder ? written.manifest : null,
      files: written.filesBefore,
      shots: written.shotsSaved,
      failed: failedWrites.length,
      firstError: failedWrites[0]?.message || "",
      fatal,
      cancelled,
      issues: written.issues,
      manifestSaved: written.manifestSaved,
      reportSaved: written.reportSaved,
    });
  }, [
    running, settings, viewerApiRef, viewerReady, isTauriRuntime, ensureFolder, watermark,
    nativeMaterialsEnabled, showGrid, setShowGrid, setBodyColor, setVehiclePaint, videoType,
  ]);

  const openResultFolder = useCallback(async () => {
    if (!result?.folder) return;
    setOpenError("");
    try {
      const opened = await openFolderPath(result.folder);
      if (!opened) setOpenError("Windows couldn't open the folder. The files are still there.");
    } catch {
      setOpenError("Windows couldn't open the folder. The files are still there.");
    }
  }, [result]);

  const openReview = useCallback(() => {
    if (!result?.folder || !result.manifest) return;
    setReviewError("");
    setReview({ root: result.folder, manifest: result.manifest });
  }, [result]);

  const closeReview = useCallback(() => setReview(null), []);

  /** Opens an earlier run from its kit-shoot.json. */
  const openPreviousRun = useCallback(async () => {
    setReviewError("");
    let picked = null;
    try {
      picked = await openDialog({
        title: "Open a kit shoot",
        multiple: false,
        directory: false,
        filters: [{ name: "Kit shoot manifest", extensions: ["json"] }],
      });
    } catch {
      return;
    }
    const path = typeof picked === "string" ? picked : "";
    if (!path) return;
    try {
      const manifest = JSON.parse(await readTextFile(path));
      if (manifest?.schema !== KIT_SHOOT_SCHEMA) throw new Error("it isn't a kit-shoot.json file");
      if (manifest.version > KIT_SHOOT_VERSION) throw new Error(`it was written by a newer Cortex Studio (version ${manifest.version})`);
      const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
      setReview({ root: path.slice(0, cut), manifest });
    } catch (error) {
      setReviewError(`That shoot couldn't be opened: ${error?.message || error}.`);
    }
  }, []);

  const dismissResult = useCallback(() => {
    setResult(null);
    setOpenError("");
  }, []);

  return {
    settings,
    update,
    running,
    progress,
    result,
    openError,
    preview,
    refreshPreview,
    videoSupported: Boolean(videoType),
    start,
    cancel,
    handleModsStatus,
    openResultFolder,
    dismissResult,
    live,
    review,
    reviewError,
    openReview,
    closeReview,
    openPreviousRun,
  };
}
