import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readFile } from "@tauri-apps/plugin-fs";
import { Car, ChevronLeft, ChevronRight, FolderOpen, Layers, Minus, RotateCcw, Shirt, Square, X } from "lucide-react";
import { parseYtd, categorizeTextures } from "./lib/ytd";
import AppLoader, { LoadingGlyph } from "./components/AppLoader";
import Onboarding from "./components/Onboarding";
import SettingsMenu from "./components/SettingsMenu";
import Viewer from "./components/Viewer";
import { loadOnboarded, loadPrefs, savePrefs, setOnboarded } from "./lib/prefs";
import {
  DEFAULT_HOTKEYS,
  HOTKEY_ACTIONS,
  findMatchingAction,
  mergeHotkeys,
} from "./lib/hotkeys";
import { Button } from "./components/ui/button";
import { Label } from "./components/ui/label";
import { Input } from "./components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";

const DEFAULT_BODY = "#e7ebf0";
const DEFAULT_BG = "#141414";
const MIN_LOADER_MS = 650;

const BUILT_IN_DEFAULTS = {
  textureMode: "everything",
  liveryExteriorOnly: false,
  windowTemplateEnabled: false,
  windowTextureTarget: "auto",
  cameraWASD: false,
  bodyColor: DEFAULT_BODY,
  backgroundColor: DEFAULT_BG,
  experimentalSettings: false,
};

const BUILT_IN_UI = {
  colorsOpen: true,
};

function getInitialDefaults() {
  const prefs = loadPrefs();
  const stored = prefs?.defaults && typeof prefs.defaults === "object" ? prefs.defaults : {};
  return { ...BUILT_IN_DEFAULTS, ...stored };
}

function getInitialUi() {
  const prefs = loadPrefs();
  const stored = prefs?.ui && typeof prefs.ui === "object" ? prefs.ui : {};
  return { ...BUILT_IN_UI, ...stored };
}

function getInitialHotkeys() {
  const prefs = loadPrefs();
  const stored = prefs?.hotkeys && typeof prefs.hotkeys === "object" ? prefs.hotkeys : {};
  return mergeHotkeys(stored, DEFAULT_HOTKEYS);
}

function getFileLabel(path, emptyLabel) {
  if (!path) return emptyLabel;
  return path.split(/[\\/]/).pop();
}

function PanelSection({ title, caption, open, onToggle, contentId, children }) {
  return (
    <div className={`panel-section ${open ? "is-open" : ""}`}>
      <button
        type="button"
        className="panel-section-toggle"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={contentId}
      >
        <span className="panel-section-text">
          <span className="panel-section-title">{title}</span>
          {caption ? <span className="panel-section-caption">{caption}</span> : null}
        </span>
        <span className="panel-section-chevron" aria-hidden="true">
          <ChevronRight className="panel-section-chevron-svg" aria-hidden="true" />
        </span>
      </button>
      <div
        id={contentId}
        className="panel-section-body"
        hidden={!open}
        aria-hidden={!open}
      >
        {children}
      </div>
    </div>
  );
}

function App() {
  const viewerApiRef = useRef(null);
  const reloadTimerRef = useRef({ primary: null, window: null });
  const isTauriRuntime =
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__ !== "undefined" &&
    typeof window.__TAURI_INTERNALS__?.invoke === "function";

  const [defaults, setDefaults] = useState(() => getInitialDefaults());
  const [hotkeys, setHotkeys] = useState(() => getInitialHotkeys());
  const [showOnboarding, setShowOnboarding] = useState(() => !loadOnboarded());
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [toolbarCollapsed, setToolbarCollapsed] = useState(false);

  const [modelPath, setModelPath] = useState("");
  const [modelSourcePath, setModelSourcePath] = useState("");
  const [texturePath, setTexturePath] = useState("");
  const [windowTemplateEnabled, setWindowTemplateEnabled] = useState(() => Boolean(getInitialDefaults().windowTemplateEnabled));
  const [windowTexturePath, setWindowTexturePath] = useState("");
  const [bodyColor, setBodyColor] = useState(() => getInitialDefaults().bodyColor);
  const [backgroundColor, setBackgroundColor] = useState(() => getInitialDefaults().backgroundColor);
  const [experimentalSettings, setExperimentalSettings] = useState(() => Boolean(getInitialDefaults().experimentalSettings));
  const [colorsOpen, setColorsOpen] = useState(() => getInitialUi().colorsOpen);
  const [panelOpen, setPanelOpen] = useState(() => ({
    model: true,
    templates: true,
    targeting: true,
    overlays: false,
    view: true,
  }));
  const [textureReloadToken, setTextureReloadToken] = useState(0);
  const [windowTextureReloadToken, setWindowTextureReloadToken] = useState(0);
  const [textureTargets, setTextureTargets] = useState([]);
  const [textureMode, setTextureMode] = useState(() => getInitialDefaults().textureMode);
  const [textureTarget, setTextureTarget] = useState("all");
  const [liveryTarget, setLiveryTarget] = useState("");
  const [liveryLabel, setLiveryLabel] = useState("");
  const [windowTextureTarget, setWindowTextureTarget] = useState(() => getInitialDefaults().windowTextureTarget || "auto");
  const [cameraWASD, setCameraWASD] = useState(() => Boolean(getInitialDefaults().cameraWASD));
  const [windowLiveryTarget, setWindowLiveryTarget] = useState("");
  const [windowLiveryLabel, setWindowLiveryLabel] = useState("");
  const [liveryWindowOverride, setLiveryWindowOverride] = useState(""); // Manual override for glass material in livery mode
  const [liveryExteriorOnly, setLiveryExteriorOnly] = useState(() => Boolean(getInitialDefaults().liveryExteriorOnly));
  const [lastUpdate, setLastUpdate] = useState("-");
  const [watchStatus, setWatchStatus] = useState("idle");
  const [dialogError, setDialogError] = useState("");
  const [textureError, setTextureError] = useState("");
  const [windowTextureError, setWindowTextureError] = useState("");
  const [ytdPath, setYtdPath] = useState("");
  const [ytdTextures, setYtdTextures] = useState(null);
  const [ytdLoading, setYtdLoading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [modelLoading, setModelLoading] = useState(false);
  const [viewerReady, setViewerReady] = useState(false);
  const [booted, setBooted] = useState(false);
  const bootStartRef = useRef(typeof performance !== "undefined" ? performance.now() : Date.now());
  const bootTimerRef = useRef(null);

  const isBooting = !booted;
  const modelExtensions = textureMode === "eup" ? ["yft", "clmesh", "dff", "ydd"] : ["yft", "clmesh", "dff"];
  const modelDropLabel = modelExtensions.map((ext) => `.${ext}`).join(" / ");

  const loadModel = useCallback(
    async (path) => {
      if (!path) return;

      const lower = path.toString().toLowerCase();
      if (lower.endsWith(".obj")) {
        setDialogError(
          "out of sheer respect for vehicle devs and those who pour their hearts and souls into their creations, .OBJ files will never be supported.",
        );
        return;
      }

      setDialogError("");
      setTextureTargets([]);
      setTextureTarget("all");
      setLiveryTarget("");
      setLiveryLabel("");
      setWindowTextureTarget("none");
      setWindowLiveryTarget("");
      setWindowLiveryLabel("");

      setModelSourcePath(path);
      setModelLoading(true);

      try {
        setModelPath(path);
      } catch (error) {
        const message =
          typeof error === "string"
            ? error
            : error && typeof error === "object" && "message" in error
              ? error.message
              : "Model load failed.";
        setDialogError(message);
        setModelPath("");
        console.error(error);
      } finally {
        setModelLoading(false);
      }
    },
    [isTauriRuntime],
  );

  useEffect(() => {
    // Ensure the loader gets time to display even when the viewer initializes instantly.
    if (!viewerReady) return;

    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const elapsed = now - bootStartRef.current;
    const remaining = Math.max(0, MIN_LOADER_MS - elapsed);

    if (bootTimerRef.current) {
      clearTimeout(bootTimerRef.current);
    }

    bootTimerRef.current = setTimeout(() => {
      setBooted(true);
    }, remaining);

    return () => {
      if (bootTimerRef.current) {
        clearTimeout(bootTimerRef.current);
      }
    };
  }, [viewerReady]);

  const scheduleReload = (kind) => {
    const key = kind === "window" ? "window" : "primary";
    const timers = reloadTimerRef.current;
    if (timers[key]) {
      clearTimeout(timers[key]);
    }
    timers[key] = setTimeout(() => {
      if (key === "window") {
        setWindowTextureReloadToken((prev) => prev + 1);
      } else {
        setTextureReloadToken((prev) => prev + 1);
      }
    }, 350);
  };

  const togglePanel = useCallback((key) => {
    setPanelOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const handleModelInfo = useCallback((info) => {
    const targets = info?.targets ?? [];
    setTextureTargets(targets);
    setLiveryTarget(info?.liveryTarget || "");
    setLiveryLabel(info?.liveryLabel || "");
    setWindowLiveryTarget(info?.windowTarget || "");
    setWindowLiveryLabel(info?.windowLabel || "");
    // Reset manual glass override when a new model is loaded
    setLiveryWindowOverride((prev) => {
      if (!prev) return prev;
      // Only reset if the previous override is not in the new targets
      return targets.some((target) => target.value === prev) ? prev : "";
    });
    setTextureTarget((prev) => {
      if (prev === "all") return prev;
      return targets.some((target) => target.value === prev) ? prev : "all";
    });
    setWindowTextureTarget((prev) => {
      if (prev === "all" || prev === "none" || prev === "auto") return prev;
      return targets.some((target) => target.value === prev) ? prev : "none";
    });
  }, []);

  useEffect(() => {
    if (!windowTemplateEnabled) return;
    setWindowTextureTarget((prev) => {
      if (prev === "auto") return prev;
      if (prev !== "none") return prev;
      return windowLiveryTarget || prev;
    });
  }, [windowTemplateEnabled, windowLiveryTarget]);

  useEffect(() => {
    if (windowTemplateEnabled) return;
    setWindowTextureError("");
  }, [windowTemplateEnabled]);

  const handleTextureError = useCallback((message) => {
    setTextureError(message || "");
  }, []);

  const handleWindowTextureError = useCallback((message) => {
    setWindowTextureError(message || "");
  }, []);

  const handleModelLoading = useCallback((loading) => {
    setModelLoading(Boolean(loading));
  }, []);

  const handleModelError = useCallback((message) => {
    setDialogError(message || "Failed to load model.");
    setModelPath("");
  }, []);

  const applyAndPersistDefaults = useCallback((next) => {
    const merged = { ...BUILT_IN_DEFAULTS, ...(next || {}) };
    setDefaults(merged);
    setTextureMode(merged.textureMode);
    setLiveryExteriorOnly(Boolean(merged.liveryExteriorOnly));
    setWindowTemplateEnabled(Boolean(merged.windowTemplateEnabled));
    setWindowTextureTarget(merged.windowTextureTarget || "auto");
    setCameraWASD(Boolean(merged.cameraWASD));
    setBodyColor(merged.bodyColor);
    setBackgroundColor(merged.backgroundColor);
    setExperimentalSettings(Boolean(merged.experimentalSettings));
    const prefs = loadPrefs() || {};
    savePrefs({ ...prefs, defaults: merged });
  }, []);

  const saveHotkeys = useCallback((next) => {
    setHotkeys(next);
    const prefs = loadPrefs() || {};
    savePrefs({ ...prefs, hotkeys: next });
  }, []);

  useEffect(() => {
    const prefs = loadPrefs() || {};
    const ui = { ...(prefs.ui || {}), colorsOpen };
    savePrefs({ ...prefs, ui });
  }, [colorsOpen]);

  const selectModelRef = useRef(null);
  const selectTextureRef = useRef(null);
  const selectWindowTextureRef = useRef(null);

  const completeOnboarding = useCallback(
    (next) => {
      applyAndPersistDefaults(next);
      setOnboarded();
      setShowOnboarding(false);
    },
    [applyAndPersistDefaults],
  );

  const selectModel = async () => {
    if (!isTauriRuntime) {
      setDialogError("Tauri runtime required for file dialog.");
      return;
    }
    try {
      const selected = await open({
        filters: [{ name: "Model", extensions: modelExtensions }],
      });
      setDialogError("");
      if (typeof selected === "string") {
        await loadModel(selected);
      }
    } catch (error) {
      setDialogError("Dialog permission blocked. Check Tauri capabilities.");
      console.error(error);
    }
  };

  const selectTexture = async () => {
    if (!isTauriRuntime) {
      setDialogError("Tauri runtime required for file dialog.");
      return;
    }
    try {
      const selected = await open({
        filters: [
          {
            name: "Texture",
            extensions: [
              "png",
              "jpg",
              "jpeg",
              "webp",
              "avif",
              "bmp",
              "gif",
              "tga",
              "dds",
              "tif",
              "tiff",
              "psd",
              "ai",
            ],
          },
        ],
      });
      setDialogError("");
      if (typeof selected === "string") {
        setTextureError("");
        setTexturePath(selected);
      }
    } catch (error) {
      setDialogError("Dialog permission blocked. Check Tauri capabilities.");
      console.error(error);
    }
  };

  const handleMinimize = async () => {
    if (!isTauriRuntime) return;
    await getCurrentWindow().minimize();
  };

  const handleMaximize = async () => {
    if (!isTauriRuntime) return;
    const win = getCurrentWindow();
    const isMaximized = await win.isMaximized();
    if (isMaximized) {
      await win.unmaximize();
    } else {
      await win.maximize();
    }
  };

  const handleClose = async () => {
    if (!isTauriRuntime) return;
    await getCurrentWindow().close();
  };

  const selectWindowTexture = async () => {
    if (!isTauriRuntime) {
      setDialogError("Tauri runtime required for file dialog.");
      return;
    }
    try {
      const selected = await open({
        filters: [
          {
            name: "Texture",
            extensions: [
              "png",
              "jpg",
              "jpeg",
              "webp",
              "avif",
              "bmp",
              "gif",
              "tga",
              "dds",
              "tif",
              "tiff",
              "psd",
              "ai",
            ],
          },
        ],
      });
      setDialogError("");
      if (typeof selected === "string") {
        setWindowTextureError("");
        setWindowTexturePath(selected);
      }
    } catch (error) {
      setDialogError("Dialog permission blocked. Check Tauri capabilities.");
      console.error(error);
    }
  };

  const selectYtd = async () => {
    if (!isTauriRuntime) {
      setDialogError("Tauri runtime required for file dialog.");
      return;
    }
    try {
      const selected = await open({
        filters: [{ name: "Texture Dictionary", extensions: ["ytd"] }],
      });
      setDialogError("");
      if (typeof selected === "string") {
        setYtdLoading(true);
        try {
          const bytes = await readFile(selected);
          const textures = parseYtd(bytes);
          if (textures && Object.keys(textures).length > 0) {
            const categorized = categorizeTextures(textures);
            setYtdPath(selected);
            setYtdTextures(categorized);
            console.log("[YTD] Loaded textures:", Object.keys(textures));
          } else {
            setDialogError("No textures found in YTD file.");
          }
        } catch (err) {
          console.error("[YTD] Load error:", err);
          setDialogError("Failed to parse YTD file.");
        } finally {
          setYtdLoading(false);
        }
      }
    } catch (error) {
      setDialogError("Dialog permission blocked. Check Tauri capabilities.");
      console.error(error);
    }
  };

  const clearYtd = () => {
    setYtdPath("");
    setYtdTextures(null);
  };

  // Keep refs updated for hotkey handler
  selectModelRef.current = selectModel;
  selectTextureRef.current = selectTexture;
  selectWindowTextureRef.current = selectWindowTexture;

  // Hotkey event handler
  useEffect(() => {
    const handleKeyDown = (event) => {
      // Ignore if typing in an input
      const target = event.target;
      if (target instanceof Element) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (target.isContentEditable) return;
        // Ignore if a hotkey input is capturing
        if (target.classList.contains("hotkey-input")) return;
      }

      const action = findMatchingAction(hotkeys, event);
      if (!action) return;

      event.preventDefault();
      event.stopPropagation();

      switch (action) {
        case HOTKEY_ACTIONS.TOGGLE_EXTERIOR_ONLY:
          setLiveryExteriorOnly((prev) => !prev);
          break;
        case HOTKEY_ACTIONS.MODE_LIVERY:
          setTextureMode("livery");
          break;
        case HOTKEY_ACTIONS.MODE_ALL:
          setTextureMode("everything");
          break;
        case HOTKEY_ACTIONS.MODE_EUP:
          setTextureMode("eup");
          break;
        case HOTKEY_ACTIONS.CYCLE_MODE:
          setTextureMode((prev) => {
            if (prev === "livery") return "everything";
            if (prev === "everything") return "eup";
            return "livery";
          });
          break;
        case HOTKEY_ACTIONS.TOGGLE_PANEL:
          setPanelCollapsed((prev) => !prev);
          break;
        case HOTKEY_ACTIONS.SELECT_MODEL:
          selectModelRef.current?.();
          break;
        case HOTKEY_ACTIONS.SELECT_LIVERY:
          selectTextureRef.current?.();
          break;
        case HOTKEY_ACTIONS.SELECT_GLASS:
          selectWindowTextureRef.current?.();
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hotkeys]);

  const handleCenterCamera = () => {
    viewerApiRef.current?.reset?.();
  };


  const handleDragOver = (event) => {
    event.preventDefault();
    if (!isDragging) setIsDragging(true);
  };

  const handleDragLeave = (event) => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setIsDragging(false);
  };

  const handleDrop = (event) => {
    event.preventDefault();
    setIsDragging(false);
    if (!isTauriRuntime) {
      setDialogError("Drag-and-drop requires the Tauri app.");
      return;
    }

    const files = Array.from(event.dataTransfer?.files || []);
    const objFile = files.find((file) => file.name?.toLowerCase()?.endsWith(".obj"));
    const modelFile = files.find((file) => {
      const name = file.name?.toLowerCase();
      return modelExtensions.some((ext) => name?.endsWith(`.${ext}`));
    });

    if (!modelFile) {
      setDialogError(
        objFile
          ? "out of sheer respect for vehicle devs and those who pour their hearts and souls into their creations, .OBJ files will never be supported."
          : `Only ${modelDropLabel} files are supported for drop.`,
      );
      return;
    }

    if (!modelFile.path) {
      setDialogError("Unable to read dropped file path.");
      return;
    }

    setDialogError("");
    loadModel(modelFile.path);
  };

  useEffect(() => {
    let unlisten = null;
    let cancelled = false;

    const normalizePath = (value) => (value || "").toString().replace(/\\/g, "/").toLowerCase();

    const start = async () => {
      if (!isTauriRuntime) {
        setWatchStatus("idle");
        return;
      }

      const primaryPath = texturePath;
      const secondaryPath = windowTemplateEnabled ? windowTexturePath : "";

      const wantsPrimary = Boolean(primaryPath);
      const wantsSecondary = Boolean(secondaryPath);

      if (!wantsPrimary) {
        await invoke("stop_watch").catch(() => null);
      }

      if (!wantsSecondary) {
        await invoke("stop_window_watch").catch(() => null);
      }

      if (!wantsPrimary && !wantsSecondary) {
        if (!cancelled) setWatchStatus("idle");
        return;
      }

      const primaryOk = wantsPrimary
        ? await invoke("start_watch", { path: primaryPath }).then(
            () => true,
            () => false,
          )
        : true;

      const secondaryOk = wantsSecondary
        ? await invoke("start_window_watch", { path: secondaryPath }).then(
            () => true,
            () => false,
          )
        : true;

      if (!cancelled) {
        setWatchStatus(primaryOk && secondaryOk ? "watching" : "error");
      }

      unlisten = await listen("texture:update", (event) => {
        const changedPath = normalizePath(event?.payload?.path);
        const primaryNorm = normalizePath(primaryPath);
        const secondaryNorm = normalizePath(secondaryPath);

        if (!primaryNorm && !secondaryNorm) return;
        if (!changedPath) {
          scheduleReload("primary");
          scheduleReload("window");
          return;
        }
        const matchesPrimary = primaryNorm && changedPath === primaryNorm;
        const matchesWindow = secondaryNorm && changedPath === secondaryNorm;
        if (matchesPrimary) scheduleReload("primary");
        if (matchesWindow) scheduleReload("window");
      });
    };

    start();

    return () => {
      cancelled = true;
      if (unlisten) {
        unlisten();
      }
      if (isTauriRuntime) {
        invoke("stop_watch").catch(() => null);
        invoke("stop_window_watch").catch(() => null);
      }
    };
  }, [texturePath, windowTexturePath, windowTemplateEnabled]);

  const onTextureReload = () => {
    setLastUpdate(new Date().toLocaleTimeString());
  };

  const resolvedTextureTarget =
    textureMode === "livery" ? liveryTarget || "all" : textureTarget;
  const resolvedWindowBaseTarget =
    windowTextureTarget === "auto"
      ? windowLiveryTarget || "none"
      : windowTextureTarget || "none";
  // In livery mode: prioritize manual override, then configured default, then none
  const resolvedWindowTextureTarget =
    textureMode === "livery"
      ? liveryWindowOverride || resolvedWindowBaseTarget
      : resolvedWindowBaseTarget;
  const hasModel = Boolean(modelPath);
  const liveryStatusLabel = liveryLabel || "No livery material found";
  const windowStatusLabel = windowLiveryLabel || "No window material found";
  const usingWindowOverride = textureMode === "livery" && liveryWindowOverride;
  const liveryHint = !hasModel
    ? "Load a model to detect livery materials."
    : liveryTarget
      ? "Auto-targeting carpaint/livery materials (carpaint, livery, sign_1, sign_2)."
      : "No livery material found. Falling back to all meshes.";
  const windowHint = !hasModel
    ? "Load a model to detect window materials."
    : usingWindowOverride
      ? "Using manually selected material."
      : windowLiveryTarget
        ? "Auto-detecting glass/window materials. Use dropdown to override."
        : "No window material auto-detected. Select a material below.";
  const modelLabel = getFileLabel(modelSourcePath || modelPath, "No model selected");
  const primaryTemplateLabel =
    textureMode === "livery"
      ? getFileLabel(texturePath, "No livery template")
      : textureMode === "everything"
        ? getFileLabel(texturePath, "No texture template")
        : getFileLabel(texturePath, "No uniform texture");
  const overlayLabel = windowTemplateEnabled
    ? getFileLabel(windowTexturePath, "No overlay selected")
    : "Off";
  const manualTargetLabel =
    textureTarget === "all"
      ? "All meshes"
      : textureTargets.find((target) => target.value === textureTarget)?.label || "Custom target";
  const targetingLabel = textureMode === "livery" ? (liveryTarget ? "Auto" : "No target") : manualTargetLabel;
  const viewLabel = liveryExteriorOnly ? "Exterior only" : "Full model";

  return (
    <motion.div
      className={`app-shell ${panelCollapsed ? "is-panel-collapsed" : ""}`}
      initial={{ opacity: 0, y: 6 }}
      animate={isBooting ? { opacity: 0, y: 6 } : { opacity: 1, y: 0 }}
      transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
      style={{ pointerEvents: isBooting ? "none" : "auto" }}
    >
        <div className="titlebar">
          <div className="titlebar-brand" data-tauri-drag-region>
            <LoadingGlyph kind="cube" className="titlebar-logo" aria-hidden="true" />

          </div>
        <div className="titlebar-spacer" data-tauri-drag-region />
        <div className="titlebar-controls">
          <button
            type="button"
            className="titlebar-btn titlebar-min"
            onClick={handleMinimize}
            aria-label="Minimize"
            data-tauri-drag-region="false"
          >
            <Minus className="titlebar-icon titlebar-icon--min" />
          </button>
          <button
            type="button"
            className="titlebar-btn titlebar-max"
            onClick={handleMaximize}
            aria-label="Maximize"
            data-tauri-drag-region="false"
          >
            <Square className="titlebar-icon titlebar-icon--max" />
          </button>
          <button
            type="button"
            className="titlebar-btn titlebar-close"
            onClick={handleClose}
            aria-label="Close"
            data-tauri-drag-region="false"
          >
            <X className="titlebar-icon titlebar-icon--close" />
          </button>
        </div>
      </div>

      {panelCollapsed ? (
        <motion.button
          type="button"
          className="panel-peek"
          onClick={() => setPanelCollapsed(false)}
          aria-label="Expand control panel"
          initial={{ opacity: 0, x: -6 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        >
          <motion.span
            className="panel-peek-icon"
            animate={{ x: [0, 3, 0] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: [0.45, 0, 0.55, 1] }}
          >
            <ChevronRight aria-hidden="true" />
          </motion.span>
        </motion.button>
      ) : null}
      <motion.aside
        className="control-panel"
        initial={{ opacity: 0, x: -12 }}
        animate={
          isBooting
            ? { opacity: 0, x: -12 }
            : panelCollapsed
              ? { opacity: 0, x: "-100%" }
              : { opacity: 1, x: 0 }
        }
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        style={{ pointerEvents: panelCollapsed ? "none" : "auto", willChange: "transform, opacity" }}
      >
        <div className="panel-header">
          <div className="panel-header-top">
            <div className="panel-header-left">
              <button
                type="button"
                className="panel-collapse"
                onClick={() => setPanelCollapsed(true)}
                aria-label="Collapse control panel"
              >
                <ChevronLeft className="panel-collapse-icon" aria-hidden="true" />
              </button>
              <div className="panel-title-stack">
                <div className="panel-title">Cortex Studio</div>

              </div>
            </div>
            <SettingsMenu
              defaults={defaults}
              builtInDefaults={BUILT_IN_DEFAULTS}
              onSave={applyAndPersistDefaults}
              hotkeys={hotkeys}
              onSaveHotkeys={saveHotkeys}
            />
          </div>
          <div className="mode-tabs" role="tablist" aria-label="Editor mode">
            <motion.button
              type="button"
              role="tab"
              className={`mode-tab ${textureMode === "livery" ? "is-active" : ""}`}
              onClick={() => setTextureMode("livery")}
              aria-selected={textureMode === "livery"}
              aria-controls="mode-panel-livery"
              whileTap={{ scale: 0.98 }}
            >
              <Car className="mode-tab-icon" aria-hidden="true" />
              <span>Livery</span>
            </motion.button>
            <motion.button
              type="button"
              role="tab"
              className={`mode-tab ${textureMode === "everything" ? "is-active" : ""}`}
              onClick={() => setTextureMode("everything")}
              aria-selected={textureMode === "everything"}
              aria-controls="mode-panel-everything"
              whileTap={{ scale: 0.98 }}
            >
              <Layers className="mode-tab-icon" aria-hidden="true" />
              <span>All</span>
            </motion.button>
            <motion.button
              type="button"
              role="tab"
              className={`mode-tab ${textureMode === "eup" ? "is-active" : ""}`}
              onClick={() => setTextureMode("eup")}
              aria-selected={textureMode === "eup"}
              aria-controls="mode-panel-eup"
              whileTap={{ scale: 0.98 }}
            >
              <Shirt className="mode-tab-icon" aria-hidden="true" />
              <span>EUP</span>
            </motion.button>
          </div>
        </div>
        <div className="control-panel-scroll">
          <PanelSection
            title="Model"
            caption={modelLabel}
            open={panelOpen.model}
            onToggle={() => togglePanel("model")}
            contentId="panel-model"
          >
            <div className="control-group">
              <Label>Select Model</Label>
              <Button variant="outline" className="border-[#7dd3fc]/50 bg-[#7dd3fc]/5 text-[#7dd3fc] hover:bg-[#7dd3fc]/10" onClick={selectModel}>
                Select Model
              </Button>
              {modelLoading ? <div className="file-meta">Preparing model…</div> : null}
            </div>
            {experimentalSettings ? (
              <div className="control-group">
                <Label>Texture Dictionary (YTD)</Label>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="flex-1 border-[#a78bfa]/50 bg-[#a78bfa]/5 text-[#a78bfa] hover:bg-[#a78bfa]/10"
                    onClick={selectYtd}
                    disabled={ytdLoading}
                  >
                    <FolderOpen className="h-4 w-4 mr-2" />
                    {ytdLoading ? "Loading..." : "Load YTD"}
                  </Button>
                  {ytdPath && (
                    <Button
                      variant="outline"
                      className="w-9 p-0 border-white/10 text-white/40 hover:text-white/80"
                      onClick={clearYtd}
                      title="Unload YTD"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                {ytdPath && (
                  <div className="file-meta mono">{ytdPath.split(/[\\/]/).pop()}</div>
                )}
                {ytdTextures && (
                  <div className="file-meta">
                    {Object.keys(ytdTextures.diffuse).length} diffuse, {Object.keys(ytdTextures.normal).length} normal, {Object.keys(ytdTextures.specular).length} specular
                  </div>
                )}
                <div className="file-meta mono">Auto-maps diffuse, normal, and specular textures to materials.</div>
              </div>
            ) : null}
          </PanelSection>

          {textureMode === "livery" ? (
            <div className="mode-content" id="mode-panel-livery" role="tabpanel">
              <PanelSection
                title="Templates"
                caption={primaryTemplateLabel}
                open={panelOpen.templates}
                onToggle={() => togglePanel("templates")}
                contentId="panel-templates"
              >
                <div className="control-group">
                  <Label>Vehicle Template</Label>
                  <div className="flex gap-2">
                      <Button
                        variant="outline"
                        className="flex-1 border-[#7dd3fc]/50 bg-[#7dd3fc]/5 text-[#7dd3fc] hover:bg-[#7dd3fc]/10"
                        onClick={selectTexture}
                      >
                        Select Livery
                      </Button>
                    {texturePath && (
                      <Button
                        variant="outline"
                        className="w-9 p-0 border-white/10 text-white/40 hover:text-white/80"
                        onClick={() => setTexturePath("")}
                        title="Unload texture"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>

                </div>
              </PanelSection>

              <PanelSection
                title="Targeting"
                caption={targetingLabel}
                open={panelOpen.targeting}
                onToggle={() => togglePanel("targeting")}
                contentId="panel-targeting"
              >
                <div className="control-group">
                  <Label>Apply Livery To</Label>
                  <div className="texture-auto-target">
                    <span className="texture-auto-badge">Auto</span>
                    <span className="texture-auto-value">{liveryStatusLabel}</span>
                  </div>
                  <div className="file-meta mono">{liveryHint}</div>
                </div>
              </PanelSection>

              <PanelSection
                title="Glass Overlay"
                caption={overlayLabel}
                open={panelOpen.overlays}
                onToggle={() => togglePanel("overlays")}
                contentId="panel-overlays"
              >
                <div className="control-group">
                  <Label>Vehicle Glass</Label>
                  <div className="toggle-row">
                    <button
                      type="button"
                      className={`settings-toggle ${windowTemplateEnabled ? "is-on" : ""}`}
                      onClick={() => setWindowTemplateEnabled((prev) => !prev)}
                      aria-pressed={windowTemplateEnabled}
                      aria-label="Toggle window template"
                    >
                      <span className="settings-toggle-dot" aria-hidden="true" />
                    </button>
                    <span className="toggle-switch-label">{windowTemplateEnabled ? "On" : "Off"}</span>
                  </div>
                  {windowTemplateEnabled ? (
                    <>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          className="flex-1 border-[#7dd3fc]/50 bg-[#7dd3fc]/5 text-[#7dd3fc] hover:bg-[#7dd3fc]/10"
                          onClick={selectWindowTexture}
                        >
                          Select Glass
                        </Button>
                        {windowTexturePath && (
                          <Button
                            variant="outline"
                            className="w-9 p-0 border-white/10 text-white/40 hover:text-white/80"
                            onClick={() => setWindowTexturePath("")}
                            title="Unload window template"
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        )}
                      </div>

                      <Label>Apply Glass To</Label>
                      <Select value={liveryWindowOverride || "auto"} onValueChange={(val) => setLiveryWindowOverride(val === "auto" ? "" : val)}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select target" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">
                            {windowLiveryTarget
                              ? `Auto (${windowStatusLabel})`
                              : "Auto (no material detected)"}
                          </SelectItem>
                          {textureTargets.map((target) => (
                            <SelectItem key={target.value} value={target.value}>
                              {target.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <div className="file-meta mono">{windowHint}</div>
                    </>
                  ) : (
                    <div className="file-meta mono">Enable to apply a window/glass texture overlay.</div>
                  )}
                </div>
              </PanelSection>

              <PanelSection
                title="Visibility"
                caption={viewLabel}
                open={panelOpen.view}
                onToggle={() => togglePanel("view")}
                contentId="panel-visibility"
              >
                <div className="control-group">
                  <Label>Exterior Only</Label>
                  <div className="toggle-row">
                    <button
                      type="button"
                      className={`settings-toggle ${liveryExteriorOnly ? "is-on" : ""}`}
                      onClick={() => setLiveryExteriorOnly((prev) => !prev)}
                      aria-pressed={liveryExteriorOnly}
                      aria-label="Toggle exterior only"
                    >
                      <span className="settings-toggle-dot" aria-hidden="true" />
                    </button>
                    <span className="toggle-switch-label">{liveryExteriorOnly ? "On" : "Off"}</span>
                  </div>
                  <div className="file-meta mono">Hides interior, glass, and wheel meshes in livery view.</div>
                </div>
              </PanelSection>
            </div>
          ) : null}

          {textureMode === "everything" ? (
            <div className="mode-content" id="mode-panel-everything" role="tabpanel">
              <PanelSection
                title="Templates"
                caption={primaryTemplateLabel}
                open={panelOpen.templates}
                onToggle={() => togglePanel("templates")}
                contentId="panel-templates"
              >
                <div className="control-group">
                  <Label>Texture Template</Label>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      className="flex-1 border-[#7dd3fc]/50 bg-[#7dd3fc]/5 text-[#7dd3fc] hover:bg-[#7dd3fc]/10"
                      onClick={selectTexture}
                    >
                      Select Texture
                    </Button>
                    {texturePath && (
                      <Button
                        variant="outline"
                        className="w-9 p-0 border-white/10 text-white/40 hover:text-white/80"
                        onClick={() => setTexturePath("")}
                        title="Unload texture"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>

                </div>
              </PanelSection>

              <PanelSection
                title="Targeting"
                caption={manualTargetLabel}
                open={panelOpen.targeting}
                onToggle={() => togglePanel("targeting")}
                contentId="panel-targeting"
              >
                <div className="control-group">
                  <Label>Apply Texture To</Label>
                  <Select value={textureTarget} onValueChange={setTextureTarget}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select target" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All meshes</SelectItem>
                      {textureTargets.map((target) => (
                        <SelectItem key={target.value} value={target.value}>
                          {target.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="file-meta mono">
                    {textureTargets.length
                      ? "Targets come from model material or mesh names."
                      : "Load a model to list material targets."}
                  </div>
                </div>
              </PanelSection>

              <PanelSection
                title="Overlays"
                caption={overlayLabel}
                open={panelOpen.overlays}
                onToggle={() => togglePanel("overlays")}
                contentId="panel-overlays"
              >
                <div className="control-group">
                  <Label>Secondary Texture</Label>
                  <div className="toggle-row">
                    <button
                      type="button"
                      className={`settings-toggle ${windowTemplateEnabled ? "is-on" : ""}`}
                      onClick={() => setWindowTemplateEnabled((prev) => !prev)}
                      aria-pressed={windowTemplateEnabled}
                      aria-label="Toggle secondary texture"
                    >
                      <span className="settings-toggle-dot" aria-hidden="true" />
                    </button>
                    <span className="toggle-switch-label">{windowTemplateEnabled ? "On" : "Off"}</span>
                  </div>
                  {windowTemplateEnabled ? (
                    <>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          className="flex-1 border-[#7dd3fc]/50 bg-[#7dd3fc]/5 text-[#7dd3fc] hover:bg-[#7dd3fc]/10"
                          onClick={selectWindowTexture}
                        >
                          Select Secondary
                        </Button>
                        {windowTexturePath && (
                          <Button
                            variant="outline"
                            className="w-9 p-0 border-white/10 text-white/40 hover:text-white/80"
                            onClick={() => setWindowTexturePath("")}
                            title="Unload secondary texture"
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                      <div className="file-meta mono">
                        {windowTexturePath ? windowTexturePath.split(/[\\/]/).pop() : "No secondary texture selected"}
                      </div>
                      <Select value={windowTextureTarget} onValueChange={setWindowTextureTarget}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select target" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">Auto (window materials)</SelectItem>
                          <SelectItem value="none">None</SelectItem>
                          <SelectItem value="all">All meshes</SelectItem>
                          {textureTargets.map((target) => (
                            <SelectItem key={target.value} value={target.value}>
                              {target.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <div className="file-meta mono">
                        {textureTargets.length
                          ? "Applied on top of the primary texture."
                          : "Load a model to list material targets."}
                      </div>
                    </>
                  ) : (
                    <div className="file-meta mono">Enable to overlay a secondary texture on specific targets.</div>
                  )}
                </div>
              </PanelSection>
            </div>
          ) : null}

          {textureMode === "eup" ? (
            <div className="mode-content" id="mode-panel-eup" role="tabpanel">
              <PanelSection
                title="Uniform Template"
                caption={primaryTemplateLabel}
                open={panelOpen.templates}
                onToggle={() => togglePanel("templates")}
                contentId="panel-templates"
              >
                <div className="control-group">
                  <Label>Uniform Texture</Label>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      className="flex-1 border-[#7dd3fc]/50 bg-[#7dd3fc]/5 text-[#7dd3fc] hover:bg-[#7dd3fc]/10"
                      onClick={selectTexture}
                    >
                      Select Uniform
                    </Button>
                    {texturePath && (
                      <Button
                        variant="outline"
                        className="w-9 p-0 border-white/10 text-white/40 hover:text-white/80"
                        onClick={() => setTexturePath("")}
                        title="Unload texture"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                  <div className="file-meta mono">{primaryTemplateLabel}</div>
                </div>
              </PanelSection>

              <PanelSection
                title="Targeting"
                caption={manualTargetLabel}
                open={panelOpen.targeting}
                onToggle={() => togglePanel("targeting")}
                contentId="panel-targeting"
              >
                <div className="control-group">
                  <Label>Apply Uniform To</Label>
                  <Select value={textureTarget} onValueChange={setTextureTarget}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select target" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All meshes</SelectItem>
                      {textureTargets.map((target) => (
                        <SelectItem key={target.value} value={target.value}>
                          {target.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="file-meta mono">
                    {textureTargets.length
                      ? "Select the clothing material to apply the uniform to."
                      : "Load a .ydd EUP model to list material targets."}
                  </div>
                </div>
              </PanelSection>
            </div>
          ) : null}

          <PanelSection
            title="Colors"
            caption="Body + background"
            open={colorsOpen}
            onToggle={() => setColorsOpen((prev) => !prev)}
            contentId="panel-colors"
          >
            <div className="control-group">
              <Label>Body Color</Label>
              <div className="color-input">
                <div className="color-swatch-wrapper">
                  <div className="color-swatch" style={{ background: bodyColor }} />
                  <input
                    type="color"
                    value={bodyColor}
                    onChange={(event) => setBodyColor(event.currentTarget.value)}
                    className="color-picker-native"
                    aria-label="Body color picker"
                  />
                </div>
                <Input
                  className="mono h-8 px-2"
                  value={bodyColor}
                  onChange={(event) => setBodyColor(event.currentTarget.value)}
                />
                <Button
                  variant="ghost"
                  className="h-8 w-8 p-0 text-white/30 hover:text-white"
                  onClick={() => setBodyColor(DEFAULT_BODY)}
                  title="Revert to default"
                >
                  <RotateCcw className="h-3 w-3" />
                </Button>
              </div>
            </div>

            <div className="control-group">
              <Label>Background Color</Label>
              <div className="color-input">
                <div className="color-swatch-wrapper">
                  <div className="color-swatch" style={{ background: backgroundColor }} />
                  <input
                    type="color"
                    value={backgroundColor}
                    onChange={(event) => setBackgroundColor(event.currentTarget.value)}
                    className="color-picker-native"
                    aria-label="Background color picker"
                  />
                </div>
                <Input
                  className="mono h-8 px-2"
                  value={backgroundColor}
                  onChange={(event) => setBackgroundColor(event.currentTarget.value)}
                />
                <Button
                  variant="ghost"
                  className="h-8 w-8 p-0 text-white/30 hover:text-white"
                  onClick={() => setBackgroundColor(DEFAULT_BG)}
                  title="Revert to default"
                >
                  <RotateCcw className="h-3 w-3" />
                </Button>
              </div>
            </div>
          </PanelSection>

        </div>

        <div className="control-panel-status" aria-label="Status">
          <div className="status-strip">
            <div className="flex items-center gap-2">
              <span className={watchStatus === "watching" ? "status-dot" : "h-2 w-2 rounded-full bg-white/20"} />
              <span>
                {watchStatus === "watching"
                  ? "Watching for saves"
                  : watchStatus === "error"
                    ? "Watcher error"
                    : "Idle"}
              </span>
            </div>
            <span>Last update: {lastUpdate}</span>
          </div>
          {dialogError ? <div className="file-meta">{dialogError}</div> : null}
          {textureError ? <div className="file-meta">{textureError}</div> : null}
          {windowTextureError ? <div className="file-meta">{windowTextureError}</div> : null}
        </div>
      </motion.aside>

      <motion.section
        className={`viewer-shell ${isDragging ? "is-dragging" : ""}`}
        initial={{ opacity: 0, y: 6 }}
        animate={isBooting ? { opacity: 0, y: 6 } : { opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.05, ease: [0.22, 1, 0.36, 1] }}
        onDragEnter={handleDragOver}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
          {isDragging ? (
            <div className="drop-overlay">
            <div className="drop-card">Drop {modelDropLabel} to load</div>
            </div>
          ) : null}
        <Viewer
          modelPath={modelPath}
          texturePath={texturePath}
          windowTexturePath={windowTemplateEnabled ? windowTexturePath : ""}
          bodyColor={bodyColor}
          backgroundColor={backgroundColor}
          textureReloadToken={textureReloadToken}
          windowTextureReloadToken={windowTextureReloadToken}
          textureTarget={resolvedTextureTarget}
          windowTextureTarget={resolvedWindowTextureTarget}
          textureMode={textureMode}
          wasdEnabled={cameraWASD}
          liveryExteriorOnly={textureMode === "livery" && liveryExteriorOnly}
          ytdTextures={ytdTextures}
          onModelInfo={handleModelInfo}
          onModelError={handleModelError}
          onModelLoading={handleModelLoading}
          onReady={(api) => {
            viewerApiRef.current = api;
            setViewerReady(true);
          }}
          onTextureReload={onTextureReload}
          onTextureError={handleTextureError}
          onWindowTextureError={handleWindowTextureError}
        />

        <AnimatePresence>
          {modelLoading ? <AppLoader variant="background" /> : null}
        </AnimatePresence>

        <motion.div 
          layout
          className="viewer-toolbar"
          transition={{ 
            type: "spring",
            stiffness: 2000,
            damping: 60
          }}
        >
          <AnimatePresence mode="wait" initial={false}>
            {!toolbarCollapsed ? (
              <motion.div
                key="expanded"
                layout
                className="flex items-center"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.01 }}
              >
                <motion.div layout className="viewer-toolbar-group">
                  <Button size="sm" variant="ghost" className="toolbar-btn" onClick={() => viewerApiRef.current?.setPreset("front")}>
                    Front
                  </Button>
                  <Button size="sm" variant="ghost" className="toolbar-btn" onClick={() => viewerApiRef.current?.setPreset("side")}>
                    Side
                  </Button>
                  <Button size="sm" variant="ghost" className="toolbar-btn" onClick={() => viewerApiRef.current?.setPreset("angle")}>
                    3/4
                  </Button>
                  <Button size="sm" variant="ghost" className="toolbar-btn" onClick={() => viewerApiRef.current?.setPreset("top")}>
                    Top
                  </Button>
                  <div className="toolbar-divider" />
                  <Button size="sm" variant="ghost" className="toolbar-btn" onClick={handleCenterCamera} disabled={!viewerReady}>
                    Center
                  </Button>
                </motion.div>
                <div className="toolbar-divider" />
                <motion.div layout className="viewer-toolbar-group">
                  <Button size="sm" variant="ghost" className="toolbar-btn" onClick={() => viewerApiRef.current?.rotateModel("x")} title="Rotate 90° on X axis">
                    <span className="mono mr-1 text-red-400">X</span>Rot
                  </Button>
                  <Button size="sm" variant="ghost" className="toolbar-btn" onClick={() => viewerApiRef.current?.rotateModel("y")} title="Rotate 90° on Y axis">
                    <span className="mono mr-1 text-green-400">Y</span>Rot
                  </Button>
                  <Button size="sm" variant="ghost" className="toolbar-btn" onClick={() => viewerApiRef.current?.rotateModel("z")} title="Rotate 90° on Z axis">
                    <span className="mono mr-1 text-blue-400">Z</span>Rot
                  </Button>
                </motion.div>
                <div className="toolbar-divider" />
                <motion.button 
                  layout
                  className="toolbar-toggle-btn" 
                  onClick={() => setToolbarCollapsed(true)}
                  title="Collapse Toolbar"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </motion.button>
              </motion.div>
            ) : (
              <motion.button
                key="collapsed"
                layout
                className="toolbar-toggle-btn is-collapsed"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setToolbarCollapsed(false)}
                title="Expand Toolbar"
              >
                <ChevronLeft className="w-4 h-4" />
              </motion.button>
            )}
          </AnimatePresence>
        </motion.div>

        <div className="viewer-hints">
          <span>Left drag: Rotate</span>
          <span>Right drag: Pan</span>
          <span>Scroll: Zoom</span>
        </div>
      </motion.section>

      <AnimatePresence>{isBooting ? <AppLoader /> : null}</AnimatePresence>
      <AnimatePresence>
        {!isBooting && showOnboarding ? (
          <Onboarding initialDefaults={defaults} onComplete={completeOnboarding} />
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}

export default App;
