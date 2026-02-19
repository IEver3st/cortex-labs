import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { writeFile, exists as fsExists } from "@tauri-apps/plugin-fs";
// Window controls handled by Shell
import { AlertTriangle, ArrowUpRight, Box, Car, Camera, ChevronRight, Eye, EyeOff, Layers, Link2, PanelLeft, RotateCcw, Shirt, X, Aperture, Disc, Zap, FolderOpen, Check, Copy, Info, Palette, Gem, Droplets, Sun } from "lucide-react";
import { useUpdateChecker } from "./lib/updater";
import { openPath } from "@tauri-apps/plugin-opener";
import AppLoader, { LoadingGlyph } from "./components/AppLoader";
import Onboarding from "./components/Onboarding";
// SettingsMenu now rendered by Shell
import Viewer from "./components/Viewer";
import DualModelViewer from "./components/DualModelViewer";
import { loadOnboarded, loadPrefs, savePrefs, setOnboarded, saveSession } from "./lib/prefs";
import { updateWorkspace } from "./lib/workspace";
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
import { CyberPanel, CyberSection, CyberButton, CyberCard, CyberLabel, CyberToggle, MaterialTypeSelector, MaterialSlider, TextureUploadGrid } from "./components/CyberUI";

const DEFAULT_BODY = "#e7ebf0";
const DEFAULT_BG = "#141414";
const MIN_LOADER_MS = 650;

const SUPPORTED_TEXTURE_EXTS = [
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
  "pdn",
];

function isTextureFormatSupported(filePath) {
  if (!filePath) return true;
  const ext = filePath.split(".").pop().toLowerCase();
  return SUPPORTED_TEXTURE_EXTS.includes(ext);
}

function getFileExtension(filePath) {
  if (!filePath) return "";
  return filePath.split(".").pop().toLowerCase();
}

const BUILT_IN_DEFAULTS = {
  textureMode: "everything",
  liveryExteriorOnly: false,
  windowTemplateEnabled: false,
  windowTextureTarget: "auto",
  cameraWASD: false,
  bodyColor: DEFAULT_BODY,
  backgroundColor: DEFAULT_BG,
  experimentalSettings: false,
  showHints: true,
  hideRotText: false,
  showGrid: false,
  showRecents: true,
  lightIntensity: 1.0,
  glossiness: 0.5,
  windowControlsStyle: "windows",
  toolbarInTitlebar: false,
  variantExportFolder: "",
  cameraControlsInPanel: false,
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

function UnloadButton({ onClick, title, className }) {
  return (
    <CyberButton variant="danger" className={className} onClick={onClick} title={title}>
      <X className="h-3 w-3 shrink-0 opacity-70" />
      <span className="font-bold tracking-[0.2em] text-[9px]">UNLOAD</span>
    </CyberButton>
  );
}

function App({ shellTab, isActive = true, onRenameTab, settingsVersion, defaultTextureMode = "livery", initialState = null, contextBarTarget = null }) {
  const viewerApiRef = useRef(null);
  const reloadTimerRef = useRef({ primary: null, window: null, dualA: null, dualB: null });
  const isTauriRuntime =
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__ !== "undefined" &&
    typeof window.__TAURI_INTERNALS__?.invoke === "function";

  const update = useUpdateChecker();

  const [defaults, setDefaults] = useState(() => getInitialDefaults());
  const [hotkeys, setHotkeys] = useState(() => getInitialHotkeys());
  const [showOnboarding, setShowOnboarding] = useState(() => !loadOnboarded());
  const [panelCollapsed, setPanelCollapsed] = useState(false);

  // Toast notification system
  const [toasts, setToasts] = useState([]);
  const toastIdRef = useRef(0);
  const showToast = useCallback((message, type = "info") => {
    const id = ++toastIdRef.current;
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3200);
  }, []);

  // Color swatch presets
  const COLOR_SWATCHES = ["#e7ebf0", "#1a1a2e", "#0f3460", "#16213e", "#533483", "#e94560", "#f5f5dc", "#2c3e50", "#000000", "#ffffff"];

  // Copy to clipboard
  const copyHex = useCallback((val) => {
    navigator.clipboard?.writeText(val).then(() => showToast(`Copied ${val}`));
  }, [showToast]);

  const [modelPath, setModelPath] = useState("");
  const [modelSourcePath, setModelSourcePath] = useState("");
  const [texturePath, setTexturePath] = useState("");
  const [windowTemplateEnabled, setWindowTemplateEnabled] = useState(() => Boolean(getInitialDefaults().windowTemplateEnabled));
  const [windowTexturePath, setWindowTexturePath] = useState("");
  const [bodyColor, setBodyColor] = useState(() => getInitialDefaults().bodyColor);
  const [backgroundColor, setBackgroundColor] = useState(() => getInitialDefaults().backgroundColor);
  const [backgroundImagePath, setBackgroundImagePath] = useState("");
  const [backgroundImageReloadToken, setBackgroundImageReloadToken] = useState(0);
  const [showWireframe, setShowWireframe] = useState(false);
  const [lightIntensity, setLightIntensity] = useState(() => getInitialDefaults().lightIntensity ?? 1.0);
  const [glossiness, setGlossiness] = useState(() => getInitialDefaults().glossiness ?? 0.5);
  const [experimentalSettings, setExperimentalSettings] = useState(() => Boolean(getInitialDefaults().experimentalSettings));

  // Vehicle Materials state
  const [materialType, setMaterialType] = useState("paint");
  const [matLightIntensity, setMatLightIntensity] = useState(1.0);
  const [matGlossiness, setMatGlossiness] = useState(0.5);
  const [matRoughness, setMatRoughness] = useState(0.3);
  const [matClearcoat, setMatClearcoat] = useState(0.0);
  const [materialTextures, setMaterialTextures] = useState([]);
  const [materialsOpen, setMaterialsOpen] = useState(false);

  // windowControlsStyle now handled by Shell
  const [colorsOpen, setColorsOpen] = useState(() => getInitialUi().colorsOpen);

  const [panelOpen, setPanelOpen] = useState(() => ({
    model: true,
    templates: true,
    targeting: true,
    overlays: false,
    view: true,
    camera: true,
  }));
  const [textureReloadToken, setTextureReloadToken] = useState(0);
  const [windowTextureReloadToken, setWindowTextureReloadToken] = useState(0);
  const [textureTargets, setTextureTargets] = useState([]);
  const [textureMode, setTextureMode] = useState(() => defaultTextureMode);
  const [textureTarget, setTextureTarget] = useState("all");
  const [liveryTarget, setLiveryTarget] = useState("");
  const [liveryLabel, setLiveryLabel] = useState("");
  const [windowTextureTarget, setWindowTextureTarget] = useState(() => getInitialDefaults().windowTextureTarget || "auto");

  const [cameraWASD, setCameraWASD] = useState(() => Boolean(getInitialDefaults().cameraWASD));
  const [cameraControlsInPanel, setCameraControlsInPanel] = useState(() => Boolean(getInitialDefaults().cameraControlsInPanel));
  const [showHints, setShowHints] = useState(() => Boolean(getInitialDefaults().showHints ?? true));
  const [hideRotText, setHideRotText] = useState(() => Boolean(getInitialDefaults().hideRotText));
  const [showGrid, setShowGrid] = useState(() => Boolean(getInitialDefaults().showGrid));
  const [windowLiveryTarget, setWindowLiveryTarget] = useState("");
  const [windowLiveryLabel, setWindowLiveryLabel] = useState("");
  const [liveryWindowOverride, setLiveryWindowOverride] = useState(""); // Manual override for glass material in livery mode
  const [liveryExteriorOnly, setLiveryExteriorOnly] = useState(() => Boolean(getInitialDefaults().liveryExteriorOnly));
  const [lastUpdate, setLastUpdate] = useState("-");
  const [watchStatus, setWatchStatus] = useState("idle");
  const [dialogError, setDialogError] = useState("");
  const [textureError, setTextureError] = useState("");
  const [windowTextureError, setWindowTextureError] = useState("");
  const [isDragging, setIsDragging] = useState(false);

  const dualViewerApiRef = useRef(null);
  const [dualModelAPath, setDualModelAPath] = useState("");
  const [dualModelBPath, setDualModelBPath] = useState("");
  const [dualTextureAPath, setDualTextureAPath] = useState("");
  const [dualTextureBPath, setDualTextureBPath] = useState("");
  const [dualWindowTextureAPath, setDualWindowTextureAPath] = useState("");
  const [dualWindowTextureBPath, setDualWindowTextureBPath] = useState("");
  const [dualWindowTextureATarget, setDualWindowTextureATarget] = useState("auto");
  const [dualWindowTextureBTarget, setDualWindowTextureBTarget] = useState("auto");
  const [dualTextureTargetsA, setDualTextureTargetsA] = useState([]);
  const [dualTextureTargetsB, setDualTextureTargetsB] = useState([]);
  const [dualWindowAutoTargetA, setDualWindowAutoTargetA] = useState("");
  const [dualWindowAutoTargetB, setDualWindowAutoTargetB] = useState("");
  const [dualWindowAutoLabelA, setDualWindowAutoLabelA] = useState("");
  const [dualWindowAutoLabelB, setDualWindowAutoLabelB] = useState("");
  const [dualTextureAReloadToken, setDualTextureAReloadToken] = useState(0);
  const [dualTextureBReloadToken, setDualTextureBReloadToken] = useState(0);
  const [dualBodyColorA, setDualBodyColorA] = useState(() => getInitialDefaults().bodyColor);
  const [dualBodyColorB, setDualBodyColorB] = useState(() => getInitialDefaults().bodyColor);
  const [dualSelectedSlot, setDualSelectedSlot] = useState("A");
  const [dualModelALoading, setDualModelALoading] = useState(false);
  const [dualModelBLoading, setDualModelBLoading] = useState(false);
  const [dualModelAError, setDualModelAError] = useState("");
  const [dualModelBError, setDualModelBError] = useState("");
  const [dualGizmoVisible, setDualGizmoVisible] = useState(true);
  const [dualTextureMode, setDualTextureMode] = useState("livery");

  const [modelLoading, setModelLoading] = useState(false);
  const [viewerReady, setViewerReady] = useState(false);
  const [booted, setBooted] = useState(false);
  const [formatWarning, setFormatWarning] = useState(null); // { type: "16bit-psd", bitDepth: 16 }
  const bootStartRef = useRef(typeof performance !== "undefined" ? performance.now() : Date.now());
  const bootTimerRef = useRef(null);

  const initialStateRestoredRef = useRef(false);

  // Generate Preview state
  const [generatingPreview, setGeneratingPreview] = useState(false);
  const [previewProgress, setPreviewProgress] = useState({ current: 0, total: 0, preset: "" });
  const [previewComplete, setPreviewComplete] = useState(false);
  const [previewOutputPath, setPreviewOutputPath] = useState("");
  const [previewPromptOpen, setPreviewPromptOpen] = useState(false);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [previewZoomDraft, setPreviewZoomDraft] = useState(1);
  const [previewZoomPreview, setPreviewZoomPreview] = useState("");
  const [previewZoomLoading, setPreviewZoomLoading] = useState(false);
  const [dualModelAPos, setDualModelAPos] = useState([0, 0, 0]);
  const [dualModelBPos, setDualModelBPos] = useState([0, 0, 3]);

  // Re-read prefs when settings are saved from the Shell-level SettingsMenu
  useEffect(() => {
    if (!settingsVersion) return;
    const merged = getInitialDefaults();
    setDefaults(merged);
    setLiveryExteriorOnly(Boolean(merged.liveryExteriorOnly));
    setWindowTemplateEnabled(Boolean(merged.windowTemplateEnabled));
    setWindowTextureTarget(merged.windowTextureTarget || "auto");
    setCameraWASD(Boolean(merged.cameraWASD));
    setCameraControlsInPanel(Boolean(merged.cameraControlsInPanel));
    setShowHints(Boolean(merged.showHints ?? true));
    setHideRotText(Boolean(merged.hideRotText));
    setShowGrid(Boolean(merged.showGrid));
    setBodyColor(merged.bodyColor);
    setDualBodyColorA(merged.bodyColor);
    setDualBodyColorB(merged.bodyColor);
    setBackgroundColor(merged.backgroundColor);
    setExperimentalSettings(Boolean(merged.experimentalSettings));
    const hk = getInitialHotkeys();
    setHotkeys(hk);
  }, [settingsVersion]);

  const isBooting = !booted;
  const modelExtensions =
    textureMode === "eup" || textureMode === "multi"
      ? ["yft", "clmesh", "dff", "ydd"]
      : ["yft", "clmesh", "dff"];
  const modelDropLabel = modelExtensions.map((ext) => `.${ext}`).join(" / ");

  const loadModel = useCallback(
    async (path) => {
      if (!path) return;

      setFormatWarning(null);

      const lower = path.toString().toLowerCase();
      if (lower.endsWith(".obj")) {
        setDialogError(
          "out of sheer respect for vehicle devs and those who pour their hearts and souls into their creations, .OBJ files will never be supported.",
        );
        return;
      }

      if (lower.endsWith(".yft") && !lower.endsWith("_hi.yft")) {
        setFormatWarning({ type: "non-hi-model", path: path.split(/[\\/]/).pop() });
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
        // Auto-rename the tab to the loaded filename
        const fileName = path.split(/[\\/]/).pop();
        if (fileName && onRenameTab) onRenameTab(fileName);
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

  const sessionSaveTimerRef = useRef(null);
  useEffect(() => {
    if (isBooting || showOnboarding) return;
    const hasContent = modelPath || dualModelAPath || dualModelBPath || texturePath || dualTextureAPath || dualTextureBPath || dualWindowTextureAPath || dualWindowTextureBPath;
    if (!hasContent) return;

    if (sessionSaveTimerRef.current) clearTimeout(sessionSaveTimerRef.current);
    sessionSaveTimerRef.current = setTimeout(() => {
      const stateSnapshot = {
        textureMode,
        modelPath: modelPath || "",
        modelSourcePath: modelSourcePath || "",
        texturePath: texturePath || "",
        textureTarget,
        windowTexturePath: windowTexturePath || "",
        windowTextureTarget,
        windowTemplateEnabled,
        liveryWindowOverride,
        bodyColor,
        backgroundColor,
        backgroundImagePath,
        showWireframe,
        lightIntensity,
        glossiness,
        liveryExteriorOnly,
        dualBodyColorA,
        dualBodyColorB,
        dualModelAPath: dualModelAPath || "",
        dualModelBPath: dualModelBPath || "",
        dualTextureAPath: dualTextureAPath || "",
        dualTextureBPath: dualTextureBPath || "",
        dualWindowTextureAPath: dualWindowTextureAPath || "",
        dualWindowTextureBPath: dualWindowTextureBPath || "",
        dualWindowTextureATarget,
        dualWindowTextureBTarget,
        dualModelAPos,
        dualModelBPos,
        dualSelectedSlot,
        dualTextureMode,
      };
      // Save to legacy session store
      saveSession(stateSnapshot);
      // Also persist to workspace so recent projects can restore full state
      if (shellTab?.workspaceId) {
        try {
          updateWorkspace(shellTab.workspaceId, { state: stateSnapshot });
        } catch {}
      }
    }, 1000);

    return () => {
      if (sessionSaveTimerRef.current) clearTimeout(sessionSaveTimerRef.current);
    };
  }, [
    isBooting, showOnboarding, textureMode,
    modelPath, modelSourcePath, texturePath, textureTarget, windowTexturePath, windowTextureTarget, windowTemplateEnabled,
    liveryWindowOverride, bodyColor, backgroundColor, backgroundImagePath, showWireframe, lightIntensity, glossiness, liveryExteriorOnly,
    dualBodyColorA, dualBodyColorB,
    dualModelAPath, dualModelBPath, dualTextureAPath, dualTextureBPath,
    dualWindowTextureAPath, dualWindowTextureBPath,
    dualWindowTextureATarget, dualWindowTextureBTarget,
    dualModelAPos, dualModelBPos, dualSelectedSlot, dualTextureMode,
    shellTab,
  ]);

  const scheduleReload = (kind) => {
    const key = kind === "window" ? "window" : "primary";
    const timers = reloadTimerRef.current;
    if (timers[key]) clearTimeout(timers[key]);
    timers[key] = setTimeout(() => {
      if (key === "window") setWindowTextureReloadToken((prev) => prev + 1);
      else setTextureReloadToken((prev) => prev + 1);
    }, 350);
  };

  const scheduleDualReload = (slot) => {
    const key = slot === "B" ? "dualB" : "dualA";
    const timers = reloadTimerRef.current;
    if (timers[key]) clearTimeout(timers[key]);
    timers[key] = setTimeout(() => {
      if (key === "dualB") setDualTextureBReloadToken((prev) => prev + 1);
      else setDualTextureAReloadToken((prev) => prev + 1);
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
    setLiveryWindowOverride((prev) => {
      if (!prev) return prev;
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

  const handleDualModelAInfo = useCallback((info) => {
    const targets = info?.targets ?? [];
    setDualTextureTargetsA(targets);
    setDualWindowAutoTargetA(info?.windowTarget || "");
    setDualWindowAutoLabelA(info?.windowLabel || "");
    setDualWindowTextureATarget((prev) => {
      if (prev === "auto" || prev === "none" || prev === "all") return prev;
      return targets.some((target) => target.value === prev) ? prev : "auto";
    });
  }, []);

  const handleDualModelBInfo = useCallback((info) => {
    const targets = info?.targets ?? [];
    setDualTextureTargetsB(targets);
    setDualWindowAutoTargetB(info?.windowTarget || "");
    setDualWindowAutoLabelB(info?.windowLabel || "");
    setDualWindowTextureBTarget((prev) => {
      if (prev === "auto" || prev === "none" || prev === "all") return prev;
      return targets.some((target) => target.value === prev) ? prev : "auto";
    });
  }, []);

  useEffect(() => {
    setDualWindowTextureATarget((prev) => {
      if (prev === "auto" || prev === "none" || prev === "all") return prev;
      return dualTextureTargetsA.some((target) => target.value === prev) ? prev : "auto";
    });
  }, [dualTextureTargetsA]);

  useEffect(() => {
    setDualWindowTextureBTarget((prev) => {
      if (prev === "auto" || prev === "none" || prev === "all") return prev;
      return dualTextureTargetsB.some((target) => target.value === prev) ? prev : "auto";
    });
  }, [dualTextureTargetsB]);

  const handleTextureError = useCallback((message) => {
    setTextureError(message || "");
    // If texture failed to load, clear the stale path
    if (message) setTexturePath("");
  }, []);

  const handleWindowTextureError = useCallback((message) => {
    setWindowTextureError(message || "");
    // If window texture failed to load, clear the stale path
    if (message) setWindowTexturePath("");
  }, []);

  const handleFormatWarning = useCallback((warning) => {
    setFormatWarning(warning);
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
    setLiveryExteriorOnly(Boolean(merged.liveryExteriorOnly));
    setWindowTemplateEnabled(Boolean(merged.windowTemplateEnabled));
    setWindowTextureTarget(merged.windowTextureTarget || "auto");

    setCameraWASD(Boolean(merged.cameraWASD));
    setCameraControlsInPanel(Boolean(merged.cameraControlsInPanel));
    setShowHints(Boolean(merged.showHints ?? true));
    setHideRotText(Boolean(merged.hideRotText));
    setShowGrid(Boolean(merged.showGrid));
    setBodyColor(merged.bodyColor);
    setDualBodyColorA(merged.bodyColor);
    setDualBodyColorB(merged.bodyColor);
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

  const restoreState = useCallback(async (state) => {
    if (!state) return;

    const fileOk = async (p) => {
      if (!p) return false;
      try { return await fsExists(p); } catch { return false; }
    };

    // Restore non-path settings immediately
    let resolvedTextureMode = state.textureMode;
    if (!resolvedTextureMode && state.openFile) {
      const openFileLower = state.openFile.toLowerCase();
      if (openFileLower.endsWith(".ydd")) {
        resolvedTextureMode = "eup";
      } else if (openFileLower.endsWith(".yft")) {
        resolvedTextureMode = "livery";
      }
    }
    if (resolvedTextureMode) setTextureMode(resolvedTextureMode);
    if (state.textureTarget) setTextureTarget(state.textureTarget);
    if (state.windowTextureTarget) setWindowTextureTarget(state.windowTextureTarget);
    if (typeof state.liveryWindowOverride === "string") setLiveryWindowOverride(state.liveryWindowOverride);
    if (typeof state.windowTemplateEnabled === "boolean") setWindowTemplateEnabled(state.windowTemplateEnabled);
    if (state.bodyColor) setBodyColor(state.bodyColor);
    if (state.dualBodyColorA) setDualBodyColorA(state.dualBodyColorA);
    else if (state.bodyColor) setDualBodyColorA(state.bodyColor);
    if (state.dualBodyColorB) setDualBodyColorB(state.dualBodyColorB);
    else if (state.bodyColor) setDualBodyColorB(state.bodyColor);
    if (state.backgroundColor) setBackgroundColor(state.backgroundColor);
    if (typeof state.showWireframe === "boolean") setShowWireframe(state.showWireframe);
    if (typeof state.lightIntensity === "number") setLightIntensity(state.lightIntensity);
    if (typeof state.glossiness === "number") setGlossiness(state.glossiness);
    if (typeof state.liveryExteriorOnly === "boolean") setLiveryExteriorOnly(state.liveryExteriorOnly);
    if (state.dualSelectedSlot) setDualSelectedSlot(state.dualSelectedSlot);
    if (state.dualTextureMode) setDualTextureMode(state.dualTextureMode);
    if (state.dualWindowTextureATarget) setDualWindowTextureATarget(state.dualWindowTextureATarget);
    if (state.dualWindowTextureBTarget) setDualWindowTextureBTarget(state.dualWindowTextureBTarget);
    if (state.dualModelAPos) setDualModelAPos(state.dualModelAPos);
    if (state.dualModelBPos) setDualModelBPos(state.dualModelBPos);

    // Restore file paths (best effort). Some environments can report false negatives
    // on fs existence checks for previously approved paths.
    const initialModelPath = state.modelSourcePath || state.modelPath || state.openFile || "";
    if (initialModelPath) {
      await loadModel(initialModelPath);
    }
    if (state.texturePath && (await fileOk(state.texturePath))) setTexturePath(state.texturePath);
    else if (state.texturePath) setTexturePath(state.texturePath);
    if (state.backgroundImagePath && (await fileOk(state.backgroundImagePath))) setBackgroundImagePath(state.backgroundImagePath);
    else if (state.backgroundImagePath) setBackgroundImagePath(state.backgroundImagePath);
    if (state.windowTexturePath && (await fileOk(state.windowTexturePath))) setWindowTexturePath(state.windowTexturePath);
    else if (state.windowTexturePath) setWindowTexturePath(state.windowTexturePath);
    if (state.dualModelAPath && (await fileOk(state.dualModelAPath))) setDualModelAPath(state.dualModelAPath);
    else if (state.dualModelAPath) setDualModelAPath(state.dualModelAPath);
    if (state.dualModelBPath && (await fileOk(state.dualModelBPath))) setDualModelBPath(state.dualModelBPath);
    else if (state.dualModelBPath) setDualModelBPath(state.dualModelBPath);
    if (state.dualTextureAPath && (await fileOk(state.dualTextureAPath))) setDualTextureAPath(state.dualTextureAPath);
    else if (state.dualTextureAPath) setDualTextureAPath(state.dualTextureAPath);
    if (state.dualTextureBPath && (await fileOk(state.dualTextureBPath))) setDualTextureBPath(state.dualTextureBPath);
    else if (state.dualTextureBPath) setDualTextureBPath(state.dualTextureBPath);
    if (state.dualWindowTextureAPath && (await fileOk(state.dualWindowTextureAPath))) setDualWindowTextureAPath(state.dualWindowTextureAPath);
    else if (state.dualWindowTextureAPath) setDualWindowTextureAPath(state.dualWindowTextureAPath);
    if (state.dualWindowTextureBPath && (await fileOk(state.dualWindowTextureBPath))) setDualWindowTextureBPath(state.dualWindowTextureBPath);
    else if (state.dualWindowTextureBPath) setDualWindowTextureBPath(state.dualWindowTextureBPath);
  }, [loadModel]);

  // Auto-restore workspace state from initialState prop (passed by Shell from workspace)
  useEffect(() => {
    if (initialStateRestoredRef.current) return;
    if (!initialState) return;
    initialStateRestoredRef.current = true;
    restoreState(initialState);
  }, [initialState, restoreState]);

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
        if (textureMode === "multi") {
          if (dualSelectedSlot === "A") {
            setDualModelAError("");
            setDualModelAPath(selected);
          } else {
            setDualModelBError("");
            setDualModelBPath(selected);
          }
        } else {
          await loadModel(selected);
        }
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
              "pdn",
            ],
          },
        ],
      });
      setDialogError("");
      if (typeof selected === "string") {
        if (!isTextureFormatSupported(selected)) {
          setFormatWarning({ type: "unsupported-format", ext: getFileExtension(selected), path: selected.split(/[\\/]/).pop() });
          return;
        }
        setTextureError("");
        setTexturePath(selected);
      }
    } catch (error) {
      setDialogError("Dialog permission blocked. Check Tauri capabilities.");
      console.error(error);
    }
  };

  // Window controls are handled by Shell

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
              "pdn",
            ],
          },
        ],
      });
      setDialogError("");
      if (typeof selected === "string") {
        if (!isTextureFormatSupported(selected)) {
          setFormatWarning({ type: "unsupported-format", ext: getFileExtension(selected), path: selected.split(/[\\/]/).pop() });
          return;
        }
        if (textureMode === "multi") {
          if (dualSelectedSlot === "A") setDualWindowTextureAPath(selected);
          else setDualWindowTextureBPath(selected);
          return;
        }
        setWindowTextureError("");
        setWindowTexturePath(selected);
      }
    } catch (error) {
      setDialogError("Dialog permission blocked. Check Tauri capabilities.");
      console.error(error);
    }
  };

  const selectBackgroundImage = async () => {
    if (!isTauriRuntime) {
      setDialogError("Tauri runtime required for file dialog.");
      return;
    }
    try {
      const selected = await open({
        filters: [
          {
            name: "Background Image",
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
              "pdn",
            ],
          },
        ],
      });
      setDialogError("");
      if (typeof selected === "string") {
        if (!isTextureFormatSupported(selected)) {
          setFormatWarning({ type: "unsupported-format", ext: getFileExtension(selected), path: selected.split(/[\\/]/).pop() });
          return;
        }
        setBackgroundImagePath((prev) => {
          if (prev === selected) {
            setBackgroundImageReloadToken((token) => token + 1);
          }
          return selected;
        });
      }
    } catch (error) {
      setDialogError("Dialog permission blocked. Check Tauri capabilities.");
      console.error(error);
    }
  };

  const modelExtsDual = ["yft", "clmesh", "dff", "ydd"];
  const textureExtsDual = ["png", "jpg", "jpeg", "webp", "avif", "bmp", "gif", "tga", "dds", "tif", "tiff", "psd", "ai", "pdn"];

  // Material texture upload handler
  const selectMaterialTexture = async () => {
    if (!isTauriRuntime) return;
    try {
      const selected = await open({
        multiple: true,
        filters: [{ name: "Texture", extensions: ["png", "jpg", "jpeg", "webp", "dds", "tga", "tif", "tiff", "psd", "bmp"] }],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const newTextures = paths.map((p) => ({
        id: `mat-tex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: p.split(/[\\/]/).pop(),
        path: p,
        thumbnail: null,
      }));
      setMaterialTextures((prev) => [...prev, ...newTextures].slice(0, 6));
    } catch { /* dialog blocked */ }
  };

  const removeMaterialTexture = useCallback((index) => {
    setMaterialTextures((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const selectDualModel = async (slot) => {
    if (!isTauriRuntime) return;
    try {
      const selected = await open({ filters: [{ name: "Model", extensions: modelExtsDual }] });
      if (typeof selected === "string") {
        if (slot === "A") { setDualModelAError(""); setDualModelAPath(selected); }
        else { setDualModelBError(""); setDualModelBPath(selected); }
      }
    } catch { /* dialog blocked */ }
  };

  const selectDualTexture = async (slot) => {
    if (!isTauriRuntime) return;
    try {
      const selected = await open({ filters: [{ name: "Texture", extensions: textureExtsDual }] });
      if (typeof selected === "string") {
        if (!isTextureFormatSupported(selected)) {
          setFormatWarning({ type: "unsupported-format", ext: getFileExtension(selected), path: selected.split(/[\\/]/).pop() });
          return;
        }
        if (slot === "A") setDualTextureAPath(selected);
        else setDualTextureBPath(selected);
      }
    } catch { /* dialog blocked */ }
  };

  selectModelRef.current = selectModel;
  selectTextureRef.current = selectTexture;
  selectWindowTextureRef.current = selectWindowTexture;

  useEffect(() => {
    const handleKeyDown = (event) => {
      const target = event.target;
      if (target instanceof Element) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (target.isContentEditable) return;
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
        // Mode switching removed — handled by Shell via new-tab hotkeys
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
        case HOTKEY_ACTIONS.TOGGLE_DUAL_GIZMO:
          setDualGizmoVisible((prev) => !prev);
          break;
        case HOTKEY_ACTIONS.SWAP_DUAL_SLOT:
          setDualSelectedSlot((prev) => (prev === "A" ? "B" : "A"));
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hotkeys, experimentalSettings]);

  const handleCenterCamera = () => {
    viewerApiRef.current?.reset?.();
  };

  const resolveExistingFolder = useCallback(async (preferredPath, fallbackPath = "") => {
    if (!isTauriRuntime) return preferredPath || fallbackPath;
    const candidates = [];
    if (preferredPath) {
      candidates.push(preferredPath);
      const trimmed = preferredPath.replace(/[\\/]+$/, "");
      const parent = trimmed.replace(/[\\/][^\\/]+$/, "");
      if (parent && parent !== trimmed) candidates.push(parent);
    }
    if (fallbackPath) candidates.push(fallbackPath);

    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        const ok = await fsExists(candidate);
        if (ok) return candidate;
      } catch {
        // keep trying remaining candidates
      }
    }

    return preferredPath || fallbackPath;
  }, [isTauriRuntime]);

  const previewSnapTokenRef = useRef(0);
  const updatePreviewSnapshot = useCallback(async (zoomLevel) => {
    if (!viewerApiRef.current || !viewerReady) return;
    previewSnapTokenRef.current += 1;
    const token = previewSnapTokenRef.current;
    setPreviewZoomLoading(true);
    try {
      viewerApiRef.current.setPreset("angle");
      viewerApiRef.current.setZoom?.(zoomLevel);
      await new Promise((r) => setTimeout(r, 120));
      if (token !== previewSnapTokenRef.current) return;
      const dataUrl = viewerApiRef.current.captureScreenshot?.();
      if (token !== previewSnapTokenRef.current) return;
      setPreviewZoomPreview(dataUrl || "");
    } finally {
      if (token === previewSnapTokenRef.current) setPreviewZoomLoading(false);
    }
  }, [viewerReady]);

  // Generate Preview — cycle through camera presets and capture screenshots
  const handleGeneratePreview = useCallback(async (zoomLevel = 1) => {
    if (!viewerApiRef.current || !modelPath || generatingPreview) return;

    // Get preview folder from prefs or prompt
    const prefs = loadPrefs() || {};
    let folder = prefs?.defaults?.previewFolder;

    if (!folder && isTauriRuntime) {
      try {
        const selected = await open({ directory: true, title: "Select Preview Export Folder" });
        if (typeof selected === "string") {
          folder = selected;
          const current = loadPrefs() || {};
          const defs = current?.defaults || {};
          savePrefs({ ...current, defaults: { ...defs, previewFolder: folder } });
        }
      } catch {}
    }

    if (!folder) return;

    const presetKeys = ["front", "back", "side", "angle", "top"];
    const presetLabels = { front: "Front", back: "Back", side: "Side", angle: "3-4 Angle", top: "Top" };
    const modelName = modelPath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "preview";

    // Create a subfolder named after the model to keep exports tidy
    const modelFolder = `${folder}/${modelName}`;
    let outputFolder = modelFolder;
    if (isTauriRuntime) {
      try { await invoke("ensure_dir", { path: modelFolder }); } catch {
        // If ensure_dir command doesn't exist, try mkdir via writeFile workaround
        // Tauri's writeFile will create the file, the folder must exist.
        // Fall back to the base folder if subfolder creation fails.
        outputFolder = folder;
      }

      try {
        const subfolderExists = await fsExists(modelFolder);
        if (!subfolderExists) outputFolder = folder;
      } catch {
        outputFolder = folder;
      }
    }

    // Temporarily disable grid for clean screenshots
    const gridWasOn = showGrid;
    if (gridWasOn) setShowGrid(false);

    setGeneratingPreview(true);
    setPreviewProgress({ current: 0, total: presetKeys.length, preset: "" });
    setPreviewOutputPath(outputFolder);

    // Wait a frame for grid to disappear if it was on
    if (gridWasOn) await new Promise((r) => setTimeout(r, 100));

    try {
      for (let i = 0; i < presetKeys.length; i++) {
        const preset = presetKeys[i];
        setPreviewProgress({ current: i, total: presetKeys.length, preset: presetLabels[preset] || preset });

        viewerApiRef.current.setPreset(preset);
        viewerApiRef.current.setZoom?.(zoomLevel);
        await new Promise((r) => setTimeout(r, 400));

        const dataUrl = viewerApiRef.current.captureScreenshot();
        if (!dataUrl) continue;

        const base64 = dataUrl.split(",")[1];
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let j = 0; j < binary.length; j++) {
          bytes[j] = binary.charCodeAt(j);
        }

        const fileName = `${modelName}_${preset}.png`;
        // Try model subfolder first, fall back to base folder
        const filePath = `${outputFolder}/${fileName}`;
        if (isTauriRuntime) {
          try {
            await writeFile(filePath, bytes);
          } catch {
            // Subfolder might not exist — write to base folder instead
            await writeFile(`${folder}/${fileName}`, bytes);
            outputFolder = folder;
          }
        }
      }

      const resolvedOutputFolder = await resolveExistingFolder(outputFolder, folder);
      setPreviewOutputPath(resolvedOutputFolder);
      setPreviewProgress({ current: presetKeys.length, total: presetKeys.length, preset: "Complete" });
      setGeneratingPreview(false);
      setPreviewComplete(true);
    } catch (err) {
      console.error("Generate preview failed:", err);
      setGeneratingPreview(false);
    } finally {
      // Restore grid state
      if (gridWasOn) setShowGrid(true);
    }
  }, [modelPath, generatingPreview, isTauriRuntime, showGrid, resolveExistingFolder]);

  useEffect(() => {
    if (!previewPromptOpen) return;
    const timer = setTimeout(() => {
      updatePreviewSnapshot(previewZoomDraft);
    }, 120);
    return () => clearTimeout(timer);
  }, [previewPromptOpen, previewZoomDraft, updatePreviewSnapshot]);


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
    const modelFiles = files.filter((file) => {
      const name = file.name?.toLowerCase();
      return modelExtensions.some((ext) => name?.endsWith(`.${ext}`));
    });
    const modelFile = modelFiles[0];

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

    if (textureMode === "multi") {
      if (modelFiles.length >= 2) {
        const [first, second] = modelFiles;
        if (!first?.path || !second?.path) {
          setDialogError("Unable to read dropped model paths.");
          return;
        }
        setDualModelAError("");
        setDualModelBError("");
        setDualModelAPath(first.path);
        setDualModelBPath(second.path);
        return;
      }

      if (dualSelectedSlot === "A") {
        setDualModelAError("");
        setDualModelAPath(modelFile.path);
      } else {
        setDualModelBError("");
        setDualModelBPath(modelFile.path);
      }
      return;
    }

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

      const isMulti = textureMode === "multi";

      if (isMulti) {
        // Ensure legacy single-template watchers are stopped so they don't fight over state.
        await invoke("stop_watch").catch(() => null);
        await invoke("stop_window_watch").catch(() => null);

        const aPath = dualTextureAPath;
        const bPath = dualTextureBPath;
        const paths = [aPath, bPath].filter(Boolean);

        if (!paths.length) {
          await invoke("stop_multi_watch").catch(() => null);
          if (!cancelled) setWatchStatus("idle");
          return;
        }

        const ok = await invoke("start_multi_watch", { paths }).then(
          () => true,
          () => false,
        );

        if (!cancelled) setWatchStatus(ok ? "watching" : "error");

        unlisten = await listen("texture:update", (event) => {
          const changedPath = normalizePath(event?.payload?.path);
          const aNorm = normalizePath(aPath);
          const bNorm = normalizePath(bPath);
          if (!aNorm && !bNorm) return;

          if (!changedPath) {
            scheduleDualReload("A");
            scheduleDualReload("B");
            return;
          }

          if (aNorm && changedPath === aNorm) scheduleDualReload("A");
          if (bNorm && changedPath === bNorm) scheduleDualReload("B");
        });

        return;
      }

      // Non-multi (single viewer) mode
      await invoke("stop_multi_watch").catch(() => null);

      const primaryPath = texturePath;
      const secondaryPath = windowTemplateEnabled ? windowTexturePath : "";

      const wantsPrimary = Boolean(primaryPath);
      const wantsSecondary = Boolean(secondaryPath);

      if (!wantsPrimary) await invoke("stop_watch").catch(() => null);
      if (!wantsSecondary) await invoke("stop_window_watch").catch(() => null);

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

      if (!cancelled) setWatchStatus(primaryOk && secondaryOk ? "watching" : "error");

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
      if (unlisten) unlisten();
      if (isTauriRuntime) {
        invoke("stop_watch").catch(() => null);
        invoke("stop_window_watch").catch(() => null);
        invoke("stop_multi_watch").catch(() => null);
      }
    };
  }, [textureMode, texturePath, windowTexturePath, windowTemplateEnabled, dualTextureAPath, dualTextureBPath]);

  const onTextureReload = useCallback(() => {
    setLastUpdate(new Date().toLocaleTimeString());
  }, []);

  const resolvedTextureTarget =
    textureMode === "livery" ? liveryTarget || "all" : textureTarget;
  const resolvedWindowBaseTarget =
    windowTextureTarget === "auto"
      ? windowLiveryTarget || "none"
      : windowTextureTarget || "none";
  const resolvedWindowTextureTarget =
    textureMode === "livery"
      ? liveryWindowOverride || resolvedWindowBaseTarget
      : resolvedWindowBaseTarget;
  const resolvedDualWindowTextureATarget =
    dualWindowTextureATarget === "auto"
      ? dualWindowAutoTargetA || "none"
      : dualWindowTextureATarget || "none";
  const resolvedDualWindowTextureBTarget =
    dualWindowTextureBTarget === "auto"
      ? dualWindowAutoTargetB || "none"
      : dualWindowTextureBTarget || "none";
  const selectedDualTargets = dualSelectedSlot === "A" ? dualTextureTargetsA : dualTextureTargetsB;
  const selectedDualWindowAutoTarget = dualSelectedSlot === "A" ? dualWindowAutoTargetA : dualWindowAutoTargetB;
  const selectedDualWindowAutoLabel = dualSelectedSlot === "A" ? dualWindowAutoLabelA : dualWindowAutoLabelB;
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

  const modeLabels = { livery: "Livery", everything: "All", eup: "EUP", multi: "Multi" };
  const currentModeLabel = modeLabels[textureMode] || "Preview";

  return (
    <motion.div
      className={`app-shell ${panelCollapsed ? "is-panel-collapsed" : ""}`}
      initial={{ opacity: 0, y: 6 }}
      animate={isBooting ? { opacity: 0, y: 6 } : { opacity: 1, y: 0 }}
      transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
      style={{ pointerEvents: isBooting ? "none" : "auto" }}
    >
      {/* ── Row 2 Portal: Context Bar ── */}
      {isActive && contextBarTarget && createPortal(
        <div className="ctx-bar-inner">
          <div className="ctx-bar-left">
            <button
              type="button"
              className="ctx-bar-toggle"
              onClick={() => setPanelCollapsed((prev) => !prev)}
              title={panelCollapsed ? "Show panel" : "Hide panel"}
            >
              <PanelLeft className="w-3.5 h-3.5" />
            </button>
            <div className="ctx-bar-sep" />
            <span className="ctx-bar-badge" style={{ color: textureMode === "livery" ? "var(--mg-primary)" : textureMode === "eup" ? "oklch(0.714 0.203 305.504)" : textureMode === "multi" ? "var(--mg-primary)" : "var(--es-success)" }}>
              {currentModeLabel}
            </span>
            {modelPath && (
              <>
                <div className="ctx-bar-sep" />
                <span className="ctx-bar-file" title={modelSourcePath || modelPath}>
                  {modelLabel}
                </span>
              </>
            )}
            <div className="ctx-bar-sep" />
            <span className={`ctx-bar-dot ${watchStatus === "watching" ? "is-watching" : watchStatus === "error" ? "is-error" : ""}`} />
            <span className="ctx-bar-status-text">
              {watchStatus === "watching" ? "Watching" : watchStatus === "error" ? "Error" : "Idle"}
            </span>
          </div>

          <div className="ctx-bar-center">
            {textureMode !== "multi" && (
              <>
                {!cameraControlsInPanel && (
                  <>
                    <span className="ctx-bar-group-label">Camera</span>
                    <button type="button" className="ctx-bar-btn" onClick={() => viewerApiRef.current?.setPreset("front")} title="Front view">Front</button>
                    <button type="button" className="ctx-bar-btn" onClick={() => viewerApiRef.current?.setPreset("back")} title="Rear view">Back</button>
                    <button type="button" className="ctx-bar-btn" onClick={() => viewerApiRef.current?.setPreset("side")} title="Side view">Side</button>
                    <button type="button" className="ctx-bar-btn" onClick={() => viewerApiRef.current?.setPreset("angle")} title="3/4 angle view">3/4</button>
                    <button type="button" className="ctx-bar-btn" onClick={() => viewerApiRef.current?.setPreset("top")} title="Top-down view">Top</button>
                    <div className="ctx-bar-sep" />
                    <button type="button" className="ctx-bar-btn ctx-bar-action" onClick={handleCenterCamera} disabled={!viewerReady} title="Re-center camera on model">
                      <RotateCcw className="w-3 h-3" style={{ marginRight: 3 }} />Center
                    </button>
                    <div className="ctx-bar-sep" />
                    <span className="ctx-bar-group-label">Rotate</span>
                    <button type="button" className="ctx-bar-btn ctx-bar-axis" onClick={() => viewerApiRef.current?.rotateModel("x")} title="Rotate 90° on X axis">
                      <span style={{ color: "#f87171" }}>X</span>
                    </button>
                    <button type="button" className="ctx-bar-btn ctx-bar-axis" onClick={() => viewerApiRef.current?.rotateModel("y")} title="Rotate 90° on Y axis">
                      <span style={{ color: "#4ade80" }}>Y</span>
                    </button>
                    <button type="button" className="ctx-bar-btn ctx-bar-axis" onClick={() => viewerApiRef.current?.rotateModel("z")} title="Rotate 90° on Z axis">
                      <span style={{ color: "#60a5fa" }}>Z</span>
                    </button>
                    <div className="ctx-bar-sep" />
                  </>
                )}
              </>
            )}
          </div>

          <div className="ctx-bar-right">
          </div>
        </div>,
        contextBarTarget
      )}

      <CyberPanel collapsed={panelCollapsed} isBooting={isBooting} statusBar={
        <div className="cs-status-bar">
          <div className="cs-status-left">
            <span className={watchStatus === "watching" ? "status-dot" : "cs-status-dot-idle"} style={watchStatus === "error" ? { background: "#ef4444" } : {}} />
            <span className="cs-status-text">
              {watchStatus === "watching"
                ? "Watching"
                : watchStatus === "error"
                  ? "Watcher error"
                  : "Idle"}
            </span>
            {watchStatus === "watching" && texturePath && (
              <span className="cs-status-file" title={texturePath}>
                {texturePath.split(/[\\/]/).pop()}
              </span>
            )}
          </div>
          <span className="cs-status-timestamp">{lastUpdate}</span>
        </div>
      }>
          {textureMode !== "multi" ? (
            <CyberSection
              title="Model"
              caption={modelLabel}
              open={panelOpen.model}
              onToggle={() => togglePanel("model")}
              contentId="panel-model"
              icon={Car}
              color="blue"
            >
              <div className="flex flex-col gap-0">
                <div className="flex gap-0">
                  <CyberButton
                    onClick={selectModel}
                    variant="blue"
                    className={modelPath ? "flex-1 rounded-none border-b-0" : "w-full"}
                  >
                    Select Model
                  </CyberButton>
                  {modelPath ? (
                    <UnloadButton
                      className="flex-1 rounded-none border-b-0 border-l-0"
                      onClick={() => { setModelPath(""); setModelError(""); }}
                      title="Unload model"
                    />
                  ) : null}
                </div>
                {modelPath ? (
                  <div className="px-2 py-1 bg-[var(--mg-surface)] border border-[var(--mg-border)] border-t-0 rounded-[var(--mg-radius)] text-[9px] font-mono text-[var(--mg-muted)] truncate">
                    {getFileLabel(modelPath, "")}
                  </div>
                ) : null}
                {modelLoading ? <div className="text-[10px] text-[var(--mg-primary)] animate-pulse mt-2">Initializing construct...</div> : null}
              </div>
            </CyberSection>
          ) : null}

          {textureMode === "livery" ? (
            <div className="space-y-4" id="mode-panel-livery" role="tabpanel">
              <CyberSection
                title="Livery"
                caption={primaryTemplateLabel}
                open={panelOpen.templates}
                onToggle={() => togglePanel("templates")}
                contentId="panel-templates"
                icon={Layers}
                color="blue"
              >
                <div className="flex flex-col gap-0">
                    <div className="flex gap-0">
                      <CyberButton
                        onClick={selectTexture}
                        variant="blue"
                        className={texturePath ? "flex-1 rounded-none border-b-0" : "w-full"}
                      >
                        Select Livery
                      </CyberButton>
                      {texturePath ? (
                        <UnloadButton
                          className="flex-1 rounded-none border-b-0 border-l-0"
                          onClick={() => setTexturePath("")}
                          title="Unload texture"
                        />
                      ) : null}
                    </div>
                    {texturePath ? (
                      <div className="px-2 py-1 bg-[var(--mg-surface)] border border-[var(--mg-border)] border-t-0 rounded-[var(--mg-radius)] text-[9px] font-mono text-[var(--mg-muted)] truncate">
                        {getFileLabel(texturePath, "")}
                      </div>
                    ) : null}
                </div>
                <CyberCard className="mt-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[9px] uppercase text-[var(--mg-primary)] shrink-0">Target</span>
                    <span className="px-1 py-0.5 bg-[oklch(0.648_0.116_182.503_/_0.2)] text-[var(--mg-primary)] rounded text-[8px] shrink-0">AUTO</span>
                    <span className="font-mono text-[10px] text-[var(--mg-muted)] truncate min-w-0">{liveryStatusLabel}</span>
                  </div>
                  <div className="text-[9px] text-[var(--mg-primary)]/50 mt-1 leading-tight">{liveryHint}</div>
                </CyberCard>
              </CyberSection>

              <CyberSection
                title="Glass Overlay"
                caption={overlayLabel}
                open={panelOpen.overlays}
                onToggle={() => togglePanel("overlays")}
                contentId="panel-overlays"
                icon={Disc}
                color="blue"
              >
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <CyberLabel className="mb-0">Enabled</CyberLabel>
                    <button
                      type="button"
                      className={`w-8 h-4 rounded-none border border-[var(--mg-border)] relative transition-colors ${windowTemplateEnabled ? "bg-[oklch(0.648_0.116_182.503_/_0.2)] border-[oklch(0.648_0.116_182.503_/_0.5)]" : "bg-[var(--mg-bg)]"}`}
                      onClick={() => setWindowTemplateEnabled((prev) => !prev)}
                    >
                      <div className={`absolute top-0.5 left-0.5 w-2.5 h-2.5 rounded-none bg-[var(--mg-muted)] transition-transform ${windowTemplateEnabled ? "translate-x-4 bg-[var(--mg-primary)]" : ""}`} />
                    </button>
                  </div>
                  {windowTemplateEnabled ? (
                    <>
                      <div className="flex flex-col gap-0">
                        <div className="flex gap-0">
                          <CyberButton
                            onClick={selectWindowTexture}
                            variant="blue"
                            className={windowTexturePath ? "flex-1 rounded-none border-b-0" : "w-full"}
                          >
                            Select Glass
                          </CyberButton>
                          {windowTexturePath ? (
                            <UnloadButton
                              className="flex-1 rounded-none border-b-0 border-l-0"
                              onClick={() => setWindowTexturePath("")}
                              title="Unload window template"
                            />
                          ) : null}
                        </div>
                        {windowTexturePath ? (
                          <div className="px-2 py-1 bg-[var(--mg-surface)] border border-[var(--mg-border)] border-t-0 rounded-[var(--mg-radius)] text-[9px] font-mono text-[var(--mg-muted)] truncate">
                            {getFileLabel(windowTexturePath, "")}
                          </div>
                        ) : null}
                      </div>
                      <div className="mt-1">
                        <CyberLabel>Override Target</CyberLabel>
                        <Select value={liveryWindowOverride || "auto"} onValueChange={(val) => setLiveryWindowOverride(val === "auto" ? "" : val)}>
                          <SelectTrigger className="w-full h-8 text-xs bg-[var(--mg-bg)] border-[var(--mg-border)] text-[var(--mg-muted)]">
                            <SelectValue placeholder="Select target" />
                          </SelectTrigger>
                          <SelectContent className="bg-[var(--mg-bg)] border-[var(--mg-border)] text-[var(--mg-muted)]">
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
                      </div>
                    </>
                  ) : (
                    <div className="text-[9px] text-[var(--mg-primary)]/50">Enable to apply a glass texture overlay.</div>
                  )}
                </div>
              </CyberSection>

              <CyberSection
                title="Visibility"
                caption={viewLabel}
                open={panelOpen.view}
                onToggle={() => togglePanel("view")}
                contentId="panel-visibility"
                icon={Eye}
                color="blue"
              >
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <CyberLabel className="mb-0">Exterior Only</CyberLabel>
                    <button
                      type="button"
                      className={`w-8 h-4 rounded-none border border-[var(--mg-border)] relative transition-colors ${liveryExteriorOnly ? "bg-[oklch(0.648_0.116_182.503_/_0.2)] border-[oklch(0.648_0.116_182.503_/_0.5)]" : "bg-[var(--mg-bg)]"}`}
                      onClick={() => setLiveryExteriorOnly((prev) => !prev)}
                    >
                      <div className={`absolute top-0.5 left-0.5 w-2.5 h-2.5 rounded-none bg-[var(--mg-muted)] transition-transform ${liveryExteriorOnly ? "translate-x-4 bg-[var(--mg-primary)]" : ""}`} />
                    </button>
                  </div>
                  <div className="text-[9px] text-[var(--mg-primary)]/50">Hides interior, glass, and wheel meshes.</div>
                </div>
              </CyberSection>
            </div>
          ) : null}

          {textureMode === "everything" ? (
            <div className="space-y-4" id="mode-panel-everything" role="tabpanel">
              <CyberSection
                title="Texture"
                caption={primaryTemplateLabel}
                open={panelOpen.templates}
                onToggle={() => togglePanel("templates")}
                contentId="panel-templates"
                icon={Layers}
                color="blue"
              >
                <div className="flex flex-col gap-0">
                    <div className="flex gap-0">
                      <CyberButton
                        onClick={selectTexture}
                        variant="blue"
                        className={texturePath ? "flex-1 rounded-none border-b-0" : "w-full"}
                      >
                        Select Texture
                      </CyberButton>
                      {texturePath ? (
                        <UnloadButton
                          className="flex-1 rounded-none border-b-0 border-l-0"
                          onClick={() => setTexturePath("")}
                          title="Unload texture"
                        />
                      ) : null}
                    </div>
                    {texturePath ? (
                      <div className="px-2 py-1 bg-[var(--mg-surface)] border border-[var(--mg-border)] border-t-0 rounded-[var(--mg-radius)] text-[9px] font-mono text-[var(--mg-muted)] truncate">
                        {getFileLabel(texturePath, "")}
                      </div>
                    ) : null}
                </div>
                <CyberCard className="mt-2">
                  <CyberLabel>Apply To</CyberLabel>
                  <Select value={textureTarget} onValueChange={setTextureTarget}>
                    <SelectTrigger className="w-full h-8 text-xs bg-[var(--mg-bg)] border-[var(--mg-border)] text-[var(--mg-muted)]">
                      <SelectValue placeholder="Select target" />
                    </SelectTrigger>
                    <SelectContent className="bg-[var(--mg-bg)] border-[var(--mg-border)] text-[var(--mg-muted)]">
                      <SelectItem value="all">All meshes</SelectItem>
                      {textureTargets.map((target) => (
                        <SelectItem key={target.value} value={target.value}>
                          {target.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </CyberCard>
              </CyberSection>

              <CyberSection
                title="Overlay"
                caption={overlayLabel}
                open={panelOpen.overlays}
                onToggle={() => togglePanel("overlays")}
                contentId="panel-overlays"
                icon={Disc}
                color="blue"
              >
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <CyberLabel className="mb-0">Secondary Texture</CyberLabel>
                    <button
                      type="button"
                      className={`w-8 h-4 rounded-none border border-[var(--mg-border)] relative transition-colors ${windowTemplateEnabled ? "bg-[oklch(0.648_0.116_182.503_/_0.2)] border-[oklch(0.648_0.116_182.503_/_0.5)]" : "bg-[var(--mg-bg)]"}`}
                      onClick={() => setWindowTemplateEnabled((prev) => !prev)}
                    >
                      <div className={`absolute top-0.5 left-0.5 w-2.5 h-2.5 rounded-none bg-[var(--mg-muted)] transition-transform ${windowTemplateEnabled ? "translate-x-4 bg-[var(--mg-primary)]" : ""}`} />
                    </button>
                  </div>
                  {windowTemplateEnabled ? (
                    <>
                        <div className="flex flex-col gap-0">
                          <div className="flex gap-0">
                            <CyberButton
                              onClick={selectWindowTexture}
                              variant="blue"
                              className={windowTexturePath ? "flex-1 rounded-none border-b-0" : "w-full"}
                            >
                              Select Secondary
                            </CyberButton>
                            {windowTexturePath ? (
                              <UnloadButton
                                className="flex-1 rounded-none border-b-0 border-l-0"
                                onClick={() => setWindowTexturePath("")}
                                title="Unload secondary texture"
                              />
                            ) : null}
                          </div>
                          {windowTexturePath ? (
                            <div className="px-2 py-1 bg-[var(--mg-surface)] border border-[var(--mg-border)] border-t-0 rounded-[var(--mg-radius)] text-[9px] font-mono text-[var(--mg-muted)] truncate">
                              {getFileLabel(windowTexturePath, "")}
                            </div>
                          ) : null}
                        </div>
                      <Select value={windowTextureTarget} onValueChange={setWindowTextureTarget}>
                        <SelectTrigger className="w-full h-8 text-xs bg-[var(--mg-bg)] border-[var(--mg-border)] text-[var(--mg-muted)]">
                          <SelectValue placeholder="Select target" />
                        </SelectTrigger>
                        <SelectContent className="bg-[var(--mg-bg)] border-[var(--mg-border)] text-[var(--mg-muted)]">
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
                    </>
                  ) : (
                    <div className="text-[9px] text-[var(--mg-primary)]/50">Enable to overlay a secondary texture.</div>
                  )}
                </div>
              </CyberSection>
            </div>
          ) : null}

          {textureMode === "eup" ? (
            <div className="space-y-4" id="mode-panel-eup" role="tabpanel">
              <CyberSection
                title="Uniform"
                caption={primaryTemplateLabel}
                open={panelOpen.templates}
                onToggle={() => togglePanel("templates")}
                contentId="panel-templates"
                icon={Layers}
                color="blue"
              >
                <div className="flex flex-col gap-0">
                    <div className="flex gap-0">
                      <CyberButton
                        onClick={selectTexture}
                        variant="blue"
                        className={texturePath ? "flex-1 rounded-none border-b-0" : "w-full"}
                      >
                        Select Uniform
                      </CyberButton>
                      {texturePath ? (
                        <UnloadButton
                          className="flex-1 rounded-none border-b-0 border-l-0"
                          onClick={() => setTexturePath("")}
                          title="Unload texture"
                        />
                      ) : null}
                    </div>
                    {texturePath ? (
                      <div className="px-2 py-1 bg-[var(--mg-surface)] border border-[var(--mg-border)] border-t-0 rounded-[var(--mg-radius)] text-[9px] font-mono text-[var(--mg-muted)] truncate">
                        {getFileLabel(texturePath, "")}
                      </div>
                    ) : null}
                </div>
                <CyberCard className="mt-2">
                  <CyberLabel>Apply To</CyberLabel>
                  <Select value={textureTarget} onValueChange={setTextureTarget}>
                    <SelectTrigger className="w-full h-8 text-xs bg-[var(--mg-bg)] border-[var(--mg-border)] text-[var(--mg-muted)]">
                      <SelectValue placeholder="Select target" />
                    </SelectTrigger>
                    <SelectContent className="bg-[var(--mg-bg)] border-[var(--mg-border)] text-[var(--mg-muted)]">
                      <SelectItem value="all">All meshes</SelectItem>
                      {textureTargets.map((target) => (
                        <SelectItem key={target.value} value={target.value}>
                          {target.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </CyberCard>
              </CyberSection>
            </div>
          ) : null}

          {textureMode === "multi" ? (
            <div className="space-y-4" id="mode-panel-multi" role="tabpanel">
              <div className="flex bg-[var(--mg-bg)] p-1 border border-[var(--mg-border)] rounded-none">
                <button
                  type="button"
                  className={`flex-1 flex items-center justify-center gap-2 py-1.5 text-[10px] font-mono uppercase tracking-wider rounded-none transition-colors ${dualTextureMode === "livery" ? "bg-[var(--mg-surface)] text-[var(--mg-primary)]" : "text-[var(--mg-primary)]/50 hover:text-[var(--mg-primary)]"}`}
                  onClick={() => setDualTextureMode("livery")}
                >
                  <Car className="h-3 w-3" />
                  <span>Livery</span>
                </button>
                <button
                  type="button"
                  className={`flex-1 flex items-center justify-center gap-2 py-1.5 text-[10px] font-mono uppercase tracking-wider rounded-none transition-colors ${dualTextureMode === "eup" ? "bg-[var(--mg-surface)] text-[var(--mg-primary)]" : "text-[var(--mg-primary)]/50 hover:text-[var(--mg-primary)]"}`}
                  onClick={() => setDualTextureMode("eup")}
                >
                  <Shirt className="h-3 w-3" />
                  <span>EUP</span>
                </button>
              </div>

              <div className="cs-multi-slot-card">
                {/* Header */}
                <div className="cs-multi-slot-header">
                  <span className="cs-multi-slot-header-label">Active Slot</span>
                  <div className="cs-multi-slot-pips">
                    <div className={`cs-multi-slot-pip cs-multi-slot-pip--a ${dualSelectedSlot === "A" ? "is-active" : ""}`} />
                    <div className={`cs-multi-slot-pip cs-multi-slot-pip--b ${dualSelectedSlot === "B" ? "is-active" : ""}`} />
                  </div>
                </div>

                {/* Slot switcher */}
                <div className="cs-multi-slot-switcher">
                  <button
                    type="button"
                    className={`cs-multi-slot-btn cs-multi-slot-btn--a ${dualSelectedSlot === "A" ? "is-active" : ""}`}
                    onClick={() => setDualSelectedSlot("A")}
                  >
                    <div className="cs-multi-slot-btn-bar" />
                    <span className="cs-multi-slot-btn-glyph">A</span>
                    <span className="cs-multi-slot-btn-sublabel">Slot</span>
                  </button>
                  <button
                    type="button"
                    className={`cs-multi-slot-btn cs-multi-slot-btn--b ${dualSelectedSlot === "B" ? "is-active" : ""}`}
                    onClick={() => setDualSelectedSlot("B")}
                  >
                    <div className="cs-multi-slot-btn-bar" />
                    <span className="cs-multi-slot-btn-glyph">B</span>
                    <span className="cs-multi-slot-btn-sublabel">Slot</span>
                  </button>
                </div>

                {/* Action bar */}
                <div className="cs-multi-slot-actions">
                  <button
                    type="button"
                    className="cs-multi-slot-action"
                    onClick={() => dualViewerApiRef.current?.snapTogether?.()}
                    title="Snap models together"
                  >
                    <Link2 className="w-3 h-3" />
                    <span>Snap</span>
                  </button>
                  <button
                    type="button"
                    className="cs-multi-slot-action"
                    onClick={() => dualViewerApiRef.current?.reset?.()}
                    title="Re-center camera"
                  >
                    <RotateCcw className="w-3 h-3" />
                    <span>Center</span>
                  </button>
                  <button
                    type="button"
                    className={`cs-multi-slot-action ${dualGizmoVisible ? "cs-multi-slot-action--gizmo-on" : ""}`}
                    onClick={() => setDualGizmoVisible((p) => !p)}
                    title={dualGizmoVisible ? "Hide gizmo" : "Show gizmo"}
                  >
                    {dualGizmoVisible ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                    <span>Gizmo</span>
                  </button>
                </div>
              </div>

              <CyberSection
                title={dualSelectedSlot === "A" ? "Slot A" : "Slot B"}
                caption={dualSelectedSlot === "A" ? getFileLabel(dualModelAPath, "No model") : getFileLabel(dualModelBPath, "No model")}
                open={true}
                onToggle={() => {}}
                contentId="panel-dual-selected-slot"
                icon={Aperture}
                color={dualSelectedSlot === "A" ? "orange" : "purple"}
              >
                {dualSelectedSlot === "A" ? (
                  <div className="flex flex-col gap-3">
                    <CyberCard>
                      <CyberLabel>Model</CyberLabel>
                      <div className="flex flex-col gap-0">
                        <div className="flex gap-0">
                          <CyberButton
                            variant="secondary"
                            className={dualModelAPath ? "flex-1 rounded-none border-b-0" : "w-full"}
                            onClick={() => selectDualModel("A")}
                          >
                            Select Model A
                          </CyberButton>
                          {dualModelAPath ? (
                            <UnloadButton
                              className="flex-1 rounded-none border-b-0 border-l-0"
                              onClick={() => { setDualModelAPath(""); setDualModelAError(""); }}
                              title="Unload model A"
                            />
                          ) : null}
                        </div>
                        {dualModelAPath ? (
                          <div className="px-2 py-1 bg-[var(--mg-surface)] border border-[var(--mg-border)] border-t-0 rounded-[var(--mg-radius)] text-[9px] font-mono text-[var(--mg-muted)] truncate">
                            {getFileLabel(dualModelAPath, "")}
                          </div>
                        ) : null}
                      </div>
                      {dualModelALoading ? <div className="text-[9px] text-[var(--mg-primary)] animate-pulse mt-1">Loading...</div> : null}
                      {dualModelAError ? <div className="text-[9px] text-red-400 mt-1">{dualModelAError}</div> : null}
                    </CyberCard>
                    <CyberCard>
                      <CyberLabel>{dualTextureMode === "eup" ? "Uniform" : "Template"}</CyberLabel>
                      <div className="flex flex-col gap-0">
                        <div className="flex gap-0">
                          <CyberButton
                            variant="secondary"
                            className={dualTextureAPath ? "flex-1 rounded-none border-b-0" : "w-full"}
                            onClick={() => selectDualTexture("A")}
                          >
                            {dualTextureMode === "eup" ? "Select Uniform A" : "Select Livery A"}
                          </CyberButton>
                          {dualTextureAPath ? (
                            <UnloadButton
                              className="flex-1 rounded-none border-b-0 border-l-0"
                              onClick={() => setDualTextureAPath("")}
                              title="Unload texture A"
                            />
                          ) : null}
                        </div>
                        {dualTextureAPath ? (
                          <div className="px-2 py-1 bg-[var(--mg-surface)] border border-[var(--mg-border)] border-t-0 rounded-[var(--mg-radius)] text-[9px] font-mono text-[var(--mg-muted)] truncate">
                            {getFileLabel(dualTextureAPath, "")}
                          </div>
                        ) : null}
                      </div>
                    </CyberCard>
                    {dualTextureMode === "livery" ? (
                      <CyberCard>
                        <CyberLabel>Window Design</CyberLabel>
                        <div className="flex flex-col gap-0">
                          <div className="flex gap-0">
                            <CyberButton
                              variant="secondary"
                              className={dualWindowTextureAPath ? "flex-1 rounded-none border-b-0" : "w-full"}
                              onClick={selectWindowTexture}
                            >
                              Select Window A
                            </CyberButton>
                            {dualWindowTextureAPath ? (
                              <UnloadButton
                                className="flex-1 rounded-none border-b-0 border-l-0"
                                onClick={() => setDualWindowTextureAPath("")}
                                title="Unload window design A"
                              />
                            ) : null}
                          </div>
                          {dualWindowTextureAPath ? (
                            <div className="px-2 py-1 bg-[var(--mg-surface)] border border-[var(--mg-border)] border-t-0 rounded-[var(--mg-radius)] text-[9px] font-mono text-[var(--mg-muted)] truncate">
                              {getFileLabel(dualWindowTextureAPath, "")}
                            </div>
                          ) : null}
                        </div>
                        <div className="mt-2">
                          <CyberLabel>Apply To</CyberLabel>
                          <Select value={dualWindowTextureATarget} onValueChange={setDualWindowTextureATarget}>
                            <SelectTrigger className="w-full h-8 text-xs bg-[var(--mg-bg)] border-[var(--mg-border)] text-[var(--mg-muted)]">
                              <SelectValue placeholder="Select target" />
                            </SelectTrigger>
                            <SelectContent className="bg-[var(--mg-bg)] border-[var(--mg-border)] text-[var(--mg-muted)]">
                              <SelectItem value="auto">
                                {selectedDualWindowAutoTarget
                                  ? `Auto (${selectedDualWindowAutoLabel || selectedDualWindowAutoTarget.replace("material:", "")})`
                                  : "Auto (no material detected)"}
                              </SelectItem>
                              <SelectItem value="none">None</SelectItem>
                              <SelectItem value="all">All meshes</SelectItem>
                              {selectedDualTargets.map((target) => (
                                <SelectItem key={`dual-a-window-${target.value}`} value={target.value}>
                                  {target.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </CyberCard>
                    ) : null}
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    <CyberCard>
                      <CyberLabel>Model</CyberLabel>
                      <div className="flex flex-col gap-0">
                        <div className="flex gap-0">
                          <CyberButton
                            variant="secondary"
                            className={dualModelBPath ? "flex-1 rounded-none border-b-0" : "w-full"}
                            onClick={() => selectDualModel("B")}
                          >
                            Select Model B
                          </CyberButton>
                          {dualModelBPath ? (
                            <UnloadButton
                              className="flex-1 rounded-none border-b-0 border-l-0"
                              onClick={() => { setDualModelBPath(""); setDualModelBError(""); }}
                              title="Unload model B"
                            />
                          ) : null}
                        </div>
                        {dualModelBPath ? (
                          <div className="px-2 py-1 bg-[var(--mg-surface)] border border-[var(--mg-border)] border-t-0 rounded-[var(--mg-radius)] text-[9px] font-mono text-[var(--mg-muted)] truncate">
                            {getFileLabel(dualModelBPath, "")}
                          </div>
                        ) : null}
                      </div>
                      {dualModelBLoading ? <div className="text-[9px] text-[#a78bfa] animate-pulse mt-1">Loading...</div> : null}
                      {dualModelBError ? <div className="text-[9px] text-red-400 mt-1">{dualModelBError}</div> : null}
                    </CyberCard>
                    <CyberCard>
                      <CyberLabel>{dualTextureMode === "eup" ? "Uniform" : "Template"}</CyberLabel>
                      <div className="flex flex-col gap-0">
                        <div className="flex gap-0">
                          <CyberButton
                            variant="secondary"
                            className={dualTextureBPath ? "flex-1 rounded-none border-b-0" : "w-full"}
                            onClick={() => selectDualTexture("B")}
                          >
                            {dualTextureMode === "eup" ? "Select Uniform B" : "Select Livery B"}
                          </CyberButton>
                          {dualTextureBPath ? (
                            <UnloadButton
                              className="flex-1 rounded-none border-b-0 border-l-0"
                              onClick={() => setDualTextureBPath("")}
                              title="Unload texture B"
                            />
                          ) : null}
                        </div>
                        {dualTextureBPath ? (
                          <div className="px-2 py-1 bg-[var(--mg-surface)] border border-[var(--mg-border)] border-t-0 rounded-[var(--mg-radius)] text-[9px] font-mono text-[var(--mg-muted)] truncate">
                            {getFileLabel(dualTextureBPath, "")}
                          </div>
                        ) : null}
                      </div>
                    </CyberCard>
                    {dualTextureMode === "livery" ? (
                      <CyberCard>
                        <CyberLabel>Window Design</CyberLabel>
                        <div className="flex flex-col gap-0">
                          <div className="flex gap-0">
                            <CyberButton
                              variant="secondary"
                              className={dualWindowTextureBPath ? "flex-1 rounded-none border-b-0" : "w-full"}
                              onClick={selectWindowTexture}
                            >
                              Select Window B
                            </CyberButton>
                            {dualWindowTextureBPath ? (
                              <UnloadButton
                                className="flex-1 rounded-none border-b-0 border-l-0"
                                onClick={() => setDualWindowTextureBPath("")}
                                title="Unload window design B"
                              />
                            ) : null}
                          </div>
                          {dualWindowTextureBPath ? (
                            <div className="px-2 py-1 bg-[var(--mg-surface)] border border-[var(--mg-border)] border-t-0 rounded-[var(--mg-radius)] text-[9px] font-mono text-[var(--mg-muted)] truncate">
                              {getFileLabel(dualWindowTextureBPath, "")}
                            </div>
                          ) : null}
                        </div>
                        <div className="mt-2">
                          <CyberLabel>Apply To</CyberLabel>
                          <Select value={dualWindowTextureBTarget} onValueChange={setDualWindowTextureBTarget}>
                            <SelectTrigger className="w-full h-8 text-xs bg-[var(--mg-bg)] border-[var(--mg-border)] text-[var(--mg-muted)]">
                              <SelectValue placeholder="Select target" />
                            </SelectTrigger>
                            <SelectContent className="bg-[var(--mg-bg)] border-[var(--mg-border)] text-[var(--mg-muted)]">
                              <SelectItem value="auto">
                                {selectedDualWindowAutoTarget
                                  ? `Auto (${selectedDualWindowAutoLabel || selectedDualWindowAutoTarget.replace("material:", "")})`
                                  : "Auto (no material detected)"}
                              </SelectItem>
                              <SelectItem value="none">None</SelectItem>
                              <SelectItem value="all">All meshes</SelectItem>
                              {selectedDualTargets.map((target) => (
                                <SelectItem key={`dual-b-window-${target.value}`} value={target.value}>
                                  {target.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </CyberCard>
                    ) : null}
                  </div>
                )}
              </CyberSection>
            </div>
          ) : null}


          <CyberSection
            title="Appearance"
            caption="Colors"
            open={colorsOpen}
            onToggle={() => setColorsOpen((prev) => !prev)}
            contentId="panel-colors"
            icon={Palette}
            color="blue"
          >
            <div className="space-y-3">
              {textureMode === "multi" ? (
                <>
                  <CyberCard>
                    <CyberLabel>Slot A Body Color</CyberLabel>
                    <div className="flex items-center gap-2">
                      <div className="color-swatch-wrapper">
                        <div className="color-swatch" style={{ background: dualBodyColorA }} />
                        <input
                          type="color"
                          value={dualBodyColorA}
                          onChange={(event) => setDualBodyColorA(event.currentTarget.value)}
                          className="color-picker-native"
                          aria-label="Slot A body color picker"
                        />
                      </div>
                      <Input
                        className="flex-1 h-8 bg-[var(--mg-input-bg)] border-[var(--mg-border)] text-[var(--mg-fg)] text-xs"
                        style={{ fontFamily: "var(--font-hud)", borderRadius: "var(--mg-radius)" }}
                        value={dualBodyColorA}
                        onChange={(event) => setDualBodyColorA(event.currentTarget.value)}
                      />
                      <button type="button" className="cs-copy-btn" onClick={() => copyHex(dualBodyColorA)} title="Copy hex"><Copy className="h-3 w-3" /></button>
                      <button
                        type="button"
                        className="w-7 h-7 flex items-center justify-center text-[var(--mg-muted)] hover:text-[var(--mg-fg)] transition-colors"
                        onClick={() => setDualBodyColorA(DEFAULT_BODY)}
                        title="Reset Slot A color"
                      >
                        <RotateCcw className="h-3 w-3" />
                      </button>
                    </div>
                    <div className="cs-swatches">
                      {COLOR_SWATCHES.map(c => (
                        <button key={c} className="cs-swatch-dot" style={{ background: c }} onClick={() => setDualBodyColorA(c)} title={c} />
                      ))}
                    </div>
                  </CyberCard>

                  <CyberCard>
                    <CyberLabel>Slot B Body Color</CyberLabel>
                    <div className="flex items-center gap-2">
                      <div className="color-swatch-wrapper">
                        <div className="color-swatch" style={{ background: dualBodyColorB }} />
                        <input
                          type="color"
                          value={dualBodyColorB}
                          onChange={(event) => setDualBodyColorB(event.currentTarget.value)}
                          className="color-picker-native"
                          aria-label="Slot B body color picker"
                        />
                      </div>
                      <Input
                        className="flex-1 h-8 bg-[var(--mg-input-bg)] border-[var(--mg-border)] text-[var(--mg-fg)] text-xs"
                        style={{ fontFamily: "var(--font-hud)", borderRadius: "var(--mg-radius)" }}
                        value={dualBodyColorB}
                        onChange={(event) => setDualBodyColorB(event.currentTarget.value)}
                      />
                      <button type="button" className="cs-copy-btn" onClick={() => copyHex(dualBodyColorB)} title="Copy hex"><Copy className="h-3 w-3" /></button>
                      <button
                        type="button"
                        className="w-7 h-7 flex items-center justify-center text-[var(--mg-muted)] hover:text-[var(--mg-fg)] transition-colors"
                        onClick={() => setDualBodyColorB(DEFAULT_BODY)}
                        title="Reset Slot B color"
                      >
                        <RotateCcw className="h-3 w-3" />
                      </button>
                    </div>
                    <div className="cs-swatches">
                      {COLOR_SWATCHES.map(c => (
                        <button key={c} className="cs-swatch-dot" style={{ background: c }} onClick={() => setDualBodyColorB(c)} title={c} />
                      ))}
                    </div>
                  </CyberCard>
                </>
              ) : (
                <CyberCard>
                  <CyberLabel>Body Color</CyberLabel>
                  <div className="flex items-center gap-2">
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
                      className="flex-1 h-8 bg-[var(--mg-input-bg)] border-[var(--mg-border)] text-[var(--mg-fg)] text-xs"
                      style={{ fontFamily: "var(--font-hud)", borderRadius: "var(--mg-radius)" }}
                      value={bodyColor}
                      onChange={(event) => setBodyColor(event.currentTarget.value)}
                    />
                    <button type="button" className="cs-copy-btn" onClick={() => copyHex(bodyColor)} title="Copy hex"><Copy className="h-3 w-3" /></button>
                    <button
                      type="button"
                      className="w-7 h-7 flex items-center justify-center text-[var(--mg-muted)] hover:text-[var(--mg-fg)] transition-colors"
                      onClick={() => setBodyColor(DEFAULT_BODY)}
                      title="Revert to default"
                    >
                      <RotateCcw className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="cs-swatches">
                    {COLOR_SWATCHES.map(c => (
                      <button key={c} className="cs-swatch-dot" style={{ background: c }} onClick={() => setBodyColor(c)} title={c} />
                    ))}
                  </div>
                </CyberCard>
              )}

              <CyberCard>
                <CyberLabel>Background Color</CyberLabel>
                <div className="flex items-center gap-2">
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
                    className="flex-1 h-8 bg-[var(--mg-input-bg)] border-[var(--mg-border)] text-[var(--mg-fg)] text-xs"
                    style={{ fontFamily: "var(--font-hud)", borderRadius: "var(--mg-radius)" }}
                    value={backgroundColor}
                    onChange={(event) => setBackgroundColor(event.currentTarget.value)}
                  />
                  <button type="button" className="cs-copy-btn" onClick={() => copyHex(backgroundColor)} title="Copy hex"><Copy className="h-3 w-3" /></button>
                  <button
                    type="button"
                    className="w-7 h-7 flex items-center justify-center text-[var(--mg-muted)] hover:text-[var(--mg-fg)] transition-colors"
                    onClick={() => setBackgroundColor(DEFAULT_BG)}
                    title="Revert to default"
                  >
                    <RotateCcw className="h-3 w-3" />
                  </button>
                </div>
                <div className="cs-swatches">
                  {COLOR_SWATCHES.map(c => (
                    <button key={c} className="cs-swatch-dot" style={{ background: c }} onClick={() => setBackgroundColor(c)} title={c} />
                  ))}
                </div>
              </CyberCard>

              <CyberCard>
                <CyberLabel>Background Image</CyberLabel>
                <div className="flex flex-col gap-0">
                  <div className="flex gap-0">
                    <CyberButton
                      onClick={selectBackgroundImage}
                      variant="secondary"
                      className={backgroundImagePath ? "flex-1 rounded-none border-b-0" : "w-full"}
                    >
                      Select Background
                    </CyberButton>
                    {backgroundImagePath ? (
                      <UnloadButton
                        className="flex-1 rounded-none border-b-0 border-l-0"
                        onClick={() => {
                          setBackgroundImagePath("");
                          setBackgroundImageReloadToken((token) => token + 1);
                        }}
                        title="Remove background image"
                      />
                    ) : null}
                  </div>
                  {backgroundImagePath ? (
                    <div className="px-2 py-1 bg-[var(--mg-surface)] border border-[var(--mg-border)] border-t-0 rounded-[var(--mg-radius)] text-[9px] font-mono text-[var(--mg-muted)] truncate">
                      {getFileLabel(backgroundImagePath, "")}
                    </div>
                  ) : null}
                </div>
                <div className="flex items-center justify-between mt-2">
                  <CyberLabel className="mb-0">Wireframe</CyberLabel>
                  <button
                    type="button"
                    className={`w-8 h-4 rounded-none border border-[var(--mg-border)] relative transition-colors ${showWireframe ? "bg-[oklch(0.648_0.116_182.503_/_0.2)] border-[oklch(0.648_0.116_182.503_/_0.5)]" : "bg-[var(--mg-bg)]"}`}
                    onClick={() => setShowWireframe((prev) => !prev)}
                    title={showWireframe ? "Disable wireframe" : "Enable wireframe"}
                  >
                    <div className={`absolute top-0.5 left-0.5 w-2.5 h-2.5 rounded-none bg-[var(--mg-muted)] transition-transform ${showWireframe ? "translate-x-4 bg-[var(--mg-primary)]" : ""}`} />
                  </button>
                </div>
              </CyberCard>

            </div>
          </CyberSection>

          {/* ── Vehicle Materials Section ── */}
          <CyberSection
            title="Materials"
            caption={`${materialType.charAt(0).toUpperCase() + materialType.slice(1)} & Lighting`}
            open={materialsOpen}
            onToggle={() => setMaterialsOpen((prev) => !prev)}
            contentId="panel-materials"
            icon={Gem}
            color="blue"
            badge="NEW"
          >
            <div className="space-y-3">
              <div>
                <CyberLabel>Surface Type</CyberLabel>
                <MaterialTypeSelector value={materialType} onChange={setMaterialType} />
              </div>

              <CyberCard>
                <CyberLabel>Scene Lighting</CyberLabel>
                <div className="space-y-3">
                  <MaterialSlider
                    label="Light Intensity"
                    value={lightIntensity}
                    onChange={setLightIntensity}
                    min={0.5}
                    max={2.0}
                    step={0.1}
                  />
                  <MaterialSlider
                    label="Glossiness"
                    value={glossiness}
                    onChange={setGlossiness}
                    min={0}
                    max={1}
                    step={0.05}
                    unit="%"
                  />
                </div>
              </CyberCard>

              <CyberCard>
                <CyberLabel>Properties</CyberLabel>
                <div className="space-y-3">
                  <MaterialSlider
                    label="Light Intensity"
                    value={matLightIntensity}
                    onChange={setMatLightIntensity}
                    min={0}
                    max={3}
                    step={0.05}
                  />
                  <MaterialSlider
                    label="Glossiness"
                    value={matGlossiness}
                    onChange={setMatGlossiness}
                    min={0}
                    max={1}
                    step={0.01}
                    unit="%"
                  />
                  <MaterialSlider
                    label="Roughness"
                    value={matRoughness}
                    onChange={setMatRoughness}
                    min={0}
                    max={1}
                    step={0.01}
                    unit="%"
                  />
                  <MaterialSlider
                    label="Clearcoat"
                    value={matClearcoat}
                    onChange={setMatClearcoat}
                    min={0}
                    max={1}
                    step={0.01}
                    unit="%"
                  />
                </div>
              </CyberCard>

              <div>
                <CyberLabel>Textures</CyberLabel>
                <TextureUploadGrid
                  textures={materialTextures}
                  onAdd={selectMaterialTexture}
                  onRemove={removeMaterialTexture}
                  maxSlots={6}
                />
              </div>
            </div>
          </CyberSection>

          {/* ── Camera Controls in Panel ── */}
          {cameraControlsInPanel && textureMode !== "multi" && (
            <CyberSection
              title="Camera"
              caption="Presets & rotation"
              open={panelOpen.camera !== false}
              onToggle={() => togglePanel("camera")}
              contentId="panel-camera"
              icon={Camera}
              color="blue"
            >
              <div className="space-y-3">
                <div>
                  <CyberLabel>Presets</CyberLabel>
                  <div className="panel-cam-presets">
                    {[
                      { key: "front", label: "Front" },
                      { key: "back", label: "Back" },
                      { key: "side", label: "Side" },
                      { key: "angle", label: "3/4" },
                      { key: "top", label: "Top" },
                    ].map(({ key, label }) => (
                      <button
                        key={key}
                        type="button"
                        className="panel-cam-preset-btn"
                        onClick={() => viewerApiRef.current?.setPreset(key)}
                        title={`${label} view`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    className="panel-cam-action-btn flex-1"
                    onClick={handleCenterCamera}
                    disabled={!viewerReady}
                    title="Re-center camera"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Center
                  </button>
                  <button
                    type="button"
                    className={`panel-cam-action-btn ${showWireframe ? "is-active" : ""}`}
                    onClick={() => setShowWireframe((prev) => !prev)}
                    title={showWireframe ? "Disable wireframe" : "Enable wireframe"}
                  >
                    <Box className="w-3 h-3" />
                    Wire
                  </button>
                </div>
                <div>
                  <CyberLabel>Rotate Model</CyberLabel>
                  <div className="flex gap-1.5 mt-1">
                    <button
                      type="button"
                      className="panel-cam-axis-btn flex-1"
                      onClick={() => viewerApiRef.current?.rotateModel("x")}
                      title="Rotate 90° on X axis"
                    >
                      <span style={{ color: "#f87171", fontWeight: 700 }}>X</span>
                    </button>
                    <button
                      type="button"
                      className="panel-cam-axis-btn flex-1"
                      onClick={() => viewerApiRef.current?.rotateModel("y")}
                      title="Rotate 90° on Y axis"
                    >
                      <span style={{ color: "#4ade80", fontWeight: 700 }}>Y</span>
                    </button>
                    <button
                      type="button"
                      className="panel-cam-axis-btn flex-1"
                      onClick={() => viewerApiRef.current?.rotateModel("z")}
                      title="Rotate 90° on Z axis"
                    >
                      <span style={{ color: "#60a5fa", fontWeight: 700 }}>Z</span>
                    </button>
                  </div>
                </div>
              </div>
            </CyberSection>
          )}

          {/* ── Capture Preview ── */}
          {textureMode !== "multi" && (
            <div className="panel-capture-section">
              <button
                type="button"
                className={`panel-capture-btn${generatingPreview ? " is-generating" : ""}`}
                onClick={() => {
                  if (generatingPreview || !viewerReady) return;
                  setPreviewZoomDraft(previewZoom || 1);
                  setPreviewPromptOpen(true);
                  setPreviewZoomPreview("");
                }}
                disabled={generatingPreview || !viewerReady || !hasModel}
                title="Generate preview screenshots from all angles"
              >
                <Camera className="panel-capture-icon" />
                <span className="panel-capture-label">
                  {generatingPreview
                    ? `${previewProgress.current} / ${previewProgress.total}`
                    : "Capture Preview"}
                </span>
                {generatingPreview && previewProgress.total > 0 && (
                  <div
                    className="panel-capture-bar-fill"
                    style={{ width: `${(previewProgress.current / previewProgress.total) * 100}%` }}
                  />
                )}
              </button>
            </div>
          )}

      </CyberPanel>

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
        {textureMode === "multi" ? (
          <DualModelViewer
            modelAPath={dualModelAPath}
            modelBPath={dualModelBPath}
            textureAPath={dualTextureAPath}
            textureBPath={dualTextureBPath}
            windowTextureAPath={dualTextureMode === "livery" ? dualWindowTextureAPath : ""}
            windowTextureBPath={dualTextureMode === "livery" ? dualWindowTextureBPath : ""}
            windowTextureATarget={resolvedDualWindowTextureATarget}
            windowTextureBTarget={resolvedDualWindowTextureBTarget}
            textureAReloadToken={dualTextureAReloadToken}
            textureBReloadToken={dualTextureBReloadToken}
            bodyColorA={dualBodyColorA}
            bodyColorB={dualBodyColorB}
            backgroundColor={backgroundColor}
            backgroundImagePath={backgroundImagePath}
            backgroundImageReloadToken={backgroundImageReloadToken}
            lightIntensity={lightIntensity}
            glossiness={glossiness}
            showWireframe={showWireframe}
            selectedSlot={dualSelectedSlot}
            gizmoVisible={dualGizmoVisible}
            showGrid={showGrid}
            textureMode={dualTextureMode}
            initialPosA={dualModelAPos}
            initialPosB={dualModelBPos}
            onSelectSlot={setDualSelectedSlot}
            onPositionChange={(posA, posB) => {
              setDualModelAPos(posA);
              setDualModelBPos(posB);
            }}
            onReady={(api) => {
              dualViewerApiRef.current = api;
              if (!viewerReady) setViewerReady(true);
            }}
            onModelAError={setDualModelAError}
            onModelBError={setDualModelBError}
            onModelALoading={setDualModelALoading}
            onModelBLoading={setDualModelBLoading}
            onModelAInfo={handleDualModelAInfo}
            onModelBInfo={handleDualModelBInfo}
            onFormatWarning={handleFormatWarning}
          />
        ) : (
          <Viewer
            modelPath={modelPath}
            texturePath={texturePath}
            windowTexturePath={windowTemplateEnabled ? windowTexturePath : ""}
            bodyColor={bodyColor}
            backgroundColor={backgroundColor}
            backgroundImagePath={backgroundImagePath}
            backgroundImageReloadToken={backgroundImageReloadToken}
            showGrid={showGrid}
            textureReloadToken={textureReloadToken}
            windowTextureReloadToken={windowTextureReloadToken}
            textureTarget={resolvedTextureTarget}
            windowTextureTarget={resolvedWindowTextureTarget}
            textureMode={textureMode}
            showWireframe={showWireframe}
            wasdEnabled={cameraWASD}
            liveryExteriorOnly={textureMode === "livery" && liveryExteriorOnly}
            lightIntensity={lightIntensity}
            glossiness={glossiness}
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
            onFormatWarning={handleFormatWarning}
          />
        )}

        <AnimatePresence>
          {(modelLoading || (textureMode === "multi" && (dualModelALoading || dualModelBLoading))) ? <AppLoader variant="background" /> : null}
        </AnimatePresence>

        {/* Controls now integrated into viewer-toolbar-bar above */}

        {showHints ? (
          <div className="viewer-hints">
            <span>Left drag: Rotate</span>
            <span>Right drag: Pan</span>
            <span>Scroll: Zoom</span>
          </div>
        ) : null}

        {/* Update notification toast */}
        <AnimatePresence>
          {update.available && !update.dismissed ? (
            <motion.div
              className="update-toast"
              initial={{ opacity: 0, y: 20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.97 }}
              transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="update-toast-content">
                <div className="update-toast-header">
                  <div className="update-toast-title-row">
                    <span className="update-toast-label">Update available</span>
                    <span className="update-toast-version">v{update.latest}</span>
                  </div>
                  <div className="update-toast-desc">
                    A new version of Cortex Studio is available to download. Would you like to download it now?
                  </div>
                </div>
                
                <div className="update-toast-footer status-strip">
                  <button
                    type="button"
                    className="update-toast-dismiss-btn update-toast-link-blue"
                    disabled={update.installing}
                    onClick={async () => {
                      const installed = await update.install();
                      if (installed) {
                        showToast("Update installed. Restart Cortex Studio to finish.");
                      }
                    }}
                  >
                    {update.installing
                      ? `Installing...${update.progressPercent > 0 ? ` ${update.progressPercent}%` : ""}`
                      : "Download & Install"}
                  </button>

                  <button
                    type="button"
                    className="update-toast-dismiss-btn"
                    onClick={update.dismiss}
                  >
                    Not now
                  </button>
                </div>
                {update.error ? (
                  <div className="update-toast-desc text-[var(--es-danger)] pt-2">{update.error}</div>
                ) : null}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        {/* Action toasts */}
        <div className="cs-toast-stack">
          <AnimatePresence>
            {toasts.map(t => (
              <motion.div
                key={t.id}
                className="cs-toast-item"
                initial={{ opacity: 0, y: 16, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8, scale: 0.97 }}
                transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
              >
                <Check className="h-3 w-3 text-[var(--es-success)]" />
                <span>{t.message}</span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </motion.section>

      <AnimatePresence>{isBooting ? <AppLoader /> : null}</AnimatePresence>
      {/* Onboarding handled by Shell */}

      {/* Format Warning Modal */}
      <AnimatePresence>
        {formatWarning ? (
          <motion.div
            className="warning-modal-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setFormatWarning(null)}
          >
            <motion.div
              className="warning-modal"
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="warning-modal-header">
                <AlertTriangle className="warning-modal-icon" />
                <div className="warning-modal-title-group">
                  <div className="warning-modal-title">
                    {formatWarning.type === "non-hi-model"
                      ? "Standard Detail Model Detected"
                      : formatWarning.type === "unsupported-format"
                        ? "Unsupported Image Format"
                        : `${formatWarning.bitDepth}-Bit PSD Not Supported`}
                  </div>
                  <div className="warning-modal-subtitle">
                    {formatWarning.type === "non-hi-model"
                      ? "Recommendation: Use _hi.yft"
                      : formatWarning.type === "unsupported-format"
                        ? `Cannot load .${formatWarning.ext} files`
                        : "High bit depth format detected"}
                  </div>
                </div>
              </div>

              <div className="warning-modal-body">
                {formatWarning.type === "unsupported-format" ? (
                  <div className="warning-modal-content">
                    <div className="warning-modal-section">
                      <div className="warning-modal-text">
                        The file <strong>{formatWarning.path}</strong> uses the <strong>.{formatWarning.ext}</strong> format, which is not supported and cannot be loaded.
                      </div>
                    </div>

                    <div className="warning-modal-section">
                      <div className="warning-modal-section-title">Supported Formats</div>
                      <div className="warning-modal-steps">
                        <div className="warning-modal-step">
                          <span className="warning-modal-step-num">1</span>
                          <span className="warning-modal-step-text"><strong>PNG</strong> — Recommended for lossless textures</span>
                        </div>
                        <div className="warning-modal-step">
                          <span className="warning-modal-step-num">2</span>
                          <span className="warning-modal-step-text"><strong>JPG / JPEG</strong> — Smaller file size, lossy compression</span>
                        </div>
                        <div className="warning-modal-step">
                          <span className="warning-modal-step-num">3</span>
                          <span className="warning-modal-step-text"><strong>PSD</strong> — Photoshop files (8-bit only)</span>
                        </div>
                      </div>
                    </div>

                    <div className="warning-modal-section">
                      <div className="warning-modal-section-title">How to Fix</div>
                      <div className="warning-modal-text">
                        Open your <strong>.{formatWarning.ext}</strong> file in an image editor and export it as <strong>PNG</strong> or <strong>JPEG</strong> before loading it here.
                      </div>
                    </div>
                  </div>
                ) : formatWarning.type === "non-hi-model" ? (
                  <div className="warning-modal-content">
                    <div className="warning-modal-section">
                      <div className="warning-modal-text">
                        You have loaded <strong>{formatWarning.path}</strong>. It is strongly recommended to use the high-detail version (ending in <strong>_hi.yft</strong>) whenever available.
                      </div>
                    </div>
                    <div className="warning-modal-section">
                      <div className="warning-modal-section-title">Missing Features</div>
                      <div className="warning-modal-text">
                        Standard models often lack critical features such as <strong>window templates</strong>, high-quality material slots, and detailed geometry. Depending on the developer, this may affect what you see in the viewer.
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="warning-modal-content">
                    <div className="warning-modal-section">
                      <div className="warning-modal-text">
                        This PSD file uses <strong>{formatWarning.bitDepth}-bit</strong> color depth (high dynamic range), 
                        which cannot be loaded directly.
                      </div>
                    </div>

                    <div className="warning-modal-section">
                      <div className="warning-modal-section-title">How to Convert</div>
                      <div className="warning-modal-steps">
                        <div className="warning-modal-step">
                          <span className="warning-modal-step-num">1</span>
                          <span className="warning-modal-step-text">Open the file in <strong>Photoshop</strong></span>
                        </div>
                        <div className="warning-modal-step">
                          <span className="warning-modal-step-num">2</span>
                          <span className="warning-modal-step-text">
                            Go to <span className="warning-modal-code">Image → Mode → 8 Bits/Channel</span>
                          </span>
                        </div>
                        <div className="warning-modal-step">
                          <span className="warning-modal-step-num">3</span>
                          <span className="warning-modal-step-text">Save the file and reload it here</span>
                        </div>
                      </div>
                    </div>

                    <div className="warning-modal-section">
                      <div className="warning-modal-section-title">Trade-offs</div>
                      <div className="warning-modal-note">
                        8-bit has 256 color levels per channel vs {formatWarning.bitDepth === 16 ? "65,536" : "billions"} in {formatWarning.bitDepth}-bit. 
                        For game textures, 8-bit is typically sufficient and more widely compatible.
                      </div>
                    </div>

                    <div className="warning-modal-section">
                      <div className="warning-modal-section-title">Alternative</div>
                      <div className="warning-modal-text">
                        Export as <strong>PNG</strong> or <strong>JPEG</strong> which automatically converts to 8-bit.
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="warning-modal-footer">
                <button
                  type="button"
                  className="warning-modal-btn warning-modal-btn-primary"
                  onClick={() => {
                    if (formatWarning.type !== "non-hi-model" && formatWarning.type !== "unsupported-format") {
                      if (formatWarning.slot === "A") {
                        if (formatWarning.kind === "window") setDualWindowTextureAPath("");
                        else setDualTextureAPath("");
                      } else if (formatWarning.slot === "B") {
                        if (formatWarning.kind === "window") setDualWindowTextureBPath("");
                        else setDualTextureBPath("");
                      } else {
                        if (formatWarning.kind === "window") setWindowTexturePath("");
                        else setTexturePath("");
                      }
                      setTextureError("");
                      setWindowTextureError("");
                    }
                    setFormatWarning(null);
                  }}
                >
                  GOT IT
                </button>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Session prompt removed — workspace state is now auto-restored via initialState prop */}

      {/* Generate Preview — zoom prompt */}
      <AnimatePresence>
        {previewPromptOpen && (
          <motion.div
            className="preview-zoom-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setPreviewPromptOpen(false)}
          >
            <motion.div
              className="preview-zoom-card"
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="preview-zoom-header">
                <Camera className="preview-zoom-icon" />
                <div>
                  <div className="preview-zoom-title">Preview Zoom</div>
                  <div className="preview-zoom-sub">Choose how close the export screenshots should be.</div>
                </div>
              </div>

              <div className="preview-zoom-preview">
                {previewZoomPreview && !previewZoomLoading ? (
                  <img src={previewZoomPreview} alt="Preview zoom" />
                ) : (
                  <div className="preview-zoom-placeholder">
                    <div className="vp-spinner" />
                    <span>{previewZoomLoading ? "Updating preview..." : "Preview pending"}</span>
                  </div>
                )}
              </div>

              <div className="preview-zoom-controls">
                <div className="preview-zoom-row">
                  <span>Zoom</span>
                  <span>{previewZoomDraft.toFixed(2)}x</span>
                </div>
                <input
                  type="range"
                  min="0.6"
                  max="1.8"
                  step="0.02"
                  value={previewZoomDraft}
                  onChange={(e) => setPreviewZoomDraft(parseFloat(e.target.value))}
                  className="preview-zoom-slider"
                />
              </div>

              <div className="preview-zoom-actions">
                <button
                  type="button"
                  className="preview-zoom-btn preview-zoom-btn--cancel"
                  onClick={() => setPreviewPromptOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="preview-zoom-btn preview-zoom-btn--confirm"
                  onClick={() => {
                    setPreviewZoom(previewZoomDraft);
                    setPreviewPromptOpen(false);
                    handleGeneratePreview(previewZoomDraft);
                  }}
                >
                  Generate Preview
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Generate Preview — progress overlay */}
      <AnimatePresence>
        {generatingPreview && (
          <motion.div
            className="gen-preview-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <motion.div
              className="gen-preview-card"
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            >
              <Camera className="gen-preview-icon" />
              <div className="gen-preview-title">Generating Preview</div>
              <div className="gen-preview-sub">{previewProgress.preset || "Starting..."}</div>
              <div className="gen-preview-bar-track">
                <motion.div
                  className="gen-preview-bar-fill"
                  animate={{ width: `${previewProgress.total > 0 ? (previewProgress.current / previewProgress.total) * 100 : 0}%` }}
                  transition={{ duration: 0.3 }}
                />
              </div>
              <div className="gen-preview-count">{previewProgress.current} / {previewProgress.total}</div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Generate Preview — completion modal */}
      <AnimatePresence>
        {previewComplete && (
          <motion.div
            className="gen-preview-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setPreviewComplete(false)}
          >
            <motion.div
              className="gen-preview-card"
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
              onClick={(e) => e.stopPropagation()}
            >
              <motion.div
                className="gen-preview-done-check"
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: "spring", stiffness: 400, damping: 20, delay: 0.1 }}
              >
                <Check className="w-6 h-6" />
              </motion.div>
              <div className="gen-preview-title">Preview Complete</div>
              <div className="gen-preview-sub">5 screenshots exported successfully</div>
              <div className="gen-preview-actions">
                <button
                  type="button"
                  className="gen-preview-btn gen-preview-btn--open"
                  onClick={async () => {
                    if (isTauriRuntime && previewOutputPath) {
                      try {
                        const prefs = loadPrefs() || {};
                        const fallbackFolder = prefs?.defaults?.previewFolder || "";
                        const targetFolder = await resolveExistingFolder(previewOutputPath, fallbackFolder);
                        await openPath(targetFolder);
                      } catch {
                        console.error("Failed to open preview folder:", previewOutputPath);
                      }
                    }
                    setPreviewComplete(false);
                  }}
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  Open Folder
                </button>
                <button
                  type="button"
                  className="gen-preview-btn gen-preview-btn--close"
                  onClick={() => setPreviewComplete(false)}
                >
                  Close
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </motion.div>
  );
}

export default App;
