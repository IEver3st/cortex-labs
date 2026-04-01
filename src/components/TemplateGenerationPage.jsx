import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { open } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import {
  AlertTriangle,
  Bug,
  Box,
  Car,
  Check,
  Copy,
  Download,
  FolderOpen,
  Layers,
  RefreshCw,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import Viewer from "./Viewer";
import { buildAutoTemplatePsd } from "../lib/template-psd";
import { loadPrefs, savePrefs } from "../lib/prefs";
import { openFolderPath } from "../lib/open-folder";
import {
  buildMarkerSelectionDraft,
  countSelectedMarkers,
  getContainedTemplateViewport,
  getMarkerTextureRect,
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
const DEFAULT_TEMPLATE_TELEMETRY_ENDPOINT = (import.meta.env?.VITE_TEMPLATE_TELEMETRY_ENDPOINT || "").trim();
const TELEMETRY_EVENT_TYPE = "template_generation_issue";

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

function getDefaultTemplateTelemetryEndpoint() {
  const prefs = loadPrefs() || {};
  const fromPrefs = prefs?.defaults?.templateTelemetryEndpoint;
  if (typeof fromPrefs === "string" && fromPrefs.trim()) return fromPrefs.trim();
  return DEFAULT_TEMPLATE_TELEMETRY_ENDPOINT;
}

function getDefaultTemplateMarkerPickModifier() {
  const prefs = loadPrefs() || {};
  return normalizeTemplateMarkerPickModifier(prefs?.defaults?.templateMarkerPickModifier);
}

function persistTemplateTelemetryEndpoint(nextEndpoint) {
  const prefs = loadPrefs() || {};
  const defaults = prefs?.defaults && typeof prefs.defaults === "object" ? prefs.defaults : {};
  const endpoint = typeof nextEndpoint === "string" ? nextEndpoint.trim() : "";
  const nextDefaults = { ...defaults };
  if (endpoint) {
    nextDefaults.templateTelemetryEndpoint = endpoint;
  } else {
    delete nextDefaults.templateTelemetryEndpoint;
  }
  savePrefs({ ...prefs, defaults: nextDefaults });
}

function getFileLabel(path, fallback = "") {
  if (!path) return fallback;
  const parts = path.toString().split(/[\\/]/);
  return parts[parts.length - 1] || fallback;
}

function createTelemetryReportId() {
  const nonce = Math.random().toString(36).slice(2, 10);
  return `tg-${Date.now()}-${nonce}`;
}

function toErrorMessage(error, fallback) {
  if (error && typeof error === "object" && "message" in error) {
    const value = error.message;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

function triggerTextDownload(fileName, textContent, mimeType = "application/json") {
  const blob = new Blob([textContent], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

async function writeTextToClipboard(text) {
  if (!navigator?.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
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
  const [layerCount, setLayerCount] = useState(0);
  const [targetCount, setTargetCount] = useState(0);
  const [generating, setGenerating] = useState(false);
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
  const [isTelemetryDialogOpen, setIsTelemetryDialogOpen] = useState(false);
  const [telemetrySending, setTelemetrySending] = useState(false);
  const [telemetryStatus, setTelemetryStatus] = useState({ tone: "", message: "" });
  const [telemetryDraft, setTelemetryDraft] = useState(() => ({
    summary: "",
    details: "",
    expectedBehavior: "",
    severity: "high",
    endpoint: getDefaultTemplateTelemetryEndpoint(),
    includeDiagnostics: true,
    includeModelPath: false,
  }));
  const [compactHeight, setCompactHeight] = useState(false);
  const persistTimerRef = useRef(null);
  const regenerateTimerRef = useRef(null);
  const telemetryStatusTimerRef = useRef(null);
  const previewShellRef = useRef(null);
  const workspaceRef = useRef(null);

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
        exportSize,
        exteriorOnly,
        includeTemplateWireframe,
        useWorldSpaceNormalsAsBase,
        detectedIslands,
        detectedIslandColors,
        detectedIslandVisibility,
        markerSelectionConfirmed,
      });
    }, 140);

    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, [
    modelPath,
    outputFolder,
    exportSize,
    exteriorOnly,
    includeTemplateWireframe,
    useWorldSpaceNormalsAsBase,
    detectedIslands,
    detectedIslandColors,
    detectedIslandVisibility,
    markerSelectionConfirmed,
    onStateChange,
  ]);

  useEffect(() => {
    return () => {
      if (regenerateTimerRef.current) clearTimeout(regenerateTimerRef.current);
      if (telemetryStatusTimerRef.current) clearTimeout(telemetryStatusTimerRef.current);
    };
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

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const obs = new ResizeObserver(([entry]) => {
      setCompactHeight(entry.contentRect.height < 480);
    });
    const node = workspaceRef.current;
    if (node) obs.observe(node);
    return () => obs.disconnect();
  }, []);

  const clearGeneratedState = useCallback(() => {
    setTemplateMap(null);
    setTemplateMapError("");
    setTemplatePsdSource(null);
    setTemplatePsdSourceError("");
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
    setLayerCount(0);
    setTargetCount(0);
    setGenerating(false);
    setGenerationError("");
    setAutoSavedPath("");
    setLastGeneratedAt(null);
    if (regenerateTimerRef.current) {
      clearTimeout(regenerateTimerRef.current);
      regenerateTimerRef.current = null;
    }
  }, []);

  const handleSelectModel = useCallback(async () => {
    if (!isTauriRuntime) return;
    try {
      const selected = await open({
        filters: [{ name: "Vehicle Model", extensions: ["yft"] }],
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
    setTemplateMap(info?.templateMap || null);
    setTemplateMapError(info?.templateMapError || "");
    setTemplatePsdSource(info?.templatePsdSource || null);
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

  const setTelemetryNotice = useCallback((tone, message, timeoutMs = 0) => {
    if (telemetryStatusTimerRef.current) {
      clearTimeout(telemetryStatusTimerRef.current);
      telemetryStatusTimerRef.current = null;
    }
    setTelemetryStatus({ tone, message });
    if (timeoutMs > 0) {
      telemetryStatusTimerRef.current = setTimeout(() => {
        setTelemetryStatus({ tone: "", message: "" });
        telemetryStatusTimerRef.current = null;
      }, timeoutMs);
    }
  }, []);

  const openTelemetryDialog = useCallback((prefillMessage = "") => {
    const prefill = typeof prefillMessage === "string" ? prefillMessage.trim() : "";
    setTelemetryStatus({ tone: "", message: "" });
    setIsTelemetryDialogOpen(true);
    setTelemetryDraft((prev) => ({
      ...prev,
      endpoint: prev.endpoint || getDefaultTemplateTelemetryEndpoint(),
      summary: prev.summary || (prefill ? `Template issue: ${prefill.slice(0, 140)}` : ""),
      details: prev.details || (prefill ? `Observed error:\n${prefill}` : ""),
    }));
  }, []);

  const closeTelemetryDialog = useCallback(() => {
    if (telemetrySending) return;
    setIsTelemetryDialogOpen(false);
  }, [telemetrySending]);

  useEffect(() => {
    if (!isTelemetryDialogOpen) return;
    const handleKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeTelemetryDialog();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeTelemetryDialog, isTelemetryDialogOpen]);

  const handleRegenerateTemplate = useCallback(() => {
    if (!modelPath || !templateMap || !templatePsdSource || generating) return;
    setGenerating(true);
    setGenerationError("");
    setAutoSavedPath("");
    if (regenerateTimerRef.current) clearTimeout(regenerateTimerRef.current);
    regenerateTimerRef.current = setTimeout(() => {
      setRegenerationToken((token) => token + 1);
      regenerateTimerRef.current = null;
    }, 180);
  }, [generating, modelPath, templateMap, templatePsdSource]);

  useEffect(() => {
    const upstreamError = templateMapError || templatePsdSourceError || "";

    if (!modelPath || !templateMap || !templatePsdSource) {
      setPreviewUrl("");
      setPsdBytes(null);
      setGenerationError(upstreamError);
      setLayerCount(0);
      setTargetCount(0);
      setDetectedIslands([]);
      setAutoSavedPath("");
      setGenerating(false);
      return;
    }

    let cancelled = false;
    let cancelBuildJob = NOOP;
    const generate = async () => {
      setGenerating(true);
      setGenerationError(upstreamError);

      try {
        const buildOptions = {
          size: exportSize,
          modelPath,
          modelFileName: getFileLabel(modelPath, "template"),
          templatePsdSource,
          fillColor: autoTemplateColor,
          preferredTarget: "material:vehicle_paint3",
          includeWireframe: includeTemplateWireframe,
          includeWorldSpaceNormals: useWorldSpaceNormalsAsBase,
          useWorldSpaceNormalsAsBase,
          detectedIslandColors,
          detectedIslandVisibility,
        };

        const buildJob = createTemplateBuildJob(templateMap, buildOptions);
        cancelBuildJob = buildJob.cancel;
        let result;
        try {
          result = await buildJob.promise;
        } catch {
          if (cancelled) return;
          result = await buildAutoTemplatePsd(templateMap, buildOptions);
        }

        if (cancelled) return;
        setPreviewUrl(result.previewDataUrl);
        setPsdBytes(result.bytes);
        setPsdFileName(result.fileName);
        setLayerCount(result.layerCount);
        setTargetCount(result.targetCount);
        const nextMarkers = Array.isArray(result.detectedIslands) ? result.detectedIslands : [];
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

        const exportOutputs = buildTemplateExportOutputs({
          format: autoTemplateExportFormat,
          psdBytes: result.bytes,
          psdFileName: result.fileName,
          previewDataUrl: result.previewDataUrl,
        });

        if (isTauriRuntime && outputFolder && exportOutputs.length > 0) {
          const savedPaths = [];
          for (const output of exportOutputs) {
            const autoPath = `${outputFolder}/${output.fileName}`;
            await writeFile(autoPath, output.bytes);
            savedPaths.push(autoPath);
          }
          if (cancelled) return;
          setAutoSavedPath(savedPaths.join(" | "));
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
      cancelBuildJob();
    };
  }, [
    templateMap,
    templateMapError,
    templatePsdSource,
    templatePsdSourceError,
    exportSize,
    modelPath,
    outputFolder,
    autoTemplateColor,
    autoTemplateExportFormat,
    includeTemplateWireframe,
    useWorldSpaceNormalsAsBase,
    detectedIslandColors,
    detectedIslandVisibility,
    regenerationToken,
    isTauriRuntime,
  ]);

  const handleSaveTemplate = useCallback(async () => {
    let exportOutputs;
    try {
      exportOutputs = buildTemplateExportOutputs({
        format: autoTemplateExportFormat,
        psdBytes,
        psdFileName,
        previewDataUrl: previewUrl,
      });
    } catch (error) {
      const message =
        error && typeof error === "object" && "message" in error
          ? error.message
          : "Template export failed.";
      setGenerationError(message);
      return;
    }
    if (exportOutputs.length === 0) return;

    if (isTauriRuntime && outputFolder) {
      try {
        const savedPaths = [];
        for (const output of exportOutputs) {
          const filePath = `${outputFolder}/${output.fileName}`;
          await writeFile(filePath, output.bytes);
          savedPaths.push(filePath);
        }
        setAutoSavedPath(savedPaths.join(" | "));
        return;
      } catch {
        // fall back to browser download
      }
    }

    for (const output of exportOutputs) {
      const blob = new Blob([output.bytes], { type: output.mimeType });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = output.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    }
  }, [autoTemplateExportFormat, isTauriRuntime, outputFolder, previewUrl, psdBytes, psdFileName]);

  const handleOpenOutputFolder = useCallback(async () => {
    if (!isTauriRuntime || !outputFolder) return;
    await openFolderPath(outputFolder);
  }, [isTauriRuntime, outputFolder]);

  const collectTemplateDiagnostics = useCallback(
    (includeModelPath = false) => {
      const mapTargets =
        templateMap?.targets && typeof templateMap.targets === "object" ? templateMap.targets : {};
      const targetKeys = Object.keys(mapTargets);
      const selectedIslandCount = countSelectedMarkers(
        buildMarkerSelectionDraft(detectedIslands, detectedIslandVisibility),
      );
      const markerSamples = detectedIslands.slice(0, 40).map((marker, index) => {
        const markerKey = marker?.key || `marker-${index}`;
        const explicitVisible = detectedIslandVisibility[markerKey];
        const explicitColor = detectedIslandColors[markerKey];
        return {
          key: markerKey,
          label: marker?.label || "",
          defaultVisible: marker?.defaultVisible !== false,
          forcedVisibility: explicitVisible === true ? true : null,
          color: typeof explicitColor === "string" ? normalizeColorInputValue(explicitColor) : null,
        };
      });
      const meshSamples = Array.isArray(templatePsdSource?.meshes)
        ? templatePsdSource.meshes.slice(0, 30).map((mesh, index) => ({
            index,
            meshName: mesh?.meshName || "",
            materialName: mesh?.materialName || "",
            shellIndex: Number.isFinite(mesh?.shellIndex) ? mesh.shellIndex : null,
            triangleCount: Number.isFinite(mesh?.triangleCount) ? mesh.triangleCount : null,
            uvArea: Number.isFinite(mesh?.uvArea) ? Number(mesh.uvArea.toFixed(8)) : null,
            isMainLiveryCandidate: Boolean(mesh?.isMainLiveryCandidate),
          }))
        : [];

      return {
        runtime: {
          shell: isTauriRuntime ? "tauri" : "browser",
          userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
          language: typeof navigator !== "undefined" ? navigator.language : "",
        },
        model: {
          fileName: getFileLabel(modelPath, ""),
          fullPath: includeModelPath ? modelPath || "" : "",
        },
        template: {
          exportSize,
          autoTemplateColor,
          autoTemplateExportFormat,
          includeTemplateWireframe,
          useWorldSpaceNormalsAsBase,
          exteriorOnly,
          layerCount,
          targetCount,
          detectedIslandCount: detectedIslands.length,
          selectedIslandCount,
          hiddenIslandCount: Math.max(0, detectedIslands.length - selectedIslandCount),
          markerSelectionConfirmed,
          markerSamples,
          hasTemplateMap: Boolean(templateMap),
          templateMapStats: templateMap?.stats || null,
          templateMapInference: templateMap?.inference || null,
          templateMapTargetsSample: targetKeys.slice(0, 30),
          templateMapTargetCount: targetKeys.length,
          hasTemplatePsdSource: Boolean(templatePsdSource),
          psdSourceSummary: templatePsdSource
            ? {
                bounds: templatePsdSource.bounds || null,
                meshCount: templatePsdSource.meshCount || 0,
                triangleCount: templatePsdSource.triangleCount || 0,
                proxyMeshCount: templatePsdSource.proxyMeshCount || 0,
                meshSamples,
              }
            : null,
          previewReady: Boolean(previewUrl),
          generatedAt: lastGeneratedAt ? lastGeneratedAt.toISOString() : null,
          generationError: generationError || null,
          templateMapError: templateMapError || null,
          templatePsdSourceError: templatePsdSourceError || null,
        },
      };
    },
    [
      autoTemplateColor,
      autoTemplateExportFormat,
      detectedIslandColors,
      detectedIslandVisibility,
      detectedIslands,
      exportSize,
      exteriorOnly,
      generationError,
      includeTemplateWireframe,
      isTauriRuntime,
      lastGeneratedAt,
      layerCount,
      markerSelectionConfirmed,
      modelPath,
      previewUrl,
      targetCount,
      templateMap,
      templateMapError,
      templatePsdSource,
      templatePsdSourceError,
      useWorldSpaceNormalsAsBase,
    ],
  );

  const buildTelemetryPayload = useCallback(() => {
    const summary = telemetryDraft.summary.trim();
    const details = telemetryDraft.details.trim();
    const expectedBehavior = telemetryDraft.expectedBehavior.trim();
    return {
      schemaVersion: 1,
      eventType: TELEMETRY_EVENT_TYPE,
      reportId: createTelemetryReportId(),
      createdAt: new Date().toISOString(),
      issue: {
        summary,
        details,
        expectedBehavior: expectedBehavior || null,
        severity: telemetryDraft.severity,
      },
      diagnostics: telemetryDraft.includeDiagnostics
        ? collectTemplateDiagnostics(telemetryDraft.includeModelPath)
        : null,
    };
  }, [collectTemplateDiagnostics, telemetryDraft]);

  const updateTelemetryField = useCallback((field, value) => {
    setTelemetryDraft((prev) => ({ ...prev, [field]: value }));
  }, []);

  const handleCopyTelemetryPayload = useCallback(async () => {
    const summary = telemetryDraft.summary.trim();
    const details = telemetryDraft.details.trim();
    if (!summary || !details) {
      setTelemetryNotice("error", "Add a summary and details before exporting telemetry.", 4800);
      return;
    }
    const payload = buildTelemetryPayload();
    const payloadJson = JSON.stringify(payload, null, 2);
    const copied = await writeTextToClipboard(payloadJson);
    if (copied) {
      setTelemetryNotice("success", "Telemetry payload copied to clipboard.", 4200);
      return;
    }
    const fallbackName = `template-telemetry-${payload.reportId}.json`;
    triggerTextDownload(fallbackName, payloadJson);
    setTelemetryNotice("success", `Clipboard unavailable. Downloaded ${fallbackName}.`, 5000);
  }, [buildTelemetryPayload, setTelemetryNotice, telemetryDraft.details, telemetryDraft.summary]);

  const handleSubmitTelemetry = useCallback(async () => {
    const summary = telemetryDraft.summary.trim();
    const details = telemetryDraft.details.trim();
    if (!summary || !details) {
      setTelemetryNotice("error", "Summary and details are required to send telemetry.", 5000);
      return;
    }

    const payload = buildTelemetryPayload();
    const payloadJson = JSON.stringify(payload, null, 2);
    const endpoint = telemetryDraft.endpoint.trim();

    setTelemetrySending(true);
    setTelemetryStatus({ tone: "", message: "" });
    try {
      if (endpoint) {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Cortex-Telemetry": "template-v1",
          },
          body: payloadJson,
        });
        if (!response.ok) {
          let body = "";
          try {
            body = (await response.text()).trim();
          } catch {
            body = "";
          }
          const suffix = body ? ` ${body.slice(0, 160)}` : "";
          throw new Error(`Endpoint returned HTTP ${response.status}.${suffix}`);
        }
        persistTemplateTelemetryEndpoint(endpoint);
        setTelemetryDraft((prev) => ({
          ...prev,
          summary: "",
          details: "",
          expectedBehavior: "",
          endpoint,
        }));
        setTelemetryNotice("success", "Telemetry sent successfully. Thanks for reporting this.", 6400);
      } else {
        const copied = await writeTextToClipboard(payloadJson);
        if (copied) {
          setTelemetryNotice(
            "success",
            "No endpoint configured. Telemetry JSON copied so you can share it manually.",
            6400,
          );
        } else {
          const fallbackName = `template-telemetry-${payload.reportId}.json`;
          triggerTextDownload(fallbackName, payloadJson);
          setTelemetryNotice(
            "success",
            `No endpoint configured. Downloaded ${fallbackName} for manual sharing.`,
            6400,
          );
        }
      }
    } catch (error) {
      setTelemetryStatus({
        tone: "error",
        message: toErrorMessage(error, "Failed to send telemetry."),
      });
    } finally {
      setTelemetrySending(false);
    }
  }, [buildTelemetryPayload, setTelemetryNotice, telemetryDraft.details, telemetryDraft.endpoint, telemetryDraft.summary]);

  const telemetryCanSubmit = Boolean(
    telemetryDraft.summary.trim() && telemetryDraft.details.trim() && !telemetrySending,
  );
  const modelFileName = getFileLabel(modelPath, "");
  const canRegenerate = Boolean(modelPath && templateMap && templatePsdSource && !generating);
  const saveButtonLabel = getTemplateSaveButtonLabel(autoTemplateExportFormat);
  const worldSpaceNormalsBaseEnabled = useWorldSpaceNormalsAsBase;
  const hasDetectedIslands = detectedIslands.length > 0;
  const confirmedSelectedCount = countSelectedMarkers(
    buildMarkerSelectionDraft(detectedIslands, detectedIslandVisibility),
  );
  const pendingSelectedCount = countSelectedMarkers(pendingMarkerSelection);
  const markerSelectionCountLabel = isMarkerEditMode
    ? `${pendingSelectedCount} / ${detectedIslands.length || 0} queued`
    : `${confirmedSelectedCount} / ${detectedIslands.length || 0} selected`;
  const markerPickModifierLabel =
    templateMarkerPickModifier === "ctrl"
      ? "Ctrl"
      : templateMarkerPickModifier === "shift"
        ? "Shift"
        : "Alt";
  const markerPickHint = `Hold ${markerPickModifierLabel} + click to select chunks`;
  const markerSelectionHint = isMarkerEditMode
    ? "Selections stay staged until you confirm."
    : "Re-enter edit mode to change which chunks regenerate into the template.";
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

  const markerPromptEl = hasDetectedIslands ? (
    <div className={`tg-marker-prompt${compactHeight ? " tg-marker-prompt--compact" : ""}`} aria-live="polite">
      <div className="tg-marker-prompt-row">
        <div className="tg-marker-prompt-copy">
          <span className="tg-marker-prompt-eyebrow">
            {isMarkerEditMode ? "Marker Edit Mode" : "Marker Selection"}
          </span>
          <strong className="tg-marker-prompt-count">{markerSelectionCountLabel}</strong>
          <span className="tg-marker-prompt-text">{markerSelectionHint}</span>
        </div>
        <div className="tg-marker-prompt-actions">
          {isMarkerEditMode ? (
            <>
              <button
                type="button"
                className="tg-marker-prompt-btn is-primary"
                onClick={handleConfirmMarkerSelection}
              >
                Confirm
              </button>
              <button
                type="button"
                className="tg-marker-prompt-btn"
                onClick={handleClearPendingMarkerSelection}
                disabled={!pendingSelectedCount}
              >
                Clear
              </button>
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
          Click chunks to toggle them. Confirm to apply.
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
              <h2 className="tg-empty-title">Template Generator</h2>
              <p className="tg-empty-desc">
                Load a vehicle model to automatically generate a layered<br />
                PSD template from its UV shell geometry.
              </p>
              <motion.button
                type="button"
                className="tg-empty-btn"
                onClick={handleSelectModel}
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.96 }}
              >
                <Car className="w-4 h-4" />
                Load .yft Model
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
            {/* ── Vertical Control Sidebar ── */}
            <motion.div
              className={`tg-sidebar${generationError ? " has-error" : ""}${generating ? " is-generating" : ""}`}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1], delay: 0.08 }}
            >
              {/* Model */}
              <div className="tg-sb-section">
                <button
                  type="button"
                  className="tg-sb-btn tg-sb-icon-btn"
                  onClick={handleSelectModel}
                  title={modelPath}
                >
                  <Car className="tg-sb-icon" />
                </button>
                <span className="tg-sb-label tg-sb-model-label" title={modelPath}>
                  {modelFileName}
                </span>
                <button
                  type="button"
                  className="tg-sb-btn tg-sb-icon-btn tg-sb-unload"
                  onClick={handleUnloadModel}
                  title="Unload model"
                >
                  <X className="tg-sb-icon" />
                </button>
              </div>

              <div className="tg-sb-rule" />

              {/* PSD Size */}
              <div className="tg-sb-section tg-sb-sizes">
                {SIZE_OPTIONS.map((size) => (
                  <button
                    key={size}
                    type="button"
                    className={`tg-sb-btn tg-sb-size${exportSize === size ? " is-active" : ""}`}
                    onClick={() => setExportSize(size)}
                    title={`Export at ${size}×${size}px`}
                  >
                    {size >= 1024 ? `${size / 1024}K` : size}
                  </button>
                ))}
              </div>

              <div className="tg-sb-rule" />

              {/* Exterior toggle */}
              <div className="tg-sb-section tg-sb-marker">
                <button
                  type="button"
                  className={`tg-sb-btn tg-sb-icon-btn tg-sb-ext-btn${exteriorOnly ? " is-active" : ""}`}
                  onClick={() => setExteriorOnly((v) => !v)}
                  aria-pressed={exteriorOnly}
                  title="Show only exterior bodyshell geometry"
                >
                  <Layers className="tg-sb-icon" />
                </button>
                <span className={`tg-sb-label tg-sb-ext-label${exteriorOnly ? " is-active" : ""}`}>
                  Exterior
                </span>
              </div>

              {/* Wireframe toggle */}
              <div className="tg-sb-section tg-sb-marker">
                <button
                  type="button"
                  className={`tg-sb-btn tg-sb-icon-btn tg-sb-ext-btn${includeTemplateWireframe ? " is-active" : ""}`}
                  onClick={() => setIncludeTemplateWireframe((prev) => !prev)}
                  aria-pressed={includeTemplateWireframe}
                  title="Toggle generated template wireframe layer"
                >
                  <Box className="tg-sb-icon" />
                </button>
                <span className={`tg-sb-label tg-sb-ext-label${includeTemplateWireframe ? " is-active" : ""}`}>
                  Wireframe
                </span>
              </div>

              {/* World-space normal base toggle */}
              <div className="tg-sb-section tg-sb-marker">
                <button
                  type="button"
                  className={`tg-sb-btn tg-sb-icon-btn tg-sb-ext-btn${worldSpaceNormalsBaseEnabled ? " is-active" : ""}`}
                  onClick={() => setUseWorldSpaceNormalsAsBase((prev) => !prev)}
                  aria-pressed={worldSpaceNormalsBaseEnabled}
                  title="Use generated world-space normal map as base color with wireframe on top"
                >
                  <Sparkles className="tg-sb-icon" />
                </button>
                <span className={`tg-sb-label tg-sb-ext-label${worldSpaceNormalsBaseEnabled ? " is-active" : ""}`}>
                  WS Base
                </span>
              </div>

              {hasDetectedIslands && (
                <>
                  <div className="tg-sb-rule" />
                  <div className="tg-sb-section tg-sb-marker">
                    <label className="tg-sb-btn tg-sb-icon-btn tg-sb-color-all" title="Change marker color for all chunks">
                      <span
                        className="tg-sb-color-all-swatch"
                        style={{ background: globalMarkerColor }}
                      />
                      <input
                        type="color"
                        className="tg-sb-marker-color-input"
                        value={globalMarkerColor}
                        onChange={(e) => handleIslandColorChange(e.target.value)}
                      />
                    </label>
                    <span className="tg-sb-label tg-sb-ext-label">Color</span>
                  </div>
                </>
              )}

              <div className="tg-sb-rule" />

              {/* Regenerate */}
              <div className="tg-sb-section">
                <motion.button
                  type="button"
                  className="tg-sb-btn tg-sb-icon-btn"
                  onClick={handleRegenerateTemplate}
                  disabled={!canRegenerate}
                  title="Regenerate template"
                  whileTap={{ scale: 0.88 }}
                >
                  <RefreshCw className="tg-sb-icon" />
                </motion.button>
                <span className={`tg-sb-label${canRegenerate ? "" : " is-disabled"}`}>
                  Regenerate
                </span>
              </div>

              {/* Spacer */}
              <div className="tg-sb-spacer" />

              {/* Output folder */}
              <div className="tg-sb-rule" />
              <div className="tg-sb-section">
                <button
                  type="button"
                  className="tg-sb-btn tg-sb-icon-btn"
                  onClick={handleSelectOutputFolder}
                  title={outputFolder || "Set output folder"}
                >
                  <FolderOpen className="tg-sb-icon" />
                </button>
                {outputFolder && (
                  <button
                    type="button"
                    className="tg-sb-btn tg-sb-icon-btn tg-sb-open-dir"
                    onClick={handleOpenOutputFolder}
                    title={`Open ${outputFolder}`}
                  >
                    <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <path d="M3 7L7 3M7 3H4M7 3V6" />
                    </svg>
                  </button>
                )}
              </div>

              <div className="tg-sb-rule" />

              {/* Save */}
              <div className="tg-sb-section">
                <motion.button
                  type="button"
                  className={`tg-sb-btn tg-sb-icon-btn tg-sb-save${autoSavedPath ? " is-saved" : ""}`}
                  onClick={handleSaveTemplate}
                  disabled={!psdBytes || generating}
                  title={saveButtonLabel}
                  whileTap={{ scale: 0.88 }}
                >
                  {autoSavedPath ? (
                    <Check className="tg-sb-icon" />
                  ) : (
                    <Download className="tg-sb-icon" />
                  )}
                </motion.button>
                <span className={`tg-sb-label tg-sb-save-label${!psdBytes || generating ? " is-disabled" : ""}${autoSavedPath ? " is-saved" : ""}`}>
                  {autoSavedPath ? "Saved" : saveButtonLabel}
                </span>
              </div>

              <div className="tg-sb-rule" />

              {/* Telemetry report */}
              <div className="tg-sb-section">
                <motion.button
                  type="button"
                  className="tg-sb-btn tg-sb-icon-btn tg-sb-report"
                  onClick={() => openTelemetryDialog(generationError)}
                  title="Report template issue telemetry"
                  whileTap={{ scale: 0.88 }}
                >
                  <Bug className="tg-sb-icon" />
                </motion.button>
                <span className="tg-sb-label tg-sb-report-label">
                  Report
                </span>
              </div>
            </motion.div>

            {/* ── Model Viewer ── */}
            <motion.div
              className="tg-pane tg-pane--model"
              initial={{ opacity: 0, scale: 0.985 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            >
              <Viewer
                modelPath={modelPath}
                texturePath={previewUrl || ""}
                textureReloadToken={lastGeneratedAt?.getTime() || 0}
                textureTarget="material:vehicle_paint3"
                textureMode="livery"
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
                liveryExteriorOnly={exteriorOnly}
                wasdEnabled={false}
                isActive={isActive}
                includeTemplateGeometry
                templateMarkerPickModifier={templateMarkerPickModifier}
                onTemplateMarkerUvHover={isMarkerEditMode ? handleModelMarkerHover : undefined}
                onTemplateMarkerUvLeave={isMarkerEditMode ? clearHoveredMarker : undefined}
                onTemplateMarkerUvPick={isMarkerEditMode ? handleModelMarkerPick : undefined}
                onModelInfo={handleModelInfo}
                onReady={NOOP}
                onTextureReload={NOOP}
                onTextureError={NOOP}
                onWindowTextureError={NOOP}
                onModelError={NOOP}
                onModelLoading={NOOP}
                onFormatWarning={NOOP}
              />
              {compactHeight && markerPromptEl}
            </motion.div>

            {/* ── Template Preview ── */}
            <motion.div
              className="tg-pane tg-pane--template"
              initial={{ opacity: 0, scale: 0.985 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1], delay: 0.06 }}
            >
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
                      <button
                        type="button"
                        className="tg-preview-report-btn"
                        onClick={() => openTelemetryDialog(generationError)}
                      >
                        Report with telemetry
                      </button>
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
                      />
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
          {isTelemetryDialogOpen && (
            <motion.div
              className="tg-telemetry-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16 }}
              onClick={closeTelemetryDialog}
            >
              <motion.div
                className="tg-telemetry-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="tg-telemetry-title"
                initial={{ opacity: 0, y: 16, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.985 }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                onClick={(event) => event.stopPropagation()}
              >
                <div className="tg-telemetry-head">
                  <div>
                    <h3 id="tg-telemetry-title" className="tg-telemetry-title">
                      Template Telemetry Report
                    </h3>
                    <p className="tg-telemetry-subtitle">
                      Share what broke so template diagnostics can be reproduced.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="tg-telemetry-close"
                    onClick={closeTelemetryDialog}
                    disabled={telemetrySending}
                    aria-label="Close telemetry dialog"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="tg-telemetry-fields">
                  <label className="tg-telemetry-field">
                    <span className="tg-telemetry-label">Issue summary</span>
                    <input
                      className="tg-telemetry-input"
                      value={telemetryDraft.summary}
                      onChange={(event) => updateTelemetryField("summary", event.currentTarget.value)}
                      placeholder="Example: template islands overlap and marker colors mismatch"
                      maxLength={240}
                    />
                  </label>

                  <label className="tg-telemetry-field">
                    <span className="tg-telemetry-label">What happened</span>
                    <textarea
                      className="tg-telemetry-textarea"
                      value={telemetryDraft.details}
                      onChange={(event) => updateTelemetryField("details", event.currentTarget.value)}
                      placeholder="Steps, output, what looked broken, and any related model details"
                      rows={4}
                    />
                  </label>

                  <label className="tg-telemetry-field">
                    <span className="tg-telemetry-label">What you expected (optional)</span>
                    <textarea
                      className="tg-telemetry-textarea"
                      value={telemetryDraft.expectedBehavior}
                      onChange={(event) =>
                        updateTelemetryField("expectedBehavior", event.currentTarget.value)
                      }
                      placeholder="Describe expected result"
                      rows={2}
                    />
                  </label>

                  <div className="tg-telemetry-row">
                    <label className="tg-telemetry-field tg-telemetry-field--half">
                      <span className="tg-telemetry-label">Severity</span>
                      <select
                        className="tg-telemetry-input"
                        value={telemetryDraft.severity}
                        onChange={(event) => updateTelemetryField("severity", event.currentTarget.value)}
                      >
                        <option value="critical">Critical</option>
                        <option value="high">High</option>
                        <option value="medium">Medium</option>
                        <option value="low">Low</option>
                      </select>
                    </label>

                    <label className="tg-telemetry-field tg-telemetry-field--grow">
                      <span className="tg-telemetry-label">Endpoint (optional)</span>
                      <input
                        className="tg-telemetry-input"
                        value={telemetryDraft.endpoint}
                        onChange={(event) => updateTelemetryField("endpoint", event.currentTarget.value)}
                        placeholder="https://api.example.com/template-telemetry"
                        autoComplete="off"
                      />
                    </label>
                  </div>

                  <label className="tg-telemetry-check">
                    <input
                      type="checkbox"
                      checked={telemetryDraft.includeDiagnostics}
                      onChange={(event) =>
                        updateTelemetryField("includeDiagnostics", event.currentTarget.checked)
                      }
                    />
                    <span>Include template diagnostics (settings, map stats, mesh samples, errors)</span>
                  </label>

                  <label
                    className={`tg-telemetry-check${telemetryDraft.includeDiagnostics ? "" : " is-disabled"}`}
                  >
                    <input
                      type="checkbox"
                      checked={telemetryDraft.includeModelPath}
                      disabled={!telemetryDraft.includeDiagnostics}
                      onChange={(event) =>
                        updateTelemetryField("includeModelPath", event.currentTarget.checked)
                      }
                    />
                    <span>Include full model path (off by default for privacy)</span>
                  </label>

                  {telemetryStatus.message && (
                    <div
                      className={`tg-telemetry-status${telemetryStatus.tone === "error" ? " is-error" : " is-success"}`}
                    >
                      {telemetryStatus.message}
                    </div>
                  )}
                </div>

                <div className="tg-telemetry-actions">
                  <button
                    type="button"
                    className="tg-telemetry-btn"
                    onClick={handleCopyTelemetryPayload}
                    disabled={telemetrySending}
                  >
                    <Copy className="w-3.5 h-3.5" />
                    Copy JSON
                  </button>
                  <button
                    type="button"
                    className="tg-telemetry-btn"
                    onClick={closeTelemetryDialog}
                    disabled={telemetrySending}
                  >
                    Close
                  </button>
                  <button
                    type="button"
                    className="tg-telemetry-btn is-primary"
                    onClick={handleSubmitTelemetry}
                    disabled={!telemetryCanSubmit}
                  >
                    <Send className="w-3.5 h-3.5" />
                    {telemetrySending ? "Sending..." : "Send Telemetry"}
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
  );
}
