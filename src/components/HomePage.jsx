import { useCallback, useState, useEffect, useMemo, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Car,
  Shirt,
  Link2,
  Trash2,
  FolderOpen,
  Plus,
  Palette,
  Search,
  ArrowUpDown,
  Pin,
  PinOff,
  ChevronDown,
  Zap,
  Flashlight,
  Siren,
  Aperture,
  Check,
  X,
  EyeOff,
  Settings,
  ListChecks,
  Square,
  SquareCheck,
} from "lucide-react";
import {
  loadWorkspaces,
  loadRecent,
  listProjects,
  deleteWorkspaces,
  createWorkspace,
  WORKSPACE_STORAGE_EVENT,
} from "../lib/workspace";
import { loadPrefs } from "../lib/prefs";
import { WORKSPACE_MODES, WORKSPACE_MODE_GROUPS, workspaceModeRoute } from "../lib/workspace-modes";
import { normalizeTextureMode } from "../lib/workspace-state";
import { DEFAULT_HOTKEYS, HOTKEY_ACTIONS, mergeHotkeys } from "../lib/hotkeys";
import appMeta from "../../package.json";
import cortexLogo from "../../src-tauri/icons/128x128@2x.png";
import * as Ctx from "./ContextMenu";
import { Keycaps, hotkeyLabel } from "./ui/keycaps";
import HomeSavedVehicles from "./HomeSavedVehicles";
import "./HomePage.css";

const MODES = WORKSPACE_MODES;
const MODE_GROUPS = WORKSPACE_MODE_GROUPS;

const FILTER_TABS = [
  { id: "all", label: "All" },
  { id: "vehicle", label: "Vehicle" },
  { id: "eup", label: "EUP" },
  { id: "multi", label: "Multi" },
  { id: "sirens", label: "Sirens" },
  { id: "variants", label: "Variants" },
  { id: "templategen", label: "Templates" },
  { id: "eupstudio", label: "EUP Studio" },
  { id: "propstudio", label: "Prop Studio" },
  { id: "photo", label: "Photo Mode" },
];

const SORT_OPTIONS = [
  { id: "recent", label: "Last opened" },
  { id: "name", label: "Name" },
  { id: "type", label: "Type" },
];

const PINNED_KEY = "cortex-studio:pinned.v1";

function loadPinned() {
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
function savePinned(ids) {
  try {
    localStorage.setItem(PINNED_KEY, JSON.stringify(ids));
  } catch {}
}

function loadHotkeys() {
  const prefs = loadPrefs();
  const stored = prefs?.hotkeys && typeof prefs.hotkeys === "object" ? prefs.hotkeys : {};
  return mergeHotkeys(stored, DEFAULT_HOTKEYS);
}

function getModeTag(entry, ws) {
  if (entry.page === "variants") return "Variant";
  if (entry.page === "templategen") return "Template";
  if (entry.page === "eupstudio") return "EUP Studio";
  if (entry.page === "propstudio") return "Prop Studio";
  if (entry.page === "photo") return "Photo Mode";
  const mode = normalizeTextureMode(ws?.state?.textureMode) || "vehicle";
  if (mode === "eup") return "EUP";
  if (mode === "multi") return "Multi";
  if (mode === "sirens") return "Sirens";
  return "Vehicle";
}

const TAG_CATEGORY = {
  Vehicle: "livery",
  EUP: "eup",
  "EUP Studio": "eup",
  "Prop Studio": "prop",
  "Photo Mode": "photo",
  Multi: "multi",
  Sirens: "siren",
  Variant: "variant",
  Template: "template",
};

function matchesFilter(filterId, entry, ws) {
  if (filterId === "all") return true;
  if (filterId === "variants" || filterId === "templategen" || filterId === "eupstudio" || filterId === "propstudio" || filterId === "photo") {
    return entry.page === filterId;
  }
  if (entry.page === "variants" || entry.page === "templategen" || entry.page === "eupstudio" || entry.page === "propstudio" || entry.page === "photo") {
    return false;
  }
  return (normalizeTextureMode(ws?.state?.textureMode) || "vehicle") === filterId;
}

function getModelPath(ws) {
  return ws?.state?.modelPath || ws?.state?.openFile || null;
}

function getModelName(ws) {
  const path = getModelPath(ws);
  if (!path) return null;
  return path.split(/[\\/]/).pop();
}

function getProjectFolder(ws) {
  const path = getModelPath(ws);
  if (!path) return null;
  const parts = path.split(/[\\/]/);
  if (parts.length > 1) return parts[parts.length - 2];
  return null;
}

function splitPath(path) {
  if (typeof path !== "string" || !path.trim()) return null;
  const parts = path.split(/[\\/]/).filter(Boolean);
  const file = parts.pop() || path;
  return { path, file, folder: parts.length ? parts[parts.length - 1] : null };
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const MAX_LINEUP_STEPS = 3;

// The focus slate mirrors the workspace dock: the files a project actually
// holds, in pipeline order. Only viewer workspaces persist these paths.
function projectPipeline(entry, ws) {
  if (entry.page !== "viewer") return null;
  const state = ws?.state || {};
  const mode = normalizeTextureMode(state.textureMode) || "vehicle";
  if (mode === "multi") {
    const vehicles = (Array.isArray(state.lineup?.slots) ? state.lineup.slots : [])
      .map((slot) => splitPath(slot?.modelPath))
      .filter(Boolean);
    if (!vehicles.length) return { steps: [{ label: "Vehicle", file: null }], more: 0 };
    return {
      steps: vehicles
        .slice(0, MAX_LINEUP_STEPS)
        .map((file, index) => ({ label: `Vehicle ${index + 1}`, file })),
      more: Math.max(0, vehicles.length - MAX_LINEUP_STEPS),
    };
  }
  const steps = [
    { label: "Model", file: splitPath(state.modelSourcePath || state.modelPath || state.openFile) },
    { label: mode === "vehicle" ? "Livery" : "Texture", file: splitPath(state.texturePath) },
  ];
  if (state.windowTexturePath || state.windowTemplateEnabled) {
    steps.push({ label: "Windows", file: splitPath(state.windowTexturePath) });
  }
  const paint = mode !== "eup" && HEX_COLOR.test(state.bodyColor || "") ? state.bodyColor : null;
  return { steps, more: 0, paint };
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
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
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
  week: "This week",
  older: "Older",
};

function loadHomeDefaults() {
  const prefs = loadPrefs() || {};
  return prefs?.defaults && typeof prefs.defaults === "object" ? prefs.defaults : {};
}

function shouldShowRecents() {
  return loadHomeDefaults().showRecents !== false;
}

function loadDefaultSort() {
  const sort = loadHomeDefaults().homeSort;
  return SORT_OPTIONS.some((option) => option.id === sort) ? sort : "recent";
}

function shouldConfirmDelete() {
  return loadHomeDefaults().confirmProjectDelete !== false;
}

function modeIconFor(entry, ws) {
  const mode = normalizeTextureMode(ws?.state?.textureMode) || "vehicle";
  if (entry.page === "variants") return Palette;
  if (entry.page === "templategen") return Zap;
  if (entry.page === "eupstudio") return Shirt;
  if (entry.page === "propstudio") return Flashlight;
  if (entry.page === "photo") return Aperture;
  if (mode === "eup") return Shirt;
  if (mode === "multi") return Link2;
  if (mode === "sirens") return Siren;
  return Car;
}

function CategoryTag({ tag }) {
  return (
    <span className="hp-tag" data-cat={TAG_CATEGORY[tag] || "all"}>
      {tag}
    </span>
  );
}

export default function HomePage({
  isActive = true,
  onNavigate,
  onOpenWorkspace,
  onOpenSavedVehicle,
  settingsVersion,
}) {
  const [recent, setRecent] = useState([]);
  const [workspaces, setWorkspaces] = useState({});
  const [showRecents, setShowRecents] = useState(() => shouldShowRecents());
  const [hotkeys, setHotkeys] = useState(() => loadHotkeys());
  const [showNewProject, setShowNewProject] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [selectedMode, setSelectedMode] = useState("vehicle");
  const [activeSection, setActiveSection] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState(() => loadDefaultSort());
  const [pendingDelete, setPendingDelete] = useState(null);
  const [, setClock] = useState(0);
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [pinnedIds, setPinnedIds] = useState(() => loadPinned());
  const [selectedProject, setSelectedProject] = useState(null);
  // Select mode: row clicks tick projects for a bulk delete instead of focusing them.
  const [selecting, setSelecting] = useState(false);
  const [checkedIds, setCheckedIds] = useState(() => new Set());
  const [olderLimit, setOlderLimit] = useState(8);
  const searchRef = useRef(null);
  const sortWrapRef = useRef(null);

  useEffect(() => {
    if (!selectedProject) return;
    const stillExists = recent.some(
      (entry) => entry.workspaceId === selectedProject.workspaceId,
    );
    if (!stillExists) setSelectedProject(null);
  }, [recent, selectedProject]);

  const refreshWorkspaceState = useCallback(() => {
    setWorkspaces(loadWorkspaces());
    setRecent(loadRecent());
    setShowRecents(shouldShowRecents());
  }, []);

  useEffect(() => {
    refreshWorkspaceState();
    setHotkeys(loadHotkeys());
  }, [refreshWorkspaceState, settingsVersion]);

  useEffect(() => {
    setSortBy(loadDefaultSort());
  }, [settingsVersion]);

  // Relative times ("2m ago") only need to tick while Home is on screen.
  useEffect(() => {
    if (!isActive) return undefined;
    setClock((tick) => tick + 1);
    const timer = window.setInterval(() => setClock((tick) => tick + 1), 30000);
    return () => window.clearInterval(timer);
  }, [isActive]);

  useEffect(() => {
    const handleWorkspaceStorage = (event) => {
      refreshWorkspaceState();
      // Opening a project hands the focus panel back to the latest one.
      const reason = event?.detail?.reason;
      if (reason === "recent-add" || reason === "recent-touch") setSelectedProject(null);
    };
    window.addEventListener(WORKSPACE_STORAGE_EVENT, handleWorkspaceStorage);
    return () =>
      window.removeEventListener(
        WORKSPACE_STORAGE_EVENT,
        handleWorkspaceStorage,
      );
  }, [refreshWorkspaceState]);

  // Close sort dropdown on outside click
  useEffect(() => {
    if (!showSortMenu) return;
    const handleClick = (e) => {
      if (sortWrapRef.current?.contains(e.target)) return;
      setShowSortMenu(false);
    };
    window.addEventListener("mousedown", handleClick);
    return () => window.removeEventListener("mousedown", handleClick);
  }, [showSortMenu]);

  const togglePin = useCallback((wsId, e) => {
    if (e) e.stopPropagation();
    setPinnedIds((prev) => {
      const next = prev.includes(wsId)
        ? prev.filter((id) => id !== wsId)
        : [...prev, wsId].slice(-5);
      savePinned(next);
      return next;
    });
  }, []);

  const validRecent = useMemo(() => listProjects(workspaces, recent), [recent, workspaces]);

  const filterCounts = useMemo(() => {
    const counts = {};
    for (const filter of FILTER_TABS) {
      counts[filter.id] = validRecent.filter((entry) =>
        matchesFilter(filter.id, entry, workspaces[entry.workspaceId]),
      ).length;
    }
    return counts;
  }, [validRecent, workspaces]);

  const filteredRecent = useMemo(() => {
    let list = validRecent.filter((entry) =>
      matchesFilter(activeSection, entry, workspaces[entry.workspaceId]),
    );
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((entry) => {
        const ws = workspaces[entry.workspaceId];
        const name = (ws.name || "").toLowerCase();
        const model = (getModelName(ws) || "").toLowerCase();
        const folder = (getProjectFolder(ws) || "").toLowerCase();
        return name.includes(q) || model.includes(q) || folder.includes(q);
      });
    }
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
  }, [validRecent, workspaces, activeSection, searchQuery, sortBy]);

  const groupedRecent = useMemo(() => {
    if (sortBy !== "recent") return null;
    const groups = { today: [], week: [], older: [] };
    filteredRecent.forEach((entry) => {
      const ws = workspaces[entry.workspaceId];
      const g = timeGroup(entry.openedAt);
      groups[g].push(entry);
    });
    return groups;
  }, [filteredRecent, workspaces, sortBy]);

  const pinnedEntries = useMemo(() => {
    return validRecent.filter((entry) => pinnedIds.includes(entry.workspaceId));
  }, [validRecent, pinnedIds]);

  const hasProjects = validRecent.length > 0;

  // The focus panel shows the selected project, or the last one opened.
  const focusEntry =
    selectedProject && workspaces[selectedProject.workspaceId]
      ? selectedProject
      : validRecent[0] || null;
  const focusWs = focusEntry ? workspaces[focusEntry.workspaceId] : null;

  // Shell starts the project and names it after the workspace, the same way
  // the new-tab menu, onboarding and the new-tab hotkeys do.
  const handleLaunch = useCallback(
    (modeId) => {
      const route = workspaceModeRoute(modeId);
      if (route) onNavigate(route.page, null, route.textureMode);
    },
    [onNavigate],
  );

  const handleCreateProject = useCallback(() => {
    const name = projectName.trim() || "Untitled Project";
    if (selectedMode === "variants" || selectedMode === "templategen" || selectedMode === "eupstudio" || selectedMode === "propstudio" || selectedMode === "photo") {
      const id = createWorkspace(name, selectedMode);
      onNavigate(selectedMode, id);
    } else {
      const id = createWorkspace(name, "viewer", { textureMode: selectedMode });
      onNavigate("viewer", id, selectedMode);
    }
    setShowNewProject(false);
    setProjectName("");
  }, [projectName, selectedMode, onNavigate]);

  /** Returns false when the project list could not be saved; nothing is deleted then. */
  const performDeleteWorkspaces = useCallback(
    (ids) => {
      const doomed = new Set(ids);
      const ok = deleteWorkspaces([...doomed]);
      refreshWorkspaceState();
      if (!ok) return false;
      setPinnedIds((prev) => {
        const next = prev.filter((id) => !doomed.has(id));
        savePinned(next);
        return next;
      });
      setCheckedIds((prev) => new Set([...prev].filter((id) => !doomed.has(id))));
      return true;
    },
    [refreshWorkspaceState],
  );

  const requestDelete = useCallback(
    (ids, confirm) => {
      const live = ids.filter((id) => workspaces[id]);
      if (live.length === 0) return;
      const names = live.map((id) => workspaces[id]?.name || "Untitled");
      if (!confirm && performDeleteWorkspaces(live)) return;
      setPendingDelete({ ids: live, names, failed: !confirm });
    },
    [performDeleteWorkspaces, workspaces],
  );

  const handleDeleteWorkspace = useCallback(
    (e, wsId) => {
      e?.stopPropagation?.();
      requestDelete([wsId], shouldConfirmDelete());
    },
    [requestDelete],
  );

  // A bulk delete always asks first, even with single-delete confirmation off.
  const requestBulkDelete = useCallback(() => {
    requestDelete([...checkedIds], checkedIds.size > 1 || shouldConfirmDelete());
  }, [checkedIds, requestDelete]);

  const startSelecting = useCallback((wsId) => {
    setSelecting(true);
    if (wsId) setCheckedIds((prev) => new Set(prev).add(wsId));
  }, []);

  const stopSelecting = useCallback(() => {
    setSelecting(false);
    setCheckedIds(new Set());
  }, []);

  const toggleChecked = useCallback((wsId) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(wsId)) next.delete(wsId);
      else next.add(wsId);
      return next;
    });
  }, []);

  const allShownChecked =
    filteredRecent.length > 0 && filteredRecent.every((entry) => checkedIds.has(entry.workspaceId));

  const toggleAllShown = useCallback(() => {
    setCheckedIds((prev) => {
      if (filteredRecent.every((entry) => prev.has(entry.workspaceId))) return new Set();
      const next = new Set(prev);
      for (const entry of filteredRecent) next.add(entry.workspaceId);
      return next;
    });
  }, [filteredRecent]);

  // Ticks for projects deleted elsewhere (another tab, a single delete) drop out.
  useEffect(() => {
    setCheckedIds((prev) => {
      const next = new Set([...prev].filter((id) => workspaces[id]));
      return next.size === prev.size ? prev : next;
    });
  }, [workspaces]);

  useEffect(() => {
    if (selecting && !hasProjects) stopSelecting();
  }, [selecting, hasProjects, stopSelecting]);

  useEffect(() => {
    if (!selecting || !isActive || pendingDelete) return undefined;
    const onKeyDown = (event) => {
      if (event.target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        stopSelecting();
      } else if (event.key === "Delete" && checkedIds.size > 0) {
        event.preventDefault();
        requestBulkDelete();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selecting, isActive, pendingDelete, checkedIds, requestBulkDelete, stopSelecting]);

  const handleOpenRecent = useCallback(
    (entry) => {
      const ws = loadWorkspaces()[entry.workspaceId];
      if (ws) onOpenWorkspace(ws);
    },
    [onOpenWorkspace],
  );

  const openRecentSettings = useCallback(() => {
    window.dispatchEvent(new CustomEvent("cortex:open-settings"));
    window.dispatchEvent(
      new CustomEvent("cortex:nav-settings", { detail: { section: "general" } }),
    );
  }, []);

  /* ─── Project row ─── */
  const renderProjectRow = (entry, opts = {}) => {
    const ws = workspaces[entry.workspaceId];
    if (!ws) return null;
    const Icon = modeIconFor(entry, ws);
    const isPinned = pinnedIds.includes(entry.workspaceId);
    const tag = getModeTag(entry, ws);
    const model = getModelName(ws);
    const folder = getProjectFolder(ws);
    const openedAt = entry.openedAt;
    const isChecked = selecting && checkedIds.has(entry.workspaceId);
    const isSelected = selecting ? isChecked : focusEntry?.workspaceId === entry.workspaceId;
    const CheckIcon = isChecked ? SquareCheck : Square;

    return (
      <Ctx.Root key={`${opts.pinned ? "pin" : "row"}-${entry.workspaceId}`}>
        <Ctx.Trigger>
          <div
            className={`hp-row ${isSelected ? "is-selected" : ""}`}
            data-cat={TAG_CATEGORY[tag] || "all"}
            role="group"
            aria-label={`${ws.name} project`}
          >
            <button
              type="button"
              className="hp-row-open"
              onClick={() => (selecting ? toggleChecked(entry.workspaceId) : setSelectedProject(entry))}
              onDoubleClick={selecting ? undefined : () => handleOpenRecent(entry)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !selecting) {
                  event.preventDefault();
                  handleOpenRecent(entry);
                }
              }}
              aria-pressed={isSelected}
              aria-label={
                selecting
                  ? `Select ${ws.name}. ${tag} project.`
                  : `${ws.name}. ${tag} project. Opened ${relativeTime(openedAt).toLowerCase()}. Press Enter to open.`
              }
            >
              {selecting ? (
                <CheckIcon className="hp-row-icon hp-row-check" aria-hidden="true" />
              ) : (
                <Icon className="hp-row-icon" aria-hidden="true" />
              )}
              <span className="hp-row-text">
                <span className="hp-row-name">
                  <span className="hp-row-label">{ws.name}</span>
                  {isPinned && !opts.pinned ? (
                    <Pin className="hp-row-pin-mark" aria-label="Pinned" />
                  ) : null}
                </span>
                {model || folder ? (
                  <span className="hp-row-meta">
                    {model ? <span className="hp-row-model" title={getModelPath(ws)}>{model}</span> : null}
                    {folder ? <span className="hp-row-folder">/{folder}</span> : null}
                  </span>
                ) : null}
              </span>
              <CategoryTag tag={tag} />
              <time
                className="hp-row-time"
                dateTime={openedAt ? new Date(openedAt).toISOString() : undefined}
                title={openedAt ? `Opened ${new Date(openedAt).toLocaleString()}` : undefined}
              >
                {relativeTime(openedAt)}
              </time>
            </button>
            {selecting ? null : <div className="hp-row-actions">
              <button
                type="button"
                className="cx-icon-btn"
                onClick={(e) => togglePin(entry.workspaceId, e)}
                onDoubleClick={(e) => e.stopPropagation()}
                title={isPinned ? "Unpin" : "Pin"}
                aria-label={isPinned ? `Unpin ${ws.name}` : `Pin ${ws.name}`}
              >
                {isPinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
              </button>
              <button
                type="button"
                className="cx-icon-btn is-danger"
                onClick={(e) => handleDeleteWorkspace(e, entry.workspaceId)}
                onDoubleClick={(e) => e.stopPropagation()}
                title="Delete project"
                aria-label={`Delete ${ws.name}`}
              >
                <Trash2 aria-hidden="true" />
              </button>
            </div>}
          </div>
        </Ctx.Trigger>
        <Ctx.Content>
          <Ctx.Item onSelect={() => handleOpenRecent(entry)}>
            <FolderOpen className="w-3.5 h-3.5" /> Open
          </Ctx.Item>
          <Ctx.Item onSelect={() => togglePin(entry.workspaceId)}>
            {isPinned ? (
              <PinOff className="w-3.5 h-3.5" />
            ) : (
              <Pin className="w-3.5 h-3.5" />
            )}
            {isPinned ? "Unpin" : "Pin to top"}
          </Ctx.Item>
          <Ctx.Item
            onSelect={() => (selecting ? toggleChecked(entry.workspaceId) : startSelecting(entry.workspaceId))}
          >
            <ListChecks className="w-3.5 h-3.5" />
            {isChecked ? "Deselect" : "Select"}
          </Ctx.Item>
          <Ctx.Separator />
          <Ctx.Item
            onSelect={(e) => handleDeleteWorkspace(e, entry.workspaceId)}
            destructive
          >
            <Trash2 className="w-3.5 h-3.5" /> Delete
          </Ctx.Item>
        </Ctx.Content>
      </Ctx.Root>
    );
  };

  const renderGroupedList = () => {
    if (!groupedRecent) {
      return filteredRecent.map((entry) => renderProjectRow(entry));
    }
    const elements = [];
    for (const key of ["today", "week", "older"]) {
      const items = groupedRecent[key];
      if (items.length === 0) continue;
      elements.push(
        <div key={`group-${key}`} className="hp-group cx-label">
          {GROUP_LABELS[key]}
        </div>,
      );
      const visible = key === "older" ? items.slice(0, olderLimit) : items;
      visible.forEach((entry) => {
        elements.push(renderProjectRow(entry));
      });
      if (key === "older" && items.length > olderLimit) {
        const remaining = items.length - olderLimit;
        elements.push(
          <button
            key="load-more"
            type="button"
            className="hp-load-more"
            onClick={() => setOlderLimit(olderLimit + 10)}
          >
            <ChevronDown aria-hidden="true" />
            Show {remaining} more
          </button>,
        );
      }
    }
    return elements;
  };

  /* ─── Focus panel ─── */
  const renderFocus = () => {
    if (!showRecents) {
      return (
        <div className="hp-focus hp-focus--note">
          <EyeOff className="hp-note-icon" aria-hidden="true" />
          <div>
            <h2 className="hp-note-title">Recent projects are hidden</h2>
            <p className="hp-note-copy">
              Turn on Session persistence in Settings to see your project history here.
            </p>
          </div>
          <button type="button" className="cx-btn" onClick={openRecentSettings}>
            <Settings aria-hidden="true" />
            Open Settings
          </button>
        </div>
      );
    }

    if (!focusEntry || !focusWs) {
      return (
        <div className="hp-focus hp-focus--empty">
          <h1 className="hp-focus-name cx-display">Start your first project</h1>
          <p className="hp-focus-lede">
            Pick a workspace on the left, or open a vehicle model to begin painting a livery.
            Projects you open appear here so you can pick up where you left off.
          </p>
          <div className="hp-focus-actions">
            <button
              type="button"
              className="cx-btn is-primary"
              onClick={() => handleLaunch("vehicle")}
            >
              <Car aria-hidden="true" />
              Open a vehicle model
            </button>
            <button
              type="button"
              className="cx-btn"
              onClick={() => setShowNewProject(true)}
            >
              <Plus aria-hidden="true" />
              New project
            </button>
          </div>
        </div>
      );
    }

    const tag = getModeTag(focusEntry, focusWs);
    const updatedAt = focusWs.updatedAt || focusEntry.openedAt;
    const openedAt = focusEntry.openedAt;
    const isPinned = pinnedIds.includes(focusEntry.workspaceId);
    const isLastOpened = focusEntry.workspaceId === validRecent[0]?.workspaceId;
    const pipeline = projectPipeline(focusEntry, focusWs);

    return (
      <div className={`hp-focus ${pipeline ? "" : "hp-focus--bare"}`} aria-live="polite">
        <span className="hp-marks" aria-hidden="true">
          <i /><i /><i /><i />
        </span>
        <h1
          key={focusEntry.workspaceId}
          className="hp-focus-name cx-display"
          title={focusWs.name}
        >
          {focusWs.name}
        </h1>
        <div className="hp-focus-sub">
          <CategoryTag tag={tag} />
          <span>{isLastOpened ? "Last opened" : "Opened"} {relativeTime(openedAt).toLowerCase()}</span>
          {updatedAt ? (
            <span className="hp-focus-stamp" title={new Date(updatedAt).toLocaleString()}>
              Saved{" "}
              {new Date(updatedAt).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          ) : null}
        </div>
        {pipeline ? (
          <ol className="hp-pipe" key={`pipe-${focusEntry.workspaceId}`} aria-label="Project files">
            {pipeline.steps.map((step, index) => (
              <li key={step.label} className={`hp-pipe-step ${step.file ? "is-done" : ""}`}>
                <span className="hp-pipe-head">
                  <span className="hp-pipe-disc cx-display" aria-hidden="true">
                    {step.file ? <Check /> : index + 1}
                  </span>
                  <span className="cx-label">{step.label}</span>
                </span>
                {step.file ? (
                  <>
                    <span className="hp-pipe-file" title={step.file.path}>{step.file.file}</span>
                    <span className="hp-pipe-folder">
                      {step.file.folder ? `/${step.file.folder}` : "\u00a0"}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="hp-pipe-file is-empty">Not set</span>
                    <span className="hp-pipe-folder">{"\u00a0"}</span>
                  </>
                )}
              </li>
            ))}
            {pipeline.more ? (
              <li className="hp-pipe-step hp-pipe-more">
                <span className="hp-pipe-head">
                  <span className="cx-label">Lineup</span>
                </span>
                <span className="hp-pipe-file">+{pipeline.more} more</span>
                <span className="hp-pipe-folder">{"\u00a0"}</span>
              </li>
            ) : null}
            {pipeline.paint ? (
              <li className="hp-pipe-step hp-pipe-paint">
                <span className="hp-pipe-head">
                  <span className="hp-pipe-swatch" style={{ background: pipeline.paint }} aria-hidden="true" />
                  <span className="cx-label">Paint</span>
                </span>
                <span className="hp-pipe-file">{pipeline.paint.toUpperCase()}</span>
                <span className="hp-pipe-folder">{"\u00a0"}</span>
              </li>
            ) : null}
          </ol>
        ) : null}
        <div className="hp-focus-actions">
          <button
            type="button"
            className="cx-btn is-primary"
            onClick={() => handleOpenRecent(focusEntry)}
          >
            <FolderOpen aria-hidden="true" />
            Open project
            <span className="cx-keys" aria-hidden="true">
              <kbd className="cx-keycap">Enter</kbd>
            </span>
          </button>
          <button
            type="button"
            className="cx-btn"
            onClick={(e) => togglePin(focusEntry.workspaceId, e)}
          >
            {isPinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
            {isPinned ? "Unpin" : "Pin"}
          </button>
          <button
            type="button"
            className="cx-btn is-danger"
            onClick={(e) => handleDeleteWorkspace(e, focusEntry.workspaceId)}
          >
            <Trash2 aria-hidden="true" />
            Delete
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="home-page">
      <div className="hp-layout">
        {/* ──── Start rail ──── */}
        <aside className="hp-left hp-rail">
          <div className="hp-brand">
            <img src={cortexLogo} alt="" className="hp-brand-logo" draggable={false} />
            <span className="hp-brand-word cx-display">
              Cortex <span className="hp-brand-accent">Studio</span>
            </span>
          </div>

          <nav className="hp-start" aria-labelledby="hp-start-title">
            <h2 className="hp-rail-title" id="hp-start-title">
              Start a session
            </h2>
            {MODE_GROUPS.map((group) => (
              <div className="hp-mode-group" key={group.id} role="group" aria-label={group.label}>
                <div className="hp-mode-group-label cx-label">{group.label}</div>
                {MODES.filter((mode) => mode.group === group.id).map((mode) => {
                  const Icon = mode.icon;
                  return (
                    <button
                      type="button"
                      key={mode.id}
                      className="hp-mode"
                      data-cat={mode.cat}
                      onClick={() => handleLaunch(mode.id)}
                      aria-keyshortcuts={hotkeyLabel(hotkeys[mode.action])}
                    >
                      <Icon className="hp-mode-icon" aria-hidden="true" />
                      <span className="hp-mode-label">{mode.label}</span>
                      <Keycaps hotkey={hotkeys[mode.action]} />
                      <span className="hp-mode-desc">{mode.desc}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>

        </aside>

        {/* ──── Projects ──── */}
        <main className="hp-right hp-main">
          {renderFocus()}

          {onOpenSavedVehicle ? <HomeSavedVehicles isActive={isActive} onOpen={onOpenSavedVehicle} /> : null}

          {showRecents && hasProjects ? (
            <section className="hp-projects" aria-labelledby="hp-projects-title">
              <div className="hp-projects-head">
                <h2 className="hp-projects-title" id="hp-projects-title">
                  Projects
                  <span className="hp-projects-count">{validRecent.length}</span>
                </h2>
                <div className="hp-filters" role="toolbar" aria-label="Filter projects">
                  {FILTER_TABS.map((filter) => {
                    const count = filterCounts[filter.id];
                    if (filter.id !== "all" && count === 0 && activeSection !== filter.id) {
                      return null;
                    }
                    return (
                      <button
                        key={filter.id}
                        type="button"
                        className={`hp-filter ${activeSection === filter.id ? "is-active" : ""}`}
                        onClick={() => setActiveSection(filter.id)}
                        aria-pressed={activeSection === filter.id}
                      >
                        {filter.label}
                        <span className="hp-filter-num">{count}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="hp-projects-tools">
                  <button
                    type="button"
                    className="cx-btn is-quiet hp-select-toggle"
                    onClick={() => (selecting ? stopSelecting() : startSelecting())}
                    aria-pressed={selecting}
                    title={selecting ? "Leave select mode" : "Select projects to delete several at once"}
                  >
                    <ListChecks aria-hidden="true" />
                    {selecting ? "Done" : "Select"}
                  </button>
                  <label className="hp-search">
                    <Search className="hp-search-icon" aria-hidden="true" />
                    <input
                      ref={searchRef}
                      type="text"
                      className="hp-search-input"
                      placeholder="Search projects"
                      aria-label="Search projects"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setSearchQuery("");
                      }}
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        className="hp-search-clear"
                        onClick={() => setSearchQuery("")}
                        aria-label="Clear search"
                      >
                        <X aria-hidden="true" />
                      </button>
                    )}
                  </label>
                  <div className="hp-sort" ref={sortWrapRef}>
                    <button
                      type="button"
                      className="cx-btn is-quiet hp-sort-btn"
                      onClick={() => setShowSortMenu(!showSortMenu)}
                      aria-haspopup="menu"
                      aria-expanded={showSortMenu}
                    >
                      <ArrowUpDown aria-hidden="true" />
                      {SORT_OPTIONS.find((s) => s.id === sortBy)?.label}
                    </button>
                    <AnimatePresence>
                      {showSortMenu && (
                        <motion.div
                          className="hp-sort-menu"
                          role="menu"
                          initial={{ opacity: 0, y: -4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -4 }}
                          transition={{ duration: 0.12, ease: [0.2, 0.8, 0.2, 1] }}
                        >
                          {SORT_OPTIONS.map((opt) => (
                            <button
                              key={opt.id}
                              type="button"
                              className={`hp-sort-option ${sortBy === opt.id ? "is-active" : ""}`}
                              role="menuitemradio"
                              aria-checked={sortBy === opt.id}
                              onClick={() => {
                                setSortBy(opt.id);
                                setShowSortMenu(false);
                              }}
                            >
                              <Check className="hp-sort-check" aria-hidden="true" />
                              {opt.label}
                            </button>
                          ))}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>
              </div>

              {selecting ? (
                <div className="hp-select-bar" role="toolbar" aria-label="Selected projects">
                  <span className="hp-select-count" aria-live="polite">
                    {checkedIds.size} selected
                  </span>
                  <button
                    type="button"
                    className="cx-btn is-quiet"
                    onClick={toggleAllShown}
                    disabled={filteredRecent.length === 0}
                  >
                    {allShownChecked ? "Clear selection" : `Select all ${filteredRecent.length}`}
                  </button>
                  <button
                    type="button"
                    className="cx-btn is-danger"
                    onClick={requestBulkDelete}
                    disabled={checkedIds.size === 0}
                    title={checkedIds.size === 0 ? "Tick projects in the list first" : undefined}
                  >
                    <Trash2 aria-hidden="true" />
                    {checkedIds.size > 1 ? `Delete ${checkedIds.size} projects` : "Delete project"}
                  </button>
                </div>
              ) : null}

              <div className="hp-list custom-scrollbar">
                {pinnedEntries.length > 0 && activeSection === "all" && !searchQuery ? (
                  <>
                    <div className="hp-group cx-label">Pinned</div>
                    {pinnedEntries.map((entry) => renderProjectRow(entry, { pinned: true }))}
                  </>
                ) : null}

                {filteredRecent.length > 0 ? (
                  renderGroupedList()
                ) : (
                  <div className="hp-no-results">
                    <p>No projects match {searchQuery ? `"${searchQuery}"` : "this filter"}.</p>
                    <button
                      type="button"
                      className="cx-btn is-quiet"
                      onClick={() => {
                        setSearchQuery("");
                        setActiveSection("all");
                      }}
                    >
                      Show all projects
                    </button>
                  </div>
                )}
              </div>
            </section>
          ) : null}
        </main>
      </div>

      <footer className="hp-footer">
        <span className="hp-footer-count">
          {Object.keys(workspaces).length} {Object.keys(workspaces).length === 1 ? "project" : "projects"}
        </span>
        {hasProjects && showRecents && selecting ? (
          <span className="hp-footer-hint">
            <span className="cx-keys" aria-hidden="true">
              <kbd className="cx-keycap">Del</kbd>
            </span>
            deletes the ticked projects.
            <span className="cx-keys" aria-hidden="true">
              <kbd className="cx-keycap">Esc</kbd>
            </span>
            leaves select mode.
          </span>
        ) : hasProjects && showRecents ? (
          <span className="hp-footer-hint">
            <span className="cx-keys" aria-hidden="true">
              <kbd className="cx-keycap">Enter</kbd>
            </span>
            opens the selected project. Right-click a row for more.
          </span>
        ) : null}
        <button
          type="button"
          className="hp-footer-version"
          onClick={() => window.dispatchEvent(new CustomEvent("cortex:open-release-notes"))}
          title="See what changed in each release"
        >
          Cortex Studio {appMeta.version}
        </button>
      </footer>

      {/* ─── New Project ─── */}
      <AnimatePresence>
        {showNewProject && (
          <motion.div
            className="home-modal-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
            onClick={() => setShowNewProject(false)}
          >
            <motion.div
              className="home-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="home-modal-title"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Escape") setShowNewProject(false);
              }}
            >
              <div className="home-modal-header">
                <h3 className="cx-display" id="home-modal-title">New project</h3>
                <button
                  type="button"
                  className="cx-icon-btn"
                  onClick={() => setShowNewProject(false)}
                  aria-label="Close"
                >
                  <X aria-hidden="true" />
                </button>
              </div>
              <div className="home-modal-body">
                <label className="home-field">
                  <span className="cx-label">Name</span>
                  <input
                    type="text"
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    placeholder="Untitled Project"
                    autoFocus
                    onKeyDown={(e) => e.key === "Enter" && handleCreateProject()}
                  />
                </label>
                <fieldset className="home-field">
                  <legend className="cx-label">Workspace</legend>
                  <div className="home-mode-select">
                    {MODES.map((mode) => (
                      <button
                        key={mode.id}
                        type="button"
                        className={`home-mode-option ${selectedMode === mode.id ? "is-selected" : ""}`}
                        aria-pressed={selectedMode === mode.id}
                        onClick={() => setSelectedMode(mode.id)}
                      >
                        <mode.icon aria-hidden="true" />
                        <span>{mode.label}</span>
                      </button>
                    ))}
                  </div>
                </fieldset>
              </div>
              <div className="home-modal-footer">
                <button
                  type="button"
                  className="cx-btn is-quiet"
                  onClick={() => setShowNewProject(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="cx-btn is-primary"
                  onClick={handleCreateProject}
                >
                  Create project
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── Delete confirmation ─── */}
      <AnimatePresence>
        {pendingDelete && (
          <motion.div
            className="home-modal-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
            onClick={() => setPendingDelete(null)}
          >
            <motion.div
              className="home-modal home-modal--confirm"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="home-delete-title"
              aria-describedby="home-delete-desc"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Escape") setPendingDelete(null);
              }}
            >
              <div className="home-modal-header">
                <h3 className="cx-display" id="home-delete-title">
                  {pendingDelete.ids.length > 1 ? `Delete ${pendingDelete.ids.length} projects` : "Delete project"}
                </h3>
              </div>
              <div className="home-modal-body">
                {pendingDelete.ids.length > 1 ? (
                  <>
                    <p className="home-modal-copy" id="home-delete-desc">
                      Remove these projects from Cortex Studio? Their saved workspace state is deleted.
                      Your models, textures, and exports on disk are not touched.
                    </p>
                    <ul className="home-modal-names">
                      {pendingDelete.names.slice(0, 6).map((name, index) => (
                        <li key={pendingDelete.ids[index]}>{name}</li>
                      ))}
                      {pendingDelete.names.length > 6 ? (
                        <li className="home-modal-names-more">and {pendingDelete.names.length - 6} more</li>
                      ) : null}
                    </ul>
                  </>
                ) : (
                  <p className="home-modal-copy" id="home-delete-desc">
                    Remove <strong>{pendingDelete.names[0]}</strong> from Cortex Studio? Its saved workspace
                    state is deleted. Your models, textures, and exports on disk are not touched.
                  </p>
                )}
                {pendingDelete.failed ? (
                  <p className="home-modal-error" role="alert">
                    The project list could not be saved, so nothing was deleted. Storage may be full.
                  </p>
                ) : null}
              </div>
              <div className="home-modal-footer">
                <button
                  type="button"
                  className="cx-btn is-quiet"
                  onClick={() => setPendingDelete(null)}
                  autoFocus
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="cx-btn is-danger"
                  onClick={() => {
                    if (performDeleteWorkspaces(pendingDelete.ids)) setPendingDelete(null);
                    else setPendingDelete({ ...pendingDelete, failed: true });
                  }}
                >
                  <Trash2 aria-hidden="true" />
                  {pendingDelete.failed
                    ? "Try again"
                    : pendingDelete.ids.length > 1
                      ? `Delete ${pendingDelete.ids.length} projects`
                      : "Delete project"}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
