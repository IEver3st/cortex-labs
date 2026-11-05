import { invoke } from "@tauri-apps/api/core";
import { writeFile } from "@tauri-apps/plugin-fs";
import appMeta from "../../../package.json";
import { pickVideoType } from "../../lib/eup-export.js";
import { resolveModSelection } from "../../lib/vehicle-modkits.js";
import {
  BUILD_ANGLES,
  CURRENT_BUILD,
  buildKitShootManifest,
  collectShotIssues,
  diffImages,
  findDuplicateShots,
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

export const SETTLE_TIMEOUT_MS = 90_000;
export const PRELOAD_BATCH = 4;
export const PROBE_WIDTH = 256;
export const DIFF_FINAL = 384;
export const THUMB_WIDTH = 480;
export const NO_MODS = Object.freeze({ parts: [], hiddenBones: [] });
export const IDLE_PROGRESS = Object.freeze({ current: 0, total: 0, label: "" });

const INTERIOR_SLOT = /^VMT_(INTERIOR\d|SEATS|STEERING|KNOB|PLAQUE|ICE)$/;

export function supportedVideoType() {
  if (typeof MediaRecorder === "undefined" || typeof HTMLCanvasElement === "undefined") return null;
  if (typeof HTMLCanvasElement.prototype.captureStream !== "function") return null;
  return pickVideoType((type) => MediaRecorder.isTypeSupported(type));
}

export function abortError(message = "The shoot was cancelled") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function nextFrames(count = 2) {
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

export function timestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function roundCrop(crop) {
  return Object.fromEntries(Object.entries(crop).map(([key, value]) => [key, Number(value.toFixed(4))]));
}

export function dataUrlBytes(dataUrl) {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function mergeMods(entries, extraBones = []) {
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

export function observeParts(status, parts) {
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

export function createModsStatusChannel() {
  const waiters = new Set();
  const channel = {
    status: null,
    sequence: 0,
    publish(status) {
      channel.status = status;
      for (const waiter of [...waiters]) waiter(status);
    },
    waitForSettled(requestId, signal, timeoutMs = SETTLE_TIMEOUT_MS) {
      return new Promise((resolve, reject) => {
        const done = (value, error) => {
          clearTimeout(timer);
          waiters.delete(check);
          signal.removeEventListener("abort", onAbort);
          if (error) reject(error);
          else resolve(value);
        };
        const check = (status) => {
          if (status?.requestId === requestId && status.settled) done(status);
        };
        const onAbort = () => done(null, abortError());
        const timer = setTimeout(() => done({ ...(channel.status || {}), timedOut: true }), timeoutMs);
        waiters.add(check);
        signal.addEventListener("abort", onAbort);
        check(channel.status);
      });
    },
  };
  return channel;
}

export function createShootRun({
  api,
  root,
  signal,
  watermark,
  modsChannel,
  setShootOverride,
  requestPrefix,
  setBodyColor,
  setVehiclePaint,
  originalPaint,
  onLive,
}) {
  const stamp = hasDrawableWatermark(watermark);
  const madeDirs = new Set();
  const writeErrors = [];
  let saved = 0;

  const writeAt = async (prefix, relativePath, bytes) => {
    const shown = prefix ? `${prefix}/${relativePath}` : relativePath;
    const fullPath = `${root}/${shown}`;
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
      writeErrors.push({ path: shown, message: String(error?.message || error) });
      return false;
    }
  };

  const make = (prefix) => {
    const write = (relativePath, bytes) => writeAt(prefix, relativePath, bytes);
    const stampAndEncode = async (canvas) => {
      if (stamp) await drawWatermark(canvas.getContext("2d"), canvas.width, canvas.height, watermark);
      return canvasToPngBytes(canvas);
    };
    const ensureLive = () => {
      if (signal.aborted) throw abortError();
    };
    const show = async (mods) => {
      ensureLive();
      modsChannel.sequence += 1;
      const requestId = `${requestPrefix}-${modsChannel.sequence}`;
      setShootOverride({ ...mods, requestId });
      const status = await modsChannel.waitForSettled(requestId, signal);
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
    const capture = (size, pose, crop = null, options = {}) => {
      ensureLive();
      const [canvas] = api.captureShots({ width: size.width, height: size.height, shots: [{ pose, crop }], ...options });
      if (!canvas) throw new Error("the viewer returned no image");
      return canvas;
    };
    const probe = (probeSize, poses) => {
      ensureLive();
      const canvases = api.captureShots({ ...probeSize, shots: poses.map((pose) => ({ pose })) });
      return canvases.map((canvas) => (canvas ? diffPixels(canvas, probeSize.width).pixels : null));
    };
    const saveShot = async (shot, canvas, label) => {
      const encoded = await stampAndEncode(canvas);
      shot.saved = await write(shot.file, encoded.bytes);
      if (!shot.saved) {
        shot.captureError = writeErrors.at(-1)?.message || "the file couldn't be written";
        return encoded;
      }
      shot.bytes = encoded.bytes.length;
      const thumb = canvasToJpegDataUrl(canvas, THUMB_WIDTH);
      if (await write(thumbPath(shot.file), dataUrlBytes(thumb))) shot.thumb = thumbPath(shot.file);
      onLive?.({ url: thumb, label });
      return encoded;
    };
    return {
      root: prefix ? `${root}/${prefix}` : root,
      prefix,
      signal,
      api,
      stamp,
      write,
      stampAndEncode,
      ensureLive,
      show,
      setPaint,
      capture,
      probe,
      saveShot,
      writeErrors,
      get saved() {
        return saved;
      },
      within: (folder) => make(prefix ? `${prefix}/${folder}` : folder),
    };
  };
  return make("");
}

export async function shootParts(ctx, { kit, modelIndex, modelName, run, size, videoSize, videoType, cameraSnapshot, startSelection, progress, record }) {
  const { api, signal } = ctx;
  const base = run.base === "build" ? startSelection : {};
  const partsPlan = planPartsShoot({ kit, base, slotTypes: run.slots });
  record.partsPlan = partsPlan;
  const probeSize = { width: PROBE_WIDTH, height: Math.round((size.height / size.width) * PROBE_WIDTH) };
  let done = 0;
  progress(0, partsPlan.shotCount, "");
  for (const slot of partsPlan.slots) {
    const shots = slot.shots;
    for (const shot of shots) {
      shot.resolution = resolveModSelection(kit, shot.selection, modelIndex);
      shot.missing = shot.resolution.missing.filter((entry) => entry.slotType === slot.type).map((entry) => entry.modelName);
      shot.slotParts = shot.resolution.parts.filter((part) => part.slotType === slot.type);
    }
    slot.baseName = shots[0].name;
    const reveal = run.camera === "auto" ? revealBonesForSlot(slot.type) : [];
    progress(done, partsPlan.shotCount, `Loading ${slot.displayName}`);
    for (let loaded = 1; loaded === 1 || loaded < shots.length; loaded += PRELOAD_BATCH) {
      await ctx.show(mergeMods([
        { resolution: shots[0].resolution },
        ...shots.slice(1, loaded + PRELOAD_BATCH).map((shot) => ({ resolution: shot.resolution, hidden: true })),
      ], reveal));
    }
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
      const results = candidates.map(() => []);
      let baseProbe = null;
      for (let index = 0; index < shots.length; index += 1) {
        progress(done, partsPlan.shotCount, `Finding the angle: ${slot.displayName} ${index + 1}/${shots.length}`);
        await ctx.show(stateFor(index));
        const probed = ctx.probe(probeSize, poses);
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
        pose = INTERIOR_SLOT.test(slot.type)
          ? cabin
          : { type: "focus", ...planFocusShot({ slotType: slot.type, focus: measured.focus, vehicle: measured.vehicle }) };
        slot.camera = { type: "auto", angle: "fallback", crop: null };
      }
    }

    const frames = [];
    for (let index = 0; index < shots.length; index += 1) {
      const shot = shots[index];
      progress(done, partsPlan.shotCount, `${slot.displayName}: ${shot.name}`);
      const status = await ctx.show(stateFor(index));
      Object.assign(shot, observeParts(status, shot.slotParts), {
        hiddenMeshCount: status?.hiddenMeshCount ?? 0,
        boneDataAvailable: Boolean(status?.boneDataAvailable),
      });
      try {
        const canvas = ctx.capture(size, pose, crop);
        const diff = diffPixels(canvas, DIFF_FINAL);
        const raw = ctx.stamp ? (await canvasToPngBytes(canvas)).blob : null;
        const encoded = await ctx.saveShot(shot, canvas, `${slot.displayName}: ${shot.name}`);
        frames.push({ shot, blob: raw || encoded.blob, diff });
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        shot.captureError = String(error?.message || error);
      }
      done += 1;
    }

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
          progress(done, partsPlan.shotCount, `Before and after: ${frame.shot.name}`);
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
          if (await ctx.write(path, (await ctx.stampAndEncode(canvas)).bytes)) frame.shot.beforeAfter = path;
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
        progress(done, partsPlan.shotCount, `Sheet: ${slot.displayName}`);
        const canvas = await composeSheet({ items, format: run.format, title: `${modelName} · ${slot.displayName}` });
        const path = `sheets/${slot.folder}.png`;
        if (await ctx.write(path, (await ctx.stampAndEncode(canvas)).bytes)) slot.sheet = path;
      }
      if (run.videos && videoType && items.length > 1) {
        progress(done, partsPlan.shotCount, `Recording ${slot.displayName}`);
        const blob = await recordCycleVideo({
          items,
          width: videoSize.width,
          height: videoSize.height,
          mimeType: videoType.mimeType,
          isCancelled: () => signal.aborted,
        });
        if (blob) {
          const path = `videos/${slot.folder}.${videoType.extension}`;
          if (await ctx.write(path, new Uint8Array(await blob.arrayBuffer()))) slot.video = path;
        }
      }
    } finally {
      bitmaps.forEach((bitmap) => bitmap.close());
    }
    progress(done, partsPlan.shotCount, "");
  }
  return partsPlan;
}

export async function shootBuilds(ctx, { kit, kits, modelIndex, modelName, run, size, videoSize, videoType, cameraSnapshot, startSelection, progress, record }) {
  const { api, signal } = ctx;
  const chosen = [];
  for (const name of run.builds) {
    if (name === CURRENT_BUILD) chosen.push({ name: "Current build", mods: startSelection });
    else {
      const build = kits.builds.find((entry) => entry.name === name);
      if (build) chosen.push(build);
    }
  }
  const buildsPlan = planBuildsShoot({ kit, builds: chosen, angles: run.angles, paints: run.paints, stockBefore: run.beforeAfter });
  record.buildsPlan = buildsPlan;
  chosen.forEach((build, index) => {
    const kept = Object.keys(buildsPlan.builds[index].selection).length;
    const asked = Object.keys(build.mods || {}).length;
    if (kept < asked) {
      record.extraIssues.push({ code: "BUILD_PARTS_DROPPED", severity: "warning", message: `${build.name}: ${asked - kept} saved part${asked - kept === 1 ? " isn't" : "s aren't"} in ${kit.kitName} and ${asked - kept === 1 ? "was" : "were"} left stock.` });
    }
  });
  const measured = api.measureVehicleMods({});
  const poseFor = (angleId) => {
    const angle = BUILD_ANGLES.find((entry) => entry.id === angleId);
    return angle.id === "view" || !measured
      ? { type: "view", camera: cameraSnapshot }
      : { type: "focus", box: measured.vehicle, direction: angle.direction };
  };
  const angleLabel = (id) => BUILD_ANGLES.find((entry) => entry.id === id).label;
  const shotKey = (shot) => `${shot.angle}|${shot.paint ?? ""}`;
  let done = 0;
  progress(0, buildsPlan.shotCount, "");
  const shootList = async (list, label, keep) => {
    let paint;
    for (const shot of list) {
      if (shot.paint !== paint) {
        paint = shot.paint;
        await ctx.setPaint(paint);
      }
      progress(done, buildsPlan.shotCount, `${label}: ${angleLabel(shot.angle)}`);
      try {
        const canvas = ctx.capture(size, poseFor(shot.angle));
        const diff = keep ? diffPixels(canvas, DIFF_FINAL) : null;
        const raw = ctx.stamp && keep ? (await canvasToPngBytes(canvas)).blob : null;
        const encoded = await ctx.saveShot(shot, canvas, `${label}: ${angleLabel(shot.angle)}`);
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
    await ctx.show(NO_MODS);
    await shootList(buildsPlan.stock, "Stock", stockFrames);
  }
  const firstFrames = [];
  for (const build of buildsPlan.builds) {
    const resolution = resolveModSelection(kit, build.selection, modelIndex);
    for (const entry of resolution.missing) {
      record.extraIssues.push({ code: "MODEL_MISSING", severity: "error", slotType: entry.slotType, message: `${build.name} uses ${entry.modelName}.yft, which isn't in this resource.` });
    }
    const status = await ctx.show(mergeMods([{ resolution }]));
    const observed = observeParts(status, resolution.parts);
    for (const error of observed.loadErrors) {
      record.extraIssues.push({ code: "LOAD_FAILED", severity: "error", message: `${build.name}: ${error.modelName} didn't load (${error.message}).` });
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
        if (await ctx.write(path, (await ctx.stampAndEncode(canvas)).bytes)) shot.beforeAfter = path;
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
        if (await ctx.write("sheets/builds.png", (await ctx.stampAndEncode(canvas)).bytes)) record.sheets.push("sheets/builds.png");
      }
      if (run.videos && videoType) {
        progress(done, buildsPlan.shotCount, "Recording builds");
        const blob = await recordCycleVideo({ items, width: videoSize.width, height: videoSize.height, mimeType: videoType.mimeType, isCancelled: () => signal.aborted });
        const path = `videos/builds.${videoType.extension}`;
        if (blob && await ctx.write(path, new Uint8Array(await blob.arrayBuffer()))) buildsPlan.video = path;
      }
    } finally {
      items.forEach((item) => item.image.close());
    }
  }
  return buildsPlan;
}

export function emptyKitRecord() {
  return { partsPlan: null, buildsPlan: null, sheets: [], extraIssues: [] };
}

export async function writeKitShootRecord(ctx, { record, kit, kits, modelName, run, size, startSelection, createdAt, cancelled, fatal, nativeMaterialsEnabled, failedWrites }) {
  const { partsPlan, buildsPlan, sheets, extraIssues } = record;
  const issues = [
    ...collectShotIssues({
      kit,
      slots: partsPlan?.slots || [],
      camera: run.camera,
      namesAvailable: (kits.nameSources || []).length > 0,
    }),
    ...extraIssues,
    ...failedWrites.map((entry) => ({ code: "CAPTURE_FAILED", severity: "error", message: `${entry.path} wasn't written: ${entry.message}` })),
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
    complete: !cancelled && !fatal && failedWrites.length === 0,
    base: run.mode === "parts" && run.base === "build" ? startSelection : {},
    parts: partsPlan?.slots || null,
    builds: buildsPlan ? [...buildsPlan.stock.length ? [{ name: "Stock", selection: {}, shots: buildsPlan.stock }] : [], ...buildsPlan.builds] : null,
    sheets,
    videos: buildsPlan?.video ? [buildsPlan.video] : [],
    issues,
  });
  const allShots = [
    ...(partsPlan?.slots || []).flatMap((slot) => slot.shots),
    ...(buildsPlan ? [...buildsPlan.stock, ...buildsPlan.builds.flatMap((build) => build.shots)] : []),
  ];
  const shotsSaved = allShots.filter((shot) => shot.saved).length;
  const filesBefore = ctx.saved;
  const encoder = new TextEncoder();
  const manifestSaved = filesBefore > 0 && await ctx.write("kit-shoot.json", encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`));
  const reportSaved = filesBefore > 0 && await ctx.write("report.html", encoder.encode(renderKitShootReport(manifest)));
  return { manifest, issues, shotsSaved, filesBefore, manifestSaved, reportSaved };
}
