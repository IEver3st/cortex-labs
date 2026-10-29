import { Suspense, lazy, memo, useCallback, useEffect, useRef, useState, useMemo } from "react";
import { AnimatePresence, MotionConfig, motion, useMotionValue, useTransform, useSpring } from "motion/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Minus, Square, X, Settings, Pencil, Trash2, Copy, Plus, Car, Shirt, Link2, Palette, ChevronDown, Sparkles, MessageSquarePlus, Flashlight, CopyX, Siren, Aperture } from "lucide-react";
import AppLoader from "./components/AppLoader";
import HomePage from "./components/HomePage";
import UpdateToolbarControl from "./components/UpdateToolbarControl";
import GlobalContextMenu from "./components/GlobalContextMenu";
import { Keycaps } from "./components/ui/keycaps";
import * as Ctx from "./components/ContextMenu";
import appMeta from "../package.json";
import cortexLogo from "../src-tauri/icons/128x128@2x.png";
import "./Shell.css";
import {
  setActiveWorkspaceId,
  updateWorkspace,
  createWorkspace,
  loadWorkspaces,
  renameWorkspace,
  addRecent,
  markWorkspaceOpened,
  loadOpenTabs,
  planOpenTabs,
  saveOpenTabs,
} from "./lib/workspace";
import { applySavedVehicleToState, findSavedVehicleWorkspace, savedVehicleWorkspaceState } from "./lib/saved-vehicles";
import { normalizeTextureMode } from "./lib/workspace-state";
import { subscribeUnsavedChanges, unsavedChangeKeys } from "./lib/unsaved-changes";
import { clearSession } from "./lib/prefs";
import UnsavedChangesDialog from "./components/UnsavedChangesDialog";
import { loadOnboarded, setOnboarded, loadPrefs, PREFS_UPDATED_EVENT } from "./lib/prefs";
import {
  WORKSPACE_MODES,
  WORKSPACE_MODE_GROUPS,
  workspaceLabel,
  workspaceModeForAction,
  workspaceModeRoute,
} from "./lib/workspace-modes";
import { applyAppearance, setSystemTheme } from "./lib/theme";
import {
  DEFAULT_HOTKEYS,
  findMatchingAction,
  formatHotkey,
  mergeHotkeys,
} from "./lib/hotkeys";

// Secondary pages and modals load on first use so the viewer shell boots lighter.
const lazyPage = (load) => lazy(() => load().then((module) => ({ default: memo(module.default) })));
const PAGE_LOADERS = {
  viewer: () => import("./App"),
  eupstudio: () => import("./components/EupPage"),
  propstudio: () => import("./components/PropStudioPage"),
  photo: () => import("./components/PhotoModePage"),
  variants: () => import("./components/VariantsPage"),
  templategen: () => import("./components/TemplateGenerationPage"),
};
const VariantsPage = lazyPage(PAGE_LOADERS.variants);
const App = lazyPage(PAGE_LOADERS.viewer);
const EupPage = lazyPage(PAGE_LOADERS.eupstudio);
const PropStudioPage = lazyPage(PAGE_LOADERS.propstudio);
const PhotoModePage = lazyPage(PAGE_LOADERS.photo);
const TemplateGenerationPage = lazyPage(PAGE_LOADERS.templategen);
const MemoHomePage = memo(HomePage);
const EMPTY_STATE = Object.freeze({});
const WhatsNew = lazy(() => import("./components/WhatsNew"));
const BugReportModal = lazy(() => import("./components/BugReportModal"));
const Onboarding = lazy(() => import("./components/Onboarding"));
const SettingsMenu = lazy(() => import("./components/SettingsMenu"));

// Long enough for the intro to land its lockup; boot also waits for the front tab's page chunk.
const MIN_BOOT_MS = 800;
const MAX_BOOT_WAIT_MS = 3000;
function generateTabId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

const NEW_TAB_ACTIONS = WORKSPACE_MODES.map((mode) => mode.action);

const HOME_TAB = { id: "home", type: "home", label: "Home", workspaceId: null, closable: false };

// Reopens the project tabs that were open last time, in order, with the one
// that was in front. Restored tabs are `deferred`: each mounts (and loads its
// model) the first time it is shown, so startup loads one model, not every
// tab's. A file opened with the app (open-with) still takes the front.
function restoreOpenTabs() {
  clearSession();
  if (loadPrefs()?.defaults?.reopenTabs === false) return { tabs: [HOME_TAB], activeTabId: HOME_TAB.id, keepSavedTabs: true };
  const plan = planOpenTabs(loadOpenTabs(), loadWorkspaces());
  const restored = plan.tabs.map((entry) => ({
    id: generateTabId(),
    type: entry.type,
    label: entry.name,
    workspaceId: entry.workspaceId,
    closable: true,
    defaultMode: entry.defaultMode,
    initialState: entry.state,
    deferred: true,
  }));
  const active = restored.find((tab) => tab.workspaceId === plan.activeWorkspaceId);
  return { tabs: [HOME_TAB, ...restored], activeTabId: active ? active.id : HOME_TAB.id };
}

// Same glyphs as the New tab menu, so a tab names its workspace kind.
const VIEWER_MODE_ICONS = {
  vehicle: Car,
  eup: Shirt,
  multi: Link2,
  sirens: Siren,
};

const TAB_ICONS = {
  variants: Palette,
  templategen: Sparkles,
  eupstudio: Shirt,
  propstudio: Flashlight,
  photo: Aperture,
};

function tabIconFor(tab) {
  if (tab.type === "viewer") {
    const mode = normalizeTextureMode(tab.initialState?.textureMode || tab.defaultMode) || "vehicle";
    return VIEWER_MODE_ICONS[mode] || Car;
  }
  return TAB_ICONS[tab.type] || Car;
}

const FILE_LABEL_EXTENSION = /\.(yft|ydd|ydr|ytd|ymt|ybn|ypt|ycd|ytyp|ymap|meta|xml|dds|png|psd|pdn|zip|rpf|json|dff|clmesh|ai|jpg|jpeg|tga|webp)$/i;
function tabDisplayLabel(label) {
  const text = String(label ?? "");
  return text.replace(FILE_LABEL_EXTENSION, "") || text;
}

const TAB_LABEL_TAIL = 5;

function TabLabel({ text, isFile }) {
  if (!isFile || text.length <= TAB_LABEL_TAIL * 2 + 2) return <span className="shell-tab-label">{text}</span>;
  return (
    <span className="shell-tab-label is-split">
      <span className="shell-tab-label-head">{text.slice(0, -TAB_LABEL_TAIL)}</span>
      <span className="shell-tab-label-tail">{text.slice(-TAB_LABEL_TAIL)}</span>
    </span>
  );
}

const MIN_UI_SCALE = 0.5;
const MAX_UI_SCALE = 1.4;
const WINDOW_DRAG_THRESHOLD_PX = 4;

// Feedback "Area" defaults to the workflow the report was opened from.
// Vehicle reports keep Livery's stable "livery" id.
const FEEDBACK_AREA_BY_MODE = { vehicle: "livery", eup: "eup", multi: "multi", sirens: "sirens" };
function feedbackAreaForTab(tab, settingsOpen) {
  if (settingsOpen || !tab || tab.type === "home") return "home-settings";
  if (tab.type === "eupstudio") return "eup-studio";
  if (tab.type === "propstudio") return "prop-studio";
  if (tab.type === "variants") return "variant-builder";
  if (tab.type === "templategen") return "template-generator";
  const mode = normalizeTextureMode(loadWorkspaces()[tab.workspaceId]?.state?.textureMode || tab.defaultMode);
  return FEEDBACK_AREA_BY_MODE[mode] || "other";
}

function clampUiScale(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 1.0;
  return Math.min(MAX_UI_SCALE, Math.max(MIN_UI_SCALE, num));
}

/**
 * Shell — browser-style tabbed container for Cortex Studio.
 * All tab panes stay mounted for instant switching (critical for WebGL viewer).
 */
export default function Shell() {
  const [booted, setBooted] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(() => !loadOnboarded());
  const [isBugReportOpen, setIsBugReportOpen] = useState(false);
  // The modal chunk loads on first open and then stays mounted so its close
  // animation keeps working exactly as before.
  const [bugReportLoaded, setBugReportLoaded] = useState(false);
  useEffect(() => {
    if (isBugReportOpen) setBugReportLoaded(true);
  }, [isBugReportOpen]);
  const [feedbackInitialType, setFeedbackInitialType] = useState("bug");
  const [feedbackInitialArea, setFeedbackInitialArea] = useState("");

  // Tab system
  const [startupTabs] = useState(restoreOpenTabs);
  const keepSavedTabsRef = useRef(startupTabs.keepSavedTabs === true);
  const [tabs, setTabs] = useState(startupTabs.tabs);
  const [activeTabId, setActiveTabId] = useState(startupTabs.activeTabId);
  const [editingTabId, setEditingTabId] = useState(null);
  const [tabDetails, setTabDetails] = useState({});
  const tabDetailSetters = useRef(new Map());
  const tabDetailSetter = useCallback((tabId) => {
    let setter = tabDetailSetters.current.get(tabId);
    if (!setter) {
      setter = (detail) => setTabDetails((prev) => (prev[tabId] === (detail || undefined) ? prev : { ...prev, [tabId]: detail || undefined }));
      tabDetailSetters.current.set(tabId, setter);
    }
    return setter;
  }, []);
  const editTabRef = useRef(null);
  const toolbarDragGestureRef = useRef(null);
  const lastToolbarDragAtRef = useRef(0);
  // Track pending tab activation (for use after setTabs)
  const pendingActiveRef = useRef(null);
  const lastExternalFileOpenRef = useRef({ path: "", at: 0 });

  // Settings change counter — bumped when settings are saved so children re-read prefs
  const [settingsVersion, setSettingsVersion] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Map of tabId -> pane element for focus management
  const paneRefs = useRef(new Map());

  // Hotkeys for new-tab shortcuts (reloaded when settings change)
  const [reduceMotionPref, setReduceMotionPref] = useState(
    () => loadPrefs()?.defaults?.reduceMotion === "always",
  );
  const [hotkeys, setHotkeys] = useState(() => {
    const prefs = loadPrefs();
    const stored = prefs?.hotkeys && typeof prefs.hotkeys === "object" ? prefs.hotkeys : {};
    return mergeHotkeys(stored, DEFAULT_HOTKEYS);
  });

  const isTauriRuntime =
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__ !== "undefined" &&
    typeof window.__TAURI_INTERNALS__?.invoke === "function";

  // Apply UI scale and window style from prefs on boot and when settings change; reload hotkeys
  useEffect(() => {
    const prefs = loadPrefs();
    const scale = clampUiScale(prefs?.defaults?.uiScale ?? 1.0);
    document.documentElement.style.setProperty("--es-ui-scale", String(scale));
    window.dispatchEvent(
      new CustomEvent("cortex:ui-scale-changed", { detail: { scale } }),
    );
    
    const style = prefs?.defaults?.windowControlsStyle ?? "windows";
    document.documentElement.setAttribute("data-window-style", style);

    const reduceMotion = prefs?.defaults?.reduceMotion === "always";
    setReduceMotionPref(reduceMotion);
    if (reduceMotion) document.documentElement.setAttribute("data-motion", "reduce");
    else document.documentElement.removeAttribute("data-motion");
    document.documentElement.setAttribute(
      "data-keycaps",
      prefs?.defaults?.showKeycaps === false ? "off" : "on",
    );

    applyAppearance({
      colorScheme: prefs?.defaults?.colorScheme,
      themePreset: prefs?.defaults?.themePreset,
      legacyDarkMode: prefs?.defaults?.darkMode ?? true,
    });

    const stored = prefs?.hotkeys && typeof prefs.hotkeys === "object" ? prefs.hotkeys : {};
    setHotkeys(mergeHotkeys(stored, DEFAULT_HOTKEYS));
  }, [settingsVersion]);

  // Track the native system theme so the System appearance option follows the OS.
  useEffect(() => {
    let cancelled = false;
    let unlistenTheme = null;
    const mediaQuery = window.matchMedia?.("(prefers-color-scheme: dark)");

    const syncBrowserTheme = (event) => {
      setSystemTheme(event.matches ? "dark" : "light");
    };

    if (isTauriRuntime) {
      const appWindow = getCurrentWindow();
      appWindow.theme().then((theme) => {
        if (cancelled) return;
        if (theme === "light" || theme === "dark") setSystemTheme(theme);
        else if (mediaQuery) syncBrowserTheme(mediaQuery);
      }).catch(() => {
        if (!cancelled && mediaQuery) syncBrowserTheme(mediaQuery);
      });
      appWindow.onThemeChanged(({ payload }) => setSystemTheme(payload)).then((unlisten) => {
        if (cancelled) unlisten();
        else unlistenTheme = unlisten;
      }).catch(() => {});
    } else if (mediaQuery) {
      syncBrowserTheme(mediaQuery);
      if (typeof mediaQuery.addEventListener === "function") {
        mediaQuery.addEventListener("change", syncBrowserTheme);
      } else {
        mediaQuery.addListener?.(syncBrowserTheme);
      }
    }

    return () => {
      cancelled = true;
      unlistenTheme?.();
      if (!isTauriRuntime) {
        if (typeof mediaQuery?.removeEventListener === "function") {
          mediaQuery.removeEventListener("change", syncBrowserTheme);
        } else {
          mediaQuery?.removeListener?.(syncBrowserTheme);
        }
      }
    };
  }, [isTauriRuntime]);

  useEffect(() => {
    if (isTauriRuntime) void getCurrentWindow().show().catch(() => {});
  }, [isTauriRuntime]);

  // Boot
  useEffect(() => {
    let cancelled = false;
    const timers = [];
    const wait = (ms) => new Promise((resolve) => timers.push(setTimeout(resolve, ms)));
    const reduceMotion = reduceMotionPref || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const front = startupTabs.tabs.find((tab) => tab.id === startupTabs.activeTabId);
    const frontPage = PAGE_LOADERS[front?.type]?.().catch(() => {});
    Promise.all([wait(reduceMotion ? 0 : MIN_BOOT_MS), Promise.race([frontPage, wait(MAX_BOOT_WAIT_MS)])]).then(() => {
      if (!cancelled) setBooted(true);
    });
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [reduceMotionPref, startupTabs]);

  useEffect(() => {
    const handlePrefsUpdated = () => {
      setSettingsVersion((version) => version + 1);
    };

    window.addEventListener(PREFS_UPDATED_EVENT, handlePrefsUpdated);
    return () => window.removeEventListener(PREFS_UPDATED_EVENT, handlePrefsUpdated);
  }, []);

  // Open a new tab (or focus existing for same workspace)
  const openTab = useCallback((type, label, workspaceId, state, defaultMode) => {
    PAGE_LOADERS[type]?.().catch(() => {});
    setTabs((prev) => {
      const existing = workspaceId ? prev.find((t) => t.workspaceId === workspaceId) : null;
      if (existing) {
        // Tab already exists — just activate it directly
        pendingActiveRef.current = existing.id;
        // Force a state update so the useEffect fires
        return [...prev];
      }

      const modeLabels = { vehicle: "Vehicle", eup: "EUP", multi: "Multi", sirens: "Sirens" };
      const fallbackLabel =
        type === "viewer"
          ? modeLabels[normalizeTextureMode(defaultMode)] || "Preview"
          : type === "eupstudio"
            ? "EUP Studio"
          : type === "propstudio"
            ? "Prop Studio"
          : type === "photo"
            ? "Photo Mode"
          : type === "templategen"
            ? "Template Gen"
            : "Variants";
      const newTab = {
        id: generateTabId(),
        type,
        label: label || fallbackLabel,
        workspaceId: workspaceId || null,
        closable: true,
        defaultMode: defaultMode || null,
        initialState: state || null,
      };

      pendingActiveRef.current = newTab.id;
      return [...prev, newTab];
    });
  }, []);

  const handleExternalFileOpen = useCallback((filePath) => {
    if (typeof filePath !== "string" || !filePath) return;

    const now = Date.now();
    const last = lastExternalFileOpenRef.current;
    if (last.path === filePath && now - last.at < 1200) return;
    lastExternalFileOpenRef.current = { path: filePath, at: now };

    const lower = filePath.toLowerCase();
    if (!(lower.endsWith(".yft") || lower.endsWith(".ydd") || lower.endsWith(".ydr") || lower.endsWith(".dff") || lower.endsWith(".clmesh"))) {
      return;
    }

    const fileName = filePath.split(/[\\/]/).pop();
    // A single drawable is a prop; it opens in Prop Studio.
    if (lower.endsWith(".ydr")) {
      const propState = { modelPath: filePath };
      const propWsId = createWorkspace(fileName, "propstudio", propState);
      openTab("propstudio", fileName, propWsId, propState);
      return;
    }
    const mode = lower.endsWith(".ydd") ? "eup" : "vehicle";
    const initialState = { textureMode: mode, modelPath: filePath, openFile: filePath };
    const wsId = createWorkspace(fileName, "viewer", initialState);
    openTab("viewer", fileName, wsId, initialState, mode);
  }, [openTab]);

  const handleSirenOpen = useCallback((request) => {
    const sirens = typeof request?.sirens === "string" ? request.sirens : "";
    if (!sirens) return;
    const model = typeof request.model === "string" && request.model ? request.model : "";
    const setting = typeof request.setting === "string" ? request.setting : "";

    const key = `${sirens}|${model}|${setting}`;
    const now = Date.now();
    const last = lastExternalFileOpenRef.current;
    if (last.path === key && now - last.at < 1200) return;
    lastExternalFileOpenRef.current = { path: key, at: now };

    const label = model ? model.split(/[\\/]/).pop() : workspaceLabel("viewer", "sirens");
    const state = model ? { textureMode: "sirens", modelPath: model, openFile: model } : { textureMode: "sirens" };
    const wsId = createWorkspace(label, "viewer", state);
    openTab("viewer", label, wsId, { ...state, sirenOpen: { path: sirens, model, setting } }, "sirens");
  }, [openTab]);

  // File-open handler (startup + running instance)
  useEffect(() => {
    if (!isTauriRuntime) return;
    let unlisten;
    let cancelled = false;

    const start = async () => {
      let unlistenFn;
      try {
        unlistenFn = await listen("file-open", (event) => {
          handleExternalFileOpen(event.payload);
        });
      } catch {
        return;
      }

      if (cancelled) {
        unlistenFn();
        return;
      }

      unlisten = unlistenFn;

      try {
        const pendingPath = await invoke("consume_pending_open_file");
        handleExternalFileOpen(pendingPath);
      } catch {
        // no-op: command may not be available in web preview
      }

      try {
        const sirensUnlisten = await listen("siren-open", (event) => handleSirenOpen(event.payload));
        if (cancelled) {
          sirensUnlisten();
          return;
        }
        const fileUnlisten = unlisten;
        unlisten = () => {
          fileUnlisten();
          sirensUnlisten();
        };
        handleSirenOpen(await invoke("consume_pending_siren_open"));
      } catch {
        // no-op: command may not be available in web preview
      }
    };

    start();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [isTauriRuntime, handleExternalFileOpen, handleSirenOpen]);

  // Flush pending tab activation after tabs state updates
  useEffect(() => {
    if (pendingActiveRef.current) {
      setActiveTabId(pendingActiveRef.current);
      pendingActiveRef.current = null;
      return;
    }
    if (!tabs.find((tab) => tab.id === activeTabId) && tabs.length > 0) {
      setActiveTabId(tabs[tabs.length - 1].id);
    }
  }, [tabs, activeTabId]);

  // Close tab (unguarded; closeTab below asks first when edits would be lost)
  const closeTabNow = useCallback((tabId) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tabId);
      if (idx === -1) return prev;
      if (!prev[idx].closable) return prev;

      const next = prev.filter((t) => t.id !== tabId);
      // Read the active tab now, not when the close was asked for: a tab
      // opened while the unsaved-edits dialog was up must keep the front.
      const newIdx = Math.min(idx, next.length - 1);
      setActiveTabId((current) => (current === tabId ? next[newIdx]?.id || "home" : current));
      return next;
    });
  }, []);


  // Close other tabs
  const closeOtherTabsNow = useCallback((keepTabId) => {
    setTabs((prev) => prev.filter((t) => !t.closable || t.id === keepTabId));
    setActiveTabId(keepTabId);
  }, []);

  // Close all closable tabs
  const closeAllTabsNow = useCallback(() => {
    setTabs((prev) => prev.filter((t) => !t.closable));
    setActiveTabId("home");
  }, []);

  // Closing a tab that holds unsaved siren edits asks first. `pendingClose` is
  // { names, scope, run } while the dialog is up.
  const [pendingClose, setPendingClose] = useState(null);
  const guardClose = useCallback((tabIds, scope, run) => {
    const dirty = unsavedChangeKeys(tabIds);
    if (dirty.length === 0) {
      run();
      return;
    }
    const names = dirty.map((id) => tabsRef.current.find((tab) => tab.id === id)?.label || "A tab");
    setPendingClose({ names, scope, run });
  }, []);
  const closeTab = useCallback((tabId) => guardClose([tabId], "tab", () => closeTabNow(tabId)), [guardClose, closeTabNow]);
  const closeOtherTabs = useCallback((keepTabId) => guardClose(
    tabsRef.current.filter((tab) => tab.closable && tab.id !== keepTabId).map((tab) => tab.id),
    "tabs",
    () => closeOtherTabsNow(keepTabId),
  ), [guardClose, closeOtherTabsNow]);
  const closeAllTabs = useCallback(() => guardClose(
    tabsRef.current.filter((tab) => tab.closable).map((tab) => tab.id),
    "tabs",
    closeAllTabsNow,
  ), [guardClose, closeAllTabsNow]);
  const confirmPendingClose = useCallback(() => {
    const run = pendingClose?.run;
    setPendingClose(null);
    run?.();
  }, [pendingClose]);
  const cancelPendingClose = useCallback(() => setPendingClose(null), []);

  // The window asks too while any tab holds unsaved edits. The close listener
  // exists only then, so a clean app closes exactly as before; Tauri holds a
  // close while a JS listener is registered, so confirming drops the listener
  // and closes again.
  const [hasUnsavedTabs, setHasUnsavedTabs] = useState(false);
  useEffect(() => subscribeUnsavedChanges(() => setHasUnsavedTabs(unsavedChangeKeys().length > 0)), []);
  useEffect(() => {
    if (!hasUnsavedTabs) return undefined;
    if (!isTauriRuntime) {
      const handleBeforeUnload = (event) => {
        event.preventDefault();
        event.returnValue = "";
      };
      window.addEventListener("beforeunload", handleBeforeUnload);
      return () => window.removeEventListener("beforeunload", handleBeforeUnload);
    }
    const appWindow = getCurrentWindow();
    let unlisten = null;
    let cancelled = false;
    const stopListening = async () => {
      const stop = unlisten;
      unlisten = null;
      await stop?.();
    };
    appWindow.onCloseRequested((event) => {
      event.preventDefault();
      const names = unsavedChangeKeys().map((id) => tabsRef.current.find((tab) => tab.id === id)?.label || "A tab");
      setPendingClose({
        names,
        scope: "window",
        run: () => {
          stopListening()
            .then(() => appWindow.close())
            .catch((error) => console.error("[Shell] Closing the window failed:", error));
        },
      });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    }).catch((error) => console.error("[Shell] Couldn't watch for window close:", error));
    return () => {
      cancelled = true;
      stopListening().catch(() => {});
    };
  }, [hasUnsavedTabs, isTauriRuntime]);

  // Rename tab (called by child components when content loads)
  const renameTab = useCallback((tabId, newLabel) => {
    if (!newLabel?.trim()) return;
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, label: newLabel.trim() } : t))
    );
  }, []);

  const tabRenameSetters = useRef(new Map());
  const tabRenameSetter = useCallback((tabId) => {
    let setter = tabRenameSetters.current.get(tabId);
    if (!setter) {
      setter = (label) => renameTab(tabId, label);
      tabRenameSetters.current.set(tabId, setter);
    }
    return setter;
  }, [renameTab]);
  const openPackBuilder = useCallback(() => openTab("eupstudio", null, null, { inspectorTab: "pack" }), [openTab]);

  // Start interactive rename
  const startRenameTab = useCallback((tabId) => {
    setEditingTabId(tabId);
    setTimeout(() => editTabRef.current?.select(), 30);
  }, []);

  const finishRenameTab = useCallback((tabId, newName) => {
    if (!newName?.trim()) {
      setEditingTabId(null);
      return;
    }
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, label: newName.trim() } : t))
    );
    setEditingTabId(null);
    // Also rename workspace if linked
    setTabs((prev) => {
      const tab = prev.find((t) => t.id === tabId);
      if (tab?.workspaceId) renameWorkspace(tab.workspaceId, newName.trim());
      return prev;
    });
  }, []);

  // Opens a workspace tab. Without a workspace id it starts a new project named
  // after the workspace, so Home, the new-tab menu, onboarding and the new-tab
  // hotkeys all save the tab and list it in Recents the same way.
  const handleNavigate = useCallback((type, workspaceId, defaultMode) => {
    setSettingsOpen(false);
    const fallbackLabel = workspaceLabel(type, defaultMode);
    if (!workspaceId) {
      const initial = type === "viewer" ? { textureMode: defaultMode || "vehicle" } : {};
      workspaceId = createWorkspace(fallbackLabel, type, initial);
    }
    const ws = loadWorkspaces()[workspaceId];
    const label = ws?.name || fallbackLabel;
    openTab(type, label, workspaceId, ws?.state, defaultMode);
    setActiveWorkspaceId(workspaceId);
    addRecent(workspaceId, label, type);
  }, [openTab]);

  const launchWorkspaceMode = useCallback((modeId) => {
    const route = workspaceModeRoute(modeId) || workspaceModeRoute("vehicle");
    handleNavigate(route.page, null, route.textureMode);
  }, [handleNavigate]);


  const handleOpenWorkspace = useCallback((ws) => {
    if (!ws?.id) return;
    setSettingsOpen(false);
    const latestWs = loadWorkspaces()[ws.id] || ws;
    const defaultMode = normalizeTextureMode(latestWs?.state?.textureMode) || "vehicle";
    const page =
      latestWs.page === "eupstudio"
        ? "eupstudio"
      : latestWs.page === "propstudio"
        ? "propstudio"
      : latestWs.page === "photo"
        ? "photo"
      : latestWs.page === "variants"
        ? "variants"
        : latestWs.page === "templategen"
          ? "templategen"
          : "viewer";
    openTab(page, latestWs.name, latestWs.id, latestWs.state, defaultMode);

    setActiveWorkspaceId(latestWs.id);
    addRecent(latestWs.id, latestWs.name, page);
  }, [openTab]);

  // A saved vehicle opens on its model with its setup restored: in the tab
  // already showing it, else in the project already linked to it, else in a
  // new project. Reopening a linked project applies the saved setup over it.
  const handleOpenSavedVehicle = useCallback((entry) => {
    const state = savedVehicleWorkspaceState(entry);
    if (!state) return;
    setSettingsOpen(false);
    const workspaces = loadWorkspaces();
    const openIds = tabsRef.current.map((tab) => tab.workspaceId).filter(Boolean);
    const linkedId = findSavedVehicleWorkspace(workspaces, entry.id, openIds);
    if (linkedId && openIds.includes(linkedId)) {
      const ws = workspaces[linkedId];
      openTab("viewer", ws.name, linkedId, ws.state, state.textureMode);
      setActiveWorkspaceId(linkedId);
      markWorkspaceOpened(linkedId);
      return;
    }
    if (linkedId) {
      const ws = workspaces[linkedId];
      const merged = applySavedVehicleToState(ws.state, entry);
      updateWorkspace(linkedId, { state: merged, page: "viewer" });
      openTab("viewer", ws.name, linkedId, merged, state.textureMode);
      setActiveWorkspaceId(linkedId);
      addRecent(linkedId, ws.name, "viewer");
      return;
    }
    const id = createWorkspace(entry.name, "viewer", state);
    openTab("viewer", entry.name, id, state, state.textureMode);
    setActiveWorkspaceId(id);
    addRecent(id, entry.name, "viewer");
  }, [openTab]);

  // Page state per tab, saved to the workspace store.
  // These handlers must stay referentially stable: the pages call them from a
  // debounced persist effect, and a fresh callback per Shell render would start
  // another persist cycle.
  // Tabs are read through a ref so the callbacks never need `tabs` as a dep.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const lastPersistedPageStateRef = useRef(new Map());

  // Switching to an already-open project tab counts as opening it, so Home's
  // last-opened order follows what the user actually worked on.
  useEffect(() => {
    const tab = tabsRef.current.find((t) => t.id === activeTabId);
    if (tab?.workspaceId) markWorkspaceOpened(tab.workspaceId);
  }, [activeTabId]);

  // A tab restored at startup mounts the first time it is shown. Panes render
  // after boot, so a file opened with the app before then skips mounting the
  // tab that was in front last time.
  useEffect(() => {
    if (!booted) return;
    setTabs((prev) => (prev.some((tab) => tab.id === activeTabId && tab.deferred)
      ? prev.map((tab) => (tab.id === activeTabId ? { ...tab, deferred: false } : tab))
      : prev));
  }, [activeTabId, booted]);

  useEffect(() => {
    if (!booted) return undefined;
    const types = new Set(tabsRef.current.filter((tab) => tab.deferred).map((tab) => tab.type));
    if (!types.size) return undefined;
    const preload = () => types.forEach((type) => PAGE_LOADERS[type]?.().catch(() => {}));
    if (typeof window.requestIdleCallback !== "function") {
      const timer = window.setTimeout(preload, 1000);
      return () => window.clearTimeout(timer);
    }
    const idle = window.requestIdleCallback(preload, { timeout: 3000 });
    return () => window.cancelIdleCallback(idle);
  }, [booted]);

  // Remember the open project tabs for the next start.
  useEffect(() => {
    if (keepSavedTabsRef.current) {
      if (tabs.every((tab) => tab.type === "home")) return;
      keepSavedTabsRef.current = false;
    }
    const active = tabs.find((tab) => tab.id === activeTabId);
    saveOpenTabs(tabs.map((tab) => tab.workspaceId).filter(Boolean), active?.workspaceId || null);
  }, [tabs, activeTabId]);

  const persistPageState = useCallback((tabId, state, page) => {
    let serialized = "";
    try {
      serialized = JSON.stringify(state);
    } catch {
      serialized = "";
    }
    const key = `${page}:${tabId}`;
    if (serialized && lastPersistedPageStateRef.current.get(key) === serialized) return;
    lastPersistedPageStateRef.current.set(key, serialized);
    const tab = tabsRef.current.find((t) => t.id === tabId);
    if (tab?.workspaceId) updateWorkspace(tab.workspaceId, { state, page });
  }, []);

  // Per-tab bound callbacks, cached so the page props stay stable across renders.
  const pageStateCallbacksRef = useRef(new Map());
  const getPageStateCallback = useCallback((tabId, type) => {
    const key = `${type}:${tabId}`;
    const cache = pageStateCallbacksRef.current;
    let fn = cache.get(key);
    if (!fn) {
      fn = (state) => persistPageState(tabId, state, type);
      cache.set(key, fn);
    }
    return fn;
  }, [persistPageState]);

  useEffect(() => {
    const liveIds = new Set(tabs.map((tab) => tab.id));
    for (const cache of [pageStateCallbacksRef.current, lastPersistedPageStateRef.current]) {
      for (const key of cache.keys()) if (!liveIds.has(key.slice(key.indexOf(":") + 1))) cache.delete(key);
    }
    for (const setters of [tabRenameSetters.current, tabDetailSetters.current]) {
      for (const id of setters.keys()) if (!liveIds.has(id)) setters.delete(id);
    }
  }, [tabs]);

  // Onboarding

  const handleOnboardingComplete = useCallback((action) => {
    setOnboarded();
    setShowOnboarding(false);

    if (!action || typeof action !== "object") return;

    if (action.type === "launch") {
      launchWorkspaceMode(action.target);
      return;
    }

    if (action.type === "openSettings") {
      window.dispatchEvent(new CustomEvent("cortex:open-settings"));
      if (typeof action.section === "string" && action.section) {
        window.dispatchEvent(
          new CustomEvent("cortex:nav-settings", { detail: { section: action.section } }),
        );
      }
    }
  }, [launchWorkspaceMode]);

  // Settings saved callback
  const handleSettingsSaved = useCallback(() => {
    setSettingsVersion((v) => v + 1);
  }, []);

  // If focus lives inside a pane that is being hidden, blur it to avoid aria-hidden conflict
  useEffect(() => {
    const activeEl = document.activeElement;
    if (!(activeEl instanceof Element)) return;

    for (const [tabId, el] of paneRefs.current.entries()) {
      if (tabId === activeTabId) continue;
      if (el?.contains(activeEl)) {
        activeEl.blur();
        break;
      }
    }
  }, [activeTabId]);

  // Global hotkeys for opening new mode tabs. They wait while the first-run
  // screen is up; with Settings open they close it, as the new-tab menu does.
  useEffect(() => {
    if (showOnboarding || pendingClose) return undefined;
    const handleKeyDown = (event) => {
      if (event.repeat) return;
      const target = event.target;
      if (target instanceof Element) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (target.isContentEditable) return;
        if (target.classList.contains("hotkey-input")) return;
      }

      const action = findMatchingAction(hotkeys, event, NEW_TAB_ACTIONS);
      const mode = workspaceModeForAction(action);
      if (!mode) return;
      event.preventDefault();
      event.stopPropagation();
      launchWorkspaceMode(mode.id);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hotkeys, launchWorkspaceMode, showOnboarding, pendingClose]);

  // Window controls
  const isWindowDragGestureTarget = useCallback((target) => {
    if (!(target instanceof Element)) return false;
    if (target.closest('[data-tauri-drag-region="false"]')) return false;
    if (target.closest(".shell-tab")) return false;
    if (
      target.closest(
        "button, input, textarea, select, option, a, [role='button'], [role='menuitem'], [contenteditable='true']",
      )
    ) {
      return false;
    }
    return true;
  }, []);

  const handleToolbarDoubleClick = useCallback(async (event) => {
    if (!isTauriRuntime) return;
    if (!isWindowDragGestureTarget(event.target)) return;
    event.preventDefault();
    const win = getCurrentWindow();
    if (await win.isMaximized()) await win.unmaximize();
    else await win.maximize();
  }, [isTauriRuntime, isWindowDragGestureTarget]);

  const isToolbarWindowDragTarget = useCallback((target) => {
    if (!(target instanceof Element)) return false;
    if (!isWindowDragGestureTarget(target)) return false;
    if (target.closest(".shell-new-tab-menu")) return false;
    return true;
  }, [isWindowDragGestureTarget]);

  const clearToolbarDragGesture = useCallback(() => {
    toolbarDragGestureRef.current = null;
  }, []);

  const handleToolbarPointerDownCapture = useCallback((event) => {
    if (!isTauriRuntime) return;
    if (event.button !== 0) return;
    if (event.pointerType === "touch") return;
    if (!isToolbarWindowDragTarget(event.target)) return;

    toolbarDragGestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
    };
  }, [isTauriRuntime, isToolbarWindowDragTarget]);

  const handleToolbarClickCapture = useCallback((event) => {
    if (Date.now() - lastToolbarDragAtRef.current > 250) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  useEffect(() => {
    if (!isTauriRuntime) return undefined;

    const handlePointerMove = (event) => {
      const gesture = toolbarDragGestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId || gesture.started) return;

      const dx = event.clientX - gesture.startX;
      const dy = event.clientY - gesture.startY;
      if (Math.hypot(dx, dy) < WINDOW_DRAG_THRESHOLD_PX) return;

      gesture.started = true;
      lastToolbarDragAtRef.current = Date.now();
      clearToolbarDragGesture();
      event.preventDefault();
      void getCurrentWindow().startDragging().catch(() => {});
    };

    const handlePointerEnd = (event) => {
      if (toolbarDragGestureRef.current?.pointerId !== event.pointerId) return;
      clearToolbarDragGesture();
    };

    window.addEventListener("pointermove", handlePointerMove, true);
    window.addEventListener("pointerup", handlePointerEnd, true);
    window.addEventListener("pointercancel", handlePointerEnd, true);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("pointerup", handlePointerEnd, true);
      window.removeEventListener("pointercancel", handlePointerEnd, true);
    };
  }, [clearToolbarDragGesture, isTauriRuntime]);

  const handleMinimize = async () => {
    if (!isTauriRuntime) return;
    await getCurrentWindow().minimize();
  };
  const handleMaximize = async () => {
    if (!isTauriRuntime) return;
    const win = getCurrentWindow();
    if (await win.isMaximized()) await win.unmaximize();
    else await win.maximize();
  };
  const handleClose = async () => {
    if (!isTauriRuntime) return;
    await getCurrentWindow().close();
  };

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];

  // Portal target for Row 2 context bar
  const contextBarRef = useRef(null);
  const [contextBarReady, setContextBarReady] = useState(false);

  // New-tab dropdown
  const [newTabOpen, setNewTabOpen] = useState(false);
  const newTabBtnRef = useRef(null);

  // Tabs that don't fit scroll inside the strip (New tab stays pinned at its
  // end). Keep the active tab in view once the toolbar mounts, when it
  // changes, a tab opens, or the window narrows.
  const tabStripRef = useRef(null);
  const homeTab = tabs.find((tab) => tab.type === "home");
  const sharedLabels = useMemo(() => {
    const seen = new Set();
    const shared = new Set();
    for (const tab of tabs) {
      if (tab.type === "home") continue;
      const label = tabDisplayLabel(tab.label);
      if (seen.has(label)) shared.add(label);
      seen.add(label);
    }
    return shared;
  }, [tabs]);
  useEffect(() => {
    const strip = tabStripRef.current;
    if (!booted || !strip || settingsOpen) return undefined;
    const reveal = () => strip.querySelector(".shell-tab.is-active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    reveal();
    // A new tab grows in over ~180 ms; reveal it again once it has its width.
    const timer = window.setTimeout(reveal, 240);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(reveal) : null;
    observer?.observe(strip);
    return () => {
      window.clearTimeout(timer);
      observer?.disconnect();
    };
  }, [booted, activeTabId, tabs.length, settingsOpen]);

  useEffect(() => {
    const strip = tabStripRef.current;
    if (!booted || !strip) return undefined;
    const mark = () => {
      strip.dataset.overflowStart = String(strip.scrollLeft > 1);
      strip.dataset.overflowEnd = String(strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1);
    };
    mark();
    strip.addEventListener("scroll", mark, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(mark) : null;
    observer?.observe(strip);
    const timer = window.setTimeout(mark, 240);
    return () => {
      strip.removeEventListener("scroll", mark);
      observer?.disconnect();
      window.clearTimeout(timer);
    };
  }, [booted, tabs.length, activeTabId]);

  // Close new-tab dropdown on outside click
  useEffect(() => {
    if (!newTabOpen) return;
    const handleClick = (e) => {
      if (newTabBtnRef.current?.contains(e.target)) return;
      setNewTabOpen(false);
    };
    window.addEventListener("mousedown", handleClick);
    return () => window.removeEventListener("mousedown", handleClick);
  }, [newTabOpen]);

  // WhatsNew modal: auto-open on new version, manual open from settings
  const [whatsNewManual, setWhatsNewManual] = useState(false);
  const handleOpenReleaseNotes = useCallback(() => setWhatsNewManual(true), []);
  const handleCloseWhatsNew = useCallback(() => setWhatsNewManual(false), []);
  const openFeedback = useCallback((reportType = "bug") => {
    setFeedbackInitialType(reportType === "feature" ? "feature" : "bug");
    setFeedbackInitialArea(feedbackAreaForTab(activeTab, settingsOpen));
    setIsBugReportOpen(true);
  }, [activeTab, settingsOpen]);

  // Home's utility links reach Shell-owned dialogs through these events.
  useEffect(() => {
    const handleReleaseNotes = () => setWhatsNewManual(true);
    const handleFeedback = (event) => openFeedback(event.detail?.type);
    window.addEventListener("cortex:open-release-notes", handleReleaseNotes);
    window.addEventListener("cortex:open-feedback", handleFeedback);
    return () => {
      window.removeEventListener("cortex:open-release-notes", handleReleaseNotes);
      window.removeEventListener("cortex:open-feedback", handleFeedback);
    };
  }, [openFeedback]);

  // Home's Start list, in its group order; viewer modes open a viewer tab.
  const newTabMenuOptions = useMemo(() => WORKSPACE_MODE_GROUPS.flatMap((group) =>
    WORKSPACE_MODES.filter((mode) => mode.group === group.id).map((mode) => ({
      id: mode.id,
      icon: mode.icon,
      label: mode.label,
      action: mode.action,
      hotkey: hotkeys[mode.action],
      onSelect: () => launchWorkspaceMode(mode.id),
    })),
  ), [launchWorkspaceMode, hotkeys]);


  return (
    <MotionConfig reducedMotion={reduceMotionPref ? "always" : "user"}>
    <GlobalContextMenu
      newTabOptions={newTabMenuOptions}
      onOpenHome={() => {
        setSettingsOpen(false);
        setActiveTabId("home");
      }}
      onOpenSettings={() => setSettingsOpen(true)}
    >
    <div className="shell-root">
      <AnimatePresence>{!booted ? <AppLoader /> : null}</AnimatePresence>

      <Suspense fallback={null}>
        {booted && <WhatsNew />}
        {whatsNewManual && <WhatsNew forceOpen isManual onClose={handleCloseWhatsNew} />}
        {bugReportLoaded && (
          <BugReportModal
            open={isBugReportOpen}
            initialType={feedbackInitialType}
            initialArea={feedbackInitialArea}
            onClose={() => setIsBugReportOpen(false)}
          />
        )}
      </Suspense>
      <AnimatePresence>
        {booted && showOnboarding ? (
          <Suspense fallback={null}>
            <Onboarding
              onComplete={handleOnboardingComplete}
            />
          </Suspense>
        ) : null}
      </AnimatePresence>

      {booted && (
        <>
          {/* ━━━ UNIFIED TOOLBAR (single row) ━━━ */}
          <motion.div
            className="shell-toolbar"
            onDoubleClick={handleToolbarDoubleClick}
            onPointerDownCapture={handleToolbarPointerDownCapture}
            onClickCapture={handleToolbarClickCapture}
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          >
            {homeTab ? (
              <button
                type="button"
                className={`shell-tab shell-tab-home ${homeTab.id === activeTabId ? "is-active" : ""}`}
                onClick={() => {
                  setSettingsOpen(false);
                  setActiveTabId(homeTab.id);
                }}
                aria-label="Home"
                aria-current={homeTab.id === activeTabId ? "page" : undefined}
                title="Home"
              >
                <img src={cortexLogo} alt="" className="shell-tab-logo" draggable={false} />
              </button>
            ) : null}

            {/* Tab strip — inline in the single row */}
            <div
              className="shell-tabs"
              ref={tabStripRef}
              onWheel={(event) => {
                // The strip hides its scrollbar, so a mouse wheel scrolls it sideways.
                const strip = event.currentTarget;
                if (event.deltaX || !event.deltaY || strip.scrollWidth <= strip.clientWidth) return;
                strip.scrollLeft += event.deltaY;
              }}
            >
              <AnimatePresence initial={false}>
                {tabs.map((tab, index) => {
                  const Icon = tabIconFor(tab);
                  const isTabActive = tab.id === activeTabId;
                  const isEditing = editingTabId === tab.id;

                  if (tab.type === "home") return null;

                  const tabElement = (
                    <motion.div
                      key={tab.id}
                      className={`shell-tab ${isTabActive ? "is-active" : ""} ${isEditing ? "is-editing" : ""}`}
                      onClick={() => {
                        setSettingsOpen(false);
                        setActiveTabId(tab.id);
                      }}
                      onDoubleClick={() => tab.closable && startRenameTab(tab.id)}
                      title={isEditing ? undefined : sharedLabels.has(tabDisplayLabel(tab.label)) && tabDetails[tab.id] ? `${tab.label} · ${tabDetails[tab.id]}` : tab.label}
                      layout="position"
                      initial={{ opacity: 0, width: 0 }}
                      animate={{ opacity: 1, width: "auto" }}
                      exit={{ opacity: 0, width: 0 }}
                      transition={{
                        layout: { duration: 0.18, ease: [0.2, 0.8, 0.2, 1] },
                        opacity: { duration: 0.14 },
                        width: { duration: 0.18, ease: [0.2, 0.8, 0.2, 1] },
                      }}
                    >
                      {isEditing ? (
                        <span className="shell-tab-select">
                          <Icon className="shell-tab-icon" aria-hidden="true" />
                          <input
                            ref={editTabRef}
                            type="text"
                            className="shell-tab-rename"
                            defaultValue={tab.label}
                            aria-label="Tab name"
                            onBlur={(e) => finishRenameTab(tab.id, e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") finishRenameTab(tab.id, e.target.value);
                              if (e.key === "Escape") setEditingTabId(null);
                            }}
                            onClick={(e) => e.stopPropagation()}
                            autoFocus
                          />
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="shell-tab-select"
                          aria-current={isTabActive ? "page" : undefined}
                          onKeyDown={(e) => {
                            if (e.key === "F2" && tab.closable) {
                              e.preventDefault();
                              startRenameTab(tab.id);
                            }
                          }}
                        >
                          <Icon className="shell-tab-icon" aria-hidden="true" />
                          <TabLabel text={tabDisplayLabel(tab.label)} isFile={tabDisplayLabel(tab.label) !== tab.label} />
                          {sharedLabels.has(tabDisplayLabel(tab.label)) && tabDetails[tab.id] ? (
                            <span className="shell-tab-detail">{tabDetails[tab.id]}</span>
                          ) : null}
                        </button>
                      )}
                      {tab.closable && (
                        <button
                          type="button"
                          className="shell-tab-close"
                          onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                          data-tauri-drag-region="false"
                          aria-label={`Close ${tab.label}`}
                          title="Close tab"
                        >
                          <X aria-hidden="true" />
                        </button>
                      )}

                    </motion.div>
                  );

                  if (tab.closable) {
                    return (
                      <Ctx.Root key={tab.id}>
                        <Ctx.Trigger>{tabElement}</Ctx.Trigger>
                        <Ctx.Content>
                          <Ctx.Item onSelect={() => startRenameTab(tab.id)}>
                            <Pencil aria-hidden="true" />
                            <span>Rename</span>
                            <Ctx.Shortcut keys="F2" />
                          </Ctx.Item>
                          <Ctx.Separator />
                          <Ctx.Item onSelect={() => closeTab(tab.id)}>
                            <X aria-hidden="true" />
                            <span>Close</span>
                          </Ctx.Item>
                          <Ctx.Item onSelect={() => closeOtherTabs(tab.id)} disabled={tabs.filter((t) => t.closable).length < 2}>
                            <CopyX aria-hidden="true" />
                            <span>Close other tabs</span>
                          </Ctx.Item>
                          <Ctx.Item onSelect={() => closeAllTabs()} destructive>
                            <Trash2 aria-hidden="true" />
                            <span>Close all tabs</span>
                          </Ctx.Item>
                        </Ctx.Content>
                      </Ctx.Root>
                    );
                  }

                  return tabElement;
                })}
              </AnimatePresence>

            {/* + New tab button (inside tabs flex row, at end) */}
            <div className="shell-new-tab-wrap" ref={newTabBtnRef} data-tauri-drag-region="false">
                <button
                  type="button"
                  className={`shell-new-tab-btn ${newTabOpen ? "is-open" : ""}`}
                  onClick={() => setNewTabOpen((p) => !p)}
                  data-tauri-drag-region="false"
                  title="New tab"
                  aria-label="New tab"
                  aria-haspopup="menu"
                  aria-expanded={newTabOpen}
                >
                  <Plus aria-hidden="true" />
                </button>
                <AnimatePresence>
                  {newTabOpen && (
                    <motion.div
                      className="shell-new-tab-menu"
                      role="menu"
                      aria-label="New tab"
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.14, ease: [0.2, 0.8, 0.2, 1] }}
                    >
                      <div className="shell-new-tab-heading cx-label">New tab</div>
                      {newTabMenuOptions.map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          role="menuitem"
                          className="shell-new-tab-option"
                          onClick={() => { opt.onSelect(); setNewTabOpen(false); }}
                        >
                          <opt.icon className="shell-new-tab-option-icon" aria-hidden="true" />
                          <span className="shell-new-tab-option-label">{opt.label}</span>
                          <Keycaps hotkey={opt.hotkey} />
                        </button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
            </div>
            </div>

            <div
              className="shell-context"
              ref={(node) => {
                contextBarRef.current = node;
                if (node && !contextBarReady) setContextBarReady(true);
              }}
            />

            {/* Draggable spacer (right-click for new tab) */}
            <Ctx.Root>
              <Ctx.Trigger>
                <div className="shell-toolbar-spacer" />
              </Ctx.Trigger>
              <Ctx.Content aria-label="New tab">
                <Ctx.Label>New tab</Ctx.Label>
                {newTabMenuOptions.map((opt) => (
                  <Ctx.Item key={opt.id} onSelect={opt.onSelect}>
                    <opt.icon aria-hidden="true" />
                    <span>{opt.label}</span>
                    <Ctx.Shortcut hotkey={opt.hotkey} />
                  </Ctx.Item>
                ))}
              </Ctx.Content>
            </Ctx.Root>

            <UpdateToolbarControl />

            <button
              type="button"
              className="shell-frame-btn"
              aria-label="Send feedback"
              title="Send feedback"
              onClick={() => openFeedback("bug")}
            >
              <MessageSquarePlus aria-hidden="true" />
            </button>

            {/* Settings */}
            <Suspense fallback={null}>
              <SettingsMenu
                pageOpen={settingsOpen}
                onOpenChange={setSettingsOpen}
                onSettingsSaved={handleSettingsSaved}
                onOpenReleaseNotes={handleOpenReleaseNotes}
              />
            </Suspense>

            {/* Window controls */}
            <motion.div
              className="shell-window-controls"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.2, duration: 0.25 }}
            >
              <button
                type="button"
                className="shell-wc-btn shell-wc-min"
                onClick={handleMinimize}
                aria-label="Minimize"
                data-tauri-drag-region="false"
              >
                <Minus className="shell-wc-icon" />
              </button>
              <button
                type="button"
                className="shell-wc-btn shell-wc-max"
                onClick={handleMaximize}
                aria-label="Maximize"
                data-tauri-drag-region="false"
              >
                <Square className="shell-wc-icon" />
              </button>
              <button
                type="button"
                className="shell-wc-btn shell-wc-close"
                onClick={handleClose}
                aria-label="Close"
                data-tauri-drag-region="false"
              >
                <X className="shell-wc-icon" />
              </button>
            </motion.div>
          </motion.div>

          {/* ━━━ Tab Panes: ALL stay mounted, only active one is visible ━━━ */}
          <div className="shell-content">
            {tabs.map((tab) => {
              const isActive = tab.id === activeTabId && !settingsOpen;
              if (tab.deferred && tab.id !== activeTabId) {
                return <div key={tab.id} className="shell-pane is-hidden" aria-hidden="true" />;
              }

              return (
                <div
                  key={tab.id}
                  className={`shell-pane ${tab.id === activeTabId ? "is-visible" : "is-hidden"}`}
                  aria-hidden={!isActive}
                  inert={!isActive}
                  ref={(node) => {
                    if (node) paneRefs.current.set(tab.id, node);
                    else paneRefs.current.delete(tab.id);
                  }}
                >
                  {tab.type === "home" && (
                    <MemoHomePage
                      isActive={isActive}
                      onNavigate={handleNavigate}
                      onOpenWorkspace={handleOpenWorkspace}
                      onOpenSavedVehicle={handleOpenSavedVehicle}
                      settingsVersion={settingsVersion}
                    />
                  )}
                  {tab.type === "viewer" && (
                    <Suspense fallback={<AppLoader variant="pane" />}>
                    <App
                      shellTab={tab}
                      isActive={isActive}
                      defaultTextureMode={tab.defaultMode || "vehicle"}
                      initialState={tab.initialState || null}
                      onRenameTab={tabRenameSetter(tab.id)}
                      onTabDetail={tabDetailSetter(tab.id)}
                      onOpenPackBuilder={openPackBuilder}
                      settingsVersion={settingsVersion}
                      contextBarTarget={contextBarRef.current}
                    />
                    </Suspense>
                  )}
                  {tab.type === "eupstudio" && (
                    <Suspense fallback={<AppLoader variant="pane" />}>
                      <EupPage
                        workspaceState={tab.initialState || EMPTY_STATE}
                        onStateChange={getPageStateCallback(tab.id, "eupstudio")}
                        onRenameTab={tabRenameSetter(tab.id)}
                        isActive={isActive}
                        contextBarTarget={contextBarRef.current}
                      />
                    </Suspense>
                  )}
                  {tab.type === "propstudio" && (
                    <Suspense fallback={<AppLoader variant="pane" />}>
                      <PropStudioPage
                        workspaceState={tab.initialState || EMPTY_STATE}
                        onStateChange={getPageStateCallback(tab.id, "propstudio")}
                        onRenameTab={tabRenameSetter(tab.id)}
                        isActive={isActive}
                        contextBarTarget={contextBarRef.current}
                      />
                    </Suspense>
                  )}
                  {tab.type === "photo" && (
                    <Suspense fallback={<AppLoader variant="pane" />}>
                      <PhotoModePage
                        workspaceState={tab.initialState || EMPTY_STATE}
                        onStateChange={getPageStateCallback(tab.id, "photo")}
                        isActive={isActive}
                        contextBarTarget={contextBarRef.current}
                      />
                    </Suspense>
                  )}
                  {tab.type === "variants" && (
                    <Suspense fallback={<AppLoader variant="pane" />}>
                      <VariantsPage
                        workspaceState={tab.initialState || EMPTY_STATE}
                        onStateChange={getPageStateCallback(tab.id, "variants")}
                        onRenameTab={tabRenameSetter(tab.id)}
                        settingsVersion={settingsVersion}
                        isActive={isActive}
                        contextBarTarget={contextBarRef.current}
                      />
                    </Suspense>
                  )}
                  {tab.type === "templategen" && (
                    <Suspense fallback={<AppLoader variant="pane" />}>
                      <TemplateGenerationPage
                        workspaceState={tab.initialState || EMPTY_STATE}
                        onStateChange={getPageStateCallback(tab.id, "templategen")}
                        onRenameTab={tabRenameSetter(tab.id)}
                        settingsVersion={settingsVersion}
                        isActive={isActive}
                        contextBarTarget={contextBarRef.current}
                      />
                    </Suspense>
                  )}

                </div>
              );
            })}
          </div>
        </>
      )}
      <UnsavedChangesDialog pending={pendingClose} onCancel={cancelPendingClose} onConfirm={confirmPendingClose} />
    </div>
    </GlobalContextMenu>
    </MotionConfig>
  );
}
