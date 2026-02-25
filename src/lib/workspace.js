/**
 * Workspace management for Cortex Studio.
 * Workspaces are saveable/loadable project states — like code editor workspaces.
 * Each workspace stores its page, viewer state, variant config, and metadata.
 */

const WORKSPACES_KEY = "cortex-studio:workspaces.v1";
const ACTIVE_WORKSPACE_KEY = "cortex-studio:active-workspace.v1";
const RECENT_KEY = "cortex-studio:recent.v1";
const MAX_RECENT = 12;
export const WORKSPACE_STORAGE_EVENT = "cortex-studio:workspace-storage-updated";

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
  } catch (err) {
    console.error("[Workspace] Failed to save:", err);
  }
}

/**
 * Create a new workspace.
 * @param {string} name
 * @param {"viewer"|"variants"|"templategen"} page

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
  const all = loadWorkspaces();
  delete all[id];
  saveWorkspaces(all);
  removeRecentByWorkspaceId(id);
  const active = getActiveWorkspaceId();
  if (active === id) {
    clearActiveWorkspaceId();
  }
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

function removeRecentByWorkspaceId(workspaceId) {
  try {
    const current = loadRecent();
    const next = current.filter((entry) => entry.workspaceId !== workspaceId);
    if (next.length === current.length) return;
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    emitWorkspaceStorageEvent("recent-remove", workspaceId);
  } catch {}
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
      page:
        page === "variants"
          ? "variants"
          : page === "templategen"
            ? "templategen"
            : "viewer",
      openedAt: Date.now(),
    });
    if (recent.length > MAX_RECENT) recent = recent.slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    emitWorkspaceStorageEvent("recent-add", workspaceId);
  } catch {}
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
