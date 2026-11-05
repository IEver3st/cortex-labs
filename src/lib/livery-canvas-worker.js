import { initializeCanvas, writePsdUint8Array } from "ag-psd";
import { decodeImageFile } from "./livery-decode.js";
import { canvasFontFamily, canvasFontKey } from "./livery-canvas.js";
import {
  buildCanvasIslands,
  findCounterpart,
  islandFrame,
  islandAtSheetPoint,
  islandSheetBounds,
  islandSheetTriangles,
  markTwinIslands,
} from "./livery-canvas-geometry.js";
import { patternSecondaryPolygons, shapePolygons } from "./livery-canvas-shapes.js";
import { dilateMaskEuclidean, rasterizeCoverageMask } from "./template-overlay.js";

initializeCanvas(
  (width, height) => new OffscreenCanvas(width, height),
  (width, height) => new ImageData(width, height),
);

const MASK_BLEED_PX = 5;
const MASK_PAD_PX = 8;
const STATS_SIDE = 256;
const MAX_MASKS = 96;
const MAX_BASE_SIDE = 8192;

const models = new Map();
const sources = new Map();
const fonts = new Map();
const masks = new Map();
let base = { key: "", bitmap: null, width: 0, height: 0 };

function reply(id, data, transfer = []) {
  self.postMessage({ id, ...data }, transfer);
}

function buildModel(modelKey, meshes) {
  const built = [];
  const problems = [];
  for (const mesh of meshes || []) {
    try {
      built.push({ data: mesh, model: buildCanvasIslands(mesh) });
    } catch (error) {
      problems.push(String(error?.message || error));
    }
  }
  markTwinIslands(built.map((entry) => entry.model));
  masks.clear();
  models.clear();
  models.set(modelKey, built);
  return {
    problems,
    meshes: built.map(({ model }) => ({
      key: model.key,
      faceToIsland: model.faceToIsland.slice(),
      islands: model.islands.map(({ triangles, ...island }) => island),
    })),
  };
}

function islandMask(modelKey, meshKey, islandIndex, width, height) {
  const cacheKey = `${modelKey}|${meshKey}|${islandIndex}|${width}x${height}`;
  const cached = masks.get(cacheKey);
  if (cached) return cached;
  const entry = (models.get(modelKey) || []).find((candidate) => candidate.model.key === meshKey);
  if (!entry) return null;
  const bounds = islandSheetBounds(entry.model, islandIndex, width, height, MASK_PAD_PX);
  if (!bounds) return null;
  const triangles = islandSheetTriangles(entry.model, islandIndex, width, height, bounds.x, bounds.y);
  const coverage = rasterizeCoverageMask(triangles, bounds.width, bounds.height);
  const dilated = dilateMaskEuclidean(coverage, bounds.width, bounds.height, MASK_BLEED_PX);
  const image = new ImageData(bounds.width, bounds.height);
  for (let i = 0, p = 3; i < dilated.length; i += 1, p += 4) image.data[p] = dilated[i] ? 255 : 0;
  const canvas = new OffscreenCanvas(bounds.width, bounds.height);
  canvas.getContext("2d").putImageData(image, 0, 0);
  const mask = { canvas, ...bounds };
  if (masks.size >= MAX_MASKS) masks.delete(masks.keys().next().value);
  masks.set(cacheKey, mask);
  return mask;
}

async function ensureFont(font) {
  const key = canvasFontKey(font.font);
  if (fonts.get(key) === "ready") return true;
  if (!font.url && !font.bytes) return false;
  const descriptors = font.font.path ? {} : { weight: String(font.font.weight || 400), style: font.font.style || "normal" };
  const face = new FontFace(canvasFontFamily(font.font), font.bytes ? font.bytes : `url(${font.url})`, descriptors);
  await face.load();
  self.fonts.add(face);
  fonts.set(key, "ready");
  return true;
}

function missingFor(request) {
  const missing = { model: false, base: false, sources: [], fonts: [] };
  if (request.modelKey && !models.has(request.modelKey)) missing.model = true;
  if (request.baseKey && base.key !== request.baseKey) missing.base = true;
  for (const item of request.items || []) {
    if (item.kind === "image" && !sources.has(item.sourceKey)) missing.sources.push(item.sourceKey);
    if (item.kind === "text" && fonts.get(canvasFontKey(item.source.font)) !== "ready") missing.fonts.push(canvasFontKey(item.source.font));
  }
  missing.sources = [...new Set(missing.sources)];
  missing.fonts = [...new Set(missing.fonts)];
  const any = missing.model || missing.base || missing.sources.length || missing.fonts.length;
  return any ? missing : null;
}

function itemBox(item, width, height) {
  const t = item.uvTransform;
  return { cx: t.u * width, cy: t.v * height, w: t.width * width, h: t.height * height, rotation: t.rotation, flipX: t.flipX };
}

function tracePolygons(context, polygons) {
  context.beginPath();
  for (const polygon of polygons) {
    polygon.forEach(([x, y], index) => (index ? context.lineTo(x, y) : context.moveTo(x, y)));
    context.closePath();
  }
}

function drawText(context, source, w, h) {
  const family = canvasFontFamily(source.font);
  const style = source.font.path ? "normal" : source.font.style || "normal";
  const weight = source.font.path ? 400 : source.font.weight || 400;
  const probe = 100;
  context.font = `${style} ${weight} ${probe}px "${family}"`;
  context.letterSpacing = `${(source.letterSpacing || 0) * probe}px`;
  const metrics = context.measureText(source.text);
  const textWidth = Math.max(1, metrics.width);
  const ascent = metrics.actualBoundingBoxAscent || probe * 0.75;
  const descent = metrics.actualBoundingBoxDescent || probe * 0.2;
  const textHeight = Math.max(1, ascent + descent);
  const fit = Math.min(w / textWidth, h / textHeight);
  context.scale(fit, fit);
  context.fillStyle = source.color;
  context.textAlign = "center";
  context.textBaseline = "alphabetic";
  context.fillText(source.text, 0, (ascent - descent) / 2);
}

function drawItemBody(context, item, box) {
  context.save();
  context.translate(box.cx, box.cy);
  context.rotate(box.rotation);
  if (box.flipX) context.scale(-1, 1);
  if (item.kind === "image") {
    const bitmap = sources.get(item.sourceKey);
    if (bitmap) context.drawImage(bitmap, -box.w / 2, -box.h / 2, box.w, box.h);
  } else if (item.kind === "text") {
    drawText(context, item.source, box.w, box.h);
  } else {
    const { shape, params, color, color2 } = item.source;
    tracePolygons(context, shapePolygons(shape, params, box.w, box.h));
    context.fillStyle = color;
    context.fill(shape === "outline" ? "evenodd" : "nonzero");
    if (color2) {
      tracePolygons(context, patternSecondaryPolygons(shape, params, box.w, box.h));
      context.fillStyle = color2;
      context.fill();
    }
  }
  context.restore();
}

function itemMask(request, item, width, height) {
  if (!item.clip || !item.island || !request.modelKey) return null;
  return islandMask(request.modelKey, item.island.mesh, item.island.index, width, height);
}

function renderItemLayer(layer, request, item, width, height) {
  const context = layer.getContext("2d");
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalCompositeOperation = "source-over";
  context.globalAlpha = 1;
  context.clearRect(0, 0, width, height);
  const mask = itemMask(request, item, width, height);
  context.save();
  if (mask) {
    context.beginPath();
    context.rect(mask.x, mask.y, mask.width, mask.height);
    context.clip();
  }
  drawItemBody(context, item, itemBox(item, width, height));
  context.restore();
  if (mask) {
    context.globalCompositeOperation = "destination-in";
    context.drawImage(mask.canvas, mask.x, mask.y);
    context.globalCompositeOperation = "source-over";
  }
  return mask;
}

function clipShare(request, item, width, height) {
  if (!item.clip || !item.island) return 0;
  const scaleX = STATS_SIDE / width;
  const scaleY = STATS_SIDE / height;
  const canvas = new OffscreenCanvas(STATS_SIDE, STATS_SIDE);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.scale(scaleX, scaleY);
  drawItemBody(context, item, itemBox(item, width, height));
  const before = context.getImageData(0, 0, STATS_SIDE, STATS_SIDE).data;
  const mask = islandMask(request.modelKey, item.island.mesh, item.island.index, width, height);
  let total = 0;
  let inside = 0;
  const maskContext = mask ? (() => {
    const small = new OffscreenCanvas(STATS_SIDE, STATS_SIDE);
    const smallContext = small.getContext("2d", { willReadFrequently: true });
    smallContext.scale(scaleX, scaleY);
    smallContext.drawImage(mask.canvas, mask.x, mask.y);
    return smallContext.getImageData(0, 0, STATS_SIDE, STATS_SIDE).data;
  })() : null;
  for (let p = 3; p < before.length; p += 4) {
    if (before[p] < 16) continue;
    total += 1;
    if (maskContext && maskContext[p] >= 16) inside += 1;
  }
  return total ? 1 - inside / total : 0;
}

function composite(request, { withBase, layers = false }) {
  const { width, height } = request.sheet;
  const out = new OffscreenCanvas(width, height);
  const context = out.getContext("2d");
  if (withBase && base.bitmap) context.drawImage(base.bitmap, 0, 0, width, height);
  const layer = new OffscreenCanvas(width, height);
  const psdLayers = [];
  for (const item of request.items) {
    if (item.hidden && !layers) continue;
    renderItemLayer(layer, request, item, width, height);
    if (!item.hidden) {
      context.globalAlpha = item.opacity;
      context.globalCompositeOperation = item.blend === "multiply" ? "multiply" : "source-over";
      context.drawImage(layer, 0, 0);
      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
    }
    if (layers) psdLayers.push(cropLayer(layer, item, width, height));
  }
  return { out, psdLayers };
}

function cropLayer(layer, item, width, height) {
  const data = layer.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      if (!data[row + x * 4 + 3]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const info = { name: item.label || item.kind, opacity: item.opacity, blendMode: item.blend === "multiply" ? "multiply" : "normal", hidden: item.hidden };
  if (maxX < 0) return { ...info, top: 0, left: 0, imageData: { width: 1, height: 1, data: new Uint8ClampedArray(4) } };
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const crop = layer.getContext("2d").getImageData(minX, minY, w, h);
  return { ...info, top: minY, left: minX, imageData: { width: w, height: h, data: crop.data } };
}

async function pngBytes(canvas) {
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}

async function compose(id, request) {
  const missing = missingFor(request);
  if (missing) {
    reply(id, { missing });
    return;
  }
  const { width, height } = request.sheet;
  if ((request.mode === "flat" || request.mode === "rgba") && (!request.baseKey || base.key !== request.baseKey || !base.bitmap)) {
    throw new Error("the base livery isn't loaded");
  }
  if (request.mode === "preview") {
    const { out } = composite(request, { withBase: true });
    const clipped = {};
    for (const item of request.items) {
      if (item.hidden || !item.clip || !item.island) continue;
      const share = clipShare(request, item, width, height);
      if (share > 0.02) clipped[item.id] = share;
    }
    const bitmap = out.transferToImageBitmap();
    reply(id, { bitmap, clipped }, [bitmap]);
    return;
  }
  if (request.mode === "stack" || request.mode === "flat") {
    const { out } = composite(request, { withBase: request.mode === "flat" });
    const bytes = await pngBytes(out);
    reply(id, { bytes, width, height }, [bytes.buffer]);
    return;
  }
  if (request.mode === "rgba") {
    const { out } = composite(request, { withBase: true });
    const rgba = new Uint8Array(out.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, height).data.buffer);
    reply(id, { rgba, width, height }, [rgba.buffer]);
    return;
  }
  if (request.mode === "psd") {
    const { out, psdLayers } = composite(request, { withBase: false, layers: true });
    const imageData = out.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, height);
    const bytes = writePsdUint8Array({ width, height, imageData, children: psdLayers });
    reply(id, { bytes, width, height, layers: psdLayers.length }, [bytes.buffer]);
    return;
  }
  throw new Error(`unknown canvas render mode "${request.mode}"`);
}

function islandsOverlay(id, { modelKey, sheet, fill, focus, focusFill }) {
  const entries = models.get(modelKey);
  if (!entries) {
    reply(id, { missing: { model: true, base: false, sources: [], fonts: [] } });
    return;
  }
  const { width, height } = sheet;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  for (const { model } of entries) {
    for (const island of model.islands) {
      const focused = focus && focus.mesh === model.key && focus.island === island.index;
      const triangles = islandSheetTriangles(model, island.index, width, height);
      context.beginPath();
      for (let i = 0; i + 5 < triangles.length; i += 6) {
        context.moveTo(triangles[i], triangles[i + 1]);
        context.lineTo(triangles[i + 2], triangles[i + 3]);
        context.lineTo(triangles[i + 4], triangles[i + 5]);
        context.closePath();
      }
      context.fillStyle = focused ? focusFill : fill;
      context.fill();
    }
  }
  const bitmap = canvas.transferToImageBitmap();
  reply(id, { bitmap }, [bitmap]);
}

self.onmessage = async (event) => {
  const { id, op } = event.data || {};
  try {
    if (op === "model") {
      const summary = buildModel(event.data.modelKey, event.data.meshes);
      reply(id, summary, summary.meshes.map((mesh) => mesh.faceToIsland.buffer));
      return;
    }
    if (op === "base") {
      base.bitmap?.close?.();
      base = { key: "", bitmap: null, width: 0, height: 0 };
      let bitmap = event.data.bitmap || null;
      if (!bitmap && event.data.rgba) {
        if (event.data.width > MAX_BASE_SIDE || event.data.height > MAX_BASE_SIDE) throw new Error(`it is ${event.data.width} × ${event.data.height}; the canvas reads up to ${MAX_BASE_SIDE} × ${MAX_BASE_SIDE}`);
        bitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray(event.data.rgba.buffer, event.data.rgba.byteOffset, event.data.rgba.length), event.data.width, event.data.height));
      }
      if (!bitmap && event.data.bytes) {
        const decoded = await decodeImageFile(event.data.bytes, event.data.ext);
        if (!decoded.rgba || decoded.width > MAX_BASE_SIDE || decoded.height > MAX_BASE_SIDE) throw new Error(`it is ${decoded.width} × ${decoded.height}; the canvas reads up to ${MAX_BASE_SIDE} × ${MAX_BASE_SIDE}`);
        bitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray(decoded.rgba.buffer, decoded.rgba.byteOffset, decoded.rgba.length), decoded.width, decoded.height));
      }
      base = { key: event.data.key || "", bitmap, width: bitmap?.width || 0, height: bitmap?.height || 0 };
      reply(id, { width: base.width, height: base.height });
      return;
    }
    if (op === "source") {
      sources.get(event.data.key)?.close?.();
      sources.set(event.data.key, event.data.bitmap);
      reply(id, { ok: true });
      return;
    }
    if (op === "drop-source") {
      sources.get(event.data.key)?.close?.();
      sources.delete(event.data.key);
      reply(id, { ok: true });
      return;
    }
    if (op === "font") {
      await ensureFont(event.data);
      reply(id, { ok: true });
      return;
    }
    if (op === "compose") {
      await compose(id, event.data.request);
      return;
    }
    if ((op === "island-at" || op === "counterpart" || op === "island-frame") && !models.has(event.data.modelKey)) {
      reply(id, { missing: { model: true, base: false, sources: [], fonts: [] } });
      return;
    }
    if (op === "island-at") {
      const entries = models.get(event.data.modelKey) || [];
      reply(id, { hit: islandAtSheetPoint(entries.map((entry) => entry.model), event.data.x, event.data.y, event.data.width, event.data.height) });
      return;
    }
    if (op === "counterpart") {
      const entries = models.get(event.data.modelKey) || [];
      const result = findCounterpart(entries.map((entry) => entry.data), event.data.source, event.data.options || {});
      if (result.status === "found") {
        const entry = entries.find((candidate) => candidate.model.key === result.mesh);
        result.island = entry ? entry.model.faceToIsland[result.face] : -1;
      }
      reply(id, { result });
      return;
    }
    if (op === "island-frame") {
      const entry = models.get(event.data.modelKey).find((candidate) => candidate.model.key === event.data.mesh);
      reply(id, { frame: entry ? islandFrame(entry.data, entry.model, event.data.island, event.data.options || {}) : null });
      return;
    }
    if (op === "islands-overlay") {
      islandsOverlay(id, event.data);
      return;
    }
    throw new Error(`unknown canvas worker request "${op}"`);
  } catch (error) {
    reply(id, { error: error instanceof Error ? error.message : String(error) });
  }
};
