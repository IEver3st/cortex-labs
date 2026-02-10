import { useCallback, useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Car, Layers, Shirt, Link2, Clock, Trash2, FolderOpen,
  Plus, ChevronRight, Palette, Eye, Check, ChevronLeft,
} from "lucide-react";
import { loadWorkspaces, loadRecent, deleteWorkspace, createWorkspace } from "../lib/workspace";
import { loadPrefs } from "../lib/prefs";
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

export default function HomePage({ onNavigate, onOpenWorkspace, settingsVersion }) {
  const [recent, setRecent] = useState([]);
  const [workspaces, setWorkspaces] = useState({});
  const [showNewProject, setShowNewProject] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [selectedMode, setSelectedMode] = useState("livery");
  const [showRecents, setShowRecents] = useState(true);

  useEffect(() => {
    const prefs = loadPrefs();
    const allowRecents = prefs?.defaults?.showRecents !== false;
    setShowRecents(allowRecents);
    setWorkspaces(loadWorkspaces());
    setRecent(allowRecents ? loadRecent() : []);
  }, [settingsVersion]);

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

      <div className="home-content-split">
        {/* Hero — centered at top */}
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
                              <div className="home-recent-item-icon" style={{ borderColor: `${color}30`, background: `${color}0a` }}>
                                <Icon className="w-3.5 h-3.5" style={{ color }} />
                              </div>
                              <div className="home-recent-item-text">
                                <span className="home-recent-item-name">{descriptiveNameForEntry(entry)}</span>
                                <span className="home-recent-item-meta">
                                  {modeLabel}
                                  {ws.updatedAt ? ` — ${relativeTime(ws.updatedAt)}` : ""}
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
      </div>

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
