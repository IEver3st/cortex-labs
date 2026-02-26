import { invoke } from "@tauri-apps/api/core";

function normalizePath(rawPath) {
  if (typeof rawPath !== "string") return "";
  const trimmed = rawPath.trim().replace(/^"(.*)"$/, "$1");
  if (!trimmed) return "";

  // "autoSavedPath" can contain multiple entries joined by " | ".
  const [firstEntry] = trimmed.split("|");
  return (firstEntry || "").trim();
}

/**
 * Open a folder (or file parent folder) in the OS file explorer.
 * Returns true on success and false when no opener path succeeded.
 */
export async function openFolderPath(rawPath) {
  const path = normalizePath(rawPath);
  if (!path) return false;

  try {
    await invoke("open_folder_fallback", { path });
    return true;
  } catch (fallbackError) {
    try {
      const { openPath } = await import("@tauri-apps/plugin-opener");
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
