import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, RotateCcw, Square, X } from "lucide-react";
import AppLoader from "./components/AppLoader";
import Onboarding from "./components/Onboarding";
import SettingsMenu from "./components/SettingsMenu";
import Viewer from "./components/Viewer";
import { loadOnboarded, loadPrefs, savePrefs, setOnboarded } from "./lib/prefs";
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
  bodyColor: DEFAULT_BODY,
  backgroundColor: DEFAULT_BG,
};

function getInitialDefaults() {
  const prefs = loadPrefs();
  const stored = prefs?.defaults && typeof prefs.defaults === "object" ? prefs.defaults : {};
  return { ...BUILT_IN_DEFAULTS, ...stored };
}

function App() {
  const viewerApiRef = useRef(null);
  const reloadTimerRef = useRef(null);
  const isTauriRuntime =
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__ !== "undefined" &&
    typeof window.__TAURI_INTERNALS__?.invoke === "function";

  const [defaults, setDefaults] = useState(() => getInitialDefaults());
  const [showOnboarding, setShowOnboarding] = useState(() => !loadOnboarded());

  const [modelPath, setModelPath] = useState("");
  const [texturePath, setTexturePath] = useState("");
  const [bodyColor, setBodyColor] = useState(() => getInitialDefaults().bodyColor);
  const [backgroundColor, setBackgroundColor] = useState(() => getInitialDefaults().backgroundColor);
  const [textureReloadToken, setTextureReloadToken] = useState(0);
  const [textureTargets, setTextureTargets] = useState([]);
  const [textureMode, setTextureMode] = useState(() => getInitialDefaults().textureMode);
  const [textureTarget, setTextureTarget] = useState("all");
  const [liveryTarget, setLiveryTarget] = useState("");
  const [liveryLabel, setLiveryLabel] = useState("");
  const [liveryExteriorOnly, setLiveryExteriorOnly] = useState(() => Boolean(getInitialDefaults().liveryExteriorOnly));
  const [lastUpdate, setLastUpdate] = useState("-");
  const [watchStatus, setWatchStatus] = useState("idle");
  const [dialogError, setDialogError] = useState("");
  const [textureError, setTextureError] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [modelLoading, setModelLoading] = useState(false);
  const [viewerReady, setViewerReady] = useState(false);
  const [booted, setBooted] = useState(false);
  const bootStartRef = useRef(typeof performance !== "undefined" ? performance.now() : Date.now());
  const bootTimerRef = useRef(null);

  const isBooting = !booted;

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

  const scheduleReload = () => {
    if (reloadTimerRef.current) {
      clearTimeout(reloadTimerRef.current);
    }
    reloadTimerRef.current = setTimeout(() => {
      setTextureReloadToken((prev) => prev + 1);
    }, 350);
  };

  const handleModelInfo = useCallback((info) => {
    const targets = info?.targets ?? [];
    setTextureTargets(targets);
    setLiveryTarget(info?.liveryTarget || "");
    setLiveryLabel(info?.liveryLabel || "");
    setTextureTarget((prev) => {
      if (prev === "all") return prev;
      return targets.some((target) => target.value === prev) ? prev : "all";
    });
  }, []);

  const handleTextureError = useCallback((message) => {
    setTextureError(message || "");
  }, []);

  const handleModelLoading = useCallback((loading) => {
    setModelLoading(Boolean(loading));
  }, []);

  const applyAndPersistDefaults = useCallback((next) => {
    const merged = { ...BUILT_IN_DEFAULTS, ...(next || {}) };
    setDefaults(merged);
    setTextureMode(merged.textureMode);
    setLiveryExteriorOnly(Boolean(merged.liveryExteriorOnly));
    setBodyColor(merged.bodyColor);
    setBackgroundColor(merged.backgroundColor);
    savePrefs({ defaults: merged });
  }, []);

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
        filters: [{ name: "OBJ Model", extensions: ["obj"] }],
      });
      setDialogError("");
      if (typeof selected === "string") {
        setTextureTargets([]);
        setTextureTarget("all");
        setLiveryTarget("");
        setLiveryLabel("");
        setModelPath(selected);
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
            extensions: ["png", "jpg", "jpeg", "tga", "dds", "bmp", "gif", "tiff", "webp", "psd"],
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
    const objFile = files.find((file) => file.name?.toLowerCase().endsWith(".obj"));

    if (!objFile) {
      setDialogError("Only .obj files are supported for drop.");
      return;
    }

    if (!objFile.path) {
      setDialogError("Unable to read dropped file path.");
      return;
    }

    setDialogError("");
    setTextureTargets([]);
    setTextureTarget("all");
    setLiveryTarget("");
    setLiveryLabel("");
    setModelPath(objFile.path);
  };

  useEffect(() => {
    let unlisten = null;

    const start = async () => {
      if (!isTauriRuntime) {
        setWatchStatus("idle");
        return;
      }
      if (!texturePath) {
        setWatchStatus("idle");
        await invoke("stop_watch").catch(() => null);
        return;
      }

      await invoke("start_watch", { path: texturePath })
        .then(() => setWatchStatus("watching"))
        .catch(() => setWatchStatus("error"));

      unlisten = await listen("texture:update", () => {
        if (!texturePath) return;
        scheduleReload();
      });
    };

    start();

    return () => {
      if (unlisten) {
        unlisten();
      }
      if (isTauriRuntime) {
        invoke("stop_watch").catch(() => null);
      }
    };
  }, [texturePath]);

  const onTextureReload = () => {
    setLastUpdate(new Date().toLocaleTimeString());
  };

  const resolvedTextureTarget =
    textureMode === "livery" ? liveryTarget || "all" : textureTarget;
  const hasModel = Boolean(modelPath);
  const liveryStatusLabel = liveryLabel || "No livery material found";
  const liveryHint = !hasModel
    ? "Load a model to detect livery materials."
    : liveryTarget
      ? "Auto-targeting carpaint/livery materials (carpaint, livery, sign_1, sign_2)."
      : "No livery material found. Falling back to all meshes.";

  return (
    <motion.div
      className="app-shell"
      initial={{ opacity: 0, y: 6 }}
      animate={isBooting ? { opacity: 0, y: 6 } : { opacity: 1, y: 0 }}
      transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
      style={{ pointerEvents: isBooting ? "none" : "auto" }}
    >
      <div className="titlebar">
        <div className="titlebar-brand" data-tauri-drag-region>
          <span className="titlebar-dot" aria-hidden="true" />
          <span className="titlebar-title">Cortex Labs</span>
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
      <motion.aside
        className="control-panel"
        initial={{ opacity: 0, x: -12 }}
        animate={isBooting ? { opacity: 0, x: -12 } : { opacity: 1, x: 0 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="panel-header">
          <div className="panel-header-top">
            <div className="panel-title">Cortex Labs</div>
            <SettingsMenu
              defaults={defaults}
              builtInDefaults={BUILT_IN_DEFAULTS}
              onSave={applyAndPersistDefaults}
            />
          </div>
        </div>

        <div className="control-group">
          <Label>Vehicle Model</Label>
          <Button variant="outline" onClick={selectModel}>
            Select .obj
          </Button>
          <div className="file-meta mono">
            {modelPath ? modelPath.split(/[\\/]/).pop() : "No model selected"}
          </div>
        </div>

        <div className="control-group">
          <Label>Texture</Label>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1 border-sky-300/30 text-sky-300 hover:bg-sky-300/10"
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
          <div className="file-meta mono">
            {texturePath ? texturePath.split(/[\\/]/).pop() : "No texture selected"}
          </div>
        </div>

        <div className="control-group">
          <Label>Texture Mode</Label>
          <div className="texture-toggle" data-mode={textureMode} role="group" aria-label="Texture mode">
            <span className="texture-toggle-thumb" aria-hidden="true" />
            <button
              type="button"
              className={`texture-toggle-option ${textureMode === "everything" ? "is-active" : ""}`}
              onClick={() => setTextureMode("everything")}
              aria-pressed={textureMode === "everything"}
            >
              Everything
            </button>
            <button
              type="button"
              className={`texture-toggle-option ${textureMode === "livery" ? "is-active" : ""}`}
              onClick={() => setTextureMode("livery")}
              aria-pressed={textureMode === "livery"}
            >
              Livery
            </button>
          </div>
          <div className="file-meta mono">
            {textureMode === "livery"
              ? "Auto-detects carpaint/livery targets from model names."
              : "Everything uses the target picker (All meshes by default)."}
          </div>
        </div>

        <div className="control-group">
          <Label>Apply Texture To</Label>
          {textureMode === "livery" ? (
            <div className="texture-auto-target">
              <span className="texture-auto-badge">Auto</span>
              <span className="texture-auto-value">{liveryStatusLabel}</span>
            </div>
          ) : (
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
          )}
          <div className="file-meta mono">
            {textureMode === "livery"
              ? liveryHint
              : textureTargets.length
                ? "Targets come from OBJ material or mesh names."
                : "Load a model to list material targets."}
          </div>
        </div>

        {textureMode === "livery" ? (
          <div className="control-group">
            <Label>Exterior Only</Label>
            <div className="toggle-row">
              <button
                type="button"
                className={`toggle-switch ${liveryExteriorOnly ? "is-on" : ""}`}
                onClick={() => setLiveryExteriorOnly((prev) => !prev)}
                aria-pressed={liveryExteriorOnly}
                aria-label="Toggle exterior only"
              >
                <span className="toggle-switch-thumb" aria-hidden="true" />
              </button>
              <span className="toggle-switch-label">{liveryExteriorOnly ? "On" : "Off"}</span>
            </div>
            <div className="file-meta mono">Hides interior, glass, and wheel meshes in livery view.</div>
          </div>
        ) : null}

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

        <div className="status-strip">
          <div className="flex items-center gap-2">
            <span className={watchStatus === "watching" ? "status-dot" : "h-2 w-2 rounded-full bg-white/20"} />
            <span>
              {watchStatus === "watching" ? "Watching for saves" : watchStatus === "error" ? "Watcher error" : "Idle"}
            </span>
          </div>
          <span>Last update: {lastUpdate}</span>
        </div>
        {dialogError ? <div className="file-meta">{dialogError}</div> : null}
        {textureError ? <div className="file-meta">{textureError}</div> : null}
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
            <div className="drop-card">Drop .obj to load</div>
          </div>
        ) : null}
        <Viewer
          modelPath={modelPath}
          texturePath={texturePath}
          bodyColor={bodyColor}
          backgroundColor={backgroundColor}
          textureReloadToken={textureReloadToken}
          textureTarget={resolvedTextureTarget}
          liveryExteriorOnly={textureMode === "livery" && liveryExteriorOnly}
          onModelInfo={handleModelInfo}
          onModelLoading={handleModelLoading}
          onReady={(api) => {
            viewerApiRef.current = api;
            setViewerReady(true);
          }}
          onTextureReload={onTextureReload}
          onTextureError={handleTextureError}
        />

        <AnimatePresence>
          {modelLoading ? <AppLoader variant="background" /> : null}
        </AnimatePresence>

        <div className="viewer-toolbar">
          <Button size="sm" variant="ghost" onClick={() => viewerApiRef.current?.setPreset("front")}>
            Front
          </Button>
          <Button size="sm" variant="ghost" onClick={() => viewerApiRef.current?.setPreset("side")}>
            Side
          </Button>
          <Button size="sm" variant="ghost" onClick={() => viewerApiRef.current?.setPreset("angle")}>
            3/4
          </Button>
          <Button size="sm" variant="ghost" onClick={() => viewerApiRef.current?.setPreset("top")}>
            Top
          </Button>
        </div>

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
