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
  Shirt,
  Trash2,
  X,
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
  if (normalizedFormat === "png") return "Save PNG";
  if (normalizedFormat === "psd_png") return "Save PSD + PNG";
  return "Save PSD";
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
  const [viewMode, setViewMode] = useState(() =>
    normalizeTemplateViewMode(workspaceState?.viewMode),
  );
  const [modelLoading, setModelLoading] = useState(false);
  const [modelLoadError, setModelLoadError] = useState("");
  const persistTimerRef = useRef(null);
  const regenerateTimerRef = useRef(null);
  const saveNoticeTimerRef = useRef(null);
  const previewShellRef = useRef(null);
  const templatePolicy = getTemplateModelPolicy(modelPath);
  const isWindowTemplate = templatePurpose === "windows" && !templatePolicy.isEup;

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
        getContainedTemplateViewport(node.clientWidth || 0, node.clientHeight || 0),
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
  const markerOverlayStyle = {
    left: `${previewViewport.offsetX}px`,
    top: `${previewViewport.offsetY}px`,
    width: `${previewViewport.size}px`,
    height: `${previewViewport.size}px`,
  };
  const showMarkerSelectionOverlay =
    previewUrl && hasDetectedIslands && previewViewport.size > 0 && isMarkerEditMode;
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

  const markerPromptEl = hasDetectedIslands && !isWindowTemplate ? (
    <div
      className={`tg-marker-prompt${compactHeight ? " tg-marker-prompt--compact" : ""}`}
      aria-live="polite"
    >
      <div className="tg-marker-prompt-row">
        <div id="tg-marker-placement-copy" className="tg-marker-prompt-copy">
          <span className="tg-marker-prompt-eyebrow">
            {isMarkerEditMode
              ? markerSelectionConfirmed
                ? "Edit marker placement"
                : "Marker placement required"
              : "Marker placement"}
          </span>
          <strong className="tg-marker-prompt-count">{markerSelectionCountLabel}</strong>
          <span className="tg-marker-prompt-text">{markerSelectionHint}</span>
          {isMarkerEditMode ? (
            <span className="tg-marker-prompt-example">
              <strong>Example:</strong> choose the door-handle or badge island, not every small island.
            </span>
          ) : null}
        </div>
        <div className="tg-marker-prompt-actions">
          {isMarkerEditMode ? (
            <>
              <button
                type="button"
                className="tg-marker-prompt-btn is-primary"
                onClick={handleConfirmMarkerSelection}
                disabled={!pendingSelectedCount && !markerSelectionConfirmed}
              >
                Apply markers
              </button>
              <button
                type="button"
                className="tg-marker-prompt-btn"
                onClick={handleClearPendingMarkerSelection}
                disabled={!pendingSelectedCount}
              >
                Clear
              </button>
              {!pendingSelectedCount && !markerSelectionConfirmed ? (
                <button
                  type="button"
                  className="tg-marker-prompt-btn"
                  onClick={handleConfirmNoMarkers}
                >
                  Use no markers
                </button>
              ) : null}
              {markerSelectionConfirmed ? (
                <button
                  type="button"
                  className="tg-marker-prompt-btn"
                  onClick={handleCancelMarkerEdit}
                >
                  Cancel
                </button>
              ) : null}
            </>
          ) : (
            <>
              <button
                type="button"
                className="tg-marker-prompt-btn is-primary"
                onClick={handleBeginMarkerEdit}
              >
                Edit
              </button>
              <button
                type="button"
                className="tg-marker-prompt-btn"
                onClick={handleResetMarkerSelection}
                disabled={!confirmedSelectedCount && !markerSelectionConfirmed}
              >
                Reset
              </button>
            </>
          )}
        </div>
      </div>
      <div
        className={`tg-marker-tip${
          isMarkerEditMode ? " is-active" : ""
        }`}
      >
        <span className="tg-marker-tip-line">
          {markerPickHint}
        </span>
      </div>
    </div>
  ) : null;

  return (
    <div className="tg-root">
        <AnimatePresence mode="wait">
          {!modelPath ? (
          /* ━━━ Empty state: immersive CTA ━━━ */
          <motion.div
            key="tg-empty"
            className="tg-empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35 }}
          >
            <div className="tg-empty-grid" aria-hidden />
            <motion.div
              className="tg-empty-cta"
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.12, duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="tg-empty-icon">
                <Sparkles className="w-7 h-7" />
              </div>
              <span className="tg-empty-kicker">UV workspace</span>
              <h2 className="tg-empty-title">Build the template your model needs</h2>
              <p className="tg-empty-desc">
                Import a model, choose body or window graphics, and select geometry visually.<br />
                No material naming convention required.
              </p>
              <div className="tg-empty-flow" aria-label="Template workflow">
                <span><b>01</b> Import model</span>
                <span><b>02</b> Pick focus</span>
                <span><b>03</b> Export PSD</span>
              </div>
              <motion.button
                type="button"
                className="tg-empty-btn"
                onClick={handleSelectModel}
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.96 }}
              >
                <Box className="w-4 h-4" />
                Import .yft or .ydd model
              </motion.button>
            </motion.div>
          </motion.div>
        ) : (
          /* ━━━ Active workspace: sidebar + viewer + preview ━━━ */
          <motion.div
            key="tg-active"
            className="tg-workspace"
            ref={workspaceRef}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
          >
            {/* ── Guided template setup ── */}
            <motion.aside
              className={`tg-sidebar${generationError ? " has-error" : ""}${generating ? " is-generating" : ""}`}
              aria-label="Template setup"
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1], delay: 0.08 }}
            >
              <div className="tg-sidebar-heading">
                <div>
                  <span className="tg-sidebar-kicker">Template builder</span>
                  <h2>{isWindowTemplate ? "Window graphics" : templatePolicy.isEup ? "EUP texture" : "Body livery"}</h2>
                </div>
                <span className={`tg-build-status${generating ? " is-busy" : ""}`} role="status">
                  {generating ? "Building" : previewUrl ? "Ready" : "Setup"}
                </span>
              </div>

              <div className="tg-sidebar-scroll">
                <section className="tg-step" aria-labelledby="tg-source-title">
                  <div className="tg-step-heading">
                    <span className="tg-step-number">01</span>
                    <div>
                      <h3 id="tg-source-title">Source model</h3>
                      <p>Loaded and ready to inspect</p>
                    </div>
                  </div>
                  <div className="tg-source-row" title={modelPath}>
                    <span className="tg-source-icon" aria-hidden>
                      {templatePolicy.isEup ? <Shirt /> : <Car />}
                    </span>
                    <span className="tg-source-copy">
                      <strong>{modelFileName}</strong>
                      <small>{templatePolicy.label} model</small>
                    </span>
                    <button type="button" onClick={handleSelectModel}>Replace</button>
                    <button type="button" className="tg-icon-action" onClick={handleUnloadModel} aria-label="Unload model">
                      <X />
                    </button>
                  </div>
                  {templateSetWarning ? <p className="tg-inline-warning">{templateSetWarning}</p> : null}
                </section>

                <section className="tg-step" aria-labelledby="tg-purpose-title">
                  <div className="tg-step-heading">
                    <span className="tg-step-number">02</span>
                    <div>
                      <h3 id="tg-purpose-title">Template focus</h3>
                      <p>Choose what artists will paint</p>
                    </div>
                  </div>
                  <div className="tg-purpose-options" role="group" aria-label="Template focus">
                    <button
                      type="button"
                      className={`tg-purpose-option${!isWindowTemplate ? " is-active" : ""}`}
                      onClick={() => handleTemplatePurposeChange("body")}
                      aria-pressed={!isWindowTemplate}
                    >
                      <Image aria-hidden />
                      <span><strong>{templatePolicy.isEup ? "Garment" : "Body livery"}</strong><small>Automatic UV target</small></span>
                    </button>
                    <button
                      type="button"
                      className={`tg-purpose-option${isWindowTemplate ? " is-active" : ""}`}
                      onClick={() => handleTemplatePurposeChange("windows")}
                      aria-pressed={isWindowTemplate}
                      disabled={templatePolicy.isEup}
                      title={templatePolicy.isEup ? "Window templates are available for vehicle models." : "Select window geometry directly on the model."}
                    >
                      <PanelTop aria-hidden />
                      <span><strong>Window graphics</strong><small>Pick geometry yourself</small></span>
                    </button>
                  </div>
                </section>

                {isWindowTemplate ? (
                  <section className="tg-step is-active" aria-labelledby="tg-parts-title">
                    <div className="tg-step-heading">
                      <span className="tg-step-number">03</span>
                      <div>
                        <h3 id="tg-parts-title">Select window parts</h3>
                        <p>{selectedPartCountLabel}</p>
                      </div>
                    </div>
                    <div className="tg-pick-instruction">
                      <MousePointer2 aria-hidden />
                      <span><strong>Click a window in the model.</strong><small>Drag to rotate. Click again to remove a part.</small></span>
                    </div>
                    {suggestedWindowPartNames.length > 0 && selectedTemplatePartNames.length === 0 ? (
                      <button
                        type="button"
                        className="tg-suggestion-btn"
                        onClick={() => setSelectedTemplatePartNames(suggestedWindowPartNames)}
                      >
                        <Sparkles aria-hidden />
                        Try likely window match
                      </button>
                    ) : null}
                    <label className="tg-part-select-label">
                      <span>Keyboard fallback</span>
                      <select
                        value=""
                        onChange={(event) => {
                          const meshName = event.target.value;
                          if (!meshName) return;
                          setSelectedTemplatePartNames((current) =>
                            current.includes(meshName) ? current : [...current, meshName],
                          );
                        }}
                      >
                        <option value="">Add a model part…</option>
                        {availableWindowPartNames.map((meshName) => (
                          <option key={meshName} value={meshName}>{meshName}</option>
                        ))}
                      </select>
                    </label>
                    {selectedTemplatePartNames.length > 0 ? (
                      <div className="tg-selected-parts" aria-label="Selected window parts">
                        {selectedTemplatePartNames.map((meshName, index) => (
                          <div className="tg-selected-part" key={meshName}>
                            <span><small>Part {index + 1}</small><strong title={meshName}>{meshName}</strong></span>
                            <button type="button" onClick={() => handleRemoveTemplatePart(meshName)} aria-label={`Remove ${meshName}`}>
                              <X />
                            </button>
                          </div>
                        ))}
                        <button type="button" className="tg-clear-parts" onClick={() => setSelectedTemplatePartNames([])}>
                          <Trash2 aria-hidden /> Clear selection
                        </button>
                      </div>
                    ) : null}
                  </section>
                ) : (
                  <section className="tg-step is-complete" aria-labelledby="tg-target-title">
                    <div className="tg-step-heading">
                      <span className="tg-step-number">03</span>
                      <div>
                        <h3 id="tg-target-title">UV target</h3>
                        <p>Detected automatically</p>
                      </div>
                    </div>
                    <div className="tg-auto-target">
                      <Check aria-hidden />
                      <span><strong>{templatePolicy.isEup ? "All garment geometry" : "Primary paint geometry"}</strong><small>No material-name setup required</small></span>
                    </div>
                  </section>
                )}

                <section className="tg-step" aria-labelledby="tg-output-title">
                  <div className="tg-step-heading">
                    <span className="tg-step-number">04</span>
                    <div>
                      <h3 id="tg-output-title">Output</h3>
                      <p>PSD construction settings</p>
                    </div>
                    <SlidersHorizontal aria-hidden className="tg-step-heading-icon" />
                  </div>
                  <div className="tg-size-grid" role="group" aria-label="Template resolution">
                    {SIZE_OPTIONS.map((size) => (
                      <button
                        key={size}
                        type="button"
                        className={exportSize === size ? "is-active" : ""}
                        onClick={() => setExportSize(size)}
                        aria-pressed={exportSize === size}
                      >
                        {size >= 1024 ? `${size / 1024}K` : size}
                      </button>
                    ))}
                  </div>
                  <div className="tg-setting-list">
                    {!isWindowTemplate && templatePolicy.supportsExteriorOnly ? (
                      <button type="button" className="tg-setting-row" onClick={() => setExteriorOnly((value) => !value)} aria-pressed={exteriorOnly}>
                        <Layers aria-hidden /><span><strong>Exterior only</strong><small>Hide interior geometry</small></span><i className={exteriorOnly ? "is-on" : ""} />
                      </button>
                    ) : null}
                    <button type="button" className="tg-setting-row" onClick={() => setIncludeTemplateWireframe((value) => !value)} aria-pressed={includeTemplateWireframe}>
                      <Box aria-hidden /><span><strong>Wireframe layer</strong><small>Trace UV boundaries</small></span><i className={includeTemplateWireframe ? "is-on" : ""} />
                    </button>
                    <button type="button" className="tg-setting-row" onClick={() => setUseWorldSpaceNormalsAsBase((value) => !value)} aria-pressed={worldSpaceNormalsBaseEnabled}>
                      <Sparkles aria-hidden /><span><strong>Normal-map base</strong><small>Use world-space shading</small></span><i className={worldSpaceNormalsBaseEnabled ? "is-on" : ""} />
                    </button>
                  </div>
                  {hasDetectedIslands && !isWindowTemplate ? (
                    <label className="tg-marker-color-row">
                      <span><strong>Marker color</strong><small>Detected detail islands</small></span>
                      <input type="color" value={globalMarkerColor} onChange={(event) => handleIslandColorChange(event.target.value)} />
                    </label>
                  ) : null}
                </section>
              </div>

              <div className="tg-sidebar-footer">
                <button type="button" className="tg-output-folder" onClick={handleSelectOutputFolder} title={outputFolder || "Choose output folder"}>
                  <FolderOpen aria-hidden />
                  <span><small>Save location</small><strong>{outputFolder ? getFileLabel(outputFolder, outputFolder) : "Choose folder"}</strong></span>
                </button>
                {outputFolder ? (
                  <button type="button" className="tg-icon-action" onClick={handleOpenOutputFolder} aria-label="Open output folder">
                    <FolderOpen />
                  </button>
                ) : null}
                <button type="button" className="tg-regenerate-btn" onClick={handleRegenerateTemplate} disabled={!canRegenerate} aria-label="Regenerate template">
                  <RefreshCw className={generating ? "is-spinning" : ""} />
                </button>
                <button
                  type="button"
                  className="tg-save-primary"
                  onClick={handleSaveTemplate}
                  disabled={
                    !psdBytes ||
                    generating ||
                    isSaving ||
                    markerPlacementRequired
                  }
                  title={
                    markerPlacementRequired
                      ? "Choose marker locations or continue with no markers before saving."
                      : undefined
                  }
                  aria-describedby={
                    markerPlacementRequired ? "tg-marker-placement-copy" : undefined
                  }
                >
                  <Download aria-hidden />
                  {isSaving ? "Saving…" : saveButtonLabel}
                </button>
              </div>
            </motion.aside>

            {/* ── Model Viewer ── */}
            <motion.div
              className="tg-pane tg-pane--model"
              initial={{ opacity: 0, scale: 0.985 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="tg-pane-header">
                <div>
                  <span className="tg-pane-index">A</span>
                  <span><strong>Model</strong><small>{isWindowTemplate ? "Select geometry" : "Inspect result"}</small></span>
                </div>
                <span className="tg-pane-meta">{isWindowTemplate ? selectedPartCountLabel : templatePolicy.label}</span>
              </div>
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
                isActive={isActive}
                includeTemplateGeometry
                templateMarkerPickModifier={templateMarkerPickModifier}
                onTemplateMarkerUvHover={!isWindowTemplate && isMarkerEditMode ? handleModelMarkerHover : undefined}
                onTemplateMarkerUvLeave={!isWindowTemplate && isMarkerEditMode ? clearHoveredMarker : undefined}
                onTemplateMarkerUvPick={!isWindowTemplate && isMarkerEditMode ? handleModelMarkerPick : undefined}
                templatePartPickEnabled={isWindowTemplate}
                selectedTemplatePartNames={selectedTemplatePartNames}
                hoveredTemplatePartName={hoveredTemplatePartName}
                onTemplatePartHover={isWindowTemplate ? handleTemplatePartHover : undefined}
                onTemplatePartLeave={isWindowTemplate ? () => setHoveredTemplatePartName("") : undefined}
                onTemplatePartPick={isWindowTemplate ? handleTemplatePartPick : undefined}
                onModelInfo={handleModelInfo}
                onReady={NOOP}
                onTextureReload={NOOP}
                onTextureError={NOOP}
                onWindowTextureError={NOOP}
                onModelError={NOOP}
                onModelLoading={NOOP}
                onFormatWarning={NOOP}
              />
              {isWindowTemplate ? (
                <div className={`tg-part-coach${selectedTemplatePartNames.length ? " has-selection" : ""}`} role="status">
                  <MousePointer2 aria-hidden />
                  <span>
                    <strong>{selectedTemplatePartNames.length ? "Selection updates live" : "Click the window geometry"}</strong>
                    <small>{selectedTemplatePartNames.length ? "Add any other panes that share the artwork." : "Drag anywhere to rotate the model."}</small>
                  </span>
                </div>
              ) : null}
              {compactHeight && markerPromptEl}
            </motion.div>

            {/* ── Template Preview ── */}
            <motion.div
              className="tg-pane tg-pane--template"
              initial={{ opacity: 0, scale: 0.985 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1], delay: 0.06 }}
            >
              <div className="tg-pane-header">
                <div>
                  <span className="tg-pane-index">B</span>
                  <span><strong>Template</strong><small>Live flattened preview</small></span>
                </div>
                <span className="tg-pane-meta">{previewUrl ? `${exportSize} × ${exportSize}` : "Waiting"}</span>
              </div>
              <div
                ref={previewShellRef}
                className={`tg-preview-shell${isMarkerEditMode ? " is-edit-mode" : ""}${
                  markerSelectionPickingActive ? " is-pick-mode" : ""
                }`}
              >
                <AnimatePresence mode="wait" initial={false}>
                  {generationError ? (
                    <motion.div
                      key={`error-${generationError}`}
                      className="tg-preview-state tg-preview-state--error"
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.22, ease: "easeOut" }}
                    >
                      <AlertTriangle className="w-5 h-5" />
                      <span>{generationError}</span>
                    </motion.div>
                  ) : isWindowTemplate && selectedTemplatePartNames.length === 0 ? (
                    <motion.div
                      key="window-selection-required"
                      className="tg-preview-state tg-preview-state--selection"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                    >
                      <PanelTop aria-hidden />
                      <strong>Select a window part</strong>
                      <span>Your UV template will appear here as soon as you click the model.</span>
                    </motion.div>
                  ) : previewUrl ? (
                    <motion.img
                      key={`preview-${lastGeneratedAt?.getTime() || previewUrl.length}`}
                      src={previewUrl}
                      alt="PSD preview"
                      className="tg-preview-image"
                      initial={{ opacity: 0, scale: 1.012, filter: "blur(6px)" }}
                      animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
                      exit={{ opacity: 0, scale: 0.992, filter: "blur(5px)" }}
                      transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
                    />
                  ) : generating ? (
                    <motion.div
                      key="generating"
                      className="tg-preview-state"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.22 }}
                      >
                        <motion.div
                          className="tg-gen-ring"
                          animate={{ rotate: 360 }}
                          transition={{ duration: 1.2, ease: "linear", repeat: Infinity }}
                        />
                      </motion.div>
                  ) : (
                    <motion.div
                      key="idle"
                      className="tg-preview-state"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.2 }}
                    >
                      <Sparkles className="w-5 h-5" />
                    </motion.div>
                  )}
                </AnimatePresence>

                {showMarkerSelectionOverlay ? (
                  <div
                    className={`tg-preview-marker-overlay${
                      markerSelectionPickingActive ? " is-pick-mode" : ""
                    }`}
                    style={markerOverlayStyle}
                  >
                    {markerOverlayMarkers.map((marker, index) => {
                      const markerKey = marker?.key || `overlay-${index}`;
                      const markerRect = getMarkerTextureRect(marker);
                      if (!markerRect) return null;
                      const markerSelected = pendingMarkerSelection[markerKey] === true;
                      const markerLabel = marker?.label || `Marker ${index + 1}`;
                      return (
                        <button
                          key={markerKey}
                          type="button"
                          className={`tg-preview-marker-hitbox${
                            markerSelected ? " is-selected" : ""
                          }${hoveredMarkerKey === markerKey ? " is-hovered" : ""}`}
                          style={{
                            left: `${(markerRect.x / exportSize) * previewViewport.size}px`,
                            top: `${(markerRect.y / exportSize) * previewViewport.size}px`,
                            width: `${(markerRect.width / exportSize) * previewViewport.size}px`,
                            height: `${(markerRect.height / exportSize) * previewViewport.size}px`,
                          }}
                          onMouseEnter={() => setHoveredMarker(markerKey)}
                          onMouseLeave={clearHoveredMarker}
                          onClick={(event) => {
                            if (!markerSelectionPickingActive) return;
                            event.preventDefault();
                            event.stopPropagation();
                            handleTogglePendingMarkerSelection(markerKey);
                          }}
                          aria-label={`${markerSelected ? "Deselect" : "Select"} ${markerLabel}`}
                          title={`${markerSelected ? "Deselect" : "Select"} ${markerLabel}`}
                          tabIndex={markerSelectionPickingActive ? 0 : -1}
                        />
                      );
                    })}
                  </div>
                ) : null}

                {!compactHeight && markerPromptEl}

                <AnimatePresence>
                  {generating && previewUrl && (
                    <motion.div
                      className="tg-preview-refresh-overlay"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
                    >
                      <motion.div
                        className="tg-preview-refresh-ring"
                        animate={{ rotate: 360 }}
                        transition={{ duration: 1.05, ease: "linear", repeat: Infinity }}
                      >
                        <span />
                        <span />
                        <span />
                      </motion.div>
                      <motion.span
                        className="tg-preview-refresh-text"
                        initial={{ opacity: 0.65, y: 2 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.3 }}
                      >
                        Refreshing template...
                      </motion.span>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {saveNotice.message && (
            <motion.div
              className={`tg-save-notice is-${saveNotice.tone}`}
              role="status"
              initial={{ opacity: 0, y: -10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.98 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            >
              {saveNotice.tone === "success" ? <Check className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
              <span>{saveNotice.message}</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
  );
}
