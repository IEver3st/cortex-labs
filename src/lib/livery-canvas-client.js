import { readFile, stat } from "@tauri-apps/plugin-fs";
import { createWorkerClient } from "./worker-client.js";
import { decodePdnRgba, decodePsdRgba } from "./viewer-utils.js";
import { isYtdTexturePath, resolveYtdTexturePath } from "./ytd-texture.js";
import { canvasFontFamily, canvasFontKey, itemLabel } from "./livery-canvas.js";
import { bundledFontUrl } from "./livery-canvas-fonts.js";

const SVG_RASTER_SIDE = 2048;
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml" };

function extensionOf(path) {
  return (/\.([^.\\/]+)$/.exec(String(path || ""))?.[1] || "").toLowerCase();
}

function errorText(error) {
  return String(error?.message || error || "it could not be read").replace(/\.$/, "");
}

async function fileStamp(path) {
  const info = await stat(path);
  return `${info.mtime?.getTime?.() ?? ""}:${info.size}`;
}

async function rasterizeSvg(bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: MIME.svg }));
  try {
    const image = new Image();
    image.decoding = "async";
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("the SVG could not be drawn"));
      image.src = url;
    });
    const naturalWidth = image.naturalWidth || SVG_RASTER_SIDE;
    const naturalHeight = image.naturalHeight || SVG_RASTER_SIDE;
    const fit = SVG_RASTER_SIDE / Math.max(naturalWidth, naturalHeight);
    const width = Math.max(1, Math.round(naturalWidth * fit));
    const height = Math.max(1, Math.round(naturalHeight * fit));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(image, 0, 0, width, height);
    return await createImageBitmap(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function decodeCanvasImage(path) {
  const bytes = await readFile(path);
  const ext = extensionOf(path);
  if (ext === "svg") return rasterizeSvg(bytes);
  return createImageBitmap(new Blob([bytes], { type: MIME[ext] || "application/octet-stream" }));
}

const mainFonts = new Map();

export async function loadCanvasFontOnPage(font) {
  const key = canvasFontKey(font);
  if (mainFonts.has(key)) return mainFonts.get(key);
  const pending = (async () => {
    const family = canvasFontFamily(font);
    if (font.path) {
      const bytes = await readFile(font.path);
      const face = new FontFace(family, bytes.slice().buffer);
      await face.load();
      document.fonts.add(face);
      return { key, font, bytes };
    }
    const face = new FontFace(family, `url(${bundledFontUrl(font.id)})`, { weight: String(font.weight), style: font.style });
    await face.load();
    document.fonts.add(face);
    return { key, font, url: bundledFontUrl(font.id) };
  })();
  mainFonts.set(key, pending);
  pending.catch(() => mainFonts.delete(key));
  return pending;
}

export function measureCanvasText(source) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const family = canvasFontFamily(source.font);
  const style = source.font.path ? "normal" : source.font.style;
  const weight = source.font.path ? 400 : source.font.weight;
  context.font = `${style} ${weight} 100px "${family}"`;
  context.letterSpacing = `${(source.letterSpacing || 0) * 100}px`;
  const metrics = context.measureText(source.text);
  const height = (metrics.actualBoundingBoxAscent || 75) + (metrics.actualBoundingBoxDescent || 20);
  return { aspect: Math.max(0.05, metrics.width / Math.max(1, height)) };
}

export function createCanvasRenderer() {
  const client = createWorkerClient(
    () => new Worker(new URL("./livery-canvas-worker.js", import.meta.url), { type: "module" }),
    { label: "Canvas worker", timeoutMs: 180_000 },
  );
  let model = null;
  let base = null;
  const sources = new Map();

  const request = (payload, transfer = []) => client.request(payload, transfer);

  async function sendModel() {
    if (!model) return null;
    const meshes = model.meshes.map((mesh) => ({
      ...mesh,
      positions: mesh.positions.slice(),
      normals: mesh.normals ? mesh.normals.slice() : null,
      uvs: mesh.uvs.slice(),
      index: mesh.index ? mesh.index.slice() : null,
    }));
    const transfer = meshes.flatMap((mesh) => [mesh.positions.buffer, mesh.uvs.buffer, mesh.normals?.buffer, mesh.index?.buffer].filter(Boolean));
    return request({ op: "model", modelKey: model.key, meshes }, transfer);
  }

  async function sendBase() {
    if (!base) return null;
    let path = base.path;
    if (isYtdTexturePath(path)) path = await resolveYtdTexturePath(path);
    const bytes = await readFile(path);
    const ext = extensionOf(path);
    if (ext === "psd" || ext === "pdn") {
      const image = ext === "psd" ? await decodePsdRgba(bytes) : await decodePdnRgba(bytes, path);
      const rgba = new Uint8Array(image.data.buffer.slice(image.data.byteOffset, image.data.byteOffset + image.data.byteLength));
      return request({ op: "base", key: base.key, rgba, width: image.width, height: image.height }, [rgba.buffer]);
    }
    return request({ op: "base", key: base.key, bytes, ext }, [bytes.buffer]);
  }

  async function sendSource(key) {
    const entry = sources.get(key);
    if (!entry) throw new Error("An image on the canvas is no longer loaded.");
    const bitmap = await decodeCanvasImage(entry.path);
    entry.size = { width: bitmap.width, height: bitmap.height };
    await request({ op: "source", key, bitmap }, [bitmap]);
  }

  async function sendFont(key, items) {
    const item = items.find((entry) => entry.kind === "text" && canvasFontKey(entry.source.font) === key);
    if (!item) return;
    const loaded = await loadCanvasFontOnPage(item.source.font);
    await request({ op: "font", font: item.source.font, ...(loaded.bytes ? { bytes: loaded.bytes.slice().buffer } : { url: loaded.url }) });
  }

  async function run(payload, attempts = 2) {
    const result = await request(payload);
    if (!result?.missing) return result;
    if (attempts <= 0) throw new Error("The canvas worker lost what it needed to draw.");
    const { missing } = result;
    if (missing.model) await sendModel();
    if (missing.base) await sendBase();
    for (const key of missing.sources || []) await sendSource(key);
    for (const key of missing.fonts || []) await sendFont(key, payload.request?.items || []);
    return run(payload, attempts - 1);
  }

  return {
    async setModel(key, meshes) {
      model = { key, meshes };
      return sendModel();
    },
    async setBase(key, path) {
      base = key && path ? { key, path } : null;
      if (!base) return request({ op: "base", key: "" });
      return sendBase();
    },
    async prepareSource(path) {
      const stamp = await fileStamp(path);
      const key = `${String(path).toLowerCase()}@${stamp}`;
      if (sources.has(key)) return { key, size: sources.get(key).size };
      for (const [other, entry] of sources) {
        if (entry.path.toLowerCase() === String(path).toLowerCase()) {
          sources.delete(other);
          request({ op: "drop-source", key: other }).catch(() => {});
        }
      }
      sources.set(key, { path, size: null });
      try {
        await sendSource(key);
      } catch (error) {
        sources.delete(key);
        throw error;
      }
      return { key, size: sources.get(key).size };
    },
    keepSources(paths) {
      const keep = new Set((paths || []).map((path) => String(path).toLowerCase()));
      for (const [key, entry] of sources) {
        if (keep.has(entry.path.toLowerCase())) continue;
        sources.delete(key);
        request({ op: "drop-source", key }).catch(() => {});
      }
    },
    async prepareFont(font) {
      return loadCanvasFontOnPage(font);
    },
    compose({ modelKey, baseKey, sheet, items, sourceKeys }, mode) {
      const prepared = items.map((item) => ({
        id: item.id,
        kind: item.kind,
        label: itemLabel(item),
        source: item.source,
        island: item.island,
        uvTransform: item.uvTransform,
        opacity: item.opacity,
        blend: item.blend,
        clip: item.clip,
        hidden: item.hidden,
        sourceKey: item.kind === "image" ? sourceKeys[item.id] || "" : "",
      }));
      return run({ op: "compose", request: { modelKey, baseKey, sheet, items: prepared, mode } });
    },
    islandAt(modelKey, x, y, width, height) {
      return run({ op: "island-at", modelKey, x, y, width, height }).then((result) => result.hit || null);
    },
    counterpart(modelKey, source, options) {
      return run({ op: "counterpart", modelKey, source, options }).then((result) => result.result);
    },
    islandFrame(modelKey, mesh, island, options) {
      return run({ op: "island-frame", modelKey, mesh, island, options }).then((result) => result.frame || null);
    },
    islandsOverlay(modelKey, sheet, colors, focus = null) {
      return run({ op: "islands-overlay", modelKey, sheet, fill: colors.fill, focusFill: colors.focus, focus });
    },
    dispose() {
      client.terminate?.();
      sources.clear();
      model = null;
      base = null;
    },
  };
}

export { errorText as canvasErrorText };
