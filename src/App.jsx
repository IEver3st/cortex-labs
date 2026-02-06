import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readFile } from "@tauri-apps/plugin-fs";
import { AlertTriangle, ArrowUpRight, Car, ChevronLeft, ChevronRight, Eye, EyeOff, FolderOpen, History, Layers, Link2, Minus, PanelLeft, PanelTop, RotateCcw, Shirt, Square, Unlink, X, Aperture, Disc, Zap } from "lucide-react";
import { categorizeTextures } from "./lib/ytd";
import YtdWorker from "./lib/ytd.worker.js?worker";
import { useUpdateChecker } from "./lib/updater";
import { openUrl } from "@tauri-apps/plugin-opener";
import appMeta from "../package.json";
import AppLoader, { LoadingGlyph } from "./components/AppLoader";
import Onboarding from "./components/Onboarding";
import SettingsMenu from "./components/SettingsMenu";
import Viewer from "./components/Viewer";
import DualModelViewer from "./components/DualModelViewer";
import YtdBrowser from "./components/YtdBrowser";
import { loadOnboarded, loadPrefs, savePrefs, setOnboarded, saveSession, loadSession, clearSession } from "./lib/prefs";
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
  extrasDefaultEnabled: true,
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



function App() {
  const viewerApiRef = useRef(null);
  const reloadTimerRef = useRef({ primary: null, window: null });
  const isTauriRuntime =
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__ !== "undefined" &&
    typeof window.__TAURI_INTERNALS__?.invoke === "function";

  // Auto-update checker — polls GitHub releases for newer versions
  const update = useUpdateChecker(appMeta.version);

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
  const [lightIntensity, setLightIntensity] = useState(() => getInitialDefaults().lightIntensity ?? 1.0);
  const [glossiness, setGlossiness] = useState(() => getInitialDefaults().glossiness ?? 0.5);
  const [experimentalSettings, setExperimentalSettings] = useState(() => Boolean(getInitialDefaults().experimentalSettings));
  const [windowControlsStyle, setWindowControlsStyle] = useState(() => getInitialDefaults().windowControlsStyle || "windows");
  const [toolbarInTitlebar, setToolbarInTitlebar] = useState(() => Boolean(getInitialDefaults().toolbarInTitlebar));
  const [colorsOpen, setColorsOpen] = useState(() => getInitialUi().colorsOpen);

  const [panelOpen, setPanelOpen] = useState(() => ({
    model: true,
    templates: true,
    targeting: true,
    overlays: false,
    view: true,
    extras: true,
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
  const [ytdPath, setYtdPath] = useState("");
  const [ytdTextures, setYtdTextures] = useState(null);
  const [ytdRawTextures, setYtdRawTextures] = useState(null);
  const [ytdLoading, setYtdLoading] = useState(false);
  const [ytdBrowserOpen, setYtdBrowserOpen] = useState(false);
  const [ytdOverrides, setYtdOverrides] = useState({});
  const [isDragging, setIsDragging] = useState(false);

  // Shared YTD textures (vehshare, vehshare_worn, etc.) — bundled with the app.
  // These are loaded once and merged into the texture lookup at lowest priority.
  const [sharedYtdTextures, setSharedYtdTextures] = useState(null);
  const sharedYtdLoadedRef = useRef(false);
  const sharedYtdLoadingRef = useRef(false);
  const loadSharedYtdsRef = useRef(null);

  // Holds the raw YTD file bytes so the worker can decode specific textures
  // on demand without re-reading the file.
  const ytdBytesRef = useRef(null);

  // Persistent YTD decode worker — reused across decode calls to avoid
  // the overhead of creating/destroying workers and to benefit from the
  // worker's internal decompression cache.
  const ytdDecodeWorkerRef = useRef(null);

  // Dual-model (multi-model) state
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

  // YTD mapping results for the inline viewer
  const [ytdMappingMeta, setYtdMappingMeta] = useState(null);

  const [modelExtras, setModelExtras] = useState([]);
  const [hiddenExtras, setHiddenExtras] = useState([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [viewerReady, setViewerReady] = useState(false);
  const [booted, setBooted] = useState(false);
  const [formatWarning, setFormatWarning] = useState(null); // { type: "16bit-psd", bitDepth: 16 }
  const bootStartRef = useRef(typeof performance !== "undefined" ? performance.now() : Date.now());
  const bootTimerRef = useRef(null);

  // Session restore state
  const [pendingSession, setPendingSession] = useState(() => loadSession());
  const [sessionPromptDismissed, setSessionPromptDismissed] = useState(false);
  // Track dual-model positions (updated by DualModelViewer via callback)
  const [dualModelAPos, setDualModelAPos] = useState([0, 0, 0]);
  const [dualModelBPos, setDualModelBPos] = useState([0, 0, 3]);

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
      setModelExtras([]);
      setHiddenExtras([]);

      setModelSourcePath(path);
      setModelLoading(true);

      // Proactively load shared YTDs for any vehicle model (YFT/YDD)
      if (experimentalSettings && (lower.endsWith(".yft") || lower.endsWith(".ydd"))) {
        loadSharedYtdsRef.current?.();
      }

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

  // ─── Auto-save session whenever meaningful state changes ───
  const sessionSaveTimerRef = useRef(null);
  useEffect(() => {
    // Don't save during boot / before onboarding
    if (isBooting || showOnboarding) return;
    // Don't save if nothing is loaded
    const hasContent = modelPath || dualModelAPath || dualModelBPath || texturePath || dualTextureAPath || dualTextureBPath;
    if (!hasContent) return;

    if (sessionSaveTimerRef.current) clearTimeout(sessionSaveTimerRef.current);
    sessionSaveTimerRef.current = setTimeout(() => {
      saveSession({
        textureMode,
        // Standard viewer state
        modelPath: modelPath || "",
        texturePath: texturePath || "",
        windowTexturePath: windowTexturePath || "",
        windowTemplateEnabled,
        bodyColor,
        backgroundColor,
        liveryExteriorOnly,
        ytdPath: ytdPath || "",
        // Multi-model state
        dualModelAPath: dualModelAPath || "",
        dualModelBPath: dualModelBPath || "",
        dualTextureAPath: dualTextureAPath || "",
        dualTextureBPath: dualTextureBPath || "",
        dualModelAPos,
        dualModelBPos,
        dualSelectedSlot,
        dualTextureMode,
      });
    }, 1000);

    return () => {
      if (sessionSaveTimerRef.current) clearTimeout(sessionSaveTimerRef.current);
    };
  }, [
    isBooting, showOnboarding, textureMode,
    modelPath, texturePath, windowTexturePath, windowTemplateEnabled,
    bodyColor, backgroundColor, liveryExteriorOnly, ytdPath,
    dualModelAPath, dualModelBPath, dualTextureAPath, dualTextureBPath,
    dualModelAPos, dualModelBPos, dualSelectedSlot, dualTextureMode,
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
    // Extras
    const extras = info?.extras ?? [];
    setModelExtras(extras);
    const extrasEnabled = getInitialDefaults().extrasDefaultEnabled ?? true;
    setHiddenExtras(extrasEnabled ? [] : extras.map((e) => e.name));
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
    setTextureMode(merged.textureMode);
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
    setWindowControlsStyle(merged.windowControlsStyle || "windows");
    setToolbarInTitlebar(Boolean(merged.toolbarInTitlebar));
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

  const restoreSession = useCallback((session) => {
    if (!session) return;
    // Restore texture mode
    if (session.textureMode) setTextureMode(session.textureMode);
    // Standard viewer
    if (session.modelPath) loadModel(session.modelPath);
    if (session.texturePath) setTexturePath(session.texturePath);
    if (session.windowTexturePath) setWindowTexturePath(session.windowTexturePath);
    if (typeof session.windowTemplateEnabled === "boolean") setWindowTemplateEnabled(session.windowTemplateEnabled);
    if (session.bodyColor) setBodyColor(session.bodyColor);
    if (session.backgroundColor) setBackgroundColor(session.backgroundColor);
    if (typeof session.liveryExteriorOnly === "boolean") setLiveryExteriorOnly(session.liveryExteriorOnly);
    // Multi-model
    if (session.dualModelAPath) setDualModelAPath(session.dualModelAPath);
    if (session.dualModelBPath) setDualModelBPath(session.dualModelBPath);
    if (session.dualTextureAPath) setDualTextureAPath(session.dualTextureAPath);
    if (session.dualTextureBPath) setDualTextureBPath(session.dualTextureBPath);
    if (session.dualSelectedSlot) setDualSelectedSlot(session.dualSelectedSlot);
    if (session.dualTextureMode) setDualTextureMode(session.dualTextureMode);
    if (session.dualModelAPos) setDualModelAPos(session.dualModelAPos);
    if (session.dualModelBPos) setDualModelBPos(session.dualModelBPos);
    // Dismiss prompt
    setSessionPromptDismissed(true);
    setPendingSession(null);
  }, [loadModel]);

  const dismissSession = useCallback(() => {
    setSessionPromptDismissed(true);
    setPendingSession(null);
    clearSession();
  }, []);

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

  // Decode specific YTD textures by name. Reuses a persistent worker
  // to avoid worker creation overhead and to benefit from the worker's
  // internal decompression/metadata cache across successive decode calls.
  const decodeYtdTextures = useCallback(async (names) => {
    const rawBytes = ytdBytesRef.current;
    if (!rawBytes || names.length === 0) return {};

    // Lazily create the persistent decode worker
    if (!ytdDecodeWorkerRef.current) {
      ytdDecodeWorkerRef.current = new YtdWorker();
    }
    const worker = ytdDecodeWorkerRef.current;

    return new Promise((resolve, reject) => {
      // Temporarily override handlers for this request
      const prevOnMessage = worker.onmessage;
      const prevOnError = worker.onerror;

      worker.onmessage = (e) => {
        // Restore previous handlers
        worker.onmessage = prevOnMessage;
        worker.onerror = prevOnError;
        if (e.data.error) reject(new Error(e.data.error));
        else resolve(e.data.textures || {});
      };
      worker.onerror = (err) => {
        worker.onmessage = prevOnMessage;
        worker.onerror = prevOnError;
        // Worker errored fatally — recreate it next time
        ytdDecodeWorkerRef.current = null;
        reject(err);
      };
      // Send a copy of the bytes (slice) so the original stays available
      const copy = rawBytes.slice(0);
      worker.postMessage({ type: "decode", bytes: copy, names }, [copy]);
    });
  }, []);

  // ─── Load bundled shared YTD texture dictionaries (vehshare, etc.) ───
  // Called once when the first model-specific YTD is loaded. These provide
  // fallback textures that nearly all GTA V vehicles reference.
  const loadSharedYtds = useCallback(async () => {
    if (sharedYtdLoadedRef.current || sharedYtdLoadingRef.current) return;
    sharedYtdLoadingRef.current = true;

    try {
      const manifestRes = await fetch("/shared-ytd/manifest.json");
      if (!manifestRes.ok) {
        console.warn("[SharedYTD] No manifest found — skipping shared textures");
        return;
      }
      const filenames = await manifestRes.json();
      if (!Array.isArray(filenames) || filenames.length === 0) return;

      console.log("[SharedYTD] Loading", filenames.length, "shared YTD files...");
      const merged = {};

      for (const filename of filenames) {
        try {
          const res = await fetch(`/shared-ytd/${filename}`);
          if (!res.ok) {
            console.warn(`[SharedYTD] Failed to fetch ${filename}:`, res.status);
            continue;
          }
          const arrayBuf = await res.arrayBuffer();
          const bytes = new Uint8Array(arrayBuf);

          // Parse metadata-only in a worker (same as regular YTD loading)
          const textures = await new Promise((resolve, reject) => {
            const worker = new YtdWorker();
            worker.onmessage = (e) => {
              worker.terminate();
              if (e.data.error) reject(new Error(e.data.error));
              else resolve(e.data.textures);
            };
            worker.onerror = (err) => {
              worker.terminate();
              reject(err);
            };
            const copy = arrayBuf.slice(0);
            worker.postMessage({ type: "parse", bytes: copy }, [copy]);
          });

          if (textures && Object.keys(textures).length > 0) {
            for (const [name, tex] of Object.entries(textures)) {
              merged[name] = { ...tex, sourceYtd: filename };
            }
            console.log(`[SharedYTD] ${filename}: ${Object.keys(textures).length} textures`);
          }
        } catch (err) {
          console.warn(`[SharedYTD] Error loading ${filename}:`, err);
        }
      }

      if (Object.keys(merged).length > 0) {
        setSharedYtdTextures(merged);
        sharedYtdLoadedRef.current = true;
        console.log("[SharedYTD] Total shared textures loaded:", Object.keys(merged).length);
      }
    } catch (err) {
      console.warn("[SharedYTD] Failed to load shared textures:", err);
    } finally {
      sharedYtdLoadingRef.current = false;
    }
  }, []);
  loadSharedYtdsRef.current = loadSharedYtds;

  // Decode shared YTD textures by name — fetches the source .ytd file,
  // decodes only the requested textures, and returns them.
  const decodeSharedYtdTextures = useCallback(async (names) => {
    if (!sharedYtdTextures || names.length === 0) return {};

    // Build case-insensitive lookup for shared textures
    const lowerLookup = {};
    for (const [k, v] of Object.entries(sharedYtdTextures)) {
      lowerLookup[k.toLowerCase()] = { ...v, originalKey: k };
    }

    // Group requested names by their source YTD file
    const bySource = {};
    for (const name of names) {
      const entry = lowerLookup[name.toLowerCase()];
      if (!entry?.sourceYtd) continue;
      if (!bySource[entry.sourceYtd]) bySource[entry.sourceYtd] = [];
      bySource[entry.sourceYtd].push(entry.originalKey || name);
    }

    const allDecoded = {};
    for (const [filename, texNames] of Object.entries(bySource)) {
      try {
        const res = await fetch(`/shared-ytd/${filename}`);
        if (!res.ok) continue;
        const arrayBuf = await res.arrayBuffer();

        const decoded = await new Promise((resolve, reject) => {
          const worker = new YtdWorker();
          worker.onmessage = (e) => {
            worker.terminate();
            if (e.data.error) reject(new Error(e.data.error));
            else resolve(e.data.textures || {});
          };
          worker.onerror = (err) => {
            worker.terminate();
            reject(err);
          };
          const copy = arrayBuf.slice(0);
          worker.postMessage({ type: "decode", bytes: copy, names: texNames }, [copy]);
        });

        Object.assign(allDecoded, decoded);
      } catch (err) {
        console.warn(`[SharedYTD] Decode error for ${filename}:`, err);
      }
    }
    return allDecoded;
  }, [sharedYtdTextures]);

  const loadYtd = async (path) => {
    setYtdLoading(true);
    try {
      const bytes = await readFile(path);
      // Keep the raw bytes for on-demand texture decoding later
      ytdBytesRef.current = bytes.buffer;

      // Phase 1: metadata-only parse in a Web Worker (fast, no RGBA decoding)
      const textures = await new Promise((resolve, reject) => {
        const worker = new YtdWorker();
        worker.onmessage = (e) => {
          worker.terminate();
          if (e.data.error) reject(new Error(e.data.error));
          else resolve(e.data.textures);
        };
        worker.onerror = (err) => {
          worker.terminate();
          reject(err);
        };
        // Send a copy so the original ref stays usable for Phase 2
        const copy = bytes.buffer.slice(0);
        worker.postMessage({ type: "parse", bytes: copy }, [copy]);
      });
      if (textures && Object.keys(textures).length > 0) {
        const categorized = categorizeTextures(textures);
        setYtdPath(path);
        setYtdTextures(categorized);
        setYtdRawTextures(textures);
        setYtdOverrides({});
        console.log("[YTD] Loaded textures:", Object.keys(textures));
        // Trigger shared YTD loading alongside the model-specific YTD
        loadSharedYtds();
      } else {
        // Only show error dialog if explicit user action, but for auto-load just log
        console.warn("No textures found in YTD file:", path);
      }
    } catch (err) {
      console.error("[YTD] Load error:", err);
    } finally {
      setYtdLoading(false);
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
        await loadYtd(selected);
      }
    } catch (error) {
      setDialogError("Dialog permission blocked. Check Tauri capabilities.");
      console.error(error);
    }
  };

  const clearYtd = () => {
    setYtdPath("");
    setYtdTextures(null);
    setYtdRawTextures(null);
    setYtdMappingMeta(null);
    setYtdOverrides({});
    ytdBytesRef.current = null;
    // Terminate the persistent decode worker to free memory
    if (ytdDecodeWorkerRef.current) {
      ytdDecodeWorkerRef.current.terminate();
      ytdDecodeWorkerRef.current = null;
    }
  };

  // YTD override handler — user changed a texture's material assignment in the browser
  const handleYtdOverride = useCallback((textureName, materialName) => {
    setYtdOverrides((prev) => {
      const next = { ...prev };
      if (materialName === null) {
        // Unassign — store explicit null
        next[textureName] = null;
      } else {
        next[textureName] = materialName;
      }
      return next;
    });
    // Update the local meta so the modal reflects it instantly
    setYtdMappingMeta((prev) => {
      if (!prev?.assignments) return prev;
      const updated = prev.assignments.map((a) =>
        a.textureName === textureName ? { ...a, materialName: materialName } : a
      );
      return { ...prev, assignments: updated };
    });
  }, []);

  // Dual-model file selectors
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
        case HOTKEY_ACTIONS.MODE_MULTI:
          setTextureMode("multi");
          break;
        case HOTKEY_ACTIONS.CYCLE_MODE:
          setTextureMode((prev) => {
            if (prev === "livery") return "everything";
            if (prev === "everything") return "eup";
            if (prev === "eup") return "multi";
            if (prev === "multi") return "livery";
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
  const extrasLabel = modelExtras.length === 0
    ? "No extras"
    : `${modelExtras.length - hiddenExtras.length}/${modelExtras.length} visible`;

  const toggleExtra = useCallback((extraName) => {
    setHiddenExtras((prev) =>
      prev.includes(extraName)
        ? prev.filter((n) => n !== extraName)
        : [...prev, extraName]
    );
  }, []);

  const showAllExtras = useCallback(() => setHiddenExtras([]), []);
  const hideAllExtras = useCallback(() => setHiddenExtras(modelExtras.map((e) => e.name)), [modelExtras]);

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
            <img src="/app-icon.svg" alt="" className="titlebar-logo" aria-hidden="true" />
            <span className="titlebar-title">Cortex Studio</span>
          </div>

          <div className="titlebar-mode-tabs" role="tablist" aria-label="Editor mode">
            <button
              type="button"
              role="tab"
              className={`titlebar-mode-tab ${textureMode === "livery" ? "is-active" : ""}`}
              onClick={() => setTextureMode("livery")}
              aria-selected={textureMode === "livery"}
            >
              <Car className="titlebar-mode-tab-icon" aria-hidden="true" />
              <span>Livery</span>
            </button>
            <button
              type="button"
              role="tab"
              className={`titlebar-mode-tab ${textureMode === "everything" ? "is-active" : ""}`}
              onClick={() => setTextureMode("everything")}
              aria-selected={textureMode === "everything"}
            >
              <Layers className="titlebar-mode-tab-icon" aria-hidden="true" />
              <span>All</span>
            </button>
            <button
              type="button"
              role="tab"
              className={`titlebar-mode-tab ${textureMode === "eup" ? "is-active" : ""}`}
              onClick={() => setTextureMode("eup")}
              aria-selected={textureMode === "eup"}
            >
              <Shirt className="titlebar-mode-tab-icon" aria-hidden="true" />
              <span>EUP</span>
            </button>
            <button
              type="button"
              role="tab"
              className={`titlebar-mode-tab ${textureMode === "multi" ? "is-active" : ""}`}
              onClick={() => setTextureMode("multi")}
              aria-selected={textureMode === "multi"}
            >
              <Link2 className="titlebar-mode-tab-icon" aria-hidden="true" />
              <span>Multi</span>
            </button>
          </div>

          <div className="titlebar-spacer" data-tauri-drag-region />

          {toolbarInTitlebar && textureMode !== "multi" ? (
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
            </div>
          ) : null}

          <button
            type="button"
            className={`titlebar-btn titlebar-dock-toggle ${toolbarInTitlebar ? "is-docked" : ""}`}
            onClick={() => {
              const next = !toolbarInTitlebar;
              setToolbarInTitlebar(next);
              const prefs = loadPrefs() || {};
              const d = { ...(prefs.defaults || {}), toolbarInTitlebar: next };
              savePrefs({ ...prefs, defaults: d });
            }}
            aria-label={toolbarInTitlebar ? "Undock controls from titlebar" : "Dock controls to titlebar"}
            data-tauri-drag-region="false"
            title={toolbarInTitlebar ? "Undock controls from titlebar" : "Dock controls to titlebar"}
          >
            <PanelTop className="titlebar-icon" />
          </button>

          <button
            type="button"
            className="titlebar-btn titlebar-panel-toggle"
            onClick={() => setPanelCollapsed((prev) => !prev)}
            aria-label={panelCollapsed ? "Show control panel" : "Hide control panel"}
            data-tauri-drag-region="false"
          >
            <PanelLeft className="titlebar-icon" />
          </button>
          <SettingsMenu
            defaults={defaults}
            builtInDefaults={BUILT_IN_DEFAULTS}
            onSave={applyAndPersistDefaults}
            hotkeys={hotkeys}
            onSaveHotkeys={saveHotkeys}
          />
          {windowControlsStyle === "mac" ? (
            <div className="titlebar-controls titlebar-controls--mac">
              <button
                type="button"
                className="mac-btn mac-close"
                onClick={handleClose}
                aria-label="Close"
                data-tauri-drag-region="false"
              />
              <button
                type="button"
                className="mac-btn mac-min"
                onClick={handleMinimize}
                aria-label="Minimize"
                data-tauri-drag-region="false"
              />
              <button
                type="button"
                className="mac-btn mac-max"
                onClick={handleMaximize}
                aria-label="Maximize"
                data-tauri-drag-region="false"
              />
            </div>
          ) : (
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
          )}

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
            {experimentalSettings && textureMode !== "multi" ? (
              <CyberCard className="mt-2">
                <div className="flex items-center justify-between mb-2">
                  <CyberLabel className="mb-0">YTD Textures</CyberLabel>
                  {ytdTextures ? (
                    <span className="text-[9px] font-mono text-[#a78bfa]">
                      {Object.keys(ytdTextures.diffuse).length}D {Object.keys(ytdTextures.normal).length}N {Object.keys(ytdTextures.specular).length}S
                    </span>
                  ) : null}
                </div>
                <div className="flex gap-1.5 mb-2">
                  <CyberButton
                    variant="purple"
                    className="flex-1 h-7 text-[9px]"
                    onClick={selectYtd}
                    disabled={ytdLoading}
                  >
                    <FolderOpen className="h-3 w-3 mr-1.5" />
                    {ytdLoading ? "Loading…" : "Load YTD"}
                  </CyberButton>
                  {ytdPath ? (
                    <CyberButton
                      variant="ghost"
                      className="h-7 px-2 text-[#a78bfa]/60 hover:text-[#a78bfa]"
                      onClick={clearYtd}
                      title="Unload YTD"
                    >
                      <X className="h-3 w-3" />
                      Unload
                    </CyberButton>
                  ) : null}
                  {ytdRawTextures ? (
                    <CyberButton
                      variant="ghost"
                      className="h-7 px-2 text-[#a78bfa]/60 hover:text-[#a78bfa]"
                      onClick={() => setYtdBrowserOpen(true)}
                      title={`View Textures${ytdMappingMeta?.assignments?.length ? ` (${ytdMappingMeta.assignments.length})` : ""}`}
                    >
                      <Eye className="h-3 w-3" />
                      Browse
                    </CyberButton>
                  ) : null}
                </div>
                {ytdPath ? <div className="px-2 py-1 bg-[#1F2833] rounded text-[9px] font-mono text-[#C5C6C7] truncate">{ytdPath.split(/[\\/]/).pop()}</div> : null}
                {!ytdPath ? <div className="text-[9px] text-[#a78bfa]/50 mt-1">Auto-maps diffuse, normal &amp; specular.</div> : null}
              </CyberCard>
            ) : null}
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
                  <div className="flex justify-between items-center">
                    <span className="font-mono text-[9px] uppercase text-[#7dd3fc]">Target</span>
                    <span className="font-mono text-[10px] text-[#C5C6C7] text-right truncate max-w-[120px]">
                      <span className="px-1 py-0.5 bg-[#7dd3fc]/20 text-[#7dd3fc] rounded text-[8px] mr-1">AUTO</span>
                      {liveryStatusLabel}
                    </span>
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
            title="Extras"
            caption={extrasLabel}
            open={panelOpen.extras}
            onToggle={() => togglePanel("extras")}
            contentId="panel-extras"
          >
            {modelExtras.length > 0 ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <CyberLabel>Vehicle Extras</CyberLabel>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      className="text-[8px] text-[rgba(230,235,244,0.5)] hover:text-[rgba(230,235,244,0.9)] px-1.5 py-0.5 rounded border border-[rgba(255,255,255,0.08)] hover:border-[rgba(255,255,255,0.2)] transition-colors uppercase tracking-wider"
                      style={{ fontFamily: "var(--font-hud)" }}
                      onClick={showAllExtras}
                    >
                      All
                    </button>
                    <button
                      type="button"
                      className="text-[8px] text-[rgba(230,235,244,0.5)] hover:text-[rgba(230,235,244,0.9)] px-1.5 py-0.5 rounded border border-[rgba(255,255,255,0.08)] hover:border-[rgba(255,255,255,0.2)] transition-colors uppercase tracking-wider"
                      style={{ fontFamily: "var(--font-hud)" }}
                      onClick={hideAllExtras}
                    >
                      None
                    </button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  {modelExtras.map((extra) => {
                    const isVisible = !hiddenExtras.includes(extra.name);
                    return (
                      <div key={extra.name} className="flex items-center justify-between py-0.5">
                        <span className="text-[10px] text-[rgba(230,235,244,0.75)]" style={{ fontFamily: "var(--font-hud)" }}>{extra.label}</span>
                        <button
                          type="button"
                          className={`w-7 h-3.5 rounded-full relative transition-colors ${isVisible ? "bg-[#7dd3fc]/25" : "bg-[rgba(255,255,255,0.08)]"}`}
                          onClick={() => toggleExtra(extra.name)}
                          aria-pressed={isVisible}
                          aria-label={`Toggle ${extra.label}`}
                        >
                          <div className={`absolute top-[2px] w-2.5 h-2.5 rounded-full transition-all ${isVisible ? "left-[14px] bg-[#7dd3fc]" : "left-[2px] bg-[rgba(230,235,244,0.35)]"}`} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="text-[10px] text-[rgba(230,235,244,0.35)]" style={{ fontFamily: "var(--font-hud)" }}>
                No extras detected. Load a model with vehicle extras.
              </div>
            )}
          </CyberSection>

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
            ytdTextures={experimentalSettings ? ytdTextures : null}
            ytdRawTextures={experimentalSettings ? ytdRawTextures : null}
            ytdOverrides={experimentalSettings ? ytdOverrides : {}}
            decodeYtdTextures={experimentalSettings ? decodeYtdTextures : null}
            sharedYtdTextures={experimentalSettings ? sharedYtdTextures : null}
            decodeSharedYtdTextures={experimentalSettings ? decodeSharedYtdTextures : null}
            lightIntensity={lightIntensity}
            glossiness={glossiness}
            hiddenExtras={hiddenExtras}
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
            onYtdMappingUpdate={experimentalSettings ? setYtdMappingMeta : undefined}
            onYtdFound={experimentalSettings ? loadYtd : undefined}
          />
        )}

        <AnimatePresence>
          {(modelLoading || (textureMode === "multi" && (dualModelALoading || dualModelBLoading))) ? <AppLoader variant="background" /> : null}
        </AnimatePresence>

        {!(toolbarInTitlebar && textureMode !== "multi") ? (
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
                  {textureMode === "multi" ? (
                    <>
                      <motion.div layout className="viewer-toolbar-group">
                        <Button
                          size="sm"
                          variant="ghost"
                          className={`toolbar-btn ${dualSelectedSlot === "A" ? "toolbar-btn--slot-a" : ""}`}
                          onClick={() => setDualSelectedSlot("A")}
                        >
                          <span className="toolbar-slot-letter toolbar-slot-letter--a">A</span>
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className={`toolbar-btn ${dualSelectedSlot === "B" ? "toolbar-btn--slot-b" : ""}`}
                          onClick={() => setDualSelectedSlot("B")}
                        >
                          <span className="toolbar-slot-letter toolbar-slot-letter--b">B</span>
                        </Button>
                      </motion.div>
                      <div className="toolbar-divider" />
                      <motion.div layout className="viewer-toolbar-group">
                        <Button size="sm" variant="ghost" className="toolbar-btn" onClick={() => setDualGizmoVisible((p) => !p)} title={dualGizmoVisible ? "Hide gizmo" : "Show gizmo"}>
                          {dualGizmoVisible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                        </Button>
                        <Button size="sm" variant="ghost" className="toolbar-btn" onClick={() => dualViewerApiRef.current?.snapTogether?.()}>
                          <Link2 className="w-3 h-3 mr-1" />Snap
                        </Button>
                        <Button size="sm" variant="ghost" className="toolbar-btn" onClick={() => dualViewerApiRef.current?.reset?.()}>
                          Center
                        </Button>
                      </motion.div>
                    </>
                  ) : (
                    <>
                      <motion.div layout className="viewer-toolbar-group">
                        <Button size="sm" variant="ghost" className="toolbar-btn" onClick={() => viewerApiRef.current?.setPreset("front")}>
                          Front
                        </Button>
                        <Button size="sm" variant="ghost" className="toolbar-btn" onClick={() => viewerApiRef.current?.setPreset("back")}>
                          Back
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
                          <span className="mono mr-1 text-red-400">X</span>{!hideRotText && "Rot"}
                        </Button>
                        <Button size="sm" variant="ghost" className="toolbar-btn" onClick={() => viewerApiRef.current?.rotateModel("y")} title="Rotate 90° on Y axis">
                          <span className="mono mr-1 text-green-400">Y</span>{!hideRotText && "Rot"}
                        </Button>
                        <Button size="sm" variant="ghost" className="toolbar-btn" onClick={() => viewerApiRef.current?.rotateModel("z")} title="Rotate 90° on Z axis">
                          <span className="mono mr-1 text-blue-400">Z</span>{!hideRotText && "Rot"}
                        </Button>
                      </motion.div>
                    </>
                  )}
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
        ) : null}

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
      <AnimatePresence>
        {!isBooting && showOnboarding ? (
          <Onboarding initialDefaults={defaults} onComplete={completeOnboarding} />
        ) : null}
      </AnimatePresence>

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

      {/* Session Restore Prompt */}
      <AnimatePresence>
        {!isBooting && !showOnboarding && pendingSession && !sessionPromptDismissed ? (
          <motion.div
            className="session-prompt-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
          >
            <motion.div
              className="session-prompt"
              initial={{ opacity: 0, y: 20, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.96 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="session-prompt-icon-row">
                <History className="session-prompt-icon" />
              </div>
              <div className="session-prompt-title">Previous Session Detected</div>
              <div className="session-prompt-description">
                {pendingSession.textureMode === "multi"
                  ? `You were working in Multi-Model mode${pendingSession.dualModelAPath ? ` with ${pendingSession.dualModelAPath.split(/[\\/]/).pop()}` : ""}${pendingSession.dualModelBPath ? ` + ${pendingSession.dualModelBPath.split(/[\\/]/).pop()}` : ""}.`
                  : `You had ${pendingSession.modelPath ? pendingSession.modelPath.split(/[\\/]/).pop() : "a model"} loaded${pendingSession.texturePath ? ` with a ${pendingSession.textureMode || "texture"} template` : ""}.`}
              </div>
              <div className="session-prompt-meta">
                {pendingSession.savedAt
                  ? `Saved ${new Date(pendingSession.savedAt).toLocaleString()}`
                  : ""}
              </div>
              <div className="session-prompt-actions">
                <button
                  type="button"
                  className="session-prompt-btn session-prompt-btn--dismiss"
                  onClick={dismissSession}
                >
                  Start Fresh
                </button>
                <button
                  type="button"
                  className="session-prompt-btn session-prompt-btn--restore"
                  onClick={() => restoreSession(pendingSession)}
                >
                  Continue Session
                </button>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* YTD Texture Browser Modal */}
      {experimentalSettings ? (
        <YtdBrowser
          open={ytdBrowserOpen}
          onClose={() => setYtdBrowserOpen(false)}
          rawTextures={ytdRawTextures}
          categorizedTextures={ytdTextures}
          mappingMeta={ytdMappingMeta}
          materialNames={ytdMappingMeta?.materialNames || []}
          onOverride={handleYtdOverride}
        />
      ) : null}
    </motion.div>
  );
}

export default App;
