import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { open } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import {
  AlertTriangle,
  Car,
  Check,
  Download,
  FileImage,
  FolderOpen,
  Layers,
  Sparkles,
  X,
} from "lucide-react";
import Viewer from "./Viewer";
import { buildAutoTemplatePsd } from "../lib/template-psd";
import { loadPrefs } from "../lib/prefs";

const SIZE_OPTIONS = [4096, 2048, 1024, 512];
const NOOP = () => {};

function getDefaultOutputFolder() {
  const prefs = loadPrefs() || {};
  return prefs?.defaults?.variantExportFolder || "";
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
  contextBarTarget,
}) {
  const isTauriRuntime =
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__ !== "undefined";

  const [modelPath, setModelPath] = useState(workspaceState?.modelPath || "");
  const [outputFolder, setOutputFolder] = useState(
    workspaceState?.outputFolder || getDefaultOutputFolder(),
  );
  const [exportSize, setExportSize] = useState(workspaceState?.exportSize || 2048);
  const [exteriorOnly, setExteriorOnly] = useState(Boolean(workspaceState?.exteriorOnly));

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
  const persistTimerRef = useRef(null);

  useEffect(() => {
    if (!settingsVersion) return;
    setOutputFolder((prev) => prev || getDefaultOutputFolder());
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
    onStateChange,
  ]);

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

  useEffect(() => {
    const upstreamError = templateMapError || templatePsdSourceError || "";

    if (!modelPath || !templateMap || !templatePsdSource) {
      setPreviewUrl("");
      setPsdBytes(null);
      setGenerationError(upstreamError);
      setLayerCount(0);
      setTargetCount(0);
      setAutoSavedPath("");
      return;
    }

    let cancelled = false;
    const generate = async () => {
      setGenerating(true);
      setGenerationError(upstreamError);

      try {
        const result = buildAutoTemplatePsd(templateMap, {
          size: exportSize,
          modelPath,
          modelFileName: getFileLabel(modelPath, "template"),
          templatePsdSource,
          preferredTarget: "material:vehicle_paint3",
        });
        if (cancelled) return;
        setPreviewUrl(result.previewDataUrl);
        setPsdBytes(result.bytes);
        setPsdFileName(result.fileName);
        setLayerCount(result.layerCount);
        setTargetCount(result.targetCount);
        setLastGeneratedAt(new Date());
        setGenerationError("");

        if (isTauriRuntime && outputFolder && result.bytes?.length) {
          const autoPath = `${outputFolder}/${result.fileName}`;
          await writeFile(autoPath, result.bytes);
          if (cancelled) return;
          setAutoSavedPath(autoPath);
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
        if (!cancelled) setGenerating(false);
      }
    };

    generate();
    return () => {
      cancelled = true;
    };
  }, [
    templateMap,
    templateMapError,
    templatePsdSource,
    templatePsdSourceError,
    exportSize,
    modelPath,
    outputFolder,
    isTauriRuntime,
  ]);

  const handleDownloadPsd = useCallback(async () => {
    if (!psdBytes || !psdBytes.length) return;

    const bytes = psdBytes instanceof Uint8Array ? psdBytes : new Uint8Array(psdBytes);

    if (isTauriRuntime && outputFolder) {
      try {
        const filePath = `${outputFolder}/${psdFileName}`;
        await writeFile(filePath, bytes);
        setAutoSavedPath(filePath);
        return;
      } catch {
        // fall back to browser download
      }
    }

    const blob = new Blob([bytes], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = psdFileName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }, [isTauriRuntime, outputFolder, psdBytes, psdFileName]);

  const handleOpenOutputFolder = useCallback(async () => {
    if (!isTauriRuntime || !outputFolder) return;
    try {
      const { openPath } = await import("@tauri-apps/plugin-opener");
      await openPath(outputFolder);
    } catch {
      // no-op
    }
  }, [isTauriRuntime, outputFolder]);

  const modelFileName = getFileLabel(modelPath, "No model loaded");
  const outputFolderName = outputFolder ? outputFolder.split(/[\\/]/).pop() : "No output folder";
  const compactStatusLabel = generationError
    ? "Needs attention"
    : generating
      ? "Generating"
      : psdBytes
        ? "Ready"
        : modelPath
          ? "Analyzing"
          : "Idle";

  const statusLabel = generationError
    ? generationError
    : generating
      ? "Generating layered PSD from UV shell geometry..."
      : psdBytes
        ? "Template PSD generated automatically."
        : modelPath
          ? "Analyzing UV shell geometry..."
          : "Load a .yft model to begin.";
  return (
    <div className="tg-root">
      {isActive && contextBarTarget &&
        createPortal(
          <div className="ctx-bar-inner tg-context-dock">
            <div className="tg-dock-row tg-dock-row--top">
              <div className="tg-dock-actions">
                <button type="button" className="tg-dock-btn tg-dock-btn--primary" onClick={handleSelectModel}>
                  <Car className="w-3 h-3" />
                  {modelPath ? "Change Model" : "Load Model"}
                </button>
                {modelPath ? (
                  <button type="button" className="tg-dock-btn" onClick={handleUnloadModel}>
                    <X className="w-3 h-3" />
                    Unload
                  </button>
                ) : null}
                <button type="button" className="tg-dock-btn" onClick={handleSelectOutputFolder}>
                  <FolderOpen className="w-3 h-3" />
                  {outputFolder ? `Output: ${outputFolderName}` : "Set Output"}
                </button>
                {outputFolder ? (
                  <button type="button" className="tg-dock-btn" onClick={handleOpenOutputFolder}>
                    Open Folder
                  </button>
                ) : null}
              </div>

              <div className="tg-dock-primary">
                <span className={`tg-dock-state ${generationError ? "is-error" : ""}`}>
                  {compactStatusLabel}
                </span>
                <button
                  type="button"
                  className="tg-dock-btn tg-dock-btn--accent"
                  onClick={handleDownloadPsd}
                  disabled={!psdBytes || generating}
                  title={psdFileName}
                >
                  <Download className="w-3 h-3" />
                  Download PSD
                </button>
              </div>
            </div>

            <div className="tg-dock-row tg-dock-row--bottom">
              <div className="tg-dock-pill" title={modelPath || "No model loaded"}>
                <Car className="w-3 h-3" />
                <span className="tg-dock-pill-label">Model</span>
                <span className="tg-dock-pill-value">{modelFileName}</span>
              </div>
              <div className="tg-dock-size">
                <span className="tg-dock-pill-label">PSD Size</span>
                {SIZE_OPTIONS.map((size) => (
                  <button
                    key={size}
                    type="button"
                    className={`tg-dock-size-btn ${exportSize === size ? "is-active" : ""}`}
                    onClick={() => setExportSize(size)}
                  >
                    {size}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className={`tg-dock-toggle ${exteriorOnly ? "is-active" : ""}`}
                onClick={() => setExteriorOnly((value) => !value)}
                aria-pressed={exteriorOnly}
                title="Show only exterior bodyshell geometry"
              >
                Exterior Only
              </button>
              <span className="tg-dock-metric">
                <FileImage className="w-3 h-3" />
                {targetCount} targets
              </span>
              <span className="tg-dock-metric">
                <Layers className="w-3 h-3" />
                {layerCount} layers
              </span>
              <div className="tg-dock-pill" title={outputFolder || "No output folder"}>
                <FolderOpen className="w-3 h-3" />
                <span className="tg-dock-pill-label">Output</span>
                <span className="tg-dock-pill-value">{outputFolderName}</span>
              </div>
            </div>
          </div>,
          contextBarTarget,
        )}

      <div className="tg-workspace">
        <motion.section
          className="tg-pane tg-pane--model"
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="tg-pane-head">
            <div className="tg-pane-title">
              <Car className="w-3.5 h-3.5" />
              <span>Loaded Model</span>
            </div>
            <span className="tg-pane-meta">{modelFileName}</span>
          </div>
          <div className="tg-pane-body">
            {modelPath ? (
              <Viewer
                modelPath={modelPath}
                texturePath={previewUrl || ""}
                textureReloadToken={lastGeneratedAt?.getTime() || 0}
                textureTarget="material:vehicle_paint3"
                textureMode="livery"
                windowTexturePath=""
                windowTextureTarget="none"
                windowTextureReloadToken={0}
                bodyColor="#e7ebf0"
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
                onModelInfo={handleModelInfo}
                onReady={NOOP}
                onTextureReload={NOOP}
                onTextureError={NOOP}
                onWindowTextureError={NOOP}
                onModelError={NOOP}
                onModelLoading={NOOP}
                onFormatWarning={NOOP}
              />
            ) : (
              <div className="tg-placeholder">
                <Car className="w-6 h-6" />
                <span>Select a `.yft` model to begin auto template generation.</span>
              </div>
            )}
          </div>
          <div className="tg-pane-foot">
            <span className="tg-stat-pill">
              <Car className="w-3 h-3" />
              {modelPath ? "Model loaded" : "No model"}
            </span>
            <span className="tg-stat-pill">
              <Sparkles className="w-3 h-3" />
              {exportSize}px PSD
            </span>
            <span className="tg-stat-pill">
              <Layers className="w-3 h-3" />
              {exteriorOnly ? "Exterior mesh only" : "All template targets"}
            </span>
          </div>
        </motion.section>

        <motion.section
          className="tg-pane tg-pane--template"
          initial={{ opacity: 0, x: 8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1], delay: 0.04 }}
        >
          <div className="tg-pane-head">
            <div className="tg-pane-title">
              <FileImage className="w-3.5 h-3.5" />
              <span>Auto Template (.PSD)</span>
            </div>
            <span className="tg-pane-meta">{psdBytes ? psdFileName : "No PSD generated"}</span>
          </div>

          <div className="tg-template-preview">
            {generationError ? (
              <div className="tg-placeholder tg-placeholder--error">
                <AlertTriangle className="w-5 h-5" />
                <span>{generationError}</span>
              </div>
            ) : generating ? (
              <div className="tg-placeholder">
                <motion.div
                  className="tg-spinner"
                  animate={{ rotate: 360 }}
                  transition={{ duration: 0.8, ease: "linear", repeat: Infinity }}
                />
                <span>Generating layered PSD...</span>
              </div>
            ) : previewUrl ? (
              <img src={previewUrl} alt="Generated PSD preview" className="tg-preview-image" />
            ) : (
              <div className="tg-placeholder">
                <Sparkles className="w-5 h-5" />
                <span>Template preview will appear here automatically.</span>
              </div>
            )}
          </div>

          <div className="tg-template-footer">
            <div className="tg-template-footer-row">
              <div className="tg-template-stats">
                <span className="tg-stat-pill">
                  <Layers className="w-3 h-3" />
                  {layerCount} layers
                </span>
                <span className="tg-stat-pill">
                  <FileImage className="w-3 h-3" />
                  {targetCount} targets
                </span>
                {lastGeneratedAt ? (
                  <span className="tg-stat-pill">
                    <Check className="w-3 h-3" />
                    {lastGeneratedAt.toLocaleTimeString()}
                  </span>
                ) : null}
              </div>
              <span className={`tg-template-status ${generationError ? "is-error" : ""}`}>
                {statusLabel}
              </span>
            </div>
            <div className="tg-template-footer-row tg-template-footer-row--meta">
              <span className="tg-autosave-note" title={outputFolder || "No output folder selected"}>
                {outputFolder ? `Output: ${outputFolder}` : "Output folder not selected"}
              </span>
              {autoSavedPath ? (
                <span className="tg-autosave-note" title={autoSavedPath}>
                  Auto-saved: {autoSavedPath}
                </span>
              ) : null}
            </div>
          </div>

        </motion.section>
      </div>
    </div>
  );
}
