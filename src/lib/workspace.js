/**
 * Workspace management for Cortex Studio.
 * Workspaces are saveable/loadable project states — like code editor workspaces.
 * Each workspace stores its page, viewer state, variant config, and metadata.
 */

const WORKSPACES_KEY = "cortex-studio:workspaces.v1";
const ACTIVE_WORKSPACE_KEY = "cortex-studio:active-workspace.v1";
const RECENT_KEY = "cortex-studio:recent.v1";
const MAX_RECENT = 12;

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
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
  } catch (err) {
    console.error("[Workspace] Failed to save:", err);
  }
}

/**
 * Create a new workspace.
 * @param {string} name
 * @param {"viewer"|"variants"} page
 * @param {Object} state — serializable state snapshot
 * @returns {string} The new workspace ID
 */
export function createWorkspace(name, page = "viewer", state = {}) {
  const id = generateId();
  const workspace = {
    id,
    name: name || "Untitled",
    page,
    state,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const all = loadWorkspaces();
  all[id] = workspace;
  saveWorkspaces(all);
  setActiveWorkspaceId(id);
  addRecent(id, name, page);
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
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function addRecent(workspaceId, name, page) {
  try {
    let recent = loadRecent();
    // Remove duplicate if exists
    recent = recent.filter((r) => r.workspaceId !== workspaceId);
    recent.unshift({
      workspaceId,
      name,
      page,
      openedAt: Date.now(),
    });
    if (recent.length > MAX_RECENT) recent = recent.slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
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
  } catch {}
}

export function clearRecent() {
  try {
    localStorage.removeItem(RECENT_KEY);
  } catch {}
}
