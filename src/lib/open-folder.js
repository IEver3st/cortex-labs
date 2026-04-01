import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";

function normalizeWindowsPath(path) {
  if (!/^(?:[a-zA-Z]:[\\/]|\\\\)/.test(path)) return path;
  return path.replace(/\//g, "\\");
}

export function normalizeOpenFolderPath(rawPath) {
  if (typeof rawPath !== "string") return "";
  const trimmed = rawPath.trim().replace(/^"(.*)"$/, "$1");
  if (!trimmed) return "";

  // "autoSavedPath" can contain multiple entries joined by " | ".
  const [firstEntry] = trimmed.split("|");
  const normalized = (firstEntry || "").trim();
  if (!normalized) return "";

  return normalizeWindowsPath(normalized);
}

/**
 * Open a folder (or file parent folder) in the OS file explorer.
 * Returns true on success and false when no opener path succeeded.
 */
export async function openFolderPath(rawPath) {
  const path = normalizeOpenFolderPath(rawPath);
  if (!path) return false;

  try {
    await invoke("open_folder_fallback", { path });
    return true;
  } catch (fallbackError) {
    try {
      await openPath(path);
      return true;
    } catch (openerError) {
      console.error("[openFolderPath] Failed to open path:", path, {
        fallbackError,
        openerError,
      });
      return false;
    }
  }
}
