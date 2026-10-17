/**
 * Workspace management for Cortex Studio.
 * Workspaces are saveable/loadable project states — like code editor workspaces.
 * Each workspace stores its page, viewer state, variant config, and metadata.
 */

import { normalizeTextureMode } from "./workspace-state.js";

const WORKSPACES_KEY = "cortex-studio:workspaces.v1";
const ACTIVE_WORKSPACE_KEY = "cortex-studio:active-workspace.v1";
const RECENT_KEY = "cortex-studio:recent.v1";
const OPEN_TABS_KEY = "cortex-studio:open-tabs.v1";
// Recents only order projects; Home lists every saved workspace.
const MAX_RECENT = 200;
export const WORKSPACE_STORAGE_EVENT = "cortex-studio:workspace-storage-updated";
export const WORKSPACE_SAVE_FAILED_EVENT = "cortex-studio:workspace-save-failed";

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function emitWorkspaceStorageEvent(reason, workspaceId) {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent(WORKSPACE_STORAGE_EVENT, {
        detail: {
          reason: reason || "changed",
          workspaceId: workspaceId || null,
          at: Date.now(),
        },
      }),
    );
  } catch {}
}

/**
 * Load all saved workspaces.
 * @returns {Object<string, Workspace>}
 */
export function loadWorkspaces() {
  try {
    const raw = localStorage.getItem(WORKSPACES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

/**
 * Save the workspace map.
 */
export function saveWorkspaces(workspaces) {
  try {
    localStorage.setItem(WORKSPACES_KEY, JSON.stringify(workspaces));
    emitWorkspaceStorageEvent("workspaces");
    return true;
  } catch (err) {
    console.error("[Workspace] Failed to save:", err);
    if (typeof window !== "undefined") {
      try {
        window.dispatchEvent(
          new CustomEvent(WORKSPACE_SAVE_FAILED_EVENT, {
            detail: { message: String(err?.message || err), at: Date.now() },
          }),
        );
      } catch {}
    }
    return false;
  }
}

/**
 * Create a new workspace.
 * @param {string} name
 * @param {"viewer"|"variants"|"templategen"|"eupstudio"|"propstudio"|"photo"} page

 * @param {Object} state — serializable state snapshot
 * @returns {string} The new workspace ID
 */
export function createWorkspace(name, page = "viewer", state = {}) {
  const id = generateId();
  const normalizedName = typeof name === "string" && name.trim() ? name.trim() : "Untitled";
  const workspace = {
    id,
    name: normalizedName,
    page,
    state,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const all = loadWorkspaces();
  all[id] = workspace;
  saveWorkspaces(all);
  setActiveWorkspaceId(id);
  addRecent(id, normalizedName, page);
  return id;
}

/**
 * Update an existing workspace's state.
 */
export function updateWorkspace(id, patch) {
  const all = loadWorkspaces();
  if (!all[id]) return;
  all[id] = { ...all[id], ...patch, updatedAt: Date.now() };
  saveWorkspaces(all);
}

/**
 * Delete a workspace.
 */
export function deleteWorkspace(id) {
  return deleteWorkspaces([id]);
}

/**
 * Delete several workspaces with one write to each store.
 * @returns {boolean} false when the workspace map could not be saved; recents
 *   and the active id are then left alone so nothing points at a half-deleted set.
 */
export function deleteWorkspaces(ids) {
  const doomed = new Set((Array.isArray(ids) ? ids : []).filter(Boolean));
  if (doomed.size === 0) return true;
  const all = loadWorkspaces();
  for (const id of doomed) delete all[id];
  if (!saveWorkspaces(all)) return false;
  removeRecentByWorkspaceIds(doomed);
  if (doomed.has(getActiveWorkspaceId())) {
    clearActiveWorkspaceId();
  }
  return true;
}

/**
 * Rename a workspace.
 */
export function renameWorkspace(id, newName) {
  updateWorkspace(id, { name: newName });
}

/**
 * Get the active workspace ID.
 */
export function getActiveWorkspaceId() {
  try {
    return localStorage.getItem(ACTIVE_WORKSPACE_KEY) || null;
  } catch {
    return null;
  }
}

/**
 * Set the active workspace ID.
 */
export function setActiveWorkspaceId(id) {
  try {
    localStorage.setItem(ACTIVE_WORKSPACE_KEY, id);
  } catch {}
}

/**
 * Clear active workspace.
 */
export function clearActiveWorkspaceId() {
  try {
    localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
  } catch {}
}

/**
 * Load the active workspace.
 */
export function loadActiveWorkspace() {
  const id = getActiveWorkspaceId();
  if (!id) return null;
  const all = loadWorkspaces();
  return all[id] || null;
}

/**
 * Recent projects list.
 */
export function loadRecent() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof entry.workspaceId === "string" &&
        entry.workspaceId.length > 0,
    );
  } catch {
    return [];
  }
}

function removeRecentByWorkspaceIds(workspaceIds) {
  try {
    const current = loadRecent();
    const next = current.filter((entry) => !workspaceIds.has(entry.workspaceId));
    if (next.length === current.length) return;
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    emitWorkspaceStorageEvent("recent-remove", workspaceIds.size === 1 ? [...workspaceIds][0] : null);
  } catch {}
}

function normalizePage(page) {
  return page === "eupstudio" || page === "propstudio" || page === "photo" || page === "variants" || page === "templategen" ? page : "viewer";
}

export function addRecent(workspaceId, name, page) {
  if (typeof workspaceId !== "string" || !workspaceId) return;
  try {
    let recent = loadRecent();
    // Remove duplicate if exists
    recent = recent.filter((r) => r.workspaceId !== workspaceId);
    recent.unshift({
      workspaceId,
      name: typeof name === "string" && name.trim() ? name.trim() : "Untitled",
      page: normalizePage(page),
      openedAt: Date.now(),
    });
    if (recent.length > MAX_RECENT) recent = recent.slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    emitWorkspaceStorageEvent("recent-add", workspaceId);
  } catch {}
}

/**
 * Record that a saved workspace was opened or brought to the front, so Home
 * orders it first. Covers tabs that were already open as well as new ones.
 */
export function markWorkspaceOpened(workspaceId) {
  if (typeof workspaceId !== "string" || !workspaceId) return;
  const ws = loadWorkspaces()[workspaceId];
  if (!ws) return;
  addRecent(workspaceId, ws.name, ws.page);
}

function finiteTime(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Every saved workspace as a Home project entry, most recently opened first.
 * Workspaces with no open record (older data, or trimmed recents) fall back to
 * their last save time so they still appear instead of silently vanishing.
 */
export function listProjects(workspaces, recent) {
  const all = workspaces && typeof workspaces === "object" ? workspaces : {};
  const openedById = new Map();
  for (const entry of Array.isArray(recent) ? recent : []) {
    if (!entry || typeof entry.workspaceId !== "string") continue;
    if (!openedById.has(entry.workspaceId)) openedById.set(entry.workspaceId, entry);
  }
  const projects = [];
  for (const [key, ws] of Object.entries(all)) {
    if (!ws || typeof ws !== "object") continue;
    const workspaceId = typeof ws.id === "string" && ws.id ? ws.id : key;
    const entry = openedById.get(workspaceId);
    projects.push({
      workspaceId,
      name: typeof ws.name === "string" && ws.name.trim() ? ws.name : "Untitled",
      page: normalizePage(ws.page || entry?.page),
      openedAt:
        finiteTime(entry?.openedAt) || finiteTime(ws.updatedAt) || finiteTime(ws.createdAt),
    });
  }
  projects.sort((a, b) => b.openedAt - a.openedAt || a.name.localeCompare(b.name));
  return projects;
}

/**
 * Touch / update the timestamp on a recent entry.
 */
export function touchRecent(workspaceId) {
  try {
    let recent = loadRecent();
    const idx = recent.findIndex((r) => r.workspaceId === workspaceId);
    if (idx < 0) return;
    const entry = recent.splice(idx, 1)[0];
    entry.openedAt = Date.now();
    recent.unshift(entry);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    emitWorkspaceStorageEvent("recent-touch", workspaceId);
  } catch {}
}

export function clearRecent() {
  try {
    localStorage.removeItem(RECENT_KEY);
    emitWorkspaceStorageEvent("recent-clear");
  } catch {}
}

// ── Open tabs ──
// The project tabs open when the app last ran, in tab order, and the one in
// front (null for Home). Tabs without a saved workspace are not kept.

function uniqueIds(ids) {
  const out = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id === "string" && id && !out.includes(id)) out.push(id);
  }
  return out;
}

export function loadOpenTabs() {
  try {
    const parsed = JSON.parse(localStorage.getItem(OPEN_TABS_KEY) || "null");
    if (!parsed || typeof parsed !== "object") return { ids: [], active: null };
    const ids = uniqueIds(parsed.ids);
    return { ids, active: ids.includes(parsed.active) ? parsed.active : null };
  } catch {
    return { ids: [], active: null };
  }
}

/** Remembers the open project tabs. Skips the write when nothing changed. */
export function saveOpenTabs(workspaceIds, activeWorkspaceId) {
  const ids = uniqueIds(workspaceIds);
  const active = ids.includes(activeWorkspaceId) ? activeWorkspaceId : null;
  try {
    const serialized = JSON.stringify({ ids, active });
    if (localStorage.getItem(OPEN_TABS_KEY) === serialized) return true;
    localStorage.setItem(OPEN_TABS_KEY, serialized);
    return true;
  } catch {
    return false;
  }
}

/**
 * Tabs to reopen from `saved` ({ ids, active }): only workspaces that still
 * exist, in their saved order. Each entry carries what Shell needs to open it.
 */
export function planOpenTabs(saved, workspaces) {
  const all = workspaces && typeof workspaces === "object" ? workspaces : {};
  const tabs = [];
  for (const workspaceId of uniqueIds(saved?.ids)) {
    const ws = all[workspaceId];
    if (!ws || typeof ws !== "object") continue;
    const type = normalizePage(ws.page);
    const state = ws.state && typeof ws.state === "object" ? ws.state : null;
    tabs.push({
      workspaceId,
      type,
      name: typeof ws.name === "string" && ws.name.trim() ? ws.name : "Untitled",
      defaultMode: type === "viewer" ? normalizeTextureMode(state?.textureMode) || "vehicle" : null,
      state,
    });
  }
  const active = tabs.some((tab) => tab.workspaceId === saved?.active) ? saved.active : null;
  return { tabs, activeWorkspaceId: active };
}
