import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readFile } from "@tauri-apps/plugin-fs";
import { AlertTriangle, Car, ChevronLeft, ChevronRight, Eye, EyeOff, FolderOpen, History, Layers, Link2, Minus, RotateCcw, Shirt, Square, Unlink, X } from "lucide-react";
import { categorizeTextures } from "./lib/ytd";
import YtdWorker from "./lib/ytd.worker.js?worker";
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
  showHints: true,
  hideRotText: false,
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
  const [showHints, setShowHints] = useState(() => Boolean(getInitialDefaults().showHints ?? true));
  const [hideRotText, setHideRotText] = useState(() => Boolean(getInitialDefaults().hideRotText));
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

  // Holds the raw YTD file bytes so the worker can decode specific textures
  // on demand without re-reading the file.
  const ytdBytesRef = useRef(null);

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

  // YTD mapping results for the inline viewer
  const [ytdMappingMeta, setYtdMappingMeta] = useState(null);

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
    dualModelAPos, dualModelBPos, dualSelectedSlot,
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

  // Decode specific YTD textures by name. Spins up a short-lived worker
  // that re-parses the cached raw bytes but only decodes the requested names.
  const decodeYtdTextures = useCallback(async (names) => {
    const rawBytes = ytdBytesRef.current;
    if (!rawBytes || names.length === 0) return {};

    return new Promise((resolve, reject) => {
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
      // Send a copy of the bytes (slice) so the original stays available for
      // future decode requests (e.g. when the user opens the YTD browser).
      const copy = rawBytes.slice(0);
      worker.postMessage({ type: "decode", bytes: copy, names }, [copy]);
    });
  }, []);

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
            setYtdPath(selected);
            setYtdTextures(categorized);
            setYtdRawTextures(textures);
            setYtdOverrides({});
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
    setYtdRawTextures(null);
    setYtdMappingMeta(null);
    setYtdOverrides({});
    ytdBytesRef.current = null;
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
        case HOTKEY_ACTIONS.CYCLE_MODE:
          setTextureMode((prev) => {
            if (prev === "livery") return "everything";
            if (prev === "everything") return "eup";
            if (prev === "eup") return experimentalSettings ? "multi" : "livery";
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
              whileTap={{ scale: 0.95 }}
            >
              <div className="mode-tab-content">
                <Car className="mode-tab-icon" aria-hidden="true" />
                <span>Livery</span>
              </div>
              {textureMode === "livery" && (
                <motion.div
                  layoutId="mode-tab-highlight"
                  className="mode-tab-bg"
                  transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
                />
              )}
            </motion.button>
            
            <motion.button
              type="button"
              role="tab"
              className={`mode-tab ${textureMode === "everything" ? "is-active" : ""}`}
              onClick={() => setTextureMode("everything")}
              aria-selected={textureMode === "everything"}
              aria-controls="mode-panel-everything"
              whileTap={{ scale: 0.95 }}
            >
              <div className="mode-tab-content">
                <Layers className="mode-tab-icon" aria-hidden="true" />
                <span>All</span>
              </div>
              {textureMode === "everything" && (
                <motion.div
                  layoutId="mode-tab-highlight"
                  className="mode-tab-bg"
                  transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
                />
              )}
            </motion.button>
            
            <motion.button
              type="button"
              role="tab"
              className={`mode-tab ${textureMode === "eup" ? "is-active" : ""}`}
              onClick={() => setTextureMode("eup")}
              aria-selected={textureMode === "eup"}
              aria-controls="mode-panel-eup"
              whileTap={{ scale: 0.95 }}
            >
              <div className="mode-tab-content">
                <Shirt className="mode-tab-icon" aria-hidden="true" />
                <span>EUP</span>
              </div>
              {textureMode === "eup" && (
                <motion.div
                  layoutId="mode-tab-highlight"
                  className="mode-tab-bg"
                  transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
                />
              )}
            </motion.button>

            {experimentalSettings ? (
              <motion.button
                type="button"
                role="tab"
                className={`mode-tab ${textureMode === "multi" ? "is-active" : ""}`}
                onClick={() => setTextureMode("multi")}
                aria-selected={textureMode === "multi"}
                aria-controls="mode-panel-multi"
                whileTap={{ scale: 0.95 }}
              >
                <div className="mode-tab-content">
                  <Link2 className="mode-tab-icon" aria-hidden="true" />
                  <span>Multi</span>
                </div>
                {textureMode === "multi" && (
                  <motion.div
                    layoutId="mode-tab-highlight"
                    className="mode-tab-bg"
                    transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
                  />
                )}
              </motion.button>
            ) : null}
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
            {experimentalSettings && textureMode !== "multi" ? (
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
                  {ytdPath ? (
                    <Button
                      variant="outline"
                      className="w-9 p-0 border-white/10 text-white/40 hover:text-white/80"
                      onClick={clearYtd}
                      title="Unload YTD"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  ) : null}
                </div>
                {ytdPath ? <div className="file-meta mono">{ytdPath.split(/[\\/]/).pop()}</div> : null}
                {ytdTextures ? (
                  <div className="file-meta">
                    {Object.keys(ytdTextures.diffuse).length} diffuse, {Object.keys(ytdTextures.normal).length} normal, {Object.keys(ytdTextures.specular).length} specular
                  </div>
                ) : null}
                <div className="file-meta mono">Auto-maps diffuse, normal, and specular textures to materials.</div>
                {ytdRawTextures ? (
                  <Button
                    variant="outline"
                    className="w-full border-white/12 text-white/70 hover:text-white/95 hover:bg-white/5"
                    onClick={() => setYtdBrowserOpen(true)}
                  >
                    View Textures{ytdMappingMeta?.assignments?.length ? ` (${ytdMappingMeta.assignments.length})` : ""}
                  </Button>
                ) : null}
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

          {textureMode === "multi" ? (
            <div className="mode-content" id="mode-panel-multi" role="tabpanel">
              {/* ── Slot Selector ── */}
              <div className="dual-slot-tabs">
                <button
                  type="button"
                  className={`dual-slot-tab dual-slot-tab--a ${dualSelectedSlot === "A" ? "is-active" : ""}`}
                  onClick={() => setDualSelectedSlot("A")}
                >
                  <span className="dual-slot-dot dual-slot-dot--a" />
                  <span>Slot A</span>
                </button>
                <button
                  type="button"
                  className={`dual-slot-tab dual-slot-tab--b ${dualSelectedSlot === "B" ? "is-active" : ""}`}
                  onClick={() => setDualSelectedSlot("B")}
                >
                  <span className="dual-slot-dot dual-slot-dot--b" />
                  <span>Slot B</span>
                </button>
              </div>

              {/* ── Selected Slot ── */}
              <PanelSection
                title={dualSelectedSlot === "A" ? "Slot A" : "Slot B"}
                caption={dualSelectedSlot === "A" ? getFileLabel(dualModelAPath, "No model") : getFileLabel(dualModelBPath, "No model")}
                open={true}
                onToggle={() => {}}
                contentId="panel-dual-selected-slot"
              >
                {dualSelectedSlot === "A" ? (
                  <div className="control-group">
                    <Label>Model A</Label>
                    <div className="flex gap-2">
                      <Button variant="outline" className="flex-1 border-[#f97316]/50 bg-[#f97316]/5 text-[#f97316] hover:bg-[#f97316]/10" onClick={() => selectDualModel("A")}>
                        Select Model A
                      </Button>
                      {dualModelAPath ? (
                        <Button variant="outline" className="w-9 p-0 border-white/10 text-white/40 hover:text-white/80" onClick={() => { setDualModelAPath(""); setDualModelAError(""); }} title="Unload model A">
                          <X className="h-4 w-4" />
                        </Button>
                      ) : null}
                    </div>
                    {dualModelALoading ? <div className="file-meta">Loading...</div> : null}
                    {dualModelAError ? <div className="file-meta text-red-400/80">{dualModelAError}</div> : null}
                    <Label>Template A</Label>
                    <div className="flex gap-2">
                      <Button variant="outline" className="flex-1 border-[#f97316]/50 bg-[#f97316]/5 text-[#f97316] hover:bg-[#f97316]/10" onClick={() => selectDualTexture("A")}>
                        Select Livery A
                      </Button>
                      {dualTextureAPath ? (
                        <Button variant="outline" className="w-9 p-0 border-white/10 text-white/40 hover:text-white/80" onClick={() => setDualTextureAPath("")} title="Unload texture A">
                          <X className="h-4 w-4" />
                        </Button>
                      ) : null}
                    </div>
                    {dualTextureAPath ? <div className="file-meta mono">{getFileLabel(dualTextureAPath, "")}</div> : null}
                  </div>
                ) : (
                  <div className="control-group">
                    <Label>Model B</Label>
                    <div className="flex gap-2">
                      <Button variant="outline" className="flex-1 border-[#a78bfa]/50 bg-[#a78bfa]/5 text-[#a78bfa] hover:bg-[#a78bfa]/10" onClick={() => selectDualModel("B")}>
                        Select Model B
                      </Button>
                      {dualModelBPath ? (
                        <Button variant="outline" className="w-9 p-0 border-white/10 text-white/40 hover:text-white/80" onClick={() => { setDualModelBPath(""); setDualModelBError(""); }} title="Unload model B">
                          <X className="h-4 w-4" />
                        </Button>
                      ) : null}
                    </div>
                    {dualModelBLoading ? <div className="file-meta">Loading...</div> : null}
                    {dualModelBError ? <div className="file-meta text-red-400/80">{dualModelBError}</div> : null}
                    <Label>Template B</Label>
                    <div className="flex gap-2">
                      <Button variant="outline" className="flex-1 border-[#a78bfa]/50 bg-[#a78bfa]/5 text-[#a78bfa] hover:bg-[#a78bfa]/10" onClick={() => selectDualTexture("B")}>
                        Select Livery B
                      </Button>
                      {dualTextureBPath ? (
                        <Button variant="outline" className="w-9 p-0 border-white/10 text-white/40 hover:text-white/80" onClick={() => setDualTextureBPath("")} title="Unload texture B">
                          <X className="h-4 w-4" />
                        </Button>
                      ) : null}
                    </div>
                    {dualTextureBPath ? <div className="file-meta mono">{getFileLabel(dualTextureBPath, "")}</div> : null}
                  </div>
                )}
              </PanelSection>




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
            textureReloadToken={textureReloadToken}
            windowTextureReloadToken={windowTextureReloadToken}
            textureTarget={resolvedTextureTarget}
            windowTextureTarget={resolvedWindowTextureTarget}
            textureMode={textureMode}
            wasdEnabled={cameraWASD}
            liveryExteriorOnly={textureMode === "livery" && liveryExteriorOnly}
            ytdTextures={ytdTextures}
            ytdOverrides={ytdOverrides}
            decodeYtdTextures={decodeYtdTextures}
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
            onYtdMappingUpdate={setYtdMappingMeta}
          />
        )}

        <AnimatePresence>
          {(modelLoading || (textureMode === "multi" && (dualModelALoading || dualModelBLoading))) ? <AppLoader variant="background" /> : null}
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

        {showHints ? (
          <div className="viewer-hints">
            <span>Left drag: Rotate</span>
            <span>Right drag: Pan</span>
            <span>Scroll: Zoom</span>
          </div>
        ) : null}
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
                    {formatWarning.bitDepth}-Bit PSD Not Supported
                  </div>
                  <div className="warning-modal-subtitle">
                    High bit depth format detected
                  </div>
                </div>
              </div>

              <div className="warning-modal-body">
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
              </div>

              <div className="warning-modal-footer">
                <button
                  type="button"
                  className="warning-modal-btn warning-modal-btn-primary"
                  onClick={() => {
                    setFormatWarning(null);
                    setTexturePath("");
                    setTextureError("");
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
      <YtdBrowser
        open={ytdBrowserOpen}
        onClose={() => setYtdBrowserOpen(false)}
        rawTextures={ytdRawTextures}
        categorizedTextures={ytdTextures}
        mappingMeta={ytdMappingMeta}
        materialNames={ytdMappingMeta?.materialNames || []}
        onOverride={handleYtdOverride}
      />
    </motion.div>
  );
}

export default App;
