// A folder of vehicles, for stepping through a pack one car at a time. The
// folder may be one resource or many. In a resource with a vehicles.meta, the
// models it names are the vehicles, so mod kit parts kept beside them (and any
// other model that is not a vehicle) stay out of the list. Without one, every
// model is listed except those its carcols.meta kits use as parts. A vehicle
// opens its `_hi` model when it has one, as the game streams that up close.

import { loadResourceMeta, simulateVehicle } from "./vehicle-meta.js";
import { findModelFile, indexModelFiles } from "./vehicle-modkits.js";

const IGNORED_DIRS = new Set([".git", "node_modules", "cache"]);
const MANIFEST = /^(fxmanifest\.lua|__resource\.lua)$/i;
const MAX_ENTRIES = 60000;
const MAX_DEPTH = 8;
const MAX_META_FILES = 800;
const MAX_META_BYTES = 8 * 1024 * 1024;
// How far up a folder picked inside a resource looks for that resource.
const ANCESTOR_LEVELS = 4;

const lower = (value) => String(value || "").toLowerCase();

function normalizePath(path) {
  const text = String(path || "").replace(/\\/g, "/").replace(/\/+$/, "");
  // A drive root keeps its slash: "C:" alone names the drive's current folder.
  return /^[a-z]:$/i.test(text) ? `${text}/` : text;
}

const joinPath = (directory, name) => (directory.endsWith("/") ? `${directory}${name}` : `${directory}/${name}`);

// The folder holding `path`; a drive root keeps its slash.
function parentOf(path) {
  const at = path.lastIndexOf("/");
  if (at <= 0) return "";
  const parent = path.slice(0, at);
  return /^[a-z]:$/i.test(parent) ? `${parent}/` : parent;
}

function baseName(path) {
  return normalizePath(path).split("/").filter(Boolean).pop() || "";
}

// The model's file name as written, less `.yft` and the `_hi` suffix.
function modelStem(path) {
  return baseName(path).replace(/\.yft$/i, "").replace(/_hi$/i, "");
}

function partNames(meta) {
  const names = new Set();
  for (const kit of meta?.kits || []) {
    for (const mod of [...(kit.visibleMods || []), ...(kit.linkMods || [])]) {
      if (mod.modelName) names.add(lower(mod.modelName));
      for (const linked of mod.linkedModels || []) names.add(lower(linked));
    }
  }
  return names;
}

// Errors in the resource's meta that keep part of the vehicle from working in
// game, like a livery list without FLAG_HAS_LIVERY, as the Meta tab reports them.
function metaProblems(meta, modelName) {
  try {
    return simulateVehicle(meta, modelName).warnings.filter((warning) => warning.severity === "error").map((warning) => warning.message);
  } catch {
    return [];
  }
}

const naturally = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
// Two resources can share a name in different folders; the path keeps each one's vehicles together.
const byResourceThenName = (a, b) => naturally(a.resource, b.resource) || naturally(a.resourcePath, b.resourcePath) || naturally(a.name, b.name);

/**
 * The vehicles in scanned resources, `[{ path, models: [yft paths], meta }]`.
 * Returns `{ vehicles, missing }`: each vehicle is
 * `{ name, path, resource, resourcePath, gameName, declared, problems }`,
 * where `declared` is false when no vehicles.meta names it and `problems`
 * lists the errors its resource's meta has for it; `missing` lists
 * vehicles.meta entries the folder holds no model for, except in a `partial`
 * resource (a folder picked inside it), where most are expected to be absent.
 */
export function listFolderVehicles(resources) {
  const vehicles = [];
  const missing = [];
  for (const resource of resources || []) {
    const index = indexModelFiles(resource.models);
    const resourcePath = normalizePath(resource.path);
    const resourceName = baseName(resourcePath);
    const declared = new Map();
    for (const entry of resource.meta?.vehicles || []) {
      const key = lower(entry.modelName);
      if (key && !declared.has(key)) declared.set(key, entry);
    }
    if (declared.size) {
      for (const entry of declared.values()) {
        const path = findModelFile(index, entry.modelName);
        if (path) vehicles.push({ name: entry.modelName, path, resource: resourceName, resourcePath, gameName: entry.gameName || "", declared: true, problems: metaProblems(resource.meta, entry.modelName) });
        else if (!resource.partial) missing.push({ name: entry.modelName, resource: resourceName });
      }
      continue;
    }
    const parts = partNames(resource.meta);
    const seen = new Set();
    for (const path of resource.models || []) {
      const stem = lower(modelStem(path));
      if (!stem || seen.has(stem) || parts.has(stem) || parts.has(`${stem}_hi`)) continue;
      seen.add(stem);
      vehicles.push({ name: modelStem(path), path: findModelFile(index, stem) || path, resource: resourceName, resourcePath, gameName: "", declared: false, problems: [] });
    }
  }
  return { vehicles: vehicles.sort(byResourceThenName), missing };
}

/**
 * Walks `folder` for vehicle models and the meta beside them, grouped by
 * resource (the nearest folder with fxmanifest.lua or __resource.lua; models
 * outside any resource group under `folder`). Meta inside `stream` folders is
 * not read, as the game does not load it. A folder picked inside a resource,
 * like its `stream` folder, takes the meta of the resource it is in, found a
 * few levels up; `allowResource(modelPath)`, when given, is asked for read
 * access to that resource first. Resolves `{ folder, vehicles, missing,
 * errors, truncated }`; unreadable folders and meta files are reported in
 * `errors` and the rest still list.
 */
export async function scanVehicleFolder(folder, { readDir, readTextFile, signal, allowResource } = {}) {
  const check = () => { if (signal?.aborted) throw new DOMException("Vehicle folder scan cancelled", "AbortError"); };
  const root = normalizePath(folder);
  const groups = new Map();
  const errors = [];
  let visited = 0;
  let metaCount = 0;
  let truncated = false;
  let rootIsResource = false;
  const group = (path) => {
    if (!groups.has(path)) groups.set(path, { path, models: [], metaPaths: [] });
    return groups.get(path);
  };
  const walk = async (directory, depth, owner, inStream) => {
    check();
    let entries;
    try { entries = await readDir(directory); }
    catch (error) { errors.push({ path: directory, message: String(error?.message || error) }); return; }
    const hasManifest = entries.some((entry) => !entry.isDirectory && MANIFEST.test(entry.name));
    const resource = hasManifest ? directory : owner;
    if (directory === root) rootIsResource = hasManifest;
    for (const entry of entries) {
      check();
      if (++visited > MAX_ENTRIES) { truncated = true; return; }
      const path = joinPath(directory, entry.name);
      const name = entry.name.toLowerCase();
      if (entry.isDirectory) {
        if (depth < MAX_DEPTH && !IGNORED_DIRS.has(name)) await walk(path, depth + 1, resource, inStream || name === "stream");
      } else if (name.endsWith(".yft")) {
        group(resource).models.push(path);
      } else if (name.endsWith(".meta") && !inStream) {
        if (metaCount >= MAX_META_FILES) truncated = true;
        else {
          metaCount += 1;
          group(resource).metaPaths.push(path);
        }
      }
    }
  };
  // The meta of a resource, outside its stream folders.
  const collectMeta = async (directory, depth, found) => {
    check();
    let entries;
    try { entries = await readDir(directory); }
    catch (error) { errors.push({ path: directory, message: String(error?.message || error) }); return; }
    for (const entry of entries) {
      if (++visited > MAX_ENTRIES) { truncated = true; return; }
      const name = entry.name.toLowerCase();
      const path = joinPath(directory, entry.name);
      if (entry.isDirectory) {
        if (depth < MAX_DEPTH && !IGNORED_DIRS.has(name) && name !== "stream") await collectMeta(path, depth + 1, found);
      } else if (name.endsWith(".meta")) {
        if (metaCount >= MAX_META_FILES) truncated = true;
        else {
          metaCount += 1;
          found.push(path);
        }
      }
    }
  };
  // The nearest ancestor of `root` with a manifest, never a drive root.
  const enclosingResource = async () => {
    let path = root;
    for (let level = 0; level < ANCESTOR_LEVELS; level += 1) {
      const parent = parentOf(path);
      if (!parent || parent === path || /^[a-z]:\/$/i.test(parent)) return "";
      path = parent;
      check();
      try {
        if ((await readDir(path)).some((entry) => !entry.isDirectory && MANIFEST.test(entry.name))) return path;
      } catch {
        return "";
      }
    }
    return "";
  };

  await walk(root, 0, root, false);

  const loose = groups.get(root);
  if (loose?.models.length && !rootIsResource) {
    try { await allowResource?.(loose.models[0]); } catch { /* the reads below report what stays unreadable */ }
    const resourceRoot = await enclosingResource();
    if (resourceRoot) {
      metaCount -= loose.metaPaths.length;
      loose.metaPaths = [];
      await collectMeta(resourceRoot, 0, loose.metaPaths);
      loose.resourcePath = resourceRoot;
      loose.partial = true;
    }
  }

  const resources = [];
  for (const entry of groups.values()) {
    if (!entry.models.length) continue;
    const files = [];
    for (const path of entry.metaPaths) {
      check();
      try {
        const text = await readTextFile(path);
        if (text.length > MAX_META_BYTES) throw new Error("Meta file exceeds the 8 MiB scan limit");
        files.push({ path, text });
      } catch (error) { errors.push({ path, message: String(error?.message || error) }); }
    }
    const meta = loadResourceMeta(files);
    errors.push(...meta.errors);
    resources.push({ path: entry.resourcePath || entry.path, models: entry.models, meta, partial: Boolean(entry.partial) });
  }
  check();
  return { folder: root, ...listFolderVehicles(resources), errors, truncated };
}

/** The vehicle `modelPath` opens: its own entry, or the one whose `_hi` or base twin it is. */
export function vehicleIndexOf(vehicles, modelPath) {
  const path = lower(normalizePath(modelPath));
  if (!path) return -1;
  const exact = vehicles.findIndex((vehicle) => lower(normalizePath(vehicle.path)) === path);
  if (exact >= 0) return exact;
  const folder = path.slice(0, path.lastIndexOf("/"));
  const stem = lower(modelStem(path));
  return vehicles.findIndex((vehicle) => {
    const own = lower(normalizePath(vehicle.path));
    return own.slice(0, own.lastIndexOf("/")) === folder && lower(modelStem(own)) === stem;
  });
}

/** The vehicle `delta` steps from the open one, or null at either end. With none open, the first. */
export function stepVehicle(vehicles, modelPath, delta) {
  if (!vehicles.length) return null;
  const at = vehicleIndexOf(vehicles, modelPath);
  if (at < 0) return delta > 0 ? vehicles[0] : vehicles[vehicles.length - 1];
  return vehicles[at + delta] || null;
}

/** Vehicles whose model, display name or resource contains `query`. */
export function filterVehicles(vehicles, query) {
  const text = lower(query).trim();
  if (!text) return vehicles;
  return vehicles.filter((vehicle) => [vehicle.name, vehicle.gameName, vehicle.resource].some((value) => lower(value).includes(text)));
}
