import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import appMeta from "../../../package.json";
import { formatSize } from "../../lib/eup-export.js";
import { findDuplicateShots, normalizeKitShootSettings, thumbPath } from "../../lib/kit-shoot.js";
import { canvasToJpegDataUrl, composeBeforeAfter, composeSheet, diffPixels } from "../../lib/kit-shoot-media.js";
import { resolveModSelection } from "../../lib/vehicle-modkits.js";
import { describePreviewRun } from "../../lib/capture-output.js";
import { captureDimensions } from "../../lib/capture-settings.js";
import { MISS_PATTERN_KEYS } from "../../lib/els-vcf.js";
import { openFolderPath } from "../../lib/open-folder.js";
import {
  LIVERY_MOD_SLOT,
  LIVERY_TIMEOUT_SECONDS,
  buildListingManifest,
  collectListingIssues,
  heroAngle,
  listingDoctorRecord,
  listingIssue,
  liveryDuplicateNames,
  normalizeListingSettings,
  planListingShoot,
  renderListingReport,
} from "../../lib/listing-shoot.js";
import {
  DIFF_FINAL,
  IDLE_PROGRESS,
  abortError,
  createModsStatusChannel,
  createShootRun,
  dataUrlBytes,
  emptyKitRecord,
  mergeMods,
  nextFrames,
  observeParts,
  shootBuilds,
  shootParts,
  supportedVideoType,
  timestamp,
  writeKitShootRecord,
} from "./shoot-runner.js";

const SETTINGS_KEY = "cortex-labs:listing-shoot.v1";
const TURNTABLE_DIRECTION = [1, 0.2, 0];
const TURNTABLE_START_YAW = -Math.PI / 4;
const LIGHTS_DIRECTION = [0.8, 0.14, -0.8];
const LIGHTS_SETTLE_MS = 600;
const DOCTOR_WAIT_MS = 5000;
const SHEET_FORMAT = "landscape";

function loadSettings() {
  try {
    return normalizeListingSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null"));
  } catch {
    return normalizeListingSettings(null);
  }
}

function listingModelName(modelPath) {
  const name = String(modelPath || "").split(/[\\/]/).pop() || "";
  return name.replace(/\.[^.]+$/, "").replace(/_hi$/i, "") || "vehicle";
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}

function errorText(error) {
  return String(error?.message || error);
}

export function describeLights({ modelLights, vehicleLights, els }) {
  if (!modelLights?.sirens?.length) return { available: false, reason: "The model has no siren lights." };
  if (els?.live) return { available: true, system: "els", reason: "" };
  if (vehicleLights?.setting?.sirens?.length) return { available: true, system: "carcols", reason: "" };
  return { available: false, reason: "No siren setting was found for this vehicle in carcols.meta, and ELS isn't driving it." };
}

export default function useListingShoot({
  enabled,
  blocked = false,
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
  gameLivery,
  setGameLivery,
  gameLiveries,
  texturePath,
  textureTarget,
  captureSize,
  vehicleLights,
  updateVehicleLights,
  els,
  modelLights,
}) {
  const [settings, setSettings] = useState(loadSettings);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(IDLE_PROGRESS);
  const [result, setResult] = useState(null);
  const [live, setLive] = useState(null);
  const [recordingPaused, setRecordingPaused] = useState(false);
  const [openError, setOpenError] = useState("");
  const [videoType] = useState(supportedVideoType);

  const latest = useRef({});
  latest.current = { modkits, bodyColor, vehiclePaint, gameLivery, setGameLivery, vehicleLights, updateVehicleLights, els };
  const modsChannelRef = useRef(null);
  if (!modsChannelRef.current) modsChannelRef.current = createModsStatusChannel();
  const liveryRef = useRef(gameLiveries);
  liveryRef.current = gameLiveries;
  const liveryWaitersRef = useRef(new Set());
  const controllerRef = useRef(null);

  useEffect(() => {
    for (const waiter of [...liveryWaitersRef.current]) waiter(gameLiveries);
  }, [gameLiveries]);

  useEffect(() => () => controllerRef.current?.abort(), [modelPath]);
  useEffect(() => {
    if (!enabled) controllerRef.current?.abort();
  }, [enabled]);

  const update = useCallback((patch) => {
    setSettings((current) => {
      const next = normalizeListingSettings({ ...current, ...(typeof patch === "function" ? patch(current) : patch) });
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch {
        return next;
      }
      return next;
    });
  }, []);

  const handleModsStatus = useCallback((status) => {
    modsChannelRef.current.publish(status);
  }, []);

  const cancel = useCallback(() => controllerRef.current?.abort(), []);

  const kitReady = modkits?.eligible && modkits.status === "ready" ? modkits.activeKit : null;
  const lights = useMemo(() => describeLights({ modelLights, vehicleLights, els }), [modelLights, vehicleLights, els]);
  const heroSize = useMemo(() => captureDimensions(captureSize), [captureSize]);
  const planInputs = useMemo(() => ({
    heroSize,
    liveries: gameLiveries?.numbers || [],
    liveryNames: kitReady?.liveryNames || [],
    kit: kitReady,
    builds: modkits?.builds || [],
    stagedLivery: Boolean(texturePath),
    originalShown: Boolean(nativeMaterialsEnabled),
    videoExtension: videoType?.extension || null,
    lights,
  }), [heroSize, gameLiveries, kitReady, modkits?.builds, texturePath, nativeMaterialsEnabled, videoType, lights]);
  const plan = useMemo(() => planListingShoot({ ...planInputs, settings }), [planInputs, settings]);

  const waitForLivery = useCallback((number, signal) => new Promise((resolve, reject) => {
    const waiters = liveryWaitersRef.current;
    const done = (value, error) => {
      clearTimeout(timer);
      waiters.delete(check);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const shown = (status) => status?.shown === number && !status.error;
    const check = (status) => {
      if (shown(status)) done({ ok: true });
      else if (number != null && typeof status?.error === "string" && status.error.startsWith(`Livery ${number} `)) done({ error: status.error });
    };
    const onAbort = () => done(null, abortError());
    const timer = setTimeout(() => done({ timedOut: true }), LIVERY_TIMEOUT_SECONDS * 1000);
    signal.addEventListener("abort", onAbort);
    if (shown(liveryRef.current)) {
      done({ ok: true });
      return;
    }
    waiters.add(check);
  }), []);

  const start = useCallback(async ({ checkDoctor = null } = {}) => {
    const api = viewerApiRef.current;
    if (running || blocked || !api?.captureShots || !isTauriRuntime || !viewerReady) return;
    const run = planListingShoot({ ...planInputs, settings });
    if (run.empty) return;
    const measured = api.measureVehicleMods?.({});
    if (!measured?.vehicle) return;

    const folderResult = await ensureFolder();
    if (!folderResult?.folder) return;
    const doctorRun = typeof checkDoctor === "function"
      ? Promise.resolve().then(checkDoctor).catch((error) => ({ status: "unavailable", reason: `Pack Doctor stopped: ${errorText(error)}`, report: null }))
      : Promise.resolve({ status: "unavailable", reason: "Pack Doctor wasn't asked to check this vehicle.", report: null });

    const controller = new AbortController();
    controllerRef.current = controller;
    const { signal } = controller;
    const createdAt = new Date();
    const modelName = listingModelName(modelPath);
    const root = `${folderResult.folder}/${modelName}/listing-${timestamp(createdAt)}`;
    const kits = latest.current.modkits;
    const kit = (run.kit || run.lineup?.items.some((item) => item.kind === "mod")) ? kits.activeKit : null;
    const startSelection = { ...(kits?.selection || {}) };
    const originalPaint = { bodyColor: latest.current.bodyColor, vehiclePaint: latest.current.vehiclePaint };
    const startLivery = latest.current.gameLivery ?? null;
    const startSwitches = { ...(latest.current.vehicleLights?.switches || {}) };
    const startElsPreview = latest.current.els?.preview || null;
    const gridWasOn = showGrid;
    const ctx = createShootRun({
      api,
      root,
      signal,
      watermark,
      modsChannel: modsChannelRef.current,
      setShootOverride: (mods) => kits?.setShootOverride(mods),
      requestPrefix: "listing",
      setBodyColor,
      setVehiclePaint,
      originalPaint,
      onLive: setLive,
    });

    let done = 0;
    const report = (label) => setProgress({ current: done, total: run.steps, label });
    const poseFor = (angleId) => ({ type: "focus", box: measured.vehicle, direction: heroAngle(angleId).direction, rest: true });
    const extraIssues = [];
    const kitRuns = [];
    let paintChanged = false;
    let liveryChanged = false;
    let overrideUsed = false;
    let lightsChanged = false;

    const shootStill = async (item, size, pose, label, { keep = false, options } = {}) => {
      report(label);
      let kept = null;
      try {
        const canvas = ctx.capture(size, pose, null, options);
        if (keep) kept = { image: await createImageBitmap(canvas), diff: diffPixels(canvas, DIFF_FINAL) };
        await ctx.saveShot(item, canvas, label);
        if (!item.saved) item.error = item.captureError;
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        item.error = errorText(error);
      }
      done += 1;
      return kept;
    };

    const writeThumb = async (item, canvas) => {
      const thumb = canvasToJpegDataUrl(canvas, 480);
      if (await ctx.write(thumbPath(item.file), dataUrlBytes(thumb))) item.thumb = thumbPath(item.file);
      setLive({ url: thumb, label: item.label || item.name });
    };

    const writeSheet = async (group, entries, title) => {
      if (!group.sheet || entries.length < 2) return;
      report(`Sheet: ${title}`);
      const canvas = await composeSheet({ items: entries, format: SHEET_FORMAT, title: `${modelName} · ${title}` });
      group.sheetSaved = await ctx.write(group.sheet, (await ctx.stampAndEncode(canvas)).bytes);
    };

    const record = async (video) => {
      report(`Recording ${video.label.toLowerCase()}`);
      setRecordingPaused(false);
      try {
        const recorded = await api.recordVideo({
          width: video.width,
          height: video.height,
          fps: video.fps,
          seconds: video.seconds,
          mimeType: videoType.mimeType,
          spin: video.spin,
          direction: video.spin ? TURNTABLE_DIRECTION : LIGHTS_DIRECTION,
          startYaw: TURNTABLE_START_YAW,
          onProgress: (fraction) => report(`Recording ${video.label.toLowerCase()} · ${Math.round(fraction * 100)}%`),
          onPause: setRecordingPaused,
          isCancelled: () => signal.aborted,
        });
        if (!recorded) throw abortError();
        Object.assign(video, { frames: recorded.frames, pauses: recorded.pauses, renderSeconds: recorded.renderSeconds });
        video.saved = await ctx.write(video.file, new Uint8Array(await recorded.blob.arrayBuffer()));
        if (!video.saved) video.error = ctx.writeErrors.at(-1)?.message || "the file couldn't be written";
      } catch (error) {
        if (error?.name === "AbortError" || signal.aborted) throw abortError();
        video.error = errorText(error);
      } finally {
        setRecordingPaused(false);
      }
      done += 1;
    };

    const runLights = (on) => {
      const { els: currentEls, updateVehicleLights: setLights } = latest.current;
      if (!on) {
        setLights({ switches: startSwitches });
        if (startElsPreview && currentEls?.setPreview) currentEls.setPreview(startElsPreview);
        return;
      }
      lightsChanged = true;
      if (planInputs.lights.system === "els" && currentEls?.live) {
        const dialect = currentEls.live.config?.dialect;
        currentEls.setPreview(dialect === "miss-els"
          ? { miss: Object.fromEntries(MISS_PATTERN_KEYS.map((key) => [key, true])) }
          : { stage: 3 });
        setLights({ switches: { ...startSwitches, night: true, headlights: "on" } });
      } else {
        setLights({ switches: { ...startSwitches, sirens: true, night: true, headlights: "on" } });
      }
    };

    setRunning(true);
    setResult(null);
    setLive(null);
    setOpenError("");
    if (gridWasOn) setShowGrid(false);

    let fatal = "";
    try {
      await nextFrames(2);

      for (const item of run.heroes) await shootStill(item, item, poseFor(item.angle), `Hero: ${item.label}`);
      for (const item of run.store) await shootStill(item, item, poseFor(item.angle), `Store ${item.label}`);

      if (run.beforeAfter) {
        const item = run.beforeAfter;
        report("Before and after");
        try {
          const pose = poseFor(item.angle);
          const before = ctx.capture(item, pose, null, { livery: false });
          const after = ctx.capture(item, pose);
          const canvas = await composeBeforeAfter({ before, after, style: item.style, beforeLabel: "Original", afterLabel: "Your livery", detail: modelName });
          item.saved = await ctx.write(item.file, (await ctx.stampAndEncode(canvas)).bytes);
          if (item.saved) await writeThumb(item, canvas);
          else item.error = ctx.writeErrors.at(-1)?.message || "the file couldn't be written";
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          item.error = errorText(error);
        }
        done += 1;
      }

      for (const video of run.videos.filter((entry) => entry.id === "turntable")) await record(video);

      const lightsClip = run.videos.find((entry) => entry.id === "lights");
      if (lightsClip) {
        runLights(true);
        try {
          await nextFrames(4);
          await delay(LIGHTS_SETTLE_MS, signal);
          await record(lightsClip);
        } finally {
          runLights(false);
          lightsChanged = false;
          await nextFrames(2);
        }
      }

      if (run.paints) {
        const entries = [];
        try {
          for (const item of run.paints.items) {
            paintChanged = true;
            await ctx.setPaint(item.paint);
            const kept = await shootStill(item, run.paints, poseFor(run.paints.angle), `Paint: ${item.name}`, { keep: true });
            if (kept) entries.push({ image: kept.image, title: item.name, detail: `Colour ${item.paint}` });
          }
          await writeSheet(run.paints, entries, "paints");
        } finally {
          entries.forEach((entry) => entry.image.close());
          await ctx.setPaint(null);
          paintChanged = false;
        }
      }

      if (run.lineup) {
        const items = run.lineup.items;
        const baseSelection = { ...startSelection };
        delete baseSelection[LIVERY_MOD_SLOT];
        const modelIndex = kits?.modelIndex;
        const frames = [];
        try {
          const signs = items.filter((item) => item.kind === "sign");
          if (signs.length && kit && Number.isInteger(startSelection[LIVERY_MOD_SLOT])) {
            overrideUsed = true;
            await ctx.show(mergeMods([{ resolution: resolveModSelection(kit, baseSelection, modelIndex) }]));
          }
          for (const item of items) {
            report(`Livery: ${item.name}`);
            if (item.kind === "sign") {
              liveryChanged = true;
              latest.current.setGameLivery(item.number);
              const waited = await waitForLivery(item.number, signal);
              if (waited.timedOut) item.timedOut = true;
              else if (waited.error) item.loadError = waited.error.replace(/^Livery \d+ didn't load: /, "");
            } else {
              liveryChanged = true;
              latest.current.setGameLivery(null);
              const resolution = resolveModSelection(kit, { ...baseSelection, [LIVERY_MOD_SLOT]: item.modIndex }, modelIndex);
              const missing = resolution.missing.find((entry) => entry.slotType === LIVERY_MOD_SLOT);
              overrideUsed = true;
              const status = await ctx.show(mergeMods([{ resolution }]));
              const observed = observeParts(status, resolution.parts.filter((part) => part.slotType === LIVERY_MOD_SLOT));
              if (missing) item.loadError = `${missing.modelName}.yft isn't in this resource`;
              else if (status?.timedOut) item.timedOut = true;
              else if (observed.loadErrors.length) item.loadError = observed.loadErrors[0].message;
            }
            if (item.timedOut || item.loadError) {
              done += 1;
              continue;
            }
            await nextFrames(2);
            const kept = await shootStill(item, run.lineup, poseFor(run.lineup.angle), `Livery: ${item.name}`, { keep: true });
            if (kept) frames.push({ item, ...kept });
          }
          if (frames.length > 1) {
            const { width, height } = frames[0].diff;
            const duplicates = findDuplicateShots(frames.map((frame) => ({ id: frame.item.id, pixels: frame.diff.pixels })), width, height);
            const names = liveryDuplicateNames(duplicates, items);
            for (const frame of frames) frame.item.duplicateOf = names.get(frame.item.id) || null;
          }
          await writeSheet(run.lineup, frames.map((frame) => ({ image: frame.image, title: frame.item.name, detail: frame.item.kind === "sign" ? `Livery ${frame.item.number}` : `Livery mod ${frame.item.modIndex}` })), "liveries");
        } finally {
          frames.forEach((frame) => frame.image.close());
          if (liveryChanged) latest.current.setGameLivery(startLivery);
          liveryChanged = false;
          if (overrideUsed) kits?.setShootOverride(null);
          overrideUsed = false;
          await nextFrames(2);
        }
      }

      if (run.kit && kit) {
        const cameraSnapshot = api.getCameraSnapshot();
        const modes = [
          run.kit.parts ? normalizeKitShootSettings({
            mode: "parts",
            camera: "auto",
            base: "stock",
            slots: kit.slots.map((slot) => slot.type).filter((type) => type !== LIVERY_MOD_SLOT),
            format: SHEET_FORMAT,
            beforeAfter: true,
            sheets: true,
            videos: false,
          }) : null,
          run.kit.builds.length ? normalizeKitShootSettings({
            mode: "builds",
            builds: run.kit.builds,
            angles: run.kit.angles,
            paints: [],
            format: SHEET_FORMAT,
            beforeAfter: true,
            sheets: true,
            videos: false,
          }) : null,
        ].filter(Boolean);
        try {
          for (const kitRun of modes) {
            const folder = `${run.kit.folder}/${kitRun.mode}`;
            const kitCtx = ctx.within(folder);
            const kitRecord = emptyKitRecord();
            const size = formatSize(kitRun.format, false);
            const progress = (current, total, label) => report(`Mod kit ${kitRun.mode === "parts" ? "parts" : "builds"} ${current}/${total}${label ? `: ${label}` : ""}`);
            let kitFatal = "";
            overrideUsed = true;
            try {
              const options = { kit, kits, modelIndex: kits.modelIndex, modelName, run: kitRun, size, videoSize: size, videoType: null, cameraSnapshot, startSelection, progress, record: kitRecord };
              if (kitRun.mode === "parts") await shootParts(kitCtx, options);
              else await shootBuilds(kitCtx, options);
            } catch (error) {
              if (error?.name === "AbortError") throw error;
              kitFatal = errorText(error);
            } finally {
              kitRuns.push({ folder, kitCtx, kitRecord, kitRun, size, kitFatal, failedWrites: ctx.writeErrors.filter((entry) => entry.path.startsWith(`${folder}/`)) });
            }
          }
        } finally {
          kits?.setShootOverride(null);
          overrideUsed = false;
        }
        done += 1;
      }
    } catch (error) {
      if (error?.name !== "AbortError") fatal = errorText(error);
    } finally {
      if (overrideUsed) kits?.setShootOverride(null);
      if (liveryChanged) latest.current.setGameLivery(startLivery);
      if (paintChanged) {
        setBodyColor(originalPaint.bodyColor);
        setVehiclePaint(originalPaint.vehiclePaint);
      }
      if (lightsChanged) runLights(false);
      if (gridWasOn) setShowGrid(true);
    }

    const cancelled = signal.aborted;
    const kitSummary = [];
    for (const entry of kitRuns) {
      const written = await writeKitShootRecord(entry.kitCtx, {
        record: entry.kitRecord,
        kit,
        kits,
        modelName,
        run: entry.kitRun,
        size: entry.size,
        startSelection,
        createdAt,
        cancelled,
        fatal: entry.kitFatal,
        nativeMaterialsEnabled,
        failedWrites: entry.failedWrites,
      });
      kitSummary.push({
        mode: entry.kitRun.mode,
        folder: entry.folder,
        manifest: written.manifestSaved ? `${entry.folder}/kit-shoot.json` : null,
        report: written.reportSaved ? `${entry.folder}/report.html` : null,
        shots: written.shotsSaved,
        fatal: entry.kitFatal || null,
      });
      for (const issue of written.issues) extraIssues.push({ ...issue, scope: "kit", message: `Mod kit: ${issue.message}` });
    }

    if (!nativeMaterialsEnabled) {
      extraIssues.push(listingIssue("UNTEXTURED", "The model's own textures were off, so the vehicle was shot without its game textures and liveries."));
    }
    if (run.lineup && texturePath && textureTarget === "all") {
      extraIssues.push(listingIssue("LIVERY_COVERED", "Your loaded texture covers every mesh, so the game liveries in the lineup may not show."));
    }
    const itemFiles = new Set([
      ...run.heroes, ...run.store, ...(run.beforeAfter ? [run.beforeAfter] : []),
      ...(run.lineup?.items || []), ...(run.paints?.items || []), ...run.videos,
    ].map((item) => item.file));
    const otherWrites = ctx.writeErrors.filter((entry) => !itemFiles.has(entry.path) && !entry.path.startsWith(`${run.kit?.folder || "kit"}/`));
    const failedWrites = [...ctx.writeErrors];
    const issues = [
      ...collectListingIssues(run),
      ...extraIssues,
      ...otherWrites.map((entry) => listingIssue("CAPTURE_FAILED", `${entry.path} wasn't written: ${entry.message}`)),
    ];
    const complete = !cancelled && !fatal && failedWrites.length === 0;
    let doctorTimer = 0;
    const packDoctor = listingDoctorRecord(await Promise.race([
      doctorRun,
      new Promise((resolve) => {
        doctorTimer = setTimeout(() => resolve({ status: "not-run", reason: "Pack Doctor was still checking when the shoot ended." }), cancelled ? 0 : DOCTOR_WAIT_MS);
      }),
    ]));
    clearTimeout(doctorTimer);
    const manifest = buildListingManifest({
      createdAt: createdAt.toISOString(),
      appVersion: appMeta.version,
      modelName,
      plan: run,
      complete,
      kit: kitSummary.length ? { name: kit.kitName, runs: kitSummary } : null,
      issues,
      packDoctor,
    });
    const filesBefore = ctx.saved;
    const encoder = new TextEncoder();
    const manifestSaved = filesBefore > 0 && await ctx.write("listing.json", encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`));
    const reportSaved = filesBefore > 0 && await ctx.write("report.html", encoder.encode(renderListingReport(manifest)));

    const made = [
      ...run.heroes, ...run.store, ...(run.beforeAfter ? [run.beforeAfter] : []),
      ...(run.lineup?.items || []), ...(run.paints?.items || []), ...run.videos,
    ];
    const summary = describePreviewRun({
      total: made.length,
      written: made.filter((item) => item.saved).length,
      skipped: made.filter((item) => !item.saved && !cancelled).map((item) => item.label || item.name),
      error: fatal,
    });
    controllerRef.current = null;
    setRunning(false);
    setProgress(IDLE_PROGRESS);
    setLive(null);
    setResult({
      folder: filesBefore > 0 ? root : "",
      summary,
      stills: made.filter((item) => item.saved && !item.fps).length,
      videos: run.videos.filter((video) => video.saved).length,
      kitShots: kitSummary.reduce((sum, entry) => sum + entry.shots, 0),
      thumbs: made.filter((item) => item.thumb).slice(0, 4).map((item) => ({ id: item.id, path: item.thumb, label: item.label || item.name })),
      failed: failedWrites.length,
      firstError: failedWrites[0]?.message || "",
      fatal,
      cancelled,
      issues,
      manifestSaved,
      reportSaved,
    });
  }, [
    running, blocked, viewerApiRef, isTauriRuntime, viewerReady, planInputs, settings, ensureFolder, modelPath, showGrid,
    watermark, setBodyColor, setVehiclePaint, setShowGrid, videoType, waitForLivery, nativeMaterialsEnabled, texturePath, textureTarget,
  ]);

  const openResultFolder = useCallback(async () => {
    if (!result?.folder) return;
    setOpenError("");
    try {
      if (!(await openFolderPath(result.folder))) setOpenError("Windows couldn't open the folder. The files are still there.");
    } catch {
      setOpenError("Windows couldn't open the folder. The files are still there.");
    }
  }, [result]);

  const dismissResult = useCallback(() => {
    setResult(null);
    setOpenError("");
  }, []);

  return {
    settings,
    update,
    plan,
    lights,
    heroSizeFixed: Boolean(heroSize),
    videoSupported: Boolean(videoType),
    running,
    progress,
    live,
    recordingPaused,
    result,
    openError,
    start,
    cancel,
    handleModsStatus,
    openResultFolder,
    dismissResult,
  };
}
