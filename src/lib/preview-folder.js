function normalizeFolderPath(rawPath) {
  if (typeof rawPath !== "string") return "";
  return rawPath.trim().replace(/^"(.*)"$/, "$1");
}

async function folderExists(path, pathExists) {
  const normalized = normalizeFolderPath(path);
  if (!normalized) return false;
  if (typeof pathExists !== "function") return true;

  try {
    return Boolean(await pathExists(normalized));
  } catch {
    return false;
  }
}

export async function resolveExistingPreviewFolderPath(preferredPath, fallbackPath = "", pathExists) {
  const normalizedPreferred = normalizeFolderPath(preferredPath);
  const normalizedFallback = normalizeFolderPath(fallbackPath);
  const candidates = [];

  if (normalizedPreferred) {
    candidates.push(normalizedPreferred);
    const trimmed = normalizedPreferred.replace(/[\\/]+$/, "");
    const parent = trimmed.replace(/[\\/][^\\/]+$/, "");
    if (parent && parent !== trimmed) candidates.push(parent);
  }

  if (normalizedFallback) candidates.push(normalizedFallback);

  const uniqueCandidates = [...new Set(candidates.filter(Boolean))];
  if (typeof pathExists !== "function") return uniqueCandidates[0] || "";

  for (const candidate of uniqueCandidates) {
    if (await folderExists(candidate, pathExists)) return candidate;
  }

  return "";
}

export async function ensurePreviewExportFolder({
  savedFolder,
  isTauriRuntime,
  pathExists,
  chooseFolder,
  persistFolder,
} = {}) {
  const normalizedSavedFolder = normalizeFolderPath(savedFolder);

  if (normalizedSavedFolder && await folderExists(normalizedSavedFolder, pathExists)) {
    return { folder: normalizedSavedFolder, status: "ready" };
  }

  if (!isTauriRuntime) {
    return {
      folder: "",
      status: normalizedSavedFolder ? "missing-without-picker" : "unset-without-picker",
      missingFolder: normalizedSavedFolder,
    };
  }

  const reason = normalizedSavedFolder ? "missing" : "unset";
  const selectedFolder = typeof chooseFolder === "function"
    ? await chooseFolder({ reason, missingFolder: normalizedSavedFolder })
    : "";
  const normalizedSelectedFolder = normalizeFolderPath(selectedFolder);

  if (!normalizedSelectedFolder) {
    return {
      folder: "",
      status: reason === "missing" ? "cancelled-missing" : "cancelled-unset",
      missingFolder: normalizedSavedFolder,
    };
  }

  if (typeof persistFolder === "function") {
    await persistFolder(normalizedSelectedFolder);
  }

  return {
    folder: normalizedSelectedFolder,
    status: reason === "missing" ? "replaced-missing" : "selected-unset",
    previousFolder: normalizedSavedFolder,
  };
}
