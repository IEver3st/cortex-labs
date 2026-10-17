import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readTextFile, writeFile } from "@tauri-apps/plugin-fs";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import appMeta from "../../../package.json";
import { exportFileStem, formatSize, pickVideoType } from "../../lib/eup-export.js";
import { resolveModSelection } from "../../lib/vehicle-modkits.js";
import {
  BUILD_ANGLES,
  CURRENT_BUILD,
  buildKitShootManifest,
  KIT_SHOOT_SCHEMA,
  KIT_SHOOT_VERSION,
  collectShotIssues,
  diffImages,
  findDuplicateShots,
  normalizeKitShootSettings,
  partFileName,
  partsCrop,
  pickProbe,
  PROBE_VISIBLE_FRACTION,
  probeCandidates,
  thumbPath,
  planBuildsShoot,
  planFocusShot,
  planPartsShoot,
  renderKitShootReport,
  revealBonesForSlot,
} from "../../lib/kit-shoot.js";
import {
  canvasToJpegDataUrl,
  canvasToPngBytes,
  composeBeforeAfter,
  composeSheet,
  diffPixels,
  recordCycleVideo,
  scaleDiffBox,
} from "../../lib/kit-shoot-media.js";
import { drawWatermark, hasDrawableWatermark } from "../../lib/watermark.js";
import { getVehicleColor } from "../../lib/data/gta-vehicle-colors.js";
import { paintDisplayColor, paintFromIndex } from "../../lib/vehicle-paint.js";
import { openFolderPath } from "../../lib/open-folder.js";

/* Kit Shoot runs: steps the viewer through a mod kit's parts (or saved
   builds), waits until each state has loaded, renders it at the export size,
   and writes shots, before/after pairs, sheets, videos, a JSON manifest and an
   HTML report under a new folder in the user's preview export folder. The
   user's own mod selection, paint and grid are restored when a run ends. */

const SETTINGS_KEY = "cortex-labs:kit-shoot.v1";
const SETTLE_TIMEOUT_MS = 90_000;
const PREVIEW_WIDTH = 480;
const PRELOAD_BATCH = 4;
// Angle probes render the whole vehicle this wide; final diffs use DIFF_FINAL.
const PROBE_WIDTH = 256;
const DIFF_FINAL = 384;
const THUMB_WIDTH = 480;
const NO_MODS = Object.freeze({ parts: [], hiddenBones: [] });
const IDLE_PROGRESS = Object.freeze({ current: 0, total: 0, label: "" });

function loadSettings() {
  try {
    return normalizeKitShootSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null"));
  } catch {
    return normalizeKitShootSettings(null);
  }
}

function supportedVideoType() {
  if (typeof MediaRecorder === "undefined" || typeof HTMLCanvasElement === "undefined") return null;
  if (typeof HTMLCanvasElement.prototype.captureStream !== "function") return null;
  return pickVideoType((type) => MediaRecorder.isTypeSupported(type));
}

function abortError() {
  const error = new Error("The kit shoot was cancelled");
  error.name = "AbortError";
  return error;
}

// Lets React commit and the viewer apply a change. Animation frames pause in
// a minimised window, so a timer bounds the wait.
function nextFrames(count = 2) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, count * 50);
    const step = (left) => {
      if (left <= 0) {
        clearTimeout(timer);
        resolve();
        return;
      }
      requestAnimationFrame(() => step(left - 1));
    };
    step(count);
  });
}

function timestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

const INTERIOR_SLOT = /^VMT_(INTERIOR\d|SEATS|STEERING|KNOB|PLAQUE|ICE)$/;

function roundCrop(crop) {
  return Object.fromEntries(Object.entries(crop).map(([key, value]) => [key, Number(value.toFixed(4))]));
}

function dataUrlBytes(dataUrl) {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Viewer mod state from several resolutions; a part shown by any entry is shown. */
function mergeMods(entries, extraBones = []) {
  const parts = new Map();
  const bones = new Set(extraBones);
  for (const entry of entries) {
    const hidden = entry.hidden === true;
    for (const part of entry.resolution.parts) {
      const known = parts.get(part.key);
      if (!known) parts.set(part.key, { ...part, hidden });
      else if (!hidden) known.hidden = false;
    }
    if (!hidden) entry.resolution.hiddenBones.forEach((bone) => bones.add(bone));
  }
  return { parts: [...parts.values()], hiddenBones: [...bones].sort() };
}

/** What the viewer reported for one shot's parts in a slot. */
function observeParts(status, parts) {
  const loadErrors = [];
  const textures = { failed: 0, missing: 0 };
  for (const part of parts) {
    const entry = status?.parts?.[part.key];
    if (entry?.state === "error") loadErrors.push({ modelName: part.modelName, message: entry.message });
    else if (!entry || entry.state === "loading") loadErrors.push({ modelName: part.modelName, message: "it was still loading after 90 seconds" });
    if (entry?.textures?.state === "error") loadErrors.push({ modelName: part.modelName, message: entry.textures.message || "its textures failed" });
    textures.failed += entry?.textures?.failed || 0;
    textures.missing += entry?.textures?.missing || 0;
  }
  return { loadErrors, textures };
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
  const statusRef = useRef(null);
  const waitersRef = useRef(new Set());
  const requestSeqRef = useRef(0);
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
    statusRef.current = status;
    for (const waiter of [...waitersRef.current]) waiter(status);
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
    const stamp = hasDrawableWatermark(watermark);
    const createdAt = new Date();
    const modelName = kits.modelName || "vehicle";
    const root = `${folderResult.folder}/${modelName}/kit-shoot-${exportFileStem(kit.kitName, "kit")}-${timestamp(createdAt)}`;
    const modelIndex = kits.modelIndex;
    const startSelection = { ...kits.selection };
    const cameraSnapshot = api.getCameraSnapshot();
    const originalPaint = { ...paintRef.current };
    const gridWasOn = showGrid;

    const madeDirs = new Set();
    let saved = 0;
    const writeErrors = [];
    const write = async (relativePath, bytes) => {
      const fullPath = `${root}/${relativePath}`;
      const dir = fullPath.slice(0, fullPath.lastIndexOf("/"));
      try {
        if (!madeDirs.has(dir)) {
          await invoke("ensure_dir", { path: dir });
          madeDirs.add(dir);
        }
        await writeFile(fullPath, bytes);
        saved += 1;
        return true;
      } catch (error) {
        writeErrors.push({ path: relativePath, message: String(error?.message || error) });
        return false;
      }
    };
    const stampAndEncode = async (canvas) => {
      if (stamp) await drawWatermark(canvas.getContext("2d"), canvas.width, canvas.height, watermark);
      return canvasToPngBytes(canvas);
    };

    const waitForSettled = (requestId) => new Promise((resolve, reject) => {
      const done = (value, error) => {
        clearTimeout(timer);
        waitersRef.current.delete(check);
        signal.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(value);
      };
      const check = (status) => {
        if (status?.requestId === requestId && status.settled) done(status);
      };
      const onAbort = () => done(null, abortError());
      // A part that never settles is reported on its shot, not fatal to the run.
      const timer = setTimeout(() => done({ ...(statusRef.current || {}), timedOut: true }), SETTLE_TIMEOUT_MS);
      waitersRef.current.add(check);
      signal.addEventListener("abort", onAbort);
      check(statusRef.current);
    });
    const show = async (mods) => {
      if (signal.aborted) throw abortError();
      requestSeqRef.current += 1;
      const requestId = `kit-shoot-${requestSeqRef.current}`;
      modkitsRef.current.setShootOverride({ ...mods, requestId });
      const status = await waitForSettled(requestId);
      await nextFrames(1);
      return status;
    };
    const setPaint = async (index) => {
      const paint = index == null ? null : paintFromIndex(index);
      if (paint) {
        setBodyColor(paintDisplayColor(paint));
        setVehiclePaint((current) => ({ ...current, primary: paint }));
      } else {
        setBodyColor(originalPaint.bodyColor);
        setVehiclePaint(originalPaint.vehiclePaint);
      }
      await nextFrames(3);
    };
    const capture = (pose, crop = null) => {
      if (signal.aborted) throw abortError();
      const [canvas] = api.captureShots({ width: size.width, height: size.height, shots: [{ pose, crop }] });
      if (!canvas) throw new Error("the viewer returned no image");
      return canvas;
    };
    const probeSize = { width: PROBE_WIDTH, height: Math.round((size.height / size.width) * PROBE_WIDTH) };
    const probe = (poses) => {
      if (signal.aborted) throw abortError();
      const canvases = api.captureShots({ ...probeSize, shots: poses.map((pose) => ({ pose })) });
      return canvases.map((canvas) => (canvas ? diffPixels(canvas, probeSize.width).pixels : null));
    };
    // Writes the shot and its preview, and shows it as the latest frame.
    const saveShot = async (shot, canvas, label) => {
      const encoded = await stampAndEncode(canvas);
      shot.saved = await write(shot.file, encoded.bytes);
      if (!shot.saved) {
        shot.captureError = writeErrors.at(-1)?.message || "the file couldn't be written";
        return encoded;
      }
      const thumb = canvasToJpegDataUrl(canvas, THUMB_WIDTH);
      if (await write(thumbPath(shot.file), dataUrlBytes(thumb))) shot.thumb = thumbPath(shot.file);
      setLive({ url: thumb, label });
      return encoded;
    };

    setRunning(true);
    setResult(null);
    setLive(null);
    setOpenError("");
    if (gridWasOn) setShowGrid(false);

    let partsPlan = null;
    let buildsPlan = null;
    const sheets = [];
    const extraIssues = [];
    let fatal = "";
    try {
      await nextFrames(2);
      if (run.mode === "parts") {
        const base = run.base === "build" ? startSelection : {};
        partsPlan = planPartsShoot({ kit, base, slotTypes: run.slots });
        let done = 0;
        setProgress({ current: 0, total: partsPlan.shotCount, label: "" });
        for (const slot of partsPlan.slots) {
          const shots = slot.shots;
          for (const shot of shots) {
            shot.resolution = resolveModSelection(kit, shot.selection, modelIndex);
            shot.missing = shot.resolution.missing.filter((entry) => entry.slotType === slot.type).map((entry) => entry.modelName);
            shot.slotParts = shot.resolution.parts.filter((part) => part.slotType === slot.type);
          }
          slot.baseName = shots[0].name;
          const reveal = run.camera === "auto" ? revealBonesForSlot(slot.type) : [];
          setProgress({ current: done, total: partsPlan.shotCount, label: `Loading ${slot.displayName}` });
          // Load every part of the slot first, so the camera can be aimed at
          // all of them and each shot only toggles visibility. Uncached parts
          // each start a bridge process, so they load a few at a time.
          for (let loaded = 1; loaded === 1 || loaded < shots.length; loaded += PRELOAD_BATCH) {
            await show(mergeMods([
              { resolution: shots[0].resolution },
              ...shots.slice(1, loaded + PRELOAD_BATCH).map((shot) => ({ resolution: shot.resolution, hidden: true })),
            ], reveal));
          }
          // Every shot state of the slot, in order: base first.
          const stateFor = (index) => mergeMods(shots.map((other, otherIndex) => ({
            resolution: other.resolution,
            hidden: otherIndex !== index,
          })), reveal);

          let pose = { type: "view", camera: cameraSnapshot };
          let crop = null;
          slot.camera = { type: "view" };
          if (run.camera === "auto") {
            const keys = [...new Set(shots.flatMap((shot) => shot.slotParts.map((part) => part.key)))];
            const bones = [...new Set(shots.flatMap((shot) => shot.mod?.turnOffBones || []))];
            const measured = api.measureVehicleMods({ keys, bones });
            const cabin = measured ? { type: "focus", ...planFocusShot({ slotType: slot.type, focus: measured.focus, vehicle: measured.vehicle }) } : null;
            const candidates = probeCandidates(slot.type);
            const poses = candidates.map((candidate) => {
              if (!measured) return null;
              return candidate.kind === "cabin" ? cabin : { type: "focus", box: measured.vehicle, direction: candidate.direction };
            });
            // Find the angle: render every candidate for the base and each
            // part, and keep the one where the parts change the most pixels.
            const results = candidates.map(() => []);
            let baseProbe = null;
            for (let index = 0; index < shots.length; index += 1) {
              setProgress({ current: done, total: partsPlan.shotCount, label: `Finding the angle: ${slot.displayName} ${index + 1}/${shots.length}` });
              await show(stateFor(index));
              const probed = probe(poses);
              if (index === 0) {
                baseProbe = probed;
                continue;
              }
              probed.forEach((pixels, candidate) => {
                const before = baseProbe[candidate];
                results[candidate].push(pixels && before
                  ? diffImages(before, pixels, probeSize.width, probeSize.height)
                  : { fraction: 0, box: null });
              });
            }
            const best = pickProbe(candidates, results);
            if (best >= 0) {
              pose = poses[best];
              crop = partsCrop({
                boxes: results[best].filter((entry) => entry.fraction >= PROBE_VISIBLE_FRACTION).map((entry) => entry.box),
                ...probeSize,
              });
              slot.camera = { type: "auto", angle: candidates[best].id, crop: crop && roundCrop(crop) };
            } else if (measured) {
              // Nothing changed from any angle: aim where the parts should be.
              pose = INTERIOR_SLOT.test(slot.type)
                ? cabin
                : { type: "focus", ...planFocusShot({ slotType: slot.type, focus: measured.focus, vehicle: measured.vehicle }) };
              slot.camera = { type: "auto", angle: "fallback", crop: null };
            }
          }

          const frames = [];
          for (let index = 0; index < shots.length; index += 1) {
            const shot = shots[index];
            setProgress({ current: done, total: partsPlan.shotCount, label: `${slot.displayName}: ${shot.name}` });
            const status = await show(stateFor(index));
            Object.assign(shot, observeParts(status, shot.slotParts), {
              hiddenMeshCount: status?.hiddenMeshCount ?? 0,
              boneDataAvailable: Boolean(status?.boneDataAvailable),
            });
            try {
              const canvas = capture(pose, crop);
              const diff = diffPixels(canvas, DIFF_FINAL);
              const raw = stamp ? (await canvasToPngBytes(canvas)).blob : null;
              const encoded = await saveShot(shot, canvas, `${slot.displayName}: ${shot.name}`);
              frames.push({ shot, blob: raw || encoded.blob, diff });
            } catch (error) {
              if (error?.name === "AbortError") throw error;
              shot.captureError = String(error?.message || error);
            }
            done += 1;
          }

          // Compare every part with the slot's base and with each other.
          const baseFrame = frames.find((frame) => frame.shot === shots[0]) || null;
          const others = frames.filter((frame) => frame !== baseFrame);
          for (const frame of others) {
            if (!baseFrame) break;
            const result = diffImages(baseFrame.diff.pixels, frame.diff.pixels, frame.diff.width, frame.diff.height);
            frame.shot.changeFraction = result.fraction;
            frame.changeBox = scaleDiffBox(result.box, frame.diff.width, size.width);
          }
          if (others.length > 1) {
            const { width, height } = others[0].diff;
            const duplicates = findDuplicateShots(others.map((frame) => ({ id: frame.shot.id, pixels: frame.diff.pixels })), width, height);
            for (const frame of others) {
              const original = duplicates.get(frame.shot.id);
              if (original) frame.shot.duplicateOf = shots.find((shot) => shot.id === original)?.name || original;
            }
          }

          const bitmaps = new Map();
          const bitmapFor = async (frame) => {
            if (!bitmaps.has(frame)) bitmaps.set(frame, await createImageBitmap(frame.blob));
            return bitmaps.get(frame);
          };
          try {
            if (run.beforeAfter && baseFrame) {
              for (const frame of others) {
                if (signal.aborted) throw abortError();
                setProgress({ current: done, total: partsPlan.shotCount, label: `Before and after: ${frame.shot.name}` });
                const canvas = await composeBeforeAfter({
                  before: await bitmapFor(baseFrame),
                  after: await bitmapFor(frame),
                  style: run.beforeAfterStyle,
                  box: frame.changeBox,
                  zoom: run.zoomToChange,
                  beforeLabel: baseFrame.shot.name,
                  afterLabel: frame.shot.name,
                  detail: slot.displayName,
                });
                const path = `${slot.folder}/before-after/${partFileName(frame.shot.modIndex, frame.shot.name)}`;
                if (await write(path, (await stampAndEncode(canvas)).bytes)) frame.shot.beforeAfter = path;
              }
            }
            const items = [];
            if ((run.sheets || (run.videos && videoType)) && frames.length > 1) {
              for (const frame of frames) {
                items.push({
                  image: await bitmapFor(frame),
                  title: frame.shot.name,
                  detail: Number.isInteger(frame.shot.modIndex) ? `${slot.displayName} · ${frame.shot.modIndex}` : slot.displayName,
                });
              }
            }
            if (run.sheets && items.length > 1) {
              setProgress({ current: done, total: partsPlan.shotCount, label: `Sheet: ${slot.displayName}` });
              const canvas = await composeSheet({ items, format: run.format, title: `${modelName} · ${slot.displayName}` });
              const path = `sheets/${slot.folder}.png`;
              if (await write(path, (await stampAndEncode(canvas)).bytes)) slot.sheet = path;
            }
            if (run.videos && videoType && items.length > 1) {
              setProgress({ current: done, total: partsPlan.shotCount, label: `Recording ${slot.displayName}` });
              const blob = await recordCycleVideo({
                items,
                width: videoSize.width,
                height: videoSize.height,
                mimeType: videoType.mimeType,
                isCancelled: () => signal.aborted,
              });
              if (blob) {
                const path = `videos/${slot.folder}.${videoType.extension}`;
                if (await write(path, new Uint8Array(await blob.arrayBuffer()))) slot.video = path;
              }
            }
          } finally {
            bitmaps.forEach((bitmap) => bitmap.close());
          }
          setProgress({ current: done, total: partsPlan.shotCount, label: "" });
        }
      } else {
        const chosen = [];
        for (const name of run.builds) {
          if (name === CURRENT_BUILD) chosen.push({ name: "Current build", mods: startSelection });
          else {
            const build = kits.builds.find((entry) => entry.name === name);
            if (build) chosen.push(build);
          }
        }
        buildsPlan = planBuildsShoot({ kit, builds: chosen, angles: run.angles, paints: run.paints, stockBefore: run.beforeAfter });
        chosen.forEach((build, index) => {
          const kept = Object.keys(buildsPlan.builds[index].selection).length;
          const asked = Object.keys(build.mods || {}).length;
          if (kept < asked) {
            extraIssues.push({ code: "BUILD_PARTS_DROPPED", severity: "warning", message: `${build.name}: ${asked - kept} saved part${asked - kept === 1 ? " isn't" : "s aren't"} in ${kit.kitName} and ${asked - kept === 1 ? "was" : "were"} left stock.` });
          }
        });
        const measured = api.measureVehicleMods({});
        const poseFor = (angleId) => {
          const angle = BUILD_ANGLES.find((entry) => entry.id === angleId);
          return angle.id === "view" || !measured
            ? { type: "view", camera: cameraSnapshot }
            : { type: "focus", box: measured.vehicle, direction: angle.direction };
        };
        const shotKey = (shot) => `${shot.angle}|${shot.paint ?? ""}`;
        let done = 0;
        setProgress({ current: 0, total: buildsPlan.shotCount, label: "" });
        const shootList = async (list, label, keep) => {
          let paint;
          for (const shot of list) {
            if (shot.paint !== paint) {
              paint = shot.paint;
              await setPaint(paint);
            }
            setProgress({ current: done, total: buildsPlan.shotCount, label: `${label}: ${BUILD_ANGLES.find((entry) => entry.id === shot.angle).label}` });
            try {
              const canvas = capture(poseFor(shot.angle));
              const diff = keep ? diffPixels(canvas, DIFF_FINAL) : null;
              const raw = stamp && keep ? (await canvasToPngBytes(canvas)).blob : null;
              const encoded = await saveShot(shot, canvas, `${label}: ${BUILD_ANGLES.find((entry) => entry.id === shot.angle).label}`);
              if (keep) keep.set(shotKey(shot), { blob: raw || encoded.blob, diff, shot });
            } catch (error) {
              if (error?.name === "AbortError") throw error;
              shot.captureError = String(error?.message || error);
            }
            done += 1;
          }
        };

        const stockFrames = new Map();
        if (buildsPlan.stock.length) {
          await show(NO_MODS);
          await shootList(buildsPlan.stock, "Stock", stockFrames);
        }
        const firstFrames = [];
        for (const build of buildsPlan.builds) {
          const resolution = resolveModSelection(kit, build.selection, modelIndex);
          for (const entry of resolution.missing) {
            extraIssues.push({ code: "MODEL_MISSING", severity: "error", slotType: entry.slotType, message: `${build.name} uses ${entry.modelName}.yft, which isn't in this resource.` });
          }
          const status = await show(mergeMods([{ resolution }]));
          const observed = observeParts(status, resolution.parts);
          for (const error of observed.loadErrors) {
            extraIssues.push({ code: "LOAD_FAILED", severity: "error", message: `${build.name}: ${error.modelName} didn't load (${error.message}).` });
          }
          const frames = new Map();
          await shootList(build.shots, build.name, frames);
          for (const shot of build.shots) {
            const frame = frames.get(shotKey(shot));
            if (frame && shot.angle === buildsPlan.angles[0]?.id && shot.paint == null) firstFrames.push({ ...frame, title: build.name });
            const before = stockFrames.get(shotKey(shot));
            if (!run.beforeAfter || !frame || !before) continue;
            if (signal.aborted) throw abortError();
            const change = diffImages(before.diff.pixels, frame.diff.pixels, frame.diff.width, frame.diff.height);
            const [beforeImage, afterImage] = await Promise.all([createImageBitmap(before.blob), createImageBitmap(frame.blob)]);
            try {
              const canvas = await composeBeforeAfter({
                before: beforeImage,
                after: afterImage,
                style: run.beforeAfterStyle,
                box: scaleDiffBox(change.box, frame.diff.width, size.width),
                zoom: run.zoomToChange,
                beforeLabel: "Stock",
                afterLabel: build.name,
                detail: shot.paint == null ? "" : getVehicleColor(shot.paint)?.name || "",
              });
              const path = shot.file.replace(/\/([^/]+)$/, "/before-after/$1");
              if (await write(path, (await stampAndEncode(canvas)).bytes)) shot.beforeAfter = path;
            } finally {
              beforeImage.close();
              afterImage.close();
            }
          }
        }
        if (firstFrames.length > 1 && (run.sheets || (run.videos && videoType))) {
          const items = [];
          for (const frame of firstFrames) items.push({ image: await createImageBitmap(frame.blob), title: frame.title, detail: modelName });
          try {
            if (run.sheets) {
              const canvas = await composeSheet({ items, format: run.format, title: `${modelName} · builds` });
              if (await write("sheets/builds.png", (await stampAndEncode(canvas)).bytes)) sheets.push("sheets/builds.png");
            }
            if (run.videos && videoType) {
              setProgress({ current: done, total: buildsPlan.shotCount, label: "Recording builds" });
              const blob = await recordCycleVideo({ items, width: videoSize.width, height: videoSize.height, mimeType: videoType.mimeType, isCancelled: () => signal.aborted });
              const path = `videos/builds.${videoType.extension}`;
              if (blob && await write(path, new Uint8Array(await blob.arrayBuffer()))) buildsPlan.video = path;
            }
          } finally {
            items.forEach((item) => item.image.close());
          }
        }
      }
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
    const issues = [
      ...collectShotIssues({
        kit,
        slots: partsPlan?.slots || [],
        camera: run.camera,
        namesAvailable: (kits.nameSources || []).length > 0,
      }),
      ...extraIssues,
      ...writeErrors.map((entry) => ({ code: "CAPTURE_FAILED", severity: "error", message: `${entry.path} wasn't written: ${entry.message}` })),
    ];
    if (!nativeMaterialsEnabled) {
      issues.push({ code: "UNTEXTURED", severity: "info", message: "The model's own textures were off, so parts were shot untextured." });
    }
    const manifest = buildKitShootManifest({
      createdAt: createdAt.toISOString(),
      appVersion: appMeta.version,
      modelName,
      kit,
      settings: run,
      size,
      complete: !cancelled && !fatal && writeErrors.length === 0,
      base: run.mode === "parts" && run.base === "build" ? startSelection : {},
      parts: partsPlan?.slots || null,
      builds: buildsPlan ? [...buildsPlan.stock.length ? [{ name: "Stock", selection: {}, shots: buildsPlan.stock }] : [], ...buildsPlan.builds] : null,
      sheets,
      videos: buildsPlan?.video ? [buildsPlan.video] : [],
      issues,
    });
    const encoder = new TextEncoder();
    const filesSaved = saved;
    const allShots = [
      ...(partsPlan?.slots || []).flatMap((slot) => slot.shots),
      ...(buildsPlan ? [...buildsPlan.stock, ...buildsPlan.builds.flatMap((build) => build.shots)] : []),
    ];
    const shotsSaved = allShots.filter((shot) => shot.saved).length;
    const manifestSaved = saved > 0 && await write("kit-shoot.json", encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`));
    const reportSaved = saved > 0 && await write("report.html", encoder.encode(renderKitShootReport(manifest)));

    controllerRef.current = null;
    setRunning(false);
    setProgress(IDLE_PROGRESS);
    setLive(null);
    const folder = filesSaved > 0 ? root : "";
    if (folder && manifestSaved) {
      setReviewError("");
      setReview({ root, manifest });
    }
    setResult({
      folder,
      manifest: folder ? manifest : null,
      files: filesSaved,
      shots: shotsSaved,
      failed: writeErrors.length,
      firstError: writeErrors[0]?.message || "",
      fatal,
      cancelled,
      issues,
      manifestSaved,
      reportSaved,
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
