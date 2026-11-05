import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeFile } from "@tauri-apps/plugin-fs";
import useEditHistory from "../../useEditHistory";
import { notifyLiveryDictionariesChanged, useLiveryDictionaries } from "../LiveriesPanel";
import { buildLiveryTexturesFromRgba } from "../../../lib/livery-image.js";
import { isFsScopeError } from "../../../lib/capture-output.js";
import { fileNameOf, largestCopy } from "../../../lib/livery-set.js";
import { UV_ORIGIN_TOP } from "../../../lib/clmesh-object.js";
import {
  addCanvasItem,
  buildDecalKit,
  CANVAS_FONT_EXTENSIONS,
  CANVAS_IMAGE_EXTENSIONS,
  canvasExportNames,
  canvasFontKey,
  canvasLiveryBinding,
  canvasLiverySlots,
  canvasSourcePaths,
  classifyCanvasBase,
  createCanvasDoc,
  DEFAULT_SHEET_SIZE,
  defaultShapeSource,
  itemLabel,
  itemMeters,
  moveCanvasItem,
  parseCanvasDoc,
  parseDecalKit,
  planCanvasSlotWrite,
  relinkCanvasSource,
  removeCanvasItems,
  replaceOnlyProblem,
  samePath,
  serializeCanvasDoc,
  updateCanvasItem,
} from "../../../lib/livery-canvas.js";
import { PATTERN_KINDS } from "../../../lib/livery-canvas-shapes.js";
import {
  barycentricFromPoint,
  faceVertices,
  islandPlacementIssue,
  normalizeBarycentric,
  orientationAt,
  uvFromBarycentric,
  uvToSheet,
} from "../../../lib/livery-canvas-geometry.js";
import { canvasErrorText, createCanvasRenderer, decodeCanvasImage, loadCanvasFontOnPage, measureCanvasText } from "../../../lib/livery-canvas-client.js";

const STAGE_KEY = "cortex.liveryCanvas.stage";
const PREVIEW_DELAY_MS = 120;
const DEFAULT_METERS = { image: 0.6, text: 0.7, stripe: 1.6, band: 1.4, chevron: 0.8, outline: 0.8, battenburg: 1.2, check: 1.2 };
const DEFAULT_ASPECT = { stripe: 5, band: 6, chevron: 1.3, outline: 1.6, battenburg: 3, check: 3 };
const FALLBACK_SHARE = 0.15;
const ISLAND_COLORS = { fill: "rgba(140, 150, 165, 0.22)", focus: "rgba(255, 255, 255, 0.42)" };

let nextId = 0;
const makeId = () => `c${Date.now().toString(36)}${(nextId += 1).toString(36)}`;

function readStage() {
  try {
    const value = localStorage.getItem(STAGE_KEY);
    return ["model", "sheet", "split"].includes(value) ? value : "split";
  } catch {
    return "split";
  }
}

function writeStage(value) {
  try {
    localStorage.setItem(STAGE_KEY, value);
  } catch {
    return;
  }
}

function copyVectors(attribute, matrix, normalMatrix) {
  const out = new Float32Array(attribute.count * 3);
  const vector = new THREE.Vector3();
  for (let i = 0; i < attribute.count; i += 1) {
    vector.set(attribute.getX(i), attribute.getY(i), attribute.getZ(i));
    if (normalMatrix) vector.applyMatrix3(normalMatrix).normalize();
    else vector.applyMatrix4(matrix);
    out[i * 3] = vector.x;
    out[i * 3 + 1] = vector.y;
    out[i * 3 + 2] = vector.z;
  }
  return out;
}

function copyUvs(attribute) {
  const out = new Float32Array(attribute.count * 2);
  for (let i = 0; i < attribute.count; i += 1) {
    out[i * 2] = attribute.getX(i);
    out[i * 2 + 1] = attribute.getY(i);
  }
  return out;
}

function meshLabel(mesh) {
  return mesh.userData?.meshLabel || mesh.name || "mesh";
}

function readCanvasModel(api) {
  const info = api?.getLiveryCanvasModel?.();
  if (!info?.root) return null;
  info.root.updateMatrixWorld(true);
  const rootInverse = info.root.matrixWorld.clone().invert();
  const meshes = [];
  const objects = new Map();
  const uvSets = new Map();
  const problems = [];
  const box = new THREE.Box3();
  info.meshes.forEach((mesh, order) => {
    if (mesh.userData?.nativeLodActive === false) return;
    const binding = canvasLiveryBinding(mesh.userData?.nativeMaterial);
    if (!binding) return;
    const geometry = mesh.geometry;
    const uv = geometry?.userData?.gtaUvSets?.[binding.uvSet];
    const position = geometry?.attributes?.position;
    if (!uv || !position) {
      problems.push(`${meshLabel(mesh)} has no UV set ${binding.uvSet}, so Canvas skips it.`);
      return;
    }
    const relative = new THREE.Matrix4().multiplyMatrices(rootInverse, mesh.matrixWorld);
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(relative);
    const key = `${order}:${meshLabel(mesh)}`.slice(0, 200);
    const data = {
      key,
      positions: copyVectors(position, relative, null),
      normals: geometry.attributes.normal ? copyVectors(geometry.attributes.normal, null, normalMatrix) : null,
      uvs: copyUvs(uv),
      index: geometry.index ? Uint32Array.from(geometry.index.array) : null,
      originTop: geometry.userData?.uvOrigin === UV_ORIGIN_TOP,
    };
    for (let i = 0; i < data.positions.length; i += 3) box.expandByPoint(new THREE.Vector3(data.positions[i], data.positions[i + 1], data.positions[i + 2]));
    meshes.push(data);
    objects.set(mesh, { key, relative, binding, data });
    uvSets.set(mesh, binding.uvSet);
  });
  const up = new THREE.Vector3(0, 1, 0).transformDirection(rootInverse);
  const upAxis = [up.x, up.y, up.z].map(Math.abs);
  const upIndex = upAxis.indexOf(Math.max(...upAxis));
  const size = box.isEmpty() ? new THREE.Vector3(1, 1, 1) : box.getSize(new THREE.Vector3());
  const centre = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
  const others = [0, 1, 2].filter((axis) => axis !== upIndex);
  const extents = others.map((axis) => size.getComponent(axis));
  const forwardIndex = extents[0] >= extents[1] ? others[0] : others[1];
  const sideIndex = others.find((axis) => axis !== forwardIndex);
  const forward = [0, 0, 0];
  forward[forwardIndex] = 1;
  return {
    id: info.id,
    meshes,
    objects,
    uvSets,
    problems,
    parentTextures: info.parentTextures,
    axes: {
      up: [up.x, up.y, up.z],
      forward,
      side: sideIndex,
      offset: centre.getComponent(sideIndex),
    },
  };
}

function hitBarycentric(entry, hit) {
  if (Array.isArray(hit.barycoord) && hit.barycoord.every(Number.isFinite)) return normalizeBarycentric(hit.barycoord);
  const vertices = faceVertices(entry.data, hit.face);
  if (!vertices || !hit.localPoint) return null;
  const point = new THREE.Vector3(...hit.localPoint).applyMatrix4(entry.relative);
  const read = (vertex) => [entry.data.positions[vertex * 3], entry.data.positions[vertex * 3 + 1], entry.data.positions[vertex * 3 + 2]];
  return barycentricFromPoint(read(vertices[0]), read(vertices[1]), read(vertices[2]), [point.x, point.y, point.z]);
}

function readsRight(flipX, mirrored) {
  return Boolean(flipX) === Boolean(mirrored);
}

function errorMessage(error) {
  if (isFsScopeError(error)) return "Cortex isn't allowed to read that location. Use Locate to pick the file again.";
  return canvasErrorText(error);
}

function writeErrorMessage(error) {
  if (isFsScopeError(error)) return "Cortex isn't allowed to write there. Choose a folder you opened in Cortex, or your Documents or Pictures";
  return canvasErrorText(error);
}

const IDLE_MODEL = { status: "idle", key: "", meshes: new Map(), problems: [], text: "" };
const IDLE_BASE = { key: "", path: "", width: 0, height: 0, status: "idle", error: "" };
const EDITABLE_TARGET = "input, textarea, select, [contenteditable='true'], [role='combobox'], [role='listbox'], [role='option'], [role='menu'], [role='menuitem'], [role='dialog'], [role='radio'], [role='radiogroup'], [role='slider'], [role='tab']";

function slotOfPath(slots, path) {
  if (!path) return null;
  const slot = slots.find((entry) => entry.existing.some((copy) => samePath(copy.texture?.path, path)));
  return slot ? slot.number : null;
}

export default function useLiveryCanvas(s, { enabled = true, keysEnabled = true } = {}) {
  const modelPath = s.modelPath || "";
  const doc = s.liveryCanvas || null;
  const engaged = Boolean(enabled && doc && modelPath);
  const isYft = /\.yft$/i.test(modelPath);
  const history = useEditHistory();
  const dictionaries = useLiveryDictionaries(modelPath, Boolean(engaged && s.isTauriRuntime && isYft));
  const signPrefix = s.gameLiveries ? s.gameLiveries.signPrefix ?? null : null;

  const rendererRef = useRef(null);
  const previewCanvasRef = useRef(null);
  const docRef = useRef(doc);
  docRef.current = doc;
  const modelRef = useRef(null);
  const [stage, setStageState] = useState(readStage);
  const [selectedId, setSelectedId] = useState(null);
  const [placing, setPlacing] = useState(null);
  const [hover, setHover] = useState(null);
  const [model, setModel] = useState(IDLE_MODEL);
  const [base, setBase] = useState(IDLE_BASE);
  const [sources, setSources] = useState({});
  const [fontErrors, setFontErrors] = useState({});
  const [sourceToken, setSourceToken] = useState(0);
  const [preview, setPreview] = useState({ revision: 0, clipped: {}, busy: false, error: "" });
  const [overlay, setOverlay] = useState({ bitmap: null, on: true });
  const overlayRef = useRef(overlay);
  overlayRef.current = overlay;
  const [pins, setPins] = useState(() => new Map());
  const pendingPinRef = useRef(null);
  const [showOnModel, setShowOnModel] = useState(true);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState("");
  const [writeDialog, setWriteDialog] = useState(null);

  const renderer = useCallback(() => {
    rendererRef.current ||= createCanvasRenderer();
    return rendererRef.current;
  }, []);

  const previewCanvas = useCallback(() => {
    if (!previewCanvasRef.current && typeof document !== "undefined") {
      previewCanvasRef.current = document.createElement("canvas");
      previewCanvasRef.current.className = "lv-cv-sheet-image";
    }
    return previewCanvasRef.current;
  }, []);

  useEffect(() => () => {
    rendererRef.current?.dispose();
    rendererRef.current = null;
    overlayRef.current.bitmap?.close?.();
    setOverlay((current) => (current.bitmap ? { ...current, bitmap: null } : current));
  }, []);

  const setStage = useCallback((value) => {
    setStageState(value);
    writeStage(value);
  }, []);

  const say = useCallback((tone, text) => setNotice(text ? { tone, text } : null), []);

  const setDoc = s.setLiveryCanvas;
  const commit = useCallback((update, key = null) => {
    const current = docRef.current;
    if (!current) return;
    const next = typeof update === "function" ? update(current) : update;
    if (!next || next === current) return;
    history.record(current, key);
    docRef.current = next;
    setDoc(next);
  }, [history, setDoc]);

  const start = useCallback(() => {
    if (!modelPath) return;
    history.clear();
    s.setLiveryCanvas((current) => current || createCanvasDoc({ model: modelPath, sheet: { width: DEFAULT_SHEET_SIZE, height: DEFAULT_SHEET_SIZE } }));
    say("", "");
  }, [history, modelPath, s, say]);

  const close = useCallback(() => {
    setPlacing(null);
    setSelectedId(null);
    history.clear();
    s.setLiveryCanvas(null);
  }, [history, s]);

  const undo = useCallback(() => {
    const current = docRef.current;
    if (!current) return;
    const snapshot = history.undo(current);
    if (!snapshot) return;
    const next = { ...snapshot, written: current.written || [] };
    docRef.current = next;
    setDoc(next);
  }, [history, setDoc]);

  const redo = useCallback(() => {
    const current = docRef.current;
    if (!current) return;
    const snapshot = history.redo(current);
    if (!snapshot) return;
    const next = { ...snapshot, written: current.written || [] };
    docRef.current = next;
    setDoc(next);
  }, [history, setDoc]);

  useEffect(() => {
    history.clear();
    setSelectedId(null);
    setPlacing(null);
    setPins((current) => (current.size ? new Map() : current));
  }, [modelPath]);

  const api = s.viewerApiRef?.current || null;
  const modelReady = engaged && s.viewerReady && !s.modelLoading;

  useEffect(() => {
    if (!modelReady) return undefined;
    const viewerApi = s.viewerApiRef?.current;
    const built = readCanvasModel(viewerApi);
    if (!built) {
      setModel(IDLE_MODEL);
      return undefined;
    }
    if (modelRef.current?.id === built.id && modelRef.current.status === "ready") return undefined;
    if (!built.meshes.length) {
      modelRef.current = { ...built, status: "none" };
      setModel({
        status: "none",
        key: "",
        meshes: new Map(),
        problems: built.problems,
        text: "Not checked: this model has no livery material Cortex can read (a _sign_ texture or a second diffuse sampler), so Canvas can't find where the livery goes.",
      });
      return undefined;
    }
    let cancelled = false;
    const key = `${built.id}`;
    modelRef.current = { ...built, status: "loading", key };
    setModel((current) => ({ ...current, status: "loading", text: "Finding the livery's parts…" }));
    viewerApi.setLiveryCanvasUvSets?.(built.uvSets);
    renderer().setModel(key, built.meshes)
      .then((summary) => {
        if (cancelled) return;
        const meshes = new Map(summary.meshes.map((mesh) => [mesh.key, mesh]));
        modelRef.current = { ...built, status: "ready", key, summary: meshes };
        const islandCount = summary.meshes.reduce((total, mesh) => total + mesh.islands.length, 0);
        setModel({ status: "ready", key, meshes, problems: [...built.problems, ...summary.problems], text: `${islandCount} ${islandCount === 1 ? "part" : "parts"} on ${summary.meshes.length} ${summary.meshes.length === 1 ? "mesh" : "meshes"}` });
      })
      .catch((error) => {
        if (cancelled) return;
        modelRef.current = { ...built, status: "error" };
        setModel({ status: "error", key: "", meshes: new Map(), problems: built.problems, text: `The model's parts couldn't be read: ${errorMessage(error)}.` });
      });
    return () => { cancelled = true; };
  }, [modelReady, modelPath, renderer, s.viewerApiRef]);

  useEffect(() => {
    if (engaged) return undefined;
    modelRef.current = null;
    const viewerApi = s.viewerApiRef?.current;
    viewerApi?.setLiveryCanvasUvSets?.(null);
    viewerApi?.setLiveryCanvasPicker?.(null);
    viewerApi?.setCompositeTexture?.(null);
    rendererRef.current?.dispose();
    rendererRef.current = null;
    if (previewCanvasRef.current) {
      previewCanvasRef.current.width = 0;
      previewCanvasRef.current.height = 0;
    }
    setPins((current) => (current.size ? new Map() : current));
    setModel((current) => (current === IDLE_MODEL ? current : IDLE_MODEL));
    setBase((current) => (current === IDLE_BASE ? current : IDLE_BASE));
    setSources((current) => (Object.keys(current).length ? {} : current));
    setFontErrors((current) => (Object.keys(current).length ? {} : current));
    setOverlay((current) => {
      if (!current.bitmap) return current;
      current.bitmap.close?.();
      return { ...current, bitmap: null };
    });
    return undefined;
  }, [engaged, s.viewerApiRef]);

  useEffect(() => () => {
    const viewerApi = s.viewerApiRef?.current;
    viewerApi?.setLiveryCanvasUvSets?.(null);
    viewerApi?.setLiveryCanvasPicker?.(null);
    viewerApi?.setCompositeTexture?.(null);
  }, [s.viewerApiRef]);

  const slotInfo = useMemo(() => canvasLiverySlots({ dictionaries: dictionaries.list, signPrefix, modelPath }), [dictionaries.list, signPrefix, modelPath]);
  const gameLiveryBase = useMemo(() => {
    if (!engaged || !Number.isInteger(s.gameLivery)) return "";
    return largestCopy(slotInfo.slots.find((slot) => slot.number === s.gameLivery))?.texture.path || "";
  }, [engaged, slotInfo, s.gameLivery]);
  const chosenPath = s.texturePath || gameLiveryBase;
  const baseSlot = s.texturePath
    ? slotOfPath(slotInfo.slots, s.texturePath) ?? [...pins].find(([, pin]) => samePath(pin.path, s.texturePath))?.[0] ?? null
    : (gameLiveryBase ? s.gameLivery : null);
  const pinned = baseSlot != null ? pins.get(baseSlot) || null : null;
  const writtenOver = baseSlot != null && !pinned && (doc?.written || []).includes(baseSlot);
  const texturePath = pinned?.path || chosenPath;
  const reloadToken = s.textureReloadToken || 0;
  useEffect(() => {
    if (!engaged) return undefined;
    if (!texturePath) {
      setBase({ key: "", path: "", width: 0, height: 0, status: "none", error: "" });
      renderer().setBase("", "").catch(() => {});
      return undefined;
    }
    let cancelled = false;
    const key = `${texturePath}@${reloadToken}`;
    setBase((current) => ({ ...current, status: "loading", error: "" }));
    renderer().setBase(key, texturePath)
      .then((result) => {
        if (cancelled) return;
        setBase({ key, path: texturePath, width: result?.width || 0, height: result?.height || 0, status: "ready", error: "" });
      })
      .catch((error) => {
        if (cancelled) return;
        const failed = { key: "", path: texturePath, width: 0, height: 0, status: "error", error: `${fileNameOf(texturePath)} couldn't be read as the base: ${errorMessage(error)}.` };
        const stillSaving = error?.type === "incomplete-file";
        setBase((current) => (stillSaving && current.key && current.path === texturePath ? { ...current, status: "ready", error: "" } : failed));
      });
    return () => { cancelled = true; };
  }, [engaged, renderer, texturePath, reloadToken]);

  const classification = useMemo(() => pinned?.classification || classifyCanvasBase({
    path: texturePath,
    dictionaries: dictionaries.list,
    parentTextures: modelRef.current?.parentTextures || api?.getLiveryCanvasModel?.()?.parentTextures || null,
  }), [pinned, texturePath, dictionaries.list, model.key, api]);


  const sheet = useMemo(() => {
    if (base.status === "ready" && base.width && base.height) return { width: base.width, height: base.height };
    const largest = slotInfo.slots.flatMap((slot) => slot.existing.map((entry) => entry.texture)).reduce((best, texture) => (
      (texture.width || 0) * (texture.height || 0) > (best?.width || 0) * (best?.height || 0) ? texture : best
    ), null);
    if (largest?.width && largest?.height) return { width: largest.width, height: largest.height };
    return doc?.sheet || { width: DEFAULT_SHEET_SIZE, height: DEFAULT_SHEET_SIZE };
  }, [base, slotInfo, doc?.sheet]);

  useEffect(() => {
    if (!doc) return;
    if (doc.sheet.width === sheet.width && doc.sheet.height === sheet.height) return;
    s.setLiveryCanvas((current) => (current ? { ...current, sheet: { ...sheet } } : current));
  }, [doc, sheet, s]);

  const imagePaths = useMemo(() => (doc ? [...new Set(doc.items.filter((item) => item.kind === "image").map((item) => item.source.path))] : []), [doc]);
  const imageKey = imagePaths.join("\n");
  useEffect(() => {
    if (!engaged) return undefined;
    let cancelled = false;
    const paths = imageKey ? imageKey.split("\n") : [];
    renderer().keepSources(paths);
    setSources((current) => {
      const kept = Object.fromEntries(Object.entries(current).filter(([path]) => paths.includes(path)));
      return Object.keys(kept).length === Object.keys(current).length ? current : kept;
    });
    (async () => {
      for (const path of paths) {
        if (cancelled) return;
        try {
          const prepared = await renderer().prepareSource(path);
          if (!cancelled) setSources((current) => (current[path]?.key === prepared.key ? current : { ...current, [path]: { key: prepared.key, size: prepared.size, error: "" } }));
        } catch (error) {
          if (!cancelled) setSources((current) => ({ ...current, [path]: { key: "", size: null, error: errorMessage(error), scope: isFsScopeError(error) } }));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [engaged, imageKey, renderer, reloadToken, sourceToken]);

  const fontPaths = useMemo(() => (doc ? [...new Set(doc.items.filter((item) => item.kind === "text" && item.source.font.path).map((item) => item.source.font.path))] : []), [doc]);
  const fontKey = fontPaths.join("\n");
  useEffect(() => {
    if (!engaged) return undefined;
    let cancelled = false;
    (async () => {
      for (const path of fontKey ? fontKey.split("\n") : []) {
        try {
          await loadCanvasFontOnPage({ path, family: fileNameOf(path), weight: 400, style: "normal" });
          if (!cancelled) setFontErrors((current) => (current[path] ? Object.fromEntries(Object.entries(current).filter(([key]) => key !== path)) : current));
        } catch (error) {
          if (!cancelled) setFontErrors((current) => ({ ...current, [path]: errorMessage(error) }));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [engaged, fontKey, sourceToken]);

  const missing = useMemo(() => {
    if (!doc) return [];
    return canvasSourcePaths(doc).map((entry) => {
      const error = entry.kind === "image" ? sources[entry.path]?.error : fontErrors[entry.path];
      return error ? { ...entry, error } : null;
    }).filter(Boolean);
  }, [doc, sources, fontErrors]);

  const drawable = useMemo(() => {
    if (!doc) return [];
    return doc.items.filter((item) => {
      if (item.kind === "image") return Boolean(sources[item.source.path]?.key);
      if (item.kind === "text" && item.source.font.path) return !fontErrors[item.source.font.path];
      return true;
    });
  }, [doc, sources, fontErrors]);

  const sourceKeys = useMemo(() => Object.fromEntries(drawable
    .filter((item) => item.kind === "image")
    .map((item) => [item.id, sources[item.source.path].key])), [drawable, sources]);

  const composeRequest = useCallback((items = drawable) => ({
    modelKey: model.status === "ready" ? model.key : "",
    baseKey: base.status === "ready" ? base.key : "",
    sheet,
    items,
    sourceKeys,
  }), [drawable, model, base, sheet, sourceKeys]);

  const visibleCount = drawable.filter((item) => !item.hidden).length;
  const generation = useRef(0);
  useEffect(() => {
    if (!engaged || model.status === "loading" || base.status === "loading") return undefined;
    const run = (generation.current += 1);
    const timer = setTimeout(async () => {
      setPreview((current) => ({ ...current, busy: true }));
      try {
        const result = await renderer().compose(composeRequest(), "preview");
        if (run !== generation.current) {
          result.bitmap?.close?.();
          return;
        }
        const canvas = previewCanvas();
        if (canvas.width !== sheet.width || canvas.height !== sheet.height) {
          canvas.width = sheet.width;
          canvas.height = sheet.height;
        }
        const context = canvas.getContext("2d");
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(result.bitmap, 0, 0);
        result.bitmap.close?.();
        const viewerApi = s.viewerApiRef?.current;
        const onModel = showOnModel && visibleCount > 0 && base.status === "ready";
        viewerApi?.setCompositeTexture?.(onModel ? canvas : null);
        setPreview((current) => ({ revision: current.revision + 1, clipped: result.clipped || {}, busy: false, error: "" }));
      } catch (error) {
        if (run !== generation.current) return;
        setPreview((current) => ({ ...current, busy: false, error: `The canvas couldn't be drawn: ${errorMessage(error)}.` }));
      }
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [engaged, composeRequest, renderer, previewCanvas, sheet, showOnModel, visibleCount, base.status, model.status, s.viewerApiRef]);

  const selectedIsland = doc?.items.find((item) => item.id === selectedId)?.island || null;
  const selectedIslandKey = selectedIsland ? `${selectedIsland.mesh}#${selectedIsland.index}` : "";
  useEffect(() => {
    if (!engaged || model.status !== "ready" || !overlay.on || stage === "model") return undefined;
    let cancelled = false;
    const focusIsland = hover?.island || (selectedIsland ? { mesh: selectedIsland.mesh, island: selectedIsland.index } : null);
    const timer = setTimeout(() => {
      renderer().islandsOverlay(model.key, sheet, ISLAND_COLORS, focusIsland)
        .then((result) => {
          if (cancelled) {
            result.bitmap?.close?.();
            return;
          }
          setOverlay((current) => {
            current.bitmap?.close?.();
            return { ...current, bitmap: result.bitmap };
          });
        })
        .catch(() => {});
    }, 60);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [engaged, model, overlay.on, stage, sheet, renderer, selectedIslandKey, hover?.island?.mesh, hover?.island?.island]);

  const islandInfo = useCallback((meshKey, index) => {
    const mesh = model.meshes.get(meshKey);
    return mesh?.islands?.[index] || null;
  }, [model]);

  const placementFor = useCallback(async (target, request) => {
    const built = modelRef.current;
    const entry = target.mesh ? [...(built?.objects?.values() || [])].find((candidate) => candidate.key === target.mesh) : null;
    const { width, height } = sheet;
    const meters = request.size?.width || DEFAULT_METERS[request.shape || request.kind] || 0.6;
    const aspect = request.aspect || DEFAULT_ASPECT[request.shape] || 1;
    if (!entry || !Number.isInteger(target.face) || !target.bary) {
      const w = width * FALLBACK_SHARE;
      const h = w / aspect;
      return {
        island: null,
        anchor: null,
        uvTransform: { u: (target.x ?? width / 2) / width, v: (target.y ?? height / 2) / height, width: w / width, height: h / height, rotation: 0, flipX: Boolean(request.flipX) },
        issue: { level: "warn", text: "That spot isn't on a livery part, so the item isn't clipped to one." },
      };
    }
    const islandIndex = model.meshes.get(entry.key)?.faceToIsland?.[target.face] ?? -1;
    const island = islandIndex >= 0 ? islandInfo(entry.key, islandIndex) : null;
    const issue = islandPlacementIssue(island, request.kind);
    if (issue.level === "refuse") return { refused: issue.text };
    const uv = uvFromBarycentric(entry.data, target.face, target.bary);
    if (!uv) return { refused: "That spot on the model can't be read." };
    const tile = island?.tile || [Math.floor(uv[0]), Math.floor(uv[1])];
    const [x, y] = uvToSheet(uv[0] - tile[0], uv[1] - tile[1], width, height, entry.data.originTop);
    const cameraUp = target.cameraUp ? (() => {
      const vector = new THREE.Vector3(...target.cameraUp).transformDirection(entry.relative);
      return [vector.x, vector.y, vector.z];
    })() : null;
    const orientation = orientationAt(entry.data, target.face, { up: built.axes.up, forward: built.axes.forward, cameraUp, width, height });
    const ppu = orientation?.pixelsPerUnit || 0;
    let w = ppu > 0 ? meters * ppu : width * FALLBACK_SHARE;
    let h = request.size?.height && ppu > 0 ? request.size.height * ppu : w / aspect;
    const fit = Math.min(1, (width * 0.9) / w, (height * 0.9) / h);
    w *= fit;
    h *= fit;
    let uvTransform = { u: x / width, v: y / height, width: w / width, height: h / height, rotation: orientation?.rotation || 0, flipX: Boolean(request.flipX) };
    if (PATTERN_KINDS.includes(request.shape) && island) {
      const frame = await renderer().islandFrame(model.key, entry.key, islandIndex, { up: built.axes.up, forward: built.axes.forward, width, height });
      if (frame) uvTransform = { u: frame.x / width, v: frame.y / height, width: frame.width / width, height: frame.height / height, rotation: frame.rotation, flipX: false };
    }
    return {
      island: island ? { mesh: entry.key, index: islandIndex } : null,
      anchor: { mesh: entry.key, face: target.face, bary: target.bary, ...(ppu > 0 ? { ppu, sheet: [width, height] } : {}) },
      uvTransform,
      issue,
      mirrored: Boolean(orientation?.mirrored),
    };
  }, [sheet, model, islandInfo, renderer]);

  const placeAt = useCallback(async (target) => {
    const request = placing;
    if (!request) return;
    const result = await placementFor(target, request);
    if (result.refused) {
      say("warn", result.refused);
      return;
    }
    const id = makeId();
    const item = {
      id,
      kind: request.kind,
      name: request.name || "",
      source: request.source,
      island: result.island,
      anchor: result.anchor,
      uvTransform: result.uvTransform,
      opacity: request.opacity ?? 1,
      blend: request.blend || "normal",
      clip: request.clip !== false,
    };
    try {
      commit((current) => addCanvasItem(current, item));
    } catch (error) {
      say("error", errorMessage(error));
      return;
    }
    setSelectedId(id);
    say(result.issue?.level || "", result.issue?.text || "");
    const queue = request.queue || [];
    if (queue.length) setPlacing({ ...queue[0], queue: queue.slice(1), total: request.total, step: (request.step || 1) + 1 });
    else setPlacing(null);
  }, [placing, placementFor, commit, say]);

  const placeAtRef = useRef(placeAt);
  placeAtRef.current = placeAt;
  const placingRef = useRef(placing);
  placingRef.current = placing;

  const surfaceStatus = useCallback((hit) => {
    const built = modelRef.current;
    if (!hit || !built?.objects) return null;
    const entry = built.objects.get(hit.mesh);
    if (!entry) return { level: "warn", text: `${meshLabel(hit.mesh)} doesn't carry the livery.`, island: null };
    const islandIndex = model.meshes.get(entry.key)?.faceToIsland?.[hit.face] ?? -1;
    const island = islandIndex >= 0 ? islandInfo(entry.key, islandIndex) : null;
    const kind = placingRef.current?.kind || "image";
    const issue = islandPlacementIssue(island, kind);
    return {
      level: issue.level || "ok",
      text: issue.text || `${meshLabel(hit.mesh)}, part ${islandIndex + 1}`,
      island: island ? { mesh: entry.key, island: islandIndex } : null,
    };
  }, [model, islandInfo]);

  useEffect(() => {
    const viewerApi = s.viewerApiRef?.current;
    if (!viewerApi?.setLiveryCanvasPicker) return undefined;
    if (!engaged || !placing || model.status !== "ready" || stage === "sheet") {
      viewerApi.setLiveryCanvasPicker(null);
      return undefined;
    }
    viewerApi.setLiveryCanvasPicker({
      onHover: (hit) => {
        const status = surfaceStatus(hit);
        setHover((current) => (current?.text === status?.text && current?.island?.island === status?.island?.island ? current : status));
      },
      onPick: (hit) => {
        if (!hit) return;
        const built = modelRef.current;
        const entry = built?.objects?.get(hit.mesh);
        if (!entry) {
          say("warn", `${meshLabel(hit.mesh)} doesn't carry the livery, so nothing can go there.`);
          return;
        }
        const bary = hitBarycentric(entry, hit);
        if (!bary) {
          say("warn", "That spot on the model can't be read.");
          return;
        }
        placeAtRef.current({ mesh: entry.key, face: hit.face, bary, cameraUp: hit.cameraUp });
      },
    });
    return () => viewerApi.setLiveryCanvasPicker(null);
  }, [engaged, placing, model.status, stage, s.viewerApiRef, surfaceStatus, say]);

  useEffect(() => {
    if (!placing) {
      setHover(null);
      return undefined;
    }
    const onKey = (event) => {
      if (event.key === "Escape") setPlacing(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [placing]);

  const placeOnSheet = useCallback(async (x, y) => {
    if (!placingRef.current) return;
    let hit = null;
    if (model.status === "ready") {
      try {
        hit = await renderer().islandAt(model.key, x, y, sheet.width, sheet.height);
      } catch {
        hit = null;
      }
    }
    if (hit) await placeAtRef.current({ mesh: hit.mesh, face: hit.face, bary: hit.bary });
    else await placeAtRef.current({ x, y });
  }, [model, renderer, sheet]);

  const hoverSheet = useCallback(async (x, y) => {
    if (model.status !== "ready" || !placingRef.current) return;
    const hit = await renderer().islandAt(model.key, x, y, sheet.width, sheet.height).catch(() => null);
    if (!hit) {
      setHover({ level: "warn", text: "Not on a livery part", island: null });
      return;
    }
    const island = islandInfo(hit.mesh, hit.island);
    const issue = islandPlacementIssue(island, placingRef.current?.kind || "image");
    setHover({ level: issue.level || "ok", text: issue.text || `Part ${hit.island + 1}`, island: { mesh: hit.mesh, island: hit.island } });
  }, [model, renderer, sheet, islandInfo]);

  const pickImage = useCallback(async () => {
    try {
      const picked = await open({ multiple: false, filters: [{ name: "Images", extensions: CANVAS_IMAGE_EXTENSIONS }] });
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) return;
      setBusy("Reading the image…");
      const prepared = await renderer().prepareSource(path);
      setSources((current) => ({ ...current, [path]: { key: prepared.key, size: prepared.size, error: "" } }));
      const aspect = prepared.size?.width && prepared.size?.height ? prepared.size.width / prepared.size.height : 1;
      setPlacing({ kind: "image", source: { path }, aspect, name: "" });
      say("", "");
    } catch (error) {
      say("error", `The image couldn't be read: ${errorMessage(error)}.`);
    } finally {
      setBusy("");
    }
  }, [renderer, say]);

  const startText = useCallback(async (source) => {
    try {
      setBusy("Loading the font…");
      await loadCanvasFontOnPage(source.font);
      const { aspect } = measureCanvasText(source);
      setPlacing({ kind: "text", source, aspect, name: "" });
      say("", "");
    } catch (error) {
      say("error", `The font couldn't be loaded: ${errorMessage(error)}.`);
    } finally {
      setBusy("");
    }
  }, [say]);

  const startShape = useCallback((shape) => {
    setPlacing({ kind: "shape", shape, source: defaultShapeSource(shape), aspect: DEFAULT_ASPECT[shape] || 1, name: "" });
    say("", "");
  }, [say]);

  const pickFont = useCallback(async () => {
    const picked = await open({ multiple: false, filters: [{ name: "Fonts", extensions: CANVAS_FONT_EXTENSIONS }] });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return null;
    const font = { path, family: fileNameOf(path).replace(/\.[^.]+$/, ""), weight: 400, style: "normal" };
    try {
      await loadCanvasFontOnPage(font);
      return font;
    } catch (error) {
      say("error", `${fileNameOf(path)} couldn't be loaded as a font: ${errorMessage(error)}.`);
      return null;
    }
  }, [say]);

  const update = useCallback((id, patch, key = null) => commit((current) => updateCanvasItem(current, id, patch), key), [commit]);

  const updateText = useCallback((id, sourcePatch) => {
    const item = docRef.current?.items.find((entry) => entry.id === id);
    if (!item || item.kind !== "text") return;
    const source = { ...item.source, ...sourcePatch };
    if (!source.text.trim()) return;
    update(id, (current) => ({ ...current, source: { ...current.source, ...sourcePatch } }), `text:${id}`);
    const wanted = `${source.text}\n${source.letterSpacing}\n${canvasFontKey(source.font)}`;
    loadCanvasFontOnPage(source.font)
      .then(() => measureCanvasText(source).aspect)
      .catch(() => null)
      .then((aspect) => {
        if (!aspect) return;
        update(id, (current) => {
          if (`${current.source.text}\n${current.source.letterSpacing}\n${canvasFontKey(current.source.font)}` !== wanted) return current;
          const t = current.uvTransform;
          const width = (t.height * sheet.height * aspect) / sheet.width;
          return Math.abs(width - t.width) < 1e-9 ? current : { ...current, uvTransform: { ...t, width } };
        }, `text:${id}`);
      });
  }, [update, sheet]);

  const remove = useCallback((ids) => {
    if (!ids.length) return;
    commit((current) => removeCanvasItems(current, ids));
    setSelectedId((current) => (ids.includes(current) ? null : current));
    setNotice(null);
  }, [commit]);

  const reorder = useCallback((id, offset) => commit((current) => moveCanvasItem(current, id, offset)), [commit]);

  const duplicate = useCallback((id) => {
    const item = docRef.current?.items.find((entry) => entry.id === id);
    if (!item) return;
    const copy = { ...item, id: makeId(), symmetry: null, uvTransform: { ...item.uvTransform, u: item.uvTransform.u + 0.02, v: item.uvTransform.v + 0.02 } };
    try {
      commit((current) => addCanvasItem(current, copy));
      setSelectedId(copy.id);
    } catch (error) {
      say("error", errorMessage(error));
    }
  }, [commit, say]);

  const fitToPart = useCallback(async (id) => {
    const item = docRef.current?.items.find((entry) => entry.id === id);
    const built = modelRef.current;
    if (!item?.island || model.status !== "ready" || !built) {
      say("warn", "The item isn't on a livery part.");
      return;
    }
    const frame = await renderer().islandFrame(model.key, item.island.mesh, item.island.index, { up: built.axes.up, forward: built.axes.forward, width: sheet.width, height: sheet.height });
    if (!frame) {
      say("warn", "That part's shape can't be read.");
      return;
    }
    update(id, (current) => ({ ...current, uvTransform: { ...current.uvTransform, u: frame.x / sheet.width, v: frame.y / sheet.height, width: frame.width / sheet.width, height: frame.height / sheet.height, rotation: frame.rotation } }));
  }, [model, renderer, sheet, update, say]);

  const mirror = useCallback(async (id, mode = "readable") => {
    const current = docRef.current;
    const item = current?.items.find((entry) => entry.id === id);
    const built = modelRef.current;
    if (!item || item.symmetry) return;
    if (!item.anchor || model.status !== "ready" || !built) {
      say("warn", "Place the item on the model or on a livery part first, so Cortex knows where it sits.");
      return;
    }
    if (item.kind === "text" && mode === "mirrored") {
      say("warn", "Text can't be mirrored: it would read backwards on the other side.");
      return;
    }
    setBusy("Finding the other side…");
    try {
      const { width, height } = sheet;
      const centre = await renderer().islandAt(model.key, item.uvTransform.u * width, item.uvTransform.v * height, width, height).catch(() => null);
      const moved = centre && (!item.island || (centre.mesh === item.island.mesh && centre.island === item.island.index));
      const from = moved ? { ...item.anchor, mesh: centre.mesh, face: centre.face, bary: centre.bary } : item.anchor;
      const found = await renderer().counterpart(model.key, { mesh: from.mesh, face: from.face, bary: from.bary }, { axis: built.axes.side, offset: built.axes.offset });
      if (found.status !== "found") {
        say("warn", found.text);
        return;
      }
      const entry = [...built.objects.values()].find((candidate) => candidate.key === found.mesh);
      const sourceEntry = [...built.objects.values()].find((candidate) => candidate.key === from.mesh);
      const island = found.island >= 0 ? islandInfo(found.mesh, found.island) : null;
      const issue = islandPlacementIssue(island, item.kind);
      if (issue.level === "refuse") {
        say("warn", issue.text);
        return;
      }
      const sourceOrientation = sourceEntry ? orientationAt(sourceEntry.data, from.face, { up: built.axes.up, forward: built.axes.forward, width, height }) : null;
      const orientation = orientationAt(entry.data, found.face, { up: built.axes.up, forward: built.axes.forward, width, height });
      const uv = uvFromBarycentric(entry.data, found.face, found.bary);
      if (!orientation || !uv) {
        say("warn", "The other side's surface can't be read.");
        return;
      }
      const tile = island?.tile || [Math.floor(uv[0]), Math.floor(uv[1])];
      const [x, y] = uvToSheet(uv[0] - tile[0], uv[1] - tile[1], width, height, entry.data.originTop);
      const meters = itemMeters(item);
      const ppu = orientation.pixelsPerUnit;
      const w = meters && ppu > 0 ? meters.width * ppu : item.uvTransform.width * width;
      const h = meters && ppu > 0 ? meters.height * ppu : item.uvTransform.height * height;
      const right = readsRight(item.uvTransform.flipX, sourceOrientation?.mirrored);
      const wantRight = mode === "readable" ? right : !right;
      const flipX = wantRight ? Boolean(orientation.mirrored) : !orientation.mirrored;
      const existing = current.items.find((candidate) => candidate.symmetry?.of === id);
      const transform = { u: x / width, v: y / height, width: w / width, height: h / height, rotation: orientation.rotation, flipX };
      const anchor = { mesh: found.mesh, face: found.face, bary: found.bary, ...(ppu > 0 ? { ppu, sheet: [width, height] } : {}) };
      if (existing) {
        update(existing.id, (twinItem) => ({ ...twinItem, island: island ? { mesh: found.mesh, index: found.island } : null, anchor, uvTransform: transform, symmetry: { of: id, mode } }));
        setSelectedId(existing.id);
      } else {
        const twin = {
          id: makeId(),
          kind: item.kind,
          name: item.name ? `${item.name} (other side)` : "",
          source: item.source,
          island: island ? { mesh: found.mesh, index: found.island } : null,
          anchor,
          uvTransform: transform,
          opacity: item.opacity,
          blend: item.blend,
          clip: item.clip,
          hidden: item.hidden,
          symmetry: { of: id, mode },
        };
        commit((latest) => addCanvasItem(latest, twin));
        setSelectedId(twin.id);
      }
      say(issue.level, issue.text || (mode === "readable" ? "Placed on the other side, reading the right way." : "Placed on the other side as a mirror image."));
    } catch (error) {
      say("error", `The other side couldn't be found: ${errorMessage(error)}.`);
    } finally {
      setBusy("");
    }
  }, [model, renderer, sheet, islandInfo, update, commit, say]);

  const remirror = useCallback((twinId) => {
    const twin = docRef.current?.items.find((entry) => entry.id === twinId);
    if (!twin?.symmetry) return;
    const sourceId = twin.symmetry.of;
    const mode = twin.symmetry.mode;
    mirror(sourceId, mode);
  }, [mirror]);

  const unlink = useCallback((id) => update(id, (item) => ({ ...item, symmetry: null })), [update]);

  const nudge = useCallback((id, dx, dy) => {
    update(id, (item) => (item.locked ? item : { ...item, uvTransform: { ...item.uvTransform, u: item.uvTransform.u + dx / sheet.width, v: item.uvTransform.v + dy / sheet.height } }), `nudge:${id}`);
  }, [update, sheet]);

  const saveTo = useCallback(async (defaultPath, filters, bytesOrText, label) => {
    const path = await save({ defaultPath, filters });
    if (!path) return "";
    const protectedPaths = [texturePath, modelPath, ...dictionaries.list.map((entry) => entry.path), ...(docRef.current ? canvasSourcePaths(docRef.current).map((entry) => entry.path) : [])].filter(Boolean);
    if (protectedPaths.some((value) => samePath(value, path))) {
      throw new Error(`${fileNameOf(path)} is one of your source files. Choose a new file so it isn't overwritten`);
    }
    const data = typeof bytesOrText === "function" ? await bytesOrText() : bytesOrText;
    try {
      await writeFile(path, typeof data === "string" ? new TextEncoder().encode(data) : data);
    } catch (error) {
      throw new Error(writeErrorMessage(error));
    }
    say("ok", `Saved ${label} to ${fileNameOf(path)}.`);
    return path;
  }, [texturePath, modelPath, dictionaries.list, say]);

  const outputBlocker = useCallback((needsBase) => {
    const current = docRef.current;
    if (!current?.items.length) return "The canvas is empty.";
    if (missing.length) {
      const names = missing.map((entry) => fileNameOf(entry.path));
      return `${names.join(", ")} ${names.length === 1 ? "is" : "are"} missing, so ${names.length === 1 ? "its item" : "their items"} would be left out. Locate ${names.length === 1 ? "it" : "them"} under Missing files, or remove ${names.length === 1 ? "that item" : "those items"}.`;
    }
    if (current.items.some((item) => item.kind === "image" && !sources[item.source.path]?.key)) return "Wait for the canvas's images to finish loading.";
    if (current.items.some((item) => item.island && item.clip) && (model.status === "loading" || (model.status === "idle" && !modelReady))) {
      return "Wait for Cortex to finish finding the livery's parts.";
    }
    if (needsBase) {
      if (writtenOver || (pinned && base.status === "error" && samePath(base.path, pinned.path))) return `Livery ${baseSlot} already has this canvas written into it, so drawing over it again would put the canvas on twice. Choose the livery's own source file (PSD, PDN or PNG) as the base in the Livery step.`;
      if (!classification.owned) return classification.reason;
      if (base.status === "loading") return "Wait for the base livery to finish loading.";
      if (base.status !== "ready") return base.error || "The base livery isn't loaded, so there is nothing to put the canvas over.";
    }
    return "";
  }, [missing, sources, model.status, modelReady, classification, base, writtenOver, baseSlot]);

  const names = useMemo(() => canvasExportNames(modelPath), [modelPath]);

  const runExport = useCallback(async (kind) => {
    if (!docRef.current) return;
    const blocked = outputBlocker(kind === "flat");
    if (blocked) {
      say("warn", blocked);
      return;
    }
    const label = kind === "psd" ? "the layered PSD" : kind === "flat" ? "the flattened PNG" : "the transparent PNG";
    setBusy(`Exporting ${label}…`);
    try {
      const filters = kind === "psd" ? [{ name: "Photoshop", extensions: ["psd"] }] : [{ name: "PNG", extensions: ["png"] }];
      await saveTo(kind === "psd" ? names.psd : kind === "flat" ? names.flat : names.stack, filters, async () => {
        const request = composeRequest();
        if (kind !== "flat") request.baseKey = "";
        const result = await renderer().compose(request, kind);
        return result.bytes;
      }, label);
    } catch (error) {
      say("error", `Export failed: ${errorMessage(error)}.`);
    } finally {
      setBusy("");
    }
  }, [outputBlocker, names, composeRequest, renderer, saveTo, say]);

  const saveCanvas = useCallback(async () => {
    const current = docRef.current;
    if (!current) return;
    try {
      await saveTo(names.doc, [{ name: "Livery canvas", extensions: ["json"] }], serializeCanvasDoc({ ...current, model: modelPath }), "the canvas");
    } catch (error) {
      say("error", `The canvas couldn't be saved: ${errorMessage(error)}.`);
    }
  }, [names, modelPath, saveTo, say]);

  const openCanvas = useCallback(async () => {
    try {
      const picked = await open({ multiple: false, filters: [{ name: "Livery canvas", extensions: ["json"] }] });
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) return;
      const { doc: opened, dropped } = parseCanvasDoc(await readTextFile(path));
      const sameModel = !opened.model || samePath(opened.model, modelPath);
      const written = [...new Set([...(docRef.current?.written || []), ...(sameModel ? opened.written || [] : [])])].sort((a, b) => a - b);
      const next = { ...opened, model: modelPath, sheet: docRef.current?.sheet || opened.sheet, written };
      if (docRef.current) commit(() => next);
      else {
        history.clear();
        docRef.current = next;
        setDoc(next);
      }
      setSelectedId(null);
      const notes = [];
      if (opened.model && !samePath(opened.model, modelPath)) notes.push(`It was made for ${fileNameOf(opened.model)}, so parts may not line up.`);
      if (dropped.length) notes.push(`${dropped.length} ${dropped.length === 1 ? "item" : "items"} couldn't be read.`);
      say(notes.length ? "warn" : "ok", `Opened ${fileNameOf(path)}. ${notes.join(" ")}`.trim());
    } catch (error) {
      say("error", `The canvas couldn't be opened: ${errorMessage(error)}.`);
    }
  }, [modelPath, commit, history, setDoc, say]);

  const locate = useCallback(async (entry) => {
    const extensions = entry.kind === "image" ? CANVAS_IMAGE_EXTENSIONS : CANVAS_FONT_EXTENSIONS;
    const picked = await open({ multiple: false, filters: [{ name: entry.kind === "image" ? "Images" : "Fonts", extensions }] });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return;
    setSources((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !samePath(key, entry.path))));
    setFontErrors((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !samePath(key, entry.path))));
    commit((current) => relinkCanvasSource(current, entry.kind, entry.path, path));
    setSourceToken((value) => value + 1);
  }, [commit]);

  const saveKit = useCallback(async (ids) => {
    const current = docRef.current;
    if (!current) return;
    try {
      const chosen = ids.length ? ids.map((id) => current.items.find((item) => item.id === id)?.symmetry?.of || id) : current.items.map((item) => item.id);
      const kit = buildDecalKit(current, [...new Set(chosen)], `${fileNameOf(modelPath).replace(/\.[^.]+$/, "")} decals`);
      await saveTo(names.kit, [{ name: "Decal set", extensions: ["json"] }], `${JSON.stringify(kit, null, 2)}\n`, "the decal set");
    } catch (error) {
      say("error", `The decal set couldn't be saved: ${errorMessage(error)}.`);
    }
  }, [modelPath, names, saveTo, say]);

  const openKit = useCallback(async () => {
    try {
      const picked = await open({ multiple: false, filters: [{ name: "Decal set", extensions: ["json"] }] });
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) return;
      const kit = parseDecalKit(await readTextFile(path));
      for (const entry of kit.items) {
        if (entry.kind === "image") {
          try {
            await decodeCanvasImage(entry.source.path).then((bitmap) => bitmap.close?.());
          } catch (error) {
            say("warn", `${fileNameOf(entry.source.path)} from the decal set couldn't be read: ${errorMessage(error)}. Locate it after placing.`);
          }
        }
        if (entry.kind === "text") await loadCanvasFontOnPage(entry.source.font).catch(() => {});
      }
      const queue = kit.items.map((entry) => ({
        kind: entry.kind,
        shape: entry.kind === "shape" ? entry.source.shape : undefined,
        source: entry.source,
        name: entry.name,
        aspect: entry.aspect,
        size: entry.size,
        opacity: entry.opacity,
        blend: entry.blend,
        clip: entry.clip,
        flipX: entry.flipX,
      }));
      setPlacing({ ...queue[0], queue: queue.slice(1), total: queue.length, step: 1, kit: kit.name });
      say("", "");
    } catch (error) {
      say("error", `The decal set couldn't be opened: ${errorMessage(error)}.`);
    }
  }, [say]);

  const slotPlan = useCallback((number) => planCanvasSlotWrite({
    modelPath,
    dictionaries: dictionaries.list,
    signPrefix,
    number,
    sheet,
    base: classification,
  }), [modelPath, dictionaries.list, signPrefix, sheet, classification]);

  const openWrite = useCallback((number) => {
    const planned = slotPlan(number);
    const blocked = planned.blocked || outputBlocker(true);
    if (blocked) {
      say("warn", blocked);
      return;
    }
    setWriteDialog({ number, ...planned });
  }, [slotPlan, outputBlocker, say]);

  const buildForWrite = useCallback(async (item, targets) => {
    const planned = slotPlan(writeDialog?.number);
    const problem = planned.blocked || replaceOnlyProblem(planned.plan);
    if (problem) throw new Error(problem);
    const blocked = outputBlocker(true);
    if (blocked) throw new Error(blocked);
    const number = writeDialog?.number;
    pendingPinRef.current = null;
    if (Number.isInteger(number) && !pins.has(number)) {
      const before = largestCopy(slotInfo.slots.find((slot) => slot.number === number))?.texture.path || "";
      if (before) {
        const kept = classifyCanvasBase({ path: before, dictionaries: dictionaries.list, parentTextures: modelRef.current?.parentTextures || null });
        pendingPinRef.current = { number, path: before, classification: kept };
      }
    }
    const result = await renderer().compose(composeRequest(), "rgba");
    return buildLiveryTexturesFromRgba(result, targets);
  }, [slotPlan, writeDialog, outputBlocker, pins, slotInfo, dictionaries.list, renderer, composeRequest]);

  const afterWrite = useCallback(async () => {
    const number = writeDialog?.number;
    const pending = pendingPinRef.current;
    pendingPinRef.current = null;
    if (pending && pending.number === number) {
      setPins((current) => (current.has(number) ? current : new Map(current).set(number, { path: pending.path, classification: pending.classification })));
    }
    if (Number.isInteger(number)) {
      s.setLiveryCanvas((current) => (current && !(current.written || []).includes(number)
        ? { ...current, written: [...(current.written || []), number].sort((a, b) => a - b) }
        : current));
    }
    notifyLiveryDictionariesChanged(modelPath);
    await s.reloadModel?.();
  }, [writeDialog, modelPath, s]);

  const selected = doc?.items.find((item) => item.id === selectedId) || null;

  const onKeyDown = useCallback((event) => {
    if (event.defaultPrevented || event.altKey) return;
    const target = event.target;
    const onPage = target === document.body || target === document.documentElement;
    if (!onPage && !target?.closest?.(".lv-cv-stage, .lv-cv-panel")) return;
    if (target?.closest?.(EDITABLE_TARGET)) return;
    const key = event.key.toLowerCase();
    const mod = event.ctrlKey || event.metaKey;
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (mod && key === "z") {
      handled();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && key === "y") {
      handled();
      redo();
      return;
    }
    if (event.key === "Escape") {
      if (placingRef.current) setPlacing(null);
      else setSelectedId(null);
      return;
    }
    if (!selectedId) return;
    if (event.key === "Delete" || event.key === "Backspace") {
      handled();
      remove([selectedId]);
      return;
    }
    const step = event.shiftKey ? 10 : 1;
    const moves = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] };
    if (moves[key]) {
      handled();
      nudge(selectedId, ...moves[key]);
    }
  }, [redo, undo, remove, nudge, selectedId]);

  const keyHandlerRef = useRef(onKeyDown);
  keyHandlerRef.current = onKeyDown;
  const keysActive = engaged && keysEnabled && s.isActive !== false;
  useEffect(() => {
    if (!keysActive) return undefined;
    const onKey = (event) => keyHandlerRef.current(event);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keysActive]);

  return {
    available: Boolean(enabled && modelPath),
    engaged,
    doc,
    stage,
    setStage,
    sheet,
    model,
    base: { ...base, classification, slot: baseSlot },
    dictionaries,
    slots: slotInfo.slots,
    selected,
    selectedId,
    select: setSelectedId,
    placing,
    cancelPlacing: () => setPlacing(null),
    hover,
    preview,
    previewCanvas,
    overlay,
    setOverlayOn: (on) => setOverlay((current) => ({ ...current, on })),
    showOnModel,
    setShowOnModel,
    notice,
    clearNotice: () => setNotice(null),
    busy,
    missing,
    sources,
    history,
    start,
    close,
    undo,
    redo,
    commit,
    update,
    updateText,
    remove,
    reorder,
    duplicate,
    nudge,
    fitToPart,
    mirror,
    remirror,
    unlink,
    pickImage,
    pickFont,
    startText,
    startShape,
    placeOnSheet,
    hoverSheet,
    clearHover: () => setHover(null),
    runExport,
    saveCanvas,
    openCanvas,
    locate,
    saveKit,
    openKit,
    slotPlan,
    openWrite,
    writeDialog,
    closeWrite: () => setWriteDialog(null),
    buildForWrite,
    afterWrite,
    islandInfo,
    itemLabel,
    outputBlocker,
  };
}
