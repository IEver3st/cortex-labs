import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Minus, Square, X, Home, Eye, Layers, Settings, Pencil, Trash2, Copy, Plus, Car, Shirt, Link2, Palette, ChevronDown } from "lucide-react";
import AppLoader from "./components/AppLoader";
import HomePage from "./components/HomePage";
import App from "./App";
import VariantsPage from "./components/VariantsPage";
import Onboarding from "./components/Onboarding";
import SettingsMenu from "./components/SettingsMenu";
import WhatsNew from "./components/WhatsNew";
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
    const scale = prefs?.defaults?.uiScale ?? 1.0;
    document.documentElement.style.setProperty("--es-ui-scale", String(scale));
    
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

  return (
    <div className="shell-root">
      <AnimatePresence>{!booted ? <AppLoader /> : null}</AnimatePresence>

      {booted && <WhatsNew />}
      {whatsNewManual && <WhatsNew forceOpen isManual onClose={handleCloseWhatsNew} />}

      {booted && (
        <>
          {/* ━━━ ROW 1: Titlebar — Brand + Tab Strip + Window Controls ━━━ */}
          <div className="shell-row1" data-tauri-drag-region>
            <div className="shell-brand" data-tauri-drag-region>
              <span className="shell-brand-name">Cortex Studio</span>
            </div>

            <div className="shell-row1-divider" />

            {/* Tab strip */}
            <div className="shell-tabs" data-tauri-drag-region>
              <AnimatePresence initial={false}>
                {tabs.map((tab) => {
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

              {/* + New tab button */}
              <div className="shell-new-tab-wrap" ref={newTabBtnRef}>
                <button
                  type="button"
                  className="shell-new-tab-btn"
                  onClick={() => setNewTabOpen((p) => !p)}
                  data-tauri-drag-region="false"
                  title="New tab"
                >
                  <Plus className="w-3 h-3" />
                  <ChevronDown className="w-2 h-2 shell-new-tab-chevron" />
                </button>
                <AnimatePresence>
                  {newTabOpen && (
                    <motion.div
                      className="shell-new-tab-menu"
                      initial={{ opacity: 0, y: -4, scale: 0.96 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -4, scale: 0.96 }}
                      transition={{ duration: 0.12 }}
                    >
                      <button className="shell-new-tab-option" onClick={() => { handleNavigate("viewer", null, "livery"); setNewTabOpen(false); }}>
                        <Car className="w-3 h-3" /> Livery
                      </button>
                      <button className="shell-new-tab-option" onClick={() => { handleNavigate("viewer", null, "everything"); setNewTabOpen(false); }}>
                        <Layers className="w-3 h-3" /> All
                      </button>
                      <button className="shell-new-tab-option" onClick={() => { handleNavigate("viewer", null, "eup"); setNewTabOpen(false); }}>
                        <Shirt className="w-3 h-3" /> EUP
                      </button>
                      <button className="shell-new-tab-option" onClick={() => { handleNavigate("viewer", null, "multi"); setNewTabOpen(false); }}>
                        <Link2 className="w-3 h-3" /> Multi
                      </button>
                      <div className="shell-new-tab-sep" />
                      <button className="shell-new-tab-option" onClick={() => { handleNavigate("variants"); setNewTabOpen(false); }}>
                        <Palette className="w-3 h-3" /> Variant Builder
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>

            {/* Draggable spacer (right-click for new tab) */}
            <Ctx.Root>
              <Ctx.Trigger>
                <div className="shell-row1-spacer" data-tauri-drag-region />
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

            {/* Settings */}
            <SettingsMenu onSettingsSaved={handleSettingsSaved} onOpenReleaseNotes={handleOpenReleaseNotes} />

            {/* Window controls */}
            <div className="shell-window-controls">
              <button type="button" className="shell-wc-btn shell-wc-min" onClick={handleMinimize} aria-label="Minimize" data-tauri-drag-region="false">
                <Minus className="shell-wc-icon" />
              </button>
              <button type="button" className="shell-wc-btn shell-wc-max" onClick={handleMaximize} aria-label="Maximize" data-tauri-drag-region="false">
                <Square className="shell-wc-icon" />
              </button>
              <button type="button" className="shell-wc-btn shell-wc-close" onClick={handleClose} aria-label="Close" data-tauri-drag-region="false">
                <X className="shell-wc-icon" />
              </button>
            </div>
          </div>

          {/* ━━━ ROW 2: Context Bar — changes per active tab ━━━ */}
          <div
            className="shell-row2"
            ref={(node) => {
              contextBarRef.current = node;
              if (node && !contextBarReady) setContextBarReady(true);
            }}
          />

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
