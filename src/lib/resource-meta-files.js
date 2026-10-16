import { loadResourceMeta } from "./vehicle-meta.js";
import { parseTextEntries } from "./vehicle-modkits.js";

const IGNORED_DIRS = new Set([".git", "node_modules", "cache"]);
const MAX_META_FILES = 128;
const MAX_ENTRIES = 12000;

function parent(path) {
  const value = path.replace(/\\/g, "/").replace(/\/$/, "");
  const index = value.lastIndexOf("/");
  return index > 2 ? value.slice(0, index) : "";
}

// Stay within the nearest resource. Without a manifest, inspect the model's
// directory and its parent only, rather than walking unrelated projects.
export async function readModelResourceMeta(modelPath, { readDir, readTextFile, signal } = {}) {
  const modelDir = parent(modelPath);
  const errors = [];
  const check = () => { if (signal?.aborted) throw new DOMException("Meta scan cancelled", "AbortError"); };
  const list = async (path, report = false) => {
    check();
    try { return await readDir(path); }
    catch (error) {
      if (report) errors.push({ path, message: String(error?.message || error) });
      return [];
    }
  };
  let root = modelDir;
  let rootEntries = await list(root, true);
  let manifestFound = false;
  let candidate = modelDir;
  for (let depth = 0; candidate && depth < 5; depth += 1) {
    const entries = depth === 0 ? rootEntries : await list(candidate);
    if (entries.some((entry) => /^(fxmanifest\.lua|__resource\.lua)$/i.test(entry.name))) {
      root = candidate;
      rootEntries = entries;
      manifestFound = true;
      break;
    }
    candidate = parent(candidate);
  }
  if (!manifestFound && parent(modelDir)) {
    const entries = await list(parent(modelDir));
    if (entries.some((entry) => entry.isDirectory && /^data$/i.test(entry.name))) {
      root = parent(modelDir);
      rootEntries = entries;
    }
  }
  const paths = [];
  // Ultimate Lighting Controller configs (ulc.lua) say which extras the
  // resource's lighting script switches.
  const ulcPaths = [];
  let visited = 0;
  let truncated = false;
  const walk = async (directory, entries, depth) => {
    for (const entry of entries) {
      check();
      if (++visited > MAX_ENTRIES || paths.length >= MAX_META_FILES) { truncated = true; return; }
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory && depth < 5 && !IGNORED_DIRS.has(entry.name.toLowerCase())) {
        // Geometry folders need no recursive meta search.
        if (entry.name.toLowerCase() !== "stream") await walk(path, await list(path, true), depth + 1);
      } else if (!entry.isDirectory && /\.meta$/i.test(entry.name)) paths.push(path);
      else if (!entry.isDirectory && /^ulc\.lua$/i.test(entry.name)) ulcPaths.push(path);
    }
  };
  await walk(root, rootEntries, 0);
  if (root !== modelDir) {
    for (const entry of await list(modelDir)) {
      if (!entry.isDirectory && /\.meta$/i.test(entry.name)) paths.push(`${modelDir}/${entry.name}`);
    }
  }
  const files = [];
  for (const path of new Set(paths)) {
    check();
    try {
      const text = await readTextFile(path);
      if (text.length > 8 * 1024 * 1024) throw new Error("Meta file exceeds the 8 MiB scan limit");
      files.push({ path, text });
    } catch (error) { errors.push({ path, message: String(error?.message || error) }); }
  }
  const ulcFiles = [];
  for (const path of ulcPaths) {
    check();
    try {
      const text = await readTextFile(path);
      if (text.length > 1024 * 1024) throw new Error("ulc.lua exceeds the 1 MiB scan limit");
      ulcFiles.push({ path, text });
    } catch (error) { errors.push({ path, message: String(error?.message || error) }); }
  }
  check();
  const meta = loadResourceMeta(files);
  meta.errors.push(...errors);
  if (truncated) meta.errors.push({ path: root, message: "Resource scan limit reached; some meta files were not read." });
  return { root, meta, ulcFiles };
}

const MAX_MODEL_ENTRIES = 40000;

// Mod kit models live in the resource's stream folders, usually beside the
// vehicle. Walk the resource root found by readModelResourceMeta for .yft
// files, plus the model's own folder when it sits outside that root.
export async function listResourceModelFiles(root, modelPath, { readDir, signal } = {}) {
  const check = () => { if (signal?.aborted) throw new DOMException("Model scan cancelled", "AbortError"); };
  const modelDir = parent(modelPath);
  const paths = [];
  const errors = [];
  let visited = 0;
  let truncated = false;
  const walk = async (directory, depth) => {
    check();
    let entries;
    try { entries = await readDir(directory); }
    catch (error) { errors.push({ path: directory, message: String(error?.message || error) }); return; }
    for (const entry of entries) {
      check();
      if (++visited > MAX_MODEL_ENTRIES) { truncated = true; return; }
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory) {
        if (depth < 6 && !IGNORED_DIRS.has(entry.name.toLowerCase())) await walk(path, depth + 1);
      } else if (/\.yft$/i.test(entry.name)) paths.push(path);
    }
  };
  const start = (root || modelDir).replace(/\\/g, "/").replace(/\/$/, "");
  await walk(start, 0);
  const normalizedModelDir = modelDir.toLowerCase();
  if (modelDir && !(normalizedModelDir === start.toLowerCase() || normalizedModelDir.startsWith(`${start.toLowerCase()}/`))) {
    await walk(modelDir, 6);
  }
  if (truncated) errors.push({ path: start, message: "Resource scan limit reached; some model files were not listed." });
  return { paths, errors };
}

const MAX_SCRIPT_FILES = 200;
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;

// Mod and slot names come from text entries the resource registers in its
// scripts (AddTextEntry). Escrow-encrypted scripts are unreadable and simply
// contribute nothing.
export async function readResourceTextEntries(root, { readDir, readTextFile, signal } = {}) {
  const check = () => { if (signal?.aborted) throw new DOMException("Text scan cancelled", "AbortError"); };
  const entries = new Map();
  const sources = [];
  const errors = [];
  const paths = [];
  const walk = async (directory, depth) => {
    check();
    let list;
    try { list = await readDir(directory); }
    catch (error) { errors.push({ path: directory, message: String(error?.message || error) }); return; }
    for (const entry of list) {
      if (paths.length >= MAX_SCRIPT_FILES) return;
      const path = `${directory}/${entry.name}`;
      const name = entry.name.toLowerCase();
      if (entry.isDirectory) {
        if (depth < 5 && !IGNORED_DIRS.has(name) && name !== "stream") await walk(path, depth + 1);
      } else if (/\.(lua|js)$/i.test(name)) paths.push(path);
    }
  };
  if (root) await walk(root.replace(/\\/g, "/").replace(/\/$/, ""), 0);
  for (const path of paths) {
    check();
    try {
      const text = await readTextFile(path);
      if (text.length > MAX_SCRIPT_BYTES || !text.includes("AddTextEntry")) continue;
      const before = entries.size;
      parseTextEntries(text, entries);
      if (entries.size > before) sources.push(path);
    } catch (error) { errors.push({ path, message: String(error?.message || error) }); }
  }
  return { entries, sources, errors };
}

const MAX_RENAME_ENTRIES = 40000;
const MAX_RENAME_TEXT_FILES = 400;
const MAX_RENAME_TEXT_BYTES = 8 * 1024 * 1024;

// The vehicle renamer's view of a resource: every file path (stream files are
// picked from these) and the text of its meta files and Lua scripts outside
// the stream folders.
export async function readResourceForRename(root, { readDir, readTextFile, signal } = {}) {
  const check = () => { if (signal?.aborted) throw new DOMException("Resource scan cancelled", "AbortError"); };
  const paths = [];
  const textPaths = [];
  const errors = [];
  let visited = 0;
  let truncated = false;
  const walk = async (directory, depth, inStream) => {
    check();
    let entries;
    try { entries = await readDir(directory); }
    catch (error) { errors.push({ path: directory, message: String(error?.message || error) }); return; }
    for (const entry of entries) {
      check();
      if (++visited > MAX_RENAME_ENTRIES) { truncated = true; return; }
      const path = `${directory}/${entry.name}`;
      const name = entry.name.toLowerCase();
      if (entry.isDirectory) {
        if (depth < 6 && !IGNORED_DIRS.has(name)) await walk(path, depth + 1, inStream || name === "stream");
        continue;
      }
      paths.push(path);
      if (!inStream && /\.(meta|lua)$/i.test(name)) textPaths.push(path);
    }
  };
  if (root) await walk(root.replace(/\\/g, "/").replace(/\/$/, ""), 0, false);
  const files = [];
  for (const path of textPaths.slice(0, MAX_RENAME_TEXT_FILES)) {
    check();
    try {
      const text = await readTextFile(path);
      if (text.length > MAX_RENAME_TEXT_BYTES) throw new Error("File exceeds the 8 MiB rename limit");
      files.push({ path, text });
    } catch (error) { errors.push({ path, message: String(error?.message || error) }); }
  }
  if (textPaths.length > MAX_RENAME_TEXT_FILES || truncated) {
    errors.push({ path: root, message: "Resource scan limit reached; some files were not checked." });
  }
  return { paths, files, errors, complete: !truncated && textPaths.length <= MAX_RENAME_TEXT_FILES };
}
