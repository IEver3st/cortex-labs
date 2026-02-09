import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { writeFile, exists as fsExists } from "@tauri-apps/plugin-fs";
// Window controls handled by Shell
import { AlertTriangle, ArrowUpRight, Car, Camera, ChevronRight, Eye, EyeOff, Layers, Link2, PanelLeft, RotateCcw, Shirt, X, Aperture, Disc, Zap, FolderOpen, Check } from "lucide-react";
import { useUpdateChecker } from "./lib/updater";
import { openUrl } from "@tauri-apps/plugin-opener";
import appMeta from "../package.json";
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
import { CyberPanel, CyberSection, CyberButton, CyberCard, CyberLabel } from "./components/CyberUI";

const DEFAULT_BODY = "#e7ebf0";
const DEFAULT_BG = "#141414";
const MIN_LOADER_MS = 650;

const SUPPORTED_TEXTURE_EXTS = ["png", "jpg", "jpeg", "psd", "dds"];

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
  lightIntensity: 1.0,
  glossiness: 0.5,
  windowControlsStyle: "windows",
  toolbarInTitlebar: false,
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



function App({ shellTab, isActive = true, onRenameTab, settingsVersion, defaultTextureMode = "livery", initialState = null }) {
  const viewerApiRef = useRef(null);
  const reloadTimerRef = useRef({ primary: null, window: null });
  const isTauriRuntime =
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__ !== "undefined" &&
    typeof window.__TAURI_INTERNALS__?.invoke === "function";

  const update = useUpdateChecker(appMeta.version);

  const [defaults, setDefaults] = useState(() => getInitialDefaults());
  const [hotkeys, setHotkeys] = useState(() => getInitialHotkeys());
  const [showOnboarding, setShowOnboarding] = useState(() => !loadOnboarded());
  const [panelCollapsed, setPanelCollapsed] = useState(false);

  const [modelPath, setModelPath] = useState("");
  const [modelSourcePath, setModelSourcePath] = useState("");
  const [texturePath, setTexturePath] = useState("");
  const [windowTemplateEnabled, setWindowTemplateEnabled] = useState(() => Boolean(getInitialDefaults().windowTemplateEnabled));
  const [windowTexturePath, setWindowTexturePath] = useState("");
  const [bodyColor, setBodyColor] = useState(() => getInitialDefaults().bodyColor);
  const [backgroundColor, setBackgroundColor] = useState(() => getInitialDefaults().backgroundColor);
  const [lightIntensity, setLightIntensity] = useState(() => getInitialDefaults().lightIntensity ?? 1.0);
  const [glossiness, setGlossiness] = useState(() => getInitialDefaults().glossiness ?? 0.5);
  const [experimentalSettings, setExperimentalSettings] = useState(() => Boolean(getInitialDefaults().experimentalSettings));
  // windowControlsStyle now handled by Shell
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
  const [textureMode, setTextureMode] = useState(() => defaultTextureMode);
  const [textureTarget, setTextureTarget] = useState("all");
  const [liveryTarget, setLiveryTarget] = useState("");
  const [liveryLabel, setLiveryLabel] = useState("");
  const [windowTextureTarget, setWindowTextureTarget] = useState(() => getInitialDefaults().windowTextureTarget || "auto");

  const [cameraWASD, setCameraWASD] = useState(() => Boolean(getInitialDefaults().cameraWASD));
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
  const [dualTextureAReloadToken, setDualTextureAReloadToken] = useState(0);
  const [dualTextureBReloadToken, setDualTextureBReloadToken] = useState(0);
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
    setShowHints(Boolean(merged.showHints ?? true));
    setHideRotText(Boolean(merged.hideRotText));
    setShowGrid(Boolean(merged.showGrid));
    setBodyColor(merged.bodyColor);
    setBackgroundColor(merged.backgroundColor);
    setExperimentalSettings(Boolean(merged.experimentalSettings));
    const hk = getInitialHotkeys();
    setHotkeys(hk);
  }, [settingsVersion]);

  const isBooting = !booted;
  const modelExtensions = textureMode === "eup" ? ["yft", "clmesh", "dff", "ydd"] : ["yft", "clmesh", "dff"];
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
    const hasContent = modelPath || dualModelAPath || dualModelBPath || texturePath || dualTextureAPath || dualTextureBPath;
    if (!hasContent) return;

    if (sessionSaveTimerRef.current) clearTimeout(sessionSaveTimerRef.current);
    sessionSaveTimerRef.current = setTimeout(() => {
      const stateSnapshot = {
        textureMode,
        modelPath: modelPath || "",
        texturePath: texturePath || "",
        windowTexturePath: windowTexturePath || "",
        windowTemplateEnabled,
        bodyColor,
        backgroundColor,
        liveryExteriorOnly,
        dualModelAPath: dualModelAPath || "",
        dualModelBPath: dualModelBPath || "",
        dualTextureAPath: dualTextureAPath || "",
        dualTextureBPath: dualTextureBPath || "",
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
    modelPath, texturePath, windowTexturePath, windowTemplateEnabled,
    bodyColor, backgroundColor, liveryExteriorOnly,
    dualModelAPath, dualModelBPath, dualTextureAPath, dualTextureBPath,
    dualModelAPos, dualModelBPos, dualSelectedSlot, dualTextureMode,
    shellTab,
  ]);

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
    setShowHints(Boolean(merged.showHints ?? true));
    setHideRotText(Boolean(merged.hideRotText));
    setShowGrid(Boolean(merged.showGrid));
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

  const restoreState = useCallback(async (state) => {
    if (!state) return;

    const fileOk = async (p) => {
      if (!p) return false;
      try { return await fsExists(p); } catch { return false; }
    };

    // Restore non-path settings immediately
    if (state.textureMode) setTextureMode(state.textureMode);
    if (typeof state.windowTemplateEnabled === "boolean") setWindowTemplateEnabled(state.windowTemplateEnabled);
    if (state.bodyColor) setBodyColor(state.bodyColor);
    if (state.backgroundColor) setBackgroundColor(state.backgroundColor);
    if (typeof state.liveryExteriorOnly === "boolean") setLiveryExteriorOnly(state.liveryExteriorOnly);
    if (state.dualSelectedSlot) setDualSelectedSlot(state.dualSelectedSlot);
    if (state.dualTextureMode) setDualTextureMode(state.dualTextureMode);
    if (state.dualModelAPos) setDualModelAPos(state.dualModelAPos);
    if (state.dualModelBPos) setDualModelBPos(state.dualModelBPos);

    // Validate file paths before restoring — skip stale references
    if (state.modelPath && (await fileOk(state.modelPath))) loadModel(state.modelPath);
    if (state.texturePath && (await fileOk(state.texturePath))) setTexturePath(state.texturePath);
    if (state.windowTexturePath && (await fileOk(state.windowTexturePath))) setWindowTexturePath(state.windowTexturePath);
    if (state.dualModelAPath && (await fileOk(state.dualModelAPath))) setDualModelAPath(state.dualModelAPath);
    if (state.dualModelBPath && (await fileOk(state.dualModelBPath))) setDualModelBPath(state.dualModelBPath);
    if (state.dualTextureAPath && (await fileOk(state.dualTextureAPath))) setDualTextureAPath(state.dualTextureAPath);
    if (state.dualTextureBPath && (await fileOk(state.dualTextureBPath))) setDualTextureBPath(state.dualTextureBPath);
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
        setWindowTextureError("");
        setWindowTexturePath(selected);
      }
    } catch (error) {
      setDialogError("Dialog permission blocked. Check Tauri capabilities.");
      console.error(error);
    }
  };

  const loadModelRef = useRef(loadModel);
  loadModelRef.current = loadModel;
  useEffect(() => {
    if (!isTauriRuntime) return;
    let unlisten;
    let cancelled = false;
    listen("file-open", (event) => {
      const filePath = event.payload;
      if (typeof filePath !== "string" || !filePath) return;
      const lower = filePath.toLowerCase();
      if (lower.endsWith(".yft") || lower.endsWith(".ydd") || lower.endsWith(".dff") || lower.endsWith(".clmesh")) {
        loadModelRef.current(filePath);
      }
    }).then((fn) => {
      if (cancelled) { fn(); }
      else { unlisten = fn; }
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [isTauriRuntime]);

  const modelExtsDual = ["yft", "clmesh", "dff", "ydd"];
  const textureExtsDual = ["png", "jpg", "jpeg", "webp", "avif", "bmp", "gif", "tga", "dds", "tif", "tiff", "psd", "ai"];

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
    if (isTauriRuntime) {
      try { await invoke("ensure_dir", { path: modelFolder }); } catch {
        // If ensure_dir command doesn't exist, try mkdir via writeFile workaround
        // Tauri's writeFile will create the file, the folder must exist.
        // Fall back to the base folder if subfolder creation fails.
      }
    }

    // Temporarily disable grid for clean screenshots
    const gridWasOn = showGrid;
    if (gridWasOn) setShowGrid(false);

    setGeneratingPreview(true);
    setPreviewProgress({ current: 0, total: presetKeys.length, preset: "" });
    setPreviewOutputPath(modelFolder);

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
        const filePath = `${modelFolder}/${fileName}`;
        if (isTauriRuntime) {
          try {
            await writeFile(filePath, bytes);
          } catch {
            // Subfolder might not exist — write to base folder instead
            await writeFile(`${folder}/${fileName}`, bytes);
          }
        }
      }

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
  }, [modelPath, generatingPreview, isTauriRuntime, showGrid]);

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
        <div className="viewer-toolbar-bar">
          {textureMode === "multi" ? (
            <div className="titlebar-inline-controls">
              <button
                type="button"
                className={`titlebar-inline-btn ${dualSelectedSlot === "A" ? "is-slot-active" : ""}`}
                style={dualSelectedSlot === "A" ? { color: "#f97316" } : undefined}
                onClick={() => setDualSelectedSlot("A")}
              >A</button>
              <button
                type="button"
                className={`titlebar-inline-btn ${dualSelectedSlot === "B" ? "is-slot-active" : ""}`}
                style={dualSelectedSlot === "B" ? { color: "#a78bfa" } : undefined}
                onClick={() => setDualSelectedSlot("B")}
              >B</button>
              <div className="titlebar-inline-divider" />
              <button type="button" className="titlebar-inline-btn" onClick={() => setDualGizmoVisible((p) => !p)} title={dualGizmoVisible ? "Hide gizmo" : "Show gizmo"}>
                {dualGizmoVisible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
              </button>
              <button type="button" className="titlebar-inline-btn" onClick={() => dualViewerApiRef.current?.snapTogether?.()}>
                <Link2 className="w-3 h-3" style={{ marginRight: 4 }} />Snap
              </button>
              <button type="button" className="titlebar-inline-btn" onClick={() => dualViewerApiRef.current?.reset?.()}>Center</button>
            </div>
          ) : (
            <div className="titlebar-inline-controls">
              <button type="button" className="titlebar-inline-btn" onClick={() => viewerApiRef.current?.setPreset("front")}>Front</button>
              <button type="button" className="titlebar-inline-btn" onClick={() => viewerApiRef.current?.setPreset("back")}>Back</button>
              <button type="button" className="titlebar-inline-btn" onClick={() => viewerApiRef.current?.setPreset("side")}>Side</button>
              <button type="button" className="titlebar-inline-btn" onClick={() => viewerApiRef.current?.setPreset("angle")}>3/4</button>
              <button type="button" className="titlebar-inline-btn" onClick={() => viewerApiRef.current?.setPreset("top")}>Top</button>
              <div className="titlebar-inline-divider" />
              <button type="button" className="titlebar-inline-btn" onClick={handleCenterCamera} disabled={!viewerReady}>Center</button>
              <div className="titlebar-inline-divider" />
              <button type="button" className="titlebar-inline-btn" onClick={() => viewerApiRef.current?.rotateModel("x")} title="Rotate 90° on X axis">
                <span className="mono text-red-400">X</span>{!hideRotText && "Rot"}
              </button>
              <button type="button" className="titlebar-inline-btn" onClick={() => viewerApiRef.current?.rotateModel("y")} title="Rotate 90° on Y axis">
                <span className="mono text-green-400">Y</span>{!hideRotText && "Rot"}
              </button>
              <button type="button" className="titlebar-inline-btn" onClick={() => viewerApiRef.current?.rotateModel("z")} title="Rotate 90° on Z axis">
                <span className="mono text-blue-400">Z</span>{!hideRotText && "Rot"}
              </button>
              {hasModel && (
                <>
                  <div className="titlebar-inline-divider" />
                  <button
                    type="button"
                    className="titlebar-inline-btn titlebar-inline-btn--preview"
                    onClick={() => {
                      if (generatingPreview || !viewerReady) return;
                      setPreviewZoomDraft(previewZoom || 1);
                      setPreviewPromptOpen(true);
                      setPreviewZoomPreview("");
                    }}
                    disabled={generatingPreview || !viewerReady}
                    title="Generate preview screenshots from all angles"
                  >
                    <Camera className="w-3.5 h-3.5" />
                    {generatingPreview ? (
                      <span className="toolbar-preview-progress">
                        {previewProgress.current}/{previewProgress.total}
                      </span>
                    ) : (
                      "Preview"
                    )}
                  </button>
                </>
              )}
            </div>
          )}

          <div className="viewer-toolbar-bar-spacer" />

          <button
            type="button"
            className="titlebar-btn titlebar-panel-toggle"
            onClick={() => setPanelCollapsed((prev) => !prev)}
            aria-label={panelCollapsed ? "Show control panel" : "Hide control panel"}
            data-tauri-drag-region="false"
          >
            <PanelLeft className="titlebar-icon" />
          </button>
        </div>

      <CyberPanel collapsed={panelCollapsed} isBooting={isBooting} statusBar={
        <div style={{ fontFamily: "var(--font-hud)", flexShrink: 0, borderTop: "1px solid rgba(255,255,255,0.06)", padding: "8px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "10px", color: "rgba(214, 221, 231, 0.55)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span className={watchStatus === "watching" ? "status-dot" : ""} style={watchStatus !== "watching" ? { width: 6, height: 6, borderRadius: 999, background: watchStatus === "error" ? "#ef4444" : "rgba(255,255,255,0.2)" } : {}} />
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
      }>
          <CyberSection
            title="Model"
            caption={modelLabel}
            open={panelOpen.model}
            onToggle={() => togglePanel("model")}
            contentId="panel-model"
            icon={Car}
            color="blue"
          >
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <CyberButton onClick={selectModel} variant="blue">
                  Select Model
                </CyberButton>
              </div>
              {modelLoading ? <div className="text-[10px] text-[#7dd3fc] animate-pulse">Initializing construct...</div> : null}
            </div>
          </CyberSection>

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
                <div className="flex flex-col gap-2">
                  <div className="flex gap-2">
                    <CyberButton onClick={selectTexture} variant="blue">
                      Select Livery
                    </CyberButton>
                    {texturePath ? (
                      <CyberButton
                        variant="ghost"
                        className="w-8 p-0"
                        onClick={() => setTexturePath("")}
                        title="Unload texture"
                      >
                        <X className="h-3 w-3" />
                      </CyberButton>
                    ) : null}
                  </div>
                </div>
                <CyberCard className="mt-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[9px] uppercase text-[#7dd3fc] shrink-0">Target</span>
                    <span className="px-1 py-0.5 bg-[#7dd3fc]/20 text-[#7dd3fc] rounded text-[8px] shrink-0">AUTO</span>
                    <span className="font-mono text-[10px] text-[#C5C6C7] truncate min-w-0">{liveryStatusLabel}</span>
                  </div>
                  <div className="text-[9px] text-[#7dd3fc]/50 mt-1 leading-tight">{liveryHint}</div>
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
                      className={`w-8 h-4 rounded-[2px] border border-[#1F2937] relative transition-colors ${windowTemplateEnabled ? "bg-[#7dd3fc]/20 border-[#7dd3fc]/50" : "bg-[#0B0C10]"}`}
                      onClick={() => setWindowTemplateEnabled((prev) => !prev)}
                    >
                      <div className={`absolute top-0.5 left-0.5 w-2.5 h-2.5 rounded-[2px] bg-[#C5C6C7] transition-transform ${windowTemplateEnabled ? "translate-x-4 bg-[#7dd3fc]" : ""}`} />
                    </button>
                  </div>
                  {windowTemplateEnabled ? (
                    <>
                      <div className="flex gap-2">
                        <CyberButton onClick={selectWindowTexture} variant="blue">
                          Select Glass
                        </CyberButton>
                        {windowTexturePath ? (
                          <CyberButton
                            variant="ghost"
                            className="w-8 p-0"
                            onClick={() => setWindowTexturePath("")}
                            title="Unload window template"
                          >
                            <X className="h-3 w-3" />
                          </CyberButton>
                        ) : null}
                      </div>
                      <div className="mt-1">
                        <CyberLabel>Override Target</CyberLabel>
                        <Select value={liveryWindowOverride || "auto"} onValueChange={(val) => setLiveryWindowOverride(val === "auto" ? "" : val)}>
                          <SelectTrigger className="w-full h-8 text-xs bg-[#0B0C10] border-[#1F2937] text-[#C5C6C7]">
                            <SelectValue placeholder="Select target" />
                          </SelectTrigger>
                          <SelectContent className="bg-[#0B0C10] border-[#1F2937] text-[#C5C6C7]">
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
                    <div className="text-[9px] text-[#7dd3fc]/50">Enable to apply a glass texture overlay.</div>
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
                      className={`w-8 h-4 rounded-[2px] border border-[#1F2937] relative transition-colors ${liveryExteriorOnly ? "bg-[#7dd3fc]/20 border-[#7dd3fc]/50" : "bg-[#0B0C10]"}`}
                      onClick={() => setLiveryExteriorOnly((prev) => !prev)}
                    >
                      <div className={`absolute top-0.5 left-0.5 w-2.5 h-2.5 rounded-[2px] bg-[#C5C6C7] transition-transform ${liveryExteriorOnly ? "translate-x-4 bg-[#7dd3fc]" : ""}`} />
                    </button>
                  </div>
                  <div className="text-[9px] text-[#7dd3fc]/50">Hides interior, glass, and wheel meshes.</div>
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
                <div className="flex flex-col gap-2">
                  <div className="flex gap-2">
                    <CyberButton onClick={selectTexture} variant="blue">
                      Select Texture
                    </CyberButton>
                    {texturePath ? (
                      <CyberButton
                        variant="ghost"
                        className="w-8 p-0"
                        onClick={() => setTexturePath("")}
                        title="Unload texture"
                      >
                        <X className="h-3 w-3" />
                      </CyberButton>
                    ) : null}
                  </div>
                </div>
                <CyberCard className="mt-2">
                  <CyberLabel>Apply To</CyberLabel>
                  <Select value={textureTarget} onValueChange={setTextureTarget}>
                    <SelectTrigger className="w-full h-8 text-xs bg-[#0B0C10] border-[#1F2937] text-[#C5C6C7]">
                      <SelectValue placeholder="Select target" />
                    </SelectTrigger>
                    <SelectContent className="bg-[#0B0C10] border-[#1F2937] text-[#C5C6C7]">
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
                      className={`w-8 h-4 rounded-[2px] border border-[#1F2937] relative transition-colors ${windowTemplateEnabled ? "bg-[#7dd3fc]/20 border-[#7dd3fc]/50" : "bg-[#0B0C10]"}`}
                      onClick={() => setWindowTemplateEnabled((prev) => !prev)}
                    >
                      <div className={`absolute top-0.5 left-0.5 w-2.5 h-2.5 rounded-[2px] bg-[#C5C6C7] transition-transform ${windowTemplateEnabled ? "translate-x-4 bg-[#7dd3fc]" : ""}`} />
                    </button>
                  </div>
                  {windowTemplateEnabled ? (
                    <>
                      <div className="flex gap-2">
                        <CyberButton onClick={selectWindowTexture} variant="blue">
                          Select Secondary
                        </CyberButton>
                        {windowTexturePath ? (
                          <CyberButton
                            variant="ghost"
                            className="w-8 p-0"
                            onClick={() => setWindowTexturePath("")}
                            title="Unload secondary texture"
                          >
                            <X className="h-3 w-3" />
                          </CyberButton>
                        ) : null}
                      </div>
                      {windowTexturePath ? <div className="px-2 py-1 bg-[#1F2833] rounded text-[9px] font-mono text-[#C5C6C7] truncate">{windowTexturePath.split(/[\\/]/).pop()}</div> : null}
                      <Select value={windowTextureTarget} onValueChange={setWindowTextureTarget}>
                        <SelectTrigger className="w-full h-8 text-xs bg-[#0B0C10] border-[#1F2937] text-[#C5C6C7]">
                          <SelectValue placeholder="Select target" />
                        </SelectTrigger>
                        <SelectContent className="bg-[#0B0C10] border-[#1F2937] text-[#C5C6C7]">
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
                    <div className="text-[9px] text-[#7dd3fc]/50">Enable to overlay a secondary texture.</div>
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
                <div className="flex flex-col gap-2">
                  <div className="flex gap-2">
                    <CyberButton onClick={selectTexture} variant="blue">
                      Select Uniform
                    </CyberButton>
                    {texturePath ? (
                      <CyberButton
                        variant="ghost"
                        className="w-8 p-0"
                        onClick={() => setTexturePath("")}
                        title="Unload texture"
                      >
                        <X className="h-3 w-3" />
                      </CyberButton>
                    ) : null}
                  </div>
                </div>
                <CyberCard className="mt-2">
                  <CyberLabel>Apply To</CyberLabel>
                  <Select value={textureTarget} onValueChange={setTextureTarget}>
                    <SelectTrigger className="w-full h-8 text-xs bg-[#0B0C10] border-[#1F2937] text-[#C5C6C7]">
                      <SelectValue placeholder="Select target" />
                    </SelectTrigger>
                    <SelectContent className="bg-[#0B0C10] border-[#1F2937] text-[#C5C6C7]">
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
              <div className="flex bg-[#0B0C10] p-1 border border-[#1F2937] rounded-sm">
                <button
                  type="button"
                  className={`flex-1 flex items-center justify-center gap-2 py-1.5 text-[10px] font-mono uppercase tracking-wider rounded-sm transition-colors ${dualTextureMode === "livery" ? "bg-[#1F2833] text-[#7dd3fc]" : "text-[#7dd3fc]/50 hover:text-[#7dd3fc]"}`}
                  onClick={() => setDualTextureMode("livery")}
                >
                  <Car className="h-3 w-3" />
                  <span>Livery</span>
                </button>
                <button
                  type="button"
                  className={`flex-1 flex items-center justify-center gap-2 py-1.5 text-[10px] font-mono uppercase tracking-wider rounded-sm transition-colors ${dualTextureMode === "eup" ? "bg-[#1F2833] text-[#7dd3fc]" : "text-[#7dd3fc]/50 hover:text-[#7dd3fc]"}`}
                  onClick={() => setDualTextureMode("eup")}
                >
                  <Shirt className="h-3 w-3" />
                  <span>EUP</span>
                </button>
              </div>

              <div className="flex gap-2">
                 <CyberButton 
                    variant={dualSelectedSlot === "A" ? "orange" : "secondary"}
                    onClick={() => setDualSelectedSlot("A")}
                 >
                    Slot A
                 </CyberButton>
                 <CyberButton 
                    variant={dualSelectedSlot === "B" ? "purple" : "secondary"}
                    onClick={() => setDualSelectedSlot("B")}
                 >
                    Slot B
                 </CyberButton>
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
                      <div className="flex gap-1.5">
                        <CyberButton variant="secondary" className="flex-1" onClick={() => selectDualModel("A")}>
                          Select Model A
                        </CyberButton>
                        {dualModelAPath ? (
                          <CyberButton variant="ghost" className="w-8 p-0" onClick={() => { setDualModelAPath(""); setDualModelAError(""); }} title="Unload model A">
                            <X className="h-3 w-3" />
                          </CyberButton>
                        ) : null}
                      </div>
                      {dualModelALoading ? <div className="text-[9px] text-[#f97316] animate-pulse mt-1">Loading...</div> : null}
                      {dualModelAError ? <div className="text-[9px] text-red-400 mt-1">{dualModelAError}</div> : null}
                    </CyberCard>
                    <CyberCard>
                      <CyberLabel>{dualTextureMode === "eup" ? "Uniform" : "Template"}</CyberLabel>
                      <div className="flex gap-1.5">
                        <CyberButton variant="secondary" className="flex-1" onClick={() => selectDualTexture("A")}>
                          {dualTextureMode === "eup" ? "Select Uniform A" : "Select Livery A"}
                        </CyberButton>
                        {dualTextureAPath ? (
                          <CyberButton variant="ghost" className="w-8 p-0" onClick={() => setDualTextureAPath("")} title="Unload texture A">
                            <X className="h-3 w-3" />
                          </CyberButton>
                        ) : null}
                      </div>
                      {dualTextureAPath ? <div className="mt-1 px-2 py-1 bg-[#1F2833] rounded text-[9px] font-mono text-[#C5C6C7] truncate">{getFileLabel(dualTextureAPath, "")}</div> : null}
                    </CyberCard>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    <CyberCard>
                      <CyberLabel>Model</CyberLabel>
                      <div className="flex gap-1.5">
                        <CyberButton variant="secondary" className="flex-1" onClick={() => selectDualModel("B")}>
                          Select Model B
                        </CyberButton>
                        {dualModelBPath ? (
                          <CyberButton variant="ghost" className="w-8 p-0" onClick={() => { setDualModelBPath(""); setDualModelBError(""); }} title="Unload model B">
                            <X className="h-3 w-3" />
                          </CyberButton>
                        ) : null}
                      </div>
                      {dualModelBLoading ? <div className="text-[9px] text-[#a78bfa] animate-pulse mt-1">Loading...</div> : null}
                      {dualModelBError ? <div className="text-[9px] text-red-400 mt-1">{dualModelBError}</div> : null}
                    </CyberCard>
                    <CyberCard>
                      <CyberLabel>{dualTextureMode === "eup" ? "Uniform" : "Template"}</CyberLabel>
                      <div className="flex gap-1.5">
                        <CyberButton variant="secondary" className="flex-1" onClick={() => selectDualTexture("B")}>
                          {dualTextureMode === "eup" ? "Select Uniform B" : "Select Livery B"}
                        </CyberButton>
                        {dualTextureBPath ? (
                          <CyberButton variant="ghost" className="w-8 p-0" onClick={() => setDualTextureBPath("")} title="Unload texture B">
                            <X className="h-3 w-3" />
                          </CyberButton>
                        ) : null}
                      </div>
                      {dualTextureBPath ? <div className="mt-1 px-2 py-1 bg-[#1F2833] rounded text-[9px] font-mono text-[#C5C6C7] truncate">{getFileLabel(dualTextureBPath, "")}</div> : null}
                    </CyberCard>
                  </div>
                )}
              </CyberSection>
            </div>
          ) : null}


          <CyberSection
            title="Colors"
            caption="Body + background"
            open={colorsOpen}
            onToggle={() => setColorsOpen((prev) => !prev)}
            contentId="panel-colors"
            icon={Zap}
            color="blue"
          >
            <div className="space-y-4">
              <div>
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
                    className="flex-1 h-8 bg-transparent border-[rgba(255,255,255,0.08)] text-[#C5C6C7] text-xs"
                    style={{ fontFamily: "var(--font-hud)" }}
                    value={bodyColor}
                    onChange={(event) => setBodyColor(event.currentTarget.value)}
                  />
                  <button
                    type="button"
                    className="w-7 h-7 flex items-center justify-center text-[rgba(230,235,244,0.3)] hover:text-[rgba(230,235,244,0.8)] transition-colors"
                    onClick={() => setBodyColor(DEFAULT_BODY)}
                    title="Revert to default"
                  >
                    <RotateCcw className="h-3 w-3" />
                  </button>
                </div>
              </div>

              <div>
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
                    className="flex-1 h-8 bg-transparent border-[rgba(255,255,255,0.08)] text-[#C5C6C7] text-xs"
                    style={{ fontFamily: "var(--font-hud)" }}
                    value={backgroundColor}
                    onChange={(event) => setBackgroundColor(event.currentTarget.value)}
                  />
                  <button
                    type="button"
                    className="w-7 h-7 flex items-center justify-center text-[rgba(230,235,244,0.3)] hover:text-[rgba(230,235,244,0.8)] transition-colors"
                    onClick={() => setBackgroundColor(DEFAULT_BG)}
                    title="Revert to default"
                  >
                    <RotateCcw className="h-3 w-3" />
                  </button>
                </div>
              </div>

              <div className="border-t border-[rgba(255,255,255,0.06)] pt-3 space-y-3">
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <CyberLabel className="mb-0">Light Intensity</CyberLabel>
                    <span className="text-[10px] text-[rgba(230,235,244,0.5)]" style={{ fontFamily: "var(--font-hud)" }}>{lightIntensity.toFixed(1)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min="0.5"
                      max="2.0"
                      step="0.1"
                      className="flex-1 accent-[#7dd3fc] h-1 bg-[rgba(255,255,255,0.1)] rounded-lg appearance-none cursor-pointer"
                      value={lightIntensity}
                      onChange={(e) => setLightIntensity(parseFloat(e.target.value))}
                    />
                    <button
                      type="button"
                      className="w-6 h-6 flex items-center justify-center text-[rgba(230,235,244,0.3)] hover:text-[rgba(230,235,244,0.8)] transition-colors"
                      onClick={() => setLightIntensity(1.0)}
                      title="Reset Lighting"
                    >
                      <RotateCcw className="h-3 w-3" />
                    </button>
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <CyberLabel className="mb-0">Glossiness</CyberLabel>
                    <span className="text-[10px] text-[rgba(230,235,244,0.5)]" style={{ fontFamily: "var(--font-hud)" }}>{Math.round(glossiness * 100)}%</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min="0.0"
                      max="1.0"
                      step="0.05"
                      className="flex-1 accent-[#7dd3fc] h-1 bg-[rgba(255,255,255,0.1)] rounded-lg appearance-none cursor-pointer"
                      value={glossiness}
                      onChange={(e) => setGlossiness(parseFloat(e.target.value))}
                    />
                    <button
                      type="button"
                      className="w-6 h-6 flex items-center justify-center text-[rgba(230,235,244,0.3)] hover:text-[rgba(230,235,244,0.8)] transition-colors"
                      onClick={() => setGlossiness(0.5)}
                      title="Reset Gloss"
                    >
                      <RotateCcw className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </CyberSection>

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
            textureAReloadToken={dualTextureAReloadToken}
            textureBReloadToken={dualTextureBReloadToken}
            bodyColor={bodyColor}
            backgroundColor={backgroundColor}
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
          />
        ) : (
          <Viewer
            modelPath={modelPath}
            texturePath={texturePath}
            windowTexturePath={windowTemplateEnabled ? windowTexturePath : ""}
            bodyColor={bodyColor}
            backgroundColor={backgroundColor}
            showGrid={showGrid}
            textureReloadToken={textureReloadToken}
            windowTextureReloadToken={windowTextureReloadToken}
            textureTarget={resolvedTextureTarget}
            windowTextureTarget={resolvedWindowTextureTarget}
            textureMode={textureMode}
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
                    onClick={() => {
                      if (update.url) {
                        if (isTauriRuntime) {
                          openUrl(update.url).catch(() => window.open(update.url, "_blank"));
                        } else {
                          window.open(update.url, "_blank");
                        }
                      }
                    }}
                  >
                    Download Update
                  </button>

                  <button
                    type="button"
                    className="update-toast-dismiss-btn"
                    onClick={update.dismiss}
                  >
                    Not now
                  </button>
                </div>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
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
                      setTexturePath("");
                      setTextureError("");
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
                      try { await openUrl(previewOutputPath); } catch {}
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
