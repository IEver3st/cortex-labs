import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { Minus, Square, X, Home, Eye, Layers, Settings, Pencil, Trash2, Copy, Plus, Car, Shirt, Link2, Palette } from "lucide-react";
import AppLoader from "./components/AppLoader";
import HomePage from "./components/HomePage";
import App from "./App";
import VariantsPage from "./components/VariantsPage";
import Onboarding from "./components/Onboarding";
import SettingsMenu from "./components/SettingsMenu";
import * as Ctx from "./components/ContextMenu";
import appMeta from "../package.json";
import {
  setActiveWorkspaceId,
  updateWorkspace,
  createWorkspace,
  loadWorkspaces,
  renameWorkspace,
  addRecent,
} from "./lib/workspace";
import { loadOnboarded, setOnboarded, loadPrefs, savePrefs } from "./lib/prefs";
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

  // Per-tab variant state cache
  const [variantStates, setVariantStates] = useState({});

  // Settings change counter — bumped when settings are saved so children re-read prefs
  const [settingsVersion, setSettingsVersion] = useState(0);

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

  // Apply UI scale from prefs on boot and when settings change; reload hotkeys
  useEffect(() => {
    const prefs = loadPrefs();
    const scale = prefs?.defaults?.uiScale ?? 1.0;
    document.documentElement.style.setProperty("--es-ui-scale", String(scale));
    const stored = prefs?.hotkeys && typeof prefs.hotkeys === "object" ? prefs.hotkeys : {};
    setHotkeys(mergeHotkeys(stored, DEFAULT_HOTKEYS));
  }, [settingsVersion]);

  // Boot
  useEffect(() => {
    const timer = setTimeout(() => setBooted(true), MIN_BOOT_MS);
    return () => clearTimeout(timer);
  }, []);

  // File-open handler
  useEffect(() => {
    if (!isTauriRuntime) return;
    let unlisten;
    let cancelled = false;

    listen("file-open", (event) => {
      const filePath = event.payload;
      if (typeof filePath !== "string" || !filePath) return;
      const lower = filePath.toLowerCase();
      if (lower.endsWith(".yft") || lower.endsWith(".ydd") || lower.endsWith(".dff") || lower.endsWith(".clmesh")) {
        const fileName = filePath.split(/[\\/]/).pop();
        const wsId = createWorkspace(fileName, "viewer", { openFile: filePath });
        openTab("viewer", fileName, wsId);
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [isTauriRuntime]);

  // Open a new tab (or focus existing for same workspace)
  const openTab = useCallback((type, label, workspaceId, state, defaultMode) => {
    let tabIdToActivate = null;

    setTabs((prev) => {
      const existing = workspaceId ? prev.find((t) => t.workspaceId === workspaceId) : null;
      if (existing) {
        tabIdToActivate = existing.id;
        return prev;
      }

      const modeLabels = { livery: "Livery", everything: "All", eup: "EUP", multi: "Multi" };
      const newTab = {
        id: generateTabId(),
        type,
        label: label || (type === "viewer" ? (modeLabels[defaultMode] || "Preview") : "Variants"),
        workspaceId: workspaceId || null,
        closable: true,
        defaultMode: defaultMode || null,
      };

      if (state && type === "variants") {
        setVariantStates((s) => ({ ...s, [newTab.id]: state }));
      }

      tabIdToActivate = newTab.id;
      return [...prev, newTab];
    });

    // Activate after setTabs completes to avoid batching issues
    if (tabIdToActivate) {
      pendingActiveRef.current = tabIdToActivate;
    }
  }, []);

  // Flush pending tab activation after tabs state updates
  useEffect(() => {
    if (pendingActiveRef.current) {
      setActiveTabId(pendingActiveRef.current);
      pendingActiveRef.current = null;
    }
  }, [tabs]);

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
    const defaultMode = ws?.state?.textureMode || "livery";
    openTab(ws.page, ws.name, ws.id, ws.state, defaultMode);
    setActiveWorkspaceId(ws.id);
    addRecent(ws.id, ws.name, ws.page);
  }, [openTab]);

  // Variant state per-tab
  const handleVariantStateChange = useCallback((tabId, state) => {
    setVariantStates((s) => ({ ...s, [tabId]: state }));
    const tab = tabs.find((t) => t.id === tabId);
    if (tab?.workspaceId) updateWorkspace(tab.workspaceId, { state, page: "variants" });
  }, [tabs]);

  // Onboarding
  const handleOnboardingComplete = useCallback((defaults) => {
    const prefs = loadPrefs() || {};
    savePrefs({ ...prefs, defaults });
    setOnboarded();
    setShowOnboarding(false);
    // Apply UI scale
    if (defaults?.uiScale) {
      document.documentElement.style.setProperty("--es-ui-scale", String(defaults.uiScale));
    }
  }, []);

  // Settings saved callback
  const handleSettingsSaved = useCallback(() => {
    setSettingsVersion((v) => v + 1);
  }, []);

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

  return (
    <div className="shell-root">
      <AnimatePresence>{!booted ? <AppLoader /> : null}</AnimatePresence>

      {booted && (
        <>
          {/* ─── Chrome: Brand + Tabs + Settings + Window Controls ─── */}
          <div className="shell-chrome" data-tauri-drag-region>
            <div className="shell-brand" data-tauri-drag-region>
              <img src="/app-icon.svg" alt="" className="shell-brand-logo" aria-hidden="true" />
              <span className="shell-brand-name">Cortex Studio</span>
            </div>

            <div className="shell-chrome-divider" />

            {/* Tab strip */}
            <div className="shell-tabs" data-tauri-drag-region>
              <AnimatePresence initial={false}>
                {tabs.map((tab) => {
                  const Icon = TAB_ICONS[tab.type] || Eye;
                  const isActive = tab.id === activeTabId;
                  const isEditing = editingTabId === tab.id;

                  const tabElement = (
                    <motion.div
                      key={tab.id}
                      className={`shell-tab ${isActive ? "is-active" : ""}`}
                      onClick={() => setActiveTabId(tab.id)}
                      onDoubleClick={() => tab.closable && startRenameTab(tab.id)}
                      layout
                      initial={{ opacity: 0, scale: 0.92, width: 0 }}
                      animate={{ opacity: 1, scale: 1, width: "auto" }}
                      exit={{ opacity: 0, scale: 0.92, width: 0 }}
                      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                    >
                      <Icon className="shell-tab-icon" />
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
                        <button
                          type="button"
                          className="shell-tab-close"
                          onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                          data-tauri-drag-region="false"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </motion.div>
                  );

                  // Wrap closable tabs with context menu
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
            </div>

            {/* Empty spacer with context menu for new tabs */}
            <Ctx.Root>
              <Ctx.Trigger>
                <div className="shell-chrome-spacer" data-tauri-drag-region />
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

            {/* Version pill */}
            <span className="shell-chrome-version">v{appMeta.version}</span>

            {/* Settings (app-wide, in chrome bar) */}
            <SettingsMenu onSettingsSaved={handleSettingsSaved} />

            {/* Window controls */}
            <div className="titlebar-controls">
              <button type="button" className="titlebar-btn titlebar-min" onClick={handleMinimize} aria-label="Minimize" data-tauri-drag-region="false">
                <Minus className="titlebar-icon titlebar-icon--min" />
              </button>
              <button type="button" className="titlebar-btn titlebar-max" onClick={handleMaximize} aria-label="Maximize" data-tauri-drag-region="false">
                <Square className="titlebar-icon titlebar-icon--max" />
              </button>
              <button type="button" className="titlebar-btn titlebar-close" onClick={handleClose} aria-label="Close" data-tauri-drag-region="false">
                <X className="titlebar-icon titlebar-icon--close" />
              </button>
            </div>
          </div>

          {/* ─── Tab Panes: ALL stay mounted, only active one is visible ─── */}
          <div className="shell-content">
            {tabs.map((tab) => {
              const isActive = tab.id === activeTabId;

              return (
                <div
                  key={tab.id}
                  className={`shell-pane ${isActive ? "is-visible" : "is-hidden"}`}
                  aria-hidden={!isActive}
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
                      onRenameTab={(label) => renameTab(tab.id, label)}
                      settingsVersion={settingsVersion}
                    />
                  )}
                  {tab.type === "variants" && (
                    <VariantsPage
                      workspaceState={variantStates[tab.id] || tab.state || {}}
                      onStateChange={(state) => handleVariantStateChange(tab.id, state)}
                      onRenameTab={(label) => renameTab(tab.id, label)}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {/* Onboarding */}
          <AnimatePresence>
            {showOnboarding && <Onboarding onComplete={handleOnboardingComplete} />}
          </AnimatePresence>
        </>
      )}
    </div>
  );
}
