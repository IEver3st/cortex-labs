import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { AnimatePresence, motion, useMotionValue, useTransform, useSpring } from "motion/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Minus, Square, X, Home, Eye, Layers, Settings, Pencil, Trash2, Copy, Plus, Car, Shirt, Link2, Palette, ChevronDown, Info } from "lucide-react";
import AppLoader from "./components/AppLoader";
import HomePage from "./components/HomePage";
import App from "./App";
import VariantsPage from "./components/VariantsPage";
import Onboarding from "./components/Onboarding";
import SettingsMenu from "./components/SettingsMenu";
import WhatsNew from "./components/WhatsNew";
import * as Ctx from "./components/ContextMenu";
import appMeta from "../package.json";
import cortexLogo from "../src-tauri/icons/cortex-logo.svg";
import {
  setActiveWorkspaceId,
  updateWorkspace,
  createWorkspace,
  loadWorkspaces,
  renameWorkspace,
  addRecent,
} from "./lib/workspace";
import { loadOnboarded, setOnboarded, loadPrefs } from "./lib/prefs";
import {
  DEFAULT_HOTKEYS,
  HOTKEY_ACTIONS,
  findMatchingAction,
  mergeHotkeys,
} from "./lib/hotkeys";

const MIN_BOOT_MS = 500;

function generateTabId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

const TAB_ICONS = {
  home: Home,
  viewer: Eye,
  variants: Layers,
};

const MIN_UI_SCALE = 0.5;
const MAX_UI_SCALE = 1.4;

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

  // Tab system
  const [tabs, setTabs] = useState([
    { id: "home", type: "home", label: "Home", workspaceId: null, closable: false },
  ]);
  const [activeTabId, setActiveTabId] = useState("home");
  const [editingTabId, setEditingTabId] = useState(null);
  const editTabRef = useRef(null);
  // Track pending tab activation (for use after setTabs)
  const pendingActiveRef = useRef(null);
  const lastExternalFileOpenRef = useRef({ path: "", at: 0 });

  // Per-tab variant state cache
  const [variantStates, setVariantStates] = useState({});

  // Settings change counter — bumped when settings are saved so children re-read prefs
  const [settingsVersion, setSettingsVersion] = useState(0);

  // Map of tabId -> pane element for focus management
  const paneRefs = useRef(new Map());

  // Hotkeys for new-tab shortcuts (reloaded when settings change)
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

    const stored = prefs?.hotkeys && typeof prefs.hotkeys === "object" ? prefs.hotkeys : {};
    setHotkeys(mergeHotkeys(stored, DEFAULT_HOTKEYS));
  }, [settingsVersion]);

  // Boot
  useEffect(() => {
    const timer = setTimeout(() => setBooted(true), MIN_BOOT_MS);
    return () => clearTimeout(timer);
  }, []);

  // Open a new tab (or focus existing for same workspace)
  const openTab = useCallback((type, label, workspaceId, state, defaultMode) => {
    setTabs((prev) => {
      const existing = workspaceId ? prev.find((t) => t.workspaceId === workspaceId) : null;
      if (existing) {
        // Tab already exists — just activate it directly
        pendingActiveRef.current = existing.id;
        // Force a state update so the useEffect fires
        return [...prev];
      }

      const modeLabels = { livery: "Livery", everything: "All", eup: "EUP", multi: "Multi" };
      const newTab = {
        id: generateTabId(),
        type,
        label: label || (type === "viewer" ? (modeLabels[defaultMode] || "Preview") : "Variants"),
        workspaceId: workspaceId || null,
        closable: true,
        defaultMode: defaultMode || null,
        initialState: state || null,
      };

      if (state && type === "variants") {
        setVariantStates((s) => ({ ...s, [newTab.id]: state }));
      }

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
    if (!(lower.endsWith(".yft") || lower.endsWith(".ydd") || lower.endsWith(".dff") || lower.endsWith(".clmesh"))) {
      return;
    }

    const fileName = filePath.split(/[\\/]/).pop();
    const mode = lower.endsWith(".ydd") ? "eup" : "livery";
    const initialState = { textureMode: mode, modelPath: filePath, openFile: filePath };
    const wsId = createWorkspace(fileName, "viewer", initialState);
    openTab("viewer", fileName, wsId, initialState, mode);
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
    };

    start();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [isTauriRuntime, handleExternalFileOpen]);

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

  // Close tab
  const closeTab = useCallback((tabId) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tabId);
      if (idx === -1) return prev;
      if (!prev[idx].closable) return prev;

      const next = prev.filter((t) => t.id !== tabId);
      if (tabId === activeTabId) {
        const newIdx = Math.min(idx, next.length - 1);
        setActiveTabId(next[newIdx]?.id || "home");
      }
      return next;
    });
    setVariantStates((s) => {
      const next = { ...s };
      delete next[tabId];
      return next;
    });
  }, [activeTabId]);

  // Close other tabs
  const closeOtherTabs = useCallback((keepTabId) => {
    setTabs((prev) => prev.filter((t) => !t.closable || t.id === keepTabId));
    setActiveTabId(keepTabId);
  }, []);

  // Close all closable tabs
  const closeAllTabs = useCallback(() => {
    setTabs((prev) => prev.filter((t) => !t.closable));
    setActiveTabId("home");
  }, []);

  // Rename tab (called by child components when content loads)
  const renameTab = useCallback((tabId, newLabel) => {
    if (!newLabel?.trim()) return;
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, label: newLabel.trim() } : t))
    );
  }, []);

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

  // Navigate from HomePage
  const handleNavigate = useCallback((type, workspaceId, defaultMode) => {
    const ws = workspaceId ? loadWorkspaces()[workspaceId] : null;
    const modeLabels = { livery: "Livery", everything: "All", eup: "EUP", multi: "Multi" };
    const label = ws?.name || (type === "viewer" ? (modeLabels[defaultMode] || "Preview") : "Variants");
    openTab(type, label, workspaceId, ws?.state, defaultMode);
    if (workspaceId) {
      setActiveWorkspaceId(workspaceId);
      addRecent(workspaceId, label, type);
    }
  }, [openTab]);

  const handleOpenWorkspace = useCallback((ws) => {
    if (!ws?.id) return;
    const latestWs = loadWorkspaces()[ws.id] || ws;
    const defaultMode = latestWs?.state?.textureMode || "livery";
    const page = latestWs.page === "variants" ? "variants" : "viewer";
    openTab(page, latestWs.name, latestWs.id, latestWs.state, defaultMode);
    setActiveWorkspaceId(latestWs.id);
    addRecent(latestWs.id, latestWs.name, page);
  }, [openTab]);

  // Variant state per-tab
  const handleVariantStateChange = useCallback((tabId, state) => {
    setVariantStates((s) => ({ ...s, [tabId]: state }));
    const tab = tabs.find((t) => t.id === tabId);
    if (tab?.workspaceId) updateWorkspace(tab.workspaceId, { state, page: "variants" });
  }, [tabs]);

  // Onboarding
  const handleOnboardingComplete = useCallback((action) => {
    setOnboarded();
    setShowOnboarding(false);

    if (!action || typeof action !== "object") return;

    if (action.type === "launch") {
      const target = action.target;
      if (target === "variants") {
        handleNavigate("variants");
        return;
      }

      const mode = ["livery", "everything", "eup", "multi"].includes(target)
        ? target
        : "livery";
      handleNavigate("viewer", null, mode);
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
  }, [handleNavigate]);

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

  // Global hotkeys for opening new mode tabs
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

      const modeMap = {
        [HOTKEY_ACTIONS.NEW_TAB_LIVERY]: "livery",
        [HOTKEY_ACTIONS.NEW_TAB_ALL]: "everything",
        [HOTKEY_ACTIONS.NEW_TAB_EUP]: "eup",
        [HOTKEY_ACTIONS.NEW_TAB_MULTI]: "multi",
      };
      const mode = modeMap[action];
      if (mode) {
        event.preventDefault();
        event.stopPropagation();
        const modeLabels = { livery: "Livery", everything: "All", eup: "EUP", multi: "Multi" };
        const label = modeLabels[mode] || "Preview";
        const id = createWorkspace(label, "viewer", { textureMode: mode });
        openTab("viewer", label, id, { textureMode: mode }, mode);
        setActiveWorkspaceId(id);
        addRecent(id, label, "viewer");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hotkeys, openTab]);

  // Window controls
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
  const handleOpenOnboarding = useCallback(() => setShowOnboarding(true), []);

  // New-tab dropdown option data for DRY rendering
  const newTabOptions = useMemo(() => [
    { mode: "livery", icon: Car, label: "Livery", type: "viewer" },
    { mode: "everything", icon: Layers, label: "All", type: "viewer" },
    { mode: "eup", icon: Shirt, label: "EUP", type: "viewer" },
    { mode: "multi", icon: Link2, label: "Multi", type: "viewer" },
  ], []);

  return (
    <div className="shell-root">
      <AnimatePresence>{!booted ? <AppLoader /> : null}</AnimatePresence>

      {booted && <WhatsNew />}
      {whatsNewManual && <WhatsNew forceOpen isManual onClose={handleCloseWhatsNew} />}
      <AnimatePresence>
        {booted && showOnboarding ? (
          <Onboarding onComplete={handleOnboardingComplete} />
        ) : null}
      </AnimatePresence>

      {booted && (
        <>
          {/* ━━━ UNIFIED TOOLBAR (single row) ━━━ */}
          <motion.div
            className="shell-toolbar"
            data-tauri-drag-region
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          >
            {/* Brand mark */}
            <div className="shell-brand" data-tauri-drag-region>
              <img src={cortexLogo} alt="" className="shell-brand-logo" draggable={false} />
              <span className="shell-brand-name">CORTEX</span>
            </div>

            <div className="shell-toolbar-sep" />

            {/* Tab strip — inline in the single row */}
            <div className="shell-tabs" data-tauri-drag-region>
              <AnimatePresence initial={false}>
                {tabs.map((tab, index) => {
                  const Icon = TAB_ICONS[tab.type] || Eye;
                  const isTabActive = tab.id === activeTabId;
                  const isEditing = editingTabId === tab.id;

                  const tabElement = (
                    <motion.div
                      key={tab.id}
                      className={`shell-tab ${isTabActive ? "is-active" : ""}`}
                      onClick={() => setActiveTabId(tab.id)}
                      onDoubleClick={() => tab.closable && startRenameTab(tab.id)}
                      layout
                      initial={{ opacity: 0, scale: 0.9, width: 0 }}
                      animate={{ opacity: 1, scale: 1, width: "auto" }}
                      exit={{ opacity: 0, scale: 0.9, width: 0, marginRight: -1 }}
                      transition={{
                        layout: { type: "spring", stiffness: 500, damping: 35 },
                        opacity: { duration: 0.15 },
                        scale: { duration: 0.2, ease: [0.22, 1, 0.36, 1] },
                        width: { duration: 0.2, ease: [0.22, 1, 0.36, 1] },
                      }}
                      whileHover={!isTabActive ? { backgroundColor: "rgba(255,255,255,0.04)" } : {}}
                    >
                      <motion.span
                        className="shell-tab-icon-wrap"
                        animate={isTabActive ? { scale: 1 } : { scale: 0.9 }}
                        transition={{ type: "spring", stiffness: 400, damping: 25 }}
                      >
                        <Icon className="shell-tab-icon" />
                      </motion.span>
                      {isEditing ? (
                        <input
                          ref={editTabRef}
                          type="text"
                          className="shell-tab-rename"
                          defaultValue={tab.label}
                          onBlur={(e) => finishRenameTab(tab.id, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") finishRenameTab(tab.id, e.target.value);
                            if (e.key === "Escape") setEditingTabId(null);
                          }}
                          onClick={(e) => e.stopPropagation()}
                          autoFocus
                        />
                      ) : (
                        <span className="shell-tab-label">{tab.label}</span>
                      )}
                      {tab.closable && (
                        <motion.button
                          type="button"
                          className="shell-tab-close"
                          onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                          data-tauri-drag-region="false"
                          whileHover={{ scale: 1.15, backgroundColor: "rgba(232,93,76,0.15)" }}
                          whileTap={{ scale: 0.9 }}
                          transition={{ type: "spring", stiffness: 400, damping: 20 }}
                        >
                          <X className="w-3 h-3" />
                        </motion.button>
                      )}

                      {/* Seamless tab: paint over the bottom border with content bg */}
                      {isTabActive && (
                        <div className="shell-tab-seamless" />
                      )}
                    </motion.div>
                  );

                  if (tab.closable) {
                    return (
                      <Ctx.Root key={tab.id}>
                        <Ctx.Trigger>{tabElement}</Ctx.Trigger>
                        <Ctx.Content>
                          <Ctx.Item onSelect={() => startRenameTab(tab.id)}>
                            <Pencil className="w-3 h-3" /> Rename
                          </Ctx.Item>
                          <Ctx.Separator />
                          <Ctx.Item onSelect={() => closeTab(tab.id)}>
                            <X className="w-3 h-3" /> Close
                          </Ctx.Item>
                          <Ctx.Item onSelect={() => closeOtherTabs(tab.id)}>
                            Close Others
                          </Ctx.Item>
                          <Ctx.Item onSelect={() => closeAllTabs()} destructive>
                            <Trash2 className="w-3 h-3" /> Close All
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
                <motion.button
                  type="button"
                  className="shell-new-tab-btn"
                  onClick={() => setNewTabOpen((p) => !p)}
                  data-tauri-drag-region="false"
                  title="New tab"
                  whileHover={{ scale: 1.08, backgroundColor: "rgba(255,255,255,0.06)" }}
                  whileTap={{ scale: 0.92 }}
                  transition={{ type: "spring", stiffness: 500, damping: 25 }}
                >
                  <motion.span
                    animate={newTabOpen ? { rotate: 45 } : { rotate: 0 }}
                    transition={{ type: "spring", stiffness: 400, damping: 20 }}
                  >
                    <Plus className="w-3 h-3" />
                  </motion.span>
                </motion.button>
                <AnimatePresence>
                  {newTabOpen && (
                    <motion.div
                      className="shell-new-tab-menu"
                      initial={{ opacity: 0, y: -6, scale: 0.95 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -6, scale: 0.95 }}
                      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                    >
                      {newTabOptions.map((opt, i) => (
                        <motion.button
                          key={opt.mode}
                          className="shell-new-tab-option"
                          onClick={() => { handleNavigate(opt.type, null, opt.mode); setNewTabOpen(false); }}
                          initial={{ opacity: 0, x: -8 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: i * 0.03, duration: 0.15 }}
                          whileHover={{ x: 3, backgroundColor: "rgba(61,186,163,0.08)" }}
                        >
                          <opt.icon className="w-3 h-3" /> {opt.label}
                        </motion.button>
                      ))}
                      <div className="shell-new-tab-sep" />
                      <motion.button
                        className="shell-new-tab-option"
                        onClick={() => { handleNavigate("variants"); setNewTabOpen(false); }}
                        initial={{ opacity: 0, x: -8 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: 0.12, duration: 0.15 }}
                        whileHover={{ x: 3, backgroundColor: "rgba(61,186,163,0.08)" }}
                      >
                        <Palette className="w-3 h-3" /> Variant Builder
                      </motion.button>
                    </motion.div>
                  )}
                </AnimatePresence>
            </div>
            </div>

            {/* Context bar — page-specific controls portaled here */}
            <div
              className="shell-context"
              data-tauri-drag-region
              ref={(node) => {
                contextBarRef.current = node;
                if (node && !contextBarReady) setContextBarReady(true);
              }}
            />

            {/* Draggable spacer (right-click for new tab) */}
            <Ctx.Root>
              <Ctx.Trigger>
                <div className="shell-toolbar-spacer" data-tauri-drag-region />
              </Ctx.Trigger>
              <Ctx.Content>
                <Ctx.Label>New Tab</Ctx.Label>
                <Ctx.Item onSelect={() => handleNavigate("viewer", null, "livery")}>
                  <Car className="w-3 h-3" /> New Livery
                </Ctx.Item>
                <Ctx.Item onSelect={() => handleNavigate("viewer", null, "everything")}>
                  <Layers className="w-3 h-3" /> New All
                </Ctx.Item>
                <Ctx.Item onSelect={() => handleNavigate("viewer", null, "eup")}>
                  <Shirt className="w-3 h-3" /> New EUP
                </Ctx.Item>
                <Ctx.Item onSelect={() => handleNavigate("viewer", null, "multi")}>
                  <Link2 className="w-3 h-3" /> New Multi
                </Ctx.Item>
                <Ctx.Separator />
                <Ctx.Item onSelect={() => handleNavigate("variants")}>
                  <Palette className="w-3 h-3" /> New Variant Builder
                </Ctx.Item>
              </Ctx.Content>
            </Ctx.Root>

            {/* Getting started / tutorial */}
            <div className="settings-anchor">
              <motion.button
                type="button"
                className="settings-cog"
                aria-label="Getting Started"
                title="Getting Started"
                onClick={handleOpenOnboarding}
              >
                <span className="settings-cog-icon">
                  <Info className="settings-cog-svg" />
                </span>
              </motion.button>
            </div>

            {/* Settings */}
            <SettingsMenu onSettingsSaved={handleSettingsSaved} onOpenReleaseNotes={handleOpenReleaseNotes} />

            {/* Window controls */}
            <motion.div
              className="shell-window-controls"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.2, duration: 0.25 }}
            >
              <motion.button
                type="button"
                className="shell-wc-btn shell-wc-min"
                onClick={handleMinimize}
                aria-label="Minimize"
                data-tauri-drag-region="false"
                whileHover={{ backgroundColor: "rgba(255,255,255,0.08)" }}
                whileTap={{ scale: 0.88 }}
                transition={{ type: "spring", stiffness: 400, damping: 25 }}
              >
                <Minus className="shell-wc-icon" />
              </motion.button>
              <motion.button
                type="button"
                className="shell-wc-btn shell-wc-max"
                onClick={handleMaximize}
                aria-label="Maximize"
                data-tauri-drag-region="false"
                whileHover={{ backgroundColor: "rgba(255,255,255,0.08)" }}
                whileTap={{ scale: 0.88 }}
                transition={{ type: "spring", stiffness: 400, damping: 25 }}
              >
                <Square className="shell-wc-icon" />
              </motion.button>
              <motion.button
                type="button"
                className="shell-wc-btn shell-wc-close"
                onClick={handleClose}
                aria-label="Close"
                data-tauri-drag-region="false"
                whileTap={{ scale: 0.88 }}
                transition={{ type: "spring", stiffness: 400, damping: 25 }}
              >
                <X className="shell-wc-icon" />
              </motion.button>
            </motion.div>
          </motion.div>

          {/* ━━━ Tab Panes: ALL stay mounted, only active one is visible ━━━ */}
          <div className="shell-content">
            {tabs.map((tab) => {
              const isActive = tab.id === activeTabId;

              return (
                <div
                  key={tab.id}
                  className={`shell-pane ${isActive ? "is-visible" : "is-hidden"}`}
                  aria-hidden={!isActive}
                  inert={!isActive}
                  ref={(node) => {
                    if (node) paneRefs.current.set(tab.id, node);
                    else paneRefs.current.delete(tab.id);
                  }}
                >
                  {tab.type === "home" && (
                    <HomePage
                      onNavigate={handleNavigate}
                      onOpenWorkspace={handleOpenWorkspace}
                      settingsVersion={settingsVersion}
                    />
                  )}
                  {tab.type === "viewer" && (
                    <App
                      shellTab={tab}
                      isActive={isActive}
                      defaultTextureMode={tab.defaultMode || "livery"}
                      initialState={tab.initialState || null}
                      onRenameTab={(label) => renameTab(tab.id, label)}
                      settingsVersion={settingsVersion}
                      contextBarTarget={contextBarRef.current}
                    />
                  )}
                  {tab.type === "variants" && (
                    <VariantsPage
                      workspaceState={variantStates[tab.id] || tab.initialState || {}}
                      onStateChange={(state) => handleVariantStateChange(tab.id, state)}
                      onRenameTab={(label) => renameTab(tab.id, label)}
                      settingsVersion={settingsVersion}
                      isActive={isActive}
                      contextBarTarget={contextBarRef.current}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
