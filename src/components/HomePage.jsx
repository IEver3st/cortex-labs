import { useCallback, useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Car, Layers, Shirt, Link2, Clock, Trash2, FolderOpen,
  Plus, ChevronRight, Palette, Eye, Check, ChevronLeft,
} from "lucide-react";
import { loadWorkspaces, loadRecent, deleteWorkspace, createWorkspace } from "../lib/workspace";
import { loadPrefs } from "../lib/prefs";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import appMeta from "../../package.json";
import * as Ctx from "./ContextMenu";

const MODES = [
  {
    id: "livery",
    label: "Livery",
    desc: "Auto-target vehicle livery materials",
    icon: Car,
    accent: "#7dd3fc",
    shortcut: "Alt + 1",
  },
  {
    id: "everything",
    label: "All",
    desc: "Apply textures to all meshes",
    icon: Layers,
    accent: "#20c997",
    shortcut: "Alt + 2",
  },
  {
    id: "eup",
    label: "EUP",
    desc: "Emergency uniform textures + YDD",
    icon: Shirt,
    accent: "#c084fc",
    shortcut: "Alt + 3",
  },
  {
    id: "multi",
    label: "Multi",
    desc: "Dual model side-by-side viewer",
    icon: Link2,
    accent: "#fb923c",
    shortcut: "Alt + 4",
  },
];

const ONBOARD_MODE_OPTIONS = [
  { id: "livery", label: "Livery", desc: "Auto-targets vehicle carpaint materials", icon: Car, color: "#7dd3fc" },
  { id: "everything", label: "All Textures", desc: "Applies texture to every mesh", icon: Layers, color: "#20c997" },
  { id: "eup", label: "EUP", desc: "Emergency uniform & clothing textures", icon: Shirt, color: "#c084fc" },
];

const DEFAULT_BODY = "#e7ebf0";
const DEFAULT_BG = "#141414";

/* ─── Onboarding Setup Flow (inline in home page) ─── */
function OnboardingFlow({ onComplete }) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState({
    textureMode: "livery",
    liveryExteriorOnly: false,
    windowTemplateEnabled: false,
    windowTextureTarget: "auto",
    cameraWASD: false,
    bodyColor: DEFAULT_BODY,
    backgroundColor: DEFAULT_BG,
    experimentalSettings: false,
    showHints: true,
    showRecents: true,
    hideRotText: false,
    showGrid: false,
    lightIntensity: 1.0,
    glossiness: 0.5,
    windowControlsStyle: "windows",
    toolbarInTitlebar: false,
    uiScale: 1.0,
    previewFolder: "",
  });

  const isTauriRuntime =
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__ !== "undefined";

  const handleSelectPreviewFolder = useCallback(async () => {
    if (!isTauriRuntime) return;
    try {
      const selected = await openDialog({ directory: true, title: "Select Preview Export Folder" });
      if (typeof selected === "string") {
        setDraft((p) => ({ ...p, previewFolder: selected }));
      }
    } catch {}
  }, [isTauriRuntime]);

  const ease = [0.22, 1, 0.36, 1];
  const finish = useCallback(() => onComplete?.(draft), [draft, onComplete]);

  return (
    <motion.div
      className="home-content-split"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5, ease }}
    >
      {/* Header area */}
      <motion.div
        className="home-hero"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, ease }}
      >
        <h1 className="home-title">Cortex Studio</h1>
        <motion.span
          className="home-version"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
        >
          v{appMeta.version}
        </motion.span>
      </motion.div>

      {/* Setup body — single centered column */}
      <div className="home-body is-single">
        <div className="home-setup-column">
          <AnimatePresence mode="wait" initial={false}>
            {/* ── Step 0: Default mode ── */}
            {step === 0 && (
              <motion.div
                key="setup-mode"
                className="home-setup-step"
                initial={{ opacity: 0, x: 40 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -40 }}
                transition={{ duration: 0.3, ease }}
              >
                <div className="home-setup-step-head">
                  <div className="home-setup-step-tag">Step 1 of 2</div>
                  <div className="home-setup-step-title">Default texture mode</div>
                  <div className="home-setup-step-hint">
                    Choose how textures are applied when you open a model. You can always change this per-session.
                  </div>
                </div>

                <div className="home-setup-modes">
                  {ONBOARD_MODE_OPTIONS.map((opt, idx) => {
                    const Icon = opt.icon;
                    const isActive = draft.textureMode === opt.id;
                    return (
                      <motion.button
                        key={opt.id}
                        type="button"
                        className={`home-setup-mode ${isActive ? "is-active" : ""}`}
                        style={{ "--setup-accent": opt.color }}
                        onClick={() => setDraft((p) => ({ ...p, textureMode: opt.id }))}
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.35, delay: 0.08 + idx * 0.06, ease }}
                        whileHover={{ y: -2 }}
                        whileTap={{ scale: 0.97 }}
                      >
                        <div className="home-setup-mode-icon">
                          <Icon />
                        </div>
                        <div className="home-setup-mode-text">
                          <span className="home-setup-mode-label">{opt.label}</span>
                          <span className="home-setup-mode-desc">{opt.desc}</span>
                        </div>
                        {isActive && (
                          <motion.div
                            className="home-setup-mode-check"
                            initial={{ scale: 0 }}
                            animate={{ scale: 1 }}
                            transition={{ type: "spring", stiffness: 500, damping: 25 }}
                          >
                            <Check className="w-3 h-3" />
                          </motion.div>
                        )}
                      </motion.button>
                    );
                  })}
                </div>

                <div className="home-setup-toggles">
                  <div className="home-setup-toggle-row">
                    <div className="home-setup-toggle-info">
                      <span className="home-setup-toggle-label">Exterior Only</span>
                      <span className="home-setup-toggle-hint">Hide interior meshes in livery mode</span>
                    </div>
                    <button
                      type="button"
                      className={`home-setup-switch ${draft.liveryExteriorOnly ? "is-on" : ""}`}
                      onClick={() => setDraft((p) => ({ ...p, liveryExteriorOnly: !p.liveryExteriorOnly }))}
                    >
                      <motion.div
                        className="home-setup-switch-thumb"
                        animate={{ x: draft.liveryExteriorOnly ? 16 : 0 }}
                        transition={{ type: "spring", stiffness: 500, damping: 30 }}
                      />
                    </button>
                  </div>

                  <div className="home-setup-toggle-row">
                    <div className="home-setup-toggle-info">
                      <span className="home-setup-toggle-label">Show Hints</span>
                      <span className="home-setup-toggle-hint">Display mouse control hints in the viewer</span>
                    </div>
                    <button
                      type="button"
                      className={`home-setup-switch ${draft.showHints ? "is-on" : ""}`}
                      onClick={() => setDraft((p) => ({ ...p, showHints: !p.showHints }))}
                    >
                      <motion.div
                        className="home-setup-switch-thumb"
                        animate={{ x: draft.showHints ? 16 : 0 }}
                        transition={{ type: "spring", stiffness: 500, damping: 30 }}
                      />
                    </button>
                  </div>
                </div>

                <div className="home-setup-nav">
                  <div />
                  <motion.button
                    type="button"
                    className="home-setup-next"
                    onClick={() => setStep(1)}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.97 }}
                  >
                    <span>Next</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </motion.button>
                </div>
              </motion.div>
            )}

            {/* ── Step 1: Export & Finish ── */}
            {step === 1 && (
              <motion.div
                key="setup-export"
                className="home-setup-step"
                initial={{ opacity: 0, x: 40 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -40 }}
                transition={{ duration: 0.3, ease }}
              >
                <div className="home-setup-step-head">
                  <div className="home-setup-step-tag">Step 2 of 2</div>
                  <div className="home-setup-step-title">Export folder</div>
                  <div className="home-setup-step-hint">
                    Choose where generated preview screenshots will be saved. You can skip this and set it later in Settings.
                  </div>
                </div>

                <motion.button
                  type="button"
                  className="home-setup-folder-btn"
                  onClick={handleSelectPreviewFolder}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1, duration: 0.3, ease }}
                  whileHover={{ y: -1 }}
                  whileTap={{ scale: 0.98 }}
                >
                  <FolderOpen className="w-5 h-5" style={{ opacity: 0.4 }} />
                  <div className="home-setup-folder-text">
                    <span className="home-setup-folder-label">
                      {draft.previewFolder
                        ? draft.previewFolder.split(/[\\/]/).pop()
                        : "Select export folder..."}
                    </span>
                    {draft.previewFolder && (
                      <span className="home-setup-folder-path">{draft.previewFolder}</span>
                    )}
                  </div>
                </motion.button>

                {!draft.previewFolder && (
                  <motion.div
                    className="home-setup-skip-note"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.2 }}
                  >
                    You'll be prompted when you first generate a preview.
                  </motion.div>
                )}

                <div className="home-setup-nav">
                  <button
                    type="button"
                    className="home-setup-back"
                    onClick={() => setStep(0)}
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    <span>Back</span>
                  </button>
                  <motion.button
                    type="button"
                    className="home-setup-finish"
                    onClick={finish}
                    whileHover={{ scale: 1.03 }}
                    whileTap={{ scale: 0.97 }}
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>Start Building</span>
                  </motion.button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}

/* ─── Main HomePage ─── */
export default function HomePage({ onNavigate, onOpenWorkspace, settingsVersion, isOnboarding, isActive = true, onOnboardingComplete }) {
  const [recent, setRecent] = useState([]);
  const [workspaces, setWorkspaces] = useState({});
  const [showNewProject, setShowNewProject] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [selectedMode, setSelectedMode] = useState("livery");
  const [showRecents, setShowRecents] = useState(() => {
    const prefs = loadPrefs();
    return prefs?.defaults?.showRecents !== false;
  });

  useEffect(() => {
    if (isOnboarding || !isActive) return;
    const prefs = loadPrefs();
    const allowRecents = prefs?.defaults?.showRecents !== false;
    setShowRecents(allowRecents);
    setWorkspaces(loadWorkspaces());
    setRecent(allowRecents ? loadRecent() : []);
  }, [settingsVersion, isOnboarding, isActive]);

  const handleLaunchMode = useCallback((mode) => {
    const modeNames = {
      livery: "Livery",
      everything: "All Textures",
      eup: "EUP",
      multi: "Multi-Model",
    };
    const id = createWorkspace(modeNames[mode] || "New Session", "viewer", { textureMode: mode });
    onNavigate("viewer", id, mode);
  }, [onNavigate]);

  const handleLaunchVariants = useCallback(() => {
    const id = createWorkspace("Variant Build", "variants");
    onNavigate("variants", id);
  }, [onNavigate]);

  const handleCreateProject = useCallback(() => {
    const name = projectName.trim() || "Untitled Project";
    const id = createWorkspace(name, "viewer", { textureMode: selectedMode });
    onNavigate("viewer", id, selectedMode);
    setShowNewProject(false);
    setProjectName("");
  }, [projectName, selectedMode, onNavigate]);

  const handleDeleteWorkspace = useCallback((e, wsId) => {
    e.stopPropagation();
    deleteWorkspace(wsId);
    setWorkspaces(loadWorkspaces());
    setRecent(loadRecent());
  }, []);

  const handleOpenRecent = useCallback((entry) => {
    const ws = loadWorkspaces()[entry.workspaceId];
    if (ws) {
      onOpenWorkspace(ws);
    }
  }, [onOpenWorkspace]);

  const modeIconForEntry = (entry) => {
    const ws = workspaces[entry.workspaceId];
    const mode = ws?.state?.textureMode || "livery";
    if (entry.page === "variants") return Palette;
    if (mode === "everything") return Layers;
    if (mode === "eup") return Shirt;
    if (mode === "multi") return Link2;
    return Car;
  };

  const modeColorForEntry = (entry) => {
    const ws = workspaces[entry.workspaceId];
    const mode = ws?.state?.textureMode || "livery";
    if (entry.page === "variants") return "#f0abfc";
    if (mode === "everything") return "#20c997";
    if (mode === "eup") return "#c084fc";
    if (mode === "multi") return "#fb923c";
    return "#7dd3fc";
  };

  const modeLabelForEntry = (entry) => {
    const ws = workspaces[entry.workspaceId];
    const mode = ws?.state?.textureMode || "livery";
    if (entry.page === "variants") return "Variant Builder";
    if (mode === "everything") return "All";
    if (mode === "eup") return "EUP";
    if (mode === "multi") return "Multi";
    return "Livery";
  };

  const descriptiveNameForEntry = (entry) => {
    const ws = workspaces[entry.workspaceId];
    if (!ws) return entry.name || "Untitled";
    const state = ws.state || {};
    if (entry.page === "variants") {
      const psd = state.psdPath;
      if (psd) {
        const name = psd.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "";
        return name ? `${name} Variants` : ws.name;
      }
      return ws.name;
    }
    const modelPath = state.modelPath || "";
    if (modelPath) {
      const modelName = modelPath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "";
      if (modelName) return `${modelName} Preview`;
    }
    return ws.name;
  };

  const relativeTime = (timestamp) => {
    if (!timestamp) return "";
    const now = Date.now();
    const diff = now - timestamp;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(timestamp).toLocaleDateString();
  };

  return (
    <div className="home-page">
      {/* Atmospheric background */}
      <div className="home-bg">
        <div className="home-bg-grain" />
        <div className="home-bg-gradient" />
        <div className="home-bg-grid" />
      </div>

      <AnimatePresence mode="wait">
        {isOnboarding ? (
          <OnboardingFlow key="onboarding" onComplete={onOnboardingComplete} />
        ) : (
          <motion.div
            key="home"
            className="home-content-split"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          >
            {/* Hero */}
            <motion.div
              className="home-hero"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
            >
              <h1 className="home-title">Cortex Studio</h1>
              <span className="home-version">v{appMeta.version}</span>
            </motion.div>

            {/* Body: two columns with divider */}
            <div className={`home-body ${showRecents ? "" : "is-single"}`}>
              {/* Left — Launch options */}
              <motion.div
                className="home-left"
                initial={{ opacity: 0, x: -16 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.6, delay: 0.12, ease: [0.22, 1, 0.36, 1] }}
              >
                <div className="home-section-label">
                  <span>Launch</span>
                </div>

                <div className="home-mode-grid">
                  {MODES.map((mode, idx) => {
                    const Icon = mode.icon;
                    return (
                      <motion.button
                        key={mode.id}
                        type="button"
                        className="home-mode-card"
                        style={{ "--mode-accent": mode.accent }}
                        onClick={() => handleLaunchMode(mode.id)}
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.45, delay: 0.18 + idx * 0.06, ease: [0.22, 1, 0.36, 1] }}
                        whileHover={{ y: -2, scale: 1.015 }}
                        whileTap={{ scale: 0.98 }}
                      >
                        <div className="home-mode-card-top">
                          <div className="home-mode-card-icon">
                            <Icon />
                          </div>
                          <span className="home-mode-card-shortcut">{mode.shortcut}</span>
                        </div>
                        <div className="home-mode-card-label">{mode.label}</div>
                        <div className="home-mode-card-desc">{mode.desc}</div>
                      </motion.button>
                    );
                  })}
                </div>

                {/* Variant Builder */}
                <motion.button
                  type="button"
                  className="home-variant-card"
                  onClick={handleLaunchVariants}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.45, delay: 0.42, ease: [0.22, 1, 0.36, 1] }}
                  whileHover={{ x: 3 }}
                  whileTap={{ scale: 0.98 }}
                >
                  <div className="home-variant-card-icon">
                    <Palette />
                  </div>
                  <div className="home-variant-card-text">
                    <span className="home-variant-card-label">Variant Builder</span>
                    <span className="home-variant-card-desc">Import PSD files, configure layer variants, batch export</span>
                  </div>
                  <ChevronRight className="home-variant-card-arrow" />
                </motion.button>

                {/* Named Project */}
                <motion.button
                  type="button"
                  className="home-named-project-btn"
                  onClick={() => setShowNewProject(true)}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.5 }}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                >
                  <FolderOpen className="w-4 h-4" />
                  <span>New Named Project...</span>
                </motion.button>
              </motion.div>

              {showRecents && (
                <>
                  {/* Vertical Divider */}
                  <div className="home-divider" />

                  {/* Right — Recents */}
                  <motion.div
                    className="home-right"
                    initial={{ opacity: 0, x: 16 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.6, delay: 0.18, ease: [0.22, 1, 0.36, 1] }}
                  >
                    <div className="home-section-label">
                      <Clock className="home-section-label-icon" />
                      <span>Recent</span>
                    </div>

                    {recent.length > 0 ? (
                      <div className="home-recent-list">
                        {recent.map((entry, i) => {
                          const ws = workspaces[entry.workspaceId];
                          if (!ws) return null;
                          const Icon = modeIconForEntry(entry);
                          const color = modeColorForEntry(entry);
                          const modeLabel = modeLabelForEntry(entry);
                          return (
                            <Ctx.Root key={entry.workspaceId}>
                              <Ctx.Trigger>
                                <motion.div
                                  className="home-recent-item"
                                  onClick={() => handleOpenRecent(entry)}
                                  initial={{ opacity: 0, x: -6 }}
                                  animate={{ opacity: 1, x: 0 }}
                                  transition={{ duration: 0.3, delay: 0.24 + i * 0.04 }}
                                  whileHover={{ x: 3 }}
                                  role="button"
                                  tabIndex={0}
                                >
                                  <div className="home-recent-item-icon">
                                    <Icon className="w-3.5 h-3.5" style={{ color }} />
                                  </div>
                                  <div className="home-recent-item-text">
                                    <span className="home-recent-item-name">{descriptiveNameForEntry(entry)}</span>
                                    <span className="home-recent-item-meta">
                                      {modeLabel}
                                      {ws.updatedAt ? ` \u2014 ${relativeTime(ws.updatedAt)}` : ""}
                                    </span>
                                  </div>
                                  <button
                                    type="button"
                                    className="home-recent-item-delete"
                                    onClick={(e) => handleDeleteWorkspace(e, entry.workspaceId)}
                                    title="Delete"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                  </button>
                                </motion.div>
                              </Ctx.Trigger>
                              <Ctx.Content>
                                <Ctx.Item onSelect={() => handleOpenRecent(entry)}>
                                  <ChevronRight className="w-3 h-3" /> Open
                                </Ctx.Item>
                                <Ctx.Separator />
                                <Ctx.Item onSelect={(e) => handleDeleteWorkspace(e, entry.workspaceId)} destructive>
                                  <Trash2 className="w-3 h-3" /> Delete
                                </Ctx.Item>
                              </Ctx.Content>
                            </Ctx.Root>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="home-empty-recent">
                        <Clock className="home-empty-recent-icon" />
                        <span>No recent sessions</span>
                        <span className="home-empty-recent-hint">Launch a mode to get started</span>
                      </div>
                    )}
                  </motion.div>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* New Project Form */}
      <AnimatePresence>
        {showNewProject && (
          <motion.div
            className="home-new-project-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowNewProject(false)}
          >
            <motion.div
              className="home-new-project"
              initial={{ opacity: 0, y: 20, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.96 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="home-new-project-title">New Project</h2>
              <div className="home-new-project-field">
                <label className="home-new-project-label">Project Name</label>
                <input
                  type="text"
                  className="home-new-project-input"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="My Livery"
                  autoFocus
                  onKeyDown={(e) => e.key === "Enter" && handleCreateProject()}
                />
              </div>
              <div className="home-new-project-field">
                <label className="home-new-project-label">Mode</label>
                <div className="home-new-project-types">
                  {MODES.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className={`home-new-project-type ${selectedMode === m.id ? "is-selected" : ""}`}
                      style={{ "--type-accent": m.accent }}
                      onClick={() => setSelectedMode(m.id)}
                    >
                      <m.icon className="w-4 h-4" />
                      <span>{m.label}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="home-new-project-actions">
                <button type="button" className="home-new-project-cancel" onClick={() => setShowNewProject(false)}>
                  Cancel
                </button>
                <button type="button" className="home-new-project-create" onClick={handleCreateProject}>
                  <Plus className="w-3.5 h-3.5" />
                  Create
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
