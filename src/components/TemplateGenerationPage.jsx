import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { open } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import {
  AlertTriangle,
  Box,
  Car,
  Check,
  Download,
  FolderOpen,
  Layers,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import Viewer from "./Viewer";
import { buildAutoTemplatePsd } from "../lib/template-psd";
import { loadPrefs } from "../lib/prefs";
import { openFolderPath } from "../lib/open-folder";

const SIZE_OPTIONS = [4096, 2048, 1024, 512];
const NOOP = () => {};
const DEFAULT_AUTO_TEMPLATE_COLOR = "#c9d8ee";
const DEFAULT_AUTO_TEMPLATE_BACKGROUND_COLOR = "#000000";
const DEFAULT_AUTO_TEMPLATE_EXPORT_FORMAT = "psd";
const DEFAULT_ENV_BODY_COLOR = "#e7ebf0";
const DEFAULT_ENV_BACKGROUND_COLOR = "#141414";

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

function normalizeAutoTemplateBackgroundColor(value) {
  if (typeof value !== "string") return DEFAULT_AUTO_TEMPLATE_BACKGROUND_COLOR;
  const trimmed = value.trim();
  if (/^#(?:[0-9a-fA-F]{3}){1,2}$/.test(trimmed)) return trimmed;
  return DEFAULT_AUTO_TEMPLATE_BACKGROUND_COLOR;
}

function normalizeEnvironmentColor(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function getDefaultEnvironmentColors() {
  const prefs = loadPrefs() || {};
  const defaults = prefs?.defaults || {};
  return {
    bodyColor: normalizeEnvironmentColor(defaults.bodyColor, DEFAULT_ENV_BODY_COLOR),
    backgroundColor: normalizeEnvironmentColor(defaults.backgroundColor, DEFAULT_ENV_BACKGROUND_COLOR),
  };
}

function getDefaultAutoTemplateColor() {
  const prefs = loadPrefs() || {};
  return normalizeAutoTemplateColor(prefs?.defaults?.autoTemplateColor);
}

function getDefaultAutoTemplateBackgroundColor() {
  const prefs = loadPrefs() || {};
  return normalizeAutoTemplateBackgroundColor(prefs?.defaults?.autoTemplateBackgroundColor);
}

function getDefaultAutoTemplateExportFormat() {
  const prefs = loadPrefs() || {};
  return normalizeAutoTemplateExportFormat(prefs?.defaults?.autoTemplateExportFormat);
}

function getFileLabel(path, fallback = "") {
  if (!path) return fallback;
  const parts = path.toString().split(/[\\/]/);
  return parts[parts.length - 1] || fallback;
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
  const [autoTemplateBackgroundColor, setAutoTemplateBackgroundColor] = useState(() =>
    getDefaultAutoTemplateBackgroundColor(),
  );
  const [autoTemplateExportFormat, setAutoTemplateExportFormat] = useState(
    () => getDefaultAutoTemplateExportFormat(),
  );
  const [environmentColors, setEnvironmentColors] = useState(() => getDefaultEnvironmentColors());
  const [useWorldSpaceNormalsAsBase, setUseWorldSpaceNormalsAsBase] = useState(() =>
    Boolean(
      workspaceState?.useWorldSpaceNormalsAsBase ||
      workspaceState?.generateWorldSpaceNormals,
    ),
  );
  const [exportSize, setExportSize] = useState(workspaceState?.exportSize || 2048);
  const [exteriorOnly, setExteriorOnly] = useState(Boolean(workspaceState?.exteriorOnly));
  const [includeTemplateWireframe, setIncludeTemplateWireframe] = useState(() =>
    Boolean(
      workspaceState?.includeTemplateWireframe ??
      workspaceState?.showWireframe,
    ),
  );

  const [templateMap, setTemplateMap] = useState(null);
  const [templateMapError, setTemplateMapError] = useState("");
  const [templatePsdSource, setTemplatePsdSource] = useState(null);
  const [templatePsdSourceError, setTemplatePsdSourceError] = useState("");
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
  const [isPreviewRefreshing, setIsPreviewRefreshing] = useState(false);
  const persistTimerRef = useRef(null);
  const regenerateTimerRef = useRef(null);

  useEffect(() => {
    if (!settingsVersion) return;
    setOutputFolder((prev) => prev || getDefaultOutputFolder());
    setAutoTemplateColor(getDefaultAutoTemplateColor());
    setAutoTemplateBackgroundColor(getDefaultAutoTemplateBackgroundColor());
    setAutoTemplateExportFormat(getDefaultAutoTemplateExportFormat());
    setEnvironmentColors(getDefaultEnvironmentColors());
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
    onStateChange,
  ]);

  useEffect(() => {
    return () => {
      if (regenerateTimerRef.current) clearTimeout(regenerateTimerRef.current);
    };
  }, []);

  const clearGeneratedState = useCallback(() => {
    setTemplateMap(null);
    setTemplateMapError("");
    setTemplatePsdSource(null);
    setTemplatePsdSourceError("");
    setPreviewUrl("");
    setPsdBytes(null);
    setPsdFileName("auto_template.psd");
    setLayerCount(0);
    setTargetCount(0);
    setGenerating(false);
    setGenerationError("");
    setAutoSavedPath("");
    setLastGeneratedAt(null);
    setIsPreviewRefreshing(false);
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

  const handleRegenerateTemplate = useCallback(() => {
    if (!modelPath || !templateMap || !templatePsdSource || generating) return;
    setIsPreviewRefreshing(true);
    setGenerating(true);
    setPreviewUrl("");
    setPsdBytes(null);
    setLayerCount(0);
    setTargetCount(0);
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
      setAutoSavedPath("");
      setGenerating(false);
      setIsPreviewRefreshing(false);
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
          backgroundColor: autoTemplateBackgroundColor,
          preferredTarget: "material:vehicle_paint3",
          includeWireframe: includeTemplateWireframe,
          includeWorldSpaceNormals: useWorldSpaceNormalsAsBase,
          useWorldSpaceNormalsAsBase,
        };

        const buildJob = createTemplateBuildJob(templateMap, buildOptions);
        cancelBuildJob = buildJob.cancel;
        let result;
        try {
          result = await buildJob.promise;
        } catch {
          if (cancelled) return;
          result = buildAutoTemplatePsd(templateMap, buildOptions);
        }

        if (cancelled) return;
        setPreviewUrl(result.previewDataUrl);
        setPsdBytes(result.bytes);
        setPsdFileName(result.fileName);
        setLayerCount(result.layerCount);
        setTargetCount(result.targetCount);
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
        setAutoSavedPath("");
      } finally {
        if (!cancelled) {
          setGenerating(false);
          setIsPreviewRefreshing(false);
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
    autoTemplateBackgroundColor,
    autoTemplateExportFormat,
    includeTemplateWireframe,
    useWorldSpaceNormalsAsBase,
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

  const modelFileName = getFileLabel(modelPath, "");
  const canRegenerate = Boolean(modelPath && templateMap && templatePsdSource && !generating);
  const saveButtonLabel = getTemplateSaveButtonLabel(autoTemplateExportFormat);
  const worldSpaceNormalsBaseEnabled = useWorldSpaceNormalsAsBase;

  return (
    <div
      className="tg-root"
      style={{ "--tg-background-color": environmentColors.backgroundColor }}
    >
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
              <div className="tg-sb-section">
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
              <div className="tg-sb-section">
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
              <div className="tg-sb-section">
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
                bodyColor={environmentColors.bodyColor}
                backgroundColor={environmentColors.backgroundColor}
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
                onModelInfo={handleModelInfo}
                onReady={NOOP}
                onTextureReload={NOOP}
                onTextureError={NOOP}
                onWindowTextureError={NOOP}
                onModelError={NOOP}
                onModelLoading={NOOP}
                onFormatWarning={NOOP}
              />
            </motion.div>

            {/* ── Template Preview ── */}
            <motion.div
              className="tg-pane tg-pane--template"
              initial={{ opacity: 0, scale: 0.985 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1], delay: 0.06 }}
            >
              <div className="tg-preview-shell">
                <AnimatePresence mode="wait" initial={false}>
                  {isPreviewRefreshing ? (
                    <motion.div
                      key="refresh-unloaded"
                      className="tg-preview-unloaded"
                      initial={{ opacity: 0, scale: 0.985 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 1.01 }}
                      transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
                    />
                  ) : generationError ? (
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

                <AnimatePresence>
                  {isPreviewRefreshing && (
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
      </div>
  );
}
