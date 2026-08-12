import { useCallback, useEffect, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import {
  AlertTriangle,
  Box,
  Car,
  ChevronDown,
  Check,
  Download,
  FolderOpen,
  Image,
  Layers,
  MousePointer2,
  PanelTop,
  RefreshCw,
  RotateCw,
  Scan,
  Shirt,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import Viewer from "./Viewer";
import { Button } from "./ui/button";
import { Toggle } from "./ui/toggle";
import { buildAutoTemplatePsd } from "../lib/template-psd";
import {
  getTemplateModelPolicy,
  normalizeTemplateViewMode,
} from "../lib/template-model";
import { loadPrefs } from "../lib/prefs";
import { openFolderPath } from "../lib/open-folder";
import {
  buildMarkerSelectionDraft,
  countSelectedMarkers,
  getContainedTemplateViewport,
  getMarkerTextureRect,
  isMarkerPlacementDecisionRequired,
  isTemplateMarkerModifierPressed,
  normalizeTemplateMarkerPickModifier,
  pickMarkerAtTexturePoint,
  toggleMarkerSelection,
  uvToTemplateTexturePoint,
} from "../lib/template-marker-utils";

const SIZE_OPTIONS = [4096, 2048, 1024, 512];
const NOOP = () => {};
const DEFAULT_AUTO_TEMPLATE_COLOR = "#c9d8ee";
const DEFAULT_AUTO_TEMPLATE_EXPORT_FORMAT = "psd";
const TEMPLATE_PREVIEW_ZOOM_MIN = 0.25;
const TEMPLATE_PREVIEW_ZOOM_MAX = 4;
const TEMPLATE_PREVIEW_ZOOM_STEP = 0.25;

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

function buildTemplateExportOutputs({ format, psdBytes, psdFileName, previewDataUrl }) {
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

  return outputs;
}

function buildTemplateExportOutputsForArtifacts(format, artifacts) {
  return (Array.isArray(artifacts) ? artifacts : []).flatMap((artifact) =>
    buildTemplateExportOutputs({
      format,
      psdBytes: artifact?.bytes,
      psdFileName: artifact?.fileName,
      previewDataUrl: artifact?.previewDataUrl,
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
      resolve({ ...result, bytes });
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

function normalizeAutoTemplateColor(value) {
  if (typeof value !== "string") return DEFAULT_AUTO_TEMPLATE_COLOR;
  const trimmed = value.trim();
  if (/^#(?:[0-9a-fA-F]{3}){1,2}$/.test(trimmed)) return trimmed;
  return DEFAULT_AUTO_TEMPLATE_COLOR;
}

function normalizeColorInputValue(value) {
  const normalized = normalizeAutoTemplateColor(value);
  if (/^#[0-9a-fA-F]{3}$/.test(normalized)) {
    return `#${normalized[1]}${normalized[1]}${normalized[2]}${normalized[2]}${normalized[3]}${normalized[3]}`.toLowerCase();
  }
  return normalized.toLowerCase();
}

function shallowEqualObject(a, b) {
  if (a === b) return true;
  const aObj = a && typeof a === "object" ? a : {};
  const bObj = b && typeof b === "object" ? b : {};
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (aObj[key] !== bObj[key]) return false;
  }
  return true;
}

function hasTrueEntries(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).some((entry) => entry === true);
}

function getDefaultAutoTemplateColor() {
  const prefs = loadPrefs() || {};
  return normalizeAutoTemplateColor(prefs?.defaults?.autoTemplateColor);
}

function getDefaultAutoTemplateExportFormat() {
  const prefs = loadPrefs() || {};
  return normalizeAutoTemplateExportFormat(prefs?.defaults?.autoTemplateExportFormat);
}

function getDefaultTemplateMarkerPickModifier() {
  const prefs = loadPrefs() || {};
  return normalizeTemplateMarkerPickModifier(prefs?.defaults?.templateMarkerPickModifier);
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
}) {
  const isTauriRuntime =
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__ !== "undefined";

  const [modelPath, setModelPath] = useState(workspaceState?.modelPath || "");
  const [outputFolder, setOutputFolder] = useState(
    workspaceState?.outputFolder || getDefaultOutputFolder(),
  );
  const [autoTemplateColor, setAutoTemplateColor] = useState(() => getDefaultAutoTemplateColor());
  const [autoTemplateExportFormat, setAutoTemplateExportFormat] = useState(
    () => getDefaultAutoTemplateExportFormat(),
  );
  const [templateMarkerPickModifier, setTemplateMarkerPickModifier] = useState(
    () => getDefaultTemplateMarkerPickModifier(),
  );
  const [templatePurpose, setTemplatePurpose] = useState(() =>
    workspaceState?.templatePurpose === "windows" ? "windows" : "body",
  );
  const [selectedTemplatePartNames, setSelectedTemplatePartNames] = useState(() =>
    normalizeMeshNameList(workspaceState?.selectedTemplatePartNames),
  );
  const [hoveredTemplatePartName, setHoveredTemplatePartName] = useState("");
  const [markerSelectionConfirmed, setMarkerSelectionConfirmed] = useState(() => {
    const explicitValue = workspaceState?.markerSelectionConfirmed;
    if (typeof explicitValue === "boolean") return explicitValue;
    return hasTrueEntries(workspaceState?.detectedIslandVisibility);
  });
  const [pendingMarkerSelection, setPendingMarkerSelection] = useState(() => {
    const markers = Array.isArray(workspaceState?.detectedIslands)
      ? workspaceState.detectedIslands
      : [];
    return buildMarkerSelectionDraft(markers, workspaceState?.detectedIslandVisibility);
  });
  const [isMarkerEditMode, setIsMarkerEditMode] = useState(false);
  const [useWorldSpaceNormalsAsBase, setUseWorldSpaceNormalsAsBase] = useState(() =>
    Boolean(
      (workspaceState?.useWorldSpaceNormalsAsBase ??
        workspaceState?.generateWorldSpaceNormals) ??
        true,
    ),
  );
  const [exportSize, setExportSize] = useState(workspaceState?.exportSize ?? 4096);
  const [exteriorOnly, setExteriorOnly] = useState(Boolean(workspaceState?.exteriorOnly));
  const [includeTemplateWireframe, setIncludeTemplateWireframe] = useState(() =>
    Boolean(
      (workspaceState?.includeTemplateWireframe ??
        workspaceState?.showWireframe) ??
        true,
    ),
  );

  const [templateMap, setTemplateMap] = useState(null);
  const [templateMapError, setTemplateMapError] = useState("");
  const [templatePsdSource, setTemplatePsdSource] = useState(null);
  const [templatePsdSourceError, setTemplatePsdSourceError] = useState("");
  const [templateSets, setTemplateSets] = useState([]);
  const [windowTemplateSets, setWindowTemplateSets] = useState([]);
  const [windowTemplateError, setWindowTemplateError] = useState("");
  const [templateSetWarning, setTemplateSetWarning] = useState("");
  const [detectedIslands, setDetectedIslands] = useState(() =>
    Array.isArray(workspaceState?.detectedIslands) ? workspaceState.detectedIslands : [],
  );
  const [detectedIslandColors, setDetectedIslandColors] = useState(() => {
    const map = workspaceState?.detectedIslandColors;
    return map && typeof map === "object" && !Array.isArray(map) ? map : {};
  });
  const [detectedIslandVisibility, setDetectedIslandVisibility] = useState(() => {
    const map = workspaceState?.detectedIslandVisibility;
    return map && typeof map === "object" && !Array.isArray(map) ? map : {};
  });
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
  const [isMarkerPickModifierPressed, setIsMarkerPickModifierPressed] = useState(false);
  const [hoveredMarkerKey, setHoveredMarkerKey] = useState("");
  const [previewViewport, setPreviewViewport] = useState(() => ({
    size: 0,
    offsetX: 0,
    offsetY: 0,
  }));
  const [templatePreviewZoom, setTemplatePreviewZoom] = useState(1);
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

  const adjustTemplatePreviewZoom = useCallback((direction) => {
    setTemplatePreviewZoom((current) =>
      clampTemplatePreviewZoom(current + direction * TEMPLATE_PREVIEW_ZOOM_STEP),
    );
  }, []);

  const fitTemplatePreview = useCallback(() => {
    setTemplatePreviewZoom(1);
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
    setAutoTemplateColor(getDefaultAutoTemplateColor());
    setAutoTemplateExportFormat(getDefaultAutoTemplateExportFormat());
    setTemplateMarkerPickModifier(getDefaultTemplateMarkerPickModifier());
  }, [settingsVersion]);

  useEffect(() => {
    if (!onStateChange) return;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      onStateChange({
        modelPath,
        outputFolder,
        templatePurpose,
        selectedTemplatePartNames,
        exportSize,
        exteriorOnly,
        includeTemplateWireframe,
        useWorldSpaceNormalsAsBase,
        detectedIslands,
        detectedIslandColors,
        detectedIslandVisibility,
        markerSelectionConfirmed,
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
    detectedIslands,
    detectedIslandColors,
    detectedIslandVisibility,
    markerSelectionConfirmed,
    viewMode,
    onStateChange,
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

  const showSaveNotice = useCallback((tone, message) => {
    if (saveNoticeTimerRef.current) clearTimeout(saveNoticeTimerRef.current);
    setSaveNotice({ tone, message });
    saveNoticeTimerRef.current = setTimeout(() => {
      setSaveNotice({ tone: "", message: "" });
      saveNoticeTimerRef.current = null;
    }, 4000);
  }, []);

  useEffect(() => {
    setIsMarkerPickModifierPressed(false);
    setHoveredMarkerKey("");

    const updateModifierState = (event) => {
      const nextPressed = isTemplateMarkerModifierPressed(
        event,
        templateMarkerPickModifier,
      );
      setIsMarkerPickModifierPressed(nextPressed);
      if (!nextPressed) setHoveredMarkerKey("");
    };

    const handleWindowBlur = () => {
      setIsMarkerPickModifierPressed(false);
      setHoveredMarkerKey("");
    };

    window.addEventListener("keydown", updateModifierState);
    window.addEventListener("keyup", updateModifierState);
    window.addEventListener("blur", handleWindowBlur);

    return () => {
      window.removeEventListener("keydown", updateModifierState);
      window.removeEventListener("keyup", updateModifierState);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [templateMarkerPickModifier]);

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
    setDetectedIslands([]);
    setDetectedIslandColors({});
    setDetectedIslandVisibility({});
    setMarkerSelectionConfirmed(false);
    setPendingMarkerSelection({});
    setIsMarkerEditMode(false);
    setHoveredMarker("");
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
    } catch {
      // no-op
    }
  }, [clearGeneratedState, isTauriRuntime, onRenameTab]);

  const handleSelectOutputFolder = useCallback(async () => {
    if (!isTauriRuntime) return;
    try {
      const selected = await open({ directory: true });
      if (typeof selected === "string") setOutputFolder(selected);
    } catch {
      // no-op
    }
  }, [isTauriRuntime]);

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

  const resolveMarkerFromUv = useCallback(
    (uv) => {
      const point = uvToTemplateTexturePoint(uv, exportSize);
      return pickMarkerAtTexturePoint(detectedIslands, point);
    },
    [detectedIslands, exportSize],
  );

  const setHoveredMarker = useCallback((markerKey = "") => {
    setHoveredMarkerKey((prev) => (prev === markerKey ? prev : markerKey));
  }, []);

  const clearHoveredMarker = useCallback(() => {
    setHoveredMarker("");
  }, [setHoveredMarker]);

  useEffect(() => {
    if (!detectedIslands.length) {
      setPendingMarkerSelection((prev) => (shallowEqualObject(prev, {}) ? prev : {}));
      setIsMarkerEditMode(false);
      return;
    }

    setPendingMarkerSelection((prev) => {
      const sourceSelection = isMarkerEditMode ? prev : detectedIslandVisibility;
      const next = buildMarkerSelectionDraft(detectedIslands, sourceSelection);
      return shallowEqualObject(prev, next) ? prev : next;
    });
  }, [detectedIslandVisibility, detectedIslands, isMarkerEditMode]);

  useEffect(() => {
    if (isWindowTemplate) {
      setIsMarkerEditMode(false);
      return;
    }
    if (!detectedIslands.length || markerSelectionConfirmed || isMarkerEditMode) return;
    setPendingMarkerSelection((prev) => {
      const next = buildMarkerSelectionDraft(detectedIslands, detectedIslandVisibility);
      return shallowEqualObject(prev, next) ? prev : next;
    });
    setIsMarkerEditMode(true);
  }, [
    detectedIslandVisibility,
    detectedIslands,
    isMarkerEditMode,
    isWindowTemplate,
    markerSelectionConfirmed,
  ]);

  const handleTogglePendingMarkerSelection = useCallback(
    (markerKey) => {
      if (!markerKey) return;
      setPendingMarkerSelection((prev) => {
        const next = toggleMarkerSelection(prev, markerKey);
        return shallowEqualObject(prev, next) ? prev : next;
      });
      setHoveredMarker(markerKey);
    },
    [setHoveredMarker],
  );

  const handleBeginMarkerEdit = useCallback(() => {
    setPendingMarkerSelection((prev) => {
      const next = buildMarkerSelectionDraft(detectedIslands, detectedIslandVisibility);
      return shallowEqualObject(prev, next) ? prev : next;
    });
    setHoveredMarker("");
    setIsMarkerEditMode(true);
  }, [detectedIslandVisibility, detectedIslands, setHoveredMarker]);

  const handleCancelMarkerEdit = useCallback(() => {
    setPendingMarkerSelection((prev) => {
      const next = buildMarkerSelectionDraft(detectedIslands, detectedIslandVisibility);
      return shallowEqualObject(prev, next) ? prev : next;
    });
    setHoveredMarker("");
    setIsMarkerEditMode(false);
  }, [detectedIslandVisibility, detectedIslands, setHoveredMarker]);

  const handleClearPendingMarkerSelection = useCallback(() => {
    setPendingMarkerSelection((prev) => (shallowEqualObject(prev, {}) ? prev : {}));
    setHoveredMarker("");
  }, [setHoveredMarker]);

  const handleConfirmMarkerSelection = useCallback(() => {
    const nextSelection = buildMarkerSelectionDraft(detectedIslands, pendingMarkerSelection);
    if (!shallowEqualObject(detectedIslandVisibility, nextSelection)) {
      setDetectedIslandVisibility(nextSelection);
      setAutoSavedPath("");
      setGenerationError("");
    }
    setPendingMarkerSelection(nextSelection);
    setMarkerSelectionConfirmed(true);
    setHoveredMarker("");
    setIsMarkerEditMode(false);
  }, [
    detectedIslandVisibility,
    detectedIslands,
    pendingMarkerSelection,
    setHoveredMarker,
  ]);

  const handleConfirmNoMarkers = useCallback(() => {
    const nextSelection = buildMarkerSelectionDraft(detectedIslands, {});
    if (!shallowEqualObject(detectedIslandVisibility, nextSelection)) {
      setDetectedIslandVisibility(nextSelection);
      setAutoSavedPath("");
      setGenerationError("");
    }
    setPendingMarkerSelection(nextSelection);
    setMarkerSelectionConfirmed(true);
    setHoveredMarker("");
    setIsMarkerEditMode(false);
  }, [detectedIslandVisibility, detectedIslands, setHoveredMarker]);

  const handleResetMarkerSelection = useCallback(() => {
    if (!shallowEqualObject(detectedIslandVisibility, {})) {
      setDetectedIslandVisibility({});
      setAutoSavedPath("");
      setGenerationError("");
    }
    setPendingMarkerSelection({});
    setMarkerSelectionConfirmed(false);
    setHoveredMarker("");
    setIsMarkerEditMode(true);
  }, [detectedIslandVisibility, setHoveredMarker]);

  const handleIslandColorChange = useCallback((color) => {
    if (!detectedIslands.length || typeof color !== "string") return;
    const normalized = normalizeColorInputValue(color);
    setDetectedIslandColors((prev) => {
      const next = {};
      for (const marker of detectedIslands) {
        if (marker?.key) next[marker.key] = normalized;
      }
      return shallowEqualObject(prev, next) ? prev : next;
    });
    setAutoSavedPath("");
  }, [detectedIslands]);

  const handleModelMarkerHover = useCallback(
    (hit) => {
      if (!isMarkerEditMode) return;
      const marker = resolveMarkerFromUv(hit?.uv);
      setHoveredMarker(marker?.key || "");
    },
    [isMarkerEditMode, resolveMarkerFromUv, setHoveredMarker],
  );

  const handleModelMarkerPick = useCallback(
    (hit) => {
      if (!isMarkerEditMode) return;
      const marker = resolveMarkerFromUv(hit?.uv);
      if (!marker?.key) return;
      handleTogglePendingMarkerSelection(marker.key);
    },
    [handleTogglePendingMarkerSelection, isMarkerEditMode, resolveMarkerFromUv],
  );

  const handleTemplatePurposeChange = useCallback((nextPurpose) => {
    const normalized = nextPurpose === "windows" ? "windows" : "body";
    setTemplatePurpose(normalized);
    setHoveredTemplatePartName("");
    setIsMarkerEditMode(false);
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
      setDetectedIslands([]);
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
            preferredTarget: isWindowTemplate ? "" : setPolicy.preferredTarget,
            includeVehicleLayers: !isWindowTemplate && setPolicy.includeVehicleLayers,
            includeWireframe: includeTemplateWireframe,
            includeWorldSpaceNormals: useWorldSpaceNormalsAsBase,
            useWorldSpaceNormalsAsBase,
            detectedIslandColors:
              isPrimaryTemplate && !isWindowTemplate ? detectedIslandColors : {},
            detectedIslandVisibility:
              isPrimaryTemplate && !isWindowTemplate ? detectedIslandVisibility : {},
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
        const nextMarkers = Array.isArray(primaryResult.detectedIslands)
          ? primaryResult.detectedIslands
          : [];
        setDetectedIslands(nextMarkers);
        setDetectedIslandColors((prev) => {
          const next = {};
          for (const marker of nextMarkers) {
            if (!marker?.key || typeof prev[marker.key] !== "string") continue;
            next[marker.key] = normalizeColorInputValue(prev[marker.key]);
          }
          return shallowEqualObject(prev, next) ? prev : next;
        });
        setLastGeneratedAt(new Date());
        setGenerationError("");

        const exportOutputs = buildTemplateExportOutputsForArtifacts(
          autoTemplateExportFormat,
          artifacts,
        );

        const markerPlacementRequired =
          !isWindowTemplate &&
          isMarkerPlacementDecisionRequired(nextMarkers, markerSelectionConfirmed);

        if (
          isTauriRuntime &&
          outputFolder &&
          exportOutputs.length > 0 &&
          !markerPlacementRequired
        ) {
          try {
            const savedPaths = [];
            for (const output of exportOutputs) {
              const autoPath = joinPath(outputFolder, output.fileName);
              await writeFile(autoPath, ensureWritableBytes(output.bytes));
              savedPaths.push(autoPath);
            }
            if (cancelled) return;
            setAutoSavedPath(savedPaths.join(" | "));
            const count = savedPaths.length;
            showSaveNotice("success", `${count} template file${count === 1 ? "" : "s"} auto-saved successfully.`);
          } catch (error) {
            if (!cancelled) {
              setAutoSavedPath("");
              showSaveNotice("error", `Auto-save failed: ${toErrorMessage(error, "Unable to write the template files.")}`);
            }
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
        setDetectedIslands([]);
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
    autoTemplateExportFormat,
    includeTemplateWireframe,
    useWorldSpaceNormalsAsBase,
    detectedIslandColors,
    detectedIslandVisibility,
    markerSelectionConfirmed,
    regenerationToken,
    isTauriRuntime,
    showSaveNotice,
    templatePolicy.format,
  ]);

  const handleSaveTemplate = useCallback(async () => {
    if (isSaving) return;
    if (
      !isWindowTemplate &&
      isMarkerPlacementDecisionRequired(detectedIslands, markerSelectionConfirmed)
    ) {
      const message = "Choose marker locations or continue with no markers before saving.";
      setGenerationError(message);
      showSaveNotice("error", message);
      return;
    }

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
      setGenerationError(message);
      showSaveNotice("error", `Save failed: ${message}`);
      return;
    }
    if (exportOutputs.length === 0) {
      const message = "Nothing to save yet. Generate a template first.";
      setGenerationError(message);
      showSaveNotice("error", message);
      return;
    }

    const confirmSave = (savedPaths) => {
      setAutoSavedPath(savedPaths.join(" | "));
      const count = savedPaths.length;
      showSaveNotice("success", `${count} template file${count === 1 ? "" : "s"} saved successfully.`);
    };

    const writeOutputsToFolder = async (folder) => {
      const savedPaths = [];
      for (const output of exportOutputs) {
        const filePath = joinPath(folder, output.fileName);
        await writeFile(filePath, ensureWritableBytes(output.bytes));
        savedPaths.push(filePath);
      }
      return savedPaths;
    };

    setIsSaving(true);
    setAutoSavedPath("");
    setGenerationError("");
    try {
      if (isTauriRuntime) {
        if (outputFolder) {
          try {
            const savedPaths = await writeOutputsToFolder(outputFolder);
            confirmSave(savedPaths);
            return;
          } catch {
            // Folder may be out of FS scope after restart — fall through to dialogs.
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
      setGenerationError(message);
      showSaveNotice("error", `Save failed: ${message}`);
    } finally {
      setIsSaving(false);
    }
  }, [
    autoTemplateExportFormat,
    detectedIslands.length,
    generatedTemplates,
    isSaving,
    isTauriRuntime,
    isWindowTemplate,
    markerSelectionConfirmed,
    outputFolder,
    previewUrl,
    psdBytes,
    psdFileName,
    showSaveNotice,
  ]);

  const handleOpenOutputFolder = useCallback(async () => {
    if (!isTauriRuntime || !outputFolder) return;
    await openFolderPath(outputFolder);
  }, [isTauriRuntime, outputFolder]);

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
  const worldSpaceNormalsBaseEnabled = useWorldSpaceNormalsAsBase;
  const activeWindowTemplateSet = windowTemplateSets[0] || null;
  const windowTemplateMap = activeWindowTemplateSet?.templateMap || null;
  const inferredWindowTarget = windowTemplateMap?.inference?.windowTarget || "";
  const suggestedWindowPartNames = normalizeMeshNameList(
    (windowTemplateMap?.targets?.[inferredWindowTarget] || []).map((entry) => entry?.meshName),
  );
  const availableWindowPartNames = normalizeMeshNameList(
    (activeWindowTemplateSet?.templatePsdSource?.meshes || []).map((mesh) => mesh?.meshName),
  ).sort((a, b) => a.localeCompare(b));
  const selectedTextureTargets = selectedTemplatePartNames.map((name) => `mesh:${name}`);
  const selectedPartCountLabel = `${selectedTemplatePartNames.length} part${
    selectedTemplatePartNames.length === 1 ? "" : "s"
  } selected`;
  const hasDetectedIslands = detectedIslands.length > 0;
  const markerPlacementRequired =
    !isWindowTemplate &&
    isMarkerPlacementDecisionRequired(detectedIslands, markerSelectionConfirmed);
  const confirmedSelectedCount = countSelectedMarkers(
    buildMarkerSelectionDraft(detectedIslands, detectedIslandVisibility),
  );
  const pendingSelectedCount = countSelectedMarkers(pendingMarkerSelection);
  const markerSelectionCountLabel = isMarkerEditMode
    ? `${pendingSelectedCount} of ${detectedIslands.length || 0} chosen`
    : `${confirmedSelectedCount} of ${detectedIslands.length || 0} placed`;
  const markerPickModifierLabel =
    templateMarkerPickModifier === "ctrl"
      ? "Ctrl"
      : templateMarkerPickModifier === "shift"
        ? "Shift"
        : "Alt";
  const markerPickHint = isMarkerPickModifierPressed
    ? `${markerPickModifierLabel} held — click the matching part on the model.`
    : `Click a UV chunk here, or hold ${markerPickModifierLabel} and click the matching model part.`;
  const markerSelectionHint = isMarkerEditMode
    ? "Markers start off. Choose only the locations where a marker belongs before saving."
    : "Only these confirmed locations will be included in the saved template.";
  const templatePreviewDisplaySize = previewViewport.size * templatePreviewZoom;
  const showMarkerSelectionOverlay =
    previewUrl && hasDetectedIslands && templatePreviewDisplaySize > 0 && isMarkerEditMode;
  const markerSelectionPickingActive = isMarkerEditMode;
  const globalMarkerColor = (() => {
    const first = detectedIslands[0];
    const key = first?.key;
    return key && detectedIslandColors[key]
      ? normalizeColorInputValue(detectedIslandColors[key])
      : (first?.defaultColor || "#00ff00");
  })();
  const markerOverlayMarkers = detectedIslands
    .slice()
    .sort((a, b) => {
      const aRect = getMarkerTextureRect(a);
      const bRect = getMarkerTextureRect(b);
      return (bRect?.area || 0) - (aRect?.area || 0);
    });

  const outputFormatLabel =
    autoTemplateExportFormat === "png"
      ? "PNG"
      : autoTemplateExportFormat === "psd_png"
        ? "PSD + PNG"
        : "PSD";
  const exportDisabled = Boolean(
    !psdBytes || generating || isSaving || markerPlacementRequired,
  );
  const exportDisabledReason = markerPlacementRequired
    ? "Choose marker locations or continue with no markers before exporting."
    : isWindowTemplate && selectedTemplatePartNames.length === 0
      ? "Select at least one window part to generate a template."
      : generationError
        ? generationError
        : generating
          ? "The template is being rebuilt."
          : !psdBytes
            ? "A generated template is required before export."
            : "";
  const buildStatusLabel = modelLoadError || generationError
    ? "Needs attention"
    : generating || modelLoading
      ? "Building"
      : previewUrl
        ? "Ready"
        : "Preparing";
  const statusSummary = previewUrl
    ? `${layerCount} layer${layerCount === 1 ? "" : "s"} · ${targetCount} target${targetCount === 1 ? "" : "s"}`
    : isWindowTemplate && selectedTemplatePartNames.length === 0
      ? "Select model geometry to continue"
      : "Waiting for generated output";
  const markerProgressLabel = isMarkerEditMode
    ? `${pendingSelectedCount} of ${detectedIslands.length} selected`
    : `${confirmedSelectedCount} of ${detectedIslands.length} placed`;
  const saveLocationLabel = outputFolder
    ? getFileLabel(outputFolder, outputFolder)
    : isTauriRuntime
      ? "Choose folder"
      : "Browser downloads";

  return (
    <main className={`tg-root tg-view-${viewMode}`} aria-label="Template Generator">
      {!modelPath ? (
        <section className="tg-empty" aria-labelledby="tg-empty-title">
          <div className="tg-empty-content">
            <span className="tg-empty-kicker">// TEMPLATE GENERATOR</span>
            <h1 id="tg-empty-title">Build a template from a model.</h1>
            <p>
              Import a supported vehicle or clothing model, choose the geometry to paint,
              and export the generated template.
            </p>
            <Button
              type="button"
              className="tg-empty-btn"
              onClick={handleSelectModel}
              disabled={!isTauriRuntime}
              title={!isTauriRuntime ? "Model import is available in the desktop app." : undefined}
            >
              <Box aria-hidden />
              Import model
            </Button>
            <span className="tg-empty-formats">
              .yft · .ydd{!isTauriRuntime ? " · Desktop app required" : ""}
            </span>
          </div>
        </section>
      ) : (
        <div className="tg-workbench">
          <header className="tg-workbench-toolbar">
            <div className="tg-workbench-title">
              <span>// TEMPLATE GENERATOR</span>
              <strong title={modelPath}>{modelFileName}</strong>
            </div>
            <div className="tg-view-switch" role="group" aria-label="Viewport layout">
              {["model", "template", "split"].map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={viewMode === mode ? "is-active" : ""}
                  onClick={() => setViewMode(mode)}
                  aria-pressed={viewMode === mode}
                >
                  {mode[0].toUpperCase() + mode.slice(1)}
                </button>
              ))}
            </div>
          </header>

          <div className="tg-workbench-body">
            <aside
              className={`tg-inspector${generationError || modelLoadError ? " has-error" : ""}`}
              aria-label="Template controls"
            >
              <div className="tg-inspector-scroll">
                <section className="tg-inspector-section" aria-labelledby="tg-source-title">
                  <div className="tg-section-heading">
                    <h2 id="tg-source-title">Source</h2>
                  </div>
                  <div className="tg-source-row" title={modelPath}>
                    <span className="tg-icon-slot" aria-hidden>
                      {templatePolicy.isEup ? <Shirt /> : <Car />}
                    </span>
                    <span className="tg-source-copy">
                      <strong>{modelFileName}</strong>
                      <small>{templatePolicy.label} · .{templatePolicy.format}</small>
                    </span>
                    <button
                      type="button"
                      className="tg-text-action"
                      onClick={handleSelectModel}
                      disabled={!isTauriRuntime}
                      title={!isTauriRuntime ? "Model replacement is available in the desktop app." : undefined}
                    >
                      Replace
                    </button>
                    <button
                      type="button"
                      className="tg-icon-action"
                      onClick={handleUnloadModel}
                      aria-label="Unload model"
                      title="Unload model"
                    >
                      <X aria-hidden />
                    </button>
                  </div>
                  {templateSetWarning ? (
                    <p className="tg-inline-message is-warning" role="status">
                      <AlertTriangle aria-hidden />
                      {templateSetWarning}
                    </p>
                  ) : null}
                </section>

                <section className="tg-inspector-section" aria-labelledby="tg-focus-title">
                  <div className="tg-section-heading">
                    <h2 id="tg-focus-title">Focus</h2>
                  </div>
                  <div className="tg-choice-list" role="group" aria-label="Template focus">
                    <button
                      type="button"
                      className={`tg-choice-row${!isWindowTemplate ? " is-active" : ""}`}
                      onClick={() => handleTemplatePurposeChange("body")}
                      aria-pressed={!isWindowTemplate}
                    >
                      <span className="tg-choice-indicator" aria-hidden />
                      <span>
                        <strong>{templatePolicy.isEup ? "Garment texture" : "Body livery"}</strong>
                        <small>Automatic UV target</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`tg-choice-row${isWindowTemplate ? " is-active" : ""}`}
                      onClick={() => handleTemplatePurposeChange("windows")}
                      aria-pressed={isWindowTemplate}
                      disabled={templatePolicy.isEup}
                      title={
                        templatePolicy.isEup
                          ? "Window templates are available for vehicle models."
                          : "Select window geometry directly on the model."
                      }
                    >
                      <span className="tg-choice-indicator" aria-hidden />
                      <span>
                        <strong>Window graphics</strong>
                        <small>Pick geometry manually</small>
                      </span>
                    </button>
                  </div>
                </section>

                <section className="tg-inspector-section" aria-labelledby="tg-target-title">
                  <div className="tg-section-heading">
                    <h2 id="tg-target-title">Target</h2>
                    <span>{isWindowTemplate ? selectedPartCountLabel : "Automatic"}</span>
                  </div>
                  {isWindowTemplate ? (
                    <>
                      <div className="tg-info-row">
                        <MousePointer2 aria-hidden />
                        <span>
                          <strong>Select window geometry</strong>
                          <small>Click the model to add or remove regions.</small>
                        </span>
                      </div>
                      {suggestedWindowPartNames.length > 0 &&
                      selectedTemplatePartNames.length === 0 ? (
                        <button
                          type="button"
                          className="tg-secondary-action"
                          onClick={() => setSelectedTemplatePartNames(suggestedWindowPartNames)}
                        >
                          <Check aria-hidden />
                          Use likely window match
                        </button>
                      ) : null}
                      <label className="tg-part-select-label">
                        <span>Keyboard selection</span>
                        <select
                          value=""
                          onChange={(event) => {
                            const meshName = event.target.value;
                            if (!meshName) return;
                            setSelectedTemplatePartNames((current) =>
                              current.includes(meshName)
                                ? current
                                : [...current, meshName],
                            );
                          }}
                        >
                          <option value="">Add a model part…</option>
                          {availableWindowPartNames.map((meshName) => (
                            <option key={meshName} value={meshName}>
                              {meshName}
                            </option>
                          ))}
                        </select>
                      </label>
                      {selectedTemplatePartNames.length > 0 ? (
                        <div className="tg-selected-parts" aria-label="Selected window parts">
                          {selectedTemplatePartNames.map((meshName) => (
                            <div className="tg-selected-part" key={meshName}>
                              <span title={meshName}>{meshName}</span>
                              <button
                                type="button"
                                onClick={() => handleRemoveTemplatePart(meshName)}
                                aria-label={`Remove ${meshName}`}
                              >
                                <X aria-hidden />
                              </button>
                            </div>
                          ))}
                          <button
                            type="button"
                            className="tg-clear-parts"
                            onClick={() => setSelectedTemplatePartNames([])}
                          >
                            <Trash2 aria-hidden />
                            Clear selection
                          </button>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <div className="tg-info-row is-confirmed">
                      <Check aria-hidden />
                      <span>
                        <strong>
                          {templatePolicy.isEup
                            ? "All garment geometry"
                            : "Primary paint geometry"}
                        </strong>
                        <small>Detected automatically from the loaded model.</small>
                      </span>
                    </div>
                  )}
                </section>

                {!isWindowTemplate ? (
                  <section className="tg-inspector-section" aria-labelledby="tg-markers-title">
                    <div className="tg-section-heading">
                      <h2 id="tg-markers-title">Markers</h2>
                      <span>{hasDetectedIslands ? markerProgressLabel : "Detecting"}</span>
                    </div>
                    <div className="tg-marker-summary">
                      <span className="tg-icon-slot" aria-hidden>
                        <MousePointer2 />
                      </span>
                      <span>
                        <strong>
                          {hasDetectedIslands
                            ? markerSelectionConfirmed
                              ? markerProgressLabel
                              : "Placement decision required"
                            : "Analyzing UV regions"}
                        </strong>
                        <small>
                          {hasDetectedIslands
                            ? isMarkerEditMode
                              ? "Choose only locations that need a paint marker."
                              : "Confirmed markers are included in the template."
                            : "Marker candidates appear after the first preview."}
                        </small>
                      </span>
                      {hasDetectedIslands && !isMarkerEditMode ? (
                        <button
                          type="button"
                          className="tg-text-action"
                          onClick={handleBeginMarkerEdit}
                        >
                          Edit
                        </button>
                      ) : null}
                    </div>
                    {hasDetectedIslands ? (
                      <label className="tg-color-row">
                        <span>
                          <strong>Marker colour</strong>
                          <small>Functional template overlay</small>
                        </span>
                        <input
                          type="color"
                          value={globalMarkerColor}
                          onChange={(event) => handleIslandColorChange(event.target.value)}
                          aria-label="Marker colour"
                        />
                      </label>
                    ) : null}
                  </section>
                ) : null}

                <section className="tg-inspector-section" aria-labelledby="tg-output-title">
                  <div className="tg-section-heading">
                    <h2 id="tg-output-title">Output</h2>
                    <span>{outputFormatLabel}</span>
                  </div>
                  <div className="tg-output-meta">
                    <span>Format</span>
                    <strong>{outputFormatLabel}</strong>
                  </div>
                  <div className="tg-field-label">Resolution</div>
                  <div className="tg-size-grid" role="group" aria-label="Template resolution">
                    {SIZE_OPTIONS.map((size) => (
                      <button
                        key={size}
                        type="button"
                        className={exportSize === size ? "is-active" : ""}
                        onClick={() => setExportSize(size)}
                        aria-pressed={exportSize === size}
                        aria-label={`${size} by ${size} pixels`}
                      >
                        {size >= 1024 ? `${size / 1024}K` : size}
                      </button>
                    ))}
                  </div>

                  <div className="tg-setting-list">
                    <div className="tg-setting-row">
                      <Box aria-hidden />
                      <span>
                        <strong>Wireframe layer</strong>
                        <small>Trace UV boundaries</small>
                      </span>
                      <Toggle
                        checked={includeTemplateWireframe}
                        onChange={setIncludeTemplateWireframe}
                        ariaLabel="Include wireframe layer"
                      />
                    </div>
                  </div>

                  <details className="tg-advanced">
                    <summary>
                      <span>Advanced</span>
                      <ChevronDown aria-hidden />
                    </summary>
                    <div className="tg-setting-list">
                      {templatePolicy.supportsExteriorOnly ? (
                        <div className="tg-setting-row">
                          <Layers aria-hidden />
                          <span>
                            <strong>Exterior only</strong>
                            <small>Exclude interior geometry</small>
                          </span>
                          <Toggle
                            checked={exteriorOnly}
                            onChange={setExteriorOnly}
                            ariaLabel="Generate exterior geometry only"
                          />
                        </div>
                      ) : null}
                      <div className="tg-setting-row">
                        <Image aria-hidden />
                        <span>
                          <strong>Normal-map base</strong>
                          <small>Use world-space shading</small>
                        </span>
                        <Toggle
                          checked={worldSpaceNormalsBaseEnabled}
                          onChange={setUseWorldSpaceNormalsAsBase}
                          ariaLabel="Use world-space normals as the base"
                        />
                      </div>
                    </div>
                  </details>
                </section>
              </div>

              <footer className="tg-inspector-footer">
                <div className="tg-save-destination">
                  <span className="tg-field-label">Save to</span>
                  <div>
                    <button
                      type="button"
                      className="tg-location-action"
                      onClick={handleSelectOutputFolder}
                      title={outputFolder || saveLocationLabel}
                      disabled={!isTauriRuntime}
                    >
                      <FolderOpen aria-hidden />
                      <span>{saveLocationLabel}</span>
                      <small>{outputFolder ? "Change" : isTauriRuntime ? "Choose" : ""}</small>
                    </button>
                    {outputFolder && isTauriRuntime ? (
                      <button
                        type="button"
                        className="tg-icon-action"
                        onClick={handleOpenOutputFolder}
                        aria-label="Open output folder"
                        title="Open output folder"
                      >
                        <FolderOpen aria-hidden />
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="tg-export-actions">
                  <button
                    type="button"
                    className="tg-icon-action tg-regenerate-btn"
                    onClick={handleRegenerateTemplate}
                    disabled={!canRegenerate}
                    aria-label="Regenerate template"
                    title="Regenerate template"
                  >
                    <RefreshCw className={generating ? "is-spinning" : ""} aria-hidden />
                  </button>
                  <Button
                    type="button"
                    className="tg-export-primary"
                    onClick={handleSaveTemplate}
                    disabled={exportDisabled}
                    aria-describedby={exportDisabledReason ? "tg-export-reason" : undefined}
                  >
                    <Download aria-hidden />
                    {isSaving ? "Exporting…" : saveButtonLabel}
                  </Button>
                </div>
                {exportDisabledReason ? (
                  <p id="tg-export-reason" className="tg-export-reason" aria-live="polite">
                    {exportDisabledReason}
                  </p>
                ) : autoSavedPath ? (
                  <p className="tg-export-reason is-success" title={autoSavedPath}>
                    Latest template saved.
                  </p>
                ) : (
                  <p className="tg-export-reason">Ready to export {outputFormatLabel}.</p>
                )}
              </footer>
            </aside>

            <section className="tg-stage" aria-label="Template work area">
              <div className="tg-canvases">
                <section className="tg-pane tg-pane--model" aria-label="Model viewport">
                  <header className="tg-pane-header">
                    <div>
                      <Box aria-hidden />
                      <span>
                        <strong>Model</strong>
                        <small>{isWindowTemplate ? "Select geometry" : modelFileName}</small>
                      </span>
                    </div>
                    <div className="tg-pane-header-actions">
                      <div className="tg-viewport-tools" role="toolbar" aria-label="Model view controls">
                        <button
                          type="button"
                          className="tg-viewport-tool is-frame"
                          onClick={handleFrameModel}
                          disabled={!modelViewerReady || modelLoading || Boolean(modelLoadError)}
                          aria-label="Frame model in default view"
                          title="Frame model in default view"
                        >
                          <Scan aria-hidden />
                        </button>
                        <span className="tg-viewport-tool-separator" aria-hidden />
                        {["x", "y", "z"].map((axis) => (
                          <button
                            key={axis}
                            type="button"
                            className="tg-viewport-tool is-rotate"
                            onClick={() => handleRotateModel(axis)}
                            disabled={!modelViewerReady || modelLoading || Boolean(modelLoadError)}
                            aria-label={`Rotate model 90 degrees around ${axis.toUpperCase()} axis`}
                            title={`Rotate model 90° around ${axis.toUpperCase()} axis`}
                          >
                            <RotateCw aria-hidden />
                            <span>{axis.toUpperCase()}</span>
                          </button>
                        ))}
                      </div>
                      <span className="tg-pane-meta">
                        {isWindowTemplate ? selectedPartCountLabel : templatePolicy.label}
                      </span>
                    </div>
                  </header>
                  <div className="tg-pane-content tg-model-shell">
                    <Viewer
                      modelPath={modelPath}
                      texturePath={previewUrl || ""}
                      textureReloadToken={lastGeneratedAt?.getTime() || 0}
                      textureTarget={
                        isWindowTemplate
                          ? selectedTextureTargets
                          : templatePolicy.textureTarget
                      }
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
                      liveryExteriorOnly={
                        templatePolicy.supportsExteriorOnly && exteriorOnly
                      }
                      wasdEnabled={false}
                      isActive={isActive && viewMode !== "template"}
                      includeTemplateGeometry
                      templateMarkerPickModifier={templateMarkerPickModifier}
                      onTemplateMarkerUvHover={
                        !isWindowTemplate && isMarkerEditMode
                          ? handleModelMarkerHover
                          : undefined
                      }
                      onTemplateMarkerUvLeave={
                        !isWindowTemplate && isMarkerEditMode
                          ? clearHoveredMarker
                          : undefined
                      }
                      onTemplateMarkerUvPick={
                        !isWindowTemplate && isMarkerEditMode
                          ? handleModelMarkerPick
                          : undefined
                      }
                      templatePartPickEnabled={isWindowTemplate}
                      selectedTemplatePartNames={selectedTemplatePartNames}
                      hoveredTemplatePartName={hoveredTemplatePartName}
                      onTemplatePartHover={
                        isWindowTemplate ? handleTemplatePartHover : undefined
                      }
                      onTemplatePartLeave={
                        isWindowTemplate
                          ? () => setHoveredTemplatePartName("")
                          : undefined
                      }
                      onTemplatePartPick={
                        isWindowTemplate ? handleTemplatePartPick : undefined
                      }
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
                    {modelLoading ? (
                      <div className="tg-canvas-state is-compact" role="status">
                        <span className="tg-spinner" aria-hidden />
                        Loading model…
                      </div>
                    ) : modelLoadError ? (
                      <div className="tg-canvas-state is-error" role="alert">
                        <AlertTriangle aria-hidden />
                        <span>
                          <strong>Model could not be loaded</strong>
                          <small>{modelLoadError}</small>
                        </span>
                      </div>
                    ) : null}
                    {isWindowTemplate ? (
                      <div
                        className={`tg-canvas-coach${selectedTemplatePartNames.length ? " has-selection" : ""}`}
                        role="status"
                      >
                        <MousePointer2 aria-hidden />
                        <span>
                          <strong>
                            {selectedTemplatePartNames.length
                              ? "Selection updates live"
                              : "Click the window geometry"}
                          </strong>
                          <small>
                            {selectedTemplatePartNames.length
                              ? "Add any other panes that share the artwork."
                              : "Drag anywhere else to rotate the model."}
                          </small>
                        </span>
                      </div>
                    ) : null}
                  </div>
                </section>

                <section className="tg-pane tg-pane--template" aria-label="Template preview">
                  <header className="tg-pane-header">
                    <div>
                      <Image aria-hidden />
                      <span>
                        <strong>Template</strong>
                        <small>
                          {isWindowTemplate ? "Selected geometry" : "Flattened UV preview"}
                        </small>
                      </span>
                    </div>
                    <div className="tg-pane-header-actions">
                      <div className="tg-viewport-tools" role="toolbar" aria-label="Template zoom controls">
                        <button
                          type="button"
                          className="tg-viewport-tool is-template-zoom"
                          onClick={() => adjustTemplatePreviewZoom(-1)}
                          disabled={!previewUrl || templatePreviewZoom <= TEMPLATE_PREVIEW_ZOOM_MIN}
                          aria-label="Zoom template out"
                          aria-keyshortcuts="-"
                          title="Zoom out (-)"
                        >
                          <ZoomOut aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="tg-viewport-tool is-template-fit"
                          onClick={fitTemplatePreview}
                          disabled={!previewUrl}
                          aria-label={`Fit template to view. Current zoom ${Math.round(templatePreviewZoom * 100)} percent`}
                          aria-keyshortcuts="0"
                          title="Fit template to view (0)"
                        >
                          {templatePreviewZoom === 1
                            ? "Fit"
                            : `${Math.round(templatePreviewZoom * 100)}%`}
                        </button>
                        <button
                          type="button"
                          className="tg-viewport-tool is-template-zoom"
                          onClick={() => adjustTemplatePreviewZoom(1)}
                          disabled={!previewUrl || templatePreviewZoom >= TEMPLATE_PREVIEW_ZOOM_MAX}
                          aria-label="Zoom template in"
                          aria-keyshortcuts="+"
                          title="Zoom in (+)"
                        >
                          <ZoomIn aria-hidden />
                        </button>
                      </div>
                      <span className="tg-pane-meta">
                        {previewUrl ? `${exportSize} × ${exportSize}` : "Waiting"}
                      </span>
                    </div>
                  </header>
                  <div
                    ref={previewShellRef}
                    className={`tg-preview-shell${isMarkerEditMode ? " is-edit-mode" : ""}`}
                    tabIndex={previewUrl ? 0 : undefined}
                    onKeyDown={handleTemplatePreviewKeyDown}
                    aria-label={
                      previewUrl
                        ? "Template preview. Use minus and plus to zoom, or zero to fit."
                        : undefined
                    }
                  >
                    {generationError ? (
                      <div className="tg-preview-state is-error" role="alert">
                        <AlertTriangle aria-hidden />
                        <span>
                          <strong>Template generation failed</strong>
                          <small>{generationError}</small>
                        </span>
                      </div>
                    ) : isWindowTemplate && selectedTemplatePartNames.length === 0 ? (
                      <div className="tg-preview-state">
                        <PanelTop aria-hidden />
                        <span>
                          <strong>Select window geometry</strong>
                          <small>
                            The UV preview appears after you select a model region.
                          </small>
                        </span>
                      </div>
                    ) : previewUrl ? (
                      <div className="tg-preview-scroll-region">
                        <div
                          className="tg-preview-canvas"
                          style={{
                            width: `${templatePreviewDisplaySize}px`,
                            height: `${templatePreviewDisplaySize}px`,
                          }}
                        >
                          <img
                            src={previewUrl}
                            alt="Generated template preview"
                            className="tg-preview-image"
                            draggable="false"
                          />

                          {showMarkerSelectionOverlay ? (
                            <div className="tg-preview-marker-overlay is-pick-mode">
                              {markerOverlayMarkers.map((marker, index) => {
                                const markerKey = marker?.key || `overlay-${index}`;
                                const markerRect = getMarkerTextureRect(marker);
                                if (!markerRect) return null;
                                const markerSelected =
                                  pendingMarkerSelection[markerKey] === true;
                                const markerLabel = marker?.label || `Marker ${index + 1}`;
                                return (
                                  <button
                                    key={markerKey}
                                    type="button"
                                    className={`tg-preview-marker-hitbox${markerSelected ? " is-selected" : ""}${
                                      hoveredMarkerKey === markerKey ? " is-hovered" : ""
                                    }`}
                                    style={{
                                      left: `${(markerRect.x / exportSize) * 100}%`,
                                      top: `${(markerRect.y / exportSize) * 100}%`,
                                      width: `${(markerRect.width / exportSize) * 100}%`,
                                      height: `${(markerRect.height / exportSize) * 100}%`,
                                    }}
                                    onMouseEnter={() => setHoveredMarker(markerKey)}
                                    onMouseLeave={clearHoveredMarker}
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      handleTogglePendingMarkerSelection(markerKey);
                                    }}
                                    aria-pressed={markerSelected}
                                    aria-label={`${markerSelected ? "Deselect" : "Select"} ${markerLabel}`}
                                    title={`${markerSelected ? "Deselect" : "Select"} ${markerLabel}`}
                                  />
                                );
                              })}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ) : (
                      <div className="tg-preview-state" role="status">
                        {generating ? (
                          <span className="tg-spinner" aria-hidden />
                        ) : (
                          <Box aria-hidden />
                        )}
                        <span>
                          <strong>{generating ? "Generating template" : "Preparing preview"}</strong>
                          <small>
                            {generating
                              ? "Flattening UV geometry and building layers."
                              : "The preview will appear when the model is ready."}
                          </small>
                        </span>
                      </div>
                    )}

                    {generating && previewUrl ? (
                      <div className="tg-preview-busy" role="status">
                        <span className="tg-spinner" aria-hidden />
                        Refreshing template…
                      </div>
                    ) : null}
                  </div>
                </section>
              </div>

              <footer
                className={`tg-stage-status${isMarkerEditMode && hasDetectedIslands ? " is-contextual" : ""}`}
                aria-live="polite"
              >
                {isMarkerEditMode && hasDetectedIslands ? (
                  <>
                    <div className="tg-status-copy">
                      <span>Markers</span>
                      <strong>{pendingSelectedCount} / {detectedIslands.length}</strong>
                      <small>{markerPickHint}</small>
                    </div>
                    <div className="tg-status-actions">
                      <button
                        type="button"
                        className="tg-status-action"
                        onClick={handleClearPendingMarkerSelection}
                        disabled={!pendingSelectedCount}
                      >
                        Clear
                      </button>
                      {!pendingSelectedCount && !markerSelectionConfirmed ? (
                        <button
                          type="button"
                          className="tg-status-action"
                          onClick={handleConfirmNoMarkers}
                        >
                          Use no markers
                        </button>
                      ) : null}
                      {markerSelectionConfirmed ? (
                        <button
                          type="button"
                          className="tg-status-action"
                          onClick={handleCancelMarkerEdit}
                        >
                          Cancel
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="tg-status-action is-primary"
                        onClick={handleConfirmMarkerSelection}
                        disabled={!pendingSelectedCount && !markerSelectionConfirmed}
                      >
                        Apply markers
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="tg-status-copy">
                      <span className={generationError || modelLoadError ? "is-error" : ""}>
                        {buildStatusLabel}
                      </span>
                      <small>{statusSummary}</small>
                    </div>
                    <div className="tg-status-meta">
                      {lastGeneratedAt
                        ? `Updated ${lastGeneratedAt.toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}`
                        : templatePolicy.label}
                    </div>
                  </>
                )}
              </footer>
            </section>
          </div>
        </div>
      )}

      {saveNotice.message ? (
        <div className={`tg-save-notice is-${saveNotice.tone}`} role="status">
          {saveNotice.tone === "success" ? (
            <Check aria-hidden />
          ) : (
            <AlertTriangle aria-hidden />
          )}
          <span>{saveNotice.message}</span>
        </div>
      ) : null}
    </main>
  );
}
