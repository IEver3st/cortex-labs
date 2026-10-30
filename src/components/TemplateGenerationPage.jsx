import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { open, save } from "@tauri-apps/plugin-dialog";
import { exists, stat, writeFile } from "@tauri-apps/plugin-fs";
import {
  AlertTriangle,
  Box,
  Check,
  Crosshair,
  Download,
  FolderInput,
  FolderOpen,
  MousePointer2,
  Redo2,
  RefreshCw,
  SquareDashedMousePointer,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import Viewer from "./Viewer";
import { Toggle } from "./ui/toggle";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { buildAutoTemplatePsd, resolveAutoTemplateColors } from "../lib/template-psd";
import {
  getTemplateModelPolicy,
  normalizeTemplateViewMode,
} from "../lib/template-model";
import {
  DEFAULT_VEHICLE_OVERLAY_COLOR,
  normalizeOpaqueHexColor,
  normalizeVehicleOverlayColor,
} from "../lib/template-overlay";
import {
  DEFAULT_TEMPLATE_MARKER_COLOR,
  getContainedTemplateViewport,
  markerFromDrag,
  moveTemplateMarker,
  normalizeTemplateMarkers,
  resizeTemplateMarker,
} from "../lib/template-markers";
import { editHistoryKey } from "../lib/edit-history";
import useEditHistory from "./useEditHistory";
import { loadPrefs } from "../lib/prefs";
import { openFolderPath } from "../lib/open-folder";
import { trackUsageOnce } from "../lib/usage";
import { isFsScopeError } from "../lib/capture-output";
import { AssetSlot, DeckButton, FootFact, PanelLayout, StageEmpty, splitPath } from "./workspace/parts";
import { PaneResizer, usePaneWidths } from "./workspace/PaneResizer";
import { usePaneMotion } from "./workspace/usePaneMotion";
import "./TemplateGenerationPage.css";
// Corner handle size on a selected marker box, in CSS px.
const MARKER_HANDLE_PX = 9;
const MARKER_HANDLES = ["nw", "ne", "sw", "se"];

const SIZE_OPTIONS = [4096, 2048, 1024, 512];
const NOOP = () => {};
const DEFAULT_AUTO_TEMPLATE_EXPORT_FORMAT = "psd";
const MAX_AUTO_SAVE_STAMPS = 48;
const TEMPLATE_PREVIEW_ZOOM_MIN = 0.25;
const TEMPLATE_PREVIEW_ZOOM_MAX = 8;
const TEMPLATE_PREVIEW_ZOOM_FACTOR = 1.25;

function clampTemplatePreviewZoom(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return 1;
  return Math.min(TEMPLATE_PREVIEW_ZOOM_MAX, Math.max(TEMPLATE_PREVIEW_ZOOM_MIN, numericValue));
}

function normalizeAutoTemplateExportFormat(value) {
  if (value === "png" || value === "psd_png") return value;
  return DEFAULT_AUTO_TEMPLATE_EXPORT_FORMAT;
}

function replaceFileExtension(fileName, nextExtension) {
  const safeName = typeof fileName === "string" && fileName ? fileName : "auto_template.psd";
  return safeName.replace(/\.[^.]+$/, `.${nextExtension}`);
}

function decodeBase64(base64) {
  if (typeof atob !== "function") {
    throw new Error("Base64 decode is unavailable in this runtime.");
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function pngDataUrlToBytes(dataUrl) {
  if (typeof dataUrl !== "string") {
    throw new Error("Template preview data is unavailable.");
  }
  const prefix = "data:image/png;base64,";
  if (!dataUrl.startsWith(prefix)) {
    throw new Error("Template preview format is unsupported.");
  }
  return decodeBase64(dataUrl.slice(prefix.length));
}

function buildTemplateExportOutputs({
  format,
  psdBytes,
  psdFileName,
  previewDataUrl,
  overlayPngBytes,
  overlayFileName,
}) {
  const normalizedFormat = normalizeAutoTemplateExportFormat(format);
  const outputs = [];
  const psdPayload = psdBytes instanceof Uint8Array ? psdBytes : new Uint8Array(psdBytes || []);

  if ((normalizedFormat === "psd" || normalizedFormat === "psd_png") && psdPayload.length > 0) {
    outputs.push({
      fileName: psdFileName || "auto_template.psd",
      bytes: psdPayload,
      mimeType: "application/octet-stream",
    });
  }

  if (normalizedFormat === "png" || normalizedFormat === "psd_png") {
    const pngBytes = pngDataUrlToBytes(previewDataUrl);
    outputs.push({
      fileName: replaceFileExtension(psdFileName || "auto_template.psd", "png"),
      bytes: pngBytes,
      mimeType: "image/png",
    });
  }

  // The overlay is its own deliverable: a transparent PNG painters stack
  // over a livery, saved whatever the template format is.
  if (overlayPngBytes instanceof Uint8Array && overlayPngBytes.length > 0) {
    outputs.push({
      fileName: overlayFileName || replaceFileExtension(psdFileName || "auto_template.psd", "overlay.png"),
      bytes: overlayPngBytes,
      mimeType: "image/png",
    });
  }

  return outputs;
}

function buildTemplateExportOutputsForArtifacts(format, artifacts) {
  return (Array.isArray(artifacts) ? artifacts : []).flatMap((artifact) =>
    buildTemplateExportOutputs({
      format,
      psdBytes: artifact?.bytes,
      psdFileName: artifact?.fileName,
      previewDataUrl: artifact?.previewDataUrl,
      overlayPngBytes: artifact?.overlayPngBytes,
      overlayFileName: artifact?.overlayFileName,
    }),
  );
}

function getTemplateSaveButtonLabel(format) {
  const normalizedFormat = normalizeAutoTemplateExportFormat(format);
  if (normalizedFormat === "png") return "Export PNG";
  if (normalizedFormat === "psd_png") return "Export PSD + PNG";
  return "Export PSD";
}

function normalizeWorkerBytes(rawBytes) {
  if (rawBytes instanceof Uint8Array) return rawBytes;
  if (rawBytes instanceof ArrayBuffer) return new Uint8Array(rawBytes);
  if (ArrayBuffer.isView(rawBytes)) {
    return new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
  }
  return null;
}

function createTemplateBuildJob(templateMap, options) {
  if (typeof Worker === "undefined") {
    return {
      promise: Promise.resolve(buildAutoTemplatePsd(templateMap, options)),
      cancel: NOOP,
    };
  }

  let worker;
  try {
    worker = new Worker(new URL("../lib/template-psd-worker.js", import.meta.url), {
      type: "module",
    });
  } catch {
    return {
      promise: Promise.resolve(buildAutoTemplatePsd(templateMap, options)),
      cancel: NOOP,
    };
  }

  let settled = false;
  const cleanup = () => {
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
  };

  const promise = new Promise((resolve, reject) => {
    worker.onmessage = (event) => {
      const payload = event?.data || {};
      if (payload?.error) {
        cleanup();
        settled = true;
        worker.terminate();
        reject(new Error(payload.error));
        return;
      }

      const result = payload?.result;
      const bytes = normalizeWorkerBytes(result?.bytes);
      if (!result || !bytes || !bytes.length) {
        cleanup();
        settled = true;
        worker.terminate();
        reject(new Error("Template worker returned invalid output."));
        return;
      }

      cleanup();
      settled = true;
      worker.terminate();
      resolve({ ...result, bytes, overlayPngBytes: normalizeWorkerBytes(result.overlayPngBytes) });
    };

    worker.onerror = (event) => {
      cleanup();
      settled = true;
      worker.terminate();
      const message =
        event && typeof event === "object" && "message" in event
          ? event.message
          : "Template worker failed.";
      reject(new Error(message || "Template worker failed."));
    };

    worker.onmessageerror = () => {
      cleanup();
      settled = true;
      worker.terminate();
      reject(new Error("Template worker message channel failed."));
    };

    worker.postMessage({ templateMap, options });
  });

  const cancel = () => {
    if (settled) return;
    settled = true;
    cleanup();
    worker.terminate();
  };

  return { promise, cancel };
}

function getDefaultOutputFolder() {
  const prefs = loadPrefs() || {};
  return prefs?.defaults?.variantExportFolder || "";
}

function normalizeExportSize(value) {
  const numeric = Number(value);
  return SIZE_OPTIONS.includes(numeric) ? numeric : SIZE_OPTIONS[0];
}

function normalizeAutoSaveStamps(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value).filter(
    ([path, stamp]) => typeof path === "string" && path && Number.isFinite(stamp),
  );
  return Object.fromEntries(entries.slice(-MAX_AUTO_SAVE_STAMPS));
}

async function readModifiedTime(path) {
  try {
    const info = await stat(path);
    const time = info?.mtime instanceof Date ? info.mtime.getTime() : Number(info?.mtime);
    return Number.isFinite(time) ? time : null;
  } catch {
    return null;
  }
}

/**
 * Auto-save may only replace a file it wrote itself and that nobody has
 * touched since: a template PSD is where the painter works, so an edited
 * or foreign file at the same name is left alone.
 */
async function canAutoSaveReplace(path, stamps) {
  if (!(await exists(path))) return true;
  const recorded = stamps[path];
  if (!Number.isFinite(recorded)) return false;
  return (await readModifiedTime(path)) === recorded;
}

function getDefaultAutoTemplateColors() {
  return resolveAutoTemplateColors(loadPrefs()?.defaults);
}

function getDefaultAutoTemplateExportFormat() {
  const prefs = loadPrefs() || {};
  return normalizeAutoTemplateExportFormat(prefs?.defaults?.autoTemplateExportFormat);
}

// Colour pickers fire on every drag step and each committed colour rebuilds
// the template, so the draft drives the swatch and only the settled value
// is committed.
function useSettledDraft(value, commit, delay = 220) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  useEffect(() => {
    if (draft === value) return undefined;
    const timer = setTimeout(() => commit(draft), delay);
    return () => clearTimeout(timer);
  }, [commit, delay, draft, value]);
  return [draft, setDraft];
}

function getFileLabel(path, fallback = "") {
  if (!path) return fallback;
  const parts = path.toString().split(/[\\/]/);
  return parts[parts.length - 1] || fallback;
}

function normalizeMeshNameList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean))];
}

function buildPurposeFileName(modelPath, purpose) {
  const fileName = getFileLabel(modelPath, "template.yft");
  if (purpose !== "windows") return fileName;
  const extension = fileName.match(/\.[^.]+$/)?.[0] || ".yft";
  const stem = fileName.replace(/\.[^.]+$/, "") || "template";
  return `${stem}_windows${extension}`;
}

function joinPath(folder, fileName) {
  const base = String(folder || "").replace(/[\\/]+$/, "");
  const name = String(fileName || "").replace(/^[\\/]+/, "");
  if (!base) return name;
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return `${base}${sep}${name}`;
}

function toErrorMessage(error, fallback) {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object" && "message" in error) {
    const value = error.message;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

function ensureWritableBytes(bytes) {
  if (bytes instanceof Uint8Array) {
    // Copy so transferred/detached worker buffers cannot fail on write.
    return new Uint8Array(bytes);
  }
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  return new Uint8Array(0);
}

function getSaveDialogFilters(fileName) {
  const lower = String(fileName || "").toLowerCase();
  if (lower.endsWith(".png")) {
    return [{ name: "PNG Image", extensions: ["png"] }];
  }
  return [{ name: "Photoshop Document", extensions: ["psd"] }];
}

function triggerBrowserDownload(fileName, bytes, mimeType) {
  const payload = ensureWritableBytes(bytes);
  const blob = new Blob([payload], { type: mimeType || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export default function TemplateGenerationPage({
  workspaceState,
  onStateChange,
  onRenameTab,
  settingsVersion,
  isActive,
  contextBarTarget,
}) {
  const isTauriRuntime =
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__ !== "undefined";

  const [modelPath, setModelPath] = useState(workspaceState?.modelPath || "");
  const [outputFolder, setOutputFolder] = useState(
    workspaceState?.outputFolder || getDefaultOutputFolder(),
  );
  const [autoTemplateColor, setAutoTemplateColor] = useState(() => getDefaultAutoTemplateColors().fillColor);
  const [autoTemplateBackgroundColor, setAutoTemplateBackgroundColor] = useState(
    () => getDefaultAutoTemplateColors().backgroundColor,
  );
  const [autoTemplateExportFormat, setAutoTemplateExportFormat] = useState(
    () => getDefaultAutoTemplateExportFormat(),
  );
  const [templatePurpose, setTemplatePurpose] = useState(() =>
    workspaceState?.templatePurpose === "windows" ? "windows" : "body",
  );
  const [selectedTemplatePartNames, setSelectedTemplatePartNames] = useState(() =>
    normalizeMeshNameList(workspaceState?.selectedTemplatePartNames),
  );
  const [hoveredTemplatePartName, setHoveredTemplatePartName] = useState("");
  const [useWorldSpaceNormalsAsBase, setUseWorldSpaceNormalsAsBase] = useState(() =>
    Boolean(
      (workspaceState?.useWorldSpaceNormalsAsBase ??
        workspaceState?.generateWorldSpaceNormals) ??
        true,
    ),
  );
  const [exportSize, setExportSize] = useState(() => normalizeExportSize(workspaceState?.exportSize));
  const [exteriorOnly, setExteriorOnly] = useState(Boolean(workspaceState?.exteriorOnly));
  const [includeTemplateWireframe, setIncludeTemplateWireframe] = useState(() =>
    Boolean(
      (workspaceState?.includeTemplateWireframe ??
        workspaceState?.showWireframe) ??
        true,
    ),
  );

  const [includeVehicleOverlay, setIncludeVehicleOverlay] = useState(
    () => workspaceState?.includeVehicleOverlay === true,
  );
  const [vehicleOverlayColor, setVehicleOverlayColor] = useState(() =>
    normalizeVehicleOverlayColor(workspaceState?.vehicleOverlayColor ?? DEFAULT_VEHICLE_OVERLAY_COLOR),
  );
  const [vehicleOverlayColorDraft, setVehicleOverlayColorDraft] = useSettledDraft(
    vehicleOverlayColor,
    setVehicleOverlayColor,
  );
  const [includeTemplateLogo, setIncludeTemplateLogo] = useState(
    () => workspaceState?.includeTemplateLogo !== false,
  );
  const [logoNotice, setLogoNotice] = useState("");
  const autoSaveStampsRef = useRef(normalizeAutoSaveStamps(workspaceState?.autoSaveStamps));
  const [autoSaveStampsVersion, setAutoSaveStampsVersion] = useState(0);

  const [templateMap, setTemplateMap] = useState(null);
  const [templateMapError, setTemplateMapError] = useState("");
  const [templatePsdSource, setTemplatePsdSource] = useState(null);
  const [templatePsdSourceError, setTemplatePsdSourceError] = useState("");
  const [templateSets, setTemplateSets] = useState([]);
  const [windowTemplateSets, setWindowTemplateSets] = useState([]);
  const [windowTemplateError, setWindowTemplateError] = useState("");
  const [templateSetWarning, setTemplateSetWarning] = useState("");
  // Painter-drawn marker boxes, in normalized texture space (see template-markers.js).
  const [templateMarkers, setTemplateMarkers] = useState(() =>
    normalizeTemplateMarkers(workspaceState?.templateMarkers),
  );
  const [templateMarkerColor, setTemplateMarkerColor] = useState(() =>
    normalizeOpaqueHexColor(workspaceState?.templateMarkerColor, DEFAULT_TEMPLATE_MARKER_COLOR),
  );
  const [templateMarkerColorDraft, setTemplateMarkerColorDraft] = useSettledDraft(
    templateMarkerColor,
    setTemplateMarkerColor,
  );
  const [markerToolActive, setMarkerToolActive] = useState(false);
  const [selectedMarkerId, setSelectedMarkerId] = useState("");
  // The box being drawn, moved or resized; committed on pointer up.
  const [markerDraft, setMarkerDraft] = useState(null);
  const [markerPixelCounts, setMarkerPixelCounts] = useState({});
  // Marker add, move, resize, fill and delete undo as whole-list snapshots.
  const {
    record: recordMarkerEdit,
    undo: undoMarkerEdit,
    redo: redoMarkerEdit,
    clear: clearMarkerHistory,
    canUndo: canUndoMarkers,
    canRedo: canRedoMarkers,
  } = useEditHistory();
  const templateMarkersRef = useRef(templateMarkers);
  templateMarkersRef.current = templateMarkers;
  const [previewUrl, setPreviewUrl] = useState("");
  const [psdBytes, setPsdBytes] = useState(null);
  const [psdFileName, setPsdFileName] = useState("auto_template.psd");
  const [generatedTemplates, setGeneratedTemplates] = useState([]);
  const [layerCount, setLayerCount] = useState(0);
  const [targetCount, setTargetCount] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState({ tone: "", message: "" });
  const [generationError, setGenerationError] = useState("");
  const [autoSavedPath, setAutoSavedPath] = useState("");
  const [lastGeneratedAt, setLastGeneratedAt] = useState(null);
  const [regenerationToken, setRegenerationToken] = useState(0);
  const [previewViewport, setPreviewViewport] = useState(() => ({
    size: 0,
    offsetX: 0,
    offsetY: 0,
  }));
  const [templatePreviewZoom, setTemplatePreviewZoom] = useState(1);
  const [sheetPan, setSheetPan] = useState({ x: 0, y: 0 });
  const [sheetPanning, setSheetPanning] = useState(false);
  const [viewMode, setViewMode] = useState(() =>
    normalizeTemplateViewMode(workspaceState?.viewMode),
  );
  const [modelLoading, setModelLoading] = useState(false);
  const [modelLoadError, setModelLoadError] = useState("");
  const [modelViewerReady, setModelViewerReady] = useState(false);
  const persistTimerRef = useRef(null);
  const regenerateTimerRef = useRef(null);
  const saveNoticeTimerRef = useRef(null);
  const previewShellRef = useRef(null);
  const sheetCanvasRef = useRef(null);
  const markerDragRef = useRef(null);
  const modelViewerApiRef = useRef(null);
  const templatePolicy = getTemplateModelPolicy(modelPath);
  const isWindowTemplate = templatePurpose === "windows" && !templatePolicy.isEup;

  const handleModelViewerReady = useCallback((api) => {
    modelViewerApiRef.current = api;
    setModelViewerReady(Boolean(api));
  }, []);

  const handleFrameModel = useCallback(() => {
    modelViewerApiRef.current?.reset?.();
  }, []);

  const handleRotateModel = useCallback((axis) => {
    modelViewerApiRef.current?.rotateModel?.(axis);
  }, []);

  // The sheet is a pan/zoom viewer: wheel zooms about the cursor and
  // dragging pans (middle button always; left button when zoomed in and not
  // drawing markers). The view is mirrored in a ref so rapid wheel events
  // compose without stale state.
  const sheetViewRef = useRef({ zoom: 1, pan: { x: 0, y: 0 } });
  const sheetDragRef = useRef(null);

  const clampSheetPan = useCallback((pan, zoom) => {
    const node = previewShellRef.current;
    if (!node || zoom <= 1) return { x: 0, y: 0 };
    const base = Math.max(0, Math.min(node.clientWidth, node.clientHeight) - 24);
    const half = (base * zoom) / 2;
    // Keep at least a margin of the sheet on screen.
    const maxX = Math.max(0, half + node.clientWidth / 2 - 64);
    const maxY = Math.max(0, half + node.clientHeight / 2 - 64);
    return {
      x: Math.min(maxX, Math.max(-maxX, pan.x)),
      y: Math.min(maxY, Math.max(-maxY, pan.y)),
    };
  }, []);

  const applySheetView = useCallback((zoom, pan) => {
    const nextPan = clampSheetPan(pan, zoom);
    sheetViewRef.current = { zoom, pan: nextPan };
    setTemplatePreviewZoom(zoom);
    setSheetPan(nextPan);
  }, [clampSheetPan]);

  const zoomSheet = useCallback((factor, clientX, clientY) => {
    const { zoom, pan } = sheetViewRef.current;
    let next = clampTemplatePreviewZoom(zoom * factor);
    // Land exactly on fit when passing through it.
    if (Math.abs(next - 1) < 0.04) next = 1;
    if (next === zoom) return;
    let anchorX = 0;
    let anchorY = 0;
    const node = previewShellRef.current;
    if (node && Number.isFinite(clientX) && Number.isFinite(clientY)) {
      const rect = node.getBoundingClientRect();
      anchorX = clientX - (rect.left + rect.width / 2);
      anchorY = clientY - (rect.top + rect.height / 2);
    }
    const ratio = next / zoom;
    applySheetView(next, {
      x: anchorX - (anchorX - pan.x) * ratio,
      y: anchorY - (anchorY - pan.y) * ratio,
    });
  }, [applySheetView]);

  const adjustTemplatePreviewZoom = useCallback((direction) => {
    zoomSheet(direction > 0 ? TEMPLATE_PREVIEW_ZOOM_FACTOR : 1 / TEMPLATE_PREVIEW_ZOOM_FACTOR);
  }, [zoomSheet]);

  const fitTemplatePreview = useCallback(() => {
    applySheetView(1, { x: 0, y: 0 });
  }, [applySheetView]);

  useEffect(() => {
    const node = previewShellRef.current;
    if (!node) return undefined;
    const handleWheel = (event) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      zoomSheet(event.deltaY < 0 ? 1.15 : 1 / 1.15, event.clientX, event.clientY);
    };
    node.addEventListener("wheel", handleWheel, { passive: false });
    return () => node.removeEventListener("wheel", handleWheel);
  }, [zoomSheet, modelPath]);

  const handleSheetPointerDown = useCallback((event) => {
    if (event.button !== 0 && event.button !== 1) return;
    if (sheetViewRef.current.zoom <= 1 && event.button === 0) return;
    sheetDragRef.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      pan: sheetViewRef.current.pan,
      moved: false,
    };
    if (event.button === 1) event.preventDefault();
  }, []);

  const handleSheetPointerMove = useCallback((event) => {
    const drag = sheetDragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    if (!drag.moved) {
      drag.moved = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setSheetPanning(true);
    }
    applySheetView(sheetViewRef.current.zoom, { x: drag.pan.x + dx, y: drag.pan.y + dy });
  }, [applySheetView]);

  const handleSheetPointerUp = useCallback((event) => {
    const drag = sheetDragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    sheetDragRef.current = null;
    if (drag.moved) setSheetPanning(false);
  }, []);

  const handleTemplatePreviewKeyDown = useCallback(
    (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        adjustTemplatePreviewZoom(-1);
        return;
      }
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        adjustTemplatePreviewZoom(1);
        return;
      }
      if (event.key === "0") {
        event.preventDefault();
        fitTemplatePreview();
      }
    },
    [adjustTemplatePreviewZoom, fitTemplatePreview],
  );

  useEffect(() => {
    if (modelPath) return;
    modelViewerApiRef.current = null;
    setModelViewerReady(false);
  }, [modelPath]);

  useEffect(() => {
    if (!settingsVersion) return;
    setOutputFolder((prev) => prev || getDefaultOutputFolder());
    const colors = getDefaultAutoTemplateColors();
    setAutoTemplateColor(colors.fillColor);
    setAutoTemplateBackgroundColor(colors.backgroundColor);
    setAutoTemplateExportFormat(getDefaultAutoTemplateExportFormat());
  }, [settingsVersion]);

  // onStateChange lives in a ref and is deliberately NOT an effect dep: the
  // parent re-renders after every persisted change, and listing the callback
  // here would re-arm the persist timer on each render and loop indefinitely.
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  useEffect(() => {
    if (!onStateChangeRef.current) return;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      onStateChangeRef.current?.({
        modelPath,
        outputFolder,
        templatePurpose,
        selectedTemplatePartNames,
        exportSize,
        exteriorOnly,
        includeTemplateWireframe,
        useWorldSpaceNormalsAsBase,
        includeVehicleOverlay,
        vehicleOverlayColor,
        includeTemplateLogo,
        autoSaveStamps: autoSaveStampsRef.current,
        templateMarkers,
        templateMarkerColor,
        viewMode,
      });
    }, 140);

    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, [
    modelPath,
    outputFolder,
    templatePurpose,
    selectedTemplatePartNames,
    exportSize,
    exteriorOnly,
    includeTemplateWireframe,
    useWorldSpaceNormalsAsBase,
    includeVehicleOverlay,
    vehicleOverlayColor,
    includeTemplateLogo,
    autoSaveStampsVersion,
    templateMarkers,
    templateMarkerColor,
    viewMode,
  ]);

  useEffect(() => {
    if (!templatePolicy.isEup || templatePurpose !== "windows") return;
    setTemplatePurpose("body");
    setSelectedTemplatePartNames([]);
    setHoveredTemplatePartName("");
  }, [templatePolicy.isEup, templatePurpose]);

  useEffect(() => {
    return () => {
      if (regenerateTimerRef.current) clearTimeout(regenerateTimerRef.current);
      if (saveNoticeTimerRef.current) clearTimeout(saveNoticeTimerRef.current);
    };
  }, []);

  const showSaveNotice = useCallback((tone, message, label = "") => {
    if (saveNoticeTimerRef.current) clearTimeout(saveNoticeTimerRef.current);
    setSaveNotice({ tone, message, label });
    // Failures stay until dismissed or replaced; only confirmations time out.
    if (tone !== "success") return;
    saveNoticeTimerRef.current = setTimeout(() => {
      setSaveNotice({ tone: "", message: "" });
      saveNoticeTimerRef.current = null;
    }, 4000);
  }, []);

  // Stamps are the modified time of each file this generator wrote, so a
  // later auto-save can tell its own untouched output from the painter's work.
  const recordAutoSaveStamp = useCallback(async (path) => {
    const time = await readModifiedTime(path);
    const stamps = { ...autoSaveStampsRef.current };
    delete stamps[path];
    if (time !== null) stamps[path] = time;
    autoSaveStampsRef.current = normalizeAutoSaveStamps(stamps);
    setAutoSaveStampsVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    if (!previewShellRef.current || typeof ResizeObserver === "undefined") return;

    const node = previewShellRef.current;
    const updateViewport = () => {
      setPreviewViewport(
        getContainedTemplateViewport(
          Math.max(0, (node.clientWidth || 0) - 24),
          Math.max(0, (node.clientHeight || 0) - 24),
        ),
      );
    };

    const observer = new ResizeObserver(updateViewport);
    observer.observe(node);
    updateViewport();

    return () => observer.disconnect();
  }, [previewUrl]);

  const clearGeneratedState = useCallback(() => {
    setTemplateMap(null);
    setTemplateMapError("");
    setTemplatePsdSource(null);
    setTemplatePsdSourceError("");
    setTemplateSets([]);
    setWindowTemplateSets([]);
    setWindowTemplateError("");
    setTemplateSetWarning("");
    setSelectedTemplatePartNames([]);
    setHoveredTemplatePartName("");
    // Marker boxes belong to one model's UV layout.
    setTemplateMarkers([]);
    setSelectedMarkerId("");
    setMarkerDraft(null);
    setMarkerPixelCounts({});
    setMarkerToolActive(false);
    markerDragRef.current = null;
    clearMarkerHistory();
    setPreviewUrl("");
    setPsdBytes(null);
    setPsdFileName("auto_template.psd");
    setGeneratedTemplates([]);
    setLayerCount(0);
    setTargetCount(0);
    setGenerating(false);
    setGenerationError("");
    setAutoSavedPath("");
    setLastGeneratedAt(null);
    setModelLoading(false);
    setModelLoadError("");
    if (regenerateTimerRef.current) {
      clearTimeout(regenerateTimerRef.current);
      regenerateTimerRef.current = null;
    }
  }, []);

  const handleSelectModel = useCallback(async () => {
    if (!isTauriRuntime) return;
    try {
      const selected = await open({
        filters: [{ name: "GTA V Model", extensions: ["yft", "ydd"] }],
      });
      if (typeof selected !== "string") return;
      setModelPath(selected);
      clearGeneratedState();
      const fileName = getFileLabel(selected, "Template Generator");
      if (fileName && onRenameTab) onRenameTab(`${fileName} // TEMPLATE`);
    } catch (error) {
      showSaveNotice("error", `The file picker couldn't open. ${toErrorMessage(error, "")}`.trim(), "Model not opened");
    }
  }, [clearGeneratedState, isTauriRuntime, onRenameTab, showSaveNotice]);

  const handleSelectOutputFolder = useCallback(async () => {
    if (!isTauriRuntime) return;
    try {
      const selected = await open({ directory: true });
      if (typeof selected === "string") setOutputFolder(selected);
    } catch (error) {
      showSaveNotice("error", `The folder picker couldn't open. ${toErrorMessage(error, "")}`.trim(), "Folder not chosen");
    }
  }, [isTauriRuntime, showSaveNotice]);

  const handleUnloadModel = useCallback(() => {
    setModelPath("");
    clearGeneratedState();
  }, [clearGeneratedState]);

  const handleModelInfo = useCallback((info) => {
    const nextSets = Array.isArray(info?.templateSets) ? info.templateSets : [];
    const nextWindowSets = Array.isArray(info?.windowTemplateSets)
      ? info.windowTemplateSets
      : [];
    const firstSet = nextSets[0] || null;
    setTemplateSets(nextSets);
    setWindowTemplateSets(nextWindowSets);
    setWindowTemplateError(info?.windowTemplateError || "");
    setTemplateSetWarning(info?.templateSetWarning || "");
    setTemplateMap(firstSet?.templateMap || info?.templateMap || null);
    setTemplateMapError(info?.templateMapError || "");
    setTemplatePsdSource(firstSet?.templatePsdSource || info?.templatePsdSource || null);
    setTemplatePsdSourceError(info?.templatePsdSourceError || "");
  }, []);

  // `historyKey` joins rapid repeats (arrow nudges of one marker) into one undo step.
  const updateTemplateMarkers = useCallback((updater, historyKey = null) => {
    const before = templateMarkersRef.current;
    const next = normalizeTemplateMarkers(updater(before));
    if (JSON.stringify(next) === JSON.stringify(before)) return;
    recordMarkerEdit(before, historyKey);
    templateMarkersRef.current = next;
    setTemplateMarkers(next);
    setAutoSavedPath("");
  }, [recordMarkerEdit]);

  const applyMarkerSnapshot = useCallback((snapshot) => {
    if (!snapshot) return;
    markerDragRef.current = null;
    setMarkerDraft(null);
    templateMarkersRef.current = snapshot;
    setTemplateMarkers(snapshot);
    setSelectedMarkerId((current) => (snapshot.some((marker) => marker.id === current) ? current : ""));
    setAutoSavedPath("");
  }, []);

  const handleUndoMarkers = useCallback(() => {
    applyMarkerSnapshot(undoMarkerEdit(templateMarkersRef.current));
  }, [applyMarkerSnapshot, undoMarkerEdit]);

  const handleRedoMarkers = useCallback(() => {
    applyMarkerSnapshot(redoMarkerEdit(templateMarkersRef.current));
  }, [applyMarkerSnapshot, redoMarkerEdit]);

  const handleDeleteMarker = useCallback((markerId) => {
    updateTemplateMarkers((current) => current.filter((marker) => marker.id !== markerId));
    setSelectedMarkerId((current) => (current === markerId ? "" : current));
  }, [updateTemplateMarkers]);

  const handleSetMarkerFill = useCallback((markerId, fill) => {
    updateTemplateMarkers((current) =>
      current.map((marker) => (marker.id === markerId ? { ...marker, fill } : marker)),
    );
  }, [updateTemplateMarkers]);

  const handleClearMarkers = useCallback(() => {
    updateTemplateMarkers(() => []);
    setSelectedMarkerId("");
  }, [updateTemplateMarkers]);

  // Pointer position in normalized texture space. The canvas rect already
  // includes zoom and pan, so the point matches the export at any view.
  const getSheetPoint = useCallback((event) => {
    const rect = sheetCanvasRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return null;
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  }, []);

  const handleMarkerPointerDown = useCallback((event) => {
    if (!markerToolActive || event.button !== 0) return;
    const point = getSheetPoint(event);
    if (!point) return;
    // Drawing owns the left button; the sheet must not start a pan.
    event.preventDefault();
    event.stopPropagation();
    const target = event.target instanceof Element ? event.target : null;
    const markerId = target?.closest("[data-marker-id]")?.getAttribute("data-marker-id") || "";
    const handle = target?.getAttribute("data-handle") || "";
    const origin = markerId ? templateMarkers.find((marker) => marker.id === markerId) : null;
    markerDragRef.current = {
      pointerId: event.pointerId,
      mode: origin ? (handle ? "resize" : "move") : "draw",
      handle,
      origin,
      start: point,
      clientX: event.clientX,
      clientY: event.clientY,
      moved: false,
    };
    setSelectedMarkerId(origin ? origin.id : "");
    // preventDefault above also stops focus; keep keyboard edits working.
    previewShellRef.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, [getSheetPoint, markerToolActive, templateMarkers]);

  const handleMarkerPointerMove = useCallback((event) => {
    const drag = markerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    if (!drag.moved && Math.hypot(event.clientX - drag.clientX, event.clientY - drag.clientY) < 3) return;
    drag.moved = true;
    const point = getSheetPoint(event);
    if (!point) return;
    if (drag.mode === "draw") {
      setMarkerDraft(markerFromDrag(drag.start, point, "__draft__"));
    } else if (drag.mode === "move") {
      setMarkerDraft(moveTemplateMarker(drag.origin, point.x - drag.start.x, point.y - drag.start.y));
    } else {
      setMarkerDraft(resizeTemplateMarker(drag.origin, drag.handle, point));
    }
  }, [getSheetPoint]);

  const handleMarkerPointerUp = useCallback((event) => {
    const drag = markerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    markerDragRef.current = null;
    const draft = markerDraft;
    setMarkerDraft(null);
    if (!drag.moved || !draft || event.type === "pointercancel") return;
    if (drag.mode === "draw") {
      const created = markerFromDrag({ x: draft.x, y: draft.y }, { x: draft.x + draft.w, y: draft.y + draft.h });
      if (!created) return;
      updateTemplateMarkers((current) => [...current, created]);
      setSelectedMarkerId(created.id);
    } else {
      updateTemplateMarkers((current) =>
        current.map((marker) => (marker.id === drag.origin.id ? { ...draft, id: marker.id } : marker)),
      );
    }
  }, [markerDraft, updateTemplateMarkers]);

  const handleSheetKeyDown = useCallback((event) => {
    if (markerToolActive && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const selected = templateMarkers.find((marker) => marker.id === selectedMarkerId);
      if (event.key === "Escape") {
        event.preventDefault();
        if (selected) setSelectedMarkerId("");
        else setMarkerToolActive(false);
        return;
      }
      if (selected && (event.key === "Delete" || event.key === "Backspace")) {
        event.preventDefault();
        handleDeleteMarker(selected.id);
        return;
      }
      const nudge = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (selected && nudge) {
        event.preventDefault();
        // One texture pixel per press, ten with Shift.
        const step = (event.shiftKey ? 10 : 1) / exportSize;
        updateTemplateMarkers((current) =>
          current.map((marker) =>
            marker.id === selected.id ? moveTemplateMarker(marker, nudge[0] * step, nudge[1] * step) : marker,
          ),
          `nudge:${selected.id}`,
        );
        return;
      }
    }
    handleTemplatePreviewKeyDown(event);
  }, [
    exportSize,
    handleDeleteMarker,
    handleTemplatePreviewKeyDown,
    markerToolActive,
    selectedMarkerId,
    templateMarkers,
    updateTemplateMarkers,
  ]);

  const handleTemplatePurposeChange = useCallback((nextPurpose) => {
    const normalized = nextPurpose === "windows" ? "windows" : "body";
    setTemplatePurpose(normalized);
    setHoveredTemplatePartName("");
    setMarkerToolActive(false);
    setGenerationError("");
    setAutoSavedPath("");
  }, []);

  const handleTemplatePartHover = useCallback((hit) => {
    setHoveredTemplatePartName(hit?.meshName || "");
  }, []);

  const handleTemplatePartPick = useCallback((hit) => {
    const meshName = typeof hit?.meshName === "string" ? hit.meshName.trim() : "";
    if (!meshName) return;
    setSelectedTemplatePartNames((current) =>
      current.includes(meshName)
        ? current.filter((entry) => entry !== meshName)
        : [...current, meshName],
    );
    setHoveredTemplatePartName(meshName);
    setGenerationError("");
    setAutoSavedPath("");
  }, []);

  const handleRemoveTemplatePart = useCallback((meshName) => {
    setSelectedTemplatePartNames((current) => current.filter((entry) => entry !== meshName));
    setHoveredTemplatePartName((current) => (current === meshName ? "" : current));
    setGenerationError("");
    setAutoSavedPath("");
  }, []);

  const handleRegenerateTemplate = useCallback(() => {
    if (
      !modelPath ||
      !templateMap ||
      !templatePsdSource ||
      generating ||
      (isWindowTemplate && selectedTemplatePartNames.length === 0)
    ) return;
    setGenerating(true);
    setGenerationError("");
    setAutoSavedPath("");
    if (regenerateTimerRef.current) clearTimeout(regenerateTimerRef.current);
    regenerateTimerRef.current = setTimeout(() => {
      setRegenerationToken((token) => token + 1);
      regenerateTimerRef.current = null;
    }, 180);
  }, [
    generating,
    isWindowTemplate,
    modelPath,
    selectedTemplatePartNames.length,
    templateMap,
    templatePsdSource,
  ]);

  useEffect(() => {
    const upstreamError = isWindowTemplate
      ? windowTemplateError
      : templateMapError || templatePsdSourceError || "";
    const sourceTemplateSets = isWindowTemplate ? windowTemplateSets : templateSets;
    const generationSets =
      sourceTemplateSets.length > 0
        ? sourceTemplateSets
        : !isWindowTemplate && templateMap && templatePsdSource
          ? [
              {
                id: `${templatePolicy.format}:model`,
                fileType: templatePolicy.format,
                modelFileName: getFileLabel(modelPath, "template"),
                templateMap,
                templatePsdSource,
              },
            ]
          : [];

    if (
      !modelPath ||
      generationSets.length === 0 ||
      (isWindowTemplate && selectedTemplatePartNames.length === 0)
    ) {
      setPreviewUrl("");
      setPsdBytes(null);
      setGeneratedTemplates([]);
      setGenerationError(upstreamError);
      setLayerCount(0);
      setTargetCount(0);
      setMarkerPixelCounts({});
      setAutoSavedPath("");
      setGenerating(false);
      return;
    }

    let cancelled = false;
    const cancelBuildJobs = new Set();
    const generate = async () => {
      setGenerating(true);
      setGenerationError(upstreamError);

      try {
        const artifacts = [];
        for (let index = 0; index < generationSets.length; index += 1) {
          if (cancelled) return;
          const templateSet = generationSets[index];
          const setPolicy = getTemplateModelPolicy(templateSet.fileType || modelPath);
          const isPrimaryTemplate = index === 0;
          const modelFileName = isWindowTemplate
            ? buildPurposeFileName(templateSet.modelFileName || modelPath, "windows")
            : templateSet.modelFileName || getFileLabel(modelPath, "template");
          const buildOptions = {
            size: exportSize,
            modelPath,
            modelFileName,
            templatePsdSource: templateSet.templatePsdSource,
            sourceFormat: setPolicy.format,
            meshSelectionMode: isWindowTemplate ? "selected" : setPolicy.meshSelectionMode,
            selectedMeshNames: isWindowTemplate ? selectedTemplatePartNames : undefined,
            fillColor: autoTemplateColor,
            backgroundColor: autoTemplateBackgroundColor,
            preferredTarget: isWindowTemplate ? "" : setPolicy.preferredTarget,
            includeVehicleLayers: !isWindowTemplate && setPolicy.includeVehicleLayers,
            includeWireframe: includeTemplateWireframe,
            includeWorldSpaceNormals: useWorldSpaceNormalsAsBase,
            useWorldSpaceNormalsAsBase,
            includeVehicleOverlay: includeVehicleOverlay && setPolicy.includeVehicleLayers,
            vehicleOverlayColor,
            includeLogo: includeTemplateLogo,
            // Boxes are drawn on the primary body sheet, so only it carries them.
            templateMarkers: isPrimaryTemplate && !isWindowTemplate ? templateMarkers : [],
            templateMarkerColor,
          };

          const buildJob = createTemplateBuildJob(templateSet.templateMap, buildOptions);
          cancelBuildJobs.add(buildJob.cancel);
          let result;
          try {
            result = await buildJob.promise;
          } catch {
            if (cancelled) return;
            result = await buildAutoTemplatePsd(templateSet.templateMap, buildOptions);
          } finally {
            cancelBuildJobs.delete(buildJob.cancel);
          }
          artifacts.push({ ...result, templateSetId: templateSet.id });
        }

        if (cancelled) return;
        const primaryResult = artifacts[0];
        setGeneratedTemplates(artifacts);
        setPreviewUrl(primaryResult.previewDataUrl);
        setPsdBytes(ensureWritableBytes(primaryResult.bytes));
        setPsdFileName(primaryResult.fileName);
        setLayerCount(artifacts.reduce((sum, artifact) => sum + (artifact.layerCount || 0), 0));
        setTargetCount(artifacts.reduce((sum, artifact) => sum + (artifact.targetCount || 0), 0));
        setMarkerPixelCounts(primaryResult.markerPixelCounts || {});
        setLastGeneratedAt(new Date());
        setGenerationError("");
        setLogoNotice(
          primaryResult.logoStatus === "placed" || primaryResult.logoStatus === "off"
            ? ""
            : primaryResult.logoMessage || "The Cortex logo could not be added.",
        );

        const exportOutputs = buildTemplateExportOutputsForArtifacts(
          autoTemplateExportFormat,
          artifacts,
        );

        if (isTauriRuntime && outputFolder && exportOutputs.length > 0) {
          const savedPaths = [];
          const keptNames = [];
          let failure = null;
          for (const output of exportOutputs) {
            // A newer build owns the folder once this one is superseded.
            if (cancelled) return;
            const autoPath = joinPath(outputFolder, output.fileName);
            try {
              if (!(await canAutoSaveReplace(autoPath, autoSaveStampsRef.current))) {
                keptNames.push(output.fileName);
                continue;
              }
              await writeFile(autoPath, ensureWritableBytes(output.bytes));
              savedPaths.push(autoPath);
              await recordAutoSaveStamp(autoPath);
            } catch (error) {
              failure = { fileName: output.fileName, message: toErrorMessage(error, "") };
              break;
            }
          }
          if (cancelled) return;
          setAutoSavedPath(savedPaths.join(" | "));
          const count = savedPaths.length;
          if (count > 0) trackUsageOnce("template", modelPath);
          const savedText = count > 0 ? `Saved ${count} template file${count === 1 ? "" : "s"}. ` : "";
          if (failure) {
            showSaveNotice(
              "error",
              `${savedText}Auto-save could not write ${failure.fileName}. ${failure.message}`.trim(),
            );
          } else if (keptNames.length > 0) {
            showSaveNotice(
              "error",
              `${savedText}Left ${keptNames.join(", ")} untouched because it changed outside this build. Export to replace it.`,
            );
          } else if (count > 0) {
            showSaveNotice("success", `Saved ${count} template file${count === 1 ? "" : "s"}`);
          }
        } else {
          setAutoSavedPath("");
        }
      } catch (error) {
        if (cancelled) return;
        const message =
          error && typeof error === "object" && "message" in error
            ? error.message
            : "Template generation failed.";
        setGenerationError(message);
        setPreviewUrl("");
        setPsdBytes(null);
        setGeneratedTemplates([]);
        setLayerCount(0);
        setTargetCount(0);
        setMarkerPixelCounts({});
        setAutoSavedPath("");
      } finally {
        if (!cancelled) {
          setGenerating(false);
        }
      }
    };

    generate();
    return () => {
      cancelled = true;
      for (const cancelBuildJob of cancelBuildJobs) cancelBuildJob();
      cancelBuildJobs.clear();
    };
  }, [
    templateMap,
    templateMapError,
    templatePsdSource,
    templatePsdSourceError,
    templateSets,
    windowTemplateSets,
    windowTemplateError,
    isWindowTemplate,
    selectedTemplatePartNames,
    exportSize,
    modelPath,
    outputFolder,
    autoTemplateColor,
    autoTemplateBackgroundColor,
    autoTemplateExportFormat,
    includeTemplateWireframe,
    useWorldSpaceNormalsAsBase,
    includeVehicleOverlay,
    vehicleOverlayColor,
    includeTemplateLogo,
    recordAutoSaveStamp,
    templateMarkers,
    templateMarkerColor,
    regenerationToken,
    isTauriRuntime,
    showSaveNotice,
    templatePolicy.format,
  ]);

  const handleSaveTemplate = useCallback(async () => {
    if (isSaving) return;

    let exportOutputs;
    try {
      exportOutputs =
        generatedTemplates.length > 0
          ? buildTemplateExportOutputsForArtifacts(autoTemplateExportFormat, generatedTemplates)
          : buildTemplateExportOutputs({
              format: autoTemplateExportFormat,
              psdBytes,
              psdFileName,
              previewDataUrl: previewUrl,
            });
    } catch (error) {
      const message = toErrorMessage(error, "Template export failed.");
      showSaveNotice("error", message);
      return;
    }
    if (exportOutputs.length === 0) {
      const message = "Nothing to save yet. Generate a template first.";
      showSaveNotice("error", message);
      return;
    }

    const confirmSave = (savedPaths) => {
      setAutoSavedPath(savedPaths.join(" | "));
      const count = savedPaths.length;
      showSaveNotice("success", `Saved ${count} template file${count === 1 ? "" : "s"}`);
      trackUsageOnce("template", modelPath || psdFileName);
    };

    const writeOutputsToFolder = async (folder) => {
      const savedPaths = [];
      for (const output of exportOutputs) {
        const filePath = joinPath(folder, output.fileName);
        try {
          await writeFile(filePath, ensureWritableBytes(output.bytes));
        } catch (error) {
          if (savedPaths.length > 0) {
            // Partial export: say what landed instead of hiding it behind a dialog.
            const partial = new Error(
              `Saved ${savedPaths.length} of ${exportOutputs.length} files, then could not write ${output.fileName}. ${toErrorMessage(error, "")}`.trim(),
            );
            partial.partial = true;
            throw partial;
          }
          const failed = new Error(`Could not write ${filePath}. ${toErrorMessage(error, "")}`.trim());
          failed.scope = isFsScopeError(error);
          throw failed;
        }
        savedPaths.push(filePath);
        await recordAutoSaveStamp(filePath);
      }
      return savedPaths;
    };

    setIsSaving(true);
    setAutoSavedPath("");
    try {
      if (isTauriRuntime) {
        if (outputFolder) {
          try {
            const savedPaths = await writeOutputsToFolder(outputFolder);
            confirmSave(savedPaths);
            return;
          } catch (error) {
            // Only a folder outside the granted fs scope (picked in an earlier
            // session) is fixed by choosing it again in a dialog. Disk, lock and
            // permission failures are reported with the path instead.
            if (!error?.scope) throw error;
          }
        }

        if (exportOutputs.length === 1) {
          const output = exportOutputs[0];
          const filePath = await save({
            defaultPath: outputFolder
              ? joinPath(outputFolder, output.fileName)
              : output.fileName,
            filters: getSaveDialogFilters(output.fileName),
          });
          if (!filePath) return;
          await writeFile(filePath, ensureWritableBytes(output.bytes));
          await recordAutoSaveStamp(filePath);
          confirmSave([filePath]);
          return;
        }

        // Multi-file export: pick a folder (dialog grants temporary write access).
        const selectedFolder = await open({
          directory: true,
          title: "Choose folder for template export",
          defaultPath: outputFolder || undefined,
        });
        if (typeof selectedFolder !== "string" || !selectedFolder) return;
        const savedPaths = await writeOutputsToFolder(selectedFolder);
        setOutputFolder(selectedFolder);
        confirmSave(savedPaths);
        return;
      }

      // Browser runtime fallback.
      for (const output of exportOutputs) {
        triggerBrowserDownload(output.fileName, output.bytes, output.mimeType);
      }
      confirmSave(exportOutputs.map((output) => output.fileName));
    } catch (error) {
      const message = toErrorMessage(error, "Failed to save template.");
      showSaveNotice("error", message);
    } finally {
      setIsSaving(false);
    }
  }, [
    autoTemplateExportFormat,
    generatedTemplates,
    isSaving,
    isTauriRuntime,
    modelPath,
    outputFolder,
    previewUrl,
    psdBytes,
    psdFileName,
    recordAutoSaveStamp,
    showSaveNotice,
  ]);

  const handleOpenOutputFolder = useCallback(async () => {
    if (!isTauriRuntime || !outputFolder) return;
    if (await openFolderPath(outputFolder)) return;
    showSaveNotice("error", `Windows couldn't open ${outputFolder}.`, "Folder not opened");
  }, [isTauriRuntime, outputFolder, showSaveNotice]);

  const [dockOpen, setDockOpen] = useState(true);
  const panes = usePaneWidths("cortex.template.panes");
  const rootRef = useRef(null);
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  useEffect(() => setNoticeDismissed(false), [saveNotice]);

  const modelFileName = getFileLabel(modelPath, "");
  const activeTemplateSets = isWindowTemplate ? windowTemplateSets : templateSets;
  const templateBatchCount = Math.max(activeTemplateSets.length, generatedTemplates.length, 1);
  const canRegenerate = Boolean(
    modelPath &&
      templateMap &&
      templatePsdSource &&
      !generating &&
      !isSaving &&
      (!isWindowTemplate || selectedTemplatePartNames.length > 0),
  );
  const baseSaveButtonLabel = getTemplateSaveButtonLabel(autoTemplateExportFormat);
  const saveButtonLabel =
    templateBatchCount > 1 ? `${baseSaveButtonLabel} (${templateBatchCount})` : baseSaveButtonLabel;
  const activeWindowTemplateSet = windowTemplateSets[0] || null;
  const windowTemplateMap = activeWindowTemplateSet?.templateMap || null;
  const inferredWindowTarget = windowTemplateMap?.inference?.windowTarget || "";
  const suggestedWindowPartNames = normalizeMeshNameList(
    (windowTemplateMap?.targets?.[inferredWindowTarget] || []).map((entry) => entry?.meshName),
  );
  const availableWindowPartNames = normalizeMeshNameList(
    (activeWindowTemplateSet?.templatePsdSource?.meshes || []).map((mesh) => mesh?.meshName),
  )
    .filter((meshName) => !selectedTemplatePartNames.includes(meshName))
    .sort((a, b) => a.localeCompare(b));
  const selectedTextureTargets = selectedTemplatePartNames.map((name) => `mesh:${name}`);
  const templatePreviewDisplaySize = previewViewport.size * templatePreviewZoom;
  const sheetPxToUnit = templatePreviewDisplaySize > 0 ? 1 / templatePreviewDisplaySize : 0;
  const markersAvailable = !isWindowTemplate && Boolean(previewUrl);
  const markerDrawing = markersAvailable && markerToolActive;

  // Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) undo and redo marker edits anywhere on
  // the page while markers can be edited; text fields keep their own undo.
  useEffect(() => {
    if (!isActive || !markersAvailable) return undefined;
    const onKeyDown = (event) => {
      const target = event.target;
      if (event.defaultPrevented || target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName)) return;
      const action = editHistoryKey(event);
      if (!action) return;
      event.preventDefault();
      if (action === "undo") handleUndoMarkers();
      else handleRedoMarkers();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isActive, markersAvailable, handleUndoMarkers, handleRedoMarkers]);
  // Show the box being dragged in place of the committed one.
  const displayedMarkers = markerDraft
    ? markerDraft.id === "__draft__"
      ? [...templateMarkers, markerDraft]
      : templateMarkers.map((marker) => (marker.id === markerDraft.id ? markerDraft : marker))
    : templateMarkers;

  const outputFormatLabel =
    autoTemplateExportFormat === "png"
      ? "PNG"
      : autoTemplateExportFormat === "psd_png"
        ? "PSD + PNG"
        : "PSD";
  const exportDisabled = Boolean(!psdBytes || generating || isSaving);
  const exportDisabledReason = !modelPath
    ? "Open a model to build its template."
    : modelLoadError
      ? "Export needs a model that loads."
      : isWindowTemplate && selectedTemplatePartNames.length === 0
        ? "Pick at least one window part on the model."
        : generationError
          ? "The last build failed. See the template pane."
          : generating
            ? "Building the template…"
            : !psdBytes
              ? "Waiting for the first build."
              : "";
  const viewerBlocked = !modelViewerReady || modelLoading || Boolean(modelLoadError);
  const modelDone = Boolean(modelPath && modelViewerReady && !modelLoadError && !modelLoading);
  const targetDone = modelDone && (isWindowTemplate ? selectedTemplatePartNames.length > 0 : Boolean(previewUrl));
  const markersDone = templateMarkers.length > 0;
  const showModelPane = viewMode !== "template";
  const showSheetPane = viewMode !== "model";
  const savedPaths = autoSavedPath ? autoSavedPath.split(" | ") : [];
  const savedSummary = savedPaths.length
    ? savedPaths.length === 1
      ? getFileLabel(savedPaths[0], savedPaths[0])
      : `${savedPaths.length} files`
    : "";
  const buildSummary = previewUrl
    ? `${layerCount} layer${layerCount === 1 ? "" : "s"} · ${targetCount} target${targetCount === 1 ? "" : "s"}`
    : "";
  const updatedLabel = lastGeneratedAt
    ? lastGeneratedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";
  const showNotice = Boolean(saveNotice.message) && !noticeDismissed;

  const contextBar =
    isActive && contextBarTarget
      ? createPortal(
          <div className="ctx-bar-inner lv-ctx">
            <PanelLayout start={{ shown: dockOpen, onToggle: () => setDockOpen((open) => !open), label: dockOpen ? "Hide the template steps" : "Show the template steps" }} />
          </div>,
          contextBarTarget,
        )
      : null;

  const rootClass = `lv-root tm-root ${dockOpen ? "" : "is-dock-closed"}`;
  usePaneMotion(rootRef, rootClass);

  return (
    <main
      ref={rootRef}
      className={rootClass}
      style={panes.style}
      aria-label="Template Generator"
    >
      {contextBar}

      {/* ──── Steps ──── */}
      <aside className="lv-dock" aria-label="Template steps" inert={!dockOpen}>
        <div className="lv-dock-scroll custom-scrollbar">
          <AssetSlot
            id="tm-model"
            step={1}
            title="Model"
            path={modelPath}
            done={modelDone}
            emptyTitle="Open a model"
            emptyHint=".yft vehicle or .ydd clothing model."
            onPick={handleSelectModel}
            onUnload={handleUnloadModel}
          >
            {!modelPath && !isTauriRuntime ? (
              <p className="lv-slot-note">Opening models needs the desktop app.</p>
            ) : null}
            {modelPath ? (
              modelLoading ? (
                <p className="lv-slot-note is-idle">
                  <span className="lv-dot" aria-hidden="true" />
                  Loading model…
                </p>
              ) : modelLoadError ? (
                <p className="lv-slot-note is-error">
                  <span className="lv-dot" aria-hidden="true" />
                  {modelLoadError}
                </p>
              ) : (
                <p className="lv-slot-note is-ok">
                  <span className="lv-dot" aria-hidden="true" />
                  {templatePolicy.label} · .{templatePolicy.format}
                  {templateBatchCount > 1 ? ` · ${templateBatchCount} templates` : ""}
                </p>
              )
            ) : null}
            {templateSetWarning ? (
              <p className="lv-slot-note is-warn">
                <AlertTriangle className="tm-note-icon" aria-hidden="true" />
                {templateSetWarning}
              </p>
            ) : null}
          </AssetSlot>

          <Step
            id="tm-target"
            step={2}
            title="Paint area"
            done={modelPath ? targetDone : false}
            disabled={!modelPath}
            note="Open a model to choose what the template covers."
            hint="What the template covers: the body or garment, or the glass you pick"
          >
            <div className="lv-seg" role="radiogroup" aria-label="Paint area">
              <button
                type="button"
                role="radio"
                aria-checked={!isWindowTemplate}
                className={`lv-seg-btn ${!isWindowTemplate ? "is-on" : ""}`}
                onClick={() => handleTemplatePurposeChange("body")}
              >
                {templatePolicy.isEup ? "Garment" : "Body"}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={isWindowTemplate}
                className={`lv-seg-btn ${isWindowTemplate ? "is-on" : ""}`}
                onClick={() => handleTemplatePurposeChange("windows")}
                disabled={templatePolicy.isEup}
                title={templatePolicy.isEup ? "Window templates are for vehicle models." : undefined}
              >
                Windows
              </button>
            </div>

            {isWindowTemplate ? (
              <>
                <p className="lv-slot-note" title="Every pane you pick shares one texture">
                  Click glass on the model to add or remove it.
                </p>
                {selectedTemplatePartNames.length > 0 ? (
                  <ul className="tm-parts" aria-label="Selected window parts">
                    {selectedTemplatePartNames.map((meshName) => (
                      <li
                        key={meshName}
                        className={`tm-part ${hoveredTemplatePartName === meshName ? "is-hovered" : ""}`}
                      >
                        <span className="tm-part-name" title={meshName}>{meshName}</span>
                        <button
                          type="button"
                          className="cx-icon-btn"
                          onClick={() => handleRemoveTemplatePart(meshName)}
                          aria-label={`Remove ${meshName}`}
                          title={`Remove ${meshName}`}
                        >
                          <X aria-hidden="true" />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="tm-part-tools">
                  {availableWindowPartNames.length > 0 ? (
                    <Select
                      value=""
                      onValueChange={(meshName) => {
                        if (!meshName) return;
                        setSelectedTemplatePartNames((current) =>
                          current.includes(meshName) ? current : [...current, meshName],
                        );
                        setGenerationError("");
                        setAutoSavedPath("");
                      }}
                    >
                      <SelectTrigger className="tm-part-add" aria-label="Add a model part">
                        <SelectValue placeholder="Add a part by name…" />
                      </SelectTrigger>
                      <SelectContent>
                        {availableWindowPartNames.map((meshName) => (
                          <SelectItem key={meshName} value={meshName}>
                            {meshName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                  {suggestedWindowPartNames.length > 0 && selectedTemplatePartNames.length === 0 ? (
                    <button
                      type="button"
                      className="cx-btn lv-btn-sm"
                      onClick={() => setSelectedTemplatePartNames(suggestedWindowPartNames)}
                    >
                      <Check aria-hidden="true" />
                      Use detected glass
                    </button>
                  ) : null}
                  {selectedTemplatePartNames.length > 0 ? (
                    <button
                      type="button"
                      className="cx-btn is-quiet lv-btn-sm"
                      onClick={() => setSelectedTemplatePartNames([])}
                    >
                      Clear
                    </button>
                  ) : null}
                </div>
              </>
            ) : (
              <p className={`lv-slot-note ${targetDone ? "is-ok" : "is-idle"}`}>
                <span className="lv-dot" aria-hidden="true" />
                {templatePolicy.isEup
                  ? "All garment geometry, detected from the model."
                  : "Primary paint geometry, detected from the model."}
              </p>
            )}
          </Step>

          {!isWindowTemplate ? (
            <Step
              id="tm-markers"
              step={3}
              title="Markers"
              done={markersDone}
              disabled={!markersAvailable}
              note={
                modelPath
                  ? "Draw markers once the template is built."
                  : "Open a model to add markers."
              }
              hint="Box small pieces so they show up on the texture. The paint inside a box takes the marker colour, exactly where you drew it."
              trailing={
                templateMarkers.length > 0 ? (
                  <button type="button" className="cx-btn is-quiet lv-btn-sm" onClick={handleClearMarkers}>
                    <X aria-hidden="true" />
                    Clear
                  </button>
                ) : null
              }
            >
              <p className="lv-slot-note">Optional. Drag a box over pieces on the template.</p>
              <button
                type="button"
                className={`cx-btn lv-btn-sm tm-draw-btn ${markerToolActive ? "is-on" : ""}`}
                aria-pressed={markerToolActive}
                onClick={() => setMarkerToolActive((active) => !active)}
              >
                <SquareDashedMousePointer aria-hidden="true" />
                {markerToolActive ? "Stop drawing" : "Draw markers"}
              </button>
              {templateMarkers.length > 0 ? (
                <ol className="tm-marker-list" aria-label="Markers">
                  {templateMarkers.map((marker, index) => {
                    const empty = markerPixelCounts[marker.id] === 0;
                    const widthPx = Math.max(1, Math.round(marker.w * exportSize));
                    const heightPx = Math.max(1, Math.round(marker.h * exportSize));
                    return (
                      <li
                        key={marker.id}
                        className={`tm-marker-row ${selectedMarkerId === marker.id ? "is-selected" : ""}`}
                      >
                        <button
                          type="button"
                          className="tm-marker-pick"
                          onClick={() => {
                            setSelectedMarkerId(marker.id);
                            setMarkerToolActive(true);
                          }}
                          aria-label={`Select marker ${index + 1}`}
                        >
                          <span className="cx-display">{index + 1}</span>
                          <span className="tm-marker-size">
                            {widthPx} × {heightPx}
                          </span>
                          {empty ? <span className="tm-marker-warn">No paint inside</span> : null}
                        </button>
                        <div className="lv-seg tm-marker-fill" role="radiogroup" aria-label={`Marker ${index + 1} fill`}>
                          {[
                            ["pieces", "Pieces"],
                            ["box", "Box"],
                          ].map(([fill, label]) => (
                            <button
                              key={fill}
                              type="button"
                              role="radio"
                              aria-checked={marker.fill === fill}
                              className={`lv-seg-btn ${marker.fill === fill ? "is-on" : ""}`}
                              onClick={() => handleSetMarkerFill(marker.id, fill)}
                              title={
                                fill === "pieces"
                                  ? "Colour only the paint geometry inside the box"
                                  : "Colour the whole box"
                              }
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        <button
                          type="button"
                          className="cx-icon-btn"
                          onClick={() => handleDeleteMarker(marker.id)}
                          aria-label={`Delete marker ${index + 1}`}
                          title="Delete marker"
                        >
                          <X aria-hidden="true" />
                        </button>
                      </li>
                    );
                  })}
                </ol>
              ) : null}
              <label className="tm-color-row">
                <span className="tm-color-chip" style={{ "--chip": templateMarkerColorDraft }}>
                  <input
                    type="color"
                    value={templateMarkerColorDraft}
                    onChange={(event) =>
                      setTemplateMarkerColorDraft(
                        normalizeOpaqueHexColor(event.target.value, DEFAULT_TEMPLATE_MARKER_COLOR),
                      )
                    }
                    aria-label="Marker colour"
                  />
                </span>
                <span className="tm-color-label">Marker colour</span>
                <span className="tm-color-hex">{templateMarkerColorDraft.toUpperCase()}</span>
              </label>
            </Step>
          ) : null}

          <Step
            id="tm-output"
            step={isWindowTemplate ? 3 : 4}
            title="Output"
            done={Boolean(autoSavedPath)}
            disabled={!modelPath}
            note="Open a model to set the output."
            hint="Resolution and layers for the generated file"
          >
            <div className="lv-field">
              <span className="cx-label">Resolution</span>
              <div className="lv-seg" role="radiogroup" aria-label="Template resolution">
                {SIZE_OPTIONS.map((size) => (
                  <button
                    key={size}
                    type="button"
                    role="radio"
                    aria-checked={exportSize === size}
                    aria-label={`${size} by ${size} pixels`}
                    className={`lv-seg-btn ${exportSize === size ? "is-on" : ""}`}
                    onClick={() => setExportSize(size)}
                  >
                    {size >= 1024 ? `${size / 1024}K` : size}
                  </button>
                ))}
              </div>
            </div>
            <div className="tm-options">
              <div className="tm-option">
                <span>
                  <strong>Wireframe layer</strong>
                  <small>UV edges on their own layer</small>
                </span>
                <Toggle
                  checked={includeTemplateWireframe}
                  onChange={setIncludeTemplateWireframe}
                  ariaLabel="Include wireframe layer"
                />
              </div>
              <div className="tm-option">
                <span>
                  <strong>Shaded base</strong>
                  <small>World-space normals under the fill</small>
                </span>
                <Toggle
                  checked={useWorldSpaceNormalsAsBase}
                  onChange={setUseWorldSpaceNormalsAsBase}
                  ariaLabel="Use world-space normals as the base"
                />
              </div>
              {templatePolicy.includeVehicleLayers ? (
                <div className="tm-option-block">
                  <div className="tm-option" title="Solid panel shapes, at least 5 px past every edge. Also saved as its own PNG.">
                    <span>
                      <strong>Vehicle overlay</strong>
                      <small>Solid panel shapes, also as a PNG</small>
                    </span>
                    <Toggle
                      checked={includeVehicleOverlay}
                      onChange={setIncludeVehicleOverlay}
                      ariaLabel="Include vehicle overlay"
                    />
                  </div>
                  {includeVehicleOverlay ? (
                    <label className="tm-color-row">
                      <span className="tm-color-chip" style={{ "--chip": vehicleOverlayColorDraft }}>
                        <input
                          type="color"
                          value={vehicleOverlayColorDraft}
                          onChange={(event) =>
                            setVehicleOverlayColorDraft(normalizeVehicleOverlayColor(event.target.value))
                          }
                          aria-label="Overlay colour"
                        />
                      </span>
                      <span className="tm-color-label">Overlay colour</span>
                      <span className="tm-color-hex">{vehicleOverlayColorDraft.toUpperCase()}</span>
                    </label>
                  ) : null}
                </div>
              ) : null}
              <div className="tm-option">
                <span>
                  <strong>Cortex logo</strong>
                  <small>
                    {includeTemplateLogo && logoNotice
                      ? logoNotice
                      : "Placed in clear space on its own layer"}
                  </small>
                </span>
                <Toggle
                  checked={includeTemplateLogo}
                  onChange={setIncludeTemplateLogo}
                  ariaLabel="Include the Cortex logo"
                />
              </div>
              {templatePolicy.supportsExteriorOnly ? (
                <div className="tm-option">
                  <span>
                    <strong>Exterior only</strong>
                    <small>Leave out interior geometry</small>
                  </span>
                  <Toggle
                    checked={exteriorOnly}
                    onChange={setExteriorOnly}
                    ariaLabel="Generate exterior geometry only"
                  />
                </div>
              ) : null}
            </div>
            <p className="tm-format" title="Change the format in Settings">
              Saves as <strong>{outputFormatLabel}</strong>
            </p>
          </Step>
        </div>

        {/* Export is the dock's exit, pinned under the steps. */}
        <footer className="lv-dock-foot tm-export">
          <FootFact label="Save to" title={outputFolder || undefined}>
            {outputFolder ? (
              <>
                <span className="tm-dest-name">{splitPath(outputFolder).name || outputFolder}</span>
                <button
                  type="button"
                  className="cx-icon-btn"
                  onClick={handleSelectOutputFolder}
                  disabled={!isTauriRuntime}
                  aria-label="Change output folder"
                  title="Change output folder"
                >
                  <FolderInput aria-hidden="true" />
                </button>
                {isTauriRuntime ? (
                  <button
                    type="button"
                    className="cx-icon-btn"
                    onClick={handleOpenOutputFolder}
                    aria-label="Open output folder"
                    title="Open output folder"
                  >
                    <FolderOpen aria-hidden="true" />
                  </button>
                ) : null}
              </>
            ) : isTauriRuntime ? (
              <button
                type="button"
                className="cx-btn lv-btn-sm"
                onClick={handleSelectOutputFolder}
                title="With a folder set, every build saves itself"
              >
                <FolderInput aria-hidden="true" />
                Choose a folder
              </button>
            ) : (
              "Browser downloads"
            )}
          </FootFact>
          <div className="tm-save-live" aria-live="polite" aria-atomic="true">
            {exportDisabledReason ? null : savedSummary ? (
              <FootFact label="Saved" title={autoSavedPath || undefined}>
                <span className="tm-saved">{`${savedSummary}${updatedLabel ? ` at ${updatedLabel}` : ""}`}</span>
              </FootFact>
            ) : buildSummary ? (
              <FootFact label="Template">{`${buildSummary}${updatedLabel ? ` · ${updatedLabel}` : ""}`}</FootFact>
            ) : null}
          </div>

          <button
            type="button"
            className="cx-btn is-primary"
            onClick={handleSaveTemplate}
            disabled={exportDisabled}
            aria-describedby={exportDisabledReason ? "tm-export-status" : undefined}
          >
            <Download aria-hidden="true" />
            {isSaving ? "Exporting…" : saveButtonLabel}
          </button>
          <div className="lv-foot-row">
            <button
              type="button"
              className="cx-btn"
              onClick={handleRegenerateTemplate}
              disabled={!canRegenerate}
              title="Build the template again from the model"
            >
              <RefreshCw className={generating ? "is-spinning" : ""} aria-hidden="true" />
              Rebuild
            </button>
          </div>
          {exportDisabledReason ? (
            <p id="tm-export-status" className="lv-foot-note" role="status">{exportDisabledReason}</p>
          ) : null}
        </footer>
        <PaneResizer side="dock" label="Resize the template steps panel" setWidth={panes.setWidth} />
      </aside>

      {/* ──── Stage ──── */}
      <section className={`tm-stage is-${viewMode}`} aria-label="Template work area">
        {!modelPath ? (
          <StageEmpty title="No model open" line="Its UVs become a layered template you can paint on.">
            <button
              type="button"
              className="cx-btn is-primary"
              onClick={handleSelectModel}
              disabled={!isTauriRuntime}
              title={!isTauriRuntime ? "Opening models needs the desktop app." : undefined}
            >
              <Box aria-hidden="true" />
              Open model
            </button>
          </StageEmpty>
        ) : null}

        <div className="tm-panes" hidden={!modelPath}>
          {/* Model */}
          <section className="tm-pane tm-pane--model" aria-label="Model" hidden={!showModelPane}>
            <div className="tm-pane-canvas">
              <Viewer
                modelPath={modelPath}
                texturePath={previewUrl || ""}
                textureReloadToken={lastGeneratedAt?.getTime() || 0}
                textureTarget={isWindowTemplate ? selectedTextureTargets : templatePolicy.textureTarget}
                textureMode={isWindowTemplate ? "everything" : templatePolicy.textureMode}
                windowTexturePath=""
                windowTextureTarget="none"
                windowTextureReloadToken={0}
                bodyColor={autoTemplateColor}
                backgroundColor="#111214"
                lightIntensity={1}
                lightAzimuth={54}
                lightElevation={46}
                glossiness={0.5}
                showGrid={false}
                showWireframe={false}
                liveryExteriorOnly={templatePolicy.supportsExteriorOnly && exteriorOnly}
                wasdEnabled={false}
                isActive={isActive && showModelPane}
                includeTemplateGeometry
                templatePartPickEnabled={isWindowTemplate}
                selectedTemplatePartNames={selectedTemplatePartNames}
                hoveredTemplatePartName={hoveredTemplatePartName}
                onTemplatePartHover={isWindowTemplate ? handleTemplatePartHover : undefined}
                onTemplatePartLeave={isWindowTemplate ? () => setHoveredTemplatePartName("") : undefined}
                onTemplatePartPick={isWindowTemplate ? handleTemplatePartPick : undefined}
                onModelInfo={handleModelInfo}
                onReady={handleModelViewerReady}
                onTextureReload={NOOP}
                onTextureError={NOOP}
                onWindowTextureError={NOOP}
                onModelError={(message) => {
                  setModelLoadError(message || "Unable to load the model.");
                  setModelLoading(false);
                }}
                onModelLoading={(loading) => {
                  setModelLoading(Boolean(loading));
                  if (loading) setModelLoadError("");
                }}
                onFormatWarning={NOOP}
              />
            </div>
            {modelLoading ? (
              <div className="tm-pane-state lv-slip" role="status">
                <span className="tm-spinner" aria-hidden="true" />
                Loading model…
              </div>
            ) : modelLoadError ? (
              <div className="tm-pane-state lv-slip is-error" role="alert">
                <AlertTriangle aria-hidden="true" />
                <span>
                  <strong>The model could not be loaded</strong>
                  <small>{modelLoadError}</small>
                </span>
                {isTauriRuntime ? (
                  <button type="button" className="cx-btn lv-btn-sm" onClick={handleSelectModel}>
                    Replace
                  </button>
                ) : null}
              </div>
            ) : null}
            {isWindowTemplate && !modelLoading && !modelLoadError ? (
              <p className="tm-coach lv-slip" role="status">
                <MousePointer2 aria-hidden="true" />
                {selectedTemplatePartNames.length
                  ? `${selectedTemplatePartNames.length} part${selectedTemplatePartNames.length === 1 ? "" : "s"} picked. Click more glass, or drag to orbit.`
                  : "Click the window glass. Drag anywhere else to orbit."}
              </p>
            ) : null}
            {modelLoadError ? null : (
            <div className="lv-deck tm-deck" role="toolbar" aria-label="Model view">
              <div className="lv-deck-group">
                <DeckButton onClick={handleFrameModel} title="Frame the model" disabled={viewerBlocked} className="is-icon">
                  <Crosshair aria-hidden="true" />
                </DeckButton>
              </div>
              <div className="lv-deck-group" role="group" aria-label="Rotate model 90 degrees">
                {["x", "y", "z"].map((axis) => (
                  <DeckButton
                    key={axis}
                    onClick={() => handleRotateModel(axis)}
                    title={`Rotate 90° on ${axis.toUpperCase()}`}
                    disabled={viewerBlocked}
                    className={`is-axis is-${axis}`}
                  >
                    {axis.toUpperCase()}
                  </DeckButton>
                ))}
              </div>
            </div>
            )}
          </section>

          {/* Template */}
          <section className="tm-pane tm-pane--sheet" aria-label="Template preview" hidden={!showSheetPane}>
            <div
              ref={previewShellRef}
              className={`tm-sheet ${markerDrawing ? "is-drawing" : ""} ${
                templatePreviewZoom > 1 ? "can-pan" : ""
              } ${sheetPanning ? "is-panning" : ""}`}
              tabIndex={previewUrl ? 0 : undefined}
              onKeyDown={handleSheetKeyDown}
              onPointerDown={handleSheetPointerDown}
              onPointerMove={handleSheetPointerMove}
              onPointerUp={handleSheetPointerUp}
              onPointerCancel={handleSheetPointerUp}
              aria-label={
                previewUrl
                  ? markerDrawing
                    ? "Template preview, drawing markers. Drag to draw a box. Arrow keys nudge the selected box, Delete removes it, Escape stops drawing."
                    : "Template preview. Scroll or minus and plus to zoom, drag to pan, zero fits."
                  : undefined
              }
            >
              {modelLoadError ? (
                <div className="tm-sheet-state">
                  <p className="tm-sheet-copy">The template builds once the model loads.</p>
                </div>
              ) : generationError ? (
                <div className="tm-sheet-state is-error" role="alert">
                  <AlertTriangle aria-hidden="true" />
                  <p className="tm-sheet-title">The template could not be built</p>
                  <p className="tm-sheet-copy">{generationError}</p>
                  {canRegenerate ? (
                    <button type="button" className="cx-btn lv-btn-sm" onClick={handleRegenerateTemplate}>
                      <RefreshCw aria-hidden="true" />
                      Try again
                    </button>
                  ) : null}
                </div>
              ) : isWindowTemplate && selectedTemplatePartNames.length === 0 ? (
                <div className="tm-sheet-state">
                  <p className="tm-sheet-title">No glass picked yet</p>
                  <p className="tm-sheet-copy">The window template appears once you pick a pane on the model.</p>
                </div>
              ) : previewUrl ? (
                <div className="tm-sheet-view">
                  <div
                    ref={sheetCanvasRef}
                    className="tm-sheet-canvas"
                    style={{
                      width: `${templatePreviewDisplaySize}px`,
                      height: `${templatePreviewDisplaySize}px`,
                      transform: `translate(calc(-50% + ${sheetPan.x}px), calc(-50% + ${sheetPan.y}px))`,
                    }}
                  >
                    <img src={previewUrl} alt="Generated template" className="tm-sheet-image" draggable="false" />
                    {markersAvailable && (displayedMarkers.length > 0 || markerDrawing) ? (
                      <>
                        <svg
                          className={`tm-boxes ${markerDrawing ? "is-active" : ""}`}
                          viewBox="0 0 1 1"
                          preserveAspectRatio="none"
                          style={{ "--marker": templateMarkerColorDraft }}
                          onPointerDown={handleMarkerPointerDown}
                          onPointerMove={handleMarkerPointerMove}
                          onPointerUp={handleMarkerPointerUp}
                          onPointerCancel={handleMarkerPointerUp}
                          aria-hidden="true"
                        >
                          {displayedMarkers.map((marker) => {
                            const selected = markerDrawing && marker.id === selectedMarkerId;
                            const handle = MARKER_HANDLE_PX * sheetPxToUnit;
                            return (
                              <g
                                key={marker.id}
                                data-marker-id={marker.id === "__draft__" ? undefined : marker.id}
                                className={`tm-box ${selected ? "is-selected" : ""} ${marker.fill === "box" ? "is-box" : ""}`}
                              >
                                <rect
                                  className="tm-box-rect"
                                  x={marker.x}
                                  y={marker.y}
                                  width={marker.w}
                                  height={marker.h}
                                  vectorEffect="non-scaling-stroke"
                                />
                                {selected
                                  ? MARKER_HANDLES.map((corner) => (
                                      <rect
                                        key={corner}
                                        data-handle={corner}
                                        className={`tm-box-handle is-${corner}`}
                                        x={(corner.endsWith("w") ? marker.x : marker.x + marker.w) - handle / 2}
                                        y={(corner.startsWith("n") ? marker.y : marker.y + marker.h) - handle / 2}
                                        width={handle}
                                        height={handle}
                                        vectorEffect="non-scaling-stroke"
                                      />
                                    ))
                                  : null}
                              </g>
                            );
                          })}
                        </svg>
                        {templateMarkers.map((marker, index) => (
                          <span
                            key={marker.id}
                            className="tm-box-label"
                            style={{ left: `${marker.x * 100}%`, top: `${marker.y * 100}%` }}
                            aria-hidden="true"
                          >
                            {index + 1}
                          </span>
                        ))}
                      </>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="tm-sheet-state" role="status">
                  <span className="tm-spinner" aria-hidden="true" />
                  <p className="tm-sheet-title">{generating ? "Building the template" : "Reading the model"}</p>
                  <p className="tm-sheet-copy">
                    {generating ? "Flattening UVs and assembling layers." : "The template builds as soon as the model is ready."}
                  </p>
                </div>
              )}
            </div>

            {previewUrl ? (
              <span className="tm-sheet-size lv-slip">
                {exportSize} × {exportSize}
                {buildSummary ? <span> · {buildSummary}</span> : null}
              </span>
            ) : null}
            {generating && previewUrl ? (
              <span className="tm-sheet-busy lv-slip" role="status">
                <span className="tm-spinner" aria-hidden="true" />
                Rebuilding…
              </span>
            ) : null}

            {previewUrl ? (
              <div className={`lv-deck tm-deck ${markerDrawing ? "is-raised" : ""}`} role="toolbar" aria-label="Template view">
                {markersAvailable ? (
                  <div className="lv-deck-group">
                    <DeckButton
                      active={markerToolActive}
                      onClick={() => setMarkerToolActive((active) => !active)}
                      title={markerToolActive ? "Stop drawing markers" : "Draw markers"}
                      className="is-icon"
                    >
                      <SquareDashedMousePointer aria-hidden="true" />
                    </DeckButton>
                    <DeckButton
                      onClick={handleUndoMarkers}
                      disabled={!canUndoMarkers}
                      title="Undo marker change (Ctrl+Z)"
                      className="is-icon"
                    >
                      <Undo2 aria-hidden="true" />
                    </DeckButton>
                    <DeckButton
                      onClick={handleRedoMarkers}
                      disabled={!canRedoMarkers}
                      title="Redo marker change (Ctrl+Shift+Z)"
                      className="is-icon"
                    >
                      <Redo2 aria-hidden="true" />
                    </DeckButton>
                  </div>
                ) : null}
                <div className="lv-deck-group">
                  <DeckButton
                    onClick={() => adjustTemplatePreviewZoom(-1)}
                    disabled={!previewUrl || templatePreviewZoom <= TEMPLATE_PREVIEW_ZOOM_MIN}
                    title="Zoom out (-)"
                    className="is-icon"
                  >
                    <ZoomOut aria-hidden="true" />
                  </DeckButton>
                  <DeckButton
                    onClick={fitTemplatePreview}
                    disabled={!previewUrl}
                    title={`Fit to view (0). Now ${Math.round(templatePreviewZoom * 100)}%`}
                    className="tm-zoom-value"
                  >
                    {templatePreviewZoom === 1 ? "Fit" : `${Math.round(templatePreviewZoom * 100)}%`}
                  </DeckButton>
                  <DeckButton
                    onClick={() => adjustTemplatePreviewZoom(1)}
                    disabled={!previewUrl || templatePreviewZoom >= TEMPLATE_PREVIEW_ZOOM_MAX}
                    title="Zoom in (+)"
                    className="is-icon"
                  >
                    <ZoomIn aria-hidden="true" />
                  </DeckButton>
                </div>
              </div>
            ) : null}
          </section>
        </div>

        {/* While drawing, the marker bar owns the bottom of the stage. */}
        {markerDrawing && modelPath ? (
          <div className="tm-markerbar lv-slip" role="group" aria-label="Marker drawing">
            <span className="tm-markerbar-count">
              <span className="cx-display">{templateMarkers.length}</span>
              <span>{templateMarkers.length === 1 ? "marker" : "markers"}</span>
            </span>
            <span className="tm-markerbar-hint">
              Drag to box pieces. Drag a box to move it, or a corner to resize. Delete removes the selected box.
            </span>
            <div className="tm-markerbar-actions">
              <button
                type="button"
                className="cx-btn is-primary lv-btn-sm"
                onClick={() => setMarkerToolActive(false)}
              >
                <Check aria-hidden="true" />
                Done
              </button>
            </div>
          </div>
        ) : null}

        {/* View switch, top left, as on the Livery stage. */}
        {modelPath ? (
          <div className="lv-stage-switch tm-view-switch" role="radiogroup" aria-label="Layout">
            {[
              { id: "model", label: "Model" },
              { id: "split", label: "Split" },
              { id: "template", label: "Template" },
            ].map((mode) => (
              <button
                key={mode.id}
                type="button"
                role="radio"
                aria-checked={viewMode === mode.id}
                className={viewMode === mode.id ? "is-on" : ""}
                onClick={() => setViewMode(mode.id)}
              >
                {mode.label}
              </button>
            ))}
          </div>
        ) : null}

        <div className="lv-alerts tm-alerts" aria-live="polite">
          {showNotice && saveNotice.tone === "error" ? (
            <div className="lv-alert" role="alert">
              <AlertTriangle className="lv-alert-icon" aria-hidden="true" />
              <div className="lv-alert-copy">
                <strong>{saveNotice.label || "Export failed"}</strong>
                <span>{saveNotice.message}</span>
              </div>
              <button
                type="button"
                className="cx-icon-btn"
                onClick={() => setNoticeDismissed(true)}
                aria-label="Dismiss"
              >
                <X aria-hidden="true" />
              </button>
            </div>
          ) : null}
        </div>
        <div className="lv-toasts tm-toasts" aria-live="polite">
          {showNotice && saveNotice.tone === "success" ? (
            <div className="lv-toast" role="status" title={autoSavedPath || undefined}>
              <Check aria-hidden="true" />
              <span>{saveNotice.message}</span>
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}

/* A pipeline step without a file: same disc, line and title as AssetSlot. */
function Step({ id, step, title, hint, done, disabled, note, trailing, children }) {
  return (
    <section id={id} className={`lv-slot ${disabled ? "is-disabled" : ""}`}>
      <header className="lv-slot-head">
        <span className={`lv-step ${done ? "is-done" : ""}`} aria-hidden="true">
          {done ? <Check /> : step}
        </span>
        <h3 className="lv-slot-title" title={hint}>{title}</h3>
        {disabled ? null : trailing}
      </header>
      <div className="lv-slot-body">
        {disabled ? <p className="lv-slot-note">{note}</p> : children}
      </div>
    </section>
  );
}
