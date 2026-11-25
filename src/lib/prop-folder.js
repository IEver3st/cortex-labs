// FiveM script and prop-folder scanning for Prop Studio.
// Pure async helpers (take readDir as an injected dependency) so every layout
// — single resource with stream/, nested stream/ subfolders, multi-resource
// category folder like [props]/, or plain prop folder — is tested under node:test.

import { isPropModelPath, propModelFormat } from "./prop-studio.js";

const MANIFEST_RE = /^(fxmanifest\.lua|__resource\.lua)$/i;
const IGNORED_DIRS = new Set([
  ".git",
  ".vscode",
  ".idea",
  "node_modules",
  "cache",
  "dist",
  "build",
  "target",
  ".next",
  ".source",
]);
const MAX_DEPTH = 8;
const MAX_ENTRIES = 25000;
const ANCESTOR_LEVELS = 4;

const naturally = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

function detectSeparator(path) {
  return String(path || "").includes("\\") ? "\\" : "/";
}

export function normalizeComparePath(path) {
  const cleaned = String(path || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:$/i.test(cleaned) ? `${cleaned}/` : cleaned;
}

export function joinFsPath(directory, name) {
  const dir = String(directory || "");
  if (!dir) return name;
  const sep = detectSeparator(dir);
  const trimmed = dir.replace(/[\\/]+$/, "");
  // Keep root slash on "C:\" or "/"
  if (/^[a-z]:$/i.test(trimmed)) return `${trimmed}${sep}${name}`;
  return `${trimmed}${sep}${name}`;
}

export function parentFsPath(path) {
  const raw = String(path || "").replace(/[\\/]+$/, "");
  const sep = detectSeparator(raw);
  const idx = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
  if (idx <= 0) return "";
  const parent = raw.slice(0, idx);
  if (/^[a-z]:$/i.test(parent)) return `${parent}${sep}`;
  return parent;
}

export function baseFsName(path) {
  return normalizeComparePath(path).split("/").filter(Boolean).pop() || "";
}

/** True when `childPath` equals or sits inside `rootPath` (case-insensitive, slash-safe). */
export function isPathInside(childPath, rootPath) {
  const child = normalizeComparePath(childPath).toLowerCase();
  const root = normalizeComparePath(rootPath).toLowerCase();
  if (!child || !root) return false;
  if (child === root) return true;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return child.startsWith(prefix);
}

function relativeSubPath(fileDir, baseDir) {
  const dir = normalizeComparePath(fileDir);
  const base = normalizeComparePath(baseDir);
  const dirLow = dir.toLowerCase();
  const baseLow = base.toLowerCase();
  if (dirLow === baseLow) return "";
  const prefix = baseLow.endsWith("/") ? baseLow : `${baseLow}/`;
  if (!dirLow.startsWith(prefix)) return "";
  return dir.slice(prefix.length);
}

function fileStem(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function fileExt(name) {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

/**
 * Scans a FiveM script root, a `stream/` folder, a multi-resource category
 * folder (e.g. `[props]/`), or a plain folder of props.
 *
 * When a selected folder has a direct `stream/` child directory (typical FiveM
 * resource), scanning automatically targets `stream/` so script code, web UIs
 * and node_modules are skipped. When scanning a multi-resource folder, any
 * subfolder containing a resource manifest + `stream/` jumps directly into its
 * `stream/` directory.
 */
export async function scanPropFolder(pickedPath, { readDir, signal } = {}) {
  const check = () => {
    if (signal?.aborted) throw new DOMException("Prop folder scan cancelled", "AbortError");
  };
  const rootPath = String(pickedPath || "").trim().replace(/[\\/]+$/, (match, offset) => (offset === 0 || (offset === 2 && pickedPath[1] === ":") ? match : ""));
  const label = baseFsName(rootPath) || rootPath;
  const models = [];
  const ytypXmls = [];
  const ytdStems = new Set();
  const errors = [];
  let visited = 0;
  let truncated = false;

  if (!rootPath || typeof readDir !== "function") {
    return {
      rootPath,
      scanRoot: rootPath,
      label,
      kind: "folder",
      detectedStream: false,
      hasManifest: false,
      models,
      ytypXmls,
      ytdStems: [],
      truncated: false,
      errors,
    };
  }

  check();
  let topEntries;
  try {
    topEntries = (await readDir(rootPath)) || [];
  } catch (error) {
    errors.push({ path: rootPath, message: String(error?.message || error) });
    return {
      rootPath,
      scanRoot: rootPath,
      label,
      kind: "folder",
      detectedStream: false,
      hasManifest: false,
      models,
      ytypXmls,
      ytdStems: [],
      truncated: false,
      errors,
    };
  }

  const hasManifest = topEntries.some((entry) => entry?.name && !entry.isDirectory && MANIFEST_RE.test(entry.name));
  const directStream = topEntries.find((entry) => entry?.name && entry.isDirectory && entry.name.toLowerCase() === "stream");

  // Also grab top-level .ytyp.xml or data/*.ytyp.xml if a resource keeps its .ytyp outside stream/.
  for (const entry of topEntries) {
    if (!entry?.name || entry.isDirectory) continue;
    if (entry.name.toLowerCase().endsWith(".ytyp.xml")) {
      ytypXmls.push(joinFsPath(rootPath, entry.name));
    }
  }

  let detectedStream = Boolean(directStream) || baseFsName(rootPath).toLowerCase() === "stream";
  const scanRoot = directStream ? joinFsPath(rootPath, directStream.name) : rootPath;
  const detectedResources = new Set();

  const walk = async (directory, depth, currentResource, streamBase) => {
    check();
    let entries;
    try {
      entries = (await readDir(directory)) || [];
    } catch (error) {
      errors.push({ path: directory, message: String(error?.message || error) });
      return;
    }

    // If we're walking a multi-script folder and hit a nested FiveM resource
    // with its own stream/ folder, jump straight into its stream/ folder.
    if (directory !== scanRoot) {
      const nestedManifest = entries.some((entry) => entry?.name && !entry.isDirectory && MANIFEST_RE.test(entry.name));
      const nestedStream = entries.find((entry) => entry?.name && entry.isDirectory && entry.name.toLowerCase() === "stream");
      if (nestedManifest && nestedStream) {
        detectedStream = true;
        const resName = baseFsName(directory);
        detectedResources.add(resName);
        for (const entry of entries) {
          if (entry?.name && !entry.isDirectory && entry.name.toLowerCase().endsWith(".ytyp.xml")) {
            ytypXmls.push(joinFsPath(directory, entry.name));
          }
        }
        if (depth < MAX_DEPTH) {
          const nextStream = joinFsPath(directory, nestedStream.name);
          await walk(nextStream, depth + 1, resName, nextStream);
        } else {
          truncated = true;
        }
        return;
      }
    }

    const subDirs = [];
    for (const entry of entries) {
      check();
      if (!entry?.name) continue;
      if (++visited > MAX_ENTRIES) {
        truncated = true;
        return;
      }
      const lower = entry.name.toLowerCase();
      const fullPath = joinFsPath(directory, entry.name);
      if (entry.isDirectory) {
        if (IGNORED_DIRS.has(lower)) continue;
        if (depth < MAX_DEPTH) subDirs.push({ path: fullPath, lower });
        else truncated = true;
      } else if (isPropModelPath(entry.name)) {
        const subPath = relativeSubPath(directory, streamBase);
        models.push({
          name: entry.name,
          stem: fileStem(entry.name),
          ext: fileExt(entry.name),
          format: propModelFormat(entry.name),
          path: fullPath,
          subPath,
          resourceName: currentResource || "",
        });
      } else if (lower.endsWith(".ytyp.xml")) {
        ytypXmls.push(fullPath);
      } else if (lower.endsWith(".ytd")) {
        ytdStems.add(fileStem(entry.name).toLowerCase());
      }
    }

    for (const dir of subDirs) {
      const nextResource = currentResource;
      await walk(dir.path, depth + 1, nextResource, streamBase);
      if (truncated) return;
    }
  };

  await walk(scanRoot, 0, hasManifest || directStream ? label : "", scanRoot);

  models.sort(
    (a, b) =>
      naturally(a.resourceName || "", b.resourceName || "") ||
      naturally(a.subPath || "", b.subPath || "") ||
      naturally(a.name, b.name),
  );

  let kind = "folder";
  if (hasManifest || directStream) kind = "script";
  else if (baseFsName(rootPath).toLowerCase() === "stream") kind = "stream";
  else if (detectedResources.size > 0) kind = "pack";

  return {
    rootPath,
    scanRoot,
    label,
    kind,
    detectedStream,
    hasManifest,
    models,
    ytypXmls: [...new Set(ytypXmls)],
    ytdStems: [...ytdStems],
    truncated,
    errors,
  };
}

/**
 * Given a single opened prop model path, looks upward (up to 4 ancestors) for
 * an enclosing FiveM resource (`fxmanifest.lua` / `__resource.lua` with a
 * `stream/` folder) or an enclosing `stream/` folder so sibling/stream props
 * appear automatically. Falls back to the model's immediate directory.
 */
export async function findEnclosingPropRoot(modelPath, { readDir } = {}) {
  const immediate = parentFsPath(modelPath);
  if (!immediate || typeof readDir !== "function") return immediate;

  let current = immediate;
  let streamAncestor = baseFsName(immediate).toLowerCase() === "stream" ? immediate : "";

  for (let level = 0; level < ANCESTOR_LEVELS; level += 1) {
    const parent = parentFsPath(current);
    if (!parent || parent === current || /^[a-z]:[\\/]?$/i.test(parent)) break;
    current = parent;
    let entries;
    try {
      entries = (await readDir(current)) || [];
    } catch {
      break;
    }
    const hasManifest = entries.some((entry) => entry?.name && !entry.isDirectory && MANIFEST_RE.test(entry.name));
    const hasStream = entries.some((entry) => entry?.name && entry.isDirectory && entry.name.toLowerCase() === "stream");
    if (hasManifest && hasStream) {
      return current;
    }
    if (!streamAncestor && baseFsName(current).toLowerCase() === "stream") {
      streamAncestor = current;
    }
  }

  return streamAncestor || immediate;
}

/** Filters scanned prop models by filename, stem, subfolder, or resource name. */
export function filterPropModels(models, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return Array.isArray(models) ? models : [];
  return (Array.isArray(models) ? models : []).filter((entry) =>
    [entry?.name, entry?.stem, entry?.subPath, entry?.resourceName].some((field) =>
      String(field || "").toLowerCase().includes(q),
    ),
  );
}
