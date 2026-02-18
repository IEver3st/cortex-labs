import { useCallback, useState, useEffect, useMemo, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Car, Layers, Shirt, Link2, Trash2, FolderOpen,
  Plus, Palette, ArrowRight,
  Search, ArrowUpDown, Pin, PinOff,
  ChevronDown, Rocket, FolderInput, Eye,
  Zap, Check, X, Command
} from "lucide-react";
import { loadWorkspaces, loadRecent, deleteWorkspace, createWorkspace } from "../lib/workspace";
import { loadPrefs, savePrefs } from "../lib/prefs";
import appMeta from "../../package.json";
import * as Ctx from "./ContextMenu";

const MODES = [
  {
    id: "livery",
    label: "Livery",
    desc: "Vehicle textures & livery painting",
    icon: Car,
    accent: "#7dd3fc",
    shortcut: "Alt+1",
    keyLabel: ["Alt", "1"],
  },
  {
    id: "everything",
    label: "All",
    desc: "View all meshes & textures",
    icon: Layers,
    accent: "#20c997",
    shortcut: "Alt+2",
    keyLabel: ["Alt", "2"],
  },
  {
    id: "eup",
    label: "EUP",
    desc: "Uniform & clothing textures",
    icon: Shirt,
    accent: "#c084fc",
    shortcut: "Alt+3",
    keyLabel: ["Alt", "3"],
  },
  {
    id: "multi",
    label: "Multi",
    desc: "Side-by-side model compare",
    icon: Link2,
    accent: "#fb923c",
    shortcut: "Alt+4",
    keyLabel: ["Alt", "4"],
  },
];

const FILTER_TABS = [
  { id: "all", label: "All" },
  { id: "livery", label: "Livery" },
  { id: "eup", label: "EUP" },
  { id: "multi", label: "Multi" },
  { id: "variants", label: "Variants" },
];

const SORT_OPTIONS = [
  { id: "recent", label: "Last Opened" },
  { id: "name", label: "Name" },
  { id: "type", label: "Type" },
];

const PINNED_KEY = "cortex-studio:pinned.v1";

function loadPinned() {
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function savePinned(ids) {
  try { localStorage.setItem(PINNED_KEY, JSON.stringify(ids)); } catch {}
}

function getModeTag(entry, ws) {
  if (entry.page === "variants") return "Variant";
  const mode = ws?.state?.textureMode || "livery";
  if (mode === "livery") return "Livery";
  if (mode === "everything") return "All";
  if (mode === "eup") return "EUP";
  if (mode === "multi") return "Multi";
  return "Livery";
}

function getModelName(ws) {
  const path = ws?.state?.modelPath || ws?.state?.openFile;
  if (!path) return null;
  return path.split(/[\\/]/).pop();
}

function getProjectFolder(ws) {
  const path = ws?.state?.modelPath || ws?.state?.openFile;
  if (!path) return null;
  const parts = path.split(/[\\/]/);
  if (parts.length > 1) return parts[parts.length - 2];
  return null;
}

function relativeTime(timestamp) {
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
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function timeGroup(timestamp) {
  if (!timestamp) return "older";
  const now = Date.now();
  const diff = now - timestamp;
  const hrs = diff / 3600000;
  if (hrs < 24) return "today";
  if (hrs < 168) return "week";
  return "older";
}

const GROUP_LABELS = {
  today: "Today",
  week: "This Week",
  older: "Older",
};

export default function HomePage({ onNavigate, onOpenWorkspace, settingsVersion }) {
  const [recent, setRecent] = useState([]);
  const [workspaces, setWorkspaces] = useState({});
  const [showNewProject, setShowNewProject] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [selectedMode, setSelectedMode] = useState("livery");
  const [activeSection, setActiveSection] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState("recent");
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [pinnedIds, setPinnedIds] = useState(() => loadPinned());
  const [createOpen, setCreateOpen] = useState(false);
  const searchRef = useRef(null);
  const createBtnRef = useRef(null);

  useEffect(() => {
    setWorkspaces(loadWorkspaces());
    setRecent(loadRecent());
  }, [settingsVersion]);

  // Close create dropdown on outside click
  useEffect(() => {
    if (!createOpen) return;
    const handleClick = (e) => {
      if (createBtnRef.current?.contains(e.target)) return;
      setCreateOpen(false);
    };
    window.addEventListener("mousedown", handleClick);
    return () => window.removeEventListener("mousedown", handleClick);
  }, [createOpen]);

  const togglePin = useCallback((wsId, e) => {
    if (e) e.stopPropagation();
    setPinnedIds(prev => {
      const next = prev.includes(wsId) ? prev.filter(id => id !== wsId) : [...prev, wsId].slice(-5);
      savePinned(next);
      return next;
    });
  }, []);

  const filteredRecent = useMemo(() => {
    let list = recent;
    // Filter by type
    if (activeSection !== "all") {
      list = list.filter(entry => {
        const ws = workspaces[entry.workspaceId];
        if (!ws) return false;
        if (activeSection === "variants") return entry.page === "variants";
        return ws.state?.textureMode === activeSection;
      });
    }
    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(entry => {
        const ws = workspaces[entry.workspaceId];
        if (!ws) return false;
        const name = (ws.name || "").toLowerCase();
        const model = (getModelName(ws) || "").toLowerCase();
        const folder = (getProjectFolder(ws) || "").toLowerCase();
        return name.includes(q) || model.includes(q) || folder.includes(q);
      });
    }
    // Sort
    if (sortBy === "name") {
      list = [...list].sort((a, b) => {
        const na = (workspaces[a.workspaceId]?.name || "").toLowerCase();
        const nb = (workspaces[b.workspaceId]?.name || "").toLowerCase();
        return na.localeCompare(nb);
      });
    } else if (sortBy === "type") {
      list = [...list].sort((a, b) => {
        const wa = workspaces[a.workspaceId];
        const wb = workspaces[b.workspaceId];
        return getModeTag(a, wa).localeCompare(getModeTag(b, wb));
      });
    }
    return list;
  }, [recent, workspaces, activeSection, searchQuery, sortBy]);

  // Group projects by time
  const groupedRecent = useMemo(() => {
    if (sortBy !== "recent") return null;
    const groups = { today: [], week: [], older: [] };
    filteredRecent.forEach(entry => {
      const ws = workspaces[entry.workspaceId];
      const g = timeGroup(ws?.updatedAt || entry.openedAt);
      groups[g].push(entry);
    });
    return groups;
  }, [filteredRecent, workspaces, sortBy]);

  const pinnedEntries = useMemo(() => {
    return recent.filter(entry => pinnedIds.includes(entry.workspaceId));
  }, [recent, pinnedIds]);

  const hasProjects = recent.length > 0;

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
    setPinnedIds(prev => prev.filter(id => id !== wsId));
  }, []);

  const handleOpenRecent = useCallback((entry) => {
    const ws = loadWorkspaces()[entry.workspaceId];
    if (ws) onOpenWorkspace(ws);
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
    const modeConfig = MODES.find(m => m.id === mode);
    return modeConfig?.accent || "#7dd3fc";
  };

  /* ─── Project row renderer ─── */
  const renderProjectRow = (entry, i, opts = {}) => {
    const ws = workspaces[entry.workspaceId];
    if (!ws) return null;
    const Icon = modeIconForEntry(entry);
    const color = modeColorForEntry(entry);
    const isPinned = pinnedIds.includes(entry.workspaceId);
    const tag = getModeTag(entry, ws);
    const model = getModelName(ws);
    const folder = getProjectFolder(ws);

    return (
      <Ctx.Root key={entry.workspaceId}>
        <Ctx.Trigger>
          <motion.div
            className={`hp-project-row ${opts.pinned ? "is-pinned" : ""}`}
            onClick={() => handleOpenRecent(entry)}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: opts.delay || 0 }}
            style={{ "--project-accent": color }}
          >
            <div className="hp-project-indicator" />
            <div className="hp-project-icon">
              <Icon className="w-4 h-4" />
            </div>
            <div className="hp-project-details">
              <div className="hp-project-name-row">
                <span className="hp-project-name">{ws.name}</span>
                <span className="hp-project-tag" data-tag={tag.toLowerCase()}>{tag}</span>
              </div>
              <div className="hp-project-meta">
                {model && <span className="hp-project-model" title={model}>{model}</span>}
                {folder && <><span className="hp-meta-sep">/</span><span className="hp-project-folder">{folder}</span></>}
                <span className="hp-meta-sep">·</span>
                <span className="hp-project-time">{relativeTime(ws.updatedAt)}</span>
              </div>
            </div>
            <div className="hp-project-actions">
              <button
                className={`hp-pin-btn ${isPinned ? "is-pinned" : ""}`}
                onClick={(e) => togglePin(entry.workspaceId, e)}
                title={isPinned ? "Unpin" : "Pin"}
              >
                {isPinned ? <PinOff className="w-3 h-3" /> : <Pin className="w-3 h-3" />}
              </button>
              <button
                className="hp-delete-btn"
                onClick={(e) => handleDeleteWorkspace(e, entry.workspaceId)}
                title="Delete"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          </motion.div>
        </Ctx.Trigger>
        <Ctx.Content>
          <Ctx.Item onSelect={() => handleOpenRecent(entry)}>
            <FolderOpen className="w-3.5 h-3.5" /> Open
          </Ctx.Item>
          <Ctx.Item onSelect={(e) => togglePin(entry.workspaceId)}>
            {isPinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
            {isPinned ? "Unpin" : "Pin to top"}
          </Ctx.Item>
          <Ctx.Separator />
          <Ctx.Item onSelect={(e) => handleDeleteWorkspace(e, entry.workspaceId)} destructive>
            <Trash2 className="w-3.5 h-3.5" /> Delete
          </Ctx.Item>
        </Ctx.Content>
      </Ctx.Root>
    );
  };

  /* ─── Grouped list renderer ─── */
  const renderGroupedList = () => {
    if (!groupedRecent) {
      // Flat list (sorted by name or type)
      return filteredRecent.map((entry, i) => renderProjectRow(entry, i, { delay: 0.05 + i * 0.02 }));
    }
    const elements = [];
    let idx = 0;
    for (const key of ["today", "week", "older"]) {
      const items = groupedRecent[key];
      if (items.length === 0) continue;
      elements.push(
        <div key={`group-${key}`} className="hp-time-group">
          <span className="hp-time-label">{GROUP_LABELS[key]}</span>
        </div>
      );
      items.forEach((entry) => {
        elements.push(renderProjectRow(entry, idx, { delay: 0.05 + idx * 0.02 }));
        idx++;
      });
    }
    return elements;
  };

  return (
    <div className="home-page">
      <div className="hp-bg">
        <div className="hp-bg-dots" />
        <div className="hp-bg-glow" />
      </div>

      <div className="hp-container">
        {/* ─── Compact Header ─── */}
        <motion.header
          className="hp-header"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          <div className="hp-brand">
            <span className="hp-brand-mark">Cortex Studio</span>
            <span className="hp-brand-ver">v{appMeta.version}</span>
          </div>
          <div className="hp-header-cta" ref={createBtnRef}>
            <button className="hp-create-btn" onClick={() => setCreateOpen((p) => !p)}>
              <Plus className="w-3.5 h-3.5" />
              <span>Create</span>
              <ChevronDown className="w-3 h-3" />
            </button>
            <AnimatePresence>
              {createOpen && (
                <motion.div
                  className="hp-create-menu"
                  initial={{ opacity: 0, y: -4, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -4, scale: 0.96 }}
                  transition={{ duration: 0.12 }}
                >
                  <button className="hp-create-option" onClick={() => { handleLaunchMode("livery"); setCreateOpen(false); }}>
                    <Car className="w-3.5 h-3.5" style={{ color: "#7dd3fc" }} /> <span>New Livery</span>
                  </button>
                  <button className="hp-create-option" onClick={() => { handleLaunchMode("everything"); setCreateOpen(false); }}>
                    <Layers className="w-3.5 h-3.5" style={{ color: "#20c997" }} /> <span>New All</span>
                  </button>
                  <button className="hp-create-option" onClick={() => { handleLaunchMode("eup"); setCreateOpen(false); }}>
                    <Shirt className="w-3.5 h-3.5" style={{ color: "#c084fc" }} /> <span>New EUP</span>
                  </button>
                  <button className="hp-create-option" onClick={() => { handleLaunchMode("multi"); setCreateOpen(false); }}>
                    <Link2 className="w-3.5 h-3.5" style={{ color: "#fb923c" }} /> <span>New Multi</span>
                  </button>
                  <div className="hp-create-sep" />
                  <button className="hp-create-option" onClick={() => { handleLaunchVariants(); setCreateOpen(false); }}>
                    <Palette className="w-3.5 h-3.5" style={{ color: "#f0abfc" }} /> <span>Variant Builder</span>
                  </button>
                  <div className="hp-create-sep" />
                  <button className="hp-create-option" onClick={() => { setShowNewProject(true); setCreateOpen(false); }}>
                    <Plus className="w-3.5 h-3.5" /> <span>New Project…</span>
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.header>

        {/* ─── Main Grid ─── */}
        <div className="hp-grid">
          {/* ──── Left: Quick Start ──── */}
          <motion.section
            className="hp-left"
            initial={{ opacity: 0, x: -16 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.45, delay: 0.08 }}
          >
            <div className="hp-section-label">
              <Zap className="w-3.5 h-3.5" />
              <span>Quick Start</span>
            </div>

            <div className="hp-mode-cards">
              {MODES.map((mode, i) => {
                const Icon = mode.icon;
                return (
                  <motion.button
                    key={mode.id}
                    className="hp-mode-card"
                    onClick={() => handleLaunchMode(mode.id)}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3, delay: 0.12 + i * 0.045 }}
                    style={{ "--mode-accent": mode.accent }}
                  >
                    <div className="hp-mode-bar" />
                    <div className="hp-mode-body">
                      <div className="hp-mode-icon-wrap">
                        <Icon className="w-5 h-5" />
                      </div>
                      <div className="hp-mode-text">
                        <span className="hp-mode-label">{mode.label}</span>
                        <span className="hp-mode-desc">{mode.desc}</span>
                      </div>
                    </div>
                    <div className="hp-mode-footer">
                      <div className="hp-keycaps">
                        {mode.keyLabel.map((k, ki) => (
                          <span key={ki} className="hp-keycap">{k}</span>
                        ))}
                      </div>
                      <ArrowRight className="w-3.5 h-3.5 hp-mode-arrow" />
                    </div>
                  </motion.button>
                );
              })}
            </div>

            <div className="hp-separator" />

            <motion.button
              className="hp-variant-card"
              onClick={handleLaunchVariants}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: 0.35 }}
            >
              <div className="hp-variant-icon">
                <Palette className="w-4 h-4" />
              </div>
              <div className="hp-variant-text">
                <span className="hp-variant-label">Variant Builder</span>
                <span className="hp-variant-desc">PSD workflow with grouped exports</span>
              </div>
              <ArrowRight className="w-4 h-4 hp-variant-arrow" />
            </motion.button>
          </motion.section>

          {/* ──── Right: Projects (hero) ──── */}
          <motion.section
            className="hp-right"
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.45, delay: 0.15 }}
          >
            {/* Section title with search and sort */}
            <div className="hp-projects-head">
              <h2 className="hp-projects-title">
                Recent Projects
                <span className="hp-projects-count">{filteredRecent.length}</span>
              </h2>
              <div className="hp-projects-controls">
                <div className="hp-search">
                  <Search className="w-3.5 h-3.5 hp-search-icon" />
                  <input
                    ref={searchRef}
                    type="text"
                    className="hp-search-input"
                    placeholder="Search…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                  {searchQuery && (
                    <button className="hp-search-clear" onClick={() => setSearchQuery("")}>
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
                <div className="hp-sort-wrap">
                  <button className="hp-sort-btn" onClick={() => setShowSortMenu(!showSortMenu)}>
                    <ArrowUpDown className="w-3 h-3" />
                    <span>{SORT_OPTIONS.find(s => s.id === sortBy)?.label}</span>
                  </button>
                  <AnimatePresence>
                    {showSortMenu && (
                      <motion.div
                        className="hp-sort-menu"
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.15 }}
                      >
                        {SORT_OPTIONS.map(opt => (
                          <button
                            key={opt.id}
                            className={`hp-sort-option ${sortBy === opt.id ? "is-active" : ""}`}
                            onClick={() => { setSortBy(opt.id); setShowSortMenu(false); }}
                          >
                            {sortBy === opt.id && <Check className="w-3 h-3" />}
                            {opt.label}
                          </button>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </div>

            {/* Filter Tabs */}
            <div className="hp-filters">
              {FILTER_TABS.map(filter => {
                const count = filter.id === "all" ? recent.length : recent.filter(entry => {
                  const ws = workspaces[entry.workspaceId];
                  if (!ws) return false;
                  if (filter.id === "variants") return entry.page === "variants";
                  return ws.state?.textureMode === filter.id;
                }).length;
                return (
                  <button
                    key={filter.id}
                    className={`hp-filter ${activeSection === filter.id ? "is-active" : ""}`}
                    onClick={() => setActiveSection(filter.id)}
                  >
                    {filter.label}
                    {count > 0 && <span className="hp-filter-num">{count}</span>}
                  </button>
                );
              })}
            </div>

            {/* ── Pinned Section ── */}
            {pinnedEntries.length > 0 && activeSection === "all" && !searchQuery && (
              <div className="hp-pinned-section">
                <div className="hp-pinned-label">
                  <Pin className="w-3 h-3" />
                  <span>Pinned</span>
                </div>
                <div className="hp-pinned-list">
                  {pinnedEntries.map((entry, i) => renderProjectRow(entry, i, { delay: 0, pinned: true }))}
                </div>
              </div>
            )}

            {/* ── Projects List ── */}
            <div className="hp-projects-scroll">
              {hasProjects && filteredRecent.length > 0 ? (
                renderGroupedList()
              ) : hasProjects ? (
                <motion.div className="hp-no-results" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                  <Search className="w-6 h-6" />
                  <p>No matches</p>
                  <span>Try a different search or filter</span>
                </motion.div>
              ) : (
                /* ── Empty State: First-time user onboarding ── */
                <motion.div
                  className="hp-empty-state"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2, duration: 0.4 }}
                >
                  <div className="hp-empty-hero">
                    <div className="hp-empty-icon-ring">
                      <Rocket className="w-6 h-6" />
                    </div>
                    <h3 className="hp-empty-title">Get Started</h3>
                    <p className="hp-empty-subtitle">Open a model or create your first project</p>
                  </div>

                  <div className="hp-empty-actions">
                    <button className="hp-empty-action" onClick={() => handleLaunchMode("livery")}>
                      <Car className="w-4 h-4" />
                      <span>Open Model</span>
                    </button>
                    <button className="hp-empty-action" onClick={() => setShowNewProject(true)}>
                      <Plus className="w-4 h-4" />
                      <span>Create Project</span>
                    </button>
                    <button className="hp-empty-action" onClick={() => handleLaunchMode("everything")}>
                      <FolderInput className="w-4 h-4" />
                      <span>Import Folder</span>
                    </button>
                  </div>

                  <div className="hp-empty-checklist">
                    <span className="hp-checklist-header">Getting Started</span>
                    <div className="hp-checklist-items">
                      <div className="hp-checklist-item">
                        <span className="hp-checklist-num">1</span>
                        <span>Open a <b>.yft</b> or <b>.ydd</b> model file</span>
                      </div>
                      <div className="hp-checklist-item">
                        <span className="hp-checklist-num">2</span>
                        <span>Apply a livery or texture overlay</span>
                      </div>
                      <div className="hp-checklist-item">
                        <span className="hp-checklist-num">3</span>
                        <span>Enable file watching for live reload</span>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </div>
          </motion.section>
        </div>

        {/* ─── Footer ─── */}
        <motion.footer
          className="hp-footer"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.35 }}
        >
          <div className="hp-stats">
            <span>{Object.keys(workspaces).length} projects</span>
            <span className="hp-stats-sep" />
            <span>{recent.length} recent</span>
          </div>
          <div className="hp-footer-hint">
            <Command className="w-3 h-3" />
            <span>Use keyboard shortcuts for faster workflow</span>
          </div>
        </motion.footer>
      </div>

      {/* ─── New Project Modal ─── */}
      <AnimatePresence>
        {showNewProject && (
          <motion.div
            className="home-modal-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowNewProject(false)}
          >
            <motion.div
              className="home-modal"
              initial={{ opacity: 0, y: 20, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.96 }}
              transition={{ duration: 0.22 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="home-modal-header">
                <h3>New Project</h3>
                <button className="home-modal-close" onClick={() => setShowNewProject(false)}>
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="home-modal-body">
                <div className="home-field">
                  <label>Project Name</label>
                  <input
                    type="text"
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    placeholder="Enter project name..."
                    autoFocus
                    onKeyDown={(e) => e.key === "Enter" && handleCreateProject()}
                  />
                </div>
                <div className="home-field">
                  <label>Mode</label>
                  <div className="home-mode-select">
                    {MODES.map((mode) => (
                      <button
                        key={mode.id}
                        className={`home-mode-option ${selectedMode === mode.id ? "is-selected" : ""}`}
                        style={{ "--mode-accent": mode.accent }}
                        onClick={() => setSelectedMode(mode.id)}
                      >
                        <mode.icon className="w-4 h-4" />
                        <span>{mode.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="home-modal-footer">
                <button className="home-btn home-btn-secondary" onClick={() => setShowNewProject(false)}>Cancel</button>
                <button className="home-btn home-btn-primary" onClick={handleCreateProject}>Create Project</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
