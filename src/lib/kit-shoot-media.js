// Canvas work for Kit Shoot output: before/after pairs, labelled slot sheets,
// and cycle videos, all composed from frames the viewer already rendered so
// the scene is never re-rendered for them. Browser only.

import { changeCrop, wipeSplit } from "./kit-shoot.js";
import { contactSheetLayout, sheetCellSize } from "./eup-export.js";

// Output images use the Cortex paper and ink, not the app theme, so they look
// the same whichever theme the user exported from.
const INK = "#0f1012";
const PAPER = "#f0f0e9";
const MUTED = "#a2a6ad";
const DISPLAY_FONT = '"Barlow Condensed", "Arial Narrow", sans-serif';
const MAIN_FONT = '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';

/** Diff frames are this wide; enough to find a part, cheap to compare. */
export const DIFF_WIDTH = 192;

let fontsReady = null;
function ensureFonts() {
  if (!fontsReady) {
    fontsReady = typeof document !== "undefined" && document.fonts?.load
      ? Promise.all([
          document.fonts.load(`italic 800 32px ${DISPLAY_FONT}`),
          document.fonts.load(`600 16px ${MAIN_FONT}`),
        ]).catch(() => null)
      : Promise.resolve();
  }
  return fontsReady;
}

function makeCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

export async function canvasToPngBytes(canvas) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("The image couldn't be encoded as PNG");
  return { blob, bytes: new Uint8Array(await blob.arrayBuffer()) };
}

/** RGBA pixels of a frame scaled to `width`, for change and duplicate checks. */
export function diffPixels(source, width = DIFF_WIDTH) {
  const height = Math.max(1, Math.round((source.height / source.width) * width));
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, width, height);
  return { pixels: ctx.getImageData(0, 0, width, height).data, width, height };
}

/** A JPEG data URL of a frame scaled down to `width`, for previews. */
export function canvasToJpegDataUrl(source, width) {
  const scale = Math.min(1, width / source.width);
  const canvas = makeCanvas(source.width * scale, source.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.86);
}

/** Maps a box in diff pixels to a frame of `width` x `height`. */
export function scaleDiffBox(box, diffWidth, width) {
  if (!box) return null;
  const scale = width / diffWidth;
  return { x: box.x * scale, y: box.y * scale, width: box.width * scale, height: box.height * scale };
}

// A label slip in the corner of a frame: display caps for the name, plain text
// for the detail. Sized from the frame so it reads the same at every format.
function drawSlip(ctx, { x, y, title, detail = "", scale, align = "left" }) {
  const padX = 14 * scale;
  const padY = 10 * scale;
  const titleSize = 30 * scale;
  const detailSize = 14 * scale;
  ctx.save();
  ctx.font = `italic 800 ${titleSize}px ${DISPLAY_FONT}`;
  const titleText = String(title || "").toUpperCase();
  const titleWidth = ctx.measureText(titleText).width;
  ctx.font = `600 ${detailSize}px ${MAIN_FONT}`;
  const detailWidth = detail ? ctx.measureText(detail).width : 0;
  const width = Math.max(titleWidth, detailWidth) + padX * 2;
  const height = padY * 2 + titleSize * 0.95 + (detail ? detailSize * 1.35 : 0);
  const left = align === "right" ? x - width : x;
  ctx.fillStyle = INK;
  ctx.globalAlpha = 0.86;
  ctx.beginPath();
  ctx.roundRect(left, y, width, height, 7 * scale);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.textBaseline = "top";
  ctx.fillStyle = PAPER;
  ctx.font = `italic 800 ${titleSize}px ${DISPLAY_FONT}`;
  ctx.fillText(titleText, left + padX, y + padY);
  if (detail) {
    ctx.fillStyle = MUTED;
    ctx.font = `600 ${detailSize}px ${MAIN_FONT}`;
    ctx.fillText(detail, left + padX, y + padY + titleSize * 0.95 + detailSize * 0.2);
  }
  ctx.restore();
}

function frameScale(width, height) {
  return Math.max(0.6, Math.min(width, height) / 1080);
}

/**
 * A before/after image. `side` puts the two frames next to each other (twice
 * as wide as a shot); `wipe` keeps the shot size and divides it through the
 * change. With `zoom`, both frames are cropped to the change first.
 */
export async function composeBeforeAfter({ before, after, style = "side", box = null, zoom = false, beforeLabel = "Before", afterLabel = "After", detail = "" }) {
  await ensureFonts();
  const width = after.width;
  const height = after.height;
  const crop = zoom && box ? changeCrop({ box, width, height }) : { x: 0, y: 0, width, height };
  const scale = frameScale(width, height);
  const margin = 24 * scale;

  if (style === "wipe") {
    const canvas = makeCanvas(width, height);
    const ctx = canvas.getContext("2d");
    const cropBox = box && zoom
      ? { x: ((box.x - crop.x) / crop.width) * width, width: (box.width / crop.width) * width }
      : box;
    const split = wipeSplit(cropBox, width);
    ctx.drawImage(after, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, split, height);
    ctx.clip();
    ctx.drawImage(before, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
    ctx.restore();
    ctx.fillStyle = PAPER;
    ctx.fillRect(split - 1.5 * scale, 0, 3 * scale, height);
    drawSlip(ctx, { x: margin, y: margin, title: beforeLabel, scale });
    drawSlip(ctx, { x: width - margin, y: margin, title: afterLabel, detail, scale, align: "right" });
    return canvas;
  }

  const gap = Math.round(6 * scale);
  const canvas = makeCanvas(width * 2 + gap, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(before, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
  ctx.drawImage(after, crop.x, crop.y, crop.width, crop.height, width + gap, 0, width, height);
  drawSlip(ctx, { x: margin, y: margin, title: beforeLabel, scale });
  drawSlip(ctx, { x: width + gap + margin, y: margin, title: afterLabel, detail, scale });
  return canvas;
}

/**
 * A labelled grid of frames. Cells keep the export format's proportions and
 * the sheet stays under 4096 px, like EUP colourway sheets.
 */
export async function composeSheet({ items, format, title = "", labels = true }) {
  await ensureFonts();
  const cell = sheetCellSize(format, items.length);
  const layout = contactSheetLayout(items.length, cell.width, cell.height);
  const scale = frameScale(cell.width, cell.height);
  const header = title ? Math.round(64 * scale) : 0;
  const canvas = makeCanvas(layout.width, layout.height + header);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (title) {
    ctx.fillStyle = INK;
    ctx.textBaseline = "middle";
    ctx.font = `italic 800 ${Math.round(40 * scale)}px ${DISPLAY_FONT}`;
    ctx.fillText(title.toUpperCase(), 20 * scale, header / 2);
  }
  items.forEach((item, index) => {
    const { x, y } = layout.cells[index];
    ctx.drawImage(item.image, 0, 0, item.image.width, item.image.height, x, y + header, cell.width, cell.height);
    if (labels) drawSlip(ctx, { x: x + 12 * scale, y: y + header + cell.height - 12 * scale - 74 * scale, title: item.title, detail: item.detail, scale });
  });
  return canvas;
}

/**
 * Plays frames in order with a short crossfade and records them as a video.
 * Real time: about `secondsPer` per frame. Returns null when cancelled.
 */
export async function recordCycleVideo({ items, width, height, mimeType, secondsPer = 1.3, fade = 0.25, fps = 30, isCancelled }) {
  await ensureFonts();
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const scale = frameScale(width, height);
  const margin = 28 * scale;
  const draw = (index, alpha) => {
    const item = items[index];
    ctx.globalAlpha = alpha;
    ctx.drawImage(item.image, 0, 0, width, height);
    ctx.globalAlpha = 1;
  };
  const stream = canvas.captureStream(fps);
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: Math.round(width * height * fps * 0.25) });
  const chunks = [];
  let recorderError = null;
  recorder.ondataavailable = (event) => {
    if (event.data?.size) chunks.push(event.data);
  };
  recorder.onerror = (event) => {
    recorderError = event.error || new Error("The recorder failed");
  };
  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve;
  });
  let cancelled = false;
  try {
    draw(0, 1);
    recorder.start(250);
    const total = items.length * secondsPer;
    // A timer, not animation frames, drives playback: frames pause in a
    // minimised window and the recording would never end.
    await new Promise((resolve) => {
      const start = performance.now();
      const step = () => {
        const elapsed = (performance.now() - start) / 1000;
        const index = Math.min(items.length - 1, Math.floor(elapsed / secondsPer));
        const into = elapsed - index * secondsPer;
        draw(index, 1);
        const next = index + 1;
        if (next < items.length && into > secondsPer - fade) draw(next, (into - (secondsPer - fade)) / fade);
        const shown = next < items.length && into > secondsPer - fade / 2 ? next : index;
        drawSlip(ctx, { x: margin, y: height - margin - 80 * scale, title: items[shown].title, detail: items[shown].detail, scale });
        if (isCancelled?.()) cancelled = true;
        if (cancelled || recorderError || elapsed >= total) {
          resolve();
          return;
        }
        setTimeout(step, 1000 / fps);
      };
      step();
    });
  } finally {
    if (recorder.state !== "inactive") recorder.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
  }
  if (cancelled) return null;
  if (recorderError) throw recorderError;
  const blob = new Blob(chunks, { type: mimeType });
  if (blob.size === 0) throw new Error("The recorder produced no video data");
  return blob;
}
